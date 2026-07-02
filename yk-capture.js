/**
 * yk-capture — interception of the player's ASR timedtext response. Two jobs, kept
 * strictly separate so the second never corrupts the first:
 *
 *  1. CAPTURE (always, passive): store the ORIGINAL body the player fetched into
 *     window.__YK_CAP__. This is what the overlay / side-transcript / dual-track cook
 *     read, so it MUST always be the real body — never a cooked one. We read it via a
 *     native prototype getter snapshotted at resolve (NATIVE_RT), NOT via
 *     this.responseText, precisely because job 2 below shadows the instance getter.
 *
 *  2. TRANSFORM (opt-in, for native playback mode): when a transform fn is registered
 *     (window.__YK_TX__.fn, set by yk-native), the PLAYER receives fn(url, original)
 *     instead of the original — i.e. the cooked karaoke json3 — so YouTube's own
 *     renderer draws the karaoke. With NO transform registered (overlay mode) the
 *     player receives the original body byte-for-byte, so behaviour is unchanged.
 *
 * The three roles stay honest: the PLAYER fetches (its request carries a valid `pot`
 * token); we never fetch; we only CAPTURE the original and OPTIONALLY swap what the
 * player reads back. We still never drive the player from here.
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
    function storeOriginal(url, text) {
      if (text && parse.captionJsonFromText(text)) captured.set(url, text);
    }

    // Re-point the live patch behaviour to THIS resolve's functions. Runs on every factory
    // resolve, so a hot-swap of yk-capture (or of yk-parse, which re-resolves us) takes
    // effect inside the already-installed fetch/XHR closures immediately.
    impl.isAsrTimedtextUrl = isAsrTimedtextUrl;
    impl.nativeText = nativeText;
    impl.nativeResponse = nativeResponse;
    impl.applyTransform = applyTransform;
    impl.storeOriginal = storeOriginal;

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
        return origFetch.apply(this, args).then(async (res) => {
          let text = '';
          try {
            text = await res.clone().text();
          } catch {
            return res;
          }
          impl.storeOriginal(url, text);
          const cooked = impl.applyTransform(url, text);
          if (cooked == null) return res;
          return new Response(cooked, {
            status: res.status,
            statusText: res.statusText,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          });
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
          // Capture the ORIGINAL via the native getter (never this.responseText, which we
          // shadow next — reading it would store the COOKED body and corrupt the pool).
          this.addEventListener('load', () => {
            try {
              impl.storeOriginal(url, impl.nativeText(this));
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

    // ONE variant of the asr track = this video + the asr language + the exact translation
    // variant (tlang === '' is the original auto-caption). Pure URL-param match.
    function variantUrlMatches(url, track, tlang, vid) {
      let u;
      try {
        u = new URL(url, location.origin);
      } catch {
        return false;
      }
      const urlVid = u.searchParams.get('v');
      if (urlVid && urlVid !== vid) return false; // captured from another video (SPA nav)
      const lang = u.searchParams.get('lang');
      if (track.languageCode && lang && lang !== track.languageCode) return false;
      return (u.searchParams.get('tlang') || '') === tlang;
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
    // by a pre-validation version of this module) is skipped, NEVER logged — this runs in
    // the per-frame render loop and any log would spam thousands of lines per video.
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

    // dispose clears the transform so a hot-swap never leaves a stale cook wired to the
    // live XHR getters (the patch itself is one-shot via __YK_NET__ and intentionally
    // stays; its behaviour follows the newest resolve through __YK_NETIMPL__).
    return {
      install,
      capturedJsonForVariant,
      hasCapturedVariant,
      registerTransform,
      clearTransform,
      dispose: clearTransform,
    };
  });
})();
