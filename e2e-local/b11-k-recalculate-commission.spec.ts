// 第 11 批 K(#996):已完成訂單「重新計算抽成」按鈕。本機 Supabase 專用(e2e-local 設定,loopback guard 生效)。
// 規格書:.project/specs/改掛會員與預設文案全形-第11批.md §十八 18.7 e2e-local + 檔尾「主腦裁決」。
//
//   ① 管理員:詳情看到「目前抽成 $100」→ 比例改 20% → 重新計算 → 確認窗寫目前金額 → toast「$100 → $200」、
//      區塊更新、DB commission_amount = 200 且 recalculated_at 有值
//   ② 有「抽成與薪資設定」的客服:看得到、能按(比例改 30% ⇒ $200 → $300)
//   ③ 只有「服務人員報表」的客服:看不到「服務人員抽成」區塊
//   ④ 375 寬手機:區塊與確認窗沒有橫向捲動(截圖存 test-results/b11-k-shots)
//   ⑤ 月薪制服務人員的已完成訂單:灰字、沒有按鈕
//   ⑥ 主腦裁決:服務人員改成月薪後 ⇒ 顯示目前抽成 + 灰字「目前不是抽成制」、沒有按鈕
//   測完只刪 fixture 自己建的資料(刪前同條件 SELECT 核對,刪後全部 0)。
//
// 執行:npx playwright test --config playwright.local.config.ts b11-k-recalculate-commission
import { mkdirSync } from "node:fs";

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import { assertNoHorizontalOverflow } from "../e2e/support/overflow-assert";
import { expectOnlyLocalRequests, recordRequestHosts } from "./support/request-guard";
import {
  injectSession,
  serviceClient,
  setupB11kFixture,
  teardownB11kFixture,
  type B11kFixture,
} from "./support/b11-k-fixture";

const LOAD_TIMEOUT = 20_000;
const SHOTS = "test-results/b11-k-shots";

test.use({ timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

let fixture: B11kFixture;
let setupFailed = false;

test.beforeAll(async () => {
  test.setTimeout(150_000);
  try {
    fixture = await setupB11kFixture();
  } catch (err) {
    setupFailed = true;
    throw err;
  }
  mkdirSync(SHOTS, { recursive: true });
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownB11kFixture(fixture);
  console.log("[b11-k] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

type Who = "admin" | "agentCs" | "agentRp";

async function newPage(browser: Browser, who: Who, width = 1280): Promise<Page> {
  const mobile = width < 768;
  const context = await browser.newContext({
    viewport: { width, height: mobile ? 812 : 900 },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
    timezoneId: "Asia/Taipei",
  });
  const page = await context.newPage();
  await page.route("**/functions/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  const session =
    who === "admin"
      ? fixture.adminSession
      : who === "agentCs"
        ? fixture.agentCsSession
        : fixture.agentRpSession;
  await injectSession(page, session);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
  return page;
}

/** 在訂單管理頁打開某張單的預約詳情(全頁層)。 */
async function openDetail(page: Page, customerName: string): Promise<Locator> {
  await page.goto("/app/orders");
  await expect(page.getByRole("heading", { name: "訂單管理" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await page
    .getByRole("button", { name: new RegExp(customerName) })
    .click({ timeout: LOAD_TIMEOUT });
  const layer = page.getByRole("dialog");
  await expect(layer.getByText("預約詳情")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(layer.getByText(customerName).first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  return layer;
}

async function setRate(value: number) {
  const r = await fixture.admin
    .from("staff_service_commission_rates")
    .update({ commission_value: value })
    .eq("staff_id", fixture.staffSId)
    .eq("service_item_id", fixture.serviceItemId)
    .select("staff_id");
  if (r.error || (r.data ?? []).length !== 1) throw new Error(`改抽成比例失敗:${r.error?.message}`);
}

async function dbCommission(bookingId: string) {
  const r = await serviceClient()
    .from("booking_commission_records")
    .select("commission_amount,recalculated_at")
    .eq("booking_id", bookingId)
    .single();
  if (r.error) throw new Error(r.error.message);
  return r.data as { commission_amount: number; recalculated_at: string | null };
}

async function recalcViaUi(page: Page, layer: Locator, from: string, to: string) {
  const section = layer.getByTestId("booking-commission-section");
  await expect(section.getByTestId("booking-commission-amount")).toHaveText(from, {
    timeout: LOAD_TIMEOUT,
  });
  await section.getByRole("button", { name: "重新計算抽成" }).click();
  const confirm = page.getByTestId("booking-commission-confirm");
  await expect(confirm).toContainText("重新計算這筆訂單的抽成？");
  await expect(confirm).toContainText(`並取代原本的抽成(目前 ${from})`);
  await confirm.getByRole("button", { name: "重新計算" }).click();
  await expect(page.getByText(`抽成已重新計算：${from} → ${to}`)).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(confirm).toHaveCount(0);
  await expect(section.getByTestId("booking-commission-amount")).toHaveText(to, {
    timeout: LOAD_TIMEOUT,
  });
}

test("① 管理員:目前抽成 → 改比例 → 重新計算 → toast 新舊金額、區塊與 DB 都更新", async ({
  browser,
}) => {
  const before = await dbCommission(fixture.bookingSId);
  expect(Number(before.commission_amount)).toBe(100);
  expect(before.recalculated_at).toBeNull();

  const page = await newPage(browser, "admin");
  const recorder = recordRequestHosts(page);
  const layer = await openDetail(page, fixture.customerS);
  const section = layer.getByTestId("booking-commission-section");
  await expect(section).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(section.getByTestId("booking-commission-computed-at")).toContainText("最後計算：");

  await setRate(20);
  await recalcViaUi(page, layer, "$100", "$200");
  await expect
    .poll(async () => Number((await dbCommission(fixture.bookingSId)).commission_amount))
    .toBe(200);
  expect((await dbCommission(fixture.bookingSId)).recalculated_at).not.toBeNull();
  await page.screenshot({ path: `${SHOTS}/k-1280-admin-after.png` });
  expectOnlyLocalRequests(recorder);
  await page.context().close();
});

test("② 有「抽成與薪資設定」的客服:看得到、能按", async ({ browser }) => {
  const page = await newPage(browser, "agentCs");
  const recorder = recordRequestHosts(page);
  const layer = await openDetail(page, fixture.customerS);
  await setRate(30);
  await recalcViaUi(page, layer, "$200", "$300");
  await expect
    .poll(async () => Number((await dbCommission(fixture.bookingSId)).commission_amount))
    .toBe(300);
  expectOnlyLocalRequests(recorder);
  await page.context().close();
});

test("③ 只有「服務人員報表」的客服:看不到「服務人員抽成」區塊", async ({ browser }) => {
  const page = await newPage(browser, "agentRp");
  const layer = await openDetail(page, fixture.customerS);
  // 等權限與詳情都讀完(料錢 / 記錄區塊出現)再判斷,避免「還在讀取中所以不見」的假通過。
  await expect(layer.getByRole("heading", { name: "記錄" })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(layer.getByTestId("agent-cannot-reverse-note")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await page.waitForTimeout(1_000);
  await expect(layer.getByText("服務人員抽成")).toHaveCount(0);
  await expect(layer.getByTestId("booking-commission-section")).toHaveCount(0);
  await page.context().close();
});

test("④ 375 寬手機:區塊與確認窗沒有橫向捲動", async ({ browser }) => {
  const page = await newPage(browser, "admin", 375);
  const layer = await openDetail(page, fixture.customerS);
  const section = layer.getByTestId("booking-commission-section");
  await expect(section.getByTestId("booking-commission-amount")).toHaveText("$300", {
    timeout: LOAD_TIMEOUT,
  });
  await section.scrollIntoViewIfNeeded();
  await assertNoHorizontalOverflow(page, "375 預約詳情(服務人員抽成區塊)");
  await page.screenshot({ path: `${SHOTS}/k-375-section.png` });
  await section.getByRole("button", { name: "重新計算抽成" }).click();
  const confirm = page.getByTestId("booking-commission-confirm");
  await expect(confirm).toBeVisible();
  await confirm.evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
  );
  await assertNoHorizontalOverflow(page, "375 重新計算抽成確認窗");
  const box = (await confirm.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  await page.screenshot({ path: `${SHOTS}/k-375-confirm.png` });
  await confirm.getByRole("button", { name: "取消" }).click();
  await expect(confirm).toHaveCount(0);
  expect(Number((await dbCommission(fixture.bookingSId)).commission_amount)).toBe(300);
  await page.context().close();
});

test("⑤ 月薪制服務人員的已完成訂單:灰字、沒有按鈕", async ({ browser }) => {
  const page = await newPage(browser, "admin");
  const layer = await openDetail(page, fixture.customerM);
  await expect(layer.getByTestId("booking-commission-no-record")).toHaveText(
    "這筆訂單沒有抽成紀錄(月薪制、日薪制、時薪制服務人員不計抽成，或完成時沒有產生)，不能重新計算。",
    { timeout: LOAD_TIMEOUT },
  );
  await expect(layer.getByRole("button", { name: "重新計算抽成" })).toHaveCount(0);
  await page.context().close();
});

test("⑥ 主腦裁決:服務人員改成月薪後 ⇒ 目前抽成 + 灰字、沒有按鈕;直接打 RPC 也被擋", async ({
  browser,
}) => {
  const upd = await fixture.admin
    .from("merchant_staff")
    .update({ compensation_type: "monthly_salary" })
    .eq("id", fixture.staffSId)
    .select("id");
  if (upd.error || (upd.data ?? []).length !== 1)
    throw new Error(`改月薪失敗:${upd.error?.message}`);

  const page = await newPage(browser, "admin");
  const layer = await openDetail(page, fixture.customerS);
  await expect(layer.getByTestId("booking-commission-not-piece-rate")).toHaveText(
    "這位服務人員目前不是抽成制，無法重新計算抽成。",
    { timeout: LOAD_TIMEOUT },
  );
  await expect(layer.getByTestId("booking-commission-amount")).toHaveText("$300");
  await expect(layer.getByRole("button", { name: "重新計算抽成" })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/k-1280-not-piece-rate.png` });

  const rpc = await fixture.admin.rpc("recalculate_booking_commission", {
    p_booking_id: fixture.bookingSId,
  });
  expect(rpc.error?.message).toBe("這位服務人員目前不是抽成制，無法重新計算抽成");
  expect(Number((await dbCommission(fixture.bookingSId)).commission_amount)).toBe(300);
  await page.context().close();
});
