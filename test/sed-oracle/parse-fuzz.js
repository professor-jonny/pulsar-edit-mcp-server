'use strict';
// node tools/sed-oracle/parse-fuzz.js [seed] [count]
// Random token-soup scripts (addresses, commands, separators, braces) through real sed and lib/sed-parse.js.
const { requireSed, realVerdict, mineVerdict, rng } = require('./oracle');

console.log(requireSed());
const seed = Number(process.argv[2] || 1);
const N = Number(process.argv[3] || 1200);
const { rnd, pick } = rng(seed);
const ADDR = ['', '', '', '1', '2', '$', '/a/', '/b/I', '\\,a,', '1,2', '1,$', '/a/,/b/', '2,+1', '1,~2', '1~2', '0,/a/', '0', '1,', ',2', '$!', '1!', '!', '/a', '1,2,3'];
const CMD = ['p', 'd', 'N', 'D', 'P', 'x', 'g', 'G', 'h', 'H', '=', 'n', 'z', 'F', 'q', 'Q', 'q5', 'l', 'l 3', 's/a/b/', 's/a/b/g', 's/a/\\1/', 's/\\(a\\)/\\1/', 's/a/b/2p', 's|a|b|', 's/a/b', 's/a', 'y/ab/xy/', 'y/a/xy/', 'y/a/b', 'b', 'bx', 't', 'T y', ':x', ': y', ':', 'a hi', 'a\\\nhi', 'a\\', 'i\\x', 'c foo', 'a', '{', '}', '{p}', '{p;}', '#c', '#n', 'r f', 'w /dev/null', 'r', 'v 4.2', 'v 9', 'k', '@', 'e', 's//x/', '//p', '/[/]/p', 's/[/]/x/'];
const SEP = ['', ';', ' ', '\n', ' ; ', ';;', '}', '{', ' }'];
function mk() {
  let s = '';
  const k = 1 + Math.floor(rnd() * 4);
  for (let i = 0; i < k; i++) s += pick(ADDR) + pick(['', '', ' ']) + pick(CMD) + pick(SEP);
  return s;
}
let bad = 0, total = 0;
const seen = new Set();
for (let k = 0; k < N; k++) {
  const s = mk();
  if (seen.has(s)) continue;
  seen.add(s);
  const r = realVerdict(s);
  if (r === 'SKIP') continue;
  total++;
  const m = mineVerdict(s);
  if (r !== m) { bad++; if (bad <= 25) console.log(JSON.stringify(s).padEnd(50) + 'sed=' + r + '   mine=' + m); }
}
console.log('seed ' + seed + ': ' + total + ' random scripts, mismatches: ' + bad);
process.exit(bad ? 1 : 0);
