'use strict';
// test/grep-oracle/grep-diff.js - compares the regex:true path of lib/search-engine.js (compilePattern + scanLines)
// with a REAL GNU grep (3.11, the Windows build from mbuilov/grep-windows, saved as test/grep-oracle/grep.exe).
// NOT part of the test suite (it needs grep.exe). See README.md in this folder.
//
//   node test/grep-oracle/grep-diff.js curated          the BRE and ERE lists of the sed oracle (test/golden/curated-lists.js)
//   node test/grep-oracle/grep-diff.js fuzz [seed] [n]  random patterns, both syntaxes
//
// For each pattern it compares: (1) compile errors (that both fail, and the message), (2) the line numbers `grep -n`
// selects, (3) the matches `grep -o -n` prints. ASCII input only: this grep build treats text as bytes whatever the
// locale, so UTF-8 behaviour cannot be checked here. Output of the Windows build ends lines with CRLF: normalised.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compilePattern, scanLines } = require('../../lib/search-engine');
const { BRE, ERE } = require('../golden/curated-lists');

const GREP = path.join(__dirname, 'grep.exe');
const ENV = Object.assign({}, process.env, { LC_ALL: 'C' });
// this Windows build EXPANDS WILDCARDS in its arguments (a*, .*, ? become file names of the current folder), so the
// pattern goes in through -f, and grep runs in an empty scratch folder
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-oracle-'));
function patFile(pattern) {
  const f = path.join(SCRATCH, 'pat.txt');
  fs.writeFileSync(f, Buffer.from(pattern + '\n', 'latin1'));
  return f;
}

function runGrep(args, input) {
  const r = spawnSync(GREP, args, { input: Buffer.from(input, 'latin1'), env: ENV, cwd: SCRATCH, timeout: 10000 });
  if (r.error) throw r.error;
  const norm = (b) => (b ? b.toString('latin1').replace(/\r\n/g, '\n') : '');
  return { out: norm(r.stdout), err: norm(r.stderr), status: r.status };
}

function requireGrep() {
  let r;
  try { r = runGrep(['--version'], ''); } catch (e) { r = null; }
  if (!r || r.status !== 0 || !/GNU grep/.test(r.out)) {
    console.error('These tools need test/grep-oracle/grep.exe (GNU grep 3.11, see README.md). Not found or not running.');
    process.exit(2);
  }
  return r.out.split('\n')[0];
}

const firstError = (stderr) => (stderr.split('\n').filter((l) => l && !/warning:/.test(l)).map((l) => l.replace(/^grep(\.exe)?: /, '').replace(/^.*pat\.txt:\d+: /, ''))[0]) || stderr.trim();

function realRun(pattern, o, lines) {
  const base = [o.fixed ? '-F' : (o.extended ? '-E' : '-G')].concat(o.icase ? ['-i'] : [], o.w ? ['-w'] : [], o.x ? ['-x'] : []);
  const input = lines.join('\n') + '\n';
  const sel = runGrep(base.concat(['-n', '-f', patFile(pattern)]), input);
  // this build cannot run back-references at all (memory exhausted): not comparable
  if (/memory exhausted/.test(sel.err)) return { unsupported: 'memory exhausted' };
  if (sel.status === 2) return { error: firstError(sel.err) };
  const picked = sel.out.split('\n').filter(Boolean).map((l) => Number(l.slice(0, l.indexOf(':'))));
  const only = runGrep(base.concat(['-o', '-n', '-f', patFile(pattern)]), input).out.split('\n').filter(Boolean);
  return { picked, only };
}

function mineRun(pattern, o, lines) {
  const strip = (m) => m.replace(/^Invalid regex: /, '');
  let pat;
  try { pat = compilePattern({ query: pattern, regex: !o.fixed, extended: !!o.extended, caseSensitive: !o.icase, wordRegexp: !!o.w, lineRegexp: !!o.x }); } catch (e) { return { error: strip(e.message) }; }
  try {
    const picked = scanLines(lines, pat, { maxMatches: 1e9 }).matches.map((m) => m.line);
    const only = [];
    for (const m of scanLines(lines, pat, { onlyMatching: true, maxMatches: 1e9 }).matches) for (const part of m.matchedParts) only.push(m.line + ':' + part);
    return { picked, only };
  } catch (e) { return { error: strip(e.message) }; }
}

// returns an array of mismatch descriptions for one pattern
function check(pattern, o, lines) {
  const real = realRun(pattern, o, lines);
  if (real.unsupported) return [{ pattern, kind: 'unsupported', grep: real.unsupported, mine: '' }];
  const mine = mineRun(pattern, o, lines);
  // a back-reference pattern for which this grep build prints nothing (it cannot run them) is not comparable
  if (/\\[1-9]/.test(pattern) && real.picked && real.picked.length === 0 && mine.picked && mine.picked.length > 0) return [{ pattern, kind: 'unsupported', grep: 'no output for a back-reference', mine: '' }];
  if (real.error !== undefined || mine.error !== undefined) {
    if (real.error === undefined) return [{ pattern, kind: 'compile', grep: 'valid', mine: mine.error }];
    if (mine.error === undefined) return [{ pattern, kind: 'compile', grep: real.error, mine: 'valid' }];
    return real.error === mine.error ? [] : [{ pattern, kind: 'errmsg', grep: real.error, mine: mine.error }];
  }
  const problems = [];
  if (real.picked.join() !== mine.picked.join()) problems.push({ pattern, kind: 'lines', grep: real.picked.join(), mine: mine.picked.join() });
  if (real.only.join('|') !== mine.only.join('|')) problems.push({ pattern, kind: 'only', grep: real.only.slice(0, 8).join('|'), mine: mine.only.slice(0, 8).join('|') });
  return problems;
}

// patterns where GNU grep's own two engines (dfa for line selection, regex for -o) disagree with each other: not copied (see README.md)
const KNOWN = new Set(['{1}', '^*a', 'a$*']);
const LINES = ['', 'a', 'abc', 'aabbcc', 'abcabc', 'ab ab', 'a_b c', 'baaac', 'xyz', 'aaa', 'abab', 'a b', 'foo bar', 'Foo FOO foo', 'a.b*c', '123 456', 'abcd', 'aXbXc'];

// ---------------------------------------------------------------- words: -w and -x (R4g), with -G, -E and -F
// Every pattern of the curated lists, and a list of fixed strings, with -w, -x and both; grep -n and grep -o -n compared.
const WORD_LINES = LINES.concat(['a_b', 'a-b', 'foo_bar', 'foo-bar', '(foo)', 'foobar foo', 'xfoo foox foo', 'a a a', 'ab', 'b a', ' a ', 'a1', '1a', '_a', 'a.', '.a', 'a,b', 'abc abc', 'A', 'FOO']);
function words() {
  let bad = 0, total = 0, skipped = 0, known = 0;
  const kinds = {};
  const FIXED = ['a', 'ab', 'abc', 'a.b', 'a b', 'foo', 'FOO', 'foo bar', '_', '1', '123', 'a*', '[a]', '\\', 'a.b*c', 'x', 'b', 'abab', 'ab ab', ' ', 'aa', 'a_b', '456', 'foo-bar', '(foo)', '.', ',', 'a,b', '-'];
  const flagSets = [{ w: true }, { x: true }, { w: true, x: true }];
  const run = (list, mode, icase, label) => {
    for (const p of list) {
      if (/[\r\n]/.test(p)) continue;
      for (const f of flagSets) {
        total++;
        const o = Object.assign({ icase }, f, mode === 'F' ? { fixed: true } : { extended: mode === 'E' });
        for (const pr of check(p, o, WORD_LINES)) {
          if (pr.kind === 'unsupported') { skipped++; continue; }
          if (KNOWN.has(pr.pattern) || (mode === 'E' && (/(^|[(|^$*+?])[{]/.test(p) || /[\^$][*+?]/.test(p)))) { known++; continue; }
          // with -w and -x together grep -o prints an empty match for an empty line (N:), which neither flag does alone
          if (f.w && f.x && pr.kind === 'only') { known++; continue; }
          bad++;
          kinds[pr.kind] = (kinds[pr.kind] || 0) + 1;
          if (bad <= 60) console.log(label + ' ' + (f.w ? '-w' : '') + (f.x ? '-x' : '') + ' ' + JSON.stringify(pr));
        }
      }
    }
  };
  run(BRE, 'G', false, 'BRE');
  run(ERE, 'E', false, 'ERE');
  run(FIXED, 'F', false, 'FIX');
  run(['foo', 'FOO', 'a', 'Foo'], 'F', true, 'FIX i');
  run(['foo', 'a', '[a-c]x*'], 'G', true, 'BRE i');
  console.log('pattern x flag combinations checked: ' + total + ' (' + skipped + ' skipped: back-references, ' + known + ' known), new mismatches: ' + bad + ' ' + JSON.stringify(kinds));
  return bad;
}

function curated() {
  let bad = 0, total = 0, skipped = 0, known = 0;
  const kinds = {};
  const run = (list, extended, icase) => {
    for (const p of list) {
      if (/[\r\n]/.test(p)) continue;
      total++;
      for (const pr of check(p, { extended, icase }, LINES)) {
        if (pr.kind === 'unsupported') { skipped++; continue; }
        if (KNOWN.has(pr.pattern)) { known++; continue; }
        // GNU grep's two engines (glibc for -o and for errors, dfa for line selection) disagree about an operator or a brace
        // at the start of an expression or right after an anchor: those patterns are classed as known, not compared
        if (extended && (/(^|[(|^$*+?])[{]/.test(pr.pattern) || /[\^$][*+?]/.test(pr.pattern))) { known++; continue; }
        bad++;
        kinds[pr.kind] = (kinds[pr.kind] || 0) + 1;
        console.log((extended ? 'ERE' : 'BRE') + (icase ? ' i ' : ' ') + JSON.stringify(pr));
      }
    }
  };
  run(BRE, false, false);
  run(ERE, true, false);
  run(['foo', 'FOO', '[a-c]x*', '\\(foo\\) \\1'], false, true);
  run(['foo', '(foo) \\1', 'f.o+', '[a-c]+'], true, true);
  console.log('patterns checked: ' + total + ' (' + skipped + ' skipped: back-references, which this grep build cannot run; ' + known + ' known GNU-internal disagreements), new mismatches: ' + bad + ' ' + JSON.stringify(kinds));
  return bad;
}

// ---------------------------------------------------------------- fuzz (same generator idea as the sed oracle)
function rng(seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  return { rnd, pick: (a) => a[Math.floor(rnd() * a.length)] };
}

function fuzz(seed, count) {
  const { rnd, pick } = rng(seed);
  const LITS = ['a', 'b', 'c', ' ', '_', 'A', 'a', 'b'];
  const SETS = ['[ab]', '[^a]', '[a-c]', '[[:alpha:]]', '[[:space:]]', '[^[:alpha:]]', '[Ab]', '[b-]'];
  const CLS = ['\\w', '\\s', '\\W', '\\S'];
  const ANCH = ['^', '$', '\\b', '\\B', '\\<', '\\>'];
  const OPS = ['*', '+', '?', '{1,2}', '{2}', '{0,2}', '{,2}', '{1,}', '{0}', '{0,1}'];
  let groupsMade = 0;
  function gen(depth) {
    const r = rnd();
    if (depth <= 0 || r < 0.30) {
      const q = rnd();
      if (q < 0.55) return { t: 'lit', v: pick(LITS) };
      if (q < 0.65) return { t: 'raw', v: '.' };
      if (q < 0.80) return { t: 'raw', v: pick(SETS) };
      if (q < 0.88) return { t: 'raw', v: pick(CLS) };
      if (q < 0.97) return { t: 'anch', v: pick(ANCH) };
      return groupsMade > 0 ? { t: 'bref', v: 1 + Math.floor(rnd() * groupsMade) } : { t: 'lit', v: 'a' };
    }
    if (r < 0.50) { groupsMade++; return { t: 'group', a: gen(depth - 1) }; }
    if (r < 0.70) return { t: 'cat', a: [gen(depth - 1), gen(depth - 1), ...(rnd() < 0.3 ? [gen(depth - 1)] : [])] };
    if (r < 0.82) return { t: 'alt', a: [gen(depth - 1), gen(depth - 1)] };
    return { t: 'rep', a: gen(depth - 1), op: pick(OPS) };
  }
  function render(n, ere) {
    switch (n.t) {
      case 'lit': case 'raw': case 'anch': return n.v;
      case 'bref': return '\\' + n.v;
      case 'group': return (ere ? '(' : '\\(') + render(n.a, ere) + (ere ? ')' : '\\)');
      case 'cat': return n.a.map((x) => render(x, ere)).join('');
      case 'alt': return n.a.map((x) => render(x, ere)).join(ere ? '|' : '\\|');
      case 'rep': {
        let inner = render(n.a, ere);
        if (!(n.a.t === 'lit' || n.a.t === 'raw' || n.a.t === 'group')) inner = (ere ? '(' : '\\(') + inner + (ere ? ')' : '\\)');
        let op = n.op;
        if (!ere) {
          if (op === '+' || op === '?') op = '\\' + op;
          else if (op[0] === '{') op = '\\{' + op.slice(1, -1) + '\\}';
        }
        return inner + op;
      }
      default: throw new Error('bad node');
    }
  }
  const ALPHA = 'abcAB _';
  const randLine = () => { const len = Math.floor(rnd() * 8); let s = ''; for (let i = 0; i < len; i++) s += ALPHA[Math.floor(rnd() * ALPHA.length)]; return s; };
  const FIXED = ['', 'a', 'abc', 'aabbcc', 'abcabc', 'ab ab', 'a_b c', 'baaac', 'aaa', 'abab', 'AbA bAb'];
  let bad = 0, skipped = 0, known = 0;
  const seen = new Set();
  for (let k = 0; k < count; k++) {
    groupsMade = 0;
    const ast = gen(3);
    const lines = FIXED.slice();
    for (let j = 0; j < 24; j++) lines.push(randLine());
    for (const ere of [true, false]) {
      const pattern = render(ast, ere);
      const icase = rnd() < 0.15;
      for (const pr of check(pattern, { extended: ere, icase }, lines)) {
        const key = pr.kind + '|' + pr.pattern;
        if (seen.has(key)) continue;
        seen.add(key);
        if (pr.kind === 'unsupported') { skipped++; continue; }
        if (KNOWN.has(pr.pattern)) { known++; continue; }
        // GNU grep's two engines (glibc for -o and for errors, dfa for line selection) disagree about an operator or a brace
        // at the start of an expression or right after an anchor: those patterns are classed as known, not compared
        if (ere && (/(^|[(|^$*+?])[{]/.test(pr.pattern) || /[\^$][*+?]/.test(pr.pattern))) { known++; continue; }
        bad++;
        if (bad <= 40) console.log((ere ? 'ERE' : 'BRE') + (icase ? ' i ' : ' ') + JSON.stringify(pr));
      }
    }
  }
  console.log('seed ' + seed + ': ' + count + ' random patterns x2 syntaxes, distinct mismatches: ' + bad + ' (' + skipped + ' skipped: back-references, ' + known + ' known)');
  return bad;
}

console.log(requireGrep());
const mode = process.argv[2];
if (mode === 'curated') process.exit(curated() ? 1 : 0);
else if (mode === 'fuzz') process.exit(fuzz(Number(process.argv[3] || 1), Number(process.argv[4] || 300)) ? 1 : 0);
else if (mode === 'words') process.exit(words() ? 1 : 0);
else if (mode === 'lenient') process.exit(lenient(Number(process.argv[3] || 1), Number(process.argv[4] || 400)) ? 1 : 0);
else { console.log('usage: node test/grep-oracle/grep-diff.js curated | fuzz [seed] [count] | lenient [seed] [count] | words'); process.exit(2); }

// ---------------------------------------------------------------- lenient: token soup (operators in odd places)
// The structured fuzzer never writes `*a`, `a{1`, `)` or `a**`; this one strings random tokens together, in both
// syntaxes, so the places where GNU grep is more lenient than sed show up. Every pattern is compared like the others.
function lenient(seed, count) {
  const { rnd, pick } = rng(seed);
  const TOK_COMMON = ['a', 'b', 'a', 'ab', '.', '*', '*', '[ab]', '[^a]', '^', '$', 'x', '{', '}', '{1}', '{1,2}', '{x}', '{1', '{,2}', '{2,1}', '\\.', '\\*', ' '];
  const TOK_ERE = ['+', '?', '(', ')', '|', '(a)', '(a|b)', '()'];
  const TOK_BRE = ['\\+', '\\?', '\\(', '\\)', '\\|', '\\(a\\)', '\\{', '\\}', '\\{1\\}', '\\{1,2\\}', '\\{x\\}', '+', '?', '(', ')', '|'];
  const FIXED = ['', 'a', 'b', 'ab', 'aa', 'ba', 'a b', '*a', 'a*', '{', '}', '{1}', 'a{', 'a{1', 'a{x}', '(', ')', 'a)', '+a', '?a', 'a|b', 'x', 'abab', '.', '\\', 'aab', 'abb'];
  let bad = 0, skipped = 0, known = 0;
  const seen = new Set();
  for (let k = 0; k < count; k++) {
    for (const ere of [true, false]) {
      const toks = TOK_COMMON.concat(ere ? TOK_ERE : TOK_BRE);
      const len = 1 + Math.floor(rnd() * 5);
      let pattern = '';
      for (let j = 0; j < len; j++) pattern += pick(toks);
      for (const pr of check(pattern, { extended: ere, icase: false }, FIXED)) {
        const key = pr.kind + '|' + (ere ? 'E' : 'B') + '|' + pr.pattern;
        if (seen.has(key)) continue;
        seen.add(key);
        if (pr.kind === 'unsupported') { skipped++; continue; }
        if (KNOWN.has(pr.pattern)) { known++; continue; }
        // GNU grep's two engines (glibc for -o and for errors, dfa for line selection) disagree about an operator or a brace
        // at the start of an expression or right after an anchor: those patterns are classed as known, not compared
        if (ere && (/(^|[(|^$*+?])[{]/.test(pr.pattern) || /[\^$][*+?]/.test(pr.pattern))) { known++; continue; }
        bad++;
        if (bad <= 60) console.log((ere ? 'ERE' : 'BRE') + ' ' + JSON.stringify(pr));
      }
    }
  }
  console.log('lenient seed ' + seed + ': ' + count + ' token-soup patterns x2 syntaxes, distinct mismatches: ' + bad + ' (' + skipped + ' skipped, ' + known + ' known)');
  return bad;
}
