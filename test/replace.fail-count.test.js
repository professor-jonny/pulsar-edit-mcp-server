'use strict';
// R3m (2026-11-07): a failed `replace` content match must be counted ONCE in the stats headline.
//
// Bug: the replace handler bumped fails.noMatch itself and then called buildFailResponse, whose
// diagnoseFailure() bumps the shared diagnosis key (noMatch / whitespace / encoding / comment /
// partialMatch) for the same failure. replace is not flagged parallelDiag (its own key IS noMatch),
// so the headline summed both and every failed call counted twice. A content-ambiguous failure was
// counted nowhere: the handler bumped fails.ambiguous, a key replace does not have (bump() drops
// unknown keys silently), and that path never reaches diagnoseFailure.
//
// Fix: buildCountedFailResponse(args, ownKey) in lib/match-engine.js = buildFailResponse plus ONE count
// per failed call: the handler's own key is bumped only when diagnoseFailure did not already count it
// (the response carries a non-enumerable diagBumped flag). The replace handler calls it.
//
// Run from the package root:   node test/replace.fail-count.test.js
// Plain Node, no Pulsar needed (SESSION_DIR / STATS_PATH are null outside Pulsar).

const assert = require('assert');
const eng    = require('../lib/match-engine');
const stats  = require('../lib/edit-stats');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const buf = [
  'function alpha() {',   // L1
  '  const total = 1;',   // L2
  '  return total;',      // L3
  '}',                    // L4
  '',                     // L5
  'function beta() {',    // L6
  '  const count = 2;',   // L7
  '  return count;',      // L8
  '}',                    // L9
  'function gamma() {',   // L10
  '  const total = 1;',   // L11
  '  return total;',      // L12
  '}',                    // L13
];
const mk = () => ({ consec: { count: 1 }, allLines: buf, text: buf.join('\n') });
const sc = (o) => Object.assign({ searchStart: 0, searchEnd: buf.length - 1, scopeLabel: '', _hasScope: false, via: 'none', hints: {} }, o);

// The key the replace handler passes as ownKey (same rule as in mcp-registration.js).
const ownKeyFor = (match) => (match.reason === 'ambiguous' ? 'fails.anchorAmbiguous' : 'fails.noMatch');

function snap() {
  const f = stats.editStats.replace.fails;
  let sum = 0;
  for (const k of Object.keys(f)) if (k !== 'foundOutsideScope') sum += f[k];
  return { faults: stats.summarise(stats.editStats).editFaults, sum, f: Object.assign({}, f) };
}

// Runs one failed replace through the counted helper and reports what moved in the stats.
function run(match, needle, scope) {
  const before = snap();
  const r = eng.buildCountedFailResponse({ tool: 'replace', ctx: mk(), scope: scope || sc(), match, needle, isCodeFile: true }, ownKeyFor(match));
  const after = snap();
  return { r, dFaults: after.faults - before.faults, dSum: after.sum - before.sum, d: (k) => after.f[k] - before.f[k] };
}

check('buildCountedFailResponse is exported', () => {
  assert.strictEqual(typeof eng.buildCountedFailResponse, 'function');
});

check('stats are not persisted by this test (STATS_PATH is null)', () => {
  assert.strictEqual(stats.STATS_PATH, null);
});

check('replace fails block has no "ambiguous" key (why the old bump was lost)', () => {
  assert.strictEqual(Object.prototype.hasOwnProperty.call(stats.editStats.replace.fails, 'ambiguous'), false);
  assert.strictEqual(typeof stats.editStats.replace.fails.anchorAmbiguous, 'number');
});

check('noMatch: needle absent counts ONE fault, one noMatch', () => {
  const x = run({ matched: false, reason: 'notFound' }, 'zzz_absent();');
  assert.strictEqual(x.dFaults, 1, 'headline faults moved by ' + x.dFaults);
  assert.strictEqual(x.d('noMatch'), 1, 'fails.noMatch moved by ' + x.d('noMatch'));
  assert.strictEqual(x.dSum, 1, 'sum of fails.* moved by ' + x.dSum);
});

check('partialMatch: counts ONE fault, in partialMatch only', () => {
  const x = run({ matched: false, reason: 'notFound' }, 'function alpha() {\n  const total = 1;\n  return WRONG;');
  assert.strictEqual(x.dFaults, 1, 'headline faults moved by ' + x.dFaults);
  assert.strictEqual(x.d('partialMatch'), 1, 'fails.partialMatch moved by ' + x.d('partialMatch'));
  assert.strictEqual(x.d('noMatch'), 0, 'fails.noMatch moved by ' + x.d('noMatch'));
  assert.strictEqual(x.dSum, 1);
});

check('whitespace-only difference: counts ONE fault', () => {
  const x = run({ matched: false, reason: 'notFound' }, '\tconst count = 2;');
  assert.strictEqual(x.dFaults, 1, 'headline faults moved by ' + x.dFaults);
  assert.strictEqual(x.dSum, 1, 'sum of fails.* moved by ' + x.dSum);
});

check('found outside the scope: counts ONE fault (foundOutsideScope is a flag, not a failure)', () => {
  const scope = sc({ searchStart: 0, searchEnd: 3, scopeLabel: ' within function "alpha"', _hasScope: true, via: 'inFunction', hints: { inFunction: 'alpha' } });
  const x = run({ matched: false, reason: 'notFound' }, 'const count = 2;', scope);
  assert.strictEqual(x.dFaults, 1, 'headline faults moved by ' + x.dFaults);
  assert.strictEqual(x.d('foundOutsideScope'), 1);
  assert.strictEqual(x.dSum, 1);
});

check('occurrenceOutOfRange (never reaches the diagnosis): counts ONE fault in noMatch', () => {
  const x = run({ matched: false, reason: 'occurrenceOutOfRange', totalMatches: 2, matchLines: [2, 11], occurrence: 5 }, '  const total = 1;');
  assert.strictEqual(x.dFaults, 1, 'headline faults moved by ' + x.dFaults);
  assert.strictEqual(x.d('noMatch'), 1);
  assert.strictEqual(x.dSum, 1);
});

check('ambiguous content match: counts ONE fault in anchorAmbiguous (was counted nowhere)', () => {
  const x = run({ matched: false, reason: 'ambiguous', matchLines: [2, 11] }, '  const total = 1;');
  assert.ok(x.r.content[0].text.includes('AMBIGUOUS'), 'expected the ambiguity message');
  assert.strictEqual(x.dFaults, 1, 'headline faults moved by ' + x.dFaults);
  assert.strictEqual(x.d('anchorAmbiguous'), 1, 'fails.anchorAmbiguous moved by ' + x.d('anchorAmbiguous'));
  assert.strictEqual(x.d('noMatch'), 0);
  assert.strictEqual(x.dSum, 1);
});

check('five failures in a row move the headline by exactly five', () => {
  const before = snap().faults;
  run({ matched: false, reason: 'notFound' }, 'zzz_one();');
  run({ matched: false, reason: 'notFound' }, 'zzz_two();');
  run({ matched: false, reason: 'ambiguous', matchLines: [2, 11] }, '  const total = 1;');
  run({ matched: false, reason: 'occurrenceOutOfRange', totalMatches: 2, matchLines: [2, 11], occurrence: 3 }, '  const total = 1;');
  run({ matched: false, reason: 'notFound' }, 'function alpha() {\n  const total = 1;\n  return WRONG;');
  assert.strictEqual(snap().faults - before, 5);
});

check('the response text is identical to buildFailResponse (counting changes no message)', () => {
  const args = { tool: 'replace', ctx: mk(), scope: sc(), match: { matched: false, reason: 'notFound' }, needle: 'zzz_absent();', isCodeFile: true };
  const a = eng.buildFailResponse(args);
  const b = eng.buildCountedFailResponse(Object.assign({}, args, { ctx: mk() }), 'fails.noMatch');
  assert.strictEqual(b.content[0].text, a.content[0].text);
});

check('the diagBumped flag is invisible to spread, keys and JSON (nothing leaks into tool results)', () => {
  const r = eng.buildFailResponse({ tool: 'replace', ctx: mk(), scope: sc(), match: { matched: false, reason: 'notFound' }, needle: 'zzz_absent();', isCodeFile: true });
  assert.strictEqual(r.diagBumped, true, 'content failures must carry the flag');
  assert.strictEqual(Object.keys(r).includes('diagBumped'), false);
  assert.strictEqual(({ ...r }).diagBumped, undefined);
  assert.strictEqual(JSON.stringify(r).includes('diagBumped'), false);
});

check('paths that skip the diagnosis carry no flag (ambiguous, occurrenceOutOfRange)', () => {
  const amb = eng.buildFailResponse({ tool: 'replace', ctx: mk(), scope: sc(), match: { matched: false, reason: 'ambiguous', matchLines: [2, 11] }, needle: '  const total = 1;', isCodeFile: true });
  const occ = eng.buildFailResponse({ tool: 'replace', ctx: mk(), scope: sc(), match: { matched: false, reason: 'occurrenceOutOfRange', totalMatches: 2, matchLines: [2, 11], occurrence: 5 }, needle: '  const total = 1;', isCodeFile: true });
  assert.ok(!amb.diagBumped);
  assert.ok(!occ.diagBumped);
});

check('parallelDiag tools are unchanged: insert still counts its own key AND the shared one (headline 1)', () => {
  // insert's call site bumps anchorNotFound itself, then buildFailResponse bumps the shared key; the
  // registry flag parallelDiag keeps the headline at one. buildFailResponse itself must not change.
  const f0 = stats.summarise(stats.editStats).editFaults;
  stats.bump('insert', 'fails.anchorNotFound');
  eng.buildFailResponse({ tool: 'insert', ctx: mk(), scope: sc(), match: { matched: false, reason: 'notFound' }, needle: 'zzz_absent();', isCodeFile: true });
  assert.strictEqual(stats.summarise(stats.editStats).editFaults - f0, 1);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
