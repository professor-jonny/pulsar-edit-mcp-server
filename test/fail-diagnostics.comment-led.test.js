'use strict';
// test/fail-diagnostics.comment-led.test.js (2026-10-12)
// Finding B: when a COMMENT MISMATCH is the lead diagnosis, the generic "Similarity: N%" line and the
// "NOT FOUND ANYWHERE" block contradicted it (the code lines DO match). They are replaced by a line saying
// the code matches except for the trailing comment, and by a "fix the comment and retry" hint.
// Everything else is unchanged: no comment issue keeps both generic lines; an exact-text-outside-scope
// failure keeps FOUND OUTSIDE SCOPE; a whitespace-different match elsewhere keeps FOUND ELSEWHERE.
// Written probe-first (TEMP\probe_cl.js printed the real outputs).
// Run: node test/fail-diagnostics.comment-led.test.js   (CL_PATH env points at a COPY of lib/match-engine.js that lives
// next to the other lib files; used by the mutation harness). Last line is '<N> passed, <M> failed'.
const path = require('path');
const LIB = process.env.CL_PATH ? path.dirname(process.env.CL_PATH) : path.join(__dirname, '..', 'lib');
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
function scope(start, end, has, fn) {
  return { searchStart: start, searchEnd: end, scopeLabel: has ? 'within function ' + fn + ' (lines X-Y)' : '',
    _hasScope: !!has, via: has ? 'inFunction' : 'none', hints: has ? { inFunction: fn } : {} };
}
function diag(needle, sc) {
  return eng.diagnoseFailure({ tool: 'replace', ctx: { allLines: BUF, text: BUF.join('\n') }, scope: sc,
    needle, subject: 'old_str', fuzzyAdvice: '' });
}
const pre = (r) => r.pre.join('\n');
const post = (r) => r.post.join('\n');
const has = (s, t) => s.indexOf(t) >= 0;

const MATCHES_LINE = 'The code on the line(s) flagged under COMMENT MISMATCH matches the buffer; only the trailing comment differs.';
const FIX_HINT = 'Fix the trailing comment(s) shown under COMMENT MISMATCH and retry';

block('C1 extra comment on the last line, no scope', () => {
  const r = diag('  const b = 2;\n  return a + b; // sum', scope(0, 8, false));
  ok('C1a reason is comment', r.diag.reason === 'comment', r.diag.reason);
  ok('C1b COMMENT MISMATCH still first', has(pre(r), 'COMMENT MISMATCH') && has(pre(r), 'remove the comment // sum'), pre(r));
  ok('C1c no Similarity line', !has(pre(r), 'Similarity:'), pre(r));
  ok('C1d code-matches line present', has(pre(r), MATCHES_LINE), pre(r));
  ok('C1e no NOT FOUND ANYWHERE', !has(post(r), 'NOT FOUND ANYWHERE') && !has(post(r), 'does not appear anywhere'), post(r));
  ok('C1f fix hint present', has(post(r), FIX_HINT), post(r));
  ok('C1g no hint label when no hint was used', !has(post(r), 'Hint used:'), post(r));
});

block('C2 scoped: the hint label is kept', () => {
  const r = diag('  const b = 2;\n  return a + b; // sum', scope(0, 4, true, 'f'));
  ok('C2a still comment-led, fix hint present', r.diag.reason === 'comment' && has(post(r), FIX_HINT), post(r));
  ok('C2b hint label kept', has(post(r), 'Hint used: inFunction:"f"'), post(r));
  ok('C2c no Similarity, no NOT FOUND ANYWHERE', !has(pre(r), 'Similarity:') && !has(post(r), 'NOT FOUND ANYWHERE'), [pre(r), post(r)]);
});

block('C3 missing comment (buffer has one, needle lacks it)', () => {
  const r = diag('  const a = 1;\n  const b = 2;', scope(0, 8, false));
  ok('C3a kind missing is reported', has(pre(r), 'ends with a comment old_str lacks'), pre(r));
  ok('C3b generic lines replaced', has(pre(r), MATCHES_LINE) && !has(pre(r), 'Similarity:') && !has(post(r), 'NOT FOUND ANYWHERE'), [pre(r), post(r)]);
});

block('C4 comment issue plus another real difference: the claim stays limited to the flagged lines', () => {
  const r = diag('  const b = 3;\n  return a + b; // sum', scope(0, 8, false));
  ok('C4a says only the FLAGGED lines match', has(pre(r), 'The code on the line(s) flagged under COMMENT MISMATCH matches the buffer'), pre(r));
  ok('C4b never claims the whole old_str matches', !has(pre(r), 'old_str matches') && !has(post(r), 'old_str matches'), [pre(r), post(r)]);
  ok('C4c fix hint hedged with the re-read advice', has(post(r), 'only if it still fails'), post(r));
});

block('C5 control: no comment issue keeps the generic wording', () => {
  const r = diag('  const z = 9;\n  return z;', scope(0, 8, false));
  ok('C5a reason noMatch', r.diag.reason === 'noMatch', r.diag.reason);
  ok('C5b Similarity line kept', has(pre(r), 'Similarity:'), pre(r));
  ok('C5c NOT FOUND ANYWHERE kept', has(post(r), 'NOT FOUND ANYWHERE'), post(r));
  ok('C5d none of the new wording', !has(pre(r), MATCHES_LINE) && !has(post(r), FIX_HINT), [pre(r), post(r)]);
});

block('C6 exact text outside the scope keeps FOUND OUTSIDE SCOPE (not comment-led)', () => {
  const r = diag('  const a = 1; // set a\n  const b = 2;', scope(5, 7, true, 'g'));
  ok('C6a FOUND OUTSIDE SCOPE', has(post(r), 'FOUND OUTSIDE SCOPE'), post(r));
  ok('C6b none of the comment-led wording', !has(pre(r), MATCHES_LINE) && !has(post(r), FIX_HINT), [pre(r), post(r)]);
});

block('C7 whitespace-different text elsewhere keeps FOUND ELSEWHERE (not comment-led)', () => {
  const r = diag('  const a = 1; // set a\n  const b = 2;\n    return a + b;', scope(5, 7, true, 'g'));
  ok('C7a FOUND ELSEWHERE', has(post(r), 'FOUND ELSEWHERE'), post(r));
  ok('C7b none of the comment-led wording', !has(pre(r), MATCHES_LINE) && !has(post(r), FIX_HINT), [pre(r), post(r)]);
});

// A comment issue found in the SCOPED window can coexist with a where-is-it explanation (the text exists elsewhere
// ignoring whitespace): the where-is-it explanation keeps priority. Probe: TEMP\probe_cl4.js.
function diagBuf(buf, needle, sc) {
  return eng.diagnoseFailure({ tool: 'replace', ctx: { allLines: buf, text: buf.join('\n') }, scope: sc,
    needle, subject: 'old_str', fuzzyAdvice: '' });
}
const NEEDLE3 = '  const a = 1;\n  const b = 2;\n    return a + b;';
const F = ['function f() {', '  const a = 1;', '  const b = 2;', '  return a + b;', '}'];
const G = ['function g() {', '  return a + b; // sum', '}'];
const H = ['function h() {', '  const a = 1;', '  const b = 2;', '  return a + b;', '}'];

block('C8 comment issue in the scoped window AND the text exists elsewhere (one place): FOUND ELSEWHERE wins', () => {
  const r = diagBuf(F.concat(G), NEEDLE3, scope(5, 7, true, 'g'));
  ok('C8a reason is still comment, elsewhere is set and unambiguous',
    r.diag.reason === 'comment' && r.diag.elsewhere && !r.diag.elsewhere.ambiguous, [r.diag.reason, r.diag.elsewhere]);
  ok('C8b COMMENT MISMATCH and FOUND ELSEWHERE both reported', has(pre(r), 'COMMENT MISMATCH') && has(post(r), 'FOUND ELSEWHERE'), [pre(r), post(r)]);
  ok('C8c elsewhere sentence in the pre section, comment-led wording absent',
    has(pre(r), 'FOUND ELSEWHERE below') && !has(pre(r), MATCHES_LINE) && !has(post(r), FIX_HINT), [pre(r), post(r)]);
});

block('C9 comment issue in the scoped window AND the elsewhere match is ambiguous: no comment-led wording', () => {
  const r = diagBuf(F.concat(H).concat(G), NEEDLE3, scope(10, 12, true, 'g'));
  ok('C9a elsewhere is ambiguous', r.diag.elsewhere && r.diag.elsewhere.ambiguous === true, r.diag.elsewhere);
  // 2026-10-12 (PJ, precision edits): the scoped window has no plausible row, so the percentage is replaced by the
  // "No similar location found" line; the comment-led wording must still NOT appear (kills the mutant that ignores _elsewhere).
  ok('C9b no comment-led wording, no unrelated percentage',
    has(pre(r), 'No similar location found') && !has(pre(r), 'Similarity:') && !has(pre(r), MATCHES_LINE), pre(r));
  ok('C9c FOUND ELSEWHERE (ambiguous) message, no fix-the-comment hint',
    has(post(r), 'more than one place in the file') && !has(post(r), FIX_HINT), post(r));
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
