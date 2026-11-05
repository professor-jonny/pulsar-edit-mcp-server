'use strict';
// Regression test (2026-11-03) -- TODO F4 wording fixes.
// Run from the package root:   node test/tool-framework.no-match.test.js
// Plain node, no Pulsar, no files written. Drives lib/tool-framework.js with a stubbed `atom`, like
// tool-framework.retry-stash.test.js.
//
// 1. A search that finds nothing (grep-file) is a normal result, not a failure. It used to go through
//    ctx.fail, which counted it toward the consecutive-failure counter, so the 3rd empty search in a row got the
//    "tool-switch suggestion" banner appended. ctx.noMatch(msg, extra) returns the same shape as ctx.fail, still
//    bumps the stats key fails.<reason> (so the stats panel is unchanged), but leaves the counter alone and adds
//    no suggestion. ctx.fail is unchanged.
// 2. An edit tool pointed at a path that is not on disk gets an empty buffer; its failure result now carries a
//    "the file does not exist" note (annotateMissingFile). Successes and non-missing files are untouched.
//
// What is pinned:
//   1. Four ctx.noMatch calls in a row: no suggestion text, counter stays 0.
//   2. ctx.noMatch bumps fails.noMatch (stats unchanged) and returns msg + merged extra.
//   3. Baseline: ctx.fail still counts, and the 3rd failure gets the suggestion.
//   4. noMatch between failures neither resets nor adds to the counter (fail, fail, noMatch, fail -> 3rd failure).
//   5. Missing file (empty buffer, not on disk): a failing result gets the wrong-path note.
//   6. Missing file: a successful result is untouched.
//   7. Existing file (non-empty buffer): a failing result is untouched.

const os   = require('os');
const path = require('path');
const { makeRegisterMcpTool } = require('../lib/tool-framework');

const filePath = path.join(os.tmpdir(), 'fw_no_match_probe_does_not_exist.txt');
let bufferText = 'x';
const fakeBuf = { getLines: () => bufferText.split('\n'), getText: () => bufferText, getPath: () => filePath };
global.atom = {
  workspace: { getTextEditors: () => [], getActiveTextEditor: () => null },
  project:   { bufferForPath: async () => fakeBuf, getBuffers: () => [], getPaths: () => [] },
  config:    { get: () => undefined },
};

const registeredByName = {};
const server = { registerTool: (name, meta, fn) => { registeredByName[name] = fn; } };
const noop = () => '';
const bumps = [];
const register = makeRegisterMcpTool(server, {
  bump: (k, key) => { bumps.push(key); }, bumpHint: noop, buildEditResponse: async () => ({ content: [] }), decorateEditedLines: noop,
  applyStyleCheck: noop, maybeLintSuffix: async () => '', smartSuggestion: () => 'SUGGEST',
});

const counters = [];
register({
  name: 'probe', group: 'edit', category: 'edit',
  features: {},
  inputSchema: {},
  handler: async (args, ctx) => {
    let r;
    if (args.mode === 'nomatch') r = ctx.noMatch('{"matchCount":0}', { matchCount: 0 });
    else if (args.mode === 'fail') r = ctx.fail('noMatch', 'fail text');
    else if (args.mode === 'failtext') r = { content: [{ type: 'text', text: '\u274C afterString "x" not found' }] };
    else r = { content: [{ type: 'text', text: '\u2705 done' }] };
    counters.push(ctx.consecFailures);
    return r;
  },
});

let bad = 0, pass = 0;
function ok(label, cond, detail) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && detail !== undefined) console.log('      ' + detail);
}
const call = (mode) => registeredByName.probe({ filePath, mode });
const text = (r) => r.content[0].text;

(async () => {
  // 1 + 2. noMatch
  let last;
  for (let i = 0; i < 4; i++) last = await call('nomatch');
  ok('1 four noMatch calls in a row never get the suggestion', !text(last).includes('SUGGEST'), text(last));
  ok('1 the consecutive-failure counter stays 0', counters.every(c => c === 0), JSON.stringify(counters));
  ok('2 ctx.noMatch still bumps fails.noMatch', bumps.filter(k => k === 'fails.noMatch').length === 4, JSON.stringify(bumps));
  ok('2 ctx.noMatch returns the message and merges extra', text(last) === '{"matchCount":0}' && last.matchCount === 0, JSON.stringify(last));

  // 3. baseline: ctx.fail still counts
  counters.length = 0;
  await call('fail'); await call('fail');
  const third = await call('fail');
  ok('3 ctx.fail still counts: the 3rd failure gets the suggestion', text(third).includes('SUGGEST') && counters[2] === 3, JSON.stringify({ t: text(third), counters }));

  // 4. noMatch neither resets nor adds (the counter carries on from the failures above, so this is relative)
  counters.length = 0;
  await call('fail');
  const before = counters[0];
  await call('nomatch');
  const afterNoMatch = counters[1];
  ok('4 noMatch between failures leaves the counter alone', afterNoMatch === before, JSON.stringify({ before, afterNoMatch }));

  // 5-7. missing file note
  bufferText = '';
  const missingFail = await call('failtext');
  ok('5 missing file: a failing result gets the wrong-path note', text(missingFail).includes('The file does not exist on disk: ' + path.resolve(filePath)) && text(missingFail).startsWith('\u274C afterString'), text(missingFail));
  const missingOk = await call('ok');
  ok('6 missing file: a successful result is untouched', text(missingOk) === '\u2705 done', text(missingOk));
  bufferText = 'x';
  const existingFail = await call('failtext');
  ok('7 existing (non-empty) file: a failing result is untouched', text(existingFail) === '\u274C afterString "x" not found', text(existingFail));

  console.log(pass + ' passed, ' + bad + ' failed');
  process.exitCode = bad ? 1 : 0;
})();
