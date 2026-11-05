'use strict';
// node tools/sed-oracle/gen-parse-test.js [outfile]      (default: test/sed-parse.test.js, rewritten in place)
// Re-records ERR_CASES and SEM_CASES of test/sed-parse.test.js from a real GNU sed. The head (helpers) and the tail
// (checks) of the test file are kept exactly as they are; only the two tables between them are regenerated.
const fs = require('fs');
const path = require('path');
const { requireSed, realVerdict, mineVerdict, realOut } = require('./oracle');
const C = require('./corpus');
const { parseScript } = require('../../lib/sed-parse');

console.log(requireSed());
const target = process.argv[2] || path.join(__dirname, '..', '..', 'test', 'sed-parse.test.js');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'sed-parse.test.js'), 'utf8');
const HEAD_END = '// ---------------------------------------------------------------- recorded from GNU sed 4.9\n';
const TAIL_START = '\n// ---------------------------------------------------------------- 1. verdicts of real GNU sed 4.9';
const head = src.slice(0, src.indexOf(HEAD_END));
const tail = src.slice(src.indexOf(TAIL_START));
if (!head || !tail || head.length === src.length) throw new Error('markers not found in test/sed-parse.test.js');

const esc = (s) => JSON.stringify(s).replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

// ---- ERR_CASES: seeds, extra seeds, prefixes of a few seeds
const seen = new Set();
const errCases = [];
function addErr(s) {
  if (seen.has(s)) return;
  seen.add(s);
  if (/(^|[^\w\\])L/.test(s)) return;
  const v = realVerdict(s);
  if (v === 'SKIP') return;
  const m = mineVerdict(s);
  if (m !== v) { console.error('MISMATCH while recording: ' + JSON.stringify(s) + ' sed=' + v + ' mine=' + m); process.exit(1); }
  errCases.push([s, v]);
}
for (const s of C.SEEDS) addErr(s);
for (const s of C.EXTRA_TEST) addErr(s);
for (const base of C.PREFIX_SEEDS) for (let k = 1; k < base.length; k++) addErr(base.slice(0, k));

// ---- SEM_CASES: a deterministic sample of the grid (every category is represented)
const sem = [];
function addSem(script, idx) {
  const inp = C.INPUTS[idx % C.INPUTS.length];
  const want = realOut(script, inp);
  if (want === null) return;
  try { const c = parseScript(script); if (c.cmds.length !== 1 && !c.silent) return; } catch (e) { return; }
  sem.push([script, inp, want]);
}
let n = 0;
for (const r of C.FLAG_RES) for (const f of C.FLAGS) for (const rep of C.FLAG_REPS) { if (n++ % 20 === 3) addSem('s/' + r + '/' + rep + '/' + f, n); }
C.REPS.forEach((rep, i) => addSem('s/' + C.REP_RES[i % 4] + '/' + rep + '/', i));
let di = 0;
for (const [d, re, rep] of C.DELIMS) addSem('s' + d + re + d + rep + d, di++);
di = 0;
for (const re of C.BRACKETS) addSem('s/' + re + '/X/g', di++);
di = 0;
for (const re of C.REGEX_ESC) addSem('s/' + re + '/X/', di++);
di = 0;
for (const y of C.YS) addSem(y, di++);
C.BODIES.forEach((b, i) => { addSem('a' + b, i); if (i % 3 === 0) addSem('i' + b, i + 1); if (i % 3 === 1) addSem('c' + b, i + 2); });
addSem('#n\ns/a/b/', 0);

let out = head + HEAD_END;
out += 'const ERR_CASES = [\n' + errCases.map((c) => '  [' + esc(c[0]) + ', ' + esc(c[1]) + '],').join('\n') + '\n];\n\n';
out += 'const SEM_CASES = [\n' + sem.map((c) => '  [' + esc(c[0]) + ', ' + esc(c[1]) + ', ' + esc(c[2]) + '],').join('\n') + '\n];\n';
out += tail;
fs.writeFileSync(target, out);
console.log('ERR_CASES ' + errCases.length + ', SEM_CASES ' + sem.length + ' -> ' + target);
