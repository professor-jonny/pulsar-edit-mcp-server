'use strict';
// lib/repo-map.js - the pure parts of get-repo-map (2026-11-18). No Pulsar, no file access.
//   countRefs(symbols, fileTexts, allFiles)  cross-file reference counts and file->file edges, one pass per file
//   renderRepoMap(sortedFiles, opts)         the map text, kept within a character budget
//   limitHealth(entries, shownRels, max)     the file-health block, only for shown files and capped
// The old handler counted refs with one regex per symbol per file (symbols x files x text), read every file twice and
// rendered at least one symbol for EVERY file, so a small maxTokens was ignored and big roots timed out.

const PURE_WORD = /^\w+$/;
const wordCache = new WeakMap(); // not used for strings; see wordsOf below

function wordsOf(text) {
  const m = new Map();
  const found = text.match(/\w+/g);
  if (found) for (const w of found) m.set(w, (m.get(w) || 0) + 1);
  return m;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Same result as counting /\bname\b/g in each other file. For a name made only of word characters a \b match is exactly
// a whole word, so the count comes from a per-file word table built once. Other names (operator+, $x, non-ASCII) keep
// the regex, so nothing changes for them.
function countRefs(symbols, fileTexts, allFiles) {
  void wordCache;
  const tables = new Map(); // filePath -> Map(word -> count), built on first use
  const table = (fp) => {
    let t = tables.get(fp);
    if (!t) { t = wordsOf(fileTexts[fp]); tables.set(fp, t); }
    return t;
  };
  const countIn = (sym, fp, re) => {
    if (PURE_WORD.test(sym.name)) return table(fp).get(sym.name) || 0;
    return (fileTexts[fp].match(re) || []).length;
  };
  const reFor = (sym) => (PURE_WORD.test(sym.name) ? null : new RegExp(`\\b${escapeRe(sym.name)}\\b`, 'g'));

  const textFiles = Object.keys(fileTexts);
  for (const sym of symbols) {
    const re = reFor(sym);
    for (const fp of textFiles) {
      if (fp === sym.filePath) continue;
      sym.refs += countIn(sym, fp, re);
    }
  }
  const edges = new Map();
  for (const sym of symbols) {
    if (sym.refs === 0) continue;
    const re = reFor(sym);
    for (const srcFp of allFiles) {
      if (srcFp === sym.filePath) continue;
      if (!fileTexts[srcFp]) continue;
      const cnt = countIn(sym, srcFp, re);
      if (cnt === 0) continue;
      const key = `${srcFp}\x00${sym.filePath}`;
      edges.set(key, (edges.get(key) || 0) + Math.sqrt(cnt));
    }
  }
  return { edges };
}

function renderOnce(fileList, symsPerFile, { minRefs, includeLineNumbers, relOf }) {
  const out = [];
  let symCount = 0, filesShown = 0;
  for (const [fp, syms] of fileList) {
    const eligible = syms
      .filter(s => s.refs >= minRefs)
      .sort((a, b) => b.score - a.score || a.line - b.line)
      .slice(0, Math.max(1, symsPerFile));
    if (!eligible.length) continue;
    eligible.sort((a, b) => a.line - b.line); // sorted by line for rendering
    out.push(relOf(fp) + ':');
    let prevLine = -1;
    for (const s of eligible) {
      if (prevLine !== -1 && s.line > prevLine + 1) out.push('...');
      out.push(`-${s.sig}${includeLineNumbers ? ` // L${s.line}` : ''}`);
      prevLine = s.line;
      symCount++;
    }
    out.push('');
    filesShown++;
  }
  return { text: out.join('\n'), symCount, filesShown };
}

// sortedFiles: [[filePath, symbols]] best-ranked first. Keeps the text within charBudget:
//   1. as many symbols per file as fit (binary search, as before);
//   2. if even ONE symbol per file does not fit, fewer files (the best-ranked ones), never fewer than one.
function renderRepoMap(sortedFiles, opts) {
  const o = { minRefs: 0, includeLineNumbers: true, relOf: (p) => p, ...opts };
  const budget = o.charBudget;
  const maxPerFile = Math.max(1, ...sortedFiles.map(([, s]) => s.length));
  let best = renderOnce(sortedFiles, maxPerFile, o);
  if (best.text.length > budget) {
    const one = renderOnce(sortedFiles, 1, o);
    if (one.text.length <= budget) {
      let lo = 1, hi = maxPerFile;
      best = one;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const r = renderOnce(sortedFiles, mid, o);
        if (r.text.length <= budget) { lo = mid; best = r; } else hi = mid - 1;
      }
    } else {
      let lo = 1, hi = sortedFiles.length;
      best = renderOnce(sortedFiles.slice(0, 1), 1, o);
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const r = renderOnce(sortedFiles.slice(0, mid), 1, o);
        if (r.text.length <= budget) { lo = mid; best = r; } else hi = mid - 1;
      }
    }
  }
  return { ...best, filesTotal: sortedFiles.length };
}

// entries: [{ rel, flags: ['[unicode]', ...] }]. Only files in shownRels are reported, at most `max` lines.
function limitHealth(entries, shownRels, max) {
  const shown = (entries || []).filter(e => shownRels.has(e.rel));
  if (!shown.length) return '';
  const lines = shown.slice(0, max).map(e => '  ' + e.rel + ': ' + e.flags.join(' '));
  if (shown.length > max) lines.push('  (+' + (shown.length - max) + ' more files with warnings; get-diagnostics or read a file to see its flags)');
  return '\n\n// File health warnings:\n' + lines.join('\n');
}

module.exports = { countRefs, renderRepoMap, limitHealth };
