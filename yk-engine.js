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
    ['config', 'log', 'settings', 'yt', 'capture', 'parse', 'styles', 'overlay', 'transcript', 'autodrive', 'panel'],
    (config, log, settings, yt, capture, parse, styles, overlay, transcript, autodrive, panel) => {
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
      // caption and clear our overlay so we NEVER leave a blank caption behind.
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
        const v = state.video || yt.getVideo();
        if (!v) {
          state.raf = requestAnimationFrame(tick);
          return;
        }
        state.video = v;
        // Auto-translate (the auto-drive) lives in its own module (yk-autodrive) so it can
        // be hot-swapped on its own; the engine just feeds it the picked asr track each tick.
        autodrive.drive(state.track, state.trackLang);
        // Show karaoke only while the player's selected caption is our asr track (or a
        // translation of it) AND that variant's body is captured. Otherwise step aside
        // so the user's chosen native caption shows — never override it or leave blank.
        if (yt.isAdShowing() || !syncBinding()) {
          stepAside();
        } else {
          engage();
          const ms = v.currentTime * 1000;
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
          // Still show the toggle so the user can turn it back on.
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
        yt.getPlayerEl()?.classList.remove(ENGAGED_CLASS); // restore the native caption
        // NOTE: if auto-translate drove the player onto an asr translation (yk-autodrive
        // → yt.selectAsrVariant), we deliberately do NOT revert that caption selection here.
        // "We stand down; the user owns the player" — reverting would itself be an override.
        // So this one player-side mutation is intentionally left in place (like __YK_CAP__'s
        // persistence, yk-capture.js), and is the one global side effect dispose does not unwind.
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
