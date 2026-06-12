'use strict';

// lib/mcp-ignore.js — .mcp-ignore support for pulsar-edit-mcp-server.
//
// Loads .mcp-ignore from the project root (first atom.project path) using
// gitignore syntax via the 'ignore' npm package. Exposes:
//
//   shouldIgnore(filePath) -> boolean
//   reloadMcpIgnore()      -> void  (called on file-watch events)
//   getMcpIgnoreInfo()     -> { path, ruleCount, loaded } (for diagnostics)
//
// All paths are normalised to forward-slash relative paths before matching,
// which is what the 'ignore' package expects on all platforms.

const fs      = require('fs');
const path    = require('path');
const ignore  = require('ignore');

// State
let _ig         = ignore();   // ignore instance -- rebuilt on reload
let _ignorePath = null;       // absolute path to the loaded .mcp-ignore file
let _ruleCount  = 0;          // number of non-comment, non-blank rules loaded
let _loaded     = false;      // true once successfully loaded at least once
let _watcher    = null;       // fs.watch handle

// Default rules -- always applied even if no .mcp-ignore exists
const DEFAULT_RULES = [
  'node_modules/',
  '.mcp-baseline/',
];

// Internal helpers

function _projectRoot() {
  if (typeof atom !== 'undefined') {
    const paths = atom.project.getPaths();
    if (paths && paths.length > 0) return paths[0];
  }
  return process.cwd();
}

function _toRelativeForward(filePath) {
  const root = _projectRoot();
  const rel  = path.relative(root, filePath);
  return rel.replace(/\\/g, '/');
}

function _buildIgnore(rules) {
  const ig = ignore();
  ig.add(DEFAULT_RULES);
  if (rules.length > 0) ig.add(rules);
  return ig;
}

function _countRules(lines) {
  return lines.filter(l => l.trim() && !l.trim().startsWith('#')).length;
}

// Public API

/**
 * Load (or reload) .mcp-ignore from the current project root.
 * Safe to call multiple times -- rebuilds the ignore instance each time.
 */
function reloadMcpIgnore() {
  const root       = _projectRoot();
  const ignorePath = path.join(root, '.mcp-ignore');

  let lines = [];
  try {
    const raw = fs.readFileSync(ignorePath, 'utf8');
    lines = raw.split(/\r?\n/);
    _ignorePath = ignorePath;
    _loaded     = true;
  } catch (_e) {
    // No .mcp-ignore at project root -- defaults only
    _ignorePath = null;
    _loaded     = false;
  }

  _ruleCount = _countRules(lines);
  _ig        = _buildIgnore(lines);

  // Set up file watcher if not already watching this path
  if (_watcher) { try { _watcher.close(); } catch (_e) {} _watcher = null; }
  try {
    _watcher = fs.watch(root, { persistent: false }, (event, filename) => {
      if (filename === '.mcp-ignore') reloadMcpIgnore();
    });
    _watcher.unref();
  } catch (_e) { /* watch not available in this environment */ }
}

/**
 * Returns true if the given absolute filePath should be ignored.
 * Paths outside the project root are never ignored.
 */
function shouldIgnore(filePath) {
  if (!filePath) return false;
  const rel = _toRelativeForward(filePath);
  if (rel.startsWith('..')) return false;
  try {
    return _ig.ignores(rel);
  } catch (_e) {
    return false;
  }
}

/**
 * Returns diagnostic info about the current ignore state.
 */
function getMcpIgnoreInfo() {
  return {
    path:      _ignorePath,
    ruleCount: _ruleCount,
    loaded:    _loaded,
    defaults:  DEFAULT_RULES,
  };
}

// Initialise on require — loads from process.cwd() if atom.project not ready yet.
reloadMcpIgnore();

/**
 * Call once from activate() (or after mcp-registration.js loads) so that:
 *   1. We reload with the real project root (atom.project is fully ready by then).
 *   2. We subscribe to onDidChangePaths so future root changes trigger a reload.
 * Returns a Disposable — add it to packageDisposables for cleanup on deactivate.
 */
function initMcpIgnore() {
  // Reload now that atom.project is guaranteed to have paths.
  reloadMcpIgnore();

  // Re-reload whenever the user changes the project root (File → Add/Remove Folder,
  // or opening a new project). This keeps the watcher and rules in sync.
  let disposable = null;
  if (typeof atom !== 'undefined' && atom.project && atom.project.onDidChangePaths) {
    disposable = atom.project.onDidChangePaths(() => reloadMcpIgnore());
  }
  return disposable || { dispose() {} };
}

module.exports = { shouldIgnore, reloadMcpIgnore, getMcpIgnoreInfo, initMcpIgnore };
