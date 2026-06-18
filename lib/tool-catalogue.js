'use babel';

// ---------------------------------------------------------------------------
// Tool catalogue — single source of truth for tool discovery + enable-group.
// Consumed by mcp-registration.js (list-tools, enable-group handlers)
// and pulsar-edit-mcp-server.js (stats panel, group toggle UI).
// ---------------------------------------------------------------------------
const TOOL_CATALOGUE = [
  // Core (always on)
  { name: "get-document",            group: "core",        desc: "Return all lines of the active editor with 1-based line numbers." },
  { name: "get-line-count",          group: "core",        desc: "Return the total line count of the active editor." },
  { name: "get-filename",            group: "core",        desc: "Return the filename of the active editor." },
  { name: "get-full-path",           group: "core",        desc: "Return the full absolute path of the active editor." },
  { name: "save-file",               group: "core",        desc: "Save the active editor to disk." },
  { name: "save-all",                group: "core",        desc: "Save all modified open editor tabs." },
  { name: "get-file-summary",        group: "core",        desc: "Structural summary of a file: functions, includes, defines, TODOs." },
  { name: "list-tools",              group: "core",        desc: "List all tools with their group and enabled/disabled status." },
  // Edit
  { name: "str_replace",             group: "edit",        desc: "Replace old_str with new_str. DECISION: know the function name? \u2192 inFunction. Know nearby unique text? \u2192 afterString or betweenHint. Have a line number? \u2192 afterLine:N (positional, 25-line window downward) or beforeLine:N (25-line window upward). Same pattern appears N times? \u2192 occurrence:N. String anchors work for unstructured files (markdown, config) too -- e.g. afterString:'## Installation' scopes an edit to under that heading, betweenHint:{start:'## Config',end:'## Usage'} restricts to that section. " +
    "Whitespace/indent mismatch? \u2192 fuzzyWhitespace:true. Smart-quotes/NBSP/BOM/box-drawing chars? \u2192 fuzzyContent:true (normalises encoding variants of known chars). " +
    "Unknown unicode, emoji, backticks, pipes, or variable-length char runs you can't reproduce exactly? \u2192 regex:true and wildcard over them (e.g. old_str: '// [\\u2500-\\u257F]+ text [\\u2500-\\u257F]+' or '.+emoji.+'). " +
    "Unsure of match? \u2192 dryRun:true first. RESPONSE: \u2705 str_replace \u2014 line N, \u00b1M lines [tags]. Tags: fuzzyWhitespace/fuzzyContent/regex when used. Followed by \u26a0\ufe0f style/lint warnings \u2014 act on them immediately." },
  { name: "insert",                  group: "edit",        desc: "Insert new lines into the active editor without touching existing content. Use afterFunction/beforeFunction (relative to a named function — drift-immune) or afterString/beforeString (relative to a unique line of text). functionEnd inserts after a named function's closing brace. dryRun previews position before writing. String anchors work for unstructured files (markdown, config): afterString:'## Installation' inserts after that heading, beforeString:'## Usage' inserts before it. RESPONSE: ✅ insert — line N, +M lines [scopeLabel]. Followed by ⚠️ style/lint warnings if any issues in the inserted region." },
  { name: "replace-document",        group: "edit",        desc: "Replace the entire editor contents with new text. Use for full-file rewrites only. RESPONSE: ✅ replace-document — N lines. No per-region lint (whole file); run get-diagnostics after if needed." },
  { name: "delete-line",             group: "edit",        desc: "DEPRECATED — use delete-line-range. Delete a single line." },
  { name: "delete-line-range",       group: "edit",        desc: "Delete a contiguous block of lines. inFunction deletes the entire named function body. betweenHint:{start,end} resolves both boundaries from content anchors. afterString resolves the start line from content. dryRun previews what will be removed. RESPONSE: ✅ delete-line-range — line N, -M lines [tags]. Followed by ⚠️ lint: if linter fires near the deletion point." },
  { name: "delete-block",            group: "edit",        desc: "Delete lines between two content anchor strings (both inclusive). sectionHint deletes a named section banner block; preprocBlock deletes a #ifdef...#endif pair by macro name. dryRun previews before committing. RESPONSE: ✅ delete-block — line N, -M lines [tags]. Followed by ⚠️ lint: if linter fires near the deletion point." },
  { name: "replace-block",           group: "edit",        desc: "Replace a brace-delimited { } block found by an anchor string — for if/while/for/switch/struct blocks that are NOT named functions (use replace-function-body for functions). Anchor string identifies the line, brace-matching finds the closing }. occurrence:N, inFunction scope, dryRun supported. RESPONSE: ✅ replace-block — line N, ±M lines. Followed by ⚠️ style/lint warnings if any." },
  { name: "get-region",              group: "edit",        desc: "Read lines between two content anchor strings without needing line numbers. Use before str_replace to verify what's in a section — immune to line drift. occurrence:N targets the Nth match of startContent." },
  { name: "get-selection",           group: "edit",        desc: "Return the currently selected text and its line/col range." },
  { name: "replace-all",             group: "edit",        desc: "Replace ALL occurrences of a string or regex across the entire file. When regex:true, replacement supports $1/$2/$& (positional) and $<name> (named capture groups, e.g. $<year>) backreferences (same as VS Code find/replace). Use dryRun:true first to see match count and locations before committing. RESPONSE: replace-all -- N occurrence(s) of 'query'. Followed by style/lint warnings if any." },
  { name: "sed",                     group: "edit",        desc: "sed-style pattern-based editing on the active buffer — no line numbers needed. expression is a s/pattern/replacement/flags string. dryRun:true previews matches. RESPONSE: ✅ sed — N match(es) [scope]. Change summary shown as nudge. Followed by ⚠️ lint: if linter fires after the edit." },
  { name: "get-structural-anchors",  group: "edit",        desc: "List section banners (sectionHint), #ifdef blocks (preprocBlock), and function end boundaries (functionEnd) in the active file. Call this before insert or delete-block when you need an anchor name to use." },
  // FileOps
  { name: "get-project-files",       group: "fileOps",     desc: "List all files under project roots, optionally filtered by glob. Use to discover file paths before read-lines or grep-file." },
  { name: "read-file",               group: "fileOps",     desc: "Read an entire file with 1-based line numbers. Expensive on large files — prefer read-lines (sections) or grep-file (search) when you don't need the whole file." },
  { name: "replace-function-body",   group: "fileOps",     desc: "Replace a named function's entire signature + body atomically. PREFERRED over str_replace for whole-function rewrites — no risk of partial match or line shift. Use afterString/afterLine/occurrence to disambiguate if the name appears in multiple places. dryRun previews. RESPONSE: ✅ replace-function-body — line N, ±M lines \"fnName\". Followed by ⚠️ style/lint warnings — act on these before your next edit." },
  { name: "replace-across-files",    group: "fileOps",     desc: "Find and replace across all project files. When regex:true, replacement supports $1/$2/$& (positional) and $<name> (named capture groups) backreferences (same as VS Code find/replace). First call without confirm returns a preview. Call again with confirm:true to commit. All writes go through the Pulsar buffer (undo history preserved, no direct disk writes). maxMatches cap (default 50) prevents accidental mass edits." },
  { name: "create-file",             group: "fileOps",     desc: "Create a new file and open it in the editor." },
  { name: "move-file",               group: "fileOps",     desc: "Move (or rename) a file from sourcePath to destPath. Open tabs are retargeted automatically." },
  { name: "copy-file",               group: "fileOps",     desc: "Copy a file to a new path and open the copy in a new tab." },
  { name: "rename-file",             group: "fileOps",     desc: "Rename a file within its current directory." },
  { name: "create-folder",           group: "fileOps",     desc: "Create a directory (and any missing parents)." },
  { name: "rename-folder",           group: "fileOps",     desc: "Rename or move a folder. All open tabs inside are retargeted to the new paths." },
  { name: "get-includes-and-defines",group: "fileOps",     desc: "Return all #include and #define lines with line numbers from a C/C++ file." },
  { name: "list-project-functions",  group: "fileOps",     desc: "List every function definition with line numbers across all project files. Use to find where a function is defined before read-lines or replace-function-body." },
  { name: "read-lines",              group: "fileOps",     desc: "Read a section of any file without opening it. PREFERRED over read-file for large files. DECISION: know function name? \u2192 inFunction. Know line number? \u2192 nearLine or startLine+endLine. Know surrounding text? \u2192 afterString or betweenHint:{start,end}. Want a window around a line? \u2192 centerLine+radius." },
  { name: "file-line-count",         group: "fileOps",     desc: "Return a file's line count without loading content. Use before read-file to decide whether to use read-lines instead." },
  { name: "apply-patch",             group: "edit",     desc: "Apply a unified diff patch to the active editor. Context-anchored so it survives line shifts. Use for large multi-location edits where str_replace would require many calls. RESPONSE: ✅ apply-patch — linesAdded/linesRemoved, N hunks [rescued if fuzzy rescue used]. Followed by ⚠️ style/lint warnings if any." },
  // Debugging
  { name: "get-debug-log",           group: "debugging",   desc: "Return recent debug log entries from MCP tool calls. Supports tail (default 20), filter by keyword, and clear." },
  { name: "get-edit-stats",          group: "debugging",   desc: "Return per-tool edit statistics for the current session and lifetime totals. Edit tools (str_replace, insert, delete-*, replace-*, apply-patch, sed) report hits/fails. Search tools (grep-file, grep-project, search-symbol, find-text) report hits/misses separately — a miss is not a failure. Summary lines are split: sessionEditSummary + sessionSearchSummary. Pass reset:true to flush session into lifetime and zero session counters." },
  { name: "session-notes",           group: "debugging",   desc: "Persistent cross-session notes written by the LLM. Stored as NDJSON (one record per line). action:write appends a note (first line = title, optional ## heading = section, rest = items). action:read retrieves notes grouped by title with ### sections; tail:N limits to last N records. action:edit replaces a record in-place by index (0-based), preserving timestamp. action:delete removes a record by index. action:clear wipes all notes. Read output shows [absIdx] on each record for edit/delete targeting. Notes survive server restarts." },
  { name: "get-failure-log",         group: "debugging",   desc: "Query the persistent fault log (session/session-faults.ndjson). Returns structured JSON entries. Filter by tool (e.g. 'str_replace'), reason (e.g. 'noMatch'), or filePath substring. tail:N limits output (default 20). Faster than PowerShell for diagnosing recurring failure patterns." },
  { name: "checkpatch",              group: "debugging",   desc: "Run Linux kernel style checks against the active file (or any .c/.h file). Returns all violations grouped by rule with line numbers. Use to audit an existing file before or after editing." },
  { name: "check-struct",            group: "debugging",   desc: "Snapshot the structural integrity of the active file (or any brace-delimited source file: .c .h .js .ts .cpp .java .go .rs etc). Reports absolute brace balance, unclosed block comments, and #if/#endif depth. Unlike the edit-response struct check (delta only), this is a point-in-time absolute read -- use for a quick sanity check without making an edit." },
  // Navigation
  { name: "open-file",               group: "navigation",  desc: "Open or switch to a file in an editor tab." },
  { name: "goto-line",               group: "navigation",  desc: "Jump the cursor to a line number in the active editor." },
  { name: "list-open-files",         group: "navigation",  desc: "List all files currently open in editor tabs." },
  { name: "get-active-editor-info",  group: "navigation",  desc: "Quick metadata check: filename, line count, cursor, language." },
  // Safety
  { name: "undo",                    group: "safety",      desc: "Undo the last change in the active editor." },
  { name: "redo",                    group: "safety",      desc: "Redo the last undone change." },
  { name: "diff-preview",            group: "safety",      desc: "Show a unified diff of proposed changes without applying them." },
  { name: "checkpoint",              group: "safety",      desc: "Save a named in-memory snapshot of the current buffer. Cleared on server restart — saving MCP server source files triggers a restart and wipes all checkpoints." },
  { name: "restore-checkpoint",      group: "safety",      desc: "Restore the buffer to a named checkpoint." },
  { name: "list-checkpoints",        group: "safety",      desc: "List all saved in-memory checkpoints." },
  // Search
  { name: "grep-file",               group: "search",      desc: "Search a single file for a string or regex, return matching lines with 1-based line numbers. Use contextLines:N to see N lines before/after each match (like grep -C). Use occurrence:N to get only the Nth match with its context — ideal for locating a specific instance before editing. Cheaper than read-file + manual scan." },
  { name: "grep-project",            group: "search",      desc: "Search all project files for a string or regex. Returns file path + line number for every match. Use to find where a symbol, pattern, or string is defined or used across the codebase." },
  { name: "search-symbol",           group: "search",      desc: "Find all uses of a C/C++ symbol with whole-word matching \u2014 won't match substrings. Use instead of grep-file when searching for a variable or function name to avoid partial matches. Supports contextLines and occurrence:N." },
  { name: "find-text",               group: "search",      desc: "Find all occurrences of a string or regex in the active editor. Returns line numbers and totalMatches count. Use occurrence:N to get the exact line of a specific instance (pass to str_replace afterLine). Use contextLines:N to see surrounding code. caseSensitive defaults to false." },
  // Diagnostics
  { name: "get-compiler-diagnostics", group: "diagnostics", desc: "Syntax-check the active C/C++ file with gcc/clang/cl (runs compiler on disk — always save-file first)." },
  { name: "get-diagnostics",          group: "diagnostics", desc: "Return live linter diagnostics (errors, warnings, info) from linter-bundle. Live on buffer — no save needed." },
  // Highlight
  { name: "highlight-range",         group: "highlight",   desc: "Visually highlight a line range in the editor." },
  // Ghidra RE tools
  { name: "list-functions",                   group: "ghidra", desc: "List all function definitions in the active Ghidra-decompiled C file (FUN_/sub_ names and standard C)." },
  { name: "search-functions",                 group: "ghidra", desc: "Find functions whose name matches a query string or regex. Returns name, line, signature." },
  { name: "get-function-body",                group: "ghidra", desc: "Extract complete source of a named function. Supports inFunction and occurrence:N for disambiguation." },
  { name: "get-xrefs",                        group: "ghidra", desc: "Find all call sites of a named function in the active file." },
  { name: "add-comment",                      group: "ghidra", desc: "Insert a block comment above a named function or at a specific line. Supports inFunction and occurrence:N." },
  { name: "get-function-list-with-comments",  group: "ghidra", desc: "List all functions with any existing comments — shows RE annotation progress at a glance." },
  // Naming checker — kernel C only
  { name: "namingcheck",         group: "fileOps", desc: "Check a kernel C file for naming violations: function verb-tier, camelCase, macro ALL_CAPS. Returns violations with line numbers. Kernel .c/.h files only." },
  { name: "check-function-docs", group: "fileOps", desc: "Check that every non-static function in a kernel C file has a kernel-doc /** */ comment above it. Flags: missing docs, // comments (wrong style), plain /* */ (advisory — not extracted by kernel-doc tool). Kernel .c/.h files only." },
  { name: "insert-function-doc", group: "edit",    desc: "Insert a kernel-doc /** */ skeleton above a named function: function_name() - desc, @param:, Context:, Return: sections. Parses parameter names from the signature; handles variadic @... args. Accepts optional line: (1-based, from check-function-docs) for precise anchor — falls back to file scan. Kernel .c/.h files only." },
];

// Groups that can be toggled (core is always on)
const TOGGLEABLE_GROUPS = ["edit", "fileOps", "navigation", "safety", "search", "diagnostics", "highlight", "debugging", "ghidra"];

module.exports = { TOOL_CATALOGUE, TOGGLEABLE_GROUPS };
