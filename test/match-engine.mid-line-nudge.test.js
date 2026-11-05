'use strict';
// Regression test (2026-10-17) -- TODO R1i: mid-line failure wording and retry nudge.
// Run from the package root:   node test/match-engine.mid-line-nudge.test.js
// Plain node, no Pulsar, no files written. Drives match-engine.buildFailResponse directly.
//
// The problem (seen live 2026-10-17): a whole-line replace whose old_str starts/ends mid-line said the
// same thing twice (the diagnosis sentence and the NOTE), then ended with "Retry cheaply: ... call
// replace again with just { filePath, old_str: '<corrected value>' }". That nudge is wrong here (the
// text is not wrong) and dangerous: a bare resend merges the stashed partial new_str, so extending
// old_str to the whole line would replace the whole line with the partial new_str.
//
// What is pinned:
//   1. A mid-line failure keeps the explanatory sentence ONCE, keeps a NOTE that names fragment:true
//      and whole lines, says to resend the whole call with new_str, and has no retry nudge.
//   2. The result still carries matched:false and now also retryStash:false (the framework then does
//      not stash it and clears any older stash, see test/tool-framework.retry-stash.test.js).
//   3. Every other failure keeps the nudge and has no retryStash key.
//   4. A tool-independent check: delete and replace-block behave the same when given a midLine.

const eng = require('../lib/match-engine');
const { midLineHint } = require('../lib/mid-line-hint');

const buf = [
  'function alpha() {',   // L1
  '  const total = 1;',   // L2
  '  return total;',      // L3
  '}',                    // L4
];
const text = buf.join('\n');
const mk   = () => ({ consec: { count: 1 }, allLines: buf, text });
const miss = { matched: false, reason: 'notFound' };
const scope = { searchStart: 0, searchEnd: buf.length - 1, scopeLabel: '', _hasScope: false, via: 'none', hints: {} };
const NUDGE = 'Retry cheaply';
const SENTENCE = 'a whole-line replace only matches complete lines';

const needle = 'const total = 1';
const hint = midLineHint({ needle, text, scopeStart: 0, scopeEnd: buf.length - 1, regex: false, fuzzyWhitespace: false, fuzzyContent: false });

let bad = 0, pass = 0;
function ok(label, cond, detail) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && detail !== undefined) console.log('      ' + detail);
}
const count = (s, sub) => s.split(sub).length - 1;

ok('0 setup: the needle is detected as mid-line', !!hint && hint.startsMid && hint.endsMid, JSON.stringify(hint));

// 1 + 2. replace with a mid-line hint
let r = eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle, isCodeFile: true, scope, midLine: hint });
let t = r.content[0].text;
ok('1 the explanatory sentence appears exactly once', count(t, SENTENCE) === 1, 'count=' + count(t, SENTENCE) + '\n' + t);
ok('1 the diagnosis still names the mid-line edges', /starts and ends in the middle of a line/.test(t), t);
ok('1 a NOTE with the action is present', /NOTE:/.test(t) && t.includes('fragment:true') && /whole line/i.test(t), t);
ok('1 the NOTE says to resend the whole call, new_str included', /whole call/i.test(t) && t.includes('new_str'), t);
ok('1 no retry nudge', !t.includes(NUDGE), t);
ok('1 the NOTE is the last line (nothing after it)', t.trim().split('\n').pop().startsWith('NOTE:'), t.trim().split('\n').pop());
ok('2 matched:false is kept', r.matched === false);
ok('2 retryStash:false is set', r.retryStash === false, JSON.stringify(Object.keys(r)));
// 3. everything else keeps the nudge and has no retryStash
r = eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle: 'zzz_absent();', isCodeFile: true, scope });
t = r.content[0].text;
ok('3 not found: nudge kept', t.includes(NUDGE), t);
ok('3 not found: no retryStash key', !('retryStash' in r), JSON.stringify(Object.keys(r)));
r = eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle: '    const total = 1;', isCodeFile: true, scope });
ok('3 near miss (indentation): nudge kept', r.content[0].text.includes(NUDGE));
ok('3 near miss: no retryStash key', !('retryStash' in r));
r = eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle, isCodeFile: true, scope, midLine: null });
ok('3 midLine:null behaves as before (nudge kept)', r.content[0].text.includes(NUDGE) && !('retryStash' in r));

// 4. other tools given a midLine
['delete', 'replace-block'].forEach((tool) => {
  const x = eng.buildFailResponse({ tool, ctx: mk(), match: miss, needle, isCodeFile: true, scope, midLine: hint });
  ok('4 ' + tool + ': no retry nudge with a midLine', !x.content[0].text.includes(NUDGE));
  ok('4 ' + tool + ': retryStash:false with a midLine', x.retryStash === false && x.matched === false);
});

console.log(pass + ' passed, ' + bad + ' failed');
process.exitCode = bad ? 1 : 0;
