'use strict';
// 2026-11-18: paging for `read` when no anchor is given (replaces read-file, which paged in 2000-line chunks with an offset).
// Pure: wholeFilePage(lineCount, startLine, chunk) -> { sliceStart, sliceEnd, note, more } or { error }.
// sliceStart/sliceEnd are 0-based row numbers, inclusive. startLine (1-based) is where to start; omitted = line 1.
const PAGE_LINES = 2000;

function wholeFilePage(lineCount, startLine, chunk = PAGE_LINES) {
  const from = startLine === undefined || startLine === null ? 0 : startLine - 1;
  if (from < 0) return { error: 'startLine must be >= 1.' };
  if (from >= lineCount) return { error: `startLine (${startLine}) exceeds file line count (${lineCount}).` };
  const to = Math.min(lineCount - 1, from + chunk - 1);
  const more = to < lineCount - 1;
  let note = '';
  if (lineCount > chunk || from > 0) {
    note = `Whole file in pages of ${chunk} lines: showing lines ${from + 1}-${to + 1} of ${lineCount}.` +
      (more ? ` Call read again with startLine:${to + 2} for the next part.` : ' This is the last part.');
  }
  return { sliceStart: from, sliceEnd: to, note, more };
}

module.exports = { PAGE_LINES, wholeFilePage };
