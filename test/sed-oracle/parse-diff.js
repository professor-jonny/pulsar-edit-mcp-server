'use strict';
// node tools/sed-oracle/parse-diff.js
// Error corpus: every seed script, every prefix of it and every single-character deletion, through real sed and through
// lib/sed-parse.js; compares accept / reject, the exact message and the exact "char N" position. About 2500 cases.
const { requireSed, realVerdict, mineVerdict } = require('./oracle');
const { SEEDS, EXTRA } = require('./corpus');

console.log(requireSed());
const cases = new Set();
for (const s of new Set(SEEDS.concat(EXTRA))) {
  if (/(^|[^\w\\])L/.test(s)) continue; // sed 4.9 accepts the L command; the parser deliberately does not (see TODO R4b-dev)
  cases.add(s);
  for (let k = 1; k < s.length; k++) cases.add(s.slice(0, k));
  for (let k = 0; k < s.length && s.length < 40; k++) cases.add(s.slice(0, k) + s.slice(k + 1));
}
let bad = 0, total = 0, skipped = 0;
for (const s of cases) {
  const r = realVerdict(s);
  if (r === 'SKIP') { skipped++; continue; }
  total++;
  const m = mineVerdict(s);
  if (r !== m) { bad++; if (bad <= 60) console.log(JSON.stringify(s).padEnd(40) + 'sed=' + r + '   mine=' + m); }
}
console.log('cases: ' + total + ' (skipped ' + skipped + '), mismatches: ' + bad);
process.exit(bad ? 1 : 0);
