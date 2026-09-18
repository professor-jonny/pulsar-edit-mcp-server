/**
 * edit-response.js — Shared edit response builder for pulsar-edit-mcp-server.
 *
 * buildEditResponse(meta, warnings)
 *   Returns the MCP protocol envelope: { content: [{ type: 'text', text }] }
 *   All edit tools call this at the commit point instead of assembling strings
 *   themselves.  When no warnings are present the output is a single clean line:
 *     ✅ str_replace — line 42, +3 lines [fuzzyWhitespace]
 *   Warnings are appended only when non-empty (silent-when-clean).
 *
 * preEditSnapshot(editor)
 *   Captures linter message digest and structural counts before a buffer write.
 *   Reserved for struct-check wiring (Tier 1) — no-op stub for now.
 *
 * postEditDelta(pre, editor)
 *   Compares a pre-edit snapshot against the current buffer state and returns
 *   new-since-edit warnings.  No-op stub for now.
 *
 * Do NOT change the outer { content: [{ type: 'text', text }] } shape here —
 * that is protocol-level and must stay consistent with the MCP spec.
 */

'use strict';

const { snapshot: structSnapshot, delta: structDelta } = require('./struct-check');
const { checkStale, recordKnownMtime } = require('./buffer-helpers');


// ─── buildEditResponse ────────────────────────────────────────────────────────

/**
 * @param {object} meta
 *   tool        {string}   'str_replace' | 'replace-function-body' | 'insert' | …
 *   line        {number}   1-based line where the edit landed (null for whole-file ops)
 *   linesChanged {number}  net line delta (+N inserted / -N deleted / 0)
 *   scopeLabel  {string}   e.g. ' within function "foo"'  ('' when not scoped)
 *   tags        {string[]} ['fuzzyWhitespace', 'regex', …]
 *   dryRun      {boolean}  true → prefix ✅ with 🔍, no commit
 *   buffer      {object}   [B26] Pulsar TextBuffer (ctx.buffer, NOT ctx.editor —
 *                          editor is null for files edited via bufferForPath when
 *                          the file isn't open in a tab, but buffer is always set
 *                          in both cases) whose contents should be saved to disk.
 *                          Omit when the caller already saved (e.g. ctx.commit()
 *                          in tool-framework.js, which saves at L218 before calling
 *                          buildEditResponse). Pass it from any handler that calls
 *                          buildEditResponse() directly so the edit actually
 *                          persists to disk instead of only updating the in-memory
 *                          buffer. dryRun:true skips the save even if buffer is set.
 *
 * @param {object} [warnings]  — all keys optional; omit or pass {} for a clean commit
 *   lint    {string}   new linter messages since preEditSnapshot ('' when clean)
 *   style   {string}   applyStyleCheck output ('' when clean)
 *   struct  {string}   structuralIntegrityCheck delta ('' when clean) [future]
 *   nudge   {string}   successNudge text ('' when suppressed)
 *
 * @returns {Promise<{ content: [{ type: string, text: string }] }>}
 *   [B26] Now async — callers must `await buildEditResponse(...)`.
 */
async function buildEditResponse(meta, warnings) {
  const {
    tool         = 'edit',
    line         = null,
    linesChanged = null,
    scopeLabel   = '',
    tags         = [],
    dryRun       = false,
    buffer       = null,
  } = meta || {};

  // [B26] Auto-save — direct buildEditResponse() callers (everything outside
  // ctx.commit()) previously returned success while leaving the buffer
  // unsaved on disk. ctx.commit() already saves before calling us (see
  // tool-framework.js ~L218) and does not pass buffer, so this is skipped
  // there — avoids a redundant double-save, not a missing one.
  //
  // [B27] Save failures are now surfaced, not swallowed. A silent catch here
  // previously let the handler report "\u2705 committed" while the edit only
  // existed in memory — proven to happen in practice (mcp-registration.js
  // decoration-guard fix, 2026-07-16: the save never completed because an
  // earlier line threw before this ran; the swallowed catch would have hidden
  // that even if this code HAD been reached). The edit itself is still
  // correct in the buffer either way, so this doesn't change what the user
  // can do about it (undo/redo, checkpoints, retry — all fine) — it just
  // stops the response from claiming disk state that isn't true.
  let _saveError = null;
  // Check disk staleness BEFORE our own save — otherwise we'd be comparing
  // against the write we're about to make and would never see real external
  // drift. auto-detected here rather than requiring every call site to pass
  // its own `stale` warning — this is what the previously-unused `stale`
  // slot below was reserved for.
  const _filePath = buffer && typeof buffer.getPath === 'function' ? buffer.getPath() : null;
  const _autoStale = checkStale(_filePath);
  if (buffer && !dryRun) {
    try {
      if (typeof buffer.save === 'function') await buffer.save();
      // Re-seed the known mtime to our own just-made write, so the NEXT call
      // doesn't see this save as "external" drift.
      recordKnownMtime(_filePath);
    } catch (e) {
      _saveError = e && e.message ? e.message : String(e);
    }
  }

  const {
    lint   = '',
    style  = '',
    struct = '',
    nudge  = '',
    stale  = _autoStale,  // caller can override; defaults to the automatic disk-drift check above
  } = warnings || {};

  // ── headline ─────────────────────────────────────────────────────────────
  // A save failure downgrades the icon from ✅ to ⚠️ — the edit is correct in
  // the in-memory buffer (undo/redo, checkpoints, and re-reads of it all see
  // the new content) but disk does NOT have it yet. Never report ✅ when that's
  // not true — the caller needs to know to retry save-file or open+save the
  // file explicitly rather than assume the job is done.
  const icon   = _saveError ? '⚠️' : (dryRun ? '🔍' : '✅');
  const where  = line !== null ? ` — line ${line}` : '';
  const delta  = linesChanged !== null && linesChanged !== 0
    ? `, ${linesChanged > 0 ? '+' : ''}${linesChanged} line${Math.abs(linesChanged) === 1 ? '' : 's'}`
    : '';
  const scope  = scopeLabel || '';
  const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';

  let text = `${icon} ${tool}${where}${delta}${scope}${tagStr}`;
  if (_saveError) {
    text += `\n⚠️ SAVE FAILED — edit applied in memory but NOT written to disk: ${_saveError}. Open the file in a tab and call save-file to persist it, then verify with get-active-editor-info (modified:false).`;
  }
  if (stale)  text = stale + '\n' + text; // stale warning before headline

  // ── warnings (silent when empty) ─────────────────────────────────────────
  if (nudge)   text += nudge;           // nudge already includes leading \n
  if (lint)    text += lint;            // maybeLintSuffix already includes leading \n
  if (style)   text += style;           // applyStyleCheck already includes leading \n
  if (struct)  text += struct;          // future struct-check delta

  return { content: [{ type: 'text', text }] };
}

// ─── preEditSnapshot ──────────────────────────────────────────────────────────

/**
 * Capture a pre-edit baseline for delta comparison.
 * Stub — returns an empty snapshot object.  Will be populated when
 * lib/struct-check.js is implemented (Tier 1 structural checks).
 *
 * @param  {object} _editor  Pulsar TextEditor (unused in stub)
 * @returns {object}         Opaque snapshot passed to postEditDelta()
 */
function preEditSnapshot(editor) {
  try {
    const filePath = editor && typeof editor.getPath === 'function' ? editor.getPath() : null;
    const STRUCT_EXTENSIONS = /\.(c|h|cpp|hpp|cc|cxx|js|ts|jsx|tsx|css|scss|java|cs|go|rs|swift)$/i;
    if (!filePath || !STRUCT_EXTENSIONS.test(filePath)) return { struct: null };
    const text = typeof editor.getText === 'function' ? editor.getText() : '';
    return { struct: structSnapshot(text) };
  } catch (_) {
    return { struct: null };
  }
}

// ─── postEditDelta ────────────────────────────────────────────────────────────

/**
 * Compare pre-edit snapshot against current editor state and return
 * new-since-edit warning strings.
 * Stub — returns empty strings.  Will be populated by struct-check wiring.
 *
 * @param  {object} _pre     Snapshot from preEditSnapshot()
 * @param  {object} _editor  Pulsar TextEditor (unused in stub)
 * @returns {{ lint: string, struct: string }}
 */
function postEditDelta(pre, editor) {
  try {
    if (!pre || pre.struct === null) return { struct: '' };
    const text  = editor && typeof editor.getText === 'function' ? editor.getText() : '';
    const after = structSnapshot(text);
    const before = pre.struct ? pre.struct : structSnapshot('');
    return { struct: structDelta(before, after) };
  } catch (_) {
    return { struct: '' };
  }
}

// ─── exports ─────────────────────────────────────────────────────────────────

module.exports = { buildEditResponse, preEditSnapshot, postEditDelta };
