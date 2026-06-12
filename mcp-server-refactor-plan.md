# pulsar-edit-mcp-server — Work Tracking

> Last audited against live code: 2026-06-12 (v0.14.0 — Tool Framework migration complete)

## Files

- `lib/mcp-registration.js` — **~6672 lines.** Full Pulsar restart + babel cache clear required for registerTool/schema changes. Handler body changes hot-reload on save.
- `lib/edit-stats.js` — Stats counters, `bump()`, `summarise()`, `buildReport()`, `buildStyleReport()`, process exit hooks. Hot-reloads on save.
- `lib/tool-hints.js` — `anchorError()`, `smartSuggestion()`, `successNudge()`, `ambiguityCheck()`. Hot-reloads on save. *(Legacy consecutive failure counter objects removed — now owned by tool-framework.js)*
- `lib/tool-framework.js` — `makeRegisterMcpTool()` factory. `ctx`: editor, buffer, allLines, text, consec, fail(), commit(), dryRunReturn(), snapshotOriginal(). Hot-reloads on save.
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
- `lib/mcp-ignore.js` — `.mcp-ignore` glob rules, `shouldIgnore()`, `initMcpIgnore()`. Hot-reloads on save.
- `lib/pulsar-edit-mcp-server.js` — Main UI/activation file. Requires Pulsar reload for most changes.
- `lib/chat-panel.js` — Chat panel UI. Requires Pulsar reload (no hot-reload).
- `lib/chat-functions.js` — Chat LLM dispatch + tool call handling. Requires Pulsar reload.
- `styles/pulsar-edit-mcp-server.less` — Stylesheet. Hot-reloads on save.

---

## TODO — Priority Order

| # | Priority | Item | Notes |
|---|---|---|---|
| 1 | 🏗️ LOW-MED | Deferred tool migrations — `run-command`, `replace-across-files`, `get-repo-map`, Ghidra ×6 | See deferred tool plan below. Each needs a dedicated session. |
| 2 | 🖼️ HIGH | Session edit highlights | Persistent per-session gutter highlights showing what changed. Toggle in chat bar. Active-edit colour while in progress. Survives buffer reloads. See design below. |
| 3 | 📊 MEDIUM | Show diff faults in stats window | Surface diff-fault breakdown in `get-edit-stats` per-rule as mini table. |
| 4 | 🔍 MEDIUM | Capture fuzzy trigger detail in edit stats | When fuzzy auto-retry fires, capture reason tokens for `get-edit-stats`. Feeds into item #5a. |
| 5 | 🔤 LOW-MEDIUM | Case-insensitive fuzzy matching in str_replace | 5th auto-retry block after partialMatch. Assess false-positive risk first. |
| 5a | 🔍 MEDIUM | Hint performance tracking + fault classification | Per-hint success rate in `buildReport()`. Two fault buckets: content faults vs hint faults. `bump()` gets optional `hintContext` param. |
| 6a | 🔍 MEDIUM | str_replace noMatch mismatch diagnosis + auto-fix | On noMatch: `_profileScan(lines)`, `_diagnoseMismatch(oldStrLines, bufferLines)`. Auto-apply transforms, retry, tag response. |
| 7 | 🖼️ MEDIUM | Inline diff in chat panel | Collapsible +N/-N block after each edit. `diff` lib already imported. Requires Pulsar reload. |
| 8 | 🧪 MEDIUM | Automated testing + script runner (Tier 1/2/3) | See design below. |
| 9 | 🔧 LOW | Named capture groups `$<name>` in `applyReplacement` | Low priority quality-of-life. |
| 10 | 💾 LOW | Disk-backed checkpoints | See design below. |
| 11 | 🔀 MEDIUM | Git integration — run-command auto-stage + finish-session commit | `run-command` runs `git add -A` after execution so git gutter tracks all file changes. `finish session` optionally commits with `mcp: session end` message. See design below. |
| 12 | 🖼️ MEDIUM | Chat panel — toggle run-command/diff output | Toggle button to show/hide run-command stdout and diff output inline in chat. |
| 13 | 🖼️ MEDIUM | Chat panel — bypass destructive edit confirmation | Button/toggle to allow destructive edits without manual confirmation. |
| 14 | 🖼️ LOW-MEDIUM | Chat panel — show LLM tool-support indicator | Display whether selected model supports tool use. |
| 15 | 🖼️ MEDIUM | Chat panel — cancel button | AbortController in chat-functions.js + cancel button in chat-panel.js. |
| 16 | 📝 MEDIUM | Session notes editor in chat panel or menu | UI to read/edit/append session notes without the LLM. |
| 17 | 🔧 MEDIUM | Split tools into named groups in enable-group UI | Surface edit/search/ghidra/file/diag/nav as labelled sections in the panel. |
| 18 | 🔧 LOW-MEDIUM | Better diff tool | Side-by-side, syntax-highlighted, or collapsible hunks in chat panel or dedicated Pulsar pane. |
| 19 | 🖼️ MEDIUM | Chat panel — OpenAI-compatible server list | Add/remove/select LLM servers, remember API key and model per server. |
| 20 | 🔧 MEDIUM | Auto-save on edit commit | Auto-save after every successful commit. Opt-out toggle. Defer to `ctx.commit()`. |
| 21 | 🔧 LOW | Auto-close files on task end | Close MCP-opened tabs on task end, preserve pre-session files. |
| 22 | 📊 LOW | Per-session stats history | Append session tally to `session-history.ndjson` on `finish session`. See design below. |

---

### ✅ Tool Framework — Migration Complete (v0.14.0)

**Framework file:** `lib/tool-framework.js` — `makeRegisterMcpTool()` factory

All non-deferred tools now on `registerMcpTool()`. Migration ran across sessions 38–56 (Phases 0–4g). The old `{ const curTool; server.registerTool(...) }` scope-block pattern is eliminated everywhere except the deferred tools below.

**Migration pattern (for reference):**

```js
registerMcpTool({
  name: 'tool-name',
  group: 'groupName',
  category: 'nav',          // 'edit' | 'search' | 'nav' | 'command'
  requiresEditor: false,    // true if handler needs editor/buffer
  title: '...',
  description: '...',
  inputSchema: { ... },
  handler: async (args, ctx) => {
    // ctx.editor, ctx.buffer, ctx.allLines, ctx.text (if requiresEditor)
    // ctx.fail(reason, msg) — bumps fault counter, returns MCP error content
    // ctx.commit(meta)      — bumps hit counter, builds edit response
    // bump(statsKey, 'hits') for search/command tools (no ctx.commit)
  }
});
```

---

### 🏗️ Deferred Tool Migrations

These were intentionally skipped during the main migration due to complexity or low priority. Each should be done in a dedicated session.

| Tool | Reason deferred | Risk | Notes |
|---|---|---|---|
| `run-command` | Pre-flight checkpoint logic, `confirm` flow, shell/process management | Med-High | The pre-flight `_run-command-*` checkpoint store + `confirm:true` guard lives outside the old `{ const curTool }` block — needs careful extraction. The shell/process spawn logic is self-contained inside the handler. |
| `replace-across-files` | Confirm-store pattern (`patchRescueStore`-style), complex glob + file iteration | Med | Uses a module-level store for multi-file confirm flow. Need to confirm the store is accessible from inside a framework handler before migrating. |
| `get-repo-map` | Large complex handler, tree-sitter + PageRank logic | Low-Med | Handler is self-contained — no tricky scope dependencies. Low risk if done carefully. Lowest priority of the three JS tools. |
| Ghidra ×6 (`list-functions`, `search-functions`, `get-function-body`, `get-xrefs`, `add-comment`, `get-function-list-with-comments`) | Minimal boilerplate, no stats, low usage — benefit of migration is small | Low | All six share the same simple `curStats = editStats[curTool] || ...` inline-init pattern (same as namingcheck/check-function-docs). Straightforward when/if desired. Do all six in one session. |

**Suggested order:** Ghidra ×6 (easiest, one session) → `get-repo-map` → `replace-across-files` → `run-command` (hardest last).

---

### Post-edit structural integrity checks

**Tier 1** — `struct-check.js` already exists: brace/bracket/paren balance, unclosed block comment, `#if`/`#endif` balance. Currently wired to `str_replace` only as PoC. Wire to remaining commit sites via Tool Framework `ctx.commit()` — do NOT wire manually before then.

**Tier 2** — Token-stream state machine: missing `break` in switch, keyword not followed by brace, unreachable code after `return`, duplicate `case` values. ~15 token types, no AST.

**Tier 3** — `verify-file` tool: full-buffer struct + linter + style + compiler diagnostics in one call. Delta-only: warn only on new issues vs pre-edit snapshot.

---

### 🖼️ HIGH — Session edit highlights

Persistent per-session gutter decorations showing everything the LLM changed, surviving buffer reloads. Goal: full edit visibility without per-edit confirmation.

**Colours (3 states):**
- `mcp-session-added` — soft green, permanent, marks added/changed lines this session
- `mcp-session-removed` — soft red, permanent, marks removed-line positions this session
- `mcp-session-editing` — amber/yellow, transient, shown on target region *while* an edit is in progress, replaced by added/removed on commit

**Persistence across buffer reloads (run-command close/reopen):**
- Module-level `sessionHighlightRanges` Map — `filePath → [{ fromRow, toRow, kind }, ...]`
- `decorateEditedLines()` with `permanent:true` writes to this store as well as painting markers
- `atom.workspace.onDidAddTextEditor()` hook — on file open, repaint any stored ranges for that path
- Markers use `{ invalidate: 'never' }` (already the case)

**Toggle button in chat bar (`chat-panel.js`):**
- Button in `topDisplay` next to Clear — `◉ Highlights` / `○ Highlights`
- Reads/writes `atom.config.get/set('pulsar-edit-mcp-server.sessionHighlights')`
- Green (`btn-success`) when on, grey when off
- `decorateEditedLines()` skips permanent paint when config is false

**Clear on finish session:**
- `get-edit-stats reset:true` drains `activeHighlightSets` and clears `sessionHighlightRanges`

**CSS additions (`pulsar-edit-mcp-server.js` styleSheet):**
- `mcp-session-added-gutter`: `rgba(80, 200, 120, 0.15)` — subtle green
- `mcp-session-removed-gutter`: `rgba(240, 80, 80, 0.15)` — subtle red  
- `mcp-session-editing-gutter`: `rgba(220, 180, 50, 0.35)` — amber, more visible

**package.json config key:** `sessionHighlights` boolean, default `true`

### 🖼️ MEDIUM — Inline diff in chat panel

Collapsible `+N -N` block in chat after each edit. `diff` library already imported. `chat-functions.js` + `chat-panel.js` only. Requires Pulsar reload.

---

### 💾 LOW — Disk-backed checkpoints

`checkpoint-to-disk name` / `restore-from-disk name`. Snapshot = file path + text → `.mcp-checkpoints/<name>-<timestamp>.json`. ~40 lines. In-memory `checkpoint`/`restore-checkpoint` stay as fast fallbacks.

---

### 🔀 MEDIUM — Git integration — run-command auto-stage + finish-session commit

**Problem:** `run-command` writes files outside the MCP edit path so session highlights and buffer state tracking can't see those changes. Git gutter already shows removed lines vs HEAD — so if git staging is kept current, the gutter covers what session highlights can't.

**run-command auto-stage:**
- After every `run-command` execution (exit 0 or non-zero), run `git add -A` in the working directory
- Git gutter immediately lights up showing all changes vs HEAD — added, modified, and **deleted** lines
- No commit made — git log stays clean during the session
- Degrade gracefully if no git repo (check for `.git` dir or catch `git add` failure silently)
- Only stage if cwd is inside a git repo — use `git rev-parse --is-inside-work-tree` as a pre-check

**finish-session commit (optional):**
- `get-edit-stats reset:true` ("finish session") optionally runs `git add -A` + `git commit -m "mcp: session [N] end [timestamp]"`
- Commit only if there are staged/unstaged changes — skip if working tree clean
- Gives one clean commit per LLM session, easy to review or `git reset --hard HEAD~1`
- Could be a config toggle: `autoCommitOnFinish` (default false — opt-in)

**Removed lines coverage:**
- With auto-stage after every run-command, git gutter shows deleted content in its native popover
- Combined with session highlights (added/changed lines) = full coverage of everything that changed

---

### 🧪 MEDIUM — Automated testing + script runner

**Tier 1** — Script runner: Node.js CLI posts steps from a `.json` script to `localhost:PORT`. ~80 lines. Asserts: `exitCode`, `messageCount`, `matched`, `contains`. Do this first.

**Tier 2** — In-process harness: `callTool(name, args, mockEditor)` bypasses HTTP. Much easier after Tool Framework Phase 1. Lives in `spec/`.

**Tier 3** — Named procedures: variable substitution (`{{file}}`), `on_fail`, conditionals. Invokable via `@//` shortcuts. Build on Tier 1.

---

### Session-notes policy schema (deferred)

Do not implement. Notes are read once at session start; no server-side selection layer exists. Revisit only if notes exceed ~25 entries and LLM demonstrably misses older ones.

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
- `replace-across-files` glob must always be `lib/*.js`, never `**/*.js` — hits `.mcp-baseline/`
- `functionHint` never on .md files — use lineNumberHint or afterHint instead
- `grep-file` before str_replace on any file to confirm exact anchor text and line numbers
- chat-panel.js, chat-functions.js and .less changes require Pulsar package reload — no hot-reload
- **Global substitution on mcp-registration.js:** `replace-all` and `sed` time out on this file (6672 lines + template literals). Use PowerShell instead: `(Get-Content file -Raw) -replace 'pattern','replacement' | Set-Content file -NoNewline` then run-command auto-reloads the buffer. Watch for whitespace variants in patterns — test with `Select-String` first.

### 📊 LOW — Per-session stats history

Append a one-line JSON record to `session-history.ndjson` on every `get-edit-stats reset:true` ("finish session"), so per-session tallies are never lost.

**Record format:**
```json
{"ts":"2026-06-12T09:00Z","session":56,"edits":8,"hits":8,"faults":0,"hitRate":1.00,"searchHits":12,"searchMisses":0,"topTools":["str_replace"]}
```

**Implementation (`edit-stats.js`):**
- `flushLifetimeStats()` already called on reset — append the record there
- File: `session-history.ndjson` alongside `edit-stats.json` (same dir)
- Append-only — never rewrite, never truncate
- `sessionCount` from lifetime stats gives the session number

**`get-edit-stats` summary addition:**
- Show last 5 sessions as a compact table at the bottom of the report:
  ```
  Recent sessions:  #54 10/10 100%  #55 7/7 100%  #56 8/8 100%
  ```
- Makes hit-rate trends visible without opening the file manually

**Low effort:** ~20 lines in `edit-stats.js`, no new tool needed.
