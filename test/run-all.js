'use strict';
// Runs every test/*.test.js in its own node process and prints one line per file.
// Usage:   node test/run-all.js [name-filter]      (npm test runs it with no filter)
// Plain node, no dependencies, no Pulsar needed (the pure modules are tested through fake buffers).
//
// A file PASSES when it exits 0 and prints no line starting with FAIL or NOT OK. When a file prints
// "<N> passed, <M> failed" the counts are summed and M must be 0. A few files print a different
// summary (match-engine.fail-response.test.js prints "probe failures: 0"); for those only the exit
// code and the FAIL scan count, and the check count shows as "-".
// Env vars that point a test at another copy of a lib file (EM_PATH, SP_PATH, ...) belong to the
// mutation harnesses and are not set here.
// Exit code: 0 when every file passes, 1 otherwise (also when no test file matches the filter).
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const dir = __dirname;
const root = path.join(dir, '..');
const filter = process.argv[2] || '';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js') && f.indexOf(filter) >= 0).sort();

if (files.length === 0) {
  console.log('No test files match "' + filter + '" in ' + dir);
  process.exit(1);
}

let totalPassed = 0;
let totalFailedChecks = 0;
let badFiles = 0;
const width = files.reduce((w, f) => Math.max(w, f.length), 0);

for (const f of files) {
  const r = cp.spawnSync(process.execPath, [path.join(dir, f)], { cwd: root, encoding: 'utf8', timeout: 180000 });
  const out = (r.stdout || '');
  const counts = out.match(/(\d+) passed, (\d+) failed/g);
  let passed = null;
  let failed = null;
  if (counts) {
    const m = /(\d+) passed, (\d+) failed/.exec(counts[counts.length - 1]);
    passed = Number(m[1]);
    failed = Number(m[2]);
  }
  const failLines = out.split(/\r?\n/).filter(l => /^\s*(FAIL|NOT OK)/i.test(l));
  const ok = r.status === 0 && failLines.length === 0 && (failed === null || failed === 0);
  if (passed !== null) totalPassed += passed;
  if (failed !== null) totalFailedChecks += failed;
  if (!ok) badFiles++;
  const label = ok ? 'PASS' : 'FAIL';
  const checks = passed === null ? '-' : String(passed);
  console.log(label + '  ' + f + ' '.repeat(width - f.length) + '  checks: ' + checks +
    (ok ? '' : '  (exit ' + r.status + (r.error ? ', ' + r.error.message : '') + ')'));
  if (!ok) {
    for (const l of failLines.slice(0, 5)) console.log('        ' + l.trim().slice(0, 200));
  }
}

console.log('');
console.log(files.length + ' test files, ' + badFiles + ' failing; ' + totalPassed + ' checks passed, ' +
  totalFailedChecks + ' failed.');
process.exit(badFiles === 0 ? 0 : 1);
