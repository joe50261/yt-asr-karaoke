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
