// 「只連本機」的 Playwright 設定(紅利系統重構批次 8 新增)。執行:`npm run test:e2e:local`。
//
// 🔴 跟預設的 playwright.config.ts 完全分開,**預設設定一個字都沒改**:`npm run test:e2e` 照舊。
//    這份只做一件事:讓 e2e 對著本機 Docker 的 Supabase(`npx supabase start`)跑,不碰正式庫。
//
// 怎麼保證 100% 只打本機(細節見 e2e-local/support/local-target.ts):
//   ① 本機網址與金鑰一律取自 `supabase status -o env`(不讀 `.env`),主機不是 127.0.0.1/localhost、
//      或網址含 supabase.co ⇒ config 載入當下就 throw,一條測試都不跑。
//   ② 開發伺服器用**另一個連接埠(預設 5194)**、`reuseExistingServer: false`(不可能撿到別人開著、連正式庫的
//      5183 伺服器),並用環境變數 VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY 改連本機
//      (Vite 規則:已經存在的環境變數優先於 `.env`;不建 `.env.local`、不改 `.env`)。
//   ③ Node 端(fixture)全域 fetch 只准打本機;瀏覽器端 Chromium 的 DNS 規則讓 localhost/127.0.0.1
//      以外的網域全部解析失敗;spec 另外斷言打到 supabase.co 的請求 = 0。
//   ④ 同時把 process.env 的 VITE_SUPABASE_* 換成本機值 ⇒ e2e/support 既有 fixture(env-file.ts 先看
//      process.env)萬一被 e2e-local 引用,也只會連本機(保險用;目前 e2e-local 只用自己的 fixture)。
//
// 收錄範圍:**只有 e2e-local/ 底下的 spec**(紅利 e2e:bonus-refactor、member-points-settings)。
// e2e-local/ 不在預設 config 的 testDir 裡 ⇒ 預設的 `npm run test:e2e`(連正式庫)永遠收不到它們,
// 也不影響 e2e/test-count-baseline.json 的基準(批次 8 收尾後回到 123 條 / 22 檔)。
// e2e/members.spec.ts 不收:批次 8 本機實跑時第一條就卡在 `getByLabel("姓名 *")`(ui-v1-full 改版後的舊
// 選擇器,屬於 SPECS-INDEX #849 的範圍)。
import { execSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

import {
  installLoopbackOnlyFetchGuard,
  loadLocalSupabaseTargetIntoEnv,
} from "./e2e-local/support/local-target";

const projectRoot = dirname(fileURLToPath(import.meta.url));
// 預設 5194(避開 5183 預設 e2e 與 QA 實測常用的 5184~5186);被占用時 strictPort 直接失敗,
// 可用 E2E_LOCAL_PORT 換一個。
const LOCAL_PORT = Number(process.env["E2E_LOCAL_PORT"] ?? 5194);

// config 會在主程序與每個 worker 各載入一次;主程序取到的值透過環境變數傳給 worker,worker 不再呼叫 CLI。
// (第 6 批 #849:這段收進 local-target.ts 的 loadLocalSupabaseTargetIntoEnv,預設 config 的本機模式共用。)
const { url: localUrl, publishableKey: localPublishableKey } = loadLocalSupabaseTargetIntoEnv(() =>
  execSync("npx supabase status -o env", {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }),
);

// ④ 既有 fixture(e2e/support/env-file.ts 先看 process.env)也改讀本機值。
process.env["VITE_SUPABASE_URL"] = localUrl;
process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] = localPublishableKey;
// 本機模式不登入超級管理員帳號(那組帳密只存在正式庫)。
delete process.env["E2E_PLATFORM_ADMIN_EMAIL"];
delete process.env["E2E_PLATFORM_ADMIN_PASSWORD"];

// ③ Node 端:只准打本機。
installLoopbackOnlyFetchGuard();

export default defineConfig({
  testDir: "./e2e-local",
  testMatch: "**/*.spec.ts",
  // 同一個本機資料庫,紅利測試彼此獨立建商家,但開發伺服器只有一台 ⇒ 不平行,結果比較好判讀。
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  timeout: 90_000,
  outputDir: "test-results/local",
  use: {
    baseURL: `http://localhost:${LOCAL_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --port ${LOCAL_PORT} --strictPort`,
    url: `http://localhost:${LOCAL_PORT}`,
    // 🔴 不撿既有伺服器:撿到的可能是連正式庫的那一台。連接埠被占用 ⇒ strictPort 直接失敗。
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_SUPABASE_URL: localUrl,
      VITE_SUPABASE_PUBLISHABLE_KEY: localPublishableKey,
    },
  },
  projects: [
    {
      name: "chromium-local",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          // ③ 瀏覽器端:localhost / 127.0.0.1 以外的網域一律解析失敗(含 *.supabase.co)。
          args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"],
        },
      },
    },
  ],
});
