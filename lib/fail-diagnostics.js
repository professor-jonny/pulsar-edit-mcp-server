'use strict';
// fail-diagnostics.js (S4-1, 2026-09-21)
//
// PURE failure-diagnosis for a no-match edit. Extracted from str_replace's
// matchIndex === -1 branch (lib/mcp-registration.js ~L1006-1266) so the shared
// match-engine can give every tool the same rich failure message.
//
// PJ DIRECTION: REPRODUCE str_replace's behaviour EXACTLY in this first cut,
// FIX QUIRKS LATER. Every quirk below is deliberately preserved and is pinned
// by a named fixture in test/fail-diagnostics.test.js so that fixing one later is
// a visible, deliberate change and not an accident.
//
//   QUIRK 1  hasEncodingIssue looks unreachable (see wsScan). Reproduced as-is.
//   QUIRK 2  diagnosis window honours only inFunction/betweenHint; every other
//            hint diagnoses against the WHOLE FILE. Reproduced: the caller passes
//            scope.diagStart/diagEnd and this module trusts them.
//   QUIRK 3  diffVsBuffer is dead data (always null). NOT this module's job: the
//            caller owns logFailure. Noted here so nobody hunts for it.
//   QUIRK 4  the fault-log bufferPreview anchors at the scope start, not at the
//            failure row. Caller-owned (logFailure). Noted for the same reason.
//   QUIRK 5  the foundOutsideScope stat bump was a side effect buried in message
//            building. Here it is RETURNED as a flag; the CALLER bumps.
//   QUIRK 6  faultBuckets.contentFaults uses (wsIssues===0 && partialMatchLines===0)
//            which is NOT the same test as the noMatch classification. So raw
//            partialMatchLines + needleLineCount are RETURNED and callers must
//            not re-derive.
//   QUIRK 7  the fault-log reason is finer than the stats reason (adds
//            hintFault:afterLine:contentMiss / hintFault:beforeLine:contentMiss).
//            This module returns the FINER reason; the caller maps down.
//
// WHAT THIS MODULE DOES NOT DO (the CALLER does all of it, so a tool only ever
// touches stat keys that exist in its own schema):
//   - any bump()                    - logFailure()
//   - ctx.consec.count++            - smartSuggestion() / retryNudge()
//
// Non-ASCII characters are written as \u escapes on purpose: the byte-identical
// test compares against the source in mcp-registration.js, and a hand-typed
// emoji is exactly the kind of thing that drifts silently.

const { calculateSimilarity } = require('./string-utils');
const { midLineEdge } = require('./mid-line-hint'); // R1h 2026-10-17: wording for a needle that starts/ends mid-line
const { scanForOldStr }       = require('./tool-hints');
const { diagnoseComments, formatCommentAdvice } = require('./comment-diagnosis'); // 2026-10-11: comment mismatch is a failure reason
const { diagnoseElsewhere, formatElsewhereAdvice } = require('./outside-scope-diagnosis'); // 2026-10-11: text found outside the scope is a failure reason, never an edit

// -- literal glyphs copied from the source (verified by code point) -----------
const EM   = '\u2014';          // em dash, used throughout
const ELL  = '\u2026';          // ellipsis, only in the no-scope "found at" line
const BULB = '\uD83D\uDCA1';    // U+1F4A1  (drift nudge)
const XMRK = '\u274C';          // U+274C   (NOT FOUND ANYWHERE)
const LENS = '\uD83D\uDD0D';    // U+1F50D  (MATCH LOCATION / old_str found at)
const SIRN = '\uD83D\uDEA8';    // U+1F6A8  (FOUND OUTSIDE SCOPE)
// The source has LITERAL question marks here (not mojibake). Checked by code point.
const Q1 = '?';                 // "? No match found ..." / "? Fix indentation ..." / "? Closest ..." prefixes
const Q2 = '??';                // "??  WHITESPACE MISMATCH" / "??  PARTIAL MATCH"

// HINT_RADIUS is only used in the afterLine/beforeLine drift nudge. The caller
// passes it in so this module stays free of tree-sitter-symbols.
const CONTEXT_RADIUS = 4;

// ---------------------------------------------------------------------------
// wsScan -- per-line whitespace vs encoding classification (str_replace L1019-1040)
// Returns { wsIssues, hasEncodingIssue }.
//
// QUIRK 1: the encoding test only runs on lines that ALREADY matched by .trim(),
// and then requires the whitespace-STRIPPED strings to differ AND contain a
// non-ASCII character. If the trims are equal, the stripped strings can differ
// only through inner whitespace, which is never non-ASCII, so this looks
// unreachable. Reproduced exactly; the S4 test proves or disproves it.
// ---------------------------------------------------------------------------
function wsScan(lines, diagLines, diagOffset) {
  const wsIssues = [];
  let hasEncodingIssue = false;
  for (let li = 0; li < lines.length; li++) {
    const trimmed = lines[li].trim();
    if (!trimmed) continue; // QUIRK: blank needle lines are never diagnosed
    const bufferHit = diagLines.findIndex(bl => bl.trim() === trimmed && bl !== lines[li]);
    if (bufferHit !== -1) {
      wsIssues.push({
        searchLine: li + 1,
        searchText: JSON.stringify(lines[li]),
        bufferLine: bufferHit + diagOffset + 1,
        bufferText: JSON.stringify(diagLines[bufferHit]),
      });
      if (!hasEncodingIssue) {
        const a = lines[li].replace(/\s/g, '');
        const b = diagLines[bufferHit].replace(/\s/g, '');
        if (a !== b && /[^\u0000-\u007F]/.test(a + b)) hasEncodingIssue = true;
      }
    }
  }
  return { wsIssues, hasEncodingIssue };
}

// ---------------------------------------------------------------------------
// partialScan -- longest run of leading needle lines matching consecutively
// anywhere in the window (str_replace L1043-1052). Multi-line needles only.
// ---------------------------------------------------------------------------
function partialScan(lines, diagLines) {
  let partialMatchLines = 0;
  if (lines.length > 1) {
    for (let start = 0; start < diagLines.length; start++) {
      let matched = 0;
      while (matched < lines.length && start + matched < diagLines.length && diagLines[start + matched] === lines[matched]) {
        matched++;
      }
      if (matched > partialMatchLines) partialMatchLines = matched;
    }
  }
  return partialMatchLines;
}

// ---------------------------------------------------------------------------
// partialWhy -- the sentence that says WHY the line after a partial match diverged (2026-11-03).
// str_replace always said "Likely a trailing-whitespace or indentation difference", even when the line
// differed in content or the region simply ended. Now: whitespace only (the two lines are equal once all
// whitespace is removed) keeps that sentence; a different line says so; a needle that runs past the end of the
// searched region says that. `matched` is partialScan's result; the FIRST window with that run is used, the same
// one partialScan found.
// ---------------------------------------------------------------------------
function partialWhy(lines, diagLines, matched) {
  const n = matched + 1;
  const whitespaceSentence = `Likely a trailing-whitespace or indentation difference on line ${n}.`;
  if (!(matched > 0) || matched >= lines.length) return whitespaceSentence;
  for (let start = 0; start < diagLines.length; start++) {
    let run = 0;
    while (run < lines.length && start + run < diagLines.length && diagLines[start + run] === lines[run]) run++;
    if (run !== matched) continue;
    const bufferLine = diagLines[start + matched];
    if (bufferLine === undefined) return `The searched region ends after those lines, so line ${n} has nothing to match.`;
    if (bufferLine.replace(/\s+/g, '') === lines[matched].replace(/\s+/g, '')) return whitespaceSentence;
    return `Line ${n} differs in content, not only in whitespace.`;
  }
  return whitespaceSentence;
}

// ---------------------------------------------------------------------------
// annotateMissingFile -- an edit tool pointed at a path that does not exist gets an EMPTY buffer, so the failure
// blamed the anchor ("afterString not found") for what is really a wrong path (2026-11-03, TODO F4). The framework
// calls this on the handler's result when the file is missing on disk; it only APPENDS a note to a failure result
// (an error text starting with the cross mark, or matched:false). Successes, dry-run previews and anything of an
// odd shape are returned untouched. Behaviour is otherwise unchanged: an edit that succeeds on a missing path
// still creates the file as before.
// ---------------------------------------------------------------------------
function annotateMissingFile(result, filePath) {
  if (!result || !Array.isArray(result.content) || !result.content[0] || typeof result.content[0].text !== 'string') return result;
  const text = result.content[0].text;
  if (!(result.matched === false || text.startsWith('\u274C'))) return result;
  result.content[0].text = text + `\n\u26A0\uFE0F The file does not exist on disk: ${filePath} \u2014 check the path first; this failure is probably caused by a wrong path, not by the anchor or match text.`;
  return result;
}

// ---------------------------------------------------------------------------
// closestArea -- word-overlap search for the nearest region (str_replace L1064-1079).
// Context is drawn from allLines (real line numbers), not the diag window.
// ---------------------------------------------------------------------------
function closestArea(lines, diagLines, diagOffset, allLines) {
  const firstMeaningfulLine = lines.find(l => l.trim().length > 3) || lines[0];
  const words = firstMeaningfulLine.trim().split(/\s+/).filter(w => w.length > 3);
  let fuzzyRow = -1;
  if (words.length > 0) {
    let bestScore = 0;
    for (let i = 0; i < diagLines.length; i++) {
      const score = words.filter(w => diagLines[i].includes(w)).length;
      if (score > bestScore) { bestScore = score; fuzzyRow = i + diagOffset; }
    }
    // Plausibility floor: on a needle with only 1-2 meaningful words, a single word match
    // is often the whole signal available (e.g. a one-word typo still shares its other
    // word) and is kept. From 3 meaningful words up, require at least half to have
    // matched before trusting fuzzyRow -- otherwise a single incidental word match on a
    // long/repetitive-vocabulary file can win `bestScore` and silently point "Closest
    // area found" / similarity at the wrong row, producing a confidently-specific but
    // wrong percentage.
    const minPlausible = words.length <= 2 ? 1 : Math.ceil(words.length / 2);
    if (bestScore < minPlausible) { fuzzyRow = -1; }
  }
  const ctxStart = fuzzyRow >= 0 ? Math.max(0, fuzzyRow - CONTEXT_RADIUS) : 0;
  const ctxEnd   = fuzzyRow >= 0 ? Math.min(allLines.length - 1, fuzzyRow + CONTEXT_RADIUS) : Math.min(7, allLines.length - 1);
  const text = allLines.slice(ctxStart, ctxEnd + 1)
    .map((l, i) => `${String(ctxStart + i + 1).padStart(4)}: ${l}`).join('\n');
  return { fuzzyRow, ctxStart, ctxEnd, text };
}

// ---------------------------------------------------------------------------
// similarityTier -- tiers >=80 / >=50 / low (str_replace L1105-1112).
// ---------------------------------------------------------------------------
// subject   : what the caller calls the needle in messages (default 'old_str', str_replace's own word).
// fuzzyAdvice: false drops the "try fuzzyWhitespace:true" recommendation, for tools whose call does not
//              honour that flag (delete Mode 4 startContent/endContent, 2026-09-21) -- advising a flag
//              that does nothing would be worse than saying nothing. Defaults keep the output byte-identical.
// wsFound    : (2026-09-21, PJ: "only when a whitespace mismatch is found") whether diagnose() actually FOUND a
//              whitespace mismatch. The "likely whitespace/indentation drift" claim is made ONLY then. A plain
//              typo or a wrong character also scores >= 80 with no whitespace difference at all, and telling the
//              caller to fix indentation there sends them the wrong way (found live: 'const totl = 1;' scored
//              83% and was blamed on drift). undefined (a caller that does not know) keeps the old wording, so
//              the exported function is unchanged for anyone who does not pass it.
function similarityTier(simPct, subject, fuzzyAdvice, wsFound) {
  const S = subject || 'old_str';
  const closeTail = fuzzyAdvice === false ? 'Re-read that region.' : 'Try fuzzyWhitespace:true or re-read that region.';
  const closeHint = wsFound === false
    ? 'Content is close but not identical ' + EM + ' compare it character by character with the buffer (a typo, a wrong character, or an invisible/Unicode difference).'
    : 'Content is close ' + EM + ' likely whitespace/indentation drift. ' + closeTail;
  if (simPct >= 80) return { tier: 'close',    hint: closeHint };
  if (simPct >= 50) return { tier: 'moderate', hint: 'Moderate match ' + EM + ' ' + S + ' may be stale. Re-read the file with read and rebuild ' + S + ' from current buffer content.' };
  return               { tier: 'low',      hint: 'Low match ' + EM + ' ' + S + ' may be pointing at the wrong location entirely. Verify scope hints and re-read the target area.' };
}

// ---------------------------------------------------------------------------
// activeHintLabel -- plain-English label for the active hint (str_replace L1155-1165).
// Precedence is significant and reproduced exactly.
// ---------------------------------------------------------------------------
function activeHintLabel(h) {
  return h.afterString    ? `afterString:"${h.afterString.substring(0, 50)}"`
       : h.afterLine   != null ? `afterLine:${h.afterLine}`
       : h.beforeString   ? `beforeString:"${h.beforeString.substring(0, 50)}"`
       : h.beforeLine  != null ? `beforeLine:${h.beforeLine}`
       : h.inFunction     ? `inFunction:"${h.inFunction}"`
       : h.betweenHint    ? `betweenHint`
       : h.afterFunction  ? `afterFunction:"${h.afterFunction}"`
       : h.beforeFunction ? `beforeFunction:"${h.beforeFunction}"`
       : h.afterSymbol    ? `afterSymbol:"${h.afterSymbol}"`
       : h.beforeSymbol   ? `beforeSymbol:"${h.beforeSymbol}"`
       : null;
}

// ---------------------------------------------------------------------------
// classify -- the FINER reason (QUIRK 7). Order is significant.
// ---------------------------------------------------------------------------
function classify({ wsIssues, hasEncodingIssue, partialMatchLines, afterLine, beforeLine, commentIssueCount = 0 }) {
  return wsIssues.length > 0 ? (hasEncodingIssue ? 'encoding' : 'whitespace')
       : commentIssueCount > 0 ? 'comment'
       : partialMatchLines > 0 ? 'partialMatch'
       : (afterLine  != null) ? 'hintFault:afterLine:contentMiss'
       : (beforeLine != null) ? 'hintFault:beforeLine:contentMiss'
       : 'noMatch';
}

// ---------------------------------------------------------------------------
// diagnose -- the entry point.
//
// input:
//   needle     string   the old text that failed to match
//   allLines   string[] full buffer lines
//   scope      {
//                diagStart  0-based first row of the DIAGNOSIS window (== diagOffset)
//                diagEnd    0-based row AFTER the last row of the window, or null = to end
//                             (QUIRK 2: the CALLER decides; str_replace passes a narrowed
//                              window only for inFunction/betweenHint)
//                hasScope   boolean  any scope hint active (str_replace's _hasScope)
//                scanStart  0-based scope start for scanForOldStr, or -1
//                scanEnd    0-based scope end   for scanForOldStr, or -1
//                label      string   scopeLabel ('' if none)
//              }
//   hints      { afterString, afterLine, beforeString, beforeLine, inFunction,
//                betweenHint, afterFunction, beforeFunction, afterSymbol, beforeSymbol }
//   hintRadius number   HINT_RADIUS, used only in the drift nudge text
//
// returns:
//   { reason, wsIssues, hasEncodingIssue, partialMatchLines, needleLineCount,
//     closestRow, context:{start,end,text}, similarity, similarityTier,
//     scanResult, foundOutsideScope, messages: string[] }
//
// `messages` is the ordered list of pieces str_replace pushed into `parts`,
// EXCLUDING smartSuggestion() and retryNudge() (caller-owned, per-tool state).
// The caller splices them where it always did: after `messages[0..n]`, the
// smartSuggestion goes BETWEEN the drift nudge and the scan messages. To keep
// that ordering exact this module returns the messages in TWO groups.
// ---------------------------------------------------------------------------
function diagnose({ needle, allLines, scope, hints, hintRadius, subject, fuzzyAdvice, midLine, midLineWhat }) {
  scope = scope || {};
  hints = hints || {};
  const S = subject || 'old_str';   // what the caller calls the needle; default = str_replace's own word
  const fuzzy = fuzzyAdvice !== false; // false = do not recommend fuzzyWhitespace:true (see similarityTier)
  const lines = String(needle).split('\n');

  const diagOffset = scope.diagStart || 0;
  const diagLines  = (scope.diagEnd == null && diagOffset === 0)
    ? allLines
    : allLines.slice(diagOffset, scope.diagEnd == null ? undefined : scope.diagEnd);

  const { wsIssues, hasEncodingIssue } = wsScan(lines, diagLines, diagOffset);
  const partialMatchLines = partialScan(lines, diagLines);
  const commentIssues = diagnoseComments({ needleLines: lines, haystackLines: diagLines, diagOffset });
  const area = closestArea(lines, diagLines, diagOffset, allLines);

  const scopeLabel = scope.label || '';
  const pre = [`${Q1} No match found for ${S}${scopeLabel || ''}.`];

  if (wsIssues.length > 0) {
    pre.push(`\n${Q2}  WHITESPACE MISMATCH on ${wsIssues.length} line(s) ${EM} content matches but indentation differs:`);
    for (const w of wsIssues) {
      pre.push(`  search line ${w.searchLine}: ${w.searchText}`);
      pre.push(`  buffer line ${w.bufferLine}: ${w.bufferText}`);
    }
    pre.push(`  ${Q1} Fix indentation in ${S} to match the buffer exactly` + (fuzzy ? ', OR retry with fuzzyWhitespace:true to commit using buffer indentation.' : '.'));
  }
  if (commentIssues.length > 0) {
    // A line whose code matches the buffer but whose trailing comment differs. A FAILURE with a precise
    // diagnosis, never an edit made behind the caller's back (PJ, 2026-10-11). The advice lines come from
    // the pure lib/comment-diagnosis.js; this module only frames them.
    const adv = formatCommentAdvice(commentIssues, { subject: S });
    pre.push(`\n${Q2}  COMMENT MISMATCH ${EM} ${adv[0]}`);
    for (const l of adv.slice(1)) pre.push(l);
  }
  if (partialMatchLines > 0 && partialMatchLines < lines.length && commentIssues.length === 0 && !midLine) {
    pre.push(`\n${Q2}  PARTIAL MATCH: first ${partialMatchLines} of ${lines.length} lines matched consecutively, then diverged. ${partialWhy(lines, diagLines, partialMatchLines)}`);
  }
  if (area.fuzzyRow >= 0) {
    pre.push(`\n${Q1}${Q1} Closest area found (lines ${area.ctxStart + 1}${EM}${area.ctxEnd + 1}):\n${area.text}`);
  }

  // The scanForOldStr call is PURE and runs here, BEFORE the similarity line, because that line's
  // wording depends on it (2026-09-21, PJ: "fix the wider wording"). Its messages are built further down.
  const hasScope = !!scope.hasScope;
  const _fullScan = scanForOldStr({
    needle: String(needle),
    allLines,
    scopeStart: hasScope ? (scope.scanStart == null ? -1 : scope.scanStart) : -1,
    scopeEnd:   hasScope ? (scope.scanEnd   == null ? -1 : scope.scanEnd)   : -1,
  });
  // EXACT text exists in the file, but only OUTSIDE the search scope. Then the failure is about WHERE the
  // caller searched, not about the text: it is not "stale" and there is no whitespace "drift". Keyed on the
  // SCAN, deliberately NOT on the similarity percentage: calculateSimilarity() rounds, so a long needle with
  // ONE wrong character also scores 100% (250 chars: 1 - 1/250 = 99.6% -> 100). "100%" does not mean exact.
  const _exactOnlyOutside = hasScope && !!_fullScan && _fullScan.hitsOutsideScope.length > 0 && _fullScan.hitsInsideScope.length === 0;
  // Text that is NOT exact anywhere but exists, ignoring whitespace, OUTSIDE the search scope: the case the
  // engine's old stage 2 (recover.partialMatchRescue) used to COMMIT behind the caller's back. It is a failure
  // with a precise diagnosis now (PJ, 2026-10-11). Only computed when a scope hint is active, the exact scan
  // found nothing and the needle has 2+ lines (partialMatchRescue's own limits). The character offsets mirror
  // what the old stage 2 passed: scopeStart = end of the row before the scope, scopeEnd = end of its last row.
  let _elsewhere = null;
  if (hasScope && !_exactOnlyOutside && lines.length > 1 && (_fullScan === null || _fullScan.total === 0)) {
    const _text = allLines.join('\n');
    const _s0 = (scope.scanStart == null || scope.scanStart < 0) ? 0 : allLines.slice(0, scope.scanStart).join('\n').length;
    const _s1 = (scope.scanEnd == null || scope.scanEnd < 0) ? _text.length : allLines.slice(0, scope.scanEnd + 1).join('\n').length;
    const _d = diagnoseElsewhere({ needleText: String(needle), fullText: _text, searchStart: _s0, searchEnd: _s1 });
    if (_d && (_d.ambiguous || _d.outsideScope)) _elsewhere = _d;
  }
  // A COMMENT MISMATCH is the lead diagnosis when no where-is-it explanation (exact outside scope, or
  // present elsewhere ignoring whitespace) applies. The generic "Similarity" and "NOT FOUND ANYWHERE" lines
  // would contradict it, because the code of the flagged line(s) DOES match (PJ, finding B, 2026-10-12).
  const _commentLed = commentIssues.length > 0 && !_exactOnlyOutside && !_elsewhere;

  // Similarity (runs for every failure, single- and multi-line). Uses area.fuzzyRow when
  // closestArea found a plausible row; otherwise falls back to diagOffset -- the resulting
  // tier is usually "Low match", which already tells the caller the location is uncertain.
  // The "Closest area found" CONTEXT BLOCK above is gated separately (area.fuzzyRow >= 0
  // only): that block asserts a specific location, which is the part that must not be shown
  // on a weak/implausible fuzzyRow. The similarity percentage itself is not a location claim.
  const simRow   = area.fuzzyRow >= 0 ? area.fuzzyRow : diagOffset;
  const bufSlice = allLines.slice(simRow, simRow + lines.length).join('\n');
  const simPct   = calculateSimilarity(String(needle), bufSlice);
  // wsIssues.length > 0 is passed as wsFound: the "whitespace/indentation drift" claim needs a real whitespace mismatch.
  const tier     = similarityTier(simPct, S, fuzzy ? undefined : false, wsIssues.length > 0);
  // When the text exists exactly outside the scope the percentage is HIDDEN (PJ, 2026-09-21): it describes the
  // closest text INSIDE the search window, and printed beside "exists exactly" it reads as a contradiction.
  // The number is still returned on the result object (similarity / similarityTier) for callers and tests.
  // No plausible row (area.fuzzyRow < 0): simPct compares old_str with the first rows of the window, i.e. with
  // unrelated text, so it is not printed (PJ, 2026-10-12, precision edits). When a located diagnosis already
  // exists (whitespace / encoding / partial match) nothing is added; otherwise say plainly that nothing similar was found.
  const _located = wsIssues.length > 0 || hasEncodingIssue || partialMatchLines > 0;
  const _simLine = _exactOnlyOutside
    ? `\n${Q1}${Q1} The text itself exists exactly (see FOUND OUTSIDE SCOPE below), so the problem is WHERE it is being searched, not the text.`
    : (_elsewhere && !_elsewhere.ambiguous)
      ? `\n${Q1}${Q1} The text itself exists ignoring whitespace (see FOUND ELSEWHERE below), so the problem is WHERE it is being searched, not the text.`
      : midLine
        ? `\n${Q1}${Q1} The text itself exists in the file, so the problem is not the text: ${S} ${midLineEdge(midLine)}, and ${midLineWhat || 'a whole-line replace'} only matches complete lines.`
        : _commentLed
        ? `\n${Q1}${Q1} The code on the line(s) flagged under COMMENT MISMATCH matches the buffer; only the trailing comment differs.`
        : (area.fuzzyRow < 0)
          ? (_located ? '' : `\n${Q1}${Q1} No similar location found in the search window: no line shares a distinctive word with ${S}. Verify scope hints and re-read the target area.`)
          : `\n${Q1}${Q1} Similarity: ${simPct}% ${EM} ${tier.hint}`;
  if (_simLine) pre.push(_simLine);

  // Drift nudge (afterLine / beforeLine)
  if (hints.afterLine != null || hints.beforeLine != null) {
    const _hintName = hints.afterLine != null ? 'afterLine' : 'beforeLine';
    const _hintVal  = hints.afterLine != null ? hints.afterLine : hints.beforeLine;
    const _anchorContent = allLines[_hintVal - 1] ? allLines[_hintVal - 1].trim() : null;
    pre.push(
      `\n${BULB} ${_hintName}:${_hintVal} window (${hintRadius} lines) ${EM} content may have drifted after prior edits.` +
      (_anchorContent ? `\n   Drift-immune alternative: use afterString:'${_anchorContent.substring(0, 60)}' instead of ${_hintName}.` : '') +
      `\n   Or re-run grep-file to confirm the current line number before retrying.`
    );
  }

  // -- scanForOldStr messages (AFTER the caller's smartSuggestion) ------------
  const post = [];
  let foundOutsideScope = false;
  const _label = activeHintLabel(hints);

  if (_elsewhere) {
    // Not exact anywhere, but present ignoring whitespace outside the scope (or in more than one place): say
    // where, and what to fix, instead of the false "does not appear anywhere in the file".
    const _adv = formatElsewhereAdvice(_elsewhere, { subject: S, scopeLabel: scopeLabel ? ' ' + String(scopeLabel).trim() : '' });
    post.push(`\n${SIRN} FOUND ELSEWHERE ${EM} ${_adv[0]}`);
    for (const l of _adv.slice(1)) post.push(l);
  } else if (_commentLed && (_fullScan === null || _fullScan.total === 0)) {
    // The exact old_str is not in the file, but only because of the trailing comment(s) diagnosed above:
    // say so instead of the contradictory "does not appear anywhere in the file".
    post.push(
      `\n${BULB} Fix the trailing comment(s) shown under COMMENT MISMATCH and retry; re-read the target area only if it still fails.` +
      (_label ? `\n   Hint used: ${_label}` : '')
    );
  } else if (_fullScan === null || _fullScan.total === 0) {
    post.push(
      `\n${XMRK} NOT FOUND ANYWHERE ${EM} ${S} does not appear anywhere in the file.` +
      (_label ? `\n   Hint used: ${_label}` : '') +
      `\n   Both the hint and the ${S} content should be verified.` +
      `\n   \u2192 Re-read the target area with read and rebuild ${S} from current buffer content.`
    );
  } else {
    if (hasScope && _fullScan.hitsInsideScope.length > 0) {
      const _locs = _fullScan.hitsInsideScope.slice(0, 5).map(h => `L${h.line} (${h.funcCtx})`).join(', ');
      post.push(
        `\n${LENS} MATCH LOCATION FOUND inside scope at ${_locs} ${EM} ${midLine ? 'the text is there; it only fails as a whole-line match.' : 'but exact text comparison failed (see whitespace/partial match detail above).'}` +
        (midLine ? '' : `\n   \u2192 Re-read lines around ${_fullScan.hitsInsideScope[0].line} with read, rebuild ${S} from the current buffer, then retry.`)
      );
    }
    if (hasScope && _fullScan.hitsOutsideScope.length > 0) {
      foundOutsideScope = true; // QUIRK 5: caller bumps fails.foundOutsideScope
      const _locs = _fullScan.hitsOutsideScope.slice(0, 5).map(h => `L${h.line} (${h.funcCtx})`).join(', ');
      post.push(
        `\n${SIRN} FOUND OUTSIDE SCOPE ${EM} ${S} exists in the file but NOT inside ${String(scopeLabel).trim() || 'the active scope'}.` +
        (_label ? ` (hint: ${_label})` : '') +
        `\n   Hit(s) outside scope: ${_locs}${_fullScan.truncated ? ' ' + ELL : ''}` +
        `\n   \u2192 Either widen the scope hint or change inFunction/betweenHint to target the right region.`
      );
    }
    if (!hasScope) {
      const _allLocs = [..._fullScan.hitsInsideScope, ..._fullScan.hitsOutsideScope]
        .slice(0, 5).map(h => `L${h.line} (${h.funcCtx})`).join(', ');
      post.push(
        `\n${LENS} ${S} found at ${_allLocs}${_fullScan.truncated ? ' ' + ELL : ''} ${EM} ${midLine ? 'the text is there; it only fails as a whole-line match.' : 'but exact match failed (see whitespace/partial match detail above).'}` +
        (midLine ? '' : `\n   \u2192 Re-read lines around the target, rebuild ${S} from current buffer content, and add a scope hint (afterString/inFunction) to narrow the search.`)
      );
    }
  }

  return {
    reason: classify({ wsIssues, hasEncodingIssue, partialMatchLines, afterLine: hints.afterLine, beforeLine: hints.beforeLine, commentIssueCount: commentIssues.length }),
    wsIssues,
    commentIssues,
    hasEncodingIssue,
    partialMatchLines,
    needleLineCount: lines.length,
    closestRow: area.fuzzyRow,
    context: { start: area.ctxStart, end: area.ctxEnd, text: area.text },
    similarity: simPct,
    similarityTier: tier.tier,
    scanResult: _fullScan,
    foundOutsideScope,
    exactOutsideScope: _exactOnlyOutside, // exact text exists, but only outside the search scope
    elsewhere: _elsewhere,                // null, or lib/outside-scope-diagnosis.js result: text present ignoring whitespace OUTSIDE the scope (or ambiguous); foundOutsideScope still means EXACT text only
    // Two groups so the CALLER can keep the original interleave:
    //   pre  -> [header ... similarity ... drift nudge]
    //   (caller pushes smartSuggestion here)
    //   post -> [scanForOldStr messages]
    //   (caller pushes retryNudge last)
    messagesPre: pre,
    messagesPost: post,
    // Convenience for callers with no smartSuggestion to interleave.
    messages: pre.concat(post),
  };
}

module.exports = {
  diagnose,
  // exported for the tests / for later stages that want a single piece
  wsScan, partialScan, partialWhy, annotateMissingFile, closestArea, similarityTier, activeHintLabel, classify,
};
