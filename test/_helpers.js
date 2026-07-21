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
    performance: { now: () => Date.now() }, // yk-capture 的在途台帳（真頁面必有）
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
      // 與真 DOM 對齊：className 與 classList 同一份資料——模組碼用 className 指定、
      // 用 '.class' 選擇器查（yk-transcript 的 .ykt-body）；兩者不同步的話 class 查詢恆 miss。
      get className() { return [...this.classList._s].join(' '); },
      set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
      // 與真 DOM 對齊：模組碼用 parentElement 做守門（yk-transcript 的 re-home 判斷），
      // 假 DOM 少了它會讓該守門「恆真」，守門被拔掉測試也照綠（無鑑別力）。
      get parentElement() { return this.parent; },
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
      appendChild(c) {
        // 與真 DOM 對齊：appendChild 會先把節點從舊 parent 摘下（「搬移」而非複製）——
        // 少了這步，「same node, moved」類斷言驗不到舊 host 已不含該節點。
        if (c.parent) {
          const i = c.parent.children.indexOf(c);
          if (i >= 0) c.parent.children.splice(i, 1);
        }
        c.parent = node;
        node.children.push(c);
        return c;
      },
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

// A FUNCTIONAL fake XMLHttpRequest with REAL responseText/response getters on its prototype
// (the makeSandbox stub has none) so yk-capture's transform seam — which snapshots the native
// prototype getter and shadows it per-instance — can be exercised in a unit test. A test
// opens+sends, then drives __fireLoad(body) to simulate readyState 4 + the 'load' event.
function makeFakeXhr() {
  function FakeXHR() {
    this.readyState = 0;
    this.status = 200; // 測試可在 __fireLoad 前覆寫（例如 429）
    this._url = '';
    this._body = '';
    this.responseType = '';
    this._listeners = {};
  }
  FakeXHR.prototype.open = function (method, url) {
    this._url = url;
    this.readyState = 1;
  };
  FakeXHR.prototype.send = function () {
    /* the test drives the load manually via __fireLoad */
  };
  FakeXHR.prototype.addEventListener = function (t, fn) {
    (this._listeners[t] = this._listeners[t] || []).push(fn);
  };
  Object.defineProperty(FakeXHR.prototype, 'responseText', {
    configurable: true,
    get() {
      // 忠實模擬真 XHR：responseType 非 ''/'text' 時讀 responseText 依規範必須 throw
      // （InvalidStateError）——yk-capture 的 nativeText 正是為此分流到 response getter。
      if (this.responseType && this.responseType !== 'text') {
        throw new Error('InvalidStateError: responseText is only valid for text responseType');
      }
      return this._body;
    },
  });
  Object.defineProperty(FakeXHR.prototype, 'response', {
    configurable: true,
    get() {
      return this.responseType === 'json' ? JSON.parse(this._body) : this._body;
    },
  });
  FakeXHR.prototype.__fireLoad = function (body) {
    this._body = body;
    this.readyState = 4;
    (this._listeners.load || []).forEach((fn) => fn({ target: this }));
    // 與真 XHR 對齊：load / error / abort 之後都會補一發 loadend
    (this._listeners.loadend || []).forEach((fn) => fn({ target: this }));
  };
  FakeXHR.prototype.abort = function () {
    this.readyState = 4;
    (this._listeners.abort || []).forEach((fn) => fn({ target: this }));
    (this._listeners.loadend || []).forEach((fn) => fn({ target: this }));
  };
  return FakeXHR;
}

module.exports = { EXT, FIX, makeSandbox, load, makeDom, makeFakeXhr };
