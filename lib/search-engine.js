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

function compilePattern({ query, regex = false, caseSensitive = false }) {
  const source = regex ? query : escapeRegex(query);
  const flags = caseSensitive ? '' : 'i';
  try {
    return new RegExp(source, flags);
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

  // Only built lazily if onlyMatching is actually used — avoids surprising
  // behavior if pattern already carries a 'g' flag from a caller-supplied RegExp.
  const globalPattern = onlyMatching
    ? new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')
    : null;

  const matches = [];
  let truncated = false;
  let globalIndex = 0;

  outer:
  for (let i = 0; i < lines.length; i++) {
    const isMatch = pattern.test(lines[i]);
    if (pattern.global) pattern.lastIndex = 0; // guard against stateful lastIndex on caller-supplied /g patterns
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
      entry.matchedParts = [...lines[i].matchAll(globalPattern)].map(m => m[0]);
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

module.exports = { compilePattern, scanLines, escapeRegex };
