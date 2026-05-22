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
  { name: "replace-text",            group: "edit",        desc: "Replace the first occurrence of a string in the active editor." },
  { name: "get-context-around",      group: "edit",        desc: "Return lines around the Nth match of a query." },
  { name: "find-text",               group: "edit",        desc: "Find all positions of a string/regex in the active editor." },
  { name: "replace-document",        group: "edit",        desc: "Replace the entire editor contents with new text." },
  { name: "insert-line",             group: "edit",        desc: "DEPRECATED — use insert-text-at-line. Insert a single line." },
  { name: "insert-text-at-line",     group: "edit",        desc: "Insert one or more lines before a given 1-based line number." },
  { name: "delete-line",             group: "edit",        desc: "DEPRECATED — use delete-line-range. Delete a single line." },
  { name: "delete-line-range",       group: "edit",        desc: "Delete a range of lines (inclusive)." },
  { name: "get-selection",           group: "edit",        desc: "Return the currently selected text and its line/col range." },
  { name: "replace-all",             group: "edit",        desc: "Replace ALL occurrences of a string in the active editor." },
  { name: "insert-at-line",          group: "edit",        desc: "DEPRECATED alias for insert-text-at-line — use insert-text-at-line instead." },
  // FileOps
  { name: "get-project-files",       group: "fileOps",     desc: "List all files under project roots, optionally filtered by glob." },
  { name: "read-file",               group: "fileOps",     desc: "Read any project file by path with 1-based line numbers." },
  { name: "run-command",             group: "fileOps",     desc: "Execute a shell command and return stdout/stderr/exit code." },
  { name: "replace-across-files",    group: "fileOps",     desc: "Find and replace across all project files (supports dry-run)." },
  { name: "replace-function-body",   group: "fileOps",     desc: "Atomically replace a named function's signature and body." },
  { name: "create-file",             group: "fileOps",     desc: "Create a new file at a path and open it in the editor." },
  { name: "get-includes-and-defines",group: "fileOps",     desc: "Return all #include/#define lines from a C/C++ file." },
  { name: "list-project-functions",  group: "fileOps",     desc: "List every function definition across all project files." },
  { name: "read-lines",              group: "fileOps",     desc: "Read a line range from any file without opening it." },
  { name: "file-line-count",         group: "fileOps",     desc: "Return the line count of any file without loading it." },
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
export const TOGGLEABLE_GROUPS = ["edit", "fileOps", "navigation", "safety", "search", "diagnostics", "highlight", "ghidra"];

export function mcpRegistration(server, linterRegistry = null, getMessages = null, groups = {}) {
  // Helper: returns true when a group is enabled (default: true)
  const g = (name) => groups[name] !== false;

  // ── EDIT GROUP ────────────────────────────────────────────────────────────
  if (g('edit')) {
  {
    const curTool = "replace-text";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Replace Text",
        description: [
          "Replace the first occurrence of `query` with `replacement` in the active editor, starting at or after `lineHint` (1-based).",
          "Use `lineHint` (from a prior grep-file call) to target a specific occurrence when the same string appears multiple times.",
          "Without `lineHint` replaces the first match in the file — only use that when the string is unique.",
          "For replacing ALL occurrences use replace-all instead.",
          "SINGLE-LINE ONLY: query is matched against one line at a time — multi-line strings spanning newlines will never match; use delete-line-range + insert-text-at-line for multi-line edits, or replace-document for a full rewrite. Returns the line number where the replacement was made so you can verify the right occurrence was changed."
        ].join(" "),
        inputSchema: {
          query:         z.string(),
          replacement:   z.string(),
          lineHint:      z.number().optional(),
          regex:         z.boolean().optional(),
          caseSensitive: z.boolean().optional()
        }
      },
      async ({ query, replacement, lineHint = 1, regex = false, caseSensitive = false }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { query, replacement, lineHint, regex, caseSensitive });

        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer = editor.getBuffer();

        const source  = regex ? query : escapeRegex(query);
        const flags   = caseSensitive ? "" : "i";
        let pattern;
        try { pattern = new RegExp(source, flags); }
        catch (e) { throw new Error(`Invalid regex: ${e.message}`); }

        const lines      = buffer.getLines();
        const startRow   = Math.max(0, (lineHint || 1) - 1);
        let matchRow     = -1;
        let matchRange   = null;

        for (let i = startRow; i < lines.length; i++) {
          const m = pattern.exec(lines[i]);
          if (m) {
            matchRow   = i;
            matchRange = [[i, m.index], [i, m.index + m[0].length]];
            break;
          }
        }

        if (matchRow === -1) {
          const hint = lineHint > 1 ? ` at or after line ${lineHint}` : "";
          return {
            content: [{ type: "text", text: `No match found for ${JSON.stringify(query)}${hint}.` }],
            matchCount: 0
          };
        }

        const originalText = buffer.getText();
        buffer.setTextInRange(matchRange, replacement);
        decorateEditedLines(editor, originalText, buffer.getText());

        return {
          content: [{ type: "text", text: `Replaced match at line ${matchRow + 1}.` }],
          matchCount: 1,
          replacedAtLine: matchRow + 1
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
    const curTool = "insert-line";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Insert Line",
        description: "DEPRECATED: use insert-text-at-line instead. Insert a single line of text before the specified 1-based line number. WARNING: line numbers shift after every insert - always call get-document again before the next line-based edit.",
        inputSchema: { lineNumber: z.number(), text: z.string() }
      },
      async ({ lineNumber, text }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { lineNumber, text: text.substring(0, 50) });

        const editor    = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer    = editor.getBuffer();
        const lineCount = buffer.getLineCount();
        if (lineNumber < 1 || lineNumber > lineCount + 1)
          throw new Error(`lineNumber ${lineNumber} is out of range (1-${lineCount + 1}).`);

        const row = lineNumber - 1;
        buffer.insert([row, 0], text + "\n");
        decorateLine(editor, row, "added");

        const newLineCount = buffer.getLineCount();
        return {
          content: [{ type: "text", text: `Inserted line at ${lineNumber}. New line count: ${newLineCount}. Remember: line numbers have shifted!` }],
          newLineCount
        };
      }
    );
  }

  {
    const curTool = "insert-text-at-line";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Insert Text At Line",
        description: "Insert one or more lines of text before the specified 1-based line number. Use for both single-line and multi-line inserts. CORRUPTION RISK: line numbers shift after every insert — using stale line numbers for a subsequent insert or delete will hit the wrong lines and silently corrupt the file. You MUST call get-document or read-lines after each insert to get updated line numbers before any further line-based edits. Returns newLineCount so you can verify the shift.",
        inputSchema: { lineNumber: z.number(), text: z.string() }
      },
      async ({ lineNumber, text }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { lineNumber, text: text.substring(0, 50) });

        const editor    = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer    = editor.getBuffer();
        const lineCount = buffer.getLineCount();
        if (lineNumber < 1 || lineNumber > lineCount + 1)
          throw new Error(`lineNumber ${lineNumber} is out of range (1-${lineCount + 1}). Cannot insert beyond end of file.`);

        const row             = lineNumber - 1;
        const textWithNewline = text.endsWith("\n") ? text : text + "\n";
        buffer.insert([row, 0], textWithNewline);
        decorateLine(editor, row, "added");

        const newLineCount = buffer.getLineCount();
        return {
          content: [{ type: "text", text: `Inserted text at line ${lineNumber}. New line count: ${newLineCount}. Remember: line numbers have shifted!` }],
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
        inputSchema: { startLine: z.number(), endLine: z.number() }
      },
      async ({ startLine, endLine }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { startLine, endLine });

        const editor    = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer    = editor.getBuffer();
        const lineCount = buffer.getLineCount();
        if (startLine < 1 || endLine < 1) throw new Error("Line numbers must be 1-based.");
        if (startLine > endLine) throw new Error(`startLine (${startLine}) must be <= endLine (${endLine}).`);
        if (endLine > lineCount) throw new Error(`endLine ${endLine} exceeds line count ${lineCount}.`);

        const startRow   = startLine - 1;
        const endRow     = endLine   - 1;
        buffer.deleteRows(startRow, endRow);
        decorateLine(editor, startRow, "removed");

        const newLineCount = buffer.getLineCount();
        const deletedCount = endLine - startLine + 1;
        return {
          content: [{ type: "text", text: `Deleted ${deletedCount} line(s) (${startLine}-${endLine}). New line count: ${newLineCount}. Remember: line numbers have shifted!` }],
          newLineCount, deletedCount
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
          newBody: z.string()
        }
      },
      async ({ name, newBody }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { name, newBodyLength: newBody.length });

        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        const buffer = editor.getBuffer();
        const found  = findFunctionInBuffer(buffer, name);
        if (!found) throw new Error(`Function "${name}" not found in active editor.`);

        const { startRow, endRow } = found;
        const originalText = buffer.getText();

        const ensuredNewline = newBody.endsWith("\n") ? newBody : newBody + "\n";
        buffer.setTextInRange([[startRow, 0], [endRow + 1, 0]], ensuredNewline);
        decorateEditedLines(editor, originalText, buffer.getText());

        const newLineCount   = buffer.getLineCount();
        const insertedLines  = ensuredNewline.split(/\r?\n/).length - 1;

        return {
          content: [{ type: "text", text: `Replaced function "${name}". Old lines: ${startRow + 1}-${endRow + 1}. Inserted ${insertedLines} lines starting at ${startRow + 1}. New total: ${newLineCount}.` }],
          functionName: name,
          oldStartLine: startRow + 1,
          oldEndLine:   endRow   + 1,
          newStartLine: startRow + 1,
          insertedLines,
          newLineCount
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

  // ── EDIT GROUP (part 2: replace-all, insert-at-line) ─────────────────────
  if (g('edit')) {
  {
    const curTool = "replace-all";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Replace All",
        description: [
          "Find and replace ALL occurrences of query with replacement in the active editor.",
          "Equivalent to replace-text with all:true — exists as a shortcut so you never accidentally replace only the first match.",
          "Supports regex and case-insensitive matching.",
          "Returns matchCount so you can verify how many occurrences were replaced. NO DRY-RUN: unlike replace-across-files there is no preview option — use find-text first to count and inspect matches before committing, especially with broad or regex queries."
        ].join(" "),
        inputSchema: {
          query:         z.string(),
          replacement:   z.string(),
          regex:         z.boolean().optional(),
          caseSensitive: z.boolean().optional()
        }
      },
      async ({ query, replacement, regex = false, caseSensitive = false }) => {
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
        let matchCount = 0;
        const newText = originalText.replace(pattern, () => { matchCount++; return replacement; });

        if (matchCount === 0) return { content: [{ type: "text", text: "No matches found — nothing replaced." }], matchCount: 0 };

        buffer.setTextViaDiff(newText);
        decorateEditedLines(editor, originalText, newText);

        return {
          content: [{ type: "text", text: `Replaced all ${matchCount} occurrence${matchCount === 1 ? "" : "s"} of ${JSON.stringify(query)}.` }],
          matchCount
        };
      }
    );
  }

  {
    const curTool = "insert-at-line";
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Insert At Line",
        description: [
          "Insert one or more lines of text before the specified 1-based line number in the active editor.",
          "DEPRECATED alias for insert-text-at-line — prefer insert-text-at-line for new code.",
          "WARNING: line numbers shift after every insert — always call get-document or read-lines again before the next line-based edit.",
          "Returns newLineCount so you can track the shift."
        ].join(" "),
        inputSchema: {
          lineNumber: z.number(),
          text:       z.string()
        }
      },
      async ({ lineNumber, text }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { lineNumber, text: text.substring(0, 80) });

        const editor    = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer    = editor.getBuffer();
        const lineCount = buffer.getLineCount();

        if (lineNumber < 1 || lineNumber > lineCount + 1)
          throw new Error(`lineNumber ${lineNumber} is out of range (1-${lineCount + 1}).`);

        const row             = lineNumber - 1;
        const textWithNewline = text.endsWith("\n") ? text : text + "\n";
        buffer.insert([row, 0], textWithNewline);
        decorateLine(editor, row, "added");

        const newLineCount = buffer.getLineCount();
        return {
          content: [{ type: "text", text: `Inserted at line ${lineNumber}. New line count: ${newLineCount}. Line numbers have shifted.` }],
          newLineCount
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
        const original = editor.getBuffer().getText();
        const hunks = diffLines(original, proposedText);
        let added = 0, removed = 0;
        const unifiedLines = [];
        let lineNo = 1;
        for (const h of hunks) {
          const count = h.count ?? h.value.split(/\r?\n/).length - 1;
          const lines = h.value.split(/\r?\n/);
          if (lines[lines.length - 1] === "") lines.pop();
          if (h.added) {
            added += count;
            lines.forEach(l => unifiedLines.push(`+ ${l}`));
          } else if (h.removed) {
            removed += count;
            lines.forEach(l => unifiedLines.push(`- ${l}`));
            lineNo += count;
          } else {
            lines.forEach(l => unifiedLines.push(`  ${l}`));
            lineNo += count;
          }
        }
        const unchanged = added === 0 && removed === 0;
        return {
          content: [{ type: "text", text: unchanged ? "No changes." : unifiedLines.join("\n") }],
          linesAdded: added, linesRemoved: removed, unchanged
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
          group: z.enum(["edit", "fileOps", "navigation", "safety", "search", "diagnostics", "highlight", "ghidra"])
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

} // end mcpRegistration

// ---------------------------------------------------------------------------
// Checkpoint store (in-memory, keyed by name)
// ---------------------------------------------------------------------------
const checkpoints = new Map();

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
