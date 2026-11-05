'use strict';
// replace-all-plan.js -- Stage 4a of the shared span pathway plan (2026-10-10).
// PURE (no Pulsar, no I/O). WIRED in Stage 4b: the replace-all handler in lib/mcp-registration.js calls it.
// Unit + differential tests: test/replace-all-plan.test.js.
//
// WHAT IT IS: the match-and-expand half of the replace-all handler (lib/mcp-registration.js,
// ~L4728-4747), moved onto lib/edit-match.js (findHits + expandHit). The handler keeps the
// write (ctx.buffer.setTextViaDiff), the dry-run location list, the failure text, stats and
// the style/lint suffixes: those are adapter work (Stage 4b).
//
// BEHAVIOUR IT MUST KEEP (the live replace-all behaviour):
//   * case-INSENSITIVE by default (edit-match defaults to case-sensitive, so this module
//     passes caseSensitive explicitly; its default here is false like the live tool);
//   * the escaped literal query is matched ONCE over the whole text (flags g+i only), so a
//     query can cross lines;
//   * the replacement template is expanded with applyReplacement semantics ($1, $&, $`, $',
//     $<name>), and pre/post are the text before/after the match in the WHOLE FILE.
//
// CRLF: the live handler runs on ctx.text, which keeps its CRs. This module splits the text
// on '\n' ONLY (never /\r?\n/), so each row keeps its trailing CR and the matcher's
// join('\n') rebuilds the input text exactly. A pattern containing \r\n therefore behaves
// as it does today.
//
// RETURNS
//   success: { ok:true, newText, matchCount, hits }
//   refusal: { ok:false, reason, ... } with reason
//     'invalidInput'  non-string argument, OR an EMPTY query (see OPEN QUESTION below)
//     'noMatch'       matchCount 0
//
// OPEN QUESTION FOR PJ (found while writing this, from reading the live code, NOT measured):
// the live handler accepts query '' (the schema is z.string()), builds new RegExp('', 'gi')
// and so matches at every position, inserting the replacement between every character.
// edit-match refuses an empty oldString, so this module reports invalidInput for it. The
// adapter in Stage 4b must either map that to an explicit refusal (a behaviour change, and
// arguably a fix) or keep a legacy path. Not decided here.

const { findHits, expandHit } = require('./edit-match');

function planReplaceAll({ text, query, replacement, caseSensitive = false } = {}) {
  if (typeof text !== 'string' || typeof query !== 'string' || typeof replacement !== 'string') {
    return { ok: false, reason: 'invalidInput' };
  }
  const lines = text.split('\n');
  const found = findHits({
    lines, oldString: query, caseSensitive, scope: 'wholeText',
  });
  if (!found.ok) return found;
  if (found.totalMatches === 0) return { ok: false, reason: 'noMatch', matchCount: 0 };

  // offset of each row start in the original text (rows were split on '\n', so +1 each)
  const starts = [];
  let off = 0;
  for (const l of lines) { starts.push(off); off += l.length + 1; }

  let out = '';
  let cursor = 0;
  for (const h of found.hits) {
    const s = starts[h.startRow] + h.startCol;
    out += text.slice(cursor, s) + expandHit(h, replacement);
    cursor = s + h.text.length;
  }
  out += text.slice(cursor);
  return { ok: true, newText: out, matchCount: found.totalMatches, hits: found.hits };
}

module.exports = { planReplaceAll };
