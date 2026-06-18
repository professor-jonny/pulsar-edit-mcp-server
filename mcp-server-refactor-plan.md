# pulsar-edit-mcp-server — Work Tracking

> Last audited against live code: 2026-06-18 (v0.15.2 — B22 str_replace failure diagnostics partial)

## Files

- `lib/mcp-registration.js` — **~6520 lines.** Full Pulsar restart + babel cache clear required for registerTool/schema changes. Handler body changes hot-reload on save.
- `lib/edit-stats.js` — Stats counters, `bump()`, `summarise()`, `buildReport()`, `buildStyleReport()`, process exit hooks. Hot-reloads on save.
- `lib/tool-hints.js` — `anchorError()`, `smartSuggestion()`, `successNudge()`, `ambiguityCheck()`. Hot-reloads on save.
- `lib/tool-framework.js` — `makeRegisterMcpTool()` factory. `ctx`: editor, buffer, allLines, text, consec, fail(), commit(), dryRunReturn(), snapshotOriginal(). Hot-reloads on save.
- `lib/buffer-helpers.js` — `walkDir()`, `resolveStructuralAnchor()`, `findAnchor()`, `findFunctionInBuffer()`, `readTextFromFile()`, `readFileOrBuffer()`, `retargetEditor()`. Hot-reloads on save.
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
| 2 | 🖼️ HIGH | Session edit highlights | Persistent per-session gutter highlights showing what changed. Toggle in chat bar. Active-edit colour while in progress. Survives buffer reloads. See design below. |
| 3 | 📊 MEDIUM | Show diff faults in stats window | Surface diff-fault breakdown in `get-edit-stats` per-rule as mini table. |
| 5 | 🔤 LOW-MEDIUM | Case-insensitive fuzzy matching in str_replace | 5th auto-retry block after partialMatch. Assess false-positive risk first. |
 hint faults. `hintsSucceeded`/`hintsFailed` parallel to `hintsUsed` on str_replace. |

| 7 | 🖼️ MEDIUM | Inline diff in chat panel | Collapsible +N/-N block after each edit. `diff` lib already imported. Requires Pulsar reload. |
| 8 | 🧪 MEDIUM | Automated testing + script runner (Tier 1/2/3) | See design below. |
| 10 | 💾 LOW | Disk-backed checkpoints | See design below. **Semi-redundant once #11 lands** — git checkout provides file recovery for closed files; in-memory checkpoints remain as fast undo fallback. Lower priority accordingly. |

| 11 | 🔀 HIGH | Git integration — run-command auto-stage + finish-session commit | `run-command` runs `git add -A` after execution so git gutter tracks all file changes. `finish session` optionally commits with `mcp: session end` message. **Also solves backup/recovery** — staging before execution means any file the command touches (including closed files not open in a tab) is recoverable via `git checkout`. This is the correct fix for the problem that #3 (staleness warning) was trying to solve — #3 is dropped. See design below. |

| 12 | 🖼️ MEDIUM | Chat panel — toggle run-command/diff output | Toggle button to show/hide run-command stdout and diff output inline in chat. |
| 13 | 🖼️ MEDIUM | Chat panel — bypass destructive edit confirmation | Button/toggle to allow destructive edits without manual confirmation. |
| 14 | 🖼️ LOW-MEDIUM | Chat panel — show LLM tool-support indicator | Display whether selected model supports tool use. |
| 15 | 🖼️ MEDIUM | Chat panel — cancel button | AbortController in chat-functions.js + cancel button in chat-panel.js. |
| 17 | 🔧 MEDIUM | Split tools into named groups in enable-group UI | Surface edit/search/ghidra/file/diag/nav as labelled sections in the panel. |
| 18 | 🔧 LOW-MEDIUM | Better diff tool | Side-by-side, syntax-highlighted, or collapsible hunks in chat panel or dedicated Pulsar pane. |
| 19 | 🖼️ MEDIUM | Chat panel — OpenAI-compatible server list | Add/remove/select LLM servers, remember API key and model per server. |
| 21 | 🔧 LOW | Auto-close files on task end | Close MCP-opened files that were not open before the session started. |
| B12 | 🐛 LOW | pulsar-edit-mcp-server.js — require('atom') crashes outside Pulsar | Both `pulsar-edit-mcp-server.js` (L10) and `mcp-registration.js` (L7) do a bare `require('atom')`. Running `node --check` or unit tests outside Pulsar throws `Cannot find module 'atom'`. Low urgency (this is a Pulsar package), but blocks static analysis and CI. Fix: wrap in try/catch and fall back to a minimal stub for the symbols actually used. Not worth doing until a test harness exists (#8). |

| B20 | 🐛 MEDIUM | mcp-registration.js — `afterLine` content miss logged as generic `noMatch`, root cause invisible | `afterLine:N` always succeeds (resolveLinePosition never fails — just clamps to bounds). When `old_str` isn't found inside the resulting 25-line window, it's logged as a plain `noMatch` or `afterNotFound` with no indication that `afterLine` was the hint or that the content drifted. This masks the dominant fault cause in lifetime stats (32 of 52 str_replace faults). Three fixes needed: **(1) Fault log disambiguation** — in the `noMatch` path, if `afterLine` was in the hint set, log reason as `hintFault:afterLine:contentMiss` instead of `noMatch`, with the window range in `hintValue`. **(2) scanForOldStr wiring for afterLine/afterString** — `scanForOldStr` is only called when `_hasScope` is true AND `_scopeBounds` resolves (currently only handles `inFunction` + `betweenHint`). The `_scopeBounds` fallback returns `{-1,-1}` for `afterLine`/`afterString`, so outside-scope detection never fires for them. Fix: populate `_scopeBounds` from `searchStart`/`searchEnd` for all hint types, not just inFunction/betweenHint. Then if `old_str` exists outside the window the fault message says "FOUND OUTSIDE SCOPE — exists at L347, window was L200–L225 — content drifted, use afterString instead". **(3) successNudge** — when `afterLine` is the sole hint and `noMatch` fires, suggest the content of the anchor line as `afterString` so the next attempt is drift-immune. `mcp-registration.js` noMatch path + `_scopeBounds` block. Hot-reloads. |

| B21 | 🐛 MEDIUM | mcp-registration.js — `insert_line` has same drift problem as `afterLine`, no warning | `insert_line` is a raw 1-based line number — identical drift risk to `afterLine` in str_replace. After any prior insert/delete above the target, `insert_line:N` silently inserts at the wrong place. Unlike str_replace there is no content match to catch the miss — it just inserts wherever the number points with no error. Three fixes mirroring B20: **(1)** Add a drift warning to the `insert_line` success path — append to the commit response: `"⚠️ insert_line is positional — if any edits above this point added or removed lines, the position may have drifted. Prefer afterString/beforeString for drift-immune inserts."` **(2)** Strengthen the tool description to demote `insert_line` to last resort — currently listed as option (5) but should say "only use if the number came from grep-file/read-lines and no edits have run since". **(3)** Consider deprecating `insert_line` entirely in favour of always requiring a content-stable hint, with `endOfFile:true` as the explicit escape hatch for append-to-end. `mcp-registration.js` insert handler + description. Hot-reloads. |

| B22 | 🔄 PARTIAL (str_replace done v0.15.2) | tool-framework.js — universal positional hint self-correction on success and failure | Positional hints (`afterLine`, `beforeLine`, `insert_line`) succeed silently even when pointing at stale positions. Add framework-level self-correction using a new `positionalHints: ['afterLine', 'beforeLine']` array in the tool `cfg`. Handlers pass `activeHint: 'afterLine'` to `ctx.commit()` / `ctx.fail()` so the framework knows which hint was actually active (not just present in args — multiple hints can be in args but only one fires). **On `ctx.commit()` with active positional hint** — append to response: current content at the anchor line so the LLM can immediately construct a drift-immune `afterString` for the next edit without a read. E.g. `\"⚠️ afterLine:250 is positional — lines below have shifted. Content at L250: '  const result = await readTextFromFile(filePath);' — next edit use afterString:'const result = await readTextFromFile' instead.\"` **On `ctx.fail()` with active positional hint + content miss (noMatch/contentMiss, NOT hint resolution failures like notFound/ambiguous)** — three cases, all computable from `allLines` + `scanForOldStr` results already available: **(1) Single match outside window** — most common drift case: show hit line + function context + drift distance (`\"drifted by +58 lines\"`) + suggested `afterString` from first line of `old_str`. LLM retries immediately. **(2) Multiple matches outside window** — show all hit locations (line + function context) so LLM can pick the right one. Each match on its own line. LLM decides which is the intended target without extra reads. **(3) No matches anywhere** — show 3-5 lines of current content around the anchor point so LLM can see what's there now and determine if the edit already applied or `old_str` is genuinely wrong. All three cases require no extra tool calls from the LLM — everything is derived from data already in the noMatch handler. **str_replace DONE (v0.15.2)**: scanForOldStr always runs on failure; hitsInsideScope reported; total===0 check fixed; all messages name active hint; no-scope path added; drift nudge fires on all failure types. **Still to do**: insert tool + replace-block + replace-function-body + delete-* same improvements; B21 insert_line drift warning. `tool-framework.js` (ctx.commit + ctx.fail signatures) + `mcp-registration.js` (str_replace + insert handlers pass activeHint). Hot-reloads. | Positional hints (`afterLine`, `beforeLine`, `insert_line`) succeed silently even when pointing at stale positions. Add framework-level self-correction using a new `positionalHints: ['afterLine', 'beforeLine']` array in the tool `cfg`. Handlers pass `activeHint: 'afterLine'` to `ctx.commit()` / `ctx.fail()` so the framework knows which hint was actually active (not just present in args — multiple hints can be in args but only one fires). **On `ctx.commit()` with active positional hint** — append to response: current content at the anchor line so the LLM can immediately construct a drift-immune `afterString` for the next edit without a read. E.g. `"⚠️ afterLine:250 is positional — lines below have shifted. Content at L250: '  const result = await readTextFromFile(filePath);' — next edit use afterString:'const result = await readTextFromFile' instead."` **On `ctx.fail()` with active positional hint + content miss (noMatch/contentMiss, NOT hint resolution failures like notFound/ambiguous)** — three cases, all computable from `allLines` + `scanForOldStr` results already available: **(1) Single match outside window** — most common drift case: show hit line + function context + drift distance (`"drifted by +58 lines"`) + suggested `afterString` from first line of `old_str`. LLM retries immediately. **(2) Multiple matches outside window** — show all hit locations (line + function context) so LLM can pick the right one. Each match on its own line. LLM decides which is the intended target without extra reads. **(3) No matches anywhere** — show 3-5 lines of current content around the anchor point so LLM can see what's there now and determine if the edit already applied or `old_str` is genuinely wrong. All three cases require no extra tool calls from the LLM — everything is derived from data already in the noMatch handler. `tool-framework.js` (ctx.commit + ctx.fail signatures) + `mcp-registration.js` (str_replace + insert handlers pass activeHint). Hot-reloads. |

| 29 | 🖼️ MEDIUM | Chat panel — persist conversation history across restarts | Chat history (`llmContextHistory`) is lost on panel close, Pulsar restart, or package reload. Write the array to a JSON file on every message (debounced ~1s), reload it in the panel constructor. Include a "Clear history" button. Lets the user resume a session without re-establishing context. `chat-functions.js` (history array) + `chat-panel.js` (load on init, clear button). Requires Pulsar reload. |

| 30 | 🖼️ MEDIUM | Menu option — View Session Notes | Add a "View Session Notes" command to the Packages → MCP Server menu (and context menu). Opens the session-notes NDJSON file in a Pulsar tab so notes can be read and hand-edited. Implementation: `pulsar-edit-mcp-server.js` new command + method calling `atom.workspace.open(SESSION_NOTES_PATH, { activateItem: true })`. `SESSION_NOTES_PATH` imported from `edit-stats.js`. Menu entries in `menus/pulsar-edit-mcp-server.json`. Hot-reloads. |

---

### Post-edit structural integrity checks

**Tier 1** — `struct-check.js` already exists: brace/bracket/paren balance, unclosed block comment, `#if`/`#endif` balance. Currently wired to `str_replace` only as PoC. Wire to remaining commit sites via Tool Framework `ctx.commit()`.

**Tier 2** — Token-stream state machine: missing `break` in switch, keyword not followed by brace, unreachable code after `return`, duplicate `case` values. ~15 token types, no AST.

**Tier 3** — `verify-file` tool: full-buffer struct + linter + style + compiler diagnostics in one call. Delta-only: warn only on new issues vs pre-edit snapshot.

---

### 🖼️ HIGH — Session edit highlights

Persistent per-session gutter decorations showing everything the LLM changed, surviving buffer reloads.

**Colours (3 states):**
- `mcp-session-added` — soft green, permanent, marks added/changed lines this session
- `mcp-session-removed` — soft red, permanent, marks removed-line positions this session
- `mcp-session-editing` — amber/yellow, transient, shown on target region while an edit is in progress

**Persistence across buffer reloads:**
- Module-level `sessionHighlightRanges` Map — `filePath → [{ fromRow, toRow, kind }, ...]`
- `decorateEditedLines()` with `permanent:true` writes to this store as well as painting markers
- `atom.workspace.onDidAddTextEditor()` hook — on file open, repaint any stored ranges for that path

**Toggle button in chat bar (`chat-panel.js`):**
- Button next to Clear — reads/writes `atom.config.get/set('pulsar-edit-mcp-server.sessionHighlights')`

**CSS:** `mcp-session-added-gutter` rgba(80,200,120,0.15) green, `mcp-session-removed-gutter` rgba(240,80,80,0.15) red, `mcp-session-editing-gutter` rgba(220,180,50,0.35) amber.
**this will likely be redundant by git integration**

---

### 🖼️ MEDIUM — Inline diff in chat panel

Collapsible `+N -N` block in chat after each edit. `diff` library already imported. `chat-functions.js` + `chat-panel.js` only. Requires Pulsar reload.
**this will likely be redundant by git integration**

---

### 💾 LOW — Disk-backed checkpoints

`checkpoint-to-disk name` / `restore-from-disk name`. Snapshot = file path + text → `.mcp-checkpoints/<name>-<timestamp>.json`. ~40 lines. In-memory checkpoints stay as fast fallbacks.
**this will likely be redundant by git integration**

---

### 🔀 HIGH — Git integration

**run-command auto-stage:** After every `run-command`, run `git add -A`. Git gutter lights up vs HEAD. No commit. Degrade gracefully if no git repo.

**Pre-execution stage (backup/recovery):** Before running the command, run `git add -A` so that the pre-command state is staged. Any file the command modifies (including files not open in Pulsar tabs) is then recoverable via `git checkout -- <file>` or `git stash`. This supersedes the stale-file-context (#3) approach — that approach was unworkable because `run-command` can write to files the editor has never seen.

**finish-session commit (optional):** `get-edit-stats reset:true` optionally runs `git add -A` + `git commit -m "mcp: session [N] end [timestamp]"`. Config toggle: `autoCommitOnFinish` (default false).

---

### 🧪 MEDIUM — Automated testing + script runner

**Tier 1** — Script runner: Node.js CLI posts steps from a `.json` script to `localhost:PORT`. Asserts: `exitCode`, `messageCount`, `matched`, `contains`.

**Tier 2** — In-process harness: `callTool(name, args, mockEditor)` bypasses HTTP. Lives in `spec/`.

**Tier 3** — Named procedures: variable substitution (`{{file}}`), `on_fail`, conditionals. Invokable via `@//` shortcuts.

---

## Feature Gap Analysis (vs other tools — researched 2026-06-04)

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
- `replace-block` for `{}` brace blocks ONLY — never `[]` array literals
- `save-all` after every edit — never batch edits without saving between them
- Saving mcp-registration.js triggers hot-reload — checkpoints wiped, MCP server cache reset
- `inFunction` never on .md files — use `afterLine` or `afterString` instead
- `replace-across-files` glob must always be `lib/*.js`, never `**/*.js` — hits node_modules
- `grep-file` before str_replace on any file to confirm exact anchor text and line numbers
- chat-panel.js, chat-functions.js and .less changes require Pulsar package reload — no hot-reload
- **Global substitution on mcp-registration.js:** `replace-all` and `sed` time out on this file. Use PowerShell: `(Get-Content file -Raw) -replace 'pattern','replacement' | Set-Content file -NoNewline` then run-command auto-reloads the buffer.
- **PowerShell null guard:** Always validate `$content` is non-null before `Set-Content`. A failed `-replace` or `Get-Content` on a locked file returns null; writing null produces a 3-byte file. Pattern: `if (-not $content) { Write-Error "Content is null, aborting"; exit 1 }` after every `Get-Content` and after every `-replace` chain.
- **tool-catalogue.js edits:** `str_replace` now works correctly (TDZ bug #26 fixed 2026-06-16). PowerShell `Set-Content` is still an option for large rewrites but prefer `str_replace` — always open the file first with `open-file`.
- **PowerShell writes to closed files are unrecoverable:** `run-command` pre-flight checkpoints all *open* editors. Files not open in a tab cannot be snapshotted. If PowerShell must write a file, open it in Pulsar first.
- **grep-project now works on mcp-registration.js** (v0.14.1 — readTextFromFile fix). No longer need open-file workaround.
