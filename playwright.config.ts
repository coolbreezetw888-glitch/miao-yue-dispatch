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
import { execSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";

import { E2E_TARGET_ENV, parseE2eTarget } from "./e2e/support/e2e-target";
import {
  assertLocalBaseUrl,
  installLoopbackOnlyFetchGuard,
  loadLocalSupabaseTargetIntoEnv,
} from "./e2e-local/support/local-target";

// 👇 預設設定(沒設 E2E_TARGET 時使用)。**這一整段跟第 6 批之前一字不差**,只是從 `export default`
//    改成先存進變數,讓檔案最下面依 E2E_TARGET 決定要匯出哪一份。
const defaultConfig = defineConfig({
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
  // 🔴 SPECS-INDEX #804:除了 list,再掛一個「執行條數守門」reporter(e2e/support/test-count-gate-reporter.ts)。
  // 它在每次跑完最後多印一段核對,並在「有測試沒跑到(did not run)」或「整套跑時收錄條數 ≠
  // e2e/test-count-baseline.json 的基準」時把結果改判成 failed。
  // 為什麼需要:worker 行程當掉(#804 實際遇到 0xC0000409)時 Playwright 只會用一行黃字說 N did not run,
  // 加上 #714 那種「整套靜默歸零」——這兩種失效都**不會變紅**,只有拿「應該有幾條」對「實際跑了幾條」
  // 才抓得到。基準數字用 `npm run test:e2e:count:update` 更新(新增測試後跑一次即可),不用人腦記。
  reporter: [["list"], ["./e2e/support/test-count-gate-reporter.ts"]],
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

// ============================================================================================
// 👇 第 6 批(SPECS-INDEX #849):預設 e2e 的「本機模式」。只有設了 `E2E_TARGET=local` 才會走這段。
//
//   執行:  E2E_TARGET=local npx playwright test            (bash)
//           $env:E2E_TARGET="local"; npx playwright test     (PowerShell)
//   前提:  `npx supabase start` 已經在跑(本機 Docker 的 Supabase)。
//
// 為什麼需要:上面的預設設定會讓 fixture **寫正式庫**,所以這套測試平常不能跑。本機模式讓同一批 spec
// 改對著本機 Supabase + 本機前端跑,寫入全部落在本機 Docker,正式庫一個字都不碰。
//
// 防呆(任何一道不過 ⇒ config 載入當下 throw,一條測試都不跑;不是只印警告):
//   ① Supabase 網址與金鑰一律取自 `npx supabase status -o env`(不讀 `.env`);網址主機不是
//      127.0.0.1 / localhost / ::1、或整串含 supabase.co ⇒ 中止(local-target.ts 的 assertLocalSupabaseUrl)。
//   ② 前端 baseURL 主機不是本機 ⇒ 中止(assertLocalBaseUrl)。
//   ③ E2E_TARGET 是 "local" 以外的值 ⇒ 中止(e2e-target.ts;防打錯字被當成「沒設」而連到正式庫)。
//   ④ `.env` 在本機模式完全不讀(env-file.ts):fixture 的 VITE_SUPABASE_* 由這裡放進 process.env,
//      正式超級管理員帳密(E2E_PLATFORM_ADMIN_*)從 process.env 移除 ⇒ 需要它的測試自動 skip。
//   ⑤ Node 端 fixture 的全域 fetch 只准打本機(installLoopbackOnlyFetchGuard)。
//   ⑥ 瀏覽器端 Chromium 的 DNS 規則:localhost / 127.0.0.1 以外的網域一律解析失敗(含 *.supabase.co)。
//   ⑦ 開發伺服器用另一個連接埠(預設 5195)、`reuseExistingServer: false`(不可能撿到連正式庫的 5183)。
// ============================================================================================
function buildLocalConfig(): PlaywrightTestConfig {
  const projectRoot = dirname(fileURLToPath(import.meta.url));
  // 5183 = 預設 e2e、5194 = e2e-local;被占用時 strictPort 直接失敗,可用 E2E_DEFAULT_LOCAL_PORT 換。
  const port = Number(process.env["E2E_DEFAULT_LOCAL_PORT"] ?? 5195);
  const baseURL = assertLocalBaseUrl(`http://localhost:${port}`).origin;

  const { url: localUrl, publishableKey: localPublishableKey } = loadLocalSupabaseTargetIntoEnv(
    () =>
      execSync("npx supabase status -o env", {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
  );

  // ④ fixture(env-file.ts 先看 process.env)改讀本機值;正式超級管理員帳密不可以出現在本機模式。
  process.env["VITE_SUPABASE_URL"] = localUrl;
  process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] = localPublishableKey;
  delete process.env["E2E_PLATFORM_ADMIN_EMAIL"];
  delete process.env["E2E_PLATFORM_ADMIN_PASSWORD"];

  // ⑤ Node 端只准打本機。
  installLoopbackOnlyFetchGuard();

  return defineConfig({
    // 收錄範圍跟預設設定完全相同(同一批 spec、同一個條數守門 reporter)。
    testDir: "./e2e",
    testMatch: "**/*.spec.ts",
    fullyParallel: true,
    // 本機只有一台開發伺服器、一個 Docker 資料庫;預設 1 個 worker 讓結果好判讀,可用 E2E_LOCAL_WORKERS 調。
    workers: Number(process.env["E2E_LOCAL_WORKERS"] ?? 1),
    forbidOnly: true,
    retries: 0,
    reporter: [["list"], ["./e2e/support/test-count-gate-reporter.ts"]],
    // 逾時跟預設設定相同,不因為本機模式放寬。
    timeout: 30_000,
    outputDir: "test-results/e2e-on-local",
    use: {
      baseURL,
      trace: "retain-on-failure",
    },
    webServer: {
      command: `npm run dev -- --port ${port} --strictPort`,
      url: baseURL,
      // ⑦ 不撿既有伺服器:撿到的可能是連正式庫的那一台。
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_SUPABASE_URL: localUrl,
        VITE_SUPABASE_PUBLISHABLE_KEY: localPublishableKey,
      },
    },
    projects: [
      {
        name: "chromium",
        use: {
          ...devices["Desktop Chrome"],
          launchOptions: {
            // ⑥ 瀏覽器端:localhost / 127.0.0.1 以外的網域一律解析失敗。
            args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"],
          },
        },
      },
    ],
  });
}

export default parseE2eTarget(process.env[E2E_TARGET_ENV]) === "local"
  ? buildLocalConfig()
  : defaultConfig;
