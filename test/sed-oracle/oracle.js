'use strict';
// tools/sed-oracle/oracle.js - shared helpers for the differential tools in this folder.
// These tools compare lib/posix-regex.js and lib/sed-parse.js with a REAL GNU sed (4.9 was used) and are NOT part of
// the test suite (they need sed on PATH; PJ's Windows machine has none). Run them where sed exists, for example in the
// assistant's sandbox or WSL. See README.md.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseScript, SedParseError } = require('../../lib/sed-parse');
const { encodeBytes, decodeBytes } = require('../../lib/sed-run');

const ENV = Object.assign({}, process.env, { LC_ALL: process.env.SED_ORACLE_LOCALE || 'C.UTF-8' });
// scripts with w / r commands write and read files: keep them in a scratch folder
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'sed-oracle-'));

function requireSed() {
  const r = spawnSync('sed', ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0 || !/GNU sed/.test(r.stdout)) {
    console.error('These tools need a real GNU sed on PATH (4.9 was used). Not found.');
    process.exit(2);
  }
  return r.stdout.split('\n')[0];
}

function runSed(args, input) {
  // a native Windows sed translates line ends (CRLF) unless told -b / --binary; on Linux the flag is a no-op, so only add it on Windows
  // bytes in, bytes out (decodeBytes keeps invalid UTF-8 as U+DC80..U+DCFF, like lib/sed-run.js does)
  const r = spawnSync('sed', process.platform === 'win32' ? ['-b'].concat(args) : args, { input: encodeBytes(input), env: ENV, timeout: 5000, cwd: CWD });
  // -b does not change stderr: a native Windows sed still ends its messages with CRLF
  const errText = r.stderr ? r.stderr.toString('utf8') : r.stderr;
  const err = process.platform === 'win32' && errText ? errText.replace(/\r\n/g, '\n') : errText;
  return { out: r.stdout ? decodeBytes(r.stdout) : r.stdout, err: err, status: r.status };
}

// ---- verdict of a script: 'ok' | 'ERR n: message' | 'LABEL message' | 'CLASS' | 'SKIP'
// 'no previous regular expression' is a RUN-TIME error in sed, so it counts as a successful parse; a w file that cannot be
// opened makes sed stop while parsing, which hides later syntax errors, so those scripts are skipped.
function realVerdict(script) {
  const r = runSed(['-e', script], 'a\nb\n');
  const m = /-e expression #1, char (\d+): ([^\n]*)/.exec(r.err || '');
  if (/couldn't open file/.test(r.err || '')) return 'SKIP';
  if (m && /no previous regular expression/.test(m[2])) return 'ok';
  if (m) return 'ERR ' + m[1] + ': ' + m[2];
  if (/can't find label/.test(r.err || '')) return 'LABEL ' + /sed: (.*)/.exec(r.err)[1];
  if (/character class syntax/.test(r.err || '')) return 'CLASS';
  return 'ok';
}
function mineVerdict(script, opts) {
  try { parseScript(script, opts); return 'ok'; } catch (e) {
    if (!(e instanceof SedParseError)) throw e;
    const reason = e.reason.split('\n')[0];
    if (reason.indexOf("can't find label") === 0) return 'LABEL ' + reason;
    if (reason.indexOf('character class syntax') === 0) return 'CLASS';
    return 'ERR ' + e.char + ': ' + reason;
  }
}
// stdout of `sed -e script` on one input line, or null when sed reported an error
function realOut(script, line) {
  const r = runSed(['-e', script], line + '\n');
  return r.err ? null : r.out;
}

// ---- GNU s///g loop for the regex level: an empty match directly after the previous match is skipped
function subst(re, str, mk, global) {
  let m = re.exec(str, 0);
  if (!m) return str;
  let out = '', pos = 0, prevEnd = -1;
  while (m) {
    const s = m.start[0], e = m.end[0];
    out += str.slice(pos, s);
    if (!(s === e && s === prevEnd)) { out += mk(m, str); if (!global) return out + str.slice(e); }
    prevEnd = e; pos = e;
    if (s === e) {
      if (pos < str.length) { const cp = str.codePointAt(pos); const len = cp > 0xffff ? 2 : 1; out += str.substr(pos, len); pos += len; } else break;
    }
    m = pos <= str.length ? re.exec(str, pos) : null;
  }
  return out + str.slice(pos);
}

// ---- evaluator for ONE s / y / a / i / c command on one line (the real runner is R4c)
function caseMod(text, type) {
  const first = type & 12, rest = type & 3;
  let out = '';
  Array.from(text).forEach((c, idx) => {
    if (idx === 0 && first) out += first === 4 ? c.toUpperCase() : c.toLowerCase();
    else out += rest === 1 ? c.toUpperCase() : rest === 2 ? c.toLowerCase() : c;
  });
  return out;
}
function expand(pieces, str, m) {
  let out = '', replMod = 0;
  for (const p of pieces) {
    let curr = (p.type & 12) ? p.type : (p.type | replMod);
    replMod = 0;
    if (p.prefix.length) { out += caseMod(p.prefix, curr); curr &= ~12; }
    if (p.ref >= 0) {
      const s = m.start[p.ref], e = m.end[p.ref];
      if ((s < 0 || s === e) && (p.type & 12)) replMod = curr & 12;
      else if (s >= 0 && s !== e) out += caseMod(str.slice(s, e), curr);
    }
  }
  return out;
}
function doS(cmd, line) {
  const re = cmd.regex.compiled;
  let m = re.exec(line, 0);
  if (!m) return { out: line, replaced: false };
  let out = '', pos = 0, prevEnd = -1, count = 0, replaced = false;
  while (m) {
    const s = m.start[0], e = m.end[0];
    out += line.slice(pos, s);
    if (!(s === e && s === prevEnd)) {
      count++;
      if (count < cmd.nth) out += line.slice(s, e);
      else {
        out += expand(cmd.repl.pieces, line, m);
        replaced = true;
        if (!cmd.global) { out += line.slice(e); return { out, replaced }; }
      }
    }
    prevEnd = e; pos = e;
    if (s === e) {
      if (pos < line.length) { const cp = line.codePointAt(pos); const len = cp > 0xffff ? 2 : 1; out += line.substr(pos, len); pos += len; } else break;
    }
    m = pos <= line.length ? re.exec(line, pos) : null;
  }
  return { out: out + line.slice(pos), replaced };
}
// output of a one-command script on one line, or null when the script is not a single s / y / a / i / c
function mineRun(script, line) {
  const { cmds, silent } = parseScript(script);
  if (cmds.length !== 1) return null;
  const c = cmds[0];
  let pattern = line, pre = '', post = '', extra = '';
  if (c.cmd === 's') {
    const r = doS(c, line);
    pattern = r.out;
    if (r.replaced && c.print) extra = pattern + '\n';
  } else if (c.cmd === 'y') {
    pattern = Array.from(line).map((ch) => (c.map.has(ch) ? c.map.get(ch) : ch)).join('');
  } else if (c.cmd === 'a') post = c.text;
  else if (c.cmd === 'i') pre = c.text;
  else if (c.cmd === 'c') return c.text;
  else return null;
  return pre + extra + (silent ? '' : pattern + '\n') + post;
}

// seeded pseudo-random numbers, so a failing run can be repeated
function rng(seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  return { rnd, pick: (a) => a[Math.floor(rnd() * a.length)] };
}

module.exports = { requireSed, runSed, realVerdict, mineVerdict, realOut, subst, mineRun, doS, expand, rng, CWD };
