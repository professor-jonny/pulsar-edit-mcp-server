'use strict';
// Tests for lib/replace-all-plan.js.
// Run: node test/replace-all-plan.test.js
// RAP_PATH (env) points the test at another copy of replace-all-plan.js (mutation harness;
// that copy needs edit-match.js and string-utils.js next to it).
//
// TWO KINDS OF CHECK
//  1. DIFFERENTIAL: legacy() below is the replace-all handler's matching code copied
//     VERBATIM from lib/mcp-registration.js (~L4731-4747, as of 2026-10-10, after the
//     named-group fix). planReplaceAll must produce the same newText and matchCount as
//     legacy() on every corpus case. This is the real safety net: it compares against what
//     the live tool does, not against values worked out by hand.
//  2. PINNED VALUES: the exact values captured from the live tool.
const path = require('path');
const rapPath = process.env.RAP_PATH || path.join(__dirname, '..', 'lib', 'replace-all-plan.js');
const { planReplaceAll } = require(rapPath);
const { escapeRegex, applyReplacement, unpackReplaceArgs } = require(path.join(__dirname, '..', 'lib', 'string-utils.js'));

let passed = 0;
let failed = 0;
function check(name, fn, expected) {
  let actual;
  try { actual = JSON.stringify(fn()); } catch (e) { actual = 'THROW: ' + e.message; }
  const want = JSON.stringify(expected);
  if (actual === want) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + ': got ' + actual + ', want ' + want); }
}

// ---- the live algorithm, copied verbatim (only the throw and the early returns differ) ----
function legacy({ text, query, replacement, regex = false, caseSensitive = false }) {
  const source = regex ? query : escapeRegex(query);
  const flags = 'g' + (caseSensitive ? '' : 'i');
  let pattern;
  try { pattern = new RegExp(source, flags); }
  catch (e) { return { ok: false, reason: 'invalidRegex', error: e.message }; }
  const originalText = text;
  let matchCount = 0;
  const newText = originalText.replace(pattern, function (m) {
    matchCount++;
    const u = unpackReplaceArgs(arguments);
    const pre = originalText.slice(0, u.offset);
    const post = originalText.slice(u.offset + m.length);
    return applyReplacement(replacement, m, u.groups, pre, post, u.named);
  });
  if (matchCount === 0) return { ok: false, reason: 'noMatch' };
  return { ok: true, newText, matchCount };
}

// what the planner reports, reduced to the fields legacy() has
function viaPlan(o) {
  const r = planReplaceAll(o);
  if (r.ok) return { ok: true, newText: r.newText, matchCount: r.matchCount };
  if (r.reason === 'invalidRegex') return { ok: false, reason: 'invalidRegex', error: r.error };
  return { ok: false, reason: r.reason };
}

const A = ['const Foo = 1;', 'const foo = 2;', 'foo foo foo', 'bar foo', 'let x = a/b;', 'function f() {', '  return foo;', '}', ''].join('\n');
const B = 'const foo = 1;\nlet a = foo + 2;\n';

// ---- corpus: [label, text, options] ----
const texts = {
  A,
  B,
  ACRLF: A.split('\n').join('\r\n'),
  empty: '',
  single: 'foo',
  noNewline: 'foo bar foo',
  bom: '\uFEFFfoo = 1;\nfoo = 2;\n',
  astral: 'a\uD83D\uDE00foo\uD83D\uDE00foo\n\uD83D\uDE00\n',
  crOnly: 'foo\rfoo\r',
  blank: '\n\n\nfoo\n\n\n',
  dollars: 'cost $5 and $10 foo $&\n',
  tabs: '\tfoo\t\n  foo  \n',
  mixedEol: 'foo\r\nfoo\nfoo\r\n',
};
const optsList = [
  { query: 'foo', replacement: 'X' },
  { query: 'foo', replacement: 'X', caseSensitive: true },
  { query: 'foo', replacement: '$&$&' },
  { query: 'foo', replacement: '[$`|$&|$\']' },
  { query: 'foo', replacement: '$$' },
  { query: 'foo', replacement: '$0' },
  { query: 'foo', replacement: '' },
  { query: 'foo', replacement: '\n' },
  { query: 'foo', replacement: '\r\n' },
  { query: 'zzz', replacement: 'X' },
  { query: 'a.b', replacement: 'X' },
  { query: 'a/b', replacement: 'X' },
  { query: '$', replacement: 'X' },
  { query: '(', replacement: 'X' },
  { query: 'FOO', replacement: 'x', caseSensitive: true },
  { query: 'FOO', replacement: 'x' },
];

let diffCases = 0;
for (const tName of Object.keys(texts)) {
  for (const o of optsList) {
    if (o._skipEmpty) continue;
    const text = texts[tName];
    const label = 'DIFF ' + tName + ' q=' + JSON.stringify(o.query) + ' r=' + JSON.stringify(o.replacement) +
      (o.caseSensitive ? ' cs' : '');
    diffCases++;
    check(label, () => viaPlan({ text, ...o }), legacy({ text, ...o }));
  }
}

// ---- pinned values (live captures) ----
check('G1 foo/X on A: 7 matches', () => planReplaceAll({ text: A, query: 'foo', replacement: 'X' }).matchCount, 7);
check('G2 foo/X on A caseSensitive: 6 matches', () => planReplaceAll({ text: A, query: 'foo', replacement: 'X', caseSensitive: true }).matchCount, 6);
check('G6 zzz: noMatch with matchCount 0', () => { const r = planReplaceAll({ text: A, query: 'zzz', replacement: 'X' }); return [r.ok, r.reason, r.matchCount]; }, [false, 'noMatch', 0]);
check('G7 $& expanded with regex:false (fixture B)', () => planReplaceAll({ text: B, query: 'foo', replacement: '$&$&' }).newText, 'const foofoo = 1;\nlet a = foofoo + 2;\n');

// ---- planner-specific behaviour ----
check('P1 CRLF text round-trips: rows keep their CR', () => planReplaceAll({ text: 'foo\r\nbar\r\n', query: 'foo', replacement: 'X' }).newText, 'X\r\nbar\r\n');
check('P3 replacement is inserted VERBATIM (no CR added)', () => planReplaceAll({ text: 'a\r\nb', query: 'a', replacement: 'X\nY' }).newText, 'X\nY\r\nb');
check('P4 hits carry whole-text pre/post', () => { const r = planReplaceAll({ text: 'ab foo cd', query: 'foo', replacement: 'X' }); return [r.hits[0].pre, r.hits[0].post]; }, ['ab ', ' cd']);
check('P5 non-string text is invalidInput', () => planReplaceAll({ text: null, query: 'a', replacement: 'b' }).reason, 'invalidInput');
check('P6 non-string replacement is invalidInput', () => planReplaceAll({ text: 'a', query: 'a', replacement: undefined }).reason, 'invalidInput');
check('P7 called with no argument does not throw', () => planReplaceAll().reason, 'invalidInput');
check('P8 case-insensitive is the DEFAULT', () => planReplaceAll({ text: 'Foo FOO foo', query: 'foo', replacement: 'x' }).newText, 'x x x');
check('P9 literal query is escaped (regex metacharacters)', () => planReplaceAll({ text: 'a.b axb', query: 'a.b', replacement: 'X' }).newText, 'X axb');
check('P10 adjacent matches', () => planReplaceAll({ text: 'foofoofoo', query: 'foo', replacement: 'X' }).newText, 'XXX');
check('P11 replacement containing the query is not rescanned', () => planReplaceAll({ text: 'foo', query: 'foo', replacement: 'foofoo' }).newText, 'foofoo');
check('P12 first and last offsets (match at 0 and at the very end)', () => planReplaceAll({ text: 'foo-foo', query: 'foo', replacement: 'X' }).newText, 'X-X');

// ---- KNOWN DIFFERENCE (documented in the module header; PJ to decide the adapter's answer) ----
check('K1 empty query: planner refuses (invalidInput)', () => planReplaceAll({ text: 'ab', query: '', replacement: '-' }).reason, 'invalidInput');
check('K2 empty query: legacy code inserts at every position (from the code, ab -> -a-b-)', () => legacy({ text: 'ab', query: '', replacement: '-' }).newText, '-a-b-');

console.log('differential cases: ' + diffCases);
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
