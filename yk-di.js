/**
 * YK DI container — a tiny dependency-injection registry shared across the
 * extension's MAIN-world content scripts via ONE page global (window.__YK__).
 *
 * Why a registry (not ES modules): MV3 content_scripts run as sourceType:script in
 * the page's MAIN world, sharing `window`. Each yk-*.js file registers a factory;
 * yk-main.js (loaded last) is the ONLY place that resolves/boots. Resolution is
 * lazy + singleton, so registration order among modules does not matter — only that
 * yk-di.js is first and yk-main.js is last.
 *
 * Hot-swap (the whole point — "swap without reload"): MCP can eval a module file's
 * IIFE back into the page at runtime. Its register(name,…) re-runs; once booted,
 * that triggers hotSwap(name): dispose every LIVE module that (transitively) depends
 * on `name`, plus `name` itself, dependents-first; drop their cached instances; then
 * re-resolve and re-start the entry. The module's new factory takes effect WITHOUT
 * reloading the extension. Cold load (booted=false) just stores the factory.
 *
 * dispose() lifecycle: any module holding DOM / listeners / timers exports dispose();
 * pure-function modules do not. dispose() is shared by hot-swap and teardown.
 */
(function () {
  'use strict';
  if (window.__YK__) return;

  const factories = new Map(); // name -> { deps, factory }
  const instances = new Map(); // name -> resolved api
  const resolving = new Set(); // cycle guard

  let booted = false;
  let entryName = null;

  function resolve(name) {
    if (instances.has(name)) return instances.get(name);
    const entry = factories.get(name);
    if (!entry) throw new Error(`[YK DI] no module registered: ${name}`);
    if (resolving.has(name)) throw new Error(`[YK DI] dependency cycle at: ${name}`);
    resolving.add(name);
    let api;
    try {
      api = entry.factory(...entry.deps.map(resolve));
    } finally {
      resolving.delete(name);
    }
    instances.set(name, api);
    return api;
  }

  // The set of currently-instantiated modules that (transitively) depend on
  // `target`, plus target itself. These are exactly what a swap of `target`
  // invalidates — a live consumer captured the OLD instance in its closure.
  function affectedSet(target) {
    const set = new Set([target]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const name of instances.keys()) {
        if (set.has(name)) continue;
        const deps = factories.get(name)?.deps || [];
        if (deps.some((d) => set.has(d))) {
          set.add(name);
          changed = true;
        }
      }
    }
    return set;
  }

  // Dependents-first order within `set`: dispose a consumer BEFORE the thing it
  // uses (engine before overlay). DFS post-order gives deps-first; reverse it.
  function disposeOrderFor(set) {
    const order = [];
    const mark = new Set();
    const visit = (n) => {
      if (mark.has(n)) return;
      mark.add(n);
      for (const d of factories.get(n)?.deps || []) {
        if (set.has(d)) visit(d);
      }
      order.push(n);
    };
    for (const n of set) visit(n);
    order.reverse();
    return order;
  }

  function hotSwap(name) {
    const order = disposeOrderFor(affectedSet(name));
    for (const n of order) {
      const inst = instances.get(n);
      if (inst && typeof inst.dispose === 'function') {
        try {
          inst.dispose();
        } catch (e) {
          console.error('[YK DI] dispose failed:', n, e);
        }
      }
      instances.delete(n);
    }
    if (entryName) {
      const api = resolve(entryName);
      if (api && typeof api.start === 'function') {
        try {
          api.start();
        } catch (e) {
          console.error('[YK DI] restart failed:', entryName, e);
        }
      }
    }
  }

  const di = {
    register(name, deps, factory) {
      factories.set(name, { deps: deps || [], factory });
      // Re-registering a live module after boot = hot-swap (same code path as the
      // initial cold register, gated on booted so cold load just stores factories).
      if (booted && instances.has(name)) hotSwap(name);
    },
    resolve,
    start(name) {
      entryName = name;
      const api = resolve(name);
      booted = true;
      if (api && typeof api.start === 'function') api.start();
      return api;
    },
    // Explicit trigger (debug / forced re-resolve); register already auto-swaps.
    swap(name) {
      if (booted && instances.has(name)) hotSwap(name);
    },
  };

  window.__YK__ = di;
})();
