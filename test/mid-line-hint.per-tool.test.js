'use strict';
// Regression test (2026-10-18) -- TODO R1j: mid-line failure wording for delete (matchString) and insert
// (afterContent / beforeContent).
// Run from the package root:   node test/mid-line-hint.per-tool.test.js
// Plain node, no Pulsar, no files written. Drives match-engine.buildFailResponse and scans the handler source.
//
// The problem: R1e/R1h/R1i taught replace to say "your text exists, it only fails as a whole-line match" when
// old_str starts or ends mid-line. delete (matchString) and insert (afterContent / beforeContent) match WHOLE
// LINES too, but still showed the typo/whitespace wording ("Similarity 83%, rebuild old_str") and called the
// needle old_str. The NOTE and the diagnosis sentence are replace-specific, so they need wording per tool.
//
// What is pinned:
//   1. Helpers in lib/mid-line-hint.js: midLineKind(tool), midLineWhat(kind, subject), midLineAdvice(kind, subject).
//      midLineAdvice() with no argument is still the replace wording.
//   2. Engine: with a midLine and a subject, the diagnosis sentence and the NOTE name the tool's own parameter
//      and the right alternative (delete: replace fragment:true + new_str '' or whole lines; insert: afterString /
//      beforeString or whole lines); no old_str, no retry nudge, retryStash:false.
//   3. replace is unchanged (no subject): same sentence, same NOTE.
//   4. Without a midLine a subject only renames the needle: the text equals the plain text with old_str replaced by the
//      subject (R1k, 2026-10-22; under R1j it was byte-identical). The full set of failure kinds is in
//      match-engine.subject-wording.test.js.
//   5. Wiring: the delete matchString and insert content-anchor failure paths compute midLineHint and pass
//      midLine + subject to buildFailResponse (source scan; the handlers cannot run without Pulsar).

const fs = require('fs');
const path = require('path');
const eng = require('../lib/match-engine');
const mlh = require('../lib/mid-line-hint');

let bad = 0, pass = 0;
function ok(label, cond, detail) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && detail !== undefined) console.log('      ' + detail);
}
const SAFE = (fn) => { try { return fn(); } catch (e) { return 'THROW: ' + e.message; } };
const ascii = (s) => typeof s === 'string' && /^[\x00-\x7F]*$/.test(s);
const has = (s, sub) => typeof s === 'string' && s.includes(sub);

const buf = [
  'function alpha() {',   // L1
  '  const total = 1;',   // L2
  '  return total;',      // L3
  '}',                    // L4
];
const text = buf.join('\n');
const mk = () => ({ consec: { count: 1 }, allLines: buf, text });
const miss = { matched: false, reason: 'notFound' };
const scope = { searchStart: 0, searchEnd: buf.length - 1, scopeLabel: '', _hasScope: false, via: 'none', hints: {} };
const NUDGE = 'Retry cheaply';
const needle = 'const total = 1';
const hint = mlh.midLineHint({ needle, text, scopeStart: 0, scopeEnd: buf.length - 1, regex: false, fuzzyWhitespace: false, fuzzyContent: false });

const build = (tool, extra) => SAFE(() => eng.buildFailResponse(Object.assign({ tool, ctx: mk(), match: miss, needle, isCodeFile: true, scope }, extra)));
const textOf = (r) => (r && r.content && r.content[0] && typeof r.content[0].text === 'string') ? r.content[0].text : String(r);
const lastLine = (t) => t.trim().split('\n').pop();

ok('0 setup: the needle is detected as mid-line', !!hint && hint.startsMid && hint.endsMid, JSON.stringify(hint));

// 1. helpers ---------------------------------------------------------------------------------------------------
ok('1 midLineKind: delete -> deleteMatch', SAFE(() => mlh.midLineKind('delete')) === 'deleteMatch', String(SAFE(() => mlh.midLineKind('delete'))));
ok('1 midLineKind: insert -> insertAnchor', SAFE(() => mlh.midLineKind('insert')) === 'insertAnchor', String(SAFE(() => mlh.midLineKind('insert'))));
ok('1 midLineKind: replace -> replace', SAFE(() => mlh.midLineKind('replace')) === 'replace');
ok('1 midLineKind: replace-block and unknown fall back to replace', SAFE(() => mlh.midLineKind('replace-block')) === 'replace' && SAFE(() => mlh.midLineKind(undefined)) === 'replace');

ok('1 midLineWhat: replace', SAFE(() => mlh.midLineWhat('replace')) === 'a whole-line replace', String(SAFE(() => mlh.midLineWhat('replace'))));
ok('1 midLineWhat: deleteMatch uses the subject', SAFE(() => mlh.midLineWhat('deleteMatch', 'matchString')) === 'delete matchString', String(SAFE(() => mlh.midLineWhat('deleteMatch', 'matchString'))));
ok('1 midLineWhat: deleteMatch default subject is matchString', SAFE(() => mlh.midLineWhat('deleteMatch')) === 'delete matchString');
ok('1 midLineWhat: insertAnchor uses the subject', SAFE(() => mlh.midLineWhat('insertAnchor', 'beforeContent')) === 'insert beforeContent', String(SAFE(() => mlh.midLineWhat('insertAnchor', 'beforeContent'))));
ok('1 midLineWhat: insertAnchor default subject is afterContent', SAFE(() => mlh.midLineWhat('insertAnchor')) === 'insert afterContent');

const advDefault = SAFE(() => mlh.midLineAdvice());
ok('1 midLineAdvice() is still the replace wording', has(advDefault, 'fragment:true') && has(advDefault, 'whole call') && has(advDefault, 'new_str') && advDefault === SAFE(() => mlh.midLineAdvice('replace')), advDefault);
const advDel = SAFE(() => mlh.midLineAdvice('deleteMatch', 'matchString'));
ok('1 delete NOTE: starts with NOTE: and names matchString', typeof advDel === 'string' && advDel.startsWith('NOTE:') && has(advDel, 'matchString'), advDel);
ok('1 delete NOTE: offers replace with fragment:true and an empty new_str', has(advDel, 'replace') && has(advDel, 'fragment:true') && has(advDel, "new_str:''"), advDel);
ok('1 delete NOTE: says extending to whole lines deletes those whole lines', /whole line/i.test(advDel) && /delet/i.test(advDel), advDel);
ok('1 delete NOTE: no old_str, ASCII only', !has(advDel, 'old_str') && ascii(advDel), advDel);
const advAfter = SAFE(() => mlh.midLineAdvice('insertAnchor', 'afterContent'));
ok('1 insert (after) NOTE: names afterContent and afterString, not beforeString', has(advAfter, 'afterContent') && has(advAfter, 'afterString') && !has(advAfter, 'beforeString'), advAfter);
ok('1 insert (after) NOTE: offers whole lines too, no fragment:true, no old_str, ASCII', /whole line/i.test(advAfter) && !has(advAfter, 'fragment:true') && !has(advAfter, 'old_str') && ascii(advAfter), advAfter);
const advBefore = SAFE(() => mlh.midLineAdvice('insertAnchor', 'beforeContent'));
ok('1 insert (before) NOTE: names beforeContent and beforeString, not afterString', has(advBefore, 'beforeContent') && has(advBefore, 'beforeString') && !has(advBefore, 'afterString'), advBefore);

// 2. engine wording per tool -------------------------------------------------------------------------------------
let r = build('delete', { midLine: hint, subject: 'matchString' });
let t = textOf(r);
ok('2 delete: the diagnosis names matchString, not old_str', has(t, 'matchString starts and ends in the middle of a line, and delete matchString only matches complete lines.') && !has(t, 'old_str'), t);
ok('2 delete: no replace-specific sentence', !has(t, 'a whole-line replace'), t);
ok('2 delete: NOTE offers replace fragment:true with an empty new_str', has(t, 'NOTE:') && has(t, 'fragment:true') && has(t, "new_str:''"), t);
ok('2 delete: no retry nudge, NOTE is the last line', !has(t, NUDGE) && lastLine(t).startsWith('NOTE:'), lastLine(t));
ok('2 delete: matched:false and retryStash:false', r && r.matched === false && r.retryStash === false, JSON.stringify(r && Object.keys(r)));

r = build('insert', { midLine: hint, subject: 'afterContent' });
t = textOf(r);
ok('2 insert (after): the diagnosis names afterContent, not old_str', has(t, 'afterContent starts and ends in the middle of a line, and insert afterContent only matches complete lines.') && !has(t, 'old_str'), t);
ok('2 insert (after): NOTE offers afterString', has(t, 'NOTE:') && has(lastLine(t), 'afterString') && !has(lastLine(t), 'beforeString'), lastLine(t));
ok('2 insert (after): no retry nudge, NOTE is the last line, retryStash:false', !has(t, NUDGE) && lastLine(t).startsWith('NOTE:') && r.retryStash === false && r.matched === false, lastLine(t));

r = build('insert', { midLine: hint, subject: 'beforeContent' });
t = textOf(r);
ok('2 insert (before): the diagnosis names beforeContent and the NOTE offers beforeString', has(t, 'beforeContent starts and ends in the middle of a line, and insert beforeContent only matches complete lines.') && has(lastLine(t), 'beforeString') && !has(lastLine(t), 'afterString') && !has(t, 'old_str'), lastLine(t));

// 3. replace unchanged --------------------------------------------------------------------------------------------
r = build('replace', { midLine: hint });
t = textOf(r);
ok('3 replace: same diagnosis sentence as before', has(t, 'old_str starts and ends in the middle of a line, and a whole-line replace only matches complete lines.'), t);
ok('3 replace: same NOTE (fragment:true, whole call, new_str)', has(t, 'NOTE:') && has(t, 'fragment:true') && has(t, 'whole call') && has(t, 'new_str'), t);
ok('3 replace: no retry nudge, retryStash:false', !has(t, NUDGE) && r.retryStash === false);

// 4. a subject without a midLine only renames the needle (R1k, 2026-10-22; R1j used to change NOTHING here) ---------------
['delete', 'insert'].forEach((tool) => {
  const subj = tool === 'delete' ? 'matchString' : 'afterContent';
  const a = build(tool, {});
  const b = build(tool, { subject: subj });
  ok('4 ' + tool + ': a subject without midLine only renames the needle (R1k: old_str becomes ' + subj + ', nothing else changes)', textOf(a).split('old_str').join(subj) === textOf(b) && textOf(a).indexOf('old_str') >= 0 && textOf(b).indexOf('old_str') < 0, 'a=' + textOf(a).length + ' b=' + textOf(b).length);
  ok('4 ' + tool + ': the delete nudge is kept (insert has none) and there is no retryStash key', (tool !== 'delete' || has(textOf(b), NUDGE)) && !(b && 'retryStash' in b), JSON.stringify(b && Object.keys(b)));
});

// 5. wiring ------------------------------------------------------------------------------------------------------
const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
function seg(startMarker, endMarker) {
  const s = reg.indexOf(startMarker);
  if (s === -1) return null;
  const e = reg.indexOf(endMarker, s);
  return e === -1 ? null : reg.slice(s, e + endMarker.length);
}
const insSeg = seg('const match = matchContentEngine(anchor, { allLines, text: ctx.text }, scope, { fuzzyWhitespace, fuzzyContent, occurrence });', 'return { ...fail, inserted: false };');
const delSeg = seg('const _match = matchContentEngine(matchString,', 'return { ...fail, deleted: false };');
ok('5 wiring: found the insert content-anchor failure path', insSeg !== null);
ok('5 wiring: found the delete matchString failure path', delSeg !== null);
if (insSeg) {
  ok('5 insert: computes midLineHint with the scope bounds', /midLineHint\(\s*\{[^}]*needle:\s*anchor/.test(insSeg) && /scopeStart:\s*scope\s*&&\s*scope\.searchStart/.test(insSeg) && /scopeEnd:\s*scope\s*&&\s*scope\.searchEnd/.test(insSeg));
  ok('5 insert: skips the hint for an ambiguous match', /_midLine\s*=[^;\n]*reason\s*===\s*'ambiguous'\s*\?\s*null/.test(insSeg));
  ok('5 insert: passes midLine and subject:hintName to buildFailResponse', /buildFailResponse\(\{[^\n]*midLine\s*:[^\n]*subject\s*:\s*hintName/.test(insSeg) || /buildFailResponse\(\{[^\n]*subject\s*:\s*hintName[^\n]*midLine\s*:/.test(insSeg));
}
if (delSeg) {
  ok('5 delete: computes midLineHint on matchString with the scope bounds', /midLineHint\(\s*\{[^}]*needle:\s*matchString/.test(delSeg) && /scopeStart:\s*_scope\s*&&\s*_scope\.searchStart/.test(delSeg) && /scopeEnd:\s*_scope\s*&&\s*_scope\.searchEnd/.test(delSeg));
  ok('5 delete: skips the hint for an ambiguous match', /_midLine\s*=[^;\n]*reason\s*===\s*'ambiguous'\s*\?\s*null/.test(delSeg));
  ok("5 delete: passes midLine and subject:'matchString' to buildFailResponse", /buildFailResponse\(\{[^\n]*midLine\s*:[^\n]*subject\s*:\s*'matchString'/.test(delSeg) || /buildFailResponse\(\{[^\n]*subject\s*:\s*'matchString'[^\n]*midLine\s*:/.test(delSeg));
}

console.log(pass + ' passed, ' + bad + ' failed');
process.exitCode = bad ? 1 : 0;
