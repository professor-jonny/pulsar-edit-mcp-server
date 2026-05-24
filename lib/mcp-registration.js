'use babel';
import fs from "fs";
import path from "path";
import { z } from "zod";
import { applyPatch, diffLines } from "diff";
import { exec as _exec } from "child_process";

// ---------------------------------------------------------------------------
// Platform helper: pick the right shell for run-command
// ---------------------------------------------------------------------------
const IS_WINDOWS = process.platform === "win32";
function getShell() {
  if (IS_WINDOWS) return { shell: "powershell.exe", flag: "-Command" };
  return { shell: "/bin/sh", flag: "-c" };
}
import { CompositeDisposable, Disposable } from "atom";

const packageDisposables = new CompositeDisposable();
const activeHighlightSets = [];

// ---------------------------------------------------------------------------
// Per-tool write-failure counters — module scope, survive across tool calls,
// reset on server restart. Each mutating tool increments its counter on a
// no-match / error, resets it on success. High counts are surfaced in error
// responses so the LLM knows to try a different strategy.
// ---------------------------------------------------------------------------
const patchFailures    = { count: 0 };  // apply-patch  (consecutive, for tool-switch hint)
const strReplFailures  = { count: 0 };  // str_replace  (consecutive, for tool-switch hint)
const insertFailures   = { count: 0 };  // insert       (consecutive, for tool-switch hint)
const deleteFailures   = { count: 0 };  // delete-line-range (consecutive, for tool-switch hint)

// ---------------------------------------------------------------------------
// Edit statistics accumulator — persists for the session lifetime, queryable
// by the LLM via get-edit-stats. Tracks per-tool hits, fail reasons, hint
// usage, dry-run count, and rolling average old_str line count.
// ---------------------------------------------------------------------------
const editStats = {
  str_replace: {
    hits: 0,
    fails: {
      noMatch:         0,  // old_str not found anywhere in search region
      whitespace:      0,  // content matches but indentation differs
      partialMatch:    0,  // N of M lines matched then diverged
      outOfScope:      0,  // functionHint / betweenHint target not found
      afterNotFound:   0,  // afterHint anchor not found
      wrongOccurrence: 0,  // requested occurrence N > occurrencesFound
    },
    hintsUsed: {
      functionHint: 0,
      lineHint:     0,
      afterHint:    0,
      betweenHint:  0,
      occurrence:   0,
    },
    fuzzyWhitespaceCommits: 0,
    dryRuns:       0,
    _oldStrLenSum: 0,   // internal — used to compute avgOldStrLines on read
  },
  insert: {
    hits: 0,
    fails: { outOfRange: 0 },
    dryRuns: 0,
  },
  delete_line_range: {
    hits: 0,
    fails: { outOfRange: 0, inverted: 0 },
    dryRuns: 0,
  },
  replace_function_body: {
    hits: 0,
    fails: { notFound: 0 },
    dryRuns: 0,
  },
  replace_block: {
    hits: 0,
    fails: { anchorNotFound: 0, braceMatchFailed: 0 },
    dryRuns: 0,
  },
  apply_patch: {
    hits: 0,
    fails: { contextMismatch: 0, exception: 0 },
    largeEditWarnings: 0,
    dryRuns: 0,
  },
  replace_all: {
    hits: 0,
    fails: { noMatch: 0 },
    dryRuns: 0,
  },
};

function failureSuggestion(counter, toolName) {
  if (counter.count < 3) return "";
  const alts = {
    "str_replace":       "replace-function-body (whole function) or replace-document (full file)",
    "insert":            "str_replace to anchor by content instead of line number",
    "delete-line-range": "str_replace to remove a block by content instead of line number",
    "apply-patch":       "str_replace for targeted edits or replace-function-body for whole-function rewrites"
  };
  const alt = alts[toolName] || "a different editing tool";
  return `\n🔁 ${counter.count} consecutive failures on ${toolName} — consider switching to ${alt}.`;
}

// ---------------------------------------------------------------------------
// Debug log ring buffer — capped at 100 entries, survives across tool calls
// ---------------------------------------------------------------------------
const DEBUG_LOG_MAX = 100;
const debugLog = [];
function dbg(toolName, msg, data) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const entry = data !== undefined
    ? `[${ts}] [${toolName}] ${msg} ${JSON.stringify(data)}`
    : `[${ts}] [${toolName}] ${msg}`;
  if (debugLog.length >= DEBUG_LOG_MAX) debugLog.shift();
  debugLog.push(entry);
  console.log(entry);
}

// ---------------------------------------------------------------------------
// Helper: escape a plain string for use inside a RegExp
// ---------------------------------------------------------------------------
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Helper: walk a directory tree, skipping common noise dirs
// ---------------------------------------------------------------------------
async function walkDir(dir, files = []) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", ".hg", ".svn", "dist", "build"].includes(entry.name)) continue;
      await walkDir(full, files);
    } else {
      files.push(full);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Helper: compile a glob pattern to a RegExp (supports ** and *)
// ---------------------------------------------------------------------------
function expandBraces(pattern) {
  const m = pattern.match(/^(.*?)\{([^{}]+)\}(.*)$/);
  if (!m) return [pattern];
  return m[2].split(",").flatMap(alt => expandBraces(m[1] + alt.trim() + m[3]));
}

function globToRegex(glob) {
  const alts = expandBraces(glob);
  const toRe = g => g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DS__")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/__DS__/g, ".*");
  const parts = alts.map(toRe);
  return new RegExp("^(" + parts.join("|") + ")$", "i");
}

// ---------------------------------------------------------------------------
// Helper: find a named function in a buffer, returns { startRow, endRow } or null
// ---------------------------------------------------------------------------
function findFunctionInBuffer(buffer, name) {
  const lines = buffer.getLines();
  const sigRe = new RegExp("(?:^|\\s)" + escapeRegex(name) + "\\s*\\(");
  let startRow = -1;

  for (let i = 0; i < lines.length; i++) {
    if (sigRe.test(lines[i]) && !lines[i].trim().startsWith("//") && !lines[i].trim().startsWith("*")) {
      let hasBrace = false;
      for (let j = i; j < Math.min(i + 6, lines.length); j++) {
        if (lines[j].includes("{")) { hasBrace = true; break; }
        if (j > i && lines[j].includes(";")) break;
      }
      if (hasBrace) { startRow = i; break; }
    }
  }

  if (startRow === -1) return null;

  let depth = 0;
  let endRow = -1;
  for (let i = startRow; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { endRow = i; break; } }
    }
    if (endRow !== -1) break;
  }

  return endRow === -1 ? null : { startRow, endRow };
}

// ---------------------------------------------------------------------------
// Helper: read a file's text — prefer the live buffer if the file is open
// in Pulsar, fall back to disk otherwise. Ensures unsaved edits are always
// visible to read/search tools without requiring a save-file first.
// ---------------------------------------------------------------------------
async function readFileOrBuffer(filePath) {
  const openEditor = atom.workspace.getTextEditors()
    .find(e => e.getPath() && path.resolve(e.getPath()) === path.resolve(filePath));
  if (openEditor) return openEditor.getBuffer().getText();
  return fs.promises.readFile(filePath, "utf8");
}

// ---------------------------------------------------------------------------
// Helper: move an open editor to a new path in-place, preserving undo history.
// Uses buffer.setPath() if available (Pulsar/Atom TextBuffer API); falls back
// to destroy + open + setText so unsaved edits are at least not lost.
// Returns the editor at the new path.
// ---------------------------------------------------------------------------
async function retargetEditor(editor, newPath) {
  const buffer = editor.getBuffer();
  if (typeof buffer.setPath === "function") {
    // Best case: retarget in-place — undo history fully preserved
    buffer.setPath(newPath);
    return editor;
  }
  // Fallback: snapshot dirty content, destroy, reopen, restore
  const bufferText = buffer.getText();
  const isModified = editor.isModified();
  await editor.destroy();
  const newEditor = await atom.workspace.open(newPath);
  if (isModified) newEditor.getBuffer().setText(bufferText);
  return newEditor;
}

// ---------------------------------------------------------------------------
// Tool catalogue — single source of truth for discovery + enable-group
// ---------------------------------------------------------------------------
export const TOOL_CATALOGUE = [
  // Core (always on)
  { name: "get-document",            group: "core",        desc: "Return all lines of the active editor with 1-based line numbers." },
  { name: "get-line-count",          group: "core",        desc: "Return the total line count of the active editor." },
  { name: "get-filename",            group: "core",        desc: "Return the filename of the active editor." },
  { name: "get-full-path",           group: "core",        desc: "Return the full absolute path of the active editor." },
  { name: "save-file",               group: "core",        desc: "Save the active editor to disk." },
  { name: "save-all",                group: "core",        desc: "Save all modified open editor tabs." },
  { name: "get-file-summary",        group: "core",        desc: "Structural summary of a file: functions, includes, defines, TODOs." },
  { name: "list-tools",              group: "core",        desc: "List all tools with their group and enabled/disabled status." },
  { name: "enable-group",            group: "core",        desc: "Enable a disabled tool group at runtime without reloading Pulsar." },
  // Edit
  { name: "str_replace",             group: "edit",        desc: "Replace old_str with new_str. Supports functionHint, lineHint, afterHint (P2), betweenHint (P4), occurrence:N (P1), fuzzyWhitespace (P3), dryRun." },
  { name: "get-context-around",      group: "edit",        desc: "Return lines around the Nth match of a query." },
  { name: "find-text",               group: "edit",        desc: "Find all positions of a string/regex in the active editor." },
  { name: "replace-document",        group: "edit",        desc: "Replace the entire editor contents with new text." },
  { name: "insert",                  group: "edit",        desc: "Insert lines before a line number or after/before a content anchor (P5). Supports dryRun." },
  { name: "delete-line",             group: "edit",        desc: "DEPRECATED — use delete-line-range. Delete a single line." },
  { name: "delete-line-range",       group: "edit",        desc: "Delete a range of lines (inclusive). Supports dryRun." },
  { name: "delete-block",            group: "edit",        desc: "Delete lines between two content anchors — content-stable equivalent of delete-line-range (P6). Supports dryRun." },
  { name: "replace-block",           group: "edit",        desc: "Brace-matched block replace anchored by any content string — generalised replace-function-body for non-function blocks (P7). Supports dryRun." },
  { name: "get-region",              group: "edit",        desc: "Return lines between two content anchor strings — content-stable equivalent of read-lines (P8)." },
  { name: "get-selection",           group: "edit",        desc: "Return the currently selected text and its line/col range." },
  { name: "replace-all",             group: "edit",        desc: "Replace ALL occurrences of a string in the active editor." },
  // FileOps
  { name: "get-project-files",       group: "fileOps",     desc: "List all files under project roots, optionally filtered by glob." },
  { name: "read-file",               group: "fileOps",     desc: "Read any project file by path with 1-based line numbers." },
  { name: "run-command",             group: "fileOps",     desc: "Execute a shell command and return stdout/stderr/exit code." },
  { name: "replace-across-files",    group: "fileOps",     desc: "Find and replace across all project files (supports dry-run)." },
  { name: "replace-function-body",   group: "fileOps",     desc: "Atomically replace a named function's signature and body." },
  { name: "create-file",             group: "fileOps",     desc: "Create a new file at a path and open it in the editor." },
  { name: "move-file",               group: "fileOps",     desc: "Move (or rename) a file from sourcePath to destPath. Retargets the open tab in-place — undo history preserved." },
  { name: "copy-file",               group: "fileOps",     desc: "Copy a file from sourcePath to destPath. Opens the copy in a new tab." },
  { name: "rename-file",             group: "fileOps",     desc: "Rename a file in-place (same directory). Alias for move-file with the same parent folder." },
  { name: "create-folder",           group: "fileOps",     desc: "Create a directory (and any missing parents) at the given path." },
  { name: "rename-folder",           group: "fileOps",     desc: "Rename / move a folder. All open tabs inside are retargeted to new paths — undo history preserved." },
  { name: "get-includes-and-defines",group: "fileOps",     desc: "Return all #include/#define lines from a C/C++ file." },
  { name: "list-project-functions",  group: "fileOps",     desc: "List every function definition across all project files." },
  { name: "read-lines",              group: "fileOps",     desc: "Read a line range from any file without opening it." },
  { name: "file-line-count",         group: "fileOps",     desc: "Return the line count of any file without loading it." },
  { name: "apply-patch",             group: "fileOps",     desc: "Apply a unified diff patch to the active editor. Context-anchored — survives line shifts. Tracks failure count and suggests alternatives after repeated failures." },
  // Debugging
  { name: "get-debug-log",           group: "debugging",   desc: "Return recent debug log entries from MCP tool calls. Supports tail (default 20), filter by keyword, and clear." },
  { name: "get-edit-stats",          group: "debugging",   desc: "Return per-tool edit statistics for the current session: hits, fail reasons, hint usage, dry-run count, fuzzy-whitespace commits. Pass reset:true to zero all counters after reading." },
  { name: "session-notes",           group: "debugging",   desc: "Persistent cross-session notes written by the LLM. action:write appends a note (what failed, what worked, lessons learned). action:read retrieves past notes at session start. action:clear wipes all notes. Notes survive server restarts." },
  // Navigation
  { name: "open-file",               group: "navigation",  desc: "Open or switch to a file in an editor tab." },
  { name: "goto-line",               group: "navigation",  desc: "Jump the cursor to a line number in the active editor." },
  { name: "list-open-files",         group: "navigation",  desc: "List all files currently open in editor tabs." },
  { name: "get-active-editor-info",  group: "navigation",  desc: "Quick metadata check: filename, line count, cursor, language." },
  { name: "get-surrounding-context", group: "navigation",  desc: "Return lines around a target line without loading the whole file." },
  // Safety
  { name: "undo",                    group: "safety",      desc: "Undo the last change in the active editor." },
  { name: "redo",                    group: "safety",      desc: "Redo the last undone change." },
  { name: "diff-preview",            group: "safety",      desc: "Show a unified diff of proposed changes without applying them." },
  { name: "checkpoint",              group: "safety",      desc: "Save a named in-memory snapshot of the current buffer. Cleared on server restart — saving MCP server source files triggers a restart and wipes all checkpoints." },
  { name: "restore-checkpoint",      group: "safety",      desc: "Restore the buffer to a named checkpoint." },
  { name: "list-checkpoints",        group: "safety",      desc: "List all saved in-memory checkpoints." },
  // Search
  { name: "grep-file",               group: "search",      desc: "Search a file for a pattern, return matching lines." },
  { name: "grep-project",            group: "search",      desc: "Search all project files for a pattern." },
  { name: "search-symbol",           group: "search",      desc: "Find all uses of a C symbol with whole-word matching." },
  // Diagnostics
  { name: "get-diagnostics",         group: "diagnostics", desc: "Syntax-check the active C/C++ file with gcc/clang/cl." },
  // Highlight
  { name: "highlight-range",         group: "highlight",   desc: "Visually highlight a line range in the editor." },
  // Ghidra (registered separately)
  { name: "ghidra:*",                group: "ghidra",      desc: "All Ghidra reverse-engineering tools (connect, disasm, debug, etc)." },
];

// Groups that can be toggled (core is always on)
export const TOGGLEABLE_GROUPS = ["edit", "fileOps", "navigation", "safety", "search", "diagnostics", "highlight", "debugging", "ghidra"];

export function mcpRegistration(server, linterRegistry = null, getMessages = null, groups = {}) {
  // Helper: returns true when a group is enabled (default: true)
  const g = (name) => groups[name] !== false;

  // ── EDIT GROUP ────────────────────────────────────────────────────────────
  if (g('edit')) {
  {
    const curTool = "str_replace";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "String Replace",
        description: [
          "Replace the first occurrence of `old_str` with `new_str` in the active editor.",
          "Supports multi-line old_str — the exact text (including newlines and indentation) must match the buffer. Whitespace differences are the most common cause of failure; the error response will flag them explicitly.",
          "Use `functionHint` (function name) to scope the search to within that function body only — the match is rejected if old_str is not found inside that function. Immune to line number drift, preferred for JS/C code.",
          "Use `lineHint` (1-based line number) to start the search at or after a specific line — useful when the same block appears multiple times and functionHint is not applicable.",
          "Use `afterHint` (content string) to start the search after the first occurrence of that string in the file — content-stable equivalent of lineHint, immune to line number drift.",
          "Use `betweenHint: { start, end }` to restrict the search to the region between two anchor strings — more precise than afterHint alone, useful for switch cases, struct blocks, #ifdef regions.",
          "Use `occurrence: N` to replace the Nth match instead of the first — useful when the same short pattern appears multiple times and no function boundary exists.",
          "Set `fuzzyWhitespace: true` to match ignoring leading/trailing whitespace per line — when exact match fails but trimmed content matches, the replacement is applied using the buffer's actual indentation. Eliminates the retry for whitespace-only mismatches.",
          "Without any hint replaces the first match in the file.",
          "For replacing ALL occurrences use replace-all instead. For a full file rewrite use replace-document.",
          "Set `dryRun:true` to preview the match without writing — responds with the matched text and surrounding context so you can confirm before committing. Reply with the same call without dryRun (or dryRun:false) to commit.",
          "Tracks consecutive no-match failures and surfaces a tool-switch suggestion after 3 failures."
        ].join(" "),
        inputSchema: {
          old_str:        z.string(),
          new_str:        z.string(),
          functionHint:   z.string().optional(),
          lineHint:       z.number().optional(),
          afterHint:      z.string().optional(),
          betweenHint:    z.object({ start: z.string(), end: z.string() }).optional(),
          occurrence:     z.number().int().min(1).optional(),
          fuzzyWhitespace: z.boolean().optional(),
          dryRun:         z.boolean().optional()
        }
      },
      async ({ old_str, new_str, functionHint, lineHint, afterHint, betweenHint, occurrence = 1, fuzzyWhitespace = false, dryRun = false }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { old_str: old_str.substring(0, 80), new_str: new_str.substring(0, 80), functionHint, lineHint, afterHint, betweenHint, occurrence, fuzzyWhitespace, dryRun });

        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer = editor.getBuffer();
        const text   = buffer.getText();
        const allLines = buffer.getLines();

        // ── Resolve search bounds ─────────────────────────────────────────────
        // Priority: functionHint > betweenHint > afterHint > lineHint > entire file
        let searchStart = 0;
        let searchEnd   = text.length;
        let scopeLabel  = "";

        if (functionHint) {
          const fn = findFunctionInBuffer(buffer, functionHint);
          if (!fn) {
            const fnRe = /^(?:(?:static|inline|extern|const|unsigned|signed|struct|enum|function)\s+)*[\w\s*]+\b(\w+)\s*\(/;
            const knownFns = allLines
              .map((l, i) => ({ l, i }))
              .filter(({ l }) => !l.trim().startsWith("//") && fnRe.test(l))
              .map(({ l, i }) => `  ${i + 1}: ${l.trim()}`);
            strReplFailures.count++;
            editStats.str_replace.fails.outOfScope++;
            return {
              content: [{ type: "text", text: [
                `❌ functionHint: function "${functionHint}" not found in active editor.`,
                `Functions detected:\n${knownFns.slice(0, 20).join("\n") || "  (none)"}`,
                failureSuggestion(strReplFailures, curTool)
              ].filter(Boolean).join("\n") }],
              matched: false
            };
          }
          searchStart = buffer.characterIndexForPosition([fn.startRow, 0]);
          searchEnd   = buffer.characterIndexForPosition([fn.endRow + 1, 0]);
          scopeLabel  = ` within function "${functionHint}" (lines ${fn.startRow + 1}–${fn.endRow + 1})`;
        } else if (betweenHint) {
          // P4: scope to between two anchor strings
          const startIdx = text.indexOf(betweenHint.start);
          if (startIdx === -1) {
            strReplFailures.count++;
            editStats.str_replace.fails.outOfScope++;
            return {
              content: [{ type: "text", text: [
                `❌ betweenHint.start "${betweenHint.start}" not found in file.`,
                failureSuggestion(strReplFailures, curTool)
              ].filter(Boolean).join("\n") }],
              matched: false
            };
          }
          const endIdx = text.indexOf(betweenHint.end, startIdx + betweenHint.start.length);
          if (endIdx === -1) {
            strReplFailures.count++;
            editStats.str_replace.fails.outOfScope++;
            return {
              content: [{ type: "text", text: [
                `❌ betweenHint.end "${betweenHint.end}" not found after start anchor.`,
                failureSuggestion(strReplFailures, curTool)
              ].filter(Boolean).join("\n") }],
              matched: false
            };
          }
          searchStart = startIdx;
          searchEnd   = endIdx + betweenHint.end.length;
          const startLine = text.substring(0, startIdx).split("\n").length;
          const endLine   = text.substring(0, endIdx).split("\n").length;
          scopeLabel  = ` between "${betweenHint.start.substring(0, 30)}" and "${betweenHint.end.substring(0, 30)}" (lines ${startLine}–${endLine})`;
        } else if (afterHint) {
          // P2: start search after first occurrence of afterHint string
          const anchorIdx = text.indexOf(afterHint);
          if (anchorIdx === -1) {
            strReplFailures.count++;
            editStats.str_replace.fails.afterNotFound++;
            return {
              content: [{ type: "text", text: [
                `❌ afterHint "${afterHint}" not found in file — cannot anchor search.`,
                failureSuggestion(strReplFailures, curTool)
              ].filter(Boolean).join("\n") }],
              matched: false
            };
          }
          searchStart = anchorIdx + afterHint.length;
          const anchorLine = text.substring(0, anchorIdx).split("\n").length;
          scopeLabel  = ` after "${afterHint.substring(0, 40)}" (line ${anchorLine})`;
        } else if (lineHint) {
          searchStart = allLines.slice(0, lineHint - 1).reduce((s, l) => s + l.length + 1, 0);
          scopeLabel  = ` at or after line ${lineHint}`;
        }

        // ── Track hint usage ─────────────────────────────────────────────────
        if (functionHint) editStats.str_replace.hintsUsed.functionHint++;
        else if (betweenHint) editStats.str_replace.hintsUsed.betweenHint++;
        else if (afterHint) editStats.str_replace.hintsUsed.afterHint++;
        else if (lineHint) editStats.str_replace.hintsUsed.lineHint++;
        if (occurrence && occurrence > 1) editStats.str_replace.hintsUsed.occurrence++;

        // ── Fuzzy whitespace helper ───────────────────────────────────────────
        // P3: when fuzzyWhitespace:true, try trimmed-per-line match and rebuild
        // old_str using buffer's actual indentation before doing the real search.
        let effectiveOldStr = old_str;
        if (fuzzyWhitespace) {
          const searchText = text.substring(searchStart, searchEnd);
          const searchLines = searchText.split("\n");
          const needle = old_str.split("\n");
          let fuzzyMatchStart = -1;
          outer:
          for (let i = 0; i <= searchLines.length - needle.length; i++) {
            for (let j = 0; j < needle.length; j++) {
              if (searchLines[i + j].trim() !== needle[j].trim()) continue outer;
            }
            fuzzyMatchStart = i;
            break;
          }
          if (fuzzyMatchStart !== -1) {
            // Rebuild old_str using buffer's actual lines (preserves indentation)
            effectiveOldStr = searchLines.slice(fuzzyMatchStart, fuzzyMatchStart + needle.length).join("\n");
          }
          // If still no fuzzy match found, fall through to normal search (will fail and report)
        }

        // ── Locate the Nth match ──────────────────────────────────────────────
        const isMultiLine = effectiveOldStr.includes("\n");
        let matchIndex = -1;
        let matchLine  = -1; // 0-based
        let occurrencesFound = 0;

        if (isMultiLine) {
          let searchFrom = searchStart;
          while (searchFrom < searchEnd) {
            const idx = text.indexOf(effectiveOldStr, searchFrom);
            if (idx === -1 || idx >= searchEnd) break;
            occurrencesFound++;
            if (occurrencesFound === occurrence) {
              matchIndex = idx;
              matchLine  = text.substring(0, idx).split("\n").length - 1;
              break;
            }
            searchFrom = idx + 1;
          }
        } else {
          const startRow = lineHint ? Math.max(0, lineHint - 1) : 0;
          const fnStartRow = functionHint
            ? buffer.positionForCharacterIndex(searchStart).row
            : afterHint || betweenHint
              ? text.substring(0, searchStart).split("\n").length - 1
              : startRow;
          const fnEndRow = (functionHint || betweenHint)
            ? buffer.positionForCharacterIndex(searchEnd).row
            : allLines.length - 1;
          for (let i = Math.max(startRow, fnStartRow); i <= fnEndRow && i < allLines.length; i++) {
            if (allLines[i].includes(effectiveOldStr)) {
              occurrencesFound++;
              if (occurrencesFound === occurrence) {
                matchLine  = i;
                matchIndex = allLines.slice(0, i).reduce((s, l) => s + l.length + 1, 0) + allLines[i].indexOf(effectiveOldStr);
                break;
              }
            }
          }
        }

        // Report if requested occurrence doesn't exist
        if (matchIndex === -1 && occurrencesFound > 0 && occurrence > occurrencesFound) {
          strReplFailures.count++;
          editStats.str_replace.fails.wrongOccurrence++;
          return {
            content: [{ type: "text", text: [
              `❌ occurrence ${occurrence} requested but only ${occurrencesFound} match(es) found for old_str${scopeLabel}.`,
              failureSuggestion(strReplFailures, curTool)
            ].filter(Boolean).join("\n") }],
            matched: false,
            strReplFailures: strReplFailures.count
          };
        }

        // ── No match — smart failure diagnostics ──────────────────────────────
        if (matchIndex === -1) {
          strReplFailures.count++;
          const lines = old_str.split("\n");

          // Search region for diagnostics (respect all scope hints)
          const diagLines = (functionHint || betweenHint)
            ? allLines.slice(text.substring(0, searchStart).split("\n").length - 1, text.substring(0, searchEnd).split("\n").length)
            : allLines;
          const diagOffset = (functionHint || betweenHint)
            ? text.substring(0, searchStart).split("\n").length - 1
            : 0;

          // 1. Check for whitespace/indentation differences per line
          const wsIssues = [];
          for (let li = 0; li < lines.length; li++) {
            const trimmed = lines[li].trim();
            if (!trimmed) continue;
            const bufferHit = diagLines.findIndex(bl => bl.trim() === trimmed && bl !== lines[li]);
            if (bufferHit !== -1) {
              wsIssues.push({
                searchLine:  li + 1,
                searchText:  JSON.stringify(lines[li]),
                bufferLine:  bufferHit + diagOffset + 1,
                bufferText:  JSON.stringify(diagLines[bufferHit])
              });
            }
          }

          // 2. Find partial match — how many leading lines match consecutively
          let partialMatchLines = 0;
          if (lines.length > 1) {
            for (let start = 0; start < diagLines.length; start++) {
              let matched = 0;
              while (matched < lines.length && start + matched < diagLines.length && diagLines[start + matched] === lines[matched]) {
                matched++;
              }
              if (matched > partialMatchLines) partialMatchLines = matched;
            }
          }

          // ── Classify failure reason for stats ─────────────────────────────
          if (wsIssues.length > 0) {
            editStats.str_replace.fails.whitespace++;
          } else if (partialMatchLines > 0 && partialMatchLines < lines.length) {
            editStats.str_replace.fails.partialMatch++;
          } else {
            editStats.str_replace.fails.noMatch++;
          }

          // 3. Fuzzy word match — find the closest area in the search region
          const firstMeaningfulLine = lines.find(l => l.trim().length > 3) || lines[0];
          const words = firstMeaningfulLine.trim().split(/\s+/).filter(w => w.length > 3);
          let fuzzyRow = -1;
          if (words.length > 0) {
            let bestScore = 0;
            for (let i = 0; i < diagLines.length; i++) {
              const score = words.filter(w => diagLines[i].includes(w)).length;
              if (score > bestScore) { bestScore = score; fuzzyRow = i + diagOffset; }
            }
          }

          const contextRadius = 4;
          const ctxStart = fuzzyRow >= 0 ? Math.max(0, fuzzyRow - contextRadius) : 0;
          const ctxEnd   = fuzzyRow >= 0 ? Math.min(allLines.length - 1, fuzzyRow + contextRadius) : Math.min(7, allLines.length - 1);
          const contextLines = allLines.slice(ctxStart, ctxEnd + 1)
            .map((l, i) => `${String(ctxStart + i + 1).padStart(4)}: ${l}`).join("\n");

          const parts = [
            `❌ No match found for old_str${scopeLabel || (lineHint ? ` at or after line ${lineHint}` : "")}.`
          ];
          if (wsIssues.length > 0) {
            parts.push(`\n⚠️  WHITESPACE MISMATCH on ${wsIssues.length} line(s) — content matches but indentation differs:`);
            for (const w of wsIssues) {
              parts.push(`  search line ${w.searchLine}: ${w.searchText}`);
              parts.push(`  buffer line ${w.bufferLine}: ${w.bufferText}`);
            }
            parts.push("  → Fix indentation in old_str to match the buffer exactly, OR retry with fuzzyWhitespace:true to commit using buffer indentation.");
          }
          if (partialMatchLines > 0 && partialMatchLines < lines.length) {
            parts.push(`\n⚠️  PARTIAL MATCH: first ${partialMatchLines} of ${lines.length} lines matched consecutively, then diverged. Likely a trailing-whitespace or indentation difference on line ${partialMatchLines + 1}.`);
          }
          if (fuzzyRow >= 0) {
            parts.push(`\n📍 Closest area found (lines ${ctxStart + 1}–${ctxEnd + 1}):\n${contextLines}`);
          }
          const sugg = failureSuggestion(strReplFailures, curTool);
          if (sugg) parts.push(sugg);

          return {
            content: [{ type: "text", text: parts.join("\n") }],
            matched: false,
            strReplFailures: strReplFailures.count
          };
        }

        // ── Match found — dry-run or commit ───────────────────────────────────
        const surroundRadius = 3;
        const ctxStart = Math.max(0, matchLine - surroundRadius);
        const matchLines = effectiveOldStr.split("\n");
        const ctxEnd   = Math.min(allLines.length - 1, matchLine + matchLines.length - 1 + surroundRadius);

        if (dryRun) {
          editStats.str_replace.dryRuns++;
          const preview = allLines.slice(ctxStart, ctxEnd + 1)
            .map((l, i) => {
              const abs = ctxStart + i;
              const inMatch = abs >= matchLine && abs < matchLine + matchLines.length;
              return `${String(abs + 1).padStart(4)}${inMatch ? " ►" : "  "} ${l}`;
            }).join("\n");

          const diffLines = matchLines.map(l => `- ${l}`).concat(new_str.split("\n").map(l => `+ ${l}`)).join("\n");

          return {
            content: [{ type: "text", text: [
              `✅ DRY RUN — match found at line ${matchLine + 1}${scopeLabel}${occurrence > 1 ? ` (occurrence ${occurrence})` : ""}${fuzzyWhitespace ? " [fuzzyWhitespace]" : ""}.`,
              `\nContext (► = lines to be replaced):\n${preview}`,
              `\nProposed diff:\n${diffLines}`,
              `\nReply with the same call without dryRun (or dryRun:false) to commit.`
            ].join("\n") }],
            matched: true,
            dryRun: true,
            matchLine: matchLine + 1
          };
        }

        // Commit the replacement
        const endIndex  = matchIndex + effectiveOldStr.length;
        const startPos  = buffer.positionForCharacterIndex(matchIndex);
        const endPos    = buffer.positionForCharacterIndex(endIndex);
        const originalText = buffer.getText();
        buffer.setTextInRange([startPos, endPos], new_str);
        decorateEditedLines(editor, originalText, buffer.getText());

        strReplFailures.count = 0; // reset on success
        editStats.str_replace.hits++;
        editStats.str_replace._oldStrLenSum += old_str.split("\n").length;
        if (fuzzyWhitespace && effectiveOldStr !== old_str) editStats.str_replace.fuzzyWhitespaceCommits++;

        return {
          content: [{ type: "text", text: `✅ Replaced match at line ${matchLine + 1}${scopeLabel}${occurrence > 1 ? ` (occurrence ${occurrence})` : ""}${fuzzyWhitespace ? " [fuzzyWhitespace]" : ""}.` }],
          matched: true,
          dryRun: false,
          replacedAtLine: matchLine + 1
        };
      }
    );
  }

  {
    const curTool = "get-context-around";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Get Context Around",
        description: [
          "Return up-to `radiusLines` lines before and after the *N-th* match of `query` in the active editor.",
          "Useful for content-aware edits.",
          "Operates on the live buffer — no need to call get-document first, always reflects the latest unsaved edits.",
          "Use larger `radiusLines` for code blocks for better context understanding."
        ].join(" "),
        inputSchema: {
          query:         z.string(),
          regex:         z.boolean().optional(),
          caseSensitive: z.boolean().optional(),
          radiusLines:   z.number().optional(),
          occurrence:    z.number().optional()
        }
      },
      async ({ query, regex = false, caseSensitive = false, radiusLines = 5, occurrence = 1 }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { query, regex, caseSensitive, radiusLines, occurrence });

        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        const buffer     = editor.getBuffer();
        const totalLines = buffer.getLineCount();
        const source     = regex ? query : escapeRegex(query);
        const pattern    = new RegExp(source, caseSensitive ? "" : "i");
        const ranges     = buffer.findAllSync(pattern);

        if (ranges.length === 0) throw new Error("No matches for query.");
        if (occurrence < 1 || occurrence > ranges.length)
          throw new Error(`occurrence (${occurrence}) is out of range (1-${ranges.length}).`);

        const range        = ranges[occurrence - 1];
        const startRow     = range.start.row;
        const endRow       = range.end.row;
        const contextStart = Math.max(0, startRow - radiusLines);
        const contextEnd   = Math.min(totalLines - 1, endRow + radiusLines);

        const lines  = buffer.getTextInRange([[contextStart, 0], [contextEnd, buffer.lineLengthForRow(contextEnd)]]).split(/\r?\n/);
        const before = lines.slice(0, startRow - contextStart);
        const match  = lines.slice(startRow - contextStart, endRow - contextStart + 1);
        const after  = lines.slice(endRow - contextStart + 1);

        return {
          content: [{ type: "text", text: JSON.stringify({ before, match, after, matchStartLine: startRow + 1, matchEndLine: endRow + 1 }, null, 2) }]
        };
      }
    );
  }

  {
    const curTool = "find-text";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Find Text",
        description: [
          "Search the active editor for a substring or regular expression and return the positions of each occurrence.",
          "Returns truncation flag if results exceed maxMatches so you know if search was capped."
        ].join(" "),
        inputSchema: {
          query:         z.string(),
          regex:         z.boolean().optional(),
          caseSensitive: z.boolean().optional(),
          maxMatches:    z.number().optional()
        }
      },
      async ({ query, regex = false, caseSensitive = false, maxMatches = 200 }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { query, regex, caseSensitive, maxMatches });

        const editor  = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        const buffer  = editor.getBuffer();
        const source  = regex ? query : escapeRegex(query);
        const pattern = new RegExp(source, caseSensitive ? "" : "i");
        const ranges  = buffer.findAllSync(pattern, { limit: maxMatches + 1 }) || [];

        if (ranges.length === 0) return { content: [{ type: "text", text: "No matches." }], matches: [], totalMatches: 0, truncated: false };

        const truncated    = ranges.length > maxMatches;
        const actualRanges = ranges.slice(0, maxMatches);
        const results      = actualRanges.map(r => ({
          startLine: r.start.row + 1, startCol: r.start.column + 1,
          endLine:   r.end.row   + 1, endCol:   r.end.column   + 1
        }));

        return {
          content: [{ type: "text", text: JSON.stringify({ matches: results, totalMatches: actualRanges.length, truncated, message: truncated ? `Results capped at ${maxMatches}. Refine your query or increase maxMatches.` : "All matches found." }, null, 2) }],
          matches: results, totalMatches: actualRanges.length, truncated
        };
      }
    );
  }

  {
    const curTool = "replace-document";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Replace Document",
        description: [
          "Replace the entire contents of the editor with rewritten text.",
          "Useful for large edits. Returns lineCount and sample of first 10 lines to verify replacement worked.",
          "Workflow hint: call get-filename to confirm the right file is active. Call get-document first only if you need to read the current content before rewriting — skip it if you already have the full text."
        ].join(" "),
        inputSchema: { text: z.string() }
      },
      async ({ text }) => {
        console.log(`CMD: ${curTool}, ARGS: { text: /*${text.length} chars*/ }`);

        const editor       = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        const buffer       = editor.getBuffer();
        const originalText = buffer.getText();
        buffer.setText(text);
        decorateEditedLines(editor, originalText, text);

        const lines       = text.split(/\r?\n/);
        const sampleLines = lines.slice(0, 10).map((t, i) => `${i + 1}: ${t}`);
        const checksum    = text.substring(0, 500).split("").reduce((a, b) => { a = ((a << 5) - a) + b.charCodeAt(0); return a & a; }, 0);

        return {
          content: [{ type: "text", text: `Document replaced. ${lines.length} lines. Sample:\n${sampleLines.join("\n")}` }],
          lineCount: lines.length, checksum, sampleLines
        };
      }
    );
  }

  {
    const curTool = "insert";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Insert",
        description: [
          "Insert one or more lines of text before the specified 1-based line number (`insert_line`). Use for both single-line and multi-line inserts.",
          "CONTENT-ANCHORED INSERT (preferred): Use `afterContent` to insert after the first occurrence of an anchor string, or `beforeContent` to insert before it — immune to line number drift. Combine with `functionHint` to scope to a function body. Use `occurrence: N` to target the Nth match of the anchor. When afterContent/beforeContent is provided, insert_line is ignored.",
          "Set `dryRun:true` to preview what will be inserted and where without writing — response shows the surrounding context so you can confirm. Reply with the same call without dryRun (or dryRun:false) to commit.",
          "CORRUPTION RISK: line numbers shift after every insert — using stale line numbers for a subsequent insert or delete will hit the wrong lines and silently corrupt the file.",
          "You MUST call get-document or read-lines after each insert to get updated line numbers before any further line-based edits. Returns newLineCount so you can verify the shift."
        ].join(" "),
        inputSchema: {
          insert_line:   z.number().optional(),
          new_str:       z.string(),
          afterContent:  z.string().optional(),
          beforeContent: z.string().optional(),
          functionHint:  z.string().optional(),
          occurrence:    z.number().int().min(1).optional(),
          dryRun:        z.boolean().optional()
        }
      },
      async ({ insert_line, new_str, afterContent, beforeContent, functionHint, occurrence = 1, dryRun = false }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { insert_line, new_str: new_str.substring(0, 80), afterContent, beforeContent, functionHint, occurrence, dryRun });

        const editor    = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer    = editor.getBuffer();
        const lineCount = buffer.getLineCount();
        const allLines  = buffer.getLines();

        // ── Content-anchored insert (P5) ─────────────────────────────────────
        if (afterContent !== undefined || beforeContent !== undefined) {
          const anchor = afterContent !== undefined ? afterContent : beforeContent;
          const insertAfter = afterContent !== undefined; // true = after, false = before

          // Resolve function scope if provided
          let searchStart = 0;
          let searchEnd   = allLines.length - 1;
          let scopeLabel  = "";
          if (functionHint) {
            const fn = findFunctionInBuffer(buffer, functionHint);
            if (!fn) {
              insertFailures.count++;
              return { content: [{ type: "text", text: [
                `❌ functionHint: function "${functionHint}" not found.`,
                failureSuggestion(insertFailures, "insert")
              ].filter(Boolean).join("\n") }], inserted: false };
            }
            searchStart = fn.startRow;
            searchEnd   = fn.endRow;
            scopeLabel  = ` within function "${functionHint}"`;
          }

          // Find Nth occurrence of anchor
          let found = 0;
          let anchorRow = -1;
          for (let i = searchStart; i <= searchEnd; i++) {
            if (allLines[i].includes(anchor)) {
              found++;
              if (found === occurrence) { anchorRow = i; break; }
            }
          }

          if (anchorRow === -1) {
            insertFailures.count++;
            editStats.insert.fails.outOfRange++;
            const hint = found > 0 ? ` (found ${found} of ${occurrence} requested)` : "";
            return { content: [{ type: "text", text: [
              `❌ ${insertAfter ? "afterContent" : "beforeContent"} "${anchor}" not found${scopeLabel}${hint}.`,
              failureSuggestion(insertFailures, "insert")
            ].filter(Boolean).join("\n") }], inserted: false, insertFailures: insertFailures.count };
          }

          // Insert row: after anchor line or before it
          const insertRow = insertAfter ? anchorRow + 1 : anchorRow;

          if (dryRun) {
            editStats.insert.dryRuns++;
            const r = 3;
            const cs = Math.max(0, insertRow - r - (insertAfter ? 0 : 1));
            const ce = Math.min(lineCount - 1, insertRow + r);
            const ctxLines = allLines.slice(cs, Math.min(insertRow, ce + 1))
              .map((l, i) => `${String(cs + i + 1).padStart(4)}   ${l}`);
            const insLines = new_str.split("\n").map(l => `${" ".repeat(4)} ► ${l}`);
            const afterLines = allLines.slice(insertRow, ce + 1)
              .map((l, i) => `${String(insertRow + i + 1).padStart(4)}   ${l}`);
            const preview = [...ctxLines, ...insLines, ...afterLines].join("\n");
            return {
              content: [{ type: "text", text: [
                `✅ DRY RUN — will insert ${new_str.split("\n").length} line(s) ${insertAfter ? "after" : "before"} "${anchor}" (line ${anchorRow + 1})${scopeLabel}.`,
                `\nContext (► = lines to be inserted):\n${preview}`,
                `\nReply with the same call without dryRun (or dryRun:false) to commit.`
              ].join("\n") }],
              dryRun: true, insertRow: insertRow + 1, lineCount
            };
          }

          const textWithNewline = new_str.endsWith("\n") ? new_str : new_str + "\n";
          buffer.insert([insertRow, 0], textWithNewline);
          decorateLine(editor, insertRow, "added");
          insertFailures.count = 0;
          editStats.insert.hits++;
          const newLineCount = buffer.getLineCount();
          return {
            content: [{ type: "text", text: `✅ Inserted text ${insertAfter ? "after" : "before"} "${anchor}" (at line ${insertRow + 1}). New line count: ${newLineCount}. Remember: line numbers have shifted!` }],
            dryRun: false, newLineCount
          };
        }

        // ── Line-number-based insert (legacy) ─────────────────────────────────
        if (insert_line === undefined) {
          return { content: [{ type: "text", text: "❌ Either insert_line or afterContent/beforeContent is required." }], inserted: false };
        }

        if (insert_line < 1 || insert_line > lineCount + 1) {
          insertFailures.count++;
          editStats.insert.fails.outOfRange++;
          const r   = 4;
          const cs  = Math.max(0, lineCount - r);
          const ctx = allLines.slice(cs).map((l, i) => `${String(cs + i + 1).padStart(4)}: ${l}`).join("\n");
          return { content: [{ type: "text", text: [
            `❌ insert_line ${insert_line} is out of range (1–${lineCount + 1}). File has ${lineCount} lines.`,
            `\n📍 End of file:\n${ctx}`,
            failureSuggestion(insertFailures, "insert")
          ].filter(Boolean).join("\n") }], inserted: false, insertFailures: insertFailures.count };
        }

        if (dryRun) {
          editStats.insert.dryRuns++;
          const radius   = 3;
          const ctxStart = Math.max(0, insert_line - 1 - radius);
          const ctxEnd   = Math.min(lineCount - 1, insert_line - 1 + radius);
          const before   = allLines.slice(ctxStart, insert_line - 1)
            .map((l, i) => `${String(ctxStart + i + 1).padStart(4)}   ${l}`);
          const inserted = new_str.split("\n")
            .map(l => `${" ".repeat(4)} ► ${l}`);
          const after    = allLines.slice(insert_line - 1, ctxEnd + 1)
            .map((l, i) => `${String(insert_line + i).padStart(4)}   ${l}`);
          const preview  = [...before, ...inserted, ...after].join("\n");

          return {
            content: [{ type: "text", text: [
              `✅ DRY RUN — will insert ${new_str.split("\n").length} line(s) before line ${insert_line}.`,
              `\nContext (► = lines to be inserted):\n${preview}`,
              `\nReply with the same call without dryRun (or dryRun:false) to commit.`
            ].join("\n") }],
            dryRun: true,
            insert_line,
            lineCount
          };
        }

        const row             = insert_line - 1;
        const textWithNewline = new_str.endsWith("\n") ? new_str : new_str + "\n";
        buffer.insert([row, 0], textWithNewline);
        decorateLine(editor, row, "added");
        insertFailures.count = 0; // reset on success
        editStats.insert.hits++;

        const newLineCount = buffer.getLineCount();
        return {
          content: [{ type: "text", text: `✅ Inserted text at line ${insert_line}. New line count: ${newLineCount}. Remember: line numbers have shifted!` }],
          dryRun: false,
          newLineCount
        };
      }
    );
  }



  {
    const curTool = "delete-line";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Delete Line",
        description: "DEPRECATED: use delete-line-range instead. Delete the specified line number (1-based). WARNING: line numbers shift after every delete - always call get-document again before the next line-based edit.",
        inputSchema: { lineNumber: z.number() }
      },
      async ({ lineNumber }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { lineNumber });

        const editor    = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer    = editor.getBuffer();
        const lineCount = buffer.getLineCount();
        if (lineNumber < 1 || lineNumber > lineCount)
          throw new Error(`lineNumber ${lineNumber} is out of range (1-${lineCount}).`);

        const row = lineNumber - 1;
        buffer.deleteRows(row, row);
        decorateLine(editor, row, "removed");

        const newLineCount = buffer.getLineCount();
        return {
          content: [{ type: "text", text: `Deleted line ${lineNumber}. New line count: ${newLineCount}. Remember: line numbers have shifted!` }],
          newLineCount
        };
      }
    );
  }

  {
    const curTool = "delete-line-range";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Delete Line Range",
        description: "Delete all lines from startLine to endLine (inclusive). CORRUPTION RISK: line numbers shift after every delete — if you call this twice using stale line numbers the second delete will hit the wrong lines and silently corrupt the file. You MUST call get-document or read-lines after each delete to get updated line numbers before any further line-based edits. Returns newLineCount so you can verify the shift.",
        inputSchema: { startLine: z.number(), endLine: z.number(), dryRun: z.boolean().optional() }
      },
      async ({ startLine, endLine, dryRun = false }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { startLine, endLine, dryRun });

        const editor    = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer    = editor.getBuffer();
        const allLines  = buffer.getLines();
        const lineCount = buffer.getLineCount();

        if (startLine < 1 || endLine < 1) {
          deleteFailures.count++;
          editStats.delete_line_range.fails.outOfRange++;
          return { content: [{ type: "text", text: [
            `❌ Line numbers must be 1-based (got startLine=${startLine}, endLine=${endLine}).`,
            `   File has ${lineCount} lines.`,
            failureSuggestion(deleteFailures, "delete-line-range")
          ].filter(Boolean).join("\n") }], deleted: false, deleteFailures: deleteFailures.count };
        }
        if (startLine > endLine) {
          deleteFailures.count++;
          editStats.delete_line_range.fails.inverted++;
          return { content: [{ type: "text", text: [
            `❌ startLine (${startLine}) must be <= endLine (${endLine}).`,
            `   Did you mean startLine=${endLine}, endLine=${startLine}?`,
            failureSuggestion(deleteFailures, "delete-line-range")
          ].filter(Boolean).join("\n") }], deleted: false, deleteFailures: deleteFailures.count };
        }
        if (endLine > lineCount) {
          deleteFailures.count++;
          editStats.delete_line_range.fails.outOfRange++;
          const r = 4;
          const cs = Math.max(0, lineCount - 1 - r);
          const ctx = allLines.slice(cs).map((l, i) => `${String(cs + i + 1).padStart(4)}: ${l}`).join("\n");
          return { content: [{ type: "text", text: [
            `❌ endLine ${endLine} exceeds file length ${lineCount}.`,
            `\n📍 End of file (lines ${cs + 1}–${lineCount}):\n${ctx}`,
            failureSuggestion(deleteFailures, "delete-line-range")
          ].filter(Boolean).join("\n") }], deleted: false, deleteFailures: deleteFailures.count };
        }

        // Show what would be deleted
        const r = 3;
        const cs = Math.max(0, startLine - 1 - r);
        const ce = Math.min(lineCount - 1, endLine - 1 + r);
        const preview = allLines.slice(cs, ce + 1).map((l, i) => {
          const abs = cs + i;
          const inDel = abs >= startLine - 1 && abs <= endLine - 1;
          return `${String(abs + 1).padStart(4)}${inDel ? " ✂" : "  "} ${l}`;
        }).join("\n");

        const deletedCount = endLine - startLine + 1;

        if (dryRun) {
          editStats.delete_line_range.dryRuns++;
          return {
            content: [{ type: "text", text: [
              `✅ DRY RUN — will delete ${deletedCount} line(s) (${startLine}–${endLine}).`,
              `\nContext (✂ = lines to be deleted):\n${preview}`,
              `\nReply with the same call without dryRun (or dryRun:false) to commit.`
            ].join("\n") }],
            dryRun: true, deleted: false, startLine, endLine, deletedCount
          };
        }

        const startRow = startLine - 1;
        const endRow   = endLine   - 1;
        buffer.deleteRows(startRow, endRow);
        decorateLine(editor, startRow, "removed");
        deleteFailures.count = 0; // reset on success
        editStats.delete_line_range.hits++;

        const newLineCount = buffer.getLineCount();
        return {
          content: [{ type: "text", text: `✅ Deleted ${deletedCount} line(s) (${startLine}–${endLine}). New line count: ${newLineCount}. Line numbers have shifted — call get-document or read-lines before the next line-based edit.` }],
          dryRun: false, deleted: true, newLineCount, deletedCount, staleLinesWarning: true
        };
      }
    );
  }

  {
    const curTool = "get-selection";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Get Selection",
        description: "Return the text and line/column range currently selected in the active editor. Returns startLine, endLine, startCol, endCol (all 1-based) alongside the selected text.",
        inputSchema: {}
      },
      async (args) => {
        console.log(`CMD: ${curTool}, ARGS: ${JSON.stringify(args)}`);

        const editor       = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const selectedText = editor.getSelectedText();
        const range        = editor.getSelectedBufferRange();

        return {
          content: [{ type: "text", text: JSON.stringify({ selectedText, startLine: range.start.row + 1, endLine: range.end.row + 1, startCol: range.start.column + 1, endCol: range.end.column + 1 }, null, 2) }]
        };
      }
    );
  }
  // ── P6: delete-block ─────────────────────────────────────────────────────
  {
    const curTool = "delete-block";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Delete Block",
        description: [
          "Delete lines between two content anchor strings (inclusive of the anchor lines by default).",
          "Content-stable equivalent of delete-line-range — immune to line number drift.",
          "Provide startContent and endContent strings; the tool finds their lines and deletes everything between them (inclusive).",
          "Use inclusive:false to exclude the anchor lines themselves (delete only the content between them).",
          "Combine with functionHint to scope the search to a named function body.",
          "Use occurrence:N to target the Nth occurrence of startContent.",
          "Set dryRun:true to preview what will be deleted without writing."
        ].join(" "),
        inputSchema: {
          startContent: z.string(),
          endContent:   z.string(),
          inclusive:    z.boolean().optional(),
          functionHint: z.string().optional(),
          occurrence:   z.number().int().min(1).optional(),
          dryRun:       z.boolean().optional()
        }
      },
      async ({ startContent, endContent, inclusive = true, functionHint, occurrence = 1, dryRun = false }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { startContent, endContent, inclusive, functionHint, occurrence, dryRun });

        const editor    = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer    = editor.getBuffer();
        const allLines  = buffer.getLines();
        const lineCount = buffer.getLineCount();

        // Resolve optional function scope
        let searchFrom = 0;
        let searchTo   = allLines.length - 1;
        if (functionHint) {
          const fn = findFunctionInBuffer(buffer, functionHint);
          if (!fn) {
            deleteFailures.count++;
            editStats.delete_line_range.fails.outOfRange++;
            return { content: [{ type: "text", text: `❌ functionHint: function "${functionHint}" not found.` }], deleted: false };
          }
          searchFrom = fn.startRow;
          searchTo   = fn.endRow;
        }

        // Find Nth occurrence of startContent
        let found = 0;
        let startRow = -1;
        for (let i = searchFrom; i <= searchTo; i++) {
          if (allLines[i].includes(startContent)) {
            found++;
            if (found === occurrence) { startRow = i; break; }
          }
        }
        if (startRow === -1) {
          deleteFailures.count++;
          editStats.delete_line_range.fails.outOfRange++;
          return { content: [{ type: "text", text: [
            `❌ startContent "${startContent}" not found (occurrence ${occurrence}).`,
            failureSuggestion(deleteFailures, "delete-line-range")
          ].filter(Boolean).join("\n") }], deleted: false, deleteFailures: deleteFailures.count };
        }

        // Find endContent starting from startRow
        let endRow = -1;
        for (let i = startRow; i <= searchTo; i++) {
          if (i !== startRow && allLines[i].includes(endContent)) {
            endRow = i;
            break;
          }
          // Also allow endContent on the same line as startContent if startContent !== endContent
          if (i === startRow && startContent !== endContent && allLines[i].includes(endContent)) {
            endRow = i;
            break;
          }
        }
        if (endRow === -1) {
          deleteFailures.count++;
          editStats.delete_line_range.fails.outOfRange++;
          return { content: [{ type: "text", text: [
            `❌ endContent "${endContent}" not found after startContent (line ${startRow + 1}).`,
            failureSuggestion(deleteFailures, "delete-line-range")
          ].filter(Boolean).join("\n") }], deleted: false, deleteFailures: deleteFailures.count };
        }

        // Apply inclusive setting
        const delStart = inclusive ? startRow : startRow + 1;
        const delEnd   = inclusive ? endRow   : endRow   - 1;

        if (delStart > delEnd) {
          return { content: [{ type: "text", text: `❌ No lines to delete — inclusive:false with adjacent anchors produces an empty range.` }], deleted: false };
        }

        // Preview
        const r = 3;
        const cs = Math.max(0, delStart - r);
        const ce = Math.min(lineCount - 1, delEnd + r);
        const preview = allLines.slice(cs, ce + 1).map((l, i) => {
          const abs = cs + i;
          return `${String(abs + 1).padStart(4)}${abs >= delStart && abs <= delEnd ? " ✂" : "  "} ${l}`;
        }).join("\n");
        const deletedCount = delEnd - delStart + 1;

        if (dryRun) {
          editStats.delete_line_range.dryRuns++;
          return {
            content: [{ type: "text", text: [
              `✅ DRY RUN — will delete ${deletedCount} line(s) (lines ${delStart + 1}–${delEnd + 1}).`,
              `\nContext (✂ = lines to be deleted):\n${preview}`,
              `\nReply with the same call without dryRun (or dryRun:false) to commit.`
            ].join("\n") }],
            dryRun: true, deleted: false, startLine: delStart + 1, endLine: delEnd + 1, deletedCount
          };
        }

        buffer.deleteRows(delStart, delEnd);
        decorateLine(editor, delStart, "removed");
        deleteFailures.count = 0;
        editStats.delete_line_range.hits++;
        const newLineCount = buffer.getLineCount();
        return {
          content: [{ type: "text", text: `✅ Deleted ${deletedCount} line(s) (lines ${delStart + 1}–${delEnd + 1}). New line count: ${newLineCount}. Line numbers have shifted.` }],
          dryRun: false, deleted: true, newLineCount, deletedCount, staleLinesWarning: true
        };
      }
    );
  }

  // ── P7: replace-block ─────────────────────────────────────────────────────
  {
    const curTool = "replace-block";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Replace Block",
        description: [
          "Generalised replace-function-body for non-function blocks — replaces a brace-delimited block anchored by a content string.",
          "Finds the first line matching anchor, then locates the next { after it and matches to the closing } using brace counting.",
          "newBody must include the anchor line (or replacement for it) and the full block content including braces.",
          "Equivalent to replace-function-body but triggered by any anchor string, not just a function name.",
          "Useful for if/while/for blocks, switch cases, struct initialisers, or any named brace-delimited region.",
          "Use occurrence:N to target the Nth occurrence of the anchor string.",
          "Set dryRun:true to preview the match without writing."
        ].join(" "),
        inputSchema: {
          anchor:     z.string(),
          newBody:    z.string(),
          occurrence: z.number().int().min(1).optional(),
          dryRun:     z.boolean().optional()
        }
      },
      async ({ anchor, newBody, occurrence = 1, dryRun = false }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { anchor: anchor.substring(0, 80), newBodyLength: newBody.length, occurrence, dryRun });

        const editor    = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer    = editor.getBuffer();
        const allLines  = buffer.getLines();

        // Find Nth occurrence of anchor
        let found = 0;
        let anchorRow = -1;
        for (let i = 0; i < allLines.length; i++) {
          if (allLines[i].includes(anchor)) {
            found++;
            if (found === occurrence) { anchorRow = i; break; }
          }
        }
        if (anchorRow === -1) {
          editStats.replace_block.fails.anchorNotFound++;
          return { content: [{ type: "text", text: [
            `❌ anchor "${anchor}" not found (occurrence ${occurrence}; found ${found}).`
          ].join("\n") }], found: false };
        }

        // Find next { at or after anchor line
        let depth = 0;
        let braceStartRow = -1;
        for (let i = anchorRow; i < allLines.length; i++) {
          if (allLines[i].includes("{")) { braceStartRow = i; break; }
          if (i > anchorRow && allLines[i].includes(";")) break; // declaration, not block
        }
        if (braceStartRow === -1) {
          editStats.replace_block.fails.braceMatchFailed++;
          return { content: [{ type: "text", text: `❌ No opening brace { found after anchor "${anchor}" (line ${anchorRow + 1}).` }], found: false };
        }

        // Brace-match to find closing }
        let endRow = -1;
        for (let i = braceStartRow; i < allLines.length; i++) {
          for (const ch of allLines[i]) {
            if (ch === "{") depth++;
            else if (ch === "}") { depth--; if (depth === 0) { endRow = i; break; } }
          }
          if (endRow !== -1) break;
        }
        if (endRow === -1) {
          editStats.replace_block.fails.braceMatchFailed++;
          return { content: [{ type: "text", text: `❌ Brace matching failed — unmatched { after anchor "${anchor}" (line ${braceStartRow + 1}).` }], found: false };
        }

        const startRow = anchorRow;
        const ensuredNewline = newBody.endsWith("\n") ? newBody : newBody + "\n";
        const insertedLines  = ensuredNewline.split(/\r?\n/).length - 1;

        if (dryRun) {
          editStats.replace_block.dryRuns++;
          const r = 2;
          const cs = Math.max(0, startRow - r);
          const ce = Math.min(allLines.length - 1, endRow + r);
          const preview = allLines.slice(cs, ce + 1).map((l, i) => {
            const abs = cs + i;
            return `${String(abs + 1).padStart(4)}${abs >= startRow && abs <= endRow ? " ►" : "  "} ${l}`;
          }).join("\n");
          const newLines = ensuredNewline.split(/\r?\n/).slice(0, -1).map(l => `     + ${l}`).join("\n");
          return {
            content: [{ type: "text", text: [
              `✅ DRY RUN — block found at lines ${startRow + 1}–${endRow + 1} (${endRow - startRow + 1} lines).`,
              `\nCurrent block (► = will be replaced):\n${preview}`,
              `\nReplacement (${insertedLines} lines):\n${newLines}`,
              `\nReply with the same call without dryRun (or dryRun:false) to commit.`
            ].join("\n") }],
            found: true, dryRun: true, oldStartLine: startRow + 1, oldEndLine: endRow + 1
          };
        }

        const originalText = buffer.getText();
        buffer.setTextInRange([[startRow, 0], [endRow + 1, 0]], ensuredNewline);
        decorateEditedLines(editor, originalText, buffer.getText());
        editStats.replace_block.hits++;
        const newLineCount = buffer.getLineCount();
        return {
          content: [{ type: "text", text: `✅ Replaced block (anchor: "${anchor}", old lines ${startRow + 1}–${endRow + 1}). Inserted ${insertedLines} lines starting at ${startRow + 1}. New total: ${newLineCount}.` }],
          found: true, dryRun: false, oldStartLine: startRow + 1, oldEndLine: endRow + 1,
          newStartLine: startRow + 1, insertedLines, newLineCount
        };
      }
    );
  }

  // ── P8: get-region ────────────────────────────────────────────────────────
  {
    const curTool = "get-region";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Get Region",
        description: [
          "Return lines between two content anchor strings — content-stable equivalent of read-lines.",
          "Provide startContent and endContent; the tool returns the lines from startContent's line to endContent's line (inclusive).",
          "Use inclusive:false to exclude the anchor lines themselves.",
          "Use occurrence:N to target the Nth occurrence of startContent.",
          "Immune to line number drift — useful for large files where exact line numbers are unknown.",
          "Example: get-region({ startContent: 'void HAL_Init(void) {', endContent: '} // end HAL_Init' })"
        ].join(" "),
        inputSchema: {
          startContent: z.string(),
          endContent:   z.string(),
          inclusive:    z.boolean().optional(),
          occurrence:   z.number().int().min(1).optional(),
          filePath:     z.string().optional()
        }
      },
      async ({ startContent, endContent, inclusive = true, occurrence = 1, filePath }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { startContent, endContent, inclusive, occurrence, filePath });

        let text;
        let resolvedPath = filePath;
        if (filePath) {
          try { text = await readFileOrBuffer(filePath); }
          catch (err) { throw new Error(`Cannot read file: ${filePath} - ${err.message}`); }
        } else {
          const editor = atom.workspace.getActiveTextEditor();
          if (!editor) throw new Error("No active editor and no filePath provided.");
          text = editor.getBuffer().getText();
          resolvedPath = editor.getPath() || "[untitled]";
        }

        const allLines = text.split(/\r?\n/);

        // Find Nth occurrence of startContent
        let found = 0;
        let startRow = -1;
        for (let i = 0; i < allLines.length; i++) {
          if (allLines[i].includes(startContent)) {
            found++;
            if (found === occurrence) { startRow = i; break; }
          }
        }
        if (startRow === -1) {
          return { content: [{ type: "text", text: `❌ startContent "${startContent}" not found (occurrence ${occurrence}; found ${found}).` }], found: false };
        }

        // Find endContent starting from startRow
        let endRow = -1;
        for (let i = startRow + 1; i < allLines.length; i++) {
          if (allLines[i].includes(endContent)) { endRow = i; break; }
        }
        // Also check same line if startContent === endContent pattern not applicable
        if (endRow === -1 && startContent !== endContent && allLines[startRow].includes(endContent)) {
          endRow = startRow;
        }
        if (endRow === -1) {
          return { content: [{ type: "text", text: `❌ endContent "${endContent}" not found after line ${startRow + 1}.` }], found: false };
        }

        const sliceStart = inclusive ? startRow : startRow + 1;
        const sliceEnd   = inclusive ? endRow   : endRow   - 1;
        const lines = allLines.slice(sliceStart, sliceEnd + 1).map((t, i) => ({ n: sliceStart + i + 1, text: t }));

        return {
          content: [{ type: "text", text: JSON.stringify({
            filePath: resolvedPath,
            startLine: sliceStart + 1, endLine: sliceEnd + 1,
            returnedLines: lines.length, lines
          }, null, 2) }],
          found: true, startLine: sliceStart + 1, endLine: sliceEnd + 1, returnedLines: lines.length
        };
      }
    );
  }

  } // end EDIT GROUP

  // ── CORE GROUP (always on) ─────────────────────────────────────────────────
  {
    const curTool = "get-document";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Get Document",
        description: "Return an array of lines with their 1-based line numbers. IMPORTANT: Always call get-document again after any insert, delete, or replace operation before making further line-based edits - line numbers shift with every change.",
        inputSchema: {}
      },
      async (args) => {
        console.log("CMD: " + curTool + ", ARGS: " + JSON.stringify(args));

        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        const lines = editor.getBuffer().getText().split(/\r?\n/).map((text, i) => ({ n: i + 1, text }));
        return { content: [{ type: "text", text: JSON.stringify(lines, null, 2) }] };
      }
    );
  }

  {
    const curTool = "get-line-count";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Get Line Count",
        description: "Return the total number of lines in the active editor.",
        inputSchema: {}
      },
      async (args) => {
        console.log("CMD: " + curTool + ", ARGS: " + JSON.stringify(args));
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        return { content: [{ type: "text", text: String(editor.getBuffer().getLineCount()) }] };
      }
    );
  }

  {
    const curTool = "get-filename";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Get Filename",
        description: "Return the filename of the active editor (or [untitled] if none).",
        inputSchema: {}
      },
      async (args) => {
        console.log("CMD: " + curTool + ", ARGS: " + JSON.stringify(args));
        const editor   = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const fullPath = editor.getPath();
        return { content: [{ type: "text", text: fullPath ? path.basename(fullPath) : "[untitled]" }] };
      }
    );
  }

  {
    const curTool = "get-full-path";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Get Full File Path",
        description: "Return the full absolute path of the active editor.",
        inputSchema: {}
      },
      async (args) => {
        console.log("CMD: " + curTool + ", ARGS: " + JSON.stringify(args));
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        return { content: [{ type: "text", text: editor.getPath() || "[untitled]" }] };
      }
    );
  }

  // ── FILE-OPS GROUP ─────────────────────────────────────────────────────────
  if (g('fileOps')) {
  {
    const curTool = "get-project-files";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Get Project Files",
        description: [
          "Return a list of all files under the current project roots.",
          "Pass a glob pattern (e.g. '**/*.c', '**/*.h', 'src/**/*.js') to filter results.",
          "Without a glob, returns every file. Equivalent to CC's Glob tool."
        ].join(" "),
        inputSchema: {
          glob: z.string().optional()
        }
      },
      async ({ glob = "" } = {}) => {
        console.log("CMD: " + curTool + ", ARGS: ", { glob });
        const roots = atom.project.getPaths();
        let files = [];
        for (const root of roots) files = files.concat(await walkDir(root));
        if (glob) {
          const globRe = globToRegex(glob);
          files = files.filter(f => globRe.test(f.replace(/\\/g, "/")));
        }
        return {
          content: [{ type: "text", text: files.join("\n") }],
          fileCount: files.length
        };
      }
    );
  }
  } // end FILE-OPS GROUP (get-project-files)

  // ── NAVIGATION GROUP ──────────────────────────────────────────────────────
  if (g('navigation')) {
  {
    const curTool = "open-file";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Open File",
        description: "Open (or switch to) a tab for the given file path. Returns file info including line count and language.",
        inputSchema: { filePath: z.string() }
      },
      async (args) => {
        console.log("CMD: " + curTool + ", ARGS: " + JSON.stringify(args));
        const { filePath } = args;
        const editor       = await atom.workspace.open(filePath);
        const lineCount    = editor.getBuffer().getLineCount();
        const language     = editor.getGrammar() ? editor.getGrammar().name : "Unknown";
        return {
          content: [{ type: "text", text: `Opened file: ${filePath}\nLines: ${lineCount}, Language: ${language}` }],
          file: filePath, lineCount, language, isActive: true
        };
      }
    );
  }

  {
    const curTool = "goto-line";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Go To Line",
        description: "Jump the cursor to a specific line number (and optionally column) in the active editor. Returns the line content and surrounding context so you can verify you jumped to the right place.",
        inputSchema: { lineNumber: z.number(), column: z.number().optional() }
      },
      async (args) => {
        console.log("CMD: " + curTool + ", ARGS: " + JSON.stringify(args));
        const { lineNumber, column = 0 } = args;

        const editor    = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer    = editor.getBuffer();
        const lineCount = buffer.getLineCount();
        if (lineNumber < 1 || lineNumber > lineCount)
          throw new Error(`Line ${lineNumber} is out of range (1-${lineCount}).`);

        const row          = lineNumber - 1;
        editor.setCursorBufferPosition([row, column], { autoscroll: true });

        const contextStart = Math.max(0, row - 2);
        const contextEnd   = Math.min(lineCount - 1, row + 2);
        const lines        = buffer.getLines().slice(contextStart, contextEnd + 1).map((text, i) => `${contextStart + i + 1}: ${text}`);

        return {
          content: [{ type: "text", text: `Jumped to line ${lineNumber}, column ${column}.\nContext:\n${lines.join("\n")}` }],
          line: lineNumber, column, lineContent: buffer.lineForRow(row), context: lines
        };
      }
    );
  }

  {
    const curTool = "list-open-files";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "List Open Files",
        description: "Return a list of all files currently open in editor tabs. Useful for understanding what files are in the workspace context.",
        inputSchema: {}
      },
      async (args) => {
        console.log("CMD: " + curTool + ", ARGS: " + JSON.stringify(args));
        const openFiles = atom.workspace.getTextEditors().map(editor => ({
          filePath: editor.getPath() || "[untitled]",
          modified: editor.isModified() ? "*" : ""
        }));
        return {
          content: [{ type: "text", text: JSON.stringify({ openFileCount: openFiles.length, files: openFiles }, null, 2) }],
          openFiles, count: openFiles.length
        };
      }
    );
  }

  {
    const curTool = "get-active-editor-info";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Get Active Editor Info",
        description: "Quick status check on the active editor without loading the full document. Returns filename, line count, language, cursor position, and modification status. Use this instead of get-document when you only need metadata - much cheaper.",
        inputSchema: {}
      },
      async (args) => {
        console.log("CMD: " + curTool + ", ARGS: " + JSON.stringify(args));

        const editor    = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        const filePath  = editor.getPath() || "[untitled]";
        const fileName  = filePath ? path.basename(filePath) : "[untitled]";
        const lineCount = editor.getBuffer().getLineCount();
        const cursorPos = editor.getCursorBufferPosition();
        const language  = editor.getGrammar() ? editor.getGrammar().name : "Unknown";
        const modified  = editor.isModified();

        const info = { filename: fileName, filePath, lineCount, cursorLine: cursorPos.row + 1, cursorCol: cursorPos.column, language, modified };
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }], ...info };
      }
    );
  }

  {
    const curTool = "get-surrounding-context";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Get Surrounding Context",
        description: "Efficiently load just a small section of the file around a specific line, without loading the entire document. Useful for huge files (1MB+) where get-document is slow. Returns lines +/-radiusLines around the target.",
        inputSchema: { lineNumber: z.number(), radiusLines: z.number().optional() }
      },
      async (args) => {
        console.log("CMD: " + curTool + ", ARGS: " + JSON.stringify(args));
        const { lineNumber, radiusLines = 5 } = args;

        const editor    = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer    = editor.getBuffer();
        const lineCount = buffer.getLineCount();
        if (lineNumber < 1 || lineNumber > lineCount)
          throw new Error(`Line ${lineNumber} is out of range (1-${lineCount}).`);

        const row          = lineNumber - 1;
        const contextStart = Math.max(0, row - radiusLines);
        const contextEnd   = Math.min(lineCount - 1, row + radiusLines);
        const lines        = buffer.getLines().slice(contextStart, contextEnd + 1).map((text, i) => ({ n: contextStart + i + 1, text }));

        return {
          content: [{ type: "text", text: JSON.stringify({ targetLine: lineNumber, contextStart: contextStart + 1, contextEnd: contextEnd + 1, lines }, null, 2) }],
          lines, targetLine: lineNumber, contextStart: contextStart + 1, contextEnd: contextEnd + 1
        };
      }
    );
  }
  } // end NAVIGATION GROUP

  // ── SAFETY GROUP ──────────────────────────────────────────────────────────
  if (g('safety')) {
  {
    const curTool = "undo";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      { title: "Undo", description: "Undo the last change in the active editor.", inputSchema: {} },
      async (args) => {
        console.log(`CMD: ${curTool}, ARGS: ${JSON.stringify(args)}`);
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer = editor.getBuffer();
        const before = buffer.getText();
        editor.undo();
        const changed = before !== buffer.getText();
        return { content: [{ type: "text", text: changed ? "Undo completed." : "Nothing to undo." }] };
      }
    );
  }

  {
    const curTool = "redo";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      { title: "Redo", description: "Redo the last undone change in the active editor.", inputSchema: {} },
      async (args) => {
        console.log(`CMD: ${curTool}, ARGS: ${JSON.stringify(args)}`);
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer = editor.getBuffer();
        const before = buffer.getText();
        editor.redo();
        const changed = before !== buffer.getText();
        return { content: [{ type: "text", text: changed ? "Redo completed." : "Nothing to redo." }] };
      }
    );
  }
  } // end SAFETY GROUP (undo/redo — more safety tools added later)

  // ---------------------------------------------------------------------------
  // Cross-file tools
  // ---------------------------------------------------------------------------

  // ── FILE-OPS GROUP (continued) ────────────────────────────────────────────
  if (g('fileOps')) {
  {
    const curTool = "read-file";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Read File",
        description: [
          "Read any project file by path and return its contents with 1-based line numbers.",
          "Unlike get-document, this does NOT require the file to be open or active in the editor. If the file is open in Pulsar, reads from the live buffer — unsaved edits are reflected automatically. Falls back to disk for files not open in the editor.",
          "Use get-project-files to discover available paths."
        ].join(" "),
        inputSchema: { filePath: z.string() }
      },
      async ({ filePath }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { filePath });
        let text;
        try { text = await readFileOrBuffer(filePath); }
        catch (err) { throw new Error(`Cannot read file: ${filePath} - ${err.message}`); }
        const lines = text.split(/\r?\n/).map((t, i) => ({ n: i + 1, text: t }));
        return { content: [{ type: "text", text: JSON.stringify(lines, null, 2) }], lineCount: lines.length, filePath };
      }
    );
  }

  {
    const curTool = "run-command";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Run Command",
        description: [
          `Execute a shell command and return stdout, stderr, and exit code.`,
          `On Windows uses PowerShell; on Linux/Mac uses /bin/sh.`,
          `cwd defaults to the first project root. timeout defaults to 30 seconds (in ms).`,
          `Use for build commands (make, gcc, cmake), running tests, git status, etc.`
        ].join(" "),
        inputSchema: {
          command: z.string(),
          cwd:     z.string().optional(),
          timeout: z.number().optional()
        }
      },
      async ({ command, cwd, timeout = 30000 }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { command, cwd, timeout });

        const workDir = cwd || (atom.project.getPaths()[0] ?? null);
        if (!workDir) throw new Error("No project root open and no cwd provided.");

        const { shell, flag } = getShell();

        return new Promise((resolve) => {
          _exec(
            command,
            { cwd: workDir, timeout, maxBuffer: 2 * 1024 * 1024, shell: shell },
            (err, stdout, stderr) => {
              const exitCode = err?.code ?? 0;
              const result = { command, shell, cwd: workDir, exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
              resolve({
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                exitCode, stdout: stdout.trim(), stderr: stderr.trim()
              });
            }
          );
        });
      }
    );
  }

  {
    const curTool = "replace-across-files";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Replace Across Files",
        description: [
          "Find and replace a string or regex across all project files (or a glob-filtered subset).",
          "Set dryRun:true to preview which files and how many matches would be affected without writing.",
          "Use glob to restrict to e.g. '**/*.js' or '**/*.c'.",
          "Files open in editor tabs are updated live (undo history preserved); closed files are written to disk. Binary files (.o, .exe, .dll, images, archives etc.) are automatically skipped to prevent corruption. Always use dryRun:true first to preview affected files and match counts before committing."
        ].join(" "),
        inputSchema: {
          query:         z.string(),
          replacement:   z.string(),
          regex:         z.boolean().optional(),
          caseSensitive: z.boolean().optional(),
          glob:          z.string().optional(),
          dryRun:        z.boolean().optional()
        }
      },
      async ({ query, replacement, regex = false, caseSensitive = false, glob = "", dryRun = false }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { query, replacement, regex, caseSensitive, glob, dryRun });

        const roots = atom.project.getPaths();
        if (!roots.length) throw new Error("No project root open.");

        const flags  = caseSensitive ? "g" : "gi";
        const source = regex ? query : escapeRegex(query);
        let pattern;
        try { pattern = new RegExp(source, flags); }
        catch (e) { throw new Error(`Invalid regex: ${e.message}`); }

        let allFiles = [];
        for (const root of roots) allFiles = allFiles.concat(await walkDir(root));
        if (glob) { const globRe = globToRegex(glob); allFiles = allFiles.filter(f => globRe.test(f.replace(/\\/g, "/"))); }
        // Skip binary files to prevent corruption
        const BINARY_EXTS = new Set(["o","obj","exe","dll","so","dylib","bin","lib","a","out","pdb","ilk","map","elf","hex","png","jpg","jpeg","gif","bmp","ico","pdf","zip","tar","gz","7z","rar"]);
        allFiles = allFiles.filter(f => !BINARY_EXTS.has(f.split(".").pop().toLowerCase()));

        const results = [];
        let totalReplacements = 0;

        for (const filePath of allFiles) {
          let original;
          try { original = await fs.promises.readFile(filePath, "utf8"); } catch { continue; }
          let count = 0;
          const updated = original.replace(new RegExp(source, flags), () => { count++; return replacement; });
          if (count === 0) continue;
          totalReplacements += count;
          results.push({ filePath, replacements: count });
          if (!dryRun) {
            const openEditor = atom.workspace.getTextEditors().find(e => e.getPath() === filePath);
            if (openEditor) openEditor.getBuffer().setTextViaDiff(updated);
            else await fs.promises.writeFile(filePath, updated, "utf8");
          }
        }

        const summary = dryRun
          ? `DRY RUN - ${totalReplacements} replacement(s) across ${results.length} file(s). No files written.`
          : `Replaced ${totalReplacements} occurrence(s) across ${results.length} file(s).`;

        return {
          content: [{ type: "text", text: JSON.stringify({ summary, totalReplacements, filesAffected: results.length, dryRun, files: results }, null, 2) }],
          totalReplacements, filesAffected: results.length, dryRun
        };
      }
    );
  }

  {
    const curTool = "replace-function-body";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Replace Function Body",
        description: [
          "Atomically replace an entire named function (signature + body) in the active editor.",
          "PREFERRED over line-based edits for whole-function rewrites - avoids line number shifting entirely.",
          "Finds the function by name, deletes from its signature line to its closing brace,",
          "and inserts the new body in one operation — no line-number shifting between steps.",
          "newBody must be the complete replacement text including the function signature.",
          "Returns the old and new line ranges so you can verify the change. SILENT SIGNATURE RISK: the tool does not validate that newBody preserves the original function signature — passing a wrong or simplified signature will silently replace it without any error. Always include the exact original signature in newBody unless you deliberately intend to change it. Use get-function-body first to read the current signature before writing."
        ].join(" "),
        inputSchema: {
          name:    z.string(),
          newBody: z.string(),
          dryRun:  z.boolean().optional()
        }
      },
      async ({ name, newBody, dryRun = false }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { name, newBodyLength: newBody.length, dryRun });

        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        const buffer   = editor.getBuffer();
        const allLines = buffer.getLines();
        const found    = findFunctionInBuffer(buffer, name);

        if (!found) {
          editStats.replace_function_body.fails.notFound++;
          // Smart failure: find closest function names
          const sigRe  = /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\())/g;
          const allSrc = buffer.getText();
          const fnNames = [];
          let m;
          while ((m = sigRe.exec(allSrc)) !== null) fnNames.push(m[1] || m[2]);

          // Fuzzy: find names that share characters with the requested name
          const nameLower = name.toLowerCase();
          const close = fnNames
            .map(fn => {
              const s = fn.toLowerCase();
              let score = 0;
              for (const ch of nameLower) if (s.includes(ch)) score++;
              return { fn, score: score / Math.max(nameLower.length, 1) };
            })
            .filter(x => x.score > 0.4)
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
            .map(x => x.fn);

          const parts = [`❌ Function "${name}" not found in active editor.`];
          if (close.length > 0) {
            parts.push(`\n📍 Similar function names found: ${close.join(", ")}`);
            parts.push(`   Did you mean one of these? Check spelling and casing.`);
          } else if (fnNames.length > 0) {
            parts.push(`\n📍 Functions in this file: ${fnNames.slice(0, 10).join(", ")}${fnNames.length > 10 ? ` … (${fnNames.length} total)` : ""}`);
          } else {
            parts.push(`   No functions detected in this file.`);
          }
          return { content: [{ type: "text", text: parts.join("\n") }], found: false };
        }

        const { startRow, endRow } = found;
        const oldSignatureLine  = allLines[startRow] ?? "";
        const ensuredNewline    = newBody.endsWith("\n") ? newBody : newBody + "\n";
        const insertedLines     = ensuredNewline.split(/\r?\n/).length - 1;
        const signatureChanged  = oldSignatureLine.trim() !== (ensuredNewline.split(/\r?\n/)[0] ?? "").trim();

        if (dryRun) {
          editStats.replace_function_body.dryRuns++;
          const r = 2;
          const cs = Math.max(0, startRow - r);
          const ce = Math.min(allLines.length - 1, endRow + r);
          const preview = allLines.slice(cs, ce + 1).map((l, i) => {
            const abs = cs + i;
            const inFn = abs >= startRow && abs <= endRow;
            return `${String(abs + 1).padStart(4)}${inFn ? " ►" : "  "} ${l}`;
          }).join("\n");
          const newLines = ensuredNewline.split(/\r?\n/).slice(0, -1).map(l => `     + ${l}`).join("\n");

          return {
            content: [{ type: "text", text: [
              `✅ DRY RUN — function "${name}" found at lines ${startRow + 1}–${endRow + 1} (${endRow - startRow + 1} lines).`,
              signatureChanged ? `\n⚠️  SIGNATURE CHANGE DETECTED — verify this is intentional.` : "",
              `\nCurrent function (► = will be replaced):\n${preview}`,
              `\nReplacement (${insertedLines} lines):\n${newLines}`,
              `\nReply with the same call without dryRun (or dryRun:false) to commit.`
            ].filter(Boolean).join("\n") }],
            found: true, dryRun: true,
            oldStartLine: startRow + 1, oldEndLine: endRow + 1, insertedLines, signatureChanged
          };
        }

        const originalText = buffer.getText();
        buffer.setTextInRange([[startRow, 0], [endRow + 1, 0]], ensuredNewline);
        decorateEditedLines(editor, originalText, buffer.getText());
        editStats.replace_function_body.hits++;

        const newLineCount = buffer.getLineCount();
        return {
          content: [{ type: "text", text: [
            `✅ Replaced function "${name}". Old lines: ${startRow + 1}–${endRow + 1}. Inserted ${insertedLines} lines starting at ${startRow + 1}. New total: ${newLineCount}.`,
            signatureChanged ? " ⚠️  WARNING: signature appears changed — verify this was intentional." : ""
          ].filter(Boolean).join("") }],
          found: true, dryRun: false,
          functionName: name,
          oldStartLine: startRow + 1,
          oldEndLine:   endRow   + 1,
          newStartLine: startRow + 1,
          signatureChanged, insertedLines, newLineCount
        };
      }
    );
  }

  {
    const curTool = "create-file";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Create File",
        description: [
          "Create a new file at the given path with optional initial content, then open it in a Pulsar tab.",
          "If the file already exists it will NOT be overwritten — use open-file instead.",
          "Directories in the path are created automatically.",
          "After creation the new file becomes the active editor so all other tools work on it immediately."
        ].join(" "),
        inputSchema: {
          filePath: z.string(),
          content:  z.string().optional()
        }
      },
      async ({ filePath, content = "" }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { filePath, contentLength: content.length });

        try {
          await fs.promises.access(filePath);
          throw new Error(`File already exists: ${filePath}. Use open-file to open it.`);
        } catch (err) {
          if (err.message.startsWith("File already exists")) throw err;
        }

        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, content, "utf8");

        const editor    = await atom.workspace.open(filePath);
        const lineCount = editor.getBuffer().getLineCount();
        const language  = editor.getGrammar() ? editor.getGrammar().name : "Unknown";

        return {
          content: [{ type: "text", text: `Created and opened: ${filePath}\nLines: ${lineCount}, Language: ${language}` }],
          filePath, lineCount, language
        };
      }
    );
  }

  // ── move-file ──────────────────────────────────────────────────────────────
  {
    const curTool = "move-file";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Move File",
        description: [
          "Move (or rename) a file from sourcePath to destPath.",
          "If the source file is open in a Pulsar tab it will be closed and the destination opened automatically.",
          "Directories in destPath are created automatically.",
          "Fails if destPath already exists — use copy-file if you want a duplicate instead."
        ].join(" "),
        inputSchema: {
          sourcePath: z.string(),
          destPath:   z.string()
        }
      },
      async ({ sourcePath, destPath }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { sourcePath, destPath });
        try { await fs.promises.access(destPath); throw new Error(`Destination already exists: ${destPath}`); } catch (err) { if (err.message.startsWith("Destination already exists")) throw err; }
        await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
        await fs.promises.rename(sourcePath, destPath);
        const oldEditor = atom.workspace.getTextEditors().find(e => e.getPath() && path.resolve(e.getPath()) === path.resolve(sourcePath));
        if (oldEditor) await retargetEditor(oldEditor, destPath);
        else await atom.workspace.open(destPath);
        return { content: [{ type: "text", text: `Moved: ${sourcePath} -> ${destPath}` }], sourcePath, destPath };
      }
    );
  }

  // ── copy-file ──────────────────────────────────────────────────────────────
  {
    const curTool = "copy-file";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Copy File",
        description: [
          "Copy a file from sourcePath to destPath and open the copy in a new Pulsar tab.",
          "Directories in destPath are created automatically.",
          "Fails if destPath already exists."
        ].join(" "),
        inputSchema: {
          sourcePath: z.string(),
          destPath:   z.string()
        }
      },
      async ({ sourcePath, destPath }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { sourcePath, destPath });
        try { await fs.promises.access(destPath); throw new Error(`Destination already exists: ${destPath}`); } catch (err) { if (err.message.startsWith("Destination already exists")) throw err; }
        await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
        await fs.promises.copyFile(sourcePath, destPath);
        await atom.workspace.open(destPath);
        return { content: [{ type: "text", text: `Copied: ${sourcePath} -> ${destPath}` }], sourcePath, destPath };
      }
    );
  }

  // ── rename-file ─────────────────────────────────────────────────────────────
  {
    const curTool = "rename-file";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Rename File",
        description: [
          "Rename a file within its current directory.",
          "newName must be a bare filename (no path separators) — use move-file for cross-directory moves.",
          "If the file is open in a tab the tab is updated to the new name automatically."
        ].join(" "),
        inputSchema: {
          filePath: z.string(),
          newName:  z.string()
        }
      },
      async ({ filePath, newName }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { filePath, newName });
        if (newName.includes("/") || newName.includes("\\\\")) throw new Error("newName must be a bare filename with no path separators. Use move-file for cross-directory moves.");
        const destPath = path.join(path.dirname(filePath), newName);
        try { await fs.promises.access(destPath); throw new Error(`Destination already exists: ${destPath}`); } catch (err) { if (err.message.startsWith("Destination already exists")) throw err; }
        await fs.promises.rename(filePath, destPath);
        const oldEditor = atom.workspace.getTextEditors().find(e => e.getPath() && path.resolve(e.getPath()) === path.resolve(filePath));
        if (oldEditor) await retargetEditor(oldEditor, destPath);
        else await atom.workspace.open(destPath);
        return { content: [{ type: "text", text: `Renamed: ${path.basename(filePath)} -> ${newName}` }], filePath, destPath };
      }
    );
  }

  // ── create-folder ───────────────────────────────────────────────────────────
  {
    const curTool = "create-folder";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Create Folder",
        description: [
          "Create a directory (and any missing parent directories) at the given path.",
          "Succeeds silently if the directory already exists.",
          "Returns the resolved path that was created."
        ].join(" "),
        inputSchema: {
          folderPath: z.string()
        }
      },
      async ({ folderPath }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { folderPath });
        await fs.promises.mkdir(folderPath, { recursive: true });
        return { content: [{ type: "text", text: `Folder ready: ${folderPath}` }], folderPath };
      }
    );
  }

  // ── rename-folder ────────────────────────────────────────────────────────────
  {
    const curTool = "rename-folder";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Rename / Move Folder",
        description: [
          "Rename or move a folder from sourcePath to destPath.",
          "All files inside are moved with it.",
          "Any open editor tabs pointing inside the old folder path are retargeted to their new paths automatically — undo history is preserved.",
          "Fails if destPath already exists."
        ].join(" "),
        inputSchema: {
          sourcePath: z.string(),
          destPath:   z.string()
        }
      },
      async ({ sourcePath, destPath }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { sourcePath, destPath });
        try { await fs.promises.access(destPath); throw new Error(`Destination already exists: ${destPath}`); } catch (err) { if (err.message.startsWith("Destination already exists")) throw err; }
        const resolvedSrc = path.resolve(sourcePath);
        // Collect all open editors inside the folder before the move
        const editorsInside = atom.workspace.getTextEditors().filter(e => e.getPath() && path.resolve(e.getPath()).startsWith(resolvedSrc + path.sep));
        // Move the folder on disk
        await fs.promises.rename(sourcePath, destPath);
        const resolvedDest = path.resolve(destPath);
        // Retarget each editor to its new path — preserves undo history if setPath is available
        for (const e of editorsInside) {
          const newPath = resolvedDest + path.resolve(e.getPath()).slice(resolvedSrc.length);
          await retargetEditor(e, newPath);
        }
        return {
          content: [{ type: "text", text: `Folder moved: ${sourcePath} -> ${destPath}. ${editorsInside.length} tab(s) retargeted to new paths.` }],
          sourcePath, destPath, retargetedTabs: editorsInside.length
        };
      }
    );
  }

  } // end FILE-OPS GROUP

  // ── CORE GROUP (continued — always on) ────────────────────────────────────
  {
    const curTool = "save-file";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Save File",
        description: [
          "Save the active editor to disk.",
          "Always call this after a sequence of edits to persist changes.",
          "Returns the file path and whether the file was modified before saving."
        ].join(" "),
        inputSchema: {}
      },
      async (args) => {
        console.log(`CMD: ${curTool}, ARGS: ${JSON.stringify(args)}`);

        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        const wasModified = editor.isModified();
        await editor.save();

        return {
          content: [{ type: "text", text: `Saved: ${editor.getPath()}${wasModified ? " (was modified)" : " (no changes)"}` }],
          filePath: editor.getPath(),
          wasModified
        };
      }
    );
  }

  {
    const curTool = "save-all";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Save All Files",
        description: [
          "Save all modified open editor tabs to disk in one call.",
          "Returns a list of which files were saved and a count of how many had unsaved changes."
        ].join(" "),
        inputSchema: {}
      },
      async (args) => {
        console.log(`CMD: ${curTool}, ARGS: ${JSON.stringify(args)}`);

        const editors  = atom.workspace.getTextEditors();
        const saved    = [];
        const skipped  = [];

        for (const editor of editors) {
          if (editor.isModified()) {
            await editor.save();
            saved.push(editor.getPath() || "[untitled]");
          } else {
            skipped.push(editor.getPath() || "[untitled]");
          }
        }

        const summary = `Saved ${saved.length} file(s), skipped ${skipped.length} unchanged.`;
        return {
          content: [{ type: "text", text: JSON.stringify({ summary, saved, skipped }, null, 2) }],
          savedCount: saved.length, saved, skipped
        };
      }
    );
  }

  {
    const curTool = "get-file-summary";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Get File Summary",
        description: [
          "Return a structural summary of any project file without loading the full content.",
          "For C/C++ files returns: all function signatures with line numbers, all #include lines,",
          "all #define lines, and any TODO/FIXME/HACK/NOTE comments with line numbers.",
          "For other file types returns: line count, first 20 lines, and any TODO/FIXME comments.",
          "PREFERRED FIRST CALL: always use this before get-document or read-file to orient yourself - far cheaper and usually enough to plan edits.",
          "Pass filePath to read any file, or omit to summarise the active editor."
        ].join(" "),
        inputSchema: { filePath: z.string().optional() }
      },
      async ({ filePath } = {}) => {
        console.log(`CMD: ${curTool}, ARGS:`, { filePath });

        let text;
        let resolvedPath = filePath;

        if (filePath) {
          try { text = await readFileOrBuffer(filePath); }
          catch (err) { throw new Error(`Cannot read file: ${filePath} - ${err.message}`); }
        } else {
          const editor = atom.workspace.getActiveTextEditor();
          if (!editor) throw new Error("No active editor and no filePath provided.");
          text = editor.getBuffer().getText();
          resolvedPath = editor.getPath() || "[untitled]";
        }

        const lines    = text.split(/\r?\n/);
        const lineCount = lines.length;
        const ext      = (resolvedPath || "").split(".").pop().toLowerCase();
        const isClike  = ["c", "cpp", "cc", "cxx", "h", "hpp", "hh"].includes(ext);

        const summary = { filePath: resolvedPath, lineCount, functions: [], includes: [], defines: [], todos: [] };

        const fnRe      = /^(?:(?:static|inline|extern|const|unsigned|signed|struct|enum)\s+)*[\w\s*]+\b(\w+)\s*\([^;)]*\)\s*(?:\{|$)/;
        const includeRe = /^\s*#\s*include\s*.+/;
        const defineRe  = /^\s*#\s*define\s+\S+/;
        const todoRe    = /\b(TODO|FIXME|HACK|NOTE|XXX)\b/i;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const n    = i + 1;

          if (isClike) {
            const fnMatch = fnRe.exec(line);
            if (fnMatch && !line.trim().startsWith("//") && !line.trim().startsWith("*")) {
              summary.functions.push({ line: n, name: fnMatch[1], signature: line.trim() });
            }
            if (includeRe.test(line)) summary.includes.push({ line: n, text: line.trim() });
            if (defineRe.test(line))  summary.defines.push({ line: n, text: line.trim() });
          }

          const todoMatch = todoRe.exec(line);
          if (todoMatch) summary.todos.push({ line: n, kind: todoMatch[1].toUpperCase(), text: line.trim() });
        }

        if (!isClike) {
          summary.firstLines = lines.slice(0, 20).map((t, i) => ({ n: i + 1, text: t }));
        }

        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
          lineCount,
          functionCount: summary.functions.length,
          includeCount:  summary.includes.length,
          defineCount:   summary.defines.length,
          todoCount:     summary.todos.length
        };
      }
    );
  }

  // ── FILE-OPS GROUP (part 2: project inspection tools) ────────────────────
  if (g('fileOps')) {
  {
    const curTool = "get-includes-and-defines";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Get Includes and Defines",
        description: [
          "Return all #include and #define lines with their line numbers from any project file.",
          "Much cheaper than get-document for large C/C++ files when you just need the header inventory.",
          "Pass filePath to read any file, or omit to use the active editor.",
          "Also returns #ifdef/#ifndef/#if blocks so you can see conditional compilation guards."
        ].join(" "),
        inputSchema: { filePath: z.string().optional() }
      },
      async ({ filePath } = {}) => {
        console.log(`CMD: ${curTool}, ARGS:`, { filePath });

        let text;
        let resolvedPath = filePath;

        if (filePath) {
          try { text = await readFileOrBuffer(filePath); }
          catch (err) { throw new Error(`Cannot read file: ${filePath} - ${err.message}`); }
        } else {
          const editor = atom.workspace.getActiveTextEditor();
          if (!editor) throw new Error("No active editor and no filePath provided.");
          text = editor.getBuffer().getText();
          resolvedPath = editor.getPath() || "[untitled]";
        }

        const lines    = text.split(/\r?\n/);
        const includes = [];
        const defines  = [];
        const conditionals = [];

        const includeRe     = /^\s*#\s*include\s*.+/;
        const defineRe      = /^\s*#\s*define\s+.+/;
        const conditionalRe = /^\s*#\s*(ifdef|ifndef|if|elif|else|endif)\b.*/;
        const undefRe       = /^\s*#\s*undef\s+.+/;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          const n    = i + 1;
          if (includeRe.test(line))     includes.push({ line: n, text: line });
          else if (defineRe.test(line) || undefRe.test(line)) defines.push({ line: n, text: line });
          else if (conditionalRe.test(line)) conditionals.push({ line: n, text: line });
        }

        const result = { filePath: resolvedPath, includes, defines, conditionals };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          includeCount: includes.length, defineCount: defines.length, conditionalCount: conditionals.length
        };
      }
    );
  }

  {
    const curTool = "list-project-functions";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "List Project Functions",
        description: [
          "List every function definition across all project files (or a glob-filtered subset).",
          "Returns file path, function name, line number, and signature for each function.",
          "Use glob to restrict to e.g. '**/*.c' or '**/*.h'.",
          "Essential for navigating large multi-file codebases and Ghidra decompiled output."
        ].join(" "),
        inputSchema: {
          glob:  z.string().optional(),
          query: z.string().optional()
        }
      },
      async ({ glob = "", query = "" } = {}) => {
        console.log(`CMD: ${curTool}, ARGS:`, { glob, query });

        const roots = atom.project.getPaths();
        if (!roots.length) throw new Error("No project root open.");

        let allFiles = [];
        for (const root of roots) allFiles = allFiles.concat(await walkDir(root));

        const effectiveGlob = glob || "**/*.{c,cpp,cc,cxx,h,hpp}";
        const globRe = globToRegex(effectiveGlob);
        allFiles = allFiles.filter(f => globRe.test(f.replace(/\\/g, "/")));

        const queryRe = query ? new RegExp(escapeRegex(query), "i") : null;
        const fnRe = /^(?:(?:static|inline|extern|const|unsigned|signed|long|short|struct|enum|void)\s+)*[\w\s*]+\b(\w+)\s*\([^;)]*\)\s*(?:\{|$)/;

        const results = [];

        for (const filePath of allFiles) {
          let text;
          try { text = await fs.promises.readFile(filePath, "utf8"); } catch { continue; }
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
            const m = fnRe.exec(line);
            if (m) {
              const name = m[1];
              if (queryRe && !queryRe.test(name)) continue;
              results.push({ filePath, line: i + 1, name, signature: line.trim() });
            }
          }
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ totalFunctions: results.length, functions: results }, null, 2) }],
          totalFunctions: results.length
        };
      }
    );
  }
  } // end FILE-OPS GROUP (part 2)

  // ── SEARCH GROUP ──────────────────────────────────────────────────────────
  if (g('search')) {
  {
    const curTool = "grep-file";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Grep File",
        description: [
          "Search for a pattern in a specific file (or the active editor if no filePath given) and return matching lines with their 1-based line numbers. When filePath is provided, reads from the live buffer if the file is open in Pulsar, otherwise falls back to disk — unsaved edits are always reflected.",
          "Much cheaper than read-file + manual scan — only matched lines are returned.",
          "Supports regex and case-insensitive matching.",
          "Returns matchCount and truncation flag if results exceed maxMatches.",
          "Use this as the primary way to locate content in a known file before making edits."
        ].join(" "),
        inputSchema: {
          query:         z.string(),
          filePath:      z.string().optional(),
          regex:         z.boolean().optional(),
          caseSensitive: z.boolean().optional(),
          maxMatches:    z.number().optional()
        }
      },
      async ({ query, filePath, regex = false, caseSensitive = false, maxMatches = 200 }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { query, filePath, regex, caseSensitive, maxMatches });

        let text;
        let resolvedPath = filePath;

        if (filePath) {
          try { text = await readFileOrBuffer(filePath); }
          catch (err) { throw new Error(`Cannot read file: ${filePath} - ${err.message}`); }
        } else {
          const editor = atom.workspace.getActiveTextEditor();
          if (!editor) throw new Error("No active editor and no filePath provided.");
          text = editor.getBuffer().getText();
          resolvedPath = editor.getPath() || "[untitled]";
        }

        const source  = regex ? query : escapeRegex(query);
        const flags   = caseSensitive ? "" : "i";
        let pattern;
        try { pattern = new RegExp(source, flags); }
        catch (e) { throw new Error(`Invalid regex: ${e.message}`); }

        const lines   = text.split(/\r?\n/);
        const matches = [];
        let truncated = false;

        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            matches.push({ line: i + 1, text: lines[i] });
            if (matches.length >= maxMatches) { truncated = true; break; }
          }
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ filePath: resolvedPath, matchCount: matches.length, truncated, matches }, null, 2) }],
          matchCount: matches.length, truncated
        };
      }
    );
  }

  {
    const curTool = "grep-project";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Grep Project",
        description: [
          "Search for a pattern across all project files (or a glob-filtered subset) and return matching lines with file paths and line numbers.",
          "Prefer this over search-across-files for straightforward line-oriented searches — same power, cleaner output.",
          "Use glob to restrict to e.g. '**/*.js' or '**/*.c'.",
          "Results are capped at maxMatches (default 200). Returns truncation flag when capped."
        ].join(" "),
        inputSchema: {
          query:         z.string(),
          glob:          z.string().optional(),
          regex:         z.boolean().optional(),
          caseSensitive: z.boolean().optional(),
          maxMatches:    z.number().optional()
        }
      },
      async ({ query, glob = "", regex = false, caseSensitive = false, maxMatches = 200 }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { query, glob, regex, caseSensitive, maxMatches });

        const roots = atom.project.getPaths();
        if (!roots.length) throw new Error("No project root open.");

        const source = regex ? query : escapeRegex(query);
        const flags  = caseSensitive ? "" : "i";
        let pattern;
        try { pattern = new RegExp(source, flags); }
        catch (e) { throw new Error(`Invalid regex: ${e.message}`); }

        let allFiles = [];
        for (const root of roots) allFiles = allFiles.concat(await walkDir(root));
        if (glob) { const globRe = globToRegex(glob); allFiles = allFiles.filter(f => globRe.test(f.replace(/\\/g, "/"))); }

        const matches = [];
        let truncated = false;

        outer:
        for (const filePath of allFiles) {
          let text;
          try { text = await fs.promises.readFile(filePath, "utf8"); } catch { continue; }
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i])) {
              matches.push({ filePath, line: i + 1, text: lines[i] });
              if (matches.length >= maxMatches) { truncated = true; break outer; }
            }
          }
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ matchCount: matches.length, truncated, matches }, null, 2) }],
          matchCount: matches.length, truncated
        };
      }
    );
  }
  } // end SEARCH GROUP (grep-file, grep-project)

  // ── FILE-OPS GROUP (part 3: read-lines) ──────────────────────────────────
  if (g('fileOps')) {
  {
    const curTool = "read-lines";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Read Lines",
        description: [
          "Read a specific line range (startLine to endLine, inclusive, 1-based) from a file or the active editor.",
          "Far cheaper than read-file for large files when you only need a section.",
          "Pass filePath to read any project file without opening it.",
          "Omit filePath to read from the active editor. When filePath is provided, reads from the live buffer if the file is open in Pulsar, otherwise falls back to disk.",
          "Returns lines with their original 1-based line numbers so they can be used directly with other tools."
        ].join(" "),
        inputSchema: {
          startLine: z.number(),
          endLine:   z.number(),
          filePath:  z.string().optional()
        }
      },
      async ({ startLine, endLine, filePath }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { startLine, endLine, filePath });

        let text;
        let resolvedPath = filePath;

        if (filePath) {
          try { text = await readFileOrBuffer(filePath); }
          catch (err) { throw new Error(`Cannot read file: ${filePath} - ${err.message}`); }
        } else {
          const editor = atom.workspace.getActiveTextEditor();
          if (!editor) throw new Error("No active editor and no filePath provided.");
          text = editor.getBuffer().getText();
          resolvedPath = editor.getPath() || "[untitled]";
        }

        const allLines  = text.split(/\r?\n/);
        const lineCount = allLines.length;

        if (startLine < 1) throw new Error("startLine must be >= 1.");
        if (endLine < startLine) throw new Error(`endLine (${endLine}) must be >= startLine (${startLine}).`);
        if (startLine > lineCount) throw new Error(`startLine (${startLine}) exceeds file line count (${lineCount}).`);

        const clampedEnd = Math.min(endLine, lineCount);
        const slice      = allLines.slice(startLine - 1, clampedEnd).map((t, i) => ({ n: startLine + i, text: t }));

        return {
          content: [{ type: "text", text: JSON.stringify({ filePath: resolvedPath, totalLines: lineCount, returnedLines: slice.length, lines: slice }, null, 2) }],
          totalLines: lineCount, returnedLines: slice.length
        };
      }
    );
  }
  } // end FILE-OPS GROUP (part 3)

  // ── EDIT GROUP (part 2: replace-all) ─────────────────────────────────────
  if (g('edit')) {
  {
    const curTool = "replace-all";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Replace All",
        description: [
          "Find and replace ALL occurrences of query with replacement in the active editor.",
          "Equivalent to str_replace applied to all occurrences — exists as a shortcut so you never accidentally replace only the first match.",
          "Supports regex and case-insensitive matching.",
          "Returns matchCount so you can verify how many occurrences were replaced. Supports dryRun:true to preview the match count without writing any changes — use this before committing broad or regex queries."
        ].join(" "),
        inputSchema: {
          query:         z.string(),
          replacement:   z.string(),
          regex:         z.boolean().optional(),
          caseSensitive: z.boolean().optional(),
          dryRun:        z.boolean().optional()
        }
      },
      async ({ query, replacement, regex = false, caseSensitive = false, dryRun = false }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { query, replacement, regex, caseSensitive });

        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer = editor.getBuffer();

        const source = regex ? query : escapeRegex(query);
        const flags  = "g" + (caseSensitive ? "" : "i");
        let pattern;
        try { pattern = new RegExp(source, flags); }
        catch (e) { throw new Error(`Invalid regex: ${e.message}`); }

        const originalText = buffer.getText();
        const allLines     = buffer.getLines();
        let matchCount = 0;
        const newText = originalText.replace(pattern, () => { matchCount++; return replacement; });

        if (matchCount === 0) {
          editStats.replace_all.fails.noMatch++;
          // Fuzzy: find closest area in file to the query words
          const words = query.trim().split(/\s+/).filter(w => w.length > 3);
          let fuzzyRow = -1, bestScore = 0;
          for (let i = 0; i < allLines.length; i++) {
            const score = words.filter(w => allLines[i].toLowerCase().includes(w.toLowerCase())).length;
            if (score > bestScore) { bestScore = score; fuzzyRow = i; }
          }
          const parts = [`❌ No matches found for ${JSON.stringify(query)} — nothing replaced.`];
          if (fuzzyRow >= 0 && bestScore > 0) {
            const r = 4;
            const cs = Math.max(0, fuzzyRow - r), ce = Math.min(allLines.length - 1, fuzzyRow + r);
            const ctx = allLines.slice(cs, ce + 1).map((l, i) => `${String(cs + i + 1).padStart(4)}: ${l}`).join("\n");
            parts.push(`\n📍 Closest area found (lines ${cs + 1}–${ce + 1}):\n${ctx}`);
            parts.push(`\nIf this is the right location, check for case or whitespace differences in your query.`);
          }
          return { content: [{ type: "text", text: parts.join("\n") }], matchCount: 0, dryRun };
        }

        if (dryRun) {
          editStats.replace_all.dryRuns++;
          // Show all match locations
          const singleFlags = (caseSensitive ? "" : "i");
          const singlePat   = new RegExp(source, singleFlags);
          const hits = [];
          for (let i = 0; i < allLines.length; i++) {
            if (singlePat.test(allLines[i])) hits.push(`  line ${i + 1}: ${allLines[i].trim()}`);
          }
          const preview = hits.slice(0, 20).join("\n") + (hits.length > 20 ? `\n  … and ${hits.length - 20} more` : "");
          return {
            content: [{ type: "text", text: [
              `✅ DRY RUN: ${matchCount} occurrence${matchCount === 1 ? "" : "s"} of ${JSON.stringify(query)} would be replaced.`,
              `\nMatch locations:\n${preview}`,
              `\nReply with the same call without dryRun (or dryRun:false) to commit.`
            ].join("\n") }],
            matchCount, dryRun: true
          };
        }

        buffer.setTextViaDiff(newText);
        decorateEditedLines(editor, originalText, newText);
        editStats.replace_all.hits++;

        return {
          content: [{ type: "text", text: `✅ Replaced all ${matchCount} occurrence${matchCount === 1 ? "" : "s"} of ${JSON.stringify(query)}.` }],
          matchCount, dryRun: false
        };
      }
    );
  }

  } // end EDIT GROUP (part 2)

  // ── FILE-OPS GROUP (part 4: file-line-count) ─────────────────────────────
  if (g('fileOps')) {
  {
    const curTool = "file-line-count";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "File Line Count",
        description: [
          "Return the line count of any project file without loading its content into context.",
          "Cheap orientation step before using read-lines or grep-file on a large file.",
          "Pass filePath to check any file. Omit to check the active editor."
        ].join(" "),
        inputSchema: { filePath: z.string().optional() }
      },
      async ({ filePath } = {}) => {
        console.log(`CMD: ${curTool}, ARGS:`, { filePath });

        let lineCount;
        let resolvedPath = filePath;

        if (filePath) {
          let text;
          try { text = await readFileOrBuffer(filePath); }
          catch (err) { throw new Error(`Cannot read file: ${filePath} - ${err.message}`); }
          lineCount = text.split(/\r?\n/).length;
        } else {
          const editor = atom.workspace.getActiveTextEditor();
          if (!editor) throw new Error("No active editor and no filePath provided.");
          lineCount    = editor.getBuffer().getLineCount();
          resolvedPath = editor.getPath() || "[untitled]";
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ filePath: resolvedPath, lineCount }, null, 2) }],
          lineCount
        };
      }
    );
  }
  } // end FILE-OPS GROUP (part 4)

  // ── FILE-OPS GROUP (part 5: apply-patch) ──────────────────────────────────
  if (g('fileOps')) {
  {
    const curTool = "apply-patch";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Apply Patch",
        description: [
          "Apply a unified diff patch to the active editor buffer.",
          "PREFERRED for targeted edits to known locations — more token-efficient than replace-document for small changes.",
          "Uses context-line anchoring: the @@ line numbers are hints only — the tool searches nearby if the file has shifted, so it survives minor line number drift.",
          "Patch format: standard unified diff with @@ hunk headers and +/- lines. Include 3 context lines (unchanged) around each change for reliable anchoring.",
          "For Ghidra decompiled output with repetitive variable names, increase context lines to 5-6 for reliable matching.",
          "LARGE EDIT WARNING: for edits touching more than ~30% of the file, replace-document or replace-function-body will be cheaper in tokens than a large patch — consider those instead.",
          "FAILURE TRACKING: this tool counts consecutive patch failures. After 3 failures it will suggest switching to replace-document or replace-function-body. Reset by calling it successfully.",
          "dryRun:true validates the patch and reports what would change without writing. Always use dryRun first on untested patches.",
          "Returns linesAdded, linesRemoved, hunksApplied, and a diff of the actual change for verification."
        ].join(" "),
        inputSchema: {
          patch:       z.string(),
          dryRun:      z.boolean().optional(),
          fuzzFactor:  z.number().optional()
        }
      },
      async ({ patch, dryRun = false, fuzzFactor = 0 }) => {
        dbg(curTool, "ARGS", { patchLength: patch.length, dryRun, fuzzFactor });

        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        const buffer       = editor.getBuffer();
        const originalText = buffer.getText();
        const filePath     = editor.getPath() || "[untitled]";
        const fileName     = path.basename(filePath);

        // Ensure patch has a file header — applyPatch requires it.
        // If the LLM omitted it, synthesize one from the active filename.
        let normalizedPatch = patch.trim();
        if (!normalizedPatch.startsWith("---")) {
          normalizedPatch = `--- a/${fileName}\n+++ b/${fileName}\n` + normalizedPatch;
        }

        // Count lines that would be added/removed for the large-edit warning
        const patchLines   = normalizedPatch.split(/\r?\n/);
        const addedLines   = patchLines.filter(l => l.startsWith("+") && !l.startsWith("+++")).length;
        const removedLines = patchLines.filter(l => l.startsWith("-") && !l.startsWith("---")).length;
        const hunkCount    = patchLines.filter(l => l.startsWith("@@")).length;
        const totalFile    = originalText.split(/\r?\n/).length;
        const changeRatio  = (addedLines + removedLines) / Math.max(totalFile, 1);

        // Large edit warning threshold: >30% of file touched
        const largeEditWarning = changeRatio > 0.3
          ? ` LARGE EDIT WARNING: this patch touches ~${Math.round(changeRatio * 100)}% of the file (${addedLines + removedLines} lines changed out of ${totalFile}). Consider replace-document or replace-function-body instead for better token efficiency.`
          : "";

        // Attempt to apply the patch
        let result;
        try {
          result = applyPatch(originalText, normalizedPatch, { fuzzFactor });
        } catch (e) {
          patchFailures.count++;
          editStats.apply_patch.fails.exception++;
          dbg(curTool, `FAIL #${patchFailures.count} (exception)`, { error: e.message });

          // Try to find where in the file the patch was aimed
          const hunkMatch = normalizedPatch.match(/@@\s*-(\d+)/);
          const hunkLine  = hunkMatch ? parseInt(hunkMatch[1], 10) : -1;
          const bufLines  = buffer.getLines();
          const parts     = [`❌ Patch threw an error: ${e.message}. Failure #${patchFailures.count} this session.`];

          if (hunkLine > 0) {
            const r  = 5;
            const cs = Math.max(0, hunkLine - 1 - r);
            const ce = Math.min(bufLines.length - 1, hunkLine - 1 + r);
            const ctx = bufLines.slice(cs, ce + 1).map((l, i) => `${String(cs + i + 1).padStart(4)}: ${l}`).join("\n");
            parts.push(`\n📍 Buffer around hunk target (line ${hunkLine}):\n${ctx}`);
          }

          if (patchFailures.count >= 3) {
            parts.push(`\n🔁 After ${patchFailures.count} failures, switch to str_replace for targeted edits, replace-function-body for whole-function rewrites, or replace-document for large changes.`);
          }

          return { content: [{ type: "text", text: parts.join("\n") }], applied: false, patchFailures: patchFailures.count };
        }

        // applyPatch returns false (not throws) when context lines don't match
        if (result === false) {
          patchFailures.count++;
          editStats.apply_patch.fails.contextMismatch++;
          dbg(curTool, `FAIL #${patchFailures.count} (context mismatch)`, { hunks: hunkCount });

          // Extract context lines from the first failing hunk to find fuzzy location
          const hunkMatch  = normalizedPatch.match(/@@[^@@]*@@\n([\s\S]*?)(?=\n@@|$)/);
          const hunkBody   = hunkMatch ? hunkMatch[1] : "";
          const ctxLines   = hunkBody.split("\n")
            .filter(l => l.startsWith(" ") || l.startsWith("-"))
            .map(l => l.slice(1).trim())
            .filter(l => l.length > 3)
            .slice(0, 4);

          const bufLines   = buffer.getLines();
          let fuzzyRow     = -1, bestScore = 0;
          for (let i = 0; i < bufLines.length; i++) {
            const score = ctxLines.filter(c => bufLines[i].includes(c)).length;
            if (score > bestScore) { bestScore = score; fuzzyRow = i; }
          }

          const parts = [`❌ Patch failed: context lines did not match anywhere in the file. Failure #${patchFailures.count} this session.`];

          if (fuzzyRow >= 0 && bestScore > 0) {
            const r  = 5;
            const cs = Math.max(0, fuzzyRow - r);
            const ce = Math.min(bufLines.length - 1, fuzzyRow + r);
            const ctx = bufLines.slice(cs, ce + 1).map((l, i) => `${String(cs + i + 1).padStart(4)}: ${l}`).join("\n");
            parts.push(`\n📍 Closest matching area in buffer (lines ${cs + 1}–${ce + 1}):\n${ctx}`);
            parts.push(`\n⚠️  Compare this to the context lines in your patch — whitespace or indentation differences are the most common cause.`);
          }

          if (patchFailures.count >= 3) {
            parts.push(`\n🔁 After ${patchFailures.count} failures, consider switching to str_replace for targeted edits, replace-function-body for whole-function rewrites, or replace-document for large changes.`);
          } else {
            parts.push(`\n   Tip: call grep-file or read-lines to get the exact current content, then regenerate the patch with correct context lines.`);
          }

          return { content: [{ type: "text", text: parts.join("\n") }], applied: false, patchFailures: patchFailures.count };
        }

        // Dry run — report what would change without writing
        if (dryRun) {
          editStats.apply_patch.dryRuns++;
          if (largeEditWarning) editStats.apply_patch.largeEditWarnings++;
          const hunks      = diffLines(originalText, result);
          const dryAdded   = hunks.filter(h => h.added).reduce((n, h) => n + (h.count ?? 0), 0);
          const dryRemoved = hunks.filter(h => h.removed).reduce((n, h) => n + (h.count ?? 0), 0);
          dbg(curTool, "DRY RUN OK", { hunks: hunkCount, added: dryAdded, removed: dryRemoved });

          // Build a compact inline diff (cap at 60 lines to keep response tight)
          const diffOut = [];
          let lineNo = 1;
          for (const h of hunks) {
            const hLines = h.value.split(/\r?\n/);
            if (hLines[hLines.length - 1] === "") hLines.pop();
            if (h.added)        hLines.forEach(l => diffOut.push(`+ ${l}`));
            else if (h.removed) hLines.forEach(l => diffOut.push(`- ${l}`));
            else                hLines.slice(0, 2).forEach(l => diffOut.push(`  ${l}`));
          }
          const diffSnippet = diffOut.slice(0, 60).join("\n") + (diffOut.length > 60 ? "\n  … (truncated)" : "");

          return {
            content: [{ type: "text", text: [
              `✅ DRY RUN — patch applies cleanly. ${hunkCount} hunk(s), +${dryAdded}/−${dryRemoved} lines.`,
              largeEditWarning ? `\n${largeEditWarning}` : "",
              `\nDiff preview:\n${diffSnippet}`,
              `\nReply with the same call without dryRun (or dryRun:false) to commit.`
            ].filter(Boolean).join("\n") }],
            dryRun: true, hunksApplied: hunkCount, linesAdded: dryAdded, linesRemoved: dryRemoved,
            largeEditWarning: !!largeEditWarning
          };
        }

        // Apply the patch to the live buffer
        const beforeText = buffer.getText();
        buffer.setTextViaDiff(result);
        decorateEditedLines(editor, beforeText, result);

        // Reset failure counter on success
        patchFailures.count = 0;
        editStats.apply_patch.hits++;
        if (largeEditWarning) editStats.apply_patch.largeEditWarnings++;
        dbg(curTool, "SUCCESS — failure counter reset", { hunks: hunkCount, dryRun: false });

        // Compute actual diff for verification
        const hunks      = diffLines(originalText, result);
        const linesAdded   = hunks.filter(h => h.added).reduce((n, h) => n + (h.count ?? 0), 0);
        const linesRemoved = hunks.filter(h => h.removed).reduce((n, h) => n + (h.count ?? 0), 0);
        const newLineCount = buffer.getLineCount();

        return {
          content: [{ type: "text", text: `Patch applied. ${hunkCount} hunk(s), +${linesAdded}/-${linesRemoved} lines. New line count: ${newLineCount}.${largeEditWarning}` }],
          hunksApplied: hunkCount, linesAdded, linesRemoved, newLineCount,
          largeEditWarning: !!largeEditWarning, dryRun: false
        };
      }
    );
  }
  } // end FILE-OPS GROUP (part 5)

  // ── DIAGNOSTICS GROUP ────────────────────────────────────────────────────
  if (g('diagnostics')) {
  {
    const curTool = "get-diagnostics";
    console.log("Registering Tool: " + curTool);

    async function findCompiler() {
      const candidates = IS_WINDOWS
        ? ["gcc", "clang", "cl"]
        : process.platform === "darwin"
          ? ["clang", "gcc", "cc"]
          : ["gcc", "clang", "cc"];

      for (const exe of candidates) {
        const probe = IS_WINDOWS ? `where ${exe}` : `which ${exe}`;
        const found = await new Promise(resolve => {
          _exec(probe, { timeout: 3000 }, err => resolve(!err));
        });
        if (found) return exe;
      }
      return null;
    }

    function buildCmd(compiler, filePath, includePaths, compilerOptions) {
      if (compiler === "cl") {
        const msvcIncludes = includePaths.replace(/-I/g, "/I");
        return `cl /Zs /W3 ${msvcIncludes} ${compilerOptions} "${filePath}"`;
      }
      return `${compiler} -fsyntax-only -Wall -Wextra ${includePaths} ${compilerOptions} "${filePath}"`;
    }

    const gccRe  = /^(.+?):(\d+):(\d+):\s*(error|warning|note):\s*(.+)$/;
    const msvcRe = /^(.+?)\((\d+)\)\s*:\s*(error|warning)\s+\w+:\s*(.+)$/;

    function parseLine(line, compiler) {
      if (compiler === "cl") {
        const m = msvcRe.exec(line);
        if (m) return { severity: m[3], file: m[1], line: parseInt(m[2], 10), col: 0, message: m[4], source: "cl" };
      } else {
        const m = gccRe.exec(line);
        if (m) return { severity: m[4], file: m[1], line: parseInt(m[2], 10), col: parseInt(m[3], 10), message: m[5], source: compiler };
      }
      return null;
    }

    server.registerTool(curTool,
      {
        title: "Get Diagnostics",
        description: [
          "Syntax-check the active C/C++ file (or all project C/C++ files) and return errors and warnings.",
          "Automatically detects the available compiler: gcc, clang, or cl (MSVC) depending on platform.",
          "scope: 'file' (default) lints only the active file; 'project' lints all .c/.cpp files.",
          "compilerOptions: extra flags passed to the compiler (e.g. '-std=c11 -DDEBUG').",
          "Each result includes severity, file, line, column, message, and the compiler used.",
          "IMPORTANT: This tool lints the file ON DISK, not the editor buffer. Always call save-file first."
        ].join(" "),
        inputSchema: {
          scope:           z.enum(["file", "project"]).optional(),
          compilerOptions: z.string().optional()
        }
      },
      async ({ scope = "file", compilerOptions = "" } = {}) => {
        console.log(`CMD: ${curTool}, ARGS:`, { scope, compilerOptions });

        const compiler = await findCompiler();
        if (!compiler) throw new Error("No C compiler found. Install gcc, clang, or cl and ensure it is on PATH.");

        const roots        = atom.project.getPaths();
        const cwd          = roots[0] ?? null;
        const includePaths = roots.map(r => `-I"${r}"`).join(" ");
        const shell        = IS_WINDOWS ? "powershell.exe" : "/bin/sh";

        let filesToLint = [];
        if (scope === "file") {
          const editor = atom.workspace.getActiveTextEditor();
          if (!editor || !editor.getPath()) throw new Error("No active file to lint.");
          filesToLint = [editor.getPath()];
        } else {
          let allFiles = [];
          for (const root of roots) allFiles = allFiles.concat(await walkDir(root));
          filesToLint = allFiles.filter(f => /\.(c|cpp|cc|cxx)$/i.test(f));
        }

        const results = [];
        for (const filePath of filesToLint) {
          const cmd = buildCmd(compiler, filePath, includePaths, compilerOptions);
          await new Promise((resolve) => {
            _exec(cmd, { cwd, timeout: 15000, maxBuffer: 1024 * 1024, shell },
              (err, stdout, stderr) => {
                const output = (stdout + "\n" + stderr).split(/\r?\n/);
                for (const line of output) {
                  const parsed = parseLine(line, compiler);
                  if (parsed) results.push(parsed);
                }
                resolve();
              }
            );
          });
        }

        const errors   = results.filter(r => r.severity === "error").length;
        const warnings = results.filter(r => r.severity === "warning").length;
        const summary  = `Compiler: ${compiler} | ${errors} error(s), ${warnings} warning(s) in ${scope}.`;

        return {
          content: [{ type: "text", text: JSON.stringify({ summary, compiler, total: results.length, diagnostics: results }, null, 2) }],
          total: results.length, errors, warnings, compiler
        };
      }
    );
  }
  } // end DIAGNOSTICS GROUP

  // ── SAFETY GROUP (part 2: diff-preview, checkpoint, restore, list) ────────
  if (g('safety')) {
  {
    const curTool = "diff-preview";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Diff Preview",
        description: [
          "Show a unified diff between the current buffer and a proposed replacement text, without applying any changes.",
          "Use this before replace-document or replace-function-body to verify edits are correct.",
          "Returns a unified diff string plus a summary of lines added/removed. After accepting the changes and applying them, always call save-file to persist to disk."
        ].join(" "),
        inputSchema: { proposedText: z.string() }
      },
      async ({ proposedText }) => {
        console.log(`CMD: ${curTool}`);
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        const original  = editor.getBuffer().getText();
        const origLines = original.split(/\r?\n/);
        const propLines = proposedText.split(/\r?\n/);
        const hunks     = diffLines(original, proposedText);
        let added = 0, removed = 0;

        // Build annotated diff with line numbers
        const unifiedLines = [];
        let origLineNo = 1;
        for (const h of hunks) {
          const lines = h.value.split(/\r?\n/);
          if (lines[lines.length - 1] === "") lines.pop();
          const count = lines.length;
          if (h.added) {
            added += count;
            lines.forEach(l => unifiedLines.push(`+      ${l}`));
          } else if (h.removed) {
            removed += count;
            lines.forEach((l, i) => unifiedLines.push(`- ${String(origLineNo + i).padStart(4)} ${l}`));
            origLineNo += count;
          } else {
            lines.forEach((l, i) => unifiedLines.push(`  ${String(origLineNo + i).padStart(4)} ${l}`));
            origLineNo += count;
          }
        }

        const unchanged = added === 0 && removed === 0;
        if (unchanged) {
          return {
            content: [{ type: "text", text: "No changes — proposed text is identical to the buffer." }],
            linesAdded: 0, linesRemoved: 0, unchanged: true, canCommit: false
          };
        }

        // Whitespace-only check: are the only differences whitespace?
        const origTrimmed = origLines.map(l => l.trim()).join("\n");
        const propTrimmed = propLines.map(l => l.trim()).join("\n");
        const wsOnly      = origTrimmed === propTrimmed;

        // Fuzzy similarity: what fraction of proposed lines exist verbatim in original?
        const origSet     = new Set(origLines.map(l => l.trim()).filter(l => l.length > 2));
        const matchCount  = propLines.filter(l => origSet.has(l.trim()) && l.trim().length > 2).length;
        const similarity  = propLines.length > 0 ? matchCount / propLines.length : 0;
        const canCommit   = similarity > 0.7 || wsOnly;

        const parts = [
          `Diff: +${added}/−${removed} lines. Similarity: ${Math.round(similarity * 100)}%.`,
          wsOnly ? `\n⚠️  WHITESPACE ONLY — all content matches but indentation/spacing differs. Safe to commit if that is intentional.` : "",
          !wsOnly && canCommit ? `\n✅ High similarity (${Math.round(similarity * 100)}%) — looks correct. Use replace-document or replace-function-body to commit.` : "",
          !wsOnly && !canCommit ? `\n⚠️  Low similarity (${Math.round(similarity * 100)}%) — review the diff carefully before committing.` : "",
          `\n${unifiedLines.join("\n")}`
        ];

        return {
          content: [{ type: "text", text: parts.filter(Boolean).join("\n") }],
          linesAdded: added, linesRemoved: removed, unchanged: false,
          similarity: Math.round(similarity * 100), wsOnly, canCommit
        };
      }
    );
  }

  {
    const curTool = "checkpoint";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Checkpoint",
        description: [
          "Save a named snapshot of the current buffer so edits can be rolled back with restore-checkpoint.",
          "name defaults to 'default'. Checkpoints are in-memory and cleared on server restart. WARNING: if this MCP server's own source files (mcp-registration.js, pulsar-edit-mcp-server.js, ghidra-tools.js) are edited and saved, Pulsar will reload the package and restart the server — all checkpoints will be lost immediately. Always save test files to disk with save-file as an additional safety net before editing server source.",
          "Call this before any risky multi-step edit sequence."
        ].join(" "),
        inputSchema: { name: z.string().optional() }
      },
      async ({ name = "default" } = {}) => {
        console.log(`CMD: ${curTool}, ARGS:`, { name });
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const text = editor.getBuffer().getText();
        checkpoints.set(name, { text, filePath: editor.getPath(), savedAt: new Date().toISOString() });
        return {
          content: [{ type: "text", text: `Checkpoint '${name}' saved (${text.split(/\r?\n/).length} lines).` }],
          name, lineCount: text.split(/\r?\n/).length
        };
      }
    );
  }

  {
    const curTool = "restore-checkpoint";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Restore Checkpoint",
        description: [
          "Restore the buffer to a previously saved checkpoint by name.",
          "name defaults to 'default'. Use list-checkpoints to see available snapshots.",
          "This is a full buffer replace — use diff-preview first to see what will change. If the checkpoint is missing (returns not found), the server was likely restarted by a server source file save — use undo or the saved disk file to recover."
        ].join(" "),
        inputSchema: { name: z.string().optional() }
      },
      async ({ name = "default" } = {}) => {
        console.log(`CMD: ${curTool}, ARGS:`, { name });
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const cp = checkpoints.get(name);
        if (!cp) throw new Error(`No checkpoint named '${name}'. Available: ${[...checkpoints.keys()].join(", ") || "none"}`);
        const originalText = editor.getBuffer().getText();
        editor.getBuffer().setTextViaDiff(cp.text);
        decorateEditedLines(editor, originalText, cp.text);
        return {
          content: [{ type: "text", text: `Restored checkpoint '${name}' (saved at ${cp.savedAt}).` }],
          name, savedAt: cp.savedAt
        };
      }
    );
  }

  {
    const curTool = "list-checkpoints";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "List Checkpoints",
        description: "List all in-memory checkpoints with their names, file paths, and save times.",
        inputSchema: {}
      },
      async () => {
        const list = [...checkpoints.entries()].map(([name, cp]) => ({
          name, filePath: cp.filePath, savedAt: cp.savedAt, lineCount: cp.text.split(/\r?\n/).length
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
          count: list.length
        };
      }
    );
  }
  } // end SAFETY GROUP (part 2)

  // ── SEARCH GROUP (part 2: search-symbol) ─────────────────────────────────
  if (g('search')) {
  {
    const curTool = "search-symbol";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Search Symbol",
        description: [
          "Find all uses of a C symbol (function, variable, macro) across the project using whole-word matching.",
          "More precise than grep-project for symbol lookup — wraps the query in word boundaries automatically.",
          "Returns each match with file, line number, and line text. Use glob to restrict file types.",
          "set definitionsOnly:true to return only lines that look like definitions/declarations."
        ].join(" "),
        inputSchema: {
          symbol:          z.string(),
          glob:            z.string().optional(),
          definitionsOnly: z.boolean().optional(),
          maxMatches:      z.number().optional()
        }
      },
      async ({ symbol, glob = "**/*.{c,cpp,h,hpp}", definitionsOnly = false, maxMatches = 200 }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { symbol, glob, definitionsOnly, maxMatches });
        const roots = atom.project.getPaths();
        if (!roots.length) throw new Error("No project root open.");

        const wordRe = new RegExp(`\\b${escapeRegex(symbol)}\\b`);
        const defRe  = new RegExp(`(?:^|[\\s*])${escapeRegex(symbol)}\\s*(?:\\(|=|;)`);

        let allFiles = [];
        for (const root of roots) allFiles = allFiles.concat(await walkDir(root));
        const globRe = globToRegex(glob);
        allFiles = allFiles.filter(f => globRe.test(f.replace(/\\/g, "/")));

        const matches = [];
        let truncated = false;

        outer:
        for (const filePath of allFiles) {
          let text;
          try { text = await fs.promises.readFile(filePath, "utf8"); } catch { continue; }
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (!wordRe.test(lines[i])) continue;
            if (definitionsOnly && !defRe.test(lines[i])) continue;
            matches.push({ filePath, line: i + 1, text: lines[i].trim() });
            if (matches.length >= maxMatches) { truncated = true; break outer; }
          }
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ symbol, matchCount: matches.length, truncated, matches }, null, 2) }],
          matchCount: matches.length, truncated
        };
      }
    );
  }
  } // end SEARCH GROUP (part 2)

  // ── HIGHLIGHT GROUP ───────────────────────────────────────────────────────
  if (g('highlight')) {
  {
    const curTool = "highlight-range";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Highlight Range",
        description: [
          "Visually highlight a line range in the active Pulsar editor to show the user what the AI is currently working on.",
          "Highlight fades after ttlMs milliseconds (default 8000). Call with clear:true to remove all highlights immediately.",
          "Use this before editing a function so the user can see what's about to change."
        ].join(" "),
        inputSchema: {
          startLine: z.number().optional(),
          endLine:   z.number().optional(),
          ttlMs:     z.number().optional(),
          clear:     z.boolean().optional()
        }
      },
      async ({ startLine, endLine, ttlMs = 8000, clear = false } = {}) => {
        console.log(`CMD: ${curTool}, ARGS:`, { startLine, endLine, ttlMs, clear });
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        if (clear) {
          while (activeHighlightSets.length) activeHighlightSets[0].dispose();
          return { content: [{ type: "text", text: "All highlights cleared." }] };
        }

        if (!startLine || !endLine) throw new Error("startLine and endLine are required unless clear:true.");

        const buffer    = editor.getBuffer();
        const lineCount = buffer.getLineCount();
        if (startLine < 1 || endLine > lineCount || startLine > endLine)
          throw new Error(`Range ${startLine}-${endLine} is invalid for a file with ${lineCount} lines.`);

        const disp   = new CompositeDisposable();
        activeHighlightSets.push(disp);
        packageDisposables.add(disp);
        addDecoration(editor, disp, startLine - 1, endLine - 1, "mcp-diff-added");
        editor.setCursorBufferPosition([startLine - 1, 0], { autoscroll: true });

        const timer = setTimeout(() => disp.dispose(), ttlMs);
        disp.add(new Disposable(() => clearTimeout(timer)));
        disp.add(new Disposable(() => {
          const idx = activeHighlightSets.indexOf(disp);
          if (idx !== -1) activeHighlightSets.splice(idx, 1);
        }));

        return {
          content: [{ type: "text", text: `Highlighted lines ${startLine}-${endLine} for ${ttlMs}ms.` }],
          startLine, endLine, ttlMs
        };
      }
    );
  }
  } // end HIGHLIGHT GROUP

  // ── DISCOVERY TOOLS (always on) ───────────────────────────────────────────
  {
    const curTool = "list-tools";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "List Tools",
        description: [
          "List every tool available in this MCP server with its group and enabled/disabled status.",
          "Call this at the start of a session to understand what's available.",
          "Disabled tools can be enabled at runtime with enable-group — no Pulsar reload needed.",
          "Returns a summary of which groups are on/off so you can request what you need."
        ].join(" "),
        inputSchema: {}
      },
      async () => {
        const currentGroups = atom.config.get('pulsar-edit-mcp-server.toolGroups') || {};
        const gEnabled = (name) => name === "core" || currentGroups[name] !== false;

        const byGroup = {};
        for (const entry of TOOL_CATALOGUE) {
          if (!byGroup[entry.group]) byGroup[entry.group] = { enabled: gEnabled(entry.group), tools: [] };
          byGroup[entry.group].tools.push({ name: entry.name, desc: entry.desc });
        }

        const groupSummary = Object.entries(byGroup).map(([group, info]) => ({
          group,
          enabled: info.enabled,
          toolCount: info.tools.length,
          tools: info.tools
        }));

        const enabledCount   = TOOL_CATALOGUE.filter(t => gEnabled(t.group)).length;
        const disabledCount  = TOOL_CATALOGUE.length - enabledCount;
        const disabledGroups = TOGGLEABLE_GROUPS.filter(g => currentGroups[g] === false);

        const summary = [
          `${enabledCount} tools enabled, ${disabledCount} tools disabled across ${Object.keys(byGroup).length} groups.`,
          disabledGroups.length
            ? `Disabled groups: ${disabledGroups.join(", ")}. Use enable-group to activate them at runtime.`
            : "All groups enabled."
        ].join(" ");

        return {
          content: [{ type: "text", text: JSON.stringify({ summary, enabledCount, disabledCount, disabledGroups, groups: groupSummary }, null, 2) }]
        };
      }
    );
  }

  {
    const curTool = "enable-group";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Enable Group",
        description: [
          "Enable a disabled tool group at runtime — tools become available immediately without reloading Pulsar.",
          "Use list-tools first to see which groups are disabled.",
          "Toggleable groups: edit, fileOps, navigation, safety, search, diagnostics, highlight, ghidra.",
          "Note: disabling a group requires a Pulsar reload; enabling is always instant.",
          "Also updates the saved config so the group stays enabled after restart."
        ].join(" "),
        inputSchema: {
          group: z.enum(["edit", "fileOps", "navigation", "safety", "search", "diagnostics", "highlight", "debugging", "ghidra"])
        }
      },
      async ({ group }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { group });

        const currentGroups = atom.config.get('pulsar-edit-mcp-server.toolGroups') || {};

        if (currentGroups[group] !== false) {
          return { content: [{ type: "text", text: `Group '${group}' is already enabled.` }] };
        }

        // Update config so it persists after restart
        atom.config.set('pulsar-edit-mcp-server.toolGroups', { ...currentGroups, [group]: true });

        // Re-register just this group by calling mcpRegistration with all others disabled
        if (group === "ghidra") {
          try {
            const { ghidraToolsRegistration } = await import("./ghidra-tools.js");
            ghidraToolsRegistration(server);
          } catch (e) {
            return {
              content: [{ type: "text", text: `Config updated but Ghidra registration failed: ${e.message}. Try reloading Pulsar.` }]
            };
          }
        } else {
          const singleGroup = {};
          for (const gr of TOGGLEABLE_GROUPS) singleGroup[gr] = (gr === group);
          mcpRegistration(server, linterRegistry, getMessages, singleGroup);
        }

        const toolsInGroup = TOOL_CATALOGUE.filter(t => t.group === group);
        return {
          content: [{ type: "text", text: `Group '${group}' enabled. ${toolsInGroup.length} tool(s) now available: ${toolsInGroup.map(t => t.name).join(", ")}` }],
          group, toolsEnabled: toolsInGroup.map(t => t.name)
        };
      }
    );
  }
  // ── DEBUGGING GROUP ────────────────────────────────────────────────────────
  if (g('debugging')) {
  {
    const curTool = "get-debug-log";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Get Debug Log",
        description: [
          "Return recent debug log entries captured from MCP tool calls.",
          "Use tail to limit output (default 20, max 100) — keeps token cost low.",
          "Use filter to show only entries matching a keyword or tool name (e.g. 'apply-patch', 'FAIL').",
          "Use clear:true to wipe the buffer after reading.",
          "Entries are timestamped HH:MM:SS.mmm and include tool name, event, and data."
        ].join(" "),
        inputSchema: {
          tail:   z.number().int().min(1).max(100).optional(),
          filter: z.string().optional(),
          clear:  z.boolean().optional()
        }
      },
      async ({ tail = 20, filter, clear = false }) => {
        dbg(curTool, "ARGS", { tail, filter, clear });

        let entries = [...debugLog];

        if (filter) {
          const lc = filter.toLowerCase();
          entries = entries.filter(e => e.toLowerCase().includes(lc));
        }

        // Take the last `tail` entries
        if (entries.length > tail) entries = entries.slice(-tail);

        if (clear) {
          debugLog.length = 0;
          dbg(curTool, "buffer cleared");
        }

        const text = entries.length > 0
          ? entries.join("\n")
          : "(no log entries match)";

        return {
          content: [{ type: "text", text }],
          entryCount: entries.length,
          bufferSize: debugLog.length
        };
      }
    );
  }

  {
    const curTool = "get-edit-stats";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Get Edit Stats",
        description: [
          "Return per-tool edit statistics accumulated during this session.",
          "Covers str_replace, insert, delete-line-range, replace-function-body,",
          "replace-block, apply-patch, and replace-all.",
          "For each tool: hits (successful commits), fail reasons (noMatch, whitespace,",
          "partialMatch, outOfScope, etc.), hint usage, dry-run count.",
          "str_replace also reports fuzzyWhitespaceCommits and avgOldStrLines.",
          "Use this to spot failure patterns mid-session and adjust strategy.",
          "Pass reset:true to zero all counters after reading.",
          "Counters reset on server restart."
        ].join(" "),
        inputSchema: {
          reset: z.boolean().optional()
        }
      },
      async ({ reset = false }) => {
        dbg(curTool, "ARGS", { reset });

        // Compute avgOldStrLines from the internal accumulator
        const sr = editStats.str_replace;
        const totalHitsAndFails = sr.hits + Object.values(sr.fails).reduce((a, b) => a + b, 0);
        const avgOldStrLines = totalHitsAndFails > 0
          ? Math.round((sr._oldStrLenSum / Math.max(sr.hits, 1)) * 10) / 10
          : 0;

        // Build the summary line
        const allHits  = sr.hits + editStats.insert.hits + editStats.delete_line_range.hits
          + editStats.replace_function_body.hits + editStats.replace_block.hits
          + editStats.apply_patch.hits + editStats.replace_all.hits;
        const allFails = Object.values(sr.fails).reduce((a, b) => a + b, 0)
          + Object.values(editStats.insert.fails).reduce((a, b) => a + b, 0)
          + Object.values(editStats.delete_line_range.fails).reduce((a, b) => a + b, 0)
          + editStats.replace_function_body.fails.notFound
          + Object.values(editStats.replace_block.fails).reduce((a, b) => a + b, 0)
          + Object.values(editStats.apply_patch.fails).reduce((a, b) => a + b, 0)
          + editStats.replace_all.fails.noMatch;
        const total    = allHits + allFails;
        const pct      = total > 0 ? Math.round((allHits / total) * 100) : 100;
        const summary  = `${total} edit ops: ${allHits} hits (${pct}%), ${allFails} fails`;

        const report = {
          sessionSummary: summary,
          str_replace: {
            hits:      sr.hits,
            failTotal: Object.values(sr.fails).reduce((a, b) => a + b, 0),
            fails:     { ...sr.fails },
            hintsUsed: { ...sr.hintsUsed },
            fuzzyWhitespaceCommits: sr.fuzzyWhitespaceCommits,
            dryRuns:   sr.dryRuns,
            avgOldStrLines
          },
          insert: {
            hits:      editStats.insert.hits,
            failTotal: Object.values(editStats.insert.fails).reduce((a, b) => a + b, 0),
            fails:     { ...editStats.insert.fails },
            dryRuns:   editStats.insert.dryRuns
          },
          delete_line_range: {
            hits:      editStats.delete_line_range.hits,
            failTotal: Object.values(editStats.delete_line_range.fails).reduce((a, b) => a + b, 0),
            fails:     { ...editStats.delete_line_range.fails },
            dryRuns:   editStats.delete_line_range.dryRuns
          },
          replace_function_body: {
            hits:      editStats.replace_function_body.hits,
            failTotal: editStats.replace_function_body.fails.notFound,
            fails:     { ...editStats.replace_function_body.fails },
            dryRuns:   editStats.replace_function_body.dryRuns
          },
          replace_block: {
            hits:      editStats.replace_block.hits,
            failTotal: Object.values(editStats.replace_block.fails).reduce((a, b) => a + b, 0),
            fails:     { ...editStats.replace_block.fails },
            dryRuns:   editStats.replace_block.dryRuns
          },
          apply_patch: {
            hits:              editStats.apply_patch.hits,
            failTotal:         Object.values(editStats.apply_patch.fails).reduce((a, b) => a + b, 0),
            fails:             { ...editStats.apply_patch.fails },
            largeEditWarnings: editStats.apply_patch.largeEditWarnings,
            dryRuns:           editStats.apply_patch.dryRuns
          },
          replace_all: {
            hits:      editStats.replace_all.hits,
            failTotal: editStats.replace_all.fails.noMatch,
            fails:     { ...editStats.replace_all.fails },
            dryRuns:   editStats.replace_all.dryRuns
          }
        };

        if (reset) {
          // Zero all counters, preserve structure
          const s = editStats.str_replace;
          s.hits = 0; s.dryRuns = 0; s.fuzzyWhitespaceCommits = 0; s._oldStrLenSum = 0;
          Object.keys(s.fails).forEach(k => s.fails[k] = 0);
          Object.keys(s.hintsUsed).forEach(k => s.hintsUsed[k] = 0);
          ["insert", "delete_line_range", "replace_function_body", "replace_block", "replace_all"].forEach(tool => {
            editStats[tool].hits = 0;
            editStats[tool].dryRuns = 0;
            Object.keys(editStats[tool].fails).forEach(k => editStats[tool].fails[k] = 0);
          });
          editStats.apply_patch.hits = 0;
          editStats.apply_patch.dryRuns = 0;
          editStats.apply_patch.largeEditWarnings = 0;
          Object.keys(editStats.apply_patch.fails).forEach(k => editStats.apply_patch.fails[k] = 0);
          dbg(curTool, "counters reset");
        }

        return {
          content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
          ...report
        };
      }
    );
  }
  // ── session-notes ──────────────────────────────────────────────────────────
  {
    const curTool = "session-notes";
    console.log("Registering Tool: " + curTool);

    // Notes file lives in the package root alongside package.json
    const notesPath = path.join(
      atom.packages.getLoadedPackage('pulsar-edit-mcp-server').path,
      'session-notes.json'
    );

    // Ensure the file exists
    async function loadNotes() {
      try {
        const raw = await fs.promises.readFile(notesPath, 'utf8');
        return JSON.parse(raw);
      } catch {
        return [];
      }
    }

    server.registerTool(curTool,
      {
        title: "Session Notes",
        description: [
          "Persistent cross-session notes written by the LLM.",
          "Use action:'write' to append a note — record what failed, what fix worked,",
          "and what to do differently next time. Notes survive server restarts.",
          "Use action:'read' to read all past notes at session start to recover context.",
          "Use action:'clear' to wipe all notes.",
          "Optionally pass project: a short label to group notes by project.",
          "RECOMMENDED: call with action:'read' at the start of every session on a known project.",
          "RECOMMENDED: call with action:'write' before ending a session where edits were made."
        ].join(" "),
        inputSchema: {
          action: z.enum(["read", "write", "clear"]),
          note:    z.string().optional(),   // required for write
          project: z.string().optional(),   // optional label e.g. "pulsar-edit-mcp-server"
          tail:    z.number().int().min(1).max(100).optional(), // for read: last N entries (default all)
        }
      },
      async ({ action, note, project, tail }) => {
        dbg(curTool, "ARGS", { action, project, tail, noteLen: note?.length });

        if (action === "read") {
          const notes = await loadNotes();
          const entries = tail ? notes.slice(-tail) : notes;
          if (entries.length === 0) {
            return { content: [{ type: "text", text: "No session notes recorded yet." }] };
          }
          const lines = entries.map((e, i) =>
            `[${e.timestamp}]${e.project ? ` [${e.project}]` : ''}\n${e.note}`
          );
          return {
            content: [{ type: "text", text: `${entries.length} note(s):\n\n${lines.join('\n\n---\n\n')}` }],
            count: entries.length
          };
        }

        if (action === "write") {
          if (!note || !note.trim()) {
            return { content: [{ type: "text", text: "❌ note is required for action:write." }] };
          }
          const notes = await loadNotes();
          const entry = {
            timestamp: new Date().toISOString(),
            project:   project || null,
            note:      note.trim()
          };
          notes.push(entry);
          await fs.promises.writeFile(notesPath, JSON.stringify(notes, null, 2), 'utf8');
          dbg(curTool, "note written", { project, timestamp: entry.timestamp });
          return {
            content: [{ type: "text", text: `✅ Note saved. Total notes: ${notes.length}.` }],
            totalNotes: notes.length
          };
        }

        if (action === "clear") {
          await fs.promises.writeFile(notesPath, '[]', 'utf8');
          dbg(curTool, "notes cleared");
          return { content: [{ type: "text", text: "✅ All session notes cleared." }] };
        }
      }
    );
  }

  } // end debugging group


} // end mcpRegistration

// ---------------------------------------------------------------------------
// Checkpoint store (in-memory, keyed by name)
// ---------------------------------------------------------------------------
const checkpoints = new Map();

// ---------------------------------------------------------------------------
// apply-patch failure counter (in-memory, reset on server restart)
// Tracks consecutive patch failures per session so the tool can advise
// the LLM to switch strategy after repeated bad diffs.
// ---------------------------------------------------------------------------
// (patchFailures, strReplFailures, insertFailures, deleteFailures declared at module scope above)

// ---------------------------------------------------------------------------
// Decoration helpers
// ---------------------------------------------------------------------------

function decorateEditedLines(editor, original, updated, { ttl = 8000 } = {}) {
  const disp = new CompositeDisposable();
  activeHighlightSets.push(disp);
  packageDisposables.add(disp);
  const hunks = diffLines(original, updated);
  let newRow = 0;
  hunks.forEach(h => {
    const lineCount = h.count ?? h.value.split(/\r?\n/).length - 1;
    if (h.added || h.removed) {
      const startRow = newRow;
      const endRow   = newRow + (h.added ? lineCount - 1 : 0);
      if (h.added)        addDecoration(editor, disp, startRow, endRow,   "mcp-diff-added");
      else if (h.removed) addDecoration(editor, disp, startRow, startRow, "mcp-diff-removed");
    }
    if (!h.removed) newRow += lineCount;
  });

  disp.add(editor.getBuffer().onDidChange(() => disp.dispose()));
  if (ttl > 0) {
    const timer = setTimeout(() => disp.dispose(), ttl);
    disp.add(new Disposable(() => clearTimeout(timer)));
  }
  disp.add(new Disposable(() => {
    const idx = activeHighlightSets.indexOf(disp);
    if (idx !== -1) activeHighlightSets.splice(idx, 1);
  }));
  return disp;
}

function decorateLine(editor, row, kind = "added", opts = {}) {
  editor.setCursorBufferPosition([row, 0], { autoscroll: true });
  const disp  = new CompositeDisposable();
  const klass = kind === "removed" ? "mcp-diff-removed" : "mcp-diff-added";
  addDecoration(editor, disp, row, row, klass);
  const { ttl = 8000 } = opts;
  if (ttl > 0) {
    const timer = setTimeout(() => disp.dispose(), ttl);
    disp.add(new Disposable(() => clearTimeout(timer)));
  }
  return disp;
}

function addDecoration(editor, disp, fromRow, toRow, klass) {
  const marker = editor.getBuffer().markRange(
    [[fromRow, 0], [toRow, Infinity]],
    { invalidate: "never" }
  );
  disp.add(new Disposable(() => marker.destroy()));
  const decoLine = editor.decorateMarker(marker, { type: "line",   class: klass });
  const decoGut  = editor.decorateMarker(marker, { type: "gutter", gutterName: "line-number", class: `${klass}-gutter` });
  disp.add(new Disposable(() => decoLine.destroy()));
  disp.add(new Disposable(() => decoGut.destroy()));
}

// ---------------------------------------------------------------------------
// Exported helpers so the Pulsar UI (showEditStats modal) can read and reset
// the in-memory stats without going through the MCP tool protocol.
// ---------------------------------------------------------------------------
export function getEditStats() {
  const sr = editStats.str_replace;
  const totalCalls = sr.hits + Object.values(sr.fails).reduce((a, b) => a + b, 0);
  const avgOldStrLines = totalCalls > 0
    ? Math.round((sr._oldStrLenSum / Math.max(sr.hits, 1)) * 10) / 10
    : 0;
  const allHits  = sr.hits + editStats.insert.hits + editStats.delete_line_range.hits
    + editStats.replace_function_body.hits + editStats.replace_block.hits
    + editStats.apply_patch.hits + editStats.replace_all.hits;
  const allFails = Object.values(sr.fails).reduce((a, b) => a + b, 0)
    + Object.values(editStats.insert.fails).reduce((a, b) => a + b, 0)
    + Object.values(editStats.delete_line_range.fails).reduce((a, b) => a + b, 0)
    + editStats.replace_function_body.fails.notFound
    + Object.values(editStats.replace_block.fails).reduce((a, b) => a + b, 0)
    + Object.values(editStats.apply_patch.fails).reduce((a, b) => a + b, 0)
    + editStats.replace_all.fails.noMatch;
  const total = allHits + allFails;
  const pct   = total > 0 ? Math.round((allHits / total) * 100) : 100;
  return {
    sessionSummary: `${total} edit ops: ${allHits} hits (${pct}%), ${allFails} fails`,
    str_replace:           { hits: sr.hits, failTotal: Object.values(sr.fails).reduce((a,b)=>a+b,0), fails: {...sr.fails}, hintsUsed: {...sr.hintsUsed}, fuzzyWhitespaceCommits: sr.fuzzyWhitespaceCommits, dryRuns: sr.dryRuns, avgOldStrLines },
    insert:                { hits: editStats.insert.hits, failTotal: Object.values(editStats.insert.fails).reduce((a,b)=>a+b,0), fails: {...editStats.insert.fails}, dryRuns: editStats.insert.dryRuns },
    delete_line_range:     { hits: editStats.delete_line_range.hits, failTotal: Object.values(editStats.delete_line_range.fails).reduce((a,b)=>a+b,0), fails: {...editStats.delete_line_range.fails}, dryRuns: editStats.delete_line_range.dryRuns },
    replace_function_body: { hits: editStats.replace_function_body.hits, failTotal: editStats.replace_function_body.fails.notFound, fails: {...editStats.replace_function_body.fails}, dryRuns: editStats.replace_function_body.dryRuns },
    replace_block:         { hits: editStats.replace_block.hits, failTotal: Object.values(editStats.replace_block.fails).reduce((a,b)=>a+b,0), fails: {...editStats.replace_block.fails}, dryRuns: editStats.replace_block.dryRuns },
    apply_patch:           { hits: editStats.apply_patch.hits, failTotal: Object.values(editStats.apply_patch.fails).reduce((a,b)=>a+b,0), fails: {...editStats.apply_patch.fails}, largeEditWarnings: editStats.apply_patch.largeEditWarnings, dryRuns: editStats.apply_patch.dryRuns },
    replace_all:           { hits: editStats.replace_all.hits, failTotal: editStats.replace_all.fails.noMatch, fails: {...editStats.replace_all.fails}, dryRuns: editStats.replace_all.dryRuns },
  };
}

export function resetEditStats() {
  const s = editStats.str_replace;
  s.hits = 0; s.dryRuns = 0; s.fuzzyWhitespaceCommits = 0; s._oldStrLenSum = 0;
  Object.keys(s.fails).forEach(k => s.fails[k] = 0);
  Object.keys(s.hintsUsed).forEach(k => s.hintsUsed[k] = 0);
  ["insert", "delete_line_range", "replace_function_body", "replace_block", "replace_all"].forEach(tool => {
    editStats[tool].hits = 0;
    editStats[tool].dryRuns = 0;
    Object.keys(editStats[tool].fails).forEach(k => editStats[tool].fails[k] = 0);
  });
  editStats.apply_patch.hits = 0;
  editStats.apply_patch.dryRuns = 0;
  editStats.apply_patch.largeEditWarnings = 0;
  Object.keys(editStats.apply_patch.fails).forEach(k => editStats.apply_patch.fails[k] = 0);
}
