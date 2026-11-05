'use strict';
// Test (2026-11-07) -- TODO R3i: count the retry shortcut in the stats and mark a failed retry in the fault log.
// Run from the package root:   node test/tool-framework.retry-stats.test.js
// Plain node, no Pulsar, no files written. Drives lib/tool-framework.js with a stubbed `atom`, a recording
// `bump` and a scripted handler.
//
// Background: a failed replace call is stashed (features.retryOnFail) and a bare
// { filePath, old_str } resend merges into it. Nothing counted that, so there was no measure of whether the model
// uses the shortcut. Now, per tool (statsKey):
//   retryMerges     a bare resend was merged into a stashed failure
//   retryMergeHits  the merged call succeeded (matched:true or dryRun:false)
//   retryMergeFails the merged call failed again (matched:false)
// and the merged call runs inside lib/retry-context.js, so the fault log (edit-stats buildFailureRecord) can add
// viaRetry:true to a failure record written while a merged call runs.
//
// What is pinned:
//   1.  A fresh failing call counts nothing.
//   2.  A bare resend after a failure counts retryMerges once; the handler sees isRetryCall() true.
//   3.  A merged call that fails again counts retryMergeFails (not Hits).
//   4.  A merged call that succeeds counts retryMergeHits (not Fails).
//   5.  A full fresh call after a stash does not count and the handler sees isRetryCall() false.
//   6.  A resend for a different file does not merge and does not count.
//   7.  A bare resend with nothing stashed does not count.
//   8.  A tool without retryOnFail never counts.
//   9.  a second retryOnFail tool is counted under its own key.
//   10. isRetryCall() is false again outside the call (no leak into the next call).
//   11. retry-context: false outside, true inside across an await, concurrent calls do not mix.
//   12. buildFailureRecord adds viaRetry:true only inside a retry call and keeps the entry fields.

const os   = require('os');
const path = require('path');
const { makeRegisterMcpTool } = require('../lib/tool-framework');
const { runAsRetry, isRetryCall } = require('../lib/retry-context');
const { buildFailureRecord } = require('../lib/edit-stats');

const fileA = path.join(os.tmpdir(), 'fw_retry_stats_probe_a.txt');
const fileB = path.join(os.tmpdir(), 'fw_retry_stats_probe_b.txt');
const fakeBuf = { getLines: () => ['x'], getText: () => 'x', getPath: () => fileA };
global.atom = {
  workspace: { getTextEditors: () => [], getActiveTextEditor: () => null },
  project:   { bufferForPath: async () => fakeBuf, getBuffers: () => [], getPaths: () => [] },
  config:    { get: () => undefined },
};

const fns = {};
const server = { registerTool: (name, meta, fn) => { fns[name] = fn; } };
const noop = () => '';
const bumps = [];
const register = makeRegisterMcpTool(server, {
  bump: (key, sub) => { bumps.push(key + ':' + sub); },
  bumpHint: noop, buildEditResponse: async () => ({ content: [] }), decorateEditedLines: noop,
  applyStyleCheck: noop, maybeLintSuffix: async () => '', smartSuggestion: noop,
});

const seen = [];
function scripted(name, withRetry) {
  register({
    name, group: 'edit', category: 'edit',
    features: withRetry ? { retryOnFail: { field: 'old_str' } } : {},
    inputSchema: {},
    handler: async (args) => {
      seen.push({ name, args: Object.assign({}, args), retry: isRetryCall() });
      const text = [{ type: 'text', text: 'x' }];
      if (args.mode === 'fail')      return { content: text, matched: false };
      if (args.mode === 'needGood')  return args.old_str === 'good' ? { content: text, matched: true } : { content: text, matched: false };
      return { content: text, matched: true };
    },
  });
}
scripted('replace', true);
scripted('second_tool', true);
scripted('plain', false);

let bad = 0, pass = 0;
function ok(label, cond, detail) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && detail !== undefined) console.log('      ' + detail);
}
const last = () => seen[seen.length - 1];
const count = (s) => bumps.filter(b => b === s).length;
const delay = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // 1. a fresh failing call counts nothing
  await fns.replace({ filePath: fileA, old_str: 'bad', new_str: 'N1', mode: 'needGood' });
  ok('1 a fresh failing call counts no retry key', bumps.filter(b => /retry/.test(b)).length === 0, JSON.stringify(bumps));

  // 2. bare resend after a failure: retryMerges once, handler sees isRetryCall() true
  await fns.replace({ filePath: fileA, old_str: 'still bad' });
  ok('2a a bare resend counts replace:retryMerges once', count('replace:retryMerges') === 1, JSON.stringify(bumps));
  ok('2b the handler sees isRetryCall() true for the merged call', last().retry === true && last().args.new_str === 'N1', JSON.stringify(last()));

  // 3. the merged call failed again (old_str 'still bad' is not 'good')
  ok('3 a merged call that fails again counts retryMergeFails, not Hits', count('replace:retryMergeFails') === 1 && count('replace:retryMergeHits') === 0, JSON.stringify(bumps));

  // 4. the merged call succeeds: stash again, then resend with old_str 'good'
  await fns.replace({ filePath: fileA, old_str: 'bad2', new_str: 'N4', mode: 'needGood' });
  await fns.replace({ filePath: fileA, old_str: 'good' });
  ok('4 a merged call that succeeds counts retryMergeHits, not another Fail', count('replace:retryMergeHits') === 1 && count('replace:retryMergeFails') === 1 && count('replace:retryMerges') === 2, JSON.stringify(bumps));

  // 5. a full fresh call after a stash is not a retry
  await fns.replace({ filePath: fileA, old_str: 'bad5', new_str: 'N5', mode: 'needGood' });
  const before5 = count('replace:retryMerges');
  await fns.replace({ filePath: fileA, old_str: 'other', new_str: 'N5b', mode: 'needGood' });
  ok('5a a full fresh call after a stash does not count', count('replace:retryMerges') === before5, JSON.stringify(bumps));
  ok('5b the handler sees isRetryCall() false for it', last().retry === false, JSON.stringify(last()));

  // 6. a resend for a different file does not merge and does not count
  await fns.replace({ filePath: fileA, old_str: 'bad6', new_str: 'N6', mode: 'needGood' });
  const before6 = count('replace:retryMerges');
  const n6 = seen.length;
  await fns.replace({ filePath: fileB, old_str: 'x' }).catch(() => {});
  ok('6 a resend for a different file is not merged and not counted', count('replace:retryMerges') === before6 && (seen.length === n6 || last().args.new_str === undefined), JSON.stringify(bumps));

  // 7. a bare resend with nothing stashed does not count
  await fns.replace({ filePath: fileA, old_str: 'good', new_str: 'ok7' }); // success clears the stash
  const before7 = count('replace:retryMerges');
  await fns.replace({ filePath: fileA, old_str: 'z' }).catch(() => {});
  ok('7 a bare resend with nothing stashed does not count', count('replace:retryMerges') === before7, JSON.stringify(bumps));

  // 8. a tool without retryOnFail never counts
  await fns.plain({ filePath: fileA, old_str: 'a', new_str: 'N8', mode: 'fail' });
  await fns.plain({ filePath: fileA, old_str: 'b' }).catch(() => {});
  ok('8 a tool without retryOnFail counts no retry key', bumps.filter(b => /^plain:retry/.test(b)).length === 0, JSON.stringify(bumps));

  // 9. a second retryOnFail tool under its own key
  await fns.second_tool({ filePath: fileA, old_str: 'bad9', new_str: 'N9', mode: 'needGood' });
  await fns.second_tool({ filePath: fileA, old_str: 'good' });
  ok('9 a second retryOnFail tool counts under its own key', count('second_tool:retryMerges') === 1 && count('second_tool:retryMergeHits') === 1, JSON.stringify(bumps));

  // 10. no leak out of the call
  ok('10 isRetryCall() is false again outside the call', isRetryCall() === false);

  // 11. retry-context itself
  ok('11a false outside', isRetryCall() === false);
  const inside = await runAsRetry(async () => { await delay(3); return isRetryCall(); });
  ok('11b true inside, across an await', inside === true);
  const a = runAsRetry(async () => { await delay(8); return isRetryCall(); });
  const b = (async () => { await delay(2); return isRetryCall(); })();
  const [ra, rb] = await Promise.all([a, b]);
  ok('11c concurrent calls do not mix (retry true, plain false)', ra === true && rb === false, ra + ' ' + rb);

  // 12. fault-log record
  const plainRec = buildFailureRecord({ tool: 'replace', reason: 'noMatch' });
  const retryRec = await runAsRetry(async () => buildFailureRecord({ tool: 'replace', reason: 'noMatch' }));
  ok('12a no viaRetry outside a retry call', plainRec.viaRetry === undefined && plainRec.tool === 'replace' && plainRec.reason === 'noMatch' && typeof plainRec.ts === 'string', JSON.stringify(plainRec));
  ok('12b viaRetry:true inside a retry call, other fields kept', retryRec.viaRetry === true && retryRec.tool === 'replace' && retryRec.reason === 'noMatch', JSON.stringify(retryRec));

  console.log(pass + ' passed, ' + bad + ' failed');
  process.exitCode = bad ? 1 : 0;
})();
