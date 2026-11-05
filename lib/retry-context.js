'use strict';
// Per-call "this call is a retry" marker (2026-11-07, TODO R3i).
//
// The framework (lib/tool-framework.js) merges a bare { filePath, old_str } resend into a stashed failure
// (features.retryOnFail). The fault log is written deep inside the match helpers, which have no access to the call
// context, so the framework runs the merged call inside runAsRetry() and edit-stats.buildFailureRecord() asks
// isRetryCall(). AsyncLocalStorage keeps the marker with THIS call across awaits, so two tool calls running at the
// same time cannot mix their markers (same approach as runWithLintTarget in lib/lint-helpers.js).
//
// No dependencies on Pulsar or on the other lib files, so plain node tests can load it.

const { AsyncLocalStorage } = require('async_hooks');

const _store = new AsyncLocalStorage();

// Run fn() with the retry marker set. Returns whatever fn returns (a promise for an async fn).
function runAsRetry(fn) {
  return _store.run({ viaRetry: true }, fn);
}

// True only while code runs inside runAsRetry().
function isRetryCall() {
  const s = _store.getStore();
  return !!(s && s.viaRetry === true);
}

module.exports = { runAsRetry, isRetryCall };
