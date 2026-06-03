# pulsar-edit-mcp-server — Work Tracking

> Last audited against live code: 2026-06-03

## Files

- `lib/mcp-registration.js` — ~6539 lines. Full Pulsar restart + babel cache clear required for registerTool/schema changes. Handler body changes hot-reload on save.
- `lib/pulsar-edit-mcp-server.js` — UI file (~865 lines).
- `lib/chat-panel.js` — Chat panel UI. Requires Pulsar reload (no hot-reload).
- `styles/pulsar-edit-mcp-server.less` — Stylesheet. Hot-reloads on save.

---

## TODO

### Chat panel MCP connect/disconnect toggle

UI switch in the chat panel header to connect or release the local MCP client on demand — allows Claude Desktop and the chat panel LLM to share the server without conflict (only one holds the session at a time).

- Toggle button in header: `🟢 MCP Connected` / `🔴 MCP Disconnected`
- `connectMcp()`: calls `startMcpClient()` via a callback passed into ChatPanel constructor, stores result in `this.mcpClient`, clears `mcpTools` cache
- `disconnectMcp()`: closes transport, nulls `this.mcpClient`, clears `mcpTools` cache
- Package passes `connectFn` / `disconnectFn` callbacks into `new ChatPanel(connectFn, disconnectFn)` — avoids circular module deps
- Button disabled (greyed) while connecting (async)
- On disconnect: next Send shows the existing "MCP server not connected" error rather than crashing

**Complexity:** Low.

### Visual diff decorations (Cursor-parity)

Render proposed changes as inline editor decorations — green/red lines in the Pulsar gutter. Claude proposes, user visually reviews in-editor, then accepts or rejects.

- New tool `stage-edit` or `dryRun:true` returns a staged state
- Use `editor.decorateMarker()` with custom CSS classes
- Store staged state in module-level `stagedEdit` object (similar to `patchRescueStore`)
- `commit-staged` / `discard-staged` or reuse `confirm:true` pattern from apply-patch
- `highlight-range` decoration system already exists — build on that

**Complexity:** Medium-high.

### Inline diff in chat panel

Show before/after diff rendered directly in the chat display after each edit — no new tab, no editor clutter. Agreed approach after comparing Claude Code / Cline / Aider (none highlight or move cursor; Cline uses a diff tab which creates tab noise).

- `diff` library already imported in codebase
- Render unified diff block as HTML in chat display after each edit tool call
- Collapsible or auto-scrolled
- Medium complexity

### ~~`naming-checker.js` — function naming + doc template validation~~ ✅ DONE (v0.10.6)

Implemented as three tools:

- **`namingcheck`** — camelCase, verb-segment, macro ALL_CAPS checks. Kernel `.c`/`.h` only.
- **`check-function-docs`** — three-tier report (missing / wrongStyle / plainDoc). Each entry includes `signature`, `[in header]` tag (sidecar `.h` detection), and `line:` anchor. Kernel `.c`/`.h` only.
- **`insert-function-doc`** — inserts kernel-doc `/**` skeleton with `@param:`, `Context:`, `Return:`. Accepts `line:` from `check-function-docs` for precise anchor. Kernel `.c`/`.h` only.

**Remaining from original spec (deferred):**
- Multi-style doc support (`doxygen`, `ghidra`, `misra`, `plain`) — currently kernel-only
- Hungarian prefix enforcement (`g_`, `s_`, `m_` etc.)
- Tier-3 verb / specifier-token counting
- `namingcheck.docStyle` config in package.json
- Weak noun endings check (`Data`, `Info`, `Helper` etc.)


---

### Future / lower priority

- **Git integration** — `run-command` can already run git commands; an auto-commit after successful edits or a `git-commit` tool would give a proper history trail. May just be a workflow convention.
- **Linting + test loop** — `get-diagnostics` and `get-compiler-diagnostics` exist but no automatic post-edit test runner. A `run-tests` tool that fires after edits and pipes failures back would close that gap.

---

## ON HOLD — File Split

### LARGE — Split `mcp-registration.js` into per-tool files

**Status:** On hold indefinitely. The original motivation was crash recovery — a syntax error in the monolith killed all tools. This has not been an issue since common schemas (ANCHOR_SCHEMA etc.) were introduced. Risk/reward no longer justifies the effort.

**Revisit if:** the file grows significantly beyond 6200 lines, or anchor collision failures return.

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
