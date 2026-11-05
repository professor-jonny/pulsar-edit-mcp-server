'use strict';
// Regression test (2026-10-17) -- TODO R1g: no retry nudge on a FOUND OUTSIDE SCOPE failure.
// Run from the package root:   node test/match-engine.outside-scope-nudge.test.js
// Plain node, no Pulsar, no files written. Drives match-engine.buildFailResponse directly.
//
// The problem (seen live 2026-10-17): when old_str exists in the file but outside the resolved
// scope, the failure ended with "Retry cheaply: ... call replace again with just { filePath, old_str }".
// A bare resend merges the stashed call, which keeps the wrong scope hint (inFunction), so following
// the nudge failed again with the same message. The fix for that failure is the scope, not old_str.
//
// What is pinned:
//   1. A scoped miss whose text exists only outside the scope still reports FOUND OUTSIDE SCOPE
//      and no longer prints the retry nudge (replace, delete, replace-block, replace-function-body).
//   2. Every other failure keeps the nudge exactly as before: not found anywhere, with or without a
//      scope hint, and a near miss inside the scope.
//   3. A tool with no nudge entry (insert) is unaffected.

const eng = require('../lib/match-engine');

const buf = [
  'function alpha() {',   // L1
  '  const total = 1;',   // L2
  '  return total;',      // L3
  '}',                    // L4
  '',                     // L5
  'function beta() {',    // L6
  '  const count = 2;',   // L7
  '  return count;',      // L8
  '}',                    // L9
];
const mk   = () => ({ consec: { count: 1 }, allLines: buf, text: buf.join('\n') });
const miss = { matched: false, reason: 'notFound' };
const sc   = (o) => Object.assign({ searchStart: 0, searchEnd: buf.length - 1, scopeLabel: '', _hasScope: false, via: 'none', hints: {} }, o);
const txt  = (r) => r.content[0].text;
const NUDGE = 'Retry cheaply';

// inFunction:'alpha' -> rows 0..3. 'const count = 2;' exists exactly, but only in beta (outside).
const inAlpha = sc({ searchStart: 0, searchEnd: 3, scopeLabel: ' within function "alpha"', _hasScope: true, via: 'inFunction', hints: { inFunction: 'alpha' } });

let bad = 0, pass = 0;
function chk(label, r, needle, want) {
  const ok = txt(r).includes(needle) === want;
  if (ok) pass++; else bad++;
  console.log((ok ? 'ok   ' : 'FAIL ') + label);
  if (!ok) console.log('      wanted ' + (want ? 'to contain' : 'NOT to contain') + ': ' + JSON.stringify(needle) + '\n      got: ' + JSON.stringify(txt(r)));
}

// 1. outside scope: diagnosis stays, nudge goes
['replace', 'delete', 'replace-block', 'replace-function-body'].forEach((tool) => {
  const r = eng.buildFailResponse({ tool, ctx: mk(), match: miss, needle: '  const count = 2;', isCodeFile: true, scope: inAlpha });
  chk('1 ' + tool + ': still reports FOUND OUTSIDE SCOPE', r, 'FOUND OUTSIDE SCOPE', true);
  chk('1 ' + tool + ': no retry nudge after an outside-scope failure', r, NUDGE, false);
  if (r.matched !== false) { bad++; console.log('FAIL 1 ' + tool + ': result must still carry matched:false'); } else pass++;
});

// 2. everything else keeps the nudge
let r = eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle: 'zzz_absent();', isCodeFile: true, scope: sc() });
chk('2 not found anywhere, no scope: nudge kept', r, NUDGE, true);

r = eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle: 'zzz_absent();', isCodeFile: true, scope: inAlpha });
chk('2 not found anywhere, with scope: nudge kept', r, NUDGE, true);
chk('2 not found anywhere, with scope: no FOUND OUTSIDE SCOPE', r, 'FOUND OUTSIDE SCOPE', false);

r = eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle: '    const total = 1;', isCodeFile: true, scope: inAlpha });
chk('2 near miss inside the scope (indentation): nudge kept', r, NUDGE, true);
chk('2 near miss inside the scope: no FOUND OUTSIDE SCOPE', r, 'FOUND OUTSIDE SCOPE', false);

r = eng.buildFailResponse({ tool: 'replace', ctx: mk(), match: miss, needle: '  const count = 2;', isCodeFile: true, scope: sc() });
chk('2 text exists in the file and no scope was given: nudge kept', r, NUDGE, true);

// 3. a tool with no nudge entry is unaffected
r = eng.buildFailResponse({ tool: 'insert', ctx: mk(), match: miss, needle: '  const count = 2;', isCodeFile: true, scope: inAlpha });
chk('3 insert: still reports FOUND OUTSIDE SCOPE', r, 'FOUND OUTSIDE SCOPE', true);
chk('3 insert: never had a nudge', r, NUDGE, false);

console.log(pass + ' passed, ' + bad + ' failed');
process.exitCode = bad ? 1 : 0;
