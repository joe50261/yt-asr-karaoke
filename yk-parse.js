/**
 * yk-parse — pure json3 → words → lines. NO DOM, NO state. This logic is mirrored
 * by extension/test/fixtures/_analyze.py; keep it byte-for-byte identical in
 * behaviour or the fixtures stop aligning.
 */
(function () {
  'use strict';
  window.__YK__.register('parse', ['config'], (config) => {
    const { LINE_BREAK_GAP_MS, CJK_RE } = config;

    function captionJsonFromText(text) {
      if (!text || !text.trim()) return null;
      try {
        const json = JSON.parse(text);
        return json?.events?.length ? json : null;
      } catch {
        return null;
      }
    }

    function parseCaptionEvents(json) {
      const words = [];
      for (const ev of json.events || []) {
        if (!ev.segs) continue;
        const base = ev.tStartMs || 0;
        const blockEnd = base + (ev.dDurationMs || 0);
        for (const seg of ev.segs) {
          const text = seg.utf8;
          if (!text) continue;
          if (text === '\n') {
            // The caption data's OWN line break (a standalone \n segment). Mark the
            // last word as a line end so groupLines breaks here.
            if (words.length) words[words.length - 1].breakAfter = true;
            continue;
          }
          // A seg with no tOffsetMs starts at the event base (line-level timing);
          // no position is invented for it.
          const start = base + (seg.tOffsetMs || 0);
          words.push({ text, start, end: blockEnd, breakAfter: false });
        }
      }
      words.sort((a, b) => a.start - b.start);
      for (let i = 0; i < words.length - 1; i++) {
        const next = words[i + 1];
        if (words[i].end > next.start) words[i].end = next.start;
      }
      return words;
    }

    // json3 encodes inter-word spacing as a LEADING space inside each seg, but the
    // first seg of each event has none. When groupLines merges events, the first
    // word of an appended event would glue to the previous word. Restore a single
    // space at such boundaries (text only — never affects timing).
    function needsBoundarySpace(prevText, curText) {
      if (!prevText || !curText) return false;
      if (/\s$/.test(prevText) || /\n$/.test(prevText)) return false;
      if (/^\s/.test(curText) || /^\n/.test(curText)) return false;
      const prevLast = prevText[prevText.length - 1];
      const curFirst = curText[0];
      if (CJK_RE.test(prevLast) || CJK_RE.test(curFirst)) return false;
      return true;
    }

    function groupLines(words) {
      if (!words.length) return [];
      // Break rules: (1) the data's own \n marks; (2) a speaker change (">>");
      // (3) only when the track has no \n marks at all — a time gap between words
      // longer than LINE_BREAK_GAP_MS. No word-count cap; long lines wrap via CSS.
      const hasDataBreaks = words.some((w) => w.breakAfter);
      const lines = [];
      let current = { words: [], start: words[0].start, end: words[0].end };

      const flush = () => {
        if (!current.words.length) return;
        current.text = current.words.map((w) => w.text).join('');
        lines.push(current);
        current = { words: [], start: 0, end: 0 };
      };

      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const prev = current.words[current.words.length - 1];
        // Rule (1): breakAfter was set during parse on the word before a \n seg.
        const dataBreak = !!prev?.breakAfter;
        // Rule (2): YouTube/CEA captions mark a change of speaker with ">>"
        // (">>>" a change of topic).
        const speakerBreak = /^\s*>>/.test(w.text);
        // Rule (3): no \n structure anywhere → a gap > LINE_BREAK_GAP_MS breaks the
        // line (a pause inside a semantic \n line is not a boundary).
        const gapBreak = !hasDataBreaks && prev && w.start - prev.end > LINE_BREAK_GAP_MS;

        if (current.words.length && (dataBreak || speakerBreak || gapBreak)) {
          flush();
          current = { words: [], start: w.start, end: w.end };
        }

        // Insert a space at event seams (never for the line-leading word).
        const linePrev = current.words[current.words.length - 1];
        if (linePrev && needsBoundarySpace(linePrev.text, w.text)) {
          w.text = ` ${w.text}`;
        }

        current.words.push(w);
        current.end = Math.max(current.end || 0, w.end, w.start + 400);
        if (!current.start && current.start !== 0) current.start = w.start;
        if (w.start < current.start) current.start = w.start;
      }
      flush();
      return lines;
    }

    // json3 → lines 一步到位（模組職責「json3 → words → lines」的組合形；消費端一律走
    // 這裡，分步匯出留給等價對照與 mock）。
    function linesFromJson(json) {
      return groupLines(parseCaptionEvents(json));
    }

    return { captionJsonFromText, parseCaptionEvents, groupLines, linesFromJson, needsBoundarySpace };
  });
})();
