## 0.8.9

### Stats zeroing on hot-reload — fixed

**Root cause:** `loadMcpModules()` hot-reloads `mcp-registration.js` on every new MCP session (each time Claude Desktop reconnects). The new module instance calls `loadLifetimeStats()` which reads from disk. But the 5-second flush interval from the *old* instance hadn't fired yet, so any stats accumulated since the last flush were in memory only — lost the moment the new instance loaded fresh from disk.

**Fix:** `loadMcpModules()` now calls `mcpDeactivate()` before the `import()` call. `mcpDeactivate` is the `deactivate()` export from `mcp-registration.js` — it does `syncToLifetime()` + synchronous `writeFileSync` to disk. This guarantees the old instance's in-session counts are persisted before the new instance reads from disk. `mcpDeactivate` is `null` on the very first load (no previous instance), guarded accordingly.

## 0.8.8

### `run-command` — chat panel output fix + `showOutput` control

**Bug fixed:** `chatPanelRef` was `null` after a Pulsar workspace restore. The panel opener only fires when `atom.workspace.open()` creates a new instance — on warm boot Pulsar restores the panel silently without calling the opener, so `chatPanelRef` stayed `null` and all streaming was swallowed. Fix: after the `open()` call in `activate()`, scan `atom.workspace.getPaneItems()` for an existing `ChatPanel` instance and assign it to `chatPanelRef` if found.

**`showOutput` param added to `run-command`:** Controls whether stdout/stderr streams live to the chat panel (default `true`). Set `showOutput: false` for noisy diagnostic commands (long file listings, verbose build output) where you only want the final result returned to the LLM, not the panel flooded. Spawn errors always show regardless of `showOutput`.

**Stray `console.log` removed** from run-command handler.

## 0.8.7

### `get-repo-map` — `excludeGlob` filter added

Added `excludeGlob` parameter to `get-repo-map`, matching the filtering pattern used by `replace-across-files`, `grep-project`, and other tools. Applied after `glob` to exclude files/folders from the symbol walk — e.g. `excludeGlob: 'test/**'` or `excludeGlob: '**/*.test.js'`. Uses the existing `globToRegex` helper; no new infrastructure needed.

## 0.8.6

### `get-repo-map` — full Aider-equivalent rewrite

Replaced the v0.8.5 regex+ref-count implementation with a full Aider-style repo map:

**Symbol extraction:** Tree-sitter via Pulsar's WASM layer (`editor.getBuffer().getLanguageMode().rootLanguageLayer`) for any file currently open in an editor tab. Falls back to regex for closed files. Tree-sitter captures `@definition.*` + `@name` pairs from the language's `tags.scm` query — gives accurate full signatures including return type and parameters.

**PageRank ranking:** Builds a directed file→file reference graph weighted by `sqrt(ref_count)`. Runs 20-iteration power-iteration PageRank with optional personalisation via `mentionedFiles` parameter (50× boost for mentioned files). Distributes file rank across its symbols proportional to each symbol's reference share.

**TreeContext rendering:** Groups symbols by file, sorted by file PageRank descending. Within each file, sorts by line number. Renders actual source signature lines with `│` prefix and `⋮...` ellipsis between non-consecutive lines — same format as Aider's `grep-ast` TreeContext.

**Token budget:** `maxTokens` parameter (default 1024 ≈ 4096 chars at ~4 chars/token). Binary search on symbols-per-file cap to find the maximum content that fits in budget.

**Parameter changes:** `maxSymbols` → `maxTokens`; `mentionedFiles` array added. `includeLineNumbers` and `minRefs` unchanged.

**Requires full restart + babel cache clear** (inputSchema changed).

---

## 0.8.5

### `get-repo-map` — compressed codebase symbol index

New tool in the SEARCH group. Returns a compact plain-text tree of all function symbols across the project, grouped by file, sorted by cross-file reference count. Designed as a first-call orientation tool for unfamiliar codebases — fits the whole project structure in ~1000 tokens.

**Output format:**
```
src/hal.c
  hal_read()               L45   ← 8 refs
  hal_write()              L78   ← 3 refs
  hal_init()               L12
```

**Parameters:** `glob` (default `**/*.{c,cpp,h,hpp,js,ts,jsx,tsx}`), `maxSymbols` (default 150), `minRefs` (default 0), `includeLineNumbers` (default true).

**Algorithm:** walks all project files, extracts function symbols with a C/JS-aware regex, counts cross-file word-boundary references for each symbol, ranks by ref count, truncates to `maxSymbols`, renders as grouped plain-text tree sorted by file ref weight.

Stats wired into session and lifetime `get-edit-stats` reporting under `get_repo_map`.

---

## 0.8.4

### Chat panel — copy/paste support + streaming fixes

**Missing `appendOutput` / `appendFault` methods**
`chat-panel.js` was missing both methods called by `mcp-registration.js` — run-command streaming output and tool fault visibility were silently no-ops. Added both methods following the `showError` pattern.

**Multiline chunk display**
stdout/stderr chunks arriving as multi-line blocks were displayed as one blob. Fixed to split on `\n` and append each line as a separate div so output is always line-per-line regardless of how PowerShell batches output.

**Text selection and copy**
Chat panel output was not selectable (mouse drag or Ctrl+C). Root cause: Pulsar's `settings-view` class sets `user-select: none` on the panel root. Fixed by adding `user-select: text` and `-webkit-user-select: text` to both `.chat-panel` and `#chat-display` in the LESS file.

**Right-click context menu — output area**
Right-click showed only Pulsar pane split options. Fixed by registering `atom.contextMenu.add()` scoped to `.chat-panel #chat-display` with Copy and Select All items, backed by `atom.commands.add()` using `execCommand('copy')` and `window.getSelection()`.

**Right-click context menu + paste — input textarea**
Paste (Ctrl+V and right-click) was not working in the chat input box. Added `user-select: text` and `-webkit-user-select: text` to `#chat-input` in LESS, and extended the context menu to cover `.chat-panel #chat-input` with Cut, Copy, Paste, and Select All items.

**Misc cleanup**
Removed dead `static mcpClient`/`static llmModel` fields (caused ESLint parse error), removed `console.log` from `setMcpClient()`, re-applied `setModel: _setModel` unused-var rename.

---

## 0.8.3

### `chat-functions.js` bug fixes + dead import removal

**`clearContextHistory` bug**

`clearContextHistory()` was zeroing the array with `length = 0`, wiping the system prompt alongside the conversation history. Fixed to reset to `[{role: "system", content: systemPrompt}]` so the system prompt is always preserved. Also clears the `mcpTools` cache so the tool list re-fetches cleanly on the next LLM call.

**`max_tokens` hardcoded at 1000**

`callLLM()` had `max_tokens: 1000` hardcoded — too low for most coding responses. Now reads `atom.config.get('pulsar-edit-mcp-server.maxTokens') || 4096`. Added `maxTokens` to `package.json` configSchema (integer, default 4096, min 256) so it is user-configurable from Settings.

**Tool call visibility in chat panel**

Each MCP tool call now shows `🔧 \`tool-name\`` in the chat panel before the call is dispatched. Uses the existing `updateChatHistory()` method — no new UI code needed.

**Dead `style-checker` import removed**

`mcp-registration.js` had a stale `import { checkLines as styleCheckLines, formatViolations as styleFormatViolations, isKernelFile } from './style-checker'` at line 7. The file `style-checker.js` does not exist at that path, causing `ERR_MODULE_NOT_FOUND` on load and silently preventing all tools from registering (only ghidra-tools.js, loaded separately, was working). None of the three imported symbols were used anywhere in the file. Import removed.

---

## 0.8.2

### `restartServer` hang fix + ghidra-tools console.log cleanup

**`restartServer` hang (root cause of "only ghidra tools loading")**

`restartServer()` was deadlocking on `await new Promise(resolve => this.serverInstance.close(resolve))` — the built-in MCP client keeps a persistent keep-alive connection open, so `server.close()` never resolves. This meant `startMcpClient()` never ran, no new MCP session was initialized, and `loadMcpModules()` never fired. The ghidra tool `console.log` calls fire at module parse time (not registration time), so they appeared in the console even when registration never happened — making it look like only ghidra tools were loading when in fact nothing was registering.

Fix: close all active transports first, then use `Promise.race(server.close(), 500ms timeout)` + `server.closeAllConnections?.()` so `restartServer()` never hangs regardless of open connections.

**ghidra-tools.js console.log cleanup**

Removed 6x `console.log("Registering Tool: " + curTool)` lines — same noise removed from `mcp-registration.js` in 0.7.x. `replace-all` confirmed 6 matches, committed in one operation.

---

## 0.8.1

### Chat panel — tool fault visibility, destructive command confirmation, drag-and-drop, show panel command

**Tool fault visibility**

Every MCP tool error now appears in the chat panel as a red `⚠ tool-name: message` block, so failures are visible to the developer in real time rather than silently disappearing into the LLM context.

- `mcp-registration.js`: thin `wrapHandler` closure patched onto `server.registerTool` at the top of `mcpRegistration()`. All tool handler throws are intercepted, `chatPanel.appendFault(name, err.message)` is called, then the error is re-thrown so the MCP SDK still returns an error response to the LLM. Zero changes to individual tool handlers.
- `chat-panel.js`: `appendFault(toolName, message)` method added — dark red box with amber left border, same append/autoscroll pattern as `appendOutput`.

**Destructive command confirmation**

`run-command` now pauses and shows a **Run / Cancel** widget in the chat panel before executing any command matching a destructive pattern (`rm`, `rmdir`, `del`, `rd`, `format`, `Remove-Item`, `ri`, `rd /s`). The MCP response is held in a Promise until the user clicks.

- `confirm: boolean` parameter added to `run-command` inputSchema — pass `confirm:true` to bypass the UI for LLM-driven automation flows.
- If the chat panel is not open, destructive commands are blocked outright and return a JSON error rather than running silently.
- `styles/pulsar-edit-mcp-server.less`: `.chat-command-confirm` class (amber left border, dark amber background) + `.chat-command-fault` (dark red).

**Drag-and-drop path inserter**

Drop a file from the filesystem onto the chat textarea → the file's path is inserted at the cursor position. File contents are never read — the LLM uses `read-file` or `grep-file` as needed, keeping the context window lean.

- `chat-panel.js`: `dragover` + `drop` listeners on the textarea. Uses `event.dataTransfer.files[n].path` and inserts at `selectionStart`.

**Show Chat Panel command**

Reopens the chat panel at any time without restarting Pulsar. Previously the only way to get it back was to restart with the `showChatPanel` setting enabled.

- `pulsar-edit-mcp-server.js`: `pulsar-edit-mcp-server:show-chat-panel` command calls `atom.workspace.open('atom://pulsar-edit-mcp-server/chat')`. Pulsar's opener deduplicates — returns the existing panel if alive, creates a new one if closed.
- `menus/pulsar-edit-mcp-server.json`: **Packages → MCP Server → Show Chat Panel** and right-click context menu entry added.

---

## 0.8.0

### `run-command` — live output streaming to chat panel

`run-command` now streams stdout and stderr to the built-in chat panel in real time as the process runs, rather than buffering all output until the process exits.

- `chat-panel.js`: added `appendOutput(text, type)` method. Creates a `div` with CSS classes `chat-command-output` + `chat-command-{type}` (types: `stdout`, `stderr`, `info`, `exit`), appends to `#chat-display`, and autoscrolls. The command line itself is shown as an `info` entry (`$ command`) before execution starts.
- `mcp-registration.js`: `spawn` added to `child_process` imports. `mcpRegistration()` gains a fifth parameter `chatPanel = null`. The `run-command` handler replaces the previous `exec`-based implementation with `child_process.spawn` — `stdout` and `stderr` data events stream chunks to `chatPanel.appendOutput()` live and accumulate into full buffers. Process close resolves the MCP response with the same shape as before (stdout, stderr, exitCode). Timeout handled via `setTimeout` + `proc.kill()`. A `run_command` entry (`hits`, `fails.spawnError`) is added to `editStats`.
- `pulsar-edit-mcp-server.js`: `chatPanelRef` module-level variable added (same pattern as `linterRegistry`) and set alongside `this.chatPanel = new ChatPanel()`. The `autoStart` block now checks `atom.packages.hasActivatedInitialPackages()` first so warm-boot timing is handled correctly — if initial packages have already activated, `restartServer()` is called immediately rather than registering a callback that will never fire.

All `chatPanel` calls in the handler are guarded with `if (chatPanel)` — safe when the panel is not open.

**Boot fix:** `await atom.workspace.open()` in `activate()` delayed execution past `onDidActivateInitialPackages`, so `restartServer()` was never called on a warm boot. Fixed by checking `hasActivatedInitialPackages()` first. `getUserValue` (not a real Pulsar API) replaced with `getSchema(key).default` comparison.

---

## 0.7.9

### Stats pause/resume — UI toggle

Added a **⏸ Pause Stats / ▶ Resume Stats** toggle to the Edit Stats panel. When paused, `bump()` is a no-op so tool hits and fails are not recorded — useful when working on Ghidra pseudocode or other non-standard files where failures would skew hit-rate stats.

- `mcp-registration.js`: `let statsPaused = false` module-level flag; `bump()` returns early when set; `getEditStats()` response includes `paused: true/false`; `toggleStatsPause()` exported for the UI.
- `pulsar-edit-mcp-server.js`: Stats panel gets a yellow **⏸ STATS PAUSED** banner and a Pause/Resume button that updates reactively without reopening the panel. No new MCP tools — UI-only.

### Lint cleanup

Resolved all ESLint warnings and errors across the open file set:

- **`mcp-registration.js`**: `5_000` numeric separator → `5000` (parse error — ESLint ecmaVersion does not support ES2021 numeric separators). Nine unused variables prefixed `_`: `ANCHOR_DESC`, `failureSuggestion`, `searchTo`, `flag` (destructure rename), `pattern` (regex validate-only block in replace-across-files), `hintLabel`, `fnRe`, `diffHunks`, `lineNo`.
- **`pulsar-edit-mcp-server.js`**: Removed unused `import { z } from "zod"`. Added missing `import * as Diff from "diff"` (used in `saveBaseline()` but was never imported). Removed dead `isServerSourceFile()` function — defined but never called.
- **`style-checker.js`**: `lastNonEmpty` → `_lastNonEmpty` (computed but never read).
- **`chat-panel.js`**: Removed `static mcpClient = null` and `static llmModel = null` class field declarations — ES2022 syntax unsupported by the ESLint config, and both were dead (`mcpClient` is an instance property set via `setMcpClient()`, `llmModel` was never read anywhere). Renamed unused `setModel` destructure import to `setModel: _setModel`.

---

## 0.7.8

### Bug fixes — code cleanup

- **`pulsar-edit-mcp-server.js`**: Removed dead `import { randomUUID } from "crypto"` (unused — `createUUID()` uses a manual implementation). Moved misplaced `import path`, `import fs`, and `import ChatPanel` from after `loadMcpModules()` back into the static imports block at the top of the file. Removed duplicate `this.subscriptions.dispose()` call in `deactivate()` — the guard block at lines 311–313 was a redundant second dispose after the unconditional call at line 304.

- **`mcp-registration.js`**: Removed stray `console.log(entry)` left in the `dbg()` helper. Removed stray `console.log('[style-check] _totalCHEdits=...')` from the inline style-check path. Removed 58 `console.log("Registering Tool: ...")` calls that fired on every MCP server reload. Converted `const { ... } = require('./style-checker')` to a proper ESM `import` — the only `require()` in a file that otherwise uses `import` throughout.

---

## 0.7.7

### `style-checker.js` — `singleline_if` rule added

Added `singleline_if` (CHECK severity) to detect control-flow bodies on the same line as their keyword — e.g. `if (!g_hal) return -1;`. Linux kernel style requires the body on its own line even for single-statement guards. The rule fires on `if`, `else`, `for`, and `while` and is detected without a full parser by matching lines where the token after the closing `)` is not `{` or a comment.

The rule is tracked in `styleStats` / `lifetimeStyleStats` alongside all other per-rule counters. The reset loop is self-maintaining (`Object.keys`) so no reset block changes were needed.

### `test/hal.c` — rewritten to correct Linux kernel style

The test file was originally written with two kernel style violations:

- **Doxygen-style file header** (`@file` / `@brief`) — kernel code uses plain `/* */` block comments, not Doxygen.
- **Single-line `if` bodies** — all guard returns were written as `if (!g_hal || ...) return -1;` on one line. Kernel style requires the body on the next line.

Both corrected. `checkpatch` confirms zero violations.

---

## 0.7.6

### `checkpatch` — standalone style audit tool for C/C++ files

A new `checkpatch` tool has been added to the **debugging** group. It runs the kernel-style whitespace and formatting checker (`style-checker.js`) against an entire file and returns violations grouped by rule, sorted by frequency.

**Behaviour:**
- Pass `filePath` to audit any project file, or omit to audit the active editor buffer (live — no save required for open files).
- Non-.c/.h files return a clean "skipping" message — the guard prevents noise on JS/JSON/Markdown files.
- Results grouped by rule (e.g. `wrong indentation - spaces vs tabs`) with line numbers shown per rule and a `...and N more` cap at 20 per rule.
- Returns a clean confirmation message when no violations are found.

**Why this matters for LLM-generated edits:**
When an LLM edits a C file, it may introduce whitespace inconsistencies — mixing tabs and spaces, incorrect indentation depth, trailing whitespace. These don't affect semantics but break kernel coding style and cause `checkpatch.pl` failures in kernel workflows. More importantly, they make the file **non-uniform**, which degrades the effectiveness of `fuzzyWhitespace`-based matching on subsequent edits — a uniform file is predictable and anchors cleanly; a mixed file creates ambiguous matches.

`checkpatch` gives the LLM (and the developer) a single-call audit of the entire file's style state, separate from per-edit inline checking. This complements the inline per-edit style tracking in `get-edit-stats` (which measures violations introduced per edit) by providing a full-file baseline view.

**Stats integration:** `checkpatch` runs are tracked in `styleStats` alongside inline edit checks. `get-edit-stats` now returns `checkpatchRuns` and `checkpatchViolations` in the `styleChecks` section, and the `sessionStyleSummary` string includes both inline and checkpatch totals.

### `style-checker.js` — major rewrite aligned to Linux kernel coding standard

Complete rewrite of `style-checker.js` to properly implement Linux kernel coding style
rules as defined in `Documentation/process/coding-style.rst` and enforced by
`checkpatch.pl`. The checker is advisory — it reports violations for the LLM to decide
on, never auto-corrects.

**Key design changes:**

- **Severity levels** added to every violation: `ERROR` (must fix), `WARNING` (should fix),
  `CHECK` (informational). Matches checkpatch.pl's three-tier system. `formatViolations()`
  now groups output by severity.

- **`sanitiseLine()` helper** — replaces string literal contents, char literals, `/* */`
  block comment bodies, and `//` line comment tails with placeholder characters before
  running spacing checks. Eliminates false positives on content inside strings/comments.
  Block comment state tracked across lines via `inBlockComment`.

- **`wrong_indentation` fixed** — previous version fired on any leading spaces including
  hal.c's consistent 4-space style. Now correctly implements the kernel rule: leading
  spaces on a code line are an ERROR. Skips block comment interiors, `*` continuation
  lines, and `#` preprocessor lines.

- **`single_line_comment` downgraded** to `CHECK` — checkpatch.pl now sets
  `$allow_c99_comments = 1` by default, meaning `//` comments are tolerated.
  Previously reported as a full violation.

- **New rules added:**
  - `dos_line_endings` (ERROR, whole-file) — `\r\n` line endings
  - `trailing_blank_lines` (ERROR, whole-file) — blank lines at end of file
  - `open_brace_control` (WARNING) — replaces old `brace_placement`; `{` on own line
    after control flow keyword should be on same line (K&R)
  - `open_brace_function` (WARNING) — function `{` on same line as signature should be
    on its own line (Allman for functions)
  - `else_brace_placement` (WARNING) — `else` on separate line from `}` should be
    `} else {`
  - `space_before_open_brace` (WARNING) — `if(x){` missing space before `{`

- **`brace_placement` kept** in stats shape for backwards compatibility with existing
  lifetime data on disk.

- **Reset loop** for style stats is now self-maintaining — iterates `Object.keys(styleStats)`
  instead of a hardcoded list, so adding new rules never requires updating the reset block.

**Rules deliberately omitted** (too ambiguous, kernel-specific, or require a parser):
typedef/struct naming, Signed-off-by signoffs, deprecated kernel APIs, spelling,
`#include` ordering, `do {} while (0)` macro wrapping, braces-required-for-multi-line-if,
complex operator spacing beyond plain `=`.



`checkLines` in `style-checker.js` was firing `missing_newline_eof` on every inline edit
check because `new_str` snippets virtually never end with `\n` — they're code fragments, not
complete files. This rule was polluting every edit's style report and inflating the lifetime
`missing_newline_eof` violation count (confirmed: fired on all 5 lifetime inline checks).

**Fix:** Added `isWholeFile = false` parameter to `checkLines`. The EOF check is now gated
on `isWholeFile`. The `checkpatch` tool passes `true` (it audits a complete file). All edit
tools call through `applyStyleCheck` which passes nothing (defaults to `false`). No change
needed at the `applyStyleCheck` call sites — the default handles it transparently.

### `replace-all` — inline style check wired

`replace-all` now runs `applyStyleCheck(replacement, filePath)` after committing changes,
matching the behaviour of all other edit tools. Previously a `replace-all` across a `.c`/`.h`
file gave no style feedback regardless of what the replacement text contained. The `🎨 style`
suffix now appears on the success response if the replacement introduces violations, and the
results are accumulated in `get-edit-stats` `styleChecks` counters.

### `list-project-functions` / `list-functions` / `get-function-list-with-comments` — keyword false positives fixed

All three function-listing tools shared a `fnRe` regex that matched any line of the form
`identifier(` — including C control-flow keywords `if (`, `for (`, `while (`, `switch (`.
This caused spurious entries like `{ name: "if", signature: "if (!g_hal || ...) {" }` in
results. Fixed by adding a negative lookahead `(?!if|for|while|switch|return|else|do\b)`
immediately before the capture group in all three regex instances (lines 1113, 3523, 3651).

### Bug fix — `apply-patch` fuzzy rescue `allLines is not defined` crash

The fuzzy rescue failure paths in `apply-patch` (both the "could not parse hunks" early
exit and the "fuzzy rescue failed" final failure) called `smartSuggestion()` with
`fileLines: allLines.length`. `allLines` is declared in the `sed` handler's scope and
is not available in the `apply-patch` handler, which uses `bufLines` for the same data.
This caused a runtime ReferenceError on any patch that triggered the fuzzy rescue path,
swallowing the proper failure message and returning a raw JS exception string instead.

**Fix:** Both `allLines.length` references at lines 4713 and 4812 replaced with
`bufLines.length`. Discovered during full tool sweep in 0.7.6 testing session.



The `const isCodeFile` declaration was placed at line ~1386 (inside the match-found path) but was referenced at line ~1374 in the `smartSuggestion` call on the no-match/failure path. JavaScript `const` temporal dead zone (TDZ) caused a runtime crash "Cannot access 'isCodeFile' before initialization" that silently swallowed the ambiguity guard — the guard fired but the error handler crashed before returning the AMBIGUOUS MATCH response.

**Fix:** `const isCodeFile` hoisted to immediately after `const buffer = editor.getBuffer()` (~line 1100), before all failure paths. Duplicate declaration at the old location removed via `sed`.

**Why TDZ bugs are dangerous in MCP servers:** The crash occurred inside the tool call handler — the MCP SDK's wrapper caught it and returned a minimal failure object rather than propagating it. The tool appeared to "work" (it returned a response) but the ambiguity guard had never fired. This class of bug — silent crash inside a hot path — can only be found by noticing missing behaviour, not by reading error logs.

### Bug fix — fuzzy rescue preview hunk regex (`$` in multiline mode)

The `apply-patch` fuzzy rescue preview was always showing empty `+`/`-` lines. Root cause: the hunk body capture regex used `$` as an end-of-input anchor, but with the `/gm` flags, `$` matches end-of-line. The capture group `([\s\S]*?)` stopped at the first newline, so the entire hunk body beyond line 1 was never captured.

**Fix:** Replaced `$` with `(?![\s\S])` — a negative lookahead that only matches true end-of-input, equivalent to `\z`. The `/gm` flags are kept; only the terminator anchor changed.

Also fixed the interleaving of `+` lines in the preview — they now appear immediately after their corresponding `-` lines rather than appended at the bottom of the context window.

### Stats panel fixes — `showEditStats()` in `pulsar-edit-mcp-server.js`

Three display bugs fixed in the edit stats UI panel:
- **"undefined" in summary**: the tools list was built from `Object.keys(s)` which included non-tool keys (`sessionEditSummary`, `styleChecks` etc.). Fixed: filter to only keys where `s[key].hits` is a number.
- **Content cut off**: `JSON.stringify` on `fails`/`hintsUsed` produced long lines. Fixed: expand only non-zero entries inline, suppress zero fields entirely.
- **`replace_document` badge**: showed "X hits / 0 fails" incorrectly. Fixed: `negCount` is null for hits-only tools; badge text omits fail count.

Panel `min-width` also increased 680 → 760px.

---

## 0.7.5


### Tool descriptions rewritten — decision triggers and decision ladders

All `registerTool` descriptions and `TOOL_CATALOGUE` short descriptions have been rewritten. The previous descriptions listed features; the new ones lead with **decision triggers** and **decision ladders** that tell the LLM *when to reach for each hint*, not just what it does.

**Philosophy change:** An LLM reading `"supports functionHint"` has no trigger to fire on. An LLM reading `"Know the function name? → functionHint:'myFn' — scopes search to inside that function body, safest choice for JS/C"` has a concrete decision rule.

**Tools rewritten (registerTool descriptions):**
- `str_replace` — decision ladder: (1) functionHint (2) afterHint (3) betweenHint (4) lineHint (5) occurrence. Each step lists when to use it, not just what it does
- `insert` — decision ladder: (1) functionEnd (2) afterContent/beforeContent (3) with functionHint (4) occurrence (5) insert_line as last resort
- `find-text` — rewritten around use cases: "use before str_replace to count occurrences", "matchCount > 1 means use a hint"
- `delete-line-range` — decision ladder: (1) functionHint (2) betweenHint (3) afterHint (4) startLine+endLine
- `delete-block` — decision ladder: (1) sectionHint (2) preprocBlock (3) startContent+endContent
- `replace-block` — concrete example added, braceMatchFailed fallback explained
- `get-region` — rewritten as "verify before editing" tool with follow-up workflow
- `replace-across-files` — two-step workflow (Step 1 / Step 2) made explicit
- `replace-function-body` — workflow guidance: "use read-lines with functionHint first, then call replace-function-body"
- `grep-file` — "PRIMARY USE: locate content to get line numbers before editing"; occurrence:N linked to str_replace lineHint
- `grep-project` — "PRIMARY USE: find where a symbol is when you don't know the file"
- `read-lines` — decision ladder for all 5 modes, return values linked to downstream tools
- `get-structural-anchors` — TYPICAL WORKFLOW section added
- `apply-patch` — use-case trigger moved to front: "USE THIS for edits touching multiple scattered locations"
- `search-symbol` — "USE THIS INSTEAD OF grep-project for symbol names — word boundary matching"

**TOOL_CATALOGUE short descriptions** also rewritten for: `str_replace`, `find-text`, `insert`, `delete-line-range`, `delete-block`, `replace-block`, `get-region`, `replace-all`, `get-structural-anchors`, `read-file`, `read-lines`, `replace-across-files`, `replace-function-body`, `grep-file`, `grep-project`, `search-symbol`.

Requires full restart + babel cache clear to expose updated descriptions to Claude Desktop.

### `readFileOrBuffer` — exists check added

Added `if (!fs.existsSync(filePath)) throw new Error('File not found: "..."')` inside `readFileOrBuffer()`, covering all 12 call sites globally. Previously, a missing path caused `fs.promises.readFile` to throw inside the MCP SDK's tool call wrapper, which caught it and returned an empty/minimal result object rather than propagating the error — causing `get-file-summary`, `read-lines`, `grep-file`, and others to silently return wrong data for bad paths. Also fixed `get-structural-anchors` which was calling `fs.promises.readFile` directly instead of `readFileOrBuffer`.

Hot-reload safe — no schema changes.

---

## 0.7.4

### `replace-across-files` — confirm pattern, contextLines, maxMatches, per-match line numbers

The tool previously fired blind: `dryRun:true` showed file names and counts but no line numbers, and the commit was a separate `dryRun:false` call with no link to the preview. A bad query could silently corrupt dozens of files.

**New safe workflow:**

1. Call without `confirm` — returns a full match listing: every match with its line number and `contextLines` lines of surrounding context (default 2, same shape as `grep-file` results). Results are stored in a pending store keyed on the query parameters.
2. Review the listing, then call again with `confirm:true` — commits using the stored pending result without re-scanning.

**`maxMatches` cap (default 50):** if total matches across all files exceed the cap the tool blocks entirely and asks you to narrow with `glob` or raise the cap. Prevents accidentally replacing hundreds of occurrences of a common token.

**`dryRun:true` kept** as a legacy alias for the preview pass — existing calls still work.

New params: `contextLines` (number, default 2), `maxMatches` (number, default 50), `confirm` (boolean).

---

### `read-lines` and `get-region` — hintsUsed bump() calls

Both tools had `hintsUsed` fields in the stats initializer and `getEditStats()` return blocks, but the handlers never incremented them — hint usage was silently dropped from stats.

- `read-lines`: now bumps `hintsUsed.functionHint`, `hintsUsed.afterHint`, `hintsUsed.betweenHint`, or `hintsUsed.lineHint` (centerLine maps to the lineHint bucket) on each successful call where a hint was used.
- `get-region`: now bumps `hintsUsed.occurrence` when `occurrence > 1` is passed.

Hot-reload safe — handler body changes only.

---

## 0.7.3

### Edit vs search stats split — misses are not failures

`grep-file`, `grep-project`, `search-symbol`, and `find-text` are read-only location tools. A no-result response is a **miss**, not a failure — it means the search term wasn't found, which is often expected. Counting them alongside `str_replace` failures in the session success rate was misleading (a session with many exploratory greps would appear to have a low hit rate even if every edit succeeded).

**What changed:**

- `summarise()` now computes two independent totals: `editHits`/`editFails` (buffer-modifying tools only) and `searchHits`/`searchMisses` (location tools only). The session/lifetime summary strings are separate: `sessionEditSummary` and `sessionSearchSummary` (and lifetime equivalents).
- `get-edit-stats` response now returns `sessionEditSummary` + `sessionSearchSummary` instead of a single `sessionSummary`. Likewise for `lifetimeEditSummary` + `lifetimeSearchSummary`.
- Search tools (`grep_file`, `grep_project`, `search_symbol`, `find_text`) now report `missTotal` and `misses` instead of `failTotal` and `fails` in the response — the field name signals the different semantic.
- Pulsar UI panel: summary line now shows both summaries (`"12 edit ops: 11 hits (92%), 1 fails  |  18 searches: 14 hits, 4 misses"`). Search tool badges show a blue background instead of red/amber — visually distinguishing misses from failures. Detail rows show `misses:` label instead of `fails:` for search tools.

**Edit tools** (failures counted in edit rate): `str_replace`, `insert`, `delete-line-range`, `delete-block`, `replace-block`, `replace-function-body`, `replace-all`, `replace-document`, `replace-across-files`, `apply-patch`, `sed`.

**Search tools** (misses counted separately): `grep-file`, `grep-project`, `search-symbol`, `find-text`.

---

## 0.7.2

### Stats — `fails.ambiguous` added to `str_replace`

The ambiguity guard was blocking correctly but bumping the wrong counter: `fails.partialMatch` instead of the dedicated `fails.ambiguous` field. Fixed — ambiguous-match blocks are now counted separately from partial content matches, making the two failure classes distinguishable in `get-edit-stats` output. `ambiguous` is covered by `Object.values(fails)` in `allFails` reduce so no change was needed to the totals calculation.

### `_isCodeFile` deduplication in `str_replace` handler

`_isCodeFile` was computed three times inside the `str_replace` handler. All three were hoisted to a single `const isCodeFile` declared once after the dry-run block and shared across the ambiguity guard, `smartSuggestion`, and `successNudge` call sites. Cosmetic only — no behaviour change.

### `resetEditStats` — generic `Object.entries` loop replaces hardcoded tool list

`resetEditStats()` previously zeroed each tool's counters via a hardcoded array of tool key names. Replaced with a generic `Object.entries(editStats)` loop that zeros all counters for whatever tools are currently present in the initializer. Any new tool added to `editStats` is automatically included in resets without a separate code change. Applied to both the exported function (used by the Pulsar UI panel) and the inline MCP handler.

### `mergeInto()` rewritten — disk is authoritative on load

The previous `mergeInto(target, src)` iterated `Object.keys(target)` (the in-memory schema) when merging disk data into the live stats object on startup. Keys present on disk but absent from the current schema were silently dropped. Rewritten to iterate `Object.keys(src)` (the disk data) instead: disk values take precedence; schema keys not on disk default to 0. Forward-compatible — adding a new tool to `editStats` produces a zero counter on the first run after upgrade, not a crash or missing key.

### Stats flush interval: 60 s → 5 s

The `setInterval` that flushes lifetime stats to `edit-stats.json` was reduced from 60 seconds to 5 seconds. The interval is a crash safety net only — the primary flush paths are `deactivate()` (synchronous, on clean package reload) and `beforeunload` (synchronous, on window close). Reduced interval means a hard crash loses at most 5 seconds of stats rather than up to a minute.

### `deactivate()` export wired through to Pulsar package lifecycle

`mcp-registration.js` already exported a `deactivate()` function that synchronously flushes lifetime stats to disk. It was never imported or called by `pulsar-edit-mcp-server.js` — Pulsar's package lifecycle calls `deactivate()` on the main package file, not on required modules. Fixed: `loadMcpModules()` now captures `reg.deactivate` into `mcpDeactivate`, and the package-level `deactivate()` calls `mcpDeactivate()` as its first action before teardown. Without this, any session shorter than the flush interval wrote nothing to disk; on the next startup `mergeInto` loaded stale data and the interval timer overwrote it with zeros, silently wiping lifetime history.

---

## 0.7.1

### `get-edit-stats` — search and file-ops tools now tracked

`grep-file`, `grep-project`, `search-symbol`, `replace-document`, and `replace-across-files` were previously invisible to `get-edit-stats`. Stats, hit/fail totals, and the Pulsar UI panel now cover all tools.

**What was added:**

- `grep-file`, `grep-project`, `search-symbol` — track `hits`, `fails.noMatch`, and `hintsUsed.occurrence` / `hintsUsed.contextLines`. `noMatch` fires on zero-result queries and on `occurrence N not found` errors, so both failure classes are visible.
- `replace-document` — tracks `hits` only (no meaningful fail mode; the tool either succeeds or throws).
- `replace-across-files` — tracks `hits`, `fails.skipped` (files where no match was found), and `dryRuns`.
- `get_selection` dead `hintsUsed` block removed from the editStats initializer and both return objects — the tool has no hint params and the block was never populated.
- `buildReport()` (used by the `get-edit-stats` MCP tool), `getEditStats()` (used by the Pulsar UI panel), and both allHits/allFails summarise blocks updated to include all five new tools. Session and lifetime return objects updated.
- CHANGELOG, README, and LLM-FAILURE-MODES updated to reflect the full tool coverage.



### `lint: true` — inline linter feedback on edit tool responses

All nine edit tools (`str_replace`, `replace-function-body`, `replace-block`, `insert`, `delete-line-range`, `delete-block`, `apply-patch`, `replace-all`, `sed`) now accept a `lint: true` parameter. When set, the tool response appends a scoped linter snapshot immediately after the edit — no need to call `get-diagnostics` separately.

**Behaviour:**
- Fires on success only (failure path shows the tool's existing error guidance).
- Messages filtered to errors + warnings only (info is too noisy).
- Scope: the rows touched by the edit (insert/replace: inserted row range ±5; delete: rows at the deletion point ±5).
- `apply-patch`, `replace-all`, and `sed` use whole-file scope — they touch arbitrary locations so no single range is meaningful.
- Silent when clean — a successful edit with no lint messages produces no extra output.
- Silent when linter-bundle is not active — safe on all project types.

**Implementation details:**
- Shared `lintSnapshot(editor, startRow, endRow)` helper added alongside `ambiguityCheck` and `smartSuggestion`.
- `lint: z.boolean().optional()` added to `ANCHOR_SCHEMA` — flows into the six scoped tools automatically via the schema spread. Added explicitly to `apply-patch`, `replace-all`, and `sed` inputSchemas (these don't use `ANCHOR_SCHEMA`).
- Uses the same `lb.mainModule.provideMcpTools().find(t => t.name === "GetLinterMessages").execute()` API as `get-diagnostics`, with file scope forced and viewMode restored.
- Wrapped in try/catch — any linter error produces null (silent).

**Why opt-in:** Projects without linter-bundle (pure C + compiler-only workflows) would get silent null returns on every edit. Opt-in keeps output clean until explicitly requested.




### Tool renames — align with Claude Code / MCP ecosystem convention

- **`get-linter-messages`** → **`get-diagnostics`** — matches `mcp__ide__getDiagnostics` naming from Claude Code and the broader MCP ecosystem. Live on buffer, no save required.
- **`get-diagnostics`** → **`get-compiler-diagnostics`** — clarifies that this tool runs the compiler (gcc/clang/cl) on the saved file on disk, distinct from the live linter tool above.

LLMs trained on Claude Code patterns will now naturally reach for `get-diagnostics` and find the right tool.

Also corrected the tool description: linter-bundle fires on `onDidChange` (debounced ~300ms) so `get-diagnostics` is **live on the buffer** — the previous description incorrectly stated "always call save-file first".

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
- `get-edit-stats` — Return per-tool edit statistics for the current session AND lifetime totals across all sessions. SESSION: counters since last server restart. LIFETIME: cumulative totals loaded from `edit-stats.json`, survives restarts. Covers all edit tools (`str_replace`, `insert`, `delete-line-range`, `replace-function-body`, `replace-block`, `apply-patch`, `replace-all`, `replace-document`, `sed`, `delete-block`) and all search tools (`grep-file`, `grep-project`, `search-symbol`, `find-text`, `replace-across-files`). Tracks hits, fail reasons (`noMatch`, `whitespace`, `partialMatch`, `outOfScope`, `afterNotFound`, `wrongOccurrence`, `skipped`), hint usage (including `occurrence` and `contextLines` for search tools), fuzzy-whitespace commit count, average `old_str` length, and dry-run count. Pass `reset:true` to flush session into lifetime, increment `sessionCount`, and zero session counters. Lifetime data persists to disk on reset and on server shutdown.
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
