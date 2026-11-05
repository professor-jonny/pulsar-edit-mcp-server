// test/replace-block-function-body.uniform-hints.test.js - XW23 uniform hints (2026-11-18).
// replace-block and replace-function-body now take the same scope hints as the other edit tools:
//   banner, ifdefBlock, ifdefEdge (both), fuzzyContent (replace-block only: replace-function-body matches an exact symbol
//   name, so unicode-tolerant matching is meaningless there and the schema no longer advertises it).
// Source checks (the handlers need a live editor): schema, destructure, resolveScope params, hint counters, failure-log hints.
const fs = require('fs');
const path = require('path');
const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');

let bad = 0, pass = 0;
function ok(name, cond) { if (cond) pass++; else { bad++; console.log('FAIL ' + name); } }

function parts(name) {
  const m = new RegExp("name:\\s*'" + name + "',").exec(reg);
  if (!m) return null;
  const si = reg.indexOf('inputSchema:', m.index);
  const hi = reg.indexOf('handler: async ({', si);
  const hOpen = reg.indexOf('({', hi) + 1;
  const hClose = reg.indexOf('}, ctx) =>', hOpen);
  const next = reg.indexOf('registerMcpTool({', hClose);
  return { schema: reg.slice(si, hi), head: reg.slice(hOpen, hClose), body: reg.slice(hClose, next < 0 ? reg.length : next) };
}
const STRUCT = ['banner', 'ifdefBlock', 'ifdefEdge'];
const hasAll = (text, names) => names.every(n => new RegExp('\\b' + n + '\\b').test(text));
const paramsHas = (body, n) => new RegExp('resolveScope\\(\\{[\\s\\S]*?params:\\s*\\{[^}]*\\b' + n + '\\b[^}]*\\}').test(body);
const faultHas = (body, n) => new RegExp('_faultHints\\s*=\\s*\\{[^}]*\\b' + n + '\\b').test(body);

for (const tool of ['replace-function-body']) { // replace-block was removed 2026-11-19
  const p = parts(tool);
  ok(tool + ': found the registration', !!p && p.schema.length > 20 && p.head.length > 20 && p.body.length > 200);
  if (!p) continue;
  ok(tool + ': schema spreads the shared scope schema', /SCOPE_ANCHOR_SCHEMA/.test(p.schema));
  ok(tool + ': schema no longer spreads the bare ANCHOR_SCHEMA', !/\.\.\.ANCHOR_SCHEMA\b/.test(p.schema));
  ok(tool + ': handler destructures banner, ifdefBlock, ifdefEdge', hasAll(p.head, STRUCT));
  for (const n of STRUCT) {
    ok(tool + ': resolveScope params carry ' + n, paramsHas(p.body, n));
    ok(tool + ': counts hintsUsed.' + n, p.body.includes("'hintsUsed." + n + "'"));
    ok(tool + ': failure log hints carry ' + n, faultHas(p.body, n));
  }
  // negative control: the same predicates must fail on a copy with banner removed
  ok(tool + ': negative control (params check fails without banner)', !paramsHas(p.body.split('banner').join('bnr'), 'banner'));
}

const fb = parts('replace-function-body');
if (fb) {
  ok('replace-function-body: schema leaves fuzzyContent out (exact symbol names; nothing to normalise)', /k !== 'fuzzyContent'/.test(fb.schema));
  ok('replace-function-body: handler does not destructure fuzzyContent', !/\bfuzzyContent\b/.test(fb.head));
}

console.log(pass + ' passed, ' + bad + ' failed');
process.exitCode = bad ? 1 : 0;
