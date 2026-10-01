// #966/#967/#968(UI 質感調整:更新提示卡片 / 底部選單 / 全站字體)的「改前 / 改後」截圖工具。
//
// 這不是驗收測試,是給使用者與 QA 看圖用的:跑在本機 Supabase(e2e-local 設定,loopback guard 生效),
// 用 staff-live-sync-fixture 建一間測試商家 + 一位已開通登入的服務人員,截:
//   ・商家端 /app/manage、/app/orders(375 / 1280)
//   ・服務人員端 /app(375)
//   ・登入頁 /signin(375)
// 「有新版本」卡片用 addInitScript 假造 navigator.serviceWorker(register() 回傳一個已經有 waiting
// worker 的 registration)觸發 —— 走的是 src/pwaUpdate.ts 正式的「載入時已有 waiting」路徑,
// 不是直接改元件 state。
//
// 執行:
//   SHOT_PREFIX=before- SHOT_DIR=before npx playwright test --config playwright.local.config.ts ui-polish-screenshots
//   SHOT_PREFIX=after-  SHOT_DIR=after  npx playwright test --config playwright.local.config.ts ui-polish-screenshots
// 截圖存到 ../.project/notes/ui-ref-2026-10-01/<SHOT_DIR>/。

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { assertNoHorizontalOverflow } from "../e2e/support/overflow-assert";
import {
  injectSession,
  setupLiveSyncFixture,
  teardownLiveSyncFixture,
  type LiveSyncFixture,
} from "./support/staff-live-sync-fixture";

const here = dirname(fileURLToPath(import.meta.url));
const PREFIX = process.env["SHOT_PREFIX"] ?? "after-";
const OUT_DIR = resolve(
  here,
  "../../.project/notes/ui-ref-2026-10-01",
  process.env["SHOT_DIR"] ?? "after",
);
const LOAD_TIMEOUT = 20_000;

// 本機設定的 --host-resolver-rules 會擋掉所有外部網域;「改前」那一版的字型是從 Google Fonts 載入的,
// 不放行就截不到真實樣子。只放行兩個字型網域(純靜態字型檔,不碰任何資料)。
test.use({
  timezoneId: "Asia/Taipei",
  launchOptions: {
    args: [
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE fonts.googleapis.com, EXCLUDE fonts.gstatic.com",
    ],
  },
});
test.describe.configure({ mode: "default", timeout: 180_000 });

let fixture: LiveSyncFixture;

test.beforeAll(async () => {
  test.setTimeout(150_000);
  mkdirSync(OUT_DIR, { recursive: true });
  fixture = await setupLiveSyncFixture();
});

test.afterAll(async () => {
  if (fixture) await teardownLiveSyncFixture(fixture);
});

/** 假造一個「載入時已經有新版本在 waiting」的 service worker 環境。 */
async function fakeWaitingServiceWorker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const noop = () => {};
    const waiting = { postMessage: noop, state: "installed", addEventListener: noop };
    const registration = {
      waiting,
      installing: null,
      active: {},
      addEventListener: noop,
      update: () => Promise.resolve(),
      pushManager: { getSubscription: () => Promise.resolve(null) },
    };
    const container = {
      controller: {},
      register: () => Promise.resolve(registration),
      ready: new Promise(noop),
      getRegistration: () => Promise.resolve(registration),
      addEventListener: noop,
      removeEventListener: noop,
    };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
  });
}

async function openPage(
  browser: Browser,
  width: number,
  height: number,
  session: LiveSyncFixture["staffA"]["session"] | null,
  withUpdate: boolean,
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    isMobile: width < 500,
    hasTouch: width < 500,
    timezoneId: "Asia/Taipei",
  });
  const page = await context.newPage();
  if (session) await injectSession(page, session);
  if (withUpdate) await fakeWaitingServiceWorker(page);
  return page;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(800);
  await page.screenshot({ path: resolve(OUT_DIR, `${PREFIX}${name}.png`) });
}

test("改前/改後截圖", async ({ browser }) => {
  const adminSession = (await fixture.m1.admin.auth.getSession()).data.session;
  expect(adminSession).not.toBeNull();

  // 商家端 375
  for (const [w, h, tag] of [
    [375, 812, "375"],
    [1280, 800, "1280"],
  ] as const) {
    const page = await openPage(browser, w, h, adminSession, true);
    await page.goto("/app/manage");
    await expect(page.getByTestId("manage-page")).toBeVisible({ timeout: LOAD_TIMEOUT });
    await shot(page, `merchant-manage-${tag}`);
    await page.goto("/app/orders");
    await expect(page.locator("nav")).toBeVisible({ timeout: LOAD_TIMEOUT });
    await shot(page, `merchant-orders-${tag}`);
    await page.context().close();
  }

  // 商家端 320(最窄寬度,確認卡片不跑版)
  {
    const page = await openPage(browser, 320, 640, adminSession, true);
    await page.goto("/app/manage");
    await expect(page.getByTestId("manage-page")).toBeVisible({ timeout: LOAD_TIMEOUT });
    await shot(page, "merchant-manage-320");
    // 卡片出現時 320px 也不可以撐出橫向捲軸。
    await expect(page.getByText("有新版本可更新")).toBeVisible();
    await assertNoHorizontalOverflow(page, "merchant-manage-320 + 新版本卡片");
    // 卡片底邊要在分頁籤列頂端之上(不蓋住分頁籤列)。
    const cardBox = await page
      .getByRole("status")
      .filter({ hasText: "有新版本可更新" })
      .boundingBox();
    const navBox = await page.locator("nav").boundingBox();
    expect(cardBox && navBox && cardBox.y + cardBox.height <= navBox.y).toBe(true);
    await page.context().close();
  }

  // 沒有新版本時的底部選單(看選單本身)
  {
    const page = await openPage(browser, 375, 812, adminSession, false);
    await page.goto("/app/manage");
    await expect(page.getByTestId("manage-page")).toBeVisible({ timeout: LOAD_TIMEOUT });
    await shot(page, "merchant-manage-375-noupdate");
    await page.locator("nav").screenshot({
      path: resolve(OUT_DIR, `${PREFIX}nav-merchant-375.png`),
    });
    await page.context().close();
  }

  // 服務人員端 375
  {
    const page = await openPage(browser, 375, 812, fixture.staffA.session, true);
    await page.goto("/app");
    await expect(page.locator("nav")).toBeVisible({ timeout: LOAD_TIMEOUT });
    await shot(page, "staff-home-375");
    await page.locator("nav").screenshot({
      path: resolve(OUT_DIR, `${PREFIX}nav-staff-375.png`),
    });
    await page.context().close();
  }

  // 登入頁 375(看字體)
  {
    const page = await openPage(browser, 375, 812, null, false);
    await page.goto("/signin");
    await shot(page, "signin-375");
    await page.context().close();
  }
});
