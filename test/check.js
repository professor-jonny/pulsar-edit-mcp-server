'use strict';
// One-command pre-restart check. Plain node, no Pulsar needed.
// Usage:   npm run check            (or: node test/check.js [--no-tests])
//
// Steps:
//   1. syntax   node --check on every lib/*.js
//   2. load     every lib/*.js is required in its own process, with require('atom') shimmed
//               (test/atom-shim.js), then each `const { a, b } = require('./x')` in it is checked
//               against what ./x really exports. This catches broken requires, missing exports,
//               typos in top-level code and leftovers from a removed feature.
//   3. tests    node test/run-all.js
//
// Exit code 0 only when every step is clean. A failure here means: do not restart Pulsar yet.
// Limits: the atom stub proves syntax, imports and wiring, not that editor calls behave. A real
// Pulsar restart is still the final check.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = path.join(__dirname, '..');
const libDir = path.join(root, 'lib');
const args = process.argv.slice(2);

const loadIdx = args.indexOf('--load');
if (loadIdx >= 0) {
  loadOne(args[loadIdx + 1]);
} else {
  main();
}

// Child mode: load one lib file under the shim, then check its destructured relative requires.
function loadOne(file) {
  require('./atom-shim').install();
  const full = path.join(libDir, file);
  try {
    require(full);
  } catch (e) {
    console.log('LOAD-FAIL ' + String((e && e.message) || e).split('\n')[0]);
    process.exit(2);
  }
  const src = fs.readFileSync(full, 'utf8');
  const re = /const\s*\{([^}]+)\}\s*=\s*require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g;
  const bad = [];
  let m;
  while ((m = re.exec(src))) {
    const body = m[1].replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const names = body.split(',').map(s => s.trim().split(':')[0].trim()).filter(n => n && n.indexOf('...') !== 0);
    let dep;
    try {
      dep = require(path.join(libDir, m[2]));
    } catch (e) {
      bad.push('cannot load ' + m[2] + ': ' + String((e && e.message) || e).split('\n')[0]);
      continue;
    }
    for (const n of names) {
      if (!(n in Object(dep))) bad.push("'" + n + "' is not exported by " + m[2]);
    }
  }
  if (bad.length) {
    for (const b of bad) console.log('WIRING ' + b);
    process.exit(3);
  }
  process.exit(0); // exit explicitly: some modules start timers that would keep the process alive
}

function main() {
  const withTests = args.indexOf('--no-tests') < 0;
  const files = fs.readdirSync(libDir).filter(f => f.endsWith('.js')).sort();
  const problems = [];

  // 1. syntax
  let syntaxBad = 0;
  for (const f of files) {
    const r = cp.spawnSync(process.execPath, ['--check', path.join(libDir, f)], { encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) {
      syntaxBad++;
      const detail = (r.stderr || '').split(/\r?\n/).filter(Boolean).slice(0, 4).join(' | ');
      problems.push('syntax  ' + f + ': ' + detail);
    }
  }
  console.log((syntaxBad ? 'FAIL' : 'PASS') + '  1/3 syntax   ' + files.length + ' files, ' + syntaxBad + ' failing');

  // 2. load + wiring
  let loadBad = 0;
  for (const f of files) {
    const r = cp.spawnSync(process.execPath, [__filename, '--load', f], { cwd: root, encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0) {
      loadBad++;
      const lines = (r.stdout || '').split(/\r?\n/).filter(l => /^(LOAD-FAIL|WIRING)/.test(l));
      if (lines.length === 0) {
        lines.push('exit ' + r.status + (r.error ? ' ' + r.error.message : '') + ' (no detail printed)');
      }
      for (const l of lines) problems.push('load    ' + f + ': ' + l);
    }
  }
  console.log((loadBad ? 'FAIL' : 'PASS') + '  2/3 load     ' + files.length + ' modules, ' + loadBad + ' failing');

  // 3. tests
  let testsBad = 0;
  if (withTests) {
    const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'run-all.js')], { cwd: root, encoding: 'utf8', timeout: 900000 });
    const out = r.stdout || '';
    const summary = out.split(/\r?\n/).filter(l => /test files,/.test(l)).pop() || '(no summary line)';
    if (r.status !== 0) {
      testsBad = 1;
      for (const l of out.split(/\r?\n/)) {
        if (/^FAIL /.test(l) || /^\s+FAIL/.test(l)) problems.push('tests   ' + l.trim());
      }
    }
    console.log((testsBad ? 'FAIL' : 'PASS') + '  3/3 tests    ' + summary.trim());
  } else {
    console.log('SKIP  3/3 tests    (--no-tests)');
  }

  if (problems.length) {
    console.log('');
    console.log('Problems:');
    for (const p of problems) console.log('  ' + p);
  }
  const ok = problems.length === 0;
  console.log('');
  console.log(ok ? 'CHECK PASSED: safe to restart Pulsar.' : 'CHECK FAILED: do not restart yet.');
  process.exit(ok ? 0 : 1);
}
