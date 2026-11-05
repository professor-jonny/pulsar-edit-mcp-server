'use strict';
// Helpers for the replace-across-files tool (2026-11-05, TODO R3c and R3d). Pure: no Pulsar needed, so they are
// unit-tested in test/raf-commit.test.js. The handler in lib/mcp-registration.js only wires them in.

// How many times the (already escaped) literal pattern occurs in one line. The commit step counts occurrences,
// so the preview counts them too, otherwise "2 match(es)" in the preview became "replaced 3 occurrence(s)".
function occurrencesInLine(line, source, flags) {
  const f = String(flags || '').includes('g') ? String(flags) : String(flags || '') + 'g';
  const m = String(line).match(new RegExp(source, f));
  return m ? m.length : 0;
}

// The one-line summary of the preview step. Both the line count and the occurrence count are always shown.
// The no-match wording is the one the tool always used.
function previewSummary({ query, glob, lineCount, occurrenceCount, fileCount }) {
  if (!lineCount) return 'No matches found for ' + JSON.stringify(query) + (glob ? ' in ' + glob : '') + '.';
  return 'Preview: ' + lineCount + ' line(s) with ' + occurrenceCount + ' occurrence(s) across ' + fileCount +
    ' file(s). Call again with confirm:true to commit.';
}

// Replace a buffer's text and save it, as every other edit tool does after a commit. A failure while setting the
// text is thrown (the caller records the file as skipped). A failure while saving is returned, because the buffer
// already holds the new text and the caller has to say it is unsaved.
async function applyAndSave(editor, updated) {
  const buffer = editor.getBuffer();
  buffer.setTextViaDiff(updated);
  try {
    await buffer.save();
    return { saved: true };
  } catch (e) {
    return { saved: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { occurrencesInLine, previewSummary, applyAndSave };
