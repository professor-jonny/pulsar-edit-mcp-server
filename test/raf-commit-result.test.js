'use strict';
// R3l (2026-11-09): replace-across-files must not report success when a save failed.
//
// Bug (found 2026-11-06 in the failed-save probe, a read-only scratch file): the confirm:true result said
// "Committed - replaced 1 occurrence(s) across 1 file(s)" with filesAffected 1 and totalReplacements 1, and only the
// skipped array said "edited in the buffer but not saved: EACCES". The handler pushed a file onto its 'committed' list
// BEFORE the save, so a file that was never written to disk was counted as a success.
//
// Fix: commitResult() in lib/raf-commit.js builds the result from three lists the handler collects: saved (the new
// text is on disk), notSaved (edited, but NOT written, with the reason) and skipped (as before). filesAffected,
// totalReplacements and files now count SAVED files only; filesSaved and filesNotSaved are new; the summary starts with
// WARNING: NOT SAVED (nothing written) or WARNING: PARTLY SAVED (some written). A clean commit keeps its old message.
//
// Run from the package root:   node test/raf-commit-result.test.js
// Plain Node, no Pulsar needed.

const fs = require('fs');
const path = require('path');
const mod = require('../lib/raf-commit');
const { commitResult, applyAndSave } = mod;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (!cond && detail ? '\n       ' + detail : ''));
}
const J = (x) => JSON.stringify(x);

check('0 commitResult is exported', typeof commitResult === 'function');

if (typeof commitResult === 'function') {
  // 1. everything saved: the old message, the old numbers
  const ok = commitResult({ saved: [{ filePath: '/p/a.txt', replacements: 2 }, { filePath: '/p/b.txt', replacements: 1 }] });
  check('1a clean commit keeps the old summary wording',
    ok.summary === '\u2705 Committed \u2014 replaced 3 occurrence(s) across 2 file(s).', ok.summary);
  check('1b clean commit: totals count the saved files', ok.totalReplacements === 3 && ok.filesAffected === 2, J(ok));
  check('1c clean commit: files and filesSaved list the saved files', J(ok.files) === J(ok.filesSaved) && ok.filesSaved.length === 2, J(ok));
  check('1d clean commit: no filesNotSaved, no skipped, no staleFiles keys with content',
    ok.filesNotSaved === undefined && ok.skipped === undefined && ok.staleFiles === undefined, J(ok));

  // 2. nothing saved: the bug case (one read-only file)
  const none = commitResult({
    saved: [],
    notSaved: [{ filePath: '/p/ro.txt', replacements: 1, reason: 'edited in the buffer but not saved: EACCES: permission denied' }],
    skipped: [{ filePath: '/p/ro.txt', reason: 'edited in the buffer but not saved: EACCES: permission denied' }],
  });
  check('2a NOT SAVED: the summary starts with WARNING: NOT SAVED', none.summary.startsWith('WARNING: NOT SAVED'), none.summary);
  check('2b NOT SAVED: the summary does not say Committed', !/Committed/.test(none.summary), none.summary);
  check('2c NOT SAVED: the summary is plain ASCII', /^[\x20-\x7e]+$/.test(none.summary), none.summary);
  check('2d NOT SAVED: filesAffected and totalReplacements are 0 (nothing is on disk)', none.filesAffected === 0 && none.totalReplacements === 0, J(none));
  check('2e NOT SAVED: filesNotSaved names the file, its replacements and the reason',
    none.filesNotSaved && none.filesNotSaved.length === 1 && none.filesNotSaved[0].filePath === '/p/ro.txt' &&
    none.filesNotSaved[0].replacements === 1 && /EACCES/.test(none.filesNotSaved[0].reason), J(none));
  check('2f NOT SAVED: filesSaved is an empty list, files too', Array.isArray(none.filesSaved) && none.filesSaved.length === 0 && none.files.length === 0, J(none));
  check('2g NOT SAVED: skipped is still carried unchanged', none.skipped && none.skipped.length === 1, J(none));
  check('2h NOT SAVED: the summary mentions the unsaved occurrence and file counts', /1 occurrence\(s\) in 1 file\(s\)/.test(none.summary), none.summary);

  // 3. partly saved
  const part = commitResult({
    saved: [{ filePath: '/p/a.txt', replacements: 2 }],
    notSaved: [{ filePath: '/p/ro.txt', replacements: 3, reason: 'edited in the buffer but not saved: EACCES' }],
    skipped: [{ filePath: '/p/ro.txt', reason: 'edited in the buffer but not saved: EACCES' }],
  });
  check('3a PARTLY SAVED: the summary starts with WARNING: PARTLY SAVED', part.summary.startsWith('WARNING: PARTLY SAVED'), part.summary);
  check('3b PARTLY SAVED: totals count only the saved file', part.totalReplacements === 2 && part.filesAffected === 1, J(part));
  check('3c PARTLY SAVED: the summary names both counts', /2 occurrence\(s\) across 1 file\(s\)/.test(part.summary) && /1 file\(s\) \(3 occurrence\(s\)\)/.test(part.summary), part.summary);
  check('3d PARTLY SAVED: the summary is plain ASCII', /^[\x20-\x7e]+$/.test(part.summary), part.summary);
  check('3e PARTLY SAVED: filesSaved and filesNotSaved each hold their own file',
    part.filesSaved.length === 1 && part.filesSaved[0].filePath === '/p/a.txt' && part.filesNotSaved.length === 1 && part.filesNotSaved[0].filePath === '/p/ro.txt', J(part));

  // 4. a write that threw is not saved either
  const thrown = commitResult({
    saved: [],
    notSaved: [{ filePath: '/p/x.txt', replacements: 1, reason: 'write failed: set failed' }],
    skipped: [{ filePath: '/p/x.txt', reason: 'write failed: set failed' }],
  });
  check('4a a write that threw is reported as NOT SAVED too', thrown.summary.startsWith('WARNING: NOT SAVED') && thrown.filesNotSaved[0].reason === 'write failed: set failed', J(thrown));

  // 5. a file that could not even be READ is skipped, not unsaved: the rest of the commit is still a clean success
  const readFail = commitResult({
    saved: [{ filePath: '/p/a.txt', replacements: 1 }],
    skipped: [{ filePath: '/p/gone.txt', reason: 'ENOENT: no such file' }],
  });
  check('5a an unreadable file only appears in skipped; the commit is still a clean success',
    readFail.summary.startsWith('\u2705 Committed') && readFail.filesNotSaved === undefined && readFail.skipped.length === 1, J(readFail));

  // 6. pass-through fields
  const stale = commitResult({ saved: [{ filePath: '/p/a.txt', replacements: 1 }], staleFiles: ['/p/a.txt'] });
  check('6a staleFiles is passed through', J(stale.staleFiles) === J(['/p/a.txt']), J(stale));
  check('6b nothing matched at all keeps the old wording with zeros',
    commitResult({}).summary === '\u2705 Committed \u2014 replaced 0 occurrence(s) across 0 file(s).', commitResult({}).summary);
  const big = commitResult({ saved: [{ filePath: '/p/a', replacements: 1 }], notSaved: [{ filePath: '/p/b', replacements: 1, reason: 'r' }] });
  check('6c the result serialises to JSON without losing the new fields', /filesNotSaved/.test(JSON.stringify(big)) && /filesSaved/.test(JSON.stringify(big)));
}

(async () => {
  // 7. end to end with the real applyAndSave and mock editors: one good file, one whose save rejects
  function mockEditor(saveRejects) {
    const buffer = { setTextViaDiff() {}, save() { return saveRejects ? Promise.reject(new Error('EACCES: permission denied')) : Promise.resolve(); }, getPath() { return '/p/f'; } };
    return { getBuffer() { return buffer; } };
  }
  if (typeof commitResult === 'function' && typeof applyAndSave === 'function') {
    const saved = [], notSaved = [], skipped = [];
    for (const [filePath, rejects, count] of [['/p/good.txt', false, 2], ['/p/ro.txt', true, 1]]) {
      const r = await applyAndSave(mockEditor(rejects), 'T');
      if (r.saved) saved.push({ filePath, replacements: count });
      else {
        const reason = 'edited in the buffer but not saved: ' + r.error;
        notSaved.push({ filePath, replacements: count, reason });
        skipped.push({ filePath, reason });
      }
    }
    const res = commitResult({ saved, notSaved, skipped });
    check('7a end to end: one good save and one failed save give PARTLY SAVED', res.summary.startsWith('WARNING: PARTLY SAVED'), res.summary);
    check('7b end to end: only the good file is counted as affected', res.filesAffected === 1 && res.totalReplacements === 2, J(res));
    check('7c end to end: the failed file carries its real error text', /EACCES/.test(res.filesNotSaved[0].reason), J(res));
  }

  // 8. source checks on the handler in lib/mcp-registration.js
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
  const iStart = src.indexOf('replace-across-files (migrated');
  const iEnd = iStart > -1 ? src.indexOf('\n  });', iStart) : -1;
  const raf = iStart > -1 && iEnd > iStart ? src.slice(iStart, iEnd) : '';
  check('8a the replace-across-files region was found', raf.length > 3000, String(raf.length));
  check('8b the file requires commitResult from ./raf-commit', /^const \{[^}]*\bcommitResult\b[^}]*\} = require\('\.\/raf-commit'\);/m.test(src));
  check('8c the handler builds its result with commitResult(', /commitResult\(/.test(raf));
  check('8d the handler collects notSaved entries', /notSaved\.push\(/.test(raf));
  check('8e the handler collects saved entries only after a good save', /saved\.push\(/.test(raf) && !/committed\.push\(/.test(raf));
  check('8f the old success-before-save list is gone', !/\bcommitted\b/.test(raf.slice(raf.indexOf('if (committing)'))));
  check('8g a commit where nothing was saved does not count as a hit', /notSaved\.length\s*>\s*0\s*&&\s*saved\.length\s*===\s*0/.test(raf));
  check('8h the reason text of a failed save still says not saved', /edited in the buffer but not saved/.test(raf));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
