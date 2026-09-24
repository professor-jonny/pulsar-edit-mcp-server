'use strict';
// S1 regression test (2026-09-20) -- occurrence safety in the shared match engine.
// Run from the package root:   node test/s1_occurrence_test.js
// Pure-function test: no Pulsar, no buffer, no files touched.
//
// Rules under test:
//   1. An occurrence past the last match is REFUSED (reason:'occurrenceOutOfRange'),
//      never clamped to the last match.
//   2. An occurrence already spent by an ambiguous scope anchor
//      (scope.occurrenceConsumed) is NOT re-applied to the content match.
//   3. Pre-existing behaviour is preserved: omitted occurrence + >1 hit is
//      'ambiguous'; a valid occurrence picks exactly that hit.

const assert = require('assert');
const { matchContent, matchBlock, matchFunction, buildFailResponse } = require('../lib/match-engine');
const { resolveStructuralAnchor } = require('../lib/buffer-helpers');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

const scopeAll = (lines, extra = {}) => ({ searchStart: 0, searchEnd: lines.length - 1, ...extra });

// -- matchContent, exact path ------------------------------------------------
const L = ['a', 'dup', 'b', 'dup', 'c'];
const ctxOf = (lines) => ({ allLines: lines, text: lines.join('\n') });

t('matchContent: occurrence past the end is refused, not clamped', () => {
  const r = matchContent('dup', ctxOf(L), scopeAll(L), { occurrence: 5, autoRescue: false });
  assert.strictEqual(r.matched, false);
  assert.strictEqual(r.reason, 'occurrenceOutOfRange');
  assert.strictEqual(r.totalMatches, 2);
  assert.deepStrictEqual(r.matchLines, [2, 4]);
});
t('matchContent: occurrence 0 is refused', () => {
  const r = matchContent('dup', ctxOf(L), scopeAll(L), { occurrence: 0, autoRescue: false });
  assert.strictEqual(r.reason, 'occurrenceOutOfRange');
});
t('matchContent: valid occurrence picks exactly that hit', () => {
  const r = matchContent('dup', ctxOf(L), scopeAll(L), { occurrence: 2, autoRescue: false });
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.matchLine, 3);
});
t('matchContent: omitted occurrence with 2 hits is still ambiguous', () => {
  const r = matchContent('dup', ctxOf(L), scopeAll(L), { autoRescue: false });
  assert.strictEqual(r.matched, false);
  assert.strictEqual(r.reason, 'ambiguous');
});
t('matchContent: occurrence 1 on a single hit still matches', () => {
  const r = matchContent('a', ctxOf(L), scopeAll(L), { occurrence: 1, autoRescue: false });
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.matchLine, 0);
});
t('matchContent: occurrence 2 on a single hit is refused (used to silently pick hit 1)', () => {
  const r = matchContent('a', ctxOf(L), scopeAll(L), { occurrence: 2, autoRescue: false });
  assert.strictEqual(r.reason, 'occurrenceOutOfRange');
  assert.strictEqual(r.totalMatches, 1);
});

// -- matchContent, occurrence already consumed by the scope anchor -----------
t('consumed occurrence is not re-applied: single content hit still matches', () => {
  const r = matchContent('a', ctxOf(L), scopeAll(L, { occurrenceConsumed: true }), { occurrence: 2, autoRescue: false });
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.matchLine, 0);
});
t('consumed occurrence is not re-applied: 2 content hits are refused as ambiguous, not silently hit 2', () => {
  const r = matchContent('dup', ctxOf(L), scopeAll(L, { occurrenceConsumed: true }), { occurrence: 2, autoRescue: false });
  assert.strictEqual(r.matched, false);
  assert.strictEqual(r.reason, 'ambiguous');
});

// -- matchContent, regex path -------------------------------------------------
t('matchContent regex: out-of-range refused', () => {
  const r = matchContent('dup', ctxOf(L), scopeAll(L), { regex: true, occurrence: 5 });
  assert.strictEqual(r.reason, 'occurrenceOutOfRange');
  assert.strictEqual(r.totalMatches, 2);
});
t('matchContent regex: valid occurrence picks that match', () => {
  const r = matchContent('dup', ctxOf(L), scopeAll(L), { regex: true, occurrence: 2 });
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.matchLine, 3);
});

// -- matchBlock ---------------------------------------------------------------
const B = ['function f() {', '}', 'function f() {', '}'];
t('matchBlock: out-of-range refused', () => {
  const r = matchBlock('function f', { allLines: B }, scopeAll(B), { occurrence: 5 });
  assert.strictEqual(r.matched, false);
  assert.strictEqual(r.reason, 'occurrenceOutOfRange');
  assert.deepStrictEqual(r.matchLines, [1, 3]);
});
t('matchBlock: valid occurrence picks that block', () => {
  const r = matchBlock('function f', { allLines: B }, scopeAll(B), { occurrence: 2 });
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.matchLine, 2);
  assert.strictEqual(r.matchEndLine, 3);
});
t('matchBlock: consumed occurrence + 2 anchor hits is ambiguous, not silently hit 2', () => {
  const r = matchBlock('function f', { allLines: B }, scopeAll(B, { occurrenceConsumed: true }), { occurrence: 2 });
  assert.strictEqual(r.reason, 'ambiguous');
});
t('matchBlock: consumed occurrence + 1 anchor hit still matches (the replace-block double-use case)', () => {
  const one = ['function g() {', '}'];
  const r = matchBlock('function g', { allLines: one }, scopeAll(one, { occurrenceConsumed: true }), { occurrence: 2 });
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.matchLine, 0);
});

// -- matchFunction ------------------------------------------------------------
const syms = [
  { name: 'f', startRow: 0, endRow: 1, sig: 'f()', kind: 'function' },
  { name: 'f', startRow: 2, endRow: 3, sig: 'f()', kind: 'function' },
];
t('matchFunction: out-of-range refused', () => {
  const r = matchFunction('f', { allLines: B }, scopeAll(B), { occurrence: 5, symbols: syms });
  assert.strictEqual(r.matched, false);
  assert.strictEqual(r.reason, 'occurrenceOutOfRange');
  assert.deepStrictEqual(r.matchLines, [1, 3]);
});
t('matchFunction: valid occurrence picks that definition', () => {
  const r = matchFunction('f', { allLines: B }, scopeAll(B), { occurrence: 2, symbols: syms });
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.matchLine, 2);
});
t('matchFunction: consumed occurrence + 2 candidates is ambiguous', () => {
  const r = matchFunction('f', { allLines: B }, scopeAll(B, { occurrenceConsumed: true }), { occurrence: 2, symbols: syms });
  assert.strictEqual(r.reason, 'ambiguous');
});

// -- structural anchors (buffer-helpers.resolveStructuralAnchor) --------------
const banners = [
  '/* ==========', '* INIT A', '* ========== */',
  'x',
  '/* ==========', '* INIT B', '* ========== */',
];
const bufOf = (lines) => ({ getLines: () => lines });
t('sectionHint: out-of-range occurrence is refused with outOfRange marker', () => {
  const r = resolveStructuralAnchor(bufOf(banners), { sectionHint: 'INIT', occurrence: 5 });
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.outOfRange, true);
  assert.strictEqual(r.occurrence, 5);
  assert.strictEqual(r.matches.length, 2);
});
t('sectionHint: valid occurrence resolves to that banner', () => {
  const r = resolveStructuralAnchor(bufOf(banners), { sectionHint: 'INIT', occurrence: 2 });
  assert.strictEqual(r.startRow, 4);
  assert.strictEqual(r.endRow, 6);
});
t('sectionHint: omitted occurrence is still plain ambiguous (no outOfRange marker)', () => {
  const r = resolveStructuralAnchor(bufOf(banners), { sectionHint: 'INIT' });
  assert.strictEqual(r.ambiguous, true);
  assert.ok(!r.outOfRange);
});
const pp = ['#ifdef FOO', 'a', '#endif /* FOO */', '#ifdef FOO', 'b', '#endif /* FOO */'];
t('preprocBlock: out-of-range occurrence is refused with outOfRange marker', () => {
  const r = resolveStructuralAnchor(bufOf(pp), { preprocBlock: 'FOO', occurrence: 3 });
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.outOfRange, true);
});
t('preprocBlock: valid occurrence resolves to that block', () => {
  const r = resolveStructuralAnchor(bufOf(pp), { preprocBlock: 'FOO', occurrence: 2 });
  assert.strictEqual(r.startRow, 3);
  assert.strictEqual(r.endRow, 5);
});

// -- buildFailResponse wording --------------------------------------------------
t('buildFailResponse: out-of-range says so plainly and is not "content not found"', () => {
  const match = matchContent('dup', ctxOf(L), scopeAll(L), { occurrence: 5, autoRescue: false });
  const out = buildFailResponse({ tool: 'delete', ctx: { consec: { count: 0 }, allLines: L, text: L.join('\n') }, scope: scopeAll(L), match, needle: 'dup' });
  const text = out.content[0].text;
  assert.strictEqual(out.matched, false);
  assert.ok(/occurrence:5 requested but only 2 matches/.test(text), text);
  assert.ok(/Nothing was changed/.test(text), text);
  assert.ok(!/content not found/.test(text), text);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
