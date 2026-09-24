# pulsar-edit-mcp-server Ã¢â‚¬â€ Work Tracking

> Last audited against live code: 2026-09-20 (tool names, file list, B32 and the Command Output panel checked against the source; the older sections further down are dated history and were only annotated where a claim had become false Ã¢â‚¬â€ see the status notes in them). This file now tracks OPEN work only. Finished bugs/features (B18Ã¢â‚¬â€œB44, T1, T2, T3 (`delete-line-range`'s narrow fix and `delete_block`'s off-findAnchor migration, both since consolidated into the single `delete` tool Ã¢â‚¬â€ findAnchor is now fully retired, see CHANGELOG), T5, FILE_SCHEMA migration, functionEnd removal, multi-line anchor support, list-open-files field removal, the full str_replaceÃ¢â€ â€™insert Feature Parity Inventory, B24 items 7Ã¢â‚¬â€œ8, the read-file pagination fix, the `get-region`/`read-lines` Ã¢â€ â€™ `read` merge, S1 engine occurrence safety, S2/S2b/S2c/S2d `delete` `occurrence` forwarding, etc.) have been moved to `CHANGELOG.md` Ã¢â‚¬â€ check there for history/rationale on anything not listed below. **The `str_replace` port is designed but not started Ã¢â‚¬â€ see the B32 section (stage S4).**

## Files

- `lib/mcp-registration.js` Ã¢â‚¬â€ **~6850 lines.** Full Pulsar restart + babel cache clear required for registerTool/schema changes. Handler body changes hot-reload on save.
- `lib/edit-stats.js` Ã¢â‚¬â€ Stats counters, `bump()`, `summarise()`, `buildReport()`, `buildStyleReport()`, process exit hooks. Hot-reloads on save.
- `lib/tool-hints.js` Ã¢â‚¬â€ `anchorError()`, `smartSuggestion()`, `successNudge()`, `ambiguityCheck()`. **NOT on the hot-reload list Ã¢â‚¬â€ a change needs a full Pulsar restart.** Keyed on *live* tool names: after any tool rename or consolidation, grep `lib/*.js` for the old name as both a string literal and a table key (it was silently dead for `delete` for days after the 2026-09-17 consolidation Ã¢â‚¬â€ see CHANGELOG).
- `lib/tool-framework.js` Ã¢â‚¬â€ `makeRegisterMcpTool()` factory. `ctx`: editor, buffer, allLines, text, consec, fail(), commit(), dryRunReturn(), snapshotOriginal(). Hot-reloads on save.
- `lib/buffer-helpers.js` Ã¢â‚¬â€ `walkDir()`, `resolveStructuralAnchor()` (`sectionHint`/`preprocBlock`; called via `match-engine.js`'s `resolveScope()`, and an out-of-range `occurrence` now returns `{ambiguous:true, outOfRange:true}` instead of clamping), `findFunctionInBuffer()`, `readTextFromFile()`, `readFileOrBuffer()`, `retargetEditor()`, `checkStale()`, `recordKnownMtime()`. **NOT on the hot-reload list Ã¢â‚¬â€ a change needs a full Pulsar restart.** (`findAnchor()` retired 2026-09-17 Ã¢â‚¬â€ see CHANGELOG.)
- `lib/lint-helpers.js` Ã¢â‚¬â€ `maybeLintSuffix()`, `lintSnapshot()`. Hot-reloads on save. `lintSnapshot()` calls `linter-bundle`'s `GetLinterMessages` tool directly via its `filePath` filter (requires `linter-bundle` Ã¢â€°Â¥ 2.6.0).
- `lib/match-engine.js` Ã¢â‚¬â€ B24 universal match engine. `resolveScope()` (handles every scope hint incl. `sectionHint`/`preprocBlock`/`preprocSide`), `matchContent()`, `matchBlock()`, `matchFunction()`, `applyEdit()`, `buildMatchResponse()`, `buildFailResponse()`. Used by `insert`, `delete` (modes 1Ã¢â‚¬â€œ5), `read`, `replace-block`, `replace-function-body` and `apply-patch`'s hunk rescue. **Still hand-rolled and not yet on the engine:** `str_replace`, `sed`, `replace-all`, `replace-document` and `delete` Mode 4's `inFunction` `searchFrom` Ã¢â‚¬â€ porting them is the decided direction (see "B32" below). The header comment at L29Ã¢â‚¬â€œ36 still says `str_replace` is not migrated and is stale until that lands. Occurrence rule: `occurrence` is refused when out of range, never clamped, and is spent once (`scope.occurrenceConsumed`). Full babel-cache-clear + **full Pulsar restart** required for any change (not on the `bust()` list), same discipline as mcp-registration.js.
- `lib/search-engine.js` Ã¢â‚¬â€ read-side counterpart to match-engine.js (added 2026-07-19). `compilePattern()`, `scanLines()`. Zero Atom dependencies, same discipline as recover.js. Wired into `find-text`, `grep-file`, `grep-project`, `search-symbol` Ã¢â‚¬â€ see CHANGELOG.md v0.18.0. Hot-reloads on save *by itself*, but that's not sufficient Ã¢â‚¬â€ the four call sites live in mcp-registration.js, so any change to those tools' handlers still needs the full babel-cache-clear + Pulsar restart. A shared engine file has no effect until something calls it; adding this file alone did not change any tool's behavior, only wiring each handler onto it did.
- `lib/tool-catalogue.js` Ã¢â‚¬â€ `TOOL_CATALOGUE` and `TOGGLEABLE_GROUPS` static data. Hot-reloads on save.
- `lib/schema.js` Ã¢â‚¬â€ `ANCHOR_SCHEMA`, `STRUCTURAL_ANCHOR_SCHEMA` Zod schemas. Hot-reloads on save.
- `lib/edit-response.js` Ã¢â‚¬â€ `buildEditResponse()`, `preEditSnapshot()`, `postEditDelta()`. Auto-calls `checkStale()`/`recordKnownMtime()` on every commit. Hot-reloads on save.
- `lib/read-response.js` Ã¢â‚¬â€ `buildSearchResponse()`. Read-side counterpart to edit-response.js. Deliberately minimal (no save, no icon, no line-delta). Hot-reloads on save.
- `lib/struct-check.js` Ã¢â‚¬â€ `snapshot()`, `delta()`, `isStructFileType()` for structural integrity checks. Hot-reloads on save.
- `lib/recover.js` Ã¢â‚¬â€ `profileNeedle()`/`profiledMatch()`/`partialMatchRescue()` Ã¢â‚¬â€ combined-transform diagnosis and full-buffer drift rescue. Zero Atom dependencies. Consumed by `match-engine.js`'s `matchContent()`. Hot-reloads on save.
- `lib/style-checker.js` Ã¢â‚¬â€ Kernel C style rules, `applyStyleCheck()`, `isKernelFile()`. Hot-reloads on save.
- `lib/naming-checker.js` Ã¢â‚¬â€ `checkNaming()`, `checkFunctionDocs()`, `buildDocSkeleton()`. Hot-reloads on save.
- `lib/tree-sitter-symbols.js` Ã¢â‚¬â€ Tree-sitter symbol extraction + anchor resolution. Hot-reloads on save.
- `lib/string-utils.js` Ã¢â‚¬â€ Pure utilities: `escapeRegex`, `applyReplacement`, `globToRegex`, `levenshteinDistance`, `calculateSimilarity`. Hot-reloads on save.
- `lib/mcp-ignore.js` Ã¢â‚¬â€ `.mcp-ignore` glob rules, `shouldIgnore()`, `initMcpIgnore()`. Hot-reloads on save.
- `lib/pulsar-edit-mcp-server.js` Ã¢â‚¬â€ Main UI/activation file. Requires Pulsar reload for most changes.
- `lib/chat-panel.js` Ã¢â‚¬â€ Chat panel UI. Requires Pulsar reload (no hot-reload).
- `lib/chat-functions.js` Ã¢â‚¬â€ Chat LLM dispatch + tool call handling. Requires Pulsar reload.
- `lib/command-terminal-panel.js` Ã¢â‚¬â€ `CommandTerminalPanel`: the dockable **Command Output** pane (URI `atom://pulsar-edit-mcp-server/command-terminal`, default location bottom, also allowed left/right). Shows live `run-command` output and gives the *user* a stdin box (Enter/**Send**) plus a **Close stdin (EOF)** button, because a process blocked reading stdin is otherwise invisible and unanswerable to an LLM client and just hangs until the timeout. One instance is reused across runs; `run-command` calls `attachProcess(proc, {command, cwd})` to rebind it, and it exposes the same `appendOutput(text, type)` shape as `ChatPanel` so both panels get one call. Constructed in `pulsar-edit-mcp-server.js`'s opener and reached from `mcp-registration.js` through a *getter* (`() => commandTerminalPanelRef`), resolved fresh on every `run-command` call Ã¢â‚¬â€ a value captured once at registration time would stay `null` for the whole server session if the panel didn't exist yet. Opened once at activation (`activatePane:false`) so that reference is populated. Requires Pulsar reload (no hot-reload).
- `styles/pulsar-edit-mcp-server.less` Ã¢â‚¬â€ Stylesheet. Hot-reloads on save.

## TODO Ã¢â‚¬â€ Priority Order

| # | Priority | Item | Notes |
|---|---|---|---|
| 2 | Ã°Å¸â€“Â¼Ã¯Â¸Â HIGH | Session edit highlights | Persistent per-session gutter highlights showing what changed. Toggle in chat bar. Active-edit colour while in progress. Survives buffer reloads. See design below. |
| 3 | Ã°Å¸â€œÅ  MEDIUM | Show diff faults in stats window | Surface diff-fault breakdown in `get-edit-stats` per-rule as mini table. |
| 5 | Ã°Å¸â€Â¤ LOW-MEDIUM | Case-insensitive fuzzy matching in str_replace | 5th auto-retry block after partialMatch. Assess false-positive risk first. |
| 7 | Ã°Å¸â€“Â¼Ã¯Â¸Â MEDIUM | Inline diff in chat panel | Collapsible +N/-N block after each edit. `diff` lib already imported. Requires Pulsar reload. |
| 8 | Ã°Å¸Â§Âª MEDIUM | Automated testing + script runner (Tier 1/2/3) | See design below. |
| 10 | Ã°Å¸â€™Â¾ LOW | Disk-backed checkpoints | See design below. **Semi-redundant once #11 lands** Ã¢â‚¬â€ git checkout provides file recovery for closed files; in-memory checkpoints remain as fast undo fallback. Lower priority accordingly. |
| 11 | Ã°Å¸â€â‚¬ HIGH | Git integration Ã¢â‚¬â€ run-command auto-stage + finish-session commit | `run-command` runs `git add -A` after execution so git gutter tracks all file changes. `finish session` optionally commits with `mcp: session end` message. **Also solves backup/recovery** Ã¢â‚¬â€ staging before execution means any file the command touches (including closed files not open in a tab) is recoverable via `git checkout`. See design below. |
| 12 | Ã°Å¸â€“Â¼Ã¯Â¸Â MEDIUM | Command Output panel Ã¢â‚¬â€ show edit diffs | **Narrowed 2026-09-20 (PJ):** the show/hide toggle is dropped Ã¢â‚¬â€ `run-command` output now lives in its own dockable **Command Output** panel (`lib/command-terminal-panel.js`) that pops up by itself on every `run-command`, so there is nothing left to toggle. What remains is *diff output* there. **State of the code (verified 2026-09-20):** diffs are already computed at edit time (`diffLines` from the `diff` package, imported at `mcp-registration.js` L5), but nothing feeds them to a panel. The only two consumers today are (a) `decorateEditedLines()` (`mcp-registration.js` ~L7210), a transient editor-gutter highlight (8 s TTL, cleared on the next buffer change, no-op when the file has no open tab), and (b) `apply-patch`'s dry-run text snippet (~L5217, capped at 60 lines). A third `diffLines` call at ~L4974 (`apply-patch` `confirm:true` path) is dead code Ã¢â‚¬â€ it diffs `buffer.getText()` against `newText` read from the same buffer one line earlier, and `_diffHunks` is never used. **Integration point:** `CommandTerminalPanel.appendOutput(text, type)` already takes a line type, so diff lines could reuse the existing call shape; the panel's stylesheet (`styles/pulsar-edit-mcp-server.less` ~L458-465) only defines `stdout`/`stderr`/`info`/`stdin-echo`, so diff colouring (`+`/`-`/context) needs new `.command-terminal-diff-*` rules. **Design questions before building:** which edits emit a diff (every commit vs only dry-runs Ã¢â‚¬â€ dry-run previews already print their own diff into the LLM's reply); whether it goes to the Command Output panel, the chat panel, or both; and whether to reuse `ctx.commit()`'s `buildEditResponse` hook (`tool-framework.js` ~L537, where `decorateEditedLines` is already called for every framework tool) so all tools get it for free instead of per-handler wiring. See also #7 (inline diff in chat panel) and #18 (better diff tool), which overlap. |
| 13 | Ã°Å¸â€“Â¼Ã¯Â¸Â MEDIUM | Chat panel Ã¢â‚¬â€ bypass destructive edit confirmation | Button/toggle to allow destructive edits without manual confirmation. |
| 14 | Ã°Å¸â€“Â¼Ã¯Â¸Â LOW-MEDIUM | Chat panel Ã¢â‚¬â€ show LLM tool-support indicator | Display whether selected model supports tool use. |
| 15 | Ã°Å¸â€“Â¼Ã¯Â¸Â MEDIUM | Chat panel Ã¢â‚¬â€ cancel button | AbortController in chat-functions.js + cancel button in chat-panel.js. |
| 17 | Ã°Å¸â€Â§ MEDIUM | Split tools into named groups in enable-group UI | Surface edit/search/ghidra/file/diag/nav as labelled sections in the panel. |
| 18 | Ã°Å¸â€Â§ LOW-MEDIUM | Better diff tool | Side-by-side, syntax-highlighted, or collapsible hunks in chat panel or dedicated Pulsar pane. |
| 19 | Ã°Å¸â€“Â¼Ã¯Â¸Â MEDIUM | Chat panel Ã¢â‚¬â€ OpenAI-compatible server list | Add/remove/select LLM servers, remember API key and model per server. |
| 21 | Ã°Å¸â€Â§ LOW | Auto-close files on task end | Close MCP-opened files that were not open before the session started. |
| B12 | Ã°Å¸Ââ€º LOW | pulsar-edit-mcp-server.js Ã¢â‚¬â€ require('atom') crashes outside Pulsar | Both `pulsar-edit-mcp-server.js` (L10) and `mcp-registration.js` (L7) do a bare `require('atom')`. Blocks static analysis/CI. Fix: wrap in try/catch, fall back to a minimal stub. Not worth doing until a test harness exists (#8). |
| B20 | Ã°Å¸Ââ€º MEDIUM | mcp-registration.js Ã¢â‚¬â€ `afterLine` content miss logged as generic `noMatch`, root cause invisible | `afterLine:N` always succeeds (clamps to bounds). When `old_str` isn't found in the resulting window, it's logged as plain `noMatch` with no indication `afterLine` was the hint or that content drifted Ã¢â‚¬â€ masks the dominant fault cause (32/52 str_replace faults in lifetime stats). Fixes needed: (1) disambiguate fault log reason as `hintFault:afterLine:contentMiss`; (2) wire `scanForOldStr`/`_scopeBounds` for afterLine/afterString (currently only inFunction/betweenHint populate it); (3) successNudge should suggest the anchor line's content as `afterString`. Hot-reloads. |
| B22 | Ã°Å¸â€â€ž PARTIAL (str_replace done v0.15.2; insert's afterLine path done v0.15.5) | tool-framework.js Ã¢â‚¬â€ universal positional hint self-correction on success and failure | Positional hints (`afterLine`, `beforeLine`, `onLine`) succeed silently even at stale positions. Needs framework-level `positionalHints` array + `activeHint` passed to `ctx.commit()`/`ctx.fail()`. **str_replace DONE.** **insert's afterLine path DONE** (v0.15.5 Ã¢â‚¬â€ deliberately targeted first since `insert` is low-traffic, safer to prove the pattern there before touching the heavier delete path; `delete`'s own hand-rolled drift-nudge (then still `delete-line-range`) was separately fixed under B32, not via this framework gating). **Still to do (re-verified 2026-09-20 against the `features:{}` blocks):** `replace-block`, `replace-function-body` and `delete` (the consolidated tool that replaced `delete-block`/`delete-line-range`) still have neither `successNudge` nor `structCheck` Ã¢â‚¬â€ only `insert` does. |

---

### Post-edit structural integrity checks

**Tier 1** Ã¢â‚¬â€ `struct-check.js` already exists: brace/bracket/paren balance, unclosed block comment, `#if`/`#endif` balance. Currently wired to `str_replace` and (via `features.structCheck`) `insert`'s `insert_line` path. Wire to remaining commit sites via Tool Framework `ctx.commit()`.

**Tier 2** Ã¢â‚¬â€ Token-stream state machine: missing `break` in switch, keyword not followed by brace, unreachable code after `return`, duplicate `case` values. ~15 token types, no AST.

**Tier 3** Ã¢â‚¬â€ `verify-file` tool: full-buffer struct + linter + style + compiler diagnostics in one call. Delta-only: warn only on new issues vs pre-edit snapshot.

---

### Ã°Å¸â€“Â¼Ã¯Â¸Â HIGH Ã¢â‚¬â€ Session edit highlights

Persistent per-session gutter decorations showing everything the LLM changed, surviving buffer reloads.

**Colours (3 states):**
- `mcp-session-added` Ã¢â‚¬â€ soft green, permanent, marks added/changed lines this session
- `mcp-session-removed` Ã¢â‚¬â€ soft red, permanent, marks removed-line positions this session
- `mcp-session-editing` Ã¢â‚¬â€ amber/yellow, transient, shown on target region while an edit is in progress

**Persistence across buffer reloads:**
- Module-level `sessionHighlightRanges` Map Ã¢â‚¬â€ `filePath Ã¢â€ â€™ [{ fromRow, toRow, kind }, ...]`
- `decorateEditedLines()` with `permanent:true` writes to this store as well as painting markers
- `atom.workspace.onDidAddTextEditor()` hook Ã¢â‚¬â€ on file open, repaint any stored ranges for that path

**Toggle button in chat bar (`chat-panel.js`):**
- Button next to Clear Ã¢â‚¬â€ reads/writes `atom.config.get/set('pulsar-edit-mcp-server.sessionHighlights')`

**CSS:** `mcp-session-added-gutter` rgba(80,200,120,0.15) green, `mcp-session-removed-gutter` rgba(240,80,80,0.15) red, `mcp-session-editing-gutter` rgba(220,180,50,0.35) amber.
**this will likely be redundant by git integration**

---

### Ã°Å¸â€“Â¼Ã¯Â¸Â MEDIUM Ã¢â‚¬â€ Inline diff in chat panel

Collapsible `+N -N` block in chat after each edit. `diff` library already imported. `chat-functions.js` + `chat-panel.js` only. Requires Pulsar reload.
**this will likely be redundant by git integration**

---

### Ã°Å¸â€™Â¾ LOW Ã¢â‚¬â€ Disk-backed checkpoints

`checkpoint-to-disk name` / `restore-from-disk name`. Snapshot = file path + text Ã¢â€ â€™ `.mcp-checkpoints/<n>-<timestamp>.json`. ~40 lines. In-memory checkpoints stay as fast fallbacks.
**this will likely be redundant by git integration**

---

### Ã°Å¸â€â‚¬ HIGH Ã¢â‚¬â€ Git integration

**run-command auto-stage:** After every `run-command`, run `git add -A`. Git gutter lights up vs HEAD. No commit. Degrade gracefully if no git repo.

**Pre-execution stage (backup/recovery):** Before running the command, run `git add -A` so that the pre-command state is staged. Any file the command modifies (including files not open in Pulsar tabs) is then recoverable via `git checkout -- <file>` or `git stash`. This supersedes the stale-file-context (#3) approach Ã¢â‚¬â€ that approach was unworkable because `run-command` can write to files the editor has never seen.

**finish-session commit (optional):** `get-edit-stats reset:true` optionally runs `git add -A` + `git commit -m "mcp: session [N] end [timestamp]"`. Config toggle: `autoCommitOnFinish` (default false).

---

### Ã°Å¸Â§Âª MEDIUM Ã¢â‚¬â€ Automated testing + script runner

**Tier 1** Ã¢â‚¬â€ Script runner: Node.js CLI posts steps from a `.json` script to `localhost:PORT`. Asserts: `exitCode`, `messageCount`, `matched`, `contains`.

**Tier 2** Ã¢â‚¬â€ In-process harness: `callTool(name, args, mockEditor)` bypasses HTTP. Lives in `spec/`.

**Tier 3** Ã¢â‚¬â€ Named procedures: variable substitution (`{{file}}`), `on_fail`, conditionals. Invokable via `@//` shortcuts.

---

## Architecture Ã¢â‚¬â€ Universal Match Engine (B24)

> Prerequisite for T1/T2/T3. Build this first.

### The problem
Every edit tool reimplements the same pipeline privately. Only str-replace received investment. Result: str-replace works well, everything else diverged and fell behind.

### The pipeline - same for every tool
- Step 1 READ: get buffer, allLines, text
- Step 2 SCOPE: resolveScope(buffer, params) - reads inFunction, afterString, beforeString, afterFunction, betweenHint, afterLine, beforeLine. Returns searchStart, searchEnd, scopeLabel, _hasScope.
- Step 3 MATCH: matchContent(needle, buffer, scope, opts) - upfront similarity scan, no fail-first. exact(1.0) then trim(0.95) then norm-unicode(0.90) then reject. Classifies ALL differences in one pass - handles mixed issues (indent + unicode on same line). Returns matched, matchIndex, matchLine, effectiveNeedle, transforms[], ambiguousMatches[].
- Step 4 EDIT: applyEdit(buffer, matchResult, newStr) - returns linesChanged, newLineCount.
- Step 5 RESPOND: buildMatchResponse(tool, match, edit, opts) - calls buildEditResponse + successNudge + smartSuggestion + scanForOldStr diagnostics on failure.

### Every tool handler becomes ~30 lines
`javascript
const scope = resolveScope(buffer, params);
const match = matchContent(params.old_str, buffer, scope, opts);
if (!match.matched) return buildFailResponse(tool, match, ctx);
const edit  = applyEdit(buffer, match, params.new_str);
return buildMatchResponse(tool, match, edit, { lint, style, ctx });
`

### Files
- new lib/match-engine.js (~280 lines) - resolveScope, matchContent, applyEdit, buildMatchResponse, buildFailResponse
- update lib/string-utils.js - add normUnicode() extracted from str-replace private _norm
- update mcp-registration.js - refactor str-replace onto engine (~-350 lines net)
- new tools block-edit, block-delete, invested insert - built on engine from day one, get fuzzy matching + unicode normalisation + ambiguity check + scanForOldStr diagnostics for free

## B32 Ã¢â‚¬â€ port `str_replace` (and every hand-rolled tool) onto the match engine Ã¢â‚¬â€ DECIDED 2026-09-20, IN PROGRESS (S1, S2, S2b/c/d done; S3 helper done but not wired; S4-1 and S4a done and live-verified; S4b done as a pure addition (not live-restart-tested, nothing calls it yet); S4c PARTIALLY done Ã¢â‚¬â€ see updated S4c bullet; S4d done and live-verified after a restart Ã¢â‚¬â€ see updated S4d bullet; S4e: all three planned sections wired and live-verified after a restart, but str_replace is still a hybrid and NOT fully ported to the engine (its commit, non-plain matching and failure builder are still hand-rolled; see the S4e status bullet) (Section 2 wired 2026-09-23; the str_replace allSymbols unsaved-edits bug it left behind fixed and verified 2026-09-24) Ã¢â‚¬â€ see updated S4e bullet)

> **This section supersedes the 2026-09-17 "do not port str_replace" ruling.** PJ chose universality: make the match engine the single implementation, port `str_replace`, `sed`, `replace-all`, `replace-document` and `delete` Mode 4's `inFunction` onto `resolveScope()` Ã¢â€ â€™ `matchContent()`/`matchBlock()`/`matchFunction()` Ã¢â€ â€™ `applyEdit()` Ã¢â€ â€™ `buildFailResponse()` behind their **existing names and registrations**, then **delete all the hand-rolled matching code**. The old finding and decision are kept below as history Ã¢â‚¬â€ the gap analysis is still correct; what changed is the weighting of "dedup only" against "one implementation to maintain and one place for every safety rule to live".
>
> **Why it became possible now:** an audit established `resolveScope()` already handles *every* scope hint including `sectionHint`/`preprocBlock`/`preprocSide`, so the scope-level gap is closed. What blocked the port was engine **safety**: `str_replace` refuses an out-of-range `occurrence` but the engine used to clamp it, so a straight port would have made the highest-traffic tool *less* safe. That is stage S1 Ã¢â‚¬â€ done.
>
> **Direction refined 2026-09-20 (PJ): `str_replace` is the REFERENCE implementation, and the engine grows to contain what it does.** Where the engine and `str_replace` disagree, the engine changes, not `str_replace`. The goal is one universal set of starts, scopes, diagnostics and failure messages for every tool, so any two tools can be compared like for like. `str_replace` is switched onto the engine last, and its hand-rolled path stays in place as the control until then. The engine is not yet a superset of it Ã¢â‚¬â€ see stage S4 below for the gaps.

### Stages (each: prove on one tool Ã¢â€ â€™ full Pulsar restart Ã¢â€ â€™ verify live before widening; every prior stage found one new bug per restart cycle)

- **S1 Ã¢â‚¬â€ engine occurrence safety. DONE, live-verified 2026-09-20** (see CHANGELOG). Out-of-range `occurrence` is refused at all six clamp sites, never clamped; `occurrence` is spent once via `scope.occurrenceConsumed`; `delete` Modes 4/5 pass `autoRescue:false`; `delete`'s `matchString` failures are now counted (`fails.anchorAmbiguous`/`anchorNotFound`). 23/23 in `test/s1_occurrence_test.js`.
- **S2 Ã¢â‚¬â€ DONE, live-verified 2026-09-20.** `delete` Mode 5 (`matchString`) forwards `occurrence` into `matchContent`. **S2b/S2c/S2d Ã¢â‚¬â€ DONE, live-verified 2026-09-20.** `delete` Mode 4 (`startContent`/`endContent`): `occurrence` reaches the start match (S2b); the end match takes the nearest closer at or after the start (S2c); an out-of-range start occurrence uses the shared `buildFailResponse` wording (S2d). Detail in CHANGELOG. One finding: in Mode 4, `inFunction` does not consume `occurrence` (its `searchFrom` comes from a hand-rolled `findFunctionInBuffer`, not `resolveScope`), so `occurrence` counts `startContent` hits from the function's first row, not "the Nth function". Decide the semantics when S4 ports that `searchFrom`.
- **S3 Ã¢â‚¬â€ identifier-boundary guard for sub-line matches. DONE as a standalone helper, NOT WIRED into any tool (2026-09-20).** `lib/identifier-boundary.js` (`isIdentChar`, `checkIdentifierBoundary`, `scanLineForFragments`) + `test/s3_identifier_boundary_test.js` (23/23; negative control: 7/23 fail with the left check disabled). It answers only "is this hit inside a longer identifier?" Ã¢â‚¬â€ refuse-vs-warn and the escape hatch belong to the caller. PJ decision: a safety guard only; part-line search/replace as a *new feature* for other tools was rejected as too messy (`str_replace`'s existing single-line fragment editing is proven and stays). **The `count`-inside-`discount` hazard on `str_replace`'s plain single-line branch (~L655, `includes()`) is still live** until the helper is wired in during S4b. The engine has no sub-line matching yet (`matchContent`/`scanBlock` compare whole lines), which is why it was built as a helper first.
- **S4 Ã¢â‚¬â€ make the engine a superset of `str_replace`, then switch it over. S4-1 and S4a DONE and live-verified; S4b done as a pure addition (not wired); S4c PARTIALLY done (see bullet below); S4d DONE and live-verified after a restart (see bullet below); S4e: all three planned sections DONE and live-verified after a restart, but str_replace is still a hybrid and NOT fully ported to the engine (see the S4e status bullet below) (Section 2 wired 2026-09-23; the str_replace allSymbols unsaved-edits bug it left behind fixed and verified 2026-09-24) (see bullet below).** Split into sub-stages so one live check can tell you which piece broke. Findings behind it are in the session notes (S4 design comparison). Summary: the rescue system was a pure duplicate of `lib/recover.js` (S4a closed this Ã¢â‚¬â€ `str_replace` now calls `recover.js` directly); scope resolution is still a duplicate with real differences; the commit path is *different* (`applyEdit` replaces whole rows, `str_replace` replaces an exact character span); the failure builder in `str_replace` (~260 lines) is far richer than the engine's. `str_replace` has 662+ lifetime hits and is the reference, so it is switched onto the engine LAST.
  - **S4-0 Ã¢â‚¬â€ stats schema.** Add `hintsSucceeded`, `hintsFailed`, `faultBuckets` and `fuzzyTriggerReasons` to the other edit tools' blocks in `edit-stats.js` (today only `str_replace` has them; every edit tool already has the full `hintsUsed` set). `bump()` to a missing key is a silent no-op, so this must precede any shared code that bumps them; test the missing-key case explicitly and watch the lifetime-merge path (known doubled-counter issue). *Only needed if universal counters are wanted Ã¢â‚¬â€ see open question 2.*
  - **S4-1 Ã¢â‚¬â€ diagnostics (FIRST real change).** Extract `str_replace`'s failure diagnostics (`mcp-registration.js` ~L1006Ã¢â‚¬â€œ1266) as a pure engine module: whitespace-vs-encoding classification, consecutive-leading-lines partial-match count, closest-area word match with Ã‚Â±4 lines of context, Levenshtein similarity with its three advice tiers (Ã¢â€°Â¥80 / Ã¢â€°Â¥50 / low), the `afterLine`/`beforeLine` drift nudge, and the full-file `scanForOldStr` messages (NOT FOUND ANYWHERE / MATCH LOCATION FOUND inside scope / FOUND OUTSIDE SCOPE). The module *returns* a classification and each tool bumps its own counters. `buildFailResponse` calls it. Additive: only error text changes, no matching/scope/commit change. `str_replace`'s own copy stays in place as the control and its output is compared against the engine's for the same failing call. Pure functions, unit-tested in plain Node with a negative control (like S1/S3).
  - **S4a Ã¢â‚¬â€ rescue. DONE, live-verified 2026-09-22 after a restart.** Pointed `str_replace`'s inline auto-retry (was L743Ã¢â‚¬â€œ1000: `_norm`, `_profileScan`, trailing-comment strip, B41 guards, partial-match rescue) at `lib/recover.js`. Net line count is NOT a clean ~250-line reduction as originally estimated: the inline profiling/rescue head was deleted and replaced with a `profiledMatch()` call, but the `partialMatchRescue()` call had to be re-added as its own ~33-line block after an intermediate edit accidentally dropped it along with the duplicate code Ã¢â‚¬â€ caught before commit via a live functional test, not by inspection. The caller kept its stat bumps and the `/* CHECK: Ã¢â‚¬Â¦ */` comment append, exactly as planned (`recover.js` returns tags and `salvagedComment` rather than mutating state). A real syntax bug (orphaned braces from the old block's deeper nesting) was introduced and fixed during the edit Ã¢â‚¬â€ see CHANGELOG for the full story. All 5 of `profiledMatch`/`partialMatchRescue`'s branches (comment-strip, fuzzyWhitespace, fuzzyContent/encoding, partial-match, ambiguity guard) live-verified individually against the real edited file, not just via `test/_s4a_parity_probe.js`'s 13/13 (which tests `recover.js` against a re-implementation, not this integration). `partialMatchRescue` matching OUTSIDE the resolved scope was NOT separately re-checked against `outsideScope` handling this round Ã¢â‚¬â€ worth confirming before S4b.
  - **S4b Ã¢â‚¬â€ span match. DONE as a pure addition, 2026-09-22 Ã¢â‚¬â€ NOT live-restart-tested (nothing calls it yet).** Built as `lib/fragment-match.js` (`matchFragment`) + `applyEditSpan` in `lib/match-engine.js`, exported alongside `applyEdit`. Shape chosen: ROW + COLUMN (`{row, startCol, endCol}`), not a global buffer-text character offset Ã¢â‚¬â€ verifies/relocates against `buffer.getLines()` directly, matching every other engine shape (`matchLine`/`matchEndLine`/`startRow`/`endRow`) and needing no text-vs-lines offset math; this choice does not require open question 1 (rows vs. characters in `resolveScope`) to be settled first, since that question is about the scope-window layer and `matchFragment` still consumes row bounds from a resolved scope. `applyEditSpan` reproduces `applyEdit`'s B39/B40 shape (drift relocate Ã¢â‚¬â€ same-row rescan first, then full-buffer search Ã¢â‚¬â€ then byte-for-byte re-verify immediately before write) in span terms. The S3 guard (`checkIdentifierBoundary`) IS wired in as `matchFragment`'s default behavior (`guardIdentifier:true` excludes glued hits from the candidate set) Ã¢â‚¬â€ **DECIDED 2026-09-22, see open question 4 above**: refuse over warn, glued-among-clean hits are filtered (not refuse-and-list), `guardIdentifier:false` is the named escape hatch. Fake-buffer unit tests: `test/s4b_fragment_match_test.js`, 29/29, fake buffer is a plain object with `getLines`/`setTextInRange`/`getLineCount` (no `getText` needed Ã¢â‚¬â€ the row+column shape never required it). All 5 standing tests re-run clean (88/23/23/0-fail/34). NOT wired into any registered tool Ã¢â‚¬â€ `str_replace`'s plain single-line branch still uses `.includes()` with no identifier guard, unchanged.
  - **S4c Ã¢â‚¬â€ scope. PARTIALLY DONE Ã¢â‚¬â€ confirmed live in mcp-registration.js, 2026-09-23.** `str_replace` already has `sectionHint`/`preprocBlock`/`preprocSide` (schema L253Ã¢â‚¬â€œ255, per that file's own comment: added this session), `logHintFailure` calls throughout every hint branch, `fails.outOfScope`/`fails.afterNotFound` stat naming, and occurrence-on-hint handling per branch. `fuzzyWhitespace` forwarding to `resolveStringPosition` FIXED 2026-09-23 (L407 now passes `{ fuzzyWhitespace }`, matching the engine). Confirmed still missing: `str_replace` still does not call `resolveScope()` itself Ã¢â‚¬â€ its L294Ã¢â‚¬â€œ435 block is a complete parallel hand-rolled implementation, not a delegate, so the "Known functions:"/"Known symbols:" listings and ambiguity messages are still duplicated by hand. This is now the only remaining S4c gap, and it's structural enough that it should probably fold into S4e's switch-over rather than stay a separate stage. Needs the rows-vs-characters decision Ã¢â‚¬â€ DECIDED 2026-09-22, see open question 1: rows.
  - **S4d Ã¢â‚¬â€ dry-run preview. DONE, live-verified after a restart, 2026-09-23.** `buildReplacePreview({ allLines, lineCount, matchLine, matchLines, new_str, scopeLabel, tags })` added to `match-engine.js` directly after `buildInsertPreview`, exported alongside it. Same context-window convention (`radius = 3`, `Ã¢ÂÂ¯` marker on matched rows), diff built from `matchLines`/`new_str` the same way `str_replace`'s hand-rolled block does, tags passed as a `string[]` instead of a hand-built ternary chain. Returns the same `{content, matched:true, dryRun:true, matchLine}` shape `buildMatchResponse`'s dry branch uses. Confirmed via `grep-project` before the restart that it had zero callers anywhere in `lib/` (pure addition, same status as S4b at the time); all 6 standing tests (the original 5 plus S4b's) passed both before and after a user-initiated restart, with `get-diagnostics` confirming the file reloaded clean. A new functional test (`test/s4d_replace_preview_test.js`, 16/16) calls the real live function directly Ã¢â‚¬â€ not a re-implementation Ã¢â‚¬â€ and checks the exact rendered output (marker placement, header wording, diff lines) for both single- and multi-line matches. **Not done:** no negative-control test yet; still not wired into any tool (`str_replace`'s own hand-rolled preview block is unchanged); whether to wire it into `str_replace` now versus waiting for the full S4e switch is an open question.
  - **S4e Ã¢â‚¬â€ switch. Section 1 (dry-run preview) DONE and live-verified after a restart, 2026-09-23. Section 3 (fragment match+commit) DONE and live-verified after a restart, 2026-09-24 -- see CHANGELOG for two bugs found+fixed this pass. Section 2 (scope resolution) DONE, wired 2026-09-23 and live-verified -- see the Section 2 and allSymbols bullets below and the top CHANGELOG entry.** The user authored `s4e/S4E_DESIGN.md` splitting the switch-over into three independent, separately-revertible pieces: Section 1 (dry-run preview Ã¢â€ â€™ `buildReplacePreview`), Section 2 (scope resolution Ã¢â€ â€™ `resolveScope`), Section 3 (plain single-line match+commit Ã¢â€ â€™ `matchFragment`+`applyEditSpan`, closing the S3 count/discount hazard). Two confirmed bugs were found and fixed in the drafts before any wiring: Section 3 imported `matchFragment` from the wrong module (`./match-engine` instead of `./fragment-match`); Section 2 used non-uniform message wording per hint-type incorrectly (v1 used one generic builder; the real tool's wording differs across `inFunction`/`afterFunction`+`beforeFunction`/`afterSymbol`+`beforeSymbol`/`afterString`+`beforeString`) and destructured a nonexistent `candidates` field off `scope.error` (real field is `raw`). Both open policy questions were answered by the user: Section 1's dry-run byte-change (`?`Ã¢â€ â€™`Ã¢ÂÂ¯` marker, header text) approved; Section 3's two-hits-per-line counting (`matchFragment` counts overlapping same-line hits separately, unlike `str_replace`'s old `.includes()` presence-only check) confirmed as correct going forward. All 3 sections unit-tested clean (33/10/10) against real or mocked engine code before any wiring began.
    - **Section 1 wiring Ã¢â‚¬â€ DONE, live-verified after a restart, 2026-09-23.** Re-grepped `mcp-registration.js` for current line numbers (`str_replace` now spans ~222Ã¢â‚¬â€œ1320; dry-run block at 1121Ã¢â‚¬â€œ1142 Ã¢â‚¬â€ drifted from the design doc's citations as expected). Added `require('./_s4e_section1_preview')` after the existing `recover.js` require, replaced the hand-rolled dry-run block with a call to `buildDryRunResult({...})`. Bug found: the draft module only existed at `s4e/_s4e_section1_preview.js` in the project root, not at `lib/` where the require path resolves Ã¢â‚¬â€ fixed via `copy-file` into `lib/` (the `s4e/` original is now a stale duplicate, not yet deleted). `node --check` clean; a whole-file `check-struct` brace-imbalance flag was traced and dismissed as the same heuristic noise documented under S4a. After a full restart: `get-diagnostics` 0/0/0, all 7 standing tests clean (88/23/23/0-fail/34/29/16, no regressions), and a real live `dryRun:true` call plus a real non-dry-run commit against a scratch fixture both confirmed the expected `Ã°Å¸â€Â DRY RUN`/`Ã¢ÂÂ¯` output end-to-end through the actual edited code Ã¢â‚¬â€ not just syntax-checked.
- **Section 3 wiring -- DONE, live-verified after a restart, 2026-09-24.** Re-applied Section 3's require/`guardIdentifier` schema+handler param/`tryPlainFragmentMatch` call after finding the wiring had dropped out of `mcp-registration.js` from an earlier session (the standalone `lib/_s4e_section3_fragment.js` module and its unit test survived untouched; only the registration-side integration was missing). A new bug was found and fixed during this re-wire -- an illegal `const` reassignment (`allOccurrenceLines`) that crashed `str_replace` globally on any file, not just the guarded case -- see CHANGELOG for the full story, including how it also caused two apparently-successful edit attempts to silently not persist. All 5 of the design doc's live scenarios (identifier-glue refusal, `guardIdentifier:false` escape hatch, plain unaffected match, ambiguous refusal listing both lines, `occurrence:N` resolution) confirmed working after the corrective restart. Standing suite re-run clean at every stage.
- **Section 2 -- DONE, wired 2026-09-23 and live-verified.** `resolveStrReplaceScope()` (`lib/_s4e_section2_scope.js`, v3, 322 lines; the `s4e/` copy is the older v2 draft) replaced str_replace's ~145-line hand-rolled scope chain in `mcp-registration.js` (require ~L27, call ~L302). v3 rebuilds each hint type's SUCCESS `scopeLabel` to match str_replace's prior wording (v2 only verified failure-path wording; wiring it as-is would have silently changed every success message), and the caller passes `resolvedRadius: HINT_RADIUS` on purpose to reproduce a known label quirk. Live bug found and fixed: str_replace defaults `occurrence = 1`, but `resolveScope()` treats any non-null occurrence as an explicit pick, so an ambiguous `inFunction`/`afterFunction`/`afterSymbol` hint (two functions named `beta`) was silently resolved to the first match; now only forwarded when > 1 (`scopeOccurrence`, ~L113 of the module). Live-verified after a restart (ambiguous refusal, `occurrence:2` narrowing, unique hint still resolving). No dedicated Section 2 test file exists -- the 213/213 figure is the sum of the 7 standing suites. Earlier docs (including older text in this file and CHANGELOG) that say Section 2 is "not yet wired" are stale.
- **S4e follow-up bug -- `str_replace` allSymbols ReferenceError. FIXED and live-verified after a restart, 2026-09-24.** The Section 2 rewire removed the only `const allSymbols = getSymbols(...)` in str_replace's handler, but the success path still passes `symbols: allSymbols` to `successNudge()`. Every committed (non-dry-run) str_replace therefore threw AFTER `buffer.setTextInRange()` and BEFORE `buildEditResponse()` (which is what saves), so edits landed in the buffer but never on disk. Dry runs return earlier, so Section 2/3 dry-run verification never hit it. Fix: `const allSymbols = getSymbols(editor, text, ctx.filePath);` after the `isCodeFile` line in the handler (~L298). str_replace was never missing an auto-save (it saves via `buildEditResponse({..., buffer})`, `edit-response.js` ~L93-95); an earlier session note claiming otherwise was wrong. Verified: two real non-dry-run commits (scoped and unscoped) with disk read-back, all 7 standing suites 213/213, `lib/test_s4e_section1.js` 10/10, `lib/test_s4e_section3.js` 10/10.
- **S4e status -- what "done" means (2026-09-24): the three planned sections are wired, str_replace is NOT fully on the engine.** Checked by grep of str_replace's handler (~L272-1155 of `mcp-registration.js`). On the engine now: scope resolution (Section 2, `resolveStrReplaceScope`), dry-run preview (Section 1, `buildDryRunResult`), plain single-line match with the identifier-glue guard (Section 3, `tryPlainFragmentMatch`), and the rescue paths (S4a, `recover.js`). Still hand-rolled inside str_replace: (1) the commit itself -- a character-index splice via `buffer.setTextInRange` (~L1105); Section 3 is match-detection only by design and `applyEdit`/`applyEditSpan` are not used; (2) all non-plain matching (multi-line, regex, fuzzy) -- only the plain single-line case goes through `matchFragment`; (3) str_replace's own failure/diagnostic builder (~260 lines) -- there are no `buildFailResponse` or `matchContentEngine` calls inside its handler, those live in `insert`/`delete`/`replace-block` and the other tools. Per this plan the hand-rolled branch stays as the live control until a live diff shows the engine reproduces it. Scope note: `s4e/S4E_DESIGN.md` explicitly puts items (2) and (3) (non-plain matching and str_replace's own failure builder), plus the nudges/bump() instrumentation, OUT of S4e's scope -- porting them would be a new stage, not unfinished S4e. What is genuinely open inside S4e is item (1), Section 3's commit half: the design says `matchFragment` + `applyEditSpan`, but only the match was wired -- `commitFragmentEdit` is imported at L28 and never called, and `applyEditSpan` is unused; wire it (needs dryRun, restart, live test, standing suite) or formally leave Section 3 match-only. S4 as a whole is therefore NOT complete: the rest of str_replace above, plus `sed`/`replace-all` and the second start/end pair tool (a `matchContentEngine`-based pair tool exists around ~L2174-2250 of `mcp-registration.js`; whether it is the one this plan means was not re-audited) remain to be confirmed or ported.
- **S4e remaining housekeeping (not blocking):** delete `test/_save_fix_scratch.js` (guard blocked the delete; needs manual delete or explicit `confirm:true`); delete or mark superseded the stale `s4e/_s4e_section1_preview.js` and `s4e/_s4e_section2_scope.js` (v2) drafts and `lib/mcp-registration.js.bac`; consider try/finally around str_replace's post-`setTextInRange` bookkeeping so a late throw can never leave an unsaved buffer; update `README.md` for the Section 2 wiring and the allSymbols fix; consider a dedicated Section 2 regression test.

### Found during S1 live verification, not yet fixed

1. **Out-of-range refusals are miscounted in stats.** `insert` and `replace-block` file an `occurrence` refusal under `fails.anchorNotFound` (`insert`'s `fails.outOfRange` stayed 0); `replace-function-body` uses `ambiguous`/`ambiguousHint`. The user-facing message is right; only the bucket is wrong. Not yet traced to the responsible `bump()` calls.
2. **Misleading wording:** `replace-function-body {inFunction:'dupfn', occurrence:5}` says "ambiguous Ã¢â‚¬â€ use occurrence:N to disambiguate" although `occurrence` was passed.
3. ~~The `delete` `matchString` ambiguity message still advises `occurrence:N`~~ Ã¢â‚¬â€ FIXED by S2 (live-verified).
4. With an explicit `occurrence` and *zero* exact hits, autoRescue can still guess a fuzzy match for non-`delete` callers (`insert` `afterContent`) Ã¢â‚¬â€ consider skipping rescue when `occurrence != null`. `findSubstringInLines` (`read` pair-mode fallback) occurrence semantics are unaudited for clamping.

### Also found while reading `str_replace` for S4, not yet fixed

1. **`ambiguityCheck`'s text is wrong since S1.** `lib/tool-hints.js` says "Proceeding without scoping would target occurrence 1 blindly", but an unscoped duplicate is now refused, never guessed.
2. **`str_replace` ignores `occurrence` when resolving a hint** (only the content match uses it), so `inFunction:'dupfn'` + `occurrence:2` is refused with "Use occurrence:N to disambiguate" Ã¢â‚¬â€ the same defect as S1 finding 2 on `replace-function-body`. The engine's `resolveScope` already handles this correctly.
3. **Radius inconsistency in `str_replace`'s scope block.** Most resolvers get `_radius` (which honours `hintRadius`), but the `afterString`/`beforeString` label and the not-found nudge use the constant `HINT_RADIUS`, so the label can disagree with the actual window when `hintRadius` is set.
4. ~~**`str_replace`'s `afterString` call omits `{ fuzzyWhitespace }`** where the engine's forwards it (`mcp-registration.js` ~L397 vs `match-engine.js` L234).~~ **FIXED 2026-09-23.** `mcp-registration.js` L407 now passes `{ fuzzyWhitespace }` to `resolveStringPosition`, matching the engine.
5. **The stats schema is not universal.** Every edit tool has the full `hintsUsed` set, but only `str_replace` has `hintsSucceeded`, `hintsFailed`, `faultBuckets` and `fuzzyTriggerReasons`. Shared code that bumps them would silently do nothing for the other tools (bump to a missing key is a no-op). `fails.*` also differs per tool.

### Open questions for PJ (unanswered)

1. ~~**Rows vs characters in `resolveScope`.**~~ **DECIDED 2026-09-22 (during S4c, user authorized deciding): rows.** `resolveScope` keeps row bounds only; character offsets are derived at the boundary by whatever consumes them (as S4b's `matchFragment` already does, taking row bounds from a resolved scope and deriving column offsets itself). Every existing tool already consumes rows, and carrying both would mean keeping two representations in sync for no consumer that needs it yet Ã¢â‚¬â€ if a future caller genuinely needs a character offset mid-scope, it derives one at its own boundary rather than `resolveScope` carrying one nobody asked for.
2. **Universal counters.** Should `hintsSucceeded`/`hintsFailed`/`faultBuckets`/`fuzzyTriggerReasons` (and `logHintFailure`) apply to ALL edit tools, as the "universal, easy to compare" goal implies, or only `str_replace`? Decides whether S4-0 is needed before S4-1. Recommended: ship S4-1's richer messages first with each tool bumping only keys it already has, then add counters.
3. **Keep the hand-rolled `str_replace` path switchable during S4e**, or replace in place? (Recommended: a switch for the matching stages, so the same call can be run against the reference.)
4. ~~**S3 wiring.**~~ **DECIDED 2026-09-22 (during S4b):** refuse, not warn Ã¢â‚¬â€ a hit glued to a longer identifier is excluded from the candidate set, never surfaced as a silent single match. Escape-hatch flag is `guardIdentifier:false` (built into `matchFragment`, `lib/fragment-match.js`) Ã¢â‚¬â€ passing it returns glued hits too, each carrying its own `boundary` result, so a caller wanting warn-not-refuse can inspect and decide itself rather than the module hiding the raw data. When only SOME hits on a line are glued: FILTER, not refuse-and-list Ã¢â‚¬â€ glued hits are silently excluded from the candidate set and `occurrence:N` counts only the remaining clean candidates; the response still reports `guardedOut` (how many were excluded) so a caller isn't left wondering why a hit it can see in the source didn't count. Does the guard apply to `regex:true`/`fuzzyWhitespace`/multi-line needles? Not yet Ã¢â‚¬â€ `matchFragment` is a plain-literal, single-line matcher only (see S4b); extending the guard to those cases is undecided and deferred to whenever/if a caller needs it. The identifier set (ASCII `[A-Za-z0-9_$]`, from `lib/identifier-boundary.js`) is unchanged and still not separately ruled on, though nothing found this session argues for widening it.
5. Skip `autoRescue` when `occurrence != null`? (Item 4 of "Found during S1 live verification" above; relevant to the `str_replace` port because it supports `occurrence` on `old_str`.)
6. In `delete` Mode 4, should `inFunction:'dupfn'` + `occurrence:2` mean "the second `dupfn`" (as in Mode 5) rather than "the second `startContent` hit after the first `dupfn`"?
7. Gate `delete`'s not-found retry nudge to tools that really have `features.retryOnFail`? (Only `str_replace` does.)
8. Approve Stage 1 of the retryable-failures plan (kind-only `retryable:{kind,Ã¢â‚¬Â¦}`)?
9. `apply-patch` lifetime is 0% (44 fails): the `dryRun`-default change shipped but its 4 live checks were never recorded Ã¢â‚¬â€ investigate?

~~"What exactly does 'remove part-line matching from `str_replace`' mean?"~~ Ã¢â‚¬â€ answered 2026-09-20: PJ was considering part-line search/match/replace/delete for other tools and decided it would get messy; S3 stays as a boundary safety guard only.

### History Ã¢â‚¬â€ the 2026-09-17 ruling (SUPERSEDED)

**Full gap analysis done 2026-09-17** (see CHANGELOG for detail): read str_replace's entire ~1100-line handler end-to-end against `match-engine.js`. Finding: the bug that originally motivated this port ("str_replace silently resolves ambiguous matches") is **already fixed independently** Ã¢â‚¬â€ B38 (2026-07-20, plain-string path) and B57/B58 (2026-09-12, fuzzyWhitespace/fuzzyContent/regex paths). str_replace's hand-rolled matching is correct and battle-tested; porting it onto the engine's equivalent-but-separate guard would be deduplication only, at real risk to the highest-traffic tool in the file (2778+ lifetime hits). Conversely, `match-engine.js` was missing two things str_replace has (B39 drift re-check, B40 write-verification) Ã¢â‚¬â€ those were ported into `applyEdit()` as their own small change (see CHANGELOG), independent of whether str_replace itself ever moves onto the engine.

**~~Decision: do not port str_replace.~~ (superseded 2026-09-20 Ã¢â‚¬â€ see the top of this section.)** No correctness gain identified: only maintainability (one shared implementation instead of two independently-correct ones). Given the traffic/risk, that trade isn't worth it right now. Revisit only if a NEW bug is found in str_replace's hand-rolled path that the engine already handles correctly (that would flip the calculus back toward porting), or if `applyEdit()` gains real callers and the dedup argument gets stronger on its own.

---


## FUTURE WORK Ã¢â‚¬â€ per-tool supported-hints declaration + hide unsupported hints from descriptions

Every tool's `inputSchema` grants it *every* hint in `ANCHOR_SCHEMA`/`STRUCTURAL_ANCHOR_SCHEMA` regardless of whether the handler actually understands it Ã¢â‚¬â€ support is implicit in whatever the handler's hand-written `if` chain happens to check, not declared anywhere. That's a structural drift risk: any future hint added to the shared schema is automatically "accepted" (schema-valid) by every tool, whether or not that tool's handler was updated to do anything with it.

**Deferred plan (not built yet, do this later, low urgency Ã¢â‚¬â€ "make it work now, filter later"):**
- Add an explicit `SUPPORTED_HINTS` list per tool (e.g. in `tool-catalogue.js` or a new small map in `schema.js`).
- Use that list in two places: (1) at request time, to reject/ignore-with-warning any hint the tool doesn't declare support for; (2) at description-generation time, to only show hints in each tool's description that it actually supports.
- Do NOT block current work on this Ã¢â‚¬â€ hand-wiring individual hints into individual tools remains fine in the interim; this is a later consolidation pass, likely bundled with the T1Ã¢â‚¬â€œT3 build-out since those introduce new tools (`block-edit`, `block-delete`) that should get the declared-hints treatment from day one.

---

## PLAN Ã¢â‚¬â€ retryable failures: framework-level nudges + cheap corrective retry (STAGED, drafted 2026-09-19, decisions A/B/C resolved same day, nothing past Stage 0 started)

**Why this exists.** `get-edit-stats` (lifetime) shows `dryRun` / `commitLastPreview` get ~0 real usage (0 dry runs across str_replace/insert/delete/replace-block despite 1200+/58/10/10 real hits), while *failures* are heavy and real (str_replace: 282 lifetime fails Ã¢â‚¬â€ 62 noMatch, 78 ambiguous, 34 outOfScope, 34 afterNotFound). Every failure today forces the caller to resend the entire call to fix one wrong field. The cheapest-to-fix and highest-volume case is **ambiguous anchor**: the failure response already lists the exact candidate lines, so the correction is a single integer (`occurrence:N`), yet the caller must resend everything.

**What already exists (do not rebuild).** `features.retryOnFail:{field}` in `tool-framework.js` (stash-on-`matched:false`, merge of ONE named field, staleness sweep) and `RETRY_FIELD_BY_TOOL`/`retryNudge()` in `match-engine.js`. Code-complete for `str_replace` only, **never verified live** (see notes [41]/[42] and the 2026-09-19 verification attempt below). This plan generalises it; it does not replace it.

### What the 2026-09-19 verification attempt actually found (facts, not hypotheses)

1. Live test on `str_replace`, controlled marker: a failed call, then a bare `{filePath, old_str}` retry. **With a RELATIVE `filePath` the retry did not merge** (hit the `new_str is required` guard, reproduced twice). **With the ABSOLUTE `filePath` the identical sequence merged and committed the stashed `new_str`, verified by reading the file** (marker landed on the expected line; fixture restored afterwards). The relative-vs-absolute path was the ONLY variable changed, so this isolates the cause to finding 7. **`retryOnFail` therefore works end to end live; it is not broken, not stale-reloaded, and not blocked by schema-default keys inflating `_otherKeys`** (all three were hypotheses in the first draft of this plan and are now ruled out by this comparison).
2. **`str_replace` never shows the retry nudge.** *(Stale as of 2026-09-20: `str_replace`'s own content-failure path now appends `retryNudge(curTool)` at `mcp-registration.js` ~L1261, imported from `match-engine.js`, so the nudge does appear there. It is still absent from its scope-hint failures, deliberately Ã¢â‚¬â€ see the note in `buildFailResponse`.)* Its failure text is built by its own ~1100-line hand-rolled path (`mcp-registration.js` ~L1090-1265), not by `buildFailResponse()` where `retryNudge()` was wired. B32 correctly rejected porting str_replace *(superseded 2026-09-20 Ã¢â‚¬â€ PJ decided on the port; see the B32 section)*, so the nudge must be added to str_replace's own path or exposed via a shared helper Ã¢â‚¬â€ it cannot come for free.
3. **Failure signalling is inconsistent across tools.** The framework trigger is `_result.matched === false`. Grep of `mcp-registration.js` shows at least five different "failed" flags: `matched:false` (str_replace, buildFailResponse), `inserted:false` (insert, 11 sites), `deleted:false` (delete), `found:false` (replace-block, replace-function-body, read), `applied:false` (sed, apply-patch). Several `deleted:false`/`applied:false` hits are dry-run *previews*, not failures, so raw counts overstate. **`retryOnFail` as built can only ever stash failures for str_replace and buildFailResponse-routed paths.**
4. **insert has no `retryOnFail` at all** (`features` is `dryRun, lint, styleCheck, consecutiveFailureCounter, successNudge, structCheck, resendlessCommit`) and is absent from `RETRY_FIELD_BY_TOOL`. Its six failure types, probed live: `afterFunction`/`afterString` not found, ambiguous anchor, nonexistent file, missing `new_str`, `onLine` out of range. **None carries a retry nudge.**
5. **Pre-existing bug, independent of retry:** `insert` on a *nonexistent file* reports `afterString "..." not found` Ã¢â‚¬â€ blaming the anchor for a missing path. Any retry flow built on this would send the caller fixing the wrong thing.
6. Reload: `lib/pulsar-edit-mcp-server.js` hot-reload `bust()` list contains only `mcp-registration.js`, `tool-framework.js`, `schema.js`, `lint-helpers.js`. **`match-engine.js`, `buffer-helpers.js`, `tool-hints.js` are absent.** The "Files" section above claims `tool-framework.js`/`tool-hints.js`/`buffer-helpers.js` "hot-reload on save" while `match-engine.js` needs a full restart Ã¢â‚¬â€ the code disagrees with the docs. **Downgraded 2026-09-19 to a cleanup item, NOT a blocker:** the live retry test (finding 1) showed no staleness in `tool-framework.js` or the handler guard, so this was not the cause of the observed failure. It may still explain the earlier `match-engine.js`-side stale-nudge cycles in notes [36]/[37] (that file is the one omitted from `bust()`), but that is unproven.
7. **`commitLastPreview` rejects a relative path that names the same file (found live 2026-09-19 while writing this plan).** Previewing `insert` on `mcp-server-refactor-plan.md` then calling `insert({filePath:'mcp-server-refactor-plan.md', commitLastPreview:true})` returned "Pending preview for insert was for a different file (C:\...\mcp-server-refactor-plan.md)" Ã¢â‚¬â€ naming the SAME file. The identical call with the absolute path committed correctly. Cause (from reading `tool-framework.js`): the stash stores the *resolved absolute* `_resolvedFilePath`, while the caller-supplied `args.filePath` is compared via `path.resolve()` against process cwd, which is not the project root (same root cause as B59 Ã¢â‚¬â€ since removed from this plan: its `readTextFromFile()` half was fixed as B62, and the `tool-framework.js` half by `_samePath()`, both in CHANGELOG). The earlier resendlessCommit tests all used `test/resendless_commit_test.js`, a path shape that happened to resolve consistently, so this never surfaced. **`retryOnFail`'s `_sameFile` check (`tool-framework.js` ~L250) uses the identical comparison and is CONFIRMED to fail the same way: the relative-path retry did not merge and the absolute-path retry did (finding 1). This is the sole cause of the observed str_replace merge failure.** Fix: compare via `resolveProjectPath()` on both sides (already imported at ~L284 for the editor-acquisition block). Sites: ~L219 (`commitLastPreview` splice) and ~L250 (`retryOnFail` `_sameFile`). Consequence for usage until fixed: **always pass the absolute path to any tool relying on `commitLastPreview` or the bare-retry shape.**

### Principles (carried from resendlessCommit's four-round history)

- **Prove on one tool, restart between stages, verify live before widening.** Every prior feature in this area found a genuinely new bug on each restart cycle; do not batch stages.
- **Unadvertised capability does not get used** (lesson from resendlessCommit's ~0 usage): the failure *response text* must say exactly how to retry cheaply. Description-only mentions do not count.
- **Only retryable failures stash.** A bad file path or a missing required arg must not stash and must not advertise a retry.
- ~~**Do not port str_replace onto the engine** (B32 stands). Add capability to its existing path.~~ **Superseded 2026-09-20:** the port is now the direction (see the B32 section). Retry work on `str_replace` still should not wait on it Ã¢â‚¬â€ add capability to its existing path now; it moves over with the port.
- **Additive, not a replacement:** keep `matched:false` working for everything that already depends on it while any new signal is introduced alongside it.

### Stage 0 Ã¢â‚¬â€ make the change loop trustworthy (BLOCKS everything below)

0a. **Fix the relative-vs-absolute path comparison (finding 7 Ã¢â‚¬â€ CONFIRMED sole cause of the str_replace merge failure)** at BOTH sites in `tool-framework.js`: the `commitLastPreview` splice (~L219) and `retryOnFail`'s `_sameFile` (~L250). Compare `path.resolve(resolveProjectPath(a)) === path.resolve(resolveProjectPath(b))` on both sides. `tool-framework.js` is on the `bust()` list so this should hot-reload, but confirm with a live test rather than assuming.
0b. **Verify with the same two-run comparison that found the bug:** failed `str_replace` then bare `{filePath, old_str}` retry, once with a RELATIVE path (must now merge) and once with an ABSOLUTE path (must still merge). Also repeat for `insert`'s `commitLastPreview` with a relative path. Restore the test fixture afterwards.
0c. **Give `str_replace` its retry nudge** (finding 2). The mechanism works but nothing tells the caller it exists, and unadvertised capability goes unused (see Principles). The nudge belongs in str_replace's own failure path (`mcp-registration.js` ~L1261-1265, the `return { ..., matched: false }` block), not via `buildFailResponse()`. Text must name the exact cheap shape: `{ filePath, old_str: '<corrected>' }`.
0d. Cleanup, non-blocking: reconcile `bust()` with the "Files" docs (finding 6).
0e. Record the result in session notes before starting Stage 1.
*Exit criterion:* a relative-path bare retry merges live, and a failed `str_replace` response tells the caller how to retry cheaply.

### Stage 1 Ã¢â‚¬â€ one explicit failure contract (`retryable`), additive

Introduce a single optional field failure responses may set, so the framework stops guessing from five different flags:

```
retryable: { kind: 'occurrence', candidates: [4, 8, 12] }   // ambiguous anchor Ã¢â‚¬â€ fix is one integer
retryable: { kind: 'field', field: 'afterString' }          // anchor/content not found Ã¢â‚¬â€ fix is one string
retryable: { kind: 'field', field: 'onLine' }               // line out of range Ã¢â‚¬â€ fix is one number
```

A failure with no `retryable` (bad file path, missing `new_str`, brace-match failure) simply does not stash Ã¢â‚¬â€ this also resolves the "not every failure is retryable" concern by construction. Framework trigger: stash when `_result.retryable` is present, OR when the legacy `matched:false` + `features.retryOnFail.field` path applies; `retryable` wins if both are present (decision B, resolved). **`matched:false` keeps working untouched** during this stage.
1a. Framework: read `retryable`, stash `{args, filePath, retryable}` per tool (same lifecycle/staleness sweep as today's `retryPending`).
1b. Framework: generate the nudge text *from* `retryable.kind`, so wording is consistent and lives in one place.
*Exit criterion:* a synthetic `retryable` result stashes, expires on a same-file commit, and never stashes for a non-retryable failure.

### Stage 2 Ã¢â‚¬â€ occurrence retry (highest value; do this before anything else on the retry side)

Caller sends `{filePath, occurrence: N}`; framework merges `occurrence` into the stashed args and re-runs. Applies only when the stashed failure was `kind:'occurrence'`. The nudge names the candidate lines already known from the ambiguity report (e.g. "matches at L4, L8, L12 Ã¢â‚¬â€ retry with just `{ filePath, occurrence: N }`").
2a. Wire on the **shared `buildFailResponse()` / `ambiguityCheck()` path first** Ã¢â‚¬â€ covers insert's main branches, delete, replace-block, replace-function-body in one change.
2b. Then insert's bespoke `sectionHint`/`preprocBlock` ambiguity (`mcp-registration.js` ~L1712-1716) and str_replace's own two ambiguity sites (~L877, ~L973) Ã¢â‚¬â€ these bypass the shared path.
2c. Validate `N` is within the stashed candidate list; out-of-range Ã¢â€ â€™ a clear error, not a silent wrong edit.
*Exit criterion, on insert first:* ambiguous `afterString` Ã¢â€ â€™ `{filePath, occurrence:2}` lands at the second match, and `occurrence` omitted on a *fresh* ambiguous call still refuses (the safe-refusal behaviour from the [27] fix must be preserved).

### Stage 3 Ã¢â‚¬â€ "not found" correction retry, per tool, insert first

Generalise `features.retryOnFail.field` from one fixed name to **the anchor key the stashed call actually used** (design option 2 from the 2026-09-19 discussion, DECIDED as decision A: accept any single anchor key as the retry, so `afterString` Ã¢â€ â€™ `afterFunction` is allowed when the *kind* of anchor was the mistake, not just its value; a retry supplying two anchor keys is rejected, not resolved silently). Order: insert Ã¢â€ â€™ delete Ã¢â€ â€™ replace-block Ã¢â€ â€™ replace-function-body Ã¢â€ â€™ str_replace's own path (nudge added directly; the port is now planned separately Ã¢â‚¬â€ see the B32 section, 2026-09-20).
3a. insert: add `features.retryOnFail`, make `new_str` optional-with-guard (same pattern already proven by `commitLastPreview` Ã¢â‚¬â€ see notes [38]; expect the same Zod-transport gotcha for any other required field a retry omits, and handle it per tool).
3b. Prove on insert alone; restart; verify; only then move to the next tool.

### Stage 4 Ã¢â‚¬â€ error-string audit (fold in as each tool is touched, not as a separate big-bang)

The user asked to check that all returned error strings are sensible. Do this per tool *as Stage 2/3 reaches it*, not as a repo-wide pass. Known issues to fix in passing:
- insert on nonexistent file Ã¢â€ â€™ wrong "anchor not found" message (finding 5). **Independent, small, can ship before any retry work** Ã¢â‚¬â€ recommended as the first code change after Stage 0.
- insert `onLine` out of range prints a partial hint list but no retry guidance.
- str_replace's `new_str is required (unless retrying...)` message currently advertises a mechanism that doesn't work (finding 1) Ã¢â‚¬â€ must be corrected or gated until Stage 0 passes.
- The consecutive-failure banner fires on zero-match `grep-file` calls ("3 consecutive failures on grep-file Ã¢â‚¬â€ strongly consider switching to: a different editing tool"). A zero-match search is an expected result, not a failure (and grep is not an editing tool). Pre-existing; noted so it stops being mistaken for a real signal.

### Decisions (RESOLVED by PJ, 2026-09-19)

- **A Ã¢â‚¬â€ scope of the merge: ANY single anchor key.** A retry may supply any one anchor key and it replaces whichever anchor the stashed call used, even a different kind (e.g. `afterString` Ã¢â€ â€™ `afterFunction`), because a failed anchor is often the wrong *kind*, not just the wrong value. Implication for Stage 3: `features.retryOnFail.field` (one fixed name) is generalised to "the anchor key set", and the framework must reject a retry that supplies two anchor keys at once (ambiguous which to honour) rather than picking one silently.
- **B Ã¢â‚¬â€ trigger: ALONGSIDE `matched:false`.** `retryable` is additive. `matched:false` remains the trigger for everything that already depends on it (str_replace, `buildFailResponse()`-routed paths) until every dependent tool has been migrated and verified live. Implication for Stage 1: the framework stashes when EITHER `retryable` is present OR the legacy `matched:false` + `features.retryOnFail.field` path applies; `retryable` wins when both are present. Removing the legacy path is a later, separate change and is NOT part of this plan.
- **C Ã¢â‚¬â€ occurrence retry is ONE-SHOT, post-ambiguity only.** `{filePath, occurrence:N}` is accepted only immediately after an ambiguity failure on the same file, consumed on use, and swept by the same staleness rules as `retryPending` (any same-file commit or another failure clears it). It is never a standalone call: with nothing pending it falls through to the normal ambiguity refusal, preserving the [27] safe-refusal behaviour.

### Explicitly NOT in scope

- ~~Porting str_replace onto the match engine (B32 stands).~~ **Superseded 2026-09-20:** PJ decided on universality, so the port is now the direction of travel Ã¢â‚¬â€ see "B32" above (stages S1Ã¢â‚¬â€œS4). It is still *not part of this retry plan*: it is sequenced separately, and Stage 2/3 retry work on `str_replace` should not wait on it.
- The universal hint-naming cleanup (see CHANGELOG/notes [23]/[24]) Ã¢â‚¬â€ separate, later.
- Migrating apply-patch's `confirm`+`patchRescueStore` onto `resendlessCommit` Ã¢â‚¬â€ separate follow-up from note [40].
- Generalising to sed / apply-patch / read tools until Stages 0Ã¢â‚¬â€œ3 have passed on insert.

---

## Architecture Ã¢â‚¬â€ unified edit backend with per-tool capability tickboxes (DECIDED direction, 2026-07-20, not built yet)

Supersedes the earlier "not designed yet" framing below (kept underneath for
history). Decided across today's conversation:

> **Status note (2026-09-20) Ã¢â‚¬â€ written after this section, so read the names below with these in mind:**
> - `delete-line`, `delete-line-range` and `delete-block` no longer exist. They were consolidated into a single **`delete`** tool on 2026-09-17 (six modes; see CHANGELOG). Where this section says `delete-line-range` or `delete-block`, read `delete`. Its raw-line path (`startLine`/`endLine`) is now the *legacy last resort* and takes `expectedContent`, which is the "narrow gap" fix described under "Where delete-line-range fits" below.
> - `get-region` and `read-lines` were likewise merged into **`read`** (2026-09-18).
> - The "shared backend" in this section is being built as the **match engine** (`lib/match-engine.js`) rather than a single `commitEdit()` function, and the decision to port `str_replace` onto it was taken on 2026-09-20 Ã¢â‚¬â€ see "B32" above. `delete` (modes 1Ã¢â‚¬â€œ5), `read`, `replace-block` and `replace-function-body` are already on it; `str_replace`, `sed`, `replace-all` and `replace-document` are not yet.

**The model:** one shared backend function Ã¢â‚¬â€
`commitEdit({ scope, deleteRange, insertText })`, per the primitive already
sketched pre-2026-07-20 (deleteRange:null = insert, insertText:'' = delete,
both non-null = replace). Every MCP-facing tool name (`str_replace`,
`insert`, `delete-line-range`, and any future one) stays its own real
registration Ã¢â‚¬â€ own name, own description, own decision-ladder, so the
per-tool teaching value the LLM relies on is never lost Ã¢â‚¬â€ but each
registration's `features`/config block (the same declarative pattern
already used today for `dryRun`/`lint`/`successNudge`/`structCheck`
per-tool toggles) also declares which **capabilities** that tool name is
allowed to use: delete-allowed, insert-allowed, which hint set, whether the
raw-line-number legacy fallback is exposed. The registration reads its own
tickboxes, calls the one shared backend with the right shape, and the
backend itself never needs to know or care which tool name it was invoked
through.

**Why this and not either extreme:**
- NOT "N separate hand-rolled implementations forever" (today's state) Ã¢â‚¬â€
  every fix/new hint/new diagnostic in the shared backend propagates to
  every tool automatically; the only per-tool surface left to maintain is
  a short tickbox list, not a duplicated handler.
- NOT "one mega-tool with a mode param" either Ã¢â‚¬â€ the "What NOT to do"
  section below's "do not collapse to 1-2 mega-tools" guidance is about
  the MCP-facing surface, and still holds: the LLM still sees
  `str_replace`, `insert`, `delete-line-range` etc as genuinely separate,
  independently-described tools. Only the implementation collapses, not
  what's presented.

**Validated against real precedent, not just reasoned from first
principles** Ã¢â‚¬â€ Cline's shipping code (test/_cline_src,
`ToolExecutorCoordinator.ts` + `WriteToFileToolHandler.ts`) does exactly
this in production: `write_to_file`, `replace_in_file`, and `new_rule` are
three separate tool names, all routed via `SharedToolHandler` to the *same*
underlying handler, gated internally by `block.name ===` checks. This
codebase's existing declarative `features:{...}` tickbox pattern is a
cleaner mechanism for the same gating than Cline's imperative if-chain Ã¢â‚¬â€
this isn't inventing a new idea, it's applying an already-proven pattern
more cleanly than the reference implementation that proved it.

**Sequencing Ã¢â‚¬â€ insert first, proven, before str_replace touches it:**
Per PJ (2026-07-20): `insert` becomes the vehicle for building out and
proving the shared backend, since it's already on
`resolveScope()`/`matchContent()`/`buildFailResponse()` and is
comparatively low-traffic (196 lifetime hits vs str_replace's 2778) Ã¢â‚¬â€ safer
to iterate on. Once `insert`'s pattern is fully verified working,
`str_replace`'s own registration gets rewired to call the same shared
backend via its own tickbox config Ã¢â‚¬â€ **not a rename, not an alias, no
naming-collision risk.** `str_replace` keeps its own registration and name
the entire time; only its internals change from hand-rolled to
backend-calling, the same incremental, verifiable step B38 already modeled
(fix logic in place, keep the name, keep it registered). This directly
avoids the "can't have two tools with the same name" concern raised
2026-07-20 Ã¢â‚¬â€ that concern only applies to a hard rename/cutover, which is
explicitly not the plan.

**Where delete-line-range fits Ã¢â‚¬â€ narrower than originally scoped for T3:**
Investigation 2026-07-20 (see `test/unified-edit-backend-design.md`) found
`delete-line-range`'s raw `startLine`/`endLine` path has no content
verification at all (unlike str_replace, which even in its weakest
`afterLine` fallback mode still narrows a search window and then still
requires `old_str` to match inside it Ã¢â‚¬â€ verified fallback, not blind
positional edit). `delete-line-range`/`delete-block` both show 100%
lifetime hit rates, so this isn't "these tools are broken" Ã¢â‚¬â€ it's one
specific narrow gap (no equivalent of `old_str` in the raw-line path) that
should get its own small, direct fix (an optional `expectedContent`-style
check, giving it the same verified-fallback shape `str_replace afterLine`
already has) rather than being folded into T3's original
merge-into-block-delete plan. T3's row below is revised accordingly.

**Not decided yet Ã¢â‚¬â€ genuinely open:**
- Exact shape of the tickbox config for capability-gating (vs. the
  existing `features:{...}` shape, which today only gates cross-cutting
  concerns like dryRun/lint Ã¢â‚¬â€ extending it to gate *which primitive
  operations* a tool exposes is new territory for that mechanism).
- Whether `delete-line-range`/`delete-block` join the shared backend in
  the same pass as `str_replace`, or as a later fast-follow once
  `str_replace` itself is proven on it. **[ANSWERED 2026-09-20: they joined
  first.** The consolidated `delete` tool's modes 1Ã¢â‚¬â€œ3 were ported onto
  `resolveScope()`/`buildFailResponse()` on 2026-09-19/20 and modes 4Ã¢â‚¬â€œ5 use
  `matchContent()`; only Mode 4's `inFunction` `searchFrom` is still
  hand-rolled. `str_replace` is now the one still to move.] (B44, fixed 2026-09-12, resolved
  the underlying ambiguous-match bug in `resolveStructuralAnchor` Ã¢â‚¬â€ so
  `sectionHint`/`preprocBlock` no longer need a bug fix *before* this
  question can be answered, only the architectural port itself. Fix-then-
  port already happened for that helper; only port remains, whenever this
  is decided.)

**Reload hazard, reconfirmed 2026-09-12 (relevant to any future edit here):**
editing this server's own source files (`mcp-registration.js`,
`buffer-helpers.js`, etc.) via `str_replace`/`insert` when the file is
**not open in a Pulsar tab** writes straight to disk but does NOT reliably
trigger Pulsar's package-reload file-watcher Ã¢â‚¬â€ repeated dry-run tests kept
showing pre-fix behavior and `get-edit-stats`' session counters never
reset, even after a `tool_search` reload of tool descriptions. A manual
Pulsar restart was required before a B44 fix actually took effect. Earlier
restart-hazard notes ([33]/[40]) assumed edits went through an open tab
(a real in-editor save), which does reliably trigger the reload Ã¢â‚¬â€ this
headless-write path is a distinct, previously undocumented case. Anyone
editing server source under this plan should expect to need a manual
restart afterward, and should verify the fix landed against a live test
(not just a description-freshness check) before considering a fix done.

---

## Architecture note Ã¢â‚¬â€ the original "universal edit tool" observation (SUPERSEDED by the section above, kept for history)


Raised by PJ, worth recording verbatim in spirit: **str_replace is conceptually insert with a before-anchor that also deletes what's in between** Ã¢â‚¬â€ and by extension, most of the edit-tool family (str_replace, insert, delete-line-range, delete-block, replace-block) could in principle be ONE underlying tool structure in the framework, with the distinct MCP tool names/descriptions the LLM sees being a presentation-layer alias over a single implementation, and behavior (delete existing content: y/n, insert new content: y/n, anchor style) selected via config tickboxes rather than five separately-maintained handlers.

This is the natural end-state of B24/T1-T6 taken one step further Ã¢â‚¬â€ not just shared matching/scoping (match-engine.js) but a shared TOOL SHAPE, with `str_replace` and `insert` becoming two configurations of the same underlying commit primitive: `commitEdit({ scope, deleteRange: match.range | null, insertText: newStr })`. A pure insert is `deleteRange: null`; a pure delete is `insertText: ''`; str_replace is both non-null.

**Not designed yet Ã¢â‚¬â€ open questions before building this:**
- Whether the MCP-facing tool SURFACE should also collapse (one tool, a `mode` param) or stay as separate named tools with separate descriptions/decision-ladders (probably the latter Ã¢â‚¬â€ collapsing the LLM-facing surface risks losing the teaching value of per-tool decision ladders, even if the implementation collapses)
- How this interacts with the T1-T6 build order already in this doc Ã¢â‚¬â€ this observation suggests those conversions and any future str_replace-onto-match-engine port might converge on the SAME shared commit primitive rather than three separate ports
- Whether `features.successNudge`-style declarative config is the right mechanism to also drive which MODE a unified tool runs in, or whether mode selection needs its own dedicated config shape

**Idea (raised by PJ, 2026-07-19) Ã¢â‚¬â€ migrate via insert instead of porting str_replace directly:** rather than porting str_replace's ~1000-line hand-rolled handler onto the engine in place, build `insert` up into the full replacement first Ã¢â‚¬â€ since `insert` is already on `resolveScope()`/`matchContent()`/`buildFailResponse()`/`features.successNudge`/`features.structCheck`, extending it to also accept a delete range (i.e. give it the `old_str` / content-to-remove side it currently lacks) would make it a strict superset of str_replace's behavior: `deleteRange: null` is today's insert, `deleteRange: match.range` is str_replace. Once `insert` can fully reproduce every str_replace case (including the ambiguity-guard and found-outside-scope fixes from the B32 addendum above, which `insert` already gets via the engine), retire the old hand-rolled `str_replace` handler and register **`str_replace` as an alias name pointing at the same underlying implementation `insert` uses** Ã¢â‚¬â€ same tool-shape idea as the `commitEdit({ scope, deleteRange, insertText })` primitive already sketched above, but sequenced as "grow insert, then rename/alias" rather than "port str_replace in place." Preserves the 662+ hit learned tool name (per "What NOT to do" in the Tool Consolidation section below Ã¢â‚¬â€ don't rename str_replace) while letting the actual migration happen on the newer, already-framework-native code path instead of inside the riskier legacy handler. Not designed in detail yet Ã¢â‚¬â€ needs a decision on: whether `insert`'s description/decision-ladder still makes sense once it also deletes (may need its own rewrite, not just aliasing), and whether `old_str`-style content-to-delete becomes a first-class `insert` param or stays str_replace-only surface syntax over the shared primitive.

## Idea Ã¢â‚¬â€ stacking/composable anchors, e.g. inFunction + afterString (raised, not designed/built yet)

Problem: `resolveScope()` today is a strict if/else-if ladder Ã¢â‚¬â€ the first hint present wins outright; every other hint passed alongside it is silently ignored. So `{inFunction:'hal_init', afterString:'g_hal ='}` does NOT mean "search for that string inside hal_init" Ã¢â‚¬â€ only `inFunction` takes effect. `betweenHint` is the only existing example of a hint that layers scope-narrowing on top of scope-narrowing, and even that's only wired as a modifier for a couple of tools, not general.

Proposed direction: let a primary scope hint resolve a search window as it does now, then optionally apply a secondary content hint (`afterString`/`beforeString`) *within* that window rather than over the whole file Ã¢â‚¬â€ i.e. two-stage `resolveScope()`. Natural fit for `lib/match-engine.js` since `matchContent()` already takes a `scope` and searches only inside `searchStart`/`searchEnd` Ã¢â‚¬â€ the missing piece is `resolveScope()` accepting a combination of hints instead of picking exactly one. Would directly help disambiguation cases where a string appears in several functions.

Not designed in detail yet Ã¢â‚¬â€ needs a decision on: which hint pairs are allowed to stack, whether it's every tool via the shared engine or opt-in per tool, and how failure messages explain "found outside the narrowed sub-scope but inside the outer one" distinctly from "not found at all."

## Idea Ã¢â‚¬â€ line-offset modifier for insert (raised, not designed/built yet)

Problem: content-anchored hints need unique, non-blank text to match against. But sometimes the actual insertion point you want is a blank line (or an otherwise low-content line) a fixed distance away from the nearest unique anchor. Today the only way to target that is the purely positional `insert_line:N`.

Proposed direction: an optional offset modifier (e.g. `lineOffset:N`) that pairs with any of the existing content-anchored hints Ã¢â‚¬â€ resolve the anchor's row the normal (drift-immune) way, then shift by N lines before inserting. Doesn't exist anywhere in `schema.js` yet. This would likely be `insert`-specific rather than a general `ANCHOR_SCHEMA` addition. Not designed in detail yet Ã¢â‚¬â€ needs a decision on interaction with `betweenHint`/scoped anchors and whether negative offsets (before the anchor) should be supported too.

---

## Tool Consolidation Ã¢â‚¬â€ Recommendations (researched 2026-06-19)

> Based on: analysis of Aider, Cline, opencode, Claude Code source + lifetime stats. **Note (2026-07-20): the specific numbers below are from an older stat snapshot (2026-06-19) Ã¢â‚¬â€ current lifetime numbers per `get-edit-stats` are str_replace 2778 hits/422 faults, insert 196/44, delete_line_range 74/0, delete_block 6/0, apply_patch 0/20. The qualitative conclusions below (str_replace dominance from investment, not superiority; other tools under-invested) still hold and are now more strongly evidenced, not less Ã¢â‚¬â€ kept as historical record rather than re-numbered throughout.**

### Industry pattern
All tools (Cline, opencode, Claude Code) converge on **3 edit tools**: surgical edit, whole-file write, multi-hunk patch. Nobody has separate insert/delete tools. Delete = surgical edit with empty replacement. Insert = surgical edit including surrounding line. **Confirmed independently 2026-07-20** by reading Cline's actual shipping source: `write_to_file`/`replace_in_file`/`new_rule` are three tool names routed to one shared handler (`SharedToolHandler` Ã¢â€ â€™ `WriteToFileToolHandler`, gated by `block.name`) Ã¢â‚¬â€ direct precedent for this codebase's own unified-backend-with-tickboxes direction (see Architecture section above).

### Our differentiator
The hint system (`afterString` 93% hit rate, `inFunction` 88%) is unique Ã¢â‚¬â€ nobody else has it. Claude Code has `@@contextLine` as a single content anchor but no scope narrowing, no ambiguity check, no fuzzy matching. This is worth protecting and extending, not replacing.

### Core principle Ã¢â‚¬â€ invest before killing
`str-replace` dominates the stats (304 hits, 79%) not because other tools are redundant but because **only `str-replace` received investment**. Every other tool got a basic implementation and was left to fend for itself.

**Do not kill a tool because it has low stats. Give it the same investment as `str-replace` first, then measure.**

The one exception: `replace-block` Ã¢â‚¬â€ genuinely superseded by `str-replace` for its brace-block use case, and its approach (find anchor, brace-count to `}`) is fragile. Kill it now.

### Planned tool family (after investment)

```
str-replace      Ã¢â‚¬â€ surgical single content match. Already mature. Will migrate onto the shared backend (see Architecture section) once insert proves the pattern Ã¢â‚¬â€ no rename.
insert           Ã¢â‚¬â€ insert at content anchor. Vehicle for proving the shared backend pattern first (see Architecture section).
apply-patch      Ã¢â‚¬â€ multi-hunk unified diff. T1 (framework migration, no format rebuild) closed 2026-09-12 Ã¢â‚¬â€ see CHANGELOG.
delete           Ã¢â‚¬â€ consolidated 2026-09-17 from delete-line / delete-line-range / delete-block into ONE tool with six modes (sectionHint / preprocBlock / inFunction / startContent+endContent / matchString / legacy startLine+endLine with expectedContent). Modes 1Ã¢â‚¬â€œ3 ported onto resolveScope() and 4Ã¢â‚¬â€œ5 onto matchContent() by 2026-09-20. Supersedes the "DEFERRED rebuild" that stood here Ã¢â‚¬â€ that was done as a consolidation, not left as two tools.
replace-document Ã¢â‚¬â€ whole file rewrite. Already fine.
replace-function-body Ã¢â‚¬â€ whole function rewrite. Already fine.
```

### Recommended changes

| # | Priority | Item | Notes |
|---|---|---|---|
| T2 | | T4EDIUM | Kill `replace-block` | 0 hits both stat sets. Genuinely superseded Ã¢â‚¬â€ `str-replace` handles all its brace-block cases better. Clean break, no alias. |
| T6 | Ã°Å¸â€Â§ LOW | Update `str-replace` description Ã¢â‚¬â€ explicit delete + insert patterns | Add: `new_str:""` deletes matched content. For inserting, prefer `insert` tool. Cross-reference clearly. |

> **Needs PJ's decision (flagged 2026-09-20, not resolved):** the T4 row above ("Kill `replace-block`") no longer matches reality and its cells are garbled (`| T2 | | T4EDIUM |` Ã¢â‚¬â€ an old edit merged the T2 and T4 rows, so the row's ID and priority are unreliable). Its stated basis was "0 hits both stat sets", but `replace-block` is registered and live: lifetime `get-edit-stats` shows **10 hits / 8 fails**, and on 2026-09-18 it was **ported onto the shared engine** (`matchBlock()` + `applyEdit()`) and live-verified Ã¢â‚¬â€ investment that contradicts killing it. Either retire T4 as overtaken by events, or restate it (e.g. "kill it once `str_replace` is on the engine and can take over brace-block edits"). Left as-is until decided.

### What NOT to do
- **Do not rename `str-replace`** Ã¢â‚¬â€ 662+ hits of learned behaviour (2778 per current lifetime stats). Cost of relearning outweighs naming aesthetics. Still holds under the unified-backend direction above: str_replace's *internals* migrate to the shared backend, but its registration/name never changes Ã¢â‚¬â€ no rename, no alias, no cutover moment.
- **Do not kill tools based on low stats alone** Ã¢â‚¬â€ `str-replace` won by investment not by being better. Other tools deserve the same treatment first.
- **Do not collapse the MCP-facing tool surface to 1-2 mega-tools with a mode param** Ã¢â‚¬â€ complexity belongs in matching logic + hints, not fewer *presented* tools. Industry evidence agrees (Cline keeps 3 separate tool names even though they share one handler). **Refined 2026-07-20:** this guidance is about what the LLM sees, not the implementation Ã¢â‚¬â€ collapsing the *backend* while keeping distinct tool names/descriptions (see Architecture section above) is the decided direction and does not violate this principle; it's Cline's own production pattern, not a "mega-tool."
- **Do not alias killed tools** Ã¢â‚¬â€ clean break. LLM relearns from descriptions. (Distinct from the shared-backend direction: that's multiple *live, still-taught* tool names sharing implementation, not an alias left behind after a tool's retirement.)

### Build order
T1 (apply-patch Ã¢â€ â€™ match-engine migration) is done and closed (2026-09-12, see CHANGELOG). T3's own delete-line-range verified-fallback fix is done (2026-09-12, see CHANGELOG); `delete_block`'s off-`findAnchor` migration is also done and live-verified (2026-09-17, see CHANGELOG) Ã¢â‚¬â€ `findAnchor` is now fully retired from the codebase. **`delete-line-range` and `delete-block` were then consolidated into the single `delete` tool (2026-09-17), which is what the "T3" work ultimately became.** T2 (insert investment) is done and is also the proving ground for the unified-backend Architecture direction above. **Since then (2026-09-18 Ã¢â€ â€™ 2026-09-20):** `read` (merging `get-region` + `read-lines`), `replace-block` and `replace-function-body` were moved onto the engine, and stage S1 of the `str_replace` port (engine occurrence safety) is done Ã¢â‚¬â€ the remaining architectural step is the `str_replace` port itself, staged as S2Ã¢â‚¬â€œS4 under "B32" above. T4 (kill replace-block) Ã¢â€ â€™ T5+T6 (description polish) unchanged **pending PJ's call on T4 Ã¢â‚¬â€ see the note under the table.**

---

## Feature Gap Analysis (vs other tools Ã¢â‚¬â€ researched 2026-06-04)

| Feature | Cursor | Windsurf | Cline | Claude Code | Us | star |
|---|---|---|---|---|---|---|
| Plan mode | yes | yes | yes | yes | no | |
| Per-step approval | yes | yes | yes | yes | no | |
| Inline diff in editor | yes | yes | no | no | no | |
| Inline diff in chat | no | no | no | partial | no | |
| Reusable workflows | no | yes | no | no | yes @// | star |
| Context window indicator | no | no | yes | yes | no | |
| Auto context compaction | no | no | no | yes | no | |
| Checkpoint / restore | no | no | shadow git | no | yes buffer+disk | star |
| Kernel C style checking | no | no | no | no | yes | star |
| Naming + doc skeleton | no | no | no | no | yes | star |
| Ghidra RE integration | no | no | no | no | yes | star |
| Edit stats + smart suggestions | no | no | no | no | yes | star |
| Persistent cross-session LLM notes | no | no | no | no | yes | star |
| Aider-style repo map (tree-sitter) | no | no | no | no | yes | star |
| Multi-agent / parallel agents | yes | yes | yes | yes | no | |
| Browser / web access during task | no | no | yes | yes | no | |

---

### Edit Strategy Notes

- `afterString` on a unique nearby string is the most reliable scope anchor; `betweenHint` when afterString is ambiguous
- `fuzzyWhitespace:true` as default for mcp-registration.js (mixed indentation throughout)
- `dryRun:true` before any str_replace with old_str > 5 lines
- `replace-function-body` first for whole-function rewrites
- `replace-block` for `{}` brace blocks ONLY Ã¢â‚¬â€ never `[]` array literals
- `save-all` after every edit Ã¢â‚¬â€ never batch edits without saving between them
- Saving mcp-registration.js triggers hot-reload Ã¢â‚¬â€ checkpoints wiped, MCP server cache reset
- `inFunction` never on .md files Ã¢â‚¬â€ use `afterLine` or `afterString` instead
- `replace-across-files` glob must always be `lib/*.js`, never `**/*.js` Ã¢â‚¬â€ hits node_modules
- `grep-file` before str_replace on any file to confirm exact anchor text and line numbers
- chat-panel.js, chat-functions.js and .less changes require Pulsar package reload Ã¢â‚¬â€ no hot-reload
- **Global substitution on mcp-registration.js:** ~~`replace-all` and `sed` time out on this file~~ Ã¢â‚¬â€ RESOLVED, no longer true. `sed` handles this file fine now. The PowerShell workaround below is kept only as a general fallback pattern, not because sed/replace-all are broken.
- **PowerShell null guard:** Always validate `$content` is non-null before `Set-Content`. A failed `-replace` or `Get-Content` on a locked file returns null; writing null produces a 3-byte file. Pattern: `if (-not $content) { Write-Error "Content is null, aborting"; exit 1 }` after every `Get-Content` and after every `-replace` chain.
- **tool-catalogue.js edits:** `str_replace` works correctly. PowerShell `Set-Content` is still an option for large rewrites but prefer `str_replace` Ã¢â‚¬â€ always open the file first with `open-file`.
- **PowerShell writes to closed files are unrecoverable:** `run-command` pre-flight checkpoints all *open* editors. Files not open in a tab cannot be snapshotted. If PowerShell must write a file, open it in Pulsar first.
- **grep-project now works on mcp-registration.js** (v0.14.1 Ã¢â‚¬â€ readTextFromFile fix). No longer need open-file workaround.
