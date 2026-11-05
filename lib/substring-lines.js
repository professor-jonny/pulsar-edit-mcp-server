'use strict';
// lib/substring-lines.js
//
// findSubstringInLines: the substring-per-line fallback for the pair-anchor mode of the read tool
// (startContent + endContent, or betweenHint). It was an inline closure inside the read handler in
// lib/mcp-registration.js; it lives here so it can be unit tested (test/substring-lines.test.js).
//
// get-region's original anchor matching treated startContent / endContent as a SUBSTRING anywhere on
// a line ("unique text at or near the start/end"), not a whole-line match. matchContentEngine
// compares WHOLE lines, so the read handler tries the engine first and falls back to this function
// only when the engine answered noMatch.
//
// findSubstringInLines(lines, needle, fromRow, occ)
//   lines    array of buffer lines
//   needle   one or more lines (joined with \n); every needle line must be a substring of the
//            buffer line at the same offset
//   fromRow  0-based row to start searching from
//   occ      optional occurrence (1-based); undefined / null means "the only match"
// Returns { matched: true, matchLine, matchEndLine } (0-based rows) or
//         { matched: false, reason: 'noMatch' | 'ambiguous', matchLines? } or
//         { matched: false, reason: 'occurrenceOutOfRange', occurrence, totalMatches, matchLines }
//         (the last one is match-engine's occurrenceFail shape; matchLines are 1-based)

const { occurrenceOutOfRange, occurrenceFail } = require('./match-engine');

function findSubstringInLines(lines, needle, fromRow, occ) {
  const needleLines = needle.split('\n');
  const nLen = needleLines.length;
  const rows = [];
  for (let i = fromRow; i + nLen <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < nLen; k++) {
      if (!lines[i + k].includes(needleLines[k])) { ok = false; break; }
    }
    if (ok) rows.push(i);
  }
  if (rows.length === 0) return { matched: false, reason: 'noMatch' };
  if (rows.length > 1 && occ == null) return { matched: false, reason: 'ambiguous', matchLines: rows.map(r => r + 1) };
  // Same refusal match-engine gives: an occurrence that is not a whole number from 1 to the number of
  // matches is refused, never clamped and never guessed. The read handler words the message.
  if (occurrenceOutOfRange(occ, rows.length)) {
    return occurrenceFail(occ, rows.length, rows.map(r => r + 1));
  }
  const pick = occ != null ? occ - 1 : 0;
  return { matched: true, matchLine: rows[pick], matchEndLine: rows[pick] + nLen - 1 };
}

module.exports = { findSubstringInLines };
