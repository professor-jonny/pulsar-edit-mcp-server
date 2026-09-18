# pulsar-edit-mcp-server — Work Tracking

> Last audited against live code: 2026-09-17. This file now tracks OPEN work only. Finished bugs/features (B18–B44, T1, T2, T3 (delete-line-range's narrow fix, and delete_block's off-findAnchor migration — findAnchor is now fully retired, see CHANGELOG), T5, FILE_SCHEMA migration, functionEnd removal, multi-line anchor support, list-open-files field removal, the full str_replace→insert Feature Parity Inventory, B24 items 7–8, the read-file pagination fix, etc.) have been moved to `CHANGELOG.md` — check there for history/rationale on anything not listed below.

## Files

- `lib/mcp-registration.js` — **~6850 lines.** Full Pulsar restart + babel cache clear required for registerTool/schema changes. Handler body changes hot-reload on save.
- `lib/edit-stats.js` — Stats counters, `bump()`, `summarise()`, `buildReport()`, `buildStyleReport()`, process exit hooks. Hot-reloads on save.
- `lib/tool-hints.js` — `anchorError()`, `smartSuggestion()`, `successNudge()`, `ambiguityCheck()`. Hot-reloads on save.
- `lib/tool-framework.js` — `makeRegisterMcpTool()` factory. `ctx`: editor, buffer, allLines, text, consec, fail(), commit(), dryRunReturn(), snapshotOriginal(). Hot-reloads on save.
- `lib/buffer-helpers.js` — `walkDir()`, `resolveStructuralAnchor()`, `findFunctionInBuffer()`, `readTextFromFile()`, `readFileOrBuffer()`, `retargetEditor()`, `checkStale()`, `recordKnownMtime()`. Hot-reloads on save. (`findAnchor()` retired 2026-09-17 — see CHANGELOG.)
- `lib/lint-helpers.js` — `maybeLintSuffix()`, `lintSnapshot()`. Hot-reloads on save. `lintSnapshot()` calls `linter-bundle`'s `GetLinterMessages` tool directly via its `filePath` filter (requires `linter-bundle` ≥ 2.6.0).
- `lib/match-engine.js` — B24 universal match engine. `resolveScope()`, `matchContent()`, `applyEdit()`, `buildMatchResponse()`, `buildFailResponse()`. Used by `insert`. Full babel-cache-clear + Pulsar restart required for any change, same discipline as mcp-registration.js.
- `lib/search-engine.js` — read-side counterpart to match-engine.js (added 2026-07-19). `compilePattern()`, `scanLines()`. Zero Atom dependencies, same discipline as recover.js. Wired into `find-text`, `grep-file`, `grep-project`, `search-symbol` — see CHANGELOG.md v0.18.0. Hot-reloads on save *by itself*, but that's not sufficient — the four call sites live in mcp-registration.js, so any change to those tools' handlers still needs the full babel-cache-clear + Pulsar restart. A shared engine file has no effect until something calls it; adding this file alone did not change any tool's behavior, only wiring each handler onto it did.
- `lib/tool-catalogue.js` — `TOOL_CATALOGUE` and `TOGGLEABLE_GROUPS` static data. Hot-reloads on save.
- `lib/schema.js` — `ANCHOR_SCHEMA`, `STRUCTURAL_ANCHOR_SCHEMA` Zod schemas. Hot-reloads on save.
- `lib/edit-response.js` — `buildEditResponse()`, `preEditSnapshot()`, `postEditDelta()`. Auto-calls `checkStale()`/`recordKnownMtime()` on every commit. Hot-reloads on save.
- `lib/read-response.js` — `buildSearchResponse()`. Read-side counterpart to edit-response.js. Deliberately minimal (no save, no icon, no line-delta). Hot-reloads on save.
- `lib/struct-check.js` — `snapshot()`, `delta()`, `isStructFileType()` for structural integrity checks. Hot-reloads on save.
- `lib/recover.js` — `profileNeedle()`/`profiledMatch()`/`partialMatchRescue()` — combined-transform diagnosis and full-buffer drift rescue. Zero Atom dependencies. Consumed by `match-engine.js`'s `matchContent()`. Hot-reloads on save.
- `lib/style-checker.js` — Kernel C style rules, `applyStyleCheck()`, `isKernelFile()`. Hot-reloads on save.
- `lib/naming-checker.js` — `checkNaming()`, `checkFunctionDocs()`, `buildDocSkeleton()`. Hot-reloads on save.
- `lib/tree-sitter-symbols.js` — Tree-sitter symbol extraction + anchor resolution. Hot-reloads on save.
- `lib/string-utils.js` — Pure utilities: `escapeRegex`, `applyReplacement`, `globToRegex`, `levenshteinDistance`, `calculateSimilarity`. Hot-reloads on save.
- `lib/mcp-ignore.js` — `.mcp-ignore` glob rules, `shouldIgnore()`, `initMcpIgnore()`. Hot-reloads on save.
- `lib/pulsar-edit-mcp-server.js` — Main UI/activation file. Requires Pulsar reload for most changes.
- `lib/chat-panel.js` — Chat panel UI. Requires Pulsar reload (no hot-reload).
- `lib/chat-functions.js` — Chat LLM dispatch + tool call handling. Requires Pulsar reload.
- `styles/pulsar-edit-mcp-server.less` — Stylesheet. Hot-reloads on save.

## TODO — Priority Order

| # | Priority | Item | Notes |
|---|---|---|---|
| 2 | 🖼️ HIGH | Session edit highlights | Persistent per-session gutter highlights showing what changed. Toggle in chat bar. Active-edit colour while in progress. Survives buffer reloads. See design below. |
| 3 | 📊 MEDIUM | Show diff faults in stats window | Surface diff-fault breakdown in `get-edit-stats` per-rule as mini table. |
| 5 | 🔤 LOW-MEDIUM | Case-insensitive fuzzy matching in str_replace | 5th auto-retry block after partialMatch. Assess false-positive risk first. |
| 7 | 🖼️ MEDIUM | Inline diff in chat panel | Collapsible +N/-N block after each edit. `diff` lib already imported. Requires Pulsar reload. |
| 8 | 🧪 MEDIUM | Automated testing + script runner (Tier 1/2/3) | See design below. |
| 10 | 💾 LOW | Disk-backed checkpoints | See design below. **Semi-redundant once #11 lands** — git checkout provides file recovery for closed files; in-memory checkpoints remain as fast undo fallback. Lower priority accordingly. |
| 11 | 🔀 HIGH | Git integration — run-command auto-stage + finish-session commit | `run-command` runs `git add -A` after execution so git gutter tracks all file changes. `finish session` optionally commits with `mcp: session end` message. **Also solves backup/recovery** — staging before execution means any file the command touches (including closed files not open in a tab) is recoverable via `git checkout`. See design below. |
| 12 | 🖼️ MEDIUM | Chat panel — toggle run-command/diff output | Toggle button to show/hide run-command stdout and diff output inline in chat. |
| 13 | 🖼️ MEDIUM | Chat panel — bypass destructive edit confirmation | Button/toggle to allow destructive edits without manual confirmation. |
| 14 | 🖼️ LOW-MEDIUM | Chat panel — show LLM tool-support indicator | Display whether selected model supports tool use. |
| 15 | 🖼️ MEDIUM | Chat panel — cancel button | AbortController in chat-functions.js + cancel button in chat-panel.js. |
| 17 | 🔧 MEDIUM | Split tools into named groups in enable-group UI | Surface edit/search/ghidra/file/diag/nav as labelled sections in the panel. |
| 18 | 🔧 LOW-MEDIUM | Better diff tool | Side-by-side, syntax-highlighted, or collapsible hunks in chat panel or dedicated Pulsar pane. |
| 19 | 🖼️ MEDIUM | Chat panel — OpenAI-compatible server list | Add/remove/select LLM servers, remember API key and model per server. |
| 21 | 🔧 LOW | Auto-close files on task end | Close MCP-opened files that were not open before the session started. |
| B12 | 🐛 LOW | pulsar-edit-mcp-server.js — require('atom') crashes outside Pulsar | Both `pulsar-edit-mcp-server.js` (L10) and `mcp-registration.js` (L7) do a bare `require('atom')`. Blocks static analysis/CI. Fix: wrap in try/catch, fall back to a minimal stub. Not worth doing until a test harness exists (#8). |
| B20 | 🐛 MEDIUM | mcp-registration.js — `afterLine` content miss logged as generic `noMatch`, root cause invisible | `afterLine:N` always succeeds (clamps to bounds). When `old_str` isn't found in the resulting window, it's logged as plain `noMatch` with no indication `afterLine` was the hint or that content drifted — masks the dominant fault cause (32/52 str_replace faults in lifetime stats). Fixes needed: (1) disambiguate fault log reason as `hintFault:afterLine:contentMiss`; (2) wire `scanForOldStr`/`_scopeBounds` for afterLine/afterString (currently only inFunction/betweenHint populate it); (3) successNudge should suggest the anchor line's content as `afterString`. Hot-reloads. |
| B22 | 🔄 PARTIAL (str_replace done v0.15.2; insert's afterLine path done v0.15.5) | tool-framework.js — universal positional hint self-correction on success and failure | Positional hints (`afterLine`, `beforeLine`, `onLine`) succeed silently even at stale positions. Needs framework-level `positionalHints` array + `activeHint` passed to `ctx.commit()`/`ctx.fail()`. **str_replace DONE.** **insert's afterLine path DONE** (v0.15.5 — deliberately targeted first since `insert` is low-traffic, safer to prove the pattern there before touching `delete-line-range`'s heavier one; `delete-line-range`'s own hand-rolled drift-nudge was separately fixed under B32, not via this framework gating). **Still to do:** `replace-block`, `replace-function-body`, `delete-block` need the same `features.successNudge`/`features.structCheck` treatment. |
| B59 | 🐛 LOW-MEDIUM, OPEN | `readTextFromFile` (buffer-helpers.js ~L264-281) — relative `filePath` args silently fail with "File not found" regardless of restarts | **Diagnosed, not fixed.** `read-file`/`grep-file` (and anything else routed through `readTextFromFile()`) call `fs.existsSync(filePath)` / `path.resolve(filePath)` directly on the caller-supplied path with no project-root fallback. A relative path (e.g. `test/foo.c`) resolves against the MCP server process's own `process.cwd()`, not the Pulsar project root — these are not guaranteed to be the same directory. When they differ, relative paths fail here permanently; restarting the server doesn't change how the host process's cwd was set at launch, so this is not a stale-state/reload issue. Confirmed the file genuinely exists via `get-project-files` glob and reads fine via `apply-patch`/absolute path — only the relative-path form fails, and only through this one helper. `apply-patch` and `get-project-files` are unaffected because they resolve paths via different, project-root-aware code (likely `atom.project`'s own APIs / `walkDir` over `atom.project.getPaths()`), never touching `process.cwd()`. **Proposed fix (not yet applied):** before the `existsSync` check, if `filePath` is not already absolute and doesn't exist as given, retry resolved against `atom.project.getPaths()[0]` (or each project root in turn) before throwing — would bring `readTextFromFile()` in line with the project-root-aware tools and close the gap. **Workaround in the meantime:** always pass the absolute path to `read-file`/`grep-file`; use `get-project-files` with a glob to obtain it when only a relative/partial name is known. |

---

### Post-edit structural integrity checks

**Tier 1** — `struct-check.js` already exists: brace/bracket/paren balance, unclosed block comment, `#if`/`#endif` balance. Currently wired to `str_replace` and (via `features.structCheck`) `insert`'s `insert_line` path. Wire to remaining commit sites via Tool Framework `ctx.commit()`.

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

`checkpoint-to-disk name` / `restore-from-disk name`. Snapshot = file path + text → `.mcp-checkpoints/<n>-<timestamp>.json`. ~40 lines. In-memory checkpoints stay as fast fallbacks.
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

## Architecture — Universal Match Engine (B24)

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

## B32 — str_replace-onto-match-engine port — remaining open item
 — RE-SCOPED, gap analysis complete (2026-09-17), NOT pursued

**Full gap analysis done 2026-09-17** (see CHANGELOG for detail): read str_replace's entire ~1100-line handler end-to-end against `match-engine.js`. Finding: the bug that originally motivated this port ("str_replace silently resolves ambiguous matches") is **already fixed independently** — B38 (2026-07-20, plain-string path) and B57/B58 (2026-09-12, fuzzyWhitespace/fuzzyContent/regex paths). str_replace's hand-rolled matching is correct and battle-tested; porting it onto the engine's equivalent-but-separate guard would be deduplication only, at real risk to the highest-traffic tool in the file (2778+ lifetime hits). Conversely, `match-engine.js` was missing two things str_replace has (B39 drift re-check, B40 write-verification) — those were ported into `applyEdit()` as their own small change (see CHANGELOG), independent of whether str_replace itself ever moves onto the engine.

**Decision: do not port str_replace.** No correctness gain identified: only maintainability (one shared implementation instead of two independently-correct ones). Given the traffic/risk, that trade isn't worth it right now. Revisit only if a NEW bug is found in str_replace's hand-rolled path that the engine already handles correctly (that would flip the calculus back toward porting), or if `applyEdit()` gains real callers and the dedup argument gets stronger on its own.

---


## FUTURE WORK — per-tool supported-hints declaration + hide unsupported hints from descriptions

Every tool's `inputSchema` grants it *every* hint in `ANCHOR_SCHEMA`/`STRUCTURAL_ANCHOR_SCHEMA` regardless of whether the handler actually understands it — support is implicit in whatever the handler's hand-written `if` chain happens to check, not declared anywhere. That's a structural drift risk: any future hint added to the shared schema is automatically "accepted" (schema-valid) by every tool, whether or not that tool's handler was updated to do anything with it.

**Deferred plan (not built yet, do this later, low urgency — "make it work now, filter later"):**
- Add an explicit `SUPPORTED_HINTS` list per tool (e.g. in `tool-catalogue.js` or a new small map in `schema.js`).
- Use that list in two places: (1) at request time, to reject/ignore-with-warning any hint the tool doesn't declare support for; (2) at description-generation time, to only show hints in each tool's description that it actually supports.
- Do NOT block current work on this — hand-wiring individual hints into individual tools remains fine in the interim; this is a later consolidation pass, likely bundled with the T1–T3 build-out since those introduce new tools (`block-edit`, `block-delete`) that should get the declared-hints treatment from day one.

---

## Architecture — unified edit backend with per-tool capability tickboxes (DECIDED direction, 2026-07-20, not built yet)

Supersedes the earlier "not designed yet" framing below (kept underneath for
history). Decided across today's conversation:

**The model:** one shared backend function —
`commitEdit({ scope, deleteRange, insertText })`, per the primitive already
sketched pre-2026-07-20 (deleteRange:null = insert, insertText:'' = delete,
both non-null = replace). Every MCP-facing tool name (`str_replace`,
`insert`, `delete-line-range`, and any future one) stays its own real
registration — own name, own description, own decision-ladder, so the
per-tool teaching value the LLM relies on is never lost — but each
registration's `features`/config block (the same declarative pattern
already used today for `dryRun`/`lint`/`successNudge`/`structCheck`
per-tool toggles) also declares which **capabilities** that tool name is
allowed to use: delete-allowed, insert-allowed, which hint set, whether the
raw-line-number legacy fallback is exposed. The registration reads its own
tickboxes, calls the one shared backend with the right shape, and the
backend itself never needs to know or care which tool name it was invoked
through.

**Why this and not either extreme:**
- NOT "N separate hand-rolled implementations forever" (today's state) —
  every fix/new hint/new diagnostic in the shared backend propagates to
  every tool automatically; the only per-tool surface left to maintain is
  a short tickbox list, not a duplicated handler.
- NOT "one mega-tool with a mode param" either — the "What NOT to do"
  section below's "do not collapse to 1-2 mega-tools" guidance is about
  the MCP-facing surface, and still holds: the LLM still sees
  `str_replace`, `insert`, `delete-line-range` etc as genuinely separate,
  independently-described tools. Only the implementation collapses, not
  what's presented.

**Validated against real precedent, not just reasoned from first
principles** — Cline's shipping code (test/_cline_src,
`ToolExecutorCoordinator.ts` + `WriteToFileToolHandler.ts`) does exactly
this in production: `write_to_file`, `replace_in_file`, and `new_rule` are
three separate tool names, all routed via `SharedToolHandler` to the *same*
underlying handler, gated internally by `block.name ===` checks. This
codebase's existing declarative `features:{...}` tickbox pattern is a
cleaner mechanism for the same gating than Cline's imperative if-chain —
this isn't inventing a new idea, it's applying an already-proven pattern
more cleanly than the reference implementation that proved it.

**Sequencing — insert first, proven, before str_replace touches it:**
Per PJ (2026-07-20): `insert` becomes the vehicle for building out and
proving the shared backend, since it's already on
`resolveScope()`/`matchContent()`/`buildFailResponse()` and is
comparatively low-traffic (196 lifetime hits vs str_replace's 2778) — safer
to iterate on. Once `insert`'s pattern is fully verified working,
`str_replace`'s own registration gets rewired to call the same shared
backend via its own tickbox config — **not a rename, not an alias, no
naming-collision risk.** `str_replace` keeps its own registration and name
the entire time; only its internals change from hand-rolled to
backend-calling, the same incremental, verifiable step B38 already modeled
(fix logic in place, keep the name, keep it registered). This directly
avoids the "can't have two tools with the same name" concern raised
2026-07-20 — that concern only applies to a hard rename/cutover, which is
explicitly not the plan.

**Where delete-line-range fits — narrower than originally scoped for T3:**
Investigation 2026-07-20 (see `test/unified-edit-backend-design.md`) found
`delete-line-range`'s raw `startLine`/`endLine` path has no content
verification at all (unlike str_replace, which even in its weakest
`afterLine` fallback mode still narrows a search window and then still
requires `old_str` to match inside it — verified fallback, not blind
positional edit). `delete-line-range`/`delete-block` both show 100%
lifetime hit rates, so this isn't "these tools are broken" — it's one
specific narrow gap (no equivalent of `old_str` in the raw-line path) that
should get its own small, direct fix (an optional `expectedContent`-style
check, giving it the same verified-fallback shape `str_replace afterLine`
already has) rather than being folded into T3's original
merge-into-block-delete plan. T3's row below is revised accordingly.

**Not decided yet — genuinely open:**
- Exact shape of the tickbox config for capability-gating (vs. the
  existing `features:{...}` shape, which today only gates cross-cutting
  concerns like dryRun/lint — extending it to gate *which primitive
  operations* a tool exposes is new territory for that mechanism).
- Whether `delete-line-range`/`delete-block` join the shared backend in
  the same pass as `str_replace`, or as a later fast-follow once
  `str_replace` itself is proven on it. (B44, fixed 2026-09-12, resolved
  the underlying ambiguous-match bug in `resolveStructuralAnchor` — so
  `sectionHint`/`preprocBlock` no longer need a bug fix *before* this
  question can be answered, only the architectural port itself. Fix-then-
  port already happened for that helper; only port remains, whenever this
  is decided.)

**Reload hazard, reconfirmed 2026-09-12 (relevant to any future edit here):**
editing this server's own source files (`mcp-registration.js`,
`buffer-helpers.js`, etc.) via `str_replace`/`insert` when the file is
**not open in a Pulsar tab** writes straight to disk but does NOT reliably
trigger Pulsar's package-reload file-watcher — repeated dry-run tests kept
showing pre-fix behavior and `get-edit-stats`' session counters never
reset, even after a `tool_search` reload of tool descriptions. A manual
Pulsar restart was required before a B44 fix actually took effect. Earlier
restart-hazard notes ([33]/[40]) assumed edits went through an open tab
(a real in-editor save), which does reliably trigger the reload — this
headless-write path is a distinct, previously undocumented case. Anyone
editing server source under this plan should expect to need a manual
restart afterward, and should verify the fix landed against a live test
(not just a description-freshness check) before considering a fix done.

---

## Architecture note — the original "universal edit tool" observation (SUPERSEDED by the section above, kept for history)


Raised by PJ, worth recording verbatim in spirit: **str_replace is conceptually insert with a before-anchor that also deletes what's in between** — and by extension, most of the edit-tool family (str_replace, insert, delete-line-range, delete-block, replace-block) could in principle be ONE underlying tool structure in the framework, with the distinct MCP tool names/descriptions the LLM sees being a presentation-layer alias over a single implementation, and behavior (delete existing content: y/n, insert new content: y/n, anchor style) selected via config tickboxes rather than five separately-maintained handlers.

This is the natural end-state of B24/T1-T6 taken one step further — not just shared matching/scoping (match-engine.js) but a shared TOOL SHAPE, with `str_replace` and `insert` becoming two configurations of the same underlying commit primitive: `commitEdit({ scope, deleteRange: match.range | null, insertText: newStr })`. A pure insert is `deleteRange: null`; a pure delete is `insertText: ''`; str_replace is both non-null.

**Not designed yet — open questions before building this:**
- Whether the MCP-facing tool SURFACE should also collapse (one tool, a `mode` param) or stay as separate named tools with separate descriptions/decision-ladders (probably the latter — collapsing the LLM-facing surface risks losing the teaching value of per-tool decision ladders, even if the implementation collapses)
- How this interacts with the T1-T6 build order already in this doc — this observation suggests those conversions and any future str_replace-onto-match-engine port might converge on the SAME shared commit primitive rather than three separate ports
- Whether `features.successNudge`-style declarative config is the right mechanism to also drive which MODE a unified tool runs in, or whether mode selection needs its own dedicated config shape

**Idea (raised by PJ, 2026-07-19) — migrate via insert instead of porting str_replace directly:** rather than porting str_replace's ~1000-line hand-rolled handler onto the engine in place, build `insert` up into the full replacement first — since `insert` is already on `resolveScope()`/`matchContent()`/`buildFailResponse()`/`features.successNudge`/`features.structCheck`, extending it to also accept a delete range (i.e. give it the `old_str` / content-to-remove side it currently lacks) would make it a strict superset of str_replace's behavior: `deleteRange: null` is today's insert, `deleteRange: match.range` is str_replace. Once `insert` can fully reproduce every str_replace case (including the ambiguity-guard and found-outside-scope fixes from the B32 addendum above, which `insert` already gets via the engine), retire the old hand-rolled `str_replace` handler and register **`str_replace` as an alias name pointing at the same underlying implementation `insert` uses** — same tool-shape idea as the `commitEdit({ scope, deleteRange, insertText })` primitive already sketched above, but sequenced as "grow insert, then rename/alias" rather than "port str_replace in place." Preserves the 662+ hit learned tool name (per "What NOT to do" in the Tool Consolidation section below — don't rename str_replace) while letting the actual migration happen on the newer, already-framework-native code path instead of inside the riskier legacy handler. Not designed in detail yet — needs a decision on: whether `insert`'s description/decision-ladder still makes sense once it also deletes (may need its own rewrite, not just aliasing), and whether `old_str`-style content-to-delete becomes a first-class `insert` param or stays str_replace-only surface syntax over the shared primitive.

## Idea — stacking/composable anchors, e.g. inFunction + afterString (raised, not designed/built yet)

Problem: `resolveScope()` today is a strict if/else-if ladder — the first hint present wins outright; every other hint passed alongside it is silently ignored. So `{inFunction:'hal_init', afterString:'g_hal ='}` does NOT mean "search for that string inside hal_init" — only `inFunction` takes effect. `betweenHint` is the only existing example of a hint that layers scope-narrowing on top of scope-narrowing, and even that's only wired as a modifier for a couple of tools, not general.

Proposed direction: let a primary scope hint resolve a search window as it does now, then optionally apply a secondary content hint (`afterString`/`beforeString`) *within* that window rather than over the whole file — i.e. two-stage `resolveScope()`. Natural fit for `lib/match-engine.js` since `matchContent()` already takes a `scope` and searches only inside `searchStart`/`searchEnd` — the missing piece is `resolveScope()` accepting a combination of hints instead of picking exactly one. Would directly help disambiguation cases where a string appears in several functions.

Not designed in detail yet — needs a decision on: which hint pairs are allowed to stack, whether it's every tool via the shared engine or opt-in per tool, and how failure messages explain "found outside the narrowed sub-scope but inside the outer one" distinctly from "not found at all."

## Idea — line-offset modifier for insert (raised, not designed/built yet)

Problem: content-anchored hints need unique, non-blank text to match against. But sometimes the actual insertion point you want is a blank line (or an otherwise low-content line) a fixed distance away from the nearest unique anchor. Today the only way to target that is the purely positional `insert_line:N`.

Proposed direction: an optional offset modifier (e.g. `lineOffset:N`) that pairs with any of the existing content-anchored hints — resolve the anchor's row the normal (drift-immune) way, then shift by N lines before inserting. Doesn't exist anywhere in `schema.js` yet. This would likely be `insert`-specific rather than a general `ANCHOR_SCHEMA` addition. Not designed in detail yet — needs a decision on interaction with `betweenHint`/scoped anchors and whether negative offsets (before the anchor) should be supported too.

---

## Tool Consolidation — Recommendations (researched 2026-06-19)

> Based on: analysis of Aider, Cline, opencode, Claude Code source + lifetime stats. **Note (2026-07-20): the specific numbers below are from an older stat snapshot (2026-06-19) — current lifetime numbers per `get-edit-stats` are str_replace 2778 hits/422 faults, insert 196/44, delete_line_range 74/0, delete_block 6/0, apply_patch 0/20. The qualitative conclusions below (str_replace dominance from investment, not superiority; other tools under-invested) still hold and are now more strongly evidenced, not less — kept as historical record rather than re-numbered throughout.**

### Industry pattern
All tools (Cline, opencode, Claude Code) converge on **3 edit tools**: surgical edit, whole-file write, multi-hunk patch. Nobody has separate insert/delete tools. Delete = surgical edit with empty replacement. Insert = surgical edit including surrounding line. **Confirmed independently 2026-07-20** by reading Cline's actual shipping source: `write_to_file`/`replace_in_file`/`new_rule` are three tool names routed to one shared handler (`SharedToolHandler` → `WriteToFileToolHandler`, gated by `block.name`) — direct precedent for this codebase's own unified-backend-with-tickboxes direction (see Architecture section above).

### Our differentiator
The hint system (`afterString` 93% hit rate, `inFunction` 88%) is unique — nobody else has it. Claude Code has `@@contextLine` as a single content anchor but no scope narrowing, no ambiguity check, no fuzzy matching. This is worth protecting and extending, not replacing.

### Core principle — invest before killing
`str-replace` dominates the stats (304 hits, 79%) not because other tools are redundant but because **only `str-replace` received investment**. Every other tool got a basic implementation and was left to fend for itself.

**Do not kill a tool because it has low stats. Give it the same investment as `str-replace` first, then measure.**

The one exception: `replace-block` — genuinely superseded by `str-replace` for its brace-block use case, and its approach (find anchor, brace-count to `}`) is fragile. Kill it now.

### Planned tool family (after investment)

```
str-replace      — surgical single content match. Already mature. Will migrate onto the shared backend (see Architecture section) once insert proves the pattern — no rename.
insert           — insert at content anchor. Vehicle for proving the shared backend pattern first (see Architecture section).
apply-patch      — multi-hunk unified diff. T1 (framework migration, no format rebuild) closed 2026-09-12 — see CHANGELOG.
delete-line-range / delete-block — DEFERRED rebuild — see T3's revised scope below. Each already ~100% hit rate; the actual gap is narrow (raw-line path lacks content verification) and gets its own small fix, not a merge.
replace-document — whole file rewrite. Already fine.
replace-function-body — whole function rewrite. Already fine.
```

### Recommended changes

| # | Priority | Item | Notes |
|---|---|---|---|
| T2 | | T4EDIUM | Kill `replace-block` | 0 hits both stat sets. Genuinely superseded — `str-replace` handles all its brace-block cases better. Clean break, no alias. |
| T6 | 🔧 LOW | Update `str-replace` description — explicit delete + insert patterns | Add: `new_str:""` deletes matched content. For inserting, prefer `insert` tool. Cross-reference clearly. |

### What NOT to do
- **Do not rename `str-replace`** — 662+ hits of learned behaviour (2778 per current lifetime stats). Cost of relearning outweighs naming aesthetics. Still holds under the unified-backend direction above: str_replace's *internals* migrate to the shared backend, but its registration/name never changes — no rename, no alias, no cutover moment.
- **Do not kill tools based on low stats alone** — `str-replace` won by investment not by being better. Other tools deserve the same treatment first.
- **Do not collapse the MCP-facing tool surface to 1-2 mega-tools with a mode param** — complexity belongs in matching logic + hints, not fewer *presented* tools. Industry evidence agrees (Cline keeps 3 separate tool names even though they share one handler). **Refined 2026-07-20:** this guidance is about what the LLM sees, not the implementation — collapsing the *backend* while keeping distinct tool names/descriptions (see Architecture section above) is the decided direction and does not violate this principle; it's Cline's own production pattern, not a "mega-tool."
- **Do not alias killed tools** — clean break. LLM relearns from descriptions. (Distinct from the shared-backend direction: that's multiple *live, still-taught* tool names sharing implementation, not an alias left behind after a tool's retirement.)

### Build order
T1 (apply-patch → match-engine migration) is done and closed (2026-09-12, see CHANGELOG). T3's own delete-line-range verified-fallback fix is done (2026-09-12, see CHANGELOG); `delete_block`'s off-`findAnchor` migration is also done and live-verified (2026-09-17, see CHANGELOG) — `findAnchor` is now fully retired from the codebase. T2 (insert investment) is done and is also the proving ground for the unified-backend Architecture direction above — that's the next real architectural step now that T1 and T3 have both landed. T4 (kill replace-block) → T5+T6 (description polish) unchanged.

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
- **Global substitution on mcp-registration.js:** ~~`replace-all` and `sed` time out on this file~~ — RESOLVED, no longer true. `sed` handles this file fine now. The PowerShell workaround below is kept only as a general fallback pattern, not because sed/replace-all are broken.
- **PowerShell null guard:** Always validate `$content` is non-null before `Set-Content`. A failed `-replace` or `Get-Content` on a locked file returns null; writing null produces a 3-byte file. Pattern: `if (-not $content) { Write-Error "Content is null, aborting"; exit 1 }` after every `Get-Content` and after every `-replace` chain.
- **tool-catalogue.js edits:** `str_replace` works correctly. PowerShell `Set-Content` is still an option for large rewrites but prefer `str_replace` — always open the file first with `open-file`.
- **PowerShell writes to closed files are unrecoverable:** `run-command` pre-flight checkpoints all *open* editors. Files not open in a tab cannot be snapshotted. If PowerShell must write a file, open it in Pulsar first.
- **grep-project now works on mcp-registration.js** (v0.14.1 — readTextFromFile fix). No longer need open-file workaround.
