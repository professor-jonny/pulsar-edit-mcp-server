'use strict';
// lib/mid-line-hint.js -- TODO R1e (2026-10-17). Pure, no Pulsar, no I/O.
//
// A whole-line `replace` only matches complete lines. When old_str starts or ends in the middle of a line
// it fails with a generic "not found". midLineHint() detects that case so the failure can say to retry with
// fragment:true; midLineAdvice() builds the wording.

const MAX_HITS = 200;

/**
 * midLineHint({ needle, text, scopeStart, scopeEnd, fuzzyWhitespace, fuzzyContent })
 *   needle     : the old_str the caller sent.
 *   text       : the buffer text.
 *   scopeStart, scopeEnd : optional 0-based inclusive row range the search was limited to. A hit outside it
 *                is ignored (that case is a FOUND OUTSIDE SCOPE failure, not a mid-line one).
 * Returns { startsMid, endsMid } for the first literal hit that starts and/or ends mid-line, else null.
 * Returns null for fuzzy calls: a literal substring test says nothing about those.
 */
function midLineHint({ needle, text, scopeStart, scopeEnd, fuzzyWhitespace, fuzzyContent } = {}) {
  if (fuzzyWhitespace || fuzzyContent) return null;
  if (typeof needle !== 'string' || typeof text !== 'string') return null;
  const n = needle.replace(/\r/g, '');
  if (n.trim() === '') return null;
  const t = text.replace(/\r/g, '');

  const lo = Number.isInteger(scopeStart) ? scopeStart : 0;
  const hi = Number.isInteger(scopeEnd) ? scopeEnd : Infinity;

  // Row of an offset = number of newlines before it. Walk forward once so the cost stays linear.
  let rowAt = 0, scanned = 0;
  const rowOf = (off) => {
    for (let i = t.indexOf('\n', scanned); i !== -1 && i < off; i = t.indexOf('\n', scanned)) { rowAt++; scanned = i + 1; }
    return rowAt;
  };

  let from = 0, hits = 0;
  while (hits < MAX_HITS) {
    const p = t.indexOf(n, from);
    if (p === -1) break;
    hits++;
    from = p + 1;
    const end = p + n.length;
    const startsMid = !(p === 0 || t[p - 1] === '\n' || n[0] === '\n');
    const endsMid   = !(end === t.length || t[end] === '\n' || n[n.length - 1] === '\n');
    if (!startsMid && !endsMid) continue;   // a whole-line hit: nothing to advise about this one
    const r1 = rowOf(p);
    if (r1 < lo || r1 > hi) continue;
    return { startsMid, endsMid };
  }
  return null;
}

/** Which edge(s) are mid-line, as a phrase. Used by the failure diagnosis (R1h); the NOTE no longer repeats it (R1i). ASCII only. */
function midLineEdge(hint) {
  return hint.startsMid && hint.endsMid ? 'starts and ends in the middle of a line'
       : hint.startsMid                 ? 'starts in the middle of a line'
       :                                  'ends in the middle of a line';
}

/**
 * Which wording family a tool uses (R1j). replace and anything unknown -> 'replace'. ASCII only.
 * delete (matchString) -> 'deleteMatch'; insert (afterContent / beforeContent) -> 'insertAnchor'.
 */
function midLineKind(tool) {
  return tool === 'delete' ? 'deleteMatch'
       : tool === 'insert' ? 'insertAnchor'
       :                     'replace';
}

/** The phrase the diagnosis sentence uses for "what only matches complete lines" (R1j). ASCII only. */
function midLineWhat(kind, subject) {
  return kind === 'deleteMatch'  ? 'delete ' + (subject || 'matchString')
       : kind === 'deleteAnchor' ? 'delete ' + (subject || 'startContent')
       : kind === 'insertAnchor' ? 'insert ' + (subject || 'afterContent')
       :                           'a whole-line replace';
}

/**
 * The NOTE added to the failure: the action only, because the diagnosis sentence already says what is wrong (R1i).
 * kind/subject default to the replace wording, so midLineAdvice() is unchanged (R1j). ASCII only.
 *   deleteMatch  : delete only matches whole lines. Offer replace fragment:true with an empty new_str, or whole lines.
 *   deleteAnchor : delete Mode 4 startContent / endContent only match whole lines. Offer extending the anchor to the whole line.
 *   insertAnchor : afterContent/beforeContent only match whole lines. Offer afterString/beforeString, or whole lines.
 */
function midLineAdvice(kind, subject) {
  if (kind === 'deleteMatch') {
    const S = subject || 'matchString';
    return 'NOTE: ' + S + ' only matches whole lines. To delete just that span, use replace with fragment:true and new_str:\'\' '
         + '(the rest of the line is left untouched), or extend ' + S + ' to cover the whole line(s) if you want those lines deleted.';
  }
  if (kind === 'deleteAnchor') {
    const S = subject || 'startContent';
    return 'NOTE: ' + S + ' only matches whole lines. Extend ' + S + ' to cover the whole line (a range delete has no part-line mode). '
         + 'To remove just a span inside one line, use replace with fragment:true and new_str:\'\'.';
  }
  if (kind === 'insertAnchor') {
    const S = subject || 'afterContent';
    const alt = S === 'beforeContent' ? 'beforeString' : 'afterString';
    const side = S === 'beforeContent' ? 'before' : 'after';
    return 'NOTE: ' + S + ' only matches whole lines. Use ' + alt + ' instead (it matches text inside a line and inserts ' + side
         + ' that line), or extend ' + S + ' to cover the whole line(s).';
  }
  return 'NOTE: resend the whole call (new_str included) with fragment:true to replace just that span (the rest of the line is left untouched), '
       + 'or extend old_str to cover the whole line(s) and make new_str the full replacement line(s).';
}

module.exports = { midLineHint, midLineAdvice, midLineEdge, midLineKind, midLineWhat };
