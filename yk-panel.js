/**
 * yk-panel — the in-page settings menu. The settings used to live in the toolbar popup,
 * which MCP/automation cannot drive (it is an unreachable chrome-extension:// window).
 * Moving the menu ONTO the player makes every control real DOM that MCP can click, and
 * keeps the popup out of the loop entirely. It is its OWN hot-swappable DI module (one
 * feature = one file), so iterating the menu is a single small inject.
 *
 * Pure view over the settings hub: it READS settings.current to reflect the controls and
 * WRITES exclusively through settings.apply(partial) — never chrome.storage (the MAIN
 * world can't), never settings.current directly. apply() makes the change live this frame
 * and persists it via bridge.js. The five keys stay ORTHOGONAL (each control writes only
 * its own key) — in particular autoDualLang (auto-DRIVE target) never touches dualTrack
 * (the dual DISPLAY): see yk-autodrive / engine.syncBinding. The one cross-control effect
 * is presentational only: nativeMode DISABLES the 字幕樣式 select (the overlay preset has
 * nothing to style when YouTube's own renderer draws the caption — README documents the
 * preset as overlay-only) — it never writes captionStyle.
 *
 * The Auto-translate menu is built from yt.translationLanguages() — YouTube's REAL runtime
 * list — read live each time the panel opens (no hardcoded language knowledge, and the menu
 * can never offer a code the player won't fetch). Before the player has loaded captions the
 * list is empty, so the menu is just 關閉 until then; reopening it once captions load fills it.
 *
 * Trusted Types: createElement/textContent/replaceChildren only — no innerHTML.
 */
(function () {
  'use strict';
  window.__YK__.register('panel', ['config', 'settings', 'yt'], (config, settings, yt) => {
    const { PANEL_ID, PANEL_BTN_ID } = config;

    // Stable control ids (MCP / tests target these). Namespaced so they can't collide
    // with YouTube's own page DOM.
    const STYLE_SEL = 'yk-set-style';
    const DUAL_CHK = 'yk-set-dual';
    const AUTOLANG_SEL = 'yk-set-autolang';
    const TRANSTOP_CHK = 'yk-set-transtop';
    const NATIVE_CHK = 'yk-set-native';

    const STYLE_OPTS = [
      ['default', '預設'],
      ['yt', 'YT'],
      ['advanced', '進階'],
    ];

    function isOpen() {
      const panel = document.getElementById(PANEL_ID);
      return !!panel && panel.dataset.open === 'true';
    }

    function setOpen(on) {
      const panel = ensurePanel();
      if (!panel) return;
      if (on) syncControls(); // reflect current settings + refresh the language list on open
      panel.dataset.open = String(on);
    }

    // A labelled row: <div.ykp-row><label>text<span.desc/></label> control </div>
    function makeRow(labelText, descText, control) {
      const row = document.createElement('div');
      row.className = 'ykp-row';
      const label = document.createElement('label');
      label.textContent = labelText;
      if (control.id) label.setAttribute('for', control.id);
      if (descText) {
        const desc = document.createElement('span');
        desc.className = 'ykp-desc';
        desc.textContent = descText;
        label.appendChild(desc);
      }
      row.appendChild(label);
      row.appendChild(control);
      return row;
    }

    function makeSelect(id) {
      const sel = document.createElement('select');
      sel.id = id;
      sel.className = 'ykp-select';
      return sel;
    }

    // A checkbox styled as a switch: <label.ykp-switch><input checkbox><span.slider/></label>.
    // The <input> carries the id so change handlers / tests / MCP target it directly.
    function makeSwitch(id) {
      const wrap = document.createElement('label');
      wrap.className = 'ykp-switch';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = id;
      const slider = document.createElement('span');
      slider.className = 'ykp-slider';
      wrap.appendChild(input);
      wrap.appendChild(slider);
      return { wrap, input };
    }

    function fillStyleOptions(sel) {
      const opts = STYLE_OPTS.map(([value, text]) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        return o;
      });
      sel.replaceChildren(...opts);
    }

    // Rebuild the Auto-translate menu from YouTube's live runtime list (關閉 + each
    // language). Re-selects `selected`; if it is no longer offered (or the list isn't
    // loaded yet) the <select> lands on the empty 關閉 option — a stale target is never
    // left silently selected, mirroring the old popup's renderLangs.
    function fillLangOptions(sel, selected) {
      const frag = [];
      const off = document.createElement('option');
      off.value = '';
      off.textContent = '關閉';
      frag.push(off);
      for (const l of yt.translationLanguages()) {
        if (!l || !l.code) continue;
        const o = document.createElement('option');
        o.value = l.code;
        o.textContent = l.name || l.code;
        frag.push(o);
      }
      sel.replaceChildren(...frag);
      sel.value = selected || '';
    }

    function ensurePanel() {
      let panel = document.getElementById(PANEL_ID);
      if (panel) return panel;
      const player = yt.getPlayerEl();
      if (!player) return null;

      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.dataset.open = 'false';

      const head = document.createElement('div');
      head.className = 'ykp-head';
      const title = document.createElement('span');
      title.textContent = '卡拉OK 設定';
      const close = document.createElement('button');
      close.className = 'ykp-close';
      close.type = 'button';
      close.textContent = '×';
      close.setAttribute('aria-label', 'Close settings');
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        setOpen(false);
      });
      head.appendChild(title);
      head.appendChild(close);

      const body = document.createElement('div');
      body.className = 'ykp-body';

      // Playback mode (the primary switch): native hands the cooked karaoke json3 to
      // YouTube's own caption renderer; off = our self-drawn overlay.
      const nativeSw = makeSwitch(NATIVE_CHK);
      nativeSw.input.addEventListener('change', () => {
        settings.apply({ nativeMode: nativeSw.input.checked });
        syncControls(); // reflect the cross-control effect (字幕樣式 disabled) immediately
      });
      body.appendChild(makeRow('原生播放', '交給 YouTube 內建字幕描繪逐字 highlight（非自繪覆蓋層）', nativeSw.wrap));

      // Caption style (overlay-only: native mode hands rendering to YouTube, so the
      // preset has nothing to apply — syncControls disables the select there)
      const styleSel = makeSelect(STYLE_SEL);
      fillStyleOptions(styleSel);
      styleSel.addEventListener('change', () => settings.apply({ captionStyle: styleSel.value }));
      body.appendChild(makeRow('字幕樣式', '預設 / YT / 進階（逐字填色）；原生播放時不適用', styleSel));

      // Bilingual (dual display)
      const dual = makeSwitch(DUAL_CHK);
      dual.input.addEventListener('change', () => settings.apply({ dualTrack: dual.input.checked }));
      body.appendChild(makeRow('雙語對照', '有譯文時，原文＋譯文兩列顯示', dual.wrap));

      // Auto-translate (auto-drive target)
      const langSel = makeSelect(AUTOLANG_SEL);
      langSel.addEventListener('change', () => settings.apply({ autoDualLang: langSel.value }));
      body.appendChild(makeRow('自動翻譯', '每支影片自動載入並選到此語言；關閉＝不自動', langSel));

      // Translation on top
      const top = makeSwitch(TRANSTOP_CHK);
      top.input.addEventListener('change', () => settings.apply({ translationOnTop: top.input.checked }));
      body.appendChild(makeRow('譯文在上', '雙語時把譯文排在原文上方', top.wrap));

      panel.appendChild(head);
      panel.appendChild(body);
      // Clicks inside the panel must not bubble to the player (seek/pause).
      panel.addEventListener('click', (e) => e.stopPropagation());
      player.appendChild(panel);
      return panel;
    }

    // Reflect settings.current onto every control + refresh the language list. Called on
    // each open so the menu shows the canonical state (the user only sees it while open).
    function syncControls() {
      const panel = document.getElementById(PANEL_ID);
      if (!panel) return;
      const nativeSw = panel.querySelector('#' + NATIVE_CHK);
      const styleSel = panel.querySelector('#' + STYLE_SEL);
      const dual = panel.querySelector('#' + DUAL_CHK);
      const langSel = panel.querySelector('#' + AUTOLANG_SEL);
      const top = panel.querySelector('#' + TRANSTOP_CHK);
      if (nativeSw) nativeSw.checked = !!settings.current.nativeMode;
      if (styleSel) {
        styleSel.value = settings.current.captionStyle || 'default';
        // overlay-only control: freeze (don't clear) it while native mode owns rendering,
        // so the stored preset survives a round-trip through native mode untouched
        styleSel.disabled = !!settings.current.nativeMode;
      }
      if (dual) dual.checked = !!settings.current.dualTrack;
      if (langSel) fillLangOptions(langSel, settings.current.autoDualLang || '');
      if (top) top.checked = !!settings.current.translationOnTop;
    }

    // Mount the ⚙ button on the player (idempotent). The engine calls this wherever it
    // ensures the Karaoke toggle, so the gear shares the toggle's lifetime / hover-reveal.
    function ensureButton() {
      if (document.getElementById(PANEL_BTN_ID)) return;
      const player = yt.getPlayerEl();
      if (!player) return;
      const btn = document.createElement('button');
      btn.id = PANEL_BTN_ID;
      btn.type = 'button';
      btn.textContent = '⚙';
      btn.setAttribute('aria-label', 'Karaoke settings');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        setOpen(!isOpen());
      });
      player.appendChild(btn);
    }

    function remove() {
      document.getElementById(PANEL_ID)?.remove();
      document.getElementById(PANEL_BTN_ID)?.remove();
    }

    return { ensureButton, ensurePanel, syncControls, setOpen, isOpen, remove, dispose: remove };
  });
})();
