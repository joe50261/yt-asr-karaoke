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

    // Karaoke units of one line-level row: latin words carrying their LEADING space
    // (json3's own inter-word spacing convention), CJK characters one by one.
    function splitRowIntoUnits(text) {
      const units = [];
      let pend = ''; // whitespace waiting to lead the next unit
      let cur = '';
      const flush = () => {
        if (cur) units.push(cur);
        cur = '';
      };
      for (const ch of text) {
        if (ch === ' ') {
          flush();
          pend += ' ';
        } else if (CJK_RE.test(ch)) {
          flush();
          units.push(pend + ch);
          pend = '';
        } else {
          if (!cur) {
            cur = pend;
            pend = '';
          }
          cur += ch;
        }
      }
      flush();
      return units;
    }

    function parseCaptionEvents(json) {
      const events = (json.events || []).filter((ev) => ev.segs);
      // Track shape: word-level tracks time their words (tOffsetMs somewhere); a track
      // with NO offsets anywhere is LINE-level — cue-sized segs, "row1\nrow2", the
      // roll-up asr format. The distinction is per TRACK, not per event: word-level
      // tracks also hold offset-less single-word events ('lucasfilm') that must not
      // be touched.
      const wordLevel = events.some((ev) => ev.segs.some((s) => s.tOffsetMs != null));
      const producesWords = (ev) =>
        ev.segs.some((s) => s.utf8 && s.utf8.split('\n').some((p) => p));
      const words = [];
      for (let e = 0; e < events.length; e++) {
        const ev = events[e];
        const base = ev.tStartMs || 0;
        const blockEnd = base + (ev.dDurationMs || 0);
        let firstWordOfEvent = true;
        // A NON-append event is a fresh caption paint. Remember that boundary on the
        // previous word: it is groupLines' fallback line structure for tracks whose
        // \n marks don't encode it (an aAppend event continues the line instead).
        const push = (text, start, end) => {
          if (firstWordOfEvent) {
            if (!ev.aAppend && words.length) words[words.length - 1].eventBreak = true;
            firstWordOfEvent = false;
          }
          words.push({ text, start, end, breakAfter: false });
        };

        // LINE-level cue with several units: the data has no per-word timing at all,
        // so interpolate word onsets by character weight over the cue's SPEECH window
        // [base, next word-bearing event's base) — the cue's own dDurationMs is a
        // DISPLAY window that overlaps the next cue (two roll-up rows stay on screen),
        // and interpolating over it would interleave neighbouring cues in the sort.
        const rows = wordLevel ? null : ev.segs.map((s) => s.utf8 || '').join('').split('\n');
        const units = rows ? rows.map(splitRowIntoUnits) : null;
        const unitCount = units ? units.reduce((n, r) => n + r.length, 0) : 0;
        if (unitCount > 1) {
          let speechEnd = blockEnd;
          for (let k = e + 1; k < events.length; k++) {
            if (producesWords(events[k])) {
              const nb = events[k].tStartMs || 0;
              if (nb > base && nb < speechEnd) speechEnd = nb;
              break;
            }
          }
          const weight = (u) => u.trim().length || 1;
          const total = units.reduce((n, r) => n + r.reduce((m, u) => m + weight(u), 0), 0);
          const span = Math.max(0, speechEnd - base);
          let acc = 0;
          for (let r = 0; r < units.length; r++) {
            for (const u of units[r]) {
              const t0 = base + Math.round((span * acc) / total);
              acc += weight(u);
              const t1 = base + Math.round((span * acc) / total);
              push(u, t0, t1);
            }
            // the row seam is the cue's own \n — a data line mark, same as below
            if (r < units.length - 1 && words.length) words[words.length - 1].breakAfter = true;
          }
          continue;
        }

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
            push(parts[p], start, blockEnd);
          }
        }
      }
      // A LINE-level track never encodes boundaries with \n — its \n are row seams.
      // But a cue with a trailing/leading \n ("row\n") lands breakAfter on an
      // event-LAST word, where the next event's eventBreak stamp collides with it and
      // flips the track-wide hasBoundaryNl gate (one stray character would silently
      // turn off event/gap breaking for the whole track). Keep the two signals
      // disjoint: on boundary words the event break IS the break.
      if (!wordLevel) {
        for (const w of words) if (w.eventBreak) w.breakAfter = false;
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
      // (3) when the \n marks don't encode the EVENT BOUNDARIES — break at the
      // boundaries marked during parse plus at gaps longer than LINE_BREAK_GAP_MS;
      // (4) the LINE_MAX_SPAN_MS safety valve below. No word-count cap; long lines
      // wrap via CSS.
      //
      // The boundary test: the classic format writes its \n marks AT event boundaries
      // (standalone \n segs between word events — breakAfter and eventBreak land on
      // the same word), so a boundary WITHOUT \n is a deliberate merge (YouTube
      // merging translated lines across events). The line-level cue format puts \n
      // only INSIDE events ("row1\nrow2") — boundaries carry no encoding there, so a
      // new event still opens a new line.
      const hasBoundaryNl = words.some((w) => w.breakAfter && w.eventBreak);
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
        // Rule (3): \n marks don't encode the boundaries → break at event boundaries
        // and at a gap > LINE_BREAK_GAP_MS. With boundary-encoded \n structure neither
        // applies: events merge unless the data says otherwise (a pause inside a
        // semantic \n line is not a boundary, and a boundary without \n is deliberate).
        const eventBreak = !hasBoundaryNl && !!prev?.eventBreak;
        const gapBreak = !hasBoundaryNl && prev && w.start - prev.end > LINE_BREAK_GAP_MS;

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
      // Cut where the speech actually pauses, not at a blind fixed interval: within a
      // flex zone around the target span ([TARGET/2, TARGET*1.5]) pick the word
      // boundary with the LARGEST native inter-onset interval — onsets are the only
      // real per-word timing the data carries (per-word ends are invented, clamped to
      // the next onset), so start[i] − start[i−1] is the pause signal. Ties resolve
      // toward the target span. A zone with no onsets at all means one giant jump —
      // the jump itself is the pause, cut right before it.
      const lo = LINE_SPLIT_TARGET_MS / 2;
      const hi = LINE_SPLIT_TARGET_MS * 1.5;
      const out = [];
      let b = 0;
      while (ws[ws.length - 1].start - ws[b].start > hi) {
        let cut = -1;
        let best = -1;
        let bestRel = 0;
        for (let i = b + 1; i < ws.length; i++) {
          const rel = ws[i].start - ws[b].start;
          if (rel > hi) {
            if (cut < 0) cut = i; // empty zone: the words jump clean over it
            break;
          }
          if (rel >= lo) {
            const gap = ws[i].start - ws[i - 1].start;
            if (
              gap > best ||
              (gap === best &&
                Math.abs(rel - LINE_SPLIT_TARGET_MS) < Math.abs(bestRel - LINE_SPLIT_TARGET_MS))
            ) {
              best = gap;
              bestRel = rel;
              cut = i;
            }
          }
        }
        out.push(lineFromWords(ws.slice(b, cut)));
        // The seam we just cut owned this word's boundary space (json3 spacing is a
        // LEADING space) — a line-leading word carries none.
        ws[cut].text = ws[cut].text.replace(/^ /, '');
        b = cut;
      }
      out.push(lineFromWords(ws.slice(b)));
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
