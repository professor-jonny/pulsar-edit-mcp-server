'use strict';
// S3 unit test (2026-09-20) -- identifier-boundary check for fragment matches.
// Run from the package root:   node test/s3_identifier_boundary_test.js
// Pure-function test: no Pulsar, no buffer, no files touched.
//
// Rules under test:
//   1. A fragment glued to an identifier character on either side is "inside" a longer identifier
//      ('count' in 'discount' or 'counter').
//   2. A whole-token hit is NOT inside ('count' in 'x = count + 1').
//   3. A boundary only matters on an edge where the fragment itself ends in an identifier
//      character: '(count' and 'count;' carry their own edge.
//   4. Identifier characters are [A-Za-z0-9_$] only: '-' and '.' are separators.
//   5. Bad input never throws.

const assert = require('assert');
const { isIdentChar, checkIdentifierBoundary, scanLineForFragments } = require('../lib/identifier-boundary');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

const at = (line, needle) => {
  const i = line.indexOf(needle);
  assert.notStrictEqual(i, -1, `needle "${needle}" not in "${line}"`);
  return checkIdentifierBoundary(line, i, needle.length);
};

// -- isIdentChar --------------------------------------------------------------
t('isIdentChar: letters, digits, underscore, dollar are identifier characters', () => {
  for (const c of ['a', 'Z', '0', '9', '_', '$']) assert.strictEqual(isIdentChar(c), true, c);
});
t('isIdentChar: separators and punctuation are not', () => {
  for (const c of [' ', '-', '.', '(', ')', ';', ',', '/', '"', '']) assert.strictEqual(isIdentChar(c), false, JSON.stringify(c));
});
t('isIdentChar: multi-character or non-string input is false', () => {
  assert.strictEqual(isIdentChar('ab'), false);
  assert.strictEqual(isIdentChar(undefined), false);
  assert.strictEqual(isIdentChar(5), false);
});

// -- the motivating case ------------------------------------------------------
t("'count' inside 'discount' is flagged (glued on the left)", () => {
  const r = at('let discount = 5;', 'count');
  assert.strictEqual(r.inside, true);
  assert.strictEqual(r.left, true);
  assert.strictEqual(r.right, false);
  assert.strictEqual(r.leftChar, 's');
});
t("'count' inside 'counter' is flagged (glued on the right)", () => {
  const r = at('counter += 1;', 'count');
  assert.strictEqual(r.inside, true);
  assert.strictEqual(r.left, false);
  assert.strictEqual(r.right, true);
  assert.strictEqual(r.rightChar, 'e');
});
t("'count' inside 'recounted' is flagged on both sides", () => {
  const r = at('recounted', 'count');
  assert.strictEqual(r.left, true);
  assert.strictEqual(r.right, true);
  assert.strictEqual(r.inside, true);
});
t("whole token 'count' is NOT inside", () => {
  const r = at('x = count + 1;', 'count');
  assert.strictEqual(r.inside, false);
  assert.strictEqual(r.left, false);
  assert.strictEqual(r.right, false);
});

// -- line edges ---------------------------------------------------------------
t('fragment at column 0 has no left neighbour', () => {
  const r = at('count = 1', 'count');
  assert.strictEqual(r.inside, false);
  assert.strictEqual(r.leftChar, '');
});
t('fragment at end of line has no right neighbour', () => {
  const r = at('n = count', 'count');
  assert.strictEqual(r.inside, false);
  assert.strictEqual(r.rightChar, '');
});
t('the whole line as the fragment is not inside', () => {
  assert.strictEqual(at('count', 'count').inside, false);
});

// -- rule 3: the needle's own edge -------------------------------------------
t("needle '(count' carries its own left edge: 'foo(count)' is fine, 'foo(discount)' is not a hit", () => {
  // '(count' cannot occur inside 'discount', so the meaningful case is the neighbour after it.
  assert.strictEqual(at('foo(count)', '(count').inside, false);
});
t("needle 'count;' carries its own right edge: 'discount;' IS still glued on the left", () => {
  const r = at('x = discount;', 'count;');
  assert.strictEqual(r.left, true);   // 'c' is an identifier char and 's' precedes it
  assert.strictEqual(r.right, false); // ';' is not an identifier char, so the right edge never counts
  assert.strictEqual(r.inside, true);
});
t("needle ' count ' (spaces) is never inside an identifier", () => {
  const r = at('a count b', ' count ');
  assert.strictEqual(r.inside, false);
  assert.strictEqual(r.left, false);
  assert.strictEqual(r.right, false);
});
t("needle 'a.b' glued to 'xa.by': left and right both count (ends are identifier characters)", () => {
  const r = at('xa.by', 'a.b');
  assert.strictEqual(r.left, true);
  assert.strictEqual(r.right, true);
});

// -- rule 4: what is a separator ---------------------------------------------
t("'-' is a separator: 'count' in 'my-count' is NOT inside", () => {
  assert.strictEqual(at('my-count', 'count').inside, false);
});
t("'.' is a separator: 'count' in 'this.count' is NOT inside", () => {
  assert.strictEqual(at('this.count', 'count').inside, false);
});
t("'_' is an identifier character: 'count' in 'my_count' IS inside", () => {
  assert.strictEqual(at('my_count', 'count').inside, true);
});
t("'$' is an identifier character: 'count' in '$count' IS inside", () => {
  assert.strictEqual(at('$count', 'count').inside, true);
});
t("digits are identifier characters: 'count' in 'count2' IS inside", () => {
  assert.strictEqual(at('count2', 'count').inside, true);
});

// -- rule 5: bad input --------------------------------------------------------
t('bad input never throws and reports not-inside', () => {
  const none = { inside: false, left: false, right: false, leftChar: '', rightChar: '' };
  assert.deepStrictEqual(checkIdentifierBoundary(undefined, 0, 1), none);
  assert.deepStrictEqual(checkIdentifierBoundary('abc', -1, 1), none);
  assert.deepStrictEqual(checkIdentifierBoundary('abc', 0, 0), none);
  assert.deepStrictEqual(checkIdentifierBoundary('abc', 2, 5), none);
  assert.deepStrictEqual(checkIdentifierBoundary('abc', 1.5, 1), none);
  assert.deepStrictEqual(checkIdentifierBoundary('abc', 0, NaN), none);
});

// -- scanLineForFragments -----------------------------------------------------
t("scanLineForFragments: 'count' in 'count discount counter' finds three hits, two glued", () => {
  const r = scanLineForFragments('count discount counter', 'count');
  assert.strictEqual(r.length, 3);
  assert.deepStrictEqual(r.map(h => h.inside), [false, true, true]);
  assert.deepStrictEqual(r.map(h => h.index), [0, 9, 15]);
});
t('scanLineForFragments: overlapping hits are all reported', () => {
  const r = scanLineForFragments('aaaa', 'aa');
  assert.deepStrictEqual(r.map(h => h.index), [0, 1, 2]);
});
t('scanLineForFragments: no match, empty needle, and bad input give an empty list', () => {
  assert.deepStrictEqual(scanLineForFragments('abc', 'x'), []);
  assert.deepStrictEqual(scanLineForFragments('abc', ''), []);
  assert.deepStrictEqual(scanLineForFragments(null, 'a'), []);
  assert.deepStrictEqual(scanLineForFragments('abc', undefined), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
