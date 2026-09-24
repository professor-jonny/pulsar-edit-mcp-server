'use babel';
const { z } = require('zod');

// ---------------------------------------------------------------------------
// FILE_SCHEMA — the one universal fragment every tool that touches a file
// should spread in, whether it edits, reads, greps, or audits it.
// Usage:  inputSchema: { ...FILE_SCHEMA, myOwnParam: z.string() }
//
// REQUIRED on every tool that spreads this. Always pass the path to the file
// you mean to act on — there is no "active editor" fallback and no need to
// call open-file first. The framework resolves the buffer by path: if the
// file is already open in a tab, the operation happens live in that tab
// (visible on screen); if it isn't open, it's done directly via
// bufferForPath — no tab created, but full undo/redo + save() support either
// way. Either path is identical from the caller's side.
const FILE_SCHEMA = {
  filePath: z.string(),
};

// ---------------------------------------------------------------------------
// Shared anchor schema fragments — spread into tool inputSchema to avoid
// repeating the same Zod definitions across insert, delete, str_replace.
// Usage:  inputSchema: { ...ANCHOR_SCHEMA, myOwnParam: z.string() }
const ANCHOR_SCHEMA = {
  ...FILE_SCHEMA,
  // ── Scope hints (constrain search to symbol body) ───────────────────────
  inFunction:      z.string().optional(),  // scope search to named function/method body
  // ── Directional hints (tree-sitter backed where possible, drift-immune) ──
  afterFunction:   z.string().optional(),  // window after function closing brace
  beforeFunction:  z.string().optional(),  // window before function opening line
  afterSymbol:     z.string().optional(),  // window after any named symbol closing
  beforeSymbol:    z.string().optional(),  // window before any named symbol opening
  afterString:     z.string().optional(),  // window after first line containing text. PREFER a single unique line -- most reliable. Multi-line text (joined with \n) is supported as a consecutive-line block match (exact, then trim-fuzzy) but is more fragile since every line must align; use only when no single line is unique enough.
  beforeString:    z.string().optional(),  // window before first line containing text. Same single-line-preferred guidance as afterString.
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

// Structural anchor params used by insert and delete.
// B15: ...ANCHOR_SCHEMA spread first so structural-only keys always win if names ever collide.
const STRUCTURAL_ANCHOR_SCHEMA = {
  ...ANCHOR_SCHEMA,
  afterContent:  z.string().optional(),
  beforeContent: z.string().optional(),
  sectionHint:   z.string().optional(),
  preprocBlock:  z.string().optional(),
  preprocSide:   z.enum(["open", "close"]).optional(),
};

module.exports = { FILE_SCHEMA, ANCHOR_SCHEMA, STRUCTURAL_ANCHOR_SCHEMA };
