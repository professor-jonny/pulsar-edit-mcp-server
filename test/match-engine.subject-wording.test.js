'use strict';
// R1k test (2026-10-22) -- match-engine.buildFailResponse names the CALLER's own parameter in EVERY content failure.
// Before R1k, `subject` (matchString, afterContent, beforeContent) was only forwarded when the failure was a mid-line one,
// so every other delete / insert failure still said `old_str`, a parameter those tools do not have.
// Run from the package root:   node test/match-engine.subject-wording.test.js
// Plain Node, no Pulsar: it drives the engine directly (same fixtures as match-engine.fail-response.test.js).
//
// What is pinned:
//   1. With a subject, no failure message mentions old_str, and the subject appears where the diagnosis names the needle.
//   2. Without a subject (replace and every tool that passes none) the output is byte-for-byte what it was, i.e. the
//      same as passing subject:'old_str' explicitly.
//   3. The mid-line failures of R1j still use their per-tool wording.

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
const bufC = [
  'const a = 1; // set a',   // L1
  'const b = 2;',            // L2
  'const c = a + b;',        // L3
];
const mk   = (b) => ({ consec: { count: 1 }, allLines: b || buf, text: (b || buf).join('\n') });
const miss = { matched: false, reason: 'notFound' };
const sc   = (o, b) => Object.assign({ searchStart: 0, searchEnd: (b || buf).length - 1, scopeLabel: '', _hasScope: false, via: 'none', hints: {} }, o);
const txt  = (r) => r.content[0].text;

let bad = 0, pass = 0;
function ok(label, cond, detail) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && detail !== undefined) console.log('      ' + detail);
}

const inFn = sc({ searchStart: 0, searchEnd: 3, scopeLabel: ' within function "alpha"', _hasScope: true, via: 'inFunction', hints: { inFunction: 'alpha' } });
const occ1 = sc({ _hasScope: true, via: 'none', hints: { occurrence: 1 } });
const occ2 = sc({ _hasScope: true, via: 'none', hints: { occurrence: 2 } });

// each scenario: [label, needle, scope, buffer, must the subject appear?]
const SCENARIOS = [
  ['not found anywhere',               'zzz_absent();',          sc(),   buf,  true],
  ['found outside the scope',          'const count = 2;',       inFn,   buf,  true],
  ['indentation differs (whitespace)', 'const count = 2;',       sc(),   buf,  true],
  ['near miss (similarity)',           '  const count = 3;',     sc(),   buf,  true],
  ['occurrence:1 alone is no scope',   'const count = 2;',       occ1,   buf,  true],
  ['occurrence:2 is a scope',          'const count = 2;',       occ2,   buf,  true],
  ['trailing comment differs',         'const a = 1; // other',  sc({}, bufC), bufC, true],
];

const TOOLS = [
  ['delete', 'matchString'],
  ['insert', 'afterContent'],
  ['insert', 'beforeContent'],
  ['replace-block', 'anchor'],
];

function build(tool, b, scope, needle, subject) {
  const a = { tool, ctx: mk(b), match: miss, needle, isCodeFile: true, scope };
  if (subject !== undefined) a.subject = subject;
  return txt(eng.buildFailResponse(a));
}

for (const [tool, subject] of TOOLS) {
  for (const [label, needle, scope, b, mustName] of SCENARIOS) {
    const out = build(tool, b, scope, needle, subject);
    ok(tool + '/' + subject + ' / ' + label + ': no old_str in the message', !/old_str/.test(out), out.split('\n').filter((l) => /old_str/.test(l)).join(' | '));
    if (mustName) ok(tool + '/' + subject + ' / ' + label + ': the message names ' + subject, out.indexOf(subject) >= 0, out.slice(0, 300));
  }
}

// default wording unchanged for callers that pass no subject
for (const tool of ['delete', 'insert', 'replace']) {
  for (const [label, needle, scope, b] of SCENARIOS) {
    const none = build(tool, b, scope, needle, undefined);
    const explicit = build(tool, b, scope, needle, 'old_str');
    ok(tool + ' without a subject / ' + label + ': identical to subject old_str', none === explicit);
  }
}
ok('a plain delete failure without a subject still says old_str (control)', /old_str/.test(build('delete', buf, occ1, 'const count = 2;', undefined)));

// the delete retry line already names matchString (RETRY_FIELD_BY_TOOL) and must keep doing so
ok('delete retry line names matchString', /\{ filePath, matchString: /.test(build('delete', buf, sc(), 'zzz_absent();', 'matchString')));

// R1j mid-line wording is unchanged: per-tool subject in the NOTE
{
  const midNeedle = 'count = 2;';
  const midLine = { startsMid: true, endsMid: false };
  const o = txt(eng.buildFailResponse({ tool: 'delete', ctx: mk(), match: miss, needle: midNeedle, isCodeFile: true, scope: sc(), midLine, subject: 'matchString' }));
  ok('mid-line failure of delete still names matchString and not old_str', o.indexOf('matchString') >= 0 && !/old_str/.test(o), o.split('\n').filter((l) => /old_str/.test(l)).join(' | '));
}

console.log('\n' + pass + ' passed, ' + bad + ' failed');
process.exit(bad === 0 ? 0 : 1);
