'use strict';
// test/fail-diagnostics.no-row.test.js (2026-10-12, PJ: precision edits)
// When closestArea finds no plausible row (no line shares a distinctive word with old_str), the old code still printed
// "Similarity: N%" computed against the FIRST rows of the window, i.e. against unrelated text. Now:
//   - no plausible row and no located diagnosis (whitespace / encoding / partial match) -> one plain line:
//     "No similar location found in the search window ..." and NO percentage;
//   - no plausible row but a located diagnosis exists -> nothing is added (the located line already says where);
//   - a plausible row (including row 0) -> the "Similarity: N%" line is kept.
// r.diag.similarity / similarityTier stay on the result either way.
// NR_PATH env points at a COPY of lib/match-engine.js that lives next to the other lib files (mutation harness).
const path = require('path');
const LIB = process.env.NR_PATH ? path.dirname(process.env.NR_PATH) : path.join(__dirname, '..', 'lib');
const eng = require(path.join(LIB, 'match-engine.js'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log('FAIL ' + name + (detail === undefined ? '' : '\n  ' + JSON.stringify(detail))); }
}
function block(name, fn) {
  try { fn(); } catch (e) { fail++; console.log('FAIL ' + name + ' threw: ' + (e && e.message)); }
}

const BUF = ['function f() {', '  const a = 1; // set a', '  const b = 2;', '  return a + b;', '}', 'function g() {', '  return 0;', '}'];
const NOSCOPE = { searchStart: 0, searchEnd: 8, scopeLabel: '', _hasScope: false, via: 'none', hints: {} };
function diag(needle) {
  return eng.diagnoseFailure({ tool: 'replace', ctx: { allLines: BUF, text: BUF.join('\n') }, scope: NOSCOPE,
    needle, subject: 'old_str', fuzzyAdvice: '' });
}
const pre = (r) => r.pre.join('\n');
const has = (s, t) => s.indexOf(t) >= 0;
const NO_ROW = 'No similar location found in the search window';

block('N1 no distinctive word in the file: plain line, no percentage, no unrelated text', () => {
  const r = diag('  zzzzqqq();\n  wwwwvvv();');
  ok('N1a closestRow is -1', r.diag.closestRow === -1, r.diag.closestRow);
  ok('N1b no-row line printed', has(pre(r), NO_ROW), pre(r));
  ok('N1c no percentage, no tier wording', !has(pre(r), 'Similarity:') && !has(pre(r), 'Low match') && !has(pre(r), '%'), pre(r));
  ok('N1d no Closest area block', !has(pre(r), 'Closest area found'), pre(r));
  ok('N1e similarity number and tier are still on the result',
    typeof r.diag.similarity === 'number' && ['close', 'moderate', 'low'].indexOf(r.diag.similarityTier) >= 0, r.diag);
  ok('N1f the line gives the next step', has(pre(r), 'Verify scope hints and re-read the target area.'), pre(r));
});

block('N2 a plausible row: Closest area and the Similarity line are kept', () => {
  const r = diag('  const b = 3;\n  return a + b;');
  ok('N2a row found', r.diag.closestRow >= 0, r.diag.closestRow);
  ok('N2b Closest area block present', has(pre(r), 'Closest area found'), pre(r));
  ok('N2c Similarity line present, no-row line absent', has(pre(r), 'Similarity:') && !has(pre(r), NO_ROW), pre(r));
});

block('N3 no row but a located diagnosis (partial match): nothing added, no percentage', () => {
  const r = diag('}\n}');
  ok('N3a closestRow is -1 and partial match found', r.diag.closestRow === -1 && r.diag.partialMatchLines > 0, [r.diag.closestRow, r.diag.partialMatchLines]);
  ok('N3b PARTIAL MATCH line present', has(pre(r), 'PARTIAL MATCH'), pre(r));
  ok('N3c neither the no-row line nor a percentage', !has(pre(r), NO_ROW) && !has(pre(r), 'Similarity:'), pre(r));
});

block('N4 row 0 is a valid row (boundary): Similarity line kept', () => {
  // 'function' is the only distinctive word; row 0 ("function f() {") is the first best-scoring line.
  const r = diag('function fx() {\n  return 9;');
  ok('N4a closestRow is 0', r.diag.closestRow === 0, r.diag.closestRow);
  ok('N4b Similarity line present, no-row line absent', has(pre(r), 'Similarity:') && !has(pre(r), NO_ROW), pre(r));
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
