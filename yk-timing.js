/**
 * yk-timing — pure time→line/word mapping, shared by the overlay and the side
 * transcript so they can never disagree about what is active. No state, no DOM.
 */
(function () {
  'use strict';
  window.__YK__.register('timing', ['config'], (config) => {
    const { LINE_LEAD_MS } = config;

    // 字組三態的容差（±ms）。wordState 的分類邊界與 wordStateBounds 的切點同一常數：
    // 分類與切點不同源的話，消費端（yk-native 逐界重繪）會在非翻面點切事件。
    const WORD_STATE_PAD_MS = 30;

    // 行活躍窗的唯一定義點：[start − LEAD, nextStart − LEAD)，contiguous、不重疊；
    // 末行無上界（end: null）。findActiveLineIndex 的點查詢與 yk-native 的 cue 切窗
    // 都由此推——overlay、側欄逐字稿、原生煮字幕三個表面對「哪一行活躍」不得分歧。
    function lineWindowStart(lines, i) {
      return lines[i].start - LINE_LEAD_MS;
    }
    function lineWindow(lines, i) {
      return {
        start: lineWindowStart(lines, i),
        end: i + 1 < lines.length ? lineWindowStart(lines, i + 1) : null,
      };
    }

    // The active line is the LAST line whose window start has been reached. Lines are
    // sorted by start, so this is unambiguous — no overlap, no first-vs-last tie.
    function findActiveLineIndex(lines, t) {
      let idx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (t >= lineWindowStart(lines, i)) idx = i;
        else break;
      }
      return idx;
    }

    function findActiveLine(lines, t) {
      const i = findActiveLineIndex(lines, t);
      return i >= 0 ? lines[i] : null;
    }

    function wordState(w, t) {
      if (t < w.start - WORD_STATE_PAD_MS) return 'future';
      if (t >= w.start - WORD_STATE_PAD_MS && t < w.end + WORD_STATE_PAD_MS) return 'active';
      return 'past';
    }

    // 字組狀態切點 [亮起, 熄滅)：兩切點之間 wordState 恆定（yk-native 憑此枚舉
    // repaint 邊界——切點集合＝wordState 的不連續點集合，由同一常數保證）。
    function wordStateBounds(w) {
      return [w.start - WORD_STATE_PAD_MS, w.end + WORD_STATE_PAD_MS];
    }

    return { findActiveLineIndex, findActiveLine, lineWindow, wordState, wordStateBounds };
  });
})();
