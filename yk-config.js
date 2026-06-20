/**
 * yk-config — every stable ID / storage key / timing constant / regex in one place.
 * Pure data, no deps. Other modules destructure what they need; this is the single
 * source of truth so the same string (e.g. ENGAGED_CLASS) can't drift between the
 * CSS that defines a rule and the engine that toggles it.
 */
(function () {
  'use strict';
  window.__YK__.register('config', [], () => ({
    STYLE_ID: 'yt-karaoke-style',
    ROOT_ID: 'yt-karaoke-root',
    TOGGLE_ID: 'yt-karaoke-toggle',
    TRANSCRIPT_ID: 'yt-karaoke-transcript',
    TRANSCRIPT_BTN_ID: 'yt-karaoke-transcript-btn',
    ENABLED_KEY: 'yt-karaoke-enabled',
    TRANSCRIPT_OPEN_KEY: 'yt-karaoke-transcript-open',
    TRANSCRIPT_WIDTH_KEY: 'yt-karaoke-transcript-width',
    OVERLAY_WIDTH_KEY: 'yt-karaoke-overlay-width',
    // Class toggled on the player while engaged; the CSS that hides the native
    // caption keys off it. Shared contract between yk-styles (defines) and
    // yk-engine (toggles) — keep it here so the two never disagree.
    ENGAGED_CLASS: 'yk-engaged',
    // Lines break only where the caption DATA breaks (its own \n line structure);
    // long lines wrap via CSS — there is NO word-count cap. This gap is a fallback
    // used ONLY for captions that carry no \n line structure at all.
    LINE_BREAK_GAP_MS: 700,
    // A line lights up this many ms before its first word — applied as one shared
    // lead-in so a line is active over [start - LEAD, nextStart - LEAD): contiguous,
    // never overlapping. (Overlapping windows made a click land on the previous line.)
    LINE_LEAD_MS: 80,
    // Chars that are NOT space-delimited (CJK / full-width). When either side of a
    // word boundary is one of these, no ASCII space should be inserted.
    CJK_RE: /[⺀-鿿　-〿가-힯＀-￯]/,
  }));
})();
