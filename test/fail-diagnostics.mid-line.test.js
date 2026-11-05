'use strict';
// Test for the mid-line failure wording (TODO R1h, 2026-10-17).
// Run from the package root:   node test/fail-diagnostics.mid-line.test.js
// Plain node, no Pulsar, no files written.
//
// R1h: a whole-line replace whose old_str starts or ends mid-line used to print the NOTE (R1e) underneath
// older lines that blame a typo or whitespace ("close but not identical", "exact text comparison failed",
// "Re-read lines around N ... rebuild old_str"). When the caller passes midLine, the diagnosis itself must say
// the text is there and only the whole-line match fails, and buildFailResponse must add the NOTE itself.
//
// What is pinned:
//   1. buildFailResponse({ midLine }) with a scope hint: no similarity/typo line, no "exact text comparison
//      failed", no "Re-read lines around", no PARTIAL MATCH blame; the match location IS still reported; the
//      NOTE is present once and is the last line; since R1i there is no retry nudge after it.
//   2. The same without a scope hint (the "found at ... but exact match failed" variant).
//   3. Without midLine nothing changes: every old line is still there and no NOTE.
//   4. midLine is ignored when the diagnosis already has a better explanation (text outside the scope).
//   5. The pure diagnose(): midLine changes the similarity line and the post lines only.
//   6. mcp-registration.js passes midLine to buildFailResponse.

const fs   = require('fs');
const path = require('path');
const eng  = require('../lib/match-engine');
const { diagnose } = require('../lib/fail-diagnostics');
const { midLineHint } = require('../lib/mid-line-hint');

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
const buf = text.split('\n');
const mk = () => ({ consec: { count: 1 }, allLines: buf, text });
const miss = { matched: false, reason: 'notFound' };

const noScope = { searchStart: 0, searchEnd: buf.length - 1, scopeLabel: '', _hasScope: false, via: 'none', hints: {} };
const inAlpha = { searchStart: 0, searchEnd: 3, scopeLabel: ' within function "alpha"', _hasScope: true, via: 'inFunction', hints: { inFunction: 'alpha' } };

const OLD_LINES = ['close but not identical', 'exact text comparison failed', 'Re-read lines around', 'whitespace/partial match detail'];
const has  = (t, s) => t.includes(s);
const none = (t, list) => list.every(s => !t.includes(s));
const count = (t, s) => t.split(s).length - 1;

function fail(scope, needle, extra) {
  const mid = midLineHint({ needle, text, scopeStart: scope.searchStart, scopeEnd: scope.searchEnd });
  return eng.buildFailResponse(Object.assign({ tool: 'replace', ctx: mk(), match: miss, needle, isCodeFile: true, scope }, extra || {}, mid ? { midLine: mid } : {}));
}

// 1. scoped
const needleMid = 'const total = 1';
let t = fail(inAlpha, needleMid).content[0].text;
ok('1 no "close but not identical" / typo blame', none(t, OLD_LINES.slice(0, 1)), t);
ok('1 no "exact text comparison failed"', !has(t, OLD_LINES[1]), t);
ok('1 no "Re-read lines around"', !has(t, OLD_LINES[2]), t);
ok('1 no "whitespace/partial match detail"', !has(t, OLD_LINES[3]), t);
ok('1 no Similarity percentage line', !/Similarity: \d+%/.test(t), t);
ok('1 match location still reported (L2)', /MATCH LOCATION FOUND inside scope at L2/.test(t), t);
ok('1 says the text is there', /the text is there/.test(t), t);
ok('1 says it starts and ends mid-line', /starts and ends in the middle of a line/.test(t), t);
ok('1 NOTE present exactly once', count(t, 'NOTE: resend the whole call') === 1, 'count=' + count(t, 'NOTE: resend the whole call'));
ok('1 NOTE comes after the diagnosis sentence', t.indexOf('NOTE:') !== -1 && t.indexOf('NOTE:') > t.indexOf('The text itself exists'));
ok('1 R1i: no retry nudge, the NOTE is the last line', !t.includes('Retry cheaply') && t.trimEnd().split('\n').pop().startsWith('NOTE:'));
ok('1 still matched:false', fail(inAlpha, needleMid).matched === false);

// 2. unscoped
t = fail(noScope, needleMid).content[0].text;
ok('2 no "exact match failed (see whitespace" line', !/exact match failed \(see whitespace/.test(t), t);
ok('2 no "Re-read lines around the target"', !has(t, 'Re-read lines around the target'), t);
ok('2 no typo blame', !has(t, OLD_LINES[0]), t);
ok('2 location still reported (found at L2)', /found at L2/.test(t), t);
ok('2 says the text is there', /the text is there/.test(t), t);
ok('2 NOTE present exactly once, no retry nudge', count(t, 'NOTE: resend the whole call') === 1 && !t.includes('Retry cheaply'));

// 3. unchanged without midLine
const plain = eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle: needleMid, isCodeFile: true, scope: inAlpha }).content[0].text;
ok('3 old typo line still there without midLine', has(plain, OLD_LINES[0]), plain);
ok('3 old "exact text comparison failed" still there', has(plain, OLD_LINES[1]), plain);
ok('3 old "Re-read lines around" still there', has(plain, OLD_LINES[2]), plain);
ok('3 no NOTE without midLine', !has(plain, 'NOTE: resend the whole call'), plain);
const plainNo = eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle: needleMid, isCodeFile: true, scope: noScope }).content[0].text;
ok('3 unscoped: old "exact match failed" line still there', /exact match failed \(see whitespace/.test(plainNo), plainNo);
ok('3 midLine:null behaves like absent', eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle: needleMid, isCodeFile: true, scope: inAlpha, midLine: null }).content[0].text === plain);

// PARTIAL MATCH blame: first line whole, second line ends mid-line
const needleHalf = '  const total = 1;\n  return tot';
const halfPlain = eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle: needleHalf, isCodeFile: true, scope: noScope }).content[0].text;
const halfMid   = fail(noScope, needleHalf).content[0].text;
ok('3 control: without midLine this needle shows PARTIAL MATCH', has(halfPlain, 'PARTIAL MATCH'), halfPlain);
ok('1 with midLine the PARTIAL MATCH blame is gone', !has(halfMid, 'PARTIAL MATCH'), halfMid);
ok('1 that needle says it only ends mid-line', /ends in the middle of a line/.test(halfMid) && !/starts in the middle of a line/.test(halfMid), halfMid);

// 4. midLine does not override a better explanation: text exists only outside the scope
const outside = eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle: 'const count = 2', isCodeFile: true, scope: inAlpha, midLine: { startsMid: true, endsMid: true } }).content[0].text;
ok('4 text outside the scope still says FOUND OUTSIDE SCOPE', has(outside, 'FOUND OUTSIDE SCOPE'), outside);
ok('4 and keeps the exists-exactly sentence', has(outside, 'The text itself exists exactly'), outside);
ok('4 and never says "the text is there"', !has(outside, 'the text is there'), outside);

// 5. pure diagnose()
const dscope = { diagStart: 0, diagEnd: null, hasScope: false, scanStart: -1, scanEnd: -1, label: '' };
const dPlain = diagnose({ needle: needleMid, allLines: buf, scope: dscope, hints: {}, hintRadius: 25 });
const dMid   = diagnose({ needle: needleMid, allLines: buf, scope: dscope, hints: {}, hintRadius: 25, midLine: { startsMid: true, endsMid: true } });
ok('5 plain diagnose: typo line present', dPlain.messagesPre.join('').includes(OLD_LINES[0]));
ok('5 midLine diagnose: typo line gone from messagesPre', !dMid.messagesPre.join('').includes(OLD_LINES[0]));
ok('5 midLine diagnose: says the text exists in the file (pre)', /The text itself exists in the file/.test(dMid.messagesPre.join('')));
ok('5 midLine diagnose: post says found at L2', /found at L2/.test(dMid.messagesPost.join('')));
ok('5 midLine diagnose: post has no re-read advice', !/Re-read lines around/.test(dMid.messagesPost.join('')));
ok('5 both runs agree on the reason, scan and stats inputs', dPlain.reason === dMid.reason && dPlain.foundOutsideScope === dMid.foundOutsideScope && dPlain.partialMatchLines === dMid.partialMatchLines && dPlain.similarity === dMid.similarity);

// 6. wiring
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
const at = src.indexOf("matchContentEngine(old_str, { allLines, text: ctx.text }, scope, { fuzzyWhitespace, fuzzyContent, occurrence })");
const seg = at === -1 ? '' : src.slice(at, at + 3600);
ok('6 replace whole-line failure path found', at !== -1);
ok('6 passes midLine to buildFailResponse', /midLine:\s*_midLine/.test(seg), seg.slice(0, 200));
ok('6 no longer builds the advice itself (engine owns the wording)', !/midLineAdvice/.test(seg));

console.log(pass + ' passed, ' + bad + ' failed');
process.exitCode = bad ? 1 : 0;
