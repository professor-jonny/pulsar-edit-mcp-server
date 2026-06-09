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


// ─── buildEditResponse ────────────────────────────────────────────────────────

/**
 * @param {object} meta
 *   tool        {string}   'str_replace' | 'replace-function-body' | 'insert' | …
 *   line        {number}   1-based line where the edit landed (null for whole-file ops)
 *   linesChanged {number}  net line delta (+N inserted / -N deleted / 0)
 *   scopeLabel  {string}   e.g. ' within function "foo"'  ('' when not scoped)
 *   tags        {string[]} ['fuzzyWhitespace', 'regex', …]
 *   dryRun      {boolean}  true → prefix ✅ with 🔍, no commit
 *
 * @param {object} [warnings]  — all keys optional; omit or pass {} for a clean commit
 *   lint    {string}   new linter messages since preEditSnapshot ('' when clean)
 *   style   {string}   applyStyleCheck output ('' when clean)
 *   struct  {string}   structuralIntegrityCheck delta ('' when clean) [future]
 *   nudge   {string}   successNudge text ('' when suppressed)
 *
 * @returns {{ content: [{ type: string, text: string }] }}
 */
function buildEditResponse(meta, warnings) {
  const {
    tool         = 'edit',
    line         = null,
    linesChanged = null,
    scopeLabel   = '',
    tags         = [],
    dryRun       = false,
  } = meta || {};

  const {
    lint   = '',
    style  = '',
    struct = '',
    nudge  = '',
  } = warnings || {};

  // ── headline ─────────────────────────────────────────────────────────────
  const icon   = dryRun ? '🔍' : '✅';
  const where  = line !== null ? ` — line ${line}` : '';
  const delta  = linesChanged !== null && linesChanged !== 0
    ? `, ${linesChanged > 0 ? '+' : ''}${linesChanged} line${Math.abs(linesChanged) === 1 ? '' : 's'}`
    : '';
  const scope  = scopeLabel || '';
  const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';

  let text = `${icon} ${tool}${where}${delta}${scope}${tagStr}`;

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
