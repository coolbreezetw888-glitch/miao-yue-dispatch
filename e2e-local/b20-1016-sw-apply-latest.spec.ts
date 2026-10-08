// SPECS-INDEX #1016(第 20 批):「立即更新」按一次就到最新版。
// 規格:.project/specs/列表卡片按鈕外露-第20批.md 的「#1016」段落(驗收:build 三版模擬)。
//
// 用「真的 build 出來的產物 + 真的 Chromium service worker」模擬版本上線(沿用 b19-1014 的做法):
//   ・vite build 一次到暫存資料夾(os.tmpdir(),跑的時候可用 TMP/TEMP 指到 scratchpad),
//     用極簡靜態伺服器提供;sw.js 由伺服器在原檔尾端加一小段「回報我是第幾版」的程式碼,
//     改這段文字 ⇒ 瀏覽器逐位元組比對 sw.js ⇒ 視為「新版本上線」。不碰 dist/。
//   ・建置時 VITE_SUPABASE_* 已經被 playwright.local.config.ts 換成本機 Supabase ⇒ 登入、讀資料只打本機。
//   ・用 permission-batch3-fixture 建一個本機測試商家,以管理員身分進 /app(提示卡掛在 AppLayout)。
//
//   1. 三版模擬:v1 接管 → 切回前景偵測到 v2(提示卡出現)→ 伺服器又上線 v3 → 按一次「立即更新」
//      ⇒ 重新整理後由 v3 接管;再等一段時間(含瀏覽器導覽後自己的檢查)提示卡不再跳、沒有 waiting。
//   2. 離線:v1 接管 → 偵測到 v2 → 斷網 → 按「立即更新」⇒ 仍然套用 v2(不卡在「更新中⋯」);
//      恢復網路後重新進站由 v2 接管。
//   3. 沒按就不套用:偵測到 v2 之後什麼都不按 ⇒ 不會自己重新整理、v2 一直停在 waiting。
//
// 執行(只跑這一支):
//   E2E_LOCAL_PORT=5302 npx playwright test --config playwright.local.config.ts b20-1016-sw-apply-latest

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  injectSession,
  setupBatch3Fixture,
  teardownBatch3Fixture,
  type Batch3Fixture,
} from "./support/permission-batch3-fixture";

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

const VERSION_MESSAGE = "B20_1016_VERSION";

let outDir = "";
let server: Server;
let origin = "";
let originalSw = "";
/** 伺服器目前「上線」的版本。 */
let liveVersion = "v1";
/** true = 伺服器整個不回應(模擬斷網)。 */
let serverDown = false;
let swRequests = 0;
let fixture: Batch3Fixture;

function swSource(version: string): string {
  // 尾端加一段:收到 { type: B20_1016_VERSION } 就用 MessageChannel 回報自己的版本。
  return `${originalSw}\n;self.addEventListener("message",function(e){if(e.data&&e.data.type===${JSON.stringify(
    VERSION_MESSAGE,
  )}&&e.ports&&e.ports[0]){e.ports[0].postMessage(${JSON.stringify(version)});}});\n`;
}

test.describe.configure({ mode: "serial", timeout: 300_000 });

test.beforeAll(async () => {
  test.setTimeout(300_000);
  outDir = mkdtempSync(join(tmpdir(), "miaoyue-b20-1016-"));
  execSync(`npx vite build --outDir "${outDir}" --emptyOutDir`, {
    cwd: projectRoot,
    stdio: "ignore",
  });
  originalSw = readFileSync(join(outDir, "sw.js"), "utf-8");
  server = createServer((req, res) => {
    if (serverDown) {
      req.socket.destroy();
      return;
    }
    const pathname = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    if (pathname === "/sw.js") {
      swRequests++;
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-cache" });
      res.end(swSource(liveVersion));
      return;
    }
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
  fixture = await setupBatch3Fixture();
});

test.afterAll(async () => {
  if (fixture) await teardownBatch3Fixture(fixture);
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  liveVersion = "v1";
  serverDown = false;
});

async function setVisibility(page: Page, state: "visible" | "hidden") {
  await page.evaluate((st) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => st });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

/** 問「目前接管這個分頁」的 service worker 是第幾版;沒有 controller 回 null。 */
const controllerVersion = (page: Page) =>
  page.evaluate(
    (type) =>
      new Promise<string | null>((resolveVersion) => {
        const controller = navigator.serviceWorker.controller;
        if (!controller) return resolveVersion(null);
        const channel = new MessageChannel();
        channel.port1.onmessage = (e) => resolveVersion(String(e.data));
        controller.postMessage({ type }, [channel.port2]);
        setTimeout(() => resolveVersion("no-answer"), 3_000);
      }),
    VERSION_MESSAGE,
  );

const hasWaiting = (page: Page) =>
  page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r && !!r.waiting));

const markerStillThere = (page: Page) =>
  page
    .evaluate(() => (window as unknown as Record<string, unknown>)["__b20Marker"] === 1)
    .catch(() => false);

/** 開 /app(管理員),等 v1 接管,再等瀏覽器導覽後自己的那次檢查做完。 */
async function openWithV1(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await injectSession(page, fixture.adminSession);
  await page.goto(`${origin}/app`);
  await page.waitForFunction(
    () => navigator.serviceWorker.getRegistration().then((r) => !!r && !!r.active),
    null,
    { timeout: 30_000 },
  );
  // 第一次重新進站有時還沒被接管(2026-10-08 實測:剛 activated 後的第一次導覽偶爾沒有 controller),
  // 最多重新進站 5 次直到 v1 接管。
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.goto(`${origin}/app`);
    const controlled = await page
      .waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (controlled) break;
  }
  expect(await controllerVersion(page)).toBe("v1");
  // Chromium 導覽後會延遲幾秒自己檢查一次 sw.js;等它做完,避免跟下面混在一起。
  await page.waitForTimeout(8_000);
  return page;
}

/** 伺服器上線 v2,模擬切回前景 ⇒ 偵測到 v2,提示卡出現。 */
async function detectV2(page: Page) {
  liveVersion = "v2";
  await setVisibility(page, "hidden");
  await setVisibility(page, "visible");
  await expect.poll(() => hasWaiting(page), { timeout: 20_000 }).toBe(true);
  await expect(page.getByTestId("update-available-card")).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>)["__b20Marker"] = 1;
  });
}

test("#1016 偵測到 v2 之後又上線 v3 ⇒ 按一次「立即更新」直接到 v3,提示卡不再跳", async ({
  browser,
}) => {
  const page = await openWithV1(browser);
  try {
    await detectV2(page);

    // 伺服器又上線 v3(此時分頁手上只有「早先偵測到的 v2」)。
    liveVersion = "v3";
    const before = swRequests;
    const startedAt = Date.now();
    await page.getByRole("button", { name: "立即更新", exact: true }).click();

    // 按下後 ⇒ 重新整理(記號消失)⇒ 由 v3 接管。
    await expect.poll(() => markerStillThere(page), { timeout: 30_000 }).toBe(false);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {
      timeout: 30_000,
    });
    expect(await controllerVersion(page)).toBe("v3");
    expect(swRequests - before, "按下時有向伺服器問最新版").toBeGreaterThanOrEqual(1);
    console.log(`[b20-1016] v2→v3 按一次到 v3,耗時 ${Date.now() - startedAt} ms`);

    // 重新整理之後再等一段時間(含瀏覽器導覽後自己的檢查)⇒ 沒有新的 waiting、提示卡不再跳。
    await page.waitForTimeout(10_000);
    expect(await hasWaiting(page)).toBe(false);
    await expect(page.getByTestId("update-available-card")).toHaveCount(0);
    expect(await controllerVersion(page)).toBe("v3");
  } finally {
    await page.context().close();
  }
});

test("#1016 離線時按「立即更新」⇒ 仍然套用早先下載好的 v2,不卡住", async ({ browser }) => {
  const page = await openWithV1(browser);
  const context = page.context();
  try {
    await detectV2(page);

    // 斷網:瀏覽器離線 + 伺服器也不回應(雙保險,確保 update() 一定問不到)。
    await context.setOffline(true);
    serverDown = true;
    const startedAt = Date.now();
    await page.getByRole("button", { name: "立即更新", exact: true }).click();

    // 套用 v2 ⇒ controllerchange ⇒ 重新整理(離線時重新整理會落在瀏覽器的離線錯誤頁,記號一樣會消失)。
    await expect.poll(() => markerStillThere(page), { timeout: 30_000 }).toBe(false);
    const elapsed = Date.now() - startedAt;
    console.log(`[b20-1016] 離線套用 v2 耗時 ${elapsed} ms`);
    expect(elapsed, "離線時最多等檢查逾時(約 5 秒)就套用").toBeLessThan(15_000);

    // 恢復網路(伺服器仍是 v2)⇒ 重新進站,由 v2 接管、沒有 waiting、提示卡不跳。
    serverDown = false;
    await context.setOffline(false);
    await page.goto(`${origin}/app`);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {
      timeout: 30_000,
    });
    expect(await controllerVersion(page)).toBe("v2");
    await page.waitForTimeout(8_000);
    expect(await hasWaiting(page)).toBe(false);
    await expect(page.getByTestId("update-available-card")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("#1016 沒按「立即更新」⇒ 不會自己套用、不會自己重新整理", async ({ browser }) => {
  const page = await openWithV1(browser);
  try {
    await detectV2(page);
    liveVersion = "v3";
    await page.waitForTimeout(6_000);
    expect(await markerStillThere(page)).toBe(true);
    expect(await controllerVersion(page)).toBe("v1");
    expect(await hasWaiting(page)).toBe(true);
    await expect(page.getByRole("button", { name: "立即更新", exact: true })).toBeEnabled();
  } finally {
    await page.context().close();
  }
});
