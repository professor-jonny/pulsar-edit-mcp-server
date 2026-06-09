# Stats Review — Post Tree-Sitter Migration

**Snapshot date:** 2026-06-06  
**Version:** 0.10.25  
**Lifetime sessions:** 30  
**Baseline:** v0.10.22 (session 12, end of regex era — see session notes)

---

## Baseline vs Current — key edit tools

The baseline was captured at the end of session 12, immediately before any real feature work ran on the tree-sitter codebase. Everything below that point in the lifetime data is from the regex era.

| Tool | Baseline hits | Baseline attempts | Baseline % | Current lifetime hits | Current lifetime attempts | Current % | Δ |
|---|---|---|---|---|---|---|---|
| `str_replace` | 656 | 774 | 84.8% | 872 | 1032 | 84.5% | −0.3pp |
| `insert` | 48 | 54 | 88.9% | 74 | 82 | 90.2% | +1.3pp |
| `delete_line_range` | 36 | 38 | 94.7% | 42 | 44 | 95.5% | +0.8pp |
| `replace_function_body` | 20 | 30 | 66.7% | 22 | 32 | 68.8% | +2.1pp |
| `replace_document` | 24 | 24 | 100% | 26 | 26 | 100% | — |
| `replace_across_files` | 30 | 30 | 100% | 30 | 30 | 100% | — |
| `delete_block` | — | — | — | 6 | 6 | 100% | new |
| `sed` | — | — | — | 6 | 8 | 75% | new |
| `apply_patch` | 0 | 12 | 0% | 0 | 12 | 0% | — (abandoned) |

**Post-baseline incremental (sessions 13–30 only):**

| Tool | Hits | Attempts | Rate |
|---|---|---|---|
| `str_replace` | 216 | 258 | 83.7% |
| `insert` | 26 | 28 | 92.9% |
| `delete_line_range` | 6 | 6 | 100% |
| `replace_function_body` | 2 | 2 | 100% |
| `grep_file` | 292 | 430 | 67.9% |

---

## Search tools

| Tool | Lifetime hits | Lifetime misses | Hit rate |
|---|---|---|---|
| `grep_file` | 824 | 376 | 68.6% |
| `grep_project` | 18 | 58 | 23.7% |
| `read_lines` | 796 | 0 | 100% |
| `find_text` | 6 | 2 | 75% |
| `search_symbol` | 2 | 0 | 100% |

`grep_file` miss rate (31%) is largely exploratory — searching for patterns that turn out not to exist is expected behaviour, not a fault. `grep_project` low hit rate is consistent with the baseline observation; it's used for wide exploratory scans, not targeted queries.

`read_lines` at 100% across 796 calls confirms the hint-based API (functionHint, lineNumberHint, centerLine+radius) works reliably.

---

## Hint usage — `str_replace`

| Hint | Lifetime uses |
|---|---|
| `lineNumberHint` | 1056 |
| `afterHint` | 42 |
| `functionHint` | 36 |
| `occurrence` | 4 |
| `betweenHint` | 2 |
| `fuzzyWhitespace` commits | 24 |
| `fuzzyContent` commits | 0 |

`lineNumberHint` dominates as expected — the standard workflow (grep-file → read-lines → str_replace with lineNumberHint) drives the majority of edits. `fuzzyWhitespace` saved 24 retries. `fuzzyContent` at 0 suggests Unicode mismatch failures are rare in this codebase.

---

## `str_replace` failure breakdown (lifetime)

| Reason | Count |
|---|---|
| `noMatch` | 100 |
| `whitespace` | 42 |
| `partialMatch` | 14 |
| `wrongOccurrence` | 4 |
| `ambiguous` | 0 |
| `outOfScope` | 0 |
| `afterNotFound` | 0 |
| **Total faults** | **160 / 1032 (15.5%)** |

`noMatch` (100) and `whitespace` (42) together account for 89% of all str_replace faults. Both are addressable: `noMatch` benefits from `lineNumberHint` + `dryRun` before commit; `whitespace` is solved by `fuzzyWhitespace:true`. The new `diffVsBuffer` diagnostic in the noMatch response (v0.10.25) should reduce retry loops further.

---

## Style compliance

| Metric | Value |
|---|---|
| Edits checked (inline) | 46 |
| Total violations introduced | 102 |
| Clean edits | 0 |
| Top rule: `wrong_indentation` | 56 occurrences |
| Top rule: `missing_newline_eof` | 46 occurrences |
| Checkpatch runs | 1 |
| Checkpatch violations | 0 |

The two dominant violations (`wrong_indentation` and `missing_newline_eof`) are both snippet-level artefacts — LLM-generated `new_str` snippets use spaces rather than tabs and don't end with `\n`. These are cosmetic in `.md` and test files but genuine errors in `.c`/`.h` production code. The inline style check catches them at commit time.

All 18 other style rules show 0 introduced violations.

---

## Tool abandonment and deprecation

- **`apply_patch`**: 0/12 lifetime (0%). No calls since baseline. Fully deprecated — `str_replace` + `lineNumberHint` is reliably faster and more predictable for scattered edits. The fuzzy rescue feature was never successfully invoked.
- **`lineNumberHintFallback`**: Removed in v0.10.25. Lifetime stat was 218 silent positional overwrites. Removal was a correctness fix, not a performance regression.
- **`replace_block`**: 2/4 (50%). Low use, low signal. Reliable only on genuinely brace-delimited blocks; avoided for bare if/for.

---

## New in post-baseline era (not in v0.10.22 baseline)

- **`warnings.style`** — always-on inline C style check on every `.c`/`.h` edit (v0.10.24+)
- **`warnings.struct`** — delta-based structural integrity check on `str_replace` (v0.10.25, `str_replace` only so far)
- **`warnings.lint`** — live linter feedback always-on (lint gate removed, v0.10.25)
- **`failure-log.ndjson`** — NDJSON failure log with `diffVsBuffer` on every `str_replace` noMatch (v0.10.25)
- **`buildEditResponse`** — standardised response envelope across all 15 commit sites (v0.10.24)

---

## Next snapshot target

After ~5 real coding sessions on the v0.10.25 codebase to assess:
- Whether `diffVsBuffer` in the noMatch response reduces `noMatch` fault rate
- Whether always-on lint surfaces actionable messages or just noise
- Whether `warnings.struct` catches real damage in production edits (not just test scenarios)
- `str_replace` hit rate post-`lineNumberHintFallback` removal (previously 218 silent overwrites were counted as hits)
