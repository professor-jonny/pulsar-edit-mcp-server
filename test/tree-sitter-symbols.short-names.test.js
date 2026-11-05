'use strict';
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
process.exit(failed ? 1 : 0);
