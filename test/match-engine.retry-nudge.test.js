'use strict';
// Regression test (2026-10-17) -- retry support for replace (TODO R1a and R1b).
// Run from the package root:   node test/match-engine.retry-nudge.test.js
// Plain node, no Pulsar, no buffer, no files written. Reads lib/mcp-registration.js as TEXT only.
//
// What is pinned:
//   1. retryNudge() (lib/match-engine.js) knows replace: its field is old_str, like str_replace.
//   2. The four tools that already had a nudge are unchanged, and a tool with no entry gets ''.
//   3. Every tool registered with features.retryOnFail has a retryNudge that names the same field
//      (the comment above RETRY_FIELD_BY_TOOL says "keep in sync"; this makes it a check).
//   4. replace's schema makes new_str optional (so a bare { filePath, old_str } retry passes MCP
//      validation) and its handler refuses a call that still has no new_str, WITHOUT a matched key
//      (a matched:false result would stash a useless pending failure and overwrite a good one).
//   5. isRetryableRefusal() (lib/replace-fragment.js): which fragment-mode refusals can be fixed by
//      sending a corrected old_str, and therefore get matched:false plus the nudge.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { retryNudge } = require('../lib/match-engine');
const replaceFragment = require('../lib/replace-fragment');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

const regSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');

// -- 1 and 2: the nudge text ------------------------------------------------------------
t('retryNudge(replace) names old_str and replace', () => {
  const n = retryNudge('replace');
  assert.ok(n.length > 0, 'expected a nudge for replace, got an empty string');
  assert.ok(n.includes('call replace again with just { filePath, old_str:'), n);
});

t('retryNudge: the four existing tools are unchanged', () => {
  assert.ok(retryNudge('str_replace').includes('call str_replace again with just { filePath, old_str:'));
  assert.ok(retryNudge('delete').includes('call delete again with just { filePath, matchString:'));
  assert.ok(retryNudge('replace-block').includes('call replace-block again with just { filePath, anchor:'));
  assert.ok(retryNudge('replace-function-body').includes('call replace-function-body again with just { filePath, anchor:'));
});

t('retryNudge: a tool with no entry gets an empty string', () => {
  assert.strictEqual(retryNudge('read'), '');
  assert.strictEqual(retryNudge('insert'), '');
  assert.strictEqual(retryNudge(undefined), '');
});

// -- 3: registrations and the nudge table agree ------------------------------------------
t('every features.retryOnFail registration has a matching retryNudge field', () => {
  const lines = regSrc.split('\n');
  let lastName = null, lastNameLine = -1;
  const found = {};
  for (let i = 0; i < lines.length; i++) {
    const nm = lines[i].match(/^\s*name:\s*['"]([^'"]+)['"],/);
    if (nm) { lastName = nm[1]; lastNameLine = i; }
    const rf = lines[i].match(/retryOnFail:\s*\{\s*field:\s*['"]([^'"]+)['"]/);
    if (rf) {
      assert.ok(lastName && i - lastNameLine <= 15, 'retryOnFail on line ' + (i + 1) + ' has no tool name just above it');
      found[lastName] = rf[1];
    }
  }
  const names = Object.keys(found);
  // Only str_replace and replace register retryOnFail (delete, replace-block and
  // replace-function-body have a nudge table entry but no registration: TODO I4).
  assert.ok(names.length >= 2, 'expected at least str_replace and replace, found ' + names.join(', '));
  names.forEach((tool) => {
    assert.ok(retryNudge(tool).includes('just { filePath, ' + found[tool] + ':'),
      tool + ' registers retryOnFail field ' + found[tool] + ' but retryNudge does not name it');
  });
});

t('replace is registered with features.retryOnFail on old_str', () => {
  const m = regSrc.match(/name:\s*'replace',[\s\S]{0,400}?retryOnFail:\s*\{\s*field:\s*'([^']+)'/);
  assert.ok(m, 'no retryOnFail near the replace registration');
  assert.strictEqual(m[1], 'old_str');
});

// -- 4: optional new_str is safe ---------------------------------------------------------
function replaceBlock() {
  const start = regSrc.search(/name:\s*'replace',/);
  assert.ok(start >= 0, 'replace registration not found');
  const rest = regSrc.slice(start);
  const next = rest.slice(10).search(/\n  if \(g\('[a-z]+'\)\) registerMcpTool\(\{/);
  return next >= 0 ? rest.slice(0, next + 10) : rest.slice(0, 20000);
}

t('replace schema: new_str is optional (so a bare retry passes MCP validation)', () => {
  assert.ok(/new_str:\s*z\.string\(\)\.optional\(\)/.test(replaceBlock()), 'new_str must be z.string().optional()');
});

t('replace handler: a call that still has no new_str is refused, with no matched key', () => {
  const b = replaceBlock();
  const at = b.indexOf('if (new_str === undefined)');
  assert.ok(at >= 0, 'replace handler has no new_str === undefined guard');
  const guard = b.slice(at, at + 700).split('\n      }\n')[0];
  assert.ok(/return \{ content:/.test(guard), 'the guard must return a refusal: ' + guard);
  assert.ok(!/\bmatched\s*:/.test(guard), 'the guard must not set matched (it would stash a useless failure): ' + guard);
  assert.ok(!/found:\s*true/.test(guard), 'the guard must not look like a success');
});

t('replace handler: the new_str guard comes before the empty and identical old_str guards', () => {
  const b = replaceBlock();
  const g = b.indexOf('if (new_str === undefined)');
  const e = b.indexOf("if (old_str === '')");
  const i = b.indexOf('if (old_str === new_str)');
  assert.ok(g >= 0 && e >= 0 && i >= 0, 'guards missing');
  assert.ok(g < e && g < i, 'new_str guard must run first');
});

// -- 5: which fragment refusals are retryable --------------------------------------------
t('isRetryableRefusal is exported', () => {
  assert.strictEqual(typeof replaceFragment.isRetryableRefusal, 'function');
});

t('isRetryableRefusal: not found, ambiguous and glued-to-identifier are retryable', () => {
  const f = replaceFragment.isRetryableRefusal;
  assert.strictEqual(f('noMatch'), true);
  assert.strictEqual(f('ambiguous'), true);
  assert.strictEqual(f('onlyIdentifierGlued'), true);
});

t('isRetryableRefusal: flag clash, occurrence range, drift, write error and unknowns are not', () => {
  const f = replaceFragment.isRetryableRefusal;
  assert.strictEqual(f('fragmentUnsupportedFlag'), false);
  assert.strictEqual(f('occurrenceOutOfRange'), false);
  assert.strictEqual(f('fragmentDrift'), false);
  assert.strictEqual(f('applyEditSpanError'), false);
  assert.strictEqual(f('invalidInput'), false);
  assert.strictEqual(f(undefined), false);
  assert.strictEqual(f('somethingElse'), false);
});

t('isRetryableRefusal agrees with the planner: refusals built from a real plan', () => {
  const lines = ['let discount = 1;', 'dup', 'dup'];
  const none = replaceFragment.planFragmentReplace({ lines, oldStr: 'zzz', newStr: 'y' });
  assert.strictEqual(none.ok, false);
  assert.strictEqual(replaceFragment.isRetryableRefusal(none.reason), true, 'reason ' + none.reason);
  const amb = replaceFragment.planFragmentReplace({ lines, oldStr: 'dup', newStr: 'y' });
  assert.strictEqual(replaceFragment.isRetryableRefusal(amb.reason), true, 'reason ' + amb.reason);
  const glued = replaceFragment.planFragmentReplace({ lines, oldStr: 'count', newStr: 'y' });
  assert.strictEqual(replaceFragment.isRetryableRefusal(glued.reason), true, 'reason ' + glued.reason);
  const oor = replaceFragment.planFragmentReplace({ lines, oldStr: 'dup', newStr: 'y', occurrence: 9 });
  assert.strictEqual(replaceFragment.isRetryableRefusal(oor.reason), false, 'reason ' + oor.reason);
  const flag = replaceFragment.planFragmentReplace({ lines, oldStr: 'dup', newStr: 'y', flags: { fuzzyWhitespace: true } });
  assert.strictEqual(replaceFragment.isRetryableRefusal(flag.reason), false, 'reason ' + flag.reason);
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
