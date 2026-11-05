'use strict';
// test/match-engine.match-content-comment.test.js (2026-10-11)
// Pins lib/match-engine.js matchContent after Step 2a of the comment fail reason: the engine no longer
// auto-strips a needle's extra trailing comment and commits (recover.profiledMatch is called with
// stripComment:false). A comment-only difference is now a noMatch that diagnose() explains; the
// whitespace and unicode rescues are unchanged.
// Written probe-first (TEMP\probe_engine.js printed the real outputs before any assertion was written).
// Run: node test/match-engine.match-content-comment.test.js   (ME_PATH env points it at another copy, used by the
// mutation harness; the copy must live next to the other lib files). Last line is '<N> passed, <M> failed'.
const path = require('path');
const eng = require(process.env.ME_PATH || path.join(__dirname, '..', 'lib', 'match-engine.js'));
const { matchContent } = eng;

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}
function block(name, fn) {
  try { fn(); } catch (e) { fail++; console.log('FAIL ' + name + ' threw: ' + (e && e.message)); }
}

function scopeFor(lines) {
  return { searchStart: 0, searchEnd: lines.length - 1, scopeLabel: '', _hasScope: false, via: 'none', hints: {} };
}
// Only the fields this test pins (salvagedComment / outsideScope are plumbing slated for removal).
function match(lines, needle, opts) {
  const r = matchContent(needle, { allLines: lines, text: lines.join('\n') }, scopeFor(lines), opts || {});
  return r.matched
    ? { matched: true, transforms: r.transforms, matchLine: r.matchLine, matchEndLine: r.matchEndLine }
    : { matched: false, reason: r.reason, transforms: r.transforms };
}

const BUF = ['function f() {', '  const a = 1; // set a', '  const b = 2;', '  return a + b;', '}'];
const NO_MATCH = { matched: false, reason: 'noMatch', transforms: [] };

// ---- C: comment-only differences are failures now -------------------------------------------------
block('C', () => {
  eq('C1 extra comment on the LAST needle line (2-line needle) is no longer stripped and committed',
    match(BUF, '  const b = 2;\n  return a + b; // sum'), NO_MATCH);
  eq('C2 same for a 1-line needle',
    match(BUF, '  return a + b; // sum'), NO_MATCH);
  eq('C2b a comment on a non-last needle line was never stripped',
    match(BUF, '  const b = 2; // two\n  return a + b;'), NO_MATCH);
  eq('C2c a last-line comment too short to strip was never stripped',
    match(BUF, '  const b = 2; // two'), NO_MATCH);
  eq('C3 different comment (never rescued)',
    match(BUF, '  const a = 1; // other\n  const b = 2;'), NO_MATCH);
  eq('C4 missing comment (never rescued)',
    match(BUF, '  const a = 1;\n  const b = 2;'), NO_MATCH);
});

// ---- R: the rescues that stay ---------------------------------------------------------------------
block('R', () => {
  eq('R1 whitespace-only difference still rescued',
    match(BUF, '    const b = 2;\n    return a + b;'),
    { matched: true, transforms: ['fuzzyWhitespace'], matchLine: 2, matchEndLine: 3 });
  eq('R2 unicode-only difference still rescued',
    match(['const s = "hi";'], 'const s = \u201chi\u201d;'),
    { matched: true, transforms: ['fuzzyContent'], matchLine: 0, matchEndLine: 0 });
  eq('R3 comment kept in the needle, later line whitespace-different: still rescued',
    match(BUF, '  const a = 1; // set a\n    const b = 2;'),
    { matched: true, transforms: ['fuzzyWhitespace'], matchLine: 1, matchEndLine: 2 });
  eq('R4 exact needle', match(BUF, '  const b = 2;\n  return a + b;'),
    { matched: true, transforms: [], matchLine: 2, matchEndLine: 3 });
});

// ---- O: autoRescue:false is unchanged ---------------------------------------------------------------
block('O', () => {
  eq('O1 whitespace needle fails without autoRescue', match(BUF, '    const b = 2;\n    return a + b;', { autoRescue: false }), NO_MATCH);
  eq('O2 unicode needle fails without autoRescue', match(['const s = "hi";'], 'const s = \u201chi\u201d;', { autoRescue: false }), NO_MATCH);
  eq('O3 exact needle matches without autoRescue', match(BUF, '  const b = 2;\n  return a + b;', { autoRescue: false }),
    { matched: true, transforms: [], matchLine: 2, matchEndLine: 3 });
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
