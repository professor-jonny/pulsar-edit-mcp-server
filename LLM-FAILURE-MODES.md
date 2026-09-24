# LLM Edit Tool — Failure Modes & Solutions

LLMs fail at code editing in predictable, classifiable ways. This document catalogues the failure modes we identified through real use, the solutions we built, and the reasoning behind each. Most solutions emerged from a feedback loop: the LLM queried its own `get-edit-stats` and `failure-log.ndjson` data mid-session, identified patterns, and proposed fixes — which were then implemented and validated against the same evidence base.

> **Status note (2026-09-24):** Failure modes 1-16 and the pipeline/stats sections below were written around 2026-06 and predate the S1-S4 match-engine work. Some tool and parameter names have since been renamed or consolidated (`functionHint` is now `inFunction`; `afterHint` and `lineContentHint` are now `afterString`/`beforeString`; `lineNumberHint` is now `afterLine`/`beforeLine`; the separate delete and read tools were consolidated into `delete` and `read` -- see CHANGELOG 0.22.0). Check the live tool descriptions before relying on an old name. The lifetime stats quoted below are point-in-time figures from that period and have not been re-verified. Failure modes 17-21 were added on 2026-09-24 from failures observed while finishing S4e.

## How we know what's failing — the evidence base

Two tools provide the data that drove every design decision here:

**`get-edit-stats`** — per-tool, per-failure-reason counters tracked across sessions in `session/session-stats.json`. Queryable by the LLM mid-session so it can see its own failure patterns and adjust strategy. In the three open-source edit tools whose source is in `test/` (Cline, Aider, opencode -- see the comparison below), none lets the running agent read its own edit statistics: Cline sends two failure types (`search_not_found`, `other_diff_error`) to a remote telemetry service and never to the model, Aider increments a `num_malformed_responses` counter that nothing else reads, and opencode records nothing. Claude Code and Cursor were not checked (no source available).

**`session-faults.ndjson`** — every `str_replace`/`insert`/`replace-block`/`replace-function-body` failure appended as a structured JSON record with `bufferPreview` (raw buffer lines around the closest match), `oldStrPreview`, and `hintsSet` (the names of the hints that were passed; hint-resolution failures additionally record the hint value, see Failure Mode 16). The record also has a `diffVsBuffer` field, but on the two call sites checked (`str_replace`'s content-failure path and one `replace-function-body` path) it is always `null`, so do not expect a char-level diff in it (see Failure Mode 2). The log is grep-queryable and browsable via **Packages → MCP Server → Show Fault Log**. Every systematic failure class that appeared 3+ times with a recognisable pattern became a candidate for automatic rescue. The log converts anecdotal failure reports into measurable signals that justify engineering cost.

## Comparison: what other tools do

*Verification note (2026-09-24):* this section was rewritten after reading the source of three open-source edit tools kept under `test/`: Cline (`_cline_src/cline-main`), Aider (`_aider_src/aider-main`) and opencode (`opencode-dev/opencode-dev`). Claude Code and Cursor are closed source and were not checked, so nothing below is claimed about them. The earlier version of this paragraph said Cline and Claude Code have no fuzzy matching and no failure diagnostics; that was wrong for the three tools below, and the table shows what the source actually contains. "Not seen" in the table means I looked for it in the edit-tool files and did not find it; it is weaker than "does not exist".

| Capability | Cline | Aider | opencode |
|---|---|---|---|
| Fuzzy matching when exact fails | Yes, 3 tiers: exact, line-trimmed, first/last-line anchor (`assistant-message/diff.ts`) | Leading-whitespace rescue that re-indents the replacement, plus a `...` elision handler. The whole-block similarity matcher exists but is unreachable: `replace_most_similar_chunk` returns before calling it (`editblock_coder.py` L183) | Yes, 9 tiers including Levenshtein similarity >= 0.65 (`packages/opencode/src/tool/edit.ts`) |
| Failure response tells the model where the closest match is | No. It returns the entire original file plus generic advice (`prompts/responses.ts` `diffError`) | Yes. `find_similar_lines` returns the best-matching chunk (similarity >= 0.6, plus 5 lines of context) as a "Did you mean" block | No. Three fixed error strings |
| Preview before writing | Human approves a diff view | All edits are dry-run first so a batch is not half-applied (`base_coder.py` `apply_updates`); the CLI `--dry-run` flag is for the human | Human approves via a permission prompt carrying the diff |
| Model can request a dry run | No | No | No |
| Refuses an ambiguous match | Not seen | Not seen | Yes ("Found multiple matches") |
| Refuses a match far larger than `old_str` | Not seen | Not seen | Yes (`isDisproportionateMatch`) |
| Lint or diagnostics fed back after the edit | Yes. Diagnostics are snapshotted before the edit and only new errors are reported after saving (`DiffViewProvider.ts`) | Separate lint step (`base_coder.py`) | Yes, LSP errors appended to the result |
| Location-scoping parameters | None: `replace_in_file` takes `path` and `diff` only | None | None: `filePath`, `oldString`, `newString`, `replaceAll` |
| Per-failure-reason counters | Two types to remote telemetry, not shown to the model | One counter, incremented, never read | None |

What this leaves as different in this project: content-anchored location hints (`inFunction`, `afterString` and the rest), a model-callable `dryRun`, and the running agent being able to read its own per-reason stats. None of those three appeared in any of the three sources. The rest of what this project does (fuzzy matching, a closest-match diagnostic, ambiguity refusal, post-edit diagnostics) exists in at least one of them. "Novel" is therefore not an accurate word for the whole system. Cline's failure mode is genuinely widely reported (its GitHub issues #1195, #2909, #3183 and #4384 describe token-eating retry loops), which is consistent with it being the weakest of the three at failure diagnostics. Every feature below exists because we measured a real failure class and fixed it.

Two ideas in the table are not confirmed to exist in this project and are worth checking: opencode's over-match guard and Aider's all-edits-dry-run-first transaction. Neither has been compared against this code.

---

## Failure Mode 1 — Whitespace and indentation mismatch

**What happens:** The LLM generates `old_str` from memory, normalising indentation — tabs become spaces, 4-space becomes 2-space, trailing spaces are dropped. The content is right but the match fails.

**How we know it's common:** Lifetime stats show `whitespace` as consistently the largest `str_replace` fail class. Early sessions showed it accounting for the majority of all `str_replace` failures before automatic rescue was added.

**Solutions:**

*`fuzzyWhitespace:true`* — matches trimmed-per-line content, then commits using the buffer's actual indentation. The LLM's version of the whitespace is never written.

*Auto-fuzzyWhitespace* — since v0.10.28 this fires automatically on any noMatch before returning failure, without requiring an explicit flag. The `[autoFuzzyWhitespace]` tag in the response signals when it fired. Eliminates the retry entirely for this failure class.

*Per-line whitespace diff* — when a match still fails, the response shows the search text vs buffer text side-by-side per line so the LLM can see exactly where indentation diverged without a separate read call.

---

## Failure Mode 2 — Unicode character substitution (invisible byte mismatch)

**What happens:** The LLM generates `old_str` containing Unicode substitutions — smart quotes instead of straight quotes, em dash instead of hyphen, non-breaking space, zero-width spaces, arrow characters. Visually identical to the buffer but different at the byte level. The whitespace diff diagnostic doesn't fire because this isn't an indentation issue.

**How we know it's common:** The `session-faults.ndjson` evidence base revealed this directly. A recurring cluster of entries showed `old_str` containing `->` (ASCII) while the buffer had `→` (U+2192). Another cluster showed trailing `/* verified */` comments present in `old_str` but absent from the buffer. These patterns were invisible before the log existed — every failure looked like a generic noMatch.

**The character classes affected:**

| LLM generates | Instead of | Unicode |
|---|---|---|
| Smart quotes `"` `"` | Straight `"` | U+201C / U+201D |
| Smart apostrophe `'` | Straight `'` | U+2019 |
| Em dash `—` | Hyphen `-` or `--` | U+2014 |
| En dash `–` | Hyphen `-` | U+2013 |
| Unicode arrows `→` `←` | ASCII `->` `<-` | U+2190–U+21FF |
| Non-breaking space | Regular space | U+00A0 |
| Zero-width space | Nothing (invisible) | U+200B |
| Box-drawing runs `────` | Dashes `----` | U+2500–U+257F |

**Solutions:**

*`fuzzyContent:true`* — normalises both `old_str` and the buffer search region to ASCII-equivalent before matching. The replacement is committed against the original buffer — encoding is preserved. Covers all character classes in the table above.

*Auto-fuzzyContent* — since v0.10.28 fires automatically after `fuzzyWhitespace` also fails, without requiring an explicit flag. Tagged `[autoFuzzyContent]` in the response.

*`regex:true`* — treats `old_str` as a JS regex. Use `.` to wildcard a single unknown character, `.*` for a span. The manual escape hatch for cases where the character type itself is unknown.

*Per-line search-versus-buffer diff and `bufferPreview`* — when a match fails, `str_replace` compares each line of `old_str` with buffer lines that are equal after trimming, and reports the pair (`searchText` against `bufferText`, each passed through `JSON.stringify`). That escapes tabs and control characters but does not escape a non-breaking or zero-width space, so those can still look identical in the output. What catches them is the classification: if a pair differs by non-ASCII characters once whitespace is stripped, the failure is classified as `encoding` rather than `whitespace`. The fault log also stores a `bufferPreview` (about five lines of raw buffer either side of the closest fuzzy match, as `L<n>: <content>`) and an `oldStrPreview` for side-by-side reading in the fault log viewer. **Correction:** earlier versions of this document described a char-level `diffVsBuffer` appended to every noMatch response. That is not what the code does. The `diffVsBuffer` field exists in the fault-log record and the viewer has a red style for it, but on the `str_replace` failure path it is initialised to `null` and never assigned (`mcp-registration.js` L980 and L1007; `lib/fail-diagnostics.js` L17 records it as dead data). Nothing in the response shows a character-level diff.

*`[unicode]` flag in `get-repo-map`* — files containing non-ASCII characters are flagged at session start so the LLM knows to use `fuzzyContent` or `regex:true` before the first edit fails.

---

## Failure Mode 3 — Hallucinated trailing comments in `old_str`

**What happens:** The LLM constructs `old_str` with a trailing `/* comment */` or `// comment` that doesn't exist in the buffer — either hallucinated from a different file version or from training data. The line content is otherwise correct. The match fails because of the extra comment.

**How we know it's common:** A distinct cluster in `failure-log.ndjson` showed entries like `oldStrPreview: "int hal_wifi_disconnect(void) /* verified */"` with `diffVsBuffer` showing the buffer had no trailing comment. Recognisable pattern across multiple files and sessions.

**Solution:**

*Auto-autoStripComment* — since v0.10.28 fires automatically after `fuzzyContent` also fails. Checks if the last line of `old_str` has a trailing comment absent from the buffer. Strips it, retries. On match, appends `/* CHECK: <comment> */` to the corresponding line of `new_str` so the salvaged comment is visible for review. Tagged `[autoStripComment]`. Only fires on single-line trailing comments on the last line of `old_str` — conservative scope to avoid false positives.

*`[trailing-comments xN]` and `[check-me xN]` flags in `get-repo-map`* — files with many inline trailing comments are flagged at session start. `[check-me xN]` flags files with `/* CHECK: */` markers left by prior rescues awaiting review.

---

## Failure Mode 4 — Line number drift

**What happens:** The LLM reads the file at turn N and gets line numbers. Edit 1 shifts everything below it. By edit 2 the line numbers in the LLM's head are wrong. Any line-number-based tool call — `insert` with `afterLine`/`onLine`/`beforeLine`, `delete` with `startLine`/`endLine` (which its own description calls legacy and a last resort), or `afterLine`/`beforeLine` on `str_replace` — is affected. An `afterLine` or `beforeLine` pointing 40+ lines off makes the search window miss the target, and the failure is logged as `hintFault:afterLine:contentMiss` (or `hintFault:beforeLine:contentMiss`) with a `bufferPreview` of the wrong region.

**How we know it's common:** In the June 2026 lifetime stats, line-number hints (then `lineNumberHint`, now `afterLine`/`beforeLine`) were used over 1300 times against 46 for `afterHint` (now `afterString`) and 42 for `functionHint` (now `inFunction`). The LLM reached for line numbers habitually because they're immediately available from grep output, even though content anchors would have been drift-immune. Multiple `failure-log` entries showed `lineHint pointing at wrong region` — the hint was off by 40+ lines due to prior inserts. Those June counts are historical and are not re-verified: lifetime absolute counts are double-counted by a bug found 2026-09-24 (see the stats section), and the current mix has shifted, with `afterString` now the most-used hint in the live lifetime stats. Whether the shift came from the `successNudge` upgrade suggestion below has not been checked.

**Solutions:**

*Content-anchored hints* — `inFunction`, `afterFunction`/`beforeFunction`, `afterSymbol`/`beforeSymbol`, `betweenHint`, `afterString`, `beforeString`. These anchor by content rather than position; they don't drift when lines are inserted above the target. (The June 2026 version of this list named `functionHint`, `afterHint` and `lineContentHint`; per the status note at the top of this document, those parameters were later renamed or consolidated into the names above.)

*`afterString`/`beforeString`* — accept a unique string on or near the target line rather than a line number. Content-stable, drift-immune. These are the current form of what this document used to call `lineContentHint` and `afterHint`.

*`successNudge` upgrade suggestion* — `successNudge()` in `lib/tool-hints.js` has two triggers. Case 1: when a purely positional hint (`afterLine`, or the since-removed `insert_line`) was the only hint used on a file of 100 or more lines, the success response appends `afterLine is positional -- it drifts if lines are inserted or deleted above it`, followed by a concrete `Switch to afterString:"<anchor>"` suggestion. The anchor string is extracted from the matched line at commit time (first 80 characters), so it is immediately usable, not generic advice. Case 2: when no hint at all was used on a file of 300 or more lines, it appends a hint reminder. Two branches of Case 2 are worth knowing: a `str_replace` whose `old_str` looks like a whole function is steered to `replace-function-body`, and a file with no parseable symbol table (for example `.md` or `.txt`) is steered to `afterString`/`beforeString` with a note that `inFunction` will not work there. Trains the pattern within the session before the next failure.

*`afterLine`/`beforeLine` are search-narrowing hints, not position anchors* (this hint was called `lineNumberHint` until the parameter consolidation) — the window is directional, not symmetric. `afterLine:N` searches from line N down to N+25, and the target may be on line N itself; `beforeLine:N` searches from N-25 up to and including line N. The 25 is the default `HINT_RADIUS` (`lib/tree-sitter-symbols.js`), and `hintRadius` on `str_replace` overrides it. If `old_str` is found in the window, it matches normally. It does not bypass content matching. The old `lineNumberHintFallback` positional overwrite was removed in v0.10.26 after what the June 2026 lifetime stats recorded as 218 silent wrong-region overwrites. That is an absolute lifetime count, and lifetime absolute counts are unreliable because of the double-counting bug (see the stats section), so treat 218 as an upper bound rather than an exact figure.

*Hint reliability — measured (re-measured 2026-09-24)* — the June 2026 figures were `afterString` 100% (56/56) and `afterLine` 75% (12/16), which matched the theory that content anchors are stable and line numbers drift. The live lifetime figures now read `afterString` 92% (282 ok, 26 failed), `afterLine` 88% (88 ok, 12 failed), `beforeString` 100%, `afterFunction` 100%, `betweenHint` 60%, and `inFunction` 44% (28 ok, 36 failed). These are ratios, so the lifetime double-counting bug (see the stats section) does not distort them, although it does inflate the raw counts shown here by about 2x. `afterString` and `afterLine` have the largest samples; `beforeString`, `afterFunction` and `betweenHint` have too few attempts to trust. The June and live figures also come from different mixes of work, so do not read the change as a trend. Three points follow. First, the gap between `afterString` and `afterLine` is now 4 points rather than 25, so the old rule "never use `afterLine` as the sole hint" is weaker than this document used to claim; `afterLine` is still drift-prone in principle and still worth pairing with a content anchor on a file under active edit. Second, the `str_replace` tool description calls `inFunction` the "safest choice for JS/C", and its measured success rate contradicts that. The cause was investigated in part on 2026-09-24. The fault log (`get-failure-log`, reason `hintFault:inFunction`) holds 32 entries from 2026-06-18 on, all `notFound` or `ambiguous`; 11 are deliberate test fixtures (`nosuchfn`, `dupfn`, `nope`, `beta` and similar). Of the other 21, 11 are C++ methods in the Ghidra decompiler `.cc` files (six written `Class::method`, five as the bare name), 8 are names that are not plainly declared functions in `mcp-registration.js` and `match-engine.js` (`grep-project`, `insert`, `str_replace`, `insert-function-doc`, `delete_line_range`, `handler`, `module`, `insertSchema`), one is a Python function, and one is `test_en_dash` in a C test file, which is unexplained. So the failures cluster by file type and hint value, and the 44% is probably a mix effect, although successes were not broken down by file type, so that is not shown. Confirmed by running `getSymbolsFromText` on snippets: the regex fallback in `lib/tree-sitter-symbols.js` cannot see out-of-class C++ definitions such as `void PrintC::opCopy(...)` (`C_FN_RE` cannot span `::`), and it returns no symbols for any extension that is not C-like or JS-like; it does find plain C functions. Not confirmed: whether the tree-sitter path, which is tried first, is also empty for `.cc` files, and why the tool-name hints fail. `getSymbols` returns the tree-sitter symbols alone whenever there are any, so the regex path that knows `registerTool` and `curTool` never runs for a parsed JS file; that fits the failures but was not tested. When the symbol table of a file is empty, `resolveSymbolPosition` returns `notFound` for a function lookup (`needsTreeSitter` is only used for kind `any`), so the LLM is not told that the file has no usable symbol table; whether the S2 `resolveScope` path behaves the same was not checked. The log and the stats do not reconcile exactly (24 `str_replace` entries in the log against 36 lifetime `inFunction` fails in the stats, about 18 after undoing the double count), and the sample is small, so treat all of this as indicative. Until it is fixed, prefer `afterString` on C++ files and for anything that is not a plainly declared function, and check the failure reason when `inFunction` fails. Third, the June `afterLine` failures were all `afterNotFound`, meaning the hint pointed at a region that had shifted; the current failure reasons have not been broken down.

---

## Failure Mode 5 — Duplicate pattern confusion (silent wrong-occurrence commit)

**What happens:** The same short pattern appears multiple times in a file — error handlers, struct initialisers, `return null`, repeated boilerplate. `str_replace` hits the first occurrence which is not the intended one. The LLM doesn't notice because the match succeeds — there's no error, no warning. The wrong function gets modified.

**How we know it's common:** `ambiguous` is tracked as a distinct fail class in stats. It became trackable once the ambiguity guard existed to produce the counter — before that, wrong-occurrence commits were invisible (they showed as hits, not failures). The guard's value is precisely that it converts silent corruptions into visible blocks.

**Solutions:**

*Ambiguity guard* — before committing, `str_replace` counts all occurrences of `old_str` in the full file. If more than one match exists and no scope hint is set, the edit is **blocked** with a `⚠️ AMBIGUOUS MATCH` response listing every matching line number. The LLM must add a hint before proceeding. The same guard applies to `replace-block`, `replace-function-body`, and the anchor modes of `delete` (its earlier separate `delete-block` tool was folded into `delete`; `delete` has an `anchorAmbiguous` failure counter). Passing `occurrence:N` where N > 1 disables the guard — deliberate targeting of multiples.

*`occurrence:N`* — target the Nth match explicitly. When the pattern repeats and `inFunction` doesn't apply, `occurrence:3` replaces the 3rd occurrence only without widening `old_str`.

*`inFunction`, `afterString`, `betweenHint`* — scope the search to a named function body, after an anchor string, or between two anchor strings. Reduces the candidate pool to a region where the pattern is unique. (Earlier versions of this document called the first two `functionHint` and `afterHint`.)

**Why the guard belongs in the tool, not the prompt:** Prompt instructions like "always check for duplicates" are forgotten mid-conversation. Tool-enforced blocking fires unconditionally at the exact moment the mistake would have been made.

---

## Failure Mode 6 — Off-by-one on block boundaries

**What happens:** The LLM tries to replace a function or block but gets the closing brace wrong — either including the start of the next function or leaving a stray `}`. Off-by-one errors on any block that spans many lines.

**Solutions:**

*`replace-function-body`* — brace-matched replacement. The LLM names the function; the tool finds the opening `{` and matches to its closing `}` using tree-sitter (for open files) or brace counting. The LLM never needs to know which line the closing brace is on.

*`replace-block`* — same brace-matching for non-function blocks. Triggered by any anchor string rather than a function name. Finds the next `{` after the anchor and matches to its closing `}`. Covers loops, conditionals, switch cases, struct blocks.

*`delete` (anchor modes)* — content-anchored delete, replacing the earlier separate `delete-block` tool. `inFunction:'name'` deletes a whole named function including its signature; `startContent` plus `endContent` deletes from one anchor line to the other (`inclusive:false` keeps the anchor lines); `matchString` deletes one exact block. No line numbers needed. An earlier version of this document described a brace-match mode for `delete-block`; the current `delete` schema has no brace-match parameter, so for a brace-delimited block that is not a function, anchor it with `startContent` and `endContent` instead. (Whether `replace-block` accepts an empty replacement as a delete has not been checked.) The raw `startLine`/`endLine` mode remains, but the tool's own description marks it legacy and a last resort; pair it with `expectedContent`.

---

## Failure Mode 7 — Stale context on large files

**What happens:** On large files `read-file` returns so much text that by the time the LLM is generating its edit, the relevant section has scrolled out of its attention window. It generates `old_str` from reconstruction rather than the actual text — paraphrases a comment, changes a variable name slightly, drops a blank line.

**Solutions:**

*`read` with content-anchored hints* — `inFunction`, `afterString`/`beforeString`, `betweenHint` (or the equivalent `startContent`+`endContent`), `sectionHint`, `preprocBlock`, or `nearLine`/`centerLine` with `radius` (default 10). Brings only the relevant region into context without loading the full file. This tool replaced the earlier `read-lines`; ambiguous anchors are refused with the candidate lines listed rather than guessed.

*`get-repo-map`* — Aider-style compressed codebase index. Tree-sitter symbol extraction, PageRank-ranked by cross-file reference density, rendered within a token budget (default 1024 tokens). Called at session start to orient the LLM without consuming the context window. `mentionedFiles` boost re-centres the map around files currently being edited.

*`read` with `betweenHint`* — returns lines between two anchor strings. This is the former `get-region`, merged with `read-lines` into the single `read` tool (`mcp-registration.js` L2172; `lib/edit-stats.js` L56 dates the consolidation 2026-09-18). Content-stable — the LLM asks for "the HAL_Init block" without knowing its line number.

*`get-file-summary`* — structural summary: functions, includes, defines, TODOs. Cheap orientation before deciding what to read in full.

---

## Failure Mode 8 — Schema/handler mismatch (hints silently dropped)

**What happens:** A hint is fully implemented in a tool's handler but not declared in `inputSchema`. The Zod validator silently drops it before the handler receives it. The LLM tries `delete-line-range functionHint:"someFunction"` and receives a result as if no hint were specified — no error, no warning, the hint simply didn't work. (Those are the June 2026 names; see the naming note in the next paragraph for the current ones.)

**How it was found:** Systematic audit of all edit tools comparing `inputSchema` declarations against handler parameter usage. `delete-line-range` had `dryRun`, `functionHint`, `afterHint`, `lineNumberHint`, `betweenHint`, `occurrence`, and `fuzzyWhitespace` fully implemented but none declared in schema. The tool appeared functional when tested manually; the bug was invisible without the audit. *Naming note:* this incident is described with the tool and parameter names in use in June 2026. `delete-line-range` has since been folded into `delete` (2026-09-17), `functionHint` is now `inFunction`, `afterHint` is now `afterString` (or `afterFunction` for a function), and `lineNumberHint` is now `afterLine`/`beforeLine`.

**Solution:**

*Schema audit matrix* — all edit tools verified that `hints`, `dryRun`, `fuzzyWhitespace`, `occurrence` are present in both `inputSchema` and the handler wherever intended. `ANCHOR_SCHEMA` is a shared Zod spread applied to the tools that accept hints, so adding a new hint touches one place. A second shared schema, `STRUCTURAL_ANCHOR_SCHEMA`, carries the section-banner and preprocessor hints (`sectionHint`, `preprocBlock`, `preprocSide`) and is spread into `insert` and `delete`; `str_replace` adds those three individually because the shared schema also carries `afterContent`/`beforeContent`, which are insert-only (comment at `mcp-registration.js` L250-255). So "one place" is not quite true any more: a new structural hint has to be added to `STRUCTURAL_ANCHOR_SCHEMA` and also declared separately for `str_replace`. (`read` also accepts `sectionHint`/`preprocBlock` but does not spread the shared schema; how it declares them was not traced.) This is the same drift that caused the original failure, so audit the schemas after adding a hint.

---

## Failure Mode 9 — Regex-based function matching failures

**What happens:** Function detection and anchor resolution were originally built on regex. This caused `replace-function-body` notFound on arrow-function and `registerTool` patterns the regex never matched; function-name scoping (then `functionHint`, now `inFunction`) finding the wrong occurrence when a name appeared as both definition and call sites; and an "insert after this function" anchor (then `afterHint:"fn_name"`, now `afterFunction:"fn_name"`) resolving to the first character occurrence of the string rather than the end of the function — causing insert-after-function to land inside the function body.

**Solution:**

*Tree-sitter migration (v0.10.20–v0.10.21)* — `lib/tree-sitter-symbols.js` replaced all 9 regex-based function-matching sites. `afterFunction:"fn_name"` now resolves to the **end** of that function (`sym.endRow`), not the first character. (In June 2026 this anchor was `afterHint:"fn_name"`.) `betweenHint` spans function-to-function semantically. Ambiguous hints return an error with a list of matches rather than silently picking the first. All tools (`list-functions`, `read`, `str_replace`, `replace-function-body`, `get-repo-map`, etc.) share the same backend — consistent results everywhere.

---

## Failure Mode 10 — Post-edit structural damage (silent cascading errors)

**What happens:** An edit introduces an unclosed `{`, an unclosed `/* block comment`, or an unmatched `#if`. The linter and compiler don't fire immediately. The next edit fails on a corrupted baseline with a confusing error that has nothing to do with what it tried to change.

**Solution:**

*Post-edit structural integrity check (`lib/struct-check.js`)* — delta snapshot before and after every edit on `.c .h .js .ts` and other brace-delimited files. Three metrics: net brace balance, unclosed block comments, `#if`/`#endif` depth. Delta-only — pre-existing imbalances are silently ignored; only damage introduced by *this edit* is reported. Warning appended to the success response as `⚠️ struct: unmatched opening brace (net +1 { })`.

*`check-struct` tool* — on-demand absolute snapshot for session-start baseline assessment.

---

## Failure Mode 11 — Unified-diff patches are a poor fit for LLM use

**What happens:** Unified diff format asks the LLM to state line numbers (the `@@ -a,b +c,d @@` header) at generation time, and it cannot do that reliably: the numbers diverge from the file during multi-edit sessions. That is a property of the unified-diff format, not of patches in general. Cline and opencode both use a different format (`*** Begin Patch` / `*** Update File:`, an optional `@@ <context line>`, then lines prefixed with `+`, `-` or a space, and no line numbers) and locate each hunk by matching content instead.

**Evidence:** `apply-patch` lifetime stats as read on 2026-09-24: 0 hits, 44 fails and 2 rescued commits. The absolute counts are inflated about 2x by the double-counting bug described in the stats section. The earlier text here said 0 hits across 40+ calls and that every attempt fell back to `str_replace` or `replace-function-body`; that fallback claim has not been re-verified. Neither Cline nor opencode ships success-rate data for its format, so their source does not show how reliably models produce it. Both restrict it by model: opencode offers `apply_patch` only to `gpt-` models (not `gpt-4`, not `oss`) and there it replaces `edit` and `write` (`packages/opencode/src/tool/registry.ts` L297-300), and Cline registers it in its GPT-5 variant configs. It is used where models are presumably trained on the format, which says little about models in general. This was read from source on 2026-09-24 and not run.

**Solution:** For this tool the recommendation stands: `apply-patch` is best kept for human-provided patches or for applying a diff received from an external source (a `git diff`), not one the LLM generates itself, and the content-anchored tools (`str_replace` with hints, `replace-function-body`, `replace-block`) cover the same use cases without the line-number dependency. The reason is the unified-diff format, not patches as such. If a patch tool for LLM-authored edits is ever wanted, the content-anchored format is the one to evaluate. Two behaviours seen in the sources should be decided deliberately rather than copied by default. opencode computes every hunk before writing any file, so a failed match aborts the whole patch with nothing written (`src/tool/apply_patch.ts` L72-191 run before the write phase at L220). Cline skips a chunk whose context is not found, records a warning that its handler never reads, and applies the rest (`PatchParser.ts` L145-157), so a partly applied patch is reported as success. Neither tool refuses an ambiguous match; both take the first hit from the cursor (compare Failure Mode 5). Cline also has a character-level similarity tier (>= 0.66 on the joined block, L309-316) even though its comment describes it as 2/3 of lines.

---

## Failure Mode 12 — LLM-generated kernel C style violations

**What happens:** LLMs trained on mixed codebases produce syntactically valid C that violates Linux kernel coding style in consistent ways: single-line `if` bodies (`if (!g_hal) return -1;` instead of the body on the next line), Doxygen `@file`/`@brief` tags instead of plain `/* */` comments. Neither is caught by the compiler or linter.

**Solution:**

*Inline per-edit style check* — every edit on `.c`/`.h` files automatically runs the kernel style checker against the lines it added or changed. Violations appear as `🎨 style` suffix on the success response. Only new lines, never pre-existing content — so the LLM sees exactly what it introduced.

*`checkpatch` tool* — whole-file audit on demand, grouped by rule sorted by frequency. Use at session start to understand the style baseline before editing.

*`singleline_if` rule* — detects `if`/`else`/`for`/`while` followed by a non-brace statement on the same line. CHECK severity (not a block) because a small number of kernel subsystems permit it in macro contexts.

---

## Failure Mode 13 — No cross-session memory (same mistakes every session)

**What happens:** The agent starts every session with zero codebase-specific knowledge of what caused retries last time. "Whitespace on this file is tabs not spaces" is completely lost by the next session. Repeated failures on the same pattern across sessions are invisible.

**Solution:**

*`session-notes`* — persistent store the LLM writes to and reads from across sessions. At session start the LLM reads what it wrote last time and adjusts immediately — which hints worked on this codebase, which files hot-reload on save, what caused retries. Combined with `get-repo-map` at session start, the LLM arrives knowing both the code layout and accumulated codebase-specific lessons.

*It does need maintenance.* An earlier version of this document claimed it "improves automatically with use; no user maintenance". Experience since then says otherwise. The notes for one project grew to 45 records and roughly 190 KB, too large to read into context in one call, and they accumulated status claims that were later wrong ("Section 2 not wired", "that error is benign", "str_replace has no auto-save"), which later sessions inherited (see Failure Mode 21). Keeping the notes useful took deliberate curation: consolidating many notes into a few, writing a single "current state -- start here" note that supersedes older pointers, taking a dated backup before deleting anything, and deleting the highest index first because `delete` shifts the later indices down. Habits that keep it working: keep one current-state note and update it rather than adding parallel lists; record the evidence (file, line, command) for anything marked confirmed; read with `tail:N` rather than the whole store; and periodically review older notes for claims the code has since overtaken.

---

## Failure Mode 14 — Wrong file active (contentFaults)

**What happens:** The LLM issues a `str_replace` while a different file is the active editor. The edit targets `mcp-registration.js` but the active tab is `tool-catalogue.js`. The search runs on the wrong buffer, finds nothing, and returns `noMatch` — or worse, if the pattern happens to exist in both files, it commits to the wrong one silently.

**How we know it's common:** Lifetime stats introduced a `faultBuckets` field to classify `str_replace` faults: `contentFaults` (old_str genuinely absent from the buffer — wrong file or stale content) vs `hintFaults` (hint resolution failed — drift, typo in anchor). Analysing the `failure-log.ndjson` cluster showed the `contentFaults` group was dominated by sessions where the LLM had switched between files without tracking which was active. The pattern was recognisable: correct `old_str` content, zero whitespace or encoding issues, but wrong file path in the blame.

**Solutions:**

*`filePath` parameter on all edit tools* — since v0.14.x every edit tool (`str_replace`, `insert`, `delete`, `replace-function-body`, `replace-block`, `apply-patch`, `sed`, `replace-document`) accepts `filePath`; in the current schemas of `str_replace`, `insert`, `delete`, `sed` and `apply-patch` it is a required field. (`delete` replaced the earlier `delete-line-range`, which is what this list originally named.) The framework opens the file in a background tab if it's not already open. The active tab is never used for writes. Passing `filePath` on every edit call eliminates the entire `contentFault` failure class — the edit can never land on the wrong buffer regardless of what the user or prior tool calls have made active.

*Rule: always pass `filePath` on edit calls to source files.* In the current tool schemas `read`, `grep-file`, `str_replace`, `insert` and `delete` all declare `filePath` as required, so the earlier advice that read tools (then `get-region`, `read-lines`, `grep-file`) could omit it to operate on the active editor no longer applies to them. Edit tools should still never rely on the active editor.

*`show-last-edited-file` command* — **Packages → MCP Server → Show Last Edited File** reveals which file was actually committed to most recently. Useful when the active tab is uncertain.

*Focus toggle* — `atom.config` key `pulsar-edit-mcp-server.focusEditedFile` (default `true`). When true, committing via `filePath` to a file already open in a tab brings that tab to focus. Toggle via **Packages → MCP Server → Toggle Focus Edited File**.

---

## Failure Mode 15 — Old_str found outside the active scope

**What happens:** The LLM uses `inFunction` or `betweenHint` to scope a `str_replace` to a region, but `old_str` doesn't appear inside that region — it exists in a different function or section of the file. The tool returns `noMatch` from the scoped search. Without more information the LLM might widen or remove the scope (making the wrong edit in the wrong place) or retry blind.

**How we know it's common:** `foundOutsideScope` was added as a distinct fail counter in `edit-stats.js` after the `scanForOldStr` feature was built to address this. Before the counter existed, these failures were indistinguishable from genuine content mismatches in stats.

**Solution:**

*`scanForOldStr`* — when `str_replace` returns `noMatch` with a scope hint active (`inFunction` or `betweenHint`), the full buffer is scanned for `old_str`. If hits are found outside the scope, the failure response includes a 🚨 **FOUND OUTSIDE SCOPE** block listing up to 5 hit locations with line numbers and nearest function context. This immediately tells the LLM: "the content exists, but not where you specified — here's where it actually is." The counter `fails.foundOutsideScope` is bumped in stats. Correct action: either update `inFunction` to the function where the hit was found, or reconsider whether the edit target is correct.

---

## Failure Mode 16 — Hint failures invisible in the fault log

**What happens:** When a hint resolution fails — `afterString` not found, `inFunction` not found or ambiguous, `betweenHint` start/end not found — the tool returns an error and bumps the relevant stats counter (`fails.afterNotFound`, `fails.outOfScope`). But the early-return path never called `logFailure`, so nothing was written to `session-faults.ndjson`. The fault log only ever received content failures (`noMatch`, `whitespace`, `partialMatch`). The 28+ `afterNotFound` hint faults visible in the June 2026 lifetime stats had zero corresponding fault log entries — the actual hint strings, file paths, and `old_str` context were completely uninspectable. (This is a historical lifetime count and has not been re-verified. Lifetime absolute counts are currently inflated by the double-counting bug described in the stats section, and when that bug began is not known, so treat "28" as approximate. The argument does not depend on the exact number: a non-zero counter with no log entries.)

**How we know it's common:** Reviewing the fault log after a session with known `afterNotFound` faults showed only `noMatch` entries. Cross-referencing with `get-edit-stats` confirmed the count discrepancy: 28 `afterNotFound` faults in stats, 0 hint-related entries in the log. The gap was structural — the early-return pattern for all hint failures bypassed `logFailure`.

**Solution:**

*`logHintFailure()` helper (v0.15.1)* — module-level function wrapping `logFailure` with a structured `reason` field: `"hintFault:<hintName>:<variant>"`. Variant is one of `notFound`, `ambiguous`, or `needsTreeSitter`. Also records `hintValue` (the failing anchor string, truncated to 80 chars) and `oldStrPreview`. Wired at all 12 hint failure early-return sites in `str_replace` and all 8 in `insert`. The `sectionHint`/`preprocBlock` path in `insert` already called `logFailure` and was left untouched.

The fault log `reason` field now takes one of two forms:
- **Content failures:** `noMatch` / `whitespace` / `partialMatch` / `encoding` — hint resolved, `old_str` didn't match
- **Hint failures:** `hintFault:<hintName>:<variant>` — anchor resolution failed before the search even ran

Both are queryable via `get-failure-log` with `reason` filter (e.g. `reason:"hintFault"` shows only anchor failures). The fault log viewer's Reason column displays both classes directly.

---

## Failure Mode 17 -- Exception between the buffer edit and the save (silent unsaved edit)

**What happens:** A tool mutates the buffer, then later bookkeeping (decorate, nudge, lint, style, response building) throws before reaching the call that saves. The edit is in the buffer but not on disk. Every buffer-first read tool (`grep-file`, `read-file`, the dry-run preview) agrees with the buffer; an external read (PowerShell `Get-Content`) shows the stale disk. The error message is about something unrelated to the edit, and because the edit visibly landed, it is easy to label the error "benign" and carry on.

**How it was found:** 2026-09-23/24. `str_replace` called `buffer.setTextInRange()` and then `successNudge({ symbols: allSymbols })`, but `allSymbols` was undeclared after a refactor (Failure Mode 18), so every committed `str_replace` threw a `ReferenceError` before `buildEditResponse()` -- the call that saves. A long README buffer-versus-disk loop followed. Two wrong diagnoses came first: "the tool has no auto-save" (it does; the save is inside `buildEditResponse`) and "the error is benign".

**Solutions:**

*Treat any error that follows a real content edit as a bug, not noise.* Confirm with `get-active-editor-info` (`modified:true` means unsaved), then find why the save was not reached rather than adding a second save.

*Say which layer each read observes.* Buffer-first tools and raw disk reads can both be correct and still disagree. Call `save-all` before trusting an external read.

*Hardening (recommended, not yet applied):* wrap the post-`setTextInRange` bookkeeping in `try/finally` so a late throw can never leave an unsaved buffer or hide the edit result.

---

## Failure Mode 18 -- A refactor drops a declaration; static checks and dry-runs cannot see it

**What happens:** Swapping a hand-rolled block for a delegating call deletes a `const` that code further down still reads. `node --check` passes (an undeclared identifier is a runtime `ReferenceError`, not a syntax error), `get-diagnostics` reports 0/0/0, the extracted module's own unit tests pass (they never load the handler), and dry-run verification passes because dry-run returns before the commit path.

**How it was found:** The S4e Section 2 rewire removed `const allSymbols = getSymbols(...)` along with the ~145-line scope block; the use at the success path went unnoticed until 2026-09-24. Section 2's live checks were ambiguity refusals and dry-run previews, none of which reached the commit. The same family appeared in the Section 3 rewire: `allOccurrenceLines = [...]` reassigned a `const` and crashed `str_replace` on every file.

**Solutions:**

*After any rewire, grep every identifier the deleted block declared for remaining uses.* This is a one-minute check that would have caught the bug.

*Do not count a dry-run as verification of the commit path.* After each rewire run at least one real, non-dry-run commit through each path (scoped and unscoped) on a scratch fixture, then read the disk back.

*Consider a handler-level smoke test* that drives a real commit against a fake buffer, so the standing suite exercises the code the module tests skip.

---

## Failure Mode 19 -- A defaulted parameter is treated as an explicit one (ambiguity guard silently disabled)

**What happens:** A wrapper passes a caller-level default (`occurrence = 1`) straight through to an engine that treats any non-null value as an explicit disambiguation choice. The engine's ambiguity refusal never fires: two functions named `beta` resolve silently to the first, and the failure that eventually appears ("not found anywhere") is misleading. This is Failure Mode 5 (silent wrong-occurrence) reintroduced by the delegation layer.

**How it was found:** Live test of Section 2 on 2026-09-23 against a scratch file with two functions named `beta`. The same bug class was then caught proactively in Section 3 before wiring (`_fragOccurrence`).

**Solutions:**

*Forward `occurrence` only when it is explicitly greater than 1* (`scopeOccurrence`, matching the existing `_hasScope` convention). "Null" and "1" are different values at an interface even when the caller treats them as the same.

*Every delegation that passes a defaulted parameter needs a duplicate-name fixture test.* If the tool does not refuse the ambiguous case, the guard is off.

---

## Failure Mode 20 -- Dry-run and commit disagree about what matched

**What happens:** The dry-run reports a match, but the real call fails with `commit-time verification failed ... No write was made`. The match stage normalises certain characters (apostrophes, smart quotes, dashes, double-encoded mojibake); the commit re-verifies the exact text in the live buffer and refuses. The safety guard works as designed (nothing is written), but the LLM has no signal that its `old_str` only matched after normalisation.

**How it was found:** 2026-09-24, editing the refactor plan document, which already contains mojibake. An `old_str` containing an apostrophe matched in dry-run and failed at commit.

**Solutions:**

*Use `regex:true` and replace the ambiguous character with `.`.* Regex mode replaces the exact characters it matched, so the commit verifies cleanly. Alternatively anchor on an ASCII-only substring.

*Treat a dry-run as necessary but not sufficient* for files known to contain non-ASCII text (`get-repo-map` marks these `[unicode]`).

*Write new text in plain ASCII in files that already contain mojibake*, and edit them only through the Pulsar tools, never by re-saving through `Set-Content`/`Out-File`, which can compound the damage.

*Candidate improvement (not built):* have the dry-run run the same exact-text verification as the commit, or tag its result when normalisation was needed, so the refusal is visible before the real call.

---

## Failure Mode 21 -- Diagnosis errors: conclusions from absence, one "ground truth", and stale status claims

**What happens:** Three related reasoning failures cost most of the time in the S4e session.

1. *Concluding "X is never called" from a search of one file.* A grep for `.save()` in `mcp-registration.js` found none in `str_replace`'s handler, and "no auto-save" was recorded as a confirmed bug. The save lives in `buildEditResponse()`, in another module. The correct diagnosis needed the full path to the terminal effect.
2. *Picking one view as ground truth.* A raw disk read was trusted over the buffer, then two internally consistent pictures were reconciled for a long time instead of asking which layer each one observed.
3. *Inheriting status claims from notes and docs.* Notes and plan text said "Section 2 not wired" and "that error is benign" while the code said otherwise, and later sessions built on them.

**Solutions:**

*Before concluding absence, trace the call path to the terminal effect,* including helpers the handler passes data into.

*Verify status against the code, not against a note.* For "is it wired", grep the `require` and the call site. When recording something as confirmed, record the evidence (file, line, command) so it can be re-checked.

*Correct wrong notes with a superseding "current state" note, then delete the wrong ones after taking a backup* (a dated copy of `session-notes.ndjson`). Delete the highest index first because indices shift, and fix any cross-references afterwards.

---

## The auto-retry pipeline

The most common `str_replace` failure causes fire automatically before a failure is returned, requiring no explicit flags. Each was opt-in originally; after lifetime stats showed them accounting for the vast majority of `noMatch` failures, automatic rescue became the safer choice.

The rescue logic lives in `lib/recover.js` and is shared: `str_replace` delegates to it (since S4a), and `match-engine.js`'s `matchContent()` calls the same functions for the other tools. `recover.js` is pure -- it returns data and never bumps stats or builds messages; the calling tool does that. (The header comment at the top of `recover.js` still says `str_replace` runs its own inline copy. That comment is stale; the code at the call sites is authoritative.)

This is NOT a strict sequential waterfall. The original design tried whitespace, then encoding, then comment-strip as separate passes. That misses a line with more than one kind of difference (for example an indent difference AND a smart quote), because neither a trim-only pass nor an encoding-only pass matches it alone. The current design diagnoses everything in one pass and does one combined retry.

The diagram below is `str_replace`'s path. Other tools go through `match-engine.js`'s `matchContent()`, which is close but not identical: it runs exact first, then explicit `fuzzyWhitespace` and `fuzzyContent` stages only when the caller asked for them, and only then falls through to the same two `recover.js` rescues. It exposes an `autoRescue` option (default true) so a destructive caller can turn the automatic guessing off. `delete` (its `startContent`, `endContent` and `matchString` modes) and the start/end pair tool pass `autoRescue:false`, so they use strict matching and will not silently match a transformed needle. If a `delete` anchor fails with "not found" while the same text is visibly in the file, that is the reason: the anchor must match exactly, including any non-ASCII characters. As above, `regex:true` bypasses the whole waterfall in both paths. The project's stated direction is that where the engine and `str_replace` disagree, the engine changes to match `str_replace`, so treat this difference as temporary.

```
P1  exact match           -- indexOf in the resolved search window
P2  profiledMatch         -- ONE combined rescue (skipped when regex:true):
      classify every difference in one pass:
        whitespace-only | unicode/encoding | trailing comment on the last line
      build ONE transformed needle from whichever transforms are needed
      retry ONCE against the window
      tags: [autoFuzzyWhitespace] [autoFuzzyContent] [autoStripComment]
      two hits in the window -> REFUSE as ambiguous (B41), never pick the first
P3  partialMatchRescue    -- drift rescue (multi-line old_str only; skipped when regex:true):
      window had no match at all -> search the WHOLE buffer for old_str's first 2 lines
      found outside the resolved scope -> retry a whitespace-tolerant match from there
      the same 2 lines occur more than once in the file -> REFUSE as ambiguous (B41)
      tag: [autoPartialMatch]
-> FAIL: diffVsBuffer char diff + Levenshtein similarity% + smartSuggestion
         + scanForOldStr scope check + session-faults.ndjson
```

`regex:true` is not a stage in this pipeline. It is an explicit up-front matching mode that replaces the plain-text match, and it disables both rescues above. In regex mode `^`/`$` are line anchors (`gm` flags) and the commit replaces the exact characters that matched.

Guards worth knowing about:

- *Trailing-comment strip is conservative.* The stripped last line must keep at least 8 non-space characters and the whole needle at least 10 (`STRIP_MIN_LAST` / `STRIP_MIN_TOTAL`), so stripping a comment can never leave a trivial anchor behind. It only looks at the LAST line of `old_str`.
- *A salvaged comment is not thrown away.* It is appended to the last line of `new_str` as `/* CHECK: <comment> */`, but only if that line has no comment of its own.
- *`partialMatchRescue` is not a prefix match.* An earlier version of this document described it as "old_str is a prefix of a longer buffer line". That is not what the code does; it is a full-buffer drift rescue for the case where a prior insert or delete moved the target so the scope hint points at the wrong area.

Tags in the response (`[autoFuzzyWhitespace]`, `[autoFuzzyContent]`, `[autoStripComment]`, `[autoPartialMatch]`) show which rescue fired, so the LLM can supply the flag explicitly next time.

---

## Smart failure suggestions

**On failure #1:** `smartSuggestion()` fires immediately — not after 3 attempts. It analyses why: no hints used → lists the specific hints with concrete syntax; `old_str` looks like a whole function → suggests `replace-function-body`; `old_str` looks like a brace block → suggests `replace-block`; large file + no hints → adds urgency text.

**On success with no hints:** `successNudge()` is appended to `str_replace` success responses when no hints were used on a file >300 lines. It tells the LLM which hints to use next time and, if `old_str` looks like a function, explicitly suggests `replace-function-body` instead. Closes the feedback loop before failures start.

**Levenshtein similarity %:** When `old_str` has >= 2 lines and a closest-area is found, a similarity percentage is appended: `"📊 Similarity: 87% — likely whitespace drift, try fuzzyWhitespace:true"`. Three bands: >=80% (whitespace/encoding, use a fuzzy flag), 50–79% (stale content, re-read), <50% (wrong location, use a scoping hint). Calibrated from lifetime stats clusters.

**Nearest-symbol suggestion on anchor failures:** When an anchor hint fails to resolve (`anchorError` in `lib/tool-hints.js`) and the hint value is a single word (`/^\w+$/`), the file's symbols are scanned for the best Levenshtein match >= 60%. The trigger is the shape of the value, not which hint was used, so a one-word `afterString` can get a suggestion too. (An earlier version of this document named `afterHint`/`betweenHint` here; `afterHint` is now `afterString`. Which hint names reach `anchorError` was not traced beyond the ones its header comment lists.) If found: `"💡 Nearest symbol: hal_wifi_scan (87% match)"`. Turns a dead-end anchor failure into a one-step correction.

---

## Stats and instrumentation — what the compared tools do not expose to the model

**Per-tool, per-reason breakdown at the point of failure.** Of the three tools compared above, Cline classifies only two failure types (`search_not_found` and `other_diff_error`) and sends them to remote telemetry, Aider counts malformed responses in one undifferentiated counter, and opencode does not classify failures at all. Aider's failure reply to the model does say what went wrong for that one edit (a "Did you mean" chunk), but nothing accumulates it by reason. Here the distinction between `whitespace`, `partialMatch`, `ambiguous`, `noMatch`, and `outOfScope` is counted and kept, which is what makes the data actionable for development.

**Queryable mid-session by the LLM.** `get-edit-stats` returns the current session totals. The LLM can call this when failures cluster, see `"str_replace whitespace:8"`, and switch to `fuzzyWhitespace:true` for the rest of the session on that file — without waiting for session end.

**Lifetime persistence.** `get-edit-stats({ reset: true })` flushes session counters into `session/session-stats.json` (earlier versions of this document said `edit-stats.json`; that filename is wrong), increments session count, and zeroes session counters. The lifetime block accumulates across all sessions and survives server restarts. The path is `STATS_PATH` in `lib/edit-stats.js`.

> **Known bug, fix pending (found 2026-09-24):** lifetime counters are currently double-counted (about 2x). `bump()` writes each event to both the session and lifetime counters, and `syncToLifetime()` then adds the session-minus-shadow delta to lifetime a second time on flush. The symptoms are that every lifetime count is even and `lifetimeSessionCount` is inflated. Session counters are correct. **Treat lifetime ratios and percentages as usable and lifetime absolute counts as unreliable** until the fix lands and the stats file is re-baselined. Once it is fixed, replace this note with the fix date and the re-baseline date. See session note [45].

**Failure log viewer.** **Packages → MCP Server → Show Fault Log** opens an interactive modal: newest-first table, live filter by tool/reason/file, click any row for a detail view with `bufferPreview` (green), `diffVsBuffer` (red), `oldStrPreview` (amber) rendered as coloured code blocks. The Reason column now distinguishes two failure classes: content failures (`noMatch`, `whitespace`, `partialMatch`) and hint failures (`hintFault:afterString:notFound`, `hintFault:inFunction:ambiguous`, etc.) — previously all hint failures were invisible in the log; they only appeared as raw counters in `get-edit-stats`.

**Hint performance tracking.** `get-edit-stats` now reports `hintsSucceeded` and `hintsFailed` per hint name, plus `hintSuccessRate` (only for hints with at least one use). In the June 2026 lifetime data this surfaced the pattern `afterString` 100%, `inFunction` 100%, `afterLine` 75%. Those are historical figures: the re-measurement under Failure Mode 4 (2026-09-24) reads `afterString` 92%, `afterLine` 88% and `inFunction` 44%, so do not treat the June pattern as current. `faultBuckets` splits faults into `contentFaults` (old_str absent — wrong file or stale content) and `hintFaults` (hint resolution failed — drift, bad anchor). `fuzzyTriggerReasons` tracks why auto-rescue fired: `needsWhitespace`, `needsContent`, `needsComment`, `partial`. Together these let the LLM diagnose a fault class in one `get-edit-stats` call rather than reading the full failure log.

**Per-session history.** `get-edit-stats` returns `recentSessions` — the last 5 session summaries from `session-history.ndjson`, each with timestamp, edit count, hit rate, and fault count. Trend visible without reading the full lifetime block.

**Style stats isolated from edit stats.** `checkpatchRuns` and `checkpatchViolations` are separate fields from `editsChecked` and `totalViolations`. A `checkpatch` run never inflates inline violation counts. If `checkpatch` violations are consistently higher than inline violations, the file was already dirty when the session started.
