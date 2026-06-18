/**
 * YouTube Caption Karaoke — Manifest V3 content script (MAIN world, document_start).
 *
 * Adapted from the project's karaoke.js. Key differences for the shipped extension:
 *  - Network-capture hooks (fetch / XMLHttpRequest) are installed IMMEDIATELY at
 *    top level so the player's FIRST timedtext json3 request is captured (no CC toggle needed).
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

  // ---- Global, one-time network capture (installed at document_start) ----
  const captured = window.__YK_CAP__ || (window.__YK_CAP__ = new Map());

  function installNetworkCapture() {
    if (window.__YK_NET__) return;
    window.__YK_NET__ = true;
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      const out = origFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        if (url && url.includes('/api/timedtext')) {
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
      if (this.__ykUrl && String(this.__ykUrl).includes('/api/timedtext')) {
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

  function pickAutoCaptionTrack(tracks) {
    if (!tracks?.length) return null;
    const player = document.querySelector('#movie_player');
    const active = player?.getOption?.('captions', 'track');
    if (active?.languageCode) {
      const sameLang = tracks.filter((t) => t.languageCode === active.languageCode);
      if (sameLang.length) {
        const asr = sameLang.find((t) => t.kind === 'asr');
        const byKind = active.kind && sameLang.find((t) => t.kind === active.kind);
        return asr || byKind || sameLang[0];
      }
    }
    return (
      tracks.find((t) => t.kind === 'asr') ||
      tracks.find((t) => /auto|自動|生成/i.test(t.name?.simpleText || '')) ||
      tracks[0]
    );
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

  function pickCapturedJson(track) {
    const vid = currentVideoId();
    let best = null;
    let bestScore = -1;
    for (const [url, text] of captured) {
      const json = captionJsonFromText(text);
      if (!json) continue;
      let lang = null;
      let asr = false;
      let json3 = false;
      let urlVid = null;
      try {
        const u = new URL(url, location.origin);
        lang = u.searchParams.get('lang');
        asr = u.searchParams.get('kind') === 'asr' || u.searchParams.get('caps') === 'asr';
        json3 = u.searchParams.get('fmt') === 'json3';
        urlVid = u.searchParams.get('v');
      } catch {
        /* ignore */
      }
      // Avoid mixing in another video's captured captions after SPA navigation.
      if (vid && urlVid && urlVid !== vid) continue;
      if (track.languageCode && lang && lang !== track.languageCode) continue;
      const score = (asr ? 2 : 0) + (json3 ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = json;
      }
    }
    return best;
  }

  function enablePlayerCaptions(track) {
    const player = document.querySelector('#movie_player');
    if (!player?.setOption) return;
    // Triggers the player to fetch the asr timedtext track. Audio is untouched.
    player.setOption('captions', 'display', true);
    if (track.languageCode) {
      const payload = { languageCode: track.languageCode };
      if (track.kind) payload.kind = track.kind;
      player.setOption('captions', 'track', payload);
    }
  }

  function waitForCapturedJson(track, timeoutMs = 12000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const id = setInterval(() => {
        const json = pickCapturedJson(track);
        if (json || Date.now() - start > timeoutMs || !state.active) {
          clearInterval(id);
          resolve(json || null);
        }
      }, 200);
    });
  }

  async function loadCaptionJsonFromUrl(url) {
    const u = new URL(url, location.origin);
    u.searchParams.set('fmt', 'json3');
    const res = await fetch(u.toString(), { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`Caption fetch failed: ${res.status}`);
    const text = await res.text();
    if (!text.trim()) return null;
    const json = JSON.parse(text);
    if (!json?.events?.length) return null;
    return json;
  }

  async function fetchCaptionJson(track) {
    // Hooks already installed at top level; the first timedtext request is captured.
    const already = pickCapturedJson(track);
    if (already) return already;

    if (track.baseUrl) {
      const direct = await loadCaptionJsonFromUrl(track.baseUrl).catch(() => null);
      if (direct) return direct;
    }

    // Captions were never requested by the player — enable the asr track to trigger a fetch.
    enablePlayerCaptions(track);

    const json = await waitForCapturedJson(track);
    if (!json) {
      throw new Error('No caption body captured (timedtext pot-gated; CC may be unavailable)');
    }
    return json;
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
      .ytp-caption-window-container,
      .caption-window.ytp-caption-window-bottom {
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

  function tick() {
    if (!state.active) return;
    const v = state.video || getVideo();
    if (!v) return;
    state.video = v;
    render(v.currentTime * 1000);
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
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    state.stage = 'pick-track';
    const track = pickAutoCaptionTrack(tracks);
    if (!track) {
      throw new Error(`No caption tracks available (tracks=${tracks?.length || 0})`);
    }
    state.trackLang = track.languageCode || '';
    console.info('[YT Karaoke] Using track:', track.name?.simpleText || state.trackLang, track.kind);

    state.stage = 'fetch-caption';
    const json = await fetchCaptionJson(track);
    if (!state.active) return;

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
      console.error('[YT Karaoke] failed at stage', state.stage, err);
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
