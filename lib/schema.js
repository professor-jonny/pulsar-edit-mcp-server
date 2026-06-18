'use babel';
const { z } = require('zod');

// ---------------------------------------------------------------------------
// Shared anchor schema fragments — spread into tool inputSchema to avoid
// repeating the same Zod definitions across insert, delete-block, str_replace.
// Usage:  inputSchema: { ...ANCHOR_SCHEMA, myOwnParam: z.string() }
const ANCHOR_SCHEMA = {
  // ── Target file ────────────────────────────────────────────────────────────
  // Provide this on all edit tools. The framework resolves the buffer by path
  // (finds an existing open tab, or opens one in the background with
  // activateItem:false) so the active tab is never used for writes.
  // Omitting filePath falls back to the active editor for read tools only.
  filePath: z.string().optional(),
  // ── Scope hints (constrain search to symbol body) ───────────────────────
  inFunction:      z.string().optional(),  // scope search to named function/method body
  // ── Directional hints (tree-sitter backed where possible, drift-immune) ──
  afterFunction:   z.string().optional(),  // window after function closing brace
  beforeFunction:  z.string().optional(),  // window before function opening line
  afterSymbol:     z.string().optional(),  // window after any named symbol closing
  beforeSymbol:    z.string().optional(),  // window before any named symbol opening
  afterString:     z.string().optional(),  // window after first line containing text
  beforeString:    z.string().optional(),  // window before first line containing text
  afterLine:       z.number().optional(),  // search window from line N downward (N to N+25) — use when target is below a known line
  beforeLine:      z.number().optional(),  // search window from line N upward (N-25 to N) — use when target is above a known line
  betweenHint:     z.object({ start: z.string(), end: z.string() }).optional(),
  // ── Match modifiers ──────────────────────────────────────────────────────
  hintRadius:      z.number().int().min(1).optional(),  // override default ±25 window for afterLine/beforeLine/afterString/afterFunction etc (default 25)
  occurrence:      z.number().int().min(1).optional(),
  fuzzyWhitespace: z.boolean().optional(),
  fuzzyContent:    z.boolean().optional(),
  regex:           z.boolean().optional(),
  dryRun:          z.boolean().optional(),
};

// Structural anchor params used by insert and delete-block.
// B15: ...ANCHOR_SCHEMA spread first so structural-only keys always win if names ever collide.
const STRUCTURAL_ANCHOR_SCHEMA = {
  ...ANCHOR_SCHEMA,
  afterContent:  z.string().optional(),
  beforeContent: z.string().optional(),
  functionEnd:   z.string().optional(),
  sectionHint:   z.string().optional(),
  preprocBlock:  z.string().optional(),
  preprocSide:   z.enum(["open", "close"]).optional(),
};

module.exports = { ANCHOR_SCHEMA, STRUCTURAL_ANCHOR_SCHEMA };
