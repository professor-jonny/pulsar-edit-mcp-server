'use strict';
// Regression test: lifetime stats must not be double-counted.
//
// Bug (found 2026-09-24): bump() wrote session AND lifetime, then
// syncToLifetime() -- run on a 5s timer, on every get-edit-stats read, on
// reset and on exit -- added (session - shadow) to lifetime AGAIN, so lifetime
// read exactly 2x session. Fix: syncToLifetime() is a no-op.
//
// Run: cmd /c "node test\edit-stats.no-double-count.test.js 2>nul"
// SESSION_DIR is null outside Pulsar (atom is undefined), so this test can never
// touch the real session/session-stats.json.

const assert = require('assert');
const path   = require('path');
const stats  = require(path.join(__dirname, '..', 'lib', 'edit-stats.js'));

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// Guard: the test must not run against real persisted stats.
check('STATS_PATH is null (cannot write real stats file)', () => {
  assert.strictEqual(stats.STATS_PATH, null);
});

const s0 = stats.editStats.str_replace.hits;
const l0 = stats.lifetimeStats.str_replace.hits;

check('bump writes session and lifetime once each', () => {
  for (let i = 0; i < 10; i++) stats.bump('str_replace', 'hits');
  assert.strictEqual(stats.editStats.str_replace.hits - s0, 10);
  assert.strictEqual(stats.lifetimeStats.str_replace.hits - l0, 10);
});

check('syncToLifetime after bumps does NOT add a second copy', () => {
  stats.syncToLifetime();
  assert.strictEqual(stats.lifetimeStats.str_replace.hits - l0, 10, 'lifetime doubled');
});

check('repeated syncs (simulating the 5s timer) stay at N, not growing', () => {
  for (let i = 0; i < 20; i++) stats.syncToLifetime();
  assert.strictEqual(stats.lifetimeStats.str_replace.hits - l0, 10);
});

check('bumps interleaved with syncs stay 1:1 with session', () => {
  for (let i = 0; i < 5; i++) { stats.bump('str_replace', 'hits'); stats.syncToLifetime(); }
  assert.strictEqual(stats.editStats.str_replace.hits - s0, 15);
  assert.strictEqual(stats.lifetimeStats.str_replace.hits - l0, 15);
});

check('nested counters (fails.*) are not doubled either', () => {
  const subs = Object.keys(stats.editStats.str_replace.fails || {});
  assert.ok(subs.length > 0, 'expected str_replace.fails sub-counters');
  const k   = subs[0];
  const fs0 = stats.editStats.str_replace.fails[k];
  const fl0 = stats.lifetimeStats.str_replace.fails[k];
  for (let i = 0; i < 4; i++) stats.bump('str_replace', 'fails.' + k);
  stats.syncToLifetime(); stats.syncToLifetime();
  assert.strictEqual(stats.editStats.str_replace.fails[k] - fs0, 4);
  assert.strictEqual(stats.lifetimeStats.str_replace.fails[k] - fl0, 4);
});

check('resetLastSynced is safe to call and does not change lifetime', () => {
  const before = stats.lifetimeStats.str_replace.hits;
  stats.resetLastSynced();
  stats.syncToLifetime();
  assert.strictEqual(stats.lifetimeStats.str_replace.hits, before);
});

check('style stats stay paired (bumpStyle session == lifetime delta)', () => {
  const rule = Object.keys(stats.styleStats).find(
    k => stats.styleStats[k] && typeof stats.styleStats[k].introduced === 'number');
  assert.ok(rule, 'expected at least one style rule');
  const a0 = stats.styleStats[rule].introduced;
  const b0 = stats.lifetimeStyleStats[rule].introduced;
  stats.bumpStyle(rule, 3);
  stats.syncToLifetime();
  assert.strictEqual(stats.styleStats[rule].introduced - a0, 3);
  assert.strictEqual(stats.lifetimeStyleStats[rule].introduced - b0, 3);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
