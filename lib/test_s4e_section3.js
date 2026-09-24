// S4e Section 3 test (scratch, deleted after). Tests tryPlainFragmentMatch +
// commitFragmentEdit against the REAL lib/match-engine.js and
// lib/fragment-match.js (this file lives temporarily in lib/ so the drafts'
// relative requires resolve correctly), using a fake buffer object per the
// S4b test pattern (getLines/setTextInRange/getLineCount, no getText needed).
const assert = require('assert');
const { tryPlainFragmentMatch, commitFragmentEdit } = require('./_s4e_section3_fragment.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; } else { fail++; console.log('FAIL:', name); }
}

function fakeBuffer(lines) {
  let arr = lines.slice();
  return {
    getLines: () => arr.slice(),
    getLineCount: () => arr.length,
    setTextInRange: (range, text) => {
      // range: [[row,startCol],[row,endCol]] for single-row span edits
      const [[r0, c0], [r1, c1]] = range;
      const line = arr[r0];
      arr[r0] = line.slice(0, c0) + text + line.slice(c1);
      if (text.includes('\n')) {
        const parts = arr[r0].split('\n');
        arr.splice(r0, 1, ...parts);
      }
    },
  };
}

// -- count-inside-discount hazard: default guardIdentifier:true excludes it --
{
  const lines = ['let discount = 5;'];
  const r = tryPlainFragmentMatch({ allLines: lines, effectiveOldStr: 'count', fnStartRow: 0, fnEndRow: 0, occurrence: 1 });
  check('discount hazard: guarded out by default', r.matched === false && r.reason === 'onlyIdentifierGlued');
}
{
  const lines = ['let discount = 5;'];
  const r = tryPlainFragmentMatch({ allLines: lines, effectiveOldStr: 'count', fnStartRow: 0, fnEndRow: 0, occurrence: 1, guardIdentifier: false });
  check('discount hazard: escape hatch guardIdentifier:false lets it through', r.matched === true);
}

// -- plain clean match still works --
{
  const lines = ['const total = 1;'];
  const r = tryPlainFragmentMatch({ allLines: lines, effectiveOldStr: 'total', fnStartRow: 0, fnEndRow: 0, occurrence: 1 });
  check('clean match: matched', r.matched === true && r.row === 0);
}

// -- USER-CONFIRMED behavior: two hits on the SAME line both count (matchFragment's
//    per-occurrence scan), unlike str_replace's old .includes()-based presence check
//    which only ever counted one hit per line. User confirmed this session that
//    matchFragment's counting is the correct/intended behavior going forward. --
{
  const lines = ['foo(count, count);'];
  const first = tryPlainFragmentMatch({ allLines: lines, effectiveOldStr: 'count', fnStartRow: 0, fnEndRow: 0, occurrence: 1 });
  const second = tryPlainFragmentMatch({ allLines: lines, effectiveOldStr: 'count', fnStartRow: 0, fnEndRow: 0, occurrence: 2 });
  check('two hits one line: occurrence:1 resolves to first hit', first.matched === true && first.startCol === 4);
  check('two hits one line: occurrence:2 resolves to second hit (confirms 2 total matches counted)', second.matched === true && second.startCol === 11);
  check('two hits one line: totalMatches reports 2', first.totalMatches === 2);
}

// -- ambiguity guard fires across separate lines when occurrence is NOT given
//    (matchFragment only refuses as ambiguous when occurrence is omitted --
//    an explicit occurrence:N always just selects the Nth candidate, same
//    disambiguation pattern str_replace itself uses elsewhere) --
{
  const lines = ['const dup = 1;', 'const dup = 2;'];
  const r = tryPlainFragmentMatch({ allLines: lines, effectiveOldStr: 'dup', fnStartRow: 0, fnEndRow: 1, occurrence: undefined });
  check('cross-line ambiguity refused when no occurrence given', r.matched === false && r.reason === 'ambiguous');
}
{
  const lines = ['const dup = 1;', 'const dup = 2;'];
  const r = tryPlainFragmentMatch({ allLines: lines, effectiveOldStr: 'dup', fnStartRow: 0, fnEndRow: 1, occurrence: 2 });
  check('cross-line ambiguity resolved by explicit occurrence:2', r.matched === true && r.row === 1);
}

// -- commitFragmentEdit: applyEditSpan passthrough, no-drift case --
{
  const buf = fakeBuffer(['const total = 1;']);
  const match = tryPlainFragmentMatch({ allLines: buf.getLines(), effectiveOldStr: 'total', fnStartRow: 0, fnEndRow: 0, occurrence: 1 });
  const res = commitFragmentEdit(buf, match, 'sum');
  check('commit: success shape', typeof res.row === 'number' && !res.error);
  check('commit: buffer actually edited', buf.getLines()[0] === 'const sum = 1;');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
