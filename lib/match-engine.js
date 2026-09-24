'use strict';
// ---------------------------------------------------------------------------
// lib/match-engine.js — Universal Match Engine (B24)
// ---------------------------------------------------------------------------
// Every edit tool needs the same five-step pipeline: read the buffer, resolve
// a scope from hints, find the content inside that scope, write the edit,
// build a response. Historically only str_replace got real investment in
// this pipeline — every other tool (insert, delete-line-range, delete-block,
// replace-block, replace-function-body, sed, apply-patch) reimplemented a
// thinner version privately, so hint parity, ambiguity checks, and smart
// failure diagnostics drifted or were missing entirely (see
// mcp-server-refactor-plan.md B24 and session-notes for the audit that led
// here).
//
// This module is the single shared implementation. A tool built on it looks
// like:
//
//   const scope = resolveScope({ editor, buffer, allLines, text, filePath, params });
//   if (scope.error) return buildFailResponse({ tool, ctx, scope, needle, isCodeFile });
//   const match = matchContent(needle, { allLines, text }, scope, opts);
//   if (!match.matched) return buildFailResponse({ tool, ctx, scope, match, needle, isCodeFile });
//   const edit = applyEdit(buffer, match, newStr);
//   return buildMatchResponse({ tool, match, edit, buffer, scopeLabel: scope.scopeLabel, warnings });
//
// Every tool that adopts this gets fuzzy matching, unicode normalisation,
// ambiguity checking, and scanForOldStr drift diagnostics for free, instead
// of a private, unmaintained copy.
//
// NOTE ON MIGRATION: str_replace's own ~350-line hand-rolled waterfall
// (mcp-registration.js, the _profileScan / fuzzyWhitespace rebuild block) is
// NOT yet refactored onto this engine — it is battle-tested (662+ lifetime
// hits) and migrating it is a separate, careful follow-up so as not to
// regress its accuracy. This engine is safe to build NEW tools on
// immediately (block-edit, block-delete, invested insert per the T1/T2/T3
// build order) and to incrementally back-fit into existing tools one at a
// time, verifying stats/behavior parity after each.
// ---------------------------------------------------------------------------

const {
  getSymbols,
  resolveAnchor,
  resolveSymbolPosition,
  resolveStringPosition,
  resolveLinePosition,
  HINT_RADIUS,
} = require('./tree-sitter-symbols');

const {
  ambiguityCheck,
  smartSuggestion,
  scanForOldStr,
  anchorError,
} = require('./tool-hints');

const { normUnicode } = require('./string-utils');
const { resolveStructuralAnchor } = require('./buffer-helpers'); // sectionHint/preprocBlock (hint-gap closure)
const { buildEditResponse } = require('./edit-response');
const { profiledMatch, partialMatchRescue } = require('./recover'); // B32
const { diagnose } = require('./fail-diagnostics'); // S4 (2026-09-21): pure failure diagnosis
const { bump } = require('./edit-stats');           // S4 (2026-09-21): engine owns the shared fails.* tally

// ── STEP 2: SCOPE ──────────────────────────────────────────────────────────

/**
 * resolveScope({ editor, buffer, allLines, text, filePath, params })
 *
 * Reads every hint style and resolves them to a single search window, using the
 * same decision-ladder priority str_replace's description teaches the LLM:
 *   afterRow > sectionHint/preprocBlock > inFunction > betweenHint >
 *   afterFunction/beforeFunction > afterSymbol/beforeSymbol >
 *   afterString/beforeString > afterLine/beforeLine > (whole file)
 * Only the first matching group is used; the rest are ignored.
 *
 * buffer may be null (read passes null): every branch works from allLines/text.
 *
 * params: {
 *   sectionHint, preprocBlock, preprocSide('open'|'close'),  -- structural anchors
 *   inFunction, betweenHint:{start,end},
 *   afterFunction, beforeFunction, afterSymbol, beforeSymbol,
 *   afterString, beforeString, afterLine, beforeLine,
 *   afterRow,        -- internal raw-row override ("search from this row to EOF"); wins over all
 *   occurrence,      -- disambiguates any hint that matches more than once
 *   hintRadius,      -- window size for the directional hints (default HINT_RADIUS)
 *   fuzzyWhitespace  -- forwarded to afterString/beforeString matching
 * }
 *
 * Returns on success:
 *   { searchStart, searchEnd, scopeLabel, _hasScope, via,
 *     anchorRow?, endAnchorRow?, positional? }
 *   searchStart/searchEnd are 0-based row bounds, inclusive.
 *   anchorRow    -- the landmark row (function start, banner row, matched string row, ...).
 *   endAnchorRow -- only set when the hint resolves to a RANGE: sectionHint, preprocBlock
 *                   and betweenHint. For those, searchStart..searchEnd IS the range, so a
 *                   caller can delete it (delete) or position after it (insert).
 *   positional   -- true only for afterLine/beforeLine (drifts if lines shift).
 *   _hasScope    -- false when no hint was given at all (whole file is the window).
 *
 * Returns on failure:
 *   { error: { kind: 'notFound'|'ambiguous'|'anchorError'|'needsTreeSitter',
 *              hintName, hintValue, symbols?, raw?, message?, ambiguous?, candidates? } }
 *   kind 'anchorError' carries a complete pre-formatted `message` (structural anchors and
 *   betweenHint); callers should surface it verbatim. For the STRUCTURAL anchors it also
 *   sets `ambiguous:true` on an ambiguity, plus `candidates` (1-based lines); betweenHint's
 *   anchorError carries only `message`, with no ambiguous flag.
 *   'notFound'/'ambiguous' carry raw resolver output for buildFailResponse to format.
 */
function _resolveScopeCore({ editor, buffer, allLines, text, filePath, params }) {
  const {
    inFunction, betweenHint, afterFunction, beforeFunction,
    afterSymbol, beforeSymbol, afterString, beforeString,
    afterLine, beforeLine, afterRow, occurrence, hintRadius, fuzzyWhitespace = false,
    sectionHint, preprocBlock, preprocSide,
  } = params || {};
  const radius = hintRadius || HINT_RADIUS;
  const symbols = getSymbols(editor, text, filePath);
  const hasHint = !!(inFunction || betweenHint || afterFunction || beforeFunction ||
    afterSymbol || beforeSymbol || afterString || beforeString ||
    afterLine != null || beforeLine != null || afterRow != null || occurrence != null ||
    sectionHint !== undefined || preprocBlock !== undefined);

  // Raw row passthrough — for callers (delete_block's start/end pair,
  // apply-patch's hunk rescue) that already know a specific row to resume
  // searching from and don't need named-hint resolution. Unlike afterLine
  // (a user-facing hint windowed to ±radius around a line number), this is
  // an internal scope override: "search from this exact row to EOF", no
  // radius clamping. Takes priority over named hints when both are present,
  // since it represents an already-resolved position, not a fresh lookup.
  if (afterRow != null) {
    const anchorRow = Math.max(0, Math.min(allLines.length - 1, afterRow));
    return { searchStart: anchorRow, searchEnd: Math.max(anchorRow, allLines.length - 1), scopeLabel: '', _hasScope: true, anchorRow, via: 'afterRow' };
  }

  // Structural anchors -- sectionHint (banner comment) / preprocBlock
  // (#ifdef..#endif). Resolved via buffer-helpers.resolveStructuralAnchor so the
  // B44 ambiguity rules (occurrence omitted + >1 match refuses; occurrence given,
  // including 1, resolves directly) are shared, not forked. A structural anchor
  // resolves to a ROW RANGE, so searchStart/searchEnd/anchorRow/endAnchorRow are
  // the range itself -- callers that position relative to the landmark (insert
  // after endAnchorRow) or delete the range (delete) read those directly.
  // scopeLabel is deliberately neutral (no "after"/"before"): insert and delete
  // use the same range differently and each builds its own wording.
  // Failures are returned as kind:'anchorError' with the message pre-formatted
  // here (wording carried over verbatim from insert/delete's former hand-rolled
  // branches), because anchorError() in tool-hints.js is shaped for symbol/string
  // results and would mislabel banner/#ifdef matches as "functions".
  // resolveStructuralAnchor only ever calls buffer.getLines(), so it is fed an
  // adapter over allLines -- callers such as read pass buffer:null, and this
  // must not throw for them.
  if (sectionHint !== undefined || preprocBlock !== undefined) {
    const hintName  = sectionHint !== undefined ? 'sectionHint' : 'preprocBlock';
    const hintValue = sectionHint !== undefined ? sectionHint : preprocBlock;
    const resolved = resolveStructuralAnchor({ getLines: () => allLines }, { sectionHint, preprocBlock, preprocSide, occurrence });
    if (!resolved) {
      return { error: { kind: 'anchorError', hintName, hintValue, message: `\u274C ${hintName}: "${hintValue}" not found. Use get-structural-anchors to list available anchors.` } };
    }
    if (resolved.ambiguous) {
      const lines = resolved.matches.map(m => m.startRow + 1).join(', ');
      if (resolved.outOfRange) {
        return { error: { kind: 'anchorError', ambiguous: true, hintName, hintValue, candidates: resolved.matches.map(m => m.startRow + 1), message: `\u274C ${hintName}: "${hintValue}" has only ${resolved.matches.length} match${resolved.matches.length === 1 ? '' : 'es'} (lines ${lines}) but occurrence:${resolved.occurrence} was requested. Nothing was changed — use an occurrence between 1 and ${resolved.matches.length}.` } };
      }
      return { error: { kind: 'anchorError', ambiguous: true, hintName, hintValue, candidates: resolved.matches.map(m => m.startRow + 1), message: `\u274C ${hintName}: "${hintValue}" matches ${resolved.matches.length} places (lines ${lines}). Narrow the hint or add occurrence:N to pick one.` } };
    }
    return {
      searchStart: resolved.startRow, searchEnd: resolved.endRow,
      scopeLabel: ` at ${hintName} "${hintValue}"`, _hasScope: true,
      anchorRow: resolved.startRow, endAnchorRow: resolved.endRow, via: hintName,
      occurrenceConsumed: occurrence != null, // S1: occurrence was spent picking this anchor; content matchers must not re-apply it
    };
  }

  if (inFunction) {
    const r = resolveSymbolPosition(symbols, inFunction, 'function', 'inside', radius);
    if (r.notFound)   return { error: { kind: 'notFound', hintName: 'inFunction', hintValue: inFunction, symbols } };
    if (r.ambiguous) {
      if (occurrence != null && occurrence <= r.matches.length) {
        const m = r.matches[occurrence - 1];
        return { searchStart: m.startRow, searchEnd: m.endRow, scopeLabel: ` within function "${inFunction}" (occurrence ${occurrence})`, _hasScope: true, anchorRow: m.startRow, via: 'inFunction', occurrenceConsumed: true };
      }
      return { error: { kind: 'ambiguous', hintName: 'inFunction', hintValue: inFunction, raw: r } };
    }
    return { searchStart: r.startRow, searchEnd: r.endRow, scopeLabel: ` within function "${inFunction}"`, _hasScope: true, anchorRow: r.anchorRow, via: 'inFunction' };
  }

  if (betweenHint) {
    const rs = resolveAnchor(betweenHint.start, symbols, text);
    const es = anchorError('betweenHint.start', betweenHint.start, rs, symbols);
    if (es) return { error: { kind: 'anchorError', message: es } };
    const re = resolveAnchor(betweenHint.end, symbols, text);
    const ee = anchorError('betweenHint.end', betweenHint.end, re, symbols);
    if (ee) return { error: { kind: 'anchorError', message: ee } };
    return { searchStart: rs.row, searchEnd: re.row, scopeLabel: ' within betweenHint region', _hasScope: true, anchorRow: rs.row, endAnchorRow: re.row, via: 'betweenHint' };
  }

  if (afterFunction || beforeFunction) {
    const name = afterFunction || beforeFunction;
    const dir  = afterFunction ? 'after' : 'before';
    const r = resolveSymbolPosition(symbols, name, 'function', dir, radius);
    const hintName = afterFunction ? 'afterFunction' : 'beforeFunction';
    if (r.notFound)  return { error: { kind: 'notFound', hintName, hintValue: name, symbols } };
    if (r.ambiguous) {
      if (occurrence != null && occurrence <= r.matches.length) {
        const m = r.matches[occurrence - 1];
        const anchorRow = dir === 'after' ? m.endRow : m.startRow;
        const searchStart = dir === 'after' ? anchorRow : Math.max(0, anchorRow - radius);
        const searchEnd   = dir === 'after' ? anchorRow + radius : anchorRow;
        return { searchStart, searchEnd, scopeLabel: ` ${dir} function "${name}" (occurrence ${occurrence})`, _hasScope: true, anchorRow, via: hintName, occurrenceConsumed: true };
      }
      return { error: { kind: 'ambiguous', hintName, hintValue: name, raw: r } };
    }
    return { searchStart: r.startRow, searchEnd: r.endRow, scopeLabel: ` ${dir} function "${name}"`, _hasScope: true, anchorRow: r.anchorRow, via: hintName };
  }

  if (afterSymbol || beforeSymbol) {
    const name = afterSymbol || beforeSymbol;
    const dir  = afterSymbol ? 'after' : 'before';
    const r = resolveSymbolPosition(symbols, name, 'any', dir, radius);
    const hintName = afterSymbol ? 'afterSymbol' : 'beforeSymbol';
    if (r.needsTreeSitter) return { error: { kind: 'needsTreeSitter', hintName, hintValue: name } };
    if (r.notFound)        return { error: { kind: 'notFound', hintName, hintValue: name, symbols } };
    if (r.ambiguous) {
      if (occurrence != null && occurrence <= r.matches.length) {
        const m = r.matches[occurrence - 1];
        const anchorRow = dir === 'after' ? m.endRow : m.startRow;
        const searchStart = dir === 'after' ? anchorRow : Math.max(0, anchorRow - radius);
        const searchEnd   = dir === 'after' ? anchorRow + radius : anchorRow;
        return { searchStart, searchEnd, scopeLabel: ` ${dir} symbol "${name}" (occurrence ${occurrence})`, _hasScope: true, anchorRow, via: hintName, occurrenceConsumed: true };
      }
      return { error: { kind: 'ambiguous', hintName, hintValue: name, raw: r } };
    }
    return { searchStart: r.startRow, searchEnd: r.endRow, scopeLabel: ` ${dir} symbol "${name}"`, _hasScope: true, anchorRow: r.anchorRow, via: hintName };
  }

  if (afterString || beforeString) {
    const val = afterString || beforeString;
    const dir = afterString ? 'after' : 'before';
    const r = resolveStringPosition(allLines, val, dir, radius, { fuzzyWhitespace });
    const hintName = afterString ? 'afterString' : 'beforeString';
    if (r.notFound)  return { error: { kind: 'notFound', hintName, hintValue: val, multiLine: r.multiLine } };
    if (r.ambiguous) {
      if (occurrence != null && occurrence <= r.rows.length) {
        const anchorRow = r.rows[occurrence - 1];
        const searchStart = dir === 'after' ? anchorRow : Math.max(0, anchorRow - radius);
        const searchEnd   = dir === 'after' ? anchorRow + radius : anchorRow;
        return { searchStart, searchEnd, scopeLabel: ` (occurrence ${occurrence})`, _hasScope: true, anchorRow, via: hintName, occurrenceConsumed: true };
      }
      return { error: { kind: 'ambiguous', hintName, hintValue: val, raw: r } };
    }
    return { searchStart: r.startRow, searchEnd: r.endRow, scopeLabel: r.viaFuzzyWhitespace ? ' [fuzzyWhitespace]' : '', _hasScope: true, anchorRow: r.anchorRow, via: hintName };
  }

  if (afterLine != null || beforeLine != null) {
    const n   = afterLine != null ? afterLine : beforeLine;
    const dir = afterLine != null ? 'after' : 'before';
    const r = resolveLinePosition(allLines.length, n, dir, radius);
    return { searchStart: r.startRow, searchEnd: r.endRow, scopeLabel: '', _hasScope: true, anchorRow: r.anchorRow, via: afterLine != null ? 'afterLine' : 'beforeLine', positional: true };
  }

  // No scoping hint at all — whole file is the window.
  return { searchStart: 0, searchEnd: Math.max(0, allLines.length - 1), scopeLabel: '', _hasScope: hasHint, via: 'none' };
}

// ---------------------------------------------------------------------------
// resolveScope -- public entry point. Thin wrapper over _resolveScopeCore (S4, 2026-09-21).
//
// WHY A WRAPPER: the core has ~13 separate return literals. buildFailResponse now needs the
// RAW HINT VALUES the caller passed (afterLine's number for the drift nudge, afterString's
// text for the "Hint used:" label, ...) so fail-diagnostics.js can name the active hint and
// pick the finer failure reason. Attaching them here, once, means NO call site changes and no
// edit to any of the core's return statements.
//
// The hints ride on the scope object as `scope.hints`. Error results are returned untouched
// (buildFailResponse's scope-failure branch does not use them). The list below must match the
// hints fail-diagnostics.js reads: activeHintLabel() and classify().
// ---------------------------------------------------------------------------
const DIAG_HINT_KEYS = ['afterString', 'afterLine', 'beforeString', 'beforeLine', 'inFunction', 'betweenHint',
                        'afterFunction', 'beforeFunction', 'afterSymbol', 'beforeSymbol',
                        'occurrence']; // occurrence is NOT read by diagnose(); buildFailResponse uses it for str_replace's "occurrence > 1" scope rule
function resolveScope(args) {
  const scope = _resolveScopeCore(args);
  if (scope && !scope.error) {
    const p = (args && args.params) || {};
    const hints = {};
    for (const k of DIAG_HINT_KEYS) if (p[k] !== undefined) hints[k] = p[k];
    scope.hints = hints;
  }
  return scope;
}

// ── STEP 3: MATCH ──────────────────────────────────────────────────────────

function scanBlock(lines, needleLines, cmp) {
  const n = needleLines.length;
  const hits = [];
  for (let i = 0; i + n <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!cmp(lines[i + j], needleLines[j])) { ok = false; break; }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

// -- S1 (2026-09-20): occurrence safety for every content matcher ---------------
// Engine defaults must be safe for DESTRUCTIVE callers (delete, replace-block,
// replace-function-body). Before S1 the matchers did hits[Math.min(occurrence, n) - 1],
// so occurrence:5 with 2 matches silently picked match 2 -- a wrong-target write.
//
// Two rules, shared by matchContent / matchBlock / matchFunction:
//   1. occurrence is spent ONCE. If resolveScope() already used it to disambiguate an
//      ambiguous anchor (scope.occurrenceConsumed), the content matcher must not
//      re-apply it -- callers such as replace-block forward the same occurrence to
//      both stages. With it spent, the content stage is judged on its own: exactly one
//      hit in the window proceeds, more than one is refused as ambiguous.
//   2. An occurrence that reaches the content stage must be an integer in 1..total.
//      Anything else is refused with reason:'occurrenceOutOfRange' and NOTHING is
//      written -- it is never clamped.
function contentOccurrence(scope, occurrence) {
  return (scope && scope.occurrenceConsumed) ? undefined : occurrence;
}

function occurrenceOutOfRange(occurrence, total) {
  return occurrence != null && (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > total);
}

function occurrenceFail(occurrence, total, matchLines) {
  return { matched: false, reason: 'occurrenceOutOfRange', occurrence, totalMatches: total, matchLines };
}

/**
 * matchContent(needle, { allLines, text }, scope, opts)
 *
 * Finds needle (one or more lines) inside the window scope resolved. Waterfall, stopping
 * at the first stage that finds a hit:
 *   1. exact line-for-line match
 *   2. fuzzyWhitespace -- trim-compare each line          (only if opts.fuzzyWhitespace)
 *   3. fuzzyContent    -- unicode-normalised compare      (only if opts.fuzzyContent)
 *   4. autoRescue #1   -- recover.js combined-transform diagnosis, within scope
 *   5. autoRescue #2   -- recover.js full-buffer partial-match rescue (multi-line needles
 *                         only; may match OUTSIDE the resolved scope)
 * regex:true bypasses the whole waterfall: needle is a RegExp run over the scoped text.
 *
 * opts: { fuzzyWhitespace, fuzzyContent, regex, occurrence, autoRescue }
 *   autoRescue (default true, B32) — after the explicit waterfall above finds
 *   nothing, automatically try lib/recover.js's combined-transform diagnosis
 *   (catches a line needing BOTH whitespace and encoding fixes at once, which
 *   the sequential fuzzyWhitespace/fuzzyContent passes above can miss since
 *   neither combines trim+normalize) and, for multi-line needles, a full-
 *   buffer partial-match rescue (finds the needle's leading lines outside the
 *   resolved scope — rescues the case where a prior edit shifted the target
 *   region). Set false for callers that want strict, predictable matching
 *   only, with no automatic transform guessing.
 *
 * Returns on success:
 *   { matched: true, matchLine, matchEndLine, transforms: [...], totalMatches,
 *     actualLines: [...] }   (actualLines = real buffer content at the match —
 *     needed so a fuzzyWhitespace commit can preserve real indentation)
 *
 * Returns on failure:
 *   { matched: false, reason: 'noMatch'|'ambiguous'|'invalidRegex', ...}
 */
function matchContent(needle, { allLines, text }, scope, opts = {}) {
  const { fuzzyWhitespace = false, fuzzyContent = false, regex = false, autoRescue = true } = opts;
  const occurrence = contentOccurrence(scope, opts.occurrence); // S1: null/undefined when the scope anchor already spent it
  const startRow = Math.max(0, scope.searchStart);
  const endRow   = Math.min(allLines.length - 1, scope.searchEnd);
  const scopedLines = allLines.slice(startRow, endRow + 1);

  if (regex) {
    const scopedText = scopedLines.join('\n');
    let re;
    // 'gm', NOT 'g' (2026-09-21, PJ: "follow the regex standard"). str_replace already compiles its regex with
    // 'gm' (mcp-registration.js L575), and line-oriented tools (grep, sed, editor find) treat ^ and $ as LINE
    // anchors. With plain 'g' they anchored to the start/end of the WHOLE scoped text, so '^\s*const' never
    // matched, and '^function' silently returned ONLY the first line even when two lines matched (found live:
    // K5 in test/_s4_scratch_regex3.js) -- a silent pick, the one thing a destructive tool must not do. With 'm'
    // that case is reported as ambiguous and occurrence:N chooses. Behaviour change: a pattern that used ^ or $
    // as a whole-text anchor can now match more places, i.e. report ambiguous where it used to pick one.
    try { re = new RegExp(needle, 'gm'); } catch (e) {
      return { matched: false, reason: 'invalidRegex', message: e.message };
    }
    const matches = [...scopedText.matchAll(re)];
    if (matches.length === 0) return { matched: false, reason: 'noMatch', transforms: ['regex'] };
    // ROWS come from the FIRST and LAST NON-WHITESPACE character of the match, not its raw edges (2026-09-21,
    // found live: `delete` matchString '\s*const total = \d;' dry-ran as "delete lines 1-2" -- the \s* ate the
    // newline before the line, so 'function alpha() {' was included). Every consumer works in WHOLE LINES
    // (delete removes rows, insert positions after a row, replace-block anchors on a row), and \s* / a literal
    // \n at either edge would otherwise pull in the neighbouring row. A match with NO non-whitespace character
    // (e.g. \n\n, or an empty match) has nothing to trim to, so it keeps its raw edges, exactly as before.
    const rowsOf = (mm) => {
      const s = mm[0];
      const lead = s.search(/\S/);
      if (lead < 0) {
        const r0 = startRow + scopedText.substring(0, mm.index).split('\n').length - 1;
        return { first: r0, last: r0 + s.split('\n').length - 1 };
      }
      const trail = s.length - s.trimEnd().length;
      const firstIdx = mm.index + lead;                 // first non-whitespace character
      const lastIdx  = mm.index + s.length - trail - 1; // last non-whitespace character
      return {
        first: startRow + scopedText.substring(0, firstIdx).split('\n').length - 1,
        last:  startRow + scopedText.substring(0, lastIdx).split('\n').length - 1,
      };
    };
    if (matches.length > 1 && occurrence == null) {
      return { matched: false, reason: 'ambiguous', matchLines: matches.map(mm => rowsOf(mm).first + 1) };
    }
    if (occurrenceOutOfRange(occurrence, matches.length)) {
      return occurrenceFail(occurrence, matches.length, matches.map(mm => rowsOf(mm).first + 1));
    }
    const m = matches[(occurrence ?? 1) - 1];
    const { first: matchLine, last: matchEndLine } = rowsOf(m);
    return {
      matched: true,
      matchLine,
      matchEndLine,
      transforms: ['regex'],
      totalMatches: matches.length,
      actualLines: allLines.slice(matchLine, matchEndLine + 1),
    };
  }

  const needleLines = needle.split('\n');
  const n = needleLines.length;
  const transforms = [];
  let salvagedComment = null;
  let matchLineCount = n; // may grow/shrink if a recover.js rescue rebuilds a needle of different length

  let hits = scanBlock(scopedLines, needleLines, (a, b) => a === b);

  if (hits.length === 0 && fuzzyWhitespace) {
    hits = scanBlock(scopedLines, needleLines, (a, b) => a.trim() === b.trim());
    if (hits.length > 0) transforms.push('fuzzyWhitespace');
  }

  if (hits.length === 0 && fuzzyContent) {
    const normNeedleLines = needleLines.map(normUnicode);
    hits = scanBlock(scopedLines, normNeedleLines, (a, b) => normUnicode(a) === b);
    if (hits.length > 0) transforms.push('fuzzyContent');
  }

  // B32 recover stage #1 — combined single-pass diagnosis (recover.js
  // profiledMatch). Only attempted automatically once the explicit waterfall
  // above has found nothing; stays within the resolved scope.
  if (hits.length === 0 && autoRescue && !regex) {
    const scopedText = scopedLines.join('\n');
    const profiled = profiledMatch(needle, scopedText);
    if (profiled && profiled.ambiguous) {
      // B41: recover.js signalled two similar-enough lines within the scoped
      // window -- do not silently pick one. Surface as a normal ambiguous
      // match failure (same shape the caller already handles from the exact
      // waterfall above).
      return { matched: false, reason: 'ambiguous', matchLines: null,
        message: 'fuzzy rescue found more than one similar candidate in scope -- narrow old_str, tighten the scope hint, or use occurrence:N.' };
    }
    if (profiled) {
      const idx = scopedText.indexOf(profiled.rebuiltNeedle);
      if (idx !== -1) {
        const pick = scopedText.substring(0, idx).split('\n').length - 1;
        hits = [pick];
        matchLineCount = profiled.rebuiltNeedle.split('\n').length;
        if (profiled.tags.fuzzyContent)          transforms.push('fuzzyContent');
        else if (profiled.tags.fuzzyWhitespace)  transforms.push('fuzzyWhitespace');
        if (profiled.tags.autoStripComment)      transforms.push('autoStripComment');
        salvagedComment = profiled.salvagedComment;
      }
    }
  }

  // B32 recover stage #2 — full-buffer partial-match rescue (recover.js
  // partialMatchRescue). Last resort: searches OUTSIDE the resolved scope, so
  // it only runs once everything above (which all respect the caller's scope)
  // has found nothing. Early return — the rescued match's line count may
  // differ from matchLineCount/n above, and it isn't scope-relative like the
  // hits[]/pick machinery the rest of this function uses.
  if (hits.length === 0 && autoRescue && !regex && n > 1) {
    const rescue = partialMatchRescue(needle, text, text.split('\n').slice(0, startRow).join('\n').length, text.split('\n').slice(0, endRow + 1).join('\n').length);
    if (rescue && rescue.ambiguous) {
      // B41: recover.js signalled the leading-lines text occurs more than
      // once anywhere in the file -- do not silently rescue against the
      // first hit. Surface as ambiguous rather than guessing.
      return { matched: false, reason: 'ambiguous', matchLines: null,
        message: 'partial-match rescue found similar text in more than one place in the file -- narrow old_str, tighten the scope hint, or use occurrence:N.' };
    }
    if (rescue) {
      const idx = text.indexOf(rescue.rebuiltNeedle, rescue.leaderIdx);
      if (idx !== -1) {
        const matchLine       = text.substring(0, idx).split('\n').length - 1;
        const rescueLineCount = rescue.rebuiltNeedle.split('\n').length;
        return {
          matched: true,
          matchLine,
          matchEndLine: matchLine + rescueLineCount - 1,
          transforms: [...transforms, 'fuzzyWhitespace', 'partialMatch'],
          totalMatches: 1,
          actualLines: allLines.slice(matchLine, matchLine + rescueLineCount),
          salvagedComment,
          outsideScope: rescue.outsideScope,
        };
      }
    }
  }

  if (hits.length === 0) {
    return { matched: false, reason: 'noMatch', transforms };
  }
  if (hits.length > 1 && occurrence == null) {
    return { matched: false, reason: 'ambiguous', matchLines: hits.map(h => startRow + h + 1) };
  }

  if (occurrenceOutOfRange(occurrence, hits.length)) {
    return occurrenceFail(occurrence, hits.length, hits.map(h => startRow + h + 1));
  }
  const pick = hits[(occurrence ?? 1) - 1];
  const matchLine = startRow + pick;
  return {
    matched: true,
    matchLine,
    matchEndLine: matchLine + matchLineCount - 1,
    transforms,
    totalMatches: hits.length,
    actualLines: allLines.slice(matchLine, matchLine + matchLineCount),
    salvagedComment,
  };
}

// ── STEP 3b: MATCH A BRACE-DELIMITED BLOCK ──────────────────────────────────

/**
 * matchBlock(anchor, { allLines }, scope, opts)
 *
 * Shares resolveScope() with every other tool for hint resolution, then does
 * what matchContent() can't: locate an anchor LINE within the resolved scope
 * and brace-match forward from it to find a whole { } block, rather than
 * matching a literal multi-line needle. Built for replace-block (T-block,
 * 2026-09-18), which previously hand-rolled its own scope resolution AND its
 * own brace-counting privately (see session notes [28]) — this only replaces
 * the anchor-finding half; brace-counting itself has no meaningful "fuzzy" or
 * "regex" variant so it stays a single plain algorithm here, shared for any
 * future block-shaped tool rather than duplicated again.
 *
 * opts: { occurrence, fuzzyWhitespace } — same semantics as matchContent:
 *   occurrence == null with >1 anchor hit in scope → ambiguous (safe refusal);
 *   occurrence:N picks the Nth anchor line, including occurrence:1 explicit
 *   (the [27] fix — no separate off-by-one convention introduced here).
 *
 * Returns on success:
 *   { matched: true, matchLine: anchorRow, matchEndLine: closeBraceRow,
 *     braceStartRow, transforms: [], totalMatches, actualLines }
 *   (matchLine/matchEndLine name-match matchContent's shape so applyEdit()
 *   and buildMatchResponse() work unmodified on the result.)
 *
 * Returns on failure:
 *   { matched: false, reason: 'noMatch'|'ambiguous'|'braceMatchFailed', ... }
 */
function matchBlock(anchor, { allLines }, scope, opts = {}) {
  const { fuzzyWhitespace = false } = opts;
  const occurrence = contentOccurrence(scope, opts.occurrence); // S1
  const startRow = Math.max(0, scope.searchStart);
  const endRow   = Math.min(allLines.length - 1, scope.searchEnd);

  const cmp = fuzzyWhitespace
    ? (line) => line.trim().includes(anchor.trim())
    : (line) => line.includes(anchor);

  const hits = [];
  for (let i = startRow; i <= endRow; i++) {
    if (cmp(allLines[i])) hits.push(i);
  }

  if (hits.length === 0) {
    return { matched: false, reason: 'noMatch', transforms: [] };
  }
  if (hits.length > 1 && occurrence == null) {
    return { matched: false, reason: 'ambiguous', matchLines: hits.map(h => h + 1) };
  }

  if (occurrenceOutOfRange(occurrence, hits.length)) {
    return occurrenceFail(occurrence, hits.length, hits.map(h => h + 1));
  }
  const anchorRow = hits[(occurrence ?? 1) - 1];

  // Find next { at or after anchorRow (bail on a bare declaration `;` first)
  let braceStartRow = -1;
  for (let i = anchorRow; i < allLines.length; i++) {
    if (allLines[i].includes('{')) { braceStartRow = i; break; }
    if (i > anchorRow && allLines[i].includes(';')) break;
  }
  if (braceStartRow === -1) {
    return { matched: false, reason: 'braceMatchFailed', anchorRow };
  }

  // Brace-count forward to the matching close.
  let depth = 0;
  let closeRow = -1;
  for (let i = braceStartRow; i < allLines.length; i++) {
    for (const ch of allLines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { closeRow = i; break; } }
    }
    if (closeRow !== -1) break;
  }
  if (closeRow === -1) {
    return { matched: false, reason: 'braceMatchFailed', anchorRow, braceStartRow };
  }

  return {
    matched: true,
    matchLine: anchorRow,
    matchEndLine: closeRow,
    braceStartRow,
    transforms: [],
    totalMatches: hits.length,
    actualLines: allLines.slice(anchorRow, closeRow + 1),
  };
}

// ── STEP 4: EDIT ───────────────────────────────────────────────────────────
// ── STEP 3b: MATCH — matchFunction (replace-function-body port, 2026-09-18) ─
//
// Resolves a NAMED FUNCTION to its complete tree-sitter symbol range
// (signature line through closing brace) inside the window resolveScope()
// already computed. Unlike matchBlock, no anchor-scan or brace-count is
// needed — resolveSymbolPosition already returns exact bounds from the
// parse tree. scope's other hints (afterFunction/afterString/betweenHint/
// etc.) act purely as a disambiguation WINDOW here, narrowing which
// same-named candidate is meant — they do not themselves name the target.
//
// Ambiguity/occurrence follows the same convention as matchBlock/resolveScope
// (fixed per the occurrence:1-explicit vs omitted distinction, session note
// [27]): omitted + >1 candidate in scope → refuse with candidate line list;
// occurrence:N → resolve directly, never silently guesses.
//
// NOTE: intentionally does NOT accept an "outer containing function" hint
// (replace-function-body's old inFunction-as-outer-scope). That parameter
// was a modifier on the implicit target name rather than a real anchor,
// had zero real-world usage, and the scenario it existed for (two function
// DEFINITIONS sharing a name in one translation unit) isn't legal C —
// removed rather than ported. See session notes [33]-[37].
function matchFunction(fnName, { allLines }, scope, opts = {}) {
  const { symbols = [] } = opts;
  const occurrence = contentOccurrence(scope, opts.occurrence); // S1
  const startRow = Math.max(0, scope.searchStart);
  const endRow   = Math.min(allLines.length - 1, scope.searchEnd);

  const candidates = symbols
    .filter(s => s.name === fnName && s.startRow >= startRow && s.startRow <= endRow)
    .sort((a, b) => a.startRow - b.startRow);

  if (candidates.length === 0) {
    return { matched: false, reason: 'noMatch', transforms: [] };
  }
  if (candidates.length > 1 && occurrence == null) {
    return { matched: false, reason: 'ambiguous', matchLines: candidates.map(c => c.startRow + 1) };
  }

  if (occurrenceOutOfRange(occurrence, candidates.length)) {
    return occurrenceFail(occurrence, candidates.length, candidates.map(c => c.startRow + 1));
  }
  const sym = candidates[(occurrence ?? 1) - 1];

  return {
    matched: true,
    matchLine: sym.startRow,
    matchEndLine: sym.endRow,
    transforms: [],
    totalMatches: candidates.length,
    actualLines: allLines.slice(sym.startRow, sym.endRow + 1),
    sig: sym.sig,
    kind: sym.kind,
  };
}

// ── STEP 4: EDIT ───────────────────────────────────────────────────────────

/**
 * applyEdit(buffer, match, newStr)
 * Writes newStr over the matched line range. Returns { linesChanged, newLineCount, startRow, endRow }.
 * Caller is responsible for old_str/new_str semantics (e.g. new_str:'' = delete).
 *
 * B39/B40 port (2026-09-17) — str_replace's own hand-rolled commit path has two
 * safety checks match-engine.js never had: B39 re-verifies the buffer hasn't
 * drifted since matchContent() ran (a fast successive edit can shift line
 * numbers between match-time and write-time) and relocates or refuses rather
 * than write at a stale row; B40 verifies the live buffer's actual content at
 * the target rows is still byte-for-byte what matchContent() reported
 * (match.actualLines) immediately before writing, refusing rather than
 * splicing into the wrong place if it isn't. Both are real, independently
 * battle-tested (B39: v0.20.0; B40 follow-on same session) safety nets str_replace
 * has and this engine didn't — ported here because they're strictly better
 * than the bare setTextInRange() this function previously did, not because
 * str_replace itself needed porting (see mcp-server-refactor-plan.md B32 —
 * the rest of str_replace's hand-rolled matching logic was independently
 * hardened via B38/B57/B58 and is NOT a gap versus this engine).
 *
 * Adapted from str_replace's offset-based version (buffer.getText() substring
 * compare) to this engine's row-based match shape: compares actual buffer
 * lines at [startRow, endRow] against match.actualLines instead of a raw
 * character-offset substring. Verification is skipped if the caller didn't
 * provide actualLines (older/partial match results) to avoid a hard
 * dependency on every caller populating it — never a hard requirement, only
 * ever a safety upgrade when available.
 *
 * Returns on drift/verification failure: { error: 'driftUnrecoverable' | 'verifyFailed' }
 * instead of the usual success shape — caller must check for `error` before
 * treating the return as a completed edit.
 */
function applyEdit(buffer, match, newStr) {
  let startRow = match.matchLine;
  let endRow   = match.matchEndLine;

  // B39: re-verify the target rows still hold what matchContent() found.
  // If not (buffer drifted since matching), try to relocate by searching for
  // the same actualLines block nearby; if that fails too, refuse rather than
  // guess — same remediation shape as str_replace's commitIndex fallback.
  if (match.actualLines && match.actualLines.length > 0) {
    const liveLines = buffer.getLines();
    const stillThere = match.actualLines.every((l, i) => liveLines[startRow + i] === l);
    if (!stillThere) {
      const blockText = match.actualLines.join('\n');
      const liveText  = liveLines.join('\n');
      const idx = liveText.indexOf(blockText);
      if (idx === -1) {
        return { error: 'driftUnrecoverable' };
      }
      startRow = liveText.substring(0, idx).split('\n').length - 1;
      endRow   = startRow + match.actualLines.length - 1;
    }

    // B40: byte-for-byte verify the (possibly relocated) target rows one more
    // time immediately before writing — catches drift the row realignment
    // above wouldn't (e.g. genuinely identical-looking lines at a different
    // location that happened to satisfy the indexOf above by coincidence).
    const freshLines = buffer.getLines();
    const verifyOk = match.actualLines.every((l, i) => freshLines[startRow + i] === l);
    if (!verifyOk) {
      return { error: 'verifyFailed' };
    }
  }

  const oldLineCount = endRow - startRow + 1;
  const ensured = newStr.endsWith('\n') || newStr === '' ? newStr : newStr + '\n';
  buffer.setTextInRange([[startRow, 0], [endRow + 1, 0]], ensured);
  const newLineCount = buffer.getLineCount();
  const newLines = newStr === '' ? 0 : newStr.split('\n').length;
  const linesChanged = newLines - oldLineCount;
  return { linesChanged, newLineCount, startRow, endRow };
}

/**
 * applyEditSpan(buffer, match, newStr)   (S4b, 2026-09-22)
 *
 * Span-mode sibling of applyEdit: writes newStr over a single-line
 * [row, startCol, endCol) fragment (lib/fragment-match.js's matchFragment
 * shape) instead of a whole-row range. Pure addition -- no existing tool
 * calls this yet; nothing changes until a caller opts in.
 *
 * Keeps the same B39/B40 shape as applyEdit (re-verify the target hasn't
 * drifted since matching, relocate if possible, refuse rather than guess) but
 * expressed in row+column terms against match.actualText instead of
 * match.actualLines:
 *   B39 -- if buffer.getLines()[row].slice(startCol, endCol) no longer equals
 *   actualText, first try the SAME row (a same-row edit before this one can
 *   shift columns without shifting rows -- cheap common case worth trying
 *   before a full-buffer search); then fall back to a full-buffer search for
 *   actualText and relocate to wherever it's found. Refuses (driftUnrecoverable)
 *   if it can't be found at all.
 *   B40 -- byte-for-byte re-verify at the (possibly relocated) span
 *   immediately before writing, exactly as applyEdit does for rows.
 *
 * Returns on success: { row, startCol, endCol, newLineCount }
 * Returns on drift/verification failure: { error: 'driftUnrecoverable' | 'verifyFailed' }
 * -- caller must check `error` before treating the return as a completed edit.
 */
function applyEditSpan(buffer, match, newStr) {
  let { row, startCol, endCol } = match;
  const actualText = match.actualText;

  const stillThere = (lines) => typeof lines[row] === 'string' && lines[row].slice(startCol, endCol) === actualText;

  let liveLines = buffer.getLines();
  if (!stillThere(liveLines)) {
    // Same-row rescan first (cheap, common case: another edit shifted columns on this row only).
    const sameRowCol = typeof liveLines[row] === 'string' ? liveLines[row].indexOf(actualText) : -1;
    if (sameRowCol !== -1) {
      startCol = sameRowCol;
      endCol   = sameRowCol + actualText.length;
    } else {
      // Full-buffer relocate: first row anywhere that contains actualText.
      let found = false;
      for (let r = 0; r < liveLines.length; r++) {
        if (typeof liveLines[r] === 'string') {
          const c = liveLines[r].indexOf(actualText);
          if (c !== -1) { row = r; startCol = c; endCol = c + actualText.length; found = true; break; }
        }
      }
      if (!found) return { error: 'driftUnrecoverable' };
    }
  }

  // B40: byte-for-byte re-verify the (possibly relocated) span immediately before writing.
  const freshLines = buffer.getLines();
  if (!stillThere(freshLines)) {
    return { error: 'verifyFailed' };
  }

  buffer.setTextInRange([[row, startCol], [row, endCol]], newStr);
  const newLineCount = buffer.getLineCount ? buffer.getLineCount() : undefined;
  return { row, startCol, endCol, newLineCount };
}

// ── STEP 5: RESPOND ────────────────────────────────────────────────────────

/**
 * buildMatchResponse({ tool, match, edit, buffer, scopeLabel, warnings, dryRun })
 * Success path — wraps buildEditResponse with tags derived from match.transforms.
 */
async function buildMatchResponse({ tool, match, edit, buffer, scopeLabel = '', warnings = {}, dryRun = false }) {
  const tags = (match.transforms || []).slice();
  if (match.totalMatches > 1) tags.push(`occurrence used (${match.totalMatches} total matches)`);
  return buildEditResponse(
    { tool, line: edit.startRow + 1, linesChanged: edit.linesChanged, scopeLabel, tags, dryRun, buffer },
    warnings
  );
}

// features.retryOnFail field lookup, by tool name — kept here rather than
// plumbed in from tool-framework.js's features object, since match-engine.js
// is meant to stay self-contained (same reasoning smartSuggestion already
// uses toolName for its own tool-specific behavior rather than taking a
// features object). Only list tools that actually have a single, obvious
// "this field is almost always the one that was wrong" candidate — str_replace's
// old_str, delete's matchString, replace-block/replace-function-body's anchor.
// Keep in sync with each tool's features.retryOnFail.field in mcp-registration.js.
const RETRY_FIELD_BY_TOOL = {
  str_replace: 'old_str',
  delete: 'matchString',
  'replace-block': 'anchor',
  'replace-function-body': 'anchor',
};

function retryNudge(tool) {
  const field = RETRY_FIELD_BY_TOOL[tool];
  if (!field) return '';
  return `\n💡 Retry cheaply: read or grep-file the actual current content first, then call ${tool} again with just { filePath, ${field}: '<corrected value>' } — no need to resend the rest of the call.`;
}

/**
 * diagnoseFailure({ tool, ctx, scope, needle, subject, fuzzyAdvice })   (S4, 2026-09-21)
 *
 * The DIAGNOSE + TALLY half of a content-match failure, extracted from buildFailResponse so a
 * tool with its OWN framing (a different header, tool-specific notes, its own retry policy) can
 * still share the diagnosis and the fails.* counters instead of hand-rolling a weaker copy.
 * buildFailResponse calls this with the defaults; delete Mode 4 (startContent/endContent) calls it
 * directly. str_replace will too (S4e).
 *
 * It runs diagnose() (PURE, lib/fail-diagnostics.js) and does the shared bump()s. It returns the
 * message pieces but does NOT assemble a response: the caller owns the header, smartSuggestion
 * (which needs its own noHintsUsed rule), the retry nudge and the return shape.
 *
 *   subject     what to call the needle in the messages (default 'old_str').
 *   fuzzyAdvice false = do not recommend fuzzyWhitespace:true (for calls that do not honour it).
 *
 * returns {
 *   diag,      the raw diagnose() result
 *   hasScope,  boolean -- use it for smartSuggestion's noHintsUsed if you have no better rule
 *   statKey,   which shared fails.* key was bumped ('whitespace'|'encoding'|'partialMatch'|'noMatch')
 *   pre,       string[]  header-less: whitespace/partial/closest-area/similarity/drift nudge
 *   post,      string[]  the scanForOldStr messages (NOT FOUND ANYWHERE / inside / outside scope)
 * }
 * Order the caller should use: header, ...pre, [tool notes], smartSuggestion, ...post, [retry nudge].
 */
function diagnoseFailure({ tool, ctx, scope, needle, subject, fuzzyAdvice }) {
  // str_replace counts occurrence toward "has a scope" ONLY when > 1 (mcp-registration.js L278-281);
  // the engine's own _hasScope also counts occurrence:1. When no real scope resolved (via 'none')
  // apply str_replace's rule, so the "inside scope" vs "found at" wording and the NO HINTS USED
  // nudge agree between tools. (Found live 2026-09-21: occurrence:1 alone flipped the message.)
  const hasScope = !!(scope && scope._hasScope) &&
    !(scope.via === 'none' && !(scope.hints && scope.hints.occurrence > 1));
  // Window = WHOLE FILE (diagStart 0, diagEnd null) EXCEPT where str_replace narrows it or where the
  // search itself was a raw-row window:
  //   - inFunction / betweenHint: str_replace narrows its diagnosis to the function/region
  //     (mcp-registration.js L1011-1016) and so must we, or the two tools diagnose different text
  //     (found live 2026-09-21: 89% vs 61%).
  //   - via 'afterRow' (delete Mode 4's start/end anchors; PJ 2026-09-21: "narrow the window"): the search
  //     covered ONLY searchStart..EOF, so diagnosing the rows above it reports text the search never looked
  //     at as a near miss (found live: an endContent existing exactly BEFORE the start anchor was called
  //     "100% ... whitespace drift", with a Closest area above the start anchor). str_replace has no
  //     afterRow analogue, so there is no fidelity constraint against it here.
  // scope.searchStart..searchEnd are 0-based INCLUSIVE rows, hence the +1 for a slice end.
  // Narrowing every OTHER hint's window to the real scope is still a deliberate later change (PJ).
  // scanStart/scanEnd are the engine's real scope, gated on hasScope, as before.
  const _narrow = !!(scope && ((scope.hints && (scope.hints.inFunction || scope.hints.betweenHint)) || scope.via === 'afterRow'));
  const diag = diagnose({
    needle,
    allLines: ctx.allLines,
    scope: {
      diagStart: _narrow ? scope.searchStart : 0,
      diagEnd:   _narrow ? scope.searchEnd + 1 : null,
      hasScope: !!hasScope,
      scanStart: hasScope ? scope.searchStart : -1,
      scanEnd:   hasScope ? scope.searchEnd   : -1,
      label: scope && scope.scopeLabel ? scope.scopeLabel : '',
    },
    hints: (scope && scope.hints) || {},
    hintRadius: HINT_RADIUS,
    subject,
    fuzzyAdvice,
  });
  // PARALLEL TALLY (PJ, 2026-09-21): these shared keys count the DIAGNOSIS. A tool's own
  // call site may ALSO bump its tool-specific key (delete: fails.anchorNotFound) for the
  // same failure, so one failure can land in two keys on purpose. A missing key is a silent
  // no-op in bump(), which is why every engine tool's fails block carries all five.
  // Reason -> stats key mapping is str_replace's own (its L1055-1061), NOT the finer reason:
  //   whitespace/encoding -> that key; partialMatch only when 0 < run < needle lines; else noMatch.
  const statKey = diag.wsIssues.length > 0
    ? (diag.hasEncodingIssue ? 'encoding' : 'whitespace')
    : (diag.partialMatchLines > 0 && diag.partialMatchLines < diag.needleLineCount) ? 'partialMatch'
    : 'noMatch';
  bump(tool, 'fails.' + statKey);
  if (diag.foundOutsideScope) bump(tool, 'fails.foundOutsideScope');
  // messagesPre[0] is str_replace's own '? No match found for ...' header; the caller supplies its own.
  return { diag, hasScope, statKey, pre: diag.messagesPre.slice(1), post: diag.messagesPost };
}

/**
 * buildFailResponse({ tool, ctx, scope, match, needle, isCodeFile })
 * Failure path — covers BOTH scope-resolution failures (bad hint) and
 * content-match failures (hint fine, needle not found/ambiguous inside it).
 * ctx: { consec, allLines, text } — same shape as tool-framework's ctx.
 */
function buildFailResponse({ tool, ctx, scope, match, needle, isCodeFile = false }) {
  // -- scope resolution failed (bad/ambiguous hint) --
  if (scope && scope.error) {
    const { kind, hintName, hintValue, symbols, raw } = scope.error;
    if (kind === 'anchorError') {
      // Pre-formatted message from resolveScope (betweenHint anchors, and the
      // structural sectionHint/preprocBlock anchors). `ambiguous` is only set by
      // the structural anchors today; carried through so callers and the retry
      // framework can tell an ambiguity failure from a plain not-found.
      return { content: [{ type: 'text', text: scope.error.message }], matched: false, ambiguous: scope.error.ambiguous === true };
    }
    if (kind === 'needsTreeSitter') {
      return { content: [{ type: 'text', text: `❌ ${hintName}: "${hintValue}" requires an open editor with tree-sitter support (symbol kind 'any' needs a live parse tree). Open the file in a tab first, or use afterString/afterLine instead.` }], matched: false };
    }
    const msg = kind === 'notFound'
      ? anchorError(hintName, hintValue, null, symbols)
      : anchorError(hintName, hintValue, raw, null);
    const sugg = smartSuggestion({ toolName: tool, counter: ctx.consec, noHintsUsed: false, fileLines: ctx.allLines.length, oldStr: needle, isCodeFile });
    // No retryNudge here, deliberately: this branch is a HINT failure (bad/ambiguous
    // function, symbol, string or line anchor), not a content-match failure. The retry
    // field a tool advertises (old_str / matchString / anchor) is the CONTENT being
    // matched, so retrying with a corrected value cannot fix a bad hint -- advertising it
    // here pointed callers at the wrong field (and, for tools without features.retryOnFail
    // wired, at a mechanism that does not exist). Fixed 2026-09-19 (hint-gap closure).
    return { content: [{ type: 'text', text: [msg, sugg].filter(Boolean).join('\n') }], matched: false, ambiguous: kind === 'ambiguous' };
  }

  // -- content match failed inside a resolved (or whole-file) scope --
  if (match && !match.matched) {
    // S1: occurrence asked for a match that does not exist. Refused, never clamped -- say so
    // plainly (this is NOT "content not found": the content matched, the index did not).
    if (match.reason === 'occurrenceOutOfRange') {
      const found = match.totalMatches;
      const at    = (match.matchLines || []).slice(0, 20).map(l => `L${l}`).join(', ');
      const range = found === 1 ? 'occurrence:1 (or omit it)' : `an occurrence between 1 and ${found}`;
      return { content: [{ type: 'text', text: `❌ ${tool}: occurrence:${match.occurrence} requested but only ${found} match${found === 1 ? '' : 'es'} found${scope && scope.scopeLabel ? scope.scopeLabel : ''}${at ? ` (${at})` : ''}. Nothing was changed — use ${range}, or tighten the scope hint.` }], matched: false, ambiguous: false };
    }
    if (match.reason === 'ambiguous') {
      const ambig = ambiguityCheck({
        needle, fullText: ctx.text, noScopeHint: true, toolName: tool, isCodeFile,
        existingMatchLines: match.matchLines,
      });
      if (ambig) return ambig;
    }
    // The diagnosis and the shared fails.* tally live in diagnoseFailure() (above) so tools with their
    // own framing can share them. This is the DEFAULT framing: the engine's tool-naming header, the
    // diagnosis, smartSuggestion BETWEEN the pre and post groups, retryNudge LAST -- the original
    // str_replace order. (str_replace's own '? No match found...' header is dropped by diagnoseFailure.)
    const { hasScope, pre, post } = diagnoseFailure({ tool, ctx, scope, needle });
    const parts = [`❌ ${tool}: content not found${scope && scope.scopeLabel ? scope.scopeLabel : ''}.`];
    for (const m of pre) parts.push(m);
    parts.push(smartSuggestion({ toolName: tool, counter: ctx.consec, noHintsUsed: !hasScope, fileLines: ctx.allLines.length, oldStr: needle, isCodeFile }));
    for (const m of post) parts.push(m);
    parts.push(retryNudge(tool));
    return { content: [{ type: 'text', text: parts.filter(Boolean).join('\n') }], matched: false };
  }

  return { content: [{ type: 'text', text: `❌ ${tool}: unknown match-engine failure` }], matched: false };
}

// ---------------------------------------------------------------------------
// buildInsertPreview — shared dryRun preview builder for `insert` (T2, 2026-07-20)
// ---------------------------------------------------------------------------
// insert's three content/structural-anchor branches (afterFunction/afterSymbol/
// afterString/betweenHint, sectionHint/preprocBlock, afterContent/beforeContent)
// each hand-rolled an identical context+insert-lines preview block, differing
// only in (a) the sentence describing *where* the insert lands and (b) a small
// per-branch offset on how far back the "before" context window starts (see
// beforeOffset below — the sectionHint/preprocBlock branch and the
// beforeContent case both need +1 because their insertRow already sits one
// row past the anchor they still want shown in context). Collapsing these
// was the last open item under T2 in mcp-server-refactor-plan.md.
//
// suffix       — appended directly after "line(s)" in the header sentence,
//                e.g. ' within function "foo" (anchor line 12)' — include any
//                leading space the caller wants.
// beforeOffset — extra rows to look further back before insertRow when
//                building the "before" context window (0 for a plain
//                after-anchor insert, 1 when insertRow is already one past
//                the anchor line that should still show as context).
function buildInsertPreview({ allLines, lineCount, insertRow, new_str, suffix = '', radius = 3, beforeOffset = 0 }) {
  const cs = Math.max(0, insertRow - radius - beforeOffset);
  const ce = Math.min(lineCount - 1, insertRow + radius);
  const ctxLines   = allLines.slice(cs, Math.min(insertRow, ce + 1)).map((l, i) => `${String(cs + i + 1).padStart(4)}   ${l}`);
  const insLines   = new_str.split('\n').map(l => `    + ${l}`);
  const afterLines = allLines.slice(insertRow, ce + 1).map((l, i) => `${String(insertRow + i + 1).padStart(4)}   ${l}`);
  const lineCountIns = new_str.split('\n').length;
  return {
    content: [{ type: 'text', text: [
      `🔍 DRY RUN — will insert ${lineCountIns} line(s)${suffix}.`,
      `\nContext (+ = lines to be inserted):\n${[...ctxLines, ...insLines, ...afterLines].join('\n')}`,
      `\nReply with the same call without dryRun (or dryRun:false) to commit \u2014 or just insert({ filePath, commitLastPreview: true }) to apply this exact preview without resending new_str.`
    ].join('\n') }],
    dryRun: true,
    insertRow: insertRow + 1,
    lineCount,
  };
}

// ---------------------------------------------------------------------------
// buildReplacePreview — shared dryRun preview builder for replace-style tools
// (S4d, 2026-09-23)
// ---------------------------------------------------------------------------
// str_replace's own dry-run block (mcp-registration.js, the "DRY RUN — match
// found" branch) hand-rolls this exact shape: a context window with the
// matched rows marked, then a "- old" / "+ new" diff, then the commit
// instruction. It is the replace-side sibling of buildInsertPreview above,
// which did the same collapsing job for insert's three anchor branches (T2).
// Nothing calls this yet -- pure addition, no existing tool's behavior
// changes until something opts in, same as S4b's fragment-match.js.
//
// Shape chosen to match matchContent/matchBlock/matchFunction's own return
// values directly: matchLine/matchLines are already what those three
// functions hand back, so a caller can pass its `match` result through with
// no reshaping.
//
//   matchLine   0-based row of the first matched line (matchContent's
//               match.matchLine / matchBlock's / matchFunction's own field).
//   matchLines  the actual matched lines (string[]), e.g. match.actualLines --
//               used both to mark the context window and to build the "- "
//               half of the diff.
//   new_str     replacement text (possibly multi-line).
//   scopeLabel  e.g. ' within function "foo"' -- appended verbatim after
//               "match found at line N", matching str_replace's own wording.
//   tags        string[] of bracketed annotations, e.g. ['fuzzyWhitespace'],
//               rendered as ' [fuzzyWhitespace] [regex]' etc. -- replaces
//               str_replace's own inline ternary chain
//               (fuzzyWhitespace?...:"")(fuzzyContent?...)(regex?...) with a
//               plain array so callers don't have to hand-build that chain.
function buildReplacePreview({ allLines, lineCount, matchLine, matchLines, new_str, scopeLabel = '', tags = [] }) {
  const radius = 3;
  const matchLineCount = matchLines.length;
  const ctxStart = Math.max(0, matchLine - radius);
  const ctxEnd = Math.min(lineCount - 1, matchLine + matchLineCount - 1 + radius);
  const preview = allLines.slice(ctxStart, ctxEnd + 1)
    .map((l, i) => {
      const abs = ctxStart + i;
      const inMatch = abs >= matchLine && abs < matchLine + matchLineCount;
      return `${String(abs + 1).padStart(4)}${inMatch ? ' ❯' : '  '} ${l}`;
    }).join('\n');
  const diffLines = matchLines.map(l => `- ${l}`).concat(new_str.split('\n').map(l => `+ ${l}`)).join('\n');
  const tagSuffix = tags.length ? tags.map(t => ` [${t}]`).join('') : '';
  return {
    content: [{ type: 'text', text: [
      `🔍 DRY RUN — match found at line ${matchLine + 1}${scopeLabel}${tagSuffix}.`,
      `\nContext (❯ = lines to be replaced):\n${preview}`,
      `\nProposed diff:\n${diffLines}`,
      `\nReply with the same call without dryRun (or dryRun:false) to commit.`
    ].join('\n') }],
    matched: true,
    dryRun: true,
    matchLine: matchLine + 1,
  };
}

module.exports = {
  resolveScope,
  matchContent,
  matchBlock,
  matchFunction,
  applyEdit,
  applyEditSpan,
  buildMatchResponse,
  buildFailResponse,
  diagnoseFailure,
  buildInsertPreview,
  buildReplacePreview,
  retryNudge,
};
