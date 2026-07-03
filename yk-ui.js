/**
 * yk-ui — player-chrome 共用 UI 機制（無狀態 DOM helper）：
 *
 *  - mountPillButton: 藥丸鈕掛載生命週期的唯一實作（id 守門、宿主變更即搬移——
 *    appendChild 對已在樹上的節點就是搬移、click 吞事件——player 上的按鈕不吞
 *    會觸發 seek/pause）。Karaoke 開關、⚙、字幕全文三顆共用；外觀與直欄座標在
 *    yk-styles 的合併規則。
 *
 *  - attachDragResize: 拖曳調寬生命週期的唯一實作。pointer capture：拖出視窗放開
 *    也收得到 pointerup，listener 不會掛死繼續調寬。幾何/clamp/持久化屬各面板政策，
 *    由呼叫端 callback 提供（overlay 中心對稱、transcript 右錨定）。
 */
(function () {
  'use strict';
  window.__YK__.register('ui', [], () => {
    function mountPillButton({ id, host, text, ariaLabel, onClick }) {
      let btn = document.getElementById(id);
      if (btn) {
        if (host && btn.parentElement !== host) host.appendChild(btn);
        return btn;
      }
      if (!host) return null;
      btn = document.createElement('button');
      btn.id = id;
      btn.type = 'button';
      if (text) btn.textContent = text;
      if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick(e, btn);
      });
      host.appendChild(btn);
      return btn;
    }

    // opts: { onStart?(e), onFrame(e), onCommit?(), onDblClick?(e), stopPropagation? }
    // stopPropagation 供掛在 player 上的 grip 用（不擋會冒泡成 seek/pause）。
    function attachDragResize(grip, opts) {
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (opts.stopPropagation) e.stopPropagation();
        if (opts.onStart) opts.onStart(e);
        try {
          grip.setPointerCapture(e.pointerId);
        } catch {
          /* 環境無 pointer capture（測試 DOM）：退回一般 listener，仍可拖 */
        }
        const onMove = (ev) => opts.onFrame(ev);
        const onUp = () => {
          grip.removeEventListener('pointermove', onMove);
          grip.removeEventListener('pointerup', onUp);
          grip.removeEventListener('pointercancel', onUp);
          if (opts.onCommit) opts.onCommit();
        };
        grip.addEventListener('pointermove', onMove);
        grip.addEventListener('pointerup', onUp);
        grip.addEventListener('pointercancel', onUp);
      });
      if (opts.onDblClick) {
        grip.addEventListener('dblclick', (e) => {
          e.preventDefault();
          if (opts.stopPropagation) e.stopPropagation();
          opts.onDblClick(e);
        });
      }
    }

    return { mountPillButton, attachDragResize };
  });
})();
