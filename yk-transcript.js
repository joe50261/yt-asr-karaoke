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
  window.__YK__.register('transcript', ['config', 'timing', 'yt'], (config, timing, yt) => {
    const { TRANSCRIPT_ID, TRANSCRIPT_BTN_ID, TRANSCRIPT_OPEN_KEY, TRANSCRIPT_WIDTH_KEY } = config;

    let sig = null; // which variant(s) are built into the panel
    let byVariant = {}; // key -> [{ row, wordEls, line }] per line of that variant
    let active = []; // currently-highlighted row entries (1, or 2 in dual-track)

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
      if (document.getElementById(TRANSCRIPT_BTN_ID)) return;
      const player = yt.getPlayerEl();
      if (!player) return;
      const btn = document.createElement('button');
      btn.id = TRANSCRIPT_BTN_ID;
      btn.type = 'button';
      btn.textContent = '字幕全文';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        setOpen(!isOpen());
      });
      player.appendChild(btn);
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
    function addResizer(panel) {
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
        fitWidth(panel);
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
      const panel = ensurePanel();
      const body = panel.querySelector('.ykt-body');
      const ordered = []; // { row, start } for time-interleaved DOM order
      const map = {};
      entries.forEach((e) => {
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
          ordered.push({ row, start: line.start });
          return { row, wordEls, line };
        });
      });
      ordered.sort((a, b) => a.start - b.start);
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
      const nextSig = entries.map((e) => `${e.key}:${e.lines.length}`).join('|');
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
