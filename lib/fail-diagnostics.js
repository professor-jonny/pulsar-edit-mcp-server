'use strict';
// fail-diagnostics.js (S4-1, 2026-09-21)
//
// PURE failure-diagnosis for a no-match edit. Extracted from str_replace's
// matchIndex === -1 branch (lib/mcp-registration.js ~L1006-1266) so the shared
// match-engine can give every tool the same rich failure message.
//
// PJ DIRECTION: REPRODUCE str_replace's behaviour EXACTLY in this first cut,
// FIX QUIRKS LATER. Every quirk below is deliberately preserved and is pinned
// by a named fixture in test/s4_diagnostics_test.js so that fixing one later is
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
const { scanForOldStr }       = require('./tool-hints');

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
function classify({ wsIssues, hasEncodingIssue, partialMatchLines, afterLine, beforeLine }) {
  return wsIssues.length > 0 ? (hasEncodingIssue ? 'encoding' : 'whitespace')
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
function diagnose({ needle, allLines, scope, hints, hintRadius, subject, fuzzyAdvice }) {
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
  if (partialMatchLines > 0 && partialMatchLines < lines.length) {
    pre.push(`\n${Q2}  PARTIAL MATCH: first ${partialMatchLines} of ${lines.length} lines matched consecutively, then diverged. Likely a trailing-whitespace or indentation difference on line ${partialMatchLines + 1}.`);
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
  pre.push(_exactOnlyOutside
    ? `\n${Q1}${Q1} The text itself exists exactly (see FOUND OUTSIDE SCOPE below), so the problem is WHERE it is being searched, not the text.`
    : `\n${Q1}${Q1} Similarity: ${simPct}% ${EM} ${tier.hint}`);

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

  if (_fullScan === null || _fullScan.total === 0) {
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
        `\n${LENS} MATCH LOCATION FOUND inside scope at ${_locs} ${EM} but exact text comparison failed (see whitespace/partial match detail above).` +
        `\n   \u2192 Re-read lines around ${_fullScan.hitsInsideScope[0].line} with read, rebuild ${S} from the current buffer, then retry.`
      );
    }
    if (hasScope && _fullScan.hitsOutsideScope.length > 0) {
      foundOutsideScope = true; // QUIRK 5: caller bumps fails.foundOutsideScope
      const _locs = _fullScan.hitsOutsideScope.slice(0, 5).map(h => `L${h.line} (${h.funcCtx})`).join(', ');
      post.push(
        `\n${SIRN} FOUND OUTSIDE SCOPE ${EM} ${S} exists in the file but NOT inside ${scopeLabel || 'the active scope'}.` +
        (_label ? ` (hint: ${_label})` : '') +
        `\n   Hit(s) outside scope: ${_locs}${_fullScan.truncated ? ' ' + ELL : ''}` +
        `\n   \u2192 Either widen the scope hint or change inFunction/betweenHint to target the right region.`
      );
    }
    if (!hasScope) {
      const _allLocs = [..._fullScan.hitsInsideScope, ..._fullScan.hitsOutsideScope]
        .slice(0, 5).map(h => `L${h.line} (${h.funcCtx})`).join(', ');
      post.push(
        `\n${LENS} ${S} found at ${_allLocs}${_fullScan.truncated ? ' ' + ELL : ''} ${EM} but exact match failed (see whitespace/partial match detail above).` +
        `\n   \u2192 Re-read lines around the target, rebuild ${S} from current buffer content, and add a scope hint (afterString/inFunction) to narrow the search.`
      );
    }
  }

  return {
    reason: classify({ wsIssues, hasEncodingIssue, partialMatchLines, afterLine: hints.afterLine, beforeLine: hints.beforeLine }),
    wsIssues,
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
  wsScan, partialScan, closestArea, similarityTier, activeHintLabel, classify,
};
