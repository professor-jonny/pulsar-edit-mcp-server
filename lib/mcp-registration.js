'use babel';
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { applyPatch, diffLines } = require('diff');
const { parseHunkOps, planRescueHunk, previewHunk, rescueStillValid } = require('./patch-rescue'); // 2026-11-19: apply-patch rescue rework
const { exec: _exec, spawn: _spawn } = require('child_process');
const { CompositeDisposable, Disposable } = require('atom');
const { checkLines: styleCheckLines, formatViolations: styleFormatViolations, isKernelFile } = require('./style-checker');
const { checkNaming, checkFunctionDocs, buildDocSkeleton, formatNamingViolations } = require('./naming-checker');
const { getSymbols, getSymbolsFromText, findFunction, resolveAnchor, braceEndRow: _tssBraceEndRow, resolveSymbolPosition, resolveStringPosition, resolveLinePosition, HINT_RADIUS } = require('./tree-sitter-symbols'); // v2
const { buildEditResponse, preEditSnapshot, postEditDelta } = require('./edit-response');
const { snapshot: structSnapshot } = require('./struct-check');
const { escapeRegex, applyReplacement, unpackReplaceArgs, globToRegex } = require('./string-utils');
const { walkDir, findFunctionInBuffer, readTextFromFile, retargetEditor, resolveProjectPath, recordKnownMtime } = require('./buffer-helpers'); // T3 (2026-09-17): findAnchor retired â€” last live caller (delete_block) ported onto resolveScope()/matchContent(); hint-gap closure (2026-09-19): resolveStructuralAnchor no longer used here â€” insert and delete both resolve banner/ifdefBlock via resolveScope()
const { buildSearchResponse } = require('./read-response');
const { maybeLintSuffix } = require('./lint-helpers');
const { TOOL_CATALOGUE, TOGGLEABLE_GROUPS } = require('./tool-catalogue');
const { shouldIgnore, reloadMcpIgnore: _reloadMcpIgnore, getMcpIgnoreInfo: _getMcpIgnoreInfo, initMcpIgnore } = require('./mcp-ignore');
const { makeRegisterMcpTool } = require('./tool-framework');
const { FILE_SCHEMA, ANCHOR_SCHEMA, STRUCTURAL_ANCHOR_SCHEMA, SCOPE_ANCHOR_SCHEMA, REGEX_REMOVED_PARAM } = require('./schema');
const { SCOPE_OBJECT_SCHEMA, withoutScopeHints } = require('./scope-arg'); // XW23 idea 1: one optional `scope` object for the position hints (replace, insert)
const { regexRefusal } = require('./regex-guard');
const { confirmDestructive, revealCommandPanel, DESTRUCTIVE_RE } = require('./command-confirm'); // 2026-11-04: a person approves destructive run-command calls (Run / Cancel in the Command Output panel)
const { occurrencesInLine, previewSummary, applyAndSave, commitResult } = require('./raf-commit'); // 2026-11-05: replace-across-files saves each file after a commit and its preview counts occurrences (TODO R3c, R3d)
const notesStore = require('./session-notes-store'); // 2026-11-05: one session-notes file per project folder
const {
  smartSuggestion, successNudge,
} = require('./tool-hints');
const { resolveScope, scopeErrorIsOutOfRange, matchContent: matchContentEngine, matchBlock, matchFunction, applyEdit, applyEditAll, buildFailResponse, buildCountedFailResponse, diagnoseFailure, buildInsertPreview, buildReplacePreview, retryNudge, applyEditSpan } = require('./match-engine'); // buildReplacePreview added 2026-09-25 for the new 'replace' tool (decision A: engine-native tool, built beside the old hand-rolled one for comparison); applyEditAll added 2026-09-25 (S5) for the upcoming replace-all/replace-across-files port
// B24/T2: insert migrated onto shared scope-resolution + match + fail-response engine (2026-07-19: afterContent/beforeContent branch ported onto matchContent(); aliased to matchContentEngine because insert's own handler used to have a parameter literally named matchContent, for onLine verification â€” the unaliased import was being shadowed by that parameter for the whole handler scope, silently calling undefined instead of the engine function. B44 follow-up, 2026-09-12: that param was renamed to expectedContent to remove the naming collision at its source â€” the matchContentEngine alias is kept as-is since it's harmless and other code already depends on the name). buildInsertPreview added 2026-07-20 (T2 completion) â€” collapses the 3 hand-rolled dryRun preview blocks below onto one shared builder.
const { planFragmentReplace, describeApplyError, isRetryableRefusal } = require('./replace-fragment'); // Stage 1(b) 2026-10-09: replace fragment refusals move onto this planner one path at a time
const { midLineHint, midLineAdvice, midLineWhat } = require('./mid-line-hint'); // R1e 2026-10-17 / R1h: whole-line replace failure knows when old_str starts/ends mid-line (match-engine.js builds the wording); R1j 2026-10-18: delete Mode 4 anchors build their own mid-line NOTE here
const { planReplaceAll } = require('./replace-all-plan'); // Stage 4b 2026-10-10: replace-all's match + expand moves onto this pure planner (lib/edit-match.js underneath)
const { countRefs, renderRepoMap, limitHealth } = require('./repo-map'); // get-repo-map 2026-11-18: one-pass ref counts, budgeted render, capped health block
const { planWrite, refuseExistingMessage } = require('./write-plan'); // write-file: create / overwrite / refuse
const { wholeFilePage } = require('./read-page'); // read with no anchor = whole file in pages (replaces read-file)
const { resolveProjectRoots } = require('./project-scope'); // project scoping 2026-11-18: which open project roots a project-wide tool covers
// project param for the project-wide tools: the active file's project by default, 'all' for every open root, or a folder name.
const _projectRoots = (project) => resolveProjectRoots(atom.project.getPaths(), project, (atom.workspace.getActiveTextEditor() || { getPath: () => null }).getPath());
const { runSed, buildSedPreview, diffLines: _sedDiffLines } = require('./sed-tool'); // R4d 2026-10-24: the sed tool runs GNU sed 4.9 semantics (lib/sed-parse.js + lib/sed-run.js) through this pure wrapper; replaces lib/sed-plan.js
// XW23: 0-based rows an edit changed (added lines, plus deletion points), so lint reports only those instead of the whole file.
const _changedRows = (before, after) => {
  const d = _sedDiffLines(before.split('\n'), after.split('\n'));
  return d.added.map(a => a.row - 1).concat(d.removed.map(r => Math.max(0, r.row - 1)));
};
const { findSubstringInLines } = require('./substring-lines'); // 2026-10-15: the read tool's pair-anchor substring fallback, extracted from the read handler so it can be unit tested
const { compilePattern, scanLines, regexHint, regexHintSuffix, caseHintForLines, makeCaseProbe, caseNoteSuffix } = require('./search-engine'); // read-side counterpart to match-engine.js â€” shared loop for grep-file/grep-project
const {
  SESSION_DIR,
  editStats, lifetimeStats, styleStats, lifetimeStyleStats,
  getStatsPaused, setStatsPaused,
  STATS_PATH, FAILURE_LOG_PATH, SESSION_HISTORY_PATH,
  logFailure, appendSessionHistory,
  flushLifetimeStats, makeStatsDiskData, syncToLifetime, resetLastSynced,
  bump, bumpStyle, bumpApplyPatchFailure,
  summarise, buildReport, buildStyleReport, shapeStatsReport,
} = require('./edit-stats');
const { fixHunkHeaders } = require('./patch-utils');
const { saveModifiedEditors, notSavedWarningLines } = require('./preflight-save'); // R3p (2026-11-09): a buffer that cannot be saved no longer stops run-command
// ---------------------------------------------------------------------------
// Platform helper: pick the right shell for run-command
// ---------------------------------------------------------------------------
const IS_WINDOWS = process.platform === "win32";
function getShell() {
  if (IS_WINDOWS) return { shell: "powershell.exe", flag: "-Command" };
  return { shell: "/bin/sh", flag: "-c" };
}

const packageDisposables = new CompositeDisposable();
// Subscribe to project root changes so .mcp-ignore stays in sync when the user
// switches project folders. initMcpIgnore() also does an immediate reload now
// that atom.project is fully ready (module was loaded via restartServer which
// is deferred until onDidActivateInitialPackages).
packageDisposables.add(initMcpIgnore());
const activeHighlightSets = [];

// ---------------------------------------------------------------------------


// Regex and helper for "is this a source code file" checks â€” used throughout
// to gate code-specific tool hints. Centralised here so the extension list only
// needs to be updated in one place.
const CODE_FILE_RE = /\.(js|ts|jsx|tsx|c|cpp|h|cs|py|java|go|rs)$/i;
function isCodeFilePath(p) { return CODE_FILE_RE.test(p || ""); }

// Returns a blocked-response object if the active editor's file is in .mcp-ignore,
// or null if the file is allowed. Call at the top of every edit tool handler:
//   const _blocked = _checkIgnored(editor); if (_blocked) return _blocked;
function _checkIgnored(editor) {
  const fp = editor && editor.getPath();
  if (fp && shouldIgnore(fp)) {
    return { content: [{ type: 'text', text: `\u26d4 mcp-ignore: "${fp}" is ignored \u2014 edit blocked.\nRemove the matching rule from .mcp-ignore to allow edits to this file.` }] };
  }
  return null;
}

/* Returns true for Ghidra-decompiled C files â€” detected by filename pattern
 * (.bin.c / .xbe.c) or high density of FUN_/DAT_/PTR_ identifiers.
 * Used to gate style checks off for decompiled pseudocode. */
const GHIDRA_NAME_RE = /\.(bin|xbe|exe|dll|elf)\.[ch]$/i;
const GHIDRA_IDENT_RE = /\b(FUN_|DAT_|PTR_|LAB_|SUB_)[0-9a-fA-F]{4,}/;
function isGhidraFile(filePath, text) {
  if (!filePath) return false;
  if (GHIDRA_NAME_RE.test(filePath)) return true;
  if (!text) return false;
  /* Count FUN_/DAT_/PTR_ identifiers â€” if density > 1 per 20 lines it's decompiled output */
  const lines = text.split('\n').length || 1;
  const matches = (text.match(new RegExp(GHIDRA_IDENT_RE.source, 'g')) || []).length;
  return (matches / lines) > 0.05;
}


// Stores the last fuzzy-rescued patch hunks so confirm:true can apply them
// without re-parsing. Cleared on successful apply or on a new patch attempt.
const patchRescueStore = { hunks: null, patchKey: null };


// ---------------------------------------------------------------------------
// bumpStyle(type, n) â€” increment a styleStats violation counter (session + lifetime).
// applyStyleCheck(newStr, filePath, lineOffset?) â€” run style checker on a snippet (isWholeFile=false), return inline suffix string.
// lineOffset (0-based, default 0) shifts reported violation line numbers to be absolute buffer lines
// instead of relative to the start of newStr â€” pass the insert row for insert's commit sites.
// ---------------------------------------------------------------------------

function applyStyleCheck(newStr, filePath, lineOffset = 0) {
  if (!isKernelFile(filePath)) return '';
  try {
    const { violations, totalViolations } = styleCheckLines(newStr, filePath, false, lineOffset);
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

// ---------------------------------------------------------------------------
// Debug log ring buffer â€” capped at 100 entries, survives across tool calls
// ---------------------------------------------------------------------------
const DEBUG_LOG_MAX = 100;
const debugLog = [];

// Last file path successfully committed by any edit tool â€” exposed via
// getLastEditedFilePath() so the package menu "Show Last Edited File" command
// can focus that tab without the framework needing to know about Pulsar's workspace.
let lastEditedFilePath = null;
function getLastEditedFilePath() { return lastEditedFilePath; }

// Log a hint-resolution failure to the fault log.
// Called at every early-return hint failure site (afterNotFound, outOfScope, etc.)
// so the fault log distinguishes hint failures from content failures (noMatch).
// reason: 'notFound' | 'ambiguous' | 'needsTreeSitter'
function logHintFailure({ tool, hintName, hintValue, reason, filePath, oldStr }) {
  logFailure({
    tool,
    reason: `hintFault:${hintName}:${reason}`, // e.g. "hintFault:afterString:notFound"
    filePath,
    hintsSet: [hintName],
    hintValue: typeof hintValue === 'string' ? hintValue.substring(0, 80) : String(hintValue),
    oldStrPreview: oldStr ? oldStr.split('\n').slice(0, 6).map((l, i) => `[${i + 1}]: ${l}`).join('\n') : null,
    diffVsBuffer: null,
    bufferPreview: null,
  });
}

// Shared match-failure fault logger (2026-09-28, PJ requirement): every tool's
// failures must record every active hint (not just the one that failed), the
// proposed new_str, a diff against the buffer, and a buffer preview -- not just
// a bare reason string. Generalises the closest-area/diff logic replace's
// own no-match branch has always had (mcp-registration.js ~L990-1023) so any
// tool can get the same diagnostic richness in the fault log. Pure logging --
// never affects what the LLM sees, only what get-failure-log can show later.
// Optional `extra` (object): tool-specific fields merged into the record (e.g. replace-function-body's
// availableFunctions / closestMatches). Spread FIRST so the standard fields below always win.
function logMatchFailure({ tool, filePath, reason, needle, proposedNewStr, allLines, hints, extra }) {
  const hintsSet = Object.entries(hints || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k]) => k);
  const lines = String(needle ?? '').split('\n');
  const firstMeaningful = lines.find(l => l.trim().length > 3) || lines[0] || '';
  const words = firstMeaningful.trim().split(/\s+/).filter(w => w.length > 3);
  let fuzzyRow = -1, bestScore = 0;
  if (words.length > 0) {
    for (let i = 0; i < allLines.length; i++) {
      const score = words.filter(w => allLines[i].includes(w)).length;
      if (score > bestScore) { bestScore = score; fuzzyRow = i; }
    }
    const minPlausible = words.length <= 2 ? 1 : Math.ceil(words.length / 2);
    if (bestScore < minPlausible) fuzzyRow = -1;
  }
  const diffRow  = fuzzyRow >= 0 ? fuzzyRow : 0;
  const bufSlice = allLines.slice(diffRow, diffRow + lines.length).join('\n');
  const hunks    = diffLines(String(needle ?? ''), bufSlice);
  const diffOut  = [];
  for (const h of hunks) {
    const hLines = h.value.split(/\r?\n/);
    if (hLines[hLines.length - 1] === '') hLines.pop();
    if (h.added)        hLines.forEach(l => diffOut.push(`+ ${l}`));
    else if (h.removed) hLines.forEach(l => diffOut.push(`- ${l}`));
    else                hLines.forEach(l => diffOut.push(`  ${l}`));
  }
  const previewStart = Math.max(0, diffRow - 5);
  const previewEnd   = Math.min(allLines.length - 1, diffRow + lines.length + 4);
  const bufferPreview = allLines.slice(previewStart, previewEnd + 1)
    .map((l, i) => `L${previewStart + i + 1}: ${l}`).join('\n');
  logFailure({
    ...(extra || {}),
    tool, reason, filePath, hintsSet,
    oldStrPreview: lines.slice(0, 6).map((l, i) => `[${i + 1}]: ${l}`).join('\n'),
    proposedNewStr: proposedNewStr != null
      ? String(proposedNewStr).split('\n').slice(0, 6).map((l, i) => `[${i + 1}]: ${l}`).join('\n')
      : null,
    diffVsBuffer: diffOut.slice(0, 60).join('\n'),
    bufferPreview,
  });
}

function dbg(toolName, msg, data) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const entry = data !== undefined
    ? `[${ts}] [${toolName}] ${msg} ${JSON.stringify(data)}`
    : `[${ts}] [${toolName}] ${msg}`;
  if (debugLog.length >= DEBUG_LOG_MAX) debugLog.shift();
  debugLog.push(entry);
}

function mcpRegistration(server, linterRegistry = null, getMessages = null, groups = {}, chatPanel = null, getCommandTerminalPanel = null) {
  // Helper: returns true when a group is enabled (default: true)
  const g = (name) => groups[name] !== false;

  // â”€â”€ Tool Framework â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // registerMcpTool: framework-managed wrapper around server.registerTool()
  // for tools that have been migrated to the new pattern.
  const registerMcpTool = makeRegisterMcpTool(server, {
    bump,
    buildEditResponse,
    decorateEditedLines,
    applyStyleCheck,
    maybeLintSuffix,
    smartSuggestion,
    successNudge, // B32: gated via features.successNudge in ctx.commit()
    onCommit: (fp) => { lastEditedFilePath = fp; },
  });

  // Wrap every tool handler so errors surface in the chat panel as well as
  // returning to the LLM. Without this, tool exceptions are silently swallowed
  // by the MCP SDK transport layer and the user has no visibility into failures.
  // enable-group runs this whole function again, so keep the SDK's own registerTool and wrap it only once.
  const origRegister = server.__origRegisterTool || (server.__origRegisterTool = server.registerTool.bind(server));
  // The catalogue (lib/tool-catalogue.js) says which group each tool is in; a tool whose group is off is not registered.
  const _toolGroup = {};
  for (const _t of TOOL_CATALOGUE) _toolGroup[_t.name] = _t.group;

  // Tools with NO active-editor file context -- meta/shell tools that should
  // still work even when the active file is ignored (so the LLM can navigate
  // away, check stats, run commands, etc). Everything else is blocked when
  // the active editor's file matches a .mcp-ignore rule.
  const IGNORE_EXEMPT = new Set([
    'get-edit-stats', 'session-notes', 'get-debug-log', 'get-failure-log',
    'list-open-files', 'get-file-info', 'open-file',
    'list-tools', 'enable-group',
    'get-project-files', 'grep-project', // walkDir already filters
    'run-command',
  ]);


  server.registerTool = (name, meta, handler) => {
    // A tool that is already registered stays as it is (the SDK throws on a second registration).
    if (server._registeredTools && server._registeredTools[name]) return server._registeredTools[name];
    const _grp = _toolGroup[name];
    if (_grp && _grp !== 'core' && !g(_grp)) return undefined;
    return origRegister(name, meta, async (args) => {
      const _refusal = regexRefusal(name, args); // R2a: see lib/regex-guard.js
      if (_refusal) return _refusal;
      // Block all tools (except meta/shell exemptions) when the active editor's
      // file matches .mcp-ignore rules. Consistent: if the server can't see the
      // file it can't edit it either -- no confusing partial access.
      if (!IGNORE_EXEMPT.has(name)) {
        const _blocked = _checkIgnored(atom.workspace.getActiveTextEditor());
        if (_blocked) return _blocked;
      }
      try {
        return await handler(args);
      } catch (err) {
        if (chatPanel) chatPanel.appendFault(name, err.message || String(err));
        throw err;   // re-throw so the MCP SDK still returns an error response to the LLM
      }
    });
  };

  // -- EDIT GROUP ------------------------------------------------------------
  if (g('edit')) {
  // -- write-file (2026-11-18): replaces create-file and replace-document -----------------------------
  if (g('edit')) registerMcpTool({
    name:     'write-file',
    group:    'edit',
    category: 'edit',
    features: { styleCheck: true },
    title:    'Write File',
    description: [
      'Write `text` as the WHOLE content of `filePath` (required). A new path: the file and its folders are created and it opens in a tab. An existing file: refused unless overwrite:true, which replaces all of its content through the editor buffer (undo works).',
      'To change part of a file use replace, insert or delete. Returns lineCount and created.',
    ].join(' '),
    inputSchema: { ...FILE_SCHEMA, text: z.string().optional(), overwrite: z.boolean().optional() },
    handler: async ({ text = '', overwrite = false }, ctx) => {
      const plan = planWrite({ exists: fs.existsSync(ctx.filePath), overwrite });
      if (plan === 'refuse') return { content: [{ type: 'text', text: refuseExistingMessage(ctx.filePath) }], created: false, found: true };
      if (plan === 'create') await fs.promises.mkdir(path.dirname(ctx.filePath), { recursive: true });
      ctx.snapshotOriginal();
      ctx.buffer.setText(text);
      const lines = text.split(/\r?\n/);
      const linesChanged = plan === 'create' ? lines.length : lines.length - ctx._originalText.split(/\r?\n/).length;
      const committed = await ctx.commit(
        { line: 1, linesChanged, scopeLabel: '', tags: [] },
        { style: applyStyleCheck(text, ctx.filePath) }
      );
      let opened = false, lintTail = '';
      if (plan === 'create') {
        // a new file is saved by commit(); open it so the user sees it and report a lint count like the old create-file
        try {
          const ed = await atom.workspace.open(ctx.filePath);
          opened = true;
          lintTail = (await maybeLintSuffix(false, ed, null, null, { countOnly: true })) || '';
        } catch (_e) { /* saved, but the tab could not be opened */ }
      }
      const headline = `${plan === 'create' ? 'Created' : 'Replaced'}: ${ctx.filePath} - ${lines.length} lines${plan === 'create' && !opened ? ' (saved, tab not opened)' : ''}`;
      const body = (committed.content && committed.content[0] && committed.content[0].text) || '';
      return {
        ...committed,
        content: [{ type: 'text', text: headline + (body ? '\n' + body : '') + lintTail }],
        created: plan === 'create', lineCount: lines.length, filePath: ctx.filePath,
      };
    },
  });

  // â”€â”€ insert (migrated to Tool Framework) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (g('edit')) registerMcpTool({
    name:     'insert',
    group:    'edit',
    category: 'edit',
    features: { dryRun: true, lint: true, styleCheck: true, consecutiveFailureCounter: true, successNudge: true, structCheck: true, resendlessCommit: true },
    title:    'Insert',
    description: [
      "Insert new lines into `filePath` (required) without changing existing content. Pick ONE anchor:",
      "(0) endOfFile:true / startOfFile:true - always resolve to the file's current last/first line, so they never drift.",
      "(1) afterFunction:'fn' inserts after that function's closing brace; beforeFunction:'fn' before its opening line (tree-sitter, drift-immune).",
      "(2) afterString:'text' / beforeString:'text' - after/before the line containing that unique text.",
      "(3) afterSymbol:'name' / beforeSymbol:'name' - same as (1) for any tree-sitter symbol (class, struct, const).",
      "(4) betweenHint:{start,end} - inserts right after the start anchor's line; both anchors must resolve.",
      "(5) banner:'text' inserts after a section banner comment; ifdefBlock:'MACRO' (+ ifdefEdge:'open'|'close') after the matching #endif, or after just that directive line when ifdefEdge is given.",
      "(6) occurrence:N targets the Nth match when an anchor appears more than once.",
      "(7) Line numbers (positional, they drift): afterLine:N inserts after line N; onLine:N makes the new text become line N (old line N moves down) and, with expectedContent:'text', verifies line N first and fails loudly on a mismatch; beforeLine:N makes the new text line N-1.",
      "dryRun:true previews without writing. Then insert({ filePath, commitLastPreview:true }) applies that exact preview without resending new_str; it only works right after the preview, and different args or another edit to the file clears it.",
      "After any insert, line numbers below it shift: re-read before reusing them.",
    ].join(" "),
    inputSchema: {
      // new_str is normally required, but must be optional at the schema
      // level so a bare {filePath, commitLastPreview:true} call can pass MCP's
      // transport-level validation and actually reach the handler, where
      // tool-framework.js's splice logic runs BEFORE any of insert's own
      // "new_str is required" checks. The handler's own logic (not Zod) is
      // responsible for rejecting a real call that omits new_str without
      // commitLastPreview:true.
      new_str:         z.string().optional(),
      commitLastPreview: z.boolean().optional(),
      endOfFile:       z.boolean().optional(),
      startOfFile:     z.boolean().optional(),
      onLine:          z.number().optional(),
      expectedContent: z.string().optional(),
      // XW23 step 2: afterString, afterFunction, afterLine, ... are described by `scope` only; flat names still work (passthrough).
      ...withoutScopeHints(STRUCTURAL_ANCHOR_SCHEMA),
      scope:           SCOPE_OBJECT_SCHEMA,
    },
    handler: async ({ afterLine, beforeLine, onLine, expectedContent, new_str, endOfFile = false, startOfFile = false, afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterString, beforeString, betweenHint, afterContent, beforeContent, inFunction, banner, ifdefBlock, ifdefEdge, hintRadius, occurrence, fuzzyWhitespace = false, fuzzyContent = false, dryRun = false, lint = false }, ctx) => {
            const { editor, buffer, allLines } = ctx;
      const curTool   = 'insert';
      const lineCount = allLines.length;
      const isCodeFile = isCodeFilePath(ctx.filePath); // B23

      // new_str is optional in the schema only so a bare commitLastPreview:true
      // call can pass MCP transport validation and reach tool-framework.js's
      // splice logic (which runs before this handler body and replaces args
      // with a stashed, complete call before we ever get here). If we reach
      // this point with new_str still missing, this is a genuine real call
      // that omitted it without going through the splice path â€” reject with
      // the same message Zod would have given, so the caller-facing behavior
      // is unchanged for every call that isn't the narrow resend-nothing shape.
      if (new_str === undefined) {
        return { content: [{ type: 'text', text: '\u274C new_str is required (unless calling with just { filePath, commitLastPreview: true } to commit a previous dry-run preview).' }], inserted: false };
      }
      const _radius    = hintRadius ?? HINT_RADIUS;

      // -- endOfFile anchor ---------------------------------------------------
      if (endOfFile) {
        bump('insert', 'hintsUsed.endOfFile');
        const insertRow = lineCount;
        if (dryRun) {
          const r        = 3;
          const cs       = Math.max(0, insertRow - r);
          const ctxLines = allLines.slice(cs, insertRow).map((l, i) => `${String(cs + i + 1).padStart(4)}   ${l}`);
          const insLines = new_str.split("\n").map(l => `${" ".repeat(4)} + ${l}`);
          return { content: [{ type: "text", text: [
            `\uD83D\uDD0D DRY RUN \u2014 will insert ${new_str.split("\n").length} line(s) at end of file (after line ${lineCount}).`,
            `\nContext (+ = lines to be inserted):\n${[...ctxLines, ...insLines].join("\n")}`,
            `\nReply with the same call without dryRun (or dryRun:false) to commit \u2014 or just insert({ filePath, commitLastPreview: true }) to apply this exact preview without resending new_str.`
          ].join("\n") }], dryRun: true, insertRow: insertRow + 1, lineCount };
        }
        // XW1: a file whose last line has no newline: append after that line, do not join onto it
        const _lastRow = lineCount - 1;
        if (lineCount > 0 && allLines[_lastRow] !== '') {
          buffer.insert([_lastRow, allLines[_lastRow].length], "\n" + new_str.replace(/\n$/, ''));
        } else {
          buffer.insert([insertRow, 0], new_str.endsWith("\n") ? new_str : new_str + "\n");
        }
        ctx.consec.count = 0; bump('insert', 'hits');
        const newLineCount = buffer.getLineCount();
        const _lintSuffix  = await maybeLintSuffix(lint, editor, insertRow, insertRow + new_str.split("\n").length - 1);
        const _styleSuffix = applyStyleCheck(new_str, ctx.filePath, insertRow);
        return {
          ...(await buildEditResponse({ tool: curTool, line: insertRow + 1, linesChanged: new_str.split('\n').length, scopeLabel: ' at end of file', buffer }, { lint: _lintSuffix, style: _styleSuffix })),
          dryRun: false, newLineCount
        };
      }

      // -- startOfFile anchor (T5 â€” symmetric with endOfFile, equally drift-immune) --
      // Always resolves to row 0 dynamically at call time, same as endOfFile always
      // resolving to the current last line â€” neither is a stale/positional number,
      // so both belong with the content anchors below, not with the positional caution given to afterLine/onLine/beforeLine.
      if (startOfFile) {
        bump('insert', 'hintsUsed.startOfFile');
        const insertRow = 0;
        if (dryRun) {
          const r        = 3;
          const ce       = Math.min(lineCount - 1, r);
          const insLines = new_str.split("\n").map(l => `${" ".repeat(4)} + ${l}`);
          const ctxLines = allLines.slice(0, ce + 1).map((l, i) => `${String(i + 1).padStart(4)}   ${l}`);
          return { content: [{ type: "text", text: [
            `ðŸ” DRY RUN â€” will insert ${new_str.split("\n").length} line(s) at start of file (before line 1).`,
            `\nContext (+ = lines to be inserted):\n${[...insLines, ...ctxLines].join("\n")}`,
            `\nReply with the same call without dryRun (or dryRun:false) to commit \u2014 or just insert({ filePath, commitLastPreview: true }) to apply this exact preview without resending new_str.`
          ].join("\n") }], dryRun: true, insertRow: 1, lineCount };
        }
        const textWithNewline = new_str.endsWith("\n") ? new_str : new_str + "\n";
        buffer.insert([insertRow, 0], textWithNewline);
        ctx.consec.count = 0; bump('insert', 'hits');
        const newLineCount = buffer.getLineCount();
        const _lintSuffixSOF  = await maybeLintSuffix(lint, editor, insertRow, insertRow + new_str.split("\n").length - 1);
        const _styleSuffixSOF = applyStyleCheck(new_str, ctx.filePath, insertRow);
        return {
          ...(await buildEditResponse({ tool: curTool, line: 1, linesChanged: new_str.split('\n').length, scopeLabel: ' at start of file', buffer }, { lint: _lintSuffixSOF, style: _styleSuffixSOF })),
          dryRun: false, newLineCount
        };
      }

      // -- Symbol/string anchors via Universal Match Engine (B24/T2) --------
      if (afterFunction !== undefined || beforeFunction !== undefined ||
          afterSymbol   !== undefined || beforeSymbol   !== undefined ||
          afterString   !== undefined || beforeString   !== undefined ||
          betweenHint   !== undefined ||
          banner   !== undefined || ifdefBlock   !== undefined) {
        const hintName = afterFunction !== undefined ? 'afterFunction'
                        : beforeFunction !== undefined ? 'beforeFunction'
                        : afterSymbol   !== undefined ? 'afterSymbol'
                        : beforeSymbol  !== undefined ? 'beforeSymbol'
                        : afterString   !== undefined ? 'afterString'
                        : beforeString  !== undefined ? 'beforeString'
                        : banner   !== undefined ? 'banner'
                        : ifdefBlock  !== undefined ? 'ifdefBlock'
                        : 'betweenHint';
        // banner/ifdefBlock resolve to a ROW RANGE (banner / #ifdef..#endif),
        // and insert lands after the range's LAST row, not its first -- so they
        // are handled apart from the single-row anchors below.
        const isStructural = hintName === 'banner' || hintName === 'ifdefBlock';
        // betweenHint has no after/before direction of its own â€” insert lands
        // immediately after the region's start anchor (betweenHint.end is still
        // resolved and validated by resolveScope, but only bounds the region;
        // it does not currently narrow ambiguity for insert's other hints).
        const dir = (hintName === 'betweenHint' || isStructural) ? 'after' : (hintName.startsWith('after') ? 'after' : 'before');
        bump('insert', `hintsUsed.${hintName}`);
        if (occurrence > 1) bump('insert', 'hintsUsed.occurrence');

        const scope = resolveScope({
          editor, buffer, allLines, text: ctx.text, filePath: ctx.filePath,
          params: { afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterString, beforeString, betweenHint, banner, ifdefBlock, ifdefEdge, occurrence, hintRadius: _radius, fuzzyWhitespace },
        });

        if (scope.error) {
          ctx.consec.count++;
          bump('insert', scopeErrorIsOutOfRange(scope.error, occurrence) ? 'fails.outOfRange' : 'fails.anchorNotFound');
          logMatchFailure({
            tool: curTool, filePath: ctx.filePath,
            reason: scope.error.kind || 'anchorNotFound',
            needle: null, proposedNewStr: new_str, allLines,
            hints: { afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterString, beforeString,
                     betweenHint, banner, ifdefBlock, ifdefEdge, occurrence, hintRadius, fuzzyWhitespace },
          });
          const fail = buildFailResponse({ tool: curTool, ctx: { consec: ctx.consec, allLines, text: ctx.text }, scope, needle: null, isCodeFile });
          return { ...fail, inserted: false };
        }

        const insertRow  = isStructural ? scope.endAnchorRow + 1 : (dir === 'after' ? scope.anchorRow + 1 : scope.anchorRow);
        const scopeLabel = isStructural
          ? ` after ${hintName} "${hintName === 'banner' ? banner : ifdefBlock}" (after line ${scope.endAnchorRow + 1})`
          : `${scope.scopeLabel || ` ${hintName} anchor`} (anchor line ${scope.anchorRow + 1})`;

        if (dryRun) {
          return buildInsertPreview({ allLines, lineCount, insertRow, new_str, suffix: scopeLabel, beforeOffset: isStructural ? 1 : 0 });
        }

        const textWithNewline = new_str.endsWith('\n') ? new_str : new_str + '\n';
        const _preSnapME = preEditSnapshot(editor);
        buffer.insert([insertRow, 0], textWithNewline);
        const _structSuffixME = postEditDelta(_preSnapME, editor).struct;
        ctx.consec.count = 0; bump('insert', 'hits');
        bump('insert', `hintsSucceeded.${hintName}`);
        if (occurrence > 1) bump('insert', 'hintsSucceeded.occurrence');
        const newLineCount = buffer.getLineCount();
        const _lintSuffixME  = await maybeLintSuffix(lint, editor, insertRow, insertRow + new_str.split('\n').length - 1);
        const _styleSuffixME = applyStyleCheck(new_str, ctx.filePath, insertRow);
        const _nudgeME = successNudge({
          toolName: curTool,
          noHintsUsed: false,
          afterLineOnly: false,
          matchedLineContent: allLines[scope.anchorRow] || '',
          fileLines: allLines.length,
          oldStr: null,
          filePath: ctx.filePath, // XW23: once-per-file "no scope hint" nudge
          isCodeFile,
        });
        return { ...(await buildEditResponse({ tool: curTool, line: insertRow + 1, linesChanged: new_str.split('\n').length, scopeLabel, buffer }, { nudge: _nudgeME, lint: _lintSuffixME, style: _styleSuffixME, struct: _structSuffixME })), dryRun: false, newLineCount };
      }
      // -- Content-anchored insert (afterContent / beforeContent) -----------
      // B24/T2 (2026-07-19): migrated onto the shared match-engine pipeline â€”
      // was previously the last insert branch still calling findAnchor()
      // directly (see mcp-server-refactor-plan.md "Full replace -> insert
      // Feature Parity Inventory"). Now inherits the same 5-tier match/rescue
      // cascade, scanForOldStr diagnostics, ambiguityCheck, successNudge, and
      // struct-check that replace has â€” none of that is reimplemented
      // here, it all comes from resolveScope()/matchContent()/buildFailResponse().
      if (afterContent !== undefined || beforeContent !== undefined) {
        if (afterContent  !== undefined) bump('insert', 'hintsUsed.afterContent');
        if (beforeContent !== undefined) bump('insert', 'hintsUsed.beforeContent');
        if (inFunction)                bump('insert', 'hintsUsed.inFunction');
        if (occurrence > 1)              bump('insert', 'hintsUsed.occurrence');
        const anchor      = afterContent !== undefined ? afterContent : beforeContent;
        const insertAfter = afterContent !== undefined;
        const scopeLabel  = inFunction ? ` within function "${inFunction}"` : "";
        const hintName    = afterContent !== undefined ? 'afterContent' : 'beforeContent';

        // inFunction narrows the search the same way it does for replace;
        // with no inFunction, the whole file is the window (resolveScope's
        // no-hint fallback) â€” matchContent's own ambiguity guard then covers
        // "found more than once" the same way it does for replace.
        const scope = resolveScope({
          editor, buffer, allLines, text: ctx.text, filePath: ctx.filePath,
          params: { inFunction, occurrence, hintRadius: _radius, fuzzyWhitespace },
        });
        if (scope.error) {
          ctx.consec.count++;
          bump('insert', scopeErrorIsOutOfRange(scope.error, occurrence) ? 'fails.outOfRange' : 'fails.anchorNotFound');
          logMatchFailure({
            tool: curTool, filePath: ctx.filePath,
            reason: scope.error.kind || 'anchorNotFound',
            needle: anchor, proposedNewStr: new_str, allLines,
            hints: { inFunction, afterContent, beforeContent, occurrence, hintRadius, fuzzyWhitespace },
          });
          const fail = buildFailResponse({ tool: curTool, ctx: { consec: ctx.consec, allLines, text: ctx.text }, scope, needle: anchor, isCodeFile });
          return { ...fail, inserted: false };
        }

        const match = matchContentEngine(anchor, { allLines, text: ctx.text }, scope, { fuzzyWhitespace, fuzzyContent, occurrence });

        if (!match.matched) {
          ctx.consec.count++;
          bump('insert', match.reason === 'occurrenceOutOfRange' ? 'fails.outOfRange' : 'fails.anchorNotFound');
          logMatchFailure({
            tool: curTool, filePath: ctx.filePath,
            reason: match.reason || 'noMatch',
            needle: anchor, proposedNewStr: new_str, allLines,
            hints: { inFunction, afterContent, beforeContent, occurrence, hintRadius, fuzzyWhitespace, fuzzyContent },
          });
          // R1j 2026-10-18: afterContent/beforeContent match WHOLE lines like replace's old_str; tell the caller when the anchor only fails because it starts/ends mid-line (subject = their own parameter name).
          const _midLine = match.reason === 'ambiguous' ? null : midLineHint({ needle: anchor, text: ctx.text, scopeStart: scope && scope.searchStart, scopeEnd: scope && scope.searchEnd, fuzzyWhitespace, fuzzyContent });
          const fail = buildFailResponse({ tool: curTool, ctx: { consec: ctx.consec, allLines, text: ctx.text }, scope, match, needle: anchor, isCodeFile, midLine: _midLine, subject: hintName });
          return { ...fail, inserted: false };
        }

        const anchorRow   = match.matchLine;
        const anchorEnd   = match.matchEndLine;
        const insertRow   = insertAfter ? anchorEnd + 1 : anchorRow;
        const strategyMsg = (match.transforms || []).length ? ` (matched via ${match.transforms.join(', ')} \u2014 consider tightening your anchor)` : "";

        if (dryRun) {
          return buildInsertPreview({
            allLines, lineCount, insertRow, new_str,
            suffix: ` ${insertAfter ? "after" : "before"} anchor (line ${anchorRow + 1})${scopeLabel}${strategyMsg}`,
            beforeOffset: insertAfter ? 0 : 1,
          });
        }

        const textWithNewline = new_str.endsWith("\n") ? new_str : new_str + "\n";
        const _preSnap = preEditSnapshot(editor);
        buffer.insert([insertRow, 0], textWithNewline);
        const _structSuffix = postEditDelta(_preSnap, editor).struct;
        ctx.consec.count = 0; bump('insert', 'hits');
        if (inFunction)                   bump('insert', 'hintsSucceeded.inFunction');
        if (afterContent  !== undefined)  bump('insert', 'hintsSucceeded.afterContent');
        if (beforeContent !== undefined)  bump('insert', 'hintsSucceeded.beforeContent');
        if (occurrence > 1)               bump('insert', 'hintsSucceeded.occurrence');
        const newLineCount = buffer.getLineCount();
        const _lintSuffix2  = await maybeLintSuffix(lint, editor, insertRow, insertRow + new_str.split("\n").length - 1);
        const _styleSuffix2 = applyStyleCheck(new_str, ctx.filePath, insertRow);
        const _nudge = successNudge({
          toolName: curTool,
          noHintsUsed: !inFunction,
          afterLineOnly: false,
          matchedLineContent: allLines[anchorRow] || '',
          fileLines: allLines.length,
          oldStr: anchor,
          filePath: ctx.filePath, // XW23: once-per-file "no scope hint" nudge
          isCodeFile,
        });
        const _tags = (match.transforms || []).slice();
        return {
          ...(await buildEditResponse(
            { tool: curTool, line: insertRow + 1, linesChanged: new_str.split('\n').length, scopeLabel, tags: _tags, buffer },
            { nudge: _nudge, lint: _lintSuffix2, style: _styleSuffix2, struct: _structSuffix }
          )),
          dryRun: false, newLineCount
        };
      }

      // -- Line-number-based insert ------------------------------------------
      if (afterLine === undefined && beforeLine === undefined && onLine === undefined) {
        return { content: [{ type: "text", text: "\u274C Either afterLine, beforeLine, onLine, afterFunction/beforeFunction, afterString/beforeString, afterSymbol/beforeSymbol, afterContent/beforeContent, betweenHint, banner, ifdefBlock, endOfFile, or startOfFile is required." }], inserted: false };
      }

      // -- afterLine / beforeLine / onLine (B37) -----------------------------
      // Normalize the three positional-line params onto a single resolved row +
      // label, so the rest of the block below (dryRun preview, range check,
      // commit) stays shared across all three.
      let _positionalMode = null; // 'afterLine' | 'beforeLine' | 'onLine'
      let _targetLine = null;     // the 1-based line number the caller supplied
      if (onLine !== undefined) { _positionalMode = 'onLine'; _targetLine = onLine; }
      else if (beforeLine !== undefined) { _positionalMode = 'beforeLine'; _targetLine = beforeLine; }
      else { _positionalMode = 'afterLine'; _targetLine = afterLine; }
      // 2026-09-30: positional hints were never counted in insert.hintsUsed (the other
      // branches all bump theirs at attempt time). expectedContent only applies to onLine.
      bump('insert', `hintsUsed.${_positionalMode}`);
      if (_positionalMode === 'onLine' && expectedContent !== undefined) bump('insert', 'hintsUsed.expectedContent');

      if (_positionalMode === 'onLine' && expectedContent !== undefined) {
        const _actualLineText = allLines[_targetLine - 1];
        if (_actualLineText === undefined || !_actualLineText.includes(expectedContent)) {
          ctx.consec.count++;
          bump('insert', 'fails.onLineContentMismatch');
          logMatchFailure({
            tool: 'insert', filePath: ctx.filePath, reason: 'contentMismatch',
            needle: expectedContent, proposedNewStr: new_str, allLines,
            hints: { onLine: _targetLine, expectedContent },
          });
          return { content: [{ type: "text", text: [
            `\u274C onLine:${_targetLine} content mismatch \u2014 expected line ${_targetLine} to contain ${JSON.stringify(expectedContent)}.`,
            _actualLineText !== undefined
              ? `Actual line ${_targetLine}: ${JSON.stringify(_actualLineText)}`
              : `Line ${_targetLine} does not exist (file has ${lineCount} lines).`,
            smartSuggestion({ toolName: "insert", counter: ctx.consec, noHintsUsed: false, fileLines: lineCount, oldStr: null, isCodeFile })
          ].filter(Boolean).join("\n") }], inserted: false, consecFailures: ctx.consec.count };
        }
      }

      // Range-check against the caller's own 1-based line number (1..lineCount+1
      // â€” appending right after the last line is valid for afterLine; for
      // beforeLine/onLine the practical upper bound is lineCount, but allowing
      // lineCount+1 here too keeps one shared check simple and matches "insert
      // at end" being reachable via endOfFile anyway).
      if (_targetLine < 1 || _targetLine > lineCount + 1) {
        ctx.consec.count++;
        bump('insert', 'fails.outOfRange');
        const r   = 4;
        const cs  = Math.max(0, lineCount - r);
        const ctx2 = allLines.slice(cs).map((l, i) => `${String(cs + i + 1).padStart(4)}: ${l}`).join("\n");
        return { content: [{ type: "text", text: [
          `\u274C ${_positionalMode}:${_targetLine} is out of range (1\u2013${lineCount + 1}). File has ${lineCount} lines.`,
          `\n\u26A0\uFE0F End of file:\n${ctx2}`,
          `Retry: pass a line number from 1 to ${lineCount + 1}, or use endOfFile:true (append) or startOfFile:true (prepend).`,
          smartSuggestion({ toolName: "insert", counter: ctx.consec, noHintsUsed: true, fileLines: lineCount, oldStr: null, isCodeFile })
        ].filter(Boolean).join("\n") }], inserted: false, consecFailures: ctx.consec.count };
      }

      // Resolve the 0-based buffer row to insert at.
      //   afterLine:N \u2014 new content becomes line N+1 (row = N, 0-based).
      //   onLine:N    \u2014 new content becomes line N itself (row = N-1, 0-based).
      //   beforeLine:N \u2014 new content becomes line N-1, i.e. one line before N (row = N-2, 0-based).
      const _row = _positionalMode === 'beforeLine' ? _targetLine - 2
                 : _positionalMode === 'onLine'      ? _targetLine - 1
                 : _targetLine;
      const _scopeLabel = _positionalMode === 'beforeLine' ? `one line before line ${_targetLine}`
                         : _positionalMode === 'onLine'     ? `as line ${_targetLine}`
                         : `after line ${_targetLine}`;

      if (_row < 0) {
        ctx.consec.count++;
        bump('insert', 'fails.outOfRange');
        return { content: [{ type: "text", text: [
          `\u274C beforeLine:${_targetLine} resolves before the start of the file (one line before line ${_targetLine} does not exist).`,
          `Use startOfFile:true to insert at the very beginning, or onLine:1 to insert as the new first line.`,
        ].join("\n") }], inserted: false, consecFailures: ctx.consec.count };
      }

      if (dryRun) {
        const radius   = 3;
        const ctxStart = Math.max(0, _row - radius);
        const ctxEnd   = Math.min(lineCount - 1, _row + radius - 1);
        const before   = allLines.slice(ctxStart, _row).map((l, i) => `${String(ctxStart + i + 1).padStart(4)}   ${l}`);
        const inserted = new_str.split("\n").map(l => `${" ".repeat(4)} + ${l}`);
        const after    = allLines.slice(_row, ctxEnd + 1).map((l, i) => `${String(_row + i + 1).padStart(4)}   ${l}`);
        return { content: [{ type: "text", text: [
          `ðŸ” DRY RUN â€” will insert ${new_str.split("\n").length} line(s) ${_scopeLabel}.`,
          `\nContext (+ = lines to be inserted):\n${[...before, ...inserted, ...after].join("\n")}`,
          `\nReply with the same call without dryRun (or dryRun:false) to commit \u2014 or just insert({ filePath, commitLastPreview: true }) to apply this exact preview without resending new_str.`
        ].join("\n") }], dryRun: true, targetLine: _targetLine, positionalMode: _positionalMode, lineCount };
      }

      const row             = _row;
      const textWithNewline = new_str.endsWith("\n") ? new_str : new_str + "\n";
      ctx.snapshotOriginal(); // B33-followup: needed for both decoration and features.structCheck in ctx.commit()
      buffer.insert([row, 0], textWithNewline);
      const newLineCount = buffer.getLineCount();
      const _lintSuffix3  = await maybeLintSuffix(lint, editor, row, row + new_str.split("\n").length - 1);
      const _styleSuffix3 = applyStyleCheck(new_str, ctx.filePath, row);
      // B32/B37: routed through ctx.commit()'s features.successNudge gating instead
      // of a hand-rolled _driftNudge (see mcp-server-refactor-plan.md B32/B37).
      // ctx.commit() bumps hit/resets consec/saves/builds the response the same
      // as the manual path below did; nudgeCtx.noHintsUsed:true + matchedLineContent
      // gets the same "positional, switch to afterString" advice as before, now
      // also aware of B31's empty-symbol-table case for files tree-sitter can't
      // parse. positionalHintName reflects whichever of the four params was
      // actually used (afterLine/beforeLine/onLine), not hardcoded.
      const _anchorContent = allLines[_row] !== undefined ? allLines[_row].trim()
                            : (allLines[_row - 1] !== undefined ? allLines[_row - 1].trim() : null);
      const commitResult = await ctx.commit(
        { line: _targetLine, linesChanged: new_str.split('\n').length, nudgeCtx: { noHintsUsed: true, positionalHintName: _positionalMode, matchedLineContent: _anchorContent, isCodeFile } },
        { lint: _lintSuffix3, style: _styleSuffix3 }
      );
      return { ...commitResult, dryRun: false, newLineCount };
    },
  });




  // delete-line removed 2026-09-17 â€” folded into `delete` (startLine == endLine covers this case).

  // â”€â”€ delete (consolidated from delete-line, delete-line-range, delete-block, 2026-09-17) â”€
  // Five match modes in priority order: structural (banner/ifdefBlock) â†’ inFunction â†’
  // content pair (startContent+endContent) â†’ matchString (single-block, via matchContentEngine,
  // same engine insert's afterContent/beforeContent and replace's old_str already share) â†’
  // legacy positional (startLine/endLine, with optional expectedContent verification).
  // See delete-tool-spec.md session note for full design rationale.
  if (g('edit')) registerMcpTool({
    name:     'delete',
    group:    'edit',
    category: 'edit',
    features: { dryRun: true, lint: true, consecutiveFailureCounter: true, structCheck: true }, // structCheck: only runs for modes that call ctx.snapshotOriginal() + ctx.commit (Mode 5 so far; R3a/H13)
    title:    'Delete',
    description: [
      "Delete lines from `filePath` (required). Say what to delete in ONE of six ways:",
      "(1) banner:'TITLE' - the whole section-banner block.",
      "(2) ifdefBlock:'MACRO' - the whole #ifdef..#endif; ifdefEdge:'open' or 'close' deletes only that one line.",
      "(3) inFunction:'fn' - the whole function, signature included.",
      "(4) startContent + endContent - from the start line to the end line inclusive; inclusive:false keeps the two anchor lines.",
      "(5) matchString - one exact block (fuzzyWhitespace and fuzzyContent allowed). Add fragment:true to remove only the matched span: the line stays, left empty if the span was the whole line. fragment needs matchString, cannot be combined with the fuzzy flags, banner, ifdefBlock or startContent/endContent, and guardIdentifier (default true) refuses a hit inside a longer identifier.",
      "(6) startLine + endLine (1-based, inclusive) - on their own they delete exactly that range; add expectedContent:'text in the range' to verify first (strongly recommended; ignored when matchString is given). Together with matchString they mean: find matchString INSIDE that line range (a duplicate outside is never touched; no match inside is refused).",
      "occurrence:N picks the Nth match. Scope hints (inFunction, afterString, afterLine, hintRadius, ...) only narrow where matchString searches; named hints win over line numbers. dryRun:true previews without writing. Raw line numbers shift after every delete, so re-read before reusing them; modes 1-5 are immune.",
    ].join(" "),
    inputSchema: {
      // mode 4 â€” content pair (ported from delete-block)
      startContent: z.string().optional(),
      endContent:   z.string().optional(),
      inclusive:    z.boolean().optional(),
      // mode 5 â€” single content match (new)
      matchString:  z.string().optional(),
      fragment:        z.boolean().optional(), // R3a / H13 step B (2026-11-13): with matchString, remove ONLY the matched span; the line stays (left empty if the span was the whole line)
      guardIdentifier: z.boolean().optional(), // fragment mode only: default true refuses hits glued to a longer identifier (same as replace)
      // mode 6 â€” legacy positional (ported from delete-line-range)
      startLine: z.number().optional(),
      endLine:   z.number().optional(),
      expectedContent: z.string().optional(),
      ...withoutScopeHints(SCOPE_ANCHOR_SCHEMA),
      scope: SCOPE_OBJECT_SCHEMA, // XW23: the shared hints without the insert-only afterContent/beforeContent
    },
    handler: async ({ startContent, endContent, banner, ifdefBlock, ifdefEdge, inclusive = true, matchString, fragment, guardIdentifier, startLine, endLine, expectedContent, inFunction, afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterString, beforeString, afterLine, beforeLine, betweenHint, hintRadius, occurrence, fuzzyWhitespace, fuzzyContent, dryRun = false, lint = false }, ctx) => {
            const { editor, buffer, allLines } = ctx;
      const curTool   = 'delete';
      const lineCount = allLines.length;
      const isCodeFile = isCodeFilePath(ctx.filePath); // B23
      const _radius    = hintRadius ?? HINT_RADIUS;

      // R3a / H13 step B (2026-11-13): fragment:true is the part-line form of matchString (Mode 5) and nothing else. A bare
      // fragment, or one combined with a whole-block mode (banner, ifdefBlock, startContent+endContent), is refused up front
      // instead of being silently ignored. Usage errors, not match failures: no consec bump, no fails.* counter.
      if (fragment && matchString === undefined) {
        return { content: [{ type: 'text', text: 'fragment:true needs matchString: it removes only the matched span of that text and leaves the line in place. Pass matchString, or drop fragment to delete whole lines.' }], found: false, deleted: false };
      }
      if (fragment && (banner !== undefined || ifdefBlock !== undefined || startContent !== undefined || endContent !== undefined)) {
        return { content: [{ type: 'text', text: 'fragment:true works with matchString only: banner, ifdefBlock and startContent+endContent delete whole lines or blocks and have no part-line mode. Use matchString with fragment:true, or drop fragment.' }], found: false, deleted: false };
      }

      // -- Mode 1/2: structural anchor (banner / ifdefBlock) via the shared engine --
      // Hint-gap closure: resolved through resolveScope() (same path insert uses), so the
      // ambiguity rules, failure wording and retry nudge are shared rather than forked.
      // A structural anchor resolves to a ROW RANGE; delete removes exactly that range.
      if (banner !== undefined || ifdefBlock !== undefined) {
        if (ifdefBlock)   bump('delete', 'hintsUsed.ifdefBlock');
        if (inFunction)     bump('delete', 'hintsUsed.inFunction');
        if (occurrence > 1) bump('delete', 'hintsUsed.occurrence');
        if (banner)    bump('delete', 'hintsUsed.banner');
        const _sScope = resolveScope({
          editor, buffer, allLines, text: ctx.text, filePath: ctx.filePath,
          params: { banner, ifdefBlock, ifdefEdge, occurrence },
        });
        if (_sScope.error) {
          ctx.consec.count++;
          bump('delete', (_sScope.error.kind === 'ambiguous' || _sScope.error.ambiguous === true) ? 'fails.anchorAmbiguous' : 'fails.anchorNotFound');
          // 2026-09-28: Mode 1/2 previously had NO fault-log entry at all.
          logMatchFailure({
            tool: curTool, filePath: ctx.filePath,
            reason: _sScope.error.kind || 'anchorNotFound',
            needle: null, proposedNewStr: null, allLines,
            hints: { banner, ifdefBlock, ifdefEdge, inFunction, occurrence },
          });
          const fail = buildFailResponse({ tool: curTool, ctx: { consec: ctx.consec, allLines, text: ctx.text }, scope: _sScope, needle: null, isCodeFile });
          return { ...fail, deleted: false };
        }
        const delStart     = _sScope.anchorRow;
        const delEnd       = _sScope.endAnchorRow;
        const deletedCount = delEnd - delStart + 1;
        const r  = 3;
        const cs = Math.max(0, delStart - r);
        const ce = Math.min(lineCount - 1, delEnd + r);
        const preview = allLines.slice(cs, ce + 1).map((l, i) => {
          const abs = cs + i;
          return `${String(abs + 1).padStart(4)}${abs >= delStart && abs <= delEnd ? " -" : "  "} ${l}`;
        }).join("\n");
        if (dryRun) {
          return ctx.dryRunReturn({
            content: [{ type: "text", text: [
              `\uD83D\uDD0D DRY RUN \u2014 will delete ${deletedCount} line(s) (lines ${delStart + 1}\u2013${delEnd + 1}).`,
              `\nContext (- = lines to be deleted):\n${preview}`,
              `\nReply with the same call without dryRun (or dryRun:false) to commit.`
            ].join("\n") }],
            dryRun: true, deleted: false, startLine: delStart + 1, endLine: delEnd + 1, deletedCount
          });
        }
        // R3a / H13 step 2 (2026-11-11): commit tail through ctx.commit (see Mode 5). snapshotOriginal() before the write.
        ctx.snapshotOriginal();
        buffer.deleteRows(delStart, delEnd);
        const newLineCount = buffer.getLineCount();
        const _lintSuffix  = await maybeLintSuffix(lint, editor, delStart, delStart + 5);
        // banner/ifdefBlock are structural anchors -- content-stable and drift-immune by construction, so no
        // nudgeCtx (no successNudge) and no staleLinesWarning (unlike the raw startLine/endLine path further down).
        const _commit12 = await ctx.commit({ line: delStart + 1, linesChanged: -deletedCount }, { lint: _lintSuffix });
        return { ..._commit12, dryRun: false, deleted: true, newLineCount, deletedCount };
      }

      // -- Mode 3: inFunction, entire named function body --------------------
      // Hint-gap closure: the function is located via resolveScope() (shared engine), not
      // findFunctionInBuffer, so ambiguity (same name twice) is refused with the candidate
      // list instead of silently taking the first, and occurrence:N disambiguates.
      // NOTE: uses searchStart/searchEnd (the function's row range), not anchorRow.
      if (inFunction && !startContent && !endContent && !matchString) {
        bump('delete', 'hintsUsed.inFunction');
        if (occurrence > 1) bump('delete', 'hintsUsed.occurrence');
        const _fScope = resolveScope({
          editor, buffer, allLines, text: ctx.text, filePath: ctx.filePath,
          params: { inFunction, occurrence },
        });
        if (_fScope.error) {
          ctx.consec.count++;
          bump('delete', (_fScope.error.kind === 'ambiguous' || _fScope.error.ambiguous === true) ? 'fails.anchorAmbiguous' : 'fails.anchorNotFound');
          logMatchFailure({
            tool: curTool, filePath: ctx.filePath,
            reason: _fScope.error.kind || 'anchorNotFound',
            needle: inFunction, proposedNewStr: null, allLines,
            hints: { inFunction, occurrence },
          });
          const fail = buildFailResponse({ tool: curTool, ctx: { consec: ctx.consec, allLines, text: ctx.text }, scope: _fScope, needle: null, isCodeFile });
          return { ...fail, deleted: false };
        }
        const delStart = _fScope.searchStart;
        const delEnd   = _fScope.searchEnd;
        const deletedCount = delEnd - delStart + 1;
        const r  = 3;
        const cs = Math.max(0, delStart - r);
        const ce = Math.min(lineCount - 1, delEnd + r);
        const preview = allLines.slice(cs, ce + 1).map((l, i) => {
          const abs = cs + i;
          return `${String(abs + 1).padStart(4)}${abs >= delStart && abs <= delEnd ? " -" : "  "} ${l}`;
        }).join("\n");
        if (dryRun) {
          return ctx.dryRunReturn({
            content: [{ type: "text", text: [
              `\uD83D\uDD0D DRY RUN \u2014 will delete ${deletedCount} line(s) (lines ${delStart + 1}\u2013${delEnd + 1}), function "${inFunction}".`,
              `\nContext (- = lines to be deleted):\n${preview}`,
              `\nReply with the same call without dryRun (or dryRun:false) to commit.`
            ].join("\n") }],
            dryRun: true, deleted: false, startLine: delStart + 1, endLine: delEnd + 1, deletedCount
          });
        }
        // R3a / H13 step 2 (2026-11-11): commit tail through ctx.commit (see Mode 5). snapshotOriginal() before the write.
        // A whole function is removed here, so structCheck (features.structCheck) is the useful one for this mode.
        ctx.snapshotOriginal();
        buffer.deleteRows(delStart, delEnd);
        const newLineCount = buffer.getLineCount();
        const _lintSuffix  = await maybeLintSuffix(lint, editor, delStart, delStart + 5);
        const _commit3 = await ctx.commit({ line: delStart + 1, linesChanged: -deletedCount }, { lint: _lintSuffix });
        return { ..._commit3, dryRun: false, deleted: true, newLineCount, deletedCount };
      }

      // -- Mode 4: content pair (startContent + endContent), ported from delete-block --------
      if (startContent && endContent) {
        bump('delete', 'hintsUsed.startContent');
        bump('delete', 'hintsUsed.endContent');
        if (inFunction)     bump('delete', 'hintsUsed.inFunction');
        if (occurrence > 1) bump('delete', 'hintsUsed.occurrence');
        if (fuzzyWhitespace) bump('delete', 'hintsUsed.fuzzyWhitespace'); // 2026-09-21: Mode 4 now honours it (same key Mode 5 uses)

        let searchFrom = 0;
        if (inFunction) {
          const fn = findFunctionInBuffer(buffer, inFunction);
          if (!fn) {
            ctx.consec.count++;
            bump('delete', 'fails.anchorNotFound');
            return { content: [{ type: "text", text: `\u274C inFunction: function "${inFunction}" not found.` }], deleted: false };
          }
          searchFrom = fn.startRow;
        }

        const _startScope = resolveScope({ editor, buffer, allLines, text: ctx.text, filePath: ctx.filePath, params: { occurrence, afterRow: searchFrom } });
        // S2 (Mode 4): forward occurrence to the startContent match. resolveScope()'s afterRow path
        // never reads occurrence (and never sets occurrenceConsumed), so without this a duplicate
        // startContent could not be disambiguated even though the ambiguity message advises occurrence:N.
        // The engine's contentOccurrence() returns undefined when scope.occurrenceConsumed, so it is never applied twice.
        // Only the START match gets it: endContent is the first match after startRow, and reusing the
        // same N there would silently skip closers.
        // 2026-09-21 (PJ: add as a feature): fuzzyWhitespace / fuzzyContent now apply to BOTH anchors,
        // same flags and same call shape as matchString (Mode 5) and the start/end pair tool. Opt-in only:
        // autoRescue stays false (destructive caller), so with none of them set behaviour is unchanged.
        const _startMatch = matchContentEngine(startContent, { allLines, text: ctx.text }, _startScope, { fuzzyWhitespace, fuzzyContent, occurrence, autoRescue: false }); // S1: destructive caller, no automatic rescue
        const startHit = _startMatch.matched
          ? { row: _startMatch.matchLine, matchedRows: _startMatch.matchEndLine - _startMatch.matchLine + 1,
              strategy: _startMatch.transforms.length === 0 ? "exact" : _startMatch.transforms[0] }
          : null;
        if (!startHit) {
          ctx.consec.count++;
          bump('delete', (_startMatch.reason === 'occurrenceOutOfRange' || _startMatch.reason === 'ambiguous') ? 'fails.anchorAmbiguous' : 'fails.startNotFound'); // 2026-09-30: 'ambiguous' was mislabelled startNotFound
          // S2d: forwarding occurrence (S2b) introduced a new failure reason this hand-written block
          // never handled, so occurrence:5 with only 2 hits fell through to "startContent not found".
          // Delegate ONLY that reason to the shared wording (same as Mode 5); the ambiguous and
          // not-found messages below are Mode 4's own and are left as they were.
          if (_startMatch.reason === 'occurrenceOutOfRange') {
            const fail = buildFailResponse({ tool: curTool, ctx: { consec: ctx.consec, allLines, text: ctx.text }, scope: _startScope, match: _startMatch, needle: startContent, isCodeFile });
            return { ...fail, deleted: false, consecFailures: ctx.consec.count };
          }
          if (_startMatch.reason === 'ambiguous') {
            const _lines = _startMatch.matchLines ? _startMatch.matchLines.join(', ') : 'multiple locations';
            // 2026-09-30: ambiguous anchors previously returned with NO fault-log entry (only not-found was logged).
            logMatchFailure({
              tool: curTool, filePath: ctx.filePath, reason: 'startAmbiguous',
              needle: startContent, proposedNewStr: null, allLines,
              hints: { startContent, endContent, inclusive, inFunction, banner, ifdefBlock, occurrence, fuzzyWhitespace, fuzzyContent },
            });
            return { content: [{ type: "text", text: [
              `\u274C startContent is ambiguous \u2014 matches more than one place in scope (lines ${_lines}): "${startContent}"`,
              `\n\uD83D\uDCA1 Narrow startContent, tighten inFunction, or pass occurrence:N.`,
            ].filter(Boolean).join("\n") }], deleted: false, consecFailures: ctx.consec.count };
          }
          // S4 (2026-09-21): a plain not-found now gets the shared diagnosis (whitespace / partial match /
          // closest area / similarity / where else the text lives) and the shared fails.* tally, PARALLEL to
          // the fails.startNotFound bump above. ambiguous and occurrenceOutOfRange were handled above and
          // are untouched. fuzzyAdvice is !fuzzyWhitespace: since 2026-09-21 Mode 4 honours fuzzyWhitespace, so
          // recommending it is TRUE when the caller has not set it and redundant noise when they already have.
          // No retryNudge: it would advertise matchString, which would switch this call to Mode 5.
          // R1j part 2 (2026-10-18): startContent matches WHOLE lines; when it only fails because it starts/ends mid-line, say so (the sentence
          // comes from diagnoseFailure via midLineWhatText) and add the NOTE below, instead of blaming a typo. Mode 4 has no nudge/stash to drop.
          const _startMid = midLineHint({ needle: startContent, text: ctx.text, scopeStart: _startScope && _startScope.searchStart, scopeEnd: _startScope && _startScope.searchEnd, fuzzyWhitespace, fuzzyContent });
          const _sd = diagnoseFailure({ tool: curTool, ctx: { consec: ctx.consec, allLines, text: ctx.text }, scope: _startScope, needle: startContent, subject: 'startContent', fuzzyAdvice: !fuzzyWhitespace, midLine: _startMid, midLineWhatText: _startMid ? midLineWhat('deleteAnchor', 'startContent') : undefined });
          // 2026-09-28: Mode 4 previously had NO fault-log entry at all for either anchor.
          logMatchFailure({
            tool: curTool, filePath: ctx.filePath, reason: 'startNotFound',
            needle: startContent, proposedNewStr: null, allLines,
            hints: { startContent, endContent, inclusive, inFunction, banner, ifdefBlock, occurrence, fuzzyWhitespace, fuzzyContent },
          });
          return { content: [{ type: "text", text: [
            `\u274C startContent not found${occurrence != null ? ` (occurrence ${occurrence})` : ""}: "${startContent}"`,
            ..._sd.pre,
            smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: !inFunction && !banner && !ifdefBlock, fileLines: lineCount, oldStr: null, isCodeFile }),
            ..._sd.post,
            _startMid ? midLineAdvice('deleteAnchor', 'startContent') : null
          ].filter(Boolean).join("\n") }], deleted: false, consecFailures: ctx.consec.count };
        }
        const startRow     = startHit.row;
        const startMsgHint = startHit.strategy !== "exact" ? ` (startContent matched via ${startHit.strategy})` : "";

        const _endScope = resolveScope({ editor, buffer, allLines, text: ctx.text, filePath: ctx.filePath, params: { afterRow: startRow + 1 } });
        // S2c (Mode 4): the end match is "the nearest endContent at or after startRow+1", so pin it to
        // occurrence:1. Without this, any block that is not the last one in the file was refused as
        // ambiguous (every later closer is also a hit), which made S2's startContent occurrence useless
        // for all but the final pair. The user's occurrence is deliberately NOT forwarded here (see S2 note).
        // A closer that is not the nearest is still reachable via a more specific endContent.
        const _endMatch = matchContentEngine(endContent, { allLines, text: ctx.text }, _endScope, { fuzzyWhitespace, fuzzyContent, occurrence: 1, autoRescue: false }); // S1: destructive caller, no automatic rescue; fuzzy flags 2026-09-21 (see startContent)
        const endHit = _endMatch.matched
          ? { row: _endMatch.matchLine, matchedRows: _endMatch.matchEndLine - _endMatch.matchLine + 1,
              strategy: _endMatch.transforms.length === 0 ? "exact" : _endMatch.transforms[0] }
          : null;
        if (!endHit) {
          ctx.consec.count++;
          bump('delete', _endMatch.reason === 'ambiguous' ? 'fails.anchorAmbiguous' : 'fails.endNotFound'); // 2026-09-30: 'ambiguous' was mislabelled endNotFound
          if (_endMatch.reason === 'ambiguous') {
            const _lines = _endMatch.matchLines ? _endMatch.matchLines.join(', ') : 'multiple locations';
            // 2026-09-30: ambiguous anchors previously returned with NO fault-log entry (only not-found was logged).
            logMatchFailure({
              tool: curTool, filePath: ctx.filePath, reason: 'endAmbiguous',
              needle: endContent, proposedNewStr: null, allLines,
              hints: { startContent, endContent, inclusive, inFunction, banner, ifdefBlock, occurrence, fuzzyWhitespace, fuzzyContent },
            });
            return { content: [{ type: "text", text: [
              `\u274C endContent is ambiguous \u2014 matches more than one place after startContent (lines ${_lines}): "${endContent}"`,
              `\n\uD83D\uDCA1 Narrow endContent, tighten inFunction, or pass occurrence:N.`,
            ].filter(Boolean).join("\n") }], deleted: false, consecFailures: ctx.consec.count };
          }
          // S4 (2026-09-21): shared diagnosis + fails.* tally (parallel to fails.endNotFound above). The scope is a
          // SHALLOW COPY so it can carry a label saying WHERE endContent was searched -- after the start anchor --
          // which the diagnosis prints when the text exists only BEFORE it (FOUND OUTSIDE SCOPE). Same reasons as
          // startContent for fuzzyAdvice (!fuzzyWhitespace) and no retryNudge (resending only endContent would drop startContent).
          // Mode 4's own context preview and tip are kept: they are the most useful part of this message.
          // R1j part 2 (2026-10-18): same as startContent. The hint is computed against _endScope (the lines AFTER startContent), so
          // text that exists only BEFORE the start anchor stays a FOUND OUTSIDE SCOPE failure and is not called mid-line.
          const _endMid = midLineHint({ needle: endContent, text: ctx.text, scopeStart: _endScope && _endScope.searchStart, scopeEnd: _endScope && _endScope.searchEnd, fuzzyWhitespace, fuzzyContent });
          const _ed = diagnoseFailure({ tool: curTool, ctx: { consec: ctx.consec, allLines, text: ctx.text }, scope: { ..._endScope, scopeLabel: ` after startContent (line ${startRow + 1})` }, needle: endContent, subject: 'endContent', fuzzyAdvice: !fuzzyWhitespace, midLine: _endMid, midLineWhatText: _endMid ? midLineWhat('deleteAnchor', 'endContent') : undefined });
          logMatchFailure({
            tool: curTool, filePath: ctx.filePath, reason: 'endNotFound',
            needle: endContent, proposedNewStr: null, allLines,
            hints: { startContent, endContent, inclusive, inFunction, banner, ifdefBlock, occurrence, fuzzyWhitespace, fuzzyContent },
          });
          const previewStart = startRow + 1;
          const previewEnd   = Math.min(allLines.length - 1, startRow + 10);
          const afterCtx     = allLines.slice(previewStart, previewEnd + 1)
            .map((l, i) => `${String(previewStart + i + 1).padStart(4)}: ${l}`).join("\n");
          return { content: [{ type: "text", text: [
            `\u274C endContent not found after startContent (line ${startRow + 1}): "${endContent}"`,
            ..._ed.pre,
            `\n\u26A0\uFE0F Lines after startContent \u2014 pick the correct endContent from here:\n${afterCtx}`,
            `\n\uD83D\uDCA1 Tip: use a single unique line as endContent if possible.`,
            smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: !inFunction && !banner && !ifdefBlock, fileLines: lineCount, oldStr: null, isCodeFile }),
            ..._ed.post,
            _endMid ? midLineAdvice('deleteAnchor', 'endContent') : null
          ].filter(Boolean).join("\n") }], deleted: false, consecFailures: ctx.consec.count };
        }
        const endRow     = endHit.row + endHit.matchedRows - 1;
        const endMsgHint = endHit.strategy !== "exact" ? ` (endContent matched via ${endHit.strategy})` : "";

        const delStart = inclusive ? startRow : startRow + 1;
        const delEnd   = inclusive ? endRow   : endRow   - 1;

        if (delStart > delEnd) {
          return { content: [{ type: "text", text: "\u274C No lines to delete \u2014 inclusive:false with adjacent anchors produces an empty range." }], deleted: false };
        }

        const r2 = 3;
        const cs = Math.max(0, delStart - r2);
        const ce = Math.min(lineCount - 1, delEnd + r2);
        const preview = allLines.slice(cs, ce + 1).map((l, i) => {
          const abs = cs + i;
          return `${String(abs + 1).padStart(4)}${abs >= delStart && abs <= delEnd ? " -" : "  "} ${l}`;
        }).join("\n");
        const deletedCount = delEnd - delStart + 1;

        if (dryRun) {
          return ctx.dryRunReturn({
            content: [{ type: "text", text: [
              `\uD83D\uDD0D DRY RUN \u2014 will delete ${deletedCount} line(s) (lines ${delStart + 1}\u2013${delEnd + 1})${startMsgHint}${endMsgHint}.`,
              `\nContext (- = lines to be deleted):\n${preview}`,
              `\nReply with the same call without dryRun (or dryRun:false) to commit.`
            ].join("\n") }],
            dryRun: true, deleted: false, startLine: delStart + 1, endLine: delEnd + 1, deletedCount
          });
        }

        // R3a / H13 step 3 (2026-11-12): commit tail through ctx.commit (see Mode 5). snapshotOriginal() before the write.
        // startContent/endContent are content anchors -- drift-immune by construction, so no nudgeCtx (no successNudge)
        // and no staleLinesWarning.
        ctx.snapshotOriginal();
        buffer.deleteRows(delStart, delEnd);
        const newLineCount2 = buffer.getLineCount();
        const _lintSuffix2  = await maybeLintSuffix(lint, editor, delStart, delStart + 5);
        const _commit4 = await ctx.commit({ line: delStart + 1, linesChanged: -deletedCount }, { lint: _lintSuffix2 });
        return { ..._commit4, dryRun: false, deleted: true, newLineCount: newLineCount2, deletedCount };
      }

      // -- Mode 5: matchString, single-block content match (NEW) -------------
      // Delegates to the same resolveScope()/matchContentEngine()/buildFailResponse()
      // pipeline insert's afterContent/beforeContent and replace's old_str already
      // share â€” no new matching logic, just a third caller that deletes instead of
      // inserting/replacing. See mode 5 note in delete-tool-spec.md for rationale on
      // why this isn't named old_str, content, or afterContent/beforeContent.
      if (matchString !== undefined) {
        bump('delete', 'hintsUsed.matchString');
        if (inFunction)     bump('delete', 'hintsUsed.inFunction');
        if (occurrence > 1) bump('delete', 'hintsUsed.occurrence');
        if (fuzzyWhitespace) bump('delete', 'hintsUsed.fuzzyWhitespace');

        // R3a / H13 step A3 (2026-11-12): startLine+endLine are the shared range hint, so matchString + range = "match this text
        // inside that range". The engine resolves it AFTER every named hint (inFunction, afterString, ... still win) and before
        // afterLine/beforeLine. The content match itself is the check, so the range-only content check is not used here.
        const _scope = resolveScope({
          editor, buffer, allLines, text: ctx.text, filePath: ctx.filePath,
          params: { inFunction, afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterString, beforeString, afterLine, beforeLine, betweenHint, startLine, endLine, hintRadius: _radius, occurrence },
        });
        if (_scope.error) {
          ctx.consec.count++;
          const _rangeReason = _scope.error.reason;
          bump('delete', _rangeReason === 'inverted' ? 'fails.inverted'
            : (_rangeReason === 'outOfRange' || _rangeReason === 'notOneBased' || _rangeReason === 'missingEnd') ? 'fails.outOfRange'
            : (_scope.error.kind === 'ambiguous' || _scope.error.ambiguous === true) ? 'fails.anchorAmbiguous' : 'fails.anchorNotFound');
          logMatchFailure({
            tool: curTool, filePath: ctx.filePath,
            reason: _scope.error.kind || 'anchorNotFound',
            needle: matchString, proposedNewStr: null, allLines,
            hints: { inFunction, afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterString, beforeString,
                     afterLine, beforeLine, betweenHint, startLine, endLine, occurrence, hintRadius, fuzzyWhitespace, matchString },
          });
          const fail = buildFailResponse({ tool: curTool, ctx: { consec: ctx.consec, allLines, text: ctx.text }, scope: _scope, needle: matchString, isCodeFile });
          return { ...fail, deleted: false };
        }
        // -- fragment:true (R3a / H13 step B, 2026-11-13, PJ's design): PART-LINE delete. Same planner, same rules as replace's
        // fragment mode (lib/replace-fragment.js planFragmentReplace: plain literal, may span lines, must match exactly once unless
        // occurrence picks one, guardIdentifier refuses a hit glued to a longer identifier, fuzzy flags refused, no auto rescue) with
        // newStr ''. Only the matched span is removed; THE LINE STAYS, left empty if the span was the whole line text. (replace
        // with an empty new_str drops the row in that case today; delete keeps it on purpose, see the nudge below.)
        if (fragment) {
          const _plan = planFragmentReplace({
            lines: allLines, startRow: _scope.searchStart, endRow: _scope.searchEnd,
            oldStr: matchString, newStr: '', occurrence, guardIdentifier,
            flags: { fuzzyWhitespace, fuzzyContent },
            liveLines: dryRun ? undefined : buffer.getLines(), // drift pre-check (reason fragmentDrift); a dry run omits it
          });
          if (!_plan.ok) {
            if (_plan.consecBump) ctx.consec.count++;
            for (const _k of _plan.statKeys) { if (_k !== 'fragmentFails') bump('delete', _k); }
            bump('delete', 'fragmentFails');
            logMatchFailure({
              tool: curTool, filePath: ctx.filePath, reason: _plan.reason,
              needle: matchString, proposedNewStr: '', allLines,
              hints: { inFunction, afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterString, beforeString,
                       afterLine, beforeLine, betweenHint, startLine, endLine, occurrence, hintRadius, fragment, guardIdentifier, matchString },
            });
            // the planner words its refusals for replace ("replace: ...", "replace refused: ..."); this is delete
            return { content: [{ type: 'text', text: _plan.message.replace(/^replace\b/, 'delete') }], found: false, deleted: false };
          }
          const { row: _fR, startCol: _fSC, endCol: _fEC } = _plan.edit;
          const _fER    = _plan.edit.endRow != null ? _plan.edit.endRow : _fR; // multi-line span: rows _fR.._fER are joined into one
          const _fAfter = allLines[_fR].slice(0, _fSC) + allLines[_fER].slice(_fEC);
          const _fWhole = _fER === _fR && _fSC === 0 && _fEC === allLines[_fR].length; // the span is the entire line text
          const _fTags  = _plan.tags.slice();
          if (dryRun) {
            const _fcs = Math.max(0, _fR - 3), _fce = Math.min(lineCount - 1, _fER + 3);
            const _fPrev = allLines.slice(_fcs, _fce + 1).map((l, i) => {
              const abs = _fcs + i;
              return `${String(abs + 1).padStart(4)}${abs >= _fR && abs <= _fER ? " -" : "  "} ${l}`;
            }).join("\n");
            return ctx.dryRunReturn({
              content: [{ type: "text", text: [
                `\uD83D\uDD0D DRY RUN \u2014 will remove the matched span from line ${_fR + 1}${_fER > _fR ? `\u2013${_fER + 1}` : ""} [${_fTags.length ? _fTags.join(", ") : "fragment"}]; the line stays.`,
                `\nContext (- = line(s) holding the span):\n${_fPrev}`,
                `\nLine ${_fR + 1} after the edit: ${_fAfter === "" ? "(empty line)" : _fAfter}`,
                `\nReply with the same call without dryRun (or dryRun:false) to commit.`
              ].join("\n") }],
              dryRun: true, deleted: false, fragment: true, startLine: _fR + 1, endLine: _fER + 1, deletedCount: 0
            });
          }
          ctx.snapshotOriginal();
          const _fApply = applyEditSpan(buffer, { row: _fR, startCol: _fSC, endRow: _fER, endCol: _fEC, actualText: _plan.edit.actualText }, '');
          if (_fApply.error) {
            const _applyErr = describeApplyError(_fApply.error); // text + stat keys; not fault-logged, no consec bump (same as replace)
            for (const _k of _applyErr.statKeys) bump('delete', _k);
            bump('delete', 'fragmentFails');
            return { content: [{ type: 'text', text: _applyErr.message }], found: false, deleted: false };
          }
          bump('delete', 'fragmentCommits');
          const _fLint = await maybeLintSuffix(lint, editor, _fR, _fR);
          // A whole-line span leaves an empty line on purpose; say so, and say how to remove the line instead.
          const _fNudge = _fWhole ? '\n\nNOTE: the matched span was the entire line, so line ' + (_fR + 1) + ' is now empty and stays. To remove the line itself, call delete again without fragment:true.' : undefined;
          const _commitFrag = await ctx.commit({ line: _fR + 1, linesChanged: -(_fER - _fR) }, { lint: _fLint, ...(_fNudge ? { nudge: _fNudge } : {}) });
          return { ..._commitFrag, dryRun: false, deleted: true, fragment: true, newLineCount: buffer.getLineCount(), deletedCount: 0 };
        }
        // S1: autoRescue:false -- delete is DESTRUCTIVE. The engine's automatic rescue can
        // fall through to a full-buffer partial match that lands OUTSIDE the resolved scope
        // (outsideScope:true, which this branch never checked) and would delete text the
        // caller never scoped. Explicit fuzzyWhitespace/fuzzyContent remain available.
        // S2 (2026-09-20): occurrence is now forwarded. Before this, delete could never pick the Nth
        // duplicate matchString (resolveScope only spends occurrence on an ANCHOR hint), so
        // ambiguityCheck()'s occurrence:N advice was wrong for it. The engine's contentOccurrence()
        // returns undefined when scope.occurrenceConsumed, so it is never applied twice.
        const _match = matchContentEngine(matchString, { allLines, text: ctx.text }, _scope, { fuzzyWhitespace, fuzzyContent, occurrence, autoRescue: false });
        if (!_match.matched) {
          ctx.consec.count++;
          // S1: was bump('delete','fails.matchStringNotFound') -- a key edit-stats.js never had,
          // so bump() no-op'd and every matchString failure went uncounted.
          bump('delete', (_match.reason === 'ambiguous' || _match.reason === 'occurrenceOutOfRange') ? 'fails.anchorAmbiguous' : 'fails.anchorNotFound');
          logMatchFailure({
            tool: curTool, filePath: ctx.filePath,
            reason: _match.reason || 'noMatch',
            needle: matchString, proposedNewStr: null, allLines,
            hints: { inFunction, afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterString, beforeString,
                     afterLine, beforeLine, betweenHint, startLine, endLine, occurrence, hintRadius, fuzzyWhitespace, fuzzyContent, matchString },
          });
          // R1j 2026-10-18: matchString matches WHOLE lines like replace's old_str; tell the caller when it only fails because it starts/ends mid-line (subject = their own parameter name).
          const _midLine = _match.reason === 'ambiguous' ? null : midLineHint({ needle: matchString, text: ctx.text, scopeStart: _scope && _scope.searchStart, scopeEnd: _scope && _scope.searchEnd, fuzzyWhitespace, fuzzyContent });
          const fail = buildFailResponse({ tool: curTool, ctx: { consec: ctx.consec, allLines, text: ctx.text }, scope: _scope, match: _match, needle: matchString, isCodeFile, midLine: _midLine, subject: 'matchString' });
          return { ...fail, deleted: false };
        }
        const delStart = _match.matchLine;
        const delEnd   = _match.matchEndLine;
        const deletedCount = delEnd - delStart + 1;
        const matchMsgHint = _match.transforms.length > 0 ? ` (matched via ${_match.transforms[0]})` : "";
        const r3 = 3;
        const cs = Math.max(0, delStart - r3);
        const ce = Math.min(lineCount - 1, delEnd + r3);
        const preview = allLines.slice(cs, ce + 1).map((l, i) => {
          const abs = cs + i;
          return `${String(abs + 1).padStart(4)}${abs >= delStart && abs <= delEnd ? " -" : "  "} ${l}`;
        }).join("\n");
        if (dryRun) {
          return ctx.dryRunReturn({
            content: [{ type: "text", text: [
              `\uD83D\uDD0D DRY RUN \u2014 will delete ${deletedCount} line(s) (lines ${delStart + 1}\u2013${delEnd + 1})${matchMsgHint}.`,
              `\nContext (- = lines to be deleted):\n${preview}`,
              `\nReply with the same call without dryRun (or dryRun:false) to commit.`
            ].join("\n") }],
            dryRun: true, deleted: false, startLine: delStart + 1, endLine: delEnd + 1, deletedCount
          });
        }
        // R3a / H13 (2026-11-11): the commit tail now goes through ctx.commit (decoration, struct check, tab focus,
        // onCommit, hit bump, consec reset, save and response), like insert. snapshotOriginal() must come before the write.
        ctx.snapshotOriginal();
        buffer.deleteRows(delStart, delEnd);
        const newLineCount = buffer.getLineCount();
        const _lintSuffix  = await maybeLintSuffix(lint, editor, delStart, delStart + 5);
        // matchString is a content anchor -- drift-immune by construction, so no nudgeCtx (no successNudge).
        const _commit5 = await ctx.commit({ line: delStart + 1, linesChanged: -deletedCount }, { lint: _lintSuffix });
        return { ..._commit5, dryRun: false, deleted: true, newLineCount, deletedCount };
      }

      // -- Mode 6: legacy positional (startLine/endLine), ported from delete-line-range -----
      // betweenHint / afterString were REMOVED from this mode (2026-09-19, hint-gap closure).
      // afterString pinned only startLine while endLine still came from the raw param -- half
      // content-anchored, half positional -- and betweenHint's start-to-end range is exactly what
      // startContent+endContent (Mode 4) already does, engine-backed, with ambiguity handling.
      // Lifetime stats showed zero uses of either on delete. Hints still SCOPE a content match
      // (matchString, Mode 5); only startLine/endLine are positional here, and they are now the shared startLine/endLine scope hint (resolveScope, step A1).
      const _resolvedVia = (startLine != null || endLine != null) ? 'positional' : null;
      if (occurrence > 1) bump('delete', 'hintsUsed.occurrence');
      if (fuzzyWhitespace) bump('delete', 'hintsUsed.fuzzyWhitespace');

      if (startLine == null || endLine == null) {
        return { content: [{ type: "text", text: "\u274C Provide one of: banner, ifdefBlock, inFunction, startContent+endContent, matchString, or startLine+endLine." }], deleted: false };
      }

      // R3a / H13 step A2 (2026-11-12): startLine/endLine are the MATCH given by position (as matchString is the match by
      // content), so the range is validated and resolved by the shared scope engine -- the same resolveScope() every other
      // mode uses -- instead of by hand here. The engine returns the exact row range, or an anchorError carrying the
      // pre-formatted message (wording unchanged) and a `reason` that is tallied below.
      const _rScope = resolveScope({ editor, buffer, allLines, text: ctx.text, filePath: ctx.filePath, params: { startLine, endLine } });
      if (_rScope.error) {
        ctx.consec.count++;
        bump('delete', _rScope.error.reason === 'inverted' ? 'fails.inverted' : 'fails.outOfRange');
        return { content: [{ type: "text", text: [
          _rScope.error.message,
          smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: !inFunction, fileLines: lineCount, oldStr: null, isCodeFile })
        ].filter(Boolean).join("\n") }], deleted: false, consecFailures: ctx.consec.count };
      }
      const startRow = _rScope.searchStart;
      const endRow   = _rScope.searchEnd;
      // T3: optional content verification for the raw-line (positional) path. A raw
      // startLine+endLine range has no matching step, so without this it deletes whatever
      // sits at those positions even if it's the wrong block -- a silent-wrong-delete risk
      // structurally identical to the pre-B38 replace bug, except here there was never a
      // matching step to have a bug in. This check is opt-in (only runs when expectedContent
      // is passed) so it doesn't break existing positional callers that don't use it -- same
      // shape as insert's onLine+expectedContent pattern.
      if (expectedContent !== undefined && _resolvedVia === 'positional') {
        const _targetLines = allLines.slice(startLine - 1, endLine);
        const _found = _targetLines.some(l => l.includes(expectedContent));
        if (!_found) {
          ctx.consec.count++;
          bump('delete', 'fails.expectedContentMismatch');
          const _preview2 = _targetLines.map((l, i) => `${String(startLine + i).padStart(4)}: ${l}`).join("\n");
          return { content: [{ type: "text", text: [
            `\u274C expectedContent mismatch \u2014 lines ${startLine}\u2013${endLine} do not contain ${JSON.stringify(expectedContent)}.`,
            `\nActual content (lines ${startLine}\u2013${endLine}):\n${_preview2}`,
            smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: !inFunction, fileLines: lineCount, oldStr: null, isCodeFile })
          ].filter(Boolean).join("\n") }], deleted: false, consecFailures: ctx.consec.count };
        }
      }

      const r  = 3;
      const cs = Math.max(0, startLine - 1 - r);
      const ce = Math.min(lineCount - 1, endLine - 1 + r);
      const preview = allLines.slice(cs, ce + 1).map((l, i) => {
        const abs   = cs + i;
        const inDel = abs >= startLine - 1 && abs <= endLine - 1;
        return `${String(abs + 1).padStart(4)}${inDel ? " -" : "  "} ${l}`;
      }).join("\n");
      const deletedCount = endLine - startLine + 1;

      if (dryRun) {
        return ctx.dryRunReturn({
          content: [{ type: "text", text: [
            `\uD83D\uDD0D DRY RUN \u2014 will delete ${deletedCount} line(s) (${startLine}\u2013${endLine}).`,
            `\nContext (- = lines to be deleted):\n${preview}`,
            `\nReply with the same call without dryRun (or dryRun:false) to commit.`
          ].join("\n") }],
          dryRun: true, deleted: false, startLine, endLine, deletedCount
        });
      }

      // Commit tail through ctx.commit (see Mode 5). snapshotOriginal() before the write. The hand-built nudge text below is
      // kept as it is and passed as warnings.nudge, which ctx.commit honours ahead of successNudge: its wording is
      // delete-specific (it names matchString / startContent+endContent, not afterString) and successNudge has no
      // "not content-verified" line. Folding both into the shared successNudge is a separate, later step.
      ctx.snapshotOriginal();
      buffer.deleteRows(startRow, endRow);

      const newLineCount = buffer.getLineCount();
      const _lintSuffix  = await maybeLintSuffix(lint, editor, startRow, startRow + 5);
      let _noSymbolsHere = false;
      const _isPositional = _resolvedVia === 'positional';
      if (_isPositional) {
        try {
          const _syms = getSymbols(editor, buffer.getText(), ctx.filePath);
          _noSymbolsHere = Array.isArray(_syms) && _syms.length === 0;
        } catch (e) { /* symbol lookup failing shouldn't block the delete response */ }
      }
      const _driftNudge = _isPositional
        ? '\nHint: line numbers are positional and drift after edits above them; ' +
          (_noSymbolsHere
            ? 'no symbol table for this file type, so prefer startContent+endContent or matchString.'
            : 'prefer inFunction, startContent+endContent or matchString.')
        : '';
      const _unverifiedNudge = (_isPositional && expectedContent === undefined)
        ? '\nNote: this delete was not content-verified; pass expectedContent next time to confirm the target lines first.'
        : '';
      const _commit6 = await ctx.commit({ line: startLine, linesChanged: -deletedCount }, { lint: _lintSuffix, nudge: _driftNudge + _unverifiedNudge });
      return {
        ..._commit6,
        dryRun: false, deleted: true, newLineCount, deletedCount, staleLinesWarning: _isPositional, contentVerified: !(_isPositional && expectedContent === undefined)
      };
    },
  });


  registerMcpTool({
    name: 'get-selection',
    group: 'edit',
    category: 'nav',
    requiresEditor: true,
    title: 'Get Selection',
    description: "Return the text and line/column range currently selected in the active editor. Returns startLine, endLine, startCol, endCol (all 1-based) alongside the selected text.",
    inputSchema: {},
    async handler(args, ctx) {
      const { editor } = ctx;
      const selectedText = editor.getSelectedText();
      const range        = editor.getSelectedBufferRange();

      bump('get_selection', 'hits');
      return {
        content: [{ type: "text", text: JSON.stringify({ selectedText, startLine: range.start.row + 1, endLine: range.end.row + 1, startCol: range.start.column + 1, endCol: range.end.column + 1 }, null, 2) }]
      };
    }
  });

  // -- `read` â€” generic anchor-based read tool. Merged get-region and read-lines
  // (2026-09-18, session notes 31/32) â€” both retired, this is the sole replacement.
  // Built on resolveScope()/matchContentEngine() instead of either source tool's
  // hand-rolled matcher.
  async function readHandler({
    filePath, inFunction, afterFunction, beforeFunction, afterSymbol, beforeSymbol,
    afterString, beforeString, afterLine, beforeLine, betweenHint,
    banner, ifdefBlock, ifdefEdge,
    startContent, endContent, inclusive = true,
    centerLine, nearLine, radius, startLine, endLine,
    occurrence, fuzzyWhitespace = false, fuzzyContent = false,
  }) {
    let text, staleWarning;
    try { ({ text, staleWarning } = await readTextFromFile(filePath)); }
    catch (err) { throw new Error(`Cannot read file: ${filePath} - ${err.message}`); }
    const resolvedPath = filePath;
    const allLines  = text.split(/\r?\n/);
    const lineCount = allLines.length;
    const editor = atom.workspace.getTextEditors().find(e => e.getPath && e.getPath() === resolvedPath) || null;

    let sliceStart, sliceEnd;
    let _pageNote = '';

    // Substring-line fallback for the pair-anchor mode below. get-region's original
    // findAnchorInLines matched startContent/endContent as a SUBSTRING anywhere on a
    // line ("unique text at or near the start/end"), not a full-line exact match.
    // matchContentEngine's default comparator is full-line equality (a === b) -- fine
    // for replace/insert/delete's old_str-style callers, but a silent behavior
    // regression here: a caller passing partial-line text (which get-region's own
    // description explicitly invites) would get a false "not found" instead of the
    // match get-region always gave. Bug found + fixed same session via live testing
    // (see session notes) before this ever reached the get-region/read-lines alias
    // layer, so no existing caller was ever exposed to it.
    // 2026-10-15: the function itself now lives in lib/substring-lines.js (imported at the top of this file).

    const pairStart = startContent || (betweenHint && betweenHint.start);
    const pairEnd   = endContent   || (betweenHint && betweenHint.end);
    if (pairStart && pairEnd) {
      const _startScope = resolveScope({ editor, buffer: null, allLines, text, filePath: resolvedPath, params: { occurrence, fuzzyWhitespace } });
      let _startMatch = matchContentEngine(pairStart, { allLines, text }, _startScope, { fuzzyWhitespace, fuzzyContent, occurrence, autoRescue: false });
      if (!_startMatch.matched && _startMatch.reason !== 'ambiguous' && _startMatch.reason !== 'occurrenceOutOfRange') {
        // Fall back to substring-per-line matching (get-region's original semantics â€”
        // "unique text at or near the start", not necessarily a whole line) before
        // giving up. matchContentEngine's own reason takes priority when it found
        // something ambiguous, so we don't mask a real ambiguity with a lucky
        // substring hit elsewhere.
        _startMatch = findSubstringInLines(allLines, pairStart, _startScope.searchStart || 0, occurrence);
      }
      if (!_startMatch.matched) {
        bump('read', 'fails.startNotFound');
        if (_startMatch.reason === 'occurrenceOutOfRange') {
          return { content: [{ type: "text", text: `âŒ start anchor: occurrence:${_startMatch.occurrence} requested but only ${_startMatch.totalMatches} match${_startMatch.totalMatches === 1 ? '' : 'es'} found (lines ${(_startMatch.matchLines || []).join(', ')}). Use an occurrence between 1 and ${_startMatch.totalMatches}.` }], found: false };
        }
        if (_startMatch.reason === 'ambiguous') {
          const _lines = _startMatch.matchLines ? _startMatch.matchLines.join(', ') : 'multiple locations';
          return { content: [{ type: "text", text: `âŒ start anchor is ambiguous â€” matches more than one place (lines ${_lines}). Narrow it or pass occurrence:N.` }], found: false };
        }
        return { content: [{ type: "text", text: `âŒ start anchor not found: "${pairStart}"` }], found: false };
      }
      const startRow = _startMatch.matchLine;
      const _endScope = resolveScope({ editor, buffer: null, allLines, text, filePath: resolvedPath, params: { afterRow: startRow + 1 } });
      let _endMatch = matchContentEngine(pairEnd, { allLines, text }, _endScope, { fuzzyWhitespace, fuzzyContent, autoRescue: false });
      if (!_endMatch.matched && _endMatch.reason !== 'ambiguous') {
        _endMatch = findSubstringInLines(allLines, pairEnd, startRow + 1, undefined);
      }
      if (!_endMatch.matched) {
        bump('read', 'fails.endNotFound');
        if (_endMatch.reason === 'ambiguous') {
          const _lines = _endMatch.matchLines ? _endMatch.matchLines.join(', ') : 'multiple locations';
          return { content: [{ type: "text", text: `âŒ end anchor is ambiguous â€” matches more than one place after the start anchor (lines ${_lines}).` }], found: false };
        }
        return { content: [{ type: "text", text: `âŒ end anchor not found after line ${startRow + 1}: "${pairEnd}"` }], found: false };
      }
      const endRow = _endMatch.matchEndLine;
      sliceStart = inclusive ? startRow : startRow + 1;
      sliceEnd   = inclusive ? endRow   : endRow   - 1;
      // Count the pair mode under the spelling the caller used. startContent/endContent take
      // precedence over betweenHint (see pairStart/pairEnd above), so mirror that here --
      // otherwise the startContent/endContent counters could never move.
      if (startContent || endContent) {
        if (startContent) bump('read', 'hintsUsed.startContent');
        if (endContent)   bump('read', 'hintsUsed.endContent');
      } else {
        bump('read', 'hintsUsed.betweenHint');
      }
      if (occurrence > 1) bump('read', 'hintsUsed.occurrence');
    }
    else if (centerLine !== undefined || nearLine !== undefined) {
      const center = centerLine !== undefined ? centerLine : nearLine;
      const r = radius !== undefined ? radius : 10;
      sliceStart = Math.max(0, center - 1 - r);
      sliceEnd   = Math.min(lineCount - 1, center - 1 + r);
      bump('read', 'hintsUsed.nearLine');
    }
    else if (startLine !== undefined && endLine !== undefined) {
      if (startLine < 1) throw new Error("startLine must be >= 1.");
      if (endLine < startLine) throw new Error(`endLine (${endLine}) must be >= startLine (${startLine}).`);
      if (startLine > lineCount) throw new Error(`startLine (${startLine}) exceeds file line count (${lineCount}).`);
      sliceStart = startLine - 1;
      sliceEnd   = Math.min(endLine, lineCount) - 1;
    }
    else {
      const scope = resolveScope({
        editor, buffer: null, allLines, text, filePath: resolvedPath,
        params: { inFunction, afterFunction, beforeFunction, afterSymbol, beforeSymbol,
                  afterString, beforeString, afterLine, beforeLine,
                  banner, ifdefBlock, ifdefEdge, occurrence, fuzzyWhitespace },
      });
      if (scope.error) {
        const e = scope.error;
        // Bucket by what actually went wrong. An ambiguous hint is a different failure from a
        // missing one: two signals mean "ambiguous" -- kind:'ambiguous' (function/string hints)
        // and ambiguous:true on an anchorError (structural banner/ifdefBlock). Everything
        // else counts as not-found, as before.
        bump('read', (e.kind === 'ambiguous' || e.ambiguous === true) ? 'fails.ambiguous' : 'fails.anchorNotFound');
        // Pre-formatted failures (structural banner/ifdefBlock anchors, betweenHint)
        // carry their own complete message -- including the candidate line list for an
        // ambiguous anchor -- so surface it verbatim rather than the generic wording below.
        if (e.kind === 'anchorError') {
          return { content: [{ type: "text", text: e.message }], found: false };
        }
        if (e.kind === 'ambiguous') {
          return { content: [{ type: "text", text: `âŒ ${e.hintName}:"${e.hintValue}" is ambiguous â€” pass occurrence:N to disambiguate.` }], found: false };
        }
        if (e.kind === 'notFound') {
          return { content: [{ type: "text", text: `âŒ ${e.hintName}:"${e.hintValue}" not found in ${resolvedPath}.` }], found: false };
        }
        return { content: [{ type: "text", text: `âŒ ${e.message || 'Could not resolve scope hint.'}` }], found: false };
      }
      if (!scope._hasScope) {
        // No anchor: the whole file in pages (replaces read-file); startLine alone = start at that line.
        const _page = wholeFilePage(lineCount, startLine);
        if (_page.error) throw new Error(_page.error);
        sliceStart = _page.sliceStart;
        sliceEnd   = _page.sliceEnd;
        _pageNote  = _page.note;
        bump('read', 'hintsUsed.wholeFile');
      } else {
        sliceStart = scope.searchStart;
        sliceEnd   = scope.searchEnd;
      }
      if (inFunction) bump('read', 'hintsUsed.inFunction');
      if (afterFunction) bump('read', 'hintsUsed.afterFunction');
      if (beforeFunction) bump('read', 'hintsUsed.beforeFunction');
      if (afterSymbol) bump('read', 'hintsUsed.afterSymbol');
      if (beforeSymbol) bump('read', 'hintsUsed.beforeSymbol');
      if (afterString) bump('read', 'hintsUsed.afterString');
      if (beforeString) bump('read', 'hintsUsed.beforeString');
      if (banner !== undefined) bump('read', 'hintsUsed.banner');
      if (ifdefBlock !== undefined) bump('read', 'hintsUsed.ifdefBlock');
      if (occurrence != null) bump('read', 'hintsUsed.occurrence');
    }

    const lines = allLines.slice(sliceStart, sliceEnd + 1).map((t, i) => ({ n: sliceStart + i + 1, text: t }));
    bump('read', 'hits');
    return {
      ...buildSearchResponse({ staleWarning: [staleWarning, _pageNote].filter(Boolean).join('\n'), body: JSON.stringify({
        filePath: resolvedPath, totalLines: lineCount,
        startLine: sliceStart + 1, endLine: sliceEnd + 1,
        returnedLines: lines.length, lines
      }, null, 2) }),
      found: true, totalLines: lineCount, startLine: sliceStart + 1, endLine: sliceEnd + 1, returnedLines: lines.length
    };
  }

  registerMcpTool({
    name: 'read',
    group: 'edit',
    category: 'nav',
    requiresEditor: false,
    title: 'Read',
    description: [
      "Read `filePath` (required) without opening it: a section by the same anchors replace/insert/delete take, or the whole file with no anchor. Pick one:",
      "(1) inFunction:'fn' - the whole function body (most reliable).",
      "(2) afterFunction/beforeFunction/afterSymbol/beforeSymbol:'name' - a window next to a named symbol.",
      "(3) afterString/beforeString:'text' - a window next to a unique line.",
      "(3b) banner:'TEXT' - the whole section-banner block; ifdefBlock:'MACRO' - the whole #ifdef..#endif (ifdefEdge:'open'|'close' returns just that one line). get-structural-anchors lists the names.",
      "(4) betweenHint:{start,end} or startContent+endContent - from the start anchor's line to the end anchor's line; inclusive:false drops the anchor lines.",
      "(5) centerLine or nearLine:N with radius:N (default 10) - context around a known line.",
      "(6) startLine + endLine - exact range, the least drift-resistant.",
      "(7) no anchor at all - the whole file in pages of 2000 lines; startLine alone starts at that line (the note says which startLine gives the next page).",
      "occurrence:N picks among several matches; an ambiguous anchor is refused with the candidate lines listed, never guessed. fuzzyWhitespace/fuzzyContent relax the content-matching hints as in replace. Anchor modes are immune to line drift. Returns lines with their real 1-based numbers, reusable as afterLine/beforeLine.",
    ].join(" "),
    inputSchema: {
      ...FILE_SCHEMA,
      scope: SCOPE_OBJECT_SCHEMA,
      startContent:   z.string().optional(),
      endContent:     z.string().optional(),
      inclusive:      z.boolean().optional(),
      centerLine:     z.number().optional(),
      nearLine:       z.number().optional(),
      radius:         z.number().optional(),
      startLine:      z.number().optional(),
      endLine:        z.number().optional(),
      occurrence:     z.number().int().min(1).optional(),
      fuzzyWhitespace: z.boolean().optional(),
      fuzzyContent:    z.boolean().optional(),
      regex:           REGEX_REMOVED_PARAM,
    },
    handler: readHandler,
  });
  } // end EDIT GROUP

  // â”€â”€ replace (2026-09-25, decision A) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Built 100% on the shared match engine from day one (resolveScope/matchContent/
  // applyEdit/buildFailResponse/buildReplacePreview -- the same primitives
  // insert/delete/replace-block use). Own stats namespace ('replace') -- see
  // mcp-server-refactor-plan.md's "OPEN DECISIONS FOR PJ" section, decision A.
  // Decision B (same session, SUPERSEDED 2026-10-08 by PJ): the default mode has NO
  // sub-line matching -- old_str must match one or more WHOLE lines. The opt-in
  // fragment:true mode adds PART-LINE replace (plain single-line literal, only the
  // matched span is written, via fragment-match.js matchFragment + applyEditSpan).
  // This reverses the 2026-09-27 'replace stays whole-line permanently' ruling at
  // PJ's direction; part-line behaviour is never the default.
  if (g('edit')) registerMcpTool({
    name:     'replace',
    group:    'edit',
    category: 'edit',
    features: { dryRun: true, lint: true, styleCheck: true, consecutiveFailureCounter: true, retryOnFail: { field: 'old_str' } },
    title:    'Replace',
    description: [
      "Replace WHOLE lines (default) or, with fragment:true, an exact part-line or multi-line span, matching `old_str` with `new_str` in `filePath` (required). Built on the shared match engine used by every edit tool.",
      "Default: old_str must match one or more whole lines exactly (after any fuzzy tolerance); it cannot match mid-line.",
      "fragment:true: old_str is a plain literal that may span lines and start or end mid-line; ONLY that span is replaced. A multi-line fragment must match exactly once (occurrence:N picks one). guardIdentifier (default true) refuses a hit glued to a longer identifier (count inside discount); pass false for an intentional mid-identifier edit. fragment cannot be combined with fuzzyWhitespace or fuzzyContent.",
      "occurrence:N picks the Nth match; an ambiguous match with no occurrence is refused, never guessed. fuzzyWhitespace / fuzzyContent opt in to tolerance for indentation drift / unicode punctuation.",
      "REGEX IS REMOVED (2026-10-28): regex:true is refused. Use sed for regex edits, or fragment:true for a literal part-line edit.",
      "edits:[{old_str,new_str},...] instead of old_str/new_str applies several literal-span edits as ONE undo step, all or nothing: each old_str must match exactly once (checked after the edits before it), any failure writes nothing and names the failing edit. A multi-line old_str matches LF or CRLF alike and new text takes the line ending of the span it replaces. dryRun checks the whole set; backup:true first copies the current text to TEMP.",
      "dryRun:true previews the match and diff without writing; use it first when unsure.",
      "If a call fails because old_str is wrong, resend just { filePath, old_str:'<corrected>' } and the failed call's new_str and flags are merged in. Not offered when the text exists outside the scope hint (fix the hint instead) or when old_str starts or ends mid-line (resend the whole call with fragment:true).",
      "Scope hints (inFunction, afterString, beforeString, afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterLine, beforeLine, betweenHint, banner, ifdefBlock + ifdefEdge, hintRadius) limit the search as in insert and delete; get-structural-anchors lists valid names.",
    ].join(" "),
    inputSchema: {
      old_str:         z.string().optional(), // optional only because edits[] can be sent instead (XW11); the handler refuses a call with neither
      edits:           z.array(z.object({ old_str: z.string(), new_str: z.string() })).optional(), // XW11: all-or-nothing multi-edit, each old_str a literal span that must match exactly once
      backup:          z.boolean().optional(), // XW11: with edits, copy the file's current text to TEMP first
      new_str:         z.string().optional(), // optional at the schema only so a bare { filePath, old_str } retry (features.retryOnFail) passes MCP validation; the handler refuses a real call without it (2026-10-17, R1b)
      fuzzyWhitespace: z.boolean().optional(),
      fuzzyContent:    z.boolean().optional(),
      regex:           REGEX_REMOVED_PARAM,
      fragment:        z.boolean().optional(), // 2026-10-08: opt-in PART-LINE mode. old_str is a literal fragment (one or more lines); only that span is replaced
      guardIdentifier: z.boolean().optional(), // fragment mode only: default true refuses hits glued to a longer identifier (count inside discount)
      // XW23 step 2: the position hints (inFunction, afterString, ..., banner, ifdefBlock, ifdefEdge) are described by `scope`
      // only; the flat names still work (passthrough schema, see lib/scope-arg.js).
      ...withoutScopeHints(ANCHOR_SCHEMA),
      scope:         SCOPE_OBJECT_SCHEMA,
    },
    handler: async ({ old_str, new_str, occurrence, dryRun = false, inFunction, afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterString, beforeString, afterLine, beforeLine, betweenHint, banner, ifdefBlock, ifdefEdge, hintRadius, fuzzyWhitespace, fuzzyContent, fragment, guardIdentifier, edits, backup = false, lint = false }, ctx) => {
      const { editor, buffer, allLines } = ctx;
      const curTool = 'replace';
      const isCodeFile = isCodeFilePath(ctx.filePath);

      // XW11 (2026-11-19): edits[] = all-or-nothing multi-edit (lib/multi-edit-plan.js, pure + tested).
      if (edits !== undefined) {
        if (old_str !== undefined || new_str !== undefined) {
          return { content: [{ type: 'text', text: '\u274C replace refused: pass either old_str/new_str or edits, not both. Nothing was written.' }], found: false };
        }
        const { planMultiEdit, describeFailure } = require('./multi-edit-plan');
        const _mp = planMultiEdit({ text: ctx.text, edits });
        if (!_mp.ok) return { content: [{ type: 'text', text: '\u274C ' + describeFailure(_mp, edits) }], found: false };
        if (dryRun) {
          return ctx.dryRunReturn({ content: [{ type: 'text', text: `\uD83D\uDD0D DRY RUN: all ${edits.length} edits match exactly once (at lines ${_mp.applied.map(a => a.line).join(', ')}). Nothing written. Repeat the call without dryRun to apply them together.` }], dryRun: true, found: true });
        }
        let _bk = '';
        if (backup) {
          const _os = require('os'), _fs = require('fs'), _path = require('path');
          const _dir = _path.join(_os.tmpdir(), 'pulsar-mcp-backup');
          _fs.mkdirSync(_dir, { recursive: true });
          const _bf = _path.join(_dir, _path.basename(ctx.filePath) + '.' + Date.now() + '.bak');
          _fs.writeFileSync(_bf, ctx.text);
          _bk = ' - backup ' + _bf;
        }
        ctx.snapshotOriginal();
        buffer.setTextViaDiff(_mp.newText);
        const _mStyle = applyStyleCheck(edits.map(e => e.new_str).join('\n'), ctx.filePath);
        const _mLint  = await maybeLintSuffix(lint, editor, null, null, { rows: _changedRows(ctx.text, _mp.newText), pad: 1 });
        return { ...(await ctx.commit({ scopeLabel: ` - ${edits.length} edits applied together${_bk}` }, { lint: _mLint, style: _mStyle })), found: true, dryRun: false };
      }
      if (old_str === undefined) {
        return { content: [{ type: 'text', text: '\u274C replace refused: pass old_str and new_str, or edits. Nothing was written.' }], found: false };
      }

      // 2026-10-17 (R1b): new_str is optional in the schema only so a bare { filePath, old_str } retry
      // (features.retryOnFail) can pass MCP transport validation. tool-framework.js merges the stashed
      // failed call's args in BEFORE this handler runs, so a call that still has no new_str here is a
      // real call that omitted it. Refuse it: an omitted new_str must never be treated as '' (that would
      // silently delete the matched text; pass '' to delete on purpose). No matched key on purpose:
      // matched:false would stash a useless pending failure over a good one.
      if (new_str === undefined) {
        return { content: [{ type: 'text', text: 'replace refused: new_str is required (pass \'\' to delete the matched text), unless you are retrying a failed call (not possible after a mid-line failure) with just { filePath, old_str: \'<corrected>\' }. Nothing was written.' }], found: false };
      }

      // Input guards (2026-10-08, borrowed from OpenCode's edit tool): refuse a
      // request that cannot be a real edit BEFORE any scope/match work. Not a
      // match failure, so ctx.consec is not incremented; logged via the fault
      // log (reason only, no stats key needed).
      if (old_str === '') {
        logMatchFailure({ tool: curTool, filePath: ctx.filePath, reason: 'emptyOldStr', needle: old_str, proposedNewStr: new_str, allLines, hints: {} });
        return { content: [{ type: 'text', text: 'replace refused: old_str is empty, so there is nothing to match. Pass the exact line(s) to replace (use insert to add new lines).' }], found: false };
      }
      if (old_str === new_str) {
        logMatchFailure({ tool: curTool, filePath: ctx.filePath, reason: 'identicalEdit', needle: old_str, proposedNewStr: new_str, allLines, hints: {} });
        return { content: [{ type: 'text', text: 'replace refused: old_str and new_str are identical, so there is no change to make. Nothing was written.' }], found: false };
      }

      if (inFunction)              bump(curTool, 'hintsUsed.inFunction');
      if (betweenHint)             bump(curTool, 'hintsUsed.betweenHint');
      if (afterString)             bump(curTool, 'hintsUsed.afterString');
      if (beforeString)            bump(curTool, 'hintsUsed.beforeString');
      if (afterFunction)           bump(curTool, 'hintsUsed.afterFunction');
      if (beforeFunction)          bump(curTool, 'hintsUsed.beforeFunction');
      if (afterSymbol)             bump(curTool, 'hintsUsed.afterSymbol');
      if (beforeSymbol)            bump(curTool, 'hintsUsed.beforeSymbol');
      if (afterLine != null)       bump(curTool, 'hintsUsed.afterLine');
      if (beforeLine != null)      bump(curTool, 'hintsUsed.beforeLine');
      if (banner !== undefined)  bump(curTool, 'hintsUsed.banner');
      if (ifdefBlock !== undefined) bump(curTool, 'hintsUsed.ifdefBlock');
      if (occurrence != null)      bump(curTool, 'hintsUsed.occurrence');
      if (fuzzyWhitespace)         bump(curTool, 'hintsUsed.fuzzyWhitespace');

      const scope = resolveScope({
        editor, buffer, allLines, text: ctx.text, filePath: ctx.filePath,
        params: { inFunction, betweenHint, afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterString, beforeString, afterLine, beforeLine, banner, ifdefBlock, ifdefEdge, occurrence, hintRadius, fuzzyWhitespace },
      });
      if (scope.error) {
        // Structural anchors (banner/ifdefBlock) report ambiguity as
        // kind:'anchorError' + ambiguous:true, not kind:'ambiguous' -- same
        // test delete uses.
        const _ambig = scope.error.kind === 'ambiguous' || scope.error.ambiguous === true;
        if (!_ambig) ctx.consec.count++;
        bump(curTool, _ambig ? 'fails.anchorAmbiguous' : 'fails.anchorNotFound');
        // 2026-09-28: hintsFailed parity with insert/delete (was never bumped
        // for replace's failure path -- only hintsUsed/hintsSucceeded existed).
        if (inFunction)              bump(curTool, 'hintsFailed.inFunction');
        if (betweenHint)             bump(curTool, 'hintsFailed.betweenHint');
        if (afterString)             bump(curTool, 'hintsFailed.afterString');
        if (beforeString)            bump(curTool, 'hintsFailed.beforeString');
        if (afterFunction)           bump(curTool, 'hintsFailed.afterFunction');
        if (beforeFunction)          bump(curTool, 'hintsFailed.beforeFunction');
        if (afterSymbol)             bump(curTool, 'hintsFailed.afterSymbol');
        if (beforeSymbol)            bump(curTool, 'hintsFailed.beforeSymbol');
        if (afterLine != null)       bump(curTool, 'hintsFailed.afterLine');
        if (beforeLine != null)      bump(curTool, 'hintsFailed.beforeLine');
        if (banner !== undefined)    bump(curTool, 'hintsFailed.banner');
        if (ifdefBlock !== undefined) bump(curTool, 'hintsFailed.ifdefBlock');
        if (occurrence != null)      bump(curTool, 'hintsFailed.occurrence');
        logMatchFailure({
          tool: curTool, filePath: ctx.filePath,
          reason: _ambig ? 'ambiguous' : (scope.error.kind || 'anchorNotFound'),
          needle: old_str, proposedNewStr: new_str, allLines,
          hints: { inFunction, betweenHint, afterFunction, beforeFunction, afterSymbol, beforeSymbol,
                   afterString, beforeString, afterLine, beforeLine, banner, ifdefBlock, ifdefEdge,
                   occurrence, fuzzyWhitespace, fuzzyContent },
        });
        return { ...buildFailResponse({ tool: curTool, ctx: { consec: ctx.consec, allLines, text: ctx.text }, scope, needle: old_str, isCodeFile }), found: false };
      }

      // 2026-10-08: successNudge -- same inputs, gated here by hand
      // because replace builds its own response instead of going through ctx.commit().
      // Symbols are only looked up when no scope hint was used (same cost rule as the framework).
      const _replNudge = (matchRow, nudgeOldStr) => {
        const _noHints = !(inFunction || betweenHint || afterFunction || beforeFunction || afterSymbol || beforeSymbol ||
          afterString || beforeString || afterLine != null || beforeLine != null ||
          banner !== undefined || ifdefBlock !== undefined || occurrence > 1);
        let _syms;
        if (_noHints) { try { _syms = getSymbols(editor, ctx.text, ctx.filePath); } catch (e) { _syms = undefined; } }
        return successNudge({
          toolName: curTool,
          noHintsUsed: _noHints,
          afterLineOnly: (afterLine != null) && !inFunction && !betweenHint && !afterFunction && !beforeFunction &&
                         !afterSymbol && !beforeSymbol && !afterString && !beforeString,
          matchedLineContent: allLines[matchRow] || '',
          fileLines: allLines.length,
          oldStr: nudgeOldStr,
          isCodeFile,
          symbols: _syms,
          filePath: ctx.filePath, // XW23: once-per-file "no scope hint" nudge
        });
      };

      // -- fragment:true (2026-10-08, PJ's direction): opt-in PART-LINE replace. Reuses the
      // S4b matchFragment() matcher over the resolved scope rows and applyEditSpan() to
      // write ONLY the matched span. Without fragment:true replace stays whole-line.
      // Plain literal, one or more lines (multi-line spans since 2026-10-16); fuzzy flags are refused, not ignored.
      if (fragment) {
        // 2026-10-08: hint stats parity with the whole-line path (same conditions as its
        // hintsSucceeded/hintsFailed blocks). bucket is 'Succeeded' or 'Failed'.
        const _fragHintBump = (bucket) => {
          const k = 'hints' + bucket + '.';
          if (inFunction)               bump(curTool, k + 'inFunction');
          if (betweenHint)              bump(curTool, k + 'betweenHint');
          if (afterString)              bump(curTool, k + 'afterString');
          if (beforeString)             bump(curTool, k + 'beforeString');
          if (afterFunction)            bump(curTool, k + 'afterFunction');
          if (beforeFunction)           bump(curTool, k + 'beforeFunction');
          if (afterSymbol)              bump(curTool, k + 'afterSymbol');
          if (beforeSymbol)             bump(curTool, k + 'beforeSymbol');
          if (afterLine != null)        bump(curTool, k + 'afterLine');
          if (beforeLine != null)       bump(curTool, k + 'beforeLine');
          if (banner !== undefined)     bump(curTool, k + 'banner');
          if (ifdefBlock !== undefined) bump(curTool, k + 'ifdefBlock');
          if (occurrence != null)       bump(curTool, k + 'occurrence');
        };
        const _fragRefuse = (reason, msg) => {
          bump(curTool, 'fragmentFails'); _fragHintBump('Failed');
          logMatchFailure({ tool: curTool, filePath: ctx.filePath, reason, needle: old_str, proposedNewStr: new_str, allLines, hints: { occurrence, fragment, guardIdentifier } });
          // 2026-10-17 (R1b): a refusal that a corrected old_str can fix (not found, ambiguous, glued to an
          // identifier) is marked matched:false, so tool-framework.js stashes the call and a bare
          // { filePath, old_str } resend works, and it carries the retry nudge. Every other refusal stays
          // found:false only (see isRetryableRefusal in lib/replace-fragment.js).
          if (isRetryableRefusal(reason)) {
            return { content: [{ type: 'text', text: msg + retryNudge(curTool) }], found: false, matched: false };
          }
          return { content: [{ type: 'text', text: msg }], found: false };
        };
        // Stage 1(b) (2026-10-09): lib/replace-fragment.js planFragmentReplace decides everything about a
        // fragment edit except the write itself: every refusal (flag clash, multi-line, the matcher
        // refusals and, on a commit, the drift pre-check), the span and the response tags. A refusal's
        // message, reason, fails.* key and consecutive-failure rule all follow the plan; _fragRefuse
        // adds fragmentFails, the hint counters and the fault log. The handler never matches itself.
        const _plan = planFragmentReplace({
          lines: allLines, startRow: scope.searchStart, endRow: scope.searchEnd,
          oldStr: old_str, newStr: new_str, occurrence, guardIdentifier,
          flags: { fuzzyWhitespace, fuzzyContent },
          liveLines: dryRun ? undefined : buffer.getLines(), // drift pre-check (reason fragmentDrift); a dry run omits it
        });
        if (!_plan.ok) {
          if (_plan.consecBump) ctx.consec.count++;
          for (const _k of _plan.statKeys) { if (_k !== 'fragmentFails') bump(curTool, _k); } // _fragRefuse bumps fragmentFails itself
          return _fragRefuse(_plan.reason, _plan.message);
        }
        // Success: the plan carries the span (edit) and the tags (fragment, plus guardedOut:N). On a
        // commit it has also run the drift pre-check (applyEditSpan relocates to the FIRST other
        // occurrence if the span moved, so for a destructive edit the plan refuses instead).
        const { row: _fragRow, startCol: _fragStartCol, endCol: _fragEndCol } = _plan.edit;
        const _fragEndRow = _plan.edit.endRow != null ? _plan.edit.endRow : _fragRow; // multi-line span (2026-10-16); equals _fragRow for a single-line fragment
        const _fragLine = allLines[_fragRow];
        const _fragTags = _plan.tags.slice();
        if (dryRun) {
          const _fragAfter = _fragLine.slice(0, _fragStartCol) + new_str + allLines[_fragEndRow].slice(_fragEndCol);
          return buildReplacePreview({ allLines, lineCount: allLines.length, matchLine: _fragRow, matchLines: allLines.slice(_fragRow, _fragEndRow + 1), new_str: _fragAfter, scopeLabel: scope.scopeLabel || '', tags: _fragTags });
        }
        const _fragOriginal = buffer.getText();
        const _fragPre = preEditSnapshot(editor); // struct-check snapshot (2026-10-08)
        const _fragEdit = applyEditSpan(buffer, { row: _fragRow, startCol: _fragStartCol, endRow: _fragEndRow, endCol: _fragEndCol, actualText: _plan.edit.actualText }, new_str);
        if (_fragEdit.error) {
          const _applyErr = describeApplyError(_fragEdit.error); // text + stat keys; not fault-logged, no consec bump (as before)
          for (const _k of _applyErr.statKeys) bump(curTool, _k);
          _fragHintBump('Failed');
          return { content: [{ type: 'text', text: _applyErr.message }], found: false };
        }
        decorateEditedLines(editor, _fragOriginal, buffer.getText());
        ctx.consec.count = 0; bump(curTool, 'hits');
        bump(curTool, 'fragmentCommits'); _fragHintBump('Succeeded');
        const _fragNewLineCount = buffer.getLineCount();
        const _fragLinesChanged = new_str.split('\n').length - (_fragEndRow - _fragRow + 1); // lines added (negative: removed); single-line fragment gives the old value
        const _fragLint  = await maybeLintSuffix(lint, editor, _fragRow, _fragRow + new_str.split('\n').length - 1);
        const _fragStyle = applyStyleCheck(new_str, ctx.filePath);
        return {
          ...(await buildEditResponse(
            { tool: curTool, line: _fragRow + 1, linesChanged: _fragLinesChanged, scopeLabel: scope.scopeLabel || '', tags: _fragTags, buffer },
            { nudge: _replNudge(_fragRow, old_str), lint: _fragLint, style: _fragStyle, struct: postEditDelta(_fragPre, editor).struct }
          )),
          found: true, dryRun: false, matchLine: _fragRow + 1, matchEndLine: _fragEndRow + 1, newLineCount: _fragNewLineCount
        };
      }

      const match = matchContentEngine(old_str, { allLines, text: ctx.text }, scope, { fuzzyWhitespace, fuzzyContent, occurrence });

      if (!match.matched) {
        if (match.reason !== 'ambiguous') ctx.consec.count++;
        // R3m (2026-11-07): the failure is counted ONCE, by buildCountedFailResponse below. This line used to bump fails.noMatch
        // itself and the diagnosis bumped it again (every failed call counted twice), and fails.ambiguous is not a key replace has.
        if (inFunction)              bump(curTool, 'hintsFailed.inFunction');
        if (betweenHint)             bump(curTool, 'hintsFailed.betweenHint');
        if (afterString)             bump(curTool, 'hintsFailed.afterString');
        if (beforeString)            bump(curTool, 'hintsFailed.beforeString');
        if (afterFunction)           bump(curTool, 'hintsFailed.afterFunction');
        if (beforeFunction)          bump(curTool, 'hintsFailed.beforeFunction');
        if (afterSymbol)             bump(curTool, 'hintsFailed.afterSymbol');
        if (beforeSymbol)            bump(curTool, 'hintsFailed.beforeSymbol');
        if (afterLine != null)       bump(curTool, 'hintsFailed.afterLine');
        if (beforeLine != null)      bump(curTool, 'hintsFailed.beforeLine');
        if (banner !== undefined)    bump(curTool, 'hintsFailed.banner');
        if (ifdefBlock !== undefined) bump(curTool, 'hintsFailed.ifdefBlock');
        if (occurrence != null)      bump(curTool, 'hintsFailed.occurrence');
        logMatchFailure({
          tool: curTool, filePath: ctx.filePath,
          reason: match.reason || 'noMatch',
          needle: old_str, proposedNewStr: new_str, allLines,
          hints: { inFunction, betweenHint, afterFunction, beforeFunction, afterSymbol, beforeSymbol,
                   afterString, beforeString, afterLine, beforeLine, banner, ifdefBlock, ifdefEdge,
                   occurrence, fuzzyWhitespace, fuzzyContent },
        });
        // R1e (2026-10-17): old_str that starts or ends mid-line can only match in fragment mode; say so (not for an ambiguous match).
        const _midLine = match.reason === 'ambiguous' ? null : midLineHint({ needle: old_str, text: ctx.text, scopeStart: scope && scope.searchStart, scopeEnd: scope && scope.searchEnd, fuzzyWhitespace, fuzzyContent });
        return { ...buildCountedFailResponse({ tool: curTool, ctx: { consec: ctx.consec, allLines, text: ctx.text }, scope, match, needle: old_str, isCodeFile, midLine: _midLine }, match.reason === 'ambiguous' ? 'fails.anchorAmbiguous' : 'fails.noMatch'), found: false };
      }

      const _tags = (match.transforms || []).slice();
      if ((match.transforms || []).includes('fuzzyWhitespace')) bump(curTool, 'fuzzyTriggerReasons.needsWhitespace');
      if ((match.transforms || []).includes('fuzzyContent'))    bump(curTool, 'fuzzyTriggerReasons.needsContent');
      if ((match.transforms || []).includes('partial'))         bump(curTool, 'fuzzyTriggerReasons.partial');

      if (dryRun) {
        // dryRuns is counted centrally in tool-framework.js (buildReplacePreview's result carries dryRun:true)
        return buildReplacePreview({
          allLines, lineCount: allLines.length,
          matchLine: match.matchLine, matchLines: match.actualLines,
          new_str, scopeLabel: scope.scopeLabel || '', tags: _tags,
        });
      }

      const originalText = buffer.getText();
      const _preSnap = preEditSnapshot(editor); // struct-check snapshot, same as replace (2026-10-08)
      const edit = applyEdit(buffer, match, new_str, old_str); // old_str passed 2026-09-27 so a fuzzyWhitespace match reindents new_str to the buffer's real indentation (session notes [60]/[61])
      if (edit.error) {
        bump(curTool, 'fails.noMatch');
        return { content: [{ type: 'text', text: `âŒ ${curTool}: ${edit.error} â€” the buffer changed since the match was resolved; re-run to re-resolve.` }], found: false };
      }
      decorateEditedLines(editor, originalText, buffer.getText());
      ctx.consec.count = 0; bump(curTool, 'hits');
      if ((match.transforms || []).includes('fuzzyWhitespace')) bump(curTool, 'fuzzyWhitespaceCommits');
      if ((match.transforms || []).includes('fuzzyContent'))    bump(curTool, 'fuzzyContentCommits');
      if (inFunction)              bump(curTool, 'hintsSucceeded.inFunction');
      if (betweenHint)             bump(curTool, 'hintsSucceeded.betweenHint');
      if (afterString)             bump(curTool, 'hintsSucceeded.afterString');
      if (beforeString)            bump(curTool, 'hintsSucceeded.beforeString');
      if (afterFunction)           bump(curTool, 'hintsSucceeded.afterFunction');
      if (beforeFunction)          bump(curTool, 'hintsSucceeded.beforeFunction');
      if (afterSymbol)             bump(curTool, 'hintsSucceeded.afterSymbol');
      if (beforeSymbol)            bump(curTool, 'hintsSucceeded.beforeSymbol');
      if (afterLine != null)       bump(curTool, 'hintsSucceeded.afterLine');
      if (beforeLine != null)      bump(curTool, 'hintsSucceeded.beforeLine');
      if (banner !== undefined)    bump(curTool, 'hintsSucceeded.banner');
      if (ifdefBlock !== undefined) bump(curTool, 'hintsSucceeded.ifdefBlock');
      if (occurrence != null)      bump(curTool, 'hintsSucceeded.occurrence');

      const newLineCount = buffer.getLineCount();
      const linesChanged = new_str.split("\n").length - (match.matchEndLine - match.matchLine + 1);
      const _lintSuffix  = await maybeLintSuffix(lint, editor, match.matchLine, match.matchLine + new_str.split("\n").length - 1);
      const _styleSuffix = applyStyleCheck(new_str, ctx.filePath);

      return {
        ...(await buildEditResponse(
          { tool: curTool, line: match.matchLine + 1, linesChanged, scopeLabel: scope.scopeLabel || '', tags: _tags, buffer },
          { nudge: _replNudge(match.matchLine, old_str), lint: _lintSuffix, style: _styleSuffix, struct: postEditDelta(_preSnap, editor).struct }
        )),
        found: true, dryRun: false, matchLine: match.matchLine + 1, matchEndLine: match.matchEndLine + 1, newLineCount
      };
    },
  });


  // -- CORE GROUP (always on) -------------------------------------------------
  // -- FILE-OPS GROUP ---------------------------------------------------------
  if (g('fileOps')) {
  registerMcpTool({
    name: 'get-project-files',
    group: 'fileOps',
    category: 'nav',
    requiresEditor: false,
    title: 'Get Project Files',
    description: [
      "Return a list of all files under the current project roots.",
      "Pass a glob pattern (e.g. '**/*.c', '**/*.h', 'src/**/*.js') to filter results.",
      "Without a glob, returns every file. Equivalent to CC's Glob tool."
    ].join(" "),
    inputSchema: {
      glob: z.string().optional(),
      project: z.string().optional()
    },
    async handler({ glob = '', project } = {}) {
      const _pr = _projectRoots(project);
      if (!_pr.ok) return { content: [{ type: 'text', text: _pr.error }], fileCount: 0 };
      const roots = _pr.roots;
      let files = [];
      const _walkOpts = { deadline: Date.now() + 20000 };
      for (const root of roots) files = await walkDir(root, files, _walkOpts);
      const _walkNote = _walkOpts.hit ? '\n(file walk stopped at its 20 s limit; list is partial, pass project or a narrower glob)' : '';
      if (glob) {
        const globRe = globToRegex(glob);
        files = files.filter(f => globRe.test(f.replace(/\\/g, "/")));
      }
      bump('get_project_files', 'hits');
      return {
        content: [{ type: 'text', text: files.join('\n') + _walkNote }],
        fileCount: files.length
      };
    },
  });
  } // end FILE-OPS GROUP (get-project-files)

  // -- NAVIGATION GROUP ------------------------------------------------------
  if (g('navigation')) {
  registerMcpTool({
    name: 'open-file',
    group: 'navigation',
    category: 'nav',
    requiresEditor: false,
    title: 'Open File',
    description: "Open a file in a Pulsar tab so the human can see its contents, watch edits happen live as tools run, hand-edit it themselves, or highlight sections for you to look at. Not required before any other tool â€” read and edit tools accept filePath directly. Use this when you want the file visible on screen for the user.",
    inputSchema: { ...FILE_SCHEMA },
    async handler({ filePath }) {
      const editor    = await atom.workspace.open(filePath);
      editor.setCursorBufferPosition([0, 0], { autoscroll: true });
      const lineCount = editor.getBuffer().getLineCount();
      const language  = editor.getGrammar() ? editor.getGrammar().name : 'Unknown';
      bump('open_file', 'hits');
      return {
        content: [{ type: 'text', text: `Opened file: ${filePath}\nLines: ${lineCount}, Language: ${language}` }],
        file: filePath, lineCount, language, isActive: true
      };
    },
  });

  registerMcpTool({
    name: 'goto-line',
    group: 'navigation',
    category: 'nav',
    requiresEditor: true,
    title: 'Go To Line',
    description: "Jump the cursor to a specific line number (and optionally column) in the active editor. Returns the line content and surrounding context so you can verify you jumped to the right place.",
    inputSchema: { lineNumber: z.number(), column: z.number().optional() },
    async handler({ lineNumber, column = 0 }, ctx) {
      const lineCount = ctx.buffer.getLineCount();
      if (lineNumber < 1 || lineNumber > lineCount)
        return ctx.fail('outOfRange', `goto-line: Line ${lineNumber} is out of range (1-${lineCount}).`);
      const row          = lineNumber - 1;
      ctx.editor.setCursorBufferPosition([row, column], { autoscroll: true });
      const contextStart = Math.max(0, row - 2);
      const contextEnd   = Math.min(lineCount - 1, row + 2);
      const lines        = ctx.allLines.slice(contextStart, contextEnd + 1).map((t, i) => `${contextStart + i + 1}: ${t}`);
      bump('goto_line', 'hits');
      return {
        content: [{ type: 'text', text: `Jumped to line ${lineNumber}, column ${column}.\nContext:\n${lines.join('\n')}` }],
        line: lineNumber, column, lineContent: ctx.buffer.lineForRow(row), context: lines
      };
    },
  });

  registerMcpTool({
    name: 'list-open-files',
    group: 'navigation',
    category: 'nav',
    requiresEditor: false,
    title: 'List Open Files',
    description: "Return a list of all files currently open in editor tabs. Useful for understanding what files are in the workspace context.",
    inputSchema: {},
    async handler() {
      // [B26 note] modified was dropped 2026-07-17 â€” since edit tools now
      // auto-save on commit, isModified() is almost always false right after
      // any MCP-driven edit and stopped being a useful signal. This tool's
      // job is just "what's open in a tab", per its own description.
      const openFiles = atom.workspace.getTextEditors().map(editor => ({
        filePath: editor.getPath() || '[untitled]'
      }));
      bump('list_open_files', 'hits');
      return {
        content: [{ type: 'text', text: JSON.stringify({ openFileCount: openFiles.length, files: openFiles }, null, 2) }],
        openFiles, count: openFiles.length
      };
    },
  });

  registerMcpTool({
    name: 'get-file-info',
    group: 'navigation',
    category: 'nav',
    requiresEditor: false,
    title: 'Get File Info',
    description: "Metadata for a file without loading its content: filename, full path and line count; if the file is open in a tab also language, cursor, active and modified. filePath is optional: omit it for the active editor.",
    inputSchema: { filePath: z.string().optional() },
    async handler({ filePath } = {}, ctx) {
      const active = atom.workspace.getActiveTextEditor();
      const ed = filePath
        ? atom.workspace.getTextEditors().find(e => e.getPath() && path.resolve(e.getPath()) === path.resolve(filePath))
        : active;
      if (!filePath && !ed) return ctx.fail('noEditor', 'get-file-info: no active editor; pass filePath.');
      const full = filePath || ed.getPath() || '[untitled]';
      let lineCount;
      if (ed) lineCount = ed.getBuffer().getLineCount();
      else {
        try { lineCount = (await readTextFromFile(filePath)).text.split(/\r?\n/).length; }
        catch (err) { return ctx.fail('notFound', 'get-file-info: cannot read ' + filePath + ': ' + err.message); }
      }
      const info = { filename: full === '[untitled]' ? full : path.basename(full), filePath: full, lineCount, open: !!ed };
      if (ed) {
        const cur = ed.getCursorBufferPosition();
        Object.assign(info, { active: ed === active, language: ed.getGrammar() ? ed.getGrammar().name : 'Unknown', cursorLine: cur.row + 1, cursorCol: cur.column, modified: ed.isModified() });
      }
      bump('get_file_info', 'hits');
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }], ...info };
    },
  });


  registerMcpTool({
    name: 'close-file',
    group: 'navigation',
    category: 'nav',
    requiresEditor: false,
    title: 'Close File',
    description: "Close an editor tab by path (required â€” same shared file-schema as every other tool, so there is no ambiguity when two files share a basename). " +
      "Set save:true to save unsaved changes before closing (default: false â€” unsaved changes are discarded). " +
      "Returns {closed:true} on success or {closed:false, error} if the file was not found.",
    inputSchema: {
      ...FILE_SCHEMA,
      save: z.boolean().optional().describe("Save before closing if the buffer has unsaved changes (default: false)."),
    },
    async handler({ filePath, save = false }, ctx) {
      const editor = atom.workspace.getTextEditors().find(e => e.getPath() === filePath);
      if (!editor) {
        return ctx.fail('notFound', `close-file: no open editor found for path: ${filePath}`, { closed: false, error: 'notFound' });
      }
      const pane = atom.workspace.paneForItem(editor);
      if (save && editor.isModified()) {
        await editor.save();
      }
      pane.destroyItem(editor, true);
      bump('close_file', 'hits');
      return { content: [{ type: 'text', text: `Closed: ${filePath || editor.getPath() || '[untitled]'}` }], closed: true };
    },
  });

  registerMcpTool({
    name: 'goto-focus',
    group: 'navigation',
    category: 'nav',
    requiresEditor: true,
    title: 'Goto Focus',
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
    async handler({ selections }, ctx) {
      const ranges = selections.map(sel => {
        const sr = (sel.startLine   || 1) - 1;
        const sc = (sel.startColumn || 1) - 1;
        const er = sel.endLine   ? sel.endLine   - 1 : sr;
        const ec = sel.endColumn ? sel.endColumn - 1 : sc;
        return [[sr, sc], [er, ec]];
      });
      ctx.editor.setSelectedBufferRanges(ranges);
      bump('goto_focus', 'hits');
      return { content: [{ type: 'text', text: `Set ${selections.length} selection(s)` }], set: true, count: selections.length };
    },
  });

  registerMcpTool({
    name: 'get-project-paths',
    group: 'navigation',
    category: 'nav',
    requiresEditor: false,
    title: 'Get Project Paths',
    description: "Return the list of root folder paths currently open in the Pulsar project. " +
      "Useful for resolving relative paths and understanding the workspace layout. " +
      "Returns an empty array if no project folders are open.",
    inputSchema: {},
    async handler() {
      const paths = atom.project.getPaths();
      bump('get_project_paths', 'hits');
      return { content: [{ type: 'text', text: JSON.stringify(paths, null, 2) }], paths };
    },
  });

  registerMcpTool({
    name: 'add-project-path',
    group: 'navigation',
    category: 'nav',
    requiresEditor: false,
    title: 'Add Project Path',
    description: "Add an additional root folder to the Pulsar project without removing existing roots. " +
      "Useful for multi-repo workflows. The path must exist on disk. " +
      "Returns {added:true, paths:[...]} with the updated project path list on success.",
    inputSchema: {
      path: z.string().describe("Absolute folder path to add to the project."),
    },
    async handler({ path: folderPath }, ctx) {
      if (!folderPath) throw new Error('path is required');
      const fs = require('fs');
      if (!fs.existsSync(folderPath)) {
        return ctx.fail('notFound', `add-project-path: path does not exist: ${folderPath}`, { added: false, error: 'notFound' });
      }
      atom.project.addPath(folderPath);
      bump('add_project_path', 'hits');
      const paths = atom.project.getPaths();
      return { content: [{ type: 'text', text: `Added: ${folderPath}\nProject paths: ${paths.join(', ')}` }], added: true, paths };
    },
  });

  } // end NAVIGATION GROUP

  // -- SAFETY GROUP ----------------------------------------------------------
  if (g('safety')) {
  registerMcpTool({
    name: 'undo',
    group: 'navigation',
    category: 'nav',
    requiresEditor: true,
    title: 'Undo',
    description: "Undo the last change in the active editor.",
    inputSchema: {},
    handler(args, ctx) {
      const before = ctx.buffer.getText();
      ctx.editor.undo();
      const changed = before !== ctx.buffer.getText();
      bump('undo', 'hits');
      return { content: [{ type: 'text', text: changed ? 'Undo completed.' : 'Nothing to undo.' }] };
    },
  });

  registerMcpTool({
    name: 'redo',
    group: 'navigation',
    category: 'nav',
    requiresEditor: true,
    title: 'Redo',
    description: "Redo the last undone change in the active editor.",
    inputSchema: {},
    handler(args, ctx) {
      const before = ctx.buffer.getText();
      ctx.editor.redo();
      const changed = before !== ctx.buffer.getText();
      bump('redo', 'hits');
      return { content: [{ type: 'text', text: changed ? 'Redo completed.' : 'Nothing to redo.' }] };
    },
  });
  } // end SAFETY GROUP (undo/redo â€” more safety tools added later)

  // ---------------------------------------------------------------------------
  // Cross-file tools
  // ---------------------------------------------------------------------------

  // -- FILE-OPS GROUP (continued) --------------------------------------------
  if (g('fileOps')) {
// â”€â”€ run-command (migrated to Tool Framework) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (g('fileOps')) registerMcpTool({
    name:           'run-command',
    group:          'fileOps',
    category:       'command',
    requiresEditor: false,
    title: 'Run Command',
    description: [
      "Run a shell command; returns stdout, stderr and exit code. PowerShell on Windows, /bin/sh on Linux/Mac. cwd defaults to the first project root; pass cwd as 'root:<rootFolderName>/<subpath>' to pick a root when several are open (get-project-paths lists them). timeout defaults to 30 seconds (in ms). Use for builds, tests, git status, etc.",
      "showOutput (default true) streams output live to the Command Output panel only, never the chat; set false for noisy commands where you want just the result. The panel (MCP Server menu, Show Command Output Panel) opens automatically and lets the user type into the command's stdin, since this tool cannot answer prompts itself.",
      "Destructive commands (rm, rmdir, del, erase, rd, Remove-Item, format D:, Format-Volume, git clean, git reset --hard, Clear-Disk, reg delete, robocopy /mir) pause for the user to click Run in the panel; confirm:true does NOT skip this prompt, and no answer within two minutes means the command is not run.",
    ].join(" "),
    inputSchema: {
      command:    z.string(),
      cwd:        z.string().optional(),
      timeout:    z.number().optional(),
      confirm:    z.boolean().optional(),
      showOutput: z.boolean().optional(),
    },
    async handler({ command, cwd, timeout = 30000, confirm = false, showOutput = true }) {
      // [B72] Support "root:<rootFolderName>/<subpath>" for unambiguous cwd targeting
      // across multiple open project roots. Falls through to raw cwd or the first
      // project root (previous behavior, kept for backward compatibility) otherwise.
      const workDir = (cwd && cwd.startsWith('root:'))
        ? resolveProjectPath(cwd)
        : (cwd || (atom.project.getPaths()[0] ?? null));
      if (!workDir) throw new Error("No project root open and no cwd provided.");

      const { shell, flag } = getShell();

      // -- PRE-FLIGHT: checkpoint, save, warn ---------------------------------
      const openEditors    = atom.workspace.getTextEditors().filter(e => e.getPath());
      const activeEditorPath = atom.workspace.getActiveTextEditor()?.getPath() ?? null;

      // 1. Checkpoint every open editor so run-command damage is recoverable
      const cpName = `_run-command-${Date.now()}`;
      for (const ed of openEditors) {
        checkpoints.set(`${cpName}:${ed.getPath()}`, {
          text:     ed.getBuffer().getText(),
          filePath: ed.getPath(),
          savedAt:  new Date().toISOString()
        });
      }

      // 2. Save all modified buffers so the shell sees current content. R3p (2026-11-09): a buffer whose save fails is
      // reported (notSaved) and the command still runs; this used to be a bare loop, so one failing save threw out of the
      // handler before the command ran. See lib/preflight-save.js.
      const { saved: savedPaths, notSaved } = await saveModifiedEditors(openEditors);
      const notSavedPaths = new Set(notSaved.map(f => f.filePath));

      // 3. Snapshot mtimes of all open files to detect post-command disk changes
      const mtimeBefore = {};
      for (const ed of openEditors) {
        try { mtimeBefore[ed.getPath()] = fs.statSync(ed.getPath()).mtimeMs; } catch (_) {}
      }

      // LLM-facing pre-flight summary
      const preFlightLines = [
        `ðŸ”’ run-command pre-flight: checkpoint '${cpName}' saved for ${openEditors.length} open file(s).`
      ];
      if (savedPaths.length > 0) {
        preFlightLines.push(`  Saved ${savedPaths.length} modified buffer(s) to disk before execution:`);
        savedPaths.forEach(p => preFlightLines.push(`    â€” ${p}`));
      }
      preFlightLines.push(...notSavedWarningLines(notSaved)); // R3p: empty when every save worked
      { const _pfPanel = getCommandTerminalPanel ? getCommandTerminalPanel() : null; if (_pfPanel && showOutput) _pfPanel.appendOutput(preFlightLines.join('\n'), 'info'); }
      // -- END PRE-FLIGHT -----------------------------------------------------

      // Destructive command guard (rewritten 2026-11-04): a PERSON must approve. The Command Output panel
      // shows the command with Run / Cancel buttons (CommandTerminalPanel.askConfirm, via lib/command-confirm.js).
      // confirm:true from the caller does NOT skip this: only a click on Run lets the command through. No answer
      // within two minutes means "do not run". The chat panel has no confirmation row (removed 2026-11-04).
      // DESTRUCTIVE_RE (which commands need approval) is imported from lib/command-confirm.js; see test/command-guard.test.js.
      if (DESTRUCTIVE_RE.test(command)) {
        const decision = await confirmDestructive({
          command,
          cwd: workDir,
          reveal: revealCommandPanel,
          getTerminalPanel: getCommandTerminalPanel,
        });
        if (!decision.approved) {
          const payload = decision.via === 'none'
            ? { error: decision.reason, command }
            : { cancelled: true, command, reason: decision.reason };
          return { content: [{ type: "text", text: JSON.stringify(payload) }] };
        }
      }

      // Announce the command in the Command Output panel (only when showOutput is true)
      // commandTerminalPanel is resolved fresh on every call (not captured at
      // server-start) because the panel is opened on demand, not auto-opened
      // like the chat panel -- a value captured once at mcpRegistration() time
      // would stay null for the whole server session if the panel didn't
      // exist yet when the server started.
      const commandTerminalPanel = getCommandTerminalPanel ? getCommandTerminalPanel() : null;
      if (commandTerminalPanel && showOutput) commandTerminalPanel.appendOutput(`$ ${command}`, 'info');

      return new Promise((resolve) => {
        // Use spawn so we can stream stdout/stderr live to the Command Output panel.
        // Shell and flag are resolved by getShell() for cross-platform support.
        const spawnArgs = [flag, command];
        const proc = _spawn(shell, spawnArgs, { cwd: workDir, shell: false, windowsHide: true });

        // Give the user a live, interactive stdin channel via the Command
        // Output panel â€” neither Claude Code nor Cline can detect or supply
        // input to a process blocked reading stdin; this lets the user just
        // type the answer (e.g. "yes") and hit Enter instead of the call
        // hanging until the timeout fires.
        if (commandTerminalPanel && showOutput) {
          commandTerminalPanel.attachProcess(proc, { command, cwd: workDir });
          // Surface the panel automatically so the user actually sees the
          // stdin box appear if the command needs input â€” opening a pane
          // item Pulsar already knows about (URI matches the opener) just
          // focuses the existing panel rather than creating a duplicate.
          atom.workspace.open('atom://pulsar-edit-mcp-server/command-terminal', { activatePane: false, searchAllPanes: true })
            .then(() => {
              // activatePane:false avoids stealing focus from the user's editor,
              // but on a collapsed/hidden dock it can leave the panel invisible â€”
              // explicitly show the bottom dock so the window actually pops up,
              // then focus the stdin box so typed input isn't lost.
              const dock = atom.workspace.getBottomDock ? atom.workspace.getBottomDock() : null;
              if (dock && typeof dock.show === 'function') dock.show();
              if (commandTerminalPanel && commandTerminalPanel._stdinInput) {
                commandTerminalPanel._stdinInput.focus();
              }
            });
        }

        let stdoutBuf = '';
        let stderrBuf = '';
        let timedOut  = false;

        const timer = setTimeout(() => {
          timedOut = true;
          // Disable/clear stdin immediately on timeout rather than waiting for
          // the async 'close' event â€” otherwise a keystroke typed in the gap
          // between kill() and close firing can sit in the box and get
          // delivered to whatever the next attached process turns out to be.
          if (commandTerminalPanel && commandTerminalPanel._proc === proc) {
            commandTerminalPanel.closeStdin();
          }
          proc.kill();
        }, timeout);

        proc.stdout.on('data', (chunk) => {
          const text = chunk.toString();
          stdoutBuf += text;
          if (showOutput) {
            const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.length > 0);
            if (commandTerminalPanel) lines.forEach(l => commandTerminalPanel.appendOutput(l, 'stdout'));
          }
        });

        proc.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          stderrBuf += text;
          if (showOutput) {
            const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.length > 0);
            if (commandTerminalPanel) lines.forEach(l => commandTerminalPanel.appendOutput(l, 'stderr'));
          }
        });

        proc.on('close', (code) => {
          clearTimeout(timer);
          const exitCode = timedOut ? -1 : (code ?? 0);
          if (commandTerminalPanel && showOutput) commandTerminalPanel.appendOutput(`[exit ${exitCode}]`, 'exit');
          bump('run_command', 'hits');
          if (timedOut)            bump('run_command', 'misses.timedOut');
          else if (exitCode !== 0) bump('run_command', 'misses.exitNonZero');

          // -- POST-EXECUTION: reload any open files changed on disk ----------
          const reloaded = [];
          const reloadErrors = [];
          for (const ed of openEditors) {
            const fp = ed.getPath();
            if (!fp || notSavedPaths.has(fp)) continue; // R3p: never reload over a buffer that holds edits that could not be saved
            try {
              const mtimeAfter = fs.statSync(fp).mtimeMs;
              if (mtimeAfter !== mtimeBefore[fp]) {
                const newText = fs.readFileSync(fp, 'utf8');
                ed.getBuffer().setTextViaDiff(newText);
                reloaded.push(fp);
              }
            } catch (_) { reloadErrors.push(fp); }
          }
          if (reloaded.length > 0 && commandTerminalPanel && showOutput) {
            commandTerminalPanel.appendOutput(
              `ðŸ”„ Reloaded ${reloaded.length} file(s) changed by command:\n` +
              reloaded.map(p => `    â€” ${p}`).join('\n'), 'info');
          }
          // -- Restore active editor focus -----------------------------------
          // Re-activate the tab that was focused before run-command so the
          // active editor isn't left pointing at whatever file was last reloaded.
          // IMPORTANT: atom.workspace.open() is async â€” we must await it inside
          // a then() chain before resolving, otherwise resolve() races the open
          // and the tab switch hasn't happened by the time the tool returns.
          const focusPromise = activeEditorPath
            ? atom.workspace.open(activeEditorPath, { activateItem: true, searchAllPanes: true, pending: false })
                .catch(() => {})
            : Promise.resolve();

          // -- END POST-EXECUTION --------------------------------------------
          // focusPromise resolves after the active tab is restored (or immediately
          // if no activeEditorPath). We chain resolve() inside .then() so the
          // tool doesn't return until the tab switch has actually completed.
          focusPromise.then(() => {
            const result = { command, shell, cwd: workDir, exitCode,
                             stdout: stdoutBuf.trim(), stderr: stderrBuf.trim(),
                             timedOut,
                             preFlightCheckpoint: cpName,
                             savedBeforeRun: savedPaths.length > 0 ? savedPaths : undefined,
                             notSavedBeforeRun: notSaved.length > 0 ? notSaved : undefined,
                             reloadedAfterRun: reloaded.length > 0 ? reloaded : undefined };
            resolve({
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              exitCode, stdout: stdoutBuf.trim(), stderr: stderrBuf.trim()
            });
          });
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          bump('run_command', 'fails.spawnError');
          if (commandTerminalPanel) commandTerminalPanel.appendOutput(`[error: ${err.message}]`, 'stderr');
          resolve({
            content: [{ type: "text", text: JSON.stringify(
              { command, shell, cwd: workDir, exitCode: -1,
                stdout: stdoutBuf.trim(), stderr: err.message }, null, 2) }],
            exitCode: -1, stdout: '', stderr: err.message
          });
        });
      });
    },
  });



// â”€â”€ replace-across-files (migrated to Tool Framework) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Pending-confirm store â€” holds the last dry-run result so confirm:true can commit
  // without re-scanning. Cleared on each new query or successful commit.
  const rafPending = { key: null, files: [] };

  if (g('fileOps')) registerMcpTool({
    name:           'replace-across-files',
    group:          'fileOps',
    category:       'command',
    requiresEditor: false,
    title: 'Replace Across Files',
    description: [
      "Find and replace a literal string across all project files (or a glob subset). REGEX IS REMOVED (2026-10-28): regex:true is refused; find the files with grep-project (filesWithMatches:true, regex:true), then run sed once per file.",
      "TWO-STEP WORKFLOW, always both: Step 1, call WITHOUT confirm for a preview of every match with file path, line number and contextLines (default 2) of context; the summary gives matching lines and occurrences (the commit counts occurrences). Step 2, call again WITH confirm:true and the same query/replacement to commit.",
      "SCOPE: only ONE project, by default the one holding the active file (the result's `scope` field says which); project:'<folder name>' picks another, project:'all' covers every open project. glob narrows the scope. maxMatches (default 50): if exceeded the tool blocks and asks you to narrow with glob or raise it. Each file is edited in its editor buffer (undo history kept) and saved after the commit; a file that could not be saved is listed in skipped. Binary files are skipped.",
    ].join(" "),
    inputSchema: {
      query:         z.string(),
      replacement:   z.string(),
      regex:         REGEX_REMOVED_PARAM,
      caseSensitive: z.boolean().optional(),
      glob:          z.string().optional(),
      project:       z.string().optional(),
      contextLines:  z.number().optional(),
      maxMatches:    z.number().optional(),
      confirm:       z.boolean().optional(),
      dryRun:        z.boolean().optional(),   // legacy alias â€” treated as !confirm
    },
    async handler({ query, replacement, caseSensitive = false, glob = "",
                    contextLines = 2, maxMatches = 50, confirm = false, dryRun = false, project }) {
      // dryRun:true (legacy) means preview pass, not commit
      const committing = confirm && !dryRun;

      // Project scoping (2026-11-18): the active file's project by default; project:'all' for every open root.
      const _scope = resolveProjectRoots(atom.project.getPaths(), project, (atom.workspace.getActiveTextEditor() || { getPath: () => null }).getPath());
      if (!_scope.ok) return { content: [{ type: "text", text: "replace-across-files: " + _scope.error }] };
      const roots = _scope.roots;

      const BINARY_EXTS = new Set(["o","obj","exe","dll","so","dylib","bin","lib","a","out","pdb","ilk","map","elf","hex","png","jpg","jpeg","gif","bmp","ico","pdf","zip","tar","gz","7z","rar"]);

      // -- COMMIT PATH --------------------------------------------------------
      // confirm:true â€” use the pending store from the last preview, no re-scan needed
      if (committing) {
        const pendingKey = `${query}||${replacement}||${glob}||${caseSensitive}||${roots.join(';')}`;
        if (rafPending.key !== pendingKey || rafPending.files.length === 0) {
          return { content: [{ type: "text", text:
            "âš ï¸ No matching preview found to confirm. Run the tool without confirm:true first to generate a match listing, then confirm."
          }] };
        }

        const flags  = caseSensitive ? "g" : "gi";
        const source = escapeRegex(query);
        const skipped = [];
        const saved = [];    // R3l (2026-11-09): files whose new text is really on disk
        const notSaved = []; // R3l: files edited but NOT written (a failed save, or a write that threw)

        const staleFiles = [];
        for (const { filePath } of rafPending.files) {
          let original;
          try { const _r = await readTextFromFile(filePath); original = _r.text; if (_r.staleWarning) staleFiles.push(filePath); } catch (e) { skipped.push({ filePath, reason: e.message }); continue; }
          const _raf_re = new RegExp(source, flags);
          let count = 0;
          const updated = original.replace(_raf_re, function(m) {
            count++;
            const u = unpackReplaceArgs(arguments);
            const pre    = original.slice(0, u.offset);
            const post   = original.slice(u.offset + m.length);
            return applyReplacement(replacement, m, u.groups, pre, post, u.named);
          });
          if (count === 0) continue;
          const openEditor = atom.workspace.getTextEditors().find(e => e.getPath() && path.resolve(e.getPath()) === path.resolve(filePath));
          try {
            const targetEditor = openEditor || await atom.workspace.open(filePath, { activateItem: false });
            // 2026-11-05 (R3c): save after the edit, like every other edit tool; a failed save is reported, not hidden
            const saveResult = await applyAndSave(targetEditor, updated, recordKnownMtime); // R3j: refresh the known mtime so our own save is not reported as STALE
            if (saveResult.saved) {
              saved.push({ filePath, replacements: count });
            } else {
              const reason = `edited in the buffer but not saved: ${saveResult.error}`;
              notSaved.push({ filePath, replacements: count, reason });
              skipped.push({ filePath, reason });
            }
          } catch (e) {
            const reason = `write failed: ${e.message}`;
            notSaved.push({ filePath, replacements: count, reason });
            skipped.push({ filePath, reason });
          }
        }

        // Clear pending store after commit
        rafPending.key = null;
        rafPending.files = [];

        if (skipped.length > 0) bump('replace_across_files', 'fails.skipped', skipped.length);
        // R3l (2026-11-09): a commit where nothing at all reached the disk is not a hit
        if (!(notSaved.length > 0 && saved.length === 0)) bump('replace_across_files', 'hits');

        const _result = commitResult({ saved, notSaved, skipped, staleFiles });
        _result.scope = _scope.label;
        return {
          content: [{ type: "text", text: JSON.stringify(_result, null, 2) }],
          totalReplacements: _result.totalReplacements, filesAffected: _result.filesAffected, dryRun: false
        };

      }

      // -- PREVIEW PATH -------------------------------------------------------
      const flags  = caseSensitive ? "g" : "gi";
      const source = escapeRegex(query);
      let _pattern;
      try { _pattern = new RegExp(source, flags); }
      catch (e) { throw new Error(`Invalid regex: ${e.message}`); }

      let allFiles = [];
      for (const root of roots) allFiles = allFiles.concat(await walkDir(root));
      if (glob) {
        const globRe = globToRegex(glob);
        // Test against absolute path (forward-slash normalised) AND
        // against the path relative to each project root -- this makes
        // subdirectory globs like 'test/*.c' work alongside '**/*.c'.
        allFiles = allFiles.filter(f => {
          const fwd = f.replace(/\\/g, '/');
          if (globRe.test(fwd)) return true;
          for (const root of roots) {
            const rel = fwd.slice(root.replace(/\\/g, '/').length).replace(/^\//, '');
            if (globRe.test(rel)) return true;
          }
          return false;
        });
      }
      allFiles = allFiles.filter(f => !BINARY_EXTS.has(f.split(".").pop().toLowerCase()));

      const results = [];
      const skipped = [];
      const staleFiles = [];
      let totalMatches = 0;
      let totalOccurrences = 0;
      let capped = false;

      outer:
      for (const filePath of allFiles) {
        let text;
        try { const _r = await readTextFromFile(filePath); text = _r.text; if (_r.staleWarning) staleFiles.push(filePath); } catch (e) { skipped.push({ filePath, reason: e.message }); continue; }

        const lines = text.split(/\r?\n/);
        const fileMatches = [];
        let fileOccurrences = 0;

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
            const occHere = occurrencesInLine(lines[i], source, caseSensitive ? "g" : "gi"); // 2026-11-05 (R3d): count occurrences like the commit step
            fileOccurrences += occHere;
            totalOccurrences += occHere;
            fileMatches.push({ line: i + 1, text: lines[i], before, after });
          }
        }

        if (fileMatches.length > 0) {
          results.push({ filePath, matchCount: fileMatches.length, occurrenceCount: fileOccurrences, matches: fileMatches });
        }
      }

      if (capped) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            summary: `âš ï¸ Match cap hit (${maxMatches}). Too many matches to safely preview â€” narrow the scope with glob or a more specific query, or raise maxMatches if you're sure.`,
            totalMatches: `>${maxMatches}`, capped: true, filesSearched: allFiles.length,
          }, null, 2) }],
          dryRun: true
        };
      }

      // Store pending for confirm
      const pendingKey = `${query}||${replacement}||${glob}||${caseSensitive}||${roots.join(';')}`; // project scoping: a preview of one project can never be confirmed against another
      rafPending.key = pendingKey;
      rafPending.files = results.map(r => ({ filePath: r.filePath }));

      if (skipped.length > 0) bump('replace_across_files', 'fails.skipped', skipped.length);

      const summary = previewSummary({ query, glob, lineCount: totalMatches, occurrenceCount: totalOccurrences, fileCount: results.length });

      return {
        content: [{ type: "text", text: JSON.stringify({
          summary, scope: _scope.label, totalMatches, totalOccurrences, filesAffected: results.length,
          replacement,
          files: results,
          skipped: skipped.length > 0 ? skipped : undefined,
          staleFiles: staleFiles.length > 0 ? staleFiles : undefined,
        }, null, 2) }],
        totalMatches, totalOccurrences, filesAffected: results.length, dryRun: true
      };
    },
  });


// â”€â”€ replace-function-body (migrated to Tool Framework) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (g('edit')) registerMcpTool({
    name:     'replace-function-body',
    group:    'edit',
    category: 'edit',
    features: { dryRun: true, lint: true, consecutiveFailureCounter: false },
    title:    'Replace Function Body',
    description: [
      "Replace a named function's whole signature and body atomically in `filePath` (required): finds the function, removes from signature to closing brace, inserts newBody. Prefer it to replace for rewriting a whole function (no partial match, no line drift).",
      "newBody is the complete replacement including the signature line and all braces. The function is found by the name in newBody's first (signature) line, so keep that name unchanged; there is no separate name parameter. inFunction names the function only when newBody has no signature line.",
      "DISAMBIGUATION: if the name appears more than once (declaration + definition), pick one with afterString, afterFunction, betweenHint or occurrence:N.",
      "WORKFLOW: read with inFunction first, edit, then call this, so the signature is exact.",
      "RESPONSE: a line like 'replace-function-body - line N, +-M lines fnName [signatureChanged if the signature changed]', followed by style and lint warnings for the replaced region, if any; act on them before the next edit. Lint runs automatically (no lint param needed).",
    ].join(" "),
    inputSchema: {
      newBody: z.string(),
      // XW23: same scope hints as every edit tool; fuzzyContent left out (this tool matches an exact symbol name).
      ...withoutScopeHints(Object.fromEntries(Object.entries(SCOPE_ANCHOR_SCHEMA).filter(([k]) => k !== 'fuzzyContent'))),
      scope: SCOPE_OBJECT_SCHEMA,
    },
    // 2026-09-18: ported onto resolveScope/matchFunction (match-engine.js), same
    // pattern as replace-block's port (session notes [29]/[30]). Dropped the old
    // inFunction-as-outer-scope disambiguation (findFunction(allSymbols, inFunction,
    // {}) + row-range pre-filter) entirely â€” it was a modifier on the implicit
    // target name rather than a real anchor, had 0 lifetime real-world usage, and
    // the case it existed for (two function DEFINITIONS sharing a name in one
    // translation unit) isn't legal C. inFunction now means the same thing it
    // means on every other resolveScope-based tool: a real anchor, here used
    // (like afterFunction/afterSymbol/afterString/betweenHint) purely to narrow
    // WHICH same-named candidate is meant when _fnName has duplicates â€” not to
    // name a containing function. See session notes [33]-[39] for the full
    // design trail.
    handler: async ({ newBody, dryRun = false, occurrence, inFunction, afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterString, beforeString, afterLine, beforeLine, betweenHint, hintRadius, fuzzyWhitespace, banner, ifdefBlock, ifdefEdge, lint = false }, ctx) => {
      const { editor, buffer, allLines } = ctx;
      const curTool = 'replace-function-body';

      // Derive function name from first line of newBody (e.g. "int hal_init(..." -> "hal_init")
      // Falls back to inFunction if provided. _fnName is used for matchFunction + error messages.
      const _sigLine    = newBody.trimStart().split(/\r?\n/)[0] ?? '';
      const _nameMatch  = _sigLine.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      const _fnName     = (_nameMatch && _nameMatch[1]) || inFunction || null;

      const text = buffer.getText();

      if (inFunction)      bump('replace_function_body', 'hintsUsed.inFunction');
      if (afterFunction)   bump('replace_function_body', 'hintsUsed.afterFunction');
      if (beforeFunction)  bump('replace_function_body', 'hintsUsed.beforeFunction');
      if (afterSymbol)     bump('replace_function_body', 'hintsUsed.afterSymbol');
      if (beforeSymbol)    bump('replace_function_body', 'hintsUsed.beforeSymbol');
      if (betweenHint)     bump('replace_function_body', 'hintsUsed.betweenHint');
      if (afterString)     bump('replace_function_body', 'hintsUsed.afterString');
      if (beforeString)    bump('replace_function_body', 'hintsUsed.beforeString');
      if (occurrence != null) bump('replace_function_body', 'hintsUsed.occurrence');
      if (fuzzyWhitespace) bump('replace_function_body', 'hintsUsed.fuzzyWhitespace');
      if (banner)          bump('replace_function_body', 'hintsUsed.banner');
      if (ifdefBlock)      bump('replace_function_body', 'hintsUsed.ifdefBlock');
      if (ifdefEdge)       bump('replace_function_body', 'hintsUsed.ifdefEdge');

      // Every active hint, recorded by logMatchFailure on each failure path below
      // (same shape replace/insert/delete/replace-block use) for get-failure-log.
      const _faultHints = { inFunction, betweenHint, afterFunction, beforeFunction, afterSymbol, beforeSymbol,
                            afterString, beforeString, afterLine, beforeLine, occurrence, hintRadius, fuzzyWhitespace,
                            banner, ifdefBlock, ifdefEdge };

      const scope = resolveScope({
        editor, buffer, allLines, text, filePath: ctx.filePath,
        params: { inFunction, betweenHint, afterFunction, beforeFunction,
          afterSymbol, beforeSymbol, afterString, beforeString,
          afterLine, beforeLine, occurrence, hintRadius, fuzzyWhitespace,
          banner, ifdefBlock, ifdefEdge },
      });
      if (scope.error) {
        bump('replace_function_body', scopeErrorIsOutOfRange(scope.error, occurrence) ? 'fails.outOfRange' : 'fails.ambiguousHint');
        logMatchFailure({
          tool: curTool, filePath: ctx.filePath,
          reason: scope.error.kind || 'scopeError',
          needle: _fnName, proposedNewStr: newBody, allLines, hints: _faultHints,
        });
        return buildFailResponse({ tool: curTool, ctx, scope, needle: _fnName, isCodeFile: true });
      }

      const allSymbols = getSymbols(editor, text, ctx.filePath);
      const match = matchFunction(_fnName, { allLines }, scope, { occurrence, symbols: allSymbols });

      if (!match.matched && match.reason === 'ambiguous') {
        const dupes = match.matchLines;
        bump('replace_function_body', 'fails.ambiguous');
        logMatchFailure({
          tool: curTool, filePath: ctx.filePath,
          reason: 'ambiguous',
          needle: _fnName, proposedNewStr: newBody, allLines, hints: _faultHints,
          extra: { matchAtLines: dupes },
        });
        return { content: [{ type: "text", text: [
          'âš ï¸  AMBIGUOUS â€” "' + _fnName + '" has ' + dupes.length + ' definitions in scope (lines: ' + dupes.join(", ") + ').',
          `   Use occurrence:N, afterString, afterFunction, afterSymbol, or betweenHint to target one:`,
          `   â€” occurrence:N    â†’ picks the Nth definition (1=line ${dupes[0]}, 2=line ${dupes[1] ?? "?"}, ...)`,
          `   â€” afterString:"â€¦" â†’ start search after a unique anchor line`,
          `   â€” afterFunction:"â€¦" / afterSymbol:"â€¦" â†’ scope relative to another named symbol`,
          `   â€” betweenHint     â†’ restrict to a region`,
        ].join("\n") }], found: false, ambiguous: true, matchAtLines: dupes };
      }

      if (!match.matched && match.reason === 'occurrenceOutOfRange') {
        // S1: the function exists, the requested occurrence does not -- do not fall into the
        // "did you mean" name-suggestion path below, which would misdescribe this failure.
        bump('replace_function_body', 'fails.outOfRange');
        logMatchFailure({
          tool: curTool, filePath: ctx.filePath,
          reason: 'occurrenceOutOfRange',
          needle: _fnName, proposedNewStr: newBody, allLines, hints: _faultHints,
        });
        return { ...buildFailResponse({ tool: curTool, ctx, scope, match, needle: _fnName, isCodeFile: true }), found: false };
      }

      if (!match.matched) {
        // Smart failure â€” use allSymbols to suggest close names
        const allNames = [...new Set(allSymbols.map(s => s.name))];
        const nameLower = (_fnName || '').toLowerCase();
        const close = allNames
          .map(fn => {
            const s = fn.toLowerCase();
            let score = 0;
            for (const ch of nameLower) if (s.includes(ch)) score++;
            return { fn, score: score / Math.max(nameLower.length, 1) };
          })
          .filter(x => x.score > 0.4)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);

        logMatchFailure({
          tool: curTool, filePath: ctx.filePath,
          reason: 'notFound',
          needle: _fnName, proposedNewStr: newBody, allLines, hints: _faultHints,
          extra: { availableFunctions: allNames.slice(0, 20), closestMatches: close.map(x => x.fn) },
        });
        const parts = ['âŒ Function "' + _fnName + '" not found' + (scope.scopeLabel || '') + '.'];
        if (close.length > 0) {
          const sigLines = close.map(({ fn }) => {
            const sym = allSymbols.find(s => s.name === fn);
            return sym ? `  ${fn}  â†’  ${sym.sig.trim()}  (line ${sym.startRow + 1})` : `  ${fn}`;
          });
          parts.push(`\nðŸ’¡ Similar names found â€” current signatures:\n${sigLines.join("\n")}`);
          parts.push(`   Did you mean one of these? Check spelling and casing.`);
        } else if (allNames.length > 0) {
          parts.push(`\nðŸ’¡ Functions in this file: ${allNames.slice(0, 10).join(", ")}${allNames.length > 10 ? ` â€” (${allNames.length} total)` : ""}`);
        } else {
          parts.push(`   No functions detected in this file.`);
        }
        bump('replace_function_body', 'fails.notFound');
        return { content: [{ type: "text", text: parts.join("\n") }], found: false };
      }

      const startRow = match.matchLine;
      const endRow   = match.matchEndLine;
      const oldSignatureLine = allLines[startRow] ?? "";
      const ensuredNewline   = newBody.endsWith("\n") ? newBody : newBody + "\n";
      const insertedLines    = ensuredNewline.split(/\r?\n/).length - 1;
      const signatureChanged = oldSignatureLine.trim() !== (ensuredNewline.split(/\r?\n/)[0] ?? "").trim();

      if (dryRun) {
        // dryRuns is counted centrally in tool-framework.js (this branch's result carries dryRun:true)
        const r = 2;
        const cs = Math.max(0, startRow - r);
        const ce = Math.min(allLines.length - 1, endRow + r);
        const preview = allLines.slice(cs, ce + 1).map((l, i) => {
          const abs = cs + i;
          const inFn = abs >= startRow && abs <= endRow;
          return `${String(abs + 1).padStart(4)}${inFn ? " â–¶" : "  "} ${l}`;
        }).join("\n");
        const newLines = ensuredNewline.split(/\r?\n/).slice(0, -1).map(l => `     + ${l}`).join("\n");
        return {
          content: [{ type: "text", text: [
            'ðŸ” DRY RUN â€” function "' + _fnName + '" found at lines ' + (startRow + 1) + 'â€“' + (endRow + 1) + ' (' + (endRow - startRow + 1) + ' lines).',
            signatureChanged ? `\nâš ï¸  SIGNATURE CHANGE DETECTED â€” verify this is intentional.` : "",
            `\nCurrent function (â–¶ = will be replaced):\n${preview}`,
            `\nReplacement (${insertedLines} lines):\n${newLines}`,
            `\nReply with the same call without dryRun (or dryRun:false) to commit.`
          ].filter(Boolean).join("\n") }],
          found: true, dryRun: true,
          oldStartLine: startRow + 1, oldEndLine: endRow + 1, insertedLines, signatureChanged
        };
      }

      const originalText = buffer.getText();
      const edit = applyEdit(buffer, match, ensuredNewline);
      if (edit.error) {
        bump('replace_function_body', 'fails.notFound');
        logMatchFailure({
          tool: curTool, filePath: ctx.filePath,
          reason: 'applyEditError',
          needle: _fnName, proposedNewStr: newBody, allLines, hints: _faultHints,
          extra: { applyError: edit.error },
        });
        return { content: [{ type: "text", text: `âŒ replace-function-body: ${edit.error} â€” the function body changed between matching and writing. Re-read the function and retry.` }], found: false };
      }
      decorateEditedLines(editor, originalText, buffer.getText());
      bump('replace_function_body', 'hits');
      const newLineCount = buffer.getLineCount();
      const _lintSuffix = await maybeLintSuffix(lint, editor, edit.startRow, edit.startRow + newBody.split("\n").length - 1);
      const _styleSuffix = applyStyleCheck(newBody, ctx.filePath);
      return {
        ...(await buildEditResponse(
          { tool: curTool, line: edit.startRow + 1, linesChanged: edit.linesChanged,
            scopeLabel: ' "' + _fnName + '"', tags: signatureChanged ? ['signatureChanged'] : [], buffer },
          { lint: _lintSuffix, style: _styleSuffix }
        )),
        found: true, dryRun: false,
        functionName: _fnName,
        oldStartLine: edit.startRow + 1,
        oldEndLine:   edit.endRow   + 1,
        newStartLine: edit.startRow + 1,
        signatureChanged, insertedLines, newLineCount
      };
    },
  });

  registerMcpTool({
    name: 'move-file',
    group: 'fileOps',
    category: 'command',
    requiresEditor: false,
    title: 'Move File',
    description: [
      "Move (or rename) a file from sourcePath to destPath.",
      "Directories in destPath are created automatically.",
      "Fails if destPath already exists â€” use copy-file if you want a duplicate instead."
    ].join(" "),
    inputSchema: {
      sourcePath: z.string(),
      destPath:   z.string()
    },
    async handler({ sourcePath, destPath }) {
      try { await fs.promises.access(destPath); throw new Error(`Destination already exists: ${destPath}`); } catch (err) { if (err.message.startsWith("Destination already exists")) throw err; }
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.rename(sourcePath, destPath);
      const oldEditor = atom.workspace.getTextEditors().find(e => e.getPath() && path.resolve(e.getPath()) === path.resolve(sourcePath));
      if (oldEditor) await retargetEditor(oldEditor, destPath);
      return { content: [{ type: "text", text: `Moved: ${sourcePath} -> ${destPath}` }], sourcePath, destPath };
    }
  });

  registerMcpTool({
    name: 'copy-file',
    group: 'fileOps',
    category: 'command',
    requiresEditor: false,
    title: 'Copy File',
    description: [
      "Copy a file from sourcePath to destPath.",
      "Directories in destPath are created automatically.",
      "Fails if destPath already exists."
    ].join(" "),
    inputSchema: {
      sourcePath: z.string(),
      destPath:   z.string()
    },
    async handler({ sourcePath, destPath }) {
      try { await fs.promises.access(destPath); throw new Error(`Destination already exists: ${destPath}`); } catch (err) { if (err.message.startsWith("Destination already exists")) throw err; }
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      // If source is open with unsaved edits, write from buffer so the copy reflects live content
      const srcEditor = atom.workspace.getTextEditors()
        .find(e => e.getPath() && path.resolve(e.getPath()) === path.resolve(sourcePath));
      if (srcEditor) {
        await fs.promises.writeFile(destPath, srcEditor.getBuffer().getText(), "utf8");
        await atom.workspace.open(destPath);
      } else {
        await fs.promises.copyFile(sourcePath, destPath);
      }
      return { content: [{ type: "text", text: `Copied: ${sourcePath} -> ${destPath}` }], sourcePath, destPath };
    }
  });

  registerMcpTool({
    name: 'create-folder',
    group: 'fileOps',
    category: 'command',
    requiresEditor: false,
    title: 'Create Folder',
    description: [
      "Create a directory (and any missing parent directories) at the given path.",
      "Succeeds silently if the directory already exists.",
      "Returns the resolved path that was created."
    ].join(" "),
    inputSchema: {
      folderPath: z.string()
    },
    async handler({ folderPath }) {
      await fs.promises.mkdir(folderPath, { recursive: true });
      return { content: [{ type: "text", text: `Folder ready: ${folderPath}` }], folderPath };
    }
  });

  registerMcpTool({
    name: 'rename-folder',
    group: 'fileOps',
    category: 'command',
    requiresEditor: false,
    title: 'Rename / Move Folder',
    description: [
      "Rename or move a folder from sourcePath to destPath.",
      "All files inside are moved with it.",
      "Fails if destPath already exists."
    ].join(" "),
    inputSchema: {
      sourcePath: z.string(),
      destPath:   z.string()
    },
    async handler({ sourcePath, destPath }) {
      try { await fs.promises.access(destPath); throw new Error(`Destination already exists: ${destPath}`); } catch (err) { if (err.message.startsWith("Destination already exists")) throw err; }
      const resolvedSrc = path.resolve(sourcePath);
      // Collect all open editors inside the folder before the move
      const editorsInside = atom.workspace.getTextEditors().filter(e => e.getPath() && path.resolve(e.getPath()).startsWith(resolvedSrc + path.sep));
      // Move the folder on disk
      await fs.promises.rename(sourcePath, destPath);
      const resolvedDest = path.resolve(destPath);
      // Retarget each editor to its new path â€” preserves undo history if setPath is available
      for (const e of editorsInside) {
        const newPath = resolvedDest + path.resolve(e.getPath()).slice(resolvedSrc.length);
        await retargetEditor(e, newPath);
      }
      return {
        content: [{ type: "text", text: `Folder moved: ${sourcePath} -> ${destPath}. ${editorsInside.length} tab(s) retargeted to new paths.` }],
        sourcePath, destPath, retargetedTabs: editorsInside.length
      };
    }
  });

  } // end FILE-OPS GROUP

  // -- CORE GROUP (continued â€” always on) ------------------------------------
  registerMcpTool({
    name: 'save-all',
    group: 'navigation',
    category: 'nav',
    requiresEditor: false,
    title: 'Save All Files',
    description: [
      "Save all modified open editor tabs to disk in one call.",
      "Returns a list of which files were saved and a count of how many had unsaved changes."
    ].join(" "),
    inputSchema: {},
    async handler() {
      const editors = atom.workspace.getTextEditors();
      const saved   = [];
      const skipped = [];
      for (const editor of editors) {
        if (editor.isModified()) {
          await editor.save();
          saved.push(editor.getPath() || '[untitled]');
        } else {
          skipped.push(editor.getPath() || '[untitled]');
        }
      }
      bump('save_all', 'hits');
      const summary = `Saved ${saved.length} file(s), skipped ${skipped.length} unchanged.`;
      return {
        content: [{ type: 'text', text: JSON.stringify({ summary, saved, skipped }, null, 2) }],
        savedCount: saved.length, saved, skipped
      };
    },
  });

  registerMcpTool({
    name: 'get-file-summary',
    group: 'fileOps',
    category: 'nav',
    requiresEditor: false,
    title: 'Get File Summary',
    description: [
      "Return a structural summary of any project file without loading the full content.",
      "For C/C++ files returns: all function signatures with line numbers, all #include lines,",
      "all #define lines, and any TODO/FIXME/HACK/NOTE comments with line numbers.",
      "For other file types returns: line count, first 20 lines, and any TODO/FIXME comments.",
      "PREFERRED FIRST CALL: always use this before read to orient yourself - far cheaper and usually enough to plan edits."
    ].join(" "),
    inputSchema: { ...FILE_SCHEMA },
    async handler({ filePath }) {
      let text, staleWarning;
      let resolvedPath = filePath;
      try { ({ text, staleWarning } = await readTextFromFile(filePath)); }
      catch (err) { throw new Error(`Cannot read file: ${filePath} â€” ${err.message}`); }
      const lines     = text.split(/\r?\n/);
      const lineCount = lines.length;
      const ext       = (resolvedPath || "").split(".").pop().toLowerCase();
      const isClike   = ["c", "cpp", "cc", "cxx", "h", "hpp", "hh"].includes(ext);
      const summary   = { filePath: resolvedPath, lineCount, functions: [], includes: [], defines: [], todos: [] };
      const _fsEditor = atom.workspace.getTextEditors().find(e => e.getPath && e.getPath() === resolvedPath);
      const _fsSyms   = getSymbols(_fsEditor || null, text, resolvedPath);
      summary.functions = _fsSyms.map(s => ({ line: s.startRow + 1, name: s.name, signature: s.sig || s.name }));
      const includeRe = /^\s*#\s*include\s*.+/;
      const defineRe  = /^\s*#\s*define\s+\S+/;
      const todoRe    = /\b(TODO|FIXME|HACK|NOTE|XXX)\b/i;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const n    = i + 1;
        if (isClike) {
          if (includeRe.test(line)) summary.includes.push({ line: n, text: line.trim() });
          if (defineRe.test(line))  summary.defines.push({ line: n, text: line.trim() });
        }
        const todoMatch = todoRe.exec(line);
        if (todoMatch) summary.todos.push({ line: n, kind: todoMatch[1].toUpperCase(), text: line.trim() });
      }
      if (!isClike) {
        summary.firstLines = lines.slice(0, 20).map((t, i) => ({ n: i + 1, text: t }));
      }
      bump('get_file_summary', 'hits');
      return {
        ...buildSearchResponse({ staleWarning, body: JSON.stringify(summary, null, 2) }),
        lineCount,
        functionCount: summary.functions.length,
        includeCount:  summary.includes.length,
        defineCount:   summary.defines.length,
        todoCount:     summary.todos.length
      };
    },
  });

  // -- FILE-OPS GROUP (part 2: project inspection tools) --------------------
  if (g('fileOps')) {
  registerMcpTool({
    name: 'get-includes-and-defines',
    group: 'fileOps',
    category: 'nav',
    requiresEditor: false,
    title: 'Get Includes and Defines',
    description: [
      "Return all #include and #define lines with their line numbers from any project file.",
      "Much cheaper than reading the whole file for large C/C++ files when you just need the header inventory.",
      "Also returns #ifdef/#ifndef/#if blocks so you can see conditional compilation guards."
    ].join(" "),
    inputSchema: { ...FILE_SCHEMA },
    async handler({ filePath }) {
      let text, staleWarning;
      let resolvedPath = filePath;
      try { ({ text, staleWarning } = await readTextFromFile(filePath)); }
      catch (err) { throw new Error(`Cannot read file: ${filePath} - ${err.message}`); }
      const lines        = text.split(/\r?\n/);
      const includes     = [];
      const defines      = [];
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
      bump('get_includes_and_defines', 'hits');
      const result = { filePath: resolvedPath, includes, defines, conditionals };
      return {
        ...buildSearchResponse({ staleWarning, body: JSON.stringify(result, null, 2) }),
        includeCount: includes.length, defineCount: defines.length, conditionalCount: conditionals.length
      };
    },
  });

  registerMcpTool({
    name: 'list-project-functions',
    group: 'fileOps',
    category: 'nav',
    requiresEditor: false,
    title: 'List Project Functions',
    description: [
      "List every function definition across all project files (or a glob-filtered subset).",
      "Returns file path, function name, line number, and signature for each function.",
      "Use glob to restrict to e.g. '**/*.c' or '**/*.h'.",
      "Essential for navigating large multi-file codebases and Ghidra decompiled output."
    ].join(" "),
    inputSchema: {
      glob:  z.string().optional(),
      query: z.string().optional(),
      project: z.string().optional()
    },
    async handler({ glob = "", query = "", project } = {}) {
      const _pr = _projectRoots(project);
      if (!_pr.ok) throw new Error(_pr.error);
      const roots = _pr.roots;
      if (!roots.length) throw new Error("No project root open.");
      let allFiles = [];
      const _walkOpts = { deadline: Date.now() + 20000 };
      for (const root of roots) allFiles = await walkDir(root, allFiles, _walkOpts);
      const _walkNote = _walkOpts.hit ? 'file walk stopped at its 20 s limit; list is partial, pass project or a narrower glob' : undefined;
      const effectiveGlob = glob || "**/*.{c,cpp,cc,cxx,h,hpp}";
      const globRe = globToRegex(effectiveGlob);
      allFiles = allFiles.filter(f => globRe.test(f.replace(/\\/g, "/")));
      const queryRe = query ? new RegExp(escapeRegex(query), "i") : null;
      const results = [];
      const _symDeadline = Date.now() + 40000;
      let _symStopped = false;
      for (const filePath of allFiles) {
        if (Date.now() > _symDeadline) { _symStopped = true; break; }
        let text;
        try { text = await fs.promises.readFile(filePath, "utf8"); } catch { continue; }
        const syms = getSymbolsFromText(text, filePath);
        for (const s of syms) {
          if (queryRe && !queryRe.test(s.name)) continue;
          results.push({ filePath, line: s.startRow + 1, name: s.name, signature: s.sig });
        }
      }
      bump('list_project_functions', 'hits');
      return {
        content: [{ type: 'text', text: JSON.stringify({ totalFunctions: results.length, ...((_walkNote || _symStopped) ? { partial: _walkNote || 'symbol scan stopped at its 40 s limit; narrow with glob or project' } : {}), functions: results }, null, 2) }],
        totalFunctions: results.length
      };
    },
  });
  } // end FILE-OPS GROUP (part 2)

  // -- SEARCH GROUP ----------------------------------------------------------
  if (g('search')) {

  // -- grep-file --------------------------------------------------------------
  registerMcpTool({
    name:     'grep-file',
    group:    'search',
    category: 'search',
    features: {},
    title:    'Grep File',
    description: [
      "Search one file for a string or regex; returns every matching line with its 1-based line number. Use it to locate content before replace or read; far cheaper than reading the whole file. It reads the live buffer if the file is open, so unsaved edits are included.",
      "contextLines:N = before:N + after:N (grep -C); before/after alone are asymmetric (-B/-A); each match gets 'before' and 'after' arrays. occurrence:N returns only the Nth match with its line number, for replace or read.",
      "regex:true = POSIX BRE like plain grep (groups, alternation, + ? {n} need a backslash; bare | + ? ( ) are literal); extended:true = ERE like grep -E. Not JavaScript: no \\d, no lazy quantifiers. wordRegexp:true (-w) and lineRegexp:true (-x, wins if both) work with or without regex. caseSensitive:false = case-insensitive (default is case-sensitive).",
      "invertMatch:true (grep -v), onlyMatching:true (just the matched substring(s), grep -o), countOnly:true (matchCount only, grep -c).",
      "Returns matchCount; if results exceed maxMatches they are truncated and a truncation flag is set.",
    ].join(" "),
    inputSchema: {
      query:         z.string(),
      ...FILE_SCHEMA,
      regex:         z.boolean().optional(),
      extended:      z.boolean().optional(),
      wordRegexp:    z.boolean().optional(),
      lineRegexp:    z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      maxMatches:    z.number().optional(),
      contextLines:  z.number().optional(),
      before:        z.number().optional(),
      after:         z.number().optional(),
      occurrence:    z.number().optional(),
      invertMatch:   z.boolean().optional(),
      onlyMatching:  z.boolean().optional(),
      countOnly:     z.boolean().optional()
    },
    requiresEditor: false,
    handler: async ({ query, filePath, regex = false, extended = false, wordRegexp = false, lineRegexp = false, caseSensitive = true, maxMatches = 200, contextLines = 0, before = 0, after = 0, occurrence = 0, invertMatch = false, onlyMatching = false, countOnly = false }, ctx) => {
      const statsKey = 'grep_file';
      let text, staleWarning;
      let _resolvedPath = filePath;

      try { ({ text, staleWarning } = await readTextFromFile(filePath)); }
      catch (err) { return ctx.fail('cannotRead', `Cannot read file: ${filePath} - ${err.message}`); }

      let pattern;
      try { pattern = compilePattern({ query, regex, extended, caseSensitive, wordRegexp, lineRegexp }); }
      catch (e) { return ctx.fail('invalidRegex', e.message); }

      const lines = text.split(/\r?\n/);
      const { matches, matchCount, truncated, globalIndex } = scanLines(lines, pattern, {
        occurrence, before, after, contextLines, maxMatches, invertMatch, onlyMatching, countOnly,
      });

      if (occurrence > 0 && matchCount === 0) {
        logFailure({ tool: statsKey, reason: 'noMatch', filePath: _resolvedPath, query, regex, caseSensitive });
        return ctx.fail('noMatch', `occurrence ${occurrence} not found â€” only ${globalIndex} match(es) in file.`);
      }
      if (matchCount === 0) {
        logFailure({ tool: statsKey, reason: 'noMatch', filePath: _resolvedPath, query, regex, caseSensitive });
        return ctx.noMatch(JSON.stringify({ matchCount: 0, truncated: false, matches: [], hint: [regexHint({ query, regex, extended }), caseHintForLines(lines, { query, regex, extended, caseSensitive, wordRegexp, lineRegexp, invertMatch })].filter(Boolean).join(' ') || undefined }));
      }
      bump(statsKey, 'hits');
      if (occurrence > 0) bump(statsKey, 'hintsUsed.occurrence');
      if (contextLines > 0 || before > 0 || after > 0) bump(statsKey, 'hintsUsed.contextLines');
      return buildSearchResponse({ staleWarning, body: JSON.stringify({ matchCount, truncated, matches }) });
    }
  });

  // -- grep-project -----------------------------------------------------------
  registerMcpTool({
    name:     'grep-project',
    group:    'search',
    category: 'search',
    features: {},
    title:    'Grep Project',
    description: [
      "Search all project files for a string or regex; returns every match with file path and 1-based line number. Use it to find where something is defined or used when you don't know the file, then grep-file or read that file.",
      "glob restricts to a pattern such as '**/*.js'; project:'<folder>' or 'all' picks the project (default: the active file's). contextLines:N = before:N + after:N (grep -C); before/after alone are asymmetric (-B/-A). occurrence:N returns only the Nth match across the whole search.",
      "regex:true = POSIX BRE like plain grep (groups, alternation, + ? {n} need a backslash; bare | + ? ( ) are literal); extended:true = ERE like grep -E. Not JavaScript: no \\d, no lazy quantifiers. wordRegexp:true (-w) and lineRegexp:true (-x, wins if both) work with or without regex. caseSensitive:false = case-insensitive (default is case-sensitive).",
      "invertMatch:true (grep -v), onlyMatching:true (grep -o), countOnly:true (matchCount only, grep -c), filesWithMatches:true (just the matching file paths, grep -l; cheaper for scoping before replace-across-files).",
      "Results are capped at maxMatches (default 200) and a truncation flag is set; narrow with glob if truncated.",
    ].join(" "),
    inputSchema: {
      query:            z.string(),
      glob:             z.string().optional(),
      regex:            z.boolean().optional(),
      extended:         z.boolean().optional(),
      wordRegexp:       z.boolean().optional(),
      lineRegexp:       z.boolean().optional(),
      caseSensitive:    z.boolean().optional(),
      maxMatches:       z.number().optional(),
      contextLines:     z.number().optional(),
      before:           z.number().optional(),
      after:            z.number().optional(),
      occurrence:       z.number().optional(),
      invertMatch:      z.boolean().optional(),
      onlyMatching:     z.boolean().optional(),
      countOnly:        z.boolean().optional(),
      filesWithMatches: z.boolean().optional(),
      project:          z.string().optional()
    },
    requiresEditor: false,
    handler: async ({ query, glob = "", regex = false, extended = false, wordRegexp = false, lineRegexp = false, caseSensitive = true, maxMatches = 200, contextLines = 0, before = 0, after = 0, occurrence = 0, invertMatch = false, onlyMatching = false, countOnly = false, filesWithMatches = false, project }, ctx) => {
      const statsKey = 'grep_project';
      const _pr = _projectRoots(project);
      if (!_pr.ok) return ctx.fail('noRoot', _pr.error);
      const roots = _pr.roots;
      if (!roots.length) return ctx.fail('noRoot', "No project root open.");

      let pattern;
      try { pattern = compilePattern({ query, regex, extended, caseSensitive, wordRegexp, lineRegexp }); }
      catch (e) { return ctx.fail('invalidRegex', e.message); }

      // Scope the walk to roots implied by glob's leading literal path segment,
      // e.g. glob "Ghidra-H8-Processor/**/*.c" only walks that root instead of
      // every open root. Falls back to all roots if glob doesn't name one.
      // (Previously walkDir ran unconditionally over every open root before
      // glob filtering or matching even began, crashing Pulsar on unscoped
      // calls against a large multi-root workspace â€” the walk itself was
      // unbounded, not the match scan.)
      let scopedRoots = roots;
      if (glob) {
        const firstSeg = glob.replace(/\\/g, "/").split("/")[0];
        if (firstSeg && !firstSeg.includes("*")) {
          const matchedRoots = roots.filter(r => path.basename(r) === firstSeg);
          if (matchedRoots.length) scopedRoots = matchedRoots;
        }
      }

      // Deadline for the whole walk+scan operation. An unscoped grep-project
      // (no glob, or glob that doesn't narrow to a subset of roots) can still
      // have to walk a very large root in full before any match/glob filtering
      // happens -- this was hanging/crashing Pulsar with no partial result.
      // Below, both the walk and the match loop check this deadline and bail
      // out with whatever was found so far, tagged timedOut:true with a hint
      // to add/narrow glob, instead of hanging indefinitely. NOTE: the walk
      // loop only checks between roots, not mid-walk of a single huge root --
      // walkDir() itself has no deadline awareness (shared helper, not
      // touched here to limit blast radius). A single massive root can still
      // exceed the deadline before this check ever runs.
      const GREP_TIMEOUT_MS = 8000;
      // R4k step 2: the second, case-folded pass that runs only when a case-sensitive search found nothing
      // gets its own budget, so an empty search over a big tree cannot double its wait.
      const CASE_PROBE_MS = 3000;
      const _deadline = Date.now() + GREP_TIMEOUT_MS;
      let timedOut = false;

      let allFiles = [];
      // walkDir now honours the deadline itself (mid-walk), so one huge root can no longer overrun it.
      const _walkOpts = { deadline: _deadline };
      for (const root of scopedRoots) {
        allFiles = await walkDir(root, allFiles, _walkOpts);
        if (_walkOpts.hit || Date.now() > _deadline) { timedOut = true; break; }
      }
      if (glob) { const globRe = globToRegex(glob); allFiles = allFiles.filter(f => globRe.test(f.replace(/\\/g, "/"))); }

      const matches = [];
      const matchedFiles = [];
      const staleFiles = [];
      let truncated = false;
      let globalIndex = 0;

      outer:
      for (const filePath of allFiles) {
        if (Date.now() > _deadline) { timedOut = true; truncated = true; break outer; }
        let text;
        try { const _r = await readTextFromFile(filePath); text = _r.text; if (_r.staleWarning) staleFiles.push(filePath); } catch { continue; }
        const lines = text.split(/\r?\n/);

        if (filesWithMatches) {
          const fileScan = scanLines(lines, pattern, { invertMatch, stopAtFirst: true });
          if (fileScan.matches.length > 0) {
            matchedFiles.push(filePath);
            globalIndex++;
            if (matchedFiles.length >= maxMatches) { truncated = true; break outer; }
          }
          continue;
        }

        const remaining = occurrence > 0 ? occurrence - globalIndex : 0;
        const fileScan = scanLines(lines, pattern, {
          occurrence: occurrence > 0 ? Math.max(1, remaining) : 0,
          before, after, contextLines,
          maxMatches: maxMatches - matches.length,
          invertMatch, onlyMatching, countOnly,
          entryExtra: () => ({ filePath }),
        });
        // reinsert filePath ahead of line/text for readability
        for (const m of fileScan.matches) { matches.push({ filePath, ...m }); }
        globalIndex += fileScan.globalIndex;
        if (occurrence > 0 && fileScan.matches.length > 0) break outer;
        if (matches.length >= maxMatches) { truncated = true; break outer; }
      }

      const effMatchCount = filesWithMatches ? matchedFiles.length : (countOnly ? globalIndex : matches.length);

      if (occurrence > 0 && matches.length === 0 && !filesWithMatches) {
        logFailure({ tool: statsKey, reason: 'noMatch', filePath: null, query, regex, caseSensitive });
        return ctx.fail('noMatch', `occurrence ${occurrence} not found â€” only ${globalIndex} match(es) in project.`);
      }
      if (effMatchCount === 0) {
        logFailure({ tool: statsKey, reason: timedOut ? 'timedOut' : 'noMatch', filePath: null, query, regex, caseSensitive });
        bump(statsKey, timedOut ? 'fails.timedOut' : 'fails.noMatch');
        let _caseNote = null;
        const _probe = timedOut ? null : makeCaseProbe({ query, regex, extended, caseSensitive, wordRegexp, lineRegexp, invertMatch });
        if (_probe) {
          const _probeEnd = Date.now() + CASE_PROBE_MS;
          for (const f of allFiles) {
            if (Date.now() > _probeEnd) break;
            let _t; try { _t = (await readTextFromFile(f)).text; } catch { continue; }
            _probe.feed(_t.split(/\r?\n/), f);
          }
          _caseNote = _probe.hint();
        }
        return { content: [{ type: "text", text: JSON.stringify({ matchCount: 0, truncated: timedOut, timedOut, matches: [], hint: [regexHint({ query, regex, extended }), _caseNote].filter(Boolean).join(' ') || undefined }, null, 2) + (timedOut ? `\nâ±ï¸ TIMED OUT â€” search exceeded ${GREP_TIMEOUT_MS}ms with no matches found before the deadline. Narrow scope with glob to search faster.` : '') }], matchCount: 0, truncated: timedOut, timedOut };
      }
      bump(statsKey, 'hits');
      if (occurrence > 0) bump(statsKey, 'hintsUsed.occurrence');
      if (contextLines > 0 || before > 0 || after > 0) bump(statsKey, 'hintsUsed.contextLines');
      const body = filesWithMatches
        ? { matchCount: matchedFiles.length, truncated, timedOut, files: matchedFiles }
        : { matchCount: effMatchCount, truncated, timedOut, matches };
      return {
        ...buildSearchResponse({
          staleWarning: staleFiles.length > 0
            ? `\nâš ï¸ STALE â€” ${staleFiles.length} file(s) scanned had on-disk content that changed since this server last touched them: ${staleFiles.map(f => path.basename(f)).join(', ')}. Matches from those files may not reflect the current content â€” re-read before trusting them.`
            : timedOut
              ? `\nâ±ï¸ TIMED OUT â€” search exceeded ${GREP_TIMEOUT_MS}ms and returned only what was found before the deadline; results are incomplete. Narrow scope with glob (e.g. glob:"ProjectFolderName/**/*.ext") to search faster and get complete results.`
              : '',
          body: JSON.stringify(body, null, 2)
        }),
        matchCount: effMatchCount, truncated, timedOut
      };
    }
  });

  } // end SEARCH GROUP (grep-file, grep-project)
  // -- EDIT GROUP (part 2: replace-all â€” migrated to Tool Framework) --------
  if (g('edit')) registerMcpTool({
    name:     'replace-all',
    group:    'edit',
    category: 'edit',
    features: { dryRun: true, lint: true, styleCheck: true },
    title:       'Replace All',
    description: [
      'Find and replace ALL occurrences of query with replacement in the file at `filePath` (required).',
      'Equivalent to replace applied to all occurrences \u2014 exists as a shortcut so you never accidentally replace only the first match.',
      'Supports caseSensitive:false matching. REGEX IS REMOVED (2026-10-28): regex:true is refused here; use the sed tool for pattern edits.',
      'Returns matchCount so you can verify how many occurrences were replaced. Supports dryRun:true to preview the match count without writing any changes \u2014 use this before committing broad queries.',
    ].join(' '),
    inputSchema: {
      ...FILE_SCHEMA,
      query:         z.string(),
      replacement:   z.string(),
      regex:         REGEX_REMOVED_PARAM,
      caseSensitive: z.boolean().optional(),
      dryRun:        z.boolean().optional(),
      lint:          z.boolean().optional(),
    },
    handler: async ({ query, replacement, caseSensitive = false, dryRun = false, lint = false }, ctx) => {
      const { allLines } = ctx;

      const source = escapeRegex(query); // still used by the dry-run location list below

      // Stage 4b 2026-10-10: matching and $-expansion now live in lib/replace-all-plan.js
      // (pure; tested against the old inline algorithm, 452 checks). Behaviour kept: case-
      // insensitive default, whole-text match (^ and $ anchor to the FILE),
      // no-match falls through to the failure block below. ONE deliberate change: an
      // empty query used to insert the replacement between every character; it is refused.
      if (query === '') {
        return ctx.fail('noMatch', '\u274C replace-all: the query is empty - nothing replaced. An empty query would match between every character.', { matchCount: 0, dryRun });
      }
      const _plan = planReplaceAll({ text: ctx.text, query, replacement, caseSensitive });
      if (!_plan.ok && _plan.reason !== 'noMatch') throw new Error(`replace-all: invalid input (${_plan.reason})`);
      const matchCount = _plan.ok ? _plan.matchCount : 0;
      const newText    = _plan.ok ? _plan.newText : ctx.text;

      if (matchCount === 0) {
        // Fuzzy: find closest area in file to the query words
        const words = query.trim().split(/\s+/).filter(w => w.length > 3);
        let fuzzyRow = -1, bestScore = 0;
        for (let i = 0; i < allLines.length; i++) {
          const score = words.filter(w => allLines[i].toLowerCase().includes(w.toLowerCase())).length;
          if (score > bestScore) { bestScore = score; fuzzyRow = i; }
        }
        const parts = [`\u274C No matches found for ${JSON.stringify(query)} \u2014 nothing replaced.`];
        if (fuzzyRow >= 0 && bestScore > 0) {
          const r = 4;
          const cs = Math.max(0, fuzzyRow - r), ce = Math.min(allLines.length - 1, fuzzyRow + r);
          const ctxLines = allLines.slice(cs, ce + 1).map((l, j) => `${String(cs + j + 1).padStart(4)}: ${l}`).join('\n');
          parts.push(`\n\u26A0\uFE0F Closest area found (lines ${cs + 1}\u2013${ce + 1}):\n${ctxLines}`);
          parts.push('\nIf this is the right location, check for case or whitespace differences in your query.');
        }
        return ctx.fail('noMatch', parts.join('\n'), { matchCount: 0, dryRun });
      }

      if (dryRun) {
        // Show all match locations
        const singleFlags = (caseSensitive ? '' : 'i');
        const singlePat   = new RegExp(source, singleFlags);
        const hits = [];
        for (let i = 0; i < allLines.length; i++) {
          if (singlePat.test(allLines[i])) hits.push(`  line ${i + 1}: ${allLines[i].trim()}`);
        }
        const preview = hits.slice(0, 20).join('\n') + (hits.length > 20 ? `\n  \u2026 and ${hits.length - 20} more` : '');
        return ctx.dryRunReturn({
          content: [{ type: 'text', text: [
            `\uD83D\uDD0D DRY RUN: ${matchCount} occurrence${matchCount === 1 ? '' : 's'} of ${JSON.stringify(query)} would be replaced.`,
            `\nMatch locations:\n${preview}`,
            '\nReply with the same call without dryRun (or dryRun:false) to commit.',
          ].join('\n') }],
          matchCount, dryRun: true,
        });
      }

      ctx.snapshotOriginal();
      ctx.buffer.setTextViaDiff(newText);

      const _styleSuffix = applyStyleCheck(replacement, ctx.filePath);
      const _lintSuffix  = await maybeLintSuffix(lint, ctx.editor, null, null, { rows: _changedRows(ctx.text, newText), pad: 1 }); // XW23: only the changed rows
      return {
        ...(await ctx.commit(
          { scopeLabel: ` \u2014 ${matchCount} occurrence${matchCount === 1 ? '' : 's'} of ${JSON.stringify(query)}` },
          { lint: _lintSuffix, style: _styleSuffix }
        )),
        matchCount, dryRun: false,
      };
    },
  });


// â”€â”€ sed (migrated to Tool Framework) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // -- get-structural-anchors ------------------------------------------------
  if (g('edit')) registerMcpTool({
    name: 'get-structural-anchors',
    group: 'edit',
    category: 'nav',
    requiresEditor: false,
    title: 'Get Structural Anchors',
    description: [
      "List the named structural anchors available in the file at `filePath` (required). Call this before using banner or ifdefBlock to discover the exact names to pass.",
      "Returns two categories:",
      "banner names â€” section banner comments (e.g. '// -- INIT --'). Pass the keyword to banner in insert or delete.",
      "ifdefBlock names â€” #ifdef/#ifndef macro names. Pass the macro name to ifdefBlock in insert or delete.",
      "filePath â€” required. The file to query.",
      "TYPICAL WORKFLOW: call get-structural-anchors â†’ pick a name â†’ pass it to insert (banner/ifdefBlock) or delete (banner/ifdefBlock)."
    ].join(" "),
    inputSchema: {
      ...FILE_SCHEMA
    },
    async handler({ filePath } = {}) {
      let buffer, _gsEditor, _gsText, _gsPath, _gsStale = '';
      if (filePath) {
        // Read from disk into a temporary lines array
        try { ({ text: _gsText, staleWarning: _gsStale } = await readTextFromFile(filePath)); }
        catch (e) { return { content: [{ type: "text", text: `âŒ Cannot read file: ${e.message}` }] }; }
        _gsPath = filePath;
        // Find open editor for this path (for tree-sitter)
        _gsEditor = atom.workspace.getTextEditors().find(e => e.getPath && e.getPath() === filePath) || null;
        // Wrap in a minimal buffer-like object
        const lines = _gsText.split(/\r?\n/);
        buffer = { getLines: () => lines };
      } else {
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) return { content: [{ type: "text", text: "âŒ No active editor and no filePath provided." }] };
        buffer   = editor.getBuffer();
        _gsEditor = editor;
        _gsPath  = editor.getPath();
        _gsText  = buffer.getText();
      }

      const allLines = buffer.getLines();

      // -- Section banners ---------------------------------------------------
      const sections = [];
      for (let i = 0; i < allLines.length; i++) {
        const prev = (i > 0) ? allLines[i - 1].trim() : "";
        const next = allLines[i + 1] ? allLines[i + 1].trim() : "";
        if (/^\/\*\s*[=\-]{6,}/.test(prev) && /^\*\s*[=\-]{6,}/.test(next)) {
          // Middle line â€” extract meaningful keyword by stripping comment chars
          const keyword = allLines[i].replace(/^\s*\*\s*/, "").trim();
          if (keyword) sections.push({ keyword, line: i + 1 });
        }
        // Single-line banner: /* ---- Name ---- */ or /* === Name === */
        const _slm = allLines[i].trim().match(/^\/\*\s*[-=]{3,}\s+(.+?)\s+[-=]{3,}\s*\*\/$/);
        if (_slm) {
          const _kw = _slm[1].trim();
          if (_kw) sections.push({ keyword: _kw, line: i + 1 });
        }
      }

      // -- Preprocessor blocks -----------------------------------------------
      const ifdefBlocks = [];
      for (let i = 0; i < allLines.length; i++) {
        const t = allLines[i].trim();
        const m = t.match(/^#\s*(ifdef|ifndef|if\b)\s+(\S+)/);
        if (m) {
          const macro = m[2];
          // Find matching #endif with comment
          for (let j = i + 1; j < allLines.length; j++) {
            const et = allLines[j].trim();
            if (/^#\s*endif/.test(et) && et.toLowerCase().includes(macro.toLowerCase())) {
              ifdefBlocks.push({ macro, openLine: i + 1, closeLine: j + 1 });
              break;
            }
          }
        }
      }

      // -- Format output -----------------------------------------------------
      const parts = [];

      if (sections.length > 0) {
        parts.push("ðŸ“Œ SECTION BANNERS (use as banner:)");
        parts.push(sections.map(s => `  "${s.keyword}"  (line ${s.line})`).join("\n"));
      } else {
        parts.push("ðŸ“Œ SECTION BANNERS â€” none found (no /* ===...=== * NAME * ===...=== */ pattern)");
      }

      parts.push("");
      if (ifdefBlocks.length > 0) {
        parts.push("ðŸ“Œ PREPROCESSOR BLOCKS (use as ifdefBlock:)");
        parts.push(ifdefBlocks.map(p =>
          `  "${p.macro}"  (#ifdef line ${p.openLine} â†’ #endif line ${p.closeLine})`
        ).join("\n"));
      } else {
        parts.push("ðŸ“Œ PREPROCESSOR BLOCKS â€” none found with named #endif comments");
      }

      bump('get_structural_anchors', 'hits');
      return buildSearchResponse({ staleWarning: _gsStale, body: parts.join("\n") });
    }
  });

  // Native in-buffer sed-style editing. Operates entirely on the live buffer â€”
  // no subprocess, no disk write required, full undo/redo and decoration support.
  if (g('edit')) registerMcpTool({
    name:     'sed',
    group:    'edit',
    category: 'edit',
    features: { dryRun: true, lint: true, consecutiveFailureCounter: true },
    title:    'Sed',
    description: [
      "GNU sed 4.9 in JavaScript on `filePath` (required). expression is a full sed script run over the whole file (or a scoped region) and written back like sed -i.",
      "Commands: s y d p P D n N g G h H x a i c = l q Q { } b t T and : labels. Addresses: N, $, first~step, /re/, addr1,addr2, addr,+N, addr,~N, 0,/re/ and !. Separate commands with ; or newlines, e.g. /foo/{s/a/b/g;p}.",
      "Regexes are POSIX basic with the GNU extensions (\\+ \\? \\| \\w \\b) and leftmost-longest matching, NOT JavaScript. extended:true is sed -E. Replacements: \\1..\\9, &, case escapes \\U \\L \\u \\l \\E; a $ is literal. s flags: g p N i I m M (s/a/b/2 replaces the 2nd match on a line).",
      "A first line of #n silences output like sed -n; as with sed -n -i, a silent script that never prints (no p) EMPTIES the file, so dryRun first. Unavailable (sandbox): e r R w W, the s flags e and w, and options -z -s -l.",
      "Scope hints (also inside the scope object) restrict the script to a region, as if wrapped in FROM,TO{ ... }: inFunction, betweenHint, banner and ifdefBlock (+ ifdefEdge) give that whole region; the after*/before* hints (Function, Symbol, String, Line) give a window of hintRadius lines (default 25); fuzzyWhitespace as in replace. occurrence picks which match of an ambiguous hint you mean, NOT the s///N count. Line numbers and $ keep their whole-file meaning; no hint = whole file.",
      "dryRun:true previews the changed lines without writing. A script that changes nothing is reported as a failure so you can correct it. Errors use sed's own wording, e.g. -e expression #1, char 5: unterminated `s' command.",
    ].join(" "),
    inputSchema: {
      // Every shared hint and modifier (inFunction, betweenHint, after*/before*, hintRadius,
      // occurrence, fuzzyWhitespace, dryRun) except regex and fuzzyContent, which have no meaning here.
      ...withoutScopeHints(Object.fromEntries(Object.entries(ANCHOR_SCHEMA).filter(([k]) => k !== 'regex' && k !== 'fuzzyContent'))),
      scope: SCOPE_OBJECT_SCHEMA,
      expression:   z.string(),
      extended:     z.boolean().optional(),
      lint:         z.boolean().optional()
    },
    handler: async ({ expression, extended = false, inFunction, betweenHint, afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterString, beforeString, afterLine, beforeLine, banner, ifdefBlock, ifdefEdge, hintRadius, occurrence, fuzzyWhitespace = false, dryRun = false, lint = false }, ctx) => {
      const { editor, buffer, allLines } = ctx;
      const curTool   = 'sed';
      const lineCount = allLines.length;

      // R4d 2026-10-24: the old JS-regex subset engine (lib/sed-plan.js) is gone from this handler.
      // The script now runs through lib/sed-tool.js (lib/sed-parse.js + lib/sed-run.js: GNU sed 4.9
      // semantics). This handler keeps what needs Pulsar: scope hints, the buffer, the write, stats.

      // -- Optional scope: every hint resolves through resolveScope(), exactly as in replace/insert.
      // The resolved rows (0-based, inclusive) become sed line numbers (1-based) for the interpreter.
      const _hintUsed = {
        inFunction: !!inFunction, betweenHint: !!betweenHint,
        afterFunction: !!afterFunction, beforeFunction: !!beforeFunction,
        afterSymbol: !!afterSymbol, beforeSymbol: !!beforeSymbol,
        afterString: !!afterString, beforeString: !!beforeString,
        afterLine: afterLine != null, beforeLine: beforeLine != null,
        banner: banner !== undefined, ifdefBlock: ifdefBlock !== undefined,
      };
      const hasHint = Object.values(_hintUsed).some(Boolean);
      let scopeRange = null;
      let scopeLabel = "";
      if (hasHint) {
        for (const k of Object.keys(_hintUsed)) if (_hintUsed[k]) bump('sed', 'hintsUsed.' + k);
        if (occurrence != null) bump('sed', 'hintsUsed.occurrence');
        const scope = resolveScope({
          editor, buffer, allLines, text: ctx.text, filePath: ctx.filePath,
          params: { inFunction, betweenHint, afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterString, beforeString, afterLine, beforeLine, banner, ifdefBlock, ifdefEdge, hintRadius, occurrence, fuzzyWhitespace },
        });
        if (scope.error) {
          const _ambig = scope.error.kind === 'ambiguous' || scope.error.ambiguous === true;
          if (!_ambig) ctx.consec.count++;
          bump('sed', _ambig ? 'fails.anchorAmbiguous' : 'fails.anchorNotFound');
          return buildFailResponse({ tool: 'sed', ctx, scope, needle: expression, isCodeFile: isCodeFilePath(ctx.filePath) });
        }
        scopeRange = { from: scope.searchStart + 1, to: scope.searchEnd + 1 };
        scopeLabel = scope.scopeLabel || "";
      }

      // -- Parse + run (sandbox mode: e r R w W refused by the parser) ----------
      const originalText = buffer.getText();
      const _fileName = path.basename(ctx.filePath || "") || undefined;
      const run = runSed({ expression, extended, text: originalText, scope: scopeRange, fileName: _fileName });
      if (!run.ok) {
        bump('sed', run.kind === 'parse' ? 'fails.badExpression' : 'fails.runError');
        return { content: [{ type: "text", text: [
          `\u274C sed: ${run.message}${scopeLabel}`,
          `Nothing was changed.${run.kind === 'parse' ? " The script is GNU sed 4.9 syntax (basic regexes unless extended:true)." : ""}`
        ].join("\n") }], applied: false };
      }

      // -- Compare ---------------------------------------------------------
      const newText = run.output;
      const preview = buildSedPreview(originalText, newText);
      const _exitNote = run.exitCode ? ` The script ended with exit status ${run.exitCode} (q/Q).` : "";
      if (!preview.changed) {
        ctx.consec.count++;
        bump('sed', 'fails.noMatch');
        const parts = [
          `\u274C sed made no changes${scopeLabel}: the script ran but its output equals the file.${_exitNote}`,
          `Check the pattern and the addresses (a basic regex needs \\( \\) \\| \\+ \\? unless extended:true is set)${hasHint ? ", and whether the scope hint covers the lines you mean" : ""}.`,
          smartSuggestion({ toolName: "sed", counter: ctx.consec, noHintsUsed: !hasHint, fileLines: lineCount, oldStr: expression, isCodeFile: isCodeFilePath(ctx.filePath) })
        ];
        return { content: [{ type: "text", text: parts.filter(Boolean).join("\n") }], applied: false, linesRemoved: 0, linesAdded: 0 };
      }

      // -- Dry run preview -------------------------------------------------
      if (dryRun) {
        return {
          content: [{ type: "text", text: [
            `\uD83D\uDD0D DRY RUN \u2014 ${preview.removedCount} line(s) removed or changed, ${preview.addedCount} line(s) added${scopeLabel}.${_exitNote}`,
            `\nPreview:\n${preview.text}`,
            `\nReply with the same call without dryRun (or dryRun:false) to commit.`
          ].join("\n") }],
          applied: false, dryRun: true, linesRemoved: preview.removedCount, linesAdded: preview.addedCount
        };
      }

      // -- Commit ----------------------------------------------------------
      buffer.setTextViaDiff(newText);
      decorateEditedLines(editor, originalText, newText);
      ctx.consec.count = 0; bump('sed', 'hits');

      dbg(curTool, "SUCCESS", { expression, extended, linesRemoved: preview.removedCount, linesAdded: preview.addedCount, scopeLabel });
      // XW23: lint only the rows sed changed (a deletion point counts too, with one row of padding), not the whole file.
      const _sedDiff = _sedDiffLines(originalText.split('\n'), newText.split('\n'));
      const _sedRows = _sedDiff.added.map(a => a.row - 1).concat(_sedDiff.removed.map(r => Math.max(0, r.row - 1)));
      const _lintSuffix = await maybeLintSuffix(lint, editor, null, null, { rows: _sedRows, pad: 1 });
      return {
        ...(await buildEditResponse(
          { tool: curTool, linesChanged: (preview.addedCount - preview.removedCount) || null, scopeLabel: `${scopeLabel} \u2014 ${preview.removedCount} removed, ${preview.addedCount} added${_exitNote}`, buffer },
          { lint: _lintSuffix, nudge: `\nChanges:\n${preview.text}` }
        )),
        applied: true, linesRemoved: preview.removedCount, linesAdded: preview.addedCount, dryRun: false
      };
    },
  });

  // -- FILE-OPS GROUP (part 4: file-line-count) -----------------------------
  if (g('fileOps')) {
  registerMcpTool({
    name: 'file-line-count',
    group: 'fileOps',
    category: 'nav',
    requiresEditor: false,
    title: 'File Line Count',
    description: [
      "Return the line count of any project file without loading its content into context.",
      "Cheap orientation step before using read or grep-file on a large file."
    ].join(" "),
    inputSchema: { ...FILE_SCHEMA },
    async handler({ filePath }) {
      let lineCount;
      let resolvedPath = filePath;
      let text, staleWarning;
      try { ({ text, staleWarning } = await readTextFromFile(filePath)); }
      catch (err) { throw new Error(`Cannot read file: ${filePath} - ${err.message}`); }
      lineCount = text.split(/\r?\n/).length;
      bump('file_line_count', 'hits');
      return {
        ...buildSearchResponse({ staleWarning, body: JSON.stringify({ filePath: resolvedPath, lineCount }, null, 2) }),
        lineCount
      };
    },
  });
  } // end FILE-OPS GROUP (part 4)

  // -- EDIT GROUP (apply-patch) -----------------------------------------------
  if (g('edit')) registerMcpTool({
    name:     'apply-patch',
    group:    'edit',
    category: 'edit',
    features: { dryRun: true, lint: true, consecutiveFailureCounter: true },
    description: [
      "Apply a unified diff patch to `filePath` (required); best for edits at several scattered places, cheaper than many replace calls. Standard format: @@ hunk headers and +/- lines with about 3 unchanged context lines per change. @@ line numbers are hints only (the tool searches nearby, so minor drift is fine) and @@ line counts are auto-corrected.",
      "DEFAULT BEHAVIOR: previews the patch without writing (dryRun defaults to true); repeat the same call with dryRun:false to commit. FUZZY RESCUE: if a hunk fails, fuzzy/indent-aware matching is tried automatically and a corrected diff preview is shown; apply it with apply-patch({ confirm:true }) without resending the patch.",
      "LARGE EDIT NOTE: for edits touching more than ~30% of the file, write-file or replace-function-body is cheaper than a large patch. Returns linesAdded, linesRemoved, hunksApplied and a diff of the actual change.",
    ].join(" "),
    inputSchema: {
      ...FILE_SCHEMA,
      patch:       z.string().optional(),
      dryRun:      z.boolean().optional(),
      fuzzFactor:  z.number().optional(),
      confirm:     z.boolean().optional(),
      lint:        z.boolean().optional(),
    },
    title:    'Apply Patch',
    handler: async ({ patch = "", dryRun = true, fuzzFactor = 0, confirm = false, lint = false }, ctx) => {
            const { editor, buffer, allLines } = ctx;
      const curTool  = 'apply-patch';
      const bufLines = allLines;
      dbg(curTool, "ARGS", { patchLength: patch.length, dryRun, fuzzFactor, confirm });

        // -- confirm:true - apply the last fuzzy-rescued patch -----------------
        if (confirm) {
          if (!patchRescueStore.hunks || patchRescueStore.hunks.length === 0) {
            return { content: [{ type: "text", text: "No rescued patch available to confirm. Send the original patch again." }], applied: false };
          }

          const rescued = patchRescueStore.hunks;
          if (patchRescueStore.filePath && patchRescueStore.filePath !== ctx.filePath) {
            return { content: [{ type: "text", text: "apply-patch confirm refused: the rescued patch was prepared for " + patchRescueStore.filePath + ", not this file. Nothing was written. Send the patch again." }], applied: false };
          }
          if (!rescued.every(rh => rescueStillValid(rh, bufLines))) {
            patchRescueStore.hunks = null; patchRescueStore.patchKey = null;
            return { content: [{ type: "text", text: "apply-patch confirm refused: the file changed since the rescue preview, so the located rows may be wrong. Nothing was written. Send the patch again." }], applied: false };
          }
          // Reverse row order so earlier rows keep their numbers; each hunk replaces its whole old block.
          const sorted = [...rescued].sort((a, b) => b.startRow - a.startRow);
          const _eolAt = (r) => (buffer.lineEndingForRow ? buffer.lineEndingForRow(Math.min(Math.max(r, 0), buffer.getLastRow())) : '') || "\n";
          for (const rh of sorted) {
            const s0 = rh.editStart, n0 = rh.editOldLen, nb = rh.editNew;
            if (n0 === 0 && nb.length === 0) continue;
            if (nb.length === 0) { buffer.deleteRows(s0, s0 + n0 - 1); continue; }
            if (n0 === 0) {
              // pure insert: before row s0, or after the last row when s0 is past the end
              if (s0 > buffer.getLastRow()) { const lr = buffer.getLastRow(); const e = _eolAt(lr - 1); buffer.insert([lr, bufLines[lr].length], e + nb.join(e)); }
              else buffer.insert([s0, 0], nb.map(l => l + _eolAt(s0)).join(""), { normalizeLineEndings: false });
              continue;
            }
            const lastRow = s0 + n0 - 1;
            buffer.setTextInRange([[s0, 0], [lastRow, bufLines[lastRow].length]], nb.map((l, i) => (i < nb.length - 1 ? l + _eolAt(Math.min(s0 + i, lastRow)) : l)).join(""), { normalizeLineEndings: false });
          }

          patchRescueStore.hunks    = null;
          patchRescueStore.patchKey = null;
          ctx.consec.count       = 0;
          dbg(curTool, "CONFIRM APPLY - rescue patch committed", { hunks: rescued.length });
          bump('apply_patch', 'rescuedCommits');

          const _lintRows = []; // XW23: only the rescued hunks' rows
          for (const rh of rescued) for (let i = 0; i <= rh.editNew.length; i++) _lintRows.push(rh.editStart + i);
          const _lintSuffix = await maybeLintSuffix(lint, editor, null, null, { rows: _lintRows, pad: 1 });
          const _hunkDetail = rescued.map((rh, i) => `  Hunk ${i + 1}: at line ${rh.startRow + 1}${rh.strategyNote}`).join('\n');
          return {
            ...(await buildEditResponse(
              { tool: curTool, tags: ['rescued'], scopeLabel: ` - ${rescued.length} hunk(s)`, buffer },
              { lint: _lintSuffix, nudge: _hunkDetail ? `\n${_hunkDetail}` : '' }
            )),
            applied: true, hunksApplied: rescued.length };
        }

        const originalText = buffer.getText();
        const filePath     = (editor && editor.getPath()) || ctx.filePath || "[untitled]";
        const fileName     = path.basename(filePath);

        // Ensure patch has a file header - applyPatch requires it.
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
          ? ` LARGE EDIT WARNING: this patch touches ~${Math.round(changeRatio * 100)}% of the file (${addedLines + removedLines} lines changed out of ${totalFile}). Consider write-file or replace-function-body instead for better token efficiency.`
          : "";

        // Auto-correct the @@ hunk headers (wrong line counts are the most common exception cause): fixHunkHeaders is in
        // lib/patch-utils.js since R3o (2026-11-08); its old version corrupted the header of every multi-line hunk.
        normalizedPatch = fixHunkHeaders(normalizedPatch);

        // Attempt to apply the patch
        let result;
        let _patchThrew = false; // R3n (2026-11-08): set in the catch below; the failure is counted ONCE, at the 'result === false' branch
        try {
          result = applyPatch(originalText, normalizedPatch, { fuzzFactor });
        } catch (e) {
          result = false; // treat exception same as context mismatch - fall through to fuzzy rescue
          _patchThrew = true; // counted once, below (R3n): this used to bump fails.exception here AND fails.contextMismatch again
          dbg(curTool, `exception (treating as mismatch)`, { error: e.message });
        }

        // -- Fuzzy rescue -----------------------------------------------------
        // If applyPatch failed, parse each hunk, locate its context lines in the
        // buffer using resolveScope()/matchContent() (exact ? fuzzy ? recover.js
        // rescue stages, same waterfall every other edit tool shares - T1,
        // 2026-09-12, migrated off the old bespoke findAnchor), rebuild a
        // corrected patch with real line numbers and real indentation, then show
        // a diff preview. The caller can apply it with confirm:true.
        if (result === false) {
          ctx.consec.count++;
          bumpApplyPatchFailure(_patchThrew); // R3n: ONE key per failed patch (exception when applyPatch threw, else contextMismatch)
          dbg(curTool, `FAIL #${ctx.consec.count} (context mismatch - attempting fuzzy rescue)`, { hunks: hunkCount });

          const bufLines = buffer.getLines();

          // Parse hunks: each hunk has context (+/-/ ) lines and a hunk header
          const hunkRe  = /^@@[^@]*@@[^\n]*\n([\s\S]*?)(?=\n@@|\n---|\n\+\+\+|(?![\s\S]))/gm;
          const hunks   = [];
          let   hm;
          while ((hm = hunkRe.exec(normalizedPatch)) !== null) {
            const body     = hm[1];
            const bodyLines = body.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));
            // Context lines (space or -) stripped of leading sigil - used as anchor
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
            hunks.push({ bodyLines, ctxLines, addLines, delLines, ops: parseHunkOps(bodyLines) });
          }

          if (hunks.length === 0) {
            return { content: [{ type: "text", text: [
              `Could not parse any hunks from patch. Failure #${ctx.consec.count}.`,
              smartSuggestion({ toolName: "apply-patch", counter: ctx.consec, noHintsUsed: true, fileLines: bufLines.length, oldStr: null, isCodeFile: isCodeFilePath(ctx.filePath) })
            ].filter(Boolean).join("\n") }], applied: false, consecFailures: ctx.consec.count };
          }

          // Try to locate each hunk in the buffer via resolveScope()/matchContent()
          const rescuedHunks = [];
          const rescueNotes  = [];
          let   searchAfter  = 0;
          let   allLocated   = true;

          for (let hi = 0; hi < hunks.length; hi++) {
            const hunk    = hunks[hi];
            // Use first 4 non-empty context lines as the anchor string.
            // T1 bugfix (2026-09-12): previously filtered l.trim().length > 2,
            // which drops short-but-meaningful lines like a bare "{" or "}".
            // That's fine for the old findAnchor fuzzy search (representative
            // sampling, no adjacency requirement) but matchContentEngine's
            // scanBlock requires the anchor lines to be CONSECUTIVE in the
            // buffer -- dropping a middle line (e.g. the "{" between a function
            // signature and its body) breaks that adjacency and the anchor
            // silently fails to match content that is actually right there.
            // Now only drops genuinely empty lines, preserving adjacency.
            const anchor  = hunk.ctxLines
              .filter(l => l.trim().length > 0)
              .slice(0, 4)
              .join("\n");

            if (!anchor) {
              rescueNotes.push(`Hunk ${hi + 1}: no usable context lines - cannot locate.`);
              allLocated = false;
              continue;
            }

            // T1: was findAnchor(buffer, anchor, { afterRow: searchAfter }) -
            // migrated onto resolveScope()/matchContent() so hunk rescue shares
            // the same ambiguity guard (B41) and diagnostics as every other
            // tool, instead of the old bespoke findAnchor fuzzy-rescue. Format
            // and behavior are unchanged - this is purely an internals swap.
            const _scope = resolveScope({ editor, buffer, allLines: bufLines, text: ctx.text, filePath: ctx.filePath, params: { afterRow: searchAfter } });
            const _m = matchContentEngine(anchor, { allLines: bufLines, text: ctx.text }, _scope, {});
            dbg(curTool, "T1 DEBUG rescue match attempt", { anchor, searchAfter, scope: _scope, matched: _m.matched, reason: _m.reason, matchLine: _m.matchLine, transforms: _m.transforms });
            const hit = _m.matched
              ? { row: _m.matchLine, matchedRows: _m.matchEndLine - _m.matchLine + 1,
                  strategy: _m.transforms.length === 0 ? "exact" : _m.transforms[0] }
              : null;
            if (!hit) {
              if (_m.reason === 'ambiguous') {
                const _lines = _m.matchLines ? _m.matchLines.join(', ') : 'multiple locations';
                rescueNotes.push(`Hunk ${hi + 1}: context is ambiguous - matches more than one place in the buffer (lines ${_lines}). Narrow the hunk's context lines to make it unique.`);
              } else {
                rescueNotes.push(`Hunk ${hi + 1}: context not found in buffer (even with fuzzy matching).`);
              }
              allLocated = false;
              continue;
            }

            // 2026-11-19: the whole old block is verified and re-planned (lib/patch-rescue.js): context rows from the
            // buffer, '+' rows re-indented per nearest old row, '+' kept in patch order.
            const _plan = planRescueHunk(hunk.ops, bufLines, hit.row);
            if (!_plan.ok) {
              rescueNotes.push(`Hunk ${hi + 1}: found near line ${hit.row + 1} but the old lines do not all match there${_plan.at !== undefined ? ` (line ${_plan.at + 1})` : ''}. Fix the hunk's context lines.`);
              allLocated = false;
              continue;
            }
            const strategyNote = (hit.strategy !== "exact" ? ` [matched via ${hit.strategy}]` : "") +
              (_plan.indentDelta !== 0 ? ` [indent adjusted ${_plan.indentDelta > 0 ? "+" : ""}${_plan.indentDelta}]` : "");
            rescuedHunks.push({ ..._plan, ops: hunk.ops, strategyNote });
            rescueNotes.push(`Hunk ${hi + 1}: located at line ${_plan.startRow + 1}${strategyNote}`);
            searchAfter = _plan.startRow + _plan.oldLen;
          }

          // Build preview of what the rescue would do (patch order: context, '-', '+')
          const previewLines = [];
          for (const rh of rescuedHunks) { previewLines.push(...previewHunk(rh.ops, bufLines, rh), ""); }

          const parts = [
            allLocated
              ? `Patch failed but fuzzy rescue located all ${hunks.length} hunk(s). Preview of corrected changes:`
              : `Patch failed. Fuzzy rescue located ${rescuedHunks.length} of ${hunks.length} hunk(s):`,
            ...rescueNotes,
            `\n${previewLines.slice(0, 80).join("\n")}${previewLines.length > 80 ? "\n  ... (truncated)" : ""}`,
          ];

          if (allLocated && rescuedHunks.length > 0) {
            // Store rescued hunks for confirm - key by a short hash of the patch
            patchRescueStore.hunks    = rescuedHunks;
            patchRescueStore.filePath = ctx.filePath;
            patchRescueStore.patchKey = patch.length + ":" + hunkCount;
            parts.push(`\nReply with apply-patch({ confirm: true }) to apply the rescued patch, or correct and resend.`);
            return { content: [{ type: "text", text: parts.join("\n") }], applied: false, rescueAvailable: true, consecFailures: ctx.consec.count };
          }

          parts.push(smartSuggestion({ toolName: "apply-patch", counter: ctx.consec, noHintsUsed: true, fileLines: bufLines.length, oldStr: null, isCodeFile: isCodeFilePath(ctx.filePath) }));
          return { content: [{ type: "text", text: parts.join("\n") }], applied: false, rescueAvailable: false, consecFailures: ctx.consec.count };
        }

        // Dry run (default) - report what would change without writing, and
        // store the resolved result so confirm:true can commit it directly
        // without needing the patch text resent.
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
          const diffSnippet = diffOut.slice(0, 60).join("\n") + (diffOut.length > 60 ? "\n  ... (truncated)" : "");

          return {
            content: [{ type: "text", text: [
              `DRY RUN - patch applies cleanly. ${hunkCount} hunk(s), +${dryAdded}/-${dryRemoved} lines.`,
              largeEditWarning ? `\n${largeEditWarning}` : "",
              `\nDiff preview:\n${diffSnippet}`,
              `\nReply with the same call and dryRun:false to commit.`
            ].filter(Boolean).join("\n") }],
            dryRun: true, hunksApplied: hunkCount, linesAdded: dryAdded, linesRemoved: dryRemoved,
            largeEditWarning: !!largeEditWarning
          };
        }

        // dryRun:false was passed explicitly - apply immediately, same as any
        // other tool's dryRun:false path.

        // Apply the patch to the live buffer
        const beforeText = buffer.getText();
        buffer.setTextViaDiff(result);
        decorateEditedLines(editor, beforeText, result);

        // Reset failure counter on success
        ctx.consec.count = 0; bump('apply_patch', 'hits');
        if (largeEditWarning) bump('apply_patch', 'largeEditWarnings');
        dbg(curTool, "SUCCESS - failure counter reset", { hunks: hunkCount, dryRun: false });

        // Compute actual diff for verification
        const hunks      = diffLines(originalText, result);
        const linesAdded   = hunks.filter(h => h.added).reduce((n, h) => n + (h.count ?? 0), 0);
        const linesRemoved = hunks.filter(h => h.removed).reduce((n, h) => n + (h.count ?? 0), 0);
        const newLineCount = buffer.getLineCount();

        const _lintSuffix = await maybeLintSuffix(lint, editor, null, null, { rows: _changedRows(beforeText, result), pad: 1 }); // XW23: only the changed rows
        const _addedText = hunks.filter(h => h.added).map(h => h.value).join("\n");
        const _styleSuffix = _addedText ? applyStyleCheck(_addedText, ctx.filePath) : "";
        return {
          ...(await buildEditResponse(
            { tool: curTool, linesChanged: linesAdded - linesRemoved, scopeLabel: ` - ${hunkCount} hunk(s), +${linesAdded}/-${linesRemoved}`, tags: largeEditWarning ? ['largeEdit'] : [], buffer },
            { lint: _lintSuffix, style: _styleSuffix }
          )),
          hunksApplied: hunkCount, linesAdded, linesRemoved, newLineCount,
          largeEditWarning: !!largeEditWarning, dryRun: false
        };
    }
  }); // end apply-patch

  // -- DIAGNOSTICS GROUP ----------------------------------------------------
  if (g('diagnostics')) {
  async function findCompiler() {
    const candidates = IS_WINDOWS
      ? ["gcc", "clang", "cl"]
      : process.platform === "darwin"
        ? ["clang", "gcc", "cc"]
        : ["gcc", "clang", "cc"];

    for (const exe of candidates) {
      const probe = IS_WINDOWS ? `where ${exe}` : `which ${exe}`;
      const found = await new Promise(resolve => {
        _exec(probe, { timeout: 3000, windowsHide: true }, err => resolve(!err));
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

  registerMcpTool({
    name:           'get-compiler-diagnostics',
    group:          'diagnostics',
    category:       'command',
    requiresEditor: false,
    title:          'Get Compiler Diagnostics',
    description: [
      "Syntax-check a C/C++ file (or all project C/C++ files) using the compiler directly.",
      "Automatically detects gcc, clang, or cl (MSVC) depending on platform.",
      "filePath (optional): the file to check when scope is 'file'. Falls back to the active editor if omitted.",
      "scope: 'file' (default) checks only filePath (or the active file if filePath is omitted); 'project' checks all .c/.cpp files.",
      "compilerOptions: extra flags passed to the compiler (e.g. '-std=c11 -DDEBUG').",
      "Each result includes severity, file, line, column, message, and the compiler used.",
      "Runs the compiler on the file as saved on disk. Edits from edit tools auto-save, so this is normally already current \u2014 only relevant if using undo or an external tool that leaves the buffer unsaved.",
      "For live buffer diagnostics without saving, use get-diagnostics (linter-bundle) instead."
    ].join(" "),
    inputSchema: {
      filePath:        z.string().optional(),
      scope:           z.enum(["file", "project"]).optional(),
      compilerOptions: z.string().optional()
    },
    handler: async ({ filePath, scope = "file", compilerOptions = "" } = {}, ctx) => {
      const compiler = await findCompiler();
      if (!compiler) throw new Error("No C compiler found. Install gcc, clang, or cl and ensure it is on PATH.");

      const roots        = atom.project.getPaths();
      const cwd          = roots[0] ?? null;
      const includePaths = roots.map(r => `-I"${r}"`).join(" ");
      const shell        = IS_WINDOWS ? "powershell.exe" : "/bin/sh";

      let filesToLint = [];
      if (scope === "file") {
        // Prefer an explicit filePath (works whether or not the file is open
        // in a tab); fall back to the active editor for backward compatibility.
        const resolvedPath = filePath || ctx?.filePath || (ctx?.editor && ctx.editor.getPath());
        if (!resolvedPath) throw new Error("No active file to lint â€” pass filePath to target a specific file.");
        filesToLint = [resolvedPath];
      } else {
        let allFiles = [];
        for (const root of roots) allFiles = allFiles.concat(await walkDir(root));
        filesToLint = allFiles.filter(f => /\.(c|cpp|cc|cxx)$/i.test(f));
      }

      const results = [];
      for (const filePath of filesToLint) {
        const cmd = buildCmd(compiler, filePath, includePaths, compilerOptions);
        await new Promise((resolve) => {
          _exec(cmd, { cwd, timeout: 15000, maxBuffer: 1024 * 1024, shell, windowsHide: true },
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
      const notes    = results.filter(r => r.severity === "note").length;
      const summary  = notes > 0
        ? `Compiler: ${compiler} | ${errors} error(s), ${warnings} warning(s), ${notes} note(s) in ${scope}.`
        : `Compiler: ${compiler} | ${errors} error(s), ${warnings} warning(s) in ${scope}.`;

      return {
        content: [{ type: "text", text: JSON.stringify({ summary, compiler, total: results.length, diagnostics: results }, null, 2) }],
        total: results.length, errors, warnings, notes, compiler
      };
    }
  });

  // -- get-diagnostics (linter-bundle) -----------------------------------------
  registerMcpTool({
    name:           'get-diagnostics',
    group:          'diagnostics',
    category:       'command',
    requiresEditor: false,
    title:          'Get Diagnostics',
    description: [
      "Return live linter diagnostics (errors, warnings, info) from linter-bundle.",
      "Live on the buffer â€” linter-bundle re-runs on every buffer change (debounced ~300ms), no save needed.",
      "Works for any language with a linter provider installed (JS, TS, C, C++, and others).",
      "Returns [] gracefully if linter-bundle is not active â€” no error.",
      "filePath (optional, used when scope is 'file'): the file to get messages for. Falls back to the active editor if omitted. Uses linter-bundle's native filePath scoping, so it reads from linter-bundle's own message registry directly rather than requiring the file to be focused.",
      "scope: 'file' (default) returns messages for filePath (or the active editor if filePath is omitted);",
      "'project' returns all messages across all open files (filePath is ignored in this mode).",
      "Each message includes severity, excerpt, linterName, file, and range (1-based line/col).",
      "For compiler-level C/C++ checks on the saved file, use get-compiler-diagnostics instead."
    ].join(" "),
    inputSchema: {
      filePath: z.string().optional(),
      scope: z.enum(["file", "project"]).optional(),
    },
    handler: async ({ filePath, scope = "file" } = {}) => {
      // Delegate to linter-bundle's own GetLinterMessages execute().
      // instance is a private module-level var in linter-bundle/lib/main.js
      // and is NOT exposed on mainModule â€” lb.mainModule.instance is always
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

      // filePath support: linter-bundle 2.6.0+ added a real filePath filter to
      // GetLinterMessages.execute() (see lint-helpers.js's lintSnapshot for the
      // reference implementation this mirrors) â€” execute({filePath}) scopes
      // messages from linter-bundle's own full registry directly, independent
      // of UI focus/viewMode, including files never opened in a tab at all.
      // This replaces an earlier viewMode-toggle-and-filter workaround that
      // was already obsoleted elsewhere in this codebase â€” use the same fix
      // here instead of re-deriving the deprecated approach.
      const editor = atom.workspace.getActiveTextEditor();
      const targetPath = filePath || editor?.getPath() || null;

      // lbResult has { mode, path, messages[] } where messages have 0-based rows.
      // scope still controls what we ask linter-bundle for: 'file' passes our
      // resolved targetPath (native upstream file-scoping); 'project' omits it
      // to get every file's messages, regardless of whether filePath was given
      // (a project-wide check with a filePath hint doesn't make sense to narrow).
      const lbResult = scope === "file"
        ? lbTool.execute(targetPath ? { filePath: targetPath } : {})
        : lbTool.execute();

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
          path: scope === "file" ? targetPath : null,
          summary: `${errors} error(s), ${warnings} warning(s), ${infos} info(s)`,
          messageCount: formatted.length,
          messages: formatted,
        }, null, 2) }]
      };
    }
  });
  } // end DIAGNOSTICS GROUP

  // -- SAFETY GROUP (part 2: diff-preview, checkpoint, restore, list) --------
  if (g('safety')) {
  registerMcpTool({
    name:           'diff-preview',
    group:          'safety',
    category:       'command',
    requiresEditor: true,
    title:          'Diff Preview',
    description: [
      "Show a unified diff between the current buffer and a proposed replacement text, without applying any changes.",
      "Use this before write-file or replace-function-body to verify edits are correct.",
      "Returns a unified diff string plus a summary of lines added/removed. The edit tool you preview for (write-file, replace-function-body, etc.) will auto-save once applied."
    ].join(" "),
    inputSchema: { proposedText: z.string() },
    handler: async ({ proposedText }, ctx) => {
      const editor = ctx.editor;

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
          content: [{ type: "text", text: "No changes â€” proposed text is identical to the buffer." }],
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
        `Diff: +${added}/-${removed} lines. Similarity: ${Math.round(similarity * 100)}%.`,
        wsOnly ? `\n??  WHITESPACE ONLY â€” all content matches but indentation/spacing differs. Safe to commit if that is intentional.` : "",
        !wsOnly && canCommit ? `\n? High similarity (${Math.round(similarity * 100)}%) â€” looks correct. Use write-file or replace-function-body to commit.` : "",
        !wsOnly && !canCommit ? `\n??  Low similarity (${Math.round(similarity * 100)}%) â€” review the diff carefully before committing.` : "",
        `\n${unifiedLines.join("\n")}`
      ];

      return {
        content: [{ type: "text", text: parts.filter(Boolean).join("\n") }],
        linesAdded: added, linesRemoved: removed, unchanged: false,
        similarity: Math.round(similarity * 100), wsOnly, canCommit
      };
    }
  });

  registerMcpTool({
    name:           'checkpoint',
    group:          'safety',
    category:       'command',
    requiresEditor: true,
    title:          'Checkpoint',
    description: [
      "Save a named snapshot of the current buffer so edits can be rolled back with restore-checkpoint.",
      "name defaults to 'default'. Checkpoints are in-memory and cleared on server restart. WARNING: if this MCP server's own source files (mcp-registration.js, pulsar-edit-mcp-server.js) are edited and saved, Pulsar will reload the package and restart the server â€” all checkpoints will be lost immediately. Always save test files to disk (save-all) as an additional safety net before editing server source.",
      "Call this before any risky multi-step edit sequence."
    ].join(" "),
    inputSchema: { name: z.string().optional() },
    handler: async ({ name = "default" } = {}, ctx) => {
      const editor = ctx.editor;
      const text = editor.getBuffer().getText();
      checkpoints.set(name, { text, filePath: ctx.filePath, savedAt: new Date().toISOString() });
      return {
        content: [{ type: "text", text: `Checkpoint '${name}' saved (${text.split(/\r?\n/).length} lines).` }],
        name, lineCount: text.split(/\r?\n/).length
      };
    }
  });

  registerMcpTool({
    name:           'restore-checkpoint',
    group:          'safety',
    category:       'command',
    requiresEditor: true,
    title:          'Restore Checkpoint',
    description: [
      "Restore the buffer to a previously saved checkpoint by name.",
      "name defaults to 'default'. Use list-checkpoints to see available snapshots.",
      "This is a full buffer replace â€” use diff-preview first to see what will change. If the checkpoint is missing (returns not found), the server was likely restarted by a server source file save â€” use undo or the saved disk file to recover."
    ].join(" "),
    inputSchema: { name: z.string().optional() },
    handler: async ({ name = "default" } = {}, ctx) => {
      const editor = ctx.editor;
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
  });

  registerMcpTool({
    name:           'list-checkpoints',
    group:          'safety',
    category:       'command',
    requiresEditor: false,
    title:          'List Checkpoints',
    description:    'List all in-memory checkpoints with their names, file paths, and save times.',
    inputSchema:    {},
    handler: async () => {
      const list = [...checkpoints.entries()].map(([name, cp]) => ({
        name, filePath: cp.filePath, savedAt: cp.savedAt, lineCount: cp.text.split(/\r?\n/).length
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
        count: list.length
      };
    }
  });
  } // end SAFETY GROUP (part 2)

  // -- SEARCH GROUP (part 2) ---------------------------------
  if (g('search')) {


// â”€â”€ get-repo-map (migrated to Tool Framework) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (g('search')) registerMcpTool({
    name:           'get-repo-map',
    group:          'search',
    category:       'command',
    requiresEditor: false,
    title: 'Get Repo Map',
    description: [
      "Compact Aider-style repo map: function signatures grouped by file, ranked by PageRank, with ... between non-consecutive lines. Use it first on an unfamiliar codebase. Uses tree-sitter via open editors for accurate symbols and falls back to regex for closed files.",
      "Output fits a token budget: maxTokens (default 1024, about 4096 chars); a binary search keeps the most symbols that fit. it maps ONE project, by default the one holding the active file (project:'<folder name>' picks another, project:'all' every open project); glob restricts files (default all C/C++/JS/TS); excludeGlob removes some (applied after glob); minRefs keeps only symbols referenced from at least that many other files (default 0 = all); mentionedFiles (paths) boosts those files in the ranking; includeLineNumbers (default true).",
      "File health warnings may be appended: [unicode] non-ASCII present (use fuzzyContent when editing); [mojibake xN] corrupted cp1252-as-UTF-8 encoding (file is broken); [crlf xN] Windows line endings; [trailing-comments xN] inline trailing comments, which replace old_str often omits (autoStripComment rescues them); [check-me xN] salvaged comments left as /* CHECK: ... */ - verify each one before removing the marker.",
    ].join(" "),
    inputSchema: {
      glob:               z.string().optional(),
      excludeGlob:        z.string().optional(),
      maxTokens:          z.number().optional(),
      minRefs:            z.number().optional(),
      mentionedFiles:     z.array(z.string()).optional(),
      includeLineNumbers: z.boolean().optional(),
      project:            z.string().optional(),
    },
    async handler({ glob = "", excludeGlob = "", maxTokens = 1024, minRefs = 0, mentionedFiles = [], includeLineNumbers = true, project } = {}) {
      // Project scoping (2026-11-18): the active file's project by default; project:'all' for every open root.
      const _scope = resolveProjectRoots(atom.project.getPaths(), project, (atom.workspace.getActiveTextEditor() || { getPath: () => null }).getPath());
      if (!_scope.ok) {
        bump('get_repo_map', 'fails.noProject');
        return { content: [{ type: "text", text: _scope.error }] };
      }
      const roots = _scope.roots;

      // -- 1. Collect files ------------------------------------------------
      const effectiveGlob = glob || "**/*.{c,cpp,cc,cxx,h,hpp,js,ts,jsx,tsx}";
      const globRe = globToRegex(effectiveGlob);
      let allFiles = [];
      for (const root of roots) allFiles = allFiles.concat(await walkDir(root));
      allFiles = allFiles.filter(f => globRe.test(f.replace(/\\/g, "/")));
      if (excludeGlob) {
        const excludeRe = globToRegex(excludeGlob);
        allFiles = allFiles.filter(f => !excludeRe.test(f.replace(/\\/g, "/")));
      }

      // -- 2. Extract symbols â€” tree-sitter for open editors, regex fallback --
      // (delegated to getSymbols / getSymbolsFromText from tree-sitter-symbols.js)

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
      const fileTexts = {}; // text of every analysed file (editor text when open), read once

      async function extractSymbols(filePath) {
        const fpFwd = filePath.replace(/\\/g, "/");
        const ed = openEditors.get(fpFwd);
        let txt;
        try { txt = ed ? ed.getText() : await fs.promises.readFile(filePath, "utf8"); } catch { return; }
        fileTexts[filePath] = txt;
        // getSymbols: uses tree-sitter if editor is open, falls back to regex for closed files.
        // getSymbolsFromText also picks up REGISTER_TOOL_RE for JS registerTool() patterns.
        const syms = getSymbols(ed || null, txt, filePath);
        for (const s of syms) {
          // indented signature = local variable / nested helper, not a map-worthy definition (the regex fallback reports them)
          if (s.name && s.name.length > 1 && !/^\s/.test(s.sig || ''))
            symbols.push({ filePath, line: s.startRow + 1, name: s.name, sig: s.sig, refs: 0, score: 0 });
        }
      }

      // Each file is read ONCE (symbols and ref counts share the text). The device call times out at about 80 s, so stop
      // analysing at 60 s and say so in the result instead of timing out with nothing.
      const _TIME_BUDGET_MS = 60000;
      const _deadline = Date.now() + _TIME_BUDGET_MS;
      let _timedOut = false;
      const analysed = [];
      for (const fp of allFiles) {
        if (Date.now() > _deadline) { _timedOut = true; break; }
        await extractSymbols(fp);
        analysed.push(fp);
      }

      // Group symbols by definer file
      const symsByFile = new Map();
      for (const sym of symbols) {
        if (!symsByFile.has(sym.filePath)) symsByFile.set(sym.filePath, []);
        symsByFile.get(sym.filePath).push(sym);
      }

      // Build edge list: [srcFile, dstFile, sqrt(refCount)]
      const nodes = [...symsByFile.keys()];
      // Cross-file refs per symbol and the file->file edges, counted in one pass per file (lib/repo-map.js)
      const { edges: edgeAccum } = countRefs(symbols, fileTexts, analysed);
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

      // -- 4. Sort files by rank, filter by minRefs ------------------------
      const sortedFiles = [...symsByFile.entries()]
        .filter(([, syms]) => syms.some(s => s.refs >= minRefs))
        .sort((a, b) => (rank[b[0]] || 0) - (rank[a[0]] || 0));


      // -- 5. Render within the token budget (lib/repo-map.js, 2026-11-18) ------
      // If even one symbol per file does not fit, the lowest-ranked files are dropped instead of overshooting maxTokens.
      const charBudget = maxTokens * 4; // ~4 chars/token
      const _relOf = (fp) => fp.replace(/\\/g, "/").replace(projectRoot + "/", "");
      const best = renderRepoMap(sortedFiles, { charBudget, minRefs, includeLineNumbers, relOf: _relOf });
      const _shownFiles = sortedFiles.slice(0, best.filesShown);

      // -- 5a. File-health scan (unicode / mojibake / crlf), for the files SHOWN only and at most 10 lines ----
      const _healthEntries = [];
      for (const [fp] of _shownFiles) {
        const txt = fileTexts[fp];
        if (!txt) continue;
        const flags = [];
        // [crlf x N]
        const crlfCount = (txt.match(/\r\n/g) || []).length;
        if (crlfCount > 0) flags.push('[crlf x' + crlfCount + ']');
        // [mojibake x N] -- cp1252-as-UTF-8 corruption clusters
        const mojiCount = (txt.match(/\xE2[\x80-\x86][\x80-\xBF]|\xC2[\x80-\xBF]|\xC3[\x80-\xBF]/g) || []).length;
        if (mojiCount > 0) flags.push('[mojibake x' + mojiCount + ']');
        // [unicode] -- non-ASCII present (needs fuzzyContent or regex:true when editing)
        if (/[^\x00-\x7F]/.test(txt)) flags.push('[unicode]');
        // [trailing-comments xN] -- lines with inline trailing /* */ or // comments
        // after code. replace old_str often hallucinate or omit these; use
        // autoStripComment rescue or strip manually when editing these lines.
        const trailingCommentLines = (txt.match(/\S.*(?:\/\/[^\n]*|\/\*.*?\*\/)\s*$/gm) || []).length;
        if (trailingCommentLines > 0) flags.push('[trailing-comments x' + trailingCommentLines + ']');
        // [check-me xN] -- /* CHECK: ... */ markers left by autoStripComment rescue;
        // each one needs a human to verify the salvaged trailing comment is correct.
        // strip // comments and string contents before scanning to avoid false positives
        // when this file scans itself (the regex pattern and its own comments contain /* CHECK: */)
        const _chkTxt = txt
          .replace(/"(?:[^"\\]|\\.)*"/g, '""')
          .replace(/'(?:[^'\\]|\\.)*'/g, "''")
          .replace(/\/\/[^\n]*/g, '');
        const checkMeCount = (_chkTxt.match(/\/\*\s*CHECK:/g) || []).length;
        if (checkMeCount > 0) flags.push('[check-me x' + checkMeCount + ']');
        if (flags.length) _healthEntries.push({ rel: _relOf(fp), flags });
      }
      const healthBlock = limitHealth(_healthEntries, new Set(_shownFiles.map(([fp]) => _relOf(fp))), 10);

      const summary = `${best.symCount} symbol(s) across ${best.filesShown} of ${best.filesTotal} file(s)` +
        (minRefs > 0 ? `, minRefs=${minRefs}` : "") +
        `, ~${Math.round(best.text.length / 4)} tokens` +
        (_timedOut ? `, STOPPED after ${_TIME_BUDGET_MS / 1000} s: analysed ${analysed.length} of ${allFiles.length} files, narrow with glob or project` : "");

      bump('get_repo_map', 'hits');
      return {
        content: [{ type: "text", text: "// Repo map (" + _scope.label + ") â€” " + summary + "\n\n" + best.text + healthBlock }],
        symbolCount: best.symCount, fileCount: sortedFiles.length,
      };
    },
  });

  } // end SEARCH GROUP (part 2)

  // -- GHIDRA GROUP ------------------------------------------------------------
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
      `^[\\w\\s\\*]+?\\b${escapeRegex(name)}\\s*\\(`
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

  registerMcpTool({
    name:           'list-functions',
    group:          'ghidra',
    category:       'search',
    requiresEditor: true,
    title:          "List Functions",
    description: [
      "List all function definitions in the active C file with their names and line numbers.",
      "Works with Ghidra-decompiled output (FUN_xxxxxxxx style names) and standard C.",
      "Workflow hint: Use open-file first to make sure the right file is active.",
    ].join(" "),
    inputSchema: {
      includeUnnamed: z.boolean().optional(),
    },
    handler: async ({ includeUnnamed = true } = {}, ctx) => {
      const symbols = getSymbols(ctx.editor, ctx.text, ctx.editor.getPath() || '');
      const results = symbols
        .filter(s => {
          if (GHIDRA_SKIP_KW.has(s.name)) return false;
          if (!includeUnnamed && /^FUN_|^sub_|^DAT_/.test(s.name)) return false;
          return true;
        })
        .map(s => ({ line: s.startRow + 1, name: s.name, preview: s.sig }));
      bump('ghidra_list_functions', 'hits');
      if (results.length === 0)
        return { content: [{ type: "text", text: "No function definitions found." }] };
      return { content: [{ type: "text", text: JSON.stringify({ count: results.length, functions: results }, null, 2) }] };
    }
  });

  registerMcpTool({
    name:           'search-functions',
    group:          'ghidra',
    category:       'search',
    requiresEditor: true,
    title:          "Search Functions",
    description: [
      "Search for function definitions whose name matches a query string or regex.",
      "Returns name, line number, and the full signature line. regex:true is a POSIX regular expression like plain grep (BRE; extended:true for ERE like grep -E), not JavaScript. caseSensitive:false ignores case (default is case-sensitive).",
      "Useful for finding FUN_8000* or all functions containing 'crypto', 'net', etc.",
    ].join(" "),
    inputSchema: {
      query:         z.string(),
      regex:         z.boolean().optional(),
      extended:      z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
    },
    handler: async ({ query, regex = false, extended = false, caseSensitive = true }, ctx) => {
      let searchPat;
      try { searchPat = compilePattern({ query, regex, extended, caseSensitive }); }
      catch (e) { return ctx.fail('invalidRegex', e.message); }
      const symbols = getSymbols(ctx.editor, ctx.text, ctx.editor.getPath() || '');
      const results = symbols
        .filter(s => !GHIDRA_SKIP_KW.has(s.name) && searchPat.test(s.name))
        .map(s => ({ line: s.startRow + 1, name: s.name, signature: s.sig }));
      if (results.length === 0) {
        bump('ghidra_search_functions', 'fails.noMatch');
        const _caseProbe = makeCaseProbe({ query, regex, extended, caseSensitive }, { unit: 'function name' });
        if (_caseProbe) _caseProbe.feed(symbols.filter(s => !GHIDRA_SKIP_KW.has(s.name)).map(s => s.name));
        return { content: [{ type: "text", text: `No functions matching "${query}" found.` + regexHintSuffix({ query, regex, extended }) + caseNoteSuffix(_caseProbe && _caseProbe.hint()) }] };
      }
      bump('ghidra_search_functions', 'hits');
      return { content: [{ type: "text", text: JSON.stringify({ count: results.length, functions: results }, null, 2) }] };
    }
  });

  registerMcpTool({
    name:           'get-function-body',
    group:          'ghidra',
    category:       'search',
    requiresEditor: true,
    title:          "Get Function Body",
    description: [
      "Extract the complete source code of a named function from the active C file.",
      "Returns the full body from signature to closing brace with line numbers.",
      "Works with Ghidra FUN_ names and standard C function names.",
      "Use occurrence:N when the same name appears multiple times (e.g. static helpers).",
    ].join(" "),
    inputSchema: {
      name:       z.string(),
      occurrence: z.number().int().min(1).optional(),
    },
    handler: async ({ name, occurrence = 1 }, ctx) => {
      const symbols = getSymbols(ctx.editor, ctx.text, ctx.editor.getPath() || '');
      const sym     = findFunction(symbols, name, { occurrence });
      if (!sym) {
        bump('ghidra_get_function_body', 'fails.notFound');
        const hint = occurrence > 1 ? ` (occurrence ${occurrence})` : "";
        return { content: [{ type: "text", text: `Function "${name}"${hint} not found. Use list-functions to see available names.` }] };
      }
      const lines = ctx.text.split(/\r?\n/);
      const body  = lines.slice(sym.startRow, sym.endRow + 1).map((t, i) => ({ n: sym.startRow + i + 1, text: t }));
      bump('ghidra_get_function_body', 'hits');
      return {
        content: [{ type: "text", text: JSON.stringify({
          name, startLine: sym.startRow + 1, endLine: sym.endRow + 1,
          lineCount: sym.endRow - sym.startRow + 1, body
        }, null, 2) }]
      };
    }
  });

  registerMcpTool({
    name:           'get-xrefs',
    group:          'ghidra',
    category:       'search',
    requiresEditor: true,
    title:          "Get Cross References",
    description: [
      "Find every call site of a named function in the active C file.",
      "Returns line numbers and the full calling line for each reference.",
      "Essential for understanding control flow in decompiled binaries.",
    ].join(" "),
    inputSchema: { name: z.string() },
    handler: async ({ name }, ctx) => {
      const lines = ctx.allLines;
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
    }
  });

  registerMcpTool({
    name:           'add-comment',
    group:          'ghidra',
    category:       'edit',
    requiresEditor: true,
    title:          "Add Comment",
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
    },
    handler: async ({ comment, functionName, lineNumber, occurrence = 1 }, ctx) => {
      /* Gate style checker off for Ghidra files â€” decompiled pseudocode violates every rule */
      const filePath = ctx.editor.getPath();
      const curTool = 'add-comment';

      let targetRow = -1;

      if (functionName) {
        targetRow = ghidraFindFn(ctx.allLines, functionName, occurrence);
        if (targetRow === -1) {
          bump('ghidra_add_comment', 'fails.notFound');
          const hint = occurrence > 1 ? ` (occurrence ${occurrence})` : "";
          return { content: [{ type: "text", text: `Function "${functionName}"${hint} not found. Use list-functions to see available names.` }] };
        }
      } else if (lineNumber != null) {
        targetRow = lineNumber - 1;
        if (targetRow < 0 || targetRow >= ctx.allLines.length)
          throw new Error(`lineNumber ${lineNumber} is out of range (1-${ctx.allLines.length})`);
      } else {
        throw new Error("Provide either functionName or lineNumber.");
      }

      const indent = (ctx.allLines[targetRow].match(/^(\s*)/) || ["", ""])[1];
      const commentLines = comment.split(/\r?\n/);
      const block = commentLines.length === 1
        ? `${indent}/* ${comment} */\n`
        : `${indent}/*\n` + commentLines.map(l => `${indent} * ${l}`).join("\n") + `\n${indent} */\n`;

      ctx.buffer.insert([targetRow, 0], block);

      /* Only run style check on non-Ghidra C/H files */
      let styleSuffix = "";
      if (!isGhidraFile(filePath, ctx.text) && isCodeFilePath(filePath)) {
        styleSuffix = applyStyleCheck(block, filePath) || "";
      }

      bump('ghidra_add_comment', 'hits');
      return {
        ...(await buildEditResponse(
          { tool: curTool, line: targetRow + 1, linesChanged: commentLines.length + 1, scopeLabel: functionName ? ` (function "${functionName}")` : '', buffer: ctx.buffer },
          { style: styleSuffix }
        )),
      };
    }
  });

  registerMcpTool({
    name:           'get-function-list-with-comments',
    group:          'ghidra',
    category:       'search',
    requiresEditor: true,
    title:          "Get Function List With Comments",
    description: [
      "List all functions with any existing comments above them.",
      "Shows reverse engineering progress at a glance â€”",
      "annotated functions vs unnamed FUN_ stubs.",
    ].join(" "),
    inputSchema: {},
    handler: async (_args, ctx) => {
      const lines = ctx.allLines;
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
    }
  });

  } // end GHIDRA GROUP

  // -- HIGHLIGHT GROUP -------------------------------------------------------
  if (g('highlight')) {
  registerMcpTool({
    name:           'highlight-range',
    group:          'highlight',
    category:       'command',
    requiresEditor: true,
    title:          'Highlight Range',
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
    },
    handler: async ({ startLine, endLine, ttlMs = 8000, clear = false } = {}, ctx) => {
      const editor = ctx.editor;

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
  });
  } // end HIGHLIGHT GROUP

  // -- DISCOVERY TOOLS (always on) -------------------------------------------
  registerMcpTool({
    name:           'list-tools',
    group:          'core',
    category:       'command',
    requiresEditor: false,
    title:          'List Tools',
    description: [
      "List every tool available in this MCP server with its group and enabled/disabled status.",
      "Call this at the start of a session to understand what's available.",
      "Disabled tools can be enabled at runtime with enable-group â€” no Pulsar reload needed.",
      "Returns a summary of which groups are on/off so you can request what you need."
    ].join(" "),
    inputSchema: {},
    handler: async () => {
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
  });

  registerMcpTool({
    name:           'enable-group',
    group:          'core',
    category:       'command',
    requiresEditor: false,
    title:          'Enable Group',
    description: [
      "Enable a disabled tool group at runtime â€” tools become available immediately without reloading Pulsar.",
      "Use list-tools first to see which groups are disabled.",
      "Note: disabling a group requires a Pulsar reload; enabling is always instant.",
      "Also updates the saved config so the group stays enabled after restart."
    ].join(" "),
    inputSchema: {
      group: z.enum([...TOGGLEABLE_GROUPS])
    },
    handler: async ({ group }) => {
      const currentGroups = atom.config.get('pulsar-edit-mcp-server.toolGroups') || {};

      if (currentGroups[group] !== false) {
        return { content: [{ type: "text", text: `Group '${group}' is already enabled.` }] };
      }

      // Update config so it persists after restart
      atom.config.set('pulsar-edit-mcp-server.toolGroups', { ...currentGroups, [group]: true });

      // Run the registration again with the saved settings: tools that are already registered are skipped,
      // so only the newly enabled group's tools are added.
      mcpRegistration(server, linterRegistry, getMessages, { ...currentGroups, [group]: true }, chatPanel, getCommandTerminalPanel);

      const toolsInGroup = TOOL_CATALOGUE.filter(t => t.group === group);
      return {
        content: [{ type: "text", text: `Group '${group}' enabled. ${toolsInGroup.length} tool(s) now available: ${toolsInGroup.map(t => t.name).join(", ")}` }],
        group, toolsEnabled: toolsInGroup.map(t => t.name)
      };
    }
  });
  // -- DEBUGGING GROUP --------------------------------------------------------
  { // each tool in this block is gated by its catalogue group in server.registerTool above
  registerMcpTool({
    name: "get-debug-log",
    group: "debugging",
    category: "command",
    requiresEditor: false,
    title: "Get Debug Log",
    description: [
      "Return recent debug log entries captured from MCP tool calls.",
      "Use tail to limit output (default 20, max 100) â€” keeps token cost low.",
      "Use filter to show only entries matching a keyword or tool name (e.g. 'apply-patch', 'FAIL').",
      "Use clear:true to wipe the buffer after reading.",
      "Entries are timestamped HH:MM:SS.mmm and include tool name, event, and data."
    ].join(" "),
    inputSchema: {
      tail:   z.number().int().min(1).max(100).optional(),
      filter: z.string().optional(),
      clear:  z.boolean().optional()
    },
    async handler({ tail = 20, filter, clear = false }) {
      dbg("get-debug-log", "ARGS", { tail, filter, clear });

      let entries = [...debugLog];

      if (filter) {
        const lc = filter.toLowerCase();
        entries = entries.filter(e => e.toLowerCase().includes(lc));
      }

      // Take the last `tail` entries
      if (entries.length > tail) entries = entries.slice(-tail);

      if (clear) {
        debugLog.length = 0;
        dbg("get-debug-log", "buffer cleared");
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
  });

  registerMcpTool({
    name: "get-failure-log",
    group: "debugging",
    category: "command",
    requiresEditor: false,
    title: "Get Failure Log",
    description: [
      "Query the persistent fault log (session/session-faults.ndjson) â€” a structured record of every tool failure written to disk.",
      "Each entry includes: ts (ISO timestamp), tool, reason, filePath, nearLine, and other context.",
      "Use tail to limit output (default 20). Filter by tool name (e.g. 'replace') or reason (e.g. 'noMatch', 'ambiguous').",
      "Returns structured JSON entries so you can identify failure patterns without needing PowerShell."
    ].join(" "),
    inputSchema: {
      tail:     z.number().int().min(1).max(200).optional(),
      tool:     z.string().optional(),
      reason:   z.string().optional(),
      filePath: z.string().optional()
    },
    async handler({ tail = 20, tool, reason, filePath: fpFilter }) {
      dbg("get-failure-log", "ARGS", { tail, tool, reason, fpFilter });

      if (!FAILURE_LOG_PATH) {
        return { content: [{ type: "text", text: "(failure log path unavailable)" }] };
      }

      let raw;
      try {
        raw = fs.readFileSync(FAILURE_LOG_PATH, 'utf8');
      } catch (_) {
        return { content: [{ type: "text", text: "(session/session-faults.ndjson not found â€” no failures recorded yet)" }] };
      }

      let entries = raw.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch (_) { return null; }
      }).filter(Boolean);

      if (tool)     entries = entries.filter(e => e.tool     && e.tool.includes(tool));
      if (reason)   entries = entries.filter(e => e.reason   && e.reason.includes(reason));
      if (fpFilter) entries = entries.filter(e => e.filePath && e.filePath.includes(fpFilter));

      const total = entries.length;
      if (entries.length > tail) entries = entries.slice(-tail);

      return {
        content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
        returned: entries.length,
        total
      };
    }
  });

  registerMcpTool({
    name: "get-edit-stats",
    group: "debugging",
    category: "command",
    requiresEditor: false,
    title: "Get Edit Stats",
    description: [
      "Per-tool edit statistics: hits, fail/miss reasons (a search miss is not a failure), hint usage and dry runs; replace also reports fuzzyWhitespaceCommits and avgOldStrLines. Summaries: sessionEditSummary / lifetimeEditSummary and sessionSearchSummary / lifetimeSearchSummary.",
      "COMPACT by default: this session only (since the last server restart), with zero counters and idle tools left out. scope:'lifetime' or 'both' adds the lifetime totals (kept on disk, they survive restarts and already include the session); tool:'<name>' returns one tool's block (hyphen or underscore name, e.g. 'replace-all'); full:true keeps every zero counter and tool (about 13,000 tokens: avoid). reset:true flushes the session into lifetime and zeroes the session counters."
    ].join(" "),
    inputSchema: {
      reset: z.boolean().optional(),
      scope: z.enum(["session", "lifetime", "both"]).optional(), // default 'session' (compact output, 2026-11-17)
      tool:  z.string().optional(),                                // one tool's block, hyphen or underscore name
      full:  z.boolean().optional()                                // true = keep every zero counter (the old, very large output)
    },
    async handler({ reset = false, scope = "session", tool: statsTool, full = false }) {
      dbg("get-edit-stats", "ARGS", { reset, scope, tool: statsTool, full });

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
      // 2026-11-17: compact by default (session only, no zero counters); see shapeStatsReport in lib/edit-stats.js.
      // Computed BEFORE the reset below, so a reset still returns the numbers it is about to zero.
      const shaped = shapeStatsReport(report, { scope, tool: statsTool, full });

      if (reset) {
        // Bump session count before zeroing
        lifetimeStats.sessionCount = (lifetimeStats.sessionCount || 0) + 1;
        flushLifetimeStats();
        dbg("get-edit-stats", `session reset, lifetime sessionCount now ${lifetimeStats.sessionCount}`);

        // Append one-line summary to session/session-history.ndjson
        const _sh = summarise(editStats);
        appendSessionHistory({
          ts:        new Date().toISOString(),
          session:   lifetimeStats.sessionCount,
          edits:     _sh.editTotal,
          hits:      _sh.editHits,
          faults:    _sh.editFaults,
          misses:    _sh.editMisses,
          hitRate:   _sh.editTotal > 0 ? Math.round((_sh.editHits / _sh.editTotal) * 100) / 100 : 1,
          searches:  _sh.searchTotal,
          searchHits: _sh.searchHits,
        });

        // Zero session counters and shadow
        // Zero all tools generically â€” self-maintaining, no manual update needed when tools are added
        for (const [, val] of Object.entries(editStats)) {
          if (typeof val !== 'object' || val === null) continue;
          if (typeof val.hits === 'number')                   val.hits = 0;
          if (typeof val.dryRuns === 'number')                val.dryRuns = 0;
          if (typeof val.largeEditWarnings === 'number')      val.largeEditWarnings = 0;
          if (typeof val.fuzzyWhitespaceCommits    === 'number') val.fuzzyWhitespaceCommits    = 0;
          if (typeof val.fuzzyContentCommits        === 'number') val.fuzzyContentCommits        = 0;
          if (typeof val.autoStripCommentCommits    === 'number') val.autoStripCommentCommits    = 0;
          if (typeof val._oldStrLenSum === 'number')              val._oldStrLenSum = 0;
          if (val.fails)     Object.keys(val.fails).forEach(k     => val.fails[k]     = 0);
          if (val.hintsUsed) Object.keys(val.hintsUsed).forEach(k => val.hintsUsed[k] = 0);
        }

        // Reset shadow so deltas start from 0 again
        resetLastSynced();

        // Zero session style stats
        styleStats._totalCHEdits       = 0;
        styleStats._cleanEdits         = 0;
        styleStats._totalViolations    = 0;
        styleStats._checkpatchRuns     = 0;
        styleStats._checkpatchViolations = 0;
        // Zero all per-rule style counters â€” self-maintaining, picks up new rules automatically
        Object.keys(styleStats).forEach(k => {
          if (styleStats[k] && typeof styleStats[k].introduced === 'number') {
            styleStats[k].introduced = 0;
          }
        });
      }

      if (reset) shaped.reset = { sessionCount: lifetimeStats.sessionCount };
      // One compact text result. The old handler pretty-printed the full report AND spread it into the result object, so it
      // went back twice.
      return {
        content: [{ type: "text", text: JSON.stringify(shaped) }]
      };
    }
  });
  // -- session-notes ----------------------------------------------------------
  // One notes file per project folder (2026-11-05): <session dir>/notes/<folder name>.ndjson, see
  // lib/session-notes-store.js. The old single file session-notes.ndjson is split into those files on the
  // first call and kept as session-notes.ndjson.migrated.
  const sessionBaseDir = SESSION_DIR || path.join(atom.packages.getLoadedPackage('pulsar-edit-mcp-server').path, 'session');
  const notesDir = path.join(sessionBaseDir, 'notes');
  const legacyNotesPath = path.join(sessionBaseDir, 'session-notes.ndjson');

  registerMcpTool({
    name: "session-notes",
    group: "debugging",
    category: "command",
    requiresEditor: false,
    title: "Session Notes",
    description: [
      "Persistent cross-session notes, one NDJSON file per project folder (notes/<folder name>.ndjson).",
      "action:'read' (call it with no project at the start of a session) reads the CURRENT project (the open root holding the active file, else the first root) and ends with an index of other projects that have notes; project:'name' reads another, project:'all' every project; tail:N = last N records per project. Output is grouped by title with [index] tags (indexes are per project).",
      "action:'write' appends a note to the current project (or project:'name'): what failed, what worked, lessons; first line = title, an optional ## line = section. action:'edit' (explicit project, index 0-based, note) replaces a note in place and keeps its timestamp. action:'delete' (explicit project, index) removes a record. action:'clear' (explicit project; 'all' is refused) wipes one project. Write a note before ending a session where edits were made."
    ].join(" "),
    inputSchema: {
      action:  z.enum(["read", "write", "edit", "delete", "clear"]),
      note:    z.string().optional(),                          // required for write/edit
      project: z.string().optional(),                          // project folder name; 'all' only for read
      tail:    z.number().int().min(1).max(100).optional(),    // read: last N entries per project
      index:   z.number().int().min(0).optional(),             // edit/delete: 0-based note index (per project)
    },
    async handler({ action, note, project, tail, index }) {
      dbg("session-notes", "ARGS", { action, project, tail, index, noteLen: note?.length });
      const say = (text, extra) => ({ content: [{ type: "text", text }], ...(extra || {}) });

      // One-off split of the old single notes file (a cheap no-op once it is gone).
      let migratedNote = '';
      try {
        const m = await notesStore.migrateLegacy({
          legacyPath: legacyNotesPath,
          dir: notesDir,
          unlabeledProject: path.basename(atom.packages.getLoadedPackage('pulsar-edit-mcp-server').path),
        });
        if (m.status === 'migrated' && m.total > 0) {
          const split = Object.keys(m.perProject).map(k => k + ' ' + m.perProject[k]).join(', ');
          migratedNote = '\n\n(Migrated ' + m.total + ' existing note(s) into per-project files: ' + split + '. The old file was kept as session-notes.ndjson.migrated.)';
        }
      } catch (e) {
        dbg("session-notes", "migration failed", e && e.message);
        migratedNote = '\n\n(WARNING: splitting the old notes file failed: ' + (e && e.message) + '. It was left untouched.)';
      }

      const activeEditor = atom.workspace.getActiveTextEditor();
      const resolved = await notesStore.resolveProject({
        requested: project,
        action,
        dir: notesDir,
        roots: atom.project.getPaths(),
        activeFile: activeEditor && activeEditor.getPath ? activeEditor.getPath() : null,
      });
      if (resolved.error) return say("\u26A0 " + resolved.error + migratedNote);

      if (action === "read") {
        const others = await notesStore.listProjects(notesDir);
        if (resolved.all) {
          const items = [];
          let count = 0;
          for (const p of others) {
            const loaded = await notesStore.load(notesDir, p.project);
            items.push({ project: p.project, records: loaded.records, bad: loaded.bad });
            count += tail ? Math.min(tail, loaded.records.length) : loaded.records.length;
          }
          return say(notesStore.formatAll(items, { tail }) + migratedNote, { count });
        }
        const { records, bad } = await notesStore.load(notesDir, resolved.project);
        const text = notesStore.formatNotes(resolved.project, records, { tail, bad })
          + notesStore.formatOthers(others, resolved.project) + migratedNote;
        return say(text, { count: tail ? Math.min(tail, records.length) : records.length, project: resolved.project });
      }

      if (action === "write") {
        if (!note || !note.trim()) return say("\u26A0 note is required for action:write.");
        const parsed = notesStore.parseNoteStr(note);
        const entry = {
          ts:      new Date().toISOString(),
          project: resolved.project,
          title:   parsed.title,
          section: parsed.section,
          items:   parsed.items
        };
        await notesStore.append(notesDir, resolved.project, entry);
        const { records } = await notesStore.load(notesDir, resolved.project);
        dbg("session-notes", "note written", { project: resolved.project, ts: entry.ts });
        return say("\u2705 Note saved to project \"" + resolved.project + "\". Total notes there: " + records.length + "." + migratedNote,
          { totalNotes: records.length, project: resolved.project });
      }

      if (action === "edit") {
        if (index === undefined || index === null) return say("\u26A0 index is required for action:edit.");
        if (!note || !note.trim()) return say("\u26A0 note (new text) is required for action:edit.");
        const { records, bad } = await notesStore.load(notesDir, resolved.project);
        if (bad > 0) {
          return say("\u26A0 Project \"" + resolved.project + "\" has " + bad + " unreadable line(s) in its notes file; edit is refused until they are fixed by hand (rewriting the file would drop them).");
        }
        if (index < 0 || index >= records.length) {
          return say("\u26A0 index " + index + " out of range for project \"" + resolved.project + "\". Total notes there: " + records.length + ".");
        }
        const parsed = notesStore.parseNoteStr(note);
        records[index].title   = parsed.title;
        records[index].section = parsed.section;
        records[index].items   = parsed.items;
        records[index].edited  = new Date().toISOString();  // the original ts is kept
        await notesStore.save(notesDir, resolved.project, records);
        dbg("session-notes", "note edited", { project: resolved.project, index });
        return say("\u2705 Note [" + index + "] of project \"" + resolved.project + "\" updated. Total notes there: " + records.length + ".",
          { totalNotes: records.length, project: resolved.project });
      }

      if (action === "delete") {
        if (index === undefined || index === null) return say("\u26A0 index is required for action:delete.");
        const { records, bad } = await notesStore.load(notesDir, resolved.project);
        if (bad > 0) {
          return say("\u26A0 Project \"" + resolved.project + "\" has " + bad + " unreadable line(s) in its notes file; delete is refused until they are fixed by hand (rewriting the file would drop them).");
        }
        if (index < 0 || index >= records.length) {
          return say("\u26A0 index " + index + " out of range for project \"" + resolved.project + "\". Total notes there: " + records.length + ".");
        }
        const removed = records.splice(index, 1)[0];
        await notesStore.save(notesDir, resolved.project, records);
        dbg("session-notes", "note deleted", { project: resolved.project, index, ts: removed.ts });
        return say("\u2705 Note [" + index + "] of project \"" + resolved.project + "\" deleted (was: " + (removed.ts || removed['timestamp'] || '?') + "). Total notes there: " + records.length + ".",
          { totalNotes: records.length, project: resolved.project });
      }

      if (action === "clear") {
        await notesStore.save(notesDir, resolved.project, []);
        dbg("session-notes", "notes cleared", { project: resolved.project });
        return say("\u2705 Cleared the notes of project \"" + resolved.project + "\".");
      }
    }
  });

  } // end debugging group

  // -- checkpatch --------------------------------------------------------------
  registerMcpTool({
    name: "checkpatch",
    group: "kernelC",
    category: "command",
    requiresEditor: false,
    title: "Checkpatch",
    description: [
      "Run Linux kernel coding style checks against a .c or .h file.",
      "Operates on the full file content â€” use this to audit an existing file,",
      "not just the lines being edited.",
      "Returns all violations grouped by rule with 1-based line numbers.",
      "Prints a summary line: N violations across M rules.",
      "Silent (clean) if no violations found.",
    ].join("\n"),
    inputSchema: {
      ...FILE_SCHEMA,
    },
    async handler({ filePath }) {
      try {
        // Resolve the file path
        let targetPath = filePath;
        if (!isKernelFile(targetPath)) {
          return { content: [{ type: "text", text: `âš âš  ${path.basename(targetPath)} is not a .c/.h file â€” skipping style check.` }] };
        }

        // Read the file content â€” use live buffer if open, fall back to disk
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
        dbg("checkpatch", `${totalViolations} violations in ${path.basename(targetPath)}`);

        if (totalViolations === 0) {
          return { content: [{ type: "text", text: `âœ… ${path.basename(targetPath)}: no style violations found.` }] };
        }

        // Group by rule
        const byRule = {};
        for (const v of violations) {
          if (!byRule[v.type]) byRule[v.type] = [];
          byRule[v.type].push(v);
        }

        const lines = [`âš âš  ${path.basename(targetPath)}: ${totalViolations} violation(s) across ${Object.keys(byRule).length} rule(s)\n`];
        for (const [rule, vs] of Object.entries(byRule).sort((a, b) => b[1].length - a[1].length)) {
          const ruleName = rule.replace(/_/g, ' ');
          lines.push(`  ${ruleName} (${vs.length}):`);
          for (const v of vs.slice(0, 20)) {  // cap at 20 per rule to avoid huge output
            lines.push(`    L${v.line}:${v.col}  ${v.message}`);
          }
          if (vs.length > 20) lines.push(`    ... and ${vs.length - 20} more`);
        }

        dbg("checkpatch", `${totalViolations} violations in ${path.basename(targetPath)}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `âŒ checkpatch error: ${err.message}` }] };
      }
    }
  });


  // -------------------------------------------------------------------------
  // check-struct -- structural integrity snapshot (absolute, not delta)
  // -------------------------------------------------------------------------
  registerMcpTool({
    name: "check-struct",
    group: "kernelC",
    category: "command",
    requiresEditor: false,
    title: "Check Struct",
    description: [
      "Snapshot the structural integrity of any brace-delimited source file.",
      "Works on .c .h .js .ts .cpp .java .go .rs .css .scss and more.",
      "Reports absolute brace balance, unclosed block comments, and #if/#endif depth.",
      "Unlike the edit-response struct check (which fires on delta only),",
      "this is a point-in-time absolute read -- use it to audit a file",
      "for pre-existing imbalances without making an edit.",
      "RESPONSE FORMAT: one line per metric. Clean files get a single checkmark line.",
      "Imbalanced files get a warning per metric with the net count.",
    ].join("\n"),
    inputSchema: {
      ...FILE_SCHEMA,
    },
    async handler({ filePath }) {
      try {
        bump("check_struct", "hits");

        let targetPath = filePath;
        const STRUCT_EXTENSIONS = /\.(c|h|cpp|hpp|cc|cxx|js|ts|jsx|tsx|css|scss|java|cs|go|rs|swift)$/i;
        if (!STRUCT_EXTENSIONS.test(targetPath)) {
          return { content: [{ type: "text", text: "\u26a0\ufe0f " + path.basename(targetPath) + " -- check-struct skipped (not a brace-delimited source file)." }] };
        }

        // Read live buffer if open, else read from disk
        let text;
        const openEditor = atom.workspace.getTextEditors()
          .find(e => e.getPath() && path.resolve(e.getPath()) === path.resolve(targetPath));
        if (openEditor) {
          text = openEditor.getText();
        } else {
          text = await fs.promises.readFile(targetPath, "utf8");
        }

        const snap = structSnapshot(text);
        const fname = path.basename(targetPath);
        const issues = [];

        if (snap.braces !== 0) {
          const dir = snap.braces > 0 ? "opening" : "closing";
          issues.push("  \u26a0\ufe0f  braces:   unmatched " + dir + " brace (net " + (snap.braces > 0 ? "+" : "") + snap.braces + " { })");
        }
        if (snap.comments !== 0) {
          issues.push("  \u26a0\ufe0f  comments: " + snap.comments + " unclosed block comment" + (snap.comments > 1 ? "s" : "") + " (/* without */)");
        }
        if (snap.ifdepth !== 0) {
          const dir = snap.ifdepth > 0 ? "unclosed #if" : "extra #endif";
          issues.push("  \u26a0\ufe0f  ifdepth:  " + dir + " (depth " + (snap.ifdepth > 0 ? "+" : "") + snap.ifdepth + ")");
        }

        if (issues.length === 0) {
          return { content: [{ type: "text", text: "\u2705 " + fname + ": struct clean (braces balanced, no unclosed comments, #if depth 0)" }] };
        }

        const lines = ["\u274c " + fname + ": " + issues.length + " structural issue" + (issues.length > 1 ? "s" : "") + " found\n"];
        lines.push(...issues);
        lines.push("\nbraces=" + snap.braces + "  comments=" + snap.comments + "  ifdepth=" + snap.ifdepth);
        return { content: [{ type: "text", text: lines.join("\n") }] };

      } catch (err) {
        return { content: [{ type: "text", text: "\u274c check-struct error: " + err.message }] };
      }
    }
  });



  // -------------------------------------------------------------------------
  // namingcheck â€” check kernel C file for naming violations
  // -------------------------------------------------------------------------
  registerMcpTool({
    name: "namingcheck",
    group: "kernelC",
    category: "command",
    requiresEditor: false,
    title: "Naming Check",
    description: [
      "Check a kernel C file for naming convention violations.",
      "Checks: function names start with a recognised verb tier (get_, set_, init_, handle_, â€”),",
      "no camelCase in function or variable names, macro names are ALL_CAPS.",
      "Kernel .c/.h files only â€” returns a gating message for other file types."
    ].join(" "),
    inputSchema: { ...FILE_SCHEMA },
    async handler({ filePath }) {
      const curStats = editStats["namingcheck"] || (editStats["namingcheck"] = { hits: 0, fails: { notKernel: 0 }, misses: { clean: 0 } });
      const targetPath = filePath;
      if (!isKernelFile(targetPath)) {
        curStats.fails.notKernel++;
        return { content: [{ type: "text", text: `âš âš  namingcheck: not a kernel C file (${path.basename(targetPath)}) â€” skipped.` }] };
      }
      let text, staleWarning;
      try { ({ text, staleWarning } = await readTextFromFile(targetPath)); }
      catch (err) { return { content: [{ type: "text", text: `âŒ Cannot read file: ${err.message}` }] }; }

      const { violations, totalViolations } = checkNaming(text, targetPath);
      if (totalViolations === 0) {
        curStats.misses.clean++;
        curStats.hits++;
        return buildSearchResponse({ staleWarning, body: `âœ… namingcheck: no violations in ${path.basename(targetPath)}.` });
      }
      curStats.hits++;
      const report = formatNamingViolations(violations);
      return { ...buildSearchResponse({ staleWarning, body: report }), totalViolations };
    }
  });

  // -------------------------------------------------------------------------
  // check-function-docs â€” check every non-static fn has a kernel-style doc
  // -------------------------------------------------------------------------
  registerMcpTool({
    name: "check-function-docs",
    group: "kernelC",
    category: "command",
    requiresEditor: false,
    title: "Check Function Docs",
    description: [
      "Check that every non-static function in a kernel C file has a kernel-doc /** */ comment above it.",
      "Reports three severity tiers: missing (no comment at all), wrongStyle (// single-line above fn â€” always wrong),",
      "plainDoc (plain /* */ present â€” not a style error but not extracted by the kernel-doc tool; advisory for exported/public fns).",
      "The correct kernel-doc format is /** with function_name() - desc, @arg:, Context:, Return: sections.",
      "Kernel .c/.h files only."
    ].join(" "),
    inputSchema: { ...FILE_SCHEMA },
    async handler({ filePath }) {
      const curStats = editStats["check-function-docs"] || (editStats["check-function-docs"] = { hits: 0, fails: { notKernel: 0 }, misses: { allGood: 0 } });
      const targetPath = filePath;
      if (!isKernelFile(targetPath)) {
        curStats.fails.notKernel++;
        return { content: [{ type: "text", text: `âš âš  check-function-docs: not a kernel C file (${path.basename(targetPath)}) â€” skipped.` }] };
      }
      let text, staleWarning;
      try { ({ text, staleWarning } = await readTextFromFile(targetPath)); }
      catch (err) { return { content: [{ type: "text", text: `âŒ Cannot read file: ${err.message}` }] }; }

      // Try to load corresponding header for inHeader detection
      let headerText = null;
      try {
        const headerPath = targetPath.replace(/\.c$/, '.h');
        if (headerPath !== targetPath && require('fs').existsSync(headerPath)) {
          headerText = require('fs').readFileSync(headerPath, 'utf8');
        }
      } catch {}

      const { missing, wrongStyle, plainDoc } = checkFunctionDocs(text, targetPath, headerText);
      if (missing.length === 0 && wrongStyle.length === 0 && plainDoc.length === 0) {
        curStats.misses.allGood++;
        curStats.hits++;
        return buildSearchResponse({ staleWarning, body: `âœ… check-function-docs: all non-static functions documented in ${path.basename(targetPath)}.` });
      }
      curStats.hits++;
      const lines = [`âš âš  function docs report â€” ${path.basename(targetPath)}`];
      if (missing.length > 0) {
        lines.push(`\nMissing doc (${missing.length}):`);
        for (const f of missing) {
          const tag = f.inHeader ? ' [in header]' : '';
          lines.push(`  L${f.line}: ${f.name}()${tag}`);
          lines.push(`    sig: ${f.signature.trim()}`);
        }
      }
      if (wrongStyle.length > 0) {
        lines.push(`\nWrong style (${wrongStyle.length}):`);
        for (const f of wrongStyle) {
          const tag = f.inHeader ? ' [in header]' : '';
          lines.push(`  L${f.line}: ${f.name}()${tag} â€” found: ${f.found}`);
          lines.push(`    sig: ${f.signature.trim()}`);
        }
      }
      if (plainDoc.length > 0) {
        lines.push(`\nPlain /* */ â€” advisory (${plainDoc.length}):`);
        for (const f of plainDoc) {
          const tag = f.inHeader ? ' [in header]' : '';
          lines.push(`  L${f.line}: ${f.name}()${tag}`);
        }
      }
      return { ...buildSearchResponse({ staleWarning, body: lines.join("\n") }), missingCount: missing.length, wrongStyleCount: wrongStyle.length, plainDocCount: plainDoc.length };
    }
  });

  // -------------------------------------------------------------------------
  // insert-function-doc â€” insert kernel /* */ skeleton above a named function
  // -------------------------------------------------------------------------
  // B24 migration (2026-09-11): moved off hand-rolled atom.workspace.getActiveTextEditor()
  // onto the shared registerMcpTool framework + match-engine.js resolveScope/buildFailResponse,
  // same pattern as insert (T2) and replace's decision ladder. Gains: filePath support
  // (works on any file, no open-file-first requirement), tree-sitter inFunction resolution
  // with proper ambiguity handling (multiple functions with the same name across the file),
  // consistent âŒ/âš ï¸ diagnostics via buildFailResponse, and consecutive-failure tracking.
  if (g('edit')) registerMcpTool({
    name: "insert-function-doc",
    group: "edit",
    category: "edit",
    features: { consecutiveFailureCounter: true },
    title: "Insert Function Doc",
    description: [
      "Insert a kernel-doc /** */ skeleton above a named function in the file at `filePath` (required).",
      "Skeleton includes: function_name() - desc, @param:, Context:, Return: sections.",
      "Parses parameter names from the signature; handles variadic @... args.",
      "Does NOT overwrite an existing comment â€” aborts if a comment is already present.",
      "Kernel .c/.h files only.",
      "functionName: name of the function to document (required). Resolved via the same tree-sitter symbol lookup as replace's inFunction â€” if the name is ambiguous (appears more than once), pass line to disambiguate.",
      "line: 1-based line number of the function definition â€” use the value from check-function-docs output to disambiguate when functionName isn't unique (optional; falls back to a file-wide symbol lookup).",
    ].join(" "),
    inputSchema: {
      ...FILE_SCHEMA,
      functionName: z.string(),
      line: z.number().int().optional(),
    },
    handler: async ({ functionName, line: hintLine }, ctx) => {
      const { editor, buffer, allLines } = ctx;
      const curTool = 'insert-function-doc';
      const targetPath = ctx.filePath;

      if (!isKernelFile(targetPath)) {
        bump(curTool, 'fails.notKernel');
        return { content: [{ type: "text", text: `âš ï¸ insert-function-doc: not a kernel C file â€” skipped.` }] };
      }

      // Resolve the function via the shared match-engine scope resolver â€” same
      // inFunction path replace/insert use, so ambiguity (multiple functions
      // with this name) is handled consistently instead of the old ad-hoc
      // findFunction/nearLine heuristic.
      //
      // [B64] resolveScope's inFunction branch disambiguates ambiguous matches
      // via `occurrence` (a 1-based index), NOT `afterLine` -- afterLine only
      // takes effect for the afterLine/beforeLine hint branches, which are
      // mutually exclusive with inFunction in the decision ladder (inFunction
      // is checked first and returns before afterLine is ever consulted). This
      // tool's own `line` param was being passed through as afterLine and
      // silently doing nothing whenever functionName was ambiguous -- the
      // resulting error message even told the caller to use occurrence:N, a
      // parameter this tool doesn't expose. Fixed by resolving inFunction
      // WITHOUT afterLine first; if that comes back ambiguous and hintLine was
      // given, find which candidate match's startRow is closest to hintLine
      //
      // [B64 follow-on, simplified 2026-09-17] resolveScope's ambiguous branch
      // used to only honor occurrence when occurrence > 1 (occurrence:1 was
      // indistinguishable from "not specified" and always fell through to the
      // ambiguous error, even though occurrence:1 legitimately means "the
      // first match"). That bug is now fixed at the source (buffer-helpers.js
      // / match-engine.js â€” omitted occurrence means "no preference, warn if
      // ambiguous"; any explicit occurrence including 1 resolves directly).
      // The bestIdx===0 bypass this comment used to describe is no longer
      // needed â€” a plain resolveScope call with occurrence:bestIdx+1 now
      // works uniformly for every bestIdx, including 0.
      let scope = resolveScope({
        editor, buffer, allLines, text: ctx.text, filePath: targetPath,
        params: { inFunction: functionName },
      });
      if (scope.error && scope.error.kind === 'ambiguous' && hintLine != null) {
        const matches = scope.error.raw && scope.error.raw.matches;
        if (matches && matches.length > 0) {
          const targetRow = hintLine - 1;
          let bestIdx = 0, bestDist = Infinity;
          matches.forEach((m, idx) => {
            const dist = Math.abs(m.startRow - targetRow);
            if (dist < bestDist) { bestDist = dist; bestIdx = idx; }
          });
          scope = resolveScope({
            editor, buffer, allLines, text: ctx.text, filePath: targetPath,
            params: { inFunction: functionName, occurrence: bestIdx + 1 },
          });
        }
      }
      if (scope.error) {
        ctx.consec.count++;
        bump(curTool, 'fails.notFound');
        const fail = buildFailResponse({ tool: curTool, ctx: { consec: ctx.consec, allLines, text: ctx.text }, scope, needle: functionName, isCodeFile: true });
        return { ...fail, inserted: false };
      }

      const fnLine = scope.anchorRow;
      const fnSignature = allLines[fnLine] || '';

      /* Check if a comment already exists above â€” via the SAME checkFunctionDocs()
       * logic check-function-docs uses, not a standalone heuristic. The old version
       * here just looked at the nearest non-blank line above and asked "does it look
       * like a comment" (ends with '*/' or starts with '/*') â€” that misfires on a
       * section banner (e.g. "/* ---- Wi-Fi ---- *\/") sitting a line or two above the
       * function with a blank line in between: banners read as "already documented"
       * even though check-function-docs correctly reports the function as missing a
       * doc. checkFunctionDocs() already traces back to the comment's opener and
       * distinguishes /** kernel-doc (real), plain /* *\/ (plainDoc, advisory but
       * still "present"), and single-line /* ---- *\/ banners (correctly treated as
       * missing) â€” reusing it here keeps insert-function-doc and check-function-docs
       * in agreement instead of drifting apart. */
      const { missing: _missing, wrongStyle: _wrongStyle, plainDoc: _plainDoc } = checkFunctionDocs(ctx.text, targetPath, null);
      const targetLine1 = fnLine + 1; /* checkFunctionDocs reports 1-based line */
      const alreadyDocumented = _wrongStyle.some(f => f.line === targetLine1) || _plainDoc.some(f => f.line === targetLine1);
      if (alreadyDocumented) {
        ctx.consec.count = 0;
        return { content: [{ type: "text", text: `âš ï¸ insert-function-doc: '${functionName}' already has a comment above it â€” not overwriting.` }] };
      }

      const skeleton = buildDocSkeleton(fnSignature);
      const insertRow = fnLine; /* insert before this row */
      buffer.insert([insertRow, 0], skeleton);
      ctx.consec.count = 0;
      bump(curTool, 'hits');
      return {
        ...(await buildEditResponse({ tool: curTool, line: insertRow + 1, linesChanged: skeleton.split('\n').length - 1, scopeLabel: ` above '${functionName}'`, buffer })),
        insertedAt: fnLine + 1,
      };
    }
  });

} // end mcpRegistration


// Named function reference so deactivate() can remove it and prevent listener
// accumulation across hot-reloads. Without removal, every module evaluation
// stacks another beforeunload listener; on window reload all of them fire and
// the last-to-run instance (possibly with lower counts) wins the disk write.
// Using synchronous writeFileSync because async promises don't resolve during
// unload. Wrapped in try/catch so a stats flush never blocks shutdown.
function _beforeUnloadHandler() {
  try {
    syncToLifetime();
    if (STATS_PATH) require('fs').writeFileSync(
      STATS_PATH, JSON.stringify(makeStatsDiskData(), null, 2), 'utf8'
    );
  } catch {}
}
window.addEventListener('beforeunload', _beforeUnloadHandler);

// Pulsar package deactivate hook â€” called synchronously when the package is
// disabled or on window reload. Most reliable flush path for package reloads
// because Pulsar calls deactivate() before tearing down the renderer, giving
// us a guaranteed synchronous save window that beforeunload may miss.
function deactivate() {
  // Cancel the flush timer so this module instance's setInterval stops firing
  // after the module is replaced on hot-reload. Without this, every /mcp
  // reconnection leaves a leaked timer writing stale data to disk.
  clearInterval(_flushIntervalHandle);
  // Remove the beforeunload listener registered by this instance so it does
  // not accumulate across hot-reloads (each load adds one more, on window
  // reload they all fire and the last -- possibly stale -- wins the write).
  window.removeEventListener('beforeunload', _beforeUnloadHandler);
  try {
    syncToLifetime();
    if (STATS_PATH) require('fs').writeFileSync(
      STATS_PATH, JSON.stringify(makeStatsDiskData(), null, 2), 'utf8'
    );
  } catch {}
}


// Also flush on a 5-second timer -- short enough that a crash loses at most 5s
// of stats. Async fire-and-forget so it never blocks the UI thread.
// Handle saved so deactivate() can cancel it on hot-reload, preventing
// stale-instance timers accumulating across /mcp reconnections.
const _flushIntervalHandle = setInterval(() => {
  try { syncToLifetime(); flushLifetimeStats(); } catch {}
}, 5000);

// ---------------------------------------------------------------------------
// Checkpoint store (in-memory, keyed by name)
// ---------------------------------------------------------------------------
const checkpoints = new Map();

// ---------------------------------------------------------------------------
// Decoration helpers
// ---------------------------------------------------------------------------

function decorateEditedLines(editor, original, updated, { ttl = 8000 } = {}) {
  // No-op when there's no open tab to decorate â€” edits via bufferForPath on a
  // closed file have no editor object, but the write itself already happened
  // via `buffer` and doesn't depend on this. Was previously unguarded, which
  // crashed the whole handler after a successful write (null.getBuffer()).
  if (!editor) return null;
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
  if (!editor) return null; // no open tab â€” nothing to decorate
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
  if (!editor) return; // no open tab â€” nothing to decorate
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
function getEditStats() {
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


  const sessionStyleReport  = buildStyleReport(styleStats,        'session');
  const lifetimeStyleReport = buildStyleReport(lifetimeStyleStats, 'lifetime');
  Object.assign(sessionReport,  sessionStyleReport);
  Object.assign(lifetimeReport, lifetimeStyleReport);

  // Read last 5 entries from session/session-history.ndjson
  let recentSessions = [];
  if (SESSION_HISTORY_PATH) {
    try {
      const raw   = require('fs').readFileSync(SESSION_HISTORY_PATH, 'utf8');
      const lines = raw.split('\n').filter(l => l.trim());
      recentSessions = lines.slice(-5).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch (_) {}
  }

  return {
    paused: getStatsPaused(),
    failureLogPath: FAILURE_LOG_PATH || null,
    recentSessions,
    session:  sessionReport,
    lifetime: lifetimeReport,
  };
}

function resetEditStats() {
  // Sync and flush before zeroing so nothing is lost
  syncToLifetime();
  lifetimeStats.sessionCount = (lifetimeStats.sessionCount || 0) + 1;
  flushLifetimeStats();

  // Append one-line summary to session/session-history.ndjson
  const _sh = summarise(editStats);
  appendSessionHistory({
    ts:        new Date().toISOString(),
    session:   lifetimeStats.sessionCount,
    edits:     _sh.editTotal,
    hits:      _sh.editHits,
    faults:    _sh.editFaults,
    misses:    _sh.editMisses,
    hitRate:   _sh.editTotal > 0 ? Math.round((_sh.editHits / _sh.editTotal) * 100) / 100 : 1,
    searches:  _sh.searchTotal,
    searchHits: _sh.searchHits,
  });

  // Zero all tools generically â€” self-maintaining, no manual update needed when tools are added
  for (const [, val] of Object.entries(editStats)) {
    if (typeof val !== 'object' || val === null) continue;
    if (typeof val.hits === 'number')                   val.hits = 0;
    if (typeof val.dryRuns === 'number')                val.dryRuns = 0;
    if (typeof val.largeEditWarnings === 'number')      val.largeEditWarnings = 0;
    if (typeof val.fuzzyWhitespaceCommits  === 'number') val.fuzzyWhitespaceCommits  = 0;
    if (typeof val.fuzzyContentCommits     === 'number') val.fuzzyContentCommits     = 0;
    if (typeof val.autoStripCommentCommits === 'number') val.autoStripCommentCommits = 0;
    if (typeof val._oldStrLenSum === 'number')           val._oldStrLenSum = 0;
    if (val.fails)     Object.keys(val.fails).forEach(k     => val.fails[k]     = 0);
    if (val.hintsUsed) Object.keys(val.hintsUsed).forEach(k => val.hintsUsed[k] = 0);
  }
  resetLastSynced();
}

function resetLifetimeStats() {
  // Zero only the persisted lifetime totals â€” session counters keep running
  const blank = makeStatsDiskData();
  Object.assign(lifetimeStats, blank);
  lifetimeStats.sessionCount = 0;
  flushLifetimeStats();
}

function toggleStatsPause() {
  setStatsPaused(!getStatsPaused());
  return getStatsPaused();
}
module.exports = {
  mcpRegistration,
  deactivate,
  getEditStats,
  resetEditStats,
  resetLifetimeStats,
  toggleStatsPause,
  getLastEditedFilePath,
};
// injected externally
