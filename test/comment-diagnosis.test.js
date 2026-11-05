'use strict';
// test/comment-diagnosis.test.js (2026-10-11)
// Pins lib/comment-diagnosis.js: splitTrailingComment, diagnoseComments, formatCommentAdvice.
// Written probe-first (TEMP\probe_cd.js printed the real outputs before any assertion was written).
// Run: node test/comment-diagnosis.test.js   (CD_PATH env points it at another copy, used by the
// mutation harness). Last line is '<N> passed, <M> failed'.
const path = require('path');
const mod = require(process.env.CD_PATH || path.join(__dirname, '..', 'lib', 'comment-diagnosis.js'));
const { splitTrailingComment, diagnoseComments, formatCommentAdvice } = mod;

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}
function block(name, fn) {
  try { fn(); } catch (e) { fail++; console.log('FAIL ' + name + ' threw: ' + (e && e.message)); }
}

// ---- S: splitTrailingComment --------------------------------------------------------------
block('S', () => {
  const s = splitTrailingComment;
  eq('S1 no comment', s('const a = 1;'), { code: 'const a = 1;', comment: null });
  eq('S2 line comment', s('const a = 1; // note'), { code: 'const a = 1;', comment: '// note' });
  eq('S3 tight comment', s('const a = 1;// tight'), { code: 'const a = 1;', comment: '// tight' });
  eq('S4 // inside a string, real comment after',
    s('  x = "http://x.y"; // real'), { code: '  x = "http://x.y";', comment: '// real' });
  eq('S5 // inside single quotes is not a comment', s("s = 'a // not' + b;"), { code: "s = 'a // not' + b;", comment: null });
  eq('S6 inline block comment with code after it', s('f(a /* inline */, b);'), { code: 'f(a /* inline */, b);', comment: null });
  eq('S7 trailing block comment', s('f(a); /* trail */'), { code: 'f(a);', comment: '/* trail */' });
  eq('S8 unclosed block comment runs to end of line', s('f(a); /* opens'), { code: 'f(a);', comment: '/* opens' });
  eq('S9 comment-only line', s('// only comment'), { code: '', comment: '// only comment' });
  eq('S10 template literal then comment', s('x = `t//t`; // c'), { code: 'x = `t//t`;', comment: '// c' });
  eq('S11 unbalanced quote means no comment detected', s("it's // odd quote"), { code: "it's // odd quote", comment: null });
  eq('S12 escaped quote keeps the string open', s('x = "a\\" // still string'), { code: 'x = "a\\" // still string', comment: null });
  eq('S13 empty', s(''), { code: '', comment: null });
  eq('S14 non-string', s(undefined), { code: '', comment: null });
  eq('S15 leading whitespace kept, trailing removed', s('  a();   // c'), { code: '  a();', comment: '// c' });
  eq('S16 block comment then line comment', s('f(a /* x */); // y'), { code: 'f(a /* x */);', comment: '// y' });
});

// ---- D: diagnoseComments ------------------------------------------------------------------
const BUF = [
  'function f() {',
  '  const a = 1; // first',
  '  const b = 2;',
  '  return a + b; // sum',
  '}',
  'const a = 1; // first',
];
const dx = (needleLines, extra) => diagnoseComments(Object.assign({ needleLines, haystackLines: BUF }, extra || {}));
block('D', () => {
  eq('D1 extra: needle has a comment the buffer lacks', dx(['  const b = 2; // two']),
    [{ needleLine: 1, kind: 'extra', needleComment: '// two', bufferComment: null, bufferLine: 3, bufferText: '  const b = 2;', candidateCount: 1 }]);
  eq('D2 missing: buffer has a comment the needle lacks (2 similar lines, first reported)', dx(['  const a = 1;']),
    [{ needleLine: 1, kind: 'missing', needleComment: null, bufferComment: '// first', bufferLine: 2, bufferText: '  const a = 1; // first', candidateCount: 2 }]);
  eq('D3 different comments', dx(['  return a + b; // total']),
    [{ needleLine: 1, kind: 'different', needleComment: '// total', bufferComment: '// sum', bufferLine: 4, bufferText: '  return a + b; // sum', candidateCount: 1 }]);
  eq('D4 a line that matches exactly is no issue', dx(['  const b = 2;']), []);
  eq('D5 indentation-only difference is no issue', dx(['const b = 2;']), []);
  eq('D6 comment-only needle line is no issue', dx(['  // nothing']), []);
  eq('D7 no buffer line with that code is no issue', dx(['  const z = 9; // z']), []);
  const multi = dx(['function f() {', '  const b = 2; // two', '  return a + b; // total', '}']);
  eq('D8 several issues, in needle order', multi.map(i => [i.needleLine, i.kind, i.bufferLine]), [[2, 'extra', 3], [3, 'different', 4]]);
  eq('D9 blank needle lines are skipped but still counted in numbering',
    dx(['', '  const b = 2; // two']).map(i => [i.needleLine, i.kind]), [[2, 'extra']]);
  eq('D10 diagOffset makes bufferLine absolute', dx(['  const b = 2; // two'], { diagOffset: 40 })[0].bufferLine, 43);
  eq('D11 non-array input gives no issues',
    [diagnoseComments({ needleLines: null, haystackLines: BUF }), diagnoseComments({ needleLines: ['x'], haystackLines: null })], [[], []]);
  eq('D12 same comment, different spacing before it, is no issue', diagnoseComments({ needleLines: ['x = 1;   // c'], haystackLines: ['x = 1; // c'] }), []);
  eq('D13 block comment kinds', diagnoseComments({ needleLines: ['f(a); /* x */'], haystackLines: ['f(a);'] }).map(i => [i.kind, i.needleComment, i.bufferComment]),
    [['extra', '/* x */', null]]);
  const needleCopy = ['  const b = 2; // two'], bufCopy = BUF.slice();
  diagnoseComments({ needleLines: needleCopy, haystackLines: bufCopy });
  eq('D14 inputs are not mutated', [needleCopy, bufCopy], [['  const b = 2; // two'], BUF]);
  eq('D15 first of several differing candidates is reported', diagnoseComments({
    needleLines: ['go();'], haystackLines: ['go(); // one', 'x', 'go(); // two'] }).map(i => [i.bufferLine, i.candidateCount, i.bufferComment]), [[1, 2, '// one']]);
  eq('D16 code that differs by more than the comment is no issue', diagnoseComments({
    needleLines: ['go(1); // a'], haystackLines: ['go(2); // a'] }), []);
  eq('D17 // inside a string on both sides does not create an issue', diagnoseComments({
    needleLines: ['u = "http://a";'], haystackLines: ['u = "http://a";'] }), []);
  eq('D18 empty needle', diagnoseComments({ needleLines: [], haystackLines: BUF }), []);
  eq('D19 non-string needle entries are skipped', diagnoseComments({ needleLines: [null, 5, '  const b = 2; // two'], haystackLines: BUF }).map(i => i.needleLine), [3]);
});

// ---- A: formatCommentAdvice ---------------------------------------------------------------
const HDR1 = '1 line(s) of old_str match the buffer except for their trailing comment. Fix just these lines:';
block('A', () => {
  const adv = (needle, opts) => formatCommentAdvice(diagnoseComments({ needleLines: needle, haystackLines: BUF }), opts);
  eq('A1 extra', adv(['  const b = 2; // two']),
    [HDR1, '  old_str line 1: remove the comment // two (buffer line 3 has none). It should read: const b = 2;']);
  eq('A2 missing, with the similar-lines note', adv(['  const a = 1;']),
    [HDR1, '  old_str line 1: buffer line 2 ends with a comment old_str lacks. It should read: const a = 1; // first [2 similar lines, first shown]']);
  eq('A3 different', adv(['  return a + b; // total']),
    [HDR1, '  old_str line 1: the comment differs (old_str: // total; buffer line 4: // sum). It should read: return a + b; // sum']);
  eq('A4 no issues gives no lines', adv(['  const b = 2;']), []);
  eq('A5 non-array gives no lines', formatCommentAdvice(null), []);
  eq('A6 subject is used in the header and the line', adv(['  const b = 2; // two'], { subject: 'anchor' }),
    ['1 line(s) of anchor match the buffer except for their trailing comment. Fix just these lines:',
     '  anchor line 1: remove the comment // two (buffer line 3 has none). It should read: const b = 2;']);

  const seven = [], sevenBuf = [];
  for (let i = 0; i < 7; i++) { seven.push('  v' + i + ' = ' + i + '; // c'); sevenBuf.push('  v' + i + ' = ' + i + ';'); }
  const sevenAdv = formatCommentAdvice(diagnoseComments({ needleLines: seven, haystackLines: sevenBuf }));
  eq('A7 default cap of 5 lines plus a tail line', [sevenAdv.length, sevenAdv[0], sevenAdv[5], sevenAdv[6]],
    [7, '7 line(s) of old_str match the buffer except for their trailing comment. Fix just these lines:',
     '  old_str line 5: remove the comment // c (buffer line 5 has none). It should read: v4 = 4;', '  ... and 2 more line(s).']);
  const capped = formatCommentAdvice(diagnoseComments({ needleLines: seven, haystackLines: sevenBuf }), { max: 2 });
  eq('A8 max option', [capped.length, capped[3]], [4, '  ... and 5 more line(s).']);
  const exact = formatCommentAdvice(diagnoseComments({ needleLines: seven.slice(0, 5), haystackLines: sevenBuf }));
  eq('A9 exactly max lines has no tail line', exact.length, 6);
  eq('A10 output is plain ASCII', adv(['  return a + b; // total']).join('\n').split('').every(c => c.charCodeAt(0) < 128), true);
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
