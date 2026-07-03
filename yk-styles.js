/**
 * yk-styles — injects the single <style> for the overlay + side transcript.
 * Trusted Types: this uses style.textContent (CSS text, not an HTML DOM sink), so it
 * is safe; no innerHTML anywhere. dispose() removes the <style> so a hot-swap of this
 * module re-injects fresh CSS (engine.init calls inject() again after a restart).
 */
(function () {
  'use strict';
  window.__YK__.register('styles', ['config'], (config) => {
    const {
      STYLE_ID, ROOT_ID, TOGGLE_ID, TRANSCRIPT_ID, TRANSCRIPT_BTN_ID, PANEL_ID, PANEL_BTN_ID,
      ENGAGED_CLASS, PLAYER_HOST_SELECTORS, KARAOKE_ACTIVE_RGB, CAPTION_STYLE_YT,
      CAPTION_STYLE_ADVANCED, OVERLAY_MAX_WIDTH_FRAC, TRANSCRIPT_MAX_WIDTH_FRAC,
    } = config;

    // 亮字金：config 的整數正典 → CSS 表示（yk-native 的 pen 用同一常數的整數形）。
    const GOLD_HEX = `#${KARAOKE_ACTIVE_RGB.toString(16).padStart(6, '0')}`;
    const goldA = (a) =>
      `rgba(${(KARAOKE_ACTIVE_RGB >> 16) & 0xff}, ${(KARAOKE_ACTIVE_RGB >> 8) & 0xff}, ${KARAOKE_ACTIVE_RGB & 0xff}, ${a})`;
    // hover-reveal 規則由 config 的宿主 selector 表生成（JS 掛鈕與 CSS 浮現同一張表：
    // 表加了新宿主，兩端一起生效）。
    const hoverReveal = (inner) => PLAYER_HOST_SELECTORS.map((s) => `${s}:hover ${inner}`).join(', ');
    // top-right 直欄槽位（Karaoke 開關 / ⚙ / 字幕全文[player host]）的唯一座標表；
    // ⚙ 卡也開在第三槽（z-67 > 66 蓋過字幕全文鈕——短暫遮擋可接受）。
    const PILL_TOP = { toggle: 12, panel: 44, transcript: 76 };

    function inject() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
      /* Hide the native caption ONLY while engaged (asr is the selected track and
         we are showing karaoke). When the user picks another track / turns captions
         off, we remove .${ENGAGED_CLASS} so the native caption shows normally. */
      .${ENGAGED_CLASS} .ytp-caption-window-container,
      .${ENGAGED_CLASS} .caption-window.ytp-caption-window-bottom {
        opacity: 0 !important;
        pointer-events: none !important;
      }
      #${ROOT_ID} {
        position: absolute;
        left: 50%;
        bottom: 8%;
        transform: translateX(-50%);
        z-index: 65;
        max-width: ${OVERLAY_MAX_WIDTH_FRAC * 100}%;
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
        background: ${goldA(0.9)};
        border-radius: 4px;
        transition: opacity 0.15s ease;
      }
      ${hoverReveal(`#${ROOT_ID} .yk-resizer`)} { opacity: 0.7; }
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
        color: ${GOLD_HEX};
        text-shadow: 0 0 12px ${goldA(0.55)}, 0 1px 2px rgba(0,0,0,0.9);
        transform: scale(1.04);
        display: inline-block;
      }

      /* ---- Caption style presets (settings menu: 預設 / YT / 進階). The rules above are
         the DEFAULT look; data-style on the overlay root switches it live. ---- */
      /* YT: match YouTube's native caption — weight 400, white, near-square, no
         glow/scale; the active word is a flat gold (no flourish). */
      #${ROOT_ID}[data-style="${CAPTION_STYLE_YT}"] .yk-line { background: rgba(8, 8, 8, 0.75); border-radius: 2px; }
      #${ROOT_ID}[data-style="${CAPTION_STYLE_YT}"] .yk-word { font-weight: 400; letter-spacing: normal; }
      #${ROOT_ID}[data-style="${CAPTION_STYLE_YT}"] .yk-word--future { color: #fff; }
      #${ROOT_ID}[data-style="${CAPTION_STYLE_YT}"] .yk-word--active {
        color: ${GOLD_HEX};
        text-shadow: none;
        transform: none;
        display: inline;
      }
      /* Advanced: the active word fills left-to-right over its spoken duration
         (--yk-fill, set per frame in render) with a progress underline; no scale
         (no layout jitter); lighter box + edge shadow; translation subordinate. */
      #${ROOT_ID}[data-style="${CAPTION_STYLE_ADVANCED}"] .yk-line { background: rgba(0, 0, 0, 0.5); border-radius: 8px; }
      #${ROOT_ID}[data-style="${CAPTION_STYLE_ADVANCED}"] .yk-word {
        font-weight: 500;
        letter-spacing: normal;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85);
      }
      #${ROOT_ID}[data-style="${CAPTION_STYLE_ADVANCED}"] .yk-word--future { color: rgba(255, 255, 255, 0.92); }
      #${ROOT_ID}[data-style="${CAPTION_STYLE_ADVANCED}"] .yk-word--past { color: rgba(255, 255, 255, 0.5); }
      #${ROOT_ID}[data-style="${CAPTION_STYLE_ADVANCED}"] .yk-word--active {
        color: transparent;
        -webkit-text-fill-color: transparent;
        background: linear-gradient(90deg, #f6c454 0 var(--yk-fill, 0%), rgba(255, 255, 255, 0.96) var(--yk-fill, 0%) 100%);
        -webkit-background-clip: text;
        background-clip: text;
        border-bottom: 2px solid #f6c454;
        transform: none;
        text-shadow: none;
        display: inline-block;
        line-height: 1.1;
      }
      #${ROOT_ID}[data-style="${CAPTION_STYLE_ADVANCED}"] .yk-lines .yk-line[data-role="translation"]:not(:only-child) { opacity: 0.92; }
      #${ROOT_ID}[data-style="${CAPTION_STYLE_ADVANCED}"] .yk-lines .yk-line[data-role="translation"]:not(:only-child) .yk-word { font-size: clamp(15px, 2vw, 22px); }
      #${ROOT_ID}[data-hidden="true"] { opacity: 0; }
      /* ---- player-chrome 藥丸鈕（Karaoke 開關 / ⚙ / 字幕全文）：外觀與 hover-reveal
         一份規則管三顆（掛載機制在 yk-ui.mountPillButton）；直欄座標見 PILL_TOP。 ---- */
      #${TOGGLE_ID}, #${PANEL_BTN_ID}, #${TRANSCRIPT_BTN_ID} {
        position: absolute;
        z-index: 66;
        border: none;
        border-radius: 4px;
        background: rgba(8, 8, 8, 0.72);
        color: #fff;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.15s ease;
      }
      ${hoverReveal(`#${TOGGLE_ID}`)},
      ${hoverReveal(`#${PANEL_BTN_ID}`)},
      ${hoverReveal(`#${TRANSCRIPT_BTN_ID}`)} { opacity: 0.85; }
      #${TOGGLE_ID}:hover, #${PANEL_BTN_ID}:hover, #${TRANSCRIPT_BTN_ID}:hover { opacity: 1; }
      #${TOGGLE_ID} {
        top: ${PILL_TOP.toggle}px;
        right: 12px;
        padding: 4px 10px;
        font: 600 12px/1.4 Roboto, Arial, sans-serif;
      }
      #${TOGGLE_ID}[data-on="false"] { color: rgba(255, 255, 255, 0.5); }
      /* The 字幕全文 toggle is a child of the overlay root (the caption box), so it
         is positioned RELATIVE to that box: just above its top-right corner, moving
         with the caption. pointer-events:auto re-enables clicks (the root disables
         them). It shares the root's opacity, so it fades with the caption. */
      #${TRANSCRIPT_BTN_ID} {
        bottom: calc(100% + 6px);
        right: 0;
        padding: 4px 10px;
        font: 600 12px/1.4 Roboto, Arial, sans-serif;
        white-space: nowrap;
        pointer-events: auto;
      }
      /* Native playback mode: there is no overlay caption box to anchor to (YouTube draws
         the caption), so the 字幕全文 button re-homes to the player chrome — the third
         PILL_TOP slot. Top-left is off limits: that corner is YouTube's own (fullscreen
         title/avatar in .ytp-chrome-top, the paid promotion label), hover-revealed at the
         same time as this pill would be. */
      #${TRANSCRIPT_BTN_ID}[data-host="player"] {
        bottom: auto;
        right: 12px;
        top: ${PILL_TOP.transcript}px;
      }
      /* ---- 亮/暗主題共用 token（YT 在 <html dark> 上即時切換）：逐字稿側欄與 ⚙ 卡
         同一組 bg/fg/muted/border/accent/shadow——兩面板必須同步跟主題，同組值只定義
         一次；各面板私有槽（--ykt-* / --ykp-* 剩餘者）留在自己的規則裡。 ---- */
      #${TRANSCRIPT_ID}, #${PANEL_ID} {
        --yk-bg: rgba(255, 255, 255, 0.98);
        --yk-fg: #0f0f0f;
        --yk-muted: #606060;
        --yk-border: #e5e5e5;
        --yk-accent: #065fd4;
        --yk-shadow: rgba(0, 0, 0, 0.28);
      }
      html[dark] #${TRANSCRIPT_ID}, html[dark] #${PANEL_ID} {
        --yk-bg: rgba(24, 24, 24, 0.98);
        --yk-fg: #f1f1f1;
        --yk-muted: #aaaaaa;
        --yk-border: #383838;
        --yk-accent: #3ea6ff;
        --yk-shadow: rgba(0, 0, 0, 0.6);
      }
      #${TRANSCRIPT_ID} {
        --ykt-line: #5a5a5a;
        --ykt-hover: #f2f2f2;
        --ykt-active-bg: #eef4ff;
        --ykt-grip-hover: rgba(6, 95, 212, 0.3);
        --ykt-past: #9a9a9a;
        --ykt-word-active: #b8860b;
        --ykt-variant: #9aa0a6;
        --ykt-variant-active: #3c4043;
        position: fixed;
        top: 56px;
        right: 0;
        bottom: 12px;
        width: 360px;
        max-width: ${TRANSCRIPT_MAX_WIDTH_FRAC * 100}vw;
        z-index: 2400;
        display: flex;
        flex-direction: column;
        background: var(--yk-bg);
        color: var(--yk-fg);
        border-radius: 12px 0 0 12px;
        box-shadow: -4px 0 24px var(--yk-shadow);
        font: 14px/1.5 "YouTube Noto", Roboto, Arial, sans-serif;
        transform: translateX(calc(100% + 4px));
        transition: transform 0.2s ease;
      }
      html[dark] #${TRANSCRIPT_ID} {
        --ykt-line: #aaaaaa;
        --ykt-hover: #272727;
        --ykt-active-bg: rgba(62, 166, 255, 0.16);
        --ykt-grip-hover: rgba(62, 166, 255, 0.35);
        --ykt-past: #6f6f6f;
        --ykt-word-active: #ffd54f;
        --ykt-variant: #808080;
        --ykt-variant-active: #c7c7c7;
      }
      #${TRANSCRIPT_ID}[data-open="true"] { transform: translateX(0); }
      #${TRANSCRIPT_ID} .ykt-head {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        border-bottom: 1px solid var(--yk-border);
        font-weight: 700;
      }
      #${TRANSCRIPT_ID} .ykt-close {
        border: none;
        background: none;
        cursor: pointer;
        font-size: 20px;
        line-height: 1;
        color: var(--yk-muted);
      }
      #${TRANSCRIPT_ID} .ykt-body {
        position: relative;
        flex: 1 1 auto;
        overflow-y: auto;
        padding: 6px 0;
        overscroll-behavior: contain;
      }
      #${TRANSCRIPT_ID} .ykt-line {
        display: flex;
        gap: 8px;
        align-items: baseline;
        padding: 6px 14px;
        cursor: pointer;
        color: var(--ykt-line);
        border-left: 3px solid transparent;
      }
      /* start~end timestamp column. tabular-nums keeps same-format rows aligned;
         it keeps its muted colour even when the line is active (stays subtle). */
      #${TRANSCRIPT_ID} .ykt-time {
        flex: 0 0 auto;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        color: var(--yk-muted);
        opacity: 0.75;
        white-space: nowrap;
        user-select: none;
      }
      #${TRANSCRIPT_ID} .ykt-text { flex: 1 1 auto; min-width: 0; }
      #${TRANSCRIPT_ID} .ykt-line:hover { background: var(--ykt-hover); }
      #${TRANSCRIPT_ID} .ykt-line[data-active="true"] {
        background: var(--ykt-active-bg);
        border-left-color: var(--yk-accent);
        color: var(--yk-fg);
      }
      #${TRANSCRIPT_ID} .ykt-w--past { color: var(--ykt-past); }
      #${TRANSCRIPT_ID} .ykt-w--active { color: var(--ykt-word-active); font-weight: 700; }
      /* In dual-track, translation rows are distinguished by COLOUR only (no indent):
         one shade lighter than the original. They are also GROUPED with their
         original — tight within the bilingual pair, loose between pairs — so the two
         read as one unit. Adjacency-scoped (':has(+…)' / '+'), so single-track (no
         [data-variant] rows) keeps its uniform 6px spacing untouched. */
      #${TRANSCRIPT_ID} .ykt-line[data-variant] {
        color: var(--ykt-variant);
        padding-top: 2px;
        padding-bottom: 2px;
      }
      #${TRANSCRIPT_ID} .ykt-line[data-variant][data-active="true"] { color: var(--ykt-variant-active); }
      #${TRANSCRIPT_ID} .ykt-line:has(+ .ykt-line[data-variant]) { padding-bottom: 2px; }
      #${TRANSCRIPT_ID} .ykt-line[data-variant] + .ykt-line { margin-top: 12px; }
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
      #${TRANSCRIPT_ID} .ykt-resizer:hover { background: var(--ykt-grip-hover); }

      /* ---- ⚙ Settings menu (yk-panel). Pill look/hover-reveal 來自上方合併規則；
         card 吃共用主題 token。Both are player children → absolute, so they live
         inside the player and show in fullscreen too. ---- */
      #${PANEL_BTN_ID} {
        top: ${PILL_TOP.panel}px;
        right: 12px;
        width: 28px;
        height: 24px;
        padding: 0;
        font: 600 14px/1 Roboto, Arial, sans-serif;
      }
      #${PANEL_ID} {
        --ykp-ctrl-border: #ccc;
        --ykp-off: #ccc;
        position: absolute;
        top: ${PILL_TOP.transcript}px;
        right: 12px;
        z-index: 67;
        width: 290px;
        max-width: 86%;
        display: none;
        flex-direction: column;
        background: var(--yk-bg);
        color: var(--yk-fg);
        border-radius: 10px;
        box-shadow: 0 6px 24px var(--yk-shadow);
        font: 13px/1.45 "YouTube Noto", Roboto, Arial, sans-serif;
        overflow: hidden;
      }
      #${PANEL_ID}[data-open="true"] { display: flex; }
      html[dark] #${PANEL_ID} {
        --ykp-ctrl-border: #555555;
        --ykp-off: #555555;
      }
      #${PANEL_ID} .ykp-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 9px 12px;
        border-bottom: 1px solid var(--yk-border);
        font-weight: 700;
      }
      #${PANEL_ID} .ykp-close {
        border: none;
        background: none;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
        color: var(--yk-muted);
      }
      #${PANEL_ID} .ykp-body { padding: 4px 12px 10px; }
      #${PANEL_ID} .ykp-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 0;
        border-top: 1px solid var(--yk-border);
      }
      #${PANEL_ID} .ykp-row:first-child { border-top: none; }
      #${PANEL_ID} .ykp-row label { font-weight: 600; flex: 1 1 auto; min-width: 0; }
      #${PANEL_ID} .ykp-desc {
        display: block;
        font-weight: 400;
        color: var(--yk-muted);
        font-size: 11px;
        margin-top: 2px;
      }
      #${PANEL_ID} .ykp-select {
        flex: 0 0 auto;
        padding: 5px 8px;
        border: 1px solid var(--ykp-ctrl-border);
        border-radius: 6px;
        font: inherit;
        background: var(--yk-bg);
        color: var(--yk-fg);
        cursor: pointer;
      }
      #${PANEL_ID} .ykp-switch { position: relative; width: 38px; height: 22px; flex: 0 0 auto; }
      #${PANEL_ID} .ykp-switch input { opacity: 0; width: 0; height: 0; }
      #${PANEL_ID} .ykp-slider {
        position: absolute;
        inset: 0;
        background: var(--ykp-off);
        border-radius: 22px;
        transition: 0.15s;
        cursor: pointer;
      }
      #${PANEL_ID} .ykp-slider::before {
        content: '';
        position: absolute;
        height: 16px;
        width: 16px;
        left: 3px;
        top: 3px;
        background: #fff;
        border-radius: 50%;
        transition: 0.15s;
      }
      #${PANEL_ID} .ykp-switch input:checked + .ykp-slider { background: var(--yk-accent); }
      #${PANEL_ID} .ykp-switch input:checked + .ykp-slider::before { transform: translateX(16px); }
    `;
      document.head.appendChild(style);
    }

    function dispose() {
      document.getElementById(STYLE_ID)?.remove();
    }

    return { inject, dispose };
  });
})();
