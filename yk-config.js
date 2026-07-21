/**
 * yk-config — every stable ID / storage key / timing constant / regex in one place.
 * Pure data, no deps. Other modules destructure what they need; this is the single
 * source of truth so the same string (e.g. ENGAGED_CLASS) can't drift between the
 * CSS that defines a rule and the engine that toggles it.
 */
(function () {
  'use strict';
  window.__YK__.register('config', [], () => ({
    // 運行 build 自報（日期.當日序號）：yk-main 開機第一行與 engine 每支影片的 init 行
    // 都會印出，console log 因此自帶「跑的是哪一版」的憑據——不再靠行號/訊息特徵反推。
    // 規則：每次推送（任何 yk-*.js 或 manifest 變動）都必須 bump，否則自報失去意義。
    BUILD: '2026-07-21.1',
    STYLE_ID: 'yt-karaoke-style',
    ROOT_ID: 'yt-karaoke-root',
    TOGGLE_ID: 'yt-karaoke-toggle',
    TRANSCRIPT_ID: 'yt-karaoke-transcript',
    TRANSCRIPT_BTN_ID: 'yt-karaoke-transcript-btn',
    PANEL_ID: 'yt-karaoke-panel',
    PANEL_BTN_ID: 'yt-karaoke-panel-btn',
    TRANSCRIPT_OPEN_KEY: 'yt-karaoke-transcript-open',
    TRANSCRIPT_WIDTH_KEY: 'yt-karaoke-transcript-width',
    OVERLAY_WIDTH_KEY: 'yt-karaoke-overlay-width',
    // YouTube 播放器宿主 selector（單一事實源）：yk-yt 依序取第一命中；yk-styles 用它
    // 生成 hover-reveal 規則。兩端不同源的話，YT 改版時 JS 掛得上按鈕、CSS 卻比對不到
    // 宿主，按鈕永遠 opacity:0。
    PLAYER_HOST_SELECTORS: ['#movie_player', '.html5-video-player'],
    // 卡拉OK 亮字金（整數 RGB 正典）：yk-native 直接作 json3 pen 的 fcForeColor（pen 只吃
    // 整數），yk-styles 轉成 #hex/rgba 插進 default 與 YT preset。past/future 不共享——
    // 它們是各表面的合成參數（覆蓋層疊自帶暗盒、原生 pen 疊 YT 字幕窗）。
    KARAOKE_ACTIVE_RGB: 0xffe566,
    // 字幕樣式 preset 契約：值即 overlay root 的 data-style。panel 選單、settings 預設、
    // yk-styles 的 [data-style] 選擇器、overlay 的進階分支共用；中文標籤留在 yk-panel。
    CAPTION_STYLE_DEFAULT: 'default',
    CAPTION_STYLE_YT: 'yt',
    CAPTION_STYLE_ADVANCED: 'advanced',
    // 寬度上限：CSS 的 max-width 與 JS 拖曳 clamp 是同一條線的兩個執法端，必須同源
    // （分家＝死拖曳區＋localStorage 存進渲染不出的寬度）。
    OVERLAY_MAX_WIDTH_FRAC: 0.92, // 佔播放器寬
    TRANSCRIPT_MAX_WIDTH_FRAC: 0.92, // 佔視窗寬
    // Class toggled on the player while engaged; the CSS that hides the native
    // caption keys off it. Shared contract between yk-styles (defines) and
    // yk-engine (toggles) — keep it here so the two never disagree.
    ENGAGED_CLASS: 'yk-engaged',
    // Lines break only where the caption DATA breaks (its own \n line structure);
    // long lines wrap via CSS — there is NO word-count cap. This gap is a fallback
    // used ONLY for captions that carry no \n line structure at all.
    LINE_BREAK_GAP_MS: 700,
    // Pathological-line safety valve (yk-parse rule 4). Some asr bodies arrive with NO
    // \n marks anywhere; word ends are clamped to the next word's start, so continuous
    // speech has no >700ms gaps either — without a backstop the whole video collapses
    // into ONE line. A grouped line whose word ONSETS span more than LINE_MAX_SPAN_MS
    // is degenerate (real asr lines run 2–7 s; fixtures max ~2.6 s) and gets re-split
    // at word boundaries into ~LINE_SPLIT_TARGET_MS chunks.
    LINE_MAX_SPAN_MS: 12000,
    LINE_SPLIT_TARGET_MS: 4000,
    // A line lights up this many ms before its first word — applied as one shared
    // lead-in so a line is active over [start - LEAD, nextStart - LEAD): contiguous,
    // never overlapping. (Overlapping windows made a click land on the previous line.)
    LINE_LEAD_MS: 80,
    // Chars that are NOT space-delimited (CJK / full-width). When either side of a
    // word boundary is one of these, no ASCII space should be inserted.
    CJK_RE: /[⺀-鿿　-〿가-힯＀-￯]/,
  }));
})();
