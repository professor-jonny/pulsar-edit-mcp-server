'use strict';
// Test (2026-11-17): get-edit-stats returns a COMPACT report by default.
// Run from the package root:   node test/get-edit-stats.compact.test.js      Plain node, no Pulsar, no files written.
//
// Why: the old handler returned every tool's counters for session AND lifetime (91% of the values were zero, about 13,000 tokens
// per call), pretty-printed, and returned the report twice (once as text, once spread into the result object).
//
// Pinned:
//   1. Schema: reset (unchanged) plus scope ('session' | 'lifetime' | 'both'), tool (string) and full (boolean).
//   2. Handler: default scope is session; one compact text result, no pretty-print, no spread of the full report; reset still works.
//   3. shapeStatsReport() (pure, lib/edit-stats.js): default session only; zero tool blocks and zero counters pruned; active tools keep
//      their pct and non-zero counters; summaries and group totals kept; scope lifetime / both; tool filter (hyphen or underscore name,
//      unknown name lists the active tools); full:true keeps everything.
//   4. A fresh (all-zero) real report shrinks to under 10% of its old size.
//   5. The tool description and the catalogue entry describe the new parameters.

const fs = require('fs');
const path = require('path');

let bad = 0, pass = 0;
function ok(label, cond, detail) {
  if (cond) pass++; else bad++;
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond && detail !== undefined) console.log('      ' + detail);
}
const root = path.join(__dirname, '..');
const reg = fs.readFileSync(path.join(root, 'lib', 'mcp-registration.js'), 'utf8');
function seg(src, a, b) { const s = src.indexOf(a); if (s === -1) return null; const e = src.indexOf(b, s); return e === -1 ? null : src.slice(s, e); }

// 1 + 2 + 5 : the registered tool ---------------------------------------------------------------------------------------
const tool = seg(reg, 'name: "get-edit-stats",', '// -- session-notes');
ok('found the get-edit-stats registration', tool !== null);
if (tool) {
  const schema = seg(tool, 'inputSchema:', 'async handler');
  ok('1 schema keeps reset', !!schema && /reset:\s*z\.boolean\(\)\.optional\(\)/.test(schema));
  ok("1 schema has scope: z.enum(['session','lifetime','both'])", !!schema && /scope:\s*z\.enum\(\[\s*["']session["'],\s*["']lifetime["'],\s*["']both["']\s*\]\)\.optional\(\)/.test(schema));
  ok('1 schema has tool: z.string().optional()', !!schema && /tool:\s*z\.string\(\)\.optional\(\)/.test(schema));
  ok('1 schema has full: z.boolean().optional()', !!schema && /full:\s*z\.boolean\(\)\.optional\(\)/.test(schema));
  ok("2 the handler defaults scope to 'session'", /async handler\(\{[^}]*scope\s*=\s*["']session["']/.test(tool));
  ok('2 the handler shapes the report with shapeStatsReport', /shapeStatsReport\(/.test(tool));
  ok('2 the text result is compact JSON (no indent argument)', /JSON\.stringify\(shaped\)/.test(tool) && !/JSON\.stringify\(report,\s*null,\s*2\)/.test(tool));
  ok('2 the full report is no longer spread into the result (it was returned twice)', !/\.\.\.report\b/.test(tool));
  ok('2 reset still zeroes the session and appends the history line', /if \(reset\) \{/.test(tool) && /appendSessionHistory\(/.test(tool) && /flushLifetimeStats\(\)/.test(tool));
  const desc = seg(tool, 'description:', 'inputSchema:');
  ok('5 the description names scope, tool and full', !!desc && /scope/.test(desc) && /\btool\b/.test(desc) && /full/.test(desc));
  ok("5 the description says the default is the session and zeros are left out", !!desc && /default/i.test(desc) && /zero/i.test(desc));
  ok('5 the description no longer opens by promising both session AND lifetime (found stale in the live probe 2026-11-17)', !!desc && !/for this session AND lifetime totals/.test(desc));
}
const { TOOL_CATALOGUE } = require(path.join(root, 'lib', 'tool-catalogue.js'));
const cat = TOOL_CATALOGUE.find(t => t.name === 'get-edit-stats');
ok('5 the catalogue entry mentions scope and full', !!cat && /scope/.test(cat.desc) && /full/.test(cat.desc), cat && cat.desc.slice(0, 160));

// 3 : the pure shaper ----------------------------------------------------------------------------------------------------
const es = require(path.join(root, 'lib', 'edit-stats.js'));
ok('3 edit-stats exports shapeStatsReport', typeof es.shapeStatsReport === 'function');
if (typeof es.shapeStatsReport === 'function') {
  const shape = es.shapeStatsReport;
  const fake = () => ({
    session: {
      sessionEditSummary: '5 hits, 1 faults',
      _editGroup: { hits: 5, faults: 1, misses: 0, total: 6, pct: 83 },
      replace: { hits: 5, failTotal: 1, pct: 83, fails: { noMatch: 1, whitespace: 0 }, hintsUsed: { afterString: 2, inFunction: 0 }, dryRuns: 0, fragmentCommits: 3 },
      delete: { hits: 0, failTotal: 0, pct: 100, fails: { noMatch: 0 }, hintsUsed: { matchString: 0 }, dryRuns: 0 },
      replace_block: { hits: 0, failTotal: 2, pct: 0, fails: { startNotFound: 2, endNotFound: 0 } },
      sed: { hits: 0, failTotal: 0, pct: 100 },
    },
    lifetime: {
      lifetimeEditSummary: '100 hits, 9 faults',
      lifetimeSessionCount: 0,
      replace: { hits: 100, failTotal: 9, pct: 92, fails: { noMatch: 9 } },
      sed: { hits: 0, failTotal: 0, pct: 100 },
    },
  });
  const s1 = shape(fake(), {});
  ok("3 default is the session only (no 'lifetime' key)", s1.session && !('lifetime' in s1), Object.keys(s1).join(','));
  ok("3 the result says which scope it is", s1.scope === 'session', String(s1.scope));
  ok('3 zero tool blocks are dropped (delete, sed)', !('delete' in s1.session) && !('sed' in s1.session), Object.keys(s1.session).join(','));
  ok('3 an active tool is kept with its hits and pct', s1.session.replace && s1.session.replace.hits === 5 && s1.session.replace.pct === 83);
  ok('3 zero counters inside an active tool are dropped', s1.session.replace && !('whitespace' in s1.session.replace.fails) && !('inFunction' in s1.session.replace.hintsUsed) && !('dryRuns' in s1.session.replace), JSON.stringify(s1.session.replace));
  ok('3 non-zero counters inside an active tool are kept', s1.session.replace.fails.noMatch === 1 && s1.session.replace.hintsUsed.afterString === 2 && s1.session.replace.fragmentCommits === 3);
  ok('3 a tool with only failures keeps pct 0 (0% is information)', s1.session.replace_block && s1.session.replace_block.pct === 0 && s1.session.replace_block.fails.startNotFound === 2, JSON.stringify(s1.session.replace_block));
  ok('3 summaries and group totals are kept', s1.session.sessionEditSummary === '5 hits, 1 faults' && s1.session._editGroup && s1.session._editGroup.total === 6);
  ok('3 the result tells how to get more (scope / tool / full)', typeof s1.more === 'string' && /scope/.test(s1.more) && /tool/.test(s1.more) && /full/.test(s1.more));

  const sl = shape(fake(), { scope: 'lifetime' });
  ok("3 scope 'lifetime' returns only the lifetime side", sl.lifetime && !('session' in sl) && sl.scope === 'lifetime' && sl.lifetime.replace.hits === 100);
  const sb = shape(fake(), { scope: 'both' });
  ok("3 scope 'both' returns both sides", sb.session && sb.lifetime && sb.scope === 'both');

  const st = shape(fake(), { scope: 'both', tool: 'replace-block' });
  ok('3 tool filter accepts the hyphen name and returns only that block per side', st.session && st.session.replace_block && !('replace' in st.session) && st.tool === 'replace_block', JSON.stringify(st).slice(0, 200));
  const stu = shape(fake(), { tool: 'replace' });
  ok('3 tool filter with the default scope returns just the session block', stu.session.replace && Object.keys(stu.session).filter(k => !k.startsWith('_') && !/Summary$/.test(k)).length === 1, Object.keys(stu.session).join(','));
  const sz = shape(fake(), { tool: 'sed' });
  ok('3 tool filter on an idle tool still returns its (zero) block, since it was asked for by name', sz.session && sz.session.sed && sz.session.sed.hits === 0, JSON.stringify(sz));
  const sx = shape(fake(), { tool: 'no_such_tool' });
  ok('3 an unknown tool name is an error that lists the active tools', typeof sx.error === 'string' && Array.isArray(sx.activeTools) && sx.activeTools.includes('replace'), JSON.stringify(sx));

  const sf = shape(fake(), { full: true, scope: 'both' });
  ok('3 full:true keeps every zero counter and every zero tool block', sf.session.delete && sf.session.sed && sf.session.replace.fails.whitespace === 0 && sf.lifetime.lifetimeSessionCount === 0);
  const sfj = JSON.stringify(sf);
  ok('3 full:true carries no pruning at all (same content as the input)', JSON.stringify(sf.session) === JSON.stringify(fake().session), sfj.slice(0, 80));

  // 4 : size regression on a real, fresh (all-zero) report
  if (typeof es.buildReport === 'function' && es.editStats && es.lifetimeStats) {
    const full = { session: es.buildReport(es.editStats, 'session'), lifetime: es.buildReport(es.lifetimeStats, 'lifetime') };
    const oldSize = JSON.stringify(full, null, 2).length * 2; // the old handler returned the report twice
    const newSize = JSON.stringify(shape(full, {})).length;
    ok('4 a fresh report shrinks to under 10% of the old size (' + newSize + ' vs ' + oldSize + ' chars)', newSize < oldSize * 0.10, newSize + ' / ' + oldSize);
    const both = JSON.stringify(shape(full, { scope: 'both' })).length;
    ok('4 even scope both is under 15% of the old size (' + both + ' chars)', both < oldSize * 0.15, String(both));
  } else ok('4 buildReport / editStats / lifetimeStats are exported', false);
}

console.log(pass + ' passed, ' + bad + ' failed');
process.exitCode = bad ? 1 : 0;
