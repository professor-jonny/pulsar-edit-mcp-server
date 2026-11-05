'use strict';
// node tools/sed-oracle/parse-sem.js
// Semantic differential: every script of the full grid (s flags and escapes, delimiters, brackets, y, a / i / c text forms)
// on 8 input lines, through real sed and through lib/sed-parse.js plus the small evaluator in oracle.js. About 10000 comparisons.
const { requireSed, realOut, mineRun } = require('./oracle');
const { semScripts, INPUTS } = require('./corpus');
const { SedParseError } = require('../../lib/sed-parse');

console.log(requireSed());
let bad = 0, total = 0, skipped = 0;
for (const sc of semScripts()) {
  for (const inp of INPUTS) {
    let mine;
    try { mine = mineRun(sc, inp); } catch (e) { if (e instanceof SedParseError) mine = 'ERR'; else throw e; }
    if (mine === null) { skipped++; continue; }
    const real = realOut(sc, inp);
    total++;
    if ((real === null ? 'ERR' : real) !== mine) {
      bad++;
      if (bad <= 40) console.log(JSON.stringify(sc) + '  <' + JSON.stringify(inp) + '>  sed=' + JSON.stringify(real) + '  mine=' + JSON.stringify(mine));
    }
  }
}
console.log('comparisons: ' + total + ' (skipped, not a single s/y/a/i/c: ' + skipped + '), mismatches: ' + bad);
process.exit(bad ? 1 : 0);
