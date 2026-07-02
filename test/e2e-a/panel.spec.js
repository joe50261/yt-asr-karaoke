// e2e-a (Playwright) — 真 Chromium + 真 unpacked 擴充 + 控制夾具（stub player，無真 YouTube）。
// 驗 in-page 設定選單（yk-panel）在「真擴充 + 真 chrome.storage + 真 isolated-world bridge」下
// 端到端可用 —— 這是 UNIT（注入 mock）與反射整合在 Node sandbox 證不到的最後一哩：
//   1. ⚙ 鈕真的掛上 player（content scripts 注入 + engine 啟動）。
//   2. Auto-translate 選單 live 反射 stub player 的 translationLanguages（讀 yt，非寫死）。
//   3. 改設定 → 真 settings.apply → 真 isolated-world bridge 反向寫 → 真 chrome.storage.set。
//   4. reload 後值持久（bridge 把 storage push 回 MAIN world，選單反射之）。
//
// 取代舊的 popup-reflect.spec.js：選單已搬進注入頁，popup 連同其 chrome.storage 反射一併退役。
// 注意：MAIN-world content script 與 Playwright 的 page.evaluate 共用同一個 page main world，
// 故可直接讀 window.__YK__（settings.current 即經 bridge 回灌的值）。
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

const EXT_DIR = path.resolve(__dirname, '..', '..');
const STUB = path.join(__dirname, 'fixtures', 'youtube-stub.html');

test('in-page 設定選單：真 chrome.storage 持久 + 反射 player runtime 語言', async () => {
  const ctx = await chromium.launchPersistentContext('', {
    headless: false, // MV3 擴充在 headless 不載入，故必須有頭（見 playwright.config.js）
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  try {
    await ctx.route('https://www.youtube.com/watch*', (r) =>
      r.fulfill({ path: STUB, contentType: 'text/html' }),
    );
    const page = await ctx.newPage();
    await page.goto('https://www.youtube.com/watch?v=stub');

    // (1) ⚙ 鈕真的掛上 player。
    await page.waitForSelector('#yt-karaoke-panel-btn', { timeout: 10000 });

    // (2) 開選單（真 click 路徑；force 跳過 hover-reveal 的 opacity:0 actionability）。
    await page.click('#yt-karaoke-panel-btn', { force: true });
    await expect(page.locator('#yt-karaoke-panel')).toHaveAttribute('data-open', 'true');

    // (3) Auto-translate 選單反射 stub player 的 translationLanguages（live 讀 yt）。
    await expect
      .poll(() => page.$$eval('#yk-set-autolang option', (els) => els.map((e) => e.textContent)), {
        timeout: 10000,
      })
      .toEqual(['關閉', '中文（繁體）', '日文']);

    // (4) 改 captionStyle → 真 settings.apply → 真 bridge 反向寫 → 真 chrome.storage.set。
    //     onChanged→push 只在真的寫入時觸發，故 settings.current 追上 'advanced' 即證明 storage 真被寫。
    await page.selectOption('#yk-set-style', 'advanced');
    await expect
      .poll(() => page.evaluate(() => window.__YK__.resolve('settings').current.captionStyle), {
        timeout: 10000,
      })
      .toBe('advanced');

    // (5) reload → 重新注入 → bridge push 持久值回 MAIN world → 重開選單反射 advanced（真持久）。
    await page.reload();
    await page.waitForSelector('#yt-karaoke-panel-btn', { timeout: 10000 });
    await expect
      .poll(() => page.evaluate(() => window.__YK__.resolve('settings').current.captionStyle), {
        timeout: 10000,
      })
      .toBe('advanced');
    await page.click('#yt-karaoke-panel-btn', { force: true });
    await expect(page.locator('#yk-set-style')).toHaveValue('advanced');

    // (6) 原生播放開關：真 click → nativeMode 真寫入 storage；字幕樣式（overlay-only）
    //     隨之停用但保值；關回去後恢復可用（值原樣）。
    const nativeSw = page.locator('#yk-set-native');
    await expect(nativeSw).not.toBeChecked();
    await nativeSw.click({ force: true });
    await expect
      .poll(() => page.evaluate(() => window.__YK__.resolve('settings').current.nativeMode), {
        timeout: 10000,
      })
      .toBe(true);
    await expect(page.locator('#yk-set-style')).toBeDisabled();
    await expect(page.locator('#yk-set-style')).toHaveValue('advanced'); // 凍結不清值
    await nativeSw.click({ force: true });
    await expect
      .poll(() => page.evaluate(() => window.__YK__.resolve('settings').current.nativeMode), {
        timeout: 10000,
      })
      .toBe(false);
    await expect(page.locator('#yk-set-style')).toBeEnabled();
  } finally {
    await ctx.close();
  }
});
