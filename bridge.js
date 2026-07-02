/**
 * Settings bridge — runs in the ISOLATED content-script world (has chrome.* APIs) and
 * relays the extension's settings to/from the MAIN-world modules (yk-*.js), which cannot
 * access chrome.storage. Two directions:
 *   - storage -> page: chrome.storage.local -> postMessage(__ykSettings); re-pushed on
 *     every chrome.storage.onChanged (so a write from any tab updates this one live).
 *   - page -> storage: the in-page settings panel (yk-panel -> yk-settings.apply) posts
 *     __ykSettingsSet; we persist it with chrome.storage.local.set. That triggers
 *     onChanged -> push, which echoes the canonical values back (idempotent).
 */
(function () {
  'use strict';

  const DEFAULTS = {
    dualTrack: false,
    captionStyle: 'default',
    translationOnTop: false,
    autoDualLang: '',
    nativeMode: false,
  };

  function push() {
    chrome.storage.local.get(DEFAULTS, (settings) => {
      window.postMessage({ __ykSettings: true, settings }, '*');
    });
  }

  push();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') push();
  });

  // yk-settings.js asks for settings once it is ready (handles the race where the
  // MAIN modules load after our first push).
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.__ykSettingsRequest === true) push();
  });

  // Reverse write: the in-page panel (yk-settings.apply) sends a partial settings patch;
  // persist only KNOWN keys (a same-page message could otherwise smuggle arbitrary keys
  // into our storage). The resulting onChanged -> push echoes the canonical values back.
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__ykSettingsSet !== true) return;
    const patch = e.data.settings;
    if (!patch || typeof patch !== 'object') return;
    const clean = {};
    for (const k of Object.keys(DEFAULTS)) {
      if (k in patch) clean[k] = patch[k];
    }
    if (Object.keys(clean).length) chrome.storage.local.set(clean);
  });
})();
