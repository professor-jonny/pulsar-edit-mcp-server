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
// Usage: await maybeLintSuffix(lint, editor, startRow, endRow)
//   startRow/endRow: 0-based row numbers, or null/null for a whole-file lint snapshot.
async function maybeLintSuffix(_lint, editor, startRow, endRow) {
  // Always-on: lint gate removed. startRow/endRow scope the region so only
  // messages introduced *in the edited area* are surfaced. Pass null/null for
  // whole-file ops. The _lint param is retained for API compatibility but ignored.
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

module.exports = { maybeLintSuffix, lintSnapshot };
