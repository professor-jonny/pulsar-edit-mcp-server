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

### `naming-checker.js` — function naming + doc template validation

Ported from GhidraMCP 5.6.0 `NamingConventions` class (pure string logic, no Ghidra dependency). Useful for **any C project**, not just RE work. Sits alongside `checkpatch` — same concept, different layer:

- `checkpatch` → code *style* (formatting, spacing, braces)
- `namingcheck` → code *semantics* (naming quality, doc completeness)

---

#### Part 1 — `namingcheck` tool: function/variable naming rules

Scans active buffer, reports naming violations with line numbers. Plugs into `styleStats` as new rule types (same counters as checkpatch rules). On-demand only — not wired inline on save.

**Verb tier system** (from `NamingConventions.class` — 100+ verbs total):
- **Tier 1 — strong/precise:** `Allocate`, `Calculate`, `Clear`, `Close`, `Compare`, `Compress`, `Connect`, `Convert`, `Copy`, `Create`, `Decode`, `Delete`, `Deserialize`, `Destroy`, `Detect`, `Disable`, `Disconnect`, `Dispatch`, `Enable`, `Encrypt`, `Enumerate`, `Execute`, `Find`, `Flush`, `Format`, `Free`, `Generate`, `Get`, `Hash`, `Initialize`, `Insert`, `Load`, `Lock`, `Map`, `Merge`, `Open`, `Parse`, `Print`, `Query`, `Read`, `Register`, `Release`, `Remove`, `Render`, `Reset`, `Resize`, `Resolve`, `Save`, `Search`, `Send`, `Set`, `Sort`, `Start`, `Stop`, `Store`, `Submit`, `Terminate`, `Transmit`, `Unload`, `Unmap`, `Unregister`, `Update`, `Validate`, `Verify`, `Write` — pass with 1+ specifier token.
- **Tier 2 — acceptable:** `Append`, `Apply`, `Build`, `Check`, `Compute`, `Configure`, `Dump`, `Emit`, `Encode`, `Filter`, `Notify`, `Output`, `Prepare`, `Publish`, `Receive`, `Scan`, `Signal`, `Trigger`, `Watch` — pass with 1+ specifier token.
- **Tier 3 — vague (need 2+ specifier tokens):** `Do`, `Make`, `Manage`, `Run`, `Use`, `Handle`, `Process`, `Perform`, `Execute` (when used generically) — `ProcessData` FAILS, `ProcessNetworkPacket` PASSES.

**Naming rules:**
- Function names must start with a tier-1 or tier-2 verb (PascalCase for C++ / snake_case verb prefix for C — configurable)
- Tier-3 verbs require 2+ additional specifier tokens in the name
- Minimum name length: 8 chars in the main part (configurable `minNameLength`) — prevents `DoIt`, `GetX`
- No weak noun endings alone: `Data`, `Info`, `Stuff`, `Thing`, `Item`, `Value`, `Result`, `Helper`, `Util`, `Manager`, `Handler` — must be qualified with a domain word
- Globals must have `g_` prefix
- File-scope statics must have `s_` prefix (configurable)
- Labels must be `snake_case`
- Enum members must be `UPPERCASE_SNAKE_CASE`
- Macro names must be `UPPERCASE_SNAKE_CASE`

**Hungarian prefix table** (configurable on/off — off by default, on for RE/Windows work):

| Prefix | Type |
|--------|------|
| `p` | pointer |
| `lp` | long pointer (16-bit legacy) |
| `pp` | pointer to pointer |
| `dw` | DWORD (unsigned 32-bit) |
| `w` | WORD (unsigned 16-bit) |
| `b` | BOOL or byte |
| `n` / `i` | int / signed integer |
| `u` | unsigned int |
| `sz` | null-terminated string (char[]) |
| `wsz` | wide null-terminated string (wchar_t[]) |
| `lpsz` | long pointer to null-terminated string |
| `lpwsz` | long pointer to wide string |
| `h` | handle (HANDLE, HWND, HKEY etc.) |
| `fn` | function pointer |
| `cb` | count of bytes |
| `c` / `cch` | count / count of characters |
| `g_` | global variable |
| `s_` | static variable |
| `m_` | member variable (C++ classes) |

---

#### Part 2 — `check-function-docs` tool: doc comment validation

Scans buffer for functions missing required doc comment sections. Reports per function with line numbers and which sections are absent. Doc style is selected per-project via config (see UI section below).

**Style: `doxygen`** (default — best general tooling support, VSCode IntelliSense, CLion, Doxygen HTML)
```c
/**
 * @brief One-line summary of what the function does.
 *
 * @param[in]  name   Description of input parameter
 * @param[out] result Pointer filled with result on success
 * @return     0 on success, negative errno on failure
 */
```
Checks: `@brief` present, `@param` with direction annotation for each parameter, `@return` or `@retval` present.

**Style: `kernel`** (Linux kernel style — pairs with `checkpatch`)
```c
/**
 * function_name - one-line summary (no period)
 * @param_name: description of parameter
 *
 * Return: 0 on success, -errno on failure
 */
```
Checks: first line is `name - description` format, `@param:` colon-style for each parameter, `Return:` present. Kernel style forbids `@brief` — flagged as violation if present.

**Style: `ghidra`** (RE workflow — plate comment format)
```c
/*
 * Algorithm:
 *   Step-by-step description for reverse engineer.
 *
 * Parameters:
 *   param_name (type) [in]  - description
 *
 * Returns:
 *   Description of return value.
 */
```
Checks: `Algorithm:`, `Parameters:`, `Returns:` sections present and non-empty.

**Style: `misra`** (safety-critical embedded — strictest)
Checks: `@brief` + `@details`, `@param` with direction, `@return`, `@pre`/`@post`, `@req` traceability tag.

**Style: `plain`** — just checks a block comment exists above the function. No section validation.

---

#### Part 3 — `insert-function-doc` tool

Inserts a skeleton doc comment above a named function, pre-filled with parameter names/types from signature, direction annotations guessed from type, and empty description fields. Style matches active `docStyle` config.

---

#### UI — Doc style selector in stats panel

**Doc Style** dropdown in stats panel: `doxygen` | `kernel` | `ghidra` | `misra` | `plain`. Writes `atom.config.set(...)` immediately. **Naming Style** toggle: `General C` (off) | `Windows/RE` (on) for Hungarian enforcement.

#### Configuration (package.json configSchema additions)

- `namingcheck.enabled` — on/off (default `true`)
- `namingcheck.docStyle` — `doxygen` | `kernel` | `ghidra` | `misra` | `plain` (default `doxygen`)
- `namingcheck.hungarian` — enforce Hungarian prefixes (default `false`)
- `namingcheck.staticPrefix` — enforce `s_` prefix on file-scope statics (default `false`)
- `namingcheck.memberPrefix` — enforce `m_` prefix on C++ members (default `false`)
- `namingcheck.minNameLength` — minimum function name length (default `8`)
- `namingcheck.customVerbs` — user-supplied tier-1 verbs array (default `[]`)
- `namingcheck.requireReqTag` — require `@req` traceability tag (misra only, default `false`)

**Complexity:** Medium. Pure JS, no new dependencies.

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
