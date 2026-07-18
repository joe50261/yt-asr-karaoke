/**
 * yk-parse — pure json3 → words → lines. NO DOM, NO state. This logic is mirrored
 * by extension/test/fixtures/_analyze.py; keep it byte-for-byte identical in
 * behaviour or the fixtures stop aligning.
 */
(function () {
  'use strict';
  window.__YK__.register('parse', ['config'], (config) => {
    const { LINE_BREAK_GAP_MS, LINE_MAX_SPAN_MS, LINE_SPLIT_TARGET_MS, CJK_RE } = config;

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
        let firstWordOfEvent = true;
        for (const seg of ev.segs) {
          const text = seg.utf8;
          if (!text) continue;
          // A seg with no tOffsetMs starts at the event base (line-level timing);
          // no position is invented for it.
          const start = base + (seg.tOffsetMs || 0);
          // A \n ANYWHERE in a seg is the caption data's OWN line break: the classic
          // format sends it as a standalone "\n" seg, but it also arrives embedded
          // ("word\n", "\nword"). Split on it; every seam marks the preceding word as
          // a line end so groupLines breaks there.
          const parts = text.split('\n');
          for (let p = 0; p < parts.length; p++) {
            if (p > 0 && words.length) words[words.length - 1].breakAfter = true;
            if (!parts[p]) continue;
            // A NON-append event is a fresh caption paint. Remember that boundary on
            // the previous word: it is groupLines' fallback line structure for tracks
            // that carry no \n marks at all (an aAppend event continues the line).
            if (firstWordOfEvent) {
              if (!ev.aAppend && words.length) words[words.length - 1].eventBreak = true;
              firstWordOfEvent = false;
            }
            words.push({ text: parts[p], start, end: blockEnd, breakAfter: false });
          }
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
      // (3) only when the track has no \n marks at all — the event boundaries marked
      // during parse (asr's line structure lives on its events when the \n marks are
      // missing), plus a time gap between words longer than LINE_BREAK_GAP_MS; (4) the
      // LINE_MAX_SPAN_MS safety valve below. No word-count cap; long lines wrap via CSS.
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
        // Rule (3): no \n structure anywhere → break at event boundaries and at a gap
        // > LINE_BREAK_GAP_MS. With \n structure present neither applies: events merge
        // unless the data says otherwise (a pause inside a semantic \n line is not a
        // boundary, and YouTube merging translated lines across events is deliberate).
        const eventBreak = !hasDataBreaks && !!prev?.eventBreak;
        const gapBreak = !hasDataBreaks && prev && w.start - prev.end > LINE_BREAK_GAP_MS;

        if (current.words.length && (dataBreak || speakerBreak || eventBreak || gapBreak)) {
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
      // Rule (4), safety valve: a "line" whose word onsets span more than
      // LINE_MAX_SPAN_MS means every structure above was missing (no \n marks, no
      // event boundaries, gapless timing — e.g. one giant event holding the whole
      // video). Re-split it at word boundaries into ~LINE_SPLIT_TARGET_MS chunks.
      // Real lines never get here (fixtures max ~2.6 s vs the 12 s threshold).
      return lines.flatMap(splitOversizedLine);
    }

    // Words (already carrying their boundary spaces) → a line with the same start/end
    // semantics as groupLines' accumulator.
    function lineFromWords(ws) {
      const line = { words: ws, start: ws[0].start, end: 0 };
      for (const w of ws) {
        line.end = Math.max(line.end, w.end, w.start + 400);
        if (w.start < line.start) line.start = w.start;
      }
      line.text = ws.map((w) => w.text).join('');
      return line;
    }

    function splitOversizedLine(line) {
      const ws = line.words;
      if (ws.length < 2 || ws[ws.length - 1].start - ws[0].start <= LINE_MAX_SPAN_MS) {
        return [line];
      }
      const out = [];
      let chunk = [];
      for (const w of ws) {
        if (chunk.length && w.start - chunk[0].start > LINE_SPLIT_TARGET_MS) {
          out.push(lineFromWords(chunk));
          chunk = [];
          // The seam we just cut owned this word's boundary space (json3 spacing is a
          // LEADING space) — a line-leading word carries none.
          w.text = w.text.replace(/^ /, '');
        }
        chunk.push(w);
      }
      if (chunk.length) out.push(lineFromWords(chunk));
      return out;
    }

    // json3 → lines 一步到位（模組職責「json3 → words → lines」的組合形；消費端一律走
    // 這裡，分步匯出留給等價對照與 mock）。
    function linesFromJson(json) {
      return groupLines(parseCaptionEvents(json));
    }

    return { captionJsonFromText, parseCaptionEvents, groupLines, linesFromJson, needsBoundarySpace };
  });
})();
