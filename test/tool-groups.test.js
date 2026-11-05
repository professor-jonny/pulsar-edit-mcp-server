'use strict';
// Aggregated summary: the runner reads only the LAST 'N passed, M failed' line, so each block's line is folded into one total printed at the end.
let __p = 0, __f = 0; const __log = console.log.bind(console);
console.log = (...a) => { const m = /(\d+) passed, (\d+) failed/.exec(a.map(String).join(' ')); if (m) { __p += Number(m[1]); __f += Number(m[2]); } else __log(...a); };
// Merged 2026-11-19 from: tool-catalogue.groups.test.js, tool-groups.defaults.test.js.
// Each former file runs in its own block, so names and pass/fail counters stay separate. Run: node test/tool-groups.test.js

// ===== tool-catalogue.groups =====
{
// Source-check test (2026-11-13): the group a tool is REGISTERED with (lib/mcp-registration.js `name:` + `group:` pair) must equal the
// group the tool CATALOGUE gives it (lib/tool-catalogue.js, which is what list-tools and enable-group use). They drifted:
// replace-function-body was registered 'edit' but catalogued 'fileOps', so list-tools showed it under the wrong group.
// Run from the package root:   node test/tool-catalogue.groups.test.js      Plain node, no Pulsar, no files written.

const fs = require('fs');
const path = require('path');

let bad = 0, pass = 0;
function ok(label, cond, detail) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && detail !== undefined) console.log('      ' + detail);
}

const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
const { TOOL_CATALOGUE } = require(path.join(__dirname, '..', 'lib', 'tool-catalogue.js'));

// name: '...' immediately followed (same or next line) by group: '...'
const registered = {};
const re = /name:\s*'([a-zA-Z0-9_-]+)',\s*\n?\s*group:\s*'([a-zA-Z]+)'/g;
let m;
while ((m = re.exec(reg)) !== null) registered[m[1]] = m[2];

const catalogued = {};
for (const t of TOOL_CATALOGUE) catalogued[t.name] = t.group;

ok('parsed registered tools', Object.keys(registered).length > 40, String(Object.keys(registered).length));
ok('parsed the catalogue', Object.keys(catalogued).length > 40, String(Object.keys(catalogued).length));

// Only the EDIT group is compared: the catalogue deliberately moves some tools registered 'navigation' or 'fileOps' into the always-on
// 'core' group and the 'safety' group, so a full comparison would flag those on purpose. A tool that is edit on EITHER side must be edit on both.
const both = Object.keys(registered).filter(n => n in catalogued && (registered[n] === 'edit' || catalogued[n] === 'edit'));
const mismatches = both.filter(n => registered[n] !== catalogued[n]);
ok('every tool that is edit on either side is edit on both (' + both.length + ' compared)', mismatches.length === 0,
  mismatches.map(n => n + ': registered ' + registered[n] + ' / catalogue ' + catalogued[n]).join('; '));

// the replace family and the other edit tools
for (const n of ['replace', 'replace-function-body', 'replace-all', 'write-file', 'insert', 'delete', 'sed', 'apply-patch']) {
  ok(n + ' is in the edit group in the catalogue', catalogued[n] === 'edit', String(catalogued[n]));
}
ok('replace-across-files stays in fileOps (it works across the project)', catalogued['replace-across-files'] === 'fileOps', String(catalogued['replace-across-files']));

console.log(pass + ' passed, ' + bad + ' failed');
if (bad) process.exitCode = 1;
}

// ===== tool-groups.defaults =====
{
// 2026-11-19 (XW23): finer tool groups, some off by default, so the served tool list is smaller.
//   core         always on (now also get-edit-stats, get-failure-log, session-notes: the feedback tools)
//   diagnostics  get-diagnostics, get-compiler-diagnostics, check-struct
//   kernelChecks checkpatch, namingcheck, check-function-docs        (default OFF)
//   checkpoints  checkpoint, restore-checkpoint, list-checkpoints, diff-preview   (default OFF)
//   fileAdmin    move-file, copy-file, create-folder, rename-folder, get-includes-and-defines  (default OFF)
//   debugging    get-debug-log only                                   (default OFF)
//   ghidra       default OFF
// The registration gates each tool by its CATALOGUE group (server.registerTool), skips a tool that is already registered
// (enable-group runs the registration again) and enable-group now re-runs it with the saved group settings.
// Run: node test/tool-groups.defaults.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const rd = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const { TOOL_CATALOGUE, TOGGLEABLE_GROUPS } = require('../lib/tool-catalogue');
const pkg = JSON.parse(rd('package.json'));
const reg = rd('lib', 'mcp-registration.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}
const grp = (n) => (TOOL_CATALOGUE.find(x => x.name === n) || {}).group;

const EXPECT = {
  core: ['get-edit-stats', 'get-failure-log', 'session-notes'],
  diagnostics: ['get-diagnostics', 'get-compiler-diagnostics', 'check-struct'],
  kernelChecks: ['checkpatch', 'namingcheck', 'check-function-docs'],
  checkpoints: ['checkpoint', 'restore-checkpoint', 'list-checkpoints', 'diff-preview'],
  fileAdmin: ['move-file', 'copy-file', 'create-folder', 'rename-folder', 'get-includes-and-defines'],
  debugging: ['get-debug-log'],
  safety: ['undo', 'redo'],
};
for (const g of Object.keys(EXPECT)) {
  t('catalogue: ' + g + ' = ' + EXPECT[g].join(', '), () => {
    for (const n of EXPECT[g]) assert.strictEqual(grp(n), g, n + ' is in ' + grp(n));
  });
}
t('debugging holds nothing but get-debug-log', () => {
  assert.deepStrictEqual(TOOL_CATALOGUE.filter(x => x.group === 'debugging').map(x => x.name), ['get-debug-log']);
});
t('every non-core catalogue group is toggleable', () => {
  const bad = [...new Set(TOOL_CATALOGUE.map(x => x.group))].filter(g => g !== 'core' && !TOGGLEABLE_GROUPS.includes(g));
  assert.deepStrictEqual(bad, []);
});
t('package.json: the off-by-default groups default to false, the others to true', () => {
  const p = pkg.configSchema.toolGroups.properties;
  for (const g of ['kernelChecks', 'checkpoints', 'fileAdmin', 'debugging', 'ghidra']) {
    assert.ok(p[g], g + ' missing'); assert.strictEqual(p[g].default, false, g + ' default');
  }
  for (const g of ['edit', 'search', 'navigation', 'fileOps', 'diagnostics', 'safety', 'highlight']) {
    assert.strictEqual(p[g].default, true, g + ' default');
  }
  for (const g of TOGGLEABLE_GROUPS) assert.ok(p[g], g + ' has no setting in package.json');
});
t('registerTool: gated by the catalogue group, skips a tool that is already registered, wraps only once', () => {
  assert.ok(/server\.__origRegisterTool/.test(reg), 'original registerTool is not kept once');
  assert.ok(/server\._registeredTools\s*&&\s*server\._registeredTools\[name\]/.test(reg), 'no already-registered guard');
  assert.ok(/_toolGroup\[name\]/.test(reg) && /!g\(_grp\)/.test(reg), 'no per-tool group gate');
});
t('the debugging block is no longer behind g(debugging) (its tools are gated one by one)', () => {
  assert.ok(!/if \(g\('debugging'\)\)/.test(reg));
  assert.ok(reg.includes('} // end debugging group'));
});
t('enable-group re-runs the registration with the saved settings and takes every toggleable group', () => {
  const i = reg.search(/name:\s+'enable-group'/);
  const b = reg.slice(i, i + 4000);
  assert.ok(/z\.enum\(\[\.\.\.TOGGLEABLE_GROUPS\]\)/.test(b), 'enum is not TOGGLEABLE_GROUPS');
  assert.ok(/\{ \.\.\.currentGroups, \[group\]: true \}, chatPanel/.test(b), 'does not re-run with the saved settings');
  assert.ok(!/singleGroup/.test(b), 'still builds a single-group map');
});

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
}

console.log = __log; console.log(__p + ' passed, ' + __f + ' failed');
