'use strict';

/**
 * read-response.js — Shared read/search response builder for
 * pulsar-edit-mcp-server (B28, read side).
 *
 * Deliberately separate from edit-response.js's buildEditResponse():
 * buildEditResponse() is genuinely edit-shaped (calls buffer.save(),
 * tracks _saveError, reports linesChanged/dryRun) — none of that applies
 * to a read-only tool with no buffer to write, and forcing reads through
 * it would mean passing dummy values for every edit-only field and
 * risking an accidental save if a `buffer` ever got passed by mistake.
 *
 * buildSearchResponse({ staleWarning, body })
 *   Prepends `staleWarning` (if non-empty) before `body`, same
 *   "warn before headline" ordering buildEditResponse() already uses on
 *   the edit side, then wraps the result in the required MCP envelope:
 *     { content: [{ type: 'text', text }] }
 *   `body` is whatever text the calling tool already built — often a
 *   JSON.stringify(...) blob (get-region, grep-file, etc.), sometimes
 *   plain text (file-line-count). buildSearchResponse doesn't care which;
 *   it never parses or reshapes `body`, only prefixes it.
 *
 * Deliberately minimal — no save, no icon, no line-delta logic. Mirrors
 * the read-only reality of these tools rather than importing edit
 * concepts that don't apply.
 */

/**
 * @param {object} opts
 *   staleWarning {string}  from readTextFromFile()'s `{ text, staleWarning }`
 *                          return shape ('' when the file is clean / this is
 *                          the first touch this session).
 *   body         {string}  the tool's already-assembled response text.
 * @returns {{ content: [{ type: string, text: string }] }}
 */
function buildSearchResponse({ staleWarning = '', body = '' } = {}) {
  const text = staleWarning ? `${staleWarning}\n${body}` : body;
  return { content: [{ type: 'text', text }] };
}

module.exports = { buildSearchResponse };
