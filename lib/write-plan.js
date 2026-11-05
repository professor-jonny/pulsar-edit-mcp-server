'use strict';
// write-file (2026-11-18): the decision that replaces create-file's "refuse if it exists" and replace-document's "overwrite".
// planWrite({ exists, overwrite }) -> 'create' | 'overwrite' | 'refuse'. overwrite must be exactly true.
function planWrite({ exists, overwrite } = {}) {
  if (!exists) return 'create';
  return overwrite === true ? 'overwrite' : 'refuse';
}

function refuseExistingMessage(filePath) {
  return `write-file refused: ${filePath} already exists. Pass overwrite:true to replace its whole content (undo still works in the editor), or use replace / insert to change part of it. Nothing was written.`;
}

module.exports = { planWrite, refuseExistingMessage };
