# pulsar-edit-mcp-server — Work Tracking

> Last audited against live code: 2026-06-05

## Files

- `lib/mcp-registration.js` — ~6539 lines. Full Pulsar restart + babel cache clear required for registerTool/schema changes. Handler body changes hot-reload on save.
- `lib/pulsar-edit-mcp-server.js` — UI file (~865 lines).
- `lib/chat-panel.js` — Chat panel UI. Requires Pulsar reload (no hot-reload).
- `lib/tree-sitter-symbols.js` — Tree-sitter symbol extraction + anchor resolution. Hot-reloads on save.
- `lib/naming-checker.js` — Kernel C naming + doc validation. Hot-reloads on save.
- `styles/pulsar-edit-mcp-server.less` — Stylesheet. Hot-reloads on save.

---

## TODO

### Visual diff decorations (Cursor-parity)

Render proposed changes as inline editor decorations — green/red lines in the Pulsar gutter. Claude proposes, user visually reviews in-editor, then accepts or rejects.

- New tool `stage-edit` or `dryRun:true` returns a staged state
- Use `editor.decorateMarker()` with custom CSS classes
- Store staged state in module-level `stagedEdit` object (similar to `patchRescueStore`)
- `commit-staged` / `discard-staged` or reuse `confirm:true` pattern from apply-patch
- `highlight-range` decoration system already exists — build on that

**Complexity:** Medium-high.

### Inline diff in chat panel

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

### Extend `smartSuggestion` to remaining edit tools

`smartSuggestion` fires on failure #1 and gives the LLM targeted guidance on what to try next. Currently wired to: `str_replace`, `insert`, `delete-line-range`, `delete-block`, `sed`, `apply-patch`.

Missing:
- **`replace-block`** — has `anchorNotFound` and `braceMatchFailed` failure paths with no smart suggestion. Medium value — brace-match failures are confusing without guidance.
- **`replace-function-body`** — has its own fuzzy name-scoring on `notFound` but not the full `smartSuggestion` system (no hint nudge, no escalation counter). Lower priority now tree-sitter makes `notFound` rare.
- **`replace-all`** / **`replace-across-files`** — minimal failure modes, low value.

**Complexity:** Low — copy the existing `smartSuggestion` call pattern from `delete-block` into the `replace-block` failure paths. One session.

---

### Future / lower priority

- **Git integration** — `run-command` can already run git commands; an auto-commit after successful edits or a `git-commit` tool would give a proper history trail. May just be a workflow convention.
- **Linting + test loop** — `get-diagnostics` and `get-compiler-diagnostics` exist but no automatic post-edit test runner. A `run-tests` tool that fires after edits and pipes failures back would close that gap.

---

## Feature Gap Analysis — vs Other Tools (researched 2026-06-04)

### What we have that others don't
- **Kernel C style checker** — inline, per-edit, rule-level violation reporting. No other tool does language-specific style at this depth.
- **naming-checker** — verb-segment, camelCase, doc skeleton generation. Unique.
- **Ghidra integration** — reverse engineering workflow. Unique.
- **Edit stats + hints system** — tracks hit/fault rates per tool, surfaces smarter suggestions based on failure patterns. Unique.
- **Self-updating project rules + repo map** — `session-notes` acts as a living CLAUDE.md: the LLM writes its own codebase-specific rules, tool preferences, and lessons learned, then reads them back at the start of every session. Combined with `get-repo-map` at session start, the LLM arrives with full structural context and accumulated knowledge of what works on this codebase. Better than a static user-written rules file because it improves automatically.
- **`@//` prompt shortcuts** — named prompt templates in `shortcuts.md`, invokable from the chat input with live filter dropdown. Functionally equivalent to Windsurf Cascade workflows at a fraction of the complexity.
- **apply-patch fuzzy rescue** — automatic fuzzy hunk recovery with confirm:true flow. Not seen elsewhere.
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
| Checkpoint / restore mid-task | ❌ | ❌ | ✅ shadow git | ❌ | ✅ (buffer only) | | Cline uses shadow git repo for checkpoints. We have buffer checkpoints (wiped on server save). Disk-backed checkpoints would be stronger. |
| Kernel C style checking (inline per-edit) | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | Per-edit violation reporting scoped to changed lines. Rule-level breakdown. checkpatch for full-file audit. |
| Function naming + doc skeleton generation | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | namingcheck, check-function-docs, insert-function-doc. Kernel C only. |
| Ghidra reverse engineering integration | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | Full RE tool suite via Ghidra MCP bridge. |
| Edit stats + smart failure suggestions | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | Per-tool hit/fault/hint tracking. Surfaces tool-switch suggestions on first failure, not third. |
| Persistent cross-session LLM notes | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | session-notes tool. LLM writes lessons learned; reads them back next session. Self-improving — no user maintenance needed. |
| Aider-style repo map (tree-sitter) | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | get-repo-map with PageRank symbol ranking. Integrated natively, no Aider install needed. |
| apply-patch fuzzy rescue | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | Auto fuzzy hunk recovery with confirm:true flow on failure. |
| Tree-sitter anchor resolution | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | afterHint/betweenHint/functionHint all resolved via tree-sitter live buffer. resolveAnchor() resolves to function end semantically, not first char occurrence. |

### Highest value gaps to consider

1. **Plan mode** — describe task → LLM outputs numbered step plan in chat → user approves/edits → execution begins. Prevents wasted edits on misunderstood tasks. All four major tools have this. Could be a chat panel mode toggle (`/plan` prefix or Plan button). LOW-MEDIUM implementation complexity — it's a prompting/UX pattern, not a new tool.

2. **Per-step approval** — before each tool call in an agentic run, show intent in chat and wait for user confirm. Cline's defining UX. Pairs naturally with plan mode. MEDIUM complexity — requires chat panel to intercept tool dispatch.

3. **Context window indicator** — show token usage in chat panel header. MEDIUM-LOW complexity — needs token counting on the callLLM response (usage field already in API response).

4. **Disk-backed checkpoints** — current checkpoints are wiped on every mcp-registration.js save (hot-reload). A `checkpoint-to-disk` / `restore-from-disk` tool pair using a named snapshot file would survive reloads. LOW complexity.

5. **Reusable workflows** — named prompt+tool recipes stored in a JSON file, invokable by name from chat. Windsurf Cascade's killer workflow feature. MEDIUM complexity. `@//` shortcuts cover the prompt-template use case already — this would add tool sequencing on top.

---
### LARGE — Split `mcp-registration.js` into per-tool files

**Status:** On hold indefinitely. The original motivation was crash recovery — a syntax error in the monolith killed all tools. This has not been an issue since common schemas (ANCHOR_SCHEMA etc.) were introduced. Risk/reward no longer justifies the effort.

**Revisit if:** the file grows significantly beyond 6200 lines, or anchor collision failures return.


---

### str_replace character-matching robustness (fuzzyContent + regex mode)

**Problem:** `str_replace` does exact byte-for-byte matching. Fails on `old_str` containing backticks, pipe characters, emoji, smart/typographic quotes, BOM, zero-width chars, and escape sequences. Documented failure classes in session notes: markdown table rows (pipes), emoji headings, template literal lines, require-lines adjacent to block comments. No existing tool (Claude Code, Cline) has solved this — they all fall back to whole-file write which corrupts context.

**Fix — three layers, implement in order:**

**Layer 1 — `fuzzyContent` normalization (highest ROI, lowest risk)**
Extend the existing `fuzzyWhitespace` infrastructure with a parallel `fuzzyContent` pass. Normalize for the *comparison only*; commit using the buffer's actual content (same pattern as `fuzzyWhitespace`). Characters to normalize:
- Typographic/smart quotes (`"` `"` `'` `'`) → straight equivalents
- BOM (`\uFEFF`) → stripped
- Zero-width chars (`\u200B`, `\u200C`, `\u200D`, `\uFEFF`, `\u00A0`) → stripped or space
- Mixed line endings (`\r\n` vs `\n`) → already handled, verify
- Emoji: match by skipping codepoint ranges U+1F000–U+1FFFF / U+2600–U+27BF in both sides during compare
Add `fuzzyContentCommits` stat counter alongside `fuzzyWhitespaceCommits` so we can measure real-world hit rate once live.

**Layer 2 — auto delete+insert fallback when `lineHint` present**
When both exact match and `fuzzyContent` match fail but `lineHint` is provided and points to a confirmed line (grep-file verified), silently fall back to: delete the matched line(s) + insert `new_str` at that position. This makes `str_replace + lineHint` a near-guarantee — character encoding becomes irrelevant when we have a confirmed line number. Surface as a new failure reason `lineHintFallback` in stats so we can track usage.

**Layer 3 — `regex: true` mode as explicit LLM escape hatch**
Expose a `regex: true` flag on `str_replace` so the LLM can write `old_str` as a pattern that wildcards over problematic characters rather than matching them exactly (e.g. `` const foo = `.*?` `` to skip backtick contents). The existing regex path is partially there but not exposed as a first-class param. This is what Serena does and it's the cleanest power-user solution. Genuinely novel — no other MCP edit server ships this.

**Files to change:** `lib/mcp-registration.js` (str_replace handler, stats init, summarise output).

**Stat additions:** `fuzzyContentCommits`, `lineHintFallback` counter in the str_replace stats block.

**Priority:** Layer 1 > Layer 2 > Layer 3. Layer 1 alone covers smart quotes + BOM + zero-width which are the most common silent failures.


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
- Never use `$1`/`$2` in replace-across-files replacement strings in regex mode — they are written as literals, not expanded. Use separate literal replace-across-files calls per distinct pattern instead.
- `replace-across-files` glob must always be `lib/*.js`, never `**/*.js` — the latter hits `.mcp-baseline/` which is a read-only backup and must never be modified. `replace-across-files` has no excludeGlob param so a positive lib/ scope is the only safe option. Same applies to `grep-project` when searching for edit targets.
- `functionHint` never on .md files — use lineHint or afterHint instead
- `grep-file` before str_replace on any file to confirm exact anchor text and line numbers
- chat-panel.js and .less changes require Pulsar package reload — they do NOT hot-reload on save
