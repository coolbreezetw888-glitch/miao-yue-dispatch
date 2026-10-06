// 紅利系統重構 批次 8(規格書 .project/specs/紅利系統重構.md §七、§4.6~§4.11、v2.4 裁決 21/22)
// 的端對端測試。**只在本機跑**:`npm run test:e2e:local`(playwright.local.config.ts)。
//
// 為什麼放在 e2e-local/ 而不是 e2e/:預設的 playwright.config.ts 連的是正式庫,規格書規定 e2e
// 不可以在正式庫跑。e2e-local/ 不在預設 config 的 testDir 裡 ⇒ `npm run test:e2e` 永遠收不到這支。
//
// 涵蓋(同一個本機測試商家,serial 依序跑,後面的情境用到前面建出來的訂單):
//   1. 建單看到派點(會員)、改數量點數跟著變、新電話顯示「新客戶」
//   2. 折抵超額被擋;改電話立刻送出被擋(v2.4 裁決 22 ①(b)),而且資料庫沒有建出任何訂單、兩位會員餘額不變
//   3. 有折扣 ⇒ 送出時跳「兩層重疊」的人工確認小卡窗;返回修改不送出;確認送出才建單,派點 = 折扣後金額算的
//   4. 完成訂單後餘額 = 原餘額 − 折抵 + 派點(會員詳情頁看得到)
//   5. 取消訂單 ⇒ 折抵退回
//   6. 店家報表「紅利折抵金額」卡片隨紅利開關出現 / 消失
//   7. 只有「會員管理」鑰匙的客服:功能關閉時會員詳情頁看不到點數卡(正向對照:開啟時看得到)
// 設定頁「儲存後重新整理仍在」與「生日紀錄空狀態」在 e2e/member-points-settings.spec.ts(本機模式也會跑那支)。
import { expect, test, type Locator, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";
import {
  clientAs,
  getBalance,
  injectSession,
  listBookings,
  MEMBER_A_INITIAL,
  MEMBER_A_PHONE,
  MEMBER_B_INITIAL,
  MEMBER_B_PHONE,
  NEW_CUSTOMER_PHONE,
  SERVICE_ITEM_NAME,
  setPointsFeature,
  setupBonusFixture,
  teardownBonusFixture,
  type BonusFixture,
} from "./support/bonus-fixture";

const LOAD_TIMEOUT = 20_000;
const STALE_MESSAGE = "紅利點數正在重新計算,請稍候再送出";

test.describe.configure({ mode: "serial", timeout: 120_000 });

let fixture: BonusFixture;
let setupFailed = false;
/** 每條測試期間瀏覽器發出的請求主機(afterEach 斷言沒有任何一個打到 supabase.co)。 */
let recorder: RequestRecorder | null = null;

test.beforeAll(async () => {
  try {
    fixture = await setupBonusFixture();
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownBonusFixture(fixture);
  console.log("[bonus-refactor 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(async ({ page }) => {
  recorder = recordRequestHosts(page);
});

test.afterEach(async () => {
  if (recorder) expectOnlyLocalRequests(recorder);
});

async function loginAsAdmin(page: Page) {
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page);
}

async function openNewBooking(page: Page, staffIndex = 0): Promise<Locator> {
  await page.goto("/app/calendar");
  await page.getByRole("button", { name: "新增預約" }).first().click();
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "新增預約" }) });
  await expect(dialog).toBeVisible({ timeout: LOAD_TIMEOUT });
  await dialog.locator("#booking-staff").click();
  await page.getByRole("option", { name: fixture.staffNames[staffIndex] as string }).click();
  // SPECS-INDEX #979(2026-10-06):服務項目改從「選擇項目」整頁勾選、付款方式改下拉選單(只改操作步驟)。
  await dialog.locator("#booking-service-items").click();
  const picker = dialog.getByTestId("service-item-picker");
  const item = picker.getByRole("checkbox", { name: new RegExp(SERVICE_ITEM_NAME) });
  await expect(item).toBeVisible({ timeout: LOAD_TIMEOUT });
  await item.click();
  await picker.getByRole("button", { name: /^確認/ }).click();
  await expect(picker).toHaveCount(0);
  await dialog.locator("#booking-customer-name").fill("E2E紅利客戶");
  await dialog.locator("#booking-payment-method").click();
  await page.getByRole("option").first().click();
  return dialog;
}

function pointsSection(dialog: Locator): Locator {
  return dialog
    .locator("section")
    .filter({ has: dialog.page().getByRole("heading", { name: /^紅利點數/ }) });
}

function suggestedRow(dialog: Locator): Locator {
  return pointsSection(dialog).getByText("系統建議派點", { exact: true }).locator("..");
}

async function enableRedeem(dialog: Locator, points: string) {
  await pointsSection(dialog).getByRole("switch", { name: "使用點數折抵" }).click();
  await dialog.locator("#booking-points-redeem-input").fill(points);
}

test("§4.6:建單看到派點、改數量跟著變、新電話顯示新客戶", async ({ page }) => {
  await loginAsAdmin(page);
  const dialog = await openNewBooking(page);

  await dialog.locator("#booking-customer-phone").fill(MEMBER_A_PHONE);
  await expect(pointsSection(dialog).getByRole("heading")).toContainText(
    `會員:${fixture.memberAName}`,
    { timeout: LOAD_TIMEOUT },
  );
  await expect(suggestedRow(dialog)).toContainText("10 點", { timeout: LOAD_TIMEOUT });
  await expect(pointsSection(dialog)).toContainText("訂單完成後才入帳");

  // #979:數量改在「選擇項目」整頁裡調(+ 一次 = 2),按確認才套用。
  await dialog.locator("#booking-service-items").click();
  await dialog
    .getByTestId("service-item-picker")
    .getByRole("button", { name: `增加「${SERVICE_ITEM_NAME}」的數量` })
    .click();
  await dialog.getByTestId("service-item-picker").getByRole("button", { name: /^確認/ }).click();
  await expect(suggestedRow(dialog)).toContainText("20 點", { timeout: LOAD_TIMEOUT });

  await dialog.locator("#booking-customer-phone").fill(NEW_CUSTOMER_PHONE);
  await expect(pointsSection(dialog).getByRole("heading")).toContainText(
    "新客戶(送出後自動建立會員)",
    { timeout: LOAD_TIMEOUT },
  );
  await expect(suggestedRow(dialog)).toContainText("20 點");
  // 新客戶餘額 0 ⇒ 沒有折抵開關。
  await expect(pointsSection(dialog).getByRole("switch", { name: "使用點數折抵" })).toHaveCount(0);
});

test("§2.10 / 裁決 22:折抵超額被擋;改電話立刻送出被擋,沒有建出訂單、餘額不變", async ({ page }) => {
  await loginAsAdmin(page);
  const dialog = await openNewBooking(page);
  await dialog.locator("#booking-customer-phone").fill(MEMBER_A_PHONE);
  await expect(suggestedRow(dialog)).toContainText("10 點", { timeout: LOAD_TIMEOUT });
  await expect(pointsSection(dialog)).toContainText(`目前可用 ${MEMBER_A_INITIAL} 點`);

  // ① 超過可用點數 ⇒ 欄位錯誤 + 送出被擋。
  await enableRedeem(dialog, "400");
  await expect(pointsSection(dialog)).toContainText(
    `這位會員目前只有 ${MEMBER_A_INITIAL} 點,無法折抵 400 點`,
  );
  await dialog.getByRole("button", { name: "建立預約" }).click();
  await expect(page.getByText("紅利折抵點數有問題").first()).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 正向對照:改成合法點數,畫面顯示折抵金額(100 點 = 10 元)。
  await dialog.locator("#booking-points-redeem-input").fill("100");
  await expect(pointsSection(dialog)).toContainText("折抵 $10");

  // ② 改電話後立刻送出:讓預覽回應延遲 4 秒,保證按下送出時預覽一定還沒回來。
  await page.route("**/rest/v1/rpc/preview_booking_points", async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue();
  });
  await dialog.locator("#booking-customer-phone").fill(MEMBER_B_PHONE);
  await dialog.getByRole("button", { name: "建立預約" }).click();
  await expect(page.getByText(STALE_MESSAGE).first()).toBeVisible({ timeout: 3000 });
  await expect(dialog).toBeVisible();

  // 預覽回來後:對到會員乙,折抵被重設。
  await expect(pointsSection(dialog).getByRole("heading")).toContainText(
    `會員:${fixture.memberBName}`,
    { timeout: LOAD_TIMEOUT },
  );
  await expect(pointsSection(dialog)).toContainText("客戶電話已變更,紅利折抵已重設");
  await page.unroute("**/rest/v1/rpc/preview_booking_points");

  // 資料庫:沒有任何訂單、兩位會員都沒被扣。
  expect(await listBookings(fixture.merchantId)).toHaveLength(0);
  expect(await getBalance(fixture.memberAId)).toBe(MEMBER_A_INITIAL);
  expect(await getBalance(fixture.memberBId)).toBe(MEMBER_B_INITIAL);
});

test("§2.5:有折扣 ⇒ 兩層重疊的人工確認窗;返回修改不送出;確認送出後派點 = 折扣後金額", async ({
  page,
}) => {
  await loginAsAdmin(page);
  const dialog = await openNewBooking(page);
  await dialog.locator("#booking-customer-phone").fill(MEMBER_B_PHONE);
  await expect(suggestedRow(dialog)).toContainText("10 點", { timeout: LOAD_TIMEOUT });

  await dialog
    .getByText("折扣優惠", { exact: true })
    .locator("..")
    .locator("..")
    .getByRole("switch")
    .click();
  await dialog
    .getByRole("radiogroup", { name: "折扣方式" })
    .getByRole("radio", { name: /百分比/ })
    .click();
  await dialog.locator("#booking-discount-value").fill("10");
  await expect(suggestedRow(dialog)).toContainText("9 點", { timeout: LOAD_TIMEOUT });
  await expect(pointsSection(dialog)).toContainText(
    "本單有自訂總金額/折扣,系統建議值僅供參考,請確認派點數",
  );

  await dialog.getByRole("button", { name: "建立預約" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(confirm).toContainText("請確認這筆訂單的派點數");
  await expect(confirm).toContainText("系統建議 9 點");
  // 兩層重疊:底下的建單全頁層仍在畫面上(小卡窗開著時 Radix 會把底層標成 aria-hidden,
  // getByRole 找不到它,所以這裡用 CSS 屬性選擇器看「實際有沒有顯示」)。
  await expect(page.locator('[role="dialog"]', { hasText: "新增預約" })).toBeVisible();

  await confirm.getByRole("button", { name: "返回修改" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(dialog).toBeVisible();
  expect(await listBookings(fixture.merchantId)).toHaveLength(0);

  await dialog.getByRole("button", { name: "建立預約" }).click();
  await expect(confirm).toBeVisible({ timeout: LOAD_TIMEOUT });
  await confirm.getByRole("button", { name: "確認送出" }).click();
  await expect(dialog).toHaveCount(0, { timeout: LOAD_TIMEOUT });

  const bookings = await listBookings(fixture.merchantId);
  expect(bookings).toHaveLength(1);
  expect(bookings[0]?.member_id).toBe(fixture.memberBId);
  expect(bookings[0]?.points_planned).toBe(9);
  expect(bookings[0]?.points_redeemed ?? 0).toBe(0);
});

test("§2.4:折抵建單 → 完成後餘額 = 原餘額 − 折抵 + 派點;會員詳情頁顯示一致", async ({ page }) => {
  await loginAsAdmin(page);
  const dialog = await openNewBooking(page, 1);
  await dialog.locator("#booking-customer-phone").fill(MEMBER_A_PHONE);
  await expect(suggestedRow(dialog)).toContainText("10 點", { timeout: LOAD_TIMEOUT });
  await enableRedeem(dialog, "100");
  await expect(dialog.getByText("紅利折抵", { exact: true }).locator("..")).toContainText("$10");
  await expect(dialog.getByText("實付", { exact: true }).locator("..")).toContainText("$990");
  await dialog.getByRole("button", { name: "建立預約" }).click();
  await expect(dialog).toHaveCount(0, { timeout: LOAD_TIMEOUT });

  const booking = (await listBookings(fixture.merchantId)).find(
    (b) => b.member_id === fixture.memberAId,
  );
  expect(booking).toBeDefined();
  expect(booking?.points_redeemed).toBe(100);
  expect(Number(booking?.points_redeem_amount_snapshot)).toBe(10);
  expect(booking?.points_planned).toBe(10);
  // 折抵在建單當下就凍結扣下。
  expect(await getBalance(fixture.memberAId)).toBe(MEMBER_A_INITIAL - 100);

  const admin = await clientAs(fixture.adminSession);
  const c1 = await admin.rpc("confirm_booking", { p_booking_id: booking?.id });
  expect(c1.error).toBeNull();
  const c2 = await admin.rpc("complete_booking", { p_booking_id: booking?.id });
  expect(c2.error).toBeNull();

  const expected = MEMBER_A_INITIAL - 100 + 10;
  expect(await getBalance(fixture.memberAId)).toBe(expected);

  await page.goto(`/app/members/${fixture.memberAId}`);
  await expect(page.locator("p.text-3xl")).toHaveText(`${expected} 點`, { timeout: LOAD_TIMEOUT });
});

test("§2.4:取消訂單 ⇒ 折抵退回", async ({ page }) => {
  await loginAsAdmin(page);
  const before = await getBalance(fixture.memberAId);
  const dialog = await openNewBooking(page, 2);
  await dialog.locator("#booking-customer-phone").fill(MEMBER_A_PHONE);
  await expect(suggestedRow(dialog)).toContainText("10 點", { timeout: LOAD_TIMEOUT });
  await enableRedeem(dialog, "50");
  await dialog.getByRole("button", { name: "建立預約" }).click();
  await expect(dialog).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  expect(await getBalance(fixture.memberAId)).toBe(before - 50);

  const booking = (await listBookings(fixture.merchantId)).find(
    (b) => b.member_id === fixture.memberAId && b.status !== "completed",
  );
  expect(booking?.points_redeemed).toBe(50);
  const admin = await clientAs(fixture.adminSession);
  const res = await admin.rpc("cancel_booking", {
    p_booking_id: booking?.id,
    p_reason: "e2e 本機:取消退回折抵",
  });
  expect(res.error).toBeNull();
  expect(await getBalance(fixture.memberAId)).toBe(before);

  await page.goto(`/app/members/${fixture.memberAId}`);
  await expect(page.locator("p.text-3xl")).toHaveText(`${before} 點`, { timeout: LOAD_TIMEOUT });
});

test("§4.10:店家報表的紅利折抵金額卡片隨開關出現 / 消失", async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto("/app/billing-report");
  const card = page.getByText("紅利折抵金額", { exact: true });
  await expect(card).toBeVisible({ timeout: LOAD_TIMEOUT });
  // 只算已完成訂單:上一條完成的那張折抵 10 元;取消的那張不算。
  await expect(card.locator("xpath=ancestor::*[contains(@class,'rounded')][1]")).toContainText(
    "10 元",
  );

  await setPointsFeature(fixture, false);
  try {
    await page.reload();
    await expect(page.getByText(/營收|收入/).first()).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(page.getByText("紅利折抵金額", { exact: true })).toHaveCount(0);
  } finally {
    await setPointsFeature(fixture, true);
  }
  await page.reload();
  await expect(page.getByText("紅利折抵金額", { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
});

test("裁決 21 ①:只有會員管理鑰匙的客服,功能關閉時看不到點數卡;開啟時看得到", async ({ page }) => {
  await injectSession(page, fixture.agentSession);
  await primeCurrentMerchant(page);

  // 正向對照:功能開啟 ⇒ 看得到點數卡。
  await page.goto(`/app/members/${fixture.memberAId}`);
  await expect(page.getByText(fixture.memberAName).first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText("點數", { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });

  await setPointsFeature(fixture, false);
  try {
    // 等「功能開關」查詢真的回來再斷言不存在(不是還在載入)。
    const flagResponse = page.waitForResponse(
      (r) => r.url().includes("/rpc/get_merchant_points_feature_enabled"),
      { timeout: LOAD_TIMEOUT },
    );
    await page.reload();
    expect((await flagResponse).ok()).toBe(true);
    await expect(page.getByText(fixture.memberAName).first()).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    await expect(page.getByText("點數", { exact: true })).toHaveCount(0);
    await expect(page.locator("p.text-3xl")).toHaveCount(0);
  } finally {
    await setPointsFeature(fixture, true);
  }
});
