'use strict';
// tools/sed-oracle/corpus.js - the script corpora shared by the parser tools (see README.md).
const fs = require('fs');
const path = require('path');

// ~290 hand-written seed scripts (valid and invalid), one JSON string per line
const SEEDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'seeds.json'), 'utf8'));

// extra seeds for parse-diff.js
const EXTRA = ['s/a/b/;p', 'y/abc/xyz/;p', 's|a\\|b|X|g', '/a/I,/b/Mp', '1~2{p;d}', '$!{N;D}', ':a;N;$!ba;s/\\n/ /g', 's/\\(a\\)\\(b\\)/\\2\\1/', 's/x/\\U&\\E!/2g', '#n\n/a/p', 'a\\\nline1\\\nline2', 'i\\  keep', 'c\\\nrepl', '0,/a/s//X/', '/a/,+2!d', '2,~4p', 's/[/]/x/', 's/a/b/w out.txt', 'r in.txt', 'y/ab/\\n\\\\/', '/a/ s/a/b/', '{p;{p}}', 'b end;p;:end', 't;T x;:x', 'l 5;q 3', '1!G;h;$!d', 'v 4.2', 's/a/\\cA\\x41\\o101\\d065/', 's/[:alpha:]/X/', '/x/Ip;//d', 's/./\\l&/g', 'N;P;D', 'e', 'w /dev/null', 'F;z;=;x;H;g;G;h', 's/a/b/ I', 's/a/b/gpw f', '0r f', '0,3r f', '+0p', '~0p', '+p', '1,+0p', 's/a/\\c\\x/', 'ba#c', ':a#c', 'v 9#c', 'v 9{', 'b{x', 's/\\(a\\)\\1\\2/x/', 's/a/b/;s//c/g', '0~0p', '1~2~3p'];

// the extra seeds that were used to record the tables in test/sed-parse.test.js (gen-parse-test.js)
const EXTRA_TEST = ['s/a/b/;p', 'y/abc/xyz/;p', 's|a\\|b|X|g', '/a/I,/b/Mp', '1~2{p;d}', '$!{N;D}', ':a;N;$!ba;s/\\n/ /g', 's/\\(a\\)\\(b\\)/\\2\\1/', 's/x/\\U&\\E!/2g', '#n\n/a/p', 'a\\\nline1\\\nline2', 'i\\  keep', 'c\\\nrepl', '0,/a/s//X/', '/a/,+2!d', '2,~4p', 's/[/]/x/', 'r in.txt', 'y/ab/\\n\\\\/', '/a/ s/a/b/', '{p;{p}}', 'b end;p;:end', 't;T x;:x', 'l 5;q 3', '1!G;h;$!d', 'v 4.2', 's/a/\\cA\\x41\\o101\\d065/', 's/[:alpha:]/X/', '/x/Ip;//d', 's/./\\l&/g', 'N;P;D', 'F;z;=;x;H;g;G;h', 's/a/b/ I', '0r f', '0,3r f', '+0p', '~0p', '+p', '1,+0p', 's/a/\\c\\x/', 'ba#c', ':a#c', 'v 9#c', 'v 9{', 'b{x', '\\\ntext\np', 's\\na\\nb\\n', 's/\\(a\\)\\1\\2/x/', 's/a/b/;s//c/g', '0~0p', '1~2~3p', 'v {', 'v 4.10', 'v 4.9.1', 'v abc', 'v 5'];

// the prefixes of these seeds are added to the recorded error table as well
const PREFIX_SEEDS = ['s/a/b/2gp', 'y/abc/xyz/', '1,3!{p;d}', '/a/I,+2s|x|y|g', 'a\\\ntext', ':a;N;$!ba', '\\,a,p', 's/[/]/x/'];

// ---- single s / y / a / i / c commands (parse-sem.js and gen-parse-test.js)
const INPUTS = ['abc', 'a^b.c\tb&x/y', 'aabbcc', 'hello world', '', 'AbC xYz', 'a b  c', 'x1y22z333'];
const FLAG_RES = ['a', 'a*', 'b*', 'x*', '\\(a\\)\\(b\\)\\?', '.', '\\w\\+', '[0-9]\\+', 'a\\|b', '\\(.\\)\\1', '^', '$', '\\b', '\\<', ' *', '[[:upper:]]'];
const FLAGS = ['', 'g', '2', '2g', '3', 'p', 'gp', 'I', 'Ig', '1', 'w /dev/null'];
const FLAG_REPS = ['X', '<&>', '[\\1]', '\\n', ''];
const REPS = ['\\x26', '[&]', '\\&', '\\t', '\\n', '\\cA', '\\d065', '\\o101', '\\x41', '\\q', '\\/', '\\\\', '\\0', '\\x5c', '\\x5cn', 'a\\\nz', '\\a\\f\\v\\r', '\\U&x', '\\u&bc', '\\L&', '&\\E&', '\\l\\U&', '\\Ux\\Ey', '\\u\\L&X', '\\U\\l&yz', '\\u\\1\\2', '\\l\\1\\U\\2', '\\E\\u&', '\\c', '\\ca', '\\c\\\\', '\\xZ', '\\d', '\\o9', '\\'];
const REP_RES = ['\\(.\\)\\(.\\)', '.', '\\(\\)\\(.\\)', '\\(x*\\)\\(a\\)'];
const DELIMS = [['|', 'a\\|b', 'X'], [',', 'a\\,b', 'X'], ['.', 'a\\.b', 'X'], ['&', 'a\\&b', 'X'], ['&', 'a', '[\\&]'], ['+', 'a\\+b', 'X'], ['?', 'a\\?b', 'X'], ['{', 'a\\{2\\}', 'X'], ['1', 'a', 'b'], ['9', 'a', '\\9'], [' ', 'a', 'b'], ['\t', 'a', 'b'], [';', 'a', 'b'], ['/', 'a\\/b', 'X'], ['/', 'a', '\\/b'], ['*', 'a\\*b', 'X'], ['^', 'a\\^b', 'X'], ['x', 'a', 'b'], ['p', 'a', 'b']];
const BRACKETS = ['[/]', '[\\/]', '[]/]', '[^]/]', '[[:alpha:]/]', '[[.a.]]', '[[=a=]]', '[/]*', '[\\n]', '[\\t]', '[[]', '[]]', '[^]]', '\\[', 'a\\[b', '[a\\]', '[^/]'];
const REGEX_ESC = ['\\x5e', '\\x2e', '\\t', '\\x26', '\\d094', '\\o136', '\\cA', '\\q', '\\/', 'b\\&', '\\.', 'a\\tb', '\\x41', '\\x', '\\cb', '\\d065', '\\n'];
const YS = ['y/abc/xyz/', 'y/a\\/b/xyz/', 'y/ab/\\n\\\\/', 'y/\\n/X/', 'y/a/\\t/', 'y/a/\\x/', 'y,a\\,b,xyz,', 'y/a\\\\b/xyz/', 'y/\\x41/B/', 'y/a/\\q/', 'y/\\q/b/', 'y/a/\\cA/', 'y/abc/\\x41\\x42\\x43/', 'y/ !/_?/', 'y/a/\\//', 'y|a\\|b|xyz|', 'y/\\d065/b/', 'y/\\o101/b/'];
const BODIES = [' text', '  two  spaces', '\\', '\\\ntext', '\\\n  indented', '\\text', '\\  text', ' one\\\ntwo', '\\\none\\\ntwo', ' x\\ty', ' x\\\\y', ' x\\qy', '\\\nx\\ty', ' foo\\', ' \\  lead', '  \\  lead', ' a\\nb', '\\\\n', '\\\nx\\\ny', ' text;p', ' x\n', '\n', ' x\\x41y', ' x\\d065y', ' x\\o101y', ' x\\cAy', ' \\a\\f\\v\\r', '\\\n', '\\\n\n', ' one\\\n  two', ' a\\\\\\\nb', '\\\n\\  lead', '\\\nlast\\'];

// every script of the full semantic grid
function semScripts() {
  const out = [];
  for (const r of FLAG_RES) for (const f of FLAGS) for (const rep of FLAG_REPS) out.push('s/' + r + '/' + rep + '/' + f);
  for (const rep of REPS) for (const re of REP_RES) out.push('s/' + re + '/' + rep + '/');
  for (const [d, re, rep] of DELIMS) out.push('s' + d + re + d + rep + d, 's' + d + re + d + rep + d + 'g');
  for (const re of BRACKETS) out.push('s/' + re + '/X/', 's/' + re + '/X/g');
  for (const re of REGEX_ESC) out.push('s/' + re + '/X/', 's/' + re + '/X/g');
  for (const y of YS) out.push(y);
  for (const k of ['a', 'i', 'c']) for (const b of BODIES) out.push(k + b);
  out.push('#n\np', '#n\ns/a/b/');
  return out;
}

module.exports = { SEEDS, EXTRA, EXTRA_TEST, PREFIX_SEEDS, INPUTS, FLAG_RES, FLAGS, FLAG_REPS, REPS, REP_RES, DELIMS, BRACKETS, REGEX_ESC, YS, BODIES, semScripts };
