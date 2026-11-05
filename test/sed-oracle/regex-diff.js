'use strict';
// node tools/sed-oracle/regex-diff.js curated
// node tools/sed-oracle/regex-diff.js fuzz [seed] [count]
// Compares lib/posix-regex.js with real sed: the same pattern through `s%RE%<&>%g` and `s%RE%<&>[\1][\2]..%` over fixed
// lines, with a JS emulation of GNU's s///g loop (oracle.js: subst); compile errors are compared by message text.
const { requireSed, runSed, subst, rng } = require('./oracle');
const { compile, RegexError } = require('../../lib/posix-regex');
const { BRE, ERE } = require('../../test/golden/curated-lists');

function sedErrorMessage(stderr) {
  const mm = /char \d+: (.*)\n?/.exec(stderr);
  return mm ? mm[1].trim() : stderr.trim();
}
const grp = (m, str, k) => (m.start[k] < 0 ? '' : str.slice(m.start[k], m.end[k]));

// returns an array of mismatch descriptions for one pattern
function check(pattern, opts, lines) {
  const o = opts || {};
  const flagStr = o.icase ? 'I' : '';
  const base = o.extended ? ['-E'] : [];
  const D = '%';
  let re = null, myErr = null;
  try { re = compile(pattern, { extended: !!o.extended, icase: !!o.icase }); } catch (e) {
    if (!(e instanceof RegexError)) throw e;
    myErr = e.message;
  }
  const probe = runSed(base.concat(['-e', 's' + D + pattern + D + 'X' + D + flagStr]), 'a\n');
  const sedErr = probe.status !== 0 ? sedErrorMessage(probe.err) : null;
  if (sedErr !== null && /^(unterminated `s' command|no previous regular expression)$/.test(sedErr)) return []; // sed's script parser, not the regex engine
  if ((sedErr === null) !== (myErr === null)) return [{ pattern, kind: 'compile', sed: sedErr, mine: myErr }];
  if (sedErr !== null) return sedErr !== myErr ? [{ pattern, kind: 'errmsg', sed: sedErr, mine: myErr }] : [];
  const problems = [];
  const input = lines.join('\n') + '\n';
  const g = runSed(base.concat(['-e', 's' + D + pattern + D + '<&>' + D + 'g' + flagStr]), input).out.split('\n').slice(0, lines.length);
  const nsub = re.nsub;
  let groupsRepl = '';
  for (let k = 1; k <= Math.min(nsub, 9); k++) groupsRepl += '[\\' + k + ']';
  const caps = nsub > 0 && nsub <= 9
    ? runSed(base.concat(['-e', 's' + D + pattern + D + '<&>' + groupsRepl + D + flagStr]), input).out.split('\n').slice(0, lines.length)
    : null;
  lines.forEach((line, idx) => {
    const myG = subst(re, line, (m, s) => '<' + s.slice(m.start[0], m.end[0]) + '>', true);
    if (myG !== g[idx]) problems.push({ pattern, kind: 'global', input: line, sed: g[idx], mine: myG });
    if (caps) {
      const myC = subst(re, line, (m, s) => {
        let r = '<' + s.slice(m.start[0], m.end[0]) + '>';
        for (let k = 1; k <= nsub; k++) r += '[' + grp(m, s, k) + ']';
        return r;
      }, false);
      if (myC !== caps[idx]) problems.push({ pattern, kind: 'caps', input: line, sed: caps[idx], mine: myC });
    }
  });
  return problems;
}

// ---------------------------------------------------------------- curated
function curated() {
  const LINES = ['', 'a', 'abc', 'aabbcc', 'abcabc', 'ab ab', 'a_b c', 'baaac', 'xyz', 'aaa', 'abab', 'a b', 'foo bar', 'Foo FOO foo', 'a.b*c', '123 456', 'abcd', 'aXbXc'];
  let bad = 0, total = 0;
  const run = (list, extended, icase) => {
    for (const p of list) {
      total++;
      for (const pr of check(p, { extended, icase }, LINES)) { bad++; console.log((extended ? 'ERE' : 'BRE') + (icase ? ' I ' : ' ') + JSON.stringify(pr)); }
    }
  };
  run(BRE, false, false);
  run(ERE, true, false);
  run(['foo', 'FOO', '[a-c]x*', '\\(foo\\) \\1'], false, true);
  run(['foo', '(foo) \\1', 'f.o+', '[a-c]+'], true, true);
  console.log('patterns checked: ' + total + ', mismatches: ' + bad);
  return bad;
}

// ---------------------------------------------------------------- fuzz
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
  let bad = 0;
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
        bad++;
        if (bad <= 40) console.log((ere ? 'ERE' : 'BRE') + (icase ? ' I ' : ' ') + JSON.stringify(pr));
      }
    }
  }
  console.log('seed ' + seed + ': ' + count + ' random patterns x2 syntaxes, distinct mismatches: ' + bad);
  console.log('(a handful per few thousand is expected: the known glibc deviations, TODO R4a-dev)');
  return bad;
}

console.log(requireSed());
const mode = process.argv[2];
if (mode === 'curated') process.exit(curated() ? 1 : 0);
else if (mode === 'fuzz') process.exit(fuzz(Number(process.argv[3] || 1), Number(process.argv[4] || 400)) ? 1 : 0);
else { console.log('usage: node tools/sed-oracle/regex-diff.js curated | fuzz [seed] [count]'); process.exit(2); }
