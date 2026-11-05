'use strict';
// 2026-10-16 -- tests for MULTI-LINE fragment replace (replace tool, fragment:true).
// Run with `node test/replace-fragment.multiline.test.js`.
//
// WHAT CHANGES: fragment:true used to refuse any old_str containing a line break
// (reason fragmentMultiLine). It now matches a span that may start and end MID-LINE across
// several rows, the way Claude's own Edit tool does. The matcher is lib/edit-match.js
// (findHits, the shared span matcher), the identifier guard runs on the FIRST and LAST edge
// of the span, and applyEditSpan writes a [row,startCol]..[endRow,endCol] span.
//
// WHAT IS PINNED: the planner's decisions, spans, refusal messages and stat keys, and the
// span writer against a tiny in-memory buffer. Single-line behaviour is pinned by
// replace-fragment.plan.test.js and must not change. All source text is ASCII.
// HONEST LIMITS: the handler (dry-run preview, linesChanged, lint range) needs Pulsar and is
// covered by the live probe, not here.

const { planFragmentReplace } = require('../lib/replace-fragment');
const { applyEditSpan } = require('../lib/match-engine');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL:', name, detail === undefined ? '' : JSON.stringify(detail)); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const LINES = [
  'function f() {',      // 0
  '  const a = 1;',      // 1
  '  return a;',         // 2
  '}',                   // 3
  'function g() {',      // 4
  '  const a = 1;',      // 5
  '  return a + b;',     // 6
  '}',                   // 7
];

function plan(over) {
  return planFragmentReplace(Object.assign({ lines: LINES, newStr: 'X' }, over));
}

// ---- M1: a span that starts and ends MID-LINE ---------------------------------------------
{
  const r = plan({ oldStr: 'a = 1;\n  return a;' });
  check('M1 ok', r.ok === true, r);
  if (r.ok) {
    eq('M1 edit', r.edit, { row: 1, startCol: 8, endRow: 2, endCol: 11, actualText: 'a = 1;\n  return a;', newStr: 'X' });
    eq('M1 tags', r.tags, ['fragment', 'multiLine']);
    eq('M1 totals', [r.totalMatches, r.guardedOut], [1, 0]);
  }
}
// ---- M2: whole-line boundaries, two rows ---------------------------------------------------
{
  const r = plan({ oldStr: '}\nfunction g() {' });
  check('M2 ok', r.ok === true, r);
  if (r.ok) eq('M2 edit', [r.edit.row, r.edit.startCol, r.edit.endRow, r.edit.endCol], [3, 0, 4, 14]);
}
// ---- M3: ambiguity lists the START row of each hit ------------------------------------------
{
  const r = plan({ oldStr: '  const a = 1;\n  return a' });
  check('M3 refused', r.ok === false, r);
  eq('M3 reason', r.reason, 'ambiguous');
  eq('M3 message', r.message, 'replace: the fragment appears 2 times in scope (lines 2, 6). Pass occurrence:N or a scope hint to pick one. Nothing was written.');
  eq('M3 statKeys', r.statKeys, ['fails.anchorAmbiguous', 'fragmentFails']);
  eq('M3 consecBump', r.consecBump, false);
  const second = plan({ oldStr: '  const a = 1;\n  return a', occurrence: 2 });
  check('M3 occurrence 2 ok', second.ok === true, second);
  if (second.ok) eq('M3 occurrence 2 span', [second.edit.row, second.edit.endRow], [5, 6]);
  const oob = plan({ oldStr: '  const a = 1;\n  return a', occurrence: 3 });
  eq('M3 occurrence 3 reason', oob.reason, 'occurrenceOutOfRange');
  eq('M3 occurrence 3 message', oob.message, 'replace: occurrence 3 is out of range; there are 2 candidate(s) in scope. Nothing was written.');
  eq('M3 occurrence 3 consecBump', oob.consecBump, true);
}
// ---- M4: identifier guard on the LAST edge (span ends inside an identifier) ----------------------
{
  const r = plan({ oldStr: 'a = 1;\n  ret' });
  eq('M4 reason', r.reason, 'onlyIdentifierGlued');
  eq('M4 message', r.message, 'replace: every occurrence of the fragment is glued to a longer identifier (2 refused, e.g. count inside discount). Pass guardIdentifier:false if a mid-identifier edit is intended. Nothing was written.');
  eq('M4 statKeys/consec', [r.statKeys, r.consecBump], [['fails.noMatch', 'fragmentFails'], true]);
  const off = plan({ oldStr: 'a = 1;\n  ret', guardIdentifier: false, occurrence: 1 });
  check('M4 guard false commits', off.ok === true && off.edit.row === 1 && off.edit.endRow === 2 && off.edit.endCol === 5, off);
}
// ---- M5: identifier guard on the FIRST edge (span starts inside an identifier) --------------------
{
  const r = plan({ oldStr: 'onst a = 1;\n  return a;' });
  eq('M5 reason', r.reason, 'onlyIdentifierGlued');
  const off = plan({ oldStr: 'onst a = 1;\n  return a;', guardIdentifier: false });
  check('M5 guard false commits', off.ok === true && off.edit.startCol === 3, off);
}
// ---- M6: CR and CRLF in old_str are normalised (buffer rows carry no CR) --------------------------
{
  const lf = plan({ oldStr: 'a = 1;\n  return a;' });
  for (const [label, s] of [['CRLF', 'a = 1;\r\n  return a;'], ['CR', 'a = 1;\r  return a;']]) {
    const r = plan({ oldStr: s });
    check('M6 ' + label + ' ok', r.ok === true, r);
    if (r.ok && lf.ok) eq('M6 ' + label + ' same edit as LF', r.edit, lf.edit);
  }
}
// ---- M7: the scope window still applies ----------------------------------------------------------------
{
  const r = plan({ oldStr: '  const a = 1;\n  return a', startRow: 4, endRow: 7 });
  check('M7 window picks the second function', r.ok === true && r.edit.row === 5 && r.edit.endRow === 6, r);
  const none = plan({ oldStr: '  const a = 1;\n  return a', startRow: 0, endRow: 1 });
  eq('M7 window too small is not found', none.reason, 'noMatch');
}
// ---- M8: drift pre-check for a multi-row span ---------------------------------------------------------
{
  const live = LINES.slice(); live[1] = '  const Q = 1;';
  const wet = plan({ oldStr: 'a = 1;\n  return a;', liveLines: live });
  eq('M8 drifted last row refuses', wet.reason, 'fragmentDrift');
  eq('M8 statKeys', wet.statKeys, ['fragmentFails']);
  const same = plan({ oldStr: 'a = 1;\n  return a;', liveLines: LINES.slice() });
  check('M8 identical live ok', same.ok === true, same);
  const dry = plan({ oldStr: 'a = 1;\n  return a;' });
  check('M8 no liveLines never drift-refuses', dry.ok === true, dry);
  const gone = plan({ oldStr: 'a = 1;\n  return a;', liveLines: LINES.slice(0, 2) });
  eq('M8 live row missing refuses', gone.reason, 'fragmentDrift');
}
// ---- M9: not found, flag clash and span ending at the start of a row ------------------------------------
{
  const nl = plan({ oldStr: 'zzz\nqqq' });
  eq('M9 not found reason', nl.reason, 'noMatch');
  eq('M9 not found message', nl.message, 'replace: fragment not found in scope. Nothing was written.');
  eq('M9 flag clash still beats multi-line', plan({ oldStr: 'a\nb', flags: { fuzzyContent: true } }).reason, 'fragmentUnsupportedFlag');
  const tail = plan({ oldStr: '  return a;\n' });
  check('M9 trailing newline ends at (nextRow, 0)', tail.ok === true && tail.edit.row === 2 && tail.edit.startCol === 0 && tail.edit.endRow === 3 && tail.edit.endCol === 0, tail);
}
// ---- M10: new_str is carried through verbatim; input lines are never mutated -----------------------------------
{
  const before = JSON.stringify(LINES);
  for (const ns of ['$&', 'two\nlines', '']) {
    const r = plan({ oldStr: 'a = 1;\n  return a;', newStr: ns });
    check('M10 newStr verbatim ' + JSON.stringify(ns), r.ok === true && r.edit.newStr === ns, r);
  }
  eq('M10 lines untouched', JSON.stringify(LINES), before);
}
// ---- M11: a single-line edit keeps its old shape (no endRow key, tags unchanged) --------------------------------
{
  const r = plan({ oldStr: 'return a;' });
  check('M11 ok', r.ok === true, r);
  if (r.ok) {
    eq('M11 edit has no endRow', r.edit, { row: 2, startCol: 2, endCol: 11, actualText: 'return a;', newStr: 'X' });
    eq('M11 tags', r.tags, ['fragment']);
  }
}

// ---- applyEditSpan against a tiny in-memory buffer ----------------------------------------------------------------
function fakeBuffer(lines) {
  const b = {
    lines: lines.slice(),
    getLines() { return b.lines.slice(); },
    getLineCount() { return b.lines.length; },
    setTextInRange(range, text) {
      const [[r0, c0], [r1, c1]] = range;
      const head = b.lines[r0].slice(0, c0);
      const tail = b.lines[r1].slice(c1);
      b.lines.splice(r0, r1 - r0 + 1, ...(head + text + tail).split('\n'));
    },
  };
  return b;
}
{
  const b = fakeBuffer(LINES);
  const r = applyEditSpan(b, { row: 1, startCol: 8, endRow: 2, endCol: 11, actualText: 'a = 1;\n  return a;' }, 'X');
  check('A1 no error', r && !r.error, r);
  eq('A1 result', r, { row: 1, startCol: 8, endRow: 2, endCol: 11, newLineCount: 7 });
  eq('A1 buffer', b.lines.slice(0, 3), ['function f() {', '  const X', '}']);
}
{
  const b = fakeBuffer(LINES);
  const r = applyEditSpan(b, { row: 1, startCol: 8, endRow: 2, endCol: 11, actualText: 'a = 1;\n  return a;' }, 'X\nY\nZ');
  eq('A2 grows the buffer', [r.newLineCount, b.lines[1], b.lines[3]], [9, '  const X', 'Z']);
}
{
  const b = fakeBuffer(LINES);
  b.lines[1] = '  const Q = 1;';
  const r = applyEditSpan(b, { row: 1, startCol: 8, endRow: 2, endCol: 11, actualText: 'a = 1;\n  return a;' }, 'X');
  eq('A3 drifted multi-row span is refused', r, { error: 'driftUnrecoverable' });
  eq('A3 buffer untouched', [b.lines[1], b.lines[2]], ['  const Q = 1;', '  return a;']);
}
{
  const b = fakeBuffer(LINES);
  const r = applyEditSpan(b, { row: 1, startCol: 8, endCol: 14, actualText: 'a = 1;' }, 'Y');
  eq('A4 single-row span still works (no endRow)', r, { row: 1, startCol: 8, endCol: 14, newLineCount: 8 });
  eq('A4 buffer', b.lines[1], '  const Y');
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail === 0 ? 0 : 1;
