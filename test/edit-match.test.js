'use strict';
// Unit tests for lib/edit-match.js, the pure matcher
// modelled on Claude Code's Edit tool (literal and case-sensitive by default, must match
// once unless replaceAll). Renamed from regex_match_test.js on 2026-10-10. Expected values
// come from probe runs (print first, assert second) and the PARITY block ties the matcher to
// the live replace-all / sed behaviour captured from the running tools.
// Run: node test/edit-match.test.js
// EM_PATH (env) points the test at another copy of edit-match.js (mutation harness).
const path = require('path');
const emPath = process.env.EM_PATH || path.join(__dirname, '..', 'lib', 'edit-match.js');
const em = require(emPath);

let passed = 0;
let failed = 0;
function check(name, fn, expected) {
  let actual;
  try { actual = JSON.stringify(fn()); } catch (e) { actual = 'THROW: ' + e.message; }
  const want = JSON.stringify(expected);
  if (actual === want) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + ': got ' + actual + ', want ' + want); }
}

// fixture A, captured live (rows 0-8, last row empty)
const A = ['const Foo = 1;', 'const foo = 2;', 'foo foo foo', 'bar foo', 'let x = a/b;', 'function f() {', '  return foo;', '}', ''];

function spans(r) {
  if (r.ok === false) return r;
  return { total: r.totalMatches, spans: r.hits.map(h => [h.startRow, h.startCol, h.endRow, h.endCol]) };
}
function sliceSpan(lines, h) {
  if (h.startRow === h.endRow) return lines[h.startRow].slice(h.startCol, h.endCol);
  const out = [lines[h.startRow].slice(h.startCol)];
  for (let r = h.startRow + 1; r < h.endRow; r++) out.push(lines[r]);
  out.push(lines[h.endRow].slice(0, h.endCol));
  return out.join('\n');
}
const find = (o) => spans(em.findHits(o));
const plan = (o) => {
  const r = em.planEdit(o);
  return r.ok ? { ok: true, n: r.hits.length, idx: r.hits.map(h => h.index), total: r.totalMatches, replaceAll: r.replaceAll } : r;
};

// ---- PARITY with the live tools ---------------------------------------------
check('G1 wholeText caseSensitive:false foo = replace-all default, 7 hits', () => find({ lines: A, oldString: 'foo', caseSensitive: false }),
  { total: 7, spans: [[0, 6, 0, 9], [1, 6, 1, 9], [2, 0, 2, 3], [2, 4, 2, 7], [2, 8, 2, 11], [3, 4, 3, 7], [6, 9, 6, 12]] });
check('G2 wholeText foo is case-sensitive by DEFAULT (Edit-style), 6 hits = caseSensitive:true', () => find({ lines: A, oldString: 'foo' }),
  { total: 6, spans: [[1, 6, 1, 9], [2, 0, 2, 3], [2, 4, 2, 7], [2, 8, 2, 11], [3, 4, 3, 7], [6, 9, 6, 12]] });
check('G7 perLine foo = sed s/foo/X/g, 6 hits', () => find({ lines: A, oldString: 'foo', scope: 'perLine' }),
  { total: 6, spans: [[1, 6, 1, 9], [2, 0, 2, 3], [2, 4, 2, 7], [2, 8, 2, 11], [3, 4, 3, 7], [6, 9, 6, 12]] });
check('G10 without regex a ( is a plain literal, not a group (one hit in "function f() {")', () => find({ lines: A, oldString: '(' }), { total: 1, spans: [[5, 10, 5, 11]] });
check('G11 the default is an EXACT match: FOO finds nothing, caseSensitive:false finds 7', () => [find({ lines: A, oldString: 'FOO' }).total, find({ lines: A, oldString: 'FOO', caseSensitive: false }).total], [0, 7]);

// ---- window and coordinates ------------------------------------------------
const rows23 = { total: 4, spans: [[2, 0, 2, 3], [2, 4, 2, 7], [2, 8, 2, 11], [3, 4, 3, 7]] };
check('C1 wholeText window rows 2-3 keeps absolute rows', () => find({ lines: A, oldString: 'foo', startRow: 2, endRow: 3 }), rows23);
check('C2 perLine window rows 2-3 keeps absolute rows', () => find({ lines: A, oldString: 'foo', scope: 'perLine', startRow: 2, endRow: 3 }), rows23);
check('C3 a match ending at the line end stays on its row', () => find({ lines: ['ab', 'cd'], oldString: 'b' }), { total: 1, spans: [[0, 1, 0, 2]] });
check('C8 columns are UTF-16 units (astral char counts 2)', () => find({ lines: ['\ud83d\ude00x'], oldString: 'x' }), { total: 1, spans: [[0, 2, 0, 3]] });
check('C9 a non-string row is skipped (perLine) or empty (wholeText)', () => find({ lines: ['a', null, 'a'], oldString: 'a' }), { total: 2, spans: [[0, 0, 0, 1], [2, 0, 2, 1]] });
check('C10 a row carrying its own trailing CR matches a literal CRLF string', () => find({ lines: ['a\r', 'b'], oldString: 'a\r\nb' }), { total: 1, spans: [[0, 0, 1, 1]] });
check('C11 span slices back to the hit text for every hit (wholeText, 2 patterns)', () => {
  const out = [];
  for (const o of [{ oldString: 'foo', caseSensitive: false }, { oldString: 'foo\nbar' }]) {
    const r = em.findHits(Object.assign({ lines: A }, o));
    out.push(r.hits.every(h => sliceSpan(A, h) === h.text) && r.hits.length > 0);
  }
  return out;
}, [true, true]);
check('C13 perLine skips a non-string row (it is not searched as the text null)', () => find({ lines: ['n', null, 'n'], oldString: 'n', scope: 'perLine' }), { total: 2, spans: [[0, 0, 0, 1], [2, 0, 2, 1]] });
check('C14 a LITERAL oldString with a real newline matches across rows (Edit-style multi-line)', () => find({ lines: A, oldString: 'foo\nbar' }), { total: 1, spans: [[2, 8, 3, 3]] });


// ---- literal (default) -----------------------------------------
check('L1 by default a.b is literal (matches only a.b)', () => find({ lines: ['a.b axb'], oldString: 'a.b' }), { total: 1, spans: [[0, 0, 0, 3]] });
check('L3 regex specials are literal by default (a+b matches only a+b)', () => find({ lines: ['a+b aab'], oldString: 'a+b' }), { total: 1, spans: [[0, 0, 0, 3]] });

// ---- invalid input ----------------------------------------------------------
check('I1 empty oldString', () => em.findHits({ lines: A, oldString: '' }), { ok: false, reason: 'invalidInput' });
check('I2 lines is not an array', () => em.findHits({ lines: 'x', oldString: 'a' }), { ok: false, reason: 'invalidInput' });
check('I3 unknown scope', () => em.findHits({ lines: A, oldString: 'a', scope: 'nope' }), { ok: false, reason: 'invalidInput' });
check('I4 no argument at all', () => em.findHits(), { ok: false, reason: 'invalidInput' });

// ---- planEdit (Edit-style policy) -------------------------------------------
check('P1 more than one match without replaceAll is ambiguous and lists 1-based rows (one per hit)', () => plan({ lines: A, oldString: 'foo' }),
  { ok: false, reason: 'ambiguous', totalMatches: 6, matchRows: [2, 3, 3, 3, 4, 7] });
check('P2 exactly one match succeeds', () => plan({ lines: A, oldString: 'Foo' }), { ok: true, n: 1, idx: [1], total: 1, replaceAll: false });
check('P3 replaceAll returns every hit in order', () => plan({ lines: A, oldString: 'foo', replaceAll: true }), { ok: true, n: 6, idx: [1, 2, 3, 4, 5, 6], total: 6, replaceAll: true });
check('P4 occurrence picks one hit', () => plan({ lines: A, oldString: 'foo', occurrence: 3 }), { ok: true, n: 1, idx: [3], total: 6, replaceAll: false });
check('P5 occurrence picks one hit with replaceAll too', () => plan({ lines: A, oldString: 'foo', occurrence: 3, replaceAll: true }), { ok: true, n: 1, idx: [3], total: 6, replaceAll: true });
check('P6 occurrence 0 is refused', () => plan({ lines: A, oldString: 'foo', occurrence: 0 }), { ok: false, reason: 'occurrenceOutOfRange', occurrence: 0, totalMatches: 6 });
check('P7 occurrence above the hit count is refused', () => plan({ lines: A, oldString: 'foo', occurrence: 99 }), { ok: false, reason: 'occurrenceOutOfRange', occurrence: 99, totalMatches: 6 });
check('P8 a fractional occurrence is refused', () => plan({ lines: A, oldString: 'foo', occurrence: 1.5 }), { ok: false, reason: 'occurrenceOutOfRange', occurrence: 1.5, totalMatches: 6 });
check('P9 no hit is noMatch', () => plan({ lines: A, oldString: 'zzz' }), { ok: false, reason: 'noMatch', totalMatches: 0 });
check('P10 a non-boolean replaceAll (string) is invalidInput', () => plan({ lines: A, oldString: 'foo', replaceAll: 'x' }), { ok: false, reason: 'invalidInput' });
check('P10b a non-boolean replaceAll (number) is invalidInput', () => plan({ lines: A, oldString: 'foo', replaceAll: 1 }), { ok: false, reason: 'invalidInput' });
check('P12 a replaceAll zero-hit search is still noMatch', () => plan({ lines: A, oldString: 'zzz', replaceAll: true }), { ok: false, reason: 'noMatch', totalMatches: 0 });
check('P13 occurrence = hit count + 1 is refused', () => plan({ lines: A, oldString: 'foo', occurrence: 7 }), { ok: false, reason: 'occurrenceOutOfRange', occurrence: 7, totalMatches: 6 });

// ---- hit data and expandHit -------------------------------------------------
const one = (o) => em.findHits(o).hits[0];
check('H4 $& doubles the match', () => em.expandHit(one({ lines: ['foo'], oldString: 'foo' }), '$&$&'), 'foofoo');
check('H5 a hit carries exactly these fields', () => Object.keys(one({ lines: ['foo'], oldString: 'foo' })),
  ['index', 'startRow', 'startCol', 'endRow', 'endCol', 'text', 'groups', 'named', 'pre', 'post']);
check('H8 hit.index is the 1-based position among ALL hits even when one is picked', () => em.planEdit({ lines: A, oldString: 'foo', occurrence: 4 }).hits[0].index, 4);

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
