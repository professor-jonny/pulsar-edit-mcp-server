'use strict';
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
process.exitCode = bad ? 1 : 0;
