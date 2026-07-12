// UNIT (Jest) — settings hub + in-page panel + yt runtime assert, via mock-injected deps
// (DI 的核心方法論：注入 mock 隔離測模組行為)。real DOM geometry/lifecycle → e2e-a。
const { makeSandbox, makeDom, load } = require('../_helpers');

const PANEL_ID = 'yt-karaoke-panel';
const PANEL_BTN_ID = 'yt-karaoke-panel-btn';

describe('yk-settings.apply — the one write path (mutate current + relay to bridge)', () => {
  function setup() {
    const s = makeSandbox();
    const posted = [];
    s.window.postMessage = (msg) => posted.push(msg);
    load(s, ['yk-di.js', 'yk-config.js', 'yk-settings.js']);
    return { settings: s.window.__YK__.resolve('settings'), posted };
  }

  test('mutates current in place AND posts __ykSettingsSet with the coerced value', () => {
    const { settings, posted } = setup();
    posted.length = 0;
    settings.apply({ dualTrack: true });
    expect(settings.current.dualTrack).toBe(true); // live this frame, no round-trip
    const sets = posted.filter((m) => m.__ykSettingsSet);
    expect(sets).toHaveLength(1);
    expect(sets[0].settings).toEqual({ dualTrack: true });
  });

  test('coerces like the bridge push (captionStyle "" → default, autoDualLang undefined → "")', () => {
    const { settings } = setup();
    settings.apply({ captionStyle: '' });
    expect(settings.current.captionStyle).toBe('default');
    settings.apply({ autoDualLang: undefined });
    expect(settings.current.autoDualLang).toBe('');
  });

  test('coerces nativeMode to a boolean (undefined → false, truthy → true)', () => {
    const { settings } = setup();
    expect(settings.current.nativeMode).toBe(false); // default
    settings.apply({ nativeMode: 1 });
    expect(settings.current.nativeMode).toBe(true);
    settings.apply({ nativeMode: undefined });
    expect(settings.current.nativeMode).toBe(false);
  });

  test('ignores unknown keys (a UI bug cannot smuggle arbitrary keys into storage)', () => {
    const { settings, posted } = setup();
    posted.length = 0;
    settings.apply({ bogus: 1, dualTrack: true });
    const sets = posted.filter((m) => m.__ykSettingsSet);
    expect(sets[0].settings).toEqual({ dualTrack: true }); // bogus dropped
    expect(settings.current.bogus).toBeUndefined();
  });

  test('enabled（Karaoke 主開關）走 hub：預設開，缺值正規化為開', () => {
    const { settings } = setup();
    expect(settings.current.enabled).toBe(true);
    settings.apply({ enabled: false });
    expect(settings.current.enabled).toBe(false);
    settings.apply({ enabled: undefined }); // 缺值＝開（v !== false）
    expect(settings.current.enabled).toBe(true);
  });

  test('dualDisplayKeys — 雙軌顯示政策的唯一定義點（engine bind 序與 native.cook 列序同源）', () => {
    const { settings } = setup();
    expect(settings.dualDisplayKeys('')).toEqual(['']); // 原文選擇永遠單列
    expect(settings.dualDisplayKeys('zh-Hant')).toEqual(['zh-Hant']); // dualTrack 關：單列
    settings.apply({ dualTrack: true });
    expect(settings.dualDisplayKeys('zh-Hant')).toEqual(['', 'zh-Hant']); // 預設原文在上
    settings.apply({ translationOnTop: true });
    expect(settings.dualDisplayKeys('zh-Hant')).toEqual(['zh-Hant', '']); // 譯文在上
    expect(settings.dualDisplayKeys('')).toEqual(['']); // dual 開但沒選譯文：仍單列
  });
});

describe('yk-panel — in-page settings menu (mock-injected settings + yt)', () => {
  function setup(opts = {}) {
    const s = makeSandbox();
    const dom = makeDom();
    s.document = dom.document;
    const player = dom.el('div');
    s.document.querySelector = (sel) =>
      sel === '#movie_player' || sel === '.html5-video-player' ? player : null;
    load(s, ['yk-di.js', 'yk-config.js', 'yk-ui.js']);
    const di = s.window.__YK__;
    const applied = [];
    const current = Object.assign(
      { dualTrack: false, captionStyle: 'default', translationOnTop: false, autoDualLang: '' },
      opts.current,
    );
    di.register('settings', [], () => ({
      current,
      apply: (p) => { applied.push(p); Object.assign(current, p); },
    }));
    let tls = opts.tls || [
      { code: 'zh-Hant', name: '中文（繁體）' },
      { code: 'ja', name: '日文' },
    ];
    di.register('yt', [], () => ({
      getPlayerEl: () => player,
      translationLanguages: () => tls,
    }));
    load(s, ['yk-panel.js']);
    return {
      s, dom, player, applied, current,
      panel: di.resolve('panel'),
      setTls: (v) => { tls = v; },
      $: (id) => s.document.getElementById(id),
    };
  }

  test('ensureButton mounts exactly one ⚙ gear on the player; idempotent', () => {
    const { panel, player, $ } = setup();
    panel.ensureButton();
    panel.ensureButton();
    const gear = $(PANEL_BTN_ID);
    expect(gear).toBeTruthy();
    expect(gear.textContent).toBe('⚙');
    expect(player.children.filter((c) => c.id === PANEL_BTN_ID)).toHaveLength(1);
  });

  test('clicking the gear opens the panel and builds the five controls', () => {
    const { panel, $ } = setup();
    panel.ensureButton();
    $(PANEL_BTN_ID).dispatch('click');
    const card = $(PANEL_ID);
    expect(card.dataset.open).toBe('true');
    expect(card.querySelector('#yk-set-native')).toBeTruthy();
    expect(card.querySelector('#yk-set-style')).toBeTruthy();
    expect(card.querySelector('#yk-set-dual')).toBeTruthy();
    expect(card.querySelector('#yk-set-autolang')).toBeTruthy();
    expect(card.querySelector('#yk-set-transtop')).toBeTruthy();
    // clicking again closes
    $(PANEL_BTN_ID).dispatch('click');
    expect(card.dataset.open).toBe('false');
  });

  test('each control writes ONLY its own key via settings.apply (keys stay orthogonal)', () => {
    const { panel, applied, $ } = setup();
    panel.ensureButton();
    panel.setOpen(true);
    const style = $('yk-set-style');
    style.value = 'advanced';
    style.dispatch('change');
    expect(applied.at(-1)).toEqual({ captionStyle: 'advanced' });

    const dual = $('yk-set-dual');
    dual.checked = true;
    dual.dispatch('change');
    expect(applied.at(-1)).toEqual({ dualTrack: true });

    // autoDualLang must NOT touch dualTrack (auto-DRIVE vs dual DISPLAY are orthogonal)
    const lang = $('yk-set-autolang');
    lang.value = 'ja';
    lang.dispatch('change');
    expect(applied.at(-1)).toEqual({ autoDualLang: 'ja' });

    const top = $('yk-set-transtop');
    top.checked = true;
    top.dispatch('change');
    expect(applied.at(-1)).toEqual({ translationOnTop: true });

    // the playback-mode switch writes ONLY nativeMode (orthogonal to every display key)
    const nativeSw = $('yk-set-native');
    nativeSw.checked = true;
    nativeSw.dispatch('change');
    expect(applied.at(-1)).toEqual({ nativeMode: true });
  });

  test('on open, the Auto-translate menu is built from yt.translationLanguages() (關閉 + langs)', () => {
    const { panel, $ } = setup();
    panel.ensureButton();
    panel.setOpen(true);
    const lang = $('yk-set-autolang');
    const opts = lang.querySelectorAll('option').map((o) => [o.value, o.textContent]);
    expect(opts).toEqual([['', '關閉'], ['zh-Hant', '中文（繁體）'], ['ja', '日文']]);
  });

  test('on open, controls reflect settings.current; a saved target no longer offered falls back to 關閉', () => {
    const { panel, $ } = setup({
      current: { dualTrack: true, captionStyle: 'yt', translationOnTop: true, autoDualLang: 'fr' },
      tls: [{ code: 'zh-Hant', name: '中文（繁體）' }], // fr not offered
    });
    panel.ensureButton();
    panel.setOpen(true);
    expect($('yk-set-style').value).toBe('yt');
    expect($('yk-set-dual').checked).toBe(true);
    expect($('yk-set-transtop').checked).toBe(true);
    expect($('yk-set-autolang').value).toBe(''); // stale fr → 退回 關閉
  });

  test('language list is read live on each open (empty before captions, fills once available)', () => {
    const { panel, setTls, $ } = setup({ tls: [] });
    panel.ensureButton();
    panel.setOpen(true);
    expect($('yk-set-autolang').querySelectorAll('option').map((o) => o.value)).toEqual(['']);
    panel.setOpen(false);
    setTls([{ code: 'de', name: '德文' }]);
    panel.setOpen(true);
    expect($('yk-set-autolang').querySelectorAll('option').map((o) => o.value)).toEqual(['', 'de']);
  });

  test('remove() tears down both the gear and the card', () => {
    const { panel, $ } = setup();
    panel.ensureButton();
    panel.setOpen(true);
    expect($(PANEL_BTN_ID)).toBeTruthy();
    expect($(PANEL_ID)).toBeTruthy();
    panel.remove();
    expect($(PANEL_BTN_ID)).toBeNull();
    expect($(PANEL_ID)).toBeNull();
  });

  test('原生播放 ON 時字幕樣式 select 停用但保值；面板開著切換開關立即反映', () => {
    const { panel, $ } = setup({ current: { nativeMode: true, captionStyle: 'yt' } });
    panel.ensureButton();
    panel.setOpen(true);
    const style = $('yk-set-style');
    expect(style.disabled).toBe(true); // overlay-only 控件在 native 模式凍結
    expect(style.value).toBe('yt'); // 只凍結、不清值：關掉 native 後 preset 原樣回來
    const sw = $('yk-set-native');
    sw.checked = false;
    sw.dispatch('change'); // 不重開面板，跨控件效果要立即出現
    expect(style.disabled).toBe(false);
    sw.checked = true;
    sw.dispatch('change');
    expect(style.disabled).toBe(true);
  });
});

describe('yk-yt — runtime assert (mock player DOM)', () => {
  function ytWith(tls) {
    const s = makeSandbox();
    let lastSet = null;
    const player = {
      getOption: (_m, k) => (k === 'tracklist' ? [{ kind: 'asr', languageCode: 'en' }] : k === 'translationLanguages' ? tls : null),
      setOption: (_m, _k, v) => { lastSet = v; },
    };
    s.document.querySelector = (sel) => (sel === '#movie_player' || sel === '.html5-video-player' ? player : null);
    load(s, ['yk-di.js', 'yk-config.js', 'yk-yt.js']);
    return { yt: s.window.__YK__.resolve('yt'), get lastSet() { return lastSet; } };
  }

  test('translationLanguages normalizes to {code,name}', () => {
    const { yt } = ytWith([{ languageCode: 'zh-Hant', languageName: '中文（繁體）' }]);
    expect(yt.translationLanguages()).toEqual([{ code: 'zh-Hant', name: '中文（繁體）' }]);
  });

  test('selectAsrVariant drives a VALID tlang with the player real tl object', () => {
    const ctx = ytWith([{ languageCode: 'zh-Hant', languageName: '中文（繁體）' }]);
    expect(ctx.yt.selectAsrVariant({ languageCode: 'en' }, 'zh-Hant')).toBe(true);
    expect(ctx.lastSet.translationLanguage.languageCode).toBe('zh-Hant');
  });

  test('selectAsrVariant REFUSES a tlang the player does not offer (no fabrication)', () => {
    const ctx = ytWith([{ languageCode: 'zh-Hant', languageName: '中文（繁體）' }]);
    expect(ctx.yt.selectAsrVariant({ languageCode: 'en' }, 'xx-bogus')).toBe(false);
    expect(ctx.lastSet).toBeNull();
  });
});

describe('yk-yt — getPlayerResponse 驗影片身分（SPA 導航的殭屍 ytInitialPlayerResponse）', () => {
  // location 固定在 ?v=abc（makeSandbox）——候選 response 以 videoDetails.videoId 對 URL。
  function ytWithResponses({ initial, live, hasPlayer = true } = {}) {
    const s = makeSandbox();
    if (initial !== undefined) s.window.ytInitialPlayerResponse = initial;
    const player = {
      getPlayerResponse: () => (typeof live === 'function' ? live() : live || null),
      classList: { contains: () => false },
    };
    s.document.querySelector = (sel) =>
      hasPlayer && (sel === '#movie_player' || sel === '.html5-video-player') ? player : null;
    load(s, ['yk-di.js', 'yk-config.js', 'yk-yt.js']);
    return { s, yt: s.window.__YK__.resolve('yt') };
  }

  test('SPA 導航後：拒用殭屍的 window.ytInitialPlayerResponse，改用播放器的 live response', () => {
    const fresh = { videoDetails: { videoId: 'abc' } };
    const stale = { videoDetails: { videoId: 'previous-video' } };
    const { yt } = ytWithResponses({ initial: stale, live: fresh });
    expect(yt.getPlayerResponse()).toBe(fresh); // 舊碼的 `initial || live` 會回 stale → 綁錯軌
  });

  test('整頁載入早期（播放器還沒好）：videoId 相符的 window global 照用', () => {
    const initial = { videoDetails: { videoId: 'abc' } };
    const { yt } = ytWithResponses({ initial, hasPlayer: false });
    expect(yt.getPlayerResponse()).toBe(initial);
  });

  test('兩個候選都不是本影片 → null（讓 waitForPlayerResponse 繼續等，不拿舊資料充數）', () => {
    const { yt } = ytWithResponses({
      initial: { videoDetails: { videoId: 'old-1' } },
      live: { videoDetails: { videoId: 'old-2' } },
    });
    expect(yt.getPlayerResponse()).toBeNull();
  });

  test('兩份都是本影片 → 以 live 為準（導航後它跟著播放器走）', () => {
    const tracks = { playerCaptionsTracklistRenderer: { captionTracks: [{ kind: 'asr' }] } };
    const live = { videoDetails: { videoId: 'abc' }, captions: tracks };
    const initial = { videoDetails: { videoId: 'abc' }, captions: tracks };
    const { yt } = ytWithResponses({ initial, live });
    expect(yt.getPlayerResponse()).toBe(live);
  });

  test('身分同、就緒不同：live 還沒長出字幕清單而 initial 已有 → 取 initial（不空等半熟的 live）', () => {
    const live = { videoDetails: { videoId: 'abc' } }; // 沒 captions
    const initial = {
      videoDetails: { videoId: 'abc' },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ kind: 'asr' }] } },
    };
    const { yt } = ytWithResponses({ initial, live });
    expect(yt.getPlayerResponse()).toBe(initial);
  });

  test('waitForPlayerResponse：導航殘留不早退，等到本影片的 tracklist 才 resolve', async () => {
    const s = makeSandbox();
    const polls = [];
    s.setInterval = (fn) => { polls.push(fn); return 1; };
    s.clearInterval = () => {};
    // 殭屍 global「有」字幕軌——舊碼會第一個 poll 就拿它 resolve（綁到上一支影片的軌）
    s.window.ytInitialPlayerResponse = {
      videoDetails: { videoId: 'previous-video' },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ kind: 'asr', languageCode: 'ja' }] } },
    };
    let live = null;
    const player = { getPlayerResponse: () => live, classList: { contains: () => false } };
    s.document.querySelector = (sel) =>
      sel === '#movie_player' || sel === '.html5-video-player' ? player : null;
    load(s, ['yk-di.js', 'yk-config.js', 'yk-yt.js']);
    const yt = s.window.__YK__.resolve('yt');
    let resolved;
    yt.waitForPlayerResponse(12000, () => true).then((pr) => { resolved = pr; });
    polls[0]();
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBeUndefined(); // 殭屍不算數：繼續等
    const fresh = {
      videoDetails: { videoId: 'abc' },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ kind: 'asr', languageCode: 'en' }] } },
    };
    live = fresh; // 新頁資料就緒：播放器的 response 換成本影片
    polls[0]();
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(fresh);
  });

  test('waitForPlayerResponse：廣告中不計時（前貼廣告可長於 limit，不得誤判成 idle）', async () => {
    const s = makeSandbox();
    const polls = [];
    s.setInterval = (fn) => { polls.push(fn); return 1; };
    s.clearInterval = () => {};
    let now = 0;
    s.Date = { now: () => now }; // 假時鐘：只有 Date.now 被用到
    let adShowing = true;
    const player = {
      getPlayerResponse: () => null, // response 一直沒來
      classList: { contains: (c) => c === 'ad-showing' && adShowing },
    };
    s.document.querySelector = (sel) =>
      sel === '#movie_player' || sel === '.html5-video-player' ? player : null;
    load(s, ['yk-di.js', 'yk-config.js', 'yk-yt.js']);
    const yt = s.window.__YK__.resolve('yt');
    let resolved;
    yt.waitForPlayerResponse(12000, () => true).then((pr) => { resolved = pr; });
    now = 50000; // 遠超 limit，但廣告中 → deadline 凍結（重設）
    polls[0]();
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBeUndefined();
    adShowing = false;
    now = 55000; // 廣告結束後 5s（< limit）：繼續等
    polls[0]();
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBeUndefined();
    now = 63000; // 廣告結束後 13s（> limit）：才逾時
    polls[0]();
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBeNull(); // 逾時把手上的（null）交回，由 engine 記 idle 原因
  });
});

describe('yk-engine — tick 的 native 分支 / 導航守門 / teardown（全 mock 注入）', () => {
  function setup() {
    const s = makeSandbox();
    const dom = makeDom();
    s.document = dom.document;
    const rafQ = [];
    s.requestAnimationFrame = (fn) => { rafQ.push(fn); return rafQ.length; };
    s.cancelAnimationFrame = () => {};
    const pollFns = []; // engine.start 的 1s 輪詢（URL fallback + enabled 邊緣）
    s.setInterval = (fn) => { pollFns.push(fn); return 1; };
    s.clearInterval = () => {};
    const player = dom.el('div');
    player.id = 'movie_player';
    load(s, ['yk-di.js', 'yk-config.js', 'yk-log.js', 'yk-ui.js']);
    const di = s.window.__YK__;
    const cur = { nativeMode: true, dualTrack: false, translationOnTop: false, autoDualLang: '' };
    di.register('settings', [], () => ({
      current: cur,
      apply: (p) => Object.assign(cur, p),
      // 契約替身：與 yk-settings.dualDisplayKeys 同約（政策本體在上方 settings describe 直測）
      dualDisplayKeys: (tlang) =>
        !cur.dualTrack || !tlang ? [tlang] : cur.translationOnTop ? [tlang, ''] : ['', tlang],
    }));
    const video = { currentTime: 5 };
    const track = { languageCode: 'en', kind: 'asr' };
    let vid = 'abc'; // 可變：導航窗口測試會把它換掉模擬 pushState 先行
    let pr = { captions: { playerCaptionsTracklistRenderer: { captionTracks: [track] } } }; // 可變：逾時測試會換成 null
    di.register('yt', [], () => ({
      isWatchPage: () => true,
      currentVideoId: () => vid,
      getPlayerEl: () => player,
      getVideo: () => video,
      isAdShowing: () => false,
      currentAsrSelection: () => ({ tlang: '' }),
      waitForPlayerResponse: () => Promise.resolve(pr),
      captionTracklist: (r) => r?.captions?.playerCaptionsTracklistRenderer || null,
      // 誠實替身：沒有 tracks 就沒有軌（engine 的 !track/idle 分支要能被走到）
      pickAutoCaptionTrack: (tracks) => (tracks && tracks.length ? track : null),
      waitForVideo: () => Promise.resolve(video),
      translationLanguages: () => [],
    }));
    di.register('capture', [], () => ({
      install() {},
      capturedJsonForVariant: () => ({ events: [{}] }),
      hasCapturedVariant: () => false,
      registerTransform() {}, clearTransform() {},
    }));
    di.register('parse', [], () => ({
      linesFromJson: () => [{ start: 0, end: 1000, text: 'x', words: [] }],
    }));
    const calls = { render: 0, overlayRemove: 0, sync: 0, hide: 0, ensure: 0, drives: 0, nativeSyncs: 0, autodriveResets: 0, nativeResets: 0 };
    di.register('styles', [], () => ({ inject() {} }));
    di.register('overlay', [], () => ({
      render: () => calls.render++, clear() {}, remove: () => calls.overlayRemove++, invalidate() {},
    }));
    di.register('transcript', [], () => ({
      ensureToggle: () => calls.ensure++, sync: () => calls.sync++, hide: () => calls.hide++, reset() {},
    }));
    di.register('autodrive', [], () => ({
      drive: () => calls.drives++,
      reset: () => calls.autodriveResets++,
    }));
    // native 的 mock：sync 把 on 拉到 nat.next（sync/reset 本體已在 native.test.js 隔離測過；
    // 這裡只驗 engine 對契約的使用：切換瞬間的 DOM 交接、isOn 分支、reset 呼叫）
    const nat = { on: false, next: true };
    di.register('native', [], () => ({
      isOn: () => nat.on,
      sync: () => { calls.nativeSyncs++; nat.on = nat.next; },
      reset: () => { calls.nativeResets++; nat.on = false; },
      enable() {}, disable() {},
    }));
    di.register('panel', [], () => ({ ensureButton() {} }));
    load(s, ['yk-engine.js']);
    const config = di.resolve('config');
    return {
      s, cur, calls, nat, rafQ, player, config,
      engine: di.resolve('engine'),
      $: (id) => s.document.getElementById(id),
      settle: () => new Promise((r) => setImmediate(r)),
      tick: () => { const fn = rafQ.shift(); if (fn) fn(); },
      poll: () => pollFns.forEach((f) => f()),
      setVid: (v) => { vid = v; },
      setPr: (v) => { pr = v; },
    };
  }

  async function started(ctx) {
    ctx.engine.start(); // readyState complete → 立即 run() → init()（兩個 await 已 resolve）
    await ctx.settle();
    await ctx.settle();
    expect(ctx.rafQ.length).toBeGreaterThan(0); // render loop 已排上
  }

  test('native 分支：不 engage、不畫 overlay，只同步側欄；enter-edge 移除 overlay', async () => {
    const ctx = await setup();
    await started(ctx);
    const removesBefore = ctx.calls.overlayRemove;
    ctx.tick(); // 第一 tick：enter edge（nat.on false→true）
    expect(ctx.calls.overlayRemove).toBe(removesBefore + 1); // DOM 交接：撤自繪 overlay
    expect(ctx.calls.render).toBe(0); // 不畫 overlay
    expect(ctx.player.classList.contains(ctx.config.ENGAGED_CLASS)).toBe(false); // 不藏原生字幕
    expect(ctx.calls.ensure).toBeGreaterThan(0); // 側欄按鈕照掛
    expect(ctx.calls.sync).toBeGreaterThan(0); // 側欄照同步（吃原始 body 的 bind）
    ctx.tick();
    expect(ctx.calls.render).toBe(0); // 穩態亦然
  });

  test('overlay 分支對照：native off 時照舊 engage + render', async () => {
    const ctx = await setup();
    ctx.cur.nativeMode = false;
    ctx.nat.next = false;
    await started(ctx);
    ctx.tick();
    expect(ctx.calls.render).toBeGreaterThan(0);
    expect(ctx.player.classList.contains(ctx.config.ENGAGED_CLASS)).toBe(true);
  });

  test('Karaoke 開關 OFF → teardown 呼叫 native.reset', async () => {
    const ctx = await setup();
    await started(ctx);
    ctx.tick();
    const before = ctx.calls.nativeResets;
    ctx.$(ctx.config.TOGGLE_ID).dispatch('click'); // ON → OFF
    expect(ctx.calls.nativeResets).toBe(before + 1);
  });

  test('dispose（nav/hot-swap 同路徑）→ teardown 呼叫 native.reset', async () => {
    const ctx = await setup();
    await started(ctx);
    ctx.tick();
    const before = ctx.calls.nativeResets;
    ctx.engine.dispose(); // dispose → teardown()
    expect(ctx.calls.nativeResets).toBe(before + 1);
  });

  test('遠端翻 enabled（他分頁/bridge 遲到）：輪詢對齊標籤；OFF 收攤、ON 重啟', async () => {
    const ctx = await setup();
    await started(ctx);
    ctx.tick();
    // 遠端 OFF：沒有本地 click 事件——輪詢的 enabled 邊緣負責收攤＋標籤
    ctx.cur.enabled = false;
    const resetsBefore = ctx.calls.nativeResets;
    ctx.poll();
    expect(ctx.calls.nativeResets).toBe(resetsBefore + 1);
    expect(ctx.$(ctx.config.TOGGLE_ID).textContent).toBe('Karaoke: OFF');
    // 遠端 ON：唯一重啟路徑也在輪詢；標籤先對齊，之後的 click 才不會反向寫 false
    ctx.cur.enabled = true;
    ctx.poll();
    expect(ctx.$(ctx.config.TOGGLE_ID).textContent).toBe('Karaoke: ON');
    await ctx.settle();
    await ctx.settle();
    expect(ctx.rafQ.length).toBeGreaterThan(0); // 引擎重啟、render loop 重新排上
  });

  test('導航窗口守門：URL 已換、teardown 未到 → tick 不驅動播放器，只續排 rAF', async () => {
    // 導航窗口的洩漏（見 yk-engine tick 頭註）：pushState 之後、yt-navigate-finish 之前
    // 的窗口內驅動 autodrive，會對舊影片重選、多發 timedtext。
    const ctx = await setup();
    await started(ctx);
    ctx.tick(); // 陽性對照：正常 tick 有驅動
    const base = { ...ctx.calls };
    expect(base.drives).toBeGreaterThan(0);
    expect(base.nativeSyncs).toBeGreaterThan(0);
    ctx.setVid(''); // 導航到非 watch 頁（watch→watch 則是另一個 id，同樣不等）
    ctx.tick();
    expect(ctx.calls.drives).toBe(base.drives); // 不 drive（autodrive 不得重選舊軌）
    expect(ctx.calls.nativeSyncs).toBe(base.nativeSyncs); // 導航窗口內也不 sync
    expect(ctx.calls.render).toBe(base.render); // 不畫
    expect(ctx.calls.sync).toBe(base.sync); // 不動側欄
    expect(ctx.rafQ.length).toBeGreaterThan(0); // 但迴圈不死：續排 rAF 等正式 teardown
    ctx.setVid('abc'); // 對照：回到原影片 id → 恢復驅動（守門不是永久停機）
    ctx.tick();
    expect(ctx.calls.drives).toBe(base.drives + 1);
  });

  test('pr 逾時 idle 不鎖死重試：資料晚到後的下一個導航事件能重新 init', async () => {
    // waitForPlayerResponse 逾時（resolve null）→ init 記 idle。舊碼 active 留 true，
    // run() 的同影片守門把之後的 yt-navigate-finish/yt-page-data-updated 全 early-return
    // 掉——資料 >12s 才到的影片永遠不啟動（「導航沒觸發」的殘餘通道）。
    const ctx = await setup();
    ctx.setPr(null); // 首次 init：response 等不到
    ctx.engine.start();
    await ctx.settle();
    await ctx.settle();
    expect(ctx.rafQ.length).toBe(0); // 沒綁到，render loop 沒排上
    ctx.setPr({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', kind: 'asr' }] } } });
    ctx.s.location.href = 'https://www.youtube.com/watch?v=abc&late=1'; // 資料晚到，導航事件再來
    ctx.poll(); // URL fallback 輪詢（與 yt-page-data-updated 同路徑：onNavigate → run）
    await ctx.settle();
    await ctx.settle();
    expect(ctx.rafQ.length).toBeGreaterThan(0); // 這次 init 成功、render loop 排上
  });

  test('teardown 通知 autodrive.reset（same-video 導離再導回要重新自動啟動）', async () => {
    // tick 導航守門的連帶效應：drive 在離開後不再跑，autodrive 的 one-shot latch
    // 觀察不到「離開」——不 re-arm 的話，同支影片回歸會卡在 done、字幕不再自動恢復。
    const ctx = await setup();
    await started(ctx);
    ctx.tick();
    const before = ctx.calls.autodriveResets;
    ctx.engine.dispose(); // dispose → teardown()（導離同路徑）
    expect(ctx.calls.autodriveResets).toBeGreaterThan(before);
  });
});

describe('yk-autodrive — 唯一選軌 driver：one-shot 自動啟動 + redrive 切一遍（mock 注入）', () => {
  function setup() {
    const s = makeSandbox();
    load(s, ['yk-di.js']);
    const di = s.window.__YK__;
    // 計數而不斷言訊息格式：drive() 每 tick 都跑，「穩態零輸出」是 log 紀律的硬約，
    // 靜音 mock 會讓逐 tick 洗版回歸而全綠——用呼叫數守住。
    const logCalls = [];
    di.register('log', [], () => ({
      info: (...a) => logCalls.push(a),
      warn: (...a) => logCalls.push(a),
      error: (...a) => logCalls.push(a),
      variant: (lang, tlang) => (tlang ? lang + '→' + tlang : lang), // 與 yk-log 同約（標籤本體不入約）
    }));
    const cur = { autoDualLang: 'zh-Hant' };
    di.register('settings', [], () => ({ current: cur }));
    const pool = new Set(); // 已捕獲的變體 key（'' = 原文）
    di.register('capture', [], () => ({
      hasCapturedVariant: (_t, k) => pool.has(k), // autodrive 只問存在性（免 parse API）
    }));
    let vid = 'abc';
    let selTlang = null; // null = 未選任何 asr 變體
    let selectOk = true;
    let sticky = true; // false = setOption 回 true 但選擇不落地（病態播放器）
    let ad = false;
    const selects = [];
    di.register('yt', [], () => ({
      currentVideoId: () => vid,
      isAdShowing: () => ad,
      currentAsrSelection: () => (selTlang == null ? null : { tlang: selTlang }),
      selectAsrVariant: (_t, tl) => {
        selects.push(tl);
        if (!selectOk) return false;
        if (sticky) selTlang = tl;
        return true;
      },
    }));
    load(s, ['yk-autodrive.js']);
    const ad_ = di.resolve('autodrive');
    const TRACK = { languageCode: 'en' };
    return {
      ad: ad_, selects, cur, logCalls,
      drive: () => ad_.drive(TRACK, 'en'),
      arrive: (k) => pool.add(k),
      setSel: (v) => { selTlang = v; },
      setVid: (v) => { vid = v; },
      setSelectOk: (v) => { selectOk = v; },
      setSticky: (v) => { sticky = v; },
      setAd: (v) => { ad = v; },
    };
  }

  test('驅動鏈：先原文、原文到貨才切譯文、譯文到貨即 done（此後不再驅動）', () => {
    const c = setup();
    c.drive();
    expect(c.selects).toEqual(['']); // 先選原文（直選譯文不會載原文 body）
    c.drive();
    expect(c.selects).toEqual(['']); // 原文 body 未到：等待，不重複驅動
    c.arrive('');
    c.drive();
    expect(c.selects).toEqual(['', 'zh-Hant']); // 到貨 → 切譯文
    c.arrive('zh-Hant');
    c.drive();
    c.drive();
    expect(c.selects).toEqual(['', 'zh-Hant']); // done：one-shot，穩態不再驅動
    // 穩態 log 靜默：done 後繼續 tick，不得再有任何輸出（log 紀律的硬約）。
    const logsAtDone = c.logCalls.length;
    for (let i = 0; i < 50; i++) c.drive();
    expect(c.logCalls.length).toBe(logsAtDone);
  });

  test('reset() re-arm：done 後播放器選軌被重設，reset 才會重新驅動（same-video 回歸）', () => {
    const c = setup();
    c.arrive('');
    c.arrive('zh-Hant');
    c.drive(); // start：兩 body 都在但不在目標上 → 直接切譯文
    c.drive(); // trans + haveTrans → done
    expect(c.selects).toEqual(['zh-Hant']);
    c.setSel(null); // 模擬導離再導回：播放器把選軌重設（字幕關了），vid 沒變
    c.drive();
    expect(c.selects).toEqual(['zh-Hant']); // 陰性對照：不 reset → 卡在 done 不驅動
    c.ad.reset(); // engine.teardown 的通知
    c.drive();
    expect(c.selects).toEqual(['zh-Hant', 'zh-Hant']); // re-arm → 重新自動啟動
  });

  // ---- 漂移重選（nudge）：驅動後、body 到貨前，播放器自己把選軌重設（廣告邊界、
  // 初始化覆寫）——那次 fetch 已死、body 永遠不來。不重選的話鏈卡在半路（「只駕駛一半」：
  // 畫面停在原文，譯文永不出現）。----

  test('漂移重選（orig）：等原文 body 期間選擇被重設 → 重選原文，鏈才走得完', () => {
    const c = setup();
    c.drive();
    expect(c.selects).toEqual(['']); // start→orig
    c.setSel(null); // 播放器把選軌丟了（body 未到 → 那次 fetch 已死）
    c.drive();
    expect(c.selects).toEqual(['', '']); // 觀察到漂移 → 重選原文
    const logsAfterNudge = c.logCalls.length;
    c.drive();
    expect(c.selects).toEqual(['', '']); // 已回到原文上、body 未到 → 等待，不逐 tick 重複
    expect(c.logCalls.length).toBe(logsAfterNudge); // 等待中也不逐 tick 洗版
    c.arrive('');
    c.drive();
    expect(c.selects).toEqual(['', '', 'zh-Hant']); // 到貨 → 照常切譯文
  });

  test('漂移重選失敗（player 未 ready）不耗預算：復原後仍可完整重選', () => {
    const c = setup();
    c.drive(); // start→orig
    c.setSel(null); // 漂移
    c.setSelectOk(false); // player 一時不 ready：每 tick 重試、不計次
    for (let i = 0; i < 20; i++) c.drive();
    expect(c.selects).toHaveLength(1 + 20); // 每 tick 都嘗試（失敗不噤聲不放棄）
    c.setSelectOk(true);
    c.drive();
    expect(c.selects).toHaveLength(1 + 20 + 1); // 復原 → 成功重選（預算從 1/8 才開始算）
    c.arrive('');
    c.drive();
    expect(c.selects.at(-1)).toBe('zh-Hant'); // 鏈照常走完
  });

  test('廣告中不漂移重選；廣告後補上（廣告期間的選軌不是主影片的事實）', () => {
    const c = setup();
    c.drive(); // start→orig
    c.setSel(null); // 漂移
    c.setAd(true);
    c.drive();
    c.drive();
    expect(c.selects).toEqual(['']); // 廣告中不動
    c.setAd(false);
    c.drive();
    expect(c.selects).toEqual(['', '']); // 廣告後補重選
  });

  test('卡等重踢：選擇還在變體上但 body 一直不來（空/壞回應不入池）→ 同變體重選重發 fetch', () => {
    const c = setup();
    c.drive(); // start→orig（人停在原文上，body 永遠不來）
    expect(c.selects).toEqual(['']);
    for (let i = 0; i < 599; i++) c.drive();
    expect(c.selects).toEqual(['']); // 門檻（600 tick）前：安靜等待
    c.drive(); // 第 600 個空等 tick → 重踢
    expect(c.selects).toEqual(['', '']); // 同變體重選（不換軌、不對戰使用者）
    for (let i = 0; i < 599; i++) c.drive();
    expect(c.selects).toHaveLength(2); // 重踢後重新計數
    c.arrive(''); // 這次 fetch 成功了
    c.drive();
    expect(c.selects.at(-1)).toBe('zh-Hant'); // 鏈繼續：切譯文
  });

  test('漂移重選（trans）＋ done 需在目標上：body 在池裡但選擇被重設 → 重選、才收 done', () => {
    const c = setup();
    c.arrive('');
    c.arrive('zh-Hant'); // 跨導航池快取：兩份 body 都已在
    c.drive(); // start：直接切譯文 → trans
    expect(c.selects).toEqual(['zh-Hant']);
    c.setSel(null); // done 未收前播放器掉軌——舊碼 haveTrans 就收 done，字幕從此鎖死
    c.drive();
    expect(c.selects).toEqual(['zh-Hant', 'zh-Hant']); // 不收 done，重選目標
    c.drive(); // 在目標上＋body 在 → done
    c.setSel(null);
    c.drive();
    expect(c.selects).toEqual(['zh-Hant', 'zh-Hant']); // done 後不再驅動（one-shot 尊重使用者）
  });

  test('漂移重選有上限：setOption 接受但不生效 → 至多 8 次後停手，不逐 tick 洗版', () => {
    const c = setup();
    c.setSticky(false); // 病態播放器：select 回 true、選擇不落地
    c.drive(); // start→orig（第 1 次 select）
    for (let i = 0; i < 20; i++) c.drive(); // orig 相位長期漂移
    expect(c.selects).toHaveLength(1 + 8); // 初次 + 8 次 nudge，之後穩態零動作
    const logsAtCap = c.logCalls.length;
    for (let i = 0; i < 50; i++) c.drive();
    expect(c.logCalls.length).toBe(logsAtCap); // 超限後穩態也零輸出（不洗版）
    c.ad.reset(); // teardown re-arm → 預算歸零
    c.drive();
    expect(c.selects).toHaveLength(1 + 8 + 1); // 新 one-shot：start 相位重新可驅動
    c.drive();
    expect(c.selects).toHaveLength(1 + 8 + 1 + 1); // 且 nudge 預算真的歸零了（沒歸零這步會被擋）
  });

  test('影片變更自動 re-arm（既有語義不受 reset 引入影響）', () => {
    const c = setup();
    c.arrive('');
    c.arrive('zh-Hant');
    c.drive();
    c.drive(); // done
    c.setVid('zzz'); // 換片（pool 快取跨片保留無妨：selection 是每片各自的）
    c.setSel(null);
    c.drive();
    expect(c.selects).toEqual(['zh-Hant', 'zh-Hant']);
  });

  // ---- redrive（yk-native 的「切一遍」請求：重選當前變體一次）----
  // 以下測項把 autoDualLang 關掉，隔離 serveRedrive（autoStart 的驅動鏈上面已測過）。

  test('redrive：下一 drive 重選「當前」變體一次（切一遍）；旗標清後不重複', () => {
    const c = setup();
    c.cur.autoDualLang = '';
    c.setSel('zh-Hant'); // 播放器顯示中
    c.ad.redrive();
    c.drive();
    expect(c.selects).toEqual(['zh-Hant']); // 重選當前變體，不是換軌
    c.drive();
    expect(c.selects).toEqual(['zh-Hant']); // 旗標已清：穩態不再動播放器
  });

  test('sel null（字幕沒開/使用者切走）→ 旗標作廢，不發重選', () => {
    const c = setup();
    c.cur.autoDualLang = '';
    c.ad.redrive(); // sel 是 null
    c.drive();
    expect(c.selects).toEqual([]);
    c.setSel('zh-Hant'); // 之後就算有選擇，舊旗標也已作廢
    c.drive();
    expect(c.selects).toEqual([]);
  });

  test('廣告中持旗不動；廣告後執行（廣告期間動選軌毫無意義）', () => {
    const c = setup();
    c.cur.autoDualLang = '';
    c.setSel('zh-Hant');
    c.setAd(true);
    c.ad.redrive();
    c.drive();
    c.drive();
    expect(c.selects).toEqual([]); // 廣告中：不動、也不作廢
    c.setAd(false);
    c.drive();
    expect(c.selects).toEqual(['zh-Hant']); // 廣告後補執行
  });

  test('執行失敗（player 未 ready）→ 旗標留著逐 tick 重試到成功', () => {
    const c = setup();
    c.cur.autoDualLang = '';
    c.setSel('zh-Hant');
    c.setSelectOk(false);
    c.ad.redrive();
    c.drive();
    c.drive();
    expect(c.selects).toHaveLength(2); // 失敗：每 tick 重試
    c.setSelectOk(true);
    c.drive();
    expect(c.selects).toHaveLength(3); // 成功 → 旗標清
    c.drive();
    expect(c.selects).toHaveLength(3);
  });

  test('reset()（teardown）連 redrive 旗標一起清，不帶進下一支影片', () => {
    const c = setup();
    c.cur.autoDualLang = '';
    c.setSel('zh-Hant');
    c.ad.redrive();
    c.ad.reset();
    c.drive();
    expect(c.selects).toEqual([]);
  });
});

describe('yk-transcript — 字幕全文 button host (overlay box vs native player chrome)', () => {
  // In overlay mode the button rides ON the overlay caption box (ROOT). In native mode there
  // is no box, so it must re-home onto the player chrome. ensureToggle is host-aware and
  // re-parents on a mode switch (the single-id guard alone can't see a wrong host).
  function setup() {
    const s = makeSandbox();
    const dom = makeDom();
    s.document = dom.document;
    const player = dom.el('div');
    player.id = 'movie_player';
    const root = dom.el('div');
    root.id = 'yt-karaoke-root'; // the overlay box (config.ROOT_ID)
    load(s, ['yk-di.js', 'yk-config.js', 'yk-timing.js', 'yk-ui.js']);
    const di = s.window.__YK__;
    const settings = { current: { nativeMode: false } };
    di.register('settings', [], () => settings);
    di.register('yt', [], () => ({ getPlayerEl: () => player, getVideo: () => null }));
    load(s, ['yk-transcript.js']);
    const TBTN = di.resolve('config').TRANSCRIPT_BTN_ID;
    return { s, player, root, settings, transcript: di.resolve('transcript'), TBTN };
  }

  test('mounts on the box in overlay mode, re-homes to the player in native mode, and back', () => {
    const { s, player, root, settings, transcript, TBTN } = setup();

    transcript.ensureToggle(); // overlay mode
    const btn = s.document.getElementById(TBTN);
    expect(btn).toBeTruthy();
    expect(btn.parent).toBe(root);
    expect(btn.dataset.host).toBe('box');

    settings.current.nativeMode = true;
    transcript.ensureToggle();
    expect(s.document.getElementById(TBTN)).toBe(btn); // same node, moved (not duplicated)
    expect(btn.parent).toBe(player);
    expect(btn.dataset.host).toBe('player');
    expect(root.children).not.toContain(btn); // 真的搬走，舊 host 不殘留

    settings.current.nativeMode = false;
    transcript.ensureToggle();
    expect(btn.parent).toBe(root);
    expect(btn.dataset.host).toBe('box');
    expect(player.children).not.toContain(btn);
  });

  test('host 沒變時 ensureToggle 是 no-op（不重複 appendChild —— 每 tick 都會呼叫，守門必須擋住）', () => {
    const { player, settings, transcript } = setup();
    settings.current.nativeMode = true;
    transcript.ensureToggle(); // 首掛到 player
    let appends = 0;
    const orig = player.appendChild.bind(player);
    player.appendChild = (c) => { appends++; return orig(c); };
    transcript.ensureToggle(); // 同 host 再呼叫（引擎每 tick 都會）
    transcript.ensureToggle();
    expect(appends).toBe(0); // parentElement 守門擋住重掛（每幀 DOM 搬移＝守門壞掉）
  });
});
