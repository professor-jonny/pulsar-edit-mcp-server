'use strict';
// S4b (2026-09-22) -- character-span fragment matcher. Pure addition: no
// existing tool's behaviour changes until something opts in (per
// mcp-server-refactor-plan.md's S4b spec). Not required by, or required from,
// match-engine.js's resolveScope/matchContent path.
//
// WHY THIS EXISTS: str_replace's plain single-line branch (mcp-registration.js
// ~L655, String#includes) matches 'count' inside 'discount' -- a single such
// hit commits silently (the B38 guard only refuses when there is MORE THAN
// ONE hit). lib/identifier-boundary.js (S3, checkIdentifierBoundary) answers
// "is this hit glued to a longer identifier?" but was built standalone
// because the engine had no SUB-LINE match shape to hang it on. This module
// is that shape.
//
// SCOPE: fragments are single-line by design (identifier-boundary.js itself
// only ever looks at neighbours on the SAME line -- see its own header). A
// needle spanning multiple lines is matchContent's job, not this module's.
// SINCE R1f (2026-10-17) matchSpan, at the bottom of this file, matches a multi-line needle
// (moved here from lib/replace-fragment.js); matchFragment itself stays single-line.
//
// SHAPE CHOICE: row + column (not a global character offset into the whole
// buffer text). Rows are what every other part of the engine already keys on
// (matchContent's matchLine/matchEndLine, applyEdit's startRow/endRow), and a
// row+column span can be verified/relocated against buffer.getLines() without
// needing a text-vs-lines offset conversion. mcp-server-refactor-plan.md's
// "open question 1" (rows vs characters in resolveScope) is about the SCOPE
// WINDOW layer and does not block this module -- resolveScope still hands
// back row bounds, and this module searches within them line by line.
//
// GUARD DEFAULT: guardIdentifier:true (the default) EXCLUDES hits glued to a
// longer identifier from the candidate set entirely -- i.e. REFUSES them, not
// warns. DECIDED 2026-09-22 (mcp-server-refactor-plan.md "Open questions for
// PJ" item 4): refuse over warn -- a destructive caller must never silently
// commit into the wrong identifier. When only SOME hits on a line are glued,
// they are FILTERED (excluded from the candidate set, occurrence:N counts only
// the clean ones), not refuse-and-list -- the `guardedOut` count on every
// result says how many were excluded, so a caller isn't left wondering why a
// hit it can see in the source didn't count. guardIdentifier:false is the
// named escape hatch for intentional mid-identifier edits: it returns glued
// hits too, each still carrying its own `boundary` result, for a caller that
// wants warn-not-refuse semantics to inspect and decide itself. NOT yet
// decided: whether this guard should apply to regex/fuzzyWhitespace/multi-line
// matching -- moot for now, since matchFragment is a plain-literal, single-line
// matcher only (see the SCOPE note above).
//
// PURE: no Pulsar, no buffer, no I/O -- takes a plain lines array. Unit tests:
// test/fragment-match.test.js.

const { checkIdentifierBoundary } = require('./identifier-boundary');
const { findHits } = require('./edit-match');

/**
 * matchFragment({ lines, needle, startRow, endRow, occurrence, guardIdentifier })
 *
 * Scans lines[startRow..endRow] (inclusive, endRow defaults to last line) for
 * every literal occurrence of `needle` on a single line. Overlapping hits on
 * the same line are all reported (advance by 1), matching how
 * scanLineForFragments / str_replace count occurrences.
 *
 * Returns on success:
 *   { matched: true, row, startCol, endCol, actualText, totalMatches,
 *     guardedOut, boundary }
 *   row is 0-based; startCol/endCol are 0-based, endCol EXCLUSIVE (like
 *   String#slice), so line.slice(startCol, endCol) === needle.
 *   guardedOut = how many raw hits were excluded by the identifier guard.
 *
 * Returns on failure:
 *   { matched: false, reason: 'invalidInput'|'noMatch'|'onlyIdentifierGlued'|
 *     'ambiguous'|'occurrenceOutOfRange', ... }
 *   'onlyIdentifierGlued' -- every raw hit existed but all were glued to a
 *   longer identifier and guardIdentifier excluded them all; distinct from
 *   'noMatch' (the needle wasn't found as a substring at all) so a caller can
 *   give a more specific message.
 */
function matchFragment({ lines, needle, startRow = 0, endRow, occurrence, guardIdentifier = true }) {
  if (!Array.isArray(lines) || typeof needle !== 'string' || needle.length === 0) {
    return { matched: false, reason: 'invalidInput' };
  }
  const lastRow  = endRow == null ? lines.length - 1 : Math.min(endRow, lines.length - 1);
  const firstRow = Math.max(0, startRow);

  const hits = [];
  for (let row = firstRow; row <= lastRow; row++) {
    const line = lines[row];
    if (typeof line !== 'string') continue;
    let from = 0;
    for (;;) {
      const col = line.indexOf(needle, from);
      if (col === -1) break;
      const boundary = checkIdentifierBoundary(line, col, needle.length);
      hits.push({ row, startCol: col, endCol: col + needle.length, boundary });
      from = col + 1;
    }
  }

  const candidates = guardIdentifier ? hits.filter(h => !h.boundary.inside) : hits;
  const guardedOut = hits.length - candidates.length;

  if (candidates.length === 0) {
    return {
      matched: false,
      reason: hits.length > 0 ? 'onlyIdentifierGlued' : 'noMatch',
      totalMatches: hits.length,
      guardedOut,
    };
  }

  if (occurrence != null) {
    if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > candidates.length) {
      return { matched: false, reason: 'occurrenceOutOfRange', occurrence, totalMatches: candidates.length, guardedOut };
    }
    const hit = candidates[occurrence - 1];
    return { matched: true, row: hit.row, startCol: hit.startCol, endCol: hit.endCol, actualText: needle, totalMatches: candidates.length, guardedOut, boundary: hit.boundary };
  }

  if (candidates.length > 1) {
    return { matched: false, reason: 'ambiguous', totalMatches: candidates.length, matchRows: candidates.map(h => h.row + 1), guardedOut };
  }

  const hit = candidates[0];
  return { matched: true, row: hit.row, startCol: hit.startCol, endCol: hit.endCol, actualText: needle, totalMatches: 1, guardedOut, boundary: hit.boundary };
}

// ---- multi-line spans (moved here from lib/replace-fragment.js, TODO R1f) ---------------------
// A multi-line needle is matched with lib/edit-match.js findHits (the shared span matcher:
// literal, case-sensitive, scope 'wholeText' so the window rows are joined with LF). A hit is
// { startRow, startCol, endRow, endCol } and may start and end MID-LINE. The identifier guard
// looks at the FIRST edge (the character before the span) and the LAST edge (the one after it).

// Is the span glued to a longer identifier at its first or last edge?
function spanGlued(lines, h) {
  const first = lines[h.startRow];
  const last = lines[h.endRow];
  const left = typeof first === 'string' && first.length > h.startCol &&
    checkIdentifierBoundary(first, h.startCol, first.length - h.startCol).left;
  const right = typeof last === 'string' && h.endCol > 0 &&
    checkIdentifierBoundary(last, 0, h.endCol).right;
  return !!(left || right);
}

// matchFragment-shaped result for a multi-line needle: same reasons, same occurrence rules.
// Success carries endRow too; row is the START row.
function matchSpan({ lines, needle, startRow, endRow, occurrence, guardIdentifier = true }) {
  const found = findHits({ lines, oldString: needle, scope: 'wholeText', startRow, endRow });
  if (!found.ok) return { matched: false, reason: 'invalidInput' };
  const hits = found.hits;
  const candidates = guardIdentifier ? hits.filter(h => !spanGlued(lines, h)) : hits;
  const guardedOut = hits.length - candidates.length;
  if (candidates.length === 0) {
    return { matched: false, reason: hits.length > 0 ? 'onlyIdentifierGlued' : 'noMatch', totalMatches: hits.length, guardedOut };
  }
  const pick = (h) => ({ matched: true, row: h.startRow, startCol: h.startCol, endRow: h.endRow, endCol: h.endCol, totalMatches: candidates.length, guardedOut });
  if (occurrence != null) {
    if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > candidates.length) {
      return { matched: false, reason: 'occurrenceOutOfRange', occurrence, totalMatches: candidates.length, guardedOut };
    }
    return pick(candidates[occurrence - 1]);
  }
  if (candidates.length > 1) {
    return { matched: false, reason: 'ambiguous', totalMatches: candidates.length, matchRows: candidates.map(h => h.startRow + 1), guardedOut };
  }
  return pick(candidates[0]);
}

module.exports = { matchFragment, matchSpan };
