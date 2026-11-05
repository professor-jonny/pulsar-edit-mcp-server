'use strict';
// ---------------------------------------------------------------------------
// patch-utils.js - helpers for the apply-patch tool that need no Pulsar (so they can be unit-tested)
// ---------------------------------------------------------------------------

// fixHunkHeaders(patch)   (moved here from the apply-patch handler and fixed, R3o, 2026-11-08)
// Auto-corrects the @@ -old,count +new,count @@ headers of a unified diff: the most common reason diff's
// applyPatch() throws is wrong line counts, so the counts are recomputed from the real hunk body and the caller
// does not have to count exactly.
//
// A hunk body runs from the line after its @@ header to the next hunk (@@), the next file header (--- / +++) or the
// END OF THE INPUT. The end of input is written (?![\s\S]). It used to be the dollar anchor, which, with the m flag
// this regex needs for its ^, matches at the end of EVERY line: the body was then only the first line, the counts came
// from that one line, and every hunk with more than one body line got a wrong header (-1,1 +1,1 for a 3-line hunk), so
// applyPatch() threw 'Unknown line' and the patch never applied directly.
//
// Counts: a line starting with + is new only, - is old only, anything else (context) is both; a line starting with a
// backslash ('\ No newline at end of file') is neither. The trailing empty piece left by split() is not a line.
function fixHunkHeaders(patch) {
  return patch.replace(
    /^(@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@[^\n]*)\n([\s\S]*?)(?=\n@@|\n---|\n\+\+\+|(?![\s\S]))/gm,
    (match, header, oldStart, newStart, body) => {
      const bodyLines = body.split('\n');
      const lines     = bodyLines[bodyLines.length - 1] === '' ? bodyLines.slice(0, -1) : bodyLines;
      const counted   = lines.filter((l) => !l.startsWith('\\'));
      const oldCount  = counted.filter((l) => !l.startsWith('+')).length;
      const newCount  = counted.filter((l) => !l.startsWith('-')).length;
      return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body}`;
    }
  );
}

module.exports = { fixHunkHeaders };
