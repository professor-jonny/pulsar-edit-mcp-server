'use strict';
// test/recover.test.js (2026-10-11)
// Pins lib/recover.js profiledMatch(needle, search, opts): the new opts.stripComment opt-out, and that
// everything else (default behaviour, whitespace rescue, unicode rescue) is unchanged.
// Written probe-first (TEMP\probe_recover.js printed the real outputs before any assertion was written).
// Run: node test/recover.test.js   (REC_PATH env points it at another copy, used by the mutation
// harness). Last line is '<N> passed, <M> failed'.
const path = require('path');
const mod = require(process.env.REC_PATH || path.join(__dirname, '..', 'lib', 'recover.js'));
const { profiledMatch } = mod;

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}
function block(name, fn) {
  try { fn(); } catch (e) { fail++; console.log('FAIL ' + name + ' threw: ' + (e && e.message)); }
}

const STRIPPED = {
  rebuiltNeedle: 'const a = 1;\nconst b = 2;',
  tags: { fuzzyWhitespace: true, fuzzyContent: false, autoStripComment: true },
  salvagedComment: '// two',
};
const WS_ONLY = {
  rebuiltNeedle: 'const a = 1;',
  tags: { fuzzyWhitespace: true, fuzzyContent: false, autoStripComment: false },
  salvagedComment: null,
};
const UNI_ONLY = {
  rebuiltNeedle: 'const s = "hi";',
  tags: { fuzzyWhitespace: false, fuzzyContent: true, autoStripComment: false },
  salvagedComment: null,
};

// ---- C: a comment the needle has and the buffer lacks -------------------------------------------
block('C', () => {
  const needle = 'const a = 1;\nconst b = 2; // two';
  const search = 'const a = 1;\nconst b = 2;';
  eq('C1 default strips the extra comment (unchanged behaviour)', profiledMatch(needle, search), STRIPPED);
  eq('C2 opts undefined is the default', profiledMatch(needle, search, undefined), STRIPPED);
  eq('C3 {} is the default', profiledMatch(needle, search, {}), STRIPPED);
  eq('C4 stripComment:true is the default', profiledMatch(needle, search, { stripComment: true }), STRIPPED);
  eq('C5 stripComment:false -> no rescue (caller fails and diagnoses)',
    profiledMatch(needle, search, { stripComment: false }), null);
  eq('C6 opts null is the default (guarded, does not throw)', profiledMatch(needle, search, null), STRIPPED);
});

// ---- W: whitespace plus an extra comment --------------------------------------------------------
block('W', () => {
  const needle = '  const a = 1;\n const b = 2; // two';
  const search = 'const a = 1;\nconst b = 2;';
  eq('W1 default rebuilds and strips', profiledMatch(needle, search), STRIPPED);
  eq('W2 stripComment:false -> null even though the whitespace alone would have been rescuable',
    profiledMatch(needle, search, { stripComment: false }), null);
});

// ---- U: the opt-out does not touch the other rescues ---------------------------------------------
block('U', () => {
  eq('U1 whitespace-only, default', profiledMatch('  const a = 1;', 'const a = 1;'), WS_ONLY);
  eq('U2 whitespace-only, stripComment:false unchanged',
    profiledMatch('  const a = 1;', 'const a = 1;', { stripComment: false }), WS_ONLY);
  eq('U3 unicode-only, default', profiledMatch('const s = \u201chi\u201d;', 'const s = "hi";'), UNI_ONLY);
  eq('U4 unicode-only, stripComment:false unchanged',
    profiledMatch('const s = \u201chi\u201d;', 'const s = "hi";', { stripComment: false }), UNI_ONLY);
});

// ---- N: shapes that never rescued, with or without the opt-out -----------------------------------
block('N', () => {
  for (const opts of [undefined, { stripComment: false }]) {
    const tag = opts ? 'false' : 'default';
    eq('N1 exact needle needs no transform (' + tag + ')', profiledMatch('const a = 1;', 'const a = 1;', opts), null);
    eq('N2 different comment is never rescued (' + tag + ')',
      profiledMatch('const a = 1; // other', 'const a = 1; // set a', opts), null);
    eq('N3 comment missing from the needle is never rescued (' + tag + ')',
      profiledMatch('const a = 1;', 'const a = 1; // set a', opts), null);
  }
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
