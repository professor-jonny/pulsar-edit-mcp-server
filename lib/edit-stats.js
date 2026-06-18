'use strict';
// ---------------------------------------------------------------------------
// lib/edit-stats.js — shared stats accumulator for pulsar-edit-mcp-server.
// Extracted from mcp-registration.js so edit-tools and search-tools can both
// require it once the tooling is split.
//
// Exports:
//   editStats, lifetimeStats, styleStats, lifetimeStyleStats,
//   statsPaused,
//   SESSION_DIR, STATS_PATH, FAILURE_LOG_PATH,
//   sumFails, logFailure, makeEmptyLifetime,
//   flushLifetimeStats, makeStatsDiskData, syncToLifetime,
//   bump, bumpStyle,
//   summarise, buildReport, buildStyleReport
// ---------------------------------------------------------------------------

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Sum all fail-counter values in a tool's .fails object. Handles undefined/null.
const sumFails = obj => Object.values(obj || {}).reduce((a, b) => a + b, 0);

// Stats pause flag — when true, bump() is a no-op so tool failures during
// Ghidra/non-standard work don't pollute hit-rate stats.
let statsPaused = false;

// ---------------------------------------------------------------------------
// Shared hint set added to every tool's hintsUsed block.
// This is the current hint API — all tools get all hints so reporting
// is consistent and bump() can find any key without special-casing.
// ---------------------------------------------------------------------------
const FULL_HINT_KEYS = {
  // ── Scope hints ───────────────────────────────────────────────────────────
  inFunction:      0,
  // ── Directional symbol hints ──────────────────────────────────────────────
  afterFunction:   0,
  beforeFunction:  0,
  afterSymbol:     0,
  beforeSymbol:    0,
  // ── Directional string hints ──────────────────────────────────────────────
  afterString:     0,
  beforeString:    0,
  // ── Positional hints ──────────────────────────────────────────────────────
  afterLine:       0,
  beforeLine:      0,
  betweenHint:     0,
  // ── Modifiers ─────────────────────────────────────────────────────────────
  occurrence:      0,
  fuzzyWhitespace: 0,
};

// Hint set for read_lines — also includes nearLine (positional line-number hint).
const READ_LINES_HINT_KEYS = {
  ...FULL_HINT_KEYS,
  nearLine: 0,
};

// Hint set for insert — also includes the insert-specific content anchors.
const INSERT_HINT_KEYS = {
  ...FULL_HINT_KEYS,
  afterContent:    0,
  beforeContent:   0,
  functionEnd:     0,
  sectionHint:     0,
  preprocBlock:    0,
  endOfFile:       0,
};

// Hint set for delete_block — also includes startContent/endContent.
const DELETE_BLOCK_HINT_KEYS = {
  ...FULL_HINT_KEYS,
  sectionHint:     0,
  preprocBlock:    0,
  startContent:    0,
  endContent:      0,
};

// ---------------------------------------------------------------------------
// Edit statistics accumulator — persists for the session lifetime, queryable
// by the LLM via get-edit-stats. Tracks per-tool hits, fail reasons, hint
// usage, dry-run count, and rolling average old_str line count.
// ---------------------------------------------------------------------------
const editStats = {
  // ── Edit tools (buffer-modifying) ────────────────────────────────────────
  str_replace: {
    hits: 0,
    fails: {
      noMatch:         0,
      whitespace:      0,
      partialMatch:    0,
      ambiguous:       0,
      outOfScope:      0,
      foundOutsideScope: 0,
      afterNotFound:   0,
      wrongOccurrence: 0,
    },
    hintsUsed:      { ...FULL_HINT_KEYS },
    hintsSucceeded: { ...FULL_HINT_KEYS }, // #5a: hint used AND edit committed
    hintsFailed:    { ...FULL_HINT_KEYS }, // #5a: hint used BUT edit failed (noMatch / outOfScope)
    // #5a fault buckets — content vs hint faults
    faultBuckets: {
      contentFaults: 0, // noMatch where old_str simply not in buffer
      hintFaults:    0, // outOfScope / afterNotFound / wrongOccurrence / foundOutsideScope
    },
    // #4 fuzzy auto-retry trigger reasons
    fuzzyTriggerReasons: {
      needsWhitespace: 0,
      needsContent:    0,
      needsComment:    0,
      partial:         0,
    },
    fuzzyWhitespaceCommits:    0,
    fuzzyContentCommits:       0,
    autoStripCommentCommits:   0,
    autoPartialMatchCommits:   0,
    regexCommits:              0,
    _oldStrLenSum: 0,
  },
  insert: {
    hits: 0,
    fails: { outOfRange: 0, anchorNotFound: 0 },
    hintsUsed: { ...INSERT_HINT_KEYS },
    dryRuns: 0,
  },
  delete_line_range: {
    hits: 0,
    fails: { outOfRange: 0, inverted: 0 },
    hintsUsed: { ...FULL_HINT_KEYS },
    dryRuns: 0,
  },
  replace_function_body: {
    hits: 0,
    fails: { notFound: 0, ambiguous: 0, ambiguousHint: 0 },
    hintsUsed: { ...FULL_HINT_KEYS },
    dryRuns: 0,
  },
  replace_block: {
    hits: 0,
    fails: { anchorNotFound: 0, braceMatchFailed: 0 },
    hintsUsed: { ...FULL_HINT_KEYS },
    dryRuns: 0,
  },
  apply_patch: {
    hits: 0,
    fails: { contextMismatch: 0, exception: 0 },
    largeEditWarnings: 0,
    rescuedCommits: 0,
    hintsUsed: { ...FULL_HINT_KEYS },
    dryRuns: 0,
  },
  replace_all: {
    hits: 0,
    fails: { noMatch: 0 },
    hintsUsed: { ...FULL_HINT_KEYS },
    dryRuns: 0,
  },
  replace_document: {
    hits: 0,
  },
  replace_across_files: {
    hits: 0,
    fails: { skipped: 0 },
    dryRuns: 0,
  },
  delete_block: {
    hits: 0,
    fails: { anchorNotFound: 0, startNotFound: 0, endNotFound: 0 },
    hintsUsed: { ...DELETE_BLOCK_HINT_KEYS },
    dryRuns: 0,
  },
  sed: {
    hits: 0,
    fails: { addressNotFound: 0, badExpression: 0, noMatch: 0 },
    hintsUsed: { ...FULL_HINT_KEYS },
    dryRuns: 0,
  },
  get_structural_anchors: {
    hits: 0,
    hintsUsed: { ...FULL_HINT_KEYS },
    dryRuns: 0,
  },
  // ── Search / read tools ───────────────────────────────────────────────────
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
  find_text: {
    hits: 0,
    fails: { noMatch: 0 },
    hintsUsed: { occurrence: 0, contextLines: 0 },
    dryRuns: 0,
  },
  get_repo_map: {
    hits: 0,
    fails: { noProject: 0 },
  },
  read_lines: {
    hits: 0,
    fails: { outOfRange: 0, anchorNotFound: 0 },
    hintsUsed: { ...READ_LINES_HINT_KEYS },
    dryRuns: 0,
  },
  get_region: {
    hits: 0,
    fails: { startNotFound: 0, endNotFound: 0 },
    hintsUsed: { ...FULL_HINT_KEYS },
    dryRuns: 0,
  },
  get_selection: {
    hits: 0,
    dryRuns: 0,
  },

  // ── Nav / file tools ──────────────────────────────────────────────────────
  close_file:      { hits: 0, fails: { notFound: 0 } },
  goto_focus:      { hits: 0, fails: { noEditor: 0 } },
  get_project_paths: { hits: 0, fails: {} },
  add_project_path:  { hits: 0, fails: { notFound: 0 } },
  // ── Shell ─────────────────────────────────────────────────────────────────
  run_command: {
    hits: 0,
    fails:   { spawnError: 0 },
    misses:  { exitNonZero: 0, timedOut: 0 },
  },
  // ── RE / Ghidra tools ─────────────────────────────────────────────────────
  ghidra_list_functions:                   { hits: 0, fails: { noEditor: 0 } },
  ghidra_search_functions:                 { hits: 0, fails: { noEditor: 0, noMatch: 0 } },
  ghidra_get_function_body:                { hits: 0, fails: { noEditor: 0, notFound: 0 } },
  ghidra_get_xrefs:                        { hits: 0, fails: { noEditor: 0, noMatch: 0 } },
  ghidra_add_comment:                      { hits: 0, fails: { noEditor: 0, notFound: 0 } },
  ghidra_get_function_list_with_comments:  { hits: 0, fails: { noEditor: 0 } },
  // ── Kernel C tools ────────────────────────────────────────────────────────
  namingcheck:         { hits: 0, fails: { notKernel: 0 }, misses: { clean: 0 } },
  check_function_docs: { hits: 0, fails: { notKernel: 0 }, misses: { allGood: 0 } },
  insert_function_doc: { hits: 0, fails: { notKernel: 0, notFound: 0, noEditor: 0 } },
  checkpatch:          { hits: 0, fails: { notKernel: 0, exception: 0 }, misses: { clean: 0 } },
};

// ---------------------------------------------------------------------------
// TOOL_REGISTRY — the single source of truth for summarise() and buildReport().
//
// Each entry:
//   key       — editStats key (underscore form)
//   group     — 'edit' | 'search' | 'nav' | 're' | 'shell'
//   countAs   — how non-hits count toward group totals:
//                 'fault'  — .fails keys are faults (bad outcomes)
//                 'miss'   — .fails keys are misses (expected no-result)
//                 'split'  — .fails has both faults and misses; use splitFails
//                 'none'   — no fail tracking (e.g. replace_document)
//   splitFails — { faultKeys, missKeys } — used when countAs === 'split'
//   extras    — additional fields to copy into the report entry (with ||0 guard)
//   compute   — optional fn(raw) => object of derived fields added to report entry
// ---------------------------------------------------------------------------
const TOOL_REGISTRY = [
  // ── Edit tools ────────────────────────────────────────────────────────────
  {
    key: 'str_replace', group: 'edit', countAs: 'fault',
    extras: ['fuzzyWhitespaceCommits','fuzzyContentCommits',
             'autoStripCommentCommits','autoPartialMatchCommits',
             'regexCommits','dryRuns'],
    compute: raw => {
      const out = {
        avgOldStrLines: raw.hits > 0 ? Math.round((raw._oldStrLenSum / raw.hits) * 10) / 10 : 0,
      };
      // #5a fault buckets
      if (raw.faultBuckets) out.faultBuckets = { ...raw.faultBuckets };
      // #4 fuzzy trigger reasons (only if any fired)
      if (raw.fuzzyTriggerReasons) {
        const total = Object.values(raw.fuzzyTriggerReasons).reduce((a, b) => a + b, 0);
        if (total > 0) out.fuzzyTriggerReasons = { ...raw.fuzzyTriggerReasons };
      }
      // #5a per-hint success rate
      if (raw.hintsSucceeded && raw.hintsFailed) {
        const rate = {};
        for (const k of Object.keys(raw.hintsSucceeded)) {
          const s = raw.hintsSucceeded[k] || 0;
          const f = raw.hintsFailed[k]    || 0;
          if (s + f > 0) rate[k] = { ok: s, fail: f, pct: pct(s, s + f) };
        }
        if (Object.keys(rate).length > 0) out.hintSuccessRate = rate;
      }
      return out;
    },
  },
  { key: 'insert',               group: 'edit',   countAs: 'fault', extras: ['dryRuns'] },
  { key: 'delete_line_range',    group: 'edit',   countAs: 'fault', extras: ['dryRuns'] },
  { key: 'replace_function_body',group: 'edit',   countAs: 'fault', extras: ['dryRuns'] },
  { key: 'replace_block',        group: 'edit',   countAs: 'fault', extras: ['dryRuns'] },
  {
    key: 'apply_patch', group: 'edit', countAs: 'fault',
    extras: ['largeEditWarnings','rescuedCommits','dryRuns'],
  },
  { key: 'replace_all',          group: 'edit',   countAs: 'miss',  extras: ['dryRuns'] },
  { key: 'replace_document',     group: 'edit',   countAs: 'none'  },
  { key: 'replace_across_files', group: 'edit',   countAs: 'fault', extras: ['dryRuns'] },
  { key: 'delete_block',         group: 'edit',   countAs: 'fault', extras: ['dryRuns'] },
  {
    key: 'sed', group: 'edit', countAs: 'split',
    splitFails: { faultKeys: ['addressNotFound','badExpression'], missKeys: ['noMatch'] },
    extras: ['dryRuns'],
  },
  { key: 'get_structural_anchors', group: 'edit', countAs: 'none',  extras: ['dryRuns'] },

  // ── Search / read tools ───────────────────────────────────────────────────
  { key: 'grep_file',          group: 'search', countAs: 'miss' },
  { key: 'grep_project',       group: 'search', countAs: 'miss' },
  { key: 'search_symbol',      group: 'search', countAs: 'miss' },
  { key: 'find_text',          group: 'search', countAs: 'miss',  extras: ['dryRuns'] },
  { key: 'get_repo_map',       group: 'search', countAs: 'fault' },
  { key: 'read_lines',         group: 'search', countAs: 'fault', extras: ['dryRuns'] },
  { key: 'get_region',         group: 'search', countAs: 'fault', extras: ['dryRuns'] },
  { key: 'get_selection',      group: 'search', countAs: 'none',  extras: ['dryRuns'] },


  // ── Nav / file tools ──────────────────────────────────────────────────────
  { key: 'close_file',       group: 'nav', countAs: 'fault' },
  { key: 'goto_focus',       group: 'nav', countAs: 'fault' },
  { key: 'get_project_paths',group: 'nav', countAs: 'none'  },
  { key: 'add_project_path', group: 'nav', countAs: 'fault' },

  // ── Shell ─────────────────────────────────────────────────────────────────
  {
    key: 'run_command', group: 'shell', countAs: 'split',
    splitFails: { faultKeys: ['spawnError'], missKeys: [] },
    // misses come from .misses not .fails
    computeMisses: raw => ((raw.misses||{}).exitNonZero || 0) + ((raw.misses||{}).timedOut || 0),
  },

  // ── RE / Ghidra tools ─────────────────────────────────────────────────────
  { key: 'ghidra_list_functions',                  group: 're', countAs: 'fault' },
  {
    key: 'ghidra_search_functions', group: 're', countAs: 'split',
    splitFails: { faultKeys: ['noEditor'], missKeys: ['noMatch'] },
  },
  { key: 'ghidra_get_function_body',               group: 're', countAs: 'fault' },
  {
    key: 'ghidra_get_xrefs', group: 're', countAs: 'split',
    splitFails: { faultKeys: ['noEditor'], missKeys: ['noMatch'] },
  },
  { key: 'ghidra_add_comment',                     group: 're', countAs: 'fault' },
  { key: 'ghidra_get_function_list_with_comments', group: 're', countAs: 'fault' },

  // ── Kernel C tools ─────────────────────────────────────────────────────────
  {
    key: 'namingcheck', group: 'kernel', countAs: 'split',
    splitFails: { faultKeys: ['notKernel'], missKeys: [] },
    computeMisses: raw => ((raw.misses||{}).clean || 0),
  },
  {
    key: 'check_function_docs', group: 'kernel', countAs: 'split',
    splitFails: { faultKeys: ['notKernel'], missKeys: [] },
    computeMisses: raw => ((raw.misses||{}).allGood || 0),
  },
  { key: 'insert_function_doc', group: 'kernel', countAs: 'fault' },
  {
    key: 'checkpatch', group: 'kernel', countAs: 'split',
    splitFails: { faultKeys: ['notKernel', 'exception'], missKeys: [] },
    computeMisses: raw => ((raw.misses||{}).clean || 0),
  },
];

// ---------------------------------------------------------------------------
// Style statistics — per-violation-type counts for Linux kernel style checks.
// Tracks violations introduced by the LLM in .c / .h files only.
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
  _cleanEdits:              0,
  _totalCHEdits:            0,
  _totalViolations:         0,
  _checkpatchRuns:          0,
  _checkpatchViolations:    0,
};

// Lifetime style stats — same shape, persisted alongside lifetimeStats.
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
  _cleanEdits:              0,
  _totalCHEdits:            0,
  _totalViolations:         0,
  _checkpatchRuns:          0,
  _checkpatchViolations:    0,
};

// ---------------------------------------------------------------------------
// Lifetime stats — same shape as editStats plus sessionCount.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Session data directory — all server-level session files live here.
// Created on first load if it doesn't exist.
// ---------------------------------------------------------------------------
const SESSION_DIR = (() => {
  try {
    const dir = path.join(
      atom.packages.getLoadedPackage('pulsar-edit-mcp-server').path,
      'session'
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch { return null; }
})();

const STATS_PATH           = SESSION_DIR ? path.join(SESSION_DIR, 'session-stats.json')    : null;
const SESSION_HISTORY_PATH = SESSION_DIR ? path.join(SESSION_DIR, 'session-history.ndjson') : null;
const FAILURE_LOG_PATH     = SESSION_DIR ? path.join(SESSION_DIR, 'session-faults.ndjson')  : null;

// Append one NDJSON line to session-faults.ndjson.
// Append one NDJSON line to session-history.ndjson on each session reset.
// entry: { ts, session, edits, hits, faults, misses, hitRate, searches, searchHits }
function appendSessionHistory(entry) {
  if (!SESSION_HISTORY_PATH) return;
  try {
    fs.appendFileSync(SESSION_HISTORY_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) { console.warn('[edit-stats] appendSessionHistory failed:', e.message); }
}

function logFailure(entry) {
  if (!FAILURE_LOG_PATH) return;
  try {
    fs.appendFileSync(FAILURE_LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch (e) { console.warn('[edit-stats] logFailure failed:', e.message); }
}

function makeEmptyLifetime() {
  const clone = JSON.parse(JSON.stringify(editStats));
  clone.sessionCount = 0;
  return clone;
}

let lifetimeStats = makeEmptyLifetime();

// Merge src into target recursively, preserving sessionCount separately.
function mergeInto(target, src) {
  for (const k of Object.keys(src)) {
    if (k === 'sessionCount') continue;
    if (typeof src[k] === 'object' && src[k] !== null) {
      if (typeof target[k] !== 'object' || target[k] === null) target[k] = {};
      mergeInto(target[k], src[k]);
    } else {
      target[k] = src[k];
    }
  }
  if (src.sessionCount !== undefined) target.sessionCount = src.sessionCount;
}

// Async init — called once from mcpRegistration() on first /mcp request.
// Returns immediately on subsequent calls (promise is cached).
let _initStatsPromise = null;
async function initStats() {
  if (_initStatsPromise) return _initStatsPromise;
  _initStatsPromise = (async () => {
    if (!STATS_PATH) return;
    try {
      const raw  = await fs.promises.readFile(STATS_PATH, 'utf8');
      const disk = JSON.parse(raw);
      mergeInto(lifetimeStats, disk);
      if (disk.styleStats && typeof disk.styleStats === 'object') {
        mergeInto(lifetimeStyleStats, disk.styleStats);
      }
    } catch { /* file missing or corrupt — start fresh */ }
  })();
  return _initStatsPromise;
}

// Build the object written to disk.
function makeStatsDiskData() {
  return { ...lifetimeStats, styleStats: lifetimeStyleStats };
}

// Flush lifetime stats to disk (async, fire-and-forget).
function flushLifetimeStats() {
  if (!STATS_PATH) return;
  fs.promises.writeFile(STATS_PATH, JSON.stringify(makeStatsDiskData(), null, 2), 'utf8')
    .catch(e => console.error('[edit-stats] flush failed:', e.message));
}

// Sync session counters into lifetime.
let _lastSynced = makeEmptyLifetime();

// Reset the sync shadow — call this after zeroing editStats on session reset.
function resetLastSynced() {
  _lastSynced = makeEmptyLifetime();
}

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

// ---------------------------------------------------------------------------
// bump(toolKey, subPath, n) — increment both session and lifetime in one call.
// path is dot-separated: e.g. 'str_replace.hits', 'str_replace.fails.whitespace'
// ---------------------------------------------------------------------------
function bump(toolKey, subPath, n = 1) {
  if (statsPaused) return;
  const key = toolKey.replace(/-/g, '_');
  let s = editStats[key];
  let l = lifetimeStats[key];
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
// bumpStyle — increment a styleStats violation counter (session + lifetime).
// ---------------------------------------------------------------------------
function bumpStyle(type, n = 1) {
  if (styleStats[type] && typeof styleStats[type].introduced === 'number') {
    styleStats[type].introduced += n;
  }
  if (lifetimeStyleStats[type] && typeof lifetimeStyleStats[type].introduced === 'number') {
    lifetimeStyleStats[type].introduced += n;
  }
}

// ---------------------------------------------------------------------------
// pct(hits, total) — safe hit-rate percentage helper.
// ---------------------------------------------------------------------------
function pct(hits, total) {
  return total > 0 ? Math.round((hits / total) * 100) : 100;
}

// ---------------------------------------------------------------------------
// _toolCounts(reg, raw) — derive { hits, faults, misses } for one registry entry.
// ---------------------------------------------------------------------------
function _toolCounts(reg, raw) {
  const hits = raw.hits || 0;
  let faults = 0;
  let misses = 0;

  if (reg.countAs === 'fault') {
    faults = sumFails(raw.fails);
  } else if (reg.countAs === 'miss') {
    misses = sumFails(raw.fails);
  } else if (reg.countAs === 'split') {
    const sf = reg.splitFails || { faultKeys: [], missKeys: [] };
    const fails = raw.fails || {};
    for (const k of sf.faultKeys) faults += fails[k] || 0;
    for (const k of sf.missKeys)  misses += fails[k] || 0;
    // run_command keeps misses in .misses not .fails
    if (typeof reg.computeMisses === 'function') misses += reg.computeMisses(raw);
  }
  // countAs:'none' — faults and misses stay 0

  return { hits, faults, misses };
}

// ---------------------------------------------------------------------------
// GROUP_META — display metadata for each tool group.
// label:     human-readable name used in summary strings.
// summaryFn: fn(g) => string | null — produces the group's summary line.
//            g = { hits, faults, misses, total, pct }.
//            Return null to suppress the key entirely (e.g. zero-activity groups).
// ---------------------------------------------------------------------------
const GROUP_META = {
  edit: {
    label: 'edit ops',
    summaryFn: g =>
      `${g.total} edit ops: ${g.hits} hits (${g.pct}%), ${g.faults} faults, ${g.misses} misses`,
  },
  search: {
    label: 'searches',
    summaryFn: g =>
      `${g.total} searches: ${g.hits} hits, ${g.misses} misses, ${g.faults} faults`,
  },
  shell: {
    label: 'commands',
    summaryFn: g =>
      (g.hits + g.faults) > 0
        ? `${g.hits + g.faults} commands: ${g.hits} completed (${g.misses} non-zero exit, ${g.faults} spawn errors)`
        : null,
  },
  re: {
    label: 'RE ops',
    summaryFn: g =>
      g.total > 0
        ? `${g.total} RE ops: ${g.hits} hits, ${g.faults} faults, ${g.misses} misses`
        : null,
  },
  nav: {
    label: 'nav ops',
    summaryFn: g =>
      g.total > 0
        ? `${g.total} nav ops: ${g.hits} hits, ${g.faults} faults`
        : null,
  },
  kernel: {
    label: 'kernel ops',
    summaryFn: g =>
      g.total > 0
        ? `${g.total} kernel ops: ${g.hits} hits, ${g.faults} faults, ${g.misses} misses`
        : null,
  },
};

// ---------------------------------------------------------------------------
// summarise(stats) — aggregate totals across tool groups.
//
// Returns:
//   groups  — { [groupName]: { hits, faults, misses, total, pct, summary } }
//             Data-driven from TOOL_REGISTRY + GROUP_META.
//
//   Backward-compat flat aliases (consumed by mcp-registration.js):
//   editHits, editFaults, editFails, editMisses, editTotal, editPct, editSummary,
//   searchHits, searchMisses, searchFaults, searchTotal, searchSummary,
//   reHits, reFaults, reMisses, reTotal, reSummary,
//   cmdHits, cmdFaults, cmdMisses, cmdSummary
// ---------------------------------------------------------------------------
function summarise(stats) {
  // Collect unique group names from registry in declaration order.
  const groupNames = [];
  for (const reg of TOOL_REGISTRY) {
    if (!groupNames.includes(reg.group)) groupNames.push(reg.group);
  }

  // Accumulate hits/faults/misses per group.
  const acc = {};
  for (const name of groupNames) acc[name] = { hits: 0, faults: 0, misses: 0 };

  for (const reg of TOOL_REGISTRY) {
    const raw = stats[reg.key] || {};
    const { hits, faults, misses } = _toolCounts(reg, raw);
    const g = acc[reg.group];
    g.hits   += hits;
    g.faults += faults;
    g.misses += misses;
  }

  // Build enriched group objects.
  const groups = {};
  for (const name of groupNames) {
    const g  = acc[name];
    const gp = GROUP_META[name] || { summaryFn: () => null };
    const total   = g.hits + g.faults + g.misses;
    const hitPct  = pct(g.hits, total);
    const summary = gp.summaryFn({ ...g, total, pct: hitPct });
    groups[name] = { hits: g.hits, faults: g.faults, misses: g.misses, total, pct: hitPct, summary };
  }

  const e = groups.edit   || { hits:0, faults:0, misses:0, total:0, pct:100, summary:'' };
  const s = groups.search || { hits:0, faults:0, misses:0, total:0, pct:100, summary:'' };
  const r = groups.re     || { hits:0, faults:0, misses:0, total:0, pct:100, summary:null };
  const c = groups.shell  || { hits:0, faults:0, misses:0, total:0, pct:100, summary:null };

  return {
    groups,
    // ── Backward-compat flat aliases ─────────────────────────────────────────
    editHits:   e.hits,
    editFaults: e.faults,
    editFails:  e.faults,   // alias — consumed by mcp-registration.js
    editMisses: e.misses,
    editTotal:  e.total,
    editPct:    e.pct,
    editSummary:   e.summary,
    searchHits:   s.hits,
    searchMisses: s.misses,
    searchFaults: s.faults,
    searchTotal:  s.total,
    searchSummary: s.summary,
    reHits:   r.hits,
    reFaults: r.faults,
    reMisses: r.misses,
    reTotal:  r.total,
    reSummary: r.summary,
    cmdHits:   c.hits,
    cmdFaults: c.faults,
    cmdMisses: c.misses,
    cmdSummary: c.summary,
  };
}

// ---------------------------------------------------------------------------
// buildReport(stats, label) — full per-tool breakdown for get-edit-stats.
// Driven entirely by TOOL_REGISTRY — adding a tool here is a registry entry only.
// ---------------------------------------------------------------------------
function buildReport(stats, label) {
  const summ = summarise(stats);

  const report = {};

  // ── Summary strings (data-driven from GROUP_META) ────────────────────────
  // Each group contributes a '[label][GroupTitle]Summary' key when non-null.
  for (const [name, g] of Object.entries(summ.groups)) {
    if (g.summary != null) {
      // Capitalise first letter of the group name for the key.
      const title = name.charAt(0).toUpperCase() + name.slice(1);
      report[label + title + 'Summary'] = g.summary;
    }
  }

  // ── Group-level breakdown objects (data-driven) ──────────────────────────
  // Emit '_${name}Group' for every group that has any activity.
  for (const [name, g] of Object.entries(summ.groups)) {
    // Always emit edit + search; suppress others when total === 0.
    if (g.total === 0 && name !== 'edit' && name !== 'search') continue;
    report['_' + name + 'Group'] = {
      hits:   g.hits,
      faults: g.faults,
      misses: g.misses,
      total:  g.total,
      pct:    g.pct,
    };
  }

  // ── Per-tool entries (driven by TOOL_REGISTRY) ───────────────────────────
  for (const reg of TOOL_REGISTRY) {
    const raw = stats[reg.key] || {};
    const { hits, faults, misses } = _toolCounts(reg, raw);

    const entry = { hits };

    // Fault / miss counts and pct
    if (reg.countAs === 'fault') {
      entry.failTotal = faults;
      entry.pct       = pct(hits, hits + faults);
      if (raw.fails) entry.fails = { ...raw.fails };
    } else if (reg.countAs === 'miss') {
      entry.missTotal = misses;
      entry.pct       = pct(hits, hits + misses);
      if (raw.fails) entry.misses = { ...raw.fails };
    } else if (reg.countAs === 'split') {
      const sf = reg.splitFails || { faultKeys: [], missKeys: [] };
      entry.faultTotal = faults;
      entry.missTotal  = misses;
      entry.pct        = pct(hits, hits + faults);
      if (raw.fails) {
        const faultObj = {}; const missObj = {};
        for (const k of sf.faultKeys) faultObj[k] = (raw.fails[k] || 0);
        for (const k of sf.missKeys)  missObj[k]  = (raw.fails[k] || 0);
        if (sf.faultKeys.length) entry.faults = faultObj;
        if (sf.missKeys.length)  entry.misses = missObj;
      }
      // run_command: expose the .misses sub-object too
      if (raw.misses) entry.misses = { ...raw.misses };
      if (raw.fails && reg.key !== 'run_command') entry.fails = { ...raw.fails };
    } else {
      // countAs:'none' — just hits, no pct (or pct:100 implicitly)
      entry.pct = 100;
    }

    // hintsUsed
    if (raw.hintsUsed) entry.hintsUsed = { ...raw.hintsUsed };

    // extras
    for (const field of (reg.extras || [])) {
      entry[field] = raw[field] || 0;
    }

    // compute (derived fields)
    if (typeof reg.compute === 'function') {
      Object.assign(entry, reg.compute(raw));
    }

    report[reg.key] = entry;
  }

  return report;
}

// ---------------------------------------------------------------------------
// buildStyleReport(ss, label) — style violation summary.
// ---------------------------------------------------------------------------
function buildStyleReport(ss, label) {
  if (!ss) return {};
  const totalEdits = ss._totalCHEdits       || 0;
  const totalViols = ss._totalViolations    || 0;
  const cleanEdits = ss._cleanEdits         || 0;
  const cpRuns     = ss._checkpatchRuns     || 0;
  const cpViols    = ss._checkpatchViolations || 0;
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
      checkpatchRuns: cpRuns, checkpatchViolations: cpViols },
  };
}

// ---------------------------------------------------------------------------
// Process-exit persistence hooks
// ---------------------------------------------------------------------------
function _flushSync() {
  try {
    syncToLifetime();
    fs.writeFileSync(STATS_PATH, JSON.stringify(makeStatsDiskData(), null, 2), 'utf8');
  } catch (e) { console.warn('[edit-stats] _flushSync failed:', e.message); }
}

process.on('exit',    () => { _flushSync(); });
process.on('SIGTERM', () => { _flushSync(); process.exit(0); });
process.on('SIGHUP',  () => { _flushSync(); process.exit(0); });

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  editStats,
  lifetimeStats,
  styleStats,
  lifetimeStyleStats,
  getStatsPaused() { return statsPaused; },
  setStatsPaused(v) { statsPaused = !!v; },
  SESSION_DIR,
  STATS_PATH,
  SESSION_HISTORY_PATH,
  FAILURE_LOG_PATH,
  sumFails,
  logFailure,
  appendSessionHistory,
  initStats,
  makeEmptyLifetime,
  flushLifetimeStats,
  makeStatsDiskData,
  syncToLifetime,
  resetLastSynced,
  bump,
  bumpStyle,
  summarise,
  buildReport,
  buildStyleReport,
};
