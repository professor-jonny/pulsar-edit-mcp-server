'use strict';
// test/sed-oracle/run-diff.js - compare lib/sed-run.js with a REAL GNU sed over a corpus of scripts x inputs.
//
//   node test/sed-oracle/run-diff.js [filter-regex] [--quick]
//
// Every script is run twice (default output and -n) over every input; output text and exit status must match.
// Scripts the parser rejects are skipped (parse-diff.js covers errors). Needs `sed` on PATH (see README.md).
// Not compared: scripts that use e, r, R, w, W (the interpreter does not run them).

const { runSed, requireSed } = require('./oracle');
const { parseScript } = require('../../lib/sed-parse');
const { runScript, SedRunError } = require('../../lib/sed-run');

const INPUTS = [
  '1\n2\n3\n4\n5\n',
  '1\n2\n3\n4\n5\n6\n',
  'a\nb\n',
  '1\n2',
  'x',
  '\n',
  '',
  'aXbXa\nfoo bar\n\nbaz qux\n',
  'a\tb\\c\u00e9\u4e2d\n\u00e9\u00e9\n',
  'hello world\nHello World\n',
  // multibyte characters (2, 3 and 4 bytes) and stray bytes that are not valid UTF-8 (\udcXX = the raw byte 0xXX)
  '\u20ac\n', 'a\u20acb\n', '\u00e9\n', '\u4e2d\u6587\n', '\ud83d\ude00\n', 'aa\u20ac\n', 'x\udcffy\n\udc80\n', '\u20ac\u20ac\n\u00e9a\n',
];

const SCRIPTS = [
  // single commands
  'p', 'd', 'D', 'G', 'g', 'h', 'H', 'x', 'n', 'N', 'P', 'z', '=', 'l', 'l 0', 'l 1', 'l 2', 'l 3', 'l 10', 'F', '2F',
  // cycles, pattern and hold space
  'N;D', '$!N;P;D', 'n;d', '$!N;s/\\n/-/', 'N;N;s/\\n/+/g', '1{N;N;D}', 'N;P;D', '$!N;$!D', 'x;G', 'h;G', '1!G;h;$!d',
  'H;$!d;x;s/\\n/,/g', '1h;2G', '1h;2g', '$!d;G', '$!d;g', '2h;1d;g', '1H;2H;$!d;x', 'x;p;x', '2{h;d};${G}', 'G;G',
  'g;G', 'N;G', 'n;n;d', 'n;N;d', 'N;N;N;D', 'x', 'x;x', '1d;x;G', '$!d;h;G', 'h;$!d;x', '1h;2{x;p;x}', 'H;g',
  'n;s/$/X/', 'N;l', 'N;=', '$!N;=', 'N;N;P;D',
  // addresses
  '2p', '2,4p', '2,4!p', '/2/,/4/p', '/2/,+1p', '2,~3p', '0~2p', '1~2p', '2~0p', '2~3p', '$!p', '$p', '1,3!d', '0,/2/p',
  '1,/1/p', '/2/,/2/p', '5,2p', '2,1p', '/x/p', '0~3,+1p', '/1/,/3/{/3/!d}', '2,4{p}', '2,4{p;d}', '/3/!d', '/a/,/b/d',
  '2,/2/p', '/2/,~2p', '/2/,+0p', '3,+2d', '2,~4p', '4,~2p', '/a/I,/B/Id', '2!d', '2,3!d', '$!{$!N}', '1~3d', '0,/1/d',
  '1,/1/d', '/o/,/o/d', '2,$d', '$,2p', '2,2p', '/hello/I{p;d}', '/^$/d', '/^$/,$d', '1!{/a/d}',
  // a i c
  '2a X', '2i X', '2c X', '2,3c X', '2,3!c X', '$!N;a X', '1{a X\nq}', '$a END', '1i\\\nA\\\nB', '2a\\\nl1\\\nl2',
  '2{i A\na B\n}', '$!N;2c Z', 'N;c Z', 'a A\nn', 'i A\nN', '2a\\  lead', '2a hello\\nworld', '$!{2,4c\\\nZ\n}',
  '2{c\\\nZ\n}', 'a X', 'i X', 'c X', '1c X', '$c X', '$!N;c X', '/a/c X', '1,2c X', '1,2{c X\n}', 'a X\nd', 'a X\nD',
  'a X\nN', '2{a X\nQ}', '2{a X\nq}', '$!n;a X', 'N;N;a X', 'a\\\n',
  // q and Q
  '2q', '2q5', '2Q', '2Q7', '$q', 'n;q', 'N;q', '3{p;q}', '/2/q3', '2{p;Q}', '1q1', 'q9',
  // s
  's/a/b/', 's/a/b/g', 's/a*/X/g', 's/x*/-/g', 's/a*/X/2', 's/a*/X/3g', 's/./&&/2', 's/\\(.\\)/\\u\\1/', 's/\\w\\+/\\U&/',
  's/\\w\\+/\\u\\L&/', 's/\\(a\\)\\|b/[\\1]/g', 's/$/!/', 's/^/>/', 'N;s/^/>/Mg', 'N;s/$/</Mg', 's/b/\\n/', 's/a/x\\ny/',
  's/[0-9]/<&>/g', 's/\\(.\\)\\(.\\)/\\2\\1/', 's/a/b/p', 's/a/b/2p', 'N;s/\\n/-/', 's/./\\l&/', 's/\\(.*\\)/\\U\\1\\E!/',
  's/x\\?/-/g', 's/.*/(&)/', 's/\\b/|/g', 's/\\</[/g', 's/\\>/]/g', 's/B/x/I', 's/a/&/;s//Z/', 's/o/0/3', 's/o/0/2g',
  's/\\(.\\)\\(.\\)\\(.\\)/\\3\\2\\1/g', 's/\\s\\+/_/g', 's/[aeiou]/\\U&/g', 's/\\(h\\)\\(e\\)/\\u\\1\\U\\2/', 's/.\\?/&;/g',
  's/^\\|$/#/g', 's/\\n//', 'N;N;s/^.*$/[&]/M2', 's/a\\|b\\|c/<&>/g', 's/\\(x\\)*/<\\1>/', 's/\\(x\\)*y*/[\\1]/g',
  's/\\w*/(&)/g', 's/\\W/_/g', 's/./\\n&/2', 's/l*/L/g', 's/$/\\n/', 's/^/\\t/', 's/e/\\\\/', 's/e/\\//',
  's/ /\\n/g;P;D', 's/\\(.\\)/\\1\\1/g', 's/\\(hello\\) \\(world\\)/\\2 \\1/I', 's/world/\\U&\\E!/I', 's/\\(a\\|b\\)\\{2\\}/X/',
  // t T b labels
  's/1/X/;n;t e;s/$/?/;:e', ':a;s/^\\(.\\{1,4\\}\\)$/ \\1/;ta', ':a;N;$!ba;s/\\n/,/g', ':a;$!{N;ba}', 's/a/b/;T;s/$/!/',
  's/z/y/;T;s/$/!/', 'b;p', ':x;n;bx', 'N;N;b end;p;:end', 't;p', 's/1/X/;t;s/$/?/', 's/1/X/;T;s/$/?/', 's/1/X/;N;t e;s/$/?/;:e',
  's/./X/;ta;s/$/-/;:a', ':a;s/aa/a/;ta', '/2/b;s/$/!/', '/2/!b;s/$/!/', 'b e;p;:e', ':a;n;$!ba', 's/a/A/;tx;s/$/-/;:x;s/b/B/;ty;s/$/+/;:y',
  // y z = l
  'y/abc/xyz/', 'y/abc/ABC/', 'N;y/\\n/ /', 'y/\\//|/', 'y/a\\tb/123/', 'y/\\\\/-/', 'y/e/\\n/', 'y/\u00e9\u4e2d/ab/', 'y,a\\,c,xyz,',
  'z;s/^$/E/', 'l;d', '$=', '=;d', 'l 5', 'l 70', 'N;N;l 4',
  // empty regex reuse
  '/a/s//Y/', 's/a/b/;s//c/', '/B/Is//-/', 's/b/[&]/;s//x/', '/ab/{s//1/;s//2/}', '/a/d;//d', '/o/s//0/g', '//p',
  // blocks
  '2{p;p}', '2,3{s/$/!/;p}', '{p}', '{;p;}', '/a/{/b/{p}}', '2{n;p}', '1!{x;p;x}', '$!{N;D}', '2,4{2,3d}', '2{2{p}}',
  // empty matches inside multibyte characters (GNU sed steps one byte, so the replacement can land between the bytes)
  's/x*/-/g', 's/x*/-/', 's/x*/-/2', 's/x*/-/3', 's/x*/-/4', 's/x*/-/5', 's/x*/-/2g', 's/x*/-/4g', 's/x*/-/Ig', 's/x*/-/Mg',
  's/a*/X/g', 's/a*/X/2', 's/a\\?/-/g', 's/\\(\\)/-/g', 's/\\(x\\)*/[\\1]/g', 's/x*\\(\\)/[\\1]/g', 's/[ab]*/-/g', 's/[a]*/-/g',
  's/[a-z]*/-/g', 's/[[:alpha:]]*/-/g', 's/\\w*/-/g', 's/\\s*/-/g', 's/\\W*/-/g', 's/.*x*/-/g', 's/\\(.\\)*/-/g', 's/\\b/|/g',
  's/\\B/|/g', 's/\\</[/g', 's/\\>/]/g', 's/x*$/!/g', 's/^x*/>/g', 's/x*\\|y/-/g', 's/a\\|/-/g', 's/x\\{0,2\\}/-/g', 's/x*y*z*/-/g',
  's/x*/-/g;s/./X/g', 's/x*/-/g;s/[^-]/X/g', 's/x*/-/g;s/-/+/g', 's/x*/-/g;l', 's/x*/-/g;y/-/+/', 'N;s/x*/-/g',
  's/^/>/;s/x*/-/g;s/$/</', 's/x*/&&/g', 's/x*/\\n/g', 's/x*/\\U&-/g', 'l', 'l 2', 'l 5', 'y/a/b/', 's/./X/g', 's/[^a]/X/g', 's/x*//g;s/./X/g', 's/x*/\\n/;s/./X/g',
  // comments and misc
  '#n\np', '#n', 'p # comment', 'p;p;p', '2{p};3{p}', '1,3{/2/d}', '$!{h;d};x;G', '1{h;d};${G}', 'N;N;N;N;N;s/\\n/ /g',
];

function fmt(s) { return JSON.stringify(s); }

// Differences that are NOT bugs of lib/sed-run.js; they are counted separately ("known"), not as mismatches:
//  - The Windows port of sed prints a TAB inside `l` output as a real tab; Linux sed prints \t.
//  - The Windows port of sed has a 16-bit wchar_t, so it mishandles characters outside the BMP (emoji, 4 bytes):
//    classes, ranges, `.`, \b and friends differ from Linux there.
// Both are only considered on win32. (Known limitation, not tested: \xHH in a regex is a raw byte in GNU sed.)
function knownDeviation(parsed, input, real) {
  if (process.platform !== 'win32') return false;
  if (input.indexOf('\t') >= 0 && parsed.cmds.some((c) => c.cmd === 'l')) return true;
  if (/[\ud800-\udbff]/.test(input)) return true;
  // a stray byte next to \b \B \< \>: the Windows port has no word boundary around a lone stray byte, Linux sed does
  if (/[\udc80-\udcff]/.test(input) && parsed.cmds.some((c) => c.cmd === 's' && c.regex && /\\[bB<>]/.test(c.regex.source || ''))) return true;
  return false;
}

function main() {
  const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const quick = process.argv.includes('--quick');
  const ver = requireSed();
  console.log(ver);
  const re = filter ? new RegExp(filter) : null;
  let cases = 0, skipped = 0, bad = 0, shown = 0, known = 0;
  const inputs = process.argv.includes('--mb') ? INPUTS.filter((s) => /[^\x00-\x7f]/.test(s))
    : process.argv.includes('--rest') ? INPUTS.slice(5, 10) : quick ? INPUTS.slice(0, 5) : INPUTS;
  const mbOnly = process.argv.includes('--mb'); // only the multibyte block of scripts, only non-ASCII inputs
  const scripts = mbOnly ? SCRIPTS.slice(SCRIPTS.indexOf('s/x*/-/')) : SCRIPTS;
  for (const script of scripts) {
    if (re && !re.test(script)) continue;
    let parsed;
    try {
      parsed = parseScript(script, { extended: false, sandbox: true });
    } catch (e) {
      skipped++;
      continue;
    }
    for (const input of inputs) {
      for (const n of [false, true]) {
        const real = runSed((n ? ['-n'] : []).concat(['-e', script]), input);
        let mine;
        try {
          const r = runScript(parsed, input, { silent: n });
          mine = { out: r.output, status: r.exitCode, err: false };
        } catch (e) {
          if (!(e instanceof SedRunError)) throw e;
          mine = { out: null, status: e.exitCode, err: true };
        }
        const realErr = real.status !== 0 && real.err !== '' && real.err !== null && real.err !== undefined && /sed:/.test(real.err);
        let same;
        if (realErr || mine.err) same = realErr && mine.err;
        else same = real.out === mine.out && real.status === mine.status;
        cases++;
        if (!same && knownDeviation(parsed, input, real)) {
          known++;
          continue;
        }
        if (!same) {
          bad++;
          if (shown++ < 40) {
            console.log(fmt(script) + (n ? ' -n' : '') + ' <' + fmt(input) + '>');
            console.log('   sed =' + (realErr ? 'ERR ' + fmt(real.err) : fmt(real.out) + ' st ' + real.status));
            console.log('   mine=' + (mine.err ? 'ERR' : fmt(mine.out) + ' st ' + mine.status));
          }
        }
      }
    }
  }
  console.log('cases: ' + cases + ' (skipped scripts the parser rejects: ' + skipped + ', known deviations: ' + known + '), mismatches: ' + bad);
  process.exitCode = bad ? 1 : 0;
}

module.exports = { SCRIPTS, INPUTS };
if (require.main === module) main();
