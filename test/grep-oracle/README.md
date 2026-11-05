# grep oracle (R4g)

Differential tool: compares the `regex:true` path of `lib/search-engine.js` (what `grep-file`, `grep-project`, `find-text` and
`search-functions` use) with a REAL GNU grep. NOT part of the test suite (`npm test` does not need it).

## Files

| File | What |
|---|---|
| `grep.exe` | GNU grep 3.11, Windows x64, prebuilt by https://github.com/mbuilov/grep-windows (`grep-3.11-x64.exe`). Placed by PJ on 2026-10-31. Not part of the package. |
| `HASHES.txt` | SHA-256 of `grep.exe` and `grep-diff.js`, recorded when they were placed. |
| `grep-diff.js` | the differential: `node test/grep-oracle/grep-diff.js curated` or `... fuzz [seed] [count]` |

## What it compares

For each pattern, in BRE (`grep -G`) and in ERE (`grep -E`), case-sensitive and a few case-insensitive:
1. whether it compiles, and the error message (`grep` says `Unmatched ( or \(`; the text must be identical),
2. the line numbers `grep -n` selects,
3. the matches `grep -o -n` prints.

The patterns are the BRE and ERE lists of the sed oracle (`test/golden/curated-lists.js`, 264 patterns) and a random generator
(`fuzz`, same idea as `test/sed-oracle/regex-diff.js`). Input is ASCII only.

## Quirks of this grep build (the harness works around them)

- It **expands wildcards in its arguments**: `a*`, `.*` and `?` are replaced by file names of the current folder. So patterns go
  in through `-f patternfile`, and grep runs in an empty scratch folder.
- With `-f`, error messages start with `<path>\pat.txt:1: `: stripped before comparing.
- It **cannot run back-references** (`\1`): "memory exhausted". Such patterns are skipped and counted. (A back-reference to a
  group that does not exist, `\(a\)\2`, is still compared: both say "Invalid back reference".)
- It writes **CRLF** line ends: normalised.
- It treats text as **bytes whatever the locale** (`LC_ALL` makes no difference): `.` matches one byte of a UTF-8 letter and `-i`
  does not fold non-ASCII. UTF-8 behaviour cannot be checked here.
- Do not run `grep.exe` from the assistant's `run-command` directly (the command guard blocks it); run it from a node script.

## Results

2026-10-31, grep 3.11 against `lib/search-engine.js` with `lib/posix-regex.js` as written for sed:
- `fuzz 1 150` (300 patterns): **0 differences**. The matching semantics (leftmost-longest, alternation, intervals, classes,
  anchors, `-o` splitting) agree with GNU grep.
- `curated`: 264 patterns, 13 skipped (back-references), **26 differences, all of one kind: GNU grep is more lenient than sed**:
  - ERE: a repetition operator with nothing before it (`*a`, `+a`, `?a`, `(*a)`, `a|*b`, `^*`, `$*`) is ignored, so `*a` is `a`
    (grep warns `* at start of expression`);
  - stacked repetition (`a**`, `a?*`; and in a BRE `a**`, `a\{1\}*`, `a\+*`) is allowed;
  - an invalid or unterminated interval is literal text (`{`, `a{`, `a{1`, `a{x}`);
  - an unmatched `)` is a literal (`)`, `a)`);
  - BRE: a leading `\{` is a literal `{` (`\{1\}`).
  - `(?:a)` is valid in grep (the `?` after `(` is dropped, so it is `(:a)`); `sed -E` rejects it.
  - For `^*a` and a leading `{1}` GNU grep's own engines disagree (line selection says one thing, `-o` another): not copied.

After R4j (2026-10-31): `lib/posix-regex.js` got a `grep: true` option that the search tools use (see the CHANGELOG entry
"The search tools accept the patterns GNU grep accepts"), and the numbers are now:
- `curated`: **0 new differences** (13 back-reference patterns skipped, 2 known).
- `lenient` (new mode: random strings of operators, braces, parentheses and anchors in odd places, both syntaxes), seeds 1 to 3
  with 500 patterns each: **0 new differences**; about 50 per seed are counted as known.
- `fuzz` seeds 1 and 5: 0.
- The "known" classes are patterns where GNU grep's own two engines disagree: glibc (used for `-o` and for the compile
  verdict) and dfa (used for line selection) treat a `{` at the start of an expression, and an operator right after an
  anchor, differently. Our engine follows the line selection (dfa), so `-o` output can differ for those. The harness
  classifies them (`KNOWN` and the leading-brace and anchor-operator patterns in `grep-diff.js`) instead of reporting them.
- The `sed` oracle (`test/sed-oracle/regex-diff.js`; run it with this folder's sibling `sed-oracle` on `PATH` and
  `SED_ORACLE_LOCALE=.UTF-8`) gives the same result before and after R4j: 4 known deviations on `curated`, 2 on `fuzz 1 150`.

Modes: `node test/grep-oracle/grep-diff.js curated | fuzz [seed] [count] | lenient [seed] [count] | words`.

`words` (2026-11-03) crosses the curated BRE and ERE lists and a list of fixed strings (`-F`) with `-w`, `-x` and both, case-sensitive and `-i`, and compares `grep -n` and `grep -o -n` with `compilePattern({ wordRegexp, lineRegexp })` + `scanLines`: 876 combinations, 0 new differences (39 skipped back-references, 69 known). The known extra quirk: `grep -o -w -x` prints an empty match for an empty line, which neither flag does alone. What it showed about grep: `-x` wins over `-w`; `-w` tries shorter matches at the same start before moving on (so `a[a-z ]*` with `-w` on "a bc1" prints `a`).
