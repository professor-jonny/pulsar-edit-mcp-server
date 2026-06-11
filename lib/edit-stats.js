'use strict';
// ---------------------------------------------------------------------------
// lib/edit-stats.js — shared stats accumulator for pulsar-edit-mcp-server.
// Extracted from mcp-registration.js so edit-tools and search-tools can both
// require it once the tooling is split.
//
// Exports:
//   editStats, lifetimeStats, styleStats, lifetimeStyleStats,
//   statsPaused,
//   STATS_PATH, FAILURE_LOG_PATH,
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
// This is the full v0.10.29 hint API — all tools get all hints so reporting
// is consistent and bump() can find any key without special-casing.
// ---------------------------------------------------------------------------
const FULL_HINT_KEYS = {
  // ── Scope hints ───────────────────────────────────────────────────────────
  inFunction:      0,
  inSymbol:        0,
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
  lineContentHint: 0,
  // ── Legacy hints (back-compat) ────────────────────────────────────────────
  functionHint:    0,
  afterHint:       0,
  lineNumberHint:  0,
  betweenHint:     0,
  // ── Modifiers ─────────────────────────────────────────────────────────────
  occurrence:      0,
  fuzzyWhitespace: 0,
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
      afterNotFound:   0,
      wrongOccurrence: 0,
    },
    hintsUsed: { ...FULL_HINT_KEYS },
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
    dryRuns: 0,
  },
  get_repo_map: {
    hits: 0,
    fails: { noProject: 0 },
  },
  read_lines: {
    hits: 0,
    fails: { outOfRange: 0, anchorNotFound: 0 },
    hintsUsed: { ...FULL_HINT_KEYS },
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
  get_linter_messages: {
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
};

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
const STATS_PATH = (() => {
  try {
    return path.join(
      atom.packages.getLoadedPackage('pulsar-edit-mcp-server').path,
      'edit-stats.json'
    );
  } catch { return null; }
})();

const FAILURE_LOG_PATH = (() => {
  try {
    return path.join(
      atom.packages.getLoadedPackage('pulsar-edit-mcp-server').path,
      'failure-log.ndjson'
    );
  } catch { return null; }
})();

// Append one NDJSON line to failure-log.ndjson.
function logFailure(entry) {
  if (!FAILURE_LOG_PATH) return;
  try {
    fs.appendFileSync(FAILURE_LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch (_) {}
}

function makeEmptyLifetime() {
  const clone = JSON.parse(JSON.stringify(editStats));
  clone.sessionCount = 0;
  return clone;
}

let lifetimeStats = makeEmptyLifetime();

// Load from disk synchronously at startup (file may not exist yet — that's fine).
(function loadLifetimeStats() {
  if (!STATS_PATH) return;
  try {
    const raw  = fs.readFileSync(STATS_PATH, 'utf8');
    const disk = JSON.parse(raw);
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
    mergeInto(lifetimeStats, disk);
    if (disk.styleStats && typeof disk.styleStats === 'object') {
      mergeInto(lifetimeStyleStats, disk.styleStats);
    }
  } catch { /* file missing or corrupt — start fresh */ }
})();

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
// summarise(stats) — aggregate totals across tool groups.
// ---------------------------------------------------------------------------
function summarise(stats) {
  const sr = stats.str_replace;
  // ── Edit tools ────────────────────────────────────────────────────────────
  const editHits = sr.hits + stats.insert.hits + stats.delete_line_range.hits
    + stats.replace_function_body.hits + stats.replace_block.hits
    + stats.apply_patch.hits + stats.replace_all.hits
    + (stats.replace_document||{hits:0}).hits
    + (stats.replace_across_files||{hits:0}).hits
    + (stats.delete_block||{hits:0}).hits
    + (stats.sed||{hits:0}).hits;
  const editFaults = sumFails(sr.fails)
    + sumFails(stats.insert.fails)
    + sumFails(stats.delete_line_range.fails)
    + sumFails(stats.replace_function_body.fails)
    + sumFails(stats.replace_block.fails)
    + sumFails(stats.apply_patch.fails)
    + ((stats.replace_across_files||{fails:{}}).fails||{skipped:0}).skipped
    + sumFails((stats.delete_block||{fails:{}}).fails)
    + (((stats.sed||{fails:{}}).fails||{}).addressNotFound || 0)
    + (((stats.sed||{fails:{}}).fails||{}).badExpression   || 0);
  const editMisses = (stats.replace_all.fails||{noMatch:0}).noMatch
    + ((stats.sed||{fails:{}}).fails||{noMatch:0}).noMatch;
  const editTotal = editHits + editFaults + editMisses;
  const editPct   = pct(editHits, editTotal);
  // ── Search tools ──────────────────────────────────────────────────────────
  // Hits: all tools that successfully return data
  const searchHits   = (stats.grep_file||{hits:0}).hits
    + (stats.grep_project||{hits:0}).hits
    + (stats.search_symbol||{hits:0}).hits
    + (stats.find_text||{hits:0}).hits
    + (stats.get_repo_map||{hits:0}).hits
    + (stats.get_structural_anchors||{hits:0}).hits
    + (stats.read_lines||{hits:0}).hits
    + (stats.get_region||{hits:0}).hits
    + (stats.get_selection||{hits:0}).hits
    + (stats.get_linter_messages||{hits:0}).hits;
  // Misses: expected no-result (query returned nothing — not an error)
  const searchMisses = ((stats.grep_file||{fails:{}}).fails||{noMatch:0}).noMatch
    + ((stats.grep_project||{fails:{}}).fails||{noMatch:0}).noMatch
    + ((stats.search_symbol||{fails:{}}).fails||{noMatch:0}).noMatch
    + ((stats.find_text||{fails:{}}).fails||{noMatch:0}).noMatch;
  // Faults: genuine errors (asked for something that couldn't be served)
  const searchFaults = ((stats.get_repo_map||{fails:{}}).fails?.noProject || 0)
    + (((stats.read_lines||{fails:{}}).fails||{}).outOfRange      || 0)
    + (((stats.read_lines||{fails:{}}).fails||{}).anchorNotFound  || 0)
    + (((stats.get_region||{fails:{}}).fails||{}).startNotFound   || 0)
    + (((stats.get_region||{fails:{}}).fails||{}).endNotFound     || 0);
  const searchTotal = searchHits + searchMisses + searchFaults;
  // ── RE / Ghidra tools ─────────────────────────────────────────────────────
  const GHIDRA_KEYS = ['ghidra_list_functions','ghidra_search_functions','ghidra_get_function_body',
                       'ghidra_get_xrefs','ghidra_add_comment','ghidra_get_function_list_with_comments'];
  const reHits   = GHIDRA_KEYS.reduce((n, k) => n + ((stats[k]||{hits:0}).hits), 0);
  const reFaults = GHIDRA_KEYS.reduce((n, k) => n + ((stats[k]||{fails:{}}).fails?.noEditor || 0)
                                                   + ((stats[k]||{fails:{}}).fails?.notFound || 0), 0);
  const reMisses = GHIDRA_KEYS.reduce((n, k) => n + ((stats[k]||{fails:{}}).fails?.noMatch  || 0), 0);
  const reTotal  = reHits + reFaults + reMisses;
  // ── run_command ───────────────────────────────────────────────────────────
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

// ---------------------------------------------------------------------------
// toolPct(t) — per-tool hit% helper used in buildReport.
// edit tools: hits / (hits + failTotal)
// search tools: hits / (hits + missTotal)  — a miss is not a failure
// ---------------------------------------------------------------------------
function toolPct(hits, totalFaults) {
  const total = hits + totalFaults;
  return total > 0 ? Math.round((hits / total) * 100) : 100;
}

// ---------------------------------------------------------------------------
// buildReport(stats, label) — full per-tool breakdown for get-edit-stats.
// Tools are ordered in logical groups:
//   1. Edit tools        (buffer-modifying)
//   2. Search tools      (locate / read-only)
//   3. Nav / file tools
//   4. RE / Ghidra tools
//   5. Shell
// Each tool with hits+fails now includes a pct field.
// ---------------------------------------------------------------------------
function buildReport(stats, label) {
  const sr  = stats.str_replace;
  const avg = sr.hits > 0 ? Math.round((sr._oldStrLenSum / sr.hits) * 10) / 10 : 0;
  const summ = summarise(stats);
  const { editSummary, searchSummary, reSummary, cmdSummary } = summ;
  const st = key => stats[key] || {};

  // Per-tool pct helpers
  const ep  = (hits, fails)  => toolPct(hits, sumFails(fails));   // edit  pct (fails   = bad)
  const sp  = (hits, misses) => toolPct(hits, sumFails(misses));  // search pct (misses = expected no-result)

  // Group-level pct
  const gpct = (hits, total) => total > 0 ? Math.round((hits / total) * 100) : 100;

  return {
    // ── Summaries ─────────────────────────────────────────────────────────────
    [label + 'EditSummary']:   editSummary,
    [label + 'SearchSummary']: searchSummary,
    ...(reSummary  ? { [label + 'RESummary']:  reSummary  } : {}),
    ...(cmdSummary ? { [label + 'CmdSummary']: cmdSummary } : {}),

    // ── Group-level breakdowns ─────────────────────────────────────────────────
    _editGroup: {
      hits:   summ.editHits,
      faults: summ.editFaults,
      misses: summ.editMisses,
      total:  summ.editTotal,
      pct:    gpct(summ.editHits, summ.editTotal),
    },
    _searchGroup: {
      hits:   summ.searchHits,
      misses: summ.searchMisses,
      faults: summ.searchFaults,
      total:  summ.searchTotal,
      pct:    gpct(summ.searchHits, summ.searchTotal),
    },
    ...(summ.reTotal > 0 ? { _reGroup: {
      hits:   summ.reHits,
      faults: summ.reFaults,
      misses: summ.reMisses,
      total:  summ.reTotal,
      pct:    gpct(summ.reHits, summ.reTotal),
    } } : {}),
    ...((summ.cmdHits + summ.cmdFaults) > 0 ? { _cmdGroup: {
      hits:   summ.cmdHits,
      faults: summ.cmdFaults,
      misses: summ.cmdMisses,
      total:  summ.cmdHits + summ.cmdFaults + summ.cmdMisses,
      pct:    gpct(summ.cmdHits, summ.cmdHits + summ.cmdFaults + summ.cmdMisses),
    } } : {}),

    // ── 1. Edit tools ──────────────────────────────────────────────────────────
    str_replace: {
      hits: sr.hits,
      failTotal: sumFails(sr.fails),
      pct: ep(sr.hits, sr.fails),
      fails: {...sr.fails},
      hintsUsed: {...sr.hintsUsed},
      fuzzyWhitespaceCommits:  sr.fuzzyWhitespaceCommits,
      fuzzyContentCommits:     sr.fuzzyContentCommits,
      autoStripCommentCommits: sr.autoStripCommentCommits  || 0,
      autoPartialMatchCommits: sr.autoPartialMatchCommits  || 0,
      dryRuns: sr.dryRuns || 0,
      avgOldStrLines: avg,
    },
    insert: {
      hits: stats.insert.hits,
      failTotal: sumFails(stats.insert.fails),
      pct: ep(stats.insert.hits, stats.insert.fails),
      fails: {...stats.insert.fails},
      hintsUsed: {...(stats.insert.hintsUsed||{})},
      dryRuns: stats.insert.dryRuns || 0,
    },
    delete_line_range: {
      hits: stats.delete_line_range.hits,
      failTotal: sumFails(stats.delete_line_range.fails),
      pct: ep(stats.delete_line_range.hits, stats.delete_line_range.fails),
      fails: {...stats.delete_line_range.fails},
      hintsUsed: {...(stats.delete_line_range.hintsUsed||{})},
      dryRuns: stats.delete_line_range.dryRuns || 0,
    },
    replace_function_body: {
      hits: stats.replace_function_body.hits,
      failTotal: sumFails(stats.replace_function_body.fails),
      pct: ep(stats.replace_function_body.hits, stats.replace_function_body.fails),
      fails: {...stats.replace_function_body.fails},
      hintsUsed: {...(stats.replace_function_body.hintsUsed||{})},
      dryRuns: stats.replace_function_body.dryRuns || 0,
    },
    replace_block: {
      hits: stats.replace_block.hits,
      failTotal: sumFails(stats.replace_block.fails),
      pct: ep(stats.replace_block.hits, stats.replace_block.fails),
      fails: {...stats.replace_block.fails},
      hintsUsed: {...(stats.replace_block.hintsUsed||{})},
      dryRuns: stats.replace_block.dryRuns || 0,
    },
    apply_patch: {
      hits: stats.apply_patch.hits,
      failTotal: sumFails(stats.apply_patch.fails),
      pct: ep(stats.apply_patch.hits, stats.apply_patch.fails),
      fails: {...stats.apply_patch.fails},
      largeEditWarnings: stats.apply_patch.largeEditWarnings || 0,
      rescuedCommits:    stats.apply_patch.rescuedCommits    || 0,
      hintsUsed: {...(stats.apply_patch.hintsUsed||{})},
      dryRuns: stats.apply_patch.dryRuns || 0,
    },
    replace_all: {
      hits: stats.replace_all.hits,
      missTotal: (stats.replace_all.fails||{noMatch:0}).noMatch,
      pct: sp(stats.replace_all.hits, stats.replace_all.fails),
      misses: {...(stats.replace_all.fails||{})},
      hintsUsed: {...(stats.replace_all.hintsUsed||{})},
      dryRuns: stats.replace_all.dryRuns || 0,
    },
    // File-level edit tools (whole-file / whole-project mutations)
    replace_document: {
      hits: st('replace_document').hits || 0,
      pct: 100,  // no fail tracking — every call either succeeds or throws
    },
    replace_across_files: {
      hits: st('replace_across_files').hits || 0,
      failTotal: sumFails(st('replace_across_files').fails),
      pct: ep(st('replace_across_files').hits || 0, st('replace_across_files').fails),
      fails: {...(st('replace_across_files').fails || {})},
      dryRuns: st('replace_across_files').dryRuns || 0,
    },
    delete_block: {
      hits: st('delete_block').hits || 0,
      failTotal: sumFails(st('delete_block').fails),
      pct: ep(st('delete_block').hits || 0, st('delete_block').fails),
      fails: {...(st('delete_block').fails || {})},
      hintsUsed: {...(st('delete_block').hintsUsed || {})},
      dryRuns: st('delete_block').dryRuns || 0,
    },
    sed: {
      hits: st('sed').hits || 0,
      faultTotal: ((st('sed').fails||{}).addressNotFound || 0) + ((st('sed').fails||{}).badExpression || 0),
      missTotal:  (st('sed').fails||{}).noMatch || 0,
      pct: ep(st('sed').hits || 0, st('sed').fails),
      fails: {...(st('sed').fails || {})},
      hintsUsed: {...(st('sed').hintsUsed || {})},
      dryRuns: st('sed').dryRuns || 0,
    },

    // ── 2. Search tools ────────────────────────────────────────────────────────
    // Query / pattern tools — misses are expected no-result, not errors
    grep_file: {
      hits: st('grep_file').hits || 0,
      missTotal: sumFails(st('grep_file').fails),
      pct: sp(st('grep_file').hits || 0, st('grep_file').fails),
      misses: {...(st('grep_file').fails || {})},
      hintsUsed: {...(st('grep_file').hintsUsed || {})},
    },
    grep_project: {
      hits: st('grep_project').hits || 0,
      missTotal: sumFails(st('grep_project').fails),
      pct: sp(st('grep_project').hits || 0, st('grep_project').fails),
      misses: {...(st('grep_project').fails || {})},
      hintsUsed: {...(st('grep_project').hintsUsed || {})},
    },
    search_symbol: {
      hits: st('search_symbol').hits || 0,
      missTotal: sumFails(st('search_symbol').fails),
      pct: sp(st('search_symbol').hits || 0, st('search_symbol').fails),
      misses: {...(st('search_symbol').fails || {})},
      hintsUsed: {...(st('search_symbol').hintsUsed || {})},
    },
    find_text: {
      hits: st('find_text').hits || 0,
      missTotal: sumFails(st('find_text').fails),
      pct: sp(st('find_text').hits || 0, st('find_text').fails),
      misses: {...(st('find_text').fails || {})},
      dryRuns: st('find_text').dryRuns || 0,
    },
    // Structural / anchor discovery — faults only (no valid "no result" case)
    get_structural_anchors: {
      hits: st('get_structural_anchors').hits || 0,
      hintsUsed: {...(st('get_structural_anchors').hintsUsed || {})},
      dryRuns: st('get_structural_anchors').dryRuns || 0,
    },
    // Read tools — out-of-range and anchor-not-found are faults, not misses
    get_repo_map: {
      hits: st('get_repo_map').hits || 0,
      failTotal: sumFails(st('get_repo_map').fails),
      pct: ep(st('get_repo_map').hits || 0, st('get_repo_map').fails),
      fails: {...(st('get_repo_map').fails || {})},
    },
    read_lines: {
      hits: st('read_lines').hits || 0,
      faultTotal: sumFails(st('read_lines').fails),
      pct: ep(st('read_lines').hits || 0, st('read_lines').fails),
      faults: {...(st('read_lines').fails || {})},
      hintsUsed: {...(st('read_lines').hintsUsed || {})},
      dryRuns: st('read_lines').dryRuns || 0,
    },
    get_region: {
      hits: st('get_region').hits || 0,
      faultTotal: sumFails(st('get_region').fails),
      pct: ep(st('get_region').hits || 0, st('get_region').fails),
      faults: {...(st('get_region').fails || {})},
      hintsUsed: {...(st('get_region').hintsUsed || {})},
      dryRuns: st('get_region').dryRuns || 0,
    },
    get_selection: {
      hits: st('get_selection').hits || 0,
      hintsUsed: {...(st('get_selection').hintsUsed || {})},
      dryRuns: st('get_selection').dryRuns || 0,
    },
    get_linter_messages: {
      hits: st('get_linter_messages').hits || 0,
      dryRuns: st('get_linter_messages').dryRuns || 0,
    },

    // ── 3. Nav / file tools ────────────────────────────────────────────────────
    close_file: {
      hits: st('close_file').hits || 0,
      failTotal: sumFails(st('close_file').fails),
      pct: ep(st('close_file').hits || 0, st('close_file').fails),
      fails: {...(st('close_file').fails || {})},
    },
    goto_focus: {
      hits: st('goto_focus').hits || 0,
      failTotal: sumFails(st('goto_focus').fails),
      pct: ep(st('goto_focus').hits || 0, st('goto_focus').fails),
      fails: {...(st('goto_focus').fails || {})},
    },
    get_project_paths: {
      hits: st('get_project_paths').hits || 0,
    },
    add_project_path: {
      hits: st('add_project_path').hits || 0,
      failTotal: sumFails(st('add_project_path').fails),
      pct: ep(st('add_project_path').hits || 0, st('add_project_path').fails),
      fails: {...(st('add_project_path').fails || {})},
    },

    // ── 4. RE / Ghidra tools ──────────────────────────────────────────────────
    ghidra_list_functions: {
      hits: st('ghidra_list_functions').hits || 0,
      failTotal: sumFails(st('ghidra_list_functions').fails),
      pct: ep(st('ghidra_list_functions').hits || 0, st('ghidra_list_functions').fails),
      fails: {...(st('ghidra_list_functions').fails || {})},
    },
    ghidra_search_functions: {
      hits: st('ghidra_search_functions').hits || 0,
      missTotal: (st('ghidra_search_functions').fails||{noMatch:0}).noMatch || 0,
      faultTotal: (st('ghidra_search_functions').fails||{noEditor:0}).noEditor || 0,
      pct: ep(st('ghidra_search_functions').hits || 0, st('ghidra_search_functions').fails),
      fails: {...(st('ghidra_search_functions').fails || {})},
    },
    ghidra_get_function_body: {
      hits: st('ghidra_get_function_body').hits || 0,
      failTotal: sumFails(st('ghidra_get_function_body').fails),
      pct: ep(st('ghidra_get_function_body').hits || 0, st('ghidra_get_function_body').fails),
      fails: {...(st('ghidra_get_function_body').fails || {})},
    },
    ghidra_get_xrefs: {
      hits: st('ghidra_get_xrefs').hits || 0,
      missTotal: (st('ghidra_get_xrefs').fails||{noMatch:0}).noMatch || 0,
      faultTotal: (st('ghidra_get_xrefs').fails||{noEditor:0}).noEditor || 0,
      pct: ep(st('ghidra_get_xrefs').hits || 0, st('ghidra_get_xrefs').fails),
      fails: {...(st('ghidra_get_xrefs').fails || {})},
    },
    ghidra_add_comment: {
      hits: st('ghidra_add_comment').hits || 0,
      failTotal: sumFails(st('ghidra_add_comment').fails),
      pct: ep(st('ghidra_add_comment').hits || 0, st('ghidra_add_comment').fails),
      fails: {...(st('ghidra_add_comment').fails || {})},
    },
    ghidra_get_function_list_with_comments: {
      hits: st('ghidra_get_function_list_with_comments').hits || 0,
      failTotal: sumFails(st('ghidra_get_function_list_with_comments').fails),
      pct: ep(st('ghidra_get_function_list_with_comments').hits || 0, st('ghidra_get_function_list_with_comments').fails),
      fails: {...(st('ghidra_get_function_list_with_comments').fails || {})},
    },

    // ── 5. Shell ──────────────────────────────────────────────────────────────
    run_command: {
      hits: st('run_command').hits || 0,
      faultTotal: (st('run_command').fails||{spawnError:0}).spawnError || 0,
      missTotal: ((st('run_command').misses||{exitNonZero:0}).exitNonZero || 0)
               + ((st('run_command').misses||{timedOut:0}).timedOut    || 0),
      pct: ep(st('run_command').hits || 0, st('run_command').fails),
      fails: {...(st('run_command').fails || {})},
    },
  };
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
process.on('exit',    () => { try { syncToLifetime(); fs.writeFileSync(STATS_PATH, JSON.stringify(makeStatsDiskData(), null, 2), 'utf8'); } catch {} });
process.on('SIGTERM', () => { try { syncToLifetime(); fs.writeFileSync(STATS_PATH, JSON.stringify(makeStatsDiskData(), null, 2), 'utf8'); } catch {} process.exit(0); });
process.on('SIGHUP',  () => { try { syncToLifetime(); fs.writeFileSync(STATS_PATH, JSON.stringify(makeStatsDiskData(), null, 2), 'utf8'); } catch {} process.exit(0); });

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
  STATS_PATH,
  FAILURE_LOG_PATH,
  sumFails,
  logFailure,
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
