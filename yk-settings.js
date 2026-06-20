/**
 * yk-settings — live popup settings, relayed by bridge.js (chrome.storage ->
 * postMessage) because the MAIN-world content script cannot read chrome.storage.
 *
 * IMPORTANT: `current` is a SINGLE mutable object whose fields are updated in place
 * by the message listener. Consumers (overlay.render / engine.syncBinding) read
 * `settings.current.X` every frame and must keep the same reference — never replace
 * `current` with a fresh object, or live reads would see stale values.
 */
(function () {
  'use strict';
  window.__YK__.register('settings', [], () => {
    const current = { dualTrack: false, captionStyle: 'default', translationOnTop: false };

    const onMessage = (e) => {
      if (e.source !== window || e.data?.__ykSettings !== true) return;
      const s = e.data.settings || {};
      current.dualTrack = !!s.dualTrack;
      current.captionStyle = s.captionStyle || 'default';
      current.translationOnTop = !!s.translationOnTop;
    };
    window.addEventListener('message', onMessage);
    // Nudge the bridge to push now, in case it initialized before this ran.
    window.postMessage({ __ykSettingsRequest: true }, '*');

    return {
      current,
      dispose() {
        window.removeEventListener('message', onMessage);
      },
    };
  });
})();
