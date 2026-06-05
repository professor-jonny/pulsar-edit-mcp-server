# LLM Edit Tool — Failure Modes & Proposed Improvements

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

**Gap:** Still requires a retry call. Could be eliminated entirely with fuzzy-whitespace
commit (see proposals).

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

**Current mitigation:** `functionHint` scopes to a named function body.

**Gap:** No solution when there's no function boundary — anonymous blocks, repeated
patterns within the same function, repeated patterns across non-function scopes.

---

### 5. Off-by-one on block boundaries
**What happens:** The LLM tries to replace a function or block but gets the closing brace
wrong by one line — either including the start of the next function or leaving a stray `}`.

**Current mitigation:** `replace-function-body` does brace-matching itself so the LLM
only needs to name the function.

**Gap:** Only works for named functions. Anonymous blocks, loops, conditionals have no
equivalent.

---

### 6. Stale context / attention window truncation
**What happens:** On large files `get-document` returns so much text that by the time the
LLM is generating its edit, the top of the file has scrolled out of its attention window.
It then generates `old_str` from reconstruction rather than the actual text.

**Current mitigation:** `get-file-summary`, `read-lines`, `grep-file`, `file-line-count`
all exist to bring only relevant content into context.

**Gap:** The LLM has to choose the right tool. On very large files, even `read-lines`
over a large range can be too much. No content-anchored "give me just this region" tool.

---

### 7. Patch header line numbers (why you gave up on patches)
**What happens:** The LLM generates `@@ -47,6 +47,8 @@` from its stale mental model. Even
if the context lines are correct the diff library can reject the hunk if the header is
too far off. The fuzz factor helps but can't save it if content itself has drifted.

**Current mitigation:** `apply-patch` uses context-line anchoring with fuzz factor, tracks
failures, and suggests switching to `str_replace` or `replace-function-body` after 3
failures.

**Gap:** Patches are fundamentally the wrong format for LLM use. The failure rate is
structural, not fixable by better tooling. The current tool is best treated as a
last-resort / human-provided path.

---

### 8. Unicode character substitution in `old_str` (invisible byte mismatch)
**What happens:** The LLM generates `old_str` that looks visually identical to the buffer content but contains Unicode substitutions — smart quotes instead of straight quotes, em dash instead of hyphen, non-breaking space instead of regular space, zero-width spaces, BOM characters. The bytes don't match; the tool returns noMatch with no whitespace explanation.

**Why it's hard to debug:** The whitespace diff diagnostic does not fire (this isn't an indentation issue). The partial-match counter immediately hits zero if the mismatch is on the first character of `old_str`. The failure looks identical to a completely wrong `old_str`.

**Current mitigation (v0.10.23):** Three-layer Unicode robustness suite — `fuzzyContent:true` (normalise both `old_str` and buffer to ASCII-equivalent before matching), `lineHintFallback` (blind positional replace when `lineHint` is set), `regex:true` (treat `old_str` as a `/gm` RegExp, use `.` to wildcard suspected Unicode chars). See S14 for full detail.


---

## Proposed Improvements

### P1 — `occurrence: N` on `str_replace`
**Fixes:** Duplicate pattern confusion (failure mode 4)  
**Effort:** Low — small addition to the existing match loop  
**How:** Add an `occurrence` parameter (default 1). The existing line-by-line scan already
finds all matches; just skip the first N-1 and take the Nth.  
**Value:** Immediately fixes the most common case where the same error-handling block or
struct initialiser appears multiple times.

```
str_replace({
  old_str: "return -1;",
  new_str: "return ERR_TIMEOUT;",
  occurrence: 3          // replace the 3rd occurrence only
})
```

---

### P2 — `afterHint` on `str_replace`
**Fixes:** Duplicate pattern confusion when there's no function boundary (failure mode 4)  
**Effort:** Low — same as `lineHint` but anchor is a content string not a line number  
**How:** Search for `afterHint` string in the buffer, find its line, then begin the
`old_str` search from that point. Content-stable equivalent of `lineHint`.

```
str_replace({
  old_str: "x = 0;",
  new_str: "x = DEFAULT_VAL;",
  afterHint: "case STATE_INIT:"   // find old_str only after this landmark
})
```

---

### P3 — Fuzzy whitespace commit on `str_replace`
**Fixes:** Whitespace/indentation mismatch (failure mode 2) — eliminates the retry entirely  
**Effort:** Medium  
**How:** When exact match fails but trimmed-per-line content matches, offer two paths:
- `fuzzyWhitespace: true` flag — match ignoring leading/trailing whitespace per line,
  then apply replacement using the buffer's actual indentation (not the LLM's version)
- Or surface as a specific failure type with a one-call fix: "set fuzzyWhitespace:true
  to commit using buffer indentation"

This turns the most common failure class from **fail → read → retry** into
**fail → retry with flag**.

---

### P4 — `betweenHint` on `str_replace`
**Fixes:** Duplicate pattern confusion for content between two landmarks (failure mode 4)  
**Effort:** Medium  
**How:** Scope the `old_str` search to between two anchor strings. More precise than
`afterHint` alone. Useful for switch cases, struct blocks, `#ifdef` regions.

```
str_replace({
  old_str: "timeout = 100;",
  new_str: "timeout = CONNECT_TIMEOUT_MS;",
  betweenHint: { start: "case MODE_CONNECT:", end: "break;" }
})
```

---

### P5 — `insert-after` / `insert-before` (content-anchored insert)
**Fixes:** Line number drift on insert (failure mode 1)  
**Effort:** Medium  
**How:** Instead of `insert_line` (a number that drifts), accept an anchor string and
insert before/after its first (or Nth) occurrence. Combines with `functionHint` for
maximum precision.

```
insert({
  new_str: "LOG(\"entered loop\");",
  afterContent: "while (retries < MAX_RETRIES) {",
  functionHint: "connect_with_retry"
})
```

This is the content-anchored equivalent of `insert` — line numbers never needed.

---

### P6 — `delete-block` (content-anchored delete)
**Fixes:** Line number drift on delete (failure mode 1), off-by-one on block boundaries
(failure mode 5)  
**Effort:** Medium-High  
**How:** Given a start anchor string and an end anchor string (or brace-match mode), find
and delete the block between them. The LLM identifies the block by content, not line
numbers.

```
delete-block({
  startContent: "// BEGIN legacy path",
  endContent:   "// END legacy path"
})
```

Or brace-match mode: given a function name or opening line, delete from `{` to matching `}`.

---

### P7 — `replace-block` (generalised replace-function-body)
**Fixes:** Off-by-one on block boundaries for non-function blocks (failure mode 5)  
**Effort:** Medium-High  
**How:** Same brace-matching logic as `replace-function-body` but triggered by any anchor
string, not just a function name. Finds the next `{` after the anchor and matches to
its closing `}`.

```
replace-block({
  anchor: "if (mode == LEGACY_MODE) {",
  newBody: "if (mode == LEGACY_MODE) {\n  return handle_legacy();\n}"
})
```

---

### P8 — `get-region` (content-anchored read-lines)
**Fixes:** Stale context / attention truncation on large files (failure mode 6)  
**Effort:** Low  
**How:** Return lines between two anchor strings rather than between line numbers.
Content-stable equivalent of `read-lines`. The LLM can ask for "the HAL_Init block"
without knowing its line number.

```
get-region({
  startContent: "void HAL_Init(void) {",
  endContent:   "} // end HAL_Init"
})
```

---

## Priority Order

| Priority | Proposal | Fixes | Effort | Impact |
|---|---|---|---|---|
| 1 | `occurrence: N` on `str_replace` | Duplicate patterns | Low | High |
| 2 | Fuzzy whitespace commit | Whitespace mismatch | Medium | Very high — eliminates most common failure |
| 3 | `afterHint` on `str_replace` | Duplicate patterns (no fn boundary) | Low | High |
| 4 | `get-region` | Large file attention truncation | Low | Medium-High |
| 5 | Content-anchored `insert` | Line drift on insert | Medium | High |
| 6 | `betweenHint` on `str_replace` | Duplicate patterns (bounded) | Medium | Medium |
| 7 | `replace-block` | Off-by-one, non-function blocks | Medium-High | Medium |
| 8 | `delete-block` | Line drift on delete | Medium-High | Medium |

---

## Notes on patches

Unified diff / patch format is structurally the wrong tool for LLM-generated edits
because it requires the LLM to know correct line numbers at generation time — which it
cannot reliably do. The content-anchored tools above (`str_replace` with hints,
`replace-function-body`, and the proposed `replace-block`) cover the same use cases
without the line-number dependency.

`apply-patch` is best kept for human-provided patches or cases where the LLM is applying
a diff it received from an external source (e.g. a git diff), not generating one itself.


---

## Edit Statistics & Instrumentation

### What other tools do

**Claude Code** — has opt-in telemetry sent to Anthropic's servers. A third-party tool
(`cc-telemetry`) scrapes local session transcript files after the fact to compute overall
tool success rates. One community member built a status line script that shows a single
aggregate warning ("82% tool success") when the rate drops below 90%. That's counting
errors, not classifying why they failed. No per-tool, per-reason breakdown exists.

**Cline** — no instrumentation at all. Their failure data comes entirely from user bug
reports on GitHub, which is why the same failure modes (whitespace mismatch, SEARCH block
out of order, diff edit failed) stay open as issues for months with no resolution.

**Cursor** — no public tooling stats or failure instrumentation.

**Summary** — no existing tool has per-tool, per-failure-reason instrumentation built into
the editor server itself. The closest anything gets is a single aggregate success/fail
count scraped from logs after the session ends.

---

### What makes in-server stats different

The critical gap in all existing approaches is **failure reason classification at the
point of failure**. They know something failed. They don't know why — whitespace mismatch,
partial match, no match, out of range, wrong occurrence. That distinction is what makes
the data actionable for development.

Two additional properties make built-in stats uniquely valuable here:

**1. Queryable by the LLM mid-session**
A `get-edit-stats` tool means the LLM can see its own failure patterns during a session
and adjust strategy — e.g. "str_replace has failed 4 times on whitespace, switch to
fuzzyWhitespace mode". None of the other tools support this. They're all post-hoc
external scrapers.

**2. Completely local**
No data leaves Pulsar. No dependency on Anthropic telemetry infrastructure or third-party
services. The LLM can query it directly, reset it, and act on it in the same session.

---

### Proposed implementation

**Module-scope stats accumulator** — persists across tool calls for the session lifetime,
reset on server restart (same pattern as the existing failure counters):

```javascript
const editStats = {

  // ── str_replace ────────────────────────────────────────────────────────────
  str_replace: {
    hits: 0,
    fails: {
      noMatch:         0,  // old_str not found anywhere
      whitespace:      0,  // content matches but indentation differs
      partialMatch:    0,  // N of M lines matched then diverged
      outOfScope:      0,  // functionHint target not found in file
      betweenNotFound: 0,  // betweenHint start/end anchors not found (proposed)
      afterNotFound:   0,  // afterHint anchor not found (proposed)
      wrongOccurrence: 0,  // requested occurrence N doesn't exist (proposed)
    },
    hintsUsed: {
      functionHint:  0,    // existing
      lineHint:      0,    // existing
      afterHint:     0,    // proposed P2
      betweenHint:   0,    // proposed P4
      occurrence:    0,    // proposed P1
    },
    fuzzyWhitespaceCommits: 0,  // times fuzzy whitespace mode saved a retry (proposed P3)
    dryRunsBeforeCommit: 0,
    avgOldStrLines: 0,          // rolling average — longer blocks fail more?
  },

  // ── insert ─────────────────────────────────────────────────────────────────
  insert: {
    hits: 0,
    fails: { outOfRange: 0 },
    // anchored variants — proposed P5
    anchored: {                  // used afterContent / beforeContent instead of line number
      hits: 0,
      fails: {
        anchorNotFound:  0,      // afterContent / beforeContent string not in file
        ambiguousAnchor: 0,      // anchor matched more than once, occurrence needed
      },
      hintsUsed: {
        afterContent:    0,      // insert after this content string
        beforeContent:   0,      // insert before this content string
        functionHint:    0,      // scoped to function body
        occurrence:      0,      // Nth match of anchor
      },
    },
    dryRunsBeforeCommit: 0,
  },

  // ── delete_line_range ──────────────────────────────────────────────────────
  delete_line_range: {
    hits: 0,
    fails: { outOfRange: 0, inverted: 0 },
    // anchored variant — proposed P6 delete-block
    anchored: {
      hits: 0,
      fails: {
        anchorNotFound:   0,     // start/end content string not found
        braceMatchFailed: 0,     // brace-match mode couldn't find closing brace
      },
      hintsUsed: {
        startContent: 0,         // delete from this anchor string
        endContent:   0,         // delete to this anchor string
        braceMatch:   0,         // delete to matching closing brace
      },
    },
    dryRunsBeforeCommit: 0,
  },

  // ── replace_function_body ──────────────────────────────────────────────────
  replace_function_body: {
    hits: 0,
    fails: { notFound: 0 },
    signatureChanges: 0,         // newBody first line differs from existing signature
    dryRunsBeforeCommit: 0,
  },

  // ── replace_block (proposed P7) ───────────────────────────────────────────
  // generalised replace-function-body for non-function blocks
  replace_block: {
    hits: 0,
    fails: {
      anchorNotFound:   0,       // anchor string not found in file
      braceMatchFailed: 0,       // no { found after anchor, or unmatched braces
    },
    hintsUsed: {
      functionHint: 0,           // anchor is a function name
      anchorString: 0,           // anchor is an arbitrary content string
    },
    dryRunsBeforeCommit: 0,
  },

  // ── apply_patch ───────────────────────────────────────────────────────────
  apply_patch: {
    hits: 0,
    fails: { contextMismatch: 0, exception: 0 },
    largeEditWarnings: 0,        // patch touched >30% of file
    dryRunsBeforeCommit: 0,
  },

  // ── replace_all ───────────────────────────────────────────────────────────
  replace_all: {
    hits: 0,
    fails: { noMatch: 0 },
    dryRunsBeforeCommit: 0,
  },

};
```

**`get-edit-stats` tool** — new tool in the debugging group alongside `get-debug-log`:

```
get-edit-stats({ reset: false })
```

Returns the current session totals. `reset: true` zeroes all counters after reading.
The LLM can call this at session start, mid-session when failures cluster, or at the end
to report what happened.

**Example response:**
```json
{
  "sessionSummary": "34 edits: 28 hits (82%), 6 fails",
  "str_replace": {
    "hits": 22, "failTotal": 4,
    "fails": { "whitespace": 3, "noMatch": 1, "partialMatch": 0,
               "outOfScope": 0, "afterNotFound": 0, "wrongOccurrence": 0 },
    "hintsUsed": { "functionHint": 8, "lineHint": 2, "afterHint": 0,
                   "betweenHint": 0, "occurrence": 0 },
    "fuzzyWhitespaceCommits": 0,
    "dryRunsBeforeCommit": 5,
    "avgOldStrLines": 4.2
  },
  "insert": {
    "hits": 4, "failTotal": 0,
    "anchored": { "hits": 0, "fails": { "anchorNotFound": 0, "ambiguousAnchor": 0 } },
    "dryRunsBeforeCommit": 1
  },
  "delete_line_range": {
    "hits": 2, "failTotal": 0,
    "anchored": { "hits": 0, "fails": { "anchorNotFound": 0, "braceMatchFailed": 0 } },
    "dryRunsBeforeCommit": 0
  },
  "replace_function_body": {
    "hits": 3, "failTotal": 0,
    "signatureChanges": 1,
    "dryRunsBeforeCommit": 2
  },
  "replace_block": {
    "hits": 0, "failTotal": 0,
    "fails": { "anchorNotFound": 0, "braceMatchFailed": 0 },
    "dryRunsBeforeCommit": 0
  },
  "apply_patch": {
    "hits": 3, "failTotal": 2,
    "fails": { "contextMismatch": 2, "exception": 0 },
    "largeEditWarnings": 1,
    "dryRunsBeforeCommit": 1
  },
  "replace_all": {
    "hits": 0, "failTotal": 0,
    "dryRunsBeforeCommit": 0
  }
}
```

**Cross-session persistence (optional, later)** — append each session's stats to a JSON
file on disk with a timestamp. Even a week of normal use would build enough data to rank
the improvement proposals by actual observed failure frequency rather than intuition.

```json
[
  {
    "sessionEnd": "2026-05-24T14:32:00",
    "str_replace": { "hits": 22, "fails": { "whitespace": 3, "noMatch": 1 } },
    "apply_patch": { "hits": 3, "fails": { "contextMismatch": 2 } }
  }
]
```

---

### What the data would answer

| Question | Why it matters |
|---|---|
| What fraction of str_replace failures are whitespace? | Tells you whether P3 fuzzy whitespace commit is the highest value proposal or not |
| Do longer old_str blocks fail more? | Validates whether multiline reconstruction (failure mode 3) is a significant issue |
| Does functionHint reduce failure rate vs unhinted calls? | Validates the entire anchoring approach — if it doesn't help much, deprioritise the other hints |
| Does afterHint reduce the outOfScope / wrongOccurrence fail rate? | Validates P2 afterHint value once implemented |
| Does betweenHint further reduce duplicate pattern failures vs afterHint alone? | Tells you whether P4 is worth the added complexity over P2 |
| Does occurrence:N eliminate the wrongOccurrence fail class? | Validates P1 — should be a near-zero fail rate if working correctly |
| Do anchored inserts fail less than line-number inserts? | Validates P5 content-anchored insert — if anchorNotFound is rare, it's a clear win |
| Do failures cluster on large files? | Validates P8 get-region priority |
| What is dryRun adoption rate? | If LLMs rarely use it voluntarily, failure responses should more strongly suggest it |
| How often does replace_block anchor fail vs replace_function_body? | Tells you if the generalised block-match approach (P7) is reliable enough to use over function-scoped replacement |
| Does apply_patch fail more than str_replace? | Quantifies whether keeping apply-patch is worth the maintenance |
| How often do fuzzyWhitespaceCommits fire? | Tells you how many retries P3 is saving once implemented |

---

## Using `session-notes` and `get-edit-stats` — Recommended Workflow

Both tools are implemented and live in pulsar-edit-mcp-server. This section
documents the intended usage pattern so it can be included in project
instructions given to the LLM at session start.

### What is available

**`session-notes`** — persistent JSON file on disk, survives server restarts.
The LLM writes notes (what failed, what worked, what to do differently) and
reads them back at the start of the next session. Notes are tagged with a
`project` label so they can be filtered per codebase.

**`get-edit-stats`** — in-memory per-session counters for every edit tool:
hits, fail reasons, hint usage, dry-run count, fuzzy-whitespace commits,
average `old_str` line count. Queryable by the LLM mid-session to spot
failure clusters and adjust strategy. Resets on server restart; can be reset
manually with `reset:true`.

### Example project instructions (include in system prompt or CLAUDE.md)

```
## Session start — always do this first
1. Call session-notes({ action: "read", project: "<project-name>" })
   Read all prior notes for this project. Adjust your edit strategy based on
   what failed before — indentation style, files that hot-reload on save,
   tools that worked better than others.

2. Call get-edit-stats() to confirm counters are at zero (fresh session).
   If not, a prior session was interrupted — the non-zero counts are from
   that session and can be ignored or reset with { reset: true }.

## During the session
- If str_replace fails more than twice in a row, call get-edit-stats() to
  classify the failure mode (whitespace? partialMatch? outOfScope?) and
  adjust accordingly — switch to fuzzyWhitespace:true, widen old_str, or
  change to replace-function-body.
- Use afterHint or functionHint on every str_replace where the pattern could
  appear more than once in the file.

## Session end — always do this before closing
1. Call get-edit-stats() to read the session summary.
2. Call session-notes({ action: "write", project: "<project-name>", note: "..." })
   Record:
   - Which tools and hints worked reliably on this codebase
   - Any failure patterns encountered (e.g. "tabs not spaces", "file
     hot-reloads on save — don't save mid-edit sequence")
   - The session stats summary line (hits/fails/%) for later comparison
   - Anything that would have saved a retry if you'd known it at session start
```

### Why this closes the cross-session learning gap

Claude Code has telemetry, but it is aggregate, deferred, and goes to Anthropic
for model training — the running agent never sees it mid-session, it is not
broken down per tool or per failure reason, and it has no awareness of the
specific codebase being edited. Cline and Cursor have no in-session
instrumentation at all. In all three cases the agent starts every session with
zero codebase-specific memory of what caused retries last time.

The session-notes + get-edit-stats combination is different in three specific
ways: failure data is classified per tool and per failure reason (not just an
aggregate pass/fail count), it is written by the agent at the point of failure
in its own words, and it is read back by the same agent at the start of the
next session on the same project. The loop is local, immediate, and
codebase-specific rather than aggregate and deferred.

---

## Additional Failure Modes & Proposals (May 2026 Audit)

The following were identified by reviewing the live pulsar-edit-mcp-server
implementation against the failure modes above. Each represents a gap that
exists across all current LLM editing tools (Claude Code, Cline, Cursor) and
that a well-instrumented MCP server is positioned to solve.

---

### G1 — Insert failure reasons are unclassified

**What all tools do:** When an insert fails, tools report a generic failure.
Neither Claude Code nor Cline distinguishes between "the line number was out of
range" (stale after a prior edit) and "the anchor string doesn't exist in the
file" (wrong content). Both are reported as the same failure, or not reported
at all.

**Why it matters:** The remedies are completely different. A stale line number
means the LLM needs to re-read the file. An anchor string not found means the
LLM constructed the wrong anchor. Conflating them forces a full read-and-retry
regardless of cause, adding a wasted tool call every time.

**What a smart server can do:** Classify at the point of failure and return a
targeted error — "anchor `afterContent` not found" vs "line number out of
range (file has N lines, you passed M)". The failure response tells the LLM
exactly what kind of retry is needed, with the minimum context to fix it
immediately.

**Stats angle:** Separate counters for `anchorNotFound` vs `outOfRange` in
insert stats let you measure which failure mode actually dominates in practice
— and therefore which mitigation is worth building first.

---

### G2 — Edit failure diagnostics don't cover the size of what failed

**What all tools do:** When a str_replace or equivalent fails, tools report
that the match wasn't found. None of them record or report how long the
`old_str` was. The LLM has no feedback on whether it is consistently failing
on short strings (likely a typo or whitespace issue) or long blocks (likely
memory reconstruction divergence).

**Why it matters:** Failure mode 3 (multiline reconstruction from memory)
gets worse as `old_str` length increases — the LLM is more likely to paraphrase
a comment or drop a blank line in a 20-line block than in a 3-line one. But
without size data split by outcome, this is intuition not measurement.

**What a smart server can do:** Track average `old_str` line count separately
for hits and fails. If `avgOldStrLinesFails` is consistently much higher than
`avgOldStrLinesHits`, the data confirms that long blocks are the problem and
that the right mitigation is smaller, more targeted edits — not better
whitespace handling.

**Stats angle:** Two accumulators — one incremented on success, one on failure
— answer the question "do longer old_str blocks fail more?" with real session
data rather than intuition.

---

### G3 — No tool tracks whether compound hints reduce failures

**What all tools do:** None of the existing tools (Claude Code, Cline, Cursor)
have any hint system at all. Even in servers that do implement hints
(`functionHint`, `occurrence`), the hints are tracked individually — so you
can see that `functionHint` was used N times, but not whether using
`functionHint` together with `occurrence:N` (the most precise targeting mode)
performs better than either alone.

**Why it matters:** If the compound combination eliminates the
`wrongOccurrence` fail class, that's strong evidence that teaching the LLM
to always use both when targeting a repeated pattern is worth the prompt cost.
If it doesn't, the complexity is wasted.

**What a smart server can do:** Track the hint combination as a unit — one
counter for `functionHint alone`, one for `occurrence alone`, one for both
together. Three numbers answer whether precision stacks additively.

---

### G4 — Session memory doesn't persist or filter across projects

**What all tools do:** Claude Code has telemetry but it is aggregate and feeds
back into model training — the running agent has no access to it during a
session and it carries no codebase-specific context. Cline and Cursor have no
session memory mechanism at all. In all cases the agent starts every session
from scratch with no knowledge of what caused retries on this specific project
last time.

**Why it matters:** Repeated failures on the same file or pattern across
sessions are invisible. The agent re-fails from scratch every time. A session
that ended with "whitespace on this file is tabs not spaces" is completely lost
by the next session.

**What a smart server can do:** Persist notes written by the agent across server
restarts, keyed by project. At session start the agent reads its own prior
notes and adjusts strategy before making the first edit. Filtering by project
on read means notes from unrelated codebases don't add noise. The data is
per-tool and per-failure-reason, not aggregate — so the agent knows exactly
which tool failed and why, not just that something went wrong.

---

### G5 — No way to read a function body by name before replacing it ✅ IMPLEMENTED (v0.10.0+)

**What all tools do:** To replace a function body without corrupting its
signature, the LLM must first read the current signature. In all existing
tools this requires either loading the full file (expensive on large files) or
using a grep/search tool and then reading the surrounding lines (two tool
calls, and the LLM still has to identify the function boundaries manually).

**Why it matters:** `replace-function-body` (or equivalent whole-function
rewrite tools) carry a silent risk: if the LLM reconstructs the signature from
memory rather than reading it, it can silently change the function's interface.
The tool has no way to detect this without a prior read.

**What a smart server can do:** Expose a `get-function-body` tool that accepts
a function name and returns the exact current lines — signature through closing
brace — using the same brace-matching logic already used for replacement. The
LLM reads the exact signature in one targeted call, then writes back a
replacement that is guaranteed to include it. Eliminates the silent-signature-
change failure class at the cost of one cheap tool call.

**Effort:** Very low in a server that already has brace-matching infrastructure
— it is the read half of `replace-function-body` exposed as its own tool.

---

### G6 — Edit failure rates are never measured across sessions ✅ IMPLEMENTED

**What all tools do:** No existing tool measures its own edit success rate in a
form the LLM can query. Claude Code has opt-in telemetry sent to Anthropic;
a third-party scraper can compute an aggregate success rate from transcripts
after the fact. Cline and Cursor have nothing. None of them give the LLM
access to its own performance data during a session, and none persist it across
sessions.

**Why it matters:** Without cross-session data, proposal priority is guesswork.
The priority table in this document (P1 > P2 > P3 > …) is based on reasoning
about which failure modes are most common — but real usage data might show that
`partialMatch` is far rarer than `whitespace`, or that `apply_patch` fails at
five times the rate of `str_replace`. That would immediately reprioritise
which mitigations to build.

**What a smart server can do:** When the LLM resets the session stats counter,
append the completed session's report (with a timestamp) to a JSON file on
disk before zeroing. Over weeks of normal use this builds a dataset that ranks
failure modes by observed frequency, validates whether implemented mitigations
actually reduced their target fail class, and surfaces regressions when a code
change makes things worse. No external tooling required — the data collection
is inside the server and the LLM can query the history directly.

**Implemented:** `get-edit-stats({ reset: true })` flushes the session counters
into a `lifetime` block persisted in `edit-stats.json`, increments `sessionCount`,
and zeroes session counters. The lifetime block accumulates across all sessions and
survives server restarts. The LLM can read both session and lifetime totals in the
same call — session for immediate mid-session strategy adjustment, lifetime for
cross-session trend analysis. This is functionally equivalent to the proposed
timestamped log without the external file management overhead.

**0.7.1 gap fix:** The initial implementation only instrumented edit tools. `grep-file`,
`grep-project`, `search-symbol`, `replace-document`, and `replace-across-files` were
absent from `editStats` entirely — invisible to `get-edit-stats` and excluded from
allHits/allFails totals. This meant the session success rate was understated (search
hits not counted) and search `noMatch` failures were silently dropped. All five tools
are now fully tracked with appropriate fail classes (`noMatch` for search tools,
`skipped` for `replace-across-files`) and hint usage fields (`occurrence`,
`contextLines`) where applicable. A dead `hintsUsed` block on `get_selection` (which
has no hint params) was also removed.

---

## Implemented Strategies (May 2026)

The following strategies were designed, implemented, and validated during the May 2026
development session. They address failure modes that were previously identified but not
fully solved, and introduce entirely new categories of protection. S1–S5 were completed
in the first phase of the session; S6 was added in the second phase after all nine edit
tools were instrumented with linter feedback. S7 covers reliability fixes to the lifetime
stats persistence pipeline completed in the third phase of the session.

---

### S1 — Ambiguity guard: block before wrong-occurrence commit

**Problem being solved:** LLMs generate `old_str` from memory of what they read. Common
short patterns (`return null`, `if (!editor)`, `const buffer = editor.getBuffer()`,
callback names) appear dozens of times in a file. The LLM picks one confidently, hits
the wrong occurrence, and silently corrupts the file. The previous tool never detected
this — it simply replaced occurrence 1.

**Why earlier approaches were insufficient:** `occurrence:N` and `functionHint` both
exist, but they require the LLM to *know* that the pattern repeats and to pre-emptively
use them. The LLM frequently doesn't know — it reads a section of the file, forms a
mental model of that region, and assumes its `old_str` is unique.

**Strategy implemented:** Before committing, `str_replace` counts all occurrences of
`effectiveOldStr` in the full file. If `totalMatches > 1` AND no scope hint is set, the
edit is **blocked** with a `⚠️ AMBIGUOUS MATCH` response that lists every matching line
number. The LLM must then specify a hint before the edit proceeds. Scan capped at 20
matches for performance. `occurrence > 1` disables the guard (caller is deliberately
targeting a specific match).

The same guard was extended to `replace-block`, `replace-function-body`, and
`delete-block` via a shared `ambiguityCheck()` helper. For `replace-function-body`,
`getSymbols()` (tree-sitter backed) counts definition-level occurrences only — not call
sites. The old `name\s*\(` regex scan was replaced in v0.10.20 as part of the full
tree-sitter migration.

**Why the guard belongs in the tool, not the prompt:** Prompt instructions like "always
check for duplicates before editing" are forgotten mid-conversation. Tool-enforced
blocking fires unconditionally at the exact moment the mistake would have been made.

---

### S2 — Smart suggestion engine: feedback at the moment of failure

**Problem being solved:** The previous failure suggestion system fired after 3
consecutive failures — by which point the LLM had already made 2 wrong calls and was
likely looping. The suggestions appeared in the response for the 3rd failure, after the
damage to in-context reasoning had already occurred.

**Why timing matters:** Research on LLM in-context behaviour shows that corrective
feedback is most effective when it appears in the same response as the failure that
prompted it. Delayed feedback (after N attempts) leaves the LLM reasoning about why the
previous retries also failed, rather than about what the right tool is.

**Strategy implemented:** `smartSuggestion(ctx)` fires on **failure #1**:
- If no hints were used → lists the specific hints that apply, with concrete syntax examples
- If `old_str` looks like a whole function (has `{` near the end) → suggests `replace-function-body`
- If `old_str` looks like a brace block → suggests `replace-block`
- If the file has >500 lines AND no hints were used → adds explicit file-size urgency text
- Escalates to tool-switch suggestions at failure #2 (not #3)

`successNudge(ctx)` is appended to `str_replace` **success** responses when no hints
were used on a file >300 lines. It tells the LLM which hints to use next time and, if
`old_str` looks like a function, explicitly says to use `replace-function-body` instead.
This closes the feedback loop before failures start — not after.

**Why both failure and success nudges are needed:** A failure nudge corrects the
immediate error. A success nudge trains the next call before it has a chance to fail.
Together they create a reinforcement loop within a session.

---

### S3 — Schema/handler uniformity: hints must be in inputSchema to be usable

**Problem being solved:** A schema mismatch was found where `delete-line-range` had
`dryRun`, `functionHint`, `afterHint`, `lineHint`, `betweenHint`, `occurrence`, and
`fuzzyWhitespace` fully implemented in its handler, but **none** of them were declared
in `inputSchema`. The LLM could never pass these parameters — they were silently dropped
by the Zod validator before the handler received them.

**Why this is an invisible bug class:** The handler worked correctly when tested with
manually constructed calls that bypassed schema validation. The tool appeared functional.
Only by auditing the schema against the handler did the mismatch surface. An LLM
attempting to use `delete-line-range functionHint:"someFunction"` would simply receive a
result as if no hint were specified — no error, no warning, no indication that the hint
was ignored.

**Strategy implemented:** A systematic audit matrix was constructed covering all edit
tools and verifying that `hints`, `dryRun`, `fuzzyWhitespace`, and `occurrence` were
present in both `inputSchema` and the handler wherever they were intended to be
supported. The matrix is now part of the session notes so future tool additions are
checked against it.

**Audit matrix (edit tools):**

| tool | hints | dryRun | fuzzy | schema matches handler |
|---|---|---|---|---|
| `str_replace` | YES | YES | YES | YES |
| `insert` | YES | YES | NO | YES |
| `delete-line-range` | YES | YES | NO | FIXED (was broken) |
| `delete-block` | YES | YES | NO | YES |
| `replace-block` | YES | YES | YES | YES |
| `replace-function-body` | YES | YES | YES | YES |
| `replace-all` | NO | YES | NO | YES |
| `sed` | fn only | YES | NO | YES |
| `apply-patch` | NO | YES | NO | YES |

---

### S4 — `read-lines` hint-based resolution: eliminate line-number dependency

**Problem being solved:** `read-lines` required `startLine`/`endLine` — line numbers
that drift every time a prior edit adds or removes lines. The LLM reads the file at turn
N, forms a mental model with line numbers, then by turn N+3 those numbers are wrong. Any
`read-lines` call based on that stale model returns the wrong region.

**Strategy implemented:** All parameters are now optional. New resolution modes were
added that anchor by content rather than position:
- `functionHint` — resolve the named function via tree-sitter (live buffer) or `getSymbolsFromText` regex fallback (closed files); uses `sym.startRow`/`sym.endRow` directly — no brace-counting needed
- `afterHint` — lines starting after the first occurrence of an anchor string
- `betweenHint` — lines between two anchor strings
- `centerLine`+`radius` — window around a specific line (useful when the line number
  is known from a prior tool response in the same turn)
- `lineHint` — alias for `centerLine` with radius defaulting to 10

This makes `read-lines` content-stable by default — the LLM can ask for "the body of
`handleAuth`" rather than "lines 247–298".

---

### S5 — Dynamic UI stats panel: tool list derived from live editStats

**Problem being solved:** The Pulsar UI stats panel (`showEditStats()`) used a hardcoded
list of 14 tool names. As tools were added (`find_text`, `delete_block`, `sed`) and
removed (`get-surrounding-context`), the panel silently showed stale entries.

**Strategy implemented:** The hardcoded array was replaced with
`Object.keys(editStats.session)` — the panel now always reflects exactly the tools that
are currently instrumented, with no manual sync step required. This eliminates an entire
class of maintenance bug where the stats display is accurate but the UI omits or
misnames tools.

---

### S6 — `lint: true`: inline linter feedback at the point of edit

**Problem being solved:** After making an edit, verifying that it introduced no new
errors required a separate `get-diagnostics` tool call — an extra round trip in every
edit-verify cycle. On complex edits this adds latency and breaks the flow of reasoning:
the LLM commits the edit, then has to plan and execute a follow-up diagnostic call before
it can assess whether the change was correct.

No existing tool (Claude Code, Cline, Cursor) bundles linter feedback into the edit
response itself. All require a separate read step after writing.

**Why the separate call is a real cost:** Each tool call is a discrete reasoning step.
An edit followed by a diagnostic check followed by a fix is a 3-step loop. If the error
is predictable from the edit (a missing import, a wrong type, a renamed symbol), bundling
the lint result into the edit response collapses it to 1 step — the LLM sees the error in
the same response as the commit and can correct immediately without an intermediate call.

**Strategy implemented:** All nine edit tools (`str_replace`, `replace-function-body`,
`replace-block`, `insert`, `delete-line-range`, `delete-block`, `apply-patch`,
`replace-all`, `sed`) accept a `lint: true` parameter. When set:

- A `lintSnapshot(editor, startRow, endRow)` helper is called after the edit commits
- It queries `linter-bundle`'s live buffer diagnostics (no save required — linter-bundle
  fires on `onDidChange` debounced ~300ms)
- Results are filtered to errors + warnings only, scoped to the rows touched by the edit
  (±5 lines for precision tools; whole-file for `apply-patch`, `replace-all`, `sed` which
  touch arbitrary locations)
- The snapshot is appended inline to the tool's success response:
  `⚠️ lint (2): [L47] error — 'g_hal' undeclared | [L83] warning — 'retries' unused`
- Silent when clean (no output pollution on successful edits)
- Silent when linter-bundle is not active (safe on all project types including pure C
  with compiler-only workflows)

**Why opt-in, not always-on:** Projects without linter-bundle would receive silent null
returns on every edit with no indication of why — adding noise and confusion. Opt-in
keeps the default output clean; developers enable it per-call when they want verification.

**Why the ±5 row padding on scope:** Compiler errors are reported at the first-use line,
which may be just outside the directly edited range. Tight scoping (exact edit rows only)
would miss cascade errors. Five lines of padding catches the common case without becoming
a whole-file diagnostic dump on every edit.

**Cross-tool comparison:** Neither Claude Code, Cline, nor Cursor bundle diagnostics into
edit responses. The closest approximation is Claude Code's background `getDiagnostics`
call after a write — but this is asynchronous, not returned in the same response, and
requires the LLM to make a separate read call if it wants to act on the result in the
same turn.

---

### S7 — Lifetime stats pipeline: failure classification and persistence reliability

**Problem being solved:** Three independent bugs in the lifetime stats pipeline meant that
cross-session data was silently lost on almost every session:

1. **Wrong fail counter on ambiguity blocks.** The ambiguity guard (S1) was bumping
   `fails.partialMatch` instead of `fails.ambiguous`. The `ambiguous` field was present in
   the initializer but never written to. Ambiguity-blocked calls appeared in the stats as
   partial-match failures, making it impossible to distinguish the two failure classes.

2. **`mergeInto()` dropped disk data for any key not in the current schema.** On startup,
   disk data was merged into the in-memory initializer by iterating `Object.keys(target)`
   (the schema). Keys on disk but not in the current schema were silently ignored. Adding
   a new tool to `editStats` and then reverting it would silently wipe all lifetime data
   for that tool. The iteration direction was wrong: disk should be authoritative.

3. **`deactivate()` was never called.** `mcp-registration.js` exported a `deactivate()`
   function that synchronously flushes lifetime stats on clean package reload. It was
   never imported by `pulsar-edit-mcp-server.js` — Pulsar calls `deactivate()` on the
   main package file, not on required modules. Any session shorter than the flush interval
   (60 s) wrote nothing to disk. On the next startup `mergeInto` loaded stale or empty
   data, then the interval timer fired and overwrote the disk file with zeros.

**Why these bugs were invisible:** Each bug was in a different layer (stats accounting,
startup merge, package lifecycle). None produced errors or warnings. The stats appeared
to work — `get-edit-stats` returned values, the disk file existed — but lifetime data
was either miscounted, lost on restart, or both. Only by correlating session totals
against disk file contents across multiple restarts did the pattern become clear.

**What makes this failure class worth documenting:** The bugs are a template for a broader
class of "silent data loss on clean shutdown" bugs that affect any stateful MCP server.
The three root causes — wrong key counted, wrong iteration direction, unhooked lifecycle
callback — are generic. Any future stateful tool that persists across restarts should
audit all three: (a) are fail counters bumping the right key, (b) is the merge direction
disk-authoritative, (c) is `deactivate()` actually wired to the package lifecycle.

**Fixes applied (0.7.2):**

- `fails.ambiguous` is now the correct bump target in the ambiguity guard. `ambiguous`
  is included in `Object.values(fails)` used by `allFails` reduce — no change to totals.
- `mergeInto()` now iterates `Object.keys(src)` (disk data). Disk values take precedence;
  schema keys absent from disk default to 0. Forward-compatible with schema additions.
- `loadMcpModules()` captures `reg.deactivate` into `mcpDeactivate`. The package-level
  `deactivate()` calls `mcpDeactivate()` as its first action. Flush is synchronous —
  Pulsar waits for `deactivate()` to return before completing the reload.
- Flush interval reduced 60 s → 5 s as a crash safety net (primary flush is still
  `deactivate()` / `beforeunload`).
- `resetEditStats()` (both exported function and MCP handler) replaced hardcoded tool
  list with `Object.entries(editStats)` loop — self-maintaining, no manual sync needed
  when tools are added or removed.

**Stats angle:** `fails.ambiguous` is now a measurable, distinct failure class. Over
multiple sessions the ratio of `ambiguous` to `partialMatch` to `noMatch` will show
whether callers are being stopped before wrong-occurrence commits (S1 working), are
failing on content mismatch (most common before hints), or are simply using the wrong
`old_str` entirely. These three classes have different remedies and their relative
frequency should drive which guidance to emphasise in tool descriptions.

---

### S8 — `checkpatch`: full-file style audit to enforce file uniformity

**Problem being solved:** LLM-generated edits can introduce whitespace inconsistencies into
C files — mixing tabs and spaces, wrong indentation depth, trailing whitespace. These
violations don't change semantics and don't trigger compiler errors, so they accumulate
silently across many edits. The consequences are twofold:

1. **Style non-conformance**: kernel coding style (`checkpatch.pl`) failures for any file
   destined for a kernel or embedded workflow.

2. **Degraded `fuzzyWhitespace` matching**: the `fuzzyWhitespace:true` mode on `str_replace`
   works by matching content while ignoring per-line indentation — it then commits using the
   buffer's actual whitespace. This works reliably when the file is **uniform**: every line
   uses the same style, so the "buffer's actual whitespace" is a predictable substitute for
   what the LLM wrote. In a mixed file (some lines tabs, some spaces), the same token can
   have different real whitespace at different occurrence sites. The substitution becomes
   ambiguous and the tool may commit with the wrong indentation for the context.

**Why the inline per-edit check (in `get-edit-stats`) is insufficient alone:**
The inline style check fires per edit and records violations introduced **in the lines
that edit wrote** — it never scans pre-existing file content. This is intentional: you
want to know if *you* made things worse, not be flooded with noise from code you didn't
touch. But it creates a blind spot: a file that already has 50 style violations when you
open it will show zero inline violations until you touch those lines. The inline stats
cannot tell you about the pre-existing baseline, or give you a holistic view of the
current style state before starting a series of edits. An LLM that takes over a file
with 30 existing violations from a previous session has no way to know this from
per-edit stats alone.

**Strategy implemented:** A standalone `checkpatch` tool audits the entire file in one
call. It runs the same `styleCheckLines()` checker used for inline edit checking but
against the full file content, groups results by rule sorted by frequency, and caps
output at 20 per rule to prevent flooding. Non-.c/.h files are silently skipped so the
tool is safe to call from any context.

**Two complementary views:**

- **Inline per-edit style check** (in `str_replace`, `insert`, etc.) — measures
  violations *introduced* by a specific edit. Useful for steering the LLM away from
  producing bad whitespace in the first place.
- **`checkpatch` whole-file audit** — measures the *current style state* of the file.
  Useful at session start (understand what you're working with), after a series of edits
  (verify the file is still clean), or when `fuzzyWhitespace` starts behaving
  unexpectedly (diagnose whether the file has become non-uniform).

**The file uniformity principle:** A file where every line follows the same whitespace
convention is predictable. `fuzzyWhitespace` substitution is reliable, hint-based
anchoring is stable, and the LLM's mental model of "the indentation at this site" is
consistent. Running `checkpatch` and fixing violations before a major edit sequence
restores this property. The tool is therefore not just a style linter — it is a
pre-condition checker for high-confidence content-anchored editing.

**Stats tracked:** `_checkpatchRuns` and `_checkpatchViolations` are accumulated in
`styleStats` alongside the inline edit tracking counters. `get-edit-stats` returns them
in the `styleChecks` object and includes both in the `sessionStyleSummary` string:
`"inline: N edits checked ... | checkpatch: N run(s), N violations found"`. This allows
direct comparison: if checkpatch violations are consistently higher than inline violations
introduced, the file was already dirty when the session started and needs a cleanup pass.

---

### S9 — `singleline_if` rule: catching LLM-generated kernel style violations

**Problem being solved:** LLMs trained on mixed codebases produce syntactically valid C that nonetheless violates Linux kernel coding style in consistent, predictable ways. Two patterns observed directly during development:

1. **Single-line `if` bodies:** `if (!g_hal) return -1;` — kernel style requires the body on the next line even for single-statement guards. LLMs produce this habitually because it is common in non-kernel C.

2. **Doxygen-style file headers:** `@file` / `@brief` tags are standard Doxygen but not kernel style. Kernel code uses plain `/* */` block comments.

Neither is caught by the compiler or linter. Both pass all mechanical whitespace checks. They are pattern-choice violations, not formatting accidents.

**Why this is a distinct failure class:** Tabs-vs-spaces is a formatting accident — the pattern is right but the whitespace is wrong. A single-line `if` body is a wrong pattern chosen habitually. The LLM reaches for it because training data is dominated by application C where it is accepted. Prompt-level instructions help but are forgotten mid-session; a rule that fires at the point of introduction is more reliable.

**Strategy implemented:** A `singleline_if` CHECK rule was added to `style-checker.js`. It detects `if`/`else`/`for`/`while` followed by `)` and a non-brace statement token on the same line, without a full parser. Fires on inline per-edit check and on `checkpatch` whole-file audit. Severity CHECK (not WARNING) because a small number of kernel subsystems permit the form in specific macro contexts — the LLM is informed but not blocked.

**Stats tracking:** `singleline_if` is tracked in `styleStats` / `lifetimeStyleStats` via the self-maintaining `Object.keys` reset loop. The `introduced` counter over sessions will show whether the rule is reducing the frequency — if it remains high, session notes should push harder on the convention at the start of kernel C sessions.

**The broader pattern:** Any LLM doing kernel or embedded C work will produce this violation class. The full mitigation stack is: (a) `singleline_if` rule catches it at introduction time, (b) `checkpatch` at session start reveals the pre-existing baseline, (c) session notes record codebase-specific style conventions so the LLM reads them before writing the first line.

---

### S10 — `str_replace` fails silently on backtick-heavy markdown lines

**What happened:** Attempting to append content to the end of `LLM-FAILURE-MODES.md` using `str_replace` with `old_str` containing inline code spans (backtick-wrapped text like `` `"inline: N edits checked ..."` ``) failed with no match, even though the line was visually correct in context. Two consecutive attempts failed.

**Root cause:** The `old_str` passed to `str_replace` contained backtick characters that interacted with the tool's internal string handling or the Zod schema's string parsing, causing the effective search string to differ from what was intended. The line existed in the file but the match never fired.

**Fix:** Switch to `insert` with `afterContent` anchored to a nearby plain-text line that contains no backticks or special characters. `insert` with `afterContent` does a simple substring search and is not affected by the same escaping issues.

**Rule:** When `str_replace` fails on a markdown line that contains inline code spans, do not retry with the same `old_str`. Switch immediately to `insert` with a plain-text `afterContent` anchor from a surrounding line, or use `insert_line` with a line number from `grep-file`.

---

### S11 — `insert` at true end-of-file times out on large files

**What happened:** Calling `insert({ insert_line: 1091, new_str: "..." })` on a 1091-line file (inserting at the last line) caused the MCP server to time out after 4 minutes with no result.

**Root cause:** `insert_line` at EOF on a very large file triggers an edge case in the buffer insertion path — likely the line-count validation or the surrounding-context scan hits a performance cliff when the target line equals the file length. The server did not crash; it simply never returned.

**Fix:** Use `afterContent` anchored to a unique string near the end of the file rather than `insert_line` at EOF. The content-anchored path does not have the same performance issue. For a file where the last meaningful line is unique, `afterContent` on that line is both faster and more robust.

**Rule:** Never use `insert_line: N` where N equals or approaches the file's line count on files >500 lines. Always use `afterContent` with a unique anchor near the target location instead.

---

### S12 — `get-repo-map`: solving context starvation on large multi-file projects

**Problem being solved:** At the start of a session on an unfamiliar or large codebase, the LLM has no map of what exists where. The instinct is to call `read-file` on the most likely file — but on a 6500-line file like `mcp-registration.js` that consumes most of the context window before any editing begins. Alternatively, the LLM guesses function names and file locations, leading to `grep-project` misses and repeated orientation calls.

**Why the existing tools were insufficient:** `list-project-functions` lists every function across all files but returns too much raw data — no ranking, no sense of which functions are architecturally important vs utility helpers. `grep-project` requires knowing what to search for. Neither gives a prioritised overview in a fixed token budget.

**Strategy implemented:** `get-repo-map` produces an Aider-style compressed codebase index that fits within a configurable token budget (default 1024 tokens). It works in three stages:

1. **Symbol extraction** — tree-sitter via Pulsar's WASM layer for any file open in an editor tab (accurate full signatures); regex fallback for closed files.
2. **PageRank ranking** — builds a directed file→file reference graph weighted by `sqrt(ref_count)`. Runs 20-iteration power-iteration PageRank with optional `mentionedFiles` personalisation (50× boost for files the LLM is currently working on). The most cross-referenced, architecturally central symbols float to the top.
3. **Token-budget rendering** — binary search finds the maximum number of symbols that fit within the budget. Output uses `│` prefix per symbol and `⋮...` ellipsis between non-consecutive lines, exactly matching Aider's TreeContext format.

**Why this belongs in the tool layer:** The LLM cannot self-correct context starvation — it cannot know what it doesn't know. A tool that automatically surfaces the most important symbols ranked by actual cross-file reference density solves orientation at the infrastructure level. The `mentionedFiles` boost means the map re-centres itself around the current working area as a session progresses.

**`excludeGlob` — preventing shadow-copy pollution:** Projects with baseline or backup directories (e.g. `.mcp-baseline/`) contain copies of the same files. Without filtering, `get-repo-map` would double every symbol and PageRank would be meaningless. The `excludeGlob` param (e.g. `excludeGlob: "**/.mcp-baseline/**"`) applies after the include `glob` filter using the same `globToRegex` helper used by every other project-wide tool, giving consistent behaviour across the tool suite.

**Rule:** Call `get-repo-map` with `excludeGlob` set for any project that has backup or vendor directories before beginning work on an unfamiliar session. Pass the files currently being edited as `mentionedFiles` to re-rank around the current context.


### S13 — Tree-sitter migration: eliminating regex function-matching failures (v0.10.20–v0.10.21)

**Problem being solved:** A large class of `replace-function-body`, `functionHint`, `afterHint`, and `betweenHint` failures traced back to a single root cause — function detection and anchor resolution were built on regex. Several failure modes resulted:

- `replace-function-body` notFound on `registerTool`/arrow-function patterns that the `(?:^|\s)name\s*(` regex never matched
- `functionHint` scoping finding the wrong occurrence when a function name appeared as both a definition and multiple call sites
- `afterHint:"fn_name"` resolving to the first *character* occurrence of the string rather than the *end* of the function — causing insert-after-function to land inside the function body
- `betweenHint` spanning from raw string position to raw string position, not function-to-function semantically
- `list-functions`, `search-functions`, `get-function-body`, `get-repo-map`, `list-project-functions` all using separate inline regex loops with inconsistent `FN_DEF_RE` definitions

**Strategy implemented (v0.10.20–v0.10.21):** A new `lib/tree-sitter-symbols.js` module was built and all 9 regex-based function-matching sites were migrated to it:

- `getSymbolsFromEditor(editor)` — tree-sitter via `rootLanguageLayer.tree` + `tagsQuery`. Walks `definition.*` + `name` captures. `endRow` from `node.endPosition.row` — exact, no brace-counting.
- `getSymbolsFromText(text, filePath)` — regex fallback (`C_FN_RE`, `JS_FN_RE`, `REGISTER_TOOL_RE`) for closed files or unsupported grammars. Used by `naming-checker.js` and `list-project-functions`.
- `findFunction(symbols, name, hints)` — filters by name + `occurrence`/`lineHint`/`afterRow`/`betweenRows` hints. Ambiguity returned as a structured result, not silently resolved.
- `resolveAnchor(hint, symbols, text)` — three-stage resolution: (1) exact symbol name → `sym.endRow` [symbolEnd], (2) pure integer → lineNumber, (3) `text.indexOf` scan with uniqueness check. Ambiguity fires at both symbol and string level, returns `{row, via, ambiguous?, matches?}`.

**Key behaviour changes visible to the LLM:**
- `afterHint:"fn_name"` now resolves to the **end** of that function (`sym.endRow`), not the first character occurrence. Insert-after-function semantics are now correct.
- `betweenHint:{start:"fn_a", end:"fn_b"}` now spans from end of `fn_a` to end of `fn_b` — function-to-function, not string-to-string.
- Ambiguous hints return an error with a list of matches rather than silently picking the first.
- `replace-function-body` `notFound` should now be near-zero for valid function names. If it fires, the function genuinely doesn't exist in that file.
- All 9 function-search tools (`list-functions`, `search-functions`, `get-function-body`, `get-function-list-with-comments`, `list-project-functions`, `get-file-summary`, `get-structural-anchors`, `read-lines` functionHint path, `str_replace` functionHint path) now use the same tree-sitter backend — consistent results across all tools.

**What is intentionally NOT migrated:** `GHIDRA_FUNC_RE` in `mcp-registration.js` — decompiled C placeholder names (`FUN_xxxxxxxx`, `DAT_`, `PTR_`) have no tree-sitter grammar. Regex is correct here.

**Stats expectation:** The `replace-function-body` `notFound:10` in the v0.10.22 baseline snapshot (session 12) was entirely from the regex era. Post-migration sessions should show `notFound` approaching 0. `str_replace` `noMatch` and `whitespace` failures should also drop as better `functionHint` scoping reduces the search space.

**Full tool audit passed:** All tools verified against `test/hal.c` and `test/test.c` in v0.10.22. `get-structural-anchors` scope bug (stale variable names from migration) was the only post-migration issue, fixed in v0.10.22.

### S14 — Unicode mismatch in `old_str`: silent noMatch failures from invisible character substitution (v0.10.23)

**Problem being solved:** A persistent class of `str_replace` `noMatch` failures had no whitespace explanation and no partial match — the tool reported no hit, but the text was visually correct. These failures were not surfaced by the existing whitespace diff diagnostics because the mismatch was not indentation: the actual characters in `old_str` differed from the buffer at the byte level. The LLM had no way to detect this from the failure response.

**Root cause — how LLMs generate Unicode substitutions:** LLM tokenisers process text through byte-pair encoding. During generation, a model that "sees" a straight double quote `"` may produce a left or right smart quote (`"` U+201C / `"` U+201D) depending on the surrounding context — especially in natural-language fragments like comments, docstrings, or string literals that resemble prose. Similarly, an em dash (`—` U+2014) may appear in place of `--` or a hyphen, a non-breaking space (U+00A0) may replace a regular space inside formatted output, and zero-width spaces (U+200B) may be silently inserted at word boundaries. The buffer was written with straight ASCII characters; the LLM's `old_str` contained Unicode substitutions. The bytes did not match. The match failed. No error, no warning.

**Character classes affected:**

| LLM generates | Instead of | Unicode |
|---|---|---|
| Smart double quote `"` `"` | Straight `"` | U+201C / U+201D |
| Smart single quote `'` | Straight `'` or apostrophe | U+2019 |
| Em dash `—` | Hyphen-minus `-` or `--` | U+2014 |
| En dash `–` | Hyphen-minus `-` | U+2013 |
| Non-breaking space | Regular space | U+00A0 |
| Zero-width space | Nothing (invisible) | U+200B |
| Soft hyphen | Nothing (invisible) | U+00AD |
| BOM | Nothing (file start) | U+FEFF |
| Emoji / surrogate pairs | (varies) | U+D800–U+DFFF |

**Why the existing diagnostics did not catch it:** The whitespace diff reporter (failure mode 2 mitigation) compares trimmed-per-line content — if trim() removes the mismatch, the diagnostic fires. Unicode substitutions inside a line are not trimmed and the diagnostic does not fire. The partial-match counter counts consecutive matching lines; a Unicode mismatch on line 1 of `old_str` immediately produces a 0-line partial match, which is indistinguishable from a completely wrong `old_str`.

**Strategy implemented — three-layer Unicode robustness suite (v0.10.23):**

**Stage 1 — `fuzzyContent:true` (normalisation-based matching):**
Both `old_str` and the buffer search region are normalised to ASCII-equivalent before matching: BOM, zero-width/soft-hyphen stripped; NBSP → space; smart single/double quotes → straight; en/em dash → hyphen; surrogate pairs (emoji) → empty string. Match found on the normalised string; replacement slices from the **original** buffer at the discovered position — buffer content is preserved exactly, only the search is normalised. New stat: `fuzzyContentCommits` — counts how often this path saved a retry. Requires `fuzzyContent: true` in the tool call.

**Stage 2 — `lineHintFallback` (position-based auto-rescue):**
When exact match fails AND `lineHint` is set and in bounds, the handler falls back to a direct positional replace at the hint row — no content matching required. Designed for the case where the LLM knows the exact target line from a prior `grep-file` result but the buffer content contains unpredictable Unicode. The fallback replaces `old_str.split('\n').length` lines from `lineHint` with `new_str`. Success response tagged `[lineHintFallback]` to signal the caller. New stat: `lineHintFallback`. **Caution:** a wrong `lineHint` will silently corrupt — this path is encoding-agnostic by design, and the tag in the response is the only signal. Always confirm the line number from a `grep-file` result in the same session turn before relying on it.

**Stage 3 — `regex:true` (pattern-based escape hatch):**
Treats `old_str` as a JavaScript `/gm` regular expression. Use `.` to wildcard single problematic characters (em dash, smart quotes), `.*` for spans of uncertain content, `\*` for literal asterisk. Invalid patterns return a clean error with the JS error message. Success/dryRun responses tagged `[regex]`. New stat: `regexCommits`. When both `regex:true` AND `lineHint` are set and the regex finds no match, Layer 2 (`lineHintFallback`) fires — `lineHint` is the stronger signal. To force regex-only, omit `lineHint`.

**Precedence and fallback chain:**
```
P1 (exact)        — try exact indexOf match in search window
P2 (occurrence)   — apply occurrence:N selection to exact matches
P3 (fuzzyWhitespace) — retry with per-line whitespace normalisation
P4 (fuzzyContent) — retry with Unicode→ASCII normalisation [NEW]
P5 (regex)        — treat old_str as /gm RegExp [NEW]
Layer 2           — lineHintFallback blind positional replace [NEW]
→ FAIL: no-match diagnostics + smartSuggestion
```

**Test coverage:** All six Unicode character classes confirmed passing against `test/fuzzy_content_test.c`: smart double quotes (U+201C/D), em dash (U+2014), en dash (U+2013), NBSP (U+00A0), smart single quote (U+2019), zero-width space (U+200B). All three paths confirmed working: match+commit, dryRun, invalid pattern error.

**When to use each mode:**

| Scenario | Recommended approach |
|---|---|
| Suspect smart quotes / em dashes in a string literal or comment | `fuzzyContent:true` |
| Have a confirmed line number from grep-file, buffer content may differ | `lineHint:N` (triggers fallback automatically on mismatch) |
| Know the pattern but not the exact Unicode chars | `regex:true` with `.` wildcards |
| None of the above, hit has failed twice | `dryRun:true` with `regex:true` to see what matches |

**Why this belongs in the tool layer:** An LLM cannot introspect the byte content of its own output. It generates text that looks visually correct, passes it to the tool, and has no mechanism to discover that a smart quote was substituted until the match fails. Prompt instructions like "always use straight quotes" are forgotten mid-session and not applied to content the LLM reconstructs from memory. Tool-level normalisation solves the problem without requiring the LLM to reason about Unicode at all.

**Stats tracking:** Three new counters (`fuzzyContentCommits`, `lineHintFallback`, `regexCommits`) are tracked in `editStats.str_replace` alongside `fuzzyWhitespaceCommits`. All appear in `get-edit-stats` output. Over sessions, the ratio `fuzzyContentCommits / (noMatch + fuzzyContentCommits)` measures how often Unicode substitution is actually the failure cause — distinguishing it from whitespace mismatch and true content divergence.

---
