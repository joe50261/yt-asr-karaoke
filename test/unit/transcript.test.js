// UNIT (Jest) — yk-transcript 的重建簽名必須是內容感知的。
// 實際案例（「完整字幕並排原文語言錯誤、雙語字幕卻正確」）：行級 roll-up 軌的翻譯
// 保留 cue 網格（每 cue 列數相同），行數與原文**恆相等**；bind 的 '' 槽一度綁到錯
// 語言的 body、之後自我修正時，count-only 簽名（key:行數）看不出差異——面板永遠
// 卡在舊語言，而 overlay 每幀直讀 bind、顯示的是新內容，兩個表面從此分家。
const { makeSandbox, makeDom, load } = require('../_helpers');

// 與 parse 產出的行同形：text ＋ words[{text,start,end}]（transcript 只吃這些欄位）。
function mkLine(start, end, texts) {
  return {
    start,
    end,
    text: texts.join(''),
    words: texts.map((t, i) => ({ text: t, start: start + i * 10, end: start + i * 10 + 10 })),
  };
}

describe('yk-transcript — 重建簽名內容感知（key/行數相同、內容不同 → 必須重建）', () => {
  function setup() {
    const s = makeSandbox();
    const dom = makeDom();
    s.document = dom.document;
    load(s, ['yk-di.js', 'yk-config.js', 'yk-timing.js']);
    const di = s.window.__YK__;
    di.register('settings', [], () => ({ current: { nativeMode: false } }));
    di.register('yt', [], () => ({ getPlayerEl: () => null, getVideo: () => null }));
    di.register('ui', [], () => ({ mountPillButton: () => null, attachDragResize: () => {} }));
    load(s, ['yk-transcript.js']);
    const config = di.resolve('config');
    s.localStorage.setItem(config.TRANSCRIPT_OPEN_KEY, 'true'); // 面板開著才會 build/sync
    const transcript = di.resolve('transcript');
    const bodyEl = () => s.document.getElementById(config.TRANSCRIPT_ID).querySelector('.ykt-body');
    // 每列的字組文字（row.children = [time span, text span]；text span 下是字 span）
    const rows = () => bodyEl().children.map((row) => row.children[1].children.map((w) => w.textContent).join(''));
    return { transcript, bodyEl, rows };
  }

  // 行數刻意相等（roll-up 譯文與原文行數恆相等的結構性碰撞），只有文字不同。
  const ZH = [mkLine(0, 1000, ['你', '好']), mkLine(2000, 3000, ['世', '界'])];
  const EN = [mkLine(0, 1000, ['hello ', 'there']), mkLine(2000, 3000, ['world', '!'])];
  const TL = [mkLine(100, 1100, ['翻', '譯']), mkLine(2100, 3100, ['譯', '文'])];

  test('bind 槽的內容換了（key 與行數都沒變）→ 面板重建，不卡在舊語言', () => {
    const { transcript, rows } = setup();
    transcript.sync(0, [{ key: '', lines: ZH }, { key: 'zh-Hant', lines: TL }]);
    expect(rows().join('|')).toContain('你好');
    // '' 槽自我修正成原文（行數相同）——舊碼的 count-only 簽名在此不重建，面板永遠顯示你好
    transcript.sync(0, [{ key: '', lines: EN }, { key: 'zh-Hant', lines: TL }]);
    const after = rows().join('|');
    expect(after).toContain('hello there');
    expect(after).not.toContain('你好');
  });

  test('內容沒變 → 不重建（列節點同一物件；同內容的新陣列亦然——廣告後重 parse 不得抖動）', () => {
    const { transcript, bodyEl } = setup();
    const entries = [{ key: '', lines: EN }, { key: 'zh-Hant', lines: TL }];
    transcript.sync(0, entries);
    const firstRow = bodyEl().children[0];
    transcript.sync(50, entries); // 同一份 bind：穩態逐 tick 呼叫
    expect(bodyEl().children[0]).toBe(firstRow);
    // 廣告後 re-bind：內容相同、陣列是新的（重 parse）——指紋相同，不觸發無謂重建
    const reparsed = [
      { key: '', lines: EN.map((l) => mkLine(l.start, l.end, l.words.map((w) => w.text))) },
      { key: 'zh-Hant', lines: TL.map((l) => mkLine(l.start, l.end, l.words.map((w) => w.text))) },
    ];
    transcript.sync(100, reparsed);
    expect(bodyEl().children[0]).toBe(firstRow);
  });
});
