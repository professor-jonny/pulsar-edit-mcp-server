'use strict';
// Unit test for lib/substring-lines.js (findSubstringInLines), the substring-per-line fallback of the
// read tool's pair-anchor mode (startContent / endContent, betweenHint).
// Run from the package root:   node test/substring-lines.test.js
// Pure-function test: no Pulsar, no buffer, no files touched.
//
// 2026-10-15: an occurrence PAST the matches used to come back as plain noMatch ("start anchor not
// found"), and an occurrence of 0, a negative number or a fraction came back as matched:true with an
// undefined matchLine and a NaN matchEndLine. Both are now refused with reason 'occurrenceOutOfRange',
// the same shape match-engine's occurrenceFail gives, which the read handler already words.

const assert = require('assert');
const { findSubstringInLines } = require('../lib/substring-lines');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

const buf = [
  'alpha',                  // row 0
  '  call foo(bar);',       // row 1
  'beta',                   // row 2
  '  call foo(baz);',       // row 3
  'gamma',                  // row 4
  '  call foo(qux);',       // row 5
];

// -- behaviour that must not change ---------------------------------------------------------
t('substring on a line is found (part-line text, one match)', () => {
  const r = findSubstringInLines(buf, 'alpha', 0, undefined);
  assert.deepStrictEqual(r, { matched: true, matchLine: 0, matchEndLine: 0 });
});
t('multi-line needle: every needle line is a substring of the line at the same offset', () => {
  const r = findSubstringInLines(buf, 'beta\ncall foo(baz', 0, undefined);
  assert.deepStrictEqual(r, { matched: true, matchLine: 2, matchEndLine: 3 });
});
t('fromRow is respected: a match above it is ignored', () => {
  const r = findSubstringInLines(buf, 'alpha', 1, undefined);
  assert.deepStrictEqual(r, { matched: false, reason: 'noMatch' });
});
t('no match at all: noMatch', () => {
  assert.deepStrictEqual(findSubstringInLines(buf, 'zeta', 0, undefined), { matched: false, reason: 'noMatch' });
});
t('three matches, no occurrence: ambiguous, with 1-based lines', () => {
  const r = findSubstringInLines(buf, 'call foo(', 0, undefined);
  assert.deepStrictEqual(r, { matched: false, reason: 'ambiguous', matchLines: [2, 4, 6] });
});
t('three matches, occurrence 1 / 2 / 3 pick the right row', () => {
  assert.strictEqual(findSubstringInLines(buf, 'call foo(', 0, 1).matchLine, 1);
  assert.strictEqual(findSubstringInLines(buf, 'call foo(', 0, 2).matchLine, 3);
  assert.strictEqual(findSubstringInLines(buf, 'call foo(', 0, 3).matchLine, 5);
});
t('one match, occurrence 1: matched', () => {
  assert.strictEqual(findSubstringInLines(buf, 'gamma', 0, 1).matched, true);
});
t('nothing found with an occurrence given: still noMatch (not out of range)', () => {
  assert.deepStrictEqual(findSubstringInLines(buf, 'zeta', 0, 2), { matched: false, reason: 'noMatch' });
});
t('fromRow past the end of the buffer: noMatch, no throw', () => {
  assert.deepStrictEqual(findSubstringInLines(buf, 'alpha', 99, undefined), { matched: false, reason: 'noMatch' });
});

// -- occurrence past the matches: refused with the engine's out-of-range shape -----------------
t('occurrence 5 with 3 matches: occurrenceOutOfRange with count and lines', () => {
  const r = findSubstringInLines(buf, 'call foo(', 0, 5);
  assert.strictEqual(r.matched, false);
  assert.strictEqual(r.reason, 'occurrenceOutOfRange');
  assert.strictEqual(r.occurrence, 5);
  assert.strictEqual(r.totalMatches, 3);
  assert.deepStrictEqual(r.matchLines, [2, 4, 6]);
});
t('occurrence 4 with exactly 3 matches: out of range (boundary)', () => {
  assert.strictEqual(findSubstringInLines(buf, 'call foo(', 0, 4).reason, 'occurrenceOutOfRange');
});
t('occurrence 2 with exactly 1 match: out of range, count 1', () => {
  const r = findSubstringInLines(buf, 'gamma', 0, 2);
  assert.strictEqual(r.reason, 'occurrenceOutOfRange');
  assert.strictEqual(r.totalMatches, 1);
  assert.deepStrictEqual(r.matchLines, [5]);
});
t('matchLines are counted from fromRow, like the matches themselves', () => {
  const r = findSubstringInLines(buf, 'call foo(', 2, 9);
  assert.strictEqual(r.reason, 'occurrenceOutOfRange');
  assert.strictEqual(r.totalMatches, 2);
  assert.deepStrictEqual(r.matchLines, [4, 6]);
});

// -- occurrence that is not a whole number from 1: refused, never a matched:true with NaN --------
for (const bad of [0, -1, 1.5]) {
  t('occurrence ' + bad + ' with 3 matches: refused, not matched:true', () => {
    const r = findSubstringInLines(buf, 'call foo(', 0, bad);
    assert.strictEqual(r.matched, false, JSON.stringify(r));
    assert.strictEqual(r.reason, 'occurrenceOutOfRange');
    assert.strictEqual(r.occurrence, bad);
    assert.strictEqual(r.totalMatches, 3);
  });
}
t('a matched result always carries whole-number rows', () => {
  const r = findSubstringInLines(buf, 'call foo(', 0, 2);
  assert.ok(Number.isInteger(r.matchLine) && Number.isInteger(r.matchEndLine), JSON.stringify(r));
});

// -- one definition of out of range: identical to the engine's own failure ------------------------
t('out-of-range result is exactly match-engine occurrenceFail (no second shape to drift)', () => {
  const { occurrenceFail } = require('../lib/match-engine');
  assert.deepStrictEqual(findSubstringInLines(buf, 'call foo(', 0, 5), occurrenceFail(5, 3, [2, 4, 6]));
  assert.deepStrictEqual(findSubstringInLines(buf, 'call foo(', 0, 0), occurrenceFail(0, 3, [2, 4, 6]));
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
