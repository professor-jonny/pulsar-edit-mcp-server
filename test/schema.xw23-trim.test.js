// test/schema.xw23-trim.test.js - XW23 schema trims that change no behaviour.
//   1. REGEX_REMOVED_PARAM keeps working (optional boolean, so regex:true still reaches the central guard) but its
//      description is short: it is repeated in the schema of every edit tool.
//   2. delete's schema no longer advertises afterContent/beforeContent (insert-only; the delete handler never reads
//      them); insert still spreads the full STRUCTURAL_ANCHOR_SCHEMA.
const fs = require('fs');
const path = require('path');
const schema = require('../lib/schema');

let bad = 0, pass = 0;
function ok(name, cond) { if (cond) pass++; else { bad++; console.log('FAIL ' + name); } }

// 1. regex param
const p = schema.REGEX_REMOVED_PARAM;
const d = p.description;
ok('1 regex param has a description', typeof d === 'string' && d.length > 0);
ok('1 regex param description is short (< 80 chars)', typeof d === 'string' && d.length < 80);
ok('1 regex param description says refused and names sed', /refused/.test(d || '') && /sed/.test(d || ''));
ok('1 regex param still accepts true and undefined (so the central guard sees regex:true)', p.safeParse(true).success && p.safeParse(undefined).success);

// 2. delete vs insert schema source
const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
function toolSchemaSrc(name) {
  const m = new RegExp("name:\\s*'" + name + "',").exec(reg);
  if (!m) return null;
  const si = reg.indexOf('inputSchema:', m.index);
  const hi = reg.indexOf('handler:', si);
  return reg.slice(si, hi);
}
const del = toolSchemaSrc('delete');
const ins = toolSchemaSrc('insert');
ok('2 found the delete and insert schema source', del !== null && ins !== null && del.length > 100 && ins.length > 100);
// 2b. the shared SCOPE_ANCHOR_SCHEMA: every shared hint plus the structural anchors, minus the insert-only content anchors
const S = schema.SCOPE_ANCHOR_SCHEMA;
ok('2 SCOPE_ANCHOR_SCHEMA is exported', S !== null && typeof S === 'object');
const SHARED = ['inFunction', 'afterFunction', 'beforeFunction', 'afterSymbol', 'beforeSymbol', 'afterString', 'beforeString',
  'afterLine', 'beforeLine', 'betweenHint', 'hintRadius', 'occurrence', 'fuzzyWhitespace', 'fuzzyContent', 'regex', 'dryRun'];
ok('2 SCOPE_ANCHOR_SCHEMA has every shared hint and modifier', !!S && SHARED.every(k => k in S));
ok('2 SCOPE_ANCHOR_SCHEMA has the structural anchors banner, ifdefBlock and ifdefEdge', !!S && ['banner', 'ifdefBlock', 'ifdefEdge'].every(k => k in S));
ok('2 SCOPE_ANCHOR_SCHEMA leaves out the insert-only afterContent and beforeContent', !!S && !('afterContent' in S) && !('beforeContent' in S));
ok('2 STRUCTURAL_ANCHOR_SCHEMA still carries afterContent and beforeContent (insert)', 'afterContent' in schema.STRUCTURAL_ANCHOR_SCHEMA && 'beforeContent' in schema.STRUCTURAL_ANCHOR_SCHEMA);
ok('2 delete spreads SCOPE_ANCHOR_SCHEMA (rollout 2026-11-19: through withoutScopeHints, the hints are described by scope)', /withoutScopeHints\(SCOPE_ANCHOR_SCHEMA\)/.test(del));
ok('2 delete no longer spreads the full STRUCTURAL_ANCHOR_SCHEMA', !/\.\.\.STRUCTURAL_ANCHOR_SCHEMA\b/.test(del));
ok('2 insert spreads STRUCTURAL_ANCHOR_SCHEMA (XW23 step 2: through withoutScopeHints, the hints are described by scope)', /withoutScopeHints\(STRUCTURAL_ANCHOR_SCHEMA\)/.test(ins));
ok('2 negative control: the delete check fails when the spread is the full schema again', !(/withoutScopeHints\(SCOPE_ANCHOR_SCHEMA\)/.test(del.split('SCOPE_ANCHOR_SCHEMA').join('STRUCTURAL_ANCHOR_SCHEMA'))));

console.log(pass + ' passed, ' + bad + ' failed');
process.exitCode = bad ? 1 : 0;
