'use strict';
// test/fail-diagnostics.comment.test.js (2026-10-11)
// Pins the comment-mismatch failure reason in lib/fail-diagnostics.js: diagnose() now reports lines whose code
// matches the buffer but whose trailing comment differs (extra / missing / different), classify() ranks that
// reason between whitespace/encoding and partialMatch, and the generic PARTIAL MATCH guess is suppressed when a
// comment issue explains the divergence. Written probe-first (TEMP\probe_fd.js printed the real outputs before
// any assertion here). The existing byte-pinned fixtures stay in test/fail-diagnostics.test.js.
// Run: node test/fail-diagnostics.comment.test.js   (FD_PATH env points it at another copy, used by the
// mutation harness). Last line is '<N> passed, <M> failed'.
const path = require('path');
const mod = require(process.env.FD_PATH || path.join(__dirname, '..', 'lib', 'fail-diagnostics.js'));
const { diagnose, classify } = mod;

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}
function block(name, fn) {
  try { fn(); } catch (e) { fail++; console.log('FAIL ' + name + ' threw: ' + (e && e.message)); }
}

const EM = '\u2014';
const allLines = [
  'function f() {',
  '  const a = 1; // set a',
  '  const b = 2;',
  '  return a + b;',
  '}',
];
function run(needle, extra) {
  return diagnose(Object.assign({
    needle, allLines, scope: { hasScope: false, label: '' }, hints: {}, hintRadius: 15,
  }, extra || {}));
}
const HEAD = '\n??  COMMENT MISMATCH ' + EM + ' 1 line(s) of old_str match the buffer except for their trailing comment. Fix just these lines:';

// ---- C: the three kinds ---------------------------------------------------------------------
block('C', () => {
  const d1 = run('  const a = 1;\n  const b = 2;');
  eq('C1 reason', d1.reason, 'comment');
  eq('C1 kind', d1.commentIssues.map(i => i.kind), ['missing']);
  eq('C1 header', d1.messagesPre[1], HEAD);
  eq('C1 issue line', d1.messagesPre[2],
    '  old_str line 1: buffer line 2 ends with a comment old_str lacks. It should read: const a = 1; // set a');
  eq('C1 wsIssues empty', d1.wsIssues.length, 0);

  const d2 = run('  const b = 2; // two\n  return a + b;');
  eq('C2 reason', d2.reason, 'comment');
  eq('C2 kind', d2.commentIssues.map(i => i.kind), ['extra']);
  eq('C2 issue line', d2.messagesPre[2],
    '  old_str line 1: remove the comment // two (buffer line 3 has none). It should read: const b = 2;');

  const d3 = run('  const a = 1; // other\n  const b = 2;');
  eq('C3 reason', d3.reason, 'comment');
  eq('C3 kind', d3.commentIssues.map(i => i.kind), ['different']);
  eq('C3 issue line', d3.messagesPre[2],
    '  old_str line 1: the comment differs (old_str: // other; buffer line 2: // set a). It should read: const a = 1; // set a');
});

// ---- N: nothing changes when there is no comment issue --------------------------------------
block('N', () => {
  const d = run('  const zzz = 9;\n  return zzz;');
  eq('N1 reason', d.reason, 'noMatch');
  eq('N1 commentIssues', d.commentIssues, []);
  eq('N1 no section', d.messagesPre.some(m => m.includes('COMMENT MISMATCH')), false);
  const w = run('    const b = 2;\n  return a + b;');
  eq('N2 whitespace reason kept', w.reason, 'whitespace');
  eq('N2 no comment section', w.messagesPre.some(m => m.includes('COMMENT MISMATCH')), false);
  eq('N3 messages = pre + post', d.messages, d.messagesPre.concat(d.messagesPost));
  eq('N4 commentIssues is always an array', Array.isArray(d.commentIssues), true);
});

// ---- P: the generic PARTIAL MATCH guess ------------------------------------------------------
block('P', () => {
  const withComment = run('function f() {\n  const a = 1; // other');
  eq('P1 partial lines still counted', withComment.partialMatchLines, 1);
  eq('P1 reason is comment', withComment.reason, 'comment');
  eq('P1 PARTIAL MATCH message suppressed', withComment.messagesPre.some(m => m.includes('PARTIAL MATCH')), false);
  const plain = run('function f() {\n  const q = 1;');
  eq('P2 reason partialMatch', plain.reason, 'partialMatch');
  eq('P2 PARTIAL MATCH message shown', plain.messagesPre.some(m => m.includes('PARTIAL MATCH: first 1 of 2 lines')), true);
});

// ---- W: whitespace outranks comment, both sections still shown --------------------------------
block('W', () => {
  const d = run('    const b = 2;\n  const a = 1; // other');
  eq('W1 reason whitespace', d.reason, 'whitespace');
  eq('W1 both issue lists', [d.wsIssues.length, d.commentIssues.length], [1, 1]);
  eq('W1 both sections', [
    d.messagesPre.some(m => m.includes('WHITESPACE MISMATCH')),
    d.messagesPre.some(m => m.includes('COMMENT MISMATCH')),
  ], [true, true]);
});

// ---- S: subject and diagnosis window --------------------------------------------------------
block('S', () => {
  const d = run('  const a = 1; // other', { subject: 'matchString' });
  eq('S1 header uses subject', d.messagesPre[1],
    '\n??  COMMENT MISMATCH ' + EM + ' 1 line(s) of matchString match the buffer except for their trailing comment. Fix just these lines:');
  eq('S1 issue uses subject', d.messagesPre[2].startsWith('  matchString line 1: the comment differs'), true);
  // window rows [1,3) = buffer lines 2-3: the issue is seen and numbered ABSOLUTELY
  const inWin = run('  const a = 1; // other', { scope: { hasScope: false, label: '', diagStart: 1, diagEnd: 3 } });
  eq('S2 absolute line number', inWin.commentIssues.map(i => i.bufferLine), [2]);
  // window rows [2,4) = buffer lines 3-4: the commented line is outside the window, so no issue
  const outWin = run('  const a = 1; // other', { scope: { hasScope: false, label: '', diagStart: 2, diagEnd: 4 } });
  eq('S3 outside window sees nothing', outWin.commentIssues, []);
  eq('S3 reason falls back', outWin.reason, 'noMatch');
});

// ---- K: classify ordering and back-compat ----------------------------------------------------
block('K', () => {
  const base = { wsIssues: [], hasEncodingIssue: false, partialMatchLines: 0 };
  eq('K1 default has no comment', classify(base), 'noMatch');
  eq('K2 comment', classify(Object.assign({}, base, { commentIssueCount: 2 })), 'comment');
  eq('K3 comment outranks partial', classify(Object.assign({}, base, { commentIssueCount: 1, partialMatchLines: 3 })), 'comment');
  eq('K4 whitespace outranks comment', classify(Object.assign({}, base, { wsIssues: [{}], commentIssueCount: 1 })), 'whitespace');
  eq('K5 encoding outranks comment', classify(Object.assign({}, base, { wsIssues: [{}], hasEncodingIssue: true, commentIssueCount: 1 })), 'encoding');
  eq('K6 comment outranks a hint fault', classify(Object.assign({}, base, { commentIssueCount: 1, afterLine: 5 })), 'comment');
  eq('K7 hint fault still reachable', classify(Object.assign({}, base, { afterLine: 5 })), 'hintFault:afterLine:contentMiss');
  eq('K8 partial still reachable', classify(Object.assign({}, base, { partialMatchLines: 2 })), 'partialMatch');
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
