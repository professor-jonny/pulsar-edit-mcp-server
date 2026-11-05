'use strict';
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
process.exit(fail ? 1 : 0);
