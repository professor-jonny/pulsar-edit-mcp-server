'use strict';
// Regenerates posix-regex.golden.json from a real GNU sed. NOT run by the test suite (it needs sed).
//   node test/golden/gen-golden.js > test/golden/posix-regex.golden.json
// Recorded with GNU sed 4.9, LC_ALL=C.UTF-8. Cases whose result differs from lib/posix-regex.js
// (known glibc anomalies, see TODO R4a notes) are left out on purpose.
const { spawnSync } = require('child_process');
const path = require('path');
const { compile, RegexError } = require(path.join(__dirname, '..', '..', 'lib', 'posix-regex'));
const ENV = Object.assign({}, process.env, { LC_ALL: 'C.UTF-8' });
const LINES = ['', 'a', 'abc', 'aabbcc', 'abcabc', 'ab ab', 'baaac', 'foo bar Foo', 'a.b*c 123', 'AbA bAb'];

function runSed(args, input) {
  const r = spawnSync('sed', args, { input, encoding: 'utf8', env: ENV });
  return { out: r.stdout, err: r.stderr, status: r.status };
}
function subst(re, str, mk, global) {
  let m = re.exec(str, 0);
  if (!m) return str;
  let out = '', pos = 0, prevEnd = -1;
  while (m) {
    const s = m.start[0], e = m.end[0];
    out += str.slice(pos, s);
    if (!(s === e && s === prevEnd)) { out += mk(m, str); if (!global) return out + str.slice(e); }
    prevEnd = e; pos = e;
    if (s === e) { if (pos < str.length) { const cp = str.codePointAt(pos); const len = cp > 0xffff ? 2 : 1; out += str.substr(pos, len); pos += len; } else break; }
    m = pos <= str.length ? re.exec(str, pos) : null;
  }
  return out + str.slice(pos);
}
const grp = (m, s, k) => (m.start[k] < 0 ? '' : s.slice(m.start[k], m.end[k]));

function one(pattern, extended, icase) {
  const base = extended ? ['-E'] : [];
  const fl = icase ? 'I' : '';
  const probe = runSed(base.concat(['-e', 's%' + pattern + '%X%' + fl]), 'a\n');
  let re = null, myErr = null;
  try { re = compile(pattern, { extended, icase }); } catch (e) { if (!(e instanceof RegexError)) throw e; myErr = e.message; }
  if (probe.status !== 0) {
    const m = /char \d+: (.*)\n?/.exec(probe.err);
    const msg = m ? m[1].trim() : probe.err.trim();
    if (/^(unterminated `s' command|no previous regular expression)$/.test(msg)) return null;
    return myErr === msg ? { re: pattern, ere: extended, i: icase, err: msg } : null;
  }
  if (myErr) return null;
  const input = LINES.join('\n') + '\n';
  const g = runSed(base.concat(['-e', 's%' + pattern + '%<&>%g' + fl]), input).out.split('\n').slice(0, LINES.length);
  const myG = LINES.map((l) => subst(re, l, (m, s) => '<' + s.slice(m.start[0], m.end[0]) + '>', true));
  if (myG.join('\n') !== g.join('\n')) return null;
  let c = null;
  if (re.nsub > 0 && re.nsub <= 9) {
    let rep = '<&>';
    for (let k = 1; k <= re.nsub; k++) rep += '[\\' + k + ']';
    c = runSed(base.concat(['-e', 's%' + pattern + '%' + rep + '%' + fl]), input).out.split('\n').slice(0, LINES.length);
    const myC = LINES.map((l) => subst(re, l, (m, s) => { let r = '<' + s.slice(m.start[0], m.end[0]) + '>'; for (let k = 1; k <= re.nsub; k++) r += '[' + grp(m, s, k) + ']'; return r; }, false));
    if (myC.join('\n') !== c.join('\n')) return null;
  }
  return { re: pattern, ere: extended, i: icase, g, c };
}

const cur = require('./curated-lists');
const cases = [];
for (const p of cur.BRE) { const r = one(p, false, false); if (r) cases.push(r); }
for (const p of cur.ERE) { const r = one(p, true, false); if (r) cases.push(r); }
for (const p of ['foo', 'FOO', '[a-c]x*', '\\(foo\\) \\1']) { const r = one(p, false, true); if (r) cases.push(r); }
for (const p of ['foo', '(foo) \\1', 'f.o+', '[a-c]+']) { const r = one(p, true, true); if (r) cases.push(r); }
// one case per line, so the file reads (and diffs) well
const head = JSON.stringify({ generator: 'GNU sed 4.9, LC_ALL=C.UTF-8', lines: LINES }).slice(0, -1);
process.stdout.write(head + ',"cases":[\n' + cases.map((c) => JSON.stringify(c)).join(',\n') + '\n]}\n');
