'use strict';
// replace-across-files fixes (2026-11-05, TODO R3c and R3d), found by the first live run of the confirm path.
//   R3c: the commit edited each buffer with setTextViaDiff but never saved it, so the files stayed unsaved
//        (every other edit tool auto-saves).
//   R3d: the preview counted LINES ("2 match(es)") while the commit counted OCCURRENCES ("replaced 3"),
//        so the number changed between the two steps.
// The handler needs Pulsar's atom object, so the logic lives in lib/raf-commit.js (pure) and the handler is
// covered by source checks.   Run: node test/raf-commit.test.js
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (!cond && detail ? '\n       ' + detail : ''));
}

let mod = null;
try { mod = require('../lib/raf-commit'); } catch (e) { check('0 lib/raf-commit.js loads', false, e.message); }
const { occurrencesInLine, previewSummary, applyAndSave } = mod || {};

// 1. occurrencesInLine (R3d)
check('1a exports are functions', typeof occurrencesInLine === 'function' && typeof previewSummary === 'function' && typeof applyAndSave === 'function');
if (occurrencesInLine) {
  check('1b one occurrence', occurrencesInLine('r3b line one: r3b_alpha', 'r3b_alpha', 'g') === 1);
  check('1c two occurrences on one line', occurrencesInLine('r3b_alpha and r3b_alpha again', 'r3b_alpha', 'g') === 2);
  check('1d no occurrence', occurrencesInLine('nothing here', 'r3b_alpha', 'g') === 0);
  check('1e a flags string without g still counts every occurrence', occurrencesInLine('aaa', 'a', 'i') === 3);
  check('1f case-insensitive flag counts other cases', occurrencesInLine('Foo foo FOO', 'foo', 'gi') === 3);
  check('1g case-sensitive flag does not', occurrencesInLine('Foo foo FOO', 'foo', 'g') === 1);
  check('1h an escaped literal source is matched literally', occurrencesInLine('a.b axb a.b', 'a\\.b', 'g') === 2);
  check('1i the result is stable on repeated calls (no lastIndex carry-over)',
    occurrencesInLine('xx', 'x', 'g') === 2 && occurrencesInLine('xx', 'x', 'g') === 2);
}

// 2. previewSummary (R3d)
if (previewSummary) {
  const s1 = previewSummary({ query: 'r3b_alpha', glob: 'r3b_scratch.txt', lineCount: 2, occurrenceCount: 3, fileCount: 1 });
  check('2a the summary names the line count', s1.includes('2 line(s)'), s1);
  check('2b the summary names the occurrence count', s1.includes('3 occurrence(s)'), s1);
  check('2c the summary names the file count', s1.includes('1 file(s)'), s1);
  check('2d the summary still tells the caller how to commit', s1.includes('confirm:true'), s1);
  const s2 = previewSummary({ query: 'r3b_alpha', glob: 'r3b_scratch.txt', lineCount: 2, occurrenceCount: 2, fileCount: 1 });
  check('2e equal counts are still both shown (the number never changes between the two steps)', s2.includes('2 line(s)') && s2.includes('2 occurrence(s)'), s2);
  const s0 = previewSummary({ query: 'zzz', glob: 'src/*.c', lineCount: 0, occurrenceCount: 0, fileCount: 0 });
  check('2f the no-match wording is unchanged: No matches found for "zzz" in src/*.c.', s0 === 'No matches found for "zzz" in src/*.c.', s0);
  const s0b = previewSummary({ query: 'zzz', glob: '', lineCount: 0, occurrenceCount: 0, fileCount: 0 });
  check('2g no glob, no "in" part', s0b === 'No matches found for "zzz".', s0b);
}

// 3. applyAndSave (R3c)
function mockEditor(opts) {
  opts = opts || {};
  const calls = [];
  const buffer = {
    setTextViaDiff(t) { calls.push('set:' + t); if (opts.setThrows) throw new Error('set failed'); },
    save() { calls.push('save'); return opts.saveRejects ? Promise.reject(new Error('disk full')) : Promise.resolve(); },
  };
  return { calls, editor: { getBuffer() { return buffer; } } };
}
(async () => {
  if (applyAndSave) {
    const m1 = mockEditor();
    const r1 = await applyAndSave(m1.editor, 'NEW TEXT');
    check('3a the buffer text is set, then the buffer is saved, in that order', JSON.stringify(m1.calls) === JSON.stringify(['set:NEW TEXT', 'save']), JSON.stringify(m1.calls));
    check('3b the result says it was saved', r1 && r1.saved === true, JSON.stringify(r1));
    check('3c save is called exactly once', m1.calls.filter(c => c === 'save').length === 1);
    const m2 = mockEditor({ saveRejects: true });
    const r2 = await applyAndSave(m2.editor, 'X');
    check('3d a failing save is reported, not thrown', r2 && r2.saved === false && /disk full/.test(r2.error || ''), JSON.stringify(r2));
    check('3e the text was still set before the failed save', m2.calls[0] === 'set:X');
    const m3 = mockEditor({ setThrows: true });
    let threw = null;
    try { await applyAndSave(m3.editor, 'X'); } catch (e) { threw = e; }
    check('3f a failure while setting the text is thrown to the caller (the handler records it as skipped)', threw && /set failed/.test(threw.message));
    check('3g and nothing is saved after a failed set', !m3.calls.includes('save'), JSON.stringify(m3.calls));
  }

  // 4. source checks on the handler in lib/mcp-registration.js
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
  const iStart = src.indexOf('replace-across-files (migrated');
  const iEnd = iStart > -1 ? src.indexOf('\n  });', iStart) : -1;
  const raf = iStart > -1 && iEnd > iStart ? src.slice(iStart, iEnd) : '';
  check('4a the replace-across-files region was found', raf.length > 3000, String(raf.length));
  check('4b the file requires ./raf-commit once at the top level', /^const \{[^}]*\} = require\('\.\/raf-commit'\);/m.test(src));
  check('4c the commit loop goes through applyAndSave', /applyAndSave\(/.test(raf));
  check('4d the handler no longer calls setTextViaDiff itself (that was the unsaved path)', !/setTextViaDiff/.test(raf));
  check('4e a save that fails is reported in skipped', /saved === false|\.saved\b/.test(raf) && /not saved/.test(raf));
  check('4f the preview counts occurrences per line', /occurrencesInLine\(/.test(raf));
  check('4g the preview summary comes from previewSummary', /previewSummary\(/.test(raf));
  check('4h the preview result carries totalOccurrences', /totalOccurrences/.test(raf));
  check('4i the tool description no longer says "no direct disk writes"', !/no direct disk writes/.test(raf));
  check('4j the tool description says each file is saved after a commit', /saved/.test((raf.match(/description: \[[\s\S]*?\]\.join/) || [''])[0]));
  check('4k anchors other tests rely on are intact: the migrated comment and the removed-regex stub',
    src.includes('replace-across-files (migrated to Tool Framework)') && /regex:\s+REGEX_REMOVED_PARAM/.test(raf));
  check('4l the pending-preview guard is unchanged', raf.includes('No matching preview found to confirm'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
