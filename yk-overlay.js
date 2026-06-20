/**
 * yk-overlay — the centered karaoke overlay over the player. Owns its own `rendered`
 * rows and the root DOM; the engine passes the bound variants in each frame.
 *
 * Trusted Types: DOM is built with createElement/textContent/replaceChildren only —
 * no innerHTML.
 *
 * Three clear levels (do NOT collapse into one — they mean different things):
 *  - invalidate(): rendered = [] only (a pure "please rebuild" flag). render()
 *    rebuilds when rendered.length !== binds.length, so the next frame re-aligns. The
 *    engine calls this when the bound set changes; it must NOT touch the DOM here, or
 *    a frame where every line is between active windows would flash hidden.
 *  - clear(): hide root + empty .yk-lines (keep the resize grip) + rendered = []. The
 *    engine calls this when stepping aside (ad / non-asr selection).
 *  - remove(): root.remove() + rendered = []. Teardown / hot-swap dispose.
 */
(function () {
  'use strict';
  window.__YK__.register('overlay', ['config', 'timing', 'settings', 'yt'], (config, timing, settings, yt) => {
    const { ROOT_ID, OVERLAY_WIDTH_KEY } = config;

    let rendered = []; // [{ lineEl, lineKey, wordEls }] aligned to binds, one row each

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
        const pr = yt.getPlayerEl().getBoundingClientRect();
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

    function ensure() {
      let root = document.getElementById(ROOT_ID);
      if (root) return root;
      const player = yt.getPlayerEl();
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

    // Render every bound variant as its own stacked line (1 normally, 2 for
    // dual-track). `rendered` holds the per-row line elements aligned to `binds`;
    // rebuild them whenever the row count changes (also the correctness backstop if
    // the engine forgot to invalidate after changing binds).
    function render(binds, t) {
      const root = ensure();
      const style = settings.current.captionStyle || 'default';
      if (root.dataset.style !== style) root.dataset.style = style;
      if (rendered.length !== binds.length) {
        rendered = binds.map(() => {
          const lineEl = document.createElement('div');
          lineEl.className = 'yk-line';
          return { lineEl, lineKey: '', wordEls: [] };
        });
        root.querySelector('.yk-lines').replaceChildren(...rendered.map((r) => r.lineEl));
      }
      let anyVisible = false;
      binds.forEach((b, i) => {
        const r = rendered[i];
        // Tag the row so style rules (e.g. advanced's subordinate translation) can
        // target the translation regardless of whether it's on top or bottom.
        const role = b.key ? 'translation' : 'original';
        if (r.lineEl.dataset.role !== role) r.lineEl.dataset.role = role;
        const line = timing.findActiveLine(b.lines, t);
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
          const cls = timing.wordState(w, t);
          const el = r.wordEls[j];
          if (!el) return;
          const next = `yk-word yk-word--${cls}`;
          if (el.className !== next) el.className = next;
          // Advanced style: fill the active word left-to-right over its spoken
          // duration (a true per-word sweep). --yk-fill is the gradient stop %.
          if (style === 'advanced' && cls === 'active') {
            const dur = Math.max(1, w.end - w.start);
            const pct = Math.max(0, Math.min(100, ((t - w.start) / dur) * 100));
            el.style.setProperty('--yk-fill', `${pct.toFixed(1)}%`);
          }
        });
      });
      root.dataset.hidden = anyVisible ? 'false' : 'true';
    }

    function invalidate() {
      rendered = [];
    }

    function clear() {
      const root = document.getElementById(ROOT_ID);
      if (root) {
        root.dataset.hidden = 'true';
        root.querySelector('.yk-lines')?.replaceChildren(); // keep .yk-lines + resize grip
      }
      rendered = [];
    }

    function remove() {
      document.getElementById(ROOT_ID)?.remove();
      rendered = [];
    }

    return { ensure, render, invalidate, clear, remove, dispose: remove };
  });
})();
