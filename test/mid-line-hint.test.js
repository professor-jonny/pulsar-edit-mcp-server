'use strict';
// Aggregated summary: the runner reads only the LAST 'N passed, M failed' line, so each block's line is folded into one total printed at the end.
let __p = 0, __f = 0; const __log = console.log.bind(console);
console.log = (...a) => { const m = /(\d+) passed, (\d+) failed/.exec(a.map(String).join(' ')); if (m) { __p += Number(m[1]); __f += Number(m[2]); } else __log(...a); };
// Merged 2026-11-19 from: mid-line-hint.test.js, mid-line-hint.delete-anchors.test.js, mid-line-hint.per-tool.test.js.
// Each former file runs in its own block, so names and pass/fail counters stay separate. Run: node test/mid-line-hint.test.js

// ===== mid-line-hint =====
{
// Test for lib/mid-line-hint.js and its use in match-engine.buildFailResponse (2026-10-17) -- TODO R1e.
// Run from the package root:   node test/mid-line-hint.test.js
// Plain node, no Pulsar, no files written.
//
// R1e: a whole-line replace fails with a generic "not found" when old_str starts or ends in the
// middle of a line. The failure should say to retry with fragment:true.
//
// What is pinned:
//   1. midLineHint: detects a start-mid-line, an end-mid-line and both; returns null for a whole-line
//      needle, a needle that is absent, a needle outside the scope rows, and for fuzzy calls.
//   2. midLineAdvice wording: names fragment:true and the whole-line alternative, says to resend the whole call with new_str, no longer repeats the edge wording (R1i), is ASCII only.
//   3. buildFailResponse({ extraAdvice }) puts the advice BEFORE the retry nudge, and nothing changes
//      without extraAdvice.
//   4. mcp-registration.js: the replace whole-line failure path passes extraAdvice built from midLineHint.

const fs   = require('fs');
const path = require('path');
const { midLineHint, midLineAdvice } = require('../lib/mid-line-hint');
const eng  = require('../lib/match-engine');

let pass = 0, bad = 0;
function ok(label, cond, extra) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && extra !== undefined) console.log('      ' + extra);
}

const text = [
  'function alpha() {',         // row 0
  '  const total = 1;',         // row 1
  '  return total;',            // row 2
  '}',                          // row 3
  '',                           // row 4
  'function beta() {',          // row 5
  '  const count = 2;',         // row 6
  '  return count;',            // row 7
  '}',                          // row 8
].join('\n');

// 1. detection
let h = midLineHint({ needle: 'const total', text });
ok('1 starts and ends mid-line', h && h.startsMid === true && h.endsMid === true, JSON.stringify(h));

h = midLineHint({ needle: '  const total', text });
ok('1 starts at line start, ends mid-line', h && h.startsMid === false && h.endsMid === true, JSON.stringify(h));

h = midLineHint({ needle: 'total = 1;', text });
ok('1 starts mid-line, ends at line end', h && h.startsMid === true && h.endsMid === false, JSON.stringify(h));

h = midLineHint({ needle: 'total;\n}\n\nfunction beta', text });
ok('1 multi-line needle: starts mid-line, ends mid-line', h && h.startsMid === true && h.endsMid === true, JSON.stringify(h));

ok('1 whole-line needle: null', midLineHint({ needle: '  const total = 1;', text }) === null);
ok('1 whole-line multi-line needle: null', midLineHint({ needle: '  const total = 1;\n  return total;', text }) === null);
ok('1 needle ending with a newline counts as line end: null', midLineHint({ needle: '  const total = 1;\n', text }) === null);
ok('1 absent needle: null', midLineHint({ needle: 'zzz_absent', text }) === null);
ok('1 empty needle: null', midLineHint({ needle: '', text }) === null);
ok('1 whitespace-only needle: null', midLineHint({ needle: '   ', text }) === null);
ok('1 fuzzyWhitespace call: null', midLineHint({ needle: 'const total', text, fuzzyWhitespace: true }) === null);
ok('1 fuzzyContent call: null', midLineHint({ needle: 'const total', text, fuzzyContent: true }) === null);

// scope rows (0-based, inclusive): 'const count' is on row 6
ok('1 hit outside the scope rows: null', midLineHint({ needle: 'const count', text, scopeStart: 0, scopeEnd: 3 }) === null);
h = midLineHint({ needle: 'const count', text, scopeStart: 5, scopeEnd: 8 });
ok('1 hit inside the scope rows: found', h && h.startsMid === true, JSON.stringify(h));

// CRLF buffer text is treated like LF
const crlf = text.split('\n').join('\r\n');
h = midLineHint({ needle: 'const total', text: crlf });
ok('1 CRLF text: found', h && h.startsMid === true && h.endsMid === true, JSON.stringify(h));
ok('1 CRLF text, whole-line needle: null', midLineHint({ needle: '  const total = 1;', text: crlf }) === null);

// 2. wording
const adv = midLineAdvice();
ok('2 names fragment:true', adv.includes('fragment:true'), adv);
ok('2 R1i: no longer repeats the edge wording (the diagnosis names the edges)', !/middle of a line/.test(adv) && !/matches complete lines/.test(adv), adv);
ok('2 mentions the whole-line alternative', /whole line/i.test(adv), adv);
ok('2 says to resend the whole call, new_str included', /whole call/i.test(adv) && adv.includes('new_str'), adv);
ok('2 ASCII only', !/[^\x00-\x7F]/.test(adv));

// 3. buildFailResponse ordering
const buf = text.split('\n');
const mk = () => ({ consec: { count: 1 }, allLines: buf, text });
const miss = { matched: false, reason: 'notFound' };
const scope = { searchStart: 0, searchEnd: buf.length - 1, scopeLabel: '', _hasScope: false, via: 'none', hints: {} };
const advice = 'MIDLINE_ADVICE_MARKER';
const withAdv = eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle: 'const total', isCodeFile: true, scope, extraAdvice: [advice] });
const without = eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle: 'const total', isCodeFile: true, scope });
const tw = withAdv.content[0].text, ta = without.content[0].text;
ok('3 advice is present', tw.includes(advice));
ok('3 advice comes before the retry nudge', tw.indexOf(advice) !== -1 && tw.indexOf(advice) < tw.indexOf('Retry cheaply'), 'adviceAt=' + tw.indexOf(advice) + ' nudgeAt=' + tw.indexOf('Retry cheaply'));
ok('3 nudge is still last', tw.trimEnd().endsWith('no need to resend the rest of the call.'));
ok('3 without extraAdvice nothing changes', !ta.includes(advice) && ta.includes('Retry cheaply'));
ok('3 result still carries matched:false', withAdv.matched === false);
ok('3 extraAdvice empty array: same text as without', eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle: 'const total', isCodeFile: true, scope, extraAdvice: [] }).content[0].text === ta);

// 4. wiring in the replace whole-line failure path
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
const at = src.indexOf("matchContentEngine(old_str, { allLines, text: ctx.text }, scope, { fuzzyWhitespace, fuzzyContent, occurrence })");
const seg = at === -1 ? '' : src.slice(at, at + 3600);
ok('4 replace whole-line path found in the source', at !== -1);
ok('4 requires lib/mid-line-hint', /require\(['"]\.\/mid-line-hint['"]\)/.test(src));
ok('4 whole-line failure calls midLineHint', /midLineHint\(/.test(seg));
ok('4 passes midLine (R1h) to buildFailResponse', /midLine:\s*_midLine/.test(seg));
ok('4 skips the hint for an ambiguous match', /ambiguous/.test(seg.slice(0, seg.indexOf('midLine:') + 200)));

console.log(pass + ' passed, ' + bad + ' failed');
if (bad) process.exitCode = 1;
}

// ===== mid-line-hint.delete-anchors =====
{
// Regression test (2026-10-18) -- TODO R1j part 2: mid-line failure wording for delete Mode 4 anchors
// (startContent / endContent).
// Run from the package root:   node test/mid-line-hint.delete-anchors.test.js
// Plain node, no Pulsar, no files written. Drives match-engine.diagnoseFailure (what Mode 4 calls directly) and
// scans lib/mcp-registration.js for the wiring.
//
// The problem: delete Mode 4 (startContent + endContent) matches WHOLE LINES like every other content anchor, but when
// an anchor starts or ends mid-line its failure still blamed a typo or whitespace ("Similarity ... rebuild"). Mode 4
// already passes its own subject ('startContent' / 'endContent') to diagnoseFailure, so the parameter name is right;
// what is missing is the mid-line hint, the sentence, and a NOTE of its own (a range delete has no part-line mode).
//
// What is pinned:
//   1. lib/mid-line-hint.js: midLineWhat('deleteAnchor', S) and midLineAdvice('deleteAnchor', S) (kind 'deleteAnchor'),
//      and midLineKind('delete') is still 'deleteMatch' (the anchors pick their kind explicitly).
//   2. diagnoseFailure with midLine + midLineWhatText: the pre messages carry "<S> starts and ends in the middle of a
//      line, and delete <S> only matches complete lines.", no typo/similarity wording; without midLine nothing changes.
//   3. Wiring: both Mode 4 not-found paths compute midLineHint against their own scope, pass midLine and
//      midLineWhatText to diagnoseFailure, and append the NOTE after the post messages (so it is the last line).

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
const scope = { searchStart: 0, searchEnd: buf.length - 1, scopeLabel: '', _hasScope: false, via: 'none', hints: {} };
const needle = 'const total = 1';
const hint = mlh.midLineHint({ needle, text, scopeStart: 0, scopeEnd: buf.length - 1, regex: false, fuzzyWhitespace: false, fuzzyContent: false });
ok('0 setup: the needle is detected as mid-line', !!hint && hint.startsMid && hint.endsMid, JSON.stringify(hint));

// 1. helpers ---------------------------------------------------------------------------------------------------
ok("1 midLineKind('delete') is still deleteMatch", SAFE(() => mlh.midLineKind('delete')) === 'deleteMatch');
ok('1 midLineWhat: deleteAnchor uses the subject', SAFE(() => mlh.midLineWhat('deleteAnchor', 'endContent')) === 'delete endContent', String(SAFE(() => mlh.midLineWhat('deleteAnchor', 'endContent'))));
ok('1 midLineWhat: deleteAnchor default subject is startContent', SAFE(() => mlh.midLineWhat('deleteAnchor')) === 'delete startContent');
const advS = SAFE(() => mlh.midLineAdvice('deleteAnchor', 'startContent'));
ok('1 start NOTE: starts with NOTE: and names startContent', typeof advS === 'string' && advS.startsWith('NOTE:') && has(advS, 'startContent'), advS);
ok('1 start NOTE: says to extend the anchor to the whole line', /extend/i.test(advS) && /whole line/i.test(advS), advS);
ok("1 start NOTE: mentions that a range delete has no part-line mode and points at replace fragment:true with new_str:''", /no part-line mode/i.test(advS) && has(advS, 'replace') && has(advS, 'fragment:true') && has(advS, "new_str:''"), advS);
ok('1 start NOTE: no old_str, no matchString, no endContent, ASCII only', !has(advS, 'old_str') && !has(advS, 'matchString') && !has(advS, 'endContent') && ascii(advS), advS);
const advE = SAFE(() => mlh.midLineAdvice('deleteAnchor', 'endContent'));
ok('1 end NOTE: names endContent, not startContent', has(advE, 'endContent') && !has(advE, 'startContent') && advE.startsWith('NOTE:') && ascii(advE), advE);
ok('1 the other kinds are unchanged', SAFE(() => mlh.midLineAdvice()) === SAFE(() => mlh.midLineAdvice('replace')) && has(SAFE(() => mlh.midLineAdvice('deleteMatch', 'matchString')), 'matchString only matches whole lines'));

// 2. diagnoseFailure (what Mode 4 calls) -----------------------------------------------------------------------------
const diag = (subject, extra) => SAFE(() => eng.diagnoseFailure(Object.assign({ tool: 'delete', ctx: mk(), scope, needle, subject, fuzzyAdvice: true }, extra)));
const joined = (d) => (d && Array.isArray(d.pre) ? d.pre.concat(d.post || []).join('\n') : String(d));

let d = diag('startContent', { midLine: hint, midLineWhatText: 'delete startContent' });
let t = joined(d);
ok('2 start: the sentence names startContent and says delete startContent only matches complete lines',
  has(t, 'startContent starts and ends in the middle of a line, and delete startContent only matches complete lines.'), t);
ok('2 start: no typo / similarity wording and no a-whole-line-replace', !has(t, 'Similarity') && !has(t, 'a whole-line replace'), t);
ok('2 start: no old_str', !has(t, 'old_str'), t);

d = diag('endContent', { midLine: hint, midLineWhatText: 'delete endContent', scope: Object.assign({}, scope, { scopeLabel: ' after startContent (line 1)' }) });
t = joined(d);
ok('2 end: the sentence names endContent', has(t, 'endContent starts and ends in the middle of a line, and delete endContent only matches complete lines.'), t);

const dControl = joined(diag('startContent', {}));
ok('2 control: without midLine there is no mid-line sentence', !has(dControl, 'only matches complete lines') && !has(dControl, 'starts and ends in the middle'), dControl);
ok('2 control: without midLine the old similarity wording is still there', has(dControl, 'Similarity'), dControl);

// 3. wiring ------------------------------------------------------------------------------------------------------
const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
function seg(startMarker, endMarker) {
  const s = reg.indexOf(startMarker);
  if (s === -1) return null;
  const e = reg.indexOf(endMarker, s);
  return e === -1 ? null : reg.slice(s, e + endMarker.length);
}
ok('3 import: midLineAdvice and midLineWhat come from mid-line-hint', /const\s*\{[^}]*\bmidLineAdvice\b[^}]*\}\s*=\s*require\('\.\/mid-line-hint'\)/.test(reg) && /const\s*\{[^}]*\bmidLineWhat\b[^}]*\}\s*=\s*require\('\.\/mid-line-hint'\)/.test(reg));

const startSeg = seg('const _sd = diagnoseFailure(', 'deleted: false, consecFailures: ctx.consec.count };');
const endSeg = seg('const _ed = diagnoseFailure(', 'deleted: false, consecFailures: ctx.consec.count };');
ok('3 wiring: found the startContent not-found path', startSeg !== null);
ok('3 wiring: found the endContent not-found path', endSeg !== null);
// the midLine computation sits just BEFORE the diagnoseFailure call, so look at the text leading up to it too
const upTo = (marker, n) => { const i = reg.indexOf(marker); return i === -1 ? '' : reg.slice(Math.max(0, i - n), i); };
const startPre = upTo('const _sd = diagnoseFailure(', 1500);
const endPre = upTo('const _ed = diagnoseFailure(', 1500);
if (startSeg) {
  ok('3 start: computes midLineHint on startContent with the _startScope bounds', /_startMid\s*=[\s\S]*?midLineHint\(\s*\{[^}]*needle:\s*startContent/.test(startPre) && /scopeStart:\s*_startScope\s*&&\s*_startScope\.searchStart/.test(startPre) && /scopeEnd:\s*_startScope\s*&&\s*_startScope\.searchEnd/.test(startPre));
  ok('3 start: passes midLine and midLineWhatText (deleteAnchor) to diagnoseFailure', /diagnoseFailure\(\{[^\n]*midLine\s*:\s*_startMid[^\n]*midLineWhatText\s*:[^\n]*midLineWhat\(\s*'deleteAnchor'\s*,\s*'startContent'\s*\)/.test(startSeg));
  ok('3 start: appends the NOTE after the post messages', /\.\.\._sd\.post[\s\S]*midLineAdvice\(\s*'deleteAnchor'\s*,\s*'startContent'\s*\)/.test(startSeg));
}
if (endSeg) {
  ok('3 end: computes midLineHint on endContent with the _endScope bounds', /_endMid\s*=[\s\S]*?midLineHint\(\s*\{[^}]*needle:\s*endContent/.test(endPre) && /scopeStart:\s*_endScope\s*&&\s*_endScope\.searchStart/.test(endPre) && /scopeEnd:\s*_endScope\s*&&\s*_endScope\.searchEnd/.test(endPre));
  ok('3 end: passes midLine and midLineWhatText (deleteAnchor) to diagnoseFailure', /diagnoseFailure\(\{[^\n]*midLine\s*:\s*_endMid[^\n]*midLineWhatText\s*:[^\n]*midLineWhat\(\s*'deleteAnchor'\s*,\s*'endContent'\s*\)/.test(endSeg));
  ok('3 end: appends the NOTE after the post messages', /\.\.\._ed\.post[\s\S]*midLineAdvice\(\s*'deleteAnchor'\s*,\s*'endContent'\s*\)/.test(endSeg));
}

console.log(pass + ' passed, ' + bad + ' failed');
if (bad) process.exitCode = 1;
}

// ===== mid-line-hint.per-tool =====
{
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
//      and the right alternative (delete: fragment:true on delete itself (step B, 2026-11-13) or whole lines; insert: afterString /
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
ok('1 delete NOTE: offers fragment:true on delete itself (step B), no replace, no new_str', has(advDel, 'fragment:true') && !has(advDel, 'replace') && !has(advDel, 'new_str'), advDel);
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
ok('2 delete: NOTE offers fragment:true on delete itself, no replace, no new_str', has(t, 'NOTE:') && has(t, 'fragment:true') && !has(t, 'new_str') && !has(t, 'use replace'), t);
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
if (bad) process.exitCode = 1;
}

console.log = __log; console.log(__p + ' passed, ' + __f + ' failed');
