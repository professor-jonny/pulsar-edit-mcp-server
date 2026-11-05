'use strict';
// edit-match.js -- Stage 3 of the shared span pathway plan (2026-10-09). Renamed from
// regex-match.js and reworked Edit-style on 2026-10-10. Pure module, no I/O. WIRED since Stages 4b and 5b
// (2026-10-10): lib/replace-all-plan.js requires it and the replace-all handler runs on it (lib/sed-plan.js did too, until the sed tool moved to lib/sed-tool.js on 2026-10-24; it was deleted on 2026-10-25).
// Unit tests: test/edit-match.test.js.
//
// MODELLED ON CLAUDE CODE'S EDIT TOOL (PJ's request 2026-10-10), so the semantics are
// familiar:
//   * oldString is matched EXACTLY: literal and case-sensitive by default. Case-insensitive
//     matching is an opt-in (caseSensitive:false), named like the live tools' parameter.
//     Regex was removed 2026-10-28 (R2a); regex lives only in sed and the search tools.
//   * It must match ONCE, or the edit is refused as 'ambiguous' (Edit: "found N matches ...
//     but replace_all is false"); replaceAll:true accepts every match (Edit's replace_all).
//   * No match is the refusal 'noMatch' (Edit: "string to replace not found").
//   * EXTENSION beyond Edit: occurrence:N picks the Nth match (1-based), because the live
//     tools (str_replace occurrence, matchFragment) already have it.
//   Refusals are returned as { ok:false, reason, ... }; this module builds no message text.
//
// WHY: replace-all (whole-text regex) and sed (line-by-line regex) each build their own
// regex loop inline in mcp-registration.js. Stage 4 and 5 move them onto one pathway;
// this module is the matcher half of it, shaped like lib/fragment-match.js (rows and
// columns, a plan function with refusals) so both can feed the same edit step.
//
// DESIGN DECISION (Claude's call while PJ was away, change freely): a hit is a span with
// BOTH rows, { startRow, startCol, endRow, endCol }, because replace-all's regex matches
// across lines (live replace-all behaviour). matchFragment's single-row shape cannot
// express that. For a perLine match startRow === endRow always.
//
// TWO SCOPES:
//   'wholeText' (replace-all): the rows startRow..endRow are joined with '\n' and the regex
//               runs once over that text; ^ and $ anchor to the whole window unless
//               multiline:true. NOTE: the join uses '\n'. Rows from buffer.getLines() carry
//               no CRs, so a pattern containing \r\n will not match across rows even when
//               the file is CRLF (ctx.text in the replace-all handler keeps its CRs). A row
//               that DOES carry its own trailing CR matches such a pattern (pinned in the
//               test). Reconciling the two is a Stage 4 adapter concern.
//   'perLine'   (sed, replace fragment): each row is matched on its own; ^ and $ anchor to
//               the row; no hit can cross rows.
//
// EXEC, NOT REPLACE-CALLBACK: hits come from RegExp#exec, so match.index and match.groups
// are always right. replace-all and sed read their callback's arguments by position
// (arguments[length-2] as the offset), which breaks when the regex has a NAMED group (an
// extra groups argument shifts the slots). Nothing here can do that.
//
// COORDINATES: rows are absolute 0-based buffer rows; columns are 0-based UTF-16 units,
// endCol EXCLUSIVE (like String#slice). A match that ends right after a '\n' ends at
// (nextRow, 0); one that ends before a '\n' ends at (row, row length).
//
// ZERO-LENGTH MATCHES are reported (like String#replace does): the search advances one
// unit after an empty match so it cannot loop forever.

const { escapeRegex, applyReplacement } = require('./string-utils');

function buildRegex({ oldString, caseSensitive, multiline, dotAll }) {
  const body = escapeRegex(oldString);
  const flags = 'g' + (caseSensitive ? '' : 'i') + (multiline ? 'm' : '') + (dotAll ? 's' : '');
  try { return { re: new RegExp(body, flags) }; }
  catch (e) { return { error: e.message }; }
}

function makeHit(m, startRow, startCol, endRow, endCol, pre, post, index) {
  return {
    index,                 // 1-based position among ALL hits in the window
    startRow, startCol, endRow, endCol,
    text: m[0],
    groups: m.slice(1),    // capture groups 1..n (undefined for a group that did not take part)
    named: m.groups,       // named groups object, or undefined
    pre, post,             // perLine: the row before/after the match; wholeText: the window text
  };
}

// Offset in a joined window -> { row, col }. starts[r] is the offset where window row r begins.
function toPos(starts, firstRow, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { row: firstRow + lo, col: offset - starts[lo] };
}

/**
 * findHits({ lines, oldString, caseSensitive, multiline, dotAll, scope, startRow, endRow })
 * Defaults: always literal, caseSensitive true, multiline false, dotAll false,
 * scope 'wholeText'. Returns { ok:true, hits, totalMatches, scope } or { ok:false, reason, ... }
 * with reason 'invalidInput' or 'invalidRegex' (error holds the engine message; nothing is thrown).
 */
function findHits({ lines, oldString, caseSensitive = true, multiline = false,
                    dotAll = false, scope = 'wholeText', startRow = 0, endRow } = {}) {
  if (!Array.isArray(lines) || typeof oldString !== 'string' || oldString.length === 0 ||
      (scope !== 'wholeText' && scope !== 'perLine')) {
    return { ok: false, reason: 'invalidInput' };
  }
  const built = buildRegex({ oldString, caseSensitive, multiline, dotAll });
  if (built.error) return { ok: false, reason: 'invalidRegex', error: built.error };
  const re = built.re;

  const lastRow = endRow == null ? lines.length - 1 : Math.min(endRow, lines.length - 1);
  const firstRow = Math.max(0, startRow);
  const hits = [];
  if (firstRow > lastRow) return { ok: true, hits, totalMatches: 0, scope };

  if (scope === 'perLine') {
    for (let row = firstRow; row <= lastRow; row++) {
      const line = lines[row];
      if (typeof line !== 'string') continue;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const end = m.index + m[0].length;
        hits.push(makeHit(m, row, m.index, row, end, line.slice(0, m.index), line.slice(end), hits.length + 1));
        if (m[0].length === 0) re.lastIndex++;
      }
    }
    return { ok: true, hits, totalMatches: hits.length, scope };
  }

  const win = [];
  for (let row = firstRow; row <= lastRow; row++) win.push(typeof lines[row] === 'string' ? lines[row] : '');
  const text = win.join('\n');
  const starts = [];
  let off = 0;
  for (const l of win) { starts.push(off); off += l.length + 1; }
  let m;
  while ((m = re.exec(text)) !== null) {
    const s = toPos(starts, firstRow, m.index);
    const endOff = m.index + m[0].length;
    const e = toPos(starts, firstRow, endOff);
    hits.push(makeHit(m, s.row, s.col, e.row, e.col, text.slice(0, m.index), text.slice(endOff), hits.length + 1));
    if (m[0].length === 0) re.lastIndex++;
  }
  return { ok: true, hits, totalMatches: hits.length, scope };
}

/**
 * planEdit({ ...findHits options, occurrence, replaceAll })
 * replaceAll defaults to false and must be a boolean.
 * Success: { ok:true, hits:[selected], totalMatches, replaceAll, scope }
 * Refusal: { ok:false, reason, ... } with reason 'invalidInput' | 'invalidRegex' | 'noMatch'
 *          | 'ambiguous' (matchRows = 1-based start row of every hit) | 'occurrenceOutOfRange'
 * occurrence:N picks the Nth hit (1-based) with or without replaceAll.
 */
function planEdit(opts = {}) {
  const { occurrence, replaceAll = false } = opts;
  if (typeof replaceAll !== 'boolean') return { ok: false, reason: 'invalidInput' };
  const found = findHits(opts);
  if (!found.ok) return found;
  const total = found.totalMatches;
  if (total === 0) return { ok: false, reason: 'noMatch', totalMatches: 0 };
  if (occurrence != null) {
    if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > total) {
      return { ok: false, reason: 'occurrenceOutOfRange', occurrence, totalMatches: total };
    }
    return { ok: true, hits: [found.hits[occurrence - 1]], totalMatches: total, replaceAll, scope: found.scope };
  }
  if (replaceAll) return { ok: true, hits: found.hits, totalMatches: total, replaceAll: true, scope: found.scope };
  if (total > 1) return { ok: false, reason: 'ambiguous', totalMatches: total, matchRows: found.hits.map(h => h.startRow + 1) };
  return { ok: true, hits: found.hits, totalMatches: 1, replaceAll: false, scope: found.scope };
}

// Expand a replacement template ($1, $&, $`, $', $<name>) for one hit with the same
// semantics replace-all and sed use today (applyReplacement), but fed from exec data.
function expandHit(hit, template) {
  return applyReplacement(template, hit.text, hit.groups, hit.pre, hit.post, hit.named);
}

module.exports = { findHits, planEdit, expandHit };
