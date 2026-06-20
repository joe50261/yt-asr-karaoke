/**
 * yk-parse — pure json3 → words → lines. NO DOM, NO state. This logic is mirrored
 * by extension/test/fixtures/_analyze.py; keep it byte-for-byte identical in
 * behaviour or the fixtures stop aligning. Real per-word timing only — never
 * interpolated.
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
            // last word as a line end so groupLines breaks where the source intends
            // (semantic), instead of us re-chunking arbitrarily.
            if (words.length) words[words.length - 1].breakAfter = true;
            continue;
          }
          // Real per-word offset only — never interpolated.
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
      // If the captions carry their own \n line structure (almost always), break ONLY
      // there. Long lines wrap via CSS — no word-count cap (it chopped dense CJK lines
      // mid-phrase). The gap fallback is used only when there is no \n structure at all.
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
        // Break where the caption DATA breaks — its own \n line structure (set on the
        // previous word during parse): the source's semantic lines.
        const dataBreak = !!prev?.breakAfter;
        // YouTube/CEA captions use ">>" to mark a change of speaker (">>>" for a
        // change of topic). Force a new line at it so speakers don't run together.
        const speakerBreak = /^\s*>>/.test(w.text);
        // Fallback for captions with NO \n structure: break on a speech pause so the
        // whole video isn't one line. Never used when \n breaks exist (it would chop
        // a semantic line mid-phrase).
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

    return { captionJsonFromText, parseCaptionEvents, groupLines, needsBoundarySpace };
  });
})();
