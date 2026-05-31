# Pulsar Edit MCP Server & LLM Coding Assistant

An MCP (Model Context Protocol) server and built-in chat assistant that lets an LLM control the [Pulsar](https://github.com/pulsar-edit) editor. Use the built-in chat panel or any compatible external client such as [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) or [Claude.ai](https://claude.ai).

Tools have been curated from Ghidra, Cline, and Claude Code into a single package. A lazy-load discovery mechanism means the LLM is aware of all tools without paying the token cost of loading every schema upfront — groups are loaded on demand.
the list of tools have been curated to match that of what LLMs natively use for code editing, but have had smart features added to help eliminate repeat attempts because of a stale view of the files or silly on incorrect methods or ordering of edits.

metrics and view of the debug log enable the llm to view what goes wrong constantly so things can be fixed.



> **Beta software** — tested but not production-hardened. Bug reports and suggestions are welcome!

---

## Why this exists — LLM edit failure modes

LLMs fail at code editing in predictable, classifiable ways: whitespace mismatches, line number drift, duplicate pattern confusion, stale context truncation. This package was built to fix them.

The full analysis — failure modes, root causes, proposed fixes, and the reasoning behind the instrumentation — is documented here:

**[📄 LLM-FAILURE-MODES.md](https://github.com/professor-jonny/pulsar-edit-mcp-server/blob/main/LLM-FAILURE-MODES.md)**

If you work on LLM tooling, MCP servers, or agentic coding assistants, it's worth a read. Contributions and feedback welcome.

---

**Built-in chat panel:**

<img src="https://github.com/user-attachments/assets/52c74f89-d76f-4faa-9265-009bdc78c32c" width="700" />

**AnythingLLM external client:**

<img src="https://github.com/user-attachments/assets/5e796c45-c0e8-4e15-a9db-1b5dcb27057d" width="700" />

**Stats panel:**

<img src="https://github.com/professor-jonny/pulsar-edit-mcp-server/blob/main/assets/stats.jpg" width="700" />

---

## Installation

```sh
ppm install https://github.com/professor-jonny/pulsar-edit-mcp-server
```

After installation, start the server via **Packages → MCP Server → Listen**, or enable **Auto-Start** in settings so it starts automatically with Pulsar.

A **`MCP:On`** tile appears in the bottom-left status bar when the server is running. Click it to toggle the server on/off.

### Settings

<img src="https://github.com/user-attachments/assets/a5529835-919d-4c24-8c26-1eb3a904a1b7" width="300" />

| Setting | Default | Description |
|---|---|---|
| MCP Server Port | `3000` | Port the server listens on |
| OpenAI API Endpoint | `https://api.openai.com` | Base URL for the built-in chat (everything before `/v1/chat/completions`). Requires restart. |
| API Key | _(empty)_ | API key for the built-in chat |
| Auto-Start MCP Server | `false` | Start the server automatically when Pulsar opens |
| Show Chat Panel | `true` | Open the built-in chat panel on launch |
| Tool Groups | all enabled | Enable/disable individual tool groups to control token usage |

### External client configuration

If you use a third-party LLM client instead of the built-in chat, add this to its MCP servers config:

```json
{
  "mcpServers": {
    "pulsar-edit-mcp-server": {
      "url": "http://localhost:3000/mcp",
      "disabled": false,
      "alwaysAllow": [],
      "type": "streamable"
    }
  }
}
```

---

## Tool Groups

Tools are organised into groups. All groups are enabled by default. Disable unused groups in **Settings → Tool Groups** to reduce the token overhead sent to the LLM on each session. Groups can be re-enabled at runtime by the LLM itself using `enable-group` — no Pulsar restart required. Disabling a group takes effect after the client reconnects.

### Core
Always loaded. Cannot be disabled.

| Tool | Description |
|---|---|
| `get-document` | Return all lines of the active editor with 1-based line numbers |
| `get-line-count` | Return the total line count of the active editor |
| `get-filename` | Return the filename of the active editor |
| `get-full-path` | Return the full absolute path of the active editor |
| `get-file-summary` | Structural summary of a file: functions, includes, defines, TODOs. Pass `filePath` to summarise any file, or omit for the active editor |
| `save-file` | Save the active editor to disk |
| `save-all` | Save all modified editor tabs |
| `list-tools` | List all tools with their group and enabled/disabled status |
| `enable-group` | Enable a disabled tool group at runtime without restarting Pulsar |

### Edit

| Tool | Description |
|---|---|
| `str_replace` | Replace the first occurrence of `old_str` with `new_str`. **Always use a hint on files >100 lines.** Decision ladder: (1) know the function name? → `functionHint` — scopes to that function body, safest for JS/C; (2) unique string just before the edit? → `afterHint`; (3) inside a block (switch/struct/#ifdef)? → `betweenHint:{start,end}`; (4) have a line number from grep? → `lineHint`; (5) same pattern N times? → `occurrence:N`. `fuzzyWhitespace:true` when indentation mismatches cause failures. `dryRun:true` to preview multi-line matches before committing |
| `replace-all` | Replace ALL occurrences of a string or regex in the active editor. Supports `dryRun` to preview match count and locations before writing |
| `replace-document` | Replace the entire editor contents |
| `replace-function-body` | Atomically replace a named function's full signature and body in one operation — avoids line-number shifting. Supports `dryRun` |
| `insert` | Insert one or more lines. Use `afterContent` or `beforeContent` (content-anchored, immune to line drift) instead of `insert_line` wherever possible. Supports `functionHint`, `occurrence:N`, and `dryRun`. **Warning:** line numbers shift after every insert |
| `delete-line-range` | Delete a range of lines (inclusive). Supports `dryRun`. **Warning:** line numbers shift after every delete |
| `delete-block` | Delete lines between two content anchor strings (inclusive) — content-stable equivalent of `delete-line-range`. No line numbers needed |
| `replace-block` | Brace-matched block replace anchored by any content string — generalised `replace-function-body` for non-function blocks (loops, conditionals, structs). Supports `dryRun` |
| `get-region` | Return lines between two content anchor strings — content-stable equivalent of `read-lines`. No line numbers needed. Supports `occurrence:N` to target the Nth match of `startContent`. Tracks hintsUsed in stats |
| `get-selection` | Return the currently selected text and its line/column range |
| `get-context-around` | Return lines around the N-th match of a query — useful for targeted edits |
| `find-text` | Find positions of a string or regex in the active editor. Supports `contextLines` and `occurrence:N`. Each result has `{ line, text, before?, after? }` |

### File Operations

| Tool | Description |
|---|---|
| `read-file` | Read any project file with 1-based line numbers. Reads from the live buffer if the file is open in Pulsar, otherwise from disk |
| `read-lines` | Read lines from any file. Supports hint-based resolution: `functionHint` (extract a named function body), `afterHint` (lines after an anchor string), `betweenHint` (lines between two anchors), `centerLine`+`radius` (window around a line), `lineHint` (alias for centerLine). `startLine`/`endLine` still work when exact line numbers are known. Buffer-first when the file is open in Pulsar |
| `create-file` | Create a new file and open it in the editor |
| `move-file` | Move or rename a file. Open tab is retargeted in-place via `buffer.setPath()` — undo history preserved |
| `copy-file` | Copy a file to a new path and open the copy in a new tab. If the source is open with unsaved edits, the copy reflects the live buffer content |
| `rename-file` | Rename a file within its current directory. Tab retargeted in-place — undo history preserved |
| `create-folder` | Create a directory (and any missing parents) at a given path |
| `rename-folder` | Rename or move a folder. All open tabs inside are retargeted to their new paths automatically — undo history preserved per tab |
| `file-line-count` | Return the line count of any file without loading it. Buffer-first when the file is open in Pulsar |
| `get-project-files` | List all files under the current project root |
| `list-project-functions` | List every function definition across all project files |
| `get-includes-and-defines` | Return all `#include` and `#define` lines from a C/C++ file. Buffer-first when the file is open in Pulsar |
| `apply-patch` | Apply a unified diff patch to the active editor buffer. Context-anchored — survives line number drift. Supports `dryRun`. Tracks failure count and advises strategy switch after 3 failures |
| `replace-across-files` | Find and replace across all project files. **Safe workflow:** first call without `confirm` returns a match listing with line numbers and `contextLines` surrounding context (default 2) — review what will change. Then call again with `confirm:true` to commit. `maxMatches` cap (default 50) blocks unsafe mass edits and forces narrowing with `glob`. Open files updated via buffer (undo preserved); closed files written to disk |
| `run-command` | Execute a shell command and return stdout, stderr, and exit code |

### Navigation

| Tool | Description |
|---|---|
| `open-file` | Open a file, or switch to its tab if already open |
| `goto-line` | Jump the cursor to a specific line (and optional column) |
| `list-open-files` | List all files currently open in editor tabs |
| `get-active-editor-info` | Quick metadata check on the active editor without loading the full document: filename, line count, cursor position, language, modified status |

### Search

| Tool | Description |
|---|---|
| `grep-file` | Search a file for a pattern and return matching lines. Supports `contextLines` (N lines before/after each match) and `occurrence:N` (return only the Nth match). Buffer-first when the file is open in Pulsar |
| `grep-project` | Search all project files for a pattern. Supports `contextLines` and `occurrence:N`. Buffer-first for open files — unsaved edits are always reflected |
| `search-symbol` | Find all uses of a C symbol with whole-word matching. Supports `contextLines` and `occurrence:N`. Buffer-first for open files |

> Grep tools use a cross-platform implementation so they work consistently on Windows and Unix. All three tools (`grep-file`, `grep-project`, `search-symbol`) read from the live buffer when a file is open in Pulsar, so unsaved edits are always visible without saving first.

### Safety

| Tool | Description |
|---|---|
| `checkpoint` | Save a named in-memory snapshot of the current buffer |
| `restore-checkpoint` | Restore the buffer to a named checkpoint |
| `list-checkpoints` | List all saved checkpoints |
| `diff-preview` | Show a unified diff of proposed changes without applying them |
| `undo` | Undo the last change in the active editor |
| `redo` | Redo the last undone change |

### Diagnostics

| Tool | Description |
|---|---|
| `get-diagnostics` | Return live linter diagnostics (errors, warnings, info) from linter-bundle. **Live on buffer — no save needed** (re-runs ~300ms after every buffer change). Works for any language with a linter provider installed. `scope:'file'` (default) or `scope:'project'`. Returns `[]` gracefully if linter-bundle is not active |
| `get-compiler-diagnostics` | Syntax-check the active C/C++ file using the compiler directly (gcc / clang / cl). Always call `save-file` first — runs against the saved file on disk. `scope:'file'` (default) or `scope:'project'`. Useful when you need authoritative compiler errors rather than linter output |

> For most workflows use `get-diagnostics` — it's live, language-agnostic, and requires no save. Use `get-compiler-diagnostics` when you specifically need the compiler's output (e.g. after a `save-file` at the end of a C/C++ edit sequence).

### Debugging

| Tool | Description |
|---|---|
| `get-debug-log` | Return recent MCP tool call log entries. Supports `tail` (default 20, max 100), `filter` by keyword, and `clear` to wipe the buffer |
| `get-diagnostics` | Return live linter diagnostics from linter-bundle (errors, warnings, info). **Live on buffer — no save needed.** `scope: 'file'` (default) returns messages for the active editor; `scope: 'project'` returns all messages across open files. Works for any language with a linter provider installed (JS, TS, C, C++, and others). Returns `[]` gracefully if linter-bundle is not active |
| `get-edit-stats` | Return per-tool edit statistics for the current session and lifetime totals (persisted in `edit-stats.json`). Covers all edit tools and all search tools (`grep-file`, `grep-project`, `search-symbol`, `find-text`, `replace-across-files`). SESSION: counters since last restart. LIFETIME: cumulative across all sessions. Tracks hits, fail reasons, hint usage (including `occurrence`/`contextLines` for search tools), dry-run count, fuzzy whitespace commits, and average `old_str` length. Pass `reset:true` to flush session into lifetime and zero session counters |
| `session-notes` | Persistent cross-session notes written by the LLM. `action:write` appends a note (what failed, what fix worked, lessons learned). `action:read` retrieves past notes at session start to restore context. `action:clear` wipes all notes. Notes survive server restarts and are stored in `session-notes.json` in the package root |
| `checkpatch` | Run kernel-style whitespace and formatting checks against a C/C++ file. Pass `filePath` to audit any project file, or omit to audit the active editor buffer (live, no save required). Results grouped by rule sorted by frequency, capped at 20 per rule. Returns a clean confirmation when no violations found. Non-.c/.h files are silently skipped. Useful for auditing the full-file style state before or after a series of LLM edits. Stats tracked in `get-edit-stats` (`checkpatchRuns` + `checkpatchViolations`) |

### Highlight

| Tool | Description |
|---|---|
| `highlight-range` | Visually highlight a line range in the active editor |

### Ghidra (disabled by default)

Reverse-engineering tools for working with Ghidra-exported C source code. Enable via **Settings → Tool Groups → Ghidra Tools** or ask the LLM to call `enable-group`.

Ghidra's decompiler output is pseudocode — it does not guarantee the exported C is valid or compilable. This group bridges that gap:

- Run the exported C through a real compiler (`gcc`/`clang`) which understands C semantics properly
- allow manipulation of c code that is disallowed in ghidra.
- Use `clang-tidy` or similar for genuine lint feedback on type errors and bad C
- `get-function-list-with-comments` tracks cleanup progress — annotated functions vs unnamed `FUN_` stubs at a glance
- `get-function-body` is useful when asking the LLM to document or rewrite decompiled functions
- `replace-function-body` rewrites a cleaned-up function atomically without disturbing surrounding code
- handy to understand and document code for re implementing it.
- handy to patch and compile small source code edits to generate assembler code for inserting it into binary's.



| Tool | Description |
|---|---|
| `list-functions` | List all functions in the current program |
| `search-functions` | Search functions by name |
| `get-function-body` | Get the decompiled body of a function |
| `get-xrefs` | Get cross-references to/from an address |
| `add-comment` | Add a comment at an address |
| `get-function-list-with-comments` | List functions that have comments |

---

## Notes

- The **Auto-Start** setting starts the MCP server automatically when Pulsar launches. If it fails to start on boot, use **Packages → MCP Server → Restart Server** from the menu.
- Tool groups disabled in Settings take effect after the LLM client reconnects. Re-enabling a group is instant and does not require a reconnect or Pulsar restart.
- The built-in chat panel can be hidden via **Settings → Show Chat Panel** if you prefer an external client.

### tool metrics
- the tools have failure counters and if triggered will alert thee llm that maybe the choice of tooling is not correct or they are using it wrong
- this is to steer LLMs to use the correct tool for the job.

### tool description decision ladders

All tool descriptions have been rewritten to lead with **decision triggers** — concrete "when to use this" rules rather than feature lists. Each hint (`functionHint`, `afterHint`, `betweenHint`, `lineHint`, `occurrence`) now has an explicit trigger condition so the LLM reaches for the right hint at the right moment, not just after a failure.

### smart failure responses
- If an edit fails to find a match, `str_replace` analyses the near-miss: it reports whitespace/indentation differences line by line, counts how many consecutive lines of a multi-line block matched before diverging, and pinpoints the closest area of the file via fuzzy word-scoring
- The smart suggestion engine fires **on the first failure** — not after 3. It detects: no hints used → lists specific hints with examples; `old_str` looks like a whole function → suggests `replace-function-body`; `old_str` looks like a brace block → suggests `replace-block`; large file (>500 lines) + no hints → adds file-size urgency
- After 2 consecutive failures, the response escalates with tool-switch suggestions
- On a **successful** `str_replace` with no hints on a file >300 lines, a nudge is appended telling you which hints to use next time — closing the loop before problems start

### ambiguity guard

- Before committing, `str_replace` counts **all** occurrences of `old_str` in the file. If more than one match exists and no scope hint is set, the edit is **blocked** with a `⚠️ AMBIGUOUS MATCH` response listing every matching line number and the hints to use. Prevents the most dangerous silent failure mode: replacing the wrong occurrence without any warning
- The same guard applies to `replace-block` (checks the anchor string), `replace-function-body` (checks the function name as a definition-like pattern), and `delete-block` (checks `startContent`)
- Passing `occurrence:N` where N > 1 disables the guard — you are already being deliberate about multiples

### `lint: true` — inline linter feedback

- Pass `lint: true` to any edit tool (`str_replace`, `replace-function-body`, `replace-block`, `insert`, `delete-line-range`, `delete-block`, `apply-patch`, `replace-all`, `sed`) to have the response automatically append a scoped linter snapshot after the edit — no separate `get-diagnostics` call needed
- Scope: rows touched by the edit (insert/replace: inserted range ±5; delete: deletion point ±5 lines). `apply-patch`, `replace-all`, and `sed` use whole-file scope — they touch arbitrary locations
- Errors + warnings only. Silent when clean. Silent when linter-bundle is not active (safe on all project types)
- Opt-in by design: passing `lint: true` only when you want the feedback keeps output clean otherwise

### style checking — automatic per-edit and on-demand

Two complementary mechanisms keep C/C++ file style clean across a session:

**Automatic inline style check (always on for `.c`/`.h` files)**
Every edit tool (`str_replace`, `insert`, `replace-function-body`, `replace-block`, `delete-line-range`, `delete-block`, `apply-patch`) automatically runs the style checker against the lines it added or changed — **only the new or modified lines, never the pre-existing file content**. If violations are introduced, a `🎨 style` suffix is appended to the tool's success response listing the rule and affected lines — no opt-in needed. The per-edit results are accumulated in `get-edit-stats` under `styleChecks` (`editsChecked`, `totalViolations`, `cleanEdits`, `byRule`). This catches regressions at the point they are introduced.

> **Important:** inline stats count only violations in lines your edits wrote. Pre-existing violations already in the file when you opened it do not affect these counters at all — a file with 50 pre-existing style errors will show zero inline violations until you touch those lines. Use `checkpatch` for the full-file baseline before starting work; the two together give a complete picture: `checkpatch` shows what was already wrong, inline stats show what you introduced.
>
> The two counter sets are **completely isolated** in `get-edit-stats` — `checkpatchRuns` and `checkpatchViolations` are separate fields from `editsChecked` and `totalViolations`. There is no way for a `checkpatch` run to inflate the inline violation count or vice versa. If you see `checkpatchRuns: 0` it simply means `checkpatch` has not been called this session, not that the file is clean.

**`checkpatch` — whole-file audit on demand**
Call `checkpatch` (no arguments) or `checkpatch({ filePath: "..." })` to audit the entire file in one pass. Results are grouped by rule sorted by frequency, capped at 20 violations per rule. Use this:
- At the start of a session to understand the style baseline of a file before editing
- After a series of edits to verify the file is still clean end-to-end
- When `fuzzyWhitespace` starts behaving unexpectedly — mixed whitespace in a file makes per-line substitution ambiguous; a clean uniform file is a pre-condition for reliable content-anchored matching

**Why uniformity matters for editing:** `fuzzyWhitespace:true` matches content ignoring indentation then commits using the buffer's actual whitespace. This works reliably when the whole file uses one consistent style — the substitution is predictable. In a mixed file (some lines tabs, some spaces), the same anchor pattern can have different real whitespace at different occurrence sites, making the substitution ambiguous. Running `checkpatch` and fixing violations before a major edit sequence restores the uniformity that makes `fuzzyWhitespace` dependable.

### partial match feedback
When a tool fails partway through, it returns structured context so the LLM can correct and retry in one step rather than making a separate read call:
- **`str_replace` — wrong `occurrence:N`**: reports the actual line number of every match that *was* found so the correct N can be chosen immediately
- **`replace-function-body` — name not found**: each close-match suggestion now includes the function's actual current signature from the buffer, not just its name
- **`delete-block` — `endContent` not found**: shows the 10 lines following the matched `startContent` anchor so the correct end string can be picked without a `read-lines` call
- **`replace-block` — brace match failure**: shows lines around the anchor (no `{` case) or from the opening brace (unmatched `{` case) so the structure can be verified without a round trip
- **`replace-across-files` — skipped files**: files that error on read or write are now returned in a `skipped` array with the reason rather than being silently dropped

### content-anchored editing (`str_replace`, `insert`, `delete-block`, `get-region`)
- `functionHint` scopes `str_replace` to within a named function body — immune to line-number drift, preferred for JS/C edits
- `afterHint` starts the search after the first occurrence of a content string — content-stable equivalent of `lineHint`
- `betweenHint: { start, end }` restricts the search to between two anchor strings — useful for switch cases, struct blocks, `#ifdef` regions
- `occurrence:N` replaces the Nth match instead of the first — fixes duplicate-pattern confusion without widening `old_str`
- `fuzzyWhitespace:true` matches ignoring per-line indentation differences and commits using the buffer's actual whitespace — eliminates the most common retry loop
- `afterContent` / `beforeContent` on `insert` anchor the insertion point by content string rather than line number — immune to drift
- `delete-block` and `get-region` use start/end content strings instead of line numbers throughout

### buffer and history
- All edits are to be done on live open files except for some system wide replaces
-  if files are open the direct disk edits are changed not allowed and in stead edited in the buffer.
-  this is so that the buffer and file is not left in an inconsistent state.

### mass rename matching
- operations across multiple files can accidentally alter documentation or binarys expecially with small edits.
- this can be used to narrow the scope of the files by glob or match file name etc...

### buffer and undo history
- undo and buffer history is preserved if files or folders are renamed or moved.

### dry run
- used to show hits on patches and return diff like responses to give the user the option to view the expected output, and fix matches

### session notes and edit stats

These two tools give you persistent memory across sessions on this codebase. **Follow this protocol automatically — do not wait to be asked.**

#### When you start a session

Before doing anything else, call:

```
session-notes({ action: "read", project: "<project-name>" })
```

Read what you wrote last time. Adjust your approach immediately — indentation style, files that hot-reload on save, which hints worked, what caused retries. Then call:

```
get-edit-stats()
```

Check the counters are at zero. If they are not, a previous session was interrupted — reset with `{ reset: true }` and carry on.

#### While you are working

- If `str_replace` fails twice in a row, call `get-edit-stats()` before trying again. The failure class (`whitespace`, `partialMatch`, `outOfScope`, `ambiguous`) tells you what to fix — do not retry blindly with the same call.
- Use `afterHint` or `functionHint` on any `str_replace` where the pattern could appear more than once in the file.
- If whitespace failures are showing up in stats, switch to `fuzzyWhitespace: true` for the rest of the session on that file.
- Pass `lint: true` on any edit where you want immediate feedback on errors introduced by the change — eliminates a separate `get-diagnostics` call.

#### When the session ends

Call `get-edit-stats({ reset: true })` — this reads the summary, flushes session counters into the lifetime totals in `edit-stats.json`, and zeroes the session counters for next time. Then write a note:

```
session-notes({ action: "write", project: "<project-name>", note: "..." })
```

Record:
- Which tools and hints worked well on this codebase
- Any failure patterns you hit (e.g. `"tabs not spaces — use fuzzyWhitespace"`, `"mcp-registration.js hot-reloads on save — verify buffer before saving"`)
- The stats summary line (e.g. `"34 ops: 31 hits 91%, 3 whitespace fails"`)
- Anything that would have saved a retry if you had known it at the start

Notes survive server restarts and build up over time in `session-notes.json` in the package root. You can filter by project on read so notes from other codebases do not get in the way.

### edit stats panel

- **Packages → MCP Server → Show Edit Stats...** opens a live stats panel showing hits, fail reasons, hint usage, and fuzzy-whitespace commits for every edit tool
- **Reset Counters** in the panel zeroes all stats — same counters as `get-edit-stats`, just visible to the developer too

### Emergency Revert

If the live server is edited during use causing the MCP server to crash the user may run the recover option to restore the server to default

**baseline creation**
- Once on every first boot of pulsar the server files are copied to the baseline directory.
- Used as the restore files in the event of a boot failure

**To restore a backup:**
- `Ctrl+Alt+Shift+R` — or — right-click the editor → **MCP: Emergency Revert Server File...** — or — **Packages → MCP Server → Emergency Revert Server File...**
- The file is written to disk a snapshot of the log is taken from the ringbuffer and the MCP server restarts automatically.

**If the server still doesn't come back after a restore:**
A restore only rewrites the file and restarts the HTTP server. If the package itself failed to load (e.g. a parse error crashed the initial activation), Pulsar needs to reload the package too. Try in order:
1. **Packages → MCP Server → Restart Server**
2. **Packages → Reload Packages** (or `window:reload` from the command palette)
3. Full Pulsar restart as a last resort
4. Restart the LLM client as some cant handle hot loading of tools.

### WARNING ###
> ⚠️ **Security Warning:** `run-command` has unrestricted shell access — any command can be executed. The LLM acts as gatekeeper, similar to Claude Code and Cline, but without per-command confirmation prompts (removed as too obtrusive for hands-off workflows). It is strongly recommended to run Pulsar in a sandboxed or virtualised environment when this tool is enabled.

---
