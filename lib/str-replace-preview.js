// S4e Section 1 -- WIRED and live-verified (2026-09-23) -- dry-run preview via
// buildReplacePreview. mcp-registration.js requires this module at L26 and
// str_replace's dryRun return delegates to buildDryRunResult (~L1027-1030).
//
// Replaced str_replace's hand-rolled dry-run block with a call to
// match-engine.js's buildReplacePreview (S4d). str_replace is currently the
// ONLY caller of buildReplacePreview; replace-block, replace-function-body,
// replace-all, sed and delete still build their own DRY RUN text by hand
// (audited 2026-09-24). Porting them would be new work, not part of S4e.
//
// BEHAVIOR CHANGE (APPROVED by PJ, 2026-09-23, and live): the rendered text
// changed bytes. Old: '?' marker, header '? DRY RUN -- match found at
// line N...'. New: the heavy-arrow marker and the magnifier-emoji header
// '<magnifier> DRY RUN -- match found at line N...'. Everything else (context
// radius 3, diff lines, "reply without dryRun to commit" trailer) is
// semantically the same, just built by the shared function instead of by hand.
// Covered by test/str-replace-preview.test.js (10/10).
//
// This module exports ONE function, buildDryRunResult, matching the shape
// str_replace's handler needs to return directly. It takes exactly the
// variables already in scope at that point in the handler -- no new state,
// no changed matching logic, nothing upstream of "we found a match and
// dryRun is true" is touched.

const { buildReplacePreview } = require('./match-engine');

/**
 * buildDryRunResult(params)
 *
 * params: {
 *   allLines,      // string[] - full buffer lines (ctx.allLines)
 *   lineCount,      // allLines.length
 *   matchLine,      // 0-based row of the match (already computed)
 *   matchLines,     // effectiveOldStr.split('\n') (already computed)
 *   new_str,        // the replacement text as given
 *   scopeLabel,     // already-built scope label string, e.g. ' inFunction "foo"'
 *   occurrence,     // number, for the occurrence tag
 *   fuzzyWhitespace, fuzzyContent, // booleans, for tags
 * }
 *
 * Returns the same { content, matched, dryRun, matchLine } shape
 * str_replace's handler currently returns inline, so this is a drop-in
 * replacement for that return statement. buildReplacePreview's own output
 * already includes the "Reply with the same call without dryRun..."
 * trailer (confirmed against the live match-engine.js source, line 1079) --
 * this function returns it unmodified, no appending.
 */
function buildDryRunResult({
  allLines, lineCount, matchLine, matchLines, new_str, scopeLabel,
  occurrence = 1, fuzzyWhitespace = false, fuzzyContent = false,
}) {
  const tags = [];
  if (occurrence > 1) tags.push(`occurrence ${occurrence}`);
  if (fuzzyWhitespace) tags.push('fuzzyWhitespace');
  if (fuzzyContent) tags.push('fuzzyContent');

  // CORRECTED after re-reading match-engine.js's real buildReplacePreview
  // source in full (line 1079): its own output ALREADY includes the
  // "Reply with the same call without dryRun (or dryRun:false) to commit."
  // trailer line. An earlier version of this draft incorrectly assumed that
  // line was missing and appended it a second time -- that assumption was
  // never actually verified against the function body at draft time, only
  // against its doc comment, and was wrong. Fixed here: buildReplacePreview's
  // return value is used directly, no appending.
  return buildReplacePreview({
    allLines,
    lineCount,
    matchLine,
    matchLines,
    new_str,
    scopeLabel: scopeLabel || '',
    tags,
  });
}

module.exports = { buildDryRunResult };
