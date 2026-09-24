'use strict';
// S3 (2026-09-20) -- identifier-boundary safety check for sub-line (fragment) matches.
//
// PROBLEM: str_replace's plain single-line branch matches with String#includes, so
// old_str 'count' matches inside 'discount'. The B38 guard only refuses when there is
// MORE THAN ONE hit; a single hit inside the wrong token commits silently.
//
// SCOPE (PJ decision 2026-09-20): SAFETY GUARD ONLY. This module decides whether a hit
// sits INSIDE a longer identifier. It does not implement part-line search/replace, and it
// does not decide whether to refuse or warn -- that belongs to the caller (S4).
//
// PURE: no Pulsar, no buffer, no I/O. Not wired into any tool yet; S4 imports it into the
// engine's substring matcher. Unit tests: test/s3_identifier_boundary_test.js.

// An identifier character: ASCII letters, digits, underscore, dollar. Deliberately NOT wider:
// '-' would treat 'a-b' as one token in CSS/Lisp and misfire on subtraction in C-like code;
// non-ASCII letters are rare in the source files this tool edits. Revisit if a real case appears.
const IDENT_CHAR = /[A-Za-z0-9_$]/;

function isIdentChar(ch) {
  return typeof ch === 'string' && ch.length === 1 && IDENT_CHAR.test(ch);
}

/**
 * Does the fragment at line[index .. index+len) sit inside a longer identifier?
 *
 * A boundary only matters on an edge where the fragment ITSELF ends in an identifier
 * character. A needle like '(count' or 'count;' already carries its own non-identifier
 * edge, so the neighbouring character is irrelevant on that side.
 *
 * @param {string} line   the line containing the hit
 * @param {number} index  0-based column where the fragment starts
 * @param {number} len    fragment length
 * @returns {{inside:boolean, left:boolean, right:boolean, leftChar:string, rightChar:string}}
 *   left/right = the fragment is glued to an identifier character on that side.
 *   Never throws: bad input is reported as {inside:false}.
 */
function checkIdentifierBoundary(line, index, len) {
  const none = { inside: false, left: false, right: false, leftChar: '', rightChar: '' };
  if (typeof line !== 'string' || !Number.isInteger(index) || !Number.isInteger(len)) return none;
  if (len < 1 || index < 0 || index + len > line.length) return none;

  const first = line[index];
  const last  = line[index + len - 1];
  const leftChar  = index > 0 ? line[index - 1] : '';
  const rightChar = index + len < line.length ? line[index + len] : '';

  const left  = isIdentChar(first) && isIdentChar(leftChar);
  const right = isIdentChar(last)  && isIdentChar(rightChar);
  return { inside: left || right, left, right, leftChar, rightChar };
}

/**
 * Convenience: scan one line for every occurrence of `needle` and report which are glued to
 * an identifier. Overlapping hits are all reported (advance by 1), matching how str_replace
 * counts occurrences.
 * @returns {Array<{index:number, inside:boolean, left:boolean, right:boolean}>}
 */
function scanLineForFragments(line, needle) {
  const out = [];
  if (typeof line !== 'string' || typeof needle !== 'string' || needle.length === 0) return out;
  let from = 0;
  for (;;) {
    const idx = line.indexOf(needle, from);
    if (idx === -1) break;
    const { inside, left, right } = checkIdentifierBoundary(line, idx, needle.length);
    out.push({ index: idx, inside, left, right });
    from = idx + 1;
  }
  return out;
}

module.exports = { isIdentChar, checkIdentifierBoundary, scanLineForFragments };
