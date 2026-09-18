'use strict';

// ---------------------------------------------------------------------------
// struct-check.js — Structural integrity snapshot + delta for edit tools.
//
// snapshot(text) -> { braces, comments, ifdepth }
//   Counts open/close imbalances across the whole file text.
//   All counts are "how many are unclosed/unmatched" -- 0 is healthy.
//
// delta(before, after) -> string
//   Compares two snapshots. Returns a warning string for any metric that
//   got WORSE (non-zero and larger than before), empty string if clean.
//   Pre-existing imbalances that didn't change are NOT reported.
// ---------------------------------------------------------------------------

/**
 * Snapshot the structural balance of a text buffer.
 *
 * @param  {string} text  Full file contents as a string.
 * @returns {{ braces: number, comments: number, ifdepth: number }}
 *   braces   -- net unclosed braces: positive = too many {, negative = too many }
 *   comments -- number of unclosed block comments (/* without matching *\/)
 *   ifdepth  -- net unclosed preprocessor conditionals (#if/#ifdef/#ifndef minus #endif)
 */
function snapshot(text) {
	if (typeof text !== 'string') return { braces: 0, comments: 0, ifdepth: 0 };

	const lines = text.split('\n');

	let braces   = 0;
	let comments = 0;
	let inBlock  = false;
	let ifdepth  = 0;

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];

		// -- block comment tracking ------------------------------------------
		let j = 0;
		while (j < line.length) {
			if (inBlock) {
				const close = line.indexOf('*/', j);
				if (close === -1) {
					j = line.length;
				} else {
					inBlock = false;
					comments = Math.max(0, comments - 1);
					j = close + 2;
				}
			} else {
				const open = line.indexOf('/*', j);
				const lc   = line.indexOf('//', j);

				if (lc !== -1 && (open === -1 || lc < open)) {
					break;
				}
				if (open !== -1) {
					const close = line.indexOf('*/', open + 2);
					if (close !== -1) {
						j = close + 2;
					} else {
						inBlock = true;
						comments++;
						j = line.length;
					}
				} else {
					break;
				}
			}
		}

		// -- brace counting (skip content inside block comments) -------------
		if (!inBlock) {
			const stripped = stripLineComment(line);
			for (let k = 0; k < stripped.length; k++) {
				if (stripped[k] === '{') braces++;
				else if (stripped[k] === '}') braces--;
			}
		}

		// -- preprocessor conditional tracking --------------------------------
		const trimmed = line.trimStart();
		if (/^#\s*if(def|ndef)?\b/.test(trimmed)) {
			ifdepth++;
		} else if (/^#\s*endif\b/.test(trimmed)) {
			ifdepth--;
		}
	}

	return { braces, comments, ifdepth };
}

/**
 * Strip a C line comment (//) from a line without stripping // inside strings.
 * Simple heuristic: track single/double quote state.
 *
 * @param  {string} line
 * @returns {string}
 */
function stripLineComment(line) {
	let inStr  = false;
	let inChar = false;
	for (let i = 0; i < line.length; i++) {
		const c    = line[i];
		const prev = i > 0 ? line[i - 1] : '';
		if (c === '"'  && !inChar && prev !== '\\') inStr  = !inStr;
		if (c === '\'' && !inStr  && prev !== '\\') inChar = !inChar;
		if (!inStr && !inChar && c === '/' && line[i + 1] === '/') {
			return line.slice(0, i);
		}
	}
	return line;
}

/**
 * Compare pre- and post-edit snapshots and return a warning string for any
 * metric that got WORSE after the edit. Returns '' when everything is clean
 * or unchanged.
 *
 * "Worse" means:
 *   braces   -- absolute value increased (more imbalanced in either direction)
 *   comments -- count increased (new unclosed block comment opened)
 *   ifdepth  -- absolute value increased (more unclosed #if or extra #endif)
 *
 * Pre-existing imbalances that didn't change are silently ignored.
 *
 * @param  {{ braces: number, comments: number, ifdepth: number }} before
 * @param  {{ braces: number, comments: number, ifdepth: number }} after
 * @returns {string}  Warning text (leading \n included), or '' if clean.
 */
function delta(before, after) {
	const issues = [];

	if (Math.abs(after.braces) > Math.abs(before.braces)) {
		const dir = after.braces > 0 ? 'opening' : 'closing';
		issues.push('unmatched ' + dir + ' brace (net ' + (after.braces > 0 ? '+' : '') + after.braces + ' { })');
	}

	if (after.comments > before.comments) {
		const n = after.comments - before.comments;
		issues.push(n + ' unclosed block comment' + (n > 1 ? 's' : '') + ' (/* without */)');
	}

	if (Math.abs(after.ifdepth) > Math.abs(before.ifdepth)) {
		const dir = after.ifdepth > 0 ? 'unclosed #if' : 'extra #endif';
		issues.push(dir + ' (depth ' + (after.ifdepth > 0 ? '+' : '') + after.ifdepth + ')');
	}

	if (issues.length === 0) return '';
	return '\n\u26a0\ufe0f struct: ' + issues.join(' | ');
}

// B33-followup: shared file-type gate. edit-response.js's preEditSnapshot()
// has its own inline copy of this regex (pre-existing, left untouched to
// avoid touching a working call site) — this export exists so any NEW caller
// (tool-framework.js's ctx.commit() features.structCheck gating) has a single
// source of truth instead of a third copy drifting out of sync.
const STRUCT_EXTENSIONS = /\.(c|h|cpp|hpp|cc|cxx|js|ts|jsx|tsx|css|scss|java|cs|go|rs|swift)$/i;

/**
 * Whether struct-check's brace/comment/ifdepth balance tracking is meaningful
 * for this file type. A .txt file, for instance, has no brace-balance
 * requirement at all — running the check there is not just wasted work, it
 * risks a false-positive warning if the file happens to contain a stray '{'
 * in prose that was never meant to be code.
 * @param {string|null|undefined} filePath
 * @returns {boolean}
 */
function isStructFileType(filePath) {
  return !!filePath && STRUCT_EXTENSIONS.test(filePath);
}

module.exports = { snapshot, delta, isStructFileType };
