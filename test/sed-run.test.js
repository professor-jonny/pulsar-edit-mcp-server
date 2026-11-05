'use strict';
// Test (2026-10-22) -- TODO R4c: lib/sed-run.js, the interpreter for parsed GNU sed 4.9 scripts.
// Run from the package root:   node test/sed-run.test.js
// Plain node, no Pulsar, no sed needed, no files written.
//
// What is pinned:
//   1. CASES (test/golden/sed-run-cases.js): each script run over recorded inputs; the expected output and exit
//      status were recorded with a real GNU sed 4.9 (bytes in, bytes out). That covers the cycle, the pattern and
//      hold space, addresses and ranges, a / i / c, q / Q, s with all its flags, t / T / b, y, l, a missing final
//      newline, empty input, and empty matches inside multibyte characters (sed steps one BYTE, so the replacement
//      can land between the bytes of a character).
//   2. SCOPE_CASES: the `scope` option behaves exactly like wrapping the script in `from,to{ ... }`.
//   3. Hand-written cases recorded from Linux sed 4.9 where the Windows port of sed differs (characters outside the
//      BMP, `l` with a tab), the byte helpers, run-time errors, unsupported commands and the options.
// A stray byte that is not valid UTF-8 is written \udcXX (raw byte 0xXX), see encodeBytes in lib/sed-run.js.
// Known limitation: \xHH in a regex is a raw byte in GNU sed (here it is a character); not tested.

const { parseScript } = require('../lib/sed-parse');
const { runScript, SedRunError, encodeBytes, decodeBytes } = require('../lib/sed-run');
const { CASES, SCOPE_CASES } = require('./golden/sed-run-cases');

let bad = 0, pass = 0;
function ok(label, cond, detail) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && detail !== undefined) console.log('      ' + detail);
}
// like ok() but silent when it passes (the recorded tables hold thousands of cases)
function quiet(label, cond, detail) {
  if (cond) { pass++; return; }
  bad++;
  console.log('FAIL ' + label);
  if (detail !== undefined) console.log('      ' + detail);
}
const J = (s) => JSON.stringify(s);

function runIt(script, input, opts, parseOpts) {
  try {
    const r = runScript(parseScript(script, parseOpts || { extended: false, sandbox: true }), input, opts || {});
    return { out: r.output, status: r.exitCode, quit: r.quit, err: null };
  } catch (e) {
    if (!(e instanceof SedRunError)) throw e;
    return { out: null, status: e.exitCode, quit: false, err: e };
  }
}

// 1. recorded cases
{
  let n = 0;
  for (const [script, silent, input, expected, status] of CASES) {
    const g = runIt(script, input, { silent: !!silent });
    n++;
    quiet('recorded: ' + J(script) + (silent ? ' -n' : '') + ' <' + J(input) + '>', g.out === expected && g.status === status,
      'sed  = ' + J(expected) + ' st ' + status + '\n      mine = ' + J(g.out) + ' st ' + g.status);
  }
  ok('recorded cases: ' + n + ' scripts x inputs match real sed', n > 1000);
}

// 2. scope = wrapping in from,to{ ... }
{
  let n = 0;
  for (const [script, from, to, input, expected, status] of SCOPE_CASES) {
    const g = runIt(script, input, { scope: { from, to } });
    n++;
    quiet('scope ' + from + ',' + to + ': ' + J(script) + ' <' + J(input) + '>', g.out === expected && g.status === status,
      'sed  = ' + J(expected) + ' st ' + status + '\n      mine = ' + J(g.out) + ' st ' + g.status);
  }
  ok('scope cases: ' + n + ' match the wrapped script in real sed', n > 100);
}

// 3a. byte helpers
{
  const bytes = Buffer.from([0x61, 0xc3, 0xa9, 0xff, 0x80, 0xe2, 0x82]);
  const t = decodeBytes(bytes);
  ok('decodeBytes: valid and stray bytes', t === 'a\u00e9\udcff\udc80\udce2\udc82', J(t));
  ok('encodeBytes(decodeBytes(x)) gives x back', encodeBytes(t).equals(bytes));
  ok('decodeBytes keeps a BOM', decodeBytes(Buffer.from([0xef, 0xbb, 0xbf, 0x61])) === '\ufeffa');
  ok('decodeBytes: overlong C0 80 is two stray bytes', decodeBytes(Buffer.from([0xc0, 0x80])) === '\udcc0\udc80');
  ok('decodeBytes: an encoded surrogate ED A0 80 is three stray bytes', decodeBytes(Buffer.from([0xed, 0xa0, 0x80, 0x61])) === '\udced\udca0\udc80a');
  ok('decodeBytes: 4-byte character', decodeBytes(Buffer.from([0xf0, 0x9f, 0x98, 0x80])) === '\ud83d\ude00');
  ok('decodeBytes: truncated sequence at the end', decodeBytes(Buffer.from([0x61, 0xe2, 0x82])) === 'a\udce2\udc82');
  ok('encodeBytes: 4-byte character is 4 bytes', encodeBytes('\ud83d\ude00').length === 4);
  ok('decodeBytes of valid UTF-8 is a plain string', decodeBytes(Buffer.from('abc\u20ac', 'utf8')) === 'abc\u20ac');
}

// 3b. recorded from Linux sed 4.9 (LC_ALL=C.UTF-8): empty matches inside multibyte characters and stray bytes
{
  const E = '\u20ac\n';        // euro sign, bytes E2 82 AC
  const EMOJI = '\ud83d\ude00\n'; // bytes F0 9F 98 80
  const L = [
    ['s/x*/-/g', E, '-\udce2-\udc82-\udcac-\n'],
    ['s/x*/-/', E, '-\u20ac\n'],
    ['s/x*/-/2', E, '\udce2-\udc82\udcac\n'],
    ['s/x*/-/3', E, '\udce2\udc82-\udcac\n'],
    ['s/x*/-/4', E, '\u20ac-\n'],
    ['s/x*/-/5', E, E],
    ['s/x*/-/2g', E, '\udce2-\udc82-\udcac-\n'],
    ['s/[a-z]*/-/g', E, '-\u20ac-\n'],
    ['s/[[:alpha:]]*/-/g', E, '-\u20ac-\n'],
    ['s/\\w*/-/g', E, '-\u20ac-\n'],
    ['s/x*/-/Ig', E, '-\u20ac-\n'],
    ['s/\\(x\\)*\\1/-/g', E, E],
    ['s/x*/-/g;s/./X/g', E, 'X\udce2X\udc82X\udcacX\n'],
    ['s/x*/-/g;s/-/+/g', E, '+\udce2+\udc82+\udcac+\n'],
    ['s/x*/-/g', EMOJI, '-\udcf0-\udc9f-\udc98-\udc80-\n'],
    ['s/x*/-/2', EMOJI, '\udcf0-\udc9f\udc98\udc80\n'],
    ['s/x*/-/3', EMOJI, '\udcf0\udc9f-\udc98\udc80\n'],
    ['s/\\w*/X/g', EMOJI, 'X\ud83d\ude00X\n'],
    ['s/\\b/|/g', EMOJI, EMOJI],
    ['s/\\B/|/g', EMOJI, '|\ud83d\ude00|\n'],
    ['s/.\\?/X/g', EMOJI, 'X\n'],
    ['s/[^a]*/X/g', EMOJI, 'X\n'],
    ['s/x*/-/g', '\udcff\n', '-\udcff-\n'],
    ['s/x*/-/g', 'a\udcffb\n', '-a-\udcff-b-\n'],
    ['s/./X/g', 'a\udcffb\n', 'X\udcffX\n'],
    ['s/[^a]/X/g', 'a\udcffb\n', 'a\udcffX\n'],
    ['s/\\W/X/g', 'a\udcffb\n', 'a\udcffb\n'],
    ['s/\\b/|/g', 'x\udcffy\n', '|x\udcffy|\n'],
    ['s/\\B/|/g', 'x\udcffy\n', 'x|\udcff|y\n'],
    ['s/\\b/|/g', '\udcffx\n', '|\udcffx|\n'],
    ['s/\\B/|/g', '\udcffx\n', '\udcff|x\n'],
    ['s/\\b/|/g', '+\udcffx\n', '+|\udcffx|\n'],
    ['s/\\b/|/g', '\udcff\n', '|\udcff|\n'],
    ['s/\\B/|/g', '\udcff\n', '\udcff\n'],
    ['s/\\</[/g', '\udcff\n', '[\udcff\n'],
    ['s/\\>/]/g', '\udcff\n', '\udcff]\n'],
    ['s/\\w/X/g', 'a\udcffb\n', 'X\udcffX\n'],
    ['s/\\S/X/g', 'a\udcffb\n', 'X\udcffX\n'],
    ['s/[[:print:]]/X/g', 'a\udcffb\n', 'X\udcffX\n'],
    ['s/[^[:alpha:]]/X/g', 'a\udcffb\n', 'a\udcffb\n'],
    ['l', 'a\tb\\c\n', 'a\\tb\\\\c$\n'],
    ['l', '\u00e9\u4e2d\n', '\\303\\251\\344\\270\\255$\n'],
    ['l', 'x\udcffy\n', 'x\\377y$\n'],
    ['l 5', 'abcdefghij\n', 'abcd\\\nefgh\\\nij$\n'],
    ['l', 'a\u0001b\r\u000b\n', 'a\\001b\\r\\v$\n'],
  ];
  for (const [script, input, expected] of L) {
    const g = runIt(script, input);
    const outShown = script === 'l' || script === 'l 5';
    // `l` goes to the output after the autoprint, so with -n off the line comes first
    const want = outShown ? expected + input : expected;
    ok('linux: ' + J(script) + ' <' + J(input) + '>', g.out === want, 'want ' + J(want) + '\n      got  ' + J(g.out));
  }
}

// 3c. results, options, errors
{
  const qr = runIt('2q5', '1\n2\n3\n');
  ok('q: exit code and quit flag', qr.out === '1\n2\n' && qr.status === 5 && qr.quit === true);
  const nr = runIt('p', '1\n');
  ok('no quit: quit flag is false, status 0', nr.quit === false && nr.status === 0);
  const f = runIt('1F', 'a\nb\n', { fileName: 'x.js' });
  ok('F prints the file name given in opts', f.out === 'x.js\na\nb\n', J(f.out));
  const f0 = runIt('1F', 'a\n');
  ok('F prints - without a file name', f0.out === '-\na\n', J(f0.out));
  const w = runIt('l', 'abcdefghij\n', { silent: true, lineWrap: 5 });
  ok('opts.lineWrap sets the default width of l', w.out === 'abcd\\\nefgh\\\nij$\n', J(w.out));
  const w0 = runIt('l', 'abcdefghij\n', { silent: true, lineWrap: 0 });
  ok('opts.lineWrap 0 never wraps', w0.out === 'abcdefghij$\n', J(w0.out));
  const wd = runIt('l', 'a'.repeat(100) + '\n', { silent: true });
  ok('l wraps at 70 by default (69 characters and a backslash)', wd.out === 'a'.repeat(69) + '\\\n' + 'a'.repeat(31) + '$\n', J(wd.out));
  const sil = runIt('p', '1\n2\n', { silent: true });
  ok('opts.silent works like -n', sil.out === '1\n2\n');
  const h = runIt('#n\np', '1\n');
  ok('#n on the first line works like -n', h.out === '1\n');

  const e1 = runIt('//p', 'a\n');
  ok('empty regex with no previous regex: SedRunError, exit 1', e1.err instanceof SedRunError && e1.status === 1 && /no previous regular expression/.test(e1.err.message), e1.err && e1.err.message);
  const e2 = runIt('/a/s//\\1/', 'a\n');
  ok('empty regex taken from an ADDRESS with a bad group reference is an error', e2.err instanceof SedRunError && /invalid reference \\1/.test(e2.err.message), e2.err && e2.err.message);
  const e2b = runIt('/b/s//[\\1]/', 'abc\n');
  ok('same with a different address', e2b.err instanceof SedRunError && e2b.status === 1);
  const e2c = runIt('s/\\(a\\)/\\1/;s//\\3/', 'aXb\n');
  ok('empty regex taken from an earlier s: a group that does not exist is empty (no error)', e2c.err === null && e2c.out === 'Xb\n', J(e2c.out));
  const e2d = runIt('s/a/b/;s//\\1/', 'aa\n');
  ok('empty regex from an earlier s without groups: \\1 is empty', e2d.err === null && e2d.out === 'b\n', J(e2d.out) + ' ' + (e2d.err && e2d.err.message));
  const e3 = runIt(':a;ba', 'x\n', { maxSteps: 100 });
  ok('maxSteps stops an endless loop with exit code 4', e3.err instanceof SedRunError && e3.status === 4, e3.err && e3.err.message);
  const e4 = runIt('w /dev/null', 'x\n', {}, { extended: false, sandbox: false });
  ok('w is not supported by the runner', e4.err instanceof SedRunError && /not supported/.test(e4.err.message), e4.err && e4.err.message);
  const e5 = runIt('r /dev/null', 'x\n', {}, { extended: false, sandbox: false });
  ok('r is not supported by the runner', e5.err instanceof SedRunError && /not supported/.test(e5.err.message), e5.err && e5.err.message);
  const e6 = runIt('s/a/b/w /dev/null', 'a\n', {}, { extended: false, sandbox: false });
  ok('the w flag of s is not supported by the runner', e6.err instanceof SedRunError, e6.err && e6.err.message);

  // a parse result can be run again and again: no state is kept in it
  const parsed = parseScript('2,3{s/$/!/;p};$!N;P;D', { extended: false, sandbox: true });
  const a = runScript(parsed, '1\n2\n3\n4\n5\n', {}).output;
  const b = runScript(parsed, '1\n2\n3\n4\n5\n', {}).output;
  const c = runScript(parsed, '1\n2\n3\n4\n5\n', { scope: { from: 2, to: 3 } }).output;
  const d = runScript(parsed, '1\n2\n3\n4\n5\n', {}).output;
  ok('a parse result gives the same output when run twice', a === b && a === d, J(a) + ' ' + J(b));
  ok('running with a scope does not change the parse result', c !== undefined && a === d);
  ok('the scope option does not add commands to the parse result', parsed.cmds.length === parseScript('2,3{s/$/!/;p};$!N;P;D', { extended: false, sandbox: true }).cmds.length);
}

console.log('\n' + pass + ' passed, ' + bad + ' failed');
process.exit(bad === 0 ? 0 : 1);
