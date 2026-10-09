// SPECS-INDEX #1025 功能開關 第 1 批 FG1-T04(本機 e2e)。
// 規格書:.project/specs/功能開關.md(第 2 版)FG1-T04。fixture 見 support/req1025-fixture.ts。
// **只在本機跑**:`npx playwright test --config playwright.local.config.ts req1025-feature-flags`
// 截圖:E2E_SHOT_DIR(預設 test-results/req1025-shots)。
//
//   ① 超級管理員關掉「資料匯入」(關閉確認小卡窗 + 備註)⇒ 那間店管理員的功能頁看不到「資料匯入」卡;
//      直接打 /app/data-import、/app/data-import/history ⇒ 回到 /app/manage;超級管理員打開 ⇒ 恢復
//   ② 超級管理員關掉「客戶線上預約」⇒ 匿名打開 /booking/<slug> 看到「這間店目前暫停線上預約」;
//      管理員的「商家設定」看不到預約網址;功能頁的「預約網址」卡也看不到;打開 ⇒ 恢復
//   ③ 功能開關頁:新開商家預設 + 已開好的商家統計 + 全部開啟／關閉(⚠️5);第三輪「先調整、按儲存才生效」、
//      未儲存離開提醒;截圖 1280 / 375:功能開關頁、批次確認小卡窗、商家詳情功能開關卡、儲存確認小卡窗
//   ④ (FG-3)關掉「服務人員登入端」⇒ 服務人員登入只看到一句話 + 登出、其他網址導回 /app;
//      管理員的服務人員管理看不到邀請登入 / 服務人員權限;打開 ⇒ 恢復
//   ⑤ (FG-3)只關「服務人員查看自己的抽成薪資」⇒ 薪資報表分頁籤不見、網址導回 /app;其他照常
//   (第三輪 ③:商家詳情卡改成先切開關、按「儲存」⇒ 確認小卡窗 + 備註 ⇒ 才生效)
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

async function openAs(
  browser: Browser,
  who: "admin" | "platform" | "staff" | "anon",
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    timezoneId: "Asia/Taipei",
  });
  const page = await context.newPage();
  track(page);
  if (who !== "anon") {
    await injectSession(page, fixture[who].session);
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

/**
 * 超級管理員在商家詳情頁調整功能開關(第三輪 ③:先切開關、按「儲存」⇒ 小卡窗(可填備註)⇒ 確認才生效)。
 * changes 依序切(主功能寫在細部功能前面);shotName 有給時,儲存小卡窗在 375 / 1280 各截一張。
 */
async function platformSetFeatures(
  page: Page,
  changes: Record<string, boolean>,
  note: string | null,
  shotName?: string,
) {
  await page.goto(`/platform-admin/merchants/${fixture.merchantId}`);
  const before: Record<string, boolean | null> = {};
  for (const [key, enabled] of Object.entries(changes)) {
    const sw = page.getByTestId(`merchant-feature-switch-${key}`);
    await expect(sw).toHaveAttribute("data-state", enabled ? "unchecked" : "checked", {
      timeout: LOAD_TIMEOUT,
    });
    before[key] = await readGrant(fixture, key);
    await sw.click();
    await expect(sw).toHaveAttribute("data-state", enabled ? "checked" : "unchecked");
  }
  await expect(page.getByTestId("merchant-feature-unsaved")).toBeVisible();
  // 還沒按儲存 ⇒ 資料庫一個值都沒變。
  for (const key of Object.keys(changes)) expect(await readGrant(fixture, key)).toBe(before[key]);

  const dialog = page.getByTestId("merchant-feature-save-dialog");
  if (shotName) {
    // 小卡窗開著時改視窗寬度,電腦版的「對齊內容欄」會停在舊寬度 ⇒ 每個寬度都重新打開一次再截圖。
    for (const [width, height] of [
      [375, 812],
      [1280, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.getByTestId("merchant-feature-save").click();
      await expect(dialog).toBeVisible();
      if (note) await dialog.getByPlaceholder("例如：試用到期").fill(note);
      await page.waitForTimeout(300);
      if (width === 375) await expectNoHorizontalScroll(page, shotName);
      await page.screenshot({ path: `${SHOT_DIR}/${shotName}_${width}.png` });
      await dialog.getByRole("button", { name: "取消" }).click();
      await expect(dialog).toBeHidden();
    }
  }
  await page.getByTestId("merchant-feature-save").click();
  await expect(dialog).toBeVisible();
  if (note) await dialog.getByPlaceholder("例如：試用到期").fill(note);
  await dialog.getByTestId("merchant-feature-save-confirm").click();
  await expect(dialog).toBeHidden({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("merchant-feature-unsaved")).toBeHidden({ timeout: LOAD_TIMEOUT });
  for (const [key, enabled] of Object.entries(changes)) {
    await expect.poll(() => readGrant(fixture, key)).toBe(enabled);
  }
}

async function platformTurnOff(page: Page, featureKey: string, note: string, shotName?: string) {
  await platformSetFeatures(page, { [featureKey]: false }, note, shotName);
}

async function platformTurnOn(page: Page, featureKey: string) {
  await platformSetFeatures(page, { [featureKey]: true }, null);
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

test("③ 功能開關頁:新開商家預設 + 已開好的商家統計 + 全部開啟／關閉;先調整、按儲存才生效;截圖 1280 / 375", async ({
  browser,
}) => {
  const platform = await openAs(browser, "platform");
  await platform.goto("/platform-admin/industry-presets");
  await expect(platform.getByRole("heading", { name: "功能開關" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(platform.getByRole("link", { name: "功能開關" })).toBeVisible();
  await expect(platform.getByTestId("feature-presets-intro")).toContainText(
    "這裡可以一次調整所有商家，也可以設定新開商家的預設",
  );
  for (const key of [
    "online_booking",
    "data_import",
    "report_export",
    "staff_portal",
    "staff_order_editing",
    "staff_self_availability",
    "staff_self_payroll",
  ]) {
    await expect(platform.getByTestId(`feature-preset-row-${key}`)).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    await expect(
      platform.getByTestId(`feature-preset-switch-on_site_dispatch-${key}`),
    ).toHaveAttribute("data-state", "checked");
    await expect(
      platform.getByTestId(`feature-preset-switch-in_store_beauty-${key}`),
    ).toHaveAttribute("data-state", "checked");
    await expect(platform.getByTestId(`feature-usage-${key}`)).toContainText(
      /已開好的商家：目前 \d+ 間開、\d+ 間關/,
      { timeout: LOAD_TIMEOUT },
    );
  }
  // 細部功能縮排在主功能底下(緊接在後)。
  const rowIds = await platform
    .locator('[data-testid^="feature-preset-row-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(rowIds.indexOf("feature-preset-row-staff_order_editing")).toBe(
    rowIds.indexOf("feature-preset-row-staff_portal") + 1,
  );
  await expect(platform.getByRole("button", { name: /^(新增|刪除)/ })).toHaveCount(0);
  await expect(platform.locator("body")).not.toContainText(/產業預設功能組合|方案|價格|加購/);
  await shotBoth(platform, "00_feature_presets_page");

  // 「全部關閉」只排進草稿,按「儲存」先跳確認窗(寫會影響幾間);這裡只截圖、按取消、放棄變更 ⇒ 資料庫完全沒變
  // (本機資料庫還有其他測試的商家,不真的對全部商家送出)。
  await platform.getByTestId("feature-bulk-off-data_import").click();
  await expect(platform.getByTestId("feature-bulk-staged-data_import")).toHaveText(
    "儲存後全部關閉",
  );
  await expect(platform.getByTestId("feature-presets-unsaved")).toBeVisible();
  // 未儲存就點導覽 ⇒ 先問
  await platform.getByRole("link", { name: "集團與商家" }).click();
  const leave = platform.getByTestId("feature-leave-guard");
  await expect(leave).toContainText("確定放棄這次的變更？");
  await leave.getByRole("button", { name: "繼續調整" }).click();
  await expect(platform).toHaveURL(/\/platform-admin\/industry-presets$/);
  const confirm = platform.getByTestId("feature-presets-confirm");
  for (const [width, height] of [
    [375, 812],
    [1280, 900],
  ] as const) {
    await platform.setViewportSize({ width, height });
    await platform.getByTestId("feature-presets-save").click();
    await expect(confirm).toContainText(/會影響 \d+ 間商家，其中 \d+ 間目前是開的。/);
    await platform.waitForTimeout(300);
    if (width === 375) await expectNoHorizontalScroll(platform, "01_bulk_confirm");
    await platform.screenshot({ path: `${SHOT_DIR}/01_bulk_confirm_${width}.png` });
    await confirm.getByRole("button", { name: "取消" }).click();
    await expect(confirm).toBeHidden();
  }
  await platform.getByRole("button", { name: "放棄變更" }).click();
  await expect(platform.getByTestId("feature-presets-unsaved")).toHaveCount(0);
  expect(await readGrant(fixture, "data_import")).toBe(true);
});

test("④ 關掉「服務人員登入端」⇒ 服務人員只看到一句話 + 登出;管理員看不到邀請登入 / 服務人員權限;打開 ⇒ 恢復", async ({
  browser,
}) => {
  const platform = await openAs(browser, "platform");
  await platformTurnOff(platform, "staff_portal", "先藏起來", "21_staff_portal_save_dialog");

  const staff = await openAs(browser, "staff");
  await staff.goto("/app");
  const closed = staff.getByTestId("staff-portal-closed");
  await expect(closed).toHaveText(/這間店目前沒有開放服務人員登入，請聯絡店家管理員。/, {
    timeout: LOAD_TIMEOUT,
  });
  await expect(closed).not.toContainText(/秒約|開通/);
  await expect(staff.getByRole("link", { name: "行事曆" })).toHaveCount(0);
  await shotBoth(staff, "30_staff_portal_closed");
  for (const path of ["/app/calendar", "/app/my-availability", "/app/my-payroll"]) {
    await staff.goto(path);
    await expect(staff).toHaveURL(/\/app$/, { timeout: LOAD_TIMEOUT });
    await expect(closed).toBeVisible();
  }

  const admin = await openAs(browser, "admin");
  await admin.goto("/app/staff");
  await expect(admin.getByText(fixture.staff.name).first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(admin.getByRole("link", { name: "服務人員權限" })).toHaveCount(0);
  await expect(admin.getByRole("button", { name: "邀請登入" })).toHaveCount(0);
  await admin.goto(`/app/staff/${fixture.staff.staffId}/permissions`);
  await expect(admin).toHaveURL(/\/app\/staff$/, { timeout: LOAD_TIMEOUT });

  await platformTurnOn(platform, "staff_portal");
  await staff.goto("/app");
  await expect(staff.getByText(fixture.staff.name).first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(staff.getByTestId("staff-portal-closed")).toHaveCount(0);
  await expect(staff.getByRole("link", { name: "行事曆" })).toBeVisible();
  await admin.goto("/app/staff");
  await expect(admin.getByRole("link", { name: "服務人員權限" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
});

test("⑤ 只關「服務人員查看自己的抽成薪資」⇒ 薪資報表分頁籤不見、網址導回 /app;其他照常", async ({
  browser,
}) => {
  const platform = await openAs(browser, "platform");
  await platformTurnOff(platform, "staff_self_payroll", "先藏薪資");

  const staff = await openAs(browser, "staff");
  await staff.goto("/app");
  await expect(staff.getByRole("link", { name: "休假設定" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(staff.getByRole("link", { name: "薪資報表" })).toHaveCount(0);
  await staff.goto("/app/my-payroll");
  await expect(staff).toHaveURL(/\/app$/, { timeout: LOAD_TIMEOUT });

  await platformTurnOn(platform, "staff_self_payroll");
  await staff.goto("/app");
  await expect(staff.getByRole("link", { name: "薪資報表" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
});
