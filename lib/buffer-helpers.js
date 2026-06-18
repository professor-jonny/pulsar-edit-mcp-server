'use babel';
const fs   = require('fs');
const path = require('path');
const { getSymbols, findFunction } = require('./tree-sitter-symbols');
const { escapeRegex } = require('./string-utils');
const { shouldIgnore } = require('./mcp-ignore');

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
      if ([".git", ".hg", ".svn"].includes(entry.name)) continue;
      if (shouldIgnore(full + path.sep)) continue; // trailing sep = directory match
      await walkDir(full, files);
    } else {
      if (shouldIgnore(full)) continue;
      files.push(full);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Helper: resolve structural anchors — sectionHint, preprocBlock, functionEnd.
// These are pre-passes that translate semantic landmarks into { startRow, endRow }
// before the normal findAnchor / line-number logic runs.
//
//   sectionHint  — finds a /* ====... / * NAME / * ====... */ banner comment by
//                  the keyword on the middle line.  Returns the row of the opening
//                  /* line (start) and the closing */ line (end).
//
//   preprocBlock — finds a #ifdef / #if / #ifndef MACRO ... #endif pair by macro
//                  name.  The closing #endif must carry a /* MACRO */ or // MACRO
//                  trailing comment matching the macro name (your project standard).
//                  Returns start = #ifdef row, end = #endif row.
//                  Optional side: "open"|"close" to return just one end as a single row.
//
//   functionEnd  — returns the single closing-brace row of a named function.
//                  Use with insert({ afterContent: functionEnd }) to insert after a
//                  function without needing to know its exact last line.
//
// Returns null if the landmark cannot be found.
// ---------------------------------------------------------------------------
function resolveStructuralAnchor(buffer, { sectionHint, preprocBlock, preprocSide, functionEnd } = {}) {
  const allLines = buffer.getLines();

  // ── sectionHint ────────────────────────────────────────────────────────────
  if (sectionHint) {
    const keyword = sectionHint.trim().toLowerCase();
    const singleLineRe = /^\/\*\s*[-=]{4,}[^*]*[-=]{4,}\s*\*\/\s*$/;
    for (let i = 0; i < allLines.length; i++) {
      const line = allLines[i];
      if (!line.toLowerCase().includes(keyword)) continue;
      // Single-line banner: /* ---- Name ---- */ or /* ===...=== Name ===...=== */
      if (singleLineRe.test(line.trim())) {
        return { startRow: i, endRow: i };
      }
      // Three-line banner: prev = /* ---/===, this = keyword, next = * ---/=== */
      if (i >= 1 && i < allLines.length - 1) {
        const prev = allLines[i - 1].trim();
        const next = allLines[i + 1] ? allLines[i + 1].trim() : '';
        if (/^\/\*\s*[=\-]{6,}/.test(prev) && /^\*\s*[=\-]{6,}/.test(next)) {
          return { startRow: i - 1, endRow: i + 1 };
        }
      }
    }
    return null;
  }

  // ── preprocBlock ───────────────────────────────────────────────────────────
  if (preprocBlock) {
    const macro = preprocBlock.trim();
    const macroLower = macro.toLowerCase();
    // Find the opening #ifdef / #if / #ifndef line
    let openRow = -1;
    for (let i = 0; i < allLines.length; i++) {
      const t = allLines[i].trim();
      if (/^#\s*(ifdef|ifndef|if\b)/.test(t) && t.toLowerCase().includes(macroLower)) {
        openRow = i;
        break;
      }
    }
    if (openRow === -1) return null;
    // Find the matching #endif — must carry a trailing comment with the macro name
    // to avoid matching unrelated #endif lines in nested blocks.
    for (let i = openRow + 1; i < allLines.length; i++) {
      const t = allLines[i].trim();
      if (/^#\s*endif/.test(t) && t.toLowerCase().includes(macroLower)) {
        const closeRow = i;
        if (preprocSide === "open")  return { startRow: openRow,  endRow: openRow };
        if (preprocSide === "close") return { startRow: closeRow, endRow: closeRow };
        return { startRow: openRow, endRow: closeRow };
      }
    }
    return null;
  }

  // ── functionEnd ────────────────────────────────────────────────────────────
  if (functionEnd) {
    const found = findFunctionInBuffer(buffer, functionEnd);
    if (!found) return null;
    return { startRow: found.endRow, endRow: found.endRow };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helper: find an anchor string (single or multi-line) in a buffer.
//
// Matching strategy (tried in order, stops at first hit):
//   1. exact     — anchor substring found on the target line (single-line)
//                  or each anchor line found as substring of buffer line (multi)
//   2. fuzzy     — each anchor line matched after collapsing whitespace runs to
//                  a single space and trimming (catches indent/tab divergence)
//   3. indent    — each anchor line matched on trimmed content only (handles
//                  cases where the LLM omitted or guessed leading indentation)
//
// Scoping options (both narrow the search range before matching):
//   inFunction   — restrict to the body of a named function
//   afterRow     — start searching from this 0-based row (e.g. after a prior anchor)
//   occurrence   — match the Nth hit rather than the first
//
// Returns { row, matchedRows, strategy } on success, null on failure.
//   row         — 0-based row of the first anchor line in the buffer
//   matchedRows — number of buffer lines consumed (= anchor line count)
//   strategy    — which strategy matched: "exact" | "fuzzy" | "indent"
// ---------------------------------------------------------------------------
function findAnchor(buffer, anchor, { occurrence = 1, inFunction = null, afterRow = 0 } = {}) {
  const allLines   = buffer.getLines();
  let   searchFrom = Math.max(0, afterRow);
  let   searchTo   = allLines.length - 1;

  if (inFunction) {
    const fn = findFunctionInBuffer(buffer, inFunction);
    if (!fn) return null;
    searchFrom = Math.max(searchFrom, fn.startRow);
    searchTo   = fn.endRow;
  }

  const anchorLines = anchor.split("\n");
  const norm        = s => s.replace(/\s+/g, " ").trim();

  function matchesAt(i, strategy) {
    if (i + anchorLines.length - 1 > searchTo) return false;
    for (let k = 0; k < anchorLines.length; k++) {
      const buf = allLines[i + k];
      const anc = anchorLines[k];
      if (strategy === "exact")  { if (!buf.includes(anc))          return false; }
      if (strategy === "fuzzy")  { if (norm(buf) !== norm(anc))     return false; }
      if (strategy === "indent") { if (buf.trim() !== anc.trim())   return false; }
    }
    return true;
  }

  for (const strategy of ["exact", "fuzzy", "indent"]) {
    let found = 0;
    for (let i = searchFrom; i <= searchTo - (anchorLines.length - 1); i++) {
      if (matchesAt(i, strategy)) {
        found++;
        if (found === occurrence) {
          return { row: i, matchedRows: anchorLines.length, strategy };
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: find a named function in a buffer, returns { startRow, endRow } or null
// ---------------------------------------------------------------------------
function findFunctionInBuffer(buffer, name) {
  // Try tree-sitter first via getSymbols (editor path), fall back to regex inside getSymbols
  const editor = atom.workspace.getTextEditors()
    .find(e => e.getBuffer && e.getBuffer() === buffer);
  const text     = buffer.getText();
  const filePath = editor ? (editor.getPath() || '') : '';
  const symbols  = getSymbols(editor || null, text, filePath);
  const sym      = findFunction(symbols, name, {});
  if (sym) return { startRow: sym.startRow, endRow: sym.endRow };

  // Hard fallback: if getSymbols returned nothing (empty file / unknown type),
  // keep the original brace-counting regex so callers never get null unexpectedly.
  const lines  = buffer.getLines();
  // Matches: `function name(`, `name(`, or IIFE `(function name(`
  const sigRe  = new RegExp("(?:^|\\s|\\()(?:function\\s+)?" + escapeRegex(name) + "\\s*\\(");
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
  let depth = 0, endRow = -1;
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
// Helper: read a file's text for READ-ONLY tools (grep-file, grep-project,
// read-file, get-repo-map, read-lines, get-region, search-symbol,
// file-line-count, list-project-functions, get-function-body, add-comment).
//
// Fast path: file already open in an editor — return live buffer text so
// unsaved edits are visible without a save-file first.
//
// Slow path: file not open — use atom.project.bufferForPath() which:
//   • Loads with Pulsar's own encoding detection (no \uFFFD mojibake, no BOM leakage)
//   • Does NOT create a pane item / tab (no workspace pollution)
//   • Resolves only when the buffer is fully loaded (no race on large files)
//   • Throws on failure — callers see the error rather than a silent bad read
//
// This replaces the previous atom.workspace.open() fallback which had a race
// condition on large files (~6600+ lines) returning empty/partial text, and
// opened a hidden tab for every file scanned by grep-project.
//
// NOTE: do NOT use this for write tools (replace-across-files commit step)
// which need a real pane item for undo history / checkpoint support.
// ---------------------------------------------------------------------------
async function readTextFromFile(filePath) {
  if (shouldIgnore(filePath)) throw new Error(`mcp-ignore: "${filePath}" is ignored. Use open-file or edit .mcp-ignore to allow it.`);
  if (!fs.existsSync(filePath)) throw new Error(`File not found: "${filePath}". Use get-project-files to list available paths.`);
  const resolved = path.resolve(filePath);
  const openEditor = atom.workspace.getTextEditors()
    .find(e => e.getPath() && path.resolve(e.getPath()) === resolved);
  if (openEditor) return openEditor.getBuffer().getText();
  // bufferForPath: encoding-safe (Pulsar handles BOM + charset detection),
  // no tab created, no race condition. Throws naturally on failure — callers
  // should see the error rather than falling back to a raw disk read which
  // bypasses encoding handling and can return BOM-prefixed text.
  const buffer = await atom.project.bufferForPath(filePath);
  return buffer.getText();
}

// ---------------------------------------------------------------------------
// Helper: read a file's text — prefer the live buffer if the file is open
// in Pulsar, fall back to disk otherwise. Ensures unsaved edits are always
// visible to read/search tools without requiring a save-file first.
//
// DEPRECATED for read-only tools: use readTextFromFile() instead.
// Still used by replace-across-files write path which needs atom.workspace.open
// to get a pane item with undo history support.
// ---------------------------------------------------------------------------
async function readFileOrBuffer(filePath) {
  if (shouldIgnore(filePath)) throw new Error(`mcp-ignore: "${filePath}" is ignored. Use open-file or edit .mcp-ignore to allow it.`);
  const resolved = path.resolve(filePath);
  const openEditor = atom.workspace.getTextEditors()
    .find(e => e.getPath() && path.resolve(e.getPath()) === resolved);
  if (openEditor) return openEditor.getBuffer().getText();
  if (!fs.existsSync(filePath)) throw new Error(`File not found: "${filePath}". Use get-project-files to list available paths.`);
  const editor = await atom.workspace.open(filePath, { activateItem: false, searchAllPanes: true });
  return editor.getBuffer().getText();
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
  // Fallback: snapshot dirty content, destroy, reopen, restore.
  // NOTE: setPath was unavailable so undo history cannot be preserved.
  // We clear the undo stack after restore so it's clean rather than pointing
  // at operations against the old path (which would silently corrupt on replay).
  const bufferText = buffer.getText();
  const isModified = editor.isModified();
  await editor.destroy();
  const newEditor = await atom.workspace.open(newPath);
  if (isModified) {
    newEditor.getBuffer().setText(bufferText);
    newEditor.getBuffer().clearUndoStack();
  }
  return newEditor;
}

module.exports = {
  walkDir,
  resolveStructuralAnchor,
  findAnchor,
  findFunctionInBuffer,
  readTextFromFile,
  readFileOrBuffer,
  retargetEditor,
};
