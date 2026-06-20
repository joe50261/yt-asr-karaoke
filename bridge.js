/**
 * Settings bridge — runs in the ISOLATED content-script world (has chrome.* APIs)
 * and relays the extension's settings to the MAIN-world modules (yk-*.js, see
 * yk-settings.js), which cannot access chrome.storage. One-way: chrome.storage.local
 * -> postMessage. Re-pushes whenever the popup changes a setting (chrome.storage.onChanged).
 */
(function () {
  'use strict';

  const DEFAULTS = { dualTrack: false, captionStyle: 'default', translationOnTop: false };

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
})();
