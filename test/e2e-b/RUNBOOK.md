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
4. **javascript_tool 的丟結果陷阱**：eval 若跨 SPA 導航、或內部 await 超過約 3 秒，
   回傳會變成 `{}`（動作其實有執行）。把「動作」與「讀取」拆成兩個 call，等待用
   短輪詢；長觀測改存 page-global（如探針 log）事後讀。
5. **歸因探針**（查「這個 fetch 是誰驅動的」）：wrap `player.setOption`、
   `XMLHttpRequest.prototype.open`、`window.fetch`，凡 captions/track 與 timedtext
   呼叫記 `{dt, path, 參數, stack}` 進 page-global；stack 裡出現 yk-*.js 幀＝我們驅動。
   探針用完必拆（保留原函式引用逐一裝回）。
6. **外部雜訊**：首頁預覽播放器會為**別支影片**自發 timedtext（`v=` 別支、`lang=` 介面
   語言、無 `tlang`）；歸因前先看 `v=` 參數，別誤算到擴充頭上。
7. **可觀測全域**：
   - `window.__YK_TX__.fn` — 現任 transform（native ON ≠ null；OFF = null）。
   - `window.__YK_NETIMPL__` — 一次性 fetch/XHR 補丁「現在跑的邏輯」。熱抽換
     yk-capture 後其欄位必須換新（函式 identity 改變）＝新碼真的生效。
   - `window.__YK_CAP__` — 原始 body 池（**永遠不得**含 cooked 內容：任一 entry
     `JSON.parse` 後不得有 `pens` 內非空 `fcForeColor` 的我方配色 0xffe566）。
   - Network 面板 `timedtext` 請求 — 「切一遍後播放器真的重新請求」的直接證據。
8. **每一步注入/操作/斷言都前置 ad 檢查**——不是「出事再查廣告」的除錯提示，是
   操作紀律：熱抽換、改設定、驅動選軌、讀斷言之前，一律先讀 `player.classList.contains
   ('ad-showing')`，廣告中就輪詢等它結束（可略過就座標點掉）再動作。廣告期間 yk-native
   不觀測簽名（ad 守門）、driver 持旗等廣告結束，此時做的任何操作都測不到
   東西，「沒反應」毫無鑑別力（實錯過一次：廣告中翻設定誤判成程式壞了）。
9. **多輪熱抽換後 rAF 鏈可能斷**（tick 停、`autodrive.drive` 零呼叫但 `state.active`
   仍 true）：`window.__YK__.swap('engine')` 強制重啟即復活。這是 hot-swap 載具的
   邊角（run/teardown 的 rAF id 覆寫競態），磁碟單次載入不會發生。

## Native 模式驗證清單

| # | 步驟 | 預期（觀測點） |
|---|------|----------------|
| 1 | ⚙ → 開「原生播放」 | `__YK_TX__.fn` 非 null；畫面 = YT 原生字幕、金色逐字 highlight（截圖 ×2 取第二張）。fetch 數：當場翻開關（字幕顯示中）→ 切一遍 **恰 1 條**；進場即已開 → **0 條**額外（player 進場自己的請求直接被煮） |
| 2 | 連續播放 ≥ 2 分鐘 | 字幕就地置換、**不堆疊**（pop-on standalone cue 配方的現場證據） |
| 3 | 開 雙語對照 + 選譯文 | 兩列各自獨立移動 highlight；`譯文在上` 翻轉上下列（陽性對照） |
| 4 | 關「原生播放」 | Network 有新 timedtext；畫面回原生白字；`__YK_TX__.fn` = null |
| 5 | native 顯示中 → 點 Karaoke: OFF | `__YK_TX__.fn` = null；**0 條**新 timedtext、**0 次** setOption；畫面維持現有 karaoke body，播放器下一次載入字幕（換軌/換片）起為原生白字 |
| 6 | 使用者手選「手動字幕軌」→ 再關 native | 使用者的選軌不變（`getOption('captions','track')` 前後一致） |
| 7 | native 模式中 SPA 換片 | 新影片正常（transform 不跨片污染）；回上一片亦正常 |
| 8 | 字幕全文按鈕 | native 模式下按鈕在**頂右欄第三格**（Karaoke/⚙ 之下），不壓 YT 左上標題／頭像 |
| 9 | SPA 導離 watch 頁（點 logo） | 離開窗口內舊影片 **0 條** timedtext、0 次 setOption（用上方探針驗；守門前同程序我方會多發 2 條）；`__YK_TX__.fn` = null。註：首頁上可能出現**無 setOption 前導**的 (orig) fetch——那是 player 自己的導航行為，非我方 |
| 10 | 導離後 back 回同支影片 | autodrive **自動**重新啟動（選軌自動回目標譯文、雙列恢復；engine teardown → `autodrive.reset()`）。進場 fetch **恰 1 條**（選軌本身）——進場不 redrive（首次觀察只初始化簽名），player 自己的請求直接被煮；已 live 驗證（2026-07-02/03） |
| 11 | native 中翻「譯文在上」 | 設定簽名變更 → `autodrive.redrive()` → **恰 1 條** fetch 以新排序重煮，畫面上下對調；已 live 驗證（2026-07-03，截圖：[音乐] 上列金色/[Music] 下列） |

**尚未 live 驗證的情境**（做過請把結果補記於此）：
- 廣告中／廣告後的 native 行為（transform 掛著時廣告自帶字幕是否受影響——
  `isAsrTimedtextUrl` 理論上擋掉，未現場驗）。
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
