// Regression test for buildReplacePreview (S4d, 2026-09-23).
// Promoted from a one-off manual probe after a live restart confirmed the
// output against the real module (see session notes). Not a negative-control
// suite yet (no deliberate-break check, unlike S4b's fragment-match test) --
// worth adding if this function gets more callers.

const engine = require('../lib/match-engine.js');
const { buildReplacePreview } = engine;

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { console.log('PASS', name); passed++; }
  else { console.log('FAIL', name); failed++; }
}

if (typeof buildReplacePreview !== 'function') {
  console.log('FAIL: buildReplacePreview not exported as a function, got:', typeof buildReplacePreview);
  process.exit(1);
}

const allLines = [
  'function alpha() {',
  '  const x = 1;',
  '  return x;',
  '}',
  '',
  'function beta() {',
  '  const y = 2;',
  '  return y;',
  '}',
];

const result = buildReplacePreview({
  allLines,
  lineCount: allLines.length,
  matchLine: 6,
  matchLines: ['  const y = 2;'],
  new_str: '  const y = 99;',
  scopeLabel: ' within function "beta"',
  tags: ['fuzzyWhitespace'],
});

check('returns matched:true', result.matched === true);
check('returns dryRun:true', result.dryRun === true);
check('matchLine is 1-based (7)', result.matchLine === 7);
check('content is one text block', Array.isArray(result.content) && result.content.length === 1 && result.content[0].type === 'text');

const text = result.content[0].text;

check('header names the 1-based match line', text.includes('match found at line 7'));
check('header includes scopeLabel verbatim', text.includes('within function "beta"'));
check('header includes the tag as [fuzzyWhitespace]', text.includes('[fuzzyWhitespace]'));
check('diff has a "- " line for the old content', text.includes('- ' + '  const y = 2;'));
check('diff has a "+ " line for the new content', text.includes('+ ' + '  const y = 99;'));
check('offers dryRun:false to commit', text.toLowerCase().includes('dryrun') && text.toLowerCase().includes('false'));
check('does NOT mention commitLastPreview', !text.includes('commitLastPreview'));

const result2 = buildReplacePreview({
  allLines,
  lineCount: allLines.length,
  matchLine: 1,
  matchLines: ['  const x = 1;', '  return x;'],
  new_str: '  const x = 42;\n  return x * 2;',
  scopeLabel: '',
  tags: [],
});
const text2 = result2.content[0].text;
check('multi-line: matchLine 1-based (2)', result2.matchLine === 2);
check('multi-line: both old lines as "- "', text2.includes('- ' + '  const x = 1;') && text2.includes('- ' + '  return x;'));
check('multi-line: both new lines as "+ "', text2.includes('+ ' + '  const x = 42;') && text2.includes('+ ' + '  return x * 2;'));
check('multi-line: no stray "undefined" from empty scopeLabel', !text2.includes('undefined'));
check('multi-line: no stray "[]" from empty tags', !text2.includes('[]'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
