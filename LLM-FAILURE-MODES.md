# LLM Edit Tool: Failure Modes and Solutions

LLMs fail at code editing in predictable, classifiable ways. This server exists to turn each recurring failure into one of three outcomes: an automatic fix, a refusal before any damage is done, or a precise diagnosis the model can act on in one step. Every feature described here answers a failure that was measured, not guessed at.

About the numbers: figures below are lifetime counters from `get-edit-stats` (four recorded sessions) and records from the fault log. The counters double-counted until a fix on 2026-09-24 and the stored totals were not corrected, so raw totals may be up to about 2x high; ratios are unaffected. The totals also include calls made while testing the tools themselves. Treat them as indicative.

---

## What makes this server different

**1. The model can read its own failure data.** `get-edit-stats` returns per-tool, per-reason counters and per-hint success rates; `get-failure-log` returns structured records of every failed edit. The agent can see that whitespace failures are clustering and change strategy mid-session. In the three open-source edit tools whose source was read (Cline, Aider, opencode), none lets the running agent see its own edit statistics: Cline sends two failure types to remote telemetry and never to the model, Aider increments a counter that nothing reads, and opencode records nothing. Claude Code and Cursor are closed source and are not claimed about.

**2. Edits are located by content, not by position.** `inFunction`, `afterString`/`beforeString`, `afterFunction`/`beforeFunction`, `afterSymbol`/`beforeSymbol`, `betweenHint`, `banner`, `ifdefBlock` and `occurrence` scope an edit to where it belongs and do not drift when lines are inserted above. The three tools compared take no location parameters beyond a path and the text itself. Even the positional hints (`afterLine`/`beforeLine`) are only search windows: the text must still match inside the window, so drift produces a refusal, not a wrong edit.

**3. It refuses instead of guessing.** Refusals that leave the file untouched: an ambiguous match, a match only inside a longer identifier, an exact match found outside the narrowed scope, a match far larger than `old_str`, a trailing-comment mismatch, a regex passed to an edit tool, and a destructive shell command the model tries to approve for itself. The ambiguity guard alone refused 117 `str_replace` calls, 38 `delete` anchors and 12 `replace` calls; each would otherwise have edited the first occurrence silently.

**4. Preview is a model-callable feature.** Edit tools take `dryRun:true` (253 uses on `str_replace`, 234 on `replace`, 114 on `insert`, 93 on `sed`); `apply-patch` previews by default; `replace-across-files` previews before it commits.

**5. Failures name their cause.** The failure text says which of these applies: whitespace mismatch, partial match, comment mismatch, found outside scope, found elsewhere (differs only in whitespace), `old_str` starts or ends mid-line, missing file on disk, wrong regex dialect. Each is a distinct failure class with its own counter, so retries address the real problem. A failed call is stashed, so the model can retry by resending only the corrected `old_str` instead of the whole call.

**6. Every edit is checked afterwards.** A structural check (brace balance, unclosed block comments, `#if`/`#endif` depth) reports damage introduced by this edit only; a style check runs on C files; linter diagnostics are available with `lint:true`. The commit step re-verifies the exact text at the match position in the live buffer before writing.

### Comparison with other tools

Read from their source (Cline, Aider, opencode) in September 2026 and not re-run since. "Not seen" means the edit-tool files were searched and nothing was found.

| Capability | Cline | Aider | opencode | This server |
|---|---|---|---|---|
| Fuzzy matching when exact fails | 3 tiers: exact, line-trimmed, first/last-line anchor | Leading-whitespace rescue plus a `...` elision handler; the whole-block similarity matcher is unreachable (`replace_most_similar_chunk` returns before calling it) | 9 tiers, including Levenshtein similarity >= 0.65 | Whitespace and Unicode rescue in one pass, within scope only; never rescues out-of-scope or comment differences, it explains them |
| Failure tells the model where the closest match is | No: returns the whole original file plus generic advice | Yes: best-matching chunk as a "Did you mean" block | No: three fixed error strings | Yes: closest area, similarity %, per-line comparison, and where the text exists if it is elsewhere |
| Model can request a dry run | No | No | No | Yes (`dryRun`) |
| Refuses an ambiguous match | Not seen | Not seen | Yes | Yes |
| Refuses a match far larger than `old_str` | Not seen | Not seen | Yes | Yes (`lib/recover.js`) |
| Lint or diagnostics after the edit | Yes, new errors only | Separate lint step | Yes, LSP errors appended | Structure check always, style check on C, linter on request |
| Location-scoping parameters | None | None | None | Ten or more content and position hints |
| Per-failure-reason counters visible to the model | Two types, to remote telemetry only | One counter, never read | None | Yes |
| Persistent structured fault log | Not seen | Not seen | Not seen | Yes |

What is genuinely different here: content-anchored location hints, a model-callable `dryRun`, the running agent reading its own per-reason statistics, and a fault log. The other behaviours (fuzzy matching, closest-match diagnostics, ambiguity refusal, post-edit diagnostics) exist in at least one of the three. Cline's failure mode is widely reported (GitHub issues #1195, #2909, #3183 and #4384 describe token-eating retry loops), consistent with it having the weakest failure diagnostics of the three.

---

## The evidence base

**`get-edit-stats`** counts, per tool and per failure reason, hits, fails, dry runs, hint usage and per-hint success. Session counters reset on request; lifetime counters persist in `session/session-stats.json`. `bump()` only increments a key that already exists in the schema, so a counter reading zero for a failure you saw means suspect a missing key before suspecting the tool.

**`session-faults.ndjson`** records every edit failure, readable with `get-failure-log` (filter by tool, reason or file) and browsable in **MCP: Show Fault Log...**. Each record carries:

- `reason`: a content reason (`noMatch`, `whitespace`, `partialMatch`, `encoding`, `comment`) or a hint reason in the form `hintFault:<hint>:<variant>` where the variant is `notFound`, `ambiguous` or `needsTreeSitter`.
- `hintsSet`: every active hint, not only the one that failed.
- `oldStrPreview`, `bufferPreview` (raw buffer lines around the closest match) and `proposedNewStr`.
- `diffVsBuffer`: a line diff of `old_str` against the closest buffer area, for content failures. Hint-resolution failures record `null` there because no buffer comparison took place.

The log turns anecdotes into signals: a failure class that appears three or more times with a recognisable pattern becomes a candidate for automatic rescue, a refusal or a better message. Before hint failures were logged, counters showed dozens of `afterNotFound` faults with no log entries, so the anchor strings that failed could not be inspected.

---

## Failure modes

### A. Matching the text

#### 1. Whitespace and indentation mismatch

**What happens:** The model regenerates `old_str` from memory and normalises indentation: tabs become spaces, 4-space becomes 2-space, trailing spaces vanish. The content is right and the match fails.

**Evidence:** On `str_replace`, 413 of the 517 automatic-rescue triggers were whitespace (about 80%; the rest were 98 partial, 4 comment, 2 content). 689 commits went through the whitespace rescue, against 50 whitespace failures that reached the model.

**Solutions:**
- `fuzzyWhitespace:true` matches trimmed-per-line content and commits using the buffer's own indentation; the model's whitespace is never written.
- Automatic rescue on any no-match: one combined diagnosis, one retry, tagged `[autoFuzzyWhitespace]`. Two candidates in the window means refusal, never first-hit.
- `delete` runs with `autoRescue:false` because it is destructive, so its anchors must match exactly. If a `delete` anchor fails while the text is visibly in the file, that is why.
- A failed match shows the search line against the buffer line, so the divergence is visible without another read.

#### 2. Unicode character substitution

**What happens:** `old_str` contains smart quotes, em or en dashes, non-breaking or zero-width spaces, or arrows where the buffer has the ASCII form (or the reverse). The two look identical but differ at the byte level, and indentation diagnostics do not fire.

**Evidence:** The fault log exposed a recurring cluster of `old_str` with `->` against a buffer holding U+2192. In the counters it is rare: 9 `fuzzyContent` commits and no `encoding`-class failures on `str_replace`.

| The model writes | Instead of | Unicode |
|---|---|---|
| Smart quotes | Straight quotes | U+201C, U+201D |
| Smart apostrophe | `'` | U+2019 |
| Em dash | `-` or `--` | U+2014 |
| En dash | `-` | U+2013 |
| Arrows | `->` `<-` | U+2190 to U+21FF |
| Non-breaking space | Space | U+00A0 |
| Zero-width space | Nothing | U+200B |
| Box-drawing runs | Dashes | U+2500 to U+257F |

**Solutions:**
- `fuzzyContent:true` normalises both `old_str` and the buffer region for comparison only; the replacement is committed against the original buffer text, so encoding is preserved. It fires automatically after the whitespace rescue, tagged `[autoFuzzyContent]`.
- When a matched pair differs only by non-ASCII characters, the failure is classified `encoding` instead of `whitespace`. Non-breaking and zero-width spaces can still look identical in the per-line output, so rely on the classification.
- `get-repo-map` flags files containing non-ASCII with `[unicode]`, so the model knows before the first edit fails.
- When the ambiguous character cannot be identified, anchor on an ASCII-only part of the line and use `replace` with `fragment:true`, or use `sed` for a pattern edit.

#### 3. Hallucinated trailing comments

**What happens:** `old_str` ends with a `/* verified */` or `// note` that is not in the buffer, hallucinated or carried from another version. The code is right; the extra comment breaks the match.

**Evidence:** A distinct cluster in the fault log, for example `int hal_wifi_disconnect(void) /* verified */` against a buffer line with no comment. Rare in the counters (4 rescue triggers; 4 `replace` and 3 `delete` comment-class failures).

**Solution:** The shared engine does not strip and commit. It fails with a COMMENT MISMATCH section naming the lines (extra, missing or different comments, on any needle line) and saying what each should read. The model fixes the comment and retries. Silently stripping hid the discrepancy from the model, which is why the engine refuses. The retired `str_replace` keeps its own inline strip and appends `/* CHECK: <comment> */` to the replacement; `get-repo-map` flags `[trailing-comments xN]` and `[check-me xN]` so leftover markers can be reviewed.

#### 4. A whole-line edit is given a mid-line `old_str`

**What happens:** `replace` without `fragment:true` matches whole lines only. The model passes text that starts or ends mid-line (a call name, one argument, the tail of a statement). The text is in the file but the match fails, and a generic diagnosis blamed a typo, whitespace or Unicode, so the model retyped and failed again.

**Evidence:** Live failures. `replace` with `fragment:true` has 359 commits and 68 failures.

**Solutions:**
- The failure names the real cause and offers two fixes: resend the whole call with `fragment:true`, or extend `old_str` to whole lines. The typo, whitespace and Unicode lines are not printed for this case.
- `delete` (`matchString`, `startContent`, `endContent`) and `insert` (`afterContent`, `beforeContent`) give the same kind of message using the caller's own parameter name.
- The bare retry (resending just `{ filePath, old_str }`) is not offered after a mid-line failure. Extending `old_str` to the whole line and merging the stashed partial `new_str` would have replaced the whole line with a fragment and dropped the indent and semicolon.
- `fragment:true` refuses a hit glued to a longer identifier (`count` inside `discount`) unless `guardIdentifier:false`.

#### 5. Regex written for the wrong engine

**What happens:** LLMs write JavaScript-style regex. Edit tools no longer accept regex, and the search tools use POSIX dialects, so such a pattern usually finds nothing, silently. In a basic regex a bare `| + ? ( ) { }` is literal text, `\d` matches the letter d, `*?` is greedy, and alternation is leftmost-longest.

**Solutions:**
- `regex:true` on `replace`, `str_replace`, `replace-all`, `replace-across-files`, `delete`, `insert`, `replace-block`, `replace-function-body` and `read` is refused with nothing changed. `replace-all` and `replace-across-files` always match literally. The central refusal (`lib/regex-guard.js`) runs first in the tool wrapper, before any handler, dry run or retry stash. The parameter stays in the schemas so its value reaches the guard; if it were removed, the schema validator would strip it silently and the pattern would be matched as a literal.
- `sed` runs real GNU sed 4.9 scripts and reports sed's own error text; its dry run lists the lines it would remove and add.
- `regex:true` on `grep-file`, `grep-project`, `find-text` and `search-functions` is POSIX: basic by default, extended with `extended:true`. A zero-match regex search that uses a bare operator without `extended:true`, a backslash-d or a lazy quantifier gets a note explaining the dialect. Matching is checked against real GNU grep (`test/grep-oracle/`) and golden cases for sed.

---

### B. Finding the place

#### 6. Line-number drift

**What happens:** The model reads a file at turn N. Edit 1 shifts everything below it, and by edit 2 the remembered line numbers are wrong. `afterLine`/`beforeLine` on edit tools and `startLine`/`endLine` on `delete` (marked legacy and a last resort) are affected.

**Evidence:** Models reach for line numbers because grep output supplies them. On `str_replace`, `afterString` succeeded 94% of the time (448 of 479) and `afterLine` 91% (166 of 183); on `replace` the figures are 86% and 81%. The gap is small in aggregate, but line hints remain drift-prone in principle and are worth pairing with a content anchor on a file under active edit.

**Solutions:**
- Content anchors (`afterString`, `beforeString`, `inFunction`, `afterFunction`, `betweenHint` and the rest) do not drift.
- `afterLine:N` searches N to N+25 and `beforeLine:N` searches N-25 to N (`HINT_RADIUS` = 25; `hintRadius` overrides it). It is a search window, not a position: the text must still be found in the window, so a drifted hint ends in a refusal, never an overwrite of the wrong region. A failing line hint is logged as `hintFault:afterLine:contentMiss` with a `bufferPreview` of the wrong region.
- `successNudge()` coaches the model during a session: after a positional-only hint on a file of 100 or more lines it says the hint is positional and suggests a ready-made `afterString` extracted from the matched line; after an edit with no hint at all on a file of 300 or more lines it reminds the model of the hints.

#### 7. Duplicate pattern confusion (silent wrong-occurrence commit)

**What happens:** The same short pattern appears several times (error handlers, struct initialisers, `return null`). The edit hits the first occurrence, which is not the intended one. The match succeeds, so no error and no warning appears.

**Evidence:** `ambiguous` is a tracked failure class: 117 on `str_replace`, 38 `anchorAmbiguous` on `delete`, 12 on `replace`. Before the guard existed these were not failures at all; they were silent hits on the wrong code.

**Solutions:**
- Ambiguity guard: with more than one match and no scope hint, the edit is blocked with the matching line numbers listed. It applies to `replace`, `replace-block`, `replace-function-body` and the anchor modes of `delete`.
- `occurrence:N` targets the Nth match explicitly. An N beyond the number of matches is refused, never clamped; an explicit `occurrence:1` is treated as an explicit choice; automatic rescue does not guess when N is above 1.
- `inFunction`, `afterString` and `betweenHint` shrink the candidate pool to a region where the pattern is unique.
- The guard lives in the tool, not the prompt: instructions such as "check for duplicates" are forgotten mid-conversation, while a tool-enforced block fires at the exact moment of the mistake.

#### 8. `old_str` exists, but outside the intended scope

**What happens:** The model scopes an edit with `inFunction` or `betweenHint`, but the text lives in a different function. The scoped search fails, and without more information the model widens or drops the scope and edits the wrong place, or retries blind.

**Evidence:** `foundOutsideScope` is its own counter (19 on `str_replace`, 10 on `replace`, 6 on `delete`, 4 on `insert`), added because these were indistinguishable from genuine content mismatches.

**Solution:** The engine never commits an exact match found outside a narrowed scope. It refuses with FOUND OUTSIDE SCOPE, listing up to five hit locations with line numbers and nearest function context. Text that exists elsewhere differing only in whitespace gets FOUND ELSEWHERE with the lines and the whitespace differences. The failure does not offer the "resend just `old_str`" shortcut, because the text is right and it is the scope hint that needs changing.

#### 9. Function ranges and symbol detection

**What happens:** Function-name scoping is only as good as the symbol table behind it. Regex-based detection missed arrow functions and `registerTool` patterns, found the wrong occurrence when a name was both definition and call site, and resolved an "insert after this function" anchor to the first character occurrence of the name instead of the end of the function.

**Solution:** `lib/tree-sitter-symbols.js` is the single backend for `list-functions`, `read`, the edit tools and `get-repo-map`. `afterFunction:"fn"` resolves to the end of that function; `betweenHint` spans function to function; an ambiguous name returns a list of matches rather than the first. Range bugs fixed along the way, any of which collapses `inFunction`/`afterFunction`/`beforeFunction` to the signature line: destructured parameters (`function f({ a, b }) {`), braces inside comments, strings, template and regex literals (masked before counting by `makeLineMasker()`), and one-letter function names. If `inFunction` resolves to a single line, suspect the range, not the anchor.

**Reliability (open):** `inFunction` is the weakest hint. On `str_replace` it succeeded 38 of 77 times (49%); on `replace`, the default edit tool, 11 of 27 (41%). `afterFunction` succeeded 8 of 8. The fault log shows failures clustering by file type: C++ methods in the Ghidra decompiler `.cc` files (written as `Class::method` or the bare name) and names that are not plainly declared functions (tool names in `mcp-registration.js`, handlers). The regex fallback cannot see out-of-class C++ definitions such as `void PrintC::opCopy(...)` (`C_FN_RE` cannot span `::`) and returns no symbols for extensions that are not C-like or JS-like. Until fixed, prefer `afterString` on C++ files and for anything that is not a plainly declared function, and check the failure reason when `inFunction` fails.

#### 10. Off-by-one on block boundaries

**What happens:** The model replaces a function or block but includes the start of the next function or leaves a stray `}`.

**Evidence:** The brace-matched tools still fail more than the match-based ones: `replace-function-body` 12 hits and 25 failures (11 not found, 11 ambiguous), `replace-block` 11 hits and 19 failures (15 anchor not found, 4 brace-match failures). Most of these are anchor or ambiguity refusals, not wrong writes.

**Solutions:**
- `replace-function-body`: the model supplies the new function; the tool finds the function by the name in the signature line and matches braces (tree-sitter on open files, brace counting otherwise), so the model never needs the closing-brace line.
- `replace-block`: the same brace matching for non-function blocks, triggered by an anchor string; covers loops, conditionals, switch cases and struct blocks.
- `delete` anchor modes: `inFunction` deletes a whole function including its signature; `startContent` plus `endContent` deletes between two anchor lines (`inclusive:false` keeps the anchors); `matchString` deletes one exact block. There is no brace-match parameter; anchor a non-function block with `startContent` and `endContent`. The raw `startLine`/`endLine` mode is a last resort and should be paired with `expectedContent`.

#### 11. Wrong file active, or wrong or missing path

**What happens:** The edit runs against the wrong buffer (a different tab is active) or against a path that does not exist, which gives an empty buffer. Every failure then blames the anchor ("afterString not found"), and the model changes a perfectly good anchor.

**Evidence:** Stats split faults into `contentFaults` (text genuinely absent: wrong file or stale content) and `hintFaults` (anchor resolution failed). The `contentFaults` group was dominated by sessions where the model had switched files without tracking which was active.

**Solutions:**
- `filePath` is required on the edit tools and `read`. The file is opened in a background tab if needed; the active tab is never used for writes, so the whole wrong-buffer class cannot occur.
- A failing edit on a path that is missing on disk with an empty buffer ends with "The file does not exist on disk ... probably caused by a wrong path". Successes and dry-run previews are untouched, and an edit that succeeds on a missing path still creates the file.
- **MCP: Show Last Edited File** reveals which file was actually committed last. `pulsar-edit-mcp-server.focusEditedFile` (default true; **MCP: Toggle Focus Edited File**) brings the edited tab to focus.

---

### C. Context and state

#### 12. Stale context on large files

**What happens:** On large files `read-file` returns so much text that by the time the edit is generated, the relevant section has left the model's attention. It reconstructs `old_str` instead of copying it, paraphrasing a comment, renaming a variable slightly or dropping a blank line.

**Evidence:** `read` is the most used and most reliable tool in the set: 2,691 hits at 99% success.

**Solutions:**
- `read` returns only the relevant region using the same anchors as the edit tools: `inFunction`, `afterString`/`beforeString`, `betweenHint` or `startContent`+`endContent`, `banner`, `ifdefBlock`, or `nearLine`/`centerLine` with `radius` (default 10). Ambiguous anchors are refused with the candidate lines listed.
- `get-repo-map`: a compressed codebase index (tree-sitter symbols, ranked by cross-file references, within a token budget, default 1024) for orientation without spending the context window; `mentionedFiles` re-centres it on the files being edited.
- `get-file-summary`: functions, includes, defines and TODOs for cheap orientation.

#### 13. No cross-session memory

**What happens:** Each session starts with no knowledge of what caused retries last time ("this file uses tabs", "that file hot-reloads on save"), so the same mistakes recur.

**Solution:** `session-notes` is a persistent store the model reads at session start and writes before it ends, one file per project folder (`session/notes/<folder name>.ndjson`). `read` with no `project` returns the current project's notes plus a one-line index of the others; `project:"all"` reads everything; `tail:N` limits each project. `edit`, `delete` and `clear` need an explicit project; `write` refuses a project name that is neither an open folder nor an existing file; indices are per project.

**It needs curation.** One project's notes grew to 45 records and roughly 190 KB, too large to read in one call, and accumulated status claims that later turned out wrong, which later sessions inherited (see Failure Mode 14). What keeps it useful: one "current state, start here" note updated in place instead of parallel lists; evidence (file, line, command) recorded for anything marked confirmed; `tail:N` instead of reading everything; a dated backup before deleting; deleting the highest index first because later indices shift down; and periodic review of older notes against the code.

#### 14. Diagnosis errors

**What happens:** Three reasoning failures cost the most time when debugging the tool itself:
1. *Concluding "X is never called" from a search of one file.* A grep for `.save()` in one file found none in a handler and "no auto-save" was recorded as a confirmed bug. The save lives in `buildEditResponse()`, in another module.
2. *Picking one view as ground truth.* A raw disk read was trusted over the buffer, and two internally consistent pictures were reconciled for a long time instead of asking which layer each one observed.
3. *Inheriting status claims from notes and docs.* Notes said "Section 2 not wired" and "that error is benign" while the code said otherwise.

**Solutions:**
- Before concluding absence, trace the call path to the terminal effect, including helpers the handler passes data into.
- Verify status against the code. For "is it wired", grep the `require` and the call site. Record evidence with anything marked confirmed.
- Say which layer each read observes: buffer-first tools and raw disk reads can both be correct and still disagree. Call `save-all` before trusting an external read.
- Correct wrong notes with a superseding "current state" note, then delete the wrong ones.

#### 15. The client holds a session the server no longer knows

**What happens:** MCP sessions live in memory, so every Pulsar restart or reload forgets them. A request carrying the old `mcp-session-id` used to get `400 Bad Request`, which the client read as a plain error, not as a cue to re-initialize, so the client itself had to be restarted. Nothing was logged on the Pulsar side.

**Solution:** An unknown session ID now gets `404` with JSON-RPC error `-32001` "Session not found" (plain text for GET and DELETE), telling the client to drop the session and re-initialize, and one line is written to the Pulsar console. A missing header still gets `400`. Sessions are deliberately not kept across a reload, because a kept session would keep the old tool handlers and the client would not receive the new tool list. Expect the first one or two calls after a reload to fail with a connector error; retry before diagnosing the tool.

---

### D. Silent damage

#### 16. Post-edit structural damage

**What happens:** An edit introduces an unclosed `{`, an unclosed `/* comment` or an unmatched `#if`. Neither linter nor compiler fires immediately; the next edit then fails against a corrupted baseline with an error unrelated to what it changed.

**Solutions:**
- `lib/struct-check.js` takes a before and after snapshot on every edit to brace-delimited files (`.c`, `.h`, `.js`, `.ts` and similar) and compares three metrics: net brace balance, unclosed block comments, `#if`/`#endif` depth. Delta only: pre-existing imbalances are ignored and only damage introduced by this edit is reported, as `struct: unmatched opening brace (net +1 { })` on the success response.
- `check-struct` gives an absolute snapshot for a baseline at session start.

#### 17. Kernel C style violations

**What happens:** LLMs trained on mixed code produce valid C that breaks Linux kernel style in consistent ways: single-line `if` bodies (`if (!g_hal) return -1;`), and Doxygen `@file`/`@brief` tags instead of plain comments. Neither is caught by the compiler or linter.

**Solutions:** Every edit to `.c`/`.h` runs the kernel style checker against the added or changed lines only, appending any violations to the success response, so the model sees exactly what it introduced. `checkpatch` audits a whole file on demand, grouped by rule and sorted by frequency. The `singleline_if` rule (`if`, `else`, `for` or `while` followed by a non-brace statement on the same line) is severity CHECK, not a block, because a few kernel subsystems allow it in macro contexts.

#### 18. An exception between the buffer edit and the save

**What happens:** A tool mutates the buffer, then later bookkeeping (decorate, nudge, lint, style, response building) throws before the call that saves. The edit is in the buffer but not on disk. Buffer-first read tools agree with the buffer; an external read shows stale disk. The error is about something unrelated, and because the edit visibly landed it is easy to dismiss as benign.

**How it showed up:** `str_replace` read an undeclared variable after `setTextInRange` and before `buildEditResponse()` (which saves), so every committed edit stayed unsaved. Two wrong diagnoses came first: "the tool has no auto-save" and "the error is benign". The same shape appeared in `replace-across-files`, which edited buffers with `setTextViaDiff` and never saved; it now commits through `applyAndSave` (`lib/raf-commit.js`), and a failed save lists the file in `skipped` as "edited in the buffer but not saved".

**Solutions:**
- Treat any error that follows a real content edit as a bug. Confirm with `get-active-editor-info` (`modified:true` means unsaved), then find why the save was not reached rather than adding a second save.
- Say which layer each read observes (see Failure Mode 14).

#### 19. A refactor drops a declaration that static checks cannot see

**What happens:** Replacing a hand-rolled block with a delegating call deletes a `const` that code further down still reads. `node --check` passes (an undeclared identifier is a runtime error, not a syntax error), diagnostics report nothing, the extracted module's tests pass because they never load the handler, and dry-run verification passes because a dry run returns before the commit path. The same family reassigned a `const` and crashed `str_replace` on every file.

**Solutions:**
- After any rewire, grep every identifier the deleted block declared for remaining uses.
- A dry run is not verification of the commit path. Run at least one real commit through each path (scoped and unscoped) on a scratch fixture and read the disk back.
- A handler-level smoke test that drives a real commit against a fake buffer would let the standing suite exercise code the module tests skip.

#### 20. A defaulted parameter is treated as an explicit one

**What happens:** A wrapper passes a caller-level default (`occurrence = 1`) to an engine that treats any non-null value as an explicit disambiguation choice. The ambiguity refusal never fires: two functions named `beta` resolve silently to the first. This is Failure Mode 7 reintroduced by the delegation layer.

**Solutions:**
- Forward `occurrence` only when it is explicitly greater than 1. Null and 1 are different values at an interface even when the caller treats them as the same.
- Every delegation that passes a defaulted parameter needs a duplicate-name fixture test; if the tool does not refuse the ambiguous case, the guard is off.

#### 21. Dry run and commit disagree about what matched

**What happens:** The dry run reports a match but the real call fails with `commit-time verification failed ... No write was made`. The match stage normalises certain characters (apostrophes, smart quotes, dashes, double-encoded mojibake); the commit re-verifies the exact text in the live buffer and refuses. The guard works as designed, but the model has no signal that its `old_str` only matched after normalisation.

**Solutions:**
- Anchor on an ASCII-only substring and use `replace` with `fragment:true` so the ambiguous character is not in `old_str`.
- Treat a dry run as necessary but not sufficient for files known to contain non-ASCII text (`get-repo-map` marks them `[unicode]`).
- In files that already contain mojibake, write new text in plain ASCII and edit only through the Pulsar tools, never by re-saving through `Set-Content` or `Out-File`, which can compound the damage.

---

### E. Tool design

#### 22. Schema and handler disagree (hints silently dropped)

**What happens:** A hint is fully implemented in a handler but not declared in `inputSchema`. The schema validator strips it before the handler sees it, so the call behaves as if the hint were absent, with no error and no warning.

**Solution:** `ANCHOR_SCHEMA` is a shared schema spread into every tool that accepts hints, so a new hint is added in one place. `STRUCTURAL_ANCHOR_SCHEMA` carries `banner`, `ifdefBlock`, `ifdefEdge` and the insert-only `afterContent`/`beforeContent`; `insert` and `delete` spread it, and `str_replace` declares the three structural hints individually because the insert-only pair does not apply to its shape. So a new structural hint has to be added in more than one place. Audit the schemas after adding a hint: schema drift is exactly how the original failure happened. Renamed parameters are not accepted under their old names, and a stale name is silently ignored, so grep saved prompts and notes for old names before assuming a call is scoped.

#### 23. Unified-diff patches are a poor fit for LLM use

**What happens:** The unified diff format asks the model to state line numbers (the `@@ -a,b +c,d @@` header) at generation time, and it cannot do so reliably: the numbers diverge from the file during multi-edit sessions. This is a property of the format, not of patches in general. Cline and opencode use a different format (`*** Begin Patch` / `*** Update File:`, an optional `@@ <context line>`, lines prefixed `+`, `-` or space, no line numbers) and locate each hunk by content.

**Evidence:** `apply-patch` lifetime: 0 successful commits and 50 failures (25 context mismatches, 25 exceptions), with 5 rescued commits. Neither Cline nor opencode publishes success-rate data for its format. Both restrict it by model (opencode offers `apply_patch` only to `gpt-` models, not `gpt-4` or `oss`; Cline registers it in its GPT-5 variant configs), which suggests it is used where models are trained on the format.

**Solution:** `apply-patch` is for human-provided patches or a diff from an external source such as `git diff`, not one the model generates itself. It previews by default (`dryRun` defaults to true; pass `dryRun:false` to commit). The content-anchored tools cover the same use cases without line-number dependence. If a patch tool for model-authored edits is ever wanted, the content-anchored format is the one to evaluate, and two behaviours seen in the other tools should be decided deliberately: opencode computes every hunk before writing, so one failed match aborts the whole patch with nothing written, while Cline skips a chunk whose context is missing, records a warning its handler never reads, and applies the rest, so a partly applied patch is reported as success. Neither refuses an ambiguous match; both take the first hit from the cursor.

#### 24. The model approves its own destructive command

**What happens:** `run-command` guards destructive commands (`rm`, `rmdir`, `del`, `rd`, `format`, `Remove-Item`, `ri`, `rd /s`). The guard once asked in the chat panel and blocked outright when no chat panel was open (the usual case with Claude Desktop), and a caller that passed `confirm:true` could skip the question, so the model could approve its own command.

**Solution:** The question is asked only in the Command Output panel, which opens without taking editor focus, shows the exact command and its working folder, and offers Run and Cancel. Only a click on Run lets it through. `lib/command-confirm.js` takes no `confirm` or `force` argument, so `confirm:true` is ignored. No answer within two minutes means "do not run"; closing the panel answers every open prompt with a refusal; if the panel cannot be opened, the command is blocked. All `run-command` output goes to that panel, not the chat panel.

#### 25. Resending the whole call to fix one field

**What happens:** A match fails because `old_str` is slightly wrong. The model resends the entire call (path, hints, flags, a long `new_str`) to change a few characters of `old_str`. That costs tokens every time and gives the model another chance to alter something that was already right, such as `new_str` or a scope hint. It is the same retry loop the Cline issues cited above describe.

**Evidence:** Failures are where the volume is: 454 lifetime failures on `str_replace` and 158 on `replace`. The framework notes that an earlier preview-then-commit flow saw almost no real use, because a capability the failure text does not mention does not get used; that is why this feature targets failures and the failure text advertises it. Adoption is not measured (see Open items).

**Solution:** `retryOnFail` (`lib/tool-framework.js`), enabled on `replace` and the retired `str_replace`, with `old_str` as the corrected field.
- When a call fails with `matched:false`, the framework stashes its full arguments. There is one stash per tool name and the latest failure wins.
- If the next call to the same tool is exactly `{ filePath, old_str }` (`filePath` may be omitted), the corrected `old_str` is merged into the stashed arguments and the full call runs. The stash is one-shot.
- Anything else counts as a fresh call and leaves the stash alone: any other argument alongside, or a different file.
- The stash is cleared by a success on that tool, and by any real commit (`dryRun:false`) from any tool on the same file, so a stale `new_str` is never merged into a file that has since changed.
- The shortcut is not advertised after FOUND OUTSIDE SCOPE, because the text is right and the scope hint is what needs changing. After a mid-line failure nothing is stashed and any older stash is cleared, because merging a partial `new_str` into a whole-line retry would drop the indent and semicolon (Failure Mode 4).
- `new_str` is optional in the schema only so the bare retry passes validation; a real call that omits it is refused by the handler.

`insert` has the matching feature for previews, `resendlessCommit`: after `dryRun:true`, calling `insert` with just `{ filePath, commitLastPreview:true }` commits the previewed insert as-is. It is one-shot, and different arguments or another tool editing the same file first clears it.

---

## How the automatic rescue works

The shared engine (`lib/match-engine.js`, with the rescue in `lib/recover.js`) matches in stages and stops at the first that succeeds:

1. Exact match inside the resolved search window.
2. Explicit `fuzzyWhitespace` and `fuzzyContent`, only when the caller asked.
3. Automatic rescue (`autoRescue`, default true): one combined diagnosis of whitespace and Unicode differences, one transformed needle, one retry, within the narrowed scope only. Two candidates means refusal. A match far larger than `old_str` is refused as disproportionate. Rescue is skipped when `occurrence` is above 1 and when the caller passes `autoRescue:false` (`delete` and the start/end pair tools, which are destructive and so use strict matching).
4. Failure with a diagnosis: PARTIAL MATCH, COMMENT MISMATCH, FOUND OUTSIDE SCOPE or FOUND ELSEWHERE, a similarity percentage and the closest area, then a record in the fault log.

The engine does not commit trailing-comment strips or partial matches found outside the scope; both are refusals with an explanation (Failure Modes 3 and 8). The retired `str_replace`, still registered as a fallback and no longer extended, keeps its own inline rescue, including the comment strip and the partial-match rescue, and is the only tool that can commit with `[autoStripComment]` or `[autoPartialMatch]`.

**Similarity bands** on failure: 80% or more means whitespace or encoding drift (use a fuzzy flag); 50 to 79% means stale content (re-read); under 50% means the wrong location (check scope hints). For a one-word anchor that fails to resolve, the failure suggests the nearest symbol in the file ("Nearest symbol: ... did you mean that?").

**Guidance on failure #1, not after three:** `smartSuggestion()` fires immediately and analyses why: no hints used lists the specific hints with syntax; an `old_str` that looks like a whole function points to `replace-function-body`; a brace block points to `replace-block`; a large file with no hints adds urgency. After a successful edit with no hints on a file over 300 lines, `successNudge()` tells the model which hints to use next time.

**Retry shortcut:** after a failed call, resending just `{ filePath, old_str }` retries it with the stashed `new_str` and flags (Failure Mode 25).

---

## Where failures still concentrate

Lifetime hit rates by tool (indicative; includes testing calls and pre-fix double counting):

| Tool | Hits | Failures | Main reasons |
|---|---|---|---|
| `read` | 2,691 | 24 | anchor not found 12, ambiguous 5 |
| `str_replace` (retired) | 2,525 | 454 | no match 158, ambiguous 117, out of scope 54, whitespace 50 |
| `replace` (default) | 486 | 158 | no match 130, ambiguous 12, found outside scope 10 |
| `insert` | 351 | 54 | anchor not found 50 |
| `sed` | 156 | 26 | bad expression 13, no match 10 |
| `delete` | 91 | 195 | anchor not found 65, start not found 60, no match 50, ambiguous 38 |
| `replace-function-body` | 12 | 25 | not found 11, ambiguous 11 |
| `replace-block` | 11 | 19 | anchor not found 15, no match 9 |
| `apply-patch` | 0 | 50 | context mismatch 25, exception 25 |

Hint success (`str_replace` lifetime): `afterString` 94% (448 of 479), `afterLine` 91% (166 of 183), `afterFunction` 100% (8 of 8), `occurrence` 100% (24 of 24), `betweenHint` 60% (6 of 10), `inFunction` 49% (38 of 77). On `replace`, `inFunction` is 41% (11 of 27) and `afterString` 86% (37 of 43).

## Open items

- **`inFunction` reliability** (Failure Mode 9): cause only partly isolated. Not determined: whether the tree-sitter path covers `.cc` files, and how the lookup behaves when a file's symbol table is empty (previously read as returning "not found" without saying the file has no usable symbol table; not re-checked). Re-measure now that the range fixes are in.
- **Unsaved-edit hardening** (Failure Mode 18): the bookkeeping after `setTextInRange` is still not wrapped in `try/finally`, so a late throw can again leave an unsaved buffer or hide the edit result.
- **Dry run versus commit** (Failure Mode 21): `str_replace`'s dry run returns before the commit-time exact-text check, so a normalisation-only match previews as success. Not checked for `replace`. A dry run that ran the same verification, or tagged its result when normalisation was needed, would close the gap.
- **`delete` and the brace-matched tools** fail more often than the match-based ones (table above); how much is real model error and how much is test traffic has not been separated.
- **`apply-patch`** has no clean commits in 50 attempts; keep it for external diffs.
- **Retry shortcut adoption** (Failure Mode 25): there is no counter for merged retries, so there is no measure of how often the model uses it or whether the failure-text nudge works. A `retryMerges` counter next to the failure counters would show it.
- **Comparison table** has not been re-run against current versions of Cline, Aider and opencode.
