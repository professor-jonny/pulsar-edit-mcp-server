'use strict';
// XW23 idea 1, step 1 (2026-11-18): one optional `scope` object for the position hints.
// A tool that declares `scope: SCOPE_OBJECT_SCHEMA` shows one field instead of a dozen; the tool framework calls
// flattenScope(args) before any handler runs, so handlers keep reading the flat names (inFunction, afterString, ...).
// Only position hints go in scope. occurrence, fuzzy flags, fragment, dryRun, new_str and the like stay top-level.
// A top-level hint wins over the same key inside scope.
const { z } = require('zod');

const SCOPE_KEYS = [
  'inFunction', 'afterFunction', 'beforeFunction', 'afterSymbol', 'beforeSymbol',
  'afterString', 'beforeString', 'afterLine', 'beforeLine', 'betweenHint', 'hintRadius',
  'banner', 'ifdefBlock', 'ifdefEdge',
];

const SCOPE_STRICT_SCHEMA = z.object({
  inFunction:     z.string().optional(),
  afterFunction:  z.string().optional(),
  beforeFunction: z.string().optional(),
  afterSymbol:    z.string().optional(),
  beforeSymbol:   z.string().optional(),
  afterString:    z.string().optional(),
  beforeString:   z.string().optional(),
  afterLine:      z.number().optional(),
  beforeLine:     z.number().optional(),
  betweenHint:    z.object({ start: z.string(), end: z.string() }).optional(),
  hintRadius:     z.number().int().min(1).optional(),
  banner:         z.string().optional(),
  ifdefBlock:     z.string().optional(),
  ifdefEdge:      z.enum(['open', 'close']).optional(),
}).strict();

// What the tool list serves: a loose object with a short description. The typed schema above is no longer sent (14 listed
// properties cost more characters than the flat hints did); checkScope() applies it when a call arrives instead.
const SCOPE_OBJECT_SCHEMA = z.record(z.any()).optional().describe(
  "Position hints, e.g. {inFunction:'fn'}. Keys: inFunction afterFunction beforeFunction afterSymbol beforeSymbol afterString beforeString afterLine beforeLine hintRadius banner ifdefBlock ifdefEdge(open|close) betweenHint{start,end}"
);

// A problem with a call's scope object as a message, or null when it is fine (absent, null or valid).
function checkScope(args) {
  if (!args || typeof args !== 'object' || args.scope === undefined || args.scope === null) return null;
  const sc = args.scope;
  if (typeof sc !== 'object' || Array.isArray(sc)) {
    return "scope must be an object such as {inFunction:'fn'}, not " + (Array.isArray(sc) ? 'an array' : 'a ' + typeof sc) + '.';
  }
  const r = SCOPE_STRICT_SCHEMA.safeParse(sc);
  if (r.success) return null;
  const parts = r.error.issues.map((i) => i.code === 'unrecognized_keys'
    ? 'unknown key(s) ' + i.keys.join(', ')
    : (i.path.join('.') || 'scope') + ': ' + i.message);
  return 'scope: ' + parts.join('; ') + '. Keys: ' + SCOPE_KEYS.join(', ') + '.';
}


function flattenScope(args) {
  if (!args || typeof args !== 'object') return args;
  const sc = args.scope;
  if (sc === undefined) return args;
  const out = { ...args };
  delete out.scope;
  if (!sc || typeof sc !== 'object' || Array.isArray(sc)) return out;
  for (const k of SCOPE_KEYS) {
    if (sc[k] === undefined || sc[k] === null) continue;
    if (out[k] === undefined || out[k] === null) out[k] = sc[k];
  }
  return out;
}

// Step 2: a schema shape without the flat position hints (they are described by `scope` instead).
function withoutScopeHints(shape) {
  return Object.fromEntries(Object.entries(shape).filter(([k]) => !SCOPE_KEYS.includes(k)));
}

// A tool whose shape declares `scope` is registered as a PASSTHROUGH object: unknown top-level keys (the flat hints, which
// are no longer listed in the schema) reach flattenScope and the handler instead of being stripped silently.
function wrapScopeSchema(shape) {
  if (!shape || shape.scope !== SCOPE_OBJECT_SCHEMA) return shape;
  return z.object(shape).passthrough();
}

module.exports = { SCOPE_KEYS, SCOPE_OBJECT_SCHEMA, SCOPE_STRICT_SCHEMA, checkScope, flattenScope, withoutScopeHints, wrapScopeSchema };
