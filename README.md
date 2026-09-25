# Pulsar Edit MCP Server & LLM Coding Assistant

An MCP (Model Context Protocol) server and built-in chat assistant that lets an LLM control the [Pulsar](https://github.com/pulsar-edit) editor. Use the built-in chat panel or any compatible external client such as [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) or [Claude.ai](https://claude.ai).

Tools have been curated from Ghidra, Cline, and Claude Code into a single package, then extended with instrumentation, failure recovery, and persistence features that no other tool has. A lazy-load discovery mechanism means the LLM is aware of all tools without paying the token cost of loading every schema upfront.

> **Beta software**  --  tested but not production-hardened. Bug reports and suggestions are welcome!

---

## Why this exists  --  LLM edit failure modes

LLMs fail at code editing in predictable, classifiable ways: whitespace mismatches, line number drift, duplicate pattern confusion, stale context truncation. This package was built to fix them.

The full analysis  --  failure modes, root causes, proposed fixes, and the reasoning behind the instrumentation  --  is documented here:

**[LLM-FAILURE-MODES.md](https://github.com/professor-jonny/pulsar-edit-mcp-server/blob/main/LLM-FAILURE-MODES.md)**

If you work on LLM tooling, MCP servers, or agentic coding assistants, it's worth a read. Contributions and feedback welcome.

---

## What makes this different

Most MCP servers expose editor actions and call it done. This one treats LLM edit failures as a first-class problem and instruments everything around fixing them.

### Ambiguity guard  --  blocks silent wrong edits
Before committing any edit, `str_replace`, `replace-block`, `replace-function-body`, and `delete` count **all** occurrences of the target pattern in the file. If more than one match exists and no scope hint is set, the edit is **blocked**  --  not silently applied to the wrong location. The response lists every matching line number and the exact hint to use. No other tool does this.

### ÃƒÂ°Ã…Â¸Ã…Â½Ã‚Â¯ Smart failure suggestions
When `str_replace` fails to match, the response immediately analyses *why*: whitespace and indentation differences are reported line-by-line, how many consecutive lines matched before diverging is counted, and the closest area of the file is found via fuzzy word-scoring. The suggestion engine fires **on failure #1**  --  if `old_str` looks like a whole function it suggests `replace-function-body`; if it looks like a brace block it suggests `replace-block`; on a large file with no hints it adds urgency. Escalates at failure #2 with tool-switch recommendations. On a *successful* edit with no hints on a file >300 lines, a nudge appended tells you which hints to use next time  --  closing the loop before problems start.

For multi-line `old_str` failures a **Levenshtein similarity score** is also returned: `Similarity: 89%  --  Content is close  --  likely whitespace/indentation drift` when a whitespace mismatch was found. Anchor resolution failures (`afterString`/`betweenHint` not found) show the nearest symbol name and its similarity percentage so typos in hint strings are caught immediately.

**Shared failure diagnosis.** The whitespace / partial-match / closest-area / similarity / where-else-does-it-exist explanation lives in one shared module (`lib/fail-diagnostics.js`, wired in through `lib/match-engine.js`), so `insert` (`afterContent`/`beforeContent`), `delete` (`matchString` and `startContent`/`endContent`) and `replace-block` (`anchor`) explain a miss the same way and count it under the same `whitespace` / `partialMatch` / `foundOutsideScope` / `noMatch` failure counters. In that shared version the "drift" claim is made only when a whitespace mismatch was actually found (a typo reads "close but not identical  --  compare it character by character"), and when the text exists exactly but outside the search scope no percentage is shown: the message says the problem is *where* it is being searched. `str_replace` still uses its own inline diagnosis and keeps the older wording for those two cases until it is moved onto the engine.

### ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã‚Â Content-anchored editing  --  immune to line number drift
All edit tools support scope hints that anchor by *content* rather than line number:
- `inFunction`  --  scopes the search to inside a named function body
- `afterString`  --  starts the search after a unique anchor string
- `betweenHint`  --  restricts the search to between two anchor strings (switch cases, struct blocks, `#ifdef` regions)
- `occurrence:N`  --  targets the Nth match when a pattern repeats
- `fuzzyWhitespace:true`  --  matches ignoring indentation differences, commits using the buffer's actual whitespace  --  eliminates the most common retry loop

### ÃƒÂ°Ã…Â¸Ã…â€™Ã‚Â³ Tree-sitter powered hint resolution  --  semantically correct anchors
All hint resolution (`inFunction`, `afterString`, `betweenHint`, `functionEnd`) is backed by Pulsar's tree-sitter parser for open files. This means `afterString:"myFn"` resolves to the **end of that function's closing brace**  --  not just the first character occurrence of the string. `betweenHint:{start:"fn_a", end:"fn_b"}` spans from the closing brace of `fn_a` to the closing brace of `fn_b`. Ambiguous anchors (same function name in multiple places) return an error with line numbers rather than silently picking the wrong one. Regex fallback covers closed files and edge cases. The same symbol index powers `get-repo-map`, `list-project-functions`, `replace-function-body`, and all structural anchor tools.

### ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã…Â  Per-tool edit stats  --  know exactly what's failing and why
`get-edit-stats` tracks hits, faults, and misses **per tool** across the session and lifetime. Failure reasons are classified (`whitespace`, `partialMatch`, `ambiguous`, `outOfScope`) so you see patterns, not just counts. Hint usage is tracked separately so you can see whether the LLM is actually using the tools correctly. A live stats panel in Pulsar (**Packages ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ MCP Server ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Show Edit Stats...**) shows the same data visually. No other coding assistant exposes this level of instrumentation.

### ÃƒÂ°Ã…Â¸Ã‚Â§Ã‚Â  Self-updating project memory.
`session-notes` is a persistent store the LLM writes to and reads from across sessions. At the start of every session the LLM reads back what it wrote last time  --  which hints worked on this codebase, which files hot-reload, what caused retries  --  and adjusts immediately. Combined with `get-repo-map` at session start for structural orientation, the LLM arrives knowing both the code layout and accumulated lessons specific to this project. It improves automatically with use. No user maintenance needed.

### ÃƒÂ¢Ã…Â¡Ã‚Â¡ `@//` prompt shortcuts  --  reusable workflows in a plain text file
Type `@//` in the chat input to open a live-filtered shortcut picker. Shortcuts are named blocks in a `shortcuts.md` file in your project root  --  edit them in Pulsar, they take effect immediately without reload. Select one to expand it inline into the input for editing before send. Functionally equivalent to Windsurf Cascade workflows at a fraction of the complexity.

### ÃƒÂ°Ã…Â¸Ã…Â½Ã‚Â¨ Inline C style checking  --  automatic on every edit
For `.c`/`.h` files, every edit tool automatically runs the Linux kernel style checker against the lines it added or changed  --  only the new lines, never pre-existing content. Violations appear as a `ÃƒÂ°Ã…Â¸Ã…Â½Ã‚Â¨ style` suffix on the success response. `checkpatch` audits the full file on demand. No other tool has language-specific style enforcement at this depth.

### ÃƒÂ°Ã…Â¸Ã‚ÂÃ‚Â· Kernel C naming and documentation tools
Three tools enforce Linux kernel conventions that no other coding assistant touches:
- **`namingcheck`**  --  scans for naming violations: functions missing a verb-tier prefix (`get_`, `set_`, `init_`, `handle_`, ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦), camelCase in function or variable names, `#define` macros not ALL_CAPS. Reports violations with line numbers.
- **`check-function-docs`**  --  audits every non-static function for a kernel-doc `/**` comment. Three severity tiers: **missing** (no comment at all), **wrongStyle** (`//` line comment  --  always wrong for kernel), **plainDoc** (`/* */` present but not kernel-doc). Each entry includes the full function signature and an `[in header]` tag if the function is declared in the sidecar `.h`.
- **`insert-function-doc`**  --  inserts a complete kernel-doc skeleton above a named function: `function_name() - desc`, `@param:` per argument (variadic `...` emits `@...:` per spec), `Context:`, `Return:`. Pass the `line:` from `check-function-docs` output for a precise anchor. Aborts cleanly if a comment already exists.

### ÃƒÂ°Ã…Â¸Ã¢â‚¬ÂÃ‚Â¬ Ghidra reverse engineering integration
A full suite of Ghidra RE tools  --  `list-functions`, `search-functions`, `get-function-body`, `get-xrefs`, `add-comment`, `get-function-list-with-comments`  --  bridges the gap between Ghidra's pseudocode export and real compilable C. Disabled by default; enable with one command.

### ÃƒÂ°Ã…Â¸Ã‚Â©Ã‚Â¹ apply-patch fuzzy rescue
When a unified diff patch fails to apply, the tool automatically attempts fuzzy/indent-aware hunk recovery and shows a corrected diff preview. Reply with `confirm:true` to apply the rescued version  --  no need to rewrite the patch.

### ÃƒÂ°Ã…Â¸Ã¢â‚¬ÂÃ‚Â Cheap corrections  --  commit a preview, or retry one field
Two features stop a preview or a failure from costing a full resend. After a `dryRun` preview, `insert({ filePath, commitLastPreview: true })` applies that exact preview without resending `new_str` or the anchors. After a failed `str_replace`, send only the field that was wrong  --  `{ filePath, old_str: '<corrected>' }`  --  and the server merges it into the failed call and re-runs it; the failure message spells this out. Both are kept only until another edit touches the same file, and either a relative or an absolute `filePath` works.

### ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¦ Structured edit responses  --  consistent feedback on every commit

Every edit tool returns a standardised response via `lib/edit-response.js`:

```
ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¦ str_replace  --  line 42, +3 lines [fuzzyWhitespace]
ÃƒÂ°Ã…Â¸Ã…Â½Ã‚Â¨ style: [L2] wrong indentation
ÃƒÂ¢Ã…Â¡Ã‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â struct: unmatched opening brace (net +1 { })
```

The headline tells you exactly where the edit landed and what matching mode was used. Warnings are silent when clean  --  a successful edit on correct code produces a single clean line. All 15 commit sites across all edit tools use the same builder, so responses are predictable regardless of which tool you call.

### ÃƒÂ°Ã…Â¸Ã‚ÂÃ¢â‚¬â€ Post-edit structural integrity checks

`lib/struct-check.js` computes a **delta snapshot** before and after every `str_replace` edit on `.c`/`.h` files. It detects three structural problems that style checkers and linters miss:

- **Unmatched braces**  --  net unclosed `{` count changed for the worse
- **Unclosed block comments**  --  a `/*` was introduced without a matching `*/`
- **`#if`/`#endif` imbalance**  --  a preprocessor conditional was left open

Delta-only means pre-existing problems in the file are silently ignored  --  only damage introduced by *this edit* is reported. Multiple issues in one edit are pipe-separated on a single line. The check is always-on and zero-configuration.

### ÃƒÂ°Ã…Â¸Ã¢â‚¬ÂÃ‚Â¬ Failure capture  --  char-level diagnostics on every failure

When `str_replace` fails to match, a `ÃƒÂ°Ã…Â¸Ã¢â‚¬ÂÃ‚Â¬ DIFF` block in the response shows the char-level diff between your `old_str` and the actual buffer content at the `afterLine` position  --  the exact byte where the strings diverged, including invisible characters like smart quotes vs straight quotes, NBSP, or zero-width spaces. Every failure is also logged to `session-faults.ndjson` with `diffVsBuffer`, `oldStrPreview`, and full hint context.

Hint resolution failures are also logged  --  not just content mismatches. When `afterString`, `inFunction`, `betweenHint`, `afterFunction`, `afterSymbol`, or any other hint fails to resolve, the fault log records the failure with a structured `reason` field: `hintFault:<hintName>:<variant>` (e.g. `hintFault:afterString:notFound`, `hintFault:inFunction:ambiguous`). This means the fault log viewer now clearly distinguishes two failure classes:

- **Content failures** (`noMatch`, `whitespace`, `partialMatch`)  --  the hint resolved fine but `old_str` didn't match at that location
- **Hint failures** (`hintFault:*`)  --  the anchor itself wasn't found or was ambiguous, so the search never started

Both are queryable via `get-failure-log` with `reason` filter. The Fault Log panel in Pulsar shows both in the same list with the Reason column populated in full.

### ÃƒÂ°Ã…Â¸Ã…â€™Ã‚Â Unicode robustness  --  three matching modes for encoding problems

LLMs frequently generate `old_str` containing Unicode variants that differ from what the buffer holds (smart quotes, em-dashes, NBSP, zero-width chars). Three modes address this without requiring a re-read:

- **`fuzzyContent:true`**  --  normalises both `old_str` and the buffer to ASCII-equivalent before matching (smart quotes ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ straight, em-dash ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ hyphen, NBSP ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ space, surrogate pairs stripped). The replacement is committed against the original buffer content  --  encoding is preserved.
- **`regex:true`**  --  treats `old_str` as a JS regex. Use `.` to wildcard a single problematic char, `.*` for a span. Supports `occurrence:N` and `afterLine` scoping.
- **`fuzzyWhitespace:true`**  --  existing mode, handles indentation-only mismatches.

All three can be layered. `get-repo-map` now appends a `[unicode]` flag to files containing non-ASCII characters  --  a heads-up to use `fuzzyContent` or `regex:true` before the first edit fails.

### ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã‚Â¦ Shared library architecture  --  tools as declarative configs

`mcp-registration.js` has been refactored from a monolith into a set of focused shared libraries. The main file is now **~7,400 lines** (down from ~8000). The `lib/tool-framework.js` layer is complete  --  each tool is a declarative config object and all cross-cutting concerns (stats, dryRun, consecutive failure counters, style/lint/struct checking, buffer acquisition by `filePath`) are handled centrally.

Libraries extracted:

- **`lib/tool-framework.js`**  --  `makeRegisterMcpTool()` wrapper. Handles buffer acquisition by `filePath` (find open tab or `bufferForPath` for closed files  --  no tab created, full undo/save support), `ctx.fail()`, `ctx.commit()` (auto-save, gutter decorations, focus toggle, `onCommit` callback), `ctx.dryRunReturn()`, consecutive failure counters
- **`lib/edit-stats.js`**  --  session/lifetime stats, `bump()`, `bumpStyle()`, `flushLifetimeStats()`, `syncToLifetime()` (a no-op since 2026-09-24: it used to add each session's counts to lifetime a second time, so lifetime read exactly 2x; `bump()` is now the only lifetime writer), `summarise()`, `buildReport()`, `buildStyleReport()`, process exit hooks
- **`lib/tool-hints.js`**  --  `anchorError()`, `smartSuggestion()`, `successNudge()`, `ambiguityCheck()`, consecutive failure counter objects
- **`lib/match-engine.js`**  --  the universal match engine, one shared implementation of read -> scope -> match -> edit -> respond. `resolveScope()` turns every scope hint (`inFunction`, `afterFunction`/`afterSymbol`, `afterString`/`beforeString`, `betweenHint`, `afterLine`/`beforeLine`, `sectionHint`, `preprocBlock`) into a single search window; `matchContent()`, `matchBlock()` and `matchFunction()` find the target inside it; `applyEdit()`/`applyEditSpan()` re-verify the target rows (or, for `applyEditSpan`, the target span) immediately before writing (drift relocation + byte-for-byte check); `buildFailResponse()`/`buildMatchResponse()` produce the diagnostics, `buildInsertPreview()`/`buildReplacePreview()` (S4d, 2026-09-23, live-verified) build the shared `dryRun` preview text for `insert` and replace-style tools respectively, and `diagnoseFailure()` runs the shared failure diagnosis (`lib/fail-diagnostics.js`) and its counters for tools that compose their own message. `insert`, `delete`, `read`, `replace-block`, `replace-function-body` and `apply-patch`'s hunk rescue run on it. `str_replace`'s own rescue/profiling logic delegates to `lib/recover.js` (S4a, live-verified 2026-09-22), and its `afterString`/`beforeString` scope-narrowing now forwards `fuzzyWhitespace` to match the engine (S4c, live 2026-09-23). Its dry-run output is now built via the shared `buildDryRunResult`/`buildReplacePreview` path too (S4e Section 1, live-verified after a restart 2026-09-23)  --  and its scope resolution goes through the engine as well: `resolveStrReplaceScope()` (`lib/_s4e_section2_scope.js`) wraps `resolveScope()` for every scope hint (S4e Section 2, wired 2026-09-23, live-verified after a restart). Its plain single-line MATCH delegates to `matchFragment()`/`tryPlainFragmentMatch()` (S4e Section 3, live-verified after a restart 2026-09-24), which closes the `count`-inside-`discount` hazard. The COMMIT half is deliberately NOT on the engine: `str_replace` still writes with its own character-index splice (`buffer.setTextInRange`), which already does the same drift-relocate and byte-for-byte checks, so `applyEditSpan()` and `commitFragmentEdit()` exist and are tested but no live tool calls them (S4e closed match-only, 2026-09-24). Multi-line, regex and fuzzy matching and the failure builder are also still `str_replace`'s own code. Two behaviours differ from the old plain branch, both refusing instead of silently committing: an identifier-glued hit is refused unless `guardIdentifier:false`, and a needle appearing twice on one line now counts as two occurrences (see "ambiguity guard" below). `sed`, `replace-all` and `replace-document` still carry their own matching code and are being ported so every tool shares one implementation
- **`lib/fragment-match.js`** — pure (no Pulsar, no I/O) character-span fragment matcher (S4b, 2026-09-22). `matchFragment()` finds a needle on a single line (fragments don't span lines) and returns a `{row, startCol, endCol}` span, using `lib/identifier-boundary.js`'s S3 guard to exclude hits glued to a longer identifier by default (the `count`-inside-`discount` hazard). `lib/match-engine.js`'s `applyEditSpan()` is its commit-side sibling, reproducing `applyEdit()`'s drift-relocate/byte-for-byte-verify safety in span terms. Wired into `str_replace`'s plain single-line match branch via `tryPlainFragmentMatch()` (S4e Section 3, live-verified after a restart 2026-09-24) -- see `test/s4b_fragment_match_test.js` (29/29) and `lib/test_s4e_section3.js` (10/10).
- **`lib/fail-diagnostics.js`**  --  pure (no Pulsar, no I/O) failure diagnosis shared by the engine tools. `diagnose()` reports a whitespace mismatch, a partial match (first N of M lines matched, then diverged), the closest area, a similarity score in tiers, a drift nudge for `afterLine`/`beforeLine`, and whether the text exists nowhere / inside the scope / only outside it. Optional `subject` names the input in the messages (`startContent`, `endContent`; default `old_str`) and `fuzzyAdvice:false` drops the "retry with `fuzzyWhitespace:true`" advice for calls that do not honour it. Covered by `test/s4_diagnostics_test.js` (pure module) and `test/s4_engine_probe.js` (drives the real engine in plain Node)
- **`lib/recover.js`**  --  combined whitespace/encoding/comment transform diagnosis (`profiledMatch`) and full-buffer partial-match rescue (`partialMatchRescue`); pure (no `bump()`, no message strings). Used by the engine's automatic rescue stage AND, since S4a, by `str_replace`'s own inline rescue directly  --  the caller in each case keeps its own stat counters and wording
- **`lib/buffer-helpers.js`**  --  `walkDir()`, `resolveStructuralAnchor()`, `findFunctionInBuffer()`, `readTextFromFile()` (open-tab buffer or `bufferForPath`  --  no raw disk reads, BOM-safe)
- **`lib/lint-helpers.js`**  --  `maybeLintSuffix()`, `lintSnapshot()`
- **`lib/tool-catalogue.js`**  --  `TOOL_CATALOGUE` array, `TOGGLEABLE_GROUPS` array
- **`lib/schema.js`**  --  `ANCHOR_SCHEMA` (includes `filePath`, all hint params), `STRUCTURAL_ANCHOR_SCHEMA` Zod schemas
- **`lib/style-checker.js`**  --  kernel C style rules, `applyStyleCheck()`, `isKernelFile()`
- **`lib/naming-checker.js`**  --  `checkNaming()`, `checkFunctionDocs()`, `buildDocSkeleton()`
- **`lib/tree-sitter-symbols.js`**  --  `getSymbols()`, `resolveAnchor()`, `findFunction()`, `braceEndRow()`
- **`lib/edit-response.js`**  --  `buildEditResponse()`, `preEditSnapshot()`, `postEditDelta()`
- **`lib/struct-check.js`**  --  `snapshot()`, `delta()`
- **`lib/string-utils.js`**  --  pure utilities: `escapeRegex`, `applyReplacement`, `globToRegex`, `levenshteinDistance`, `calculateSimilarity`


<img src="https://github.com/user-attachments/assets/52c74f89-d76f-4faa-9265-009bdc78c32c" width="700" />

**AnythingLLM external client:**

<img src="https://github.com/user-attachments/assets/5e796c45-c0e8-4e15-a9db-1b5dcb27057d" width="700" />

**Shortcut use:**

<img src="https://github.com/professor-jonny/pulsar-edit-mcp-server/blob/main/assets/shortcut_use.jpg" width="700" />

**Stats panel:**

<img src="https://github.com/professor-jonny/pulsar-edit-mcp-server/blob/main/assets/stats.jpg" width="700" />

**Fault Log**

<img src="https://github.com/professor-jonny/pulsar-edit-mcp-server/blob/main/assets/fault_log.jpg" width="700" />

**Fault Log Entry**

<img src="https://github.com/professor-jonny/pulsar-edit-mcp-server/blob/main/assets/fault_log_entry.jpg" width="700" />

---

## Installation

```sh
ppm install https://github.com/professor-jonny/pulsar-edit-mcp-server
```

After installation, start the server via **Packages ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ MCP Server ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Listen**, or enable **Auto-Start** in settings so it starts automatically with Pulsar.

A **`MCP:On`** tile appears in the bottom-left status bar when the server is running. Click it to toggle the server on/off.

### Settings

<img src="https://github.com/user-attachments/assets/a5529835-919d-4c24-8c26-1eb3a904a1b7" width="300" />

| Setting | Default | Description |
|---|---|---|
| MCP Server Port | `3000` | Port the server listens on |
| OpenAI API Endpoint | `https://api.openai.com` | Base URL for the built-in chat (everything before `/v1/chat/completions`). Requires restart. |
| API Key | _(empty)_ | API key for the built-in chat |
| Auto-Start MCP Server | `false` | Start the server automatically when Pulsar opens |
| Focus Edited File | `true` | After each successful LLM edit, switch focus to the edited file's tab. Disable to keep your current tab while edits happen in background. Only affects already-open tabs  --  closed files are always edited silently without opening a tab. Toggle via **Packages ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ MCP Server ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Toggle Focus Edited File** |
| Max Tokens | `4096` | Maximum tokens for built-in chat LLM responses |
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

Tools are organised into groups. All groups are enabled by default. Disable unused groups in **Settings ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Tool Groups** to reduce the token overhead sent to the LLM on each session. Groups can be re-enabled at runtime by the LLM itself using `enable-group`  --  no Pulsar restart required. Disabling a group takes effect after the client reconnects.

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
| `str_replace` | Replace the first occurrence of `old_str` with `new_str`. Pass `filePath` to target any file without switching tabs. **Always use a hint on files >100 lines.** Decision ladder: (1) know the function name? ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ `inFunction`  --  scopes to that function body, safest for JS/C; (2) unique string just before the edit? ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ `afterString`; (3) inside a block (switch/struct/#ifdef)? ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ `betweenHint:{start,end}`; (4) have a line number from grep? ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ `afterLine`; (5) same pattern N times? ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ `occurrence:N`. `fuzzyWhitespace:true` when indentation mismatches cause failures. `fuzzyContent:true` for Unicode mismatches. `regex:true` to treat `old_str` as a JS regex. `dryRun:true` to preview before committing. After a failed match, retry cheaply with just `{ filePath, old_str: '<corrected>' }`  --  the rest of the failed call is reused |
| `replace-all` | Replace ALL occurrences of a string or regex in the active editor. Supports `dryRun` to preview match count and locations before writing |
| `replace-document` | Replace the entire editor contents |
| `replace-function-body` | Atomically replace a named function's full signature and body in one operation  --  avoids line-number shifting. Supports `dryRun` |
| `insert` | Insert one or more lines. Use `endOfFile:true`/`startOfFile:true` to append/prepend (simplest, drift-immune). Use `afterFunction`/`beforeFunction`, `afterString`/`beforeString`, `afterSymbol`/`beforeSymbol`, or `betweenHint` (content-anchored, immune to line drift) for mid-file inserts. If you only have a line number, use `afterLine:N` (after N), `onLine:N` (content becomes line N, pushing old line N down  --  optionally verify first with `expectedContent:'...'`), or `beforeLine:N` (one line before N). All three are positional and drift after other edits. Also supports `afterContent`/`beforeContent` (anchor by content string; `fuzzyWhitespace`/`fuzzyContent`/`regex` all honoured, opt-in), `sectionHint`, `preprocBlock`, `occurrence:N`, and `dryRun`  --  after a preview, `insert({ filePath, commitLastPreview: true })` applies that exact preview without resending anything. **Warning:** line numbers shift after every insert |
| `delete` | Delete lines by content, not line numbers. Six modes in priority order: (1) `sectionHint:'BANNER'`  --  a whole named section-banner block; (2) `preprocBlock:'MACRO'`  --  a whole `#ifdefÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦#endif` block (`preprocSide:'open'` or `'close'` deletes just that one line); (3) `inFunction:'fn'`  --  an entire named function; (4) `startContent` + `endContent`  --  from one anchor line to the other, inclusive (`inclusive:false` keeps the anchor lines); a duplicated `startContent` needs `occurrence:N`, while `endContent` resolves to the nearest match after the start; `fuzzyWhitespace`/`fuzzyContent`/`regex` apply to both anchors (opt-in); (5) `matchString`  --  one matched block, with the same `fuzzyWhitespace`/`fuzzyContent`/`regex` flags as `str_replace`; (6) `startLine` + `endLine`  --  legacy last resort, pass `expectedContent` to verify the range first. Scope hints (`afterFunction`, `afterString`, `betweenHint`, ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦) narrow where `matchString` searches. Ambiguous anchors are refused with the candidate lines listed. Supports `dryRun`. Replaces `delete-line`, `delete-line-range` and `delete-block` |
| `replace-block` | Brace-matched block replace anchored by any content string  --  generalised `replace-function-body` for non-function blocks (loops, conditionals, structs). Supports `dryRun` |
| `apply-patch` | Apply a unified diff patch to the file at `filePath`. Context-anchored  --  survives line number drift, and `@@` line numbers are only hints. **Previews by default** (`dryRun` defaults to `true`)  --  call again with `dryRun:false` to commit. If a hunk fails, it retries with fuzzy, indent-aware matching and shows a corrected preview; `apply-patch({ confirm:true })` applies that rescued version without resending the patch. Best for scattered multi-location edits; for edits touching more than about 30% of a file, `replace-document` or `replace-function-body` is cheaper |
| `get-structural-anchors` | List the named structural anchors in a file (`filePath` required): section banner names (pass to `sectionHint`) and `#ifdef`/`#ifndef` macro names (pass to `preprocBlock`). Call it before `insert`, `delete` or `read` when you need the exact anchor name |
| `get-selection` | Return the currently selected text and its line/column range |

### File Operations

| Tool | Description |
|---|---|
| `read-file` | Read any project file with 1-based line numbers. Reads from the live buffer if the file is open in Pulsar, otherwise from disk |
| `read` | Read a section of any file without opening it, using the same anchors the edit tools use: `inFunction` (a whole function body), `afterFunction`/`beforeFunction`/`afterSymbol`/`beforeSymbol`, `afterString`/`beforeString`, `sectionHint` (a whole banner block), `preprocBlock` (a whole `#ifdefÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦#endif` block; `preprocSide:'open'` or `'close'` returns just that one line), an anchor pair `startContent`+`endContent` (or `betweenHint`; `inclusive:false` drops the anchor lines), `centerLine`/`nearLine` + `radius`, or `startLine`+`endLine`. `occurrence:N` disambiguates; an ambiguous anchor is refused with the candidate lines listed, never guessed. Returns real 1-based line numbers. Replaces `get-region` and `read-lines`. Buffer-first when the file is open in Pulsar |
| `create-file` | Create a new file and open it in the editor |
| `move-file` | Move or rename a file. Open tab is retargeted in-place via `buffer.setPath()`  --  undo history preserved |
| `copy-file` | Copy a file to a new path and open the copy in a new tab. If the source is open with unsaved edits, the copy reflects the live buffer content |
| `rename-file` | Rename a file within its current directory. Tab retargeted in-place  --  undo history preserved |
| `create-folder` | Create a directory (and any missing parents) at a given path |
| `rename-folder` | Rename or move a folder. All open tabs inside are retargeted to their new paths automatically  --  undo history preserved per tab |
| `file-line-count` | Return the line count of any file without loading it. Buffer-first when the file is open in Pulsar |
| `get-project-files` | List all files under the current project root |
| `list-project-functions` | List every function definition across all project files |
| `get-includes-and-defines` | Return all `#include` and `#define` lines from a C/C++ file. Buffer-first when the file is open in Pulsar |
| `replace-across-files` | Find and replace across all project files. **Safe workflow:** first call without `confirm` returns a match listing with line numbers and `contextLines` surrounding context (default 2)  --  review what will change. Then call again with `confirm:true` to commit. `maxMatches` cap (default 50) blocks unsafe mass edits and forces narrowing with `glob`. Open files updated via buffer (undo preserved); closed files written to disk |
| `run-command` | Execute a shell command (PowerShell on Windows, `/bin/sh` elsewhere) and return stdout, stderr and exit code. `cwd` defaults to the first project root; pass `"root:<rootFolderName>/<subpath>"` to target one root unambiguously when several are open. `timeout` defaults to 30 s. Before running, every open editor is checkpointed and modified buffers are saved so the shell sees current content. Output streams live to the chat panel **and** the [Command Output panel](#command-output-panel), which also lets you type input into the running process  --  see below. `showOutput:false` suppresses the live streaming for noisy commands. Destructive-looking commands need confirmation (`confirm:true` bypasses) |

### Navigation

| Tool | Description |
|---|---|
| `open-file` | Open a file, or switch to its tab if already open |
| `goto-line` | Jump the cursor to a specific line (and optional column) |
| `list-open-files` | List all files currently open in editor tabs |
| `get-active-editor-info` | Quick metadata check on the active editor without loading the full document: filename, line count, cursor position, language, modified status |
| `close-file` | Close an editor tab by path. Optional `save: boolean` (default `false`) saves before closing |
| `goto-focus` | Move cursor to one or more positions/selections in the active editor, scrolling the view into focus. Array of `{ startLine, startColumn?, endLine?, endColumn? }` (1-based) |
| `get-project-paths` | Return the list of root folder paths currently open in the Pulsar project |
| `add-project-path` | Add an additional root folder to the project without removing existing roots |

### Search

| Tool | Description |
|---|---|
| `grep-file` | Search a file for a pattern and return matching lines. Supports `contextLines` (N lines before/after each match) and `occurrence:N` (return only the Nth match). Buffer-first when the file is open in Pulsar |
| `grep-project` | Search all project files for a pattern. Supports `contextLines` and `occurrence:N`. Buffer-first for open files  --  unsaved edits are always reflected |
| `search-symbol` | Find all uses of a C symbol with whole-word matching. Supports `contextLines` and `occurrence:N`. Buffer-first for open files |
| `find-text` | Find positions of a string or regex in the active editor. Supports `contextLines` and `occurrence:N`. Each result has `{ line, text, before?, after? }` |
| `get-repo-map` | Aider-style compressed codebase index. Extracts symbols via tree-sitter (open editors) or regex fallback, ranks files by PageRank, renders with `ÃƒÂ¢Ã¢â‚¬ÂÃ¢â‚¬Å¡` signature lines and `ÃƒÂ¢Ã¢â‚¬Â¹Ã‚Â®...` ellipsis between gaps. Output fits within a token budget. Use as the first call on an unfamiliar project. Appends **file-health flags** to affected files: `[unicode]` (non-ASCII present  --  use `fuzzyContent` or `regex:true` when editing), `[mojibake xN]` (corrupted cp1252-as-UTF-8 encoding), `[crlf xN]` (Windows line endings). Params: `glob`, `excludeGlob`, `maxTokens` (default 1024), `minRefs`, `mentionedFiles` (PageRank boost), `includeLineNumbers` |

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
| `get-diagnostics` | Return live linter diagnostics (errors, warnings, info) from linter-bundle. **Live on buffer  --  no save needed** (re-runs ~300ms after every buffer change). Works for any language with a linter provider installed. `scope:'file'` (default) or `scope:'project'`. Returns `[]` gracefully if linter-bundle is not active |
| `get-compiler-diagnostics` | Syntax-check the active C/C++ file using the compiler directly (gcc / clang / cl). Always call `save-file` first  --  runs against the saved file on disk. `scope:'file'` (default) or `scope:'project'`. Useful when you need authoritative compiler errors rather than linter output |

> For most workflows use `get-diagnostics`  --  it's live, language-agnostic, and requires no save. Use `get-compiler-diagnostics` when you specifically need the compiler's output (e.g. after a `save-file` at the end of a C/C++ edit sequence).

### Debugging

| Tool | Description |
|---|---|
| `get-debug-log` | Return recent MCP tool call log entries. Supports `tail` (default 20, max 100), `filter` by keyword, and `clear` to wipe the buffer |
| `get-failure-log` | Query `session-faults.ndjson`  --  the structured failure capture log written on every `str_replace`/`insert`/`replace-block`/`replace-function-body` failure. Supports `tail` (default 20, max 200), `tool`, `reason`, and `filePath` filters. Content failures (`noMatch`, `whitespace`, `partialMatch`) include `diffVsBuffer`, `bufferPreview`, and `oldStrPreview`. Hint failures (`hintFault:<hintName>:<variant>`) include `hintValue` and `oldStrPreview`. Use the `reason` filter to separate the two classes  --  e.g. `reason:"hintFault"` shows only anchor resolution failures. |
| `get-edit-stats` | Return per-tool edit statistics for the current session and lifetime totals (persisted in `edit-stats.json`). Covers all edit tools and all search tools (`grep-file`, `grep-project`, `search-symbol`, `find-text`, `replace-across-files`). SESSION: counters since last restart. LIFETIME: cumulative across all sessions. Tracks hits, fail reasons, hint usage (including `occurrence`/`contextLines` for search tools), dry-run count, fuzzy whitespace commits, and average `old_str` length. Pass `reset:true` to flush session into lifetime and zero session counters |
| `session-notes` | Persistent cross-session notes written by the LLM. `action:write` appends a note (what failed, what fix worked, lessons learned); an optional `project` label groups notes. `action:read` retrieves them grouped by title, each tagged with its `[index]`; `tail:N` limits it to the last N records  --  worth using once the log grows large. `action:edit` replaces a note in place by `index` (keeping its timestamp), `action:delete` removes one by `index` (later records shift down), and `action:clear` wipes everything. Notes survive server restarts and are stored as NDJSON in `session/session-notes.ndjson` in the package root |
| `checkpatch` | Run kernel-style whitespace and formatting checks against a C/C++ file. Pass `filePath` to audit any project file, or omit to audit the active editor buffer (live, no save required). Results grouped by rule sorted by frequency, capped at 20 per rule. Returns a clean confirmation when no violations found. Non-.c/.h files are silently skipped. Useful for auditing the full-file style state before or after a series of LLM edits. Stats tracked in `get-edit-stats` (`checkpatchRuns` + `checkpatchViolations`) |
| `check-struct` | On-demand absolute structural integrity snapshot for any brace-delimited file. Reports net unclosed `{` count, unclosed `/* block comments`, and `#if`/`#endif` nesting depth. Complements the automatic per-edit delta check  --  use this when you need an absolute reading, not just a delta |
| `namingcheck` | Check a kernel C file for naming convention violations: function names missing a verb-tier prefix (`get_`, `set_`, `init_`, `handle_`, ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦), camelCase in function or variable names, `#define` macros not ALL_CAPS. Returns violations with line numbers. Kernel `.c`/`.h` files only |
| `check-function-docs` | Check that every non-static function in a kernel C file has a kernel-doc `/**` comment above it. Three severity tiers: **missing** (no comment), **wrongStyle** (`//` comment  --  always wrong), **plainDoc** (`/* */` present  --  advisory). Each entry includes the full signature and `[in header]` tag (detected from sidecar `.h`). Kernel `.c`/`.h` files only |
| `insert-function-doc` | Insert a kernel-doc `/**` skeleton above a named function: `function_name() - desc`, `@param:` per argument (variadic `...` emits `@...:` per spec), `Context: Any context.`, `Return:`. Accepts optional `line:` (1-based, from `check-function-docs`) as a direct anchor  --  falls back to file scan. Aborts if a comment already exists. Kernel `.c`/`.h` files only |

### Highlight

| Tool | Description |
|---|---|
| `highlight-range` | Visually highlight a line range in the active editor |

### Ghidra (disabled by default)

Reverse-engineering tools for working with Ghidra-exported C source code. Enable via **Settings ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Tool Groups ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Ghidra Tools** or ask the LLM to call `enable-group`.

Ghidra's decompiler output is pseudocode  --  it does not guarantee the exported C is valid or compilable. This group bridges that gap:

- Run the exported C through a real compiler (`gcc`/`clang`) which understands C semantics properly
- Manipulate C code in ways that are not possible inside Ghidra itself
- Use `clang-tidy` or similar for genuine lint feedback on type errors and bad C
- `get-function-list-with-comments` tracks cleanup progress  --  annotated functions vs unnamed `FUN_` stubs at a glance
- `get-function-body` is useful when asking the LLM to document or rewrite decompiled functions
- `replace-function-body` rewrites a cleaned-up function atomically without disturbing surrounding code
- Useful for understanding and documenting decompiled code prior to re-implementation
- Patch and compile small source edits to generate assembler for binary patching workflows

| Tool | Description |
|---|---|
| `list-functions` | List all function definitions in the active Ghidra-decompiled C file (`FUN_`/`sub_` names and standard C), with line numbers |
| `search-functions` | Find functions whose name matches a query string or regex. Returns name, line and signature |
| `get-function-body` | Extract the complete source of a named function. Supports `inFunction` and `occurrence:N` for disambiguation |
| `get-xrefs` | Find all call sites of a named function in the active file |
| `add-comment` | Insert a block comment above a named function or at a specific line. Supports `inFunction` and `occurrence:N` |
| `get-function-list-with-comments` | List all functions with any existing comments  --  shows annotation progress at a glance |

---

## Notes

- The **Auto-Start** setting starts the MCP server automatically when Pulsar launches. If it fails to start on boot, use **Packages ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ MCP Server ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Restart Server** from the menu.
- Tool groups disabled in Settings take effect after the LLM client reconnects. Re-enabling a group is instant and does not require a reconnect or Pulsar restart.
- The built-in chat panel can be hidden via **Settings ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Show Chat Panel** if you prefer an external client.

### Chat panel

The built-in chat panel serves two roles: an LLM chat interface (when an API key is configured) and a live output display for MCP tool activity from external clients such as Claude.ai.

**Output display**  --  `run-command` stdout and stderr stream into the panel line-by-line as the process runs (and into the separate [Command Output panel](#command-output-panel), which is where you can type input into a running command). Tool faults (unexpected handler throws) appear as ÃƒÂ¢Ã…Â¡Ã‚Â  fault lines. Destructive commands (`rm`, `Remove-Item`, etc.) show a Run/Cancel confirmation widget before executing.

**Copy and paste**  --  text in the output area is selectable by mouse drag or Ctrl+A/Ctrl+C. Right-click on the output area shows Copy and Select All. Right-click on the input box shows Cut, Copy, Paste, and Select All. Note: image clipboard content (e.g. print screen) cannot be pasted into the text input  --  text only.

**Opening the panel**  --  use **Packages ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ MCP Server ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Show Chat Panel** or the command palette (`pulsar-edit-mcp-server:show-chat-panel`).

**Model selector**  --  a searchable combobox above the input. Models are fetched from the configured API endpoint and sorted alphabetically. Type to filter the list in real time; the dropdown opens upward above the input. The selected model is persisted across Pulsar restarts  --  the last-used model is restored automatically on next open. A **ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¢** button beside the input clears the selection and the persisted value.

**`@//` shortcuts**  --  type `@//` in the chat input to open a shortcut picker dropdown. Continue typing to filter by name. Enter or click to expand the shortcut body inline into the input for editing before send. Escape dismisses the dropdown. Shortcuts are defined in a `shortcuts.md` file in the project root using named blocks:
```
@//shortcut-name {
  freeform prompt text sent to chat on expand
}
```
The file is re-read on every trigger  --  edits take effect without reload. If `shortcuts.md` does not exist it is auto-created with sample content on first chat panel open.

### Command Output panel

A dockable pane, separate from the chat panel, that shows live output from `run-command` and lets **you** type input into the process it started.

**Why it exists.** A command that blocks reading stdin (a `y/n` prompt, a password, an interactive installer) leaves an LLM client with nothing to do: it can neither see that the process is waiting nor answer it, so the call just hangs until the timeout fires. `run-command` spawns a real child process inside Pulsar, so the panel simply gives the person at the keyboard a way to answer it.

**What it shows.** The command being run and its working directory (`Running: <command>  --  <cwd>`, then `Finished: <command>`), followed by the process's stdout and stderr line by line. Anything you send is echoed back as `> <text>`. **Clear** empties the output.

**Sending input.** Type into the input box and press **Enter** or click **Send**  --  the text is written to the process's stdin followed by a newline. **Close stdin (EOF)** signals end-of-input, for a process that is waiting on input you don't want to give. The input box, **Send** and **Close stdin** are enabled only while a command is running, and are disabled again when it exits or times out. A timeout closes stdin immediately, so a keystroke typed in the gap before the process is killed cannot be delivered to whatever command runs next.

**Opening it.** The panel opens automatically, docked at the bottom with the input box focused, whenever `run-command` runs with `showOutput` true. To open it by hand use **Packages ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ MCP Server ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Show Command Output Panel** or the command palette (`pulsar-edit-mcp-server:show-command-terminal-panel`). It can be dragged to the bottom, left or right dock. One panel is reused across runs.

**`showOutput:false`** keeps a command out of both the chat panel and the Command Output panel, and the panel does not open  --  use it for noisy diagnostics where you only want the final result. A command run that way can't be answered from the panel either, so don't use it for anything that might prompt.

### Tool metrics

Every edit tool has per-failure-reason counters. When consecutive failures cluster, the tool surfaces a targeted suggestion  --  switch hint, switch tool, add `fuzzyWhitespace`  --  rather than returning a bare noMatch. This steers the LLM toward the correct approach without requiring it to manually diagnose the failure class.

### tool description decision ladders

All tool descriptions have been rewritten to lead with **decision triggers**  --  concrete "when to use this" rules rather than feature lists. Each hint (`inFunction`, `afterString`, `betweenHint`, `afterLine`, `occurrence`) now has an explicit trigger condition so the LLM reaches for the right hint at the right moment, not just after a failure.

### smart failure responses
- If an edit fails to find a match, `str_replace` analyses the near-miss: it reports whitespace/indentation differences line by line, counts how many consecutive lines of a multi-line block matched before diverging, and pinpoints the closest area of the file via fuzzy word-scoring. `insert` (`afterContent`/`beforeContent`), `delete` (`matchString` and `startContent`/`endContent`) and `replace-block` (`anchor`) give the same analysis through the shared diagnosis module, plus a note when the text exists exactly but outside the search scope
- The smart suggestion engine fires **on the first failure**  --  not after 3. It detects: no hints used ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ lists specific hints with examples; `old_str` looks like a whole function ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ suggests `replace-function-body`; `old_str` looks like a brace block ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ suggests `replace-block`; large file (>500 lines) + no hints ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ adds file-size urgency. `delete` failures have dedicated guidance listing `matchString`, `startContent`/`endContent`, `sectionHint`, `preprocBlock`, `inFunction`, and `get-structural-anchors`
- After 2 consecutive failures, the response escalates with tool-switch suggestions
- On a **successful** `str_replace` with no hints on a file >300 lines, a nudge is appended telling you which hints to use next time  --  closing the loop before problems start

### ambiguity guard

- Before committing, `str_replace` counts **all** occurrences of `old_str` in the file. If more than one match exists and no scope hint is set, the edit is **blocked** with a `ÃƒÂ¢Ã…Â¡Ã‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â AMBIGUOUS MATCH` response listing every matching line number and the hints to use. Prevents the most dangerous silent failure mode: replacing the wrong occurrence without any warning
- The same guard applies to `replace-block` (checks the anchor string), `replace-function-body` (checks the function name as a definition-like pattern), and `delete` (checks `matchString` and the `startContent` anchor)
- Passing an explicit `occurrence:N` (including `occurrence:1`) disables the guard  --  you are already being deliberate about multiples. Omitting it is what triggers the refusal
- **Two more refusals on the plain single-line path (S4e Section 3, live 2026-09-24).** (1) Identifier guard: `old_str: "count"` no longer matches inside `discount`. If every hit is glued to a longer identifier the call is refused with `onlyIdentifierGlued` instead of committing; pass `guardIdentifier:false` to allow it deliberately. Glued hits are excluded from the count, so a `count` that also appears as a whole word still resolves normally (with `guardIdentifier:false` both hits count, and the call becomes ambiguous). (2) Same-line double hit: a needle that appears twice on ONE line now counts as two occurrences. Unscoped, that is refused as ambiguous (the message lists the same line number twice); `occurrence:1` and `occurrence:2` pick the first and second hit. Before this, the second hit was invisible and the edit went to the first one silently. Neither change applies to `fuzzyWhitespace`, `fuzzyContent`, `regex` or multi-line `old_str`, which keep their own matching

### `lint`  --  inline linter feedback (always-on)

- Linter feedback fires automatically on every edit  --  no `lint: true` opt-in needed. The parameter is still accepted for backwards compatibility but is ignored; the gate has been removed.
- Scope: rows touched by the edit (insert/replace: inserted range Ãƒâ€šÃ‚Â±5; delete: deletion point Ãƒâ€šÃ‚Â±5 lines). `apply-patch`, `replace-all`, and `sed` use whole-file scope.
- Errors + warnings only. Silent when clean. Silent when linter-bundle is not active (safe on all project types).

### style checking  --  automatic per-edit and on-demand

Two complementary mechanisms keep C/C++ file style clean across a session:

**Automatic inline style check (always on for `.c`/`.h` files)**
Every edit tool (`str_replace`, `insert`, `replace-function-body`, `replace-block`, `delete`, `apply-patch`) automatically runs the style checker against the lines it added or changed  --  **only the new or modified lines, never the pre-existing file content**. If violations are introduced, a `ÃƒÂ°Ã…Â¸Ã…Â½Ã‚Â¨ style` suffix is appended to the tool's success response listing the rule and affected lines  --  no opt-in needed. The per-edit results are accumulated in `get-edit-stats` under `styleChecks` (`editsChecked`, `totalViolations`, `cleanEdits`, `byRule`). This catches regressions at the point they are introduced.

> **Important:** inline stats count only violations in lines your edits wrote. Pre-existing violations already in the file when you opened it do not affect these counters at all  --  a file with 50 pre-existing style errors will show zero inline violations until you touch those lines. Use `checkpatch` for the full-file baseline before starting work; the two together give a complete picture: `checkpatch` shows what was already wrong, inline stats show what you introduced.
>
> The two counter sets are **completely isolated** in `get-edit-stats`  --  `checkpatchRuns` and `checkpatchViolations` are separate fields from `editsChecked` and `totalViolations`. There is no way for a `checkpatch` run to inflate the inline violation count or vice versa. If you see `checkpatchRuns: 0` it simply means `checkpatch` has not been called this session, not that the file is clean.

**`checkpatch`  --  whole-file audit on demand**
Call `checkpatch` (no arguments) or `checkpatch({ filePath: "..." })` to audit the entire file in one pass. Results are grouped by rule sorted by frequency, capped at 20 violations per rule. Use this:
- At the start of a session to understand the style baseline of a file before editing
- After a series of edits to verify the file is still clean end-to-end
- When `fuzzyWhitespace` starts behaving unexpectedly  --  mixed whitespace in a file makes per-line substitution ambiguous; a clean uniform file is a pre-condition for reliable content-anchored matching

**Why uniformity matters for editing:** `fuzzyWhitespace:true` matches content ignoring indentation then commits using the buffer's actual whitespace. This works reliably when the whole file uses one consistent style  --  the substitution is predictable. In a mixed file (some lines tabs, some spaces), the same anchor pattern can have different real whitespace at different occurrence sites, making the substitution ambiguous. Running `checkpatch` and fixing violations before a major edit sequence restores the uniformity that makes `fuzzyWhitespace` dependable.

### partial match feedback
When a tool fails partway through, it returns structured context so the LLM can correct and retry in one step rather than making a separate read call:
- **`str_replace`  --  wrong `occurrence:N`**: reports the actual line number of every match that *was* found so the correct N can be chosen immediately
- **`replace-function-body`  --  name not found**: each close-match suggestion now includes the function's actual current signature from the buffer, not just its name
- **`delete`  --  `endContent` not found**: shows the lines that follow the matched `startContent` anchor so the correct end string can be picked without a separate `read` call
- **`replace-block`  --  brace match failure**: shows lines around the anchor (no `{` case) or from the opening brace (unmatched `{` case) so the structure can be verified without a round trip
- **`replace-across-files`  --  skipped files**: files that error on read or write are now returned in a `skipped` array with the reason rather than being silently dropped

### content-anchored editing (`str_replace`, `insert`, `delete`, `read`)
- `inFunction` scopes `str_replace` to within a named function body  --  immune to line-number drift, preferred for JS/C edits
- `afterString` starts the search after the first occurrence of a content string  --  content-stable, doesn't drift with line number changes
- `betweenHint: { start, end }` restricts the search to between two anchor strings  --  useful for switch cases, struct blocks, `#ifdef` regions
- `afterLine` / `beforeLine`  --  directional window hints when you have a known line number from grep; prefer `afterString` when the content is stable
- `occurrence:N` replaces the Nth match instead of the first  --  fixes duplicate-pattern confusion without widening `old_str`
- `fuzzyWhitespace:true` matches ignoring per-line indentation differences and commits using the buffer's actual whitespace  --  eliminates the most common retry loop
- `afterContent` / `beforeContent` on `insert` anchor the insertion point by content string rather than line number  --  immune to drift. `fuzzyWhitespace`, `fuzzyContent` and `regex` are all honoured (opt-in; live-verified 2026-09-22)
- `delete` `startContent`/`endContent` accept `fuzzyWhitespace`, `fuzzyContent` and `regex` on both anchors, opt-in (the default is unchanged). A fuzzy start anchor that matches two lines differing only in indentation is refused as ambiguous rather than picking the first; use `occurrence:N`. Always `dryRun` first when using `regex:true` on `delete`
- With `regex:true` on `delete` (`matchString` and both anchors) and on `insert` (`afterContent`/`beforeContent`), `^` and `$` match at each line, as they do in `str_replace`, so a pattern such as `^function` that matches two lines is reported as ambiguous and `occurrence:N` chooses. The rows/anchor come from the first and last non-whitespace characters of the match, so a leading or trailing `\s*` does not pull in the neighbouring line. Live-verified for both `delete` and `insert` (2026-09-22); `replace-block` shares the same matching code but its `regex:true` behaviour has not been separately tested
- `delete` and `read` accept `startContent`/`endContent` (or `sectionHint`/`preprocBlock`) instead of line numbers; raw `startLine`/`endLine` remain only as a legacy fallback



### filePath routing  --  edits never touch your active tab

All edit tools accept an optional `filePath` parameter. When provided, the framework resolves the buffer by path rather than using whatever tab happens to be active:

- **File already open in a tab**  --  uses its live buffer directly. No tab switch. If the `Focus Edited File` setting is enabled, the tab is brought to front after a successful commit so you can see the result. Toggle this per-session via **Packages ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ MCP Server ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Toggle Focus Edited File**.
- **File not open**  --  uses `atom.project.bufferForPath()`. No tab is created, no focus changes. The buffer has full undo history and `save()` support  --  identical to an open file except it has no pane item and no gutter decorations.

This means you can keep reading one file while the LLM edits another in the background. Use **Packages ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ MCP Server ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Show Last Edited File** at any time to jump to the last file that was committed.

### Buffer and history

All edits operate on the live Pulsar buffer rather than writing directly to disk. When a file is open, disk writes are routed through the buffer so the file and editor are never left in an inconsistent state. Undo history is fully preserved.

### Mass replace scoping

Cross-file operations like `replace-across-files` can unintentionally touch documentation, binary assets, or generated files if the scope is too broad. Use the `glob` parameter to restrict replacements to the intended file set, and always review the dry-run preview before confirming.

### Undo history on file operations

Undo and redo history is preserved when files or folders are renamed or moved  --  open tabs are retargeted in-place via `buffer.setPath()` rather than closed and reopened.

### Dry run

Pass `dryRun:true` to any edit tool to preview the match and proposed change without writing anything. Returns a diff-style response showing what would be replaced and where. Use this before committing any multi-line edit you're uncertain about.

### session notes and edit stats

These two tools give you persistent memory across sessions on this codebase. **Follow this protocol automatically  --  do not wait to be asked.**

#### When you start a session

Before doing anything else, call:

```
session-notes({ action: "read", project: "<project-name>" })
```

Read what you wrote last time. Adjust your approach immediately  --  indentation style, files that hot-reload on save, which hints worked, what caused retries. Then call:

```
get-edit-stats()
```

Check the counters are at zero. If they are not, a previous session was interrupted  --  reset with `{ reset: true }` and carry on.

#### While you are working

- If `str_replace` fails twice in a row, call `get-edit-stats()` before trying again. The failure class (`whitespace`, `partialMatch`, `outOfScope`, `ambiguous`) tells you what to fix  --  do not retry blindly with the same call.
- Use `inFunction` or `afterString` on any `str_replace` where the pattern could appear more than once in the file. Use `afterLine` only when content anchors aren't available  --  it drifts after inserts/deletes.
- If whitespace failures are showing up in stats, switch to `fuzzyWhitespace: true` for the rest of the session on that file.
- Pass `lint: true` on any edit where you want immediate feedback on errors introduced by the change  --  eliminates a separate `get-diagnostics` call.

#### When the session ends

Call `get-edit-stats({ reset: true })`  --  this reads the summary, flushes session counters into the lifetime totals in `edit-stats.json`, and zeroes the session counters for next time. Then write a note:

```
session-notes({ action: "write", project: "<project-name>", note: "..." })
```

Record:
- Which tools and hints worked well on this codebase
- Any failure patterns you hit (e.g. `"tabs not spaces  --  use fuzzyWhitespace"`, `"mcp-registration.js hot-reloads on save  --  verify buffer before saving"`)
- The stats summary line (e.g. `"34 ops: 31 hits 91%, 3 whitespace fails"`)
- Anything that would have saved a retry if you had known it at the start

Notes survive server restarts and build up over time in `session-notes.json` in the package root. You can filter by project on read so notes from other codebases do not get in the way.

### edit stats panel

- **Packages ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ MCP Server ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Show Edit Stats...** opens a live stats panel showing hits, fail reasons, hint usage, and fuzzy-whitespace commits for every edit tool
- **Reset Counters** in the panel zeroes all stats  --  same counters as `get-edit-stats`, just visible to the developer too

### Emergency Revert

If the live server is edited during use causing the MCP server to crash, use the recover option to restore the server to a known-good state.

**baseline creation**
- The baseline is **not automatic**  --  you must save it manually before making changes.
- Use **Packages ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ MCP Server ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Save Backup** to snapshot the current server files to `.mcp-baseline/`. Do this whenever the server is in a known-good working state.
- If no baseline has been saved yet, the Restore button will not be available in the revert modal.

**To restore a backup:**
- `Ctrl+Alt+Shift+R`  --  or  --  right-click the editor ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ **MCP: Emergency Revert Server File...**  --  or  --  **Packages ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ MCP Server ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Emergency Revert Server File...**
- The file is written to disk a snapshot of the log is taken from the ringbuffer and the MCP server restarts automatically.

**If the server still doesn't come back after a restore:**
A restore only rewrites the file and restarts the HTTP server. If the package itself failed to load (e.g. a parse error crashed the initial activation), Pulsar needs to reload the package too. Try in order:
1. **Packages ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ MCP Server ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Restart Server**
2. **Packages ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Reload Packages** (or `window:reload` from the command palette)
3. Full Pulsar restart as a last resort
4. Restart the LLM client  --  some clients don't handle hot-reloaded tool lists gracefully.

### WARNING ###
> ÃƒÂ¢Ã…Â¡Ã‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â **Security Warning:** `run-command` has unrestricted shell access  --  any command can be executed. Destructive commands (`rm`, `Remove-Item`, `del`, `format` etc.) show a **Run / Cancel** confirmation widget in the chat panel before executing. Pass `confirm:true` to bypass this for automated workflows. **The confirmation check is pattern-based and not exhaustive**  --  commands that achieve destructive results indirectly (e.g. `patch`, `git clean -fd`, `robocopy /purge`, output redirection, PowerShell scripts) will not be caught. It can also match too much: it looks for the words anywhere in the command text, so a harmless command can trip it. With no chat panel open there is nowhere to show the Run / Cancel widget, so a matching command is **blocked outright** with an error instead  --  open the chat panel or pass `confirm:true`. The Command Output panel does not show the confirmation. It is strongly recommended to run Pulsar in a sandboxed or virtualised environment when this tool is enabled.

---
