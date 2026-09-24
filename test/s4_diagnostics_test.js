'use strict';
// S4-1 unit test (2026-09-21) -- pure failure diagnostics (lib/fail-diagnostics.js).
// Run from the package root:   node test/s4_diagnostics_test.js
// Pure-function test: no Pulsar, no buffer. Reads lib/mcp-registration.js as TEXT only.
//
// PJ DIRECTION: the module REPRODUCES str_replace exactly; quirks are FIXED LATER.
// So this file has two kinds of test:
//   RULE    -- behaviour that is correct and must stay.
//   QUIRK   -- behaviour that is arguably WRONG but is deliberately preserved. Each is
//              a named fixture so that fixing it later is a visible, deliberate change
//              (the test must be edited on purpose) and not an accident.
//
// Rules under test:
//   1. Whitespace-only difference        -> reason 'whitespace', wsIssues filled.
//   2. Leading lines match then diverge   -> reason 'partialMatch', raw counts returned.
//   3. Content not in the buffer at all   -> reason 'noMatch'; NOT FOUND ANYWHERE.
//   4. Content exists outside the scope   -> foundOutsideScope flag set (caller bumps).
//   5. afterLine/beforeLine + no content  -> the FINER reason and the drift nudge.
//   6. Similarity tiers are >=80 / >=50 / low.
//   7. Message text is byte-identical to the source in mcp-registration.js.
//   8. diagnose() has no side effects: same input twice gives the same output.
//   9. Bad input does not throw.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const D      = require('../lib/fail-diagnostics');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

const EM = '\u2014';
const noScope = { hasScope: false, diagStart: 0, diagEnd: null, scanStart: -1, scanEnd: -1, label: '' };
const F = (extra) => Object.assign({ hintRadius: 25 }, extra);

// A small fixture buffer used by most tests.
const buf = [
  'function alpha() {',          // L1
  '  const total = 1;',          // L2
  '  return total;',             // L3
  '}',                           // L4
  '',                            // L5
  'function beta() {',           // L6
  '  const count = 2;',          // L7
  '  return count;',             // L8
  '}',                           // L9
];

// -- rule 1: whitespace --------------------------------------------------------
t('whitespace: indentation-only difference is classified whitespace', () => {
  const r = D.diagnose(F({ needle: 'const total = 1;', allLines: buf, scope: noScope, hints: {} }));
  assert.strictEqual(r.reason, 'whitespace');
  assert.strictEqual(r.wsIssues.length, 1);
  assert.strictEqual(r.wsIssues[0].searchLine, 1);
  assert.strictEqual(r.wsIssues[0].bufferLine, 2);
  assert.strictEqual(r.wsIssues[0].searchText, JSON.stringify('const total = 1;'));
  assert.strictEqual(r.wsIssues[0].bufferText, JSON.stringify('  const total = 1;'));
});
t('whitespace: the WHITESPACE MISMATCH block names both lines', () => {
  const r = D.diagnose(F({ needle: 'const total = 1;', allLines: buf, scope: noScope, hints: {} }));
  const all = r.messages.join('\n');
  assert.ok(all.includes('WHITESPACE MISMATCH on 1 line(s)'), all);
  assert.ok(all.includes('search line 1: "const total = 1;"'), all);
  assert.ok(all.includes('buffer line 2: "  const total = 1;"'), all);
  assert.ok(all.includes('retry with fuzzyWhitespace:true'), all);
});

// -- rule 2: partial match -----------------------------------------------------
t('partialMatch: leading lines match, then diverge; raw counts are returned', () => {
  const needle = 'function alpha() {\n  const total = 1;\n  return WRONG;';
  const r = D.diagnose(F({ needle, allLines: buf, scope: noScope, hints: {} }));
  assert.strictEqual(r.reason, 'partialMatch');
  assert.strictEqual(r.partialMatchLines, 2);
  assert.strictEqual(r.needleLineCount, 3);
  assert.ok(r.messages.join('\n').includes('PARTIAL MATCH: first 2 of 3 lines matched consecutively'));
  assert.ok(r.messages.join('\n').includes('difference on line 3.'));
});
t('partialMatch: a single-line needle never reports a partial match', () => {
  const r = D.diagnose(F({ needle: 'function alpha() { X', allLines: buf, scope: noScope, hints: {} }));
  assert.strictEqual(r.partialMatchLines, 0);
});

// -- rule 3: not found anywhere ------------------------------------------------
t('noMatch: content nowhere in the file gives NOT FOUND ANYWHERE', () => {
  const r = D.diagnose(F({ needle: 'zzz_absent_zzz();', allLines: buf, scope: noScope, hints: {} }));
  assert.strictEqual(r.reason, 'noMatch');
  assert.strictEqual(r.scanResult, null);
  assert.strictEqual(r.foundOutsideScope, false);
  assert.ok(r.messagesPost.join('\n').includes('NOT FOUND ANYWHERE'));
});
t('noMatch: the active hint is named in NOT FOUND ANYWHERE', () => {
  const r = D.diagnose(F({ needle: 'zzz_absent_zzz();', allLines: buf, scope: noScope, hints: { afterString: 'function beta' } }));
  assert.ok(r.messagesPost.join('\n').includes('Hint used: afterString:"function beta"'));
});

// -- rule 4: found outside scope -----------------------------------------------
t('outside scope: exact text elsewhere sets foundOutsideScope and lists the line', () => {
  const scope = { hasScope: true, diagStart: 0, diagEnd: null, scanStart: 0, scanEnd: 3, label: ' (inFunction "alpha")' };
  const r = D.diagnose(F({ needle: 'const count = 2;', allLines: buf, scope, hints: { inFunction: 'alpha' } }));
  assert.strictEqual(r.foundOutsideScope, true);
  const post = r.messagesPost.join('\n');
  assert.ok(post.includes('FOUND OUTSIDE SCOPE'), post);
  assert.ok(post.includes('Hit(s) outside scope: L7'), post);
  assert.ok(post.includes('(hint: inFunction:"alpha")'), post);
});
t('outside scope: with NO scope the hits are merged into one "old_str found at" line', () => {
  const r = D.diagnose(F({ needle: 'const count = 2;', allLines: buf, scope: noScope, hints: {} }));
  assert.strictEqual(r.foundOutsideScope, false);
  assert.ok(r.messagesPost.join('\n').includes('old_str found at L7'));
});
t('inside scope: exact text present in scope reports MATCH LOCATION FOUND', () => {
  const scope = { hasScope: true, diagStart: 5, diagEnd: 9, scanStart: 5, scanEnd: 8, label: '' };
  const r = D.diagnose(F({ needle: 'const count = 2;', allLines: buf, scope, hints: { inFunction: 'beta' } }));
  assert.ok(r.messagesPost.join('\n').includes('MATCH LOCATION FOUND inside scope at L7'));
});

// -- rule 5: afterLine / beforeLine --------------------------------------------
t('finer reason: afterLine with a content miss gives hintFault:afterLine:contentMiss', () => {
  const r = D.diagnose(F({ needle: 'zzz_absent_zzz();', allLines: buf, scope: noScope, hints: { afterLine: 2 } }));
  assert.strictEqual(r.reason, 'hintFault:afterLine:contentMiss');
});
t('finer reason: beforeLine with a content miss gives hintFault:beforeLine:contentMiss', () => {
  const r = D.diagnose(F({ needle: 'zzz_absent_zzz();', allLines: buf, scope: noScope, hints: { beforeLine: 8 } }));
  assert.strictEqual(r.reason, 'hintFault:beforeLine:contentMiss');
});
t('finer reason: a whitespace failure still wins over the afterLine miss', () => {
  const r = D.diagnose(F({ needle: 'const total = 1;', allLines: buf, scope: noScope, hints: { afterLine: 2 } }));
  assert.strictEqual(r.reason, 'whitespace');
});
t('drift nudge: afterLine shows the window size and a drift-immune afterString suggestion', () => {
  const r = D.diagnose(F({ needle: 'zzz_absent_zzz();', allLines: buf, scope: noScope, hints: { afterLine: 2 }, hintRadius: 25 }));
  const pre = r.messagesPre.join('\n');
  assert.ok(pre.includes('afterLine:2 window (25 lines)'), pre);
  assert.ok(pre.includes("use afterString:'const total = 1;' instead of afterLine."), pre);
});
t('drift nudge: absent when neither afterLine nor beforeLine is set', () => {
  const r = D.diagnose(F({ needle: 'zzz_absent_zzz();', allLines: buf, scope: noScope, hints: { afterString: 'function beta' } }));
  assert.ok(!r.messagesPre.join('\n').includes('window ('));
});

// -- rule 6: similarity tiers --------------------------------------------------
t('similarity: tier boundaries are >=80 close, >=50 moderate, else low', () => {
  assert.strictEqual(D.similarityTier(100).tier, 'close');
  assert.strictEqual(D.similarityTier(80).tier,  'close');
  assert.strictEqual(D.similarityTier(79).tier,  'moderate');
  assert.strictEqual(D.similarityTier(50).tier,  'moderate');
  assert.strictEqual(D.similarityTier(49).tier,  'low');
  assert.strictEqual(D.similarityTier(0).tier,   'low');
});
t('similarity: the result carries the numeric percentage and tier', () => {
  const r = D.diagnose(F({ needle: 'const total = 1;', allLines: buf, scope: noScope, hints: {} }));
  assert.strictEqual(typeof r.similarity, 'number');
  assert.ok(r.similarity >= 0 && r.similarity <= 100);
  assert.ok(['close', 'moderate', 'low'].includes(r.similarityTier));
});

// -- closest area --------------------------------------------------------------
t('closest area: +-4 lines of context with real line numbers, padded to 4', () => {
  const r = D.diagnose(F({ needle: 'return count;', allLines: buf, scope: noScope, hints: {} }));
  assert.ok(r.closestRow >= 0);
  assert.strictEqual(r.context.start, Math.max(0, r.closestRow - 4));
  assert.ok(/^\s{0,3}\d+: /.test(r.context.text));
});
t('closest area: with no usable word, falls back to rows 1-8', () => {
  const r = D.diagnose(F({ needle: 'a b', allLines: buf, scope: noScope, hints: {} }));
  assert.strictEqual(r.closestRow, -1);
  assert.strictEqual(r.context.start, 0);
  assert.strictEqual(r.context.end, 7);
  assert.ok(!r.messages.join('\n').includes('Closest area found'));
});

// -- rule 7: byte-identical to the source --------------------------------------
// The module cannot be diffed against a live str_replace (the branch is inline in a
// 7400-line closure), so pin its fixed strings against the SOURCE TEXT instead.
// Comparison happens inside Node on code points, never through console output
// (the Windows console renders U+2192 as U+001A).
const SRC_PATH = path.join(__dirname, '..', 'lib', 'mcp-registration.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const stripEsc = s => s; // strings below are compared verbatim, escapes already resolved by JS
const inSrc = (needle, label) => t('source-identical: ' + label, () => {
  assert.ok(SRC.includes(needle), 'mcp-registration.js does not contain: ' + JSON.stringify(needle));
});
inSrc('WHITESPACE MISMATCH on ${wsIssues.length} line(s) ' + EM + ' content matches but indentation differs:', 'whitespace header');
inSrc('Fix indentation in old_str to match the buffer exactly, OR retry with fuzzyWhitespace:true to commit using buffer indentation.', 'whitespace fix hint');
inSrc('PARTIAL MATCH: first ${partialMatchLines} of ${lines.length} lines matched consecutively, then diverged. Likely a trailing-whitespace or indentation difference on line ${partialMatchLines + 1}.', 'partial match line');
inSrc('Content is close ' + EM + ' likely whitespace/indentation drift. Try fuzzyWhitespace:true or re-read that region.', 'similarity tier: close');
inSrc('Moderate match ' + EM + ' old_str may be stale. Re-read the file with read and rebuild old_str from current buffer content.', 'similarity tier: moderate');
inSrc('Low match ' + EM + ' old_str may be pointing at the wrong location entirely. Verify scope hints and re-read the target area.', 'similarity tier: low');
inSrc('Closest area found (lines ${ctxStart + 1}' + EM + '${ctxEnd + 1}):', 'closest area header');
inSrc('Similarity: ${simPct}% ' + EM + ' ${simHint}', 'similarity line');
inSrc('content may have drifted after prior edits.', 'drift nudge');
inSrc('Drift-immune alternative: use afterString:', 'drift nudge alternative');
inSrc('Or re-run grep-file to confirm the current line number before retrying.', 'drift nudge tail');
inSrc('NOT FOUND ANYWHERE ' + EM + ' old_str does not appear anywhere in the file.', 'not found anywhere');
inSrc('Both the hint and the old_str content should be verified.', 'not found: verify');
inSrc('\u2192 Re-read the target area with read and rebuild old_str from current buffer content.', 'not found: arrow line');
inSrc('MATCH LOCATION FOUND inside scope at ${_locs} ' + EM + ' but exact text comparison failed (see whitespace/partial match detail above).', 'match location found');
inSrc('FOUND OUTSIDE SCOPE ' + EM + ' old_str exists in the file but NOT inside ${scopeLabel', 'found outside scope');
inSrc('Hit(s) outside scope: ${_locs}', 'outside scope hits');
inSrc('Either widen the scope hint or change inFunction/betweenHint to target the right region.', 'outside scope: widen');
inSrc('old_str found at ${_allLocs}', 'no-scope found-at');
inSrc('add a scope hint (afterString/inFunction) to narrow the search.', 'no-scope found-at tail');
// the glyphs themselves, by code point
t('source-identical: emoji code points used by the module exist in the source', () => {
  for (const cp of ['\uD83D\uDCA1', '\u274C', '\uD83D\uDD0D', '\uD83D\uDEA8', '\u2026']) {
    assert.ok(SRC.includes(cp), 'source is missing U+' + cp.codePointAt(0).toString(16).toUpperCase());
  }
});

// -- rule 8: purity -------------------------------------------------------------
t('purity: the same input twice gives deep-equal output', () => {
  const args = F({ needle: 'const total = 1;\n  return WRONG;', allLines: buf, scope: noScope, hints: { afterLine: 2 } });
  assert.deepStrictEqual(D.diagnose(args), D.diagnose(args));
});
t('purity: the input arrays and objects are not mutated', () => {
  const lines = buf.slice();
  const args = F({ needle: 'const total = 1;', allLines: lines, scope: Object.assign({}, noScope), hints: { afterLine: 2 } });
  const before = JSON.stringify(args);
  D.diagnose(args);
  assert.strictEqual(JSON.stringify(args), before);
});

// -- rule 9: bad input ----------------------------------------------------------
t('bad input: an empty buffer does not throw', () => {
  const r = D.diagnose(F({ needle: 'x', allLines: [], scope: noScope, hints: {} }));
  assert.strictEqual(r.reason, 'noMatch');
});
t('bad input: missing scope and hints objects do not throw', () => {
  assert.doesNotThrow(() => D.diagnose({ needle: 'x', allLines: buf }));
});
t('bad input: an empty needle does not throw', () => {
  assert.doesNotThrow(() => D.diagnose(F({ needle: '', allLines: buf, scope: noScope, hints: {} })));
});

// -- rule 10: subject + fuzzyAdvice (added 2026-09-21 for delete Mode 4) -----------------
// delete Mode 4 (startContent/endContent) reuses this diagnosis but must (a) name its OWN
// input instead of str_replace's 'old_str', and (b) NOT recommend fuzzyWhitespace:true, which
// its matchContentEngine calls do not honour (they pass only {occurrence, autoRescue:false}).
// Defaults must stay byte-identical -- rules 1-9 above are the proof.
const allMsgs = (r) => r.messages.join('\n');
const alphaScope = { hasScope: true, diagStart: 0, diagEnd: null, scanStart: 0, scanEnd: 3, label: ' (inFunction "alpha")' };

t('subject: the default wording is still old_str', () => {
  const r = D.diagnose(F({ needle: 'zzz_absent_zzz();', allLines: buf, scope: noScope, hints: {} }));
  assert.ok(allMsgs(r).includes('old_str does not appear anywhere in the file.'));
  assert.ok(r.messagesPre[0].includes('No match found for old_str'));
});
t('subject: a custom subject replaces old_str in the whitespace and found-at messages', () => {
  const r = D.diagnose(F({ needle: 'const total = 1;', allLines: buf, scope: noScope, hints: {}, subject: 'startContent' }));
  assert.ok(!/old_str/.test(allMsgs(r)), allMsgs(r));
  assert.ok(allMsgs(r).includes('Fix indentation in startContent to match the buffer exactly'));
  assert.ok(allMsgs(r).includes('startContent found at L2'));
  assert.ok(allMsgs(r).includes('rebuild startContent from current buffer content'));
});
t('subject: a custom subject replaces old_str in the not-found-anywhere block', () => {
  const r = D.diagnose(F({ needle: 'zzz_absent_zzz();', allLines: buf, scope: noScope, hints: {}, subject: 'endContent' }));
  assert.ok(!/old_str/.test(allMsgs(r)), allMsgs(r));
  assert.ok(allMsgs(r).includes('endContent does not appear anywhere in the file.'));
  assert.ok(allMsgs(r).includes('Both the hint and the endContent content should be verified.'));
});
t('subject: a custom subject replaces old_str in the outside-scope and inside-scope blocks', () => {
  const out = D.diagnose(F({ needle: 'const count = 2;', allLines: buf, scope: alphaScope, hints: { inFunction: 'alpha' }, subject: 'endContent' }));
  assert.ok(!/old_str/.test(allMsgs(out)), allMsgs(out));
  assert.ok(allMsgs(out).includes('endContent exists in the file but NOT inside'));
  const inside = { hasScope: true, diagStart: 5, diagEnd: 9, scanStart: 5, scanEnd: 8, label: '' };
  const inn = D.diagnose(F({ needle: 'const count = 2;', allLines: buf, scope: inside, hints: { inFunction: 'beta' }, subject: 'endContent' }));
  assert.ok(!/old_str/.test(allMsgs(inn)), allMsgs(inn));
  assert.ok(allMsgs(inn).includes('rebuild endContent from the current buffer, then retry.'));
});
t('subject: the moderate and low similarity tiers use the subject', () => {
  const m = D.similarityTier(60, 'anchor');
  assert.ok(m.hint.includes('anchor may be stale') && m.hint.includes('rebuild anchor from current buffer content'), m.hint);
  assert.ok(!/old_str/.test(m.hint));
  const l = D.similarityTier(10, 'anchor');
  assert.ok(l.hint.includes('anchor may be pointing at the wrong location entirely'), l.hint);
  assert.ok(!/old_str/.test(l.hint));
});
t('subject: the "No match found for" header uses the subject', () => {
  const r = D.diagnose(F({ needle: 'zzz_absent_zzz();', allLines: buf, scope: noScope, hints: {}, subject: 'startContent' }));
  assert.ok(r.messagesPre[0].includes('No match found for startContent'), r.messagesPre[0]);
});
t('fuzzyAdvice:false drops EVERY fuzzyWhitespace recommendation', () => {
  // A whitespace-only failure hits both the whitespace block and the "close" similarity tier.
  const r = D.diagnose(F({ needle: 'const total = 1;', allLines: buf, scope: noScope, hints: {}, fuzzyAdvice: false }));
  assert.strictEqual(r.similarityTier, 'close');
  assert.ok(!/fuzzyWhitespace/.test(allMsgs(r)), allMsgs(r));
  assert.ok(allMsgs(r).includes('Fix indentation in old_str to match the buffer exactly.'), allMsgs(r));
  assert.ok(allMsgs(r).includes('likely whitespace/indentation drift. Re-read that region.'), allMsgs(r));
});
t('fuzzyAdvice: undefined and true both keep the fuzzyWhitespace recommendation', () => {
  for (const fa of [undefined, true]) {
    const r = D.diagnose(F({ needle: 'const total = 1;', allLines: buf, scope: noScope, hints: {}, fuzzyAdvice: fa }));
    assert.ok(allMsgs(r).includes('OR retry with fuzzyWhitespace:true to commit using buffer indentation.'), 'fuzzyAdvice=' + fa);
    assert.ok(allMsgs(r).includes('Try fuzzyWhitespace:true or re-read that region.'), 'fuzzyAdvice=' + fa);
  }
});
t('subject and fuzzyAdvice change the WORDING only, never the classification or the counts', () => {
  for (const needle of ['const total = 1;', 'function alpha() {\n  const total = 1;\n  return WRONG;', 'zzz_absent_zzz();']) {
    const a = D.diagnose(F({ needle, allLines: buf, scope: noScope, hints: {} }));
    const b = D.diagnose(F({ needle, allLines: buf, scope: noScope, hints: {}, subject: 'startContent', fuzzyAdvice: false }));
    for (const k of ['reason', 'wsIssues', 'hasEncodingIssue', 'partialMatchLines', 'needleLineCount', 'closestRow', 'similarity', 'similarityTier', 'foundOutsideScope']) {
      assert.deepStrictEqual(b[k], a[k], k + ' changed for needle ' + JSON.stringify(needle));
    }
  }
});

// -- rule 11: exact text OUTSIDE the scope (2026-09-21, PJ: "fix the wider wording") ----------
// Found live: an endContent that existed EXACTLY, only before the start anchor, was reported as
// "Similarity: 100% -- Content is close -- likely whitespace/indentation drift". Wrong: nothing drifted,
// the caller searched the wrong place. The line must say so. It is keyed on the SCAN (exact hits outside
// the scope, none inside), NOT on the percentage, because calculateSimilarity() rounds: a 250-char needle
// with ONE wrong character also scores 100% -- and there, with no whitespace difference, the message must NOT
// claim drift either (rule 12), it says "close but not identical".
// 2026-09-21 (PJ: "hide it in case"): in the exact-outside-scope case the percentage is HIDDEN from the line
// (it describes the closest text INSIDE the window, which reads as a contradiction beside "exists exactly").
// simLine finds either form of the line; r.similarity stays on the result object.
const simLine = (r) => r.messagesPre.find(m => /Similarity:|text itself exists exactly/.test(m)) || '';
const dupBuf = buf.concat(['', 'function gamma() {', '  const total = 1;', '}']); // const total = 1; at L2 AND L12
const alphaOnly = { hasScope: true, diagStart: 0, diagEnd: null, scanStart: 0, scanEnd: 3, label: ' (inFunction "alpha")' };

t('exact-outside-scope: the line says the text exists exactly and the problem is WHERE', () => {
  const r = D.diagnose(F({ needle: 'const count = 2;', allLines: buf, scope: alphaOnly, hints: { inFunction: 'alpha' } }));
  assert.strictEqual(r.exactOutsideScope, true);
  assert.ok(simLine(r).includes('The text itself exists exactly (see FOUND OUTSIDE SCOPE below), so the problem is WHERE it is being searched, not the text.'), simLine(r));
  assert.ok(!/stale|drift|fuzzyWhitespace|wrong location/.test(simLine(r)), simLine(r));
});
t('exact-outside-scope: the percentage is HIDDEN from the message but still returned on the result', () => {
  const r = D.diagnose(F({ needle: 'const count = 2;', allLines: buf, scope: alphaOnly, hints: { inFunction: 'alpha' } }));
  assert.ok(!simLine(r).includes('%') && !simLine(r).includes('Similarity:'), simLine(r));
  assert.ok(!r.messages.join('\n').includes('Similarity:'), 'no Similarity line anywhere in the message');
  assert.strictEqual(typeof r.similarity, 'number');
  assert.ok(['close', 'moderate', 'low'].includes(r.similarityTier));
});
t('exact-outside-scope: exact text INSIDE the scope keeps the ordinary tier wording', () => {
  const inside = { hasScope: true, diagStart: 5, diagEnd: 9, scanStart: 5, scanEnd: 8, label: '' };
  const r = D.diagnose(F({ needle: 'const count = 2;', allLines: buf, scope: inside, hints: { inFunction: 'beta' } }));
  assert.strictEqual(r.exactOutsideScope, false);
  assert.ok(!simLine(r).includes('exists exactly'), simLine(r));
});
t('exact-outside-scope: hits BOTH inside and outside the scope keep the ordinary wording', () => {
  const r = D.diagnose(F({ needle: 'const total = 1;', allLines: dupBuf, scope: alphaOnly, hints: { inFunction: 'alpha' } }));
  assert.ok(r.scanResult.hitsInsideScope.length > 0 && r.scanResult.hitsOutsideScope.length > 0, 'precondition: hits on both sides');
  assert.strictEqual(r.exactOutsideScope, false);
  assert.ok(!simLine(r).includes('exists exactly'), simLine(r));
});
t('exact-outside-scope: with NO scope nothing is "outside", so the ordinary wording is kept', () => {
  const r = D.diagnose(F({ needle: 'const count = 2;', allLines: buf, scope: noScope, hints: {} }));
  assert.strictEqual(r.exactOutsideScope, false);
  assert.ok(!simLine(r).includes('exists exactly'), simLine(r));
});
t('exact-outside-scope: text that exists nowhere keeps the ordinary wording', () => {
  const r = D.diagnose(F({ needle: 'zzz_absent_zzz();', allLines: buf, scope: alphaOnly, hints: { inFunction: 'alpha' } }));
  assert.strictEqual(r.exactOutsideScope, false);
  assert.ok(simLine(r).includes('Low match'), simLine(r));
});
t('exact-outside-scope: a 100% similarity that is NOT exact is not called exact, and (no whitespace issue) not called drift either', () => {
  const b2 = ['x'.repeat(249) + 'B', 'other line'];
  const r = D.diagnose(F({ needle: 'x'.repeat(249) + 'A', allLines: b2, scope: noScope, hints: {} }));
  assert.strictEqual(r.similarity, 100, 'precondition: this pair must round to 100, got ' + r.similarity);
  assert.strictEqual(r.wsIssues.length, 0, 'precondition: no whitespace mismatch');
  assert.strictEqual(r.exactOutsideScope, false);
  assert.ok(!simLine(r).includes('exists exactly'), simLine(r));
  assert.ok(simLine(r).includes('Content is close but not identical'), simLine(r));
  assert.ok(!/drift/.test(simLine(r)), simLine(r));
});
t('exact-outside-scope: only the similarity WORDING changes; classification and counts do not', () => {
  const a = D.diagnose(F({ needle: 'const count = 2;', allLines: buf, scope: alphaOnly, hints: { inFunction: 'alpha' } }));
  assert.strictEqual(a.reason, 'whitespace');
  assert.strictEqual(a.foundOutsideScope, true);
  assert.strictEqual(a.similarityTier, D.similarityTier(a.similarity).tier);
});

// -- rule 12: the "whitespace/indentation drift" claim needs a real whitespace mismatch ----------------
// (2026-09-21, PJ: "only when a white space mis match is found".) Found live: 'const totl = 1;' (a typo) scored
// 83% and the message said "likely whitespace/indentation drift" although no whitespace difference existed.
t('drift claim: a real whitespace mismatch still says likely whitespace/indentation drift', () => {
  const r = D.diagnose(F({ needle: 'const total = 1;', allLines: buf, scope: noScope, hints: {} }));
  assert.ok(r.wsIssues.length > 0, 'precondition: a whitespace mismatch was found');
  assert.strictEqual(r.similarityTier, 'close', 'precondition: close tier');
  assert.ok(simLine(r).includes('likely whitespace/indentation drift'), simLine(r));
});
t('drift claim: a plain TYPO in the close tier does NOT claim drift', () => {
  const r = D.diagnose(F({ needle: 'const totl = 1;', allLines: buf, scope: noScope, hints: {} }));
  assert.strictEqual(r.wsIssues.length, 0, 'precondition: no whitespace mismatch');
  assert.strictEqual(r.similarityTier, 'close', 'precondition: this typo must score in the close tier, got ' + r.similarity + '%');
  assert.ok(simLine(r).includes('Content is close but not identical'), simLine(r));
  assert.ok(simLine(r).includes('a typo, a wrong character, or an invisible/Unicode difference'), simLine(r));
  assert.ok(!/drift|fuzzyWhitespace|indentation/.test(simLine(r)), simLine(r));
});
t('drift claim: the neutral wording is the same with fuzzy advice on or off', () => {
  for (const fa of [undefined, true, false]) {
    const r = D.diagnose(F({ needle: 'const totl = 1;', allLines: buf, scope: noScope, hints: {}, fuzzyAdvice: fa }));
    assert.ok(simLine(r).includes('Content is close but not identical'), 'fuzzyAdvice=' + fa + ' ' + simLine(r));
    assert.ok(!/fuzzyWhitespace/.test(simLine(r)), 'fuzzyAdvice=' + fa);
  }
});
t('drift claim: only the WORDING changes -- the typo is still classified noMatch with the same counts', () => {
  const r = D.diagnose(F({ needle: 'const totl = 1;', allLines: buf, scope: noScope, hints: {} }));
  assert.strictEqual(r.reason, 'noMatch');
  assert.strictEqual(r.partialMatchLines, 0);
  assert.strictEqual(typeof r.similarity, 'number');
});
t('drift claim: similarityTier() is unchanged for a caller that does not pass wsFound', () => {
  assert.ok(D.similarityTier(90).hint.includes('likely whitespace/indentation drift'));
  assert.ok(D.similarityTier(90, undefined, undefined, undefined).hint.includes('likely whitespace/indentation drift'));
  assert.ok(D.similarityTier(90, undefined, undefined, true).hint.includes('likely whitespace/indentation drift'));
  assert.ok(D.similarityTier(90, undefined, undefined, false).hint.includes('Content is close but not identical'));
});
t('drift claim: the moderate and low tiers are the same whether or not a whitespace mismatch was found', () => {
  for (const pct of [60, 10]) {
    assert.strictEqual(D.similarityTier(pct, 'x', undefined, true).hint, D.similarityTier(pct, 'x', undefined, false).hint, 'pct ' + pct);
  }
});

// =============================================================================
// QUIRKS -- deliberately PRESERVED. Each fixture documents behaviour that is
// arguably wrong. If you FIX one later, this test must be edited on purpose.
// =============================================================================

// QUIRK 1: hasEncodingIssue looks unreachable. This is a HYPOTHESIS from reading the
// code; the fixtures below try to falsify it. If any of them yields reason 'encoding'
// the hypothesis is WRONG and the counter matters after all.
t('QUIRK 1: smart-quote drift is NOT classified encoding (trims differ, so no wsIssue)', () => {
  const b = ['  const s = \u201Chello\u201D;'];
  const r = D.diagnose(F({ needle: '  const s = "hello";', allLines: b, scope: noScope, hints: {} }));
  assert.strictEqual(r.hasEncodingIssue, false);
  assert.notStrictEqual(r.reason, 'encoding');
});
t('QUIRK 1: NBSP-for-space drift is NOT classified encoding either', () => {
  const b = ['  return\u00A0value;'];
  const r = D.diagnose(F({ needle: '  return value;', allLines: b, scope: noScope, hints: {} }));
  assert.strictEqual(r.hasEncodingIssue, false);
  assert.notStrictEqual(r.reason, 'encoding');
});
t('QUIRK 1: inner-whitespace drift is whitespace, never encoding', () => {
  const b = ['  a   b'];
  const r = D.diagnose(F({ needle: '  a b', allLines: b, scope: noScope, hints: {} }));
  assert.strictEqual(r.hasEncodingIssue, false);
});
t('QUIRK 1: brute force -- no generated pair reaches hasEncodingIssue', () => {
  // Pairs that share .trim() but differ in raw text (the ONLY way a wsIssue is created),
  // with non-ASCII characters placed everywhere a difference could hide.
  const bits = ['\u00E9', '\u201C', '\u00A0', '\u200B', '\uFEFF', 'x', ' ', '\t'];
  let reached = 0, tried = 0;
  for (const core of ['a' + bits[0] + 'b', 'a' + bits[1] + 'b', 'foo(' + bits[2] + ')']) {
    for (const pad1 of ['', ' ', '  ', '\t']) {
      for (const pad2 of ['', ' ', '  ', '\t']) {
        if (pad1 === pad2) continue;
        tried++;
        const r = D.wsScan([pad1 + core], [pad2 + core], 0);
        if (r.hasEncodingIssue) reached++;
      }
    }
  }
  assert.ok(tried > 0);
  assert.strictEqual(reached, 0, reached + ' of ' + tried + ' pairs reached hasEncodingIssue -- QUIRK 1 hypothesis is FALSE');
});

// QUIRK 2: diagnosis window is whatever the CALLER passes. str_replace narrows it only for
// inFunction/betweenHint. Pinned here as "the module trusts scope.diagStart/diagEnd".
t('QUIRK 2: the module diagnoses exactly the window it is handed', () => {
  const narrow = { hasScope: true, diagStart: 0, diagEnd: 4, scanStart: 0, scanEnd: 3, label: '' };
  const wide   = { hasScope: true, diagStart: 0, diagEnd: null, scanStart: 0, scanEnd: 3, label: '' };
  // 'const count = 2;' has different indentation in beta() at row 6 -- outside the narrow window.
  const rn = D.diagnose(F({ needle: 'const count = 2;', allLines: buf, scope: narrow, hints: {} }));
  const rw = D.diagnose(F({ needle: 'const count = 2;', allLines: buf, scope: wide,   hints: {} }));
  assert.strictEqual(rn.wsIssues.length, 0);
  assert.strictEqual(rw.wsIssues.length, 1);
});

// QUIRK 5: the stat bump is NOT made here; it is returned as a flag.
t('QUIRK 5: foundOutsideScope is a RETURNED flag, the module bumps nothing', () => {
  const scope = { hasScope: true, diagStart: 0, diagEnd: null, scanStart: 0, scanEnd: 3, label: '' };
  const r = D.diagnose(F({ needle: 'const count = 2;', allLines: buf, scope, hints: { inFunction: 'alpha' } }));
  assert.strictEqual(r.foundOutsideScope, true);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fail-diagnostics.js'), 'utf8');
  assert.ok(!/require\(['"]\.\/edit-stats['"]\)/.test(src), 'fail-diagnostics.js must not require edit-stats');
  assert.ok(!/\bbump\s*\(/.test(src.replace(/\/\/.*$/gm, '')), 'fail-diagnostics.js must not call bump()');
});

// QUIRK 6: raw counts are returned so callers cannot drift on the classification.
t('QUIRK 6: a partial match covering EVERY needle line is reason partialMatch here, but NOT "partialMatch < lines" for stats', () => {
  // Needle equals the buffer's first two lines exactly, so partialMatchLines === lines.length.
  const needle = 'function alpha() {\n  const total = 1;';
  const r = D.diagnose(F({ needle, allLines: buf, scope: noScope, hints: {} }));
  assert.strictEqual(r.partialMatchLines, r.needleLineCount);
  // The message block is suppressed (the source requires partialMatchLines < lines.length) ...
  assert.ok(!r.messages.join('\n').includes('PARTIAL MATCH'));
  // ... but the finer reason still says partialMatch, because it tests only > 0 (L1244).
  assert.strictEqual(r.reason, 'partialMatch');
});

// QUIRK 7: the finer reason is returned; the caller maps it down.
t('QUIRK 7: the module returns the FINER reason, not the stats reason', () => {
  const r = D.diagnose(F({ needle: 'zzz_absent_zzz();', allLines: buf, scope: noScope, hints: { afterLine: 2 } }));
  assert.ok(r.reason.startsWith('hintFault:'));
});

// =============================================================================
// NEGATIVE CONTROL -- repeatable. Copies the module into a temp dir, breaks ONE
// rule in the copy, runs the same probe, and requires the copy to give a
// DIFFERENT answer. A test that cannot fail proves nothing.
// =============================================================================
function negControl(label, breakFn, probe) {
  t('negative control: ' + label, () => {
    const os  = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's4_negctl_'));
    try {
      const libDir = path.join(__dirname, '..', 'lib');
      const tmpLib = path.join(tmp, 'lib');
      fs.mkdirSync(tmpLib);
      for (const f of ['fail-diagnostics.js', 'string-utils.js', 'tool-hints.js']) {
        fs.copyFileSync(path.join(libDir, f), path.join(tmpLib, f));
      }
      const target = path.join(tmpLib, 'fail-diagnostics.js');
      const original = fs.readFileSync(target, 'utf8');
      const broken = breakFn(original);
      assert.notStrictEqual(broken, original, 'the break did not change the copy -- the control is vacuous');
      fs.writeFileSync(target, broken);
      const good = probe(D);
      const bad  = probe(require(target));
      assert.notDeepStrictEqual(bad, good, 'the broken copy gave the SAME answer -- this test cannot detect that rule');
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    }
  });
}
negControl('breaking the >=80 tier boundary is detected',
  s => s.replace('simPct >= 80', 'simPct >= 101'),
  M => M.similarityTier(90).tier);
negControl('breaking the whitespace classification is detected',
  s => s.replace('bl.trim() === trimmed && bl !== lines[li]', 'bl.trim() === trimmed && bl === lines[li]'),
  M => M.diagnose({ needle: 'const total = 1;', allLines: buf, scope: noScope, hints: {}, hintRadius: 25 }).reason);
negControl('dropping the foundOutsideScope flag is detected',
  s => s.replace('foundOutsideScope = true;', 'foundOutsideScope = false;'),
  M => M.diagnose({ needle: 'const count = 2;', allLines: buf, scope: { hasScope: true, diagStart: 0, diagEnd: null, scanStart: 0, scanEnd: 3, label: '' }, hints: { inFunction: 'alpha' }, hintRadius: 25 }).foundOutsideScope);
negControl('breaking the finer afterLine reason is detected',
  s => s.replace("'hintFault:afterLine:contentMiss'", "'noMatch'"),
  M => M.diagnose({ needle: 'zzz_absent_zzz();', allLines: buf, scope: noScope, hints: { afterLine: 2 }, hintRadius: 25 }).reason);
negControl('breaking a message string is detected',
  s => s.split('NOT FOUND ANYWHERE').join('NOT FOUND SOMEWHERE'),
  M => M.diagnose({ needle: 'zzz_absent_zzz();', allLines: buf, scope: noScope, hints: {}, hintRadius: 25 }).messagesPost);
// 2026-09-21: controls for subject / fuzzyAdvice. They use split/join, which replaces EVERY
// occurrence (the subject default appears in both similarityTier and diagnose), never String.replace,
// which would only hit the first and could let a copy in a comment make a control vacuous.
negControl('ignoring the subject is detected',
  s => s.split("const S = subject || 'old_str';").join("const S = 'old_str';"),
  M => M.diagnose({ needle: 'zzz_absent_zzz();', allLines: buf, scope: noScope, hints: {}, hintRadius: 25, subject: 'startContent' }).messages);
negControl('ignoring fuzzyAdvice:false in diagnose() is detected',
  s => s.split('const fuzzy = fuzzyAdvice !== false;').join('const fuzzy = true;'),
  M => M.diagnose({ needle: 'const total = 1;', allLines: buf, scope: noScope, hints: {}, hintRadius: 25, fuzzyAdvice: false }).messages);
negControl('ignoring fuzzyAdvice:false in similarityTier() is detected',
  s => s.split('fuzzyAdvice === false ?').join('false ?'),
  M => M.similarityTier(90, undefined, false).hint);
// 2026-09-21 (exact-outside-scope wording). Each token below must appear EXACTLY once in the module or the
// control is vacuous -- the assertion inside negControl() ("the break did not change the copy") enforces it.
negControl('dropping the exact-outside-scope wording entirely is detected',
  s => s.split('const _exactOnlyOutside = hasScope &&').join('const _exactOnlyOutside = false && hasScope &&'),
  M => M.diagnose({ needle: 'const count = 2;', allLines: buf, scope: alphaOnly, hints: { inFunction: 'alpha' }, hintRadius: 25 }).messagesPre);
negControl('ignoring hits INSIDE the scope (only checking outside) is detected',
  s => s.split('&& _fullScan.hitsInsideScope.length === 0;').join(';'),
  M => M.diagnose({ needle: 'const total = 1;', allLines: dupBuf, scope: alphaOnly, hints: { inFunction: 'alpha' }, hintRadius: 25 }).exactOutsideScope);
// 2026-09-21 (rule 12 + hidden percentage). Tokens below appear exactly once in the module (the assertion inside
// negControl() -- "the break did not change the copy" -- enforces it); split/join, never String.replace.
negControl('dropping the wsFound check in similarityTier() (drift claimed for a typo) is detected',
  s => s.split('wsFound === false').join('false'),
  M => M.diagnose({ needle: 'const totl = 1;', allLines: buf, scope: noScope, hints: {}, hintRadius: 25 }).messagesPre);
negControl('not passing wsFound from diagnose() is detected',
  s => s.split('fuzzy ? undefined : false, wsIssues.length > 0').join('fuzzy ? undefined : false'),
  M => M.diagnose({ needle: 'const totl = 1;', allLines: buf, scope: noScope, hints: {}, hintRadius: 25 }).messagesPre);
negControl('showing the percentage in the exact-outside-scope line again is detected',
  s => s.split('The text itself exists exactly (see').join('Similarity: ${simPct}% The text itself exists exactly (see'),
  M => M.diagnose({ needle: 'const count = 2;', allLines: buf, scope: alphaOnly, hints: { inFunction: 'alpha' }, hintRadius: 25 }).messagesPre);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
