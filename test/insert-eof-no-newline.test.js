// XW1: insert endOfFile on a file with no final newline must not join onto the last line.
const fs = require('fs'); const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL ' + n); } };
check('endOfFile checks for a last line without newline', /const _lastRow = lineCount - 1;/.test(src));
check('appends after the last line end', /buffer\.insert\(\[_lastRow, allLines\[_lastRow\]\.length\], "\\n" \+ new_str/.test(src));
console.log(`insert-eof-no-newline: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);