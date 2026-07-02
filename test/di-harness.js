/**
 * DI 驗證 harness（Node，唯讀，非 ship 檔）。
 * 只保留「形狀鎖」(A–C)：resolve / 熱抽換順序 / parse 等價，infra、不具功能意義。
 * 功能驗證（settings.apply、yk-panel 投影/寫入、yk-yt runtime assert）已遷到 Jest
 * (`test/unit/feature.test.js`，注入 mock 隔離測)，本檔不再重證（避免重複）。
 *  A) 容器熱抽換的 dispose 順序（依賴者先）+ 重啟
 *  B) 14 模組全部 resolve、無循環/缺漏 dep
 *  C) 新 parse vs git HEAD 舊 content.js 在真實 fixtures 上逐行相同
 *  D) native dispose 還原 capture transform seam（__YK_TX__.fn 清回 null）
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const EXT = path.resolve(__dirname, '..');
const FIX = path.join(EXT, 'test', 'fixtures');
const OLD = process.env.OLD_CONTENT; // git HEAD content.js 路徑

let failed = 0;
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' ' + m); if (!c) failed++; };

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

const MODULES = ['yk-config.js','yk-log.js','yk-settings.js','yk-timing.js','yk-parse.js','yk-yt.js','yk-capture.js','yk-styles.js','yk-overlay.js','yk-transcript.js','yk-panel.js','yk-autodrive.js','yk-native.js','yk-engine.js'];
const NAMES = ['config','log','settings','timing','parse','yt','capture','styles','overlay','transcript','panel','autodrive','native','engine'];

// ---------- A) 容器熱抽換 ----------
(function partA() {
  console.log('\n== A) container hot-swap ordering ==');
  const s = makeSandbox();
  load(s, ['yk-di.js']);
  const di = s.window.__YK__;
  const disposed = [];
  let appStarts = 0;
  di.register('leaf', [], () => ({ dispose() { disposed.push('leaf'); } }));
  di.register('mid', ['leaf'], () => ({ dispose() { disposed.push('mid'); } }));
  di.register('app', ['mid'], () => ({ start() { appStarts++; }, dispose() { disposed.push('app'); } }));
  di.start('app');
  ok(appStarts === 1, 'entry start() called once on boot');
  disposed.length = 0;
  // 重新 register leaf（模擬 MCP eval 進新版）→ 自動 hotSwap
  di.register('leaf', [], () => ({ dispose() { disposed.push('leaf'); } }));
  ok(JSON.stringify(disposed) === JSON.stringify(['app', 'mid', 'leaf']), 'dispose order is dependents-first: ' + JSON.stringify(disposed));
  ok(appStarts === 2, 'entry restarted after hot-swap (appStarts=' + appStarts + ')');
})();

// ---------- B) 全模組 resolve ----------
let realParse = null;
(function partB() {
  console.log('\n== B) resolve all 14 modules ==');
  const s = makeSandbox();
  load(s, ['yk-di.js', ...MODULES]);
  const di = s.window.__YK__;
  for (const n of NAMES) {
    try {
      const api = di.resolve(n);
      ok(api && typeof api === 'object', 'resolve ' + n + ' → ' + (api ? Object.keys(api).join(',') : 'null'));
      if (n === 'parse') realParse = api;
    } catch (e) {
      ok(false, 'resolve ' + n + ' threw: ' + e.message);
    }
  }
  // capture.install 冪等 + __YK_NET__ guard
  const cap = di.resolve('capture');
  cap.install(); cap.install();
  const capMap = s.window.__YK_CAP__; // 跨 realm，用鴨子型別而非 instanceof
  ok(s.window.__YK_NET__ === true, '__YK_NET__ guard set after install');
  ok(capMap && typeof capMap.set === 'function' && typeof capMap.get === 'function', '__YK_CAP__ is a Map-like (persistent capture pool)');
})();

// ---------- C) parse 等價（新 DI vs git HEAD 舊 content.js） ----------
(function partC() {
  console.log('\n== C) parse equivalence: new DI vs old content.js (git HEAD) ==');
  if (!OLD || !fs.existsSync(OLD)) { ok(false, 'OLD_CONTENT not provided'); return; }

  // 從舊 content.js 抽出 4 個純函式 + 2 常數，eval 成獨立 oldParse（不跑整個 IIFE）。
  const src = fs.readFileSync(OLD, 'utf8');
  function extractFn(name) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('fn not found: ' + name);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
  }
  const cjk = src.match(/const CJK_RE = (\/.*\/);/)[1];
  const gap = src.match(/const LINE_BREAK_GAP_MS = (\d+);/)[1];
  const oldBundle = `(function(){
    const LINE_BREAK_GAP_MS = ${gap};
    const CJK_RE = ${cjk};
    ${extractFn('captionJsonFromText')}
    ${extractFn('parseCaptionEvents')}
    ${extractFn('needsBoundarySpace')}
    ${extractFn('groupLines')}
    return { captionJsonFromText, parseCaptionEvents, groupLines, needsBoundarySpace };
  })()`;
  const oldParse = vm.runInNewContext(oldBundle, { JSON, Math });

  const fixtures = [
    ['5ipNqGvS5Hw.en.asr.json3.json', 44],
    ['5ipNqGvS5Hw.en-zh-Hant.asr.json3.json', 41],
  ];
  for (const [file, expectN] of fixtures) {
    const json = JSON.parse(fs.readFileSync(path.join(FIX, file), 'utf8'));
    // 各自跑（parseCaptionEvents 會 mutate words，故各自 JSON.parse 一份）
    const a = realParse.groupLines(realParse.parseCaptionEvents(JSON.parse(JSON.stringify(json))));
    const b = oldParse.groupLines(oldParse.parseCaptionEvents(JSON.parse(JSON.stringify(json))));
    const sig = (lines) => lines.map((l) => l.start + '|' + l.text).join('\n');
    ok(a.length === b.length, file + ': new lines=' + a.length + ' old lines=' + b.length);
    ok(sig(a) === sig(b), file + ': per-line (start|text) identical new↔old');
    ok(a.length === expectN, file + ': line count = ' + a.length + ' (baseline ' + expectN + ' from _analyze.py)');
  }
})();


// ---------- D) native transform seam teardown ----------
(function partD() {
  console.log('\n== D) native dispose clears the capture transform seam ==');
  const s = makeSandbox();
  load(s, ['yk-di.js', ...MODULES]);
  const di = s.window.__YK__;
  const capture = di.resolve('capture');
  const native = di.resolve('native');
  native.enable();
  ok(typeof s.window.__YK_TX__.fn === 'function', 'native.enable registers a transform (__YK_TX__.fn set)');
  native.dispose();
  ok(s.window.__YK_TX__.fn === null, 'native.dispose clears the transform (capture seam back to no-op)');
  capture.registerTransform(() => 'x');
  capture.dispose();
  ok(s.window.__YK_TX__.fn === null, 'capture.dispose also clears the transform');
})();


console.log('\n' + (failed ? 'FAILED ' + failed : 'ALL PASS'));
process.exit(failed ? 1 : 0);
