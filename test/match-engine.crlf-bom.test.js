'use strict';
// 2026-10-08 -- CRLF / BOM regression test for the WHOLE-LINE path the replace tool
// uses (match-engine.js matchContent + applyEdit; replace's default, non-fragment mode).
// Pins CURRENT behaviour as probed 2026-10-08 (probe printed first, assertions second):
//   * strict matching (autoRescue:false) treats a BOM or a CR as a real character;
//   * the default auto-rescue DOES match across a BOM / CR / CRLF difference and labels
//     the match with a transform (it is never reported as an exact match);
//   * applyEdit writes new_str VERBATIM: a BOM or CR on the replaced row survives only
//     if new_str carries it.
// No Pulsar, no atom -- run with `node test/match-engine.crlf-bom.test.js`.
//
// LIMIT: the fake buffer below does NOT normalise line endings the way Pulsar's
// TextBuffer.setTextInRange does, so what Pulsar writes for a new_str containing CRLF
// is NOT tested here. Whether Pulsar's buffer even holds a BOM or CRs is a Pulsar fact
// this file does not prove; it only pins how the ENGINE treats such characters if they
// are present. All source text is ASCII; non-ASCII data uses \u escapes.

const { matchContent, applyEdit } = require('../lib/match-engine');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL:', name, detail === undefined ? '' : JSON.stringify(detail)); }
}

const BOM = '\uFEFF';

function scopeFor(lines) {
  return { searchStart: 0, searchEnd: lines.length - 1, scopeLabel: '', _hasScope: false, via: 'none', hints: {} };
}
function match(lines, needle, opts) {
  return matchContent(needle, { allLines: lines, text: lines.join('\n') }, scopeFor(lines), opts || {});
}

// Multi-row fake buffer: text is the lines joined by '\n'; setTextInRange takes the
// [[row, col], [row, col]] ranges applyEdit produces.
function makeBuf(initial) {
  let text = initial.join('\n');
  function toOffset(p) {
    const ls = text.split('\n');
    let off = 0;
    for (let i = 0; i < p[0]; i++) off += ls[i].length + 1;
    return off + p[1];
  }
  return {
    getLines() { return text.split('\n'); },
    getLineCount() { return text.split('\n').length; },
    getText() { return text; },
    setTextInRange(range, t) { const a = toOffset(range[0]); const b = toOffset(range[1]); text = text.slice(0, a) + t + text.slice(b); },
  };
}
function editRow(lines, needle, newStr, opts) {
  const buf = makeBuf(lines);
  const m = match(buf.getLines(), needle, Object.assign({ autoRescue: false }, opts || {}));
  if (!m.matched) return { matched: false, m, lines: buf.getLines() };
  const e = applyEdit(buf, m, newStr, needle);
  return { matched: true, m, e, lines: buf.getLines() };
}

// W1-W4. A BOM on row 0 of the buffer.
{
  const lines = [BOM + 'const a = 1;', 'x'];
  const exact = match(lines, BOM + 'const a = 1;', { autoRescue: false });
  check('W1 needle WITH the BOM matches strictly', exact.matched === true && exact.matchLine === 0 && exact.transforms.length === 0, exact);
  const strict = match(lines, 'const a = 1;', { autoRescue: false });
  check('W2 needle WITHOUT the BOM is a strict noMatch', strict.matched === false && strict.reason === 'noMatch', strict);
  const fuzzy = match(lines, 'const a = 1;', { autoRescue: false, fuzzyContent: true });
  check('W3 fuzzyContent matches across the BOM and says so', fuzzy.matched === true && fuzzy.transforms.indexOf('fuzzyContent') !== -1, fuzzy);
  const rescued = match(lines, 'const a = 1;');
  check('W4 default auto-rescue matches across the BOM, flagged as a transform',
        rescued.matched === true && rescued.matchLine === 0 && rescued.transforms.length > 0, rescued);
  check('W4 rescued match reports the REAL buffer row (BOM included)', (rescued.actualLines || [])[0] === BOM + 'const a = 1;', rescued.actualLines);
}

// W5. CRLF needle against buffer lines that carry no CR.
{
  const lines = ['a', 'b', 'c'];
  const strict = match(lines, 'a\r\nb', { autoRescue: false });
  check('W5 CRLF needle vs LF lines: strict noMatch', strict.matched === false && strict.reason === 'noMatch', strict);
  const rescued = match(lines, 'a\r\nb');
  check('W5 CRLF needle vs LF lines: default rescue matches rows 0-1',
        rescued.matched === true && rescued.matchLine === 0 && rescued.matchEndLine === 1 && rescued.transforms.length > 0, rescued);
  check('W5 rescued match reports the real rows (no CR)', JSON.stringify(rescued.actualLines) === JSON.stringify(['a', 'b']), rescued.actualLines);
}

// W6. Buffer lines that DO carry a trailing CR (file split on LF only).
{
  const lines = ['a\r', 'b\r', 'c\r'];
  const lfNeedle = match(lines, 'a\nb', { autoRescue: false });
  check('W6 LF needle vs CR lines: strict noMatch', lfNeedle.matched === false && lfNeedle.reason === 'noMatch', lfNeedle);
  const crlfNeedle = match(lines, 'a\r\nb\r', { autoRescue: false });
  check('W6 CRLF needle with the last CR matches strictly', crlfNeedle.matched === true && crlfNeedle.matchLine === 0 && crlfNeedle.matchEndLine === 1 && crlfNeedle.transforms.length === 0, crlfNeedle);
  const single = match(lines, 'b\r', { autoRescue: false });
  check('W6 single-line needle ending in CR matches strictly', single.matched === true && single.matchLine === 1, single);
  const rescued = match(lines, 'a\nb');
  check('W6 default rescue matches LF needle against CR lines, flagged',
        rescued.matched === true && rescued.transforms.length > 0 && JSON.stringify(rescued.actualLines) === JSON.stringify(['a\r', 'b\r']), rescued);
}

// W7. Plain whole-line edit through applyEdit (control for the cases below).
{
  const before = ['one', 'two', 'three'];
  const r = editRow(before, 'two', 'TWO');
  check('W7 whole-line edit applied', r.matched && !r.e.error && r.e.startRow === 1 && r.e.endRow === 1, r);
  check('W7 whole-line edit content', JSON.stringify(r.lines) === JSON.stringify(['one', 'TWO', 'three']), r.lines);
  check('W7 control: edited result differs from the original', JSON.stringify(r.lines) !== JSON.stringify(before));
}

// W8. new_str is written VERBATIM: a CR on the replaced row survives only if new_str has it.
{
  const keep = editRow(['a\r', 'b\r', 'c\r'], 'b\r', 'B\r');
  check('W8 new_str with CR keeps the CR', keep.matched && JSON.stringify(keep.lines) === JSON.stringify(['a\r', 'B\r', 'c\r']), keep.lines);
  const drop = editRow(['a\r', 'b\r', 'c\r'], 'b\r', 'B');
  check('W8 new_str without CR drops it (verbatim write, no preservation)', drop.matched && JSON.stringify(drop.lines) === JSON.stringify(['a\r', 'B', 'c\r']), drop.lines);
}

// W9. Same for a BOM on the replaced row.
{
  const dropped = editRow([BOM + 'first', 'two'], BOM + 'first', 'FIRST');
  check('W9 new_str without BOM drops the BOM (verbatim write)', dropped.matched && dropped.lines[0] === 'FIRST', dropped.lines);
  const kept = editRow([BOM + 'first', 'two'], BOM + 'first', BOM + 'FIRST');
  check('W9 new_str with BOM keeps the BOM', kept.matched && kept.lines[0] === BOM + 'FIRST', kept.lines);
}

// W10. Rows that differ only by a trailing CR are two distinct strict hits: ambiguous
//      without occurrence, refused-not-guessed; occurrence:2 picks the second.
{
  const lines = ['b\r', 'b\r', 'x'];
  const amb = match(lines, 'b\r', { autoRescue: false });
  check('W10 identical CR rows are ambiguous', amb.matched === false && amb.reason === 'ambiguous', amb);
  const o2 = match(lines, 'b\r', { autoRescue: false, occurrence: 2 });
  check('W10 occurrence:2 picks the second row', o2.matched === true && o2.matchLine === 1, o2);
  const mixed = match(['b', 'b\r'], 'b', { autoRescue: false });
  check('W10 control: a row with a CR does not strictly match a needle without one', mixed.matched === true && mixed.matchLine === 0 && mixed.totalMatches === 1, mixed);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
