/**
 * yk-capture — interception of the player's ASR timedtext response. Two jobs, kept
 * separate so the transform (job 2) cannot corrupt the pool (job 1):
 *
 *  1. CAPTURE (always, passive): store the ORIGINAL body the player fetched into
 *     window.__YK_CAP__ — the source data for the overlay / side-transcript /
 *     dual-track cook. We read it via a native prototype getter snapshotted at resolve
 *     (NATIVE_RT), NOT via this.responseText: job 2 below shadows the instance getter,
 *     and the shadow returns the cooked body.
 *
 *  2. TRANSFORM (opt-in, for native playback mode): when a transform fn is registered
 *     (window.__YK_TX__.fn, set by yk-native), the PLAYER receives fn(url, original)
 *     instead of the original — i.e. the cooked karaoke json3 — so YouTube's own
 *     renderer draws the karaoke. With NO transform registered (overlay mode) the
 *     player receives the original body byte-for-byte, so behaviour is unchanged.
 *
 * Division of labour: the PLAYER fetches (its request carries the `pot` token; a bare
 * fetch of a timedtext URL gets an empty body). This module only captures and swaps
 * bodies — track selection lives in yk-autodrive.
 *
 * Page-global contracts (names are read EXTERNALLY / must survive module re-resolve):
 *  - window.__YK_CAP__ : Map<url, ORIGINAL body>. PERSISTS across SPA navigations and
 *    accumulates over videos; capturedJsonForVariant filters by the URL's `?v=`.
 *  - window.__YK_NET__ : one-shot guard so the fetch/XHR patch installs exactly once,
 *    even across re-resolves/hot-swaps. install() is idempotent.
 *  - window.__YK_TX__  : { fn } the live transform. A PAGE-GLOBAL (not factory closure)
 *    so the once-installed patch closures read the CURRENT transform after a hot-swap of
 *    yk-capture/yk-native. registerTransform/clearTransform write it.
 *  - window.__YK_NETIMPL__ : the hot-swappable BEHAVIOUR of the once-installed patch.
 *    The patch closures themselves can never be reinstalled (__YK_NET__), so they hold
 *    NO logic: every decision (URL match, pool validation, native reads, transform
 *    application) is called through this object, and EVERY factory resolve re-points
 *    its fields to the fresh module's functions. Without this, a hot-swap of yk-capture
 *    would silently keep running the first-ever version of that logic — invisible and
 *    unverifiable from a live MCP-injection session.
 */
(function () {
  'use strict';
  window.__YK__.register('capture', ['log', 'parse', 'yt'], (log, parse, yt) => {
    const captured = window.__YK_CAP__ || (window.__YK_CAP__ = new Map());
    const tx = window.__YK_TX__ || (window.__YK_TX__ = { fn: null });
    const impl = window.__YK_NETIMPL__ || (window.__YK_NETIMPL__ = {});

    // Snapshot the NATIVE accessors at resolve so capture always reads the ORIGINAL even
    // after the instance getters are shadowed below. Re-snapshotting on a re-resolve is
    // safe: we shadow instances, never the prototype. Guarded so a test stub XHR (no
    // responseText descriptor) doesn't throw at resolve time.
    const rtDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
    const rDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');
    const NATIVE_RT = rtDesc ? rtDesc.get : null;
    const NATIVE_R = rDesc ? rDesc.get : null;
    function nativeText(xhr) {
      try {
        // responseText is only valid for responseType '' / 'text'; for 'json' the spec makes it
        // throw, so read the parsed value via NATIVE_R and re-stringify (capture + cook both want
        // the body as a string). YouTube uses the default (text) path in practice; this keeps the
        // json branch correct so the original is still captured and the cook still applies.
        if (xhr.responseType === 'json') {
          const r = NATIVE_R ? NATIVE_R.call(xhr) : null;
          return r != null ? JSON.stringify(r) : '';
        }
        return NATIVE_RT ? NATIVE_RT.call(xhr) : xhr.responseText;
      } catch {
        return '';
      }
    }
    function nativeResponse(xhr) {
      return NATIVE_R ? NATIVE_R.call(xhr) : xhr.responseText;
    }

    // The asr track's request is the only one we want, and it is precisely the one
    // whose URL has the `kind=asr` param. Manual tracks carry `caps=asr` but never
    // `kind=asr`, so this excludes them.
    function isAsrTimedtextUrl(url) {
      return (
        typeof url === 'string' &&
        url.includes('/api/timedtext') &&
        /[?&]kind=asr(?:&|$)/.test(url)
      );
    }

    // Apply the registered transform to ONE original body for the player, defensively.
    // Returns the cooked string, or null to mean "serve the original unchanged".
    function applyTransform(url, original) {
      if (!tx.fn) return null;
      try {
        const cooked = tx.fn(url, original);
        return cooked != null && cooked !== original ? cooked : null;
      } catch (e) {
        log.warn('native transform failed; serving original:', e);
        return null;
      }
    }

    // Store the ORIGINAL body in the pool, but ONLY if it is valid per-word json3. The
    // timedtext URL carries a rotating pot/expire/signature, so the SAME variant is fetched
    // under many different URLs over a session (page-load, an auto-drive, a native re-fetch);
    // an early/empty/error response would otherwise sit in the pool under its own URL forever
    // and make capturedJsonForVariant warn on every render tick. Validate once here so the
    // pool only ever holds usable json3 — and hasCapturedVariant can trust presence alone.
    // Returns whether the body was stored (noteResult keys the failure ledger off this).
    function storeOriginal(url, text) {
      const ok = !!(text && parse.captionJsonFromText(text));
      if (ok) captured.set(url, text);
      return ok;
    }

    // 壞回應台帳：per-VARIANT（URL 的 pot/expire 每次都轉，按 URL 記連續失敗永遠是 1）。
    // storeOriginal 擋下的回應以前「觀察不到地死」——autodrive 只能盲目 10 秒重踢；
    // YouTube 對 tlang=（自動翻譯）路徑回 429 限流時，盲踢只會延長封鎖。這裡記下
    // HTTP 狀態與連續次數，lastFailure 讓 autodrive 據此指數退避；成功入池即清帳。
    const failures = new Map(); // `${v}|${lang}|${tlang}` -> { status, count }
    const FAILURES_MAX = 64; // 跨導航累積的變體數上限（與 memo 同思路，防整 session 增長）
    const failureKey = (v, lang, tlang) => v + '|' + lang + '|' + tlang;
    function noteResult(url, status, stored) {
      const id = variantFromUrl(url);
      if (!id) return;
      const key = failureKey(id.v, id.lang, id.tlang);
      if (stored) {
        failures.delete(key);
        return;
      }
      const prev = failures.get(key);
      const count = (prev ? prev.count : 0) + 1;
      failures.delete(key); // 重插到 Map 尾端：淘汰順序＝最舊觀察
      failures.set(key, { status: status || 0, count });
      while (failures.size > FAILURES_MAX) failures.delete(failures.keys().next().value);
      // 只在首次觀察到該變體失敗時記一行（action edge；重試沿用 autodrive 的 stall log）。
      if (count === 1) {
        log.warn(
          'capture', 'timedtext HTTP', status || 'error', 'for', log.variant(id.lang, id.tlang),
          '— body not usable' + (status === 429 ? ' (rate-limited by YouTube)' : ''),
        );
      }
    }
    // autodrive 查詢口：這個變體最近的壞回應（無紀錄或已成功 → null）。
    function lastFailure(track, tlang) {
      return failures.get(failureKey(yt.currentVideoId(), track.languageCode || '', tlang)) || null;
    }

    // 在途台帳：同變體有請求還在路上時，autodrive 不得再 setOption 選它——重選會讓
    // 播放器 abort 在途請求重發，而 abort 只是客戶端不讀回應、伺服器端已收單計入
    // 配額（429 限流下每個被取消的請求都白燒一次額度）。記 performance.now 時戳而
    // 非計數：loadend 若因頁面拆除沒送達，殘影會在 INFLIGHT_TTL_MS 後自動過期，
    // 不會把 inFlight 永久卡在 true。
    const inflight = new Map(); // `${v}|${lang}|${tlang}` -> [startedAt, ...]
    const INFLIGHT_TTL_MS = 30000;
    function noteSent(url) {
      const id = variantFromUrl(url);
      if (!id) return;
      const key = failureKey(id.v, id.lang, id.tlang);
      const list = inflight.get(key) || [];
      list.push(performance.now());
      inflight.set(key, list);
    }
    function noteSettled(url) {
      const id = variantFromUrl(url);
      if (!id) return;
      const key = failureKey(id.v, id.lang, id.tlang);
      const list = inflight.get(key);
      if (!list) return;
      list.shift();
      if (!list.length) inflight.delete(key);
    }
    function noteAborted(url) {
      const id = variantFromUrl(url);
      if (!id) return;
      // 每個取消記一行帶變體標籤（action edge）：取消通常來自播放器 session 重建或
      // 選軌更替把在途請求換掉——伺服器端照樣計入配額，對帳時要能逐筆點名。
      log.info('capture', 'timedtext request aborted (superseded) for', log.variant(id.lang, id.tlang));
    }
    function inFlight(track, tlang) {
      const list = inflight.get(failureKey(yt.currentVideoId(), track.languageCode || '', tlang));
      if (!list) return false;
      const cutoff = performance.now() - INFLIGHT_TTL_MS;
      return list.some((t) => t > cutoff);
    }

    // Re-point the live patch behaviour to THIS resolve's functions. Runs on every factory
    // resolve, so a hot-swap of yk-capture (or of yk-parse, which re-resolves us) takes
    // effect inside the already-installed fetch/XHR closures immediately.
    impl.isAsrTimedtextUrl = isAsrTimedtextUrl;
    impl.nativeText = nativeText;
    impl.nativeResponse = nativeResponse;
    impl.applyTransform = applyTransform;
    impl.storeOriginal = storeOriginal;
    impl.noteResult = noteResult;
    impl.noteSent = noteSent;
    impl.noteSettled = noteSettled;
    impl.noteAborted = noteAborted;

    function install() {
      if (window.__YK_NET__) return;
      window.__YK_NET__ = true;
      const origFetch = window.fetch;
      window.fetch = function (...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        if (!impl.isAsrTimedtextUrl(url)) return origFetch.apply(this, args);
        // asr fetch: always capture the original; serve cooked to the caller iff a
        // transform is registered. (YouTube uses XHR for timedtext in practice; this
        // path is kept symmetric for robustness.)
        const pending = origFetch.apply(this, args);
        impl.noteSent(url);
        return pending.then(async (res) => {
          impl.noteSettled(url);
          let text = '';
          try {
            text = await res.clone().text();
          } catch {
            return res;
          }
          impl.noteResult(url, res.status, impl.storeOriginal(url, text));
          const cooked = impl.applyTransform(url, text);
          if (cooked == null) return res;
          return new Response(cooked, {
            status: res.status,
            statusText: res.statusText,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          });
        }, (e) => {
          impl.noteSettled(url); // 網路層 reject（abort/斷線）也要結清在途
          throw e;
        });
      };
      const open = XMLHttpRequest.prototype.open;
      const send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__ykUrl = url;
        return open.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function (...args) {
        if (impl.isAsrTimedtextUrl(String(this.__ykUrl))) {
          const url = String(this.__ykUrl);
          impl.noteSent(url);
          // Capture the ORIGINAL via the native getter (never this.responseText, which we
          // shadow next — reading it would store the COOKED body and corrupt the pool).
          this.addEventListener('load', () => {
            try {
              impl.noteResult(url, this.status, impl.storeOriginal(url, impl.nativeText(this)));
            } catch {
              /* ignore */
            }
          });
          this.addEventListener('error', () => {
            try {
              impl.noteResult(url, 0, false); // 網路層死亡（status 0）也入台帳
            } catch {
              /* ignore */
            }
          });
          this.addEventListener('abort', () => {
            try {
              impl.noteAborted(url); // 被取代／取消：只記 log，不入失敗台帳（無伺服器裁決）
            } catch {
              /* ignore */
            }
          });
          // load / error / abort 三種結局都會走 loadend：在途台帳只在這裡結清一次。
          this.addEventListener('loadend', () => {
            try {
              impl.noteSettled(url);
            } catch {
              /* ignore */
            }
          });
          // Shadow responseText/response so the PLAYER receives the cooked body when a
          // transform is registered; otherwise the native body, byte-identical. tx.fn is
          // read dynamically (so a transform registered after send() still applies).
          Object.defineProperty(this, 'responseText', {
            configurable: true,
            get() {
              const orig = impl.nativeText(this);
              if (this.readyState === 4) {
                const cooked = impl.applyTransform(url, orig);
                if (cooked != null) return cooked;
              }
              return orig;
            },
          });
          Object.defineProperty(this, 'response', {
            configurable: true,
            get() {
              if (this.readyState !== 4 || !tx.fn) {
                return impl.nativeResponse(this);
              }
              const cooked = impl.applyTransform(url, impl.nativeText(this));
              if (cooked != null) return this.responseType === 'json' ? JSON.parse(cooked) : cooked;
              return impl.nativeResponse(this);
            },
          });
        }
        return send.apply(this, args);
      };
    }

    // Register the live transform (native mode) / clear it (overlay mode). Writes the
    // page-global so the already-installed patch closures pick it up immediately, and so
    // a hot-swap of yk-capture/yk-native re-points cleanly.
    function registerTransform(fn) {
      tx.fn = typeof fn === 'function' ? fn : null;
    }
    function clearTransform() {
      tx.fn = null;
    }

    // timedtext URL → 變體身分（v / lang / tlang 的唯一解碼點；'' = 原文，解不開回 null）。
    // 池匹配（下方 variantUrlMatches）與 yk-native cook 的守門/dual 查找 key 都走這裡——
    // 兩端各自解碼的話，匹配規則一改就對「同一變體」認定分家（dual 查池默默 miss）。
    function variantFromUrl(url) {
      let u;
      try {
        u = new URL(url, location.origin);
      } catch {
        return null;
      }
      return {
        v: u.searchParams.get('v') || '',
        lang: u.searchParams.get('lang') || '',
        tlang: u.searchParams.get('tlang') || '',
      };
    }

    // ONE variant of the asr track = this video + the asr language + the exact translation
    // variant. v 缺席視為本影片（player 的請求一律帶 v，寬鬆分支屬防禦性）。
    function variantUrlMatches(url, track, tlang, vid) {
      const id = variantFromUrl(url);
      if (!id) return false;
      if (id.v && id.v !== vid) return false; // captured from another video (SPA nav)
      if (track.languageCode && id.lang && id.lang !== track.languageCode) return false;
      return id.tlang === tlang;
    }

    // Existence check WITHOUT parsing. The pool is validated on the way in (storeOriginal),
    // so presence alone means "usable json3 is captured" — safe and cheap enough for the
    // per-frame edge-signature computation in yk-native (no per-tick JSON.parse).
    function hasCapturedVariant(track, tlang) {
      const vid = yt.currentVideoId();
      for (const url of captured.keys()) {
        if (variantUrlMatches(url, track, tlang, vid)) return true;
      }
      return false;
    }

    // Locate + parse the captured body for ONE variant. Returns the json, or null if not
    // captured yet. An entry that fails the parse (only possible for pool contents written
    // by a pre-validation version of this module) is skipped silently — this runs in
    // the per-frame render loop and a log here would spam thousands of lines per video.
    function capturedJsonForVariant(track, tlang) {
      const vid = yt.currentVideoId();
      for (const [url, text] of captured) {
        if (!variantUrlMatches(url, track, tlang, vid)) continue;
        const json = parse.captionJsonFromText(text);
        if (!json) continue;
        return json;
      }
      return null;
    }

    // dispose clears the transform: the installed XHR getters are permanent, so a
    // transform left behind would keep cooking after the module is gone (the patch
    // itself is one-shot via __YK_NET__ and intentionally stays; its behaviour follows
    // the newest resolve through __YK_NETIMPL__).
    return {
      install,
      variantFromUrl,
      capturedJsonForVariant,
      hasCapturedVariant,
      lastFailure,
      inFlight,
      registerTransform,
      clearTransform,
      dispose: clearTransform,
    };
  });
})();
