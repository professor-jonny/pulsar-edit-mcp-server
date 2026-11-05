'use strict';
// 2026-10-09 -- Stage 1(a) of the "shared span pathway" plan (mcp-server-refactor-plan.md,
// '## PLAN -- shared span pathway + per-tool ambiguity policy'). PURE planner for the
// replace tool's fragment:true mode: no Pulsar, no buffer, no stats, no I/O. Name mirrors
// lib/str-replace-fragment.js.
//
// STATUS: the replace handler (lib/mcp-registration.js, fragment branch ~L2876-2912) calls
// it (Stage 1(b) is done) for every refusal path, the span and the tags, and keeps only the write.
// This file is the single home of that logic, pinned by test/replace-fragment.*.test.js.
// Pinned details:
// the messages are the GOLDEN strings captured live on 2026-10-09 (session note: GOLDEN
// MESSAGES) and the statKeys below were read from the handler source the same day.
//
// WHAT IT DOES (same order as the handler):
//   1. refuse fuzzyWhitespace / fuzzyContent              (reason fragmentUnsupportedFlag)
//   2. match a multi-line old_str as a span (LF/CR/CRLF)             (edit-match.js; endRow on the edit)
//   3. matchFragment() or, multi-line, matchSpan() over lines[startRow..endRow]       (noMatch / invalidInput /
//        onlyIdentifierGlued / ambiguous / occurrenceOutOfRange, or success)
//   4. drift pre-check against liveLines, ONLY when liveLines is passed (reason
//        fragmentDrift). The handler runs this AFTER its dryRun return, so a dry run simply
//        omits liveLines.
//
// RETURNS
//   success: { ok: true, edit: { row, startCol, endCol, actualText, newStr },
//              totalMatches, guardedOut, tags }
//     row is 0-based; startCol/endCol are 0-based with endCol EXCLUSIVE (String#slice).
//     tags is the handler's _fragTags: ['fragment'] plus 'guardedOut:N' when N > 0.
//   refusal: { ok: false, reason, message, statKeys, hintsFailed, consecBump, logFault }
//     message  the exact text the handler returns (every one ends 'Nothing was written.'
//              except the applyEditSpan error, which is the one refusal that can follow a
//              write attempt: see describeApplyError).
//     statKeys the bump() keys the handler records for this refusal, for the replace tool.
//              Always contains 'fragmentFails'; 'fails.noMatch' on every refusal except
//              ambiguous (which gets 'fails.anchorAmbiguous') and drift (fragmentFails only).
//              Flag clash and multi-line were folded into fails.noMatch on 2026-10-11 so they
//              show in the fails.* headline (before, they only bumped fragmentFails).
//              (replace uses anchorAmbiguous, NOT 'ambiguous':
//              a bump key must match the tool's own schema name.)
//     hintsFailed  true on every refusal: the handler also bumps hintsFailed.<hint> for each
//              scope hint the caller passed. That depends on the call's hint arguments, so
//              the handler keeps doing it; this module only says that it must.
//     consecBump   true when the handler also increments ctx.consec.count (the consecutive-
//              failure counter behind the 'switch tool' suggestion). False for ambiguous,
//              flag clash, multi-line and drift.
//     logFault true when the handler calls logMatchFailure with this reason.
//
// NOT HERE ON PURPOSE: the write itself (applyEditSpan), dry-run preview text, struct/nudge/
// lint/style suffixes and the success stat bumps. Those need Pulsar objects and stay in the
// handler.

const { matchFragment, matchSpan } = require('./fragment-match');

const MSG_FLAG_CLASH = 'replace refused: fragment:true is a plain literal match and cannot be combined with fuzzyWhitespace or fuzzyContent. Nothing was written.';
// (MSG_MULTI_LINE was removed 2026-10-16: fragment:true now matches multi-line spans.)
const MSG_NOT_FOUND  = 'replace: fragment not found in scope. Nothing was written.';
const MSG_DRIFT      = 'replace refused: the matched span changed in the buffer since it was resolved; re-run to re-resolve. Nothing was written.';

// ---- multi-line spans (2026-10-16) ------------------------------------------------------------
// The span matcher itself (matchSpan, with its identifier guard) lives in lib/fragment-match.js
// since TODO R1f, so other tools can reuse it. Only spanText (used by the drift check) stays here.
// The text a span covers in a set of lines, rows joined with LF; undefined if a row is missing.
function spanText(lines, h) {
  if (!Array.isArray(lines)) return undefined;
  const a = lines[h.row];
  const b = lines[h.endRow];
  if (typeof a !== 'string' || typeof b !== 'string') return undefined;
  if (h.endRow === h.row) return a.slice(h.startCol, h.endCol);
  const parts = [a.slice(h.startCol)];
  for (let r = h.row + 1; r < h.endRow; r++) {
    if (typeof lines[r] !== 'string') return undefined;
    parts.push(lines[r]);
  }
  parts.push(b.slice(0, h.endCol));
  return parts.join('\n');
}

function refusal(reason, message, statKeys, consecBump, logFault) {
  return { ok: false, reason, message, statKeys, hintsFailed: true, consecBump, logFault };
}

// Message for a matchFragment refusal, built exactly as the handler builds it. Anything the
// matcher reports that has no specific wording (noMatch, invalidInput) gets MSG_NOT_FOUND.
function matcherMessage(m, occurrence) {
  if (m.reason === 'ambiguous') {
    const rows = m.matchRows || [];
    return 'replace: the fragment appears ' + m.totalMatches + ' times in scope (lines '
      + rows.slice(0, 10).join(', ')
      + (rows.length > 10 ? ', ... and ' + (rows.length - 10) + ' more' : '')
      + '). Pass occurrence:N or a scope hint to pick one. Nothing was written.';
  }
  if (m.reason === 'onlyIdentifierGlued') {
    return 'replace: every occurrence of the fragment is glued to a longer identifier ('
      + m.guardedOut + ' refused, e.g. count inside discount). Pass guardIdentifier:false if a mid-identifier edit is intended. Nothing was written.';
  }
  if (m.reason === 'occurrenceOutOfRange') {
    return 'replace: occurrence ' + occurrence + ' is out of range; there are '
      + m.totalMatches + ' candidate(s) in scope. Nothing was written.';
  }
  return MSG_NOT_FOUND;
}

/**
 * planFragmentReplace({ lines, startRow, endRow, oldStr, newStr, occurrence,
 *                       guardIdentifier, flags, liveLines, matcher })
 *
 * lines            array of the buffer's lines the match is resolved against
 * startRow/endRow  0-based inclusive scope window (the handler passes scope.searchStart /
 *                  scope.searchEnd); endRow omitted = last line
 * oldStr / newStr  the literal needle and its replacement (newStr is carried through
 *                  verbatim; this module never interprets it)
 * occurrence       optional 1-based pick among the candidates
 * guardIdentifier  default true; only the value false disables the guard (the handler
 *                  passes guardIdentifier !== false, so undefined means ON)
 * flags            { fuzzyWhitespace, fuzzyContent }; any truthy value is refused
 * liveLines        optional; when given, the drift pre-check runs against it
 * matcher          injectable, defaults to matchFragment (lets tests force drift/odd shapes)
 */
function planFragmentReplace({
  lines, startRow, endRow, oldStr, newStr, occurrence,
  guardIdentifier, flags, liveLines, matcher = matchFragment,
}) {
  const f = flags || {};
  if (f.fuzzyWhitespace || f.fuzzyContent) {
    return refusal('fragmentUnsupportedFlag', MSG_FLAG_CLASH, ['fails.noMatch', 'fragmentFails'], false, true);
  }
  // 2026-10-16: a multi-line old_str is no longer refused. It is matched as a span (matchSpan, from fragment-match.js);
  // CR and CRLF are normalised to LF because buffer rows carry no line break.
  const multi = typeof oldStr === 'string' && (oldStr.includes('\n') || oldStr.includes('\r'));
  const needle = multi ? oldStr.replace(/\r\n?/g, '\n') : oldStr;

  const m = (multi ? matchSpan : matcher)({
    lines, needle, startRow, endRow, occurrence,
    guardIdentifier: guardIdentifier !== false,
  });

  if (!m.matched) {
    const ambiguous = m.reason === 'ambiguous';
    return refusal(
      m.reason || 'noMatch',
      matcherMessage(m, occurrence),
      [ambiguous ? 'fails.anchorAmbiguous' : 'fails.noMatch', 'fragmentFails'],
      !ambiguous,
      true
    );
  }

  if (liveLines !== undefined) {
    const live = Array.isArray(liveLines) ? liveLines[m.row] : undefined;
    const liveSpan = multi ? spanText(liveLines, m) : (typeof live === 'string' ? live.slice(m.startCol, m.endCol) : undefined);
    if (liveSpan !== needle) {
      return refusal('fragmentDrift', MSG_DRIFT, ['fragmentFails'], false, true);
    }
  }

  const tags = ['fragment'];
  if (multi) tags.push('multiLine');
  if (m.guardedOut > 0) tags.push('guardedOut:' + m.guardedOut);
  return {
    ok: true,
    edit: multi
      ? { row: m.row, startCol: m.startCol, endRow: m.endRow, endCol: m.endCol, actualText: needle, newStr }
      : { row: m.row, startCol: m.startCol, endCol: m.endCol, actualText: oldStr, newStr },
    totalMatches: m.totalMatches,
    guardedOut: m.guardedOut,
    tags,
  };
}

/**
 * describeApplyError(err) -- the refusal for applyEditSpan returning { error }. Same shape as
 * planFragmentReplace's refusals, except: the message does NOT end 'Nothing was written.'
 * (it asks the caller to re-run), consecBump is false, and logFault is false (the handler
 * does not call logMatchFailure on this path). Not reachable live.
 */
function describeApplyError(err) {
  return {
    ok: false,
    reason: 'applyEditSpanError',
    message: 'replace failed: ' + err + ' -- the buffer changed since the match was resolved; re-run to re-resolve.',
    statKeys: ['fails.noMatch', 'fragmentFails'],
    hintsFailed: true,
    consecBump: false,
    logFault: false,
  };
}

// 2026-10-17 (R1b): which refusals a corrected old_str can fix. The handler marks these matched:false
// and appends the retry nudge, so tool-framework.js stashes the call and a bare { filePath, old_str }
// resend works. Not retryable: a flag clash (old_str is not the problem), an out-of-range occurrence
// (occurrence is), a drift or write error (re-run as is), and anything unknown.
const RETRYABLE_REASONS = new Set(['noMatch', 'ambiguous', 'onlyIdentifierGlued']);
function isRetryableRefusal(reason) {
  return RETRYABLE_REASONS.has(reason);
}

module.exports = { planFragmentReplace, describeApplyError, isRetryableRefusal };
