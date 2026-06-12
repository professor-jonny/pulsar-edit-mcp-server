'use babel';
// ---------------------------------------------------------------------------
// lib/tool-hints.js — contextual hint/suggestion engine + consecutive failure
// counters for the MCP tool layer.
//
// Extracted from mcp-registration.js (Phase A, 2026-06-11).
// Zero Atom API dependencies — safe to require() at module load without Atom.
//
// Exports:
//   anchorError(hintName, hintValue, result, symbols)
//   smartSuggestion(ctx)
//   successNudge(ctx)
//   ambiguityCheck({ needle, fullText, scopedText, noScopeHint, toolName, isCodeFile, existingMatchLines })
// ---------------------------------------------------------------------------
const { calculateSimilarity } = require('./string-utils');

// ---------------------------------------------------------------------------
// anchorError — format a resolveAnchor failure/ambiguity into a user-facing
// error string. Returns a string or null (null = no error, anchor resolved OK).
// hintName:  'afterHint' | 'betweenHint.start' | 'betweenHint.end'
// result:    return value of resolveAnchor (null = not found, else check .ambiguous)
// ---------------------------------------------------------------------------
// symbols (optional) — array from getSymbols(); when provided and result===null,
//   a Levenshtein nearest-match suggestion is appended for symbol-name-style hints.
function anchorError(hintName, hintValue, result, symbols) {
  if (result === null) {
    let msg = `❌ ${hintName} "${hintValue}" not found — no matching symbol, line number, or string in file.`;
    // Nearest-symbol suggestion — only for identifier-style hints (no whitespace).
    if (symbols && symbols.length > 0 && /^\w+$/.test(hintValue)) {
      let bestPct = 0, bestName = '';
      for (const s of symbols) {
        const pct = calculateSimilarity(hintValue, s.name);
        if (pct > bestPct) { bestPct = pct; bestName = s.name; }
      }
      if (bestPct >= 60) {
        msg += `\n💡 Nearest symbol: "${bestName}" (${bestPct}% match) — did you mean that?`;
      }
    }
    return msg;
  }
  if (result.ambiguous) {
    if (result.via === 'symbolEnd') {
      const list = result.matches
        .map(m => `  L${m.startRow + 1}–L${m.endRow + 1}: ${m.name}`)
        .join('\n');
      return `❌ ${hintName} "${hintValue}" is ambiguous — ${result.matches.length} functions with that name:\n${list}\nUse occurrence:N or lineNumberHint to disambiguate. To scope the edit inside a specific function body, use functionHint instead.`;
    }
    // via === 'string'
    const list = result.matches.map(r => `  L${r + 1}`).join('\n');
    return `❌ ${hintName} "${hintValue}" is ambiguous — appears on ${result.matches.length} lines:\n${list}\nUse a more unique anchor string, or lineNumberHint.`;
  }
  return null; // resolved OK
}

// ---------------------------------------------------------------------------
// smartSuggestion — fires on EVERY failure, not just after 3.
// Also used to append nudges on success when no hints were used.
// ctx = { toolName, counter, noHintsUsed, fileLines, oldStr, isCodeFile }
// ---------------------------------------------------------------------------
function smartSuggestion(ctx) {
  const { toolName, counter, noHintsUsed, fileLines, oldStr, isCodeFile } = ctx;
  const parts = [];
  const n = counter ? counter.count : 0;

  // ── Hint nudge: always on failure when no hints were used ─────────────────
  if (noHintsUsed) {
    if (toolName === "str_replace" || toolName === "replace-block") {
      parts.push("💡 NO HINTS USED — retry with one of:");
      parts.push("   functionHint:\"name\"  → scope search to a named function body (immune to line drift)");
      parts.push("   afterHint:\"string\"   → start search after a unique anchor string");
      parts.push("   betweenHint:{start,end} → restrict to region between two anchors");
      parts.push("   occurrence:N          → target the Nth match if the pattern repeats");
      parts.push("   fuzzyWhitespace:true  \u2192 retry ignoring indentation differences");
      parts.push("   fuzzyContent:true     \u2192 retry ignoring encoding variants (smart-quotes, BOM, NBSP, box-drawing runs) — use when you know the chars but encoding may differ");
      parts.push("   regex:true            \u2192 wildcard over unknown/variable unicode, emoji, backticks, pipes — use when you can't reproduce the exact chars (e.g. old_str: '// [\\\\u2500-\\\\u257F]+ section [\\\\u2500-\\\\u257F]+' or '.+emoji.+')");
    } else if (toolName === "insert") {
      parts.push("💡 NO HINTS USED — retry with:");
      parts.push("   afterFunction:\"name\" / beforeFunction:\"name\" → insert after/before a named function (tree-sitter backed, drift-immune)");
      parts.push("   afterString:\"text\"   / beforeString:\"text\"   → insert after/before the line containing this text");
      parts.push("   afterSymbol:\"name\"   / beforeSymbol:\"name\"   → insert after/before any named symbol (class, const, etc)");
      parts.push("   afterContent/beforeContent → legacy content anchor (also valid)");
    } else if (toolName === "delete-line-range") {
      parts.push("💡 NO HINTS USED — line numbers shift after every edit. Prefer content-stable alternatives:");
      parts.push("   functionHint:\"name\"    → delete an entire named function");
      parts.push("   betweenHint:{start,end} → delete by anchor strings instead of line numbers");
      parts.push("   → Or use delete-block with startContent/endContent anchors");
    } else if (toolName === "delete-block") {
      parts.push("💡 NO HINTS USED — retry with:");
      parts.push("   startContent/endContent → delete lines between two unique anchor strings");
      parts.push("   sectionHint:\"name\"      → delete a named /* ===...=== */ banner block");
      parts.push("   preprocBlock:\"MACRO\"    → delete a #ifdef...#endif pair by macro name");
      parts.push("   functionHint:\"name\"     → scope the anchor search to a function body");
      parts.push("   → Call get-structural-anchors to list available sectionHint/preprocBlock names");
    }
  }

  // ── Code-aware tool suggestions ───────────────────────────────────────────
  if (isCodeFile && oldStr) {
    const str = oldStr.trim();
    // Looks like a whole function (has signature + opening brace + body)
    const looksLikeFunction =
      /^\s*(async\s+)?(\w+\s+)*\w+\s*\(/.test(str) &&
      str.includes("{") && str.includes("}") &&
      str.split("\n").length > 3;
    if (looksLikeFunction && toolName === "str_replace") {
      parts.push("🔧 old_str looks like a complete function — use replace-function-body instead:");
      parts.push("   replace-function-body name:\"functionName\" newBody:\"...\" is atomic, immune to line drift,");
      parts.push("   and preserves undo history as a single operation.");
    }
    // Looks like a block (has anchor + braces but not a full function sig)
    const looksLikeBlock = str.includes("{") && str.includes("}") && str.split("\n").length > 5 && !looksLikeFunction;
    if (looksLikeBlock && toolName === "str_replace") {
      parts.push("🔧 old_str looks like a brace-delimited block — consider replace-block:");
      parts.push("   replace-block anchor:\"first line of block\" newBody:\"...\" finds the block by content,");
      parts.push("   not line numbers, so it survives any upstream edits.");
    }
  }

  // ── Consecutive failure escalation ────────────────────────────────────────
  if (n >= 2) {
    const alts = {
      "str_replace":       "replace-function-body (whole function), replace-block (brace block), or replace-document (full rewrite)",
      "insert":            "afterFunction/beforeFunction (named function anchor), afterString/beforeString (content anchor), or get-structural-anchors to list available names",
      "delete-line-range": "delete-block with startContent/endContent or sectionHint/preprocBlock — call get-structural-anchors to list available names",
      "delete-block":      "delete-line-range with betweenHint:{start,end} for anchor-based deletion, or str_replace to remove specific content",
      "replace-block":     "replace-function-body if replacing a named function, or str_replace for smaller targeted edits",
      "apply-patch":       "str_replace for targeted edits or replace-function-body for whole-function rewrites",
      "sed":               "str_replace for single targeted edits or replace-all for global pattern replacement"
    };
    const alt = alts[toolName] || "a different editing tool";
    parts.push(`\n🔁 ${n} consecutive failures on ${toolName} — strongly consider switching to: ${alt}`);
  }

  // ── Large file nudge on first failure ────────────────────────────────────
  if (n === 1 && fileLines > 500 && noHintsUsed) {
    parts.push(`\n📏 File is ${fileLines} lines — on large files, hint-scoped edits are far more reliable than bare string matching.`);
  }

  return parts.length ? "\n" + parts.join("\n") : "";
}

// ---------------------------------------------------------------------------
// successNudge — soft nudge appended to SUCCESS responses when no hints used
// on a large file. Returns empty string on small files or when hints were used.
// ctx = { toolName, noHintsUsed, lineNumberHintOnly, matchedLineContent,
//         fileLines, oldStr, isCodeFile }
// ---------------------------------------------------------------------------
function successNudge(ctx) {
  const { toolName, noHintsUsed, lineNumberHintOnly, matchedLineContent, fileLines, oldStr, isCodeFile } = ctx;
  // Case 1: lineNumberHint used but no content-stable hint — suggest afterHint upgrade
  if (lineNumberHintOnly && matchedLineContent && fileLines >= 100) {
    const anchor = matchedLineContent.trim().substring(0, 80).replace(/"/g, '\\"');
    return `\n⚡ lineNumberHint is positional and drifts if lines are inserted above it.` +
      `\n   Next time use afterHint:"${anchor}" instead — it's content-stable and won't drift.`;
  }
  // Case 2: no hints at all on a large file
  if (!noHintsUsed || fileLines < 300) return "";
  const parts = [];
  parts.push(`\n⚡ Hint: no scoping hints used on a ${fileLines}-line file.`);
  if (isCodeFile && oldStr) {
    const str = oldStr.trim();
    const looksLikeFunction =
      /^\s*(async\s+)?(\w+\s+)*\w+\s*\(/.test(str) &&
      str.includes("{") && str.includes("}") && str.split("\n").length > 3;
    if (looksLikeFunction && toolName === "str_replace") {
      parts.push("   Next time use replace-function-body for whole-function rewrites — it's atomic and drift-immune.");
      return parts.join("\n");
    }
  }
  parts.push(`   Next time add functionHint, afterHint, or betweenHint to make the match drift-immune.`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// ambiguityCheck — shared by str_replace, replace-block, replace-function-body,
// delete-block, insert. Counts occurrences of needle in fullText and returns
// a blocking error object if ambiguous with no scope hint, or null if safe.
//
// needle        — the string/anchor being searched for
// fullText      — complete buffer text to scan (used for line number reporting)
// scopedText    — optional substring of fullText already restricted to the hint
//                 region; when provided the occurrence count is done on this
//                 narrower text so inFunction/inSymbol/betweenHint scopes don't
//                 count matches outside the region (fixes BUG-A).
// noScopeHint   — true when no scoping hint at all and occurrence<=1
// toolName      — for suggestions
// isCodeFile    — for code-specific suggestions
// existingMatchLines[] — optional pre-computed array of line numbers (avoids re-scan)
// ---------------------------------------------------------------------------
function ambiguityCheck({ needle, fullText, scopedText, noScopeHint, toolName, isCodeFile, existingMatchLines }) {
  if (!noScopeHint) return null; // scoped — caller is being deliberate
  // Use scopedText for the occurrence count when the caller already narrowed the
  // region (e.g. inFunction, betweenHint). Line numbers are reported relative to
  // fullText so we need the offset of scopedText inside fullText.
  const scanText   = scopedText !== undefined ? scopedText : fullText;
  const scanOffset = (scopedText !== undefined && scopedText !== fullText)
    ? fullText.indexOf(scopedText)   // may be -1 on huge files; safe fallback below
    : 0;
  const matchLines = existingMatchLines || (() => {
    const lines = [];
    let pos = 0;
    while (lines.length <= 20) {
      const idx = scanText.indexOf(needle, pos);
      if (idx === -1) break;
      // Report line numbers relative to the full buffer so they're meaningful to the LLM.
      const absIdx = scanOffset >= 0 ? scanOffset + idx : idx;
      lines.push(fullText.substring(0, absIdx).split("\n").length);
      pos = idx + 1;
    }
    return lines;
  })();
  if (matchLines.length <= 1) return null; // unique — safe to proceed
  const lineList = matchLines.slice(0, 20).join(", ") + (matchLines.length > 20 ? "…" : "");
  const hints = [
    `⚠️  AMBIGUOUS — "${needle.substring(0, 60).replace(/\n/g, "↵")}" found ${matchLines.length}+ times in file (lines: ${lineList}).`,
    `   Proceeding without scoping would target occurrence 1 blindly. Be explicit:`,
    `   • functionHint:"name"      → scope to a named function body`,
    `   • afterHint:"string"       → start search after a unique anchor`,
    `   • betweenHint:{start,end}  → restrict to a region`,
    `   • occurrence:N             → explicitly target the Nth match (1=${matchLines[0]}, 2=${matchLines[1] || "?"}, ...)`,
    isCodeFile && toolName === "replace-block"
      ? `   • Or use replace-function-body if this block is a named function` : "",
    isCodeFile && (toolName === "delete-block" || toolName === "insert")
      ? `   • Or use delete-block/insert with sectionHint if this is a named section` : "",
  ].filter(Boolean).join("\n");
  return {
    content: [{ type: "text", text: hints }],
    matched: false, ambiguous: true,
    totalMatches: matchLines.length, matchAtLines: matchLines,
  };
}

module.exports = {
  anchorError,
  smartSuggestion,
  successNudge,
  ambiguityCheck,
};
