// Tests for lib/sed-tool.js (R4d): the pure half of the `sed` MCP tool, plus source guards that
// the handler in lib/mcp-registration.js is wired to it. Run: node test/sed-tool.test.js
// No Pulsar and no real sed are needed; the expected outputs are GNU sed 4.9 behaviour that
// test/sed-run.test.js already pins against recorded real-sed results.
const fs = require('fs');
const path = require('path');
const { runSed, diffLines, buildSedPreview, myersDiff } = require('../lib/sed-tool.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; } else { fail++; console.log('FAIL:', name); }
}
function out(expression, text, extra) {
  const r = runSed(Object.assign({ expression, text }, extra || {}));
  return r.ok ? r.output : ('ERR:' + r.kind + ':' + r.message);
}

// ---- 1. runSed: plain scripts (basic regex by default, like sed) -------------------------------
check('1a s///g', out('s/a/X/g', 'abc\nbar\nbaz\n') === 'Xbc\nbXr\nbXz\n');
check('1b BRE: ( is a literal paren', out('s/(a)/X/', '(a)\nb\n') === 'X\nb\n');
check('1c BRE: \\(a\\) is a group and \\1 a back-reference', out('s/\\(a\\)b/\\1\\1/', 'abc\n') === 'aac\n');
check('1d y command', out('y/abc/xyz/', 'aabbcc\n') === 'xxyyzz\n');
check('1e a command (one-liner form)', out('1a hello', 'a\nb\n') === 'a\nhello\nb\n');
check('1f missing final newline is kept', out('s/a/X/', 'a') === 'X');
check('1g CR is an ordinary character (CRLF file)', out('s/b/X/', 'a\r\nb\r\n') === 'a\r\nX\r\n');
check('1h CR means $ does not match before CRLF', out('s/a$/X/', 'a\r\n') === 'a\r\n');
check('1i #n first line is silent like sed -n', out('#n\n2p', 'a\nb\nc\n') === 'b\n');
check('1j a silent script that never prints empties the file (sed -n -i)', out('#n\n/zzz/p', 'a\nb\n') === '');
check('1k s///2 replaces the 2nd match only', out('s/a/X/2', 'aaa\n') === 'aXa\n');
check('1l no match leaves the text unchanged', out('s/zzz/X/', 'a\nb\n') === 'a\nb\n');

// ---- 2. extended regexes (-E) --------------------------------------------------------------------
check('2a extended:true uses ERE groups', out('s/(a|b)+/Y/', 'abab\n', { extended: true }) === 'Y\n');
check('2b without extended the same script is not an ERE', out('s/(a|b)+/Y/', 'abab\n') === 'abab\n');
check('2c extended:false is the default', out('s/a+/X/', 'aa\n') === 'aa\n' && out('s/a+/X/', 'aa\n', { extended: true }) === 'X\n');

// ---- 3. scope (the resolved hint region, 1-based inclusive) --------------------------------------
check('3a scope limits s///g to its lines', out('s/a/X/g', 'abc\nbar\nbaz\n', { scope: { from: 2, to: 2 } }) === 'abc\nbXr\nbaz\n');
check('3b no scope = whole file', out('s/a/X/g', 'abc\nbar\nbaz\n', { scope: null }) === 'Xbc\nbXr\nbXz\n');
check('3c line numbers keep their whole-file meaning inside a scope', out('2d', 'a\nb\nc\n', { scope: { from: 2, to: 3 } }) === 'a\nc\n');
check('3d a line number outside the scope does nothing', out('1d', 'a\nb\nc\n', { scope: { from: 2, to: 3 } }) === 'a\nb\nc\n');
check('3e $ keeps its whole-file meaning (the last line is outside this scope)', out('$d', 'a\nb\nc\n', { scope: { from: 1, to: 2 } }) === 'a\nb\nc\n');
check('3f $ inside a scope that reaches the end', out('$d', 'a\nb\nc\n', { scope: { from: 2, to: 3 } }) === 'a\nb\n');
check('3g scoped delete of a regex range stays inside the scope', out('/b/,/c/d', 'b\nc\nb\nc\n', { scope: { from: 3, to: 4 } }) === 'b\nc\n');

// ---- 4. q / Q exit status ------------------------------------------------------------------------
{
  const r = runSed({ expression: '2q5', text: 'a\nb\nc\n' });
  check('4a 2q5: ok, output stops after line 2 (like sed -i)', r.ok && r.output === 'a\nb\n');
  check('4b 2q5: exit status 5 reported', r.ok && r.exitCode === 5 && r.quit === true);
  const r2 = runSed({ expression: 's/a/X/', text: 'a\n' });
  check('4c a normal run has exit status 0 and no quit', r2.ok && r2.exitCode === 0 && r2.quit === false);
}

// ---- 5. errors: sed's own wording, kind parse / run -----------------------------------------------
{
  const r = runSed({ expression: 's/a/b', text: 'x\n' });
  check('5a unterminated s: not ok, kind parse', !r.ok && r.kind === 'parse');
  check('5b unterminated s: sed message with position', !r.ok && r.message === "-e expression #1, char 5: unterminated `s' command");
  check('5c unterminated s: char is reported', !r.ok && r.char === 5);
  const w = runSed({ expression: 'w out.txt', text: 'x\n' });
  check('5d w is refused (sandbox)', !w.ok && w.kind === 'parse' && /sandbox/.test(w.message));
  const e = runSed({ expression: 'e', text: 'x\n' });
  check('5e e is refused (sandbox)', !e.ok && e.kind === 'parse');
  const s = runSed({ expression: 's/a/b/w out.txt', text: 'x\n' });
  check('5f the s flag w is refused (sandbox)', !s.ok && s.kind === 'parse');
  const g = runSed({ expression: 's/\\(a/x/', text: 'a\n' });
  check('5g unmatched group: parse error with the regex message', !g.ok && g.kind === 'parse' && g.message.indexOf('Unmatched ( or \\(') !== -1);
  const n = runSed({ expression: 's//x/', text: 'a\n' });
  check('5h empty regex with no previous regex is a RUN error', !n.ok && n.kind === 'run' && /no previous regular expression/.test(n.message));
  check('5i run error carries exit status 1', !n.ok && n.exitCode === 1);
  const z = runSed({ expression: '', text: 'a\n' });
  check('5j an empty script is allowed and changes nothing', z.ok && z.output === 'a\n');
}

// ---- 6. diffLines ----------------------------------------------------------------------------------
{
  const same = diffLines(['a', 'b'], ['a', 'b']);
  check('6a identical: nothing removed or added', same.removed.length === 0 && same.added.length === 0);
  const ch = diffLines(['a', 'b', 'c'], ['a', 'B', 'c']);
  check('6b one changed line: removed row 2', ch.removed.length === 1 && ch.removed[0].row === 2 && ch.removed[0].text === 'b');
  check('6c one changed line: added row 2', ch.added.length === 1 && ch.added[0].row === 2 && ch.added[0].text === 'B');
  const ins = diffLines(['a', 'c'], ['a', 'b', 'c']);
  check('6d inserted line: only added, at its NEW row', ins.removed.length === 0 && ins.added.length === 1 && ins.added[0].row === 2 && ins.added[0].text === 'b');
  const del = diffLines(['a', 'b', 'c'], ['a', 'c']);
  check('6e deleted line: only removed, at its OLD row', del.added.length === 0 && del.removed.length === 1 && del.removed[0].row === 2);
  const lcs = diffLines(['x', 'a', 'y', 'b', 'z'], ['a', 'b']);
  check('6f LCS keeps the common lines (3 removed, 0 added)', lcs.removed.length === 3 && lcs.added.length === 0);
  check('6g LCS removed rows are the old rows 1, 3, 5', lcs.removed.map(r => r.row).join(',') === '1,3,5');
  const emptyNew = diffLines(['a', 'b'], ['']);
  check('6h everything replaced by an empty line', emptyNew.removed.length === 2 && emptyNew.added.length === 1);
  const big1 = [], big2 = [];
  for (let i = 0; i < 2100; i++) { big1.push('o' + i); big2.push('n' + i); }
  const big = diffLines(big1, big2);
  check('6i very large disjoint blocks use the fallback and stay correct', big.removed.length === 2100 && big.added.length === 2100 && big.removed[0].row === 1 && big.added[2099].row === 2100);
  // ---- R4i (2026-10-31): a few real edits far apart in a big file must be reported as exactly those
  // edits. Before the Myers diff, two edits more than about 2,000 rows apart made the middle block
  // bigger than the LCS limit and the whole middle was reported as changed (4 edits on rows 2572 to
  // 4759 gave 2188 removed and 2188 added; edits on rows 316 and 4753 gave 4438).
  const bigOld = [];
  for (let i = 1; i <= 7500; i++) bigOld.push('line ' + i + ' of the big file');
  const rows4 = [2572, 2759, 3725, 4759];
  const bigNew4 = bigOld.slice();
  for (const r of rows4) bigNew4[r - 1] += ' EDITED';
  const d4 = diffLines(bigOld, bigNew4);
  check('6j 4 real edits 2,200 rows apart: exactly 4 removed and 4 added (was 2188 and 2188)', d4.removed.length === 4 && d4.added.length === 4);
  check('6k those 4 edits are reported at rows 2572, 2759, 3725 and 4759', d4.removed.map(r => r.row).join(',') === rows4.join(',') && d4.added.map(r => r.row).join(',') === rows4.join(',') && d4.added[0].text === 'line 2572 of the big file EDITED');
  const bigNew2 = bigOld.slice();
  bigNew2[315] += ' X';
  bigNew2[4752] += ' Y';
  const d2 = diffLines(bigOld, bigNew2);
  check('6l 2 real edits on rows 316 and 4753: exactly 2 removed and 2 added (was 4438)', d2.removed.length === 2 && d2.added.length === 2 && d2.removed[1].row === 4753);
  const bigNewDel = bigOld.slice();
  bigNewDel.splice(1000, 78);
  bigNewDel[6000] += ' Z';
  bigNewDel.splice(3000, 0, 'NEW A', 'NEW B');
  const d3 = diffLines(bigOld, bigNewDel);
  check('6m a 78-line deletion, one far edit and 2 inserted lines: 79 removed and 3 added', d3.removed.length === 79 && d3.added.length === 3);
  check('6n the deleted block is old rows 1001 to 1078 and the edited line is old row 6079', d3.removed.slice(0, 78).every((r, i) => r.row === 1001 + i) && d3.removed[78].row === 6079);
  check('6o the inserted lines are reported as added, with their text', d3.added.some(r => r.text === 'NEW A') && d3.added.some(r => r.text === 'NEW B'));
  const pv = buildSedPreview(bigOld.join('\n') + '\n', bigNew4.join('\n') + '\n');
  check('6p buildSedPreview on the big file: counts 4 and 4, 8 lines, no "more changed" summary', pv.removedCount === 4 && pv.addedCount === 4 && pv.text.split('\n').length === 8 && !/more changed/.test(pv.text));
  // myersDiff itself: a valid edit script (the kept lines are equal) and a minimal one (same distance
  // as the LCS), on 2,000 random pairs; a small alphabet makes plenty of repeated lines
  let seed = 20261031;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const lcsLen = (x, y) => {
    const t = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    return t[0][0];
  };
  let badRandom = 0;
  for (let it = 0; it < 2000; it++) {
    const alpha = 1 + rnd(5);
    const x = Array.from({ length: rnd(40) }, () => String.fromCharCode(97 + rnd(alpha)));
    const y = Array.from({ length: rnd(40) }, () => String.fromCharCode(97 + rnd(alpha)));
    const r = myersDiff(x, y);
    if (!r) { badRandom++; continue; }
    const rs = new Set(r.removedIdx);
    const as = new Set(r.addedIdx);
    const keptX = x.filter((_, i) => !rs.has(i)).join('');
    const keptY = y.filter((_, j) => !as.has(j)).join('');
    if (keptX !== keptY || r.removedIdx.length + r.addedIdx.length !== x.length + y.length - 2 * lcsLen(x, y)) badRandom++;
  }
  check('6q 2,000 random pairs: the Myers result is a valid and minimal edit script', badRandom === 0);
  check('6r over the distance limit it returns null, so the caller falls back', myersDiff(['a', 'b', 'c', 'd'], ['w', 'x', 'y', 'z'], 3) === null);
  const me = myersDiff([], []);
  const mr = myersDiff(['a'], []);
  check('6s empty and one-sided inputs', me.removedIdx.length === 0 && me.addedIdx.length === 0 && mr.removedIdx.join(',') === '0' && mr.addedIdx.length === 0);
}

// ---- 7. buildSedPreview -----------------------------------------------------------------------------
{
  const u = buildSedPreview('a\nb\n', 'a\nb\n');
  check('7a unchanged text: changed false, empty preview', u.changed === false && u.text === '' && u.removedCount === 0 && u.addedCount === 0);
  const p = buildSedPreview('a\nb\nc\n', 'a\nB\nc\nd\n');
  check('7b counts: 1 removed, 2 added', p.changed && p.removedCount === 1 && p.addedCount === 2);
  check('7c preview text: - old, + new, + appended', p.text === '   2 - b\n   2 + B\n   4 + d');
  const a = [], b = [];
  for (let i = 0; i < 40; i++) { a.push('old' + i); b.push('new' + i); }
  const t = buildSedPreview(a.join('\n') + '\n', b.join('\n') + '\n', { max: 30 });
  const lines = t.text.split('\n');
  check('7d truncation: 30 entries plus one summary line', lines.length === 31);
  check('7e truncation: the summary says how many more', /and 50 more changed line\(s\)/.test(lines[30]));
  const d = buildSedPreview('a\nb\n', '');
  check('7f emptied file: all lines removed', d.changed && d.removedCount === 2 && d.addedCount === 0);
}

// ---- 8. THE HANDLER IS WIRED TO THIS MODULE (guards against a silent revert) --------------------------
const regSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
check('8a mcp-registration requires lib/sed-tool', regSrc.indexOf("require('./sed-tool')") !== -1);
check('8b the old planner is no longer required', regSrc.indexOf("require('./sed-plan')") === -1 && regSrc.indexOf('planSed(') === -1);
const sedStart = regSrc.indexOf("name:     'sed',");
const sedEnd = regSrc.indexOf('FILE-OPS GROUP (part 4: file-line-count)');
const sedSrc = (sedStart !== -1 && sedEnd > sedStart) ? regSrc.slice(sedStart, sedEnd) : '';
check('8c sed tool block found', sedSrc.length > 1000);
const hintNames = ['inFunction', 'betweenHint', 'afterFunction', 'beforeFunction', 'afterSymbol', 'beforeSymbol', 'afterString', 'beforeString', 'afterLine', 'beforeLine', 'banner', 'ifdefBlock', 'ifdefEdge', 'hintRadius', 'occurrence', 'fuzzyWhitespace'];
const handlerLine = sedSrc.split('\n').find(l => l.indexOf('handler: async ({') !== -1) || '';
check('8d handler signature found', handlerLine.length > 0);
for (const h of hintNames) check('8e handler destructures hint ' + h, new RegExp('\\b' + h + '\\b').test(handlerLine));
check('8f handler destructures extended', /\bextended\s*=\s*false\b/.test(handlerLine));
check('8g every hint is forwarded to resolveScope', hintNames.every(h => new RegExp('params: \\{[^}]*\\b' + h + '\\b').test(sedSrc)));
check('8h scope rows are turned into 1-based sed line numbers', /from:\s*scope\.searchStart\s*\+\s*1,\s*to:\s*scope\.searchEnd\s*\+\s*1/.test(sedSrc));
check('8i schema reuses the shared hint schema without regex / fuzzyContent', sedSrc.indexOf('ANCHOR_SCHEMA') !== -1 && /k !== 'regex' && k !== 'fuzzyContent'/.test(sedSrc));
check('8j schema has the structural anchors and extended', ['banner:', 'ifdefBlock:', 'ifdefEdge:', 'extended:'].every(k => sedSrc.indexOf(k) !== -1));
check('8k old occurrence number schema is gone', sedSrc.indexOf('occurrence:   z.number().int().optional()') === -1);
check('8l handler runs the script through runSed with the resolved scope', /runSed\(\{ expression, extended, text: originalText, scope: scopeRange/.test(sedSrc));
check('8m dry run and commit both use buildSedPreview output', sedSrc.indexOf('buildSedPreview(originalText, newText)') !== -1 && sedSrc.indexOf('buffer.setTextViaDiff(newText)') !== -1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
