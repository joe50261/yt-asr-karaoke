/**
 * yk-log — single logger for the whole content script. Every line emitted to the
 * page console is prefixed with a stable tag so it is unambiguously attributable to
 * this extension. Never call console.* directly elsewhere — go through this.
 *
 * variant() 是「變體 log 標籤」的唯一定義點：原文 = 'en'、翻譯 = 'en→zh-Hant'。
 * engine 的 binding/bound 與 autodrive 的 select/drift/stall 都從這裡取字——
 * 同一個變體在 log 裡只有一種寫法，跨行才對得起來（各寫各的就會出現
 * "English (auto-generated)" / "orig" / "en" 三種名字指同一條軌的歧義）。
 */
(function () {
  'use strict';
  window.__YK__.register('log', [], () => {
    const LOG_TAG = '[YT Karaoke]';
    return {
      info: (...args) => console.info(LOG_TAG, ...args),
      warn: (...args) => console.warn(LOG_TAG, ...args),
      error: (...args) => console.error(LOG_TAG, ...args),
      variant: (lang, tlang) => (tlang ? (lang || '?') + '→' + tlang : lang || '?'),
    };
  });
})();
