'use strict';
// Stats pause (2026-11-18): while stats are paused, the persistent fault log (session-faults.ndjson) must not grow either.
// Before this fix only bump() honoured the pause, so deliberate failures during a probe session still landed in the log.
// Runs against a TEMP session folder (a minimal fake `atom` gives the module its folder), never the real session folder.
//   Run: node test/edit-stats.pause-faultlog.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-stats-pause-'));
global.atom = { packages: { getLoadedPackage: () => ({ path: tmp }) } };
const stats = require('../lib/edit-stats');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}
const logPath = path.join(tmp, 'session', 'session-faults.ndjson');
const lines = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length : 0);

t('setup: the module used the temp session folder, not the real one', () => {
  assert.strictEqual(stats.FAILURE_LOG_PATH, logPath);
});
t('unpaused: a failure is appended to the log', () => {
  stats.setStatsPaused(false);
  stats.logFailure({ tool: 'replace', reason: 'noMatch' });
  assert.strictEqual(lines(), 1);
});
t('paused: a failure is NOT appended', () => {
  stats.setStatsPaused(true);
  stats.logFailure({ tool: 'replace', reason: 'ambiguous' });
  stats.logFailure({ tool: 'delete', reason: 'noMatch' });
  assert.strictEqual(lines(), 1);
});
t('paused: the flag reads back as paused', () => {
  assert.strictEqual(stats.getStatsPaused(), true);
});
t('unpaused again: logging resumes', () => {
  stats.setStatsPaused(false);
  stats.logFailure({ tool: 'insert', reason: 'noMatch' });
  assert.strictEqual(lines(), 2);
});

// Registered after the stats module's own exit flush, so the temp folder is removed once that has run.
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ } });
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
