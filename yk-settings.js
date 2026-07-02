/**
 * yk-settings — the live settings hub. bridge.js relays chrome.storage -> postMessage
 * (the MAIN-world content script cannot read chrome.storage), and the in-page settings
 * panel (yk-panel) writes back through apply().
 *
 * IMPORTANT: `current` is a SINGLE mutable object whose fields are updated in place
 * by the message listener AND by apply(). Consumers (overlay.render / engine.syncBinding)
 * read `settings.current.X` every frame and must keep the same reference — never replace
 * `current` with a fresh object, or live reads would see stale values.
 *
 * apply(partial) is the ONLY write path: it mutates `current` in place (so the change is
 * live THIS frame — no storage round-trip latency) AND posts __ykSettingsSet so bridge.js
 * persists it to chrome.storage (survives reload). The bridge's onChanged echo then re-
 * pushes the same values back through onMessage — idempotent, so there is no flicker.
 */
(function () {
  'use strict';
  window.__YK__.register('settings', [], () => {
    const current = {
      dualTrack: false,
      captionStyle: 'default',
      translationOnTop: false,
      // '' = off; otherwise a translation target language code (e.g. 'zh-Hant').
      // When set, the engine auto-drives the player into dual-track for that language.
      autoDualLang: '',
      // false = overlay mode (we self-draw the karaoke); true = native playback mode
      // (yk-native cooks a karaoke json3 and hands it to YouTube's own caption renderer).
      nativeMode: false,
    };

    // Per-key normalizers — the single source of truth for how a raw stored/UI value
    // becomes a canonical `current` field. Shared by onMessage (full push from bridge)
    // and apply (partial write from the panel) so the two can never coerce differently.
    const COERCE = {
      dualTrack: (v) => !!v,
      captionStyle: (v) => v || 'default',
      translationOnTop: (v) => !!v,
      autoDualLang: (v) => v || '',
      nativeMode: (v) => !!v,
    };

    const onMessage = (e) => {
      if (e.source !== window || e.data?.__ykSettings !== true) return;
      const s = e.data.settings || {};
      for (const k in COERCE) current[k] = COERCE[k](s[k]);
    };
    window.addEventListener('message', onMessage);
    // Nudge the bridge to push now, in case it initialized before this ran.
    window.postMessage({ __ykSettingsRequest: true }, '*');

    // The ONE write path (used by yk-panel). Mutate `current` in place for an instant
    // live update, then relay the partial to bridge.js for persistence. Unknown keys are
    // ignored so a UI bug can't smuggle arbitrary keys into storage.
    function apply(partial) {
      if (!partial || typeof partial !== 'object') return;
      const out = {};
      for (const k in partial) {
        if (!(k in COERCE)) continue;
        current[k] = COERCE[k](partial[k]);
        out[k] = current[k];
      }
      if (Object.keys(out).length) window.postMessage({ __ykSettingsSet: true, settings: out }, '*');
    }

    return {
      current,
      apply,
      dispose() {
        window.removeEventListener('message', onMessage);
      },
    };
  });
})();
