'use strict';
// ---------------------------------------------------------------------------
// style-checker.js — Linux kernel coding style checks in pure JS.
//
// API:
//   checkLines(newStr, filePath, isWholeFile?) → { violations: [{line, col, type, message}], totalViolations }
//   isKernelFile(filePath)       → true for .c / .h files
//
// DESIGN:
//   - Operates on the new_str (added lines) only — diff-only operation.
//   - Each violation has a 1-based line number relative to the start of newStr.
//   - Silent when clean (violations array is empty).
//   - No external dependencies — pure JS string operations.
//
// VIOLATION TYPES (keys match styleStats shape):
//   High confidence (deterministic):
//     trailing_whitespace, wrong_indentation, line_too_long, missing_newline_eof,
//     keyword_spacing, space_before_semicolon, paren_spacing, comma_spacing,
//     operator_spacing, consecutive_blanks
//   Medium confidence (higher false positive risk):
//     pointer_spacing, brace_placement, single_line_comment
//
// FALSE POSITIVE MITIGATIONS:
//   - operator_spacing skips: ->, ::, *, /, % in #include paths, unary contexts
//   - pointer_spacing checks only in declarations (avoids dereference *)
//   - brace_placement checks only control flow keywords (not struct/function defs)
// ---------------------------------------------------------------------------

const KERNEL_EXTENSIONS = /\.(c|h)$/i;

/**
 * Returns true if the file path is a C source or header file.
 */
function isKernelFile(filePath) {
  if (!filePath) return false;
  return KERNEL_EXTENSIONS.test(filePath);
}

/**
 * Check the added lines (new_str) for Linux kernel style violations.
 * @param {string} newStr  — the replacement/inserted text
 * @param {string} filePath — used to determine if checks apply (.c/.h only)
 * @returns {{ violations: Array, totalViolations: number }}
 */
function checkLines(newStr, filePath, isWholeFile) {
  if (!isKernelFile(filePath) || !newStr) {
    return { violations: [], totalViolations: 0 };
  }

  const violations = [];
  const lines = newStr.split('\n');

  // Track consecutive blank lines (needs across-line state)
  let consecutiveBlanks = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;  // 1-based
    const raw = lines[i];

    // -----------------------------------------------------------------------
    // Missing newline at EOF — only check last line if it's non-empty
    // -----------------------------------------------------------------------
    if (i === lines.length - 1 && raw.length > 0) {
      // newStr ending without \n means no newline at EOF
      // Only report for whole-file writes — snippet replacements never end with \n
      if (isWholeFile && !newStr.endsWith('\n')) {
        violations.push({ line: lineNum, col: raw.length + 1, type: 'missing_newline_eof', message: 'No newline at end of file' });
      }
    }

    // Skip further checks on empty lines except consecutive blank tracking
    if (raw.trim() === '') {
      consecutiveBlanks++;
      if (consecutiveBlanks > 1) {
        violations.push({ line: lineNum, col: 1, type: 'consecutive_blanks', message: `Consecutive blank lines (${consecutiveBlanks} in a row)` });
      }
      continue;
    }
    consecutiveBlanks = 0;

    // -----------------------------------------------------------------------
    // Trailing whitespace
    // -----------------------------------------------------------------------
    if (/[ \t]+$/.test(raw)) {
      violations.push({ line: lineNum, col: raw.trimEnd().length + 1, type: 'trailing_whitespace', message: 'Trailing whitespace' });
    }

    // -----------------------------------------------------------------------
    // Line length > 100 characters (kernel allows 100, strict limit is 80 but
    // 100 is the common modern tolerance)
    // -----------------------------------------------------------------------
    if (raw.length > 100) {
      violations.push({ line: lineNum, col: 101, type: 'line_too_long', message: `Line ${raw.length} chars (limit 100)` });
    }

    // -----------------------------------------------------------------------
    // Wrong indentation — spaces used instead of tabs for leading indent.
    // Kernel uses tabs. A line starting with spaces (not inside a string,
    // not a #define continuation) is wrong.
    // Heuristic: starts with 2+ spaces (single space could be alignment).
    // -----------------------------------------------------------------------
    if (/^  /.test(raw) && !/^\s*\*/.test(raw)) {
      // Skip: comment continuation lines (spaces before *), preprocessor alignment
      const stripped = raw.trimStart();
      if (!stripped.startsWith('*') && !stripped.startsWith('#')) {
        violations.push({ line: lineNum, col: 1, type: 'wrong_indentation', message: 'Spaces used for indentation (use tabs)' });
      }
    }

    // Skip further checks on preprocessor lines to reduce false positives
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('#')) continue;

    // -----------------------------------------------------------------------
    // Keyword spacing: if(  for(  while(  switch(  → should be if (  etc.
    // -----------------------------------------------------------------------
    const kwMatch = raw.match(/\b(if|for|while|switch|return|sizeof)\(/);
    if (kwMatch) {
      // 'return(' is also wrong but rarer; sizeof( is kernel style violation
      const kw = kwMatch[1];
      violations.push({ line: lineNum, col: raw.indexOf(kwMatch[0]) + 1, type: 'keyword_spacing', message: `Missing space after '${kw}' keyword: use '${kw} ('` });
    }

    // -----------------------------------------------------------------------
    // Space before semicolon: x ; → x;
    // -----------------------------------------------------------------------
    if (/ ;/.test(raw)) {
      const col = raw.indexOf(' ;') + 1;
      violations.push({ line: lineNum, col, type: 'space_before_semicolon', message: "Space before semicolon" });
    }

    // -----------------------------------------------------------------------
    // Spaces inside parentheses: ( x ) → (x)
    // Detect '( ' or ' )' that aren't part of a cast or function-like macro
    // -----------------------------------------------------------------------
    const parenOpen  = raw.match(/\(\s+\S/);
    const parenClose = raw.match(/\S\s+\)/);
    if (parenOpen) {
      violations.push({ line: lineNum, col: raw.indexOf(parenOpen[0]) + 1, type: 'paren_spacing', message: "Space after '('" });
    } else if (parenClose) {
      violations.push({ line: lineNum, col: raw.indexOf(parenClose[0]) + 1, type: 'paren_spacing', message: "Space before ')'" });
    }

    // -----------------------------------------------------------------------
    // Comma spacing: f(a,b) → f(a, b)
    // Match comma not followed by space, newline, or end — but not in strings
    // -----------------------------------------------------------------------
    const commaMatch = raw.match(/,[^\s\n]/);
    if (commaMatch) {
      violations.push({ line: lineNum, col: raw.indexOf(commaMatch[0]) + 1, type: 'comma_spacing', message: "Missing space after comma" });
    }

    // -----------------------------------------------------------------------
    // Operator spacing: x=1 → x = 1
    // Careful to exclude: ==, !=, <=, >=, ->, ++, --, +=, -=, *=, /=, %=, &=, |=, ^=
    // and not flag: string literals, char literals, angle brackets in #include
    // -----------------------------------------------------------------------
    {
      // Remove string literals to avoid false matches inside them
      const noStrings = raw.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
      // Plain = not preceded or followed by another = or ! or < or > or + - * / % & | ^ ~
      const opRx = /(?<![=!<>+\-*/%&|^~])=(?![=])/g;
      let m;
      while ((m = opRx.exec(noStrings)) !== null) {
        const pos = m.index;
        const before = noStrings[pos - 1];
        const after  = noStrings[pos + 1];
        if (before && before !== ' ' && after && after !== ' ') {
          violations.push({ line: lineNum, col: pos + 1, type: 'operator_spacing', message: "Missing spaces around '='" });
          break; // one report per line is enough
        }
      }
    }

    // -----------------------------------------------------------------------
    // Pointer spacing: char* x → char *x  (pointer binds to variable, not type)
    // Medium confidence — only flag clear declaration patterns
    // -----------------------------------------------------------------------
    {
      // Match: word* word (type*name pattern, no space before *)
      const ptrMatch = raw.match(/\b\w+\*\s+\w/);
      if (ptrMatch) {
        violations.push({ line: lineNum, col: raw.indexOf(ptrMatch[0]) + 1, type: 'pointer_spacing', message: "Pointer '*' should bind to variable name, not type: use 'type *name'" });
      }
    }

    // -----------------------------------------------------------------------
    // Brace placement: control flow opening brace on its own line
    // e.g.:  if (x)\n{\n  instead of if (x) {\n
    // Detect a line that is ONLY { (with optional whitespace) that follows a
    // control-flow statement line
    // -----------------------------------------------------------------------
    if (/^\s*\{\s*$/.test(raw) && i > 0) {
      const prevTrimmed = lines[i - 1].trimStart();
      if (/^(if|else|for|while|do|switch)\b/.test(prevTrimmed)) {
        violations.push({ line: lineNum, col: 1, type: 'brace_placement', message: "Opening '{' should be on the same line as the control statement (K&R style)" });
      }
    }

    // -----------------------------------------------------------------------
    // Single-line comments: // comment → /* comment */
    // The kernel prefers C89-style block comments
    // -----------------------------------------------------------------------
    {
      // Detect // not inside a string
      const noStr = raw.replace(/"(?:[^"\\]|\\.)*"/g, '""');
      const slashIdx = noStr.indexOf('//');
      if (slashIdx >= 0) {
        violations.push({ line: lineNum, col: slashIdx + 1, type: 'single_line_comment', message: "Use /* */ style comments instead of //" });
      }
    }
  }

  return { violations, totalViolations: violations.length };
}

/**
 * Format violations into a compact inline string for tool responses.
 * Returns null if no violations.
 */
function formatViolations(violations) {
  if (!violations || violations.length === 0) return null;
  const parts = violations.map(v => `[L${v.line}] ${v.type.replace(/_/g, ' ')}`);
  return `🎨 style (${violations.length}): ${parts.join(' | ')}`;
}

module.exports = { isKernelFile, checkLines, formatViolations };
