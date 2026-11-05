'use strict';
// test/match-engine.match-content-scope.test.js (2026-10-11)
// Pins lib/match-engine.js after Step 2b of the comment fail reason: matchContent has NO stage 2 any more.
// recover.partialMatchRescue used to search the WHOLE buffer and commit text found OUTSIDE the resolved
// scope (even an exact needle that lived only outside the caller's scope). Such needles are now a plain
// noMatch, and diagnoseFailure() explains them.
// Written probe-first (TEMP\probe_stage2.js and TEMP\probe_diag2.js printed the real outputs, before and after
// the change, before any assertion was written).
// Run: node test/match-engine.match-content-scope.test.js   (ME_PATH env points it at another copy of match-engine.js that
// lives next to the other lib files, used by the mutation harness). Last line is '<N> passed, <M> failed'.
const path = require('path');
const eng = require(process.env.ME_PATH || path.join(__dirname, '..', 'lib', 'match-engine.js'));
const { matchContent, diagnoseFailure } = eng;

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}
function ok(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log('FAIL ' + name + (detail === undefined ? '' : '\n  ' + JSON.stringify(detail))); }
}
function block(name, fn) {
  try { fn(); } catch (e) { fail++; console.log('FAIL ' + name + ' threw: ' + (e && e.message)); }
}

const BUF = ['function f() {', '  const a = 1; // set a', '  const b = 2;', '  return a + b;', '}',
  'function g() {', '  return 0;', '}'];
function scope(start, end, hasScope) {
  return { searchStart: start, searchEnd: end, scopeLabel: hasScope ? 'within function g (lines 6-8)' : '',
    _hasScope: !!hasScope, via: hasScope ? 'inFunction' : 'none', hints: hasScope ? { inFunction: 'g' } : {} };
}
function match(needle, sc, opts) {
  const r = matchContent(needle, { allLines: BUF, text: BUF.join('\n') }, sc, opts || {});
  return r.matched
    ? { matched: true, transforms: r.transforms, matchLine: r.matchLine, matchEndLine: r.matchEndLine }
    : { matched: false, reason: r.reason, transforms: r.transforms };
}
const NO_MATCH = { matched: false, reason: 'noMatch', transforms: [] };
const T3 = '  const a = 1; // set a\n  const b = 2;\n    return a + b;'; // first two lines exact, 3rd line extra indent

// ---- M: matchContent ------------------------------------------------------------------------------
block('M', () => {
  eq('M1 whole-file scope: stage 1 still rescues whitespace drift in scope', match(T3, scope(0, 7, false)),
    { matched: true, transforms: ['fuzzyWhitespace'], matchLine: 1, matchEndLine: 3 });
  eq('M2 target INSIDE the narrowed scope: still rescued', match(T3, scope(0, 4, true)),
    { matched: true, transforms: ['fuzzyWhitespace'], matchLine: 1, matchEndLine: 3 });
  eq('M3 target only OUTSIDE the scope: no longer committed outside it', match(T3, scope(5, 7, true)), NO_MATCH);
  eq('M4 an EXACT needle that exists only outside the scope is no longer committed there either',
    match('  const a = 1; // set a\n  const b = 2;', scope(5, 7, true)), NO_MATCH);
  eq('M5 2-line needle, 2nd line whitespace-different, outside scope (never rescued)',
    match('  const a = 1; // set a\n    const b = 2;', scope(5, 7, true)), NO_MATCH);
  eq('M6 3rd line really different, outside scope (never rescued)',
    match('  const a = 1; // set a\n  const b = 2;\n  return a - b;', scope(5, 7, true)), NO_MATCH);
  eq('M7 autoRescue:false in scope fails', match(T3, scope(0, 4, true), { autoRescue: false }), NO_MATCH);
  eq('M8 autoRescue:false outside scope fails', match(T3, scope(5, 7, true), { autoRescue: false }), NO_MATCH);
  eq('M9 an exact needle located AFTER the scope end is not found',
    match('  return 0;', scope(0, 4, true)), NO_MATCH);
  eq('M10 a whitespace-different needle located AFTER the scope end is not found',
    match('    return 0;', scope(0, 4, true)), NO_MATCH);
});

// ---- D: what the caller is told -------------------------------------------------------------------
block('D', () => {
  const diag = (needle) => diagnoseFailure({ tool: 'replace', ctx: { allLines: BUF, text: BUF.join('\n') },
    scope: scope(5, 7, true), needle, subject: 'old_str', fuzzyAdvice: '' });
  const exact = diag('  const a = 1; // set a\n  const b = 2;');
  eq('D1 exact needle outside scope: reason key', exact.statKey, 'noMatch');
  eq('D2 ... foundOutsideScope flag', exact.diag.foundOutsideScope, true);
  eq('D3 ... exactOutsideScope flag', exact.diag.exactOutsideScope, true);
  const postE = exact.post.join('\n');
  ok('D4 ... says FOUND OUTSIDE SCOPE', postE.indexOf('FOUND OUTSIDE SCOPE') >= 0, postE);
  ok('D5 ... names the hit line', postE.indexOf('Hit(s) outside scope: L2 (inside f())') >= 0, postE);
  const ws = diag(T3);
  eq('D6 whitespace-different outside scope: foundOutsideScope stays false (it means EXACT text only)',
    ws.diag.foundOutsideScope, false);
  eq('D6b ... but elsewhere is reported: lines 2-4, outside the scope',
    ws.diag.elsewhere && [ws.diag.elsewhere.startLine, ws.diag.elsewhere.endLine, ws.diag.elsewhere.outsideScope], [2, 4, true]);
  const postW = ws.post.join('\n');
  ok('D7 says FOUND ELSEWHERE', postW.indexOf('FOUND ELSEWHERE') >= 0, postW);
  ok('D7b no longer claims NOT FOUND ANYWHERE', postW.indexOf('NOT FOUND ANYWHERE') < 0, postW);
  ok('D7c gives the location and the scope fix',
    postW.indexOf('at lines 2-4, outside the search scope.') >= 0
    && postW.indexOf('Fix: drop the scope hint, or move it so it covers lines 2-4.') >= 0, postW);
  ok('D7d names the differing line',
    postW.indexOf('old_str line 3 reads') >= 0 && postW.indexOf('buffer line 4 reads') >= 0, postW);
  const preW = ws.pre.join('\n');
  ok('D8 the misleading "Low match, wrong location" similarity line is replaced',
    preW.indexOf('FOUND ELSEWHERE below') >= 0 && preW.indexOf('Similarity:') < 0, preW);
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
