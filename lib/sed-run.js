'use strict';
// lib/sed-run.js - interpreter for parsed GNU sed 4.9 scripts (TODO R4c).
//
// Pure module: no Pulsar, no file access. It runs the vector produced by lib/sed-parse.js over the text of
// ONE input (the whole file as a string) and returns the new text.
//
//   const { runScript, SedRunError } = require('./sed-run');
//   const { cmds, silent } = parseScript(script, { extended: false, sandbox: true });
//   const { output, exitCode, quit } = runScript({ cmds, silent }, text, opts);
//
// opts (all optional):
//   silent     true for -n (a `#n` first line is already in the parse result)
//   lineWrap   default width of `l` (GNU -l N, default 70; 0 never wraps)
//   fileName   what `F` prints (default '-', like sed reading standard input)
//   scope      { from, to }: run the script as if it were wrapped in `from,to{ ... }` (whole-file line numbers
//              and `$` keep their meaning; this is how a function scope is expressed)
//   maxSteps   safety stop for endless loops (real sed would run forever); throws SedRunError (exit code 4)
//
// Behaviour follows GNU sed 4.9 (execute.c), including: a missing final newline is kept missing, the `t` flag is
// reset whenever a new line is read (also by n / N), `N` on the last line prints the pattern space, an empty
// regex means "the last regex used at run time", `c` inside a range prints its text once at the end of the range.
// Not supported (the parser's sandbox mode rejects them first): e, r, R, w, W and the w flag of s.
//
// Bytes: GNU sed works on bytes. Callers should read files with decodeBytes() and write results with encodeBytes():
// bytes that are not valid UTF-8 travel as lone surrogates U+DC80..U+DCFF and come back unchanged. After an empty
// regex match sed steps one BYTE, so `s/x*/-/g` on a multibyte character puts the replacement between its bytes
// (and writes invalid UTF-8); this module does the same on purpose (see midSafe for when it can happen).

class SedRunError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'SedRunError';
    this.exitCode = exitCode === undefined ? 1 : exitCode;
  }
}

const INACTIVE = 0;
const ACTIVE = 1;
const CLOSED = 2;

function toUp(ch) {
  const u = ch.toUpperCase();
  return Array.from(u).length === 1 ? u : ch;
}

function toLow(ch) {
  const l = ch.toLowerCase();
  return Array.from(l).length === 1 ? l : ch;
}

// ---- bytes <-> text ("surrogateescape"): GNU sed works on BYTES, so a regex that matches the empty string can
// split a multibyte character (the replacement lands between its bytes) and a file can hold bytes that are not
// valid UTF-8. Such stray bytes live in the JS string as lone surrogates U+DC80..U+DCFF (byte 0x80..0xFF);
// decodeBytes / encodeBytes convert file bytes to text and back without losing or changing a byte.
const LONE_ESC = /[\udc80-\udcff]/u;

function encodeBytes(str) {
  if (!LONE_ESC.test(str)) return Buffer.from(str, 'utf8');
  const parts = [];
  let run = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xdc80 && cp <= 0xdcff) {
      if (run) { parts.push(Buffer.from(run, 'utf8')); run = ''; }
      parts.push(Buffer.from([cp - 0xdc00]));
    } else run += ch;
  }
  if (run) parts.push(Buffer.from(run, 'utf8'));
  return Buffer.concat(parts);
}

function decodeBytes(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch (e) {
    // not valid UTF-8: decode by hand, turning every byte outside a valid sequence into U+DC80..U+DCFF
  }
  let out = '';
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const b = buf[i];
    if (b < 0x80) { out += String.fromCharCode(b); i++; continue; }
    let need = 0, cp = 0, min = 0;
    if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 0x1f; min = 0x80; }
    else if (b >= 0xe0 && b <= 0xef) { need = 2; cp = b & 0x0f; min = 0x800; }
    else if (b >= 0xf0 && b <= 0xf4) { need = 3; cp = b & 0x07; min = 0x10000; }
    let ok = need > 0 && i + need < n;
    for (let k = 1; ok && k <= need; k++) {
      const c = buf[i + k];
      if ((c & 0xc0) !== 0x80) ok = false;
      else cp = (cp << 6) | (c & 0x3f);
    }
    if (ok && (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))) ok = false;
    if (ok) { out += String.fromCodePoint(cp); i += need + 1; } else { out += String.fromCharCode(0xdc00 + b); i++; }
  }
  return out;
}

function utf8Len(cp) {
  if (cp < 0x80) return 1;
  if (cp >= 0xdc80 && cp <= 0xdcff) return 1; // a stray byte
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

function escByte(b) {
  return String.fromCharCode(b < 0x80 ? b : 0xdc00 + b);
}

// Can the regex match the empty string BETWEEN the bytes of a multibyte character? In GNU sed 4.9 (glibc regex) it can
// only when the pattern has no multibyte-aware parts: no I flag, no `.`, no range / class / negated bracket, no
// \w \W \s \S, no word assertions (\b \B \< \>), no back-reference. Found by probing real sed (see CHANGELOG).
const midSafeCache = new WeakMap();
function midSafe(rx) {
  if (midSafeCache.has(rx)) return midSafeCache.get(rx);
  const v = computeMidSafe(rx);
  midSafeCache.set(rx, v);
  return v;
}

function computeMidSafe(rx) {
  if (rx.icase) return false;
  const s = rx.source;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      const d = s[i + 1];
      i++;
      if (d === undefined) break;
      if ('wWsSbB<>`\''.indexOf(d) >= 0 || (d >= '1' && d <= '9')) return false;
      continue;
    }
    if (ch === '.') return false;
    if (ch === '[') {
      let j = i + 1;
      if (s[j] === '^') return false;
      if (s[j] === ']') j++;
      const first = j;
      while (j < s.length && s[j] !== ']') {
        if (s[j] === '[' && (s[j + 1] === ':' || s[j + 1] === '.' || s[j + 1] === '=')) return false;
        if (s[j] === '-' && j > first && j + 1 < s.length && s[j + 1] !== ']') return false;
        j++;
      }
      i = j;
    }
  }
  return true;
}

// GNU str_append_modified: type bits 1 upper, 2 lower, 4 upper-first (\u), 8 lower-first (\l)
function modify(str, type) {
  if (!type || str === '') return str;
  let out = '';
  let first = true;
  for (const ch of str) {
    if (first) {
      first = false;
      if (type & 4) out += toUp(ch);
      else if (type & 8) out += toLow(ch);
      else if (type & 1) out += toUp(ch);
      else if (type & 2) out += toLow(ch);
      else out += ch;
    } else if (type & 1) out += toUp(ch);
    else if (type & 2) out += toLow(ch);
    else out += ch;
  }
  return out;
}

// GNU append_replacement
function buildReplacement(repl, text, m) {
  let out = '';
  let repMod = 0;
  for (const p of repl.pieces) {
    let curr = (p.type & 12) ? p.type : (p.type | repMod);
    repMod = 0;
    if (p.prefix) {
      out += modify(p.prefix, curr);
      curr &= ~12;
    }
    if (p.ref >= 0) {
      const s = p.ref < m.start.length ? m.start[p.ref] : -1;
      const e = p.ref < m.end.length ? m.end[p.ref] : -1;
      if (s === e || s < 0) {
        if (p.type & 12) repMod = curr & 12;
      } else {
        out += modify(text.slice(s, e), curr);
      }
    }
  }
  return out;
}

// the commands of a script wrapped in `from,to{ ... }` (entries are copied, jump targets shift by one)
function wrapScope(cmds, scope) {
  const n = cmds.length;
  const out = [{ cmd: '{', a1: { type: 'num', n: scope.from }, a2: { type: 'num', n: scope.to }, negate: false, blockEnd: n + 1 }];
  for (const c of cmds) {
    const d = Object.assign({}, c);
    if (typeof d.blockEnd === 'number') d.blockEnd += 1;
    if (typeof d.jump === 'number') d.jump += 1;
    out.push(d);
  }
  out.push({ cmd: '}', a1: null, a2: null, negate: false });
  return out;
}

function makeOutput() {
  const chunks = [];
  let missing = false;
  return {
    write(t) {
      if (missing) { chunks.push('\n'); missing = false; }
      chunks.push(t);
    },
    writeLine(t, chomped) {
      this.write(t);
      if (chomped) chunks.push('\n');
      else missing = true;
    },
    toString() { return chunks.join(''); },
  };
}

function runScript(parsed, input, opts) {
  opts = opts || {};
  const cmds = opts.scope ? wrapScope(parsed.cmds, opts.scope) : parsed.cmds;
  const n = cmds.length;
  const silent = !!(opts.silent || parsed.silent);
  const lineWrap = opts.lineWrap === undefined ? 70 : opts.lineWrap;
  const fileName = opts.fileName === undefined ? '-' : opts.fileName;
  const maxSteps = opts.maxSteps === undefined ? 20000000 : opts.maxSteps;

  const lines = input.length === 0 ? [] : input.split('\n');
  let lastChomped = true;
  if (lines.length) {
    if (lines[lines.length - 1] === '') lines.pop();
    else lastChomped = false;
  }
  let pos = 0;
  const out = makeOutput();
  let ps = { text: '', chomped: true };
  let hs = { text: '', chomped: true };
  let lineNo = 0;
  let replaced = false;
  let lastRegex = null;
  let appendQ = [];
  const rangeState = new Array(n);
  const rangeEnd = new Array(n).fill(0);
  const addrRegexes = new Set();
  for (let i = 0; i < n; i++) {
    const c = cmds[i];
    rangeState[i] = (c.a1 && c.a1.type === 'num' && c.a1.n === 0 && c.a2) ? ACTIVE : INACTIVE;
    if (c.a1 && c.a1.type === 'regex') addrRegexes.add(c.a1.regex);
    if (c.a2 && c.a2.type === 'regex') addrRegexes.add(c.a2.regex);
  }

  function flushAppend() {
    for (const t of appendQ) out.write(t);
    appendQ = [];
  }

  function readInto(append) {
    if (pos >= lines.length) return false;
    flushAppend();
    replaced = false;
    const text = lines[pos];
    const chomped = pos < lines.length - 1 || lastChomped;
    pos++;
    lineNo++;
    if (append) ps.text += '\n' + text;
    else ps.text = text;
    ps.chomped = chomped;
    return true;
  }

  function pickRegex(rx) {
    if (rx.empty) {
      if (!lastRegex) throw new SedRunError('no previous regular expression', 1);
      return lastRegex;
    }
    lastRegex = rx;
    return rx;
  }

  function matchOne(a) {
    switch (a.type) {
      case 'num': return lineNo === a.n;
      case 'last': return pos >= lines.length;
      case 'step':
        if (a.step <= 0) return lineNo === a.first;
        return lineNo >= a.first && (lineNo - a.first) % a.step === 0;
      case 'regex': return pickRegex(a.regex).compiled.exec(ps.text, 0) !== null;
      default: return false;
    }
  }

  // GNU match_address_p
  function matchAddress(i) {
    const c = cmds[i];
    if (!c.a1) return true;
    if (!c.a2) return matchOne(c.a1);
    const l = lineNo;
    if (rangeState[i] === ACTIVE) {
      const t = c.a2.type;
      if (t === 'num' || t === 'plus' || t === 'mod') {
        const end = t === 'num' ? c.a2.n : rangeEnd[i];
        if (l >= end) rangeState[i] = CLOSED;
        return l <= end;
      }
      if (matchOne(c.a2)) rangeState[i] = CLOSED;
      return true;
    }
    if (rangeState[i] === CLOSED && c.a1.type === 'num') return false;
    // a numeric first address starts the range at the first line seen at or after it (the line itself may have been
    // skipped, e.g. inside a block or after n / N); a range that was closed never starts again
    if (c.a1.type === 'num') {
      if (l < c.a1.n) return false;
      // started late and the numeric end is already behind us: the range is over, nothing matches
      if (l > c.a1.n && c.a2.type === 'num' && l > c.a2.n) return false;
    } else if (!matchOne(c.a1)) return false;
    let end = null;
    if (c.a2.type === 'num') end = c.a2.n;
    else if (c.a2.type === 'plus') end = l + c.a2.n;
    else if (c.a2.type === 'mod') end = c.a2.n > 0 ? l + c.a2.n - (l % c.a2.n) : l;
    if (end !== null) {
      if (end <= l) {
        rangeState[i] = CLOSED;
        return true;
      }
      rangeEnd[i] = end;
    }
    rangeState[i] = ACTIVE;
    return true;
  }

  function substitute(c) {
    const rx = pickRegex(c.regex);
    const re = rx.compiled;
    // GNU sed compiles an address regex without sub-expressions; the FIRST time it is reused as the empty regex of an
    // `s` it is recompiled and the group references of that `s` are checked. Later uses are not checked, and a regex
    // of an earlier `s` is never checked: a group that does not exist is simply empty.
    if (c.regex.empty && addrRegexes.has(rx)) {
      addrRegexes.delete(rx);
      if (c.repl.maxId > re.nsub) {
        throw new SedRunError("invalid reference \\" + c.repl.maxId + " on `s' command's RHS", 1);
      }
    }
    const text = ps.text;
    const len = text.length;
    const numb = Math.max(1, c.nth || 0);
    let start = 0;
    let count = 0;
    let prevEnd = -1;
    let did = false;
    let res = '';
    let stop = false;
    const safe = midSafe(rx);
    let byteView = null;
    let bi = 0;
    let bo = 0;
    // byte offset of string index i (only needed when a multibyte character is stepped over)
    const byteOffsetOf = (i) => {
      if (i < bi) { bi = 0; bo = 0; }
      bo += encodeBytes(text.slice(bi, i)).length;
      bi = i;
      return bo;
    };
    // GNU sed steps ONE BYTE after an empty match. Inside a multibyte character the regex may match the empty string
    // again between the bytes (see midSafe), which splits the character. Returns how many string units were consumed.
    const stepChar = (i, m) => {
      const cp = text.codePointAt(i);
      const cl = cp > 0xffff ? 2 : 1;
      const ch = text.slice(i, i + cl);
      const nb = utf8Len(cp);
      if (nb === 1 || !safe || (did && !c.global)) {
        res += ch;
        return cl;
      }
      if (byteView === null) byteView = encodeBytes(text).toString('latin1');
      const bytes = encodeBytes(ch);
      const base = byteOffsetOf(i);
      let piece = escByte(bytes[0]);
      let inserted = false;
      for (let j = 1; j < nb; j++) {
        const mm = re.exec(byteView, base + j);
        if (mm && mm.start[0] === base + j && mm.end[0] === base + j) {
          count++;
          if (count >= numb) {
            did = true;
            inserted = true;
            piece += buildReplacement(c.repl, text, m);
            if (!c.global) {
              for (let k = j; k < nb; k++) piece += escByte(bytes[k]);
              stop = true;
              break;
            }
          }
        }
        piece += escByte(bytes[j]);
      }
      res += inserted ? piece : ch;
      return cl;
    };
    while (start <= len) {
      const m = re.exec(text, start);
      if (!m) break;
      const ms = m.start[0];
      const me = m.end[0];
      if (ms === me && ms === prevEnd) {
        // an empty match right after the previous match does not count: step over one character
        if (ms >= len) break;
        start = ms + stepChar(ms, m);
        if (stop) break;
        continue;
      }
      res += text.slice(start, ms);
      count++;
      if (count < numb) res += text.slice(ms, me);
      else {
        did = true;
        res += buildReplacement(c.repl, text, m);
      }
      prevEnd = me;
      start = me;
      let atEnd = false;
      if (ms === me) {
        if (me < len) {
          start = me + stepChar(me, m);
        } else {
          atEnd = true;
        }
      }
      if (stop || atEnd || (did && !c.global)) break;
    }
    if (!did) return;
    res += text.slice(Math.min(start, len));
    // stray bytes that now form a valid UTF-8 sequence again (e.g. an empty replacement between the bytes) are one character
    if (LONE_ESC.test(res)) res = decodeBytes(encodeBytes(res));
    ps.text = res;
    replaced = true;
    if (c.print) out.writeLine(ps.text, ps.chomped);
  }

  function listLine(width) {
    const lineLen = width < 0 ? lineWrap : width;
    const bytes = encodeBytes(ps.text);
    let o = '';
    let w = 0;
    for (const b of bytes) {
      let item;
      switch (b) {
        case 92: item = '\\\\'; break;
        case 7: item = '\\a'; break;
        case 8: item = '\\b'; break;
        case 12: item = '\\f'; break;
        case 10: item = '\\n'; break;
        case 13: item = '\\r'; break;
        case 9: item = '\\t'; break;
        case 11: item = '\\v'; break;
        default:
          item = b >= 32 && b < 127 ? String.fromCharCode(b) : '\\' + b.toString(8).padStart(3, '0');
      }
      if (lineLen > 0 && w + item.length > lineLen - 1) {
        o += '\\\n';
        w = 0;
      }
      o += item;
      w += item.length;
    }
    out.write(o + '$\n');
  }

  function translate(c) {
    let res = '';
    for (const ch of ps.text) {
      const r = c.map.get(ch);
      res += r === undefined ? ch : r;
    }
    ps.text = res;
  }

  let exitCode = 0;
  let quit = false;
  let skipFinalFlush = false;
  let restart = false;
  let steps = 0;

  for (;;) {
    if (!restart) {
      if (!readInto(false)) break;
    }
    restart = false;
    let pc = 0;
    let outcome = 'end';
    while (pc < n) {
      if (++steps > maxSteps) throw new SedRunError('step limit exceeded (the script may loop forever)', 4);
      const c = cmds[pc];
      let hit = matchAddress(pc);
      if (c.negate) hit = !hit;
      if (!hit) {
        pc = c.cmd === '{' ? c.blockEnd + 1 : pc + 1;
        continue;
      }
      switch (c.cmd) {
        case '{': case '}': case ':': case '#': break;
        case '=': out.write(lineNo + '\n'); break;
        case 'a': appendQ.push(c.text); break;
        case 'i': out.write(c.text); break;
        case 'c':
          if (rangeState[pc] !== ACTIVE) out.write(c.text);
          outcome = 'delete';
          break;
        case 'd': outcome = 'delete'; break;
        case 'D': {
          const k = ps.text.indexOf('\n');
          if (k < 0) outcome = 'delete';
          else {
            ps.text = ps.text.slice(k + 1);
            outcome = 'restart';
          }
          break;
        }
        case 'F': out.write(fileName + '\n'); break;
        case 'g': ps.text = hs.text; ps.chomped = hs.chomped; break;
        case 'G': ps.text += '\n' + hs.text; ps.chomped = hs.chomped; break;
        case 'h': hs.text = ps.text; hs.chomped = ps.chomped; break;
        case 'H': hs.text += '\n' + ps.text; hs.chomped = ps.chomped; break;
        case 'l': listLine(c.width === undefined ? -1 : c.width); break;
        case 'n':
          if (pos < lines.length) {
            if (!silent) out.writeLine(ps.text, ps.chomped);
            readInto(false);
          } else {
            pc = n;
            continue;
          }
          break;
        case 'N':
          if (pos < lines.length) readInto(true);
          else {
            pc = n;
            continue;
          }
          break;
        case 'p': out.writeLine(ps.text, ps.chomped); break;
        case 'P': {
          const k = ps.text.indexOf('\n');
          if (k < 0) out.writeLine(ps.text, ps.chomped);
          else out.write(ps.text.slice(0, k) + '\n');
          break;
        }
        case 'q':
          exitCode = c.exit === undefined || c.exit < 0 ? 0 : c.exit;
          outcome = 'quit';
          break;
        case 'Q':
          exitCode = c.exit === undefined || c.exit < 0 ? 0 : c.exit;
          outcome = 'quitSilent';
          break;
        case 's':
          if (c.eval || c.wfile) throw new SedRunError('the e and w flags of s are not supported', 1);
          substitute(c);
          break;
        case 't':
          if (replaced) {
            replaced = false;
            pc = c.jump;
            continue;
          }
          break;
        case 'T':
          if (!replaced) {
            pc = c.jump;
            continue;
          }
          replaced = false;
          break;
        case 'b': pc = c.jump; continue;
        case 'x': { const t = ps; ps = hs; hs = t; break; }
        case 'y': translate(c); break;
        case 'z': ps.text = ''; break;
        case 'e': case 'r': case 'R': case 'w': case 'W':
          throw new SedRunError('the ' + c.cmd + ' command is not supported', 1);
        default:
          throw new SedRunError('unknown command: ' + c.cmd, 1);
      }
      if (outcome !== 'end') break;
      pc++;
    }
    if (outcome === 'end') {
      if (!silent) out.writeLine(ps.text, ps.chomped);
    } else if (outcome === 'restart') {
      flushAppend();
      restart = true;
    } else if (outcome === 'quit') {
      // GNU q always ends the printed pattern space with a newline, even when the input had none
      if (!silent) out.write(ps.text + '\n');
      flushAppend();
      quit = true;
      skipFinalFlush = true;
      break;
    } else if (outcome === 'quitSilent') {
      quit = true;
      skipFinalFlush = true;
      break;
    }
  }
  if (!skipFinalFlush) flushAppend();
  return { output: out.toString(), exitCode, quit };
}

module.exports = { runScript, SedRunError, decodeBytes, encodeBytes };
