// 共用 Node 測試夾具（Jest unit 與 legacy di-harness 共用）：在 vm sandbox 裡載入
// MAIN-world yk-*.js，可注入 mock window/document/chrome 來隔離測（DI 的核心方法論）。
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const EXT = path.resolve(__dirname, '..');
const FIX = path.join(EXT, 'test', 'fixtures');

function makeSandbox() {
  const stubEl = () => ({
    style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } },
    dataset: {}, classList: { add() {}, remove() {}, contains() { return false; } },
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, appendChild() {},
    append() {}, replaceChildren() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, width: 0 }; }, scrollTo() {},
  });
  const win = {
    addEventListener() {}, removeEventListener() {}, postMessage() {}, fetch() { return Promise.resolve(); },
    innerWidth: 1000, innerHeight: 800,
  };
  win.window = win;
  const sandbox = {
    window: win,
    document: {
      querySelector() { return null; }, getElementById() { return null; },
      createElement() { return stubEl(); }, head: { appendChild() {} }, body: { appendChild() {} },
      addEventListener() {}, readyState: 'complete',
    },
    location: { href: 'https://www.youtube.com/watch?v=abc', search: '?v=abc', pathname: '/watch', origin: 'https://www.youtube.com' },
    localStorage: (() => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } }; })(),
    getComputedStyle() { return { position: 'relative' }; },
    console, URL, URLSearchParams, Date, Math, JSON,
    setInterval() { return 0; }, clearInterval() {}, requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    XMLHttpRequest: function () {},
  };
  sandbox.XMLHttpRequest.prototype = { open() {}, send() {}, addEventListener() {} };
  vm.createContext(sandbox);
  return sandbox;
}

function load(sandbox, files) {
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), sandbox, { filename: f });
  }
}

// A small but FUNCTIONAL fake DOM (the makeSandbox stub is too thin to exercise a
// DOM-building module like yk-panel). Tracks the element tree, ids, attributes and event
// listeners, and lets a test dispatch('change'/'click') to fire a handler — enough to
// assert a DI view module's build + write contracts under mock-injected deps. NOT a full
// DOM; real geometry/lifecycle/fullscreen is e2e-a's job.
function makeDom() {
  const byId = new Map();
  function matches(node, sel) {
    if (sel[0] === '#') return node._id === sel.slice(1);
    if (sel[0] === '.') return node.classList.contains(sel.slice(1));
    return node.tagName === sel.toUpperCase();
  }
  function walk(node, pred, out) {
    for (const c of node.children) {
      if (pred(c)) {
        if (!out) return c;
        out.push(c);
      }
      const r = walk(c, pred, out);
      if (r && !out) return r;
    }
    return out ? out : null;
  }
  function el(tag) {
    const node = {
      tagName: String(tag || '').toUpperCase(),
      parent: null,
      children: [],
      _listeners: {},
      _attrs: {},
      _id: '',
      _value: '',
      textContent: '',
      checked: false,
      type: '',
      style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } },
      dataset: {},
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
      },
      get id() { return this._id; },
      set id(v) { this._id = v; if (v) byId.set(v, node); },
      // A <select> only accepts a value that matches one of its <option>s (else it lands
      // on the empty/first — that IS the panel's "stale target → 關閉" fallback). Other
      // elements (input, option) store the value verbatim.
      get value() { return this._value; },
      set value(v) {
        if (node.tagName === 'SELECT') {
          const opts = node.querySelectorAll('option');
          node._value = opts.length ? (opts.some((o) => o._value === v) ? v : '') : v;
        } else {
          node._value = v;
        }
      },
      setAttribute(k, v) { this._attrs[k] = v; },
      getAttribute(k) { return this._attrs[k]; },
      removeAttribute(k) { delete this._attrs[k]; },
      addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
      removeEventListener() {},
      appendChild(c) { c.parent = node; node.children.push(c); return c; },
      append(...cs) { cs.forEach((c) => node.appendChild(c)); },
      replaceChildren(...cs) { node.children = []; cs.forEach((c) => node.appendChild(c)); },
      remove() {
        if (node.parent) {
          const i = node.parent.children.indexOf(node);
          if (i >= 0) node.parent.children.splice(i, 1);
        }
        if (node._id && byId.get(node._id) === node) byId.delete(node._id);
      },
      querySelector(sel) { return walk(node, (n) => matches(n, sel)); },
      querySelectorAll(sel) { return walk(node, (n) => matches(n, sel), []); },
      getBoundingClientRect() { return { left: 0, width: 0 }; },
      scrollTo() {},
      // test helper: synchronously fire listeners of a type with a minimal event
      dispatch(type) {
        (node._listeners[type] || []).forEach((fn) =>
          fn({ stopPropagation() {}, preventDefault() {}, clientX: 0, target: node }));
      },
    };
    return node;
  }
  const document = {
    createElement: el,
    createDocumentFragment: () => el('fragment'),
    getElementById: (id) => byId.get(id) || null,
    querySelector(sel) {
      const holder = el('root');
      // search whole registry isn't tree-scoped; emulate by walking documentElement
      return walk(this.documentElement, (n) => matches(n, sel)) || (holder, null);
    },
    head: el('head'),
    body: el('body'),
    addEventListener() {},
    readyState: 'complete',
  };
  document.documentElement = el('html');
  document.documentElement.appendChild(document.head);
  document.documentElement.appendChild(document.body);
  return { document, el };
}

module.exports = { EXT, FIX, makeSandbox, load, makeDom };
