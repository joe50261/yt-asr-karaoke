// e2e-a 層：真 Chromium + 真 unpacked 擴充，餵控制夾具（stub YouTube player）。
// 載入 MV3 擴充必須有頭（headless 不載 extension），故 fullyParallel=false + headless=false。
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/e2e-a',
  fullyParallel: false,
  workers: 1,
  use: { headless: false },
});
