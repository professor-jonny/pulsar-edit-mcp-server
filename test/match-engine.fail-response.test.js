'use strict';
// Engine wiring test (2026-09-21) -- drives match-engine.buildFailResponse / resolveScope
// directly in plain Node, so the wiring is proven BEFORE a Pulsar restart.
// Run from the package root:   node test/match-engine.fail-response.test.js
// Scope: it exercises the engine wiring only (message content, hint plumbing,
// untouched branches). The bump() tally is checked in a separate file because bump() needs a
// live STATS_PATH-less session store.

const eng = require('../lib/match-engine');

const buf = [
  'function alpha() {',   // L1
  '  const total = 1;',   // L2
  '  return total;',      // L3
  '}',                    // L4
  '',                     // L5
  'function beta() {',    // L6
  '  const count = 2;',   // L7
  '  return count;',      // L8
  '}',                    // L9
];
const mk   = () => ({ consec: { count: 1 }, allLines: buf, text: buf.join('\n') });
const miss = { matched: false, reason: 'notFound' };
const sc   = (o) => Object.assign({ searchStart: 0, searchEnd: buf.length - 1, scopeLabel: '', _hasScope: false, via: 'none', hints: {} }, o);
const txt  = (r) => r.content[0].text;

let bad = 0;
function chk(label, r, needle, want) {
  const ok = txt(r).includes(needle) === want;
  if (!ok) bad++;
  console.log((ok ? 'ok   ' : 'FAIL ') + label);
  if (!ok) console.log('      wanted ' + (want ? 'to contain' : 'NOT to contain') + ': ' + JSON.stringify(needle));
}
function chkTrue(label, cond, detail) {
  if (!cond) bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label + (detail ? '   ' + detail : ''));
}

// A. not found anywhere
let r = eng.buildFailResponse({ tool: 'insert', ctx: mk(), scope: sc(), match: miss, needle: 'zzz_absent();', isCodeFile: true });
chk('A not-found-anywhere message',  r, 'NOT FOUND ANYWHERE', true);
chk('A header names the tool',       r, '\u274C insert: content not found.', true);
chk('A str_replace header dropped',  r, 'No match found for old_str', false);

// B. found outside the real scope
r = eng.buildFailResponse({
  tool: 'delete', ctx: mk(), match: miss, needle: 'const count = 2;', isCodeFile: true,
  scope: sc({ searchStart: 0, searchEnd: 3, scopeLabel: ' within function "alpha"', _hasScope: true, via: 'inFunction', hints: { inFunction: 'alpha' } }),
});
chk('B FOUND OUTSIDE SCOPE',         r, 'FOUND OUTSIDE SCOPE', true);
chk('B hint label from scope.hints', r, 'inFunction:"alpha"', true);
chk('B engine scope label shown',    r, 'content not found within function "alpha".', true);

// C. afterLine drift nudge carries the real line number from scope.hints
r = eng.buildFailResponse({
  tool: 'delete', ctx: mk(), match: miss, needle: 'zzz_absent();', isCodeFile: true,
  scope: sc({ _hasScope: true, via: 'afterLine', hints: { afterLine: 2 } }),
});
chk('C drift nudge line number',     r, 'afterLine:2 window (', true);
chk('C drift-immune alternative',    r, "use afterString:'const total = 1;'", true);

// D. partial match
r = eng.buildFailResponse({
  tool: 'replace-block', ctx: mk(), scope: sc(), match: miss, isCodeFile: true,
  needle: 'function alpha() {\n  const total = 1;\n  return WRONG;',
});
chk('D PARTIAL MATCH',               r, 'PARTIAL MATCH: first 2 of 3', true);

// E. branches that must be UNCHANGED
r = eng.buildFailResponse({
  tool: 'delete', ctx: mk(), scope: sc(), needle: 'x', isCodeFile: true,
  match: { matched: false, reason: 'occurrenceOutOfRange', occurrence: 5, totalMatches: 2, matchLines: [1, 2] },
});
chk('E occurrenceOutOfRange unchanged', r, 'occurrence:5 requested but only 2 matches', true);
chk('E ...and no diagnosis appended',   r, 'Similarity:', false);
r = eng.buildFailResponse({ tool: 'delete', ctx: mk(), scope: { error: { kind: 'anchorError', message: 'MSG-VERBATIM' } }, needle: 'x', isCodeFile: true });
chk('E scope-error branch unchanged',   r, 'MSG-VERBATIM', true);
r = eng.buildFailResponse({ tool: 'delete', ctx: mk(), scope: sc(), needle: null, isCodeFile: true });
chk('E no-match fallthrough unchanged', r, 'unknown match-engine failure', true);

// F. resolveScope wrapper
const base = { editor: null, buffer: null, allLines: buf, text: buf.join('\n'), filePath: 'x.c' };
const out = eng.resolveScope(Object.assign({}, base, { params: { afterLine: 0, occurrence: 1 } }));
chkTrue('F wrapper keeps a falsy afterLine:0', !!(out.hints && out.hints.afterLine === 0), 'hints=' + JSON.stringify(out.hints));
const errOut = eng.resolveScope(Object.assign({}, base, { params: { banner: 'nope' } }));
chkTrue('F error results returned untouched (no hints)', !!(errOut.error && !errOut.hints));
const plain = eng.resolveScope(Object.assign({}, base, { params: {} }));
chkTrue('F no-hint call gives empty hints', !!(plain.hints && Object.keys(plain.hints).length === 0));
const withStr = eng.resolveScope(Object.assign({}, base, { params: { afterString: 'function beta', occurrence: 1 } }));
chkTrue('F afterString reaches scope.hints', !!(withStr.hints && withStr.hints.afterString === 'function beta'), 'hints=' + JSON.stringify(withStr.hints));

// G. Window + scope alignment with str_replace. Both were wiring errors in the first cut,
//    FOUND LIVE 2026-09-21 by running the same failing call through insert and str_replace.
//    Control values below are the LIVE str_replace output for the same scoped miss.
const EMD = '\u2014';
const inFn = sc({ searchStart: 0, searchEnd: 3, scopeLabel: ' within function "alpha"', _hasScope: true, via: 'inFunction', hints: { inFunction: 'alpha' } });
r = eng.buildFailResponse({ tool: 'insert', ctx: mk(), match: miss, needle: 'const count = 2;', isCodeFile: true, scope: inFn });
chk('G1 inFunction: indentation hit at L7 is NOT seen (outside the window)', r, 'WHITESPACE MISMATCH', false);
chk('G1 inFunction: closest area equals the str_replace control',            r, 'Closest area found (lines 1' + EMD + '6)', true);
// 2026-09-21: the exact text sits OUTSIDE the scope here, so the percentage is HIDDEN (PJ: "hide it in case") and the line says
// so instead. The 61% parity with the live str_replace control no longer applies to this line: str_replace still prints it
// until S4e. The closest-area parity above is unaffected.
chk('G1 inFunction: the exact-outside-scope line replaces the percentage',   r, 'The text itself exists exactly (see FOUND OUTSIDE SCOPE below)', true);
chk('G1 inFunction: no Similarity percentage is printed (hidden)',            r, 'Similarity:', false);
chk('G1 inFunction: still reports FOUND OUTSIDE SCOPE',                      r, 'FOUND OUTSIDE SCOPE', true);

const btw = sc({ searchStart: 0, searchEnd: 3, scopeLabel: ' between anchors', _hasScope: true, via: 'betweenHint', hints: { betweenHint: { start: 'function alpha', end: '}' } } });
r = eng.buildFailResponse({ tool: 'insert', ctx: mk(), match: miss, needle: 'const count = 2;', isCodeFile: true, scope: btw });
chk('G2 betweenHint narrows the window too',                                 r, 'WHITESPACE MISMATCH', false);

const aft = sc({ searchStart: 1, searchEnd: 8, scopeLabel: '', _hasScope: true, via: 'afterString', hints: { afterString: 'function alpha' } });
r = eng.buildFailResponse({ tool: 'insert', ctx: mk(), match: miss, needle: 'const count = 2;', isCodeFile: true, scope: aft });
chk('G3 afterString does NOT narrow (whole file, as str_replace)',           r, 'WHITESPACE MISMATCH on 1 line(s)', true);

const occ1 = sc({ _hasScope: true, via: 'none', hints: { occurrence: 1 } });
r = eng.buildFailResponse({ tool: 'delete', ctx: mk(), match: miss, needle: 'const count = 2;', isCodeFile: true, scope: occ1 });
chk('G4 occurrence:1 alone is NOT a scope: merged "old_str found at" line',  r, 'old_str found at L7', true);
chk('G4 occurrence:1 alone: no "inside scope" wording',                      r, 'MATCH LOCATION FOUND inside scope', false);
chk('G4 occurrence:1 alone: NO HINTS USED nudge is shown',                   r, 'NO HINTS USED', true);

const occ2 = sc({ _hasScope: true, via: 'none', hints: { occurrence: 2 } });
r = eng.buildFailResponse({ tool: 'delete', ctx: mk(), match: miss, needle: 'const count = 2;', isCodeFile: true, scope: occ2 });
chk('G5 occurrence:2 IS a scope: "inside scope" wording',                    r, 'MATCH LOCATION FOUND inside scope at L7', true);
chk('G5 occurrence:2: NO HINTS USED nudge is not shown',                     r, 'NO HINTS USED', false);

const wr = eng.resolveScope(Object.assign({}, base, { params: { occurrence: 3 } }));
chkTrue('G6 wrapper carries occurrence onto scope.hints', !!(wr.hints && wr.hints.occurrence === 3), 'hints=' + JSON.stringify(wr.hints));

// H. diagnoseFailure() -- the shared half, and the two delete Mode 4 call shapes (2026-09-21).
//    The delete handler needs a live editor, so this reproduces the EXACT diagnoseFailure() calls
//    the startContent / endContent branches make (scope from resolveScope with afterRow, as they do).
//    Wrapped in a block so its names (out, d, before, ...) can never collide with sections A-G above.
{
const dctx = () => ({ consec: { count: 1 }, allLines: buf, text: buf.join('\n') });
const joinAll = (d) => d.pre.concat(d.post).join('\n');

// H1. default call: header-less pre (str_replace's own '? No match found' header is dropped), old_str wording.
let d = eng.diagnoseFailure({ tool: 'insert', ctx: dctx(), scope: sc(), needle: 'zzz_absent();' });
chkTrue('H1 pre has no str_replace header', !d.pre.join('\n').includes('No match found for'));
chkTrue('H1 default wording is old_str', joinAll(d).includes('old_str does not appear anywhere in the file.'));
chkTrue('H1 returns the stat key that was bumped', d.statKey === 'noMatch', 'statKey=' + d.statKey);
chkTrue('H1 returns hasScope=false for an unscoped call', d.hasScope === false);

// H2. buildFailResponse's default output is unchanged by the extraction: same pieces, same order.
const viaBuild = txt(eng.buildFailResponse({ tool: 'insert', ctx: mk(), scope: sc(), match: miss, needle: 'const total = 1;', isCodeFile: true }));
chkTrue('H2 buildFailResponse still leads with the engine header', viaBuild.startsWith('\u274C insert: content not found.'));
chkTrue('H2 buildFailResponse still has the diagnosis body', viaBuild.includes('WHITESPACE MISMATCH on 1 line(s)') && viaBuild.includes('Similarity:'));
chkTrue('H2 buildFailResponse still ends with no retry line for insert (no retry field)', !viaBuild.includes('Retry cheaply'));

// H3. Mode 4 startContent shape: resolveScope(afterRow: 0), subject 'startContent', no fuzzy advice.
const startScope = eng.resolveScope(Object.assign({}, base, { params: { afterRow: 0 } }));
d = eng.diagnoseFailure({ tool: 'delete', ctx: dctx(), scope: startScope, needle: 'const total = 1;', subject: 'startContent', fuzzyAdvice: false });
let out = joinAll(d);
chkTrue('H3 startContent: names its own input, never old_str', out.includes('startContent') && !/old_str/.test(out), out.slice(0, 200));
chkTrue('H3 startContent: recommends NO fuzzyWhitespace (Mode 4 does not honour it)', !/fuzzyWhitespace/.test(out));
chkTrue('H3 startContent: still shows the whitespace diagnosis', out.includes('WHITESPACE MISMATCH on 1 line(s)'));
chkTrue('H3 startContent: afterRow scope reports the match as inside scope', out.includes('MATCH LOCATION FOUND inside scope at L2'), '');
chkTrue('H3 startContent: stat key is whitespace', d.statKey === 'whitespace', 'statKey=' + d.statKey);

// H4. Mode 4 endContent shape: resolveScope(afterRow: startRow + 1) plus the shallow-copied label.
const startRow = 1; // start anchor found on row 1 (line 2); endContent is searched from row 2 on
const endScope = eng.resolveScope(Object.assign({}, base, { params: { afterRow: startRow + 1 } }));
d = eng.diagnoseFailure({ tool: 'delete', ctx: dctx(), scope: Object.assign({}, endScope, { scopeLabel: ' after startContent (line ' + (startRow + 1) + ')' }), needle: 'function alpha() {', subject: 'endContent', fuzzyAdvice: false });
out = joinAll(d);
chkTrue('H4 endContent existing only BEFORE the start anchor -> FOUND OUTSIDE SCOPE', out.includes('FOUND OUTSIDE SCOPE') && d.diag.foundOutsideScope === true);
chkTrue('H4 endContent: the hit is reported at L1', out.includes('Hit(s) outside scope: L1'));
chkTrue('H4 endContent: the label says where it searched', out.includes('NOT inside after startContent (line 2)'), '');
chkTrue('H4 endContent: names its own input, never old_str', out.includes('endContent exists in the file') && !/old_str/.test(out));
d = eng.diagnoseFailure({ tool: 'delete', ctx: dctx(), scope: endScope, needle: 'zzz_absent();', subject: 'endContent', fuzzyAdvice: false });
chkTrue('H4 endContent: absent everywhere -> NOT FOUND ANYWHERE naming endContent', joinAll(d).includes('endContent does not appear anywhere in the file.'));

// H5. the shallow copy must not mutate the resolved scope the handler keeps using afterwards.
const before = JSON.stringify(endScope);
eng.diagnoseFailure({ tool: 'delete', ctx: dctx(), scope: Object.assign({}, endScope, { scopeLabel: ' x' }), needle: 'zzz();', subject: 'endContent', fuzzyAdvice: false });
chkTrue('H5 diagnoseFailure does not mutate the scope it is given', JSON.stringify(endScope) === before);

// H6. (1) NARROWED WINDOW + (2) WORDING (PJ, 2026-09-21). FOUND LIVE: an endContent that exists EXACTLY,
//     only BEFORE the start anchor, printed "Closest area found (lines 1-5)" (above the start anchor) and
//     "Similarity: 100% -- Content is close -- likely whitespace/indentation drift". Nothing had drifted.
const eLbl = Object.assign({}, endScope, { scopeLabel: ' after startContent (line ' + (startRow + 1) + ')' });
const dB = eng.diagnoseFailure({ tool: 'delete', ctx: dctx(), scope: eLbl, needle: 'function alpha() {', subject: 'endContent', fuzzyAdvice: true });
const outB = joinAll(dB);
chkTrue('H6 narrowed: the closest row is never above the search start', dB.diag.closestRow === -1 || dB.diag.closestRow >= endScope.searchStart, 'closestRow=' + dB.diag.closestRow + ' searchStart=' + endScope.searchStart);
chkTrue('H6 wording: says the text exists exactly and the problem is WHERE it is searched', outB.includes('The text itself exists exactly (see FOUND OUTSIDE SCOPE below), so the problem is WHERE it is being searched, not the text.'));
chkTrue('H6 wording: the percentage is hidden in that case (PJ 2026-09-21)', !outB.includes('Similarity:'));
chkTrue('H6 wording: NO false drift / stale claim for text that exists exactly', !/likely whitespace\/indentation drift|may be stale|wrong location entirely/.test(outB));
chkTrue('H6 still reports FOUND OUTSIDE SCOPE at L1', outB.includes('Hit(s) outside scope: L1') && dB.diag.exactOutsideScope === true);
// In-test control: the SAME call with a scope that is NOT an afterRow scope must NOT be narrowed, so it
// diagnoses the row above the start anchor. Proves narrowing (not something else) changed the result above.
const dWide = eng.diagnoseFailure({ tool: 'delete', ctx: dctx(), scope: Object.assign({}, eLbl, { via: 'afterString' }), needle: 'function alpha() {', subject: 'endContent', fuzzyAdvice: true });
chkTrue('H6 control: without via=afterRow the window is the whole file (closest row is the L1 hit)', dWide.diag.closestRow === 0, 'closestRow=' + dWide.diag.closestRow);
// startContent (afterRow 0) starts at row 0, so narrowing must not change ITS window at all.
const dS0 = eng.diagnoseFailure({ tool: 'delete', ctx: dctx(), scope: startScope, needle: 'const total = 1;', subject: 'startContent', fuzzyAdvice: true });
chkTrue('H6 startContent with searchFrom 0 keeps the whole-file window (whitespace hit at L2)', dS0.diag.wsIssues.length === 1 && dS0.diag.wsIssues[0].bufferLine === 2);
// fuzzyAdvice is TRUE now that Mode 4 honours the flag: the recommendation must be present when unset.
chkTrue('H6 fuzzyAdvice:true (flag not set) recommends fuzzyWhitespace:true', joinAll(dS0).includes('OR retry with fuzzyWhitespace:true'));
const dS1 = eng.diagnoseFailure({ tool: 'delete', ctx: dctx(), scope: startScope, needle: 'const total = 1;', subject: 'startContent', fuzzyAdvice: false });
chkTrue('H6 fuzzyAdvice:false (flag already set) does not repeat the recommendation', !/fuzzyWhitespace/.test(joinAll(dS1)));
}

// I. delete Mode 4 fuzzyWhitespace / fuzzyContent (PJ, 2026-09-21: "add as a feature").
//    The delete handler needs a live editor, so this drives matchContent() with the EXACT call shapes
//    Mode 4 now makes: start = { fuzzyWhitespace, fuzzyContent, occurrence, autoRescue:false } on an
//    afterRow scope, end = the same with occurrence:1 on an afterRow(startRow+1) scope. Values below were
//    OBSERVED first (printed from the real engine before the assertions were written), not guessed.
{
const ctxI = { allLines: buf, text: buf.join('\n') };
const sS = eng.resolveScope(Object.assign({}, base, { params: { afterRow: 0 } }));
const eS = eng.resolveScope(Object.assign({}, base, { params: { afterRow: 2 } }));
const M = (needle, scope, opts) => eng.matchContent(needle, ctxI, scope, Object.assign({ autoRescue: false }, opts));

chkTrue('I1 DEFAULT UNCHANGED: a whitespace-only start anchor still hard-fails with no flag', M('const total = 1;', sS, {}).matched === false);
let r1 = M('const total = 1;', sS, { fuzzyWhitespace: true });
chkTrue('I2 fuzzyWhitespace:true matches the indented start anchor at L2', r1.matched === true && r1.matchLine === 1 && r1.matchEndLine === 1, JSON.stringify(r1.transforms));
chkTrue('I3 ...and reports the strategy Mode 4 prints as "(startContent matched via fuzzyWhitespace)"', Array.isArray(r1.transforms) && r1.transforms[0] === 'fuzzyWhitespace');
chkTrue('I4 fuzzyContent:true alone does NOT rescue a whitespace-only miss (it is a different transform)', M('const total = 1;', sS, { fuzzyContent: true }).matched === false);

chkTrue('I7 DEFAULT UNCHANGED: a whitespace-only END anchor still hard-fails with no flag', M('return total;', eS, { occurrence: 1 }).matched === false);
let r3 = M('return total;', eS, { fuzzyWhitespace: true, occurrence: 1 });
chkTrue('I8 fuzzyWhitespace:true matches the END anchor at L3', r3.matched === true && r3.matchLine === 2 && r3.transforms[0] === 'fuzzyWhitespace');

// SAFETY: a destructive tool must not silently pick the wrong one. Two lines that differ only in indent
// are BOTH fuzzy candidates -> ambiguous, and occurrence:N then chooses.
const dupB = ['a() {', '  x = 1;', '}', 'b() {', '    x = 1;', '}'];
const dupCtx = { allLines: dupB, text: dupB.join('\n') };
const dupScope = eng.resolveScope({ editor: null, buffer: null, allLines: dupB, text: dupB.join('\n'), filePath: 'y.c', params: { afterRow: 0 } });
const rAmb = eng.matchContent('x = 1;', dupCtx, dupScope, { fuzzyWhitespace: true, occurrence: undefined, autoRescue: false });
chkTrue('I10 SAFETY: fuzzy start anchor matching two candidates is AMBIGUOUS, never silently the first', rAmb.matched === false && rAmb.reason === 'ambiguous');
const rOcc = eng.matchContent('x = 1;', dupCtx, dupScope, { fuzzyWhitespace: true, occurrence: 2, autoRescue: false });
chkTrue('I11 SAFETY: occurrence:2 then selects the second candidate', rOcc.matched === true && rOcc.matchLine === 4);
}

console.log('\nprobe failures: ' + bad);
process.exit(bad ? 1 : 0);
