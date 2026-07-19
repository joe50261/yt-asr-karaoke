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

  test('在途台帳涵蓋所有 timedtext（含手動軌）；abort 結清且不入失敗台帳', () => {
    const { capture, start } = setup();
    expect(capture.anyInFlight()).toBe(false);
    // 手動軌（name=…、無 kind=asr）：播放器偏好還原的初始載入常是這種——守門必須看得到，
    // 否則 autodrive 的 setOption 照樣把它撞掉。
    const manual = start('https://www.youtube.com/api/timedtext?v=abc&lang=en&name=Default&tlang=zh-Hans&fmt=json3');
    expect(capture.anyInFlight()).toBe(true);
    manual.abort(); // 被選軌變更／session 重建換掉
    expect(capture.anyInFlight()).toBe(false);
    expect(capture.lastFailure(track, 'zh-Hans')).toBeNull(); // 無伺服器裁決，不記失敗
    const xhr2 = start(ASR('zh-Hans'));
    expect(capture.anyInFlight()).toBe(true);
    xhr2.__fireLoad(GOOD_BODY);
    expect(capture.anyInFlight()).toBe(false);
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
    const state = { anyInFlight: opts.anyInFlight || (() => false), ps: opts.playerState ?? 1 };
    const hasCaptured = opts.hasCaptured || ((_t, tlang) => tlang === '');
    di.register('log', [], () => ({ info() {}, warn() {}, error() {}, variant: (l, t) => (t ? l + '→' + t : l) }));
    di.register('settings', [], () => ({ current: { autoDualLang: 'zh-Hans' } }));
    di.register('yt', [], () => ({
      currentVideoId: () => 'abc',
      isAdShowing: () => false,
      // 永遠停在目標變體上、body 永不到（429 情境）；select 都被接受
      currentAsrSelection: () => ({ tlang: 'zh-Hans' }),
      // 預設已在播放（ps=1）：初始化窗守門（played gate）放行，本組聚焦節流語義
      captionState: () => ({ off: false, lang: 'en', kind: 'asr', name: '', tlang: 'zh-Hans', playerState: state.ps, t: 0, ad: false }),
      selectAsrVariant: (_t, tlang) => (selects.push(tlang), true),
    }));
    di.register('capture', [], () => ({
      hasCapturedVariant: (...a) => hasCaptured(...a), // 預設：原文已入池，翻譯永遠缺
      lastFailure: () => failure,
      anyInFlight: () => state.anyInFlight(),
    }));
    load(s, ['yk-watch.js', 'yk-autodrive.js']);
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

  test('在途守門：本影片任何字幕請求在路上時一律不 setOption（不取消、不燒配額）', () => {
    // 例如播放器自己還原字幕偏好的初始 fetch（可能是手動軌）還在飛：autodrive 不得
    // 搶著選軌——setOption 會 abort 它，伺服器端已計入配額。
    const { drive, selects, state } = setup(null, { anyInFlight: () => true });
    for (let t = 0; t <= STALL_TICKS * 2; t++) drive(track, 'en');
    expect(selects).toHaveLength(0); // start 相位的首選被守門擋下、相位原地等待
    state.anyInFlight = () => false; // 請求落地：下一 tick 恢復驅動
    drive(track, 'en');
    expect(selects).toEqual(['zh-Hans']);
  });

  test('初始化窗守門：播放器進入播放（ps=1）前不驅動——內建偏好還原到播放開始前才收尾，先動必 race', () => {
    // 實測（2026-07-18 log）：固定 ~2s 時間讓路在 buffering 中就期滿開驅動，內建 init
    // 的最後一手（偏好還原）在 buffering→playing 轉移前 ~160ms 才落，把我們蓋掉。
    // 唯一可靠的「內建已出完手」訊號是本影片首次進入播放。
    const { drive, selects, state } = setup(null, { hasCaptured: () => false, playerState: 3 });
    for (let t = 0; t < 500; t++) drive(track, 'en'); // buffering 多久都不動（窗多長由播放器決定）
    expect(selects).toHaveLength(0);
    state.ps = 1; // 播放開始＝內建 init 已收尾
    drive(track, 'en');
    expect(selects).toEqual(['']);
  });

  test('初始化窗守門：池裡已有 body 也一樣等播放——內建的最後一手不看池，照樣蓋', () => {
    const { drive, selects, state } = setup(null, { playerState: 3 }); // 原文已入池（跨導航快取）
    for (let t = 0; t < 300; t++) drive(track, 'en');
    expect(selects).toHaveLength(0);
    state.ps = 1;
    drive(track, 'en');
    expect(selects).toEqual(['zh-Hans']); // 原文在池：播放後直接切目標
  });
});

describe('yk-autodrive — done 後對帳（reseed，後備）：播放中段重置回選、使用者換軌尊重', () => {
  // init 收尾的重置由初始化窗守門在源頭消滅（不 race）；reseed 只留給播放中段的
  // 重置（廣告邊界等不明生命週期點）：偏離開始貼近生命週期錨點→回選，穩態偏離
  // ＝使用者換軌→尊重。本套件驗證 reconcile 的錨點歸因。
  const WINDOW = 300; // 與 yk-autodrive 的 RESEED_WINDOW_TICKS 同步（~5s）

  function setup() {
    const s = makeSandbox();
    load(s, ['yk-di.js']);
    const di = s.window.__YK__;
    const selects = [];
    const warns = [];
    // st.sel = currentAsrSelection 的回值；st.cs = captionState 快照（watch 與 reconcile 共用）
    const st = {
      sel: { tlang: 'zh-Hans' }, // 初始即在目標上：start 相位直接收 done，不發 select
      // ps=1（播放中）：初始化窗守門已過——reseed 只管播放中段的重置
      cs: { off: false, lang: 'en', kind: 'asr', name: '', tlang: 'zh-Hans', playerState: 1, t: 0, ad: false },
    };
    di.register('log', [], () => ({
      info() {},
      warn: (...a) => warns.push(a.join(' ')),
      error() {},
      variant: (l, t) => (t ? (l || '?') + '→' + t : l || '?'),
    }));
    di.register('settings', [], () => ({ current: { autoDualLang: 'zh-Hans' } }));
    di.register('yt', [], () => ({
      currentVideoId: () => 'abc',
      isAdShowing: () => false,
      currentAsrSelection: () => st.sel,
      captionState: () => (st.cs ? { ...st.cs } : null),
      selectAsrVariant: (_t, tlang) => {
        selects.push(tlang);
        st.sel = { tlang }; // select 落地（簡化為即時）：選擇回到 asr 變體上
        st.cs = { ...st.cs, kind: 'asr', name: '', tlang };
        return true;
      },
    }));
    di.register('capture', [], () => ({
      hasCapturedVariant: () => true, // 兩個 body 都已入池
      lastFailure: () => null,
      anyInFlight: () => false,
    }));
    load(s, ['yk-watch.js', 'yk-autodrive.js']);
    const watch = di.resolve('watch');
    const autodrive = di.resolve('autodrive');
    // 引擎的每 frame 順序：watch.tick() 先、autodrive.drive() 後
    const tick = () => {
      watch.tick();
      autodrive.drive(track, 'en');
    };
    // 播放器自己重置：選擇離開我們的 asr 軌（手動軌＋記住的翻譯），字幕仍開著
    const playerReset = () => {
      st.sel = null;
      st.cs = { ...st.cs, kind: '', name: 'Default', tlang: 'zh-Hans' };
    };
    return { tick, st, selects, warns, playerReset };
  }
  const track = { languageCode: 'en' };

  test('播放中段重置、ps 轉移晚 ~10 tick 才來 → 晚到的錨照樣把偏離標成重置並回選', () => {
    // 錨可晚到：實測 init 收尾的重置早於 ps 轉移 ~160ms——中段重置（廣告邊界等）
    // 同樣可能先重置後轉移，窗內逐 tick 續判補得到。
    const { tick, st, selects, warns, playerReset } = setup();
    for (let i = 0; i < WINDOW + 100; i++) tick(); // 走出 baseline/done 錨的窗，進穩態
    expect(selects).toHaveLength(0); // done 一路安靜
    playerReset();
    for (let i = 0; i < 10; i++) tick(); // 錨未到：先不動（區分不了使用者換軌）
    expect(selects).toHaveLength(0);
    st.cs = { ...st.cs, playerState: 3 }; // playing→buffering：錨到了
    tick();
    expect(selects).toEqual(['zh-Hans']); // 同 tick 回選目標
    expect(warns.some((l) => l.includes('reseed') && l.includes('manual en→zh-Hans "Default"'))).toBe(true);
  });

  test('done 剛落地即被重置：done 錨在窗內 → 立即回選', () => {
    const { tick, selects, playerReset } = setup();
    for (let i = 0; i < 66; i++) tick(); // done 後 ~1.1s
    playerReset();
    tick();
    expect(selects).toEqual(['zh-Hans']);
  });

  test('穩態偏離（使用者換軌）：窗內無錨 → 永不回選；窗過期後晚來的 ps 轉移也不追溯', () => {
    const { tick, st, selects, playerReset } = setup();
    for (let i = 0; i < WINDOW + 100; i++) tick();
    playerReset();
    for (let i = 0; i < WINDOW + 10; i++) tick(); // 偏離窗過期：這次偏離定性為使用者動作
    st.cs = { ...st.cs, playerState: 2 }; // 之後使用者暫停（新錨）
    for (let i = 0; i < 10; i++) tick();
    expect(selects).toHaveLength(0); // 不因新錨翻案
  });

  test('字幕被關（off）＝使用者意志：任何錨都不回選', () => {
    const { tick, st, selects } = setup();
    for (let i = 0; i < 10; i++) tick();
    st.sel = null;
    st.cs = { ...st.cs, off: true, lang: '', kind: '', tlang: '', playerState: 3 }; // 錨與關字幕同時發生也一樣
    for (let i = 0; i < 20; i++) tick();
    expect(selects).toHaveLength(0);
  });

  test('回選上限：連續重置最多回選 MAX_RESEEDS（3）次，之後尊重外部狀態', () => {
    const { tick, st, selects, playerReset } = setup();
    tick(); // done
    for (let round = 0; round < 5; round++) {
      playerReset();
      st.cs = { ...st.cs, playerState: round % 2 ? 3 : 1 }; // 每輪伴隨 ps 轉移（錨）
      for (let i = 0; i < 5; i++) tick();
    }
    expect(selects).toEqual(['zh-Hans', 'zh-Hans', 'zh-Hans']); // 3 次封頂
  });
});
