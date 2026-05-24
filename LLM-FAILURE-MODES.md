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

