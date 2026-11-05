'use strict';
// 2026-11-19 (apply-patch rework): pure helpers for the fuzzy rescue of a unified-diff hunk.
// Old rescue stored only the added/deleted lines and re-found the delete row at confirm time, so
//   - added lines were NOT re-indented (they kept the patch's indent, not the buffer's), and
//   - a hunk with only '+' lines was inserted BEFORE its context instead of where the '+' sat.
// Now one hunk = the whole old block (context + deleted rows) replaced by a new block built in order:
// context rows come from the buffer (real indentation), '-' rows are dropped, '+' rows are re-indented.

// bodyLines: the hunk's lines without the @@ header, each starting with ' ', '-' or '+'
function parseHunkOps(bodyLines) {
  const ops = [];
  for (const l of bodyLines) {
    if (l.startsWith('\\')) continue;                 // "\ No newline at end of file"
    const k = l[0];
    if (k === ' ' || k === '-' || k === '+') ops.push({ k, text: l.slice(1) });
    else if (l === '') ops.push({ k: ' ', text: '' }); // a blank context line that lost its leading space
  }
  return ops;
}

const indentOf = (s) => s.match(/^[ \t]*/)[0];

// hitRow: buffer row where the first NON-EMPTY old (context/deleted) line of the hunk was found
function planRescueHunk(ops, bufLines, hitRow) {
  const oldOps = ops.filter(o => o.k !== '+');
  const firstIdx = oldOps.findIndex(o => o.text.trim() !== '');
  if (firstIdx < 0) return { ok: false, reason: 'noContext' };
  const startRow = hitRow - firstIdx;
  if (startRow < 0 || startRow + oldOps.length > bufLines.length) return { ok: false, reason: 'outOfRange' };
  for (let i = 0; i < oldOps.length; i++) {
    if (bufLines[startRow + i].trim() !== oldOps[i].text.trim()) return { ok: false, reason: 'mismatch', at: startRow + i, expected: oldOps[i].text };
  }
  // indent shift per old line (buffer indent minus patch indent); an added line takes the shift of the
  // nearest old line before it in the patch (or the first one after it, for a hunk that opens with '+')
  const deltas = oldOps.map((o, i) => indentOf(bufLines[startRow + i]).length - indentOf(o.text).length);
  const unit = bufLines.slice(startRow, startRow + oldOps.length).some(l => indentOf(l).includes('\t')) ? '\t' : ' ';
  const reindent = (t, delta) => {
    if (t.trim() === '') return '';
    if (delta === 0) return t;
    const cur = indentOf(t);
    return (delta > 0 ? cur + unit.repeat(delta) : cur.slice(0, Math.max(0, cur.length + delta))) + t.slice(cur.length);
  };
  const newBlock = [];
  let oi = 0;
  for (const o of ops) {
    if (o.k === ' ') { newBlock.push(bufLines[startRow + oi]); oi++; }
    else if (o.k === '-') { oi++; }
    else newBlock.push(reindent(o.text, deltas.length ? deltas[Math.min(Math.max(oi - 1, 0), deltas.length - 1)] : 0));
  }
  const indentDelta = deltas[firstIdx];
  // minimal changed span: drop identical rows at both ends so untouched rows (and their line endings) are not rewritten
  const oldRows = bufLines.slice(startRow, startRow + oldOps.length);
  let pre = 0;
  while (pre < oldRows.length && pre < newBlock.length && oldRows[pre] === newBlock[pre]) pre++;
  let suf = 0;
  while (suf < oldRows.length - pre && suf < newBlock.length - pre && oldRows[oldRows.length - 1 - suf] === newBlock[newBlock.length - 1 - suf]) suf++;
  const editNew = newBlock.slice(pre, newBlock.length - suf);
  const editOldLen = oldRows.length - pre - suf;
  return { ok: true, startRow, oldLen: oldOps.length, newBlock, indentDelta, oldTrimmed: oldOps.map(o => o.text.trim()), editStart: startRow + pre, editOldLen, editNew };
}

// preview rows for one planned hunk, built in patch order
function previewHunk(ops, bufLines, plan) {
  const out = [];
  let oi = 0;
  const reindented = plan.newBlock;
  let ni = 0;
  for (const o of ops) {
    if (o.k === ' ') { out.push(`${String(plan.startRow + oi + 1).padStart(4)}   ${bufLines[plan.startRow + oi]}`); oi++; ni++; }
    else if (o.k === '-') { out.push(`${String(plan.startRow + oi + 1).padStart(4)} - ${bufLines[plan.startRow + oi]}`); oi++; }
    else { out.push(`     + ${reindented[ni]}`); ni++; }
  }
  return out;
}

// still valid against the current buffer? (confirm may come after the file changed)
function rescueStillValid(plan, bufLines) {
  if (!plan || plan.startRow + plan.oldLen > bufLines.length) return false;
  return Array.isArray(plan.oldTrimmed) && plan.oldTrimmed.every((t, i) => bufLines[plan.startRow + i].trim() === t);
}

module.exports = { parseHunkOps, planRescueHunk, previewHunk, rescueStillValid, indentOf };
