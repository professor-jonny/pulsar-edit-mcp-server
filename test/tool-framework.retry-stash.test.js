'use strict';
// Regression test (2026-10-17) -- TODO R1i: a failure that sets retryStash:false must not be stashed,
// and must clear any older stashed failure for the same tool.
// Run from the package root:   node test/tool-framework.retry-stash.test.js
// Plain node, no Pulsar, no files written. Drives lib/tool-framework.js with a stubbed `atom` and a
// scripted handler.
//
// The problem: features.retryOnFail stashes every matched:false failure, and the next call that is
// exactly { filePath, old_str } merges the stashed new_str and flags into it. For a mid-line failure
// that is dangerous: extending old_str to the whole line and bare-resending replaces the whole line
// with the partial new_str. buildFailResponse now returns retryStash:false for a mid-line failure;
// the framework must honour it. A result with neither matched:false nor matched:true (so no stash
// change at all) would leave an OLDER unrelated failure alive, which a bare resend could still merge.
//
// What is pinned:
//   1. Baseline: a plain matched:false failure is stashed and a bare { filePath, old_str } merges it.
//   2. A matched:false + retryStash:false failure is not stashed: a bare resend after it is NOT merged.
//   3. It also clears an OLDER stash: fail (stashed), then a retryStash:false failure, then a bare
//      resend is NOT merged with the older failure.
//   4. After a retryStash:false failure, a normal matched:false failure stashes again.
//   5. matched:true still clears the stash (unchanged).

const os   = require('os');
const path = require('path');
const { makeRegisterMcpTool } = require('../lib/tool-framework');

const filePath = path.join(os.tmpdir(), 'fw_retry_stash_probe.txt');
const fakeBuf  = { getLines: () => ['x'], getText: () => 'x', getPath: () => filePath };
global.atom = {
  workspace: { getTextEditors: () => [], getActiveTextEditor: () => null },
  project:   { bufferForPath: async () => fakeBuf, getBuffers: () => [], getPaths: () => [] },
  config:    { get: () => undefined },
};

let registered = null;
const server = { registerTool: (name, meta, fn) => { registered = fn; } };
const noop = () => '';
const register = makeRegisterMcpTool(server, {
  bump: noop, bumpHint: noop, buildEditResponse: async () => ({ content: [] }), decorateEditedLines: noop,
  applyStyleCheck: noop, maybeLintSuffix: async () => '', smartSuggestion: noop,
});

const seen = [];
register({
  name: 'replace', group: 'edit', category: 'edit',
  features: { retryOnFail: { field: 'old_str' } },
  inputSchema: {},
  handler: async (args) => {
    seen.push(Object.assign({}, args));
    if (args.mode === 'fail')    return { content: [{ type: 'text', text: 'x' }], matched: false };
    if (args.mode === 'midline') return { content: [{ type: 'text', text: 'x' }], matched: false, retryStash: false };
    if (args.mode === 'ok')      return { content: [{ type: 'text', text: 'x' }], matched: true };
    return { content: [{ type: 'text', text: 'x' }] };
  },
});

let bad = 0, pass = 0;
function ok(label, cond, detail) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && detail !== undefined) console.log('      ' + detail);
}
const last = () => seen[seen.length - 1];

(async () => {
  // 1. baseline: stash + merge
  await registered({ filePath, old_str: 'a', new_str: 'N1', mode: 'fail' });
  await registered({ filePath, old_str: 'b' });
  ok('1 plain failure is stashed: a bare resend merges new_str and mode', last().new_str === 'N1' && last().mode === 'fail' && last().old_str === 'b', JSON.stringify(last()));

  // 2. retryStash:false is not stashed
  await registered({ filePath, old_str: 'a', new_str: 'N2', mode: 'midline' });
  const n2 = seen.length;
  await registered({ filePath, old_str: 'whole line' });
  ok('2 after a retryStash:false failure a bare resend is not merged', seen.length === n2 + 1 && last().new_str === undefined && last().mode === undefined, JSON.stringify(last()));

  // 3. retryStash:false also clears an older stash
  await registered({ filePath, old_str: 'a', new_str: 'N3', mode: 'fail' });
  await registered({ filePath, old_str: 'a', new_str: 'N3b', mode: 'midline' });
  await registered({ filePath, old_str: 'whole line' });
  ok('3 an older stashed failure is cleared by a later retryStash:false failure', last().new_str === undefined && last().mode === undefined, JSON.stringify(last()));

  // 4. a normal failure stashes again afterwards
  await registered({ filePath, old_str: 'a', new_str: 'N4', mode: 'fail' });
  await registered({ filePath, old_str: 'c' });
  ok('4 a normal failure after that stashes again', last().new_str === 'N4' && last().mode === 'fail', JSON.stringify(last()));

  // 5. matched:true still clears
  await registered({ filePath, old_str: 'a', new_str: 'N5', mode: 'fail' });
  await registered({ filePath, old_str: 'a', new_str: 'N5b', mode: 'ok' });
  await registered({ filePath, old_str: 'd' });
  ok('5 matched:true still clears the stash', last().new_str === undefined && last().mode === undefined, JSON.stringify(last()));

  console.log(pass + ' passed, ' + bad + ' failed');
  process.exitCode = bad ? 1 : 0;
})();
