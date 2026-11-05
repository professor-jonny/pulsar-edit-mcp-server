'use strict';
// Aggregated summary: the runner reads only the LAST 'N passed, M failed' line, so each block's line is folded into one total printed at the end.
let __p = 0, __f = 0; const __log = console.log.bind(console);
console.log = (...a) => { const m = /(\d+) passed, (\d+) failed/.exec(a.map(String).join(' ')); if (m) { __p += Number(m[1]); __f += Number(m[2]); } else __log(...a); };
// Merged 2026-11-19 from: fail-diagnostics.comment.test.js, fail-diagnostics.comment-led.test.js, fail-diagnostics.mid-line.test.js, fail-diagnostics.no-row.test.js.
// Each former file runs in its own block, so names and pass/fail counters stay separate. Run: node test/fail-diagnostics.cases.test.js

// ===== fail-diagnostics.comment =====
{
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
if (fail) process.exitCode = 1;
}

// ===== fail-diagnostics.comment-led =====
{
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
if (fail) process.exitCode = 1;
}

// ===== fail-diagnostics.mid-line =====
{
// Test for the mid-line failure wording (TODO R1h, 2026-10-17).
// Run from the package root:   node test/fail-diagnostics.mid-line.test.js
// Plain node, no Pulsar, no files written.
//
// R1h: a whole-line replace whose old_str starts or ends mid-line used to print the NOTE (R1e) underneath
// older lines that blame a typo or whitespace ("close but not identical", "exact text comparison failed",
// "Re-read lines around N ... rebuild old_str"). When the caller passes midLine, the diagnosis itself must say
// the text is there and only the whole-line match fails, and buildFailResponse must add the NOTE itself.
//
// What is pinned:
//   1. buildFailResponse({ midLine }) with a scope hint: no similarity/typo line, no "exact text comparison
//      failed", no "Re-read lines around", no PARTIAL MATCH blame; the match location IS still reported; the
//      NOTE is present once and is the last line; since R1i there is no retry nudge after it.
//   2. The same without a scope hint (the "found at ... but exact match failed" variant).
//   3. Without midLine nothing changes: every old line is still there and no NOTE.
//   4. midLine is ignored when the diagnosis already has a better explanation (text outside the scope).
//   5. The pure diagnose(): midLine changes the similarity line and the post lines only.
//   6. mcp-registration.js passes midLine to buildFailResponse.

const fs   = require('fs');
const path = require('path');
const eng  = require('../lib/match-engine');
const { diagnose } = require('../lib/fail-diagnostics');
const { midLineHint } = require('../lib/mid-line-hint');

let pass = 0, bad = 0;
function ok(label, cond, extra) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && extra !== undefined) console.log('      ' + extra);
}

const text = [
  'function alpha() {',         // row 0
  '  const total = 1;',         // row 1
  '  return total;',            // row 2
  '}',                          // row 3
  '',                           // row 4
  'function beta() {',          // row 5
  '  const count = 2;',         // row 6
  '  return count;',            // row 7
  '}',                          // row 8
].join('\n');
const buf = text.split('\n');
const mk = () => ({ consec: { count: 1 }, allLines: buf, text });
const miss = { matched: false, reason: 'notFound' };

const noScope = { searchStart: 0, searchEnd: buf.length - 1, scopeLabel: '', _hasScope: false, via: 'none', hints: {} };
const inAlpha = { searchStart: 0, searchEnd: 3, scopeLabel: ' within function "alpha"', _hasScope: true, via: 'inFunction', hints: { inFunction: 'alpha' } };

const OLD_LINES = ['close but not identical', 'exact text comparison failed', 'Re-read lines around', 'whitespace/partial match detail'];
const has  = (t, s) => t.includes(s);
const none = (t, list) => list.every(s => !t.includes(s));
const count = (t, s) => t.split(s).length - 1;

function fail(scope, needle, extra) {
  const mid = midLineHint({ needle, text, scopeStart: scope.searchStart, scopeEnd: scope.searchEnd });
  return eng.buildFailResponse(Object.assign({ tool: 'replace', ctx: mk(), match: miss, needle, isCodeFile: true, scope }, extra || {}, mid ? { midLine: mid } : {}));
}

// 1. scoped
const needleMid = 'const total = 1';
let t = fail(inAlpha, needleMid).content[0].text;
ok('1 no "close but not identical" / typo blame', none(t, OLD_LINES.slice(0, 1)), t);
ok('1 no "exact text comparison failed"', !has(t, OLD_LINES[1]), t);
ok('1 no "Re-read lines around"', !has(t, OLD_LINES[2]), t);
ok('1 no "whitespace/partial match detail"', !has(t, OLD_LINES[3]), t);
ok('1 no Similarity percentage line', !/Similarity: \d+%/.test(t), t);
ok('1 match location still reported (L2)', /MATCH LOCATION FOUND inside scope at L2/.test(t), t);
ok('1 says the text is there', /the text is there/.test(t), t);
ok('1 says it starts and ends mid-line', /starts and ends in the middle of a line/.test(t), t);
ok('1 NOTE present exactly once', count(t, 'NOTE: resend the whole call') === 1, 'count=' + count(t, 'NOTE: resend the whole call'));
ok('1 NOTE comes after the diagnosis sentence', t.indexOf('NOTE:') !== -1 && t.indexOf('NOTE:') > t.indexOf('The text itself exists'));
ok('1 R1i: no retry nudge, the NOTE is the last line', !t.includes('Retry cheaply') && t.trimEnd().split('\n').pop().startsWith('NOTE:'));
ok('1 still matched:false', fail(inAlpha, needleMid).matched === false);

// 2. unscoped
t = fail(noScope, needleMid).content[0].text;
ok('2 no "exact match failed (see whitespace" line', !/exact match failed \(see whitespace/.test(t), t);
ok('2 no "Re-read lines around the target"', !has(t, 'Re-read lines around the target'), t);
ok('2 no typo blame', !has(t, OLD_LINES[0]), t);
ok('2 location still reported (found at L2)', /found at L2/.test(t), t);
ok('2 says the text is there', /the text is there/.test(t), t);
ok('2 NOTE present exactly once, no retry nudge', count(t, 'NOTE: resend the whole call') === 1 && !t.includes('Retry cheaply'));

// 3. unchanged without midLine
const plain = eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle: needleMid, isCodeFile: true, scope: inAlpha }).content[0].text;
ok('3 old typo line still there without midLine', has(plain, OLD_LINES[0]), plain);
ok('3 old "exact text comparison failed" still there', has(plain, OLD_LINES[1]), plain);
ok('3 old "Re-read lines around" still there', has(plain, OLD_LINES[2]), plain);
ok('3 no NOTE without midLine', !has(plain, 'NOTE: resend the whole call'), plain);
const plainNo = eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle: needleMid, isCodeFile: true, scope: noScope }).content[0].text;
ok('3 unscoped: old "exact match failed" line still there', /exact match failed \(see whitespace/.test(plainNo), plainNo);
ok('3 midLine:null behaves like absent', eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle: needleMid, isCodeFile: true, scope: inAlpha, midLine: null }).content[0].text === plain);

// PARTIAL MATCH blame: first line whole, second line ends mid-line
const needleHalf = '  const total = 1;\n  return tot';
const halfPlain = eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle: needleHalf, isCodeFile: true, scope: noScope }).content[0].text;
const halfMid   = fail(noScope, needleHalf).content[0].text;
ok('3 control: without midLine this needle shows PARTIAL MATCH', has(halfPlain, 'PARTIAL MATCH'), halfPlain);
ok('1 with midLine the PARTIAL MATCH blame is gone', !has(halfMid, 'PARTIAL MATCH'), halfMid);
ok('1 that needle says it only ends mid-line', /ends in the middle of a line/.test(halfMid) && !/starts in the middle of a line/.test(halfMid), halfMid);

// 4. midLine does not override a better explanation: text exists only outside the scope
const outside = eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle: 'const count = 2', isCodeFile: true, scope: inAlpha, midLine: { startsMid: true, endsMid: true } }).content[0].text;
ok('4 text outside the scope still says FOUND OUTSIDE SCOPE', has(outside, 'FOUND OUTSIDE SCOPE'), outside);
ok('4 and keeps the exists-exactly sentence', has(outside, 'The text itself exists exactly'), outside);
ok('4 and never says "the text is there"', !has(outside, 'the text is there'), outside);

// 5. pure diagnose()
const dscope = { diagStart: 0, diagEnd: null, hasScope: false, scanStart: -1, scanEnd: -1, label: '' };
const dPlain = diagnose({ needle: needleMid, allLines: buf, scope: dscope, hints: {}, hintRadius: 25 });
const dMid   = diagnose({ needle: needleMid, allLines: buf, scope: dscope, hints: {}, hintRadius: 25, midLine: { startsMid: true, endsMid: true } });
ok('5 plain diagnose: typo line present', dPlain.messagesPre.join('').includes(OLD_LINES[0]));
ok('5 midLine diagnose: typo line gone from messagesPre', !dMid.messagesPre.join('').includes(OLD_LINES[0]));
ok('5 midLine diagnose: says the text exists in the file (pre)', /The text itself exists in the file/.test(dMid.messagesPre.join('')));
ok('5 midLine diagnose: post says found at L2', /found at L2/.test(dMid.messagesPost.join('')));
ok('5 midLine diagnose: post has no re-read advice', !/Re-read lines around/.test(dMid.messagesPost.join('')));
ok('5 both runs agree on the reason, scan and stats inputs', dPlain.reason === dMid.reason && dPlain.foundOutsideScope === dMid.foundOutsideScope && dPlain.partialMatchLines === dMid.partialMatchLines && dPlain.similarity === dMid.similarity);

// 6. wiring
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
const at = src.indexOf("matchContentEngine(old_str, { allLines, text: ctx.text }, scope, { fuzzyWhitespace, fuzzyContent, occurrence })");
const seg = at === -1 ? '' : src.slice(at, at + 3600);
ok('6 replace whole-line failure path found', at !== -1);
ok('6 passes midLine to buildFailResponse', /midLine:\s*_midLine/.test(seg), seg.slice(0, 200));
ok('6 no longer builds the advice itself (engine owns the wording)', !/midLineAdvice/.test(seg));

console.log(pass + ' passed, ' + bad + ' failed');
if (bad) process.exitCode = 1;
}

// ===== fail-diagnostics.no-row =====
{
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
if (fail) process.exitCode = 1;
}

console.log = __log; console.log(__p + ' passed, ' + __f + ' failed');
