// SPECS-INDEX #1025 功能開關 第 1 批 FG1-T04(本機 e2e)。
// 規格書:.project/specs/功能開關.md(第 2 版)FG1-T04。fixture 見 support/req1025-fixture.ts。
// **只在本機跑**:`npx playwright test --config playwright.local.config.ts req1025-feature-flags`
// 截圖:E2E_SHOT_DIR(預設 test-results/req1025-shots)。
//
//   ① 超級管理員關掉「資料匯入」(關閉確認小卡窗 + 備註)⇒ 那間店管理員的功能頁看不到「資料匯入」卡;
//      直接打 /app/data-import、/app/data-import/history ⇒ 回到 /app/manage;超級管理員打開 ⇒ 恢復
//   ② 超級管理員關掉「客戶線上預約」⇒ 匿名打開 /booking/<slug> 看到「這間店目前暫停線上預約」;
//      管理員的「商家設定」看不到預約網址;功能頁的「預約網址」卡也看不到;打開 ⇒ 恢復
//   ③ 截圖 1280 / 375:功能開關頁、商家詳情功能開關卡、關閉確認小卡窗(375 不可橫向捲動)
import { expect, test, type Browser, type Page } from "@playwright/test";

import { injectSession } from "./support/c1-public-booking-fixture";
import {
  readGrant,
  setupReq1025Fixture,
  teardownReq1025Fixture,
  type Req1025Fixture,
} from "./support/req1025-fixture";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";

const LOAD_TIMEOUT = 20_000;
const SHOT_DIR = process.env["E2E_SHOT_DIR"] ?? "test-results/req1025-shots";

test.use({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "default", timeout: 150_000 });

let fixture: Req1025Fixture;
let setupFailed = false;
let recorders: RequestRecorder[] = [];

test.beforeAll(async () => {
  test.setTimeout(120_000);
  try {
    fixture = await setupReq1025Fixture();
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  if (setupFailed || !fixture) return;
  const actions = await teardownReq1025Fixture(fixture);
  console.log("[req1025 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(() => {
  recorders = [];
});
test.afterEach(() => {
  expect(recorders.length, "前提:這條測試至少開過一個頁面").toBeGreaterThan(0);
  for (const r of recorders) expectOnlyLocalRequests(r);
});

function track(page: Page): void {
  recorders.push(recordRequestHosts(page));
}

async function openAs(browser: Browser, who: "admin" | "platform" | "anon"): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    timezoneId: "Asia/Taipei",
  });
  const page = await context.newPage();
  track(page);
  if (who !== "anon") {
    await injectSession(page, who === "admin" ? fixture.admin.session : fixture.platform.session);
  }
  return page;
}

async function expectNoHorizontalScroll(page: Page, label: string): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${label}:375 寬不可以有橫向捲動`).toBeLessThanOrEqual(clientWidth);
}

async function shotBoth(page: Page, name: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${SHOT_DIR}/${name}_1280.png`, fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(page, name);
  await page.screenshot({ path: `${SHOT_DIR}/${name}_375.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** 超級管理員在商家詳情頁把某個功能關掉(走關閉確認小卡窗)。 */
async function platformTurnOff(page: Page, featureKey: string, note: string, shotName?: string) {
  await page.goto(`/platform-admin/merchants/${fixture.merchantId}`);
  const sw = page.getByTestId(`merchant-feature-switch-${featureKey}`);
  await expect(sw).toHaveAttribute("data-state", "checked", { timeout: LOAD_TIMEOUT });
  const dialog = page.getByTestId("merchant-feature-close-dialog");
  if (shotName) {
    // 小卡窗開著時改視窗寬度,電腦版的「對齊內容欄」會停在舊寬度 ⇒ 每個寬度都重新打開一次再截圖。
    for (const [width, height] of [
      [375, 812],
      [1280, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      await sw.click();
      await expect(dialog).toBeVisible();
      await dialog.getByPlaceholder("例如：試用到期").fill(note);
      await page.waitForTimeout(300);
      if (width === 375) await expectNoHorizontalScroll(page, shotName);
      await page.screenshot({ path: `${SHOT_DIR}/${shotName}_${width}.png` });
      await dialog.getByRole("button", { name: "取消" }).click();
      await expect(dialog).toBeHidden();
      await expect(sw).toHaveAttribute("data-state", "checked");
    }
  }
  await sw.click();
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("例如：試用到期").fill(note);
  await dialog.getByTestId("merchant-feature-close-confirm").click();
  await expect(dialog).toBeHidden({ timeout: LOAD_TIMEOUT });
  await expect(sw).toHaveAttribute("data-state", "unchecked", { timeout: LOAD_TIMEOUT });
  await expect.poll(() => readGrant(fixture, featureKey)).toBe(false);
}

/** 超級管理員在商家詳情頁把某個功能打開(直接存)。 */
async function platformTurnOn(page: Page, featureKey: string) {
  await page.goto(`/platform-admin/merchants/${fixture.merchantId}`);
  const sw = page.getByTestId(`merchant-feature-switch-${featureKey}`);
  await expect(sw).toHaveAttribute("data-state", "unchecked", { timeout: LOAD_TIMEOUT });
  await sw.click();
  await expect(sw).toHaveAttribute("data-state", "checked", { timeout: LOAD_TIMEOUT });
  await expect.poll(() => readGrant(fixture, featureKey)).toBe(true);
}

/** 打開功能頁,等到功能開關讀完(用一張「一定開著」的功能卡當錨點)。 */
async function openManageAndWait(page: Page, anchorText: string) {
  await page.goto("/app/manage");
  await expect(page.getByTestId("manage-page")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText(anchorText, { exact: true }).first()).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
}

test("① 關掉「資料匯入」⇒ 管理員看不到卡、直接打網址導回功能頁;打開 ⇒ 恢復", async ({
  browser,
}) => {
  const platform = await openAs(browser, "platform");
  await platformTurnOff(platform, "data_import", "試用到期", "20_close_dialog");

  // 最近變更紀錄看得到這一筆
  await platform.getByTestId("merchant-feature-logs-toggle").click();
  await expect(platform.getByTestId("merchant-feature-logs")).toContainText("資料匯入", {
    timeout: LOAD_TIMEOUT,
  });
  await expect(platform.getByTestId("merchant-feature-logs")).toContainText("備註：試用到期");
  await expect(platform.getByTestId("merchant-feature-differs-data_import")).toBeVisible();
  const card = platform.getByTestId("merchant-feature-grants-card");
  await card.scrollIntoViewIfNeeded();
  await shotBoth(platform, "10_merchant_detail_card");

  const admin = await openAs(browser, "admin");
  // 「預約網址」卡只在功能讀完、而且線上預約開著時才出現 ⇒ 當作「功能開關已讀完」的錨點。
  await openManageAndWait(admin, "預約網址");
  await expect(admin.getByText("報表匯出中心", { exact: true })).toBeVisible();
  await expect(admin.getByText("資料匯入", { exact: true })).toHaveCount(0);

  await admin.goto("/app/data-import");
  await expect(admin).toHaveURL(/\/app\/manage$/, { timeout: LOAD_TIMEOUT });
  await expect(admin.getByText("資料匯入", { exact: true })).toHaveCount(0);
  await admin.goto("/app/data-import/history");
  await expect(admin).toHaveURL(/\/app\/manage$/, { timeout: LOAD_TIMEOUT });
  await expect(admin.locator("body")).not.toContainText("尚未開通");

  await platformTurnOn(platform, "data_import");
  await openManageAndWait(admin, "預約網址");
  await expect(admin.getByText("資料匯入", { exact: true })).toBeVisible();
  await admin.goto("/app/data-import");
  await expect(admin).toHaveURL(/\/app\/data-import$/);
  await admin.waitForTimeout(500);
  await expect(admin).toHaveURL(/\/app\/data-import$/);
});

test("② 關掉「客戶線上預約」⇒ 預約頁暫停、商家設定與功能頁看不到預約網址;打開 ⇒ 恢復", async ({
  browser,
}) => {
  const platform = await openAs(browser, "platform");
  await platformTurnOff(platform, "online_booking", "先藏起來");

  const anon = await openAs(browser, "anon");
  await anon.goto(`/booking/${fixture.slug}`);
  await expect(anon.getByText("這間店目前暫停線上預約")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(anon.locator("body")).not.toContainText("尚未開通");

  const admin = await openAs(browser, "admin");
  const featuresLoaded = admin.waitForResponse((r) =>
    r.url().includes("/rpc/get_merchant_features"),
  );
  await admin.goto("/app/settings");
  await featuresLoaded;
  await expect(admin.getByText("基本資料", { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(admin.getByText(fixture.slug, { exact: true })).toHaveCount(0);
  await expect(admin.getByText("預約網址", { exact: true })).toHaveCount(0);

  await openManageAndWait(admin, "報表匯出中心");
  await expect(admin.getByText("預約網址", { exact: true })).toHaveCount(0);
  await expect(admin.getByTestId("booking-url-open")).toHaveCount(0);

  await platformTurnOn(platform, "online_booking");
  await anon.goto(`/booking/${fixture.slug}`);
  await expect(anon.getByText(fixture.merchantName).first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(anon.getByText("這間店目前暫停線上預約")).toHaveCount(0);
  await admin.goto("/app/settings");
  await expect(admin.getByText(fixture.slug, { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
});

test("③ 功能開關頁:標題、功能 × 兩產業開關、沒有新增 / 刪除;截圖 1280 / 375", async ({
  browser,
}) => {
  const platform = await openAs(browser, "platform");
  await platform.goto("/platform-admin/industry-presets");
  await expect(platform.getByRole("heading", { name: "功能開關" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(platform.getByRole("link", { name: "功能開關" })).toBeVisible();
  for (const key of ["online_booking", "data_import", "report_export"]) {
    await expect(platform.getByTestId(`feature-preset-row-${key}`)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    await expect(
      platform.getByTestId(`feature-preset-switch-on_site_dispatch-${key}`),
    ).toHaveAttribute("data-state", "checked");
    await expect(
      platform.getByTestId(`feature-preset-switch-in_store_beauty-${key}`),
    ).toHaveAttribute("data-state", "checked");
  }
  await expect(platform.getByRole("button", { name: /新增|刪除/ })).toHaveCount(0);
  await expect(platform.locator("body")).not.toContainText(/產業預設功能組合|方案|價格|加購/);
  await shotBoth(platform, "00_feature_presets_page");
});
