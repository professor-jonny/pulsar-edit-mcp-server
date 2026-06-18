'use babel';
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { applyPatch, diffLines } = require('diff');
const { exec: _exec, spawn: _spawn } = require('child_process');
const { CompositeDisposable, Disposable } = require('atom');
const { checkLines: styleCheckLines, formatViolations: styleFormatViolations, isKernelFile } = require('./style-checker');
const { checkNaming, checkFunctionDocs, buildDocSkeleton, formatNamingViolations } = require('./naming-checker');
const { getSymbols, getSymbolsFromText, findFunction, resolveAnchor, braceEndRow: _tssBraceEndRow, resolveSymbolPosition, resolveStringPosition, resolveLinePosition, HINT_RADIUS } = require('./tree-sitter-symbols'); // v2
const { buildEditResponse, preEditSnapshot, postEditDelta } = require('./edit-response');
const { snapshot: structSnapshot } = require('./struct-check');
const { escapeRegex, applyReplacement, globToRegex, calculateSimilarity } = require('./string-utils');
const { walkDir, resolveStructuralAnchor, findAnchor, findFunctionInBuffer, readTextFromFile, retargetEditor } = require('./buffer-helpers');
const { maybeLintSuffix } = require('./lint-helpers');
const { TOOL_CATALOGUE, TOGGLEABLE_GROUPS } = require('./tool-catalogue');
const { shouldIgnore, reloadMcpIgnore: _reloadMcpIgnore, getMcpIgnoreInfo: _getMcpIgnoreInfo, initMcpIgnore } = require('./mcp-ignore');
const { makeRegisterMcpTool } = require('./tool-framework');
const { ANCHOR_SCHEMA, STRUCTURAL_ANCHOR_SCHEMA } = require('./schema');
const {
  anchorError, smartSuggestion, successNudge, ambiguityCheck, scanForOldStr,
} = require('./tool-hints');
const {
  SESSION_DIR,
  editStats, lifetimeStats, styleStats, lifetimeStyleStats,
  getStatsPaused, setStatsPaused,
  STATS_PATH, FAILURE_LOG_PATH, SESSION_HISTORY_PATH,
  logFailure, appendSessionHistory,
  flushLifetimeStats, makeStatsDiskData, syncToLifetime, resetLastSynced,
  bump, bumpStyle,
  summarise, buildReport, buildStyleReport,
} = require('./edit-stats');
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


// Regex and helper for "is this a source code file" checks — used throughout
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


// Stores the last fuzzy-rescued patch hunks so confirm:true can apply them
// without re-parsing. Cleared on successful apply or on a new patch attempt.
const patchRescueStore = { hunks: null, patchKey: null };


// ---------------------------------------------------------------------------
// bumpStyle(type, n) — increment a styleStats violation counter (session + lifetime).
// applyStyleCheck(newStr, filePath) — run style checker on a snippet (isWholeFile=false), return inline suffix string.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Debug log ring buffer — capped at 100 entries, survives across tool calls
// ---------------------------------------------------------------------------
const DEBUG_LOG_MAX = 100;
const debugLog = [];

// Last file path successfully committed by any edit tool — exposed via
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

function dbg(toolName, msg, data) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const entry = data !== undefined
    ? `[${ts}] [${toolName}] ${msg} ${JSON.stringify(data)}`
    : `[${ts}] [${toolName}] ${msg}`;
  if (debugLog.length >= DEBUG_LOG_MAX) debugLog.shift();
  debugLog.push(entry);
}

function mcpRegistration(server, linterRegistry = null, getMessages = null, groups = {}, chatPanel = null) {
  // Helper: returns true when a group is enabled (default: true)
  const g = (name) => groups[name] !== false;

  // ── Tool Framework ────────────────────────────────────────────────────────
  // registerMcpTool: framework-managed wrapper around server.registerTool()
  // for tools that have been migrated to the new pattern.
  const registerMcpTool = makeRegisterMcpTool(server, {
    bump,
    buildEditResponse,
    decorateEditedLines,
    applyStyleCheck,
    maybeLintSuffix,
    smartSuggestion,
    onCommit: (fp) => { lastEditedFilePath = fp; },
  });

  // Wrap every tool handler so errors surface in the chat panel as well as
  // returning to the LLM. Without this, tool exceptions are silently swallowed
  // by the MCP SDK transport layer and the user has no visibility into failures.
  const origRegister = server.registerTool.bind(server);

  // Tools with NO active-editor file context -- meta/shell tools that should
  // still work even when the active file is ignored (so the LLM can navigate
  // away, check stats, run commands, etc). Everything else is blocked when
  // the active editor's file matches a .mcp-ignore rule.
  const IGNORE_EXEMPT = new Set([
    'get-edit-stats', 'session-notes', 'get-debug-log', 'get-failure-log',
    'list-open-files', 'get-active-editor-info', 'open-file',
    'list-tools', 'enable-group',
    'get-project-files', 'grep-project', 'search-symbol', // walkDir already filters
    'run-command',
  ]);

  server.registerTool = (name, meta, handler) => {
    return origRegister(name, meta, async (args) => {
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
  registerMcpTool({
    name:     'str_replace',
    group:    'edit',
    category: 'edit',
    features: { dryRun: true, lint: true, styleCheck: true, consecutiveFailureCounter: true },
    title:    'String Replace',
    description: [
      "Replace the first occurrence of `old_str` with `new_str` in the active editor.",
      "ALWAYS use a hint on files >100 lines to scope the search. DECISION LADDER:",
      "(1) Know the function/method name containing the edit? \u2192 inFunction:'myFn' \u2014 scopes search to inside that function body, immune to line drift, safest choice for JS/C.",
      "(2) Know a unique string just before the edit? \u2192 afterString:'some anchor text' \u2014 starts search after that line, content-stable.",
      "(3) Know a unique string just after the edit? \u2192 beforeString:'some text below' \u2014 ends search before that line.",
      "(4) Edit is inside a specific region? \u2192 betweenHint:{start:'...', end:'...'} \u2014 restricts search to that exact span.",
      "(5) Know the line number from grep-file or read-lines? \u2192 afterLine:N (searches N to N+25) or beforeLine:N (searches N\u221225 to N) \u2014 directional 25-line windows, positional.",
      "(6) Same pattern appears N times and none of the above apply? \u2192 occurrence:N to target the Nth match.",
      "fuzzyWhitespace:true \u2014 set this when exact match fails due to indentation differences; matches trimmed content and uses the buffer's actual whitespace.",
      "dryRun:true \u2014 always use this first for multi-line old_str you're not certain about; previews what would be matched without writing.",
      "For replacing ALL occurrences use replace-all. For a full function rewrite use replace-function-body. For a full file rewrite use replace-document.",
      "Tracks consecutive failures and surfaces a tool-switch suggestion after repeated no-match errors.",
      "RESPONSE FORMAT: \u2705 str_replace \u2014 line N, \u00b1M lines [tags] \u2014 where tags show the match method used (fuzzyWhitespace, regex, etc).",
      "Warnings appended when non-empty: \u26a0\ufe0f style: rule violations in the changed lines; \u26a0\ufe0f lint: L# error/warning from the linter in the edited region.",
      "ACT ON WARNINGS: style violations mean the written code breaks kernel style rules \u2014 fix immediately. Lint errors mean the compiler/linter detected a problem in the region just edited.",
    ].join(" "),
    inputSchema: {
      old_str:         z.string(),
      ...ANCHOR_SCHEMA,
      new_str:         z.string(),
    },
    handler: async ({ old_str, new_str, betweenHint, inFunction, afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterString, beforeString, afterLine, beforeLine, hintRadius, occurrence = 1, fuzzyWhitespace = false, fuzzyContent = false, regex = false, dryRun = false, lint = false }, ctx) => {
      // Alias ctx.consec as the legacy failure counter so all existing call sites work unchanged

      const { editor, buffer, allLines, text } = ctx;
      const curTool = 'str_replace'; // retained for smartSuggestion call sites
      const isCodeFile = isCodeFilePath(ctx.filePath); // B23: ctx.filePath safe when editor is null (bufferForPath path)
      const _radius = hintRadius ?? HINT_RADIUS;
      const _hasScope = !!(inFunction || betweenHint ||
        afterFunction || beforeFunction || afterSymbol || beforeSymbol ||
        afterString || beforeString || afterLine != null || beforeLine != null ||
        occurrence > 1);
        const allSymbols = getSymbols(editor, text, ctx.filePath); // B23

        // -- Resolve search bounds ---------------------------------------------
        // Priority: betweenHint > inFunction > afterFunction/beforeFunction > afterSymbol/beforeSymbol > afterString/beforeString > afterLine/beforeLine > entire file
        let searchStart = 0;
        let searchEnd   = text.length;
        let scopeLabel  = "";

        if (betweenHint) {
          const rStart = resolveAnchor(betweenHint.start, allSymbols, text);
          const errStart = anchorError('betweenHint.start', betweenHint.start, rStart, allSymbols);
          if (errStart) {
            logHintFailure({ tool: curTool, hintName: 'betweenHint.start', hintValue: betweenHint.start, reason: 'notFound', filePath: ctx.filePath, oldStr: old_str });
            ctx.consec.count++;
            bump('str_replace', 'fails.outOfScope'); bump('str_replace', 'faultBuckets.hintFaults'); // #5a
            return { content: [{ type: "text", text: [errStart, smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: false, fileLines: allLines.length, oldStr: old_str, isCodeFile })].filter(Boolean).join("\n") }], matched: false };
          }
          const rEnd = resolveAnchor(betweenHint.end, allSymbols, text);
          const errEnd = anchorError('betweenHint.end', betweenHint.end, rEnd, allSymbols);
          if (errEnd) {
            logHintFailure({ tool: curTool, hintName: 'betweenHint.end', hintValue: betweenHint.end, reason: 'notFound', filePath: ctx.filePath, oldStr: old_str });
            ctx.consec.count++;
            bump('str_replace', 'fails.outOfScope'); bump('str_replace', 'faultBuckets.hintFaults'); // #5a
            return { content: [{ type: "text", text: [errEnd, smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: false, fileLines: allLines.length, oldStr: old_str, isCodeFile })].filter(Boolean).join("\n") }], matched: false };
          }
          searchStart = buffer.characterIndexForPosition([rStart.row, 0]);
          searchEnd   = buffer.characterIndexForPosition([rEnd.row + 1, 0]);
          scopeLabel  = ` between "${betweenHint.start.substring(0, 30)}" [${rStart.via}] and "${betweenHint.end.substring(0, 30)}" [${rEnd.via}] (lines ${rStart.row + 1}—${rEnd.row + 1})`;
        // inFunction — scope search to function body
        } else if (inFunction) {
          const hintVal  = inFunction;
          const r = resolveSymbolPosition(allSymbols, hintVal, 'function', 'inside', _radius);
          if (r.needsTreeSitter) {
            logHintFailure({ tool: curTool, hintName: 'inFunction', hintValue: hintVal, reason: 'needsTreeSitter', filePath: ctx.filePath, oldStr: old_str });
            ctx.consec.count++;
            bump('str_replace', 'fails.outOfScope'); bump('str_replace', 'faultBuckets.hintFaults'); // #5a
            return { content: [{ type: 'text', text: `? inFunction: requires the file to be open in the editor with a grammar assigned (no tree-sitter parse tree found).` }], matched: false };
          }
          if (r.notFound) {
            const known = allSymbols.filter(s => ['function','registerTool'].includes(s.kind)).map(s => `  ${s.startRow + 1}: ${s.name} [${s.kind}]`).slice(0, 20);
            logHintFailure({ tool: curTool, hintName: 'inFunction', hintValue: hintVal, reason: 'notFound', filePath: ctx.filePath, oldStr: old_str });
            ctx.consec.count++;
            bump('str_replace', 'fails.outOfScope'); bump('str_replace', 'faultBuckets.hintFaults'); // #5a
            return { content: [{ type: 'text', text: [`? inFunction: "${hintVal}" not found.`, `Known functions:\n${known.join('\n') || '  (none)'}`, smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: false, fileLines: allLines.length, oldStr: old_str, isCodeFile })].filter(Boolean).join('\n') }], matched: false };
          }
          if (r.ambiguous) {
            const list = r.matches.map(m => `  line ${m.startRow + 1}: ${m.name} [${m.kind}]`).join('\n');
            logHintFailure({ tool: curTool, hintName: 'inFunction', hintValue: hintVal, reason: 'ambiguous', filePath: ctx.filePath, oldStr: old_str });
            ctx.consec.count++;
            bump('str_replace', 'fails.outOfScope'); bump('str_replace', 'faultBuckets.hintFaults'); // #5a
            return { content: [{ type: 'text', text: `? inFunction: "${hintVal}" is ambiguous \u2014 ${r.matches.length} matches:\n${list}\nUse occurrence:N to disambiguate.` }], matched: false };
          }
          searchStart = buffer.characterIndexForPosition([r.startRow, 0]);
          searchEnd   = buffer.characterIndexForPosition([r.endRow + 1, 0]);
          scopeLabel  = ` within inFunction "${hintVal}" (lines ${r.startRow + 1}\u2014${r.endRow + 1})`;

        // afterFunction / beforeFunction — window relative to function symbol
        } else if (afterFunction || beforeFunction) {
          const hintName = afterFunction ? 'afterFunction' : 'beforeFunction';
          const hintVal  = afterFunction || beforeFunction;
          const dir      = afterFunction ? 'after' : 'before';
          const r = resolveSymbolPosition(allSymbols, hintVal, 'function', dir, _radius);
          if (r.notFound) {
            const known = allSymbols.filter(s => ['function','registerTool'].includes(s.kind)).map(s => `  ${s.startRow + 1}: ${s.name}`).slice(0, 20);
            logHintFailure({ tool: curTool, hintName, hintValue: hintVal, reason: 'notFound', filePath: ctx.filePath, oldStr: old_str });
            ctx.consec.count++;
            bump('str_replace', 'fails.outOfScope'); bump('str_replace', 'faultBuckets.hintFaults'); // #5a
            return { content: [{ type: 'text', text: [`? ${hintName}: function "${hintVal}" not found.`, `Known functions:\n${known.join('\n') || '  (none)'}`, smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: false, fileLines: allLines.length, oldStr: old_str, isCodeFile })].filter(Boolean).join('\n') }], matched: false };
          }
          if (r.ambiguous) {
            const list = r.matches.map(m => `  line ${m.startRow + 1}: ${m.name}`).join('\n');
            logHintFailure({ tool: curTool, hintName, hintValue: hintVal, reason: 'ambiguous', filePath: ctx.filePath, oldStr: old_str });
            ctx.consec.count++;
            bump('str_replace', 'fails.outOfScope'); bump('str_replace', 'faultBuckets.hintFaults'); // #5a
            return { content: [{ type: 'text', text: `? ${hintName}: "${hintVal}" is ambiguous:\n${list}\nUse occurrence:N to disambiguate.` }], matched: false };
          }
          searchStart = buffer.characterIndexForPosition([r.startRow, 0]);
          searchEnd   = buffer.characterIndexForPosition([r.endRow + 1, 0]);
          scopeLabel  = ` ${hintName} "${hintVal}" (lines ${r.startRow + 1}—${r.endRow + 1}, anchor line ${r.anchorRow + 1})`;

        // afterSymbol / beforeSymbol — window relative to any symbol
        } else if (afterSymbol || beforeSymbol) {
          const hintName = afterSymbol ? 'afterSymbol' : 'beforeSymbol';
          const hintVal  = afterSymbol || beforeSymbol;
          const dir      = afterSymbol ? 'after' : 'before';
          const r = resolveSymbolPosition(allSymbols, hintVal, 'any', dir, _radius);
          if (r.needsTreeSitter) {
            logHintFailure({ tool: curTool, hintName, hintValue: hintVal, reason: 'needsTreeSitter', filePath: ctx.filePath, oldStr: old_str });
            ctx.consec.count++;
            bump('str_replace', 'fails.outOfScope'); bump('str_replace', 'faultBuckets.hintFaults'); // #5a
            return { content: [{ type: 'text', text: `? ${hintName}: requires the file to be open in the editor with a grammar assigned (no tree-sitter parse tree found).` }], matched: false };
          }
          if (r.notFound) {
            const known = allSymbols.map(s => `  ${s.startRow + 1}: ${s.name} [${s.kind}]`).slice(0, 20);
            logHintFailure({ tool: curTool, hintName, hintValue: hintVal, reason: 'notFound', filePath: ctx.filePath, oldStr: old_str });
            ctx.consec.count++;
            bump('str_replace', 'fails.outOfScope'); bump('str_replace', 'faultBuckets.hintFaults'); // #5a
            return { content: [{ type: 'text', text: [`? ${hintName}: "${hintVal}" not found.`, `Known symbols:\n${known.join('\n') || '  (none)'}`, smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: false, fileLines: allLines.length, oldStr: old_str, isCodeFile })].filter(Boolean).join('\n') }], matched: false };
          }
          if (r.ambiguous) {
            const list = r.matches.map(m => `  line ${m.startRow + 1}: ${m.name} [${m.kind}]`).join('\n');
            logHintFailure({ tool: curTool, hintName, hintValue: hintVal, reason: 'ambiguous', filePath: ctx.filePath, oldStr: old_str });
            ctx.consec.count++;
            bump('str_replace', 'fails.outOfScope'); bump('str_replace', 'faultBuckets.hintFaults'); // #5a
            return { content: [{ type: 'text', text: `? ${hintName}: "${hintVal}" is ambiguous:\n${list}\nUse occurrence:N to disambiguate.` }], matched: false };
          }
          searchStart = buffer.characterIndexForPosition([r.startRow, 0]);
          searchEnd   = buffer.characterIndexForPosition([r.endRow + 1, 0]);
          scopeLabel  = ` ${hintName} "${hintVal}" (lines ${r.startRow + 1}—${r.endRow + 1}, anchor line ${r.anchorRow + 1})`;

        // afterString / beforeString — window relative to a line containing text
        } else if (afterString || beforeString) {
          const hintName = afterString ? 'afterString' : 'beforeString';
          const hintVal  = afterString || beforeString;
          const dir      = afterString ? 'after' : 'before';
          const r = resolveStringPosition(allLines, hintVal, dir, _radius);
          if (r.notFound) {
            logHintFailure({ tool: curTool, hintName, hintValue: hintVal, reason: 'notFound', filePath: ctx.filePath, oldStr: old_str });
            ctx.consec.count++;
            bump('str_replace', 'fails.afterNotFound'); bump('str_replace', 'faultBuckets.hintFaults'); // #5a
            return { content: [{ type: 'text', text: [`? ${hintName}: "${hintVal.substring(0, 60)}" not found in file.`, smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: false, fileLines: allLines.length, oldStr: old_str, isCodeFile })].filter(Boolean).join('\n') }], matched: false };
          }
          if (r.ambiguous) {
            const lines = r.rows.map(row => `  line ${row + 1}`).join('\n');
            ctx.consec.count++;
            bump('str_replace', 'fails.afterNotFound'); bump('str_replace', 'faultBuckets.hintFaults'); // #5a
            logHintFailure({ tool: curTool, hintName, hintValue: hintVal, reason: 'ambiguous', filePath: ctx.filePath, oldStr: old_str });
            return { content: [{ type: 'text', text: `? ${hintName}: "${hintVal.substring(0, 60)}" found on ${r.rows.length} lines — use a more unique string:\n${lines}` }], matched: false };
          }
          searchStart = buffer.characterIndexForPosition([r.startRow, 0]);
          searchEnd   = buffer.characterIndexForPosition([r.endRow + 1, 0]);
          scopeLabel  = ` ${hintName} "${hintVal.substring(0, 40)}" (anchor line ${r.anchorRow + 1}, —${HINT_RADIUS})`;

        // afterLine / beforeLine — positional last resort
        } else if (afterLine != null || beforeLine != null) {
          const hintName = afterLine != null ? 'afterLine' : 'beforeLine';
          const hintVal  = afterLine != null ? afterLine : beforeLine;
          const dir      = afterLine != null ? 'after' : 'before';
          const r = resolveLinePosition(allLines.length, hintVal, dir, _radius);
          searchStart = buffer.characterIndexForPosition([r.startRow, 0]);
          searchEnd   = buffer.characterIndexForPosition([r.endRow + 1, 0]);
          scopeLabel  = ` ${hintName}:${hintVal} (lines ${r.startRow + 1}—${r.endRow + 1})`;
        }

        // -- Track hint usage -------------------------------------------------
        if (inFunction)            bump('str_replace', 'hintsUsed.inFunction');
        if (afterFunction)         bump('str_replace', 'hintsUsed.afterFunction');
        if (beforeFunction)        bump('str_replace', 'hintsUsed.beforeFunction');
        if (afterSymbol)           bump('str_replace', 'hintsUsed.afterSymbol');
        if (beforeSymbol)          bump('str_replace', 'hintsUsed.beforeSymbol');
        if (afterString)           bump('str_replace', 'hintsUsed.afterString');
        if (beforeString)          bump('str_replace', 'hintsUsed.beforeString');
        if (afterLine != null)     bump('str_replace', 'hintsUsed.afterLine');
        if (beforeLine != null)    bump('str_replace', 'hintsUsed.beforeLine');
        if (betweenHint)           bump('str_replace', 'hintsUsed.betweenHint');
        if (occurrence > 1)        bump('str_replace', 'hintsUsed.occurrence');

        // -- Fuzzy whitespace helper -------------------------------------------
        // P3: when fuzzyWhitespace:true, try trimmed-per-line match and rebuild
        // old_str using buffer's actual indentation before doing the real search.
        let effectiveOldStr = old_str;
        let effectiveNewStr = new_str; // may be rewritten by autoStripComment
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

        // -- Fuzzy content helper ----------------------------------------------
        let matchIndex = -1;
        let matchLine  = -1; // 0-based
        let occurrencesFound = 0;

        // P4: when fuzzyContent:true, normalise smart-quotes, BOM, zero-width
        // chars, box-drawing runs, and emoji in both old_str and buffer text for comparison only,
        // then rebuild effectiveOldStr from the buffer's actual characters.
        if (fuzzyContent) {
          const normalise = s => s
            .replace(/\uFEFF/g, '')                          // BOM
            .replace(/[\u200B\u200C\u200D\u00AD]/g, '')      // zero-width / soft-hyphen
            .replace(/\u00A0/g, ' ')                         // non-breaking space ? space
            .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")  // smart single quotes
            .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')  // smart double quotes
            .replace(/[\u2013\u2014]/g, '-')                 // en/em dash -> hyphen
            .replace(/[\u2190-\u21FF]/g, '->')               // arrows (? ? ? ? etc.) -> ASCII
            .replace(/[\u2500-\u257F]+/g, '--')              // box-drawing runs (e.g. -----) -> --
            .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '\u{1F4CC}'); // surrogate pairs (emoji) -> placeholder
          const normNeedle = normalise(effectiveOldStr);
          const searchText = text.substring(searchStart, searchEnd);
          const normHaystack = normalise(searchText);
          const idx = normHaystack.indexOf(normNeedle);
          if (idx !== -1) {
            // Rebuild effectiveOldStr using the buffer's actual characters at the matched position.
            // Walk searchText forward consuming characters until normNeedle.length normalised
            // characters have been accounted for. We can't use effectiveOldStr.length directly
            // because normalisation is non-length-preserving (BOM/zero-width/surrogate removals
            // shrink the string), so the normalised and raw lengths differ.
            let srcIdx = idx;
            let consumed = 0;
            while (consumed < normNeedle.length && srcIdx < searchText.length) {
              consumed += normalise(searchText[srcIdx]).length;
              srcIdx++;
            }
            effectiveOldStr = searchText.substring(idx, srcIdx);
            // Capture match position directly -- don't make the indexOf loops re-find it.
            // idx is relative to searchText (= text.substring(searchStart, searchEnd)),
            // so the absolute char index in the full buffer is searchStart + idx.
            const absIdx = searchStart + idx;
            matchIndex = absIdx;
            matchLine  = text.substring(0, absIdx).split('\n').length - 1;
            occurrencesFound = occurrence; // signal "already found" -- skips indexOf loops
          }
        }

        // -- P5: regex mode — compile old_str as JS RegExp, find Nth match ----
        // When regex:true, old_str is treated as a pattern so the LLM can
        // wildcard over backticks, pipes, emoji, or any other problematic chars.
        // Runs after fuzzyWhitespace/fuzzyContent so those flags still apply to
        // the search region scoping, but the actual match uses RegExp.exec().
        // matchIndex/matchLine are set here and the normal indexOf loop is skipped.
        if (regex) {
          let pattern;
          try {
            pattern = new RegExp(effectiveOldStr, 'gm');
          } catch (e) {
            ctx.consec.count++;
            bump('str_replace', 'fails.noMatch');
            return {
              content: [{ type: 'text', text: `? regex:true — invalid pattern: ${e.message}\nCheck your old_str regex syntax and retry.` }],
              matched: false,
              consecFailures: ctx.consec.count
            };
          }
          const searchText = text.substring(searchStart, searchEnd);
          let match;
          let nFound = 0;
          while ((match = pattern.exec(searchText)) !== null) {
            nFound++;
            if (nFound === occurrence) {
              const absIdx  = searchStart + match.index;
              matchIndex    = absIdx;
              matchLine     = text.substring(0, absIdx).split('\n').length - 1;
              // Rewrite effectiveOldStr to the exact matched text so the
              // buffer.setTextInRange replacement targets the right span.
              effectiveOldStr = match[0];
              break;
            }
            // avoid infinite loop on zero-length matches
            if (match.index === pattern.lastIndex) pattern.lastIndex++;
          }
          occurrencesFound = nFound;
        }


        const isMultiLine = effectiveOldStr.includes("\n");

        if (!regex) {
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
            const fnStartRow = inFunction || betweenHint
              ? buffer.positionForCharacterIndex(searchStart).row
              : searchStart > 0
                ? text.substring(0, searchStart).split("\n").length - 1
                : 0;
            const fnEndRow = (inFunction || betweenHint)
              ? buffer.positionForCharacterIndex(searchEnd).row
              : allLines.length - 1;
            for (let i = fnStartRow; i <= fnEndRow && i < allLines.length; i++) {
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
        } // end !regex



        // Report if requested occurrence doesn't exist -- show where the ones that DO exist are.
        // In regex mode we can't do indexOf on the pattern string, so give a simpler message.
        if (matchIndex === -1 && occurrencesFound > 0 && occurrence > occurrencesFound) {
          ctx.consec.count++;
          bump('str_replace', 'fails.wrongOccurrence'); bump('str_replace', 'faultBuckets.hintFaults'); // #5a
          if (regex) {
            return {
              content: [{ type: "text", text: [
                `? occurrence:${occurrence} requested but regex pattern only matched ${occurrencesFound} time(s)${scopeLabel}.`,
                `?? Use occurrence:N where N = ${occurrencesFound}, or broaden your pattern.`,
                smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: false, fileLines: allLines.length, oldStr: old_str, isCodeFile: isCodeFilePath(ctx.filePath) })
              ].filter(Boolean).join("\n") }],
              matched: false,
              occurrencesFound,
              consecFailures: ctx.consec.count
            };
          }
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
              `? occurrence:${occurrence} requested but only ${occurrencesFound} match(es) found for old_str${scopeLabel}.`,
              `?? Found at line(s): ${foundAt.join(", ")} — use one of these as occurrence:N or adjust old_str.`,
              smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: false, fileLines: allLines.length, oldStr: old_str, isCodeFile: isCodeFilePath(ctx.filePath) })
            ].filter(Boolean).join("\n") }],
            matched: false,
            occurrencesFound,
            foundAtLines: foundAt,
            consecFailures: ctx.consec.count
          };
        }


                // -- Auto-retry: scan-first mismatch diagnosis + transform ------------
                // Profile the needle lines against the search window in ONE pass to
                // determine which transforms are needed, then apply them all at once
                // and retry.  Replaces the old stepped whitespace → encoding → comment
                // waterfall with a single diagnosis loop + single match attempt.
                let autoFuzzyWhitespace = false;
                let autoFuzzyContent    = false;
                let autoStripComment    = false;
                let salvagedComment     = null;

                if (matchIndex === -1 && !regex) {
                  // Shared Unicode normaliser (same map used in explicit fuzzyContent P4)
                  const _norm = s => s
                    .replace(/\uFEFF/g, '')
                    .replace(/[\u200B\u200C\u200D\u00AD]/g, '')
                    .replace(/\u00A0/g, ' ')
                    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
                    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
                    .replace(/[\u2013\u2014]/g, '-')
                    .replace(/[\u2190-\u21FF]/g, '->')
                    .replace(/[\u2500-\u257F]+/g, '--')
                    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '\u{1F4CC}');

                  const searchText  = text.substring(searchStart, searchEnd);
                  const searchLines = searchText.split('\n');
                  const needleLines = old_str.split('\n');

                  // _profileScan: single pass over needle lines to classify mismatches.
                  // Returns { needsWhitespace, needsEncoding, trailingComment } where:
                  //   needsWhitespace — at least one line differs only in indentation
                  //   needsEncoding   — at least one line has non-ASCII Unicode diff
                  //   trailingComment — trailing comment on last needle line not in buffer
                  const _profileScan = (needle, haystack) => {
                    const trailingCommentRe = /(\s*(?:\/\*.*?\*\/|\/\/[^\n]*))$/;
                    let needsWhitespace = false;
                    let needsEncoding   = false;
                    let trailingComment = null;

                    for (let li = 0; li < needle.length; li++) {
                      const nLine = needle[li];
                      const nTrim = nLine.trim();
                      if (!nTrim) continue;

                      // Look for a buffer line whose trimmed content matches
                      const bufMatch = haystack.find(bl => bl.trim() === nTrim);
                      if (bufMatch !== undefined) {
                        if (bufMatch !== nLine) needsWhitespace = true;
                        continue;
                      }

                      // No exact trim match — try normalise-and-trim
                      const nNorm = _norm(nTrim);
                      const bufNorm = haystack.find(bl => _norm(bl.trim()) === nNorm);
                      if (bufNorm !== undefined) {
                        // Diff chars are Unicode, not just whitespace
                        needsEncoding = true;
                        if (bufNorm !== nLine) needsWhitespace = true;
                        continue;
                      }

                      // Last line: check for trailing comment mismatch
                      if (li === needle.length - 1) {
                        const cm = nLine.match(trailingCommentRe);
                        if (cm) {
                          const stripped = nLine.slice(0, nLine.length - cm[1].length);
                          const strippedTrim = stripped.trim();
                          const bufStripped = haystack.find(bl => bl.trim() === strippedTrim);
                          if (bufStripped !== undefined) {
                            trailingComment = cm[1].trim();
                            if (bufStripped !== stripped) needsWhitespace = true;
                          }
                        }
                      }
                    }
                    return { needsWhitespace, needsEncoding, trailingComment };
                  };

                  const profile = _profileScan(needleLines, searchLines);
                  const anyTransform = profile.needsWhitespace || profile.needsEncoding || profile.trailingComment;

                  // #4 capture fuzzy trigger reasons before attempting transform
                  if (profile.needsWhitespace)   bump('str_replace', 'fuzzyTriggerReasons.needsWhitespace');
                  if (profile.needsEncoding)     bump('str_replace', 'fuzzyTriggerReasons.needsContent');
                  if (profile.trailingComment)   bump('str_replace', 'fuzzyTriggerReasons.needsComment');

                  if (anyTransform) {
                    // Build the transformed needle to match against
                    let workNeedle = needleLines;

                    // Strip trailing comment from last line if detected
                    if (profile.trailingComment) {
                      const trailingCommentRe = /(\s*(?:\/\*.*?\*\/|\/\/[^\n]*))$/;
                      const last = workNeedle[workNeedle.length - 1];
                      const cm   = last.match(trailingCommentRe);
                      if (cm) {
                        const strippedLast = last.slice(0, last.length - cm[1].length);
                        // BUG-B guard: needle must be long enough to be a reliable anchor
                        const STRIP_MIN_LAST  = 8;
                        const STRIP_MIN_TOTAL = 10;
                        if (strippedLast.replace(/\s/g, '').length >= STRIP_MIN_LAST &&
                            workNeedle.slice(0, -1).concat(strippedLast).join('\n').replace(/\s/g, '').length >= STRIP_MIN_TOTAL) {
                          workNeedle = workNeedle.slice(0, -1).concat(strippedLast);
                          salvagedComment = profile.trailingComment;
                        }
                      }
                    }

                    // Single fuzzy-per-line match: trim-compare (and optionally norm-compare)
                    let fuzzyStart = -1;
                    outer_scan:
                    for (let i = 0; i <= searchLines.length - workNeedle.length; i++) {
                      for (let j = 0; j < workNeedle.length; j++) {
                        const sl = searchLines[i + j];
                        const nl = workNeedle[j];
                        const match = profile.needsEncoding
                          ? _norm(sl.trim()) === _norm(nl.trim())
                          : sl.trim() === nl.trim();
                        if (!match) continue outer_scan;
                      }
                      fuzzyStart = i;
                      break;
                    }

                    if (fuzzyStart !== -1) {
                      // Rebuild effectiveOldStr from the buffer's actual lines
                      let rebuiltOldStr;
                      if (profile.needsEncoding) {
                        // Encoding path: walk raw chars to find exact span in searchText
                        // (normalisation is non-length-preserving, can't use line slice directly)
                        const normNeedle   = _norm(workNeedle.join('\n'));
                        const normHaystack = _norm(searchText);
                        const normIdx    = normHaystack.indexOf(normNeedle);
                        if (normIdx !== -1) {
                          let srcIdx = normIdx, consumed = 0;
                          while (consumed < normNeedle.length && srcIdx < searchText.length) {
                            consumed += _norm(searchText[srcIdx]).length;
                            srcIdx++;
                          }
                          rebuiltOldStr = searchText.substring(normIdx, srcIdx);
                        }
                      }
                      if (!rebuiltOldStr) {
                        // Whitespace / comment path: use line slice directly
                        rebuiltOldStr = searchLines.slice(fuzzyStart, fuzzyStart + workNeedle.length).join('\n');
                      }

                      const autoIdx = text.indexOf(rebuiltOldStr, searchStart);
                      if (autoIdx !== -1 && autoIdx < searchEnd) {
                        matchIndex      = autoIdx;
                        matchLine       = text.substring(0, autoIdx).split('\n').length - 1;
                        effectiveOldStr = rebuiltOldStr;

                        if (profile.needsEncoding) {
                          fuzzyContent     = true;
                          autoFuzzyContent = true;
                          bump('str_replace', 'fuzzyContentCommits');
                        } else if (profile.needsWhitespace) {
                          fuzzyWhitespace     = true;
                          autoFuzzyWhitespace = true;
                          bump('str_replace', 'hintsUsed.fuzzyWhitespace');
                          bump('str_replace', 'fuzzyWhitespaceCommits');
                        }

                        if (salvagedComment) {
                          autoStripComment = true;
                          bump('str_replace', 'autoStripCommentCommits');
                          if (!fuzzyWhitespace) {
                            bump('str_replace', 'hintsUsed.fuzzyWhitespace');
                            bump('str_replace', 'fuzzyWhitespaceCommits');
                            fuzzyWhitespace = true;
                            autoFuzzyWhitespace = true;
                          }
                          // Append salvaged comment to effectiveNewStr's last line
                          const nsLines = effectiveNewStr.split('\n');
                          const nsLast  = nsLines[nsLines.length - 1];
                          if (!/\/\/|\/\*/.test(nsLast)) {
                            nsLines[nsLines.length - 1] = nsLast + ' /* CHECK: ' + salvagedComment + ' */';
                            effectiveNewStr = nsLines.join('\n');
                          }
                        }
                      }
                    }
                  }
                }

        // -- Auto-retry: partialMatch — drop search window and try full buffer --
        // If still no match after all auto-retries, scan for a partial prefix
        // match (=2 leading lines of old_str) anywhere in the file. When the
        // leading lines are found at a position outside the original search
        // window (hint window has drifted), attempt a full match there with
        // fuzzyWhitespace normalisation. This rescues the most common partialMatch
        // cause: a prior insert/delete shifted the target region so the hint
        // or afterString now points at the wrong area.
        let autoPartialMatch = false;
        if (matchIndex === -1 && !regex && old_str.includes('\n')) {
          const pmLines  = old_str.split('\n');
          const pmLeader = pmLines.slice(0, Math.min(2, pmLines.length)).join('\n');
          // Search the entire buffer (not just the hint window) for the leading lines
          const pmLeaderIdx = text.indexOf(pmLeader);
          if (pmLeaderIdx !== -1) {
            // Found the leader outside the hint window — try fuzzyWhitespace match
            // from here over the full old_str length
            const pmSearchText = text.substring(pmLeaderIdx, pmLeaderIdx + old_str.length * 2);
            const pmSearchLines = pmSearchText.split('\n');
            const pmNeedle      = pmLines.map(l => l.trim());
            let pmStart = -1;
            outer_pm:
            for (let i = 0; i <= pmSearchLines.length - pmNeedle.length; i++) {
              for (let j = 0; j < pmNeedle.length; j++) {
                if (pmSearchLines[i + j].trim() !== pmNeedle[j]) continue outer_pm;
              }
              pmStart = i;
              break;
            }
            if (pmStart !== -1) {
              const rebuiltOldStr = pmSearchLines.slice(pmStart, pmStart + pmNeedle.length).join('\n');
              const pmAbsIdx = text.indexOf(rebuiltOldStr, pmLeaderIdx);
              if (pmAbsIdx !== -1) {
                matchIndex      = pmAbsIdx;
                matchLine       = text.substring(0, pmAbsIdx).split('\n').length - 1;
                effectiveOldStr = rebuiltOldStr;
                bump('str_replace', 'hintsUsed.fuzzyWhitespace');
                bump('str_replace', 'autoPartialMatchCommits');
                bump('str_replace', 'fuzzyTriggerReasons.partial'); // #4
              }
            }
          }
        }

        if (matchIndex === -1) {
          ctx.consec.count++;
          const lines = old_str.split("\n");

          // Search region for diagnostics (respect all scope hints)
          const diagLines = (inFunction || betweenHint)
            ? allLines.slice(text.substring(0, searchStart).split("\n").length - 1, text.substring(0, searchEnd).split("\n").length)
            : allLines;
          const diagOffset = (inFunction || betweenHint)
            ? text.substring(0, searchStart).split("\n").length - 1
            : 0;

          // 1. Check for whitespace/indentation differences per line
          const wsIssues = [];
          let   hasEncodingIssue = false; // true when diff involves non-ASCII Unicode, not just whitespace
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
              // Classify: if non-whitespace chars still differ (after stripping all whitespace)
              // and either side has non-ASCII codepoints, the root cause is encoding not indentation.
              if (!hasEncodingIssue) {
                const a = lines[li].replace(/\s/g, '');
                const b = diagLines[bufferHit].replace(/\s/g, '');
                if (a !== b && /[^\u0000-\u007F]/.test(a + b)) hasEncodingIssue = true;
              }
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

          // -- Classify failure reason for stats -----------------------------
          if (wsIssues.length > 0) {
            bump('str_replace', hasEncodingIssue ? 'fails.encoding' : 'fails.whitespace');
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
            `? No match found for old_str${scopeLabel || ''}.`
          ];
          if (wsIssues.length > 0) {
            parts.push(`\n??  WHITESPACE MISMATCH on ${wsIssues.length} line(s) — content matches but indentation differs:`);
            for (const w of wsIssues) {
              parts.push(`  search line ${w.searchLine}: ${w.searchText}`);
              parts.push(`  buffer line ${w.bufferLine}: ${w.bufferText}`);
            }
            parts.push("  ? Fix indentation in old_str to match the buffer exactly, OR retry with fuzzyWhitespace:true to commit using buffer indentation.");
          }
          if (partialMatchLines > 0 && partialMatchLines < lines.length) {
            parts.push(`\n??  PARTIAL MATCH: first ${partialMatchLines} of ${lines.length} lines matched consecutively, then diverged. Likely a trailing-whitespace or indentation difference on line ${partialMatchLines + 1}.`);
          }
          // 4. Closest region + Levenshtein similarity
          //    Show the nearest matching area in the buffer regardless of whether
          //    fuzzyRow was found. Similarity runs for all failures (single and multi-line).
          if (fuzzyRow >= 0) {
            parts.push(`\n?? Closest area found (lines ${ctxStart + 1}—${ctxEnd + 1}):\n${contextLines}`);
          }
          {
            const simRow   = fuzzyRow >= 0 ? fuzzyRow : diagOffset;
            const bufSlice = allLines.slice(simRow, simRow + lines.length).join('\n');
            const simPct   = calculateSimilarity(old_str, bufSlice);
            let simHint;
            if (simPct >= 80) {
              simHint = 'Content is close — likely whitespace/indentation drift. Try fuzzyWhitespace:true or re-read that region.';
            } else if (simPct >= 50) {
              simHint = 'Moderate match — old_str may be stale. Re-read the file with read-lines and rebuild old_str from current buffer content.';
            } else {
              simHint = 'Low match — old_str may be pointing at the wrong location entirely. Verify scope hints and re-read the target area.';
            }
            parts.push(`\n?? Similarity: ${simPct}% — ${simHint}`);
          }
          if (afterLine != null || beforeLine != null) {
            const _hintName = afterLine != null ? 'afterLine' : 'beforeLine';
            const _hintVal  = afterLine != null ? afterLine : beforeLine;
            const _anchorContent = allLines[_hintVal - 1] ? allLines[_hintVal - 1].trim() : null;
            // Always show the drift nudge when a positional line hint was active —
            // even on wsIssues/partialMatch failures the anchor may have shifted.
            parts.push(
              `\n💡 ${_hintName}:${_hintVal} window (${HINT_RADIUS} lines) — content may have drifted after prior edits.` +
              (_anchorContent ? `\n   Drift-immune alternative: use afterString:'${_anchorContent.substring(0, 60)}' instead of ${_hintName}.` : '') +
              `\n   Or re-run grep-file to confirm the current line number before retrying.`
            );
          }
          const sugg = smartSuggestion({
            toolName: curTool,
            counter: ctx.consec,
            noHintsUsed: !_hasScope,
            fileLines: allLines.length,
            oldStr: old_str,
            isCodeFile,
          });
          if (sugg) parts.push(sugg);

          // -- scanForOldStr: detect match outside active scope ----------------
          // Always scan the full file for old_str so we can tell the LLM exactly
          // where it is (or confirm it's nowhere) regardless of scope hints.
          {
            const _fullScan = scanForOldStr({
              needle:     old_str,
              allLines,
              scopeStart: _hasScope ? (() => {
                if (inFunction) { const _fn = findFunctionInBuffer(buffer, inFunction); return _fn ? _fn.startRow : -1; }
                return text.substring(0, searchStart).split('\n').length - 1;
              })() : -1,
              scopeEnd: _hasScope ? (() => {
                if (inFunction) { const _fn = findFunctionInBuffer(buffer, inFunction); return _fn ? _fn.endRow : -1; }
                return text.substring(0, searchEnd).split('\n').length - 1;
              })() : -1,
            });

            // Build a plain-English label for the active hint so failures name it.
            const _activeHintLabel = afterString  ? `afterString:"${afterString.substring(0, 50)}"`
                                   : afterLine   != null ? `afterLine:${afterLine}`
                                   : beforeString ? `beforeString:"${beforeString.substring(0, 50)}"`
                                   : beforeLine  != null ? `beforeLine:${beforeLine}`
                                   : inFunction  ? `inFunction:"${inFunction}"`
                                   : betweenHint ? `betweenHint`
                                   : afterFunction  ? `afterFunction:"${afterFunction}"`
                                   : beforeFunction ? `beforeFunction:"${beforeFunction}"`
                                   : afterSymbol    ? `afterSymbol:"${afterSymbol}"`
                                   : beforeSymbol   ? `beforeSymbol:"${beforeSymbol}"`
                                   : null;

            if (_fullScan === null || _fullScan.total === 0) {
              // old_str not found anywhere in the file — stale or wrong.
              parts.push(
                `\n❌ NOT FOUND ANYWHERE — old_str does not appear anywhere in the file.` +
                (_activeHintLabel ? `\n   Hint used: ${_activeHintLabel}` : '') +
                `\n   Both the hint and the old_str content should be verified.` +
                `\n   → Re-read the target area with read-lines and rebuild old_str from current buffer content.`
              );
            } else {
              if (_hasScope && _fullScan.hitsInsideScope.length > 0) {
                // Match IS inside the search window but failed (whitespace/partialMatch).
                const _locs = _fullScan.hitsInsideScope.slice(0, 5)
                  .map(h => `L${h.line} (${h.funcCtx})`).join(', ');
                parts.push(
                  `\n🔍 MATCH LOCATION FOUND inside scope at ${_locs} — but exact text comparison failed (see whitespace/partial match detail above).` +
                  `\n   → Re-read lines around ${_fullScan.hitsInsideScope[0].line} with read-lines, rebuild old_str from the current buffer, then retry.`
                );
              }
              if (_hasScope && _fullScan.hitsOutsideScope.length > 0) {
                bump('str_replace', 'fails.foundOutsideScope');
                const _locs = _fullScan.hitsOutsideScope.slice(0, 5)
                  .map(h => `L${h.line} (${h.funcCtx})`).join(', ');
                parts.push(
                  `\n🚨 FOUND OUTSIDE SCOPE — old_str exists in the file but NOT inside ${scopeLabel || 'the active scope'}.` +
                  (_activeHintLabel ? ` (hint: ${_activeHintLabel})` : '') +
                  `\n   Hit(s) outside scope: ${_locs}${_fullScan.truncated ? ' …' : ''}` +
                  `\n   → Either widen the scope hint or change inFunction/betweenHint to target the right region.`
                );
              }
              if (!_hasScope) {
                // No scope hint — report all hits so LLM can pick the right one.
                const _allLocs = [..._fullScan.hitsInsideScope, ..._fullScan.hitsOutsideScope]
                  .slice(0, 5).map(h => `L${h.line} (${h.funcCtx})`).join(', ');
                parts.push(
                  `\n🔍 old_str found at ${_allLocs}${_fullScan.truncated ? ' …' : ''} — but exact match failed (see whitespace/partial match detail above).` +
                  `\n   → Re-read lines around the target, rebuild old_str from current buffer content, and add a scope hint (afterString/inFunction) to narrow the search.`
                );
              }
            }
          }

          // #5a: fault bucket — contentFaults (old_str not in buffer at all) vs hintFaults handled above
          if (wsIssues.length === 0 && partialMatchLines === 0) {
            bump('str_replace', 'faultBuckets.contentFaults');
          }
          // #5a: hintsFailed — bump for each hint that was active on this failed call
          if (inFunction)     bump('str_replace', 'hintsFailed.inFunction');
          if (afterFunction)  bump('str_replace', 'hintsFailed.afterFunction');
          if (beforeFunction) bump('str_replace', 'hintsFailed.beforeFunction');
          if (afterSymbol)    bump('str_replace', 'hintsFailed.afterSymbol');
          if (beforeSymbol)   bump('str_replace', 'hintsFailed.beforeSymbol');
          if (afterString)    bump('str_replace', 'hintsFailed.afterString');
          if (beforeString)   bump('str_replace', 'hintsFailed.beforeString');
          if (afterLine)      bump('str_replace', 'hintsFailed.afterLine');
          if (beforeLine)     bump('str_replace', 'hintsFailed.beforeLine');
          if (betweenHint)    bump('str_replace', 'hintsFailed.betweenHint');
          if (occurrence > 1) bump('str_replace', 'hintsFailed.occurrence');

          // -- Failure capture: diffVsBuffer + NDJSON log --
          let diffVsBuffer = null;
          {
            // Capture raw buffer lines around the failure point for the fault log viewer.
            // Uses diagOffset (fuzzy match row) as the anchor point.
            // ±5 lines, formatted as "L<n>: <content>" so old vs buffer is directly comparable.
            const _previewRow   = diagOffset;
            const _previewStart = Math.max(0, _previewRow - 5);
            const _previewEnd   = Math.min(allLines.length - 1, _previewRow + old_str.split('\n').length + 4);
            const bufferPreview = allLines
              .slice(_previewStart, _previewEnd + 1)
              .map((l, i) => `L${_previewStart + i + 1}: ${l}`)
              .join('\n');
            logFailure({
              tool: curTool,
              reason: wsIssues.length > 0 ? (hasEncodingIssue ? 'encoding' : 'whitespace')
                    : partialMatchLines > 0 ? 'partialMatch'
                    : (afterLine != null) ? 'hintFault:afterLine:contentMiss'
                    : (beforeLine != null) ? 'hintFault:beforeLine:contentMiss'
                    : 'noMatch',
              filePath: ctx.filePath,
              hintsSet: [betweenHint && 'betweenHint', inFunction && 'inFunction',
                         afterString && 'afterString', beforeString && 'beforeString',
                         afterLine && 'afterLine', beforeLine && 'beforeLine',
                         afterFunction && 'afterFunction', beforeFunction && 'beforeFunction',
                         afterSymbol && 'afterSymbol', beforeSymbol && 'beforeSymbol',
                         occurrence > 1 && 'occurrence'].filter(Boolean),
              oldStrPreview: old_str.split('\n').slice(0, 6).map((l, i) => `[${i + 1}]: ${l}`).join('\n'),
              diffVsBuffer,
              bufferPreview,
            });
          }

          return {
            content: [{ type: "text", text: parts.join("\n") }],
            matched: false,
            consecFailures: ctx.consec.count
          };
        }

        // -- Match found — dry-run or commit -----------------------------------
        const surroundRadius = 3;
        const ctxStart = Math.max(0, matchLine - surroundRadius);
        const matchLines = effectiveOldStr.split("\n");
        const ctxEnd   = Math.min(allLines.length - 1, matchLine + matchLines.length - 1 + surroundRadius);

        if (dryRun) {
          const preview = allLines.slice(ctxStart, ctxEnd + 1)
            .map((l, i) => {
              const abs = ctxStart + i;
              const inMatch = abs >= matchLine && abs < matchLine + matchLines.length;
              return `${String(abs + 1).padStart(4)}${inMatch ? " ?" : "  "} ${l}`;
            }).join("\n");

          const diffLines = matchLines.map(l => `- ${l}`).concat(new_str.split("\n").map(l => `+ ${l}`)).join("\n");

          return {
            content: [{ type: "text", text: [
              `? DRY RUN — match found at line ${matchLine + 1}${scopeLabel}${occurrence > 1 ? ` (occurrence ${occurrence})` : ""}${fuzzyWhitespace ? " [fuzzyWhitespace]" : ""}${fuzzyContent ? " [fuzzyContent]" : ""}${regex ? " [regex]" : ""}.`,
              `\nContext (? = lines to be replaced):\n${preview}`,
              `\nProposed diff:\n${diffLines}`,
              `\nReply with the same call without dryRun (or dryRun:false) to commit.`
            ].join("\n") }],
            matched: true,
            dryRun: true,
            matchLine: matchLine + 1
          };
        }

        // -- Ambiguity guard (shared helper) ---------------------------------
        // noScopeHint must cover EVERY hint that narrows searchStart/searchEnd.
        // Missing any hint here causes the guard to scan the full buffer and
        // fire false ambiguity errors even when a scope is active (BUG-A).
        // _hasScope declared at top of handler
        const _ambig = ambiguityCheck({
          needle: effectiveOldStr, fullText: text,
          // Pass the already-narrowed region so the guard counts occurrences
          // inside the scope only, not the whole buffer (fixes BUG-A).
          scopedText: (searchStart > 0 || searchEnd < text.length)
            ? text.substring(searchStart, searchEnd)
            : undefined,
          noScopeHint: !_hasScope,
          toolName: curTool, isCodeFile,
        });
        if (_ambig) { bump('str_replace', 'fails.ambiguous'); ctx.consec.count++; return _ambig; }

        // Commit the replacement
        const endIndex  = matchIndex + effectiveOldStr.length;
        const startPos  = buffer.positionForCharacterIndex(matchIndex);
        const endPos    = buffer.positionForCharacterIndex(endIndex);
        const originalText = buffer.getText();
        const _preSnap = preEditSnapshot(editor);
        buffer.setTextInRange([startPos, endPos], effectiveNewStr);
        decorateEditedLines(editor, originalText, buffer.getText());
        const _structSuffix = postEditDelta(_preSnap, editor).struct;

        ctx.consec.count = 0; // reset on success
        bump('str_replace', 'hits');
        bump('str_replace', '_oldStrLenSum', old_str.split("\n").length);
        if (fuzzyWhitespace) bump('str_replace', 'fuzzyWhitespaceCommits');
        if (fuzzyContent)    bump('str_replace', 'fuzzyContentCommits');
        if (regex)           bump('str_replace', 'regexCommits');

        // #5a: hintsSucceeded — bump for each hint active on this successful call
        if (inFunction)     bump('str_replace', 'hintsSucceeded.inFunction');
        if (afterFunction)  bump('str_replace', 'hintsSucceeded.afterFunction');
        if (beforeFunction) bump('str_replace', 'hintsSucceeded.beforeFunction');
        if (afterSymbol)    bump('str_replace', 'hintsSucceeded.afterSymbol');
        if (beforeSymbol)   bump('str_replace', 'hintsSucceeded.beforeSymbol');
        if (afterString)    bump('str_replace', 'hintsSucceeded.afterString');
        if (beforeString)   bump('str_replace', 'hintsSucceeded.beforeString');
        if (afterLine)      bump('str_replace', 'hintsSucceeded.afterLine');
        if (beforeLine)     bump('str_replace', 'hintsSucceeded.beforeLine');
        if (betweenHint)    bump('str_replace', 'hintsSucceeded.betweenHint');
        if (occurrence > 1) bump('str_replace', 'hintsSucceeded.occurrence');

        const _nudge = successNudge({
          toolName: curTool,
          noHintsUsed: !_hasScope,
          afterLineOnly: (afterLine != null) && !inFunction && !betweenHint &&
                         !afterFunction && !beforeFunction && !afterSymbol && !beforeSymbol &&
                         !afterString && !beforeString,
          matchedLineContent: allLines[matchLine] || '',
          fileLines: allLines.length,
          oldStr: old_str,
          isCodeFile,
        });
        const _lintSuffix  = await maybeLintSuffix(lint, editor, matchLine, matchLine + effectiveNewStr.split("\n").length - 1);
        const _styleSuffix = applyStyleCheck(effectiveNewStr, ctx.filePath); // B23
        const _tags = [
          fuzzyWhitespace ? (autoFuzzyWhitespace ? 'autoFuzzyWhitespace' : 'fuzzyWhitespace') : '',
          fuzzyContent    ? (autoFuzzyContent    ? 'autoFuzzyContent'    : 'fuzzyContent')    : '',
          regex           ? 'regex'           : '',
          autoStripComment  ? 'autoStripComment'  : '',
          autoPartialMatch  ? 'autoPartialMatch'  : '',
          occurrence > 1  ? `occurrence:${occurrence}` : '',
        ].filter(Boolean);
        return {
          ...buildEditResponse(
            { tool: curTool, line: matchLine + 1, linesChanged: new_str.split('\n').length - old_str.split('\n').length, scopeLabel, tags: _tags },
            { nudge: _nudge, lint: _lintSuffix, style: _styleSuffix, struct: _structSuffix }
          ),
          matched: true,
          dryRun: false,
          replacedAtLine: matchLine + 1
        };
    },
  });

  // -- find-text (migrated to Tool Framework) ---------------------------------
  if (g('search')) registerMcpTool({
    name:           'find-text',
    group:          'search',
    category:       'search',
    requiresEditor: true,
    title:          'Find Text',
    description: [
      'Find all occurrences of a string or regex in the active editor and return their line numbers.',
      'USE THIS TO: count how many times a pattern appears before deciding to use str_replace vs replace-all; get the exact line numbers and occurrence indices for a pattern before editing; confirm a pattern exists before attempting an edit.',
      'occurrence:N \u2014 return only the Nth match with its context. Use this to get the exact line number of a specific instance, then pass that line number to str_replace afterLine.',
      'contextLines:N \u2014 return N lines before and after each match. Use this to verify the surrounding code, not just the match line.',
      'regex:true \u2014 treat query as a regular expression. caseSensitive:true \u2014 case-sensitive matching (default is case-insensitive).',
      'Returns totalMatches so you know how many times the pattern appears \u2014 if totalMatches > 1 you should use occurrence:N or a hint with str_replace to avoid hitting the wrong instance.',
    ].join(' '),
    inputSchema: {
      query:         z.string(),
      regex:         z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      maxMatches:    z.number().optional(),
      contextLines:  z.number().optional(),
      occurrence:    z.number().optional(),
    },
    handler: async ({ query, regex = false, caseSensitive = false, maxMatches = 200, contextLines = 0, occurrence = 0 }, ctx) => {
      const text   = ctx.text;
      const source = regex ? query : escapeRegex(query);
      const flags  = caseSensitive ? '' : 'i';
      let pattern;
      try { pattern = new RegExp(source, flags); }
      catch (e) { return ctx.fail('invalidRegex', `Invalid regex: ${e.message}`); }

      const lines     = text.split(/\r?\n/);
      const matches   = [];
      let truncated   = false;
      let globalIndex = 0;

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
        logFailure('find_text', 'noMatch', ctx.editor, null, null, query);
        return ctx.fail('noMatch', `occurrence ${occurrence} not found \u2014 only ${globalIndex} match(es) in file.`);
      }

      if (matches.length === 0) {
        logFailure('find_text', 'noMatch', ctx.editor, null, null, query);
        bump('find_text', 'fails.noMatch');
        return { content: [{ type: 'text', text: 'No matches.' }], matches: [], totalMatches: 0, truncated: false };
      }

      bump('find_text', 'hits');
      if (occurrence > 0) bump('find_text', 'hintsUsed.occurrence');
      if (contextLines > 0) bump('find_text', 'hintsUsed.contextLines');
      return {
        content: [{ type: 'text', text: JSON.stringify({ matches, totalMatches: matches.length, truncated, message: truncated ? `Results capped at ${maxMatches}. Refine your query or increase maxMatches.` : 'All matches found.' }, null, 2) }],
        matches, totalMatches: matches.length, truncated,
      };
    },
  });

  // ── replace-document (migrated to Tool Framework) ──────────────────────
  if (g('edit')) registerMcpTool({
    name:     'replace-document',
    group:    'edit',
    category: 'edit',
    features: { styleCheck: true },
    title:       'Replace Document',
    description: [
      'Replace the entire contents of the editor with rewritten text.',
      'Useful for large edits. Returns lineCount and sample of first 10 lines to verify replacement worked.',
      'Workflow hint: call get-filename to confirm the right file is active. Call get-document first only if you need to read the current content before rewriting \u2014 skip it if you already have the full text.',
    ].join(' '),
    inputSchema: { text: z.string() },
    handler: async ({ text }, ctx) => {
      ctx.snapshotOriginal();
      ctx.buffer.setText(text);

      const lines       = text.split(/\r?\n/);
      const sampleLines = lines.slice(0, 10).map((t, i) => `${i + 1}: ${t}`);
      const checksum    = text.substring(0, 500).split('').reduce((a, b) => { a = ((a << 5) - a) + b.charCodeAt(0); return a & a; }, 0);
      const linesChanged = lines.length - ctx._originalText.split(/\r?\n/).length;

      const _styleSuffix = applyStyleCheck(text, ctx.editor.getPath());
      return {
        ...(await ctx.commit(
          { line: 1, linesChanged, scopeLabel: '', tags: [] },
          { style: _styleSuffix }
        )),
        lineCount: lines.length, checksum, sampleLines,
      };
    },
  });

  // ── insert (migrated to Tool Framework) ────────────────────────────────
  if (g('edit')) registerMcpTool({
    name:     'insert',
    group:    'edit',
    category: 'edit',
    features: { dryRun: true, lint: true, styleCheck: true, consecutiveFailureCounter: true },
    title:    'Insert',
    description: [
      "Insert new lines into the active editor without modifying any existing content. Use this when adding code, not changing it.",
      "DECISION \u2014 how to anchor the insert position:",
      "(0) Appending to the end of the file? \u2192 endOfFile:true \u2014 the simplest and most reliable option for any 'add to end' operation.",
      "(1) Know a function name near the insert point? \u2192 afterFunction:'fnName' inserts after that function's closing brace; beforeFunction:'fnName' inserts before its opening line. Tree-sitter backed \u2014 drift-immune.",
      "(2) Know a unique string on a nearby line? \u2192 afterString:'some text' inserts after the line containing that text; beforeString:'some text' inserts before it.",
      "(3) Know any other named symbol (class, struct, const)? \u2192 afterSymbol:'name' / beforeSymbol:'name' \u2014 same as afterFunction but for any tree-sitter symbol.",
      "(4) Same anchor string appears multiple times? \u2192 occurrence:N to target the Nth match.",
      "(5) Only know a line number? \u2192 insert_line:N (1-based) inserts AFTER line N, matching standard editor convention \u2014 but CAUTION: line numbers shift after every insert; use read-lines to verify current numbers first.",
      "dryRun:true previews what will be inserted and where without writing \u2014 use this before any insert you're unsure about.",
      "WARNING: after any insert, all line numbers below the insertion point shift. Never use stale line numbers for a subsequent edit \u2014 call read-lines to get updated positions.",
    ].join(" "),
    inputSchema: {
      new_str:         z.string(),
      endOfFile:       z.boolean().optional(),
      insert_line:     z.number().optional(),
      afterFunction:   z.string().optional(),
      beforeFunction:  z.string().optional(),
      afterSymbol:     z.string().optional(),
      beforeSymbol:    z.string().optional(),
      afterString:     z.string().optional(),
      beforeString:    z.string().optional(),
      ...STRUCTURAL_ANCHOR_SCHEMA,
    },
    handler: async ({ insert_line, new_str, endOfFile = false, afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterString, beforeString, afterContent, beforeContent, inFunction, functionEnd, hintRadius, occurrence = 1, dryRun = false, lint = false }, ctx) => {
            const { editor, buffer, allLines } = ctx;
      const curTool   = 'insert';
      const lineCount = allLines.length;
      const isCodeFile = isCodeFilePath(ctx.filePath); // B23
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
            `\nReply with the same call without dryRun (or dryRun:false) to commit.`
          ].join("\n") }], dryRun: true, insertRow: insertRow + 1, lineCount };
        }
        const textWithNewline = new_str.endsWith("\n") ? new_str : new_str + "\n";
        buffer.insert([insertRow, 0], textWithNewline);
        ctx.consec.count = 0; bump('insert', 'hits');
        const newLineCount = buffer.getLineCount();
        const _lintSuffix  = await maybeLintSuffix(lint, editor, insertRow, insertRow + new_str.split("\n").length - 1);
        const _styleSuffix = applyStyleCheck(new_str, ctx.filePath);
        return {
          ...buildEditResponse({ tool: curTool, line: insertRow + 1, linesChanged: new_str.split('\n').length, scopeLabel: ' at end of file' }, { lint: _lintSuffix, style: _styleSuffix }),
          dryRun: false, newLineCount
        };
      }

      // -- afterFunction / beforeFunction ------------------------------------
      if (afterFunction !== undefined || beforeFunction !== undefined) {
        const hintName  = afterFunction !== undefined ? 'afterFunction' : 'beforeFunction';
        const hintVal   = afterFunction !== undefined ? afterFunction : beforeFunction;
        const dir       = afterFunction !== undefined ? 'after' : 'before';
        bump('insert', `hintsUsed.${hintName}`);
        if (occurrence > 1) bump('insert', 'hintsUsed.occurrence');
        const allSymbols = getSymbols(editor, null, ctx.filePath);
        const r = resolveSymbolPosition(allSymbols, hintVal, 'function', dir, _radius);
          logHintFailure({ tool: curTool, hintName, hintValue: hintVal, reason: 'notFound', filePath: ctx.filePath, oldStr: null });
        if (r.notFound) {
          ctx.consec.count++;
          bump('insert', 'fails.anchorNotFound');
          const known = allSymbols.filter(s => ['function','registerTool'].includes(s.kind)).map(s => `  ${s.startRow + 1}: ${s.name}`).slice(0, 20);
          return { content: [{ type: 'text', text: [`\u274C ${hintName}: function "${hintVal}" not found.`, `Known functions:\n${known.join('\n') || '  (none)'}`, smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: false, fileLines: lineCount, oldStr: null, isCodeFile })].filter(Boolean).join('\n') }], inserted: false };
        }
          logHintFailure({ tool: curTool, hintName, hintValue: hintVal, reason: 'ambiguous', filePath: ctx.filePath, oldStr: null });
        if (r.ambiguous) {
          ctx.consec.count++;
          bump('insert', 'fails.anchorNotFound');
          const list = r.matches.map(m => `  line ${m.startRow + 1}: ${m.name}`).join('\n');
          return { content: [{ type: 'text', text: `\u274C ${hintName}: "${hintVal}" is ambiguous:\n${list}\nUse occurrence:N to disambiguate.` }], inserted: false };
        }
        const insertRow  = dir === 'after' ? r.anchorRow + 1 : r.anchorRow;
        const scopeLabel = ` ${hintName} "${hintVal}" (anchor line ${r.anchorRow + 1})`;
        if (dryRun) {
          const rd = 3;
          const cs = Math.max(0, insertRow - rd);
          const ce = Math.min(lineCount - 1, insertRow + rd);
          const ctxLines = allLines.slice(cs, insertRow).map((l, i) => `${String(cs + i + 1).padStart(4)}   ${l}`);
          const insLines = new_str.split('\n').map(l => `${' '.repeat(4)} + ${l}`);
          const aftLines = allLines.slice(insertRow, ce + 1).map((l, i) => `${String(insertRow + i + 1).padStart(4)}   ${l}`);
          return { content: [{ type: 'text', text: [`\uD83D\uDD0D DRY RUN \u2014 will insert ${new_str.split('\n').length} line(s)${scopeLabel}.`, `\nContext (+ = lines to be inserted):\n${[...ctxLines, ...insLines, ...aftLines].join('\n')}`, `\nReply with the same call without dryRun (or dryRun:false) to commit.`].join('\n') }], dryRun: true, insertRow: insertRow + 1, lineCount };
        }
        const textWithNewline = new_str.endsWith('\n') ? new_str : new_str + '\n';
        buffer.insert([insertRow, 0], textWithNewline);
        ctx.consec.count = 0; bump('insert', 'hits');
        const newLineCount = buffer.getLineCount();
        const _lintSuffixAF  = await maybeLintSuffix(lint, editor, insertRow, insertRow + new_str.split('\n').length - 1);
        const _styleSuffixAF = applyStyleCheck(new_str, ctx.filePath);
        return { ...buildEditResponse({ tool: curTool, line: insertRow + 1, linesChanged: new_str.split('\n').length, scopeLabel, tags: ['staleLinesWarning'] }, { lint: _lintSuffixAF, style: _styleSuffixAF }), dryRun: false, newLineCount };
      }

      // -- afterSymbol / beforeSymbol ----------------------------------------
      if (afterSymbol !== undefined || beforeSymbol !== undefined) {
        const hintName  = afterSymbol !== undefined ? 'afterSymbol' : 'beforeSymbol';
        const hintVal   = afterSymbol !== undefined ? afterSymbol : beforeSymbol;
        const dir       = afterSymbol !== undefined ? 'after' : 'before';
        bump('insert', `hintsUsed.${hintName}`);
        if (occurrence > 1) bump('insert', 'hintsUsed.occurrence');
        const allSymbols = getSymbols(editor, null, ctx.filePath);
        const r = resolveSymbolPosition(allSymbols, hintVal, 'any', dir, _radius);
          logHintFailure({ tool: curTool, hintName, hintValue: hintVal, reason: 'needsTreeSitter', filePath: ctx.filePath, oldStr: null });
        if (r.needsTreeSitter) {
          ctx.consec.count++;
          bump('insert', 'fails.anchorNotFound');
          return { content: [{ type: 'text', text: `\u274C ${hintName}: requires the file to be open in the editor with a grammar assigned (no tree-sitter parse tree found).` }], inserted: false };
        }
          logHintFailure({ tool: curTool, hintName, hintValue: hintVal, reason: 'notFound', filePath: ctx.filePath, oldStr: null });
        if (r.notFound) {
          ctx.consec.count++;
          bump('insert', 'fails.anchorNotFound');
          const known = allSymbols.map(s => `  ${s.startRow + 1}: ${s.name} [${s.kind}]`).slice(0, 20);
          return { content: [{ type: 'text', text: [`\u274C ${hintName}: "${hintVal}" not found.`, `Known symbols:\n${known.join('\n') || '  (none)'}`, smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: false, fileLines: lineCount, oldStr: null, isCodeFile })].filter(Boolean).join('\n') }], inserted: false };
        }
          logHintFailure({ tool: curTool, hintName, hintValue: hintVal, reason: 'ambiguous', filePath: ctx.filePath, oldStr: null });
        if (r.ambiguous) {
          ctx.consec.count++;
          bump('insert', 'fails.anchorNotFound');
          const list = r.matches.map(m => `  line ${m.startRow + 1}: ${m.name} [${m.kind}]`).join('\n');
          return { content: [{ type: 'text', text: `\u274C ${hintName}: "${hintVal}" is ambiguous:\n${list}\nUse occurrence:N to disambiguate.` }], inserted: false };
        }
        const insertRow  = dir === 'after' ? r.anchorRow + 1 : r.anchorRow;
        const scopeLabel = ` ${hintName} "${hintVal}" (anchor line ${r.anchorRow + 1})`;
        if (dryRun) {
          const rd = 3;
          const cs = Math.max(0, insertRow - rd);
          const ce = Math.min(lineCount - 1, insertRow + rd);
          const ctxLines = allLines.slice(cs, insertRow).map((l, i) => `${String(cs + i + 1).padStart(4)}   ${l}`);
          const insLines = new_str.split('\n').map(l => `${' '.repeat(4)} + ${l}`);
          const aftLines = allLines.slice(insertRow, ce + 1).map((l, i) => `${String(insertRow + i + 1).padStart(4)}   ${l}`);
          return { content: [{ type: 'text', text: [`\uD83D\uDD0D DRY RUN \u2014 will insert ${new_str.split('\n').length} line(s)${scopeLabel}.`, `\nContext (+ = lines to be inserted):\n${[...ctxLines, ...insLines, ...aftLines].join('\n')}`, `\nReply with the same call without dryRun (or dryRun:false) to commit.`].join('\n') }], dryRun: true, insertRow: insertRow + 1, lineCount };
        }
        const textWithNewline = new_str.endsWith('\n') ? new_str : new_str + '\n';
        buffer.insert([insertRow, 0], textWithNewline);
        ctx.consec.count = 0; bump('insert', 'hits');
        const newLineCount = buffer.getLineCount();
        const _lintSuffixAS  = await maybeLintSuffix(lint, editor, insertRow, insertRow + new_str.split('\n').length - 1);
        const _styleSuffixAS = applyStyleCheck(new_str, ctx.filePath);
        return { ...buildEditResponse({ tool: curTool, line: insertRow + 1, linesChanged: new_str.split('\n').length, scopeLabel, tags: ['staleLinesWarning'] }, { lint: _lintSuffixAS, style: _styleSuffixAS }), dryRun: false, newLineCount };
      }

      // -- afterString / beforeString ----------------------------------------
      if (afterString !== undefined || beforeString !== undefined) {
        const hintName  = afterString !== undefined ? 'afterString' : 'beforeString';
        const hintVal   = afterString !== undefined ? afterString : beforeString;
        const dir       = afterString !== undefined ? 'after' : 'before';
        bump('insert', `hintsUsed.${hintName}`);
        if (occurrence > 1) bump('insert', 'hintsUsed.occurrence');
        const r = resolveStringPosition(allLines, hintVal, dir, _radius);
          logHintFailure({ tool: curTool, hintName, hintValue: hintVal, reason: 'notFound', filePath: ctx.filePath, oldStr: null });
        if (r.notFound) {
          ctx.consec.count++;
          bump('insert', 'fails.anchorNotFound');
          return { content: [{ type: 'text', text: [`\u274C ${hintName}: "${hintVal.substring(0, 60)}" not found in file.`, smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: false, fileLines: lineCount, oldStr: null, isCodeFile })].filter(Boolean).join('\n') }], inserted: false };
        }
          logHintFailure({ tool: curTool, hintName, hintValue: hintVal, reason: 'ambiguous', filePath: ctx.filePath, oldStr: null });
        if (r.ambiguous) {
          ctx.consec.count++;
          bump('insert', 'fails.anchorNotFound');
          const lines = r.rows.map(row => `  line ${row + 1}`).join('\n');
          return { content: [{ type: 'text', text: `\u274C ${hintName}: "${hintVal.substring(0, 60)}" found on ${r.rows.length} lines \u2014 use a more unique string:\n${lines}` }], inserted: false };
        }
        const insertRow  = dir === 'after' ? r.anchorRow + 1 : r.anchorRow;
        const scopeLabel = ` ${hintName} "${hintVal.substring(0, 40)}" (anchor line ${r.anchorRow + 1})`;
        if (dryRun) {
          const rd = 3;
          const cs = Math.max(0, insertRow - rd);
          const ce = Math.min(lineCount - 1, insertRow + rd);
          const ctxLines = allLines.slice(cs, insertRow).map((l, i) => `${String(cs + i + 1).padStart(4)}   ${l}`);
          const insLines = new_str.split('\n').map(l => `${' '.repeat(4)} + ${l}`);
          const aftLines = allLines.slice(insertRow, ce + 1).map((l, i) => `${String(insertRow + i + 1).padStart(4)}   ${l}`);
          return { content: [{ type: 'text', text: [`\uD83D\uDD0D DRY RUN \u2014 will insert ${new_str.split('\n').length} line(s)${scopeLabel}.`, `\nContext (+ = lines to be inserted):\n${[...ctxLines, ...insLines, ...aftLines].join('\n')}`, `\nReply with the same call without dryRun (or dryRun:false) to commit.`].join('\n') }], dryRun: true, insertRow: insertRow + 1, lineCount };
        }
        const textWithNewline = new_str.endsWith('\n') ? new_str : new_str + '\n';
        buffer.insert([insertRow, 0], textWithNewline);
        ctx.consec.count = 0; bump('insert', 'hits');
        const newLineCount = buffer.getLineCount();
        const _lintSuffixSS  = await maybeLintSuffix(lint, editor, insertRow, insertRow + new_str.split('\n').length - 1);
        const _styleSuffixSS = applyStyleCheck(new_str, ctx.filePath);
        return { ...buildEditResponse({ tool: curTool, line: insertRow + 1, linesChanged: new_str.split('\n').length, scopeLabel, tags: ['staleLinesWarning'] }, { lint: _lintSuffixSS, style: _styleSuffixSS }), dryRun: false, newLineCount };
      }

      // -- functionEnd structural anchor -------------------------------------
      if (functionEnd !== undefined) {
        bump('insert', 'hintsUsed.functionEnd');
        if (occurrence > 1) bump('insert', 'hintsUsed.occurrence');
          logHintFailure({ tool: curTool, hintName: 'functionEnd', hintValue: functionEnd, reason: 'notFound', filePath: ctx.filePath, oldStr: null });
        const resolved = resolveStructuralAnchor(buffer, { functionEnd });
        if (!resolved) {
          bump('insert', 'fails.anchorNotFound');
          return { content: [{ type: "text", text: `\u274C functionEnd: function "${functionEnd}" not found. Use get-structural-anchors to list available function names.` }], inserted: false };
        }
        const insertRow  = resolved.endRow + 1;
        const scopeLabel = ` after end of "${functionEnd}"`;
        if (dryRun) {
          const r        = 3;
          const cs       = Math.max(0, resolved.endRow - r);
          const ce       = Math.min(lineCount - 1, insertRow + r);
          const ctxLines = allLines.slice(cs, insertRow).map((l, i) => `${String(cs + i + 1).padStart(4)}   ${l}`);
          const insLines = new_str.split("\n").map(l => `${" ".repeat(4)} + ${l}`);
          const aftLines = allLines.slice(insertRow, ce + 1).map((l, i) => `${String(insertRow + i + 1).padStart(4)}   ${l}`);
          return { content: [{ type: "text", text: [
            `\uD83D\uDD0D DRY RUN \u2014 will insert ${new_str.split("\n").length} line(s)${scopeLabel} (after line ${resolved.endRow + 1}).`,
            `\nContext (+ = lines to be inserted):\n${[...ctxLines, ...insLines, ...aftLines].join("\n")}`,
            `\nReply with the same call without dryRun (or dryRun:false) to commit.`
          ].join("\n") }], dryRun: true, insertRow: insertRow + 1, lineCount };
        }
        const textWithNewline = new_str.endsWith("\n") ? new_str : new_str + "\n";
        buffer.insert([insertRow, 0], textWithNewline);
        ctx.consec.count = 0; bump('insert', 'hits');
        const newLineCount = buffer.getLineCount();
        const _lintSuffixFE  = await maybeLintSuffix(lint, editor, insertRow, insertRow + new_str.split("\n").length - 1);
        const _styleSuffixFE = applyStyleCheck(new_str, ctx.filePath);
        return {
          ...buildEditResponse({ tool: curTool, line: insertRow + 1, linesChanged: new_str.split('\n').length, scopeLabel, tags: ['staleLinesWarning'] }, { lint: _lintSuffixFE, style: _styleSuffixFE }),
          dryRun: false, newLineCount
        };
      }

      // -- Content-anchored insert (afterContent / beforeContent) -----------
      if (afterContent !== undefined || beforeContent !== undefined) {
        if (afterContent  !== undefined) bump('insert', 'hintsUsed.afterContent');
        if (beforeContent !== undefined) bump('insert', 'hintsUsed.beforeContent');
        if (inFunction)                bump('insert', 'hintsUsed.inFunction');
        if (occurrence > 1)              bump('insert', 'hintsUsed.occurrence');
        const anchor      = afterContent !== undefined ? afterContent : beforeContent;
        const insertAfter = afterContent !== undefined;
        const scopeLabel  = inFunction ? ` within function "${inFunction}"` : "";

        const hit = findAnchor(buffer, anchor, { occurrence, inFunction });

        if (!hit) {
          ctx.consec.count++;
          bump('insert', 'fails.anchorNotFound');
          logFailure({
            tool: 'insert', reason: 'anchorNotFound', filePath: ctx.filePath,
            afterLineOnly: false,
            hintsSet: [inFunction && 'inFunction', afterContent !== undefined && 'afterContent', beforeContent !== undefined && 'beforeContent'].filter(Boolean),
            bufferPreview: (() => {
              const _fn = inFunction ? findFunctionInBuffer(buffer, inFunction) : null;
              const _s  = _fn ? _fn.startRow : 0;
              return allLines.slice(_s, Math.min(allLines.length - 1, _s + 15) + 1)
                .map((l, i) => `L${_s + i + 1}: ${l}`).join('\n');
            })(),
            scopeLines: (() => {
              const _fn = inFunction ? findFunctionInBuffer(buffer, inFunction) : null;
              return _fn ? `L${_fn.startRow + 1}\u2013L${_fn.endRow + 1} (function scope)` : 'no scope';
            })()
          });
          const fn          = inFunction ? findFunctionInBuffer(buffer, inFunction) : null;
          const previewFrom = fn ? fn.startRow : 0;
          const previewTo   = Math.min(allLines.length - 1, previewFrom + 10);
          const ctx2        = allLines.slice(previewFrom, previewTo + 1)
            .map((l, i) => `${String(previewFrom + i + 1).padStart(4)}: ${l}`).join("\n");
          return { content: [{ type: "text", text: [
            `\u274C ${insertAfter ? "afterContent" : "beforeContent"} not found${scopeLabel}: "${anchor}"`,
            inFunction && !fn ? `   (inFunction "${inFunction}" was also not found \u2014 check the function name)` : "",
            `\n\u26A0\uFE0F ${fn ? `Start of "${inFunction}"` : "Top of file"} \u2014 pick a single unique anchor line from here:\n${ctx2}`,
            `\n\uD83D\uDCA1 Tip: use a single unique line as anchor. Use inFunction to scope to a function body.`,
            smartSuggestion({ toolName: "insert", counter: ctx.consec, noHintsUsed: !inFunction && !afterContent && !beforeContent, fileLines: lineCount, oldStr: null, isCodeFile })
          ].filter(Boolean).join("\n") }], inserted: false, consecFailures: ctx.consec.count };
        }

        const anchorRow   = hit.row;
        const anchorEnd   = hit.row + hit.matchedRows - 1;
        const insertRow   = insertAfter ? anchorEnd + 1 : anchorRow;
        const strategyMsg = hit.strategy !== "exact" ? ` (matched via ${hit.strategy} \u2014 consider tightening your anchor)` : "";

        if (dryRun) {
          const r  = 3;
          const cs = Math.max(0, insertRow - r - (insertAfter ? 0 : 1));
          const ce = Math.min(lineCount - 1, insertRow + r);
          const ctxLines  = allLines.slice(cs, Math.min(insertRow, ce + 1)).map((l, i) => `${String(cs + i + 1).padStart(4)}   ${l}`);
          const insLines  = new_str.split("\n").map(l => `${" ".repeat(4)} + ${l}`);
          const afterLines = allLines.slice(insertRow, ce + 1).map((l, i) => `${String(insertRow + i + 1).padStart(4)}   ${l}`);
          return { content: [{ type: "text", text: [
            `\uD83D\uDD0D DRY RUN \u2014 will insert ${new_str.split("\n").length} line(s) ${insertAfter ? "after" : "before"} anchor (line ${anchorRow + 1})${scopeLabel}${strategyMsg}.`,
            `\nContext (+ = lines to be inserted):\n${[...ctxLines, ...insLines, ...afterLines].join("\n")}`,
            `\nReply with the same call without dryRun (or dryRun:false) to commit.`
          ].join("\n") }], dryRun: true, insertRow: insertRow + 1, lineCount };
        }

        const textWithNewline = new_str.endsWith("\n") ? new_str : new_str + "\n";
        buffer.insert([insertRow, 0], textWithNewline);
        ctx.consec.count = 0; bump('insert', 'hits');
        const newLineCount = buffer.getLineCount();
        const _lintSuffix2  = await maybeLintSuffix(lint, editor, insertRow, insertRow + new_str.split("\n").length - 1);
        const _styleSuffix2 = applyStyleCheck(new_str, ctx.filePath);
        return {
          ...buildEditResponse({ tool: curTool, line: anchorRow + 1, linesChanged: new_str.split('\n').length, scopeLabel, tags: ['staleLinesWarning'] }, { lint: _lintSuffix2, style: _styleSuffix2 }),
          dryRun: false, newLineCount
        };
      }

      // -- Line-number-based insert (legacy) ---------------------------------
      if (insert_line === undefined) {
        return { content: [{ type: "text", text: "\u274C Either insert_line, afterFunction/beforeFunction, afterString/beforeString, afterSymbol/beforeSymbol, afterContent/beforeContent, functionEnd, or endOfFile is required." }], inserted: false };
      }

      if (insert_line < 1 || insert_line > lineCount + 1) {
        ctx.consec.count++;
        bump('insert', 'fails.outOfRange');
        const r   = 4;
        const cs  = Math.max(0, lineCount - r);
        const ctx2 = allLines.slice(cs).map((l, i) => `${String(cs + i + 1).padStart(4)}: ${l}`).join("\n");
        return { content: [{ type: "text", text: [
          `\u274C insert_line ${insert_line} is out of range (1\u2013${lineCount + 1}). File has ${lineCount} lines.`,
          `\n\u26A0\uFE0F End of file:\n${ctx2}`,
          smartSuggestion({ toolName: "insert", counter: ctx.consec, noHintsUsed: true, fileLines: lineCount, oldStr: null, isCodeFile })
        ].filter(Boolean).join("\n") }], inserted: false, consecFailures: ctx.consec.count };
      }

      if (dryRun) {
        const radius   = 3;
        const ctxStart = Math.max(0, insert_line - 1 - radius);
        const ctxEnd   = Math.min(lineCount - 1, insert_line - 1 + radius);
        const before   = allLines.slice(ctxStart, insert_line).map((l, i) => `${String(ctxStart + i + 1).padStart(4)}   ${l}`);
        const inserted = new_str.split("\n").map(l => `${" ".repeat(4)} + ${l}`);
        const after    = allLines.slice(insert_line, ctxEnd + 1).map((l, i) => `${String(insert_line + i + 1).padStart(4)}   ${l}`);
        return { content: [{ type: "text", text: [
          `🔍 DRY RUN — will insert ${new_str.split("\n").length} line(s) after line ${insert_line}.`,
          `\nContext (+ = lines to be inserted):\n${[...before, ...inserted, ...after].join("\n")}`,
          `\nReply with the same call without dryRun (or dryRun:false) to commit.`
        ].join("\n") }], dryRun: true, insert_line, lineCount };
      }

      const row             = insert_line; // insert AFTER line N — row is 0-based, so insert_line maps to the row after line N
      const textWithNewline = new_str.endsWith("\n") ? new_str : new_str + "\n";
      buffer.insert([row, 0], textWithNewline);
      ctx.consec.count = 0; bump('insert', 'hits');
      const newLineCount = buffer.getLineCount();
      const _lintSuffix3  = await maybeLintSuffix(lint, editor, row, row + new_str.split("\n").length - 1);
      const _styleSuffix3 = applyStyleCheck(new_str, ctx.filePath);
      return {
        ...buildEditResponse({ tool: curTool, line: insert_line, linesChanged: new_str.split('\n').length, tags: ['staleLinesWarning'] }, { lint: _lintSuffix3, style: _styleSuffix3 }),
        dryRun: false, newLineCount
      };
    },
  });




  registerMcpTool({
    name: 'delete-line',
    group: 'edit',
    category: 'edit',
    requiresEditor: true,
    title: 'Delete Line',
    description: "DEPRECATED: use delete-line-range instead. Delete the specified line number (1-based). WARNING: line numbers shift after every delete - always call get-document again before the next line-based edit.",
    inputSchema: { lineNumber: z.number() },
    async handler({ lineNumber }, ctx) {
      const { editor, buffer } = ctx;
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
  });


  // ── delete-line-range (migrated to Tool Framework) ─────────────────────
  if (g('edit')) registerMcpTool({
    name:     'delete-line-range',
    group:    'edit',
    category: 'edit',
    features: { dryRun: true, lint: true, consecutiveFailureCounter: true },
    title:    'Delete Line Range',
    description: [
      "Delete a contiguous range of lines from the active editor.",
      "DECISION \u2014 how to specify what to delete:",
      "(1) Want to delete an entire named function? \u2192 inFunction:'myFn' \u2014 deletes the complete function body including its signature. No line numbers needed.",
      "(2) Know unique text that surrounds the block to delete? \u2192 betweenHint:{start:'...', end:'...'} \u2014 resolves both start and end lines from content anchors, immune to line drift.",
      "(3) Know a unique string that appears just before the block? \u2192 afterString:'anchor text' to set the start line from content; combine with endLine for the end.",
      "(4) Have exact line numbers? \u2192 startLine + endLine (both 1-based inclusive).",
      "occurrence:N \u2014 when using anchor hints, targets the Nth occurrence of the anchor.",
      "dryRun:true \u2014 previews which lines will be deleted without writing. Always use this when unsure of the range.",
      "WARNING: after any delete, line numbers below the deletion point shift. Never reuse stale line numbers for a subsequent edit.",
    ].join(" "),
    inputSchema: {
      startLine: z.number().optional(),
      endLine:   z.number().optional(),
      ...ANCHOR_SCHEMA,
    },
    handler: async ({ startLine, endLine, dryRun = false, inFunction, afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterString, beforeString, afterLine, beforeLine, betweenHint, hintRadius, occurrence = 1, fuzzyWhitespace, lint = false }, ctx) => {
            const { editor, buffer, allLines } = ctx;
      const curTool   = 'delete-line-range';
      const lineCount = allLines.length;
      const isCodeFile = isCodeFilePath(ctx.filePath); // B23
      const _radius    = hintRadius ?? HINT_RADIUS;

      // -- Resolve anchor hints to line numbers --------------------------------
      if (inFunction) {
        bump('delete_line_range', 'hintsUsed.inFunction');
        const fn = findFunctionInBuffer(buffer, inFunction);
        if (!fn) {
          bump('delete_line_range', 'fails.outOfRange');
          return { content: [{ type: "text", text: `\u274C inFunction: function "${inFunction}" not found in active editor.` }], deleted: false };
        }
        startLine = fn.startRow + 1;
        endLine   = fn.endRow   + 1;
      } else if (betweenHint) {
        bump('delete_line_range', 'hintsUsed.betweenHint');
        const text2 = buffer.getText();
        const syms  = getSymbols(editor, text2, ctx.filePath);
        const rStart = resolveAnchor(betweenHint.start, syms, text2);
        const errStart = anchorError('betweenHint.start', betweenHint.start, rStart);
        if (errStart) { bump('delete_line_range', 'fails.outOfRange'); return { content: [{ type: "text", text: errStart }], deleted: false }; }
        const rEnd = resolveAnchor(betweenHint.end, syms, text2);
        const errEnd = anchorError('betweenHint.end', betweenHint.end, rEnd);
        if (errEnd) { bump('delete_line_range', 'fails.outOfRange'); return { content: [{ type: "text", text: errEnd }], deleted: false }; }
        startLine = rStart.row + 1;
        endLine   = rEnd.row   + 1;
      } else if (afterString) {
        bump('delete_line_range', 'hintsUsed.afterString');
        const r = resolveStringPosition(allLines, afterString, 'after', _radius);
        if (r.notFound) { bump('delete_line_range', 'fails.outOfRange'); return { content: [{ type: "text", text: `\u274C afterString: "${afterString}" not found in active editor.` }], deleted: false }; }
        if (r.ambiguous) { bump('delete_line_range', 'fails.outOfRange'); return { content: [{ type: "text", text: `\u274C afterString: "${afterString}" is ambiguous (found on lines ${r.rows.map(n => n+1).join(', ')}).` }], deleted: false }; }
        startLine = r.anchorRow + 2;
      }
      if (occurrence > 1) bump('delete_line_range', 'hintsUsed.occurrence');
      if (fuzzyWhitespace) bump('delete_line_range', 'hintsUsed.fuzzyWhitespace');

      if (startLine < 1 || endLine < 1) {
        ctx.consec.count++;
        bump('delete_line_range', 'fails.outOfRange');
        return { content: [{ type: "text", text: [
          `\u274C Line numbers must be 1-based (got startLine=${startLine}, endLine=${endLine}).`,
          `   File has ${lineCount} lines.`,
          smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: !inFunction && !afterString && !betweenHint, fileLines: lineCount, oldStr: null, isCodeFile })
        ].filter(Boolean).join("\n") }], deleted: false, consecFailures: ctx.consec.count };
      }
      if (startLine > endLine) {
        ctx.consec.count++;
        bump('delete_line_range', 'fails.inverted');
        return { content: [{ type: "text", text: [
          `\u274C startLine (${startLine}) must be <= endLine (${endLine}).`,
          `   Did you mean startLine=${endLine}, endLine=${startLine}?`,
          smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: !inFunction && !afterString && !betweenHint, fileLines: lineCount, oldStr: null, isCodeFile })
        ].filter(Boolean).join("\n") }], deleted: false, consecFailures: ctx.consec.count };
      }
      if (endLine > lineCount) {
        ctx.consec.count++;
        bump('delete_line_range', 'fails.outOfRange');
        const r2 = 4;
        const cs = Math.max(0, lineCount - 1 - r2);
        const ctx2 = allLines.slice(cs).map((l, i) => `${String(cs + i + 1).padStart(4)}: ${l}`).join("\n");
        return { content: [{ type: "text", text: [
          `\u274C endLine ${endLine} exceeds file length ${lineCount}.`,
          `\n\u26A0\uFE0F End of file (lines ${cs + 1}\u2013${lineCount}):\n${ctx2}`,
          smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: !inFunction && !afterString && !betweenHint, fileLines: lineCount, oldStr: null, isCodeFile })
        ].filter(Boolean).join("\n") }], deleted: false, consecFailures: ctx.consec.count };
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
        return {
          content: [{ type: "text", text: [
            `\uD83D\uDD0D DRY RUN \u2014 will delete ${deletedCount} line(s) (${startLine}\u2013${endLine}).`,
            `\nContext (- = lines to be deleted):\n${preview}`,
            `\nReply with the same call without dryRun (or dryRun:false) to commit.`
          ].join("\n") }],
          dryRun: true, deleted: false, startLine, endLine, deletedCount
        };
      }

      const startRow = startLine - 1;
      const endRow   = endLine   - 1;
      buffer.deleteRows(startRow, endRow);
      decorateLine(editor, startRow, "removed");
      ctx.consec.count = 0; bump('delete_line_range', 'hits');

      const newLineCount = buffer.getLineCount();
      const _lintSuffix  = await maybeLintSuffix(lint, editor, startRow, startRow + 5);
      return {
        ...buildEditResponse(
          { tool: curTool, line: startLine, linesChanged: -deletedCount, tags: ['staleLinesWarning'] },
          { lint: _lintSuffix }
        ),
        dryRun: false, deleted: true, newLineCount, deletedCount, staleLinesWarning: true
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

  // ── delete-block (migrated to Tool Framework) ───────────────────────────

  // -- P8: get-region --------------------------------------------------------
  registerMcpTool({
    name: 'get-region',
    group: 'edit',
    category: 'nav',
    requiresEditor: false,
    title: 'Get Region',
    description: [
      "Read lines between two content anchor strings from the active editor — use this when you know surrounding text but not line numbers.",
      "USE THIS TO: verify what's inside a block before editing it; read a switch case; read a struct initialiser; read any named section.",
      "Provide startContent (unique text at or near the start of the region) and endContent (unique text at or near the end). Returns all lines from startContent's line to endContent's line inclusive.",
      "occurrence:N — when startContent appears multiple times, targets the Nth occurrence. inclusive:false excludes the anchor lines themselves.",
      "Immune to line number drift — safe to use even when the file has been recently edited.",
      "After reading with get-region, use the returned line numbers directly with str_replace afterLine/beforeLine, or use betweenHint with the same anchor strings to scope an edit."
    ].join(" "),
    inputSchema: {
      startContent: z.string(),
      endContent:   z.string(),
      inclusive:    z.boolean().optional(),
      filePath:     z.string().optional(),
      ...ANCHOR_SCHEMA
    },
    async handler({ startContent, endContent, inclusive = true, occurrence = 1, filePath }) {
      let text;
      let resolvedPath = filePath;
      if (filePath) {
        try { text = await readTextFromFile(filePath); }
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
  });

  } // end EDIT GROUP
  if (g('edit')) registerMcpTool({
    name:     'delete-block',
    group:    'edit',
    category: 'edit',
    features: { dryRun: true, lint: true, consecutiveFailureCounter: true },
    title:    'Delete Block',
    description: [
      "Delete all lines between two content anchor strings (inclusive by default). Content-stable \u2014 immune to line number drift.",
      "DECISION \u2014 three ways to specify what to delete:",
      "(1) Deleting a named section banner block? \u2192 sectionHint:'SECTION TITLE' \u2014 finds the banner by keyword and deletes the whole block.",
      "(2) Deleting a #ifdef...#endif block by macro name? \u2192 preprocBlock:'MACRO_NAME' \u2014 deletes the entire preprocessor conditional. Use preprocSide:'open' or 'close' to target only one end.",
      "(3) Know unique text at the start and end of the block? \u2192 startContent:'...' and endContent:'...' \u2014 deletes from startContent line to endContent line inclusive.",
      "inclusive:false \u2014 exclude the anchor lines themselves.",
      "inFunction — scope the startContent/endContent search to within a named function body.",
      "occurrence:N \u2014 when startContent appears multiple times, target the Nth occurrence.",
      "dryRun:true \u2014 preview exactly which lines will be deleted without writing. Always use this first.",
    ].join(" "),
    inputSchema: {
      startContent: z.string().optional(),
      endContent:   z.string().optional(),
      inclusive:    z.boolean().optional(),
      ...STRUCTURAL_ANCHOR_SCHEMA,
    },
    handler: async ({ startContent, endContent, sectionHint, preprocBlock, preprocSide, inclusive = true, inFunction, afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterString, beforeString, afterLine, beforeLine, betweenHint, hintRadius, occurrence = 1, dryRun = false, lint = false }, ctx) => {
            const { editor, buffer, allLines } = ctx;
      const curTool   = 'delete-block';
      const lineCount = allLines.length;
      const isCodeFile = isCodeFilePath(ctx.filePath); // B23

      // -- Structural anchor pre-pass (sectionHint / preprocBlock) -------------
      if (sectionHint !== undefined || preprocBlock !== undefined) {
        if (preprocBlock)   bump('delete_block', 'hintsUsed.preprocBlock');
        if (inFunction)     bump('delete_block', 'hintsUsed.inFunction');
        if (occurrence > 1) bump('delete_block', 'hintsUsed.occurrence');
        if (sectionHint)    bump('delete_block', 'hintsUsed.sectionHint');
        const resolved = resolveStructuralAnchor(buffer, { sectionHint, preprocBlock, preprocSide });
        if (!resolved) {
          ctx.consec.count++;
          bump('delete_block', 'fails.anchorNotFound');
          const kind = sectionHint ? `sectionHint "${sectionHint}"` : `preprocBlock "${preprocBlock}"`;
          return { content: [{ type: "text", text: [
            `\u274C ${kind} not found. Use get-structural-anchors to list available anchors.`,
            smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: !sectionHint && !preprocBlock && !inFunction, fileLines: lineCount, oldStr: null, isCodeFile })
          ].filter(Boolean).join("\n") }], deleted: false };
        }
        const delStart     = resolved.startRow;
        const delEnd       = resolved.endRow;
        const deletedCount = delEnd - delStart + 1;
        const r  = 3;
        const cs = Math.max(0, delStart - r);
        const ce = Math.min(lineCount - 1, delEnd + r);
        const preview = allLines.slice(cs, ce + 1).map((l, i) => {
          const abs = cs + i;
          return `${String(abs + 1).padStart(4)}${abs >= delStart && abs <= delEnd ? " -" : "  "} ${l}`;
        }).join("\n");
        if (dryRun) {
          return {
            content: [{ type: "text", text: [
              `\uD83D\uDD0D DRY RUN \u2014 will delete ${deletedCount} line(s) (lines ${delStart + 1}\u2013${delEnd + 1}).`,
              `\nContext (- = lines to be deleted):\n${preview}`,
              `\nReply with the same call without dryRun (or dryRun:false) to commit.`
            ].join("\n") }],
            dryRun: true, deleted: false, startLine: delStart + 1, endLine: delEnd + 1, deletedCount
          };
        }
        buffer.deleteRows(delStart, delEnd);
        decorateLine(editor, delStart, "removed");
        ctx.consec.count = 0; bump('delete_block', 'hits');
        const newLineCount = buffer.getLineCount();
        const _lintSuffix  = await maybeLintSuffix(lint, editor, delStart, delStart + 5);
        return {
          ...buildEditResponse({ tool: curTool, line: delStart + 1, linesChanged: -deletedCount, tags: ['staleLinesWarning'] }, { lint: _lintSuffix }),
          dryRun: false, deleted: true, newLineCount, deletedCount, staleLinesWarning: true
        };
      }

      // -- Content-anchor path (startContent + endContent) --------------------
      if (!startContent || !endContent) {
        return { content: [{ type: "text", text: "\u274C Provide either sectionHint, preprocBlock, or both startContent and endContent." }], deleted: false };
      }

      bump('delete_block', 'hintsUsed.startContent');
      bump('delete_block', 'hintsUsed.endContent');
      if (inFunction)     bump('delete_block', 'hintsUsed.inFunction');
      if (occurrence > 1) bump('delete_block', 'hintsUsed.occurrence');

      let searchFrom = 0;
      let _searchTo  = allLines.length - 1;
      if (inFunction) {
        const fn = findFunctionInBuffer(buffer, inFunction);
        if (!fn) {
          ctx.consec.count++;
          bump('delete_block', 'fails.anchorNotFound');
          return { content: [{ type: "text", text: `\u274C inFunction: function "${inFunction}" not found.` }], deleted: false };
        }
        searchFrom = fn.startRow;
        _searchTo  = fn.endRow;
      }

      const startHit = findAnchor(buffer, startContent, { occurrence, inFunction, afterRow: searchFrom });
      if (!startHit) {
        ctx.consec.count++;
        bump('delete_block', 'fails.startNotFound');
        return { content: [{ type: "text", text: [
          `\u274C startContent not found (occurrence ${occurrence}): "${startContent}"`,
          smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: !inFunction && !sectionHint && !preprocBlock, fileLines: lineCount, oldStr: null, isCodeFile })
        ].filter(Boolean).join("\n") }], deleted: false, consecFailures: ctx.consec.count };
      }
      const startRow     = startHit.row;
      const startMsgHint = startHit.strategy !== "exact" ? ` (startContent matched via ${startHit.strategy})` : "";

      const endHit = findAnchor(buffer, endContent, { afterRow: startRow + 1, inFunction });
      if (!endHit) {
        ctx.consec.count++;
        bump('delete_block', 'fails.endNotFound');
        const previewStart = startRow + 1;
        const previewEnd   = Math.min(allLines.length - 1, startRow + 10);
        const afterCtx     = allLines.slice(previewStart, previewEnd + 1)
          .map((l, i) => `${String(previewStart + i + 1).padStart(4)}: ${l}`).join("\n");
        return { content: [{ type: "text", text: [
          `\u274C endContent not found after startContent (line ${startRow + 1}): "${endContent}"`,
          `\n\u26A0\uFE0F Lines after startContent \u2014 pick the correct endContent from here:\n${afterCtx}`,
          `\n\uD83D\uDCA1 Tip: use a single unique line as endContent if possible.`,
          smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: !inFunction && !sectionHint && !preprocBlock, fileLines: lineCount, oldStr: null, isCodeFile })
        ].filter(Boolean).join("\n") }], deleted: false, consecFailures: ctx.consec.count };
      }
      const endRow     = endHit.row + endHit.matchedRows - 1;
      const endMsgHint = endHit.strategy !== "exact" ? ` (endContent matched via ${endHit.strategy})` : "";

      const delStart = inclusive ? startRow : startRow + 1;
      const delEnd   = inclusive ? endRow   : endRow   - 1;

      // Ambiguity check on startContent
      if (startContent) {
        const _noScope = !inFunction && !afterString && !betweenHint && occurrence <= 1;
        const _ambig = ambiguityCheck({ needle: startContent, fullText: buffer.getText(), noScopeHint: _noScope, toolName: curTool, isCodeFile });
        if (_ambig) { bump('delete_block', 'fails.startNotFound'); ctx.consec.count++; return _ambig; }
      }

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
        return {
          content: [{ type: "text", text: [
            `\uD83D\uDD0D DRY RUN \u2014 will delete ${deletedCount} line(s) (lines ${delStart + 1}\u2013${delEnd + 1})${startMsgHint}${endMsgHint}.`,
            `\nContext (- = lines to be deleted):\n${preview}`,
            `\nReply with the same call without dryRun (or dryRun:false) to commit.`
          ].join("\n") }],
          dryRun: true, deleted: false, startLine: delStart + 1, endLine: delEnd + 1, deletedCount
        };
      }

      buffer.deleteRows(delStart, delEnd);
      decorateLine(editor, delStart, "removed");
      ctx.consec.count = 0; bump('delete_block', 'hits');
      const newLineCount2 = buffer.getLineCount();
      const _lintSuffix2  = await maybeLintSuffix(lint, editor, delStart, delStart + 5);
      return {
        ...buildEditResponse({ tool: curTool, line: delStart + 1, linesChanged: -deletedCount, tags: ['staleLinesWarning'] }, { lint: _lintSuffix2 }),
        dryRun: false, deleted: true, newLineCount: newLineCount2, deletedCount, staleLinesWarning: true
      };
    },
  });

  // ── replace-block (migrated to Tool Framework) ────────────────────────────
  if (g('edit')) registerMcpTool({
    name:     'replace-block',
    group:    'edit',
    category: 'edit',
    features: { dryRun: true, lint: true, consecutiveFailureCounter: true },
    title:    'Replace Block',
    description: [
      "Replace a brace-delimited { } block in the active editor, identified by an anchor string on or near the opening line.",
      "USE THIS FOR: if/else blocks, while/for loops, switch statements, struct initialisers, anonymous blocks — any { } region that is NOT a named function. For named functions use replace-function-body instead.",
      "HOW IT WORKS: finds the first line containing anchor, locates the next { on or after it, brace-counts to the matching }, replaces the entire block with newBody.",
      "newBody must be the complete replacement including the anchor line and both braces.",
      "EXAMPLE: to replace `if (x > 0) { doA(); }` — anchor:'if (x > 0)', newBody:'if (x > 0) {\\n  doB();\\n}'.",
      "occurrence:N — when the same anchor string appears multiple times, targets the Nth occurrence.",
      "inFunction — scopes the anchor search to within a named function body, preventing false matches elsewhere in the file.",
      "dryRun:true — previews what block will be matched without writing. Use this first when the anchor string might match multiple blocks.",
      "NOTE: braceMatchFailed means the anchor was found but no { } block followed it. If this happens consistently, use str_replace instead."
    ].join(" "),
    inputSchema: {
      anchor:  z.string(),
      newBody: z.string(),
      ...ANCHOR_SCHEMA
    },
    handler: async ({ anchor, newBody, occurrence = 1, dryRun = false, inFunction, afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterString, beforeString, afterLine, beforeLine, betweenHint, hintRadius, fuzzyWhitespace, lint = false }, ctx) => {
            const { editor, buffer, allLines } = ctx;
      const curTool = 'replace-block';
      const isCodeFile = isCodeFilePath(ctx.filePath); // B23

      // -- Resolve search scope from hints ------------------------------------
      // inFunction > betweenHint > afterString > entire file
      let searchStartRow = 0;
      let searchEndRow   = allLines.length - 1;
      const _radius = hintRadius ?? HINT_RADIUS;
      const _hasScope = !!(inFunction || betweenHint ||
        afterFunction || beforeFunction || afterSymbol || beforeSymbol ||
        afterString || beforeString || afterLine != null || beforeLine != null ||
        occurrence > 1);

      if (inFunction) {
        bump('replace_block', 'hintsUsed.inFunction');
        const fn = findFunctionInBuffer(buffer, inFunction);
        if (!fn) {
          bump('replace_block', 'fails.anchorNotFound');
          return { content: [{ type: "text", text: `❌ inFunction: function "${inFunction}" not found in active editor.` }], found: false };
        }
        searchStartRow = fn.startRow;
        searchEndRow   = fn.endRow;
      } else if (betweenHint) {
        bump('replace_block', 'hintsUsed.betweenHint');
        const text = buffer.getText();
        const syms = getSymbols(editor, text, ctx.filePath);
        const rStart = resolveAnchor(betweenHint.start, syms, text);
        const errStart = anchorError('betweenHint.start', betweenHint.start, rStart);
        if (errStart) { bump('replace_block', 'fails.anchorNotFound'); return { content: [{ type: "text", text: errStart }], found: false }; }
        const rEnd = resolveAnchor(betweenHint.end, syms, text);
        const errEnd = anchorError('betweenHint.end', betweenHint.end, rEnd);
        if (errEnd) { bump('replace_block', 'fails.anchorNotFound'); return { content: [{ type: "text", text: errEnd }], found: false }; }
        searchStartRow = rStart.row;
        searchEndRow   = rEnd.row;
      } else if (afterString) {
        bump('replace_block', 'hintsUsed.afterString');
        const r = resolveStringPosition(allLines, afterString, 'after', _radius);
        if (r.notFound)  { bump('replace_block', 'fails.anchorNotFound'); return { content: [{ type: "text", text: `❌ afterString: "${afterString}" not found.` }], found: false }; }
        if (r.ambiguous) { bump('replace_block', 'fails.anchorNotFound'); return { content: [{ type: "text", text: `❌ afterString: "${afterString}" is ambiguous (lines ${r.rows.map(n => n+1).join(', ')}).` }], found: false }; }
        searchStartRow = r.startRow;
        searchEndRow   = r.endRow;
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
        ctx.consec.count++;
        logFailure({
          tool: 'replace_block',
          reason: 'anchorNotFound',
          filePath: ctx.filePath,
          hintsSet: [inFunction && 'inFunction', afterString && 'afterString', betweenHint && 'betweenHint'].filter(Boolean),
          oldStrPreview: anchor,
          bufferPreview: allLines
            .slice(searchStartRow, Math.min(allLines.length - 1, searchStartRow + 15) + 1)
            .map((l, i) => `L${searchStartRow + i + 1}: ${l}`).join('\n'),
          scopeLines: `L${searchStartRow + 1}–L${searchEndRow + 1} (${searchEndRow - searchStartRow + 1} lines searched)`,
          diffVsBuffer: null
        });
        return { content: [{ type: 'text', text: [
          `❌ anchor "${anchor}" not found (occurrence ${occurrence}; scanned ${found} match(es)).`,
          `\n💡 Searched ${searchStartRow + 1}–${searchEndRow + 1} of ${allLines.length} lines.`,
          smartSuggestion({ toolName: curTool, counter: ctx.consec, noHintsUsed: !inFunction && !afterString && !betweenHint, fileLines: allLines.length, oldStr: anchor, isCodeFile })
        ].filter(Boolean).join('\n') }], found: false };
      }

      // -- Ambiguity check — count anchor matches in full file ---------------
      {
        const _noScope = !inFunction && !afterString && !betweenHint && occurrence <= 1;
        const _ambig = ambiguityCheck({ needle: anchor, fullText: buffer.getText(), noScopeHint: _noScope, toolName: curTool, isCodeFile });
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
        const previewEnd = Math.min(allLines.length - 1, anchorRow + 6);
        const _blockCtx = allLines.slice(anchorRow, previewEnd + 1)
          .map((l, i) => `${String(anchorRow + i + 1).padStart(4)}: ${l}`).join("\n");
        return { content: [{ type: "text", text: [
          `❌ No opening brace { found after anchor "${anchor}" (line ${anchorRow + 1}).`,
          `\n💡 Lines at and after anchor — verify this is a brace-delimited block:\n${_blockCtx}`
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
        const previewEnd = Math.min(allLines.length - 1, braceStartRow + 15);
        const _blockCtx = allLines.slice(braceStartRow, previewEnd + 1)
          .map((l, i) => `${String(braceStartRow + i + 1).padStart(4)}: ${l}`).join("\n");
        return { content: [{ type: "text", text: [
          `❌ Brace matching failed — unmatched { after anchor "${anchor}" (line ${braceStartRow + 1}).`,
          `\n💡 Content from opening brace — check for missing } or nested blocks:\n${_blockCtx}`
        ].join("\n") }], found: false };
      }

      const startRow = anchorRow;
      const ensuredNewline = newBody.endsWith("\n") ? newBody : newBody + "\n";
      const insertedLines  = ensuredNewline.split(/\r?\n/).length - 1;

      if (dryRun) {
        const r = 2;
        const cs = Math.max(0, startRow - r);
        const ce = Math.min(allLines.length - 1, endRow + r);
        const preview = allLines.slice(cs, ce + 1).map((l, i) => {
          const abs = cs + i;
          return `${String(abs + 1).padStart(4)}${abs >= startRow && abs <= endRow ? " ▶" : "  "} ${l}`;
        }).join("\n");
        const newLines = ensuredNewline.split(/\r?\n/).slice(0, -1).map(l => `     + ${l}`).join("\n");
        return {
          content: [{ type: "text", text: [
            `🔍 DRY RUN — block found at lines ${startRow + 1}–${endRow + 1} (${endRow - startRow + 1} lines).`,
            `\nCurrent block (▶ = will be replaced):\n${preview}`,
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
      const _styleSuffix = applyStyleCheck(newBody, ctx.filePath);
      ctx.consec.count = 0; bump('replace_block', 'hits');
      return {
        ...buildEditResponse(
          { tool: curTool, line: startRow + 1, linesChanged: insertedLines - (endRow - startRow + 1), scopeLabel: ` (anchor: "${anchor}")` },
          { lint: _lintSuffix, style: _styleSuffix }
        ),
        found: true, dryRun: false, oldStartLine: startRow + 1, oldEndLine: endRow + 1,
        newStartLine: startRow + 1, insertedLines, newLineCount
      };
    },
  });


  // -- CORE GROUP (always on) -------------------------------------------------
  registerMcpTool({
    name: 'get-document',
    group: 'navigation',
    category: 'nav',
    requiresEditor: true,
    title: 'Get Document',
    description: "Return an array of lines with their 1-based line numbers. IMPORTANT: Always call get-document again after any insert, delete, or replace operation before making further line-based edits - line numbers shift with every change.",
    inputSchema: {},
    async handler(args, ctx) {
      const lines = ctx.text.split(/\r?\n/).map((t, i) => ({ n: i + 1, text: t }));
      bump('get_document', 'hits');
      return { content: [{ type: 'text', text: JSON.stringify(lines, null, 2) }] };
    },
  });

  registerMcpTool({
    name: 'get-line-count',
    group: 'navigation',
    category: 'nav',
    requiresEditor: true,
    title: 'Get Line Count',
    description: "Return the total number of lines in the active editor.",
    inputSchema: {},
    async handler(args, ctx) {
      bump('get_line_count', 'hits');
      return { content: [{ type: 'text', text: String(ctx.buffer.getLineCount()) }] };
    },
  });

  registerMcpTool({
    name: 'get-filename',
    group: 'navigation',
    category: 'nav',
    requiresEditor: true,
    title: 'Get Filename',
    description: "Return the filename of the active editor (or [untitled] if none).",
    inputSchema: {},
    async handler(args, ctx) {
      const fullPath = ctx.editor.getPath();
      bump('get_filename', 'hits');
      return { content: [{ type: 'text', text: fullPath ? path.basename(fullPath) : '[untitled]' }] };
    },
  });

  registerMcpTool({
    name: 'get-full-path',
    group: 'navigation',
    category: 'nav',
    requiresEditor: true,
    title: 'Get Full File Path',
    description: "Return the full absolute path of the active editor.",
    inputSchema: {},
    async handler(args, ctx) {
      bump('get_full_path', 'hits');
      return { content: [{ type: 'text', text: ctx.editor.getPath() || '[untitled]' }] };
    },
  });

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
      glob: z.string().optional()
    },
    async handler({ glob = '' } = {}) {
      const roots = atom.project.getPaths();
      let files = [];
      for (const root of roots) files = files.concat(await walkDir(root));
      if (glob) {
        const globRe = globToRegex(glob);
        files = files.filter(f => globRe.test(f.replace(/\\/g, "/")));
      }
      bump('get_project_files', 'hits');
      return {
        content: [{ type: 'text', text: files.join('\n') }],
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
    description: "Open (or switch to) a tab for the given file path. Returns file info including line count and language.",
    inputSchema: { filePath: z.string() },
    async handler({ filePath }) {
      const editor    = await atom.workspace.open(filePath);
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
      const openFiles = atom.workspace.getTextEditors().map(editor => ({
        filePath: editor.getPath() || '[untitled]',
        modified: editor.isModified() ? '*' : ''
      }));
      bump('list_open_files', 'hits');
      return {
        content: [{ type: 'text', text: JSON.stringify({ openFileCount: openFiles.length, files: openFiles }, null, 2) }],
        openFiles, count: openFiles.length
      };
    },
  });

  registerMcpTool({
    name: 'get-active-editor-info',
    group: 'navigation',
    category: 'nav',
    requiresEditor: true,
    title: 'Get Active Editor Info',
    description: "Quick status check on the active editor without loading the full document. Returns filename, line count, language, cursor position, and modification status. Use this instead of get-document when you only need metadata - much cheaper.",
    inputSchema: {},
    async handler(args, ctx) {
      const filePath  = ctx.editor.getPath() || '[untitled]';
      const fileName  = filePath ? path.basename(filePath) : '[untitled]';
      const lineCount = ctx.buffer.getLineCount();
      const cursorPos = ctx.editor.getCursorBufferPosition();
      const language  = ctx.editor.getGrammar() ? ctx.editor.getGrammar().name : 'Unknown';
      const modified  = ctx.editor.isModified();
      const info = { filename: fileName, filePath, lineCount, cursorLine: cursorPos.row + 1, cursorCol: cursorPos.column, language, modified };
      bump('get_active_editor_info', 'hits');
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }], ...info };
    },
  });


  registerMcpTool({
    name: 'close-file',
    group: 'navigation',
    category: 'nav',
    requiresEditor: false,
    title: 'Close File',
    description: "Close an editor tab by path. If path is omitted, closes the active editor. " +
      "Set save:true to save unsaved changes before closing (default: false — unsaved changes are discarded). " +
      "Returns {closed:true} on success or {closed:false, error} if the file was not found.",
    inputSchema: {
      filePath: z.string().optional().describe("Absolute path of the file to close. Omit to close the active editor."),
      save:     z.boolean().optional().describe("Save before closing if the buffer has unsaved changes (default: false)."),
    },
    async handler({ filePath, save = false }, ctx) {
      let editor, pane;
      if (filePath) {
        editor = atom.workspace.getTextEditors().find(e => e.getPath() === filePath);
        if (!editor) {
          return ctx.fail('notFound', `close-file: no open editor found for path: ${filePath}`, { closed: false, error: 'notFound' });
        }
        pane = atom.workspace.paneForItem(editor);
      } else {
        editor = atom.workspace.getActiveTextEditor();
        if (!editor) {
          return ctx.fail('notFound', 'close-file: no active editor', { closed: false, error: 'noActiveEditor' });
        }
        pane = atom.workspace.getActivePane();
      }
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
  } // end SAFETY GROUP (undo/redo — more safety tools added later)

  // ---------------------------------------------------------------------------
  // Cross-file tools
  // ---------------------------------------------------------------------------

  // -- FILE-OPS GROUP (continued) --------------------------------------------
  if (g('fileOps')) {
  registerMcpTool({
    name: 'read-file',
    group: 'fileOps',
    category: 'nav',
    requiresEditor: false,
    title: 'Read File',
    description: [
      "Read any project file by path and return its contents with 1-based line numbers.",
      "Unlike get-document, this does NOT require the file to be open or active in the editor. If the file is open in Pulsar, reads from the live buffer — unsaved edits are reflected automatically. Falls back to disk for files not open in the editor.",
      "Use get-project-files to discover available paths."
    ].join(" "),
    inputSchema: { filePath: z.string() },
    async handler({ filePath }) {
      let text;
      try { text = await readTextFromFile(filePath); }
      catch (err) { throw new Error(`Cannot read file: ${filePath} - ${err.message}`); }
      const lines = text.split(/\r?\n/).map((t, i) => ({ n: i + 1, text: t }));
      bump('read_file', 'hits');
      return { content: [{ type: 'text', text: JSON.stringify(lines, null, 2) }], lineCount: lines.length, filePath };
    },
  });

// ── run-command (migrated to Tool Framework) ────────────────────────────────
  if (g('fileOps')) registerMcpTool({
    name:           'run-command',
    group:          'fileOps',
    category:       'command',
    requiresEditor: false,
    title: 'Run Command',
    description: [
      `Execute a shell command and return stdout, stderr, and exit code.`,
      `On Windows uses PowerShell; on Linux/Mac uses /bin/sh.`,
      `cwd defaults to the first project root. timeout defaults to 30 seconds (in ms).`,
      `Use for build commands (make, gcc, cmake), running tests, git status, etc.`,
      `showOutput — stream stdout/stderr live to the chat panel (default true). Set false for noisy diagnostic commands where you only want the final result.`
    ].join(" "),
    inputSchema: {
      command:    z.string(),
      cwd:        z.string().optional(),
      timeout:    z.number().optional(),
      confirm:    z.boolean().optional(),
      showOutput: z.boolean().optional(),
    },
    async handler({ command, cwd, timeout = 30000, confirm = false, showOutput = true }) {
      const workDir = cwd || (atom.project.getPaths()[0] ?? null);
      if (!workDir) throw new Error("No project root open and no cwd provided.");

      const { shell, flag } = getShell();

      // -- PRE-FLIGHT: checkpoint, save, warn ---------------------------------
      const openEditors    = atom.workspace.getTextEditors().filter(e => e.getPath());
      const modifiedPaths  = openEditors.filter(e => e.isModified()).map(e => e.getPath());
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

      // 2. Save all modified buffers so the shell sees current content
      for (const ed of openEditors) {
        if (ed.isModified()) await ed.save();
      }

      // 3. Snapshot mtimes of all open files to detect post-command disk changes
      const mtimeBefore = {};
      for (const ed of openEditors) {
        try { mtimeBefore[ed.getPath()] = fs.statSync(ed.getPath()).mtimeMs; } catch (_) {}
      }

      // LLM-facing pre-flight summary
      const preFlightLines = [
        `🔒 run-command pre-flight: checkpoint '${cpName}' saved for ${openEditors.length} open file(s).`
      ];
      if (modifiedPaths.length > 0) {
        preFlightLines.push(`  Saved ${modifiedPaths.length} modified buffer(s) to disk before execution:`);
        modifiedPaths.forEach(p => preFlightLines.push(`    — ${p}`));
      }
      if (chatPanel && showOutput) chatPanel.appendOutput(preFlightLines.join('\n'), 'info');
      // -- END PRE-FLIGHT -----------------------------------------------------

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
          if (timedOut)            bump('run_command', 'misses.timedOut');
          else if (exitCode !== 0) bump('run_command', 'misses.exitNonZero');

          // -- POST-EXECUTION: reload any open files changed on disk ----------
          const reloaded = [];
          const reloadErrors = [];
          for (const ed of openEditors) {
            const fp = ed.getPath();
            if (!fp) continue;
            try {
              const mtimeAfter = fs.statSync(fp).mtimeMs;
              if (mtimeAfter !== mtimeBefore[fp]) {
                const newText = fs.readFileSync(fp, 'utf8');
                ed.getBuffer().setTextViaDiff(newText);
                reloaded.push(fp);
              }
            } catch (_) { reloadErrors.push(fp); }
          }
          if (reloaded.length > 0 && chatPanel && showOutput) {
            chatPanel.appendOutput(
              `🔄 Reloaded ${reloaded.length} file(s) changed by command:\n` +
              reloaded.map(p => `    — ${p}`).join('\n'), 'info');
          }
          // -- Restore active editor focus -----------------------------------
          // Re-activate the tab that was focused before run-command so the
          // active editor isn't left pointing at whatever file was last reloaded.
          // IMPORTANT: atom.workspace.open() is async — we must await it inside
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
                             savedBeforeRun: modifiedPaths.length > 0 ? modifiedPaths : undefined,
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
          if (chatPanel) chatPanel.appendOutput(`[error: ${err.message}]`, 'stderr');
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



// ── replace-across-files (migrated to Tool Framework) ──────────────────────
  // Pending-confirm store — holds the last dry-run result so confirm:true can commit
  // without re-scanning. Cleared on each new query or successful commit.
  const rafPending = { key: null, files: [] };

  if (g('fileOps')) registerMcpTool({
    name:           'replace-across-files',
    group:          'fileOps',
    category:       'command',
    requiresEditor: false,
    title: 'Replace Across Files',
    description: [
      "Find and replace a string or regex across all project files (or a glob-filtered subset).",
      "When regex:true, replacement supports capture-group backreferences: $1, $2 ... $9, $& (whole match) -- identical to VS Code find/replace with regex enabled.",
      "TWO-STEP WORKFLOW — always do both steps:",
      "Step 1: call WITHOUT confirm — returns a preview listing every match with file path, line number, and contextLines (default 2) of surrounding context. Review this before committing.",
      "Step 2: call again WITH confirm:true and the same query/replacement — commits all replacements.",
      "glob — restrict to a file pattern e.g. '**/*.js' or 'src/**/*.c'. Use this to narrow the scope when the pattern appears in many files.",
      "maxMatches (default 50) — if exceeded the tool blocks and asks you to narrow with glob or raise the limit.",
      "contextLines (default 2) — number of lines before/after each match shown in the preview.",
      "Files open in editor tabs are updated live with undo history preserved; closed files are opened automatically and updated via the buffer (full undo history, no direct disk writes). Binary files are skipped."
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
    },
    async handler({ query, replacement, regex = false, caseSensitive = false, glob = "",
                    contextLines = 2, maxMatches = 50, confirm = false, dryRun = false }) {
      // dryRun:true (legacy) means preview pass, not commit
      const committing = confirm && !dryRun;

      const roots = atom.project.getPaths();
      if (!roots.length) throw new Error("No project root open.");

      const BINARY_EXTS = new Set(["o","obj","exe","dll","so","dylib","bin","lib","a","out","pdb","ilk","map","elf","hex","png","jpg","jpeg","gif","bmp","ico","pdf","zip","tar","gz","7z","rar"]);

      // -- COMMIT PATH --------------------------------------------------------
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
          try { original = await readTextFromFile(filePath); } catch (e) { skipped.push({ filePath, reason: e.message }); continue; }
          const _raf_re = new RegExp(source, flags);
          let count = 0;
          const updated = original.replace(_raf_re, function(m) {
            count++;
            const groups      = Array.prototype.slice.call(arguments, 1, arguments.length - 2);
            const namedGroups = arguments[arguments.length - 1];
            const offset = arguments[arguments.length - 2];
            const pre    = original.slice(0, offset);
            const post   = original.slice(offset + m.length);
            return applyReplacement(replacement, m, groups, pre, post, namedGroups);
          });
          if (count === 0) continue;
          totalReplacements += count;
          committed.push({ filePath, replacements: count });
          const openEditor = atom.workspace.getTextEditors().find(e => e.getPath() && path.resolve(e.getPath()) === path.resolve(filePath));
          try {
            const targetEditor = openEditor || await atom.workspace.open(filePath, { activateItem: false });
            targetEditor.getBuffer().setTextViaDiff(updated);
          } catch (e) {
            skipped.push({ filePath, reason: `write failed: ${e.message}` });
          }
        }

        // Clear pending store after commit
        rafPending.key = null;
        rafPending.files = [];

        if (skipped.length > 0) bump('replace_across_files', 'fails.skipped', skipped.length);
        bump('replace_across_files', 'hits');

        return {
          content: [{ type: "text", text: JSON.stringify({
            summary: `✅ Committed — replaced ${totalReplacements} occurrence(s) across ${committed.length} file(s).`,
            totalReplacements, filesAffected: committed.length, files: committed,
            skipped: skipped.length > 0 ? skipped : undefined,
          }, null, 2) }],
          totalReplacements, filesAffected: committed.length, dryRun: false
        };
      }

      // -- PREVIEW PATH -------------------------------------------------------
      const flags  = caseSensitive ? "g" : "gi";
      const source = regex ? query : escapeRegex(query);
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
      let totalMatches = 0;
      let capped = false;

      outer:
      for (const filePath of allFiles) {
        let text;
        try { text = await readTextFromFile(filePath); } catch (e) { skipped.push({ filePath, reason: e.message }); continue; }

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
        return {
          content: [{ type: "text", text: JSON.stringify({
            summary: `⚠️ Match cap hit (${maxMatches}). Too many matches to safely preview — narrow the scope with glob or a more specific query, or raise maxMatches if you're sure.`,
            totalMatches: `>${maxMatches}`, capped: true, filesSearched: allFiles.length,
          }, null, 2) }],
          dryRun: true
        };
      }

      // Store pending for confirm
      const pendingKey = `${query}||${replacement}||${glob}||${regex}||${caseSensitive}`;
      rafPending.key = pendingKey;
      rafPending.files = results.map(r => ({ filePath: r.filePath }));

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
        totalMatches, filesAffected: results.length, dryRun: true
      };
    },
  });


// ── replace-function-body (migrated to Tool Framework) ───────────────────
  if (g('edit')) registerMcpTool({
    name:     'replace-function-body',
    group:    'edit',
    category: 'edit',
    features: { dryRun: true, lint: true, consecutiveFailureCounter: false },
    title:    'Replace Function Body',
    description: [
      "Replace a named function's entire signature and body atomically in the active editor.",
      "USE THIS INSTEAD OF str_replace when you need to rewrite a whole function — it finds the function by name, removes from signature to closing brace, and inserts newBody in one step. No risk of partial match or line drift.",
      "name — the function name (just the name, not the full signature). newBody — the complete replacement including the signature line and all braces.",
      "DISAMBIGUATION: if the same function name appears in multiple places (e.g. declaration + definition), use afterString or occurrence:N to identify which one to target.",
      "WORKFLOW: use read-lines with inFunction first to read the current function, make your changes, then call replace-function-body with newBody. This ensures you have the exact current signature.",
      "RESPONSE: ✅ replace-function-body — line N, ±M lines \"fnName\" [signatureChanged if sig changed]. Followed by ⚠️ style: violations and ⚠️ lint: messages if any issues in the replaced region — act on these before your next edit. Lint runs automatically (no lint param needed)."
    ].join(" "),
    inputSchema: {
      newBody: z.string(),
      ...ANCHOR_SCHEMA
    },
    handler: async ({ name, newBody, dryRun = false, occurrence = 1, inFunction, afterFunction, beforeFunction, afterSymbol, beforeSymbol, afterString, beforeString, afterLine, beforeLine, betweenHint, hintRadius, fuzzyWhitespace, lint = false }, ctx) => {
      const { editor, buffer, allLines } = ctx;
      const curTool = 'replace-function-body';

      // Derive function name from first line of newBody (e.g. "int hal_init(..." -> "hal_init")
      // Falls back to inFunction if provided. name is used for findFunction + error messages.
      const _sigLine    = newBody.trimStart().split(/\r?\n/)[0] ?? '';
      const _nameMatch  = _sigLine.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      const _fnName     = (_nameMatch && _nameMatch[1]) || inFunction || null;

      const text = buffer.getText();
      const _radius = hintRadius ?? HINT_RADIUS;
      const _hasScope = !!(inFunction || betweenHint ||
        afterFunction || beforeFunction || afterSymbol || beforeSymbol ||
        afterString || beforeString || afterLine != null || beforeLine != null ||
        occurrence > 1);

      // -- Resolve hints → findFunction options -----------------------------
      if (inFunction)    bump('replace_function_body', 'hintsUsed.inFunction');
      if (betweenHint)   bump('replace_function_body', 'hintsUsed.betweenHint');
      if (afterString)   bump('replace_function_body', 'hintsUsed.afterString');
      if (occurrence > 1)  bump('replace_function_body', 'hintsUsed.occurrence');
      if (fuzzyWhitespace) bump('replace_function_body', 'hintsUsed.fuzzyWhitespace');

      // Translate hints to row offsets for findFunction
      const _hintSyms = getSymbols(editor, text, ctx.filePath);
      let afterRow    = undefined;
      let betweenRows = undefined;
      if (afterString) {
        const r = resolveStringPosition(allLines, afterString, 'after', _radius);
        if (r.notFound)  { bump('replace_function_body', 'fails.ambiguousHint'); return { content: [{ type: "text", text: `❌ afterString: "${afterString}" not found.` }], replaced: false }; }
        if (r.ambiguous) { bump('replace_function_body', 'fails.ambiguousHint'); return { content: [{ type: "text", text: `❌ afterString: "${afterString}" is ambiguous (lines ${r.rows.map(n => n+1).join(', ')}).` }], replaced: false }; }
        afterRow = r.anchorRow;
      }
      if (betweenHint) {
        const rStart = resolveAnchor(betweenHint.start, _hintSyms, text);
        const errStart = anchorError('betweenHint.start', betweenHint.start, rStart);
        if (errStart) { bump('replace_function_body', 'fails.ambiguousHint'); return { content: [{ type: "text", text: errStart }], replaced: false }; }
        const rEnd = resolveAnchor(betweenHint.end, _hintSyms, text);
        const errEnd = anchorError('betweenHint.end', betweenHint.end, rEnd);
        if (errEnd) { bump('replace_function_body', 'fails.ambiguousHint'); return { content: [{ type: "text", text: errEnd }], replaced: false }; }
        betweenRows = { start: rStart.row, end: rEnd.row };
      }

      // -- Symbol extraction — tree-sitter first, regex fallback ------------
      const allSymbols = getSymbols(editor, text, ctx.filePath);

      // If inFunction is given, scope to that outer function's row range
      let scopedSymbols = allSymbols;
      if (inFunction) {
        const outer = findFunction(allSymbols, inFunction, {});
        if (outer) {
          scopedSymbols = allSymbols.filter(
            s => s.startRow >= outer.startRow && s.startRow <= outer.endRow
          );
        }
      }

      const found = findFunction(scopedSymbols, _fnName, {
        occurrence,
        afterRow,
        betweenRows,
      });

      if (!found) {
        // Smart failure — use allSymbols to suggest close names
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

        logFailure({
          tool: 'replace_function_body', reason: 'notFound', filePath: ctx.filePath,
          hintsSet: [afterString && 'afterString', betweenHint && 'betweenHint', inFunction && 'inFunction'].filter(Boolean),
          oldStrPreview: _fnName, diffVsBuffer: null,
          availableFunctions: allNames.slice(0, 20),
          closestMatches: close.map(x => x.fn),
          bufferPreview: allLines.slice(0, Math.min(allLines.length - 1, 15) + 1)
            .map((l, i) => `L${i + 1}: ${l}`).join('\n')
        });
        const parts = ['❌ Function "' + _fnName + '" not found in active editor.'];
        if (close.length > 0) {
          const sigLines = close.map(({ fn }) => {
            const sym = allSymbols.find(s => s.name === fn);
            return sym ? `  ${fn}  →  ${sym.sig.trim()}  (line ${sym.startRow + 1})` : `  ${fn}`;
          });
          parts.push(`\n💡 Similar names found — current signatures:\n${sigLines.join("\n")}`);
          parts.push(`   Did you mean one of these? Check spelling and casing.`);
        } else if (allNames.length > 0) {
          parts.push(`\n💡 Functions in this file: ${allNames.slice(0, 10).join(", ")}${allNames.length > 10 ? ` — (${allNames.length} total)` : ""}`);
        } else {
          parts.push(`   No functions detected in this file.`);
        }
        bump('replace_function_body', 'fails.notFound');
        return { content: [{ type: "text", text: parts.join("\n") }], found: false };
      }

      // -- Ambiguity warning — multiple definitions, no scoping hint --------
      {
        const _noScope = !inFunction && !afterString && !betweenHint && occurrence <= 1;
        if (_noScope) {
          const dupes = allSymbols.filter(s => s.name === _fnName);
          if (dupes.length > 1) {
            const lineNums = dupes.map(s => s.startRow + 1).join(", ");
            bump('replace_function_body', 'fails.ambiguous');
            return { content: [{ type: "text", text: [
              '⚠️  AMBIGUOUS — "' + _fnName + '" has ' + dupes.length + ' definitions in file (lines: ' + lineNums + ').',
              `   Use occurrence:N, afterString, inFunction, or betweenHint to target one:`,
              `   — occurrence:N   → Nth definition (1=line ${dupes[0].startRow + 1}, 2=line ${dupes[1]?.startRow + 1 ?? "?"}, ...)`,
              `   — occurrence:N    → picks the Nth definition`,
              `   — afterString:"…" → start search after a unique anchor line`,
              `   — inFunction:"…"  → scope to an outer function`,
              `   — betweenHint     → restrict to a region`,
            ].join("\n") }], found: false, ambiguous: true, matchAtLines: dupes.map(s => s.startRow + 1) };
          }
        }
      }

      const { startRow, endRow } = found;
      const oldSignatureLine = allLines[startRow] ?? "";
      const ensuredNewline   = newBody.endsWith("\n") ? newBody : newBody + "\n";
      const insertedLines    = ensuredNewline.split(/\r?\n/).length - 1;
      const signatureChanged = oldSignatureLine.trim() !== (ensuredNewline.split(/\r?\n/)[0] ?? "").trim();

      if (dryRun) {
        const r = 2;
        bump('replace_function_body', 'dryRuns');
        const cs = Math.max(0, startRow - r);
        const ce = Math.min(allLines.length - 1, endRow + r);
        const preview = allLines.slice(cs, ce + 1).map((l, i) => {
          const abs = cs + i;
          const inFn = abs >= startRow && abs <= endRow;
          return `${String(abs + 1).padStart(4)}${inFn ? " ▶" : "  "} ${l}`;
        }).join("\n");
        const newLines = ensuredNewline.split(/\r?\n/).slice(0, -1).map(l => `     + ${l}`).join("\n");
        return {
          content: [{ type: "text", text: [
            '🔍 DRY RUN — function "' + _fnName + '" found at lines ' + (startRow + 1) + '–' + (endRow + 1) + ' (' + (endRow - startRow + 1) + ' lines).',
            signatureChanged ? `\n⚠️  SIGNATURE CHANGE DETECTED — verify this is intentional.` : "",
            `\nCurrent function (▶ = will be replaced):\n${preview}`,
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
      bump('replace_function_body', 'hits');
      const newLineCount = buffer.getLineCount();
      const _lintSuffix = await maybeLintSuffix(lint, editor, startRow, startRow + newBody.split("\n").length - 1);
      const _styleSuffix = applyStyleCheck(newBody, ctx.filePath);
      return {
        ...buildEditResponse(
          { tool: curTool, line: startRow + 1, linesChanged: insertedLines - (endRow - startRow + 1),
            scopeLabel: ' "' + _fnName + '"', tags: signatureChanged ? ['signatureChanged'] : [] },
          { lint: _lintSuffix, style: _styleSuffix }
        ),
        found: true, dryRun: false,
        functionName: _fnName,
        oldStartLine: startRow + 1,
        oldEndLine:   endRow   + 1,
        newStartLine: startRow + 1,
        signatureChanged, insertedLines, newLineCount
      };
    },
  });

  registerMcpTool({
    name: 'create-file',
    group: 'fileOps',
    category: 'command',
    requiresEditor: false,
    title: 'Create File',
    description: [
      "Create a new file at the given path with optional initial content, then open it in a Pulsar tab.",
      "If the file already exists it will NOT be overwritten — use open-file instead.",
      "Directories in the path are created automatically.",
      "After creation the new file becomes the active editor so all other tools work on it immediately."
    ].join(" "),
    inputSchema: {
      filePath: z.string(),
      content:  z.string().optional()
    },
    async handler({ filePath, content = "" }) {
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
  });

  registerMcpTool({
    name: 'move-file',
    group: 'fileOps',
    category: 'command',
    requiresEditor: false,
    title: 'Move File',
    description: [
      "Move (or rename) a file from sourcePath to destPath.",
      "If the source file is open in a Pulsar tab it will be closed and the destination opened automatically.",
      "Directories in destPath are created automatically.",
      "Fails if destPath already exists — use copy-file if you want a duplicate instead."
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
      else await atom.workspace.open(destPath);
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
      "Copy a file from sourcePath to destPath and open the copy in a new Pulsar tab.",
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
      } else {
        await fs.promises.copyFile(sourcePath, destPath);
      }
      await atom.workspace.open(destPath);
      return { content: [{ type: "text", text: `Copied: ${sourcePath} -> ${destPath}` }], sourcePath, destPath };
    }
  });

  registerMcpTool({
    name: 'rename-file',
    group: 'fileOps',
    category: 'command',
    requiresEditor: false,
    title: 'Rename File',
    description: [
      "Rename a file within its current directory.",
      "newName must be a bare filename (no path separators) — use move-file for cross-directory moves.",
      "If the file is open in a tab the tab is updated to the new name automatically."
    ].join(" "),
    inputSchema: {
      filePath: z.string(),
      newName:  z.string()
    },
    async handler({ filePath, newName }) {
      if (newName.includes("/") || newName.includes("\\\\")) throw new Error("newName must be a bare filename with no path separators. Use move-file for cross-directory moves.");
      const destPath = path.join(path.dirname(filePath), newName);
      try { await fs.promises.access(destPath); throw new Error(`Destination already exists: ${destPath}`); } catch (err) { if (err.message.startsWith("Destination already exists")) throw err; }
      await fs.promises.rename(filePath, destPath);
      const oldEditor = atom.workspace.getTextEditors().find(e => e.getPath() && path.resolve(e.getPath()) === path.resolve(filePath));
      if (oldEditor) await retargetEditor(oldEditor, destPath);
      else await atom.workspace.open(destPath);
      return { content: [{ type: "text", text: `Renamed: ${path.basename(filePath)} -> ${newName}` }], filePath, destPath };
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
      "Any open editor tabs pointing inside the old folder path are retargeted to their new paths automatically — undo history is preserved.",
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
  });

  } // end FILE-OPS GROUP

  // -- CORE GROUP (continued — always on) ------------------------------------
  registerMcpTool({
    name: 'save-file',
    group: 'navigation',
    category: 'nav',
    requiresEditor: true,
    title: 'Save File',
    description: [
      "Save the active editor to disk.",
      "Always call this after a sequence of edits to persist changes.",
      "Returns the file path and whether the file was modified before saving."
    ].join(" "),
    inputSchema: {},
    async handler(args, ctx) {
      const wasModified = ctx.editor.isModified();
      await ctx.editor.save();
      bump('save_file', 'hits');
      return {
        content: [{ type: 'text', text: `Saved: ${ctx.editor.getPath()}${wasModified ? " (was modified)" : " (no changes)"}` }],
        filePath: ctx.editor.getPath(),
        wasModified
      };
    },
  });

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
      "PREFERRED FIRST CALL: always use this before get-document or read-file to orient yourself - far cheaper and usually enough to plan edits.",
      "Pass filePath to read any file, or omit to summarise the active editor."
    ].join(" "),
    inputSchema: { filePath: z.string().optional() },
    async handler({ filePath } = {}) {
      let text;
      let resolvedPath = filePath;
      if (filePath) {
        try { text = await readTextFromFile(filePath); }
        catch (err) { throw new Error(`Cannot read file: ${filePath} — ${err.message}`); }
      } else {
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor and no filePath provided.");
        text = editor.getBuffer().getText();
        resolvedPath = editor.getPath() || '[untitled]';
      }
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
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
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
      "Much cheaper than get-document for large C/C++ files when you just need the header inventory.",
      "Pass filePath to read any file, or omit to use the active editor.",
      "Also returns #ifdef/#ifndef/#if blocks so you can see conditional compilation guards."
    ].join(" "),
    inputSchema: { filePath: z.string().optional() },
    async handler({ filePath } = {}) {
      let text;
      let resolvedPath = filePath;
      if (filePath) {
        try { text = await readTextFromFile(filePath); }
        catch (err) { throw new Error(`Cannot read file: ${filePath} - ${err.message}`); }
      } else {
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor and no filePath provided.");
        text = editor.getBuffer().getText();
        resolvedPath = editor.getPath() || "[untitled]";
      }
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
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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
      query: z.string().optional()
    },
    async handler({ glob = "", query = "" } = {}) {
      const roots = atom.project.getPaths();
      if (!roots.length) throw new Error("No project root open.");
      let allFiles = [];
      for (const root of roots) allFiles = allFiles.concat(await walkDir(root));
      const effectiveGlob = glob || "**/*.{c,cpp,cc,cxx,h,hpp}";
      const globRe = globToRegex(effectiveGlob);
      allFiles = allFiles.filter(f => globRe.test(f.replace(/\\/g, "/")));
      const queryRe = query ? new RegExp(escapeRegex(query), "i") : null;
      const results = [];
      for (const filePath of allFiles) {
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
        content: [{ type: 'text', text: JSON.stringify({ totalFunctions: results.length, functions: results }, null, 2) }],
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
      "Search a file for a string or regex and return every matching line with its 1-based line number.",
      "PRIMARY USE: locate content in a file to get line numbers before making edits with str_replace or read-lines. Far cheaper than read-file — only matched lines are returned.",
      "filePath — search any project file. Omit to search the active editor. Reads from the live buffer if the file is open (unsaved edits are included).",
      "contextLines:N — return N lines before and after each match, like grep -C. Each match result includes 'before' and 'after' arrays. Use this to verify the surrounding context before editing.",
      "occurrence:N — return only the Nth match with its context. Use this when you know which specific instance you want (e.g. the 3rd call to a function) — tells you the exact line number to pass to str_replace afterLine or read-lines.",
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
    },
    requiresEditor: false,
    handler: async ({ query, filePath, regex = false, caseSensitive = false, maxMatches = 200, contextLines = 0, occurrence = 0 }, ctx) => {
      const statsKey = 'grep_file';
      let text;
      let _resolvedPath = filePath;

      if (filePath) {
        try { text = await readTextFromFile(filePath); }
        catch (err) { throw new Error(`Cannot read file: ${filePath} - ${err.message}`); }
      } else {
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor and no filePath provided.");
        text = editor.getBuffer().getText();
        _resolvedPath = editor.getPath() || "[untitled]";
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
        logFailure({ tool: statsKey, reason: 'noMatch', filePath: _resolvedPath, query, regex, caseSensitive });
        return ctx.fail('noMatch', `occurrence ${occurrence} not found — only ${globalIndex} match(es) in file.`);
      }
      if (matches.length === 0) {
        logFailure({ tool: statsKey, reason: 'noMatch', filePath: _resolvedPath, query, regex, caseSensitive });
        return ctx.fail('noMatch', JSON.stringify({ matchCount: 0, truncated: false, matches: [] }));
      }
      bump(statsKey, 'hits');
      if (occurrence > 0) bump(statsKey, 'hintsUsed.occurrence');
      if (contextLines > 0) bump(statsKey, 'hintsUsed.contextLines');
      return { content: [{ type: 'text', text: JSON.stringify({ matchCount: matches.length, truncated, matches }) }] };
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
      "Search for a string or regex across all project files and return every match with file path and 1-based line number.",
      "PRIMARY USE: find where a symbol, pattern, or string is defined or used when you don't know which file it's in. Follow up with grep-file or read-lines on the specific file once you've located it.",
      "glob — restrict to a file pattern e.g. '**/*.js' or 'src/**/*.c'. Use this to avoid searching unrelated files.",
      "contextLines:N — return N lines before and after each match. Use this to understand the surrounding code, not just the match line.",
      "occurrence:N — return only the Nth match across the entire search. Useful when you know which specific instance you want.",
      "regex:true — treat query as a regular expression. caseSensitive:false — case-insensitive matching.",
      "Results capped at maxMatches (default 200). Returns truncation flag when capped — use glob to narrow scope if truncated."
    ].join(" "),
    inputSchema: {
      query:         z.string(),
      glob:          z.string().optional(),
      regex:         z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      maxMatches:    z.number().optional(),
      contextLines:  z.number().optional(),
      occurrence:    z.number().optional()
    },
    requiresEditor: false,
    handler: async ({ query, glob = "", regex = false, caseSensitive = false, maxMatches = 200, contextLines = 0, occurrence = 0 }, ctx) => {
      const statsKey = 'grep_project';
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
        try { text = await readTextFromFile(filePath); } catch { continue; }
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
        logFailure({ tool: statsKey, reason: 'noMatch', filePath: null, query, regex, caseSensitive });
        return ctx.fail('noMatch', `occurrence ${occurrence} not found — only ${globalIndex} match(es) in project.`);
      }
      if (matches.length === 0) {
        logFailure({ tool: statsKey, reason: 'noMatch', filePath: null, query, regex, caseSensitive });
        bump(statsKey, 'fails.noMatch');
        return { content: [{ type: "text", text: JSON.stringify({ matchCount: 0, truncated: false, matches: [] }, null, 2) }], matchCount: 0, truncated: false };
      }
      bump(statsKey, 'hits');
      if (occurrence > 0) bump(statsKey, 'hintsUsed.occurrence');
      if (contextLines > 0) bump(statsKey, 'hintsUsed.contextLines');
      return {
        content: [{ type: "text", text: JSON.stringify({ matchCount: matches.length, truncated, matches }, null, 2) }],
        matchCount: matches.length, truncated
      };
    }
  });

  } // end SEARCH GROUP (grep-file, grep-project)

  // -- FILE-OPS GROUP (part 3: read-lines) ----------------------------------
  if (g('fileOps')) {
  registerMcpTool({
    name: 'read-lines',
    group: 'fileOps',
    category: 'nav',
    requiresEditor: false,
    title: 'Read Lines',
    description: [
      "Read a section of any file without opening it. PREFERRED over read-file for large files — only loads the lines you need.",
      "DECISION — how to specify what to read:",
      "(1) Know the function name? ? inFunction:'myFn' — extracts the complete function body (signature + all lines to closing brace). Works for JS, C, and any brace-delimited language. Most reliable mode.",
      "(2) Know a unique string just before the section? ? afterString:'anchor text' — starts reading at the line after the anchor. Combine with endLine or radius to bound the end.",
      "(3) Know text at both the start and end of the region? ? betweenHint:{start:'...', end:'...'} — reads from the start anchor line to the end anchor line.",
      "(4) Have a line number and want context around it? \u2192 centerLine:42 with radius:N (defaults to radius:10, i.e. 10 lines above and below).",
      "(5) Know exact start and end line numbers? ? startLine + endLine.",
      "filePath — read any project file. Omit to read the active editor. Live buffer is used if the file is open (unsaved edits included).",
      "Returns lines with their original 1-based line numbers — use them directly as afterLine in str_replace or startLine/endLine in delete-line-range."
    ].join(" "),
    inputSchema: {
      startLine:    z.number().optional(),
      endLine:      z.number().optional(),
      filePath:     z.string().optional(),
      centerLine:   z.number().optional(),
      radius:       z.number().optional(),
      inFunction:    z.string().optional(),
      afterString:   z.string().optional(),
      betweenHint:  z.object({ start: z.string(), end: z.string() }).optional(),
      nearLine:      z.number().optional(),
    },
    async handler({ startLine, endLine, filePath, centerLine, radius, inFunction, afterString, betweenHint, nearLine }) {
      let text;
      let resolvedPath = filePath;
      if (filePath) {
        try { text = await readTextFromFile(filePath); }
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
      const _editor  = filePath ? null : atom.workspace.getActiveTextEditor();
      const _syms    = getSymbols(_editor, text, resolvedPath);
      if (inFunction) {
        const sym = _syms.find(s => s.name === inFunction);
        if (!sym) throw new Error(`inFunction: function "${inFunction}" not found in ${resolvedPath}. Known: ${_syms.map(s=>s.name).slice(0,10).join(', ')}`);
        resolvedStart = sym.startRow + 1;
        resolvedEnd   = sym.endRow   + 1;
        _hintLabel    = ` [inFunction:"${inFunction}" lines ${resolvedStart}—${resolvedEnd}]`;
      } else if (betweenHint) {
        const rStart = resolveAnchor(betweenHint.start, _syms, text);
        const errStart = anchorError('betweenHint.start', betweenHint.start, rStart);
        if (errStart) throw new Error(errStart);
        const rEnd = resolveAnchor(betweenHint.end, _syms, text);
        const errEnd = anchorError('betweenHint.end', betweenHint.end, rEnd);
        if (errEnd) throw new Error(errEnd);
        resolvedStart = rStart.row + 1;
        resolvedEnd   = rEnd.row   + 1;
        _hintLabel    = ` [betweenHint [${rStart.via}] lines ${resolvedStart}—${resolvedEnd}]`;
      } else if (afterString) {
        const r = resolveAnchor(afterString, _syms, text);
        const err = anchorError('afterString', afterString, r);
        if (err) throw new Error(err);
        resolvedStart = r.row + 2; // 1-based line AFTER the anchor
        const _r = radius !== undefined ? radius : 20;
        resolvedEnd   = endLine !== undefined ? endLine : resolvedStart + _r - 1;
        _hintLabel    = ` [afterString [${r.via}] "${afterString.substring(0, 40)}" line ${resolvedStart}]`;
      } else if (centerLine !== undefined || nearLine !== undefined) {
        const center = centerLine !== undefined ? centerLine : nearLine;
        const r      = radius !== undefined ? radius : 10;
        resolvedStart = Math.max(1, center - r);
        resolvedEnd   = Math.min(lineCount, center + r);
        _hintLabel     = ` [centerLine:${center} radius:${r}]`;
      } else {
        resolvedStart = startLine;
        resolvedEnd   = endLine;
        if (resolvedStart === undefined || resolvedEnd === undefined)
          throw new Error("Must provide startLine+endLine, centerLine, inFunction, afterString, betweenHint, or nearLine.");
      }
      if (resolvedStart < 1) throw new Error("startLine must be >= 1.");
      if (resolvedEnd < resolvedStart) throw new Error(`endLine (${resolvedEnd}) must be >= startLine (${resolvedStart}).`);
      if (resolvedStart > lineCount) throw new Error(`startLine (${resolvedStart}) exceeds file line count (${lineCount}).`);
      const clampedEnd = Math.min(resolvedEnd, lineCount);
      const slice      = allLines.slice(resolvedStart - 1, clampedEnd).map((t, i) => ({ n: resolvedStart + i, text: t }));
      bump('read_lines', 'hits');
      if (inFunction)                            bump('read_lines', 'hintsUsed.inFunction');
      else if (betweenHint)                      bump('read_lines', 'hintsUsed.betweenHint');
      else if (afterString)                      bump('read_lines', 'hintsUsed.afterString');
      else if (nearLine !== undefined)           bump('read_lines', 'hintsUsed.nearLine');
      else if (centerLine !== undefined)         bump('read_lines', 'hintsUsed.nearLine'); // centerLine maps to same bucket
      return {
        content: [{ type: 'text', text: JSON.stringify({ filePath: resolvedPath, totalLines: lineCount, returnedLines: slice.length, lines: slice }, null, 2) }],
        totalLines: lineCount, returnedLines: slice.length
      };
    },
  });
  } // end FILE-OPS GROUP (part 3)

  // -- EDIT GROUP (part 2: replace-all — migrated to Tool Framework) --------
  if (g('edit')) registerMcpTool({
    name:     'replace-all',
    group:    'edit',
    category: 'edit',
    features: { dryRun: true, lint: true, styleCheck: true },
    title:       'Replace All',
    description: [
      'Find and replace ALL occurrences of query with replacement in the active editor.',
      'Equivalent to str_replace applied to all occurrences \u2014 exists as a shortcut so you never accidentally replace only the first match.',
      'Supports regex:true and caseSensitive:false matching. When regex:true, the replacement string supports capture-group backreferences: $1, $2 ... $9 (Nth capture group), $& (whole match), $` (text before match), $\' (text after match) -- identical to VS Code find/replace with regex enabled.',
      'Returns matchCount so you can verify how many occurrences were replaced. Supports dryRun:true to preview the match count without writing any changes \u2014 use this before committing broad or regex queries.',
    ].join(' '),
    inputSchema: {
      query:         z.string(),
      replacement:   z.string(),
      regex:         z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      dryRun:        z.boolean().optional(),
      lint:          z.boolean().optional(),
    },
    handler: async ({ query, replacement, regex = false, caseSensitive = false, dryRun = false, lint = false }, ctx) => {
      const { allLines } = ctx;

      const source = regex ? query : escapeRegex(query);
      const flags  = 'g' + (caseSensitive ? '' : 'i');
      let pattern;
      try { pattern = new RegExp(source, flags); }
      catch (e) { throw new Error(`Invalid regex: ${e.message}`); }

      const originalText = ctx.text;
      let matchCount = 0;
      // Use string-form replace so $1/$2/$& backreferences in replacement are
      // interpolated natively -- same behaviour as VS Code find/replace with regex.
      const newText = originalText.replace(pattern, function(m) {
        matchCount++;
        const groups      = Array.prototype.slice.call(arguments, 1, arguments.length - 2);
        const namedGroups = arguments[arguments.length - 1];
        const offset = arguments[arguments.length - 2];
        const pre    = originalText.slice(0, offset);
        const post   = originalText.slice(offset + m.length);
        return applyReplacement(replacement, m, groups, pre, post, namedGroups);
      });

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

      const _styleSuffix = applyStyleCheck(replacement, ctx.editor.getPath());
      const _lintSuffix  = await maybeLintSuffix(lint, ctx.editor, null, null);
      return {
        ...(await ctx.commit(
          { scopeLabel: ` \u2014 ${matchCount} occurrence${matchCount === 1 ? '' : 's'} of ${JSON.stringify(query)}` },
          { lint: _lintSuffix, style: _styleSuffix }
        )),
        matchCount, dryRun: false,
      };
    },
  });


// ── sed (migrated to Tool Framework) ─────────────────────────────────────

  // -- get-structural-anchors ------------------------------------------------
  if (g('edit')) registerMcpTool({
    name: 'get-structural-anchors',
    group: 'edit',
    category: 'nav',
    requiresEditor: false,
    title: 'Get Structural Anchors',
    description: [
      "List the named structural anchors available in the active file. Call this before using sectionHint, preprocBlock, or functionEnd to discover the exact names to pass.",
      "Returns three categories:",
      "sectionHint names — section banner comments (e.g. '// -- INIT --'). Pass the keyword to sectionHint in insert or delete-block.",
      "preprocBlock names — #ifdef/#ifndef macro names. Pass the macro name to preprocBlock in insert or delete-block.",
      "functionEnd names — function names and their closing-brace line numbers. Pass the function name to functionEnd in insert to add code immediately after a function.",
      "filePath — optionally query a file other than the active editor.",
      "TYPICAL WORKFLOW: call get-structural-anchors → pick a name → pass it to insert (functionEnd/sectionHint) or delete-block (sectionHint/preprocBlock)."
    ].join(" "),
    inputSchema: {
      filePath: z.string().optional()
    },
    async handler({ filePath } = {}) {
      let buffer, _gsEditor, _gsText, _gsPath;
      if (filePath) {
        // Read from disk into a temporary lines array
        try { _gsText = await readTextFromFile(filePath); }
        catch (e) { return { content: [{ type: "text", text: `❌ Cannot read file: ${e.message}` }] }; }
        _gsPath = filePath;
        // Find open editor for this path (for tree-sitter)
        _gsEditor = atom.workspace.getTextEditors().find(e => e.getPath && e.getPath() === filePath) || null;
        // Wrap in a minimal buffer-like object
        const lines = _gsText.split(/\r?\n/);
        buffer = { getLines: () => lines };
      } else {
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) return { content: [{ type: "text", text: "❌ No active editor and no filePath provided." }] };
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
          // Middle line — extract meaningful keyword by stripping comment chars
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

      // -- Function ends via tree-sitter -------------------------------------
      // getSymbols gives exact endRow for every symbol — no brace-walk needed.
      const _gsSymbols = getSymbols(_gsEditor, _gsText, _gsPath);
      const functionEnds = _gsSymbols.map(s => ({ name: s.name, endLine: s.endRow + 1 }));

      // -- Format output -----------------------------------------------------
      const parts = [];

      if (sections.length > 0) {
        parts.push("📌 SECTION BANNERS (use as sectionHint:)");
        parts.push(sections.map(s => `  "${s.keyword}"  (line ${s.line})`).join("\n"));
      } else {
        parts.push("📌 SECTION BANNERS — none found (no /* ===...=== * NAME * ===...=== */ pattern)");
      }

      parts.push("");
      if (preprocBlocks.length > 0) {
        parts.push("📌 PREPROCESSOR BLOCKS (use as preprocBlock:)");
        parts.push(preprocBlocks.map(p =>
          `  "${p.macro}"  (#ifdef line ${p.openLine} → #endif line ${p.closeLine})`
        ).join("\n"));
      } else {
        parts.push("📌 PREPROCESSOR BLOCKS — none found with named #endif comments");
      }

      parts.push("");
      if (functionEnds.length > 0) {
        parts.push("📌 FUNCTION ENDS (use as functionEnd:)");
        parts.push(functionEnds.map(f => `  "${f.name}"  (closing brace at line ${f.endLine})`).join("\n"));
      } else {
        parts.push("📌 FUNCTION ENDS — none detected");
      }

      bump('get_structural_anchors', 'hits');
      return { content: [{ type: "text", text: parts.join("\n") }] };
    }
  });

  // Native in-buffer sed-style editing. Operates entirely on the live buffer —
  // no subprocess, no disk write required, full undo/redo and decoration support.
  if (g('edit')) registerMcpTool({
    name:     'sed',
    group:    'edit',
    category: 'edit',
    features: { dryRun: true, lint: true, consecutiveFailureCounter: true },
    title:    'Sed',
    description: [
      "sed-style pattern-based editing on the active buffer — no line numbers needed.",
      "Supports the four most useful sed commands:",
      "  s/pattern/replacement/[flags]  — substitute (flags: g=global, i=case-insensitive, N=Nth occurrence only). Replacement supports $1/$2...$9 capture-group backreferences, $& (whole match) -- same as VS Code regex replace.",
      "  /address/s/pattern/replacement/[flags] — substitute only on lines matching address",
      "  /start/,/end/d — delete all lines from first line matching start through first line matching end (inclusive)",
      "  /addr/d — delete all lines matching address",
      "All patterns are JavaScript-compatible regular expressions.",
      "Use inFunction to restrict any command to the body of a named function.",
      "Use dryRun:true to preview changes without writing — always recommended for global substitutions.",
      "On no-match, returns the closest matching area in the buffer so you can correct the pattern.",
      "Returns matchCount and linesDeleted so you can verify the operation."
    ].join(" "),
    inputSchema: {
      expression:   z.string(),
      inFunction:   z.string().optional(),
      dryRun:       z.boolean().optional(),
      lint:         z.boolean().optional()
    },
    handler: async ({ expression, inFunction, dryRun = false, lint = false }, ctx) => {
            const { editor, buffer, allLines } = ctx;
      const curTool  = 'sed';
      const lineCount = allLines.length;

      // Resolve optional function scope
      let scopeStart = 0;
      let scopeEnd   = lineCount - 1;
      let scopeLabel = "";
      if (inFunction) {
        const fn = findFunctionInBuffer(buffer, inFunction);
        if (!fn) {
          ctx.consec.count++;
          return { content: [{ type: "text", text: `❌ inFunction: function "${inFunction}" not found.` }], applied: false };
        }
        scopeStart = fn.startRow;
        scopeEnd   = fn.endRow;
        scopeLabel = ` (scoped to "${inFunction}")`;
      }

      // -- Parse expression ------------------------------------------------
      // Supported forms:
      //   s/pat/rep/flags                      — global substitute
      //   /addr/s/pat/rep/flags                — addressed substitute
      //   /start/,/end/d                       — range delete
      //   /addr/d                              — addressed delete

      function makeRe(pat, flags = "") {
        try { return new RegExp(pat, flags); }
        catch (e) { return null; }
      }

      function parseSed(expr) {
        expr = expr.trim();
        const rangeDelete = expr.match(/^\/(.+?)\/,\/(.+?)\/(d)$/);
        if (rangeDelete) return { type: "rangeDelete", startPat: rangeDelete[1], endPat: rangeDelete[2] };
        const addrDelete = expr.match(/^\/(.+?)\/(d)$/);
        if (addrDelete) return { type: "addrDelete", addrPat: addrDelete[1] };
        const addrSubst = expr.match(/^\/(.+?)\/s(.)(.+)$/);
        if (addrSubst) {
          const sep  = addrSubst[2];
          const rest = addrSubst[3].split(sep);
          if (rest.length >= 2) {
            return { type: "addrSubst", addrPat: addrSubst[1], pat: rest[0], rep: rest[1], flags: rest[2] || "" };
          }
        }
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

      // -- Execute ---------------------------------------------------------
      const workLines  = allLines.slice();
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
            const newLine = line.replace(subRe, function(m) {
              nthCounter++;
              if (nthCounter !== nthOnly) return m;
              matchCount++;
              const groups      = Array.prototype.slice.call(arguments, 1, arguments.length - 2);
              const namedGroups = arguments[arguments.length - 1];
              const offset = arguments[arguments.length - 2];
              return applyReplacement(rep, m, groups, line.slice(0, offset), line.slice(offset + m.length), namedGroups);
            });
            if (newLine !== line) { changeLog.push({ row: i, before: line, after: newLine }); workLines[i] = newLine; }
          } else {
            let lineMatches = 0;
            const newLine = line.replace(subRe, function(m) {
              lineMatches++; matchCount++;
              const groups      = Array.prototype.slice.call(arguments, 1, arguments.length - 2);
              const namedGroups = arguments[arguments.length - 1];
              const offset = arguments[arguments.length - 2];
              return applyReplacement(rep, m, groups, line.slice(0, offset), line.slice(offset + m.length), namedGroups);
            });
            if (lineMatches > 0) { changeLog.push({ row: i, before: line, after: newLine }); workLines[i] = newLine; }
          }
        }

      } else if (parsed.type === "addrDelete") {
        const addrRe = makeRe(parsed.addrPat, "i");
        if (!addrRe) {
          return { content: [{ type: "text", text: `❌ Bad address pattern: /${parsed.addrPat}/` }], applied: false };
        }
        for (let i = scopeEnd; i >= scopeStart; i--) {
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
            break;
          }
        }
        if (startRow !== -1 && linesDeleted === 0) {
          const previewEnd = Math.min(allLines.length - 1, startRow + 10);
          const _sedCtx = allLines.slice(startRow, previewEnd + 1)
            .map((l, i) => `${String(startRow + i + 1).padStart(4)}: ${l}`).join("\n");
          ctx.consec.count++;
          bump('sed', 'fails.addressNotFound');
          return { content: [{ type: "text", text: [
            `❌ Range start /${parsed.startPat}/ found at line ${startRow + 1} but end /${parsed.endPat}/ not found after it${scopeLabel}.`,
            `\n💡 Lines after start — pick the correct end pattern:\n${_sedCtx}`
          ].join("\n") }], applied: false };
        }
      }

      // -- No match --------------------------------------------------------
      if (matchCount === 0) {
        ctx.consec.count++;
        bump('sed', 'fails.noMatch');
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
          const _sedCtx = allLines.slice(cs, ce + 1).map((l, i) => `${String(cs + i + 1).padStart(4)}: ${l}`).join("\n");
          parts.push(`\n💡 Closest area (lines ${cs + 1}–${ce + 1}) — check for case/whitespace differences:\n${_sedCtx}`);
        }
        parts.push(smartSuggestion({ toolName: "sed", counter: ctx.consec, noHintsUsed: !inFunction, fileLines: lineCount, oldStr: expression, isCodeFile: isCodeFilePath(ctx.filePath) }));
        return { content: [{ type: "text", text: parts.filter(Boolean).join("\n") }], applied: false, matchCount: 0 };
      }

      // -- Dry run preview -------------------------------------------------
      const previewLines = [];
      for (const ch of changeLog.slice(0, 30)) {
        previewLines.push(`${String(ch.row + 1).padStart(4)} - ${ch.before}`);
        if (ch.after !== null) previewLines.push(`${String(ch.row + 1).padStart(4)} + ${ch.after}`);
      }
      if (changeLog.length > 30) previewLines.push(`  … and ${changeLog.length - 30} more changes`);
      const preview = previewLines.join("\n");

      if (dryRun) {
        return {
          content: [{ type: "text", text: [
            `🔍 DRY RUN — ${matchCount} match(es)${linesDeleted ? `, ${linesDeleted} line(s) would be deleted` : ""}${scopeLabel}.`,
            `\nPreview:\n${preview}`,
            `\nReply with the same call without dryRun (or dryRun:false) to commit.`
          ].join("\n") }],
          applied: false, dryRun: true, matchCount, linesDeleted
        };
      }

      // -- Commit ----------------------------------------------------------
      const originalText = buffer.getText();
      const newText      = workLines.join("\n") +
        (originalText.endsWith("\n") ? "\n" : "");
      buffer.setTextViaDiff(newText);
      decorateEditedLines(editor, originalText, newText);
      ctx.consec.count = 0; bump('sed', 'hits');

      dbg(curTool, "SUCCESS", { expression, matchCount, linesDeleted, scopeLabel });
      const _lintSuffix = await maybeLintSuffix(lint, editor, null, null);
      return {
        ...buildEditResponse(
          { tool: curTool, linesChanged: -linesDeleted || null, scopeLabel: `${scopeLabel} — ${matchCount} match(es)` },
          { lint: _lintSuffix, nudge: `\nChanges:\n${preview}` }
        ),
        applied: true, matchCount, linesDeleted, dryRun: false
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
      "Cheap orientation step before using read-lines or grep-file on a large file.",
      "Pass filePath to check any file. Omit to check the active editor."
    ].join(" "),
    inputSchema: { filePath: z.string().optional() },
    async handler({ filePath } = {}) {
      let lineCount;
      let resolvedPath = filePath;
      if (filePath) {
        let text;
        try { text = await readTextFromFile(filePath); }
        catch (err) { throw new Error(`Cannot read file: ${filePath} - ${err.message}`); }
        lineCount = text.split(/\r?\n/).length;
      } else {
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor and no filePath provided.");
        lineCount    = editor.getBuffer().getLineCount();
        resolvedPath = editor.getPath() || "[untitled]";
      }
      bump('file_line_count', 'hits');
      return {
        content: [{ type: 'text', text: JSON.stringify({ filePath: resolvedPath, lineCount }, null, 2) }],
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
      "Apply a unified diff patch to the active editor. USE THIS for edits that touch multiple scattered locations in a file \u2014 more efficient than multiple str_replace calls.",
      "Patch format: standard unified diff with @@ hunk headers and +/- lines. Include 3 unchanged context lines around each change for reliable anchoring.",
      "@@ line numbers are hints only \u2014 the tool searches nearby if the file has shifted, so it survives minor line drift. @@ line counts are auto-corrected.",
      "FUZZY RESCUE: if a hunk fails to apply, the tool automatically tries fuzzy/indent-aware matching and shows a corrected diff preview. Reply with apply-patch({ confirm:true }) to apply the rescued version without resending the patch.",
      "dryRun:true \u2014 validates the patch and reports what would change without writing. Use this first on any non-trivial patch.",
      "LARGE EDIT NOTE: for edits touching more than ~30% of the file, replace-document or replace-function-body will be cheaper in tokens than a large patch.",
      "Returns linesAdded, linesRemoved, hunksApplied, and a diff of the actual change."
    ].join(" "),
    inputSchema: {
      patch:       z.string().optional(),
      dryRun:      z.boolean().optional(),
      fuzzFactor:  z.number().optional(),
      confirm:     z.boolean().optional(),
      lint:        z.boolean().optional(),
    },
    title:    'Apply Patch',
    handler: async ({ patch = "", dryRun = false, fuzzFactor = 0, confirm = false, lint = false }, ctx) => {
            const { editor, buffer, allLines } = ctx;
      const curTool  = 'apply-patch';
      const bufLines = allLines;
      dbg(curTool, "ARGS", { patchLength: patch.length, dryRun, fuzzFactor, confirm });

        // -- confirm:true — apply the last fuzzy-rescued patch -----------------
        if (confirm) {
          if (!patchRescueStore.hunks || patchRescueStore.hunks.length === 0) {
            return { content: [{ type: "text", text: "? No rescued patch available to confirm. Send the original patch again." }], applied: false };
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
          ctx.consec.count       = 0;

          const newText   = buffer.getText();
          const _diffHunks = diffLines(buffer.getText(), newText);
          dbg(curTool, "CONFIRM APPLY — rescue patch committed", { hunks: rescued.length });
          bump('apply_patch', 'rescuedCommits');

          const _lintSuffix = await maybeLintSuffix(lint, editor, null, null);
          const _hunkDetail = rescued.map((rh, i) => `  Hunk ${i + 1}: at line ${rh.startRow + 1}${rh.strategyNote}`).join('\n');
          return {
            ...buildEditResponse(
              { tool: curTool, tags: ['rescued'], scopeLabel: ` — ${rescued.length} hunk(s)` },
              { lint: _lintSuffix, nudge: _hunkDetail ? `\n${_hunkDetail}` : '' }
            ),
            applied: true, hunksApplied: rescued.length };
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

        // -- Fuzzy rescue -----------------------------------------------------
        // If applyPatch failed, parse each hunk, locate its context lines in the
        // buffer using findAnchor (exact ? fuzzy ? indent-strip), rebuild a
        // corrected patch with real line numbers and real indentation, then show
        // a diff preview. The caller can apply it with confirm:true.
        if (result === false) {
          ctx.consec.count++;
          bump('apply_patch', 'fails.contextMismatch');
          dbg(curTool, `FAIL #${ctx.consec.count} (context mismatch — attempting fuzzy rescue)`, { hunks: hunkCount });

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
              `? Could not parse any hunks from patch. Failure #${ctx.consec.count}.`,
              smartSuggestion({ toolName: "apply-patch", counter: ctx.consec, noHintsUsed: true, fileLines: bufLines.length, oldStr: null, isCodeFile: isCodeFilePath(ctx.filePath) })
            ].filter(Boolean).join("\n") }], applied: false, consecFailures: ctx.consec.count };
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
              rescueNotes.push(`??  Hunk ${hi + 1}: no usable context lines — cannot locate.`);
              allLocated = false;
              continue;
            }

            const hit = findAnchor(buffer, anchor, { afterRow: searchAfter });
            if (!hit) {
              rescueNotes.push(`??  Hunk ${hi + 1}: context not found in buffer (even with fuzzy matching).`);
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
            rescueNotes.push(`? Hunk ${hi + 1}: located at line ${hit.row + 1}${strategyNote}`);
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
              ? `??  Patch failed but fuzzy rescue located all ${hunks.length} hunk(s). Preview of corrected changes:`
              : `??  Patch failed. Fuzzy rescue located ${rescuedHunks.length} of ${hunks.length} hunk(s):`,
            ...rescueNotes,
            `\n${previewLines.slice(0, 80).join("\n")}${previewLines.length > 80 ? "\n  — (truncated)" : ""}`,
          ];

          if (allLocated && rescuedHunks.length > 0) {
            // Store rescued hunks for confirm — key by a short hash of the patch
            patchRescueStore.hunks    = rescuedHunks;
            patchRescueStore.patchKey = patch.length + ":" + hunkCount;
            parts.push(`\n? Reply with apply-patch({ confirm: true }) to apply the rescued patch, or correct and resend.`);
            return { content: [{ type: "text", text: parts.join("\n") }], applied: false, rescueAvailable: true, consecFailures: ctx.consec.count };
          }

          parts.push(smartSuggestion({ toolName: "apply-patch", counter: ctx.consec, noHintsUsed: true, fileLines: bufLines.length, oldStr: null, isCodeFile: isCodeFilePath(ctx.filePath) }));
          return { content: [{ type: "text", text: parts.join("\n") }], applied: false, rescueAvailable: false, consecFailures: ctx.consec.count };
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
          const diffSnippet = diffOut.slice(0, 60).join("\n") + (diffOut.length > 60 ? "\n  — (truncated)" : "");

          return {
            content: [{ type: "text", text: [
              `? DRY RUN — patch applies cleanly. ${hunkCount} hunk(s), +${dryAdded}/-${dryRemoved} lines.`,
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
        ctx.consec.count = 0; bump('apply_patch', 'hits');
        if (largeEditWarning) bump('apply_patch', 'largeEditWarnings');
        dbg(curTool, "SUCCESS — failure counter reset", { hunks: hunkCount, dryRun: false });

        // Compute actual diff for verification
        const hunks      = diffLines(originalText, result);
        const linesAdded   = hunks.filter(h => h.added).reduce((n, h) => n + (h.count ?? 0), 0);
        const linesRemoved = hunks.filter(h => h.removed).reduce((n, h) => n + (h.count ?? 0), 0);
        const newLineCount = buffer.getLineCount();

        const _lintSuffix = await maybeLintSuffix(lint, editor, null, null);
        const _addedText = hunks.filter(h => h.added).map(h => h.value).join("\n");
        const _styleSuffix = _addedText ? applyStyleCheck(_addedText, ctx.filePath) : "";
        return {
          ...buildEditResponse(
            { tool: curTool, linesChanged: linesAdded - linesRemoved, tags: largeEditWarning ? ['largeEdit'] : [] },
            { lint: _lintSuffix, style: _styleSuffix }
          ),
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

  registerMcpTool({
    name:           'get-compiler-diagnostics',
    group:          'diagnostics',
    category:       'command',
    requiresEditor: false,
    title:          'Get Compiler Diagnostics',
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
    },
    handler: async ({ scope = "file", compilerOptions = "" } = {}) => {
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
    },
    handler: async ({ scope = "file" } = {}) => {
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
      "Use this before replace-document or replace-function-body to verify edits are correct.",
      "Returns a unified diff string plus a summary of lines added/removed. After accepting the changes and applying them, always call save-file to persist to disk."
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
        `Diff: +${added}/-${removed} lines. Similarity: ${Math.round(similarity * 100)}%.`,
        wsOnly ? `\n??  WHITESPACE ONLY — all content matches but indentation/spacing differs. Safe to commit if that is intentional.` : "",
        !wsOnly && canCommit ? `\n? High similarity (${Math.round(similarity * 100)}%) — looks correct. Use replace-document or replace-function-body to commit.` : "",
        !wsOnly && !canCommit ? `\n??  Low similarity (${Math.round(similarity * 100)}%) — review the diff carefully before committing.` : "",
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
      "name defaults to 'default'. Checkpoints are in-memory and cleared on server restart. WARNING: if this MCP server's own source files (mcp-registration.js, pulsar-edit-mcp-server.js) are edited and saved, Pulsar will reload the package and restart the server — all checkpoints will be lost immediately. Always save test files to disk with save-file as an additional safety net before editing server source.",
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
      "This is a full buffer replace — use diff-preview first to see what will change. If the checkpoint is missing (returns not found), the server was likely restarted by a server source file save — use undo or the saved disk file to recover."
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

  // -- SEARCH GROUP (part 2: search-symbol) ---------------------------------
  if (g('search')) {
  registerMcpTool({
    name:           'search-symbol',
    group:          'search',
    category:       'search',
    requiresEditor: false,
    title:          'Search Symbol',
    description: [
      'Find all uses of a C/C++ symbol (function name, variable, macro) across the project using whole-word matching.',
      "USE THIS INSTEAD OF grep-project when searching for a symbol name \u2014 it automatically wraps the query in word boundaries so 'init' won't match 'initialize' or 'reinit'. Returns file path, line number, and line text for every match.",
      'definitionsOnly:true \u2014 filter results to lines that look like definitions or declarations (function signatures, variable declarations). Use this to find where a symbol is defined rather than called.',
      'contextLines:N \u2014 return N lines before and after each match. Use this to understand the code around each use.',
      'occurrence:N \u2014 return only the Nth match across the entire search with its context. Use this to get the exact file and line of a specific instance.',
      "glob \u2014 restrict to a file pattern (default: '**/*.{c,cpp,h,hpp}'). Change to '**/*.js' etc for other languages.",
      'Results capped at maxMatches (default 200).',
    ].join(' '),
    inputSchema: {
      symbol:          z.string(),
      glob:            z.string().optional(),
      definitionsOnly: z.boolean().optional(),
      maxMatches:      z.number().optional(),
      contextLines:    z.number().optional(),
      occurrence:      z.number().optional(),
    },
    handler: async ({ symbol, glob = '**/*.{c,cpp,h,hpp}', definitionsOnly = false, maxMatches = 200, contextLines = 0, occurrence = 0 }, ctx) => {
      const roots = atom.project.getPaths();
      if (!roots.length) return ctx.fail('noRoot', 'No project root open.');

      const wordRe = new RegExp(`\\b${escapeRegex(symbol)}\\b`);
      const defRe  = new RegExp(`(?:^|[\\s*])${escapeRegex(symbol)}\\s*(?:\\(|=|;)`);

      let allFiles = [];
      for (const root of roots) allFiles = allFiles.concat(await walkDir(root));
      const globRe = globToRegex(glob);
      allFiles = allFiles.filter(f => globRe.test(f.replace(/\\/g, '/')));

      const matches   = [];
      let truncated   = false;
      let globalIndex = 0;

      outer:
      for (const filePath of allFiles) {
        let text;
        try { text = await readTextFromFile(filePath); } catch { continue; }
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
        logFailure('search_symbol', 'noMatch', null, null, null, symbol);
        return ctx.fail('noMatch', `occurrence ${occurrence} not found \u2014 only ${globalIndex} match(es) in project.`);
      }
      if (matches.length === 0) {
        logFailure('search_symbol', 'noMatch', null, null, null, symbol);
        bump('search_symbol', 'fails.noMatch');
        return { content: [{ type: 'text', text: JSON.stringify({ symbol, matchCount: 0, truncated: false, matches: [] }, null, 2) }], matchCount: 0, truncated: false };
      }

      bump('search_symbol', 'hits');
      if (occurrence > 0) bump('search_symbol', 'hintsUsed.occurrence');
      if (contextLines > 0) bump('search_symbol', 'hintsUsed.contextLines');
      return {
        content: [{ type: 'text', text: JSON.stringify({ symbol, matchCount: matches.length, truncated, matches }, null, 2) }],
        matchCount: matches.length, truncated,
      };
    },
  });


// ── get-repo-map (migrated to Tool Framework) ──────────────────────────────
  if (g('search')) registerMcpTool({
    name:           'get-repo-map',
    group:          'search',
    category:       'command',
    requiresEditor: false,
    title: 'Get Repo Map',
    description: [
      "Return a compact Aider-style repo map — function signatures grouped by file, ranked by PageRank importance, rendered with — prefix and ?... ellipsis between non-consecutive lines.",
      "USE THIS as the first call on an unfamiliar codebase to understand its structure without reading individual files.",
      "Uses tree-sitter (via open Pulsar editors) for accurate symbol extraction; falls back to regex for closed files.",
      "Output fits within a token budget (default 1024 tokens — 4096 chars). Binary search finds the most symbols that fit.",
      "glob — restrict to a file pattern e.g. '**/*.c' or 'src/**/*.js'. Defaults to all C/C++/JS/TS files.",
      "excludeGlob — exclude files matching a pattern e.g. 'test/**' or '**/*.test.js'. Applied after glob.",
      "maxTokens — token budget for output (default 1024). Increase for large projects.",
      "minRefs — only include symbols referenced from at least this many other files (default 0 = include all).",
      "mentionedFiles — array of file paths (relative or absolute) to boost in PageRank personalisation.",
      "includeLineNumbers — include line number annotation in output (default true).",
      "File health warnings appended when issues found: [unicode] non-ASCII chars present (use fuzzyContent or regex:true when editing)," +
      " [mojibake xN] corrupted cp1252-as-UTF-8 encoding (file is broken)," +
      " [crlf xN] Windows line endings detected," +
      " [trailing-comments xN] lines with inline trailing block or line comments —" +
      " str_replace old_str often hallucinates or omits these; autoStripComment rescue handles them automatically," +
      " [check-me xN] salvaged trailing comments left by autoStripComment as /* CHECK: ... */ — verify each one is correct before removing the marker.",
    ].join(" "),
    inputSchema: {
      glob:               z.string().optional(),
      excludeGlob:        z.string().optional(),
      maxTokens:          z.number().optional(),
      minRefs:            z.number().optional(),
      mentionedFiles:     z.array(z.string()).optional(),
      includeLineNumbers: z.boolean().optional(),
    },
    async handler({ glob = "", excludeGlob = "", maxTokens = 1024, minRefs = 0, mentionedFiles = [], includeLineNumbers = true } = {}) {
      const roots = atom.project.getPaths();
      if (!roots.length) {
        bump('get_repo_map', 'fails.noProject');
        return { content: [{ type: "text", text: "No project root open." }] };
      }

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

      // -- 2. Extract symbols — tree-sitter for open editors, regex fallback --
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

      async function extractSymbols(filePath) {
        const fpFwd = filePath.replace(/\\/g, "/");
        const ed = openEditors.get(fpFwd);
        let txt;
        try { txt = ed ? ed.getText() : await fs.promises.readFile(filePath, "utf8"); } catch { return; }
        // getSymbols: uses tree-sitter if editor is open, falls back to regex for closed files.
        // getSymbolsFromText also picks up REGISTER_TOOL_RE for JS registerTool() patterns.
        const syms = getSymbols(ed || null, txt, filePath);
        for (const s of syms) {
          if (s.name && s.name.length > 1)
            symbols.push({ filePath, line: s.startRow + 1, name: s.name, sig: s.sig, refs: 0, score: 0 });
        }
      }

      for (const fp of allFiles) await extractSymbols(fp);

      // -- 3. Build file→file reference graph for PageRank ----------------
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

      // -- 4. Sort files by rank, filter by minRefs ------------------------
      const sortedFiles = [...symsByFile.entries()]
        .filter(([, syms]) => syms.some(s => s.refs >= minRefs))
        .sort((a, b) => (rank[b[0]] || 0) - (rank[a[0]] || 0));

      // -- 5a. File-health scan (unicode / mojibake / crlf) -----------------
      const fileHealthWarnings = [];
      for (const fp of allFiles) {
        const txt = fileTexts[fp];
        if (!txt) continue;
        const rel = fp.replace(/\\/g, '/').replace(projectRoot + '/', '');
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
        // after code. str_replace old_str often hallucinate or omit these; use
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
        if (flags.length) fileHealthWarnings.push('  ' + rel + ': ' + flags.join(' '));
      }
      const healthBlock = fileHealthWarnings.length
        ? '\n\n// File health warnings:\n' + fileHealthWarnings.join('\n')
        : '';

      // -- 5. Token-budget binary search + TreeContext rendering -----------
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
            if (prevLine !== -1 && s.line > prevLine + 1) out.push("?...");
            const lineTag = includeLineNumbers ? ` // L${s.line}` : "";
            out.push(`—${s.sig}${lineTag}`);
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
        (minRefs > 0 ? `, minRefs=${minRefs}` : "") +
        `, ~${Math.round(best.text.length / 4)} tokens`;

      bump('get_repo_map', 'hits');
      return {
        content: [{ type: "text", text: "// Repo map — " + summary + "\n\n" + best.text + healthBlock }],
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
      "Returns name, line number, and the full signature line.",
      "Useful for finding FUN_8000* or all functions containing 'crypto', 'net', etc.",
    ].join(" "),
    inputSchema: {
      query:         z.string(),
      regex:         z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
    },
    handler: async ({ query, regex = false, caseSensitive = false }, ctx) => {
      const flags     = caseSensitive ? "" : "i";
      const searchPat = regex
        ? new RegExp(query, flags)
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
      const symbols = getSymbols(ctx.editor, ctx.text, ctx.editor.getPath() || '');
      const results = symbols
        .filter(s => !GHIDRA_SKIP_KW.has(s.name) && searchPat.test(s.name))
        .map(s => ({ line: s.startRow + 1, name: s.name, signature: s.sig }));
      if (results.length === 0) {
        bump('ghidra_search_functions', 'fails.noMatch');
        return { content: [{ type: "text", text: `No functions matching "${query}" found.` }] };
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
      /* Gate style checker off for Ghidra files — decompiled pseudocode violates every rule */
      const filePath = ctx.editor.getPath();

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
        content: [{ type: "text", text:
          `Comment inserted above line ${targetRow + 1}${functionName ? ` (function "${functionName}")` : ""}.`
          + (styleSuffix ? `\n${styleSuffix}` : "")
        }]
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
      "Shows reverse engineering progress at a glance —",
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
      "Disabled tools can be enabled at runtime with enable-group — no Pulsar reload needed.",
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
      "Enable a disabled tool group at runtime — tools become available immediately without reloading Pulsar.",
      "Use list-tools first to see which groups are disabled.",
      "Toggleable groups: edit, fileOps, navigation, safety, search, diagnostics, highlight, ghidra.",
      "Note: disabling a group requires a Pulsar reload; enabling is always instant.",
      "Also updates the saved config so the group stays enabled after restart."
    ].join(" "),
    inputSchema: {
      group: z.enum(["edit", "fileOps", "navigation", "safety", "search", "diagnostics", "highlight", "debugging", "ghidra"])
    },
    handler: async ({ group }) => {
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
  });
  // -- DEBUGGING GROUP --------------------------------------------------------
  if (g('debugging')) {
  registerMcpTool({
    name: "get-debug-log",
    group: "debugging",
    category: "command",
    requiresEditor: false,
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
      "Query the persistent fault log (session/session-faults.ndjson) — a structured record of every tool failure written to disk.",
      "Each entry includes: ts (ISO timestamp), tool, reason, filePath, nearLine, and other context.",
      "Use tail to limit output (default 20). Filter by tool name (e.g. 'str_replace') or reason (e.g. 'noMatch', 'ambiguous').",
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
        return { content: [{ type: "text", text: "(session/session-faults.ndjson not found — no failures recorded yet)" }] };
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
      "Return per-tool edit statistics for this session AND lifetime totals across all sessions.",
      "SESSION: counters since last server restart.",
      "LIFETIME: cumulative totals loaded from disk (session/session-stats.json), survives restarts.",
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
    },
    async handler({ reset = false }) {
      dbg("get-edit-stats", "ARGS", { reset });

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
        // Zero all tools generically — self-maintaining, no manual update needed when tools are added
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
  });
  // -- session-notes ----------------------------------------------------------
  // Notes file lives in the session/ subfolder alongside other server data files
  const notesPath = SESSION_DIR
    ? path.join(SESSION_DIR, 'session-notes.ndjson')
    : path.join(atom.packages.getLoadedPackage('pulsar-edit-mcp-server').path, 'session', 'session-notes.ndjson');

  // Ensure the file exists — NDJSON: one JSON record per non-empty line
  async function loadNotes() {
    try {
      const raw = await fs.promises.readFile(notesPath, 'utf8');
      return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    } catch {
      return [];
    }
  }

  registerMcpTool({
    name: "session-notes",
    group: "debugging",
    category: "command",
    requiresEditor: false,
    title: "Session Notes",
    description: [
      "Persistent cross-session notes written by the LLM. Stored as NDJSON (one record per line).",
      "action:'write'  — append a note (record what failed, what worked, lessons learned).",
      "action:'read'   — retrieve notes at session start. tail:N limits to last N records. Output is grouped by title with ### sections and [absIdx] tags for targeting.",
      "action:'edit'   — replace a note in-place. Requires index (0-based) and note (new text). Preserves original timestamp.",
      "action:'delete' — remove a record by index (0-based). All subsequent records shift down.",
      "action:'clear'  — wipe all notes.",
      "Optionally pass project: a short label to group notes by project.",
      "RECOMMENDED: call action:'read' at the start of every session on a known project.",
      "RECOMMENDED: call action:'write' before ending a session where edits were made."
    ].join(" "),
    inputSchema: {
      action:  z.enum(["read", "write", "edit", "delete", "clear"]),
      note:    z.string().optional(),                          // required for write/edit
      project: z.string().optional(),                          // optional label
      tail:    z.number().int().min(1).max(100).optional(),    // read: last N entries
      index:   z.number().int().min(0).optional(),             // edit/delete: 0-based note index
    },
    async handler({ action, note, project, tail, index }) {
      dbg("session-notes", "ARGS", { action, project, tail, index, noteLen: note?.length });

      // helper: parse a raw note string into NDJSON fields { title, section, items }
      function parseNoteStr(str) {
        const lines = str.trim().split('\n').filter(l => l.trim());
        const title = lines[0] || 'Untitled';
        const rest  = lines.slice(1);
        // If the next line looks like a ## heading, treat it as section
        let section = null;
        let items   = rest;
        if (rest.length > 0 && /^##/.test(rest[0])) {
          section = rest[0].replace(/^#+\s*/, '');
          items   = rest.slice(1);
        }
        return { title, section, items };
      }
      // helper: write records array as NDJSON (one JSON object per line)
      async function saveNotes(notes) {
        const ndjson = notes.map(r => JSON.stringify(r)).join('\n');
        await fs.promises.writeFile(notesPath, ndjson + '\n', 'utf8');
      }

      if (action === "read") {
        const notes = await loadNotes();
        const entries = tail ? notes.slice(-tail) : notes;
        if (entries.length === 0) {
          return { content: [{ type: "text", text: "No session notes recorded yet." }] };
        }
        // Group consecutive records sharing the same title into a single display block.
        // Each record gets an absolute [index] shown for edit/delete targeting.
        const startIdx = tail ? notes.length - entries.length : 0;
        const grouped  = [];
        let   curGroup = null;
        entries.forEach((rec, i) => {
          const absIdx = startIdx + i;
          const ts     = rec.ts || rec.timestamp || '?';
          const proj   = rec.project ? ` [${rec.project}]` : '';
          if (!curGroup || curGroup.title !== rec.title) {
            curGroup = { title: rec.title || '(untitled)', ts, proj, sections: [] };
            grouped.push(curGroup);
          }
          // Support legacy records that used .note instead of .items
          const body = rec.items
            ? rec.items.join('\n')
            : (Array.isArray(rec.note) ? rec.note.join('\n') : (rec.note || ''));
          curGroup.sections.push({ absIdx, section: rec.section || null, body });
        });
        const lines = grouped.map(g => {
          const header = `## ${g.title}  [${g.ts}]${g.proj}`;
          const secs   = g.sections.map(s => {
            const idxTag = `[${s.absIdx}]`;
            if (s.section) return `### ${s.section}  ${idxTag}\n${s.body}`;
            return `${idxTag}\n${s.body}`;
          });
          return [header, ...secs].join('\n');
        });
        return {
          content: [{ type: "text", text: `${entries.length} note(s):\n\n${lines.join('\n\n---\n\n')}` }],
          count: entries.length
        };
      }

      if (action === "write") {
        if (!note || !note.trim()) {
          return { content: [{ type: "text", text: "⚠ note is required for action:write." }] };
        }
        const notes = await loadNotes();
        const parsed = parseNoteStr(note);
        const entry  = {
          ts:      new Date().toISOString(),
          project: project || null,
          title:   parsed.title,
          section: parsed.section,
          items:   parsed.items
        };
        notes.push(entry);
        await saveNotes(notes);
        dbg("session-notes", "note written", { project, ts: entry.ts });
        return {
          content: [{ type: "text", text: `✅ Note saved. Total notes: ${notes.length}.` }],
          totalNotes: notes.length
        };
      }

      if (action === "edit") {
        if (index === undefined || index === null) {
          return { content: [{ type: "text", text: "⚠ index is required for action:edit." }] };
        }
        if (!note || !note.trim()) {
          return { content: [{ type: "text", text: "⚠ note (new text) is required for action:edit." }] };
        }
        const notes = await loadNotes();
        if (index < 0 || index >= notes.length) {
          return { content: [{ type: "text", text: `⚠ index ${index} out of range. Total notes: ${notes.length}.` }] };
        }
        const parsed = parseNoteStr(note);
        notes[index].title   = parsed.title;
        notes[index].section = parsed.section;
        notes[index].items   = parsed.items;
        notes[index].edited  = new Date().toISOString();  // preserve original ts
        await saveNotes(notes);
        dbg("session-notes", "note edited", { index });
        return {
          content: [{ type: "text", text: `✅ Note [${index}] updated. Total notes: ${notes.length}.` }],
          totalNotes: notes.length
        };
      }

      if (action === "delete") {
        if (index === undefined || index === null) {
          return { content: [{ type: "text", text: "⚠ index is required for action:delete." }] };
        }
        const notes = await loadNotes();
        if (index < 0 || index >= notes.length) {
          return { content: [{ type: "text", text: `⚠ index ${index} out of range. Total notes: ${notes.length}.` }] };
        }
        const removed = notes.splice(index, 1)[0];
        await saveNotes(notes);
        dbg("session-notes", "note deleted", { index, timestamp: removed.timestamp });
        return {
          content: [{ type: "text", text: `✅ Note [${index}] deleted (was: ${removed.timestamp}). Total notes: ${notes.length}.` }],
          totalNotes: notes.length
        };
      }

      if (action === "clear") {
        await saveNotes([]);
        dbg("session-notes", "notes cleared");
        return { content: [{ type: "text", text: "✅ All session notes cleared." }] };
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
    async handler({ filePath }) {
      try {
        // Resolve the file path
        let targetPath = filePath;
        if (!targetPath) {
          const editor = atom.workspace.getActiveTextEditor();
          if (!editor) return { content: [{ type: "text", text: "⚠ No active editor and no filePath provided." }] };
          targetPath = editor.getPath();
        }
        if (!targetPath) return { content: [{ type: "text", text: "⚠ Active editor has no file path (unsaved buffer)." }] };
        if (!isKernelFile(targetPath)) {
          return { content: [{ type: "text", text: `⚠⚠ ${path.basename(targetPath)} is not a .c/.h file — skipping style check.` }] };
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
        dbg("checkpatch", `${totalViolations} violations in ${path.basename(targetPath)}`);

        if (totalViolations === 0) {
          return { content: [{ type: "text", text: `✅ ${path.basename(targetPath)}: no style violations found.` }] };
        }

        // Group by rule
        const byRule = {};
        for (const v of violations) {
          if (!byRule[v.type]) byRule[v.type] = [];
          byRule[v.type].push(v);
        }

        const lines = [`⚠⚠ ${path.basename(targetPath)}: ${totalViolations} violation(s) across ${Object.keys(byRule).length} rule(s)\n`];
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
        return { content: [{ type: "text", text: `❌ checkpatch error: ${err.message}` }] };
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
      "filePath -- path to the file to check. Omit to use the active editor.",
      "RESPONSE FORMAT: one line per metric. Clean files get a single checkmark line.",
      "Imbalanced files get a warning per metric with the net count.",
    ].join("\n"),
    inputSchema: {
      filePath: z.string().optional().describe("Path to the source file to check. Omit for active editor. Works on any brace-delimited language."),
    },
    async handler({ filePath }) {
      try {
        bump("check-struct", "hits");

        let targetPath = filePath;
        if (!targetPath) {
          const editor = atom.workspace.getActiveTextEditor();
          if (!editor) return { content: [{ type: "text", text: "\u274c No active editor and no filePath provided." }] };
          targetPath = editor.getPath();
        }
        if (!targetPath) return { content: [{ type: "text", text: "\u274c Active editor has no file path (unsaved buffer)." }] };
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
  // namingcheck — check kernel C file for naming violations
  // -------------------------------------------------------------------------
  registerMcpTool({
    name: "namingcheck",
    group: "kernelC",
    category: "command",
    requiresEditor: false,
    title: "Naming Check",
    description: [
      "Check a kernel C file for naming convention violations.",
      "Checks: function names start with a recognised verb tier (get_, set_, init_, handle_, —),",
      "no camelCase in function or variable names, macro names are ALL_CAPS.",
      "Kernel .c/.h files only — returns a gating message for other file types.",
      "filePath: path to the file to check (defaults to active editor if omitted).",
    ].join(" "),
    inputSchema: { filePath: z.string().optional() },
    async handler({ filePath }) {
      const curStats = editStats["namingcheck"] || (editStats["namingcheck"] = { hits: 0, fails: { notKernel: 0 }, misses: { clean: 0 } });
      const editor = atom.workspace.getActiveTextEditor();
      const targetPath = filePath || editor?.getPath();
      if (!targetPath) return { content: [{ type: "text", text: "⚠ No file path provided and no active editor." }] };
      if (!isKernelFile(targetPath)) {
        curStats.fails.notKernel++;
        return { content: [{ type: "text", text: `⚠⚠ namingcheck: not a kernel C file (${path.basename(targetPath)}) — skipped.` }] };
      }
      let text;
      try { text = await readTextFromFile(targetPath); }
      catch (err) { return { content: [{ type: "text", text: `❌ Cannot read file: ${err.message}` }] }; }

      const { violations, totalViolations } = checkNaming(text, targetPath);
      if (totalViolations === 0) {
        curStats.misses.clean++;
        curStats.hits++;
        return { content: [{ type: "text", text: `✅ namingcheck: no violations in ${path.basename(targetPath)}.` }] };
      }
      curStats.hits++;
      const report = formatNamingViolations(violations);
      return { content: [{ type: "text", text: report }], totalViolations };
    }
  });

  // -------------------------------------------------------------------------
  // check-function-docs — check every non-static fn has a kernel-style doc
  // -------------------------------------------------------------------------
  registerMcpTool({
    name: "check-function-docs",
    group: "kernelC",
    category: "command",
    requiresEditor: false,
    title: "Check Function Docs",
    description: [
      "Check that every non-static function in a kernel C file has a kernel-doc /** */ comment above it.",
      "Reports three severity tiers: missing (no comment at all), wrongStyle (// single-line above fn — always wrong),",
      "plainDoc (plain /* */ present — not a style error but not extracted by the kernel-doc tool; advisory for exported/public fns).",
      "The correct kernel-doc format is /** with function_name() - desc, @arg:, Context:, Return: sections.",
      "Kernel .c/.h files only.",
      "filePath: path to the file to check (defaults to active editor if omitted).",
    ].join(" "),
    inputSchema: { filePath: z.string().optional() },
    async handler({ filePath }) {
      const curStats = editStats["check-function-docs"] || (editStats["check-function-docs"] = { hits: 0, fails: { notKernel: 0 }, misses: { allGood: 0 } });
      const editor = atom.workspace.getActiveTextEditor();
      const targetPath = filePath || editor?.getPath();
      if (!targetPath) return { content: [{ type: "text", text: "⚠ No file path provided and no active editor." }] };
      if (!isKernelFile(targetPath)) {
        curStats.fails.notKernel++;
        return { content: [{ type: "text", text: `⚠⚠ check-function-docs: not a kernel C file (${path.basename(targetPath)}) — skipped.` }] };
      }
      let text;
      try { text = await readTextFromFile(targetPath); }
      catch (err) { return { content: [{ type: "text", text: `❌ Cannot read file: ${err.message}` }] }; }

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
        return { content: [{ type: "text", text: `✅ check-function-docs: all non-static functions documented in ${path.basename(targetPath)}.` }] };
      }
      curStats.hits++;
      const lines = [`⚠⚠ function docs report — ${path.basename(targetPath)}`];
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
          lines.push(`  L${f.line}: ${f.name}()${tag} — found: ${f.found}`);
          lines.push(`    sig: ${f.signature.trim()}`);
        }
      }
      if (plainDoc.length > 0) {
        lines.push(`\nPlain /* */ — advisory (${plainDoc.length}):`);
        for (const f of plainDoc) {
          const tag = f.inHeader ? ' [in header]' : '';
          lines.push(`  L${f.line}: ${f.name}()${tag}`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }], missingCount: missing.length, wrongStyleCount: wrongStyle.length, plainDocCount: plainDoc.length };
    }
  });

  // -------------------------------------------------------------------------
  // insert-function-doc — insert kernel /* */ skeleton above a named function
  // -------------------------------------------------------------------------
  registerMcpTool({
    name: "insert-function-doc",
    group: "kernelC",
    category: "command",
    requiresEditor: true,
    title: "Insert Function Doc",
    description: [
      "Insert a kernel-doc /** */ skeleton above a named function: function_name() - desc, @param:, Context:, Return: sections.",
      "Parses parameter names from the signature; handles variadic @... args.",
      "Does NOT overwrite an existing comment — aborts if a comment is already present.",
      "Kernel .c/.h files only.",
      "functionName: name of the function to document (required).",
      "line: 1-based line number of the function definition — use the value from check-function-docs output for a precise anchor (optional; falls back to file scan).",
      "Use open-file to switch to the target file before calling this tool.",
    ].join(" "),
    inputSchema: {
      functionName: z.string(),
      line: z.number().int().optional(),
    },
    async handler({ functionName, line: hintLine }) {
      const curStats = editStats["insert-function-doc"] || (editStats["insert-function-doc"] = { hits: 0, fails: { notKernel: 0, notFound: 0, noEditor: 0 } });
      const editor = atom.workspace.getActiveTextEditor();
      if (!editor) { curStats.fails.noEditor++; return { content: [{ type: "text", text: "⚠ No editor available." }] }; }

      const targetPath = editor.getPath();
      if (!isKernelFile(targetPath)) {
        curStats.fails.notKernel++;
        return { content: [{ type: "text", text: `⚠⚠ insert-function-doc: not a kernel C file — skipped.` }] };
      }

      const buffer = editor.getBuffer();
      const text = buffer.getText();
      const lines = text.split('\n');

      /* find the function definition line — use tree-sitter symbols */
      let fnLine = -1;
      let fnSignature = '';
      const _docSyms = getSymbolsFromText(text, targetPath);
      const _docMatch = findFunction(_docSyms, functionName, hintLine !== undefined ? { nearLine: hintLine } : {});
      if (_docMatch) {
        fnLine = _docMatch.startRow;
        fnSignature = lines[fnLine] || '';
      }
      if (fnLine === -1) {
        curStats.fails.notFound++;
        return { content: [{ type: "text", text: `❌ insert-function-doc: function '${functionName}' not found.` }] };
      }

      /* check if a comment already exists above (skip blanks) */
      let prevIdx = fnLine - 1;
      while (prevIdx >= 0 && lines[prevIdx].trim() === '') prevIdx--;
      if (prevIdx >= 0 && (lines[prevIdx].trimStart().endsWith('*/') || lines[prevIdx].trimStart().startsWith('/*'))) {
        return { content: [{ type: "text", text: `⚠⚠ insert-function-doc: '${functionName}' already has a comment above it — not overwriting.` }] };
      }

      const skeleton = buildDocSkeleton(fnSignature);
      const insertRow = fnLine; /* insert before this row */
      buffer.insert([insertRow, 0], skeleton);
      await editor.save();
      curStats.hits++;
      return { content: [{ type: "text", text: `✅ Doc skeleton inserted above '${functionName}' at L${fnLine + 1}.` }], insertedAt: fnLine + 1 };
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

// Pulsar package deactivate hook — called synchronously when the package is
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

  // Zero all tools generically — self-maintaining, no manual update needed when tools are added
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
  // Zero only the persisted lifetime totals — session counters keep running
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
