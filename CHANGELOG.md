# pulsar-edit-mcp-server — Work Tracking

> Last audited against live code: 2026-09-18 (get-region/read-lines retired in favor of `read` — see below; pending live restart verification)

## `get-region` and `read-lines` merged into `read` and retired (2026-09-18)

**Context:** `get-region` and `read-lines` were two separate, largely overlapping read-side tools — `get-region` did content-anchor-pair reads (`startContent`/`endContent`, substring match), `read-lines` did line-number and symbol-based reads (`inFunction`, `nearLine`+`radius`, `startLine`+`endLine`, `afterString`, `betweenHint`) via its own hand-rolled matching rather than the shared `resolveScope()`/`matchContentEngine()` engine. Both had real but incomplete hint coverage — `read-lines` had no `afterFunction`/`beforeFunction`/`afterSymbol`/`beforeSymbol`/`occurrence`/`fuzzyWhitespace`/`fuzzyContent`/`regex`, and `get-region`'s own `occurrence` param existed in schema but had zero real-world uses and no real ambiguity guard behind it.

**Change:** built `read` as a single generic anchor-based read tool on `resolveScope()`/`matchContentEngine()`, covering every mode either source tool had plus the previously-missing hints, and added a local substring-fallback (`findSubstringInLines()`) so `get-region`'s original "unique text at or near the start/end" partial-line matching semantics were preserved rather than silently tightened to exact full-line matches. After `read` was built additively and live-verified against its own fixture, `get-region` and `read-lines` were removed outright rather than kept as alias wrappers — `read` is now the only entry point for anchor/line-based reads (`read-file` remains separate — whole-file/paginated dump, a different tool class, untouched by this merge).

**Bug caught and fixed before the tools were retired:** the pair-anchor mode's first draft called `matchContentEngine` directly for `startContent`/`endContent`, which does full-line exact-equality matching — a real, silent regression from `get-region`'s original substring behavior (a caller passing partial-line text, which `get-region`'s own description explicitly invited, would have gotten a false "not found"). Caught via live testing before the aliasing/retirement step, so no existing caller was ever exposed to it. Fixed with a substring-per-line fallback that only engages when `matchContentEngine`'s own attempts find nothing — a genuine ambiguity result from the engine is trusted as-is and never masked by a lucky substring hit landing on just one line elsewhere.

**Housekeeping — stale description text fixed across the file:** every other tool's description or inline error/nudge message that referenced `read-lines` by name (`str_replace`'s failure diagnostics, `insert`'s positional-hint warnings, `read-file`'s truncation note, `grep-file`/`grep-project`/`file-line-count`'s "follow up with" pointers) was updated to point at `read` instead, so no user-facing text references a tool name that no longer exists. `read`'s own header comment, which still described itself as an "additive first step" pending a future alias conversion, was updated to reflect that the merge is now complete rather than in progress. Comments explaining *why* the substring fallback exists (referencing `get-region`'s original behavior as historical context, not as a live tool) were left as-is — they remain accurate.

**Not yet done:** this edit touches `mcp-registration.js` and has not been restart-verified live yet — per the standing hazard for this file, a full Pulsar restart is required before `get-region`/`read-lines` are confirmed actually gone from `list-tools` and `read` is confirmed still working correctly with the updated description text. `get-diagnostics` reports 0 errors/warnings on the file post-edit.

**Status:** code-complete, confirmed against source (`get-region`/`read-lines` registrations fully absent, `read` present, no dead stats buckets in `edit-stats.js`). Live restart verification pending. Universal hint-naming cleanup (`old_str`/`afterContent`+`beforeContent`/`expectedContent`/`startContent`+`endContent`/`matchString` → one canonical name) remains separate, later, not started.

## `replace-function-body` ported onto the shared match-engine.js, live-verified (2026-09-18 code and verification)

**Context:** `replace-function-body` was fully hand-rolled — its own inline `afterString`/`betweenHint` resolution, its own `occurrence <= 1` ambiguity gate (the same pre-fix convention the `occurrence:1` off-by-one entry below closed everywhere else), and its own call into `findFunction()` (`tree-sitter-symbols.js`) for the actual function lookup. It also carried an `inFunction` parameter with a different, narrower meaning than every other tool on the shared engine: rather than "the function itself" (as `inFunction` means for `str_replace`/`insert`/`delete`/`replace-block`), it meant "restrict the target-name lookup to *inside* this other named function" — an outer-container filter, not an anchor. `afterFunction`/`beforeFunction`/`afterSymbol`/`beforeSymbol` were present in the schema and destructured in the handler but never actually consulted — dead schema, the same class of gap `replace-block`'s port (see entry below) found and fixed for its own hints.

**Decision — drop `inFunction`'s outer-container meaning rather than reconcile or rename it:** confirmed via `get-edit-stats` that `inFunction` had 0 real lifetime uses on this tool across 1486 lifetime edit ops project-wide, and 0 of `replace-function-body`'s 8 lifetime fails were `ambiguous` (all `notFound`) — no evidence any real duplicate-name case ever needed it. Structurally, it was never a real anchor to begin with: every other hint in the schema can resolve a position on its own, but this one only ever modified an already-otherwise-supplied target name (parsed from `newBody`'s own signature line) — a filter, not an anchor. Further, C doesn't allow two function *definitions* sharing a name in one translation unit, so the scenario this hint existed to disambiguate — two real nested bodies with the same name — is close to impossible in valid C, not just empirically rare here. Removed outright, not renamed/preserved. Post-port, `inFunction` on this tool now means what it means everywhere else on the shared engine — "the function itself" — consistent with `str_replace`/`insert`/`delete`/`replace-block`.

**Change:** added `matchFunction(fnName, {allLines}, scope, opts)` to `match-engine.js`, after `matchBlock` and before `applyEdit()` (STEP 4), exported alongside it. Given a `scope` from `resolveScope()` and a `symbols` array passed in via `opts` (reuses the handler's own `getSymbols()` call rather than re-parsing), filters symbols by `name === fnName` and `startRow` within the resolved scope, sorts by `startRow`, then applies the same `occurrence == null`-ambiguous / `occurrence:N`-explicit convention as `matchContent`/`matchBlock` — refusing with the candidate lines rather than ever silently picking one. No anchor-scan or brace-count needed at all (unlike `matchBlock`), since tree-sitter symbol boundaries (`sym.startRow`/`endRow`) are already exact. Returns the same shape `matchBlock` does (`matchLine`/`matchEndLine`/`actualLines`/`sig`/`kind`), so `applyEdit()`/`buildFailResponse()` work on it unmodified. `replace-function-body`'s handler in `mcp-registration.js` was rewritten to: `resolveScope()` → `matchFunction()` → dryRun preview → `applyEdit()` → `buildEditResponse()`, dropping the old inline `afterString`/`betweenHint` resolution, the old outer-container `inFunction` block, and the old `occurrence <= 1` gate entirely. This also gives the tool the B39/B40 drift/verify safety net on its commit path for free, same as `replace-block`'s port.

**Behavior change, not just a refactor:** `afterFunction`/`beforeFunction`/`afterSymbol`/`beforeSymbol` were already present in the schema and destructured in the old handler, but never actually consulted for disambiguation — dead parameters. Post-port, all of them are live and genuinely scope the search, same finding as `replace-block`'s port below.

**Bug caught and fixed before ship (source-inspection, not a live failure):** the first draft of `matchFunction` read `scope.symbols`, assuming `resolveScope()`'s success return carried the full symbols array. Grepped every `symbols` reference in `match-engine.js` before committing and confirmed `symbols` only ever appears inside `scope.ERROR` objects (diagnostic use), never in a success return. Fixed by passing `symbols` in via `opts` instead, computed once by the handler.

**Verified live (2026-09-18), post-restart** against a purpose-built fixture (`test/rfb_port_verify_test.c`): (a) simple single-match case — dryRun preview and commit both correct, no `[signatureChanged]` tag on a body-only change; (b) ambiguous same-name case (`scopeDup`, two definitions) — omitted `occurrence` correctly refuses with both candidate lines listed and the full hint list (`occurrence`/`afterString`/`afterFunction`/`afterSymbol`/`betweenHint`), `occurrence:1` now resolves directly to the first definition, `occurrence:2` resolves to the second (regression check, no issue); (c) previously-dead hints — `afterFunction` and `afterSymbol` (tried independently, same anchor) both correctly scoped to the definition *after* the anchor rather than falling back to a whole-file/first-match default, proving the wiring is real; (d) a function preceded by an 11-line doc comment — matched the full body (signature through closing brace), not just the signature line, confirming a previously-parked, unrelated `read`/`inFunction` anomaly on a different symbol in a different file does not reproduce via `matchFunction`; (e) `[signatureChanged]` tag fired correctly on a real signature change and was correctly absent on a body-only change; (f) `applyEdit()`'s drift/verify safety net was transparent across all 4 real commits made this session — `check-struct` on the fixture post-all-edits reports fully clean (braces balanced, no unclosed comments, `#if` depth 0).

**Restart note:** the code for this port was written in an earlier session; that session's first live-test attempt (before any restart) failed with `matchFunction is not a function` — confirmed by source inspection to be the already-documented stale-server hazard (editing `mcp-registration.js`/`match-engine.js` needs a real restart, not a reload), not a code defect. A user-initiated restart resolved it immediately; the first call afterward worked with no further issues, and no code changes were needed in the verification session itself.

**Status:** closed. Universal hint-naming cleanup (`old_str`/`afterContent`+`beforeContent`/`expectedContent`/`startContent`+`endContent`/`matchString` → one canonical name) remains separate, later, not started.

## `replace-block` ported onto the shared match-engine.js, live-verified (2026-09-17 code / 2026-09-18 verification)

**Context:** `replace-block` was fully hand-rolled — its own scope resolution (`findFunctionInBuffer`, `resolveAnchor`, `resolveStringPosition`), its own anchor-scan loop, its own `occurrence <= 1` ambiguity gate (the same pre-fix convention the prior entry above closed everywhere else), and its own brace-counting logic — despite a header comment claiming it was "migrated to Tool Framework," which turned out to mean only the `registerMcpTool` registration wrapper (`dryRun`/`lint`/`consecutiveFailureCounter`), not the matching engine. Confirmed by direct source inspection that none of its scope resolution went through `resolveScope`/`matchContentEngine`.

**Change:** added `matchBlock(anchor, {allLines}, scope, opts)` to `match-engine.js`, placed after `matchContent` (STEP 3) and before `applyEdit()` (STEP 4). It reuses `resolveScope()` for all hint resolution (`inFunction`/`betweenHint`/`afterFunction`+`beforeFunction`/`afterSymbol`+`beforeSymbol`/`afterString`+`beforeString`/`afterLine`+`beforeLine`), then does its own occurrence-aware anchor-line scan within the resolved scope (same `occurrence == null`-ambiguous / `occurrence:N`-explicit convention as `matchContent` — no `occurrence <= 1` reintroduced), then brace-counts forward to the matching close. Returns `matchLine`/`matchEndLine`/`actualLines` in the same shape `matchContent` returns, so `applyEdit()` and `buildFailResponse()` work on it unmodified. `replace-block`'s handler in `mcp-registration.js` was rewritten to: `resolveScope()` → `matchBlock()` → dryRun preview → `applyEdit()` → `buildEditResponse()`. Brace-matching itself is unchanged, just relocated into `matchBlock()`. `braceMatchFailed` keeps its own bespoke error message rather than being folded into `buildFailResponse`'s anchor-not-found/ambiguity shape, since it's a genuinely different failure class. This also gives `replace-block` the B39/B40 drift/verify safety net on its commit path for free, which the old hand-rolled `setTextInRange` call never had.

**Behavior change, not just a refactor:** `afterFunction`/`beforeFunction`/`afterSymbol`/`beforeSymbol`/`afterLine`/`beforeLine` were already present in the tool's schema and destructured in the old handler, but the old hand-rolled if/else chain only ever checked `inFunction`/`betweenHint`/`afterString` — the rest were silently ignored dead parameters. Post-port, all of them are live and actually scope the search.

**Verified live (2026-09-18)** against a purpose-built fixture (`test/replaceblock_verify_test.js`): (a) simple single-match anchor+brace block — dryRun preview and commit both correct; (b) ambiguous anchor (same string in two blocks) — omitted `occurrence` correctly refuses with the candidate line list, `occurrence:1` now resolves directly to the first match (confirms the `occurrence == null` fix carried through this port correctly), `occurrence:2` still resolves correctly (no regression); (c) previously-dead hints — built a sharper test than a single anchor allows: the same ambiguous anchor string duplicated across two sibling functions, then `afterFunction` and `inFunction` each targeted against it independently. Both resolved to two different, correct matches with no ambiguity error, proving the scoping is genuinely wired in rather than schema-present-but-ignored; (d) `braceMatchFailed` — an anchor with no following `{` produces its own distinct error with the anchor line and surrounding context, doesn't fall through to the wrong error shape or crash. `check-struct` and `get-diagnostics` clean throughout (0 errors; only the fixture's deliberately-unused-var/undef warnings). `beforeFunction`/`afterSymbol`/`beforeSymbol`/`afterLine`/`beforeLine` were not individually exercised — `afterFunction`+`inFunction` were enough to confirm the shared `resolveScope` wiring is real; lower priority to test the rest exhaustively unless a bug surfaces. `applyEdit()`'s drift/verify safety net was not actively observed under real drift in this session (nothing else touched the file concurrently) — expected to be transparent per how it behaves for the other tools, but not directly exercised here.

**Status:** closed.

## `occurrence:1` off-by-one fixed and live-verified — explicit occurrence:1 no longer indistinguishable from omitted (2026-09-17)

**Problem:** every ambiguity guard across the shared matching infrastructure (`resolveStructuralAnchor` in `buffer-helpers.js`; `resolveScope`'s `inFunction`/`afterFunction`+`beforeFunction`/`afterSymbol`+`beforeSymbol`/`afterString`+`beforeString` branches and `matchContent`'s regex and fuzzy/exact paths, both in `match-engine.js`) used the same `occurrence > 1` / `occurrence <= 1` shape: every handler defaulted `occurrence = 1` in its own destructuring, so an omitted `occurrence` and an explicitly-passed `occurrence:1` were indistinguishable by the time they reached these checks. Result: `occurrence:1` was always treated as ambiguous whenever more than one match existed — it was structurally impossible to ever select the first of several matches without first hitting the ambiguity refusal and retrying with `occurrence:2`+ (which worked correctly). Surfaced while live-testing the new `delete` tool's `sectionHint` mode (see previous entry) against a file with two similarly-named banners.

**Corrected semantics (per PJ, deliberately distinct from a naive "just remove the check"):** omitted `occurrence` with more than one match still safely refuses and lists the candidates — this is the important safety behavior and was explicitly preserved, never weakened. Only an *explicit* `occurrence:1` changes: it now resolves directly to the first match, exactly as `occurrence:2`+ already did.

**Fix:** removed the `= 1` handler-level defaults in `insert` and `delete` (`mcp-registration.js`) so `undefined` actually propagates instead of being pre-collapsed. In `buffer-helpers.js`/`match-engine.js`, every ambiguity guard changed from `occurrence <= 1` (or `occurrence > 1` for the inverse) to `occurrence == null` (`occurrence != null`), and the two `matchContent` indexing lines changed to `occurrence ?? 1` so a single match with `occurrence` genuinely omitted still resolves. `str_replace` (never used this shared code — confirmed via B32's earlier gap analysis and a direct call-site check), `replace-block`/`get-region` (own hand-rolled matching, confirmed by inspection — `get-region` has its own `findAnchorInLines`), and `tree-sitter-symbols.js`'s `findFunction` (a different, non-guarded pattern used only for read-side navigation, not edit safety) were deliberately left untouched — out of scope, no bug present.

**Bonus cleanup:** `insert-function-doc`'s `hintLine` disambiguation had a hand-built `bestIdx === 0` bypass, comment-tagged `[B64 follow-on]`, that hand-constructed a scope object specifically to work around this exact bug rather than calling `resolveScope`. Now dead weight once the source fix landed — simplified to call `resolveScope` uniformly for every `bestIdx` including 0; comment updated to explain the history.

**Verified live** with a throwaway fixture (two similarly-named section banners, a duplicate function name) against both `delete` (`sectionHint`) and `insert` (`afterFunction`): omitted `occurrence` still correctly refuses with the candidate list; `occurrence:1` now resolves directly (the fix); `occurrence:2` still resolves directly (regression check). `get-diagnostics` clean (0/0/0) on all three touched files before and after the `insert-function-doc` cleanup.

**Status:** closed.

## `delete` tool shipped — consolidates `delete-line`, `delete-line-range`, `delete-block` into one tool with 5 match modes, live-verified (2026-09-17)

**Change:** per a spec drafted, reviewed, and revised together with PJ (including catching an early draft's `content` param name as itself a third redundant synonym for `old_str`/`afterContent`+`beforeContent` before settling on `matchString`), `delete-line`, `delete-line-range`, and `delete-block` were removed and replaced with a single `delete` tool exposing a 6-rung decision ladder: `sectionHint`/`preprocBlock` (+`preprocSide`) → `inFunction` (whole function body) → `startContent`+`endContent` (+`inclusive`) → `matchString` (new — single-block match-and-delete, delegating to the same `resolveScope`/`matchContentEngine`/`buildFailResponse` pipeline `insert`'s `afterContent`/`beforeContent` and `str_replace`'s `old_str` already share, not new matching logic) → `startLine`+`endLine` (+`expectedContent` verification). `delete-line` folded in via `startLine == endLine`. Stats consolidated into a single `delete` bucket in `edit-stats.js` (mode-level history from the three old buckets not preserved, per PJ's call) with `matchString` added to tracked hint keys.

**Bug caught and fixed before ship:** the first draft's `matchString` mode called `buildFailResponse` with an invented parameter shape that didn't match any real call site in the codebase, and was missing the `scope.error` early-return check every other `resolveScope` caller has. Fixed to match the established `{ tool, ctx: { consec, allLines, text }, scope, needle, isCodeFile }` signature before shipping.

**Verified live post-restart** against a purpose-built fixture (section banner, `#ifdef` block, named function, `START_BLOCK`/`END_BLOCK` markers): all 6 modes exercised via `dryRun`, including the `inclusive:false` variant and `expectedContent`'s both success and mismatch-rejection paths; two real (non-dry-run) commits confirmed the actual write path end-to-end, not just the preview path. `get-edit-stats` confirmed the three old tools are fully absent from lifetime stats and the merged `delete` bucket is tracking correctly.

**Found, not fixed here (see next entry above — now closed separately):** the `occurrence:1`-always-ambiguous bug in `resolveStructuralAnchor`, hit while testing `delete`'s `sectionHint` mode against a file with two similarly-named banners.

**Status:** closed.

## B32 re-scoped — gap analysis found no bug to port, but ported B39/B40's write-safety checks into match-engine.js's applyEdit() (2026-09-17)

**Context:** Went looking to finally do the B32 str_replace-onto-match-engine port (str_replace: 2778+ lifetime hits, ~1100-line hand-rolled handler — much larger than match-engine.js's own header comment estimate of "~350 lines"). Before touching the highest-traffic tool in the file, did a full behavioral gap analysis first: read str_replace's entire handler end-to-end and compared every piece of its matching/ambiguity/commit logic against `match-engine.js`'s equivalents.

**Finding — the original premise (B32's addendum, "str_replace silently resolves ambiguous matches") is stale.** That bug is already fixed, independently, by **B38** (2026-07-20, plain-string path) and **B57/B58** (2026-09-12, `fuzzyWhitespace`/`fuzzyContent`/`regex` paths) — none of this history was previously written up as closing B32's motivating bug, it was scattered across separate bug-number entries. str_replace's hand-rolled ambiguity guards are correct and independently battle-tested; porting them onto the engine's equivalent (already-correct) guard would be pure deduplication, not a bugfix, at real risk to the file's most-used tool.

**Finding — going the other direction, match-engine.js was actually missing two things str_replace has and needed:** **B39** (buffer-drift re-check between match-time and write-time — a fast successive edit can shift line numbers before the write happens) and **B40** (byte-for-byte verification of the live buffer's actual content at the write target immediately before writing). `match-engine.js`'s `applyEdit()` previously did a bare `setTextInRange()` with neither check.

**Change — ported B39/B40 into `applyEdit()`, adapted from str_replace's character-offset version to this engine's row-based match shape:** compares live buffer lines at `[matchLine, matchEndLine]` against `match.actualLines` (a field `matchContent()` already returns); on mismatch, attempts to relocate by searching the live buffer for the same `actualLines` block and retries verification at the new location; if that also fails, refuses and returns `{ error: 'driftUnrecoverable' | 'verifyFailed' }` instead of writing. Verification is entirely opt-in — skipped with no behavior change if `match.actualLines` isn't populated — so this is a pure safety upgrade, never a new hard requirement on the calling convention.

**Important — this port is currently inert.** Traced every call site of `resolveScope()`/`matchContentEngine()` across the codebase (`insert`, `apply-patch`'s hunk rescue, `delete_block`, `insert-function-doc`): all of them write via their own direct `buffer.setTextInRange()` calls using `matchLine`/`matchEndLine` from the match result — **none of them call `applyEdit()` itself**. `applyEdit()` has been dead code since it was written; this port doesn't change that, it just means the function is safer/more complete whenever a future caller (or a real B32 str_replace port, if ever revisited) adopts it.

**Verified** via a standalone test (`test/apply_edit_b39_b40_verify.js`, deleted after running) against a mock buffer object — no live tool call was possible since nothing calls this function yet. 13/13 assertions passed: normal no-drift write; drift with the target block still findable elsewhere (relocates and succeeds); drift with the block gone entirely (refuses, buffer untouched); multi-line ranges; delete (`new_str:''`); and the no-`actualLines`-provided case (verification skipped, behaves exactly like the old bare version). `node -c` confirms the file is syntactically valid.

**Status:** B32 itself remains explicitly NOT pursued — the gap analysis found no correctness gain and real risk, so the plan doc's "hold off" decision stands, now on firmer evidence rather than an assumption. This entry closes out the useful side-effect of that investigation (the applyEdit() hardening) as its own small, independently-verified change.

## T1 fixed — `apply-patch`'s hunk fuzzy-rescue migrated off `findAnchor` onto match-engine (2026-09-12, backfilled to CHANGELOG 2026-09-17)

**Change:** `apply-patch`'s fuzzy-rescue path (triggered when the initial unified-diff apply fails on context mismatch) previously re-located each hunk's anchor via the old bespoke `findAnchor(buffer, anchor, { afterRow: searchAfter })`. Migrated onto `resolveScope()`/`matchContentEngine()` — same framework `insert` got under T2 — using the `afterRow` passthrough added to `resolveScope()` specifically to unblock this and T3. Format and behavior are unchanged from the caller's perspective: this was purely an internals swap, not a rebuild (the T1 "build a new `block-edit` tool" plan was investigated and explicitly shelved in favor of this narrower scope — see the 2026-07-20 decision entry below).

**Bugfix bundled with the migration:** the anchor-line filter previously dropped any context line with `trim().length <= 2`, intended to skip near-empty lines but incidentally also dropping short-but-structurally-meaningful lines like a bare `{` or `}`. That was harmless for the old `findAnchor`'s representative-sampling search, but `matchContentEngine`'s `scanBlock` requires anchor lines to be consecutive in the buffer — dropping a middle line (e.g. the `{` between a function signature and its body) broke that adjacency and caused the anchor to silently fail to match content that was actually present. Fixed to only drop genuinely empty lines, preserving adjacency.

**Inherited for free:** hunk-rescue now shares the same ambiguity guard (B41-class) as every other match-engine tool — a hunk whose context matches more than one location in the buffer is now reported as ambiguous (with the candidate line numbers) instead of the old fuzzy-rescue silently picking one.

**Status:** closed. This was the last remaining piece of T1's revised scope. Combined with T3's own migration (`delete_block`, closed 2026-09-17 — see above), `findAnchor` is now fully retired from the codebase.

## `findAnchor` fully retired — `delete_block` ported onto match-engine, live-verified (2026-09-17)

**Change:** `delete_block`'s `startContent`/`endContent` anchor lookups (the last two live callers of the old bespoke `findAnchor()` helper in `buffer-helpers.js`, per the retirement plan's caller table) ported onto the shared `resolveScope()`/`matchContentEngine()` framework — same `afterRow` passthrough / adapter-shape pattern (`hit = { row, matchedRows, strategy }`) T1 already proved for `apply-patch`'s hunk rescue. `findAnchor()`'s function body and its export removed from `buffer-helpers.js`; the now-unused import removed from `mcp-registration.js`.

**Bug fixed as a side effect:** previously only `startContent` had any ambiguity check (a separate bespoke `ambiguityCheck()` call), and `endContent` had none at all — a duplicate `endContent` string in scope would silently resolve to the first match with no warning. `matchContentEngine()`'s native ambiguity guard now covers both anchors; the old bespoke `ambiguityCheck()` call was removed as redundant/superseded. All existing custom failure-message formatting (the "here are the lines after startContent" preview, `smartSuggestion` calls) was preserved as-is — this was a matching-internals swap, not a UX rewrite.

**Verified live post-restart** with a purpose-built fixture (`test/t3_delete_block_verify_test.js`, two functions each containing an identical `// BLOCK_MARKER start` / `// BLOCK_MARKER end` pair): an unscoped `delete_block` call correctly reported startContent as ambiguous instead of silently deleting the first match; the same call scoped with `inFunction:'beta'` correctly resolved to and deleted only `beta`'s block, leaving `alpha`'s identical-looking block fully untouched. Confirmed the restart actually landed the change (not testing stale cached code) via the live lint-suffix response on the real delete commit.

**Status:** closed. `findAnchor` retirement (tracked in the refactor plan's "`findAnchor` retirement" section) is now complete — both previously-remaining callers (`apply-patch` under T1, `delete_block` under T3) are migrated. No remaining call sites reference the function; only comments mention the old name for historical context.

## 2026-09-17 — `read-file` pagination fix live-verified (large files no longer hard-fail)

**Problem:** `read-file` had no size guard — it returned a file's entire content regardless of size and simply hard-failed with a generic "tool result too large" error past roughly 1MB, with no truncation, pagination, or way to request the rest. Hit live reading `CHANGELOG.md` at 1032 lines.

**Fix:** added an optional `offset` (default 0) to `read-file`'s input schema. The handler now slices output into 2000-line pages instead of returning the full line array unconditionally. When a file exceeds one page, the response is prefixed with a truncation note (`"⚠️ Large file — showing part N of M (lines X-Y of Z). Call again with offset:<next> for the next part."`, or "This is the last part." on the final page), plus a pointer to `read-lines` for callers who only need a section. New response fields (`returnedLines`, `offset`, `truncated`, `totalPages`, `currentPage`) let a caller page programmatically without re-parsing the warning text. Description text updated in both `mcp-registration.js` and the separate `tool-catalogue.js` summary copy.

**Verified:** 4 acceptance tests, no restart needed this session (fix was already live). Against `lib/mcp-registration.js` (7358 lines): no-offset call correctly returned part 1 of 4 (lines 1-2000) with the right truncation note and `offset:2000` hint; `offset:2000` correctly picked up at line 2001 (part 2 of 4); `offset:6000` correctly returned the last page (lines 6001-7358, part 4 of 4, "this is the last part," ending exactly at true EOF with no off-by-one). Regression check against `lib/schema.js` (59 lines) returned the full file with zero truncation note and an unchanged response shape.

**Status:** closed — all "not yet done" items from the original fix (restart+cache-clear, first/mid/last page boundaries, small-file regression) are now confirmed. The 2000-line-per-page threshold itself was a conservative guess rather than a measurement against the actual ~1MB byte cap — left as an open nice-to-have, not blocking.

## `grep-project` unscoped-search timeouts fixed — return-with-truncation instead of gather-then-truncate

**Problem:** an unscoped `grep-project` (no glob) against a large project — notably one with a big nested codebase like the full Ghidra C++ source tree — could time out entirely ("No result received... after waiting 4 minutes"), observed alongside elevated Pulsar memory (~7GB) and tree-sitter WASM parser crashes. The search was gathering every match across every file before truncating the response, so the full unscoped scan had to complete (and hold the full match set in memory) regardless of how large the eventual truncated response would be.

**Fix:** `grep-project` now truncates as it goes rather than gathering all results first and truncating afterward — the scan stops once the response's match/result cap is reached instead of continuing to walk the rest of the project. This avoids doing (and holding in memory) far more work than the response will ever return.

**Status:** closed. Scoping searches with an explicit `glob` remains good practice for precision, but is no longer required as a timeout workaround for large unscoped searches.

## B44 fixed and verified — `resolveStructuralAnchor` silent-ambiguous-match bug (2026-09-12)

**Bug fixed — `resolveStructuralAnchor` (`buffer-helpers.js` L49-119) had no ambiguity guard, same silent-wrong-location-write bug class as B38/B41 but in a separate, never-audited code path:** used by `insert`'s `sectionHint`/`preprocBlock` branch and `delete-block`'s equivalent — both call this helper directly rather than going through `match-engine.js`. Its `sectionHint` and `preprocBlock` branches matched via case-insensitive substring against every line and `return`ed on the *first* hit, with no collection of further matches, no ambiguity check, and no `occurrence` param in the function signature at all. A file with two section banners or two preproc blocks whose keyword/macro-name text shared a substring (e.g. `sectionHint:'Wi-Fi'` matching both `/* ---- Wi-Fi Config ---- */` and `/* ---- Wi-Fi Legacy ---- */`) would silently resolve to whichever appeared first and commit there with zero warning.

**Reproduced live** with a purpose-built fixture (`test/b44_structural_anchor_ambiguity_test.c`, two overlapping section banners and two overlapping preproc blocks, kept in-repo as a regression fixture): `sectionHint:"Wi-Fi"` and `preprocBlock:"CONFIG_WIFI_NEW"` (each a substring of two real anchors in the fixture) both confirmed silently resolving to the first match with dry-run previews giving no indication a second match existed.

**Fix:** both branches now collect every match instead of returning on the first hit, gained an `occurrence` param (default 1), and return `{ ambiguous: true, matches: [...] }` when `matches.length > 1 && occurrence <= 1` — same shape/pattern as `match-engine.js`'s `resolveScope` ambiguous branches. Both call sites (`insert`, `delete-block`) updated to pass `occurrence` through and surface a dedicated ambiguous-match error distinct from not-found, with a new `fails.anchorAmbiguous` stat.

**Verified live post-restart** against the fixture: `sectionHint:"Wi-Fi"` and `preprocBlock:"CONFIG_WIFI_NEW"` now correctly report both match lines instead of silently resolving to the first; `occurrence:2` correctly disambiguates to the second match; a full unique-name hint (`"Wi-Fi Config"`) resolves normally with zero added friction; `delete-block` inherited the fix automatically via the shared helper, with no separate patch needed there.

**Restart note:** editing/saving `buffer-helpers.js` and `mcp-registration.js` via headless `str_replace` (files not open in any tab) did not reliably trigger the server's package-reload file-watcher this time — a manual Pulsar restart was required before the fix took effect, a previously undocumented case distinct from the in-tab-save reload path assumed by earlier restart-hazard notes.

**Left open:** wiring `sectionHint`/`preprocBlock` as a proper `resolveScope()` branch in `match-engine.js` — actually consolidating into the shared framework rather than fixing the bug in place at `buffer-helpers.js` — was deliberately not done as part of this fix (fix-then-port, not port-then-fix). Whether `delete-block` ever joins the shared `match-engine.js` backend remains a separate, undecided architecture question.

## T3 fixed and verified — `delete-line-range` raw-line path gains content verification (2026-09-12)

**Gap fixed — `delete-line-range`'s raw `startLine`/`endLine` path had no content verification at all**, unlike `str_replace` which even in its weakest `afterLine` fallback mode still requires `old_str` to match inside a narrowed window. `delete-line-range`/`delete-block` both had ~100% lifetime hit rates, so this wasn't "these tools are broken" — it was one narrow, specific gap: nothing stopped a raw line-range delete from silently removing the wrong lines if line numbers had drifted since they were last read.

**Fix:** added an optional `expectedContent` param to `delete-line-range` (schema, handler destructuring, and a new verification block after the existing bounds checks). Fires only when `expectedContent` is passed (opt-in — doesn't break existing lifetime callers) and only on the two flagged gaps: `_resolvedVia === 'positional'` (raw `startLine`/`endLine`) or `'afterString+endLine'` (the half-drift-immune case where `afterString` only pins `startLine`, `endLine` stays raw). On mismatch, returns a loud error showing the actual content of the target range plus a `smartSuggestion` nudge — same shape as `insert`'s `onLine`+`expectedContent` check and B44's ambiguous-match errors. New stat key: `fails.expectedContentMismatch`. Both description strings (the live decision-ladder text and the `tool-catalogue.js` summary) updated to document and recommend it.

**Verified live post-restart** against the B44 fixture: a deliberate content mismatch on a line range is correctly blocked with the actual content shown; a real matching string passes through with a normal preview; calling with no `expectedContent` at all (the existing-caller pattern) is completely unaffected — zero regression.

**Status:** closes the last "confident wrong-location write, zero verification" gap in the edit-tool family — B38 fixed it in `str_replace`, B44 fixed it in `resolveStructuralAnchor` for `insert`/`delete-block`'s `sectionHint`/`preprocBlock`, this closes it for `delete-line-range`'s raw path. `delete-block` was deliberately left untouched, out of scope for this pass — whether it ever joins the shared `match-engine.js` backend remains open.

## 2026-09-17 — Migration audit gap-fix (`delete-line`, `add-comment`) live-verified with disk-level confirmation

**Verified:** the two real auto-save gaps found in the 2026-09-16 migration audit (`delete-line` and `add-comment` mutated the buffer directly and returned without ever triggering a save) were fixed same-session by migrating both onto `buildEditResponse()`, following the same pattern as their already-safe siblings (`delete-line-range`, `insert-function-doc`/`replace-block`). This entry records live verification post-restart.

**Method:** for each tool, created a fresh test file, made an edit, then called `close-file` with `save:false` (deliberately discarding any unsaved buffer state) before reading the file back from disk — ruling out a false-positive from `read-file`'s live-buffer preference, which every prior verification in this project had relied on instead.

**Result:** both edits were present on disk after the tab was closed without an explicit save — `delete-line-range`'s deletion and `add-comment`'s inserted block comment both survived, confirming the `buildEditResponse` migration genuinely saves rather than just returning a success message.

**Status:** closes the full migration-audit arc — audited all 13 `category:'edit'` tools, found 11 already safe (via `ctx.commit()` or direct `buildEditResponse()` calls, all exit branches checked), found and fixed 2 real gaps, now both live-verified with disk-level confirmation rather than live-buffer re-reads.

## 2026-09-16 — Auto-save migration audit: 2 real gaps found and fixed (`delete-line`, `add-comment` were not persisting edits)

**Bug found — `delete-line` and `add-comment` mutated the buffer directly and returned without ever calling `buildEditResponse()` or `ctx.commit()`:** a full audit of all 13 `category:'edit'` tool registrations (prompted by confirming `str_replace`'s auto-save coverage via a separate, non-`ctx.commit()` route through `buildEditResponse()`) found these two were the only tools that never reached either save path. `delete-line` (already deprecated in favor of `delete-line-range`) called `buffer.deleteRows()` directly; `add-comment` (Ghidra RE block-comment tool, not deprecated, actively used) called `ctx.buffer.insert()` directly. Both returned a plain `content: [...]` response afterward with zero persistence — an edit made via either tool was silently buffer-only unless something else later saved the buffer.

**Fix:** migrated both onto `buildEditResponse()`, mirroring the pattern used by structurally similar already-safe tools (`delete-line-range` for `delete-line`; `insert-function-doc`/`replace-block` for `add-comment`). `delete-line` also gained `features: { lint: true }` (previously had no lint support at all). `add-comment` kept all its existing logic (Ghidra function lookup, indent detection, Ghidra-file style-check gating) unchanged, but its manually-concatenated `styleSuffix` string is now passed through `buildEditResponse`'s standard `style` warnings field instead of being hand-formatted.

**Status:** code-complete, verified via `node --check` and on-disk persistence checks at write time; live disk-level verification (tab closed without save, then re-read) completed 2026-09-17 — see entry above.

## 2026-09-16 — Auto-save architecture confirmed universal across both save routes (`ctx.commit()` and direct `buildEditResponse()`)

**Investigated:** whether tools not migrated onto the shared framework's `ctx.commit()` path (e.g. `str_replace`, which has its own hand-rolled match/commit logic) were missing the "auto-save on every edit" guarantee.

**Finding:** `buildEditResponse()` (`edit-response.js`), not `ctx.commit()`, is the true single save point for the whole edit surface. `ctx.commit()` saves earlier itself (for decoration/struct-check ordering) then omits `buffer` from its own `buildEditResponse()` call to avoid a double-save; every hand-rolled tool (including `str_replace`, on both its primary match path and its partial-match rescue path) calls `buildEditResponse()` directly with `buffer` passed in, which saves unconditionally when present. Both routes converge on the same guarantee — `str_replace` was never a gap.

**Follow-up audit:** enumerated all 13 `category:'edit'` tools and checked each against this two-route model, including secondary/rescue exit branches — 11 confirmed safe, 2 real gaps found and fixed (see entries above/below).

**Also fixed this session — 4 stale tool descriptions written under the old manual-save model:** `get-compiler-diagnostics` and `diff-preview` (both `mcp-registration.js` and `tool-catalogue.js` copies) previously instructed the LLM to call `save-file` first; now correctly note that edit tools auto-save. `save-file` itself now clarifies it's rarely needed for MCP-made changes, still useful for non-MCP-sourced buffer changes (e.g. a human typing directly in Pulsar).

## 2026-09-16 — `create-file` lint-count mode (B84) added to the framework; live-verified except for one unproven detail (ESLint debounce race found, not yet fixed)

**Feature — `ctx.commit()`'s `features.lint` now accepts `'count'` as well as `true`:** whole-file/large-block tools like `create-file` previously had no lint wiring at all; dumping every message's full per-line detail for a freshly-created large file would be noisy. `features: { lint: 'count' }` now returns a condensed `⚠️ lint (N issue(s)) — call get-diagnostics on this file to review.` instead of the full per-message breakdown, while existing `features: { lint: true }` tools (`str_replace`, `insert`, etc.) are unaffected. `create-file` was migrated to use this, gaining `ctx.commit()`'s save/decorate/focus side effects along the way (its own `fs.writeFile` still does the actual disk write; `ctx.commit()`'s `buffer.save()` is now a second, harmless, idempotent save).

**Verified:** silent-when-clean behavior, tab-focus, and save-on-create all confirmed correct via live testing. The countOnly *output format* itself was never actually observed live — every test file's lint messages weren't ready at response time (see the debounce-race finding below), so the wiring is proven not-broken but the specific string it produces is still unconfirmed.

**Bug found, not yet fixed — ESLint debounce race affects every lint-enabled edit tool, not just `create-file`:** lint feedback queried immediately after an edit/create can reflect the *previous* edit's state (or nothing, for a brand-new file) because ESLint's own ~300ms debounce hasn't completed yet by the time `maybeLintSuffix` runs. Confirmed via a stale-message reproduction (`str_replace` showed the prior edit's warning, not the new one) and via a timing test (natural round-trip latency already exceeds the debounce window in most cases; a deliberate ~200-300ms delay reliably let the real result settle). This is a pre-existing, broader issue that B84 inherited rather than caused. **Not yet fixed** — candidate approaches (flat delay, poll/retry, document as a known limitation, or check for a synchronous lint API) were identified but no decision made.

## 2026-09-16 — Move/copy/rename tab-opening bug fixed; two-round description cleanup; second stale-description source (`tool-catalogue.js`) discovered

**Bug fixed — `move-file`, `copy-file`, `rename-file` unconditionally opened a new tab for the destination even when the source was never open in one:** each had an unconditional `else await atom.workspace.open(destPath)` (or unconditional call) after the write, regardless of whether the source file had a tab to begin with. Fixed so a new tab only opens when the source was already open (and, for `copy-file`, specifically when the *source* was open — the copy tab-opening is now correctly gated on that, not unconditional).

**Description cleanup (two rounds, `mcp-registration.js`):** per the stated principle that tab mechanics are invisible plumbing the LLM should never need to reason about — the only genuinely query-relevant tab facts are "is a file open" (`list-open-files`) and "what's selected" (`get-selection`) — removed pure UI-mechanic trivia ("works whether or not the file is open in a tab", "tabs are retargeted automatically", etc.) from 16 tool descriptions across both rounds. Kept the substance where it's actually query-relevant (e.g. `grep-file`/`read-lines` still note they read from the live buffer, which affects correctness of results).

**Second source found — `lib/tool-catalogue.js`:** after restart, `list-tools` still showed the old stale descriptions on 6 tools. Root cause: `list-tools` reads from a separate, independently-hand-maintained `TOOL_CATALOGUE` array (`tool-catalogue.js`), used only for that one diagnostic view — not the actual tool registration used by real MCP calls. The earlier fixes were not wasted (they fixed what an MCP client actually sees when it lists/calls a tool), but `list-tools`'s own display was reading a second, drifted copy. Mirrored the same 6 description edits into `tool-catalogue.js`; confirmed via post-second-restart `list-tools` output that both files are now consistent with each other and match the stated end-state (only `save-all`, `open-file`, `list-open-files` mention tabs at all).

**Lesson recorded for future description-cleanup passes:** grep both `mcp-registration.js` and `tool-catalogue.js` from the start — they can drift independently.

## 2026-09-15/16 — B73: `tool-framework.js`'s generic tool wrapper had its own unpatched copy of the B68 buffer-leak bug

**Bug found — `makeRegisterMcpTool()`'s shared scaffold (used by every tool registered via `registerMcpTool`, not just the read-only family B69 patched) unconditionally called `atom.project.bufferForPath()` for any tool call with a `filePath`, with zero buffer lifecycle management:** this ran even for pure read/nav/search tools — confirmed via `read-file` (`category:'nav'`), which even has its own separate `readTextFromFile` call in its handler body, meaning this wrapper's `bufferForPath` call was 100% wasted *and* dangerous for that tool specifically. Same unbounded-buffer-leak class as B68 (native renderer crash via `INVALID_POINTER_WRITE`, per B70/B71's crash-dump analysis, when a leaked buffer is later torn down while still referenced) — but a completely separate code path upstream of every framework-registered tool, never touched by B69's fix in `buffer-helpers.js`. Found while diagnosing a real session outage (repeated intermittent tool-call failures, including on tools that had just worked seconds earlier) coinciding with heavy tool usage against a project with the full external Ghidra C++ source tree open as a root.

**Fix (mirrors B69's final, post-B71 architecture):** in the "not open in a tab" branch, compute `alreadyRegistered` via `atom.project.getBuffers()` lookup. If `category === 'edit'` or `alreadyRegistered`, behavior is unchanged (real `bufferForPath` call). Otherwise (nav/search/command, no buffer already registered): skip `bufferForPath` entirely, read via `fs.promises.readFile`, strip a UTF-8 BOM manually, and hand back a lightweight shim exposing only `getLines()`/`getText()`/`getPath()` — the only methods any non-edit-category tool ever touches. No real `TextBuffer` is ever created for this path, so there's nothing to leak or race-destroy.

**Live-verified:** `read-file` on files not open in any tab returned correct content via the new shim path with zero exceptions; memory stayed flat (`Get-Process Pulsar` working set: 934.1MB → 915.8MB across two calls, within noise); `str_replace` (`category:'edit'`) regression-checked unaffected, still goes through the real `bufferForPath` path.

**Follow-up bug found same investigation — `create-file` broken by B73's own preload:** the generic wrapper's preload (`fs.readFile` for non-`'edit'`-category tools, per the fix above) ran *before* any handler body, including `create-file`'s — whose whole point is a path that doesn't exist yet. The preload's `ENOENT` short-circuited the call before `create-file`'s actual `fs.writeFile` logic ever ran. Fixed by adding a `skipFilePreload` cfg flag to `registerMcpTool` (defaults `false`); set `true` on `create-file`'s registration so the wrapper only resolves `ctx.filePath` without attempting to read it.

## 2026-09-16 — Command Output panel stdin: four chained bugs found and fixed (never appeared, focus lost, stale input on timeout)

**Bug fixed — `commandTerminalPanelRef` was never populated on a fresh session, so the Command Output panel could never appear at all:** unlike the chat panel (auto-opened at `activate()` via the `showChatPanel` config), nothing ever called `atom.workspace.open()` for the `command-terminal` URI on a fresh install/session with no saved workspace layout. The `addOpener` callback that sets `commandTerminalPanelRef` only fires in response to that call, and `run-command`'s own logic to open the panel only ran *inside* `if (commandTerminalPanel && showOutput)` — requiring the panel to already exist. This was a chicken-and-egg deadlock: the only code that could create the panel required the panel to already be created.

**Fix:** `pulsar-edit-mcp-server.js` `activate()` now opens the `command-terminal` URI once at startup (`{ activatePane: false, activateItem: false }`), immediately after the chat panel's own auto-open, so `commandTerminalPanelRef` is always populated before any `run-command` call can need it.

**Bug fixed — `enable-group`'s runtime re-registration silently dropped `chatPanel`/`getCommandTerminalPanel`:** the `mcpRegistration()` calls inside the `enable-group` tool handler (used to enable a disabled tool group without a full restart) passed only 4 of the function's 6 parameters, leaving `chatPanel` and `getCommandTerminalPanel` at their `null` defaults for the rest of the session — breaking the panel for every subsequent `run-command` call after any group was enabled at runtime, even though startup registration had wired it correctly.

**Fix:** both `mcpRegistration()` call sites inside `enable-group` (ghidra-group branch and generic single-group branch) now forward `chatPanel, getCommandTerminalPanel` from the enclosing closure.

**Bug fixed — `atom.workspace.open(..., { activatePane: false })` alone doesn't reliably surface a collapsed/hidden dock, and `attachProcess()`'s `.focus()` call raced against the open Promise:** the panel could be created and enabled but never actually visible, or visible without keyboard focus reaching the stdin input.

**Fix:** `run-command`'s panel-open call now chains a `.then()` that explicitly calls `atom.workspace.getBottomDock().show()` and re-focuses `commandTerminalPanel._stdinInput` once the pane item is confirmed open, instead of relying on the synchronous `attachProcess()` focus call alone.

**Bug fixed — stdin left live in the gap between a timeout's `proc.kill()` and the async `close` event:** on timeout, `setTimeout`'s handler called `proc.kill()` but didn't disable the input box until `close` eventually fired asynchronously. A keystroke typed in that window (or already sitting in the box) could be delivered to a stale `_proc` reference or linger and get sent to whatever process `attachProcess()` bound next — confirmed live: text typed against a timed-out `Read-Host` was delivered as stdin to an unrelated second command run moments later.

**Fix:** the timeout handler now calls `commandTerminalPanel.closeStdin()` synchronously (guarded on `commandTerminalPanel._proc === proc`) at the same time it calls `proc.kill()`, so the box is disabled and cleared immediately on timeout rather than waiting on the async exit event.

**Status:** all four fixes applied and restart-verified live — the panel now appears on a fresh session, survives `enable-group` calls, pops into view with focus on every `run-command`, and immediately goes inert (input disabled, buttons grayed, status reads "No command running") the moment a command times out, with no stale keystrokes leaking into the next command.


## 2026-09-15 — B72 followup: `root:<rootName>/<rest>` path prefix fixed (was silently unreachable for every tool)

**Bug fixed — `lib/tool-framework.js` — the generic `registerMcpTool` wrapper bypassed `resolveProjectPath()` entirely, so B72's `root:<rootName>/<rest>` addressing never actually ran for any tool:** B72 added `root:` prefix parsing to `resolveProjectPath()` in `buffer-helpers.js`, wired into `readTextFromFile`/`readFileOrBuffer`. But every tool registered via `registerMcpTool` — including `read-file`, `str_replace`, and the rest of the `filePath`-accepting tools — had its `args.filePath` resolved and loaded directly by the wrapper itself (`path.resolve()` + `atom.project.bufferForPath()`) *before* the tool's own handler body ever executed. This happened unconditionally, so a `root:...` path was handed straight to `bufferForPath`/`fs` as a literal string, producing `EINVAL, open 'root:...'` regardless of what `resolveProjectPath` was capable of — the handler-level code was simply never reached. Confirmed by two independent debug markers (one in `resolveProjectPath` itself, one at the top of `read-file`'s handler) that both failed to fire across multiple full restarts, proving neither `buffer-helpers.js` nor `read-file`'s handler was ever executing on a `root:`-prefixed call.

**Fix:** `tool-framework.js`'s wrapper now calls `resolveProjectPath(args.filePath)` at the top of its `if (args.filePath)` block, before any `bufferForPath`/`fs` access. On failure (e.g. an unknown `root:` name), the clear `resolveProjectPath` error is returned directly instead of falling through to a raw filesystem call on the unresolved string. This makes `root:` addressing — and the existing B62 relative-path-against-project-root fallback — work uniformly across every tool that goes through `registerMcpTool`'s `filePath` handling, not just the read-only tools that happened to call `readTextFromFile` themselves.

**Scope:** applies to every tool with a `filePath` argument (`read-file`, `str_replace`, `insert`, `delete-line-range`, `delete-block`, `replace-function-body`, `replace-block`, `replace-document`, `replace-all`, `sed`, `apply-patch`, `grep-file`, `read-lines`, `get-region`, `get-file-summary`, `get-structural-anchors`, `get-includes-and-defines`, `check-struct`, `namingcheck`, `check-function-docs`, `insert-function-doc`, `file-line-count`, `get-diagnostics`, `close-file`). Tools with no `filePath` param — `get-project-paths`, `add-project-path`, `get-project-files`, `grep-project`/`search-symbol`/`find-text` (project-wide, glob-scoped), `list-project-functions`, `get-repo-map`, `run-command` (uses `cwd`, resolved via a separate `root:`-aware path added in the original B72 commit) — were never in scope for this bug and are unaffected.

**Verified live post-restart:** negative control `read-file` with `root:TotallyBogusRootName/foo.txt` now returns the correct `resolveProjectPath: no open project root named "TotallyBogusRootName"...` error (previously the generic `EINVAL`). Positive case `read-file` with `root:Ghidra-H8-Processor/h8/data/languages/h8539f.slaspec` now correctly resolves and returns the real file content.

## 2026-09-14/15 — B72: `root:<rootName>/<rest>` explicit multi-root addressing added

**Feature — `lib/buffer-helpers.js` `resolveProjectPath()` and `lib/mcp-registration.js` `run-command` — explicit unambiguous path addressing across multiple open Pulsar project roots (B72):** with 3 independent project roots open at once, `resolveProjectPath`'s existing relative-path fallback (B62) tries each root in turn and silently uses the first match — fine for a single-project workspace, ambiguous when the same relative path could plausibly exist under more than one root. Added a `root:<rootFolderName>/<rest>` prefix: `root:Ghidra-H8-Processor/h8/data/languages/h8539f.slaspec` resolves only against the project root whose folder basename matches `Ghidra-H8-Processor`, and throws a clear error naming the known open roots if no match is found — no silent fallback to guessing, since removing ambiguity is the entire point of the prefix. Also wired into `run-command`'s `cwd` handling so a command can be run in an explicit root (e.g. `cwd: "root:ghidra"`) instead of the previous silent default of whichever root was added first. `get-project-paths` returns the list of valid root basenames to address.

**Note:** this feature shipped with a bug that made it silently non-functional for every tool except direct callers of `resolveProjectPath` — see the 2026-09-15 "B72 followup" entry above for the fix.

## 2026-09-12 — B68/B69: `grep-project` memory leak and renderer crash on large unscoped searches fixed

**Bug fixed — `lib/buffer-helpers.js` `readTextFromFile()` — every non-open file touched by a search tool leaked a retained, tree-sitter-parsed buffer (B68):** the read path called `atom.project.bufferForPath()` for any file not already open in a tab, but never released the resulting buffer. `bufferForPath()` registers a live `TextBuffer` (file watcher + grammar/tree-sitter parser) that stays alive indefinitely unless explicitly destroyed. An unscoped `grep-project` across a large project (hundreds of files) leaked one such buffer per file, observed as Pulsar memory climbing to ~7GB and repeated tree-sitter WASM parser crashes (`RuntimeError: Aborted`) even with no tabs open.

**First fix attempted (create-then-destroy) caused a worse problem — a native renderer crash:** checking whether a buffer was already registered, then destroying it immediately after reading, closed the leak (memory confirmed flat post-fix) but introduced a race: the registered-buffer check ran before `bufferForPath` fully resolved, so a concurrent consumer could start using the buffer in that window: `destroy()` then tore it out from under that consumer at the native layer. Confirmed via Windows minidump analysis (`cdb.exe !analyze -v`) as a genuine `INVALID_POINTER_WRITE` access violation inside a native `.node` addon — not a catchable JS exception, so no amount of try/catch around the destroy call could have prevented it.

**Root fix:** stopped creating a buffer at all for files with no already-registered buffer. `readTextFromFile` now checks `atom.project.getBuffers()` for an existing registration *before* deciding how to read: if one exists (a concurrent edit tool, or a buffer open outside any visible tab), it goes through `bufferForPath` as before and leaves it alone; if none exists, it reads the file directly via `fs.promises.readFile()` — no buffer is ever created, so there is nothing to race or destroy. A manual UTF-8 BOM strip was added to match what `bufferForPath`'s `getText()` would have presented, since Pulsar's automatic encoding detection is bypassed on this path. The existing open-tab check (live buffer, unsaved edits included) is untouched and still runs first.

**Verified live post-restart:** an unscoped `grep-project` across the full project (including the largest subtree, hundreds of C++ files) returned 200 matches with memory staying flat (~132MB) and no renderer crash — previously reproduced reliably under the same conditions.

## 2026-09-12 — B57/B58: `str_replace`'s own fuzzyWhitespace/fuzzyContent/regex match paths were excluded from the shared ambiguity guard

**Bug fixed — `lib/mcp-registration.js` `str_replace` handler — the B38 ambiguity guard silently excluded `str_replace`'s own `fuzzyWhitespace`/`fuzzyContent` matching from ambiguity detection (B57):** `str_replace` has its own inline fuzzy-matching branches, separate from `match-engine.js` (which other tools like `insert` use and which already has its own ambiguity guard). Calling `str_replace` with `fuzzyWhitespace:true` or `fuzzyContent:true` against `old_str` text that matched more than once in the file committed silently to whichever match came first, with no warning — the same silent-wrong-location class of bug as the original B38/B41 fixes, just in a code path those fixes didn't reach.

**Fix:** extended the same ambiguity check already used for plain-string matches to also apply when a fuzzy strategy resolves the match, refusing with the same "matches N times ... Found at line(s): ..." message naming every match. A follow-on bug surfaced during this fix's own live testing — a "double-count" false positive that spuriously reported an unambiguous fuzzyContent match as matching twice — was found and fixed in the same session.

**Bug fixed — `str_replace`'s regex mode had no ambiguity guard at all (B58):** the B38 guard was explicitly gated to skip regex mode, with a comment claiming regex already had an equivalent guard elsewhere — true for tools migrated onto `match-engine.js`, but `str_replace`'s own regex branch is not migrated and has no other ambiguity check. Compounding this, the regex-matching loop itself stopped scanning as soon as it found the requested occurrence, so the match count it reported could never exceed 1 even when the pattern matched multiple times later in the file — confirmed live: a regex matching two lines in a fixture silently committed to the first with zero warning.

**Fix:** removed the early-exit from the regex matching loop so it always scans the whole file and records every match, then dropped the regex exclusion from the B38 guard entirely so ambiguous regex matches now refuse exactly like plain-string ones. A same-session follow-on bug (a temporal-dead-zone `ReferenceError` introduced by the fix itself, caught by the first live test after restart, not by `node --check`) was found and fixed before the feature shipped.

**Verified live post-restart**, both fixes, full three-case pattern (ambiguous refuses / unique proceeds / `occurrence:N` disambiguates) against a fixture with two structurally identical function bodies: all cases passed for `fuzzyWhitespace`, `fuzzyContent`, and `regex` modes, closing out the last unaudited match paths in `str_replace` alongside the original B38 plain-string guard.

## 2026-09-12 — B62 (relative-path resolution) and B64 (insert-function-doc disambiguation) fixed

**Bug fixed — `lib/buffer-helpers.js` — relative paths failed in `read-file`/`grep-file`/etc. depending on the MCP host process's `cwd` (B62):** `readTextFromFile()` (backing `read-file`, `grep-file`, `get-repo-map`, `read-lines`, `get-region`, `search-symbol`, `file-line-count`, `list-project-functions`, `get-file-summary`, `get-includes-and-defines`, `get-structural-anchors`, `namingcheck`, `check-function-docs`) and `readFileOrBuffer()` (backing `replace-across-files`'s commit path) both called `fs.existsSync(filePath)` directly with no project-root fallback — a relative path only worked when the host process's `cwd` happened to equal the Pulsar project root, which isn't guaranteed. `get-project-files`, `grep-project`, and `apply-patch` were unaffected (they resolve via `atom.project.getPaths()` or `atom.project`'s own path APIs).

Fix: added `resolveProjectPath(filePath)` — if the raw path doesn't already resolve, tries `path.join(root, filePath)` against every `atom.project.getPaths()` root in turn, returning the first candidate that exists; falls through unchanged (letting the caller's own `existsSync` check fire the normal "File not found" error) if nothing resolves, so behavior for genuinely-missing files is unchanged. Wired into both `readTextFromFile` and `readFileOrBuffer`.

**Verified live post-restart:** `read-file` and `grep-file` with a relative path (`test/b44_structural_anchor_ambiguity_test.c`) that previously threw "File not found" now resolve correctly; a genuinely nonexistent relative path still throws the normal error, confirming the fallback doesn't mask real failures.

**Bug fixed — `lib/mcp-registration.js` — `insert-function-doc`'s `line` param (its own documented way to disambiguate an ambiguous function name) had no effect (B64):** the handler passed the caller's `line` through to `resolveScope()` as `afterLine`, but `resolveScope`'s `inFunction` branch only reads `occurrence` to disambiguate — `afterLine` is never consulted once `inFunction` is resolved. Result: passing `line` to disambiguate a duplicate function name produced the identical ambiguous refusal as passing nothing, and the error message even suggested `occurrence:N`, a parameter this tool doesn't expose.

Fix: resolve `inFunction` first without a line hint; if ambiguous and `line` was given, find whichever candidate match's `startRow` is closest to `line` and retry with that match's index as `occurrence`.

**Follow-on bug found during this fix's own live verification and fixed — `occurrence:1` was indistinguishable from "not specified" (B64 follow-on):** `resolveScope`'s ambiguous branch only honors `occurrence` when `occurrence > 1`, so when the closest candidate was the *first* match (`occurrence:1`), the retry fell through to the same ambiguous error — asymmetric with later matches, which resolved fine. Fixed by bypassing `resolveScope`'s occurrence re-check for that one case and building the scope directly from the chosen match's own `startRow`/`endRow`.

**Verified live post-restart**, fixture `test/b64_dup_function_name_test.c` (two identically-named functions in `#ifdef`/`#else` branches): `line` pointing at the first function now resolves and inserts correctly; `line` pointing at the second function still resolves correctly (regression check); no `line` given still correctly refuses ambiguous, naming both candidates.

`node --check` clean on both files throughout both fixes. All changes independently confirmed persisted to disk (PowerShell `Select-String`/`LastWriteTime`, outside any Pulsar/MCP tool self-report) before each restart+cache-clear, per this project's standing rule for edits to the server's own source.

---

## Decision — T1 (apply-patch replacement) shelved, revised to framework-migration-only (2026-07-20, no code change)

**Investigated and decided against** building a new tool to replace `apply-patch` — neither a `block-edit` tool (Codex-style `*** Begin Patch`) nor a `multi_str_replace` batch-mode extension to `str_replace`. Full investigation, source reading, and reasoning preserved in `test/t1-block-edit-design.md` (marked NOT PURSUED, kept as a record).

What drove it: read Cline's (`replace_in_file.ts`/`diff.ts`) and Aider's (`editblock_coder.py`/`search_replace.py`) actual shipping source rather than working from assumption. Both are structurally just content-anchored search+replace pairs — no independent "block-edit" concept exists in either to model a new tool on. Separately, `LLM-FAILURE-MODES.md`'s Failure Mode 11 had already independently concluded the same root cause (unified diff is position-anchored, 0/40+ hits) but recommends **keeping** apply-patch specifically for human-provided/external diffs (applying a `git diff` the LLM didn't generate itself) rather than retiring it. A batch str_replace mode wouldn't cover that use case at all. Finally, quantified the token-savings case for a batch/multi-edit mode directly against the fault-log/stats evidence base and found it thin: none of the 16 documented failure modes are about round-trip/call-count overhead — all are single-edit reliability issues (matching, drift, ambiguity, scope) — so the case for the new surface area, validation, and semantics (all-or-nothing vs. partial-apply, etc.) that a batch mode would require didn't hold up against the evidence.

**Revised T1 scope:** `apply-patch` keeps its existing unified-diff format and behavior exactly as-is. The only remaining work is migrating its internals onto `resolveScope()`/`matchContent()` (`lib/match-engine.js`) — the same framework migration `insert` already got in T2, and the same one `block-delete` will get in T3 — so it inherits the shared ambiguity guard and `scanForOldStr` diagnostics instead of its old bespoke `findAnchor`-based fuzzy-rescue block. No new tool, no rename, no format change. `mcp-server-refactor-plan.md`'s T1 row and build order updated accordingly.

## v0.21.1 — B38 fixed: str_replace no longer silently resolves ambiguous matches (2026-07-20)

**Bug fixed — `lib/mcp-registration.js` — str_replace silently edited the first match when old_str matched more than once and occurrence wasn't specified (B38):** both occurrence-counting loops in the plain-string match path (multi-line branch and single-line branch, ~lines 526-596) `break`d the instant they hit the requested `occurrence` count (default 1), never scanning the rest of the resolved scope to check for additional matches. The only related check (`occurrence > occurrencesFound`) only fired when the caller explicitly requested an occurrence number higher than what existed — it required `matchIndex === -1`, which was never true in the silent-duplicate case since the first match had already succeeded. Net effect: if `old_str` matched more than once in scope and `occurrence` wasn't given, str_replace edited the first match with zero indication other matches existed — a wrong-location-edit risk, not just a missing diagnostic.

Fix: both loops now scan the entire resolved scope unconditionally, collecting every match's line number into `allOccurrenceLines` while still recording `matchIndex`/`matchLine` only for the requested occurrence. A new guard runs after both loops: `if (!regex && occurrencesFound > 1 && occurrence <= 1)` returns an ambiguous-match error (all matched line numbers, a suggestion to pass `occurrence:N` or add a scope hint, plus the existing `smartSuggestion` footer) instead of proceeding to commit. Mirrors `match-engine.js`'s `matchContent()` ambiguity guard (`hits.length > 1 && occurrence <= 1`) — same threshold, same "default counts as unspecified" semantics. Regex mode is unaffected (guarded by `!regex`; it has its own separate match-counting path untouched by this fix).

**Verified live post-restart (full Pulsar restart + cache clear)** with new fixture `test/b38_ambiguous_match_test.js` (a line duplicated 3× across 3 functions, plus one unique-match line): no-occurrence call against the 3× duplicate correctly blocked with all three line numbers reported (8, 13, 18) and the buffer left untouched; `occurrence:2` correctly committed to only the 2nd match, others unaffected; the unique single-match line committed normally with no added friction from the new guard. `get-diagnostics` (project scope) reports 0 errors/warnings.

---

## v0.21.0 — T2 closed: buildInsertPreview() unifies insert's 3 dryRun preview blocks; housekeeping (2026-07-20)

**Feature — `lib/match-engine.js` — added `buildInsertPreview()`, the last open item under T2:** `insert`'s three content/structural-anchor branches (`afterFunction`/`afterSymbol`/`afterString`/`betweenHint`, `sectionHint`/`preprocBlock`, `afterContent`/`beforeContent`) each hand-rolled an identical context+insert-lines dryRun preview block, differing only in the "where it lands" sentence and a small offset on how far back the "before" context window starts. Collapsed onto one shared builder: `buildInsertPreview({ allLines, lineCount, insertRow, new_str, suffix, radius = 3, beforeOffset = 0 })`. `suffix` carries the per-branch landing-location sentence; `beforeOffset` (0 or 1) reproduces each branch's original context-window math exactly — 0 for the afterFunction/afterSymbol/afterString/betweenHint branch and the `afterContent` case, 1 for the `sectionHint`/`preprocBlock` branch and the `beforeContent` case (both of those have `insertRow` sitting one row past the anchor line that should still show as context). Exported from `match-engine.js` and imported into `mcp-registration.js` alongside the existing `matchContentEngine`/`buildFailResponse` imports. Net: -18 lines across the three call sites, +40 lines shared once — pure dedup, no intended behavior change.

**Verified live post-restart:** created a scratch `.c` file and exercised all three branches with `dryRun:true` — `afterFunction` (beforeOffset 0), `preprocBlock` (beforeOffset 1, using a `#endif /* NAME */`-style named comment per `get-structural-anchors`' actual requirement), `afterContent` (beforeOffset 0), and `beforeContent` (beforeOffset 1) — all four previews rendered correct line numbers, context radius, and footer text, matching pre-refactor output exactly. A real (non-dryRun) `afterFunction` commit was also verified to insert correctly. `node --check` clean on both files throughout; `get-diagnostics` reported 0 errors/warnings. Scratch file removed after.

**T2 ("Invest in insert — full hint system + diagnostics") is now fully closed.** Every row in the str_replace-vs-insert Feature Parity Inventory is `yes` across all branches: match/rescue cascade, `scanForOldStr`, `ambiguityCheck`, `successNudge`, struct-check, and now the shared preview builder. Full audit trail and branch-by-branch progress notes from the migration (afterRow passthrough, afterContent port, afterFunction/sectionHint successNudge+structCheck additions, the `matchContent` shadowing bug found and fixed mid-session) are preserved above in v0.20.0 and below in v0.19.0/v0.17.0 — not repeated here.

**Bug closed, not previously logged — B40, `insert` reported line 1 instead of line 2 for an `afterContent` insert:** investigated during T2 live-testing (2026-07-19). On inspection the source was already correct (`line: insertRow + 1`, and `match.matchEndLine` correctly computed for both single- and multi-line needles) — the discrepancy was the live Pulsar process still running stale compiled code, the same class of issue as the `matchContent` shadowing confusion found the same session. Confirmed via post-restart retest: the same `afterContent` insert correctly reported line 2. No code change. **B40 closed — stale-cache artifact, not a real bug.**

**False positives closed, not previously logged — B42 (`delete-block` apparent hang) and B43 (`close-file` apparent hang):** both tools appeared to hang for 4+ minutes during T2-adjacent testing (2026-07-19), initially treated as potential critical server-side hangs. Root cause was mundane: both tool calls were sitting on pending human approval while the operator was away from the keyboard, indistinguishable from a genuine hang until retested with the operator confirmed present — both then executed instantly and correctly. No code changes made or needed. Lesson recorded: checking whether *other* tool calls still respond only rules out a global lockup, not a single call waiting on approval.

**B24 (universal match engine) — item 8 decision, not previously logged — `betweenHint`/`sectionHint` scope stay as-is:** following item 7's closure (v0.17.0 — both hints already work standalone for `insert`, no gap existed), PJ decided neither hint should be removed or restricted: `betweenHint` has real if narrow use, `sectionHint` is less useful but removing it would leave inconsistent hint sets across tools. If either becomes a real problem later, the fix is the deferred per-tool `SUPPORTED_HINTS` declaration (see plan's FUTURE WORK section) rather than removing the hint. B24 is fully closed as of this decision — only B32 (the deliberately-deferred str_replace-onto-engine port) remains open under that umbrella.

**Housekeeping:** Removed completed items from `mcp-server-refactor-plan.md`: the T2 TODO-table row (superseded by this entry), B24 TODO items 7–8 (superseded by v0.17.0 and this entry), the full "str_replace → insert Feature Parity Inventory" section (superseded by this entry and v0.20.0/v0.19.0/v0.17.0), and the "BUGS FOUND DURING T2 LIVE TESTING" section covering B39–B43 (B39/B41 already logged v0.20.0; B40/B42/B43 logged above for the first time). The `findAnchor` retirement table's completed `insert` row was also dropped, leaving only the two still-open callers (`delete_block` under T3, `apply-patch` under T1). Plan file now retains only open work: B12, B20, B22 (partial), B38 (open, high-priority correctness bug), B32 (open, deliberately deferred str_replace port), the Gap Audit's still-relevant items 1–4, the `findAnchor` retirement tracking for T1/T3, the T1/T3/T4/T5/T6 tool-consolidation roadmap, and the not-yet-designed ideas (universal edit tool, stacking anchors, line-offset modifier, per-tool SUPPORTED_HINTS).

---

## v0.20.0 — T2: insert's afterContent/afterFunction/sectionHint branches migrated onto match-engine; B39 buffer-corruption bug fixed; B41 create-file bug fixed (2026-07-19)

**Feature — `lib/match-engine.js` — `resolveScope()` gained a raw `afterRow` passthrough:** previously `resolveScope()` only resolved scope from named hints (`afterFunction`, `afterString`, `betweenHint`, etc.); callers needing "just start searching from row N" (no named hint) had no way to ask for that. Added `afterRow` as a first-priority param — when given, returns `{ searchStart: afterRow, searchEnd: allLines.length - 1, anchorRow: afterRow, via: 'afterRow' }` directly, clamped to valid bounds, taking priority over any named hint passed alongside it. Distinct from the existing `afterLine` hint (a user-facing hint windowed to ±radius around a line number) — this is an internal, unwindowed scope override. Verified with a standalone script: `afterRow` beats a named hint when both given, clamps correctly past EOF, and the no-hint baseline is unchanged. This unblocks T1 (apply-patch) and T3 (delete_block) migrating off `findAnchor` in the future, per `mcp-server-refactor-plan.md`'s retirement-criterion section — not used by any caller yet.

**Feature — `lib/mcp-registration.js` — `insert`'s `afterContent`/`beforeContent` branch migrated off `findAnchor()` onto `resolveScope()`/`matchContent()`/`buildFailResponse()` (T2):** this was the last `insert` branch still calling `findAnchor()` directly. Now inherits, for free: the 5-tier match/rescue cascade (exact→trim→unicode-norm, trailing-comment-strip rescue, full-buffer drift rescue, encoding-vs-whitespace diagnosis, fuzzy cold-failure locator), `scanForOldStr` diagnostics, `ambiguityCheck` (via `matchContent`'s built-in multi-hit guard), and on the success path, `successNudge` and struct-check (`preEditSnapshot`/`postEditDelta`) — none of which this branch had before. Live-tested: exact match, dryRun (buffer correctly untouched), ambiguity detection (correctly blocks and reports all match lines), `occurrence:N` resolving an ambiguous match, `beforeContent` (unaffected by the below bug since `insertAfter` is false), `endOfFile`/`startOfFile` regression-checked alongside.

**Feature — `afterFunction`/`beforeFunction`/`afterSymbol`/`beforeSymbol`/`afterString`/`beforeString`/`betweenHint` branch and `sectionHint`/`preprocBlock` branch — added `successNudge` and struct-check to the success path:** these branches already used `resolveScope()`/`buildFailResponse()` on the failure path from earlier work, but were missing `successNudge`/struct-check (`preEditSnapshot`/`postEditDelta`) on success — the last two rows of the str_replace-vs-insert feature-parity table. Added, plus `hintsSucceeded.*` stat tracking (previously only `hintsUsed.*` was tracked, not which hints led to a successful commit). Live-tested: `afterFunction`, `sectionHint`, and `preprocBlock` (after fixing the test fixture to use a `#endif // MACRO`-style named comment, which is what `preprocBlock` actually requires — confirmed via `get-structural-anchors`, not a bug) all commit correctly.

**Bug found and fixed during implementation — `matchContent` naming collision silently broke the new afterContent branch:** `insert`'s handler already destructures a tool parameter literally named `matchContent` (pre-existing — lets a caller verify `onLine:N`'s content before inserting). Importing the engine's `matchContent` function under the same name meant the parameter shadowed the import for the whole handler scope, so the new branch was silently calling `undefined` instead of the engine function. Fixed by aliasing the import: `const { resolveScope, matchContent: matchContentEngine, buildFailResponse } = require('./match-engine')`, with the one call site updated to `matchContentEngine(...)`. The `onLine`+`matchContent` parameter itself is untouched and still works exactly as before — confirmed via regression test (`onLine:1` + `matchContent:'#include <stdio.h>'`, both matching and mismatching, both behaved correctly).

**Bug found, root-caused, and fixed — general buffer corruption on line-count-changing edits (B39), CRITICAL:** discovered while live-testing the above — an `insert` (any branch) immediately followed by a `str_replace` targeting content after the insertion point corrupted the buffer (merged lines, stray leftover characters). Further isolation showed this is **not insert-specific at all** — plain `str_replace` → `str_replace` reproduces it too, with the precise trigger being: edit #1 changes the buffer's total line count, edit #2 immediately targets content whose row shifted as a result. Root-caused to `str_replace`'s commit path (`mcp-registration.js` ~L1146-1151): `matchIndex` (a character offset found by searching an earlier-captured `text` string) was converted to a row/col `Position` via `buffer.positionForCharacterIndex(matchIndex)` against the **live** buffer, with no check that the live buffer still matched the `text` snapshot `matchIndex` was found against — a stale offset silently resolves to the wrong position if the two have drifted. **Fixed:** added a drift check immediately before commit — if the live buffer's text no longer matches the snapshot, relocate `effectiveOldStr` fresh (searching near the original offset first, then anywhere in the file); if relocation isn't possible, refuse the edit with a clear error rather than risk corrupting an unrelated line. **Verified live post-restart:** the exact original corruption repro (2-line-adding str_replace immediately followed by str_replace on the shifted content) now produces correct content; the non-drifted case (same-line edit immediately followed by another same-line edit) still works unchanged, confirming no regression in the common path.

**Bug found and fixed — `create-file` intermittently returned success with an empty buffer (B41):** observed twice — `create-file` with a non-empty `content` param reported success but the resulting editor buffer was empty. Leading hypothesis (not fully confirmed): `atom.workspace.open(filePath)` can return an existing, stale/empty buffer for a path rather than one reflecting the just-written disk content. **Fixed** defensively regardless of the exact cause: after opening, if `editor.getText() !== content`, force it with `editor.setText(content)` — guarantees the tool's own success claim can't be wrong about what ends up in the buffer. **Verified live post-restart:** 3 consecutive `create-file` calls with distinct paths/content, each checked via `get-document`/`read-lines` immediately after — all correct.

**False positives investigated and closed — B42/B43, `delete_block` and `close-file` "hangs":** both tools appeared to hang for 4+ minutes during testing. Initially treated as critical server-side hangs (a `delete_block` repro with `startContent`/`endContent`/`occurrence` was reproduced twice with 0 hits recorded server-side). Root cause turned out to be mundane: the tool calls were sitting on pending human approval while the operator was away from the keyboard, indistinguishable from a real hang until retested with the operator confirmed present — both tools then executed instantly and correctly on retry. No code changes made or needed; recorded in `mcp-server-refactor-plan.md` as a lesson on distinguishing approval-wait from actual unresponsiveness (checking whether *other* tool calls still respond only rules out a *global* lockup, not a single pending approval).

**Not done this session, left for follow-up (see `mcp-server-refactor-plan.md` for full detail):** T1 (`apply-patch`) and T3 (`delete_block`'s `startContent`/`endContent` pair) still call `findAnchor()` directly and have not been migrated onto `match-engine.js` — the `afterRow` passthrough added above exists to support that future work but isn't used yet. The 3 dryRun preview blocks across `insert`'s branches remain hand-rolled, not yet unified into one shared preview builder. `apply-patch`, `sed`, `replace-all`, `replace-across-files`, checkpoint/restore, and undo/redo were not exercised this session.

`node --check` clean on `mcp-registration.js` and `match-engine.js` throughout. All fixes verified against live behavior post-restart, not just statically.

---

## v0.19.0 — B37: insert positional hints split into afterLine/beforeLine/onLine, insert_line removed (2026-07-19)

**Feature — `lib/mcp-registration.js` — `insert`'s ambiguous `insert_line:N` replaced with three directional params (B37):** `insert_line:N` had no direction word, so callers naturally assumed the number was the target line, but the actual behavior was "insert AFTER line N" — a silent off-by-one mismatch. Replaced with: `afterLine:N` (insert after line N, new content becomes line N+1 — identical to `insert_line`'s old behavior); `onLine:N` (new content becomes line N itself, pushing the old line N and everything below it down by one); `beforeLine:N` (new content becomes line N-1, one line before N — equivalent to `onLine:N-1`). All three resolve through one shared row-normalization block feeding the existing range-check/dryRun/commit path, rather than three duplicated handlers.

**Feature — `onLine` + `matchContent` verification:** `onLine:N` accepts an optional `matchContent:'expected text'` — if given, the current content of line N is checked before inserting; on mismatch the call fails loudly with the actual line content instead of silently inserting in the wrong place. Wired through the existing `logHintFailure`/`smartSuggestion` machinery (reason: `hintFault:onLine:contentMismatch`), consistent with B20's disambiguated-fault-reason work.

**Bug fixed during implementation — `beforeLine` initially shared `onLine`'s row math:** first pass incorrectly resolved `beforeLine:N` to the same row as `onLine:N` (both `N-1`). Corrected: `beforeLine:N` resolves to row `N-2` (0-based), placing new content one full line before N, not on N. Added a guard for `beforeLine:1` (which would resolve before row 0) — fails cleanly with a message pointing to `startOfFile:true` or `onLine:1` instead of crashing.

**Design change from original B37 plan — `insert_line` removed entirely, not kept as a deprecated alias (decided by PJ):** the original design kept `insert_line` working as a silent alias for `afterLine` so existing callers wouldn't break. Superseded by an explicit decision to remove it outright — `insert_line` is no longer in `insert`'s `inputSchema`; calling it now falls through to the "no anchor provided" error (rejected at the schema level via `additionalProperties: false` before reaching the handler). All description text, code comments, and the "no anchor provided" error message updated to drop every `insert_line` reference.

**`positionalHintName` now reflects the actual param used:** `ctx.commit()`'s drift-nudge (B21/B22) previously hardcoded `positionalHintName: 'insert_line'` for this code path. Now passes whichever of `afterLine`/`onLine`/`beforeLine` was actually supplied, so the nudge correctly names the hint that drifted.

**Live-tested post-restart (2026-07-19):** `afterLine:12`, `onLine:12`, and `beforeLine:12` on `test/test.c` all produced the correct resulting line layout (verified by direct read-lines inspection after a real, non-dry-run commit). `beforeLine:1` correctly rejected instead of crashing. `onLine` + wrong `matchContent` correctly failed with the actual line content shown. `onLine` + correct `matchContent` proceeded normally. Calling `insert_line` post-restart correctly falls through to the "no anchor provided" error — confirmed it's no longer accepted at the schema level, not just undocumented.

`node --check` clean on `mcp-registration.js` throughout.

---



**Feature — `lib/search-engine.js` (new file):** Read-side counterpart to `match-engine.js` (B24) — `find-text`, `grep-file`, and `grep-project` had each independently reimplemented the same ~35-line pattern-compile + line-scan + context/occurrence/truncation loop (the exact "only str-replace got investment" pattern the T1–T6 tool-consolidation section already documents, just not previously written up on the search side). Extracted once as `compilePattern({query, regex, caseSensitive})` and `scanLines(lines, pattern, opts)`. Zero Atom dependencies, same discipline as `recover.js` — the engine only scans an array of strings; callers own how they get `lines` (live buffer / single file / walked project files), stats bumping, response envelope shape, and stale-file tracking. Closes the loop identified in conversation, not from a pre-existing TODO row.

**Feature — previously-missing grep semantics added, verified against the GNU grep manual (not against GPL source — see rationale below):** `scanLines()` supports `before`/`after` (asymmetric context, real `-A`/`-B` semantics — the tools previously only had symmetric `contextLines`/`-C`), `invertMatch` (`-v`), `onlyMatching` (`-o`), `countOnly` (`-c`), and `stopAtFirst` (cheap existence check, backing `grep-project`'s new `filesWithMatches`/`-l`). A generic `filter(text, i)` hook was added specifically so `search-symbol`'s `definitionsOnly` — a secondary predicate on top of its word-boundary match — could use the shared loop too, without the engine needing any concept of what a "definition" looks like.

**Licensing note:** GNU grep's actual C source (`src/grep.c`) was deliberately not read or copied from — it's GPL-3.0, and copying real code into this package would pull GPL terms onto that file. Its README also explains it hand-rolls a DFA + Boyer-Moore matcher because C has no built-in regex engine; that specific problem doesn't apply here since V8's `RegExp` already does equivalent optimization, so there was no algorithmic core worth porting regardless. Only documented *option semantics* were used, sourced from the GNU grep manual and man7.org.

**Wiring — all four call sites in `lib/mcp-registration.js` migrated, not just the engine file added:** `find-text` (line ~1210), `grep-file` (~3673), `grep-project` (~3749), and `search-symbol` (~5107) all now call `compilePattern()`/`scanLines()` instead of their private loops. This was necessary, not optional — a shared engine file that nothing calls has no effect; `search-engine.js` on its own does not change tool behavior until each tool's handler is rewritten to use it, the same way `match-engine.js` sat with only `insert` wired onto it for several versions (see v0.15.5/v0.16.0 entries below) before other tools adopted it. `grep-project` and `search-symbol` needed extra care since they loop across multiple files but still need one *global* `occurrence`/`maxMatches` budget — each per-file `scanLines()` call now gets a shrinking `maxMatches` (`maxMatches - matches.length so far`) and a recalculated `occurrence` target (`occurrence - globalIndex so far`), so cross-file Nth-match and result-capping behave identically to the old single-array implementation.

**Verified:** `get-diagnostics` clean (0 errors/warnings) on both `search-engine.js` and `mcp-registration.js` after every edit. Not yet live-tested post-restart — this touches `mcp-registration.js`, so per existing policy (see v0.16.0 entry below) it needs the full babel-cache-clear + Pulsar restart before any of the four tools' new options actually take effect; hot-reload-on-save does not apply to `registerTool`/schema changes in that file.

---

## v0.17.0 — B21 drift-warning generalized, T5 startOfFile added, B36 fixed, B37 designed (2026-07-19)

**Bug fixed — `lib/tool-hints.js` — `successNudge()`'s positional drift warning was hardcoded to `afterLine`, so `insert`'s `insert_line` never got it (B21):** Case 1 of `successNudge()` only fired on an `afterLineOnly` boolean and always said "afterLine is positional…", regardless of which positional hint was actually used. Generalized to a `positionalHintName` field so the message names whichever hint applies. `lib/tool-framework.js`'s `ctx.commit()` now forwards `positionalHintName` from `nudgeCtx` (kept `afterLineOnly` for back-compat). `insert`'s `insert_line` commit call now passes `positionalHintName: 'insert_line'`, so it gets the same targeted, low-threshold (100+ line) warning `afterLine` already had, instead of only qualifying for the generic, higher-threshold (300+ line) "no hints used" message that didn't call out drift by name. Deprecating `insert_line` outright remains an open, low-urgency question — not decided, superseded by B37's design below.

**Feature — `lib/mcp-registration.js` — added `startOfFile:true` to `insert`, symmetric with `endOfFile` (T5):** `endOfFile` already existed; `startOfFile` was missing. Both are dynamic (resolved at call time to the file's actual current first/last line), so unlike `insert_line` neither is a stale positional number and neither can drift. Repositioned both as option (0) in the tool description, explicitly called out as not-positional, ahead of the content-anchor options and clearly distinct from `insert_line`'s last-resort caution (option 7).

**Bug fixed — `lib/tree-sitter-symbols.js` — regex symbol fallback treated markdown code-fence content as real symbols (B36):** `getSymbolsFromText()` fell through to an "unknown extension — try both" branch for any non-C/non-JS `filePath` (e.g. `.md`), running `JS_FN_RE`/`C_FN_RE` against every line including fenced-code-block content — so a doc's own illustrative JS snippets (e.g. `const scope = resolveScope(...)`) got returned as fake symbols, silently defeating B30/B31's `symbols.length === 0` empty-symbol-table gate. Fixed with an early `if (!isC && !isJs) return [];` right after computing the extension flags; removed the now-unreachable "unknown extension — try both" branch. Verified via `get-diagnostics` — 0 errors/warnings.

**Design only, not yet built — `insert` — replace ambiguous `insert_line` with `afterLine`/`beforeLine`/`onLine` (B37):** Raised and refined in conversation: `insert_line:N` has no direction word, so LLMs naturally assume the number IS the target line, but the actual behavior is "insert AFTER line N" — a silent off-by-one mismatch. There's also no way to verify a line's content before trusting its number (`afterString`/`beforeString` match content with no number; `insert_line` uses a number with zero verification). Agreed design: `afterLine:N` (insert after, today's behavior), `beforeLine:N` (insert before, the missing case), `onLine:N` + optional `matchContent:'...'` (new content becomes line N, verified against expected content if given, failing loudly on mismatch instead of silently inserting wrong). `insert_line` would remain as a deprecated alias for `afterLine`, not removed outright. See `mcp-server-refactor-plan.md` B37 for the full writeup — not implemented yet.

**Closed, re-verified against code — B24 (universal match engine) item 7 was not actually a gap:** The plan's claim that `betweenHint`/`sectionHint` don't work as standalone anchors for `insert` was checked directly against the handler and found incorrect — both already resolve fine alone (`betweenHint` via the main anchor block's `resolveScope()`, `sectionHint` via its own `resolveStructuralAnchor()` block), and the tool description/error message already list both correctly. No code or doc change was needed. B24 is now fully closed; only B32 (the deliberately-deferred str_replace port) remains as follow-on work under that umbrella.

---

## v0.16.0 — B26/B28/B35 finalized + live-tested, B32 re-audit, match-engine.js hot-reload policy decided (2026-07-19)

**Bug fixed — `lib/edit-response.js` — most edit tools never called `buffer.save()` (B26):** Only `ctx.commit()` (2 call sites) saved to disk; the other 16+ handlers using `buildEditResponse()` directly wrote to the in-memory buffer and returned success without saving. Fix: `buildEditResponse()` now takes an optional `buffer` in `meta` and awaits `buffer.save()` itself before building the response, with save failures surfaced (icon downgrades ✅→⚠️, explicit "SAVE FAILED" message) instead of silently swallowed. Live-tested across headless (`bufferForPath`) and open-tab edit paths — confirmed synchronous, confirmed disk content matches via independent `Get-Content` reads.

**Feature — read-side staleness detection completed (B28):** Edit-side disk-vs-buffer drift warnings existed already; the read half is now wired into `readTextFromFile()` (returns `{ text, staleWarning }`) and a new `lib/read-response.js` (`buildSearchResponse()` — deliberately separate from the edit-shaped `buildEditResponse()`, no save/icon/line-delta logic). All 14 read call sites updated (`get-region`, `read-file`, `get-file-summary`, `grep-file`, `read-lines`, `get-structural-anchors`, `file-line-count`, `namingcheck`, `check-function-docs`, etc.), plus multi-file scanners (`grep-project`, `search-symbol`, `replace-across-files`) via a `staleFiles` array. Live-tested end-to-end: first-touch silent seed, stale warning on external change, warning clears after being shown once, plain-text and multi-file paths all confirmed.

**Bug fixed, then superseded upstream — `lib/lint-helpers.js` — lint reported messages for the wrong file (B35):** `lintSnapshot()` queried `linter-bundle`'s `GetLinterMessages` in `"file"` viewMode, which reports whatever tab is UI-focused — completely independent of which file the edit tool actually targeted. An edit to an unfocused or never-opened file could return another open file's lint messages. Interim fix used `viewMode:"project"` + client-side path filtering. **Superseded 2026-07-19:** filed upstream bug report got `linter-bundle` fixed directly (now v2.6.0, adds a `filePath` filter to `GetLinterMessages.execute()`); `lintSnapshot()` refactored to call it directly, removing ~15 lines of workaround. Live-tested: zero cross-file leakage, correct messages when targeting the right file.

**Re-audit — B32 (match-engine vs str_replace feature parity):** All five originally-identified gaps (successNudge wiring, autoPartialMatch rescue, autoStripComment rescue, combined single-pass transform diagnosis, struct-check gating) confirmed closed in code via `lib/recover.js` and `tool-framework.js`'s declarative `features.*` gates. Only the str_replace-onto-match-engine port itself remains open — deliberately deferred given the tool's hit count and battle-tested status; will be tackled as its own careful, tested change, not opportunistically.

**Decision — `lib/match-engine.js` hot-reload behavior:** Previously logged as "unconfirmed" after several fixes needed a full restart to take effect. Closed as a non-issue rather than root-caused further: `match-engine.js` is now simply treated the same as `mcp-registration.js` — always clear the babel cache and do a full Pulsar restart for any change to this file, no reliance on hot-reload.

**Housekeeping:** Removed completed items from `mcp-server-refactor-plan.md` (B25–B35, FILE_SCHEMA migration note, functionEnd removal history, multi-line anchor fix, list-open-files field removal) — all now captured here or in earlier changelog entries. Plan file retains only open items: the B32 str_replace port, the betweenHint/sectionHint scope-only documentation gap, B20/B21/B22 (partial), B24 (engine still being built out), the T1–T6 tool consolidation roadmap, and not-yet-designed ideas (universal edit tool, stacking anchors, line-offset modifier).

---

## v0.15.5 — B31-B34: successNudge/struct-check declarative gating, lib/recover.js extraction (2026-07-17)


**Bug fixed — `lib/tool-hints.js` — `successNudge()` recommended symbol-based anchors (`inFunction`/`afterFunction`/`afterSymbol`) even on files with no parseable symbol table (B31):** The "no scoping hints used on a large file" success-path nudge always suggested `inFunction`/`afterString`/`betweenHint` regardless of file type. On a file tree-sitter can't parse (`.txt`, or any unsupported extension), `inFunction` et al. can never resolve — the suggestion was dead advice. `successNudge()` now accepts an optional `symbols` array in its `ctx`; when `symbols.length === 0`, it states plainly that the file has no parseable symbol table and recommends only `afterString`/`beforeString`, building a concrete example anchor from `matchedLineContent` when available.

**Bug fixed — `lib/mcp-registration.js` — `delete-line-range`'s hand-rolled drift nudge had the same B31 symptom (B32):** Its inline `_driftNudge` unconditionally suggested `inFunction` for any positional delete, same root cause as B31 but undocumented until an audit of `match-engine.js` against `str_replace`'s actual handler code (not just prior documentation of it) turned it up. Fixed with the same empty-symbols check, lazily fetching `getSymbols()` only when the delete is positional to avoid the tree-sitter parse cost otherwise.

**Bug fixed — `lib/mcp-registration.js` — regression introduced while fixing the above, caught same session:** the `delete-line-range` fix accidentally dropped the `const _isPositional = _resolvedVia === ...` declaration line while keeping two usages of it. Passed `node --check` (syntactically valid — a runtime-only scope error) but threw `_isPositional is not defined` on the first live call post-restart. Fixed by restoring the declaration. Caught only by a live-test pass, not by static checks — recorded in the refactor plan as a standing lesson: `node --check` does not catch scope/reference errors from a careless multi-part edit.

**Feature — `lib/recover.js` (new file):** Extracted `str_replace`'s two hand-rolled rescue mechanisms into a standalone, tool-agnostic module — zero Atom dependencies. `profileNeedle()`/`profiledMatch()` do single-pass combined-transform diagnosis: classify whitespace/encoding/trailing-comment mismatches together and retry once with a needle combining whichever transforms are needed, catching mixed-issue lines (e.g. indent + smart-quote on the same line) that a strict sequential waterfall tries independently and can miss. `partialMatchRescue()` does a full-buffer drift rescue: searches outside the resolved scope for the needle's leading lines when the in-scope search finds nothing, rescuing the case where a prior edit shifted the target region. `str_replace`'s own inline implementation is unchanged by this — the module exists for `match-engine.js` and future tools ported onto it.

**Feature — `lib/match-engine.js` — `recover.js` wired into `matchContent()` via a new `autoRescue` opt (default `true`):** after the existing exact→fuzzyWhitespace→fuzzyContent waterfall, `matchContent()` now automatically tries the combined-diagnosis rescue (stays in-scope) and, for multi-line needles, the full-buffer partial-match rescue (early-returns — operates outside the scope-relative `hits[]`/`pick` math the rest of the function uses). `autoRescue:false` opts out for strict/predictable-only matching. Note: `matchContent()`/`buildMatchResponse()` are not yet called by any tool in production — `insert` (the only tool on `match-engine.js` so far) only uses `resolveScope()`/`buildFailResponse()` — so this fix is structurally complete but unexercised until a future tool (T1-T6's `block-edit`/`block-delete`, or an eventual `str_replace` port) actually calls it.

**Feature — `lib/tool-framework.js` — declarative `features.successNudge` and `features.structCheck` gating added to `ctx.commit()`:** mirrors the existing `features.lint`/`features.styleCheck` pattern exactly. A tool opts in with one config line instead of hand-rolling its own duplicate nudge/struct-check logic — the root cause of the B31/B32 divergence in the first place. `features.successNudge:true` plus a handler-supplied `meta.nudgeCtx: { noHintsUsed, afterLineOnly, matchedLineContent, oldStr, isCodeFile, symbols? }` computes the `nudge` warning slot via `successNudge()`, lazily fetching `symbols` only when `noHintsUsed` is true. `features.structCheck:true` computes the `struct` warning slot via `struct-check.js`'s `snapshot()`/`delta()`, gated on (1) `ctx.snapshotOriginal()` having been called before the write (reuses the existing decoration-support snapshot rather than requiring a second one) and (2) the new `isStructFileType(filePath)` export, so non-code files like `.txt` are excluded automatically — and the check only ever runs for tools that explicitly opt in.

**Feature — `lib/struct-check.js` — `isStructFileType(filePath)` added:** exports the file-extension gate (previously an inline-only regex duplicated inside `edit-response.js`'s `preEditSnapshot()`) as a reusable helper, single source of truth for the new `ctx.commit()` call site. `edit-response.js`'s own existing inline copy is left untouched — working code, no reason to touch it.

**Change — `lib/mcp-registration.js` — `insert`'s `insert_line` (legacy positional) path migrated onto the new gating:** added `successNudge: true` and `structCheck: true` to `insert`'s `features`. `insert_line`'s previous hand-rolled `_driftNudge` (B21 — always correctly suggested `afterString`, never actually had the B31 symptom) replaced with a `ctx.commit()` call carrying `nudgeCtx`. Added `ctx.snapshotOriginal()` before the write so `structCheck` has a pre-edit baseline. Trade-off: the old nudge's dynamic "line numbers have shifted by +N lines" sentence is dropped, since `successNudge()` doesn't carry that context — the core actionable advice (positional, switch to `afterString`) is preserved and now also gets B31's empty-symbol-table awareness. `insert`'s other four success paths (`endOfFile`, `betweenHint`, `sectionHint`/`preprocBlock`, content-anchor) were deliberately left untouched — they always have a hint present, so the new gating would produce nothing for them regardless, and converting them offered no behaviour change for real regression risk on a live, heavily-used tool.

**Live-verified (2026-07-17, post-restart):** `insert`'s `insert_line` nudge correctly omits `inFunction`/`afterFunction`/`afterSymbol` on a `.txt` file and suggests `afterString` using the real matched line as an example; `delete-line-range` positional correctly omits `inFunction` on the same `.txt` and correctly keeps it on a `.js` file with real symbols; struct-check correctly warns on an unbalanced-brace insert into a `.js` file, stays silent on a balanced insert, and stays silent on a `.txt` file regardless of brace content.

**Discovered, not yet fixed — logged as B35 in the refactor plan:** an unrelated `lint` warning citing JavaScript-specific ESLint rules (`no-unreachable`, `no-constant-condition`) fired on a `.txt` file during the struct-check live test, from a call that never requested linting. Not caused by anything in this entry — logged separately for follow-up, not yet root-caused.

`node --check` clean on `tool-framework.js`, `struct-check.js`, `match-engine.js`, `recover.js`, `mcp-registration.js`. `recover.js` and `struct-check.js`'s new `isStructFileType()` export were both smoke-tested standalone via `node -e require(...)` (zero Atom dependencies, safe outside Pulsar).

---

## v0.15.4 — B25: multi-line afterString/beforeString anchors, full diagnostic parity (2026-06-20)

**Feature — `lib/tree-sitter-symbols.js` — `resolveMultiLineStringPosition()` added:** `resolveStringPosition` previously scanned single lines only (`allLines[i].includes(text)`), so any multi-line `afterString`/`beforeString` (containing `\n`) could never match — always `notFound`, silently. `resolveStringPosition` now detects `text.includes('\n')` and delegates to the new `resolveMultiLineStringPosition()`, which scans for N consecutive `allLines` entries matching the split anchor text — exact match first, falling back to trim-fuzzy (handles indentation drift between lines) if no exact block is found. Returns the same `{ anchorRow, startRow, endRow }` shape (plus `multiLine: true` / `viaTrim`) so all callers work unchanged.

**Docs — `lib/schema.js` — `ANCHOR_SCHEMA` comments updated:** `afterString`/`beforeString` field comments now state multi-line text is supported as a consecutive-line block match but should be used only when no single line is unique enough — prefer a single unique line for reliability.

**Improvement — `lib/mcp-registration.js` — multi-line match tip added to `notFound` diagnostics on all 5 `afterString`/`beforeString` call sites:** Previously only `str_replace` told the LLM when its anchor had matched (or failed) as a multi-line block. The same `r.multiLine`-driven tip — *"matched as a multi-line block (N lines) — prefer a SINGLE unique line for reliability"* — has been added to the `notFound` failure path of `insert`, `delete-line-range`, `replace-block`, and `replace-function-body`, bringing all 5 tools that use `afterString`/`beforeString` to parity.

**Root cause / history:** Live incident this session — an LLM session passed a 3-line `afterString`, got a bare `notFound`, and escalated to a PowerShell workaround instead of recognising the anchor itself was malformed for the (then-broken) matcher. Tracked as bug B25 in the refactor plan. The core feature fix and schema doc update were completed in an earlier session; this entry finishes the diagnostic-message parity across all five tools.

`node --check` + `eslint@8` clean (0 errors, 0 warnings) on `mcp-registration.js`, `tree-sitter-symbols.js`, `schema.js`.

---

## v0.15.3 — insert_line convention fix (2026-06-18)

**Bug fixed — `lib/mcp-registration.js` — `insert_line:N` was inserting BEFORE line N, not after:** Standard editor convention (Cline, Claude Code, VS Code) is that inserting at line N places new content after line N, pushing subsequent lines down. The insert handler was using `row = insert_line - 1` which inserted before the target line — off by one from what any LLM familiar with other tools would expect.

Fix: changed `row` from `insert_line - 1` to `insert_line`. New content now appears after line N. Also updated the dryRun context slices and the dryRun message ("before line N" → "after line N"). Description updated to explicitly state "inserts AFTER line N, matching standard editor convention".

---

## v0.15.2 — str_replace failure messages: full scan diagnostics (2026-06-18)

**Improvement — `lib/mcp-registration.js` — str_replace fail path now scans full file and reports all match locations (B22 partial):**

Previously the `scanForOldStr` block only ran when a scope hint was active (`_hasScope`), only reported hits outside the active scope, silently discarded `hitsInsideScope`, and had a broken `=== null` check that never fired for "not found anywhere" (zero-hit results return `{ total: 0 }`, not `null`).

Three new diagnostic messages now appear in every str_replace failure:

- `❌ NOT FOUND ANYWHERE` — fires when `old_str` has zero hits anywhere in the file (`_fullScan.total === 0`). Names the active hint (`afterLine:40`, `afterString:"foo"`, `inFunction:"bar"`, etc.) so the LLM knows both the hint and the `old_str` need verifying. Always runs regardless of whether a scope hint was active.

- `🔍 MATCH LOCATION FOUND inside scope at L<n>` — fires when the exact text of `old_str` is present inside the hint window but the commit failed due to whitespace mismatch or partial match. Previously these hits were found and discarded silently. Now the LLM gets the exact line number and function context so it can re-read that area and fix `old_str` directly.

- `🚨 FOUND OUTSIDE SCOPE` — existing message, now also names the active hint in parentheses (e.g. `hint: inFunction:"test_smart_quotes"`).

- No-scope-hint path added: when no hint is set and `old_str` fails, all hits across the file are listed with line numbers and function context so the LLM can identify which occurrence to target and add an appropriate scope hint.

**Improvement — `lib/mcp-registration.js` — `afterLine`/`beforeLine` drift nudge fires on all failure types (B22):**

Previously the drift nudge (suggesting `afterString` as a drift-immune alternative) was guarded by `wsIssues.length === 0 && partialMatchLines === 0` — it was suppressed when the failure involved a whitespace mismatch or partial match. The guard is removed. The nudge now fires whenever a positional line hint was active, regardless of failure type. Message also improved: `"use afterString:'...' instead of afterLine"` rather than the passive `"next time use afterString"`.

**Improvement — `lib/tool-hints.js` — `successNudge` Case 1 wording sharpened:**

On a successful `str_replace` that used only `afterLine` (no content-stable hint), the upgrade suggestion changed from `"Next time use afterString:… — it's content-stable"` to `"Switch to afterString:… — that anchor is content-stable and will find the right location even after edits."` Removes passive framing; reads as an immediate actionable correction.

---

## v0.15.1 — Hint failures now visible in fault log (2026-06-18)

**Bug fixed — `lib/mcp-registration.js` — hint failures not logged to fault log (B18 + B19):** All hint early-return paths in `str_replace` (12 sites) and `insert` (8 sites) bumped stats counters but never called `logFailure`. The fault log only ever received `noMatch`/`whitespace`/`partialMatch` entries — content failures. All hint resolution failures (`afterString` not found, `inFunction` not found/ambiguous/needsTreeSitter, `betweenHint` start/end not found, `afterFunction`/`beforeFunction`/`afterSymbol`/`beforeSymbol` not found/ambiguous, `afterContent`/`beforeContent` not found/ambiguous, `functionEnd` not found) were completely invisible and uninspectable.

Fix: added `logHintFailure()` module-level helper that wraps `logFailure` with a structured `reason` field: `"hintFault:<hintName>:<variant>"` (e.g. `hintFault:afterString:notFound`, `hintFault:inFunction:ambiguous`). Also records `hintValue` (the failing anchor string, truncated to 80 chars) and `oldStrPreview`. Wired at all 20 sites across both tools. The `sectionHint`/`preprocBlock` structural anchor path in `insert` already had `logFailure` — left untouched.

The fault log `reason` field now takes one of two forms: content failures (`noMatch`, `whitespace`, `partialMatch`, `encoding`) or hint failures (`hintFault:<hintName>:<variant>`). Both the list view Reason column and the detail view in the Fault Log panel now show the distinction clearly.

---

## v0.15.0 — filePath routing, focus toggle, critical bump fix, lint cleanup (2026-06-18)

**Bug fixed — `lib/tool-framework.js` — `bump` missing from deps destructure (critical):** `bump` was passed to `makeRegisterMcpTool()` in `mcp-registration.js` but was never destructured from `deps` in `tool-framework.js`. Every `ctx.fail()`, `ctx.commit()`, and `ctx.dryRunReturn()` call threw `ReferenceError: bump is not defined` at runtime, meaning stats were never bumped, `onCommit` never fired, and `lastEditedFilePath` was never set. All framework-routed tools were silently broken for stats tracking.

**Bug fixed — `lib/pulsar-edit-mcp-server.js` — `loadMcpModules` only cache-busted `mcp-registration.js`:** `tool-framework.js` and `schema.js` were not invalidated on hot-reload, so changes to either file were silently ignored until a full Pulsar window reload. Now all three are busted via a `bust()` helper before re-requiring.

**Bug fixed — `lib/buffer-helpers.js` — `readTextFromFile` `fs.readFileSync` fallback removed:** The fallback bypassed Pulsar's encoding detection and could return BOM-prefixed text (`\uFEFF`). `bufferForPath` is reliable and handles encoding correctly; if it throws, the error now surfaces visibly rather than falling back silently to a raw disk read.

**Bug fixed — `lib/mcp-registration.js` — 14 `no-undef` lint warnings:** `replace-block`, `replace-function-body`, `delete-line-range`, and `delete-block` handler destructures were missing newer hint names added to `ANCHOR_SCHEMA`: `afterFunction`, `beforeFunction`, `afterSymbol`, `beforeSymbol`, `beforeString`, `afterLine`, `beforeLine`. All four updated to match full hint set.

**Bug fixed — lint cleanup across project:** `chat-functions.js` — `eslint-disable-next-line` on intentional `while(true)` SSE loop. Both spec files — `eslint-env jasmine` + `global waitsForPromise` + unused imports prefixed `_`. `pulsar-edit-mcp-server.js` — unused `tools` var renamed `_tools`.

**Feature — `lib/schema.js` — `filePath` added to `ANCHOR_SCHEMA`:** All edit tools that spread `ANCHOR_SCHEMA` now accept an optional `filePath` parameter. The framework resolves the buffer by path rather than using the active tab for writes.

**Feature — `lib/tool-framework.js` — buffer-by-path acquisition:** Editor acquisition block rewritten with three priority paths: (1) `args.filePath` + file open in tab → use existing `TextEditor` buffer directly; (2) `args.filePath` + file not open → `atom.project.bufferForPath()` — no tab created, full undo and save support, no focus change ever; (3) no `filePath` + `requiresEditor` → active tab (read/nav/cursor tools only). Active tab is now never used for writes. Added `ctx.filePath` to ctx object.

**Feature — focus edited file toggle:** Post-commit, if the edited file is open in a tab and `pulsar-edit-mcp-server.focusEditedFile` config is `true`, the tab is brought to front via `activateItem`. Closed files (edited via `bufferForPath`) never trigger a focus change regardless of toggle state. Config key added to `package.json` configSchema (boolean, default `true`, order 6). `Packages → MCP Server → Toggle Focus Edited File` command reads/writes the config and shows a notification. `onCommit` callback now fires for both open-tab and bufferForPath edits (previously only fired when `editor` was non-null).

**Feature — `Packages → MCP Server → Show Last Edited File`:** After any successful commit, `lastEditedFilePath` is set via `onCommit`. The menu command calls `atom.workspace.open(filePath, { activateItem: true, searchAllPanes: true })` to bring that file to front on demand. Shows an info notification if no file has been edited yet this session.

---

## v0.14.4 — Bug fixes: stats, logging, disposable leaks, duplicate detection (2026-06-17)

**Bug fixed — `lib/edit-stats.js` — silent catch in `appendSessionHistory` / `logFailure` (B1):** Both `catch (_) {}` blocks were empty, making disk-full or permission errors completely invisible. Both now log `console.warn('[edit-stats] X failed:', e.message)`.

**Bug fixed — `lib/edit-stats.js` — redundant stats writes on shutdown (B2):** `process.on('exit')`, `SIGTERM`, and `SIGHUP` each duplicated the `syncToLifetime()` + `writeFileSync` inline, meaning up to 3 writes on graceful shutdown. Extracted into a single `_flushSync()` helper (with its own `console.warn` on error) called by all three handlers.

**Bug fixed — `lib/tree-sitter-symbols.js` — silent catch in `getSymbolsFromEditor` (B8):** Top-level `try/catch` returned `[]` with no logging on any error, making grammar load failures and tree-sitter API breakage invisible. Now logs `console.warn('[tree-sitter-symbols] getSymbolsFromEditor failed:', ...)` before returning `[]`.

**Bug fixed — `lib/tool-framework.js` — no duplicate tool name detection (B7):** `server.registerTool` with a duplicate name silently overwrote the previous registration. Added a `_registeredNames` Set inside `makeRegisterMcpTool`; any duplicate now logs `console.warn('[tool-framework] duplicate tool name "X" — previous registration will be overwritten')`.

**Bug fixed — `lib/chat-panel.js` — `atom.commands.add` disposable not tracked (B5):** Return value of `atom.commands.add(this.element, {...})` was never stored or disposed, causing commands to persist after the panel was destroyed. Now stored as `this._commandsDisposable` and disposed in `destroy()`.

**Bug fixed — `lib/chat-panel.js` — `atom.contextMenu.add` accumulates on every panel instantiation (B4):** Return value of `atom.contextMenu.add(...)` was never stored or disposed, causing context-menu entries to stack up on every open/close cycle. Now stored as `this._contextMenuDisposable` and disposed in `destroy()`.

**Feature — `lib/edit-stats.js` + `mcp-registration.js` — fuzzy trigger detail in stats (#4):** Added `fuzzyTriggerReasons: { needsWhitespace, needsContent, needsComment, partial }` to `str_replace` stats. Each flag is bumped when the auto-retry diagnosis fires for that reason. Surfaced in `get-edit-stats` via `TOOL_REGISTRY compute()` (suppressed when all zero).

**Feature — `lib/edit-stats.js` + `mcp-registration.js` — hint performance tracking + fault classification (#5a):** Added `hintsSucceeded` and `hintsFailed` objects (parallel to `hintsUsed`) to `str_replace` stats, bumped at commit and noMatch respectively for each active hint. Added `faultBuckets: { contentFaults, hintFaults }` — `contentFaults` when old_str is genuinely absent, `hintFaults` alongside every `outOfScope`/`afterNotFound`/`wrongOccurrence`. `get-edit-stats` now exposes `hintSuccessRate: { [hint]: { ok, fail, pct } }` for any hint that has been used.

---

## v0.14.3 — Auto-save on edit commit (2026-06-16)

**Feature — `lib/tool-framework.js` — auto-save on `ctx.commit()` (#20):** Added `if (buffer) await buffer.save()` inside `ctx.commit()`, after `decorateEditedLines` and before the hit counter bump. Every tool that goes through the framework now saves the file automatically on a successful edit — no more manual `save-file` calls needed after edits. Framework version bumped to v1.1 in header comment.

---

## v0.14.2 — Bug fixes: stats, str_replace, grep_project, named capture groups (2026-06-16)

**Bug fixed — `lib/edit-stats.js` — nearLine hint silently dropped:** `READ_LINES_HINT_KEYS` was missing the `nearLine` key, so `read-lines` handler's `bump('nearLine')` call hit no slot and was silently discarded. Fix: added `READ_LINES_HINT_KEYS = { ...FULL_HINT_KEYS, nearLine: 0 }` and wired it into the `read_lines` editStats block. (#22 side-effect fix)

**Bug fixed — `lib/mcp-registration.js` — `afterLineOnly` hardcoded `false` in `successNudge` (#23):** Case 1 of `successNudge` (the "you used only a line-number hint" nudge) could never fire because `afterLineOnly` was always `false`. Fixed to compute from actual hint params.

**Bug fixed — `lib/edit-stats.js` + `mcp-registration.js` — stale `get_linter_messages` counter (#24):** Dead counter block and `TOOL_REGISTRY` entry for the old `get_linter_messages` tool removed from both files.

**Bug fixed — `lib/mcp-registration.js` — `_hasScope` TDZ crash on `tool-catalogue.js` hot-reload (#26):** `const _hasScope` was declared at ~L971 inside the `str_replace` handler body but used at ~L895 (the `noMatch` path). `const` puts the binding in TDZ for the entire enclosing block, so any `noMatch` execution crashed with "Cannot access '_hasScope' before initialization". This also caused `str_replace` to abort writes to `tool-catalogue.js` on every hot-reload. Fix: moved `_hasScope` declaration to top of handler (after `_radius`). `str_replace` on `tool-catalogue.js` now works correctly.

**Bug fixed — `lib/string-utils.js` + `.mcp-ignore` + `lib/buffer-helpers.js` — `grep_project` broken on all globbed searches (#28):** Three fixes: (1) `globToRegex` built `^(pattern)$` — the `^` anchor means it only matches strings that start with the pattern, but `walkDir` returns absolute paths like `C:\Users\...\lib\foo.js`, so `^lib/*.js` never matched. Fix: removed `^`, now suffix-match `(pattern)$`. (2) `node_modules/` was absent from `.mcp-ignore`, causing unglobbed searches to walk 5000+ files. (3) `readTextFromFile` hardened with `fs.readFileSync` fallback if `bufferForPath` throws.

**Feature — `lib/string-utils.js` + `mcp-registration.js` + `tool-catalogue.js` — named capture groups `$<name>` in replace tools (#10):** `applyReplacement` now accepts a 6th `namedGroups` argument. Regex extended to handle `$<name>` syntax. Four call sites in `mcp-registration.js` updated to extract and pass `namedGroups`. `replace-all` and `replace-across-files` descriptions in `tool-catalogue.js` updated to document `$<name>` syntax.

**Docs — `lib/tool-catalogue.js` — string anchors for unstructured files (#15):** `str_replace` description updated to include a worked example of `afterString:'## Installation'` and `betweenHint:{start:'## Config',end:'## Usage'}` for markdown/config files. Matches the example already in the `insert` description.

**Milestone — Tool Framework migration fully complete (all tools):** All deferred tools confirmed migrated by code inspection: `run-command` (L2496), `replace-across-files` (L2722), `get-repo-map` (L5060), and all 6 Ghidra tools (L5337–L5531). No bare `server.registerTool` call sites remain for tool handlers. The deferred tool migrations section has been removed from the refactor plan.

 Added `SESSION_HISTORY_PATH` and `appendSessionHistory(entry)` to `edit-stats.js`. Called at both `get-edit-stats reset:true` sites (inline handler + `resetEditStats()`). `getEditStats()` reads the last 5 lines of `session-history.ndjson` and returns them as `recentSessions`. Schema: `{ts, session, edits, hits, faults, misses, hitRate, searches, searchHits}`.

---

## v0.14.1 — Fix grep-project 0-match race on large closed files (2026-06-16)

**Bug fixed — `lib/buffer-helpers.js`:** `readFileOrBuffer()` used `atom.workspace.open(filePath, { activateItem: false })` as its fallback for closed files. On large files (~6600+ lines) this had a race condition where `getText()` returned empty or partial text because the buffer wasn't fully populated when the promise resolved. This caused `grep-project` (and all other read-only tools) to return 0 matches on `mcp-registration.js` and any other large closed file. Also opened a hidden Pulsar tab for every file scanned, polluting the workspace.

**Fix:** Added `readTextFromFile()` — a new read-only helper that uses `await atom.project.bufferForPath(filePath)` for closed files. `bufferForPath()` resolves only when the buffer is fully loaded, uses Pulsar's encoding detection (no `\uFFFD` mojibake), and creates no pane item. All 14 read-only call sites in `mcp-registration.js` (`grep-file`, `grep-project`, `read-file`, `read-lines`, `get-region`, `search-symbol`, `file-line-count`, `get-repo-map`, `get-function-body`, `add-comment`, `list-project-functions`, and others) switched to `readTextFromFile()`. The write-path call in `replace-across-files` (commit step) retains `atom.workspace.open()` — it needs a real pane item for undo history and checkpoint support. `readFileOrBuffer()` kept in exports for write-path callers.

---

## v0.14.0 — Tool Framework Phase 4f–4g complete: full migration (2026-06-12)

**Change — Tool Framework Phase 4f (`lib/mcp-registration.js`):** 4 debugging-group tools migrated to `registerMcpTool({ category:'command', requiresEditor:false, group:'debugging' })`: `get-debug-log`, `get-failure-log`, `get-edit-stats`, `session-notes`. `loadNotes()` helper lifted out of old `{ const curTool }` scope to `if(g('debugging'))` outer scope (same pattern as `findCompiler()` in 4d). All `dbg(curTool,...)` calls replaced with string literals.

**Change — Tool Framework Phase 4g (`lib/mcp-registration.js`):** 5 kernelC-group tools migrated to `registerMcpTool({ category:'command', group:'kernelC' })`: `checkpatch` (requiresEditor:false), `check-struct` (requiresEditor:false), `namingcheck` (requiresEditor:false), `check-function-docs` (requiresEditor:false), `insert-function-doc` (requiresEditor:true). `curStats = editStats[curTool] || ...` inline init patterns updated to use string literals. `bump(curTool, "hits")` in check-struct updated to `bump("check-struct", "hits")`.

**Milestone — Tool Framework migration complete:** All non-deferred tools now on `registerMcpTool()`. Remaining SKIP/DEFER tools: `run-command`, `replace-across-files`, `get-repo-map`, 6× Ghidra tools (deferred indefinitely per refactor plan).

## v0.13.0 — Tool Framework Phase 4a–4e: remaining tool migrations (2026-06-12)

**Change — Tool Framework Phase 4a (`lib/mcp-registration.js`):** 6 fileOps file-management tools migrated to `registerMcpTool({ category:'command', requiresEditor:false })`: `create-file`, `move-file`, `copy-file`, `rename-file`, `create-folder`, `rename-folder`. Thin wrappers with no stats bumping — `console.log(CMD)` lines dropped (framework handles logging).

**Change — Tool Framework Phase 4b (`lib/mcp-registration.js`):** 4 edit-group tools migrated: `delete-line` (deprecated wrapper), `get-selection`, `get-region`, `get-structural-anchors`. `get-region` and `get-structural-anchors` used `delete-line-range` + `insert` pattern due to deep nesting (8-space indent inside outer `{ const curTool }` block made `str_replace` fuzzyWhitespace unreliable on 90+ line handlers).

**Change — Tool Framework Phase 4c (`lib/mcp-registration.js`):** 4 safety-group tools migrated to `registerMcpTool({ category:'command' })`: `diff-preview`, `checkpoint`, `restore-checkpoint` (`requiresEditor:true`), `list-checkpoints` (`requiresEditor:false`). No stats bumping — command category thin wrappers.

**Change — Tool Framework Phase 4d (`lib/mcp-registration.js`):** 2 diagnostics-group tools migrated: `get-compiler-diagnostics`, `get-diagnostics`. `get-compiler-diagnostics` had three helper functions (`findCompiler`, `buildCmd`, `parseLine`) and two regexes (`gccRe`, `msvcRe`) nested inside the old `{ const curTool }` scope block — these were lifted out and dedented one level into the `if (g('diagnostics'))` block scope, where the handler can still close over them. `get-diagnostics` retains its direct `bump('get_linter_messages', 'hits')` calls — correct, as these are named stat keys not `ctx.commit()` paths. Both `requiresEditor:false`.

**Change — Tool Framework Phase 4e (`lib/mcp-registration.js`):** 3 tools migrated: `highlight-range` (`group:'highlight'`, `requiresEditor:true`), `list-tools` (`group:'core'`, `requiresEditor:false`), `enable-group` (`group:'core'`, `requiresEditor:false`). `list-tools` and `enable-group` were always-on discovery tools with no `if (g(...))` guard — they register in sequence without a group gate and use `group:'core'` matching the tool catalogue.

## v0.13.0 — Tool Framework Phase 3+4 complete: all search/nav tools migrated, legacy aliases removed (2026-06-12)

**Change — Tool Framework Phase 3 (`lib/mcp-registration.js`):** All search and nav tools migrated from bare `server.registerTool()` to `registerMcpTool()`. Search tools migrated: `grep-file`, `grep-project`, `search-symbol`, `find-text`. Nav tools migrated: `get-document`, `get-line-count`, `get-filename`, `get-full-path`, `get-project-files`, `open-file`, `goto-line`, `list-open-files`, `get-active-editor-info`, `close-file`, `goto-focus`, `get-project-paths`, `add-project-path`, `undo`, `redo`, `read-file`, `save-file`, `save-all`, `get-file-summary`, `get-includes-and-defines`, `list-project-functions`, `read-lines`, `file-line-count`. Total `registerMcpTool()` call count: 38. `get-repo-map` deferred (complex handler). Ghidra tools left as-is (minimal boilerplate).

**Change — Tool Framework Phase 4 cleanup (`lib/mcp-registration.js`):** All 7 legacy per-tool consecutive failure counter alias declarations removed: `strReplFailures`, `insertFailures`, `deleteFailures`, `deleteBlockFailures`, `replaceBlockFailures`, `sedFailures`, `patchFailures`. All usages replaced with `ctx.consec` directly (`ctx.consec.count++`, `counter: ctx.consec`, `ctx.consec.count = 0`). Return object keys standardised from `xxxFailures: alias.count` to `consecFailures: ctx.consec.count`. Counter ownership now fully consolidated in `tool-framework.js` `consecCounters` map.

**Change — `lib/buffer-helpers.js` (v0.12.0 carry-forward):** `readFileOrBuffer` fallback now uses `atom.workspace.open(filePath, { activateItem: false })` instead of `fs.promises.readFile` — Pulsar's encoding-aware buffer is always used, fixing silent `grep-file` misses on files with non-ASCII content.

## v0.12.0 — UTF-8 clean + grep always uses live buffer (2026-06-12)

**Bug fixed — `mcp-registration.js` mojibake:** 194 `\uFFFD` replacement characters remained in inline comments throughout `mcp-registration.js` — all were em-dashes (`—`) that survived previous partial repairs. Replaced all 194 with U+2014 directly on disk via a one-line Node script. File is now fully clean UTF-8. All other `lib/*.js` files were already clean (0 `\uFFFD`).

**Bug fixed — `readFileOrBuffer` encoding mismatch (`lib/buffer-helpers.js`):** When a file was not already open in Pulsar, `readFileOrBuffer` fell back to `fs.promises.readFile(path, "utf8")`. Node's UTF-8 decoder replaces invalid byte sequences with `\uFFFD`, so any file with residual cp1252 bytes on disk would cause `grep-file` queries containing Unicode chars (arrows, em-dashes) to silently return no matches even when the content was visually present. Fix: replaced the `fs.promises.readFile` fallback with `atom.workspace.open(filePath, { activateItem: false, searchAllPanes: true })` — Pulsar's own encoding detection is used, producing a buffer that exactly matches what an already-open editor returns. `activateItem: false` means the file opens silently without switching focus.


## v0.11.9 — Tool Framework Phase 2 complete: all edit tools migrated (2026-06-12)

**Change — `lib/tool-framework.js` + `lib/mcp-registration.js`:** All 8 main edit tools now registered via `registerMcpTool()` instead of bare `server.registerTool()`. Migrated in sessions 40–47: `str_replace`, `insert`, `delete-line-range`, `delete-block`, `replace-function-body`, `replace-block`, `sed`, `apply-patch`. Each handler receives a `ctx` object with `editor`, `buffer`, `allLines`, `text`, `ctx.consec` (consecutive failure counter), `ctx.fail()`, `ctx.commit()`, `ctx.dryRunReturn()`, and `ctx.snapshotOriginal()` — eliminating per-tool boilerplate for editor acquisition, stats bumping, and failure counter management.

**Change — `apply-patch` group corrected:** `apply-patch` was incorrectly placed in the `fileOps` toggle group. Moved to `edit` group in both `mcp-registration.js` (`if (g('edit'))` guard) and `lib/tool-catalogue.js`. It is an edit tool — it modifies buffer content — and should be enabled/disabled with the other edit tools.

**Removed from module scope:** Per-tool failure counter objects (`strReplFailures`, `insertFailures`, `deleteFailures`, `replaceBlockFailures`, `patchFailures`, `sedFailures`) no longer declared at module scope in `mcp-registration.js`. All are now managed internally by the framework's `consecCounters` map.

## v0.11.8 — .mcp-ignore: periodic rescan via onDidChangePaths (2026-06-11)

**Bug fixed:** `.mcp-ignore` rules only took effect if the ignore list was populated at server startup. If the user added rules to `.mcp-ignore` after startup, or switched to a different project root (File → Add/Remove Folder), the ignore state would not update.

**Root cause:** `reloadMcpIgnore()` was called once on `require` in `mcp-ignore.js`. The `fs.watch` watcher was set up on the project root at that moment. If `atom.project.getPaths()` returned `[]` at require-time (before Pulsar fully activates), the watcher was attached to `process.cwd()` instead of the real project root, so changes to `.mcp-ignore` were never seen. Even when the project root was correct, switching roots left the old watcher in place.

**Change — `lib/mcp-ignore.js`:** Added `initMcpIgnore()` export. Calls `reloadMcpIgnore()` immediately (with the now-correct project root), then subscribes to `atom.project.onDidChangePaths` so any future root change triggers a fresh reload. Returns a `Disposable` for cleanup.

**Change — `lib/mcp-registration.js`:** Destructures `initMcpIgnore` from `./mcp-ignore`. Calls `packageDisposables.add(initMcpIgnore())` immediately after `packageDisposables` is created — at this point `mcp-registration.js` is loaded via `restartServer()` which is deferred to `onDidActivateInitialPackages`, so `atom.project` is fully ready.


## v0.11.7 — .mcp-ignore: wire _checkIgnored into registerTool wrapper (2026-06-11)

**Change — `lib/mcp-registration.js`:** `_checkIgnored()` was defined but never called. Added a `EDIT_TOOL_NAMES` Set (built once from `TOOL_CATALOGUE.filter(t => t.group === 'edit')`) inside `mcpRegistration()`. The `server.registerTool` wrapper now checks `EDIT_TOOL_NAMES.has(name)` and calls `_checkIgnored(atom.workspace.getActiveTextEditor())` before invoking the handler — a single guard covering all edit-group tools. Unused `reloadMcpIgnore` and `getMcpIgnoreInfo` imports renamed to `_reloadMcpIgnore` / `_getMcpIgnoreInfo` to satisfy ESLint no-unused-vars.

**Complete `.mcp-ignore` coverage (three locations):**
1. `buffer-helpers.js` `walkDir()` — filters ignored files/dirs from directory traversal (grep-project, get-repo-map, replace-across-files).
2. `buffer-helpers.js` `readFileOrBuffer()` — throws on ignored paths for all read tools that call it.
3. `mcp-registration.js` `server.registerTool` wrapper — blocks all edit-group tool handlers when the active editor's file is ignored.

## v0.11.5 — run-command focus restore: await before resolve (2026-06-11)

**Bug fixed:** `run-command` reported the tool result before the active tab restore had actually completed. `atom.workspace.open()` is async — calling it fire-and-forget then immediately calling `resolve()` meant the tab switch raced the tool return and lost. In practice the previously active tab appeared unchanged (still the default) rather than being visibly restored.

**Change — `lib/mcp-registration.js`:** `resolve()` is now called inside `focusPromise.then()` instead of after it. `focusPromise` is either the `atom.workspace.open()` promise (with `.catch(()=>{})`) or `Promise.resolve()` when no active path was captured. This guarantees the tab has switched before the tool returns.

## v0.11.6 — remove filePath from insert-function-doc (2026-06-11)

**Change — `lib/mcp-registration.js`:** `insert-function-doc` no longer accepts a `filePath` parameter. All edit tools now require `open-file` first to set the active editor — passing a path to an edit tool was a false affordance that silently hit the wrong file when the target wasn't active. Description updated to say "Use open-file to switch to the target file before calling this tool." Handler simplified to always use `atom.workspace.getActiveTextEditor()`.

 — run-command restores active editor focus (2026-06-11)

**Change — `lib/mcp-registration.js`:** `run-command` pre-flight now captures the active editor path (`activeEditorPath`) alongside `openEditors`. After the post-execution reload loop completes, `atom.workspace.open(activeEditorPath, { activateItem: true, searchAllPanes: true })` is called (fire-and-forget, errors ignored) to restore the tab that had focus before the command ran. Prevents the active editor shifting to whichever reloaded file was processed last.

## v0.11.3 — BUG-B fix: autoStripComment short-needle guard (2026-06-11)

**Bug fixed:** `autoStripComment` could silently commit to the wrong line when stripping a trailing comment left a needle too short to be a reliable anchor inside the hint window (e.g. a single token or empty last line). The fuzzy trimmed-line search would then match the wrong occurrence and commit with a `/* CHECK: ... */` marker at the wrong location.

**Change — `lib/mcp-registration.js`:** Added minimum-length guard before the `autoStripComment` fuzzy search. If `strippedLast` has fewer than 8 non-whitespace chars, or the full stripped needle fewer than 10, the rescue is skipped and falls through to normal failure reporting. Named constants `STRIP_MIN_LAST = 8` and `STRIP_MIN_TOTAL = 10` inline.

## v0.11.2 — BUG-A fix: ambiguityCheck scope awareness (2026-06-11)

**Bug fixed:** `fuzzyContent:true` combined with `inFunction` (or any non-`functionHint` scope hint) triggered a false ambiguity error because `ambiguityCheck` was scanning the full buffer and `noScopeHint` did not include `inFunction`, `inSymbol`, `lineContentHint`, `afterFunction`, `beforeFunction`, `afterSymbol`, `beforeSymbol`, `afterString`, `beforeString`, `afterLine`, or `beforeLine`.

**Changes:**
- `lib/tool-hints.js` — `ambiguityCheck` accepts optional `scopedText` parameter; when provided, occurrence counting runs on the scoped region only (with line numbers reported relative to the full buffer for LLM readability). JSDoc updated.
- `lib/mcp-registration.js` — `ambiguityCheck` call: `noScopeHint` replaced with `_hasScope` flag that covers all 12 scoping hints + `occurrence > 1`. `scopedText` passed as `text.substring(searchStart, searchEnd)` when the region has been narrowed. `successNudge` call: `noHintsUsed` and `lineNumberHintOnly` likewise updated to cover the full hint set.


**New tools:**
- `get-failure-log` (debugging group) — query `failure-log.ndjson` directly from the LLM. Args: `tail` (default 20, max 200), `tool`, `reason`, `filePath` filters. Returns structured JSON. Complements `get-edit-stats` with per-failure detail. Added to `tool-catalogue.js`.

**Fault log viewer UI (`pulsar-edit-mcp-server.js`):**
- New `showFaultLog()` modal command (**Packages → MCP Server → Show Fault Log...**): reads `failure-log.ndjson`, shows newest-first table with `#`, Time, Tool (cyan), Reason (amber), File, Line, Detail columns. Live filter inputs for tool / reason / file substring. Count badge `X / Y entries` updates with filter. 🗑 Clear Log button with confirm prompt.
- Row click opens a detail overlay (absolutely-positioned inside the modal element — not a second modal panel). Shows all fields in a grid: `bufferPreview` dark-green, `diffVsBuffer` dark-red, `oldStrPreview` dark-amber monospace blocks. Raw JSON pre block at bottom. `← Back to list` button removes the overlay without closing the parent.

**`run-command` pre-flight + post-execution (`mcp-registration.js`):**
- Pre-flight: snapshots all open editor buffers as checkpoints keyed `_run-command-<ts>:<path>`. Saves all modified buffers to disk. Records mtimes of all open files.
- Post-execution: compares mtimes after process close; reloads any externally-modified files into buffers via `setTextViaDiff`. Result includes `preFlightCheckpoint`, `savedBeforeRun[]`, `reloadedAfterRun[]`.

**`logFailure` context improvements (`mcp-registration.js`):**
- `str_replace` noMatch/whitespace: `bufferPreview` ±5 lines around hint row, `oldStrPreview` first 6 lines formatted `[1]: ...\n[2]: ...`.
- `insert` anchorNotFound: `oldStrPreview` = full anchor string, `bufferPreview` = first 15 lines of function scope, `scopeLines` = range description.
- `replace-block` anchorNotFound: `oldStrPreview` = full anchor, `bufferPreview` = 15 lines from `searchStartRow`.
- `replace-function-body` notFound: `oldStrPreview` = fn name, `availableFunctions` = first 20 function names, `closestMatches` = near-miss names.

**Other:**
- `open-file` divergence warning added then removed — the post-execution buffer reload in `run-command` is the correct architectural answer (see refactor plan).
- `replace-across-files` closed-file handling: closed files now opened via `atom.workspace.open(filePath, {activateItem:false})` before `setTextViaDiff`. Full undo history on all affected files; no direct `fs.promises.writeFile` for content edits.
- `str_replace` similarity fix: closest-region and Levenshtein similarity score now always run on noMatch (was previously gated inside `if (fuzzyRow >= 0)` — dead code on single-line failures and pure noMatch cases).

## v0.11.0 — Library extraction refactor (2026-06-10)

`mcp-registration.js` has been refactored from a single ~8007-line monolith into a set of focused shared libraries. All code moves are pure extractions — no behaviour changes.

**Extracted libraries (new files):**
- `lib/edit-stats.js` (~800 lines) — session/lifetime stats, `bump()`, `bumpStyle()`, `flushLifetimeStats()`, `syncToLifetime()`, `summarise()`, `buildReport()`, `buildStyleReport()`. Also holds `process.on` exit hooks.
- `lib/tool-hints.js` (247 lines) — `anchorError()`, `smartSuggestion()`, `successNudge()`, `ambiguityCheck()`, consecutive failure counter objects.
- `lib/buffer-helpers.js` (265 lines) — `walkDir()`, `resolveStructuralAnchor()`, `findAnchor()`, `findFunctionInBuffer()`, `readFileOrBuffer()`, `retargetEditor()`.
- `lib/lint-helpers.js` (74 lines) — `maybeLintSuffix()`, `lintSnapshot()`.
- `lib/tool-catalogue.js` (94 lines) — `TOOL_CATALOGUE` array, `TOGGLEABLE_GROUPS` array.
- `lib/schema.js` (48 lines) — `ANCHOR_SCHEMA`, `STRUCTURAL_ANCHOR_SCHEMA` Zod schemas.

**Result:** `mcp-registration.js` reduced from **8007 → 6693 lines** (−1314 lines, −16%).

- Chat panel tool result handling fix (`chat-functions.js`): `addToolResultToHistory()` was calling `JSON.stringify(toolResult.content)` where `content` is already a `[{type,text}]` array — the model received raw JSON envelope strings instead of plain text and stopped using tools. Fixed to `content.map(c => c.text ?? '').join('\n')`. Added `isError` handling: prefixes `[tool error]` when `toolResult.isError` is true. Error text now also surfaced in chat display via `updateChatHistory`.

**Other changes in v0.11.0:**
- `grep-file` bug fix: no-match path was missing its `return` statement, causing "Tool execution failed" instead of `{ matchCount: 0 }`. Return envelope fix also required (raw objects silently dropped by MCP SDK).
- `ANCHOR_SCHEMA` expanded with full v0.10.29 hint set: `inFunction`, `inSymbol`, `afterFunction`, `beforeFunction`, `afterSymbol`, `beforeSymbol`, `afterString`, `beforeString`, `afterLine`, `beforeLine`, `lineContentHint`. All tools using `...ANCHOR_SCHEMA` spread pick up the new hints automatically.
- Stats UI improvements: `hintsUsed` init block updated with all new hint keys; `buildReport()` now groups tools logically (edit / search / nav / RE / shell); per-tool `pct` (hit%) added to every edit and search tool; group summary objects (`_editGroup`, `_searchGroup`, etc.) added.
- Stats panel renderer (`pulsar-edit-mcp-server.js`) updated: rescue counters (`fuzzyContent`, `autoStripComment`, `autoPartialMatch`, `rescued`) now visible; `get_structural_anchors` moved from Edit to Search group; search group badge correctly shows misses+faults.
- `resetLifetimeStats()` function added and exposed; "Reset Lifetime" button added to stats panel.
- Near-miss rescue counters: `autoPartialMatchCommits` separated from `fuzzyWhitespaceCommits`; `apply_patch.rescuedCommits` now tracked.
- Redundant post-`buildReport` ghidra/run_command injection removed from `getEditStats()` handler (now data-driven inside `buildReport()`).

## Files

- `lib/mcp-registration.js` — **~6693 lines.** Full Pulsar restart + babel cache clear required for registerTool/schema changes. Handler body changes hot-reload on save.
- `lib/edit-stats.js` — Stats counters, `bump()`, `summarise()`, `buildReport()`, `buildStyleReport()`, process exit hooks. Hot-reloads on save.
- `lib/tool-hints.js` — `anchorError()`, `smartSuggestion()`, `successNudge()`, `ambiguityCheck()`, consecutive failure counters. Hot-reloads on save.
- `lib/buffer-helpers.js` — Buffer/file utility functions: `walkDir()`, `resolveStructuralAnchor()`, `findAnchor()`, `findFunctionInBuffer()`, `readFileOrBuffer()`, `retargetEditor()`. Hot-reloads on save.
- `lib/lint-helpers.js` — `maybeLintSuffix()`, `lintSnapshot()`. Hot-reloads on save.
- `lib/tool-catalogue.js` — `TOOL_CATALOGUE` and `TOGGLEABLE_GROUPS` static data. Hot-reloads on save.
- `lib/schema.js` — `ANCHOR_SCHEMA`, `STRUCTURAL_ANCHOR_SCHEMA` Zod schemas. Hot-reloads on save.
- `lib/edit-response.js` — `buildEditResponse()`, `preEditSnapshot()`, `postEditDelta()`. Hot-reloads on save.
- `lib/struct-check.js` — `snapshot()`, `delta()`, `isStructFileType()` for structural integrity checks. Consumed by `str_replace` directly and, since v0.15.5, by `ctx.commit()`'s `features.structCheck` gating in `tool-framework.js`. Hot-reloads on save.
- `lib/recover.js` — (new in v0.15.5) `profileNeedle()`/`profiledMatch()`/`partialMatchRescue()` — combined-transform diagnosis and full-buffer drift rescue, extracted from `str_replace`'s inline implementation. Zero Atom dependencies. Consumed by `match-engine.js`'s `matchContent()`. Hot-reloads on save.
- `lib/style-checker.js` — Kernel C style rules, `applyStyleCheck()`, `isKernelFile()`. Hot-reloads on save.
- `lib/naming-checker.js` — `checkNaming()`, `checkFunctionDocs()`, `buildDocSkeleton()`. Hot-reloads on save.
- `lib/tree-sitter-symbols.js` — Tree-sitter symbol extraction + anchor resolution. Hot-reloads on save.
- `lib/string-utils.js` — Pure utilities: `escapeRegex`, `applyReplacement`, `globToRegex`, `levenshteinDistance`, `calculateSimilarity`. Hot-reloads on save.
- `lib/pulsar-edit-mcp-server.js` — Main UI/activation file. Requires Pulsar reload for most changes.
- `lib/chat-panel.js` — Chat panel UI. Requires Pulsar reload (no hot-reload).
- `styles/pulsar-edit-mcp-server.less` — Stylesheet. Hot-reloads on save.

---

## TODO — Priority Order

| # | Priority | Item | Notes |
|---|---|---|---|
| 1 | 🏗️ LARGE | Tool Framework `lib/tool-framework.js` | Next major item. See full design below. |
| 2 | 📋 LARGE | Tool Framework — per-tool feature plan | Before/during framework build: document each tool's features as a checklist so nothing gets lost in the migration. Tick off as each is ported. See note below. |
| 3 | 📁 MEDIUM | File context staleness warning | Buffer version tracking. See design below. |
| 4 | 🖼️ MEDIUM-HIGH | Visual diff decorations (Cursor-parity) | Inline editor green/red decorations. See design below. |
| 5 | 📊 MEDIUM | Show diff faults in stats like window | Idea: surface diff-fault breakdown in `get-edit-stats` the same way the hint window shows — e.g. per-rule fault counts rendered as a mini table/window. Needs design. |
| 6 | 🔍 MEDIUM | Capture fuzzy trigger detail in edit stats | When a fuzzy auto-retry fires (fuzzyWhitespace, fuzzyContent, autoPartialMatch), capture *what* caused it — the diffVsBuffer or a short "reason token" — so `get-edit-stats` can show "autoFuzzyWhitespace x3: trailing space on line N" rather than just a count. Helps distinguish real encoding mismatches from stale old_str. |
| 7 | 🔤 LOW-MEDIUM | Case-insensitive fuzzy matching in str_replace | When str_replace noMatch, optionally retry with case-folded comparison. Use case: LLM sends wrong capitalisation (e.g. `Const` vs `const`). Would be a 5th auto-retry block after partialMatch. Need to assess false-positive risk — case matters in most languages. |
| 8 | 🖼️ MEDIUM | Inline diff in chat panel | See design below. |
| 9 | ✅ DONE | Pulsar ignore / `.mcp-ignore` | Implemented v0.11.7. `lib/mcp-ignore.js` + 3 integration points. |
| 10 | 🔧 LOW | Named capture groups `$<name>` in `applyReplacement` | Low priority quality-of-life. |
| 11 | 🧪 MEDIUM | Automated testing + script runner (Tier 1/2/3) | See design below. |
| 12 | 💾 LOW | Disk-backed checkpoints | See design below. |
| 13 | 🔀 LOW | Git integration tool | See design below. |
| 14 | 🔍 MEDIUM | grep-project fails on mcp-registration.js | Investigate: grep-project appears to fail or return partial results on `mcp-registration.js` specifically (8007 lines, CRLF, heavy Unicode). May be a line-length or encoding issue in the search backend. Reproduce + root-cause before fixing. |
| 15 | 📝 LOW | Document string anchors for unstructured files | See note below. |

---

### ✅ DONE — Extend `smartSuggestion` + `logFailure` to remaining edit tools

Completed 2026-06-09. `logFailure` and `smartSuggestion` now wired to `replace-block`, `insert` anchorNotFound, and `replace-function-body` notFound. All main edit tools covered.

---

### 📋 Tool Framework — per-tool feature plan

Before starting the framework migration, create a checklist document (or a section here) that lists every tool by name with its features ticked: `dryRun`, `lint`, `styleCheck`, `consecutiveFailureCounter`, `smartSuggestion`, `buildEditResponse`, `logFailure`, `stats keys`. Use this as the migration ledger — each tool gets a row, features get columns, tick off as each is ported to `registerMcpTool()`. This prevents features from silently dropping during the rewrite of an 8000-line file.

**Suggested format:**

| Tool | dryRun | lint | styleCheck | failCounter | smartSugg | logFailure | migrated |
|---|---|---|---|---|---|---|---|
| str_replace | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| insert | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ |
| ... | | | | | | | |

**Complexity:** Low prep work, high value as a migration safety net.

---

### 📝 LOW — Document string anchors for unstructured files

**Status:** Already implemented — `afterHint` and `betweenHint` accept arbitrary strings and do a text scan, not just symbol names. The gap is LLM awareness.

**Action:** Add a worked example to the `str_replace`/`insert` tool description covering markdown/config use cases, e.g. `afterHint:"## Installation"` to insert after a heading. One-line addition to TOOL_CATALOGUE description strings.

---

### 📁 MEDIUM — File context staleness warning (Pulsar buffer version tracking)

**Problem:** If the user edits a file in Pulsar between two LLM tool calls (e.g. manually fixes a line after a bad edit, or saves from an external tool), the LLM's mental model of the file is stale. The next `str_replace` or `replace-function-body` will use the old context. Currently we give no warning — the edit either silently hits the wrong place or fails with a confusing noMatch.

The thing to note here is that we mostly use hints as anchor points not line numbers so this has limited uses except for calls without hints, but it is still good for context so the LLM is aware of this.

This also could be handy for multiple LLMs working on the same content as it is technically possible to have multiple http mcp clients connected at the same time.

Pulsar's `TextBuffer` exposes `buffer.changeCount` (increments on every change) and `buffer.isModified()`. We already hold a reference to the live buffer in every tool handler.

**Implementation:**
1. Add a `Map<filePath, changeCount>` (`fileReadVersions`) at module scope, cleared on server start.
2. In `read-lines`, `get-document`, `grep-file` commit paths: record `fileReadVersions.set(filePath, buffer.changeCount)`.
3. In `str_replace`, `replace-function-body`, `insert`, `delete-line-range` commit paths: before applying, check if `buffer.changeCount !== fileReadVersions.get(filePath)`. If so, prepend warning: `"⚠️ stale context: file has changed since last read (buffer version +3). Verify your old_str still matches before proceeding."`.
4. Clear the entry when a write tool succeeds — record the post-write changeCount immediately to avoid false positives on our own edits.

---

### 🚫 MEDIUM — Pulsar ignore / file exclusion (`.mcp-ignore`)

**Problem:** `replace-across-files`, `grep-project`, `get-project-files`, `get-repo-map` currently have no file exclusion beyond the `.mcp-baseline/` glob guard in replace-across-files. On large projects with `node_modules`, build output, or generated files, tools return noise and waste tokens.

**Proposed:** A `.mcp-ignore` file at the project root (gitignore syntax). Loaded once at server start, re-loaded on file-save event. Applied as a filter in: `get-project-files`, `grep-project`, `get-repo-map`, `replace-across-files`, `list-project-functions`.

Default exclusions baked in (no `.mcp-ignore` needed): `node_modules/**`, `.mcp-baseline/**`, `*.min.js`, `dist/**`, `build/**`.

**Implementation:** ~50 lines. Use `micromatch` (already a dependency via globToRegex) or a simple gitignore-style line parser. Single `shouldIgnore(filePath)` helper called at each filter point.

---

### 🏗️ LARGE — Tool Framework (`lib/tool-framework.js`) — eliminate per-tool boilerplate

**Status:** Design complete (2026-06-06). Not yet started.

**Problem:** Every tool in `mcp-registration.js` hand-rolls the same bookkeeping scaffold:

- `editStats` / `lifetimeStats` init — declared per-tool at module scope (~L93–300). Adding a fail reason touches 3 places: init, `summarise()`, `buildReport()`.
- Instrumentation call sites inside each handler — `bump()`, `counter.count++/=0`, `smartSuggestion(...)`, `buildEditResponse(...)`, `dryRuns` bump. A cross-cutting change (e.g. the `dryRuns` fix) required touching every handler.
- `summarise()` and `buildReport()` hand-enumerate every tool explicitly — adding a tool means updating them too.

This is the root cause of most stat bugs fixed in v0.10.24 and the bump refactor session.

**Proposed fix:** `lib/tool-framework.js` — a `registerMcpTool()` wrapper. Each tool becomes a declarative config object; the framework handles all cross-cutting concerns automatically.

**Tool config shape:**

```js
registerMcpTool(server, {
  name:     'str_replace',
  group:    'edit',
  category: 'edit',            // 'edit' | 'search' | 'command' | 'nav'
  features: {
    dryRun:                    true,
    lint:                      true,
    consecutiveFailureCounter: true,
    smartSuggestion:           true,
    buildEditResponse:         true,
    styleCheck:                true,
  },
  stats: {
    fails:     ['noMatch', 'whitespace', 'partialMatch', 'ambiguous',
                'outOfScope', 'afterNotFound', 'wrongOccurrence'],
    hintsUsed: ['functionHint', 'afterHint', 'lineNumberHint', 'betweenHint',
                'occurrence', 'fuzzyWhitespace'],
    extras:    ['fuzzyWhitespaceCommits', 'fuzzyContentCommits',
                'regexCommits', 'lineNumberHintFallback', '_oldStrLenSum'],
  },
  inputSchema: { old_str: z.string(), new_str: z.string(), ...ANCHOR_SCHEMA },
  description: [...],
  handler: async (args, ctx) => {
    // ctx provides: editor, buffer, allLines, text, allSymbols
    //               bump(subPath, n)   — pre-namespaced to this tool
    //               fail(reason, msg) — bump + counter++ + smartSuggestion + return error
    //               commit(meta)      — counter=0 + bump hits + buildEditResponse + style/lint
    //               dryRunReturn(p)   — bump dryRuns + return preview
    //               consecutiveFailures — the { count } object
    // Handler contains ONLY the tool-specific logic — no bookkeeping.
  }
});
```

**What `registerMcpTool()` does automatically:**
- Auto-inits `editStats[tool]` and `lifetimeStats[tool]` from `stats` config — no separate declaration
- Creates consecutive-failure counter if `features.consecutiveFailureCounter`
- Injects `ctx` into the handler
- `ctx.fail(reason, msg)` → bumps `fails.reason` + `counter.count++` + appends `smartSuggestion` + returns error object
- `ctx.commit(meta)` → `counter.count=0` + bumps `hits` + calls `buildEditResponse` + appends style/lint/struct warnings
- `ctx.dryRunReturn(preview)` → bumps `dryRuns` + returns preview
- `summarise()` and `buildReport()` become **data-driven** — iterate `Object.keys(editStats)` instead of hand-enumerating

**What stays the same:** `bump()`, `ANCHOR_SCHEMA`, `STRUCTURAL_ANCHOR_SCHEMA`, `buildEditResponse()`, `smartSuggestion()`, `successNudge()`, `bumpStyle()`, `applyStyleCheck()`, `syncToLifetime()`, `flushLifetimeStats()`, all handler logic.

**Migration phases (incremental — introduce alongside existing pattern):**

| Phase | Scope | Risk | Notes |
|---|---|---|---|
| 0 | Make `summarise()` + `buildReport()` data-driven | Low | No handler changes. Immediate win — `Object.keys(editStats)` replaces hand-enumeration. |
| 1 | Write `lib/tool-framework.js` + `registerMcpTool()`. Migrate `replace-all` + `replace-document` as PoC. | Low-Med | Two simple tools with no consecutive counter. Verify stats identical before/after. |
| 2 | Migrate 8 main edit tools (`str_replace`, `insert`, `delete-line-range`, `delete-block`, `replace-function-body`, `replace-block`, `sed`, `apply-patch`). | Med | One tool at a time. Pre-reboot checklist after each. `apply-patch` needs escape hatch for `rescueAvailable` return shape. |
| 3 | Migrate search/nav tools. Leave Ghidra tools as-is. | Low | Ghidra tools have minimal boilerplate and change rarely. |
| 4 | Delete old manual stats declarations + module-scope consecutive-failure counters (now auto-generated). | Low | Final cleanup — only after all tools migrated and verified. |

**Escape hatches needed:**
- `apply-patch` has `rescueAvailable` and `confirm:true` flow — handler needs to return custom shapes; `ctx.commit()` needs a `raw:true` override.
- `namingcheck`, `check-function-docs`, `insert-function-doc` use local `curStats` inline-init — intentional, keep as-is (not migration targets).

**Complexity:** Large overall, but each phase is Low-Medium. Phase 0 alone takes ~30 min with no risk. Full migration: 4–6 sessions.

**This supersedes the old "Split mcp-registration.js" item** — splitting into per-tool files was the previous answer to the same problem. The framework approach is better: tools stay co-located (easier to cross-reference), the common infrastructure is shared, and the result is more maintainable than N separate files each re-importing the same helpers.

---

### 🖼️ MEDIUM-HIGH — Visual diff decorations (Cursor-parity)

Render proposed changes as inline editor decorations — green/red lines in the Pulsar gutter. Claude proposes, user visually reviews in-editor, then accepts or rejects.

- New tool `stage-edit` or `dryRun:true` returns a staged state
- Use `editor.decorateMarker()` with custom CSS classes
- Store staged state in module-level `stagedEdit` object (similar to `patchRescueStore`)
- `commit-staged` / `discard-staged` or reuse `confirm:true` pattern from apply-patch
- `highlight-range` decoration system already exists — build on that

**Complexity:** Medium-high.

---

### 🖼️ MEDIUM — Inline diff in chat panel

Show before/after diff rendered directly in the chat display after each edit — no new tab, no editor clutter.

**How other tools do it (researched 2026-06-04):**
- **Cursor** — renders green/red line decorations inline *in the editor file itself* before accept/reject. Requires deep VS Code fork access to the rendering layer. Not replicable in a Pulsar extension without the visual diff decorations feature below.
- **Cline** — opens a native VS Code side-by-side diff tab per edit. Works but creates tab noise — the exact thing we want to avoid.
- **Claude Code (VS Code ext)** — inconsistent: small edits show a diff block inline in the *chat panel*; full file writes open a side-by-side editor tab. Users are complaining about the inconsistency. The `+12 -1` stats indicator in Claude Desktop is a lighter alternative.
- **Aider** — terminal only. Diffs are opt-in via `/diff` command or `--show-diffs` flag. Retroactive, not pushed.

**Proposed approach** — inline diff block in the chat display after each edit, matching what Claude Code does for small edits (the better half of their inconsistent UX):
- `diff` library already imported
- Collapsible block with `+N -N` summary line (matches Claude Desktop stats indicator) — click to expand full unified diff
- Always visible summary, detail on demand — avoids noise for large edits
- `chat-functions.js` + `chat-panel.js` only, no new tools needed

**Complexity:** Medium.

---

### 🧪 MEDIUM — Automated testing and script runner

**Status:** Design complete. Not yet started. Three tiers — do Tier 1 first, others depend on it.

#### Tier 1 — Script runner: drive the existing HTTP endpoint from a JSON script file

The MCP HTTP server is already running at `localhost:PORT`. A script runner is just a Node.js CLI that reads a `.json` script file and POSTs each step to the existing server — no new server, no new protocol.

**Script format (`scripts/verify-tools.json`):**
```json
{
  "name": "post-edit verification",
  "steps": [
    {
      "tool": "run-command",
      "args": { "command": "node --check lib\\mcp-registration.js" },
      "assert": { "exitCode": 0 }
    },
    {
      "tool": "get-diagnostics",
      "args": { "scope": "project" },
      "assert": { "messageCount": 0 }
    },
    {
      "tool": "str_replace",
      "args": {
        "old_str": "const TEST_ANCHOR = 'hello';",
        "new_str": "const TEST_ANCHOR = 'hello';",
        "dryRun": true
      },
      "assert": { "matched": true }
    }
  ]
}
```

**Runner (`scripts/run-script.js`):**
```js
// node scripts/run-script.js scripts/verify-tools.json
// POSTs each step to localhost:PORT/mcp/v1/tools/call
// Reports pass/fail per step, exits non-zero if any assert fails
```

**Invocation from chat panel or run-command:**
```
run-command: node scripts/run-script.js scripts/verify-tools.json
```

**Key design points:**
- No new server, no new protocol — uses the HTTP endpoint the MCP SDK already exposes
- Script files are version-controlled alongside the package — they accumulate over time as a regression suite
- `assert` block is optional — steps without asserts still run and report output (useful for smoke tests)
- Supported assert keys: `exitCode`, `messageCount`, `matched`, `applied`, `hits`, `contains` (substring in response text), `not_contains`
- On failure: print the actual response + diff vs expected, exit 1

**Files needed:** `scripts/run-script.js` (~80 lines), script `.json` files in `scripts/`

**Complexity:** Low. The HTTP endpoint is already there; this is a thin client.

---

#### Tier 2 — In-process test harness: call tool handlers directly, assert on output

For unit-testing individual tool handlers without the HTTP overhead and without Pulsar running. Useful for CI, for testing edge cases that are hard to reproduce live, and for the tool framework migration (verify each migrated tool produces identical output).

**How:** Export a `callTool(name, args)` function from `mcp-registration.js` that bypasses HTTP and calls the registered handler directly with a mock `editor`/`buffer` context.

```js
// spec/tool-harness.js
const { callTool, mockEditor } = require('../lib/mcp-registration');

const editor = mockEditor({
  text: 'const x = 1;\nconst y = 2;\n',
  filePath: 'test/fake.js'
});

const result = await callTool('str_replace', {
  old_str: 'const x = 1;',
  new_str: 'const x = 99;',
}, editor);

assert(result.matched === true);
assert(editor.getText().includes('const x = 99;'));
```

**Key design points:**
- `mockEditor(options)` returns a minimal object implementing the Pulsar `TextEditor` API surface the tools use (`getText`, `getLines`, `setTextInRange`, `getPath`, etc.) — pure JS, no Pulsar needed
- Test files live in `spec/` alongside existing spec files
- Run with `node --test spec/tool-harness.js` (Node 18+ built-in test runner) or plain `node spec/tool-harness.js`
- The tool framework (item 1 in TODO) makes this much easier — once handlers receive `ctx` injection, `mockEditor` is just a mock `ctx`
- Doubles as the regression suite for the tool framework migration: run before and after each tool migration, assert outputs match

**Files needed:** `spec/tool-harness.js`, `lib/mock-editor.js` (~100 lines)

**Complexity:** Medium. `mockEditor` needs to cover the Pulsar buffer API surface used by tools — about 15 methods. The tool framework makes this significantly easier.

**Dependency:** Benefits greatly from Tool Framework Phase 1 being done first (handlers become testable in isolation). Can be started independently but is much cleaner after the framework exists.

---

#### Tier 3 — Named procedures: reusable tool sequences with conditional logic

A named, version-controlled procedure system — sequences of tool calls with variable substitution, conditionals, and loops. Invokable by name from the chat panel or from Tier 1 scripts.

**Procedure format (`procedures/post-edit-verify.proc.json`):**
```json
{
  "name": "post-edit-verify",
  "description": "Run after any mcp-registration.js edit",
  "vars": { "file": "lib/mcp-registration.js" },
  "steps": [
    { "tool": "run-command",    "args": { "command": "node --check {{file}}" }, "assert": { "exitCode": 0 }, "on_fail": "abort" },
    { "tool": "get-diagnostics","args": { "scope": "project" },                 "assert": { "messageCount": 0 } },
    { "tool": "get-edit-stats", "args": {} }
  ]
}
```

**Invocation from chat:**
```
@// post-edit-verify
```
(via the existing `@//` shortcuts system — procedures are just a richer kind of shortcut)

**Difference from Tier 1:** Tier 1 is a static sequence. Tier 3 adds: variable substitution (`{{file}}`), `on_fail: abort | continue | retry`, conditional steps (`"if": "{{exitCode}} == 0"`), and named procedures invokable from chat shortcuts — closing the gap with Windsurf Cascade workflows.

**Complexity:** Medium. The runner from Tier 1 is the engine; Tier 3 adds a template/conditional layer on top.

**Dependency:** Build on Tier 1. The `@//` shortcuts system already exists as the invocation mechanism.

---

**Relationship to other TODO items:**

- **Tool Framework** — Tier 2 (in-process harness) pairs directly with the framework migration: run the harness before/after each tool migration as a correctness gate.
- **Failure capture** — script runner (Tier 1) can run known-failure scenarios and assert the NDJSON log records the right `reason` and `diffVsBuffer`.
- **Per-step approval (Feature Gap table)** — Tier 3 procedures are a natural place to hook in per-step approval UI: show each step's intent in the chat panel before executing.

**Priority within this item:** Tier 1 first (standalone, no dependencies, immediately useful). Tier 2 after Tool Framework Phase 1. Tier 3 after Tier 1 is working.

---

### 💾 LOW — Disk-backed checkpoints

**Status:** Not started.

**Problem:** In-memory checkpoints are wiped on every `mcp-registration.js` save (Pulsar hot-reload). Any multi-step edit sequence that spans a server reload loses its safety net. The gap table notes Cline uses a shadow git repo for this.

**Proposed:** `checkpoint-to-disk name` / `restore-from-disk name` tool pair. Snapshot = file path + full text written to `.mcp-checkpoints/<name>-<timestamp>.json`. No git required. Survives reloads. The existing `checkpoint` / `restore-checkpoint` tools stay as fast in-memory fallbacks.

**Implementation:** ~40 lines in a new handler. `fs.writeFileSync` on checkpoint, `fs.readFileSync` + `buffer.setText()` on restore. Store in package dir alongside `edit-stats.json`.

---

### 🔀 LOW — Git integration tool

**Status:** Not started. `run-command` can already call git — this is about surfacing it cleanly as a first-class tool.

**Problem:** After a successful editing session there's no easy way to commit the work with a meaningful message. Manually running `run-command` with a git command works but is clunky and not tracked in edit stats.

**Proposed:** A `git-commit` tool: takes a `message` param, runs `git add -p` interactively or `git add <files>` + `git commit -m`. Returns the commit hash. Could also expose `git-status` (cleaner than `run-command git status`) and `git-diff` (show pending changes before committing).

**Implementation:** Thin wrappers around `run-command` internals. Low complexity — the interesting design question is whether to auto-add all modified files or require explicit paths.

---

### Future / lower priority

- **Linting + test loop** — `get-diagnostics` and `get-compiler-diagnostics` exist but no automatic post-edit test runner. A `run-tests` tool that fires after edits and pipes failures back would close that gap.

---

### Post-edit structural integrity checks

**Problem:** The inline linter (`lint:true` param) exists and works but is effectively invisible — it is not mentioned in any tool description string in TOOL_CATALOGUE, only in the Zod schema. As a result it is never passed by the LLM and provides zero value in practice. Separately, a whole class of post-edit failures (brace imbalance, unclosed block comments, `#if`/`#endif` imbalance) produce no feedback at all — the edit succeeds and the damage is silently compounded by subsequent edits.

**Two tiers of fix:**

**Tier 1 — always-on fast structural checks (per-edit, inline)**

A new `lib/struct-check.js` module exporting `structuralIntegrityCheck(text, filePath)` — same call signature as `applyStyleCheck`, appends a warning suffix or empty string. Runs on the full buffer text after commit (not just `new_str` — brace delta is only meaningful at buffer scope). Single tokeniser pass tracking state `(NORMAL | LINE_COMMENT | BLOCK_COMMENT | STRING | CHAR)`. Checks:

- **Brace/bracket/paren balance** — `{ } [ ] ( )` delta. Flag if nonzero after edit.
- **Unclosed block comment** — track `/*`/`*/` pairs; flag with line number of unclosed opener.
- **`#if`/`#endif` balance** — preprocessor nesting depth; flag if nonzero at EOF.

Wire into same 15 commit sites as `buildEditResponse` (which wraps `applyStyleCheck`): `str_replace`, `replace-function-body`, `insert`, `replace-document`, `replace-all`, `sed`, `apply-patch`, `delete-line-range`, `delete-block`, `replace-block`, `replace-across-files`, and all remaining handlers. Add `_structWarnings` counter to stats. Target ~150 lines, <2ms on a 1000-line file.

**Tier 2 — token-stream state machine (per-edit, medium complexity)**

Extend the tokeniser with a depth-tracking register machine (~15 token types, no AST needed):

- **Missing `break` in switch case** — track `SWITCH_BODY` mode; flag `case:` reached without preceding `break`/`return`/`/* fallthrough */`.
- **Keyword not followed by brace** — after `if(...)`/`for(...)`/`while(...)`, next non-whitespace token must be `{`. Flags dangling-body patterns.
- **Unreachable code after `return`** — code following `return` at same brace depth before next `}` or `case`.
- **Duplicate `case` values** — tokenise and deduplicate case labels within a switch.

**Tier 3 — `verify-file` tool (end-of-task, explicit)**

A new `verify-file` tool bundling: full-buffer structural integrity (Tiers 1+2), linter snapshot (whole file), style report, and optionally compiler diagnostics. Tool description: *"Call this before reporting a task complete on any code file."* Addresses the Verification & Termination failure class — makes verification a named step in the protocol, not an ad-hoc memory item.

**Always-on, non-disableable — design principles:**

Remove the `lint` param entirely rather than defaulting it to `true`. No escape hatch at the tool level — the LLM should not be able to suppress its own safety net. Silent when clean means no opt-in is needed anyway.

The key design requirement to make always-on non-annoying is **delta checking** — compare post-edit state against pre-edit baseline captured just before the buffer write:

- **Structural checks (brace/comment/#if balance):** only warn if the imbalance is *worse* than before the edit. Capture pre-edit counts, compare post-edit counts, warn only if `post > pre`. This suppresses false positives during multi-call rewrites — a deliberate two-step rewrite with an intermediate imbalanced state won't false-positive because the delta is zero on the first step.
- **Linter:** capture the set of linter message digests before the edit, compare after. Only surface messages that are *new* — pre-existing errors are not the LLM's fault on this edit and shouldn't appear in this response. This is strictly better than the current opt-in behaviour which either shows everything or nothing.

Implementation: each edit tool captures `preEditSnapshot()` (brace counts + linter message set) before `buffer.setTextInRange(...)`, then calls `postEditDelta(pre, post)` to produce the suffix. Both helpers are stubbed in `lib/edit-response.js`; the tokeniser logic will live in `lib/struct-check.js` and be called from there.

**Complexity:** Tier 1 = Low-Medium (delta snapshot adds state). Tier 2 = Medium. Tier 3 = Low.

---

### Session-notes policy schema (deferred — architecture decision)

**Background:** Reviewed suggestion to restructure session notes from free-text into a structured policy/state-machine schema with fields: `task_class`, `file_class`, `failure_class`, `recommended_tool`, `recommended_hints`, `confidence`, `last_seen`, `success_count`, `failure_count`, `deprecated`, `priority_score`.

**Assessment — do not implement yet.**

The schema solves a problem that doesn't exist in the current architecture. Notes are read once at session start by the LLM; there is no server-side selection layer. Adding structured fields without a selection layer adds maintenance overhead with no runtime benefit — the LLM still reads all notes and interprets them opportunistically regardless of schema.

The schema becomes valuable only if the server intercepts tool calls and injects relevant policy inline at the point of use. The inline nudge pattern (`smartSuggestion`, `[lineNumberHintFallback]` warnings) is already the proven delivery mechanism for this — it lands policy at the exact decision point, not front-loaded in session notes the LLM may have deprioritised 30 tool calls ago.

**What to do instead (low cost, immediate value):**
- Add `[DEPRECATED]` prefix to obsolete session notes so the LLM skips them.
- Add `failure_class:` tag as free text to new notes — enables future grep/categorisation if a selection layer is built.
- If a selection layer is ever built, only two fields are load-bearing: `deprecated`/`superseded_by` and a `priority_score` or `success_count`/`failure_count` pair. Everything else is analytics.

**Revisit if:** session notes exceed ~25 entries and the LLM demonstrably starts missing older ones, or a tool-intercept architecture is built for `verify-file` / per-step approval.

---

## Feature Gap Analysis — vs Other Tools (researched 2026-06-04)

### What we have that others don't
- **Kernel C style checker** — inline, per-edit, rule-level violation reporting. No other tool does language-specific style at this depth.
- **naming-checker** — verb-segment, camelCase, doc skeleton generation. Unique.
- **Ghidra integration** — reverse engineering workflow. Unique.
- **Edit stats + hints system** — tracks hit/fault rates per tool, surfaces smarter suggestions based on failure patterns. Unique.
- **Self-updating project rules + repo map** — `session-notes` acts as a living CLAUDE.md: the LLM writes its own codebase-specific rules, tool preferences, and lessons learned, then reads them back at the start of every session. Combined with `get-repo-map` at session start, the LLM arrives with full structural context and accumulated knowledge of what works on this codebase. Better than a static user-written rules file because it improves automatically.
- **`@//` prompt shortcuts** — named prompt templates in `shortcuts.md`, invokable from the chat input with live filter dropdown. Functionally equivalent to Windsurf Cascade workflows at a fraction of the complexity.
- **apply-patch fuzzy rescue** — fuzzy rescue confirm:true flow implemented but apply-patch itself (0/40 lifetime hits) is effectively deprecated. The fuzzy infrastructure remains in place for future use.
- **Tree-sitter symbol resolution** — all hint/anchor resolution (afterHint, betweenHint, functionHint) backed by tree-sitter live buffer. Regex fallback for unsupported grammars (Ghidra decompiled C). Unique depth for a Pulsar extension.

### What others have that we don't — gap table

| Feature | Cursor | Windsurf | Cline | Claude Code | Us | ★ Unique to us | Notes |
|---|---|---|---|---|---|---|---|
| Plan mode (describe task → plan → approve) | ✅ | ✅ | ✅ | ✅ | ❌ | | High value. LLM proposes step-by-step plan in chat before touching files. User approves/edits plan first. |
| Per-step approval in agentic runs | ✅ | ✅ | ✅ | ✅ | ❌ | | Each tool call shows intent + asks confirm before executing. |
| Inline diff in editor (green/red decorations) | ✅ | ✅ | ❌ | ❌ | ❌ | | Already in plan as visual diff decorations. Cursor-only due to fork. |
| Inline diff in chat panel | ❌ | ❌ | ❌ | ✅ (partial) | ❌ | | Already in plan. |
| Reusable task workflows / recipes | ❌ | ✅ Cascade | ❌ | ❌ | ✅ `@//` | ★ | `@//` shortcuts in `shortcuts.md` — named prompt templates with live filter dropdown. Equivalent to Windsurf Cascade workflows, simpler format. |
| Context window usage indicator | ❌ | ❌ | ✅ | ✅ | ❌ | | Token count + cost per interaction shown in chat. Low-medium value. |
| Auto context compaction / summarisation | ❌ | ❌ | ❌ | ✅ /compact | ❌ | | Summarises old history to free window. Medium value for long sessions. |
| CLAUDE.md / project rules file | ❌ | ❌ | ❌ | ✅ | ✅ | ★ | Covered by session-notes: LLM writes and self-updates its own rules, tool preferences, and lessons. Read back at every session start. Better than a static file — improves automatically with use. |
| Codebase orientation / repo map on startup | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | get-repo-map called at session start gives full structural context. Combined with session-notes, the LLM arrives knowing both the code layout and accumulated lessons for this project. |
| Multi-agent / parallel agents | ✅ (8x) | ✅ Cascade | ✅ Kilo fork | ✅ Agent tool | ❌ | | Complex. Out of scope for single-server architecture. |
| Arena mode (compare model outputs) | ❌ | ✅ | ❌ | ❌ | ❌ | | Run same task on 2+ models, pick winner. Interesting but niche. |
| Auto model selection per task | ✅ Auto | ❌ | ❌ | ❌ | ❌ | | Cursor picks best model automatically. We have manual model combobox with persistence. |
| Browser / web access during task | ❌ | ❌ | ✅ | ✅ | ❌ | | Cline/Claude Code can fetch URLs mid-task. run-command + curl is a workaround. |
| Spend / token limit guard | ❌ | ❌ | ✅ | ❌ | ❌ | | Cline v3.78 added spend limit UI to stop runaway agents. |
| .cursorrules / per-project AI config | ✅ | ❌ | ❌ | ❌ | ❌ | | Per-project rules file that shapes AI behaviour. We cover this via session-notes (see above). |
| Checkpoint / restore mid-task | ❌ | ❌ | ✅ shadow git | ❌ | ✅ buffer + disk | ★ | Buffer checkpoints in place. Disk-backed checkpoints in TODO — survive hot-reload. Git integration also in TODO. |
| Kernel C style checking (inline per-edit) | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | Per-edit violation reporting scoped to changed lines. Rule-level breakdown. checkpatch for full-file audit. |
| Function naming + doc skeleton generation | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | namingcheck, check-function-docs, insert-function-doc. Kernel C only. |
| Ghidra reverse engineering integration | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | Full RE tool suite via Ghidra MCP bridge. |
| Edit stats + smart failure suggestions | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | Per-tool hit/fault/hint tracking. Surfaces tool-switch suggestions on first failure, not third. |
| Persistent cross-session LLM notes | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | session-notes tool. LLM writes lessons learned; reads them back next session. Self-improving — no user maintenance needed. |
| Aider-style repo map (tree-sitter) | ❌ | ❌ | ❌ | ❌ | ✅ | ★ | get-repo-map with PageRank symbol ranking. Integrated natively, no Aider install needed. |
| apply-patch fuzzy rescue | ❌ | ❌ | ❌ | ❌ | ⚠️ | | Fuzzy rescue with confirm:true flow implemented. apply-patch has 0 lifetime hits — effectively deprecated in favour of str_replace. Infrastructure retained. |

### Highest value gaps to consider

1. **Plan mode** — describe task → LLM outputs numbered step plan in chat → user approves/edits → execution begins. Prevents wasted edits on misunderstood tasks. All four major tools have this. Could be a chat panel mode toggle (`/plan` prefix or Plan button). LOW-MEDIUM implementation complexity — it's a prompting/UX pattern, not a new tool.

2. **Per-step approval** — before each tool call in an agentic run, show intent in chat and wait for user confirm. Cline's defining UX. Pairs naturally with plan mode. MEDIUM complexity — requires chat panel to intercept tool dispatch.

3. **Context window indicator** — show token usage in chat panel header. MEDIUM-LOW complexity — needs token counting on the callLLM response (usage field already in API response).

4. **Disk-backed checkpoints** — now in TODO above (💾 LOW). Git integration also in TODO (🔀 LOW).

5. **Reusable workflows** — named prompt+tool recipes stored in a JSON file, invokable by name from chat. Windsurf Cascade's killer workflow feature. MEDIUM complexity. `@//` shortcuts cover the prompt-template use case already — this would add tool sequencing on top.

---

## Edit Strategy (key rules)

- `open-file` before any str_replace — buffer must be active
- `fuzzyWhitespace:true` as default for mcp-registration.js (mixed indentation throughout)
- `afterHint` on unique nearby string is the most reliable scope anchor; `betweenHint` when afterHint is ambiguous
- `dryRun:true` before any str_replace with old_str > 5 lines
- `replace-function-body` first for whole-function rewrites
- `replace-block` for `{}` brace blocks ONLY — never `[]` array literals
- `save-all` after every edit — never batch edits without saving between them
- Saving mcp-registration.js triggers hot-reload — checkpoints wiped, MCP server cache restarts
- **Reload procedure:** close Pulsar → delete `.pulsar/compile-cache/js/babel/` → reopen Pulsar → restart Claude Desktop
- `betweenHint` is the best disambiguator when `afterHint` hits an earlier occurrence
- `$1`/`$2` backreferences in `replace-across-files`/`replace-all`/`sed` replacement strings work correctly (fixed v0.10.27 via `applyReplacement`).
- `replace-across-files` glob must always be `lib/*.js`, never `**/*.js` — the latter hits `.mcp-baseline/` which is a read-only backup and must never be modified. `replace-across-files` has no excludeGlob param so a positive lib/ scope is the only safe option. Same applies to `grep-project` when searching for edit targets.
- `functionHint` never on .md files — use lineNumberHint or afterHint instead
- `grep-file` before str_replace on any file to confirm exact anchor text and line numbers
- chat-panel.js and .less changes require Pulsar package reload — they do NOT hot-reload on save
