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
const { buildEditResponse } = require('./edit-response');
const { profiledMatch, partialMatchRescue } = require('./recover'); // B32

// ── STEP 2: SCOPE ──────────────────────────────────────────────────────────

/**
 * resolveScope({ editor, buffer, allLines, text, filePath, params })
 *
 * Reads every hint style (inFunction, betweenHint, afterFunction/beforeFunction,
 * afterSymbol/beforeSymbol, afterString/beforeString, afterLine/beforeLine)
 * and resolves them to a single search window, using the same decision-ladder
 * priority str_replace's description already teaches the LLM.
 *
 * params: { inFunction, betweenHint, afterFunction, beforeFunction,
 *           afterSymbol, beforeSymbol, afterString, beforeString,
 *           afterLine, beforeLine, occurrence, hintRadius }
 *
 * Returns on success:
 *   { searchStart, searchEnd, scopeLabel, _hasScope, anchorRow?, via, positional? }
 *   (searchStart/searchEnd are 0-based row bounds, inclusive)
 *
 * Returns on failure:
 *   { error: { kind: 'notFound'|'ambiguous'|'anchorError'|'needsTreeSitter',
 *              hintName, hintValue, symbols?, raw?, message? } }
 */
function resolveScope({ editor, buffer, allLines, text, filePath, params }) {
  const {
    inFunction, betweenHint, afterFunction, beforeFunction,
    afterSymbol, beforeSymbol, afterString, beforeString,
    afterLine, beforeLine, afterRow, occurrence, hintRadius, fuzzyWhitespace = false,
  } = params || {};
  const radius = hintRadius || HINT_RADIUS;
  const symbols = getSymbols(editor, text, filePath);
  const hasHint = !!(inFunction || betweenHint || afterFunction || beforeFunction ||
    afterSymbol || beforeSymbol || afterString || beforeString ||
    afterLine != null || beforeLine != null || afterRow != null || occurrence != null);

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

  if (inFunction) {
    const r = resolveSymbolPosition(symbols, inFunction, 'function', 'inside', radius);
    if (r.notFound)   return { error: { kind: 'notFound', hintName: 'inFunction', hintValue: inFunction, symbols } };
    if (r.ambiguous) {
      if (occurrence != null && occurrence <= r.matches.length) {
        const m = r.matches[occurrence - 1];
        return { searchStart: m.startRow, searchEnd: m.endRow, scopeLabel: ` within function "${inFunction}" (occurrence ${occurrence})`, _hasScope: true, anchorRow: m.startRow, via: 'inFunction' };
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
        return { searchStart, searchEnd, scopeLabel: ` ${dir} function "${name}" (occurrence ${occurrence})`, _hasScope: true, anchorRow, via: hintName };
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
        return { searchStart, searchEnd, scopeLabel: ` ${dir} symbol "${name}" (occurrence ${occurrence})`, _hasScope: true, anchorRow, via: hintName };
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
        return { searchStart, searchEnd, scopeLabel: ` (occurrence ${occurrence})`, _hasScope: true, anchorRow, via: hintName };
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

/**
 * matchContent(needle, { allLines, text }, scope, opts)
 *
 * Upfront waterfall: exact match, then fuzzyWhitespace (trim-compare),
 * * opts: { fuzzyWhitespace, fuzzyContent, regex, occurrence, isCodeFile,
 *         autoRescue }
 *   autoRescue (default true, B32) — after the explicit waterfall above finds
 *   nothing, automatically try lib/recover.js's combined-transform diagnosis
 *   (catches a line needing BOTH whitespace and encoding fixes at once, which
 *   the sequential fuzzyWhitespace/fuzzyContent passes above can miss since
 *   neither combines trim+normalize) and, for multi-line needles, a full-
 *   buffer partial-match rescue (finds the needle's leading lines outside the
 *   resolved scope — rescues the case where a prior edit shifted the target
 *   region). Set false for callers that want strict, predictable matching
 *   only, with no automatic transform guessing.Whitespace, fuzzyContent, regex, occurrence, isCodeFile,hitespace, fuzzyContent, regex, occurrence, isCodeFile }
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
  const { fuzzyWhitespace = false, fuzzyContent = false, regex = false, occurrence, autoRescue = true } = opts;
  const startRow = Math.max(0, scope.searchStart);
  const endRow   = Math.min(allLines.length - 1, scope.searchEnd);
  const scopedLines = allLines.slice(startRow, endRow + 1);

  if (regex) {
    const scopedText = scopedLines.join('\n');
    let re;
    try { re = new RegExp(needle, 'g'); } catch (e) {
      return { matched: false, reason: 'invalidRegex', message: e.message };
    }
    const matches = [...scopedText.matchAll(re)];
    if (matches.length === 0) return { matched: false, reason: 'noMatch', transforms: ['regex'] };
    if (matches.length > 1 && occurrence == null) {
      const lines = matches.map(m => startRow + scopedText.substring(0, m.index).split('\n').length);
      return { matched: false, reason: 'ambiguous', matchLines: lines };
    }
    const m = matches[Math.min(occurrence ?? 1, matches.length) - 1];
    const matchLine = startRow + scopedText.substring(0, m.index).split('\n').length - 1;
    const consumedLines = m[0].split('\n').length;
    return {
      matched: true,
      matchLine,
      matchEndLine: matchLine + consumedLines - 1,
      transforms: ['regex'],
      totalMatches: matches.length,
      actualLines: allLines.slice(matchLine, matchLine + consumedLines),
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

  const pick = hits[Math.min(occurrence ?? 1, hits.length) - 1];
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
  const { occurrence, fuzzyWhitespace = false } = opts;
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

  const anchorRow = hits[Math.min(occurrence ?? 1, hits.length) - 1];

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
  const { occurrence, symbols = [] } = opts;
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

  const sym = candidates[Math.min(occurrence ?? 1, candidates.length) - 1];

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
      return { content: [{ type: 'text', text: scope.error.message }], matched: false };
    }
    if (kind === 'needsTreeSitter') {
      return { content: [{ type: 'text', text: `❌ ${hintName}: "${hintValue}" requires an open editor with tree-sitter support (symbol kind 'any' needs a live parse tree). Open the file in a tab first, or use afterString/afterLine instead.` }], matched: false };
    }
    const msg = kind === 'notFound'
      ? anchorError(hintName, hintValue, null, symbols)
      : anchorError(hintName, hintValue, raw, null);
    const sugg = smartSuggestion({ toolName: tool, counter: ctx.consec, noHintsUsed: false, fileLines: ctx.allLines.length, oldStr: needle, isCodeFile });
    return { content: [{ type: 'text', text: [msg, sugg].filter(Boolean).join('\n') }], matched: false, ambiguous: kind === 'ambiguous' };
  }

  // -- content match failed inside a resolved (or whole-file) scope --
  if (match && !match.matched) {
    if (match.reason === 'ambiguous') {
      const ambig = ambiguityCheck({
        needle, fullText: ctx.text, noScopeHint: true, toolName: tool, isCodeFile,
        existingMatchLines: match.matchLines,
      });
      if (ambig) return ambig;
    }
    const hasScope = scope && scope._hasScope;
    const scan = scanForOldStr({
      needle,
      allLines: ctx.allLines,
      scopeStart: hasScope ? scope.searchStart : -1,
      scopeEnd:   hasScope ? scope.searchEnd   : -1,
    });
    const parts = [`❌ ${tool}: content not found${scope && scope.scopeLabel ? scope.scopeLabel : ''}.`];
    if (scan && scan.hitsOutsideScope && scan.hitsOutsideScope.length > 0) {
      parts.push(`💡 Found OUTSIDE the active scope at: ${scan.hitsOutsideScope.map(h => `L${h.line} (${h.funcCtx})`).join(', ')} — content may have drifted, or the hint is scoping to the wrong region.`);
    } else if (scan === null) {
      parts.push(`   Content not found anywhere in the file — check for typos or re-read the region.`);
    }
    parts.push(smartSuggestion({ toolName: tool, counter: ctx.consec, noHintsUsed: !hasScope, fileLines: ctx.allLines.length, oldStr: needle, isCodeFile }));
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
      `\nReply with the same call without dryRun (or dryRun:false) to commit.`
    ].join('\n') }],
    dryRun: true,
    insertRow: insertRow + 1,
    lineCount,
  };
}

module.exports = {
  resolveScope,
  matchContent,
  matchBlock,
  matchFunction,
  applyEdit,
  buildMatchResponse,
  buildFailResponse,
  buildInsertPreview,
};
