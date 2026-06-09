'use strict';
// ---------------------------------------------------------------------------
// naming-checker.js — Linux kernel naming convention and kernel-doc checks.
//
// API:
//   checkNaming(text, filePath)    → { violations: [{line, col, type, message}], totalViolations }
//   checkFunctionDocs(text, filePath?, headerText?)
//                                  → { missing: [{name, line, signature, inHeader}],
//                                       wrongStyle: [{name, line, signature, inHeader, found}],
//                                       plainDoc:   [{name, line, signature, inHeader}] }
//   buildDocSkeleton(fnSignature)  → string  (kernel-doc /** */ skeleton)
//   isKernelFile(filePath)         → re-exported from style-checker
//   formatNamingViolations(v)      → compact inline string | null
//
// SCOPE: kernel C only (.c / .h). All functions gate on isKernelFile().
//
// NAMING RULES (from kernel coding-style + driver conventions):
//   fn_no_verb      — no recognised verb anywhere in the function name
//                     (checked across all _-separated segments, so hal_wifi_scan
//                      passes because 'scan' is a verb segment)
//   fn_camel_case   — function name uses camelCase
//   var_camel_case  — local variable uses camelCase
//   macro_lowercase — #define macro name is not ALL_CAPS
//
// DOC RULES (from https://docs.kernel.org/doc-guide/kernel-doc.html):
//   The official kernel-doc format uses /** (double-star opener) with:
//     * function_name() - Brief description.
//     * @arg: description
//     * Return: description
//   Plain /* */ won't be extracted by the kernel-doc tool — it is not a style
//   error, but exported (EXPORT_SYMBOL) and public non-static functions SHOULD
//   have /** kernel-doc so the documentation toolchain can pick them up.
//
//   missing_doc     — non-static function has no comment above it at all
//   wrong_doc_style — has a // comment above it (wrong — must be block comment)
//   plain_doc       — has plain /* */ instead of /** kernel-doc (warn, not error)
// ---------------------------------------------------------------------------
const { isKernelFile } = require('./style-checker');
const { getSymbolsFromText } = require('./tree-sitter-symbols');

// ---------------------------------------------------------------------------
// Verb segments — a function name is valid if ANY underscore-separated segment
// matches a verb. This handles subsystem-prefixed names correctly:
//   hal_wifi_scan   → segments: hal, wifi, scan  → 'scan' is a verb ✓
//   hal_init        → segments: hal, init         → 'init' is a verb ✓
//   hal_data        → segments: hal, data         → no verb ✗
// ---------------------------------------------------------------------------
const VERB_SEGMENTS = new Set([
	/* lifecycle */
	'init', 'exit', 'create', 'destroy', 'alloc', 'free', 'open', 'close',
	'start', 'stop', 'run', 'probe', 'remove', 'resume', 'suspend',
	'register', 'unregister', 'enable', 'disable',
	/* data ops */
	'get', 'set', 'read', 'write', 'send', 'recv', 'receive',
	'load', 'store', 'save', 'restore', 'fetch', 'push', 'pop',
	'copy', 'move', 'map', 'unmap', 'remap', 'translate',
	/* processing */
	'handle', 'process', 'parse', 'build', 'update', 'reset', 'flush',
	'prepare', 'setup', 'teardown', 'cleanup', 'configure', 'config',
	'request', 'release', 'submit', 'complete', 'cancel', 'abort',
	/* search / check */
	'find', 'search', 'match', 'lookup', 'scan',
	'check', 'verify', 'validate', 'test',
	'is', 'has', 'can', 'should', 'needs',
	/* output */
	'show', 'print', 'dump', 'log', 'trace', 'report',
	/* lock */
	'lock', 'unlock', 'wait', 'notify', 'signal', 'wakeup',
	/* misc */
	'do', 'apply', 'execute', 'trigger', 'raise', 'clear', 'mark',
	'add', 'remove', 'insert', 'delete', 'attach', 'detach',
	'encode', 'decode', 'encrypt', 'decrypt', 'compress', 'decompress',
	'connect', 'disconnect', 'bind', 'unbind',
	'format', 'convert', 'resize', 'realloc',
]);

/* camelCase detector */
const CAMEL_RE = /[a-z][A-Z]/;

/* Local variable declaration inside a function body */
const VAR_DECL_RE = /^\t+(?:(?:unsigned|signed|long|short|const|volatile|struct|enum|union)\s+)*\w+\s+\*?(\w+)\s*(?:=|;)/;

/* #define MACRO_NAME */
const MACRO_RE = /^#define\s+([A-Za-z_]\w*)/;

/* Common kernel exemptions — not subject to verb-tier check */
const EXEMPT_FN_RE = /^(main|module_init|module_exit|MODULE_|EXPORT_|__init|__exit|__setup|subsys_initcall|late_initcall|device_initcall)/;

// ---------------------------------------------------------------------------
// hasVerbSegment(name)
// Returns true if any underscore-separated segment of name is a known verb.
// ---------------------------------------------------------------------------
function hasVerbSegment(name) {
	const segments = name.split('_').filter(s => s.length > 0);
	return segments.some(s => VERB_SEGMENTS.has(s.toLowerCase()));
}

// ---------------------------------------------------------------------------
// checkNaming(text, filePath)
// ---------------------------------------------------------------------------
function checkNaming(text, filePath) {
	if (!isKernelFile(filePath) || !text) {
		return { violations: [], totalViolations: 0 };
	}

	const violations = [];
	const lines = text.split('\n');
	let inBlockComment = false;
	let braceDepth = 0;

	// Build a Set of function definition line numbers (0-based) from tree-sitter
	// so the inner loop can do a fast O(1) lookup instead of re-running a regex.
	const fnSymbols = getSymbolsFromText(text, filePath);
	const fnByRow = new Map(); // 0-based startRow → symbol
	for (const sym of fnSymbols) {
		fnByRow.set(sym.startRow, sym);
	}

	for (let i = 0; i < lines.length; i++) {
		const lineNum = i + 1;
		const raw = lines[i];
		const trimmed = raw.trimStart();

		/* skip block comment contents */
		if (inBlockComment) {
			if (raw.includes('*/')) inBlockComment = false;
			continue;
		}
		if (trimmed.startsWith('/*')) {
			if (!raw.includes('*/')) inBlockComment = true;
			continue;
		}
		if (trimmed.startsWith('//')) continue;

		/* track brace depth */
		for (const ch of raw) {
			if (ch === '{') braceDepth++;
			if (ch === '}') braceDepth--;
		}
		const inFunctionBody = braceDepth >= 1;

		/* ------------------------------------------------------------------ */
		/* #define macro naming                                                */
		/* ------------------------------------------------------------------ */
		if (trimmed.startsWith('#define')) {
			const m = raw.match(MACRO_RE);
			if (m) {
				const name = m[1];
				/* skip include guards, short names, known lowercase helpers */
				if (name.length > 1 && name !== name.toUpperCase() &&
					!/^(min|max|likely|unlikely|ARRAY_SIZE|container_of|offsetof|sizeof)$/.test(name)) {
					violations.push({
						line: lineNum, col: raw.indexOf(name) + 1,
						type: 'macro_lowercase',
						message: `Macro '${name}' should be ALL_CAPS`,
					});
				}
			}
			continue;
		}

		/* ------------------------------------------------------------------ */
		/* Function definition naming — file scope only (braceDepth == 0)     */
		/* ------------------------------------------------------------------ */
		if (!inFunctionBody && trimmed.includes('(')) {
			const sym = fnByRow.get(i);
			if (sym) {
				const name = sym.name;
				if (!EXEMPT_FN_RE.test(name) && name.length > 2) {
					/* camelCase check */
					if (CAMEL_RE.test(name)) {
						violations.push({
							line: lineNum, col: raw.indexOf(name) + 1,
							type: 'fn_camel_case',
							message: `Function '${name}' uses camelCase — kernel style requires snake_case`,
						});
					} else {
						/* verb segment check — skip static and __-prefixed */
						const isStatic = /\bstatic\b/.test(raw);
						const hasPrefix = name.startsWith('_');
						if (!isStatic && !hasPrefix && !hasVerbSegment(name)) {
							violations.push({
								line: lineNum, col: raw.indexOf(name) + 1,
								type: 'fn_no_verb',
								message: `Function '${name}' contains no verb segment (init/get/set/scan/handle/…)`,
							});
						}
					}
				}
			}
		}

		/* ------------------------------------------------------------------ */
		/* Local variable camelCase                                           */
		/* ------------------------------------------------------------------ */
		if (inFunctionBody) {
			const m = raw.match(VAR_DECL_RE);
			if (m) {
				const name = m[1];
				if (CAMEL_RE.test(name)) {
					violations.push({
						line: lineNum, col: raw.indexOf(name) + 1,
						type: 'var_camel_case',
						message: `Variable '${name}' uses camelCase — kernel style requires snake_case`,
					});
				}
			}
		}
	}

	return { violations, totalViolations: violations.length };
}

// ---------------------------------------------------------------------------
// checkFunctionDocs(text)
//
// Kernel-doc rules (docs.kernel.org/doc-guide/kernel-doc.html):
//   CORRECT:   /** opener  — kernel-doc format, required for exported/public fns
//   ACCEPTABLE: /* opener  — plain block comment, ok for private notes
//   WRONG:     // comment  — never acceptable above a function definition
//   MISSING:   no comment at all
//
// Returns (each entry includes name, line, signature, inHeader):
//   missing    [{name, line, signature, inHeader}]        — no comment at all
//   wrongStyle [{name, line, signature, inHeader, found}] — // comment above fn
//   plainDoc   [{name, line, signature, inHeader}]        — /* instead of /** (advisory)
// ---------------------------------------------------------------------------
function checkFunctionDocs(text, filePath, headerText) {
	if (!text) return { missing: [], wrongStyle: [], plainDoc: [] };

	// Build a set of function names declared in the corresponding header
	const headerNames = new Set();
	if (headerText) {
		const headerSyms = getSymbolsFromText(headerText, filePath);
		for (const sym of headerSyms) {
			if (sym.name && sym.name.length > 2) headerNames.add(sym.name);
		}
	}

	const missing = [];
	const wrongStyle = [];
	const plainDoc = [];
	const lines = text.split('\n');
	let inBlockComment = false;

	// Pre-compute function definition lines via tree-sitter (0-based startRow → symbol)
	const fnSymbols = getSymbolsFromText(text, filePath);
	const fnByRow = new Map();
	for (const sym of fnSymbols) {
		fnByRow.set(sym.startRow, sym);
	}

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const trimmed = raw.trimStart();

		if (inBlockComment) {
			if (raw.includes('*/')) inBlockComment = false;
			continue;
		}
		if (trimmed.startsWith('/*')) {
			if (!raw.includes('*/')) inBlockComment = true;
			continue;
		}
		if (trimmed.startsWith('//') || trimmed.startsWith('#')) continue;

		const sym = fnByRow.get(i);
		if (!sym) continue;
		if (/\bstatic\b/.test(raw)) continue;

		const name = sym.name;
		if (name.length <= 2) continue;

		const signature = raw.trimEnd();
		const inHeader  = headerNames.has(name);

		/* scan upward past blank lines */
		let prevIdx = i - 1;
		while (prevIdx >= 0 && lines[prevIdx].trim() === '') prevIdx--;

		if (prevIdx < 0) {
			missing.push({ name, line: i + 1, signature, inHeader });
			continue;
		}

		const prevLine = lines[prevIdx].trimStart();

		// ends with '*/' — some kind of block comment above
		if (prevLine.endsWith('*/') || prevLine === '*/') {
			/* find the opener */
			let scanIdx = prevIdx;
			while (scanIdx >= 0 && !lines[scanIdx].includes('/*')) scanIdx--;

			if (scanIdx >= 0) {
				const opener = lines[scanIdx].trimStart();
				if (opener.startsWith('/**')) {
					/* correct kernel-doc — all good */
					continue;
				} else {
					// Check if the comment is a section banner: /* ---- Name ---- */ or /* === Name === */
					// Single-line banners are organisational dividers, not function docs — treat as missing.
					const isBanner = /^\/\*\s*[-=]{3,}/.test(opener) && opener.includes('*/');
					if (isBanner) {
						missing.push({ name, line: i + 1, signature, inHeader });
					} else {
						// plain /* */ — acceptable but advisory
						plainDoc.push({ name, line: i + 1, signature, inHeader });
					}
					continue;
				}
			}
			continue;
		}

		/* // comment above — wrong style */
		if (prevLine.startsWith('//')) {
			wrongStyle.push({ name, line: i + 1, signature, inHeader, found: 'single_line_comment' });
			continue;
		}

		/* anything else — no doc */
		missing.push({ name, line: i + 1, signature, inHeader });
	}

	return { missing, wrongStyle, plainDoc };
}


// ---------------------------------------------------------------------------
// buildDocSkeleton(fnSignature)
// Generates a kernel-doc /** */ skeleton per docs.kernel.org format:
//   /**
//    * function_name() - Brief description.
//    * @arg1: Description.
//    * @...: Description.   (variadic — @... is the kernel-doc convention)
//    *
//    * Context: Any context.
//    * Return: Description.
//    */
// ---------------------------------------------------------------------------
function buildDocSkeleton(fnSignature) {
	if (!fnSignature) return '/**\n * TODO: document this function\n */\n';

	const nameMatch = fnSignature.match(/(\w+)\s*\(/);
	const fnName = nameMatch ? nameMatch[1] : 'function';

	const paramMatch = fnSignature.match(/\(([^)]*)\)/);
	const paramStr = paramMatch ? paramMatch[1].trim() : '';

	const params = [];
	if (paramStr && paramStr !== 'void' && paramStr !== '') {
		for (const part of paramStr.split(',')) {
			const trimPart = part.trim();
			/* variadic — kernel-doc uses @...: */
			if (trimPart === '...') {
				params.push('...');
				continue;
			}
			const words = trimPart.replace(/\*+/g, ' ').trim().split(/\s+/);
			if (words.length > 0) {
				const pname = words[words.length - 1];
				if (pname && /^\w+$/.test(pname)) params.push(pname);
			}
		}
	}

	const docLines = ['/**'];
	docLines.push(` * ${fnName}() - Brief description.`);
	for (const p of params) {
		docLines.push(` * @${p}: Description.`);
	}
	docLines.push(' *');
	docLines.push(' * Context: Any context.');
	docLines.push(' * Return: Description.');
	docLines.push(' */');

	return docLines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// formatNamingViolations(violations)
// ---------------------------------------------------------------------------
function formatNamingViolations(violations) {
	if (!violations || violations.length === 0) return null;
	const parts = violations.map(v => `[L${v.line}] ${v.type.replace(/_/g, ' ')}: ${v.message}`);
	return `📛 naming (${violations.length}):\n${parts.join('\n')}`;
}

module.exports = { checkNaming, checkFunctionDocs, buildDocSkeleton, formatNamingViolations, isKernelFile };
