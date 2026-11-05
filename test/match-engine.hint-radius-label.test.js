'use strict';
// Regression test (2026-10-15) -- the afterLine / beforeLine drift nudge must print the window the
// caller actually used, not always the default.
// Run from the package root:   node test/match-engine.hint-radius-label.test.js
// Pure-function test: no Pulsar, no buffer, no files touched.
//
// The real window always honoured the caller's hintRadius (resolveScope passes it to the line / string /
// symbol resolvers), but the engine handed diagnose() the constant HINT_RADIUS, so a failed edit with
// {afterLine: N, hintRadius: 5} said "window (25 lines)". resolveScope now records the effective radius
// on the scope (scope.hintRadius) and the failure path passes that to diagnose().

const assert = require('assert');
const { resolveScope, matchContent, buildFailResponse } = require('../lib/match-engine');
const { HINT_RADIUS } = require('../lib/tree-sitter-symbols');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

const buf = [];
for (let i = 1; i <= 30; i++) buf.push('const v' + i + ' = ' + i + ';');
const text = buf.join('\n');
const miss = { matched: false, reason: 'notFound' };

function scopeFor(params) {
  const s = resolveScope({ editor: null, buffer: null, allLines: buf, text, filePath: 'x.js', params });
  assert.ok(!s.error, 'scope error: ' + JSON.stringify(s.error));
  return s;
}
function failText(scope, needle) {
  const r = buildFailResponse({ tool: 'delete', ctx: { consec: { count: 1 }, allLines: buf, text },
    scope, match: miss, needle: needle || 'zzz_absent();', isCodeFile: true });
  return r.content[0].text;
}

// -- the label follows the caller's radius ---------------------------------------------------------
t('afterLine with hintRadius 5: label says 5 lines', () => {
  const txt = failText(scopeFor({ afterLine: 1, hintRadius: 5 }));
  assert.ok(txt.includes('afterLine:1 window (5 lines)'), txt);
  assert.ok(!txt.includes('(' + HINT_RADIUS + ' lines)'), txt);
});
t('beforeLine with hintRadius 7: label says 7 lines', () => {
  const txt = failText(scopeFor({ beforeLine: 30, hintRadius: 7 }));
  assert.ok(txt.includes('beforeLine:30 window (7 lines)'), txt);
});
t('afterLine with a radius larger than the default: label says 40 lines', () => {
  const txt = failText(scopeFor({ afterLine: 1, hintRadius: 40 }));
  assert.ok(txt.includes('afterLine:1 window (40 lines)'), txt);
});
t('no hintRadius: label still says the default', () => {
  const txt = failText(scopeFor({ afterLine: 1 }));
  assert.ok(txt.includes('afterLine:1 window (' + HINT_RADIUS + ' lines)'), txt);
});

// -- the label and the real window agree -------------------------------------------------------------
t('the real window honours hintRadius: v13 is outside 5 lines of line 1, inside the default', () => {
  const near = matchContent('const v13 = 13;', { allLines: buf, text }, scopeFor({ afterLine: 1, hintRadius: 5 }), {});
  assert.strictEqual(near.matched, false, JSON.stringify(near));
  const dflt = matchContent('const v13 = 13;', { allLines: buf, text }, scopeFor({ afterLine: 1 }), {});
  assert.strictEqual(dflt.matched, true, JSON.stringify(dflt));
});

// -- nothing else changes ----------------------------------------------------------------------------
t('a non-line hint prints no window label, with or without hintRadius', () => {
  const txt = failText(scopeFor({ afterString: 'const v2 = 2;', hintRadius: 5 }));
  assert.ok(!txt.includes('window ('), txt);
});
t('the radius is NOT added to scope.hints (hints feed the fault log and classify())', () => {
  const s = scopeFor({ afterLine: 1, hintRadius: 5 });
  assert.ok(!('hintRadius' in s.hints), JSON.stringify(s.hints));
  assert.strictEqual(s.hints.afterLine, 1);
});
t('a hand-built scope without hintRadius falls back to the default', () => {
  const s = { _hasScope: true, via: 'afterLine', hints: { afterLine: 2 } };
  const txt = failText(s);
  assert.ok(txt.includes('afterLine:2 window (' + HINT_RADIUS + ' lines)'), txt);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
