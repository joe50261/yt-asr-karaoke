// UNIT (Jest) — yk-watch 播放器觀測器：只在「變化的瞬間」記 log（穩態零輸出），
// 成因歸因 own-select / external / baseline，playerState 轉移逐筆記錄。
// 動機：YT 會在同 session 的不明生命週期點重置字幕選軌，抓重置瞬間需要逐 tick 觀測。
const { makeSandbox, load } = require('../_helpers');

describe('yk-watch — 逐 tick 差分觀測（mock 注入 log/yt）', () => {
  function setup() {
    const s = makeSandbox();
    load(s, ['yk-di.js']);
    const di = s.window.__YK__;
    const lines = [];
    di.register('log', [], () => ({
      info: (...a) => lines.push(a.join(' ')),
      warn: (...a) => lines.push(a.join(' ')),
      error() {},
      variant: (l, t) => (t ? (l || '?') + '→' + t : l || '?'),
    }));
    const st = {
      vid: 'abc',
      state: { off: false, lang: 'en', kind: 'asr', name: '', tlang: '', playerState: 1, t: 0, ad: false },
    };
    di.register('yt', [], () => ({
      captionState: () => (st.state ? { ...st.state } : null),
      currentVideoId: () => st.vid,
    }));
    load(s, ['yk-watch.js']);
    const watch = di.resolve('watch');
    lines.length = 0; // 掛載自報行（attached）不算進各測試的觀測輸出
    return { watch, st, lines };
  }
  const track = { languageCode: 'en' };

  test('resolve 即自報 attached：模組載入與播放器可觀測是兩個可分辨的訊號', () => {
    const s = makeSandbox();
    load(s, ['yk-di.js']);
    const di = s.window.__YK__;
    const lines = [];
    di.register('log', [], () => ({ info: (...a) => lines.push(a.join(' ')), warn() {}, error() {}, variant: () => '' }));
    di.register('yt', [], () => ({ captionState: () => null, currentVideoId: () => null }));
    load(s, ['yk-watch.js']);
    di.resolve('watch');
    expect(lines).toEqual(['watch attached']); // 播放器永不就緒也要有這行
  });

  test('首次觀測記 [baseline]；之後穩態零輸出（log 紀律）', () => {
    const { watch, lines } = setup();
    watch.tick();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[baseline]');
    expect(lines[0]).toContain('asr en');
    for (let i = 0; i < 200; i++) watch.tick();
    expect(lines).toHaveLength(1); // 無變化：一行都不多
  });

  test('外部變化（YT 重置到手動軌翻譯）→ [external]，帶軌名與播放狀態', () => {
    const { watch, st, lines } = setup();
    watch.tick(); // baseline
    st.state = { ...st.state, kind: '', name: 'Default', tlang: 'zh-Hans', playerState: 3 };
    watch.tick(); // 同一 tick：先 caption 行、後 playerState 轉移行
    const line = lines.find((l) => l.includes('[external]'));
    expect(line).toBeTruthy();
    expect(line).toContain('manual en→zh-Hans "Default"');
    expect(lines.some((l) => l.includes('playerState 1→3'))).toBe(true); // 轉移錨點同步記錄
  });

  test('markOwn 後的同變體落地 → [own-select]；標記一次即銷，之後的變化屬外部', () => {
    const { watch, st, lines } = setup();
    watch.tick(); // baseline
    watch.markOwn(track, 'zh-Hans');
    st.state = { ...st.state, tlang: 'zh-Hans' };
    watch.tick();
    expect(lines.at(-1)).toContain('[own-select]');
    st.state = { ...st.state, off: true, lang: '', kind: '', tlang: '' };
    watch.tick();
    expect(lines.at(-1)).toContain('(captions off)');
    expect(lines.at(-1)).toContain('[external]'); // own 已銷：字幕被關是外部行為
  });

  test('markOwn 歸因窗會過期：久未落地的標記不會替之後的外部變化背書', () => {
    const { watch, st, lines } = setup();
    watch.tick(); // baseline
    watch.markOwn(track, 'zh-Hans');
    for (let i = 0; i < 150; i++) watch.tick(); // 超過 OWN_TTL_TICKS(120)
    st.state = { ...st.state, tlang: 'zh-Hans' };
    watch.tick();
    expect(lines.at(-1)).toContain('[external]');
  });

  test('換影片重掛基線；reset()（teardown）同效', () => {
    const { watch, st, lines } = setup();
    watch.tick();
    st.vid = 'xyz';
    watch.tick();
    expect(lines.at(-1)).toContain('v=xyz');
    expect(lines.at(-1)).toContain('[baseline]');
    watch.reset();
    watch.tick();
    expect(lines.filter((l) => l.includes('[baseline]'))).toHaveLength(3);
  });

  test('播放器未就緒（captionState null）：不觀測也不記，不拋錯', () => {
    const { watch, st, lines } = setup();
    st.state = null;
    for (let i = 0; i < 10; i++) watch.tick();
    expect(lines).toHaveLength(0);
  });

  test('anchorAge：baseline／playerState 轉移／廣告邊界都是錨點，穩態逐 tick 遞增', () => {
    const { watch, st, lines } = setup();
    expect(watch.anchorAge()).toBe(Infinity); // 尚無任何觀測
    watch.tick(); // baseline
    expect(watch.anchorAge()).toBe(0);
    for (let i = 0; i < 10; i++) watch.tick();
    expect(watch.anchorAge()).toBe(10);
    st.state = { ...st.state, playerState: 2 };
    watch.tick(); // ps 轉移＝新錨
    expect(watch.anchorAge()).toBe(0);
    for (let i = 0; i < 5; i++) watch.tick();
    const before = lines.length;
    st.state = { ...st.state, ad: true };
    watch.tick(); // 廣告邊界＝新錨；不另記 log（幾乎必伴隨 ps 轉移）
    expect(watch.anchorAge()).toBe(0);
    expect(lines.length).toBe(before);
    watch.reset();
    expect(watch.anchorAge()).toBe(Infinity); // teardown 歸零
  });
});
