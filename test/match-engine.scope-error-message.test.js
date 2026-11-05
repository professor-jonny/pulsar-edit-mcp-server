'use strict';
// Regression test (2026-10-14) -- an occurrence PAST the matches of a symbol or string hint must be
// reported as out of range, not as "ambiguous -- use occurrence:N".
// Run from the package root:   node test/match-engine.scope-error-message.test.js
// Pure-function test: no Pulsar, no buffer, no files touched.
//
// Before 2026-10-14, replace-function-body {inFunction:'dupfn', occurrence:5} with two dupfn
// definitions answered "Use occurrence:N to disambiguate." although occurrence WAS passed. The same
// held for afterFunction / beforeFunction / afterSymbol / beforeSymbol / afterString / beforeString.
// resolveScope now tags the 'ambiguous' error with the occurrence the caller passed, and
// buildFailResponse words it like the structural-anchor (banner / ifdefBlock) out-of-range message.

const assert = require('assert');
const { resolveScope, buildFailResponse, scopeErrorIsOutOfRange } = require('../lib/match-engine');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

const fnLines = ['function dupfn() {', '  return 1;', '}', 'function dupfn() {', '  return 2;', '}'];
const strLines = ['alpha', 'dup', 'b', 'dup', 'c', 'dup'];

function failText(lines, filePath, params) {
  const base = { editor: null, buffer: null, allLines: lines, text: lines.join('\n'), filePath };
  const scope = resolveScope(Object.assign({}, base, { params }));
  assert.ok(scope.error, 'expected a scope error, got ' + JSON.stringify(scope).slice(0, 120));
  const r = buildFailResponse({ tool: 'replace-function-body', ctx: { consec: {}, allLines: lines, text: base.text },
    scope, needle: 'x', isCodeFile: true });
  return { text: r.content[0].text, ambiguous: r.ambiguous };
}

// -- symbol hints, occurrence past the end ---------------------------------------------
t('inFunction, 2 definitions, occurrence 5: out-of-range wording', () => {
  const r = failText(fnLines, 'x.js', { inFunction: 'dupfn', occurrence: 5 });
  assert.ok(r.text.includes('has only 2 matches'), r.text);
  assert.ok(r.text.includes('lines 1, 4'), r.text);
  assert.ok(r.text.includes('occurrence:5 was requested'), r.text);
  assert.ok(r.text.includes('between 1 and 2'), r.text);
  assert.ok(!r.text.includes('to disambiguate'), r.text);
  assert.strictEqual(r.ambiguous, true);
});
t('afterFunction, 2 definitions, occurrence 7: out-of-range wording', () => {
  const r = failText(fnLines, 'x.js', { afterFunction: 'dupfn', occurrence: 7 });
  assert.ok(r.text.includes('afterFunction'), r.text);
  assert.ok(r.text.includes('has only 2 matches'), r.text);
  assert.ok(r.text.includes('occurrence:7 was requested'), r.text);
  assert.ok(!r.text.includes('to disambiguate'), r.text);
});

// -- string hints, occurrence past the end ---------------------------------------------
t('afterString, 3 lines, occurrence 9: out-of-range wording', () => {
  const r = failText(strLines, 'x.txt', { afterString: 'dup', occurrence: 9 });
  assert.ok(r.text.includes('has only 3 matches'), r.text);
  assert.ok(r.text.includes('lines 2, 4, 6'), r.text);
  assert.ok(r.text.includes('occurrence:9 was requested'), r.text);
  assert.ok(!r.text.includes('to disambiguate'), r.text);
  assert.ok(!r.text.includes('more unique anchor'), r.text);
});
t('beforeString, 3 lines, occurrence 4: out-of-range wording', () => {
  const r = failText(strLines, 'x.txt', { beforeString: 'dup', occurrence: 4 });
  assert.ok(r.text.includes('has only 3 matches'), r.text);
  assert.ok(r.text.includes('occurrence:4 was requested'), r.text);
});

// -- occurrence that is not a positive integer: refused with a message, never a crash ---------
// occurrence counts occurrences (lines), so 0, a negative number and a fraction can never be
// right. Before 2026-10-14 they slipped past "occurrence <= matches.length" and resolveScope
// threw "Cannot read properties of undefined (reading 'startRow')".
for (const bad of [0, -1, 1.5]) {
  t('inFunction, 2 definitions, occurrence ' + bad + ': refused with a message, no throw', () => {
    const r = failText(fnLines, 'x.js', { inFunction: 'dupfn', occurrence: bad });
    assert.ok(r.text.includes('occurrence:' + bad + ' was requested'), r.text);
    assert.ok(r.text.includes('between 1 and 2'), r.text);
    assert.strictEqual(r.ambiguous, true);
  });
  t('afterFunction, 2 definitions, occurrence ' + bad + ': refused with a message, no throw', () => {
    const r = failText(fnLines, 'x.js', { afterFunction: 'dupfn', occurrence: bad });
    assert.ok(r.text.includes('occurrence:' + bad + ' was requested'), r.text);
  });
  t('afterString, 3 lines, occurrence ' + bad + ': refused with a message, no throw', () => {
    const r = failText(strLines, 'x.txt', { afterString: 'dup', occurrence: bad });
    assert.ok(r.text.includes('occurrence:' + bad + ' was requested'), r.text);
    assert.ok(r.text.includes('between 1 and 3'), r.text);
  });
  t('beforeString, 3 lines, occurrence ' + bad + ': counted as out of range', () => {
    const s = resolveScope({ editor: null, buffer: null, allLines: strLines, text: strLines.join('\n'),
      filePath: 'x.txt', params: { beforeString: 'dup', occurrence: bad } });
    assert.ok(s.error, 'expected a scope error');
    assert.strictEqual(scopeErrorIsOutOfRange(s.error, bad), true);
  });
}
// -- wording: a non-whole or non-positive occurrence is told WHY, a whole one past the end is not ---
for (const bad of [0, -1, 1.5]) {
  t('occurrence ' + bad + ' is told an occurrence is a whole number from 1', () => {
    const r = failText(fnLines, 'x.js', { inFunction: 'dupfn', occurrence: bad });
    assert.ok(r.text.includes('must be a whole number between 1 and 2'), r.text);
    assert.ok(r.text.includes('counts matches from 1'), r.text);
  });
}
t('whole occurrence past the end keeps the plain use-an-occurrence advice', () => {
  const r = failText(fnLines, 'x.js', { inFunction: 'dupfn', occurrence: 5 });
  assert.ok(r.text.includes('use an occurrence between 1 and 2'), r.text);
  assert.ok(!r.text.includes('whole number'), r.text);
});
t('valid occurrence 2 still resolves (inFunction and afterString)', () => {
  const a = resolveScope({ editor: null, buffer: null, allLines: fnLines, text: fnLines.join('\n'),
    filePath: 'x.js', params: { inFunction: 'dupfn', occurrence: 2 } });
  assert.ok(!a.error, 'inFunction occurrence 2 must resolve');
  assert.strictEqual(a.occurrenceConsumed, true);
  const b = resolveScope({ editor: null, buffer: null, allLines: strLines, text: strLines.join('\n'),
    filePath: 'x.txt', params: { afterString: 'dup', occurrence: 3 } });
  assert.ok(!b.error, 'afterString occurrence 3 must resolve');
});

// -- no occurrence: the original advice must be unchanged -------------------------------
t('inFunction, 2 definitions, no occurrence: still says use occurrence:N', () => {
  const r = failText(fnLines, 'x.js', { inFunction: 'dupfn' });
  assert.ok(r.text.includes('Use occurrence:N to disambiguate.'), r.text);
  assert.ok(!r.text.includes('was requested'), r.text);
  assert.strictEqual(r.ambiguous, true);
});
t('afterString, 3 lines, no occurrence: still says use a more unique anchor', () => {
  const r = failText(strLines, 'x.txt', { afterString: 'dup' });
  assert.ok(r.text.includes('more unique anchor string'), r.text);
  assert.ok(!r.text.includes('was requested'), r.text);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
