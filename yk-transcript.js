/**
 * yk-transcript — the expandable side panel showing the full caption transcript,
 * karaoke-highlighted and click-to-seek. Owns its own state (sig / byVariant /
 * active). Its toggle only flips open/closed (no engine callback), so it lives here
 * without depending on the engine.
 *
 * Trusted Types: createElement/textContent/replaceChildren only — no innerHTML.
 *
 * Clear levels:
 *  - hide(): close the panel + active = [] (does NOT clear sig/byVariant). The engine
 *    calls this when stepping aside; keeping the built rows is what lets re-engaging
 *    after an ad reuse them instantly (paired with capture's persistent __YK_CAP__).
 *  - reset(): close + clear sig/byVariant/active, but KEEP the panel DOM (so the
 *    user's dragged width survives). Teardown.
 *  - dispose(): remove the panel + toggle DOM entirely. Hot-swap of this module.
 */
(function () {
  'use strict';
  window.__YK__.register('transcript', ['config', 'settings', 'timing', 'yt', 'ui'], (config, settings, timing, yt, ui) => {
    const {
      ROOT_ID, TRANSCRIPT_ID, TRANSCRIPT_BTN_ID, TRANSCRIPT_OPEN_KEY, TRANSCRIPT_WIDTH_KEY,
      TRANSCRIPT_MAX_WIDTH_FRAC,
    } = config;

    let sig = null; // which variant(s) are built into the panel
    let byVariant = {}; // key -> [{ row, wordEls, line }] per line of that variant
    let active = []; // currently-highlighted row entries (1, or 2 in dual-track)

    // 行陣列 → 內容指紋，重建簽名的一部分。key＋行數不足以辨識「同一份內容」：行級
    // roll-up 軌的翻譯保留 cue 網格（每 cue 列數相同），行數與原文**恆相等**——bind 某
    // 槽的 body 換了語言（池一度被錯 body 汙染、之後自我修正）時，count-only 簽名看不出
    // 差異，面板永遠卡在舊內容，而 overlay 每幀直讀 bind 顯示的卻是新內容（「雙語字幕
    // 對、側欄原文錯」的整起事故）。指紋按 lines 陣列參照做 WeakMap 快取：sync 每 tick
    // 重算簽名，內容只在陣列首次出現時掃一遍，之後 O(1)；同內容的新陣列（廣告後重
    // parse）指紋相同，不會觸發無謂重建。
    const fingerprints = new WeakMap(); // lines[] -> hash string
    function linesFingerprint(lines) {
      let fp = fingerprints.get(lines);
      if (fp === undefined) {
        let h = 0;
        for (const line of lines) {
          h = (h * 31 + line.start) | 0;
          for (const w of line.words) {
            const s = w.text || '';
            for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
          }
        }
        fp = String(h >>> 0);
        fingerprints.set(lines, fp);
      }
      return fp;
    }

    // ms -> clock label (m:ss, or h:mm:ss past the hour). Display-only.
    function fmtTime(ms) {
      const total = Math.max(0, Math.round(ms / 1000));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      const mm = h ? String(m).padStart(2, '0') : String(m);
      return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
    }

    function isOpen() {
      try {
        return localStorage.getItem(TRANSCRIPT_OPEN_KEY) === 'true';
      } catch {
        return false;
      }
    }

    function setOpen(on) {
      try {
        localStorage.setItem(TRANSCRIPT_OPEN_KEY, on ? 'true' : 'false');
      } catch {
        /* ignore */
      }
      const panel = document.getElementById(TRANSCRIPT_ID);
      if (panel) panel.dataset.open = String(on);
    }

    function ensureToggle() {
      // Host depends on the mode. In OVERLAY mode the button rides ON the overlay caption box
      // (ROOT_ID) — like the resize grip, a root child with pointer-events:auto that survives
      // the per-frame replaceChildren — so it moves with the caption. In NATIVE mode there is
      // NO overlay box (YT draws the caption), so it lives on the PLAYER chrome instead.
      // data-host drives the positioning CSS variant. We re-parent on a mode switch (a plain
      // single-id guard can't tell the button is on the WRONG host).
      const native = !!settings.current.nativeMode;
      const host = native ? yt.getPlayerEl() : document.getElementById(ROOT_ID);
      if (!host) return;
      const btn = ui.mountPillButton({
        id: TRANSCRIPT_BTN_ID,
        host,
        text: '字幕全文',
        onClick: () => setOpen(!isOpen()),
      });
      if (btn) btn.dataset.host = native ? 'player' : 'box';
    }

    function ensurePanel() {
      let panel = document.getElementById(TRANSCRIPT_ID);
      if (panel) return panel;
      panel = document.createElement('div');
      panel.id = TRANSCRIPT_ID;
      panel.dataset.open = String(isOpen());
      const head = document.createElement('div');
      head.className = 'ykt-head';
      const title = document.createElement('span');
      title.textContent = '字幕全文';
      const close = document.createElement('button');
      close.className = 'ykt-close';
      close.type = 'button';
      close.textContent = '×';
      close.setAttribute('aria-label', 'Close transcript');
      close.addEventListener('click', () => setOpen(false));
      head.appendChild(title);
      head.appendChild(close);
      const body = document.createElement('div');
      body.className = 'ykt-body';
      panel.appendChild(head);
      panel.appendChild(body);
      addResizer(panel);
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
    // 拖曳生命週期在 yk-ui.attachDragResize；這裡只有本面板的幾何政策（右錨定、clamp）
    // 與持久化。Double-click fits the panel width to its widest line.
    function addResizer(panel) {
      const grip = document.createElement('div');
      grip.className = 'ykt-resizer';
      let startX = 0;
      let startW = 0;
      ui.attachDragResize(grip, {
        onStart(e) {
          startX = e.clientX;
          startW = panel.getBoundingClientRect().width;
        },
        onFrame(e) {
          const w = startW + (startX - e.clientX); // drag left => wider
          panel.style.width = `${Math.min(window.innerWidth * TRANSCRIPT_MAX_WIDTH_FRAC, Math.max(220, w))}px`;
        },
        onCommit() {
          try {
            localStorage.setItem(TRANSCRIPT_WIDTH_KEY, panel.style.width);
          } catch {
            /* ignore */
          }
        },
        onDblClick() {
          fitWidth(panel);
        },
      });
      panel.appendChild(grip);
    }

    // Auto-size the panel so its widest line does not wrap (clamped to the viewport).
    function fitWidth(panel) {
      const body = panel.querySelector('.ykt-body');
      let max = 0;
      body.querySelectorAll('.ykt-line').forEach((row) => {
        row.style.whiteSpace = 'nowrap';
        max = Math.max(max, row.scrollWidth + (row.offsetWidth - row.clientWidth));
        row.style.whiteSpace = '';
      });
      // + horizontal padding/border of the body and a little slack for the scrollbar.
      const w = Math.min(window.innerWidth * TRANSCRIPT_MAX_WIDTH_FRAC, Math.max(220, max + 36));
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
      const panel = ensurePanel();
      const body = panel.querySelector('.ykt-body');
      const ordered = []; // { row, anchor, rank, start } — interval-grouped DOM order
      const map = {};
      // Group rows by the TRANSLATION's intervals, not by raw start. The auto-translation
      // merges several original lines into one (M<N), so an original whose text was merged
      // away ("orphan") has its start land INSIDE a translation's span — sorting by start
      // alone drops it AFTER that translation (whose end overruns it), giving o,T,o instead
      // of o,o,T. Anchor every row to the translation interval its start falls into (largest
      // translation start ≤ row start), so each orphan sorts with its sentence's originals,
      // ahead of the translation. Translation spans OVERLAP (so a translation's own end is
      // unusable as a key) but translation STARTS are monotonic — safe interval boundaries.
      const tlEntry = entries.find((e) => e.key); // the translation variant (dual-track only)
      const tlStarts = tlEntry ? tlEntry.lines.map((l) => l.start) : []; // monotonic
      const groupAnchor = (start) => {
        let lo = 0, hi = tlStarts.length - 1, ans = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (tlStarts[mid] <= start) { ans = tlStarts[mid]; lo = mid + 1; } else hi = mid - 1;
        }
        return ans;
      };
      entries.forEach((e, rank) => {
        map[e.key] = e.lines.map((line) => {
          const row = document.createElement('div');
          row.className = 'ykt-line';
          if (e.key) row.dataset.variant = e.key; // translation rows (indented/muted)
          // start~end label, then the words in their own box so wrapped lines hang
          // under the text column (not under the timestamp).
          const time = document.createElement('span');
          time.className = 'ykt-time';
          time.textContent = `${fmtTime(line.start)}~${fmtTime(line.end)}`;
          const text = document.createElement('span');
          text.className = 'ykt-text';
          const wordEls = line.words.map((w) => {
            const span = document.createElement('span');
            span.className = 'ykt-w ykt-w--future';
            span.textContent = w.text;
            text.appendChild(span);
            return span;
          });
          row.appendChild(time);
          row.appendChild(text);
          row.addEventListener('click', () => {
            const v = yt.getVideo();
            if (v) v.currentTime = line.start / 1000 + 0.01;
          });
          ordered.push({ row, anchor: groupAnchor(line.start), rank, start: line.start });
          return { row, wordEls, line };
        });
      });
      // anchor = translation interval; rank = entry order (original above translation, or
      // reversed under translationOnTop); start = order within a group.
      ordered.sort((a, b) => a.anchor - b.anchor || a.rank - b.rank || a.start - b.start);
      body.replaceChildren(...ordered.map((x) => x.row));
      return map;
    }

    function hide() {
      const panel = document.getElementById(TRANSCRIPT_ID);
      if (panel) panel.dataset.open = 'false';
      active = [];
    }

    function reset() {
      hide();
      sig = null;
      byVariant = {};
      active = [];
    }

    function dispose() {
      document.getElementById(TRANSCRIPT_ID)?.remove();
      document.getElementById(TRANSCRIPT_BTN_ID)?.remove();
      sig = null;
      byVariant = {};
      active = [];
    }

    // Keep the side transcript in sync with playback. `entries` is the bind set (1
    // variant, or 2 in dual-track). Each variant highlights its own active line +
    // word; the selected (last) variant's active line is what we auto-scroll to.
    function sync(t, entries) {
      if (!isOpen() || !entries || !entries.length) {
        hide();
        return;
      }
      const panel = ensurePanel();
      panel.dataset.open = 'true';
      const nextSig = entries.map((e) => `${e.key}:${e.lines.length}:${linesFingerprint(e.lines)}`).join('|');
      if (nextSig !== sig) {
        sig = nextSig;
        byVariant = buildTranscript(entries);
        active = [];
      }
      const nowActive = [];
      let scrollRow = null;
      entries.forEach((e, ei) => {
        const rows = byVariant[e.key] || [];
        const idx = timing.findActiveLineIndex(e.lines, t);
        const entry = idx >= 0 ? rows[idx] : null;
        if (entry) {
          nowActive.push(entry);
          if (ei === entries.length - 1) scrollRow = entry.row;
        }
      });
      const prev = active || [];
      const changed = nowActive.length !== prev.length || nowActive.some((e, i) => e !== prev[i]);
      if (changed) {
        // Rows LEAVING the active set: drop the row highlight AND reset their word
        // spans back to plain, else the last lit word stays gold on the line we left.
        prev.forEach((e) => {
          if (nowActive.includes(e)) return;
          e.row.removeAttribute('data-active');
          e.wordEls.forEach((el) => {
            if (el.className !== 'ykt-w ykt-w--future') el.className = 'ykt-w ykt-w--future';
          });
        });
        nowActive.forEach((e) => {
          e.row.dataset.active = 'true';
        });
        active = nowActive;
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
          const cls = `ykt-w ykt-w--${timing.wordState(w, t)}`;
          if (el.className !== cls) el.className = cls;
        });
      });
    }

    return { ensurePanel, ensureToggle, sync, hide, reset, dispose };
  });
})();
