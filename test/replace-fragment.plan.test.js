'use strict';
// 2026-10-09 -- tests for lib/replace-fragment.js (planFragmentReplace,
// describeApplyError). Run with `node test/replace-fragment.plan.test.js`.
//
// WHAT IS PINNED: the refusal MESSAGES are the golden strings captured LIVE on 2026-10-09
// (session note GOLDEN MESSAGES, A-H; scratch file lines 'const total = 1;' / 'const
// discount = 2;' / 'let total2 = total + total;' / '// two words here'). The statKeys,
// consecBump and logFault values were read from the handler source (lib/mcp-registration.js
// fragment branch, L2869-2908) on 2026-10-09 and are NOT yet verified live; the handler does
// not call the planner yet (that is Stage 1(b)).
//
// HONEST LIMITS: this tests the planner in isolation. It cannot prove the handler still
// produces the same text or bumps the same keys after Stage 1(b); the golden strings are
// the reference to re-check against at that point. Golden item J (dry-run preview) and the
// success-path stat bumps live in the handler and are not covered. All source text is
// ASCII.

const assert = require('assert');
const { planFragmentReplace, describeApplyError } = require('../lib/replace-fragment');
const { matchFragment } = require('../lib/fragment-match');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL:', name, detail === undefined ? '' : JSON.stringify(detail)); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const GOLDEN = [
  'const total = 1;',
  'const discount = 2;',
  'let total2 = total + total;',
  '// two words here',
];

function plan(over) {
  return planFragmentReplace(Object.assign({ lines: GOLDEN, newStr: 'X' }, over));
}

// ---- golden messages A-F, G, H ---------------------------------------------------------
{ // A. ambiguous; line 3 listed twice because it holds two clean hits (total2 is glued)
  const r = plan({ oldStr: 'total' });
  check('A refused', r.ok === false, r);
  eq('A reason', r.reason, 'ambiguous');
  eq('A message', r.message, 'replace: the fragment appears 3 times in scope (lines 1, 3, 3). Pass occurrence:N or a scope hint to pick one. Nothing was written.');
  eq('A statKeys', r.statKeys, ['fails.anchorAmbiguous', 'fragmentFails']);
  eq('A consecBump', r.consecBump, false);
  eq('A hintsFailed/logFault', [r.hintsFailed, r.logFault], [true, true]);
}
{ // B. every hit glued
  const r = plan({ oldStr: 'count' });
  eq('B reason', r.reason, 'onlyIdentifierGlued');
  eq('B message', r.message, 'replace: every occurrence of the fragment is glued to a longer identifier (1 refused, e.g. count inside discount). Pass guardIdentifier:false if a mid-identifier edit is intended. Nothing was written.');
  eq('B statKeys', r.statKeys, ['fails.noMatch', 'fragmentFails']);
  eq('B consecBump', r.consecBump, true);
}
{ // C. occurrence out of range
  const r = plan({ oldStr: 'total', occurrence: 9 });
  eq('C reason', r.reason, 'occurrenceOutOfRange');
  eq('C message', r.message, 'replace: occurrence 9 is out of range; there are 3 candidate(s) in scope. Nothing was written.');
  eq('C statKeys', r.statKeys, ['fails.noMatch', 'fragmentFails']);
  eq('C consecBump', r.consecBump, true);
}
{ // D. flag clash: all three flags give the same text and the same stats
  const D = 'replace refused: fragment:true is a plain literal match and cannot be combined with fuzzyWhitespace or fuzzyContent. Nothing was written.';
  for (const flag of ['fuzzyWhitespace', 'fuzzyContent']) {
    const r = plan({ oldStr: 'discount', flags: { [flag]: true } });
    eq('D ' + flag + ' reason', r.reason, 'fragmentUnsupportedFlag');
    eq('D ' + flag + ' message', r.message, D);
    eq('D ' + flag + ' statKeys', r.statKeys, ['fails.noMatch', 'fragmentFails']);
    eq('D ' + flag + ' consecBump', r.consecBump, false);
  }
}
{ // E. multi-line old_str (LF, CR, CRLF): NOT refused any more (2026-10-16), it is matched as a span.
  //    'a<break>b' is simply not in GOLDEN, so it is the ordinary not-found refusal. Span matching
  //    itself is pinned in replace-fragment.multiline.test.js.
  for (const [label, s] of [['LF', 'a\nb'], ['CR', 'a\rb'], ['CRLF', 'a\r\nb']]) {
    const r = plan({ oldStr: s });
    eq('E ' + label + ' reason', r.reason, 'noMatch');
    eq('E ' + label + ' message', r.message, 'replace: fragment not found in scope. Nothing was written.');
    eq('E ' + label + ' statKeys', r.statKeys, ['fails.noMatch', 'fragmentFails']);
    eq('E ' + label + ' consecBump', r.consecBump, true);
  }
}
{ // F. not found: no near-match diagnostics (observation in the golden note)
  const r = plan({ oldStr: 'zzzmissing' });
  eq('F reason', r.reason, 'noMatch');
  eq('F message', r.message, 'replace: fragment not found in scope. Nothing was written.');
  eq('F statKeys', r.statKeys, ['fails.noMatch', 'fragmentFails']);
  eq('F consecBump', r.consecBump, true);
  eq('F logFault', r.logFault, true);
}
{ // G. drift (source-only in the golden note): live line no longer holds the needle
  const live = GOLDEN.slice(); live[1] = 'const rebate = 2;';
  const r = plan({ oldStr: 'discount', liveLines: live });
  eq('G reason', r.reason, 'fragmentDrift');
  eq('G message', r.message, 'replace refused: the matched span changed in the buffer since it was resolved; re-run to re-resolve. Nothing was written.');
  eq('G statKeys', r.statKeys, ['fragmentFails']);
  eq('G consecBump', r.consecBump, false);
  eq('G logFault', r.logFault, true);
}
{ // H. applyEditSpan error (source-only): different message ending, no fault log, no consec
  const r = describeApplyError('span drifted');
  eq('H ok', r.ok, false);
  eq('H reason', r.reason, 'applyEditSpanError');
  eq('H message', r.message, 'replace failed: span drifted -- the buffer changed since the match was resolved; re-run to re-resolve.');
  eq('H statKeys', r.statKeys, ['fails.noMatch', 'fragmentFails']);
  eq('H consecBump/logFault/hintsFailed', [r.consecBump, r.logFault, r.hintsFailed], [false, false, true]);
}

// ---- the ambiguity list cap (10 then '... and N more') ----------------------------------
{
  const many = []; for (let i = 0; i < 12; i++) many.push('// line');
  const r = planFragmentReplace({ lines: many, oldStr: '// line', newStr: 'X' });
  eq('cap 12 hits', r.message, 'replace: the fragment appears 12 times in scope (lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, ... and 2 more). Pass occurrence:N or a scope hint to pick one. Nothing was written.');
  const ten = many.slice(0, 10);
  const r10 = planFragmentReplace({ lines: ten, oldStr: '// line', newStr: 'X' });
  eq('cap exactly 10 hits has no suffix', r10.message, 'replace: the fragment appears 10 times in scope (lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10). Pass occurrence:N or a scope hint to pick one. Nothing was written.');
  const r11 = planFragmentReplace({ lines: many.slice(0, 11), oldStr: '// line', newStr: 'X' });
  check('cap 11 hits says 1 more', r11.message.includes(', ... and 1 more)'), r11.message);
}

// ---- success paths ------------------------------------------------------------------------
{
  const r = plan({ oldStr: 'discount', newStr: 'rebate' });
  check('S1 ok', r.ok === true, r);
  eq('S1 edit', r.edit, { row: 1, startCol: 6, endCol: 14, actualText: 'discount', newStr: 'rebate' });
  eq('S1 tags', r.tags, ['fragment']);
  eq('S1 totals', [r.totalMatches, r.guardedOut], [1, 0]);
}
{ // occurrence picks among CLEAN candidates; total2 is excluded and reported as guardedOut
  const r = plan({ oldStr: 'total', occurrence: 2 });
  check('S2 ok', r.ok === true, r);
  eq('S2 edit', r.edit, { row: 2, startCol: 13, endCol: 18, actualText: 'total', newStr: 'X' });
  eq('S2 tags', r.tags, ['fragment', 'guardedOut:1']);
  eq('S2 totals', [r.totalMatches, r.guardedOut], [3, 1]);
}
{ // scope window narrows the candidates (row indexes are 0-based; message rows are 1-based)
  const r = plan({ oldStr: 'total', startRow: 2, endRow: 2 });
  eq('S3 ambiguous inside window', r.message, 'replace: the fragment appears 2 times in scope (lines 3, 3). Pass occurrence:N or a scope hint to pick one. Nothing was written.');
  const r2 = plan({ oldStr: 'total', startRow: 0, endRow: 0 });
  check('S3 window of one clean hit', r2.ok === true && r2.edit.row === 0, r2);
}
{ // guardIdentifier: only an explicit false turns it off (the handler passes !== false)
  const off = plan({ oldStr: 'count', guardIdentifier: false });
  check('G1 guard false commits mid-identifier', off.ok === true && off.edit.row === 1 && off.edit.startCol === 9, off);
  const undef = plan({ oldStr: 'count', guardIdentifier: undefined });
  eq('G1 undefined means guard ON', undef.reason, 'onlyIdentifierGlued');
  const on = plan({ oldStr: 'count', guardIdentifier: true });
  eq('G1 true means guard ON', on.reason, 'onlyIdentifierGlued');
}
{ // liveLines identical -> no drift; liveLines omitted -> the drift check does not run
  const same = plan({ oldStr: 'discount', liveLines: GOLDEN.slice() });
  check('D1 live identical ok', same.ok === true, same);
  const drifted = GOLDEN.slice(); drifted[1] = 'x';
  const dry = plan({ oldStr: 'discount' });
  check('D1 dry run (no liveLines) never drift-refuses', dry.ok === true, dry);
  const wet = plan({ oldStr: 'discount', liveLines: drifted });
  eq('D1 same call with drifted liveLines refuses', wet.reason, 'fragmentDrift');
  const shortLive = plan({ oldStr: 'discount', liveLines: [] });
  eq('D1 live row missing refuses', shortLive.reason, 'fragmentDrift');
  const notArray = plan({ oldStr: 'discount', liveLines: null });
  eq('D1 liveLines null (not undefined) is treated as drift, not skipped', notArray.reason, 'fragmentDrift');
}

// ---- ordering of the refusals (mirrors the handler) ----------------------------------------
{
  eq('O1 flag clash beats multi-line', plan({ oldStr: 'a\nb', flags: { fuzzyContent: true } }).reason, 'fragmentUnsupportedFlag');
  eq('O2 multi-line is matched as a span (no hit here), not refused', plan({ oldStr: 'total\n' }).reason, 'noMatch');
  eq('O3 matcher refusal beats drift', plan({ oldStr: 'total', liveLines: [] }).reason, 'ambiguous');
  eq('O4 falsey flag values do not clash', plan({ oldStr: 'discount', flags: { fuzzyContent: false, fuzzyWhitespace: undefined } }).ok, true);
}

// ---- odd inputs -------------------------------------------------------------------------------
{
  const e = plan({ oldStr: '' });
  eq('X1 empty needle reason', e.reason, 'invalidInput');
  eq('X1 empty needle message', e.message, 'replace: fragment not found in scope. Nothing was written.');
  eq('X1 empty needle stats', [e.statKeys, e.consecBump], [['fails.noMatch', 'fragmentFails'], true]);
  const u = plan({ oldStr: undefined });
  eq('X2 undefined needle does not throw and refuses', [u.ok, u.reason], [false, 'invalidInput']);
  const noReason = planFragmentReplace({ lines: GOLDEN, oldStr: 'q', newStr: 'X', matcher: () => ({ matched: false }) });
  eq('X3 matcher without a reason defaults to noMatch', [noReason.reason, noReason.statKeys], ['noMatch', ['fails.noMatch', 'fragmentFails']]);
  const badRow = planFragmentReplace({ lines: GOLDEN, oldStr: 'q', newStr: 'X', liveLines: GOLDEN, matcher: () => ({ matched: true, row: 99, startCol: 0, endCol: 1, totalMatches: 1, guardedOut: 0 }) });
  eq('X4 matched row past the live buffer is drift', badRow.reason, 'fragmentDrift');
}

// ---- new_str is carried through verbatim, never interpreted ------------------------------------
{
  for (const ns of ['$&', "$1$'$$", 'a\\b\tc', 'two\nlines', '']) {
    const r = plan({ oldStr: 'discount', newStr: ns });
    check('V1 newStr verbatim ' + JSON.stringify(ns), r.ok === true && r.edit.newStr === ns, r);
  }
}

// ---- purity: the input lines are never mutated ---------------------------------------------------
{
  const before = JSON.stringify(GOLDEN);
  plan({ oldStr: 'total' }); plan({ oldStr: 'discount' }); plan({ oldStr: 'zzz' });
  eq('P1 lines untouched', JSON.stringify(GOLDEN), before);
}

// ---- parity with matchFragment: planner ok === matcher matched, same span ---------------------------
{
  const cases = [
    { needle: 'total' }, { needle: 'total', occurrence: 2 }, { needle: 'total', occurrence: 4 },
    { needle: 'count' }, { needle: 'count', guardIdentifier: false }, { needle: 'discount' },
    { needle: 'two words' }, { needle: 'zzz' }, { needle: 'total', startRow: 2 }, { needle: 'e', startRow: 1, endRow: 1 },
  ];
  for (const c of cases) {
    const m = matchFragment({ lines: GOLDEN, needle: c.needle, startRow: c.startRow, endRow: c.endRow, occurrence: c.occurrence, guardIdentifier: c.guardIdentifier !== false });
    const p = planFragmentReplace({ lines: GOLDEN, oldStr: c.needle, newStr: 'X', startRow: c.startRow, endRow: c.endRow, occurrence: c.occurrence, guardIdentifier: c.guardIdentifier });
    const label = 'PAR ' + JSON.stringify(c);
    check(label + ' decision', p.ok === m.matched, { p, m });
    if (m.matched) eq(label + ' span', [p.edit.row, p.edit.startCol, p.edit.endCol], [m.row, m.startCol, m.endCol]);
    else eq(label + ' reason', p.reason, m.reason);
  }
}

// ---- every planner refusal ends 'Nothing was written.' (describeApplyError is the exception) -------------
{
  const refusals = [
    plan({ oldStr: 'total' }), plan({ oldStr: 'count' }), plan({ oldStr: 'total', occurrence: 9 }),
    plan({ oldStr: 'x', flags: { fuzzyContent: true } }), plan({ oldStr: 'a\nb' }), plan({ oldStr: 'zzz' }),
    plan({ oldStr: 'discount', liveLines: [] }),
  ];
  check('Z1 all end with Nothing was written.', refusals.every(r => !r.ok && r.message.endsWith('Nothing was written.')), refusals.map(r => r.message));
  check('Z1 describeApplyError does not', !describeApplyError('e').message.endsWith('Nothing was written.'));
  check('Z1 every refusal asks for hintsFailed', refusals.every(r => r.hintsFailed === true));
  check('Z1 every refusal lists fragmentFails', refusals.every(r => (r.statKeys || []).includes('fragmentFails')));
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail === 0 ? 0 : 1; // exitCode, not exit(): lets a long failure listing flush on a pipe
