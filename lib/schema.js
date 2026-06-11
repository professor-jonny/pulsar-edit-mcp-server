'use babel';
const { z } = require('zod');

// ---------------------------------------------------------------------------
// Shared anchor schema fragments — spread into tool inputSchema to avoid
// repeating the same Zod definitions across insert, delete-block, str_replace.
// Usage:  inputSchema: { ...ANCHOR_SCHEMA, myOwnParam: z.string() }
const ANCHOR_SCHEMA = {
  // ── Scope hints (constrain search window) ───────────────────────────────
  inFunction:      z.string().optional(),  // scope search to named function body
  inSymbol:        z.string().optional(),  // scope search to any named symbol body
  // ── Directional hints (preferred — tree-sitter backed, drift-immune) ───
  afterFunction:   z.string().optional(),  // window after function closing brace
  beforeFunction:  z.string().optional(),  // window before function opening line
  afterSymbol:     z.string().optional(),  // window after any symbol closing
  beforeSymbol:    z.string().optional(),  // window before any symbol opening
  afterString:     z.string().optional(),  // window after first line containing text
  beforeString:    z.string().optional(),  // window before first line containing text
  // ── Legacy hints (kept for back-compat) ─────────────────────────────────
  functionHint:    z.string().optional(),  // alias: scope to named function body
  afterHint:       z.string().optional(),  // alias: afterString
  lineNumberHint:  z.number().optional(),  // positional (drifts — last resort)
  lineContentHint: z.string().optional(),  // content-stable positional
  afterLine:       z.number().optional(),  // window after line N
  beforeLine:      z.number().optional(),  // window before line N
  betweenHint:     z.object({ start: z.string(), end: z.string() }).optional(),
  // ── Match modifiers ──────────────────────────────────────────────────────
  occurrence:      z.number().int().min(1).optional(),
  fuzzyWhitespace: z.boolean().optional(),
  fuzzyContent:    z.boolean().optional(),
  regex:           z.boolean().optional(),
  dryRun:          z.boolean().optional(),
  lint:            z.boolean().optional(),
};

// Structural anchor params used by insert and delete-block
const STRUCTURAL_ANCHOR_SCHEMA = {
  afterContent:  z.string().optional(),
  beforeContent: z.string().optional(),
  functionEnd:   z.string().optional(),
  sectionHint:   z.string().optional(),
  preprocBlock:  z.string().optional(),
  preprocSide:   z.enum(["open", "close"]).optional(),
  ...ANCHOR_SCHEMA,
};

module.exports = { ANCHOR_SCHEMA, STRUCTURAL_ANCHOR_SCHEMA };
