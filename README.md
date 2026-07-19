# YouTube 字幕卡拉OK（Chrome 擴充功能，Manifest V3）

把 YouTube 影片的**自動產生字幕**變成卡拉OK：當前行置中顯示在播放器上，
每個字隨語音同步亮起，用的是字幕軌**真實的逐字時間戳**。也支援
YouTube 的**自動翻譯**字幕，包含**雙語對照（dual-track）**顯示。

## 運作原理（短版）

擴充功能是對「播放器當前顯示的自動字幕」的**被動綁定**：

- **播放器** —— 只有 YouTube 播放器能*抓取*字幕軌；它的請求帶 `pot`
  （proof-of-origin）token。直接 fetch 字幕 URL 會被 `pot` 擋下、回空 body。
- **hook** —— 一個 `document_start` 的 hook 被動*捕獲*播放器自己的
  `timedtext` 請求 body（自動字幕 `kind=asr`，翻譯再加 `tlang=…`）。
- **我們** —— 讀播放器當前選擇的軌，找到對應的捕獲 body，解析其 json3，
  渲染卡拉OK覆蓋層。

預設情況下**由你自己選擇自動字幕**，擴充功能綁定播放器當前的選擇。
唯一的例外是可自行開啟的**自動翻譯**：選定目標語言後，引擎用播放器*自己的*
`setOption` API 依序選擇原文 asr 與其翻譯——抓取仍由**播放器**完成（帶它的
`pot` token），hook 仍然只捕獲。見下方「使用方式」。

## 使用方式

1. 打開一個 `https://www.youtube.com/watch?...` 影片。
2. 在播放器的字幕選單（齒輪 → 字幕）選**自動產生**的軌
   （例如 `English (auto-generated)` / `英文 (自動產生)`）。
   卡拉OK覆蓋層會綁定它並逐字亮起。
3. 要看翻譯，選**自動翻譯** → 目標語言
   （例如 `英文 (自動產生) >> 中文`）。覆蓋層切到該語言，仍然逐字。
4. **Karaoke: ON/OFF** 按鈕（播放器右上角，滑鼠懸停顯示）切換覆蓋層。
   狀態與其他設定同路徑持久化（經 `bridge.js` 寫入 `chrome.storage`）。
5. **調整字幕框寬度**：懸停覆蓋層、拖右緣把手（置中框對稱加寬/收窄，
   改變換行位置）；雙擊把手重設為貼合文字。依瀏覽器記憶。

如果你選了**非自動**字幕（手動/上傳的字幕）或關掉字幕，擴充功能會**讓位**：
撤下覆蓋層、取消隱藏播放器自己的字幕。

## 側欄字幕全文

**字幕全文**按鈕（字幕框上方、跟著它移動——懸停顯示）展開側欄面板，
顯示**完整字幕逐字稿**。正在播放的行會高亮並自動捲入視野，行內當前字
隨語音卡拉OK亮起。**點任一行即跳轉**影片到該處。**拖面板左緣調寬度**；
**雙擊左緣自動貼合**最長行（依瀏覽器記憶）。雙語模式下逐字稿是雙語的：
原文與譯文按時間交錯成雙語對——譯文緊貼在其原文之下、對與對之間留較寬
間距，且譯文顏色淺一階（用顏色區分，不用縮排）——各自高亮自己的當前行。
面板與播放保持同步，擴充功能讓位時隱藏，開/關狀態與寬度都會記憶。
它**跟隨 YouTube 自己的亮/暗主題**（依 `<html dark>`），兩種模式都貼合頁面。

## 頁內設定選單

點**播放器上的 ⚙ 按鈕**（就在 **Karaoke: ON/OFF** 下方）打開設定卡片。
它活在**頁面上**，不在工具列 popup 裡，所以控件是真實的播放器 DOM
（automation/MCP 能驅動），全螢幕也能用。卡片跟隨 YouTube 亮/暗主題。
變更即時生效並跨重載持久化（經 `bridge.js` 寫入 `chrome.storage`）。

- **原生播放** —— 切換卡拉OK的*繪製方式*。關（預設）是上述的**覆蓋層**模式
  （我們自繪一個字幕框、蓋在被隱藏的原生字幕上）。**開**是**原生**模式：
  在播放器抓取自動字幕的那一刻，我們**煮**出一份卡拉OK樣式的 `json3`
  （每列一個 pop-on 字幕視窗，每個字用 active / past / future 三種 pen
  按軌內真實逐字時間重繪）並**換進回應裡**，讓 **YouTube 自己的字幕渲染器**
  畫出逐字高亮。完全不自繪，因此繼承 YouTube 原生的排版、全螢幕與字幕設定；
  **雙語對照**照樣可用（兩個堆疊的原生視窗）。覆蓋層專屬的**字幕樣式**預設
  在原生模式不適用——原生開啟時該下拉**停用**但保留原值，關回覆蓋層模式即恢復生效。
  **字幕全文**按鈕移到我們右上欄的第三格（Karaoke 與 ⚙ 之下——原生模式沒有
  覆蓋框可以停靠，而左上角屬於 YouTube 自己的全螢幕標題/付費宣傳區）。
  當場切換模式（開或關）都走「切一遍」：重選當前字幕變體，播放器自己
  重新請求字幕、立即生效。按 Karaoke 開關關掉整個擴充只是卸下 transform；
  畫面上的字幕到播放器下一次載入（換軌/換片）才回原生樣式。
  見「架構」——它是獨立的可熱抽換模組（`yk-native.js`：cook 加上掛/卸同步），
  外加 `yk-capture.js` 裡薄薄的 transform 接縫；捕獲池只存**原始** body
  （經保存的原生 getter 讀取），逐字稿與雙語 cook 讀的都是它。
- **字幕樣式** —— 覆蓋層的外觀，即時生效：
  - `預設` —— 金色當前字，柔光暈加輕微放大。
  - `YT` —— 貼近 YouTube 原生字幕（字重 400、白字、近方形框）；
    當前字是純平金色，無特效。
  - `進階` —— 當前字**在其發音時長內由左至右填色**（真正的逐字掃描），
    帶進度底線、無縮放抖動；淺色框帶邊緣陰影；雙語時譯文列次要化
    （較小、較暗），原文為主。
- **雙語對照（dual-track）** —— 選了自動翻譯時，把原文*和*譯文顯示成上下
  兩列逐字列（覆蓋層），逐字稿也交錯顯示。各列按自己軌的時間與行結構走，
  所以兩列大致同步。需要兩份 body 都已載入：先選一次`自動產生`、再選
  `自動翻譯`（直接選翻譯不會載入原文——那就只顯示可用的那一份），或直接用
  下面的**自動翻譯**讓它幫你載。
- **自動翻譯** —— 自動**驅動**的目標。它與上面的**雙語對照**完全**正交**：
  這個選單只控制*播放器顯示哪個字幕*（驅動）；**雙語對照**只控制*單列或
  雙列*（顯示）。選定目標語言後，引擎**一次性**驅動播放器（用它自己的
  `setOption` API）先到原文 asr、再到該語言的自動翻譯——不需要手動走
  `自動產生`/`自動翻譯`，每一步都以 body 實際捕獲為門檻（沒有計時器）。
  若播放器在等待 body 時自己把選軌重設（廣告邊界、初始化覆寫），引擎會
  觀察到漂移並**重選**（每輪驅動有限次）；若選軌還在但 body 遲遲不到
  （空/壞回應），空等約 10 秒會**重選同一變體重發請求**——驅動鏈不會
  卡在半路。重發按 capture 的壞回應台帳**指數退避**：同變體連續壞回應
  （YouTube 對 `tlang=` 路徑的 **429 限流**、5xx、pot 失手的空 200）
  每多一次，重發門檻翻倍（上限約 5 分鐘）——對已限流的端點固定間隔
  連打只會延長封鎖。429 是伺服器端按 IP/session 記的翻譯路徑配額，
  不帶 `tlang` 的原文 asr 不受影響；配額常在頁面載入前就已耗盡
  （播放器自己還原字幕偏好的第一個請求就可能 429），退避後自動重試。
  一次性：換影片、換目標語言、或引擎 teardown 後回到同支影片，才會再驅動
  一輪。切回`關閉`只是**停止自動驅動**；顯示狀態屬於
  **雙語對照**自己的開關，不受影響。因為兩者正交，任何組合都成立
  ——例如`（中文，雙語關）`自動載入中文翻譯並**單列**顯示；`（中文，雙語開）`
  顯示雙語對照。選單本身**由播放器執行期的 `translationLanguages` 建構**，
  每次打開卡片都從 `yt` 現讀，所以只會列 YouTube 真的提供的語言；已存的
  目標若不再提供，就退回`關閉`。選單**自己不持有任何語言清單**（播放器
  還沒載入字幕前只顯示`關閉`；載入後重開即填滿）。驅動時也做執行期驗證：
  `yk-yt.selectAsrVariant` 拒絕播放器沒有提供的語言代碼。
- **譯文在上** —— 雙語時把譯文疊在原文上方而不是下方。覆蓋層與側欄
  逐字稿都適用（兩者同一列序）。

## 換行

斷行規則（`yk-parse.groupLines`）：

- 字幕資料自帶的 `\n` 行標記——json3 的獨立 `\n` seg，或內嵌在字裡的
  `\n`（`"word\n"`、`"\nword"` 同樣視為行標記）；
- 說話者變更（`>>` 開頭的字）；
- `\n` 沒有編碼**事件邊界**時，退回事件邊界斷行：每個非 `aAppend` 的
  新事件斷行（asr 的行結構本來就落在事件上；`aAppend` 是 roll-up 續行，
  不斷）。判定看 `\n` 是否與事件邊界共現：classic 格式的獨立 `\n` seg
  都落在邊界上——那裡「邊界沒 `\n`」是刻意併行（翻譯軌跨事件併行是
  YouTube 有意的），事件邊界與間隔規則都不適用；**行級 cue 格式**
  （每事件單一 seg、`"列1\n列2"`、整軌無 `tOffsetMs` 的 roll-up 格式）
  的 `\n` 全在事件內部、邊界無編碼，照樣逐事件斷。時間間隔仍是後盾：
  前後字間隔超過 `LINE_BREAK_GAP_MS`（700 ms）也斷；
- 安全閥：組出來的行若字起點跨度超過 `LINE_MAX_SPAN_MS`（12 s，正常 asr
  行只有 2–7 s），代表上面所有結構都缺席（例如整片塞在單一事件裡），
  強制重切。切點不盲切等距：在 `LINE_SPLIT_TARGET_MS`（4 s）目標的彈性
  區間（2–6 s）內，選**原生 onset 間隔**（`start[i]−start[i−1]`，資料唯一
  真實的逐字時間；逐字 end 是 clamp 出來的顯示值）最大的字界——即語音
  真正停頓處；同值偏向 4 s 目標。

行內沒有字數上限，長行由 CSS 折行。曾有 asr 軌整軌不帶 `\n` 標記
（字尾又被 clamp 到下一字起點、無間隔可斷），整片崩成一行——事件邊界
與安全閥就是為此而設。

## 載入未封裝版（開發）

1. 打開 `chrome://extensions`。
2. 開啟右上角**開發人員模式**。
3. 點**載入未封裝項目**，選這個 `extension/` 資料夾。
4. 打開 `youtube.com/watch` 影片並選其自動產生字幕。

改完檔案後，在 `chrome://extensions` 點擴充功能的**重新載入**（↻），
再重載 YouTube 分頁。

## 檔案

卡拉OK邏輯拆成小型**依賴注入模組**（`yk-*.js`），由一個極小的容器
（`window.__YK__`）接線，任一模組都能在執行期熱抽換——見下方「架構」。
全部跑在 `MAIN` world、`document_start`，依載入順序列在 manifest
（`yk-di.js` 最先、`yk-main.js` 最後）。YouTube 強制 Trusted Types
（`innerHTML` 會被擋），DOM 都用 `textContent` / `replaceChildren` 建。

- `manifest.json` —— MV3 manifest。`yk-*.js` 模組跑 `MAIN` world
  `document_start`；`bridge.js` 跑預設（隔離）world。要求 `storage` 權限
  （設定持久化）；不要求任何 host 權限。
- `yk-di.js` —— DI 容器：`register` / `resolve` / `start` / 熱抽換。
- `yk-config.js` —— ID、儲存鍵、時間常數、`CJK_RE`，以及跨模組契約常數
  （播放器宿主 selector 表、卡拉OK亮字金、字幕樣式 preset 值、寬度上限）——
  同一條規則的 CSS 端與 JS 端都從這裡取值。也持有 **`BUILD`（運行 build
  自報）**：yk-main 開機第一行印 `boot build <BUILD>`，engine 每支影片的
  `init` 行也重印——console log 因此自帶「跑的是哪一版」的憑據（Chrome 對
  未封裝擴充功能不會自動重載，repo 已更新 ≠ 頁面注入的是新檔）。規則：
  **每次推送都必須 bump `BUILD`**，貼 log 回報問題時對照這個值。
- `yk-log.js` —— 帶標籤的 console logger；也持有**變體 log 標籤**的唯一
  定義點（`variant()`：原文 `en`、翻譯 `en→zh-Hant`）——engine 的
  binding/bound 與 yk-autodrive 的 select/drift/stall 同用，同一變體在
  log 裡只有一種寫法。
- `yk-settings.js` —— 設定中樞：持有即時的 `current`（含 Karaoke 主開關
  `enabled`），由 `bridge.js` 轉送進來；`apply()` 是唯一寫入路徑（就地改
  `current` ＋ 轉送出去持久化）。也持有雙軌顯示政策 `dualDisplayKeys`
  （engine 的 bind 序與 yk-native 的列序同源）。
- `yk-timing.js` —— 純函數的行/字狀態對映；行活躍窗（`lineWindow`）與字組
  狀態切點（`wordStateBounds`）的唯一定義點——覆蓋層、側欄逐字稿、原生
  煮字幕三個渲染面同源。
- `yk-parse.js` —— 純函數的 json3 → 字 → 行（無 DOM、無狀態；`linesFromJson`
  一步到位）。
- `yk-yt.js` —— YouTube 播放器與 DOM 的無狀態 adapter（含 playerResponse →
  字幕軌清單的唯一讀取點 `captionTracklist`）。`getPlayerResponse` 以
  `videoDetails.videoId` 對當前 URL 驗明正身：SPA 導航後
  `window.ytInitialPlayerResponse` 是上一次整頁載入的殭屍資料，不驗會
  綁到舊影片的軌（自動翻譯在導航後整個不啟動）。
- `yk-watch.js` —— **播放器觀測器**：每 tick 快照字幕選軌全貌
  （`yt.captionState`：含手動軌、手動軌翻譯、字幕關閉——
  `currentAsrSelection` 之外的盲區）與播放器狀態，只在**變化的瞬間**
  記 log：毫秒時戳（可與 DevTools Network 對時）、當下播放時間、廣告
  狀態，成因標注 `[own-select]`（autodrive 的 setOption 落地；每次
  select 後 `markOwn` 登記、落地一次即銷、~2s 歸因窗過期）／
  `[external]`（播放器自己重置或使用者操作）／`[baseline]`（本影片
  首次觀測）；playerState 轉移逐筆記錄（重置的對帳錨點）。YT 會在同
  session 的不明生命週期點重置選軌（偏好 reconcile），這是抓「哪個
  瞬間、前後發生什麼」的材料——實測（2026-07-18 log）重置落在
  buffering→playing 轉移前 ~160ms。`anchorAge()` 把「距最近生命週期
  錨點（baseline／playerState 轉移／廣告邊界）幾個 tick」開放給
  yk-autodrive 的 done 後對帳：貼近錨點的外部偏離是播放器重置（可回
  選），穩態深處的偏離是使用者動作（尊重）。engine 每 tick 呼叫
  `tick()`（導航守門之前——導航窗口內的重置也要看得到）、teardown
  呼叫 `reset()`。
  穩態零輸出。resolve 時自報一行 `watch attached`——「模組有沒有載入」
  與「播放器可不可觀測」拆成兩個可分辨的訊號：attached 有印而
  `[baseline]` 不出，問題在 `captionState` 回 null，不是模組不在頁面裡。
- `yk-ui.js` —— player-chrome 共用 UI 機制：藥丸鈕掛載（`mountPillButton`，
  Karaoke 開關 / ⚙ / 字幕全文三顆共用）與 pointer-capture 拖曳調寬
  （`attachDragResize`，拖出視窗放開不會掛死）。
- `yk-capture.js` —— `fetch`/XHR 攔截器。把**原始** asr timedtext body
  捕進池裡（經保存的原生 getter 讀取——與換給播放器的內容分屬兩條讀取
  路徑），並提供 transform 接縫（`registerTransform`/`clearTransform`，
  page-global），讓原生模式換掉**播放器**收到的 body。無 transform 時
  ＝與被動模式位元組等同。另記兩本 per-variant 台帳供 yk-autodrive
  節流：**壞回應台帳**（`lastFailure`：HTTP 狀態＋連續次數，429/5xx/
  空 200 入帳、成功入池清帳；asr-only）與**在途台帳**（`anyInFlight`：
  send 起算、loadend 結清、30 秒 TTL 防殘影；涵蓋**所有** timedtext
  含手動軌——捕獲與 transform 仍 asr-only）；abort（請求被選軌變更或
  session 重建取代）逐筆記 log 帶變體標籤，方便對帳，但不入失敗台帳。
  補丁只安裝一次（`__YK_NET__`）但**不含任何邏輯**：每個決策都經 page-global
  的 `__YK_NETIMPL__` 呼叫、每次 resolve 重指，所以熱抽換這個模組真的會改變
  live hook 跑的邏輯（MCP 注入的 session 能驗證自己的修改）。
- `yk-styles.js` —— 注入覆蓋層＋逐字稿＋設定選單的 CSS。
- `yk-overlay.js` —— 置中的卡拉OK覆蓋層（管理自己的渲染列）。
- `yk-transcript.js` —— 側欄逐字稿面板（管理自己的面板狀態）。
- `yk-panel.js` —— **頁內設定選單**（播放器上的 ⚙ 按鈕＋卡片），獨立的可
  熱抽換模組。純 view：讀 `settings.current` 反映控件、只經 `settings.apply()`
  寫入、自動翻譯清單每次開卡從 `yt.translationLanguages()` 現建。
  取代舊的工具列 popup。
- `yk-autodrive.js` —— **唯一的自動選軌 driver**：自動翻譯的 one-shot
  （持有自己的驅動 latch），**加上** `redrive()`（切一遍）——在 yk-native
  請求時把當前變體重選一次；播放器沒有字幕快取，任何 `setOption` 選軌
  都會讓它重新請求 timedtext。一個 boolean 旗標，逐 tick 重試到
  播放器接受為止；沒有計時器。等待 body 期間若觀察到播放器丟掉了我們
  驅動的選擇，會**漂移重選**；若選擇還在但 body 空等過久（壞回應不入池，
  fetch 觀察不到地死了），會**卡等重踢**——重選同一變體讓播放器重發請求
  （與切一遍同一招，計 rAF tick 不設計時器）；重踢門檻按 capture 的
  壞回應台帳（`lastFailure`）指數退避，429 限流下不盲踢；漂移重選對
  帳上有失敗紀錄的變體也改走退避。所有 setOption 前先過**在途守門**
  （`capture.anyInFlight`）：本影片**任何** timedtext 請求（含手動軌
  ——偏好還原的初始載入常是）還在路上就不選軌——播放器只有一條字幕
  載入管線，任何選軌都會 abort 在途請求，而 abort 只是客戶端不讀
  回應，伺服器端已計入配額，等於取消再白燒一次額度。新影片另有
  **讓路期**（~2 秒）：bind 當下不搶 setOption，先讓播放器 init 自己
  的偏好還原出手（有 body 落池即提前結束；同影片換目標語言不適用），
  避免在錯誤時機與內建功能 race。兩者共用每輪 one-shot 上限 8 次的
  預算，防止與使用者對戰或洗版。**done 後對帳（reseed）**：done 不是
  終點——實測播放器會在 done 後（如 buffering→playing 轉移）自己把
  選軌重置回「手動軌＋記住的翻譯」，one-shot latch 不動的話 engine
  只能 stepAside、失敗被 done/bound 的成功 log 蓋住。done 相位因此
  每 tick 繼續對帳：選擇偏離目標且字幕仍開著時，偏離「開始」貼近
  生命週期錨點（`watch.anchorAge`；錨可晚到，窗內逐 tick 續判）就把
  目標重選回來；穩態深處的偏離＝使用者換軌、字幕被關＝使用者意志，
  一律尊重。上限 3 次／one-shot，照樣過在途守門。每個動作（選軌、
  相位轉移、re-arm、切一遍、回選）都記 log 並帶 `v=<影片id>`，多影片
  連續導航時可逐行對上。engine 每 tick 呼叫 `drive()`、teardown 時
  呼叫 `reset()`。
- `yk-native.js` —— **原生播放模式**，獨立的可熱抽換模組：純函數
  `cookKaraoke(entries, opts)`（解析後的行 → 卡拉OK `json3`：pop-on 視窗、
  逐字重繪事件、經 `timing.wordState` 的逐 seg pen、整數色值）、註冊到
  `yk-capture` 的 impure `cook(url, body)` transform，以及掛/卸同步
  （`sync`/`reset`/`isOn`——狀態只有一個 `on` 旗標＋一個設定簽名）。
  核心就是「劫持＋切一遍」：transform 煮掉經過接縫的每一份回應，而
  播放器在每次選軌/載片都會自己請求，所以模式大多自然生效；只有當場翻
  設定（nativeMode、開著時的 dual/top）才請 autodrive 切一遍（重選當前
  變體，播放器隨之重新請求）。選軌變更不需觀測（播放器對新選擇自己會
  請求）。`reset` 卸下 transform、清簽名。
- `yk-engine.js` —— 生命週期指揮：選軌、綁定、渲染迴圈、SPA 重啟、開關。
  tick 有導航守門（URL 已換 → 什麼都不驅動，等正式 teardown）。原生模式下
  它只每 tick 呼叫 `native.sync()`、在切換瞬間交接字幕區域；teardown
  一律呼叫 `native.reset()` 卸 transform。
- `yk-main.js` —— 入口：裝 hook ＋ 啟動 engine。
- `bridge.js` —— 隔離 world 的中繼：把 `chrome.storage` 設定經
  `window.postMessage` 鏡射給 MAIN world 模組（它有 `chrome.*`；MAIN world
  沒有），也反向持久化——頁內選單的 `apply()` 發補丁，`bridge.js` 寫進
  `chrome.storage`（其 `onChanged` 再回聲回來）。
- `test/` —— 純 Node 的驗證 harness ＋ 雙語 timedtext fixtures。
- `icons/` —— 16/48/128 px 圖示。

## 架構（模組＋熱抽換）

每個 `yk-*.js` 向容器註冊一個 factory；解析是惰性且單例的。模組只透過
注入的依賴交談，且每個都小到能獨立閱讀/替換。持有 DOM、
監聽器或計時器的模組都提供 `dispose()`。

因為模組共享頁面的 `window`，模組可以**在執行期抽換而不重載擴充功能**：
重新 eval 一份改過的 `yk-*.js`（例如經 DevTools console 或 CDP
`Runtime.evaluate`）——它的 `register(...)` 重跑，容器把所有依賴它的
live 模組（dependents 先）連同它自己一起 dispose，然後以新 factory
重新解析並重啟 engine。

## 備註

- 不要求任何 host 權限；content script 只碰它被注入的 `www.youtube.com` 頁面。
- 原生字幕只在 asr 卡拉OK實際顯示時隱藏；音訊與自動播放下一支不受影響。
- 帶 `tOffsetMs` 的軌，高亮只用資料自帶的逐字時間。**行級軌**（整軌
  沒有任何 `tOffsetMs`，例如 roll-up cue 格式）改為在 cue 的**語音窗**
  （本事件 base 到下一個出字事件的 base——cue 自己的 `dDurationMs` 是
  顯示窗、與下一 cue 重疊，不能用）內按字元權重**內插**逐字 onset：
  拉丁按詞、CJK 逐字。內插只在整軌無 offset 時啟用，帶 offset 的軌
  一個位元組都不動。
- 改寫自專案的 `karaoke.js`，加上早期 hook 安裝、SPA 生命週期處理、
  翻譯/雙語綁定與頁內設定選單。
