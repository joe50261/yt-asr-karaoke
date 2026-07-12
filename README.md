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
  卡在半路。
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

- 字幕資料自帶的 `\n` 行標記（json3 的獨立 `\n` seg）；
- 說話者變更（`>>` 開頭的字）；
- 整軌沒有任何 `\n` 標記時，改用時間間隔：前後字間隔超過
  `LINE_BREAK_GAP_MS`（700 ms）斷行。

行內沒有字數上限，長行由 CSS 折行。

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
  同一條規則的 CSS 端與 JS 端都從這裡取值。
- `yk-log.js` —— 帶標籤的 console logger。
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
- `yk-ui.js` —— player-chrome 共用 UI 機制：藥丸鈕掛載（`mountPillButton`，
  Karaoke 開關 / ⚙ / 字幕全文三顆共用）與 pointer-capture 拖曳調寬
  （`attachDragResize`，拖出視窗放開不會掛死）。
- `yk-capture.js` —— `fetch`/XHR 攔截器。把**原始** asr timedtext body
  捕進池裡（經保存的原生 getter 讀取——與換給播放器的內容分屬兩條讀取
  路徑），並提供 transform 接縫（`registerTransform`/`clearTransform`，
  page-global），讓原生模式換掉**播放器**收到的 body。無 transform 時
  ＝與被動模式位元組等同。
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
  （與切一遍同一招，計 rAF tick 不設計時器）。兩者共用每輪 one-shot
  上限 8 次的預算，防止與使用者對戰或洗版。每個動作（選軌、相位轉移、
  re-arm、切一遍）都記 log 並帶 `v=<影片id>`，多影片連續導航時可逐行
  對上。engine 每 tick 呼叫 `drive()`、teardown 時呼叫 `reset()`。
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
- 高亮只用字幕資料自帶的 `tOffsetMs`；自動字幕只有行級時間（無逐字
  offset）的影片，退回逐行高亮。
- 改寫自專案的 `karaoke.js`，加上早期 hook 安裝、SPA 生命週期處理、
  翻譯/雙語綁定與頁內設定選單。
