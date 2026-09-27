#!/usr/bin/env node
// #804(SPECS-INDEX):Playwright e2e「應該有幾條測試」的基準核對/更新指令。
//
//   node scripts/e2e-test-count.mjs check    ← npm run test:e2e:count(npm run test:e2e 開跑前也會自動先跑這個)
//   node scripts/e2e-test-count.mjs update   ← npm run test:e2e:count:update(新增/刪除測試之後跑一次,更新基準)
//
// 做法:用 `playwright test --list`(**唯讀**:只收集測試、不啟動瀏覽器、不建立任何測試資料,幾秒鐘跑完)
// 搭配 e2e/support/test-count-gate-reporter.ts 這個 reporter,把「收錄到的條數/檔數」拿去對
// e2e/test-count-baseline.json。判定邏輯在 reporter 裡,這個檔案只是把指令包起來,不另外算一套數字,
// 避免兩邊算法漂移。
//
// 為什麼要有這一步:#714 / #804 都是「測試沒跑卻沒有紅字」的失效——testMatch 改壞會讓整套歸零、
// worker 當掉會讓後面的測試 did not run。基準值寫成檔案、每次機器核對,人腦就不用記「上次是 110 還是 114」。
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] ?? "check";

if (mode !== "check" && mode !== "update") {
  console.error(`用法:node scripts/e2e-test-count.mjs [check|update](收到:${mode})`);
  process.exit(2);
}

const require = createRequire(import.meta.url);
// 直接用 node 執行 Playwright 的 CLI 入口,不經過 npx / shell:Windows 上路徑含括號與中文時最不容易出錯。
const playwrightCli = require.resolve("@playwright/test/cli");

const env = { ...process.env };
if (mode === "update") {
  // reporter 看到這個環境變數就會把這次收錄到的數字寫回基準檔(名稱要跟 reporter 裡的 UPDATE_BASELINE_ENV 一致)。
  env.E2E_TEST_COUNT_UPDATE_BASELINE = "1";
}

console.log(
  mode === "update"
    ? "[e2e 條數守門] 重新收集全套 e2e 測試並更新基準(唯讀 --list,不會啟動瀏覽器、不會建立測試資料)…"
    : "[e2e 條數守門] 核對全套 e2e 測試條數是否符合基準(唯讀 --list,不會啟動瀏覽器、不會建立測試資料)…",
);

const result = spawnSync(
  process.execPath,
  [playwrightCli, "test", "--list", "--reporter=./e2e/support/test-count-gate-reporter.ts"],
  { cwd: projectRoot, stdio: "inherit", env },
);

if (result.error) {
  console.error(`[e2e 條數守門] 無法啟動 playwright:${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
