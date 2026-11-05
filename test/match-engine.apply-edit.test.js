'use strict';
// Standalone verification for match-engine.js's applyEdit() B39/B40 port.
// Mocks the minimal buffer surface applyEdit() touches: getLines(), setTextInRange(), getLineCount().

const { applyEdit } = require('../lib/match-engine.js');

function mockBuffer(lines) {
  let ls = lines.slice();
  return {
    getLines: () => ls.slice(),
    getLineCount: () => ls.length,
    setTextInRange: ([[sr, sc], [er, ec]], text) => {
      const before = ls.slice(0, sr);
      const after  = ls.slice(er);
      const inserted = text === '' ? [] : text.replace(/\n$/, '').split('\n');
      ls = [...before, ...inserted, ...after];
    },
  };
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`OK   ${name}`); }
  else      { fail++; console.log(`FAIL ${name}`); }
}

// Test 1: normal case, no drift
{
  const buf = mockBuffer(['a', 'b', 'TARGET', 'c']);
  const match = { matchLine: 2, matchEndLine: 2, actualLines: ['TARGET'] };
  const res = applyEdit(buf, match, 'REPLACED');
  check('normal case: no error', !res.error);
  check('normal case: content replaced', buf.getLines().join(',') === 'a,b,REPLACED,c');
}

// Test 2: drift, block still exists nearby -- should relocate and succeed
{
  const buf = mockBuffer(['a', 'EXTRA', 'b', 'TARGET', 'c']);
  const match = { matchLine: 2, matchEndLine: 2, actualLines: ['TARGET'] };
  const res = applyEdit(buf, match, 'REPLACED');
  check('drift case: relocated (no error)', !res.error);
  check('drift case: correct line replaced', buf.getLines().join(',') === 'a,EXTRA,b,REPLACED,c');
}

// Test 3: drift, block gone entirely -- should refuse
{
  const buf = mockBuffer(['a', 'b', 'c']);
  const match = { matchLine: 1, matchEndLine: 1, actualLines: ['TARGET'] };
  const res = applyEdit(buf, match, 'REPLACED');
  check('unrecoverable drift: error returned', res.error === 'driftUnrecoverable');
  check('unrecoverable drift: buffer untouched', buf.getLines().join(',') === 'a,b,c');
}

// Test 4: multi-line actualLines, no drift
{
  const buf = mockBuffer(['a', 'L1', 'L2', 'L3', 'b']);
  const match = { matchLine: 1, matchEndLine: 3, actualLines: ['L1', 'L2', 'L3'] };
  const res = applyEdit(buf, match, 'ONE_LINE');
  check('multi-line: no error', !res.error);
  check('multi-line: replaced correctly', buf.getLines().join(',') === 'a,ONE_LINE,b');
  check('multi-line: linesChanged correct', res.linesChanged === (1 - 3));
}

// Test 5: no actualLines provided -- verification skipped
{
  const buf = mockBuffer(['a', 'b', 'c']);
  const match = { matchLine: 1, matchEndLine: 1 };
  const res = applyEdit(buf, match, 'X');
  check('no actualLines: no error (verification skipped)', !res.error);
  check('no actualLines: write still happens', buf.getLines().join(',') === 'a,X,c');
}

// Test 6: delete (new_str = '')
{
  const buf = mockBuffer(['a', 'DELETE_ME', 'b']);
  const match = { matchLine: 1, matchEndLine: 1, actualLines: ['DELETE_ME'] };
  const res = applyEdit(buf, match, '');
  check('delete: no error', !res.error);
  check('delete: line removed', buf.getLines().join(',') === 'a,b');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
