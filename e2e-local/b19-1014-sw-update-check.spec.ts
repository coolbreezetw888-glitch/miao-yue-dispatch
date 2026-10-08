// SPECS-INDEX #1014(第 19 批):手機下拉重新整理 / App 切回前景時,也要主動檢查一次新版本。
// 規格:.project/specs/下拉刷新檢查新版本-第19批.md(驗收重點第 3 點)。
//
// 用「真的 build 出來的產物 + 真的 Chromium service worker」模擬「新版本上線」(沿用 src/pwaUpdate.ts
// 註解提到的 2026-09-20「build 兩版」實測做法的等效版本):
//   1. vite build 一次到暫存資料夾,用一個極簡靜態伺服器提供(不碰 dist/、不碰任何資料庫)。
//   2. 開首頁、等第一版 service worker 接管頁面(controller 存在)。
//   3. 把 sw.js 內容改掉一個位元組(瀏覽器逐位元組比對 sw.js ⇒ 視為「第二版上線」)。
//   4. 確認「什麼都不做」時不會自己偵測到(證明下面偵測到是因為切回前景,不是瀏覽器自己檢查)。
//   5. 模擬 App 從背景切回前景(visibilitychange → visible)⇒ 新版本被偵測到(registration.waiting 出現)。
//   6. 沒有自動套用、沒有自動重新整理(waiting 還在、頁面上的記號沒被 reload 清掉)。
//   7. 30 秒內再切一次 ⇒ 不再向伺服器要 sw.js(節流)。
//
// 為什麼只驗「切回前景」:首頁(未登入)沒有掛 PullToRefresh 與 UpdateAvailableHint(兩者都在 /app 外殼);
// 下拉刷新呼叫的是同一個 checkForServiceWorkerUpdate(),接線與「偵測到 ⇒ 通知提示卡」的部分由
// src/components/PullToRefresh.test.tsx、src/pwaUpdate.test.ts、src/components/UpdateAvailableHint.test.tsx 覆蓋。
// 這支不需要登入、不建任何測試資料。
//
// 執行(只跑這一支;E2E_LOCAL_PORT 換一個連接埠可避免跟別的 e2e-local 同時跑時撞埠):
//   npx playwright test --config playwright.local.config.ts b19-1014-sw-update-check

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".html": "text/html",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

let outDir = "";
let server: Server;
let origin = "";
let swRequests = 0;

test.describe.configure({ mode: "serial", timeout: 240_000 });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  outDir = mkdtempSync(join(tmpdir(), "miaoyue-b19-1014-"));
  execSync(`npx vite build --outDir "${outDir}" --emptyOutDir`, {
    cwd: projectRoot,
    stdio: "ignore",
  });
  server = createServer((req, res) => {
    const pathname = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    if (pathname === "/sw.js") swRequests++;
    let file = join(outDir, pathname);
    if (!file.startsWith(outDir) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(outDir, "index.html");
    }
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

async function setVisibility(page: Page, state: "visible" | "hidden") {
  await page.evaluate((st) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => st });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

const hasWaiting = (page: Page) =>
  page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r && !!r.waiting));

test("#1014 新版本上線後,App 切回前景就偵測到(不自動套用),30 秒內不重複檢查", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const swPath = join(outDir, "sw.js");
  const original = readFileSync(swPath, "utf-8");
  try {
    // 第一版接管頁面。
    await page.goto(`${origin}/`);
    await page.waitForFunction(
      () => navigator.serviceWorker.getRegistration().then((r) => !!r && !!r.active),
      null,
      { timeout: 30_000 },
    );
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {
      timeout: 30_000,
    });
    // Chromium 導覽後會延遲幾秒自己檢查一次 sw.js;等它做完,避免跟下面混在一起。
    await page.waitForTimeout(8_000);

    // 「第二版上線」。
    writeFileSync(swPath, `${original}\n// b19-1014 v2 ${Date.now()}\n`);
    const before = swRequests;
    await page.waitForTimeout(4_000);
    expect(swRequests - before, "什麼都不做時不該自己去檢查").toBe(0);
    expect(await hasWaiting(page)).toBe(false);

    // 頁面上做個記號:如果被自動 reload,記號會消失。
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>)["__b19Marker"] = 1;
    });

    // App 切到背景再切回前景。
    await setVisibility(page, "hidden");
    await setVisibility(page, "visible");
    await expect.poll(() => hasWaiting(page), { timeout: 20_000 }).toBe(true);
    expect(swRequests - before).toBe(1);

    // 不自動套用、不自動重新整理。
    await page.waitForTimeout(2_000);
    expect(await hasWaiting(page)).toBe(true);
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>)["__b19Marker"]),
    ).toBe(1);

    // 30 秒內再切一次 ⇒ 節流,不再要 sw.js。
    const afterFirst = swRequests;
    await setVisibility(page, "hidden");
    await setVisibility(page, "visible");
    await page.waitForTimeout(2_000);
    expect(swRequests - afterFirst).toBe(0);
  } finally {
    writeFileSync(swPath, original);
    await context.close();
  }
});
