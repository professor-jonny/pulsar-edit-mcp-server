'use strict';
// Lets lib/*.js be loaded under plain node, with no Pulsar running.
//
// What it does:
//   1. Makes require('atom') return a tiny stand-in (Disposable, CompositeDisposable), which is all
//      the lib files import from it.
//   2. Defines a minimal global `window` (addEventListener/removeEventListener no-ops) if none exists.
//   3. Defines a global `atom` if none exists. It is a permissive stub: any property access gives
//      another stub, calling a stub returns undefined. That is enough for modules to LOAD (their
//      atom.* calls sit inside functions). A module that uses atom at load time shows up as a
//      failure instead of being silently faked.
//
// It proves syntax, imports and wiring only. It does not prove that editor calls behave: that
// still needs a real Pulsar restart.
//
// Usage:   require('./atom-shim').install();     (before requiring anything from ../lib)
// A test that sets its own global.atom keeps it: install() never overwrites an existing global.
const Module = require('module');

class Disposable {
  constructor(callback) {
    this.disposed = false;
    this._callback = typeof callback === 'function' ? callback : null;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this._callback) {
      const cb = this._callback;
      this._callback = null;
      cb();
    }
  }
}

class CompositeDisposable {
  constructor(...items) {
    this.disposed = false;
    this._items = new Set();
    this.add(...items);
  }
  add(...items) {
    for (const d of items) this._items.add(d);
  }
  remove(item) {
    this._items.delete(item);
  }
  delete(item) {
    this._items.delete(item);
  }
  clear() {
    this._items.clear();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this._items) {
      try { if (d && typeof d.dispose === 'function') d.dispose(); } catch (e) { /* ignore */ }
    }
    this._items.clear();
  }
}

// Permissive deep stub: stub.a.b.c is a stub, stub(...) is undefined, `then` is absent so a stub
// is never mistaken for a thenable.
function deepStub(name) {
  return new Proxy(function () {}, {
    get(_target, prop) {
      if (typeof prop === 'symbol') {
        if (prop === Symbol.toPrimitive) return () => '[atom-shim ' + name + ']';
        return undefined;
      }
      if (prop === 'then') return undefined;
      return deepStub(name + '.' + prop);
    },
    apply() { return undefined; },
    construct() { return {}; },
  });
}

const atomModule = { Disposable, CompositeDisposable };
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'atom') return atomModule;
    return originalLoad.apply(this, arguments);
  };
  if (typeof global.atom === 'undefined') global.atom = deepStub('atom');
  // mcp-registration.js registers a 'beforeunload' flush hook at load time (Pulsar's renderer has a
  // window). Plain node does not, so give it one that records listeners and does nothing else.
  if (typeof global.window === 'undefined') {
    global.window = {
      addEventListener() {},
      removeEventListener() {},
    };
  }
}

module.exports = { install, Disposable, CompositeDisposable, deepStub };
