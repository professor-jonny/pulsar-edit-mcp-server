// test/tool-hints.success-nudge.test.js - XW23: the success nudges are short, ASCII only, one line each,
// and the "no scope hint" nudge shows once per file (when the caller passes filePath).
//   1. positional-hint nudge: one line, ASCII, names the hint and carries the matched line as afterString.
//   2. no-scope-hint nudge: one line, ASCII, names inFunction / afterString / betweenHint and the line count.
//   3. no-symbol-table variant: one line, ASCII, does NOT recommend inFunction, recommends afterString.
//   4. once per file: the second identical call for the same filePath is empty; another file still gets one;
//      a caller that passes no filePath is never silenced.
//   5. gates unchanged: small file, or hints used, gives an empty string; positional needs 100+ lines.
const { successNudge } = require('../lib/tool-hints');

let bad = 0, pass = 0;
function ok(name, cond) { if (cond) pass++; else { bad++; console.log('FAIL ' + name); } }
const ascii = s => /^[\x00-\x7f]*$/.test(s);
const oneLine = s => s.replace(/^\n/, '').indexOf('\n') === -1;

// 1. positional hint
const p = successNudge({ toolName: 'insert', noHintsUsed: true, afterLineOnly: true, positionalHintName: 'afterLine',
  matchedLineContent: '  const x = 1;', fileLines: 500, isCodeFile: true, symbols: [{ name: 'f' }], filePath: 'a.js' });
ok('1 positional is ASCII', ascii(p));
ok('1 positional is one line', oneLine(p) && p.length > 0);
ok('1 positional names the hint', /afterLine/.test(p) && /positional/.test(p));
ok('1 positional carries the anchor', p.includes('afterString:"const x = 1;"'));
ok('1 positional is short', p.length < 140);
const p2 = successNudge({ toolName: 'insert', noHintsUsed: true, positionalHintName: 'afterLine',
  matchedLineContent: '  const x = 1;', fileLines: 500, isCodeFile: true, symbols: [{ name: 'f' }], filePath: 'a.js' });
ok('1 positional is NOT silenced on repeat (its anchor is specific)', p2 === p);

// 2. no scope hint
const base = { toolName: 'replace', noHintsUsed: true, fileLines: 640, isCodeFile: true, symbols: [{ name: 'f' }], matchedLineContent: 'foo();' };
const n = successNudge({ ...base, filePath: 'b.js' });
ok('2 no-scope is ASCII', ascii(n));
ok('2 no-scope is one line', oneLine(n) && n.length > 0);
ok('2 no-scope says the line count', n.includes('640'));
ok('2 no-scope names the three hints', /inFunction/.test(n) && /afterString/.test(n) && /betweenHint/.test(n));
ok('2 no-scope is short', n.length < 120);

// 3. no symbol table
const ns = successNudge({ ...base, symbols: [], filePath: 'c.txt' });
ok('3 no-symbols is ASCII', ascii(ns));
ok('3 no-symbols is one line', oneLine(ns) && ns.length > 0);
ok('3 no-symbols recommends afterString', /afterString/.test(ns));
ok('3 no-symbols does not recommend inFunction', !/inFunction/.test(ns));
ok('3 no-symbols carries the anchor', ns.includes('afterString:"foo();"'));

// 4. once per file
const d1 = successNudge({ ...base, filePath: 'once-d.js' });
const d2 = successNudge({ ...base, filePath: 'once-d.js' });
const e1 = successNudge({ ...base, filePath: 'once-e.js' });
ok('4 first call for a file gives a nudge', d1.length > 0);
ok('4 second call for the same file is empty', d2 === '');
ok('4 another file still gets one', e1.length > 0);
const f1 = successNudge({ ...base });
const f2 = successNudge({ ...base });
ok('4 no filePath: never silenced', f1.length > 0 && f2 === f1);

// 5. gates
ok('5 small file is empty', successNudge({ ...base, fileLines: 120, filePath: 'g.js' }) === '');
ok('5 hints used is empty', successNudge({ ...base, noHintsUsed: false, filePath: 'h.js' }) === '');
ok('5 positional below 100 lines falls through to the 300-line gate',
  successNudge({ toolName: 'insert', noHintsUsed: true, positionalHintName: 'afterLine', matchedLineContent: 'x', fileLines: 50, filePath: 'i.js' }) === '');

// 6. every direct successNudge call site in mcp-registration.js passes filePath. The live probe of 2026-11-18 showed
// replace repeating the nudge because its own call site did not (only the framework path passed it).
const fs = require('fs');
const path = require('path');
const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
function siteReport(src) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf('successNudge({', i)) !== -1) {
    const end = src.indexOf('});', i);
    out.push(src.slice(i, end).includes('filePath: ctx.filePath'));
    i = end;
  }
  return out;
}
const sites = siteReport(reg);
ok('6 found the successNudge call sites in mcp-registration.js', sites.length >= 3);
ok('6 every call site passes filePath', sites.every(Boolean));
const stripped = siteReport(reg.split('filePath: ctx.filePath, // XW23: once-per-file "no scope hint" nudge').join(''));
ok('6 negative control: with the filePath lines removed the check fails', stripped.length === sites.length && !stripped.every(Boolean));

console.log(pass + ' passed, ' + bad + ' failed');
process.exitCode = bad ? 1 : 0;
