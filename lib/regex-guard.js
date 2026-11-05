'use strict';
// R2a (2026-10-28): regex is removed from every edit tool and every anchor.
// These are the ONLY tools that still take regex. sed has its own GNU regex dialect
// and no regex flag, so it is not in this list. Any other tool called with regex:true
// is refused by regexRefusal() before its handler, the framework retry stash or a
// dry run can run. Pure module, no I/O, so it is unit-tested directly
// (test/regex-guard.test.js) and wired in mcp-registration.js's registerTool wrapper.
//
// The schemas still ACCEPT a regex boolean (REGEX_REMOVED_PARAM in lib/schema.js) only so
// the value reaches this guard: zod would otherwise strip it silently and the pattern
// would be matched as a literal string.

const REGEX_KEEP = new Set(['find-text', 'grep-file', 'grep-project', 'search-functions']);
const READ_ONLY = new Set(['read']);

function regexRefusal(name, args) {
  if (!args || args.regex !== true || REGEX_KEEP.has(name)) return null;
  // read is the one read-only tool that shares the anchor schema, so it gets its own wording:
  // nothing could have been changed, and the useful pointer is grep-file plus a line range.
  const text = READ_ONLY.has(name)
    ? `? ${name}: regex:true is no longer supported on this tool. ` +
      `Find the line with grep-file or find-text (regex still works there), then pass startLine/endLine, ` +
      `or use a literal afterString / inFunction hint.`
    : `? ${name}: regex:true is no longer supported on this tool. Nothing was changed.\n` +
      `Use the sed tool for a regex edit (GNU sed syntax, e.g. expression "s/old\\(x\\)/new\\1/", extended:true for -E), ` +
      `or replace with fragment:true for a literal part-line edit. ` +
      `Regex still works on find-text, grep-file, grep-project and search-functions.`;
  return { content: [{ type: 'text', text }], isError: true };
}

module.exports = { REGEX_KEEP, regexRefusal };
