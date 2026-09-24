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
// features.resendlessCommit:true (new) — a tool opts in to let its dryRun
// preview be committed without resending its full args. Purely a framework-
// level wrapper around whatever the handler already returns; the handler
// itself needs NO changes beyond declaring the feature. Mechanism: when a
// resendlessCommit tool's handler returns an object with dryRun:true, the
// framework stashes {args, filePath} keyed by tool name. If the VERY NEXT
// call to that same tool name passes only {commitLastPreview:true} (no other
// args beyond filePath), the framework splices the stashed args back in
// (forcing dryRun:false) before invoking the handler — so the caller never
// has to retype/resend the patch/content/params it already sent for the
// preview. commitLastPreview:true with nothing pending (no prior dryRun:true
// call for that tool, or it already got committed/invalidated) returns a
// friendly error asking the caller to resend full arguments — it does NOT
// silently no-op or fall through to a confusing "missing required field"
// error from the handler's own schema validation.
// The stash is one-shot: cleared after a successful commitLastPreview, after
// any non-commit call to that tool (args changed — assume the caller moved
// on), or after any OTHER edit tool commits to the same filePath (staleness
// guard — the previewed state may no longer be accurate). See insert's
// registration for the first tool to use this (proving ground, per
// mcp-server-refactor-plan.md's insert-first sequencing).
//
// features.retryOnFail:{ field: 'old_str' } (new) — a tool opts in to let a
// FAILED call (noMatch/ambiguous/outOfScope/etc — anything the match-engine
// reports via matched:false) be retried by sending ONLY the corrected field
// plus filePath, instead of resending the whole call. Distinct from
// resendlessCommit: that one is for a SUCCESSFUL dryRun preview being
// committed as-is; this one is for a FAILED real attempt being corrected on
// one specific field. Mechanism: when a retryOnFail tool's handler returns
// matched:false (the existing convention buildFailResponse() already uses
// across str_replace/insert/delete/replace-block/replace-function-body — no
// new signal needed), the framework stashes that call's full args. If the
// NEXT call to that same tool is exactly { filePath, <field>: '<value>' }
// (no other meaningful args, where <field> is whatever this tool's
// features.retryOnFail.field names — e.g. 'old_str' for str_replace), the
// framework merges just that one field into the stashed args and re-invokes
// the handler with the merged, complete call. The failure response text
// itself is expected to nudge the caller toward this — "read the current
// content, then retry with just { filePath, old_str: '...' }" — since an
// unadvertised capability doesn't get used (confirmed empirically:
// resendlessCommit's dryRun-then-commit flow saw ~0 real dryRun usage across
// the whole edit-tool lifetime stats before this was ever built, because the
// two-call dryRun workflow itself was already barely used — retryOnFail
// targets FAILURES instead, which do have real, heavy lifetime volume:
// str_replace alone has 282 lifetime fails vs 0 dryRuns). Same one-shot /
// staleness-guard shape as resendlessCommit, sharing the same underlying
// pendingCommits-style store design (see the retryPending store below).
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

// ---------------------------------------------------------------------------
// _samePath(a, b) -- do two caller/stash file paths name the same file?
//
// Used by the resendlessCommit splice and the retryOnFail merge to decide
// whether a stashed call belongs to the file the caller is now naming.
//
// Why not a bare path.resolve() compare: the stash holds the RESOLVED ABSOLUTE
// path (_resolvedFilePath), but the caller passes a PROJECT-RELATIVE path
// (relative is the intended form for every tool). path.resolve() resolves a
// relative path against process.cwd(), which is NOT the Pulsar project root,
// so the same file compared unequal and the retry/commit was wrongly refused
// ("Pending preview ... was for a different file" naming the very same file).
// Found live 2026-09-19; see mcp-server-refactor-plan.md finding 7.
//
// Both sides go through resolveProjectPath() first (project-root-aware,
// handles root:<name>/<rest>), then path.resolve() for normalisation.
//
// Returns true (same), false (definitely different), or null when a side
// cannot be resolved (e.g. an unknown root: prefix throws). Callers treat
// null as "cannot prove different" -- the safe direction for a stash lookup is
// to fall through to a normal call, never to splice into the wrong file.
// ---------------------------------------------------------------------------
function _samePath(a, b) {
  const path = require('path');
  const { resolveProjectPath } = require('./buffer-helpers');
  try {
    return path.resolve(resolveProjectPath(a)) === path.resolve(resolveProjectPath(b));
  } catch (_e) {
    return null;
  }
}

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

  // features.resendlessCommit pending-preview store. Key: tool name.
  // Value: { args, filePath, timestamp }. One entry per tool name at a time
  // (not per-file) — a second dry-run call to the same tool before a commit
  // simply overwrites the pending entry, same "latest wins" behavior
  // patchRescueStore already has for apply-patch's own narrower version of
  // this idea. See module header for the full mechanism description.
  const pendingCommits = {};

  // features.retryOnFail pending-failure store. Same shape and lifecycle as
  // pendingCommits, kept as a separate object rather than reusing
  // pendingCommits itself — a tool could in principle have BOTH a pending
  // successful preview (resendlessCommit) and a pending failed attempt
  // (retryOnFail) at the same time (e.g. dryRun succeeded, caller committed,
  // then immediately tried a second, different edit that failed) — sharing
  // one store would conflate the two. Key: tool name. Value:
  // { args, filePath, timestamp }.
  const retryPending = {};

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

        // ── features.resendlessCommit: splice in a pending preview ──────────
        // If this tool opts in and the caller sent ONLY {commitLastPreview:true}
        // (plus optionally the same filePath, for callers that like to be
        // explicit), replace args with whatever was stashed from that tool's
        // last dryRun:true response, forcing dryRun:false. Any other args
        // present alongside commitLastPreview:true are treated as "caller is
        // sending a fresh, different call" — commitLastPreview is ignored and
        // the stash is left alone, since this isn't the narrow resend-nothing
        // shape the feature exists for.
        if (features.resendlessCommit && args && args.commitLastPreview === true) {
          const path = require('path');
          // A required-string param the caller's tool-calling layer coerces to
          // "" when omitted (e.g. insert's new_str) must not count as a "real"
          // arg here, or a bare {filePath, commitLastPreview:true} call would
          // never match this narrow shape. Treat undefined/null/""/false as
          // "not really provided" for this check — a caller sending a genuine
          // non-empty value alongside commitLastPreview:true is a real,
          // different call and should fall through normally instead of being
          // spliced.
          const _otherKeys = Object.keys(args).filter(k => {
            if (k === 'commitLastPreview' || k === 'filePath') return false;
            const v = args[k];
            return !(v === undefined || v === null || v === '' || v === false);
          });
          if (_otherKeys.length === 0) {
            const _pending = pendingCommits[name];
            if (!_pending) {
              return { content: [{ type: 'text', text: `❌ No pending preview to commit for ${name} — nothing was previewed yet (or it already committed / was invalidated by another edit). Call it again with your full arguments; it will preview first.` }] };
            }
            if (args.filePath && _pending.filePath && _samePath(args.filePath, _pending.filePath) !== true) {
              return { content: [{ type: 'text', text: `❌ Pending preview for ${name} was for a different file (${_pending.filePath}) — call it again with your full arguments for ${args.filePath}.` }] };
            }
            args = { ..._pending.args, dryRun: false };
            delete pendingCommits[name]; // one-shot — cleared whether the commit succeeds or fails below
          }
        }

        // ── features.retryOnFail: merge a corrected field into a failed call ──
        // If this tool opts in (features.retryOnFail = {field: 'old_str'} etc)
        // and the caller sent EXACTLY {filePath, <field>: '<value>'} — that one
        // named field plus filePath, and nothing else meaningful — merge that
        // single corrected value into the stashed args from this tool's last
        // matched:false failure and retry the full call. Any other args shape
        // (missing the field, extra fields present, or the field's value
        // "empty" by the same undefined/null/''/false convention used for
        // resendlessCommit above) is treated as a fresh, different call —
        // falls through normally, stash left untouched.
        if (features.retryOnFail && features.retryOnFail.field && args) {
          const _field = features.retryOnFail.field;
          const path = require('path');
          const _otherKeys = Object.keys(args).filter(k => {
            if (k === 'filePath') return false;
            const v = args[k];
            return !(v === undefined || v === null || v === '' || v === false);
          });
          if (_otherKeys.length === 1 && _otherKeys[0] === _field) {
            const _pending = retryPending[name];
            if (_pending) {
              // Only merge if the filePath matches (or the caller omitted it —
              // treated as "same file" for convenience, same as resendlessCommit).
              const _sameFile = !args.filePath || !_pending.filePath ||
                _samePath(args.filePath, _pending.filePath) === true;
              if (_sameFile) {
                args = { ..._pending.args, [_field]: args[_field] };
                delete retryPending[name]; // one-shot
              }
              // If filePath genuinely differs, fall through to a normal call
              // with just {filePath, field} — will almost certainly fail its
              // own schema validation (missing other required fields) and
              // surface a clear error rather than silently retrying against
              // the wrong file's stashed state.
            }
            // No pending failure: fall through normally too — same reasoning,
            // a normal call with just {filePath, field} will fail schema
            // validation with a clear "other fields required" error rather
            // than a bespoke retryOnFail-specific message. Unlike
            // resendlessCommit's commitLastPreview, this shape ({filePath,
            // old_str}) is ambiguous with a plain (if incomplete) real call,
            // so a custom error here would be guessing at intent.
          }
        }

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
        const _result = await handler(args, ctx);

        // ── features.resendlessCommit: stash a fresh preview ────────────────
        // Detect via the same dryRun:true convention every dryRun-capable
        // tool already returns (see mcp-registration.js — consistent across
        // all of them). Only stash real previews, not commit-splice replays
        // (those already forced dryRun:false above, so this naturally can't
        // double-stash a commit response).
        if (features.resendlessCommit && _result && _result.dryRun === true) {
          pendingCommits[name] = { args, filePath: _resolvedFilePath, timestamp: Date.now() };
        } else if (features.resendlessCommit && _result && _result.dryRun === false) {
          // A real commit (whether via normal dryRun:false or via the splice
          // above) — nothing pending should survive it regardless of which
          // path produced it. Already deleted above for the splice case;
          // this covers the "caller passed dryRun:false directly" case too.
          delete pendingCommits[name];
        }

        // ── features.retryOnFail: stash a fresh failure ──────────────────────
        // Detect via matched:false — the existing convention buildFailResponse()
        // in match-engine.js already returns across every tool that uses it
        // (str_replace, insert, delete, replace-block, replace-function-body —
        // confirmed via grep). No handler changes needed to produce this
        // signal, same as dryRun:true already being relied on for
        // resendlessCommit. A successful match (matched:true, or no matched
        // key at all for tools that don't use buildFailResponse) clears any
        // stale pending failure for this tool — the caller moved past it.
        if (features.retryOnFail && _result && _result.matched === false) {
          retryPending[name] = { args, filePath: _resolvedFilePath, timestamp: Date.now() };
        } else if (features.retryOnFail && _result && _result.matched === true) {
          delete retryPending[name];
        }

        // ── resendlessCommit/retryOnFail staleness guard (universal, ANY tool) ──
        // This must NOT be gated on this tool's own features.resendlessCommit/
        // retryOnFail — a plain str_replace/delete/etc with no resendless
        // support of its own still needs to invalidate some OTHER tool's
        // pending preview OR pending failed-attempt for the same file. ctx.commit() has its own narrower version of this
        // sweep, but several tools (str_replace among them) build their return
        // value directly via buildEditResponse() and return it from the
        // handler without ever calling ctx.commit() at all — confirmed via
        // grep that str_replace is not among ctx.commit()'s callers — so a
        // sweep placed only inside ctx.commit() misses every one of those
        // tools' commits. This one runs for every tool's result regardless of
        // which internal path produced it, using the same dryRun:false
        // convention already relied on above. A tool with no filePath (e.g.
        // active-editor-only calls) or a result that never reached a real
        // write (dryRun undefined/true, or a failure response) does nothing
        // here — only an explicit dryRun:false marks a real commit.
        if (_result && _result.dryRun === false && _resolvedFilePath) {
          const path = require('path');
          const _rp = path.resolve(_resolvedFilePath);
          for (const _k of Object.keys(pendingCommits)) {
            if (_k === name) continue; // this tool's own entry is handled above already
            if (pendingCommits[_k].filePath && path.resolve(pendingCommits[_k].filePath) === _rp) {
              delete pendingCommits[_k];
            }
          }
          for (const _k of Object.keys(retryPending)) {
            if (retryPending[_k].filePath && path.resolve(retryPending[_k].filePath) === _rp) {
              delete retryPending[_k];
            }
          }
        }

        return _result;
      }
    );
  }

  return registerMcpTool;
}

module.exports = { makeRegisterMcpTool };
