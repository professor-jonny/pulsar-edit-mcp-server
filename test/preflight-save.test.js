'use strict';
// R3p (2026-11-09): one buffer that cannot be saved must not stop run-command.
//
// Bug (found in the R3l live probe): run-command's pre-flight saved every modified buffer in a bare loop,
//   for (const ed of openEditors) { if (ed.isModified()) await ed.save(); }
// so ONE failing save (the buffer of a read-only file that replace-across-files had edited after a failed save)
// threw out of the handler: the command never ran and the caller got a bare 'EACCES, open <path>' that did not say
// which buffer was the problem. savedBeforeRun also listed every modified path as saved, even one that was not.
//
// Fix: saveModifiedEditors(editors) in lib/preflight-save.js tries each save on its own, never throws, and returns
// { saved: [path], notSaved: [{ filePath, reason }] }. The handler runs the command anyway, reports savedBeforeRun
// (really saved) and notSavedBeforeRun (path and reason), prints a warning in the pre-flight summary, and does not
// reload a buffer that holds unsaved edits after the command.
//
// Run from the package root:   node test/preflight-save.test.js
// Plain Node, no Pulsar needed.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (!cond && detail ? '\n       ' + detail : ''));
}
const J = (x) => JSON.stringify(x);

let mod = null;
try { mod = require('../lib/preflight-save'); } catch (e) { check('0 lib/preflight-save.js loads', false, e.message); }
const { saveModifiedEditors, notSavedWarningLines } = mod || {};

// A mock editor: modified or not, with a save that resolves, rejects or throws synchronously.
function ed(filePath, opts) {
  opts = opts || {};
  const calls = opts.calls || [];
  return {
    getPath() { return filePath; },
    isModified() { return opts.modified !== false; },
    save() {
      calls.push('save:' + filePath);
      if (opts.throwSync) throw opts.throwSync;
      return opts.reject ? Promise.reject(opts.reject) : Promise.resolve();
    },
  };
}

(async () => {
  check('1a both helpers are exported', typeof saveModifiedEditors === 'function' && typeof notSavedWarningLines === 'function');

  if (typeof saveModifiedEditors === 'function') {
    // 2. the normal case: modified buffers are saved, unmodified ones are left alone
    const calls = [];
    const r = await saveModifiedEditors([ed('/p/a.js', { calls }), ed('/p/clean.js', { calls, modified: false }), ed('/p/b.js', { calls })]);
    check('2a modified buffers are saved, in order', J(calls) === J(['save:/p/a.js', 'save:/p/b.js']), J(calls));
    check('2b an unmodified buffer is not saved', !calls.includes('save:/p/clean.js'), J(calls));
    check('2c saved lists exactly the saved paths', J(r.saved) === J(['/p/a.js', '/p/b.js']), J(r));
    check('2d notSaved is empty', Array.isArray(r.notSaved) && r.notSaved.length === 0, J(r));

    // 3. the bug case: one save fails, the rest still run, nothing is thrown
    const calls2 = [];
    const eacces = new Error("EACCES, open '/p/ro.txt'");
    let threw = null, r2 = null;
    try { r2 = await saveModifiedEditors([ed('/p/a.js', { calls: calls2 }), ed('/p/ro.txt', { calls: calls2, reject: eacces }), ed('/p/b.js', { calls: calls2 })]); } catch (e) { threw = e; }
    check('3a a failing save does not throw out of the helper', threw === null, threw && threw.message);
    check('3b the buffers after the failing one are still saved', J(calls2) === J(['save:/p/a.js', 'save:/p/ro.txt', 'save:/p/b.js']), J(calls2));
    check('3c saved holds only the buffers that really saved', r2 && J(r2.saved) === J(['/p/a.js', '/p/b.js']), J(r2));
    check('3d notSaved names the file and carries the real reason', r2 && r2.notSaved.length === 1 && r2.notSaved[0].filePath === '/p/ro.txt' && /EACCES/.test(r2.notSaved[0].reason), J(r2));

    // 4. other failure shapes
    const r3 = await saveModifiedEditors([ed('/p/x.txt', { throwSync: new Error('disk full') })]);
    check('4a a save that throws synchronously is handled too', r3.notSaved.length === 1 && /disk full/.test(r3.notSaved[0].reason) && r3.saved.length === 0, J(r3));
    const r4 = await saveModifiedEditors([ed('/p/y.txt', { reject: 'plain string failure' })]);
    check('4b a rejection that is not an Error still gives a reason', r4.notSaved.length === 1 && r4.notSaved[0].reason === 'plain string failure', J(r4));
    const r5 = await saveModifiedEditors([ed('/p/a.js', { modified: false })]);
    check('4c nothing modified: nothing saved, nothing failed', r5.saved.length === 0 && r5.notSaved.length === 0, J(r5));
    const r6 = await saveModifiedEditors([]);
    check('4d no editors at all', r6.saved.length === 0 && r6.notSaved.length === 0, J(r6));
    const r7 = await saveModifiedEditors([ed('/p/ro1', { reject: new Error('EACCES 1') }), ed('/p/ro2', { reject: new Error('EACCES 2') })]);
    check('4e every buffer failing still returns normally, both listed', r7.saved.length === 0 && r7.notSaved.length === 2, J(r7));
  }

  if (typeof notSavedWarningLines === 'function') {
    check('5a no failures: no warning lines', J(notSavedWarningLines([])) === '[]');
    const lines = notSavedWarningLines([{ filePath: '/p/ro.txt', reason: "EACCES, open '/p/ro.txt'" }, { filePath: '/p/b.txt', reason: 'disk full' }]);
    const text = lines.join('\n');
    check('5b the warning says how many buffers were not saved', /2 modified buffer\(s\)/.test(text) && /NOT/.test(text), text);
    check('5c the warning lists each path with its reason', text.includes('/p/ro.txt') && text.includes('EACCES') && text.includes('/p/b.txt') && text.includes('disk full'), text);
    check('5d the warning says the command runs on the disk copy', /disk copy/.test(text), text);
    check('5e the warning is plain ASCII', /^[\x20-\x7e\n]+$/.test(text), text);
  }

  // 6. source checks on the run-command handler in lib/mcp-registration.js
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
  const i0 = src.indexOf('PRE-FLIGHT: checkpoint, save, warn');
  const i1 = src.indexOf('reloadedAfterRun: reloaded', i0); // the end of the result object, after the post-execution part
  const rc = i0 > -1 && i1 > i0 ? src.slice(i0, i1) : '';
  check('6a the run-command pre-flight region was found', rc.length > 2000, String(rc.length));
  check('6b the file requires saveModifiedEditors from ./preflight-save', /^const \{[^}]*\bsaveModifiedEditors\b[^}]*\} = require\('\.\/preflight-save'\);/m.test(src) && /^const \{[^}]*\bnotSavedWarningLines\b[^}]*\} = require\('\.\/preflight-save'\);/m.test(src));
  check('6c the handler saves through saveModifiedEditors(', /saveModifiedEditors\(/.test(rc));
  check('6d the bare save loop that threw is gone', !/if \(ed\.isModified\(\)\) await ed\.save\(\)/.test(rc));
  check('6e the result reports notSavedBeforeRun', /notSavedBeforeRun/.test(rc));
  check('6f savedBeforeRun no longer lists every modified path (the old modifiedPaths variable is gone)', !/modifiedPaths/.test(rc));
  check('6g the pre-flight summary gets the warning lines', /notSavedWarningLines\(/.test(rc));
  check('6h a buffer that could not be saved is not reloaded after the command', /notSaved/.test(rc.slice(rc.indexOf('POST-EXECUTION'))) , 'no notSaved check in the post-execution part');
  check('6i the checkpoint step and the mtime snapshot are still there', /checkpoints\.set\(/.test(rc) && /mtimeBefore\[/.test(rc));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
