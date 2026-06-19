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
  const TRANSCRIPT_ID = 'yt-karaoke-transcript';
  const TRANSCRIPT_BTN_ID = 'yt-karaoke-transcript-btn';
  const ENABLED_KEY = 'yt-karaoke-enabled';
  const TRANSCRIPT_OPEN_KEY = 'yt-karaoke-transcript-open';
  const TRANSCRIPT_WIDTH_KEY = 'yt-karaoke-transcript-width';
  const OVERLAY_WIDTH_KEY = 'yt-karaoke-overlay-width';
  // Lines break only where the caption DATA breaks (its own \n line structure);
  // long lines wrap via CSS — there is NO word-count cap. This gap is a fallback
  // used ONLY for captions that carry no \n line structure at all.
  const LINE_BREAK_GAP_MS = 700;

  // Live settings from the popup, relayed by bridge.js (chrome.storage -> postMessage)
  // because this MAIN-world script cannot read chrome.storage.
  const settings = { dualTrack: false };
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.__ykSettings !== true) return;
    const s = e.data.settings || {};
    settings.dualTrack = !!s.dualTrack;
  });
  // Nudge the bridge to push now, in case it initialized before this script ran.
  window.postMessage({ __ykSettingsRequest: true }, '*');

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
      bind: [], // [{ key, words, lines }] — 1 variant, or 2 when dual-track is on
      bindSig: null, // signature of the variant(s) currently parsed in
      rendered: [], // [{ lineEl, lineKey, wordEls }] aligned to bind, one row each
      video: null,
      raf: 0,
      track: null,
      trackLang: '',
      stage: 'idle',
      videoId: '',
      active: false,
      transcriptSig: null, // which variant(s) are built into the side panel
      transcriptByVariant: {}, // key -> [{ row, wordEls, line }] per line of that variant
      transcriptActive: [], // currently-highlighted row entries (1, or 2 in dual-track)
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

  // Locate the captured body for ONE variant of the asr track: tlang === '' is the
  // original auto-caption; otherwise the auto-translation to that language. The
  // hook captures both (a translated request URL also carries kind=asr, plus
  // tlang), so we never re-judge "which is asr" — we just match this video, the
  // asr language, and the exact translation variant, then ASSERT the body is the
  // expected per-word json3. Returns the json, or null if not captured yet.
  function capturedJsonForVariant(track, tlang) {
    const vid = currentVideoId();
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
      const json = captionJsonFromText(text); // assert: per-word json3 + events
      if (!json) {
        log.warn('captured asr body is not valid json3 (unexpected):', url);
        continue;
      }
      return json;
    }
    return null;
  }

  function parseCaptionEvents(json) {
    const words = [];
    for (const ev of json.events || []) {
      if (!ev.segs) continue;
      const base = ev.tStartMs || 0;
      const blockEnd = base + (ev.dDurationMs || 0);
      for (const seg of ev.segs) {
        const text = seg.utf8;
        if (!text) continue;
        if (text === '\n') {
          // The caption data's OWN line break (a standalone \n segment). Mark the
          // last word as a line end so groupLines breaks where the source intends
          // (semantic), instead of us re-chunking arbitrarily.
          if (words.length) words[words.length - 1].breakAfter = true;
          continue;
        }
        // Real per-word offset only — never interpolated.
        const start = base + (seg.tOffsetMs || 0);
        words.push({ text, start, end: blockEnd, breakAfter: false });
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
    // If the captions carry their own \n line structure (almost always), break ONLY
    // there. Long lines wrap via CSS — no word-count cap (it chopped dense CJK lines
    // mid-phrase). The gap fallback is used only when there is no \n structure at all.
    const hasDataBreaks = words.some((w) => w.breakAfter);
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
      // Break where the caption DATA breaks — its own \n line structure (set on the
      // previous word during parse): the source's semantic lines.
      const dataBreak = !!prev?.breakAfter;
      // YouTube/CEA captions use ">>" to mark a change of speaker (">>>" for a
      // change of topic). Force a new line at it so speakers don't run together.
      const speakerBreak = /^\s*>>/.test(w.text);
      // Fallback for captions with NO \n structure: break on a speech pause so the
      // whole video isn't one line. Never used when \n breaks exist (it would chop
      // a semantic line mid-phrase).
      const gapBreak = !hasDataBreaks && prev && w.start - prev.end > LINE_BREAK_GAP_MS;

      if (current.words.length && (dataBreak || speakerBreak || gapBreak)) {
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
        pointer-events: none;
        font-family: "YouTube Noto", Roboto, Arial, sans-serif;
        line-height: 1.35;
        transition: opacity 0.15s ease;
      }
      #${ROOT_ID} .yk-lines {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        text-align: center;
      }
      #${ROOT_ID} .yk-resizer {
        position: absolute;
        right: -5px;
        top: 50%;
        transform: translateY(-50%);
        width: 8px;
        height: 46px;
        cursor: ew-resize;
        pointer-events: auto;
        opacity: 0;
        background: rgba(255, 229, 102, 0.9);
        border-radius: 4px;
        transition: opacity 0.15s ease;
      }
      .html5-video-player:hover #${ROOT_ID} .yk-resizer,
      #movie_player:hover #${ROOT_ID} .yk-resizer { opacity: 0.7; }
      #${ROOT_ID} .yk-resizer:hover { opacity: 1; }
      #${ROOT_ID} .yk-line {
        display: inline-block;
        width: var(--yk-box-width, auto);
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
      #${TRANSCRIPT_BTN_ID} {
        position: absolute;
        top: 44px;
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
      .html5-video-player:hover #${TRANSCRIPT_BTN_ID},
      #movie_player:hover #${TRANSCRIPT_BTN_ID} { opacity: 0.85; }
      #${TRANSCRIPT_BTN_ID}:hover { opacity: 1; }
      #${TRANSCRIPT_ID} {
        position: fixed;
        top: 56px;
        right: 0;
        bottom: 12px;
        width: 360px;
        max-width: 92vw;
        z-index: 2400;
        display: flex;
        flex-direction: column;
        background: rgba(255, 255, 255, 0.98);
        color: #0f0f0f;
        border-radius: 12px 0 0 12px;
        box-shadow: -4px 0 24px rgba(0, 0, 0, 0.28);
        font: 14px/1.5 "YouTube Noto", Roboto, Arial, sans-serif;
        transform: translateX(calc(100% + 4px));
        transition: transform 0.2s ease;
      }
      #${TRANSCRIPT_ID}[data-open="true"] { transform: translateX(0); }
      #${TRANSCRIPT_ID} .ykt-head {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        border-bottom: 1px solid #e5e5e5;
        font-weight: 700;
      }
      #${TRANSCRIPT_ID} .ykt-close {
        border: none;
        background: none;
        cursor: pointer;
        font-size: 20px;
        line-height: 1;
        color: #606060;
      }
      #${TRANSCRIPT_ID} .ykt-body {
        position: relative;
        flex: 1 1 auto;
        overflow-y: auto;
        padding: 6px 0;
        overscroll-behavior: contain;
      }
      #${TRANSCRIPT_ID} .ykt-line {
        padding: 6px 14px;
        cursor: pointer;
        color: #5a5a5a;
        border-left: 3px solid transparent;
      }
      #${TRANSCRIPT_ID} .ykt-line:hover { background: #f2f2f2; }
      #${TRANSCRIPT_ID} .ykt-line[data-active="true"] {
        background: #eef4ff;
        border-left-color: #065fd4;
        color: #0f0f0f;
      }
      #${TRANSCRIPT_ID} .ykt-w--past { color: #9a9a9a; }
      #${TRANSCRIPT_ID} .ykt-w--active { color: #b8860b; font-weight: 700; }
      /* In dual-track, translation rows sit indented + muted under the original. */
      #${TRANSCRIPT_ID} .ykt-line[data-variant] { padding-left: 30px; color: #707070; }
      #${TRANSCRIPT_ID} .ykt-line[data-variant][data-active="true"] { color: #0f0f0f; }
      /* Drag the left edge to resize the panel width. */
      #${TRANSCRIPT_ID} .ykt-resizer {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 8px;
        cursor: ew-resize;
        z-index: 1;
      }
      #${TRANSCRIPT_ID} .ykt-resizer:hover { background: rgba(6, 95, 212, 0.3); }
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
    // Lines render into .yk-lines so the resize grip (a sibling) survives the
    // per-bind replaceChildren in render().
    const linesBox = document.createElement('div');
    linesBox.className = 'yk-lines';
    root.appendChild(linesBox);
    const w = getOverlayWidth();
    if (w) root.style.setProperty('--yk-box-width', w);
    addOverlayResizer(root);
    player.appendChild(root);
    return root;
  }

  function getOverlayWidth() {
    try {
      return localStorage.getItem(OVERLAY_WIDTH_KEY) || '';
    } catch {
      return '';
    }
  }

  // Drag the right-edge grip to set the caption box width (controls wrapping); the
  // centered box grows symmetrically. Double-click to reset to fit content. Width
  // is a --yk-box-width CSS var on the overlay root, persisted.
  function addOverlayResizer(root) {
    const grip = document.createElement('div');
    grip.className = 'yk-resizer';
    let centerX = 0;
    let maxW = 0;
    const onMove = (e) => {
      const w = Math.min(maxW, Math.max(120, (e.clientX - centerX) * 2));
      root.style.setProperty('--yk-box-width', `${Math.round(w)}px`);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        localStorage.setItem(OVERLAY_WIDTH_KEY, root.style.getPropertyValue('--yk-box-width'));
      } catch {
        /* ignore */
      }
    };
    grip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pr = getPlayerEl().getBoundingClientRect();
      centerX = pr.left + pr.width / 2;
      maxW = pr.width * 0.92;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    grip.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      root.style.removeProperty('--yk-box-width');
      try {
        localStorage.removeItem(OVERLAY_WIDTH_KEY);
      } catch {
        /* ignore */
      }
    });
    root.appendChild(grip);
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

  // ---- Expandable side transcript panel (full caption text, karaoke-highlighted) ----
  function isTranscriptOpen() {
    try {
      return localStorage.getItem(TRANSCRIPT_OPEN_KEY) === 'true';
    } catch {
      return false;
    }
  }

  function setTranscriptOpen(on) {
    try {
      localStorage.setItem(TRANSCRIPT_OPEN_KEY, on ? 'true' : 'false');
    } catch {
      /* ignore */
    }
    const panel = document.getElementById(TRANSCRIPT_ID);
    if (panel) panel.dataset.open = String(on);
  }

  function ensureTranscriptToggle() {
    if (document.getElementById(TRANSCRIPT_BTN_ID)) return;
    const player = getPlayerEl();
    if (!player) return;
    const btn = document.createElement('button');
    btn.id = TRANSCRIPT_BTN_ID;
    btn.type = 'button';
    btn.textContent = '字幕全文';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      setTranscriptOpen(!isTranscriptOpen());
    });
    player.appendChild(btn);
  }

  function ensureTranscriptPanel() {
    let panel = document.getElementById(TRANSCRIPT_ID);
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = TRANSCRIPT_ID;
    panel.dataset.open = String(isTranscriptOpen());
    const head = document.createElement('div');
    head.className = 'ykt-head';
    const title = document.createElement('span');
    title.textContent = '字幕全文';
    const close = document.createElement('button');
    close.className = 'ykt-close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close transcript');
    close.addEventListener('click', () => setTranscriptOpen(false));
    head.appendChild(title);
    head.appendChild(close);
    const body = document.createElement('div');
    body.className = 'ykt-body';
    panel.appendChild(head);
    panel.appendChild(body);
    addTranscriptResizer(panel);
    document.body.appendChild(panel);
    // Restore the user's chosen width.
    try {
      const w = localStorage.getItem(TRANSCRIPT_WIDTH_KEY);
      if (w) panel.style.width = w;
    } catch {
      /* ignore */
    }
    return panel;
  }

  // Drag the left edge to resize the panel width (it is anchored to the right).
  function addTranscriptResizer(panel) {
    const grip = document.createElement('div');
    grip.className = 'ykt-resizer';
    let startX = 0;
    let startW = 0;
    const onMove = (e) => {
      const w = startW + (startX - e.clientX); // drag left => wider
      panel.style.width = `${Math.min(window.innerWidth * 0.92, Math.max(220, w))}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        localStorage.setItem(TRANSCRIPT_WIDTH_KEY, panel.style.width);
      } catch {
        /* ignore */
      }
    };
    grip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = panel.getBoundingClientRect().width;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    // Double-click the grip to fit the panel width to its widest line.
    grip.addEventListener('dblclick', (e) => {
      e.preventDefault();
      fitTranscriptWidth(panel);
    });
    panel.appendChild(grip);
  }

  // Auto-size the panel so its widest line does not wrap (clamped to the viewport).
  function fitTranscriptWidth(panel) {
    const body = panel.querySelector('.ykt-body');
    let max = 0;
    body.querySelectorAll('.ykt-line').forEach((row) => {
      row.style.whiteSpace = 'nowrap';
      max = Math.max(max, row.scrollWidth + (row.offsetWidth - row.clientWidth));
      row.style.whiteSpace = '';
    });
    // + horizontal padding/border of the body and a little slack for the scrollbar.
    const w = Math.min(window.innerWidth * 0.92, Math.max(220, max + 36));
    panel.style.width = `${w}px`;
    try {
      localStorage.setItem(TRANSCRIPT_WIDTH_KEY, panel.style.width);
    } catch {
      /* ignore */
    }
  }

  // (Re)build the panel body from all bound variants. Each variant's lines become
  // clickable rows; rows from both languages are interleaved by time (so the
  // translation sits next to its original in dual-track). Returns a per-variant
  // array of row entries aligned to that variant's lines.
  function buildTranscript(entries) {
    const panel = ensureTranscriptPanel();
    const body = panel.querySelector('.ykt-body');
    const ordered = []; // { row, start } for time-interleaved DOM order
    const byVariant = {};
    entries.forEach((e) => {
      byVariant[e.key] = e.lines.map((line) => {
        const row = document.createElement('div');
        row.className = 'ykt-line';
        if (e.key) row.dataset.variant = e.key; // translation rows (indented/muted)
        const wordEls = line.words.map((w) => {
          const span = document.createElement('span');
          span.className = 'ykt-w ykt-w--future';
          span.textContent = w.text;
          row.appendChild(span);
          return span;
        });
        row.addEventListener('click', () => {
          const v = state.video || getVideo();
          if (v) v.currentTime = line.start / 1000 + 0.01;
        });
        ordered.push({ row, start: line.start });
        return { row, wordEls, line };
      });
    });
    ordered.sort((a, b) => a.start - b.start);
    body.replaceChildren(...ordered.map((x) => x.row));
    return byVariant;
  }

  function hideTranscript() {
    const panel = document.getElementById(TRANSCRIPT_ID);
    if (panel) panel.dataset.open = 'false';
    state.transcriptActive = [];
  }

  // Keep the side transcript in sync with playback. `entries` is state.bind (1
  // variant, or 2 in dual-track). Each variant highlights its own active line +
  // word; the selected (last) variant's active line is what we auto-scroll to.
  function syncTranscript(t, entries) {
    if (!isTranscriptOpen() || !entries || !entries.length) {
      hideTranscript();
      return;
    }
    const panel = ensureTranscriptPanel();
    panel.dataset.open = 'true';
    const sig = entries.map((e) => `${e.key}:${e.lines.length}`).join('|');
    if (sig !== state.transcriptSig) {
      state.transcriptSig = sig;
      state.transcriptByVariant = buildTranscript(entries);
      state.transcriptActive = [];
    }
    const nowActive = [];
    let scrollRow = null;
    entries.forEach((e, ei) => {
      const rows = state.transcriptByVariant[e.key] || [];
      let idx = -1;
      for (let i = 0; i < e.lines.length; i++) {
        const next = e.lines[i + 1];
        if (t >= e.lines[i].start - 80 && (!next || t < next.start + 80)) {
          idx = i;
          break;
        }
      }
      const entry = idx >= 0 ? rows[idx] : null;
      if (entry) {
        nowActive.push(entry);
        if (ei === entries.length - 1) scrollRow = entry.row;
      }
    });
    const prev = state.transcriptActive || [];
    const changed = nowActive.length !== prev.length || nowActive.some((e, i) => e !== prev[i]);
    if (changed) {
      prev.forEach((e) => e.row.removeAttribute('data-active'));
      nowActive.forEach((e) => {
        e.row.dataset.active = 'true';
      });
      state.transcriptActive = nowActive;
      if (scrollRow) {
        const body = panel.querySelector('.ykt-body');
        const top = scrollRow.offsetTop - (body.clientHeight - scrollRow.offsetHeight) / 2;
        body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    }
    nowActive.forEach((e) => {
      e.line.words.forEach((w, j) => {
        const el = e.wordEls[j];
        if (!el) return;
        const cls = `ykt-w ykt-w--${wordState(w, t)}`;
        if (el.className !== cls) el.className = cls;
      });
    });
  }

  function findActiveLine(lines, t) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const next = lines[i + 1];
      if (t >= line.start - 80 && (!next || t < next.start + 80)) return line;
    }
    return null;
  }

  function wordState(w, t) {
    if (t < w.start - 30) return 'future';
    if (t >= w.start - 30 && t < w.end + 30) return 'active';
    return 'past';
  }

  // Render every bound variant as its own stacked line (1 normally, 2 for
  // dual-track). state.rendered holds the per-row line elements aligned to
  // state.bind; rebuild them whenever the row count changes.
  function render(t) {
    const root = ensureOverlay();
    const binds = state.bind;
    if (state.rendered.length !== binds.length) {
      state.rendered = binds.map(() => {
        const lineEl = document.createElement('div');
        lineEl.className = 'yk-line';
        return { lineEl, lineKey: '', wordEls: [] };
      });
      root.querySelector('.yk-lines').replaceChildren(...state.rendered.map((r) => r.lineEl));
    }
    let anyVisible = false;
    binds.forEach((b, i) => {
      const r = state.rendered[i];
      const line = findActiveLine(b.lines, t);
      if (!line) {
        if (r.lineKey !== '') {
          r.lineEl.replaceChildren();
          r.lineKey = '';
          r.wordEls = [];
        }
        r.lineEl.style.display = 'none';
        return;
      }
      anyVisible = true;
      r.lineEl.style.display = '';
      const lineKey = `${line.start}|${line.words.map((w) => w.text).join('')}`;
      if (lineKey !== r.lineKey) {
        r.lineKey = lineKey;
        r.wordEls = line.words.map((w) => {
          const span = document.createElement('span');
          span.className = 'yk-word yk-word--future';
          span.textContent = w.text;
          return span;
        });
        r.lineEl.replaceChildren(...r.wordEls);
      }
      line.words.forEach((w, j) => {
        const cls = wordState(w, t);
        const el = r.wordEls[j];
        if (!el) return;
        const next = `yk-word yk-word--${cls}`;
        if (el.className !== next) el.className = next;
      });
    });
    root.dataset.hidden = anyVisible ? 'false' : 'true';
  }

  // The asr caption variant the player CURRENTLY displays: { tlang } where tlang is
  // the auto-translation target ('' = original asr). Returns null when the player's
  // selected caption is NOT our asr track — a manual/translated-of-manual track, a
  // different asr language, or captions off — in which case the caller steps aside.
  // A translated auto-caption is still the asr track plus a `translationLanguage`.
  function currentAsrSelection() {
    const player = getPlayerEl();
    if (!player?.getOption) return null;
    let cur;
    try {
      cur = player.getOption('captions', 'track');
    } catch {
      return null;
    }
    if (cur?.kind !== 'asr') return null;
    if (state.trackLang && cur.languageCode && cur.languageCode !== state.trackLang) return null;
    return { tlang: cur.translationLanguage?.languageCode || '' };
  }

  // Reactively bind to the variant(s) the player currently displays. Normally that
  // is the single selected variant; with dual-track on AND a translation selected,
  // we also bind the original asr so both render. Re-parses only when the wanted
  // set or the line-length setting changes; a wanted-but-not-yet-captured variant
  // is added as soon as its body appears. Returns true when at least one variant is
  // bound; false when the selection is not our asr track or nothing is captured yet
  // (caller steps aside so the native caption shows — never a blank).
  function syncBinding() {
    const sel = currentAsrSelection();
    if (!sel) return false;
    const wantKeys = settings.dualTrack && sel.tlang ? ['', sel.tlang] : [sel.tlang];
    const sig = wantKeys.join('|');
    if (sig !== state.bindSig) {
      state.bindSig = sig;
      state.bind = [];
      state.rendered = [];
    }
    if (state.bind.length !== wantKeys.length) {
      const before = state.bind.length;
      const have = new Set(state.bind.map((b) => b.key));
      for (const key of wantKeys) {
        if (have.has(key)) continue;
        const json = capturedJsonForVariant(state.track, key);
        if (!json) continue;
        const lines = groupLines(parseCaptionEvents(json));
        if (!lines.length) continue;
        state.bind.push({ key, lines });
      }
      if (state.bind.length > before) {
        state.bind.sort((a, b) => wantKeys.indexOf(a.key) - wantKeys.indexOf(b.key));
        state.rendered = []; // order/count changed → rebuild rows
        log.info('Bound:', state.bind.map((b) => b.key || state.trackLang).join(' + '));
      }
    }
    return state.bind.length > 0;
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
      root.querySelector('.yk-lines')?.replaceChildren(); // keep .yk-lines + resize grip
    }
    state.bind = [];
    state.bindSig = null;
    state.rendered = [];
    hideTranscript();
  }

  function tick() {
    if (!state.active) return;
    const v = state.video || getVideo();
    if (!v) {
      state.raf = requestAnimationFrame(tick);
      return;
    }
    state.video = v;
    // Show karaoke only while the player's selected caption is our asr track (or a
    // translation of it) AND that variant's body is captured. Otherwise step aside
    // so the user's chosen native caption shows — never override it or leave blank.
    if (isAdShowing() || !syncBinding()) {
      stepAside();
    } else {
      engage();
      const ms = v.currentTime * 1000;
      render(ms);
      // The side transcript follows the binding: single variant normally, or both
      // (original + translation, interleaved by time) when dual-track is on.
      syncTranscript(ms, state.bind);
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
    getPlayerEl()?.classList.remove('yk-engaged'); // restore the native caption
    hideTranscript();
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
    ensureTranscriptToggle();
    state.videoId = currentVideoId();

    state.stage = 'player-response';
    const pr = await waitForPlayerResponse();
    if (!state.active) return;
    const tracklist = pr?.captions?.playerCaptionsTracklistRenderer;
    const tracks = tracklist?.captionTracks;

    state.stage = 'pick-track';
    const track = pickAutoCaptionTrack(tracks, tracklist);
    // No asr track on this video → nothing to bind to. Stay idle; not an error.
    if (!track) return;
    state.track = track;
    state.trackLang = track.languageCode || '';
    log.info('Binding to track:', track.name?.simpleText || state.trackLang, track.kind);

    state.stage = 'wait-video';
    state.video = await waitForVideo();
    if (!state.active) return;

    // From here the render loop reactively binds to whichever variant (original or
    // an auto-translation) the player currently displays — see tick()/syncBinding().
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
        bound: state.bind.length,
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
