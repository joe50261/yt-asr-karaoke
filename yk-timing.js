/**
 * yk-timing — pure time→line/word mapping, shared by the overlay and the side
 * transcript so they can never disagree about what is active. No state, no DOM.
 */
(function () {
  'use strict';
  window.__YK__.register('timing', ['config'], (config) => {
    const { LINE_LEAD_MS } = config;

    // The active line is the LAST line whose lead-in (start - LINE_LEAD_MS) has been
    // reached. Lines are sorted by start, so this is unambiguous: a line stays active
    // until exactly the next line's lead-in — no overlap, no first-vs-last tie.
    function findActiveLineIndex(lines, t) {
      let idx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (t >= lines[i].start - LINE_LEAD_MS) idx = i;
        else break;
      }
      return idx;
    }

    function findActiveLine(lines, t) {
      const i = findActiveLineIndex(lines, t);
      return i >= 0 ? lines[i] : null;
    }

    function wordState(w, t) {
      if (t < w.start - 30) return 'future';
      if (t >= w.start - 30 && t < w.end + 30) return 'active';
      return 'past';
    }

    return { findActiveLineIndex, findActiveLine, wordState };
  });
})();
