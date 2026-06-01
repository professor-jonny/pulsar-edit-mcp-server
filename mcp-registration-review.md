# Code Review — `mcp-registration.js`

Review date: 2026-06-01  
File: `lib/mcp-registration.js` (~6539 lines)

---

## 🔴 Bugs / Correctness

### L7 — `style-checker` import (verify first)
```js
const { checkLines: styleCheckLines, formatViolations: styleFormatViolations, isKernelFile } = require('./style-checker');
```
This import was previously identified as causing `ERR_MODULE_NOT_FOUND`, silently killing all non-Ghidra tool registration. Verify `style-checker.js` exists and exports these symbols. If not, this is the same root-cause bug as the 2026-05-31 outage.

### L1554 — Wrong `bump()` call signature in `find-text` ✅ Fixed
```js
bump('find_text', 'fails', 'noMatch');  // ❌ wrong
bump('find_text', 'fails.noMatch');     // ✅ correct
```
`bump(toolKey, subPath, n=1)` — the third argument is `n`, not a sub-key. As written, `'noMatch'` is passed as `n`, and the counter is never incremented. This explains why `find_text` shows 0 misses lifetime despite being used.

### L2068–2071 — Unconditional hint bumps in `delete-block` structural path
```js
if (sectionHint !== undefined || preprocBlock !== undefined) {
  bump('delete_block', 'hintsUsed.preprocBlock');  // bumped even when sectionHint was used
  bump('delete_block', 'hintsUsed.functionHint');  // bumped even when not provided
  bump('delete_block', 'hintsUsed.occurrence');    // bumped even when not provided
```
All three are unconditional. When `sectionHint` is used, `preprocBlock` is still counted. `functionHint` and `occurrence` are counted even when neither was passed. Inflates hint stats.

---

## 🟡 Reliability Issues

### L17 — `import` statement stranded after function declarations
```js
const IS_WINDOWS = ...   // L12
function getShell() { }  // L13–16
import { CompositeDisposable, Disposable } from "atom";  // L17 ← should be at top
```
`import` statements should appear at the top of the file. Babel silently reorders them but it's invalid ES module spec and a latent risk.

### L656–659 — `lintSnapshot` view mode not restored on throw
```js
if (lbUiPanel && origMode !== "file") lbUiPanel.viewMode = "file";
const lbResult = lbTool.execute();   // ← if this throws, viewMode is never restored
if (lbUiPanel && origMode !== "file") lbUiPanel.viewMode = origMode;
```
Needs a `try/finally` to guarantee restoration.

### L628–630 — `_failureSuggestion` is dead code ✅ Fixed
Removed.

### L480–492 — `_ANCHOR_DESC` constant is dead code ✅ Fixed
Removed.

### L1877 — `delete-line-range` accepts `filePath` param but never uses it
```js
filePath: z.string().optional(),  // in inputSchema
// handler never destructures or uses filePath
```
Misleads callers who pass it expecting it to target a different file. Either wire it up or remove from schema.

### L6220 — `curTool` shadowed inside `checkpatch` handler ✅ Fixed
Removed inner duplicate declaration.

### L2815 vs L2873 — `getShell()` returns `flag` that is never used ✅ Fixed
Now destructures `{ shell, flag }` and uses `flag` in `spawnArgs` instead of hardcoded strings.

### L6285–6286 — Duplicate comment ✅ Fixed
Removed duplicate line.

---

## 🟠 Maintainability / Refactoring

### Repeated lint suffix IIFE (8+ occurrences)
```js
const _lintSuffix = lint ? await (async () => {
  const snap = await lintSnapshot(editor, matchLine, endRow);
  return snap ? `\n${snap}` : "";
})() : "";
```
This pattern appears in `str_replace`, `insert` (×3), `delete-line-range`, `delete-block`, `replace-block`, `replace-function-body`. Extract to a module-level helper:
```js
async function maybeLintSuffix(lint, editor, startRow, endRow) {
  if (!lint) return "";
  const snap = await lintSnapshot(editor, startRow, endRow);
  return snap ? `\n${snap}` : "";
}
```

### `isCodeFile` regex duplicated 12+ times inline
```js
/\.(js|ts|jsx|tsx|c|cpp|h|cs|py|java|go|rs)$/i.test(editor.getPath() || "")
```
Repeated in every tool handler that needs it. Extract to a module-level helper function.

### `buildReport`/`summarise` logic duplicated between MCP handler and exported `getEditStats()`
The `summarise()` and `buildReport()` functions are closures inside the `get-edit-stats` MCP handler (L5902–6023) and cannot be shared. The exported `getEditStats()` function (L6398–6513) re-implements the same accumulation logic independently. This is ~150 lines of duplication. Extract both to module scope so `getEditStats()` can call them.

### `bump()` comment at L432 is inaccurate
```js
// instead we sync lifetime at the point of each direct editStats write by
// wrapping the flush into the reset handler.
```
This is not what happens. Lifetime sync occurs on: `setInterval` (every 5s), `get-edit-stats` call, flush events, and `deactivate`. It does not happen on each direct `editStats` write. The comment should be corrected to avoid misleading contributors.

### `findFunctionInBuffer` brace scanner ignores strings and comments (L961)
```js
for (const ch of lines[i]) {
  if (ch === "{") depth++;
  else if (ch === "}") { depth--; ... }
}
```
A `{` inside a string literal, comment, or regex will throw off the brace counter, potentially returning a wrong `endRow`. Low frequency in practice but worth an inline comment acknowledging the limitation, since `functionHint` scoping in `str_replace` depends on this being correct.

### Tool registration double-brace style is confusing on first read
```js
if (g('edit')) {
{                         // ← second brace to scope curTool
  const curTool = "str_replace";
```
The inner `{ }` blocks are valid JS scope — but the double opening brace reads like a mistake. Adding a section comment before each tool block would make structure clearer without changing behaviour.

---

## ✅ Things that are well done (no action needed)

- `smartSuggestion` + `ambiguityCheck` layered failure diagnostics are clean and production-quality
- `syncToLifetime` delta approach correctly avoids double-counting on concurrent writes
- `resolveStructuralAnchor` is well-commented and handles all three anchor types cleanly
- Flush redundancy (`setInterval` + `beforeunload` + `deactivate` + `process.on exit/SIGTERM/SIGHUP`) is good defensive programming
- `wrapHandler` pattern for fault visibility requires zero changes to individual tool handlers

---

## Priority Order for Fixes

| # | Priority | Issue | Location | Status |
|---|----------|-------|----------|--------|
| 1 | 🔴 Verify | `style-checker` import — confirm file exists | L7 | ✅ Verified — file exists, exports correct |
| 2 | 🔴 Fix | `bump('find_text', 'fails', 'noMatch')` wrong signature | L1554 | ✅ Fixed |
| 3 | 🔴 Fix | Unconditional hint bumps in delete-block structural path | L2068–2071 | ✅ Fixed — also fixed same issue in content-anchor path, added missing startContent bump |
| 4 | 🟡 Fix | `lintSnapshot` view mode not restored on throw | L656–659 | ✅ Fixed — wrapped in try/finally |
| 5 | 🟡 Fix | `import` statement after function declarations | L17 | ✅ Fixed — moved to top with other imports |
| 6 | 🟡 Remove | `_failureSuggestion()` dead shim | L628–630 | ✅ Fixed |
| 7 | 🟡 Remove | `_ANCHOR_DESC` dead constant | L480–492 | ✅ Fixed |
| 8 | 🟡 Fix | `delete-line-range` `filePath` in schema but not used | L1877 | ✅ Fixed — removed from schema |
| 9 | 🟡 Fix | `curTool` inner shadow in checkpatch handler | L6220 | ✅ Fixed |
| 10 | 🟡 Fix | `getShell()` `flag` unused in spawn | L2815/2873 | ✅ Fixed |
| 11 | 🟡 Fix | Duplicate comment | L6286 | ✅ Fixed |
| 12 | 🟠 Refactor | Extract `maybeLintSuffix` helper | Multiple | ⬜ Todo |
| 13 | 🟠 Refactor | Extract `isCodeFile` regex to module-level helper | Multiple | ⬜ Todo |
| 14 | 🟠 Refactor | Extract `buildReport`/`summarise` to module scope | L5902–6513 | ⬜ Todo |
| 15 | 🟠 Note | Fix inaccurate `bump()` comment | L432 | ✅ Fixed |
| 16 | 🟠 Note | Add comment to `findFunctionInBuffer` re: brace scanner limitation | L961 | ✅ Fixed |



### new things to refactor :


The main candidates:
1. sumFails(obj) helper — Object.values(x.fails).reduce((a,b)=>a+b,0) appears ~20 times in buildReport/summarise. A one-liner const sumFails = obj => Object.values(obj||{}).reduce((a,b)=>a+b,0) would tighten every failTotal line. Low effort, genuinely readable improvement.
2. applyStyleCheck(text, editor.getPath() || "") → applyStyleCheck(text, editor.getPath()) — editor.getPath() returns null for untitled files which applyStyleCheck already guards against internally. The || "" on every call site is defensive noise. Minor, but consistent.
3. The || {} safe-access pattern on optional tool keys — (stats.delete_block||{fails:{}}).fails||{} repeats throughout buildReport. The safeTool helper already exists in getEditStats for exactly this but isn't used in buildReport. Moving safeTool to module scope and using it in buildReport would clean up ~15 lines.
What's NOT worth doing: The Zod schema definitions (z.string().optional() etc.) — they're already in shared ANCHOR_SCHEMA constants at the top of the file, and individual tool schemas are necessarily different. No real duplication there.
The sumFails helper is the most impactful for the least risk — it would touch buildReport directly and make the intent clearer. Want to do that one, or leave it here?
