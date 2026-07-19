/**
 * yk-watch — 播放器觀測器。每 tick 快照播放器的字幕選軌全貌（yt.captionState：含
 * 手動軌、手動軌翻譯、字幕關閉——currentAsrSelection 的盲區都在內）與播放器狀態，
 * 只在「變化的瞬間」記 log：毫秒時戳（performance.now，可與 DevTools Network 面板
 * 對時）、當下播放時間、廣告狀態，並標注成因——
 *   [own-select]  autodrive 剛發的 setOption 落地（每次 select 後 markOwn 登記）
 *   [external]    播放器自己重置（偏好 reconcile／session 生命週期點）或使用者操作
 *   [baseline]    本影片首次觀測的基準
 * 動機：YT 會在同 session 內的不明生命週期點重置字幕選軌（例如把選擇拉回
 * 手動軌＋記住的翻譯語言），從外部只能靠逐瞬間觀測抓到「是哪個瞬間、前後
 * 發生了什麼」（playerState 轉移、廣告邊界、時間跳動），才有材料設計判別。
 * 實測（2026-07-18 log）：重置落在 buffering→playing 轉移前 ~160ms——生命週期
 * 錨點（baseline／playerState 轉移／廣告邊界）與重置緊鄰。anchorAge() 把「距離
 * 最近錨點幾個 tick」開放給 autodrive 的 done 後對帳（reseed）：貼近錨點的外部
 * 偏離是播放器重置、可回選；穩態中的偏離是使用者動作、必須尊重。
 * 穩態零輸出（log 紀律）；engine 每 tick 呼叫 tick()、teardown 呼叫 reset()。
 */
(function () {
  'use strict';
  window.__YK__.register('watch', ['log', 'yt'], (log, yt) => {
    const OWN_TTL_TICKS = 120; // 自家 select 的歸因窗（~2s）：setOption 的選軌變化幾乎即刻落地
    let vid = null; // 觀測中的影片（換片重掛基線）
    let lastSig; // undefined = 尚無基線
    let lastPs; // 上次播放器狀態
    let lastAd; // 上次廣告狀態（邊界＝生命週期錨點；不另記 log——幾乎必伴隨 ps 轉移）
    let own = null; // { lang, tlang, ttl }：autodrive 剛發出的選擇
    let tickN = 0; // 已觀測的 tick 數（captionState 回 null 不計）
    let anchorTick = -1; // 最近一次生命週期錨點（baseline／ps 轉移／廣告邊界）的 tick

    const now = () => 't=+' + Math.round(performance.now()) + 'ms';
    const ct = (s) => 'ct=' + (s.t == null ? '?' : s.t.toFixed(2));

    function describe(s) {
      if (s.off) return '(captions off)';
      const label = log.variant(s.lang, s.tlang);
      if (s.kind === 'asr') return 'asr ' + label;
      return 'manual ' + label + (s.name ? ' "' + s.name + '"' : '');
    }

    // autodrive 每次 select 成功後登記：接下來觀測到的同變體變化歸因為 own-select。
    function markOwn(track, tlang) {
      own = { lang: (track && track.languageCode) || '', tlang, ttl: OWN_TTL_TICKS };
    }

    function tick() {
      const s = yt.captionState();
      if (!s) return; // 播放器未就緒：無可觀測
      tickN++;
      const cur = yt.currentVideoId();
      if (cur !== vid) {
        vid = cur;
        lastSig = undefined;
        lastPs = undefined;
        lastAd = undefined;
      }
      if (own && --own.ttl <= 0) own = null;
      if (s.ad !== lastAd) {
        if (lastAd !== undefined) anchorTick = tickN; // 廣告邊界；首次觀測非邊界不算
        lastAd = s.ad;
      }
      const sig = s.off ? 'off' : [s.lang, s.kind, s.name, s.tlang].join('|');
      if (sig !== lastSig) {
        const first = lastSig === undefined;
        if (first) anchorTick = tickN; // baseline＝本影片生命週期起點錨
        const isOwn =
          !!own && !s.off && s.kind === 'asr' &&
          (!own.lang || !s.lang || s.lang === own.lang) && s.tlang === own.tlang;
        if (isOwn) own = null; // 落地一次即銷：之後同變體的再變化屬外部
        log.info(
          'watch', 'v=' + vid, now(),
          'caption →', describe(s),
          first ? '[baseline]' : isOwn ? '[own-select]' : '[external]',
          'ps=' + s.playerState, ct(s),
          ...(s.ad ? ['[ad]'] : []),
        );
        lastSig = sig;
      }
      if (s.playerState !== lastPs) {
        // 播放器狀態轉移（-1 unstarted/0 ended/1 playing/2 paused/3 buffering/5 cued）：
        // 重置幾乎都伴隨這些轉移，是逐瞬間對帳的錨點。基線 tick 不另記（caption 行已含 ps）。
        if (lastPs !== undefined) {
          log.info('watch', 'v=' + vid, now(), 'playerState', lastPs + '→' + s.playerState, ct(s), ...(s.ad ? ['[ad]'] : []));
        }
        anchorTick = tickN;
        lastPs = s.playerState;
      }
    }

    // 距離最近生命週期錨點（baseline／playerState 轉移／廣告邊界）幾個已觀測 tick。
    // 尚無任何錨點回 Infinity。autodrive 的 done 後對帳靠它判別「播放器重置 vs
    // 使用者換軌」——重置緊鄰錨點（實測早於 ps 轉移 ~160ms，逐 tick 續判補得到），
    // 穩態深處的偏離則永遠夠不到窗。
    function anchorAge() {
      return anchorTick < 0 ? Infinity : tickN - anchorTick;
    }

    function reset() {
      vid = null;
      lastSig = undefined;
      lastPs = undefined;
      lastAd = undefined;
      own = null;
      tickN = 0;
      anchorTick = -1;
    }

    // 掛載自報（resolve 時一次）：把「模組有沒有載入」與「播放器可不可觀測」拆成兩個
    // 可分辨的訊號——之後若 attached 有印而 [baseline] 遲遲不出，問題明確在
    // captionState 一直回 null，而不是模組根本不在頁面裡。
    log.info('watch', 'attached');

    return { tick, markOwn, anchorAge, reset, dispose: reset };
  });
})();
