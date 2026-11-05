'use strict';
// Aggregated summary: the runner reads only the LAST 'N passed, M failed' line, so each block's line is folded into one total printed at the end.
let __p = 0, __f = 0; const __log = console.log.bind(console);
console.log = (...a) => { const m = /(\d+) passed, (\d+) failed/.exec(a.map(String).join(' ')); if (m) { __p += Number(m[1]); __f += Number(m[2]); } else __log(...a); };
// Merged 2026-11-19 from: tree-sitter-symbols.test.js, tree-sitter-symbols.code-mask.test.js, tree-sitter-symbols.short-names.test.js.
// Each former file runs in its own block, so names and pass/fail counters stay separate. Run: node test/tree-sitter-symbols.test.js

// ===== tree-sitter-symbols =====
{
// test/tree-sitter-symbols.test.js (2026-10-11)
// Pins lib/tree-sitter-symbols.js bodyEndRow (new) and its use by getSymbolsFromText, plus the
// deliberately UNCHANGED braceEndRow. Bug fixed: braceEndRow returned the SIGNATURE row for any
// function whose parameter list holds an object pattern, e.g. 'function f({ a, b }) {', so
// inFunction / afterFunction scopes collapsed to one line.
// Written probe-first (TEMP\bodyend_probe.js and TEMP\probe_tss.js printed the real outputs before
// any assertion was written).
// Run: node test/tree-sitter-symbols.test.js   (TSS_PATH env points it at another copy, used by the
// mutation harness). Last line is '<N> passed, <M> failed'.
const path = require('path');
const mod = require(process.env.TSS_PATH || path.join(__dirname, '..', 'lib', 'tree-sitter-symbols.js'));
const { bodyEndRow, braceEndRow, getSymbolsFromText } = mod;

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}
function block(name, fn) {
  try { fn(); } catch (e) { fail++; console.log('FAIL ' + name + ' threw: ' + (e && e.message)); }
}

// ---- B: bodyEndRow on small inputs (row 0 is the signature row) ---------------------------
block('B', () => {
  const b = (lines) => bodyEndRow(lines, 0);
  eq('B1 destructured param', b(['function f({ a, b }) {', '  return a;', '}']), 2);
  eq('B2 default object param', b(['function g(a = {}) {', '  if (a) {', '  }', '}']), 3);
  eq('B3 multi-line signature', b(['function h({', '  a,', '  b', '}) {', '  return 1;', '}']), 5);
  eq('B4 async arrow, destructured', b(['const k = async ({ x }) => {', '  return x;', '};']), 2);
  eq('B5 plain params, nested block', b(['function s(a, b) {', '  if (a) {', '    b();', '  }', '}']), 4);
  eq('B6 one-line arrow with brace arg stays one row',
    b(['const m = (x) => foo({a:1});', 'function n() {', '}']), 0);
  eq('B7 call with multi-line object arg', b(['const o = foo({', '  a: 1', '});']), 2);
  eq('B8 object literal', b(['const p = {', '  a: 1,', '};']), 2);
  eq('B9 C style, brace on next line', b(['int f(int a)', '{', '  return a;', '}']), 3);
  eq('B10 stray ( in the body does not matter',
    b(['function q({ a }) {', "  const s = '(';", '  if (a) {', '  }', '}']), 4);
  eq('B11 no brace at all', b(['const r = 5;']), -1);
  eq('B12 class', b(['class A extends B {', '  m() {}', '}']), 2);
  eq('B13 } inside a string no longer ends the body early (fixed 2026-10-16, see code-mask test)',
    b(['function t({ a }) {', "  const s = '}';", '}']), 2);
  eq('B14 no-semicolon call with object arg reaches the final fallback',
    b(['const o = foo({', '  a: 1', '})']), 2);
  eq('B15 body brace beyond the 6-row window falls back to braceEndRow',
    b(['function w(', '  a,', '  b,', '  c,', '  d,', '  e,', ') {', '  return 1;', '}']), 8);
  eq('B16 ) inside a string default does not push paren depth negative',
    b(['function f({ a = ")" }) {', '  return a;', '}']), 2);
  eq('B17 ends at the first function, not the next one',
    b(['function p({ a }) {', '  return a;', '}', 'function q() {', '}']), 2);
});

// ---- U: braceEndRow is UNCHANGED (mcp-registration.js imports it as _tssBraceEndRow) ----------
block('U', () => {
  eq('U1 old behaviour kept: destructured param ends on the signature row',
    braceEndRow(['function f({ a, b }) {', '  return a;', '}'], 0), 0);
  eq('U2 plain function', braceEndRow(['function s(a, b) {', '  if (a) {', '  }', '}'], 0), 3);
  eq('U3 no brace', braceEndRow(['const r = 5;'], 0), -1);
});

// ---- G: getSymbolsFromText ranges (rows are 0-based) ---------------------------------------
block('G', () => {
  const fixture = [
    'function plain(a, b) {',              // 0
    '  if (a) {',                          // 1
    '    b();',                            // 2
    '  }',                                 // 3
    '}',                                   // 4
    '',                                    // 5
    'function destr({ a, b }) {',          // 6
    '  return a + b;',                     // 7
    '}',                                   // 8
    '',                                    // 9
    'const arrow = async ({ x }) => {',    // 10
    '  return x;',                         // 11
    '};',                                  // 12
    '',                                    // 13
    'function withDefault(o = {}) {',      // 14
    '  const s = "(";',                    // 15
    '  return o;',                         // 16
    '}',                                   // 17
    '',                                    // 18
    "const curTool = 'my-tool';",          // 19
    'server.registerTool(curTool, {',      // 20
    '  a: 1,',                             // 21
    '}, async () => {',                    // 22
    '});',                                 // 23
  ].join('\n');
  const syms = getSymbolsFromText(fixture, 'fixture.js');
  const rng = (n) => { const s = syms.find((x) => x.name === n); return s ? [s.startRow, s.endRow] : null; };
  eq('G1 symbol count', syms.length, 5);
  eq('G2 plain function', rng('plain'), [0, 4]);
  eq('G3 destructured param function now spans its body', rng('destr'), [6, 8]);
  eq('G4 destructured async arrow', rng('arrow'), [10, 12]);
  eq('G5 default object param plus ( in a string', rng('withDefault'), [14, 17]);
  eq('G6 registerTool path unchanged (still braceEndRow from the registerTool row)',
    rng('my-tool'), [19, 22]);
  const lines = fixture.split('\n');
  eq('G7 registerTool end row equals braceEndRow(lines, 20)', rng('my-tool')[1], braceEndRow(lines, 20));
  eq('G8 destr ends on its closing brace line', lines[rng('destr')[1]], '}');
  eq('G9 non-code extension still yields no symbols', getSymbolsFromText(fixture, 'notes.md'), []);
});

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
}

// ===== tree-sitter-symbols.code-mask =====
{
// test/tree-sitter-symbols.code-mask.test.js (2026-10-16)
// Pins lib/tree-sitter-symbols.js bodyEndRow ignoring braces and parens that sit inside COMMENTS,
// STRINGS, TEMPLATE LITERALS and REGEX LITERALS. Bug fixed: bodyEndRow counted every brace, so one
// stray '{' in a comment (match-engine.js matchContent, a comment quoting 'function alpha() {')
// left the depth above 0, bodyEndRow returned -1, getSymbolsFromText fell back to the signature
// row and inFunction / afterFunction scopes collapsed to ONE line (394 to 394).
// Written test-first: every M case below was seen RED against the old counter before the fix.
// Run: node test/tree-sitter-symbols.code-mask.test.js   (TSS_PATH env points it at another copy,
// used by the mutation harness). Last line is '<N> passed, <M> failed'.
const fs = require('fs');
const path = require('path');
const mod = require(process.env.TSS_PATH || path.join(__dirname, '..', 'lib', 'tree-sitter-symbols.js'));
const { bodyEndRow, getSymbolsFromText } = mod;

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}
function block(name, fn) {
  try { fn(); } catch (e) { fail++; console.log('FAIL ' + name + ' threw: ' + (e && e.message)); }
}

// ---- M: bodyEndRow with non-code text holding braces / parens (row 0 is the signature row) ------
block('M', () => {
  const b = (lines) => bodyEndRow(lines, 0);
  eq('M1 line comment holding an open brace (the matchContent shape)',
    b(['function a() {', "  // quotes 'function alpha() {' as an example", '  return 1;', '}']), 3);
  eq('M2 multi-line block comment holding braces',
    b(['function a() {', '  /* {', '     { */', '  return 1;', '}']), 4);
  eq('M3 braces inside single-quoted strings',
    b(['function a() {', "  const s = '{';", "  const t = '}}';", '}']), 3);
  eq('M4 escaped quote inside a double-quoted string',
    b(['function a() {', '  const s = "\\"{";', '}']), 2);
  eq('M5 multi-line template literal with a nested ${ } expression',
    b(['function a() {', '  const t = `{', '  x ${ {a:1}.a } }', '  `;', '  return t;', '}']), 5);
  eq('M6 regex literals holding a brace and a quote',
    b(['function a(s) {', "  return /[{']/.test(s) && /\\}/.test(s);", '}']), 2);
  eq('M7 division is not a regex, trailing // comment holds a brace',
    b(['function a(x) {', '  const r = x / 2; // }', '  return r / 3;', '}']), 3);
  eq('M8 // inside a string does not start a comment',
    b(['function a() {', "  const u = 'http://x'; if (u) {", '  }', '}']), 3);
  eq('M9 ( inside a string default in the signature',
    b(["function f({ a = '(' }) {", '  return a;', '}']), 2);
  eq('M10 signature with destructuring plus a comment brace in the body',
    b(["function mc(n, { l, t }, s, o = {}) {", "  // so 'function alpha() {' was included).", '  return 1;', '}']), 3);
  eq('M11 block comment opener inside a string does not open a comment',
    b(['function a() {', "  const s = '/*';", '  if (s) {', '  }', '}']), 4);
  eq('M12 // inside a regex does not start a comment',
    b(['function a(s) {', '  return /\\/\\//.test(s) && s.indexOf("{") < 0;', '}']), 2);
  eq('M13 brace after a template literal that closed on the same line',
    b(['function a() {', '  const t = `x`; if (t) {', '  }', '}']), 3);
});

// ---- N: behaviour that must NOT change --------------------------------------------------------
block('N', () => {
  const b = (lines) => bodyEndRow(lines, 0);
  eq('N1 plain nested blocks', b(['function s(a, b) {', '  if (a) {', '    b();', '  }', '}']), 4);
  eq('N2 object literal', b(['const p = {', '  a: 1,', '};']), 2);
  eq('N3 no brace at all', b(['const r = 5;']), -1);
  eq('N4 a real brace after a comment on the same line',
    b(['function a() { // open', '  return 1;', '}']), 2);
  eq('N5 a real brace after a block comment on the same line',
    b(['function a() /* x */ {', '  return 1;', '}']), 2);
  eq('N6 stray ( inside a string in the body does not matter',
    b(['function q({ a }) {', "  const s = '(';", '  if (a) {', '  }', '}']), 4);
});

// ---- G: getSymbolsFromText ranges and the real file that exposed the bug -------------------------
block('G', () => {
  const fixture = [
    'function withComment(a, { b }) {',   // 0
    "  // quotes 'function alpha() {'",    // 1
    '  return a + b;',                     // 2
    '}',                                   // 3
    '',                                    // 4
    'function after() {',                  // 5
    '  return 1;',                         // 6
    '}',                                   // 7
  ].join('\n');
  const syms = getSymbolsFromText(fixture, 'fixture.js');
  const rng = (n) => { const s = syms.find((x) => x.name === n); return s ? [s.startRow, s.endRow] : null; };
  eq('G1 function with a comment brace spans its whole body', rng('withComment'), [0, 3]);
  eq('G2 the next function is unaffected', rng('after'), [5, 7]);

  const file = path.join(__dirname, '..', 'lib', 'match-engine.js');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const row = lines.findIndex((l) => l.startsWith('function matchContent('));
  const end = bodyEndRow(lines, row);
  eq('G3 real file: matchContent signature found', row >= 0, true);
  eq('G4 real file: matchContent body ends on a closing brace line', lines[end], '}');
  eq('G5 real file: matchContent spans more than 100 lines', end - row > 100, true);
  const gs = getSymbolsFromText(lines.join('\n'), file);
  const mc = gs.find((x) => x.name === 'matchContent');
  eq('G6 real file: getSymbolsFromText gives matchContent the same range', mc ? [mc.startRow, mc.endRow] : null, [row, end]);
});

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
}

// ===== tree-sitter-symbols.short-names =====
{
// One-letter symbol names (Finding A, 2026-10-12): explicit 'function f' and 'class C' declarations and
// function-valued consts must be found; bare 'const a = 1' / 'let i = 0' must NOT become symbols.
// ST_PATH env var points the test at another copy of tree-sitter-symbols.js (mutation harness).
const path = require('path');
const target = process.env.ST_PATH || path.join(__dirname, '..', 'lib', 'tree-sitter-symbols.js');
const { getSymbolsFromText } = require(target);

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; } else { failed++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function names(text, file) { return getSymbolsFromText(text, file || 'x.js').map(s => s.name); }
function find(text, name, file) { return getSymbolsFromText(text, file || 'x.js').find(s => s.name === name); }

const src = [
  'function f() {',          // 0
  '  let i = 0;',            // 1
  '  for (;;) {',            // 2
  '    const a = 1;',        // 3
  '  }',                     // 4
  '}',                       // 5
  'async function g(x) {',   // 6
  '  return x;',             // 7
  '}',                       // 8
  'class C {',               // 9
  '  m() {}',                // 10
  '}',                       // 11
  'const h = (a) => {',      // 12
  '  return a;',             // 13
  '};',                      // 14
  'const k = async x => {',  // 15
  '  return x;',             // 16
  '};',                      // 17
  'const q = function () {', // 18
  '};',                      // 19
  'const ff = 1; {',         // 20
  '}',                       // 21
  'function ff2() {',        // 22
  '}'                        // 23
].join('\n');

const got = names(src);
check('S1 function f found', got.includes('f'));
check('S2 async function g found', got.includes('g'));
check('S3 class C found', got.includes('C'));
check('S4 arrow const h found', got.includes('h'));
check('S5 async arrow const k found', got.includes('k'));
check('S6 function-expression const q found', got.includes('q'));
check('S7 let i = 0 is NOT a symbol', !got.includes('i'));
check('S8 const a = 1 is NOT a symbol', !got.includes('a'));
check('S9 two-letter names unchanged', got.includes('ff') && got.includes('ff2'));
check('S10 f spans rows 0-5', (() => { const s = find(src, 'f'); return s && s.startRow === 0 && s.endRow === 5; })());
check('S11 g spans rows 6-8', (() => { const s = find(src, 'g'); return s && s.startRow === 6 && s.endRow === 8; })());
check('S12 C is kind class, f is kind function', (find(src, 'C') || {}).kind === 'class' && (find(src, 'f') || {}).kind === 'function');
check('S13 exactly the expected symbols', got.slice().sort().join(',') === 'C,f,ff,ff2,g,h,k,q', got.join(','));

// A bare one-letter const with a brace within 6 lines must still be refused.
const bare = ['const x = 5;', 'if (x) {', '}'].join('\n');
check('S14 bare one-letter const with a nearby brace refused', !names(bare).includes('x'));
const bare2 = ['let n = foo(1);', 'while (n) {', '}'].join('\n');
check('S15 let n = call(...) refused', !names(bare2).includes('n'));

// C files keep the old rule (no one-letter names).
const csrc = ['int f(void)', '{', '  return 0;', '}', 'int main(void)', '{', '  return 0;', '}'].join('\n');
const cn = names(csrc, 'x.c');
check('S16 C one-letter function still skipped, main found', !cn.includes('f') && cn.includes('main'), cn.join(','));

console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
}

console.log = __log; console.log(__p + ' passed, ' + __f + ' failed');
