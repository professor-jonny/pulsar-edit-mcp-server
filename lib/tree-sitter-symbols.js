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
 *       hints.nearLine      — prefer symbol whose startRow is closest
 *       hints.afterRow     — restrict to symbols starting after this row
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

// -- Code masker -------------------------------------------------------------

// A '/' after one of these characters (or after one of the keywords below) starts a regex literal;
// after anything else (identifier, number, ')' or ']') it is division.
const REGEX_PREV_CHARS = '(,=:[!&|?{};';
const REGEX_PREV_WORDS = new Set(['return', 'typeof', 'case', 'throw', 'delete', 'void', 'else', 'do', 'in', 'of']);

/**
 * Returns a stateful function mask(line) that gives back the SAME-LENGTH line with every character
 * that is not code (comment text, string and char literal contents, template literal text, regex
 * literals) replaced by a space, so column numbers still line up. Call it on consecutive rows: it
 * carries block comments and template literals (with nested ${ } expressions) across lines.
 * Strings and regex literals end at the end of the line. A '${' and its matching '}' are blanked,
 * the code between them is kept. Heuristic, not a parser: regex vs division is decided from the
 * previous significant character or keyword (see REGEX_PREV_CHARS).
 */
function makeLineMasker() {
  let inBlock = false;   // inside a /* ... */ comment
  const stack = [];      // open template literals: { t: 'tmpl' } text or { t: 'expr', depth } code
  let prev = '';         // last significant code character, '' at the start
  let word = '';         // identifier that ends at prev, '' when prev is not part of one
  return function mask(line) {
    const n = line.length;
    const out = new Array(n).fill(' ');
    let i = 0;
    while (i < n) {
      if (inBlock) {
        const e = line.indexOf('*/', i);
        if (e < 0) return out.join('');
        inBlock = false;
        i = e + 2;
        continue;
      }
      const top = stack.length ? stack[stack.length - 1] : null;
      if (top && top.t === 'tmpl') {
        while (i < n) {
          const tc = line[i];
          if (tc === '\\') { i += 2; continue; }
          if (tc === '`') { stack.pop(); i++; prev = ')'; word = ''; break; }
          if (tc === '$' && line[i + 1] === '{') { stack.push({ t: 'expr', depth: 0 }); i += 2; prev = '{'; word = ''; break; }
          i++;
        }
        continue;
      }
      const ch = line[i];
      const nx = line[i + 1];
      if (ch === '/' && nx === '/') return out.join('');
      if (ch === '/' && nx === '*') { inBlock = true; i += 2; continue; }
      if (ch === '/') {
        const regexOk = prev === '' || REGEX_PREV_CHARS.indexOf(prev) >= 0 || (word !== '' && REGEX_PREV_WORDS.has(word));
        if (regexOk) {
          let j = i + 1, inClass = false, found = false;
          while (j < n) {
            const rc = line[j];
            if (rc === '\\') { j += 2; continue; }
            if (inClass) { if (rc === ']') inClass = false; }
            else if (rc === '[') inClass = true;
            else if (rc === '/') { found = true; break; }
            j++;
          }
          if (found) {
            i = j + 1;
            while (i < n && /[a-z]/i.test(line[i])) i++;
            prev = ')'; word = '';
            continue;
          }
        }
        out[i] = '/'; prev = '/'; word = ''; i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < n) {
          if (line[j] === '\\') { j += 2; continue; }
          if (line[j] === ch) break;
          j++;
        }
        i = j + 1;
        prev = ')'; word = '';
        continue;
      }
      if (ch === '`') { stack.push({ t: 'tmpl' }); i++; continue; }
      if (top && top.t === 'expr') {
        if (ch === '{') top.depth++;
        else if (ch === '}') {
          if (top.depth === 0) { stack.pop(); i++; continue; }
          top.depth--;
        }
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i;
        while (j < n && /[\w$]/.test(line[j])) { out[j] = line[j]; j++; }
        word = line.slice(i, j);
        prev = line[j - 1];
        i = j;
        continue;
      }
      out[i] = ch;
      if (ch !== ' ' && ch !== '\t') { prev = ch; word = ''; }
      i++;
    }
    return out.join('');
  };
}

/**
 * Row of the closing brace of the function BODY whose signature starts at
 * fromRow. Unlike braceEndRow it skips braces inside the parameter list
 * (object destructuring, '= {}' defaults), which made braceEndRow return the
 * signature row for e.g. 'function f({ a, b }) {' (2026-10-11).
 *
 * The body brace is the first '{' met at paren depth 0 within 6 rows of
 * fromRow (the same window getSymbolsFromText uses for its hasBrace check).
 * A ';' at paren depth 0 before any such brace means "no body here", and when
 * no body brace is found at all this returns exactly what braceEndRow returns,
 * so one-line arrow bodies, object literals and call expressions behave as
 * before. Only the signature is paren-sensitive; the body is counted with plain
 * brace counting, so a stray '(' inside the body cannot break it.
 * Braces and parens inside comments, strings, template literals and regex
 * literals are ignored (makeLineMasker, 2026-10-16); before that one stray '{'
 * in a comment made this return -1 and the symbol collapsed to its signature
 * row. The no-body fallback still calls braceEndRow, which counts every brace.
 * Returns a 0-based row or -1.
 */
function bodyEndRow(lines, fromRow) {
  const last = Math.min(fromRow + 6, lines.length);
  // Rows are masked lazily and strictly in order (the masker carries block comment and template
  // literal state from row to row), so only the rows up to the body's closing brace are scanned.
  const mask = makeLineMasker();
  const masked = [];
  const at = (row) => {
    while (masked.length <= row - fromRow) masked.push(mask(lines[fromRow + masked.length]));
    return masked[row - fromRow];
  };
  let parenDepth = 0;
  for (let i = fromRow; i < last; i++) {
    const line = at(i);
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '(') parenDepth++;
      else if (ch === ')') { if (parenDepth > 0) parenDepth--; }
      else if (ch === ';' && parenDepth === 0) return braceEndRow(lines, fromRow);
      else if (ch === '{' && parenDepth === 0) {
        let depth = 1;
        for (let j = i; j < lines.length; j++) {
          const l2 = at(j);
          for (let k = (j === i ? c + 1 : 0); k < l2.length; k++) {
            if (l2[k] === '{') depth++;
            else if (l2[k] === '}') { depth--; if (depth === 0) return j; }
          }
        }
        return -1;
      }
    }
  }
  return braceEndRow(lines, fromRow);
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
        while (node.parent && node.parent.startPosition &&
               node.parent.startPosition.row === node.startPosition.row) {
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
      while (ancestor && ancestor.startPosition) {
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
    console.warn('[tree-sitter-symbols] getSymbolsFromEditor failed:', _e && _e.message || _e);
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
  // B36 fix: previously, an unrecognized extension (e.g. .md, .txt) fell through
  // to the "unknown extension — try both" branch below, running JS_FN_RE/C_FN_RE
  // against every line including markdown fenced-code-block content. A doc's own
  // illustrative JS snippets (e.g. "const scope = resolveScope(...)") would then
  // match JS_FN_RE and get returned as fake symbols, silently defeating B30/B31's
  // symbols.length === 0 gate (which exists specifically to detect "this file type
  // has no real function/symbol table" and steer away from inFunction/afterFunction).
  // Fix: bail out to an empty symbols array for anything that isn't a recognized
  // code extension, rather than guessing via regex on unrelated file types.
  if (!isC && !isJs) return [];
  const symbols = [];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const trimmed = l.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    let name = null;
    let allowShort = false; // true only for explicit function/class declarations and function-valued consts
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
        // One-letter names (function f, class C, const h = (a) => ...) are real symbols;
        // a bare 'const a = 1' / 'let i = 0' is not, so m[2] needs a visible function form.
        allowShort = !!(m[1] || m[3] ||
          /=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|\w+\s*=>)/.test(l));
      }
    }
    // B36: the old "unknown extension — try both" else-branch here is now
    // unreachable — the function returns [] early above for any filePath that
    // is neither isC nor isJs, so by this point one of the two is always true.

    if (!name || (name.length < 2 && !allowShort)) continue;

    // Need a { somewhere within 6 lines (handles K&R and multi-line sigs)
    let hasBrace = false;
    for (let j = i; j < Math.min(i + 6, lines.length); j++) {
      if (lines[j].includes('{')) { hasBrace = true; break; }
      if (j > i && lines[j].includes(';')) break;
    }
    if (!hasBrace) continue;

    const endRow = bodyEndRow(lines, i);
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
 *   nearLine    {number}  — 0-based row; prefer closest match
 *   afterRow    {number}  — 0-based; only consider symbols starting >= this row
 *   betweenRows {start,end} — 0-based; only consider symbols in range
 *
 * Returns { name, startRow, endRow, sig, kind } or null.
 */
function findFunction(symbols, name, hints = {}) {
  const { occurrence = 1, nearLine, afterRow, betweenRows } = hints;

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

  // nearLine: pick closest
  if (nearLine != null) {
    let best = candidates[0];
    let bestDist = Math.abs(best.startRow - nearLine);
    for (const c of candidates) {
      const dist = Math.abs(c.startRow - nearLine);
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
 * For afterString:        use result.row as lower-bound row (search from row+1).
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
function resolveSymbolPosition(symbols, name, kind, direction, radius = HINT_RADIUS) {
  // Filter by kind
  const FUNCTION_KINDS = new Set(['function', 'method', 'registerTool']);
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
    return { anchorRow, startRow: anchorRow, endRow: anchorRow + radius, sym };
  }
  // 'before'
  const anchorRow = sym.startRow;
  return { anchorRow, startRow: Math.max(0, anchorRow - radius), endRow: anchorRow, sym };
}

/**
 * resolveStringPosition(allLines, text, direction)
 *
 * Finds the first line containing `text` and returns a search/insert window.
 * B25: if `text` spans multiple lines (contains '\n'), delegates to
 * resolveMultiLineStringPosition instead of always returning notFound.
 *
 * direction: 'after'  → window = anchorRow..anchorRow+HINT_RADIUS
 *            'before' → window = anchorRow-HINT_RADIUS..anchorRow
 *
 * Returns one of:
 *   { anchorRow, startRow, endRow }
 *   { ambiguous: true, rows: [number...], multiLine? }   — text found on multiple lines
 *   { notFound: true, multiLine? }
 */
function resolveStringPosition(allLines, text, direction, radius = HINT_RADIUS, opts = {}) {
  if (text.includes('\n')) {
    return resolveMultiLineStringPosition(allLines, text, direction, radius);
  }

  const rows = [];
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i].includes(text)) rows.push(i);
  }

  let viaFuzzyWhitespace = false;
  if (rows.length === 0 && opts.fuzzyWhitespace) {
    const normText = text.trim().replace(/\s+/g, ' ');
    for (let i = 0; i < allLines.length; i++) {
      if (allLines[i].trim().replace(/\s+/g, ' ').includes(normText)) rows.push(i);
    }
    if (rows.length > 0) viaFuzzyWhitespace = true;
  }

  if (rows.length === 0) return { notFound: true };
  if (rows.length > 1)   return { ambiguous: true, rows, viaFuzzyWhitespace };

  const anchorRow = rows[0];
  if (direction === 'after') {
    return { anchorRow, startRow: anchorRow, endRow: anchorRow + radius, viaFuzzyWhitespace };
  }
  // 'before'
  return { anchorRow, startRow: Math.max(0, anchorRow - HINT_RADIUS), endRow: anchorRow, viaFuzzyWhitespace };
}

/**
 * resolveMultiLineStringPosition(allLines, text, direction, radius)
 *
 * B25 feature fix: `resolveStringPosition` used to scan single lines only
 * (allLines[i].includes(text)), so a multi-line `text` (containing '\n')
 * could never match — always notFound, silently. This scans for
 * `textLines.length` consecutive `allLines` entries that match the split
 * `text`, exact first, then trim-fuzzy if no exact block is found.
 *
 * direction: 'after'  → anchor is the LAST line of the matched block,
 *                       window = anchorRow..anchorRow+radius
 *            'before' → anchor is the FIRST line of the matched block,
 *                       window = anchorRow-radius..anchorRow
 *
 * Returns the same shape as resolveStringPosition so callers need no changes:
 *   { anchorRow, startRow, endRow, multiLine: true, viaTrim? }
 *   { ambiguous: true, rows: [number...], multiLine: true }
 *   { notFound: true, multiLine: true }
 */
function resolveMultiLineStringPosition(allLines, text, direction, radius = HINT_RADIUS) {
  const textLines = text.split('\n');
  const n = textLines.length;

  const scanFor = (cmp) => {
    const hits = [];
    for (let i = 0; i + n <= allLines.length; i++) {
      let ok = true;
      for (let j = 0; j < n; j++) {
        if (!cmp(allLines[i + j], textLines[j])) { ok = false; break; }
      }
      if (ok) hits.push(i);
    }
    return hits;
  };

  // Exact line-for-line match first.
  let rows = scanFor((a, b) => a === b);
  let viaTrim = false;

  // Fall back to trim-fuzzy (handles indentation drift between lines) if no exact block found.
  if (rows.length === 0) {
    rows = scanFor((a, b) => a.trim() === b.trim());
    viaTrim = rows.length > 0;
  }

  if (rows.length === 0) return { notFound: true, multiLine: true };
  if (rows.length > 1)   return { ambiguous: true, rows, multiLine: true };

  const blockStartRow = rows[0];
  const blockEndRow   = blockStartRow + n - 1;

  if (direction === 'after') {
    const anchorRow = blockEndRow;
    return { anchorRow, startRow: anchorRow, endRow: anchorRow + radius, multiLine: true, viaTrim };
  }
  // 'before'
  const anchorRow = blockStartRow;
  return { anchorRow, startRow: Math.max(0, anchorRow - radius), endRow: anchorRow, multiLine: true, viaTrim };
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
function resolveLinePosition(lineCount, n, direction, radius = HINT_RADIUS) {
  const anchorRow = Math.max(0, Math.min(n - 1, lineCount - 1));
  if (direction === 'after') {
    return { anchorRow, startRow: anchorRow, endRow: Math.min(anchorRow + radius, lineCount - 1) };
  }
  // 'before'
  return { anchorRow, startRow: Math.max(0, anchorRow - radius), endRow: anchorRow };
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  getSymbolsFromEditor,
  getSymbolsFromText,
  getSymbols,
  findFunction,
  resolveAnchor,
  braceEndRow,
  bodyEndRow,
  resolveSymbolPosition,
  resolveStringPosition,
  resolveMultiLineStringPosition,
  resolveLinePosition,
  HINT_RADIUS,
  C_FN_RE,
  JS_FN_RE,
  REGISTER_TOOL_RE,
};
