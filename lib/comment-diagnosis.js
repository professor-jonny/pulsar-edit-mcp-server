'use strict';
// lib/comment-diagnosis.js (2026-10-11)
//
// PURE diagnosis of a trailing-comment mismatch between an edit needle (old_str / anchor / match
// text) and the buffer. No Pulsar, no stats, no I/O, no message decoration.
//
// WHY: until now str_replace and the engine's autoRescue silently STRIPPED a trailing comment from
// the needle's last line when the code matched but the comment did not (recover.js profiledMatch,
// tag autoStripComment), and str_replace even appended a /* CHECK: ... */ marker to new_str. PJ
// decided (2026-10-11) that this is a FAILURE with a precise diagnosis instead: the caller is told
// exactly which lines differ only by their trailing comment and what the buffer line reads, so the
// retry sends just what needs fixing. Nothing is edited behind the caller's back.
//
// WHAT COUNTS AS A COMMENT ISSUE: a needle line with no exact or trim-equal buffer line whose CODE
// part (text before a trailing // or /* ... */ comment, outside string literals) equals the code of
// a buffer line while the COMMENTS differ. Three kinds:
//   extra      needle has a trailing comment, the buffer line has none
//   missing    the buffer line has a trailing comment, the needle line has none
//   different  both have one and the texts differ
// Lines whose code part is empty (comment-only lines) are not comment issues: that is a plain text
// difference and the generic diagnosis handles it.
//
// LIMITS (deliberate): only // and /* */ comments (the JS/C family, same as the old
// TRAILING_COMMENT_RE). String detection is a simple quote scan (' " `) with backslash escapes; an
// unbalanced quote simply means no comment is detected on that line (no issue reported, never a
// wrong edit, because this module never edits anything).

/**
 * splitTrailingComment(line) -> { code, comment }
 *   code     the line text before the comment, trailing whitespace removed (leading kept)
 *   comment  the trimmed comment text including its // or /* markers, or null when none
 * A /* ... *\/ comment in the MIDDLE of a line (code after it) is not a trailing comment: it stays in
 * code and scanning continues.
 */
function splitTrailingComment(line) {
  if (typeof line !== 'string') return { code: '', comment: null };
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && line[i + 1] === '/') {
      return { code: line.slice(0, i).replace(/\s+$/, ''), comment: line.slice(i).trim() };
    }
    if (c === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end === -1 || line.slice(end + 2).trim() === '') {
        return { code: line.slice(0, i).replace(/\s+$/, ''), comment: line.slice(i).trim() };
      }
      i = end + 1; // inline block comment with code after it: skip it, keep scanning
    }
  }
  return { code: line.replace(/\s+$/, ''), comment: null };
}

/**
 * diagnoseComments({ needleLines, haystackLines, diagOffset })
 *   needleLines    the needle split into lines
 *   haystackLines  the buffer lines the failure is diagnosed against (the diagnosis window)
 *   diagOffset     0-based row of haystackLines[0] in the whole buffer, so bufferLine is absolute
 * Returns an array of issues, one per needle line, in needle order:
 *   { needleLine, kind, needleComment, bufferComment, bufferLine, bufferText, candidateCount }
 *   needleLine / bufferLine are 1-based; candidateCount is how many buffer lines share the code
 *   but differ in comment (the first one is reported).
 */
function diagnoseComments({ needleLines, haystackLines, diagOffset = 0 }) {
  const issues = [];
  if (!Array.isArray(needleLines) || !Array.isArray(haystackLines)) return issues;
  const trimmed = new Set(haystackLines.map(l => (typeof l === 'string' ? l.trim() : '')));
  const split = haystackLines.map(splitTrailingComment);

  for (let li = 0; li < needleLines.length; li++) {
    const nl = needleLines[li];
    if (typeof nl !== 'string') continue;
    const nt = nl.trim();
    if (!nt || trimmed.has(nt)) continue;           // blank, or already matches modulo indentation
    const n = splitTrailingComment(nl);
    const nCode = n.code.trim();
    if (!nCode) continue;                            // comment-only line: not a comment issue
    const hits = [];
    for (let bi = 0; bi < split.length; bi++) {
      const b = split[bi];
      if (b.code.trim() !== nCode) continue;
      if ((n.comment || '') === (b.comment || '')) continue;
      hits.push(bi);
    }
    if (hits.length === 0) continue;
    const bi = hits[0];
    const b = split[bi];
    issues.push({
      needleLine: li + 1,
      kind: !n.comment ? 'missing' : (!b.comment ? 'extra' : 'different'),
      needleComment: n.comment,
      bufferComment: b.comment,
      bufferLine: bi + diagOffset + 1,
      bufferText: haystackLines[bi],
      candidateCount: hits.length,
    });
  }
  return issues;
}

/**
 * formatCommentAdvice(issues, { subject, max }) -> array of plain ASCII message lines (empty when
 * there are no issues). The first line is a header; then one line per issue naming the needle line,
 * what differs and how the buffer line reads, so the caller fixes only those lines.
 * The caller adds any emoji/prefix and joins the lines.
 */
function formatCommentAdvice(issues, { subject = 'old_str', max = 5 } = {}) {
  if (!Array.isArray(issues) || issues.length === 0) return [];
  const out = [issues.length + ' line(s) of ' + subject
    + ' match the buffer except for their trailing comment. Fix just these lines:'];
  for (const i of issues.slice(0, max)) {
    const reads = ' It should read: ' + String(i.bufferText).trim();
    let body;
    if (i.kind === 'extra') {
      body = 'remove the comment ' + i.needleComment + ' (buffer line ' + i.bufferLine + ' has none).';
    } else if (i.kind === 'missing') {
      body = 'buffer line ' + i.bufferLine + ' ends with a comment ' + subject + ' lacks.';
    } else {
      body = 'the comment differs (' + subject + ': ' + i.needleComment + '; buffer line '
        + i.bufferLine + ': ' + i.bufferComment + ').';
    }
    const many = i.candidateCount > 1 ? ' [' + i.candidateCount + ' similar lines, first shown]' : '';
    out.push('  ' + subject + ' line ' + i.needleLine + ': ' + body + reads + many);
  }
  if (issues.length > max) out.push('  ... and ' + (issues.length - max) + ' more line(s).');
  return out;
}

module.exports = { splitTrailingComment, diagnoseComments, formatCommentAdvice };
