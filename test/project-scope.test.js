'use strict';
// Aggregated summary: the runner reads only the LAST 'N passed, M failed' line, so each block's line is folded into one total printed at the end.
let __p = 0, __f = 0; const __log = console.log.bind(console);
console.log = (...a) => { const m = /(\d+) passed, (\d+) failed/.exec(a.map(String).join(' ')); if (m) { __p += Number(m[1]); __f += Number(m[2]); } else __log(...a); };
// Merged 2026-11-19 from: project-scope.test.js, project-scope.wiring.test.js, project-scope.wiring2.test.js.
// Each former file runs in its own block, so names and pass/fail counters stay separate. Run: node test/project-scope.test.js

// ===== project-scope =====
{
// XW23 / project scoping (2026-11-18): lib/project-scope.js picks which open project roots a project-wide tool covers.
// Pure-function test: no Pulsar.   Run: node test/project-scope.test.js
//   default (no project): the root that holds the active file, else the first root.
//   project:'all': every root.   project:'<name>': the root with that folder name (case-insensitive), else an error listing names.
const assert = require('assert');
const { resolveProjectRoots } = require('../lib/project-scope');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}
const R = ['C:\\proj\\alpha', 'C:\\proj\\beta', 'D:\\work\\gamma'];

t('default: the root holding the active file', () => {
  const r = resolveProjectRoots(R, undefined, 'C:\\proj\\beta\\src\\a.js');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.roots, ['C:\\proj\\beta']);
  assert.strictEqual(r.mode, 'active');
  assert.ok(/beta/.test(r.label));
});
t('default: path match is case-insensitive and slash-insensitive', () => {
  const r = resolveProjectRoots(R, undefined, 'c:/PROJ/Beta/x.js');
  assert.deepStrictEqual(r.roots, ['C:\\proj\\beta']);
});
t('default: a sibling folder with the same prefix is not matched (alpha vs alpha2)', () => {
  const r = resolveProjectRoots(['C:\\p\\alpha', 'C:\\p\\alpha2'], undefined, 'C:\\p\\alpha2\\f.js');
  assert.deepStrictEqual(r.roots, ['C:\\p\\alpha2']);
});
t('default: nested roots pick the deepest match', () => {
  const r = resolveProjectRoots(['C:\\p', 'C:\\p\\inner'], undefined, 'C:\\p\\inner\\f.js');
  assert.deepStrictEqual(r.roots, ['C:\\p\\inner']);
});
t('default: no active file -> the first root', () => {
  const r = resolveProjectRoots(R, undefined, null);
  assert.deepStrictEqual(r.roots, ['C:\\proj\\alpha']);
  assert.strictEqual(r.mode, 'first');
});
t('default: active file outside every root -> the first root', () => {
  const r = resolveProjectRoots(R, undefined, 'E:\\elsewhere\\f.js');
  assert.deepStrictEqual(r.roots, ['C:\\proj\\alpha']);
});
t("project:'all' -> every root", () => {
  const r = resolveProjectRoots(R, 'all', 'C:\\proj\\beta\\a.js');
  assert.deepStrictEqual(r.roots, R);
  assert.strictEqual(r.mode, 'all');
});
t('project:name -> that root, case-insensitive', () => {
  const r = resolveProjectRoots(R, 'GAMMA', 'C:\\proj\\alpha\\a.js');
  assert.deepStrictEqual(r.roots, ['D:\\work\\gamma']);
  assert.strictEqual(r.mode, 'named');
});
t('project:name -> unknown name is an error that lists the names, never a silent fallback', () => {
  const r = resolveProjectRoots(R, 'nope', null);
  assert.strictEqual(r.ok, false);
  assert.ok(/alpha/.test(r.error) && /beta/.test(r.error) && /gamma/.test(r.error));
  assert.ok(/all/.test(r.error));
});
t('project:name -> two roots with the same folder name is ambiguous, refused', () => {
  const r = resolveProjectRoots(['C:\\a\\app', 'D:\\b\\app'], 'app', null);
  assert.strictEqual(r.ok, false);
  assert.ok(/ambiguous/i.test(r.error));
});
t('project:name also accepts the full root path', () => {
  const r = resolveProjectRoots(['C:\\a\\app', 'D:\\b\\app'], 'D:\\b\\app', null);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.roots, ['D:\\b\\app']);
});
t('no roots at all -> error', () => {
  const r = resolveProjectRoots([], undefined, null);
  assert.strictEqual(r.ok, false);
});
t('a single root: default is that root, label does not nag about other projects', () => {
  const r = resolveProjectRoots(['C:\\only'], undefined, null);
  assert.deepStrictEqual(r.roots, ['C:\\only']);
  assert.ok(!/other/i.test(r.label));
});
t('label names the scope so a preview can show it', () => {
  const r = resolveProjectRoots(R, undefined, 'C:\\proj\\alpha\\a.js');
  assert.ok(/alpha/.test(r.label) && /project:'all'/.test(r.label));
});

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
}

// ===== project-scope.wiring =====
{
// test/project-scope.wiring.test.js - project scoping (2026-11-18).
// replace-across-files and get-repo-map used to walk EVERY open project root. They now resolve their roots through
// lib/project-scope.js (active file's project by default; project:'all' or a folder name to choose).
// Source check (the handlers need a live Pulsar).
const fs = require('fs');
const path = require('path');
const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');

let bad = 0, pass = 0;
function ok(name, cond) { if (cond) pass++; else { bad++; console.log('FAIL ' + name); } }
function body(name) {
  const m = new RegExp("name:\\s*'" + name + "',").exec(reg);
  if (!m) return '';
  const next = reg.indexOf('registerMcpTool({', m.index + 20);
  const next2 = reg.indexOf('registerMcpTool({', next + 20);
  return reg.slice(m.index, next < 0 ? reg.length : (next2 < 0 ? reg.length : next2));
}
const sliceTool = (name) => {
  const m = new RegExp("name:\\s*'" + name + "',").exec(reg);
  if (!m) return '';
  const end = reg.indexOf("\n  });", m.index);
  return reg.slice(m.index, end < 0 ? reg.length : end);
};

ok('project-scope is required', /require\('\.\/project-scope'\)/.test(reg));
for (const tool of ['replace-across-files', 'get-repo-map']) {
  const b = sliceTool(tool);
  ok(tool + ': found', b.length > 500);
  ok(tool + ': schema has an optional project string', /project:\s*z\.string\(\)\.optional\(\)/.test(b));
  ok(tool + ': handler takes project', /\bproject\b[^)]*\}\s*(=\s*\{\})?\)\s*\{/.test(b));
  ok(tool + ': roots come from resolveProjectRoots', /resolveProjectRoots\(atom\.project\.getPaths\(\), project,/.test(b) && /const roots = _scope\.roots;/.test(b));
  ok(tool + ': no direct atom.project.getPaths() assignment to roots', !/const roots = atom\.project\.getPaths\(\)/.test(b));
  ok(tool + ': description mentions the project scope', /project:'all'/.test(b));
}
const raf = sliceTool('replace-across-files');
ok('replace-across-files: both pendingKey builders include the roots (preview cannot confirm another project)', (raf.match(/pendingKey = `[^`]*roots\.join/g) || []).length === 2);
ok('replace-across-files: preview result carries the scope label', /summary, scope: _scope\.label/.test(raf));
ok('replace-across-files: commit result carries the scope label', /_result\.scope = _scope\.label/.test(raf));
const rm = sliceTool('get-repo-map');
ok('get-repo-map: output header names the scope', /Repo map \(" \+ _scope\.label/.test(rm));
// negative control
ok('negative control (old direct assignment is detected)', /const roots = atom\.project\.getPaths\(\)/.test('const roots = atom.project.getPaths();'));

console.log(pass + ' passed, ' + bad + ' failed');
if (bad) process.exitCode = 1;
}

// ===== project-scope.wiring2 =====
{
// Wiring (source) checks, 2026-11-18: get-project-files, list-project-functions, grep-project and search-symbol take an
// optional `project` param (resolveProjectRoots) and their walks carry a deadline so a huge tree cannot be walked in full.
// Run: node test/project-scope.wiring2.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}
function toolBody(name) {
  const i = src.indexOf("name: '" + name + "'") >= 0 ? src.indexOf("name: '" + name + "'") : src.indexOf("name:     '" + name + "'") >= 0 ? src.indexOf("name:     '" + name + "'") : src.indexOf("name:           '" + name + "'");
  assert.ok(i >= 0, 'tool not found: ' + name);
  const next = src.indexOf('registerMcpTool(', i);
  return src.slice(i, next > 0 ? next : i + 9000);
}

for (const name of ['get-project-files', 'list-project-functions', 'grep-project']) {
  t(name + ': has a project param and resolves roots with the shared helper', () => {
    const b = toolBody(name);
    assert.ok(/project:\s*z\.string\(\)\.optional\(\)/.test(b), 'no project schema');
    assert.ok(/_projectRoots\(project\)/.test(b), 'no _projectRoots(project) call');
    assert.ok(!/const roots\s*=\s*atom\.project\.getPaths\(\)/.test(b), 'still reads every root');
  });
  t(name + ': the walk carries a deadline and reports a partial list', () => {
    const b = toolBody(name);
    assert.ok(/deadline:/.test(b), 'no deadline passed to walkDir');
    assert.ok(/_walkNote|timedOut/.test(b), 'no partial-list note');
  });
}
t('_projectRoots helper wraps resolveProjectRoots with the active file', () => {
  assert.ok(/const _projectRoots\s*=/.test(src));
});

t('get-repo-map skips indented (local) symbols', () => {
  assert.ok(/!\/\^\\s\/\.test\(s\.sig/.test(src), 'no indented-signature filter in extractSymbols');
});
t('project label has no nested parentheses', () => {
  const { resolveProjectRoots } = require('../lib/project-scope');
  const r = resolveProjectRoots(['C:/a/one', 'C:/a/two'], undefined, 'C:/a/one/x.js');
  assert.ok(!/\(.*\(/.test(r.label) && /two|2 open/.test(r.label), r.label);
});

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
}

console.log = __log; console.log(__p + ' passed, ' + __f + ' failed');
