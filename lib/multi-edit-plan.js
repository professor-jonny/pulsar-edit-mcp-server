'use strict';
// XW11 (2026-11-19): all-or-nothing multi-edit planner behind replace({ edits: [...] }).
// Pure: takes the file text and a list of { old_str, new_str } and returns the new text, or says
// which edit failed. Nothing is written by this module.
//   - each old_str is a literal span (may start/end mid-line, may span lines), applied in order to
//     the text the earlier edits produced
//   - each must match EXACTLY once; 0 or 2+ hits fails the whole set (nothing applies)
//   - line endings: a multi-line old_str matches whether the file has LF or CRLF there
//     (XW1), and new_str is written in the ending of the span it replaces
const EOL_RE = /\r\n|\r|\n/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function findAll(text, needle) {
  const hits = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(needle, from);
    if (i < 0) break;
    hits.push({ start: i, end: i + needle.length });
    from = i + Math.max(1, needle.length);
  }
  return hits;
}

function findTolerant(text, needle) {
  const parts = needle.split(/\r\n|\r|\n/);
  if (parts.length < 2) return [];
  const re = new RegExp(parts.map(escapeRe).join('\\r?\\n'), 'g');
  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    hits.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return hits;
}

// the line ending to write for a replaced span
function eolFor(text, hit) {
  const span = text.slice(hit.start, hit.end);
  if (span.includes('\r\n')) return '\r\n';
  if (span.includes('\n')) return '\n';
  const nl = text.indexOf('\n', hit.end);
  if (nl >= 0) return text[nl - 1] === '\r' ? '\r\n' : '\n';
  const before = text.lastIndexOf('\n', hit.start);
  if (before >= 0) return text[before - 1] === '\r' ? '\r\n' : '\n';
  return '\n';
}

function planMultiEdit({ text, edits }) {
  if (!Array.isArray(edits) || edits.length === 0) return { ok: false, index: -1, reason: 'empty' };
  let work = text;
  const applied = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i] || {};
    if (typeof e.old_str !== 'string' || e.old_str === '') return { ok: false, index: i, reason: 'emptyOldStr' };
    if (typeof e.new_str !== 'string') return { ok: false, index: i, reason: 'missingNewStr' };
    if (e.old_str === e.new_str) return { ok: false, index: i, reason: 'identical' };
    let hits = findAll(work, e.old_str);
    if (hits.length === 0) hits = findTolerant(work, e.old_str);
    if (hits.length === 0) return { ok: false, index: i, reason: 'notFound', count: 0 };
    if (hits.length > 1) return { ok: false, index: i, reason: 'ambiguous', count: hits.length };
    const h = hits[0];
    const eol = eolFor(work, h);
    const rep = e.new_str.replace(new RegExp(EOL_RE.source, 'g'), eol);
    const line = work.slice(0, h.start).split(/\r\n|\r|\n/).length;
    work = work.slice(0, h.start) + rep + work.slice(h.end);
    applied.push({ index: i, line });
  }
  return { ok: true, newText: work, applied };
}

function describeFailure(plan, edits) {
  const e = (edits && edits[plan.index]) || {};
  const head = `edit ${plan.index + 1} of ${edits ? edits.length : '?'}`;
  const snip = typeof e.old_str === 'string' ? JSON.stringify(e.old_str.length > 60 ? e.old_str.slice(0, 57) + '...' : e.old_str) : '';
  switch (plan.reason) {
    case 'empty': return 'replace refused: edits is empty.';
    case 'emptyOldStr': return `replace refused: ${head} has an empty old_str. Nothing was written.`;
    case 'missingNewStr': return `replace refused: ${head} has no new_str (pass '' to delete). Nothing was written.`;
    case 'identical': return `replace refused: ${head} has old_str equal to new_str. Nothing was written.`;
    case 'notFound': return `replace failed: ${head} (${snip}) was not found, after the edits before it were applied. Nothing was written; no edit in the set was applied.`;
    case 'ambiguous': return `replace failed: ${head} (${snip}) matches ${plan.count} places. Make old_str longer so it is unique. Nothing was written; no edit in the set was applied.`;
    default: return `replace failed: ${head} (${plan.reason}). Nothing was written.`;
  }
}

module.exports = { planMultiEdit, describeFailure, findAll, findTolerant, eolFor };
