'use strict';
// Aggregated summary: the runner reads only the LAST 'N passed, M failed' line, so each block's line is folded into one total printed at the end.
let __p = 0, __f = 0; const __log = console.log.bind(console);
console.log = (...a) => { const m = /(\d+) passed, (\d+) failed/.exec(a.map(String).join(' ')); if (m) { __p += Number(m[1]); __f += Number(m[2]); } else __log(...a); };
// Merged 2026-11-19 from: apply-patch.fail-count.test.js, patch-fix-hunk-headers.test.js, patch-rescue.test.js.
// Each former file runs in its own block, so names and pass/fail counters stay separate. Run: node test/apply-patch.test.js

// ===== apply-patch.fail-count =====
{
// R3n (2026-11-08): a failed apply-patch must be counted ONCE in the stats headline.
//
// Bug: when diff's applyPatch() THREW (malformed hunk, bad header), the handler bumped fails.exception in the
// catch block, set result = false, and then the shared 'result === false' branch bumped fails.contextMismatch for
// the same failure. apply_patch has no parallelDiag, so its headline is the plain sum of its fail keys and every
// patch that threw counted twice (lifetime: contextMismatch 25 and exception 25, failTotal 50 for 25 failures).
//
// Fix: bumpApplyPatchFailure(threw) in lib/edit-stats.js bumps ONE key per failed patch: exception when
// applyPatch threw, contextMismatch when it returned false. The two keys now partition the failures.
// The handler (lib/mcp-registration.js) no longer bumps in the catch block and calls the helper once.
//
// Run from the package root:   node test/apply-patch.fail-count.test.js
// Plain Node, no Pulsar needed (SESSION_DIR / STATS_PATH are null outside Pulsar).

const assert = require('assert');
const { applyPatch } = require('diff');
const stats = require('../lib/edit-stats');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

function snap() {
  const f = stats.editStats.apply_patch.fails;
  return { faults: stats.summarise(stats.editStats).editFaults, cm: f.contextMismatch, ex: f.exception };
}

// Mirrors the handler's try / catch / 'result === false' sequence with the REAL applyPatch.
function runLikeHandler(text, patch) {
  let result, threw = false;
  try { result = applyPatch(text, patch); } catch (e) { result = false; threw = true; }
  if (result === false) stats.bumpApplyPatchFailure(threw);
  return { result, threw };
}

const TEXT = 'alpha\nbeta\ngamma\n';
// Well-formed patch whose context does not exist in TEXT: applyPatch returns false.
const MISMATCH = '--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n';
// Hunk body with a line that has no valid sigil: the parser throws (the case that used to count twice).
const MALFORMED = '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\nthis line has no sigil\n beta\n';

check('bumpApplyPatchFailure is exported', () => {
  assert.strictEqual(typeof stats.bumpApplyPatchFailure, 'function');
});

check('stats are not persisted by this test (STATS_PATH is null)', () => {
  assert.strictEqual(stats.STATS_PATH, null);
});

check('apply_patch fails block has both keys', () => {
  assert.strictEqual(typeof stats.editStats.apply_patch.fails.contextMismatch, 'number');
  assert.strictEqual(typeof stats.editStats.apply_patch.fails.exception, 'number');
});

check('threw = true: ONE fault, in exception only', () => {
  const a = snap();
  stats.bumpApplyPatchFailure(true);
  const b = snap();
  assert.strictEqual(b.faults - a.faults, 1, 'headline moved by ' + (b.faults - a.faults));
  assert.strictEqual(b.ex - a.ex, 1);
  assert.strictEqual(b.cm - a.cm, 0);
});

check('threw = false: ONE fault, in contextMismatch only', () => {
  const a = snap();
  stats.bumpApplyPatchFailure(false);
  const b = snap();
  assert.strictEqual(b.faults - a.faults, 1, 'headline moved by ' + (b.faults - a.faults));
  assert.strictEqual(b.cm - a.cm, 1);
  assert.strictEqual(b.ex - a.ex, 0);
});

check('real diff: a context mismatch counts ONE fault', () => {
  const a = snap();
  const r = runLikeHandler(TEXT, MISMATCH);
  const b = snap();
  assert.strictEqual(r.result, false, 'expected applyPatch to return false');
  assert.strictEqual(r.threw, false, 'expected a plain mismatch, not an exception');
  assert.strictEqual(b.faults - a.faults, 1);
  assert.strictEqual(b.cm - a.cm, 1);
  assert.strictEqual(b.ex - a.ex, 0);
});

check('real diff: a malformed patch counts ONE fault (the old double count)', () => {
  const a = snap();
  const r = runLikeHandler(TEXT, MALFORMED);
  const b = snap();
  assert.strictEqual(r.result, false, 'expected a failed patch');
  assert.strictEqual(b.faults - a.faults, 1, 'headline moved by ' + (b.faults - a.faults) + (r.threw ? ' (it threw)' : ' (it did not throw)'));
  // whichever way the installed diff version reports it, exactly one key moved
  assert.strictEqual((b.cm - a.cm) + (b.ex - a.ex), 1);
  if (r.threw) { assert.strictEqual(b.ex - a.ex, 1); assert.strictEqual(b.cm - a.cm, 0); }
});

check('four failures in a row (two thrown, two not) move the headline by exactly four', () => {
  const a = snap();
  stats.bumpApplyPatchFailure(true);
  stats.bumpApplyPatchFailure(false);
  stats.bumpApplyPatchFailure(true);
  stats.bumpApplyPatchFailure(false);
  const b = snap();
  assert.strictEqual(b.faults - a.faults, 4);
  assert.strictEqual(b.ex - a.ex, 2);
  assert.strictEqual(b.cm - a.cm, 2);
});

check('the two keys partition the failures: their sum equals the headline for apply_patch', () => {
  const f = stats.editStats.apply_patch.fails;
  const other = stats.summarise(stats.editStats).editFaults; // all edit tools together
  assert.ok(other >= f.contextMismatch + f.exception);
  const a = snap();
  runLikeHandler(TEXT, MISMATCH);
  runLikeHandler(TEXT, MALFORMED);
  const b = snap();
  assert.strictEqual((b.cm - a.cm) + (b.ex - a.ex), b.faults - a.faults);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
}

// ===== patch-fix-hunk-headers =====
{
// R3o (2026-11-08): the apply-patch header auto-correction must work for hunks with MORE THAN ONE body line.
//
// Bug: fixHunkHeaders (then a closure inside the apply-patch handler) ended the lazy hunk body with the dollar
// anchor while the regex had the m flag, so the anchor matched at the end of EVERY line: the body it saw was only the
// first line, and the new @@ counts were computed from that one line. A 3-line hunk with one change got the header
// -1,1 +1,1 and diff's applyPatch() threw 'Unknown line 5'. So no multi-line hunk ever applied directly (lifetime:
// apply_patch hits 0, every failure an exception); only the fuzzy rescue ever committed.
//
// Fix: fixHunkHeaders moved to lib/patch-utils.js (so it can be tested) and the body now ends at the next hunk, the
// next file header or the END OF INPUT: (?![\s\S]). It also leaves the 'no newline at end of file' marker out of the counts.
//
// Run from the package root:   node test/patch-fix-hunk-headers.test.js
// Plain Node, no Pulsar needed.

const assert = require('assert');
const { applyPatch } = require('diff');
const { fixHunkHeaders } = require('../lib/patch-utils');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const hdrs = (p) => p.split('\n').filter((l) => l.startsWith('@@'));
const HEAD = '--- a/f.txt\n+++ b/f.txt\n';
const TEXT = 'x1\nx2\nx3\nx4\nx5\nx6\nx7\nx8\n';

check('fixHunkHeaders is exported', () => {
  assert.strictEqual(typeof fixHunkHeaders, 'function');
});

check('the bug case: a 3-line hunk with one change keeps counts 3 and 3 and APPLIES', () => {
  const p = HEAD + '@@ -1,3 +1,3 @@\n x1\n-x2\n+Y\n x3\n';
  const f = fixHunkHeaders(p);
  assert.deepStrictEqual(hdrs(f), ['@@ -1,3 +1,3 @@']);
  assert.strictEqual(applyPatch(TEXT, f), 'x1\nY\nx3\nx4\nx5\nx6\nx7\nx8\n');
});

check('wrong counts from the caller are corrected (the purpose of the function) and the patch applies', () => {
  const p = HEAD + '@@ -1,99 +1,7 @@\n x1\n-x2\n+Y\n x3\n';
  const f = fixHunkHeaders(p);
  assert.deepStrictEqual(hdrs(f), ['@@ -1,3 +1,3 @@']);
  assert.strictEqual(applyPatch(TEXT, f), 'x1\nY\nx3\nx4\nx5\nx6\nx7\nx8\n');
});

check('pure add (two added lines between context): old 2, new 4, applies', () => {
  const p = HEAD + '@@ -2,0 +2,0 @@\n x2\n+A\n+B\n x3\n';
  const f = fixHunkHeaders(p);
  assert.deepStrictEqual(hdrs(f), ['@@ -2,2 +2,4 @@']);
  assert.strictEqual(applyPatch(TEXT, f), 'x1\nx2\nA\nB\nx3\nx4\nx5\nx6\nx7\nx8\n');
});

check('pure delete (two removed lines between context): old 4, new 2, applies', () => {
  const p = HEAD + '@@ -4,0 +4,0 @@\n x4\n-x5\n-x6\n x7\n';
  const f = fixHunkHeaders(p);
  assert.deepStrictEqual(hdrs(f), ['@@ -4,4 +4,2 @@']);
  assert.strictEqual(applyPatch(TEXT, f), 'x1\nx2\nx3\nx4\nx7\nx8\n');
});

check('two hunks in one patch are corrected independently and both apply', () => {
  const p = HEAD + '@@ -1,1 +1,1 @@\n x1\n-x2\n+Y\n x3\n@@ -6,1 +6,1 @@\n x6\n-x7\n+Z\n x8\n';
  const f = fixHunkHeaders(p);
  assert.deepStrictEqual(hdrs(f), ['@@ -1,3 +1,3 @@', '@@ -6,3 +6,3 @@']);
  assert.strictEqual(applyPatch(TEXT, f), 'x1\nY\nx3\nx4\nx5\nx6\nZ\nx8\n');
});

check('a hunk whose body is ONE line still works (old behaviour kept)', () => {
  const f = fixHunkHeaders(HEAD + '@@ -2,1 +2,1 @@\n-x2\n');
  assert.deepStrictEqual(hdrs(f), ['@@ -2,1 +2,0 @@']);
});

check('"\\ No newline at end of file" lines are not counted as old or new lines', () => {
  const p = HEAD + '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n';
  const f = fixHunkHeaders(p);
  assert.deepStrictEqual(hdrs(f), ['@@ -1,2 +1,2 @@']);
  assert.strictEqual(applyPatch('a\nb', f), 'a\nB');
});

check('every body line survives: only the @@ lines change', () => {
  const p = HEAD + '@@ -1,1 +1,1 @@\n x1\n-x2\n+Y\n x3\n@@ -6,1 +6,1 @@\n x6\n-x7\n+Z\n x8\n';
  const f = fixHunkHeaders(p);
  const strip = (s) => s.split('\n').filter((l) => !l.startsWith('@@')).join('\n');
  assert.strictEqual(strip(f), strip(p));
});

check('it is idempotent', () => {
  const p = HEAD + '@@ -1,99 +1,7 @@\n x1\n-x2\n+Y\n x3\n';
  assert.strictEqual(fixHunkHeaders(fixHunkHeaders(p)), fixHunkHeaders(p));
});

check('text without hunks is returned unchanged', () => {
  assert.strictEqual(fixHunkHeaders(HEAD), HEAD);
  assert.strictEqual(fixHunkHeaders(''), '');
});

check('a patch that really does not match still makes applyPatch return false, not throw', () => {
  const p = HEAD + '@@ -1,3 +1,3 @@\n no such one\n-no such two\n+changed\n no such three\n';
  const f = fixHunkHeaders(p);
  assert.strictEqual(applyPatch(TEXT, f), false);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
}

// ===== patch-rescue =====
{
// apply-patch rescue helpers. Run: node test/patch-rescue.test.js
const assert = require('assert');
const { parseHunkOps, planRescueHunk, previewHunk, rescueStillValid } = require('../lib/patch-rescue');
let n = 0; const t = (name, fn) => { fn(); n++; };
const apply = (buf, plan) => { const o = buf.slice(); o.splice(plan.startRow, plan.oldLen, ...plan.newBlock); return o; };

t('parse: sigils, blank context, no-newline marker', () => {
  const ops = parseHunkOps([' a', '-b', '+B', '', '\\ No newline at end of file']);
  assert.deepStrictEqual(ops, [{ k: ' ', text: 'a' }, { k: '-', text: 'b' }, { k: '+', text: 'B' }, { k: ' ', text: '' }]);
});
t('replace line, indent re-applied from the buffer (was dropped before)', () => {
  const buf = ['a', '    b', '    c', 'd'];
  const ops = parseHunkOps([' a', '   b', '-  c', '+  C', ' d']);
  const p = planRescueHunk(ops, buf, 0);
  assert.strictEqual(p.ok, true);
  assert.deepStrictEqual(apply(buf, p), ['a', '    b', '    C', 'd']);
});
t('indent delta from a shifted block', () => {
  const buf = ['    x', '    y', 'z'];
  const p = planRescueHunk(parseHunkOps(['   x', '+  new', '   y']), buf, 0);
  assert.deepStrictEqual(apply(buf, p), ['    x', '    new', '    y', 'z']);
  assert.strictEqual(p.indentDelta, 2); // patch line '   x' is sigil + 2 spaces; the buffer has 4
});
t('add-only hunk lands after its preceding context, not before (was a bug)', () => {
  const buf = ['one', 'two', 'three'];
  const p = planRescueHunk(parseHunkOps([' one', '+1a', ' two']), buf, 0);
  assert.deepStrictEqual(apply(buf, p), ['one', '1a', 'two', 'three']);
});
t('hunk starting with a blank context line: start row is derived from the first non-empty line', () => {
  const buf = ['p', '', 'q', 'r'];
  const p = planRescueHunk(parseHunkOps([' ', ' q', '-r', '+R']), buf, 2);
  assert.strictEqual(p.startRow, 1);
  assert.deepStrictEqual(apply(buf, p), ['p', '', 'q', 'R']);
});
t('pure delete', () => {
  const buf = ['a', 'b', 'c'];
  const p = planRescueHunk(parseHunkOps([' a', '-b', ' c']), buf, 0);
  assert.deepStrictEqual(apply(buf, p), ['a', 'c']);
});
t('a mismatch inside the block is refused, not guessed', () => {
  const p = planRescueHunk(parseHunkOps([' a', '-b', ' zzz']), ['a', 'b', 'c'], 0);
  assert.strictEqual(p.ok, false); assert.strictEqual(p.reason, 'mismatch'); assert.strictEqual(p.at, 2);
});
t('tab-indented buffer, space-indented patch', () => {
  const buf = ['\tx', '\ty'];
  const p = planRescueHunk(parseHunkOps([' x', '+new', ' y']), buf, 0);
  assert.deepStrictEqual(apply(buf, p), ['\tx', '\tnew', '\ty']);
});
t('preview is in patch order', () => {
  const buf = ['one', 'two', 'three'];
  const ops = parseHunkOps([' one', '-two', '+TWO', ' three']);
  const lines = previewHunk(ops, buf, planRescueHunk(ops, buf, 0));
  assert.deepStrictEqual(lines.map(l => l.trim()), ['1   one', '2 - two', '+ TWO', '3   three']);
});
t('rescueStillValid detects a changed file', () => {
  const plan = { startRow: 0, oldLen: 2, oldTrimmed: ['a', 'b'] };
  assert.strictEqual(rescueStillValid(plan, ['a', 'b', 'c']), true);
  assert.strictEqual(rescueStillValid(plan, ['a', 'X', 'c']), false);
});
console.log(`patch-rescue: ${n} tests passed`);

// the confirm path must call the real TextBuffer method (setTextInBufferRange does not exist; it threw at confirm time)
const _src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
assert.ok(!/setTextInBufferRange/.test(_src) && /buffer\.setTextInRange\(\[\[s0, 0\]/.test(_src));
console.log('patch-rescue: confirm uses setTextInRange');

// minimal changed span: untouched context rows are not rewritten (keeps their CR/LF in mixed files)
{
  const buf = ['one', 'two', 'three', 'four'];
  const p = planRescueHunk(parseHunkOps([' one', '-two', '+TWO', ' three', ' four']), buf, 0);
  assert.strictEqual(p.editStart, 1); assert.strictEqual(p.editOldLen, 1); assert.deepStrictEqual(p.editNew, ['TWO']);
  const q = planRescueHunk(parseHunkOps([' one', '+1a', ' two']), buf, 0);
  assert.strictEqual(q.editStart, 1); assert.strictEqual(q.editOldLen, 0); assert.deepStrictEqual(q.editNew, ['1a']);
  const d = planRescueHunk(parseHunkOps([' one', '-two', ' three']), buf, 0);
  assert.strictEqual(d.editOldLen, 1); assert.deepStrictEqual(d.editNew, []);
  console.log('patch-rescue: minimal span ok');
}
}

console.log = __log; console.log(__p + ' passed, ' + __f + ' failed');
