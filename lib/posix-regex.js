'use strict';
// lib/posix-regex.js - POSIX BRE / ERE regular expressions with the GNU extensions (TODO R4a).
//
// Goal: behave like the regex engine inside GNU sed 4.9 (glibc regcomp / re_search with the syntax
// bits sed uses). Pure module: no Pulsar, no I/O, no dependencies. Plain Node 20 compatible.
//
//   const re = compile(pattern, { extended: false, icase: false, multiline: false, grep: false });
//   re.nsub                          number of capture groups
//   re.exec(str, from)               null, or { start: Int32Array, end: Int32Array } (index 0 = whole match,
//                                    -1 = group did not participate); search begins at `from`, but ^ and
//                                    the word-boundary tests always look at the whole string (like sed).
//   grep: true  (R4j, 2026-10-31) is GNU grep's lenient syntax instead of sed's strict one; the search tools use it.
//   It changes only what the strict mode rejects: an ERE repetition operator with nothing before it (and every
//   operator right after it) is ignored, a { that does not start a valid interval is literal text, an unmatched )
//   is literal text, stacked repetition (a**) is allowed in both syntaxes, a BRE leading \{ is a literal brace, and
//   an ERE operator right after an anchor repeats the anchor (^*a, a$*). Checked against GNU grep 3.11 with
//   test/grep-oracle/grep-diff.js; where grep's own engines disagree (-o versus line selection) line selection wins.
//   Without grep the engine stays strict, like sed. Both modes report a brace followed by junk and the end of the
//   pattern as Unmatched \{, as glibc and GNU sed do.
//
// Matching rule: leftmost match, then the longest overall match; among paths that reach that longest end
// the first one in priority order wins (alternatives left to right, repetition greedy). That is also what
// glibc does when it fills in the sub-matches.

class RegexError extends Error {
  constructor(message) { super(message); this.name = 'RegexError'; }
}

const MSG = {
  ECOLLATE: 'Invalid collation character',
  ECTYPE: 'Invalid character class name',
  EESCAPE: 'Trailing backslash',
  ESUBREG: 'Invalid back reference',
  EBRACK: 'Unmatched [, [^, [:, [., or [=',
  EPAREN: 'Unmatched ( or \\(',
  EBRACE: 'Unmatched \\{',
  BADBR: 'Invalid content of \\{\\}',
  ERANGE: 'Invalid range end',
  BADRPT: 'Invalid preceding regular expression',
  ESIZE: 'Regular expression too big',
  ERPAREN: 'Unmatched ) or \\)',
};

const RE_DUP_MAX = 0x7fff;
const MAX_NODES = 250000;
const MAX_STEPS = 60000000;

// ---------------------------------------------------------------- character helpers

const reL = /^\p{L}$/u, reLu = /^\p{Lu}$/u, reLl = /^\p{Ll}$/u, reN = /^[\p{L}\p{Nd}]$/u;
const reP = /^[\p{P}\p{S}]$/u, reZ = /^[\p{Z}\u0085]$/u, reCc = /^\p{Cc}$/u, reWordNon = /^[\p{L}\p{N}]$/u;

function isWordCp(cp) {
  if (cp < 128) return (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || cp === 95;
  return reWordNon.test(String.fromCodePoint(cp));
}

const CLASS_FNS = {
  alpha: (c) => (c < 128 ? (c >= 65 && c <= 90) || (c >= 97 && c <= 122) : reL.test(String.fromCodePoint(c))),
  digit: (c) => c >= 48 && c <= 57,
  alnum: (c) => (c < 128 ? (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) : reN.test(String.fromCodePoint(c))),
  upper: (c) => (c < 128 ? c >= 65 && c <= 90 : reLu.test(String.fromCodePoint(c))),
  lower: (c) => (c < 128 ? c >= 97 && c <= 122 : reLl.test(String.fromCodePoint(c))),
  space: (c) => (c < 128 ? c === 32 || (c >= 9 && c <= 13) : reZ.test(String.fromCodePoint(c))),
  blank: (c) => c === 32 || c === 9 || (c > 127 && /^\p{Zs}$/u.test(String.fromCodePoint(c))),
  punct: (c) => (c < 128 ? (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126) : reP.test(String.fromCodePoint(c))),
  print: (c) => (c < 128 ? c >= 32 && c <= 126 : !reCc.test(String.fromCodePoint(c))),
  graph: (c) => (c < 128 ? c >= 33 && c <= 126 : !reCc.test(String.fromCodePoint(c)) && !reZ.test(String.fromCodePoint(c))),
  cntrl: (c) => c < 32 || c === 127 || (c > 127 && reCc.test(String.fromCodePoint(c))),
  xdigit: (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102),
};

function caseVariants(cp) {
  const s = String.fromCodePoint(cp);
  const out = new Set([cp]);
  for (const v of [s.toLowerCase(), s.toUpperCase()]) {
    if ([...v].length === 1) out.add(v.codePointAt(0));
  }
  return [...out];
}

function setHas(set, cp) {
  for (const r of set.ranges) if (cp >= r[0] && cp <= r[1]) return true;
  for (const f of set.classes) if (f(cp)) return true;
  return false;
}

function setTest(set, cp) {
  // a stray byte (lone surrogate U+DC80..U+DCFF, see lib/sed-run.js) is an invalid character: glibc lets no set match it
  if (cp >= 0xdc80 && cp <= 0xdcff) return false;
  let hit = setHas(set, cp);
  if (!hit && set.icase) {
    for (const v of caseVariants(cp)) if (v !== cp && setHas(set, v)) { hit = true; break; }
  }
  if (set.neg) return !hit && !(set.nlExcl && cp === 10);
  return hit;
}

// ---------------------------------------------------------------- parser

function parseRegex(pat, ere, icase, multiline, grep) {
  const n = pat.length;
  let i = 0;
  let nsub = 0;
  let hasBackref = false;
  let closed = new Set();
  const E = (m) => { throw new RegexError(m); };
  const readCp = () => { const cp = pat.codePointAt(i); i += cp > 0xffff ? 2 : 1; return cp; };

  const isAnchor = (nd) => nd.t === 'bol' || nd.t === 'eol' || nd.t === 'bos' || nd.t === 'eos'
    || nd.t === 'wordb' || nd.t === 'nwordb' || nd.t === 'wstart' || nd.t === 'wend';

  function mkSet(neg, ranges, classes) {
    return { t: 'set', neg, ranges, classes, icase, nlExcl: multiline };
  }
  function classSet(names, neg) {
    return { t: 'set', neg, ranges: [], classes: names.map((c) => (typeof c === 'string' ? CLASS_FNS[c] : c)), icase: false, nlExcl: false };
  }
  const wordFn = (c) => isWordCp(c);

  // ---- bracket expression; `i` is just after the opening '['
  function parseBracket() {
    let neg = false;
    if (pat[i] === '^') { neg = true; i++; }
    const ranges = [];
    const classes = [];
    let first = true;
    const readElem = () => {
      // returns { cp } for a single character element, or { cls } for a class element
      if (i >= n) E(MSG.EBRACK);
      const c = pat[i];
      if (c === '[' && i + 1 < n && (pat[i + 1] === ':' || pat[i + 1] === '.' || pat[i + 1] === '=')) {
        const kind = pat[i + 1];
        const close = pat.indexOf(kind + ']', i + 2);
        if (close < 0) E(MSG.EBRACK);
        const name = pat.slice(i + 2, close);
        if (name.length > 31) E(MSG.EBRACK);
        i = close + 2;
        if (kind === ':') {
          if (!Object.prototype.hasOwnProperty.call(CLASS_FNS, name)) E(MSG.ECTYPE);
          return { cls: CLASS_FNS[name] };
        }
        const chars = [...name];
        if (chars.length !== 1) E(MSG.ECOLLATE);
        return { cp: chars[0].codePointAt(0), equiv: kind === '=' };
      }
      return { cp: readCp() };
    };
    for (;;) {
      if (i >= n) E(MSG.EBRACK);
      if (pat[i] === ']' && !first) { i++; break; }
      if (pat[i] === '-' && !first && pat[i + 1] !== ']') E(MSG.ERANGE);
      first = false;
      const a = readElem();
      // range?
      if (a.cp !== undefined && !a.equiv && pat[i] === '-' && i + 1 < n && pat[i + 1] !== ']') {
        i++;
        const b = readElem();
        if (b.cp === undefined || b.equiv) E(MSG.ERANGE);
        if (a.cp > b.cp) E(MSG.ERANGE);
        ranges.push([a.cp, b.cp]);
      } else if (a.cp !== undefined) {
        ranges.push([a.cp, a.cp]);
      } else {
        classes.push(a.cls);
      }
    }
    return mkSet(neg, ranges, classes);
  }

  // ---- interval after the opening brace; `i` is just after '{' (ERE) or '\{' (BRE)
  function parseInterval() {
    const closeTok = ere ? '}' : '\\}';
    const readNum = () => {
      let num = -1;
      for (;;) {
        if (i >= n) return { num: -2, end: true };
        const c = pat[i];
        if (c >= '0' && c <= '9') { num = (num < 0 ? 0 : num) * 10 + (c.charCodeAt(0) - 48); if (num > RE_DUP_MAX + 1) num = RE_DUP_MAX + 1; i++; continue; }
        if (c === ',') return { num, term: ',' };
        if (pat.startsWith(closeTok, i)) return { num, term: 'close' };
        // glibc keeps reading to the next comma or closing brace; running off the end of the pattern is Unmatched \{ (R4j)
        while (i < n && pat[i] !== ',' && !pat.startsWith(closeTok, i)) i++;
        return i >= n ? { num: -2, end: true } : { num: -2, bad: true };
      }
    };
    let r = readNum();
    let start = r.num;
    let term = r.term;
    let end = 0;
    let atEnd = !!r.end;
    if (start === -1) {
      if (term === ',') start = 0;
      else E(MSG.BADBR);
    }
    if (start !== -2) {
      if (term === 'close') end = start;
      else if (term === ',') {
        i++; // skip ','
        r = readNum();
        end = r.num; term = r.term; atEnd = !!r.end;
        if (r.num === -2) end = -2;
      } else end = -2;
    }
    if (start === -2 || end === -2) {
      // GNU grep -E (R4j): a brace that does not start a valid interval is literal text, so rewind and let the caller treat it so
      if (grep && ere) return null;
      E(atEnd ? MSG.EBRACE : MSG.BADBR);
    }
    if ((end !== -1 && start > end) || term !== 'close') E(MSG.BADBR);
    i += closeTok.length;
    if ((end === -1 ? start : end) > RE_DUP_MAX) E(MSG.ESIZE);
    return { min: start, max: end === -1 ? Infinity : end };
  }

  // returns the repetition operator at `i` (consuming it) or null
  function tryRepeatOp() {
    const c = pat[i];
    if (c === '*') { i++; return { min: 0, max: Infinity, star: true }; }
    if (ere) {
      if (c === '+') { i++; return { min: 1, max: Infinity }; }
      if (c === '?') { i++; return { min: 0, max: 1 }; }
      if (c === '{') { const save = i; i++; const r = parseInterval(); if (r === null) { i = save; return null; } r.brace = true; return r; }
    } else if (c === '\\') {
      const d = pat[i + 1];
      if (d === '+') { i += 2; return { min: 1, max: Infinity }; }
      if (d === '?') { i += 2; return { min: 0, max: 1 }; }
      if (d === '{') { i += 2; const r = parseInterval(); r.brace = true; return r; }
    }
    return null;
  }

  function parseAtom(depth) {
    const c = pat[i];
    if (c === '\\') {
      if (i + 1 >= n) E(MSG.EESCAPE);
      const d = pat[i + 1];
      if (!ere && d === '(') { i += 2; return parseGroup(depth); }
      if (!ere && d === '{') { if (!grep) E(MSG.BADRPT); i += 2; return { t: 'char', ch: '{' }; } // grep: a leading \{ is a literal brace
      if (d >= '1' && d <= '9') {
        const k = d.charCodeAt(0) - 48;
        if (!closed.has(k)) E(MSG.ESUBREG);
        i += 2; hasBackref = true;
        return { t: 'backref', k };
      }
      i += 2;
      switch (d) {
        case 'w': return classSet([wordFn], false);
        case 'W': return classSet([wordFn], true);
        case 's': return classSet(['space'], false);
        case 'S': return classSet(['space'], true);
        case 'b': return { t: 'wordb' };
        case 'B': return { t: 'nwordb' };
        case '<': return { t: 'wstart' };
        case '>': return { t: 'wend' };
        case '`': return { t: 'bos' };
        case '\'': return { t: 'eos' };
        case 'n': return { t: 'char', ch: '\n' };
        default: {
          i -= 1; // re-read the escaped character as a code point
          const cp = readCp();
          return { t: 'char', ch: String.fromCodePoint(cp) };
        }
      }
    }
    if (c === '[') { i++; return parseBracket(); }
    if (c === '.') { i++; return { t: 'any' }; }
    if (ere) {
      if (c === '(') { i++; return parseGroup(depth); }
      if (c === '^') { i++; return { t: 'bol' }; }
      if (c === '$') { i++; return { t: 'eol' }; }
      if (c === '*' || c === '+' || c === '?' || c === '{') {
        if (!grep) E(MSG.BADRPT);
        // GNU grep -E (R4j): nothing before the operator, so it repeats nothing and is ignored, and so is every operator
        // right after it (+{2,1} is all ignored); a { that does not start a valid interval is literal text
        if (c !== '{') { i++; return { t: 'empty', lead: true }; }
        const save = i;
        i++;
        let valid = false;
        try { valid = parseInterval() !== null; } catch (e) { valid = false; }
        if (valid) return { t: 'empty', lead: true };
        i = save; // a literal {, read by the code below
      }
    } else {
      if (c === '^' && atBranchStart) { i++; return { t: 'bol' }; }
      if (c === '$') {
        const nx = pat[i + 1];
        const endOk = i + 1 === n || (nx === '\\' && (pat[i + 2] === ')' || pat[i + 2] === '|'));
        if (endOk) { i++; return { t: 'eol' }; }
      }
    }
    const cp = readCp();
    return { t: 'char', ch: String.fromCodePoint(cp) };
  }

  let atBranchStart = true;

  function parseGroup(depth) {
    const idx = ++nsub;
    const savedStart = atBranchStart;
    atBranchStart = true;
    let body;
    const closeTok = ere ? ')' : '\\)';
    if (pat.startsWith(closeTok, i)) body = { t: 'empty' };
    else body = parseAlt(depth + 1);
    if (!pat.startsWith(closeTok, i)) E(MSG.EPAREN);
    i += closeTok.length;
    closed.add(idx);
    atBranchStart = savedStart;
    return { t: 'group', idx, node: body };
  }

  function parseBranch(depth) {
    const items = [];
    atBranchStart = true;
    while (i < n) {
      const c = pat[i];
      if (ere) {
        if (c === '|') break;
        if (c === ')') { if (depth > 0) break; if (!grep) E(MSG.ERPAREN); } // grep -E: an unmatched ) is literal text
      } else if (c === '\\') {
        const d = pat[i + 1];
        if (d === '|') break;
        if (d === ')') { if (depth > 0) break; E(MSG.ERPAREN); }
      }
      let atom = parseAtom(depth);
      if (atom.lead) { atBranchStart = true; continue; } // grep -E: an ignored leading operator
      if (isAnchor(atom)) {
        // an anchor is never followed by a repetition operator; the next token starts a new expression
        // (GNU grep -E is the exception: an operator right after an anchor repeats the anchor, so ^* and a$* may match zero times)
        if (grep && ere) {
          let any = false;
          let zero = false;
          for (;;) { const save = i; let op = null; try { op = tryRepeatOp(); } catch (e) { i = save; } if (!op) break; any = true; if (op.min === 0) zero = true; } // an invalid interval here is not an error in grep (glibc drops the brace)
          if (any && zero) atom = { t: 'empty' };
        }
        items.push(atom);
        atBranchStart = true;
        continue;
      }
      let reps = 0;
      for (;;) {
        const op = tryRepeatOp();
        if (!op) break;
        if (reps > 0 && !ere && !grep && (op.star || op.brace)) E(MSG.BADRPT); // grep allows stacked repetition (a**)
        reps++;
        atom = { t: 'rep', node: atom, min: op.min, max: op.max };
      }
      items.push(atom);
      atBranchStart = false;
    }
    if (items.length === 0) return { t: 'empty' };
    if (items.length === 1) return items[0];
    return { t: 'cat', items };
  }

  function parseAlt(depth) {
    const initial = new Set(closed);
    const alts = [parseBranch(depth)];
    for (;;) {
      if (ere ? pat[i] === '|' : (pat[i] === '\\' && pat[i + 1] === '|')) {
        i += ere ? 1 : 2;
        // glibc: back-references only see groups completed before this alternative started
        const accumulated = closed;
        closed = new Set(initial);
        alts.push(parseBranch(depth));
        for (const k of accumulated) closed.add(k);
      } else break;
    }
    return alts.length === 1 ? alts[0] : { t: 'alt', alts };
  }

  const ast = parseAlt(0);
  if (i < n) E(MSG.ERPAREN);
  return { ast, nsub, hasBackref };
}

// ---------------------------------------------------------------- matcher

function buildMatcher(parsed, opts) {
  const { ast, nsub, hasBackref } = parsed;
  const icase = !!opts.icase;
  const ml = !!opts.multiline;
  const ctx = { S: '', n: 0, caps: new Int32Array(2 * (nsub + 1)), tmp: new Int32Array(nsub + 1), bestEnd: -1, bestCaps: null, visited: [], steps: 0 };
  let memoCount = 0;
  let nodeCount = 0;

  const cpAt = (i) => {
    const c = ctx.S.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < ctx.n) {
      const d = ctx.S.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) return ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000;
    }
    return c;
  };
  const cpBefore = (i) => {
    const c = ctx.S.charCodeAt(i - 1);
    if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
      const h = ctx.S.charCodeAt(i - 2);
      if (h >= 0xd800 && h <= 0xdbff) return ((h - 0xd800) << 10) + (c - 0xdc00) + 0x10000;
    }
    return c;
  };
  // A stray byte (lone surrogate U+DC80..U+DCFF, see lib/sed-run.js) counts as a WORD character for \b \B \< \>
  // (found by probing glibc sed: 'x<ff>y', '<ff>x' and '+<ff>x' have no boundary next to the byte), although \w does not match it.
  const isStray = (c) => c >= 0xdc80 && c <= 0xdcff;
  const wordBefore = (i) => i > 0 && (isStray(cpBefore(i)) || isWordCp(cpBefore(i)));
  const wordAfter = (i) => i < ctx.n && (isStray(cpAt(i)) || isWordCp(cpAt(i)));

  const memoWrap = (f) => {
    if (hasBackref) return f;
    const id = memoCount++;
    return (i) => {
      let set = ctx.visited[id];
      if (!set) set = ctx.visited[id] = new Set();
      if (set.has(i)) return false;
      set.add(i);
      return f(i);
    };
  };

  const step = () => { if (++ctx.steps > MAX_STEPS) throw new RegexError('Regular expression too complex'); };

  function comp(node, next) {
    if (++nodeCount > MAX_NODES) throw new RegexError(MSG.ESIZE);
    switch (node.t) {
      case 'empty': return next;
      case 'char': {
        const ch = node.ch;
        if (!icase) {
          if (ch.length === 1) {
            const code = ch.charCodeAt(0);
            return (i) => i < ctx.n && ctx.S.charCodeAt(i) === code && next(i + 1);
          }
          return (i) => ctx.S.startsWith(ch, i) && next(i + ch.length);
        }
        const variants = caseVariants(ch.codePointAt(0)).map((v) => String.fromCodePoint(v));
        return (i) => {
          for (const v of variants) if (ctx.S.startsWith(v, i)) return next(i + v.length);
          return false;
        };
      }
      case 'any':
        return (i) => {
          if (i >= ctx.n) return false;
          const cp = cpAt(i);
          if (ml && cp === 10) return false;
          if (cp >= 0xdc80 && cp <= 0xdcff) return false; // a stray byte is not a character
          return next(i + (cp > 0xffff ? 2 : 1));
        };
      case 'set':
        return (i) => {
          if (i >= ctx.n) return false;
          const cp = cpAt(i);
          return setTest(node, cp) && next(i + (cp > 0xffff ? 2 : 1));
        };
      case 'cat': {
        let f = next;
        for (let k = node.items.length - 1; k >= 0; k--) f = comp(node.items[k], f);
        return f;
      }
      case 'alt': {
        const joined = memoWrap(next);
        const fs = node.alts.map((a) => comp(a, joined));
        return (i) => {
          for (let k = 0; k < fs.length; k++) if (fs[k](i)) return true;
          return false;
        };
      }
      case 'group': {
        const k = node.idx;
        const opt = !!node.opt; // direct operand of an optional / repeated part (glibc opt_subexp)
        const reg = { snap: null };
        const closeF = (i) => {
          const c = ctx.caps;
          if (opt && reg.snap && ctx.tmp[k] === i && reg.snap[2 * k] !== -1) {
            // empty re-match of an optional group that already matched: glibc puts the old registers
            // back (inner groups included), as if this iteration had not happened
            const cur = c.slice();
            c.set(reg.snap);
            const r0 = next(i);
            c.set(cur);
            return r0;
          }
          const os = c[2 * k], oe = c[2 * k + 1];
          c[2 * k] = ctx.tmp[k]; c[2 * k + 1] = i;
          const r = next(i);
          c[2 * k] = os; c[2 * k + 1] = oe;
          return r;
        };
        const body = comp(node.node, closeF);
        return (i) => {
          const old = ctx.tmp[k];
          const oldSnap = reg.snap;
          ctx.tmp[k] = i;
          if (opt) reg.snap = ctx.caps.slice();
          const r = body(i);
          ctx.tmp[k] = old;
          reg.snap = oldSnap;
          return r;
        };
      }
      case 'backref': {
        const k = node.k;
        return (i) => {
          step();
          const s = ctx.caps[2 * k], e = ctx.caps[2 * k + 1];
          if (s < 0) return false;
          const len = e - s;
          if (i + len > ctx.n) return false;
          const a = ctx.S.substr(s, len), b = ctx.S.substr(i, len);
          if (a !== b && !(icase && a.toLowerCase() === b.toLowerCase())) return false;
          return next(i + len);
        };
      }
      case 'bol': return (i) => (i === 0 || (ml && ctx.S.charCodeAt(i - 1) === 10)) && next(i);
      case 'eol': return (i) => (i === ctx.n || (ml && ctx.S.charCodeAt(i) === 10)) && next(i);
      case 'bos': return (i) => i === 0 && next(i);
      case 'eos': return (i) => i === ctx.n && next(i);
      case 'wordb': return (i) => wordBefore(i) !== wordAfter(i) && next(i);
      case 'nwordb': return (i) => wordBefore(i) === wordAfter(i) && next(i);
      case 'wstart': return (i) => !wordBefore(i) && wordAfter(i) && next(i);
      case 'wend': return (i) => wordBefore(i) && !wordAfter(i) && next(i);
      case 'rep': return compRep(node, next);
      default: throw new Error('posix-regex: unknown node ' + node.t);
    }
  }

  // one-character atoms step iteratively, so `.*` over a long line does not recurse once per character
  function atomStep(X) {
    if (X.t === 'char') {
      const ch = X.ch;
      if (!icase) {
        if (ch.length === 1) {
          const code = ch.charCodeAt(0);
          return (i) => (i < ctx.n && ctx.S.charCodeAt(i) === code ? i + 1 : -1);
        }
        return (i) => (ctx.S.startsWith(ch, i) ? i + ch.length : -1);
      }
      const variants = caseVariants(ch.codePointAt(0)).map((v) => String.fromCodePoint(v));
      return (i) => {
        for (const v of variants) if (ctx.S.startsWith(v, i)) return i + v.length;
        return -1;
      };
    }
    if (X.t === 'any') {
      return (i) => {
        if (i >= ctx.n) return -1;
        const cp = cpAt(i);
        if (ml && cp === 10) return -1;
        if (cp >= 0xdc80 && cp <= 0xdcff) return -1; // a stray byte is not a character
        return i + (cp > 0xffff ? 2 : 1);
      };
    }
    return (i) => {
      if (i >= ctx.n) return -1;
      const cp = cpAt(i);
      return setTest(X, cp) ? i + (cp > 0xffff ? 2 : 1) : -1;
    };
  }

  function compSimpleRep(X, min, max, next) {
    const stepFn = atomStep(X);
    const joined = memoWrap(next);
    return (i) => {
      const pos = [i];
      let p = i;
      while (pos.length - 1 < max) {
        const q = stepFn(p);
        if (q < 0) break;
        pos.push(q);
        p = q;
      }
      for (let k = pos.length - 1; k >= min; k--) {
        step();
        if (joined(pos[k])) return true;
      }
      return false;
    };
  }

  function compRep(node, next) {
    const { min, max } = node;
    const X = node.node;
    if (max === 0) return next;
    if (X.t === 'char' || X.t === 'any' || X.t === 'set') return compSimpleRep(X, min, max, next);
    // the group that is the direct operand of an optional / repeated part is flagged (glibc opt_subexp)
    const XO = X.t === 'group' ? Object.assign({}, X, { opt: true }) : X;
    const joined = memoWrap(next);
    let tail;
    if (max === Infinity) {
      const reg = { cur: -1 };
      let loop;
      const body = comp(XO, (j) => {
        step();
        if (j === reg.cur) return joined(j); // an empty iteration does not loop again
        return loop(j);
      });
      loop = memoWrap((i) => {
        step();
        const old = reg.cur;
        reg.cur = i;
        const r = body(i);
        reg.cur = old;
        if (r) return true;
        return joined(i);
      });
      tail = loop;
    } else {
      // glibc: X{m,n} = X ... X (m copies) then ((( X? ) X)? ... X)?  -- k = n-m optional copies, nested
      // only the first optional copy (k === 1, the innermost) carries glibc's opt_subexp flag
      const optional = (k, nxt) => {
        if (k === 0) return nxt;
        const afterX = comp(k === 1 ? XO : X, nxt);
        const inner = optional(k - 1, afterX);
        return memoWrap((i) => { step(); return inner(i) || nxt(i); });
      };
      tail = optional(max - min, joined);
    }
    for (let k = 0; k < min; k++) tail = comp(X, tail);
    return tail;
  }

  const finish = (i) => {
    if (i > ctx.bestEnd) { ctx.bestEnd = i; ctx.bestCaps = ctx.caps.slice(); }
    return i === ctx.n; // cannot be longer than the whole string: stop at the first such path
  };
  const top = comp(ast, finish);

  function exec(str, from) {
    ctx.S = str; ctx.n = str.length; ctx.visited = []; ctx.steps = 0;
    const n = str.length;
    for (let start = from || 0; start <= n; start++) {
      if (start > 0 && start < n) {
        const c = str.charCodeAt(start), p = str.charCodeAt(start - 1);
        if (c >= 0xdc00 && c <= 0xdfff && p >= 0xd800 && p <= 0xdbff) continue;
      }
      ctx.caps.fill(-1); ctx.tmp.fill(-1); ctx.bestEnd = -1; ctx.bestCaps = null;
      try {
        top(start);
      } catch (e) {
        if (e instanceof RangeError) throw new RegexError('Regular expression too complex');
        throw e;
      }
      if (ctx.bestEnd >= 0) {
        const caps = ctx.bestCaps;
        const sArr = new Int32Array(nsub + 1), eArr = new Int32Array(nsub + 1);
        sArr[0] = start; eArr[0] = ctx.bestEnd;
        for (let k = 1; k <= nsub; k++) { sArr[k] = caps[2 * k]; eArr[k] = caps[2 * k + 1]; }
        return { start: sArr, end: eArr };
      }
    }
    return null;
  }

  return exec;
}

function compile(pattern, opts) {
  const o = opts || {};
  const parsed = parseRegex(String(pattern), !!o.extended, !!o.icase, !!o.multiline, !!o.grep);
  const exec = buildMatcher(parsed, o);
  return { nsub: parsed.nsub, exec, source: pattern, extended: !!o.extended, hasBackref: parsed.hasBackref };
}

module.exports = { compile, RegexError };
