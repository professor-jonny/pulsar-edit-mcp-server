# LLM Edit Tool — Failure Modes & Implemented Strategies

## Context: How other tools handle this

Before the proposals, it's worth knowing what Claude Code and Cline actually do — because
the comparison shows where pulsar-edit-mcp-server is already ahead, and where gaps remain.

### Claude Code (`str_replace` / Edit tool)

- Exact string match only — `old_string` must appear **exactly once** in the file
- If it appears more than once, Claude is expected to widen `old_string` with enough
  surrounding context to make it unique, or use `replace_all: true`
- No `functionHint`, no `lineHint`, no `dryRun`, no failure diagnostics
- No fuzzy matching, no partial-match reporting, no whitespace diff
- Falls back to `write_to_file` (full rewrite) when `str_replace` fails repeatedly

### Cline (`replace_in_file`)

- Uses a SEARCH/REPLACE block format similar to unified diff
- Same fundamental problems — widely reported in their GitHub issues:
  "The diff edit fails a lot more often than when it works. It makes it eat tokens like
  crazy, fail a few more times and eventually uses write_to_file which is extremely
  inefficient." (issue #1195)
  "replace_in_file fails when SEARCH/REPLACE blocks are out of order" (issue #4067)
- No anchoring system, no failure diagnostics, no fuzzy location hints
- The failure loop (fail → full read → retry → fail → full rewrite) is a known open
  problem across all models they support

### Summary

Neither tool has `functionHint`, `lineHint`, `dryRun`, whitespace mismatch reporting,
partial match counting, or fuzzy area location. The failure diagnostics and anchoring
system in pulsar-edit-mcp-server are genuinely novel. The proposals below extend that
lead further.

---

## Known LLM Edit Failure Modes

### 1. Line number drift (most fundamental)

**What happens:** The LLM reads the file at turn N and gets line numbers. Edit 1 shifts
everything below it. By edit 2 the line numbers in the LLM's head are wrong but it has
no way to know that. Any line-number-based tool (insert, delete-line-range, patches) is
affected.

**Current mitigation:** `str_replace` and `replace-function-body` anchor on content not
position. `insert` and `delete-line-range` warn about shift and return `newLineCount`.

**Gap:** No content-anchored equivalent of `insert` or `delete-line-range`.

---

### 2. Whitespace / indentation mismatch (most common failure)

**What happens:** The LLM generates `old_str` from memory, normalising indentation —
tabs become spaces, 4-space becomes 2-space, trailing spaces are dropped. The content is
right but the match fails.

**Current mitigation:** On failure, `str_replace` reports per-line whitespace differences
showing the search text vs buffer text side-by-side. No additional read needed to fix.
`fuzzyWhitespace: true` eliminates the retry entirely by matching on trimmed-per-line
content and applying the replacement using the buffer's actual indentation.

**Live data (lifetime stats):** 2 whitespace failures observed, both recovered via
`fuzzyWhitespaceCommits` (auto-commit). Zero retries needed for whitespace in those cases.

---

### 3. Multiline old_str reconstruction from memory

**What happens:** The LLM subtly rewrites `old_str` — paraphrases a comment, changes a
variable name slightly, drops a blank line. Looks right to a human but fails exact match.

**Current mitigation:** Partial match counter tells how many consecutive lines matched
before divergence. Fuzzy word-scoring shows the closest area in the file.

**Gap:** The LLM still needs a retry after reading the exact content.

---

### 4. Duplicate pattern confusion

**What happens:** The same block appears multiple times (error handlers, struct
initialisers, repeated boilerplate). `str_replace` hits the first occurrence which may
not be the intended one. The LLM usually doesn't notice until the code breaks.

**Current mitigation:** `functionHint` scopes to a named function body. The ambiguity
guard (S1) blocks the edit entirely if `old_str` matches more than one location and no
scope hint is set, forcing the LLM to be explicit before proceeding.

---

### 5. Off-by-one on block boundaries

**What happens:** The LLM tries to replace a function or block but gets the closing brace
wrong by one line — either including the start of the next function or leaving a stray `}`.

**Current mitigation:** `replace-function-body` does brace-matching itself so the LLM
only needs to name the function. `replace-block` extends this to arbitrary anchor strings.

**Gap:** Only works when a clear anchor string or function name is available.

---

### 6. Stale context / attention window truncation

**What happens:** On large files `get-document` returns so much text that by the time the
LLM is generating its edit, the top of the file has scrolled out of its attention window.
It then generates `old_str` from reconstruction rather than the actual text.

**Current mitigation:** `get-file-summary`, `read-lines` (hint-based), `grep-file`,
`grep-project`, `search-symbol`, `find-text`, and `get-region` all exist to bring only
relevant content into context. `read-lines` can resolve a region by `functionHint`,
`afterHint`, `betweenHint`, `lineHint`, or `centerLine`+`radius` — no line numbers needed.

---

### 7. Patch header line numbers (why patches were abandoned)

**What happens:** The LLM generates `@@ -47,6 +47,8 @@` from its stale mental model. Even
if the context lines are correct the diff library can reject the hunk if the header is
too far off.

**Current mitigation:** `apply-patch` uses context-line anchoring with fuzz factor, tracks
failures, and suggests switching to `str_replace` or `replace-function-body` after 3
failures.

**Status:** Patches are structurally the wrong format for LLM-generated edits. `apply-patch`
is best treated as a last-resort / human-provided path only.

---

### 8. LLM defaults to fragile tools despite better options being available (most persistent)

**What happens:** The LLM reaches for familiar, low-friction tools — `read-lines` with a
`lineHint` (line number), `str_replace` without any anchor hints — even when the file is
large, the pattern is duplicated, and better tools exist. The sophisticated tools
(`replace-function-body`, `replace-block`, `afterHint`, `betweenHint`, `occurrence`) go
unused not because they don't work but because the LLM never reaches for them unless
forced to by a failure.

**Live data (lifetime stats):**
```
str_replace:           18 hits, 4 fails
replace_function_body:  0 hits
replace_block:          0 hits
dryRuns (all tools):    0

str_replace hint usage:
  lineHint:       12   ← fragile (line numbers drift)
  functionHint:    8   ← stable
  afterHint:       0   ← never used
  betweenHint:     0   ← never used
  occurrence:      0   ← never used
```

`lineHint` is used 50% more than `functionHint`. Content-anchored alternatives
(`afterHint`, `betweenHint`) are never used. `replace-function-body` and `replace-block`
— which eliminate whole classes of failure — have zero hits. `dryRun` has never been
used voluntarily across any tool.

**Important caveat:** These stats were gathered with a capable model (Claude Sonnet).
With a weaker LLM the failure rate on `str_replace` would be higher, `old_str`
reconstruction from memory would be less accurate, and tool selection would be even
more conservative. The tool-selection problem does not improve with model quality alone
— it is a structural default, not an intelligence problem.

**Why reactive mitigations are insufficient:** The smart suggestion engine (S2) fires on
failure and nudges toward better tools. The success nudge fires on successful `str_replace`
when no hints were used on a large file. Neither changes the default behaviour reliably
because the LLM is succeeding often enough (18/22 on `str_replace`) that it is rarely
corrected. Success reinforces the fragile default path.

**What session notes with explicit tool guidance actually did:** In longer sessions,
adding specific tool guidance to session notes — e.g. "use `replace-function-body` for
all function edits on this file" — demonstrably reduced failure rates. The LLM followed
the guidance and reached for the better tools. However it produced a consistent side
effect: the LLM narrated its tool use at every step ("I'll use `replace-function-body`
here as the session notes suggest"), signalling compliance rather than acting naturally.
It was working but performing at the same time — pattern-matching to the instruction and
announcing the match rather than reasoning from context.

Weaker models do this more aggressively, not less. The narration is the tell that the
behaviour is rule-following rather than internalised judgment.

**Why this matters for tool design:** Session notes guidance is worth using — it measurably
reduces failures — but it is not a complete solution. The LLM is complying with an
instruction it found in context, not reasoning about the edit. If the instruction is
absent, ambiguous, or doesn't quite fit the situation, the behaviour reverts. And the
narration adds noise to every session.

The ideal is the LLM reaching for the right tool because the context makes it obvious,
not because a rule told it to. Making the *wrong tool more expensive at the point of use*
is more reliable than instructions — the ambiguity guard doesn't tell the LLM to use
hints, it blocks and forces a retry. P9 (file metadata at open time, no instructions)
is the proposed complement: an LLM that can see "850 lines, 14 functions, largest 120
lines" may naturally reach for `replace-function-body` without being told to. A rule
says "do this"; information makes the right tool the obvious fit.

**Proposed mitigations:** See P9–P11 below.

---

## Proposals

### Status of original proposals (P1–P8)

| Proposal | Description | Status |
|---|---|---|
| P1 | `occurrence: N` on `str_replace` | ✅ Implemented |
| P2 | `afterHint` on `str_replace` | ✅ Implemented |
| P3 | Fuzzy whitespace commit | ✅ Implemented |
| P4 | `betweenHint` on `str_replace` | ✅ Implemented |
| P5 | Content-anchored `insert` (`afterContent`/`beforeContent`) | ✅ Implemented |
| P6 | `delete-block` (content-anchored delete) | ✅ Implemented |
| P7 | `replace-block` (generalised replace-function-body) | ✅ Implemented |
| P8 | `get-region` (content-anchored read-lines) | ✅ Implemented |

All P1–P8 proposals are live. The remaining open work is the tool-selection problem
(failure mode 9), addressed by P9–P11 below.

---

### P9 — File metadata note on `open-file`

**Fixes:** LLM defaults to fragile tools (failure mode 9)
**Effort:** Low
**How:** When `open-file` is called, append a compact metadata block to the response
alongside the file content: line count, detected language, number of functions, largest
function sizes. No instructions — just facts about the file.

The goal is to provide information that makes the right tool the obvious choice, rather
than rules that get performed. An LLM that can see "850 lines, 14 functions, largest 120
lines" naturally reaches for `replace-function-body` on function edits. An LLM that only
sees raw file content has no basis for that choice until after a failure.

---

### P10 — `lineHint`-only warning on `str_replace`

**Fixes:** LLM defaults to fragile tools (failure mode 9), line number drift (failure mode 1)
**Effort:** Low
**How:** When `str_replace` succeeds but `lineHint` was the only hint used (no
`functionHint`, `afterHint`, or `betweenHint`), append a soft warning to the success
response noting that line numbers drift after edits and content anchors are more stable.

This makes the fragile choice visible at the moment of every use, not only after failure.
It is a cost signal at the point of the call, not a rule that may not be in context.

---

### P11 — Escalating `dryRun` prompt for large `old_str`

**Fixes:** LLM never uses `dryRun` voluntarily (failure mode 9)
**Effort:** Low
**How:** When `str_replace` is called with `old_str` longer than N lines (e.g. 8) and
`dryRun` was not set, append to the success response a note that the edit committed
without verification. On failure of a large `old_str`, escalate this to a blocking
suggestion rather than a soft nudge.

`dryRun` has been zero across the entire lifetime stats. The LLM has never used it
voluntarily. The tool needs to make the cost of skipping it visible at the point of
large edits, not rely on the LLM remembering it is available.

---

## Implemented Strategies (May 2026)

### S1 — Ambiguity guard: block before wrong-occurrence commit

**Problem being solved:** LLMs generate `old_str` from memory of what they read. Common
short patterns (`return null`, `if (!editor)`, `const buffer = editor.getBuffer()`,
callback names) appear dozens of times in a file. The LLM picks one confidently, hits
the wrong occurrence, and silently corrupts the file.

**Why earlier approaches were insufficient:** `occurrence:N` and `functionHint` both
exist, but they require the LLM to *know* that the pattern repeats and to pre-emptively
use them. The LLM frequently doesn't know.

**Strategy implemented:** Before committing, `str_replace` counts all occurrences of
`effectiveOldStr` in the full file. If `totalMatches > 1` AND no scope hint is set, the
edit is **blocked** with a `⚠️ AMBIGUOUS MATCH` response listing every matching line
number. Scan capped at 20 matches. `occurrence > 1` disables the guard.

Extended to `replace-block`, `replace-function-body`, and `delete-block` via a shared
`ambiguityCheck()` helper. For `replace-function-body`, a regex scan counts
definition-like occurrences (`name\s*\(`) only — not call sites.

**Why the guard belongs in the tool, not the prompt:** Prompt instructions like "always
check for duplicates before editing" are forgotten mid-conversation. Tool-enforced
blocking fires unconditionally at the exact moment the mistake would have been made.
This is the same principle as P9–P11: structural cost at the point of the wrong choice,
not rules written elsewhere.

---

### S2 — Smart suggestion engine: feedback at the moment of failure

**Problem being solved:** The previous failure suggestion system fired after 3 consecutive
failures. By that point the LLM had already made 2 wrong calls and was likely looping.

**Strategy implemented:** `smartSuggestion(ctx)` fires on **failure #1**:

- No hints used → lists the specific hints that apply, with concrete syntax examples
- `old_str` looks like a whole function → suggests `replace-function-body`
- `old_str` looks like a brace block → suggests `replace-block`
- File >500 lines AND no hints → adds file-size urgency text
- Escalates to tool-switch suggestions at failure #2

`successNudge(ctx)` appended to `str_replace` **success** responses when no hints were
used on a file >300 lines. Tells the LLM which hints to use next time.

**Known limitation (from live stats):** The success nudge is not reliably changing
behaviour. With an 18/22 success rate on `str_replace`, the failure path fires
infrequently. `lineHint` is still used 50% more than `functionHint`, and content-anchored
alternatives remain at zero. Reactive feedback after failure is insufficient — the
default is set before the first edit attempt. P9 (file metadata at open time) is the
proposed complement, providing information that shapes the choice rather than correcting
it after the fact.

---

### S6 — Inline linter feedback on edit tool responses (`lint: true`)

**Problem being solved:** Edits that succeed syntactically but introduce lint errors are
invisible to the LLM. It moves on assuming the edit was clean, and errors surface only
when something breaks downstream — if at all.

**Strategy implemented:** All six edit tools accept a `lint: true` parameter. When set,
the linter runs automatically after commit, scoped to the edited line range, and any
errors or warnings are appended to the tool response. The LLM sees lint feedback in the
same response as the edit result, at the moment the edit is made, rather than discovering
problems in a separate diagnostic call later.

**Known gap:** For deletion tools, the deleted lines are gone so lint scope is a fixed
neighbourhood around the deletion point. Full-function scoping would be more accurate
but is left as a future improvement.

---

## Edit Statistics & Instrumentation

### What other tools do

**Claude Code** — opt-in telemetry sent to Anthropic. A third-party scraper computes an
aggregate success rate from transcripts after the fact. No per-tool, per-reason breakdown.
The running agent never sees it mid-session.

**Cline** — no instrumentation. Failure data comes from user bug reports. Same failure
modes stay open for months.

**Cursor** — no public tooling stats or failure instrumentation.

No existing tool has per-tool, per-failure-reason instrumentation built into the server
itself that the LLM can query mid-session.

---

### What in-server stats provide

Two properties make built-in stats uniquely valuable:

**1. Queryable by the LLM mid-session** — `get-edit-stats` lets the LLM see its own
failure patterns during a session and adjust strategy. None of the other tools support
this.

**2. Lifetime accumulation** — Session stats reset per session. Lifetime stats accumulate
across all sessions and survive restarts (persisted to `edit-stats.json`). This solves
cross-session persistence without a separate timestamped log file — the lifetime stats
architecture is sufficient.

---

### What the live data shows

From `edit-stats.json` (lifetime stats at time of writing):

```
str_replace:    18 hits, 4 fails (whitespace: 2, outOfScope: 2)
replace_all:     8 hits
read_lines:      8 hits
get_diagnostics: 8 hits

replace_function_body: 0 hits
replace_block:         0 hits
dryRuns (all tools):   0

str_replace hint usage:
  lineHint:      12
  functionHint:   8
  afterHint:      0
  betweenHint:    0
  occurrence:     0
```

The failure rate on `str_replace` itself is acceptable at 82%. The problem is tool
selection — the LLM defaults to `str_replace`+`lineHint` and never reaches for the
tools that eliminate whole failure classes. This is currently the most persistent open
problem in the system, and these stats represent a *best case*: a capable model on a
small sample. Weaker models or longer sessions would show considerably worse numbers.

---

### What the data would answer (open questions)

| Question | Why it matters |
|---|---|
| Does `afterHint` reduce failure rate vs `lineHint`? | Validates P10 once implemented |
| Do failures cluster on files >500 lines? | Validates P9 file-size threshold |
| Does `dryRun` adoption increase after P11? | Validates escalating prompt approach |
| Does `replace-function-body` usage increase after P9? | Primary metric for tool-selection fix |
| Do longer `old_str` blocks fail more? | Validates P11 line-count threshold |
| Does `fuzzyWhitespace` proactive use increase with P10-style nudging? | 2 auto-commits observed; proactive use still zero |

---

## Using `session-notes` and `get-edit-stats` — Recommended Workflow

Both tools are implemented and live. This section documents the intended usage pattern
for inclusion in project instructions given to the LLM at session start.

### Example project instructions (include in system prompt or CLAUDE.md)

```
## Session start — always do this first
1. Call session-notes({ action: "read", project: "<project-name>" })
   Read all prior notes for this project. Adjust edit strategy based on
   what failed before — indentation style, files that hot-reload on save,
   tools that worked better than others.

2. Call get-edit-stats() to confirm counters are at zero (fresh session).
   If not, a prior session was interrupted — reset with { reset: true }.

## During the session
- If str_replace fails more than once, call get-edit-stats() to classify
  the failure mode and adjust strategy.

## Session end — always do this before closing
1. Call get-edit-stats() to read the session summary.
2. Call session-notes({ action: "write", project: "<project-name>", note: "..." })
   Record: which tools worked reliably, any failure patterns, the session
   stats summary line, anything that would have saved a retry.
```

**On including explicit tool guidance in session notes:** Adding specific tool guidance
to session notes ("use `replace-function-body` for all function edits on this file")
demonstrably reduces failures in longer sessions — the LLM follows the guidance and
reaches for better tools. It is worth doing. The side effect is narrated tool use: the
LLM announces what it is doing and why at every step, signalling that it found the
instruction and is complying. This is noisy but not harmful.

The session-notes mechanism is more effective than a static system prompt rule because
the notes are project-specific, written at the point of actual failure on the actual
codebase, and read back at session start when the LLM is forming its approach. Generic
rules in a system prompt are easier to ignore; a note that says "whitespace on
mcp-registration.js is tabs not spaces — str_replace failed 3 times because of this"
is specific enough to act on.

### Why this matters

Claude Code has telemetry but it is aggregate, deferred, and goes to Anthropic — the
running agent never sees it mid-session, and it has no awareness of the specific codebase
being edited. Cline and Cursor have nothing. In all cases the agent starts every session
with zero codebase-specific memory of what caused retries last time.

The session-notes + get-edit-stats combination is different in three specific ways:
failure data is classified per tool and per failure reason; it is written by the agent at
the point of failure in its own words; and it is read back by the same agent at the start
of the next session on the same project.

---

## Notes on patches

Unified diff / patch format is structurally the wrong tool for LLM-generated edits
because it requires correct line numbers at generation time — which the LLM cannot
reliably produce. The content-anchored tools (`str_replace` with hints,
`replace-function-body`, `replace-block`) cover the same use cases without the
line-number dependency.

`apply-patch` is best kept for human-provided patches or cases where the LLM is applying
a diff received from an external source (e.g. a git diff), not generating one itself.
