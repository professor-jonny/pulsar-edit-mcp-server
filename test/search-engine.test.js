'use strict';
// R4g (2026-10-31): tests for lib/search-engine.js, the shared pattern compiler and line scanner of
// find-text, grep-file, grep-project and search-functions.
//   Sections 1 and 2  pin down the behaviour that must NOT change (the literal path, scanLines options).
//   Sections 3 to 9   specify the new behaviour: regex:true is a POSIX BRE like plain grep, extended:true
//                     is an ERE like grep -E, both compiled by lib/posix-regex.js (the engine of sed).
// Run from the package root:   node test/search-engine.test.js
const { compilePattern, scanLines } = require('../lib/search-engine');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (!cond && detail !== undefined ? '\n       ' + detail : ''));
}
const lineNumbers = (lines, pattern, opts) => scanLines(lines, pattern, opts).matches.map(m => m.line).join(',');
const parts = (line, pattern) => scanLines([line], pattern, { onlyMatching: true }).matches[0].matchedParts;
const bre = (query, extra) => compilePattern(Object.assign({ query, regex: true }, extra));
const ere = (query, extra) => bre(query, Object.assign({ extended: true }, extra));
function compileError(fn) { try { fn(); return null; } catch (e) { return e; } }

// ---- 1. the literal path (regex:false) must not change -----------------------------------------------
const L = ['alpha one', 'Beta two', 'gamma ONE', 'delta', 'one-one', ''];
check('1a literal query is case-insensitive by default', scanLines(L, compilePattern({ query: 'one' })).matchCount === 3);
check('1b caseSensitive:true is respected', scanLines(L, compilePattern({ query: 'one', caseSensitive: true })).matchCount === 2);
check('1c regex characters in a literal query are literal', lineNumbers(['a.b', 'axb'], compilePattern({ query: 'a.b' })) === '1');
check('1d a literal query of ( or [ compiles', compileError(() => compilePattern({ query: '(' })) === null && compileError(() => compilePattern({ query: '[a' })) === null);
check('1e the extended flag does nothing without regex:true (the query stays literal)', lineNumbers(['a+', 'aa'], compilePattern({ query: 'a+', extended: true })) === '1');

// ---- 2. scanLines options must not change ---------------------------------------------------------------
const S = ['a1', 'b2', 'a3', 'b4', 'a5'];
const pa = compilePattern({ query: 'a' });
check('2a occurrence:2 returns only the second match', lineNumbers(S, pa, { occurrence: 2 }) === '3');
check('2b maxMatches truncates and says so', (() => { const r = scanLines(S, pa, { maxMatches: 2 }); return r.truncated === true && r.matches.length === 2; })());
check('2c invertMatch returns the non-matching lines', lineNumbers(S, pa, { invertMatch: true }) === '2,4');
check('2d countOnly counts and returns no entries', (() => { const r = scanLines(S, pa, { countOnly: true }); return r.matchCount === 3 && r.matches.length === 0; })());
check('2e stopAtFirst stops after one match', scanLines(S, pa, { stopAtFirst: true }).matches.length === 1);
check('2f before and after give asymmetric context', (() => { const e = scanLines(S, compilePattern({ query: 'b2' }), { before: 1, after: 2 }).matches[0]; return e.before.length === 1 && e.before[0].line === 1 && e.after.length === 2 && e.after[1].text === 'b4'; })());
check('2g contextLines is the symmetric shorthand', (() => { const e = scanLines(S, compilePattern({ query: 'b2' }), { contextLines: 1 }).matches[0]; return e.before.length === 1 && e.after.length === 1; })());
check('2h onlyMatching on the literal path lists every occurrence', parts('xx one yy one', compilePattern({ query: 'one' })).join() === 'one,one');
check('2i entryExtra and filter are applied', (() => { const r = scanLines(S, pa, { entryExtra: i => ({ idx: i }), filter: (t, i) => i > 0 }); return r.matches.length === 2 && r.matches[0].idx === 2; })());

// ---- 3. regex:true is a POSIX BRE (plain grep) ---------------------------------------------------------
check('3a BRE alternation is \\| (GNU extension)', lineNumbers(['cat', 'dog', 'bird'], bre('cat\\|dog')) === '1,2');
check('3b BRE: a bare | is a literal bar', lineNumbers(['a|b', 'a', 'b'], bre('a|b')) === '1');
check('3c BRE: + is literal, \\+ is the operator', lineNumbers(['a+', 'aa'], bre('a+')) === '1' && lineNumbers(['aa', 'b'], bre('a\\+')) === '1');
check('3d BRE group and backreference \\(ab\\)\\1', lineNumbers(['abab', 'ab'], bre('\\(ab\\)\\1')) === '1');
check('3e BRE interval \\{2\\}', lineNumbers(['aa', 'a'], bre('a\\{2\\}')) === '1');
check('3f BRE anchors ^ and $ apply to each line', lineNumbers(['abc', 'xabc', 'abcx'], bre('^abc$')) === '1');
check('3g POSIX bracket classes work', lineNumbers(['a1', 'ab'], bre('[[:digit:]]')) === '1');
check('3h BRE: a bare ( is a literal paren', lineNumbers(['f(x)', 'fx'], bre('f(x)')) === '1');

// ---- 4. extended:true is an ERE (grep -E) -------------------------------------------------------------
check('4a ERE alternation |', lineNumbers(['cat', 'dog', 'bird'], ere('cat|dog')) === '1,2');
check('4b ERE + ? and groups with intervals', lineNumbers(['aab', 'b'], ere('a+b')) === '1' && lineNumbers(['abab', 'ab'], ere('(ab){2}')) === '1');
check('4c ERE backreference (ab)\\1', lineNumbers(['abab', 'abba'], ere('(ab)\\1')) === '1');
check('4d ERE: a backslash escapes an operator (a\\+ is a literal plus)', lineNumbers(['a+', 'aa'], ere('a\\+')) === '1');

// ---- 5. POSIX, not JavaScript: the traps are kept faithful (same as GNU grep) ---------------------------
check('5a \\d is not a digit class: it matches the letter d', lineNumbers(['a1', 'd'], ere('\\d')) === '2');
check('5b a lazy quantifier is not lazy: a.*?b takes the longest match', parts('aXbYb', ere('a.*?b')).join() === 'aXbYb');
check('5c alternation is leftmost-longest: a|ab on "ab" gives ab (JavaScript gives a)', parts('ab', ere('a|ab')).join() === 'ab');
check('5d the JavaScript group (?:x) is not special: as in grep it is the group (:x) (the ? after the paren is dropped)', lineNumbers([':x', 'x'], ere('(?:x)')) === '1');

// ---- 6. case --------------------------------------------------------------------------------------------
check('6a regex:true keeps the existing default: case-insensitive', lineNumbers(['ABC'], bre('abc')) === '1');
check('6b caseSensitive:true is respected by the POSIX path', lineNumbers(['ABC', 'abc'], bre('abc', { caseSensitive: true })) === '2');

// ---- 7. onlyMatching on the POSIX path ------------------------------------------------------------------
check('7a every non-overlapping match is returned', parts('ab12cd345', bre('[0-9]\\+')).join() === '12,345');
check('7b empty matches are skipped, like grep -o', (() => { const r = scanLines(['abc'], bre('x*'), { onlyMatching: true }); return r.matches.length === 1 && r.matches[0].matchedParts.length === 0; })());
check('7c ^ matches only at the start of the line, also for repeated matches', parts('aaa', bre('^a')).join() === 'a');
check('7d every match is leftmost, then longest', parts('foo foobar', ere('foo|foobar')).join() === 'foo,foobar');

// ---- 8. errors are reported as invalidRegex with the POSIX message ---------------------------------------
check('8a an unmatched \\( in a BRE is invalidRegex', (() => { const e = compileError(() => bre('\\(ab')); return !!e && e.code === 'invalidRegex' && /Invalid regex/.test(e.message); })());
check('8b an unmatched ( in an ERE is invalidRegex', (() => { const e = compileError(() => ere('(ab')); return !!e && e.code === 'invalidRegex'; })());
check('8c the message carries the POSIX wording', (() => { const e = compileError(() => ere('[ab')); return !!e && /Unmatched \[/.test(e.message); })());
check('8d a trailing backslash is invalidRegex', (() => { const e = compileError(() => bre('ab\\')); return !!e && e.code === 'invalidRegex'; })());
check('8e a pattern that is too complex fails while matching, with the same invalidRegex code', (() => {
  const e = compileError(() => scanLines(['a'.repeat(3000)], ere('(a|aa)+b')));
  return !!e && e.code === 'invalidRegex' && /complex/i.test(e.message);
})());
check('8f a plain pattern over 5,000 lines of 60 characters scans in well under 2 seconds', (() => {
  const big = Array.from({ length: 5000 }, (_, i) => 'row ' + i + ' lorem ipsum dolor sit amet consectetur adipiscing elit');
  const t0 = Date.now();
  const n = scanLines(big, bre('row [0-9]*7 .*elit'), { countOnly: true }).matchCount;
  return n === 500 && Date.now() - t0 < 2000;
})());

// ---- 9. a plain RegExp still works in scanLines (search-symbol passes one) ------------------------------
check('9a a RegExp pattern still scans', lineNumbers(['foo1', 'bar', 'foo2'], /foo\d/i) === '1,3');
check('9b a /g RegExp is not stateful from line to line', lineNumbers(['foo', 'foo', 'foo'], /foo/g) === '1,2,3');
check('9c onlyMatching with a RegExp still works', parts('a1b22', /\d+/).join() === '1,22');

// ---- 10. the four search tools are wired to the POSIX path (source checks, no Pulsar needed) -------------
const fs = require('fs');
const path = require('path');
const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
const countOf = (s) => reg.split(s).length - 1;
check('10a find-text, grep-file, grep-project and search-functions all pass extended to compilePattern', countOf('compilePattern({ query, regex, extended, caseSensitive') === 4, 'found ' + countOf('compilePattern({ query, regex, extended, caseSensitive'));
check('10b no call still compiles without extended', countOf('compilePattern({ query, regex, caseSensitive })') === 0);
check('10c search-functions no longer builds its own JavaScript RegExp from the query', !/new RegExp\(query, flags\)/.test(reg));
check('10d each of the four tools declares the extended parameter', (reg.match(/^\s+extended:\s+z\.boolean\(\)\.optional\(\),/gm) || []).length >= 4);
check('10e the four handlers destructure extended', (reg.match(/handler: async \(\{[^}]*\bregex = false, extended = false\b/g) || []).length === 4);
check('10f find-text, grep-file and grep-project (not search-functions) pass wordRegexp and lineRegexp to compilePattern', countOf('wordRegexp, lineRegexp })') === 3, 'found ' + countOf('wordRegexp, lineRegexp })'));
check('10g those three tools declare wordRegexp and lineRegexp and destructure them', (reg.match(/^\s+wordRegexp:\s+z\.boolean\(\)\.optional\(\),/gm) || []).length === 3 && (reg.match(/^\s+lineRegexp:\s+z\.boolean\(\)\.optional\(\),/gm) || []).length === 3 && (reg.match(/handler: async \(\{[^}]*wordRegexp = false, lineRegexp = false/g) || []).length === 3);

// ---- 11. the no-match note about POSIX traps (regexHint) -------------------------------------------------
const { regexHint, regexHintSuffix } = require('../lib/search-engine');
const hint = (query, o) => regexHint(Object.assign({ query, regex: true }, o));
check('11a a bare | in a BRE: the note says to pass extended:true', /extended:true/.test(hint('foo|bar') || ''), String(hint('foo|bar')));
check('11b a bare ( ) + ? { } in a BRE each raise the note', ['(a)', 'a+', 'a?', 'a{2}'].every(q => /literal text/.test(hint(q) || '')));
check('11c an escaped operator is real syntax: no note', hint('foo\\|bar') === null && hint('a\\+') === null && hint('\\(a\\)') === null);
check('11d operators inside a bracket expression are literal anyway: no note', hint('[|+?]') === null && hint('[^)]x') === null);
check('11e extended:true with an alternation: no note', hint('foo|bar', { extended: true }) === null);
check('11f a backslash-d raises the digit note, in a BRE and in an ERE', /\[0-9\]/.test(hint('a\\d') || '') && /\[0-9\]/.test(hint('a\\d', { extended: true }) || ''));
check('11g a lazy quantifier in an ERE raises the lazy note, but not in a BRE (where ? is literal)', /lazy/.test(hint('a.*?b', { extended: true }) || '') && !/lazy/.test(hint('a.*?b') || ''));
check('11h regex:false never raises a note, whatever the query', regexHint({ query: 'a|b+(c)\\d', regex: false }) === null);
check('11i a plain BRE raises no note', hint('foo.*bar') === null && hint('^abc$') === null);
check('11j the suffix form is empty without a note and starts with a space with one', regexHintSuffix({ query: 'a.b', regex: true }) === '' && /^ Note: /.test(regexHintSuffix({ query: 'a|b', regex: true })));
check('11k the four no-match replies use the note', countOf('regexHint(') + countOf('regexHintSuffix(') >= 4, 'found ' + (countOf('regexHint(') + countOf('regexHintSuffix(')));

// ---- 12. GNU grep is more lenient than sed (R4j, found with test/grep-oracle on 2026-10-31) --------------
// Every expectation below is what real GNU grep 3.11 did on the same input (grep-diff.js). The sed engine
// underneath rejects these patterns, so the search tools compile with the grep option of lib/posix-regex.js.
const posixRaw = require('../lib/posix-regex');
const L12 = ['a', 'xa', 'b', ''];
check('12a ERE: a repetition operator with nothing before it is ignored (*a, +a, ?a behave as a)',
  ['*a', '+a', '?a'].every(q => lineNumbers(L12, ere(q)) === '1,2' && parts('xa', ere(q)).join() === 'a'));
check('12b ERE: the same after ( and after |, and at the start before an anchor', lineNumbers(L12, ere('(*a)')) === '1,2' && lineNumbers(['a', 'b', 'c'], ere('a|*b')) === '1,2' && lineNumbers(['a', 'b', 'c'], ere('a|+b')) === '1,2' && lineNumbers(L12, ere('^*')) === '1,2,3,4');
check('12c stacked repetition is allowed: ERE a** and a?*, BRE a**, a\\{1\\}* and a\\+*', ['a**', 'a?*'].every(q => lineNumbers(L12, ere(q)) === '1,2,3,4') && ['a**', 'a\\{1\\}*', 'a\\+*'].every(q => lineNumbers(L12, bre(q)) === '1,2,3,4' && parts('aaa', bre(q)).join() === 'aaa'));
check('12d BRE: a leading \\{ is a literal brace, and so is a stray \\}', lineNumbers(['{1}', '1', 'a'], bre('\\{1\\}')) === '1');
check('12e ERE: { with nothing before it is literal text', lineNumbers(['{', 'a'], ere('{')) === '1');
check('12f ERE: an invalid or unterminated interval is literal text (a{ a{1 a{x} a{1,x})', lineNumbers(['a{', 'a'], ere('a{')) === '1' && lineNumbers(['a{1', 'a'], ere('a{1')) === '1' && lineNumbers(['a{x}', 'a'], ere('a{x}')) === '1' && lineNumbers(['a{1,x}', 'a'], ere('a{1,x}')) === '1');
check('12g ERE: an unmatched ) is literal text, a real group still works', lineNumbers(['x)', 'x'], ere(')')) === '1' && lineNumbers(['a)', 'a'], ere('a)')) === '1' && lineNumbers(['ab', 'a'], ere('(a)b')) === '1');
check('12h ERE: (?:a) is accepted, as in grep: it is the group (:a), so it finds the text :a', lineNumbers([':a', 'a'], ere('(?:a)')) === '1');
check('12i what stays an error in grep stays an error here: a{2,1} a{} a{99999} (ERE), a\\{1 a\\{x\\} \\) (BRE), (a and \\(a',
  ['a{2,1}', 'a{}', 'a{99999}', '(a'].every(q => !!compileError(() => ere(q))) && ['a\\{1', 'a\\{x\\}', '\\)', '\\(a', 'a\\{2,1\\}'].every(q => !!compileError(() => bre(q))));
check('12j the messages are still the POSIX ones', (() => { const m = (f) => { const e = compileError(f); return e ? e.message : ''; }; return /Invalid content of/.test(m(() => ere('a{2,1}'))) && /Unmatched \\\{/.test(m(() => bre('a\\{1'))) && /Unmatched \( or/.test(m(() => ere('(a'))); })());
check('12k sed is NOT changed: without the grep option the strict rules stay',
  ['*a', 'a{1', ')', 'a|*b'].every(q => { try { posixRaw.compile(q, { extended: true }); return false; } catch (e) { return e instanceof posixRaw.RegexError; } })
  && ['a**', '\\{1\\}'].every(q => { try { posixRaw.compile(q, { extended: false }); return false; } catch (e) { return e instanceof posixRaw.RegexError; } }));
check('12l the grep option compiles those patterns when asked directly', ['*a', 'a{1', ')'].every(q => { try { posixRaw.compile(q, { extended: true, grep: true }); return true; } catch (e) { return false; } }));
check('12m ERE: a valid interval with nothing before it is ignored, like * (grep selects the lines as if it were not there)', lineNumbers(L12, ere('{1}')) === '1,2,3,4' && lineNumbers(L12, ere('{,2}')) === '1,2,3,4' && lineNumbers(L12, ere('{1,2}a')) === '1,2');
check('12n ERE: every operator after an ignored leading operator is ignored too (+{2,1}, **a)', compileError(() => ere('+{2,1}')) === null && lineNumbers(L12, ere('**a')) === '1,2' && compileError(() => ere('|+{2,1}|{2,1}')) === null);
check('12o ERE: an operator after an anchor repeats the anchor, so ^*a and a$* may skip it (grep selects every line with an a)', lineNumbers(L12, ere('^*a')) === '1,2' && lineNumbers(L12, ere('a$*')) === '1,2' && lineNumbers(['ab', 'a'], ere('a$')) === '2' && lineNumbers(['ab', 'a'], ere('a$*')) === '1,2');
check('12p ERE: an invalid interval after an anchor is not an error (${2,1})', compileError(() => ere('${2,1}||')) === null);
check('12q a brace followed by junk and then the end of the pattern is "Unmatched \\{", junk and then a closing brace is "Invalid content", as in real grep and real sed', (() => {
  const m = (f) => { const e = compileError(f); return e ? e.message : ''; };
  return /Unmatched \\\{/.test(m(() => bre('a\\{(ab'))) && /Unmatched \\\{/.test(m(() => bre('a\\{1,x'))) && /Invalid content of/.test(m(() => bre('a\\{x\\}'))) && /Invalid content of/.test(m(() => ere('a{2,1}')));
})());
check('12r the same messages come from the strict sed mode (the sed engine got the glibc scan-ahead too)', (() => {
  const m = (pat, ext) => { try { posixRaw.compile(pat, { extended: ext }); return ''; } catch (e) { return e.message; } };
  return /Unmatched \\\{/.test(m('a\\{(ab', false)) && /Unmatched \\\{/.test(m('a{(ab', true)) && /Invalid content of/.test(m('a\\{x\\}', false)) && /Invalid content of/.test(m('a{x}', true));
})());
// ---- 13. wordRegexp (grep -w) and lineRegexp (grep -x) (R4g) -------------------------------------------
// Expected values are what GNU grep 3.11 printed for the same input (test/grep-oracle, also run in bulk by
// `grep-diff.js words`: 876 pattern and flag combinations, 0 new differences).
const W13 = ['foo', 'foobar', 'foo bar', 'xfoo', 'foo_bar', 'foo-bar', '(foo)', 'a foo b', 'foofoo foo', ''];
const lit = (query, extra) => compilePattern(Object.assign({ query }, extra));
check('13a literal wordRegexp: whole words only (grep -F -w)', lineNumbers(W13, lit('foo', { wordRegexp: true })) === '1,3,6,7,8,9');
check('13b literal lineRegexp: the whole line only (grep -F -x)', lineNumbers(W13, lit('foo', { lineRegexp: true })) === '1');
check('13c literal wordRegexp with the case folded (grep -F -wi)', lineNumbers(W13, lit('FOO', { wordRegexp: true })) === '1,3,6,7,8,9' && lineNumbers(W13, lit('FOO', { wordRegexp: true, caseSensitive: true })) === '');
check('13d regex:true wordRegexp and lineRegexp behave the same for a plain word (BRE)', lineNumbers(W13, bre('foo', { wordRegexp: true })) === '1,3,6,7,8,9' && lineNumbers(W13, bre('foo', { lineRegexp: true })) === '1');
check('13e ERE lineRegexp needs the whole line: foo|foobar gives the lines foo and foobar', lineNumbers(W13, ere('foo|foobar', { lineRegexp: true })) === '1,2' && lineNumbers(W13, bre('f.*r', { lineRegexp: true })) === '2,3,5,6');
check('13f lineRegexp wins when both are given, as in grep', lineNumbers(W13, ere('foo', { wordRegexp: true, lineRegexp: true })) === '1');
check('13g -w tries a shorter match at the same start: a[a-z ]* on "a bc1" is just a', parts('a bc1', ere('a[a-z ]*', { wordRegexp: true })).join() === 'a' && lineNumbers(['a bc1'], ere('a[a-z ]*', { wordRegexp: true })) === '1');
check('13h -w takes the longest bounded match: foo|foobar on "foobar x" is foobar', parts('foobar x', ere('foo|foobar', { wordRegexp: true })).join() === 'foobar');
check('13i an empty pattern with -w selects only lines with a spot that has no word character next to it (empty line, a space, a dash)', lineNumbers(['a', '', ' ', 'a b', '-'], ere('', { wordRegexp: true })) === '2,3,5' && lineNumbers(['a', '', ' '], lit('', { lineRegexp: true })) === '2');
check('13j a literal with regex characters is matched literally: a.b with -w', lineNumbers(['a.b', 'xa.b', 'a.bx', 'a.b c', 'axb'], lit('a.b', { wordRegexp: true })) === '1,4');
check('13k + with -w: o+ finds only the whole words o and oo', lineNumbers(['foo', 'o', 'oo oo', 'ox'], ere('o+', { wordRegexp: true })) === '2,3');
check('13l onlyMatching with -w lists each bounded match (grep -ow)', parts('foofoo foo a foo', lit('foo', { wordRegexp: true })).join() === 'foo,foo');
check('13m the options do not change the default path: no wordRegexp or lineRegexp is still a plain RegExp for a literal', compilePattern({ query: 'foo' }) instanceof RegExp && compilePattern({ query: 'foo', wordRegexp: false, lineRegexp: false }) instanceof RegExp);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
