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
// Helper: resolve structural anchors — sectionHint, preprocBlock.
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
// Returns null if the landmark cannot be found.
// ---------------------------------------------------------------------------
function resolveStructuralAnchor(buffer, { sectionHint, preprocBlock, preprocSide, occurrence } = {}) {
  const allLines = buffer.getLines();

  // ── sectionHint ────────────────────────────────────────────────────────────
  // B44: collect ALL banner matches instead of returning on the first hit --
  // a short/generic keyword can legitimately match more than one banner in
  // the same file (e.g. "Wi-Fi" matching both "Wi-Fi Config" and "Wi-Fi
  // Legacy"). Silently picking the first one is a confident-wrong-location
  // write with no warning -- same failure class as B38/B41 in str_replace.
  if (sectionHint) {
    const keyword = sectionHint.trim().toLowerCase();
    const singleLineRe = /^\/\*\s*[-=]{4,}[^*]*[-=]{4,}\s*\*\/\s*$/;
    const matches = [];
    for (let i = 0; i < allLines.length; i++) {
      const line = allLines[i];
      if (!line.toLowerCase().includes(keyword)) continue;
      // Single-line banner: /* ---- Name ---- */ or /* ===...=== Name ===...=== */
      if (singleLineRe.test(line.trim())) {
        matches.push({ startRow: i, endRow: i });
        continue;
      }
      // Three-line banner: prev = /* ---/===, this = keyword, next = * ---/=== */
      if (i >= 1 && i < allLines.length - 1) {
        const prev = allLines[i - 1].trim();
        const next = allLines[i + 1] ? allLines[i + 1].trim() : '';
        if (/^\/\*\s*[=\-]{6,}/.test(prev) && /^\*\s*[=\-]{6,}/.test(next)) {
          matches.push({ startRow: i - 1, endRow: i + 1 });
        }
      }
    }
    if (matches.length === 0) return null;
    // occurrence omitted (undefined/null) → caller expressed no preference;
    // refuse if ambiguous rather than silently guessing (safety net).
    // occurrence given as any real number, including 1 → caller explicitly
    // picked that match; resolve directly. This distinguishes "didn't say"
    // from "said 1" — both used to collapse to the same refusal, which made
    // an explicit occurrence:1 indistinguishable from omitting it entirely.
    if (matches.length > 1 && occurrence == null) {
      return { ambiguous: true, matches };
    }
    return matches[Math.min(occurrence ?? 1, matches.length) - 1];
  }

  // ── preprocBlock ───────────────────────────────────────────────────────────
  // B44: same fix as sectionHint above -- a macro name that is itself a
  // substring of another macro name in the file (e.g. CONFIG_WIFI_NEW vs
  // CONFIG_WIFI_NEW_DEBUG) must not silently resolve to whichever block
  // appears first.
  if (preprocBlock) {
    const macro = preprocBlock.trim();
    const macroLower = macro.toLowerCase();
    // Find every opening #ifdef / #if / #ifndef line that matches.
    const openRows = [];
    for (let i = 0; i < allLines.length; i++) {
      const t = allLines[i].trim();
      if (/^#\s*(ifdef|ifndef|if\b)/.test(t) && t.toLowerCase().includes(macroLower)) {
        openRows.push(i);
      }
    }
    if (openRows.length === 0) return null;
    // For each opening line, find its matching #endif -- must carry a
    // trailing comment with the macro name to avoid matching unrelated
    // #endif lines in nested blocks.
    const matches = [];
    for (const openRow of openRows) {
      for (let i = openRow + 1; i < allLines.length; i++) {
        const t = allLines[i].trim();
        if (/^#\s*endif/.test(t) && t.toLowerCase().includes(macroLower)) {
          matches.push({ openRow, closeRow: i });
          break;
        }
      }
    }
    if (matches.length === 0) return null;
    if (matches.length > 1 && occurrence == null) {
      return { ambiguous: true, matches: matches.map(m => ({ startRow: m.openRow, endRow: m.closeRow })) };
    }
    const { openRow, closeRow } = matches[Math.min(occurrence ?? 1, matches.length) - 1];
    if (preprocSide === "open")  return { startRow: openRow,  endRow: openRow };
    if (preprocSide === "close") return { startRow: closeRow, endRow: closeRow };
    return { startRow: openRow, endRow: closeRow };
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
// Helper: resolve a possibly-relative filePath against the project root(s).
//
// [B62] fs.existsSync/path.resolve on a relative path resolve against
// process.cwd() -- the MCP server host process's own working directory,
// which is NOT guaranteed to equal the Pulsar project root (depends on how
// Atom/Pulsar's runtime launched the plugin host). Tools that walk from
// atom.project.getPaths() (get-project-files, grep-project) or resolve via
// atom.project's own APIs (apply-patch) are unaffected; readTextFromFile/
// readFileOrBuffer's plain fs.existsSync check is not, and throws
// "File not found" on a relative path whenever cwd != project root, even
// though the file genuinely exists and is trivially found by glob.
//
// Fix: if the raw path doesn't exist and isn't already absolute, try
// resolving it against each open project root in turn before giving up.
// Absolute paths, and relative paths that already resolve against cwd, are
// returned unchanged -- this only adds a fallback, it never changes
// behavior for paths that already work today.
// ---------------------------------------------------------------------------
function resolveProjectPath(filePath) {
  // [B72] Explicit "root:<rootFolderName>/<rest>" prefix -- unambiguous virtual-root
  // addressing across multiple Pulsar project roots. When present, this is the ONLY
  // resolution attempted: a match must be exact (by root folder basename), and a
  // non-matching prefix throws immediately rather than silently falling through to
  // guesswork, since the whole point of the prefix is to remove ambiguity.
  if (typeof filePath === 'string' && filePath.startsWith('root:')) {
    const rest = filePath.slice('root:'.length);
    const sepIdx = rest.search(/[\\/]/);
    const rootName = sepIdx === -1 ? rest : rest.slice(0, sepIdx);
    const remainder = sepIdx === -1 ? '' : rest.slice(sepIdx + 1);
    const roots = (atom.project.getPaths && atom.project.getPaths()) || [];
    const match = roots.find(r => path.basename(r) === rootName);
    if (!match) {
      const known = roots.map(r => path.basename(r)).join(', ') || '(no project roots open)';
      throw new Error(`resolveProjectPath: no open project root named "${rootName}" in "${filePath}". Known roots: ${known}`);
    }
    return path.join(match, remainder);
  }

  if (fs.existsSync(filePath)) return filePath;
  const roots = (atom.project.getPaths && atom.project.getPaths()) || [];
  for (const root of roots) {
    const candidate = path.join(root, filePath);
    if (fs.existsSync(candidate)) return candidate;
  }
  return filePath; // unresolved -- let the caller's existsSync check produce the normal not-found error
}

// ---------------------------------------------------------------------------
// Helper: read a file's text for READ-ONLY tools (grep-file, grep-project,
// read-file, get-repo-map, read-lines, get-region, search-symbol,
// file-line-count, list-project-functions, get-file-summary,
// get-includes-and-defines, get-structural-anchors, namingcheck,
// check-function-docs), plus replace-across-files' own preview/commit scans.
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
//
// [B28, read side] Returns { text, staleWarning } rather than a bare string.
// staleWarning comes from checkStale() (defined further down this same
// file — hoisted, safe to call here) called right before returning, mirroring
// the edit-side disk-drift check already wired into buildEditResponse().
// '' when clean, or when this is the first time this session anything has
// touched the file (nothing to compare against yet — seeded silently).
// Callers pass staleWarning through to buildSearchResponse()
// (lib/read-response.js), which prepends it before the tool's own body text.
// ---------------------------------------------------------------------------
async function readTextFromFile(filePath) {
  if (shouldIgnore(filePath)) throw new Error(`mcp-ignore: "${filePath}" is ignored. Use open-file or edit .mcp-ignore to allow it.`);
  filePath = resolveProjectPath(filePath); // [B62] relative-path fallback against project roots
  if (!fs.existsSync(filePath)) throw new Error(`File not found: "${filePath}". Use get-project-files to list available paths.`);
  const resolved = path.resolve(filePath);
  const openEditor = atom.workspace.getTextEditors()
    .find(e => e.getPath() && path.resolve(e.getPath()) === resolved);
  if (openEditor) {
    const text = openEditor.getBuffer().getText();
    return { text, staleWarning: checkStale(filePath) };
  }
  // [B69] Two prior fixes at this spot both proved unsafe under live testing:
  // - Original code always called bufferForPath(), which registers a live
  //   TextBuffer with atom.project (file watcher + tree-sitter parser) and
  //   never released it — leaked one retained buffer per file touched on an
  //   unscoped project search (session notes [68]: ~7GB memory growth,
  //   tree-sitter WASM crashes).
  // - B68's fix (create-then-destroy, with isModified/isRetained guards and
  //   a try/catch around destroy) stopped the leak but crashed the renderer
  //   with a native access violation (confirmed via minidump analysis,
  //   session notes [69]/[70]): the alreadyRegistered check runs *before*
  //   bufferForPath resolves, so something else can start using the buffer
  //   in that window, and destroy() then tears it out from under that
  //   consumer at the native layer — a race the JS try/catch cannot guard
  //   against, since the crash isn't a catchable JS exception.
  //
  // [B69 fix] Root fix: never create a buffer we don't need in the first
  // place, rather than create-then-destroy. If nothing already has this
  // path registered (checked up front, same as before), skip
  // atom.project.bufferForPath entirely and read the file directly via
  // fs.readFile — no buffer is ever created, so there is nothing to race or
  // destroy. This trades Pulsar's automatic charset detection for files
  // with genuinely unusual (non-UTF8) encodings, which is judged an
  // acceptable and rare cost against a class of file corruption we
  // previously fixed for the read path (see B62's own note re resolving
  // paths only, not content) and a hard crash affecting the whole app. UTF-8
  // BOM is stripped by hand below since that's overwhelmingly the common
  // case (matches what bufferForPath would present via getText() anyway).
  //
  // If a buffer for this path IS already registered — meaning some other
  // live consumer (a concurrent edit tool, or a buffer left open outside
  // any visible tab) is relying on it — we go through bufferForPath as
  // before and deliberately do NOT touch/destroy it. This is the case
  // openEditor's tab-based check above doesn't catch, and is exactly the
  // scenario where returning fs.readFile's on-disk bytes could silently
  // hand back stale content instead of that buffer's real (possibly
  // unsaved) text — so this branch intentionally keeps using the live
  // buffer, not disk, for correctness.
  const alreadyRegistered = atom.project.getBuffers()
    .some(b => b.getPath() && path.resolve(b.getPath()) === resolved);
  let text;
  if (alreadyRegistered) {
    const buffer = await atom.project.bufferForPath(filePath);
    text = buffer.getText();
    // Not ours to destroy — someone else registered it, leave it alone.
  } else {
    const raw = await fs.promises.readFile(resolved, 'utf8');
    // Strip a UTF-8 BOM if present, matching what buffer.getText() would
    // have returned via bufferForPath's own encoding handling.
    text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  }
  return { text, staleWarning: checkStale(filePath) };
}
// ---------------------------------------------------------------------------
// Helper: detect whether a file's on-disk content has drifted from what this
// server last knew about it — i.e. something external (another process, the
// user editing outside Pulsar, another tool) touched the file since our last
// save or load, and the live buffer may now be about to read/write against
// content that no longer matches disk.
//
// Mechanism: mtime snapshot, same pattern already proven in run-command's
// pre/post-execution disk-change detection (mtimeBefore/mtimeAfter). We keep
// a module-level map of "the mtime as of the last time THIS SERVER touched
// this file" (recordKnownMtime, called on every successful save/load), and
// compare it against the file's current on-disk mtime on demand.
//
// Deliberately warn-only: does NOT reload the buffer or block the operation.
// The caller (buildEditResponse for edits, or a read tool) decides what to
// do with the warning string — for edits this means the LLM may be about to
// save over an external change; for reads it means the buffer content being
// returned may already be behind disk.
//
// Resets on every Pulsar restart (module-level map, no persistence) — that's
// fine, since a fresh process has no prior state to compare against; the
// first touch of any file after restart just seeds the map silently rather
// than warning.
// ---------------------------------------------------------------------------
const _knownMtimes = new Map();

function recordKnownMtime(filePath) {
  if (!filePath) return;
  try { _knownMtimes.set(path.resolve(filePath), fs.statSync(filePath).mtimeMs); }
  catch (_) { /* file may not exist yet (new/untitled) — nothing to record */ }
}

function checkStale(filePath) {
  if (!filePath) return '';
  const resolved = path.resolve(filePath);
  const known = _knownMtimes.get(resolved);
  let currentMtime;
  try { currentMtime = fs.statSync(filePath).mtimeMs; }
  catch (_) { return ''; } // file missing/unreadable — not this check's job to report that
  if (known === undefined) {
    // First time we've seen this file this session — seed silently, no warning.
    _knownMtimes.set(resolved, currentMtime);
    return '';
  }
  if (currentMtime !== known) {
    // Update the known mtime so we don't re-warn every call on the same drift.
    _knownMtimes.set(resolved, currentMtime);
    return `\n⚠️ STALE — "${path.basename(filePath)}" changed on disk since this server last touched it ` +
      `(outside this session, e.g. another tool, process, or edit made directly in Pulsar). ` +
      `The content just returned/edited may not reflect that external change. ` +
      `If this matters, re-read the file before trusting its content or making further edits.`;
  }
  return '';
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
  filePath = resolveProjectPath(filePath); // [B62] relative-path fallback against project roots
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
  findFunctionInBuffer,
  resolveProjectPath,
  readTextFromFile,
  readFileOrBuffer,
  retargetEditor,
  checkStale,
  recordKnownMtime,
};
