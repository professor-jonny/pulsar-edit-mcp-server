'use strict';
// Aggregated summary: the runner reads only the LAST 'N passed, M failed' line, so each block's line is folded into one total printed at the end.
let __p = 0, __f = 0; const __log = console.log.bind(console);
console.log = (...a) => { const m = /(\d+) passed, (\d+) failed/.exec(a.map(String).join(' ')); if (m) { __p += Number(m[1]); __f += Number(m[2]); } else __log(...a); };
// Merged 2026-11-19 from: lint-helpers.cap.test.js, lint-helpers.scope.test.js, sed.lint-scope.test.js, replace-all-apply-patch.lint-scope.test.js.
// Each former file runs in its own block, so names and pass/fail counters stay separate. Run: node test/lint-scope.test.js

// ===== lint-helpers.cap =====
{
// 2026-11-19 (XW23): the per-message lint detail is capped. At most LINT_MAX_MESSAGES messages (errors first), each excerpt at most
// LINT_MAX_EXCERPT characters on one line, and a tail that says how many were left out and where to see them.
// Run: node test/lint-helpers.cap.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const lh = require('../lib/lint-helpers');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); } }
const msg = (row, severity, excerpt) => ({ severity, excerpt, range: { start: { row } } });
const many = (n, sev = 'warning') => Array.from({ length: n }, (_, i) => msg(i, sev, 'problem number ' + i));
const fmt = (m, o) => { assert.strictEqual(typeof lh.formatLintDetail, 'function', 'formatLintDetail is not exported'); return lh.formatLintDetail(m, o); };

t('a few messages are all shown, no tail', () => {
  const s = fmt(many(3));
  assert.ok(/lint \(3 warnings\):/.test(s) && /\[L1\]/.test(s) && /\[L3\]/.test(s) && !/more/.test(s), s);
});
t('exactly the limit is shown in full', () => {
  const s = fmt(many(5));
  assert.ok(/\[L5\]/.test(s) && !/more/.test(s), s);
});
t('over the limit: only 5 shown, the headline keeps the true total, the tail says how many were left out', () => {
  const s = fmt(many(12));
  assert.ok(/lint \(12 warnings\):/.test(s), s);
  assert.ok(/\[L5\]/.test(s) && !/\[L6\]/.test(s), s);
  assert.ok(/\+7 more/.test(s) && /get-diagnostics/.test(s), s);
});
t('errors come before warnings inside the cap', () => {
  const m = many(8).concat([msg(40, 'error', 'real error')]);
  const s = fmt(m);
  assert.ok(/\[L41\] error/.test(s), 'the late error was cut: ' + s);
  assert.ok(s.indexOf('[L41]') < s.indexOf('[L1]'), s);
});
t('a long excerpt is cut to the limit with an ellipsis', () => {
  const s = fmt([msg(0, 'warning', 'x'.repeat(400))]);
  const ex = s.split('— ')[1];
  assert.ok(ex.length <= 140, 'excerpt is ' + ex.length);
  assert.ok(ex.endsWith('…'), ex.slice(-5));
});
t('a multi-line excerpt is joined onto one line', () => {
  const s = fmt([msg(0, 'warning', 'first line\n   second   line')]);
  assert.ok(/first line second line/.test(s), s);
});
t('the limits can be overridden', () => {
  const s = fmt(many(6), { maxMessages: 2, maxExcerpt: 10 });
  assert.ok(/\[L2\]/.test(s) && !/\[L3\]/.test(s) && /\+4 more/.test(s), s);
});
t('the headline counts errors and warnings separately', () => {
  const m = many(10).concat([msg(20, 'error', 'e1'), msg(21, 'error', 'e2')]);
  assert.ok(/lint \(2 errors, 10 warnings\):/.test(fmt(m)), fmt(m));
  assert.ok(/lint \(1 error\):/.test(fmt([msg(0, 'error', 'e')])), 'singular error');
  assert.ok(/lint \(1 warning\):/.test(fmt([msg(0, 'warning', 'w')])), 'singular warning');
});
t('lintCountLabel is exported and drives the count-only line too', () => {
  assert.strictEqual(typeof lh.lintCountLabel, 'function');
  assert.strictEqual(lh.lintCountLabel([msg(0, 'error', 'a'), msg(1, 'warning', 'b'), msg(2, 'warning', 'c')]), '1 error, 2 warnings');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'lint-helpers.js'), 'utf8');
  assert.ok(/lint \(\$\{lintCountLabel\(msgs\)\}\) /.test(src), 'count-only line does not use lintCountLabel');
});
t('lintSnapshot uses it for the detail and keeps the count-only branch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'lint-helpers.js'), 'utf8');
  assert.ok(/return formatLintDetail\(msgs\)/.test(src), 'lintSnapshot does not call formatLintDetail');
  assert.ok(/opts\.countOnly/.test(src));
  assert.ok(!/parts\.join\(" \| "\)/.test(src), 'the uncapped join is still there');
});
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
}

// ===== lint-helpers.scope =====
{
// XW23 lint scoping (2026-11-18): filterLintMessages is the pure filter behind lintSnapshot.
// Pure-function test: no Pulsar, no linter.   Run: node test/lint-helpers.scope.test.js
//   1. No range: every error and warning is kept, info is dropped (unchanged behaviour).
//   2. startRow/endRow: padded by 5 rows each side by default (unchanged behaviour); file-level messages always kept.
//   3. NEW opts.rows (0-based changed rows, for sed / replace-all / apply-patch): only messages within opts.pad of one of
//      those rows (pad defaults to 0 in rows mode); an empty list keeps only file-level messages.
const assert = require('assert');
const { filterLintMessages } = require('../lib/lint-helpers');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}
const m = (row, severity = 'warning') => ({ severity, excerpt: 'x' + row, range: { start: { row } } });
const rowsOf = (list) => list.map((x) => x.range ? x.range.start.row : 'file');

t('1 no range keeps errors and warnings, drops info', () => {
  const r = filterLintMessages([m(1), m(2, 'error'), m(3, 'info')], null, null, {});
  assert.deepStrictEqual(rowsOf(r), [1, 2]);
});
t('2 default pad is 5 rows each side of startRow..endRow', () => {
  const r = filterLintMessages([m(4), m(5), m(10), m(15), m(16)], 10, 10, {});
  assert.deepStrictEqual(rowsOf(r), [5, 10, 15]);
});
t('2 a message with no range is always kept', () => {
  const r = filterLintMessages([{ severity: 'error', excerpt: 'file level', range: null }, m(500)], 10, 10, {});
  assert.deepStrictEqual(rowsOf(r), ['file']);
});
t('3 rows mode: only the changed rows (pad 0)', () => {
  const r = filterLintMessages([m(2), m(3), m(4), m(49), m(50), m(51)], null, null, { rows: [3, 50] });
  assert.deepStrictEqual(rowsOf(r), [3, 50]);
});
t('3 rows mode: pad option widens the match', () => {
  const r = filterLintMessages([m(1), m(2), m(3), m(4), m(5)], null, null, { rows: [3], pad: 1 });
  assert.deepStrictEqual(rowsOf(r), [2, 3, 4]);
});
t('3 rows mode: warnings far from any changed row are dropped (the whole-file noise case)', () => {
  const many = []; for (let i = 0; i < 40; i++) many.push(m(i * 10));
  const r = filterLintMessages(many, null, null, { rows: [100] });
  assert.deepStrictEqual(rowsOf(r), [100]);
});
t('3 rows mode: empty list keeps only file-level messages', () => {
  const r = filterLintMessages([{ severity: 'error', excerpt: 'f', range: null }, m(1)], null, null, { rows: [] });
  assert.deepStrictEqual(rowsOf(r), ['file']);
});
t('3 rows mode wins over startRow/endRow when both are given', () => {
  const r = filterLintMessages([m(0), m(7)], 0, 100, { rows: [7] });
  assert.deepStrictEqual(rowsOf(r), [7]);
});
t('3 negative control: without rows the same far warning IS kept', () => {
  const r = filterLintMessages([m(0), m(7)], null, null, {});
  assert.deepStrictEqual(rowsOf(r), [0, 7]);
});

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
}

// ===== sed.lint-scope =====
{
// test/sed.lint-scope.test.js - XW23 lint scoping (2026-11-18).
// sed used to lint the WHOLE file (maybeLintSuffix(lint, editor, null, null)), so every unrelated warning in a big
// file came back with each sed edit. It now passes the changed rows (from diffLines) to lintSnapshot.
// Source check (the handler needs a live editor).
const fs = require('fs');
const path = require('path');
const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');

let bad = 0, pass = 0;
function ok(name, cond) { if (cond) pass++; else { bad++; console.log('FAIL ' + name); } }

const m = /name:\s*'sed',/.exec(reg);
ok('found the sed registration', !!m);
const next = reg.indexOf('registerMcpTool({', m.index + 20);
const body = reg.slice(m.index, next < 0 ? reg.length : next);

ok('sed imports diffLines (aliased: the name diffLines is taken in this file)', /diffLines:\s*_sedDiffLines\s*\}\s*=\s*require\('\.\/sed-tool'\)/.test(reg));
ok('sed does not lint the whole file any more', !/maybeLintSuffix\(lint, editor, null, null\)/.test(body));
ok('sed passes the changed rows to lint', /maybeLintSuffix\(lint, editor, null, null, \{[^}]*\brows\b/.test(body));
ok('sed computes the rows with diffLines', /_sedDiffLines\(/.test(body));
// negative control: the whole-file call is what the check above must reject
ok('negative control (old call shape is detected)', /maybeLintSuffix\(lint, editor, null, null\)/.test('x = await maybeLintSuffix(lint, editor, null, null);'));

console.log(pass + ' passed, ' + bad + ' failed');
if (bad) process.exitCode = 1;
}

// ===== replace-all-apply-patch.lint-scope =====
{
// test/replace-all-apply-patch.lint-scope.test.js - XW23 lint scoping (2026-11-18).
// replace-all and apply-patch (both of its commit paths) used to lint the WHOLE file. They now pass the changed rows.
// Source check (the handlers need a live editor), plus a behaviour check of the _changedRows helper copied from the source.
const fs = require('fs');
const path = require('path');
const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
const { diffLines } = require('../lib/sed-tool');

let bad = 0, pass = 0;
function ok(name, cond) { if (cond) pass++; else { bad++; console.log('FAIL ' + name); } }

function body(name) {
  const m = new RegExp("name:\\s*'" + name + "',").exec(reg);
  if (!m) return '';
  const next = reg.indexOf('registerMcpTool({', m.index + 20);
  return reg.slice(m.index, next < 0 ? reg.length : next);
}

ok('no maybeLintSuffix(..., null, null) whole-file call is left in the edit tools', !/maybeLintSuffix\(lint, [a-zA-Z.]*[eE]ditor, null, null\)/.test(reg));
const ra = body('replace-all');
ok('replace-all passes the changed rows', /maybeLintSuffix\(lint, ctx\.editor, null, null, \{ rows: _changedRows\(ctx\.text, newText\)/.test(ra));
const ap = body('apply-patch');
ok('apply-patch main path passes the changed rows', /rows: _changedRows\(beforeText, result\)/.test(ap));
ok('apply-patch rescue path passes the rescued rows', /rows: _lintRows/.test(ap));
ok('_changedRows is defined once, on top of the aliased diffLines', (reg.match(/const _changedRows = /g) || []).length === 1 && /_sedDiffLines\(before\.split/.test(reg));
// negative control for the whole-file detector
ok('negative control (detector sees the old call)', /maybeLintSuffix\(lint, [a-zA-Z.]*[eE]ditor, null, null\)/.test('await maybeLintSuffix(lint, ctx.editor, null, null);'));

// helper behaviour (same body as the source helper)
const _changedRows = (before, after) => {
  const d = diffLines(before.split('\n'), after.split('\n'));
  return d.added.map(a => a.row - 1).concat(d.removed.map(r => Math.max(0, r.row - 1)));
};
const a = ['a', 'b', 'c', 'd', 'e'].join('\n');
ok('helper: one changed line -> that 0-based row twice (added and removed)', JSON.stringify(_changedRows(a, a.replace('c', 'C'))) === '[2,2]');
ok('helper: two far changes -> only those rows', JSON.stringify(_changedRows(a, a.replace('a', 'A').replace('e', 'E'))) === '[0,4,0,4]');
ok('helper: deletion -> its row', JSON.stringify(_changedRows(a, ['a', 'b', 'd', 'e'].join('\n'))) === '[2]');
ok('helper: identical text -> no rows', _changedRows(a, a).length === 0);

console.log(pass + ' passed, ' + bad + ' failed');
if (bad) process.exitCode = 1;
}

console.log = __log; console.log(__p + ' passed, ' + __f + ' failed');
