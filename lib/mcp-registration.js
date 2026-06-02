'use babel';
import fs from "fs";
import path from "path";
import { z } from "zod";
import { applyPatch, diffLines } from "diff";
import { exec as _exec, spawn as _spawn } from "child_process";
import { CompositeDisposable, Disposable } from "atom";
const { checkLines: styleCheckLines, formatViolations: styleFormatViolations, isKernelFile } = require('./style-checker');

// ---------------------------------------------------------------------------
// Platform helper: pick the right shell for run-command
// ---------------------------------------------------------------------------
const IS_WINDOWS = process.platform === "win32";
function getShell() {
  if (IS_WINDOWS) return { shell: "powershell.exe", flag: "-Command" };
  return { shell: "/bin/sh", flag: "-c" };
}

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
const deleteFailures      = { count: 0 };  // delete-line-range (consecutive, for tool-switch hint)
const deleteBlockFailures = { count: 0 };  // delete-block      (consecutive, for tool-switch hint)

// Regex and helper for "is this a source code file" checks — used throughout
// to gate code-specific tool hints. Centralised here so the extension list only
// needs to be updated in one place.
const CODE_FILE_RE = /\.(js|ts|jsx|tsx|c|cpp|h|cs|py|java|go|rs)$/i;
function isCodeFilePath(p) { return CODE_FILE_RE.test(p || ""); }

/* Returns true for Ghidra-decompiled C files — detected by filename pattern
 * (.bin.c / .xbe.c) or high density of FUN_/DAT_/PTR_ identifiers.
 * Used to gate style checks off for decompiled pseudocode. */
const GHIDRA_NAME_RE = /\.(bin|xbe|exe|dll|elf)\.[ch]$/i;
const GHIDRA_IDENT_RE = /\b(FUN_|DAT_|PTR_|LAB_|SUB_)[0-9a-fA-F]{4,}/;
function isGhidraFile(filePath, text) {
  if (!filePath) return false;
  if (GHIDRA_NAME_RE.test(filePath)) return true;
  if (!text) return false;
  /* Count FUN_/DAT_/PTR_ identifiers — if density > 1 per 20 lines it's decompiled output */
  const lines = text.split('\n').length || 1;
  const matches = (text.match(new RegExp(GHIDRA_IDENT_RE.source, 'g')) || []).length;
  return (matches / lines) > 0.05;
}

// Sum all fail-counter values in a tool's .fails object. Handles undefined/null
// gracefully so callers don't need inline ||{} guards.
const sumFails = obj => Object.values(obj || {}).reduce((a, b) => a + b, 0);

// Stores the last fuzzy-rescued patch hunks so confirm:true can apply them
// without re-parsing. Cleared on successful apply or on a new patch attempt.
const patchRescueStore = { hunks: null, patchKey: null };

// Stats pause flag — when true, bump() is a no-op so tool failures during
// Ghidra/non-standard work don't pollute hit-rate stats.
let statsPaused = false;

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
      ambiguous:       0,   // old_str matched >1 location, no scope hint — ambiguity guard blocked
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
      endOfFile:       0,
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
  grep_file: {
    hits: 0,
    fails: { noMatch: 0 },
    hintsUsed: { occurrence: 0, contextLines: 0 },
  },
  grep_project: {
    hits: 0,
    fails: { noMatch: 0 },
    hintsUsed: { occurrence: 0, contextLines: 0 },
  },
  search_symbol: {
    hits: 0,
    fails: { noMatch: 0 },
    hintsUsed: { occurrence: 0, contextLines: 0 },
  },
  replace_document: {
    hits: 0,
  },
  replace_across_files: {
    hits: 0,
    fails: { skipped: 0 },
    dryRuns: 0,
  },
  run_command: {
    hits: 0,
    fails: { spawnError: 0 },
    misses: { exitNonZero: 0, timedOut: 0 },
  },
  get_repo_map: {
    hits: 0,
    fails: { noProject: 0 },
  },
  close_file:      { hits: 0, fails: { notFound: 0 } },
  goto_focus:      { hits: 0, fails: { noEditor: 0 } },
  get_project_paths: { hits: 0, fails: {} },
  add_project_path:  { hits: 0, fails: { notFound: 0 } },
  ghidra_list_functions: { hits: 0, fails: { noEditor: 0 } },
  ghidra_search_functions: { hits: 0, fails: { noEditor: 0, noMatch: 0 } },
  ghidra_get_function_body: { hits: 0, fails: { noEditor: 0, notFound: 0 } },
  ghidra_get_xrefs: { hits: 0, fails: { noEditor: 0, noMatch: 0 } },
  ghidra_add_comment: { hits: 0, fails: { noEditor: 0, notFound: 0 } },
  ghidra_get_function_list_with_comments: { hits: 0, fails: { noEditor: 0 } },
};

// ---------------------------------------------------------------------------
// Style statistics — per-violation-type counts for Linux kernel style checks.
// Tracks violations introduced by the LLM in .c / .h files only.
// Same bump() / mergeInto() / session+lifetime pattern as editStats.
// ---------------------------------------------------------------------------
const styleStats = {
  // ERROR
  trailing_whitespace:      { introduced: 0 },
  wrong_indentation:        { introduced: 0 },
  dos_line_endings:         { introduced: 0 },
  missing_newline_eof:      { introduced: 0 },
  trailing_blank_lines:     { introduced: 0 },
  // WARNING
  line_too_long:            { introduced: 0 },
  keyword_spacing:          { introduced: 0 },
  space_before_semicolon:   { introduced: 0 },
  paren_spacing:            { introduced: 0 },
  comma_spacing:            { introduced: 0 },
  operator_spacing:         { introduced: 0 },
  pointer_spacing:          { introduced: 0 },
  open_brace_control:       { introduced: 0 },
  open_brace_function:      { introduced: 0 },
  else_brace_placement:     { introduced: 0 },
  space_before_open_brace:  { introduced: 0 },
  brace_placement:          { introduced: 0 },  // legacy — kept for existing lifetime data
  // CHECK
  single_line_comment:      { introduced: 0 },
  consecutive_blanks:       { introduced: 0 },
  singleline_if:            { introduced: 0 },
  // score tracking
  _cleanEdits:      0,  // C/H edits with zero violations
  _totalCHEdits:    0,  // total C/H edit ops checked
  _totalViolations:     0,  // cumulative violation count
  _checkpatchRuns:      0,  // standalone checkpatch tool invocations
  _checkpatchViolations: 0, // violations found by standalone checkpatch
};

// Lifetime style stats — same shape, persisted alongside lifetimeStats
let lifetimeStyleStats = {
  // ERROR
  trailing_whitespace:      { introduced: 0 },
  wrong_indentation:        { introduced: 0 },
  dos_line_endings:         { introduced: 0 },
  missing_newline_eof:      { introduced: 0 },
  trailing_blank_lines:     { introduced: 0 },
  // WARNING
  line_too_long:            { introduced: 0 },
  keyword_spacing:          { introduced: 0 },
  space_before_semicolon:   { introduced: 0 },
  paren_spacing:            { introduced: 0 },
  comma_spacing:            { introduced: 0 },
  operator_spacing:         { introduced: 0 },
  pointer_spacing:          { introduced: 0 },
  open_brace_control:       { introduced: 0 },
  open_brace_function:      { introduced: 0 },
  else_brace_placement:     { introduced: 0 },
  space_before_open_brace:  { introduced: 0 },
  brace_placement:          { introduced: 0 },  // legacy
  // CHECK
  single_line_comment:      { introduced: 0 },
  consecutive_blanks:       { introduced: 0 },
  singleline_if:            { introduced: 0 },
  _cleanEdits:      0,
  _totalCHEdits:    0,
  _totalViolations:     0,
  _checkpatchRuns:      0,
  _checkpatchViolations: 0,
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
      // Disk (src) is authoritative — copy all keys from disk into target.
      // Keys in target but missing from disk keep their default (0).
      // Keys in disk but missing from target are added — forward-compatible with
      // schema additions written by a newer version that this load doesn't know about.
      for (const k of Object.keys(src)) {
        if (k === 'sessionCount') continue; // handled below
        if (typeof src[k] === 'object' && src[k] !== null) {
          if (typeof target[k] !== 'object' || target[k] === null) target[k] = {};
          mergeInto(target[k], src[k]);
        } else {
          target[k] = src[k];
        }
      }
      if (src.sessionCount !== undefined) target.sessionCount = src.sessionCount;
    }
    mergeInto(lifetimeStats, disk);
    if (disk.styleStats && typeof disk.styleStats === 'object') {
      mergeInto(lifetimeStyleStats, disk.styleStats);
    }
  } catch { /* file missing or corrupt — start fresh */ }
})();

// Flush lifetime stats to disk (async, fire-and-forget)
function flushLifetimeStats() {
  if (!STATS_PATH) return;
  fs.promises.writeFile(STATS_PATH, JSON.stringify(makeStatsDiskData(), null, 2), 'utf8')
    .catch(e => console.error('[edit-stats] flush failed:', e.message));
}

// Build the object written to disk — includes both lifetime edit stats and style stats.
function makeStatsDiskData() {
  return { ...lifetimeStats, styleStats: lifetimeStyleStats };
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
// lifetimeStats is synced periodically: every 5s via setInterval, on every
// get-edit-stats call, on flush events (beforeunload/deactivate), and on
// process.exit/SIGTERM/SIGHUP. It is NOT synced on every direct editStats write.
// For future cleanliness, new instrumentation should use bump() directly.
function bump(toolKey, subPath, n = 1) {
  if (statsPaused) return;
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
  lint:            z.boolean().optional(),  // append scoped linter snapshot to response
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


// ---------------------------------------------------------------------------
// Smart contextual suggestion engine — fires on EVERY failure, not just after 3.
// Also used to append nudges on success when no hints were used.
// ctx = { toolName, counter, noHintsUsed, fileLines, oldStr, isCodeFile }
// ---------------------------------------------------------------------------
function smartSuggestion(ctx) {
  const { toolName, counter, noHintsUsed, fileLines, oldStr, isCodeFile } = ctx;
  const parts = [];
  const n = counter ? counter.count : 0;

  // ── Hint nudge: always on failure when no hints were used ─────────────────
  if (noHintsUsed) {
    if (toolName === "str_replace" || toolName === "replace-block") {
      parts.push("💡 NO HINTS USED — retry with one of:");
      parts.push("   functionHint:\"name\"  → scope search to a named function body (immune to line drift)");
      parts.push("   afterHint:\"string\"   → start search after a unique anchor string");
      parts.push("   betweenHint:{start,end} → restrict to region between two anchors");
      parts.push("   occurrence:N          → target the Nth match if the pattern repeats");
      parts.push("   fuzzyWhitespace:true  → retry ignoring indentation differences");
    } else if (toolName === "insert") {
      parts.push("💡 NO HINTS USED — retry with:");
      parts.push("   afterContent/beforeContent → insert relative to a content anchor (immune to line drift)");
      parts.push("   functionEnd:\"name\"         → insert after a named function's closing brace");
      parts.push("   functionHint:\"name\"        → scope anchor search to a function body");
    } else if (toolName === "delete-line-range") {
      parts.push("💡 NO HINTS USED — line numbers shift after every edit. Prefer content-stable alternatives:");
      parts.push("   functionHint:\"name\"    → delete an entire named function");
      parts.push("   betweenHint:{start,end} → delete by anchor strings instead of line numbers");
      parts.push("   → Or use delete-block with startContent/endContent anchors");
    } else if (toolName === "delete-block") {
      parts.push("💡 NO HINTS USED — retry with:");
      parts.push("   startContent/endContent → delete lines between two unique anchor strings");
      parts.push("   sectionHint:\"name\"      → delete a named /* ===...=== */ banner block");
      parts.push("   preprocBlock:\"MACRO\"    → delete a #ifdef...#endif pair by macro name");
      parts.push("   functionHint:\"name\"     → scope the anchor search to a function body");
      parts.push("   → Call get-structural-anchors to list available sectionHint/preprocBlock names");
    }
  }

  // ── Code-aware tool suggestions ───────────────────────────────────────────
  if (isCodeFile && oldStr) {
    const str = oldStr.trim();
    // Looks like a whole function (has signature + opening brace + body)
    const looksLikeFunction =
      /^\s*(async\s+)?(\w+\s+)*\w+\s*\(/.test(str) &&
      str.includes("{") && str.includes("}") &&
      str.split("\n").length > 3;
    if (looksLikeFunction && toolName === "str_replace") {
      parts.push("🔧 old_str looks like a complete function — use replace-function-body instead:");
      parts.push("   replace-function-body name:\"functionName\" newBody:\"...\" is atomic, immune to line drift,");
      parts.push("   and preserves undo history as a single operation.");
    }
    // Looks like a block (has anchor + braces but not a full function sig)
    const looksLikeBlock = str.includes("{") && str.includes("}") && str.split("\n").length > 5 && !looksLikeFunction;
    if (looksLikeBlock && toolName === "str_replace") {
      parts.push("🔧 old_str looks like a brace-delimited block — consider replace-block:");
      parts.push("   replace-block anchor:\"first line of block\" newBody:\"...\" finds the block by content,");
      parts.push("   not line numbers, so it survives any upstream edits.");
    }
  }

  // ── Consecutive failure escalation ────────────────────────────────────────
  if (n >= 2) {
    const alts = {
      "str_replace":       "replace-function-body (whole function), replace-block (brace block), or replace-document (full rewrite)",
      "insert":            "afterContent/beforeContent anchor, functionEnd:\"name\", or get-structural-anchors to list available anchors",
      "delete-line-range": "delete-block with startContent/endContent or sectionHint/preprocBlock — call get-structural-anchors to list available names",
      "delete-block":      "delete-line-range with betweenHint:{start,end} for anchor-based deletion, or str_replace to remove specific content",
      "replace-block":     "replace-function-body if replacing a named function, or str_replace for smaller targeted edits",
      "apply-patch":       "str_replace for targeted edits or replace-function-body for whole-function rewrites",
      "sed":               "str_replace for single targeted edits or replace-all for global pattern replacement"
    };
    const alt = alts[toolName] || "a different editing tool";
    parts.push(`\n🔁 ${n} consecutive failures on ${toolName} — strongly consider switching to: ${alt}`);
  }

  // ── Large file nudge on first failure ────────────────────────────────────
  if (n === 1 && fileLines > 500 && noHintsUsed) {
    parts.push(`\n📏 File is ${fileLines} lines — on large files, hint-scoped edits are far more reliable than bare string matching.`);
  }

  return parts.length ? "\n" + parts.join("\n") : "";
}

// Soft nudge appended to SUCCESS responses when no hints used on a large file.
// Returns empty string on small files or when hints were already used.
function successNudge(ctx) {
  const { toolName, noHintsUsed, fileLines, oldStr, isCodeFile } = ctx;
  if (!noHintsUsed || fileLines < 300) return "";
  const parts = [];
  parts.push(`\n⚡ Hint: no scoping hints used on a ${fileLines}-line file.`);
  if (isCodeFile && oldStr) {
    const str = oldStr.trim();
    const looksLikeFunction =
      /^\s*(async\s+)?(\w+\s+)*\w+\s*\(/.test(str) &&
      str.includes("{") && str.includes("}") && str.split("\n").length > 3;
    if (looksLikeFunction && toolName === "str_replace") {
      parts.push("   Next time use replace-function-body for whole-function rewrites — it's atomic and drift-immune.");
      return parts.join("\n");
    }
  }
  parts.push(`   Next time add functionHint, afterHint, or betweenHint to make the match drift-immune.`);
  return parts.join("\n");
}
// ---------------------------------------------------------------------------
// bumpStyle(type, n) — increment a styleStats violation counter (session + lifetime).
// applyStyleCheck(newStr, filePath) — run style checker on a snippet (isWholeFile=false), return inline suffix string.
// ---------------------------------------------------------------------------
function bumpStyle(type, n = 1) {
  if (styleStats[type] && typeof styleStats[type].introduced === 'number') {
    styleStats[type].introduced += n;
  }
  if (lifetimeStyleStats[type] && typeof lifetimeStyleStats[type].introduced === 'number') {
    lifetimeStyleStats[type].introduced += n;
  }
}

function applyStyleCheck(newStr, filePath) {
  if (!isKernelFile(filePath)) return '';
  try {
    const { violations, totalViolations } = styleCheckLines(newStr, filePath);
    styleStats._totalCHEdits++;
    lifetimeStyleStats._totalCHEdits++;
    styleStats._totalViolations        += totalViolations;
    lifetimeStyleStats._totalViolations += totalViolations;
    dbg('style-check', `_totalCHEdits=${styleStats._totalCHEdits} totalViolations=${totalViolations}`, { filePath });
    if (totalViolations === 0) {
      styleStats._cleanEdits++;
      lifetimeStyleStats._cleanEdits++;
      return '';
    }
    for (const v of violations) {
      bumpStyle(v.type);
    }
    const msg = styleFormatViolations(violations);
    return msg ? `\n${msg}` : '';
  } catch (_) {
    return '';
  }
}
// ---------------------------------------------------------------------------
// lintSnapshot(editor, startRow, endRow) — shared helper for lint:true param.
// Returns a compact lint string scoped to [startRow, endRow] (0-based inclusive),
// or null if linter-bundle is inactive, no messages in range, or any error.
// Scope logic:
//   1. If startRow/endRow provided, filter to that row range.
//   2. Messages: errors + warnings only (info too noisy).
//   3. Silent when clean (no output = no noise on good edits).
// ---------------------------------------------------------------------------
// Convenience wrapper — replaces the repeated inline IIFE pattern:
//   lint ? await (async () => { const snap = await lintSnapshot(...); return snap ? `\n${snap}` : ""; })() : ""
// Usage: await maybeLintSuffix(lint, editor, startRow, endRow)
//   startRow/endRow: 0-based row numbers, or null/null for a whole-file lint snapshot.
async function maybeLintSuffix(lint, editor, startRow, endRow) {
  if (!lint) return "";
  const snap = await lintSnapshot(editor, startRow, endRow);
  return snap ? `\n${snap}` : "";
}

async function lintSnapshot(editor, startRow, endRow) {
  // Returns a compact lint string scoped to [startRow, endRow] (0-based inclusive),
  // or null if linter-bundle inactive, no messages, or any error.
  // Rows use linter-bundle's native "row" field (0-based). If absent, falls back to
  // "line" field (also 0-based in raw execute() output). Scope is padded by 5 lines
  // to account for GCC reporting errors slightly outside the edited range.
  try {
    const lb = atom.packages.getActivePackage("linter-bundle");
    if (!lb) return null;

    const lbTool = lb?.mainModule?.provideMcpTools?.()
      ?.find(t => t.name === "GetLinterMessages");
    if (!lbTool) return null;

    const lbUiPanel = lb?.mainModule?._ui?.panel ?? lb?.mainModule?.ui?.panel;
    const origMode = lbUiPanel?.viewMode;
    if (lbUiPanel && origMode !== "file") lbUiPanel.viewMode = "file";
    let lbResult;
    try {
      lbResult = lbTool.execute();
    } finally {
      if (lbUiPanel && origMode !== "file") lbUiPanel.viewMode = origMode;
    }

    const allMsgs = lbResult.messages || [];
    const scopeStart = startRow != null ? Math.max(0, startRow - 5) : null;
    const scopeEnd   = endRow   != null ? endRow + 5 : null;

    const msgs = allMsgs
      .filter(m => m.severity === "error" || m.severity === "warning")
      .filter(m => {
        if (scopeStart == null) return true;
        if (m.range == null) return true; // file-level error, always include
        const row = m.range.start?.row ?? m.range.start?.line ?? 0;
        return row >= scopeStart && row <= scopeEnd;
      });

    if (msgs.length === 0) return null;

    const parts = msgs.map(m => {
      const lineNo = (m.range?.start?.row ?? m.range?.start?.line ?? 0) + 1;
      return `[L${lineNo}] ${m.severity} — ${m.excerpt}`;
    });
    return `⚠️ lint (${msgs.length}): ${parts.join(" | ")}`;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ambiguity check — shared by str_replace, replace-block, replace-function-body,
// delete-block, insert. Counts occurrences of needle in fullText and returns
// a blocking error object if ambiguous with no scope hint, or null if safe.
//
// needle        — the string/anchor being searched for
// fullText      — complete buffer text to scan
// noScopeHint   — true when no functionHint/afterHint/betweenHint/lineHint and occurrence<=1
// toolName      — for suggestions
// isCodeFile    — for code-specific suggestions
// matchLines[]  — optional pre-computed array of line numbers (avoids re-scan)
// ---------------------------------------------------------------------------
function ambiguityCheck({ needle, fullText, noScopeHint, toolName, isCodeFile, existingMatchLines }) {
  if (!noScopeHint) return null; // scoped — caller is being deliberate
  const matchLines = existingMatchLines || (() => {
    const lines = [];
    let pos = 0;
    while (lines.length <= 20) {
      const idx = fullText.indexOf(needle, pos);
      if (idx === -1) break;
      lines.push(fullText.substring(0, idx).split("\n").length);
      pos = idx + 1;
    }
    return lines;
  })();
  if (matchLines.length <= 1) return null; // unique — safe to proceed
  const lineList = matchLines.slice(0, 20).join(", ") + (matchLines.length > 20 ? "…" : "");
  const hints = [
    `⚠️  AMBIGUOUS — "${needle.substring(0, 60).replace(/\n/g, "↵")}" found ${matchLines.length}+ times in file (lines: ${lineList}).`,
    `   Proceeding without scoping would target occurrence 1 blindly. Be explicit:`,
    `   • functionHint:"name"      → scope to a named function body`,
    `   • afterHint:"string"       → start search after a unique anchor`,
    `   • betweenHint:{start,end}  → restrict to a region`,
    `   • occurrence:N             → explicitly target the Nth match (1=${matchLines[0]}, 2=${matchLines[1] || "?"}, ...)`,
    isCodeFile && toolName === "replace-block"
      ? `   • Or use replace-function-body if this block is a named function` : "",
    isCodeFile && (toolName === "delete-block" || toolName === "insert")
      ? `   • Or use delete-block/insert with sectionHint if this is a named section` : "",
  ].filter(Boolean).join("\n");
  return {
    content: [{ type: "text", text: hints }],
    matched: false, ambiguous: true,
    totalMatches: matchLines.length, matchAtLines: matchLines,
  };
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
    // NOTE: character-level brace scan — does not skip string literals, comments,
    // or regex. A '{' inside "..." or // ... can give a wrong endRow. Low frequency
    // in practice but functionHint scoping in str_replace depends on this being correct.
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
  if (!fs.existsSync(filePath)) throw new Error(`File not found: "${filePath}". Use get-project-files to list available paths.`);
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
  { name: "str_replace",             group: "edit",        desc: "Replace old_str with new_str. DECISION: know the function name? → functionHint. Know nearby unique text? → afterHint or betweenHint. Have a line number? → lineHint. Same pattern appears N times? → occurrence:N. Whitespace mismatch? → fuzzyWhitespace:true. Unsure of match? → dryRun:true first." },
  { name: "find-text",               group: "edit",        desc: "Find all positions of a string or regex in the active editor. Returns line numbers + optional context lines. Use before str_replace to confirm a pattern exists and count occurrences — tells you what occurrence:N to use." },
  { name: "replace-document",        group: "edit",        desc: "Replace the entire editor contents with new text. Use for full-file rewrites only." },
  { name: "insert",                  group: "edit",        desc: "Insert new lines into the active editor without touching existing content. Use afterContent/beforeContent (content anchors — immune to line drift) rather than insert_line. functionEnd inserts after a named function's closing brace. dryRun previews position before writing." },
  { name: "delete-line",             group: "edit",        desc: "DEPRECATED — use delete-line-range. Delete a single line." },
  { name: "delete-line-range",       group: "edit",        desc: "Delete a contiguous block of lines. functionHint deletes the entire named function body. betweenHint:{start,end} resolves both boundaries from content anchors. afterHint resolves the start line from content. dryRun previews what will be removed." },
  { name: "delete-block",            group: "edit",        desc: "Delete lines between two content anchor strings (both inclusive). sectionHint deletes a named section banner block; preprocBlock deletes a #ifdef...#endif pair by macro name. dryRun previews before committing." },
  { name: "replace-block",           group: "edit",        desc: "Replace a brace-delimited { } block found by an anchor string — for if/while/for/switch/struct blocks that are NOT named functions (use replace-function-body for functions). Anchor string identifies the line, brace-matching finds the closing }. occurrence:N, functionHint scope, dryRun supported." },
  { name: "get-region",              group: "edit",        desc: "Read lines between two content anchor strings without needing line numbers. Use before str_replace to verify what's in a section — immune to line drift. occurrence:N targets the Nth match of startContent." },
  { name: "get-selection",           group: "edit",        desc: "Return the currently selected text and its line/col range." },
  { name: "replace-all",             group: "edit",        desc: "Replace ALL occurrences of a string across the entire file. Use dryRun:true first to see the match count before committing." },
  { name: "get-structural-anchors",  group: "edit",        desc: "List section banners (sectionHint), #ifdef blocks (preprocBlock), and function end boundaries (functionEnd) in the active file. Call this before insert or delete-block when you need an anchor name to use." },
  // FileOps
  { name: "get-project-files",       group: "fileOps",     desc: "List all files under project roots, optionally filtered by glob. Use to discover file paths before read-lines or grep-file." },
  { name: "read-file",               group: "fileOps",     desc: "Read an entire file with 1-based line numbers. Expensive on large files — prefer read-lines (sections) or grep-file (search) when you don't need the whole file." },
  { name: "run-command",             group: "fileOps",     desc: "Execute a shell command and return stdout/stderr/exit code." },
  { name: "replace-across-files",    group: "fileOps",     desc: "Find and replace across all project files. First call without confirm returns a preview with match line numbers and context. Call again with confirm:true to commit. maxMatches cap (default 50) prevents accidental mass edits." },
  { name: "replace-function-body",   group: "fileOps",     desc: "Replace a named function's entire signature + body atomically. PREFERRED over str_replace for whole-function rewrites — no risk of partial match or line shift. Use afterHint/lineHint/occurrence to disambiguate if the name appears in multiple places. dryRun previews." },
  { name: "create-file",             group: "fileOps",     desc: "Create a new file and open it in the editor." },
  { name: "move-file",               group: "fileOps",     desc: "Move (or rename) a file from sourcePath to destPath. Open tabs are retargeted automatically." },
  { name: "copy-file",               group: "fileOps",     desc: "Copy a file to a new path and open the copy in a new tab." },
  { name: "rename-file",             group: "fileOps",     desc: "Rename a file within its current directory." },
  { name: "create-folder",           group: "fileOps",     desc: "Create a directory (and any missing parents)." },
  { name: "rename-folder",           group: "fileOps",     desc: "Rename or move a folder. All open tabs inside are retargeted to the new paths." },
  { name: "get-includes-and-defines",group: "fileOps",     desc: "Return all #include and #define lines with line numbers from a C/C++ file." },
  { name: "list-project-functions",  group: "fileOps",     desc: "List every function definition with line numbers across all project files. Use to find where a function is defined before read-lines or replace-function-body." },
  { name: "read-lines",              group: "fileOps",     desc: "Read a section of any file without opening it. PREFERRED over read-file for large files. DECISION: know function name? → functionHint. Know line number? → lineHint or startLine+endLine. Know surrounding text? → afterHint or betweenHint:{start,end}. Want a window around a line? → centerLine+radius." },
  { name: "file-line-count",         group: "fileOps",     desc: "Return a file's line count without loading content. Use before read-file to decide whether to use read-lines instead." },
  { name: "apply-patch",             group: "fileOps",     desc: "Apply a unified diff patch to the active editor. Context-anchored so it survives line shifts. Use for large multi-location edits where str_replace would require many calls." },
  // Debugging
  { name: "get-debug-log",           group: "debugging",   desc: "Return recent debug log entries from MCP tool calls. Supports tail (default 20), filter by keyword, and clear." },
  { name: "get-edit-stats",          group: "debugging",   desc: "Return per-tool edit statistics for the current session and lifetime totals. Edit tools (str_replace, insert, delete-*, replace-*, apply-patch, sed) report hits/fails. Search tools (grep-file, grep-project, search-symbol, find-text) report hits/misses separately — a miss is not a failure. Summary lines are split: sessionEditSummary + sessionSearchSummary. Pass reset:true to flush session into lifetime and zero session counters." },
  { name: "session-notes",           group: "debugging",   desc: "Persistent cross-session notes written by the LLM. action:write appends a note (what failed, what worked, lessons learned). action:read retrieves past notes at session start. action:clear wipes all notes. Notes survive server restarts." },
  { name: "checkpatch",              group: "debugging",   desc: "Run Linux kernel style checks against the active file (or any .c/.h file). Returns all violations grouped by rule with line numbers. Use to audit an existing file before or after editing." },
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
  { name: "search-symbol",           group: "search",      desc: "Find all uses of a C/C++ symbol with whole-word matching — won't match substrings. Use instead of grep-file when searching for a variable or function name to avoid partial matches. Supports contextLines and occurrence:N." },
  // Diagnostics
  { name: "get-compiler-diagnostics", group: "diagnostics", desc: "Syntax-check the active C/C++ file with gcc/clang/cl (runs compiler on disk — always save-file first)." },
  { name: "get-diagnostics",          group: "diagnostics", desc: "Return live linter diagnostics (errors, warnings, info) from linter-bundle. Live on buffer — no save needed." },
  // Highlight
  { name: "highlight-range",         group: "highlight",   desc: "Visually highlight a line range in the editor." },
  // Ghidra RE tools (now inline in mcpRegistration)
  { name: "list-functions",                   group: "ghidra", desc: "List all function definitions in the active Ghidra-decompiled C file (FUN_/sub_ names and standard C)." },
  { name: "search-functions",                 group: "ghidra", desc: "Find functions whose name matches a query string or regex. Returns name, line, signature." },
  { name: "get-function-body",                group: "ghidra", desc: "Extract complete source of a named function. Supports functionHint and occurrence:N for disambiguation." },
  { name: "get-xrefs",                        group: "ghidra", desc: "Find all call sites of a named function in the active file." },
  { name: "add-comment",                      group: "ghidra", desc: "Insert a block comment above a named function or at a specific line. Supports functionHint and occurrence:N." },
  { name: "get-function-list-with-comments",  group: "ghidra", desc: "List all functions with any existing comments — shows RE annotation progress at a glance." },
];

// Groups that can be toggled (core is always on)
export const TOGGLEABLE_GROUPS = ["edit", "fileOps", "navigation", "safety", "search", "diagnostics", "highlight", "debugging", "ghidra"];

export function mcpRegistration(server, linterRegistry = null, getMessages = null, groups = {}, chatPanel = null) {
  // Helper: returns true when a group is enabled (default: true)
  const g = (name) => groups[name] !== false;

  // Wrap every tool handler so errors surface in the chat panel as well as
  // returning to the LLM. Without this, tool exceptions are silently swallowed
  // by the MCP SDK transport layer and the user has no visibility into failures.
  const origRegister = server.registerTool.bind(server);
  server.registerTool = (name, meta, handler) => {
    return origRegister(name, meta, async (args) => {
      try {
        return await handler(args);
      } catch (err) {
        if (chatPanel) chatPanel.appendFault(name, err.message || String(err));
        throw err;   // re-throw so the MCP SDK still returns an error response to the LLM
      }
    });
  };

  // ── EDIT GROUP ────────────────────────────────────────────────────────────
  if (g('edit')) {
  {
    const curTool = "str_replace";
    server.registerTool(
      curTool,
      {
        title: "String Replace",
        description: [
          "Replace the first occurrence of `old_str` with `new_str` in the active editor.",
          "ALWAYS use a hint on files >100 lines to scope the search. DECISION LADDER:",
          "(1) Know the function/method name containing the edit? → functionHint:'myFn' — scopes search to inside that function body, immune to line number drift, safest choice for JS/C.",
          "(2) Know a unique string that appears just before the edit? → afterHint:'some anchor text' — starts search after that string, content-stable.",
          "(3) Edit is inside a specific block (switch case, struct, #ifdef)? → betweenHint:{start:'...', end:'...'} — restricts search to that exact region.",
          "(4) Have a line number from grep-file or read-lines? → lineHint:42 — starts search at that line.",
          "(5) Same short pattern appears N times and none of the above apply? → occurrence:N to target the Nth match.",
          "fuzzyWhitespace:true — set this when exact match fails due to indentation differences; matches trimmed content and uses the buffer's actual whitespace.",
          "dryRun:true — always use this first for multi-line old_str you're not certain about; previews what would be matched without writing.",
          "For replacing ALL occurrences use replace-all. For a full function rewrite use replace-function-body. For a full file rewrite use replace-document.",
          "Tracks consecutive failures and surfaces a tool-switch suggestion after repeated no-match errors."
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
      async ({ old_str, new_str, functionHint, lineHint, afterHint, betweenHint, occurrence = 1, fuzzyWhitespace = false, dryRun = false, lint = false }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { old_str: old_str.substring(0, 80), new_str: new_str.substring(0, 80), functionHint, lineHint, afterHint, betweenHint, occurrence, fuzzyWhitespace, dryRun });

        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer = editor.getBuffer();
        const isCodeFile = isCodeFilePath(editor.getPath());
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
            const fnRe = /^(?:(?:static|inline|extern|const|unsigned|signed|struct|enum|function)\s+)*[\w\s*]+\b(?!if|for|while|switch|return|else|do\b)(\w+)\s*\(/;
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
                smartSuggestion({ toolName: curTool, counter: strReplFailures, noHintsUsed: false, fileLines: allLines.length, oldStr: old_str, isCodeFile: isCodeFilePath(editor.getPath()) })
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
                smartSuggestion({ toolName: curTool, counter: strReplFailures, noHintsUsed: false, fileLines: allLines.length, oldStr: old_str, isCodeFile: isCodeFilePath(editor.getPath()) })
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
                smartSuggestion({ toolName: curTool, counter: strReplFailures, noHintsUsed: false, fileLines: allLines.length, oldStr: old_str, isCodeFile: isCodeFilePath(editor.getPath()) })
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
                smartSuggestion({ toolName: curTool, counter: strReplFailures, noHintsUsed: false, fileLines: allLines.length, oldStr: old_str, isCodeFile: isCodeFilePath(editor.getPath()) })
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
              smartSuggestion({ toolName: curTool, counter: strReplFailures, noHintsUsed: false, fileLines: allLines.length, oldStr: old_str, isCodeFile: isCodeFilePath(editor.getPath()) })
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
          const sugg = smartSuggestion({
            toolName: curTool,
            counter: strReplFailures,
            noHintsUsed: !functionHint && !afterHint && !betweenHint && !lineHint && occurrence <= 1,
            fileLines: allLines.length,
            oldStr: old_str,
            isCodeFile,
          });
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

        // ── Ambiguity guard (shared helper) ─────────────────────────────────
        const _ambig = ambiguityCheck({
          needle: effectiveOldStr, fullText: text,
          noScopeHint: !functionHint && !afterHint && !betweenHint && !lineHint && occurrence <= 1,
          toolName: curTool, isCodeFile,
        });
        if (_ambig) { bump('str_replace', 'fails.ambiguous'); strReplFailures.count++; return _ambig; }

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

        const _nudge = successNudge({
          toolName: curTool,
          noHintsUsed: !functionHint && !afterHint && !betweenHint && !lineHint && occurrence <= 1,
          fileLines: allLines.length,
          oldStr: old_str,
          isCodeFile,
        });

        const _lintSuffix = await maybeLintSuffix(lint, editor, matchLine, matchLine + new_str.split("\n").length - 1);
        const _styleSuffix = applyStyleCheck(new_str, editor.getPath());
        return {
          content: [{ type: "text", text: `✅ Replaced match at line ${matchLine + 1}${scopeLabel}${occurrence > 1 ? ` (occurrence ${occurrence})` : ""}${fuzzyWhitespace ? " [fuzzyWhitespace]" : ""}.${_nudge}${_lintSuffix}${_styleSuffix}` }],
          matched: true,
          dryRun: false,
          replacedAtLine: matchLine + 1
        };
      }
    );
  }

  {
    const curTool = "find-text";
    server.registerTool(
      curTool,
      {
        title: "Find Text",
        description: [
          "Find all occurrences of a string or regex in the active editor and return their line numbers.",
          "USE THIS TO: count how many times a pattern appears before deciding to use str_replace vs replace-all; get the exact line numbers and occurrence indices for a pattern before editing; confirm a pattern exists before attempting an edit.",
          "occurrence:N — return only the Nth match with its context. Use this to get the exact line number of a specific instance, then pass that line number to str_replace lineHint.",
          "contextLines:N — return N lines before and after each match. Use this to verify the surrounding code, not just the match line.",
          "regex:true — treat query as a regular expression. caseSensitive:true — case-sensitive matching (default is case-insensitive).",
          "Returns matchCount so you know how many times the pattern appears — if matchCount > 1 you should use occurrence:N or a hint with str_replace to avoid hitting the wrong instance."
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
          bump('find_text', 'fails.noMatch');
          throw new Error(`occurrence ${occurrence} not found — only ${globalIndex} match(es) in file.`);
        }

        if (matches.length === 0) { bump('find_text', 'fails.noMatch'); return { content: [{ type: "text", text: "No matches." }], matches: [], totalMatches: 0, truncated: false }; }

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

        bump('replace_document', 'hits');
        return {
          lineCount: lines.length, checksum, sampleLines
        };
      }
    );
  }

  {
    const curTool = "insert";
    server.registerTool(
      curTool,
      {
        title: "Insert",
        description: [
          "Insert new lines into the active editor without modifying any existing content. Use this when adding code, not changing it.",
          "DECISION — how to anchor the insert position:",
          "(0) Appending to the end of the file? → endOfFile:true — the simplest and most reliable option for any 'add to end' operation.",
          "(1) Adding a new function after an existing one? → functionEnd:'existingFnName' — inserts after that function's closing brace, the most reliable way to insert between functions.",
          "(2) Know a unique string that should appear just before the insertion point? → afterContent:'some anchor text' to insert after it, or beforeContent:'...' to insert before it. Content-anchored — immune to line drift.",
          "(3) Inside a known function and want to scope the anchor search? → combine afterContent/beforeContent with functionHint:'fnName'.",
          "(4) Same anchor string appears multiple times? → occurrence:N to target the Nth match.",
          "(5) Only know a line number? → insert_line (1-based) — but CAUTION: line numbers shift after every insert; use read-lines to verify current numbers first.",
          "dryRun:true previews what will be inserted and where without writing — use this before any insert you're unsure about.",
          "WARNING: after any insert, all line numbers below the insertion point shift. Never use stale line numbers for a subsequent edit — call read-lines to get updated positions."
        ].join(" "),
        inputSchema: {
          new_str:       z.string(),
          endOfFile:     z.boolean().optional(),
          insert_line:   z.number().optional(),
          ...STRUCTURAL_ANCHOR_SCHEMA,  // afterContent, beforeContent, functionEnd, sectionHint, preprocBlock, preprocSide, functionHint, occurrence, dryRun
        }
      },
      async ({ insert_line, new_str, endOfFile = false, afterContent, beforeContent, functionHint, functionEnd, occurrence = 1, dryRun = false, lint = false }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { insert_line, new_str: new_str.substring(0, 80), endOfFile, afterContent, beforeContent, functionHint, functionEnd, occurrence, dryRun });

        const editor    = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");
        const buffer    = editor.getBuffer();
        const lineCount = buffer.getLineCount();
        const allLines  = buffer.getLines();

        // ── endOfFile anchor ─────────────────────────────────────────────────
        if (endOfFile) {
          bump('insert', 'hintsUsed.endOfFile');
          const insertRow = lineCount;
          if (dryRun) {
            bump('insert', 'dryRuns');
            const r        = 3;
            const cs       = Math.max(0, insertRow - r);
            const ctxLines = allLines.slice(cs, insertRow).map((l, i) => `${String(cs + i + 1).padStart(4)}   ${l}`);
            const insLines = new_str.split("\n").map(l => `${" ".repeat(4)} ► ${l}`);
            return {
              content: [{ type: "text", text: [
                `✅ DRY RUN — will insert ${new_str.split("\n").length} line(s) at end of file (after line ${lineCount}).`,
                `\nContext (► = lines to be inserted):\n${[...ctxLines, ...insLines].join("\n")}`,
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
          const _lintSuffix = await maybeLintSuffix(lint, editor, insertRow, insertRow + new_str.split("\n").length - 1);
          const _styleSuffix = applyStyleCheck(new_str, editor.getPath());
          return {
            content: [{ type: "text", text: `✅ Inserted ${new_str.split("\n").length} line(s) at end of file. New line count: ${newLineCount}.${_lintSuffix}${_styleSuffix}` }],
            dryRun: false, newLineCount
          };
        }

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
          const _lintSuffix = await maybeLintSuffix(lint, editor, insertRow, insertRow + new_str.split("\n").length - 1);
          const _styleSuffix = applyStyleCheck(new_str, editor.getPath());
          return {
            content: [{ type: "text", text: `✅ Inserted ${new_str.split("\n").length} line(s)${scopeLabel}. New line count: ${newLineCount}. Remember: line numbers have shifted!${_lintSuffix}${_styleSuffix}` }],
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
              smartSuggestion({ toolName: "insert", counter: insertFailures, noHintsUsed: !functionHint && !afterContent && !beforeContent, fileLines: allLines.length, oldStr: null, isCodeFile: isCodeFilePath(editor.getPath()) })
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
          const _lintSuffix2 = await maybeLintSuffix(lint, editor, insertRow, insertRow + new_str.split("\n").length - 1);
          const _styleSuffix2 = applyStyleCheck(new_str, editor.getPath());
          return {
            content: [{ type: "text", text: `✅ Inserted ${new_str.split("\n").length} line(s) ${insertAfter ? "after" : "before"} anchor (line ${anchorRow + 1})${scopeLabel}${strategyMsg}. New line count: ${newLineCount}. Remember: line numbers have shifted!${_lintSuffix2}${_styleSuffix2}` }],
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
            smartSuggestion({ toolName: "insert", counter: insertFailures, noHintsUsed: true, fileLines: allLines.length, oldStr: null, isCodeFile: isCodeFilePath(editor.getPath()) })
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
        const _lintSuffix3 = await maybeLintSuffix(lint, editor, row, row + new_str.split("\n").length - 1);
        const _styleSuffix3 = applyStyleCheck(new_str, editor.getPath());
        return {
          content: [{ type: "text", text: `✅ Inserted text at line ${insert_line}. New line count: ${newLineCount}. Remember: line numbers have shifted!${_lintSuffix3}${_styleSuffix3}` }],
          dryRun: false,
          newLineCount
        };
      }
    );
  }



  {
    const curTool = "delete-line";
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
    server.registerTool(
      curTool,
      {
        title: "Delete Line Range",
        description: [
          "Delete a contiguous range of lines from the active editor.",
          "DECISION — how to specify what to delete:",
          "(1) Want to delete an entire named function? → functionHint:'myFn' — deletes the complete function body including its signature. No line numbers needed.",
          "(2) Know unique text that surrounds the block to delete? → betweenHint:{start:'...', end:'...'} — resolves both start and end lines from content anchors, immune to line drift.",
          "(3) Know a unique string that appears just before the block? → afterHint:'anchor text' to set the start line from content; combine with endLine for the end.",
          "(4) Have exact line numbers? → startLine + endLine (both 1-based inclusive).",
          "occurrence:N — when using anchor hints, targets the Nth occurrence of the anchor.",
          "dryRun:true — previews which lines will be deleted without writing. Always use this when unsure of the range.",
          "WARNING: after any delete, line numbers below the deletion point shift. Never reuse stale line numbers for a subsequent edit."
        ].join(" "),
        inputSchema: {
          startLine:    z.number().optional(),
          endLine:      z.number().optional(),
          ...ANCHOR_SCHEMA,  // functionHint, afterHint, betweenHint, lineHint, occurrence, dryRun
        }
      },
      async ({ startLine, endLine, dryRun = false, functionHint, afterHint, lineHint, betweenHint, occurrence = 1, fuzzyWhitespace, lint = false }) => {
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
            smartSuggestion({ toolName: "delete-line-range", counter: deleteFailures, noHintsUsed: !functionHint && !afterHint && !betweenHint && !lineHint, fileLines: lineCount, oldStr: null, isCodeFile: isCodeFilePath(editor.getPath()) })
          ].filter(Boolean).join("\n") }], deleted: false, deleteFailures: deleteFailures.count };
        }
        if (startLine > endLine) {
          deleteFailures.count++;
          bump('delete_line_range', 'fails.inverted');
          return { content: [{ type: "text", text: [
            `❌ startLine (${startLine}) must be <= endLine (${endLine}).`,
            `   Did you mean startLine=${endLine}, endLine=${startLine}?`,
            smartSuggestion({ toolName: "delete-line-range", counter: deleteFailures, noHintsUsed: !functionHint && !afterHint && !betweenHint && !lineHint, fileLines: lineCount, oldStr: null, isCodeFile: isCodeFilePath(editor.getPath()) })
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
            smartSuggestion({ toolName: "delete-line-range", counter: deleteFailures, noHintsUsed: !functionHint && !afterHint && !betweenHint && !lineHint, fileLines: lineCount, oldStr: null, isCodeFile: isCodeFilePath(editor.getPath()) })
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
        const _lintSuffix = await maybeLintSuffix(lint, editor, startRow, startRow + 5);
        return {
          content: [{ type: "text", text: `✅ Deleted ${deletedCount} line(s) (${startLine}–${endLine}). New line count: ${newLineCount}. Line numbers have shifted — call get-document or read-lines before the next line-based edit.${_lintSuffix}` }],
          dryRun: false, deleted: true, newLineCount, deletedCount, staleLinesWarning: true
        };
      }
    );
  }

  {
    const curTool = "get-selection";
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
    server.registerTool(
      curTool,
      {
        title: "Delete Block",
        description: [
          "Delete all lines between two content anchor strings (inclusive by default). Content-stable — immune to line number drift.",
          "DECISION — three ways to specify what to delete:",
          "(1) Deleting a named section banner block (e.g. a // ── SECTION TITLE ── comment and its contents)? → sectionHint:'SECTION TITLE' — finds the banner by keyword and deletes the whole block.",
          "(2) Deleting a #ifdef...#endif block by macro name? → preprocBlock:'MACRO_NAME' — deletes the entire preprocessor conditional. Use preprocSide:'open' or 'close' to target only one end of the pair.",
          "(3) Know unique text at the start and end of the block to remove? → startContent:'...' and endContent:'...' — deletes from the startContent line to the endContent line inclusive.",
          "inclusive:false — exclude the anchor lines themselves (delete only what's between them, keeping the anchors).",
          "functionHint — scope the startContent/endContent search to within a named function body.",
          "occurrence:N — when startContent appears multiple times, target the Nth occurrence.",
          "dryRun:true — preview exactly which lines will be deleted without writing. Always use this first."
        ].join(" "),
        inputSchema: {
          startContent: z.string().optional(),
          endContent:   z.string().optional(),
          inclusive:    z.boolean().optional(),
          ...STRUCTURAL_ANCHOR_SCHEMA,  // sectionHint, preprocBlock, preprocSide, functionHint, occurrence, dryRun
        }
      },
      async ({ startContent, endContent, sectionHint, preprocBlock, preprocSide, inclusive = true, functionHint, afterHint, betweenHint, lineHint, occurrence = 1, dryRun = false, lint = false }) => {
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
          if (preprocBlock)  bump('delete_block', 'hintsUsed.preprocBlock');
          if (functionHint)  bump('delete_block', 'hintsUsed.functionHint');
          if (occurrence > 1) bump('delete_block', 'hintsUsed.occurrence');
          if (sectionHint)   bump('delete_block', 'hintsUsed.sectionHint');
          const resolved = resolveStructuralAnchor(buffer, { sectionHint, preprocBlock, preprocSide });
          if (!resolved) {
            deleteBlockFailures.count++;
            bump('delete_block', 'fails.anchorNotFound');
            const kind = sectionHint ? `sectionHint "${sectionHint}"` : `preprocBlock "${preprocBlock}"`;
            return { content: [{ type: "text", text: [
              `❌ ${kind} not found. Use get-structural-anchors to list available anchors.`,
              smartSuggestion({ toolName: "delete-block", counter: deleteBlockFailures, noHintsUsed: !sectionHint && !preprocBlock && !functionHint, fileLines: lineCount, oldStr: null, isCodeFile: isCodeFilePath(editor.getPath()) })
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
          deleteBlockFailures.count = 0;
          bump('delete_block', 'hits');
          const newLineCount = buffer.getLineCount();
          const _lintSuffix = await maybeLintSuffix(lint, editor, delStart, delStart + 5);
          return {
            content: [{ type: "text", text: `✅ Deleted ${deletedCount} line(s) (lines ${delStart + 1}–${delEnd + 1}). New line count: ${newLineCount}. Line numbers have shifted.${_lintSuffix}` }],
            dryRun: false, deleted: true, newLineCount, deletedCount, staleLinesWarning: true
          };
        }

        // ── Content-anchor path (startContent + endContent) ───────────────────
        if (!startContent || !endContent) {
          return { content: [{ type: "text", text: "❌ Provide either sectionHint, preprocBlock, or both startContent and endContent." }], deleted: false };
        }

        // Track content-anchor hint usage
        bump('delete_block', 'hintsUsed.startContent');
        bump('delete_block', 'hintsUsed.endContent');
        if (functionHint)  bump('delete_block', 'hintsUsed.functionHint');
        if (occurrence > 1) bump('delete_block', 'hintsUsed.occurrence');

        // Resolve optional function scope
        let searchFrom = 0;
        let _searchTo   = allLines.length - 1;
        if (functionHint) {
          const fn = findFunctionInBuffer(buffer, functionHint);
          if (!fn) {
            deleteBlockFailures.count++;
            bump('delete_block', 'fails.anchorNotFound');
            return { content: [{ type: "text", text: `❌ functionHint: function "${functionHint}" not found.` }], deleted: false };
          }
          searchFrom = fn.startRow;
          _searchTo   = fn.endRow;
        }

        // Find Nth occurrence of startContent (multi-line, fuzzy, indent-aware)
        const startHit = findAnchor(buffer, startContent, { occurrence, functionHint, afterRow: searchFrom });
        if (!startHit) {
          deleteBlockFailures.count++;
          bump('delete_block', 'fails.startNotFound');
          return { content: [{ type: "text", text: [
            `❌ startContent not found (occurrence ${occurrence}): "${startContent}"`,
            smartSuggestion({ toolName: "delete-block", counter: deleteBlockFailures, noHintsUsed: !functionHint && !sectionHint && !preprocBlock, fileLines: lineCount, oldStr: null, isCodeFile: isCodeFilePath(editor.getPath()) })
          ].filter(Boolean).join("\n") }], deleted: false, deleteBlockFailures: deleteBlockFailures.count };
        }
        const startRow     = startHit.row;
        const startMsgHint = startHit.strategy !== "exact" ? ` (startContent matched via ${startHit.strategy})` : "";

        // Find endContent starting after startContent (multi-line, fuzzy, indent-aware)
        const endHit = findAnchor(buffer, endContent, { afterRow: startRow + 1, functionHint });
        if (!endHit) {
          deleteBlockFailures.count++;
          bump('delete_block', 'fails.endNotFound');
          const previewStart = startRow + 1;
          const previewEnd   = Math.min(allLines.length - 1, startRow + 10);
          const afterCtx     = allLines.slice(previewStart, previewEnd + 1)
            .map((l, i) => `${String(previewStart + i + 1).padStart(4)}: ${l}`).join("\n");
          return { content: [{ type: "text", text: [
            `❌ endContent not found after startContent (line ${startRow + 1}): "${endContent}"`,
            `\n📍 Lines after startContent — pick the correct endContent from here:\n${afterCtx}`,
            `\n💡 Tip: endContent can be multi-line or fuzzy-matched, but every line must appear in order. Use a single unique line if possible.`,
            smartSuggestion({ toolName: "delete-block", counter: deleteBlockFailures, noHintsUsed: !functionHint && !sectionHint && !preprocBlock, fileLines: lineCount, oldStr: null, isCodeFile: isCodeFilePath(editor.getPath()) })
          ].filter(Boolean).join("\n") }], deleted: false, deleteBlockFailures: deleteBlockFailures.count };
        }
        const endRow     = endHit.row + endHit.matchedRows - 1;
        const endMsgHint = endHit.strategy !== "exact" ? ` (endContent matched via ${endHit.strategy})` : "";

        // Apply inclusive setting
        const delStart = inclusive ? startRow : startRow + 1;
        const delEnd   = inclusive ? endRow   : endRow   - 1;

        // ── Ambiguity check on startContent ──────────────────────────────────
        if (startContent) {
          const _isCode = isCodeFilePath(editor.getPath());
          const _noScope = !functionHint && !afterHint && !betweenHint && !lineHint && occurrence <= 1;
          const _ambig = ambiguityCheck({ needle: startContent, fullText: buffer.getText(), noScopeHint: _noScope, toolName: "delete-block", isCodeFile: _isCode });
          if (_ambig) { bump('delete_block', 'fails.startNotFound'); deleteBlockFailures.count++; return _ambig; }
        }

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
        deleteBlockFailures.count = 0;
        bump('delete_block', 'hits');
        const newLineCount = buffer.getLineCount();
        const _lintSuffix2 = await maybeLintSuffix(lint, editor, delStart, delStart + 5);
        return {
          content: [{ type: "text", text: `✅ Deleted ${deletedCount} line(s) (lines ${delStart + 1}–${delEnd + 1}). New line count: ${newLineCount}. Line numbers have shifted.${_lintSuffix2}` }],
          dryRun: false, deleted: true, newLineCount, deletedCount, staleLinesWarning: true
        };
      }
    );
  }

  // ── P7: replace-block ─────────────────────────────────────────────────────
  {
    const curTool = "replace-block";
    server.registerTool(
      curTool,
      {
        title: "Replace Block",
        description: [
          "Replace a brace-delimited { } block in the active editor, identified by an anchor string on or near the opening line.",
          "USE THIS FOR: if/else blocks, while/for loops, switch statements, struct initialisers, anonymous blocks — any { } region that is NOT a named function. For named functions use replace-function-body instead.",
          "HOW IT WORKS: finds the first line containing anchor, locates the next { on or after it, brace-counts to the matching }, replaces the entire block with newBody.",
          "newBody must be the complete replacement including the anchor line and both braces.",
          "EXAMPLE: to replace `if (x > 0) { doA(); }` — anchor:'if (x > 0)', newBody:'if (x > 0) {\\n  doB();\\n}'.",
          "occurrence:N — when the same anchor string appears multiple times, targets the Nth occurrence.",
          "functionHint — scopes the anchor search to within a named function body, preventing false matches elsewhere in the file.",
          "dryRun:true — previews what block will be matched without writing. Use this first when the anchor string might match multiple blocks.",
          "NOTE: braceMatchFailed means the anchor was found but no { } block followed it. If this happens consistently, use str_replace instead."
        ].join(" "),
        inputSchema: {
          anchor:  z.string(),
          newBody: z.string(),
          ...ANCHOR_SCHEMA
        }
      },
      async ({ anchor, newBody, occurrence = 1, dryRun = false, functionHint, afterHint, lineHint, betweenHint, fuzzyWhitespace, lint = false }) => {
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

        // ── Ambiguity check — count anchor matches in full file ───────────────
        {
          const _isCode = isCodeFilePath(editor.getPath());
          const _noScope = !functionHint && !afterHint && !betweenHint && !lineHint && occurrence <= 1;
          const _ambig = ambiguityCheck({ needle: anchor, fullText: buffer.getText(), noScopeHint: _noScope, toolName: curTool, isCodeFile: _isCode });
          if (_ambig) { bump('replace_block', 'fails.anchorNotFound'); return _ambig; }
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
        const _lintSuffix = await maybeLintSuffix(lint, editor, startRow, startRow + newBody.split("\n").length - 1);
        const _styleSuffix = applyStyleCheck(newBody, editor.getPath());
        bump('replace_block', 'hits');
        return {
          content: [{ type: "text", text: `✅ Replaced block (anchor: "${anchor}", old lines ${startRow + 1}–${endRow + 1}). Inserted ${insertedLines} lines starting at ${startRow + 1}. New total: ${newLineCount}.${_lintSuffix}${_styleSuffix}` }],
          found: true, dryRun: false, oldStartLine: startRow + 1, oldEndLine: endRow + 1,
          newStartLine: startRow + 1, insertedLines, newLineCount
        };
      }
    );
  }

  // ── P8: get-region ────────────────────────────────────────────────────────
  {
    const curTool = "get-region";
    server.registerTool(
      curTool,
      {
        title: "Get Region",
        description: [
          "Read lines between two content anchor strings from the active editor — use this when you know surrounding text but not line numbers.",
          "USE THIS TO: verify what's inside a block before editing it; read a switch case; read a struct initialiser; read any named section.",
          "Provide startContent (unique text at or near the start of the region) and endContent (unique text at or near the end). Returns all lines from startContent's line to endContent's line inclusive.",
          "occurrence:N — when startContent appears multiple times, targets the Nth occurrence. inclusive:false excludes the anchor lines themselves.",
          "Immune to line number drift — safe to use even when the file has been recently edited.",
          "After reading with get-region, use the returned line numbers directly with str_replace lineHint, or use betweenHint with the same anchor strings to scope an edit."
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
        if (occurrence > 1) bump('get_region', 'hintsUsed.occurrence');
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
    const curTool = "close-file";
    server.registerTool(curTool,
      {
        title: "Close File",
        description: "Close an editor tab by path. If path is omitted, closes the active editor. " +
          "Set save:true to save unsaved changes before closing (default: false — unsaved changes are discarded). " +
          "Returns {closed:true} on success or {closed:false, error} if the file was not found.",
        inputSchema: {
          filePath: z.string().optional().describe("Absolute path of the file to close. Omit to close the active editor."),
          save:     z.boolean().optional().describe("Save before closing if the buffer has unsaved changes (default: false)."),
        },
      },
      async ({ filePath, save = false } = {}) => {
        bump(curTool, 'hits');
        let editor, pane;
        if (filePath) {
          editor = atom.workspace.getTextEditors().find(e => e.getPath() === filePath);
          if (!editor) {
            bump(curTool, 'fails.notFound');
            return { content: [{ type: "text", text: `close-file: no open editor found for path: ${filePath}` }], closed: false, error: "notFound" };
          }
          pane = atom.workspace.paneForItem(editor);
        } else {
          editor = atom.workspace.getActiveTextEditor();
          if (!editor) {
            bump(curTool, 'fails.notFound');
            return { content: [{ type: "text", text: "close-file: no active editor" }], closed: false, error: "noActiveEditor" };
          }
          pane = atom.workspace.getActivePane();
        }
        if (save && editor.isModified()) {
          await editor.save();
        }
        pane.destroyItem(editor, true);
        return { content: [{ type: "text", text: `Closed: ${filePath || editor.getPath() || "[untitled]"}` }], closed: true };
      }
    );
  }

  {
    const curTool = "goto-focus";
    server.registerTool(curTool,
      {
        title: "Goto Focus",
        description: "Set one or more cursor positions or selections in the active editor. " +
          "All positions are 1-based line numbers (matching the Pulsar gutter). " +
          "If end is omitted, places a cursor at start without selecting. " +
          "Useful for moving the user's view to a relevant line after an edit.",
        inputSchema: {
          selections: z.array(z.object({
            startLine:   z.number().describe("Start line (1-based)"),
            startColumn: z.number().optional().describe("Start column (1-based, default: 1)"),
            endLine:     z.number().optional().describe("End line (1-based, defaults to startLine)"),
            endColumn:   z.number().optional().describe("End column (1-based, defaults to startColumn)"),
          })).min(1).describe("Array of selection ranges to set. First entry becomes the primary selection."),
        },
      },
      async ({ selections } = {}) => {
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) {
          bump(curTool, 'fails.noEditor');
          return { content: [{ type: "text", text: "goto-focus: no active editor" }], set: false };
        }
        const ranges = selections.map(sel => {
          const sr = (sel.startLine   || 1) - 1;
          const sc = (sel.startColumn || 1) - 1;
          const er = sel.endLine   ? sel.endLine   - 1 : sr;
          const ec = sel.endColumn ? sel.endColumn - 1 : sc;
          return [[sr, sc], [er, ec]];
        });
        editor.setSelectedBufferRanges(ranges);
        bump(curTool, 'hits');
        return { content: [{ type: "text", text: `Set ${selections.length} selection(s)` }], set: true, count: selections.length };
      }
    );
  }

  {
    const curTool = "get-project-paths";
    server.registerTool(curTool,
      {
        title: "Get Project Paths",
        description: "Return the list of root folder paths currently open in the Pulsar project. " +
          "Useful for resolving relative paths and understanding the workspace layout. " +
          "Returns an empty array if no project folders are open.",
        inputSchema: {},
      },
      async () => {
        const paths = atom.project.getPaths();
        bump(curTool, 'hits');
        return { content: [{ type: "text", text: JSON.stringify(paths, null, 2) }], paths };
      }
    );
  }

  {
    const curTool = "add-project-path";
    server.registerTool(curTool,
      {
        title: "Add Project Path",
        description: "Add an additional root folder to the Pulsar project without removing existing roots. " +
          "Useful for multi-repo workflows. The path must exist on disk. " +
          "Returns {added:true, paths:[...]} with the updated project path list on success.",
        inputSchema: {
          path: z.string().describe("Absolute folder path to add to the project."),
        },
      },
      async ({ path: folderPath } = {}) => {
        if (!folderPath) throw new Error("path is required");
        const fs = require('fs');
        if (!fs.existsSync(folderPath)) {
          bump(curTool, 'fails.notFound');
          return { content: [{ type: "text", text: `add-project-path: path does not exist: ${folderPath}` }], added: false, error: "notFound" };
        }
        atom.project.addPath(folderPath);
        bump(curTool, 'hits');
        const paths = atom.project.getPaths();
        return { content: [{ type: "text", text: `Added: ${folderPath}\nProject paths: ${paths.join(', ')}` }], added: true, paths };
      }
    );
  }

  } // end NAVIGATION GROUP

  // ── SAFETY GROUP ──────────────────────────────────────────────────────────
  if (g('safety')) {
  {
    const curTool = "undo";
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
    server.registerTool(curTool,
      {
        title: "Run Command",
        description: [
          `Execute a shell command and return stdout, stderr, and exit code.`,
          `On Windows uses PowerShell; on Linux/Mac uses /bin/sh.`,
          `cwd defaults to the first project root. timeout defaults to 30 seconds (in ms).`,
          `Use for build commands (make, gcc, cmake), running tests, git status, etc.`,
          `showOutput — stream stdout/stderr live to the chat panel (default true). Set false for noisy diagnostic commands where you only want the final result.`
        ].join(" "),
        inputSchema: {
          command: z.string(),
          cwd:     z.string().optional(),
          timeout: z.number().optional(),
          confirm:    z.boolean().optional(),
          showOutput: z.boolean().optional()
        }
      },
      async ({ command, cwd, timeout = 30000, confirm = false, showOutput = true }) => {
        const workDir = cwd || (atom.project.getPaths()[0] ?? null);
        if (!workDir) throw new Error("No project root open and no cwd provided.");

        const { shell, flag } = getShell();

        // Destructive command guard — pause and ask user to confirm in chat panel
        // before running anything that deletes files or wipes data.
        // Pass confirm:true to bypass (for LLM-driven automation flows).
        const DESTRUCTIVE_RE = /\b(rm|rmdir|del|rd|format|Remove-Item|ri\s|rd\s.*\/s)\b/i;
        if (!confirm && DESTRUCTIVE_RE.test(command)) {
          if (!chatPanel) {
            // No panel open — block with an error to be safe
            return {
              content: [{ type: "text", text: JSON.stringify({
                error: "Destructive command blocked: open the chat panel or pass confirm:true to proceed.",
                command
              }) }]
            };
          }
          // Show confirmation UI in chat panel; MCP response held until user decides
          const userChoice = await new Promise((resolveChoice) => {
            const chatDisplay = chatPanel.element.querySelector('#chat-display');
            if (!chatDisplay) { resolveChoice(false); return; }

            const wrapper = document.createElement('div');
            wrapper.classList.add('chat-command-output', 'chat-command-confirm');
            wrapper.innerHTML = `<span>⚠️ Destructive command: <code>${command.replace(/</g,'&lt;')}</code> — Run anyway?</span>`;

            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;gap:6px;margin-top:6px';

            const yesBtn = document.createElement('button');
            yesBtn.className = 'btn btn-error';
            yesBtn.textContent = 'Run';
            yesBtn.addEventListener('click', () => { wrapper.remove(); resolveChoice(true); });

            const noBtn = document.createElement('button');
            noBtn.className = 'btn';
            noBtn.textContent = 'Cancel';
            noBtn.addEventListener('click', () => { wrapper.remove(); resolveChoice(false); });

            btnRow.appendChild(yesBtn);
            btnRow.appendChild(noBtn);
            wrapper.appendChild(btnRow);
            chatDisplay.appendChild(wrapper);
            chatDisplay.scrollTop = chatDisplay.scrollHeight;
          });

          if (!userChoice) {
            return {
              content: [{ type: "text", text: JSON.stringify({ cancelled: true, command, reason: "User declined destructive command." }) }]
            };
          }
        }

        // Announce the command in the chat panel (only when showOutput is true)
        if (chatPanel && showOutput) chatPanel.appendOutput(`$ ${command}`, 'info');

        return new Promise((resolve) => {
          // Use spawn so we can stream stdout/stderr live to the chat panel.
          // Shell and flag are resolved by getShell() for cross-platform support.
          const spawnArgs = [flag, command];
          const proc = _spawn(shell, spawnArgs, { cwd: workDir, shell: false });

          let stdoutBuf = '';
          let stderrBuf = '';
          let timedOut  = false;

          const timer = setTimeout(() => {
            timedOut = true;
            proc.kill();
          }, timeout);

          proc.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            stdoutBuf += text;
            if (chatPanel && showOutput) text.replace(/\r\n/g, '\n').split('\n')
              .filter(l => l.length > 0)
              .forEach(l => chatPanel.appendOutput(l, 'stdout'));
          });

          proc.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            stderrBuf += text;
            if (chatPanel && showOutput) text.replace(/\r\n/g, '\n').split('\n')
              .filter(l => l.length > 0)
              .forEach(l => chatPanel.appendOutput(l, 'stderr'));
          });

          proc.on('close', (code) => {
            clearTimeout(timer);
            const exitCode = timedOut ? -1 : (code ?? 0);
            if (chatPanel && showOutput) chatPanel.appendOutput(`[exit ${exitCode}]`, 'exit');
            bump('run_command', 'hits');
            if (timedOut)        bump('run_command', 'misses.timedOut');
            else if (exitCode !== 0) bump('run_command', 'misses.exitNonZero');
            const result = { command, shell, cwd: workDir, exitCode,
                             stdout: stdoutBuf.trim(), stderr: stderrBuf.trim(),
                             timedOut };
            resolve({
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              exitCode, stdout: stdoutBuf.trim(), stderr: stderrBuf.trim()
            });
          });

          proc.on('error', (err) => {
            clearTimeout(timer);
            bump('run_command', 'fails.spawnError');
            if (chatPanel) chatPanel.appendOutput(`[error: ${err.message}]`, 'stderr');
            resolve({
              content: [{ type: "text", text: JSON.stringify(
                { command, shell, cwd: workDir, exitCode: -1,
                  stdout: stdoutBuf.trim(), stderr: err.message }, null, 2) }],
              exitCode: -1, stdout: '', stderr: err.message
            });
          });
        });
      }
    );
  }

  {
    const curTool = "replace-across-files";

    // Pending-confirm store — holds the last dry-run result so confirm:true can commit
    // without re-scanning. Cleared on each new query or successful commit.
    const rafPending = { key: null, files: [] };

    server.registerTool(curTool,
      {
        title: "Replace Across Files",
        description: [
          "Find and replace a string or regex across all project files (or a glob-filtered subset).",
          "TWO-STEP WORKFLOW — always do both steps:",
          "Step 1: call WITHOUT confirm — returns a preview listing every match with file path, line number, and contextLines (default 2) of surrounding context. Review this before committing.",
          "Step 2: call again WITH confirm:true and the same query/replacement — commits all replacements.",
          "glob — restrict to a file pattern e.g. '**/*.js' or 'src/**/*.c'. Use this to narrow the scope when the pattern appears in many files.",
          "maxMatches (default 50) — if exceeded the tool blocks and asks you to narrow with glob or raise the limit.",
          "contextLines (default 2) — number of lines before/after each match shown in the preview.",
          "Files open in editor tabs are updated live with undo history preserved; closed files are written to disk. Binary files are skipped."
        ].join(" "),
        inputSchema: {
          query:         z.string(),
          replacement:   z.string(),
          regex:         z.boolean().optional(),
          caseSensitive: z.boolean().optional(),
          glob:          z.string().optional(),
          contextLines:  z.number().optional(),
          maxMatches:    z.number().optional(),
          confirm:       z.boolean().optional(),
          dryRun:        z.boolean().optional(),   // legacy alias — treated as !confirm
        }
      },
      async ({ query, replacement, regex = false, caseSensitive = false, glob = "",
               contextLines = 2, maxMatches = 50, confirm = false, dryRun = false }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { query, replacement, regex, caseSensitive, glob, contextLines, maxMatches, confirm, dryRun });

        // dryRun:true (legacy) means preview pass, not commit
        const committing = confirm && !dryRun;

        const roots = atom.project.getPaths();
        if (!roots.length) throw new Error("No project root open.");

        const BINARY_EXTS = new Set(["o","obj","exe","dll","so","dylib","bin","lib","a","out","pdb","ilk","map","elf","hex","png","jpg","jpeg","gif","bmp","ico","pdf","zip","tar","gz","7z","rar"]);

        // ── COMMIT PATH ────────────────────────────────────────────────────────
        // confirm:true — use the pending store from the last preview, no re-scan needed
        if (committing) {
          const pendingKey = `${query}||${replacement}||${glob}||${regex}||${caseSensitive}`;
          if (rafPending.key !== pendingKey || rafPending.files.length === 0) {
            return { content: [{ type: "text", text:
              "⚠️ No matching preview found to confirm. Run the tool without confirm:true first to generate a match listing, then confirm."
            }] };
          }

          const flags  = caseSensitive ? "g" : "gi";
          const source = regex ? query : escapeRegex(query);
          const skipped = [];
          let totalReplacements = 0;
          const committed = [];

          for (const { filePath } of rafPending.files) {
            let original;
            try { original = await readFileOrBuffer(filePath); } catch (e) { skipped.push({ filePath, reason: e.message }); continue; }
            let count = 0;
            const updated = original.replace(new RegExp(source, flags), () => { count++; return replacement; });
            if (count === 0) continue;
            totalReplacements += count;
            committed.push({ filePath, replacements: count });
            const openEditor = atom.workspace.getTextEditors().find(e => e.getPath() && path.resolve(e.getPath()) === path.resolve(filePath));
            try {
              if (openEditor) openEditor.getBuffer().setTextViaDiff(updated);
              else await fs.promises.writeFile(filePath, updated, "utf8");
            } catch (e) {
              skipped.push({ filePath, reason: `write failed: ${e.message}` });
            }
          }

          // Clear pending store after commit
          rafPending.key = null;
          rafPending.files = [];

          bump('replace_across_files', 'hits');
          if (skipped.length > 0) bump('replace_across_files', 'fails.skipped', skipped.length);

          return {
            content: [{ type: "text", text: JSON.stringify({
              summary: `✅ Committed — replaced ${totalReplacements} occurrence(s) across ${committed.length} file(s).`,
              totalReplacements, filesAffected: committed.length, files: committed,
              skipped: skipped.length > 0 ? skipped : undefined,
            }, null, 2) }],
            totalReplacements, filesAffected: committed.length
          };
        }

        // ── PREVIEW PATH ───────────────────────────────────────────────────────
        const flags  = caseSensitive ? "g" : "gi";
        const source = regex ? query : escapeRegex(query);
        let _pattern;
        try { _pattern = new RegExp(source, flags); }
        catch (e) { throw new Error(`Invalid regex: ${e.message}`); }

        let allFiles = [];
        for (const root of roots) allFiles = allFiles.concat(await walkDir(root));
        if (glob) { const globRe = globToRegex(glob); allFiles = allFiles.filter(f => globRe.test(f.replace(/\\/g, "/"))); }
        allFiles = allFiles.filter(f => !BINARY_EXTS.has(f.split(".").pop().toLowerCase()));

        const results = [];
        const skipped = [];
        let totalMatches = 0;
        let capped = false;

        outer:
        for (const filePath of allFiles) {
          let text;
          try { text = await readFileOrBuffer(filePath); } catch (e) { skipped.push({ filePath, reason: e.message }); continue; }

          const lines = text.split(/\r?\n/);
          const fileMatches = [];

          for (let i = 0; i < lines.length; i++) {
            // reset lastIndex for each line test with global flag
            const linePattern = new RegExp(source, caseSensitive ? "g" : "gi");
            if (linePattern.test(lines[i])) {
              totalMatches++;
              if (totalMatches > maxMatches) { capped = true; break outer; }
              const before = lines.slice(Math.max(0, i - contextLines), i)
                .map((t, j) => ({ line: Math.max(1, i - contextLines + 1) + j, text: t }));
              const after  = lines.slice(i + 1, i + 1 + contextLines)
                .map((t, j) => ({ line: i + 2 + j, text: t }));
              fileMatches.push({ line: i + 1, text: lines[i], before, after });
            }
          }

          if (fileMatches.length > 0) {
            results.push({ filePath, matchCount: fileMatches.length, matches: fileMatches });
          }
        }

        if (capped) {
          bump('replace_across_files', 'dryRuns');
          return {
            content: [{ type: "text", text: JSON.stringify({
              summary: `⚠️ Match cap hit (${maxMatches}). Too many matches to safely preview — narrow the scope with glob or a more specific query, or raise maxMatches if you're sure.`,
              totalMatches: `>${maxMatches}`, capped: true, filesSearched: allFiles.length,
            }, null, 2) }]
          };
        }

        // Store pending for confirm
        const pendingKey = `${query}||${replacement}||${glob}||${regex}||${caseSensitive}`;
        rafPending.key = pendingKey;
        rafPending.files = results.map(r => ({ filePath: r.filePath }));

        bump('replace_across_files', 'dryRuns');
        if (skipped.length > 0) bump('replace_across_files', 'fails.skipped', skipped.length);

        const summary = totalMatches === 0
          ? `No matches found for ${JSON.stringify(query)}${glob ? ` in ${glob}` : ""}.`
          : `Preview: ${totalMatches} match(es) across ${results.length} file(s). Call again with confirm:true to commit.`;

        return {
          content: [{ type: "text", text: JSON.stringify({
            summary, totalMatches, filesAffected: results.length,
            replacement,
            files: results,
            skipped: skipped.length > 0 ? skipped : undefined,
          }, null, 2) }],
          totalMatches, filesAffected: results.length
        };
      }
    );
  }

  {
    const curTool = "replace-function-body";
    server.registerTool(curTool,
      {
        title: "Replace Function Body",
        description: [
          "Replace a named function's entire signature and body atomically in the active editor.",
          "USE THIS INSTEAD OF str_replace when you need to rewrite a whole function — it finds the function by name, removes from signature to closing brace, and inserts newBody in one step. No risk of partial match or line drift.",
          "name — the function name (just the name, not the full signature). newBody — the complete replacement including the signature line and all braces.",
          "DISAMBIGUATION: if the same function name appears in multiple places (e.g. declaration + definition), use afterHint or lineHint to identify which one to target. occurrence:N also works.",
          "dryRun:true — previews which function will be matched (shows its current line range) without writing. Use this first when unsure.",
          "WORKFLOW: use read-lines with functionHint first to read the current function, make your changes, then call replace-function-body with newBody. This ensures you have the exact current signature.",
          "lint:true — appends live linter diagnostics for the replaced region after the edit."
        ].join(" "),
        inputSchema: {
          name:    z.string(),
          newBody: z.string(),
          ...ANCHOR_SCHEMA
        }
      },
      async ({ name, newBody, dryRun = false, occurrence = 1, functionHint, afterHint, lineHint, betweenHint, fuzzyWhitespace, lint = false }) => {
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

        // ── Ambiguity check — count functions with this name in the file ──────
        {
          const _isCode = isCodeFilePath(editor.getPath());
          const _noScope = !functionHint && !afterHint && !betweenHint && !lineHint && occurrence <= 1;
          if (_noScope) {
            // Count occurrences of `name(` pattern as a proxy for duplicate function names
            const sigRe = new RegExp("(?:^|\\s)" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\(", "g");
            const sigMatches = [];
            let m;
            while ((m = sigRe.exec(buffer.getText())) !== null) {
              sigMatches.push(buffer.getText().substring(0, m.index).split("\n").length);
              if (sigMatches.length > 20) break;
            }
            if (sigMatches.length > 1) {
              bump('replace_function_body', 'fails.notFound');
              return { content: [{ type: "text", text: [
                `⚠️  AMBIGUOUS — function name "${name}" appears ${sigMatches.length}+ times in file (lines: ${sigMatches.join(", ")}).`,
                `   This could be overloads, callbacks, or nested helpers with the same name.`,
                `   Use occurrence:N to target a specific definition, or add a scoping hint:`,
                `   • afterHint:"string"       → start search after a unique context line`,
                `   • betweenHint:{start,end}  → restrict to a region`,
                `   • occurrence:N             → target the Nth definition (1=${sigMatches[0]}, 2=${sigMatches[1] || "?"}, ...)`,
              ].join("\n") }], found: false, ambiguous: true, matchAtLines: sigMatches };
            }
          }
        }
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
        const _lintSuffix = await maybeLintSuffix(lint, editor, startRow, startRow + newBody.split("\n").length - 1);
        const _styleSuffix = applyStyleCheck(newBody, editor.getPath());
        bump('replace_function_body', 'hits');
        return {
          content: [{ type: "text", text: [
            `✅ Replaced function "${name}". Old lines: ${startRow + 1}–${endRow + 1}. Inserted ${insertedLines} lines starting at ${startRow + 1}. New total: ${newLineCount}.`,
            signatureChanged ? " ⚠️  WARNING: signature appears changed — verify this was intentional." : "",
            _lintSuffix,
            _styleSuffix
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
          catch (err) { throw new Error(`Cannot read file: ${filePath} — ${err.message}`); }
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

        const fnRe      = /^(?:(?:static|inline|extern|const|unsigned|signed|struct|enum)\s+)*[\w\s*]+\b(?!if|for|while|switch|return|else|do\b)(\w+)\s*\([^;)]*\)\s*(?:\{|$)/;
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
        const fnRe = /^(?:(?:static|inline|extern|const|unsigned|signed|long|short|struct|enum|void)\s+)*[\w\s*]+\b(?!if|for|while|switch|return|else|do\b)(\w+)\s*\([^;)]*\)\s*(?:\{|$)/;

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
    server.registerTool(curTool,
      {
        title: "Grep File",
        description: [
          "Search a file for a string or regex and return every matching line with its 1-based line number.",
          "PRIMARY USE: locate content in a file to get line numbers before making edits with str_replace or read-lines. Far cheaper than read-file — only matched lines are returned.",
          "filePath — search any project file. Omit to search the active editor. Reads from the live buffer if the file is open (unsaved edits are included).",
          "contextLines:N — return N lines before and after each match, like grep -C. Each match result includes 'before' and 'after' arrays. Use this to verify the surrounding context before editing.",
          "occurrence:N — return only the Nth match with its context. Use this when you know which specific instance you want (e.g. the 3rd call to a function) — tells you the exact line number to pass to str_replace lineHint or read-lines.",
          "regex:true — treat query as a regular expression. caseSensitive:false — case-insensitive matching (default is case-sensitive).",
          "Returns matchCount. If results exceed maxMatches, results are truncated and a truncation flag is set."
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

        if (occurrence > 0 && matches.length === 0) {
          bump('grep_file', 'fails.noMatch');
          throw new Error(`occurrence ${occurrence} not found — only ${globalIndex} match(es) in file.`);
        }
        if (matches.length === 0) bump('grep_file', 'fails.noMatch');
        else {
          bump('grep_file', 'hits');
          if (occurrence > 0) bump('grep_file', 'hintsUsed.occurrence');
          if (contextLines > 0) bump('grep_file', 'hintsUsed.contextLines');
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
    server.registerTool(curTool,
      {
        title: "Grep Project",
        description: [
          "Search for a string or regex across all project files and return every match with file path and 1-based line number.",
          "PRIMARY USE: find where a symbol, pattern, or string is defined or used when you don't know which file it's in. Follow up with grep-file or read-lines on the specific file once you've located it.",
          "glob — restrict to a file pattern e.g. '**/*.js' or 'src/**/*.c'. Use this to avoid searching unrelated files.",
          "contextLines:N — return N lines before and after each match. Use this to understand the surrounding code, not just the match line.",
          "occurrence:N — return only the Nth match across the entire search. Useful when you know which specific instance you want.",
          "regex:true — treat query as a regular expression. caseSensitive:false — case-insensitive matching.",
          "Results capped at maxMatches (default 200). Returns truncation flag when capped — use glob to narrow scope if truncated."
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

        if (occurrence > 0 && matches.length === 0) {
          bump('grep_project', 'fails.noMatch');
          throw new Error(`occurrence ${occurrence} not found — only ${globalIndex} match(es) in project.`);
        }
        if (matches.length === 0) bump('grep_project', 'fails.noMatch');
        else {
          bump('grep_project', 'hits');
          if (occurrence > 0) bump('grep_project', 'hintsUsed.occurrence');
          if (contextLines > 0) bump('grep_project', 'hintsUsed.contextLines');
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
    server.registerTool(curTool,
      {
        title: "Read Lines",
        description: [
          "Read a section of any file without opening it. PREFERRED over read-file for large files — only loads the lines you need.",
          "DECISION — how to specify what to read:",
          "(1) Know the function name? → functionHint:'myFn' — extracts the complete function body (signature + all lines to closing brace). Works for JS, C, and any brace-delimited language. Most reliable mode.",
          "(2) Know a unique string just before the section? → afterHint:'anchor text' — starts reading at the line after the anchor. Combine with endLine or radius to bound the end.",
          "(3) Know text at both the start and end of the region? → betweenHint:{start:'...', end:'...'} — reads from the start anchor line to the end anchor line.",
          "(4) Have a line number and want context around it? → lineHint:42 (defaults to radius:10, i.e. 10 lines above and below) or centerLine:42 with radius:N.",
          "(5) Know exact start and end line numbers? → startLine + endLine.",
          "filePath — read any project file. Omit to read the active editor. Live buffer is used if the file is open (unsaved edits included).",
          "Returns lines with their original 1-based line numbers — use them directly as lineHint in str_replace or startLine/endLine in delete-line-range."
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
        let resolvedStart, resolvedEnd, _hintLabel = "";

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
          _hintLabel     = ` [functionHint:"${functionHint}" lines ${resolvedStart}–${resolvedEnd}]`;

        } else if (betweenHint) {
          const startIdx = text.indexOf(betweenHint.start);
          if (startIdx === -1) throw new Error(`betweenHint.start "${betweenHint.start}" not found in file.`);
          const endIdx = text.indexOf(betweenHint.end, startIdx + betweenHint.start.length);
          if (endIdx === -1) throw new Error(`betweenHint.end "${betweenHint.end}" not found after start anchor.`);
          resolvedStart = text.substring(0, startIdx).split("\n").length;
          resolvedEnd   = text.substring(0, endIdx).split("\n").length;
          _hintLabel     = ` [betweenHint lines ${resolvedStart}–${resolvedEnd}]`;

        } else if (afterHint) {
          const anchorIdx = text.indexOf(afterHint);
          if (anchorIdx === -1) throw new Error(`afterHint "${afterHint}" not found in file.`);
          resolvedStart = text.substring(0, anchorIdx).split("\n").length + 1;
          // endLine or radius pins the end; defaults to +20 if neither provided
          const r = radius !== undefined ? radius : 20;
          resolvedEnd   = endLine !== undefined ? endLine : resolvedStart + r - 1;
          _hintLabel     = ` [afterHint "${afterHint.substring(0, 40)}" line ${resolvedStart}]`;

        } else if (centerLine !== undefined || lineHint !== undefined) {
          const center = centerLine !== undefined ? centerLine : lineHint;
          const r      = radius !== undefined ? radius : 10;
          resolvedStart = Math.max(1, center - r);
          resolvedEnd   = Math.min(lineCount, center + r);
          _hintLabel     = ` [centerLine:${center} radius:${r}]`;

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
        if (functionHint)                              bump('read_lines', 'hintsUsed.functionHint');
        else if (betweenHint)                          bump('read_lines', 'hintsUsed.betweenHint');
        else if (afterHint)                            bump('read_lines', 'hintsUsed.afterHint');
        else if (lineHint !== undefined)               bump('read_lines', 'hintsUsed.lineHint');
        else if (centerLine !== undefined)             bump('read_lines', 'hintsUsed.lineHint'); // centerLine maps to same bucket
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
          dryRun:        z.boolean().optional(),
          lint:          z.boolean().optional()
        }
      },
      async ({ query, replacement, regex = false, caseSensitive = false, dryRun = false, lint = false }) => {
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
          bump('replace_all', 'fails.noMatch');
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
        const _styleSuffix = applyStyleCheck(replacement, editor.getPath());
        const _lintSuffix = await maybeLintSuffix(lint, editor, null, null);
        return {
          content: [{ type: "text", text: `✅ Replaced all ${matchCount} occurrence${matchCount === 1 ? "" : "s"} of ${JSON.stringify(query)}.${_styleSuffix}${_lintSuffix}` }],
          matchCount, dryRun: false
        };
      }
    );
  }

  } // end EDIT GROUP (part 2)

  // ── get-structural-anchors ────────────────────────────────────────────────
  {
    const curTool = "get-structural-anchors";
    server.registerTool(
      curTool,
      {
        title: "Get Structural Anchors",
        description: [
          "List the named structural anchors available in the active file. Call this before using sectionHint, preprocBlock, or functionEnd to discover the exact names to pass.",
          "Returns three categories:",
          "sectionHint names — section banner comments (e.g. '// ── INIT ──'). Pass the keyword to sectionHint in insert or delete-block.",
          "preprocBlock names — #ifdef/#ifndef macro names. Pass the macro name to preprocBlock in insert or delete-block.",
          "functionEnd names — function names and their closing-brace line numbers. Pass the function name to functionEnd in insert to add code immediately after a function.",
          "filePath — optionally query a file other than the active editor.",
          "TYPICAL WORKFLOW: call get-structural-anchors → pick a name → pass it to insert (functionEnd/sectionHint) or delete-block (sectionHint/preprocBlock)."
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
          try { text = await readFileOrBuffer(filePath); }
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
        const _fnRe = /(?:^|\s)(\w+)\s*\([^)]*\)\s*$/;
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
          dryRun: z.boolean().optional(),
          lint:   z.boolean().optional()
        }
      },
      async ({ expression, functionHint, dryRun = false, lint = false }) => {
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
          parts.push(smartSuggestion({ toolName: "sed", counter: sedFailures, noHintsUsed: !functionHint, fileLines: lineCount, oldStr: expression, isCodeFile: isCodeFilePath(editor.getPath()) }));
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
        const _lintSuffix = await maybeLintSuffix(lint, editor, null, null);
        return {
          content: [{ type: "text", text: [
            `✅ sed: ${matchCount} match(es) applied${linesDeleted ? `, ${linesDeleted} line(s) deleted` : ""}${scopeLabel}.`,
            `\nChanges:\n${preview}`,
            _lintSuffix
          ].filter(Boolean).join("") }],
          applied: true, matchCount, linesDeleted
        };
      }
    );
  }

  // ── FILE-OPS GROUP (part 4: file-line-count) ─────────────────────────────
  if (g('fileOps')) {
  {
    const curTool = "file-line-count";
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
    server.registerTool(curTool,
      {
        title: "Apply Patch",
        description: [
          "Apply a unified diff patch to the active editor. USE THIS for edits that touch multiple scattered locations in a file — more efficient than multiple str_replace calls.",
          "Patch format: standard unified diff with @@ hunk headers and +/- lines. Include 3 unchanged context lines around each change for reliable anchoring.",
          "@@ line numbers are hints only — the tool searches nearby if the file has shifted, so it survives minor line drift. @@ line counts are auto-corrected.",
          "FUZZY RESCUE: if a hunk fails to apply, the tool automatically tries fuzzy/indent-aware matching and shows a corrected diff preview. Reply with apply-patch({ confirm:true }) to apply the rescued version without resending the patch.",
          "dryRun:true — validates the patch and reports what would change without writing. Use this first on any non-trivial patch.",
          "LARGE EDIT NOTE: for edits touching more than ~30% of the file, replace-document or replace-function-body will be cheaper in tokens than a large patch.",
          "Returns linesAdded, linesRemoved, hunksApplied, and a diff of the actual change."
        ].join(" "),
        inputSchema: {
          patch:       z.string().optional(),
          dryRun:      z.boolean().optional(),
          fuzzFactor:  z.number().optional(),
          confirm:     z.boolean().optional(),
          lint:        z.boolean().optional(),
        }
      },
      async ({ patch = "", dryRun = false, fuzzFactor = 0, confirm = false, lint = false }) => {
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
          const _diffHunks = diffLines(buffer.getText(), newText);
          dbg(curTool, "CONFIRM APPLY — rescue patch committed", { hunks: rescued.length });

          bump('apply_patch', 'hits');
          const _lintSuffix = await maybeLintSuffix(lint, editor, null, null);
          return { content: [{ type: "text", text: [
            `✅ Rescued patch applied — ${rescued.length} hunk(s) committed.`,
            rescued.map((rh, i) => `  Hunk ${i + 1}: at line ${rh.startRow + 1}${rh.strategyNote}`).join("\n"),
            _lintSuffix
          ].filter(Boolean).join("\n") }], applied: true, hunksApplied: rescued.length };
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
          const hunkRe  = /^@@[^@]*@@[^\n]*\n([\s\S]*?)(?=\n@@|\n---|\n\+\+\+|(?![\s\S]))/gm;
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
              smartSuggestion({ toolName: "apply-patch", counter: patchFailures, noHintsUsed: true, fileLines: bufLines.length, oldStr: null, isCodeFile: isCodeFilePath(editor.getPath()) })
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
              // Insert + lines immediately after the last consecutive del line
              if (isDel) {
                const nextAbs = abs + 1;
                const nextIsDel = rh.delLines.some(dl => bufLines[nextAbs] && bufLines[nextAbs].trim() === dl.trim());
                if (!nextIsDel) {
                  rh.addLines.forEach(al => previewLines.push(`     + ${al}`));
                }
              }
            });
            // Fallback: if no del lines found, append + lines at end of context
            const anyDel = bufLines.slice(cs, ce + 1).some((l, i) =>
              rh.delLines.some(dl => bufLines[cs + i] && bufLines[cs + i].trim() === dl.trim()));
            if (!anyDel) rh.addLines.forEach(al => previewLines.push(`     + ${al}`));
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

          parts.push(smartSuggestion({ toolName: "apply-patch", counter: patchFailures, noHintsUsed: true, fileLines: bufLines.length, oldStr: null, isCodeFile: isCodeFilePath(editor.getPath()) }));
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
          let _lineNo = 1;
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

        const _lintSuffix = await maybeLintSuffix(lint, editor, null, null);
        const _addedText = hunks.filter(h => h.added).map(h => h.value).join("\n");
        const _styleSuffix = _addedText ? applyStyleCheck(_addedText, editor.getPath()) : "";
        return {
          content: [{ type: "text", text: `Patch applied. ${hunkCount} hunk(s), +${linesAdded}/-${linesRemoved} lines. New line count: ${newLineCount}.${largeEditWarning}${_lintSuffix}${_styleSuffix}` }],
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
    const curTool = "get-compiler-diagnostics";

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
        title: "Get Compiler Diagnostics",
        description: [
          "Syntax-check the active C/C++ file (or all project C/C++ files) using the compiler directly.",
          "Automatically detects gcc, clang, or cl (MSVC) depending on platform.",
          "scope: 'file' (default) checks only the active file; 'project' checks all .c/.cpp files.",
          "compilerOptions: extra flags passed to the compiler (e.g. '-std=c11 -DDEBUG').",
          "Each result includes severity, file, line, column, message, and the compiler used.",
          "IMPORTANT: Runs the compiler on the SAVED file — always call save-file first.",
          "For live buffer diagnostics without saving, use get-diagnostics (linter-bundle) instead."
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

  // ── get-diagnostics (linter-bundle) ─────────────────────────────────────────
  {
    const curTool = "get-diagnostics";
    server.registerTool(
      curTool,
      {
        title: "Get Diagnostics",
        description: [
          "Return live linter diagnostics (errors, warnings, info) from linter-bundle.",
          "Live on the buffer — linter-bundle re-runs on every buffer change (debounced ~300ms), no save-file needed.",
          "Works for any language with a linter provider installed (JS, TS, C, C++, and others).",
          "Returns [] gracefully if linter-bundle is not active — no error.",
          "scope: 'file' (default) returns messages for the active editor only;",
          "'project' returns all messages across all open files.",
          "Each message includes severity, excerpt, linterName, file, and range (1-based line/col).",
          "For compiler-level C/C++ checks on the saved file, use get-compiler-diagnostics instead."
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
    server.registerTool(curTool,
      {
        title: "Checkpoint",
        description: [
          "Save a named snapshot of the current buffer so edits can be rolled back with restore-checkpoint.",
          "name defaults to 'default'. Checkpoints are in-memory and cleared on server restart. WARNING: if this MCP server's own source files (mcp-registration.js, pulsar-edit-mcp-server.js) are edited and saved, Pulsar will reload the package and restart the server — all checkpoints will be lost immediately. Always save test files to disk with save-file as an additional safety net before editing server source.",
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
    server.registerTool(curTool,
      {
        title: "Search Symbol",
        description: [
          "Find all uses of a C/C++ symbol (function name, variable, macro) across the project using whole-word matching.",
          "USE THIS INSTEAD OF grep-project when searching for a symbol name — it automatically wraps the query in word boundaries so 'init' won't match 'initialize' or 'reinit'. Returns file path, line number, and line text for every match.",
          "definitionsOnly:true — filter results to lines that look like definitions or declarations (function signatures, variable declarations). Use this to find where a symbol is defined rather than called.",
          "contextLines:N — return N lines before and after each match. Use this to understand the code around each use.",
          "occurrence:N — return only the Nth match across the entire search with its context. Use this to get the exact file and line of a specific instance.",
          "glob — restrict to a file pattern (default: '**/*.{c,cpp,h,hpp}'). Change to '**/*.js' etc for other languages.",
          "Results capped at maxMatches (default 200)."
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

        if (occurrence > 0 && matches.length === 0) {
          bump('search_symbol', 'fails.noMatch');
          throw new Error(`occurrence ${occurrence} not found — only ${globalIndex} match(es) in project.`);
        }
        if (matches.length === 0) bump('search_symbol', 'fails.noMatch');
        else {
          bump('search_symbol', 'hits');
          if (occurrence > 0) bump('search_symbol', 'hintsUsed.occurrence');
          if (contextLines > 0) bump('search_symbol', 'hintsUsed.contextLines');
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ symbol, matchCount: matches.length, truncated, matches }, null, 2) }],
          matchCount: matches.length, truncated
        };
      }
    );
  }
  {
    const curTool = "get-repo-map";
    server.registerTool(curTool,
      {
        title: "Get Repo Map",
        description: [
          "Return a compact Aider-style repo map — function signatures grouped by file, ranked by PageRank importance, rendered with │ prefix and ⋮... ellipsis between non-consecutive lines.",
          "USE THIS as the first call on an unfamiliar codebase to understand its structure without reading individual files.",
          "Uses tree-sitter (via open Pulsar editors) for accurate symbol extraction; falls back to regex for closed files.",
          "Output fits within a token budget (default 1024 tokens ≈ 4096 chars). Binary search finds the most symbols that fit.",
          "glob — restrict to a file pattern e.g. '**/*.c' or 'src/**/*.js'. Defaults to all C/C++/JS/TS files.",
          "excludeGlob — exclude files matching a pattern e.g. 'test/**' or '**/*.test.js'. Applied after glob.",
          "maxTokens — token budget for output (default 1024). Increase for large projects.",
          "minRefs — only include symbols referenced from at least this many other files (default 0 = include all).",
          "mentionedFiles — array of file paths (relative or absolute) to boost in PageRank personalisation.",
          "includeLineNumbers — include line number annotation in output (default true).",
        ].join(" "),
        inputSchema: {
          glob:               z.string().optional(),
          excludeGlob:        z.string().optional(),
          maxTokens:          z.number().optional(),
          minRefs:            z.number().optional(),
          mentionedFiles:     z.array(z.string()).optional(),
          includeLineNumbers: z.boolean().optional(),
        }
      },
      async ({ glob = "", excludeGlob = "", maxTokens = 1024, minRefs = 0, mentionedFiles = [], includeLineNumbers = true } = {}) => {
        const roots = atom.project.getPaths();
        if (!roots.length) {
          bump('get_repo_map', 'fails.noProject');
          return { content: [{ type: "text", text: "No project root open." }] };
        }

        // ── 1. Collect files ────────────────────────────────────────────────
        const effectiveGlob = glob || "**/*.{c,cpp,cc,cxx,h,hpp,js,ts,jsx,tsx}";
        const globRe = globToRegex(effectiveGlob);
        let allFiles = [];
        for (const root of roots) allFiles = allFiles.concat(await walkDir(root));
        allFiles = allFiles.filter(f => globRe.test(f.replace(/\\/g, "/")));
        if (excludeGlob) {
          const excludeRe = globToRegex(excludeGlob);
          allFiles = allFiles.filter(f => !excludeRe.test(f.replace(/\\/g, "/")));
        }

        // ── 2. Extract symbols — tree-sitter for open editors, regex fallback ──
        const cFnRe  = /^(?:(?:static|inline|extern|const|unsigned|signed|long|short|struct|enum|void|export|async|function)\s+)*[\w\s*]+\b(?!if|for|while|switch|return|else|do\b)(\w+)\s*\([^;)]*\)\s*(?:\{|$)/;
        const jsFnRe = /(?:^|\s)(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\()|(?:^|\s)class\s+(\w+)/;

        // Map open editors by forward-slash path for tree-sitter access
        const openEditors = new Map();
        for (const ed of atom.workspace.getTextEditors()) {
          const p = ed.getPath();
          if (p) openEditors.set(p.replace(/\\/g, "/"), ed);
        }

        // Normalise mentionedFiles to forward-slash paths
        const projectRoot = roots[0].replace(/\\/g, "/");
        const mentionedSet = new Set(mentionedFiles.map(f => {
          const fwd = f.replace(/\\/g, "/");
          return (fwd.startsWith("/") || /^[A-Za-z]:/.test(fwd)) ? fwd : projectRoot + "/" + fwd;
        }));

        // symbols: { filePath, line, name, sig, refs, score }
        const symbols = [];

        async function extractSymbols(filePath) {
          const fpFwd = filePath.replace(/\\/g, "/");
          const ed = openEditors.get(fpFwd);
          if (ed) {
            try {
              const langMode = ed.getBuffer().getLanguageMode();
              const layer    = langMode.rootLanguageLayer;
              const tree     = layer?.tree;
              const tq       = layer?.tagsQuery;
              if (tree && tq) {
                const captures = tq.captures(tree.rootNode);
                const defs = {};
                for (const cap of captures) {
                  if (cap.name.startsWith("definition.")) {
                    defs[cap.node.id] = { startRow: cap.node.startPosition.row };
                  }
                }
                for (const cap of captures) {
                  if (cap.name === "name") {
                    const parent = cap.node.parent;
                    if (parent && defs[parent.id]) {
                      const row = defs[parent.id].startRow;
                      const sig = ed.lineTextForBufferRow(row) || cap.node.text;
                      symbols.push({ filePath, line: row + 1, name: cap.node.text, sig: sig.trimEnd(), refs: 0, score: 0 });
                    }
                  }
                }
                return;
              }
            } catch (_e) { /* fall through to regex */ }
          }
          let txt;
          try { txt = await fs.promises.readFile(filePath, "utf8"); } catch { return; }
          const lines = txt.split(/\r?\n/);
          const isJs  = /\.(js|ts|jsx|tsx)$/.test(filePath);
          for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (l.trim().startsWith("//") || l.trim().startsWith("*")) continue;
            let name = null;
            const m = isJs ? jsFnRe.exec(l) : cFnRe.exec(l);
            if (m) name = isJs ? (m[1] || m[2] || m[3]) : m[1];
            if (name && name.length > 1) {
              symbols.push({ filePath, line: i + 1, name, sig: l.trimEnd(), refs: 0, score: 0 });
            }
          }
        }

        for (const fp of allFiles) await extractSymbols(fp);

        // ── 3. Build file→file reference graph for PageRank ────────────────
        const fileTexts = {};
        for (const fp of allFiles) {
          try { fileTexts[fp] = await fs.promises.readFile(fp, "utf8"); } catch { /* skip */ }
        }

        // Count cross-file refs per symbol
        for (const sym of symbols) {
          const wordRe = new RegExp(`\\b${escapeRegex(sym.name)}\\b`, "g");
          for (const [fp, txt] of Object.entries(fileTexts)) {
            if (fp === sym.filePath) continue;
            sym.refs += (txt.match(wordRe) || []).length;
          }
        }

        // Group symbols by definer file
        const symsByFile = new Map();
        for (const sym of symbols) {
          if (!symsByFile.has(sym.filePath)) symsByFile.set(sym.filePath, []);
          symsByFile.get(sym.filePath).push(sym);
        }

        // Build edge list: [srcFile, dstFile, sqrt(refCount)]
        const nodes = [...symsByFile.keys()];
        const edgeAccum = new Map();
        for (const sym of symbols) {
          if (sym.refs === 0) continue;
          const wordRe = new RegExp(`\\b${escapeRegex(sym.name)}\\b`, "g");
          for (const srcFp of allFiles) {
            if (srcFp === sym.filePath) continue;
            const txt = fileTexts[srcFp];
            if (!txt) continue;
            const cnt = (txt.match(wordRe) || []).length;
            if (cnt === 0) continue;
            const key = `${srcFp}\x00${sym.filePath}`;
            edgeAccum.set(key, (edgeAccum.get(key) || 0) + Math.sqrt(cnt));
          }
        }
        const edges = [...edgeAccum.entries()].map(([k, w]) => {
          const nul = k.indexOf("\x00");
          return [k.slice(0, nul), k.slice(nul + 1), w];
        });

        // Personalised PageRank power-iteration
        const d = 0.85, iters = 20;
        const pLen = nodes.length || 1;
        const personalization = {};
        for (const n of nodes) personalization[n] = mentionedSet.has(n.replace(/\\/g, "/")) ? 50 / pLen : 1 / pLen;
        const pSum = Object.values(personalization).reduce((a, b) => a + b, 0);
        for (const n of nodes) personalization[n] /= pSum;
        let rank = { ...personalization };
        const outW = {};
        for (const [src, , w] of edges) outW[src] = (outW[src] || 0) + w;
        for (let i = 0; i < iters; i++) {
          const nr = {};
          for (const n of nodes) nr[n] = (1 - d) * personalization[n];
          for (const [src, dst, w] of edges) {
            if (!outW[src]) continue;
            nr[dst] = (nr[dst] || 0) + d * rank[src] * w / outW[src];
          }
          rank = nr;
        }

        // Assign per-symbol score from file rank weighted by ref share
        for (const [fp, syms] of symsByFile) {
          const fileRank = rank[fp] || 0;
          const totalRefs = syms.reduce((s, x) => s + x.refs, 0) || 1;
          for (const sym of syms) sym.score = fileRank * (sym.refs / totalRefs);
        }

        // ── 4. Sort files by rank, filter by minRefs ────────────────────────
        const sortedFiles = [...symsByFile.entries()]
          .filter(([, syms]) => syms.some(s => s.refs >= minRefs))
          .sort((a, b) => (rank[b[0]] || 0) - (rank[a[0]] || 0));

        // ── 5. Token-budget binary search + TreeContext rendering ───────────
        const charBudget = maxTokens * 4; // ~4 chars/token

        function renderMap(fileList, symsPerFile) {
          const out = [];
          let symCount = 0;
          for (const [fp, syms] of fileList) {
            const eligible = syms
              .filter(s => s.refs >= minRefs)
              .sort((a, b) => b.score - a.score || a.line - b.line)
              .slice(0, Math.max(1, symsPerFile));
            if (!eligible.length) continue;
            eligible.sort((a, b) => a.line - b.line); // TreeContext: sort by line for rendering
            const rel = fp.replace(/\\/g, "/").replace(projectRoot + "/", "");
            out.push(rel + ":");
            let prevLine = -1;
            for (const s of eligible) {
              if (prevLine !== -1 && s.line > prevLine + 1) out.push("⋮...");
              const lineTag = includeLineNumbers ? ` // L${s.line}` : "";
              out.push(`│${s.sig}${lineTag}`);
              prevLine = s.line;
              symCount++;
            }
            out.push("");
          }
          return { text: out.join("\n"), symCount };
        }

        const maxPerFile = Math.max(1, ...sortedFiles.map(([, s]) => s.length));
        let lo = 1, hi = maxPerFile;
        let best = renderMap(sortedFiles, hi);
        if (best.text.length > charBudget) {
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            const r = renderMap(sortedFiles, mid);
            if (r.text.length <= charBudget) { lo = mid; best = r; }
            else hi = mid - 1;
          }
          best = renderMap(sortedFiles, lo);
        }

        const summary = `${best.symCount} symbol(s) across ${sortedFiles.length} file(s)` +
          (minRefs > 0 ? `, minRefs≥${minRefs}` : "") +
          `, ~${Math.round(best.text.length / 4)} tokens`;

        bump('get_repo_map', 'hits');
        return {
          content: [{ type: "text", text: `// Repo map — ${summary}\n\n${best.text}` }],
          symbolCount: best.symCount, fileCount: sortedFiles.length,
        };
      }
    );
  }

  } // end SEARCH GROUP (part 2)

  // ── GHIDRA GROUP ────────────────────────────────────────────────────────────
  if (g('ghidra')) {

  const GHIDRA_FUNC_RE = /^[\w\s\*]+?\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?\s*$/;
  const GHIDRA_SKIP_KW = new Set([
    'if','else','while','for','switch','do','return','sizeof',
    'typedef','struct','enum','union'
  ]);

  /* Resolve a function start row by name + optional occurrence:N.
   * Returns 0-based row index or -1 if not found. */
  function ghidraFindFn(lines, name, occurrence = 1) {
    const pat = new RegExp(
      `^[\\w\\s\\*]+?\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`
    );
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      if (pat.test(lines[i]) && !/;\s*$/.test(lines[i])) {
        count++;
        if (count === occurrence) return i;
      }
    }
    return -1;
  }

  {
    const curTool = "list-functions";
    server.registerTool(curTool, {
      title: "List Functions",
      description: [
        "List all function definitions in the active C file with their names and line numbers.",
        "Works with Ghidra-decompiled output (FUN_xxxxxxxx style names) and standard C.",
        "Workflow hint: Use open-file first to make sure the right file is active.",
      ].join(" "),
      inputSchema: {
        includeUnnamed: z.boolean().optional(),
      }
    }, async ({ includeUnnamed = true } = {}) => {
      const editor = atom.workspace.getActiveTextEditor();
      if (!editor) { bump('ghidra_list_functions', 'fails.noEditor'); throw new Error("No active editor"); }
      const lines = editor.getText().split(/\r?\n/);
      const results = [];
      lines.forEach((line, i) => {
        if (/^\s*(#|\/\/|\/\*|\*)/.test(line) || /^\s*$/.test(line)) return;
        const m = line.match(GHIDRA_FUNC_RE);
        if (!m) return;
        const name = m[1];
        if (GHIDRA_SKIP_KW.has(name)) return;
        if (!includeUnnamed && /^FUN_|^sub_|^DAT_/.test(name)) return;
        results.push({ line: i + 1, name, preview: line.trim() });
      });
      bump('ghidra_list_functions', 'hits');
      if (results.length === 0)
        return { content: [{ type: "text", text: "No function definitions found." }] };
      return { content: [{ type: "text", text: JSON.stringify({ count: results.length, functions: results }, null, 2) }] };
    });
  }

  {
    const curTool = "search-functions";
    server.registerTool(curTool, {
      title: "Search Functions",
      description: [
        "Search for function definitions whose name matches a query string or regex.",
        "Returns name, line number, and the full signature line.",
        "Useful for finding FUN_8000* or all functions containing 'crypto', 'net', etc.",
      ].join(" "),
      inputSchema: {
        query:         z.string(),
        regex:         z.boolean().optional(),
        caseSensitive: z.boolean().optional(),
      }
    }, async ({ query, regex = false, caseSensitive = false }) => {
      const editor = atom.workspace.getActiveTextEditor();
      if (!editor) { bump('ghidra_search_functions', 'fails.noEditor'); throw new Error("No active editor"); }
      const lines = editor.getText().split(/\r?\n/);
      const flags = caseSensitive ? "" : "i";
      const searchPat = regex
        ? new RegExp(query, flags)
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
      const results = [];
      lines.forEach((line, i) => {
        if (/^\s*(#|\/\/|\/\*|\*)/.test(line)) return;
        const m = line.match(GHIDRA_FUNC_RE);
        if (!m) return;
        const name = m[1];
        if (GHIDRA_SKIP_KW.has(name)) return;
        if (searchPat.test(name)) results.push({ line: i + 1, name, signature: line.trim() });
      });
      if (results.length === 0) {
        bump('ghidra_search_functions', 'fails.noMatch');
        return { content: [{ type: "text", text: `No functions matching "${query}" found.` }] };
      }
      bump('ghidra_search_functions', 'hits');
      return { content: [{ type: "text", text: JSON.stringify({ count: results.length, functions: results }, null, 2) }] };
    });
  }

  {
    const curTool = "get-function-body";
    server.registerTool(curTool, {
      title: "Get Function Body",
      description: [
        "Extract the complete source code of a named function from the active C file.",
        "Returns the full body from signature to closing brace with line numbers.",
        "Works with Ghidra FUN_ names and standard C function names.",
        "Use occurrence:N when the same name appears multiple times (e.g. static helpers).",
      ].join(" "),
      inputSchema: {
        name:       z.string(),
        occurrence: z.number().int().min(1).optional(),
      }
    }, async ({ name, occurrence = 1 }) => {
      const editor = atom.workspace.getActiveTextEditor();
      if (!editor) { bump('ghidra_get_function_body', 'fails.noEditor'); throw new Error("No active editor"); }
      const lines = editor.getText().split(/\r?\n/);
      const startLine = ghidraFindFn(lines, name, occurrence);
      if (startLine === -1) {
        bump('ghidra_get_function_body', 'fails.notFound');
        const hint = occurrence > 1 ? ` (occurrence ${occurrence})` : "";
        return { content: [{ type: "text", text: `Function "${name}"${hint} not found. Use list-functions to see available names.` }] };
      }
      /* Walk forward tracking brace depth to find closing brace */
      let depth = 0, endLine = startLine, foundOpen = false;
      for (let i = startLine; i < lines.length; i++) {
        for (const ch of lines[i]) {
          if (ch === '{') { depth++; foundOpen = true; }
          else if (ch === '}') depth--;
        }
        if (foundOpen && depth === 0) { endLine = i; break; }
      }
      const body = lines.slice(startLine, endLine + 1).map((t, i) => ({ n: startLine + i + 1, text: t }));
      bump('ghidra_get_function_body', 'hits');
      return {
        content: [{ type: "text", text: JSON.stringify({
          name, startLine: startLine + 1, endLine: endLine + 1,
          lineCount: endLine - startLine + 1, body
        }, null, 2) }]
      };
    });
  }

  {
    const curTool = "get-xrefs";
    server.registerTool(curTool, {
      title: "Get Cross References",
      description: [
        "Find every call site of a named function in the active C file.",
        "Returns line numbers and the full calling line for each reference.",
        "Essential for understanding control flow in decompiled binaries.",
      ].join(" "),
      inputSchema: { name: z.string() }
    }, async ({ name }) => {
      const editor = atom.workspace.getActiveTextEditor();
      if (!editor) { bump('ghidra_get_xrefs', 'fails.noEditor'); throw new Error("No active editor"); }
      const lines = editor.getText().split(/\r?\n/);
      const callPat = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`, "g");
      const defPat  = new RegExp(`^[\\w\\s\\*]+?\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`);
      const results = [];
      lines.forEach((line, i) => {
        if (defPat.test(line) && !/;\s*$/.test(line)) return; /* skip definition */
        if (callPat.test(line)) results.push({ line: i + 1, context: line.trim() });
        callPat.lastIndex = 0;
      });
      if (results.length === 0) {
        bump('ghidra_get_xrefs', 'fails.noMatch');
        return { content: [{ type: "text", text: `No calls to "${name}" found.` }] };
      }
      bump('ghidra_get_xrefs', 'hits');
      return { content: [{ type: "text", text: JSON.stringify({ name, callCount: results.length, xrefs: results }, null, 2) }] };
    });
  }

  {
    const curTool = "add-comment";
    server.registerTool(curTool, {
      title: "Add Comment",
      description: [
        "Insert a block comment above a named function or at a specific line number.",
        "Use functionName to target a function by name, or lineNumber for a specific line.",
        "Use occurrence:N when the function name appears multiple times.",
        "Creates a /* ... */ style block comment above the target.",
      ].join(" "),
      inputSchema: {
        comment:      z.string(),
        functionName: z.string().optional(),
        lineNumber:   z.number().optional(),
        occurrence:   z.number().int().min(1).optional(),
      }
    }, async ({ comment, functionName, lineNumber, occurrence = 1 }) => {
      const editor = atom.workspace.getActiveTextEditor();
      if (!editor) { bump('ghidra_add_comment', 'fails.noEditor'); throw new Error("No active editor"); }

      /* Gate style checker off for Ghidra files — decompiled pseudocode violates every rule */
      const filePath = editor.getPath();
      const text = editor.getText();

      const buffer = editor.getBuffer();
      const lines = text.split(/\r?\n/);
      let targetRow = -1;

      if (functionName) {
        targetRow = ghidraFindFn(lines, functionName, occurrence);
        if (targetRow === -1) {
          bump('ghidra_add_comment', 'fails.notFound');
          const hint = occurrence > 1 ? ` (occurrence ${occurrence})` : "";
          return { content: [{ type: "text", text: `Function "${functionName}"${hint} not found. Use list-functions to see available names.` }] };
        }
      } else if (lineNumber != null) {
        targetRow = lineNumber - 1;
        if (targetRow < 0 || targetRow >= lines.length)
          throw new Error(`lineNumber ${lineNumber} is out of range (1-${lines.length})`);
      } else {
        throw new Error("Provide either functionName or lineNumber.");
      }

      const indent = (lines[targetRow].match(/^(\s*)/) || ["", ""])[1];
      const commentLines = comment.split(/\r?\n/);
      const block = commentLines.length === 1
        ? `${indent}/* ${comment} */\n`
        : `${indent}/*\n` + commentLines.map(l => `${indent} * ${l}`).join("\n") + `\n${indent} */\n`;

      buffer.insert([targetRow, 0], block);

      /* Only run style check on non-Ghidra C/H files */
      let styleSuffix = "";
      if (!isGhidraFile(filePath, text) && isCodeFilePath(filePath)) {
        styleSuffix = applyStyleCheck(block, filePath) || "";
      }

      bump('ghidra_add_comment', 'hits');
      return {
        content: [{ type: "text", text:
          `Comment inserted above line ${targetRow + 1}${functionName ? ` (function "${functionName}")` : ""}.`
          + (styleSuffix ? `\n${styleSuffix}` : "")
        }]
      };
    });
  }

  {
    const curTool = "get-function-list-with-comments";
    server.registerTool(curTool, {
      title: "Get Function List With Comments",
      description: [
        "List all functions with any existing comments above them.",
        "Shows reverse engineering progress at a glance —",
        "annotated functions vs unnamed FUN_ stubs.",
      ].join(" "),
      inputSchema: {}
    }, async () => {
      const editor = atom.workspace.getActiveTextEditor();
      if (!editor) { bump('ghidra_get_function_list_with_comments', 'fails.noEditor'); throw new Error("No active editor"); }
      const lines = editor.getText().split(/\r?\n/);
      const results = [];
      lines.forEach((line, i) => {
        if (/^\s*(#|\/\/|\/\*|\*)/.test(line)) return;
        const m = line.match(GHIDRA_FUNC_RE);
        if (!m) return;
        const name = m[1];
        if (GHIDRA_SKIP_KW.has(name)) return;
        const commentLines = [];
        for (let j = i - 1; j >= 0 && j >= i - 10; j--) {
          const prev = lines[j].trim();
          if (prev === '' || /^\/[\/*]/.test(prev) || /^\*/.test(prev)) {
            if (prev !== '') commentLines.unshift(prev);
          } else break;
        }
        results.push({
          line: i + 1, name,
          isUnnamed: /^FUN_|^sub_/.test(name),
          comment: commentLines.length > 0 ? commentLines.join(" ") : null
        });
      });
      const named    = results.filter(r => !r.isUnnamed).length;
      const unnamed  = results.filter(r =>  r.isUnnamed).length;
      const annotated = results.filter(r => r.comment).length;
      bump('ghidra_get_function_list_with_comments', 'hits');
      return {
        content: [{ type: "text", text: JSON.stringify({
          summary: { total: results.length, named, unnamed, annotated },
          functions: results
        }, null, 2) }]
      };
    });
  }

  } // end GHIDRA GROUP

  // ── HIGHLIGHT GROUP ───────────────────────────────────────────────────────
  if (g('highlight')) {
  {
    const curTool = "highlight-range";
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
          mcpRegistration(server, linterRegistry, getMessages, { ghidra: true });
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
    server.registerTool(curTool,
      {
        title: "Get Edit Stats",
        description: [
          "Return per-tool edit statistics for this session AND lifetime totals across all sessions.",
          "SESSION: counters since last server restart.",
          "LIFETIME: cumulative totals loaded from disk (edit-stats.json), survives restarts.",
          "EDIT TOOLS (str_replace, insert, delete-*, replace-*, apply-patch, sed):",
          "  report hits + fails. Summary in sessionEditSummary / lifetimeEditSummary.",
          "SEARCH TOOLS (grep-file, grep-project, search-symbol, find-text):",
          "  report hits + misses (a miss is not a failure — no-result is expected behaviour).",
          "  Summary in sessionSearchSummary / lifetimeSearchSummary.",
          "For each tool: hits, fail/miss reasons, hint usage, dry-run count.",
          "str_replace also reports fuzzyWhitespaceCommits and avgOldStrLines.",
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

        const sessionReport  = buildReport(editStats,      'session');
        const lifetimeReport = buildReport(lifetimeStats,  'lifetime');
        lifetimeReport.lifetimeSessionCount = lifetimeStats.sessionCount || 0;

        const sessionStyleReport  = buildStyleReport(styleStats,         'session');
        const lifetimeStyleReport = buildStyleReport(lifetimeStyleStats,  'lifetime');
        Object.assign(sessionReport,  sessionStyleReport);
        Object.assign(lifetimeReport, lifetimeStyleReport);

        const report = { session: sessionReport, lifetime: lifetimeReport };

        if (reset) {
          // Bump session count before zeroing
          lifetimeStats.sessionCount = (lifetimeStats.sessionCount || 0) + 1;
          flushLifetimeStats();
          dbg(curTool, `session reset, lifetime sessionCount now ${lifetimeStats.sessionCount}`);

          // Zero session counters and shadow
          // Zero all tools generically — self-maintaining, no manual update needed when tools are added
          for (const [, val] of Object.entries(editStats)) {
            if (typeof val !== 'object' || val === null) continue;
            if (typeof val.hits === 'number')                   val.hits = 0;
            if (typeof val.dryRuns === 'number')                val.dryRuns = 0;
            if (typeof val.largeEditWarnings === 'number')      val.largeEditWarnings = 0;
            if (typeof val.fuzzyWhitespaceCommits === 'number') val.fuzzyWhitespaceCommits = 0;
            if (typeof val._oldStrLenSum === 'number')          val._oldStrLenSum = 0;
            if (val.fails)     Object.keys(val.fails).forEach(k     => val.fails[k]     = 0);
            if (val.hintsUsed) Object.keys(val.hintsUsed).forEach(k => val.hintsUsed[k] = 0);
          }

          // Reset shadow so deltas start from 0 again
          _lastSynced = makeEmptyLifetime();

          // Zero session style stats
          styleStats._totalCHEdits       = 0;
          styleStats._cleanEdits         = 0;
          styleStats._totalViolations    = 0;
          styleStats._checkpatchRuns     = 0;
          styleStats._checkpatchViolations = 0;
          // Zero all per-rule style counters — self-maintaining, picks up new rules automatically
          Object.keys(styleStats).forEach(k => {
            if (styleStats[k] && typeof styleStats[k].introduced === 'number') {
              styleStats[k].introduced = 0;
            }
          });
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

  // ── checkpatch ──────────────────────────────────────────────────────────────
  {
    const curTool = "checkpatch";
    server.registerTool(curTool,
      {
        title: "Checkpatch",
        description: [
          "Run Linux kernel coding style checks against a .c or .h file.",
          "Operates on the full file content — use this to audit an existing file,",
          "not just the lines being edited.",
          "filePath — path to the file to check. Omit to use the active editor.",
          "Returns all violations grouped by rule with 1-based line numbers.",
          "Prints a summary line: N violations across M rules.",
          "Silent (clean) if no violations found.",
        ].join("\n"),
        inputSchema: {
          filePath: z.string().optional().describe("Path to the .c/.h file to check. Omit for active editor."),
        },
      },
      async ({ filePath }) => {
        try {
          // Resolve the file path
          let targetPath = filePath;
          if (!targetPath) {
            const editor = atom.workspace.getActiveTextEditor();
            if (!editor) return { content: [{ type: "text", text: "❌ No active editor and no filePath provided." }] };
            targetPath = editor.getPath();
          }
          if (!targetPath) return { content: [{ type: "text", text: "❌ Active editor has no file path (unsaved buffer)." }] };
          if (!isKernelFile(targetPath)) {
            return { content: [{ type: "text", text: `⚠️ ${path.basename(targetPath)} is not a .c/.h file — skipping style check.` }] };
          }

          // Read the file content — use live buffer if open, fall back to disk
          let content;
          const openEditor = atom.workspace.getTextEditors()
            .find(e => e.getPath() && path.resolve(e.getPath()) === path.resolve(targetPath));
          if (openEditor) {
            content = openEditor.getText();
          } else {
            content = await fs.promises.readFile(targetPath, 'utf8');
          }

          const { violations, totalViolations } = styleCheckLines(content, targetPath, true);

          styleStats._checkpatchRuns++;
          lifetimeStyleStats._checkpatchRuns++;
          styleStats._checkpatchViolations        += totalViolations;
          lifetimeStyleStats._checkpatchViolations += totalViolations;
          dbg(curTool, `${totalViolations} violations in ${path.basename(targetPath)}`);

          if (totalViolations === 0) {
            return { content: [{ type: "text", text: `✅ ${path.basename(targetPath)}: no style violations found.` }] };
          }

          // Group by rule
          const byRule = {};
          for (const v of violations) {
            if (!byRule[v.type]) byRule[v.type] = [];
            byRule[v.type].push(v);
          }

          const lines = [`🎨 ${path.basename(targetPath)}: ${totalViolations} violation(s) across ${Object.keys(byRule).length} rule(s)\n`];
          for (const [rule, vs] of Object.entries(byRule).sort((a, b) => b[1].length - a[1].length)) {
            const ruleName = rule.replace(/_/g, ' ');
            lines.push(`  ${ruleName} (${vs.length}):`);
            for (const v of vs.slice(0, 20)) {  // cap at 20 per rule to avoid huge output
              lines.push(`    L${v.line}:${v.col}  ${v.message}`);
            }
            if (vs.length > 20) lines.push(`    ... and ${vs.length - 20} more`);
          }

          dbg(curTool, `${totalViolations} violations in ${path.basename(targetPath)}`);
          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
          return { content: [{ type: "text", text: `❌ checkpatch error: ${err.message}` }] };
        }
      }
    );
  }


} // end mcpRegistration

// Flush lifetime stats when the Node process exits (full Pulsar quit)
process.on('exit',    () => { try { syncToLifetime(); require('fs').writeFileSync(STATS_PATH, JSON.stringify(makeStatsDiskData(), null, 2), 'utf8'); } catch {} });
process.on('SIGTERM', () => { try { syncToLifetime(); require('fs').writeFileSync(STATS_PATH, JSON.stringify(makeStatsDiskData(), null, 2), 'utf8'); } catch {} process.exit(0); });
process.on('SIGHUP',  () => { try { syncToLifetime(); require('fs').writeFileSync(STATS_PATH, JSON.stringify(makeStatsDiskData(), null, 2), 'utf8'); } catch {} process.exit(0); });

// Also flush on window unload — fires on Pulsar window reload/restart where
// process.on('exit') does NOT fire (renderer restarts, Node process stays alive).
// Using synchronous writeFileSync here because async promises don't resolve
// during unload. Wrapped in try/catch so a stats flush never blocks shutdown.
window.addEventListener('beforeunload', () => {
  try {
    syncToLifetime();
    if (STATS_PATH) require('fs').writeFileSync(
      STATS_PATH, JSON.stringify(makeStatsDiskData(), null, 2), 'utf8'
    );
  } catch {}
});

// Pulsar package deactivate hook — called synchronously when the package is
// disabled or on window reload. Most reliable flush path for package reloads
// because Pulsar calls deactivate() before tearing down the renderer, giving
// us a guaranteed synchronous save window that beforeunload may miss.
export function deactivate() {
  try {
    syncToLifetime();
    if (STATS_PATH) require('fs').writeFileSync(
      STATS_PATH, JSON.stringify(makeStatsDiskData(), null, 2), 'utf8'
    );
  } catch {}
}


// Also flush on a 5-second timer — short enough that a crash loses at most 5s
// of stats. Async fire-and-forget so it never blocks the UI thread.
setInterval(() => {
  try { syncToLifetime(); flushLifetimeStats(); } catch {}
}, 5000);

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
// ---------------------------------------------------------------------------
// Stats report helpers — module-scope so both the get-edit-stats MCP handler
// and the exported getEditStats() function share the same implementation.
// ---------------------------------------------------------------------------

function summarise(stats) {
  const sr = stats.str_replace;
  // ── Edit tools (buffer-modifying) ──────────────────────────────────────
  const editHits = sr.hits + stats.insert.hits + stats.delete_line_range.hits
    + stats.replace_function_body.hits + stats.replace_block.hits
    + stats.apply_patch.hits + stats.replace_all.hits
    + (stats.replace_document||{hits:0}).hits
    + (stats.replace_across_files||{hits:0}).hits
    + (stats.delete_block||{hits:0}).hits
    + (stats.sed||{hits:0}).hits;
  // Faults — tool used wrong, precondition not met, bad input
  const editFaults = sumFails(sr.fails)
    + sumFails(stats.insert.fails)
    + sumFails(stats.delete_line_range.fails)
    + stats.replace_function_body.fails.notFound
    + sumFails(stats.replace_block.fails)
    + sumFails(stats.apply_patch.fails)
    + ((stats.replace_across_files||{fails:{}}).fails||{skipped:0}).skipped
    + sumFails((stats.delete_block||{fails:{}}).fails)
    + (((stats.sed||{fails:{}}).fails||{}).addressNotFound || 0)
    + (((stats.sed||{fails:{}}).fails||{}).badExpression   || 0);
  // Misses — tool ran fine, content just wasn't there (speculative ops)
  const editMisses = (stats.replace_all.fails||{noMatch:0}).noMatch
    + ((stats.sed||{fails:{}}).fails||{noMatch:0}).noMatch;
  const editTotal = editHits + editFaults + editMisses;
  const editPct   = editTotal > 0 ? Math.round((editHits / editTotal) * 100) : 100;
  // ── Search tools (read-only / locate) ──────────────────────────────────
  const searchHits   = (stats.grep_file||{hits:0}).hits + (stats.grep_project||{hits:0}).hits
    + (stats.search_symbol||{hits:0}).hits + (stats.find_text||{hits:0}).hits
    + (stats.get_repo_map||{hits:0}).hits;
  const searchMisses = ((stats.grep_file||{fails:{}}).fails||{noMatch:0}).noMatch
    + ((stats.grep_project||{fails:{}}).fails||{noMatch:0}).noMatch
    + ((stats.search_symbol||{fails:{}}).fails||{noMatch:0}).noMatch
    + ((stats.find_text||{fails:{}}).fails||{noMatch:0}).noMatch;
  const searchFaults = (stats.get_repo_map||{fails:{}}).fails?.noProject || 0;
  const searchTotal = searchHits + searchMisses + searchFaults;
  // ── RE / Ghidra tools ──────────────────────────────────────────────────
  const GHIDRA_KEYS = ['ghidra_list_functions','ghidra_search_functions','ghidra_get_function_body',
                       'ghidra_get_xrefs','ghidra_add_comment','ghidra_get_function_list_with_comments'];
  const reHits   = GHIDRA_KEYS.reduce((n, k) => n + ((stats[k]||{hits:0}).hits), 0);
  const reFaults = GHIDRA_KEYS.reduce((n, k) => n + ((stats[k]||{fails:{}}).fails?.noEditor || 0)
                                                   + ((stats[k]||{fails:{}}).fails?.notFound || 0), 0);
  const reMisses = GHIDRA_KEYS.reduce((n, k) => n + ((stats[k]||{fails:{}}).fails?.noMatch  || 0), 0);
  const reTotal  = reHits + reFaults + reMisses;
  // ── run_command ────────────────────────────────────────────────────────
  const cmdHits    = (stats.run_command||{hits:0}).hits;
  const cmdFaults  = (stats.run_command||{fails:{}}).fails?.spawnError  || 0;
  const cmdMisses  = ((stats.run_command||{misses:{}}).misses?.exitNonZero || 0)
                   + ((stats.run_command||{misses:{}}).misses?.timedOut    || 0);
  return {
    editHits, editFaults, editMisses, editTotal, editPct,
    searchHits, searchMisses, searchFaults, searchTotal,
    reHits, reFaults, reMisses, reTotal,
    cmdHits, cmdFaults, cmdMisses,
    editSummary:   `${editTotal} edit ops: ${editHits} hits (${editPct}%), ${editFaults} faults, ${editMisses} misses`,
    searchSummary: `${searchTotal} searches: ${searchHits} hits, ${searchMisses} misses, ${searchFaults} faults`,
    reSummary:     reTotal > 0 ? `${reTotal} RE ops: ${reHits} hits, ${reFaults} faults, ${reMisses} misses` : null,
    cmdSummary:    cmdHits + cmdFaults > 0
      ? `${cmdHits + cmdFaults} commands: ${cmdHits} completed (${cmdMisses} non-zero exit, ${cmdFaults} spawn errors)`
      : null,
  };
}

function buildReport(stats, label) {
  const sr  = stats.str_replace;
  const avg = sr.hits > 0 ? Math.round((sr._oldStrLenSum / sr.hits) * 10) / 10 : 0;
  const { editSummary, searchSummary, reSummary, cmdSummary } = summarise(stats);
  // Safe accessor for optional tool keys — returns {} when the key doesn't exist
  // yet (e.g. older lifetime stat objects loaded from disk before a tool was added).
  const st = key => stats[key] || {};
  return {
    [label + 'EditSummary']:   editSummary,
    [label + 'SearchSummary']: searchSummary,
    ...(reSummary  ? { [label + 'RESummary']:  reSummary  } : {}),
    ...(cmdSummary ? { [label + 'CmdSummary']: cmdSummary } : {}),
    str_replace: {
      hits: sr.hits, failTotal: sumFails(sr.fails),
      fails: {...sr.fails}, hintsUsed: {...sr.hintsUsed},
      fuzzyWhitespaceCommits: sr.fuzzyWhitespaceCommits,
      dryRuns: sr.dryRuns, avgOldStrLines: avg
    },
    insert:               { hits: stats.insert.hits,
      failTotal: sumFails(stats.insert.fails),
      fails: {...stats.insert.fails}, hintsUsed: {...(stats.insert.hintsUsed||{})}, dryRuns: stats.insert.dryRuns },
    delete_line_range:    { hits: stats.delete_line_range.hits,
      failTotal: sumFails(stats.delete_line_range.fails),
      fails: {...stats.delete_line_range.fails}, hintsUsed: {...(stats.delete_line_range.hintsUsed||{})}, dryRuns: stats.delete_line_range.dryRuns },
    replace_function_body:{ hits: stats.replace_function_body.hits,
      failTotal: stats.replace_function_body.fails.notFound,
      fails: {...stats.replace_function_body.fails}, hintsUsed: {...(stats.replace_function_body.hintsUsed||{})}, dryRuns: stats.replace_function_body.dryRuns },
    replace_block:        { hits: stats.replace_block.hits,
      failTotal: sumFails(stats.replace_block.fails),
      fails: {...stats.replace_block.fails}, hintsUsed: {...(stats.replace_block.hintsUsed||{})}, dryRuns: stats.replace_block.dryRuns },
    apply_patch:          { hits: stats.apply_patch.hits,
      failTotal: sumFails(stats.apply_patch.fails),
      fails: {...stats.apply_patch.fails},
      largeEditWarnings: stats.apply_patch.largeEditWarnings,
      hintsUsed: {...(stats.apply_patch.hintsUsed||{})}, dryRuns: stats.apply_patch.dryRuns },
    replace_all:          { hits: stats.replace_all.hits,
      missTotal: stats.replace_all.fails.noMatch,
      misses: {...stats.replace_all.fails}, hintsUsed: {...(stats.replace_all.hintsUsed||{})}, dryRuns: stats.replace_all.dryRuns },
    get_structural_anchors: { hits: st('get_structural_anchors').hits || 0,
      hintsUsed: {...(st('get_structural_anchors').hintsUsed || {})},
      dryRuns: st('get_structural_anchors').dryRuns || 0 },
    delete_block:         { hits: st('delete_block').hits || 0,
      failTotal: sumFails(st('delete_block').fails),
      fails: {...(st('delete_block').fails || {})},
      hintsUsed: {...(st('delete_block').hintsUsed || {})},
      dryRuns: st('delete_block').dryRuns || 0 },
    sed:                  { hits: st('sed').hits || 0,
      faultTotal: ((st('sed').fails||{}).addressNotFound || 0) + ((st('sed').fails||{}).badExpression || 0),
      missTotal:  (st('sed').fails||{}).noMatch || 0,
      fails: {...(st('sed').fails || {})},
      hintsUsed: {...(st('sed').hintsUsed || {})},
      dryRuns: st('sed').dryRuns || 0 },
    read_lines:           { hits: st('read_lines').hits || 0,
      failTotal: sumFails(st('read_lines').fails),
      fails: {...(st('read_lines').fails || {})},
      hintsUsed: {...(st('read_lines').hintsUsed || {})},
      dryRuns: st('read_lines').dryRuns || 0 },
    get_region:           { hits: st('get_region').hits || 0,
      failTotal: sumFails(st('get_region').fails),
      fails: {...(st('get_region').fails || {})},
      hintsUsed: {...(st('get_region').hintsUsed || {})},
      dryRuns: st('get_region').dryRuns || 0 },
    get_selection:        { hits: st('get_selection').hits || 0,
      hintsUsed: {...(st('get_selection').hintsUsed || {})},
      dryRuns: st('get_selection').dryRuns || 0 },
    get_linter_messages:  { hits: st('get_linter_messages').hits || 0,
      dryRuns: st('get_linter_messages').dryRuns || 0 },
    grep_file:            { hits: st('grep_file').hits || 0,
      missTotal: sumFails(st('grep_file').fails),
      misses: {...(st('grep_file').fails || {})},
      hintsUsed: {...(st('grep_file').hintsUsed || {})} },
    grep_project:         { hits: st('grep_project').hits || 0,
      missTotal: sumFails(st('grep_project').fails),
      misses: {...(st('grep_project').fails || {})},
      hintsUsed: {...(st('grep_project').hintsUsed || {})} },
    search_symbol:        { hits: st('search_symbol').hits || 0,
      missTotal: sumFails(st('search_symbol').fails),
      misses: {...(st('search_symbol').fails || {})},
      hintsUsed: {...(st('search_symbol').hintsUsed || {})} },
    find_text:            { hits: st('find_text').hits || 0,
      missTotal: sumFails(st('find_text').fails),
      misses: {...(st('find_text').fails || {})},
      dryRuns: st('find_text').dryRuns || 0 },
    replace_document:     { hits: st('replace_document').hits || 0 },
    replace_across_files: { hits: st('replace_across_files').hits || 0,
      failTotal: sumFails(st('replace_across_files').fails),
      fails: {...(st('replace_across_files').fails || {})},
      dryRuns: st('replace_across_files').dryRuns || 0 },
    close_file:        { hits: st('close_file').hits || 0,        failTotal: sumFails(st('close_file').fails),        fails: {...(st('close_file').fails        || {})} },
    goto_focus:       { hits: st('goto_focus').hits || 0,       failTotal: sumFails(st('goto_focus').fails),       fails: {...(st('goto_focus').fails       || {})} },
    get_project_paths: { hits: st('get_project_paths').hits || 0 },
    add_project_path:  { hits: st('add_project_path').hits || 0,  failTotal: sumFails(st('add_project_path').fails),  fails: {...(st('add_project_path').fails  || {})} },
  };
}

function buildStyleReport(ss, label) {
  if (!ss) return {};
  const totalEdits  = ss._totalCHEdits       || 0;
  const totalViols  = ss._totalViolations    || 0;
  const cleanEdits  = ss._cleanEdits         || 0;
  const cpRuns      = ss._checkpatchRuns     || 0;
  const cpViols     = ss._checkpatchViolations || 0;
  const byRule = {};
  for (const [k, v] of Object.entries(ss)) {
    if (k.startsWith('_')) continue;
    if (v && typeof v.introduced === 'number' && v.introduced > 0) {
      byRule[k] = v.introduced;
    }
  }
  const topRules = Object.entries(byRule)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([rule, count]) => `${rule}:${count}`)
    .join(', ');
  const editSummary = totalEdits === 0
    ? 'no inline checks run'
    : `${totalEdits} edits checked, ${totalViols} violations (${cleanEdits} clean). Top: ${topRules || 'none'}`;
  const cpSummary = cpRuns === 0
    ? 'no checkpatch runs'
    : `${cpRuns} run(s), ${cpViols} violations found`;
  return {
    [label + 'StyleSummary']: `inline: ${editSummary} | checkpatch: ${cpSummary}`,
    styleChecks: { editsChecked: totalEdits, totalViolations: totalViols, cleanEdits, byRule,
      checkpatchRuns: cpRuns, checkpatchViolations: cpViols }
  };
}

export function getEditStats() {
  syncToLifetime();

  const sessionReport  = buildReport(editStats,     'session');
  const lifetimeReport = buildReport(lifetimeStats, 'lifetime');
  lifetimeReport.lifetimeSessionCount = lifetimeStats.sessionCount || 0;

  // Lifetime summaries include session count
  lifetimeReport.lifetimeEditSummary   = (() => {
    const { editHits, editTotal, editFails, editPct } = summarise(lifetimeStats);
    const n = lifetimeStats.sessionCount || 0;
    return `${editTotal} edit ops across ${n} sessions: ${editHits} hits (${editPct}%), ${editFails} fails`;
  })();
  lifetimeReport.lifetimeSearchSummary = (() => {
    const { searchHits, searchTotal, searchMisses } = summarise(lifetimeStats);
    const n = lifetimeStats.sessionCount || 0;
    return `${searchTotal} searches across ${n} sessions: ${searchHits} hits, ${searchMisses} misses`;
  })();

  // run_command, get_repo_map, and ghidra_* extras not in buildReport
  sessionReport.get_repo_map  = { hits: (editStats.get_repo_map||{hits:0}).hits,  fails: {...((editStats.get_repo_map||{}).fails||{})} };
  sessionReport.run_command    = { hits: (editStats.run_command||{hits:0}).hits,   fails: {...((editStats.run_command||{}).fails||{})} };
  lifetimeReport.get_repo_map  = { hits: (lifetimeStats.get_repo_map||{hits:0}).hits, fails: {...((lifetimeStats.get_repo_map||{}).fails||{})} };
  lifetimeReport.run_command   = { hits: (lifetimeStats.run_command||{hits:0}).hits,  fails: {...((lifetimeStats.run_command||{}).fails||{})} };
  for (const key of ['ghidra_list_functions','ghidra_search_functions','ghidra_get_function_body',
                     'ghidra_get_xrefs','ghidra_add_comment','ghidra_get_function_list_with_comments']) {
    sessionReport[key]  = { hits: (editStats[key]||{hits:0}).hits,     fails: {...((editStats[key]||{}).fails||{})} };
    lifetimeReport[key] = { hits: (lifetimeStats[key]||{hits:0}).hits,  fails: {...((lifetimeStats[key]||{}).fails||{})} };
  }

  const sessionStyleReport  = buildStyleReport(styleStats,        'session');
  const lifetimeStyleReport = buildStyleReport(lifetimeStyleStats, 'lifetime');
  Object.assign(sessionReport,  sessionStyleReport);
  Object.assign(lifetimeReport, lifetimeStyleReport);

  return {
    paused: statsPaused,
    session:  sessionReport,
    lifetime: lifetimeReport,
  };
}

export function resetEditStats() {
  // Sync and flush before zeroing so nothing is lost
  syncToLifetime();
  lifetimeStats.sessionCount = (lifetimeStats.sessionCount || 0) + 1;
  flushLifetimeStats();

  // Zero all tools generically — self-maintaining, no manual update needed when tools are added
  for (const [, val] of Object.entries(editStats)) {
    if (typeof val !== 'object' || val === null) continue;
    if (typeof val.hits === 'number')                   val.hits = 0;
    if (typeof val.dryRuns === 'number')                val.dryRuns = 0;
    if (typeof val.largeEditWarnings === 'number')      val.largeEditWarnings = 0;
    if (typeof val.fuzzyWhitespaceCommits === 'number') val.fuzzyWhitespaceCommits = 0;
    if (typeof val._oldStrLenSum === 'number')          val._oldStrLenSum = 0;
    if (val.fails)     Object.keys(val.fails).forEach(k     => val.fails[k]     = 0);
    if (val.hintsUsed) Object.keys(val.hintsUsed).forEach(k => val.hintsUsed[k] = 0);
  }
  _lastSynced = makeEmptyLifetime();
}

export function toggleStatsPause() {
  statsPaused = !statsPaused;
  return statsPaused;
}
