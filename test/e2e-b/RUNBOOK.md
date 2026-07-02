# e2e-b RUNBOOK — 真 YouTube + MCP 熱注入的人工駕駛驗證

e2e-b 不是自動 suite：它是「真 youtube.com、真播放器、真 timedtext」下由 MCP/CDP
人工駕駛的驗證程序。**功能契約寫在 unit（Jest）與 e2e-a（Playwright）裡；本檔只寫
載具步驟**——怎麼注入、怎麼觀測、怎麼截圖——兩者不混（測試寫契約，MCP 步驟抽成
runbook）。

## 前置

- Chrome 已載入 unpacked 擴充（本 repo 根目錄），連上 browser MCP。
- 測試影片：`5ipNqGvS5Hw`（GQ Taiwan 星戰風暴兵大全；en ASR + 自動翻譯齊全，
  與 `test/fixtures/` 同源）。
- 前貼片廣告：等倒數結束 → 截圖定位「略過」鈕 → 用 MCP **座標** left_click。
  JS `.click()` 對略過鈕無效。

## 通則（每次 e2e-b 都適用）

1. **磁碟改動的 live 驗證一律 MCP 注入熱抽換**：把整個 yk-*.js 檔案源碼貼進
   `javascript_tool` eval——IIFE 重跑 `__YK__.register` 即觸發 hotSwap。禁止改走
   base64／本機 server／請使用者重載擴充。
2. **截圖規則**：給使用者看的驗證截圖必須單獨一個 MCP call（放進 batch 不會顯示）。
   截圖可能落後渲染一個週期：**連截兩張、以第二張為準**（祭品截圖）。
3. **控制變因**：測 ON/OFF 邊緣前先確認**起始狀態**不是已達標狀態；「畫面沒變」
   無鑑別力（壞掉也會沒變），要配一個陽性對照（改另一個輸入、證明輸出真的會動），
   並確認訊號真的送達（讀對應全域，見下）。
4. **可觀測全域**：
   - `window.__YK_TX__.fn` — 現任 transform（native ON ≠ null；OFF/退場 = null）。
   - `window.__YK_NETIMPL__` — 一次性 fetch/XHR 補丁「現在跑的邏輯」。熱抽換
     yk-capture 後其欄位必須換新（函式 identity 改變）＝新碼真的生效。
   - `window.__YK_CAP__` — 原始 body 池（**永遠不得**含 cooked 內容：任一 entry
     `JSON.parse` 後不得有 `pens` 內非空 `fcForeColor` 的我方配色 0xffe566）。
   - Network 面板 `timedtext` 請求 — 「強制重抓真的發生」的直接證據。

## Native 模式驗證清單

| # | 步驟 | 預期（觀測點） |
|---|------|----------------|
| 1 | ⚙ → 開「原生播放」 | `__YK_TX__.fn` 非 null；Network 出現新 timedtext（OFF→ON 重抓）；畫面 = YT 原生字幕、金色逐字 highlight（截圖 ×2 取第二張） |
| 2 | 連續播放 ≥ 2 分鐘 | 字幕就地置換、**不堆疊**（pop-on standalone cue 配方的現場證據） |
| 3 | 開 雙語對照 + 選譯文 | 兩列各自獨立移動 highlight；`譯文在上` 翻轉上下列（陽性對照） |
| 4 | 關「原生播放」 | Network 有新 timedtext；畫面回原生白字；`__YK_TX__.fn` = null |
| 5 | native 顯示中 → 點 Karaoke: OFF | 字幕**還原成原生白字**（teardown 帶 restoreCaption 的行為）；`__YK_TX__.fn` = null |
| 6 | 使用者手選「手動字幕軌」→ 再關 native | **不得**動使用者的選軌（`getOption('captions','track')` 前後一致）——讓位守門 |
| 7 | native 模式中 SPA 換片 | 新影片正常（transform 不跨片污染）；回上一片亦正常 |
| 8 | 字幕全文按鈕 | native 模式下按鈕在**頂右欄第三格**（Karaoke/⚙ 之下），不壓 YT 左上標題／頭像 |

**尚未 live 驗證的情境**（做過請把結果補記於此）：
- 廣告中／廣告後的 native 行為（transform 掛著時廣告自帶字幕是否受影響——
  `isAsrTimedtextUrl` 理論上擋掉，未現場驗）。
- **廣告中退場的還原判準**：`currentAsrSelection` 在廣告期間的實際回傳未知；若回
  null 且已出 300ms bust 窗，此刻關 native／Karaoke 會被 standDown 判成「使用者已
  切走」而不還原 → 廣告結束若玩家重顯快取的 cooked body，殘留症狀會經此路徑重現。
  驗法：廣告播放中點 Karaoke: OFF → 廣告結束後看字幕是否為原生白字。
- 逐行級字幕影片（無 per-word timing）在 native 模式的 cook 產物。

## Golden fixture 的 provenance 與重生程序

`test/fixtures/cooked.5ipNqGvS5Hw.en.karaoke.json3.json`：

- **內容**＝`cookKaraoke(en fixture 中 start∈[9100,10500]ms 的行)` 的輸出——
  unit golden 測試（`native.test.js` 的 golden 測項）就是用同一式重建後 `toEqual` 比對。
- **配方的 live 接受性**：整數 `fcForeColor`、pop-on（無 `sdScrollDir`）、standalone
  cue（無 wWinId）、per-seg `pPenId`、XHR 路徑——經真 youtube.com 實證
  （記錄：memory `native-json3-karaoke-cook-recipe`，2026-06-30 前後）。
- **重生程序（改 cook 配方時）**：
  1. 先跑上表 1–3 的 live 接受性驗證，確認**新** bytes 玩家真的接受且渲染正確；
  2. 才用新 cookKaraoke 重生 fixture：
     `node -e` 載入 sandbox（同 `loadNative`）→ 過濾 9100–10500ms → 寫檔；
  3. 嚴禁「測試紅了 → 直接用改過的碼重生 fixture 讓它變綠」而跳過步驟 1——
     那會讓 golden 退化成自我快照（碼怎麼錯它就怎麼綠）。
- **原始 fixture 抓法**：直接 fetch `baseUrl` 會 200 空 body（缺 `pot`）；必須被動
  hook player 自己的請求——完整流程見 `test/fixtures/README.md`。
