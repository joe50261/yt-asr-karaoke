/**
 * yk-main — the entry. Loaded LAST in the manifest's MAIN-world js[], and the ONLY
 * place that resolves/boots, so every module is registered by the time we resolve.
 *
 * At document_start (before YouTube's player code runs) we install the network hook
 * synchronously — it must be in place before the player makes its first timedtext
 * request. Then we boot the engine, which sets up SPA navigation and the render loop.
 *
 * After this runs, the container is "booted": re-evaluating any module file (e.g. MCP
 * evals an edited yk-overlay.js back into the page) re-registers its factory, which
 * triggers a live hot-swap — no extension reload.
 */
(function () {
  'use strict';
  const di = window.__YK__;
  if (!di) throw new Error('[YT Karaoke] yk-di.js must load before yk-main.js');
  // 開機第一行自報運行 build：Chrome 對未封裝擴充功能不會自動重載，repo 已更新
  // ≠ 頁面注入的是新檔。這行在任何後續失敗（DI 解析、engine boot）之前就印出，
  // 是判讀整份 console log 對應哪版原始碼的唯一憑據。
  di.resolve('log').info('boot', 'build', di.resolve('config').BUILD);
  di.resolve('capture').install();
  di.start('engine');
})();
