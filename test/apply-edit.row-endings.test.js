'use strict';
// R2d / XW1: whole-line replace keeps each row's own line ending. Run: node test/apply-edit.row-endings.test.js
const assert = require('assert');
const { applyEdit } = require('../lib/match-engine');
// minimal buffer double: rows + per-row endings; records what setTextInRange received
function fakeBuffer(rows, endings) {
  const b = { written: null,
    getLines: () => rows.slice(), getLineCount: () => rows.length, getLastRow: () => rows.length - 1,
    lineEndingForRow: (r) => endings[r] === undefined ? '' : endings[r],
    setTextInRange: (range, text) => { b.written = { range, text }; } };
  return b;
}
const run = (rows, endings, s, e, newStr) => {
  const b = fakeBuffer(rows, endings);
  applyEdit(b, { matchLine: s, matchEndLine: e, actualLines: rows.slice(s, e + 1), transforms: [] }, newStr);
  return b.written.text;
};
const LF = '\n', CR = '\r\n';
let n = 0; const t = (f) => { f(); n++; };
t(() => assert.strictEqual(run(['a', 'b', 'c', 'd'], [LF, CR, CR, LF], 0, 1, 'p\nq\nr'), 'p\nq\r\nr\r\n')); // LF row then CRLF row, one more line
t(() => assert.strictEqual(run(['a', 'b', 'c'], [CR, CR, CR], 1, 1, 'x\ny'), 'x\r\ny\r\n'));               // pure CRLF unchanged
t(() => assert.strictEqual(run(['a', 'b', 'c'], [LF, LF, LF], 1, 1, 'x\ny'), 'x\ny\n'));                   // pure LF unchanged
t(() => assert.strictEqual(run(['a', 'b', 'c'], [LF, CR, LF], 1, 1, 'B'), 'B\r\n'));                       // CRLF row kept
t(() => assert.strictEqual(run(['a', 'b', 'c'], [LF, CR, CR], 0, 1, 'z'), 'z\n'));                         // fewer lines: first row's ending
t(() => assert.strictEqual(run(['a', 'b'], [CR, ''], 1, 1, 'B'), 'B'));                                  // last row without ending stays without one
t(() => assert.strictEqual(run(['a', 'b'], [LF, LF], 0, 0, ''), ''));                                      // delete
console.log(`apply-edit row endings: ${n} tests passed`);