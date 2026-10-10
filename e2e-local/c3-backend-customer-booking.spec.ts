// 客戶端第 3 批(C3)本機 e2e:後台 / 服務人員端看客人線上預約 + 順位 + 設定畫面。
// 規格書:.project/specs/客戶端第3批-送出預約與通知店家.md(🔴 零之零優先);介面 .project/notes/c3-contract.md。
// **只在本機跑**:`npx playwright test --config playwright.local.config.ts c3-backend-customer-booking`
//
// 客人訂單用本機 service role 直接呼叫 internal_customer_submit_booking 建(= Edge Function 呼叫的同一支核心)。
// 涵蓋:C3-E01(訂單列表 / 預約詳細 / 服務人員端詳細的「線上預約」「訪客預約」、訪客提示、建單人、操作紀錄)、
//       C3-C01(管理員鈴鐺 customer_booking_created 的標籤 / 內文 / 點擊目的地)、
//       C3-H03(服務人員管理 ↑↓ 立即生效、最上那位 ↑ 停用、說明小字)、C3-E02(4 項不再「即將推出」)、
//       C3-H05(商家設定兩個完成頁文字欄)、C3-E03(預約網址文案)。截圖 1280 / 375(C3-J02)。
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { primeCurrentMerchant, primeStaffCurrentMerchant } from "../e2e/support/app-shell";
import { buildFetch } from "../e2e/support/fixture-supabase-client";
import {
  injectSession,
  ITEM_INDOOR,
  serviceClient,
  STAFF_MING,
} from "./support/c1-public-booking-fixture";
import { createCustomerSession, newLineSub, testPhone } from "./support/c2-line-login-fixture";
import { LOAD_TIMEOUT, shotBoth } from "./support/c3-flow";
import {
  createCustomerBookingDirect,
  setupC3Fixture,
  teardownC3Fixture,
  type C3Fixture,
} from "./support/c3-submit-fixture";
import { readLocalSupabaseTarget } from "./support/local-target";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";

test.use({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

const MEMBER_CUSTOMER = "線上會員王小明";
const GUEST_CUSTOMER = "線上訪客林小華";

let fixture: C3Fixture;
let setupFailed = false;
let recorders: RequestRecorder[] = [];
let bookingDate = "";

function plusDays(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function isSunday(dateKey: string): boolean {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0;
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  try {
    fixture = await setupC3Fixture();
    const c1 = fixture.c2.c1;
    bookingDate = plusDays(c1.dateLeave, 1);
    while (isSunday(bookingDate)) bookingDate = plusDays(bookingDate, 1);
    const item = await serviceClient()
      .from("service_items")
      .select("id")
      .eq("merchant_id", c1.merchantAId)
      .eq("name", ITEM_INDOOR)
      .single();
    const itemId = item.data!.id as string;
    const draft = (time: string, name: string) => ({
      items: [{ service_item_id: itemId, quantity: 1 }],
      staff_id: c1.staffMingId,
      date: bookingDate,
      time,
      name,
      address: "台北市信義區松仁路 58 號 12 樓",
      notes: "<b>門口有狗</b>",
    });

    // 會員:客人帳號先走 ⑥-2(customer_complete_profile)接上會員,再送出。
    const session = await createCustomerSession(fixture.c2, newLineSub(), "王小明的 LINE");
    const { url, publishableKey } = readLocalSupabaseTarget();
    const customer = createClient(url, publishableKey, {
      global: { fetch: buildFetch(publishableKey) },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await customer.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    const linked = await customer.rpc("customer_complete_profile", {
      p_slug: c1.slugA,
      p_phone: testPhone(fixture.c2, 61),
      p_name: MEMBER_CUSTOMER,
      p_agree_policy: true,
    });
    expect((linked.data as { state?: string } | null)?.state).toBe("linked");
    const m = await createCustomerBookingDirect({
      slug: c1.slugA,
      userId: session.user.id,
      guestPhone: null,
      draft: draft("10:00", MEMBER_CUSTOMER),
      submissionId: randomUUID(),
    });
    expect(m["state"]).toBe("created");
    const g = await createCustomerBookingDirect({
      slug: c1.slugA,
      userId: null,
      guestPhone: testPhone(fixture.c2, 62),
      draft: draft("14:00", GUEST_CUSTOMER),
      submissionId: randomUUID(),
    });
    expect(g["state"]).toBe("created");
    console.log(`[c3-backend 本機] fixture 建好(A=${c1.slugA},預約日 ${bookingDate})`);
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(240_000);
  if (setupFailed || !fixture) return;
  const actions = await teardownC3Fixture(fixture);
  console.log("[c3-backend 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(() => {
  recorders = [];
});
test.afterEach(() => {
  for (const r of recorders) expectOnlyLocalRequests(r);
});

function track(page: Page): void {
  recorders.push(recordRequestHosts(page));
}

async function asAdmin(page: Page): Promise<void> {
  track(page);
  await injectSession(page, fixture.c2.c1.adminSession);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
}

test("C3-E01:訂單列表與預約詳細 ⇒ 線上預約 / 訪客預約標籤、訪客提示、建單人、操作紀錄", async ({
  page,
}) => {
  await asAdmin(page);
  await page.goto("/app/orders");
  const search = page.getByLabel("搜尋訂單");
  await expect(search).toBeVisible({ timeout: LOAD_TIMEOUT });
  await search.fill("線上");
  const memberCard = page.locator('[role="button"]').filter({ hasText: MEMBER_CUSTOMER });
  const guestCard = page.locator('[role="button"]').filter({ hasText: GUEST_CUSTOMER });
  await expect(memberCard.getByTestId("booking-source-tag-online")).toHaveText("線上預約", {
    timeout: LOAD_TIMEOUT,
  });
  await expect(guestCard.getByTestId("booking-source-tag-guest")).toContainText("訪客預約");
  await expect(guestCard).toContainText("訪客（線上預約）");
  await expect(memberCard).toContainText("客人（線上預約）");
  await expect(page.getByText("(已移除的人員)")).toHaveCount(0);
  await shotBoth(page, "backend-01-orders-list");

  await guestCard.click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByText("預約詳情")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(detail.getByTestId("booking-source-tag-guest")).toBeVisible();
  await expect(detail.getByTestId("guest-booking-hint")).toContainText(
    "客人沒有登入，電話未經驗證，請自行與客戶電話確認。",
  );
  await expect(detail).toContainText("訪客（線上預約）");
  // C3-F05:客人填的備註純文字
  await expect(detail.getByText("<b>門口有狗</b>")).toBeVisible();
  await shotBoth(page, "backend-02-guest-detail");
  await detail.getByText("操作記錄").click();
  await expect(detail).toContainText(`訪客 ${GUEST_CUSTOMER}`, { timeout: LOAD_TIMEOUT });
  await expect(detail).not.toContainText("已移除的人員");
});

test("C3-C01:管理員鈴鐺「客人線上預約時」⇒ 內文含訪客提醒,點了到訂單管理", async ({ page }) => {
  await asAdmin(page);
  await page.getByTestId("notification-bell").click();
  const rows = page.getByTestId("notification-row").filter({ hasText: "客人線上預約時" });
  await expect(rows).toHaveCount(2, { timeout: LOAD_TIMEOUT });
  const guestRow = rows.filter({ hasText: GUEST_CUSTOMER });
  await expect(guestRow).toContainText("新的線上預約（待確認）");
  await expect(guestRow).toContainText("訪客預約（未登入），請自行與客戶電話確認。");
  await expect(rows.filter({ hasText: MEMBER_CUSTOMER })).toContainText("請確認接單。");
  await shotBoth(page, "backend-03-bell");
  await guestRow.click();
  await expect(page).toHaveURL(/\/app\/orders$/, { timeout: LOAD_TIMEOUT });
});

test("C3-E01:服務人員端預約詳細 ⇒ 訪客預約標籤 + 提示", async ({ page }) => {
  track(page);
  await injectSession(page, fixture.staffUser.session);
  await primeStaffCurrentMerchant(page, LOAD_TIMEOUT);
  await page.goto("/app/calendar");
  // 先等月曆格子畫出來(不然下面「這個月有沒有那一天」會在載入前就判斷成沒有)。
  await expect(page.locator("button[data-date-key]").first()).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  const cell = page.locator(`button[data-date-key="${bookingDate}"]`);
  for (let i = 0; i < 2 && !(await cell.count()); i += 1) {
    await page.getByText("下個月 →").click();
  }
  await cell.click({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText(`${bookingDate} 的預約`)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.getByText(GUEST_CUSTOMER, { exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("booking-source-tag-guest")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(dialog.getByTestId("guest-booking-hint")).toBeVisible();
  await shotBoth(page, "backend-04-staff-guest-detail");
});

test("C3-H03:服務人員管理 ↑↓ 立即生效;最上那位 ↑ 停用;篩選時不顯示", async ({ page }) => {
  await asAdmin(page);
  const svc = serviceClient();
  const orderOf = async () => {
    const r = await svc
      .from("merchant_staff")
      .select("id,display_order,created_at")
      .eq("merchant_id", fixture.c2.c1.merchantAId)
      .eq("status", "active")
      .order("display_order")
      .order("created_at")
      .order("id");
    return (r.data ?? []).map((x) => x.id as string);
  };
  const before = await orderOf();
  await page.goto("/app/staff");
  await expect(page.getByTestId("staff-order-help")).toContainText(
    "順位會影響：客人選「不指定」時優先排給誰、預約頁與行事曆的排列順序。",
    { timeout: LOAD_TIMEOUT },
  );
  const ups = page.getByTestId("staff-order-up");
  const downs = page.getByTestId("staff-order-down");
  await expect(ups.first()).toBeDisabled();
  await expect(downs.last()).toBeDisabled();
  await shotBoth(page, "backend-05-staff-order");

  await downs.first().click();
  await expect
    .poll(orderOf, { timeout: LOAD_TIMEOUT })
    .toEqual([before[1], before[0], ...before.slice(2)]);
  // 畫面跟著換:第一張卡片換成原本的第二位
  await expect(ups.first()).toBeDisabled({ timeout: LOAD_TIMEOUT });
  await ups.nth(1).click();
  await expect.poll(orderOf, { timeout: LOAD_TIMEOUT }).toEqual(before);

  // 篩選「已上架」⇒ 箭頭收起來,說明改成「切到「全部」才能調整順位」
  await page.getByRole("tab", { name: /已上架/ }).click();
  await expect(page.getByTestId("staff-order-arrows")).toHaveCount(0);
  await expect(page.getByTestId("staff-order-help")).toContainText("切到「全部」才能調整順位");
});

test("C3-E02:編輯服務人員 ⇒ 客戶預約相關 4 項不再「即將推出」", async ({ page }) => {
  await asAdmin(page);
  await page.goto("/app/staff");
  const card = page.locator("li").filter({ hasText: STAFF_MING });
  await card.getByRole("button", { name: "編輯", exact: true }).click({ timeout: LOAD_TIMEOUT });
  const layer = page.getByRole("dialog");
  await expect(layer.getByText("客戶預約自動接受")).toBeVisible({ timeout: LOAD_TIMEOUT });
  for (const label of [
    "客戶預約無時段限制",
    "客戶預約自動接受",
    "最少要提前幾天預約",
    "最遠可以預約到幾天後",
  ]) {
    const row = layer.getByText(label, { exact: true }).locator("..");
    await expect(row).not.toContainText("即將推出");
  }
  // #1052 H2-03:Google 日曆、施工照片還沒上線 ⇒ 開關先不顯示,畫面上不再有「即將推出」
  await expect(layer.getByText("即將推出")).toHaveCount(0);
  await expect(layer.getByText("服務人員Google日曆同步")).toHaveCount(0);
  await expect(layer.getByText("服務人員施工圖片上傳")).toHaveCount(0);
  await layer.getByText("客戶預約自動接受").scrollIntoViewIfNeeded();
  await shotBoth(page, "backend-06-staff-settings");
});

test("C3-H05 / E03:商家設定「線上預約」卡兩個完成頁文字欄,存檔寫進資料庫;預約網址文案", async ({
  page,
}) => {
  await asAdmin(page);
  await page.goto("/app/settings");
  // 預約網址 ? 說明(主腦 10/9 小修):先講用途,再講代碼不能改。
  await page.getByRole("button", { name: "說明：預約網址是什麼、可以改嗎" }).click({
    timeout: LOAD_TIMEOUT,
  });
  await expect(
    page.getByText(
      "顧客預約用的專屬連結。客人可以看服務、選時間並送出預約。網址代碼由系統自動產生，目前不開放自行修改。",
    ),
  ).toBeVisible();
  const card = page.getByTestId("online-booking-settings-card");
  await expect(card.locator("#settings-completion-message-member")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(card.locator("#settings-completion-message-member")).toHaveAttribute(
    "placeholder",
    "店家確認後會通知您。",
  );
  await expect(card.locator("#settings-completion-message-guest")).toHaveAttribute(
    "placeholder",
    "店家確認後會與您聯絡。",
  );
  await card.locator("#settings-completion-message-guest").fill("  店家會在一天內打電話給你。  ");
  await expect(card).toContainText("13 / 200");
  await card.scrollIntoViewIfNeeded();
  await shotBoth(page, "backend-07-settings-completion-message");
  await page.getByRole("button", { name: "儲存變更" }).first().click();
  await expect(page.getByText("商家設定已儲存")).toBeVisible({ timeout: LOAD_TIMEOUT });
  const row = await serviceClient()
    .from("merchant_booking_settings")
    .select("completion_message_member,completion_message_guest")
    .eq("merchant_id", fixture.c2.c1.merchantAId)
    .single();
  expect(row.data).toEqual({
    completion_message_member: null,
    completion_message_guest: "店家會在一天內打電話給你。",
  });

  await page.goto("/app/manage");
  await expect(
    page.getByText("顧客預約用的專屬連結。客人可以看服務、選時間並送出預約。"),
  ).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByText("即將開放")).toHaveCount(0);
});
