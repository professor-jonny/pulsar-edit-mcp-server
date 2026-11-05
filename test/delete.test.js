'use strict';
// Aggregated summary: the runner reads only the LAST 'N passed, M failed' line, so each block's line is folded into one total printed at the end.
let __p = 0, __f = 0; const __log = console.log.bind(console);
console.log = (...a) => { const m = /(\d+) passed, (\d+) failed/.exec(a.map(String).join(' ')); if (m) { __p += Number(m[1]); __f += Number(m[2]); } else __log(...a); };
// Merged 2026-11-19 from: delete.fragment.test.js, delete.mode12-3-framework.test.js, delete.mode4-framework.test.js, delete.mode5-framework.test.js, delete.mode5-range.test.js, delete.mode6-framework.test.js.
// Each former file runs in its own block, so names and pass/fail counters stay separate. Run: node test/delete.test.js

// ===== delete.fragment =====
{
// Source-check test (2026-11-13) -- TODO R3a / H13, delete step B: fragment:true on delete.
// Run from the package root:   node test/delete.fragment.test.js
// Plain node, no Pulsar, no files written. Handler wiring cannot be unit-tested outside Pulsar, so this scans
// lib/mcp-registration.js, lib/edit-stats.js and lib/mid-line-hint.js. The planner itself
// (lib/replace-fragment.js planFragmentReplace) is covered by its own tests. A live probe after a full Pulsar restart is still needed.
//
// Design (PJ, 2026-11-13): delete with fragment:true removes ONLY the matched span of a matchString match; the LINE STAYS,
// even when the span is the whole line text (it is left empty). Whole-line delete stays the default.
// Pinned:
//   1. delete schema and handler take fragment and guardIdentifier.
//   2. Early refusals (before Mode 1/2): fragment without matchString; fragment with banner / ifdefBlock / startContent / endContent.
//   3. Mode 5 plans through planFragmentReplace with newStr '' and the scope rows, passing the fuzzy flags (the planner refuses the clash).
//   4. Mode 5 writes through applyEditSpan after ctx.snapshotOriginal(), commits through ctx.commit, dry-runs through ctx.dryRunReturn.
//   5. The fragment branch comes BEFORE the whole-line matchContentEngine call in Mode 5.
//   6. Stats: delete has fragmentCommits and fragmentFails, and lists them as extras.
//   7. mid-line-hint.js: the deleteMatch advice says pass fragment:true (no replace, no new_str); deleteAnchor stays whole-line.
//   8. Tool description and catalogue text mention fragment:true and that the line stays.

const fs = require('fs');
const path = require('path');

let bad = 0, pass = 0;
function ok(label, cond, detail) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && detail !== undefined) console.log('      ' + detail);
}
const lib = (f) => fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');
const reg = lib('mcp-registration.js');
function seg(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s === -1) return null;
  const e = src.indexOf(endMarker, s);
  return e === -1 ? null : src.slice(s, e);
}

// 1. schema + handler ------------------------------------------------------------------------------------------------
const delTool = seg(reg, "name:     'delete',", '// -- Mode 1/2: structural anchor');
ok('found the delete tool head (description, schema, handler signature)', delTool !== null);
const schema = delTool && seg(delTool, 'inputSchema:', 'handler:');
ok('1 schema has fragment: z.boolean().optional()', !!schema && /fragment:\s*z\.boolean\(\)\.optional\(\)/.test(schema));
ok('1 schema has guardIdentifier: z.boolean().optional()', !!schema && /guardIdentifier:\s*z\.boolean\(\)\.optional\(\)/.test(schema));
const sig = delTool && delTool.match(/handler:\s*async\s*\(\{[^}]*\}/);
ok('1 handler destructures fragment', !!sig && /\bfragment\b/.test(sig[0]));
ok('1 handler destructures guardIdentifier', !!sig && /\bguardIdentifier\b/.test(sig[0]));

// 2. early refusals --------------------------------------------------------------------------------------------------
ok('2 refuses fragment without matchString before Mode 1/2', !!delTool && /if \(fragment\b[^)]*matchString === undefined/.test(delTool));
ok('2 the refusal text says fragment:true needs matchString', !!delTool && /fragment:true needs matchString/.test(delTool));
ok('2 refuses fragment with banner / ifdefBlock / startContent / endContent',
  !!delTool && /fragment[\s\S]{0,200}banner !== undefined[\s\S]{0,200}ifdefBlock !== undefined[\s\S]{0,200}startContent !== undefined[\s\S]{0,200}endContent !== undefined/.test(delTool));
ok('2 the early refusals are not delete failures that bump consec or fails', !!delTool && !/fragment:true needs matchString[\s\S]{0,300}ctx\.consec\.count\+\+/.test(delTool));

// 3-5. Mode 5 ---------------------------------------------------------------------------------------------------------
const m5 = seg(reg, '// -- Mode 5: matchString', '// -- Mode 6: legacy positional');
ok('found the Mode 5 segment', m5 !== null);
if (m5) {
  const iFrag = m5.indexOf('planFragmentReplace(');
  const iWhole = m5.indexOf('const _match = matchContentEngine(');
  ok('3 Mode 5 calls planFragmentReplace', iFrag !== -1);
  ok("3 newStr is '' (delete removes the span)", /planFragmentReplace\(\{[\s\S]*?newStr:\s*''/.test(m5));
  ok('3 plans over the resolved scope rows (searchStart / searchEnd)', /planFragmentReplace\(\{[\s\S]*?startRow:\s*_scope\.searchStart[\s\S]*?endRow:\s*_scope\.searchEnd/.test(m5));
  ok('3 passes occurrence and guardIdentifier', /planFragmentReplace\(\{[\s\S]*?occurrence[\s\S]*?guardIdentifier/.test(m5));
  ok('3 passes the fuzzy flags so the planner can refuse the clash', /planFragmentReplace\(\{[\s\S]*?flags:\s*\{\s*fuzzyWhitespace,\s*fuzzyContent\s*\}/.test(m5));
  ok('3 passes liveLines on a commit only (drift pre-check)', /liveLines:\s*dryRun\s*\?\s*undefined\s*:\s*buffer\.getLines\(\)/.test(m5));
  ok('4 writes through applyEditSpan', /applyEditSpan\(buffer,/.test(m5));
  ok('4 snapshotOriginal comes before applyEditSpan', m5.indexOf('ctx.snapshotOriginal()') !== -1 && m5.indexOf('ctx.snapshotOriginal()') < m5.indexOf('applyEditSpan('));
  ok('4 the fragment branch commits through ctx.commit', /_commitFrag\s*=\s*await ctx\.commit\(/.test(m5));
  ok('4 the fragment branch dry-runs through ctx.dryRunReturn', /ctx\.dryRunReturn\(/.test(m5.slice(iFrag, iWhole)));
  ok('4 the fragment branch reports linesChanged for a multi-line span (rows joined)', /linesChanged:\s*-\(/.test(m5.slice(iFrag, iWhole)));
  ok("4 a refused fragment counts fragmentFails", m5.includes("'fragmentFails'"));
  ok("4 a committed fragment counts fragmentCommits", m5.includes("'fragmentCommits'"));
  ok('5 the fragment branch comes before the whole-line matchContentEngine call', iFrag !== -1 && iWhole !== -1 && iFrag < iWhole, iFrag + ' / ' + iWhole);
  ok('5 the fragment branch is guarded by if (fragment)', /if \(fragment\) \{/.test(m5));
  ok('5 the whole-line branch still deletes rows (buffer.deleteRows)', m5.includes('buffer.deleteRows(delStart, delEnd)'));

  // 9. wording found by the live probe (2026-11-13)
  ok('9 the dry-run header names the tags once (the planner tags already include fragment)', !m5.includes('[fragment${') && m5.includes('_fTags.length ? _fTags.join(", ") : "fragment"'));
  ok('9 the whole-line NOTE starts on its own line (leading newline)', /_fNudge\s*=\s*_fWhole\s*\?\s*'\\n\\nNOTE:/.test(m5) || /_fNudge\s*=\s*_fWhole\s*\?\s*'\\nNOTE:/.test(m5));
  ok('9 planner refusals say delete, not replace', /_plan\.message\.replace\(\/\^replace\\b\/,\s*'delete'\)/.test(m5));
}

// 6. stats -----------------------------------------------------------------------------------------------------------
const stats = lib('edit-stats.js');
const sDel = seg(stats, '  delete: {', '  replace_function_body: {');
ok('6 delete stats block has fragmentCommits: 0', !!sDel && /fragmentCommits:\s*0/.test(sDel));
ok('6 delete stats block has fragmentFails: 0', !!sDel && /fragmentFails:\s*0/.test(sDel));
ok("6 the delete summary row lists fragmentCommits and fragmentFails as extras", /key:\s*'delete'[^\n]*extras:\s*\[[^\]]*'fragmentCommits'[^\]]*'fragmentFails'/.test(stats));

// 7. mid-line advice -------------------------------------------------------------------------------------------------
const mlh = require(path.join(__dirname, '..', 'lib', 'mid-line-hint.js'));
const advDel = mlh.midLineAdvice('deleteMatch', 'matchString');
ok('7 deleteMatch advice says pass fragment:true', /fragment:true/.test(advDel), advDel);
ok('7 deleteMatch advice no longer names replace or new_str', !/replace/i.test(advDel) && !/new_str/.test(advDel), advDel);
ok('7 deleteMatch advice says the line stays when the span is the whole line', /line stays|stays, empty|left empty/i.test(advDel), advDel);
ok('7 deleteMatch advice still offers extending to whole lines', /whole line/i.test(advDel), advDel);
const advAnchor = mlh.midLineAdvice('deleteAnchor', 'startContent');
ok('7 deleteAnchor advice is unchanged: no fragment:true (range delete has no part-line mode)', !/fragment:true/.test(advAnchor) || /no part-line mode/.test(advAnchor), advAnchor);

// 8. description + catalogue ------------------------------------------------------------------------------------------
const desc = seg(reg, "name:     'delete',", 'inputSchema:');
ok('8 delete description mentions fragment:true', !!desc && /fragment:true/.test(desc));
ok('8 delete description says the line stays', !!desc && /(line (always )?stays|leaves the line)/i.test(desc));
ok('8 delete description says guardIdentifier', !!desc && /guardIdentifier/.test(desc));
const cat = lib('tool-catalogue.js');
const catDel = (cat.split('\n').find(l => /name:\s*"delete"/.test(l) || /name:\s*'delete'/.test(l)) || '');
ok('8 catalogue delete line mentions fragment:true', /fragment:true/.test(catDel), catDel.slice(0, 120));

console.log(pass + ' passed, ' + bad + ' failed');
if (bad) process.exitCode = 1;
}

// ===== delete.mode12-3-framework =====
{
// Source-check test (2026-11-11) -- TODO R3a / H13: delete Modes 1/2 (banner / ifdefBlock) and Mode 3 (inFunction)
// moved onto the Tool Framework (step 2; Mode 5 was step 1, see delete.mode5-framework.test.js).
// Run from the package root:   node test/delete.mode12-3-framework.test.js
// Plain node, no Pulsar, no files written. Handler wiring cannot be unit-tested outside Pulsar, so this scans
// lib/mcp-registration.js. A live probe after a full Pulsar restart is still needed for each mode.
//
// Pinned for each of the two segments (same checks as Mode 5):
//   1. ctx.snapshotOriginal() BEFORE buffer.deleteRows, then await ctx.commit AFTER it with
//      line: delStart + 1, linesChanged: -deletedCount and the lint suffix.
//   2. The dry run returns through ctx.dryRunReturn, payload fields and message text unchanged.
//   3. No hand-rolled decorateLine, buildEditResponse, manual hit bump or manual consec reset.
//   4. The return keeps dryRun:false, deleted:true, newLineCount, deletedCount.
//   5. The failure paths are untouched (buildFailResponse, own stats keys, logMatchFailure).
// Modes 4 and 6 are NOT migrated yet: they must still hold their own tails (control checks at the end).

const fs = require('fs');
const path = require('path');

let bad = 0, pass = 0;
function ok(label, cond, detail) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && detail !== undefined) console.log('      ' + detail);
}

const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
function seg(startMarker, endMarker) {
  const s = reg.indexOf(startMarker);
  if (s === -1) return null;
  const e = reg.indexOf(endMarker, s);
  return e === -1 ? null : reg.slice(s, e);
}

function checkMode(label, code, dryRunText, failKeys) {
  ok(label + ' found the segment', code !== null);
  if (!code) return;
  const iSnap = code.indexOf('ctx.snapshotOriginal()');
  const iDel = code.indexOf('buffer.deleteRows(');
  const iCommit = code.indexOf('await ctx.commit(');
  ok(label + ' calls ctx.snapshotOriginal()', iSnap !== -1);
  ok(label + ' calls buffer.deleteRows(', iDel !== -1);
  ok(label + ' snapshot comes BEFORE the delete', iSnap !== -1 && iDel !== -1 && iSnap < iDel);
  ok(label + ' finishes through await ctx.commit(', iCommit !== -1);
  ok(label + ' commit comes AFTER the delete', iDel !== -1 && iCommit !== -1 && iDel < iCommit);
  const commitCall = iCommit === -1 ? '' : code.slice(iCommit, code.indexOf(';', iCommit) + 1);
  ok(label + ' commit meta carries line: delStart + 1', /line:\s*delStart\s*\+\s*1/.test(commitCall), commitCall);
  ok(label + ' commit meta carries linesChanged: -deletedCount', /linesChanged:\s*-deletedCount/.test(commitCall), commitCall);
  ok(label + ' commit passes the lint suffix it computed', /lint:\s*_lintSuffix\b/.test(commitCall), commitCall);
  ok(label + ' the lint suffix is still computed with maybeLintSuffix', /_lintSuffix\s*=\s*await\s+maybeLintSuffix\(/.test(code));
  ok(label + ' dry run goes through ctx.dryRunReturn(', /if\s*\(dryRun\)\s*\{\s*return\s+ctx\.dryRunReturn\(/.test(code));
  ok(label + ' dry run payload keeps dryRun:true, deleted:false, startLine, endLine, deletedCount', /dryRun:\s*true,\s*deleted:\s*false,\s*startLine:\s*delStart\s*\+\s*1,\s*endLine:\s*delEnd\s*\+\s*1,\s*deletedCount/.test(code));
  ok(label + ' dry run message text is unchanged', code.includes(dryRunText) && code.includes('Context (- = lines to be deleted)') && code.includes('Reply with the same call without dryRun'), dryRunText);
  ok(label + ' no hand-rolled decorateLine', !/decorateLine\(/.test(code));
  ok(label + ' no hand-rolled buildEditResponse', !/buildEditResponse\(/.test(code));
  ok(label + " no manual hit bump (bump('delete', 'hits'))", !/bump\(\s*'delete'\s*,\s*'hits'\s*\)/.test(code));
  ok(label + ' no manual consec reset after the delete', !/ctx\.consec\.count\s*=\s*0/.test(code));
  ok(label + ' return keeps dryRun:false, deleted:true, newLineCount, deletedCount', /dryRun:\s*false,\s*deleted:\s*true,\s*newLineCount,\s*deletedCount/.test(code.slice(iCommit === -1 ? 0 : iCommit)));
  ok(label + ' newLineCount is still read from the buffer', /newLineCount\s*=\s*buffer\.getLineCount\(\)/.test(code));
  ok(label + ' failure path keeps buildFailResponse({', (code.match(/buildFailResponse\(\{/g) || []).length === 1);
  ok(label + ' failure path keeps logMatchFailure({', (code.match(/logMatchFailure\(\{/g) || []).length === 1);
  ok(label + ' failure path keeps its stats keys', failKeys.every((k) => code.includes(k)), failKeys.join(','));
}

checkMode('mode 1/2:', seg('// -- Mode 1/2: structural anchor', '// -- Mode 3: inFunction'),
  'will delete ${deletedCount} line(s) (lines ${delStart + 1}\\u2013${delEnd + 1}).', ["'fails.anchorAmbiguous'", "'fails.anchorNotFound'"]);
checkMode('mode 3:', seg('// -- Mode 3: inFunction', '// -- Mode 4: content pair'),
  'will delete ${deletedCount} line(s) (lines ${delStart + 1}\\u2013${delEnd + 1}), function "${inFunction}".', ["'fails.anchorAmbiguous'", "'fails.anchorNotFound'"]);

// Mode 3 reads the function's row range, Mode 1/2 the anchor rows: pinned so a copy-paste slip is caught.
const m12 = seg('// -- Mode 1/2: structural anchor', '// -- Mode 3: inFunction');
const m3 = seg('// -- Mode 3: inFunction', '// -- Mode 4: content pair');
ok('mode 1/2: still takes its rows from anchorRow / endAnchorRow', !!m12 && /delStart\s*=\s*_sScope\.anchorRow/.test(m12) && /delEnd\s*=\s*_sScope\.endAnchorRow/.test(m12));
ok('mode 3: still takes its rows from searchStart / searchEnd', !!m3 && /delStart\s*=\s*_fScope\.searchStart/.test(m3) && /delEnd\s*=\s*_fScope\.searchEnd/.test(m3));

// Control: Modes 4 and 5 are migrated (steps 3 and 1); Mode 6 still holds its own tail.
const m4 = seg('// -- Mode 4: content pair', '// -- Mode 5: matchString');
const m5 = seg('// -- Mode 5: matchString', '// -- Mode 6: legacy positional');
ok('control: mode 5 is still on ctx.commit', !!m5 && /await\s+ctx\.commit\(/.test(m5));
ok('control: mode 4 is on ctx.commit too (step 3, see delete.mode4-framework.test.js)', !!m4 && /await\s+ctx\.commit\(/.test(m4) && !/decorateLine\(/.test(m4));

console.log(pass + ' passed, ' + bad + ' failed');
if (bad) process.exitCode = 1;
}

// ===== delete.mode4-framework =====
{
// Source-check test (2026-11-12) -- TODO R3a / H13, step 3: delete Mode 4 (startContent + endContent) moved onto the
// Tool Framework (Mode 5 was step 1, Modes 1/2 and 3 were step 2; see delete.mode5-framework.test.js and
// delete.mode12-3-framework.test.js).
// Run from the package root:   node test/delete.mode4-framework.test.js
// Plain node, no Pulsar, no files written. Handler wiring cannot be unit-tested outside Pulsar, so this scans
// lib/mcp-registration.js. A live probe after a full Pulsar restart is still needed.
//
// Only the COMMIT TAIL and the dry-run return of Mode 4 change. Mode 4's long failure handling (startContent and
// endContent diagnosis, midLineHint, logMatchFailure, S1/S2/S2c/S2d/S4 behaviour) is deliberate and must stay as it is.
// Pinned:
//   1. snapshotOriginal() BEFORE buffer.deleteRows, then await ctx.commit AFTER it with line: delStart + 1,
//      linesChanged: -deletedCount and the lint suffix (_lintSuffix2 in this mode).
//   2. The dry run returns through ctx.dryRunReturn, payload and message text (incl. startMsgHint/endMsgHint) unchanged.
//   3. No hand-rolled decorateLine, buildEditResponse, manual hit bump or manual consec reset.
//   4. The return keeps dryRun:false, deleted:true, newLineCount: newLineCount2, deletedCount.
//   5. All the failure handling is untouched: counts of buildFailResponse / logMatchFailure / diagnoseFailure /
//      midLineHint, the four logMatchFailure reasons, the three fails.* keys, autoRescue:false on both engine calls,
//      the S2c occurrence:1 pin on the end match, the S2 occurrence forward on the start match, the empty-range refusal.
//   6. Control: Mode 6 (startLine/endLine) is on ctx.commit too (step A2).

const fs = require('fs');
const path = require('path');

let bad = 0, pass = 0;
function ok(label, cond, detail) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && detail !== undefined) console.log('      ' + detail);
}

const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
function seg(startMarker, endMarker) {
  const s = reg.indexOf(startMarker);
  if (s === -1) return null;
  const e = reg.indexOf(endMarker, s);
  return e === -1 ? null : reg.slice(s, e);
}
const count = (code, re) => (code.match(re) || []).length;

const m4 = seg('// -- Mode 4: content pair', '// -- Mode 5: matchString');
ok('found the Mode 4 segment', m4 !== null);
if (m4) {
  // 1. commit tail
  const iSnap = m4.indexOf('ctx.snapshotOriginal()');
  const iDel = m4.indexOf('buffer.deleteRows(');
  const iCommit = m4.indexOf('await ctx.commit(');
  ok('1 calls ctx.snapshotOriginal()', iSnap !== -1);
  ok('1 calls buffer.deleteRows(', iDel !== -1);
  ok('1 snapshot comes BEFORE the delete', iSnap !== -1 && iDel !== -1 && iSnap < iDel);
  ok('1 finishes through await ctx.commit(', iCommit !== -1);
  ok('1 commit comes AFTER the delete', iDel !== -1 && iCommit !== -1 && iDel < iCommit);
  const commitCall = iCommit === -1 ? '' : m4.slice(iCommit, m4.indexOf(';', iCommit) + 1);
  ok('1 commit meta carries line: delStart + 1', /line:\s*delStart\s*\+\s*1/.test(commitCall), commitCall);
  ok('1 commit meta carries linesChanged: -deletedCount', /linesChanged:\s*-deletedCount/.test(commitCall), commitCall);
  ok('1 commit passes the lint suffix it computed (_lintSuffix2)', /lint:\s*_lintSuffix2\b/.test(commitCall), commitCall);
  ok('1 the lint suffix is still computed with maybeLintSuffix', /_lintSuffix2\s*=\s*await\s+maybeLintSuffix\(/.test(m4));

  // 2. dry run
  ok('2 dry run goes through ctx.dryRunReturn(', /if\s*\(dryRun\)\s*\{\s*return\s+ctx\.dryRunReturn\(/.test(m4));
  ok('2 dry run payload keeps dryRun:true, deleted:false, startLine, endLine, deletedCount', /dryRun:\s*true,\s*deleted:\s*false,\s*startLine:\s*delStart\s*\+\s*1,\s*endLine:\s*delEnd\s*\+\s*1,\s*deletedCount/.test(m4));
  ok('2 dry run message keeps the start/end match hints', m4.includes('(lines ${delStart + 1}\\u2013${delEnd + 1})${startMsgHint}${endMsgHint}.'));
  ok('2 dry run message keeps the context and commit lines', m4.includes('Context (- = lines to be deleted)') && m4.includes('Reply with the same call without dryRun'));

  // 3. no hand-rolled tail
  ok('3 no hand-rolled decorateLine', !/decorateLine\(/.test(m4));
  ok('3 no hand-rolled buildEditResponse', !/buildEditResponse\(/.test(m4));
  ok("3 no manual hit bump (bump('delete', 'hits'))", !/bump\(\s*'delete'\s*,\s*'hits'\s*\)/.test(m4));
  ok('3 no manual consec reset after the delete', !/ctx\.consec\.count\s*=\s*0/.test(m4));

  // 4. return
  ok('4 return keeps dryRun:false, deleted:true, newLineCount: newLineCount2, deletedCount', /dryRun:\s*false,\s*deleted:\s*true,\s*newLineCount:\s*newLineCount2,\s*deletedCount/.test(m4.slice(iCommit === -1 ? 0 : iCommit)));
  ok('4 newLineCount2 is still read from the buffer', /newLineCount2\s*=\s*buffer\.getLineCount\(\)/.test(m4));

  // 5. failure handling untouched
  ok('5 buildFailResponse({ still used once (occurrenceOutOfRange)', count(m4, /buildFailResponse\(\{/g) === 1);
  ok('5 logMatchFailure({ still used 4 times', count(m4, /logMatchFailure\(\{/g) === 4, String(count(m4, /logMatchFailure\(\{/g)));
  ['startAmbiguous', 'startNotFound', 'endAmbiguous', 'endNotFound'].forEach((r) => ok('5 logMatchFailure reason ' + r, m4.includes("reason: '" + r + "'")));
  ok('5 diagnoseFailure( still used for both anchors', count(m4, /diagnoseFailure\(\{/g) === 2);
  ok('5 midLineHint( still used for both anchors', count(m4, /midLineHint\(\{/g) === 2);
  ok('5 failure stats keys kept', m4.includes("'fails.anchorAmbiguous'") && m4.includes("'fails.startNotFound'") && m4.includes("'fails.endNotFound'") && m4.includes("'fails.anchorNotFound'"));
  ok('5 S1: autoRescue:false on both engine calls', count(m4, /autoRescue:\s*false/g) === 2);
  ok('5 S2: occurrence forwarded to the start match', /\{\s*fuzzyWhitespace,\s*fuzzyContent,\s*occurrence,\s*autoRescue:\s*false\s*\}/.test(m4));
  ok('5 S2c: the end match is pinned to occurrence: 1', /\{\s*fuzzyWhitespace,\s*fuzzyContent,\s*occurrence:\s*1,\s*autoRescue:\s*false\s*\}/.test(m4));
  ok('5 the empty-range refusal is kept', m4.includes('No lines to delete'));
  ok('5 delStart / delEnd still honour inclusive', /delStart\s*=\s*inclusive\s*\?\s*startRow\s*:\s*startRow\s*\+\s*1/.test(m4) && /delEnd\s*=\s*inclusive\s*\?\s*endRow\s*:\s*endRow\s*-\s*1/.test(m4));
}

// 6. control: Mode 6 still on its own tail
const m6Start = reg.indexOf('// -- Mode 6: legacy positional');
const m6End = m6Start === -1 ? -1 : reg.slice(m6Start).search(/\n\s*name:\s*'/);
const m6 = m6Start === -1 ? null : reg.slice(m6Start, m6End === -1 ? m6Start + 12000 : m6Start + m6End);
ok('6 control: found the Mode 6 segment', m6 !== null);
ok('6 control: Mode 6 is on ctx.commit too (step A2, see delete.mode6-framework.test.js)', !!m6 && /await\s+ctx\.commit\(/.test(m6) && !/decorateLine\(/.test(m6));

console.log(pass + ' passed, ' + bad + ' failed');
if (bad) process.exitCode = 1;
}

// ===== delete.mode5-framework =====
{
// Source-check test (2026-11-11) -- TODO R3a / H13: delete Mode 5 (matchString) moved onto the Tool Framework.
// Run from the package root:   node test/delete.mode5-framework.test.js
// Plain node, no Pulsar, no files written. Handler wiring cannot be unit-tested outside Pulsar, so this scans
// lib/mcp-registration.js for the wiring (same approach as mid-line-hint.delete-anchors.test.js). A live probe after
// a full Pulsar restart is still needed (delete a line of a scratch file with matchString, then restore it).
//
// What is pinned (Mode 5 only; Modes 1-4 and 6 are migrated in later, separate steps):
//   1. The delete registration declares features.structCheck:true (ctx.commit only runs it when the handler called
//      ctx.snapshotOriginal() first, so modes that are not migrated yet are unaffected).
//   2. Mode 5 takes ctx.snapshotOriginal() BEFORE buffer.deleteRows, then finishes through ctx.commit with
//      line: delStart + 1 and linesChanged: -deletedCount and the lint suffix it already computed.
//   3. Mode 5's dry run goes through ctx.dryRunReturn (payload fields unchanged).
//   4. Mode 5 no longer hand-rolls the tail: no decorateLine, no buildEditResponse, no manual hit bump, no manual
//      consec reset.
//   5. The return keeps the old result fields: dryRun:false, deleted:true, newLineCount, deletedCount.
//   6. Mode 5's failure paths are untouched (they still use buildFailResponse and their own stats keys).

const fs = require('fs');
const path = require('path');

let bad = 0, pass = 0;
function ok(label, cond, detail) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && detail !== undefined) console.log('      ' + detail);
}

const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
function seg(startMarker, endMarker) {
  const s = reg.indexOf(startMarker);
  if (s === -1) return null;
  const e = reg.indexOf(endMarker, s);
  return e === -1 ? null : reg.slice(s, e);
}

// 1. registration features ---------------------------------------------------------------------------------------
const head = (reg.match(/name:\s*'delete',[\s\S]*?title:\s*'Delete'/) || [null])[0];
ok('1 found the delete registration header', head !== null);
if (head) {
  ok('1 features still declare dryRun, lint and consecutiveFailureCounter', /features:\s*\{[^}]*dryRun:\s*true[^}]*\}/.test(head) && /features:\s*\{[^}]*lint:\s*true[^}]*\}/.test(head) && /features:\s*\{[^}]*consecutiveFailureCounter:\s*true[^}]*\}/.test(head), head);
  ok('1 features declare structCheck:true', /features:\s*\{[^}]*structCheck:\s*true[^}]*\}/.test(head), head);
}

// 2-6. Mode 5 segment ----------------------------------------------------------------------------------------------
const m5 = seg('// -- Mode 5: matchString', '// -- Mode 6: legacy positional');
ok('2 found the Mode 5 segment', m5 !== null);
if (m5) {
  const iSnap = m5.lastIndexOf('ctx.snapshotOriginal()', m5.indexOf('buffer.deleteRows(')); // the snapshot right before the whole-line delete (the fragment branch has its own)
  const iDel = m5.indexOf('buffer.deleteRows(');
  const iCommit = iDel === -1 ? -1 : m5.indexOf('await ctx.commit(', iDel); // the WHOLE-LINE commit (the fragment branch, step B 2026-11-13, has its own commit before it; see delete.fragment.test.js)
  ok('2 calls ctx.snapshotOriginal()', iSnap !== -1);
  ok('2 calls buffer.deleteRows(', iDel !== -1);
  ok('2 snapshot comes BEFORE the delete', iSnap !== -1 && iDel !== -1 && iSnap < iDel);
  ok('2 finishes through await ctx.commit(', iCommit !== -1);
  ok('2 commit comes AFTER the delete', iDel !== -1 && iCommit !== -1 && iDel < iCommit);
  const commitCall = iCommit === -1 ? '' : m5.slice(iCommit, m5.indexOf(';', iCommit) + 1);
  ok('2 commit meta carries line: delStart + 1', /line:\s*delStart\s*\+\s*1/.test(commitCall), commitCall);
  ok('2 commit meta carries linesChanged: -deletedCount', /linesChanged:\s*-deletedCount/.test(commitCall), commitCall);
  ok('2 commit passes the lint suffix it computed', /lint:\s*_lintSuffix\b/.test(commitCall), commitCall);
  ok('2 the lint suffix is still computed with maybeLintSuffix', /_lintSuffix\s*=\s*await\s+maybeLintSuffix\(/.test(m5));

  ok('3 dry run goes through ctx.dryRunReturn(', /if\s*\(dryRun\)\s*\{\s*return\s+ctx\.dryRunReturn\(/.test(m5));
  ok('3 dry run payload keeps dryRun:true, deleted:false, startLine, endLine, deletedCount', /dryRun:\s*true,\s*deleted:\s*false,\s*startLine:\s*delStart\s*\+\s*1,\s*endLine:\s*delEnd\s*\+\s*1,\s*deletedCount/.test(m5));
  ok('3 dry run message text is unchanged', m5.includes('will delete ${deletedCount} line(s) (lines ${delStart + 1}') && m5.includes('Context (- = lines to be deleted)') && m5.includes('Reply with the same call without dryRun'));

  ok('4 no hand-rolled decorateLine', !/decorateLine\(/.test(m5));
  ok('4 no hand-rolled buildEditResponse', !/buildEditResponse\(/.test(m5));
  ok("4 no manual hit bump (bump('delete', 'hits'))", !/bump\(\s*'delete'\s*,\s*'hits'\s*\)/.test(m5));
  ok('4 no manual consec reset after the delete', !/ctx\.consec\.count\s*=\s*0/.test(m5));

  ok('5 return keeps dryRun:false, deleted:true, newLineCount, deletedCount', /dryRun:\s*false,\s*deleted:\s*true,\s*newLineCount,\s*deletedCount/.test(m5.slice(iCommit === -1 ? 0 : iCommit)));
  ok('5 newLineCount is still read from the buffer', /newLineCount\s*=\s*buffer\.getLineCount\(\)/.test(m5));

  ok('6 failure paths keep buildFailResponse (scope error and no-match)', (m5.match(/buildFailResponse\(\{/g) || []).length === 2);
  ok('6 failure paths keep their own stats keys', m5.includes("'fails.anchorAmbiguous'") && m5.includes("'fails.anchorNotFound'"));
  ok('6 the S1 autoRescue:false guard is still there', /autoRescue:\s*false/.test(m5));
  ok('6 occurrence is still forwarded to the engine', /fuzzyContent,\s*occurrence,\s*autoRescue:\s*false/.test(m5));
}

console.log(pass + ' passed, ' + bad + ' failed');
if (bad) process.exitCode = 1;
}

// ===== delete.mode5-range =====
{
// Source-check test (2026-11-12) -- TODO R3a / H13, delete step A3: matchString + startLine/endLine means
// "match this text INSIDE that line range" (today Mode 5 ignores the range).
// Run from the package root:   node test/delete.mode5-range.test.js
// Plain node, no Pulsar, no files written. Handler wiring cannot be unit-tested outside Pulsar, so this scans
// lib/mcp-registration.js. The engine behaviour (range hint, errors) is covered by match-engine.line-range-hint.test.js.
// A live probe after a full Pulsar restart is still needed.
//
// Pinned:
//   1. Mode 5 passes startLine and endLine to resolveScope params.
//   2. Both logMatchFailure hints objects in Mode 5 carry startLine and endLine.
//   3. A range error from the scope engine is tallied like Mode 6: fails.inverted (reason inverted) and
//      fails.outOfRange (notOneBased / outOfRange / missingEnd); other scope errors keep anchorAmbiguous/anchorNotFound.
//   4. Mode 5 still surfaces the scope failure through buildFailResponse (prints anchorError message verbatim).
//   5. expectedContent stays a range-only option: Mode 5 does not read it.
//   6. The delete tool description no longer calls startLine/endLine LEGACY/LAST RESORT, no longer says scope hints are
//      ignored with startLine/endLine, and says matchString + startLine/endLine searches inside the range.

const fs = require('fs');
const path = require('path');

let bad = 0, pass = 0;
function ok(label, cond, detail) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && detail !== undefined) console.log('      ' + detail);
}

const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
function seg(startMarker, endMarker) {
  const s = reg.indexOf(startMarker);
  if (s === -1) return null;
  const e = reg.indexOf(endMarker, s);
  return e === -1 ? null : reg.slice(s, e);
}

const m5 = seg('// -- Mode 5: matchString', '// -- Mode 6: legacy positional');
ok('found the Mode 5 segment', m5 !== null);
if (m5) {
  // 1. resolveScope params
  const rs = m5.match(/resolveScope\(\{[\s\S]*?\}\);/);
  ok('1 Mode 5 calls resolveScope', !!rs);
  ok('1 resolveScope params include startLine', !!rs && /params:\s*\{[^}]*\bstartLine\b/.test(rs[0]), rs && rs[0]);
  ok('1 resolveScope params include endLine', !!rs && /params:\s*\{[^}]*\bendLine\b/.test(rs[0]), rs && rs[0]);

  // 2. logMatchFailure hints
  const lmf = m5.match(/logMatchFailure\(\{[\s\S]*?\}\);/g) || [];
  ok('2 Mode 5 has three logMatchFailure calls (scope error, fragment refusal since step B, content no-match)', lmf.length === 3, String(lmf.length));
  lmf.forEach((c, i) => {
    ok('2 logMatchFailure #' + (i + 1) + ' hints include startLine', /hints:\s*\{[\s\S]*\bstartLine\b/.test(c));
    ok('2 logMatchFailure #' + (i + 1) + ' hints include endLine', /hints:\s*\{[\s\S]*\bendLine\b/.test(c));
  });

  // 3. tally
  ok("3 tallies an inverted range as 'fails.inverted'", m5.includes("'fails.inverted'"));
  ok("3 tallies other range errors as 'fails.outOfRange'", m5.includes("'fails.outOfRange'"));
  ok("3 reads the engine's error reason", /_scope\.error\.reason/.test(m5));
  ok("3 keeps 'fails.anchorAmbiguous' and 'fails.anchorNotFound'", m5.includes("'fails.anchorAmbiguous'") && m5.includes("'fails.anchorNotFound'"));
  ok('3 scope error still counts toward the consecutive-failure counter', /_scope\.error\)\s*\{\s*ctx\.consec\.count\+\+/.test(m5));

  // 4. verbatim failure surface
  ok('4 scope failure goes through buildFailResponse with scope: _scope', /buildFailResponse\(\{[\s\S]*?scope:\s*_scope\b/.test(m5));

  // 5. expectedContent not used by Mode 5
  ok('5 Mode 5 does not read expectedContent', !/expectedContent/.test(m5));
}

// 6. description
const desc = seg("name:     'delete',", 'inputSchema:');
ok('found the delete description', desc !== null);
if (desc) {
  ok('6 no LEGACY/LAST RESORT wording', !desc.includes('LEGACY/LAST RESORT'));
  ok('6 no "ignored with startLine/endLine" wording', !/ignored with startLine\/endLine/.test(desc));
  ok('6 says matchString + startLine/endLine searches inside the range', /matchString[^"]*startLine[^"]*(inside|within)[^"]*range/i.test(desc) || /(inside|within) (that|the) (line )?range/i.test(desc));
  ok('6 says expectedContent is for a range on its own', /expectedContent[^"]*(range on its own|startLine\+endLine alone|without matchString|ignored when matchString)/i.test(desc));
}

console.log(pass + ' passed, ' + bad + ' failed');
if (bad) process.exitCode = 1;
}

// ===== delete.mode6-framework =====
{
// Source-check test (2026-11-12) -- TODO R3a / H13, delete step A2: Mode 6 (startLine + endLine, the match given by
// position) validated and resolved through the shared scope engine (resolveScope, see
// match-engine.line-range-hint.test.js) and moved onto ctx.commit. After this step NO delete mode keeps a hand-rolled
// commit tail.
// Run from the package root:   node test/delete.mode6-framework.test.js
// Plain node, no Pulsar, no files written. Handler wiring cannot be unit-tested outside Pulsar, so this scans
// lib/mcp-registration.js. A live probe after a full Pulsar restart is still needed.
//
// Pinned:
//   1. The range is resolved by resolveScope({ ... params: { startLine, endLine } }); a scope error is tallied
//      (fails.inverted for an inverted range, fails.outOfRange otherwise), counts toward the consecutive-failure
//      counter, and is surfaced with the engine's own message plus smartSuggestion. The hand-rolled validation
//      (startLine < 1, startLine > endLine, endLine > lineCount) is gone from the handler.
//   2. The optional expectedContent check is untouched (same stats key, same message).
//   3. The dry run returns through ctx.dryRunReturn, payload and text unchanged.
//   4. snapshotOriginal() BEFORE buffer.deleteRows, then await ctx.commit AFTER it with line: startLine,
//      linesChanged: -deletedCount, the lint suffix and the nudge text it already built (warnings.nudge wins over
//      successNudge in ctx.commit, so the wording and the "not content-verified" line are kept exactly).
//   5. No decorateLine, buildEditResponse, manual hit bump or manual consec reset left in Mode 6, and none anywhere in
//      the delete handler.
//   6. The return keeps dryRun:false, deleted:true, newLineCount, deletedCount, staleLinesWarning, contentVerified.

const fs = require('fs');
const path = require('path');

let bad = 0, pass = 0;
function ok(label, cond, detail) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && detail !== undefined) console.log('      ' + detail);
}

const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
function seg(startMarker, endMarker) {
  const s = reg.indexOf(startMarker);
  if (s === -1) return null;
  const e = reg.indexOf(endMarker, s);
  return e === -1 ? null : reg.slice(s, e);
}

const m6 = seg('// -- Mode 6: legacy positional', "name: 'get-selection'");
ok('found the Mode 6 segment', m6 !== null);
if (m6) {
  // 1. shared scope engine
  ok('1 resolves the range through resolveScope with params { startLine, endLine }', /resolveScope\(\{[\s\S]*?params:\s*\{\s*startLine,\s*endLine\s*\}/.test(m6));
  ok('1 handles a scope error (_rScope.error)', /if\s*\(\s*_rScope\.error\s*\)/.test(m6));
  ok("1 tallies an inverted range as 'fails.inverted'", m6.includes("'fails.inverted'"));
  ok("1 tallies the other range errors as 'fails.outOfRange'", m6.includes("'fails.outOfRange'"));
  ok('1 surfaces the engine message', /_rScope\.error\.message/.test(m6));
  ok('1 a scope error counts toward the consecutive-failure counter', /ctx\.consec\.count\+\+/.test(m6));
  ok('1 a scope error still appends smartSuggestion', /smartSuggestion\(/.test(m6));
  ok('1 no hand-rolled startLine < 1 check', !/startLine\s*<\s*1/.test(m6));
  ok('1 no hand-rolled startLine > endLine check', !/startLine\s*>\s*endLine/.test(m6));
  ok('1 no hand-rolled endLine > lineCount check', !/endLine\s*>\s*lineCount/.test(m6));
  ok('1 the "provide one of" message for a missing startLine/endLine is kept', m6.includes('Provide one of: banner, ifdefBlock, inFunction, startContent+endContent, matchString, or startLine+endLine.'));
  ok('1 rows come from the resolved scope', /searchStart/.test(m6) && /searchEnd/.test(m6));

  // 2. expectedContent untouched
  ok("2 expectedContent check keeps its stats key", m6.includes("'fails.expectedContentMismatch'"));
  ok('2 expectedContent check keeps its message', m6.includes('expectedContent mismatch') && m6.includes('do not contain'));

  // 3. dry run
  ok('3 dry run goes through ctx.dryRunReturn(', /if\s*\(dryRun\)\s*\{\s*return\s+ctx\.dryRunReturn\(/.test(m6));
  ok('3 dry run payload keeps dryRun:true, deleted:false, startLine, endLine, deletedCount', /dryRun:\s*true,\s*deleted:\s*false,\s*startLine,\s*endLine,\s*deletedCount/.test(m6));
  ok('3 dry run message text is unchanged', m6.includes('will delete ${deletedCount} line(s) (${startLine}\\u2013${endLine}).') && m6.includes('Context (- = lines to be deleted)') && m6.includes('Reply with the same call without dryRun'));

  // 4. commit
  const iSnap = m6.indexOf('ctx.snapshotOriginal()');
  const iDel = m6.indexOf('buffer.deleteRows(');
  const iCommit = m6.indexOf('await ctx.commit(');
  ok('4 calls ctx.snapshotOriginal()', iSnap !== -1);
  ok('4 calls buffer.deleteRows(', iDel !== -1);
  ok('4 snapshot comes BEFORE the delete', iSnap !== -1 && iDel !== -1 && iSnap < iDel);
  ok('4 finishes through await ctx.commit(', iCommit !== -1);
  ok('4 commit comes AFTER the delete', iDel !== -1 && iCommit !== -1 && iDel < iCommit);
  const commitCall = iCommit === -1 ? '' : m6.slice(iCommit, m6.indexOf(';', iCommit) + 1);
  ok('4 commit meta carries line: startLine', /line:\s*startLine\b/.test(commitCall), commitCall);
  ok('4 commit meta carries linesChanged: -deletedCount', /linesChanged:\s*-deletedCount/.test(commitCall), commitCall);
  ok('4 commit passes the lint suffix', /lint:\s*_lintSuffix\b/.test(commitCall), commitCall);
  ok('4 commit passes the nudge text it built (drift + unverified)', /nudge:\s*_driftNudge\s*\+\s*_unverifiedNudge/.test(commitCall), commitCall);
  // XW23 (2026-11-18): the Mode 6 nudges were shortened to one line each and made ASCII only; same advice, new wording.
  ok('4 the drift nudge text is kept', m6.includes('line numbers are positional and drift') && m6.includes('prefer inFunction, startContent+endContent or matchString.'));
  ok('4 the no-symbol-table wording is kept', m6.includes('no symbol table for this file type') && m6.includes('so prefer startContent+endContent or matchString.'));
  ok('4 the unverified nudge is kept', m6.includes('this delete was not content-verified') && m6.includes('pass expectedContent next time'));
  const _nudgeSrc = m6.slice(m6.indexOf('const _driftNudge'), m6.indexOf('const _commit6'));
  ok('4 the Mode 6 nudge text is ASCII only', _nudgeSrc.length > 100 && /^[\x00-\x7f]*$/.test(_nudgeSrc));
  ok('4 the lazy getSymbols lookup is kept (only for the positional path)', /getSymbols\(editor,\s*buffer\.getText\(\),\s*ctx\.filePath\)/.test(m6));
  ok('4 the lint suffix is still computed with maybeLintSuffix', /_lintSuffix\s*=\s*await\s+maybeLintSuffix\(/.test(m6));

  // 5. no hand-rolled tail
  ok('5 no hand-rolled decorateLine', !/decorateLine\(/.test(m6));
  ok('5 no hand-rolled buildEditResponse', !/buildEditResponse\(/.test(m6));
  ok("5 no manual hit bump (bump('delete', 'hits'))", !/bump\(\s*'delete'\s*,\s*'hits'\s*\)/.test(m6));
  ok('5 no manual consec reset after the delete', !/ctx\.consec\.count\s*=\s*0/.test(m6));

  // 6. return fields
  ok('6 return keeps dryRun:false, deleted:true, newLineCount, deletedCount', /dryRun:\s*false,\s*deleted:\s*true,\s*newLineCount,\s*deletedCount/.test(m6.slice(iCommit === -1 ? 0 : iCommit)));
  ok('6 return keeps staleLinesWarning and contentVerified', /staleLinesWarning:\s*_isPositional/.test(m6) && /contentVerified:\s*!\(\s*_isPositional\s*&&\s*expectedContent\s*===\s*undefined\s*\)/.test(m6));
  ok('6 newLineCount is still read from the buffer', /newLineCount\s*=\s*buffer\.getLineCount\(\)/.test(m6));
}

// 5b. the whole delete handler: no mode keeps a hand-rolled tail any more
const del = seg("name:     'delete',", "name: 'get-selection'");
ok('found the whole delete handler', del !== null);
if (del) {
  ok('5b no decorateLine( anywhere in the delete handler', !/decorateLine\(/.test(del));
  ok('5b no buildEditResponse( anywhere in the delete handler', !/buildEditResponse\(/.test(del));
  ok("5b no manual bump('delete', 'hits') anywhere in the delete handler", !/bump\(\s*'delete'\s*,\s*'hits'\s*\)/.test(del));
  ok('5b every mode commits through ctx.commit (6 call sites: modes 1/2, 3, 4, 5, 5 fragment (step B), 6)', (del.match(/await\s+ctx\.commit\(/g) || []).length === 6, String((del.match(/await\s+ctx\.commit\(/g) || []).length));
}

console.log(pass + ' passed, ' + bad + ' failed');
if (bad) process.exitCode = 1;
}

console.log = __log; console.log(__p + ' passed, ' + __f + ' failed');
