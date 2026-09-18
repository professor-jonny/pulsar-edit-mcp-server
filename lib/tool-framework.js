'use babel';
// ---------------------------------------------------------------------------
// lib/tool-framework.js  —  Tool Framework v1.2
// ---------------------------------------------------------------------------
// Provides registerMcpTool(): a thin wrapper around server.registerTool() that
// handles the repeated scaffold every edit/search tool needs:
//   • editor + buffer acquisition
//   • stats bump (hits / fails / dryRuns)
//   • consecutive-failure counter management
//   • smartSuggestion injection on repeated failures
//   • auto-save on commit (buffer.save() after every successful edit)
//   • ctx.fail(reason, msg)        — bump fail, return error content
//   • ctx.commit(meta, warnings)   — bump hit, auto-save, buildEditResponse + decorateEditedLines
//   • ctx.dryRunReturn(payload)    — bump dryRun, return dry-run content
//
// Usage (in mcp-registration.js):
//
//   const { makeRegisterMcpTool } = require('./tool-framework');
//   const registerMcpTool = makeRegisterMcpTool(server, {
//     bump, buildEditResponse, decorateEditedLines, applyStyleCheck,
//     maybeLintSuffix, smartSuggestion, successNudge,
//   });
//
//   registerMcpTool({
//     name:     'replace-all',
//     group:    'edit',
//     category: 'edit',           // 'edit' | 'search' | 'command' | 'nav'
//     features: { dryRun: true, lint: true, styleCheck: true, successNudge: true, structCheck: true },
//     title:    'Replace All',
//     description: '...',
//     inputSchema: { ... },       // Zod shape (passed straight through)
//     handler: async (args, ctx) => { ... }
//   });
//
// ctx object exposed to handlers:
//   ctx.editor         — resolved TextEditor (by filePath if provided, else active tab)
//   ctx.buffer         — editor.getBuffer()
//   ctx.allLines       — buffer.getLines() snapshot at call time
//   ctx.text           — buffer.getText() snapshot at call time
//   ctx.filePath       — resolved file path (args.filePath or editor.getPath())
//   ctx.fail(reason, msg, extra?)
//       bump fail counter, optionally bump consec counter, return MCP content
//   ctx.commit(meta, warnings?)
//       buffer already written by handler; auto-saves, bumps hit, decorates, buildEditResponse
//       meta: { tool, line?, linesChanged?, scopeLabel?, tags?, nudgeCtx? }
//       warnings: { lint?, style?, nudge?, struct? }
//       structCheck (features.structCheck:true) requires ctx.snapshotOriginal()
//       to have been called before the buffer write — silently skipped otherwise.
//   ctx.dryRunReturn(payload)
//       bump dryRuns, return payload wrapped in MCP content if not already
//   ctx.consecFailures — consecutive failure count for this tool (read-only)
// ---------------------------------------------------------------------------

/**
 * Factory — call once per server instance.
 *
 * @param {object} server   — MCP server (server.registerTool already wrapped by mcp-registration.js)
 * @param {object} deps     — local helpers that cannot be required() directly:
 *   bump, buildEditResponse, decorateEditedLines, applyStyleCheck,
 *   maybeLintSuffix, smartSuggestion, successNudge (optional — only needed
 *   if any registered tool sets features.successNudge)
 * @returns {function} registerMcpTool
 */
function makeRegisterMcpTool(server, deps) {
  const { getSymbols } = require('./tree-sitter-symbols'); // B32: lazy symbol lookup for successNudge gating
  const { snapshot: structSnapshot, delta: structDelta, isStructFileType } = require('./struct-check'); // B33-followup: features.structCheck gating
  const _registeredNames = new Set(); // B7: duplicate tool name detection
  const {
    bump,
    buildEditResponse,
    decorateEditedLines,
    applyStyleCheck,
    maybeLintSuffix,
    smartSuggestion,
    successNudge, // B32: optional — only required if any registered tool sets features.successNudge
    onCommit,           // optional: onCommit(filePath) called after every successful commit
  } = deps;

  // Per-tool consecutive failure counters (mirrors the hand-rolled objects in
  // tool-hints.js but owned here so the framework can manage them).
  // Key: tool name (hyphenated).  Value: { count: number }.
  const consecCounters = {};

  /**
   * Register a tool via the framework.
   * @param {object} cfg — tool configuration object (see module header).
   */
  function registerMcpTool(cfg) {
    const {
      name,
      group:    _group,            // 'edit' | 'search' | 'nav' | 'fileOps' | ...  (reserved for Phase 2)
      category: _category = 'edit', // determines which bump key family to use     (reserved for Phase 2)
      features = {},
      title,
      description,
      inputSchema,
      handler,
      requiresEditor = true,     // set false for tools that don't need an active editor
      skipFilePreload = false,   // set true for tools whose target file legitimately may not exist yet (e.g. create-file) — the generic filePath preload below always tries to read the file, which is wrong for tools that CREATE it themselves in their own handler body
    } = cfg;

    // Normalise tool name to stats key (replace-all → replace_all)
    const statsKey = name.replace(/-/g, '_');

    // B7: warn on duplicate tool name
    if (_registeredNames.has(name)) {
      console.warn(`[tool-framework] duplicate tool name "${name}" — previous registration will be overwritten`);
    }
    _registeredNames.add(name);

    // Allocate a consecutive-failure counter for this tool
    if (!consecCounters[name]) consecCounters[name] = { count: 0 };
    const consec = consecCounters[name];

    server.registerTool(
      name,
      {
        title: title || name,
        description,
        inputSchema,
      },
      async (args) => {

        // ── Editor acquisition ──────────────────────────────────────────────
        // Priority order:
        //   1. args.filePath provided:
        //      a. File already open in a tab → use its TextEditor + buffer directly.
        //         Post-commit: focus the tab if 'focusEditedFile' config is true.
        //      b. File not open → bufferForPath() — no tab created, no focus change.
        //         Full save() + undo history, encoding-safe. Toggle irrelevant.
        //   2. requiresEditor:true, no filePath → active tab (read/nav/cursor tools).
        //   3. requiresEditor:false → no editor needed (stats, shell tools etc).
        //
        // Edit tools must always pass filePath. Active tab is only for read/cursor tools.
        const path = require('path');
        const { resolveProjectPath } = require('./buffer-helpers'); // [B72 followup] resolve root:<name>/<rest> before any fs/bufferForPath use
        let editor = null, buffer = null, allLines = [], text = '';
        let _resolvedFilePath = null;   // canonical path for onCommit + focus

        if (args.filePath && skipFilePreload) {
          // Tool owns its own fs I/O (e.g. create-file) — just resolve/normalize the
          // path for ctx.filePath without trying to read or open it here.
          try {
            _resolvedFilePath = path.resolve(resolveProjectPath(args.filePath));
          } catch (err) {
            return { content: [{ type: 'text', text: `❌ Could not resolve path: ${args.filePath} — ${err.message}` }] };
          }
        } else if (args.filePath) {
          // [B72 followup] This generic wrapper previously resolved/loaded args.filePath
          // directly (path.resolve + atom.project.bufferForPath) BEFORE any registered
          // handler body ever ran -- completely bypassing readTextFromFile/resolveProjectPath
          // and the root:<rootName>/<rest> prefix implemented there. Route through the same
          // resolveProjectPath helper here so root: paths (and the existing relative-path
          // fallback from B62) work uniformly for every tool registered via this framework,
          // not just the read-only tools that happened to call readTextFromFile themselves.
          let _rawFilePath = args.filePath;
          try {
            _rawFilePath = resolveProjectPath(args.filePath);
          } catch (err) {
            // e.g. root:<unknown> -- surface the clear resolveProjectPath error rather than
            // falling through to a raw fs/bufferForPath call that would just EINVAL on the
            // literal 'root:...' string.
            return { content: [{ type: 'text', text: `❌ Could not load file: ${args.filePath} — ${err.message}` }] };
          }
          _resolvedFilePath = path.resolve(_rawFilePath);

          // (a) Already open in a tab?
          editor = atom.workspace.getTextEditors()
            .find(e => e.getPath() && path.resolve(e.getPath()) === _resolvedFilePath)
            || null;

          if (editor) {
            // Live TextEditor — decorations, undo, focus all work
            buffer = editor.getBuffer();
          } else {
            // [B73] Previously this ALWAYS called atom.project.bufferForPath() for
            // any file not already open in a tab, for EVERY tool registered via this
            // framework -- including pure read/search/nav tools (read-file, get-file-summary,
            // grep-file, etc, category !== 'edit') that never call ctx.commit()/buffer.save()
            // and have no need for a real, live, Pulsar-tracked TextBuffer at all.
            // bufferForPath() registers the buffer with atom.project as a side effect
            // (file watcher + tree-sitter grammar assignment) and never releases it on
            // its own -- this is the exact same unbounded-buffer-leak bug diagnosed and
            // fixed for buffer-helpers.js's readTextFromFile as B68/B69, just at a
            // different, universal choke point that B69 never touched. Confirmed via the
            // B68 investigation: leaking one tree-sitter-parsed buffer per file touched
            // during a large sweep (e.g. grep-project-class usage) causes multi-GB memory
            // growth and, per B70/B71's crash-dump analysis, a genuine native renderer
            // crash (INVALID_POINTER_WRITE) when a leaked buffer is later torn down while
            // still referenced -- so this is not just a memory nit, it's the same crash.
            //
            // FIX: only go through bufferForPath (real, live, trackable buffer) when the
            // tool might actually mutate + save (category === 'edit'), OR when a buffer
            // for this path is already registered elsewhere (some other live consumer
            // genuinely has it open -- must not bypass that with a second, divergent read).
            // Otherwise, read the file directly via fs.promises.readFile -- no Pulsar
            // buffer is ever created, so there is nothing to leak or race-destroy. This
            // mirrors B69's already-proven-safe design (buffer-helpers.js resolveProjectPath
            // callers), applied here so it actually covers every tool that goes through
            // this shared framework, not just the ones that separately called
            // readTextFromFile themselves.
            const alreadyRegistered = atom.project.getBuffers()
              .some(b => b.getPath() && path.resolve(b.getPath()) === _resolvedFilePath);

            if (_category === 'edit' || alreadyRegistered) {
              try {
                buffer = await atom.project.bufferForPath(_rawFilePath);
              } catch (err) {
                return { content: [{ type: 'text', text: `❌ Could not load file: ${args.filePath} — ${err.message}` }] };
              }
            } else {
              // No live buffer needed or wanted -- read straight from disk.
              const fs = require('fs');
              let raw;
              try {
                raw = await fs.promises.readFile(_resolvedFilePath, 'utf8');
              } catch (err) {
                return { content: [{ type: 'text', text: `❌ Could not load file: ${args.filePath} — ${err.message}` }] };
              }
              if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // strip UTF-8 BOM, matches bufferForPath's getText()
              const _rawLines = raw.split(/\r\n|\r|\n/);
              // Lightweight buffer-shaped shim: read-only tools only ever call
              // getLines()/getText()/getPath() on ctx.buffer (confirmed no registered
              // category!=='edit' tool calls ctx.commit(), which is the only consumer of
              // buffer.save()/setText*). No real Atom TextBuffer is created here at all.
              buffer = {
                getLines: () => _rawLines,
                getText: () => raw,
                getPath: () => _resolvedFilePath,
              };
            }
          }

          allLines = buffer.getLines();
          text     = buffer.getText();

        } else if (requiresEditor) {
          editor = atom.workspace.getActiveTextEditor();
          if (!editor) {
            return { content: [{ type: 'text', text: '❌ No active editor — pass filePath to target a specific file' }] };
          }
          buffer           = editor.getBuffer();
          allLines         = buffer.getLines();
          text             = buffer.getText();
          _resolvedFilePath = editor.getPath() || null;
        }

        // ── ctx object ──────────────────────────────────────────────────────
        const ctx = {
          editor,
          buffer,
          allLines,
          text,
          filePath: _resolvedFilePath,
          get consecFailures() { return consec.count; },
          // Raw consec counter object — handlers can alias this as their legacy
          // failure counter (e.g. const strReplFailures = ctx.consec).
          consec,

          // ctx.fail(reason, msg, extra?)
          // reason: stats key like 'noMatch', 'ambiguous', etc.
          // msg: string returned to LLM
          // extra: optional extra fields merged into the return object
          fail(reason, msg, extra = {}) {
            bump(statsKey, `fails.${reason}`);
            consec.count++;
            const suggestion = (features.consecutiveFailureCounter !== false && consec.count >= 3)
              ? smartSuggestion({ toolName: name, counter: consec, noHintsUsed: false, fileLines: allLines.length, oldStr: null, isCodeFile: false })
              : '';
            return {
              content: [{ type: 'text', text: suggestion ? `${msg}\n\n${suggestion}` : msg }],
              ...extra,
            };
          },

          //   ctx.commit(meta, warnings?)
          // Call AFTER writing to the buffer.  Bumps hit, decorates, builds response.
          // meta: { tool?, line?, linesChanged?, scopeLabel?, tags?,
          //         nudgeCtx?: { noHintsUsed, afterLineOnly, positionalHintName,
          //                      matchedLineContent,
          //                      oldStr, isCodeFile, symbols } }
          //   nudgeCtx is only read when features.successNudge is true (B32).
          //   symbols is optional — if omitted and noHintsUsed is true, commit()
          //   fetches it lazily (same cost-avoidance discipline as the B32
          //   delete-line-range fix: only pay for the tree-sitter parse when the
          //   empty-symbols branch could actually fire).
          // warnings: { lint?, style?, nudge? }
          async commit(meta = {}, warnings = {}) {
            // Resolve lint/style/nudge if handler hasn't already
            const { nudgeCtx, ...restMeta } = meta;
            const resolvedMeta = { tool: name, ...restMeta };
            let lintSuffix  = warnings.lint;
            let styleSuffix = warnings.style;
            let nudgeSuffix = warnings.nudge;
            let structSuffix = warnings.struct;

            if (styleSuffix === undefined && features.styleCheck && editor) {
              // Use current buffer state (post-write), not the pre-call snapshot
              styleSuffix = applyStyleCheck(buffer.getText(), editor.getPath());
            }
            if (lintSuffix === undefined && features.lint && editor) {
              // B84: features.lint accepts true (full per-message detail —
              // existing behavior, right for small/scoped edits) or 'count'
              // (summary only — right for whole-file/large-block tools like
              // create-file, where full detail on a big file would be noise).
              const lintOpts = features.lint === 'count' ? { countOnly: true } : undefined;
              lintSuffix = await maybeLintSuffix(args.lint || false, editor, null, null, lintOpts);
            }
            // B32 — declarative gating pattern: any tool can opt in with
            // features.successNudge:true instead of hand-rolling its own
            // drift-nudge (the duplication that caused B31/B32 in the first
            // place). No-op if the handler didn't pass nudgeCtx.
            if (nudgeSuffix === undefined && features.successNudge && nudgeCtx && successNudge) {
              let symbols = nudgeCtx.symbols;
              if (symbols === undefined && nudgeCtx.noHintsUsed && editor) {
                try { symbols = getSymbols(editor, buffer.getText(), _resolvedFilePath); }
                catch (e) { symbols = undefined; } // symbol lookup failing shouldn't block commit
              }
              nudgeSuffix = successNudge({
                toolName: name,
                noHintsUsed: !!nudgeCtx.noHintsUsed,
                afterLineOnly: !!nudgeCtx.afterLineOnly,
                positionalHintName: nudgeCtx.positionalHintName || null,
                matchedLineContent: nudgeCtx.matchedLineContent,
                fileLines: allLines.length,
                oldStr: nudgeCtx.oldStr,
                isCodeFile: !!nudgeCtx.isCodeFile,
                symbols,
              });
            }

            // B33-followup — declarative gating pattern, same shape as
            // successNudge above: a tool opts in with features.structCheck:true
            // instead of the struct-check wiring being hardcoded into one
            // handler (previously only str_replace had it — B32 item #5).
            // Two independent gates, both deliberate (PJ's point in raising
            // this): (1) file-type — isStructFileType() skips non-code files
            // like .txt, where brace-balance has no meaning and could even
            // false-positive on stray '{' in prose; (2) tool-type — this is a
            // per-tool opt-in, not automatic for every registerMcpTool call,
            // since some edit shapes (e.g. a pure line-count-preserving
            // delete) may not need it. Needs ctx.snapshotOriginal() to have
            // been called before the write (same prerequisite decoration
            // already has) — silently skips if it wasn't, rather than forcing
            // every handler that wants structCheck to also want decoration.
            if (structSuffix === undefined && features.structCheck && editor &&
                ctx._originalText !== undefined && isStructFileType(_resolvedFilePath)) {
              try {
                const before = structSnapshot(ctx._originalText);
                const after  = structSnapshot(buffer.getText());
                structSuffix = structDelta(before, after);
              } catch (e) { structSuffix = ''; } // struct-check failing shouldn't block commit
            }

            // Decorate changed lines in the editor
            if (editor && ctx._originalText !== undefined) {
              decorateEditedLines(editor, ctx._originalText, buffer.getText());
            }

            // Save + report happen in ONE place: buildEditResponse (edit-response.js).
            // Previously this saved here AND buildEditResponse could also save —
            // two independent save call sites with two different (and inconsistent)
            // failure-handling behaviors. Passing `buffer` here makes commit's save
            // go through the same path as every other caller, so a failed save is
            // always surfaced the same way (⚠️ icon + message), never silently lost.
            if (onCommit && _resolvedFilePath) onCommit(_resolvedFilePath);

            // Focus the edited tab if it's open and the user has the toggle on
            if (editor && _resolvedFilePath) {
              const focusEnabled = atom.config.get('pulsar-edit-mcp-server.focusEditedFile') !== false;
              if (focusEnabled) {
                atom.workspace.open(_resolvedFilePath, { activateItem: true, searchAllPanes: true })
                  .catch(() => {}); // B14: fire-and-forget, ignore rejection if pane is closing
              }
            }

            bump(statsKey, 'hits');
            consec.count = 0;

            return {
              ...(await buildEditResponse({ ...resolvedMeta, buffer }, { lint: lintSuffix, style: styleSuffix, nudge: nudgeSuffix, struct: structSuffix })),
            };
          },

          // ctx.dryRunReturn(payload)
          // payload: the MCP return object (must have content[])
          dryRunReturn(payload) {
            bump(statsKey, 'dryRuns');
            return payload;
          },

          // Stash originalText before handler mutates the buffer.
          // Handlers should call ctx.snapshotOriginal() before any buffer write
          // so ctx.commit() can compute the decoration diff.
          snapshotOriginal() {
            ctx._originalText = buffer ? buffer.getText() : '';
          },
          _originalText: undefined,
        };

        // ── Invoke handler ──────────────────────────────────────────────────
        return await handler(args, ctx);
      }
    );
  }

  return registerMcpTool;
}

module.exports = { makeRegisterMcpTool };
