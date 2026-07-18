// UNIT (Jest) — yk-parse line breaking. The four break rules with real fixtures for the
// classic format and synthetic json3 for the degenerate formats YouTube has been seen
// serving (asr bodies with NO \n marks — the "one giant unbroken line" bug).
const fs = require('fs');
const path = require('path');
const { FIX, makeSandbox, load } = require('../_helpers');

function makeParse() {
  const s = makeSandbox();
  load(s, ['yk-di.js', 'yk-config.js', 'yk-parse.js']);
  return s.window.__YK__.resolve('parse');
}
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));

describe('yk-parse.groupLines — rule (1): the data\'s own \\n marks (classic asr format)', () => {
  test('real fixtures keep their baseline line counts (44 en / 41 zh-Hant)', () => {
    const parse = makeParse();
    expect(parse.linesFromJson(fixture('5ipNqGvS5Hw.en.asr.json3.json'))).toHaveLength(44);
    expect(parse.linesFromJson(fixture('5ipNqGvS5Hw.en-zh-Hant.asr.json3.json'))).toHaveLength(41);
  });

  test('with \\n structure present, event boundaries do NOT break (translated-line merges stay merged)', () => {
    const parse = makeParse();
    // Two word events with no \n between them, but a \n elsewhere in the track:
    // YouTube merging translated lines across events is deliberate — keep the merge.
    const lines = parse.linesFromJson({ events: [
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'first' }, { utf8: ' half', tOffsetMs: 400 }] },
      { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'second' }, { utf8: ' half', tOffsetMs: 400 }, { utf8: '\n', tOffsetMs: 800 }] },
      { tStartMs: 4000, dDurationMs: 2000, segs: [{ utf8: 'next' }] },
    ] });
    expect(lines.map((l) => l.text)).toEqual(['first half second half', 'next']);
  });

  test('embedded \\n ("word\\n" / "\\nword") breaks like a standalone \\n seg', () => {
    const parse = makeParse();
    const lines = parse.linesFromJson({ events: [
      { tStartMs: 0, dDurationMs: 3000, segs: [
        { utf8: 'hello' }, { utf8: ' world\n', tOffsetMs: 400 }, { utf8: 'again', tOffsetMs: 900 },
      ] },
    ] });
    expect(lines.map((l) => l.text)).toEqual(['hello world', 'again']);
  });
});

describe('yk-parse.groupLines — rule (3): tracks with NO \\n marks fall back to event boundaries', () => {
  test('the giant-line bug: stripping the \\n events from the real fixture still yields the SAME lines', () => {
    const parse = makeParse();
    const classic = parse.linesFromJson(fixture('5ipNqGvS5Hw.en.asr.json3.json'));
    const stripped = fixture('5ipNqGvS5Hw.en.asr.json3.json');
    stripped.events = stripped.events.filter((ev) => !(ev.segs && ev.segs.every((s) => s.utf8 === '\n')));
    const lines = parse.linesFromJson(stripped);
    // Before the event-boundary rule this collapsed into ONE 90-second line: word ends
    // are clamped to the next word's start, so the >700ms gap fallback never fires on
    // continuous speech.
    expect(lines.map((l) => `${l.start}|${l.text}`)).toEqual(classic.map((l) => `${l.start}|${l.text}`));
  });

  test('an aAppend event continues the line (live roll-up continuation is not a boundary)', () => {
    const parse = makeParse();
    const lines = parse.linesFromJson({ events: [
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'roll' }] },
      { tStartMs: 500, dDurationMs: 1500, aAppend: 1, segs: [{ utf8: ' up', tOffsetMs: 0 }] },
      { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'next' }] },
    ] });
    expect(lines.map((l) => l.text)).toEqual(['roll up', 'next']);
  });

  test('the >700ms gap fallback still breaks between sparse events', () => {
    const parse = makeParse();
    const lines = parse.linesFromJson({ events: [
      { tStartMs: 0, dDurationMs: 1000, aAppend: 1, segs: [{ utf8: 'one' }] },
      { tStartMs: 2000, dDurationMs: 1000, aAppend: 1, segs: [{ utf8: 'two' }] },
    ] });
    expect(lines.map((l) => l.text)).toEqual(['one', 'two']);
  });
});

describe('yk-parse — line-level roll-up asr (real captured body: cue-sized segs, embedded \\n, NO tOffsetMs)', () => {
  const fx = () => fixture('linelevel-rollup.asr.json3.json');

  test('every cue row becomes its own line, in order, with nothing lost', () => {
    const parse = makeParse();
    const lines = parse.linesFromJson(fx());
    expect(lines.slice(0, 6).map((l) => l.text)).toEqual([
      'My garden is completely overrun with',
      'brambles, and most people just throw',
      "them away. But, in this video, I'm going",
      'to see if I can turn this thorny',
      'nightmare into tea that actually taste',
      'good.',
    ]);
    // Full reconstruction: rows rejoined equal the cue text stream. Before the
    // boundary-\n gate, cross-cue merges produced misaligned double rows; before the
    // embedded-\n rule, the whole video was ONE line.
    const orig = fx().events.filter((e) => e.segs)
      .map((e) => e.segs.map((s) => s.utf8 || '').join('')).join('\n');
    expect(lines.map((l) => l.text).join('\n')).toBe(orig);
  });

  test('per-word karaoke units are interpolated over the cue SPEECH window (display windows overlap)', () => {
    const parse = makeParse();
    const lines = parse.linesFromJson(fx());
    expect(lines[0].words.length).toBeGreaterThan(1); // real units, not one blob per row
    // onsets stay ordered across the whole track — the global sort cannot scramble text
    const starts = lines.flatMap((l) => l.words.map((w) => w.start));
    expect(starts.some((s, i) => i && s < starts[i - 1])).toBe(false);
    // cue 1 displays over 0–7840ms but cue 2 SPEAKS from 4960 — interpolation must
    // stay inside the speech window or the sort would interleave neighbouring cues
    const cue1Last = lines[1].words[lines[1].words.length - 1];
    expect(cue1Last.end).toBeLessThanOrEqual(4960);
  });

  test('">>" speaker rows still open their own line (isSpeakerChange body parses)', () => {
    const parse = makeParse();
    const lines = parse.linesFromJson(fx());
    expect(lines.some((l) => l.text === '>> They had higher humidity, low oxygen,')).toBe(true);
  });

  test('a CJK line-level row interpolates per character', () => {
    const parse = makeParse();
    const lines = parse.linesFromJson({ events: [
      { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: '上周，Anthropic 去年底' }] },
      { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: '宣布' }] },
    ] });
    expect(lines.map((l) => l.text)).toEqual(['上周，Anthropic 去年底', '宣布']);
    const w = lines[0].words;
    expect(w.map((x) => x.text)).toEqual(['上', '周', '，', 'Anthropic', ' 去', '年', '底']);
    expect(w[0].start).toBe(0);
    expect(w[w.length - 1].end).toBe(2000); // clipped to the next cue's onset
  });

  test('word-level tracks are untouched: an offset-less multi-word event stays ONE seg-word', () => {
    const parse = makeParse();
    const lines = parse.linesFromJson({ events: [
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'multi word label' }] },
      { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'timed' }, { utf8: ' words', tOffsetMs: 400 }] },
    ] });
    // the TRACK carries offsets, so interpolation must not fire anywhere in it
    expect(lines[0].text).toBe('multi word label');
    expect(lines[0].words).toHaveLength(1);
  });
});

describe('yk-parse.groupLines — rule (4): LINE_MAX_SPAN_MS safety valve', () => {
  test('one giant event holding the whole video re-splits into ~LINE_SPLIT_TARGET_MS chunks', () => {
    const parse = makeParse();
    const segs = [];
    for (let i = 0; i < 300; i++) segs.push({ utf8: (i ? ' w' : 'w') + i, tOffsetMs: i * 300 });
    const lines = parse.linesFromJson({ events: [{ tStartMs: 0, dDurationMs: 90000, segs }] });
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      const span = l.words[l.words.length - 1].start - l.words[0].start;
      expect(span).toBeLessThanOrEqual(12000);
      expect(l.text).not.toMatch(/^ /); // the cut seam's boundary space is stripped
    }
    // No text lost or reordered across the re-split.
    expect(lines.map((l) => l.text).join(' ')).toBe(segs.map((s, i) => (i ? s.utf8.slice(1) : s.utf8)).join(' '));
    // Chunks stay contiguous and sorted for timing.lineWindow.
    for (let i = 1; i < lines.length; i++) expect(lines[i].start).toBeGreaterThan(lines[i - 1].start);
  });

  test('the cut lands on the largest NATIVE onset interval (a real pause), not a blind fixed grid', () => {
    const parse = makeParse();
    // Words every 300ms, but a 1500ms speech pause after w9 (rel 2700 → 4200, inside
    // the first chunk's 2–6s flex zone). The cut must land exactly on that pause.
    const segs = [];
    for (let i = 0; i < 10; i++) segs.push({ utf8: (i ? ' w' : 'w') + i, tOffsetMs: i * 300 });
    for (let i = 0; i < 40; i++) segs.push({ utf8: ' p' + i, tOffsetMs: 4200 + i * 300 });
    const lines = parse.linesFromJson({ events: [{ tStartMs: 0, dDurationMs: 20000, segs }] });
    expect(lines[0].text).toBe('w0 w1 w2 w3 w4 w5 w6 w7 w8 w9');
    expect(lines[1].start).toBe(4200); // the word right after the pause opens the next line
  });

  test('normal-length lines are untouched (no re-split below the threshold)', () => {
    const parse = makeParse();
    const lines = parse.linesFromJson(fixture('5ipNqGvS5Hw.en.asr.json3.json'));
    for (const l of lines) {
      const span = l.words[l.words.length - 1].start - l.words[0].start;
      expect(span).toBeLessThanOrEqual(12000);
    }
    expect(lines).toHaveLength(44); // rule 4 never fired on real data
  });
});
