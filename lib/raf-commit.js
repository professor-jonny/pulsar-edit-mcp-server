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
async function applyAndSave(editor, updated, onSaved) {
  const buffer = editor.getBuffer();
  buffer.setTextViaDiff(updated);
  try {
    await buffer.save();
  } catch (e) {
    return { saved: false, error: e && e.message ? e.message : String(e) };
  }
  // R3j (2026-11-06): let the caller refresh the server's known-mtime record for this file now that our own save has
  // changed it, so the next read does not report that save as an external change (false STALE warning). The callback
  // is best effort: a failure in it never turns a good save into a failed one.
  if (typeof onSaved === 'function') {
    try { onSaved(typeof buffer.getPath === 'function' ? buffer.getPath() : undefined); } catch (_) { /* ignore */ }
  }
  return { saved: true };
}

// The result of the confirm:true step (R3l, 2026-11-09). The handler collects three lists and this builds the result:
//   saved     [{ filePath, replacements }]          files whose new text is on disk
//   notSaved  [{ filePath, replacements, reason }]  files that were edited but NOT written (a save that failed, or a write
//                                                   that threw); the buffer may still hold the edit
//   skipped   [{ filePath, reason }]                everything that was not done cleanly, as the tool always reported it
//                                                   (a file that could not be read, plus the notSaved reasons)
//   staleFiles [filePath]                           files whose disk copy changed outside the server (passed through)
// A file counts as affected only when it was SAVED: filesAffected, totalReplacements and files (kept for older callers;
// the same list as filesSaved) describe what is on disk. It used to push every file onto the success list BEFORE the save,
// so a failed save still read as "Committed - replaced N occurrence(s) across M file(s)". Warnings are plain ASCII.
function commitResult({ saved = [], notSaved = [], skipped = [], staleFiles = [] } = {}) {
  const sum = (list) => list.reduce((n, f) => n + (f.replacements || 0), 0);
  const savedReps = sum(saved);
  const unsavedReps = sum(notSaved);
  const tail = ' A buffer may still hold the edit: save it by hand or undo before closing it.';
  let summary;
  if (notSaved.length === 0) {
    summary = '\u2705 Committed \u2014 replaced ' + savedReps + ' occurrence(s) across ' + saved.length + ' file(s).';
  } else if (saved.length === 0) {
    summary = 'WARNING: NOT SAVED - no file was written to disk. ' + unsavedReps + ' occurrence(s) in ' + notSaved.length +
      ' file(s) were edited but not saved: see filesNotSaved for each reason.' + tail;
  } else {
    summary = 'WARNING: PARTLY SAVED - replaced ' + savedReps + ' occurrence(s) across ' + saved.length + ' file(s) on disk, but ' +
      notSaved.length + ' file(s) (' + unsavedReps + ' occurrence(s)) were edited and NOT saved: see filesNotSaved for each reason.' + tail;
  }
  return {
    summary,
    totalReplacements: savedReps,
    filesAffected: saved.length,
    files: saved,
    filesSaved: saved,
    filesNotSaved: notSaved.length > 0 ? notSaved : undefined,
    skipped: skipped.length > 0 ? skipped : undefined,
    staleFiles: staleFiles.length > 0 ? staleFiles : undefined,
  };
}

module.exports = { occurrencesInLine, previewSummary, applyAndSave, commitResult };
