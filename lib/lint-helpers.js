'use babel';

// ---------------------------------------------------------------------------
// No-tab linting (linter-bundle issue #3).
// Edit tools on a file with no open tab work on a bare TextBuffer from
// atom.project.bufferForPath() and ctx.editor is null, but linters need a
// TextEditor. tool-framework runs every handler inside runWithLintTarget() so
// lintSnapshot() can find the CURRENT call's buffer (AsyncLocalStorage keeps
// parallel tool calls from seeing each other's file). For a null editor we lint
// through a hidden TextEditor built on that same buffer, cached per buffer.
// The hidden editor is deliberately NEVER destroyed by us: destroying the last
// holder of a project buffer has crashed the renderer before (see B68/B69 in
// buffer-helpers.js). It lives and dies with its buffer.
// ---------------------------------------------------------------------------
const { AsyncLocalStorage } = require('async_hooks');
const _lintTargetStore = new AsyncLocalStorage();
const _hiddenLintEditors = new WeakMap(); // TextBuffer -> TextEditor

function runWithLintTarget(target, fn) {
  return _lintTargetStore.run(target, fn);
}

// The current tool call's buffer, if it is a real, live, file-backed TextBuffer
// (read tools get a plain shim, which does not qualify).
function _liveBufferFromContext() {
  const st = _lintTargetStore.getStore();
  const buffer = st && st.buffer;
  if (!buffer || typeof buffer.onDidDestroy !== 'function') return null;
  if (typeof buffer.isDestroyed === 'function' && buffer.isDestroyed()) return null;
  if (!buffer.getPath || !buffer.getPath()) return null;
  return buffer;
}

// Fallback for a linter-bundle without lintBuffer(): our own hidden editor.
function _hiddenLintEditorFor(buffer) {
  let ed = _hiddenLintEditors.get(buffer);
  if (!ed || (typeof ed.isDestroyed === 'function' && ed.isDestroyed())) {
    ed = atom.workspace.buildTextEditor({ buffer });
    _hiddenLintEditors.set(buffer, ed);
  }
  return ed;
}

// ---------------------------------------------------------------------------
// lintSnapshot(editor, startRow, endRow) -- always-on post-edit lint helper.
// Returns a compact lint string scoped to [startRow, endRow] (0-based inclusive),
// or null if linter-bundle is inactive, no messages in range, or any error.
// Scope logic:
//   1. If startRow/endRow provided, filter to that row range.
//   2. Messages: errors + warnings only (info too noisy).
//   3. Silent when clean (no output = no noise on good edits).
// ---------------------------------------------------------------------------
// Convenience wrapper — replaces the repeated inline IIFE pattern:
//   lint ? await (async () => { const snap = await lintSnapshot(...); return snap ? `\n${snap}` : ""; })() : ""
// Usage: await maybeLintSuffix(lint, editor, startRow, endRow, opts)
//   startRow/endRow: 0-based row numbers, or null/null for a whole-file lint snapshot.
//   opts.countOnly: true — B84: for whole-file/large-block tools (create-file,
//     replace-document, etc) where returning every message's text would dump a
//     huge, noisy wall of text for something like a freshly-created 1000-line
//     file. Returns just "⚠️ lint (N issue(s)) — call get-diagnostics on this
//     file to review." instead of the full per-message breakdown. Small-edit
//     tools (replace, insert, replace-function-body, etc) should keep the
//     default (full detail) — the scoped region is already small, so the full
//     breakdown is cheap and actually useful inline.
async function maybeLintSuffix(_lint, editor, startRow, endRow, opts) {
  // Always-on: lint gate removed. startRow/endRow scope the region so only
  // messages introduced *in the edited area* are surfaced. Pass null/null for
  // whole-file ops. The _lint param is retained for API compatibility but ignored.
  const snap = await lintSnapshot(editor, startRow, endRow, opts);
  return snap ? `\n${snap}` : "";
}

async function lintSnapshot(editor, startRow, endRow, opts = {}) {
  // Returns a compact lint string scoped to [startRow, endRow] (0-based inclusive),
  // or null if linter-bundle inactive, no messages, or any error.
  // Rows use linter-bundle's native "row" field (0-based). If absent, falls back to
  // "line" field (also 0-based in raw execute() output). Scope is padded by 5 lines
  // to account for GCC reporting errors slightly outside the edited range.
  try {
    // B35, superseded 2026-07-19: linter-bundle 2.6.0 added optional
    // filePath/severity/linterName filters to GetLinterMessages.execute()
    // (https://github.com/asiloisad/pulsar-linter-bundle/commit/956207e,
    // path-matching fixed in /commit/472e749). When filePath is supplied,
    // execute() scopes messages from its own full registry directly —
    // independent of UI focus or the panel's viewMode — including files
    // that were never opened in a tab at all. This replaces the previous
    // workaround (force viewMode:"project", pull every open file's
    // messages, filter client-side by resolved path) with exactly the
    // upstream fix the bug report asked for: no more viewMode toggling,
    // no more manual path normalization racing the package's own platform
    // rules (Windows case/separator-insensitive, POSIX exact — see
    // normalizePath() in linter-bundle's lib/main.js).
    // No open tab (ctx.editor is null): lint the current call's buffer instead.
    // Null when there is no live buffer context.
    let ctxBuffer = null;
    if (!editor) {
      ctxBuffer = _liveBufferFromContext();
      if (!ctxBuffer) return null;
    }
    const targetPath = editor ? (editor.getPath && editor.getPath()) : ctxBuffer.getPath();
    if (!targetPath) return null;

    const lb = atom.packages.getActivePackage("linter-bundle");
    if (!lb) return null;

    const lbTool = lb?.mainModule?.provideMcpTools?.()
      ?.find(t => t.name === "GetLinterMessages");
    if (!lbTool) return null;

    // B84 fix: force a lint pass and wait for it before reading messages.
    // linter-bundle keeps its registries module-private (mainModule does not
    // expose them), so use its exported lintEditor(editor) or, for a buffer with
    // no open tab, lintBuffer(buffer): both await every provider, then flush the
    // message registry's 100ms debounce. Without this the read below returns the
    // PREVIOUS pass's results, because the change-driven pass is debounced and
    // not awaitable.
    // The timeout is a safety net: a hung linter must never stall an edit.
    // A linter-bundle without lintBuffer (issue #3) gets our own hidden editor.
    const lintEditor = lb?.mainModule?.lintEditor;
    const lintBuffer = lb?.mainModule?.lintBuffer;
    let lintRun = null;
    if (editor && typeof lintEditor === 'function') {
      lintRun = lintEditor(editor);
    } else if (ctxBuffer && typeof lintBuffer === 'function') {
      lintRun = lintBuffer(ctxBuffer);
    } else if (ctxBuffer && typeof lintEditor === 'function') {
      lintRun = lintEditor(_hiddenLintEditorFor(ctxBuffer));
    }
    if (lintRun) {
      let timer;
      let timedOut = false;
      try {
        await Promise.race([
          Promise.resolve(lintRun).catch(() => {}),
          new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(); }, 3000); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      // A pass that outlives the timeout has not delivered this edit's results,
      // so whatever the registry holds belongs to an earlier pass. Say so rather
      // than present it as this edit's lint state.
      if (timedOut) {
        return "lint (pending): still running after 3s, results not yet current - call get-diagnostics on this file shortly.";
      }
    }


    const lbResult = lbTool.execute({ filePath: targetPath });

    const allMsgs = lbResult.messages || [];
    const msgs = filterLintMessages(allMsgs, startRow, endRow, opts);
    if (msgs.length === 0) return null;

    // B84: countOnly mode — used by whole-file/large-block tools (create-file,
    // etc) so a freshly written 1000-line file doesn't dump every message's
    // full text into the response. Just the count + a pointer to the real
    // detail via get-diagnostics.
    if (opts.countOnly) {
      return `⚠️ lint (${lintCountLabel(msgs)}) — call get-diagnostics on this file to review.`;
    }

    return formatLintDetail(msgs);
  } catch (_) {
    return null;
  }
}

// 2026-11-19 (XW23): the per-message detail is capped so one edit cannot return a wall of lint. At most maxMessages messages
// (errors first, then in the order given), each excerpt collapsed to one line and cut at maxExcerpt characters; the headline keeps
// the true total and a tail says how many were left out and where to see them.
const LINT_MAX_MESSAGES = 5;
const LINT_MAX_EXCERPT = 140;
// "2 errors, 10 warnings" (zero counts left out). The headline of both the detail and the count-only line.
function lintCountLabel(msgs) {
  const e = msgs.filter(m => m.severity === 'error').length;
  const w = msgs.length - e;
  const out = [];
  if (e) out.push(e + ' error' + (e === 1 ? '' : 's'));
  if (w) out.push(w + ' warning' + (w === 1 ? '' : 's'));
  return out.join(', ');
}
function formatLintDetail(msgs, opts = {}) {
  const max = opts.maxMessages != null ? opts.maxMessages : LINT_MAX_MESSAGES;
  const maxEx = opts.maxExcerpt != null ? opts.maxExcerpt : LINT_MAX_EXCERPT;
  const ordered = msgs.map((m, i) => ({ m, i }))
    .sort((a, b) => ((a.m.severity === 'error' ? 0 : 1) - (b.m.severity === 'error' ? 0 : 1)) || (a.i - b.i))
    .map(x => x.m);
  const shown = ordered.slice(0, max);
  const parts = shown.map(m => {
    const lineNo = (m.range?.start?.row ?? m.range?.start?.line ?? 0) + 1;
    let ex = String(m.excerpt == null ? '' : m.excerpt).replace(/\s+/g, ' ').trim();
    if (ex.length > maxEx) ex = ex.slice(0, Math.max(1, maxEx - 1)) + '\u2026';
    return `[L${lineNo}] ${m.severity} \u2014 ${ex}`;
  });
  const more = msgs.length - shown.length;
  const tail = more > 0 ? ` | \u2026 +${more} more: call get-diagnostics on this file for all` : '';
  return `\u26A0\uFE0F lint (${lintCountLabel(msgs)}): ${parts.join(' | ')}${tail}`;
}

// XW23 (2026-11-18): the pure scope filter behind lintSnapshot (errors and warnings only).
//   startRow/endRow: keep messages within 5 rows of that range (the old behaviour; null = whole file).
//   opts.rows: 0-based list of CHANGED rows (sed, replace-all, apply-patch know them): keep only messages within
//     opts.pad (default 0) of one of those rows, so warnings elsewhere in a big file are not dumped into the result.
//   Messages without a range are file-level and always kept.
function filterLintMessages(allMsgs, startRow, endRow, opts = {}) {
  const sev = (allMsgs || []).filter(m => m.severity === "error" || m.severity === "warning");
  const rowOf = (m) => m.range.start?.row ?? m.range.start?.line ?? 0;
  if (Array.isArray(opts.rows)) {
    const pad = opts.pad != null ? opts.pad : 0;
    return sev.filter(m => m.range == null || opts.rows.some(r => Math.abs(rowOf(m) - r) <= pad));
  }
  const scopeStart = startRow != null ? Math.max(0, startRow - 5) : null;
  const scopeEnd   = endRow   != null ? endRow + 5 : null;
  return sev.filter(m => {
    if (scopeStart == null) return true;
    if (m.range == null) return true; // file-level error, always include
    const row = rowOf(m);
    return row >= scopeStart && row <= scopeEnd;
  });
}

module.exports = { maybeLintSuffix, lintSnapshot, runWithLintTarget, filterLintMessages, formatLintDetail, lintCountLabel, LINT_MAX_MESSAGES, LINT_MAX_EXCERPT };
