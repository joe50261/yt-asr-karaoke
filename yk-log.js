/**
 * yk-log — single logger for the whole content script. Every line emitted to the
 * page console is prefixed with a stable tag so it is unambiguously attributable to
 * this extension. Never call console.* directly elsewhere — go through this.
 */
(function () {
  'use strict';
  window.__YK__.register('log', [], () => {
    const LOG_TAG = '[YT Karaoke]';
    return {
      info: (...args) => console.info(LOG_TAG, ...args),
      warn: (...args) => console.warn(LOG_TAG, ...args),
      error: (...args) => console.error(LOG_TAG, ...args),
    };
  });
})();
