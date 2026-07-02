// UNIT (Jest) — native playback mode: the PURE cook (parsed lines -> karaoke json3) and the
// capture transform seam (player reads cooked, __YK_CAP__ keeps the original). Mock-injected /
// real-getter fake XHR; the live player ACCEPTING the bytes is e2e-b's job, not here.
const fs = require('fs');
const path = require('path');
const { makeSandbox, load, FIX, makeFakeXhr } = require('../_helpers');

const ASR_URL = 'https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr';

function loadNative() {
  const s = makeSandbox();
  load(s, [
    'yk-di.js', 'yk-config.js', 'yk-log.js', 'yk-settings.js', 'yk-timing.js',
    'yk-parse.js', 'yk-yt.js', 'yk-capture.js', 'yk-autodrive.js', 'yk-native.js',
  ]);
  const di = s.window.__YK__;
  return { s, di, native: di.resolve('native'), parse: di.resolve('parse'), timing: di.resolve('timing') };
}

function linesFromFixture(parse, file) {
  const json = JSON.parse(fs.readFileSync(path.join(FIX, file), 'utf8'));
  return parse.groupLines(parse.parseCaptionEvents(json));
}

describe('cookKaraoke — pure: parsed lines -> karaoke json3', () => {
  test('single variant: ONE pop-on window, INTEGER pens, per-seg pPenId via timing.wordState', () => {
    const { native, parse, timing } = loadNative();
    const lines = linesFromFixture(parse, '5ipNqGvS5Hw.en.asr.json3.json');
    const json = JSON.parse(native.cookKaraoke([{ key: '', lines }], {}));

    expect(json.wireMagic).toBe('pb3');

    // pens = [{}, past, active, future]; colours are INTEGERS (a "#hex" string makes YT drop the event)
    expect(json.pens).toHaveLength(4);
    [1, 2, 3].forEach((i) => expect(typeof json.pens[i].fcForeColor).toBe('number'));
    expect(json.pens[2].fcForeColor).toBe(0xffe566); // active = gold

    // POP-ON: centred and NO sdScrollDir ANYWHERE (a roll-up window would stack repaints)
    expect(json.wsWinStyles.some((w) => w && w.juJustifCode === 2)).toBe(true);
    expect(JSON.stringify(json).includes('sdScrollDir')).toBe(false);

    // STANDALONE cues: NO persistent window-defining event (one would roll up / stack the
    // repaints during full-video playback). One position entry (index 1).
    expect(json.events.some((e) => e.id != null || e.wWinId != null)).toBe(false);
    expect(json.wpWinPositions).toHaveLength(2);

    // repaint events: each self-positions at window position 1 and every seg has a valid pen id
    const repaint = json.events.filter((e) => e.segs);
    expect(repaint.length).toBeGreaterThan(0);
    repaint.forEach((e) => {
      expect(e.wpWinPosId).toBe(1);
      expect(e.wsWinStyleId).toBe(1);
      e.segs.forEach((s) => expect([1, 2, 3]).toContain(s.pPenId));
    });

    // the highlight agrees with timing.wordState: at word0.start+1 the covering event marks
    // word0 ACTIVE (pen 2) — native and the side transcript share one source of truth
    const line = lines[0];
    const t = line.words[0].start + 1;
    expect(timing.wordState(line.words[0], t)).toBe('active');
    const ev = repaint.find((e) => e.wpWinPosId === 1 && e.tStartMs <= t && t < e.tStartMs + e.dDurationMs);
    expect(ev).toBeTruthy();
    expect(ev.segs[0].pPenId).toBe(2);

    // concatenated cooked segs reproduce the line text (no injected-space artifacts)
    expect(ev.segs.map((s) => s.utf8).join('')).toBe(line.text);
  });

  test('dual variant: TWO window positions; entries[0] is the top row; no window-def', () => {
    const { native, parse } = loadNative();
    const orig = linesFromFixture(parse, '5ipNqGvS5Hw.en.asr.json3.json');
    const trans = linesFromFixture(parse, '5ipNqGvS5Hw.en-zh-Hant.asr.json3.json');
    const json = JSON.parse(
      native.cookKaraoke([{ key: '', lines: orig }, { key: 'zh-Hant', lines: trans }], {}),
    );

    expect(json.events.some((e) => e.id != null || e.wWinId != null)).toBe(false); // standalone cues
    expect(json.wpWinPositions).toHaveLength(3); // empty + 2 row positions
    // entries[0] (top row) sits higher on screen => smaller avVerPos than entries[1]
    expect(json.wpWinPositions[1].avVerPos).toBeLessThan(json.wpWinPositions[2].avVerPos);
    // CONTENT binds to the position: posId 1 events repaint entries[0] (orig) lines, posId 2
    // entries[1] (trans) lines — the geometry assertion alone can't catch a swapped posId
    // (which would flip the rows on screen and invert translationOnTop).
    const texts = (lines) => new Set(lines.map((l) => l.text));
    const origTexts = texts(orig);
    const transTexts = texts(trans);
    const evText = (e) => e.segs.map((s) => s.utf8).join('');
    const w1 = json.events.filter((e) => e.segs && e.wpWinPosId === 1);
    const w2 = json.events.filter((e) => e.segs && e.wpWinPosId === 2);
    expect(w1.length).toBeGreaterThan(0);
    expect(w2.length).toBeGreaterThan(0);
    w1.forEach((e) => expect(origTexts.has(evText(e))).toBe(true));
    w2.forEach((e) => expect(transTexts.has(evText(e))).toBe(true));
    // per-window replace-in-place holds for BOTH rows: time-ordered, never overlapping
    for (const w of [w1, w2]) {
      for (let i = 1; i < w.length; i++) {
        expect(w[i].tStartMs).toBeGreaterThanOrEqual(w[i - 1].tStartMs + w[i - 1].dDurationMs);
      }
    }
  });

  test('empty input cooks an empty (no-window) document, not a crash', () => {
    const { native } = loadNative();
    const json = JSON.parse(native.cookKaraoke([], {}));
    expect(json.wireMagic).toBe('pb3');
    expect(json.events.filter((e) => e.segs)).toHaveLength(0);
  });

  test('every repaint event is well-formed: positive duration, ordered + non-overlapping per window', () => {
    const { native, parse } = loadNative();
    const lines = linesFromFixture(parse, '5ipNqGvS5Hw.en.asr.json3.json');
    const repaint = JSON.parse(native.cookKaraoke([{ key: '', lines }], {})).events.filter((e) => e.segs);
    repaint.forEach((e) => {
      expect(e.tStartMs).toBeGreaterThanOrEqual(0);
      expect(e.dDurationMs).toBeGreaterThan(0);
    });
    // within a window the player shows ONE line at a time: events are time-ordered and never overlap
    const w1 = repaint.filter((e) => e.wpWinPosId === 1);
    for (let i = 1; i < w1.length; i++) {
      expect(w1[i].tStartMs).toBeGreaterThanOrEqual(w1[i - 1].tStartMs + w1[i - 1].dDurationMs);
    }
  });

  test('a line starting within LINE_LEAD_MS of 0 still emits clean, non-overlapping events', () => {
    const { native } = loadNative();
    const lines = [
      {
        start: 10,
        end: 900,
        text: 'hi there',
        words: [
          { text: 'hi', start: 10, end: 400 },
          { text: ' there', start: 400, end: 900 },
        ],
      },
    ];
    const w1 = JSON.parse(native.cookKaraoke([{ key: '', lines }], {})).events.filter(
      (e) => e.segs && e.wpWinPosId === 1,
    );
    const starts = w1.map((e) => e.tStartMs);
    expect(new Set(starts).size).toBe(starts.length); // no two events share a tStartMs
    expect(w1[0].tStartMs).toBe(0); // clamped, not negative
    w1.forEach((e) => expect(e.dDurationMs).toBeGreaterThan(0));
    for (let i = 1; i < w1.length; i++) {
      expect(w1[i].tStartMs).toBeGreaterThanOrEqual(w1[i - 1].tStartMs + w1[i - 1].dDurationMs);
    }
  });

  test('golden: output matches the bytes the LIVE player accepted + rendered (en, 9.1–10.5s)', () => {
    // The golden was captured from a real youtube.com render of exactly this cook (see e2e-b);
    // it pins the live-verified invariants (integer fcForeColor, pop-on, per-seg pPenId) to bytes
    // the player actually accepted, not just author-believed shapes.
    const { native, parse } = loadNative();
    const lines = linesFromFixture(parse, '5ipNqGvS5Hw.en.asr.json3.json').filter(
      (l) => l.start >= 9100 && l.start <= 10500,
    );
    const got = JSON.parse(native.cookKaraoke([{ key: '', lines }], {}));
    const golden = JSON.parse(
      fs.readFileSync(path.join(FIX, 'cooked.5ipNqGvS5Hw.en.karaoke.json3.json'), 'utf8'),
    );
    expect(got).toEqual(golden);
  });
});

describe('cook() — impure transform: 守門 / memo / dual 組裝（mock 注入 settings/yt/capture）', () => {
  const EN_URL = 'https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr';
  const ZH_URL = 'https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr&tlang=zh-Hant';
  const enBody = () => fs.readFileSync(path.join(FIX, '5ipNqGvS5Hw.en.asr.json3.json'), 'utf8');
  const zhBody = () => fs.readFileSync(path.join(FIX, '5ipNqGvS5Hw.en-zh-Hant.asr.json3.json'), 'utf8');

  // 與 loadNative 相同的載入法，但 settings/yt/capture 全 mock：cook 的每個分支
  // 都能在完全受控的輸入下驅動（feature.test.js transcript 段的既有手法）。
  function loadCook(cur = {}) {
    const s = makeSandbox();
    load(s, ['yk-di.js', 'yk-config.js', 'yk-log.js', 'yk-timing.js', 'yk-parse.js']);
    const di = s.window.__YK__;
    const current = Object.assign(
      { nativeMode: true, dualTrack: false, translationOnTop: false },
      cur,
    );
    const pool = {}; // tlang -> 原始 body 字串（'' = 原文變體）
    const calls = { has: 0, get: 0 };
    di.register('settings', [], () => ({ current }));
    di.register('yt', [], () => ({ currentVideoId: () => 'abc' }));
    di.register('capture', [], () => ({
      hasCapturedVariant: (_t, tl) => { calls.has++; return pool[tl] != null; },
      capturedJsonForVariant: (_t, tl) => {
        calls.get++;
        return pool[tl] != null ? JSON.parse(pool[tl]) : null;
      },
      registerTransform() {}, clearTransform() {},
    }));
    di.register('autodrive', [], () => ({ redrive() {} }));
    load(s, ['yk-native.js']);
    return { native: di.resolve('native'), parse: di.resolve('parse'), current, pool, calls };
  }

  test('nativeMode 關閉 → 原文原樣返回（=== 同一字串，絕不誤煮）', () => {
    const { native } = loadCook({ nativeMode: false });
    const body = enBody();
    expect(native.cook(EN_URL, body)).toBe(body);
  });

  test('URL 的 v 與當前影片不符 → 原文（SPA 殘留 transform 的安全網）', () => {
    const { native } = loadCook();
    const body = enBody();
    expect(native.cook('https://www.youtube.com/api/timedtext?v=zzz&lang=en&kind=asr', body)).toBe(body);
  });

  test('不可解析 / 非 json3 body → 原文，不丟例外', () => {
    const { native } = loadCook();
    expect(native.cook(EN_URL, 'not json')).toBe('not json');
    expect(native.cook(EN_URL, '{"events":[]}')).toBe('{"events":[]}');
  });

  test('單軌：煮出 1 個視窗位置的合法 json3', () => {
    const { native } = loadCook();
    const cooked = native.cook(EN_URL, enBody());
    const json = JSON.parse(cooked);
    expect(json.wireMagic).toBe('pb3');
    expect(json.wpWinPositions).toHaveLength(2); // 空 + 1 列
  });

  test('dual：原文已捕獲 → 兩列；預設原文在上（posId 1 = 原文內容）', () => {
    const { native, parse, pool } = loadCook({ dualTrack: true });
    pool[''] = enBody();
    const json = JSON.parse(native.cook(ZH_URL, zhBody()));
    expect(json.wpWinPositions).toHaveLength(3);
    const origTexts = new Set(linesFromFixture(parse, '5ipNqGvS5Hw.en.asr.json3.json').map((l) => l.text));
    const ev = json.events.find((e) => e.segs && e.wpWinPosId === 1);
    expect(origTexts.has(ev.segs.map((x) => x.utf8).join(''))).toBe(true);
  });

  test('dual + translationOnTop：譯文佔 posId 1（上列）', () => {
    const { native, parse, pool } = loadCook({ dualTrack: true, translationOnTop: true });
    pool[''] = enBody();
    const json = JSON.parse(native.cook(ZH_URL, zhBody()));
    const transTexts = new Set(
      linesFromFixture(parse, '5ipNqGvS5Hw.en-zh-Hant.asr.json3.json').map((l) => l.text),
    );
    const ev = json.events.find((e) => e.segs && e.wpWinPosId === 1);
    expect(transTexts.has(ev.segs.map((x) => x.utf8).join(''))).toBe(true);
  });

  test('dual 想要但原文還沒捕獲 → 先煮單軌', () => {
    const { native } = loadCook({ dualTrack: true });
    const json = JSON.parse(native.cook(ZH_URL, zhBody()));
    expect(json.wpWinPositions).toHaveLength(2);
  });

  test('memo：同 URL 同 sig 第二次直接回快取（不重查原文、回同一字串）', () => {
    const { native, pool, calls } = loadCook({ dualTrack: true });
    pool[''] = enBody();
    const a = native.cook(ZH_URL, zhBody());
    const getsAfterFirst = calls.get;
    const b = native.cook(ZH_URL, zhBody());
    expect(b).toBe(a); // 同一字串（快取命中）
    expect(calls.get).toBe(getsAfterFirst); // memo 在 parse/查池之前短路
  });

  test('memo：原文後到（single→dual 升級）→ sig 變 → 同 URL 重煮成兩列', () => {
    const { native, pool } = loadCook({ dualTrack: true });
    const single = JSON.parse(native.cook(ZH_URL, zhBody()));
    expect(single.wpWinPositions).toHaveLength(2);
    pool[''] = enBody(); // 原文變體進池 → haveOrig 翻面
    const dual = JSON.parse(native.cook(ZH_URL, zhBody()));
    expect(dual.wpWinPositions).toHaveLength(3);
  });
});

describe('mode edge — 劫持的掛/卸＋「設定簽名變了就切一遍」（mock 注入）', () => {
  const TRACK = { languageCode: 'en' };

  function loadEdge(cur = {}) {
    const s = makeSandbox();
    load(s, ['yk-di.js', 'yk-config.js', 'yk-log.js', 'yk-timing.js', 'yk-parse.js']);
    const di = s.window.__YK__;
    const current = Object.assign(
      { nativeMode: true, dualTrack: false, translationOnTop: false },
      cur,
    );
    let redrives = 0; // autodrive.redrive() 的呼叫數（「切一遍」請求）
    const selects = []; // yt.selectAsrVariant（僅 standDown 還原會用）
    let sel = { tlang: '' };
    let selectOk = true;
    let ad = false;
    const tx = { fn: null };
    di.register('settings', [], () => ({ current }));
    di.register('yt', [], () => ({
      currentVideoId: () => 'abc',
      currentAsrSelection: () => sel,
      isAdShowing: () => ad,
      selectAsrVariant: (_t, tl) => { selects.push(tl); return selectOk; },
    }));
    di.register('capture', [], () => ({
      hasCapturedVariant: () => false,
      capturedJsonForVariant: () => null,
      registerTransform: (f) => { tx.fn = f; },
      clearTransform: () => { tx.fn = null; },
    }));
    di.register('autodrive', [], () => ({ redrive: () => { redrives++; } }));
    load(s, ['yk-native.js']);
    return {
      native: di.resolve('native'), current, selects, tx,
      redrives: () => redrives,
      setSel: (v) => { sel = v; },
      setSelectOk: (v) => { selectOk = v; },
      setAd: (v) => { ad = v; },
    };
  }

  test('進場（native 已開）：註冊 transform、首次觀察只初始化——不當場翻煮，等自然 fetch', () => {
    const { native, redrives, tx } = loadEdge();
    native.syncEdge(TRACK, 'en');
    native.syncEdge(TRACK, 'en');
    expect(native.isOn()).toBe(true);
    expect(typeof tx.fn).toBe('function');
    expect(redrives()).toBe(0); // 進場零多餘動作：player 進場自己的字幕 fetch 會被煮
  });

  test('當場開 native（off→on）→ 掛 transform + redrive 一次；穩態不再', () => {
    const { native, redrives, current, tx } = loadEdge({ nativeMode: false });
    native.syncEdge(TRACK, 'en'); // 首次觀察（sig '0'）
    expect(tx.fn).toBeNull();
    expect(redrives()).toBe(0);
    current.nativeMode = true; // 使用者當場翻開關
    native.syncEdge(TRACK, 'en');
    expect(typeof tx.fn).toBe('function');
    expect(redrives()).toBe(1); // 切一遍 → 畫面上的真身被重抓重煮
    native.syncEdge(TRACK, 'en');
    expect(redrives()).toBe(1); // steady state
  });

  test('當場關 native（on→off）→ 先卸 transform 再 redrive（抓回來的就是真身＝當場還原）', () => {
    const { native, redrives, current, tx } = loadEdge();
    native.syncEdge(TRACK, 'en');
    current.nativeMode = false;
    native.syncEdge(TRACK, 'en');
    expect(native.isOn()).toBe(false);
    expect(tx.fn).toBeNull();
    expect(redrives()).toBe(1);
  });

  test('native on 時翻 dual/top → 各 redrive 一次；off 時翻 → inert 不動', () => {
    const { native, redrives, current } = loadEdge();
    native.syncEdge(TRACK, 'en'); // 首次
    current.dualTrack = true;
    native.syncEdge(TRACK, 'en');
    expect(redrives()).toBe(1);
    current.translationOnTop = true;
    native.syncEdge(TRACK, 'en');
    expect(redrives()).toBe(2);
    current.nativeMode = false; // 關掉（+1 還原 redrive）
    native.syncEdge(TRACK, 'en');
    expect(redrives()).toBe(3);
    current.dualTrack = false; // off 下翻 display 設定：overlay 每幀即時生效，無需重抓
    current.translationOnTop = false;
    native.syncEdge(TRACK, 'en');
    expect(redrives()).toBe(3);
  });

  test('選擇變更完全不觀測：換軌不觸發任何動作（player 自己的新 fetch 自然被煮）', () => {
    const { native, redrives, setSel } = loadEdge();
    native.syncEdge(TRACK, 'en');
    setSel({ tlang: 'ja' });
    native.syncEdge(TRACK, 'en');
    setSel(null); // 連字幕關掉也不關 mode edge 的事
    native.syncEdge(TRACK, 'en');
    expect(redrives()).toBe(0);
  });

  test('廣告守門：廣告中不觀測簽名；廣告結束補上、事件不丟', () => {
    const { native, redrives, current, setAd } = loadEdge();
    native.syncEdge(TRACK, 'en'); // 首次
    setAd(true);
    current.dualTrack = true; // 廣告中翻設定
    native.syncEdge(TRACK, 'en');
    expect(redrives()).toBe(0); // 廣告中不動
    setAd(false);
    native.syncEdge(TRACK, 'en');
    expect(redrives()).toBe(1); // 廣告後第一個 tick 補上（狀態性比較）
  });

  test('關 nativeMode 的 teardown 路徑（standDown(true)，sel 可見）→ 一步重選還原真身', () => {
    const { native, selects, tx } = loadEdge();
    native.syncEdge(TRACK, 'en');
    native.standDown(true);
    expect(native.isOn()).toBe(false);
    expect(tx.fn).toBeNull();
    expect(selects).toEqual(['']); // transform 已清 → 重選抓回的就是真身
  });

  test('使用者已切走（sel null 且非廣告）→ 絕不重選蓋掉使用者的選擇', () => {
    const { native, selects, setSel, tx } = loadEdge();
    native.syncEdge(TRACK, 'en');
    setSel(null);
    native.standDown(true);
    expect(selects).toEqual([]);
    expect(tx.fn).toBeNull();
  });

  test('廣告中退場（sel null 但 ad-showing）→ 盡力還原到原文變體，不誤判成使用者切走', () => {
    const { native, selects, setSel, setAd } = loadEdge();
    native.syncEdge(TRACK, 'en');
    setAd(true);
    setSel(null); // 廣告期選軌回報 null——不是使用者切走
    native.standDown(true);
    expect(selects).toEqual(['']);
  });

  test('standDown(false)（nav/hot-swap 路徑）→ 清 transform、永不重選', () => {
    const { native, selects, tx } = loadEdge();
    native.syncEdge(TRACK, 'en');
    native.standDown(false);
    expect(tx.fn).toBeNull();
    expect(selects).toEqual([]);
    expect(native.isOn()).toBe(false);
  });

  test('還原重選被 player 拒絕（瞬時不可用）→ 不 throw（一次性路徑，log 警告即可）', () => {
    const { native, setSelectOk } = loadEdge();
    native.syncEdge(TRACK, 'en');
    setSelectOk(false);
    expect(() => native.standDown(true)).not.toThrow();
  });
});

describe('yk-capture transform seam (real-getter fake XHR)', () => {
  // The pool only accepts VALID per-word json3 (storeOriginal validates on the way in), so
  // every "original" body in these tests is real json3 with events.
  const VALID = '{"events":[{"tStartMs":0,"dDurationMs":100,"segs":[{"utf8":"hi"}]}]}';
  function setup() {
    const s = makeSandbox();
    s.XMLHttpRequest = makeFakeXhr(); // functional fake with real responseText/response getters
    load(s, [
      'yk-di.js', 'yk-config.js', 'yk-log.js', 'yk-timing.js', 'yk-parse.js', 'yk-yt.js', 'yk-capture.js',
    ]);
    const di = s.window.__YK__;
    const capture = di.resolve('capture');
    capture.install();
    return { s, capture, CAP: s.window.__YK_CAP__ };
  }
  function fetchAsr(s, url, body) {
    const xhr = new s.XMLHttpRequest();
    xhr.open('GET', url);
    xhr.send();
    xhr.__fireLoad(body); // simulate readyState 4 + 'load'
    return xhr;
  }

  test('no transform: the player reads the ORIGINAL and __YK_CAP__ stores the original', () => {
    const { s, CAP } = setup();
    const xhr = fetchAsr(s, ASR_URL, VALID);
    expect(xhr.responseText).toBe(VALID);
    expect(CAP.get(ASR_URL)).toBe(VALID);
  });

  test('registerTransform: the player reads COOKED while __YK_CAP__ still keeps the ORIGINAL', () => {
    const { s, capture, CAP } = setup();
    capture.registerTransform((url, orig) => 'COOKED:' + orig);
    const xhr = fetchAsr(s, ASR_URL, VALID);
    expect(xhr.responseText).toBe('COOKED:' + VALID);
    expect(CAP.get(ASR_URL)).toBe(VALID); // pool must hold the ORIGINAL, never the cooked
  });

  test('clearTransform: back to a byte-identical no-op', () => {
    const { s, capture } = setup();
    capture.registerTransform(() => 'COOKED');
    capture.clearTransform();
    const xhr = fetchAsr(s, ASR_URL, VALID);
    expect(xhr.responseText).toBe(VALID);
  });

  test('a throwing transform falls back to the original (never breaks the player)', () => {
    const { s, capture } = setup();
    capture.registerTransform(() => {
      throw new Error('boom');
    });
    const xhr = fetchAsr(s, ASR_URL, VALID);
    expect(xhr.responseText).toBe(VALID);
  });

  test('an INVALID body never enters the pool (kills the per-tick warn spam at the source)', () => {
    const { s, CAP } = setup();
    fetchAsr(s, ASR_URL, '{"events":[]}'); // valid JSON but no events
    fetchAsr(s, ASR_URL + '&x=1', 'not json at all'); // unparseable
    fetchAsr(s, ASR_URL + '&x=2', ''); // empty
    expect(CAP.size).toBe(0);
  });

  test('responseType "json": pool keeps the original string and the cook still applies via .response', () => {
    const { s, capture, CAP } = setup();
    capture.registerTransform((url, orig) => JSON.stringify({ cooked: JSON.parse(orig) }));
    const xhr = new s.XMLHttpRequest();
    xhr.responseType = 'json';
    xhr.open('GET', ASR_URL);
    xhr.send();
    xhr.__fireLoad(VALID);
    expect(xhr.response).toEqual({ cooked: JSON.parse(VALID) }); // player gets the cooked, parsed
    expect(CAP.get(ASR_URL)).toBe(VALID); // pool stores the ORIGINAL (read via the native getter)
  });

  test('a transform registered AFTER send() (before load) still applies — tx.fn is read dynamically', () => {
    const { s, capture } = setup();
    const xhr = new s.XMLHttpRequest();
    xhr.open('GET', ASR_URL);
    xhr.send(); // 此刻還沒有 transform
    capture.registerTransform((url, orig) => 'LATE:' + orig);
    xhr.__fireLoad(VALID);
    expect(xhr.responseText).toBe('LATE:' + VALID);
  });

  test('hot-swap yk-capture：一次性安裝的補丁改讀新 resolve 的邏輯（__YK_NETIMPL__ 重指）', () => {
    const { s, capture, CAP } = setup();
    const storeBefore = s.window.__YK_NETIMPL__.storeOriginal;
    // 模擬 MCP 熱抽換：boot 後重新 eval 模組檔 → di.register 觸發真正的 hotSwap 路徑
    s.window.__YK__.start('capture');
    load(s, ['yk-capture.js']);
    const capture2 = s.window.__YK__.resolve('capture');
    expect(capture2).not.toBe(capture); // 新實例
    expect(s.window.__YK_NETIMPL__.storeOriginal).not.toBe(storeBefore); // impl 已重指
    // 直接證明凍結的補丁閉包是「透過全域」呼叫，不是抓走一份舊拷貝：
    // 換掉 impl.storeOriginal，接著的 XHR 必須打到替身。
    const seen = [];
    const real = s.window.__YK_NETIMPL__.storeOriginal;
    s.window.__YK_NETIMPL__.storeOriginal = (u, t) => { seen.push(u); real(u, t); };
    capture2.registerTransform((u, o) => 'HS:' + o);
    const url = ASR_URL + '&hs=1';
    const xhr = fetchAsr(s, url, VALID);
    expect(seen).toContain(url); // 補丁走的是現任 impl
    expect(xhr.responseText).toBe('HS:' + VALID); // 新實例的 transform 生效
    expect(CAP.get(url)).toBe(VALID); // 池照樣只存原始
  });
});

describe('yk-capture fetch 路徑（假 fetch + 最小 Response 仿製品）', () => {
  const VALID = '{"events":[{"tStartMs":0,"dDurationMs":100,"segs":[{"utf8":"hi"}]}]}';
  function setupFetch() {
    const s = makeSandbox();
    // capture 只用到 res.clone().text()、new Response(body, init)、回傳值的 .text()
    function FakeResponse(body, init = {}) {
      this._body = String(body);
      this.status = init.status ?? 200;
      this.statusText = init.statusText ?? '';
    }
    FakeResponse.prototype.clone = function () { return new FakeResponse(this._body, this); };
    FakeResponse.prototype.text = function () { return Promise.resolve(this._body); };
    s.Response = FakeResponse;
    let nextBody = VALID;
    const upstream = [];
    s.window.fetch = (...args) => {
      upstream.push(args[0]);
      return Promise.resolve(new FakeResponse(nextBody));
    };
    load(s, ['yk-di.js', 'yk-config.js', 'yk-log.js', 'yk-timing.js', 'yk-parse.js', 'yk-yt.js', 'yk-capture.js']);
    const di = s.window.__YK__;
    const capture = di.resolve('capture');
    capture.install();
    return {
      s, capture, upstream,
      CAP: s.window.__YK_CAP__,
      setBody: (b) => { nextBody = b; },
      fetch: (url) => s.window.fetch(url),
    };
  }

  test('無 transform：回傳原 Response 物件本身，池存原始', async () => {
    const { fetch, CAP } = setupFetch();
    const res = await fetch(ASR_URL);
    expect(await res.text()).toBe(VALID);
    expect(CAP.get(ASR_URL)).toBe(VALID);
  });

  test('有 transform：呼叫端拿到 cooked Response，池仍存原始', async () => {
    const { fetch, capture, CAP } = setupFetch();
    capture.registerTransform((u, o) => 'COOKED:' + o);
    const res = await fetch(ASR_URL);
    expect(await res.text()).toBe('COOKED:' + VALID);
    expect(CAP.get(ASR_URL)).toBe(VALID);
  });

  test('非 asr URL：直接放行、不碰池', async () => {
    const { fetch, CAP, upstream } = setupFetch();
    await fetch('https://www.youtube.com/api/timedtext?v=abc&lang=en'); // 無 kind=asr（手動軌）
    await fetch('https://example.com/other');
    expect(CAP.size).toBe(0);
    expect(upstream).toHaveLength(2); // 都有真的往下打
  });

  test('無效 body 不入池（與 XHR 路徑同一入池驗證）', async () => {
    const { fetch, CAP, setBody } = setupFetch();
    setBody('{"events":[]}');
    await fetch(ASR_URL);
    setBody('not json');
    await fetch(ASR_URL + '&x=1');
    expect(CAP.size).toBe(0);
  });
});
