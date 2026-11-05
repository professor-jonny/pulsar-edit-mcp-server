'use strict';
// Aggregated summary: the runner reads only the LAST 'N passed, M failed' line, so each block's line is folded into one total printed at the end.
let __p = 0, __f = 0; const __log = console.log.bind(console);
console.log = (...a) => { const m = /(\d+) passed, (\d+) failed/.exec(a.map(String).join(' ')); if (m) { __p += Number(m[1]); __f += Number(m[2]); } else __log(...a); };
// Merged 2026-11-19 from: search-symbol-removed.test.js, replace-block-removed.test.js, str-replace.removed.test.js, tool-removals.get-file-info.test.js.
// Each former file runs in its own block, so names and pass/fail counters stay separate. Run: node test/tool-removals.test.js

// ===== search-symbol-removed =====
{
// 2026-11-19 (XW23): search-symbol removed (0 lifetime uses; whole-word grep, which grep-file and grep-project cover).
// Run: node test/search-symbol-removed.test.js
const fs = require('fs');
const path = require('path');
const rd = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); } }
const noComments = (s) => s.replace(/^\s*\/\/[^\n]*$/gm, '');
t('not registered, not exempted, no stats calls in mcp-registration.js', () => {
  const r = noComments(rd('lib', 'mcp-registration.js'));
  if (/search-symbol|search_symbol/.test(r)) throw new Error('still mentioned: ' + (r.match(/.{0,40}(search-symbol|search_symbol).{0,40}/) || [''])[0]);
});
t('not in the catalogue', () => { if (/search-symbol/.test(rd('lib', 'tool-catalogue.js'))) throw new Error('still there'); });
t('no stats counters for it', () => { if (/search_symbol/.test(noComments(rd('lib', 'edit-stats.js')))) throw new Error('edit-stats.js'); if (/search_symbol/.test(rd('lib', 'pulsar-edit-mcp-server.js'))) throw new Error('stats panel list'); });
t('README table and package.json no longer list it', () => {
  if (/^\| `search-symbol` \|/m.test(rd('README.md'))) throw new Error('README row');
  if (/search-symbol/.test(rd('package.json'))) throw new Error('package.json');
});
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
}

// ===== replace-block-removed =====
{
// 2026-11-19 (XW23): replace-block removed (0 lifetime uses). Whole non-function blocks are now a longer replace, or delete + insert.
// matchBlock stays in match-engine.js (the engine and its tests are shared labels; only the tool goes). Run: node test/replace-block-removed.test.js
const fs = require('fs');
const path = require('path');
const rd = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); } }
const noComments = (s) => s.replace(/^\s*\/\/[^\n]*$/gm, '');
t('not registered and no stats calls in mcp-registration.js', () => {
  const r = noComments(rd('lib', 'mcp-registration.js'));
  const m = r.match(/.{0,50}(replace-block|replace_block).{0,50}/);
  if (m) throw new Error('still mentioned: ' + m[0]);
});
t('not in the catalogue, the stats table or the panel list', () => {
  if (/replace-block/.test(rd('lib', 'tool-catalogue.js'))) throw new Error('catalogue');
  if (/replace_block/.test(noComments(rd('lib', 'edit-stats.js')))) throw new Error('edit-stats.js');
  if (/replace_block/.test(rd('lib', 'pulsar-edit-mcp-server.js'))) throw new Error('panel list');
});
t('README has no replace-block row', () => { if (/replace-block/.test(rd('README.md'))) throw new Error('README still mentions it'); });
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
}

// ===== str-replace.removed =====
{
// Source-check test (2026-11-13): str_replace is REMOVED -- no alias, no redirect, no stats (PJ). It was deprecated in favour of `replace`.
// Run from the package root:   node test/str-replace.removed.test.js      Plain node, no Pulsar, no files written.
//
// Pinned:
//   1. The tool is not registered (no name 'str_replace' in lib/mcp-registration.js) and not in the catalogue.
//   2. No stub or alias: the registration source never mentions the old tool name at all.
//   3. Its stats are gone: no 'str_replace' key in a fresh stats object, none in the summary rows, and old persisted data that still
//      carries one is dropped on load.
//   4. No lib file mentions it any more (str_replace, str-replace, StrReplace), so there is no dead wrapper or stale comment left.
//   5. The three wrapper modules that only the old handler used are deleted (str-replace-scope / -fragment / -preview) with their tests.
//   6. The regex guard no longer lists it.

const fs = require('fs');
const path = require('path');

let bad = 0, pass = 0;
function ok(label, cond, detail) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && detail !== undefined) console.log('      ' + detail);
}
const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(root, ...p));

// 1 + 2 ---------------------------------------------------------------------------------------------------------------
const reg = read('lib', 'mcp-registration.js');
ok("1 mcp-registration.js does not register a tool named 'str_replace'", !/name:\s*'str_replace'/.test(reg));
const { TOOL_CATALOGUE } = require(path.join(root, 'lib', 'tool-catalogue.js'));
ok('1 the catalogue has no str_replace entry', !TOOL_CATALOGUE.some(t => /str[_-]?replace/i.test(t.name)));
ok('2 the registration source never names the old tool (no alias or stub)', !/str[_-]replace/i.test(reg));

// 3 stats -------------------------------------------------------------------------------------------------------------
// The ONE allowed mention of the old name is the load-time prune list in edit-stats.js, on a line marked `legacy-key-prune`:
// persisted lifetime stats (session-stats.json) written before the removal still carry a str_replace block, and mergeInto() would
// otherwise load it back in. Everything else about the tool's stats must be gone.
const stats = read('lib', 'edit-stats.js');
const statsOther = stats.split('\n').filter(l => !l.includes('legacy-key-prune')).join('\n');
ok("3 edit-stats.js has no 'str_replace' key, summary row or comment (apart from the marked prune list)", !/str_replace/.test(statsOther));
ok('3 edit-stats.js has the marked legacy-key-prune list naming it once', (stats.match(/legacy-key-prune/g) || []).length === 1);
const es = require(path.join(root, 'lib', 'edit-stats.js'));
ok("3 the live session stats object has no str_replace entry", !('str_replace' in es.editStats));
ok("3 the live lifetime stats object has no str_replace entry", !('str_replace' in es.lifetimeStats));
ok('3 edit-stats exports _pruneRemovedTools', typeof es._pruneRemovedTools === 'function');
if (typeof es._pruneRemovedTools === 'function') {
  const disk = { str_replace: { hits: 2542, fails: { noMatch: 1 } }, insert: { hits: 5 }, sessionCount: 4 };
  es._pruneRemovedTools(disk);
  ok('3 pruning drops the persisted str_replace block', !('str_replace' in disk));
  ok('3 pruning leaves the other tools and sessionCount alone', disk.insert && disk.insert.hits === 5 && disk.sessionCount === 4);
  ok('3 pruning tolerates null / non-objects', (() => { try { es._pruneRemovedTools(null); es._pruneRemovedTools('x'); return true; } catch { return false; } })());
}
ok('3 initStats prunes before merging', /_pruneRemovedTools\(disk\);\s*\n\s*_migrateRenamedHintKeys\(disk\);|_migrateRenamedHintKeys\(disk\);\s*\n\s*_pruneRemovedTools\(disk\);/.test(stats) && stats.indexOf('_pruneRemovedTools(disk)') < stats.indexOf('mergeInto(lifetimeStats, disk)'));

// 4 no mention left in lib ----------------------------------------------------------------------------------------------
const libFiles = fs.readdirSync(path.join(root, 'lib')).filter(f => f.endsWith('.js'));
const stale = [];
for (const f of libFiles) {
  const lines = read('lib', f).split('\n');
  lines.forEach((l, i) => { if (/str[_-]replace|StrReplace/.test(l) && !l.includes('legacy-key-prune')) stale.push(f + ':' + (i + 1)); });
}
ok('4 no lib file mentions str_replace / str-replace / StrReplace (' + libFiles.length + ' files scanned)', stale.length === 0, stale.slice(0, 25).join(' ') + (stale.length > 25 ? ' ... (+' + (stale.length - 25) + ')' : ''));

// 5 wrapper modules + their tests deleted ----------------------------------------------------------------------------
for (const m of ['str-replace-scope', 'str-replace-fragment', 'str-replace-preview']) {
  ok('5 lib/' + m + '.js is deleted', !exists('lib', m + '.js'));
  ok('5 test/' + m + '.test.js is deleted', !exists('test', m + '.test.js'));
}

// 6 regex guard ----------------------------------------------------------------------------------------------------------
const rg = read('lib', 'regex-guard.js');
ok('6 regex-guard.js does not list str_replace', !/str_replace/.test(rg));

console.log(pass + ' passed, ' + bad + ' failed');
if (bad) process.exitCode = 1;
}

// ===== tool-removals.get-file-info =====
{
// XW23 (2026-11-18): tools removed as redundant and one renamed.
//   removed: get-document (read / read-file), rename-file (move-file), save-file (edits auto-save; save-all remains),
//            get-line-count, get-filename, get-full-path (folded into get-file-info)
//   renamed: get-active-editor-info -> get-file-info, now with an optional filePath (omit = active editor)
// Source-text checks: handler wiring cannot run outside Pulsar. Run: node test/tool-removals.get-file-info.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const rd = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const reg = rd('lib', 'mcp-registration.js');
const cat = rd('lib', 'tool-catalogue.js');
const readme = rd('README.md');
const stats = rd('lib', 'edit-stats.js');
const srv = rd('lib', 'pulsar-edit-mcp-server.js');
const resp = rd('lib', 'edit-response.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

const REMOVED = ['get-document', 'rename-file', 'save-file', 'get-line-count', 'get-filename', 'get-full-path', 'get-active-editor-info'];
for (const n of REMOVED) {
  const u = n.replace(/-/g, '_');
  t(n + ': not registered, not in the catalogue, README, stats or the panel lists', () => {
    assert.ok(!new RegExp("name:\\s+'" + n + "'").test(reg), 'still registered');
    assert.ok(!new RegExp('name:\\s+"' + n + '"').test(cat), 'still in tool-catalogue');
    assert.ok(!new RegExp('`' + n + '`').test(readme), 'still in README');
    assert.ok(!new RegExp("\\b" + u + "\\b").test(stats), 'still in edit-stats');
    assert.ok(!new RegExp("'" + u + "'").test(srv), 'still in the stats panel lists');
    assert.ok(!new RegExp("'" + n + "'").test(reg.slice(0, 20000)), 'still named in the registration header lists');
  });
}
t('no description or message still points at a removed tool', () => {
  for (const n of ['get-document', 'save-file', 'get-active-editor-info']) {
    assert.ok(!reg.includes(n), 'mcp-registration.js still mentions ' + n);
    assert.ok(!resp.includes(n), 'edit-response.js still mentions ' + n);
  }
});
t('get-file-info is registered with an optional filePath, no editor required', () => {
  const i = reg.search(/name:\s+'get-file-info'/);
  assert.ok(i > 0, 'not registered');
  const b = reg.slice(i, i + 3500);
  assert.ok(/requiresEditor:\s*false/.test(b), 'requiresEditor must be false');
  assert.ok(/filePath:\s*z\.string\(\)\.optional\(\)/.test(b), 'filePath must be optional');
  assert.ok(/bump\('get_file_info'/.test(b), 'no stats bump');
});
t('get-file-info is in the catalogue, README, stats and the panel list', () => {
  assert.ok(/name:\s+"get-file-info"/.test(cat));
  assert.ok(/`get-file-info`/.test(readme));
  assert.ok(/get_file_info/.test(stats));
  assert.ok(/'get_file_info'/.test(srv));
});
t('get-file-info stays exempt from the ignore list (it is how you look at the active file)', () => {
  const i = reg.indexOf('const IGNORE_EXEMPT');
  assert.ok(i > 0 && reg.slice(i, i + 700).includes("'get-file-info'"));
});
t('the save-failed message points at save-all and get-file-info', () => {
  assert.ok(/save-all/.test(resp) && /get-file-info/.test(resp));
});

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
}

console.log = __log; console.log(__p + ' passed, ' + __f + ' failed');
