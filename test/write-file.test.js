'use strict';
// 2026-11-18: write-file replaces create-file and replace-document (XW23, fewer tools).
//   new path            -> create the file (folders too), put the text in, save, open a tab
//   existing + overwrite -> replace the whole content through the buffer (undo works)
//   existing, no overwrite -> refuse (create-file's safety guard is kept)
// lib/write-plan.js holds the decision; the rest is source-text wiring. Run: node test/write-file.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { planWrite, refuseExistingMessage } = require('../lib/write-plan');
const rd = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

t('planWrite: missing file is created', () => {
  assert.strictEqual(planWrite({ exists: false, overwrite: false }), 'create');
  assert.strictEqual(planWrite({ exists: false, overwrite: true }), 'create');
});
t('planWrite: existing file without overwrite is refused', () => assert.strictEqual(planWrite({ exists: true, overwrite: false }), 'refuse'));
t('planWrite: existing file with overwrite:true is replaced', () => assert.strictEqual(planWrite({ exists: true, overwrite: true }), 'overwrite'));
t('planWrite: overwrite must be exactly true', () => {
  assert.strictEqual(planWrite({ exists: true, overwrite: 'yes' }), 'refuse');
  assert.strictEqual(planWrite({ exists: true }), 'refuse');
});
t('the refusal names the path, overwrite:true and replace', () => {
  const m = refuseExistingMessage('C:/x/a.js');
  assert.ok(/C:\/x\/a\.js/.test(m) && /overwrite:true/.test(m) && /replace/.test(m) && /Nothing was written/.test(m), m);
});

const reg = rd('lib', 'mcp-registration.js');
const cat = rd('lib', 'tool-catalogue.js');
const readme = rd('README.md');
const stats = rd('lib', 'edit-stats.js');
const srv = rd('lib', 'pulsar-edit-mcp-server.js');
for (const n of ['create-file', 'replace-document']) {
  const u = n.replace(/-/g, '_');
  t(n + ': removed from the registration, catalogue, README table, stats and the panel lists', () => {
    assert.ok(!new RegExp("name:\\s+'" + n + "'").test(reg), 'still registered');
    assert.ok(!new RegExp('name:\\s+"' + n + '"').test(cat), 'still in tool-catalogue');
    assert.ok(!new RegExp('^\\| `' + n + '` \\|', 'm').test(readme), 'still a README table row');
    assert.ok(!new RegExp('\\b' + u + '\\b').test(stats.replace(/\/\/[^\n]*/g, '')), 'still in edit-stats');
    assert.ok(!new RegExp("'" + u + "'").test(srv), 'still in the stats panel lists');
  });
}
t('write-file is registered as an edit tool with text and overwrite', () => {
  const i = reg.search(/name:\s+'write-file'/);
  assert.ok(i > 0, 'not registered');
  const b = reg.slice(i, i + 5000);
  assert.ok(/group:\s+'edit'/.test(b) && /category:\s+'edit'/.test(b));
  assert.ok(/text:\s*z\.string\(\)\.optional\(\)/.test(b) && /overwrite:\s*z\.boolean\(\)\.optional\(\)/.test(b));
  assert.ok(/planWrite\(/.test(b) && /refuseExistingMessage\(/.test(b));
  assert.ok(/mkdir\(/.test(b) && /atom\.workspace\.open\(/.test(b), 'creating must make folders and open a tab');
  assert.ok(/bump\('write_file'|ctx\.commit\(/.test(b));
});
t('write-file is in the catalogue (edit group), README, stats and the panel lists', () => {
  assert.ok(/name:\s+"write-file",\s+group:\s+"edit"/.test(cat));
  assert.ok(/^\| `write-file` \|/m.test(readme));
  assert.ok(/write_file/.test(stats));
  assert.ok(/'write_file'/.test(srv));
});
t('no description or message still points at a removed tool', () => {
  const code = reg.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/replace-document|create-file/.test(code), 'mcp-registration.js (outside comments) still mentions them');
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
