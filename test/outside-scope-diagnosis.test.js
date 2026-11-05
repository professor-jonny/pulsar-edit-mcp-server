'use strict';
// test/outside-scope-diagnosis.test.js (2026-10-11)
// Pins lib/outside-scope-diagnosis.js (pure) and its wiring into lib/fail-diagnostics.js diagnose(): text that is not
// exact anywhere but exists, ignoring whitespace, OUTSIDE the search scope is a FAILURE with a precise diagnosis
// ("FOUND ELSEWHERE"), never an edit made behind the caller's back (PJ, 2026-10-11). It replaces the old, false
// "NOT FOUND ANYWHERE" in exactly that case and in no other.
// Written probe-first (TEMP\probe_diag2.js, probe_diag3.js printed every real output before an assertion was written).
// Run: node test/outside-scope-diagnosis.test.js   (ME_PATH env points at a COPY of lib/match-engine.js that lives next
// to the other lib files; the module under test is taken from the same folder, used by the mutation harness).
// Last line is '<N> passed, <M> failed'.
const path = require('path');
const LIB = process.env.ME_PATH ? path.dirname(process.env.ME_PATH) : path.join(__dirname, '..', 'lib');
const eng = require(path.join(LIB, 'match-engine.js'));
const el = require(path.join(LIB, 'outside-scope-diagnosis.js'));

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

const BUF = ['function f() {', '  const a = 1; // set a', '  const b = 2;', '  return a + b;', '}', 'function g() {', '  return 0;', '}'];
const BUF2 = ['function f() {', '  const a = 1;', '  const b = 2;', '  return a + b;', '}',
  'function h() {', '  const a = 1;', '  const b = 2;', '  return a - b;', '}',
  'function g() {', '  return 0;', '}'];
const T3 = '  const a = 1; // set a\n  const b = 2;\n    return a + b;'; // first two lines exact, 3rd line extra indent

// ---- M: the pure module ----------------------------------------------------------------------------
block('M', () => {
  const text = BUF.join('\n');
  eq('M1 whitespace-different 3-line needle, search window empty',
    el.diagnoseElsewhere({ needleText: T3, fullText: text, searchStart: 0, searchEnd: 0 }),
    { ambiguous: false, startLine: 2, endLine: 4, outsideScope: true,
      differing: [{ needleLine: 3, needleText: '    return a + b;', bufferLine: 4, bufferText: '  return a + b;' }] });
  eq('M2 single-line needle is never diagnosed',
    el.diagnoseElsewhere({ needleText: '  return 0;', fullText: text, searchStart: 0, searchEnd: 0 }), null);
  eq('M3 non-string needle', el.diagnoseElsewhere({ needleText: 5, fullText: text }), null);
  eq('M4 no arguments', el.diagnoseElsewhere(), null);
  eq('M5 an exact 2-line needle outside the window has no differing lines',
    el.diagnoseElsewhere({ needleText: '  const a = 1; // set a\n  const b = 2;', fullText: text,
      searchStart: text.indexOf('function g'), searchEnd: text.length }),
    { ambiguous: false, startLine: 2, endLine: 3, outsideScope: true, differing: [] });
});

// ---- F: the advice lines ---------------------------------------------------------------------------
block('F', () => {
  eq('F1 exact match outside the scope, with a scope label',
    el.formatElsewhereAdvice({ ambiguous: false, startLine: 2, endLine: 3, outsideScope: true, differing: [] },
      { subject: 'old_str', scopeLabel: ' within g' }),
    ['old_str was not found within g as written, but it matches exactly at lines 2-3, outside the search scope.',
      '  Fix: drop the scope hint, or move it so it covers lines 2-3.']);
  eq('F2 one line, inside the scope, custom subject',
    el.formatElsewhereAdvice({ ambiguous: false, startLine: 4, endLine: 4, outsideScope: false,
      differing: [{ needleLine: 1, needleText: ' x', bufferLine: 4, bufferText: 'x' }] }, { subject: 'new_str' }),
    ['new_str was not found as written, but it matches (ignoring whitespace) at line 4.',
      '  Whitespace (indentation or trailing) differs on 1 line(s):',
      '  new_str line 1 reads " x" but buffer line 4 reads "x"',
      '  Fix: use the buffer whitespace shown above (or pass fuzzyWhitespace:true).']);
  const many = [0, 1, 2, 3, 4].map((i) => ({ needleLine: i + 1, needleText: ' a' + i, bufferLine: 10 + i, bufferText: 'a' + i }));
  eq('F3 more differing lines than max: first max shown, then a count',
    el.formatElsewhereAdvice({ ambiguous: false, startLine: 10, endLine: 14, outsideScope: true, differing: many }, { max: 2 }),
    ['old_str was not found as written, but it matches (ignoring whitespace) at lines 10-14, outside the search scope.',
      '  Fix: drop the scope hint, or move it so it covers lines 10-14.',
      '  Whitespace (indentation or trailing) differs on 5 line(s):',
      '  old_str line 1 reads " a0" but buffer line 10 reads "a0"',
      '  old_str line 2 reads " a1" but buffer line 11 reads "a1"',
      '  ... and 3 more line(s).',
      '  Fix: use the buffer whitespace shown above (or pass fuzzyWhitespace:true).']);
  const three = [1, 2, 3].map((i) => ({ needleLine: i, needleText: ' a' + i, bufferLine: 20 + i, bufferText: 'a' + i }));
  const f3 = el.formatElsewhereAdvice({ ambiguous: false, startLine: 20, endLine: 22, outsideScope: true, differing: three });
  eq('F4 exactly max (3) differing lines: all shown, no "and N more" line', f3.length, 7);
  ok('F4b ... and no "more line(s)" text', f3.join('\n').indexOf('more line(s)') < 0, f3);
  eq('F5 ambiguous',
    el.formatElsewhereAdvice({ ambiguous: true }, { subject: 'old_str' }),
    ['old_str (ignoring whitespace) matches in more than one place in the file, so no location can be suggested.'
      + ' Narrow old_str or add a scope hint or occurrence:N.']);
  eq('F6 null diagnosis', el.formatElsewhereAdvice(null), []);
  eq('F7 non-object diagnosis', el.formatElsewhereAdvice('x'), []);
});

// ---- W: wiring into diagnose() via diagnoseFailure ---------------------------------------------------
function scope(start, end, has) {
  return { searchStart: start, searchEnd: end, scopeLabel: has ? 'within function g (lines X-Y)' : '',
    _hasScope: !!has, via: has ? 'inFunction' : 'none', hints: has ? { inFunction: 'g' } : {} };
}
function diag(buf, needle, sc) {
  return eng.diagnoseFailure({ tool: 'replace', ctx: { allLines: buf, text: buf.join('\n') }, scope: sc,
    needle, subject: 'old_str', fuzzyAdvice: '' });
}
const post = (r) => r.post.join('\n');
const pre = (r) => r.pre.join('\n');
block('W', () => {
  const p2 = diag(BUF, T3, scope(5, 7, true));
  eq('W1 target before the scope: elsewhere lines 2-4, outside', p2.diag.elsewhere && [p2.diag.elsewhere.startLine, p2.diag.elsewhere.endLine, p2.diag.elsewhere.outsideScope], [2, 4, true]);
  ok('W1b says FOUND ELSEWHERE, not NOT FOUND ANYWHERE', post(p2).indexOf('FOUND ELSEWHERE') >= 0 && post(p2).indexOf('NOT FOUND ANYWHERE') < 0, post(p2));
  ok('W1d gives the location and the scope fix',
    post(p2).indexOf('at lines 2-4, outside the search scope.') >= 0
    && post(p2).indexOf('Fix: drop the scope hint, or move it so it covers lines 2-4.') >= 0, post(p2));
  ok('W1e names the differing line and the whitespace fix',
    post(p2).indexOf('old_str line 3 reads "    return a + b;" but buffer line 4 reads "  return a + b;"') >= 0
    && post(p2).indexOf('Fix: use the buffer whitespace shown above') >= 0, post(p2));
  ok('W1c similarity claim replaced', pre(p2).indexOf('FOUND ELSEWHERE below') >= 0 && pre(p2).indexOf('Similarity:') < 0, pre(p2));

  const e7 = diag(BUF, 'function g() {\n  return 0;\n  }', scope(0, 4, true));
  eq('W2 target AFTER the scope end: elsewhere lines 6-8, outside',
    e7.diag.elsewhere && [e7.diag.elsewhere.startLine, e7.diag.elsewhere.endLine, e7.diag.elsewhere.outsideScope], [6, 8, true]);
  ok('W2b says FOUND ELSEWHERE', post(e7).indexOf('FOUND ELSEWHERE') >= 0, post(e7));

  const e1 = diag(BUF2, '  const a = 1;\n  const b = 2;\n    return a + b;', scope(10, 12, true));
  eq('W3 ambiguous leader: elsewhere is {ambiguous:true}', e1.diag.elsewhere, { ambiguous: true });
  ok('W3b says FOUND ELSEWHERE with the ambiguity text',
    post(e1).indexOf('FOUND ELSEWHERE') >= 0 && post(e1).indexOf('matches in more than one place in the file') >= 0, post(e1));
  // 2026-10-12 (PJ, precision edits): no plausible row in the scoped window, so no percentage is printed any more;
  // the ambiguity still gives no single-location claim in the pre section.
  ok('W3c ambiguous: no single-location claim, no unrelated percentage',
    pre(e1).indexOf('FOUND ELSEWHERE below') < 0 && pre(e1).indexOf('Similarity:') < 0 && pre(e1).indexOf('No similar location found') >= 0, pre(e1));

  const e2 = diag(BUF, '    return 0;', scope(0, 4, true));
  eq('W4 single-line needle: no elsewhere', e2.diag.elsewhere, null);
  ok('W4b ... still NOT FOUND ANYWHERE', post(e2).indexOf('NOT FOUND ANYWHERE') >= 0 && post(e2).indexOf('FOUND ELSEWHERE') < 0, post(e2));

  const e3 = diag(BUF, T3, scope(0, 4, true));
  eq('W5 text inside the scope (whitespace drift): no elsewhere', e3.diag.elsewhere, null);
  eq('W5b ... classified as whitespace', e3.statKey, 'whitespace');
  ok('W5c ... still NOT FOUND ANYWHERE', post(e3).indexOf('NOT FOUND ANYWHERE') >= 0, post(e3));

  const e4 = diag(BUF, T3, scope(0, 7, false));
  eq('W6 no scope hint: no elsewhere', e4.diag.elsewhere, null);
  ok('W6b ... still NOT FOUND ANYWHERE', post(e4).indexOf('NOT FOUND ANYWHERE') >= 0, post(e4));

  const e6 = diag(BUF2, '  const a = 1;\n  const b = 2;\n    return a + b;', scope(0, 12, false));
  eq('W7 no scope hint, ambiguous leader: no elsewhere', e6.diag.elsewhere, null);
  ok('W7b ... still NOT FOUND ANYWHERE', post(e6).indexOf('NOT FOUND ANYWHERE') >= 0, post(e6));

  const e5 = diag(BUF, '  const a = 1; // set a\n  const b = 2;\n  return a - b;', scope(5, 7, true));
  eq('W8 a really different 3rd line: no elsewhere', e5.diag.elsewhere, null);
  ok('W8b ... still NOT FOUND ANYWHERE', post(e5).indexOf('NOT FOUND ANYWHERE') >= 0, post(e5));

  const ex = diag(BUF, '  const a = 1; // set a\n  const b = 2;', scope(5, 7, true));
  eq('W9 EXACT text outside the scope is still FOUND OUTSIDE SCOPE (unchanged), no elsewhere', ex.diag.elsewhere, null);
  eq('W9b ... foundOutsideScope true', ex.diag.foundOutsideScope, true);
  ok('W9c ... says FOUND OUTSIDE SCOPE', post(ex).indexOf('FOUND OUTSIDE SCOPE') >= 0 && post(ex).indexOf('FOUND ELSEWHERE') < 0, post(ex));
  eq('W10 foundOutsideScope stays false for the whitespace-different elsewhere case (stats unchanged)', p2.diag.foundOutsideScope, false);
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
