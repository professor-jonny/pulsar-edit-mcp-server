# pulsar-edit-mcp-server — Work Tracking

> Last audited against live code: 2026-06-11 (v0.11.0)

## Files

- `lib/mcp-registration.js` — **~6693 lines.** Full Pulsar restart + babel cache clear required for registerTool/schema changes. Handler body changes hot-reload on save.
- `lib/edit-stats.js` — Stats counters, `bump()`, `summarise()`, `buildReport()`, `buildStyleReport()`, process exit hooks. Hot-reloads on save.
- `lib/tool-hints.js` — `anchorError()`, `smartSuggestion()`, `successNudge()`, `ambiguityCheck()`, consecutive failure counters. Hot-reloads on save.
- `lib/buffer-helpers.js` — `walkDir()`, `resolveStructuralAnchor()`, `findAnchor()`, `findFunctionInBuffer()`, `readFileOrBuffer()`, `retargetEditor()`. Hot-reloads on save.
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
- `lib/chat-functions.js` — Chat LLM dispatch + tool call handling. Requires Pulsar reload.
- `styles/pulsar-edit-mcp-server.less` — Stylesheet. Hot-reloads on save.

---

## TODO — Priority Order

| # | Priority | Item | Notes |
|---|---|---|---|
| 1 | 🏗️ LARGE | Tool Framework `lib/tool-framework.js` | Next major item. See full design below. |
| 2 | 📋 LARGE | Tool Framework — per-tool feature plan | Before/during framework build: checklist of every tool's features (dryRun, lint, styleCheck, failCounter, smartSugg, logFailure) as migration ledger. |
| 3 | 🖼️ MEDIUM-HIGH | Visual diff decorations (Cursor-parity) | Inline editor green/red decorations. See design below. |
| 4 | 📊 MEDIUM | Show diff faults in stats window | Surface diff-fault breakdown in `get-edit-stats` per-rule as a mini table. Needs design. |
| 5 | 🔍 MEDIUM | Capture fuzzy trigger detail in edit stats | When fuzzy auto-retry fires, capture what caused it so `get-edit-stats` shows reason tokens not just counts. |
| 6 | 🔤 LOW-MEDIUM | Case-insensitive fuzzy matching in str_replace | 5th auto-retry block after partialMatch. Assess false-positive risk first. |
| 7 | 🖼️ MEDIUM | Inline diff in chat panel | See design below. |
| 8 | 🚫 MEDIUM | Pulsar ignore / `.mcp-ignore` | See design below. |
| 9 | 🔧 LOW | Named capture groups `$<name>` in `applyReplacement` | Low priority quality-of-life. |
| 10 | 🧪 MEDIUM | Automated testing + script runner (Tier 1/2/3) | See design below. |
| 11 | 💾 LOW | Disk-backed checkpoints | See design below. |
| 12 | 🔀 LOW | Git integration tool | See design below. |
| 13 | ✅ DONE | Document string anchors for unstructured files | Added to insert desc in tool-catalogue.js. | `afterHint:"## Installation"` for markdown/config. One-line addition to TOOL_CATALOGUE. |
| 14 | ✅ DONE | str_replace noMatch closest-region hint | Was partially implemented but broken — similarity block was nested inside `fuzzyRow >= 0` guard so never ran for single-line failures or when no fuzzy row found. Fixed: similarity now always runs using fuzzyRow if found else diagOffset. Removed `lines.length >= 2` restriction. |
| 15 | ✅ DONE | Failure log query tool | New `get-failure-log` tool added to mcp-registration.js. Args: tail, tool, reason, filePath filters. Returns structured JSON. | — either a new `get-failure-log` tool or extend `get-debug-log` with `source:'failures'` param. Args: `tail:N` (default 20), `tool`/`reason`/`filePath` filters. Returns parsed NDJSON as structured JSON — no PowerShell needed. |
| 16 | 🖼️ MEDIUM | Chat panel — toggle run-command/diff output | Toggle button to show/hide run-command stdout and diff output inline in chat. Currently output is either always shown or swallowed. |
| 17 | 🖼️ MEDIUM | Chat panel — bypass destructive edit confirmation | Button or toggle to allow destructive edits (yes/no prompt) without manual confirmation. Useful for trusted batch sessions. |
| 18 | 🖼️ LOW-MEDIUM | Chat panel — show LLM tool-support indicator | Display whether the currently selected model supports tool use. May be inferrable from model name/capabilities endpoint — needs investigation. |
| 19 | 🖼️ MEDIUM | Chat panel — cancel button | Cancel in-flight LLM request. Needs AbortController wired into the fetch/SDK call in chat-functions.js and a cancel button in chat-panel.js. |
| 20 | 🖼️ MEDIUM | Fault log viewer in Pulsar menu | Menu item (Packages → MCP Server → View Fault Log) opening a pane that reads and displays failure-log.ndjson with basic filtering — tool, reason, date. Complements item 15. |
| 21 | 📝 MEDIUM | Session notes editor in chat panel or menu | UI to read/edit/append session notes without needing the LLM. Simple textarea pane, save button. Could live in the chat panel as a tab or as a Pulsar pane. |
| 22 | 🔧 MEDIUM | Split tools into named groups in enable-group UI | Tools currently split into TOGGLEABLE_GROUPS but UI just shows group names. Surfacing edit/search/ghidra/file/diag/nav as labelled sections in the panel would make selectively enabling/disabling groups much clearer. |
| 23 | 🔧 LOW-MEDIUM | Better diff tool | Current diff output is plain unified diff. Consider side-by-side, syntax-highlighted, or collapsible hunks — either inline in chat panel (item 16) or as a dedicated Pulsar pane. |
| 24 | 🖼️ MEDIUM | Chat panel — OpenAI-compatible server list | UI to add/remove/select LLM servers. Remember API key and model selection per server between sessions. Switch active server without restarting Pulsar. |
| 25 | 🔧 MEDIUM | Auto-save on edit commit | Automatically save after every successful tool commit (str_replace, insert, delete-line-range etc). Removes need for explicit save-all calls. Opt-out toggle in settings. |
| | 26 | ✅ DONE | run-command: checkpoint + save-before + reload-after | Pre-flight: checkpoints all open editors to `_run-command-<ts>:<path>`, saves all modified buffers to disk. Post-execution: mtime snapshot detects changed files, reloads them into buffers via setTextViaDiff. LLM gets preFlightCheckpoint, savedBeforeRun, reloadedAfterRun in result. | 27 | 🔧 LOW | Auto-close files on task end | Close editor tabs opened by MCP tools during a session when task ends (e.g. get-edit-stats reset:true). Preserve files that were already open before the session. |

---

### 🏗️ LARGE — Tool Framework (`lib/tool-framework.js`)

**Status:** Design complete. Not yet started.

**Problem:** Every tool hand-rolls the same scaffold: `editStats`/`lifetimeStats` init, `bump()`, `counter.count++/=0`, `smartSuggestion()`, `buildEditResponse()`, `dryRuns` bump. Cross-cutting changes touch every handler.

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
  handler: async (args, ctx) => {
    // ctx: editor, buffer, allLines, text, allSymbols
    // ctx.fail(reason, msg), ctx.commit(meta), ctx.dryRunReturn(p)
  }
});
```

**Migration phases:**

| Phase | Scope | Risk | Notes |
|---|---|---|---|
| 0 | Make `summarise()` + `buildReport()` data-driven | Low | `Object.keys(editStats)` replaces hand-enumeration. No handler changes. |
| 1 | Write `lib/tool-framework.js` + `registerMcpTool()`. Migrate `replace-all` + `replace-document` as PoC. | Low-Med | Verify stats identical before/after. |
| 2 | Migrate 8 main edit tools. | Med | One tool at a time. Pre-reboot checklist after each. |
| 3 | Migrate search/nav tools. Leave Ghidra as-is. | Low | Ghidra tools have minimal boilerplate. |
| 4 | Delete old manual stats declarations + failure counters. | Low | Final cleanup after all tools migrated. |

**Escape hatches:** `apply-patch` needs `raw:true` override on `ctx.commit()`. `namingcheck`/`check-function-docs`/`insert-function-doc` use local `curStats` — keep as-is.

---

### 🚫 MEDIUM — Pulsar ignore / `.mcp-ignore`

`replace-across-files`, `grep-project`, `get-project-files`, `get-repo-map` have no file exclusion beyond `.mcp-baseline/`. A `.mcp-ignore` file (gitignore syntax) at project root, loaded at server start. Default exclusions: `node_modules/**`, `.mcp-baseline/**`, `*.min.js`, `dist/**`, `build/**`. Single `shouldIgnore(filePath)` helper. ~50 lines.

---

### 🖼️ MEDIUM-HIGH — Visual diff decorations (Cursor-parity)

Green/red inline editor decorations. `dryRun:true` returns staged state. Use `editor.decorateMarker()`. Store staged state in module-level `stagedEdit` (like `patchRescueStore`). `commit-staged`/`discard-staged` or reuse `confirm:true` from apply-patch. Build on `highlight-range`.

---

### 🖼️ MEDIUM — Inline diff in chat panel

Collapsible `+N -N` block in chat after each edit. `diff` library already imported. `chat-functions.js` + `chat-panel.js` only. Requires Pulsar reload.

---

### 🧪 MEDIUM — Automated testing + script runner

**Tier 1** — Script runner: Node.js CLI posts steps from a `.json` script to `localhost:PORT`. ~80 lines. Asserts: `exitCode`, `messageCount`, `matched`, `contains`. Do this first.

**Tier 2** — In-process harness: `callTool(name, args, mockEditor)` bypasses HTTP. Much easier after Tool Framework Phase 1. Lives in `spec/`.

**Tier 3** — Named procedures: variable substitution (`{{file}}`), `on_fail`, conditionals. Invokable via `@//` shortcuts. Build on Tier 1.

---

### 💾 LOW — Disk-backed checkpoints

`checkpoint-to-disk name` / `restore-from-disk name`. Snapshot = file path + text → `.mcp-checkpoints/<name>-<timestamp>.json`. ~40 lines. In-memory `checkpoint`/`restore-checkpoint` stay as fast fallbacks.

---

### 🔀 LOW — Git integration tool

`git-commit` tool: `message` param, `git add <files>` + `git commit -m`. Returns commit hash. Also `git-status` and `git-diff`. Thin wrappers around `run-command` internals.

---

### Post-edit structural integrity checks

**Tier 1** — `struct-check.js` already exists: brace/bracket/paren balance, unclosed block comment, `#if`/`#endif` balance. Currently wired to `str_replace` only as PoC. Wire to remaining 14 commit sites via Tool Framework `ctx.commit()` — do NOT wire manually before then.

**Tier 2** — Token-stream state machine: missing `break` in switch, keyword not followed by brace, unreachable code after `return`, duplicate `case` values. ~15 token types, no AST.

**Tier 3** — `verify-file` tool: full-buffer struct + linter + style + compiler diagnostics in one call. *"Call this before reporting a task complete."* Delta-only: warn only on new issues vs pre-edit snapshot.

---

### Session-notes policy schema (deferred)

Do not implement. Notes are read once at session start; no server-side selection layer exists. Schema adds overhead with no runtime benefit. Revisit only if notes exceed ~25 entries and LLM demonstrably misses older ones.

---

## Feature Gap Analysis (vs other tools — researched 2026-06-04)

| Feature | Cursor | Windsurf | Cline | Claude Code | Us | ★ |
|---|---|---|---|---|---|---|
| Plan mode | ✅ | ✅ | ✅ | ✅ | ❌ | |
| Per-step approval | ✅ | ✅ | ✅ | ✅ | ❌ | |
| Inline diff in editor | ✅ | ✅ | ❌ | ❌ | ❌ | |
| Inline diff in chat | ❌ | ❌ | ❌ | ✅ partial | ❌ | |
| Reusable workflows | ❌ | ✅ | ❌ | ❌ | ✅ `@//` | ★ |
| Context window indicator | ❌ | ❌ | ✅ | ✅ | ❌ | |
| Auto context compaction | ❌ | ❌ | ❌ | ✅ | ❌ | |
| Checkpoint / restore | ❌ | ❌ | ✅ shadow git | ❌ | ✅ buffer+disk | ★ |
| Kernel C style checking | ❌ | ❌ | ❌ | ❌ | ✅ | ★ |
| Naming + doc skeleton | ❌ | ❌ | ❌ | ❌ | ✅ | ★ |
| Ghidra RE integration | ❌ | ❌ | ❌ | ❌ | ✅ | ★ |
| Edit stats + smart suggestions | ❌ | ❌ | ❌ | ❌ | ✅ | ★ |
| Persistent cross-session LLM notes | ❌ | ❌ | ❌ | ❌ | ✅ | ★ |
| Aider-style repo map (tree-sitter) | ❌ | ❌ | ❌ | ❌ | ✅ | ★ |
| Multi-agent / parallel agents | ✅ | ✅ | ✅ | ✅ | ❌ | |
| Browser / web access during task | ❌ | ❌ | ✅ | ✅ | ❌ | |
| Spend / token limit guard | ❌ | ❌ | ✅ | ❌ | ❌ | |

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
- `rep- `replace-across-files` glob must always be `lib/*.js`, never `**/*.js` — hits `.mcp-baseline/`
- `replace-across-files` commit path: all writes now go through Pulsar buffer (closed files are opened with activateItem:false). Full undo history on all affected files.nctionHint` never on .md files — use lineNumberHint or afterHint instead
- `grep-file` before str_replace on any file to confirm exact anchor text and line numbers
- chat-panel.js, chat-functions.js and .less changes require Pulsar package reload — no hot-reload
