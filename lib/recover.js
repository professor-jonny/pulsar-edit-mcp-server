'use strict';
// ---------------------------------------------------------------------------
// lib/recover.js — shared "recover" stage for content-based needle matching.
//
// B32: extracted from str_replace's hand-rolled inline logic (mcp-registration.js,
// originally ~L605-832). str_replace's own behavior is UNCHANGED by this file —
// it still runs its own inline copy. This module exists so match-engine.js's
// matchContent() (and any future tool ported onto it — block-edit, block-delete,
// eventually str_replace itself per T1-T3) can call the same battle-tested
// rescue logic instead of match-engine's current simpler sequential waterfall
// (exact → fuzzyWhitespace → fuzzyContent, tried independently).
//
// Two independent rescue mechanisms:
//
//   profiledMatch(needleText, searchText)
//     B32 #4 — single-pass diagnosis + one combined retry. Classifies ALL
//     differences between needleText and the search window in one pass
//     (whitespace-only / unicode-encoding / trailing-comment-on-last-line),
//     builds ONE transformed needle combining whichever transforms are
//     needed, and does ONE match attempt with it. Fixes the case a strict
//     sequential waterfall misses: a line with BOTH an indent difference AND
//     a smart-quote difference, which fails a trim-only pass and an encoding-
//     only pass independently since neither combines trim+normalize.
//
//   partialMatchRescue(needleText, fullText, searchStart, searchEnd)
//     B32 #2 — when the scoped window has NO match at all, search the ENTIRE
//     buffer for the needle's leading ~2 lines. If found outside the resolved
//     scope, retry a fuzzyWhitespace match from there. Rescues the common
//     case where a prior insert/delete shifted the target region so the
//     scope/hint now points at the wrong area.
//
// Zero Atom API dependencies — safe to require() at module load without Atom,
// same design constraint as tool-hints.js.
// ---------------------------------------------------------------------------

// Shared Unicode normaliser — same map used by str_replace's inline fuzzyContent.
function _norm(s) {
  return s
    .replace(/\uFEFF/g, '')
    .replace(/[\u200B\u200C\u200D\u00AD]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2190-\u21FF]/g, '->')
    .replace(/[\u2500-\u257F]+/g, '--')
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '\u{1F4CC}');
}

// BUG-B guard constants — a stripped trailing comment must still leave a
// reliable, non-trivial anchor behind (same thresholds as the original).
const STRIP_MIN_LAST  = 8;
const STRIP_MIN_TOTAL = 10;
const TRAILING_COMMENT_RE = /(\s*(?:\/\*.*?\*\/|\/\/[^\n]*))$/;

/**
 * profileNeedle(needleLines, haystackLines)
 * Single pass over needleLines classifying mismatches against haystackLines
 * (the search-window lines). Internal helper, exported for testability.
 * @returns {{ needsWhitespace, needsEncoding, trailingComment }}
 */
function profileNeedle(needleLines, haystackLines) {
  let needsWhitespace = false;
  let needsEncoding   = false;
  let trailingComment = null;

  for (let li = 0; li < needleLines.length; li++) {
    const nLine = needleLines[li];
    const nTrim = nLine.trim();
    if (!nTrim) continue;

    const bufMatch = haystackLines.find(bl => bl.trim() === nTrim);
    if (bufMatch !== undefined) {
      if (bufMatch !== nLine) needsWhitespace = true;
      continue;
    }

    const nNorm = _norm(nTrim);
    const bufNorm = haystackLines.find(bl => _norm(bl.trim()) === nNorm);
    if (bufNorm !== undefined) {
      needsEncoding = true;
      if (bufNorm !== nLine) needsWhitespace = true;
      continue;
    }

    if (li === needleLines.length - 1) {
      const cm = nLine.match(TRAILING_COMMENT_RE);
      if (cm) {
        const stripped = nLine.slice(0, nLine.length - cm[1].length);
        const strippedTrim = stripped.trim();
        const bufStripped = haystackLines.find(bl => bl.trim() === strippedTrim);
        if (bufStripped !== undefined) {
          trailingComment = cm[1].trim();
          if (bufStripped !== stripped) needsWhitespace = true;
        }
      }
    }
  }
  return { needsWhitespace, needsEncoding, trailingComment };
}

/**
 * profiledMatch(needleText, searchText)
 * Full B32 #4 rescue: profile + build transformed needle + single retry.
 *
 * @param {string} needleText   — the needle as originally supplied (multi-line OK)
 * @param {string} searchText   — the search window text (already scope-narrowed
 *                                by the caller — this function does NOT expand scope)
 * @returns {null | {
 *     rebuiltNeedle: string,
 *     tags: { fuzzyWhitespace, fuzzyContent, autoStripComment },
 *     salvagedComment: string|null
 *   }}
 *   rebuiltNeedle is the exact substring as it exists in searchText — locate it
 *   with searchText.indexOf(rebuiltNeedle), or re-locate in the full buffer via
 *   fullText.indexOf(rebuiltNeedle, searchStart).
 *   salvagedComment (when non-null) is the comment text stripped from the
 *   needle's last line — callers should append it to new_str's last line
 *   (e.g. wrapped as a "CHECK:" block comment) for human review.
 */
function profiledMatch(needleText, searchText) {
  const searchLines = searchText.split('\n');
  const needleLines  = needleText.split('\n');

  const profile = profileNeedle(needleLines, searchLines);
  const anyTransform = profile.needsWhitespace || profile.needsEncoding || profile.trailingComment;
  if (!anyTransform) return null;

  let workNeedle = needleLines;
  let salvagedComment = null;

  if (profile.trailingComment) {
    const last = workNeedle[workNeedle.length - 1];
    const cm   = last.match(TRAILING_COMMENT_RE);
    if (cm) {
      const strippedLast = last.slice(0, last.length - cm[1].length);
      if (strippedLast.replace(/\s/g, '').length >= STRIP_MIN_LAST &&
          workNeedle.slice(0, -1).concat(strippedLast).join('\n').replace(/\s/g, '').length >= STRIP_MIN_TOTAL) {
        workNeedle = workNeedle.slice(0, -1).concat(strippedLast);
        salvagedComment = profile.trailingComment;
      }
    }
  }

  let fuzzyStart = -1;
  let fuzzyStart2 = -1; // B41: second hit, for ambiguity check
  outer_scan:
  for (let i = 0; i <= searchLines.length - workNeedle.length; i++) {
    for (let j = 0; j < workNeedle.length; j++) {
      const sl = searchLines[i + j];
      const nl = workNeedle[j];
      const match = profile.needsEncoding
        ? _norm(sl.trim()) === _norm(nl.trim())
        : sl.trim() === nl.trim();
      if (!match) continue outer_scan;
    }
    if (fuzzyStart === -1) {
      fuzzyStart = i;
    } else {
      fuzzyStart2 = i;
      break;
    }
  }
  if (fuzzyStart === -1) return null;
  // B41: two similar-enough lines matched within the search window -- taking
  // fuzzyStart (the first) silently would risk rebuilding a needle against the
  // wrong location with no warning. Signal ambiguity instead of picking one.
  if (fuzzyStart2 !== -1) return { ambiguous: true };

  let rebuiltNeedle;
  if (profile.needsEncoding) {
    const normNeedle   = _norm(workNeedle.join('\n'));
    const normHaystack = _norm(searchText);
    const normIdx      = normHaystack.indexOf(normNeedle);
    if (normIdx !== -1) {
      let srcIdx = normIdx, consumed = 0;
      while (consumed < normNeedle.length && srcIdx < searchText.length) {
        consumed += _norm(searchText[srcIdx]).length;
        srcIdx++;
      }
      rebuiltNeedle = searchText.substring(normIdx, srcIdx);
    }
  }
  if (!rebuiltNeedle) {
    rebuiltNeedle = searchLines.slice(fuzzyStart, fuzzyStart + workNeedle.length).join('\n');
  }

  const tags = {
    fuzzyWhitespace:   !profile.needsEncoding && profile.needsWhitespace,
    fuzzyContent:      profile.needsEncoding,
    autoStripComment:  !!salvagedComment,
  };
  // A salvaged comment implies a whitespace-normalized rebuild even when the
  // rest of the line matched exactly (mirrors the original's bookkeeping).
  if (salvagedComment) tags.fuzzyWhitespace = true;

  return { rebuiltNeedle, tags, salvagedComment };
}

/**
 * partialMatchRescue(needleText, fullText, searchStart, searchEnd)
 * B32 #2 full-buffer drift rescue. Only meaningful for multi-line needles —
 * a single line has no "leading lines" to anchor on.
 *
 * @param {string} needleText
 * @param {string} fullText     — entire buffer text
 * @param {number} searchStart  — original scope start (char offset) — used only
 *                                to detect whether the rescue found something
 *                                genuinely OUTSIDE the original scope
 * @param {number} searchEnd    — original scope end (char offset)
 * @returns {null | { rebuiltNeedle: string, leaderIdx: number, outsideScope: boolean }}
 *   Caller should locate the absolute match index via
 *   fullText.indexOf(rebuiltNeedle, leaderIdx) same as the original call site did.
 */
function partialMatchRescue(needleText, fullText, searchStart = 0, searchEnd = fullText.length) {
  if (!needleText.includes('\n')) return null;

  const pmLines  = needleText.split('\n');
  const pmLeader = pmLines.slice(0, Math.min(2, pmLines.length)).join('\n');
  const pmLeaderIdx = fullText.indexOf(pmLeader);
  if (pmLeaderIdx === -1) return null;
  // B41: pmLeader is searched against the ENTIRE buffer with no scope. If the
  // same leading-lines text occurs more than once anywhere in the file, taking
  // the first occurrence silently risks rescuing against the wrong location.
  const pmLeaderIdx2 = fullText.indexOf(pmLeader, pmLeaderIdx + 1);
  if (pmLeaderIdx2 !== -1) return { ambiguous: true };

  const pmSearchText  = fullText.substring(pmLeaderIdx, pmLeaderIdx + needleText.length * 2);
  const pmSearchLines = pmSearchText.split('\n');
  const pmNeedle      = pmLines.map(l => l.trim());

  let pmStart = -1;
  outer_pm:
  for (let i = 0; i <= pmSearchLines.length - pmNeedle.length; i++) {
    for (let j = 0; j < pmNeedle.length; j++) {
      if (pmSearchLines[i + j].trim() !== pmNeedle[j]) continue outer_pm;
    }
    pmStart = i;
    break;
  }
  if (pmStart === -1) return null;

  const rebuiltNeedle = pmSearchLines.slice(pmStart, pmStart + pmNeedle.length).join('\n');
  const outsideScope = pmLeaderIdx < searchStart || pmLeaderIdx >= searchEnd;
  return { rebuiltNeedle, leaderIdx: pmLeaderIdx, outsideScope };
}

module.exports = {
  profileNeedle,
  profiledMatch,
  partialMatchRescue,
  _norm,
};
