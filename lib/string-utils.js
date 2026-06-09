'use strict';

// ---------------------------------------------------------------------------
// lib/string-utils.js — Pure string / regex / glob utilities
//
// Extracted from mcp-registration.js so they are independently require()-able
// (no Pulsar dependency) and unit-testable via the Tier-2 test harness.
//
// Consumers in mcp-registration.js destructure this module:
//   const { escapeRegex, applyReplacement, expandBraces, globToRegex } =
//       require('./string-utils');
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helper: escape a plain string for use inside a RegExp
// ---------------------------------------------------------------------------
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Helper: apply a replacement string with $1/$2/$&/$`/$' interpolation.
// Mirrors String.prototype.replace(regex, replacementString) semantics so
// callbacks in replace-all, replace-across-files, and sed can count matches
// while still honouring capture-group backreferences -- exactly what VS Code
// and every LLM is trained to expect from regex replace operations.
//   rep    -- the replacement template string (may contain $1, $2, $&, etc.)
//   m      -- the full match string  ($&)
//   groups -- captured groups array from the match callback (...args slice)
//   pre    -- the string before the match ($`)
//   post   -- the string after the match  ($')
// ---------------------------------------------------------------------------
function applyReplacement(rep, m, groups, pre, post) {
  return rep.replace(/\$(\d+|&|`|')/g, function(_, token) {
    if (token === '&') return m;
    if (token === '`') return pre !== undefined ? pre : '';
    if (token === "'") return post !== undefined ? post : '';
    const n = parseInt(token, 10);
    return (n > 0 && groups[n - 1] !== undefined) ? groups[n - 1] : '';
  });
}

// ---------------------------------------------------------------------------
// Helper: compile a glob pattern to a RegExp (supports ** and *)
// ---------------------------------------------------------------------------
function expandBraces(pattern) {
  const m = pattern.match(/^(.*?)\{([^{}]+)\}(.*)$/);
  if (!m) return [pattern];
  return m[2].split(",").flatMap(alt => expandBraces(m[1] + alt.trim() + m[3]));
}

function globToRegex(glob) {
  const alts = expandBraces(glob);
  const toRe = g => g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DS__")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/__DS__/g, ".*");
  const parts = alts.map(toRe);
  return new RegExp("^(" + parts.join("|") + ")$", "i");
}

// ---------------------------------------------------------------------------
// Levenshtein edit distance and similarity percentage.
//
// levenshteinDistance(a, b) — classic DP, O(min(m,n)) space (two-row).
// calculateSimilarity(a, b) — returns integer 0-100:
//   100 * (1 - distance / max(a.length, b.length))
//   Returns 100 for two empty strings (identical), 0 when one is empty.
// ---------------------------------------------------------------------------
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Keep b as the shorter string to minimise memory.
  if (a.length < b.length) { const t = a; a = b; b = t; }
  let prev = [];
  let curr = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[b.length];
}

function calculateSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 100;
  return Math.round(100 * (1 - levenshteinDistance(a, b) / maxLen));
}

// ---------------------------------------------------------------------------

module.exports = { escapeRegex, applyReplacement, expandBraces, globToRegex, levenshteinDistance, calculateSimilarity };
