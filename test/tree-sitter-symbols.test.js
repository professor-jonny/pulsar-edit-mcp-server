'use strict';
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
process.exit(fail ? 1 : 0);
