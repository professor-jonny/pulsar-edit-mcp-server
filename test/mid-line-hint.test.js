'use strict';
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
process.exitCode = bad ? 1 : 0;
