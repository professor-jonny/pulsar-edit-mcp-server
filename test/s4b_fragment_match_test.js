'use strict';
// S4b (2026-09-22) -- unit tests for lib/fragment-match.js (matchFragment) and
// lib/match-engine.js's applyEditSpan, using a fake buffer (plain object with
// getLines/setTextInRange/getLineCount). No Pulsar, no atom -- run with
// `node test/s4b_fragment_match_test.js`. Includes a negative control per the
// STANDING RULES note (use split().join(), never String.replace, for a
// control that cannot fail).

const assert = require('assert');
const { matchFragment } = require('../lib/fragment-match');
const { applyEditSpan } = require('../lib/match-engine');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL:', name); }
}

// ---------------------------------------------------------------------------
// matchFragment
// ---------------------------------------------------------------------------

// 1. Plain single hit, no identifier hazard.
{
  const r = matchFragment({ lines: ['const total = 1;'], needle: 'total' });
  check('F1 plain hit matched', r.matched === true);
  check('F1 plain hit row/col', r.row === 0 && r.startCol === 6 && r.endCol === 11);
  check('F1 plain hit totalMatches', r.totalMatches === 1);
}

// 2. The count-inside-discount hazard: guarded by default -> refused, not silently committed.
{
  const r = matchFragment({ lines: ['let discount = total * 2;'], needle: 'count' });
  check('F2 glued hit refused', r.matched === false && r.reason === 'onlyIdentifierGlued');
  check('F2 glued hit totalMatches counts the raw hit', r.totalMatches === 1);
  check('F2 glued hit guardedOut', r.guardedOut === 1);
}

// 3. Same hazard with guardIdentifier:false -> hit is returned, boundary.inside visible to caller.
{
  const r = matchFragment({ lines: ['let discount = total * 2;'], needle: 'count', guardIdentifier: false });
  check('F3 unguarded hit matched', r.matched === true);
  check('F3 unguarded hit boundary.inside true', r.boundary.inside === true);
}

// 4. A needle protected by non-identifier characters on BOTH its own edges is
//    NOT flagged, even though the same substring would be glued without them
//    (per identifier-boundary.js's own doc: a boundary only matters on an edge
//    where the fragment itself ends in an identifier char). ' count ' has a
//    space on each edge, so neither side reads as glued to 'dis'/'= 1'.
{
  const r = matchFragment({ lines: ['let dis count = 1;'], needle: ' count ' });
  check('F4 both-edges-protected fragment not flagged', r.matched === true && r.boundary.inside === false);
  // Contrast: 'count' alone in 'discount' (both edges glued) IS flagged -- see F2.
}

// 5. Negative control: split/join (never String.replace -- it would only hit
//    the first occurrence, silently masking a bug in the multi-hit path).
{
  const line = 'aaa aaa aaa';
  const rebuilt = line.split('aaa').join('XXX');
  check('F5 negative control setup sane', rebuilt === 'XXX XXX XXX');
  const r = matchFragment({ lines: [line], needle: 'aaa', occurrence: null });
  check('F5 three overlapping-free hits -> ambiguous without occurrence', r.matched === false && r.reason === 'ambiguous' && r.totalMatches === 3);
}

// 6. occurrence:N picks the Nth candidate (post-guard).
{
  const r = matchFragment({ lines: ['aaa aaa aaa'], needle: 'aaa', occurrence: 2 });
  check('F6 occurrence:2 picks second hit', r.matched === true && r.startCol === 4);
}

// 7. occurrence out of range is refused, never clamped.
{
  const r = matchFragment({ lines: ['aaa aaa aaa'], needle: 'aaa', occurrence: 9 });
  check('F7 occurrence out of range refused', r.matched === false && r.reason === 'occurrenceOutOfRange');
}

// 8. No match at all.
{
  const r = matchFragment({ lines: ['nothing here'], needle: 'zzz' });
  check('F8 no match', r.matched === false && r.reason === 'noMatch' && r.totalMatches === 0);
}

// 9. startRow/endRow scoping is honoured.
{
  const lines = ['total here', 'total here too', 'total again'];
  const r = matchFragment({ lines, needle: 'total', startRow: 1, endRow: 2 });
  check('F9 scoped to rows 1-2', r.matched === false && r.reason === 'ambiguous' && r.matchRows.every(row => row >= 2));
}

// 10. Invalid input handled without throwing.
{
  const r1 = matchFragment({ lines: 'not an array', needle: 'x' });
  const r2 = matchFragment({ lines: ['x'], needle: '' });
  check('F10 non-array lines', r1.matched === false && r1.reason === 'invalidInput');
  check('F10 empty needle', r2.matched === false && r2.reason === 'invalidInput');
}

// ---------------------------------------------------------------------------
// applyEditSpan -- fake buffer (plain object: getLines/setTextInRange/getLineCount)
// ---------------------------------------------------------------------------

function makeFakeBuffer(initialLines) {
  let lines = initialLines.slice();
  return {
    getLines() { return lines.slice(); },
    getLineCount() { return lines.length; },
    getText() { return lines.join('\n'); },
    // range: [[row, col], [row, col]] -- this fake only supports same-row ranges,
    // which is all applyEditSpan ever produces (fragments are single-line).
    setTextInRange(range, text) {
      const [[r0, c0], [r1, c1]] = range;
      assert.strictEqual(r0, r1, 'fake buffer only supports same-row setTextInRange');
      const line = lines[r0];
      lines[r0] = line.slice(0, c0) + text + line.slice(c1);
    },
  };
}

// 11. Plain successful span edit, no drift.
{
  const buf = makeFakeBuffer(['const total = 1;']);
  const match = { row: 0, startCol: 6, endCol: 11, actualText: 'total' };
  const edit = applyEditSpan(buf, match, 'sum');
  check('E1 no-drift edit applied', !edit.error);
  check('E1 no-drift edit content', buf.getLines()[0] === 'const sum = 1;');
}

// 12. Same-row drift: another edit shifted columns on the SAME row since matching.
{
  const buf = makeFakeBuffer(['const XXtotal = 1;']); // as if 2 chars were inserted before 'total'
  const match = { row: 0, startCol: 6, endCol: 11, actualText: 'total' }; // stale columns
  const edit = applyEditSpan(buf, match, 'sum');
  check('E2 same-row relocate applied', !edit.error);
  check('E2 same-row relocate content', buf.getLines()[0] === 'const XXsum = 1;');
}

// 13. Full-buffer drift: the row itself shifted (a line was inserted above).
{
  const buf = makeFakeBuffer(['// a new line was inserted above', 'const total = 1;']);
  const match = { row: 0, startCol: 6, endCol: 11, actualText: 'total' }; // stale row
  const edit = applyEditSpan(buf, match, 'sum');
  check('E3 full-buffer relocate applied', !edit.error);
  check('E3 full-buffer relocate row', edit.row === 1);
  check('E3 full-buffer relocate content', buf.getLines()[1] === 'const sum = 1;');
}

// 14. Unrecoverable drift: actualText no longer exists anywhere.
{
  const buf = makeFakeBuffer(['const sum = 1;']); // 'total' is gone entirely
  const match = { row: 0, startCol: 6, endCol: 11, actualText: 'total' };
  const edit = applyEditSpan(buf, match, 'sum');
  check('E4 unrecoverable drift refused', edit.error === 'driftUnrecoverable');
  check('E4 unrecoverable drift did not write', buf.getLines()[0] === 'const sum = 1;');
}

// 15. matchFragment's output plugs directly into applyEditSpan (integration
//     of the two pure pieces, still no Pulsar).
{
  const lines = ['let discount = total * 2;'];
  const m = matchFragment({ lines, needle: 'total' });
  check('E5 integration matched first', m.matched === true);
  const buf = makeFakeBuffer(lines);
  const edit = applyEditSpan(buf, m, 'price');
  check('E5 integration applied', !edit.error);
  check('E5 integration content', buf.getLines()[0] === 'let discount = price * 2;');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
