'use strict';
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
process.exit(fail ? 1 : 0);
