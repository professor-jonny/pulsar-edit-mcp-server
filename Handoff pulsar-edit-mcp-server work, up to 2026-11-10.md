# Handoff: pulsar-edit-mcp-server work, up to 2026-11-10

*Written so PJ can start a fresh conversation. Everything below comes from the previous conversation. Where something was only inferred, it says so. Re-read the files named here before trusting any number.*

## 1. The project in one paragraph

A Pulsar package that runs an MCP server so Claude can edit, search and run commands in Pulsar. Path: `C:\Users\j.brophy.CORKILLSYSTEMS\.pulsar\packages\pulsar-edit-mcp-server`. User: PJ (Windows, PowerShell 5, Pulsar). Key files: `lib/mcp-registration.js` (about 7,400 lines, roughly 70 tool handlers), `lib/tool-framework.js` (the Tool Framework: `ctx.commit`, `ctx.fail`, `ctx.dryRunReturn`, the staleness guard), 48 small modules in `lib/` (for example `match-engine.js`, `edit-stats.js`, `raf-commit.js`, `command-confirm.js`), tests in `test/*.test.js`, and docs `README.md`, `CHANGELOG.md`, `TODO.md`, `LLM-FAILURE-MODES.md`. Pulsar session notes for the project `pulsar-edit-mcp-server` hold the detailed history: 29 notes, newest last.

## 2. Start here (first steps in the new conversation)

1. Load the Pulsar tools with `tool_search` (they are deferred; see section 3 for queries that worked), then read the newest session notes: `session-notes` action `read`, `tail` 5, `project` `pulsar-edit-mcp-server`.
2. Read `TODO.md` items **H13** and **R3a**. Both were updated with the `delete` investigation (section 7).
3. Ask PJ to confirm the user-visible behaviour changes of the `delete` migration (section 7), then start with Mode 5.
4. Run the suite once as a baseline: `cmd /c "node test\run-all.js 2>nul" | Select-Object -Last 3`. Expected at the time of writing: 60 test files, 5256 checks, 0 failing.

## 3. Working rules and gotchas (learned the hard way)

- **Tools are deferred.** After a Pulsar restart or a stall they must be loaded again with `tool_search`. Queries that worked: `pulsar run-command shell command`; `pulsar read a section of any file startLine endLine`; `pulsar replace old_str new_str fragment edit a line`; `pulsar insert new lines without modifying existing`; `pulsar delete lines from a file by line range`; `pulsar session-notes persistent notes`; `pulsar apply-patch unified diff patch`; `pulsar replace-across-files glob query replacement confirm`; `pulsar open-file open a file in a Pulsar tab`; `pulsar open-file undo last change in active editor`. One query once loaded only the `replace-*` family and the plain `replace` needed its own search.
- **Code in `lib/*.js` needs a full Pulsar restart and a new MCP session** before it is live. Live probes come after that. A bare `confirm:true` on `replace-across-files` is refused unless a preview ran in the same session.
- **Tests first.** Write the test, see it fail (red), make the fix, see it pass. Handler wiring cannot be unit-tested outside Pulsar, so tests use pure helper modules plus source-text checks on the handler, then a live probe after a restart.
- **Running tests:** `cmd /c "node test\run-all.js 2>nul"`. For one test, send output to files in TEMP: `cmd /c "node test\x.test.js 1> %TEMP%\out.txt 2> %TEMP%\err.txt"`. Do not use PowerShell `2>$null`: it makes the wrapper report exit code 1 even when tests pass.
- **Docs edits use a guarded, copy-first node script** run through `run-command` (a here-string `@' ... '@ | node -`). Each swap must match exactly once or the script aborts without writing; back up to TEMP first (`*.bak`); choose the line ending by majority (TODO, README and CHANGELOG are LF; CHANGELOG has exactly 2 CRLF pairs); add no non-ASCII characters; read the result back.
- **`run-command` guard:** scripts containing the words `del`, `rm`, `rd`, `format` or `Remove-Item` are blocked. Claude never deletes files; PJ deletes scratch files by hand.
- **`session-notes` write: always pass `project:'pulsar-edit-mcp-server'`.** Without it the note goes to the folder of the active file (once it landed in `Ghidra-H8-Processor` and had to be moved).
- **`get-edit-stats` is about 25 KB per read.** Use it sparingly, once per probe.
- **Judge line endings from bytes,** not `Get-Content`. The scratch file `r3b_scratch.txt` is LF with a trailing newline, 116 bytes.
- **The tools cannot see the Command Output panel.** Ask PJ for a screenshot (scroll the panel to the entry; do not press Clear). The panel keeps its history.
- **After a tool reports "not available" or errors, read the file before saying what state it is in.**
- **Check the module list before creating a new `lib` module.** The convention is small pure modules (22 to 130 lines) that tests can import.
- **Dates:** the date was 2026-11-10 at the end. Entries from before midnight say 2026-11-09.

## 4. Work completed in this chain (all live-verified)

Each item has a CHANGELOG entry, a test file, and a TODO line in the finished list.

| ID | Bug | Fix | Test (checks) |
| --- | --- | --- | --- |
| R3m | `replace` counted every failed call twice (the handler bumped `fails.noMatch`, then the shared diagnosis bumped again); an ambiguous content match was counted nowhere | `buildCountedFailResponse(args, ownKey)` in `match-engine.js`; a non-enumerable `diagBumped` flag marks diagnosed responses; ambiguous now counts in `fails.anchorAmbiguous` | `replace.fail-count.test.js` (14) |
| R3n | `apply-patch` counted a thrown patch in both `exception` and `contextMismatch` | `bumpApplyPatchFailure(threw)` in `edit-stats.js`; the keys now partition failures | `apply-patch.fail-count.test.js` (9) |
| R3o | `fixHunkHeaders` used `$` with the `m` flag, so every multi-line hunk got a wrong header and threw `Unknown line`; no patch ever applied directly | moved to new `lib/patch-utils.js`, body ends at `(?![\s\S])`, `\ No newline` marker not counted | `patch-fix-hunk-headers.test.js` (12) |
| I2 | `apply-patch` showed 0% success | answered by R3o; commit probe: two real commits applied directly, `hits` 0 to 2 | (live probe) |
| R3l | `replace-across-files` reported success when a save failed | `commitResult()` in `raf-commit.js`: summary `WARNING: NOT SAVED` or `WARNING: PARTLY SAVED`; `filesSaved`, `filesNotSaved`; `filesAffected` and `totalReplacements` count saved files only; a nothing-saved commit is not a hit; failed-save buffers are left modified by design | `raf-commit-result.test.js` (34) |
| R3p | one unsaveable buffer made `run-command` abort with a bare `EACCES` and run nothing | new `lib/preflight-save.js`: `saveModifiedEditors`, `notSavedWarningLines`; the command runs on the disk copy; result has `notSavedBeforeRun`; the post-command reload skips unsaved buffers | `preflight-save.test.js` (28) |

Also done:

- **No double count** was found in `replace-all` (live), `replace-function-body`, `sed` and `replace-across-files` (by reading and lifetime numbers).
- **README rows** for `run-command` and `replace-across-files` describe the R3l and R3p behaviour; the CHANGELOG has a docs entry.
- **R3p panel warning** confirmed from PJ's screenshot: `WARNING: 1 modified buffer(s) could NOT be saved; the command runs on the disk copy of:` plus the file and its EACCES reason.
- **Probe procedure for read-only tests:** set `r3c_ro_scratch.txt` read-only with `Set-ItemProperty ... IsReadOnly $true`, run the preview then `confirm:true`, then clean up with `open-file`, `undo`, check `modified:false`, and clear the attribute.

## 5. Current state (at the end of the previous conversation)

- Suite: **60 files, 5256 checks, 0 failing.** (Baseline before this chain: 55 files, 5159 checks; the five new test files add 97 checks.)
- `TODO.md` 246 lines, `CHANGELOG.md` 2,405 lines, `README.md` 585 lines. All are up to date for R3l, R3m, R3n, R3o, R3p, I2 and H13.
- No code is waiting for a live probe. The only code change not yet probed live are the sub-cases listed in section 6.
- Backups of every docs edit are in TEMP as `*.pre-*.bak`.

## 6. Open items

From `TODO.md` (re-read it for the exact text):

- **R3a (medium):** `delete`, `replace-block` and `replace-function-body` lack `successNudge` and `structCheck`. Nuance added: `replace-function-body` already calls `ctx.commit` once, so for it the features are probably just declarations; `delete` and `replace-block` must be moved onto `ctx.commit` first.
- **R2h (medium):** every edit tool silently destroys bytes that are not valid UTF-8. Needs a design decision.
- **R4g remainder (medium):** grep faithfulness audit: `-L`, `--exclude`, maybe `-z`, and comparing `-c -m -v -A -B -C` against `grep.exe`.
- **R4k / last-call stash design (P1 to P8):** PJ still has to decide P6 (optional fields versus a replay tool) and P7 (TTL numbers).
- **S6:** uncounted failures, for example `sed` writes no fault-log record and the fault log has 52 malformed entries.
- **R3e:** `deactivate` throws on the status bar tile.
- **R3k:** the "extra window" (see below). PJ declined the watcher script.
- **H8 (dependencies), H11 (`pwsh` not installed), H12 (remove non-ASCII from `lib`), H13 (handler split, section 8).**
- Smaller: dead CSS rule `.chat-command-confirm`; the 2-minute timeout of the destructive prompt is unit-tested only.

Not probed live (unit tests only): `apply-patch` no-newline marker and two hunks in one patch; `replace` whitespace, partial-match and `occurrenceOutOfRange` counting; the R3p post-command reload skip.

Known limit: in `apply-patch`, a removed or added line whose content starts with `--` or `++` (so the patch line starts with `---` or `+++`) ends the hunk body early (same as `hunkRe`).

Unexplained: the status bar shows "2 deprecations" (cause not investigated; PJ can click it). PJ's main window now lists four project roots: `pulsar-edit-mcp-server`, `Ghidra-H8-Processor`, `h8`, `ghidra-mcp`.

**R3k, what was learned:** the "ghost" window was the single Pulsar window that hosts the MCP server, minimized and then brought forward. No code in `lib/*.js`, in Pulsar core's `workspace.open`, or in other installed packages' own source calls the OS-level raise (`atom.focus()`); the trigger is probably outside Pulsar. `node_modules` of other packages were not scanned.

## 7. The `delete` / Tool Framework thread (where the conversation stopped)

**Facts (checked by reading and counting):**

- The `delete` registration is **547 lines** (lines 1720 to 2267 of `lib/mcp-registration.js`): header 38, Mode 1/2 (banner, `ifdefBlock`) 60, Mode 3 (`inFunction`) 55, Mode 4 (`startContent` + `endContent`) 183, Mode 5 (`matchString`) 88, Mode 6 (legacy `startLine`/`endLine`) 123. 87 lines (16%) are comments, much of it dated fix history.
- It is six tools merged into one handler (comments: Modes 4 and 6 were "ported from delete-block" and "ported from delete-line-range").
- **The commit tail is repeated five times** (`buffer.deleteRows` at lines 1804, 1862, 2043, 2132, 2235), about 26 lines each, about 130 lines in total. A line diff showed Modes 1/2, 3, 4 and 5 are the same logic (they differ only in dry-run message text, renamed variables and comments). Mode 6 really differs: it works from `startLine`/`endLine` and builds a positional drift nudge and an "unverified" nudge by hand.
- Mode 4 is hand-written matching for two anchors; its comments record deliberate behaviour (the end match is pinned to occurrence 1, the start occurrence is forwarded).
- **`delete` uses none of `ctx.commit`, `ctx.fail`, `ctx.dryRunReturn`.** It declares only `dryRun`, `lint` and `consecutiveFailureCounter`; `insert` declares `styleCheck`, `successNudge`, `structCheck` and more. Only 6 handlers call `ctx.commit` (`insert`, `replace`, `replace-function-body`, `replace-document`, `create-file`, `replace-all`); `str_replace`, `replace-block`, `apply-patch`, `run-command`, `replace-across-files` and `sed` call none.
- `ctx.commit` (`tool-framework.js` about lines 493 to 588) does in one call: style check, lint suffix, success nudge, struct check, diff-based decoration (needs `ctx.snapshotOriginal()` before the write), `onCommit`, tab focus (setting `focusEditedFile`), the hit bump with the failure-counter reset, and `buildEditResponse` with the save.
- **`onCommit` only records `lastEditedFilePath`** for the package menu command "Show Last Edited File". Only `ctx.commit` calls it, so `delete` edits never update that entry (a small gap).
- **The staleness guard is universal** (`tool-framework.js` lines 671 to 701): after any tool result with `dryRun:false` and a resolved file path it clears other tools' pending previews and retries for that file. **Tested live:** an `insert` dry-run preview was invalidated by a real `delete` on the same file (a control run proved the preview commits normally). Mode 6 was probed; the other four modes share the `dryRun:false` return by code reading only.
- Decoration: `decorateLine` (used by `delete`) marks one row with `mcp-diff-removed`, moves the cursor there with autoscroll, ends only on a timer and is not tracked in `activeHighlightSets`; `decorateEditedLines` (used by `ctx.commit`) marks the same row, does not move the cursor, is tracked and clears on the next buffer change.

**What moving `delete` onto `ctx.commit` changes for the user:** the edited tab gets focus (not checked whether `delete` focuses today); "Show Last Edited File" starts including `delete` edits; the cursor no longer jumps; `successNudge` and `structCheck` become available (`structCheck` is probably useful: a real delete changes the line count and Mode 3 removes whole functions).

**Agreed plan (PJ said: live test, then migration; the live test is done; the migration has NOT started):**

1. Get PJ's go on the behaviour changes above.
2. Read `ctx.commit`'s parameters and one `insert` call site in `lib/mcp-registration.js` (the `insert` handler starts near line 1296).
3. Write source-check tests first (handler wiring cannot be unit-tested), then migrate **one mode at a time**, starting with Mode 5 (`matchString`, the simplest content-anchored mode) or Mode 1/2: call `ctx.snapshotOriginal()` before each `deleteRows`, replace the tail with `ctx.commit`, dry runs with `ctx.dryRunReturn`, plain failures with `ctx.fail`, and enable `successNudge`, `structCheck` (and `retryOnFail` if sensible).
4. After a full Pulsar restart and a new MCP session, probe each migrated mode on a scratch file (delete a line, then restore it; verify bytes).
5. Leave Mode 4 (hand-written matching) and Mode 6 (positional, hand-rolled nudge) for later, riskier steps.
6. Expected size effect: about 130 lines of tail down to about 30. Update CHANGELOG, TODO (R3a, H13) and the session notes at each step.

## 8. Handler split (TODO H13)

- `lib/mcp-registration.js` has roughly 70 handlers. Largest by distance to the next handler (upper bounds): `str_replace` \~890, `delete` \~527 (really 547 as a registration), `insert` \~412, `apply-patch` \~392, `replace` \~285, `get-repo-map` \~259, `run-command` \~251, `get-selection` \~243, `replace-function-body` \~206, `replace-across-files` \~203, `replace-block` \~169, `grep-project` \~153, `session-notes` \~131.
- The edit family (`str_replace`, `delete`, `insert`, `replace`, `replace-block`) is about 2,300 lines, a third of the file.
- Recommendation given: no big-bang split. Extract a handler when it next needs a change (no behaviour change in the move, a mock-based handler test with it). First, a read-only mapping of the shared dependencies of `apply-patch`, `run-command` and `replace-across-files` (`checkpoints`, the debug log, `bump`, the stored fuzzy-patch hunks, `getCommandTerminalPanel`, helpers in the first \~340 lines) and which of them already use the Tool Framework. PJ has not said whether the mapping should include `str_replace`. The `delete` migration (section 7) may be the better first move.
- A refactor plan file named in some `lib` headers (`mcp-server-refactor-plan.md`) was not found in the repo.

## 9. For PJ to do by hand

Delete these scratch files in the package root: `r3b_scratch.txt`, `r3b_scratch2.txt`, `r3c_ro_scratch.txt` (no longer read-only; content unchanged), `r3n_out.txt`, `r3n_err.txt`. Backups in TEMP (`*.pre-*.bak`) can go whenever you like.

## 10. Mistakes made in the previous conversation (so they are not repeated)

- Told PJ the last R3n edit had not been made after a tool reported itself unavailable, without reading the file (it had been applied).
- Wrote a session note to the wrong project (no `project` argument).
- Said `onCommit` invalidates other tools' stashed previews. It does not; the staleness guard is universal. Corrected in TODO H13 after reading the code and running the live test.
- Said `delete` gets no nudge at all. Mode 6 hand-rolls one; Modes 1 to 5 have none by design.
- Suggested a new helper for `delete`'s commit tail before checking that `ctx.commit` already does that job.
- Created two new `lib` modules without first checking the module list for a better home (they follow the convention, but the check was skipped).
- Early live probes used `r3c_ro_scratch.txt` assuming it was still read-only; its attribute had been cleared, so set it again before a probe.
