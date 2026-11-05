'use strict';
// Test (2026-10-18) -- TODO R4a: lib/posix-regex.js, a POSIX BRE / ERE regex engine that behaves like the regex
// inside GNU sed 4.9 (leftmost-longest, GNU extensions, glibc error messages).
// Run from the package root:   node test/posix-regex.test.js
// Plain node, no Pulsar, no files written.
//
// What is pinned:
//   1. Golden data recorded from a real GNU sed 4.9 (test/golden/posix-regex.golden.json, regenerated with
//      test/golden/gen-golden.js on a machine that has sed): for every pattern the s///g output on a fixed set of
//      lines, the group captures where there are groups, and the exact error message for invalid patterns.
//   2. The search API: `from` moves where the search starts but ^ and the word tests still see the whole string;
//      unset groups are -1; invalid patterns throw RegexError.
//   3. The M flag (multi-line mode) against GNU sed's results on a pattern space "a\nb\nc".
//   4. Robustness: a long line does not overflow the stack, catastrophic patterns stay fast, runaway
//      back-reference patterns fail cleanly instead of hanging.
//
// Known deviations from GNU sed (documented in TODO R4a, deliberately NOT asserted here):
//   - glibc anomalies with assertions (\< \> \b \B and a mid-pattern ^ or $) inside repeated groups, for example
//     (^[Ab](b)){0,2} or (\w\>a){,2}a, where GNU sed sometimes matches something no matcher can justify;
//   - capture assignment for three-level nested optional groups that match empty, for example ((.{0,2}){0,1}){2}.

const fs = require('fs');
const path = require('path');
const { compile, RegexError } = require('../lib/posix-regex');

let bad = 0, pass = 0;
function ok(label, cond, detail) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && detail !== undefined) console.log('      ' + detail);
}

// GNU sed's s///[g] loop: an empty match directly after the previous match is skipped. (The real one will live in
// lib/sed-run.js, R4c; this copy keeps the engine test self-contained.)
function subst(re, str, mk, global) {
  let m = re.exec(str, 0);
  if (!m) return str;
  let out = '', pos = 0, prevEnd = -1;
  while (m) {
    const s = m.start[0], e = m.end[0];
    out += str.slice(pos, s);
    if (!(s === e && s === prevEnd)) { out += mk(m, str); if (!global) return out + str.slice(e); }
    prevEnd = e; pos = e;
    if (s === e) {
      if (pos < str.length) { const cp = str.codePointAt(pos); const len = cp > 0xffff ? 2 : 1; out += str.substr(pos, len); pos += len; } else break;
    }
    m = pos <= str.length ? re.exec(str, pos) : null;
  }
  return out + str.slice(pos);
}
const grp = (m, s, k) => (m.start[k] < 0 ? '' : s.slice(m.start[k], m.end[k]));

// ---------------------------------------------------------------- 1. golden data from GNU sed 4.9
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden', 'posix-regex.golden.json'), 'utf8'));
for (const c of golden.cases) {
  const tag = (c.ere ? 'ERE' : 'BRE') + (c.i ? ' I' : '') + ' ' + JSON.stringify(c.re);
  let re = null, err = null;
  try { re = compile(c.re, { extended: c.ere, icase: c.i }); } catch (e) { err = e; }
  if (c.err !== undefined) {
    ok('golden error  ' + tag + ' -> ' + c.err, err instanceof RegexError && err.message === c.err, err ? 'got: ' + err.message : 'compiled without error');
    continue;
  }
  if (err) { ok('golden compile  ' + tag, false, err.message); continue; }
  const g = golden.lines.map((l) => subst(re, l, (m, s) => '<' + s.slice(m.start[0], m.end[0]) + '>', true));
  const gOk = g.join('\n') === c.g.join('\n');
  ok('golden s///g  ' + tag, gOk, gOk ? undefined : JSON.stringify({ sed: c.g, mine: g }));
  if (c.c) {
    const caps = golden.lines.map((l) => subst(re, l, (m, s) => {
      let r = '<' + s.slice(m.start[0], m.end[0]) + '>';
      for (let k = 1; k <= re.nsub; k++) r += '[' + grp(m, s, k) + ']';
      return r;
    }, false));
    const cOk = caps.join('\n') === c.c.join('\n');
    ok('golden groups ' + tag, cOk, cOk ? undefined : JSON.stringify({ sed: c.c, mine: caps }));
  }
}

// ---------------------------------------------------------------- 2. search API
{
  const m1 = compile('^a').exec('aa', 1);
  ok('api: ^ matches only at absolute position 0, even when the search starts later', m1 === null);
  const m2 = compile('a').exec('aa', 1);
  ok('api: the search starts at `from`', m2 !== null && m2.start[0] === 1 && m2.end[0] === 2);
  ok('api: \\< looks at the character before `from`', compile('\\<b').exec('ab', 1) === null && compile('\\<b').exec('a b', 1) !== null);
  const m3 = compile('(a)|(b)', { extended: true }).exec('b', 0);
  ok('api: a group that did not take part is -1 for start and end', m3 && m3.start[1] === -1 && m3.end[1] === -1 && m3.start[2] === 0 && m3.end[2] === 1);
  ok('api: nsub counts the capture groups', compile('\\(a\\)\\(b\\(c\\)\\)').nsub === 3 && compile('((a)|b)+', { extended: true }).nsub === 2);
  const m4 = compile('(a|ab)(c|bcd)(d*)', { extended: true }).exec('abcd', 0);
  ok('api: leftmost-longest overall match for (a|ab)(c|bcd)(d*) on abcd', m4 && m4.start[0] === 0 && m4.end[0] === 4);
  const m5 = compile('x*', {}).exec('abc', 0);
  ok('api: an empty match is reported at the search start', m5 && m5.start[0] === 0 && m5.end[0] === 0);
  ok('api: no match returns null', compile('z').exec('abc', 0) === null);
  let thrown = null;
  try { compile('\\(a'); } catch (e) { thrown = e; }
  ok('api: an invalid pattern throws RegexError (an Error) with the glibc message', thrown instanceof RegexError && thrown instanceof Error && thrown.message === 'Unmatched ( or \\(');
  const m6 = compile('\u00e9.', {}).exec('x\u00e9\u00c0', 0);
  ok('api: non-ASCII characters are single characters for .', m6 && m6.start[0] === 1 && m6.end[0] === 3);
  const m7 = compile('^.$', {}).exec('\u{1F600}', 0);
  ok('api: an astral character (surrogate pair) is ONE character for .', m7 && m7.end[0] === 2);
  ok('api: icase matches either case', compile('abc', { icase: true }).exec('xABc', 0).start[0] === 1);
}

// ---------------------------------------------------------------- 3. M flag, results from GNU sed 4.9 on "a\nb\nc"
{
  const PS = 'a\nb\nc';
  const rows = [
    // [pattern, multiline, global, replacement, expected]
    ['^b$', true, false, 'X', 'a\nX\nc'],
    ['^', true, true, '>', '>a\n>b\n>c'],
    ['$', true, true, '<', 'a<\nb<\nc<'],
    ['^', false, true, '>', '>a\nb\nc'],
    ['a.b', false, false, 'X', 'X\nc'],
    ['a.b', true, false, 'X', 'a\nb\nc'],
    ['a[^x]b', false, false, 'X', 'X\nc'],
    ['a[^x]b', true, false, 'X', 'a\nb\nc'],
    ['\\`a', true, true, 'X', 'X\nb\nc'],
    ["c\\'", true, true, 'X', 'a\nb\nX'],
    ['^.', true, true, 'X', 'X\nX\nX'],
    ['.$', true, true, 'X', 'X\nX\nX'],
    ['\\n', false, true, '_', 'a_b_c'],
    ['[\n]', false, true, '_', 'a_b_c'],
    ['a$', false, false, 'X', 'a\nb\nc'],
    ['\\wb', false, false, 'X', 'a\nb\nc'],
    ['\\Wb', false, false, 'X', 'aX\nc'],
    ['\\Wb', true, false, 'X', 'aX\nc'],
  ];
  for (const [pat, ml, g, rep, want] of rows) {
    const got = subst(compile(pat, { multiline: ml }), PS, () => rep, g);
    ok('M flag: s/' + JSON.stringify(pat) + '/' + rep + '/' + (g ? 'g' : '') + (ml ? 'M' : '') + ' on a\\nb\\nc', got === want, JSON.stringify({ want, got }));
  }
}

// ---------------------------------------------------------------- 4. robustness
{
  let t0 = Date.now();
  const long = 'x'.repeat(30000) + 'foo';
  const mLong = compile('.*foo', {}).exec(long, 0);
  ok('robust: .*foo on a 30000-character line (no stack overflow)', mLong && mLong.start[0] === 0 && mLong.end[0] === 30003);
  ok('robust: ...and it is fast (under 3 s)', Date.now() - t0 < 3000, (Date.now() - t0) + ' ms');

  t0 = Date.now();
  const cat = compile('(a*)*b', { extended: true }).exec('a'.repeat(200) + 'c', 0);
  ok('robust: (a*)*b on a^200 c is a quick no-match (no catastrophic backtracking)', cat === null && Date.now() - t0 < 2000, (Date.now() - t0) + ' ms');

  t0 = Date.now();
  const cat2 = compile('(a|aa)+$', { extended: true }).exec('a'.repeat(60) + 'c', 0);
  ok('robust: (a|aa)+$ on a^60 c is a quick no-match', cat2 === null && Date.now() - t0 < 2000, (Date.now() - t0) + ' ms');

  let err = null;
  try { compile('(a*)*\\1b', { extended: true }).exec('a'.repeat(25), 0); } catch (e) { err = e; }
  ok('robust: a runaway back-reference pattern fails with RegexError "too complex", it does not hang', err instanceof RegexError && /too complex/.test(err.message), err ? err.message : 'no error');

  let res = null; err = null;
  try { res = compile('(ab)*c', { extended: true }).exec('ab'.repeat(3000) + 'c', 0); } catch (e) { err = e; }
  ok('robust: a deep group loop either matches or fails with RegexError, never a raw RangeError', (res && res.end[0] === 6001) || err instanceof RegexError, err ? err.name + ': ' + err.message : undefined);

  let big = null;
  try { compile('a\\{99999\\}'); } catch (e) { big = e; }
  ok('robust: an interval above RE_DUP_MAX is "Regular expression too big"', big instanceof RegexError && big.message === 'Regular expression too big');
}

// 5. Stray bytes (2026-10-22): bytes that are not valid UTF-8 travel as lone surrogates U+DC80..U+DCFF (lib/sed-run.js).
// Recorded from GNU sed 4.9 on Linux (C.UTF-8): they are invalid characters, so no `.`, bracket (negated or not),
// \w \W \s \S matches one, but for \b \B \< \> a stray byte counts as a word character.
{
  const S = '\udcff';
  const m = (pat, str, opts) => compile(pat, opts).exec(str, 0);
  ok('stray byte: . does not match it', m('.', S) === null && m('a.b', 'a' + S + 'b') === null);
  ok('stray byte: [^a] does not match it', m('[^a]', S) === null);
  ok('stray byte: [[:print:]] and [[:alpha:]] do not match it', m('[[:print:]]', S) === null && m('[[:alpha:]]', S) === null);
  ok('stray byte: \\W and \\S and \\w do not match it', m('\\W', S) === null && m('\\S', S) === null && m('\\w', S) === null);
  ok('stray byte: a plain literal next to it still matches', m('a', 'a' + S) !== null && m('a', S + 'a').start[0] === 1);
  ok('stray byte: .* stops in front of it', m('.*', 'ab' + S + 'c').end[0] === 2);
  const at = (pat, str) => { const r = []; for (let i = 0; i <= str.length; i++) { const x = compile(pat).exec(str, i); if (x && x.start[0] === i && x.end[0] === i) r.push(i); } return r.join(','); };
  ok('stray byte is a word character for \\b: x<ff>y has boundaries only at both ends', at('\\b', 'x' + S + 'y') === '0,3', at('\\b', 'x' + S + 'y'));
  ok('stray byte: \\b finds the start of a lone byte', m('\\b', S).start[0] === 0);
  ok('stray byte: \\B does not match around a lone byte', m('\\B', S) === null);
  ok('stray byte: \\B matches inside a word that holds it', compile('\\B').exec('x' + S + 'y', 1).start[0] === 1);
  ok('stray byte: \\< and \\> treat it as a word character', m('\\<', S).start[0] === 0 && m('\\>', S).start[0] === 1);
  ok('a real surrogate pair is still one character for .', m('^.$', '\ud83d\ude00') !== null);
}

console.log('\n' + pass + ' passed, ' + bad + ' failed');
process.exit(bad === 0 ? 0 : 1);
