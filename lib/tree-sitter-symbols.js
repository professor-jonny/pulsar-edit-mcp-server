/**
 * tree-sitter-symbols.js
 *
 * Unified symbol extraction for all tools that need to find, scope, or
 * replace functions by name.
 *
 * PRIMARY PATH  — open editor with tree-sitter parse tree:
 *   Uses Pulsar's internal rootLanguageLayer.tree + tagsQuery.
 *   Handles JS arrow functions, registerTool() callbacks, class methods,
 *   C functions, TypeScript — anything the grammar tags as a definition.
 *   Also brace-counts from the definition node's startPosition to find endRow,
 *   which replace-function-body needs.
 *
 * FALLBACK PATH — closed file or no tree-sitter layer:
 *   Regex-based extraction. Covers:
 *     C/C++  — static/inline/extern qualifiers + return type + name(
 *     JS/TS  — function decl, const/let/var arrow, async arrow, class
 *     registerTool() style — registerTool('name', async (...)
 *
 * EXPORTED API:
 *   getSymbolsFromEditor(editor)
 *     → [{ name, startRow, endRow, sig, kind }]  (0-based rows)
 *     Always returns endRow via brace-count from the node's startRow.
 *
 *   getSymbolsFromText(text, filePath)
 *     → [{ name, startRow, endRow, sig, kind }]  (0-based rows)
 *     Pure regex, used for closed files.
 *
 *   getSymbols(editorOrNull, text, filePath)
 *     Convenience: tries editor first, falls back to text.
 *
 *   findFunction(symbols, name, hints)
 *     Filters symbols by name + optional hints:
 *       hints.occurrence  — 1-based occurrence index
 *       hints.lineNumberHint    — prefer symbol whose startRow is closest
 *       hints.afterHint   — restrict to symbols starting after this row
 *       hints.betweenHint — { startRow, endRow } restrict to range
 *     Returns the single best match or null.
 *
 *   braceEndRow(lines, fromRow)
 *     Shared brace-counting utility. Given 0-based lines array and a
 *     starting row (which may or may not contain the first {), walks
 *     forward and returns the 0-based row of the matching closing brace,
 *     or -1 if not found.
 */

'use strict';

// ── Regex fallbacks ────────────────────────────────────────────────────────

// C/C++ function definition: optional qualifiers, return type, name(
const C_FN_RE = /^(?:(?:static|inline|extern|const|unsigned|signed|long|short|struct|enum|void)\s+)*[\w\s*]+\b(?!if\b|for\b|while\b|switch\b|return\b|else\b|do\b)(\w+)\s*\([^;)]*\)\s*(?:\{|$)/;

// JS/TS: function decl, const/let/var arrow, async arrow, class
const JS_FN_RE = /(?:^|\s)(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(?)|(?:^|\s)class\s+(\w+)/;

// registerTool('name', ...) — direct string literal form
const REGISTER_TOOL_RE = /registerTool\s*\(\s*['"`]([\w-]+)['"`]/;

// const curTool = "name"; — the pattern used in mcp-registration.js where the tool name
// is assigned to curTool first, then passed to server.registerTool(curTool, ...).
// We match the assignment line and treat the whole block as the function body.
const CUR_TOOL_RE = /^\s*const\s+curTool\s*=\s*['"`]([\w-]+)['"`]\s*;/;

// C-like file extensions
const C_EXT_RE = /\.(c|h|cpp|cc|cxx|hpp)$/i;
// JS/TS file extensions
const JS_EXT_RE = /\.(js|ts|jsx|tsx|mjs|cjs)$/i;

// ── Brace-count utility ────────────────────────────────────────────────────

/**
 * Walk forward from fromRow finding the closing brace that matches the
 * first { encountered. Returns 0-based row index or -1.
 * lines: string[] (0-based)
 */
function braceEndRow(lines, fromRow) {
  let depth = 0;
  for (let i = fromRow; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

// ── Tree-sitter path ───────────────────────────────────────────────────────

/**
 * Extract symbols from an open Pulsar editor using tree-sitter.
 * Returns [] if the editor has no tree-sitter layer (falls through to regex).
 */
function getSymbolsFromEditor(editor) {
  try {
    const langMode = editor.getBuffer().getLanguageMode();
    const layer    = langMode && langMode.rootLanguageLayer;
    const tree     = layer && layer.tree;
    const tq       = layer && layer.tagsQuery;
    if (!tree || !tq) return [];

    const captures = tq.captures(tree.rootNode);
    const allLines = editor.getText().split(/\r?\n/);

    // First pass: collect definition nodes keyed by the walked-up node's id
    // so the second pass can match via ancestor traversal.
    const defs = new Map();
    for (const cap of captures) {
      if (cap.name.startsWith('definition.')) {
        let node = cap.node;
        // Walk up while the parent starts on the same row — reaches the full
        // function_declaration / arrow_function / method_definition node
        while (node.parent && node.parent.startPosition.row === node.startPosition.row) {
          node = node.parent;
        }
        const entry = {
          node,
          kind:     cap.name.slice('definition.'.length),
          startRow: node.startPosition.row,
          endRow:   node.endPosition.row,
        };
        // Key by both the original capture node id AND the walked-up node id
        defs.set(cap.node.id, entry);
        if (node.id !== cap.node.id) defs.set(node.id, entry);
      }
    }

    // Second pass: find 'name' captures whose ancestor is a definition node.
    // Walk up from the name node until we find a def entry or hit the root.
    const symbols = [];
    const seen = new Set();
    for (const cap of captures) {
      if (cap.name !== 'name') continue;
      let ancestor = cap.node.parent;
      let def = null;
      while (ancestor) {
        def = defs.get(ancestor.id);
        if (def) break;
        ancestor = ancestor.parent;
      }
      if (!def) continue;
      // Deduplicate — a definition node can match multiple name captures
      if (seen.has(def.node.id)) continue;
      seen.add(def.node.id);

      const sig = allLines[def.startRow] || cap.node.text;
      symbols.push({
        name:     cap.node.text,
        startRow: def.startRow,
        endRow:   def.endRow,
        sig:      sig.trimEnd(),
        kind:     def.kind,
      });
    }

    return symbols;
  } catch (_e) {
    return [];
  }
}

// ── Regex fallback path ────────────────────────────────────────────────────

/**
 * Extract symbols from raw text using regex.
 * filePath is used to pick the right regex set.
 * Returns same shape as getSymbolsFromEditor.
 */
function getSymbolsFromText(text, filePath) {
  const lines  = text.split(/\r?\n/);
  const isC    = C_EXT_RE.test(filePath || '');
  const isJs   = JS_EXT_RE.test(filePath || '');
  const symbols = [];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const trimmed = l.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    let name = null;
    let kind = 'function';

    // curTool pattern — const curTool = "name"; (mcp-registration.js style)
    const ctm = CUR_TOOL_RE.exec(l);
    if (ctm) {
      name = ctm[1];
      kind = 'registerTool';
      // endRow: scan forward for server.registerTool( then brace-count from there
      let braceStart = -1;
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (/registerTool\s*\(/.test(lines[j])) { braceStart = j; break; }
      }
      const endR = braceStart !== -1 ? braceEndRow(lines, braceStart) : i;
      if (endR > i) {
        symbols.push({ name, startRow: i, endRow: endR, sig: l.trimEnd(), kind });
      }
      continue; // skip the hasBrace check below
    }

    // registerTool pattern — direct string literal form
    const rtm = REGISTER_TOOL_RE.exec(l);
    if (rtm) {
      name = rtm[1];
      kind = 'registerTool';
    } else if (isC) {
      const m = C_FN_RE.exec(l);
      if (m) name = m[1];
    } else if (isJs) {
      const m = JS_FN_RE.exec(l);
      if (m) {
        name = m[1] || m[2] || m[3];
        kind = m[3] ? 'class' : 'function';
      }
    } else {
      // Unknown extension — try both
      const m = JS_FN_RE.exec(l) || C_FN_RE.exec(l);
      if (m) name = m[1] || m[2] || m[3];
    }

    if (!name || name.length < 2) continue;

    // Need a { somewhere within 6 lines (handles K&R and multi-line sigs)
    let hasBrace = false;
    for (let j = i; j < Math.min(i + 6, lines.length); j++) {
      if (lines[j].includes('{')) { hasBrace = true; break; }
      if (j > i && lines[j].includes(';')) break;
    }
    if (!hasBrace) continue;

    const endRow = braceEndRow(lines, i);
    symbols.push({
      name,
      startRow: i,
      endRow:   endRow === -1 ? i : endRow,
      sig:      l.trimEnd(),
      kind,
    });
  }

  return symbols;
}

// ── Convenience wrapper ────────────────────────────────────────────────────

/**
 * Try tree-sitter via editor; fall back to regex via text.
 * editor may be null/undefined.
 * text may be null/undefined (will be read from editor if needed).
 * filePath used for regex language detection.
 */
function getSymbols(editor, text, filePath) {
  if (editor) {
    const syms = getSymbolsFromEditor(editor);
    if (syms.length > 0) return syms;
    // Tree-sitter returned nothing — fall through to regex on buffer text
    text     = text || editor.getText();
    filePath = filePath || editor.getPath() || '';
  }
  if (!text) return [];
  return getSymbolsFromText(text, filePath || '');
}

// ── findFunction ───────────────────────────────────────────────────────────

/**
 * Filter a symbols array down to the best single match for `name`.
 *
 * hints (all optional):
 *   occurrence  {number}  — 1-based; pick the Nth match by startRow order
 *   lineNumberHint    {number}  — 0-based row; prefer closest match
 *   afterRow    {number}  — 0-based; only consider symbols starting >= this row
 *   betweenRows {start,end} — 0-based; only consider symbols in range
 *
 * Returns { name, startRow, endRow, sig, kind } or null.
 */
function findFunction(symbols, name, hints = {}) {
  const { occurrence = 1, lineNumberHint, afterRow, betweenRows } = hints;

  let candidates = symbols.filter(s => s.name === name);

  if (afterRow != null) {
    candidates = candidates.filter(s => s.startRow >= afterRow);
  }
  if (betweenRows) {
    candidates = candidates.filter(
      s => s.startRow >= betweenRows.start && s.startRow <= betweenRows.end
    );
  }

  // Sort by startRow ascending
  candidates.sort((a, b) => a.startRow - b.startRow);

  if (candidates.length === 0) return null;

  // occurrence:N
  if (occurrence > 1) {
    return candidates[occurrence - 1] || null;
  }

  // lineNumberHint: pick closest
  if (lineNumberHint != null) {
    let best = candidates[0];
    let bestDist = Math.abs(best.startRow - lineNumberHint);
    for (const c of candidates) {
      const dist = Math.abs(c.startRow - lineNumberHint);
      if (dist < bestDist) { best = c; bestDist = dist; }
    }
    return best;
  }

  // Default: first
  return candidates[0];
}

// ── Anchor resolution ───────────────────────────────────────────────────────

/**
 * resolveAnchor(hint, symbols, text)
 *
 * Resolves a hint string to a { row, via } object using a semantic chain:
 *
 *   1. Symbol name match (exact):
 *        1 match  → { row: sym.endRow, via: 'symbolEnd', sym }
 *        2+ match → { ambiguous: true, via: 'symbolEnd', matches: [{name,startRow,endRow}...] }
 *   2. Pure integer string → { row: parseInt(hint)-1, via: 'lineNumber' }
 *   3. Raw string (text.indexOf):
 *        found once  → { row, charIdx, via: 'string' }
 *        found 2+    → { ambiguous: true, via: 'string', matches: [row...] }
 *   4. Not found → null
 *
 * row is always 0-based.
 * charIdx is the character index of the END of the matched string in text
 * (i.e. text.indexOf(hint) + hint.length), useful for searchStart in str_replace.
 *
 * For afterHint:         use result.row as lower-bound row (search from row+1).
 * For betweenHint.start: use result.row as range start.
 * For betweenHint.end:   use result.row as range end (sym.endRow = closing brace row).
 */
function resolveAnchor(hint, symbols, text) {
  if (hint == null) return null;

  // ── 1. Symbol name match ─────────────────────────────────────────────────
  const symMatches = symbols.filter(s => s.name === hint);
  if (symMatches.length === 1) {
    return { row: symMatches[0].endRow, via: 'symbolEnd', sym: symMatches[0] };
  }
  if (symMatches.length > 1) {
    return {
      ambiguous: true,
      via: 'symbolEnd',
      matches: symMatches.map(s => ({ name: s.name, startRow: s.startRow, endRow: s.endRow })),
    };
  }

  // ── 2. Pure integer → treat as 1-based line number ───────────────────────
  if (/^\d+$/.test(hint.trim())) {
    const n = parseInt(hint.trim(), 10);
    if (n >= 1) return { row: n - 1, via: 'lineNumber' };
  }

  // ── 3. Raw string scan ───────────────────────────────────────────────────
  if (!text) return null;
  const indices = [];
  let pos = 0;
  while (pos < text.length) {
    const idx = text.indexOf(hint, pos);
    if (idx === -1) break;
    indices.push(idx);
    pos = idx + hint.length;
  }

  if (indices.length === 0) return null;

  if (indices.length > 1) {
    const rows = indices.map(i => text.substring(0, i + hint.length).split('\n').length - 1);
    return { ambiguous: true, via: 'string', matches: rows };
  }

  // Exactly one string match
  const charIdx = indices[0] + hint.length;
  const row = text.substring(0, charIdx).split('\n').length - 1;
  return { row, charIdx, via: 'string' };
}

// ── Position resolvers ───────────────────────────────────────────────────────

const HINT_RADIUS = 25;

/**
 * resolveSymbolPosition(symbols, name, kind, direction)
 *
 * Resolves a named symbol to a search/insert window.
 *
 * kind:
 *   'function' — only considers symbols with kind 'function' or 'registerTool'
 *   'any'      — considers all symbol kinds (struct, class, enum, typedef, etc.)
 *                Requires tree-sitter; returns { needsTreeSitter: true } if
 *                symbols array is empty and kind === 'any'.
 *
 * direction:
 *   'inside'  — window = startRow..endRow  (search scoped to symbol body)
 *   'after'   — anchor = endRow,   window = anchor..anchor+HINT_RADIUS
 *   'before'  — anchor = startRow, window = anchor-HINT_RADIUS..anchor
 *
 * Returns one of:
 *   { anchorRow, startRow, endRow, sym }          — success (0-based rows)
 *   { ambiguous: true, matches: [{name,startRow,endRow,kind}...] }
 *   { notFound: true }
 *   { needsTreeSitter: true }                      — kind==='any' but no symbols
 */
function resolveSymbolPosition(symbols, name, kind, direction) {
  // Filter by kind
  const FUNCTION_KINDS = new Set(['function', 'registerTool']);
  let candidates = kind === 'function'
    ? symbols.filter(s => s.name === name && FUNCTION_KINDS.has(s.kind))
    : symbols.filter(s => s.name === name);

  // If kind==='any' and no candidates at all (empty symbols array = no tree-sitter)
  if (kind === 'any' && symbols.length === 0) {
    return { needsTreeSitter: true };
  }

  if (candidates.length === 0) return { notFound: true };

  if (candidates.length > 1) {
    return {
      ambiguous: true,
      matches: candidates.map(s => ({
        name: s.name, startRow: s.startRow, endRow: s.endRow, kind: s.kind,
      })),
    };
  }

  const sym = candidates[0];

  if (direction === 'inside') {
    return { anchorRow: sym.startRow, startRow: sym.startRow, endRow: sym.endRow, sym };
  }
  if (direction === 'after') {
    const anchorRow = sym.endRow;
    return { anchorRow, startRow: anchorRow, endRow: anchorRow + HINT_RADIUS, sym };
  }
  // 'before'
  const anchorRow = sym.startRow;
  return { anchorRow, startRow: Math.max(0, anchorRow - HINT_RADIUS), endRow: anchorRow, sym };
}

/**
 * resolveStringPosition(allLines, text, direction)
 *
 * Finds the first line containing `text` and returns a search/insert window.
 *
 * direction: 'after'  → window = anchorRow..anchorRow+HINT_RADIUS
 *            'before' → window = anchorRow-HINT_RADIUS..anchorRow
 *
 * Returns one of:
 *   { anchorRow, startRow, endRow }
 *   { ambiguous: true, rows: [number...] }   — text found on multiple lines
 *   { notFound: true }
 */
function resolveStringPosition(allLines, text, direction) {
  const rows = [];
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i].includes(text)) rows.push(i);
  }
  if (rows.length === 0) return { notFound: true };
  if (rows.length > 1)   return { ambiguous: true, rows };

  const anchorRow = rows[0];
  if (direction === 'after') {
    return { anchorRow, startRow: anchorRow, endRow: anchorRow + HINT_RADIUS };
  }
  // 'before'
  return { anchorRow, startRow: Math.max(0, anchorRow - HINT_RADIUS), endRow: anchorRow };
}

/**
 * resolveLinePosition(lineCount, n, direction)
 *
 * Converts a 1-based line number into a search/insert window.
 * Always succeeds — clamps to file bounds.
 *
 * direction: 'after'  → window = anchorRow..anchorRow+HINT_RADIUS
 *            'before' → window = anchorRow-HINT_RADIUS..anchorRow
 *
 * Returns { anchorRow, startRow, endRow }  (0-based rows)
 */
function resolveLinePosition(lineCount, n, direction) {
  const anchorRow = Math.max(0, Math.min(n - 1, lineCount - 1));
  if (direction === 'after') {
    return { anchorRow, startRow: anchorRow, endRow: Math.min(anchorRow + HINT_RADIUS, lineCount - 1) };
  }
  // 'before'
  return { anchorRow, startRow: Math.max(0, anchorRow - HINT_RADIUS), endRow: anchorRow };
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  getSymbolsFromEditor,
  getSymbolsFromText,
  getSymbols,
  findFunction,
  resolveAnchor,
  braceEndRow,
  resolveSymbolPosition,
  resolveStringPosition,
  resolveLinePosition,
  HINT_RADIUS,
  C_FN_RE,
  JS_FN_RE,
  REGISTER_TOOL_RE,
};
