'use babel';
// ---------------------------------------------------------------------------
// lib/tool-framework.js  —  Tool Framework v1.0
// ---------------------------------------------------------------------------
// Provides registerMcpTool(): a thin wrapper around server.registerTool() that
// handles the repeated scaffold every edit/search tool needs:
//   • editor + buffer acquisition
//   • stats bump (hits / fails / dryRuns)
//   • consecutive-failure counter management
//   • smartSuggestion injection on repeated failures
//   • ctx.fail(reason, msg)        — bump fail, return error content
//   • ctx.commit(meta, warnings)   — bump hit, call buildEditResponse + decorateEditedLines
//   • ctx.dryRunReturn(payload)    — bump dryRun, return dry-run content
//
// Usage (in mcp-registration.js):
//
//   const { makeRegisterMcpTool } = require('./tool-framework');
//   const registerMcpTool = makeRegisterMcpTool(server, {
//     bump, buildEditResponse, decorateEditedLines, applyStyleCheck,
//     maybeLintSuffix, smartSuggestion,
//   });
//
//   registerMcpTool({
//     name:     'replace-all',
//     group:    'edit',
//     category: 'edit',           // 'edit' | 'search' | 'command' | 'nav'
//     features: { dryRun: true, lint: true, styleCheck: true },
//     title:    'Replace All',
//     description: '...',
//     inputSchema: { ... },       // Zod shape (passed straight through)
//     handler: async (args, ctx) => { ... }
//   });
//
// ctx object exposed to handlers:
//   ctx.editor         — active TextEditor (null if requiresEditor:false)
//   ctx.buffer         — editor.getBuffer()
//   ctx.allLines       — buffer.getLines() snapshot at call time
//   ctx.text           — buffer.getText() snapshot at call time
//   ctx.fail(reason, msg, extra?)
//       bump fail counter, optionally bump consec counter, return MCP content
//   ctx.commit(meta, warnings?)
//       buffer already written by handler; bump hit, decorate, buildEditResponse
//       meta: { tool, line?, linesChanged?, scopeLabel?, tags? }
//       warnings: { lint?, style? }
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
 *   maybeLintSuffix, smartSuggestion
 * @returns {function} registerMcpTool
 */
function makeRegisterMcpTool(server, deps) {
  const {
    bump,
    buildEditResponse,
    decorateEditedLines,
    applyStyleCheck,
    maybeLintSuffix,
    smartSuggestion,
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
    } = cfg;

    // Normalise tool name to stats key (replace-all → replace_all)
    const statsKey = name.replace(/-/g, '_');

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
        console.log(`CMD: ${name}, ARGS:`, args);

        // ── Editor acquisition ──────────────────────────────────────────────
        let editor = null, buffer = null, allLines = [], text = '';
        if (requiresEditor) {
          editor = atom.workspace.getActiveTextEditor();
          if (!editor) {
            return { content: [{ type: 'text', text: '❌ No active editor' }] };
          }
          buffer   = editor.getBuffer();
          allLines = buffer.getLines();
          text     = buffer.getText();
        }

        // ── ctx object ──────────────────────────────────────────────────────
        const ctx = {
          editor,
          buffer,
          allLines,
          text,
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

          // ctx.commit(meta, warnings?)
          // Call AFTER writing to the buffer.  Bumps hit, decorates, builds response.
          // meta: { tool?, line?, linesChanged?, scopeLabel?, tags? }
          // warnings: { lint?, style? }
          async commit(meta = {}, warnings = {}) {
            // Resolve lint/style if handler hasn't already
            const resolvedMeta = { tool: name, ...meta };
            let lintSuffix  = warnings.lint;
            let styleSuffix = warnings.style;

            if (styleSuffix === undefined && features.styleCheck && editor) {
              // Use current buffer state (post-write), not the pre-call snapshot
              styleSuffix = applyStyleCheck(buffer.getText(), editor.getPath());
            }
            if (lintSuffix === undefined && features.lint && editor) {
              lintSuffix = await maybeLintSuffix(args.lint || false, editor, null, null);
            }

            // Decorate changed lines in the editor
            if (editor && ctx._originalText !== undefined) {
              decorateEditedLines(editor, ctx._originalText, buffer.getText());
            }

            bump(statsKey, 'hits');
            consec.count = 0;

            return {
              ...buildEditResponse(resolvedMeta, { lint: lintSuffix, style: styleSuffix }),
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
