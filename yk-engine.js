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
    ['config', 'log', 'settings', 'yt', 'capture', 'parse', 'styles', 'overlay', 'transcript', 'autodrive', 'native', 'panel'],
    (config, log, settings, yt, capture, parse, styles, overlay, transcript, autodrive, native, panel) => {
      const { TOGGLE_ID, ENABLED_KEY, ENGAGED_CLASS } = config;

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

      function isEnabled() {
        try {
          return localStorage.getItem(ENABLED_KEY) !== 'false';
        } catch {
          return true;
        }
      }

      function setEnabled(on) {
        try {
          localStorage.setItem(ENABLED_KEY, on ? 'true' : 'false');
        } catch {
          /* ignore */
        }
      }

      function ensureToggle() {
        if (document.getElementById(TOGGLE_ID)) return;
        const player = yt.getPlayerEl();
        if (!player) return;
        const btn = document.createElement('button');
        btn.id = TOGGLE_ID;
        btn.type = 'button';
        btn.dataset.on = String(isEnabled());
        btn.textContent = isEnabled() ? 'Karaoke: ON' : 'Karaoke: OFF';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const next = !isEnabled();
          setEnabled(next);
          btn.dataset.on = String(next);
          btn.textContent = next ? 'Karaoke: ON' : 'Karaoke: OFF';
          if (next) {
            run();
          } else {
            teardown();
          }
        });
        player.appendChild(btn);
      }

      // Reactively bind to the variant(s) the player currently displays. Normally that
      // is the single selected variant; with dual-track on AND a translation selected,
      // we also bind the original asr so both render. Re-parses only when the wanted
      // set changes; a wanted-but-not-yet-captured variant is added as soon as its body
      // appears. Returns true when at least one variant is bound.
      function syncBinding() {
        const sel = yt.currentAsrSelection(state.trackLang);
        if (!sel) return false;
        // In dual-track, order the stacked rows: original-then-translation by default,
        // or translation-then-original when translationOnTop is set. The dual DISPLAY is
        // owned solely by dualTrack — NOT by autoDualLang. autoDualLang only auto-STARTS
        // (drives the player); dualTrack is independent (the user sets it in the menu).
        // Turning autoDualLang back to 關閉 must do NOTHING to the display, so the display
        // must not depend on it (else it would actively collapse dual→single on off, wrong).
        const pair = settings.current.translationOnTop ? [sel.tlang, ''] : ['', sel.tlang];
        const dual = settings.current.dualTrack;
        const wantKeys = dual && sel.tlang ? pair : [sel.tlang];
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
            const lines = parse.groupLines(parse.parseCaptionEvents(json));
            if (!lines.length) continue;
            state.bind.push({ key, lines });
          }
          if (state.bind.length > before) {
            state.bind.sort((a, b) => wantKeys.indexOf(a.key) - wantKeys.indexOf(b.key));
            overlay.invalidate(); // order/count changed → rebuild rows
            log.info('Bound:', state.bind.map((b) => b.key || state.trackLang).join(' + '));
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

        state.stage = 'player-response';
        const pr = await yt.waitForPlayerResponse(12000, () => state.active);
        if (!state.active) return;
        const tracklist = pr?.captions?.playerCaptionsTracklistRenderer;
        const tracks = tracklist?.captionTracks;

        state.stage = 'pick-track';
        const track = yt.pickAutoCaptionTrack(tracks, tracklist);
        // No asr track on this video → nothing to bind to. Stay idle; not an error.
        if (!track) return;
        state.track = track;
        state.trackLang = track.languageCode || '';
        log.info('Binding to track:', track.name?.simpleText || state.trackLang, track.kind);

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
          log.error('failed at stage', state.stage, err);
          state.active = false;
        });
      }

      function teardown() {
        state.active = false;
        cancelAnimationFrame(state.raf);
        yt.getPlayerEl()?.classList.remove(ENGAGED_CLASS); // un-hide the native caption
        // A transform left registered would cook the next video's request.
        native.reset();
        // 任何 teardown = 這支影片的生命週期結束：re-arm autodrive 的 one-shot，讓
        // same-video 回歸（導離再導回、Karaoke OFF→ON）重新自動啟動。tick 的導航
        // 守門讓 drive 在離開後不再跑，autodrive 觀察不到「離開」，必須在此通知。
        autodrive.reset();
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
        // Fallback: detect video id changes that did not emit a known event.
        urlPollId = setInterval(() => {
          if (location.href !== lastUrl) {
            lastUrl = location.href;
            onNavigate();
          }
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
