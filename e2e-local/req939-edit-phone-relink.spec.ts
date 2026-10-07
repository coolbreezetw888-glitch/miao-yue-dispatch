// SPECS-INDEX #939 / #988(第 11 批 A):已連結會員的訂單改電話 ⇒ 自動改掛會員 + 紅利重算 —— 端對端(只在本機跑)。
// 規格書 .project/specs/改掛會員與預設文案全形-第11批.md §1.7、§5.3。
// 執行:`npm run test:e2e:local -- req939`(playwright.local.config.ts;只連本機 Docker,Playwright 自己開
// 獨立的 headless Chromium,不碰使用者的瀏覽器)。不在預設 config 的 testDir 裡 ⇒ 不影響 123 條 / 22 檔基準。
//
//   1. 客服(管理員)打開已連結會員甲、有折抵 100 點的單 → 把電話改成會員乙的 → 面板出現「會改掛到:乙」
//      與常駐 `!`(折抵 100 點會退回給甲)→ 儲存 → 提示「已改掛會員:乙」→ 訂單詳情的會員變成乙、
//      資料庫的訂單會員 = 乙、甲的點數回到原值 → 甲的會員詳情點數異動多一筆「先退回原本的紅利折抵 100 點」
//   2. 改成沒人用的電話 → 面板「會用這支電話建立新會員:{表單姓名}」→ 儲存 → 會員名單多一位
//
// 測試資料:沿用紅利批次 8 的 setupBonusFixture(管理員、會員甲 300 點 / 乙 500 點、10 點 = 1 元、最多折 50%)。
// teardown 同一支 teardownBonusFixture(service_role 硬刪除,刪前核對名稱 / email 格式、刪後全部 0)。
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
  MEMBER_A_INITIAL,
  MEMBER_A_PHONE,
  MEMBER_B_PHONE,
  SERVICE_ITEM_PRICE,
  serviceClient,
  setupBonusFixture,
  teardownBonusFixture,
  type BonusFixture,
} from "./support/bonus-fixture";

const LOAD_TIMEOUT = 20_000;
const REDEEM_POINTS = 100;
/** 不在任何會員名下的電話(本 fixture 只有甲 0966100001、乙 0966100002 與 NEW_CUSTOMER_PHONE 0966100099)。 */
const UNUSED_PHONE = "0966100939";

test.describe.configure({ mode: "serial", timeout: 120_000 });

let fixture: BonusFixture;
let setupFailed = false;
let recorder: RequestRecorder | null = null;
let bookingCounter = 0;

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
  console.log("[req939 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(async ({ page }) => {
  recorder = recordRequestHosts(page);
  // 本機沒有跑 Edge Function:改單後的推播呼叫一律攔下回 200(不影響這支要驗的東西)。
  await page.route("**/functions/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
});

test.afterEach(async () => {
  if (recorder) expectOnlyLocalRequests(recorder);
});

function taipeiDateKey(offsetDays: number): string {
  const d = new Date(Date.now() + 8 * 3600_000 + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** 以管理員身分(正式 RPC,權限照常生效)建一張掛在電話對應會員底下的單,可帶折抵。 */
async function createBooking(
  customerName: string,
  phone: string,
  redeem: { points: number; memberId: string } | null,
): Promise<string> {
  bookingCounter += 1;
  const admin = await clientAs(fixture.adminSession);
  const hour = String(8 + bookingCounter).padStart(2, "0");
  const created = await admin.rpc("create_booking", {
    p_merchant_id: fixture.merchantId,
    p_staff_id: fixture.staffIds[0],
    p_service_items: [
      { service_item_id: fixture.serviceItemId, quantity: 1, unit_price: SERVICE_ITEM_PRICE },
    ],
    p_start_at: `${taipeiDateKey(2)}T${hour}:00:00+08:00`,
    p_customer_name: customerName,
    p_customer_phone: phone,
    p_payment_method_id: fixture.paymentMethodId,
    ...(redeem
      ? { p_points_redeemed: redeem.points, p_points_redeem_member_id: redeem.memberId }
      : {}),
  });
  if (created.error || !created.data) throw new Error(`建單失敗:${created.error?.message}`);
  return (created.data as { id: string }).id;
}

async function bookingMember(
  id: string,
): Promise<{ member_id: string | null; points_redeemed: number }> {
  const r = await serviceClient()
    .from("bookings")
    .select("member_id,points_redeemed")
    .eq("id", id)
    .single();
  if (r.error) throw new Error(`查訂單失敗:${r.error.message}`);
  return r.data as { member_id: string | null; points_redeemed: number };
}

/** 訂單管理頁 → 打開這張單的預約詳情 → 按「編輯」,回傳編輯表單。 */
async function openEditForm(page: Page, customerName: string): Promise<Locator> {
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page);
  await page.goto("/app/orders");
  await expect(page.getByRole("heading", { name: "訂單管理" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await page.getByRole("button", { name: new RegExp(customerName) }).click();
  const layer = page.getByRole("dialog");
  await expect(layer.getByText("預約詳情")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await layer.getByRole("button", { name: "編輯", exact: true }).click();
  const form = page.getByRole("dialog").filter({ has: page.getByText("編輯預約") });
  await expect(form.locator("#booking-customer-phone")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(form.getByText("已連結會員：")).toBeVisible({ timeout: LOAD_TIMEOUT });
  return form;
}

test("#939 改成另一位會員的電話 ⇒ 改掛 + 原會員的折抵全數退回", async ({ page }) => {
  const name = `E2E改掛客戶${fixture.runId}`;
  const id = await createBooking(name, MEMBER_A_PHONE, {
    points: REDEEM_POINTS,
    memberId: fixture.memberAId,
  });
  expect(await getBalance(fixture.memberAId)).toBe(MEMBER_A_INITIAL - REDEEM_POINTS);

  const form = await openEditForm(page, name);
  await form.locator("#booking-customer-phone").fill(MEMBER_B_PHONE);

  const panel = form.getByTestId("member-relink-panel");
  await expect(panel).toContainText(`電話已更改，儲存後這筆訂單會改掛到：${fixture.memberBName}`, {
    timeout: LOAD_TIMEOUT,
  });
  await expect(form.getByTestId("member-relink-consequence")).toHaveText(
    `!儲存後，這筆訂單的紅利改算給新的會員。原會員「${fixture.memberAName}」的紅利折抵 ${REDEEM_POINTS} 點會全部退回給他，派點依新會員重新計算。`,
  );

  await form.getByRole("button", { name: "儲存變更" }).click();
  await expect(page.getByText(`已改掛會員：${fixture.memberBName}`)).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 資料庫:訂單掛到乙、折抵歸 0;甲的點數回到原值。
  await expect
    .poll(async () => (await bookingMember(id)).member_id, { timeout: LOAD_TIMEOUT })
    .toBe(fixture.memberBId);
  expect((await bookingMember(id)).points_redeemed).toBe(0);
  expect(await getBalance(fixture.memberAId)).toBe(MEMBER_A_INITIAL);

  // 訂單詳情:會員變成乙。
  await page.goto("/app/orders");
  await page.getByRole("button", { name: new RegExp(name) }).click();
  const layer = page.getByRole("dialog");
  await expect(layer.getByText("預約詳情")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(layer.getByText(fixture.memberBName).first()).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 原會員甲的會員詳情:點數異動多一筆退回。
  await page.goto(`/app/members/${fixture.memberAId}`);
  await expect(
    page.getByText(`訂單編輯變更了會員或折抵點數，先退回原本的紅利折抵 ${REDEEM_POINTS} 點`),
  ).toBeVisible({ timeout: LOAD_TIMEOUT });
});

test("#939 改成沒人用的電話 ⇒ 用這支電話自動建立新會員", async ({ page }) => {
  const name = `E2E改掛新客${fixture.runId}`;
  const id = await createBooking(name, MEMBER_A_PHONE, null);
  const before = await serviceClient()
    .from("members")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", fixture.merchantId);
  if (before.error) throw new Error(before.error.message);

  const form = await openEditForm(page, name);
  await form.locator("#booking-customer-phone").fill(UNUSED_PHONE);
  await form.locator("#booking-customer-name").fill(`${name}新`);
  await expect(form.getByTestId("member-relink-panel")).toContainText(
    `電話已更改，儲存後會用這支電話建立新會員：${name}新`,
    { timeout: LOAD_TIMEOUT },
  );
  await expect(form.getByTestId("member-relink-consequence")).toHaveText(
    "!儲存後，這筆訂單的紅利改算給新的會員，派點依新會員重新計算。",
  );
  await form.getByRole("button", { name: "儲存變更" }).click();
  await expect(page.getByText(`已改掛會員：${name}新`)).toBeVisible({ timeout: LOAD_TIMEOUT });

  const created = await serviceClient()
    .from("members")
    .select("id,name,phone")
    .eq("merchant_id", fixture.merchantId)
    .eq("phone", UNUSED_PHONE);
  if (created.error) throw new Error(created.error.message);
  expect(created.data).toHaveLength(1);
  expect(created.data?.[0]?.name).toBe(`${name}新`);
  expect((await bookingMember(id)).member_id).toBe(created.data?.[0]?.id);
  const after = await serviceClient()
    .from("members")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", fixture.merchantId);
  expect(after.count).toBe((before.count ?? 0) + 1);

  // 會員名單多一位(畫面看得到)。
  await page.goto("/app/members");
  await expect(page.getByText(`${name}新`).first()).toBeVisible({ timeout: LOAD_TIMEOUT });
});
