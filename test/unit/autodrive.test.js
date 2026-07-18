// UNIT (Jest) — 429/壞回應感知：yk-capture 的 per-variant 失敗台帳 + yk-autodrive 的
// stall 指數退避。實際案例：YouTube 對 tlang=（自動翻譯）timedtext 回 429 限流，body
// 永不入池；先前 stall-rekick 每 ~10s 盲踢 ×8，對已限流端點連打只會延長封鎖。
const { makeSandbox, load, makeFakeXhr } = require('../_helpers');

const ASR = (tlang) =>
  'https://www.youtube.com/api/timedtext?v=abc&kind=asr&lang=en&fmt=json3' +
  (tlang ? '&tlang=' + tlang : '');
const GOOD_BODY = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hi' }] }] });

describe('yk-capture — 壞回應台帳（real-getter fake XHR）', () => {
  function setup() {
    const s = makeSandbox();
    s.XMLHttpRequest = makeFakeXhr();
    load(s, ['yk-di.js', 'yk-config.js', 'yk-log.js', 'yk-timing.js', 'yk-parse.js', 'yk-yt.js', 'yk-capture.js']);
    const capture = s.window.__YK__.resolve('capture');
    capture.install();
    const fire = (url, body, status) => {
      const xhr = new s.XMLHttpRequest();
      xhr.open('GET', url);
      if (status != null) xhr.status = status;
      xhr.send();
      xhr.__fireLoad(body);
    };
    const start = (url) => {
      const xhr = new s.XMLHttpRequest();
      xhr.open('GET', url);
      xhr.send();
      return xhr;
    };
    return { capture, fire, start };
  }
  const track = { languageCode: 'en' };

  test('429 空回應入台帳：status 與連續次數按變體累計，URL 輪替不歸零', () => {
    const { capture, fire } = setup();
    expect(capture.lastFailure(track, 'zh-Hans')).toBeNull();
    fire(ASR('zh-Hans') + '&pot=AAA', '', 429);
    expect(capture.lastFailure(track, 'zh-Hans')).toEqual({ status: 429, count: 1 });
    fire(ASR('zh-Hans') + '&pot=BBB', '', 429); // pot/expire 輪替＝不同 URL、同變體
    expect(capture.lastFailure(track, 'zh-Hans')).toEqual({ status: 429, count: 2 });
    // 只算自己的變體：原文不受翻譯的失敗影響
    expect(capture.lastFailure(track, '')).toBeNull();
  });

  test('成功入池即清帳；200 但空 body（pot 失手）也算失敗', () => {
    const { capture, fire } = setup();
    fire(ASR(''), '', 200); // 200 空 body：storeOriginal 擋下 → 失敗
    expect(capture.lastFailure(track, '')).toEqual({ status: 200, count: 1 });
    fire(ASR(''), GOOD_BODY, 200);
    expect(capture.lastFailure(track, '')).toBeNull(); // 清帳
    expect(capture.hasCapturedVariant(track, '')).toBe(true);
  });

  test('在途台帳：send 起算、loadend 結清；abort 也結清且不入失敗台帳', () => {
    const { capture, start } = setup();
    expect(capture.inFlight(track, 'zh-Hans')).toBe(false);
    const xhr = start(ASR('zh-Hans'));
    expect(capture.inFlight(track, 'zh-Hans')).toBe(true);
    expect(capture.inFlight(track, '')).toBe(false); // 只算自己的變體
    xhr.abort(); // 播放器把在途請求換掉（session 重建／選軌更替）
    expect(capture.inFlight(track, 'zh-Hans')).toBe(false);
    expect(capture.lastFailure(track, 'zh-Hans')).toBeNull(); // 無伺服器裁決，不記失敗
    const xhr2 = start(ASR('zh-Hans'));
    xhr2.__fireLoad(GOOD_BODY);
    expect(capture.inFlight(track, 'zh-Hans')).toBe(false);
    expect(capture.hasCapturedVariant(track, 'zh-Hans')).toBe(true);
  });
});

describe('yk-autodrive — stall 重踢按壞回應台帳指數退避（mock 注入 deps）', () => {
  const STALL_TICKS = 600; // 與 yk-autodrive 的常數同步（60fps ≈ 10s）

  function setup(failure, opts = {}) {
    const s = makeSandbox();
    load(s, ['yk-di.js']);
    const di = s.window.__YK__;
    const selects = [];
    const state = { inFlight: opts.inFlight || (() => false) };
    di.register('log', [], () => ({ info() {}, warn() {}, error() {}, variant: (l, t) => (t ? l + '→' + t : l) }));
    di.register('settings', [], () => ({ current: { autoDualLang: 'zh-Hans' } }));
    di.register('yt', [], () => ({
      currentVideoId: () => 'abc',
      isAdShowing: () => false,
      // 永遠停在目標變體上、body 永不到（429 情境）；select 都被接受
      currentAsrSelection: () => ({ tlang: 'zh-Hans' }),
      selectAsrVariant: (_t, tlang) => (selects.push(tlang), true),
    }));
    di.register('capture', [], () => ({
      hasCapturedVariant: (_t, tlang) => tlang === '', // 原文已入池，翻譯永遠缺
      lastFailure: () => failure,
      inFlight: (...a) => state.inFlight(...a),
    }));
    load(s, ['yk-autodrive.js']);
    return { drive: di.resolve('autodrive').drive, selects, state };
  }
  const track = { languageCode: 'en' };

  function ticksUntilRekick(drive, selects) {
    // 第一次 drive 走 start→trans（select 目標）；其後每 tick 進 stall 計數。
    drive(track, 'en');
    const afterArm = selects.length;
    for (let t = 1; t <= STALL_TICKS * 4 + 10; t++) {
      drive(track, 'en');
      if (selects.length > afterArm) return t;
    }
    return Infinity;
  }

  test('無失敗紀錄：維持原門檻（STALL_TICKS 個 tick 後重踢）', () => {
    const { drive, selects } = setup(null);
    expect(ticksUntilRekick(drive, selects)).toBe(STALL_TICKS);
  });

  test('連續 2 次 429：門檻翻 4 倍（2^count），不再 10 秒盲踢', () => {
    const { drive, selects } = setup({ status: 429, count: 2 });
    expect(ticksUntilRekick(drive, selects)).toBe(STALL_TICKS * 4);
  });

  test('在途守門：目標變體請求還在路上時一律不 setOption（不取消、不燒配額）', () => {
    // 例如播放器自己還原字幕偏好的初始 fetch 還在飛：autodrive 不得搶著重選。
    const { drive, selects, state } = setup(null, { inFlight: (_t, tlang) => tlang === 'zh-Hans' });
    for (let t = 0; t <= STALL_TICKS * 2; t++) drive(track, 'en');
    expect(selects).toHaveLength(0); // start 相位的首選被守門擋下、相位原地等待
    state.inFlight = () => false; // 請求落地：下一 tick 恢復驅動
    drive(track, 'en');
    expect(selects).toEqual(['zh-Hans']);
  });
});
