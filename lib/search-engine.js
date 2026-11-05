'use strict';

/**
 * search-engine.js — Shared line-scanning engine for pulsar-edit-mcp-server's
 * search-family tools (find-text, grep-file, grep-project, search-symbol).
 *
 * Companion to match-engine.js (B24), but for the read/search side. Those
 * four tools each independently reimplemented the same pattern-compile +
 * line-scan + context/occurrence/truncation loop — this file is that loop,
 * extracted once. See mcp-server-refactor-plan.md for the duplication
 * writeup this closes out.
 *
 * Zero Atom dependencies — pure string/array manipulation, same discipline
 * as recover.js. Callers own everything tool-specific:
 *   - getting `lines` however they get them (live buffer text, a single
 *     file's readTextFromFile() result, or one call per walked project file)
 *   - stats bumping (bump/logFailure) — stats keys stay per-tool
 *   - response envelope shape (buildSearchResponse / ctx.fail / etc.)
 *   - stale-file tracking — grep-project's staleFiles bookkeeping stays
 *     in grep-project, this file has no concept of file identity at all
 *
 * ─────────────────────────────────────────────────────────────────────────
 * compilePattern({ query, regex, caseSensitive })
 *   Builds a RegExp the same way all four tools did independently: escapes
 *   the query unless regex:true, defaults to case-insensitive unless
 *   caseSensitive:true. Throws { code: 'invalidRegex' } on bad regex —
 *   callers decide how to surface that (ctx.fail vs throw new Error).
 *
 * scanLines(lines, pattern, opts)
 *   The shared loop itself. Covers what the four tools already had, plus
 *   the grep options that were identified as missing against real grep
 *   semantics (verified against the GNU grep manual, not GPL source):
 *
 *     occurrence     Nth match only, 1-based (existing behavior)
 *     before/after   asymmetric context — real grep -A N -B M semantics
 *     contextLines   legacy symmetric shorthand (-C) — before/after win
 *                    if either is explicitly given
 *     maxMatches     cap + truncated flag (existing behavior)
 *     invertMatch    return non-matching lines instead (-v)
 *     onlyMatching   return matched substring(s), not the full line (-o)
 *     countOnly      skip building entries, just count (-c)
 *     stopAtFirst    bail after the first match — cheap existence check,
 *                    for a filesWithMatches (-l) caller that only needs
 *                    to know a file matched at all, not every line
 *     entryExtra(i)  optional (lineIndex) => object merged into each
 *                    entry — how grep-project attaches { filePath }
 *                    without this file needing to know what a file is
 *     filter(text,i) optional secondary predicate applied after the main
 *                    pattern match — how search-symbol's definitionsOnly
 *                    (a check on top of the word-boundary match) plugs in
 *                    without this file needing to know what a "definition"
 *                    looks like
 *
 *   Returns { matches, matchCount, truncated, globalIndex }.
 *   countOnly returns matches:[] with matchCount still populated from
 *   globalIndex, so callers never need a separate code path for -c.
 */

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- R4g (2026-10-31): the POSIX matcher -------------------------------------------------------------
// scanLines works on a "matcher": { test(line) -> boolean, all(line) -> every non-overlapping match
// as a string }. A plain RegExp is wrapped by toMatcher(); the POSIX matcher is built here.
const posix = require('./posix-regex');

function invalidRegexError(message) {
  const err = new Error(`Invalid regex: ${message}`);
  err.code = 'invalidRegex';
  return err;
}

// ---- R4g (2026-10-31): grep -w (wordRegexp) and grep -x (lineRegexp), checked against GNU grep 3.11 ----------
// A matcher is built from find(line, from) -> { start, end } | null; test and all come from it.
const WORD_CHAR = /[\p{L}\p{N}_]/u; // letters, digits and the underscore, like a UTF-8 grep
const isWordChar = (ch) => ch !== undefined && WORD_CHAR.test(ch);
const wordBounded = (line, start, end) => !isWordChar(line[start - 1]) && !isWordChar(line[end]);

// grep -w: a match counts only if the character before it and the one after it are not word characters. When the
// longest match at a start fails that test, grep tries shorter matches anchored at the same start (matching the
// text cut one character short), and only then the next start. run(text, from) is the engine's exec.
function findWord(run, line, from) {
  let m = run(line, from);
  while (m) {
    const s = m.start[0];
    let e = m.end[0];
    for (;;) {
      if (wordBounded(line, s, e)) return { start: s, end: e };
      if (e <= s) break;
      const shorter = run(line.slice(0, e - 1), s);
      if (shorter && shorter.start[0] === s && shorter.end[0] > s) e = shorter.end[0]; else break;
    }
    if (s + 1 > line.length) break;
    m = run(line, s + 1);
  }
  return null;
}

function matcherFromFind(find) {
  return {
    test(line) { return find(line, 0) !== null; },
    // like grep -o: leftmost, non-overlapping, empty matches skipped; ^ and the word tests look at the whole line
    all(line) {
      const found = [];
      let from = 0;
      while (from <= line.length) {
        const m = find(line, from);
        if (!m) break;
        if (m.end === m.start) { from = m.start + 1; continue; }
        found.push(line.slice(m.start, m.end));
        from = m.end;
      }
      return found;
    },
  };
}

// the same two options for a literal query (grep -F -w, -F -x), without the regex engine
function compileLiteralWhole(query, { caseSensitive, wordRegexp, lineRegexp }) {
  const body = escapeRegex(query);
  const occurrences = new RegExp(body, caseSensitive ? 'g' : 'gi');
  const whole = new RegExp('^' + body + '$', caseSensitive ? '' : 'i');
  const find = (line, from) => {
    if (lineRegexp) return from === 0 && whole.test(line) ? { start: 0, end: line.length } : null;
    occurrences.lastIndex = from;
    let m;
    while ((m = occurrences.exec(line)) !== null) {
      const s = m.index;
      const e = s + m[0].length;
      if (wordBounded(line, s, e)) return { start: s, end: e };
      occurrences.lastIndex = s + 1; // overlapping occurrences count too
      if (s + 1 > line.length) break;
    }
    return null;
  };
  return Object.assign(matcherFromFind(find), { kind: 'literal', source: query, caseSensitive: !!caseSensitive });
}

function compilePosix(query, { extended, caseSensitive, wordRegexp, lineRegexp }) {
  let re;
  try {
    re = posix.compile(query, { extended: !!extended, icase: !caseSensitive, grep: true }); // grep: GNU grep's lenient syntax (R4j), not sed's strict one
  } catch (e) {
    throw invalidRegexError(e.message);
  }
  // exec() can also throw while matching ("Regular expression too complex"); report it the same way
  const run = (line, from) => {
    try { return re.exec(line, from); } catch (e) { throw invalidRegexError(e.message); }
  };
  const find = (line, from) => {
    if (lineRegexp) {
      // grep -x: the leftmost-longest match must be the whole line
      if (from > 0) return null;
      const m = run(line, 0);
      return m && m.start[0] === 0 && m.end[0] === line.length ? { start: 0, end: line.length } : null;
    }
    if (wordRegexp) return findWord(run, line, from);
    const m = run(line, from);
    return m ? { start: m.start[0], end: m.end[0] } : null;
  };
  return Object.assign(matcherFromFind(find), { kind: 'posix', source: query, extended: !!extended, caseSensitive: !!caseSensitive });
}

function toMatcher(pattern) {
  if (!(pattern instanceof RegExp)) return pattern;
  let globalPattern = null; // built lazily, only if onlyMatching is used
  return {
    test(line) {
      const hit = pattern.test(line);
      if (pattern.global) pattern.lastIndex = 0; // guard against stateful lastIndex on caller-supplied /g patterns
      return hit;
    },
    all(line) {
      if (!globalPattern) globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      return [...line.matchAll(globalPattern)].map(m => m[0]);
    },
  };
}

function compilePattern({ query, regex = false, extended = false, caseSensitive = false, wordRegexp = false, lineRegexp = false }) {
  // R4g: regex:true is a POSIX regex like plain grep (BRE; ERE with extended:true), compiled by
  // lib/posix-regex.js, the engine sed already uses. regex:false stays the fast path: a plain
  // RegExp of the escaped literal, the same thing as grep -F.
  // wordRegexp (grep -w) and lineRegexp (grep -x) work on both paths; like grep, -x wins when both are given.
  if (lineRegexp) wordRegexp = false;
  if (regex) return compilePosix(query, { extended, caseSensitive, wordRegexp, lineRegexp });
  if (wordRegexp || lineRegexp) return compileLiteralWhole(query, { caseSensitive, wordRegexp, lineRegexp });
  const flags = caseSensitive ? '' : 'i';
  try {
    return new RegExp(escapeRegex(query), flags);
  } catch (e) {
    const err = new Error(`Invalid regex: ${e.message}`);
    err.code = 'invalidRegex';
    throw err;
  }
}

function scanLines(lines, pattern, opts = {}) {
  const {
    occurrence = 0,
    before = 0,
    after = 0,
    contextLines = 0,
    maxMatches = 200,
    invertMatch = false,
    onlyMatching = false,
    countOnly = false,
    stopAtFirst = false,
    entryExtra = null,
    filter = null,
  } = opts;

  const effBefore = before || contextLines;
  const effAfter  = after  || contextLines;

  const matcher = toMatcher(pattern);

  const matches = [];
  let truncated = false;
  let globalIndex = 0;

  outer:
  for (let i = 0; i < lines.length; i++) {
    const isMatch = matcher.test(lines[i]);
    const selected = invertMatch ? !isMatch : isMatch;
    if (!selected) continue;

    if (filter && !filter(lines[i], i)) continue;

    globalIndex++;
    if (occurrence > 0 && globalIndex !== occurrence) continue;

    if (countOnly) {
      if (occurrence > 0) break outer;
      if (stopAtFirst) break outer;
      continue;
    }

    const entry = { line: i + 1, text: lines[i] };

    if (onlyMatching && !invertMatch) {
      entry.matchedParts = matcher.all(lines[i]);
    }

    if (effBefore > 0 || effAfter > 0) {
      entry.before = lines.slice(Math.max(0, i - effBefore), i)
        .map((t, j) => ({ line: Math.max(1, i - effBefore + 1) + j, text: t }));
      entry.after = lines.slice(i + 1, i + 1 + effAfter)
        .map((t, j) => ({ line: i + 2 + j, text: t }));
    }

    if (entryExtra) Object.assign(entry, entryExtra(i));

    matches.push(entry);
    if (occurrence > 0) break outer;
    if (stopAtFirst) break outer;
    if (matches.length >= maxMatches) { truncated = true; break outer; }
  }

  return {
    matches,
    matchCount: countOnly ? globalIndex : matches.length,
    truncated,
    globalIndex,
  };
}

// R4g: a note for a search that found nothing, about the ways POSIX syntax differs from the JavaScript
// patterns people write by habit. Returns a string, or null when the query shows none of them (and always
// null without regex:true: a literal query has no syntax). Only real syntax counts: backslash pairs and
// bracket expressions are skipped, so [|+] and a\|b raise nothing.
function regexHint({ query, regex, extended }) {
  if (!regex || typeof query !== 'string') return null;
  const bare = query.replace(/\\./g, '').replace(/\[\^?\]?(?:\[:[a-z]+:\]|[^\]])*\]/g, '');
  const notes = [];
  if (!extended && /[|+?(){}]/.test(bare)) {
    notes.push('In a basic regex (the default) a bare | + ? ( ) { } is literal text. Pass extended:true for an ERE like grep -E, or put a backslash before the operator (alternation is backslash-pipe).');
  }
  if (/\\[dD]/.test(query)) {
    notes.push('POSIX has no digit shorthand: a backslash and d matches the letter d. Use [0-9] or [[:digit:]].');
  }
  if (extended && /[*+?}]\?/.test(bare)) {
    notes.push('POSIX has no lazy quantifiers (*? +? ??): they are greedy.');
  }
  return notes.length ? 'Note: ' + notes.join(' ') : null;
}

// the same note ready to append to a message ('' when there is none)
function regexHintSuffix(args) {
  const hint = regexHint(args);
  return hint ? ' ' + hint : '';
}

module.exports = { compilePattern, scanLines, escapeRegex, regexHint, regexHintSuffix };
