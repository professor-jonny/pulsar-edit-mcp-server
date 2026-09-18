'use babel';

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
//     tools (str_replace, insert, replace-function-body, etc) should keep the
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
    if (!editor) return null;
    const targetPath = editor.getPath && editor.getPath();
    if (!targetPath) return null;

    const lb = atom.packages.getActivePackage("linter-bundle");
    if (!lb) return null;

    const lbTool = lb?.mainModule?.provideMcpTools?.()
      ?.find(t => t.name === "GetLinterMessages");
    if (!lbTool) return null;

    // B84 fix: force-lint and await completion before reading messages.
    // Without this, execute() below reads whatever's currently in
    // linter-bundle's registry — which, called synchronously right after a
    // buffer write, is almost always STALE (ESLint's own change debounce is
    // ~300ms, per editor-linter.js's DEBOUNCE_CHANGE_DEFAULT_MS). Forcing
    // editorLinter.lint(false) bypasses that debounce and emits "should-lint"
    // immediately; we then wait for linter-bundle's own registryLinters to
    // report the pass finished (bounded by a safety timeout so a hung or
    // missing linter can never stall an edit response).
    // LIMITATION: registryEditors only tracks editors with an open tab
    // (populated via atom.workspace.observeTextEditors). Files edited via
    // tool-framework's background bufferForPath path (no tab open) have no
    // EditorLinter to force — for those, this falls through to the old
    // (possibly stale) registry read, same as before this fix.
    const linterMain = lb?.mainModule;
    const editorLinter = linterMain?.registryEditors?.get?.(editor);
    if (editorLinter && linterMain.registryLinters?.onDidUpdateMessages) {
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          disposable.dispose();
          clearTimeout(timer);
          resolve();
        };
        const disposable = linterMain.registryLinters.onDidUpdateMessages(done);
        const timer = setTimeout(done, 1000); // safety net — never hang an edit response
        try {
          editorLinter.lint(false);
        } catch (_) {
          done(); // if forcing the lint call itself throws, fall back to whatever's in the registry
        }
      });
    }

    const lbResult = lbTool.execute({ filePath: targetPath });

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

    // B84: countOnly mode — used by whole-file/large-block tools (create-file,
    // etc) so a freshly written 1000-line file doesn't dump every message's
    // full text into the response. Just the count + a pointer to the real
    // detail via get-diagnostics.
    if (opts.countOnly) {
      return `⚠️ lint (${msgs.length} issue${msgs.length === 1 ? "" : "s"}) — call get-diagnostics on this file to review.`;
    }

    const parts = msgs.map(m => {
      const lineNo = (m.range?.start?.row ?? m.range?.start?.line ?? 0) + 1;
      return `[L${lineNo}] ${m.severity} — ${m.excerpt}`;
    });
    return `⚠️ lint (${msgs.length}): ${parts.join(" | ")}`;
  } catch (_) {
    return null;
  }
}

module.exports = { maybeLintSuffix, lintSnapshot };
