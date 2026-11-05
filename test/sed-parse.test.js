'use strict';
// Test (2026-10-18) -- TODO R4b: lib/sed-parse.js, the parser for GNU sed 4.9 scripts.
// Run from the package root:   node test/sed-parse.test.js
// Plain node, no Pulsar, no sed needed, no files written.
//
// What is pinned:
//   1. ERR_CASES: for each script the exact verdict of a real GNU sed 4.9 -- "ok", or the error with its
//      "char N" position and message (positions count bytes), or a label / character-class error -- so the
//      parser accepts and rejects the same scripts with the same messages.
//   2. SEM_CASES: single s / y / a / i / c commands applied to one line, output recorded from real GNU sed 4.9
//      (escapes, delimiters, brackets, replacement case conversion, a/i/c text forms). A tiny evaluator in this
//      file applies the parsed command; the real runner is R4c.
//   3. The shape of the parse result: blocks, jumps, labels, addresses, silent mode, replacement pieces, y maps,
//      sandbox mode, the -E option, error object fields.
// The expected values were recorded with GNU sed 4.9 (LC_ALL=C.UTF-8); the recording tools are not part of the package.
//
// Known deviation: the L command is rejected as an unknown command (GNU sed 4.9 accepts it and fails at run time).
// "no previous regular expression" is a RUN-TIME error in sed (an empty regex executed with none before it),
// so the parser accepts it and the runner (R4c) raises it.

const { parseScript, SedParseError, normalizeText } = require('../lib/sed-parse');

let bad = 0, pass = 0;
function ok(label, cond, detail) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && detail !== undefined) console.log('      ' + detail);
}

function verdict(script, opts) {
  try { parseScript(script, opts); return 'ok'; } catch (e) {
    if (!(e instanceof SedParseError)) throw e;
    if (e.reason.indexOf('can\'t find label') === 0) return 'LABEL ' + e.reason;
    if (e.reason.indexOf('character class syntax') === 0) return 'CLASS';
    return 'ERR ' + e.char + ': ' + e.reason;
  }
}

// ---- evaluator for ONE s / y / a / i / c command on one line (GNU sed's replacement and s///g rules)
function caseMod(text, type) {
  const first = type & 12, rest = type & 3;
  let out = '';
  Array.from(text).forEach((c, idx) => {
    if (idx === 0 && first) out += first === 4 ? c.toUpperCase() : c.toLowerCase();
    else out += rest === 1 ? c.toUpperCase() : rest === 2 ? c.toLowerCase() : c;
  });
  return out;
}
function expand(pieces, str, m) {
  let out = '', replMod = 0;
  for (const p of pieces) {
    let curr = (p.type & 12) ? p.type : (p.type | replMod);
    replMod = 0;
    if (p.prefix.length) { out += caseMod(p.prefix, curr); curr &= ~12; }
    if (p.ref >= 0) {
      const s = m.start[p.ref], e = m.end[p.ref];
      if ((s < 0 || s === e) && (p.type & 12)) replMod = curr & 12;
      else if (s >= 0 && s !== e) out += caseMod(str.slice(s, e), curr);
    }
  }
  return out;
}
function doS(cmd, line) {
  const re = cmd.regex.compiled;
  let m = re.exec(line, 0);
  if (!m) return { out: line, replaced: false };
  let out = '', pos = 0, prevEnd = -1, count = 0, replaced = false;
  while (m) {
    const s = m.start[0], e = m.end[0];
    out += line.slice(pos, s);
    if (!(s === e && s === prevEnd)) {
      count++;
      if (count < cmd.nth) out += line.slice(s, e);
      else {
        out += expand(cmd.repl.pieces, line, m);
        replaced = true;
        if (!cmd.global) { out += line.slice(e); return { out, replaced }; }
      }
    }
    prevEnd = e; pos = e;
    if (s === e) {
      if (pos < line.length) { const cp = line.codePointAt(pos); const len = cp > 0xffff ? 2 : 1; out += line.substr(pos, len); pos += len; } else break;
    }
    m = pos <= line.length ? re.exec(line, pos) : null;
  }
  return { out: out + line.slice(pos), replaced };
}
function runOne(script, line) {
  const { cmds, silent } = parseScript(script);
  const c = cmds[0];
  let pattern = line, pre = '', post = '', extra = '';
  if (c.cmd === 's') {
    const r = doS(c, line);
    pattern = r.out;
    if (r.replaced && c.print) extra = pattern + '\n';
  } else if (c.cmd === 'y') {
    pattern = Array.from(line).map((ch) => (c.map.has(ch) ? c.map.get(ch) : ch)).join('');
  } else if (c.cmd === 'a') post = c.text;
  else if (c.cmd === 'i') pre = c.text;
  else if (c.cmd === 'c') return c.text;
  return pre + extra + (silent ? '' : pattern + '\n') + post;
}

// ---------------------------------------------------------------- recorded from GNU sed 4.9
const ERR_CASES = [
  ["", "ok"],
  [" ", "ok"],
  [";", "ok"],
  [";;", "ok"],
  ["{", "ERR 0: unmatched `{'"],
  ["}", "ERR 1: unexpected `}'"],
  ["{}", "ok"],
  ["p;}", "ERR 3: unexpected `}'"],
  ["{p", "ERR 0: unmatched `{'"],
  ["x y", "ERR 3: extra characters after command"],
  ["pp", "ERR 2: extra characters after command"],
  ["p p", "ERR 3: extra characters after command"],
  ["p;p", "ok"],
  ["p ; p", "ok"],
  ["p}", "ERR 2: unexpected `}'"],
  ["1p;", "ok"],
  ["1,2,3p", "ERR 4: unknown command: `,'"],
  ["1,p", "ERR 3: unexpected `,'"],
  [",2p", "ERR 1: unknown command: `,'"],
  ["1!!p", "ERR 3: multiple `!'s"],
  ["1! p", "ok"],
  ["1 !p", "ok"],
  ["! p", "ok"],
  ["!p", "ok"],
  ["1,2q", "ERR 4: command only uses one address"],
  ["1q", "ok"],
  ["1,2=", "ok"],
  ["1,2a x", "ok"],
  ["1,2i x", "ok"],
  ["1,2r /dev/null", "ok"],
  ["1,2l", "ok"],
  ["a", "ERR 1: expected \\ after `a', `c' or `i'"],
  ["a x", "ok"],
  ["a\\", "ok"],
  ["a\\\nx", "ok"],
  ["a\\x", "ok"],
  ["i\\", "ok"],
  ["c\\\nx", "ok"],
  [":", "ERR 1: \":\" lacks a label"],
  [": a", "ok"],
  [":a;", "ok"],
  [":a b", "ok"],
  ["1:a", "ERR 2: : doesn't want any addresses"],
  ["b", "ok"],
  ["b a", "LABEL can't find label for jump to `a'"],
  ["ba;p", "LABEL can't find label for jump to `a'"],
  ["b;p", "ok"],
  ["b}", "ERR 2: unexpected `}'"],
  ["{b}", "ok"],
  ["{b;}", "ok"],
  ["t", "ok"],
  ["T x", "LABEL can't find label for jump to `x'"],
  ["y/a/b/", "ok"],
  ["y/a/bc/", "ERR 7: strings for `y' command are different lengths"],
  ["y/a/b", "ERR 5: unterminated `y' command"],
  ["y/a/b/g", "ERR 7: extra characters after command"],
  ["y/\\n/x/", "ok"],
  ["y/a\\/b/xyz/", "ok"],
  ["y/ab/\\n\\\\/", "ok"],
  ["y/a/\\x/", "ok"],
  ["s/a/b/", "ok"],
  ["s/a/b", "ERR 5: unterminated `s' command"],
  ["s/a/b/g", "ok"],
  ["s/a/b/gg", "ERR 8: multiple `g' options to `s' command"],
  ["s/a/b/pp", "ERR 8: multiple `p' options to `s' command"],
  ["s/a/b/2", "ok"],
  ["s/a/b/0", "ERR 7: number option to `s' command may not be zero"],
  ["s/a/b/2g", "ok"],
  ["s/a/b/22", "ok"],
  ["s/a/b/w", "ERR 7: missing filename in r/R/w/W commands"],
  ["s/a/b/w /dev/null", "ok"],
  ["s/a/b/e", "ok"],
  ["s/a/b/I", "ok"],
  ["s/a/b/i", "ok"],
  ["s/a/b/M", "ok"],
  ["s/a/b/m", "ok"],
  ["s/a/b/x", "ERR 7: unknown option to `s'"],
  ["s/a/\\1/", "ERR 7: invalid reference \\1 on `s' command's RHS"],
  ["s/\\(a\\)/\\1\\2/", "ERR 13: invalid reference \\2 on `s' command's RHS"],
  ["s/a/&&/", "ok"],
  ["s/a/\\&/", "ok"],
  ["s/a/\\n/", "ok"],
  ["s/a/\\t/", "ok"],
  ["s/a/\\x41/", "ok"],
  ["s/a/\\cA/", "ok"],
  ["s/a/\\d065/", "ok"],
  ["s/a/\\o101/", "ok"],
  ["s/a/\\L&/", "ok"],
  ["s/a/\\Ua\\E/", "ok"],
  ["s/a/\\u&/", "ok"],
  ["s//x/", "ok"],
  ["s/a//", "ok"],
  ["//p", "ok"],
  ["/a/p", "ok"],
  ["/a/Ip", "ok"],
  ["/a/Mp", "ok"],
  ["/a/IMp", "ok"],
  ["/a/x", "ok"],
  ["\\,a,p", "ok"],
  ["\\,a\\,b,p", "ok"],
  ["/a\\/b/p", "ok"],
  ["/[/]/p", "ok"],
  ["s/[/]/x/", "ok"],
  ["s/[^/]/x/", "ok"],
  ["$p", "ok"],
  ["$!p", "ok"],
  ["2,$p", "ok"],
  ["1~2p", "ok"],
  ["0~3p", "ok"],
  ["2~0p", "ok"],
  ["0p", "ERR 2: invalid usage of line address 0"],
  ["0,/a/p", "ok"],
  ["0,2p", "ERR 4: invalid usage of line address 0"],
  ["1,+2p", "ok"],
  ["1,~2p", "ok"],
  ["+1p", "ERR 2: invalid usage of +N or ~N as first address"],
  ["~2p", "ERR 2: invalid usage of +N or ~N as first address"],
  ["2,1p", "ok"],
  ["/a/,/b/p", "ok"],
  ["/a/,+1p", "ok"],
  ["/a/,~2p", "ok"],
  ["$,2p", "ok"],
  ["1,$p", "ok"],
  ["p # c", "ok"],
  ["p#c", "ok"],
  ["#c", "ok"],
  ["1#c", "ERR 2: comments don't accept any addresses"],
  ["#n", "ok"],
  ["# c\np", "ok"],
  ["p\n#c", "ok"],
  ["r", "ERR 1: missing filename in r/R/w/W commands"],
  ["r /dev/null", "ok"],
  ["r/dev/null", "ok"],
  ["w", "ERR 1: missing filename in r/R/w/W commands"],
  ["w /dev/null", "ok"],
  ["W /dev/null", "ok"],
  ["R /dev/null", "ok"],
  ["q5", "ok"],
  ["q 5", "ok"],
  ["q x", "ERR 3: extra characters after command"],
  ["Q", "ok"],
  ["Q 3", "ok"],
  ["l", "ok"],
  ["l 5", "ok"],
  ["l5", "ok"],
  ["l x", "ERR 3: extra characters after command"],
  ["v", "ok"],
  ["v 4.2", "ok"],
  ["v 9.9", "ERR 5: expected newer version of sed"],
  ["F", "ok"],
  ["z", "ok"],
  ["x;x", "ok"],
  ["=", "ok"],
  ["N;P;D", "ok"],
  ["{p;p}", "ok"],
  ["{p;p;}", "ok"],
  ["{p\np\n}", "ok"],
  ["{ p ; p }", "ok"],
  ["1{p}", "ok"],
  ["1{p};2{p}", "ok"],
  ["1{p}2{p}", "ERR 5: extra characters after command"],
  ["1{p} p", "ERR 6: extra characters after command"],
  ["1,2{p}", "ok"],
  ["{{p}}", "ok"],
  ["}{", "ERR 1: unexpected `}'"],
  ["y/a/b/;p", "ok"],
  ["y/a/b/ ;p", "ok"],
  ["s/a/b/ ;p", "ok"],
  ["s/a/b/;p", "ok"],
  ["s/a/b/g;p", "ok"],
  ["s/a/b/}", "ERR 7: unexpected `}'"],
  ["{s/a/b/}", "ok"],
  ["{y/a/b/}", "ok"],
  ["a text;p", "ok"],
  ["a\\\ntext\np", "ok"],
  ["a\\\ntext\\\nmore\np", "ok"],
  ["a  spaced", "ok"],
  ["a\\  spaced", "ok"],
  ["a\\\n  spaced", "ok"],
  ["a x\\\ny", "ok"],
  ["a x\ny", "ERR 5: unterminated `y' command"],
  ["$!{N;D}", "ok"],
  ["a\\\n", "ok"],
  ["a x\\", "ok"],
  ["i\\\nfoo", "ok"],
  ["i foo\nbar", "LABEL can't find label for jump to `ar'"],
  ["c\\\nfoo", "ok"],
  ["{a foo\n}", "ok"],
  ["{a foo}", "ERR 0: unmatched `{'"],
  ["1a\\\nfoo\n2p", "ok"],
  [":a;N;$!ba;s/\\n/ /g", "ok"],
  [":a b;p", "ok"],
  [":a;p;ba", "ok"],
  ["ba;:a", "ok"],
  ["{:a;p;ba}", "ok"],
  ["b a;:a", "ok"],
  [":a\nb a", "ok"],
  ["t a;:a", "ok"],
  [":a;:a", "ok"],
  ["s/a/b/;:x", "ok"],
  ["bx;:x;p", "ok"],
  [": a;ba", "ok"],
  [":a ;ba", "ok"],
  ["p;# comment\np", "ok"],
  ["{#c\np}", "ok"],
  ["y/abc/xyz/", "ok"],
  ["y/a/ /", "ok"],
  ["y,a\\,b,xyz,", "ok"],
  ["y/a\\\\b/xyz/", "ok"],
  ["y/a\\nb/xyz/", "ok"],
  ["y/a/b/ p", "ERR 8: extra characters after command"],
  ["y/a/b/p", "ERR 7: extra characters after command"],
  ["s|a|b|", "ok"],
  ["s,a,b,", "ok"],
  ["s a b ", "ok"],
  ["s\\na\\nb\\n", "ERR 9: unknown option to `s'"],
  ["s,a\\,b,X,", "ok"],
  ["s|a\\|b|X|", "ok"],
  ["s.a\\.b.X.", "ok"],
  ["s&a&b&", "ok"],
  ["s/a/\\\n/", "ok"],
  ["s/a\\\nb/X/", "ok"],
  ["s/a/b\\\nc/", "ok"],
  ["s/\\(a\\)\\(b\\)\\(c\\)\\(d\\)\\(e\\)\\(f\\)\\(g\\)\\(h\\)\\(i\\)\\(j\\)/\\9/", "ok"],
  ["s/a/b/w x y", "ok"],
  ["s/a/b/pw /dev/null", "ok"],
  ["s/a/b/gI", "ok"],
  ["s/a/b/Ig", "ok"],
  ["s/a/b/2p", "ok"],
  ["s/a/b/p2", "ok"],
  ["s/a/b/g2", "ok"],
  ["s/a/b/ g", "ok"],
  ["s/a/b/\ng", "ok"],
  ["1,3p", "ok"],
  ["1,3!p", "ok"],
  ["1,3 p", "ok"],
  ["1 ,3p", "ok"],
  ["1, 3p", "ok"],
  ["/a/ ,/b/p", "ok"],
  ["/a/, /b/p", "ok"],
  ["  p", "ok"],
  ["\n\np\n\n", "ok"],
  ["p\n\n;p", "ok"],
  ["{;p}", "ok"],
  ["{p};", "ok"],
  ["{p}}", "ERR 4: unexpected `}'"],
  ["{{p}", "ERR 0: unmatched `{'"],
  ["1{;}", "ok"],
  ["1!{p}", "ok"],
  ["1!{p;}", "ok"],
  ["1 ! { p }", "ok"],
  ["$!N", "ok"],
  ["$ p", "ok"],
  ["/a/ p", "ok"],
  ["/a/I p", "ok"],
  ["/a/ I p", "ok"],
  ["/a/Ip;p", "ok"],
  ["\\ca\\cp", "ERR 6: unterminated address regex"],
  ["\\%a%p", "ok"],
  ["\\|a\\|b|p", "ok"],
  ["/a/,p", "ERR 5: unexpected `,'"],
  ["/a//p", "ERR 4: unknown command: `/'"],
  ["/a", "ERR 2: unterminated address regex"],
  ["\\", "ERR 1: unterminated address regex"],
  ["\\a", "ERR 2: unterminated address regex"],
  ["1~p", "ok"],
  ["1~", "ERR 2: missing command"],
  ["~", "ERR 1: missing command"],
  ["1,~p", "ok"],
  ["1,+p", "ok"],
  ["1,+", "ERR 3: missing command"],
  ["5,2q", "ERR 4: command only uses one address"],
  ["e echo hi", "ok"],
  ["e", "ok"],
  ["s/a/b/e;p", "ok"],
  ["v 4.8;p", "ok"],
  ["v 99", "ERR 4: expected newer version of sed"],
  ["q;p", "ok"],
  ["q 1;p", "ok"],
  ["l;p", "ok"],
  ["l 2;p", "ok"],
  ["= ;p", "ok"],
  ["r /dev/null;p", "ok"],
  ["w /dev/null\np", "ok"],
  ["r a b", "ok"],
  ["r\n", "ERR 2: missing filename in r/R/w/W commands"],
  ["w\n", "ERR 2: missing filename in r/R/w/W commands"],
  ["y/abc/xyz/;p", "ok"],
  ["s|a\\|b|X|g", "ok"],
  ["/a/I,/b/Mp", "ok"],
  ["1~2{p;d}", "ok"],
  ["s/\\(a\\)\\(b\\)/\\2\\1/", "ok"],
  ["s/x/\\U&\\E!/2g", "ok"],
  ["#n\n/a/p", "ok"],
  ["a\\\nline1\\\nline2", "ok"],
  ["i\\  keep", "ok"],
  ["c\\\nrepl", "ok"],
  ["0,/a/s//X/", "ok"],
  ["/a/,+2!d", "ok"],
  ["2,~4p", "ok"],
  ["r in.txt", "ok"],
  ["/a/ s/a/b/", "ok"],
  ["{p;{p}}", "ok"],
  ["b end;p;:end", "ok"],
  ["t;T x;:x", "ok"],
  ["l 5;q 3", "ok"],
  ["1!G;h;$!d", "ok"],
  ["s/a/\\cA\\x41\\o101\\d065/", "ok"],
  ["s/[:alpha:]/X/", "CLASS"],
  ["/x/Ip;//d", "ok"],
  ["s/./\\l&/g", "ok"],
  ["F;z;=;x;H;g;G;h", "ok"],
  ["s/a/b/ I", "ok"],
  ["0r f", "ok"],
  ["0,3r f", "ERR 4: invalid usage of line address 0"],
  ["+0p", "ok"],
  ["~0p", "ok"],
  ["+p", "ok"],
  ["1,+0p", "ok"],
  ["s/a/\\c\\x/", "ERR 9: recursive escaping after \\c not allowed"],
  ["ba#c", "LABEL can't find label for jump to `a'"],
  [":a#c", "ok"],
  ["v 9#c", "ERR 3: expected newer version of sed"],
  ["v 9{", "ERR 4: expected newer version of sed"],
  ["b{x", "LABEL can't find label for jump to `{x'"],
  ["\\\ntext\np", "ERR 6: unterminated address regex"],
  ["s/\\(a\\)\\1\\2/x/", "ERR 14: Invalid back reference"],
  ["s/a/b/;s//c/g", "ok"],
  ["0~0p", "ERR 4: invalid usage of line address 0"],
  ["1~2~3p", "ERR 4: unknown command: `~'"],
  ["v {", "ERR 3: expected newer version of sed"],
  ["v 4.10", "ERR 6: expected newer version of sed"],
  ["v 4.9.1", "ERR 7: expected newer version of sed"],
  ["v abc", "ERR 5: expected newer version of sed"],
  ["v 5", "ERR 3: expected newer version of sed"],
  ["s", "ERR 1: unterminated `s' command"],
  ["s/", "ERR 2: unterminated `s' command"],
  ["s/a", "ERR 3: unterminated `s' command"],
  ["s/a/", "ERR 4: unterminated `s' command"],
  ["y", "ERR 1: unterminated `y' command"],
  ["y/", "ERR 2: unterminated `y' command"],
  ["y/a", "ERR 3: unterminated `y' command"],
  ["y/ab", "ERR 4: unterminated `y' command"],
  ["y/abc", "ERR 5: unterminated `y' command"],
  ["y/abc/", "ERR 6: unterminated `y' command"],
  ["y/abc/x", "ERR 7: unterminated `y' command"],
  ["y/abc/xy", "ERR 8: unterminated `y' command"],
  ["y/abc/xyz", "ERR 9: unterminated `y' command"],
  ["1", "ERR 1: missing command"],
  ["1,", "ERR 2: unexpected `,'"],
  ["1,3", "ERR 3: missing command"],
  ["1,3!", "ERR 4: missing command"],
  ["1,3!{", "ERR 0: unmatched `{'"],
  ["1,3!{p", "ERR 0: unmatched `{'"],
  ["1,3!{p;", "ERR 0: unmatched `{'"],
  ["1,3!{p;d", "ERR 0: unmatched `{'"],
  ["/", "ERR 1: unterminated address regex"],
  ["/a/", "ERR 3: missing command"],
  ["/a/I", "ERR 4: missing command"],
  ["/a/I,", "ERR 5: unexpected `,'"],
  ["/a/I,+", "ERR 6: missing command"],
  ["/a/I,+2", "ERR 7: missing command"],
  ["/a/I,+2s", "ERR 8: unterminated `s' command"],
  ["/a/I,+2s|", "ERR 9: unterminated `s' command"],
  ["/a/I,+2s|x", "ERR 10: unterminated `s' command"],
  ["/a/I,+2s|x|", "ERR 11: unterminated `s' command"],
  ["/a/I,+2s|x|y", "ERR 12: unterminated `s' command"],
  ["/a/I,+2s|x|y|", "ok"],
  ["a\\\nt", "ok"],
  ["a\\\nte", "ok"],
  ["a\\\ntex", "ok"],
  [":a", "ok"],
  [":a;N", "ok"],
  [":a;N;", "ok"],
  [":a;N;$", "ERR 6: missing command"],
  [":a;N;$!", "ERR 7: missing command"],
  [":a;N;$!b", "ok"],
  ["\\,", "ERR 2: unterminated address regex"],
  ["\\,a", "ERR 3: unterminated address regex"],
  ["\\,a,", "ERR 4: missing command"],
  ["s/[", "ERR 3: unterminated `s' command"],
  ["s/[/", "ERR 4: unterminated `s' command"],
  ["s/[/]", "ERR 5: unterminated `s' command"],
  ["s/[/]/", "ERR 6: unterminated `s' command"],
  ["s/[/]/x", "ERR 7: unterminated `s' command"],
];

const SEM_CASES = [
  ["s/a/\\n/", "", "\n"],
  ["s/a/\\n/3", "abc", "abc\n"],
  ["s/a/\\n/Ig", "", "\n"],
  ["s/a*/\\n/g", "abc", "\nb\nc\n\n"],
  ["s/a*/\\n/p", "", "\n\n\n\n"],
  ["s/a*/\\n/1", "abc", "\nbc\n"],
  ["s/b*/\\n/2", "", "\n"],
  ["s/b*/\\n/gp", "abc", "\na\nc\n\n\na\nc\n\n"],
  ["s/b*/\\n/w /dev/null", "", "\n\n"],
  ["s/x*/\\n/2g", "abc", "a\nb\nc\n\n"],
  ["s/x*/\\n/I", "", "\n\n"],
  ["s/\\(a\\)\\(b\\)\\?/\\n/", "abc", "\nc\n"],
  ["s/\\(a\\)\\(b\\)\\?/\\n/3", "", "\n"],
  ["s/\\(a\\)\\(b\\)\\?/\\n/Ig", "abc", "\nc\n"],
  ["s/./\\n/g", "", "\n"],
  ["s/./\\n/p", "abc", "\nbc\n\nbc\n"],
  ["s/./\\n/1", "", "\n"],
  ["s/\\w\\+/\\n/2", "abc", "abc\n"],
  ["s/\\w\\+/\\n/gp", "", "\n"],
  ["s/\\w\\+/\\n/w /dev/null", "abc", "\n\n"],
  ["s/[0-9]\\+/\\n/2g", "", "\n"],
  ["s/[0-9]\\+/\\n/I", "abc", "abc\n"],
  ["s/a\\|b/\\n/", "", "\n"],
  ["s/a\\|b/\\n/3", "abc", "abc\n"],
  ["s/a\\|b/\\n/Ig", "", "\n"],
  ["s/\\(.\\)\\1/\\n/g", "abc", "abc\n"],
  ["s/\\(.\\)\\1/\\n/p", "", "\n"],
  ["s/\\(.\\)\\1/\\n/1", "abc", "abc\n"],
  ["s/^/\\n/2", "", "\n"],
  ["s/^/\\n/gp", "abc", "\nabc\n\nabc\n"],
  ["s/^/\\n/w /dev/null", "", "\n\n"],
  ["s/$/\\n/2g", "abc", "abc\n"],
  ["s/$/\\n/I", "", "\n\n"],
  ["s/\\b/\\n/", "abc", "\nabc\n"],
  ["s/\\b/\\n/3", "", "\n"],
  ["s/\\b/\\n/Ig", "abc", "\nabc\n\n"],
  ["s/\\</\\n/g", "", "\n"],
  ["s/\\</\\n/p", "abc", "\nabc\n\nabc\n"],
  ["s/\\</\\n/1", "", "\n"],
  ["s/ */\\n/2", "abc", "a\nbc\n"],
  ["s/ */\\n/gp", "", "\n\n\n\n"],
  ["s/ */\\n/w /dev/null", "abc", "\nabc\n"],
  ["s/[[:upper:]]/\\n/2g", "", "\n"],
  ["s/[[:upper:]]/\\n/I", "abc", "\nbc\n"],
  ["s/\\(.\\)\\(.\\)/\\x26/", "abc", "&c\n"],
  ["s/./[&]/", "a^b.c\tb&x/y", "[a]^b.c\tb&x/y\n"],
  ["s/\\(\\)\\(.\\)/\\&/", "aabbcc", "&abbcc\n"],
  ["s/\\(x*\\)\\(a\\)/\\t/", "hello world", "hello world\n"],
  ["s/\\(.\\)\\(.\\)/\\n/", "", "\n"],
  ["s/./\\cA/", "AbC xYz", "\u0001bC xYz\n"],
  ["s/\\(\\)\\(.\\)/\\d065/", "a b  c", "A b  c\n"],
  ["s/\\(x*\\)\\(a\\)/\\o101/", "x1y22z333", "x1y22z333\n"],
  ["s/\\(.\\)\\(.\\)/\\x41/", "abc", "Ac\n"],
  ["s/./\\q/", "a^b.c\tb&x/y", "q^b.c\tb&x/y\n"],
  ["s/\\(\\)\\(.\\)/\\//", "aabbcc", "/abbcc\n"],
  ["s/\\(x*\\)\\(a\\)/\\\\/", "hello world", "hello world\n"],
  ["s/\\(.\\)\\(.\\)/\\0/", "", "\n"],
  ["s/./\\x5c/", "AbC xYz", "\\bC xYz\n"],
  ["s/\\(\\)\\(.\\)/\\x5cn/", "a b  c", "\\n b  c\n"],
  ["s/\\(x*\\)\\(a\\)/a\\\nz/", "x1y22z333", "x1y22z333\n"],
  ["s/\\(.\\)\\(.\\)/\\a\\f\\v\\r/", "abc", "\u0007\f\u000b\rc\n"],
  ["s/./\\U&x/", "a^b.c\tb&x/y", "AX^b.c\tb&x/y\n"],
  ["s/\\(\\)\\(.\\)/\\u&bc/", "aabbcc", "Abcabbcc\n"],
  ["s/\\(x*\\)\\(a\\)/\\L&/", "hello world", "hello world\n"],
  ["s/\\(.\\)\\(.\\)/&\\E&/", "", "\n"],
  ["s/./\\l\\U&/", "AbC xYz", "AbC xYz\n"],
  ["s/\\(\\)\\(.\\)/\\Ux\\Ey/", "a b  c", "Xy b  c\n"],
  ["s/\\(x*\\)\\(a\\)/\\u\\L&X/", "x1y22z333", "x1y22z333\n"],
  ["s/\\(.\\)\\(.\\)/\\U\\l&yz/", "abc", "aBYZc\n"],
  ["s/\\(\\)\\(.\\)/\\l\\1\\U\\2/", "aabbcc", "Aabbcc\n"],
  ["s/\\(x*\\)\\(a\\)/\\E\\u&/", "hello world", "hello world\n"],
  ["s/\\(.\\)\\(.\\)/\\c/", "", "\n"],
  ["s/./\\ca/", "AbC xYz", "\u0001bC xYz\n"],
  ["s/\\(\\)\\(.\\)/\\c\\\\/", "a b  c", "\u001c b  c\n"],
  ["s/\\(x*\\)\\(a\\)/\\xZ/", "x1y22z333", "x1y22z333\n"],
  ["s/\\(.\\)\\(.\\)/\\d/", "abc", "dc\n"],
  ["s/./\\o9/", "a^b.c\tb&x/y", "o9^b.c\tb&x/y\n"],
  ["s|a\\|b|X|", "abc", "abc\n"],
  ["s,a\\,b,X,", "a^b.c\tb&x/y", "a^b.c\tb&x/y\n"],
  ["s.a\\.b.X.", "aabbcc", "Xbcc\n"],
  ["s&a\\&b&X&", "hello world", "hello world\n"],
  ["s&a&[\\&]&", "", "\n"],
  ["s+a\\+b+X+", "AbC xYz", "AbC xYz\n"],
  ["s?a\\?b?X?", "a b  c", "a b  c\n"],
  ["s{a\\{2\\}{X{", "x1y22z333", "x1y22z333\n"],
  ["s1a1b1", "abc", "bbc\n"],
  ["s9a9\\99", "a^b.c\tb&x/y", "9^b.c\tb&x/y\n"],
  ["s a b ", "aabbcc", "babbcc\n"],
  ["s\ta\tb\t", "hello world", "hello world\n"],
  ["s;a;b;", "", "\n"],
  ["s/a\\/b/X/", "AbC xYz", "AbC xYz\n"],
  ["s/a/\\/b/", "a b  c", "/b b  c\n"],
  ["s*a\\*b*X*", "x1y22z333", "x1y22z333\n"],
  ["s^a\\^b^X^", "abc", "abc\n"],
  ["sxaxbx", "a^b.c\tb&x/y", "b^b.c\tb&x/y\n"],
  ["spapbp", "aabbcc", "babbcc\n"],
  ["s/[/]/X/g", "abc", "abc\n"],
  ["s/[\\/]/X/g", "a^b.c\tb&x/y", "a^b.c\tb&xXy\n"],
  ["s/[]/]/X/g", "aabbcc", "aabbcc\n"],
  ["s/[^]/]/X/g", "hello world", "XXXXXXXXXXX\n"],
  ["s/[[:alpha:]/]/X/g", "", "\n"],
  ["s/[[.a.]]/X/g", "AbC xYz", "AbC xYz\n"],
  ["s/[[=a=]]/X/g", "a b  c", "X b  c\n"],
  ["s/[/]*/X/g", "x1y22z333", "XxX1XyX2X2XzX3X3X3X\n"],
  ["s/[\\n]/X/g", "abc", "abc\n"],
  ["s/[\\t]/X/g", "a^b.c\tb&x/y", "a^b.cXb&x/y\n"],
  ["s/[[]/X/g", "aabbcc", "aabbcc\n"],
  ["s/[]]/X/g", "hello world", "hello world\n"],
  ["s/[^]]/X/g", "", "\n"],
  ["s/\\[/X/g", "AbC xYz", "AbC xYz\n"],
  ["s/a\\[b/X/g", "a b  c", "a b  c\n"],
  ["s/[a\\]/X/g", "x1y22z333", "x1y22z333\n"],
  ["s/[^/]/X/g", "abc", "XXX\n"],
  ["s/\\x5e/X/", "abc", "Xabc\n"],
  ["s/\\x2e/X/", "a^b.c\tb&x/y", "X^b.c\tb&x/y\n"],
  ["s/\\t/X/", "aabbcc", "aabbcc\n"],
  ["s/\\x26/X/", "hello world", "hello world\n"],
  ["s/\\d094/X/", "", "X\n"],
  ["s/\\o136/X/", "AbC xYz", "XAbC xYz\n"],
  ["s/\\cA/X/", "a b  c", "a b  c\n"],
  ["s/\\q/X/", "x1y22z333", "x1y22z333\n"],
  ["s/\\//X/", "abc", "abc\n"],
  ["s/b\\&/X/", "a^b.c\tb&x/y", "a^b.c\tXx/y\n"],
  ["s/\\./X/", "aabbcc", "aabbcc\n"],
  ["s/a\\tb/X/", "hello world", "hello world\n"],
  ["s/\\x41/X/", "", "\n"],
  ["s/\\x/X/", "AbC xYz", "AbC XYz\n"],
  ["s/\\cb/X/", "a b  c", "a b  c\n"],
  ["s/\\d065/X/", "x1y22z333", "x1y22z333\n"],
  ["s/\\n/X/", "abc", "abc\n"],
  ["y/abc/xyz/", "abc", "xyz\n"],
  ["y/a\\/b/xyz/", "a^b.c\tb&x/y", "x^z.c\tz&xyy\n"],
  ["y/ab/\\n\\\\/", "aabbcc", "\n\n\\\\cc\n"],
  ["y/\\n/X/", "hello world", "hello world\n"],
  ["y/a/\\t/", "", "\n"],
  ["y/a/\\x/", "AbC xYz", "AbC xYz\n"],
  ["y,a\\,b,xyz,", "a b  c", "x z  c\n"],
  ["y/a\\\\b/xyz/", "x1y22z333", "x1y22z333\n"],
  ["y/\\x41/B/", "abc", "abc\n"],
  ["y/a/\\q/", "a^b.c\tb&x/y", "q^b.c\tb&x/y\n"],
  ["y/\\q/b/", "aabbcc", "aabbcc\n"],
  ["y/a/\\cA/", "hello world", "hello world\n"],
  ["y/abc/\\x41\\x42\\x43/", "", "\n"],
  ["y/ !/_?/", "AbC xYz", "AbC_xYz\n"],
  ["y/a/\\//", "a b  c", "/ b  c\n"],
  ["y|a\\|b|xyz|", "x1y22z333", "x1y22z333\n"],
  ["y/\\d065/b/", "abc", "abc\n"],
  ["y/\\o101/b/", "a^b.c\tb&x/y", "a^b.c\tb&x/y\n"],
  ["a text", "abc", "abc\ntext\n"],
  ["i text", "a^b.c\tb&x/y", "text\na^b.c\tb&x/y\n"],
  ["a  two  spaces", "a^b.c\tb&x/y", "a^b.c\tb&x/y\ntwo  spaces\n"],
  ["c  two  spaces", "hello world", "two  spaces\n"],
  ["a\\", "aabbcc", "aabbcc\n"],
  ["a\\\ntext", "hello world", "hello world\ntext\n"],
  ["i\\\ntext", "", "text\n\n"],
  ["a\\\n  indented", "", "\n  indented\n"],
  ["c\\\n  indented", "a b  c", "  indented\n"],
  ["a\\text", "AbC xYz", "AbC xYz\ntext\n"],
  ["a\\  text", "a b  c", "a b  c\n  text\n"],
  ["i\\  text", "x1y22z333", "  text\nx1y22z333\n"],
  ["a one\\\ntwo", "x1y22z333", "x1y22z333\none\ntwo\n"],
  ["c one\\\ntwo", "a^b.c\tb&x/y", "one\ntwo\n"],
  ["a\\\none\\\ntwo", "abc", "abc\none\ntwo\n"],
  ["a x\\ty", "a^b.c\tb&x/y", "a^b.c\tb&x/y\nx\ty\n"],
  ["i x\\ty", "aabbcc", "x\ty\naabbcc\n"],
  ["a x\\\\y", "aabbcc", "aabbcc\nx\\y\n"],
  ["c x\\\\y", "", "x\\y\n"],
  ["a x\\qy", "hello world", "hello world\nxqy\n"],
  ["a\\\nx\\ty", "", "\nx\ty\n"],
  ["i\\\nx\\ty", "AbC xYz", "x\ty\nAbC xYz\n"],
  ["a foo\\", "AbC xYz", "AbC xYz\nfoo\n"],
  ["c foo\\", "x1y22z333", "foo\n"],
  ["a \\  lead", "a b  c", "a b  c\n  lead\n"],
  ["a  \\  lead", "x1y22z333", "x1y22z333\n  lead\n"],
  ["i  \\  lead", "abc", "  lead\nabc\n"],
  ["a a\\nb", "abc", "abc\na\nb\n"],
  ["c a\\nb", "aabbcc", "a\nb\n"],
  ["a\\\\n", "a^b.c\tb&x/y", "a^b.c\tb&x/y\n\n\n"],
  ["a\\\nx\\\ny", "aabbcc", "aabbcc\nx\ny\n"],
  ["i\\\nx\\\ny", "hello world", "x\ny\nhello world\n"],
  ["a text;p", "hello world", "hello world\ntext;p\n"],
  ["c text;p", "AbC xYz", "text;p\n"],
  ["a x\n", "", "\nx\n"],
  ["a\n", "AbC xYz", "AbC xYz\n\n"],
  ["i\n", "a b  c", "\na b  c\n"],
  ["a x\\x41y", "a b  c", "a b  c\nxAy\n"],
  ["c x\\x41y", "abc", "xAy\n"],
  ["a x\\d065y", "x1y22z333", "x1y22z333\nxAy\n"],
  ["a x\\o101y", "abc", "abc\nxAy\n"],
  ["i x\\o101y", "a^b.c\tb&x/y", "xAy\na^b.c\tb&x/y\n"],
  ["a x\\cAy", "a^b.c\tb&x/y", "a^b.c\tb&x/y\nx\u0001y\n"],
  ["c x\\cAy", "hello world", "x\u0001y\n"],
  ["a \\a\\f\\v\\r", "aabbcc", "aabbcc\na\f\u000b\r\n"],
  ["a\\\n", "hello world", "hello world\n\n"],
  ["i\\\n", "", "\n\n"],
  ["a\\\n\n", "", "\n\n"],
  ["c\\\n\n", "a b  c", "\n"],
  ["a one\\\n  two", "AbC xYz", "AbC xYz\none\n  two\n"],
  ["a a\\\\\\\nb", "a b  c", "a b  c\na\\\nb\n"],
  ["i a\\\\\\\nb", "x1y22z333", "a\\\nb\nx1y22z333\n"],
  ["a\\\n\\  lead", "x1y22z333", "x1y22z333\n  lead\n"],
  ["c\\\n\\  lead", "a^b.c\tb&x/y", "  lead\n"],
  ["a\\\nlast\\", "abc", "abc\nlast\n"],
  ["#n\ns/a/b/", "abc", ""],
];

// ---------------------------------------------------------------- 1. verdicts of real GNU sed 4.9
for (const [script, want] of ERR_CASES) {
  const got = verdict(script);
  ok('verdict ' + JSON.stringify(script) + ' -> ' + want, got === want, 'got: ' + got);
}

// ---------------------------------------------------------------- 2. s / y / a / i / c results of real GNU sed 4.9
for (const [script, input, want] of SEM_CASES) {
  let got;
  try { got = runOne(script, input); } catch (e) { got = 'THROWN ' + e.message; }
  ok('result ' + JSON.stringify(script) + ' on ' + JSON.stringify(input), got === want, JSON.stringify({ want, got }));
}

// ---------------------------------------------------------------- 3. shape of the parse result
{
  const r = parseScript('1{p;b end};p;:end');
  ok('shape: block, branch and label entries', r.cmds.length === 6 && r.cmds.map((c) => c.cmd).join('') === '{pb}p:');
  ok('shape: { knows its matching } (blockEnd) and carries its address', r.cmds[0].blockEnd === 3 && r.cmds[0].a1.type === 'num' && r.cmds[0].a1.n === 1);
  ok('shape: a branch jumps to the index of its label entry', r.cmds[2].label === 'end' && r.cmds[2].jump === 5 && r.cmds[5].label === 'end');
  const e = parseScript('b;t;T');
  ok('shape: b / t / T without a label jump to the end of the script', e.cmds.every((c) => c.jump === e.cmds.length));
  const n = parseScript('{{p};p}');
  ok('shape: nested blocks get their own blockEnd', n.cmds[0].blockEnd === 5 && n.cmds[1].blockEnd === 3);
}
{
  const t = (script) => parseScript(script).cmds[0];
  const c1 = t('1,3p');
  ok('address: 1,3', c1.a1.type === 'num' && c1.a1.n === 1 && c1.a2.type === 'num' && c1.a2.n === 3 && !c1.negate);
  const c2 = t('$!p');
  ok('address: $! is last with negate', c2.a1.type === 'last' && c2.negate === true && c2.a2 === null);
  const c3 = t('/a/I,+2p');
  ok('address: /re/I,+N', c3.a1.type === 'regex' && c3.a1.regex.icase === true && c3.a2.type === 'plus' && c3.a2.n === 2);
  const c4 = t('2~3p');
  ok('address: first~step', c4.a1.type === 'step' && c4.a1.first === 2 && c4.a1.step === 3);
  const c5 = t('0,/x/p');
  ok('address: 0,/re/', c5.a1.type === 'num' && c5.a1.n === 0 && c5.a2.type === 'regex');
  const c6 = t('1,~4p');
  ok('address: addr1,~N', c6.a2.type === 'mod' && c6.a2.n === 4);
  const c7 = t('2~0p');
  ok('address: first~0 is plain line number first', c7.a1.type === 'num' && c7.a1.n === 2);
  const c8 = t('+0p');
  ok('address: +0 as a first address is a null address (matches every line)', c8.a1.type === 'null');
  const c9 = t('2,+0p');
  ok('address: +0 as a second address ends the range on its first line', c9.a2.type === 'plus' && c9.a2.n === 0);
  const c10 = t('\\,a/b,Mp');
  ok('address: custom delimiter and M flag', c10.a1.regex.source === 'a/b' && c10.a1.regex.multiline === true);
  const c11 = t('//p');
  ok('address: the empty regex is marked empty (the runner uses the last regex)', c11.a1.regex.empty === true && c11.a1.regex.compiled === null);
  ok('address: 0r file is allowed', parseScript('0r f').cmds[0].file === 'f');
}
{
  ok('silent: a script starting with #n', parseScript('#n\np').silent === true && parseScript('#n\np').cmds.length === 1);
  ok('silent: #n followed by text on the first line is silent too (as in GNU sed)', parseScript('#nx\np').silent === true);
  ok('silent: not when # is not the first character, or the letter differs', parseScript(' #n\np').silent === false && parseScript('#N\np').silent === false && parseScript('p\n#n').silent === false);
  ok('comments and separators produce no entries', parseScript('# c\n;;p # tail\n').cmds.length === 1);
}
{
  const s1 = parseScript('s/\\(a\\)\\(b\\)/\\2-&\\n/').cmds[0];
  ok('s: replacement pieces for \\2-&\\n', JSON.stringify(s1.repl.pieces) === JSON.stringify([{ prefix: '', ref: 2, type: 0 }, { prefix: '-', ref: 0, type: 0 }, { prefix: '\n', ref: -1, type: 0 }]) && s1.repl.maxId === 2);
  const s2 = parseScript('s/./\\U&x\\E!/').cmds[0];
  ok('s: case-conversion pieces carry their type (1 = upper)', s2.repl.pieces.map((p) => p.type).join(',') === '0,1,1,0' && s2.repl.pieces[3].prefix === '!');
  const s3 = parseScript('s/a/b/2gpI').cmds[0];
  ok('s: flags 2 g p I', s3.nth === 2 && s3.global === true && s3.print === 1 && s3.regex.icase === true && s3.eval === false && s3.wfile === null);
  const s4 = parseScript('s/a/b/w out file.txt').cmds[0];
  ok('s: w flag takes the rest of the line as the file name', s4.wfile === 'out file.txt');
  const s5 = parseScript('s/a/b/ g').cmds[0];
  ok('s: whitespace between flags is skipped (a following g is still the flag)', s5.global === true);
  const s6 = parseScript('s/a\\|b/X/M').cmds[0];
  ok('s: the regex is compiled (posix-regex) with its flags', s6.regex.compiled.nsub === 0 && s6.regex.multiline === true && s6.regex.source === 'a\\|b');
}
{
  const y = parseScript('y/abc/xyz/').cmds[0];
  ok('y: map of characters', y.map.size === 3 && y.map.get('a') === 'x' && y.map.get('c') === 'z');
  const y2 = parseScript('y/a\\/b/xyz/').cmds[0];
  ok('y: an escaped delimiter is a character', y2.map.get('/') === 'y');
  ok('a: text ends in a newline', parseScript('a hi').cmds[0].text === 'hi\n');
  ok('a: a bare a\\ has empty text', parseScript('a\\').cmds[0].text === '');
  ok('i: backslash-newline continues the text', parseScript('i one\\\ntwo').cmds[0].text === 'one\ntwo\n');
  ok('r w R W take the rest of the line', parseScript('r a b;c').cmds[0].file === 'a b;c' && parseScript('w x').cmds[0].file === 'x');
  ok('q / Q / l arguments', parseScript('q5').cmds[0].exit === 5 && parseScript('Q').cmds[0].exit === -1 && parseScript('l 8').cmds[0].width === 8 && parseScript('l').cmds[0].width === -1);
  ok('e records its command text', parseScript('e echo hi').cmds[0].command === 'echo hi\n' && parseScript('e').cmds[0].command === '');
  ok('v checks the version and produces no entry', parseScript('v 4.2;p').cmds.length === 1);
}
{
  let err = null;
  try { parseScript('s/a/b/x'); } catch (e) { err = e; }
  ok('error: object fields', err instanceof SedParseError && err instanceof Error && err.char === 7 && err.reason === 'unknown option to `s\'' && err.message === '-e expression #1, char 7: unknown option to `s\'');
  let err2 = null;
  try { parseScript('b nowhere'); } catch (e) { err2 = e; }
  ok('error: a missing label has no position', err2 instanceof SedParseError && err2.char === null && err2.message === 'can\'t find label for jump to `nowhere\'');
  let err3 = null;
  try { parseScript('{p'); } catch (e) { err3 = e; }
  ok('error: an unmatched { is reported at char 0, like sed', err3 && err3.char === 0 && err3.message === '-e expression #1, char 0: unmatched `{\'');
  ok('error: positions count bytes, not characters', verdict('s/\u00e9/x/Z') === 'ERR 8: unknown option to `s\'');
  ok('error: invalid regex messages come from posix-regex, positioned after the flags', verdict('s/a\\{1/x/g') === 'ERR 10: Unmatched \\{');
}
{
  for (const sc of ['r f', 'w f', 'R f', 'W f', 'e', 's/a/b/w f', 's/a/b/e']) {
    ok('sandbox: ' + JSON.stringify(sc) + ' is refused', /disabled in sandbox mode/.test(verdict(sc, { sandbox: true })), verdict(sc, { sandbox: true }));
  }
  ok('sandbox: other commands are fine', verdict('s/a/b/g;p;y/a/b/', { sandbox: true }) === 'ok');
  ok('sandbox: positions match sed (char 1 for r, char 7 for the s flag)', verdict('r f', { sandbox: true }) === 'ERR 1: e/r/w commands disabled in sandbox mode' && verdict('s/a/b/w f', { sandbox: true }) === 'ERR 7: e/r/w commands disabled in sandbox mode');
  const ere = parseScript('s/(a|b)+/x/', { extended: true }).cmds[0];
  const bre = parseScript('s/(a|b)+/x/').cmds[0];
  ok('extended option: -E syntax for s', ere.regex.compiled.nsub === 1 && bre.regex.compiled.nsub === 0);
}
{
  ok('normalizeText: escapes in a/i/c text', normalizeText('\\x41\\t\\q\\\\', 'buffer') === 'A\tq\\');
  ok('normalizeText: a produced & stays literal in a replacement', normalizeText('\\x26', 'replacement') === '\\&');
  ok('normalizeText: a produced & is raw in a regex', normalizeText('\\x5e', 'regex') === '^');
  let thrown = null;
  try { normalizeText('\\c\\x', 'replacement'); } catch (e) { thrown = e; }
  ok('normalizeText: \\c followed by a lone backslash is an error', thrown instanceof SedParseError && /recursive escaping/.test(thrown.reason));
}

console.log('\n' + pass + ' passed, ' + bad + ' failed');
process.exit(bad === 0 ? 0 : 1);
