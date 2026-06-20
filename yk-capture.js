/**
 * yk-capture — passive interception of the player's ASR timedtext response.
 *
 * Three roles, never conflated: the PLAYER fetches a timedtext track (only it can —
 * its request carries a valid `pot` token); the HOOK here only CAPTURES bodies the
 * player itself fetched (it never fetches); WE never fetch and never drive the player.
 *
 * Page-global contracts (read EXTERNALLY by build-probes.js / build.js — keep names):
 *  - window.__YK_CAP__ : Map<url, body> of captured asr bodies. PERSISTS across SPA
 *    navigations and accumulates over videos; capturedJsonForVariant filters by the
 *    URL's `?v=`. NEVER cleared on teardown/navigate — that is what lets the overlay
 *    re-engage instantly after an ad (the body is still here).
 *  - window.__YK_NET__ : one-shot guard so the fetch/XHR patch installs exactly once,
 *    even across re-resolves/hot-swaps. install() is idempotent.
 */
(function () {
  'use strict';
  window.__YK__.register('capture', ['log', 'parse', 'yt'], (log, parse, yt) => {
    const captured = window.__YK_CAP__ || (window.__YK_CAP__ = new Map());

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

    function install() {
      if (window.__YK_NET__) return;
      window.__YK_NET__ = true;
      const origFetch = window.fetch;
      window.fetch = function (...args) {
        const out = origFetch.apply(this, args);
        try {
          const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
          if (isAsrTimedtextUrl(url)) {
            out
              .then((res) => res.clone().text())
              .then((t) => {
                if (t) captured.set(url, t);
              })
              .catch(() => {});
          }
        } catch {
          /* ignore */
        }
        return out;
      };
      const open = XMLHttpRequest.prototype.open;
      const send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__ykUrl = url;
        return open.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function (...args) {
        if (isAsrTimedtextUrl(String(this.__ykUrl))) {
          this.addEventListener('load', () => {
            try {
              if (this.responseText) captured.set(String(this.__ykUrl), this.responseText);
            } catch {
              /* ignore */
            }
          });
        }
        return send.apply(this, args);
      };
    }

    // Locate the captured body for ONE variant of the asr track: tlang === '' is the
    // original auto-caption; otherwise the auto-translation to that language. We match
    // this video, the asr language, and the exact translation variant, then ASSERT the
    // body is the expected per-word json3. Returns the json, or null if not captured yet.
    function capturedJsonForVariant(track, tlang) {
      const vid = yt.currentVideoId();
      for (const [url, text] of captured) {
        let u;
        try {
          u = new URL(url, location.origin);
        } catch {
          continue;
        }
        const urlVid = u.searchParams.get('v');
        if (urlVid && urlVid !== vid) continue; // captured from another video (SPA nav)
        const lang = u.searchParams.get('lang');
        if (track.languageCode && lang && lang !== track.languageCode) continue;
        if ((u.searchParams.get('tlang') || '') !== tlang) continue; // wrong translation variant
        const json = parse.captionJsonFromText(text); // assert: per-word json3 + events
        if (!json) {
          log.warn('captured asr body is not valid json3 (unexpected):', url);
          continue;
        }
        return json;
      }
      return null;
    }

    return { install, capturedJsonForVariant };
  });
})();
