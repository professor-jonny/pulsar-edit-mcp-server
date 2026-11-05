'use strict';
// Pins the CURRENT behaviour of the two pure
// helpers that replace-all, sed and replace-across-files share:
//   lib/string-utils.js  applyReplacement(rep, m, groups, pre, post, namedGroups)
//                        escapeRegex(str)
// Expected values were taken from a probe run (print first, assert second).
// Run: node test/string-utils.replace.test.js
// SU_PATH (env) points the test at a different copy of string-utils.js; the
// mutation harness uses it. Handler-level behaviour of replace-all and sed is
// NOT covered here (those handlers are inline closures that need atom).
const path = require('path');
const suPath = process.env.SU_PATH || path.join(__dirname, '..', 'lib', 'string-utils.js');
const { applyReplacement: ar, escapeRegex: er, unpackReplaceArgs: un } = require(suPath);

let passed = 0;
let failed = 0;
function check(name, fn, expected) {
  let actual;
  try { actual = fn(); } catch (e) { actual = 'THROW: ' + e.message; }
  if (actual === expected) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + ': got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)); }
}

// ---- applyReplacement ------------------------------------------------------
check('AR1 no tokens is returned unchanged', () => ar('xyz', 'M', [], 'PRE', 'POST'), 'xyz');
check('AR2 $1 and $2 pick capture groups', () => ar('$1-$2', 'M', ['a', 'b'], 'PRE', 'POST'), 'a-b');
check('AR3 $& is the whole match', () => ar('<$&>', 'M', [], 'PRE', 'POST'), '<M>');
check('AR4 $` is pre and $\' is post', () => ar('[$`|$\']', 'M', [], 'PRE', 'POST'), '[PRE|POST]');
check('AR5 $0 is DROPPED (native JS keeps it literal)', () => ar('a$0b', 'M', ['a'], 'PRE', 'POST'), 'ab');
check('AR6 a group number above the group count gives empty', () => ar('a$3b', 'M', ['a', 'b'], 'PRE', 'POST'), 'ab');
check('AR7 $$ stays LITERAL (native JS turns it into one $)', () => ar('a$$b', 'M', [], 'PRE', 'POST'), 'a$$b');
check('AR8 $10 with 2 groups reads BOTH digits and gives empty (native: $1 then 0)', () => ar('$10', 'M', ['a', 'b'], 'PRE', 'POST'), '');
check('AR9 $10 with 10 groups gives the tenth group', () => ar('$10', 'M', ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'TEN'], 'PRE', 'POST'), 'TEN');
check('AR10 $<n> uses the named group', () => ar('$<n>!', 'M', [], 'PRE', 'POST', { n: 'NAMED' }), 'NAMED!');
check('AR11 $<n> with no namedGroups object gives empty', () => ar('$<n>!', 'M', [], 'PRE', 'POST'), '!');
check('AR12 $<n> with a missing key gives empty', () => ar('$<n>!', 'M', [], 'PRE', 'POST', { z: 1 }), '!');
check('AR13 an unclosed $<n stays literal', () => ar('$<n', 'M', [], 'PRE', 'POST'), '$<n');
check('AR14 undefined pre and post give empty', () => ar('[$`|$\']', 'M', [], undefined, undefined), '[|]');
check('AR15 an undefined group gives empty', () => ar('$1|$2', 'M', [undefined, 'b'], 'PRE', 'POST'), '|b');
check('AR16 an empty replacement gives empty', () => ar('', 'M', [], 'PRE', 'POST'), '');
check('AR17 a lone $ stays literal', () => ar('cost $', 'M', [], 'PRE', 'POST'), 'cost $');
check('AR18 $ followed by a letter stays literal', () => ar('$x', 'M', [], 'PRE', 'POST'), '$x');
check('AR19 inserted text is not expanded again', () => ar('$1', 'M', ['$&'], 'PRE', 'POST'), '$&');

// ---- native JS semantics, pinned only to document the divergences above ----
check('N1 native $$ gives one $', () => 'a'.replace(/a/, '$$'), '$');
check('N2 native $10 with 2 groups is $1 then 0', () => 'ab'.replace(/(a)(b)/, '$10'), 'a0');
check('N3 native $0 stays literal', () => 'a'.replace(/(a)/, 'x$0y'), 'x$0y');

// ---- unpackReplaceArgs (named-group fix, 2026-10-10) -------------------------
// Values come from probe_ura.js, which fed REAL String#replace callbacks through the helper.
function capture(text, re) {
  const out = [];
  text.replace(re, function () { out.push(un(arguments)); return ''; });
  return JSON.stringify(out);
}
// The same composition replace-all, sed and replace-across-files now use.
function viaReplace(text, re, rep) {
  return text.replace(re, function () {
    const a = un(arguments);
    return ar(rep, a.m, a.groups, text.slice(0, a.offset), text.slice(a.offset + a.m.length), a.named);
  });
}
check('U1 no capture groups', () => capture('xay', /a/g), '[{"m":"a","groups":[],"offset":1,"string":"xay"}]');
check('U2 one numbered group', () => capture('xay', /(a)/g), '[{"m":"a","groups":["a"],"offset":1,"string":"xay"}]');
check('U3 a group that did not take part is undefined (JSON null)', () => capture('xby', /(a)?(b)/g), '[{"m":"b","groups":[null,"b"],"offset":1,"string":"xby"}]');
check('U4 a named group is split off as named, NOT left in groups or read as the offset', () => capture('xay', /(?<w>a)/g), '[{"m":"a","groups":["a"],"offset":1,"string":"xay","named":{"w":"a"}}]');
check('U5 numbered plus named group', () => capture('xaby', /(a)(?<w>b)/g), '[{"m":"ab","groups":["a","b"],"offset":1,"string":"xaby","named":{"w":"b"}}]');
check('U6 offsets of two matches', () => JSON.stringify(JSON.parse(capture('a-a', /a/g)).map(x => x.offset)), '[0,2]');
check('U7 a plain arguments object without a groups object', () => JSON.stringify((function () { return un(arguments); })('M', 'g1', 7, 'TEXT')), '{"m":"M","groups":["g1"],"offset":7,"string":"TEXT"}');
check('U8 a plain arguments object with a groups object', () => JSON.stringify((function () { return un(arguments); })('M', 'g1', 7, 'TEXT', { w: 'g1' })), '{"m":"M","groups":["g1"],"offset":7,"string":"TEXT","named":{"w":"g1"}}');
check('U9 an array works as well as arguments', () => JSON.stringify(un(['M', 7, 'TEXT'])), '{"m":"M","groups":[],"offset":7,"string":"TEXT"}');
check('U10 a null last argument is the string, not a groups object', () => JSON.stringify(un(['M', 7, null])), '{"m":"M","groups":[],"offset":7,"string":null}');
check('E1 named group: $` and $\' are right (the old slots gave [|foo|const foo = 2;])', () => viaReplace('const foo = 2;', /(?<w>foo)/g, '[$`|$<w>|$\']'), 'const [const |foo| = 2;] = 2;');
check('E2 numbered group gives the same text', () => viaReplace('const foo = 2;', /(foo)/g, '[$`|$1|$\']'), 'const [const |foo| = 2;] = 2;');
check('E3 $<length> with NO named group is empty (the old code gave the text length 14)', () => viaReplace('const foo = 2;', /(foo)/g, '$<length>'), 'const  = 2;');
check('E4 $<0> with NO named group is empty (the old code gave the first character)', () => viaReplace('const foo = 2;', /(foo)/g, '$<0>'), 'const  = 2;');
check('E5 two named hits each get their own pre and post', () => viaReplace('foo foo', /(?<w>foo)/g, '[$`|$<w>|$\']'), '[|foo| foo] [foo |foo|]');

// ---- escapeRegex -----------------------------------------------------------
check('ER1 escapes . and *', () => er('a.b*c'), 'a\\.b\\*c');
check('ER2 escapes every special character', () => er('.*+?^${}()|[]\\'), '\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
check('ER3 leaves hyphen and slash alone', () => er('a-b/c'), 'a-b/c');
check('ER4 empty string stays empty', () => er(''), '');
check('ER5 round trip: the escaped text matches itself literally', () => String(new RegExp(er('a.b(c)[d]')).test('a.b(c)[d]')), 'true');
check('ER6 the dot no longer matches any character', () => String(new RegExp(er('a.b')).test('axb')), 'false');
check('ER7 a dollar sign is matched literally', () => String(new RegExp(er('a$')).test('a$')), 'true');

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
