// Tests for lib/str-replace-preview.js: buildDryRunResult against the REAL
// lib/match-engine.js buildReplacePreview. Run: node test/str-replace-preview.test.js
const { buildDryRunResult } = require('../lib/str-replace-preview.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; } else { fail++; console.log('FAIL:', name); }
}

const allLines = ['function beta() {', '  const count = 2;', '  return count;', '}'];

// -- single-line replace, no tags --
{
  const r = buildDryRunResult({
    allLines, lineCount: allLines.length, matchLine: 1, matchLines: ['  const count = 2;'],
    new_str: '  const total = 2;', scopeLabel: ' within function "beta"',
  });
  const t = r.content[0].text;
  check('uses new ❯ marker (Section 1 byte-change, user confirmed OK)', t.includes('❯'));
  check('uses new 🔍 DRY RUN header', t.includes('🔍 DRY RUN'));
  check('shows match line context', t.includes('within function "beta"'));
  check('shows the diff', t.includes('const count') && t.includes('const total'));
  check('includes commit trailer (not double-appended)', (t.match(/without dryRun/g) || []).length === 1);
}

// -- tags: occurrence, fuzzyWhitespace, fuzzyContent --
{
  const r = buildDryRunResult({
    allLines, lineCount: allLines.length, matchLine: 2, matchLines: ['  return count;'],
    new_str: '  return total;', scopeLabel: '',
    occurrence: 2, fuzzyWhitespace: true, fuzzyContent: true,
  });
  const t = r.content[0].text;
  check('tags: occurrence shown', t.includes('occurrence 2'));
  check('tags: fuzzyWhitespace shown', t.includes('fuzzyWhitespace'));
  check('tags: fuzzyContent shown', t.includes('fuzzyContent'));
}

// -- occurrence 1 (default) does NOT show an occurrence tag --
{
  const r = buildDryRunResult({
    allLines, lineCount: allLines.length, matchLine: 1, matchLines: ['  const count = 2;'],
    new_str: '  const total = 2;', scopeLabel: '',
  });
  check('default occurrence 1: no occurrence tag shown', !r.content[0].text.includes('occurrence'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
