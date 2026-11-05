# tools/sed-oracle - differential tools against a real GNU sed

These scripts check `lib/posix-regex.js` (TODO R4a) and `lib/sed-parse.js` (R4b) against a REAL GNU sed
(4.9 was used, run with `LC_ALL=C.UTF-8`). They are development tools, not part of the package's test suite:
they need `sed` on PATH, and the Windows machine this package lives on has none. Run them where sed exists
(WSL, Linux, macOS with GNU sed, or the assistant's sandbox) from the package root. Each prints the sed
version first and exits 0 when everything agrees, 1 on a mismatch, 2 when sed is missing.
The scripts write only to a scratch folder under the OS temp directory (scripts with `w` / `r` commands).

| tool | what it does |
|---|---|
| `node tools/sed-oracle/regex-diff.js curated` | 264 curated BRE / ERE patterns: s///g output, group captures and error messages vs sed |
| `node tools/sed-oracle/regex-diff.js fuzz [seed] [count]` | random patterns rendered as ERE and BRE; a few distinct mismatches per few thousand are the KNOWN glibc deviations (TODO R4a-dev) |
| `node tools/sed-oracle/parse-diff.js` | error corpus: every seed script, every prefix and every single-character deletion (about 2500 cases): accept / reject, exact message, exact "char N" |
| `node tools/sed-oracle/parse-sem.js` | about 10000 comparisons of single s / y / a / i / c commands applied to a line |
| `node tools/sed-oracle/parse-fuzz.js [seed] [count]` | random token-soup scripts, accept / reject and message |
| `node tools/sed-oracle/gen-parse-test.js [outfile]` | re-records the two expected-value tables of `test/sed-parse.test.js` from real sed (the helpers and checks around them are kept as they are) |

Files: `oracle.js` (shared helpers: run sed, verdicts, the GNU s///g emulation, the small one-command evaluator),
`corpus.js` (seed lists and category lists), `seeds.json` (about 290 hand-written scripts, valid and invalid).
The golden data for the regex tests is regenerated separately with `node test/golden/gen-golden.js`.

## How the work was done (use the same method for the interpreter, R4c)
1. Probe sed first: tiny scripts that print what sed does for dozens of inputs; several behaviours differed from memory.
2. Write the module; compare it with sed on a curated corpus, then on random inputs.
3. Mutation-check the tests: inject deliberate bugs into a copy of the module; a surviving mutant is a missing test case.
4. Record sed's answers into the repo's tests as inline tables / golden data, so the tests run without sed.

Known artifacts to discount: sed's message for an unknown newline command contains a newline; a `w` file that cannot be
opened makes sed stop while parsing and hides later syntax errors (those scripts are skipped); "no previous regular
expression" is a run-time error in sed, so a script that only fails that way counts as a successful parse.
## The interpreter tools (added 2026-10-22, TODO R4c)
- `run-diff.js [filter-regex] [--quick | --rest | --mb]`: runs every script of a corpus (about 400) through REAL sed and
  through `lib/sed-run.js` and compares output text and exit status. `--quick` = first 5 inputs, `--rest` = the next 5,
  `--mb` = only the multibyte block of scripts on the non-ASCII inputs (the whole corpus in one go is too slow for a
  3 minute limit). Results seen with sed 4.9 on Windows: `--quick` 3260 cases and `--rest` 3260 cases (28 known:
  Windows `l` prints a tab as a real tab) and `--mb` 1098 cases (23 known: non-BMP input, or a stray byte next to \b \B \< \>), 0 mismatches.
- `gen-run-test.js [outfile]`: writes `test/golden/sed-run-cases.js` (expected outputs recorded from real sed) used by
  `test/sed-run.test.js`. Skips cases where the Windows port of sed differs from Linux sed: `l` with a tab, characters
  outside the BMP, and a stray byte next to \b \B \< \>. Those are covered by hand-written cases recorded on Linux.
- Bytes: `oracle.js` sends and reads BYTES (`encodeBytes` / `decodeBytes` from `lib/sed-run.js`): bytes that are not valid
  UTF-8 appear in strings as lone surrogates U+DC80..U+DCFF.
- Windows port of sed vs Linux sed (glibc): the Windows build has a 16-bit wchar_t, so characters outside the BMP (emoji)
  are mishandled (classes, `.`, \b); `l` prints a tab as a real tab; a lone stray byte has no word boundary there.
  Treat Linux sed as the reference whenever they differ.

Everything about the project: `SED-R4-HANDOFF.md` in the package root.

## Running on Windows (added 2026-10-21)
A native Windows build of GNU sed 4.9 works: mbuilov/sed-windows, release "sed-4.9-x64 fixed", asset `sed-4.9-x64.exe`
(SHA-1 517226430b5a708cc8d2dfa4caa624f6a5b0449a). Copy it as `sed.exe` into this folder (it is not part of the package) and,
in PowerShell, from the package root: `$env:PATH = (Resolve-Path test\sed-oracle).Path + ';' + $env:PATH` and
`$env:SED_ORACLE_LOCALE = '.UTF-8'` (that build rejects `C.UTF-8`; on Linux leave the variable unset). `oracle.js` adds `-b`
on Windows and turns CRLF in sed's messages into LF. Results seen with that build: `parse-diff.js` 2529 cases, 0 mismatches;
`parse-fuzz.js` 1174 scripts, 0; `parse-sem.js` 0 mismatches on the 9312 comparisons that do not use `/dev/null` (the 80 scripts
with `w /dev/null` fail in the Windows build: no such device); `regex-diff.js curated` 4 mismatches, all the BRE pattern `\(a$\)`
(real Linux sed 4.9 treats that `$` as an anchor, like lib/posix-regex.js; the Windows build does not): a Windows-port difference,
not a bug in the modules. Treat Linux sed as the reference when the two differ.
