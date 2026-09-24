'use strict';
// insert regex / fuzzyContent wiring test (2026-09-22).
// Drives the REAL engine in plain Node with the exact option shape insert's handler now forwards
// (mcp-registration.js ~L1744), and pins the OLD shape as the bug. No Pulsar, no restart needed.
// Run from the package root:   node test/insert_regex_wiring_test.js
// Read the final 'passed / failed' line. A negative control at the end proves the checks can fail.
const fs = require('fs');
const path = require('path');
const eng = require('../lib/match-engine');

const buf = [
  'function alpha() {',   // L1 (row 0)
  '  const total = 1;',   // L2 (row 1)
  '  return total;',      // L3
  '}',                    // L4
  '',                     // L5
  'function beta() {',    // L6
  '  const count = 2;',   // L7
  '  return count;',      // L8
  '}',                    // L9
];
const text = buf.join('\n');
const src = { allLines: buf, text };
const scope = () => eng.resolveScope({
  editor: null, buffer: null, allLines: buf, text, filePath: 'x.c',
  params: { inFunction: undefined, occurrence: undefined, hintRadius: 25, fuzzyWhitespace: false },
});

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (!cond && detail ? '\n       ' + detail : ''));
}
const desc = (m) => m ? `matched=${m.matched} row=${m.matchLine} end=${m.matchEndLine} transforms=${JSON.stringify(m.transforms || [])} reason=${m.reason}` : 'null';

// What insert's handler does, parameterised so the OLD and NEW shapes can both be run.
function run(anchor, flags, shape) {
  const sc = scope();
  if (sc.error) return { scopeError: sc.error };
  const opts = shape === 'old'
    ? { fuzzyWhitespace: !!flags.fuzzyWhitespace, occurrence: flags.occurrence }
    : { fuzzyWhitespace: !!flags.fuzzyWhitespace, fuzzyContent: !!flags.fuzzyContent, regex: !!flags.regex, occurrence: flags.occurrence };
  return eng.matchContent(anchor, src, sc, opts);
}

// ---- 1. THE BUG: with the OLD option shape, regex:true is silently dropped -------------------------
let m = run('const total = \\d;', { regex: true }, 'old');
check('1a OLD shape: regex pattern is NOT honoured (this is the bug being fixed)', m.matched === false, desc(m));

// ---- 2. THE FIX: NEW shape forwards regex ----------------------------------------------------------
m = run('const total = \\d;', { regex: true }, 'new');
check('2a NEW shape: regex anchor matches', m.matched === true, desc(m));
check('2b NEW shape: matches the right row (L2 = row 1)', m.matchLine === 1 && m.matchEndLine === 1, desc(m));
check('2c NEW shape: match is tagged as regex', (m.transforms || []).includes('regex'), desc(m));

// insert places content AFTER matchEndLine (insertAfter -> anchorEnd + 1); prove the row it would use
const insertRowAfter = m.matchEndLine + 1;
check('2d afterContent insert row = 2 (new line lands at L3, directly after the matched L2)', insertRowAfter === 2, 'insertRow=' + insertRowAfter);

// ---- 3. THE ROW FIX, on the insert path (this is the check that was UNTESTABLE before) -------------
// A trailing \s* used to drag the NEXT row into the match; insert then landed one row too low.
m = run('const total = \\d;\\s*', { regex: true }, 'new');
check('3a trailing \\s* regex still matches', m.matched === true, desc(m));
check('3b trailing \\s* does NOT extend the match past L2 (matchEndLine stays row 1)', m.matchEndLine === 1, desc(m));
check('3c so afterContent inserts after L2, NOT after L3', (m.matchEndLine + 1) === 2, 'insertRow=' + (m.matchEndLine + 1));
m = run('\\s*const total = \\d;', { regex: true }, 'new');
check('3d leading \\s* does NOT pull in the previous row (starts at row 1, not row 0)', m.matched === true && m.matchLine === 1, desc(m));

// ---- 4. per-line anchors and ambiguity carry through to insert -------------------------------------
m = run('^function', { regex: true }, 'new');
check('4a ^function (2 hits) is refused as ambiguous, not silently the first', m.matched === false && /ambig/i.test(String(m.reason)), desc(m));
m = run('^function', { regex: true, occurrence: 2 }, 'new');
check('4b ^function with occurrence:2 picks the beta line (row 5)', m.matched === true && m.matchLine === 5, desc(m));

// ---- 5. fuzzyContent now forwarded (unicode-normalised compare) ------------------------------------
const uni = ['const label = \u201Chello\u201D;'];           // smart quotes in the FILE
const usrc = { allLines: uni, text: uni.join('\n') };
const usc = eng.resolveScope({ editor: null, buffer: null, allLines: uni, text: uni.join('\n'), filePath: 'u.js',
  params: { inFunction: undefined, occurrence: undefined, hintRadius: 25, fuzzyWhitespace: false } });
const plain = 'const label = "hello";';                       // straight quotes in the ANCHOR
const oldU = eng.matchContent(plain, usrc, usc, { fuzzyWhitespace: false, occurrence: undefined });
const newU = eng.matchContent(plain, usrc, usc, { fuzzyWhitespace: false, fuzzyContent: true, regex: false, occurrence: undefined });
// FINDING (2026-09-22, observed not assumed): insert leaves autoRescue ON, and the rescue path already normalises
// unicode, so the OLD shape ALSO matches this case and tags it fuzzyContent. The flag was ignored but the outcome
// was usually the same. The flag is only OBSERVABLE with rescue off, so that is where forwarding is proven.
check('5a OLD shape (rescue ON) already matches via the rescue path -- so fuzzyContent was never the functional bug', oldU.matched === true, desc(oldU));
check('5b NEW shape with fuzzyContent:true matches it', newU.matched === true, desc(newU));
check('5c ...and is tagged fuzzyContent', (newU.transforms || []).includes('fuzzyContent'), desc(newU));
const offOld = eng.matchContent(plain, usrc, usc, { fuzzyWhitespace: false, occurrence: undefined, autoRescue: false });
const offNew = eng.matchContent(plain, usrc, usc, { fuzzyWhitespace: false, fuzzyContent: true, occurrence: undefined, autoRescue: false });
check('5d rescue OFF, flag NOT forwarded: no match (the flag is what does the work)', offOld.matched === false, desc(offOld));
check('5e rescue OFF, fuzzyContent forwarded: matches -- proves the option reaches the matcher', offNew.matched === true && (offNew.transforms || []).includes('fuzzyContent'), desc(offNew));
// BOM: the OLD shape matched but under the WRONG label; the forwarded flag gives the right one.
const bom = ['\uFEFFconst y = 2;'];
const bsrc = { allLines: bom, text: bom.join('\n') };
const bsc = () => eng.resolveScope({ editor: null, buffer: null, allLines: bom, text: bom.join('\n'), filePath: 'b.js', params: { hintRadius: 25 } });
const bomOld = eng.matchContent('const y = 2;', bsrc, bsc(), { fuzzyWhitespace: false, occurrence: undefined });
const bomNew = eng.matchContent('const y = 2;', bsrc, bsc(), { fuzzyWhitespace: false, fuzzyContent: true, regex: false, occurrence: undefined });
check('5f BOM: OLD shape matches but is mislabelled fuzzyWhitespace', bomOld.matched === true && (bomOld.transforms || []).includes('fuzzyWhitespace'), desc(bomOld));
check('5g BOM: NEW shape labels it correctly as fuzzyContent', bomNew.matched === true && (bomNew.transforms || []).includes('fuzzyContent'), desc(bomNew));

// ---- 6. regression guards: the DEFAULT (no flags) behaviour is unchanged ---------------------------
m = run('const total = 1;', {}, 'new');
check('6a literal anchor still matches with no flags', m.matched === true && m.matchLine === 1, desc(m));
check('6b literal anchor carries no regex/fuzzyContent tag', !(m.transforms || []).includes('regex') && !(m.transforms || []).includes('fuzzyContent'), desc(m));
const o = run('const total = 1;', {}, 'old');
check('6c OLD and NEW shapes agree on a plain literal anchor (same row)', o.matched === m.matched && o.matchLine === m.matchLine, desc(o) + ' | ' + desc(m));
m = run('const total = \\d;', {}, 'new');
check('6d WITHOUT regex:true a regex-looking anchor stays literal (still not matched)', m.matched === false, desc(m));
m = run('zzz_absent();', { regex: true }, 'new');
check('6e a regex that matches nothing fails cleanly (matched:false, no throw)', m.matched === false, desc(m));

// ---- 7. an INVALID regex must fail safely rather than throw out of the tool ------------------------
let threw = null;
try { m = run('const total = (', { regex: true }, 'new'); } catch (e) { threw = e; }
check('7a an invalid regex does not throw out of the engine', threw === null, threw && String(threw.message));
check('7b an invalid regex reports matched:false', threw === null && m && m.matched === false, desc(m));

// ---- 8. THE HANDLER SOURCE ACTUALLY FORWARDS THE FLAGS (guards against a silent revert) ------------
const regSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
const handlerLine = regSrc.split('\n').find(l => l.includes("handler: async ({ afterLine, beforeLine, onLine, expectedContent, new_str"));
check('8a insert handler signature found', !!handlerLine);
check('8b insert handler destructures fuzzyContent', !!handlerLine && /\bfuzzyContent\s*=\s*false\b/.test(handlerLine));
check('8c insert handler destructures regex', !!handlerLine && /\bregex\s*=\s*false\b/.test(handlerLine));
const callLine = regSrc.split('\n').find(l => l.includes('const match = matchContentEngine(anchor, { allLines, text: ctx.text }, scope,'));
check('8d insert content-anchor engine call found', !!callLine);
check('8e that call forwards fuzzyContent AND regex AND occurrence',
  !!callLine && /fuzzyContent/.test(callLine) && /\bregex\b/.test(callLine) && /\boccurrence\b/.test(callLine), callLine && callLine.trim());
check('8f insert leaves autoRescue at its default (non-destructive caller)', !!callLine && !/autoRescue/.test(callLine), callLine && callLine.trim());

// ---- 9. NEGATIVE CONTROL: revert the fix in a copy of the source; the checks above MUST notice -----
// (split().join(), never String.replace -- a first-occurrence replace can hit a comment and never fail)
const REVERT_FROM = '{ fuzzyWhitespace, fuzzyContent, regex, occurrence });';
const REVERT_TO   = '{ fuzzyWhitespace, occurrence });';
const occurrences = regSrc.split('const match = matchContentEngine(anchor, { allLines, text: ctx.text }, scope, ' + REVERT_FROM).length - 1;
check('9a negative-control token occurs exactly once in the real source', occurrences === 1, 'occurrences=' + occurrences);
const reverted = regSrc.split('const match = matchContentEngine(anchor, { allLines, text: ctx.text }, scope, ' + REVERT_FROM)
  .join('const match = matchContentEngine(anchor, { allLines, text: ctx.text }, scope, ' + REVERT_TO);
check('9b the reverted copy really differs from the real source', reverted !== regSrc);
const revLine = reverted.split('\n').find(l => l.includes('const match = matchContentEngine(anchor, { allLines, text: ctx.text }, scope,'));
const wouldPass8e = /fuzzyContent/.test(revLine) && /\bregex\b/.test(revLine) && /\boccurrence\b/.test(revLine);
check('9c check 8e FAILS on the reverted copy (so it can actually fail)', wouldPass8e === false, revLine && revLine.trim());

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
