'use strict';
// Regression test (2026-10-14) -- failure-bucket helper scopeErrorIsOutOfRange (lib/match-engine.js).
// Run from the package root:   node test/match-engine.scope-error-bucket.test.js
// Pure-function test: no Pulsar, no buffer, no files touched.
//
// insert, replace-block and replace-function-body tally a scope failure under a stats key. Before
// 2026-10-14 an occurrence beyond the matches was filed under fails.anchorNotFound (insert,
// replace-block) or fails.ambiguous / fails.ambiguousHint (replace-function-body). The helper tells
// the three tools which scope errors are really out-of-range requests.
//
// Rule under test: resolveScope resolves an ambiguous anchor DIRECTLY when the occurrence is within
// range, so an 'ambiguous' scope error that still has an occurrence means out of range. Everything
// else (not found, unscoped duplicate, betweenHint errors) is NOT out of range.

const assert = require('assert');
const { resolveScope, scopeErrorIsOutOfRange } = require('../lib/match-engine');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

const lines = ['alpha', 'dup', 'b', 'dup', 'c', 'dup'];
const base  = { editor: null, buffer: null, allLines: lines, text: lines.join('\n'), filePath: 'x.txt' };
const scopeOf = (params) => resolveScope(Object.assign({}, base, { params }));

// resolveStructuralAnchor pairs an #ifdef with the next #endif that carries the macro name in
// a trailing comment, so the fixture's #endif lines must say FOO or the anchor is 'not found'.
const pp = ['#ifdef FOO', 'x', '#endif /* FOO */', '#ifdef FOO', 'y', '#endif /* FOO */'];
const ppBase = { editor: null, buffer: null, allLines: pp, text: pp.join('\n'), filePath: 'x.c' };
const ppScopeOf = (params) => resolveScope(Object.assign({}, ppBase, { params }));

// -- string anchors ---------------------------------------------------------------
t('afterString duplicate, no occurrence: ambiguous error, NOT out of range', () => {
  const s = scopeOf({ afterString: 'dup' });
  assert.ok(s.error, 'expected a scope error');
  assert.strictEqual(s.error.kind, 'ambiguous');
  assert.strictEqual(scopeErrorIsOutOfRange(s.error, undefined), false);
});
t('afterString duplicate, occurrence past the end: out of range', () => {
  const s = scopeOf({ afterString: 'dup', occurrence: 9 });
  assert.ok(s.error, 'expected a scope error');
  assert.strictEqual(s.error.kind, 'ambiguous');
  assert.strictEqual(scopeErrorIsOutOfRange(s.error, 9), true);
});
t('afterString duplicate, occurrence in range: resolves, no error at all', () => {
  const s = scopeOf({ afterString: 'dup', occurrence: 2 });
  assert.ok(!s.error, 'an in-range occurrence must resolve');
  assert.strictEqual(s.occurrenceConsumed, true);
  assert.strictEqual(scopeErrorIsOutOfRange(s.error, 2), false);
});
t('afterString not found, occurrence given: notFound is NOT out of range', () => {
  const s = scopeOf({ afterString: 'nothere', occurrence: 3 });
  assert.ok(s.error, 'expected a scope error');
  assert.strictEqual(s.error.kind, 'notFound');
  assert.strictEqual(scopeErrorIsOutOfRange(s.error, 3), false);
});

// -- structural anchors (anchorError with ambiguous:true) -----------------------------
t('ifdefBlock duplicate, no occurrence: NOT out of range', () => {
  const s = ppScopeOf({ ifdefBlock: 'FOO' });
  assert.ok(s.error && s.error.ambiguous === true, JSON.stringify(s.error));
  assert.strictEqual(scopeErrorIsOutOfRange(s.error, undefined), false);
});
t('ifdefBlock duplicate, occurrence past the end: out of range', () => {
  const s = ppScopeOf({ ifdefBlock: 'FOO', occurrence: 5 });
  assert.ok(s.error && s.error.ambiguous === true, JSON.stringify(s.error));
  assert.strictEqual(scopeErrorIsOutOfRange(s.error, 5), true);
});

// -- errors that must never count as out of range --------------------------------------
t('betweenHint anchorError carries no ambiguous flag: NOT out of range', () => {
  const s = scopeOf({ betweenHint: { start: 'zzz', end: 'dup' }, occurrence: 3 });
  assert.ok(s.error, 'expected a scope error');
  assert.strictEqual(scopeErrorIsOutOfRange(s.error, 3), false);
});

// -- helper edge cases ---------------------------------------------------------------------
t('no error: false', () => {
  assert.strictEqual(scopeErrorIsOutOfRange(undefined, 4), false);
  assert.strictEqual(scopeErrorIsOutOfRange(null, 4), false);
});
t('ambiguous error but occurrence omitted (undefined or null): false', () => {
  assert.strictEqual(scopeErrorIsOutOfRange({ kind: 'ambiguous' }, undefined), false);
  assert.strictEqual(scopeErrorIsOutOfRange({ kind: 'ambiguous' }, null), false);
});
t('occurrence given, error kind other than ambiguous: false', () => {
  assert.strictEqual(scopeErrorIsOutOfRange({ kind: 'notFound' }, 2), false);
  assert.strictEqual(scopeErrorIsOutOfRange({ kind: 'needsTreeSitter' }, 2), false);
  assert.strictEqual(scopeErrorIsOutOfRange({ kind: 'anchorError', message: 'x' }, 2), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
