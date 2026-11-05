'use strict';
// Aggregated summary: the runner reads only the LAST 'N passed, M failed' line, so each block's line is folded into one total printed at the end.
let __p = 0, __f = 0; const __log = console.log.bind(console);
console.log = (...a) => { const m = /(\d+) passed, (\d+) failed/.exec(a.map(String).join(' ')); if (m) { __p += Number(m[1]); __f += Number(m[2]); } else __log(...a); };
// Merged 2026-11-19 from: multi-edit-plan.test.js, replace-edits.wiring.test.js.
// Each former file runs in its own block, so names and pass/fail counters stay separate. Run: node test/replace-edits.test.js

// ===== multi-edit-plan =====
{
// XW11: replace({ edits }) planner. Run: node test/multi-edit-plan.test.js
const assert = require('assert');
const { planMultiEdit, describeFailure } = require('../lib/multi-edit-plan');
let n = 0;
const t = (name, fn) => { fn(); n++; };
const run = (text, edits) => planMultiEdit({ text, edits });

t('two edits apply in order', () => {
  const r = run('a\nb\nc\n', [{ old_str: 'a', new_str: 'A' }, { old_str: 'c', new_str: 'C' }]);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.newText, 'A\nb\nC\n');
  assert.deepStrictEqual(r.applied.map(x => x.line), [1, 3]);
});
t('later edit sees the earlier result', () => {
  const r = run('x\n', [{ old_str: 'x', new_str: 'y' }, { old_str: 'y', new_str: 'z' }]);
  assert.strictEqual(r.newText, 'z\n');
});
t('part-line literal edit', () => {
  assert.strictEqual(run('foo bar\n', [{ old_str: 'bar', new_str: 'baz' }]).newText, 'foo baz\n');
});
t('ambiguous anchor fails the whole set, with its index', () => {
  const r = run('a\na\nb\n', [{ old_str: 'b', new_str: 'B' }, { old_str: 'a', new_str: 'A' }]);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.index, 1); assert.strictEqual(r.reason, 'ambiguous'); assert.strictEqual(r.count, 2);
});
t('not found fails the whole set', () => {
  const r = run('a\n', [{ old_str: 'a', new_str: 'A' }, { old_str: 'zzz', new_str: 'q' }]);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.index, 1); assert.strictEqual(r.reason, 'notFound');
});
t('LF anchor matches CRLF rows and new text is CRLF (XW1)', () => {
  const r = run('a\r\nb\r\nc\r\n', [{ old_str: 'a\nb', new_str: 'x\ny\nz' }]);
  assert.strictEqual(r.newText, 'x\r\ny\r\nz\r\nc\r\n');
});
t('CRLF anchor matches LF rows and new text is LF (XW1)', () => {
  const r = run('a\nb\nc\n', [{ old_str: 'a\r\nb', new_str: 'x\r\ny' }]);
  assert.strictEqual(r.newText, 'x\ny\nc\n');
});
t('mixed file: single-line edit inside a CRLF row keeps CRLF for added lines', () => {
  const r = run('a\nb\r\nc\n', [{ old_str: 'b', new_str: 'p\nq' }]);
  assert.strictEqual(r.newText, 'a\np\r\nq\r\nc\n');
});
t('guards', () => {
  assert.strictEqual(run('a', []).reason, 'empty');
  assert.strictEqual(run('a', [{ old_str: '', new_str: 'x' }]).reason, 'emptyOldStr');
  assert.strictEqual(run('a', [{ old_str: 'a' }]).reason, 'missingNewStr');
  assert.strictEqual(run('a', [{ old_str: 'a', new_str: 'a' }]).reason, 'identical');
});
t('delete with empty new_str', () => {
  assert.strictEqual(run('a\nb\n', [{ old_str: 'b\n', new_str: '' }]).newText, 'a\n');
});
t('failure text names the edit and says nothing was written', () => {
  const edits = [{ old_str: 'a', new_str: 'A' }, { old_str: 'zzz', new_str: 'q' }];
  const m = describeFailure(run('a\n', edits), edits);
  assert.ok(/edit 2 of 2/.test(m) && /Nothing was written/.test(m));
});
console.log(`multi-edit-plan: ${n} tests passed`);
}

// ===== replace-edits.wiring =====
{
// XW11 wiring: replace accepts edits[] and routes it to lib/multi-edit-plan.js. Run: node test/replace-edits.wiring.test.js
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
const has = (re, m) => assert.ok(re.test(src), m);
has(/edits:\s+z\.array\(z\.object\(\{ old_str: z\.string\(\), new_str: z\.string\(\) \}\)\)\.optional\(\)/, 'edits in schema');
has(/backup:\s+z\.boolean\(\)\.optional\(\)/, 'backup in schema');
has(/require\('\.\/multi-edit-plan'\)/, 'planner required');
has(/replace refused: pass either old_str\/new_str or edits, not both/, 'mixing refused');
has(/replace refused: pass old_str and new_str, or edits/, 'neither refused');
has(/pulsar-mcp-backup/, 'backup folder');
has(/edits:\[\{old_str,new_str\},\.\.\.\] instead of old_str\/new_str/, 'description');
console.log('replace-edits wiring: 7 checks passed');
}

console.log = __log; console.log(__p + ' passed, ' + __f + ' failed');
