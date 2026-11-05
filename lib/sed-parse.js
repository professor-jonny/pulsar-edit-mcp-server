'use strict';
// lib/sed-parse.js - parser for GNU sed 4.9 scripts (TODO R4b).
//
// Pure module: no Pulsar, no I/O (it never opens the files named by r / R / w / W; it only records the names).
// Reproduces the behaviour of GNU sed's compile.c, including its error messages and the "char N" positions.
//
//   const { cmds, silent } = parseScript(script, { extended: false, sandbox: false });
//
// `cmds` is a flat vector like sed's own: every command is one entry, a `{` knows the index of its `}`
// (blockEnd), a b / t / T knows the index it jumps to (jump; cmds.length means "end of script"), a ':' entry is
// a no-op that carries its label. Entries:
//   { cmd, a1, a2, negate, ...arguments }
//   a1 / a2: null or { type: 'num', n } | { type: 'last' } | { type: 'step', first, step } (first~step)
//            | { type: 'regex', regex } | { type: 'plus', n } (a2 only: +N) | { type: 'mod', n } (a2 only: ~N)
//   a, i, c:        text  (final text, normally ending in a newline; '' for a bare `a\`)
//   s:              regex, repl: { pieces, maxId }, global, print (bit 1 = before eval, 2 = after), eval, nth, wfile
//   y:              map: Map of character (a one-character string) -> replacement character
//   r R w W:        file          e: command          q Q: exit (or -1)          l: width (or -1)
//   b t T:          label, jump   : label             {: blockEnd
// A regex is { source, icase, multiline, empty, compiled } where `compiled` is a lib/posix-regex result
// (null when `empty`: the empty regex means "the last regex used" at run time).
// Replacement pieces follow GNU sed: { prefix, ref, type } with ref -1 for none, 0 for & and \0, 1 to 9 for
// groups; type is a bit set: 1 upper, 2 lower, 4 upper-first (\u), 8 lower-first (\l).
// Errors are SedParseError: message "-e expression #1, char N: reason" (or just the reason when sed prints
// no position), plus .reason and .char (null when there is none).

const { compile: compileRegex, RegexError } = require('./posix-regex');

const EOF = null;
const SED_VERSION = '4.9';

const R = {
  BAD_MODIF: 'cannot specify modifiers on empty regexp',
  EXCESS_OPEN_BRACE: 'unmatched `{\'',
  EXCESS_CLOSE_BRACE: 'unexpected `}\'',
  EXCESS_JUNK: 'extra characters after command',
  EXPECTED_SLASH: 'expected \\ after `a\', `c\' or `i\'',
  NO_COLON_ADDR: ': doesn\'t want any addresses',
  COLON_LACKS_LABEL: '":" lacks a label',
  NO_CLOSE_BRACE_ADDR: '`}\' doesn\'t want any addresses',
  NO_SHARP_ADDR: 'comments don\'t accept any addresses',
  ONE_ADDR: 'command only uses one address',
  BAD_BANG: 'multiple `!\'s',
  BAD_COMMA: 'unexpected `,\'',
  NO_COMMAND: 'missing command',
  UNTERMINATED_S: 'unterminated `s\' command',
  UNTERMINATED_Y: 'unterminated `y\' command',
  UNTERMINATED_REGEX: 'unterminated address regex',
  Y_CMD_LEN: 'strings for `y\' command are different lengths',
  UNKNOWN_S_OPT: 'unknown option to `s\'',
  EXCESS_P_OPT: 'multiple `p\' options to `s\' command',
  EXCESS_G_OPT: 'multiple `g\' options to `s\' command',
  EXCESS_N_OPT: 'multiple number options to `s\' command',
  ZERO_N_OPT: 'number option to `s\' command may not be zero',
  INVALID_LINE_0: 'invalid usage of line address 0',
  BAD_PLUS_TILDE: 'invalid usage of +N or ~N as first address',
  MISSING_FILENAME: 'missing filename in r/R/w/W commands',
  EXPECTED_NEWER: 'expected newer version of sed',
  CLASS_SYNTAX: 'character class syntax is [[:space:]], not [:space:]',
  SANDBOX: 'e/r/w commands disabled in sandbox mode',
  RECURSIVE_C: 'recursive escaping after \\c not allowed',
};

class SedParseError extends Error {
  constructor(reason, char, exprNo) {
    super(char === null || char === undefined ? reason : '-e expression #' + (exprNo || 1) + ', char ' + char + ': ' + reason);
    this.name = 'SedParseError';
    this.reason = reason;
    this.char = char === undefined ? null : char;
  }
}

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';
const isDigit = (c) => c !== EOF && c >= '0' && c <= '9';

// like glibc strverscmp for what `v` needs: digit runs compare as numbers, everything else by character code
function versionCompare(a, b) {
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (isDigit(a[i]) && isDigit(b[j])) {
      let ei = i, ej = j;
      while (ei < a.length && isDigit(a[ei])) ei++;
      while (ej < b.length && isDigit(b[ej])) ej++;
      const na = a.slice(i, ei).replace(/^0+(?=\d)/, ''), nb = b.slice(j, ej).replace(/^0+(?=\d)/, '');
      if (na.length !== nb.length) return na.length < nb.length ? -1 : 1;
      if (na !== nb) return na < nb ? -1 : 1;
      i = ei; j = ej;
      continue;
    }
    if (a[i] !== b[j]) return a[i] < b[j] ? -1 : 1;
    i++; j++;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

// ---------------------------------------------------------------- text normalisation (sed's normalize_text)
// kind: 'regex' | 'replacement' | 'buffer' (a, i, c text) | 'none' (y strings)
function digitValue(c) {
  if (c === undefined) return -1;
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'a' && c <= 'f') return c.charCodeAt(0) - 87;
  if (c >= 'A' && c <= 'F') return c.charCodeAt(0) - 55;
  return -1;
}

function normalizeText(s, kind, fail) {
  const bad = fail || ((reason) => { throw new SedParseError(reason, null); });
  let out = '';
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c !== '\\' || i + 1 >= n) { out += c; i++; continue; }
    const d = s[i + 1];
    switch (d) {
      case 'a': out += '\x07'; i += 2; continue;
      case 'f': out += '\f'; i += 2; continue;
      case 'n': out += '\n'; i += 2; continue;
      case 'r': out += '\r'; i += 2; continue;
      case 't': out += '\t'; i += 2; continue;
      case 'v': out += '\v'; i += 2; continue;
      case 'c': {
        if (i + 2 >= n) {
          out += kind === 'replacement' ? '\\\\' : '\\c';
          i += 2;
          continue;
        }
        let x = s[i + 2];
        let used = 3;
        if (x === '\\') {
          if (s[i + 3] !== '\\') bad(R.RECURSIVE_C);
          used = 4;
        }
        out += String.fromCharCode(x.toUpperCase().charCodeAt(0) ^ 0x40);
        i += used;
        continue;
      }
      case 'd': case 'o': case 'x': {
        const base = d === 'd' ? 10 : d === 'o' ? 8 : 16;
        let num = 0, max = 1, p = i + 2;
        for (; p < n && max <= 255; p++, max *= base) {
          const v = digitValue(s[p]);
          if (v < 0 || v >= base) break;
          num = num * base + v;
        }
        const ch = p === i + 2 ? d : String.fromCharCode(num & 0xff);
        // a produced & or \ stays literal in a replacement; elsewhere it is inserted as it is
        if (kind === 'replacement' && (ch === '&' || ch === '\\')) out += '\\';
        out += ch;
        i = p;
        continue;
      }
      case '\\':
        out += kind === 'buffer' ? '\\' : '\\\\';
        i += 2;
        continue;
      default:
        if (kind === 'buffer') out += d; // an unknown escape in a/i/c text just loses its backslash
        else out += '\\' + d;
        i += 2;
    }
  }
  return out;
}

// ---------------------------------------------------------------- the parser

class Parser {
  constructor(script, opts) {
    this.s = script;
    this.i = 0;
    this.opts = opts;
    this.cmds = [];
    this.blocks = [];
    this.labels = new Map();
    this.jumps = [];
    this.silent = false;
  }

  // ---- reader (sed's inchar / savchar / in_nonblank)
  inchar() { return this.i < this.s.length ? this.s[this.i++] : EOF; }
  savchar(ch) { if (ch !== EOF) this.i--; }
  peek() { return this.i < this.s.length ? this.s[this.i] : EOF; }
  inNonblank() {
    let ch;
    do { ch = this.inchar(); } while (ch === ' ' || ch === '\t');
    return ch;
  }
  inInteger(ch) {
    let num = 0;
    while (isDigit(ch)) { num = num * 10 + (ch.charCodeAt(0) - 48); ch = this.inchar(); }
    this.savchar(ch);
    return num;
  }
  bytePos() { return Buffer.byteLength(this.s.slice(0, this.i), 'utf8'); }
  fail(reason) { throw new SedParseError(reason, this.bytePos(), 1); }

  readEndOfCmd() {
    const ch = this.inNonblank();
    if (ch === '}' || ch === '#') this.savchar(ch);
    else if (ch !== EOF && ch !== '\n' && ch !== ';') this.fail(R.EXCESS_JUNK);
  }

  readLabel() {
    let ch = this.inNonblank();
    let b = '';
    while (ch !== EOF && ch !== '\n' && !isSpace(ch) && ch !== ';' && ch !== '}' && ch !== '#') { b += ch; ch = this.inchar(); }
    this.savchar(ch);
    return b;
  }

  readFilename() {
    let ch = this.inNonblank();
    let b = '';
    while (ch !== EOF && ch !== '\n') { b += ch; ch = this.inchar(); }
    return b;
  }

  // ---- delimited strings (sed's match_slash); returns null when unterminated
  matchSlash(slash, regex) {
    if (slash === EOF) return null;
    let b = '';
    let ch;
    let inBracket = false;
    let closed = false;
    while ((ch = this.inchar()) !== EOF && ch !== '\n') {
      if (inBracket) {
        if (ch === '\\') {
          const nx = this.peek();
          if (nx === 'n') { this.i++; b += '\n'; continue; }
          if (nx === slash) { this.i++; b += slash; continue; }
          b += '\\';
          continue;
        }
        b += ch;
        if (ch === ']') inBracket = false;
        else if (ch === '[') {
          const k = this.peek();
          if (k === ':' || k === '.' || k === '=') {
            const close = this.s.indexOf(k + ']', this.i + 1);
            if (close >= 0 && this.s.slice(this.i, close).indexOf('\n') < 0) {
              b += this.s.slice(this.i, close + 2);
              this.i = close + 2;
            }
          }
        }
        continue;
      }
      if (ch === slash) { closed = true; break; }
      if (ch === '\\') {
        ch = this.inchar();
        if (ch === EOF) break;
        else if (ch === 'n' && regex) ch = '\n';
        else if (ch !== '\n' && (ch !== slash || (!regex && ch === '&'))) b += '\\';
        b += ch;
        continue;
      }
      if (regex && ch === '[') {
        inBracket = true;
        b += ch;
        if (this.peek() === '^') { b += '^'; this.i++; }
        if (this.peek() === ']') { b += ']'; this.i++; }
        continue;
      }
      b += ch;
    }
    if (ch === '\n') this.savchar(ch);
    return closed ? b : null;
  }

  // ---- regex compilation (sed's compile_rx)
  compileRx(b, icase, multiline, neededRefs) {
    if (b.length === 0) {
      if (icase || multiline) this.fail(R.BAD_MODIF);
      return { source: '', icase: false, multiline: false, empty: true, compiled: null };
    }
    const pattern = normalizeText(b, 'regex', (r) => this.fail(r));
    if (hasBadClassSyntax(pattern)) throw new SedParseError(R.CLASS_SYNTAX, null);
    let compiled;
    try {
      compiled = compileRegex(pattern, { extended: !!this.opts.extended, icase, multiline });
    } catch (e) {
      if (e instanceof RegexError) this.fail(e.message);
      throw e;
    }
    if (neededRefs > compiled.nsub + 1) this.fail('invalid reference \\' + (neededRefs - 1) + ' on `s\' command\'s RHS');
    return { source: pattern, icase, multiline, empty: false, compiled };
  }

  // ---- addresses (sed's compile_address); returns null when `ch` does not start one
  compileAddress(ch) {
    if (ch === '/' || ch === '\\') {
      if (ch === '\\') ch = this.inchar();
      const b = this.matchSlash(ch, true);
      if (b === null) this.fail(R.UNTERMINATED_REGEX);
      let icase = false, multiline = false;
      for (;;) {
        ch = this.inNonblank();
        if (ch === 'I') icase = true;
        else if (ch === 'M') multiline = true;
        else { this.savchar(ch); break; }
      }
      return { type: 'regex', regex: this.compileRx(b, icase, multiline, 0) };
    }
    if (isDigit(ch)) {
      const n = this.inInteger(ch);
      ch = this.inNonblank();
      if (ch !== '~') { this.savchar(ch); return { type: 'num', n }; }
      const step = this.inInteger(this.inNonblank());
      return step > 0 ? { type: 'step', first: n, step } : { type: 'num', n };
    }
    if (ch === '+' || ch === '~') {
      const n = this.inInteger(this.inNonblank());
      // sed turns +0 and ~0 into a null address: as a first address it matches every line, as a second one the
      // range ends on the line where it started (we call that { type: 'plus', n: 0 })
      if (n === 0) return { type: 'null', zero: true };
      return { type: ch === '+' ? 'plus' : 'mod', n };
    }
    if (ch === '$') return { type: 'last' };
    return null;
  }

  // ---- a, i, c, e text (sed's read_text); the reader sits on the first character of the text
  readText() {
    let buf = '';
    let ch = this.inchar();
    while (ch !== EOF && ch !== '\n') {
      if (ch === '\\') {
        ch = this.inchar();
        if (ch !== EOF) buf += '\\';
      }
      if (ch === EOF) { buf += '\n'; return normalizeText(buf, 'buffer', (r) => this.fail(r)); }
      buf += ch;
      ch = this.inchar();
    }
    buf += '\n';
    return normalizeText(buf, 'buffer', (r) => this.fail(r));
  }

  readTextArgument() {
    let ch = this.inNonblank();
    if (ch === EOF) this.fail(R.EXPECTED_SLASH);
    if (ch === '\\') {
      ch = this.inchar();
      if (ch === EOF) return '';
      if (ch === '\n') return this.readText();
      this.savchar(ch);
      return this.readText();
    }
    this.savchar(ch);
    return this.readText();
  }

  // ---- replacement of s (sed's setup_replacement)
  setupReplacement(text) {
    const t = normalizeText(text, 'replacement', (r) => this.fail(r));
    const pieces = [];
    let reprType = 0, saveType = 0, maxId = 0, base = 0, tail = null;
    for (let p = 0; p < t.length; ++p) {
      const ch = t[p];
      if (ch === '\\') {
        tail = { prefix: t.slice(base, p), ref: -1, type: reprType };
        pieces.push(tail);
        reprType = saveType;
        p++;
        if (p >= t.length) tail.prefix += '\\';
        else {
          const e = t[p];
          if (e >= '0' && e <= '9') { tail.ref = e.charCodeAt(0) - 48; if (maxId < tail.ref) maxId = tail.ref; }
          else if (e === 'L') { reprType = 2; saveType = 2; }
          else if (e === 'U') { reprType = 1; saveType = 1; }
          else if (e === 'E') { reprType = 0; saveType = 0; }
          else if (e === 'l') { saveType = reprType; reprType |= 8; }
          else if (e === 'u') { saveType = reprType; reprType |= 4; }
          else tail.prefix += e;
        }
        base = p + 1;
      } else if (ch === '&') {
        tail = { prefix: t.slice(base, p), ref: 0, type: reprType };
        pieces.push(tail);
        reprType = saveType;
        base = p + 1;
      }
    }
    if (base < t.length) pieces.push({ prefix: t.slice(base), ref: -1, type: reprType });
    return { pieces, maxId };
  }

  // ---- flags of s (sed's mark_subst_opts)
  markSubstOpts(cmd) {
    let icase = false, multiline = false;
    cmd.global = false; cmd.print = 0; cmd.eval = false; cmd.nth = 0; cmd.wfile = null;
    for (;;) {
      const ch = this.inchar();
      switch (ch) {
        case 'i': case 'I': icase = true; break;
        case 'm': case 'M': multiline = true; break;
        case 'e':
          if (this.opts.sandbox) this.fail(R.SANDBOX);
          cmd.eval = true;
          break;
        case 'p':
          if (cmd.print) this.fail(R.EXCESS_P_OPT);
          cmd.print |= (1 << (cmd.eval ? 1 : 0));
          break;
        case 'g':
          if (cmd.global) this.fail(R.EXCESS_G_OPT);
          cmd.global = true;
          break;
        case 'w': {
          if (this.opts.sandbox) this.fail(R.SANDBOX);
          const f = this.readFilename();
          if (f === '') this.fail(R.MISSING_FILENAME);
          cmd.wfile = f;
          return { icase, multiline };
        }
        case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
          if (cmd.nth) this.fail(R.EXCESS_N_OPT);
          cmd.nth = this.inInteger(ch);
          if (!cmd.nth) this.fail(R.ZERO_N_OPT);
          break;
        case '}': case '#':
          this.savchar(ch);
          return { icase, multiline };
        case '\n': case ';': case EOF:
          return { icase, multiline };
        case ' ': case '\t':
          break;
        case '\r':
          if (this.inchar() === '\n') return { icase, multiline };
          this.fail(R.UNKNOWN_S_OPT);
          break;
        default:
          this.fail(R.UNKNOWN_S_OPT);
      }
    }
  }

  checkSandbox(what) {
    if (this.opts.sandbox) this.fail(R.SANDBOX);
    return what;
  }

  // ---- the main loop (sed's compile_program)
  run() {
    const { cmds } = this;
    let ch;
    while ((ch = this.inchar()) !== EOF) {
      if (ch === ';' || isSpace(ch)) continue;
      const startIdx = this.i - 1;
      const cmd = { cmd: null, a1: null, a2: null, negate: false };
      const a = this.compileAddress(ch);
      if (a) {
        if (a.type === 'plus' || a.type === 'mod') this.fail(R.BAD_PLUS_TILDE);
        cmd.a1 = a;
        ch = this.inNonblank();
        if (ch === ',') {
          const a2 = this.compileAddress(this.inNonblank());
          if (!a2) this.fail(R.BAD_COMMA);
          cmd.a2 = a2.type === 'null' ? { type: 'plus', n: 0 } : a2;
          ch = this.inNonblank();
        }
        if (cmd.a1.type === 'num' && cmd.a1.n === 0 && (cmd.a2 ? cmd.a2.type !== 'regex' : ch !== 'r')) this.fail(R.INVALID_LINE_0);
      }
      if (ch === '!') {
        cmd.negate = true;
        ch = this.inNonblank();
        if (ch === '!') this.fail(R.BAD_BANG);
      }
      if (ch === EOF) this.fail(R.NO_COMMAND);
      cmd.cmd = ch;

      switch (ch) {
        case '#':
          if (cmd.a1) this.fail(R.NO_SHARP_ADDR);
          ch = this.inchar();
          if (ch === 'n' && startIdx === 0) this.silent = true;
          while (ch !== EOF && ch !== '\n') ch = this.inchar();
          continue;

        case 'v': {
          const arg = this.readLabel();
          if (arg !== '' && versionCompare(arg, SED_VERSION) > 0) this.fail(R.EXPECTED_NEWER);
          continue;
        }

        case '{':
          this.blocks.push(cmds.length);
          break;

        case '}':
          if (!this.blocks.length) this.fail(R.EXCESS_CLOSE_BRACE);
          if (cmd.a1) this.fail(R.NO_CLOSE_BRACE_ADDR);
          this.readEndOfCmd();
          cmds[this.blocks.pop()].blockEnd = cmds.length;
          break;

        case 'e': {
          this.checkSandbox();
          ch = this.inNonblank();
          if (ch === EOF || ch === '\n') { cmd.command = ''; break; }
          this.savchar(ch);
          cmd.command = this.readTextArgument();
          break;
        }

        case 'a': case 'i': case 'c':
          cmd.text = this.readTextArgument();
          break;

        case ':': {
          if (cmd.a1) this.fail(R.NO_COLON_ADDR);
          const label = this.readLabel();
          if (label === '') this.fail(R.COLON_LACKS_LABEL);
          cmd.label = label;
          this.labels.set(label, cmds.length);
          break;
        }

        case 'T': case 'b': case 't':
          cmd.label = this.readLabel();
          this.jumps.push(cmd);
          break;

        case 'Q': case 'q':
          if (cmd.a2) this.fail(R.ONE_ADDR);
          // fall through
        case 'l': {
          ch = this.inNonblank();
          let arg = -1;
          if (isDigit(ch)) { arg = this.inInteger(ch); ch = this.inNonblank(); }
          this.savchar(ch);
          if (cmd.cmd === 'l') cmd.width = arg; else cmd.exit = arg;
          this.readEndOfCmd();
          break;
        }

        case '=': case 'd': case 'D': case 'F': case 'g': case 'G': case 'h': case 'H':
        case 'n': case 'N': case 'p': case 'P': case 'z': case 'x':
          this.readEndOfCmd();
          break;

        case 'r': case 'R': case 'w': case 'W': {
          this.checkSandbox();
          const f = this.readFilename();
          if (f === '') this.fail(R.MISSING_FILENAME);
          cmd.file = f;
          break;
        }

        case 's': {
          const slash = this.inchar();
          const b = this.matchSlash(slash, true);
          if (b === null) this.fail(R.UNTERMINATED_S);
          const b2 = this.matchSlash(slash, false);
          if (b2 === null) this.fail(R.UNTERMINATED_S);
          cmd.repl = this.setupReplacement(b2);
          const fl = this.markSubstOpts(cmd);
          cmd.regex = this.compileRx(b, fl.icase, fl.multiline, cmd.repl.maxId + 1);
          break;
        }

        case 'y': {
          const slash = this.inchar();
          const src = this.matchSlash(slash, false);
          if (src === null) this.fail(R.UNTERMINATED_Y);
          const dst = this.matchSlash(slash, false);
          if (dst === null) this.fail(R.UNTERMINATED_Y);
          const unesc = (str) => {
            const t = normalizeText(str, 'none', (r) => this.fail(r));
            const out = [];
            for (let k = 0; k < t.length;) {
              if (t[k] === '\\' && k + 1 < t.length) { out.push(t[k + 1]); k += 2; } else { out.push(t[k]); k++; }
            }
            return Array.from(out.join(''));
          };
          const from = unesc(src), to = unesc(dst);
          if (from.length !== to.length) this.fail(R.Y_CMD_LEN);
          cmd.map = new Map();
          for (let k = 0; k < from.length; k++) if (!cmd.map.has(from[k])) cmd.map.set(from[k], to[k]);
          this.readEndOfCmd();
          break;
        }

        default:
          this.fail('unknown command: `' + ch + '\'');
      }
      cmds.push(cmd);
    }

    if (this.blocks.length) throw new SedParseError(R.EXCESS_OPEN_BRACE, 0, 1);
    for (const j of this.jumps) {
      if (j.label === '') j.jump = cmds.length;
      else if (this.labels.has(j.label)) j.jump = this.labels.get(j.label);
      else throw new SedParseError('can\'t find label for jump to `' + j.label + '\'', null);
    }
    return { cmds, silent: this.silent };
  }
}

// [:space:] used without the outer brackets (sed refuses it); sees only plain bracket expressions
function hasBadClassSyntax(pattern) {
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { i++; continue; }
    if (c !== '[') continue;
    let j = i + 1;
    if (pattern[j] === '^') j++;
    let k = j;
    if (pattern[k] === ']') k++;
    let plain = true;
    for (; k < pattern.length && pattern[k] !== ']'; k++) {
      if (pattern[k] === '[' || (pattern[k] === '-' && k > j && pattern[k + 1] !== ']')) plain = false;
    }
    if (k >= pattern.length) return false;
    const content = pattern.slice(j, k);
    if (plain && content.length >= 3 && content[0] === ':' && content[content.length - 1] === ':' && /[^:]/.test(content)) return true;
    i = k;
  }
  return false;
}

function parseScript(script, opts) {
  return new Parser(String(script), opts || {}).run();
}

module.exports = { parseScript, SedParseError, normalizeText };
