'use strict';
// Aggregated summary: the runner reads only the LAST 'N passed, M failed' line, so each block's line is folded into one total printed at the end.
let __p = 0, __f = 0; const __log = console.log.bind(console);
console.log = (...a) => { const m = /(\d+) passed, (\d+) failed/.exec(a.map(String).join(' ')); if (m) { __p += Number(m[1]); __f += Number(m[2]); } else __log(...a); };
// Merged 2026-11-19 from: match-engine.match-content-comment.test.js, match-engine.match-content-scope.test.js, match-engine.matchblock-fuzzycontent.test.js, match-engine.line-range-hint.test.js.
// Each former file runs in its own block, so names and pass/fail counters stay separate. Run: node test/match-engine.match-content.test.js

// ===== match-engine.match-content-comment =====
{
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
if (fail) process.exitCode = 1;
}

// ===== match-engine.match-content-scope =====
{
// test/match-engine.match-content-scope.test.js (2026-10-11)
// Pins lib/match-engine.js after Step 2b of the comment fail reason: matchContent has NO stage 2 any more.
// recover.partialMatchRescue used to search the WHOLE buffer and commit text found OUTSIDE the resolved
// scope (even an exact needle that lived only outside the caller's scope). Such needles are now a plain
// noMatch, and diagnoseFailure() explains them.
// Written probe-first (TEMP\probe_stage2.js and TEMP\probe_diag2.js printed the real outputs, before and after
// the change, before any assertion was written).
// Run: node test/match-engine.match-content-scope.test.js   (ME_PATH env points it at another copy of match-engine.js that
// lives next to the other lib files, used by the mutation harness). Last line is '<N> passed, <M> failed'.
const path = require('path');
const eng = require(process.env.ME_PATH || path.join(__dirname, '..', 'lib', 'match-engine.js'));
const { matchContent, diagnoseFailure } = eng;

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}
function ok(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log('FAIL ' + name + (detail === undefined ? '' : '\n  ' + JSON.stringify(detail))); }
}
function block(name, fn) {
  try { fn(); } catch (e) { fail++; console.log('FAIL ' + name + ' threw: ' + (e && e.message)); }
}

const BUF = ['function f() {', '  const a = 1; // set a', '  const b = 2;', '  return a + b;', '}',
  'function g() {', '  return 0;', '}'];
function scope(start, end, hasScope) {
  return { searchStart: start, searchEnd: end, scopeLabel: hasScope ? 'within function g (lines 6-8)' : '',
    _hasScope: !!hasScope, via: hasScope ? 'inFunction' : 'none', hints: hasScope ? { inFunction: 'g' } : {} };
}
function match(needle, sc, opts) {
  const r = matchContent(needle, { allLines: BUF, text: BUF.join('\n') }, sc, opts || {});
  return r.matched
    ? { matched: true, transforms: r.transforms, matchLine: r.matchLine, matchEndLine: r.matchEndLine }
    : { matched: false, reason: r.reason, transforms: r.transforms };
}
const NO_MATCH = { matched: false, reason: 'noMatch', transforms: [] };
const T3 = '  const a = 1; // set a\n  const b = 2;\n    return a + b;'; // first two lines exact, 3rd line extra indent

// ---- M: matchContent ------------------------------------------------------------------------------
block('M', () => {
  eq('M1 whole-file scope: stage 1 still rescues whitespace drift in scope', match(T3, scope(0, 7, false)),
    { matched: true, transforms: ['fuzzyWhitespace'], matchLine: 1, matchEndLine: 3 });
  eq('M2 target INSIDE the narrowed scope: still rescued', match(T3, scope(0, 4, true)),
    { matched: true, transforms: ['fuzzyWhitespace'], matchLine: 1, matchEndLine: 3 });
  eq('M3 target only OUTSIDE the scope: no longer committed outside it', match(T3, scope(5, 7, true)), NO_MATCH);
  eq('M4 an EXACT needle that exists only outside the scope is no longer committed there either',
    match('  const a = 1; // set a\n  const b = 2;', scope(5, 7, true)), NO_MATCH);
  eq('M5 2-line needle, 2nd line whitespace-different, outside scope (never rescued)',
    match('  const a = 1; // set a\n    const b = 2;', scope(5, 7, true)), NO_MATCH);
  eq('M6 3rd line really different, outside scope (never rescued)',
    match('  const a = 1; // set a\n  const b = 2;\n  return a - b;', scope(5, 7, true)), NO_MATCH);
  eq('M7 autoRescue:false in scope fails', match(T3, scope(0, 4, true), { autoRescue: false }), NO_MATCH);
  eq('M8 autoRescue:false outside scope fails', match(T3, scope(5, 7, true), { autoRescue: false }), NO_MATCH);
  eq('M9 an exact needle located AFTER the scope end is not found',
    match('  return 0;', scope(0, 4, true)), NO_MATCH);
  eq('M10 a whitespace-different needle located AFTER the scope end is not found',
    match('    return 0;', scope(0, 4, true)), NO_MATCH);
});

// ---- D: what the caller is told -------------------------------------------------------------------
block('D', () => {
  const diag = (needle) => diagnoseFailure({ tool: 'replace', ctx: { allLines: BUF, text: BUF.join('\n') },
    scope: scope(5, 7, true), needle, subject: 'old_str', fuzzyAdvice: '' });
  const exact = diag('  const a = 1; // set a\n  const b = 2;');
  eq('D1 exact needle outside scope: reason key', exact.statKey, 'noMatch');
  eq('D2 ... foundOutsideScope flag', exact.diag.foundOutsideScope, true);
  eq('D3 ... exactOutsideScope flag', exact.diag.exactOutsideScope, true);
  const postE = exact.post.join('\n');
  ok('D4 ... says FOUND OUTSIDE SCOPE', postE.indexOf('FOUND OUTSIDE SCOPE') >= 0, postE);
  ok('D5 ... names the hit line', postE.indexOf('Hit(s) outside scope: L2 (inside f())') >= 0, postE);
  const ws = diag(T3);
  eq('D6 whitespace-different outside scope: foundOutsideScope stays false (it means EXACT text only)',
    ws.diag.foundOutsideScope, false);
  eq('D6b ... but elsewhere is reported: lines 2-4, outside the scope',
    ws.diag.elsewhere && [ws.diag.elsewhere.startLine, ws.diag.elsewhere.endLine, ws.diag.elsewhere.outsideScope], [2, 4, true]);
  const postW = ws.post.join('\n');
  ok('D7 says FOUND ELSEWHERE', postW.indexOf('FOUND ELSEWHERE') >= 0, postW);
  ok('D7b no longer claims NOT FOUND ANYWHERE', postW.indexOf('NOT FOUND ANYWHERE') < 0, postW);
  ok('D7c gives the location and the scope fix',
    postW.indexOf('at lines 2-4, outside the search scope.') >= 0
    && postW.indexOf('Fix: drop the scope hint, or move it so it covers lines 2-4.') >= 0, postW);
  ok('D7d names the differing line',
    postW.indexOf('old_str line 3 reads') >= 0 && postW.indexOf('buffer line 4 reads') >= 0, postW);
  const preW = ws.pre.join('\n');
  ok('D8 the misleading "Low match, wrong location" similarity line is replaced',
    preW.indexOf('FOUND ELSEWHERE below') >= 0 && preW.indexOf('Similarity:') < 0, preW);
});

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
}

// ===== match-engine.matchblock-fuzzycontent =====
{
// XW23 uniform hints (2026-11-18): matchBlock (the replace-block engine) honours fuzzyContent like matchContent does.
// Pure-function test: no Pulsar, no buffer, no files touched.   Run: node test/match-engine.matchblock-fuzzycontent.test.js
//   1. Default stays strict: a straight-quote anchor does not match a curly-quote line.
//   2. fuzzyContent:true matches through curly quotes, en dashes and zero-width characters (the normUnicode rules).
//   3. Safety is unchanged: two lines that match once normalised are still AMBIGUOUS without occurrence; occurrence picks.
//   4. fuzzyContent composes with fuzzyWhitespace; an ordinary exact match is unaffected by the flag.
const assert = require('assert');
const { matchBlock } = require('../lib/match-engine');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}
const scopeAll = (lines) => ({ searchStart: 0, searchEnd: lines.length - 1 });

const Q = ['if (s == “hello”) {', '  x();', '}'];
t('1 default: straight-quote anchor does not match a curly-quote line', () => {
  const r = matchBlock('if (s == "hello")', { allLines: Q }, scopeAll(Q), {});
  assert.strictEqual(r.matched, false);
  assert.strictEqual(r.reason, 'noMatch');
});
t('2 fuzzyContent: curly quotes match straight quotes, block found', () => {
  const r = matchBlock('if (s == "hello")', { allLines: Q }, scopeAll(Q), { fuzzyContent: true });
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.matchLine, 0);
  assert.strictEqual(r.matchEndLine, 2);
  assert.strictEqual(r.braceStartRow, 0);
});
const D = ['function f() { // a – b', '}'];
t('2 default: hyphen anchor does not match an en-dash line', () => {
  const r = matchBlock('// a - b', { allLines: D }, scopeAll(D), {});
  assert.strictEqual(r.matched, false);
});
t('2 fuzzyContent: hyphen anchor matches an en-dash line', () => {
  const r = matchBlock('// a - b', { allLines: D }, scopeAll(D), { fuzzyContent: true });
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.matchEndLine, 1);
});
const Z = ['foo​bar() {', '}'];
t('2 fuzzyContent: zero-width characters are ignored', () => {
  const r = matchBlock('foobar()', { allLines: Z }, scopeAll(Z), { fuzzyContent: true });
  assert.strictEqual(r.matched, true);
});

const A2 = ['if (s == “hello”) {', '}', 'if (s == "hello") {', '}'];
t('3 ambiguity is still refused with fuzzyContent and no occurrence', () => {
  const r = matchBlock('if (s == "hello")', { allLines: A2 }, scopeAll(A2), { fuzzyContent: true });
  assert.strictEqual(r.matched, false);
  assert.strictEqual(r.reason, 'ambiguous');
  assert.deepStrictEqual(r.matchLines, [1, 3]);
});
t('3 occurrence:2 picks the second normalised hit', () => {
  const r = matchBlock('if (s == "hello")', { allLines: A2 }, scopeAll(A2), { fuzzyContent: true, occurrence: 2 });
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.matchLine, 2);
});
t('3 occurrence past the end is still refused, not clamped', () => {
  const r = matchBlock('if (s == "hello")', { allLines: A2 }, scopeAll(A2), { fuzzyContent: true, occurrence: 5 });
  assert.strictEqual(r.matched, false);
  assert.strictEqual(r.reason, 'occurrenceOutOfRange');
});

const W = ['    if (s == “hello”) {  ', '    }'];
t('4 fuzzyContent composes with fuzzyWhitespace', () => {
  const r = matchBlock('  if (s == "hello")  ', { allLines: W }, scopeAll(W), { fuzzyContent: true, fuzzyWhitespace: true });
  assert.strictEqual(r.matched, true);
});
t('4 fuzzyWhitespace alone still does not bridge curly quotes', () => {
  const r = matchBlock('  if (s == "hello")  ', { allLines: W }, scopeAll(W), { fuzzyWhitespace: true });
  assert.strictEqual(r.matched, false);
});
const P = ['if (ok) {', '}'];
t('4 an exact match is unaffected by the flag', () => {
  const a = matchBlock('if (ok)', { allLines: P }, scopeAll(P), {});
  const b = matchBlock('if (ok)', { allLines: P }, scopeAll(P), { fuzzyContent: true });
  assert.strictEqual(a.matched, true);
  assert.strictEqual(b.matched, true);
  assert.strictEqual(a.matchLine, b.matchLine);
  assert.strictEqual(a.matchEndLine, b.matchEndLine);
});

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
}

// ===== match-engine.line-range-hint =====
{
// Unit test (2026-11-12) -- TODO R3a / H13, delete step A1: startLine / endLine become a scope hint in resolveScope().
// Run from the package root:   node test/match-engine.line-range-hint.test.js
// Pure-function test: no Pulsar, no buffer, no files touched.
//
// PJ's direction: startLine/endLine are the MATCH given by position (as matchString is the match by content), so they
// belong in the shared hint system next to afterLine/beforeLine, not in a delete-only "Mode 6". This step only adds the
// hint to the engine; no tool handler passes it yet, so no tool behaviour changes.
//
// The hint resolves to an exact 1-based inclusive row range:
//   searchStart = startLine-1, searchEnd = endLine-1, anchorRow = startLine-1, endAnchorRow = endLine-1,
//   via 'startLine', positional:true, occurrence NOT consumed (a content match inside the range may still use it).
// Failures come back as { error: { kind:'anchorError', reason, hintName, hintValue, message } } with the message
// pre-formatted (wording carried over verbatim from delete's former Mode 6) so a caller can surface it as it is:
//   reason 'missingEnd' (only one of the two given), 'notOneBased' (< 1), 'inverted' (start > end),
//   'outOfRange' (endLine past the last line).
// Named hints keep priority (first match wins, same as every other hint): afterString + startLine resolves afterString.
// The exact range is checked BEFORE afterLine/beforeLine (a radius window), so startLine/endLine win over those two.

const assert = require('assert');
const { resolveScope, matchContent, buildFailResponse } = require('../lib/match-engine');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

const buf = [];
for (let i = 1; i <= 30; i++) buf.push('const v' + i + ' = ' + i + ';');
const text = buf.join('\n');
const scopeRaw = (params) => resolveScope({ editor: null, buffer: null, allLines: buf, text, filePath: 'x.js', params });
function scopeOk(params) {
  const s = scopeRaw(params);
  assert.ok(!s.error, 'scope error: ' + JSON.stringify(s.error));
  return s;
}

// -- the range resolves ------------------------------------------------------------------------------
t('startLine 5 / endLine 8 resolves to rows 4..7', () => {
  const s = scopeOk({ startLine: 5, endLine: 8 });
  assert.strictEqual(s.searchStart, 4);
  assert.strictEqual(s.searchEnd, 7);
  assert.strictEqual(s.anchorRow, 4);
  assert.strictEqual(s.endAnchorRow, 7);
});
t('the scope is flagged as a positional scoped hint via startLine', () => {
  const s = scopeOk({ startLine: 5, endLine: 8 });
  assert.strictEqual(s.via, 'startLine');
  assert.strictEqual(s.positional, true);
  assert.strictEqual(s._hasScope, true);
});
t('the scope label names the lines', () => {
  const s = scopeOk({ startLine: 5, endLine: 8 });
  assert.ok(/lines 5.8/.test(s.scopeLabel), s.scopeLabel);
});
t('a single-line range (start == end) is valid', () => {
  const s = scopeOk({ startLine: 12, endLine: 12 });
  assert.strictEqual(s.searchStart, 11);
  assert.strictEqual(s.searchEnd, 11);
});
t('the first and the last line of the file are valid bounds', () => {
  const s = scopeOk({ startLine: 1, endLine: 30 });
  assert.strictEqual(s.searchStart, 0);
  assert.strictEqual(s.searchEnd, 29);
});
t('scope.hints carries startLine and endLine for the diagnosis and the fault log', () => {
  const s = scopeOk({ startLine: 5, endLine: 8 });
  assert.strictEqual(s.hints.startLine, 5);
  assert.strictEqual(s.hints.endLine, 8);
});
t('occurrence is NOT consumed by the range (a content match inside it may still use it)', () => {
  const s = scopeOk({ startLine: 5, endLine: 8, occurrence: 1 });
  assert.ok(!s.occurrenceConsumed, JSON.stringify(s));
});

// -- the range scopes a content match ----------------------------------------------------------------
t('a content match inside the range is found', () => {
  const s = scopeOk({ startLine: 5, endLine: 8 });
  const m = matchContent('const v6 = 6;', { allLines: buf, text }, s, {});
  assert.strictEqual(m.matched, true, JSON.stringify(m));
  assert.strictEqual(m.matchLine, 5);
});
t('a content match outside the range is NOT found', () => {
  const s = scopeOk({ startLine: 5, endLine: 8 });
  const m = matchContent('const v12 = 12;', { allLines: buf, text }, s, { autoRescue: false });
  assert.strictEqual(m.matched, false, JSON.stringify(m));
});

// -- failures ----------------------------------------------------------------------------------------
t('startLine 0 is refused as not 1-based, with the old Mode 6 wording', () => {
  const s = scopeRaw({ startLine: 0, endLine: 3 });
  assert.ok(s.error, 'expected an error');
  assert.strictEqual(s.error.kind, 'anchorError');
  assert.strictEqual(s.error.reason, 'notOneBased');
  assert.ok(s.error.message.includes('Line numbers must be 1-based (got startLine=0, endLine=3).'), s.error.message);
  assert.ok(s.error.message.includes('File has 30 lines.'), s.error.message);
});
t('endLine 0 is refused as not 1-based', () => {
  const s = scopeRaw({ startLine: 3, endLine: 0 });
  assert.ok(s.error && s.error.reason === 'notOneBased', JSON.stringify(s.error));
});
t('startLine > endLine is refused as inverted, and suggests the swap', () => {
  const s = scopeRaw({ startLine: 8, endLine: 5 });
  assert.ok(s.error, 'expected an error');
  assert.strictEqual(s.error.reason, 'inverted');
  assert.ok(s.error.message.includes('startLine (8) must be <= endLine (5).'), s.error.message);
  assert.ok(s.error.message.includes('Did you mean startLine=5, endLine=8?'), s.error.message);
});
t('endLine past the end of the file is refused as out of range, with the last lines shown', () => {
  const s = scopeRaw({ startLine: 28, endLine: 31 });
  assert.ok(s.error, 'expected an error');
  assert.strictEqual(s.error.reason, 'outOfRange');
  assert.ok(s.error.message.includes('endLine 31 exceeds file length 30.'), s.error.message);
  assert.ok(s.error.message.includes('End of file (lines 26'), s.error.message);
  assert.ok(s.error.message.includes('const v30 = 30;'), s.error.message);
});
t('the failure carries hintName and hintValue so a caller can log it', () => {
  const s = scopeRaw({ startLine: 8, endLine: 5 });
  assert.strictEqual(s.error.hintName, 'startLine');
  assert.strictEqual(s.error.hintValue, '8-5');
});
t('only startLine given: refused as missingEnd', () => {
  const s = scopeRaw({ startLine: 5 });
  assert.ok(s.error && s.error.reason === 'missingEnd', JSON.stringify(s.error));
  assert.ok(s.error.message.includes('startLine and endLine must be given together'), s.error.message);
});
t('only endLine given: refused as missingEnd', () => {
  const s = scopeRaw({ endLine: 5 });
  assert.ok(s.error && s.error.reason === 'missingEnd', JSON.stringify(s.error));
});

// -- the failure diagnosis names the hint -------------------------------------------------------------
t('a failed content match inside the range names the startLine hint in the diagnosis', () => {
  const s = scopeOk({ startLine: 5, endLine: 8 });
  const r = buildFailResponse({ tool: 'delete', ctx: { consec: { count: 1 }, allLines: buf, text },
    scope: s, match: { matched: false, reason: 'notFound' }, needle: 'zzz_absent();', isCodeFile: true });
  const txt = r.content[0].text;
  assert.ok(txt.includes('startLine:5'), txt);
});

// -- nothing else changes -----------------------------------------------------------------------------
t('afterLine still resolves as before', () => {
  const s = scopeOk({ afterLine: 10 });
  assert.strictEqual(s.via, 'afterLine');
  assert.strictEqual(s.positional, true);
});
t('no hint at all: the whole file, via none', () => {
  const s = scopeOk({});
  assert.strictEqual(s.via, 'none');
  assert.strictEqual(s.searchStart, 0);
  assert.strictEqual(s.searchEnd, 29);
});
t('a named hint keeps priority over startLine/endLine (afterString wins)', () => {
  const s = scopeOk({ afterString: 'const v2 = 2;', startLine: 20, endLine: 22 });
  assert.strictEqual(s.via, 'afterString');
});
t('startLine/endLine win over afterLine/beforeLine (an exact range is more specific than a radius window)', () => {
  const s = scopeOk({ afterLine: 10, startLine: 20, endLine: 22 });
  assert.strictEqual(s.via, 'startLine');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
}

console.log = __log; console.log(__p + ' passed, ' + __f + ' failed');
