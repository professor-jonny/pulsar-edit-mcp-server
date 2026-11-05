'use strict';
// ---------------------------------------------------------------------------
// preflight-save.js - the "save every modified buffer" step of run-command's pre-flight (R3p, 2026-11-09).
// Pure: it only needs objects with getPath(), isModified() and save(), so it is unit-tested without Pulsar
// (test/preflight-save.test.js). The handler in lib/mcp-registration.js only wires it in.
// ---------------------------------------------------------------------------

// Saves every modified editor, one by one, so the shell sees current content. A save that fails (a read-only file, a
// full disk) is recorded and the loop carries on: it used to be a bare loop, so ONE failing save threw out of the
// handler, the command never ran and the caller got a bare 'EACCES, open <path>' that did not name the buffer.
//   saved:    [filePath]                      buffers that really reached the disk
//   notSaved: [{ filePath, reason }]          buffers that are still modified; the command runs on their disk copy
// Never throws.
async function saveModifiedEditors(editors) {
  const saved = [];
  const notSaved = [];
  for (const ed of editors || []) {
    if (!ed.isModified()) continue;
    const filePath = ed.getPath();
    try {
      await ed.save();
      saved.push(filePath);
    } catch (e) {
      notSaved.push({ filePath, reason: e && e.message ? e.message : String(e) });
    }
  }
  return { saved, notSaved };
}

// The warning lines for the pre-flight summary (plain ASCII), or [] when every save worked.
function notSavedWarningLines(notSaved) {
  if (!notSaved || notSaved.length === 0) return [];
  const lines = [
    '  WARNING: ' + notSaved.length + ' modified buffer(s) could NOT be saved; the command runs on the disk copy of:',
  ];
  notSaved.forEach((f) => lines.push('    - ' + f.filePath + ' (' + f.reason + ')'));
  return lines;
}

module.exports = { saveModifiedEditors, notSavedWarningLines };
