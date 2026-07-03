# Dual-track timedtext fixtures

真實 YouTube 自動字幕 + 自動翻譯，成對抓回來，用來測試 `content.js` 的
dual-track 配對 / `groupLines` / transcript 間距邏輯。

## 檔案

| 檔 | 內容 |
|---|---|
| `5ipNqGvS5Hw.en.asr.json3.json` | 原文自動字幕（en, ASR），前 ~90 秒 |
| `5ipNqGvS5Hw.en-zh-Hant.asr.json3.json` | 同一條 ASR track 的自動翻譯（→ zh-Hant），前 ~90 秒 |
| `cooked.5ipNqGvS5Hw.en.karaoke.json3.json` | **golden**：`cookKaraoke`（yk-native）對 en fixture 中 start∈[9100,10500]ms 行的輸出。配方（整數 fcForeColor / pop-on standalone cue / per-seg pPenId）經真 youtube.com live 實證；provenance 與重生程序見 `test/e2e-b/RUNBOOK.md`——嚴禁用改過的碼直接重生讓測試變綠 |
| `meta.json` | 來源、抓取方式、精簡說明、統計 |
| `_analyze.py` | 複刻 `groupLines` 的對齊驗證腳本（`python3 _analyze.py`） |

影片：`5ipNqGvS5Hw`（GQ Taiwan《星際大戰》風暴兵大全）。

## 怎麼抓的

直接 fetch caption `baseUrl` 會回 **HTTP 200 但空 body** —— baseUrl 缺 player 帶的
`pot`（proof of origin token）。所以跟 `content.js` 一樣走「被動 hook player
response」：在頁面 context patch `fetch`/XHR，再用 player API
（`setOption('captions','track',{… translationLanguage:{languageCode:'zh-Hant'}})`）
觸發請求，攔截回應。

> 已精簡：移除 `acAsrConf` 與 window 樣式欄位，只留 `content.js` 真正會 parse 的
> `tStartMs` / `dDurationMs` / `segs.utf8` / `tOffsetMs`。時間與文字皆為原值。

## 實證結論（前 90 秒這段）

跑 `_analyze.py`：

```
原文行 N = 44
譯文行 M = 41        ← N ≠ M：3 行被譯文「合併」掉
原文行 start 在譯文有同值 = 41/44   → 3 個孤行
[data-variant] + .ykt-line 命中 = 40 次，其中「下一列也是譯文」誤命中 = 0
前 16 列 DOM 序列 = o T o T o o T o T o o T o T …
```

對照先前的架構討論，這份真實資料給出三個結論：

1. **「同值碰撞」屬實。** 41/44 原文行的 `start` 在譯文行裡有完全相等值；DOM
   序列前段乾淨的 `oToT` 就是 stable sort 同 start 把原文(先 push)排在譯文前的產物。
   配對沒有任何顯式邏輯，全靠 `ordered.sort` 的 tie。

2. **N ≠ M 屬實，但形態與先前猜測相反。** auto-translate 在這段是**合併**原文行
   （M < N），不是拆分。故障形態是序列裡的 `oo`（孤行原文，譯文把對應行併走了），
   **不是** `TT`（連續譯文）。所以 `[data-variant] + .ykt-line` 的「譯文後接譯文」
   誤命中在這段是 0 —— 真正會出事的是 `oo` 處：第二個原文行前面不是譯文，拿不到
   pair 間距，間距規律斷掉。

3. **全片差異更大。** 全片統計 N=632 / M=483（差 149 行），孤行與合併比這段更密集，
   也可能在別段出現 `TT`。要完整覆蓋可重新截取全片（這份只取前 90 秒控制體積）。

結論不變：pair 不是 DOM 裡的實體，是 sort tie 的副作用；用相鄰選擇器去猜 pair 邊界，
在真實的 N≠M 資料上必然漏掉孤行。根治仍是建實體 `.ykt-pair` 容器、間距下在容器層。
