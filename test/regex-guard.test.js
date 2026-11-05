'use strict';
// R2a regex-removal guard test (2026-10-28).
// Pure unit tests for lib/regex-guard.js plus source-wiring checks, so a silent revert of the
// guard, the schema stub or the handler cleanup is caught. No Pulsar, no restart needed.
// Run from the package root:   node test/regex-guard.test.js
const fs = require('fs');
const path = require('path');
const { REGEX_KEEP, regexRefusal } = require('../lib/regex-guard');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (!cond && detail ? '\n       ' + detail : ''));
}

// ---- 1. which tools keep regex ------------------------------------------------------------------
check('1a REGEX_KEEP is exactly the four search tools',
  REGEX_KEEP.size === 4 && ['find-text', 'grep-file', 'grep-project', 'search-functions'].every(t => REGEX_KEEP.has(t)),
  JSON.stringify([...REGEX_KEEP]));
check('1b sed is NOT in REGEX_KEEP (it has no regex flag; its regex is the script)', !REGEX_KEEP.has('sed'));

// ---- 2. refusal for every edit tool and for read --------------------------------------------------
const EDIT_TOOLS = ['replace', 'str_replace', 'replace-all', 'replace-across-files', 'delete', 'insert',
  'replace-block', 'replace-function-body', 'read'];
for (const t of EDIT_TOOLS) {
  const r = regexRefusal(t, { regex: true, filePath: 'x.js' });
  const text = r && r.content && r.content[0] && r.content[0].text || '';
  check('2 ' + t + ': regex:true is refused', !!r && r.isError === true, JSON.stringify(r));
  if (t === 'read') {
    // read is read-only: it must not claim an edit was undone, and it points to grep-file plus a line range
    check('2 read: wording is read-specific (names the tool, no "Nothing was changed", points to grep-file and startLine/endLine)',
      text.includes('read:') && !/Nothing was changed/.test(text) && /grep-file/.test(text) && /startLine\/endLine/.test(text), text);
  } else {
    check('2 ' + t + ': message names the tool, says nothing was changed, points to sed and fragment:true',
      text.includes(t + ':') && /Nothing was changed/.test(text) && /\bsed\b/.test(text) && /fragment:true/.test(text), text);
  }
}

// ---- 3. everything that must still work -----------------------------------------------------------
for (const t of REGEX_KEEP) check('3 ' + t + ': regex:true passes through', regexRefusal(t, { regex: true, query: 'a.b' }) === null);
for (const t of EDIT_TOOLS) {
  check('3 ' + t + ': regex:false passes through', regexRefusal(t, { regex: false }) === null);
  check('3 ' + t + ': no regex key passes through', regexRefusal(t, { filePath: 'x.js' }) === null);
}
check('3x no args at all passes through', regexRefusal('replace', undefined) === null && regexRefusal('replace', null) === null);
check('3y only a real boolean true is refused (strings are the schema\'s job)', regexRefusal('replace', { regex: 'true' }) === null);

// ---- 4. the source is wired (guards against a silent revert) -------------------------------------
const root = path.join(__dirname, '..');
const reg = fs.readFileSync(path.join(root, 'lib', 'mcp-registration.js'), 'utf8');
const sch = fs.readFileSync(path.join(root, 'lib', 'schema.js'), 'utf8');
const lines = reg.split('\n');

check('4a mcp-registration requires regex-guard', /require\('\.\/regex-guard'\)/.test(reg));
const wrapAt = reg.indexOf('server.registerTool = (name, meta, handler) =>');
const guardAt = reg.indexOf('regexRefusal(name, args)', wrapAt);
const handlerAt = reg.indexOf('return await handler(args);', wrapAt);
check('4b the registerTool wrapper calls regexRefusal BEFORE the handler runs',
  wrapAt > 0 && guardAt > wrapAt && handlerAt > guardAt, `wrap=${wrapAt} guard=${guardAt} handler=${handlerAt}`);
check('4c schema.js exports REGEX_REMOVED_PARAM and ANCHOR_SCHEMA uses it for regex',
  /REGEX_REMOVED_PARAM/.test(sch) && /regex:\s+REGEX_REMOVED_PARAM/.test(sch) && /module\.exports[^\n]*REGEX_REMOVED_PARAM/.test(sch));
const stubLines = lines.filter(l => /^\s+regex:\s+REGEX_REMOVED_PARAM,/.test(l));
check('4d replace, read, replace-across-files and replace-all declare the removed stub (4 lines)', stubLines.length === 4, 'found ' + stubLines.length);

// every handler that still destructures regex must be one of the four search tools
const regexHandlers = lines.filter(l => /handler:\s*async\s*\(\{[^}]*\bregex\b/.test(l));
check('4e only the four search tools destructure regex in their handler', regexHandlers.length === 4, 'found ' + regexHandlers.length);
check('4f replace-across-files and replace-all no longer read a regex value',
  !/async handler\(\{ query, replacement, regex/.test(reg) && !/handler: async \(\{ query, replacement, regex/.test(reg));
check('4g no edit path builds a pattern from user regex any more', !/regex \? query : escapeRegex\(query\)/.test(reg));
check('4h the retired str_replace regexCommits counter is gone', !/'regexCommits'/.test(reg));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);