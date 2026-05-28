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

// Stores the last fuzzy-rescued patch hunks so confirm:true can apply them
// without re-parsing. Cleared on successful apply or on a new patch attempt.
const patchRescueStore = { hunks: null, patchKey: null };

// ---------------------------------------------------------------------------
// Edit statistics accumulator — persists for the session lifetime, queryable
// by the LLM via get-edit-stats. Tracks per-tool hits, fail reasons, hint
// usage, dry-run count, and rolling average old_str line count.
// ---------------------------------------------------------------------------
const editStats = {
  str_replace: {
    hits: 0,
    fails: {
      noMatch:         0,
      whitespace:      0,
      partialMatch:    0,
      outOfScope:      0,
      afterNotFound:   0,
      wrongOccurrence: 0,
    },
    hintsUsed: {
      functionHint:    0,
      afterHint:       0,
      lineHint:        0,
      betweenHint:     0,
      occurrence:      0,
      fuzzyWhitespace: 0,
    },
    fuzzyWhitespaceCommits: 0,
    dryRuns:       0,
    _oldStrLenSum: 0,
  },
  insert: {
    hits: 0,
    fails: { outOfRange: 0, anchorNotFound: 0 },
    hintsUsed: {
      functionHint:    0,
      afterHint:       0,
      lineHint:        0,
      betweenHint:     0,
      occurrence:      0,
      fuzzyWhitespace: 0,
      afterContent:    0,
      beforeContent:   0,
      functionEnd:     0,
      sectionHint:     0,
      preprocBlock:    0,
    },
    dryRuns: 0,
  },
  delete_line_range: {
    hits: 0,
    fails: { outOfRange: 0, inverted: 0 },
    hintsUsed: {
      functionHint:    0,
      afterHint:       0,
      lineHint:        0,
      betweenHint:     0,
      occurrence:      0,
      fuzzyWhitespace: 0,
    },
    dryRuns: 0,
  },
  replace_function_body: {
    hits: 0,
    fails: { notFound: 0 },
    hintsUsed: {
      functionHint:    0,
      afterHint:       0,
      lineHint:        0,
      betweenHint:     0,
      occurrence:      0,
      fuzzyWhitespace: 0,
    },
    dryRuns: 0,
  },
  replace_block: {
    hits: 0,
    fails: { anchorNotFound: 0, braceMatchFailed: 0 },
    hintsUsed: {
      functionHint:    0,
      afterHint:       0,
      lineHint:        0,
      betweenHint:     0,
      occurrence:      0,
      fuzzyWhitespace: 0,
    },
    dryRuns: 0,
  },
  apply_patch: {
    hits: 0,
    fails: { contextMismatch: 0, exception: 0 },
    largeEditWarnings: 0,
    hintsUsed: {
      functionHint:    0,
      afterHint:       0,
      lineHint:        0,
      betweenHint:     0,
      occurrence:      0,
      fuzzyWhitespace: 0,
    },
    dryRuns: 0,
  },
  replace_all: {
    hits: 0,
    fails: { noMatch: 0 },
    hintsUsed: {
      functionHint:    0,
      afterHint:       0,
      lineHint:        0,
      betweenHint:     0,
      occurrence:      0,
      fuzzyWhitespace: 0,
    },
    dryRuns: 0,
  },
  get_structural_anchors: {
    hits: 0,
    hintsUsed: {
      functionHint:    0,
      afterHint:       0,
      lineHint:        0,
      betweenHint:     0,
      occurrence:      0,
      fuzzyWhitespace: 0,
    },
    dryRuns: 0,
  },
  delete_block: {
    hits: 0,
    fails: { anchorNotFound: 0, startNotFound: 0, endNotFound: 0 },
    hintsUsed: {
      functionHint:    0,
      afterHint:       0,
      lineHint:        0,
      betweenHint:     0,
      occurrence:      0,
      fuzzyWhitespace: 0,
      sectionHint:     0,
      preprocBlock:    0,
      endContent:      0,
    },
    dryRuns: 0,
  },
  sed: {
    hits: 0,
    fails: { addressNotFound: 0, badExpression: 0, noMatch: 0 },
    hintsUsed: {
      functionHint:    0,
      afterHint:       0,
      lineHint:        0,
      betweenHint:     0,
      occurrence:      0,
      fuzzyWhitespace: 0,
    },
    dryRuns: 0,
  },
  read_lines: {
    hits: 0,
    fails: { outOfRange: 0, anchorNotFound: 0 },
    hintsUsed: {
      functionHint:    0,
      afterHint:       0,
      lineHint:        0,
      betweenHint:     0,
      occurrence:      0,
      fuzzyWhitespace: 0,
    },
    dryRuns: 0,
  },
  get_region: {
    hits: 0,
    fails: { startNotFound: 0, endNotFound: 0 },
    hintsUsed: {
      functionHint:    0,
      afterHint:       0,
      lineHint:        0,
      betweenHint:     0,
      occurrence:      0,
      fuzzyWhitespace: 0,
    },
    dryRuns: 0,
  },
  get_selection: {
    hits: 0,
    hintsUsed: {
      functionHint:    0,
      afterHint:       0,
      lineHint:        0,
      betweenHint:     0,
      occurrence:      0,
      fuzzyWhitespace: 0,
    },
    dryRuns: 0,
  },
  find_text: {
    hits: 0,
    fails: { noMatch: 0 },
    dryRuns: 0,
  },
  get_linter_messages: {
    hits: 0,
    dryRuns: 0,
  },
};

// ---------------------------------------------------------------------------
// Lifetime stats — same shape as editStats plus sessionCount.
// Loaded from disk at startup, flushed on reset:true and server shutdown.
// All increments go to BOTH editStats (session) and lifetimeStats (lifetime)
// via the bump() helper — no changes needed at instrumentation sites.
// ---------------------------------------------------------------------------
const STATS_PATH = (() => {
  try {
    return path.join(
      atom.packages.getLoadedPackage('pulsar-edit-mcp-server').path,
      'edit-stats.json'
    );
  } catch { return null; }
})();

function makeEmptyLifetime() {
  // Deep-clone editStats shape, add sessionCount
  const clone = JSON.parse(JSON.stringify(editStats));
  clone.sessionCount = 0;
  return clone;
}

let lifetimeStats = makeEmptyLifetime();

// Load from disk synchronously at startup (file may not exist yet — that's fine)
(function loadLifetimeStats() {
  if (!STATS_PATH) return;
  try {
    const raw  = require('fs').readFileSync(STATS_PATH, 'utf8');
    const disk = JSON.parse(raw);
    // Merge: disk values overwrite defaults, missing keys stay at 0
    function mergeInto(target, src) {
      for (const k of Object.keys(target)) {
        if (src[k] === undefined) continue;
        if (typeof target[k] === 'object' && target[k] !== null) {
          mergeInto(target[k], src[k]);
        } else {
          target[k] = src[k];
        }
      }
      // sessionCount lives at top level
      if (src.sessionCount !== undefined) target.sessionCount = src.sessionCount;
    }
    mergeInto(lifetimeStats, disk);
  } catch { /* file missing or corrupt — start fresh */ }
})();

// Flush lifetime stats to disk (async, fire-and-forget)
function flushLifetimeStats() {
  if (!STATS_PATH) return;
  fs.promises.writeFile(STATS_PATH, JSON.stringify(lifetimeStats, null, 2), 'utf8')
    .catch(e => console.error('[edit-stats] flush failed:', e.message));
}

// Sync session counters into lifetime — called before any lifetime read or flush.
// Walks editStats recursively and adds the delta (session value - last synced value)
// into lifetimeStats. We track "last synced" via a shadow copy updated each sync.
let _lastSynced = makeEmptyLifetime();

function syncToLifetime() {
  function addDelta(session, lifetime, shadow) {
    for (const k of Object.keys(session)) {
      if (k === 'sessionCount') continue;
      if (typeof session[k] === 'number') {
        const delta = session[k] - (shadow[k] || 0);
        if (delta > 0) {
          lifetime[k] = (lifetime[k] || 0) + delta;
          shadow[k]   = session[k];
        }
      } else if (typeof session[k] === 'object' && session[k] !== null) {
        if (!lifetime[k]) lifetime[k] = {};
        if (!shadow[k])   shadow[k]   = {};
        addDelta(session[k], lifetime[k], shadow[k]);
      }
    }
  }
  addDelta(editStats, lifetimeStats, _lastSynced);
}

// bump(statObj, path, n) — increment both session and lifetime in one call.
// path is dot-separated: e.g. 'str_replace.hits', 'str_replace.fails.whitespace'
// All existing instrumentation sites call editStats directly — this helper is
// used for NEW instrumentation and for the reset path going forward.
// The existing sites still work because they write to editStats directly, and
// lifetimeStats is synced on every increment via a Proxy-free approach:
// instead we sync lifetime at the point of each direct editStats write by
// wrapping the flush into the reset handler. For future cleanliness, new
// instrumentation should use bump() directly.
function bump(toolKey, subPath, n = 1) {
  // Walk session
  let s = editStats[toolKey];
  let l = lifetimeStats[toolKey];
  if (!s || !l) return;
  const parts = subPath.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    s = s[parts[i]]; l = l[parts[i]];
    if (!s || !l) return;
  }
  const leaf = parts[parts.length - 1];
  if (typeof s[leaf] === 'number') s[leaf] += n;
  if (typeof l[leaf] === 'number') l[leaf] += n;
}

// ---------------------------------------------------------------------------
// Shared anchor schema fragments — spread into tool inputSchema to avoid
// repeating the same Zod definitions across insert, delete-block, str_replace.
// Usage:  inputSchema: { ...ANCHOR_SCHEMA, myOwnParam: z.string() }
// ---------------------------------------------------------------------------
const ANCHOR_SCHEMA = {
  // Scope hints
  functionHint:    z.string().optional(),   // scope search to named function body
  afterHint:       z.string().optional(),   // start search after first occurrence of string
  lineHint:        z.number().optional(),   // start search at or after line N
  betweenHint:     z.object({ start: z.string(), end: z.string() }).optional(),
  occurrence:      z.number().int().min(1).optional(),  // target Nth match
  fuzzyWhitespace: z.boolean().optional(),  // match ignoring leading/trailing whitespace
  dryRun:          z.boolean().optional(),
};

// Structural anchor params used by insert and delete-block
const STRUCTURAL_ANCHOR_SCHEMA = {
  afterContent:  z.string().optional(),
  beforeContent: z.string().optional(),
  functionEnd:   z.string().optional(),
  sectionHint:   z.string().optional(),
  preprocBlock:  z.string().optional(),
  preprocSide:   z.enum(["open", "close"]).optional(),
  ...ANCHOR_SCHEMA,
};

// Shared description fragments reused across tools
const ANCHOR_DESC = {
  contentAnchor:
    "CONTENT-ANCHORED (preferred): Use `afterContent` / `beforeContent` — immune to line drift. " +
    "Combine with `functionHint` to scope to a function. Use `occurrence:N` for the Nth match.",
  structuralAnchor:
    "STRUCTURAL ANCHORS: `functionEnd` inserts after a named function's closing brace. " +
    "`sectionHint` targets a named /* ===…=== */ banner block. " +
    "`preprocBlock` targets a #ifdef…#endif pair by macro name. " +
    "Call get-structural-anchors first to list available names.",
  dryRun:
    "Set `dryRun:true` to preview without writing. Reply without dryRun to commit.",
};

function failureSuggestion(counter, toolName) {
  if (counter.count < 3) return "";
  const alts = {
    "str_replace":       "replace-function-body (whole function) or replace-document (full file)",
    "insert":            "afterContent/beforeContent anchor or functionEnd structural anchor (immune to line drift) — call get-structural-anchors to list available names",
    "delete-line-range": "delete-block with startContent/endContent or sectionHint/preprocBlock structural anchor — call get-structural-anchors to list available names",
    "apply-patch":       "str_replace for targeted edits or replace-function-body for whole-function rewrites",
    "sed":               "str_replace for single targeted edits or replace-all for global pattern replacement"
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
    for (let i = 1; i < allLines.length - 1; i++) {
      // Middle line must contain the keyword (case-insensitive)
      if (!allLines[i].toLowerCase().includes(keyword)) continue;
      // Previous line must look like an opening banner: /* === or /* ---
      const prev = allLines[i - 1].trim();
      if (!/^\/\*\s*[=\-]{6,}/.test(prev)) continue;
      // Next line must look like a closing banner: * === */ or * --- */
      const next = allLines[i + 1] ? allLines[i + 1].trim() : "";
      if (!/^\*\s*[=\-]{6,}/.test(next)) continue;
      // Found — opening /* line is i-1, closing */ line is i+1
      return { startRow: i - 1, endRow: i + 1 };
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
//   functionHint — restrict to the body of a named function
//   afterRow     — start searching from this 0-based row (e.g. after a prior anchor)
//   occurrence   — match the Nth hit rather than the first
//
// Returns { row, matchedRows, strategy } on success, null on failure.
//   row         — 0-based row of the first anchor line in the buffer
//   matchedRows — number of buffer lines consumed (= anchor line count)
//   strategy    — which strategy matched: "exact" | "fuzzy" | "indent"
// ---------------------------------------------------------------------------
function findAnchor(buffer, anchor, { occurrence = 1, functionHint = null, afterRow = 0 } = {}) {
  const allLines   = buffer.getLines();
  let   searchFrom = Math.max(0, afterRow);
  let   searchTo   = allLines.length - 1;

  if (functionHint) {
    const fn = findFunctionInBuffer(buffer, functionHint);
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
  { name: "find-text",               group: "edit",        desc: "Find all positions of a string/regex in the active editor. Supports contextLines (before/after arrays) and occurrence:N to return only the Nth match." },
  { name: "replace-document",        group: "edit",        desc: "Replace the entire editor contents with new text." },
  { name: "insert",                  group: "edit",        desc: "Insert lines before a line number or after/before a content anchor. New: functionEnd inserts after a named function's closing brace. Supports dryRun." },
  { name: "delete-line",             group: "edit",        desc: "DEPRECATED — use delete-line-range. Delete a single line." },
  { name: "delete-line-range",       group: "edit",        desc: "Delete a range of lines (inclusive). Supports dryRun." },
  { name: "delete-block",            group: "edit",        desc: "Delete lines between two content anchors. New: sectionHint deletes a named section banner block; preprocBlock deletes a #ifdef...#endif pair by macro name. Supports dryRun." },
  { name: "replace-block",           group: "edit",        desc: "Brace-matched block replace anchored by any content string — generalised replace-function-body for non-function blocks (P7). Supports dryRun." },
  { name: "get-region",              group: "edit",        desc: "Return lines between two content anchor strings — content-stable equivalent of read-lines (P8)." },
  { name: "get-selection",           group: "edit",        desc: "Return the currently selected text and its line/col range." },
  { name: "replace-all",             group: "edit",        desc: "Replace ALL occurrences of a string in the active editor." },
  { name: "get-structural-anchors",  group: "edit",        desc: "List available structural anchors in the active file — section banners (sectionHint), preprocessor blocks (preprocBlock), and function boundaries (functionEnd). Use before insert/delete-block to pick the right anchor." },
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
  { name: "read-lines",              group: "fileOps",     desc: "Read a line range from any file. Range modes: startLine+endLine (explicit), centerLine+radius (window around a line). Hint modes: functionHint (full function body), afterHint (range starting after a string), betweenHint (range between two strings), lineHint (alias for centerLine)." },
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
  // Safety
  { name: "undo",                    group: "safety",      desc: "Undo the last change in the active editor." },
  { name: "redo",                    group: "safety",      desc: "Redo the last undone change." },
  { name: "diff-preview",            group: "safety",      desc: "Show a unified diff of proposed changes without applying them." },
  { name: "checkpoint",              group: "safety",      desc: "Save a named in-memory snapshot of the current buffer. Cleared on server restart — saving MCP server source files triggers a restart and wipes all checkpoints." },
  { name: "restore-checkpoint",      group: "safety",      desc: "Restore the buffer to a named checkpoint." },
  { name: "list-checkpoints",        group: "safety",      desc: "List all saved in-memory checkpoints." },
  // Search
  { name: "grep-file",               group: "search",      desc: "Search a file for a pattern, return matching lines with optional contextLines and occurrence filtering." },
  { name: "grep-project",            group: "search",      desc: "Search all project files for a pattern." },
  { name: "search-symbol",           group: "search",      desc: "Find all uses of a C symbol with whole-word matching. Supports contextLines and occurrence filtering." },
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
          old_str:         z.string(),
          new_str:         z.string(),
          lineHint:        z.number().optional(),
          afterHint:       z.string().optional(),
          betweenHint:     z.object({ start: z.string(), end: z.string() }).optional(),
          fuzzyWhitespace: z.boolean().optional(),
          ...ANCHOR_SCHEMA,   // functionHint, occurrence, dryRun
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
            bump('str_replace', 'fails.outOfScope');
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
            bump('str_replace', 'fails.outOfScope');
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
            bump('str_replace', 'fails.outOfScope');
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
            bump('str_replace', 'fails.afterNotFound');
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
        if (functionHint)          bump('str_replace', 'hintsUsed.functionHint');
        if (betweenHint)           bump('str_replace', 'hintsUsed.betweenHint');
        if (afterHint)             bump('str_replace', 'hintsUsed.afterHint');
        if (lineHint)              bump('str_replace', 'hintsUsed.lineHint');
        if (occurrence > 1)        bump('str_replace', 'hintsUsed.occurrence');

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

        // Report if requested occurrence doesn't exist — show where the ones that DO exist are
        if (matchIndex === -1 && occurrencesFound > 0 && occurrence > occurrencesFound) {
          strReplFailures.count++;
          bump('str_replace', 'fails.wrongOccurrence');
          // Collect line numbers of all occurrences that were found so the caller can correct N
          const foundAt = [];
          let scanFrom = searchStart;
          const scanText = isMultiLine ? text : allLines.join("\n");
          for (let n = 0; n < occurrencesFound; n++) {
            const idx = scanText.indexOf(effectiveOldStr, scanFrom);
            if (idx === -1) break;
            foundAt.push(scanText.substring(0, idx).split("\n").length);
            scanFrom = idx + 1;
          }
          return {
            content: [{ type: "text", text: [
              `❌ occurrence:${occurrence} requested but only ${occurrencesFound} match(es) found for old_str${scopeLabel}.`,
              `📍 Found at line(s): ${foundAt.join(", ")} — use one of these as occurrence:N or adjust old_str.`,
              failureSuggestion(strReplFailures, curTool)
            ].filter(Boolean).join("\n") }],
            matched: false,
            occurrencesFound,
            foundAtLines: foundAt,
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
            bump('str_replace', 'fails.whitespace');
          } else if (partialMatchLines > 0 && partialMatchLines < lines.length) {
            bump('str_replace', 'fails.partialMatch');
          } else {
            bump('str_replace', 'fails.noMatch');
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
          bump('str_replace', 'dryRuns');
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
        bump('str_replace', 'hits');
        bump('str_replace', '_oldStrLenSum', old_str.split("\n").length);
        if (fuzzyWhitespace) bump('str_replace', 'fuzzyWhitespaceCommits');

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
    const curTool = "find-text";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Find Text",
        description: [
          "Search the active editor for a substring or regular expression and return the positions of each occurrence.",
          "Use contextLines to return N lines before and after each match (like grep -C) — each match includes a 'before' and 'after' array.",
          "Use occurrence to return only the Nth match (1-based) — useful when you want a specific hit with context without all results.",
          "Returns truncation flag if results exceed maxMatches so you know if search was capped."
        ].join(" "),
        inputSchema: {
          query:         z.string(),
          regex:         z.boolean().optional(),
          caseSensitive: z.boolean().optional(),
          maxMatches:    z.number().optional(),
          contextLines:  z.number().optional(),
          occurrence:    z.number().optional()
        }
      },
      async ({ query, regex = false, caseSensitive = false, maxMatches = 200, contextLines = 0, occurrence = 0 }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { query, regex, caseSensitive, maxMatches, contextLines, occurrence });

        const editor  = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        const text    = editor.getBuffer().getText();
        const source  = regex ? query : escapeRegex(query);
        const flags   = caseSensitive ? "" : "i";
        let pattern;
        try { pattern = new RegExp(source, flags); }
        catch (e) { throw new Error(`Invalid regex: ${e.message}`); }

        const lines      = text.split(/\r?\n/);
        const matches    = [];
        let truncated    = false;
        let globalIndex  = 0;

        outer:
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            globalIndex++;
            if (occurrence > 0 && globalIndex !== occurrence) continue;
            const entry = { line: i + 1, text: lines[i] };
            if (contextLines > 0) {
              entry.before = lines.slice(Math.max(0, i - contextLines), i).map((t, j) => ({ line: Math.max(1, i - contextLines + 1) + j, text: t }));
              entry.after  = lines.slice(i + 1, i + 1 + contextLines).map((t, j) => ({ line: i + 2 + j, text: t }));
            }
            matches.push(entry);
            if (occurrence > 0) { break outer; }
            if (matches.length >= maxMatches) { truncated = true; break outer; }
          }
        }

        if (occurrence > 0 && matches.length === 0) {
          bump('find_text', 'fails', 'noMatch');
          throw new Error(`occurrence ${occurrence} not found — only ${globalIndex} match(es) in file.`);
        }

        if (matches.length === 0) { bump('find_text', 'fails', 'noMatch'); return { content: [{ type: "text", text: "No matches." }], matches: [], totalMatches: 0, truncated: false }; }

        bump('find_text', 'hits');
        return {
          content: [{ type: "text", text: JSON.stringify({ matches, totalMatches: matches.length, truncated, message: truncated ? `Results capped at ${maxMatches}. Refine your query or increase maxMatches.` : "All matches found." }, null, 2) }],
          matches, totalMatches: matches.length, truncated
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
          "STRUCTURAL ANCHORS: `functionEnd` inserts immediately after a named function's closing brace — the most reliable way to insert between functions. Example: functionEnd:'load_secrets' inserts after that function ends.",
          "Set `dryRun:true` to preview what will be inserted and where without writing — response shows the surrounding context so you can confirm. Reply with the same call without dryRun (or dryRun:false) to commit.",
          "CORRUPTION RISK: line numbers shift after every insert — using stale line numbers for a subsequent insert or delete will hit the wrong lines and silently corrupt the file.",
          "You MUST call get-document or read-lines after each insert to get updated line numbers before any further line-based edits. Returns newLineCount so you can verify the shift."
        ].join(" "),
        inputSchema: {
          new_str:       z.string(),
          insert_line:   z.number().optional(),
          ...STRUCTURAL_ANCHOR_SCHEMA,  // afterContent, beforeContent, functionEnd, sectionHint, preprocBlock, preprocSide, functionHint, occurrence, dryRun
        }
      },
      async ({ insert_line, new_str, afterContent, beforeContent, functionHint, functionEnd, occurrence = 1, dryRun = false }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { insert_line, new_str: new_str.substring(0, 80), afterContent, beforeContent, functionHint, functionEnd, occurrence, dryRun });

        const editor    = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer    = editor.getBuffer();
        const lineCount = buffer.getLineCount();
        const allLines  = buffer.getLines();

        // ── functionEnd structural anchor ─────────────────────────────────────
        if (functionEnd !== undefined) {
          bump('insert', 'hintsUsed.functionEnd');
          if (occurrence > 1) bump('insert', 'hintsUsed.occurrence');
          const resolved = resolveStructuralAnchor(buffer, { functionEnd });
          if (!resolved) {
            bump('insert', 'fails.anchorNotFound');
            return { content: [{ type: "text", text: `❌ functionEnd: function "${functionEnd}" not found. Use get-structural-anchors to list available function names.` }], inserted: false };
          }
          const insertRow  = resolved.endRow + 1;
          const scopeLabel = ` after end of "${functionEnd}"`;
          if (dryRun) {
            bump('insert', 'dryRuns');
            const r         = 3;
            const cs        = Math.max(0, resolved.endRow - r);
            const ce        = Math.min(lineCount - 1, insertRow + r);
            const ctxLines  = allLines.slice(cs, insertRow).map((l, i) => `${String(cs + i + 1).padStart(4)}   ${l}`);
            const insLines  = new_str.split("\n").map(l => `${" ".repeat(4)} ► ${l}`);
            const aftLines  = allLines.slice(insertRow, ce + 1).map((l, i) => `${String(insertRow + i + 1).padStart(4)}   ${l}`);
            return {
              content: [{ type: "text", text: [
                `✅ DRY RUN — will insert ${new_str.split("\n").length} line(s)${scopeLabel} (after line ${resolved.endRow + 1}).`,
                `\nContext (► = lines to be inserted):\n${[...ctxLines, ...insLines, ...aftLines].join("\n")}`,
                `\nReply with the same call without dryRun (or dryRun:false) to commit.`
              ].join("\n") }],
              dryRun: true, insertRow: insertRow + 1, lineCount
            };
          }
          const textWithNewline = new_str.endsWith("\n") ? new_str : new_str + "\n";
          buffer.insert([insertRow, 0], textWithNewline);
          decorateLine(editor, insertRow, "added");
          insertFailures.count = 0;
          bump('insert', 'hits');
          const newLineCount = buffer.getLineCount();
          return {
            content: [{ type: "text", text: `✅ Inserted ${new_str.split("\n").length} line(s)${scopeLabel}. New line count: ${newLineCount}. Remember: line numbers have shifted!` }],
            dryRun: false, newLineCount
          };
        }

        // ── Content-anchored insert ───────────────────────────────────────────
        if (afterContent !== undefined || beforeContent !== undefined) {
          if (afterContent !== undefined)  bump('insert', 'hintsUsed.afterContent');
          if (beforeContent !== undefined) bump('insert', 'hintsUsed.beforeContent');
          if (functionHint)                bump('insert', 'hintsUsed.functionHint');
          if (occurrence > 1)              bump('insert', 'hintsUsed.occurrence');
          const anchor      = afterContent !== undefined ? afterContent : beforeContent;
          const insertAfter = afterContent !== undefined;
          const scopeLabel  = functionHint ? ` within function "${functionHint}"` : "";

          const hit = findAnchor(buffer, anchor, { occurrence, functionHint });

          if (!hit) {
            insertFailures.count++;
            bump('insert', 'fails.anchorNotFound');
            // Show the 10 lines around where a function scope starts (if scoped)
            // or the top of the file, so the caller can pick a better anchor
            const fn       = functionHint ? findFunctionInBuffer(buffer, functionHint) : null;
            const previewFrom = fn ? fn.startRow : 0;
            const previewTo   = Math.min(allLines.length - 1, previewFrom + 10);
            const ctx = allLines.slice(previewFrom, previewTo + 1)
              .map((l, i) => `${String(previewFrom + i + 1).padStart(4)}: ${l}`).join("\n");
            return { content: [{ type: "text", text: [
              `❌ ${insertAfter ? "afterContent" : "beforeContent"} not found${scopeLabel}: "${anchor}"`,
              functionHint && !fn ? `   (functionHint "${functionHint}" was also not found — check the function name)` : "",
              `\n📍 ${fn ? `Start of "${functionHint}"` : "Top of file"} — pick a single unique anchor line from here:\n${ctx}`,
              `\n💡 Tip: use a single unique line as anchor. Multi-line anchors work but every line must match exactly. Use functionHint to scope to a function body.`,
              failureSuggestion(insertFailures, "insert")
            ].filter(Boolean).join("\n") }], inserted: false, insertFailures: insertFailures.count };
          }

          // Insert row: after last matched anchor line or before first
          const anchorRow   = hit.row;
          const anchorEnd   = hit.row + hit.matchedRows - 1;
          const insertRow   = insertAfter ? anchorEnd + 1 : anchorRow;
          const strategyMsg = hit.strategy !== "exact" ? ` (matched via ${hit.strategy} — consider tightening your anchor)` : "";

          if (dryRun) {
            bump('insert', 'dryRuns');
            const r  = 3;
            const cs = Math.max(0, insertRow - r - (insertAfter ? 0 : 1));
            const ce = Math.min(lineCount - 1, insertRow + r);
            const ctxLines  = allLines.slice(cs, Math.min(insertRow, ce + 1))
              .map((l, i) => `${String(cs + i + 1).padStart(4)}   ${l}`);
            const insLines  = new_str.split("\n").map(l => `${" ".repeat(4)} ► ${l}`);
            const afterLines = allLines.slice(insertRow, ce + 1)
              .map((l, i) => `${String(insertRow + i + 1).padStart(4)}   ${l}`);
            const preview = [...ctxLines, ...insLines, ...afterLines].join("\n");
            return {
              content: [{ type: "text", text: [
                `✅ DRY RUN — will insert ${new_str.split("\n").length} line(s) ${insertAfter ? "after" : "before"} anchor (line ${anchorRow + 1})${scopeLabel}${strategyMsg}.`,
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
          bump('insert', 'hits');
          const newLineCount = buffer.getLineCount();
          return {
            content: [{ type: "text", text: `✅ Inserted ${new_str.split("\n").length} line(s) ${insertAfter ? "after" : "before"} anchor (line ${anchorRow + 1})${scopeLabel}${strategyMsg}. New line count: ${newLineCount}. Remember: line numbers have shifted!` }],
            dryRun: false, newLineCount
          };
        }

        // ── Line-number-based insert (legacy) ─────────────────────────────────
        if (insert_line === undefined) {
          return { content: [{ type: "text", text: "❌ Either insert_line or afterContent/beforeContent is required." }], inserted: false };
        }

        if (insert_line < 1 || insert_line > lineCount + 1) {
          insertFailures.count++;
          bump('insert', 'fails.outOfRange');
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
          bump('insert', 'dryRuns');
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
        bump('insert', 'hits');

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
        inputSchema: { startLine: z.number(), endLine: z.number(), filePath: z.string().optional() }
      },
      async ({ startLine, endLine, dryRun = false, functionHint, afterHint, lineHint, betweenHint, occurrence = 1, fuzzyWhitespace }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { startLine, endLine, dryRun, functionHint, afterHint, lineHint, betweenHint, occurrence, fuzzyWhitespace });

        const editor    = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer    = editor.getBuffer();
        const allLines  = buffer.getLines();
        const lineCount = buffer.getLineCount();

        // ── Resolve anchor hints to line numbers ──────────────────────────────
        // If any hint is provided, resolve it to override startLine (and optionally endLine).
        // functionHint: scope to function body — sets startLine+endLine to function bounds.
        // betweenHint: sets startLine+endLine to the region between two strings.
        // afterHint / lineHint: sets startLine to the resolved row + 1 (endLine unchanged).
        if (functionHint) {
          bump('delete_line_range', 'hintsUsed.functionHint');
          const fn = findFunctionInBuffer(buffer, functionHint);
          if (!fn) {
            bump('delete_line_range', 'fails.outOfRange');
            return { content: [{ type: "text", text: `❌ functionHint: function "${functionHint}" not found in active editor.` }], deleted: false };
          }
          startLine = fn.startRow + 1;
          endLine   = fn.endRow   + 1;
        } else if (betweenHint) {
          bump('delete_line_range', 'hintsUsed.betweenHint');
          const text = buffer.getText();
          const si = text.indexOf(betweenHint.start);
          if (si === -1) {
            bump('delete_line_range', 'fails.outOfRange');
            return { content: [{ type: "text", text: `❌ betweenHint.start "${betweenHint.start}" not found in file.` }], deleted: false };
          }
          const ei = text.indexOf(betweenHint.end, si + betweenHint.start.length);
          if (ei === -1) {
            bump('delete_line_range', 'fails.outOfRange');
            return { content: [{ type: "text", text: `❌ betweenHint.end "${betweenHint.end}" not found after start anchor.` }], deleted: false };
          }
          startLine = text.substring(0, si).split("\n").length;
          endLine   = text.substring(0, ei + betweenHint.end.length).split("\n").length;
        } else if (afterHint) {
          bump('delete_line_range', 'hintsUsed.afterHint');
          const text = buffer.getText();
          const ai = text.indexOf(afterHint);
          if (ai === -1) {
            bump('delete_line_range', 'fails.outOfRange');
            return { content: [{ type: "text", text: `❌ afterHint "${afterHint}" not found in file.` }], deleted: false };
          }
          startLine = text.substring(0, ai + afterHint.length).split("\n").length;
        } else if (lineHint) {
          bump('delete_line_range', 'hintsUsed.lineHint');
          startLine = lineHint;
        }
        if (occurrence > 1) bump('delete_line_range', 'hintsUsed.occurrence');
        if (fuzzyWhitespace) bump('delete_line_range', 'hintsUsed.fuzzyWhitespace');

        if (startLine < 1 || endLine < 1) {
          deleteFailures.count++;
          bump('delete_line_range', 'fails.outOfRange');
          return { content: [{ type: "text", text: [
            `❌ Line numbers must be 1-based (got startLine=${startLine}, endLine=${endLine}).`,
            `   File has ${lineCount} lines.`,
            failureSuggestion(deleteFailures, "delete-line-range")
          ].filter(Boolean).join("\n") }], deleted: false, deleteFailures: deleteFailures.count };
        }
        if (startLine > endLine) {
          deleteFailures.count++;
          bump('delete_line_range', 'fails.inverted');
          return { content: [{ type: "text", text: [
            `❌ startLine (${startLine}) must be <= endLine (${endLine}).`,
            `   Did you mean startLine=${endLine}, endLine=${startLine}?`,
            failureSuggestion(deleteFailures, "delete-line-range")
          ].filter(Boolean).join("\n") }], deleted: false, deleteFailures: deleteFailures.count };
        }
        if (endLine > lineCount) {
          deleteFailures.count++;
          bump('delete_line_range', 'fails.outOfRange');
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
          bump('delete_line_range', 'dryRuns');
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
        bump('delete_line_range', 'hits');

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

        bump('get_selection', 'hits');
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
          "STRUCTURAL ANCHORS (preferred for C files): `sectionHint` deletes an entire named section banner block by keyword (e.g. sectionHint:'TERMINAL ECHO'). `preprocBlock` deletes a complete #ifdef...#endif pair by macro name (e.g. preprocBlock:'XPP_BUILD_TOOL'). Use `preprocSide:'open'` or `'close'` to target just one end of the pair.",
          "CONTENT ANCHORS: Provide startContent and endContent strings; the tool finds their lines and deletes everything between them (inclusive).",
          "Use inclusive:false to exclude the anchor lines themselves (delete only the content between them).",
          "Combine with functionHint to scope the search to a named function body.",
          "Use occurrence:N to target the Nth occurrence of startContent.",
          "Set dryRun:true to preview what will be deleted without writing."
        ].join(" "),
        inputSchema: {
          startContent: z.string().optional(),
          endContent:   z.string().optional(),
          inclusive:    z.boolean().optional(),
          ...STRUCTURAL_ANCHOR_SCHEMA,  // sectionHint, preprocBlock, preprocSide, functionHint, occurrence, dryRun
        }
      },
      async ({ startContent, endContent, sectionHint, preprocBlock, preprocSide, inclusive = true, functionHint, occurrence = 1, dryRun = false }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { startContent, endContent, sectionHint, preprocBlock, preprocSide, inclusive, functionHint, occurrence, dryRun });

        const editor    = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer    = editor.getBuffer();
        const allLines  = buffer.getLines();
        const lineCount = buffer.getLineCount();

        // ── Structural anchor pre-pass ────────────────────────────────────────
        // sectionHint and preprocBlock resolve directly to { startRow, endRow }
        // and bypass the startContent/endContent matching entirely.
        if (sectionHint !== undefined || preprocBlock !== undefined) {
          bump('delete_block', 'hintsUsed.preprocBlock');
          bump('delete_block', 'hintsUsed.functionHint');
          bump('delete_block', 'hintsUsed.occurrence');
          if (sectionHint)   bump('delete_block', 'hintsUsed.sectionHint');
          const resolved = resolveStructuralAnchor(buffer, { sectionHint, preprocBlock, preprocSide });
          if (!resolved) {
            deleteFailures.count++;
            bump('delete_block', 'fails.anchorNotFound');
            const kind = sectionHint ? `sectionHint "${sectionHint}"` : `preprocBlock "${preprocBlock}"`;
            return { content: [{ type: "text", text: [
              `❌ ${kind} not found. Use get-structural-anchors to list available anchors.`,
              failureSuggestion(deleteFailures, "delete-line-range")
            ].filter(Boolean).join("\n") }], deleted: false };
          }
          const delStart = resolved.startRow;
          const delEnd   = resolved.endRow;
          const deletedCount = delEnd - delStart + 1;
          const r = 3;
          const cs = Math.max(0, delStart - r);
          const ce = Math.min(lineCount - 1, delEnd + r);
          const preview = allLines.slice(cs, ce + 1).map((l, i) => {
            const abs = cs + i;
            return `${String(abs + 1).padStart(4)}${abs >= delStart && abs <= delEnd ? " ✂" : "  "} ${l}`;
          }).join("\n");
          if (dryRun) {
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
          bump('delete_block', 'hits');
          const newLineCount = buffer.getLineCount();
          return {
            content: [{ type: "text", text: `✅ Deleted ${deletedCount} line(s) (lines ${delStart + 1}–${delEnd + 1}). New line count: ${newLineCount}. Line numbers have shifted.` }],
            dryRun: false, deleted: true, newLineCount, deletedCount, staleLinesWarning: true
          };
        }

        // ── Content-anchor path (startContent + endContent) ───────────────────
        if (!startContent || !endContent) {
          return { content: [{ type: "text", text: "❌ Provide either sectionHint, preprocBlock, or both startContent and endContent." }], deleted: false };
        }

                // Track content-anchor hint usage
        bump('delete_block', 'hintsUsed.endContent');
        bump('delete_block', 'hintsUsed.functionHint');
        bump('delete_block', 'hintsUsed.occurrence');

        // Resolve optional function scope
        let searchFrom = 0;
        let searchTo   = allLines.length - 1;
        if (functionHint) {
          const fn = findFunctionInBuffer(buffer, functionHint);
          if (!fn) {
            deleteFailures.count++;
            bump('delete_block', 'fails.anchorNotFound');
            return { content: [{ type: "text", text: `❌ functionHint: function "${functionHint}" not found.` }], deleted: false };
          }
          searchFrom = fn.startRow;
          searchTo   = fn.endRow;
        }

        // Find Nth occurrence of startContent (multi-line, fuzzy, indent-aware)
        const startHit = findAnchor(buffer, startContent, { occurrence, functionHint, afterRow: searchFrom });
        if (!startHit) {
          deleteFailures.count++;
          bump('delete_block', 'fails.startNotFound');
          return { content: [{ type: "text", text: [
            `❌ startContent not found (occurrence ${occurrence}): "${startContent}"`,
            failureSuggestion(deleteFailures, "delete-line-range")
          ].filter(Boolean).join("\n") }], deleted: false, deleteFailures: deleteFailures.count };
        }
        const startRow     = startHit.row;
        const startMsgHint = startHit.strategy !== "exact" ? ` (startContent matched via ${startHit.strategy})` : "";

        // Find endContent starting after startContent (multi-line, fuzzy, indent-aware)
        const endHit = findAnchor(buffer, endContent, { afterRow: startRow + 1, functionHint });
        if (!endHit) {
          deleteFailures.count++;
          bump('delete_block', 'fails.endNotFound');
          const previewStart = startRow + 1;
          const previewEnd   = Math.min(allLines.length - 1, startRow + 10);
          const afterCtx     = allLines.slice(previewStart, previewEnd + 1)
            .map((l, i) => `${String(previewStart + i + 1).padStart(4)}: ${l}`).join("\n");
          return { content: [{ type: "text", text: [
            `❌ endContent not found after startContent (line ${startRow + 1}): "${endContent}"`,
            `\n📍 Lines after startContent — pick the correct endContent from here:\n${afterCtx}`,
            `\n💡 Tip: endContent can be multi-line or fuzzy-matched, but every line must appear in order. Use a single unique line if possible.`,
            failureSuggestion(deleteFailures, "delete-line-range")
          ].filter(Boolean).join("\n") }], deleted: false, deleteFailures: deleteFailures.count };
        }
        const endRow     = endHit.row + endHit.matchedRows - 1;
        const endMsgHint = endHit.strategy !== "exact" ? ` (endContent matched via ${endHit.strategy})` : "";

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
          return {
            content: [{ type: "text", text: [
              `✅ DRY RUN — will delete ${deletedCount} line(s) (lines ${delStart + 1}–${delEnd + 1})${startMsgHint}${endMsgHint}.`,
              `\nContext (✂ = lines to be deleted):\n${preview}`,
              `\nReply with the same call without dryRun (or dryRun:false) to commit.`
            ].join("\n") }],
            dryRun: true, deleted: false, startLine: delStart + 1, endLine: delEnd + 1, deletedCount
          };
        }

        buffer.deleteRows(delStart, delEnd);
        decorateLine(editor, delStart, "removed");
        deleteFailures.count = 0;
        bump('delete_block', 'hits');
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
          anchor:  z.string(),
          newBody: z.string(),
          ...ANCHOR_SCHEMA
        }
      },
      async ({ anchor, newBody, occurrence = 1, dryRun = false, functionHint, afterHint, lineHint, betweenHint, fuzzyWhitespace }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { anchor: anchor.substring(0, 80), newBodyLength: newBody.length, occurrence, dryRun, functionHint, afterHint, lineHint, betweenHint, fuzzyWhitespace });

        const editor    = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer    = editor.getBuffer();
        const allLines  = buffer.getLines();

        // ── Resolve search scope from hints (same priority as str_replace) ────
        // functionHint > betweenHint > afterHint > lineHint > entire file
        let searchStartRow = 0;
        let searchEndRow   = allLines.length - 1;

        if (functionHint) {
          bump('replace_block', 'hintsUsed.functionHint');
          const fn = findFunctionInBuffer(buffer, functionHint);
          if (!fn) {
            bump('replace_block', 'fails.anchorNotFound');
            return { content: [{ type: "text", text: `❌ functionHint: function "${functionHint}" not found in active editor.` }], found: false };
          }
          searchStartRow = fn.startRow;
          searchEndRow   = fn.endRow;
        } else if (betweenHint) {
          bump('replace_block', 'hintsUsed.betweenHint');
          const text = buffer.getText();
          const si = text.indexOf(betweenHint.start);
          if (si === -1) {
            bump('replace_block', 'fails.anchorNotFound');
            return { content: [{ type: "text", text: `❌ betweenHint.start "${betweenHint.start}" not found in file.` }], found: false };
          }
          const ei = text.indexOf(betweenHint.end, si + betweenHint.start.length);
          if (ei === -1) {
            bump('replace_block', 'fails.anchorNotFound');
            return { content: [{ type: "text", text: `❌ betweenHint.end "${betweenHint.end}" not found after start anchor.` }], found: false };
          }
          searchStartRow = text.substring(0, si).split("\n").length - 1;
          searchEndRow   = text.substring(0, ei + betweenHint.end.length).split("\n").length - 1;
        } else if (afterHint) {
          bump('replace_block', 'hintsUsed.afterHint');
          const text = buffer.getText();
          const ai = text.indexOf(afterHint);
          if (ai === -1) {
            bump('replace_block', 'fails.anchorNotFound');
            return { content: [{ type: "text", text: `❌ afterHint "${afterHint}" not found in file.` }], found: false };
          }
          searchStartRow = text.substring(0, ai + afterHint.length).split("\n").length - 1;
        } else if (lineHint) {
          bump('replace_block', 'hintsUsed.lineHint');
          searchStartRow = Math.max(0, lineHint - 1);
        }
        if (occurrence > 1) bump('replace_block', 'hintsUsed.occurrence');
        if (fuzzyWhitespace) bump('replace_block', 'hintsUsed.fuzzyWhitespace');

        // Find Nth occurrence of anchor within scoped rows
        let found = 0;
        let anchorRow = -1;
        for (let i = searchStartRow; i <= searchEndRow; i++) {
          if (allLines[i].includes(anchor)) {
            found++;
            if (found === occurrence) { anchorRow = i; break; }
          }
        }
        if (anchorRow === -1) {
          bump('replace_block', 'fails.anchorNotFound');
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
          bump('replace_block', 'fails.braceMatchFailed');
          // Show what comes after the anchor so the caller can see why there's no brace
          const previewEnd = Math.min(allLines.length - 1, anchorRow + 6);
          const ctx = allLines.slice(anchorRow, previewEnd + 1)
            .map((l, i) => `${String(anchorRow + i + 1).padStart(4)}: ${l}`).join("\n");
          return { content: [{ type: "text", text: [
            `❌ No opening brace { found after anchor "${anchor}" (line ${anchorRow + 1}).`,
            `\n📍 Lines at and after anchor — verify this is a brace-delimited block:\n${ctx}`
          ].join("\n") }], found: false };
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
          bump('replace_block', 'fails.braceMatchFailed');
          // Show context around the unclosed brace so the caller can see the file structure
          const previewEnd = Math.min(allLines.length - 1, braceStartRow + 15);
          const ctx = allLines.slice(braceStartRow, previewEnd + 1)
            .map((l, i) => `${String(braceStartRow + i + 1).padStart(4)}: ${l}`).join("\n");
          return { content: [{ type: "text", text: [
            `❌ Brace matching failed — unmatched { after anchor "${anchor}" (line ${braceStartRow + 1}).`,
            `\n📍 Content from opening brace — check for missing } or nested blocks:\n${ctx}`
          ].join("\n") }], found: false };
        }

        const startRow = anchorRow;
        const ensuredNewline = newBody.endsWith("\n") ? newBody : newBody + "\n";
        const insertedLines  = ensuredNewline.split(/\r?\n/).length - 1;

        if (dryRun) {
          bump('replace_block', 'dryRuns');
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
        const newLineCount = buffer.getLineCount();
        bump('replace_block', 'hits');
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
          filePath:     z.string().optional(),
          ...ANCHOR_SCHEMA
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
        const norm     = s => s.replace(/\s+/g, " ").trim();

        // findAnchorInLines — same strategy as findAnchor but works on a plain array
        function findAnchorInLines(lines, anchor, fromRow = 0, occ = 1) {
          const ancLines = anchor.split("\n");
          function matchesAt(i, strategy) {
            if (i + ancLines.length - 1 >= lines.length) return false;
            for (let k = 0; k < ancLines.length; k++) {
              const buf = lines[i + k], anc = ancLines[k];
              if (strategy === "exact"  && !buf.includes(anc))        return false;
              if (strategy === "fuzzy"  && norm(buf) !== norm(anc))   return false;
              if (strategy === "indent" && buf.trim() !== anc.trim()) return false;
            }
            return true;
          }
          for (const strategy of ["exact", "fuzzy", "indent"]) {
            let found = 0;
            for (let i = fromRow; i <= lines.length - ancLines.length; i++) {
              if (matchesAt(i, strategy)) {
                found++;
                if (found === occ) return { row: i, matchedRows: ancLines.length, strategy };
              }
            }
          }
          return null;
        }

        const startHit = findAnchorInLines(allLines, startContent, 0, occurrence);
        if (!startHit) {
          bump('get_region', 'fails.startNotFound');
          return { content: [{ type: "text", text: `❌ startContent not found (occurrence ${occurrence}): "${startContent}"` }], found: false };
        }
        const startRow = startHit.row;

        const endHit = findAnchorInLines(allLines, endContent, startRow + 1);
        if (!endHit) {
          bump('get_region', 'fails.endNotFound');
          return { content: [{ type: "text", text: `❌ endContent not found after line ${startRow + 1}: "${endContent}"` }], found: false };
        }
        const endRow = endHit.row + endHit.matchedRows - 1;

        const sliceStart = inclusive ? startRow : startRow + 1;
        const sliceEnd   = inclusive ? endRow   : endRow   - 1;
        const lines = allLines.slice(sliceStart, sliceEnd + 1).map((t, i) => ({ n: sliceStart + i + 1, text: t }));

        bump('get_region', 'hits');
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
        const skipped = [];
        let totalReplacements = 0;

        for (const filePath of allFiles) {
          let original;
          try { original = await readFileOrBuffer(filePath); } catch (e) { skipped.push({ filePath, reason: e.message }); continue; }
          let count = 0;
          const updated = original.replace(new RegExp(source, flags), () => { count++; return replacement; });
          if (count === 0) continue;
          totalReplacements += count;
          results.push({ filePath, replacements: count });
          if (!dryRun) {
            const openEditor = atom.workspace.getTextEditors().find(e => e.getPath() && path.resolve(e.getPath()) === path.resolve(filePath));
            try {
              if (openEditor) openEditor.getBuffer().setTextViaDiff(updated);
              else await fs.promises.writeFile(filePath, updated, "utf8");
            } catch (e) {
              skipped.push({ filePath, reason: `write failed: ${e.message}` });
            }
          }
        }

        const summary = dryRun
          ? `DRY RUN - ${totalReplacements} replacement(s) across ${results.length} file(s). No files written.`
          : `Replaced ${totalReplacements} occurrence(s) across ${results.length} file(s).`;

        return {
          content: [{ type: "text", text: JSON.stringify({
            summary, totalReplacements, filesAffected: results.length, dryRun, files: results,
            skipped: skipped.length > 0 ? skipped : undefined,
            skippedCount: skipped.length
          }, null, 2) }],
          totalReplacements, filesAffected: results.length, dryRun, skippedCount: skipped.length
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
          ...ANCHOR_SCHEMA
        }
      },
      async ({ name, newBody, dryRun = false, occurrence = 1, functionHint, afterHint, lineHint, betweenHint, fuzzyWhitespace }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { name, newBodyLength: newBody.length, dryRun, occurrence, functionHint, afterHint, lineHint, betweenHint, fuzzyWhitespace });

        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        const buffer   = editor.getBuffer();
        const allLines = buffer.getLines();
        const text     = buffer.getText();

        // ── Resolve search scope from hints ────────────────────────────────────
        // afterHint/betweenHint/lineHint constrain which occurrence of `name` to target.
        // occurrence:N picks the Nth matching function when the name appears multiple times.
        let searchStartRow = 0;
        let searchEndRow   = allLines.length - 1;

        if (functionHint) {
          bump('replace_function_body', 'hintsUsed.functionHint');
          // functionHint scopes to another function's body to disambiguate nested/same-name fns
          const outer = findFunctionInBuffer(buffer, functionHint);
          if (outer) { searchStartRow = outer.startRow; searchEndRow = outer.endRow; }
        } else if (betweenHint) {
          bump('replace_function_body', 'hintsUsed.betweenHint');
          const si = text.indexOf(betweenHint.start);
          const ei = si !== -1 ? text.indexOf(betweenHint.end, si + betweenHint.start.length) : -1;
          if (si !== -1) searchStartRow = text.substring(0, si).split("\n").length - 1;
          if (ei !== -1) searchEndRow   = text.substring(0, ei + betweenHint.end.length).split("\n").length - 1;
        } else if (afterHint) {
          bump('replace_function_body', 'hintsUsed.afterHint');
          const ai = text.indexOf(afterHint);
          if (ai !== -1) searchStartRow = text.substring(0, ai + afterHint.length).split("\n").length - 1;
        } else if (lineHint) {
          bump('replace_function_body', 'hintsUsed.lineHint');
          searchStartRow = Math.max(0, lineHint - 1);
        }
        if (occurrence > 1) bump('replace_function_body', 'hintsUsed.occurrence');
        if (fuzzyWhitespace) bump('replace_function_body', 'hintsUsed.fuzzyWhitespace');

        // Find the Nth occurrence of the named function within the scoped rows
        const sigRe = new RegExp("(?:^|\\s)" + escapeRegex(name) + "\\s*\\(");
        let matchCount = 0;
        let found = null;
        for (let i = searchStartRow; i <= searchEndRow; i++) {
          const line = allLines[i];
          if (sigRe.test(line) && !line.trim().startsWith("//") && !line.trim().startsWith("*")) {
            let hasBrace = false;
            for (let j = i; j < Math.min(i + 6, allLines.length); j++) {
              if (allLines[j].includes("{")) { hasBrace = true; break; }
              if (j > i && allLines[j].includes(";")) break;
            }
            if (hasBrace) {
              matchCount++;
              if (matchCount === occurrence) {
                // Brace-match from this startRow
                let depth = 0, endRow = -1;
                for (let j = i; j < allLines.length; j++) {
                  for (const ch of allLines[j]) {
                    if (ch === "{") depth++;
                    else if (ch === "}") { depth--; if (depth === 0) { endRow = j; break; } }
                  }
                  if (endRow !== -1) break;
                }
                if (endRow !== -1) { found = { startRow: i, endRow }; break; }
              }
            }
          }
        }

        if (!found) {
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
            // Show the close matches with their actual current signatures so the caller can correct immediately
            const sigLines = close.map(fn => {
              const sigRe2 = new RegExp(`(?:^|\\n)([^\\n]*\\b${escapeRegex(fn)}\\s*\\([^)]*\\)[^\\n]*)`, "m");
              const m2 = sigRe2.exec(allSrc);
              return m2 ? `  ${fn}  →  ${m2[1].trim()}` : `  ${fn}`;
            });
            parts.push(`\n📍 Similar function names found — current signatures:\n${sigLines.join("\n")}`);
            parts.push(`   Did you mean one of these? Check spelling and casing.`);
          } else if (fnNames.length > 0) {
            parts.push(`\n📍 Functions in this file: ${fnNames.slice(0, 10).join(", ")}${fnNames.length > 10 ? ` … (${fnNames.length} total)` : ""}`);
          } else {
            parts.push(`   No functions detected in this file.`);
          }
          bump('replace_function_body', 'fails.notFound');
          return { content: [{ type: "text", text: parts.join("\n") }], found: false };
        }

        const { startRow, endRow } = found;
        const oldSignatureLine  = allLines[startRow] ?? "";
        const ensuredNewline    = newBody.endsWith("\n") ? newBody : newBody + "\n";
        const insertedLines     = ensuredNewline.split(/\r?\n/).length - 1;
        const signatureChanged  = oldSignatureLine.trim() !== (ensuredNewline.split(/\r?\n/)[0] ?? "").trim();

        if (dryRun) {
          bump('replace_function_body', 'dryRuns');
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

        const newLineCount = buffer.getLineCount();
        bump('replace_function_body', 'hits');
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

        let editor;
        try {
          editor = await atom.workspace.open(filePath);
        } catch (openErr) {
          // Clean up the orphan file so create-file can be retried
          try { await fs.promises.unlink(filePath); } catch {}
          throw new Error(`File written but failed to open in editor: ${openErr.message}`);
        }
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
        // If source is open with unsaved edits, write from buffer so the copy reflects live content
        const srcEditor = atom.workspace.getTextEditors()
          .find(e => e.getPath() && path.resolve(e.getPath()) === path.resolve(sourcePath));
        if (srcEditor) {
          await fs.promises.writeFile(destPath, srcEditor.getBuffer().getText(), "utf8");
        } else {
          await fs.promises.copyFile(sourcePath, destPath);
        }
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
          "Use contextLines to return N lines before and after each match (like grep -C) — each match includes a 'before' and 'after' array.",
          "Use occurrence to return only the Nth match in the file (1-based) — useful when you want a specific hit with context without all results.",
          "Returns matchCount and truncation flag if results exceed maxMatches.",
          "Use this as the primary way to locate content in a known file before making edits."
        ].join(" "),
        inputSchema: {
          query:         z.string(),
          filePath:      z.string().optional(),
          regex:         z.boolean().optional(),
          caseSensitive: z.boolean().optional(),
          maxMatches:    z.number().optional(),
          contextLines:  z.number().optional(),
          occurrence:    z.number().optional()
        }
      },
      async ({ query, filePath, regex = false, caseSensitive = false, maxMatches = 200, contextLines = 0, occurrence = 0 }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { query, filePath, regex, caseSensitive, maxMatches, contextLines, occurrence });

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

        const lines      = text.split(/\r?\n/);
        const matches    = [];
        let truncated    = false;
        let globalIndex  = 0;

        outer:
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            globalIndex++;
            if (occurrence > 0 && globalIndex !== occurrence) continue;
            const entry = { line: i + 1, text: lines[i] };
            if (contextLines > 0) {
              entry.before = lines.slice(Math.max(0, i - contextLines), i).map((t, j) => ({ line: Math.max(1, i - contextLines + 1) + j, text: t }));
              entry.after  = lines.slice(i + 1, i + 1 + contextLines).map((t, j) => ({ line: i + 2 + j, text: t }));
            }
            matches.push(entry);
            if (occurrence > 0) { break outer; }
            if (matches.length >= maxMatches) { truncated = true; break outer; }
          }
        }

        if (occurrence > 0 && matches.length === 0)
          throw new Error(`occurrence ${occurrence} not found — only ${globalIndex} match(es) in file.`);

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
          "Use contextLines to return N lines before and after each match (like grep -C) — each match includes a 'before' and 'after' array.",
          "Use occurrence to return only the Nth match across the whole search (1-based) — useful when you want a specific hit with context without all results.",
          "Results are capped at maxMatches (default 200). Returns truncation flag when capped."
        ].join(" "),
        inputSchema: {
          query:        z.string(),
          glob:         z.string().optional(),
          regex:        z.boolean().optional(),
          caseSensitive:z.boolean().optional(),
          maxMatches:   z.number().optional(),
          contextLines: z.number().optional(),
          occurrence:   z.number().optional()
        }
      },
      async ({ query, glob = "", regex = false, caseSensitive = false, maxMatches = 200, contextLines = 0, occurrence = 0 }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { query, glob, regex, caseSensitive, maxMatches, contextLines, occurrence });

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
        let globalIndex = 0;

        outer:
        for (const filePath of allFiles) {
          let text;
          try { text = await readFileOrBuffer(filePath); } catch { continue; }
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i])) {
              globalIndex++;
              if (occurrence > 0 && globalIndex !== occurrence) continue;
              const entry = { filePath, line: i + 1, text: lines[i] };
              if (contextLines > 0) {
                entry.before = lines.slice(Math.max(0, i - contextLines), i).map((t, j) => ({ line: Math.max(1, i - contextLines + 1) + j, text: t }));
                entry.after  = lines.slice(i + 1, i + 1 + contextLines).map((t, j) => ({ line: i + 2 + j, text: t }));
              }
              matches.push(entry);
              if (occurrence > 0) { break outer; }
              if (matches.length >= maxMatches) { truncated = true; break outer; }
            }
          }
        }

        if (occurrence > 0 && matches.length === 0)
          throw new Error(`occurrence ${occurrence} not found — only ${globalIndex} match(es) in project.`);

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
          "Returns lines with their original 1-based line numbers so they can be used directly with other tools.",
          "RANGE MODES: (1) startLine+endLine — explicit inclusive range.",
          "(2) centerLine+radius — window of radius lines above and below centerLine.",
          "HINT MODES (resolve range from content, immune to line drift):",
          "functionHint — returns the complete body of a named function (works on JS, C, and similar brace-delimited languages).",
          "afterHint — starts the range at the line immediately after the first occurrence of a string; combine with endLine or radius to set the end.",
          "betweenHint: { start, end } — range from the line of the start anchor to the line of the end anchor.",
          "lineHint — alias for centerLine when used without startLine/endLine; defaults to radius:10."
        ].join(" "),
        inputSchema: {
          startLine:    z.number().optional(),
          endLine:      z.number().optional(),
          filePath:     z.string().optional(),
          centerLine:   z.number().optional(),
          radius:       z.number().optional(),
          functionHint: z.string().optional(),
          afterHint:    z.string().optional(),
          betweenHint:  z.object({ start: z.string(), end: z.string() }).optional(),
          lineHint:     z.number().optional(),
        }
      },
      async ({ startLine, endLine, filePath, centerLine, radius, functionHint, afterHint, betweenHint, lineHint }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { startLine, endLine, filePath, centerLine, radius, functionHint, afterHint, betweenHint, lineHint });

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
        let resolvedStart, resolvedEnd, hintLabel = "";

        // ── Resolve range from hints ─────────────────────────────────────────
        if (functionHint) {
          // Scan for function signature + brace-count to find body
          const sigRe = new RegExp("(?:^|\\s)" + escapeRegex(functionHint) + "\\s*\\(");
          let fnStart = -1;
          for (let i = 0; i < allLines.length; i++) {
            const l = allLines[i];
            if (sigRe.test(l) && !l.trim().startsWith("//") && !l.trim().startsWith("*")) {
              let hasBrace = false;
              for (let j = i; j < Math.min(i + 6, allLines.length); j++) {
                if (allLines[j].includes("{")) { hasBrace = true; break; }
                if (j > i && allLines[j].includes(";")) break;
              }
              if (hasBrace) { fnStart = i; break; }
            }
          }
          if (fnStart === -1) throw new Error(`functionHint: function "${functionHint}" not found in ${resolvedPath}.`);
          let depth = 0, fnEnd = -1;
          for (let i = fnStart; i < allLines.length; i++) {
            for (const ch of allLines[i]) {
              if (ch === "{") depth++;
              else if (ch === "}") { depth--; if (depth === 0) { fnEnd = i; break; } }
            }
            if (fnEnd !== -1) break;
          }
          if (fnEnd === -1) throw new Error(`functionHint: could not find closing brace for "${functionHint}".`);
          resolvedStart = fnStart + 1; // convert to 1-based
          resolvedEnd   = fnEnd   + 1;
          hintLabel     = ` [functionHint:"${functionHint}" lines ${resolvedStart}–${resolvedEnd}]`;

        } else if (betweenHint) {
          const startIdx = text.indexOf(betweenHint.start);
          if (startIdx === -1) throw new Error(`betweenHint.start "${betweenHint.start}" not found in file.`);
          const endIdx = text.indexOf(betweenHint.end, startIdx + betweenHint.start.length);
          if (endIdx === -1) throw new Error(`betweenHint.end "${betweenHint.end}" not found after start anchor.`);
          resolvedStart = text.substring(0, startIdx).split("\n").length;
          resolvedEnd   = text.substring(0, endIdx).split("\n").length;
          hintLabel     = ` [betweenHint lines ${resolvedStart}–${resolvedEnd}]`;

        } else if (afterHint) {
          const anchorIdx = text.indexOf(afterHint);
          if (anchorIdx === -1) throw new Error(`afterHint "${afterHint}" not found in file.`);
          resolvedStart = text.substring(0, anchorIdx).split("\n").length + 1;
          // endLine or radius pins the end; defaults to +20 if neither provided
          const r = radius !== undefined ? radius : 20;
          resolvedEnd   = endLine !== undefined ? endLine : resolvedStart + r - 1;
          hintLabel     = ` [afterHint "${afterHint.substring(0, 40)}" line ${resolvedStart}]`;

        } else if (centerLine !== undefined || lineHint !== undefined) {
          const center = centerLine !== undefined ? centerLine : lineHint;
          const r      = radius !== undefined ? radius : 10;
          resolvedStart = Math.max(1, center - r);
          resolvedEnd   = Math.min(lineCount, center + r);
          hintLabel     = ` [centerLine:${center} radius:${r}]`;

        } else {
          // Explicit startLine + endLine
          resolvedStart = startLine;
          resolvedEnd   = endLine;
          if (resolvedStart === undefined || resolvedEnd === undefined)
            throw new Error("Must provide startLine+endLine, centerLine, functionHint, afterHint, betweenHint, or lineHint.");
        }

        // ── Validate and slice ───────────────────────────────────────────────
        if (resolvedStart < 1) throw new Error("startLine must be >= 1.");
        if (resolvedEnd < resolvedStart) throw new Error(`endLine (${resolvedEnd}) must be >= startLine (${resolvedStart}).`);
        if (resolvedStart > lineCount) throw new Error(`startLine (${resolvedStart}) exceeds file line count (${lineCount}).`);

        const clampedEnd = Math.min(resolvedEnd, lineCount);
        const slice      = allLines.slice(resolvedStart - 1, clampedEnd).map((t, i) => ({ n: resolvedStart + i, text: t }));

        bump('read_lines', 'hits');
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
          bump('replace_all', 'dryRuns');
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

        bump('replace_all', 'hits');
        return {
          content: [{ type: "text", text: `✅ Replaced all ${matchCount} occurrence${matchCount === 1 ? "" : "s"} of ${JSON.stringify(query)}.` }],
          matchCount, dryRun: false
        };
      }
    );
  }

  } // end EDIT GROUP (part 2)

  // ── get-structural-anchors ────────────────────────────────────────────────
  {
    const curTool = "get-structural-anchors";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Get Structural Anchors",
        description: [
          "List available structural anchors in the active file.",
          "Returns three categories: section banner names (use as sectionHint in insert/delete-block),",
          "preprocessor block macro names (use as preprocBlock), and function names with their",
          "end-row (use as functionEnd in insert).",
          "Call this before using sectionHint/preprocBlock/functionEnd to pick the correct anchor name.",
          "Optional filePath to query a file other than the active editor."
        ].join(" "),
        inputSchema: {
          filePath: z.string().optional()
        }
      },
      async ({ filePath } = {}) => {
        console.log(`CMD: ${curTool}, ARGS:`, { filePath });

        let buffer;
        if (filePath) {
          // Read from disk into a temporary lines array
          let text;
          try { text = await fs.promises.readFile(filePath, "utf8"); }
          catch (e) { return { content: [{ type: "text", text: `❌ Cannot read file: ${e.message}` }] }; }
          // Wrap in a minimal buffer-like object
          const lines = text.split(/\r?\n/);
          buffer = { getLines: () => lines };
        } else {
          const editor = atom.workspace.getActiveTextEditor();
          if (!editor) return { content: [{ type: "text", text: "❌ No active editor and no filePath provided." }] };
          buffer = editor.getBuffer();
        }

        const allLines = buffer.getLines();

        // ── Section banners ───────────────────────────────────────────────────
        const sections = [];
        for (let i = 1; i < allLines.length - 1; i++) {
          const prev = allLines[i - 1].trim();
          const next = allLines[i + 1] ? allLines[i + 1].trim() : "";
          if (/^\/\*\s*[=\-]{6,}/.test(prev) && /^\*\s*[=\-]{6,}/.test(next)) {
            // Middle line — extract meaningful keyword by stripping comment chars
            const keyword = allLines[i].replace(/^\s*\*\s*/, "").trim();
            if (keyword) sections.push({ keyword, line: i + 1 });
          }
        }

        // ── Preprocessor blocks ───────────────────────────────────────────────
        const preprocBlocks = [];
        for (let i = 0; i < allLines.length; i++) {
          const t = allLines[i].trim();
          const m = t.match(/^#\s*(ifdef|ifndef|if\b)\s+(\S+)/);
          if (m) {
            const macro = m[2];
            // Find matching #endif with comment
            for (let j = i + 1; j < allLines.length; j++) {
              const et = allLines[j].trim();
              if (/^#\s*endif/.test(et) && et.toLowerCase().includes(macro.toLowerCase())) {
                preprocBlocks.push({ macro, openLine: i + 1, closeLine: j + 1 });
                break;
              }
            }
          }
        }

        // ── Function ends ─────────────────────────────────────────────────────
        // Use the existing C-function finder via findFunctionInBuffer if available,
        // otherwise do a simple scan for named function signatures.
        const functionEnds = [];
        // Simple scan: lines matching "type name(" that are followed by a body
        const fnRe = /(?:^|\s)(\w+)\s*\([^)]*\)\s*$/;
        for (let i = 0; i < allLines.length; i++) {
          const line = allLines[i];
          // Look for lines that are closing braces at column 0 — these are function ends
          if (line === "}" || line === "};") {
            // Walk back to find the function name
            for (let k = i - 1; k >= Math.max(0, i - 60); k--) {
              const candidate = allLines[k].trim();
              const nm = candidate.match(/^(?:static\s+)?(?:\w+\s+)+(\w+)\s*\([^{;]*\)\s*$/);
              if (nm) {
                functionEnds.push({ name: nm[1], endLine: i + 1 });
                break;
              }
              // Stop at previous closing brace
              if (allLines[k] === "}" || allLines[k] === "};") break;
            }
          }
        }

        // ── Format output ─────────────────────────────────────────────────────
        const parts = [];

        if (sections.length > 0) {
          parts.push("📌 SECTION BANNERS (use as sectionHint:)");
          parts.push(sections.map(s => `  "${s.keyword}"  (line ${s.line})`).join("\n"));
        } else {
          parts.push("📌 SECTION BANNERS — none found (no /* ===...=== * NAME * ===...=== */ pattern)");
        }

        parts.push("");
        if (preprocBlocks.length > 0) {
          parts.push("🔧 PREPROCESSOR BLOCKS (use as preprocBlock:)");
          parts.push(preprocBlocks.map(p =>
            `  "${p.macro}"  (#ifdef line ${p.openLine} → #endif line ${p.closeLine})`
          ).join("\n"));
        } else {
          parts.push("🔧 PREPROCESSOR BLOCKS — none found with named #endif comments");
        }

        parts.push("");
        if (functionEnds.length > 0) {
          parts.push("🔚 FUNCTION ENDS (use as functionEnd:)");
          parts.push(functionEnds.map(f => `  "${f.name}"  (closing brace at line ${f.endLine})`).join("\n"));
        } else {
          parts.push("🔚 FUNCTION ENDS — none detected");
        }

        bump('get_structural_anchors', 'hits');
        return { content: [{ type: "text", text: parts.join("\n") }] };
      }
    );
  }

  // ── sed ──────────────────────────────────────────────────────────────────
  // Native in-buffer sed-style editing. Operates entirely on the live buffer —
  // no subprocess, no disk write required, full undo/redo and decoration support.
  {
    const curTool = "sed";
    const sedFailures = { count: 0 };
    console.log("Registering Tool: " + curTool);
    server.registerTool(curTool,
      {
        title: "Sed",
        description: [
          "sed-style pattern-based editing on the active buffer — no line numbers needed.",
          "Supports the four most useful sed commands:",
          "  s/pattern/replacement/[flags]  — substitute (flags: g=global, i=case-insensitive, N=Nth occurrence only)",
          "  /address/s/pattern/replacement/[flags] — substitute only on lines matching address",
          "  /start/,/end/d — delete all lines from first line matching start through first line matching end (inclusive)",
          "  /address/d — delete all lines matching address",
          "All patterns are JavaScript-compatible regular expressions.",
          "Use functionHint to restrict any command to the body of a named function.",
          "Use dryRun:true to preview changes without writing — always recommended for global substitutions.",
          "On no-match, returns the closest matching area in the buffer so you can correct the pattern.",
          "Returns matchCount and linesDeleted so you can verify the operation."
        ].join(" "),
        inputSchema: {
          expression: z.string(),
          functionHint: z.string().optional(),
          dryRun: z.boolean().optional()
        }
      },
      async ({ expression, functionHint, dryRun = false }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { expression, functionHint, dryRun });

        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer    = editor.getBuffer();
        const allLines  = buffer.getLines();
        const lineCount = allLines.length;

        // Resolve optional function scope
        let scopeStart = 0;
        let scopeEnd   = lineCount - 1;
        let scopeLabel = "";
        if (functionHint) {
          const fn = findFunctionInBuffer(buffer, functionHint);
          if (!fn) {
            sedFailures.count++;
            return { content: [{ type: "text", text: `❌ functionHint: function "${functionHint}" not found.` }], applied: false };
          }
          scopeStart = fn.startRow;
          scopeEnd   = fn.endRow;
          scopeLabel = ` (scoped to "${functionHint}")`;
        }

        // ── Parse expression ────────────────────────────────────────────────
        // Supported forms:
        //   s/pat/rep/flags                      — global substitute
        //   /addr/s/pat/rep/flags                — addressed substitute
        //   /start/,/end/d                       — range delete
        //   /addr/d                              — addressed delete

        // Helper: build a RegExp from a pattern string, report bad expressions
        function makeRe(pat, flags = "") {
          try { return new RegExp(pat, flags); }
          catch (e) { return null; }
        }

        // Helper: find the separator char (first char after command letter)
        // sed allows any delimiter, e.g. s|foo|bar| — detect it
        function parseSed(expr) {
          // Strip leading/trailing whitespace
          expr = expr.trim();

          // Form 1: /addr/,/addr2/d
          const rangeDelete = expr.match(/^\/(.+?)\/,\/(.+?)\/(d)$/);
          if (rangeDelete) return { type: "rangeDelete", startPat: rangeDelete[1], endPat: rangeDelete[2] };

          // Form 2: /addr/d
          const addrDelete = expr.match(/^\/(.+?)\/(d)$/);
          if (addrDelete) return { type: "addrDelete", addrPat: addrDelete[1] };

          // Form 3: /addr/s<sep>pat<sep>rep<sep>flags
          const addrSubst = expr.match(/^\/(.+?)\/s(.)(.+)$/);
          if (addrSubst) {
            const sep  = addrSubst[2];
            const rest = addrSubst[3].split(sep);
            if (rest.length >= 2) {
              return { type: "addrSubst", addrPat: addrSubst[1], pat: rest[0], rep: rest[1], flags: rest[2] || "" };
            }
          }

          // Form 4: s<sep>pat<sep>rep<sep>flags
          const subst = expr.match(/^s(.)(.+)$/);
          if (subst) {
            const sep  = subst[1];
            const rest = subst[2].split(sep);
            if (rest.length >= 2) {
              return { type: "subst", pat: rest[0], rep: rest[1], flags: rest[2] || "" };
            }
          }

          return null;
        }

        const parsed = parseSed(expression);
        if (!parsed) {
          bump('sed', 'fails.badExpression');
          return { content: [{ type: "text", text: [
            `❌ Could not parse sed expression: "${expression}"`,
            `Supported forms:`,
            `  s/pattern/replacement/[flags]`,
            `  /address/s/pattern/replacement/[flags]`,
            `  /start/,/end/d`,
            `  /addr/d`,
          ].join("\n") }], applied: false };
        }

        // ── Execute ─────────────────────────────────────────────────────────
        const workLines  = allLines.slice(); // shallow copy — we'll build result
        let   matchCount = 0;
        let   linesDeleted = 0;
        const changeLog  = []; // { row, before, after } for preview

        if (parsed.type === "subst" || parsed.type === "addrSubst") {
          const { pat, rep, flags } = parsed;
          const addrRe = parsed.addrPat ? makeRe(parsed.addrPat, "i") : null;
          if (parsed.addrPat && !addrRe) {
            bump('sed', 'fails.badExpression');
            return { content: [{ type: "text", text: `❌ Bad address pattern: /${parsed.addrPat}/` }], applied: false };
          }

          // Parse flags: g=global, i=case-insensitive, N=Nth only
          const globalFlag = flags.includes("g");
          const caseFlag   = flags.includes("i") ? "i" : "";
          const nthMatch   = flags.match(/(\d+)/);
          const nthOnly    = nthMatch ? parseInt(nthMatch[1], 10) : 0;

          const reFlags = (globalFlag ? "g" : "") + caseFlag;
          const subRe   = makeRe(pat, reFlags);
          if (!subRe) {
            bump('sed', 'fails.badExpression');
            return { content: [{ type: "text", text: `❌ Bad substitution pattern: /${pat}/` }], applied: false };
          }

          let nthCounter = 0;
          for (let i = scopeStart; i <= scopeEnd; i++) {
            const line = workLines[i];
            if (addrRe && !addrRe.test(line)) continue;

            if (nthOnly) {
              // Replace only the Nth occurrence across all lines
              const newLine = line.replace(subRe, (m, ...args) => {
                nthCounter++;
                if (nthCounter === nthOnly) { matchCount++; return rep; }
                return m;
              });
              if (newLine !== line) { changeLog.push({ row: i, before: line, after: newLine }); workLines[i] = newLine; }
            } else {
              let lineMatches = 0;
              const newLine = line.replace(subRe, (m) => { lineMatches++; matchCount++; return rep; });
              if (lineMatches > 0) { changeLog.push({ row: i, before: line, after: newLine }); workLines[i] = newLine; }
            }
          }

        } else if (parsed.type === "addrDelete") {
          const addrRe = makeRe(parsed.addrPat, "i");
          if (!addrRe) {
            return { content: [{ type: "text", text: `❌ Bad address pattern: /${parsed.addrPat}/` }], applied: false };
          }
          for (let i = scopeEnd; i >= scopeStart; i--) { // reverse so indices stay valid
            if (addrRe.test(workLines[i])) {
              changeLog.push({ row: i, before: workLines[i], after: null });
              workLines.splice(i, 1);
              linesDeleted++;
            }
          }
          matchCount = linesDeleted;

        } else if (parsed.type === "rangeDelete") {
          const startRe = makeRe(parsed.startPat, "i");
          const endRe   = makeRe(parsed.endPat, "i");
          if (!startRe || !endRe) {
            bump('sed', 'fails.badExpression');
            return { content: [{ type: "text", text: `❌ Bad range pattern.` }], applied: false };
          }
          let startRow = -1;
          for (let i = scopeStart; i <= scopeEnd; i++) {
            if (startRow === -1 && startRe.test(workLines[i])) { startRow = i; continue; }
            if (startRow !== -1 && endRe.test(workLines[i])) {
              const count = i - startRow + 1;
              for (let r = i; r >= startRow; r--) changeLog.push({ row: r, before: workLines[r], after: null });
              workLines.splice(startRow, count);
              linesDeleted += count;
              matchCount   += count;
              // Only first range
              break;
            }
          }
          if (startRow !== -1 && linesDeleted === 0) {
            // start found but end not found — report what came after start
            const previewEnd = Math.min(allLines.length - 1, startRow + 10);
            const ctx = allLines.slice(startRow, previewEnd + 1)
              .map((l, i) => `${String(startRow + i + 1).padStart(4)}: ${l}`).join("\n");
            sedFailures.count++;
            bump('sed', 'fails.addressNotFound');
            return { content: [{ type: "text", text: [
              `❌ Range start /${parsed.startPat}/ found at line ${startRow + 1} but end /${parsed.endPat}/ not found after it${scopeLabel}.`,
              `\n📍 Lines after start — pick the correct end pattern:\n${ctx}`
            ].join("\n") }], applied: false };
          }
        }

        // ── No match ────────────────────────────────────────────────────────
        if (matchCount === 0) {
          sedFailures.count++;
          bump('sed', 'fails.noMatch');
          // Fuzzy: find closest area using first token of pattern
          const searchPat = parsed.pat || parsed.addrPat || parsed.startPat || "";
          const words = searchPat.replace(/[.*+?^${}()|[\]\\]/g, " ").trim().split(/\s+/).filter(w => w.length > 2);
          let fuzzyRow = -1, bestScore = 0;
          for (let i = 0; i < allLines.length; i++) {
            const score = words.filter(w => allLines[i].toLowerCase().includes(w.toLowerCase())).length;
            if (score > bestScore) { bestScore = score; fuzzyRow = i; }
          }
          const parts = [`❌ No matches for sed expression: ${expression}${scopeLabel}`];
          if (fuzzyRow >= 0 && bestScore > 0) {
            const r = 4, cs = Math.max(0, fuzzyRow - r), ce = Math.min(allLines.length - 1, fuzzyRow + r);
            const ctx = allLines.slice(cs, ce + 1).map((l, i) => `${String(cs + i + 1).padStart(4)}: ${l}`).join("\n");
            parts.push(`\n📍 Closest area (lines ${cs + 1}–${ce + 1}) — check for case/whitespace differences:\n${ctx}`);
          }
          parts.push(failureSuggestion(sedFailures, "sed") || "");
          return { content: [{ type: "text", text: parts.filter(Boolean).join("\n") }], applied: false, matchCount: 0 };
        }

        // ── Dry run preview ─────────────────────────────────────────────────
        const previewLines = [];
        for (const ch of changeLog.slice(0, 30)) {
          previewLines.push(`${String(ch.row + 1).padStart(4)} - ${ch.before}`);
          if (ch.after !== null) previewLines.push(`${String(ch.row + 1).padStart(4)} + ${ch.after}`);
        }
        if (changeLog.length > 30) previewLines.push(`  … and ${changeLog.length - 30} more changes`);
        const preview = previewLines.join("\n");

        if (dryRun) {
          bump('sed', 'dryRuns');
          return {
            content: [{ type: "text", text: [
              `✅ DRY RUN — ${matchCount} match(es)${linesDeleted ? `, ${linesDeleted} line(s) would be deleted` : ""}${scopeLabel}.`,
              `\nPreview:\n${preview}`,
              `\nReply with the same call without dryRun (or dryRun:false) to commit.`
            ].join("\n") }],
            applied: false, dryRun: true, matchCount, linesDeleted
          };
        }

        // ── Commit ──────────────────────────────────────────────────────────
        const originalText = buffer.getText();
        const newText      = workLines.join("\n") +
          (originalText.endsWith("\n") ? "\n" : "");
        buffer.setTextViaDiff(newText);
        decorateEditedLines(editor, originalText, newText);
        sedFailures.count = 0;
        bump('sed', 'hits');

        dbg(curTool, "SUCCESS", { expression, matchCount, linesDeleted, scopeLabel });
        return {
          content: [{ type: "text", text: [
            `✅ sed: ${matchCount} match(es) applied${linesDeleted ? `, ${linesDeleted} line(s) deleted` : ""}${scopeLabel}.`,
            `\nChanges:\n${preview}`
          ].join("\n") }],
          applied: true, matchCount, linesDeleted
        };
      }
    );
  }

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
          "@@ line counts are auto-corrected — you don't need to count exactly, just get the start line approximately right.",
          "Patch format: standard unified diff with @@ hunk headers and +/- lines. Include 3 context lines (unchanged) around each change for reliable anchoring.",
          "FUZZY RESCUE: if the patch fails, the tool automatically tries to locate each hunk using fuzzy/indent-aware matching and shows a corrected diff preview. Reply with apply-patch({ confirm: true }) to apply the rescued version without resending the patch.",
          "LARGE EDIT WARNING: for edits touching more than ~30% of the file, replace-document or replace-function-body will be cheaper in tokens than a large patch.",
          "dryRun:true validates the patch and reports what would change without writing. Always use dryRun first on untested patches.",
          "Returns linesAdded, linesRemoved, hunksApplied, and a diff of the actual change for verification."
        ].join(" "),
        inputSchema: {
          patch:       z.string().optional(),
          dryRun:      z.boolean().optional(),
          fuzzFactor:  z.number().optional(),
          confirm:     z.boolean().optional()
        }
      },
      async ({ patch = "", dryRun = false, fuzzFactor = 0, confirm = false }) => {
        dbg(curTool, "ARGS", { patchLength: patch.length, dryRun, fuzzFactor, confirm });

        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        const buffer   = editor.getBuffer();
        const bufLines = buffer.getLines();

        // ── confirm:true — apply the last fuzzy-rescued patch ─────────────────
        if (confirm) {
          if (!patchRescueStore.hunks || patchRescueStore.hunks.length === 0) {
            return { content: [{ type: "text", text: "❌ No rescued patch available to confirm. Send the original patch again." }], applied: false };
          }

          const rescued = patchRescueStore.hunks;
          // Apply hunks in reverse row order so earlier edits don't shift later rows
          const sorted  = [...rescued].sort((a, b) => b.startRow - a.startRow);

          for (const rh of sorted) {
            // Delete the lines that match delLines (find their actual rows)
            // and insert addLines in their place
            const delCount = rh.delLines.length;
            const insertAt = rh.startRow;

            // Find the exact rows of the lines to delete by matching trimmed content
            let delStart = -1;
            for (let i = insertAt; i < Math.min(insertAt + rh.matchedRows + 3, bufLines.length); i++) {
              if (rh.delLines.length > 0 && bufLines[i] && bufLines[i].trim() === rh.delLines[0].trim()) {
                delStart = i;
                break;
              }
            }

            if (delStart !== -1 && delCount > 0) {
              buffer.deleteRows(delStart, delStart + delCount - 1);
            }

            if (rh.addLines.length > 0) {
              const insertRow  = delStart !== -1 ? delStart : insertAt;
              const insertText = rh.addLines.join("\n") + "\n";
              buffer.insert([insertRow, 0], insertText);
            }
          }

          patchRescueStore.hunks    = null;
          patchRescueStore.patchKey = null;
          patchFailures.count       = 0;

          const newText   = buffer.getText();
          const diffHunks = diffLines(buffer.getText(), newText);
          dbg(curTool, "CONFIRM APPLY — rescue patch committed", { hunks: rescued.length });

          bump('apply_patch', 'hits');
          return { content: [{ type: "text", text: [
            `✅ Rescued patch applied — ${rescued.length} hunk(s) committed.`,
            rescued.map((rh, i) => `  Hunk ${i + 1}: at line ${rh.startRow + 1}${rh.strategyNote}`).join("\n")
          ].join("\n") }], applied: true, hunksApplied: rescued.length };
        }

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

        // Auto-correct @@ hunk headers — the most common exception cause is
        // wrong line counts in @@ -old,count +new,count @@. Recompute them
        // from the actual hunk body so the LLM doesn't have to count exactly.
        function fixHunkHeaders(patch) {
          return patch.replace(
            /^(@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@[^\n]*)\n([\s\S]*?)(?=\n@@|\n---|\n\+\+\+|$)/gm,
            (match, header, oldStart, newStart, body) => {
              const bodyLines  = body.split("\n");
              // Don't count trailing empty line from split
              const nonEmpty   = bodyLines[bodyLines.length - 1] === "" ? bodyLines.slice(0, -1) : bodyLines;
              const oldCount   = nonEmpty.filter(l => !l.startsWith("+")).length;
              const newCount   = nonEmpty.filter(l => !l.startsWith("-")).length;
              const newHeader  = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
              return `${newHeader}\n${body}`;
            }
          );
        }
        normalizedPatch = fixHunkHeaders(normalizedPatch);

        // Attempt to apply the patch
        let result;
        try {
          result = applyPatch(originalText, normalizedPatch, { fuzzFactor });
        } catch (e) {
          result = false; // treat exception same as context mismatch — fall through to fuzzy rescue
          bump('apply_patch', 'fails.exception');
          dbg(curTool, `exception (treating as mismatch)`, { error: e.message });
        }

        // ── Fuzzy rescue ─────────────────────────────────────────────────────
        // If applyPatch failed, parse each hunk, locate its context lines in the
        // buffer using findAnchor (exact → fuzzy → indent-strip), rebuild a
        // corrected patch with real line numbers and real indentation, then show
        // a diff preview. The caller can apply it with confirm:true.
        if (result === false) {
          patchFailures.count++;
          bump('apply_patch', 'fails.contextMismatch');
          dbg(curTool, `FAIL #${patchFailures.count} (context mismatch — attempting fuzzy rescue)`, { hunks: hunkCount });

          const bufLines = buffer.getLines();

          // Parse hunks: each hunk has context (+/-/ ) lines and a hunk header
          const hunkRe  = /^@@[^@]*@@[^\n]*\n([\s\S]*?)(?=\n@@|\n---|\n\+\+\+|$)/gm;
          const hunks   = [];
          let   hm;
          while ((hm = hunkRe.exec(normalizedPatch)) !== null) {
            const body     = hm[1];
            const bodyLines = body.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));
            // Context lines (space or -) stripped of leading sigil — used as anchor
            const ctxLines = bodyLines
              .filter(l => l.startsWith(" ") || l.startsWith("-"))
              .map(l => l.slice(1));
            // Added lines (+ sigil stripped)
            const addLines = bodyLines
              .filter(l => l.startsWith("+"))
              .map(l => l.slice(1));
            // Lines to remove (- sigil stripped)
            const delLines = bodyLines
              .filter(l => l.startsWith("-"))
              .map(l => l.slice(1));
            hunks.push({ bodyLines, ctxLines, addLines, delLines });
          }

          if (hunks.length === 0) {
            return { content: [{ type: "text", text: [
              `❌ Could not parse any hunks from patch. Failure #${patchFailures.count}.`,
              failureSuggestion(patchFailures, "apply-patch")
            ].filter(Boolean).join("\n") }], applied: false, patchFailures: patchFailures.count };
          }

          // Try to locate each hunk in the buffer via findAnchor
          const rescuedHunks = [];
          const rescueNotes  = [];
          let   searchAfter  = 0;
          let   allLocated   = true;

          for (let hi = 0; hi < hunks.length; hi++) {
            const hunk    = hunks[hi];
            // Use first 4 non-empty context lines as the anchor string
            const anchor  = hunk.ctxLines
              .filter(l => l.trim().length > 2)
              .slice(0, 4)
              .join("\n");

            if (!anchor) {
              rescueNotes.push(`⚠️  Hunk ${hi + 1}: no usable context lines — cannot locate.`);
              allLocated = false;
              continue;
            }

            const hit = findAnchor(buffer, anchor, { afterRow: searchAfter });
            if (!hit) {
              rescueNotes.push(`⚠️  Hunk ${hi + 1}: context not found in buffer (even with fuzzy matching).`);
              allLocated = false;
              continue;
            }

            // Determine the actual indentation from the first matched buffer line
            const bufIndent   = bufLines[hit.row].match(/^(\s*)/)[1];
            const anchorIndent = hunk.ctxLines[0] ? hunk.ctxLines[0].match(/^(\s*)/)[1] : "";
            const indentDelta  = bufIndent.length - anchorIndent.length;
            const reindent     = l => {
              if (!l) return l;
              const lineIndent = l.match(/^(\s*)/)[1];
              const newLen     = Math.max(0, lineIndent.length + indentDelta);
              return " ".repeat(newLen) + l.trimStart();
            };

            const strategyNote = hit.strategy !== "exact"
              ? ` [matched via ${hit.strategy}${indentDelta !== 0 ? `, indent adjusted ${indentDelta > 0 ? "+" : ""}${indentDelta}` : ""}]`
              : (indentDelta !== 0 ? ` [indent adjusted ${indentDelta > 0 ? "+" : ""}${indentDelta}]` : "");

            rescuedHunks.push({
              startRow:    hit.row,
              matchedRows: hunk.ctxLines.length,
              delLines:    hunk.delLines,
              addLines:    hunk.addLines.map(reindent),
              strategyNote
            });
            rescueNotes.push(`✅ Hunk ${hi + 1}: located at line ${hit.row + 1}${strategyNote}`);
            searchAfter = hit.row + hunk.ctxLines.length;
          }

          // Build preview of what the rescue would do
          const previewLines = [];
          for (const rh of rescuedHunks) {
            const r  = 2;
            const cs = Math.max(0, rh.startRow - r);
            const ce = Math.min(bufLines.length - 1, rh.startRow + rh.matchedRows + r);
            bufLines.slice(cs, ce + 1).forEach((l, i) => {
              const abs = cs + i;
              const isDel = rh.delLines.some(dl => bufLines[abs] && bufLines[abs].trim() === dl.trim());
              previewLines.push(`${String(abs + 1).padStart(4)}${isDel ? " -" : "  "} ${l}`);
            });
            rh.addLines.forEach(l => previewLines.push(`     + ${l}`));
            previewLines.push("");
          }

          const parts = [
            allLocated
              ? `⚠️  Patch failed but fuzzy rescue located all ${hunks.length} hunk(s). Preview of corrected changes:`
              : `⚠️  Patch failed. Fuzzy rescue located ${rescuedHunks.length} of ${hunks.length} hunk(s):`,
            ...rescueNotes,
            `\n${previewLines.slice(0, 80).join("\n")}${previewLines.length > 80 ? "\n  … (truncated)" : ""}`,
          ];

          if (allLocated && rescuedHunks.length > 0) {
            // Store rescued hunks for confirm — key by a short hash of the patch
            patchRescueStore.hunks    = rescuedHunks;
            patchRescueStore.patchKey = patch.length + ":" + hunkCount;
            parts.push(`\n✅ Reply with apply-patch({ confirm: true }) to apply the rescued patch, or correct and resend.`);
            return { content: [{ type: "text", text: parts.join("\n") }], applied: false, rescueAvailable: true, patchFailures: patchFailures.count };
          }

          parts.push(failureSuggestion(patchFailures, "apply-patch") || "");
          return { content: [{ type: "text", text: parts.join("\n") }], applied: false, rescueAvailable: false, patchFailures: patchFailures.count };
        }

        // Dry run — report what would change without writing
        if (dryRun) {
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

          bump('apply_patch', 'dryRuns');
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
        bump('apply_patch', 'hits');
        if (largeEditWarning) bump('apply_patch', 'largeEditWarnings');
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

  // ── get-linter-messages ───────────────────────────────────────────────────
  {
    const curTool = "get-linter-messages";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Get Linter Messages",
        description: [
          "Return live linter diagnostics from linter-bundle (errors, warnings, info).",
          "Requires linter-bundle + a linter provider (e.g. linter-eslint) to be installed in Pulsar.",
          "Returns [] gracefully if linter-bundle is not active — no error.",
          "scope: 'file' (default) returns messages for the active editor only;",
          "'project' returns all messages across all open files.",
          "IMPORTANT: Always call save-file before get-linter-messages — linters run on the",
          "saved file, not the buffer. Use this instead of get-diagnostics for JS/TS files.",
          "get-diagnostics remains the right tool for C/C++ files (runs gcc/clang directly).",
          "Post-edit workflow: edit → save-file → get-linter-messages."
        ].join(" "),
        inputSchema: {
          scope: z.enum(["file", "project"]).optional(),
        }
      },
      async ({ scope = "file" } = {}) => {
        console.log(`CMD: ${curTool}, ARGS:`, { scope });

        // Delegate to linter-bundle's own GetLinterMessages execute().
        // instance is a private module-level var in linter-bundle/lib/main.js
        // and is NOT exposed on mainModule — lb.mainModule.instance is always
        // undefined. The public provideMcpTools()[0].execute() is the correct API.
        const lb = atom.packages.getActivePackage("linter-bundle");
        const lbTool = lb?.mainModule?.provideMcpTools?.()
          ?.find(t => t.name === "GetLinterMessages");

        if (!lbTool) {
          bump('get_linter_messages', 'hits');
          return { content: [{ type: "text", text: JSON.stringify({
            linterActive: false, scope, path: null,
            summary: "0 error(s), 0 warning(s), 0 info(s)",
            messageCount: 0, messages: [],
          }, null, 2) }] };
        }

        // lbResult has { mode, path, messages[] } where messages have 0-based rows.
        // We override the mode with our scope param and convert rows to 1-based.
        const editor = atom.workspace.getActiveTextEditor();
        const editorPath = editor?.getPath() || null;

        // Temporarily override the panel viewMode so execute() respects our scope.
        const lbUiPanel = lb?.mainModule?._ui?.panel ?? lb?.mainModule?.ui?.panel;
        const origMode = lbUiPanel?.viewMode;
        if (lbUiPanel && origMode !== scope) lbUiPanel.viewMode = scope;
        const lbResult = lbTool.execute();
        if (lbUiPanel && origMode !== scope) lbUiPanel.viewMode = origMode;

        // Re-format messages with 1-based line numbers (linter-bundle uses 0-based).
        const formatted = (lbResult.messages || []).map(m => {
          const r = m.range;
          return {
            severity:   m.severity,
            excerpt:    m.excerpt,
            linterName: m.linterName,
            file:       m.file || null,
            range:      r ? {
              start: { line: (r.start?.row ?? 0) + 1, col: (r.start?.column ?? 0) + 1 },
              end:   { line: (r.end?.row   ?? 0) + 1, col: (r.end?.column   ?? 0) + 1 },
            } : null,
            url: m.url || null,
          };
        });

        const errors   = formatted.filter(m => m.severity === "error").length;
        const warnings = formatted.filter(m => m.severity === "warning").length;
        const infos    = formatted.filter(m => m.severity === "info").length;

        bump('get_linter_messages', 'hits');
        return {
          content: [{ type: "text", text: JSON.stringify({
            linterActive: true,
            scope,
            path: scope === "file" ? editorPath : null,
            summary: `${errors} error(s), ${warnings} warning(s), ${infos} info(s)`,
            messageCount: formatted.length,
            messages: formatted,
          }, null, 2) }]
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
          "set definitionsOnly:true to return only lines that look like definitions/declarations.",
          "Use contextLines to return N lines before and after each match (like grep -C) — each match includes a 'before' and 'after' array.",
          "Use occurrence to return only the Nth match across the whole search (1-based) — useful when you want a specific hit with context without all results."
        ].join(" "),
        inputSchema: {
          symbol:          z.string(),
          glob:            z.string().optional(),
          definitionsOnly: z.boolean().optional(),
          maxMatches:      z.number().optional(),
          contextLines:    z.number().optional(),
          occurrence:      z.number().optional()
        }
      },
      async ({ symbol, glob = "**/*.{c,cpp,h,hpp}", definitionsOnly = false, maxMatches = 200, contextLines = 0, occurrence = 0 }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { symbol, glob, definitionsOnly, maxMatches, contextLines, occurrence });
        const roots = atom.project.getPaths();
        if (!roots.length) throw new Error("No project root open.");

        const wordRe = new RegExp(`\\b${escapeRegex(symbol)}\\b`);
        const defRe  = new RegExp(`(?:^|[\\s*])${escapeRegex(symbol)}\\s*(?:\\(|=|;)`);

        let allFiles = [];
        for (const root of roots) allFiles = allFiles.concat(await walkDir(root));
        const globRe = globToRegex(glob);
        allFiles = allFiles.filter(f => globRe.test(f.replace(/\\/g, "/")));

        const matches    = [];
        let truncated    = false;
        let globalIndex  = 0;

        outer:
        for (const filePath of allFiles) {
          let text;
          try { text = await readFileOrBuffer(filePath); } catch { continue; }
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (!wordRe.test(lines[i])) continue;
            if (definitionsOnly && !defRe.test(lines[i])) continue;
            globalIndex++;
            if (occurrence > 0 && globalIndex !== occurrence) continue;
            const entry = { filePath, line: i + 1, text: lines[i].trim() };
            if (contextLines > 0) {
              entry.before = lines.slice(Math.max(0, i - contextLines), i).map((t, j) => ({ line: Math.max(1, i - contextLines + 1) + j, text: t }));
              entry.after  = lines.slice(i + 1, i + 1 + contextLines).map((t, j) => ({ line: i + 2 + j, text: t }));
            }
            matches.push(entry);
            if (occurrence > 0) { break outer; }
            if (matches.length >= maxMatches) { truncated = true; break outer; }
          }
        }

        if (occurrence > 0 && matches.length === 0)
          throw new Error(`occurrence ${occurrence} not found — only ${globalIndex} match(es) in project.`);

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
          "Return per-tool edit statistics for this session AND lifetime totals across all sessions.",
          "SESSION: counters since last server restart.",
          "LIFETIME: cumulative totals loaded from disk (edit-stats.json), survives restarts.",
          "Covers str_replace, insert, delete-line-range, replace-function-body,",
          "replace-block, apply-patch, and replace-all.",
          "For each tool: hits, fail reasons (noMatch, whitespace, partialMatch, outOfScope, etc.),",
          "hint usage, dry-run count. str_replace also reports fuzzyWhitespaceCommits and avgOldStrLines.",
          "Pass reset:true to flush session into lifetime, increment sessionCount, and zero session counters.",
          "Lifetime data persists to disk automatically on reset and on server shutdown."
        ].join(" "),
        inputSchema: {
          reset: z.boolean().optional()
        }
      },
      async ({ reset = false }) => {
        dbg(curTool, "ARGS", { reset });

        // Always sync session deltas into lifetime before reading
        syncToLifetime();

        // ── helpers ────────────────────────────────────────────────────────
        function summarise(stats) {
          const sr = stats.str_replace;
          const allHits = sr.hits + stats.insert.hits + stats.delete_line_range.hits
            + stats.replace_function_body.hits + stats.replace_block.hits
            + stats.apply_patch.hits + stats.replace_all.hits;
          const allFails = Object.values(sr.fails).reduce((a, b) => a + b, 0)
            + Object.values(stats.insert.fails).reduce((a, b) => a + b, 0)
            + Object.values(stats.delete_line_range.fails).reduce((a, b) => a + b, 0)
            + stats.replace_function_body.fails.notFound
            + Object.values(stats.replace_block.fails).reduce((a, b) => a + b, 0)
            + Object.values(stats.apply_patch.fails).reduce((a, b) => a + b, 0)
            + stats.replace_all.fails.noMatch;
          const total = allHits + allFails;
          const pct   = total > 0 ? Math.round((allHits / total) * 100) : 100;
          return { allHits, allFails, total, pct,
            summary: `${total} edit ops: ${allHits} hits (${pct}%), ${allFails} fails` };
        }

        function buildReport(stats, label) {
          const sr  = stats.str_replace;
          const avg = sr.hits > 0 ? Math.round((sr._oldStrLenSum / sr.hits) * 10) / 10 : 0;
          const { summary } = summarise(stats);
          return {
            [label + 'Summary']: summary,
            str_replace: {
              hits: sr.hits, failTotal: Object.values(sr.fails).reduce((a,b)=>a+b,0),
              fails: {...sr.fails}, hintsUsed: {...sr.hintsUsed},
              fuzzyWhitespaceCommits: sr.fuzzyWhitespaceCommits,
              dryRuns: sr.dryRuns, avgOldStrLines: avg
            },
            insert:               { hits: stats.insert.hits,
              failTotal: Object.values(stats.insert.fails).reduce((a,b)=>a+b,0),
              fails: {...stats.insert.fails}, hintsUsed: {...(stats.insert.hintsUsed||{})}, dryRuns: stats.insert.dryRuns },
            delete_line_range:    { hits: stats.delete_line_range.hits,
              failTotal: Object.values(stats.delete_line_range.fails).reduce((a,b)=>a+b,0),
              fails: {...stats.delete_line_range.fails}, hintsUsed: {...(stats.delete_line_range.hintsUsed||{})}, dryRuns: stats.delete_line_range.dryRuns },
            replace_function_body:{ hits: stats.replace_function_body.hits,
              failTotal: stats.replace_function_body.fails.notFound,
              fails: {...stats.replace_function_body.fails}, hintsUsed: {...(stats.replace_function_body.hintsUsed||{})}, dryRuns: stats.replace_function_body.dryRuns },
            replace_block:        { hits: stats.replace_block.hits,
              failTotal: Object.values(stats.replace_block.fails).reduce((a,b)=>a+b,0),
              fails: {...stats.replace_block.fails}, hintsUsed: {...(stats.replace_block.hintsUsed||{})}, dryRuns: stats.replace_block.dryRuns },
            apply_patch:          { hits: stats.apply_patch.hits,
              failTotal: Object.values(stats.apply_patch.fails).reduce((a,b)=>a+b,0),
              fails: {...stats.apply_patch.fails},
              largeEditWarnings: stats.apply_patch.largeEditWarnings,
              hintsUsed: {...(stats.apply_patch.hintsUsed||{})}, dryRuns: stats.apply_patch.dryRuns },
            replace_all:          { hits: stats.replace_all.hits,
              failTotal: stats.replace_all.fails.noMatch,
              fails: {...stats.replace_all.fails}, hintsUsed: {...(stats.replace_all.hintsUsed||{})}, dryRuns: stats.replace_all.dryRuns },
            get_structural_anchors: { hits: (stats.get_structural_anchors || {hits:0}).hits,
              hintsUsed: {...((stats.get_structural_anchors||{}).hintsUsed||{})},
              dryRuns: (stats.get_structural_anchors||{dryRuns:0}).dryRuns },
            delete_block:         { hits: (stats.delete_block || {hits:0}).hits,
              failTotal: Object.values((stats.delete_block||{fails:{}}).fails||{}).reduce((a,b)=>a+b,0),
              fails: {...((stats.delete_block||{fails:{}}).fails||{})},
              hintsUsed: {...((stats.delete_block||{hintsUsed:{}}).hintsUsed||{})},
              dryRuns: (stats.delete_block||{dryRuns:0}).dryRuns },
            sed:                  { hits: (stats.sed||{hits:0}).hits,
              failTotal: Object.values((stats.sed||{fails:{}}).fails||{}).reduce((a,b)=>a+b,0),
              fails: {...((stats.sed||{fails:{}}).fails||{})},
              hintsUsed: {...((stats.sed||{hintsUsed:{}}).hintsUsed||{})},
              dryRuns: (stats.sed||{dryRuns:0}).dryRuns },
            read_lines:           { hits: (stats.read_lines||{hits:0}).hits,
              failTotal: Object.values((stats.read_lines||{fails:{}}).fails||{}).reduce((a,b)=>a+b,0),
              fails: {...((stats.read_lines||{fails:{}}).fails||{})},
              hintsUsed: {...((stats.read_lines||{hintsUsed:{}}).hintsUsed||{})},
              dryRuns: (stats.read_lines||{dryRuns:0}).dryRuns },
            get_region:           { hits: (stats.get_region||{hits:0}).hits,
              failTotal: Object.values((stats.get_region||{fails:{}}).fails||{}).reduce((a,b)=>a+b,0),
              fails: {...((stats.get_region||{fails:{}}).fails||{})},
              hintsUsed: {...((stats.get_region||{hintsUsed:{}}).hintsUsed||{})},
              dryRuns: (stats.get_region||{dryRuns:0}).dryRuns },
            get_selection:        { hits: (stats.get_selection||{hits:0}).hits,
              hintsUsed: {...((stats.get_selection||{hintsUsed:{}}).hintsUsed||{})},
              dryRuns: (stats.get_selection||{dryRuns:0}).dryRuns },
            find_text:            { hits: (stats.find_text||{hits:0}).hits,
              failTotal: Object.values((stats.find_text||{fails:{}}).fails||{}).reduce((a,b)=>a+b,0),
              fails: {...((stats.find_text||{fails:{}}).fails||{})},
              dryRuns: (stats.find_text||{dryRuns:0}).dryRuns },
            get_linter_messages:  { hits: (stats.get_linter_messages||{hits:0}).hits,
              dryRuns: (stats.get_linter_messages||{dryRuns:0}).dryRuns },
          };
        }

        const sessionReport  = buildReport(editStats,      'session');
        const lifetimeReport = buildReport(lifetimeStats,  'lifetime');
        lifetimeReport.lifetimeSessionCount = lifetimeStats.sessionCount || 0;

        const report = { session: sessionReport, lifetime: lifetimeReport };

        if (reset) {
          // Bump session count before zeroing
          lifetimeStats.sessionCount = (lifetimeStats.sessionCount || 0) + 1;
          flushLifetimeStats();
          dbg(curTool, `session reset, lifetime sessionCount now ${lifetimeStats.sessionCount}`);

          // Zero session counters and shadow
          const s = editStats.str_replace;
          s.hits = 0; s.dryRuns = 0; s.fuzzyWhitespaceCommits = 0; s._oldStrLenSum = 0;
          Object.keys(s.fails).forEach(k => s.fails[k] = 0);
          Object.keys(s.hintsUsed).forEach(k => s.hintsUsed[k] = 0);
          ["insert","delete_line_range","replace_function_body","replace_block","replace_all"].forEach(tool => {
            editStats[tool].hits = 0;
            editStats[tool].dryRuns = 0;
            Object.keys(editStats[tool].fails).forEach(k => editStats[tool].fails[k] = 0);
          });
          editStats.apply_patch.hits = 0;
          editStats.apply_patch.dryRuns = 0;
          editStats.apply_patch.largeEditWarnings = 0;
          Object.keys(editStats.apply_patch.fails).forEach(k => editStats.apply_patch.fails[k] = 0);
          editStats.get_structural_anchors.hits = 0;

          // Reset shadow so deltas start from 0 again
          _lastSynced = makeEmptyLifetime();
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

// Flush lifetime stats when the Node process exits (full Pulsar quit)
process.on('exit', () => { try { syncToLifetime(); flushLifetimeStats(); } catch {} });

// Also flush on window unload — fires on Pulsar window reload/restart where
// process.on('exit') does NOT fire (renderer restarts, Node process stays alive).
// Using synchronous writeFileSync here because async promises don't resolve
// during unload. Wrapped in try/catch so a stats flush never blocks shutdown.
window.addEventListener('beforeunload', () => {
  try {
    syncToLifetime();
    if (STATS_PATH) require('fs').writeFileSync(
      STATS_PATH, JSON.stringify(lifetimeStats, null, 2), 'utf8'
    );
  } catch {}
});

// Also flush on a 60-second timer so stats survive crashes mid-session.
setInterval(() => {
  try { syncToLifetime(); flushLifetimeStats(); } catch {}
}, 60_000);

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
  syncToLifetime();
  const sr  = editStats.str_replace;
  const avg = sr.hits > 0 ? Math.round((sr._oldStrLenSum / sr.hits) * 10) / 10 : 0;
  const allHits  = sr.hits + editStats.insert.hits + editStats.delete_line_range.hits
    + editStats.replace_function_body.hits + editStats.replace_block.hits
    + editStats.apply_patch.hits + editStats.replace_all.hits;
  const allFails = Object.values(sr.fails).reduce((a,b)=>a+b,0)
    + Object.values(editStats.insert.fails).reduce((a,b)=>a+b,0)
    + Object.values(editStats.delete_line_range.fails).reduce((a,b)=>a+b,0)
    + editStats.replace_function_body.fails.notFound
    + Object.values(editStats.replace_block.fails).reduce((a,b)=>a+b,0)
    + Object.values(editStats.apply_patch.fails).reduce((a,b)=>a+b,0)
    + editStats.replace_all.fails.noMatch;
  const total = allHits + allFails;
  const pct   = total > 0 ? Math.round((allHits / total) * 100) : 100;

  // lifetime summary
  const lsr = lifetimeStats.str_replace;
  const lHits  = lsr.hits + lifetimeStats.insert.hits + lifetimeStats.delete_line_range.hits
    + lifetimeStats.replace_function_body.hits + lifetimeStats.replace_block.hits
    + lifetimeStats.apply_patch.hits + lifetimeStats.replace_all.hits;
  const lFails = Object.values(lsr.fails).reduce((a,b)=>a+b,0)
    + Object.values(lifetimeStats.insert.fails).reduce((a,b)=>a+b,0)
    + Object.values(lifetimeStats.delete_line_range.fails).reduce((a,b)=>a+b,0)
    + lifetimeStats.replace_function_body.fails.notFound
    + Object.values(lifetimeStats.replace_block.fails).reduce((a,b)=>a+b,0)
    + Object.values(lifetimeStats.apply_patch.fails).reduce((a,b)=>a+b,0)
    + lifetimeStats.replace_all.fails.noMatch;
  const lTotal = lHits + lFails;
  const lPct   = lTotal > 0 ? Math.round((lHits / lTotal) * 100) : 100;

  const safeTool = (s, tool) => (s[tool] || { hits:0, fails:{}, hintsUsed:{}, dryRuns:0 });

  return {
    session: {
      sessionSummary: `${total} edit ops: ${allHits} hits (${pct}%), ${allFails} fails`,
      str_replace:           { hits: sr.hits, failTotal: Object.values(sr.fails).reduce((a,b)=>a+b,0), fails: {...sr.fails}, hintsUsed: {...sr.hintsUsed}, fuzzyWhitespaceCommits: sr.fuzzyWhitespaceCommits, dryRuns: sr.dryRuns, avgOldStrLines: avg },
      insert:                { hits: editStats.insert.hits, failTotal: Object.values(editStats.insert.fails).reduce((a,b)=>a+b,0), fails: {...editStats.insert.fails}, hintsUsed: {...editStats.insert.hintsUsed}, dryRuns: editStats.insert.dryRuns },
      delete_line_range:     { hits: editStats.delete_line_range.hits, failTotal: Object.values(editStats.delete_line_range.fails).reduce((a,b)=>a+b,0), fails: {...editStats.delete_line_range.fails}, hintsUsed: {...editStats.delete_line_range.hintsUsed}, dryRuns: editStats.delete_line_range.dryRuns },
      replace_function_body: { hits: editStats.replace_function_body.hits, failTotal: editStats.replace_function_body.fails.notFound, fails: {...editStats.replace_function_body.fails}, hintsUsed: {...editStats.replace_function_body.hintsUsed}, dryRuns: editStats.replace_function_body.dryRuns },
      replace_block:         { hits: editStats.replace_block.hits, failTotal: Object.values(editStats.replace_block.fails).reduce((a,b)=>a+b,0), fails: {...editStats.replace_block.fails}, hintsUsed: {...editStats.replace_block.hintsUsed}, dryRuns: editStats.replace_block.dryRuns },
      delete_block:          { hits: editStats.delete_block.hits, failTotal: Object.values(editStats.delete_block.fails).reduce((a,b)=>a+b,0), fails: {...editStats.delete_block.fails}, hintsUsed: {...editStats.delete_block.hintsUsed}, dryRuns: editStats.delete_block.dryRuns },
      apply_patch:           { hits: editStats.apply_patch.hits, failTotal: Object.values(editStats.apply_patch.fails).reduce((a,b)=>a+b,0), fails: {...editStats.apply_patch.fails}, largeEditWarnings: editStats.apply_patch.largeEditWarnings, hintsUsed: {...editStats.apply_patch.hintsUsed}, dryRuns: editStats.apply_patch.dryRuns },
      replace_all:           { hits: editStats.replace_all.hits, failTotal: editStats.replace_all.fails.noMatch, fails: {...editStats.replace_all.fails}, hintsUsed: {...editStats.replace_all.hintsUsed}, dryRuns: editStats.replace_all.dryRuns },
      get_structural_anchors:{ hits: editStats.get_structural_anchors.hits, hintsUsed: {...editStats.get_structural_anchors.hintsUsed}, dryRuns: editStats.get_structural_anchors.dryRuns },
      sed:                   { hits: editStats.sed.hits, failTotal: Object.values(editStats.sed.fails).reduce((a,b)=>a+b,0), fails: {...editStats.sed.fails}, hintsUsed: {...editStats.sed.hintsUsed}, dryRuns: editStats.sed.dryRuns },
      read_lines:            { hits: editStats.read_lines.hits, failTotal: Object.values(editStats.read_lines.fails).reduce((a,b)=>a+b,0), fails: {...editStats.read_lines.fails}, hintsUsed: {...editStats.read_lines.hintsUsed}, dryRuns: editStats.read_lines.dryRuns },
      get_region:            { hits: editStats.get_region.hits, failTotal: Object.values(editStats.get_region.fails).reduce((a,b)=>a+b,0), fails: {...editStats.get_region.fails}, hintsUsed: {...editStats.get_region.hintsUsed}, dryRuns: editStats.get_region.dryRuns },
      get_selection:         { hits: editStats.get_selection.hits, hintsUsed: {...editStats.get_selection.hintsUsed}, dryRuns: editStats.get_selection.dryRuns },
      get_linter_messages:     { hits: editStats.get_linter_messages.hits, dryRuns: editStats.get_linter_messages.dryRuns },
      find_text:               { hits: editStats.find_text.hits, failTotal: Object.values(editStats.find_text.fails).reduce((a,b)=>a+b,0), fails: {...editStats.find_text.fails}, dryRuns: editStats.find_text.dryRuns },
    },
    lifetime: {
      lifetimeSummary: `${lTotal} edit ops across ${lifetimeStats.sessionCount || 0} sessions: ${lHits} hits (${lPct}%), ${lFails} fails`,
      lifetimeSessionCount: lifetimeStats.sessionCount || 0,
      str_replace:           { hits: lsr.hits, failTotal: Object.values(lsr.fails).reduce((a,b)=>a+b,0), fails: {...lsr.fails}, hintsUsed: {...lsr.hintsUsed}, fuzzyWhitespaceCommits: lsr.fuzzyWhitespaceCommits, dryRuns: lsr.dryRuns },
      insert:                { hits: lifetimeStats.insert.hits, failTotal: Object.values(lifetimeStats.insert.fails).reduce((a,b)=>a+b,0), fails: {...lifetimeStats.insert.fails}, hintsUsed: {...lifetimeStats.insert.hintsUsed}, dryRuns: lifetimeStats.insert.dryRuns },
      delete_line_range:     { hits: lifetimeStats.delete_line_range.hits, failTotal: Object.values(lifetimeStats.delete_line_range.fails).reduce((a,b)=>a+b,0), fails: {...lifetimeStats.delete_line_range.fails}, hintsUsed: {...lifetimeStats.delete_line_range.hintsUsed}, dryRuns: lifetimeStats.delete_line_range.dryRuns },
      replace_function_body: { hits: lifetimeStats.replace_function_body.hits, failTotal: lifetimeStats.replace_function_body.fails.notFound, fails: {...lifetimeStats.replace_function_body.fails}, hintsUsed: {...(lifetimeStats.replace_function_body.hintsUsed||{})}, dryRuns: lifetimeStats.replace_function_body.dryRuns },
      replace_block:         { hits: lifetimeStats.replace_block.hits, failTotal: Object.values(lifetimeStats.replace_block.fails).reduce((a,b)=>a+b,0), fails: {...lifetimeStats.replace_block.fails}, hintsUsed: {...(lifetimeStats.replace_block.hintsUsed||{})}, dryRuns: lifetimeStats.replace_block.dryRuns },
      delete_block:          { hits: safeTool(lifetimeStats,'delete_block').hits, failTotal: Object.values(safeTool(lifetimeStats,'delete_block').fails).reduce((a,b)=>a+b,0), fails: {...safeTool(lifetimeStats,'delete_block').fails}, hintsUsed: {...safeTool(lifetimeStats,'delete_block').hintsUsed}, dryRuns: safeTool(lifetimeStats,'delete_block').dryRuns },
      apply_patch:           { hits: lifetimeStats.apply_patch.hits, failTotal: Object.values(lifetimeStats.apply_patch.fails).reduce((a,b)=>a+b,0), fails: {...lifetimeStats.apply_patch.fails}, largeEditWarnings: lifetimeStats.apply_patch.largeEditWarnings, hintsUsed: {...(lifetimeStats.apply_patch.hintsUsed||{})}, dryRuns: lifetimeStats.apply_patch.dryRuns },
      replace_all:           { hits: lifetimeStats.replace_all.hits, failTotal: lifetimeStats.replace_all.fails.noMatch, fails: {...lifetimeStats.replace_all.fails}, hintsUsed: {...(lifetimeStats.replace_all.hintsUsed||{})}, dryRuns: lifetimeStats.replace_all.dryRuns },
      get_structural_anchors:{ hits: (lifetimeStats.get_structural_anchors||{hits:0}).hits, hintsUsed: {...((lifetimeStats.get_structural_anchors||{}).hintsUsed||{})}, dryRuns: (lifetimeStats.get_structural_anchors||{dryRuns:0}).dryRuns },
      sed:                   { hits: safeTool(lifetimeStats,'sed').hits, failTotal: Object.values(safeTool(lifetimeStats,'sed').fails).reduce((a,b)=>a+b,0), fails: {...safeTool(lifetimeStats,'sed').fails}, hintsUsed: {...safeTool(lifetimeStats,'sed').hintsUsed}, dryRuns: safeTool(lifetimeStats,'sed').dryRuns },
      read_lines:            { hits: safeTool(lifetimeStats,'read_lines').hits, failTotal: Object.values(safeTool(lifetimeStats,'read_lines').fails).reduce((a,b)=>a+b,0), fails: {...safeTool(lifetimeStats,'read_lines').fails}, hintsUsed: {...safeTool(lifetimeStats,'read_lines').hintsUsed}, dryRuns: safeTool(lifetimeStats,'read_lines').dryRuns },
      get_region:            { hits: safeTool(lifetimeStats,'get_region').hits, failTotal: Object.values(safeTool(lifetimeStats,'get_region').fails).reduce((a,b)=>a+b,0), fails: {...safeTool(lifetimeStats,'get_region').fails}, hintsUsed: {...safeTool(lifetimeStats,'get_region').hintsUsed}, dryRuns: safeTool(lifetimeStats,'get_region').dryRuns },
      get_selection:         { hits: safeTool(lifetimeStats,'get_selection').hits, hintsUsed: {...safeTool(lifetimeStats,'get_selection').hintsUsed}, dryRuns: safeTool(lifetimeStats,'get_selection').dryRuns },
      get_linter_messages:     { hits: safeTool(lifetimeStats,'get_linter_messages').hits, dryRuns: safeTool(lifetimeStats,'get_linter_messages').dryRuns },
      find_text:               { hits: safeTool(lifetimeStats,'find_text').hits, failTotal: Object.values(safeTool(lifetimeStats,'find_text').fails).reduce((a,b)=>a+b,0), fails: {...safeTool(lifetimeStats,'find_text').fails}, dryRuns: safeTool(lifetimeStats,'find_text').dryRuns },
    },
  };
}

export function resetEditStats() {
  // Sync and flush before zeroing so nothing is lost
  syncToLifetime();
  lifetimeStats.sessionCount = (lifetimeStats.sessionCount || 0) + 1;
  flushLifetimeStats();

  const s = editStats.str_replace;
  s.hits = 0; s.dryRuns = 0; s.fuzzyWhitespaceCommits = 0; s._oldStrLenSum = 0;
  Object.keys(s.fails).forEach(k => s.fails[k] = 0);
  Object.keys(s.hintsUsed).forEach(k => s.hintsUsed[k] = 0);
  ["insert", "delete_line_range", "replace_function_body", "replace_block", "replace_all"].forEach(tool => {
    editStats[tool].hits = 0;
    editStats[tool].dryRuns = 0;
    Object.keys(editStats[tool].fails).forEach(k => editStats[tool].fails[k] = 0);
    if (editStats[tool].hintsUsed) Object.keys(editStats[tool].hintsUsed).forEach(k => editStats[tool].hintsUsed[k] = 0);
  });
  editStats.apply_patch.hits = 0;
  editStats.apply_patch.dryRuns = 0;
  editStats.apply_patch.largeEditWarnings = 0;
  Object.keys(editStats.apply_patch.fails).forEach(k => editStats.apply_patch.fails[k] = 0);
  if (editStats.apply_patch.hintsUsed) Object.keys(editStats.apply_patch.hintsUsed).forEach(k => editStats.apply_patch.hintsUsed[k] = 0);
  ["get_structural_anchors", "sed", "read_lines", "get_region", "get_selection", "get_linter_messages", "find_text"].forEach(tool => {
    if (!editStats[tool]) return;
    editStats[tool].hits = 0;
    if (editStats[tool].dryRuns !== undefined) editStats[tool].dryRuns = 0;
    if (editStats[tool].fails)     Object.keys(editStats[tool].fails).forEach(k => editStats[tool].fails[k] = 0);
    if (editStats[tool].hintsUsed) Object.keys(editStats[tool].hintsUsed).forEach(k => editStats[tool].hintsUsed[k] = 0);
  });
  _lastSynced = makeEmptyLifetime();
}
