# pulsar-edit-mcp-server — Work Tracking

> Last audited against live code: 2026-06-11 (v0.11.1)

## v0.11.1 — Fault log viewer, run-command pre-flight, logFailure context improvements (2026-06-11)

**New tools:**
- `get-failure-log` (debugging group) — query `failure-log.ndjson` directly from the LLM. Args: `tail` (default 20, max 200), `tool`, `reason`, `filePath` filters. Returns structured JSON. Complements `get-edit-stats` with per-failure detail. Added to `tool-catalogue.js`.

**Fault log viewer UI (`pulsar-edit-mcp-server.js`):**
- New `showFaultLog()` modal command (**Packages → MCP Server → Show Fault Log...**): reads `failure-log.ndjson`, shows newest-first table with `#`, Time, Tool (cyan), Reason (amber), File, Line, Detail columns. Live filter inputs for tool / reason / file substring. Count badge `X / Y entries` updates with filter. 🗑 Clear Log button with confirm prompt.
- Row click opens a detail overlay (absolutely-positioned inside the modal element — not a second modal panel). Shows all fields in a grid: `bufferPreview` dark-green, `diffVsBuffer` dark-red, `oldStrPreview` dark-amber monospace blocks. Raw JSON pre block at bottom. `← Back to list` button removes the overlay without closing the parent.

**`run-command` pre-flight + post-execution (`mcp-registration.js`):**
- Pre-flight: snapshots all open editor buffers as checkpoints keyed `_run-command-<ts>:<path>`. Saves all modified buffers to disk. Records mtimes of all open files.
- Post-execution: compares mtimes after process close; reloads any externally-modified files into buffers via `setTextViaDiff`. Result includes `preFlightCheckpoint`, `savedBeforeRun[]`, `reloadedAfterRun[]`.

**`logFailure` context improvements (`mcp-registration.js`):**
- `str_replace` noMatch/whitespace: `bufferPreview` ±5 lines around hint row, `oldStrPreview` first 6 lines formatted `[1]: ...\n[2]: ...`.
- `insert` anchorNotFound: `oldStrPreview` = full anchor string, `bufferPreview` = first 15 lines of function scope, `scopeLines` = range description.
- `replace-block` anchorNotFound: `oldStrPreview` = full anchor, `bufferPreview` = 15 lines from `searchStartRow`.
- `replace-function-body` notFound: `oldStrPreview` = fn name, `availableFunctions` = first 20 function names, `closestMatches` = near-miss names.

**Other:**
- `open-file` divergence warning added then removed — the post-execution buffer reload in `run-command` is the correct architectural answer (see refactor plan).
- `replace-across-files` closed-file handling: closed files now opened via `atom.workspace.open(filePath, {activateItem:false})` before `setTextViaDiff`. Full undo history on all affected files; no direct `fs.promises.writeFile` for content edits.
- `str_replace` similarity fix: closest-region and Levenshtein similarity score now always run on noMatch (was previously gated inside `if (fuzzyRow >= 0)` — dead code on single-line failures and pure noMatch cases).

## v0.11.0 — Library extraction refactor (2026-06-10)

`mcp-registration.js` has been refactored from a single ~8007-line monolith into a set of focused shared libraries. All code moves are pure extractions — no behaviour changes.

**Extracted libraries (new files):**
- `lib/edit-stats.js` (~800 lines) — session/lifetime stats, `bump()`, `bumpStyle()`, `flushLifetimeStats()`, `syncToLifetime()`, `summarise()`, `buildReport()`, `buildStyleReport()`. Also holds `process.on` exit hooks.
- `lib/tool-hints.js` (247 lines) — `anchorError()`, `smartSuggestion()`, `successNudge()`, `ambiguityCheck()`, consecutive failure counter objects.
- `lib/buffer-helpers.js` (265 lines) — `walkDir()`, `resolveStructuralAnchor()`, `findAnchor()`, `findFunctionInBuffer()`, `readFileOrBuffer()`, `retargetEditor()`.
- `lib/lint-helpers.js` (74 lines) — `maybeLintSuffix()`, `lintSnapshot()`.
- `lib/tool-catalogue.js` (94 lines) — `TOOL_CATALOGUE` array, `TOGGLEABLE_GROUPS` array.
- `lib/schema.js` (48 lines) — `ANCHOR_SCHEMA`, `STRUCTURAL_ANCHOR_SCHEMA` Zod schemas.

**Result:** `mcp-registration.js` reduced from **8007 → 6693 lines** (−1314 lines, −16%).

- Chat panel tool result handling fix (`chat-functions.js`): `addToolResultToHistory()` was calling `JSON.stringify(toolResult.content)` where `content` is already a `[{type,text}]` array — the model received raw JSON envelope strings instead of plain text and stopped using tools. Fixed to `content.map(c => c.text ?? '').join('\n')`. Added `isError` handling: prefixes `[tool error]` when `toolResult.isError` is true. Error text now also surfaced in chat display via `updateChatHistory`.

**Other changes in v0.11.0:**
- `grep-file` bug fix: no-match path was missing its `return` statement, causing "Tool execution failed" instead of `{ matchCount: 0 }`. Return envelope fix also required (raw objects silently dropped by MCP SDK).
- `ANCHOR_SCHEMA` expanded with full v0.10.29 hint set: `inFunction`, `inSymbol`, `afterFunction`, `beforeFunction`, `afterSymbol`, `beforeSymbol`, `afterString`, `beforeString`, `afterLine`, `beforeLine`, `lineContentHint`. All tools using `...ANCHOR_SCHEMA` spread pick up the new hints automatically.
- Stats UI improvements: `hintsUsed` init block updated with all new hint keys; `buildReport()` now groups tools logically (edit / search / nav / RE / shell); per-tool `pct` (hit%) added to every edit and search tool; group summary objects (`_editGroup`, `_searchGroup`, etc.) added.
- Stats panel renderer (`pulsar-edit-mcp-server.js`) updated: rescue counters (`fuzzyContent`, `autoStripComment`, `autoPartialMatch`, `rescued`) now visible; `get_structural_anchors` moved from Edit to Search group; search group badge correctly shows misses+faults.
- `resetLifetimeStats()` function added and exposed; "Reset Lifetime" button added to stats panel.
- Near-miss rescue counters: `autoPartialMatchCommits` separated from `fuzzyWhitespaceCommits`; `apply_patch.rescuedCommits` now tracked.
- Redundant post-`buildReport` ghidra/run_command injection removed from `getEditStats()` handler (now data-driven inside `buildReport()`).

## Files

- `lib/mcp-registration.js` — **~6693 lines.** Full Pulsar restart + babel cache clear required for registerTool/schema changes. Handler body changes hot-reload on save.
- `lib/edit-stats.js` — Stats counters, `bump()`, `summarise()`, `buildReport()`, `buildStyleReport()`, process exit hooks. Hot-reloads on save.
- `lib/tool-hints.js` — `anchorError()`, `smartSuggestion()`, `successNudge()`, `ambiguityCheck()`, consecutive failure counters. Hot-reloads on save.
- `lib/buffer-helpers.js` — Buffer/file utility functions: `walkDir()`, `resolveStructuralAnchor()`, `findAnchor()`, `findFunctionInBuffer()`, `readFileOrBuffer()`, `retargetEditor()`. Hot-reloads on save.
- `lib/lint-helpers.js` — `maybeLintSuffix()`, `lintSnapshot()`. Hot-reloads on save.
- `lib/tool-catalogue.js` — `TOOL_CATALOGUE` and `TOGGLEABLE_GROUPS` static data. Hot-reloads on save.
- `lib/schema.js` — `ANCHOR_SCHEMA`, `STRUCTURAL_ANCHOR_SCHEMA` Zod schemas. Hot-reloads on save.
- `lib/edit-response.js` — `buildEditResponse()`, `preEditSnapshot()`, `postEditDelta()`. Hot-reloads on save.
- `lib/struct-check.js` — `snapshot()`, `delta()` for structural integrity checks. Hot-reloads on save.
- `lib/style-checker.js` — Kernel C style rules, `applyStyleCheck()`, `isKernelFile()`. Hot-reloads on save.
- `lib/naming-checker.js` — `checkNaming()`, `checkFunctionDocs()`, `buildDocSkeleton()`. Hot-reloads on save.
- `lib/tree-sitter-symbols.js` — Tree-sitter symbol extraction + anchor resolution. Hot-reloads on save.
- `lib/string-utils.js` — Pure utilities: `escapeRegex`, `applyReplacement`, `globToRegex`, `levenshteinDistance`, `calculateSimilarity`. Hot-reloads on save.
- `lib/pulsar-edit-mcp-server.js` — Main UI/activation file. Requires Pulsar reload for most changes.
- `lib/chat-panel.js` — Chat panel UI. Requires Pulsar reload (no hot-reload).
- `styles/pulsar-edit-mcp-server.less` — Stylesheet. Hot-reloads on save.

---

## TODO — Priority Order

| # | Priority | Item | Notes |
|---|---|---|---|
| 1 | 🏗️ LARGE | Tool Framework `lib/tool-framework.js` | Next major item. See full design below. |
| 2 | 📋 LARGE | Tool Framework — per-tool feature plan | Before/during framework build: document each tool's features as a checklist so nothing gets lost in the migration. Tick off as each is ported. See note below. |
| 3 | 📁 MEDIUM | File context staleness warning | Buffer version tracking. See design below. |
| 4 | 🖼️ MEDIUM-HIGH | Visual diff decorations (Cursor-parity) | Inline editor green/red decorations. See design below. |
| 5 | 📊 MEDIUM | Show diff faults in stats like window | Idea: surface diff-fault breakdown in `get-edit-stats` the same way the hint window shows — e.g. per-rule fault counts rendered as a mini table/window. Needs design. |
| 6 | 🔍 MEDIUM | Capture fuzzy trigger detail in edit stats | When a fuzzy auto-retry fires (fuzzyWhitespace, fuzzyContent, autoPartialMatch), capture *what* caused it — the diffVsBuffer or a short "reason token" — so `get-edit-stats` can show "autoFuzzyWhitespace x3: trailing space on line N" rather than just a count. Helps distinguish real encoding mismatches from stale old_str. |
| 7 | 🔤 LOW-MEDIUM | Case-insensitive fuzzy matching in str_replace | When str_replace noMatch, optionally retry with case-folded comparison. Use case: LLM sends wrong capitalisation (e.g. `Const` vs `const`). Would be a 5th auto-retry block after partialMatch. Need to assess false-positive risk — case matters in most languages. |
| 8 | 🖼️ MEDIUM | Inline diff in chat panel | See design below. |
| 9 | 🚫 MEDIUM | Pulsar ignore / `.mcp-ignore` | See design below. |
| 10 | 🔧 LOW | Named capture groups `$<name>` in `applyReplacement` | Low priority quality-of-life. |
| 11 | 🧪 MEDIUM | Automated testing + script runner (Tier 1/2/3) | See design below. |
| 12 | 💾 LOW | Disk-backed checkpoints | See design below. |
| 13 | 🔀 LOW | Git integration tool | See design below. |
| 14 | 🔍 MEDIUM | grep-project fails on mcp-registration.js | Investigate: grep-project appears to fail or return partial results on `mcp-registration.js` specifically (8007 lines, CRLF, heavy Unicode). May be a line-length or encoding issue in the search backend. Reproduce + root-cause before fixing. |
| 15 | 📝 LOW | Document string anchors for unstructured files | See note below. |

---

### ✅ DONE — Extend `smartSuggestion` + `logFailure` to remaining edit tools

Completed 2026-06-09. `logFailure` and `smartSuggestion` now wired to `replace-block`, `insert` anchorNotFound, and `replace-function-body` notFound. All main edit tools covered.

---

### 📋 Tool Framework — per-tool feature plan

Before starting the framework migration, create a checklist document (or a section here) that lists every tool by name with its features ticked: `dryRun`, `lint`, `styleCheck`, `consecutiveFailureCounter`, `smartSuggestion`, `buildEditResponse`, `logFailure`, `stats keys`. Use this as the migration ledger — each tool gets a row, features get columns, tick off as each is ported to `registerMcpTool()`. This prevents features from silently dropping during the rewrite of an 8000-line file.

**Suggested format:**

| Tool | dryRun | lint | styleCheck | failCounter | smartSugg | logFailure | migrated |
|---|---|---|---|---|---|---|---|
| str_replace | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| insert | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ |
| ... | | | | | | | |

**Complexity:** Low prep work, high value as a migration safety net.

---

### 📝 LOW — Document string anchors for unstructured files

**Status:** Already implemented — `afterHint` and `betweenHint` accept arbitrary strings and do a text scan, not just symbol names. The gap is LLM awareness.

**Action:** Add a worked example to the `str_replace`/`insert` tool description covering markdown/config use cases, e.g. `afterHint:"## Installation"` to insert after a heading. One-line addition to TOOL_CATALOGUE description strings.

---

### 📁 MEDIUM — File context staleness warning (Pulsar buffer version tracking)

**Problem:** If the user edits a file in Pulsar between two LLM tool calls (e.g. manually fixes a line after a bad edit, or saves from an external tool), the LLM's mental model of the file is stale. The next `str_replace` or `replace-function-body` will use the old context. Currently we give no warning — the edit either silently hits the wrong place or fails with a confusing noMatch.

The thing to note here is that we mostly use hints as anchor points not line numbers so this has limited uses except for calls without hints, but it is still good for context so the LLM is aware of this.

This also could be handy for multiple LLMs working on the same content as it is technically possible to have multiple http mcp clients connected at the same time.

Pulsar's `TextBuffer` exposes `buffer.changeCount` (increments on every change) and `buffer.isModified()`. We already hold a reference to the live buffer in every tool handler.

**Implementation:**
1. Add a `Map<filePath, changeCount>` (`fileReadVersions`) at module scope, cleared on server start.
2. In `read-lines`, `get-document`, `grep-file` commit paths: record `fileReadVersions.set(filePath, buffer.changeCount)`.
3. In `str_replace`, `replace-function-body`, `insert`, `delete-line-range` commit paths: before applying, check if `buffer.changeCount !== fileReadVersions.get(filePath)`. If so, prepend warning: `"⚠️ stale context: file has changed since last read (buffer version +3). Verify your old_str still matches before proceeding."`.
4. Clear the entry when a write tool succeeds — record the post-write changeCount immediately to avoid false positives on our own edits.

---

### 🚫 MEDIUM — Pulsar ignore / file exclusion (`.mcp-ignore`)

**Problem:** `replace-across-files`, `grep-project`, `get-project-files`, `get-repo-map` currently have no file exclusion beyond the `.mcp-baseline/` glob guard in replace-across-files. On large projects with `node_modules`, build output, or generated files, tools return noise and waste tokens.

**Proposed:** A `.mcp-ignore` file at the project root (gitignore syntax). Loaded once at server start, re-loaded on file-save event. Applied as a filter in: `get-project-files`, `grep-project`, `get-repo-map`, `replace-across-files`, `list-project-functions`.

Default exclusions baked in (no `.mcp-ignore` needed): `node_modules/**`, `.mcp-baseline/**`, `*.min.js`, `dist/**`, `build/**`.

**Implementation:** ~50 lines. Use `micromatch` (already a dependency via globToRegex) or a simple gitignore-style line parser. Single `shouldIgnore(filePath)` helper called at each filter point.

---

### 🏗️ LARGE — Tool Framework (`lib/tool-framework.js`) — eliminate per-tool boilerplate

**Status:** Design complete (2026-06-06). Not yet started.

**Problem:** Every tool in `mcp-registration.js` hand-rolls the same bookkeeping scaffold:

- `editStats` / `lifetimeStats` init — declared per-tool at module scope (~L93–300). Adding a fail reason touches 3 places: init, `summarise()`, `buildReport()`.
- Instrumentation call sites inside each handler — `bump()`, `counter.count++/=0`, `smartSuggestion(...)`, `buildEditResponse(...)`, `dryRuns` bump. A cross-cutting change (e.g. the `dryRuns` fix) required touching every handler.
- `summarise()` and `buildReport()` hand-enumerate every tool explicitly — adding a tool means updating them too.

This is the root cause of most stat bugs fixed in v0.10.24 and the bump refactor session.

**Proposed fix:** `lib/tool-framework.js` — a `registerMcpTool()` wrapper. Each tool becomes a declarative config object; the framework handles all cross-cutting concerns automatically.

**Tool config shape:**

```js
registerMcpTool(server, {
  name:     'str_replace',
  group:    'edit',
  category: 'edit',            // 'edit' | 'search' | 'command' | 'nav'
  features: {
    dryRun:                    true,
    lint:                      true,
    consecutiveFailureCounter: true,
    smartSuggestion:           true,
    buildEditResponse:         true,
    styleCheck:                true,
  },
  stats: {
    fails:     ['noMatch', 'whitespace', 'partialMatch', 'ambiguous',
                'outOfScope', 'afterNotFound', 'wrongOccurrence'],
    hintsUsed: ['functionHint', 'afterHint', 'lineNumberHint', 'betweenHint',
                'occurrence', 'fuzzyWhitespace'],
    extras:    ['fuzzyWhitespaceCommits', 'fuzzyContentCommits',
                'regexCommits', 'lineNumberHintFallback', '_oldStrLenSum'],
  },
  inputSchema: { old_str: z.string(), new_str: z.string(), ...ANCHOR_SCHEMA },
  description: [...],
  handler: async (args, ctx) => {
    // ctx provides: editor, buffer, allLines, text, allSymbols
    //               bump(subPath, n)   — pre-namespaced to this tool
    //               fail(reason, msg) — bump + counter++ + smartSuggestion + return error
    //               commit(meta)      — counter=0 + bump hits + buildEditResponse + style/lint
    //               dryRunReturn(p)   — bump dryRuns + return preview
    //               consecutiveFailures — the { count } object
    // Handler contains ONLY the tool-specific logic — no bookkeeping.
  }
});
```

**What `registerMcpTool()` does automatically:**
- Auto-inits `editStats[tool]` and `lifetimeStats[tool]` from `stats` config — no separate declaration
- Creates consecutive-failure counter if `features.consecutiveFailureCounter`
- Injects `ctx` into the handler
- `ctx.fail(reason, msg)` → bumps `fails.reason` + `counter.count++` + appends `smartSuggestion` + returns error object
- `ctx.commit(meta)` → `counter.count=0` + bumps `hits` + calls `buildEditResponse` + appends style/lint/struct warnings
- `ctx.dryRunReturn(preview)` → bumps `dryRuns` + returns preview
- `summarise()` and `buildReport()` become **data-driven** — iterate `Object.keys(editStats)` instead of hand-enumerating

**What stays the same:** `bump()`, `ANCHOR_SCHEMA`, `STRUCTURAL_ANCHOR_SCHEMA`, `buildEditResponse()`, `smartSuggestion()`, `successNudge()`, `bumpStyle()`, `applyStyleCheck()`, `syncToLifetime()`, `flushLifetimeStats()`, all handler logic.

**Migration phases (incremental — introduce alongside existing pattern):**

| Phase | Scope | Risk | Notes |
|---|---|---|---|
| 0 | Make `summarise()` + `buildReport()` data-driven | Low | No handler changes. Immediate win — `Object.keys(editStats)` replaces hand-enumeration. |
| 1 | Write `lib/tool-framework.js` + `registerMcpTool()`. Migrate `replace-all` + `replace-document` as PoC. | Low-Med | Two simple tools with no consecutive counter. Verify stats identical before/after. |
| 2 | Migrate 8 main edit tools (`str_replace`, `insert`, `delete-line-range`, `delete-block`, `replace-function-body`, `replace-block`, `sed`, `apply-patch`). | Med | One tool at a time. Pre-reboot checklist after each. `apply-patch` needs escape hatch for `rescueAvailable` return shape. |
| 3 | Migrate search/nav tools. Leave Ghidra tools as-is. | Low | Ghidra tools have minimal boilerplate and change rarely. |
| 4 | Delete old manual stats declarations + module-scope consecutive-failure counters (now auto-generated). | Low | Final cleanup — only after all tools migrated and verified. |

**Escape hatches needed:**
- `apply-patch` has `rescueAvailable` and `confirm:true` flow — handler needs to return custom shapes; `ctx.commit()` needs a `raw:true` override.
- `namingcheck`, `check-function-docs`, `insert-function-doc` use local `curStats` inline-init — intentional, keep as-is (not migration targets).

**Complexity:** Large overall, but each phase is Low-Medium. Phase 0 alone takes ~30 min with no risk. Full migration: 4–6 sessions.

**This supersedes the old "Split mcp-registration.js" item** — splitting into per-tool files was the previous answer to the same problem. The framework approach is better: tools stay co-located (easier to cross-reference), the common infrastructure is shared, and the result is more maintainable than N separate files each re-importing the same helpers.

---

### 🖼️ MEDIUM-HIGH — Visual diff decorations (Cursor-parity)

Render proposed changes as inline editor decorations — green/red lines in the Pulsar gutter. Claude proposes, user visually reviews in-editor, then accepts or rejects.

- New tool `stage-edit` or `dryRun:true` returns a staged state
- Use `editor.decorateMarker()` with custom CSS classes
- Store staged state in module-level `stagedEdit` object (similar to `patchRescueStore`)
- `commit-staged` / `discard-staged` or reuse `confirm:true` pattern from apply-patch
- `highlight-range` decoration system already exists — build on that

**Complexity:** Medium-high.

---

### 🖼️ MEDIUM — Inline diff in chat panel

Show before/after diff rendered directly in the chat display after each edit — no new tab, no editor clutter.

**How other tools do it (researched 2026-06-04):**
- **Cursor** — renders green/red line decorations inline *in the editor file itself* before accept/reject. Requires deep VS Code fork access to the rendering layer. Not replicable in a Pulsar extension without the visual diff decorations feature below.
- **Cline** — opens a native VS Code side-by-side diff tab per edit. Works but creates tab noise — the exact thing we want to avoid.
- **Claude Code (VS Code ext)** — inconsistent: small edits show a diff block inline in the *chat panel*; full file writes open a side-by-side editor tab. Users are complaining about the inconsistency. The `+12 -1` stats indicator in Claude Desktop is a lighter alternative.
- **Aider** — terminal only. Diffs are opt-in via `/diff` command or `--show-diffs` flag. Retroactive, not pushed.

**Proposed approach** — inline diff block in the chat display after each edit, matching what Claude Code does for small edits (the better half of their inconsistent UX):
- `diff` library already imported
- Collapsible block with `+N -N` summary line (matches Claude Desktop stats indicator) — click to expand full unified diff
- Always visible summary, detail on demand — avoids noise for large edits
- `chat-functions.js` + `chat-panel.js` only, no new tools needed

**Complexity:** Medium.

---

### 🧪 MEDIUM — Automated testing and script runner

**Status:** Design complete. Not yet started. Three tiers — do Tier 1 first, others depend on it.

#### Tier 1 — Script runner: drive the existing HTTP endpoint from a JSON script file

The MCP HTTP server is already running at `localhost:PORT`. A script runner is just a Node.js CLI that reads a `.json` script file and POSTs each step to the existing server — no new server, no new protocol.

**Script format (`scripts/verify-tools.json`):**
```json
{
  "name": "post-edit verification",
  "steps": [
    {
      "tool": "run-command",
      "args": { "command": "node --check lib\\mcp-registration.js" },
      "assert": { "exitCode": 0 }
    },
    {
      "tool": "get-diagnostics",
      "args": { "scope": "project" },
      "assert": { "messageCount": 0 }
    },
    {
      "tool": "str_replace",
      "args": {
        "old_str": "const TEST_ANCHOR = 'hello';",
        "new_str": "const TEST_ANCHOR = 'hello';",
        "dryRun": true
      },
      "assert": { "matched": true }
    }
  ]
}
```

**Runner (`scripts/run-script.js`):**
```js
// node scripts/run-script.js scripts/verify-tools.json
// POSTs each step to localhost:PORT/mcp/v1/tools/call
// Reports pass/fail per step, exits non-zero if any assert fails
```

**Invocation from chat panel or run-command:**
```
run-command: node scripts/run-script.js scripts/verify-tools.json
```

**Key design points:**
- No new server, no new protocol — uses the HTTP endpoint the MCP SDK already exposes
- Script files are version-controlled alongside the package — they accumulate over time as a regression suite
- `assert` block is optional — steps without asserts still run and report output (useful for smoke tests)
- Supported assert keys: `exitCode`, `messageCount`, `matched`, `applied`, `hits`, `contains` (substring in response text), `not_contains`
- On failure: print the actual response + diff vs expected, exit 1

**Files needed:** `scripts/run-script.js` (~80 lines), script `.json` files in `scripts/`

**Complexity:** Low. The HTTP endpoint is already there; this is a thin client.

---

#### Tier 2 — In-process test harness: call tool handlers directly, assert on output

For unit-testing individual tool handlers without the HTTP overhead and without Pulsar running. Useful for CI, for testing edge cases that are hard to reproduce live, and for the tool framework migration (verify each migrated tool produces identical output).

**How:** Export a `callTool(name, args)` function from `mcp-registration.js` that bypasses HTTP and calls the registered handler directly with a mock `editor`/`buffer` context.

```js
// spec/tool-harness.js
const { callTool, mockEditor } = require('../lib/mcp-registration');

const editor = mockEditor({
  text: 'const x = 1;\nconst y = 2;\n',
  filePath: 'test/fake.js'
});

const result = await callTool('str_replace', {
  old_str: 'const x = 1;',
  new_str: 'const x = 99;',
}, editor);

assert(result.matched === true);
assert(editor.getText().includes('const x = 99;'));
```

**Key design points:**
- `mockEditor(options)` returns a minimal object implementing the Pulsar `TextEditor` API surface the tools use (`getText`, `getLines`, `setTextInRange`, `getPath`, etc.) — pure JS, no Pulsar needed
- Test files live in `spec/` alongside existing spec files
- Run with `node --test spec/tool-harness.js` (Node 18+ built-in test runner) or plain `node spec/tool-harness.js`
- The tool framework (item 1 in TODO) makes this much easier — once handlers receive `ctx` injection, `mockEditor` is just a mock `ctx`
- Doubles as the regression suite for the tool framework migration: run before and after each tool migration, assert outputs match

**Files needed:** `spec/tool-harness.js`, `lib/mock-editor.js` (~100 lines)

**Complexity:** Medium. `mockEditor` needs to cover the Pulsar buffer API surface used by tools — about 15 methods. The tool framework makes this significantly easier.

**Dependency:** Benefits greatly from Tool Framework Phase 1 being done first (handlers become testable in isolation). Can be started independently but is much cleaner after the framework exists.

---

#### Tier 3 — Named procedures: reusable tool sequences with conditional logic

A named, version-controlled procedure system — sequences of tool calls with variable substitution, conditionals, and loops. Invokable by name from the chat panel or from Tier 1 scripts.

**Procedure format (`procedures/post-edit-verify.proc.json`):**
```json
{
  "name": "post-edit-verify",
  "description": "Run after any mcp-registration.js edit",
  "vars": { "file": "lib/mcp-registration.js" },
  "steps": [
    { "tool": "run-command",    "args": { "command": "node --check {{file}}" }, "assert": { "exitCode": 0 }, "on_fail": "abort" },
    { "tool": "get-diagnostics","args": { "scope": "project" },                 "assert": { "messageCount": 0 } },
    { "tool": "get-edit-stats", "args": {} }
  ]
}
```

**Invocation from chat:**
```
@// post-edit-verify
```
(via the existing `@//` shortcuts system — procedures are just a richer kind of shortcut)

**Difference from Tier 1:** Tier 1 is a static sequence. Tier 3 adds: variable substitution (`{{file}}`), `on_fail: abort | continue | retry`, conditional steps (`"if": "{{exitCode}} == 0"`), and named procedures invokable from chat shortcuts — closing the gap with Windsurf Cascade workflows.

**Complexity:** Medium. The runner from Tier 1 is the engine; Tier 3 adds a template/conditional layer on top.

**Dependency:** Build on Tier 1. The `@//` shortcuts system already exists as the invocation mechanism.

---

**Relationship to other TODO items:**

- **Tool Framework** — Tier 2 (in-process harness) pairs directly with the framework migration: run the harness before/after each tool migration as a correctness gate.
- **Failure capture** — script runner (Tier 1) can run known-failure scenarios and assert the NDJSON log records the right `reason` and `diffVsBuffer`.
- **Per-step approval (Feature Gap table)** — Tier 3 procedures are a natural place to hook in per-step approval UI: show each step's intent in the chat panel before executing.

**Priority within this item:** Tier 1 first (standalone, no dependencies, immediately useful). Tier 2 after Tool Framework Phase 1. Tier 3 after Tier 1 is working.

---

### 💾 LOW — Disk-backed checkpoints

**Status:** Not started.

**Problem:** In-memory checkpoints are wiped on every `mcp-registration.js` save (Pulsar hot-reload). Any multi-step edit sequence that spans a server reload loses its safety net. The gap table notes Cline uses a shadow git repo for this.

**Proposed:** `checkpoint-to-disk name` / `restore-from-disk name` tool pair. Snapshot = file path + full text written to `.mcp-checkpoints/<name>-<timestamp>.json`. No git required. Survives reloads. The existing `checkpoint` / `restore-checkpoint` tools stay as fast in-memory fallbacks.

**Implementation:** ~40 lines in a new handler. `fs.writeFileSync` on checkpoint, `fs.readFileSync` + `buffer.setText()` on restore. Store in package dir alongside `edit-stats.json`.

---

### 🔀 LOW — Git integration tool

**Status:** Not started. `run-command` can already call git — this is about surfacing it cleanly as a first-class tool.

**Problem:** After a successful editing session there's no easy way to commit the work with a meaningful message. Manually running `run-command` with a git command works but is clunky and not tracked in edit stats.

**Proposed:** A `git-commit` tool: takes a `message` param, runs `git add -p` interactively or `git add <files>` + `git commit -m`. Returns the commit hash. Could also expose `git-status` (cleaner than `run-command git status`) and `git-diff` (show pending changes before committing).

**Implementation:** Thin wrappers around `run-command` internals. Low complexity — the interesting design question is whether to auto-add all modified files or require explicit paths.

---

### Future / lower priority

- **Linting + test loop** — `get-diagnostics` and `get-compiler-diagnostics` exist but no automatic post-edit test runner. A `run-tests` tool that fires after edits and pipes failures back would close that gap.

---

### Post-edit structural integrity checks

**Problem:** The inline linter (`lint:true` param) exists and works but is effectively invisible — it is not mentioned in any tool description string in TOOL_CATALOGUE, only in the Zod schema. As a result it is never passed by the LLM and provides zero value in practice. Separately, a whole class of post-edit failures (brace imbalance, unclosed block comments, `#if`/`#endif` imbalance) produce no feedback at all — the edit succeeds and the damage is silently compounded by subsequent edits.

**Two tiers of fix:**

**Tier 1 — always-on fast structural checks (per-edit, inline)**

A new `lib/struct-check.js` module exporting `structuralIntegrityCheck(text, filePath)` — same call signature as `applyStyleCheck`, appends a warning suffix or empty string. Runs on the full buffer text after commit (not just `new_str` — brace delta is only meaningful at buffer scope). Single tokeniser pass tracking state `(NORMAL | LINE_COMMENT | BLOCK_COMMENT | STRING | CHAR)`. Checks:

- **Brace/bracket/paren balance** — `{ } [ ] ( )` delta. Flag if nonzero after edit.
- **Unclosed block comment** — track `/*`/`*/` pairs; flag with line number of unclosed opener.
- **`#if`/`#endif` balance** — preprocessor nesting depth; flag if nonzero at EOF.

Wire into same 15 commit sites as `buildEditResponse` (which wraps `applyStyleCheck`): `str_replace`, `replace-function-body`, `insert`, `replace-document`, `replace-all`, `sed`, `apply-patch`, `delete-line-range`, `delete-block`, `replace-block`, `replace-across-files`, and all remaining handlers. Add `_structWarnings` counter to stats. Target ~150 lines, <2ms on a 1000-line file.

**Tier 2 — token-stream state machine (per-edit, medium complexity)**

Extend the tokeniser with a depth-tracking register machine (~15 token types, no AST needed):

- **Missing `break` in switch case** — track `SWITCH_BODY` mode; flag `case:` reached without preceding `break`/`return`/`/* fallthrough */`.
- **Keyword not followed by brace** — after `if(...)`/`for(...)`/`while(...)`, next non-whitespace token must be `{`. Flags dangling-body patterns.
- **Unreachable code after `return`** — code following `return` at same brace depth before next `}` or `case`.
- **Duplicate `case` values** — tokenise and deduplicate case labels within a switch.

**Tier 3 — `verify-file` tool (end-of-task, explicit)**

A new `verify-file` tool bundling: full-buffer structural integrity (Tiers 1+2), linter snapshot (whole file), style report, and optionally compiler diagnostics. Tool description: *"Call this before reporting a task complete on any code file."* Addresses the Verification & Termination failure class — makes verification a named step in the protocol, not an ad-hoc memory item.

**Always-on, non-disableable — design principles:**

Remove the `lint` param entirely rather than defaulting it to `true`. No escape hatch at the tool level — the LLM should not be able to suppress its own safety net. Silent when clean means no opt-in is needed anyway.

The key design requirement to make always-on non-annoying is **delta checking** — compare post-edit state against pre-edit baseline captured just before the buffer write:

- **Structural checks (brace/comment/#if balance):** only warn if the imbalance is *worse* than before the edit. Capture pre-edit counts, compare post-edit counts, warn only if `post > pre`. This suppresses false positives during multi-call rewrites — a deliberate two-step rewrite with an intermediate imbalanced state won't false-positive because the delta is zero on the first step.
- **Linter:** capture the set of linter message digests before the edit, compare after. Only surface messages that are *new* — pre-existing errors are not the LLM's fault on this edit and shouldn't appear in this response. This is strictly better than the current opt-in behaviour which either shows everything or nothing.

Implementation: each edit tool captures `preEditSnapshot()` (brace counts + linter message set) before `buffer.setTextInRange(...)`, then calls `postEditDelta(pre, post)` to produce the suffix. Both helpers are stubbed in `lib/edit-response.js`; the tokeniser logic will live in `lib/struct-check.js` and be called from there.

**Complexity:** Tier 1 = Low-Medium (delta snapshot adds state). Tier 2 = Medium. Tier 3 = Low.

---

### Session-notes policy schema (deferred — architecture decision)

**Background:** Reviewed suggestion to restructure session notes from free-text into a structured policy/state-machine schema with fields: `task_class`, `file_class`, `failure_class`, `recommended_tool`, `recommended_hints`, `confidence`, `last_seen`, `success_count`, `failure_count`, `deprecated`, `priority_score`.

**Assessment — do not implement yet.**

The schema solves a problem that doesn't exist in the current architecture. Notes are read once at session start by the LLM; there is no server-side selection layer. Adding structured fields without a selection layer adds maintenance overhead with no runtime benefit — the LLM still reads all notes and interprets them opportunistically regardless of schema.

The schema becomes valuable only if the server intercepts tool calls and injects relevant policy inline at the point of use. The inline nudge pattern (`smartSuggestion`, `[lineNumberHintFallback]` warnings) is already the proven delivery mechanism for this — it lands policy at the exact decision point, not front-loaded in session notes the LLM may have deprioritised 30 tool calls ago.

**What to do instead (low cost, immediate value):**
- Add `[DEPRECATED]` prefix to obsolete session notes so the LLM skips them.
- Add `failure_class:` tag as free text to new notes — enables future grep/categorisation if a selection layer is built.
- If a selection layer is ever built, only two fields are load-bearing: `deprecated`/`superseded_by` and a `priority_score` or `success_count`/`failure_count` pair. Everything else is analytics.

**Revisit if:** session notes exceed ~25 entries and the LLM demonstrably starts missing older ones, or a tool-intercept architecture is built for `verify-file` / per-step approval.

---

## Feature Gap Analysis — vs Other Tools (researched 2026-06-04)

### What we have that others don't
- **Kernel C style checker** — inline, per-edit, rule-level violation reporting. No other tool does language-specific style at this depth.
- **naming-checker** — verb-segment, camelCase, doc skeleton generation. Unique.
- **Ghidra integration** — reverse engineering workflow. Unique.
- **Edit stats + hints system** — tracks hit/fault rates per tool, surfaces smarter suggestions based on failure patterns. Unique.
- **Self-updating project rules + repo map** — `session-notes` acts as a living CLAUDE.md: the LLM writes its own codebase-specific rules, tool preferences, and lessons learned, then reads them back at the start of every session. Combined with `get-repo-map` at session start, the LLM arrives with full structural context and accumulated knowledge of what works on this codebase. Better than a static user-written rules file because it improves automatically.
- **`@//` prompt shortcuts** — named prompt templates in `shortcuts.md`, invokable from the chat input with live filter dropdown. Functionally equivalent to Windsurf Cascade workflows at a fraction of the complexity.
- **apply-patch fuzzy rescue** — fuzzy rescue confirm:true flow implemented but apply-patch itself (0/40 lifetime hits) is effectively deprecated. The fuzzy infrastructure remains in place for future use.
- **Tree-sitter symbol resolution** — all hint/anchor resolution (afterHint, betweenHint, functionHint) backed by tree-sitter live buffer. Regex fallback for unsupported grammars (Ghidra decompiled C). Unique depth for a Pulsar extension.

### What others have that we don't — gap table

| Feature | Cursor | Windsurf | Cline | Claude Code | Us | ★ Unique to us | Notes |
|---|---|---|---|---|---|---|---|
| Plan mode (describe task → plan → approve) | ✅ | ✅ | ✅ | ✅ | ❌ | | High value. LLM proposes step-by-step plan in chat before touching files. User approves/edits plan first. |
| Per-step approval in agentic runs | ✅ | ✅ | ✅ | ✅ | ❌ | | Each tool call shows intent + asks confirm before executing. |
| Inline diff in editor (green/red decorations) | ✅ | ✅ | ❌ | ❌ | ❌ | | Already in plan as visual diff decorations. Cursor-only due to fork. |
| Inline diff in chat panel | ❌ | ❌ | ❌ | ✅ (partial) | ❌ | | Already in plan. |
| Reusable task workflows / recipes | ❌ | ✅ Cascade | ❌ | ❌ | ✅ `@//` | ★ | `@//` shortcuts in `shortcuts.md` — named prompt templates with live filter dropdown. Equivalent to Windsurf Cascade workflows, simpler format. |
| Context window usage indicator | ❌ | ❌ | ✅ | ✅ | ❌ | | Token count + cost per interaction shown in chat. Low-medium value. |
| Auto context compaction / summarisation | ❌ | ❌ | ❌ | ✅ /compact | ❌ | | Summarises old history to free window. Medium value for long sessions. |
| CLAUDE.md / project rules file | ❌ | ❌ | ❌ | ✅ | ✅ | ★ | Covered by session-notes: LLM writes and self-updates its own rules, tool preferences, and lessons. Read back at every session start. Better than a static file — improves automatically with use. |
| Codebase orientation / repo map on startup | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | get-repo-map called at session start gives full structural context. Combined with session-notes, the LLM arrives knowing both the code layout and accumulated lessons for this project. |
| Multi-agent / parallel agents | ✅ (8x) | ✅ Cascade | ✅ Kilo fork | ✅ Agent tool | ❌ | | Complex. Out of scope for single-server architecture. |
| Arena mode (compare model outputs) | ❌ | ✅ | ❌ | ❌ | ❌ | | Run same task on 2+ models, pick winner. Interesting but niche. |
| Auto model selection per task | ✅ Auto | ❌ | ❌ | ❌ | ❌ | | Cursor picks best model automatically. We have manual model combobox with persistence. |
| Browser / web access during task | ❌ | ❌ | ✅ | ✅ | ❌ | | Cline/Claude Code can fetch URLs mid-task. run-command + curl is a workaround. |
| Spend / token limit guard | ❌ | ❌ | ✅ | ❌ | ❌ | | Cline v3.78 added spend limit UI to stop runaway agents. |
| .cursorrules / per-project AI config | ✅ | ❌ | ❌ | ❌ | ❌ | | Per-project rules file that shapes AI behaviour. We cover this via session-notes (see above). |
| Checkpoint / restore mid-task | ❌ | ❌ | ✅ shadow git | ❌ | ✅ buffer + disk | ★ | Buffer checkpoints in place. Disk-backed checkpoints in TODO — survive hot-reload. Git integration also in TODO. |
| Kernel C style checking (inline per-edit) | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | Per-edit violation reporting scoped to changed lines. Rule-level breakdown. checkpatch for full-file audit. |
| Function naming + doc skeleton generation | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | namingcheck, check-function-docs, insert-function-doc. Kernel C only. |
| Ghidra reverse engineering integration | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | Full RE tool suite via Ghidra MCP bridge. |
| Edit stats + smart failure suggestions | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | Per-tool hit/fault/hint tracking. Surfaces tool-switch suggestions on first failure, not third. |
| Persistent cross-session LLM notes | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | session-notes tool. LLM writes lessons learned; reads them back next session. Self-improving — no user maintenance needed. |
| Aider-style repo map (tree-sitter) | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | get-repo-map with PageRank symbol ranking. Integrated natively, no Aider install needed. |
| apply-patch fuzzy rescue | ❌ | ❌ | ❌ | ❌ | ⚠️ | | Fuzzy rescue with confirm:true flow implemented. apply-patch has 0 lifetime hits — effectively deprecated in favour of str_replace. Infrastructure retained. |

### Highest value gaps to consider

1. **Plan mode** — describe task → LLM outputs numbered step plan in chat → user approves/edits → execution begins. Prevents wasted edits on misunderstood tasks. All four major tools have this. Could be a chat panel mode toggle (`/plan` prefix or Plan button). LOW-MEDIUM implementation complexity — it's a prompting/UX pattern, not a new tool.

2. **Per-step approval** — before each tool call in an agentic run, show intent in chat and wait for user confirm. Cline's defining UX. Pairs naturally with plan mode. MEDIUM complexity — requires chat panel to intercept tool dispatch.

3. **Context window indicator** — show token usage in chat panel header. MEDIUM-LOW complexity — needs token counting on the callLLM response (usage field already in API response).

4. **Disk-backed checkpoints** — now in TODO above (💾 LOW). Git integration also in TODO (🔀 LOW).

5. **Reusable workflows** — named prompt+tool recipes stored in a JSON file, invokable by name from chat. Windsurf Cascade's killer workflow feature. MEDIUM complexity. `@//` shortcuts cover the prompt-template use case already — this would add tool sequencing on top.

---

## Edit Strategy (key rules)

- `open-file` before any str_replace — buffer must be active
- `fuzzyWhitespace:true` as default for mcp-registration.js (mixed indentation throughout)
- `afterHint` on unique nearby string is the most reliable scope anchor; `betweenHint` when afterHint is ambiguous
- `dryRun:true` before any str_replace with old_str > 5 lines
- `replace-function-body` first for whole-function rewrites
- `replace-block` for `{}` brace blocks ONLY — never `[]` array literals
- `save-all` after every edit — never batch edits without saving between them
- Saving mcp-registration.js triggers hot-reload — checkpoints wiped, MCP server cache restarts
- **Reload procedure:** close Pulsar → delete `.pulsar/compile-cache/js/babel/` → reopen Pulsar → restart Claude Desktop
- `betweenHint` is the best disambiguator when `afterHint` hits an earlier occurrence
- `$1`/`$2` backreferences in `replace-across-files`/`replace-all`/`sed` replacement strings work correctly (fixed v0.10.27 via `applyReplacement`).
- `replace-across-files` glob must always be `lib/*.js`, never `**/*.js` — the latter hits `.mcp-baseline/` which is a read-only backup and must never be modified. `replace-across-files` has no excludeGlob param so a positive lib/ scope is the only safe option. Same applies to `grep-project` when searching for edit targets.
- `functionHint` never on .md files — use lineNumberHint or afterHint instead
- `grep-file` before str_replace on any file to confirm exact anchor text and line numbers
- chat-panel.js and .less changes require Pulsar package reload — they do NOT hot-reload on save
