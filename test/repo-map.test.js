'use strict';
// Aggregated summary: the runner reads only the LAST 'N passed, M failed' line, so each block's line is folded into one total printed at the end.
let __p = 0, __f = 0; const __log = console.log.bind(console);
console.log = (...a) => { const m = /(\d+) passed, (\d+) failed/.exec(a.map(String).join(' ')); if (m) { __p += Number(m[1]); __f += Number(m[2]); } else __log(...a); };
// Merged 2026-11-19 from: repo-map.test.js, repo-map.wiring.test.js.
// Each former file runs in its own block, so names and pass/fail counters stay separate. Run: node test/repo-map.test.js

// ===== repo-map =====
{
// get-repo-map (2026-11-18): lib/repo-map.js holds the pure parts of the tool.
//   1. countRefs gives EXACTLY the same per-symbol ref counts and file->file edges as the old per-symbol regex loop,
//      but with one pass over each file's words instead of one regex per symbol per file.
//   2. renderRepoMap honours the budget: when even one symbol per file does not fit, it drops the lowest-ranked files
//      (the old code kept one symbol for EVERY file, so maxTokens:200 returned ~3,400 tokens).
//   3. limitHealth only reports files that were shown and caps the number of lines (the old block was unbounded).
//   Pure: no Pulsar, no files.   Run: node test/repo-map.test.js
const assert = require('assert');
const { countRefs, renderRepoMap, limitHealth } = require('../lib/repo-map');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- the ORIGINAL algorithm, copied from the old handler, as the reference -------------------------------------------
function oldRefs(symbols, fileTexts, allFiles) {
  for (const sym of symbols) {
    const wordRe = new RegExp(`\\b${esc(sym.name)}\\b`, 'g');
    for (const [fp, txt] of Object.entries(fileTexts)) {
      if (fp === sym.filePath) continue;
      sym.refs += (txt.match(wordRe) || []).length;
    }
  }
  const edgeAccum = new Map();
  for (const sym of symbols) {
    if (sym.refs === 0) continue;
    const wordRe = new RegExp(`\\b${esc(sym.name)}\\b`, 'g');
    for (const srcFp of allFiles) {
      if (srcFp === sym.filePath) continue;
      const txt = fileTexts[srcFp];
      if (!txt) continue;
      const cnt = (txt.match(wordRe) || []).length;
      if (cnt === 0) continue;
      const key = `${srcFp}\x00${sym.filePath}`;
      edgeAccum.set(key, (edgeAccum.get(key) || 0) + Math.sqrt(cnt));
    }
  }
  return edgeAccum;
}
const mkSyms = (spec) => spec.map(([filePath, name, line]) => ({ filePath, line, name, sig: 'sig ' + name, refs: 0, score: 0 }));

const files = {
  'a.js': 'function alpha() { beta(); beta(); gamma_x(); }\nconst z = alpha_two;\n// operator+ and $dollar and a.b\n',
  'b.js': 'function beta() { alpha(); }\nfoo.beta; beta_more(); xbeta; beta\n',
  'c.js': 'alpha alpha alpha\nfoo_bar foo bar\n\u00c9cole \u00e9cole\n',
  'd.js': '',
};
const symSpec = [
  ['a.js', 'alpha', 1], ['a.js', 'gamma_x', 2], ['a.js', 'operator+', 3], ['a.js', '$dollar', 4],
  ['b.js', 'beta', 1], ['c.js', 'foo', 1], ['c.js', '\u00e9cole', 3], ['d.js', 'ghost', 1],
];
t('1 countRefs equals the old regex loop (refs and edges), including odd names', () => {
  const a = mkSyms(symSpec), b = mkSyms(symSpec);
  const oldEdges = oldRefs(a, files, Object.keys(files));
  const res = countRefs(b, files, Object.keys(files));
  assert.deepStrictEqual(b.map(s => s.refs), a.map(s => s.refs));
  assert.deepStrictEqual([...res.edges.entries()].sort(), [...oldEdges.entries()].sort());
});
t('1 countRefs: a name glued to longer words is not counted (foo_bar, xbeta, beta_more)', () => {
  const b = mkSyms([['b.js', 'beta', 1]]);
  countRefs(b, files, Object.keys(files));
  assert.strictEqual(b[0].refs, 2); // defined in b.js: only the two real calls in a.js count
  const c = mkSyms([['a.js', 'beta', 1]]);
  countRefs(c, files, Object.keys(files));
  assert.strictEqual(c[0].refs, 3); // in b.js: 'function beta', 'foo.beta' and the final 'beta'; not xbeta, not beta_more
});
t('1 countRefs: a file missing from fileTexts is skipped without error', () => {
  const b = mkSyms([['a.js', 'alpha', 1]]);
  const res = countRefs(b, { 'a.js': files['a.js'] }, ['a.js', 'gone.js']);
  assert.strictEqual(b[0].refs, 0);
  assert.strictEqual(res.edges.size, 0);
});
t('1 countRefs: bigger random corpus equals the old loop', () => {
  const words = ['one', 'two', 'three', 'four', 'five', 'six_seven', 'eight', 'a1', 'B2'];
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const ft = {}; const names = [];
  for (let f = 0; f < 12; f++) {
    let txt = ''; for (let i = 0; i < 80; i++) txt += words[Math.floor(rnd() * words.length)] + (rnd() < 0.3 ? '.' : ' ') + (rnd() < 0.2 ? '(\n' : '');
    ft['f' + f + '.js'] = txt;
  }
  const spec = []; for (let f = 0; f < 12; f++) for (const w of words.slice(0, 1 + (f % 6))) spec.push(['f' + f + '.js', w, 1]);
  const a = mkSyms(spec), b = mkSyms(spec);
  const oldEdges = oldRefs(a, ft, Object.keys(ft));
  const res = countRefs(b, ft, Object.keys(ft));
  assert.deepStrictEqual(b.map(s => s.refs), a.map(s => s.refs));
  assert.deepStrictEqual([...res.edges.entries()].sort(), [...oldEdges.entries()].sort());
});

// ---- rendering ------------------------------------------------------------------------------------------------------
function mkFiles(n, symsEach) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const fp = '/p/file' + i + '.js';
    const syms = []; for (let j = 0; j < symsEach; j++) syms.push({ filePath: fp, line: j * 10 + 1, name: 'fn' + i + '_' + j, sig: 'function fn' + i + '_' + j + '(a, b) {', refs: 1, score: 1 / (i + 1) });
    out.push([fp, syms]);
  }
  return out; // already in rank order: file0 is the best
}
const relOf = (fp) => fp.replace('/p/', '');
t('2 renderRepoMap stays within the budget even when one symbol per file does not fit', () => {
  const r = renderRepoMap(mkFiles(152, 5), { charBudget: 800, minRefs: 0, includeLineNumbers: true, relOf });
  assert.ok(r.text.length <= 800, 'length ' + r.text.length);
  assert.ok(r.filesShown >= 1 && r.filesShown < 152);
  assert.strictEqual(r.filesTotal, 152);
});
t('2 renderRepoMap drops the LOWEST ranked files, keeps the best ones', () => {
  const r = renderRepoMap(mkFiles(50, 3), { charBudget: 400, minRefs: 0, includeLineNumbers: true, relOf });
  assert.ok(r.text.includes('file0.js:'));
  assert.ok(!r.text.includes('file49.js:'));
});
t('2 renderRepoMap with a roomy budget shows every file and as many symbols as fit', () => {
  const r = renderRepoMap(mkFiles(4, 3), { charBudget: 100000, minRefs: 0, includeLineNumbers: true, relOf });
  assert.strictEqual(r.filesShown, 4);
  assert.strictEqual(r.symCount, 12);
});
t('2 renderRepoMap always shows at least one file, even if that line alone is over the budget', () => {
  const r = renderRepoMap(mkFiles(3, 2), { charBudget: 5, minRefs: 0, includeLineNumbers: true, relOf });
  assert.strictEqual(r.filesShown, 1);
});
t('2 renderRepoMap: minRefs filters symbols and files with none left are not shown', () => {
  const f = mkFiles(2, 2); f[1][1].forEach(s => { s.refs = 0; });
  const r = renderRepoMap(f, { charBudget: 100000, minRefs: 1, includeLineNumbers: false, relOf });
  assert.ok(r.text.includes('file0.js:') && !r.text.includes('file1.js:'));
  assert.ok(!/ \/\/ L\d/.test(r.text));
});
t('2 negative control: a budget big enough for everything does not trim files', () => {
  const r = renderRepoMap(mkFiles(152, 1), { charBudget: 1e7, minRefs: 0, includeLineNumbers: true, relOf });
  assert.strictEqual(r.filesShown, 152);
});

// ---- health block ---------------------------------------------------------------------------------------------------
const warn = (n) => { const o = []; for (let i = 0; i < n; i++) o.push({ rel: 'f' + i + '.js', flags: ['[unicode]'] }); return o; };
t('3 limitHealth reports only the files that were shown', () => {
  const r = limitHealth(warn(5), new Set(['f1.js', 'f3.js']), 10);
  assert.ok(r.includes('f1.js') && r.includes('f3.js') && !r.includes('f0.js'));
});
t('3 limitHealth caps the lines and says how many more', () => {
  const r = limitHealth(warn(40), new Set(warn(40).map(w => w.rel)), 10);
  assert.strictEqual(r.split('\n').filter(l => /f\d+\.js/.test(l)).length, 10);
  assert.ok(/30 more/.test(r));
});
t('3 limitHealth: nothing to report -> empty string', () => {
  assert.strictEqual(limitHealth(warn(3), new Set(), 10), '');
  assert.strictEqual(limitHealth([], new Set(['x']), 10), '');
});

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
}

// ===== repo-map.wiring =====
{
// test/repo-map.wiring.test.js - get-repo-map (2026-11-18).
// The handler must use lib/repo-map.js: one read per file, one-pass ref counts, a budgeted render, a capped health block
// for shown files only, and a time limit with a clear "stopped" note. Source check (the handler needs a live Pulsar).
const fs = require('fs');
const path = require('path');
const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');

let bad = 0, pass = 0;
function ok(name, cond) { if (cond) pass++; else { bad++; console.log('FAIL ' + name); } }

const m = /name:\s*'get-repo-map',/.exec(reg);
ok('found get-repo-map', !!m);
const end = reg.indexOf("\n  });", m.index);
const b = reg.slice(m.index, end);

ok('requires lib/repo-map', /require\('\.\/repo-map'\)/.test(reg));
ok('refs and edges come from countRefs', /countRefs\(symbols, fileTexts, analysed\)/.test(b));
ok('the old per-symbol regex loop is gone', !/new RegExp\(`\\\\b\$\{escapeRegex\(sym\.name\)\}/.test(b));
ok('files are read once (no second readFile pass into fileTexts)', !/fileTexts\[fp\] = await fs\.promises\.readFile/.test(b) && /fileTexts\[filePath\] = txt;/.test(b));
ok('render goes through renderRepoMap with the char budget', /renderRepoMap\(sortedFiles, \{ charBudget/.test(b) && !/function renderMap\(/.test(b));
ok('health block is capped and limited to shown files', /limitHealth\(_healthEntries, new Set\(_shownFiles/.test(b) && /for \(const \[fp\] of _shownFiles\)/.test(b));
ok('health scan no longer loops over every file', !/for \(const fp of allFiles\) \{\s*const txt = fileTexts\[fp\];/.test(b));
ok('has a time budget and says when it stopped', /_TIME_BUDGET_MS = 60000/.test(b) && /_timedOut/.test(b) && /STOPPED after/.test(b));
ok('summary reports files shown out of total', /best\.filesShown\} of \$\{best\.filesTotal\}/.test(b));
// negative control
ok('negative control (old health loop shape is detected)', /for \(const fp of allFiles\) \{\s*const txt = fileTexts\[fp\];/.test('for (const fp of allFiles) {\n        const txt = fileTexts[fp];'));

console.log(pass + ' passed, ' + bad + ' failed');
if (bad) process.exitCode = 1;
}

console.log = __log; console.log(__p + ' passed, ' + __f + ' failed');
