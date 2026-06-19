/**
 * YouTube Caption Karaoke — Manifest V3 content script (MAIN world, document_start).
 *
 * Adapted from the project's karaoke.js. Key differences for the shipped extension:
 *  - Caption acquisition model — three distinct roles, never conflate them:
 *      • player — YouTube's player; the ONLY actor that can FETCH a timedtext
 *        track, because its requests carry a valid `pot` (proof-of-origin) token.
 *      • hook   — our passive interception of the player's fetch/XHR calls; it
 *        only CAPTURES bodies the player itself fetched. The hook never fetches.
 *      • us     — we never fetch (a direct timedtext fetch is pot-gated and
 *        returns an empty body) and we never drive the player. There is no
 *        "fetch"/"抓" concept here: karaoke is a passive BINDING to whatever
 *        auto-caption the player currently displays. The asr track is selected
 *        externally (by the user, or automation/MCP); we install the hook, wait
 *        for it to capture the body, then render. While no auto-caption is
 *        selected we stay idle — that is the normal waiting state, not an error.
 *    The hook is installed at top level (document_start) so it is already in place
 *    when the player makes its first timedtext request.
 *    (Driving the player to auto-select the asr track is NOT implemented — see
 *    karaoke.js / project notes; today the auto-caption must be selected manually.)
 *  - Never mutes the video and never disables autoplay-next (no playback/audio interference).
 *  - Handles YouTube SPA navigation: tears down + re-inits per /watch video.
 *  - Real per-word timing only (seg.tOffsetMs). No simulated/interpolated word timing.
 */
(function () {
  'use strict';

  const STYLE_ID = 'yt-karaoke-style';
  const ROOT_ID = 'yt-karaoke-root';
  const TOGGLE_ID = 'yt-karaoke-toggle';
  const ENABLED_KEY = 'yt-karaoke-enabled';
  const MAX_LINE_CHARS = 48;
  const LINE_BREAK_GAP_MS = 700;

  // Single logger for the whole content script: every line emitted to the page
  // console is prefixed with a stable tag so it is unambiguously attributable to
  // this extension. Never call console.* directly elsewhere — go through log.*.
  const LOG_TAG = '[YT Karaoke]';
  const log = {
    info: (...args) => console.info(LOG_TAG, ...args),
    warn: (...args) => console.warn(LOG_TAG, ...args),
    error: (...args) => console.error(LOG_TAG, ...args),
  };

  // ---- Hook: passively captures the player's ASR timedtext response (document_start) ----
  // Interception only — it reads a body the PLAYER fetched; it never fetches. It
  // captures ONLY the auto-caption resource (request URL carries `kind=asr`), so
  // `captured` holds just the single track we bind to — there is nothing else to
  // sift through later (no manual/translated bodies, no re-judging which is asr).
  const captured = window.__YK_CAP__ || (window.__YK_CAP__ = new Map());

  // The asr track's request is the only one we want, and it is precisely the one
  // whose URL has the `kind=asr` param. Manual tracks carry `caps=asr` but never
  // `kind=asr`, so this excludes them.
  function isAsrTimedtextUrl(url) {
    return (
      typeof url === 'string' && url.includes('/api/timedtext') && /[?&]kind=asr(?:&|$)/.test(url)
    );
  }

  function installNetworkCapture() {
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

  // Install hooks NOW, before YouTube's player code runs.
  installNetworkCapture();

  // ---- Per-video lifecycle state ----
  let state = freshState();

  function freshState() {
    return {
      words: [],
      lines: [],
      video: null,
      raf: 0,
      trackLang: '',
      lineKey: '',
      wordEls: [],
      stage: 'idle',
      videoId: '',
      active: false,
      captureTimer: 0,
    };
  }

  function isEnabled() {
    try {
      return localStorage.getItem(ENABLED_KEY) !== 'false';
    } catch {
      return true;
    }
  }

  function setEnabled(on) {
    try {
      localStorage.setItem(ENABLED_KEY, on ? 'true' : 'false');
    } catch {
      /* ignore */
    }
  }

  function currentVideoId() {
    try {
      return new URLSearchParams(location.search).get('v') || '';
    } catch {
      return '';
    }
  }

  function isWatchPage() {
    return location.pathname === '/watch' && !!currentVideoId();
  }

  function getPlayerResponse() {
    return (
      window.ytInitialPlayerResponse ||
      document.querySelector('#movie_player')?.getPlayerResponse?.() ||
      null
    );
  }

  function getVideo() {
    return (
      document.querySelector('#movie_player video') ||
      document.querySelector('video.html5-main-video')
    );
  }

  // True while YouTube is playing an ad: the player gains the `ad-showing`
  // class and the active <video> element is the ad, not the watch video.
  function isAdShowing() {
    const player =
      document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    return !!player && player.classList.contains('ad-showing');
  }

  // Identify the auto-generated (ASR) caption track for THIS video using only
  // video-intrinsic data (kind === 'asr'), never the user's caption/UI settings.
  // We NEVER guess: if there is no ASR track, or multiple ASR tracks that cannot
  // be disambiguated down to exactly one, return null (not found). A wrong track
  // would carry no/incorrect per-word timing, so the old fallbacks (asrTracks[0],
  // name-matching, tracks[0]) are removed — not-found is an explicit outcome.
  function pickAutoCaptionTrack(tracks, tracklist) {
    if (!tracks?.length) return null;
    const asrTracks = tracks.filter((t) => t.kind === 'asr');
    // Exactly one ASR track → unambiguous.
    if (asrTracks.length === 1) return asrTracks[0];
    // No ASR track → this video has no auto-caption to bind to. Not found.
    if (asrTracks.length === 0) return null;
    // Multiple ASR tracks (rare): the only video-intrinsic disambiguator is the
    // video's default audio language. Accept it ONLY if it resolves to exactly
    // one ASR track; anything else is genuinely ambiguous → not found.
    const audioTracks = tracklist?.audioTracks;
    const defAudioIdx = tracklist?.defaultAudioTrackIndex;
    const defAudio = Number.isInteger(defAudioIdx) ? audioTracks?.[defAudioIdx] : undefined;
    const audioCapIdx = defAudio?.captionTrackIndices?.[0];
    const byAudio = Number.isInteger(audioCapIdx) ? tracks[audioCapIdx] : undefined;
    const defCapIdx = tracklist?.defaultCaptionTrackIndex;
    const byDefaultCap = Number.isInteger(defCapIdx) ? tracks[defCapIdx] : undefined;
    const preferredLang = byAudio?.languageCode || byDefaultCap?.languageCode;
    if (!preferredLang) return null;
    const matches = asrTracks.filter((t) => t.languageCode === preferredLang);
    return matches.length === 1 ? matches[0] : null;
  }

  function captionJsonFromText(text) {
    if (!text || !text.trim()) return null;
    try {
      const json = JSON.parse(text);
      return json?.events?.length ? json : null;
    } catch {
      return null;
    }
  }

  // The asr track was already chosen by pickAutoCaptionTrack — that is the single
  // judgment. The hook captured ONLY kind=asr bodies, so we do NOT re-judge which
  // body is asr; we just locate the one for THIS track (current video, and the
  // matching language if the video exposes several asr tracks) and ASSERT it is
  // the expected per-word json3. Returns the json once captured, else null.
  function capturedJsonForTrack(track) {
    const vid = currentVideoId();
    for (const [url, text] of captured) {
      let urlVid = null;
      let lang = null;
      try {
        const u = new URL(url, location.origin);
        urlVid = u.searchParams.get('v');
        lang = u.searchParams.get('lang');
      } catch {
        continue;
      }
      if (urlVid && urlVid !== vid) continue; // captured from another video (SPA nav)
      if (track.languageCode && lang && lang !== track.languageCode) continue;
      const json = captionJsonFromText(text); // assert: the asr body must be json3 + events
      if (!json) {
        log.warn('captured asr body is not valid json3 (unexpected):', url);
        continue;
      }
      return json;
    }
    return null;
  }

  // Bind to the player's currently-selected auto-caption: wait until the player
  // has fetched the asr track and our hook has captured its body. We never drive
  // the player and we never fetch — the auto-caption is selected externally (by
  // the user, or by automation/MCP). If it is never selected we simply stay idle
  // (no overlay); that is the normal waiting state, NOT an error. Resolves with
  // the json once captured, or null if this run is torn down (SPA navigation /
  // toggle off) before it appears.
  function waitForCapturedJson(track) {
    return new Promise((resolve) => {
      const poll = () => {
        if (!state.active) {
          resolve(null);
          return;
        }
        const json = capturedJsonForTrack(track);
        if (json) {
          resolve(json);
          return;
        }
        state.captureTimer = setTimeout(poll, 200);
      };
      poll();
    });
  }

  function parseCaptionEvents(json) {
    const words = [];
    for (const ev of json.events || []) {
      if (!ev.segs) continue;
      const base = ev.tStartMs || 0;
      const blockEnd = base + (ev.dDurationMs || 0);
      for (const seg of ev.segs) {
        const text = seg.utf8;
        if (!text || text === '\n') continue;
        // Real per-word offset only — never interpolated.
        const start = base + (seg.tOffsetMs || 0);
        words.push({ text, start, end: blockEnd });
      }
    }
    words.sort((a, b) => a.start - b.start);
    for (let i = 0; i < words.length - 1; i++) {
      const next = words[i + 1];
      if (words[i].end > next.start) words[i].end = next.start;
    }
    return words;
  }

  // Chars that are NOT space-delimited (CJK / full-width). When either side of a
  // word boundary is one of these, no ASCII space should be inserted.
  const CJK_RE = /[\u2E80-\u9FFF\u3000-\u303F\uAC00-\uD7AF\uFF00-\uFFEF]/;

  // json3 encodes inter-word spacing as a LEADING space inside each seg, but the
  // first seg of each event has none. When groupLines merges events, the first
  // word of an appended event would glue to the previous word. Restore a single
  // space at such boundaries (text only — never affects timing).
  function needsBoundarySpace(prevText, curText) {
    if (!prevText || !curText) return false;
    if (/\s$/.test(prevText) || /\n$/.test(prevText)) return false;
    if (/^\s/.test(curText) || /^\n/.test(curText)) return false;
    const prevLast = prevText[prevText.length - 1];
    const curFirst = curText[0];
    if (CJK_RE.test(prevLast) || CJK_RE.test(curFirst)) return false;
    return true;
  }

  function groupLines(words) {
    if (!words.length) return [];
    const lines = [];
    let current = { words: [], start: words[0].start, end: words[0].end };

    const flush = () => {
      if (!current.words.length) return;
      current.text = current.words.map((w) => w.text).join('');
      lines.push(current);
      current = { words: [], start: 0, end: 0 };
    };

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const prev = current.words[current.words.length - 1];
      const gap = prev ? w.start - prev.end : 0;
      const len = current.words.reduce((n, x) => n + x.text.length, 0) + w.text.length;
      const hardBreak = /\n$/.test(prev?.text || '') || /^\n/.test(w.text);
      // YouTube/CEA captions use ">>" to mark a change of speaker (">>>" for a
      // change of topic). Keep the marker text, but force a new line to start at
      // it so speakers don't run together. Treated as an extra hard break.
      const speakerBreak = /^\s*>>/.test(w.text);

      if (current.words.length && (hardBreak || speakerBreak || gap > LINE_BREAK_GAP_MS || len > MAX_LINE_CHARS)) {
        flush();
        current = { words: [], start: w.start, end: w.end };
      }

      // Insert a space at event seams (never for the line-leading word).
      const linePrev = current.words[current.words.length - 1];
      if (linePrev && needsBoundarySpace(linePrev.text, w.text)) {
        w.text = ` ${w.text}`;
      }

      current.words.push(w);
      current.end = Math.max(current.end || 0, w.end, w.start + 400);
      if (!current.start && current.start !== 0) current.start = w.start;
      if (w.start < current.start) current.start = w.start;
    }
    flush();
    return lines;
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      /* Hide the native caption ONLY while engaged (asr is the selected track and
         we are showing karaoke). When the user picks another track / turns captions
         off, we remove .yk-engaged so the native caption shows normally. */
      .yk-engaged .ytp-caption-window-container,
      .yk-engaged .caption-window.ytp-caption-window-bottom {
        opacity: 0 !important;
        pointer-events: none !important;
      }
      #${ROOT_ID} {
        position: absolute;
        left: 50%;
        bottom: 8%;
        transform: translateX(-50%);
        z-index: 65;
        max-width: 92%;
        text-align: center;
        pointer-events: none;
        font-family: "YouTube Noto", Roboto, Arial, sans-serif;
        line-height: 1.35;
        transition: opacity 0.15s ease;
      }
      #${ROOT_ID} .yk-line {
        display: inline-block;
        padding: 0.35em 0.65em;
        border-radius: 6px;
        background: rgba(8, 8, 8, 0.72);
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
      }
      #${ROOT_ID} .yk-word {
        display: inline;
        font-size: clamp(18px, 2.4vw, 28px);
        font-weight: 600;
        letter-spacing: 0.02em;
        white-space: pre-wrap;
        transition: color 0.08s linear, text-shadow 0.08s linear, transform 0.08s linear;
      }
      #${ROOT_ID} .yk-word--past {
        color: rgba(255, 255, 255, 0.45);
      }
      #${ROOT_ID} .yk-word--future {
        color: rgba(255, 255, 255, 0.88);
      }
      #${ROOT_ID} .yk-word--active {
        color: #ffe566;
        text-shadow: 0 0 12px rgba(255, 229, 102, 0.55), 0 1px 2px rgba(0,0,0,0.9);
        transform: scale(1.04);
        display: inline-block;
      }
      #${ROOT_ID}[data-hidden="true"] { opacity: 0; }
      #${TOGGLE_ID} {
        position: absolute;
        top: 12px;
        right: 12px;
        z-index: 66;
        padding: 4px 10px;
        border: none;
        border-radius: 4px;
        background: rgba(8, 8, 8, 0.72);
        color: #fff;
        font: 600 12px/1.4 Roboto, Arial, sans-serif;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.15s ease;
      }
      .html5-video-player:hover #${TOGGLE_ID},
      #movie_player:hover #${TOGGLE_ID} { opacity: 0.85; }
      #${TOGGLE_ID}:hover { opacity: 1; }
      #${TOGGLE_ID}[data-on="false"] { color: rgba(255, 255, 255, 0.5); }
    `;
    document.head.appendChild(style);
  }

  function getPlayerEl() {
    return document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
  }

  function ensureOverlay() {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;
    const player = getPlayerEl();
    if (!player) throw new Error('YouTube player not found');
    if (getComputedStyle(player).position === 'static') player.style.position = 'relative';
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('aria-live', 'polite');
    player.appendChild(root);
    return root;
  }

  function ensureToggle() {
    if (document.getElementById(TOGGLE_ID)) return;
    const player = getPlayerEl();
    if (!player) return;
    const btn = document.createElement('button');
    btn.id = TOGGLE_ID;
    btn.type = 'button';
    btn.dataset.on = String(isEnabled());
    btn.textContent = isEnabled() ? 'Karaoke: ON' : 'Karaoke: OFF';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const next = !isEnabled();
      setEnabled(next);
      btn.dataset.on = String(next);
      btn.textContent = next ? 'Karaoke: ON' : 'Karaoke: OFF';
      if (next) {
        run();
      } else {
        teardown();
      }
    });
    player.appendChild(btn);
  }

  function findActiveLine(t) {
    for (let i = 0; i < state.lines.length; i++) {
      const line = state.lines[i];
      const next = state.lines[i + 1];
      if (t >= line.start - 80 && (!next || t < next.start + 80)) return line;
    }
    return null;
  }

  function wordState(w, t) {
    if (t < w.start - 30) return 'future';
    if (t >= w.start - 30 && t < w.end + 30) return 'active';
    return 'past';
  }

  function render(t) {
    const root = ensureOverlay();
    const line = findActiveLine(t);
    if (!line) {
      root.dataset.hidden = 'true';
      root.innerHTML = '';
      state.lineKey = '';
      state.wordEls = [];
      return;
    }
    root.dataset.hidden = 'false';
    const lineKey = `${line.start}|${line.words.map((w) => w.text).join('')}`;
    if (lineKey !== state.lineKey) {
      state.lineKey = lineKey;
      const lineEl = document.createElement('div');
      lineEl.className = 'yk-line';
      state.wordEls = line.words.map((w) => {
        const span = document.createElement('span');
        span.className = 'yk-word yk-word--future';
        span.textContent = w.text;
        lineEl.appendChild(span);
        return span;
      });
      root.replaceChildren(lineEl);
    }
    line.words.forEach((w, i) => {
      const cls = wordState(w, t);
      const el = state.wordEls[i];
      if (!el) return;
      const next = `yk-word yk-word--${cls}`;
      if (el.className !== next) el.className = next;
    });
  }

  // True only while the auto-caption (asr) track is the player's CURRENTLY
  // displayed caption. When the user selects a different track (manual/translated)
  // or turns captions off, getOption('captions','track') is a non-asr/empty object,
  // so this is false → we must step aside and let the native caption show. If we
  // know which asr language we bound to, also require the displayed asr track to
  // match it (a video can expose several asr languages).
  function isAsrTrackSelected() {
    const player = getPlayerEl();
    if (!player?.getOption) return false;
    try {
      const cur = player.getOption('captions', 'track');
      if (cur?.kind !== 'asr') return false;
      return !state.trackLang || !cur.languageCode || cur.languageCode === state.trackLang;
    } catch {
      return false;
    }
  }

  // Engage: we own the caption area — hide the native caption (via .yk-engaged) so
  // it does not show through behind the karaoke overlay.
  function engage() {
    getPlayerEl()?.classList.add('yk-engaged');
  }

  // Step aside: hand the caption area back to the player. Un-hide the native
  // caption and clear our overlay so we NEVER leave a blank caption behind. Used
  // while an ad plays, or whenever the selected caption is not the asr track.
  function stepAside() {
    getPlayerEl()?.classList.remove('yk-engaged');
    const root = document.getElementById(ROOT_ID);
    if (root) {
      root.dataset.hidden = 'true';
      root.innerHTML = '';
    }
    state.lineKey = '';
    state.wordEls = [];
  }

  function tick() {
    if (!state.active) return;
    const v = state.video || getVideo();
    if (!v) {
      state.raf = requestAnimationFrame(tick);
      return;
    }
    state.video = v;
    // Bind only while the asr track is the player's selected caption (and not
    // during an ad); otherwise step aside so the user's chosen native caption
    // shows — never override it with a stale/blank overlay.
    if (isAdShowing() || !isAsrTrackSelected()) {
      stepAside();
    } else {
      engage();
      render(v.currentTime * 1000);
    }
    state.raf = requestAnimationFrame(tick);
  }

  function waitForVideo() {
    return new Promise((resolve, reject) => {
      let n = 0;
      const id = setInterval(() => {
        if (!state.active) {
          clearInterval(id);
          reject(new Error('aborted'));
          return;
        }
        const v = getVideo();
        if (v) {
          clearInterval(id);
          resolve(v);
        } else if (++n > 80) {
          clearInterval(id);
          reject(new Error('Video element not found'));
        }
      }, 250);
    });
  }

  function waitForPlayerResponse(timeoutMs = 12000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const id = setInterval(() => {
        const pr = getPlayerResponse();
        const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if ((tracks && tracks.length) || Date.now() - start > timeoutMs || !state.active) {
          clearInterval(id);
          resolve(pr);
        }
      }, 200);
    });
  }

  function teardown() {
    state.active = false;
    cancelAnimationFrame(state.raf);
    clearTimeout(state.captureTimer);
    getPlayerEl()?.classList.remove('yk-engaged'); // restore the native caption
    const root = document.getElementById(ROOT_ID);
    if (root) root.remove();
    const toggle = document.getElementById(TOGGLE_ID);
    if (toggle) {
      toggle.dataset.on = String(isEnabled());
      toggle.textContent = isEnabled() ? 'Karaoke: ON' : 'Karaoke: OFF';
    }
    state = freshState();
  }

  async function init() {
    state.stage = 'styles';
    injectStyles();
    ensureToggle();
    state.videoId = currentVideoId();

    state.stage = 'player-response';
    const pr = await waitForPlayerResponse();
    if (!state.active) return;
    const tracklist = pr?.captions?.playerCaptionsTracklistRenderer;
    const tracks = tracklist?.captionTracks;

    state.stage = 'pick-track';
    const track = pickAutoCaptionTrack(tracks, tracklist);
    // No caption track on this video → nothing to bind to. Stay idle; not an error.
    if (!track) return;
    state.trackLang = track.languageCode || '';
    log.info('Binding to track:', track.name?.simpleText || state.trackLang, track.kind);

    // Bind to the player's auto-caption: wait (passively, no timeout) until the
    // selected asr track is captured by our hook. If it is never selected we stay
    // idle here — that is the normal waiting state, not an error.
    state.stage = 'await-caption';
    const json = await waitForCapturedJson(track);
    if (!json || !state.active) return;

    state.stage = 'parse';
    state.words = parseCaptionEvents(json);
    state.lines = groupLines(state.words);
    if (!state.lines.length) throw new Error('Caption parse produced no lines');

    state.stage = 'wait-video';
    state.video = await waitForVideo();
    if (!state.active) return;

    state.stage = 'running';
    cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(tick);
  }

  function run() {
    if (!isWatchPage()) return;
    if (!isEnabled()) {
      // Still show the toggle so the user can turn it back on.
      injectStyles();
      ensureToggle();
      return;
    }
    if (state.active && state.videoId === currentVideoId()) return;
    teardown();
    state = freshState();
    state.active = true;
    init().catch((err) => {
      window.__YT_KARAOKE_ERR__ = {
        stage: state.stage,
        message: String(err && err.message ? err.message : err),
        words: state.words.length,
        lines: state.lines.length,
      };
      log.error('failed at stage', state.stage, err);
      state.active = false;
    });
  }

  // ---- SPA navigation handling ----
  function onNavigate() {
    if (isWatchPage()) {
      run();
    } else {
      teardown();
    }
  }

  window.addEventListener('yt-navigate-finish', onNavigate, true);
  window.addEventListener('yt-page-data-updated', onNavigate, true);

  // Fallback: detect video id changes that did not emit a known event.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onNavigate();
    }
  }, 1000);

  // Initial attempt once the DOM is ready enough to host the overlay.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onNavigate, { once: true });
  } else {
    onNavigate();
  }
})();
