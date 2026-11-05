'use strict';
// 2026-10-08 -- unit tests for the PIECES the replace tool's fragment:true mode
// (lib/mcp-registration.js, fragment branch ~L2850-2924) is built from, driven the
// way that branch drives them: matchFragment over a scope window, then the live-span
// drift pre-check, then applyEditSpan on a fake buffer. No Pulsar, no atom -- run with
// `node test/replace-fragment.pieces.test.js`.
//
// SCOPE / HONEST LIMIT: this does NOT call the replace handler (it needs Pulsar's
// ctx, editor and stats). The handler-only glue -- refusal message text, bump() keys,
// fault logging, struct/nudge suffixes, dry-run preview -- is NOT covered here; that
// needs the fragment branch extracted into a pure module (like
// lib/str-replace-fragment.js). Generic matcher/applyEditSpan cases already live in
// test/fragment-match.test.js; this file adds what that one lacks: unicode, CR,
// BOM, scope windows across rows, special characters in new_str, and the drift guard.
// All source text is ASCII; non-ASCII test data uses \u escapes.

const assert = require('assert');
const { matchFragment } = require('../lib/fragment-match');
const { applyEditSpan } = require('../lib/match-engine');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL:', name, detail === undefined ? '' : JSON.stringify(detail)); }
}

function makeFakeBuffer(initialLines) {
  const lines = initialLines.slice();
  return {
    getLines() { return lines.slice(); },
    getLineCount() { return lines.length; },
    getText() { return lines.join('\n'); },
    setTextInRange(range, text) {
      const [[r0, c0], [r1, c1]] = range;
      assert.strictEqual(r0, r1, 'fake buffer only supports same-row setTextInRange');
      const line = lines[r0];
      lines[r0] = line.slice(0, c0) + text + line.slice(c1);
    },
  };
}

// Mirrors the handler's sequence: match, drift pre-check (L2899-2902), applyEditSpan.
// opts.liveLines simulates a buffer that changed after the match was resolved.
function runFragEdit(lines, needle, newStr, opts) {
  opts = opts || {};
  const m = matchFragment({
    lines, needle,
    startRow: opts.startRow, endRow: opts.endRow, occurrence: opts.occurrence,
    guardIdentifier: opts.guardIdentifier !== false,
  });
  if (!m.matched) return { ok: false, reason: m.reason, m, lines: lines.slice() };
  const buf = makeFakeBuffer(opts.liveLines || lines);
  const live = buf.getLines()[m.row];
  if (typeof live !== 'string' || live.slice(m.startCol, m.endCol) !== needle) {
    return { ok: false, reason: 'fragmentDrift', m, lines: buf.getLines() };
  }
  const edit = applyEditSpan(buf, { row: m.row, startCol: m.startCol, endCol: m.endCol, actualText: needle }, newStr);
  if (edit.error) return { ok: false, reason: 'applyEditSpanError:' + edit.error, m, lines: buf.getLines() };
  return { ok: true, m, lines: buf.getLines() };
}

// R1. A line holding an em dash (U+2014) before the needle: columns are UTF-16 units,
//     the dash must survive the edit untouched.
{
  const r = runFragEdit(['a \u2014 b total c'], 'total', 'sum');
  check('R1 em dash line edits', r.ok, r);
  check('R1 em dash line content', r.lines[0] === 'a \u2014 b sum c', r.lines);
  check('R1 em dash char intact', r.lines[0].charCodeAt(2) === 0x2014);
}

// R2. Astral character (surrogate pair) before the needle: the span is in UTF-16
//     units, so the result must equal a plain split/join of that single occurrence.
{
  const line = '\uD83D\uDE00 total x';
  const r = runFragEdit([line], 'total', 'sum');
  check('R2 astral line edits', r.ok, r);
  check('R2 astral line content', r.lines[0] === line.split('total').join('sum'), r.lines);
  check('R2 astral startCol in UTF-16 units', r.m.startCol === 3, r.m);
}

// R3. A line that still carries a trailing CR (CRLF buffer read as lines): the CR is
//     outside the span and must be preserved.
{
  const r = runFragEdit(['x = total;\r'], 'total', 'sum');
  check('R3 CR line edits', r.ok, r);
  check('R3 trailing CR preserved', r.lines[0] === 'x = sum;\r', r.lines);
}

// R4. BOM at the start of line 0 is outside the span and must be preserved.
{
  const r = runFragEdit(['\uFEFFconst total = 1;'], 'total', 'sum');
  check('R4 BOM line edits', r.ok, r);
  check('R4 BOM preserved', r.lines[0] === '\uFEFFconst sum = 1;', r.lines);
}

// R5. Scope window: hits on rows 0, 2, 4; searching rows 1..3 finds ONLY row 2 (not
//     ambiguous), and rows 0 and 4 are left alone.
{
  const lines = ['total 0', 'x', 'total 2', 'y', 'total 4'];
  const r = runFragEdit(lines, 'total', 'sum', { startRow: 1, endRow: 3 });
  check('R5 scoped single hit edits', r.ok && r.m.row === 2, r);
  check('R5 rows outside scope untouched', r.lines[0] === 'total 0' && r.lines[4] === 'total 4', r.lines);
  check('R5 scoped row changed', r.lines[2] === 'sum 2', r.lines);
}

// R6. Unscoped: three hits on rows 0, 2, 4 are ambiguous (matchRows are 1-based) and
//     nothing is edited; occurrence:2 and :3 pick rows 2 and 4.
{
  const lines = ['total 0', 'x', 'total 2', 'y', 'total 4'];
  const amb = runFragEdit(lines, 'total', 'sum');
  check('R6 ambiguous refused', !amb.ok && amb.reason === 'ambiguous', amb);
  check('R6 ambiguous matchRows are 1-based', JSON.stringify(amb.m.matchRows) === '[1,3,5]', amb.m);
  check('R6 ambiguous wrote nothing', JSON.stringify(amb.lines) === JSON.stringify(lines));
  const o2 = runFragEdit(lines, 'total', 'sum', { occurrence: 2 });
  check('R6 occurrence:2 -> row 2', o2.ok && o2.m.row === 2 && o2.lines[2] === 'sum 2', o2);
  const o3 = runFragEdit(lines, 'total', 'sum', { occurrence: 3 });
  check('R6 occurrence:3 -> row 4', o3.ok && o3.m.row === 4 && o3.lines[4] === 'sum 4', o3);
}

// R7. Out-of-range / non-integer occurrence values are refused, never clamped.
{
  const lines = ['total 0', 'x', 'total 2', 'y', 'total 4'];
  for (const occ of [0, -1, 1.5, 4]) {
    const r = runFragEdit(lines, 'total', 'sum', { occurrence: occ });
    check('R7 occurrence ' + occ + ' refused', !r.ok && r.reason === 'occurrenceOutOfRange', r);
    check('R7 occurrence ' + occ + ' wrote nothing', JSON.stringify(r.lines) === JSON.stringify(lines));
  }
}

// R8. Two hits on one line: occurrence picks the first or the second, the other stays.
{
  const r1 = runFragEdit(['total = total'], 'total', 'sum', { occurrence: 1 });
  const r2 = runFragEdit(['total = total'], 'total', 'sum', { occurrence: 2 });
  check('R8 first of two on a line', r1.ok && r1.lines[0] === 'sum = total', r1.lines);
  check('R8 second of two on a line', r2.ok && r2.lines[0] === 'total = sum', r2.lines);
}

// R9. new_str is literal: $&, $1, $', backslashes and a CR/LF-free tab are written as-is.
{
  for (const ns of ['$&', '$1', "$'", '\\n', 'a\tb', '$$']) {
    const r = runFragEdit(['x = total;'], 'total', ns);
    check('R9 literal new_str ' + JSON.stringify(ns), r.ok && r.lines[0] === 'x = ' + ns + ';', r.lines);
  }
}

// R10. Empty new_str deletes just the fragment.
{
  const r = runFragEdit(['a total b'], ' total', '');
  check('R10 empty new_str deletes fragment', r.ok && r.lines[0] === 'a b', r.lines);
}

// R11. Needle that IS a non-ASCII punctuation character (the em dash itself).
{
  const r = runFragEdit(['a \u2014 b'], '\u2014', '-');
  check('R11 em dash as the needle', r.ok && r.lines[0] === 'a - b', r);
}

// R12. Identifier guard through the replace sequence: refused by default with the
//      line untouched; guardIdentifier:false commits the mid-identifier edit.
{
  const refused = runFragEdit(['discount'], 'count', 'X');
  check('R12 glued hit refused by default', !refused.ok && refused.reason === 'onlyIdentifierGlued', refused);
  check('R12 glued refusal wrote nothing', refused.lines[0] === 'discount');
  const forced = runFragEdit(['discount'], 'count', 'X', { guardIdentifier: false });
  check('R12 guardIdentifier:false commits', forced.ok && forced.lines[0] === 'disX', forced);
}

// R13. Overlapping hits are all counted (advance by 1): 'aa' in 'aaaa' is 3 raw hits.
//      The guard is off here so identifier gluing does not hide the overlap case.
{
  const amb = runFragEdit(['aaaa'], 'aa', 'X', { guardIdentifier: false });
  check('R13 overlapping hits ambiguous', !amb.ok && amb.reason === 'ambiguous' && amb.m.totalMatches === 3, amb);
  const o2 = runFragEdit(['aaaa'], 'aa', 'X', { guardIdentifier: false, occurrence: 2 });
  check('R13 occurrence:2 of overlapping hits', o2.ok && o2.m.startCol === 1 && o2.lines[0] === 'aXa', o2);
}

// R14. DRIFT GUARD. The live buffer shifted columns after the match was resolved.
//      The handler's pre-check must refuse (its reason: fragmentDrift); and it is
//      NEEDED because applyEditSpan on its own would silently relocate and write.
{
  const resolvedFrom = ['const total = 1;'];
  const live = ['const XXtotal = 1;'];
  const r = runFragEdit(resolvedFrom, 'total', 'sum', { liveLines: live });
  check('R14 drift refused by pre-check', !r.ok && r.reason === 'fragmentDrift', r);
  check('R14 drift refusal wrote nothing', r.lines[0] === 'const XXtotal = 1;', r.lines);
  const m = matchFragment({ lines: resolvedFrom, needle: 'total' });
  const buf = makeFakeBuffer(live);
  const edit = applyEditSpan(buf, { row: m.row, startCol: m.startCol, endCol: m.endCol, actualText: 'total' }, 'sum');
  check('R14 applyEditSpan alone relocates and writes (why the guard exists)',
        !edit.error && buf.getLines()[0] === 'const XXsum = 1;', buf.getLines());
}

// R15. A needle containing a newline never matches inside the single-line scan (the
//      handler refuses it earlier with fragmentMultiLine; this pins the matcher side).
{
  const m = matchFragment({ lines: ['a', 'b'], needle: 'a\nb' });
  check('R15 multi-line needle does not match', m.matched === false && m.reason === 'noMatch', m);
}

// R16. Negative control (split/join, never String.replace): a replace-ALL result differs
//      from the single-occurrence expectation, so R-tests above can fail on an
//      accidental replace-all.
{
  const line = 'a total b total';
  const allReplaced = line.split('total').join('sum');
  const expected = 'a total b sum';
  check('R16 control: expected differs from replace-all', expected !== allReplaced, { expected, allReplaced });
  const r = runFragEdit([line], 'total', 'sum', { occurrence: 2 });
  check('R16 occurrence:2 edits ONLY the second', r.ok && r.lines[0] === expected, r.lines);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
