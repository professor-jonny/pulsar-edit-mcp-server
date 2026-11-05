// S4e Section 2 (v3, wiring this session) — scope resolution via resolveScope().
//
// v3 fixes ONE additional bug found by comparing v2 directly against
// resolveScope's SUCCESS-path scopeLabel text (lib/match-engine.js lines
// 130-259), which v2 never checked (v2 only verified the FAILURE-path
// wording against str_replace's live source):
//
// BUG 3 (success-label wording mismatch): resolveScope's own scopeLabel on
// success is NOT the same text str_replace currently produces. Examples,
// read directly from match-engine.js:
//   inFunction:            engine returns ' within function "X"'
//                          str_replace (live line 347) returns
//                          ' within inFunction "X" (lines A—B)'
//   afterFunction/before-  engine returns ' after function "X"' (no line
//   Function:              range, no anchor line); str_replace (live line
//                          371) returns ' afterFunction "X" (lines A—B,
//                          anchor line N)'
//   afterSymbol/before-    engine returns ' after symbol "X"'; str_replace
//   Symbol:                (live line 401) returns ' afterSymbol "X" (lines
//                          A—B, anchor line N)'
//   afterString/before-    engine returns '' or ' [fuzzyWhitespace]' only;
//   String:                str_replace (live line 425) returns
//                          ' afterString "X" (anchor line N, —RADIUS)'
//   betweenHint:           engine returns ' within betweenHint region' (no
//                          text/via preview); str_replace (live line 320)
//                          returns the start/end text previews + via + rows.
// Using scope.scopeLabel verbatim would have silently changed every
// success-path message's wording (not just failures) the moment this
// module was wired in — a regression v1/v2 never flagged because both only
// checked the failure branches. Fixed by building the label HERE from
// scope's row/anchor/via fields, reproducing str_replace's current exact
// text, same "data-in wording-out" split already used for the failure
// branches and for S4a's recover.js delegation.
//
// Carried forward unchanged from v2 (still verified accurate):
// - BUG 1 (wording parity) and BUG 2 (wrong field name / `raw` not
//   `candidates`) fixes on the FAILURE path, transcribed from live lines
//   331-342 (inFunction notFound/ambiguous), 355-366 (afterFunction/
//   beforeFunction), 385-396 (afterSymbol/beforeSymbol), 408-425
//   (afterString/beforeString).
// - resolveScope returns the FULL unfiltered symbol list on notFound; the
//   [function,registerTool] filter for the function-hint group stays
//   caller-side.
// - Every bump()/logHintFailure() call and every failure message string
//   preserved verbatim.
//
// NOT delegated (deliberately, unchanged from v1/v2): betweenHint's success
// label needs the original hint TEXT previews (start.substring(0,30) etc.)
// which resolveScope's return value does not carry back out — only rs.via/
// re.via and the resolved rows. Since betweenHint's anchor-resolution detail
// (rStart.via/rEnd.via) is not exposed on the scope object either, this
// branch reproduces the row numbers only and drops the [via] annotations
// str_replace's hand-rolled branch had — flagged explicitly below, not
// silently dropped.

const { resolveScope } = require('./match-engine');

const FUNCTION_KINDS = ['function', 'registerTool'];
const isFunctionGroup = (h) => h === 'inFunction' || h === 'afterFunction' || h === 'beforeFunction';
const isSymbolGroup = (h) => h === 'afterSymbol' || h === 'beforeSymbol';
const isStringGroup = (h) => h === 'afterString' || h === 'beforeString';

/**
 * resolveStrReplaceScope(params)
 *
 * params: everything str_replace's handler already has in scope:
 *   { editor, buffer, allLines, text, filePath,
 *     old_str, curTool, isCodeFile,
 *     betweenHint, inFunction, afterFunction, beforeFunction,
 *     afterSymbol, beforeSymbol, afterString, beforeString,
 *     afterLine, beforeLine, hintRadius, occurrence, fuzzyWhitespace,
 *     logHintFailure, bump, smartSuggestion, consec }
 *
 * Returns on success:
 *   { ok: true, searchStart, searchEnd, scopeLabel }
 *   searchStart/searchEnd are CHARACTER INDICES (converted from resolveScope's
 *   row bounds), matching what str_replace's downstream matching code expects
 *   today -- no changes needed below this function's call site.
 *   scopeLabel is REBUILT here (not resolveScope's own scopeLabel) to match
 *   str_replace's existing exact wording -- see BUG 3 above.
 *
 * Returns on failure:
 *   { ok: false, result }
 *   result is the COMPLETE { content, matched: false } object str_replace's
 *   handler should return directly.
 */
function resolveStrReplaceScope(params) {
  const {
    editor, buffer, allLines, text, filePath,
    old_str, curTool, isCodeFile,
    betweenHint, inFunction, afterFunction, beforeFunction,
    afterSymbol, beforeSymbol, afterString, beforeString,
    afterLine, beforeLine, hintRadius, occurrence, fuzzyWhitespace,
    logHintFailure, bump, smartSuggestion, consec,
    resolvedRadius, // caller's already-computed `_radius` (hintRadius ?? HINT_RADIUS),
                    // needed verbatim for the afterString/beforeString label below --
                    // resolveScope does not echo the radius it used back out.
  } = params;

  // BUG FIX (live-testing this session): str_replace's handler defaults
  // occurrence to 1 when the caller passes none (mcp-registration.js
  // handler destructure, `occurrence = 1`) -- that default exists for
  // picking the Nth occurrence of old_str CONTENT within the resolved
  // scope, a separate later stage. resolveScope's ambiguous-hint branches
  // treat ANY non-null occurrence (including 1) as an explicit pick, so
  // forwarding the raw value here silently resolved a genuinely ambiguous
  // scope hint (e.g. inFunction:"beta" with two functions named beta) to
  // the FIRST match instead of refusing -- confirmed live: a duplicate
  // function name no longer triggered the ambiguous branch at all.
  // Fixed by only forwarding occurrence for SCOPE disambiguation when it is
  // explicitly > 1, matching this project's existing convention already
  // used for _hasScope a few lines up in the caller (`occurrence > 1`).
  const scopeOccurrence = (occurrence != null && occurrence > 1) ? occurrence : undefined;
  const scope = resolveScope({
    editor, buffer, allLines, text, filePath,
    params: {
      betweenHint, inFunction, afterFunction, beforeFunction,
      afterSymbol, beforeSymbol, afterString, beforeString,
      afterLine, beforeLine, hintRadius, occurrence: scopeOccurrence, fuzzyWhitespace,
    },
  });

  if (scope.error) {
    const { kind, hintName, hintValue, symbols, message, multiLine, raw } = scope.error;
    consec.count++;

    // -- anchorError (structural anchors, betweenHint): message is
    //    pre-formatted by resolveScope itself; surface verbatim per the
    //    function's own doc comment (match-engine.js lines 101-104).
    if (kind === 'anchorError') {
      logHintFailure({ tool: curTool, hintName, hintValue, reason: 'notFound', filePath, oldStr: old_str });
      bump('str_replace', 'fails.outOfScope');
      bump('str_replace', 'faultBuckets.hintFaults');
      return {
        ok: false,
        result: {
          content: [{ type: 'text', text: [message, smartSuggestion({
            toolName: curTool, counter: consec, noHintsUsed: false,
            fileLines: allLines.length, oldStr: old_str, isCodeFile,
          })].filter(Boolean).join('\n') }],
          matched: false,
        },
      };
    }

    // -- needsTreeSitter (afterSymbol/beforeSymbol only) -- live lines ~378-383.
    if (kind === 'needsTreeSitter') {
      logHintFailure({ tool: curTool, hintName, hintValue, reason: 'needsTreeSitter', filePath, oldStr: old_str });
      bump('str_replace', 'fails.outOfScope');
      bump('str_replace', 'faultBuckets.hintFaults');
      return {
        ok: false,
        result: {
          content: [{ type: 'text', text: `? ${hintName}: requires the file to be open in the editor with a grammar assigned (no tree-sitter parse tree found).` }],
          matched: false,
        },
      };
    }

    // -- notFound --
    if (kind === 'notFound') {
      logHintFailure({ tool: curTool, hintName, hintValue, reason: 'notFound', filePath, oldStr: old_str });
      bump('str_replace', isStringGroup(hintName) ? 'fails.afterNotFound' : 'fails.outOfScope');
      bump('str_replace', 'faultBuckets.hintFaults');

      if (isStringGroup(hintName)) {
        // Live lines 408-413: no listing, just a multi-line tip when the
        // resolver flagged a multi-line hint value.
        const multiLineTip = multiLine
          ? `  Tip: ${hintName} matched as a multi-line block (${String(hintValue).split('\n').length} lines) — prefer a SINGLE unique line for reliability.`
          : '';
        return {
          ok: false,
          result: {
            content: [{ type: 'text', text: [`? ${hintName}: "${String(hintValue).substring(0, 60)}" not found in file.${multiLineTip}`,
              smartSuggestion({ toolName: curTool, counter: consec, noHintsUsed: false, fileLines: allLines.length, oldStr: old_str, isCodeFile })]
              .filter(Boolean).join('\n') }],
            matched: false,
          },
        };
      }

      let header, label, known;
      if (hintName === 'inFunction') {
        // Live line 335 (header, no "function" word) + line 331 (listing HAS [kind]).
        header = `? inFunction: "${hintValue}" not found.`;
        label = 'Known functions:';
        known = (symbols || []).filter(s => FUNCTION_KINDS.includes(s.kind))
          .slice(0, 20).map(s => `  ${s.startRow + 1}: ${s.name} [${s.kind}]`);
      } else if (isFunctionGroup(hintName)) {
        // afterFunction/beforeFunction. Live line 359 (header HAS "function"
        // word) + line 355 (listing has NO [kind]).
        header = `? ${hintName}: function "${hintValue}" not found.`;
        label = 'Known functions:';
        known = (symbols || []).filter(s => FUNCTION_KINDS.includes(s.kind))
          .slice(0, 20).map(s => `  ${s.startRow + 1}: ${s.name}`);
      } else {
        // afterSymbol/beforeSymbol. Live line 389 (header, no "function"
        // word) + line 385 (listing HAS [kind], unfiltered symbol set).
        header = `? ${hintName}: "${hintValue}" not found.`;
        label = 'Known symbols:';
        known = (symbols || []).slice(0, 20).map(s => `  ${s.startRow + 1}: ${s.name} [${s.kind}]`);
      }
      return {
        ok: false,
        result: {
          content: [{ type: 'text', text: [header,
            `${label}\n${known.join('\n') || '  (none)'}`,
            smartSuggestion({ toolName: curTool, counter: consec, noHintsUsed: false, fileLines: allLines.length, oldStr: old_str, isCodeFile })]
            .filter(Boolean).join('\n') }],
          matched: false,
        },
      };
    }

    // -- ambiguous --
    if (kind === 'ambiguous') {
      logHintFailure({ tool: curTool, hintName, hintValue, reason: 'ambiguous', filePath, oldStr: old_str });
      bump('str_replace', isStringGroup(hintName) ? 'fails.afterNotFound' : 'fails.outOfScope');
      bump('str_replace', 'faultBuckets.hintFaults');

      if (isStringGroup(hintName)) {
        // Live line 420: totally different shape from the symbol-based
        // groups — r.rows (bare row numbers), no name/kind, NO "Use
        // occurrence:N" tip, NO smartSuggestion appended.
        const rows = (raw && raw.rows) || [];
        const lines = rows.map(row => `  line ${row + 1}`).join('\n');
        return {
          ok: false,
          result: {
            content: [{ type: 'text', text: `? ${hintName}: "${String(hintValue).substring(0, 60)}" found on ${rows.length} lines — use a more unique string:\n${lines}` }],
            matched: false,
          },
        };
      }

      const matches = (raw && raw.matches) || [];
      if (hintName === 'inFunction') {
        // Live line 342: header INCLUDES the match count; list HAS [kind].
        const list = matches.map(m => `  line ${m.startRow + 1}: ${m.name} [${m.kind}]`).join('\n');
        return {
          ok: false,
          result: {
            content: [{ type: 'text', text: `? inFunction: "${hintValue}" is ambiguous — ${matches.length} matches:\n${list}\nUse occurrence:N to disambiguate.` }],
            matched: false,
          },
        };
      }
      if (isFunctionGroup(hintName)) {
        // afterFunction/beforeFunction. Live line 366: header has NO count;
        // list (line 362) has NO [kind].
        const list = matches.map(m => `  line ${m.startRow + 1}: ${m.name}`).join('\n');
        return {
          ok: false,
          result: {
            content: [{ type: 'text', text: `? ${hintName}: "${hintValue}" is ambiguous:\n${list}\nUse occurrence:N to disambiguate.` }],
            matched: false,
          },
        };
      }
      // afterSymbol/beforeSymbol. Live line 396: header has NO count; list
      // (line 392) HAS [kind].
      const list = matches.map(m => `  line ${m.startRow + 1}: ${m.name} [${m.kind}]`).join('\n');
      return {
        ok: false,
        result: {
          content: [{ type: 'text', text: `? ${hintName}: "${hintValue}" is ambiguous:\n${list}\nUse occurrence:N to disambiguate.` }],
          matched: false,
        },
      };
    }

    // Fallback -- should not be reached if the kinds above are exhaustive;
    // return raw message if resolveScope ever adds a new kind this draft
    // doesn't know about, rather than throwing.
    return {
      ok: false,
      result: {
        content: [{ type: 'text', text: message || `? ${hintName}: scope resolution failed (${kind}).` }],
        matched: false,
      },
    };
  }

  // -- Success: convert resolveScope's row bounds to the character-index
  //    bounds str_replace's downstream matching code expects. This is the
  //    SAME conversion str_replace's own current hand-rolled branches already
  //    perform (e.g. live lines 344-345 for inFunction) -- not a new pattern.
  const searchStart = buffer.characterIndexForPosition([scope.searchStart, 0]);
  const searchEnd = buffer.characterIndexForPosition([scope.searchEnd + 1, 0]);

  // -- Rebuild scopeLabel to match str_replace's EXISTING exact wording (BUG 3
  //    fix -- see header). resolveScope's own scope.scopeLabel is NOT used
  //    here on purpose; it is worded differently (see header comment table).
  let scopeLabel = '';
  const via = scope.via;
  if (via === 'inFunction') {
    // Live line 347: ` within inFunction "X" (lines A—B)`.
    scopeLabel = ` within inFunction "${inFunction}" (lines ${scope.searchStart + 1}—${scope.searchEnd + 1})`;
  } else if (via === 'afterFunction' || via === 'beforeFunction' || via === 'afterSymbol' || via === 'beforeSymbol') {
    // Live lines 371 / 401: ` ${hintName} "X" (lines A—B, anchor line N)`.
    const hintVal = afterFunction || beforeFunction || afterSymbol || beforeSymbol;
    scopeLabel = ` ${via} "${hintVal}" (lines ${scope.searchStart + 1}—${scope.searchEnd + 1}, anchor line ${(scope.anchorRow ?? scope.searchStart) + 1})`;
  } else if (via === 'afterString' || via === 'beforeString') {
    // Live line 426 -- IMPORTANT QUIRK, reproduced deliberately, not fixed:
    // str_replace's label prints the bare HINT_RADIUS CONSTANT here, NOT
    // the hint's own resolved `_radius` (hintRadius ?? HINT_RADIUS) used for
    // the actual search a few lines earlier. This looks like a pre-existing
    // bug (a caller passing hintRadius:10 gets a label still showing the
    // constant's default), but per this project's standing rule ("reproduce
    // quirks first, fix later" -- session note [0] LESSON f) this module
    // preserves it byte-for-byte rather than silently correcting it. The
    // caller passes the raw HINT_RADIUS constant as `resolvedRadius` (NOT
    // its own `_radius`) specifically to match this.
    const hintVal = afterString || beforeString;
    scopeLabel = ` ${via} "${String(hintVal).substring(0, 40)}" (anchor line ${(scope.anchorRow ?? scope.searchStart) + 1}, —${resolvedRadius})`;
  } else if (via === 'betweenHint') {
    // NOT fully reproduced -- see header "NOT delegated" note. resolveScope
    // does not expose the start/end hint-text previews or their [via]
    // annotations, only the resolved rows. Falls back to a row-only label
    // rather than silently guessing the missing text/via detail.
    scopeLabel = ` within betweenHint region (lines ${scope.searchStart + 1}—${scope.searchEnd + 1})`;
  } else if (via === 'afterLine' || via === 'beforeLine') {
    // Live line 435: ` ${hintName}:${hintVal} (lines A—B)` -- CORRECTED here;
    // an earlier draft of this comment wrongly assumed this stayed empty.
    const hintVal = afterLine != null ? afterLine : beforeLine;
    scopeLabel = ` ${via}:${hintVal} (lines ${scope.searchStart + 1}—${scope.searchEnd + 1})`;
  }
  // 'none' (no hint at all) keeps scopeLabel === '' to match str_replace's
  // current whole-file behavior.

  return { ok: true, searchStart, searchEnd, scopeLabel };
}

module.exports = { resolveStrReplaceScope };
