# pulsar-edit-mcp-server — Work Tracking

> Last audited against live code: 2026-06-01

## Files

- `lib/mcp-registration.js` — ~6539 lines. Full Pulsar restart + babel cache clear required for registerTool/schema changes. Handler body changes hot-reload on save.
- `lib/pulsar-edit-mcp-server.js` — UI file (~865 lines).

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

---

---

### `chat-functions.js` improvements

The chat panel is already a full agentic loop — `callLLM` calls the LLM, executes MCP tool calls, feeds results back, and loops until done. It's a mini Claude Desktop built into Pulsar. Several improvements:

**~~1. `clearContextHistory` bug~~ ✅ DONE** — Fixed 2026-06-01. Resets to `[{role:"system",...}]` instead of emptying. Also clears `mcpTools` cache.

**~~2. `max_tokens: 1000` hardcoded~~ ✅ DONE** — Fixed 2026-06-01. Now reads `pulsar-edit-mcp-server.maxTokens` config (default 4096). Added to package.json schema as configurable setting.

**3. No streaming**
`callLLM` waits for full response before rendering. Adding `stream: true` + Server-Sent Events parsing would make responses feel much faster. Medium complexity but high UX impact.

**4. No image/vision support**
Messages are plain text strings. Adding multipart content support would enable image paste (PrintScreen → base64 → vision LLM). Medium complexity.

**~~5. Tool call visibility~~ ✅ DONE** — Fixed 2026-06-01. Shows `🔧 \`tool-name\`` in chat panel before each tool call.

### ~~Chat panel visibility — tool faults, destructive command confirmation, drag-and-drop~~ ✅ DONE

Implemented 2026-06-01. Tool faults: `wrapHandler` on `server.registerTool` in `mcpRegistration()` catches all throws and calls `chatPanel.appendFault(name, err.message)`. Destructive command confirmation: `confirm` param on run-command; `DESTRUCTIVE_RE` check before spawn; inline Run/Cancel widget in panel holds Promise until user clicks. Drag-and-drop: `dragover`+`drop` on textarea inserts file path at cursor. Show Chat Panel: `pulsar-edit-mcp-server:show-chat-panel` command + menu entries.

The chat panel is primarily a **display and control panel** in practice — Claude Desktop connects via MCP, the built-in LLM chat input is secondary. These items make the panel more useful as a live view of what's happening.

**Tool fault visibility:**
Currently tool errors go back to the LLM as exception responses — not visible in the chat panel at all. Wire tool fault strings to `appendOutput(text, 'error')` so every tool failure shows in the panel.

**Destructive command confirmation:**
Before spawning commands matching a danger pattern (`rm`, `rmdir`, `del`, `rd`, `format`, `Remove-Item`, `rd /s` etc.), pause and render a confirmation UI in the chat panel:
- "⚠️ Destructive command: `rm -rf dist/` — Run anyway?"
- Yes / No buttons
- MCP response held until user responds
- `confirm:true` param bypasses the UI for LLM-driven automation

**Drag and drop — path inserter:**
Drop a file from the filesystem onto the chat panel → insert just the file path into the input textarea, not the file contents. LLM then uses `read-file`/`grep-file` to read only what it needs.

**Complexity:** Low-medium. All three use the existing `#chat-display` append pattern proven in `showError`.

---

### ~~`run-command` streaming output to chat panel~~ ✅ DONE

Implemented 2026-06-01. `exec` replaced with `spawn`. stdout/stderr stream live to `chatPanel.appendOutput()`. `appendOutput(text, type)` added to `chat-panel.js`. `chatPanel` passed into `mcpRegistration()` as 5th param. MCP response to LLM unchanged (full stdout/stderr/exitCode on exit). `run_command` stats entry added.

---

### `get-repo-map` — compressed codebase index (Aider-equivalent)

**Status:** ✅ COMPLETE — v0.8.7. Full Aider-equivalent implementation with `excludeGlob` filter.

`excludeGlob` added in v0.8.7 — excludes files/folders from the symbol walk (e.g. `.mcp-baseline/`, `vendor/`, `test/`). Applied after `glob` using the same `globToRegex` helper as `grep-project`, `replace-across-files`, and other project-wide tools.

**Problem:** Navigating a large multi-file project currently requires multiple `list-project-functions` + `grep-project` calls to build context. Aider solves this with a "repo map" — a compact symbol index that fits in ~1000 tokens regardless of repo size.

**Target output format (Aider style):**
```
src/hal.c:
⋮...
│int hal_read(uint8_t *buf, size_t len)
⋮...
│void hal_write(const uint8_t *buf, size_t len)

src/net.c:
⋮...
│int net_connect(const char *host, uint16_t port)
```

**How Aider does it (repomap.py — fully researched 2026-06-01):**
1. **Tree-sitter** parses each file via `.scm` tag query files → emits `Tag(name, kind='def'|'ref', line)` tuples. Falls back to **Pygments** tokeniser for refs when tree-sitter only finds defs (e.g. C/C++).
2. Builds a **directed graph**: `referencer_file → definer_file` edges weighted by `sqrt(ref_count) × mul`. Multipliers: camelCase/snake_case names ≥8 chars → ×10, mentioned idents → ×10, `_` prefix → ×0.1, >5 definers → ×0.1, file in chat → ×50.
3. Runs **NetworkX PageRank** on the graph with optional personalisation for mentioned files/idents.
4. Distributes rank from each source node across its out-edges proportionally, accumulates `ranked_definitions[(definer_file, ident)]`.
5. **Binary search** on tag count to fit within token budget (default 1024 tokens).
6. Renders with **`TreeContext`** from `grep-ast` — shows the actual signature lines with `│` pipe prefix and `⋮...` ellipsis for skipped sections.

**How to implement this in Pulsar (researched 2026-06-01):**

Pulsar uses `web-tree-sitter` (WebAssembly) not `node-tree-sitter`. It is **not** accessible from a shell `node` process — it lives inside Electron's renderer and is only accessible from within a Pulsar package.

**Accessing tree-sitter from an MCP tool handler:**
```js
// For any open editor:
const langMode = editor.getBuffer().getLanguageMode();  // WasmTreeSitterLanguageMode
const layer = langMode.rootLanguageLayer;               // LanguageLayer instance
const tree = layer?.tree;                               // web-tree-sitter Tree object
const tagsQuery = layer?.tagsQuery;                     // pre-loaded tags.scm Query

// Run the tags query:
const captures = tagsQuery.captures(tree.rootNode);
// → [{name: 'definition.function', node: {startPosition: {row, col}, text}}, ...]
// → [{name: 'name', node: ...}, ...]  (the @name capture paired with @definition.*)
```

**Tags .scm files exist in app.asar for:** C, C++, JS, TS, Python, Ruby, Rust, Java, CSS, JSON, Shell, YAML, TOML, PHP, C#, Clojure, Markdown, Sass. Paths: `/node_modules/language-*/grammars/*/tags.scm`.

**C tags.scm example:**
```scheme
(function_declarator
  (identifier) @name) @definition.function
```

**JS tags.scm captures:** `@definition.function`, `@definition.method`, `@definition.class`, `@name`, `@doc`.

**For closed files** (not open in an editor): open silently with `atom.workspace.open(path, {activateItem: false, pending: true})`, get tags, then destroy. Or fall back to regex for closed files only.

**PageRank without networkx:** ~20-line power-iteration in JS:
```js
function pagerank(edges, nodes, iterations=20, d=0.85) {
  let rank = {};
  for (const n of nodes) rank[n] = 1 / nodes.length;
  for (let i = 0; i < iterations; i++) {
    const newRank = {};
    for (const n of nodes) newRank[n] = (1 - d) / nodes.length;
    for (const [src, dst, weight] of edges) {
      const outWeight = edges.filter(e => e[0] === src).reduce((s, e) => s + e[2], 0);
      newRank[dst] = (newRank[dst] || 0) + d * rank[src] * weight / outWeight;
    }
    rank = newRank;
  }
  return rank;
}
```

**TreeContext rendering substitute:** group tags by file, sort by line number, render actual source lines with `│` prefix, insert `⋮...` between non-consecutive lines. Read line from `tree.rootNode` text or re-read from file buffer.

**Token budget:** estimate ~4 chars/token. Binary search on how many tags to include.

**Parameters:** `glob?`, `maxTokens?` (default 1024), `minRefs?` (default 0), `mentionedFiles?` (boosts personalisation).

**Complexity:** Medium-high. The tree-sitter access path is confirmed working. Main risk: open/close of closed files may be slow for large repos — consider regex fallback for files not currently open.

---

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
 * Longer description paragraph (optional).
 *
 * @param[in]  name   Description of input parameter
 * @param[out] result Pointer filled with result on success
 * @param[in,out] buf Buffer read from and written to
 * @return     0 on success, negative errno on failure
 * @retval     -EINVAL if name is NULL
 * @note       Optional usage note
 * @warning    Optional warning
 * @see        related_function()
 */
```
Checks: `@brief` present, `@param` with direction annotation `[in]`/`[out]`/`[in,out]` for each parameter in signature, `@return` or `@retval` present. `@note`/`@warning`/`@see` optional. Reports missing direction annotation as a separate violation (`doxygen_param_no_direction`).

**Style: `kernel`** (Linux kernel style — pairs with `checkpatch`)
```c
/**
 * function_name - one-line summary (no period)
 * @param_name: description of parameter
 * @another:    description
 *
 * Longer description paragraph.
 *
 * Context: any (or: process, atomic, irq etc.)
 * Return: 0 on success, -errno on failure
 */
```
Checks: first line is `name - description` format, `@param:` colon-style (not `@param name`) for each parameter, `Return:` or `Returns:` section present. `Context:` optional but flagged as missing for functions that acquire locks (heuristic: name contains `lock`/`mutex`/`spin`). Kernel style explicitly forbids Doxygen `@brief` — flagged as a violation if present.

**Style: `ghidra`** (RE workflow — plate comment format from GhidraMCP `NamingConventions.class`)
```c
/*
 * Algorithm:
 *   Step-by-step description of what the function does,
 *   written for a reverse engineer reading decompiled output.
 *
 * Parameters:
 *   param_name (type) [in]  - description
 *   result     (type) [out] - description
 *
 * Returns:
 *   Description of return value and error conditions.
 *
 * Notes:
 *   Optional cross-references to related FUN_ addresses.
 */
```
Checks: `Algorithm:` section present and non-empty, `Parameters:` section with one line per parameter in `name (type) [dir] - desc` format, `Returns:` section present. `Notes:` optional. This style is specifically designed for documenting decompiled/renamed functions where the original intent must be reconstructed.

**Style: `misra`** (MISRA-C / safety-critical embedded)
```c
/**
 * @brief    Summary.
 * @details  Extended description.
 * @param[in]  name  Description
 * @return   Return description
 * @pre      Precondition that must hold before calling
 * @post     Postcondition guaranteed on return
 * @req      REQ-MODULE-001  (requirement traceability tag)
 */
```
Checks: `@brief` + `@details`, `@param` with direction for all params, `@return`, `@pre`/`@post` present (MISRA R8.7 equivalent), `@req` traceability tag present. This is the strictest mode — intended for safety-critical / automotive / medical device codebases where every function must be traceable to a requirement.

**Style: `plain`** (minimal — just check a block comment exists)
Checks only that a `/* ... */` or `/** ... */` block comment appears on the line immediately above the function signature. No section validation. Lowest friction, useful as a first-pass gate before adopting a full standard.

---

#### Part 3 — `insert-function-doc` tool

Inserts a skeleton doc comment above a named function, pre-filled with:
- Parameter names and types extracted from the signature
- Direction annotations guessed from type (`const` → `[in]`, pointer-only → `[out]`, pointer+const → `[in]`) — LLM corrects if wrong
- Return type annotation
- Empty description fields for the LLM or developer to fill in

Style matches the active `docStyle` config. Turns every `check-function-docs` violation into a single tool call. For `ghidra` style, pre-fills `FUN_` cross-reference hints if the buffer contains nearby Ghidra-style addresses.

---

#### UI — Doc style selector in stats panel

Add a **Doc Style** dropdown to the stats panel (`pulsar-edit-mcp-server.js`) alongside the existing Pause Stats button. Dropdown options: `doxygen` | `kernel` | `ghidra` | `misra` | `plain`. Selecting an option writes `atom.config.set('pulsar-edit-mcp-server.namingcheck.docStyle', value)` immediately — no save/restart needed. The LLM reads `atom.config.get(...)` at tool call time so the change takes effect on the next `check-function-docs` or `insert-function-doc` call.

The dropdown should show the current active style on load (`atom.config.get(...)` on panel init) and update when the config changes externally (via Settings view) using `atom.config.onDidChange(...)`.

A **Naming Style** toggle (separate from doc style) controls the Hungarian prefix enforcement: `General C` (off) | `Windows/RE` (on). Same immediate-write pattern.

---

#### Configuration (package.json configSchema additions)

- `namingcheck.enabled` — on/off (default `true`)
- `namingcheck.docStyle` — `doxygen` | `kernel` | `ghidra` | `misra` | `plain` (default `doxygen`)
- `namingcheck.hungarian` — enforce Hungarian prefixes (default `false`)
- `namingcheck.staticPrefix` — enforce `s_` prefix on file-scope statics (default `false`)
- `namingcheck.memberPrefix` — enforce `m_` prefix on C++ members (default `false`)
- `namingcheck.minNameLength` — minimum function name length (default `8`)
- `namingcheck.customVerbs` — user-supplied tier-1 verbs array (default `[]`)
- `namingcheck.requireReqTag` — require `@req` traceability tag (only active when `docStyle` is `misra`, default `false`)

---

#### Implementation notes

- New `lib/naming-checker.js` — same pattern as `style-checker.js`. Exports `checkNaming(text, filePath, opts)`, `checkDocs(text, filePath, style)`, `buildDocSkeleton(sig, style)`, `formatNamingViolations(violations)`.
- Three MCP tools in `mcp-registration.js`: `namingcheck`, `check-function-docs`, `insert-function-doc` — all in a new `NAMING GROUP` block, same lazy-load pattern as other groups.
- Stats wired into `styleStats` object — new rule keys: `verb_missing`, `verb_tier3_underspecified`, `name_too_short`, `weak_noun_suffix`, `hungarian_violation`, `doc_missing`, `doc_missing_brief`, `doc_missing_param`, `doc_param_no_direction`, `doc_missing_return`, `doc_missing_pre_post`, `doc_missing_req_tag`.
- `isGhidraFile()` check — skip naming rules on Ghidra decompiled files (high density of `FUN_`/`DAT_`/`PTR_` identifiers), but still allow `ghidra` doc style check since those files are exactly what `ghidra` style is for.

**Complexity:** Medium. Pure JS, no new dependencies. UI dropdown is low complexity — same `atom.config` write pattern used by existing settings.

---

### Ghidra tools — bring up to standard

`ghidra-tools.js` predates all the ANCHOR_SCHEMA and stats work. Needs:

- **Stats:** Add `editStats` entries + `bump()` calls for hits/fails on all tools (`list-functions`, `search-functions`, `get-function-body`, `get-xrefs`, `add-comment`, `get-function-list-with-comments`)
- **Hints:** Wire `functionHint`/`lineHint`/`occurrence` into `get-function-body` and `add-comment` — both currently fail silently if the name isn't found exactly
- **Console.log cleanup:** Noisy registration logs, same pattern as was fixed in mcp-registration.js
- **Style checker gate:** Must be gated OFF for Ghidra files — decompiled pseudocode violates every rule. Need `isGhidraFile()` in `style-checker.js` (detect by filename pattern `.bin.`/`.xbe.` or high density of `FUN_`/`DAT_`/`PTR_` prefixes) called before `checkLines()` runs any rules.

---

### stats getting zeroed

Found it. There's a 5-second flush interval on line 6068 — so stats should survive crashes. But the key question is what happens when mcp-registration.js is hot-reloaded on save. The setInterval from the old module instance keeps running against the old lifetimeStats object, then the new module instance starts fresh with a new makeEmptyLifetime() and a new loadLifetimeStats() call.
The problem is the 5-second window. If you save mcp-registration.js within 5 seconds of the last flush — which is almost always the case when doing rapid edits — the interval from the old instance hasn't fired yet, the new instance loads from disk (which has stale data), and the in-session counts from the old instance are lost.
The fix is simple: flush synchronously before the module unloads. That means calling syncToLifetime() + a sync writeFileSync (not async) in the module cleanup path, triggered when the server restarts. Let me check where restartServer is:


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
- Never use `$1`/`$2` in replace-all replacement strings — not backreferences
- `functionHint` never on .md files — use lineHint or afterHint instead
- `grep-file` before str_replace on any file to confirm exact anchor text and line numbers
