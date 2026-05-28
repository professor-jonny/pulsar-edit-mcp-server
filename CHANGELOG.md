

## 0.6.0

### New search/read capabilities — `contextLines` + `occurrence` on grep tools

All three grep/search tools now support scoped result narrowing on par with the edit tools:

- **`grep-file`** — added `contextLines` (returns N lines before/after each match as `before`/`after` arrays) and `occurrence:N` (return only the Nth match and stop). Matches `grep-project` parity.
- **`grep-project`** — `contextLines` and `occurrence` were already implemented; confirmed complete.
- **`search-symbol`** — added `contextLines` and `occurrence` with the same pattern (globalIndex counter, early-exit labeled break, before/after arrays). Updated description.
- **`find-text`** — upgraded from `buffer.findAllSync` to a line-scan approach. Added `contextLines` and `occurrence`. Each result now has `{ line, text, before?, after? }` consistent with grep-file output. Added try/catch for invalid regex (was missing).

### `read-lines` full rewrite — hint-based range resolution

`read-lines` no longer requires `startLine`/`endLine`. All parameters are now optional. New resolution modes:

- **`centerLine` + `radius`** — return a window of N lines around a centre line
- **`functionHint`** — scan for a named function, brace-count to find its body, return it
- **`afterHint`** — return lines starting after the first occurrence of an anchor string
- **`betweenHint: { start, end }`** — return lines between two anchor strings
- **`lineHint`** — alias for `centerLine` (radius defaults to 10)

`startLine`/`endLine` still work as before for callers that know exact line numbers.

### `delete-line-range` schema fix — hints were silently ignored

**Bug fix:** `delete-line-range` had `dryRun`, `functionHint`, `afterHint`, `lineHint`, `betweenHint`, `occurrence`, and `fuzzyWhitespace` fully implemented in its handler but none of them were declared in `inputSchema`. The LLM could never pass them — they were silently dropped. Fixed by spreading `ANCHOR_SCHEMA` into the inputSchema and making `startLine`/`endLine` optional (required only when no hint is provided).

### `get-surrounding-context` removed

Fully superseded by the `read-lines` rewrite. All call sites updated. Removed from `editStats`, `buildReport()`, `getEditStats()`, `resetEditStats()`, `tools[]` list, and `list-tools` handler.

### Edit stats UI — dynamic tool list

`showEditStats()` (Pulsar UI panel) previously used a hardcoded 14-entry `tools = [...]` array that was stale (included the removed `get-surrounding-context`, omitted `find_text`, `delete_block`, `sed`). Replaced with dynamic derivation from `Object.keys(editStats.session)` — the panel now always reflects the live tool set automatically.

### Smart failure suggestion engine — fires on first failure, not third

Replaced `failureSuggestion()` with `smartSuggestion(ctx)` + `successNudge(ctx)`:

- **`smartSuggestion`** fires on **failure #1** (not #3). Detects: no hints used → lists specific hints with examples; `old_str` looks like a whole function → suggests `replace-function-body`; `old_str` looks like a brace block → suggests `replace-block`; large file (>500 lines) + no hints → adds urgency. Escalates at consecutive failure **#2** (not #3).
- **`successNudge`** appended to `str_replace` success responses when no hints were used on a file >300 lines — tells you which hints you should have used, and if `old_str` looks like a function body, specifically says to use `replace-function-body` next time.
- Feedback fires at the **moment of failure in the tool response** — the only reliable way to change in-context behaviour.

### Ambiguity guard — blocks silent wrong-occurrence edits

`str_replace` now counts all occurrences of `effectiveOldStr` in the full file before committing. If `totalMatches > 1` and no scope hint is set (no `functionHint`/`afterHint`/`betweenHint`/`lineHint` and `occurrence <= 1`), the edit is **blocked** with a `⚠️ AMBIGUOUS MATCH` response listing all line numbers where it matches and the specific hints to use. Scan capped at 20 matches for performance.

Previously `str_replace` with an ambiguous `old_str` would silently replace occurrence 1 — the most dangerous silent failure mode.

`noScopeHint = false` when `occurrence > 1` (caller is already being deliberate about multiples).

### Ambiguity guard extended to `replace-block`, `replace-function-body`, `delete-block`

A shared `ambiguityCheck({needle, fullText, noScopeHint, toolName, isCodeFile})` helper now guards:

- **`replace-block`** — checks anchor string before brace-matching
- **`replace-function-body`** — checks function name via regex scan (`name\s*\(`) counting only definition-like occurrences, not call sites
- **`delete-block`** — checks `startContent` before deleting

### Bug fixes — search tool stats tracking

- **`find-text` missing `bump()`** — `find-text` had no `editStats` entry and never called `bump()` on hit or miss. Added `find_text` to the stats initializer, `buildReport()`, `getEditStats()` (session + lifetime), and `resetEditStats()`. Added `bump('find_text', 'hits')` and `bump('find_text', 'fails', 'noMatch')` in the handler.

---

## 0.5.0

### Bug fixes — buffer integrity

- **`replace-across-files` read pass** — was reading from disk (`fs.readFile`) even when a file was open with unsaved edits, then pushing the disk-based result into the live buffer via `setTextViaDiff`. Unsaved work in any open file matching the query was silently overwritten. Fixed by using `readFileOrBuffer` so the replacement is computed against the live buffer content.
- **`replace-across-files` path comparison** — used bare `===` to find the open editor for a file path, instead of `path.resolve()` like every other tool. On Windows this caused a silent miss (path casing or separator difference), causing the tool to fall through to `fs.writeFile` and bypass the buffer entirely — losing undo history. Fixed to use `path.resolve()` consistently.
- **`copy-file`** — used `fs.copyFile` which reads from disk, ignoring any unsaved edits in an open buffer. If the source file had unsaved changes the copy would be missing them silently. Fixed to detect an open editor for the source path and write from its buffer instead.
- **`grep-project`** — read from disk only, returning stale results for any file with unsaved edits. LLM would then make edits based on line numbers that didn't match the live buffer. Fixed to use `readFileOrBuffer`.
- **`search-symbol`** — same disk-only read issue as `grep-project`. Fixed to use `readFileOrBuffer`.
- **`retargetEditor` fallback** (when `buffer.setPath` is unavailable) — after destroy+reopen+setText, the undo stack contained operations against the old file path. Calling undo could silently replay them against the wrong buffer. Fixed by calling `clearUndoStack()` after setText so the history is clean rather than corrupt.
- **`create-file`** — if `workspace.open` failed after the file was already written to disk, the file was left as an orphan. Subsequent `create-file` calls would throw "file already exists" with no way to retry. Fixed by catching the open failure and unlinking the orphaned file before re-throwing.

### Improved failure diagnostics — partial match feedback

All four tools now return structured context on failure so the LLM can correct and retry in one step rather than making a separate read call:

**`str_replace` — `occurrence:N` wrong**
- Previously returned only "N matches found, you asked for M". Now also scans back and reports the actual line number of every match that *was* found, so the correct `occurrence:N` or a narrower `old_str` can be chosen immediately.

**`replace-function-body` — function name not found**
- Previously listed similar function names as bare strings. Now includes each close match's actual current signature from the buffer, so a renamed function can be corrected without a `get-function-body` round trip.

**`delete-block` — `endContent` not found**
- Previously returned only "endContent not found after line N". Now shows the 10 lines that follow the matched `startContent` anchor, so the correct `endContent` string can be picked without a separate `read-lines` call.

**`replace-block` — brace match failures**
- No opening `{` found: now shows the lines at and immediately after the anchor so the caller can verify whether it's a brace-delimited block at all.
- Unmatched `{`: now shows the content from the opening brace line so a missing `}` or unexpected nesting can be spotted without a `read-lines` call.

**`replace-across-files` — silent skips**
- Files that previously errored on read or write were silently dropped with `continue`. Now accumulated into a `skipped` array with the error reason and returned alongside `files` in the response. Write failures are also caught and reported rather than throwing uncaught. `skippedCount` is always present in the return value.

---

## 0.4.0

### New tools (P1–P8 from llm-edit-failure-modes.md)

**Edit**
- `get-region` — Return lines between two content anchor strings — content-stable equivalent of `read-lines`. No line numbers needed.
- `delete-block` — Delete lines between two content anchors (inclusive) — content-stable equivalent of `delete-line-range`. No line numbers needed.
- `replace-block` — Brace-matched block replace anchored by any content string — generalised `replace-function-body` for non-function blocks (loops, conditionals, structs).

**Debugging**
- `get-edit-stats` — Return per-tool edit statistics for the current session: hits, fail reasons (`noMatch`, `whitespace`, `partialMatch`, `outOfScope`, `afterNotFound`, `wrongOccurrence`), hint usage, fuzzy-whitespace commit count, average `old_str` length, and dry-run count. Pass `reset:true` to zero all counters after reading.
- `session-notes` — Persistent cross-session LLM notes. `action:write` appends a note (failures, fixes, lessons learned). `action:read` retrieves past notes at session start to restore context. `action:clear` wipes all notes. Survives server restarts. Stored in `session-notes.json` in the package root. Optional `project` field groups notes by codebase. This is the mechanism that turns per-session failure reasoning into persistent cross-session memory.

### New features on existing tools

**`str_replace`**
- `afterHint` — Start the search after the first occurrence of a content string in the file. Content-stable equivalent of `lineHint`, immune to line-number drift.
- `betweenHint: { start, end }` — Restrict the search to the region between two anchor strings. More precise than `afterHint` alone; useful for switch cases, struct blocks, `#ifdef` regions.
- `occurrence:N` — Replace the Nth match instead of the first. Fixes duplicate-pattern confusion without needing to widen `old_str`.
- `fuzzyWhitespace:true` — Match ignoring per-line indentation differences; commit using the buffer's actual whitespace. Eliminates the most common retry loop (fail → read → fix indent → retry).

**`insert`**
- `afterContent` / `beforeContent` — Content-anchored insert: find the anchor string and insert after/before it. Immune to line-number drift. Preferred over `insert_line` wherever possible. Supports `functionHint` and `occurrence:N` for scoping.

### Edit Stats panel (Pulsar UI)

- **Packages → MCP Server → Show Edit Stats...** opens a live stats panel showing hits, fail reasons, hint usage, and fuzzy-whitespace commit counts per tool for the current session.
- A **Reset Counters** button zeroes all session stats without requiring a server restart.
- Also accessible via right-click context menu on any editor.

### Stats instrumentation in mcp-registration.js

- Module-scope `editStats` accumulator tracks per-tool hits, fails (classified by reason), hint usage, dry-run count, and `_oldStrLenSum` (used to compute `avgOldStrLines` on read).
- `getEditStats()` and `resetEditStats()` exported for use by the Pulsar UI panel.
- Stats reset on server restart; optionally resetable mid-session via tool or panel.

---

## 0.3.0

### Breaking renames

- `replace-text` → **`str_replace`** — aligns with the Claude Code / Cline convention and makes the tool's primary behaviour (exact-string replacement) unambiguous.
- `insert-text-at-line` → **`insert`** — shorter, consistent with the Claude Code `insert` tool.

Any existing prompts or system instructions that reference the old names must be updated.

### New features on existing tools

**`str_replace` (formerly `replace-text`)**
- `functionHint` — scope the search to a named function body only. The match is rejected if `old_str` is not found inside that function. Immune to line-number drift; preferred for JS/C edits.
- `lineHint` — start the search at or after a specific 1-based line. Useful when the same text appears multiple times and `functionHint` is not applicable.
- `dryRun` — preview the match and surrounding context without writing. Returns matched lines with `►` markers. Commit by re-calling without `dryRun`.
- **Smart failure diagnostics** — on a no-match, the tool now: (a) reports whitespace/indentation differences line-by-line for each `old_str` line whose trimmed content exists in the buffer, (b) reports partial consecutive-line match count before divergence, (c) finds the closest fuzzy area via word-scoring and shows it with line numbers. Consecutive failure counter triggers a tool-switch suggestion after 3 failures.

**`insert` (formerly `insert-text-at-line`)**
- `dryRun` — preview what will be inserted and where, with surrounding context, before committing.
- Out-of-range line numbers now return a diagnostic with the end-of-file context and a failure counter.

**`delete-line-range`**
- `dryRun` — shows the lines that would be deleted (marked `✂`) with surrounding context before committing.
- Out-of-range inputs now surface a diagnostic with the end-of-file context.

**`replace-all`**
- `dryRun` — previews all match locations (up to 20 shown) before committing. Fuzzy area hint on zero-match responses.

**`replace-function-body`**
- `dryRun` — shows current function span with `►` markers and the replacement diff before committing.
- Warns when the first line of `newBody` differs from the existing signature (silent signature-change risk).
- On not-found: fuzzy function-name scoring suggests the closest matching names in the file.

**`apply-patch`**
- `dryRun` — validates the patch and shows a compact `+/-` diff of what would change without writing.
- Large-edit warning when a patch touches more than 30% of the file — suggests `replace-document` or `replace-function-body` for better token efficiency.
- On failure: fuzzy context-line scoring finds the closest matching area in the buffer and shows it with line numbers.

**`grep-file`**
- `filePath` is now optional — omit to search the active editor buffer directly.

**`get-file-summary`** and **`get-includes-and-defines`**
- `filePath` is now optional — omit to summarise the active editor.

### Moved to correct group

- `get-active-editor-info` — now correctly documented in the **Navigation** group (it was erroneously listed under Core in the README).

---

## 0.2.0

### New Tools

**File Operations**
- `move-file` — Move or rename a file. If the file is open in a Pulsar tab the buffer is retargeted in-place using `buffer.setPath()`, preserving full undo history.
- `copy-file` — Copy a file to a new path and open the copy in a new tab.
- `rename-file` — Rename a file within its current directory. Tab retargeted in-place; undo history preserved.
- `create-folder` — Create a directory (and any missing parents) at a given path.
- `rename-folder` — Rename or move a folder. All open editor tabs inside the folder are retargeted to their new paths automatically; undo history preserved per tab.
- `read-lines` — Read a specific line range from any file without loading the whole file. Buffer-first when the file is open in Pulsar.
- `file-line-count` — Return the line count of any file without loading its content. Buffer-first when the file is open in Pulsar.
- `apply-patch` — Apply a unified diff patch to the active editor buffer. Context-line anchored so it survives minor line number drift. Tracks consecutive failure count and suggests alternative tools after repeated failures. Supports `dryRun` mode.
- `list-project-functions` — List every function definition across all project files (or a glob-filtered subset).
- `replace-function-body` — Atomically replace a named function's full signature and body in the active editor in a single operation, avoiding line-number shifting.
- `replace-all` — Replace all occurrences of a string in the active editor.
- `replace-across-files` — Find and replace across all project files with glob filtering and `dryRun` support. Open files updated via buffer (undo preserved); closed files written to disk.

**Navigation**
- `goto-line` — Jump the cursor to a specific line (and optional column) in the active editor.
- `list-open-files` — List all files currently open in editor tabs.
- `get-surrounding-context` — Return lines around a target line without loading the whole file.
- `get-active-editor-info` — Quick metadata check (filename, line count, cursor position, language, modified status) without loading the full document.

**Safety**
- `checkpoint` — Save a named in-memory snapshot of the current buffer, restorable with `restore-checkpoint`.
- `restore-checkpoint` — Restore the buffer to a named checkpoint.
- `list-checkpoints` — List all saved in-memory checkpoints.
- `diff-preview` — Show a unified diff of proposed changes without applying them.

**Search**
- `grep-file` — Search a file for a pattern and return matching lines. Reads from the live buffer when the file is open in Pulsar.
- `grep-project` — Search all project files for a pattern.
- `search-symbol` — Find all uses of a C symbol across project files using whole-word matching.

**Diagnostics**
- `get-diagnostics` — Syntax-check the active C/C++ file (or all project C/C++ files) using the available compiler (gcc / clang / cl). Runs against the saved file on disk.

**Debugging**
- `get-debug-log` — Return recent MCP tool call log entries. Supports `tail`, `filter` by keyword, and `clear`.

**Highlight**
- `highlight-range` — Visually highlight a line range in the active editor with a timed fade.

**Core additions**
- `get-file-summary` — Structural summary of a file: functions, includes, defines, and TODOs.
- `save-all` — Save all modified open editor tabs in one call.
- `list-tools` — List every tool with group and enabled/disabled status. Intended as a session-start call so the LLM knows what is available without loading all schemas.
- `enable-group` — Enable a disabled tool group at runtime without reloading Pulsar.

**Ghidra group** (disabled by default)
- Full suite of Ghidra reverse-engineering tools: `list-functions`, `search-functions`, `get-function-body`, `get-xrefs`, `add-comment`, `get-function-list-with-comments`.

### Improvements
- **Buffer-first reads** — `read-file`, `read-lines`, `grep-file`, `get-includes-and-defines`, and `file-line-count` all read from the live Pulsar buffer when a file is open, so unsaved edits are always visible without requiring a save first.
- **Lazy-load tool discovery** — Tools are grouped and schemas are only sent to the LLM when a group is first used, reducing per-session token overhead.
- **Tool groups** — All tool groups can be enabled/disabled in Settings. Groups can be re-enabled at runtime by the LLM via `enable-group` with no Pulsar restart needed.
- **Windows support** — `run-command` auto-detects PowerShell on Windows. Glob matching is normalised for Windows paths.
- **apply-patch failure tracking** — consecutive patch failures are counted per session; after 3 failures the tool advises the LLM to switch strategy.
- **Decoration system** — Edited lines are highlighted in the editor after every MCP edit operation, with an 8-second fade.
- **Bug fix** — Removed duplicate `const resolvedSrc` declaration in `rename-folder` that caused a parse error on server startup.
- **Stale description fixes** — `move-file` and `rename-folder` tool descriptions and catalogue entries updated to correctly reflect that open tabs are retargeted in-place (undo history preserved), not closed and reopened.
- **Emergency revert system** — Server source files (`mcp-registration.js`, `pulsar-edit-mcp-server.js`, `ghidra-tools.js`) are automatically snapshotted on every Pulsar startup and on every save. Up to 5 timestamped backups per file are kept in `.mcp-backups/` (gitignored). A restore modal is accessible via `Ctrl+Alt+Shift+R`, the right-click context menu, or the Packages menu — completely independent of the MCP server so it works even when the server is crashed. Restoring writes the file to disk, updates the open buffer in Pulsar if the file is open, and restarts the MCP server automatically. Note: if the package itself failed to load due to a parse error, a Packages → Reload Packages or full Pulsar restart is still needed after restoring.

---

## 0.1.0 - First Release

Initial development based on:
* https://github.com/coppolaf/pulsar-edit-mcp-server/commit/f24558a80339c11f8dc063571aa12f9e1f3221b5

### Tools included at fork point
- `replace-text` — Search the active editor for `query` and replace it with `replacement`.
- `get-context-around` — Return up-to `radiusLines` lines before and after the N-th match of `query` in the active editor.
- `find-text` — Search the active editor for a substring or regular expression and return positions of each occurrence.
- `replace-document` — Replace entire contents of the document.
- `insert-line` — Insert a blank line at row.
- `insert-text-at-line` — Insert a block of text at a specified line number, shifting existing text down.
- `delete-line` — Delete a single line.
- `delete-line-range` — Delete a range of lines.
- `get-selection` — Get the selected text.
- `get-document` — Get an array of each line in the document with line numbers.
- `get-line-count` — Get the total number of lines in the current document.
- `get-filename` — Get the filename of the current document.
- `get-full-path` — Get the full path of the current document.
- `get-project-files` — Get all project files in the current project.
- `open-file` — Open a file (or move to that file's tab if already open).
- `undo` — Undo the last change in the editor.
- `redo` — Redo the last undo in the editor.
