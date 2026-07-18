/**
 * yk-engine — the orchestrator. Owns the per-video lifecycle state, the Karaoke
 * ON/OFF toggle, the render loop, and SPA navigation. It wires the lower modules
 * together; everything that mutates lifecycle (bind/track/video/raf) lives here.
 *
 * This is the DI entry: start() sets up navigation + the initial run; dispose()
 * unwinds every global side effect (RAF, nav listeners, URL poll, toggle DOM) so a
 * hot-swap leaves nothing behind. Because the module is a singleton across SPA
 * navigations, teardown explicitly re-creates fresh lifecycle state (clearing
 * track/trackLang — otherwise the next video's asr would be judged against the old
 * language and we'd step aside forever) and tells the overlay/transcript owners to
 * reset themselves.
 */
(function () {
  'use strict';
  window.__YK__.register(
    'engine',
    ['config', 'log', 'settings', 'yt', 'capture', 'parse', 'styles', 'overlay', 'transcript', 'autodrive', 'native', 'panel', 'ui', 'watch'],
    (config, log, settings, yt, capture, parse, styles, overlay, transcript, autodrive, native, panel, ui, watch) => {
      const { TOGGLE_ID, ENGAGED_CLASS } = config;

      let state = freshLifecycle();
      let urlPollId = 0;
      let lastUrl = location.href;

      function freshLifecycle() {
        return {
          bind: [], // [{ key, lines }] — 1 variant, or 2 when dual-track is on
          bindSig: null, // signature of the variant(s) currently parsed in
          video: null,
          raf: 0,
          track: null,
          trackLang: '',
          stage: 'idle',
          videoId: '',
          active: false,
        };
      }

      // 主開關住在 settings hub（與 nativeMode 同性質的行為開關；經 bridge 持久化，
      // 面板/mock/他分頁都看得到）。缺值＝開。
      function isEnabled() {
        return settings.current.enabled !== false;
      }

      // enabled 的單一反應路徑（邊緣偵測）：值變了 → 標籤對齊＋run()/teardown()。
      // enabled 會從三個方向翻動——本地 click、bridge 遲到的 boot push、他分頁的
      // onChanged 回聲——後兩者沒有本地 click 事件，靠 start() 的輪詢呼叫這裡。
      // 沒有這條路徑，遠端 OFF→ON 無人重啟、標籤停在 OFF，之後點鈕會反向寫入 false。
      let lastEnabled = null;
      function watchEnabled() {
        const on = isEnabled();
        if (on === lastEnabled) return;
        lastEnabled = on;
        const toggle = document.getElementById(TOGGLE_ID);
        if (toggle) {
          toggle.dataset.on = String(on);
          toggle.textContent = on ? 'Karaoke: ON' : 'Karaoke: OFF';
        }
        if (on) {
          run();
        } else {
          teardown();
        }
      }

      function ensureToggle() {
        const btn = ui.mountPillButton({
          id: TOGGLE_ID,
          host: yt.getPlayerEl(),
          text: isEnabled() ? 'Karaoke: ON' : 'Karaoke: OFF',
          onClick: () => {
            settings.apply({ enabled: !isEnabled() });
            watchEnabled();
          },
        });
        if (btn) btn.dataset.on = String(isEnabled());
      }

      // Reactively bind to the variant(s) the player currently displays. Normally that
      // is the single selected variant; with dual-track on AND a translation selected,
      // we also bind the original asr so both render. Re-parses only when the wanted
      // set changes; a wanted-but-not-yet-captured variant is added as soon as its body
      // appears. Returns true when at least one variant is bound.
      function syncBinding() {
        const sel = yt.currentAsrSelection(state.trackLang);
        if (!sel) return false;
        // 變體集合與列序＝雙軌顯示政策（settings.dualDisplayKeys，native.cook 同源）
        // 對當前選擇的展開。
        const wantKeys = settings.dualDisplayKeys(sel.tlang);
        const sig = wantKeys.join('|');
        if (sig !== state.bindSig) {
          state.bindSig = sig;
          state.bind = [];
          overlay.invalidate();
        }
        if (state.bind.length !== wantKeys.length) {
          const before = state.bind.length;
          const have = new Set(state.bind.map((b) => b.key));
          for (const key of wantKeys) {
            if (have.has(key)) continue;
            const json = capture.capturedJsonForVariant(state.track, key);
            if (!json) continue;
            const lines = parse.linesFromJson(json);
            if (!lines.length) continue;
            state.bind.push({ key, lines });
          }
          if (state.bind.length > before) {
            state.bind.sort((a, b) => wantKeys.indexOf(a.key) - wantKeys.indexOf(b.key));
            overlay.invalidate(); // order/count changed → rebuild rows
            log.info('engine', 'v=' + state.videoId, 'bound:', state.bind.map((b) => log.variant(state.trackLang, b.key)).join(' + '));
          }
        }
        return state.bind.length > 0;
      }

      // Engage: we own the caption area — hide the native caption (via ENGAGED_CLASS).
      function engage() {
        yt.getPlayerEl()?.classList.add(ENGAGED_CLASS);
      }

      // Step aside: hand the caption area back to the player. Un-hide the native
      // caption and clear our overlay in the same step — un-hiding alone doubles the
      // caption, clearing alone leaves a blank one.
      // transcript.hide() is SOFT (keeps built rows) so re-engaging after an ad reuses
      // them — paired with capture's persistent __YK_CAP__.
      function stepAside() {
        yt.getPlayerEl()?.classList.remove(ENGAGED_CLASS);
        overlay.clear();
        state.bind = [];
        state.bindSig = null;
        transcript.hide();
      }

      function tick() {
        if (!state.active) return;
        // enabled 由 bridge 異步送達：boot 可能先按預設 true 起跑。遲到的 enabled=false
        // 在這裡（比 1s 輪詢快）收攤；watchEnabled 同時對齊標籤與基線。
        if (!isEnabled()) {
          watchEnabled();
          return;
        }
        // 播放器觀測器：每 tick 差分快照，變化瞬間記 log（成因歸因見 yk-watch）。
        // 放在導航守門之前——導航窗口內的重置也要看得到。
        watch.tick();
        // SPA 導航窗口守門：點連結的瞬間 pushState 已把 URL 換走，但正式 teardown 要等
        // yt-navigate-finish（新頁資料載完才發）——這幾百 ms 內 tick 仍在跑。此時不可
        // 再驅動播放器：導航中播放器會重設字幕選軌，autodrive 的 one-shot／redrive 旗標
        // 會對舊影片重選、多發 timedtext。只續排 rAF，等導航事件做正式收尾。
        if (yt.currentVideoId() !== state.videoId) {
          state.raf = requestAnimationFrame(tick);
          return;
        }
        const v = state.video || yt.getVideo();
        if (!v) {
          state.raf = requestAnimationFrame(tick);
          return;
        }
        state.video = v;
        // The ONE automatic caption driver (auto-start one-shot + redrive) lives in
        // yk-autodrive; the engine just feeds it the picked asr track each tick.
        autodrive.drive(state.track, state.trackLang);
        // Native mode's when-to-cook (register/clear the cook, settings-signature redrive)
        // lives in yk-native.sync; the engine only calls it each tick and handles the
        // switch-on DOM handover (drop our overlay, un-hide the native caption).
        const wasNativeOn = native.isOn();
        native.sync(state.track);
        if (native.isOn() && !wasNativeOn) {
          overlay.remove(); // drop the self-drawn overlay; YT now draws the cooked caption
          yt.getPlayerEl()?.classList.remove(ENGAGED_CLASS); // un-hide the native caption
        }
        const ms = v.currentTime * 1000;
        // syncBinding reactively binds to the player's current asr selection and parses the
        // ORIGINAL captured body(ies); used by the overlay AND (in native mode) the transcript.
        const bound = !yt.isAdShowing() && syncBinding();
        if (native.isOn()) {
          // Native mode: YouTube's own renderer draws the cooked karaoke — the native
          // caption stays visible (no engage) and the overlay stays empty; only the side
          // transcript is kept in sync from the bound ORIGINAL lines.
          if (bound) {
            transcript.ensureToggle();
            transcript.sync(ms, state.bind);
          } else {
            transcript.hide();
          }
        } else if (!bound) {
          // Overlay mode, not engaged: hand the caption area back to the player.
          stepAside();
        } else {
          engage();
          overlay.render(state.bind, ms);
          // The 字幕全文 toggle lives ON the caption box, so attach it only after
          // overlay.render has created the root (idempotent; no-ops once present).
          transcript.ensureToggle();
          // The side transcript follows the binding: single variant normally, or both
          // (original + translation, interleaved by time) when dual-track is on.
          transcript.sync(ms, state.bind);
        }
        state.raf = requestAnimationFrame(tick);
      }

      async function init() {
        state.stage = 'styles';
        styles.inject();
        ensureToggle();
        panel.ensureButton(); // the ⚙ settings menu shares the toggle's lifetime/hover-reveal
        state.videoId = yt.currentVideoId();
        log.info('engine', 'v=' + state.videoId, 'init: waiting for player response');

        state.stage = 'player-response';
        const pr = await yt.waitForPlayerResponse(12000, () => state.active);
        if (!state.active) return;
        // YT 內部形狀只在 yk-yt 讀（與 waitForPlayerResponse 的就緒判定同一條路徑）。
        const tracklist = yt.captionTracklist(pr);
        const tracks = tracklist?.captionTracks;

        state.stage = 'pick-track';
        const track = yt.pickAutoCaptionTrack(tracks, tracklist);
        // No asr track on this video → nothing to bind to. Stay idle; not an error.
        // 但要說清楚是「這支影片」為何 idle——三種原因（response 等不到／沒字幕軌／
        // asr 軌不唯一）對使用者看起來都一樣是「沒動」，log 不分影片不分原因就無從查。
        if (!track) {
          log.info(
            'engine', 'v=' + state.videoId,
            !pr ? 'idle: player response not ready before timeout'
              : !tracks?.length ? 'idle: video has no caption tracks'
                : 'idle: no unambiguous asr track among ' + tracks.length + ' tracks',
          );
          // 逾時（pr 根本沒等到）≠ 這支影片沒字幕：資料晚到時 yt-navigate-finish/
          // yt-page-data-updated 還會再來，active 留 true 會被 run() 的同影片守門
          // early-return 永遠擋住（「導航沒觸發」的殘餘通道）。放掉 active 讓下一個
          // 導航事件重新 init；真的沒字幕軌（pr 在手）才維持 idle latch，不空轉。
          if (!pr) state.active = false;
          return;
        }
        state.track = track;
        state.trackLang = track.languageCode || '';
        // binding 行是這支影片「要勾住什麼」的完整宣告：asr 軌（統一變體標籤＋人類可讀
        // 名稱一次）＋自動翻譯要驅動到的目標——少了目標，讀 log 的人不知道 autodrive
        // 接下來的 select 是誰交辦的。
        const target = settings.current.autoDualLang;
        log.info(
          'engine', 'v=' + state.videoId,
          'binding: asr track', log.variant(state.trackLang, ''),
          '("' + (track.name?.simpleText || state.trackLang) + '")',
          target ? '— auto-translate: ' + log.variant(state.trackLang, target) : '— auto-translate: off',
        );

        state.stage = 'wait-video';
        state.video = await yt.waitForVideo(() => state.active);
        if (!state.active) return;

        // From here the render loop reactively binds to whichever variant (original or
        // an auto-translation) the player currently displays — see tick()/syncBinding().
        state.stage = 'running';
        cancelAnimationFrame(state.raf);
        state.raf = requestAnimationFrame(tick);
      }

      function run() {
        if (!yt.isWatchPage()) return;
        if (!isEnabled()) {
          // Still show the toggle so the user can turn it back on. Karaoke off ⇒ no
          // cooking: drop any registered transform.
          native.reset();
          styles.inject();
          ensureToggle();
          panel.ensureButton();
          return;
        }
        if (state.active && state.videoId === yt.currentVideoId()) return;
        teardown();
        state = freshLifecycle();
        state.active = true;
        init().catch((err) => {
          window.__YT_KARAOKE_ERR__ = {
            stage: state.stage,
            message: String(err && err.message ? err.message : err),
            bound: state.bind.length,
          };
          log.error('engine', 'v=' + state.videoId, 'failed at stage', state.stage, err);
          state.active = false;
        });
      }

      function teardown() {
        // 只有真的有生命週期可收（videoId 已設）才記——run() 每次都先呼叫 teardown，
        // 全新 state 的空收攤不記，log 才不會出現無主的 teardown 行。
        if (state.videoId) log.info('engine', 'v=' + state.videoId, 'teardown');
        state.active = false;
        cancelAnimationFrame(state.raf);
        yt.getPlayerEl()?.classList.remove(ENGAGED_CLASS); // un-hide the native caption
        // A transform left registered would cook the next video's request.
        native.reset();
        // 任何 teardown = 這支影片的生命週期結束：re-arm autodrive 的 one-shot，讓
        // same-video 回歸（導離再導回、Karaoke OFF→ON）重新自動啟動。tick 的導航
        // 守門讓 drive 在離開後不再跑，autodrive 觀察不到「離開」，必須在此通知。
        autodrive.reset();
        watch.reset(); // 觀測基線隨生命週期歸零：下一支影片重掛 [baseline]
        // Caption-track selection (autodrive → yt.selectAsrVariant) is player-side state:
        // teardown does not track or touch it — the one global side effect dispose leaves
        // in place (like __YK_CAP__'s persistence, yk-capture.js).
        transcript.reset();
        overlay.remove();
        const toggle = document.getElementById(TOGGLE_ID);
        if (toggle) {
          toggle.dataset.on = String(isEnabled());
          toggle.textContent = isEnabled() ? 'Karaoke: ON' : 'Karaoke: OFF';
        }
        // Fresh lifecycle clears track/trackLang/bind so the next video binds cleanly.
        state = freshLifecycle();
      }

      // ---- SPA navigation handling ----
      function onNavigate() {
        if (yt.isWatchPage()) {
          run();
        } else {
          teardown();
        }
      }

      function start() {
        window.addEventListener('yt-navigate-finish', onNavigate, true);
        window.addEventListener('yt-page-data-updated', onNavigate, true);
        lastUrl = location.href;
        lastEnabled = isEnabled(); // 基線：初始 run/teardown 由 onNavigate 決定，這裡只記錄
        // Fallback: detect video id changes that did not emit a known event.
        // 同一輪詢也守 enabled 邊緣（遠端 OFF→ON 的唯一重啟路徑；OFF 亦涵蓋
        // 「init 早退、tick 不在跑」時遲到的關閉）。
        urlPollId = setInterval(() => {
          if (location.href !== lastUrl) {
            lastUrl = location.href;
            onNavigate();
          }
          watchEnabled();
        }, 1000);
        // Initial attempt once the DOM is ready enough to host the overlay.
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', onNavigate, { once: true });
        } else {
          onNavigate();
        }
      }

      function dispose() {
        window.removeEventListener('yt-navigate-finish', onNavigate, true);
        window.removeEventListener('yt-page-data-updated', onNavigate, true);
        clearInterval(urlPollId);
        urlPollId = 0;
        teardown();
        document.getElementById(TOGGLE_ID)?.remove();
      }

      return { start, dispose };
    },
  );
})();
