'use strict';
// 2026-11-18: `read` with NO anchor returns the whole file in pages (this replaces read-file), and startLine alone means
// "start at that line". lib/read-page.js holds the pure paging (wholeFilePage); the read handler calls it when no scope
// hint was given. read-file and find-text are removed (find-text duplicated grep-file for the active editor only).
// Run: node test/read-page.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { wholeFilePage, PAGE_LINES } = require('../lib/read-page');
const rd = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

t('page size is 2000 lines, as read-file had', () => assert.strictEqual(PAGE_LINES, 2000));
t('a small file is returned whole, no note', () => {
  const r = wholeFilePage(50);
  assert.deepStrictEqual([r.sliceStart, r.sliceEnd, r.note, r.more], [0, 49, '', false]);
});
t('a file of exactly one page: whole, no note', () => {
  const r = wholeFilePage(2000);
  assert.deepStrictEqual([r.sliceStart, r.sliceEnd, r.note, r.more], [0, 1999, '', false]);
});
t('a large file: first page, a note with the next startLine', () => {
  const r = wholeFilePage(5000);
  assert.strictEqual(r.sliceStart, 0);
  assert.strictEqual(r.sliceEnd, 1999);
  assert.strictEqual(r.more, true);
  assert.ok(/lines 1-2000 of 5000/.test(r.note), r.note);
  assert.ok(/startLine:2001/.test(r.note), r.note);
});
t('startLine alone starts at that line', () => {
  const r = wholeFilePage(5000, 2001);
  assert.strictEqual(r.sliceStart, 2000);
  assert.strictEqual(r.sliceEnd, 3999);
  assert.ok(/startLine:4001/.test(r.note), r.note);
});
t('the last page says so and has no next startLine', () => {
  const r = wholeFilePage(5000, 4001);
  assert.strictEqual(r.sliceEnd, 4999);
  assert.strictEqual(r.more, false);
  assert.ok(/last part/.test(r.note) && !/startLine:/.test(r.note), r.note);
});
t('a small file read from the middle still carries a note', () => {
  const r = wholeFilePage(50, 10);
  assert.strictEqual(r.sliceStart, 9);
  assert.ok(r.note.length > 0);
});
t('startLine past the end is an error, startLine below 1 is an error', () => {
  assert.ok(/exceeds file line count/.test(wholeFilePage(10, 11).error));
  assert.ok(/>= 1/.test(wholeFilePage(10, 0).error));
});
t('a custom page size is honoured', () => {
  const r = wholeFilePage(100, undefined, 30);
  assert.strictEqual(r.sliceEnd, 29);
  assert.ok(/startLine:31/.test(r.note));
});

const reg = rd('lib', 'mcp-registration.js');
const cat = rd('lib', 'tool-catalogue.js');
const readme = rd('README.md');
const stats = rd('lib', 'edit-stats.js');
const srv = rd('lib', 'pulsar-edit-mcp-server.js');
for (const n of ['find-text', 'read-file']) {
  const u = n.replace(/-/g, '_');
  t(n + ': removed from the registration, catalogue, README, stats and the panel lists', () => {
    assert.ok(!new RegExp("name:\\s+'" + n + "'").test(reg), 'still registered');
    assert.ok(!new RegExp('name:\\s+"' + n + '"').test(cat), 'still in tool-catalogue');
    assert.ok(!new RegExp('`' + n + '`').test(readme), 'still in README');
    assert.ok(!new RegExp('\\b' + u + '\\b').test(stats), 'still in edit-stats');
    assert.ok(!new RegExp("'" + u + "'").test(srv), 'still in the stats panel lists');
  });
}
t('the read handler pages the whole file when no anchor is given', () => {
  assert.ok(/wholeFilePage\(/.test(reg), 'read handler does not call wholeFilePage');
  assert.ok(!/Must provide startLine\+endLine, centerLine/.test(reg), 'the old "must provide an anchor" refusal is still there');
});
t('the read description tells how to read a whole file', () => {
  const i = reg.search(/name:\s+'read',/);
  assert.ok(/no anchor/i.test(reg.slice(i, i + 4000)) || /whole file/i.test(reg.slice(i, i + 4000)));
});
t('no description still points at read-file or find-text', () => {
  assert.ok(!/read-file|find-text/.test(reg.replace(/\/\/[^\n]*/g, '')), 'mcp-registration.js (outside comments) still mentions them');
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
