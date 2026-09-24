// Playwright 設定(端對端瀏覽器測試層)。
// 對應 ARCHITECTURE.md 第八節第 5 條的三層測試工具分工,見 .claude/skills/automated-testing/SKILL.md。
//
// 這裡選擇對著本機 `npm run dev`(Vite dev server)跑,不是對正式 Vercel 部署網址跑——原因:
//   1. e2e 測試需要控制網址列導向(注入假憑證後造訪 /app),本機 dev server 跑起來、關掉都很快,
//      不會佔用/干擾正式站台的真實流量或快取。
//   2. 前端程式碼本身沒有差異(同一份 build 產物邏輯),本機 dev server 已經足以驗證
//      React Router 的導向行為與 auth-guard 的呼叫時機,不需要真的部署一次才能測。
//   3. 這份測試仍然會打「真正的」Supabase Auth 伺服器(.env 裡設定的正式專案 wjtbmmnakcriuaqoknsq)
//      ——只是驗證一組格式正確、但簽章無效的假 token 會被伺服器判定為 401,屬於唯讀的憑證驗證行為,
//      不會寫入/修改任何一筆真實資料。
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // 🔴 SPECS-INDEX #714:**一定要明寫 testMatch,不要用預設值。**
  // Playwright 的預設 testMatch 是 `**/*.@(spec|test).?(c|m)[jt]s?(x)`——**連 `*.test.ts` 也收**。
  // 2026-09-25 新增的 e2e/support/env-file.test.ts 是一支 Vitest 測試(純字串解析函式,不需要
  // 瀏覽器),放在 e2e/ 底下之後,Playwright 會把它當成自己的測試檔載入 → import 到 `vitest`
  // → 在收集階段整個爆掉,`npx playwright test --list` 的輸出變成
  // **「Total: 0 tests in 0 files」**(實測)。
  // ⚠️ 這個失效模式極度危險:它不是「一條測試紅了」,而是**整套 e2e 靜默變成 0 條**,
  //    CI 上看起來像是「全部通過」。收斂成只收 `*.spec.ts` 之後,兩層測試的命名分工就固定了:
  //    **Playwright = `*.spec.ts`,Vitest = `*.test.ts`**(vitest.config.ts 的 include 也是照這個分)。
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  reporter: "list",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:5183",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 5183 --strictPort",
    url: "http://localhost:5183",
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
