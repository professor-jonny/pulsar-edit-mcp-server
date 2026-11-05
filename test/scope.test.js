'use strict';
// Aggregated summary: the runner reads only the LAST 'N passed, M failed' line, so each block's line is folded into one total printed at the end.
let __p = 0, __f = 0; const __log = console.log.bind(console);
console.log = (...a) => { const m = /(\d+) passed, (\d+) failed/.exec(a.map(String).join(' ')); if (m) { __p += Number(m[1]); __f += Number(m[2]); } else __log(...a); };
// Merged 2026-11-19 from: scope-arg.test.js, scope-loose.test.js, scope-rollout.test.js.
// Each former file runs in its own block, so names and pass/fail counters stay separate. Run: node test/scope.test.js

// ===== scope-arg =====
{
// XW23 idea 1, step 1 (2026-11-18): an optional `scope` object carries the position hints, so a tool shows one field instead
// of a dozen. lib/scope-arg.js holds the key list, the zod schema and the pure flattenScope(args); the tool framework calls
// flattenScope before any handler runs, so handlers keep reading the flat names. Top-level hints win over scope ones.
// Run: node test/scope-arg.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SCOPE_KEYS, SCOPE_OBJECT_SCHEMA, SCOPE_STRICT_SCHEMA, flattenScope } = require('../lib/scope-arg');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

t('the key list is the position hints and nothing else', () => {
  const want = ['inFunction', 'afterFunction', 'beforeFunction', 'afterSymbol', 'beforeSymbol', 'afterString', 'beforeString',
    'afterLine', 'beforeLine', 'betweenHint', 'hintRadius', 'banner', 'ifdefBlock', 'ifdefEdge'];
  assert.deepStrictEqual(SCOPE_KEYS.slice().sort(), want.slice().sort());
});
t('no scope: args returned unchanged (same object)', () => {
  const a = { filePath: 'x', old_str: 'a', afterString: 'q' };
  assert.strictEqual(flattenScope(a), a);
});
t('scope keys are lifted to the top level and scope is removed', () => {
  const r = flattenScope({ filePath: 'x', old_str: 'a', scope: { inFunction: 'f', afterLine: 10 } });
  assert.strictEqual(r.inFunction, 'f');
  assert.strictEqual(r.afterLine, 10);
  assert.ok(!('scope' in r));
  assert.strictEqual(r.filePath, 'x');
});
t('a top-level hint wins over the same key in scope', () => {
  const r = flattenScope({ afterString: 'top', scope: { afterString: 'inner', beforeString: 'b' } });
  assert.strictEqual(r.afterString, 'top');
  assert.strictEqual(r.beforeString, 'b');
});
t('keys that are not position hints are NOT lifted (occurrence, fuzzy flags, new_str)', () => {
  const r = flattenScope({ scope: { occurrence: 2, fuzzyWhitespace: true, new_str: 'x', inFunction: 'f' } });
  assert.strictEqual(r.occurrence, undefined);
  assert.strictEqual(r.fuzzyWhitespace, undefined);
  assert.strictEqual(r.new_str, undefined);
  assert.strictEqual(r.inFunction, 'f');
});
t('undefined or null values inside scope are ignored', () => {
  const r = flattenScope({ scope: { inFunction: undefined, afterString: null, afterLine: 0 } });
  assert.ok(!('inFunction' in r) && !('afterString' in r));
  assert.strictEqual(r.afterLine, 0);
});
t('a non-object scope is ignored, args kept', () => {
  const a = { filePath: 'x', scope: 'nonsense' };
  const r = flattenScope(a);
  assert.strictEqual(r.filePath, 'x');
});
t('input object is not mutated', () => {
  const a = { filePath: 'x', scope: { inFunction: 'f' } };
  flattenScope(a);
  assert.ok('scope' in a && !('inFunction' in a));
});
t('null / undefined args pass through', () => {
  assert.strictEqual(flattenScope(undefined), undefined);
  assert.strictEqual(flattenScope(null), null);
});
t('typed schema (used by checkScope) accepts a valid scope and rejects unknown keys', () => {
  const p = SCOPE_STRICT_SCHEMA.parse({ inFunction: 'f', betweenHint: { start: 'a', end: 'b' } });
  assert.strictEqual(p.inFunction, 'f');
  assert.ok(!SCOPE_STRICT_SCHEMA.safeParse({ inFunction: 'f', junk: 1 }).success);
});
t('the served schema is loose: any object passes, so the typing is checked by checkScope', () => {
  assert.ok(SCOPE_OBJECT_SCHEMA.safeParse({ inFunction: 'f', junk: 1 }).success);
});
t('typed schema rejects a wrong type (afterLine must be a number)', () => {
  assert.ok(!SCOPE_STRICT_SCHEMA.safeParse({ afterLine: 'x' }).success);
});

const fw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tool-framework.js'), 'utf8');
const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
t('the framework flattens scope before the handler runs', () => {
  assert.ok(/flattenScope/.test(fw), 'tool-framework.js does not use flattenScope');
  assert.ok(fw.indexOf('flattenScope(args)') < fw.indexOf('features.resendlessCommit && args'), 'flatten must come before the preview splice');
});
for (const name of ['replace', 'insert']) {
  t(name + ' declares the scope param', () => {
    const i = reg.search(new RegExp("name:\\s+'" + name + "',"));
    assert.ok(i > 0);
    const body = reg.slice(i, i + 9000);
    assert.ok(/scope:\s*SCOPE_OBJECT_SCHEMA/.test(body), 'no scope: SCOPE_OBJECT_SCHEMA in ' + name);
  });
}

// Step 2 (same day, PJ: only user, free to change): the flat hints leave the SCHEMA of tools that declare `scope`, but still
// WORK, because such a tool's schema is made passthrough (unknown keys reach the handler instead of being stripped), so an
// older cached client schema or a description-driven call with flat names keeps working.
const { withoutScopeHints, wrapScopeSchema } = require('../lib/scope-arg');
const { z } = require('zod');
t('withoutScopeHints drops the position hints and keeps everything else', () => {
  const shape = { filePath: z.string(), inFunction: z.string().optional(), afterLine: z.number().optional(), occurrence: z.number().optional(), banner: z.string().optional() };
  const r = withoutScopeHints(shape);
  assert.deepStrictEqual(Object.keys(r).sort(), ['filePath', 'occurrence']);
});
t('wrapScopeSchema: a shape without scope is returned unchanged', () => {
  const shape = { a: z.string() };
  assert.strictEqual(wrapScopeSchema(shape), shape);
});
t('wrapScopeSchema: a shape with scope becomes a passthrough object (flat hints survive parsing)', () => {
  const s = wrapScopeSchema({ filePath: z.string(), scope: SCOPE_OBJECT_SCHEMA });
  const p = s.parse({ filePath: 'x', inFunction: 'f', afterLine: 3 });
  assert.strictEqual(p.inFunction, 'f');
  assert.strictEqual(p.afterLine, 3);
  assert.ok(!s.safeParse({ inFunction: 'f' }).success, 'filePath is still required');
});
t('the framework registers tools through wrapScopeSchema', () => {
  assert.ok(/wrapScopeSchema\(inputSchema\)/.test(fw));
});
for (const name of ['replace', 'insert']) {
  t(name + ' schema is built without the flat hints', () => {
    const i = reg.search(new RegExp("name:\\s+'" + name + "',"));
    const body = reg.slice(i, i + 9000);
    assert.ok(/withoutScopeHints\(/.test(body), 'no withoutScopeHints in ' + name);
  });
}

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
}

// ===== scope-loose =====
{
// 2026-11-19 (XW23): the served `scope` schema is loose with a short description; checkScope() validates a call's scope object
// against the typed schema and the framework refuses a bad one before the handler runs. Run: node test/scope-loose.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SCOPE_KEYS, SCOPE_OBJECT_SCHEMA, checkScope } = require('../lib/scope-arg');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); } }
t('checkScope: absent, null and valid scopes are fine', () => {
  assert.strictEqual(checkScope({ filePath: 'x' }), null);
  assert.strictEqual(checkScope({ scope: null }), null);
  assert.strictEqual(checkScope({ scope: { inFunction: 'f', betweenHint: { start: 'a', end: 'b' }, afterLine: 3, ifdefEdge: 'open' } }), null);
  assert.strictEqual(checkScope(undefined), null);
});
t('checkScope: a string or array scope is refused with an example', () => {
  assert.ok(/must be an object such as \{inFunction/.test(checkScope({ scope: 'inFunction' })));
  assert.ok(/an array/.test(checkScope({ scope: [1] })));
});
t('checkScope: a wrong type names the key and the message lists the valid keys', () => {
  const m = checkScope({ scope: { afterLine: 'x' } });
  assert.ok(/afterLine/.test(m) && /Keys: inFunction/.test(m), m);
});
t('checkScope: an unknown key is named', () => {
  const m = checkScope({ scope: { inFuncton: 'f' } });
  assert.ok(/unknown key\(s\) inFuncton/.test(m), m);
});
t('the served description names every position key', () => {
  const d = SCOPE_OBJECT_SCHEMA.description;
  for (const k of SCOPE_KEYS) assert.ok(d.includes(k), 'description lacks ' + k);
});
t('the served schema is small as JSON schema (under 450 characters)', () => {
  let conv;
  try { conv = require('zod-to-json-schema'); } catch (_) { return; } // not installed: size is checked live instead
  const f = conv.zodToJsonSchema || conv.default;
  const n = JSON.stringify(f(SCOPE_OBJECT_SCHEMA)).length;
  assert.ok(n < 450, 'served scope schema is ' + n + ' characters');
});
t('the framework checks scope before it flattens it, on every registration path', () => {
  const fw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tool-framework.js'), 'utf8');
  const calls = fw.split('args = flattenScope(args);').length - 1;
  const checks = fw.split('checkScope(args)').length - 1;
  assert.ok(calls >= 1 && checks === calls, calls + ' flatten calls, ' + checks + ' checks');
  assert.ok(fw.indexOf('checkScope(args)') < fw.indexOf('args = flattenScope(args);'));
});
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
}

// ===== scope-rollout =====
{
// 2026-11-19 (XW23 idea 1, rollout): delete, read, replace-block, replace-function-body and sed take the position hints as the
// one `scope` object (like replace and insert) instead of 14 flat fields. Source-text test. Run: node test/scope-rollout.test.js
const fs = require('fs');
const path = require('path');
const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); } }
const HINTS = ['inFunction', 'afterFunction', 'beforeFunction', 'afterSymbol', 'beforeSymbol', 'afterString', 'beforeString', 'afterLine', 'beforeLine', 'betweenHint', 'hintRadius', 'banner', 'ifdefBlock', 'ifdefEdge'];
function schemaText(tool) {
  const i = reg.search(new RegExp("name:\\s+['\"]" + tool + "['\"],"));
  if (i < 0) throw new Error(tool + ' not registered');
  const s = reg.indexOf('inputSchema: {', i);
  const e = reg.indexOf('handler:', s);
  if (s < 0 || e < 0) throw new Error('no schema block for ' + tool);
  return reg.slice(s, e);
}
for (const tool of ['delete', 'read', 'replace-function-body', 'sed', 'replace', 'insert']) {
  t(tool + ': scope object, no flat position hints in the schema', () => {
    const b = schemaText(tool);
    if (!/scope:\s*SCOPE_OBJECT_SCHEMA/.test(b)) throw new Error('no scope: SCOPE_OBJECT_SCHEMA');
    const flat = HINTS.filter(h => new RegExp('^\\s*' + h + ':\\s*z\\.', 'm').test(b));
    if (flat.length) throw new Error('still flat: ' + flat.join(', '));
  });
}
t('the shared hint fragments are filtered through withoutScopeHints', () => {
  for (const tool of ['delete', 'replace-function-body', 'sed']) {
    if (!/withoutScopeHints\(/.test(schemaText(tool))) throw new Error(tool + ' does not use withoutScopeHints');
  }
});
t('modifiers stay top-level: read keeps startContent/endContent/centerLine/startLine, delete keeps startContent', () => {
  const r = schemaText('read');
  for (const k of ['startContent', 'endContent', 'centerLine', 'nearLine', 'startLine', 'endLine', 'occurrence']) if (!new RegExp('\\b' + k + ':').test(r)) throw new Error('read lost ' + k);
  if (!/startContent/.test(schemaText('delete'))) throw new Error('delete lost startContent');
  if (!/expression:/.test(schemaText('sed'))) throw new Error('sed lost expression');
});
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
}

console.log = __log; console.log(__p + ' passed, ' + __f + ' failed');
