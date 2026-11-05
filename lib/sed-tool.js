'use strict';
// ---------------------------------------------------------------------------
// lib/sed-tool.js -- the pure half of the `sed` MCP tool (R4d)
// ---------------------------------------------------------------------------
// The tool handler in lib/mcp-registration.js owns everything that needs Pulsar
// (scope hints, the buffer, the write, stats). This module owns everything that
// does not, so it can be unit tested with no editor:
//
//   runSed({ expression, extended, text, scope, fileName })
//     parses the script (sandbox mode: r R w W e and the s flags e / w are
//     rejected), runs it over the WHOLE text like `sed` would and returns
//       { ok: true,  output, exitCode, quit, silent }
//       { ok: false, kind: 'parse'|'run', message, exitCode?, char? }
//     `scope` is optional: { from, to } are 1-based INCLUSIVE sed line numbers
//     and make the script run as if wrapped in `from,to{ ... }` (line numbers and
//     `$` keep their whole-file meaning). No scope = the whole file.
//
//   diffLines(oldLines, newLines)
//     line diff for the dry-run preview: { removed: [{row, text}], added: [{row, text}] }
//     (row = 1-based row in the OLD text for removed, in the NEW text for added).
//
//   buildSedPreview(oldText, newText, { max })
//     { changed, removedCount, addedCount, text } -- `text` is the preview block.
//
// No `-z`, `-s` or `-l` here (PJ, 2026-10-24: -z is a future update; the tool
// edits one file; the l wrap width stays at GNU's default of 70).
// ---------------------------------------------------------------------------

const { parseScript, SedParseError } = require('./sed-parse');
const { runScript, SedRunError } = require('./sed-run');

function isRegexError(e) {
  return !!e && e.name === 'RegexError';
}

function runSed({ expression, extended = false, text, scope, fileName }) {
  let parsed;
  try {
    parsed = parseScript(String(expression), { extended: !!extended, sandbox: true });
  } catch (e) {
    if (e instanceof SedParseError || isRegexError(e)) {
      return { ok: false, kind: 'parse', message: e.message, char: e.char === undefined ? null : e.char, reason: e.reason };
    }
    throw e;
  }
  let res;
  try {
    const opts = {};
    if (scope) opts.scope = { from: scope.from, to: scope.to };
    if (fileName !== undefined) opts.fileName = fileName;
    res = runScript(parsed, String(text), opts);
  } catch (e) {
    if (e instanceof SedRunError || isRegexError(e)) {
      return { ok: false, kind: 'run', message: e.message, exitCode: e.exitCode === undefined ? 1 : e.exitCode };
    }
    throw e;
  }
  return { ok: true, output: res.output, exitCode: res.exitCode, quit: res.quit, silent: !!parsed.silent };
}

// Largest middle block (old length x new length) the exact LCS table is built for; a bigger
// block goes to the Myers diff below (R4i), and only when even that is too far apart the caller reports "everything in the middle changed", which is always correct,
// only less minimal.
const LCS_CELL_LIMIT = 4000000;

// R4i (2026-10-31): largest edit distance (removed + added lines) the Myers diff below searches
// before it gives up and the caller falls back to "everything in the middle changed".
const MYERS_MAX_D = 2000;

// Myers O(ND) diff, used for the blocks the LCS table above is too big for. A script that changes a
// few lines of a big file leaves a big middle block between the first and the last change (two edits
// 2,200 rows apart leave a 2,200 x 2,200 block) but a tiny edit distance, and that is exactly where
// the old fallback reported the whole middle as changed (2,188 lines removed and added for 4 real
// edits). Returns { removedIdx, addedIdx } (ascending indices into a and b), or null when the edit
// distance is over maxD, so memory stays at about maxD squared ints.
function myersDiff(a, b, maxD) {
  const N = a.length;
  const M = b.length;
  const limit = Math.min(N + M, maxD === undefined ? MYERS_MAX_D : maxD);
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2)); // v before this round, k = -d-1 .. d+1
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = d; break; }
    }
  }
  if (found < 0) return null;
  const removedIdx = [];
  const addedIdx = [];
  let x = N;
  let y = M;
  for (let d = found; d > 0; d--) {
    const vv = trace[d]; // the entry for diagonal k is vv[k + d + 1]
    const k = x - y;
    const down = k === -d || (k !== d && vv[k + d] < vv[k + d + 2]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = vv[prevK + d + 1];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; } // the run of common lines
    if (down) addedIdx.push(prevY); else removedIdx.push(prevX);
    x = prevX;
    y = prevY;
  }
  removedIdx.reverse();
  addedIdx.reverse();
  return { removedIdx, addedIdx };
}

function diffLines(oldLines, newLines) {
  let pre = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (pre < minLen && oldLines[pre] === newLines[pre]) pre++;
  let suf = 0;
  while (suf < minLen - pre && oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]) suf++;
  const a = oldLines.slice(pre, oldLines.length - suf);
  const b = newLines.slice(pre, newLines.length - suf);
  const removed = [];
  const added = [];
  const m = a.length;
  const n = b.length;
  if (m > 0 && n > 0 && m * n > LCS_CELL_LIMIT) {
    // R4i: too big for the LCS table, so use the Myers diff, which finds the true minimal edit script
    // when few lines changed; only a really big edit distance reaches the fallback below
    const my = myersDiff(a, b);
    if (my) {
      return {
        removed: my.removedIdx.map((i) => ({ row: pre + i + 1, text: a[i] })),
        added: my.addedIdx.map((j) => ({ row: pre + j + 1, text: b[j] })),
      };
    }
  }
  if (m === 0 || n === 0 || m * n > LCS_CELL_LIMIT) {
    for (let i = 0; i < m; i++) removed.push({ row: pre + i + 1, text: a[i] });
    for (let j = 0; j < n; j++) added.push({ row: pre + j + 1, text: b[j] });
    return { removed, added };
  }
  // classic LCS table (Uint32Array rows keep it small enough for the limit above)
  const w = n + 1;
  const t = new Uint32Array((m + 1) * w);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { i++; j++; }
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) { removed.push({ row: pre + i + 1, text: a[i] }); i++; }
    else { added.push({ row: pre + j + 1, text: b[j] }); j++; }
  }
  while (i < m) { removed.push({ row: pre + i + 1, text: a[i] }); i++; }
  while (j < n) { added.push({ row: pre + j + 1, text: b[j] }); j++; }
  return { removed, added };
}

function buildSedPreview(oldText, newText, opts) {
  const max = (opts && opts.max) || 30;
  if (oldText === newText) return { changed: false, removedCount: 0, addedCount: 0, text: '' };
  const { removed, added } = diffLines(oldText.split('\n'), newText.split('\n'));
  // Interleave by row so a change reads "- old" then "+ new" near each other.
  const entries = [];
  for (const r of removed) entries.push({ key: r.row, order: 0, sign: '-', row: r.row, text: r.text });
  for (const a of added) entries.push({ key: a.row, order: 1, sign: '+', row: a.row, text: a.text });
  entries.sort((x, y) => (x.key - y.key) || (x.order - y.order));
  const shown = entries.slice(0, max).map((e) => String(e.row).padStart(4) + ' ' + e.sign + ' ' + e.text);
  if (entries.length > max) shown.push('  ... and ' + (entries.length - max) + ' more changed line(s)');
  return { changed: true, removedCount: removed.length, addedCount: added.length, text: shown.join('\n') };
}

module.exports = { runSed, diffLines, buildSedPreview, myersDiff };
