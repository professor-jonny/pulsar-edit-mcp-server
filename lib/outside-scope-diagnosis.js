'use strict';
// lib/outside-scope-diagnosis.js (2026-10-11)
//
// PURE diagnosis of "the needle is not in the search scope, but its text is in the file". No Pulsar,
// no stats, no I/O, no message decoration beyond the plain ASCII advice lines.
//
// WHY: until now str_replace and the match-engine's autoRescue #2 ("partial match") silently EDITED
// the text they found elsewhere in the buffer (recover.js partialMatchRescue, tag partialMatch /
// autoPartialMatch). PJ decided (2026-10-11) that committing an edit the caller did not ask for is
// wrong: this is a FAILURE with a precise diagnosis instead. The caller is told where the text is,
// whether it is outside the scope it asked for, and which lines differ only in whitespace, so the
// retry sends just what needs fixing. Nothing is edited behind the caller's back.
//
// Detection is exactly recover.js partialMatchRescue (same leader lines, same trimmed line compare,
// same ambiguity rule), so a case the old rescue would have committed is now reported, and a case it
// refused is still refused. This module only turns the rescue's result into advice.
//
//   diagnoseElsewhere({ needleText, fullText, searchStart, searchEnd })
//     -> null                                   nothing found (or a single-line needle)
//     -> { ambiguous: true }                    the leading lines occur more than once in the file
//     -> { ambiguous: false, startLine, endLine, outsideScope, differing }
//        startLine / endLine are 1-based buffer lines of the match; outsideScope is true when the
//        match starts outside searchStart..searchEnd (character offsets); differing lists the needle
//        lines whose text is not byte-identical to the buffer line (whitespace only, by construction):
//        [{ needleLine, needleText, bufferLine, bufferText }]
//
//   formatElsewhereAdvice(diag, { subject, scopeLabel, max }) -> array of plain message lines
//     (empty for a null diagnosis). The caller adds any emoji/prefix and joins the lines.

const { partialMatchRescue } = require('./recover');

function diagnoseElsewhere({ needleText, fullText, searchStart = 0, searchEnd } = {}) {
  if (typeof needleText !== 'string' || typeof fullText !== 'string') return null;
  const end = typeof searchEnd === 'number' ? searchEnd : fullText.length;
  const r = partialMatchRescue(needleText, fullText, searchStart, end);
  if (!r) return null;
  if (r.ambiguous) return { ambiguous: true };
  const idx = fullText.indexOf(r.rebuiltNeedle, r.leaderIdx);
  if (idx === -1) return null;
  const startLine = fullText.substring(0, idx).split('\n').length;
  const bufLines = r.rebuiltNeedle.split('\n');
  const needleLines = needleText.split('\n');
  const differing = [];
  for (let i = 0; i < needleLines.length; i++) {
    if (needleLines[i] !== bufLines[i]) {
      differing.push({
        needleLine: i + 1,
        needleText: needleLines[i],
        bufferLine: startLine + i,
        bufferText: bufLines[i],
      });
    }
  }
  return {
    ambiguous: false,
    startLine,
    endLine: startLine + bufLines.length - 1,
    outsideScope: !!r.outsideScope,
    differing,
  };
}

function formatElsewhereAdvice(diag, { subject = 'old_str', scopeLabel = '', max = 3 } = {}) {
  if (!diag || typeof diag !== 'object') return [];
  if (diag.ambiguous) {
    return [subject + ' (ignoring whitespace) matches in more than one place in the file, so no location can be suggested.'
      + ' Narrow ' + subject + ' or add a scope hint or occurrence:N.'];
  }
  const range = diag.startLine === diag.endLine
    ? 'line ' + diag.startLine
    : 'lines ' + diag.startLine + '-' + diag.endLine;
  const exact = diag.differing.length === 0;
  const out = [subject + ' was not found' + scopeLabel + ' as written, but it matches '
    + (exact ? 'exactly' : '(ignoring whitespace)') + ' at ' + range
    + (diag.outsideScope ? ', outside the search scope.' : '.')];
  if (diag.outsideScope) {
    out.push('  Fix: drop the scope hint, or move it so it covers ' + range + '.');
  }
  if (!exact) {
    const d = diag.differing;
    out.push('  Whitespace (indentation or trailing) differs on ' + d.length + ' line(s):');
    for (const x of d.slice(0, max)) {
      out.push('  ' + subject + ' line ' + x.needleLine + ' reads ' + JSON.stringify(x.needleText)
        + ' but buffer line ' + x.bufferLine + ' reads ' + JSON.stringify(x.bufferText));
    }
    if (d.length > max) out.push('  ... and ' + (d.length - max) + ' more line(s).');
    out.push('  Fix: use the buffer whitespace shown above (or pass fuzzyWhitespace:true).');
  }
  return out;
}

module.exports = { diagnoseElsewhere, formatElsewhereAdvice };
