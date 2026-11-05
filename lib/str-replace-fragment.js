// S4e Section 3 -- WIRED (match half only), live-verified 2026-09-24.
// str_replace's plain single-line MATCH delegates to matchFragment() via
// tryPlainFragmentMatch() below (mcp-registration.js, the `else` branch after
// the fuzzy/regex/multi-line branches; grep for tryPlainFragmentMatch).
//
// STATUS OF THE TWO HALVES (closed by PJ's decision, 2026-09-24):
//   MATCH  -- WIRED. tryPlainFragmentMatch() is called on every plain
//             (non-fuzzy, non-regex, non-multi-line) str_replace.
//   COMMIT -- DELIBERATELY NOT WIRED. commitFragmentEdit() below is exported
//             and imported at mcp-registration.js L28 but is NEVER CALLED, and
//             applyEditSpan is not used by any live tool. The commit stays on
//             str_replace's own character-index splice (buffer.setTextInRange)
//             because that block already does the B39 drift-relocate and B40
//             byte-for-byte verify, so swapping it would replace proven code
//             with equivalent never-run code, and fuzzy/regex/multi-line matches
//             would still need the old block anyway. If it is ever wired: dry
//             run, full restart, live test, standing suite -- and note this
//             file has silently lost work and shipped real bugs at every wiring
//             step so far, none of them caught by the standing suites.
//
// Replaces ONLY str_replace's plain single-line match branch (formerly
// `allLines[i].includes(effectiveOldStr)`). It does NOT touch fuzzyWhitespace,
// fuzzyContent, regex, or multi-line old_str handling -- those keep their own
// hand-rolled matching. This module is only relevant when none of those flags
// are set and old_str has no newline.
//
// TWO INTENDED BEHAVIOUR CHANGES vs the old plain branch (both refuse instead
// of silently committing; both covered by test/str-replace-fragment.test.js):
//   1. IDENTIFIER GUARD. `old_str: "count"` used to match inside `discount`
//      and commit with no warning if that was the only hit. With
//      matchFragment's default guardIdentifier:true that hit is excluded and
//      the call reports 'onlyIdentifierGlued' instead. guardIdentifier:false is
//      the explicit escape hatch. (Closes the hazard flagged since S3,
//      2026-09-20; PJ chose refuse-over-warn.)
//   2. SAME-LINE DOUBLE HIT. The old branch checked PRESENCE per line, so a
//      line containing the needle twice counted as ONE occurrence and an
//      unscoped call committed to the first hit silently. matchFragment counts
//      every hit, so that line is now 2 occurrences: with no occurrence given
//      the call refuses as ambiguous; occurrence:1 / occurrence:2 pick the 1st
//      / 2nd hit on the line. (Verified by probe 2026-09-24: totalMatches 2,
//      matchRows [1,1].) KNOWN WART: the ambiguity message therefore lists the
//      same row twice ("Found at line(s): 1, 1"). Cosmetic, not fixed.

const { matchFragment } = require('./fragment-match');
const { applyEditSpan } = require('./match-engine');
// BUG FIXED (v2, this session): the v1 draft imported BOTH matchFragment and
// applyEditSpan from './match-engine', which would throw at load time --
// matchFragment is not defined there. Verified directly against both files'
// live module.exports this session:
//   lib/fragment-match.js line 121: module.exports = { matchFragment };
//   lib/match-engine.js   line 1093: applyEditSpan, (in its own export list,
//                                    alongside resolveScope/buildReplacePreview/etc)
// So matchFragment and applyEditSpan live in two different files and must be
// imported separately, as done above.

/**
 * tryPlainFragmentMatch(params)
 *
 * params: {
 *   allLines,           // string[]
 *   effectiveOldStr,    // the (possibly fuzzy-rebuilt) needle -- but this
 *                        // function should only be called when fuzzyWhitespace
 *                        // and fuzzyContent are BOTH false and old_str has no
 *                        // newline, so effectiveOldStr === old_str in practice
 *                        // for every call this function actually receives.
 *   fnStartRow, fnEndRow, // the same scoped row range str_replace's current
 *                          // plain branch computes (live lines 656-663) --
 *                          // NOT the full searchStart/searchEnd character
 *                          // range; this function takes rows directly.
 *   occurrence,
 *   guardIdentifier = true,
 * }
 *
 * Returns on success:
 *   { matched: true, row, startCol, endCol, actualText, totalMatches, guardedOut }
 *   (matchFragment's own success shape, passed through)
 *
 * Returns on no-match / guarded-out / ambiguous / out-of-range:
 *   { matched: false, reason, totalMatches, guardedOut }
 *   Caller is responsible for turning `reason` into the appropriate
 *   user-facing message -- this module does NOT build messages or bump()
 *   stats, same pure-data-in/wording-out split as recover.js (S4a) and
 *   resolveScope (Section 2 above).
 */
function tryPlainFragmentMatch({ allLines, effectiveOldStr, fnStartRow, fnEndRow, occurrence, guardIdentifier = true }) {
  return matchFragment({
    lines: allLines,
    needle: effectiveOldStr,
    startRow: fnStartRow,
    endRow: fnEndRow,
    occurrence,
    guardIdentifier,
  });
}

/**
 * commitFragmentEdit(buffer, match, newStr)
 *
 * Thin wrapper over applyEditSpan -- kept as a separate named function
 * (rather than calling applyEditSpan directly at the call site) so the
 * caller's commit-path code reads the same shape as str_replace's existing
 * commit block does today (a single named step between "match found" and
 * "stats/response building"), easing side-by-side review against the
 * current live lines 940-994.
 *
 * Returns applyEditSpan's own return shape unchanged:
 *   success: { row, startCol, endCol, newLineCount }
 *   failure: { error: 'driftUnrecoverable' | 'verifyFailed' }
 *
 * NOTE: applyEditSpan reproduces the B39/B40 drift-relocate and
 * byte-for-byte-verify logic itself -- str_replace's OWN hand-rolled
 * versions of that logic (live lines 940-984, the
 * `_freshTextAtCommit !== text` / `_verifyText !== effectiveOldStr` checks)
 * become DEAD CODE for calls that go through this path once wired in, and
 * should be removed only for the fragment-match branch specifically, not
 * for the fuzzy/regex/multi-line branches which still need their own
 * (unchanged, character-index-based) drift handling -- those branches are
 * NOT covered by applyEditSpan and must keep their current commit logic.
 * This is a case where the live file ends up with TWO commit paths
 * side by side (span-based for plain-literal single-line matches,
 * character-index-based for everything else), not one unified path --
 * that split is intentional per applyEditSpan's own single-line-only design,
 * not an oversight to "finish" later.
 */
function commitFragmentEdit(buffer, match, newStr) {
  return applyEditSpan(buffer, match, newStr);
}

module.exports = { tryPlainFragmentMatch, commitFragmentEdit };
