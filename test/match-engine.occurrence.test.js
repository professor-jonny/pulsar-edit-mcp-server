'use strict';
// Aggregated summary: the runner reads only the LAST 'N passed, M failed' line, so each block's line is folded into one total printed at the end.
let __p = 0, __f = 0; const __log = console.log.bind(console);
console.log = (...a) => { const m = /(\d+) passed, (\d+) failed/.exec(a.map(String).join(' ')); if (m) { __p += Number(m[1]); __f += Number(m[2]); } else __log(...a); };
// Merged 2026-11-19 from: match-engine.occurrence.test.js, match-engine.rescue-occurrence.test.js.
// Each former file runs in its own block, so names and pass/fail counters stay separate. Run: node test/match-engine.occurrence.test.js

// ===== match-engine.occurrence =====
{
// Regression test (2026-09-20) -- occurrence safety in the shared match engine.
// Run from the package root:   node test/match-engine.occurrence.test.js
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
  const r = matchContent('dup', ctxOf(L), scopeAll(L), { occurrence: 5 });
  assert.strictEqual(r.reason, 'occurrenceOutOfRange');
  assert.strictEqual(r.totalMatches, 2);
});
t('matchContent regex: valid occurrence picks that match', () => {
  const r = matchContent('dup', ctxOf(L), scopeAll(L), { occurrence: 2 });
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
t('banner: out-of-range occurrence is refused with outOfRange marker', () => {
  const r = resolveStructuralAnchor(bufOf(banners), { banner: 'INIT', occurrence: 5 });
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.outOfRange, true);
  assert.strictEqual(r.occurrence, 5);
  assert.strictEqual(r.matches.length, 2);
});
t('banner: valid occurrence resolves to that banner', () => {
  const r = resolveStructuralAnchor(bufOf(banners), { banner: 'INIT', occurrence: 2 });
  assert.strictEqual(r.startRow, 4);
  assert.strictEqual(r.endRow, 6);
});
t('banner: omitted occurrence is still plain ambiguous (no outOfRange marker)', () => {
  const r = resolveStructuralAnchor(bufOf(banners), { banner: 'INIT' });
  assert.strictEqual(r.ambiguous, true);
  assert.ok(!r.outOfRange);
});
const pp = ['#ifdef FOO', 'a', '#endif /* FOO */', '#ifdef FOO', 'b', '#endif /* FOO */'];
t('ifdefBlock: out-of-range occurrence is refused with outOfRange marker', () => {
  const r = resolveStructuralAnchor(bufOf(pp), { ifdefBlock: 'FOO', occurrence: 3 });
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.outOfRange, true);
});
t('ifdefBlock: valid occurrence resolves to that block', () => {
  const r = resolveStructuralAnchor(bufOf(pp), { ifdefBlock: 'FOO', occurrence: 2 });
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
if (fail) process.exitCode = 1;
}

// ===== match-engine.rescue-occurrence =====
{
// Regression test (2026-10-15) -- autoRescue must not guess when the caller passes occurrence above 1.
// Run from the package root:   node test/match-engine.rescue-occurrence.test.js
// Pure-function test: no Pulsar, no buffer, no files touched.
//
// matchContent's autoRescue (recover.js profiledMatch) runs only when the exact / fuzzy waterfall found
// NOTHING. It ignores occurrence and reduces its answer to ONE rescued hit (the first), so occurrence:2
// could never mean "the second candidate": it either failed with a misleading "has only 1 match" or
// silently depended on how many near-matches the rescue happened to see. An occurrence above 1 cannot
// refer to anything the engine listed (there were no exact matches to list), so the rescue is skipped
// and the failure is a plain noMatch that diagnose() explains. No occurrence and occurrence:1 still rescue.

const assert = require('assert');
const { resolveScope, matchContent } = require('../lib/match-engine');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

// A line that needs BOTH a whitespace fix (extra indent) and a unicode fix (curly quotes) to equal the
// needle, so only the combined rescue can find it.
const NEEDLE = 'const x = "foo";';
const FUZZY  = '    const x = \u201Cfoo\u201D;';
const one = ['alpha', FUZZY, 'beta'];
const two = ['alpha', FUZZY, 'beta', FUZZY, 'gamma'];

function run(lines, needle, opts) {
  const text = lines.join('\n');
  const scope = resolveScope({ editor: null, buffer: null, allLines: lines, text, filePath: 'x.js', params: {} });
  assert.ok(!scope.error, 'scope error: ' + JSON.stringify(scope.error));
  return matchContent(needle, { allLines: lines, text }, scope, opts || {});
}

// -- rescue still works for no occurrence and occurrence 1 -----------------------------------------
t('one fuzzy candidate, no occurrence: rescued', () => {
  const r = run(one, NEEDLE);
  assert.strictEqual(r.matched, true, JSON.stringify(r));
  assert.strictEqual(r.matchLine, 1);
});
t('one fuzzy candidate, occurrence 1: rescued', () => {
  const r = run(one, NEEDLE, { occurrence: 1 });
  assert.strictEqual(r.matched, true, JSON.stringify(r));
  assert.strictEqual(r.matchLine, 1);
});
t('autoRescue:false: no rescue at all, plain noMatch', () => {
  const r = run(one, NEEDLE, { autoRescue: false });
  assert.strictEqual(r.matched, false);
  assert.strictEqual(r.reason, 'noMatch');
});

// -- occurrence above 1: the rescue is skipped, nothing is guessed -----------------------------------
t('one fuzzy candidate, occurrence 2: noMatch, not "has only 1 match"', () => {
  const r = run(one, NEEDLE, { occurrence: 2 });
  assert.strictEqual(r.matched, false, JSON.stringify(r));
  assert.strictEqual(r.reason, 'noMatch', JSON.stringify(r));
});
t('two fuzzy candidates, occurrence 2: noMatch, not a silent pick of either', () => {
  const r = run(two, NEEDLE, { occurrence: 2 });
  assert.strictEqual(r.matched, false, JSON.stringify(r));
  assert.strictEqual(r.reason, 'noMatch', JSON.stringify(r));
});
t('one fuzzy candidate, occurrence 9: noMatch', () => {
  const r = run(one, NEEDLE, { occurrence: 9 });
  assert.strictEqual(r.matched, false);
  assert.strictEqual(r.reason, 'noMatch', JSON.stringify(r));
});

// -- an invalid occurrence is still refused loudly, not turned into a quiet noMatch -------------------
for (const bad of [0, -1, 1.5]) {
  t('one fuzzy candidate, occurrence ' + bad + ': still refused as out of range', () => {
    const r = run(one, NEEDLE, { occurrence: bad });
    assert.strictEqual(r.matched, false, JSON.stringify(r));
    assert.strictEqual(r.reason, 'occurrenceOutOfRange', JSON.stringify(r));
  });
}

// -- exact matches never go near the rescue ------------------------------------------------------------
t('two exact matches, occurrence 2: picks the second (rescue not involved)', () => {
  const r = run(['dup', 'x', 'dup'], 'dup', { occurrence: 2 });
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.matchLine, 2);
});
t('two exact matches, occurrence 3: out of range, as before', () => {
  const r = run(['dup', 'x', 'dup'], 'dup', { occurrence: 3 });
  assert.strictEqual(r.reason, 'occurrenceOutOfRange');
  assert.strictEqual(r.totalMatches, 2);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
}

console.log = __log; console.log(__p + ' passed, ' + __f + ' failed');
