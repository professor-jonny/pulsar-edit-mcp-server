# LLM Edit Tool — Failure Modes & Solutions

LLMs fail at code editing in predictable, classifiable ways. This document catalogues the failure modes we identified through real use, the solutions we built, and the reasoning behind each. Most solutions emerged from a feedback loop: the LLM queried its own `get-edit-stats` and `failure-log.ndjson` data mid-session, identified patterns, and proposed fixes — which were then implemented and validated against the same evidence base.

## How we know what's failing — the evidence base

Two tools provide the data that drove every design decision here:

**`get-edit-stats`** — per-tool, per-failure-reason counters tracked across sessions in `edit-stats.json`. Queryable by the LLM mid-session so it can see its own failure patterns and adjust strategy. No other tool (Claude Code, Cline, Cursor) exposes this — they have aggregate post-hoc scrapers at best; the running agent never sees its own performance data.

**`session-faults.ndjson`** — every `str_replace`/`insert`/`replace-block`/`replace-function-body` failure appended as a structured JSON record with `diffVsBuffer` (char-level diff of `old_str` vs actual buffer content), `bufferPreview`, `oldStrPreview`, and the full hint context. The log is grep-queryable and browsable via **Packages → MCP Server → Show Fault Log**. Every systematic failure class that appeared 3+ times with a recognisable pattern became a candidate for automatic rescue. The log converts anecdotal failure reports into measurable signals that justify engineering cost.

## Comparison: what other tools do

Neither Claude Code nor Cline have `functionHint`, `lineNumberHint`, `dryRun`, whitespace mismatch reporting, partial match counting, fuzzy location hints, or per-failure-reason instrumentation. Claude Code has exact-match-only `str_replace` with no diagnostics; Cline's SEARCH/REPLACE blocks have the same fundamental problems — widely reported in their GitHub issues as token-eating retry loops. Cursor has no public tooling stats. The failure diagnostics and anchoring system here are novel; every feature below exists because we measured a real failure class and fixed it.

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

*`diffVsBuffer`* — char-level diff appended to every noMatch failure response when `lineNumberHint` is set, showing exactly where the bytes diverged including invisible characters. Viewable in the fault log viewer.

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

**What happens:** The LLM reads the file at turn N and gets line numbers. Edit 1 shifts everything below it. By edit 2 the line numbers in the LLM's head are wrong. Any line-number-based tool call — insert, delete-line-range, lineNumberHint — is affected. A `lineNumberHint` pointing 40+ lines off causes `diffVsBuffer` to compare completely unrelated content.

**How we know it's common:** Lifetime stats showed `lineNumberHint` used over 1300 times vs `afterHint` used 46 times and `functionHint` 42 times. The LLM reached for line numbers habitually because they're immediately available from grep output, even though content anchors would have been drift-immune. Multiple `failure-log` entries showed `lineHint pointing at wrong region` — the hint was off by 40+ lines due to prior inserts.

**Solutions:**

*Content-anchored hints* — `functionHint`, `afterHint`, `betweenHint`, `afterString`, `beforeString`, `lineContentHint`. These anchor by content rather than position; they don't drift when lines are inserted above the target.

*`lineContentHint`* — accepts a unique string on the target line rather than a line number. Content-stable, drift-immune. Added as step 4b in the `str_replace` decision ladder.

*`successNudge` lineHint upgrade suggestion* — when `str_replace` commits using only `lineNumberHint` on a file >= 100 lines, the success response appends a specific suggestion: `"Next time use afterHint:\"<content>\" instead — it's content-stable and won't drift."` The anchor string is extracted from the matched line at commit time — immediately usable, not generic advice. Trains the pattern within the session before the next failure.

*`lineNumberHint` is a search-narrowing hint, not a position anchor* — it narrows the search window to ±25 rows around the specified line. If `old_str` is found in that window, it matches normally. It does not bypass content matching. The old `lineNumberHintFallback` positional overwrite was removed in v0.10.26 after producing 218 silent wrong-region overwrites in lifetime stats.

*`afterLine` vs `afterString` reliability — measured* — lifetime hint success rates confirm what theory predicts: `afterString` is 100% (56/56) because content is stable; `afterLine` is 75% (12/16) because line numbers drift after insertions above the target. The 4 `afterLine` failures were all `afterNotFound` — the hint pointed at a region that had shifted. Rule: use `afterLine` only when paired with a second hint (e.g. `inFunction` + `afterLine`). Never use `afterLine` as the sole hint on a file that is being actively edited across multiple turns.

---

## Failure Mode 5 — Duplicate pattern confusion (silent wrong-occurrence commit)

**What happens:** The same short pattern appears multiple times in a file — error handlers, struct initialisers, `return null`, repeated boilerplate. `str_replace` hits the first occurrence which is not the intended one. The LLM doesn't notice because the match succeeds — there's no error, no warning. The wrong function gets modified.

**How we know it's common:** `ambiguous` is tracked as a distinct fail class in stats. It became trackable once the ambiguity guard existed to produce the counter — before that, wrong-occurrence commits were invisible (they showed as hits, not failures). The guard's value is precisely that it converts silent corruptions into visible blocks.

**Solutions:**

*Ambiguity guard* — before committing, `str_replace` counts all occurrences of `old_str` in the full file. If more than one match exists and no scope hint is set, the edit is **blocked** with a `⚠️ AMBIGUOUS MATCH` response listing every matching line number. The LLM must add a hint before proceeding. The same guard applies to `replace-block`, `replace-function-body`, and `delete-block`. Passing `occurrence:N` where N > 1 disables the guard — deliberate targeting of multiples.

*`occurrence:N`* — target the Nth match explicitly. When the pattern repeats and `functionHint` doesn't apply, `occurrence:3` replaces the 3rd occurrence only without widening `old_str`.

*`functionHint`, `afterHint`, `betweenHint`* — scope the search to a named function body, after an anchor string, or between two anchor strings. Reduces the candidate pool to a region where the pattern is unique.

**Why the guard belongs in the tool, not the prompt:** Prompt instructions like "always check for duplicates" are forgotten mid-conversation. Tool-enforced blocking fires unconditionally at the exact moment the mistake would have been made.

---

## Failure Mode 6 — Off-by-one on block boundaries

**What happens:** The LLM tries to replace a function or block but gets the closing brace wrong — either including the start of the next function or leaving a stray `}`. Off-by-one errors on any block that spans many lines.

**Solutions:**

*`replace-function-body`* — brace-matched replacement. The LLM names the function; the tool finds the opening `{` and matches to its closing `}` using tree-sitter (for open files) or brace counting. The LLM never needs to know which line the closing brace is on.

*`replace-block`* — same brace-matching for non-function blocks. Triggered by any anchor string rather than a function name. Finds the next `{` after the anchor and matches to its closing `}`. Covers loops, conditionals, switch cases, struct blocks.

*`delete-block`* — content-anchored delete given a start string and end string (or brace-match mode). No line numbers needed.

---

## Failure Mode 7 — Stale context on large files

**What happens:** On large files `read-file` returns so much text that by the time the LLM is generating its edit, the relevant section has scrolled out of its attention window. It generates `old_str` from reconstruction rather than the actual text — paraphrases a comment, changes a variable name slightly, drops a blank line.

**Solutions:**

*`read-lines` with content-anchored hints* — `functionHint`, `afterHint`, `betweenHint`, `centerLine`+`radius`. Brings only the relevant region into context without loading the full file.

*`get-repo-map`* — Aider-style compressed codebase index. Tree-sitter symbol extraction, PageRank-ranked by cross-file reference density, rendered within a token budget (default 1024 tokens). Called at session start to orient the LLM without consuming the context window. `mentionedFiles` boost re-centres the map around files currently being edited.

*`get-region`* — returns lines between two anchor strings. Content-stable equivalent of `read-lines` — the LLM asks for "the HAL_Init block" without knowing its line number.

*`get-file-summary`* — structural summary: functions, includes, defines, TODOs. Cheap orientation before deciding what to read in full.

---

## Failure Mode 8 — Schema/handler mismatch (hints silently dropped)

**What happens:** A hint is fully implemented in a tool's handler but not declared in `inputSchema`. The Zod validator silently drops it before the handler receives it. The LLM tries `delete-line-range functionHint:"someFunction"` and receives a result as if no hint were specified — no error, no warning, the hint simply didn't work.

**How it was found:** Systematic audit of all edit tools comparing `inputSchema` declarations against handler parameter usage. `delete-line-range` had `dryRun`, `functionHint`, `afterHint`, `lineNumberHint`, `betweenHint`, `occurrence`, and `fuzzyWhitespace` fully implemented but none declared in schema. The tool appeared functional when tested manually; the bug was invisible without the audit.

**Solution:**

*Schema audit matrix* — all edit tools verified that `hints`, `dryRun`, `fuzzyWhitespace`, `occurrence` are present in both `inputSchema` and the handler wherever intended. `ANCHOR_SCHEMA` is now a shared Zod spread applied to all tools that accept hints, so adding a new hint touches one place.

---

## Failure Mode 9 — Regex-based function matching failures

**What happens:** Function detection and anchor resolution were originally built on regex. This caused `replace-function-body` notFound on arrow-function and `registerTool` patterns the regex never matched; `functionHint` scoping finding the wrong occurrence when a name appeared as both definition and call sites; `afterHint:"fn_name"` resolving to the first character occurrence of the string rather than the end of the function — causing insert-after-function to land inside the function body.

**Solution:**

*Tree-sitter migration (v0.10.20–v0.10.21)* — `lib/tree-sitter-symbols.js` replaced all 9 regex-based function-matching sites. `afterHint:"fn_name"` now resolves to the **end** of that function (`sym.endRow`), not the first character. `betweenHint` spans function-to-function semantically. Ambiguous hints return an error with a list of matches rather than silently picking the first. All tools (`list-functions`, `read-lines`, `str_replace`, `replace-function-body`, `get-repo-map`, etc.) share the same backend — consistent results everywhere.

---

## Failure Mode 10 — Post-edit structural damage (silent cascading errors)

**What happens:** An edit introduces an unclosed `{`, an unclosed `/* block comment`, or an unmatched `#if`. The linter and compiler don't fire immediately. The next edit fails on a corrupted baseline with a confusing error that has nothing to do with what it tried to change.

**Solution:**

*Post-edit structural integrity check (`lib/struct-check.js`)* — delta snapshot before and after every edit on `.c .h .js .ts` and other brace-delimited files. Three metrics: net brace balance, unclosed block comments, `#if`/`#endif` depth. Delta-only — pre-existing imbalances are silently ignored; only damage introduced by *this edit* is reported. Warning appended to the success response as `⚠️ struct: unmatched opening brace (net +1 { })`.

*`check-struct` tool* — on-demand absolute snapshot for session-start baseline assessment.

---

## Failure Mode 11 — Patches are structurally wrong for LLM use

**What happens:** Unified diff format requires the LLM to know correct line numbers at generation time, which it cannot do reliably. Even with context lines and fuzz factor, the LLM's mental model of line positions diverges from reality during multi-edit sessions. Failure rate is structural, not fixable with better tooling.

**Evidence:** `apply_patch` lifetime stats: 0 hits across 40+ calls. Every attempt eventually fell back to `str_replace` or `replace-function-body`.

**Solution:** `apply-patch` is best kept for human-provided patches or cases where the LLM is applying a diff received from an external source (a `git diff`), not generating one itself. The content-anchored tools (`str_replace` with hints, `replace-function-body`, `replace-block`) cover all the same use cases without the line-number dependency.

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

*`session-notes`* — persistent store the LLM writes to and reads from across sessions. At session start the LLM reads what it wrote last time and adjusts immediately — which hints worked on this codebase, which files hot-reload on save, what caused retries. Combined with `get-repo-map` at session start, the LLM arrives knowing both the code layout and accumulated codebase-specific lessons. Improves automatically with use; no user maintenance.

---

## Failure Mode 14 — Wrong file active (contentFaults)

**What happens:** The LLM issues a `str_replace` while a different file is the active editor. The edit targets `mcp-registration.js` but the active tab is `tool-catalogue.js`. The search runs on the wrong buffer, finds nothing, and returns `noMatch` — or worse, if the pattern happens to exist in both files, it commits to the wrong one silently.

**How we know it's common:** Lifetime stats introduced a `faultBuckets` field to classify `str_replace` faults: `contentFaults` (old_str genuinely absent from the buffer — wrong file or stale content) vs `hintFaults` (hint resolution failed — drift, typo in anchor). Analysing the `failure-log.ndjson` cluster showed the `contentFaults` group was dominated by sessions where the LLM had switched between files without tracking which was active. The pattern was recognisable: correct `old_str` content, zero whitespace or encoding issues, but wrong file path in the blame.

**Solutions:**

*`filePath` parameter on all edit tools* — since v0.14.x every edit tool (`str_replace`, `insert`, `delete-line-range`, `replace-function-body`, `replace-block`, `apply-patch`, `sed`, `replace-document`) accepts `filePath`. The framework opens the file in a background tab if it's not already open. The active tab is never used for writes. Passing `filePath` on every edit call eliminates the entire `contentFault` failure class — the edit can never land on the wrong buffer regardless of what the user or prior tool calls have made active.

*Rule: always pass `filePath` on edit calls to source files.* Read tools (get-region, read-lines, grep-file) can omit it when the intent is to operate on the active editor; edit tools should not rely on that assumption.

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

**What happens:** When a hint resolution fails — `afterString` not found, `inFunction` not found or ambiguous, `betweenHint` start/end not found — the tool returns an error and bumps the relevant stats counter (`fails.afterNotFound`, `fails.outOfScope`). But the early-return path never called `logFailure`, so nothing was written to `session-faults.ndjson`. The fault log only ever received content failures (`noMatch`, `whitespace`, `partialMatch`). The 28+ `afterNotFound` hint faults visible in lifetime stats had zero corresponding fault log entries — the actual hint strings, file paths, and `old_str` context were completely uninspectable.

**How we know it's common:** Reviewing the fault log after a session with known `afterNotFound` faults showed only `noMatch` entries. Cross-referencing with `get-edit-stats` confirmed the count discrepancy: 28 `afterNotFound` faults in stats, 0 hint-related entries in the log. The gap was structural — the early-return pattern for all hint failures bypassed `logFailure`.

**Solution:**

*`logHintFailure()` helper (v0.15.1)* — module-level function wrapping `logFailure` with a structured `reason` field: `"hintFault:<hintName>:<variant>"`. Variant is one of `notFound`, `ambiguous`, or `needsTreeSitter`. Also records `hintValue` (the failing anchor string, truncated to 80 chars) and `oldStrPreview`. Wired at all 12 hint failure early-return sites in `str_replace` and all 8 in `insert`. The `sectionHint`/`preprocBlock` path in `insert` already called `logFailure` and was left untouched.

The fault log `reason` field now takes one of two forms:
- **Content failures:** `noMatch` / `whitespace` / `partialMatch` / `encoding` — hint resolved, `old_str` didn't match
- **Hint failures:** `hintFault:<hintName>:<variant>` — anchor resolution failed before the search even ran

Both are queryable via `get-failure-log` with `reason` filter (e.g. `reason:"hintFault"` shows only anchor failures). The fault log viewer's Reason column displays both classes directly.

---

## The auto-retry pipeline

The most common `str_replace` failure causes now fire automatically before returning a failure, requiring no explicit flags. Each was opt-in originally; after lifetime stats showed them accounting for the vast majority of `noMatch` failures, automatic rescue became the safer choice.

```
P1  exact match           — indexOf in search window
P2  fuzzyWhitespace       — trim-per-line (auto if not explicit)
P3  fuzzyContent          — Unicode→ASCII normalisation (auto if not explicit)
P4  autoStripComment      — strip trailing comment from old_str last line (auto)
P4a autoPartialMatch      — when old_str is a prefix of a longer buffer line, commit the partial match (auto; tagged [autoPartialMatch])
P5  regex:true            — treat old_str as /gm RegExp [explicit only]
→ FAIL: diffVsBuffer char diff + Levenshtein similarity% + smartSuggestion + scanForOldStr scope check + session-faults.ndjson
```

Tags in the response (`[autoFuzzyWhitespace]`, `[autoFuzzyContent]`, `[autoStripComment]`) show which rescue path fired so the LLM can supply the flag explicitly next time.

---

## Smart failure suggestions

**On failure #1:** `smartSuggestion()` fires immediately — not after 3 attempts. It analyses why: no hints used → lists the specific hints with concrete syntax; `old_str` looks like a whole function → suggests `replace-function-body`; `old_str` looks like a brace block → suggests `replace-block`; large file + no hints → adds urgency text.

**On success with no hints:** `successNudge()` is appended to `str_replace` success responses when no hints were used on a file >300 lines. It tells the LLM which hints to use next time and, if `old_str` looks like a function, explicitly suggests `replace-function-body` instead. Closes the feedback loop before failures start.

**Levenshtein similarity %:** When `old_str` has >= 2 lines and a closest-area is found, a similarity percentage is appended: `"📊 Similarity: 87% — likely whitespace drift, try fuzzyWhitespace:true"`. Three bands: >=80% (whitespace/encoding, use a fuzzy flag), 50–79% (stale content, re-read), <50% (wrong location, use a scoping hint). Calibrated from lifetime stats clusters.

**Nearest-symbol suggestion on anchor failures:** When `afterHint`/`betweenHint` anchor resolution fails and the hint looks like a symbol name, the full symbols array is scanned for the best Levenshtein match >= 60%. If found: `"💡 Nearest symbol: hal_wifi_scan (87% match)"`. Turns a dead-end anchor failure into a one-step correction.

---

## Stats and instrumentation — what no other tool has

**Per-tool, per-reason breakdown at the point of failure.** Other tools know something failed; they don't know why. The distinction between `whitespace`, `partialMatch`, `ambiguous`, `noMatch`, and `outOfScope` is what makes the data actionable for development.

**Queryable mid-session by the LLM.** `get-edit-stats` returns the current session totals. The LLM can call this when failures cluster, see `"str_replace whitespace:8"`, and switch to `fuzzyWhitespace:true` for the rest of the session on that file — without waiting for session end.

**Lifetime persistence.** `get-edit-stats({ reset: true })` flushes session counters into `edit-stats.json`, increments session count, and zeroes session counters. The lifetime block accumulates across all sessions and survives server restarts.

**Failure log viewer.** **Packages → MCP Server → Show Fault Log** opens an interactive modal: newest-first table, live filter by tool/reason/file, click any row for a detail view with `bufferPreview` (green), `diffVsBuffer` (red), `oldStrPreview` (amber) rendered as coloured code blocks. The Reason column now distinguishes two failure classes: content failures (`noMatch`, `whitespace`, `partialMatch`) and hint failures (`hintFault:afterString:notFound`, `hintFault:inFunction:ambiguous`, etc.) — previously all hint failures were invisible in the log; they only appeared as raw counters in `get-edit-stats`.

**Hint performance tracking.** `get-edit-stats` now reports `hintsSucceeded` and `hintsFailed` per hint name, plus `hintSuccessRate` (only for hints with at least one use). This surfaces the exact pattern confirmed by lifetime data: `afterString` 100%, `inFunction` 100%, `afterLine` 75%. `faultBuckets` splits faults into `contentFaults` (old_str absent — wrong file or stale content) and `hintFaults` (hint resolution failed — drift, bad anchor). `fuzzyTriggerReasons` tracks why auto-rescue fired: `needsWhitespace`, `needsContent`, `needsComment`, `partial`. Together these let the LLM diagnose a fault class in one `get-edit-stats` call rather than reading the full failure log.

**Per-session history.** `get-edit-stats` returns `recentSessions` — the last 5 session summaries from `session-history.ndjson`, each with timestamp, edit count, hit rate, and fault count. Trend visible without reading the full lifetime block.

**Style stats isolated from edit stats.** `checkpatchRuns` and `checkpatchViolations` are separate fields from `editsChecked` and `totalViolations`. A `checkpatch` run never inflates inline violation counts. If `checkpatch` violations are consistently higher than inline violations, the file was already dirty when the session started.
