// Vitest 設定(前端邏輯測試層:hooks、資料轉換函式)。
// 對應 ARCHITECTURE.md 第八節第 5 條的三層測試工具分工,見 .claude/skills/automated-testing/SKILL.md。
//
// 刻意獨立成自己的設定檔(不是把 test 區塊塞進 vite.config.ts),原因:
// vite.config.ts 是 build/dev server 設定,職責跟「怎麼跑測試」不同,分開比較不會互相干擾,
// 之後要調整任何一邊都不用擔心波及另一邊。
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // 大部分測試對象是 React hooks / 瀏覽器 API(localStorage 等),用 jsdom 模擬瀏覽器環境。
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      // 只收 src 底下的 *.test.ts(x);pgTAP 的 supabase/tests/** 不歸這裡管。
      //
      // SPECS-INDEX #714:額外收 `e2e/support/**/*.test.{ts,tsx}` 這一條窄路徑——
      // e2e/support/env-file.ts 是一支純字串解析函式(跟瀏覽器、資料庫都無關),用 Vitest
      // 秒跑就能逐條驗完,不值得為它啟動 dev server + 真實瀏覽器。
      // ⚠️ 這條路徑刻意只收 `*.test.ts`:**Playwright 的檔案一律是 `*.spec.ts`**,不會被
      //    Vitest 誤收進來(誤收的話 Vitest 會去 import @playwright/test 然後整批爆掉)。
      //    新增 e2e 測試時請維持這個命名分工:Playwright = `.spec.ts`,Vitest = `.test.ts`。
      include: ["src/**/*.test.{ts,tsx}", "e2e/support/**/*.test.{ts,tsx}"],
      css: false,
    },
  }),
);
