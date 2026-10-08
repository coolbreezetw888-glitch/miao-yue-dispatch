// 客戶端第 3 批(C3)本機 e2e:會員送出預約。
// 規格書:.project/specs/客戶端第3批-送出預約與通知店家.md(🔴 零之零優先);介面 .project/notes/c3-contract.md。
// **只在本機跑**:`npx playwright test --config playwright.local.config.ts c3-member-submit`
// LINE 登入 / Edge Function 用 page.route 模擬(fixture 見 support/c3-submit-fixture.ts),資料庫全部是本機真的。
//
// 涵蓋:C3-D02(⑥-2 先接上會員、再自動送出)、C3-D03(確認送出)、C3-D05 slot_taken、C3-D06 ⑦-1 / ⑦-2、
//       零之零 Q5(完成頁顯示被排到的服務人員)、Q7(店家自訂完成頁文字)、C3-D07 ① 登入列、
//       C3-F03(回應不洩漏服務人員本名 / 電話、沒有 _internal)、完成頁上一頁回 ①。
import { expect, test, type Page, type Response } from "@playwright/test";

import {
  ITEM_INDOOR,
  SENTINELS,
  serviceClient,
  SHOP_A_NAME,
  STAFF_MING,
} from "./support/c1-public-booking-fixture";
import {
  createCustomerSession,
  mockLineLogin,
  newLineSub,
  testPhone,
} from "./support/c2-line-login-fixture";
import { injectCustomerSession, LOAD_TIMEOUT, shotBoth, walkToForm } from "./support/c3-flow";
import {
  mockBookingSubmit,
  setupC3Fixture,
  teardownC3Fixture,
  type C3Fixture,
} from "./support/c3-submit-fixture";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";
import { buildTaipeiIso } from "../src/modules/booking/dateUtils";

test.use({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

let fixture: C3Fixture;
let setupFailed = false;
let recorders: RequestRecorder[] = [];
/** 同一位客人(第 1 條接上會員之後,後面幾條沿用)。 */
const SUB = newLineSub();
const CUSTOMER_NAME = "王小明";

test.beforeAll(async () => {
  test.setTimeout(240_000);
  try {
    fixture = await setupC3Fixture();
    console.log(`[c3-member 本機] fixture 建好(A=${fixture.c2.c1.slugA})`);
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(240_000);
  if (setupFailed || !fixture) return;
  const actions = await teardownC3Fixture(fixture);
  console.log("[c3-member 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
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

function collectSubmitBodies(page: Page): string[] {
  const bodies: string[] = [];
  page.on("response", (res: Response) => {
    if (!res.url().includes("/functions/v1/customer-booking-submit")) return;
    void res
      .text()
      .then((t) => bodies.push(t))
      .catch(() => undefined);
  });
  return bodies;
}

async function bookingBySubmission(submissionId: string) {
  const r = await serviceClient()
    .from("bookings")
    .select(
      "id,status,source,is_guest_booking,member_id,created_by_role,customer_name,customer_phone,customer_notes,staff_id",
    )
    .eq("customer_submission_id", submissionId)
    .single();
  expect(r.error).toBeNull();
  return r.data!;
}

/** 第 1 條之後:直接帶著「已接上會員」的客人登入狀態開預約頁。 */
async function asLinkedCustomer(page: Page): Promise<void> {
  const session = await createCustomerSession(fixture.c2, SUB, "王小明的 LINE");
  await injectCustomerSession(page, fixture.c2.c1.slugA, session);
}

test("C3-D02 / D06:新客人 LINE 登入 ⇒ ⑥-2「送出預約」⇒ 接上會員並自動送出 ⇒ ⑦-1;上一頁回 ①", async ({
  page,
}) => {
  track(page);
  const bodies = collectSubmitBodies(page);
  const login = await mockLineLogin(page, fixture.c2, { sub: SUB, displayName: "王小明的 LINE" });
  const submit = await mockBookingSubmit(page);

  await walkToForm(page, fixture.c2.c1.slugA, { item: ITEM_INDOOR, name: CUSTOMER_NAME });
  // 2026-10-09 使用者新增:步驟條 5 步 + 姓名上方提示句(A 店 LINE 登入 + 允許不登入)
  await expect(page.getByTestId("public-booking-step-label")).toContainText("步驟 4／5");
  await expect(page.getByTestId("public-booking-step-label")).toContainText("下一步：登入／電話");
  await expect(page.getByTestId("public-booking-next-step-hint")).toHaveText(
    "下一步會請你用 LINE 登入或填寫電話。",
  );
  await shotBoth(page, "member-00-form-hint");
  await page.getByTestId("public-booking-submit").click();
  await expect(page.getByTestId("customer-line-login")).toContainText("下次預約不用再填電話");
  await expect(page.getByTestId("public-booking-step-label")).toContainText("步驟 5／5");
  await page.getByTestId("customer-line-login-button").click();

  await expect(page.getByTestId("customer-profile")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("customer-profile-submit")).toHaveText("送出預約");
  await expect(page.getByTestId("public-booking-step-label")).toContainText("步驟 5／5");
  await page.locator("#customer-profile-phone").fill(testPhone(fixture.c2, 31));
  await page.getByTestId("customer-profile-consent").click();
  await shotBoth(page, "member-01-profile-submit");
  await page.getByTestId("customer-profile-submit").click();

  const done = page.getByTestId("booking-complete");
  await expect(done).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(done).toHaveAttribute("data-kind", "member_pending");
  await expect(page.getByTestId("booking-complete-title")).toHaveText("已送出，等待店家確認");
  await expect(page.getByTestId("booking-complete-message")).toHaveText("店家確認後會通知你。");
  // 零之零 Q5:不指定也顯示被排到的那位(顯示名)
  await expect(page.getByTestId("booking-complete-staff")).not.toHaveText("由店家安排");
  // 第 4 批(C4-B04)起:會員完成頁的取消說明改成會員中心自己取消 +「前往會員中心」主要按鈕
  await expect(page.getByTestId("booking-complete-contact")).toContainText(
    "要取消可以在服務前 24 小時以前到會員中心操作",
  );
  await expect(page.getByTestId("booking-complete-member-center")).toHaveText("前往會員中心");
  await shotBoth(page, "member-02-complete-pending");

  // 資料庫
  expect(login.userIds).toHaveLength(1);
  expect(submit.requests).toHaveLength(1);
  const req = submit.requests[0]!;
  expect(req["guest"]).toBeUndefined();
  expect(Object.keys(req["draft"] as Record<string, unknown>).sort()).toEqual(
    ["address", "date", "items", "name", "notes", "staff_id", "time"].sort(),
  );
  const b = await bookingBySubmission(String(req["submission_id"]));
  expect(b).toMatchObject({
    status: "pending_confirmation",
    source: "customer",
    is_guest_booking: false,
    created_by_role: "customer",
    customer_name: CUSTOMER_NAME,
    customer_notes: "門口有狗",
  });
  expect(b.member_id).not.toBeNull();
  const log = await serviceClient()
    .from("booking_status_change_logs")
    .select("from_status,to_status,actor_role_snapshot,actor_name_snapshot")
    .eq("booking_id", b.id)
    .single();
  expect(log.data).toEqual({
    from_status: null,
    to_status: "pending_confirmation",
    actor_role_snapshot: "customer",
    actor_name_snapshot: `客人 ${CUSTOMER_NAME}`,
  });

  // C3-F03:回應原文沒有 _internal、服務人員本名 / 電話、任何 id
  await expect.poll(() => bodies.length).toBeGreaterThan(0);
  const raw = bodies.join("\n");
  expect(raw).not.toContain("_internal");
  expect(raw).not.toContain(SENTINELS.staffRealName);
  expect(raw).not.toContain(SENTINELS.staffPhone);
  expect(raw).not.toContain(b.id);
  expect(raw).not.toContain(b.member_id!);
  expect(raw).not.toContain(b.staff_id);

  // C3-D06:系統上一頁 ⇒ 回 ①(看得到登入列),不能回到確認畫面
  await page.goBack();
  await expect(page.getByTestId("public-booking-start")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("customer-login-bar")).toContainText(CUSTOMER_NAME);
  await expect(page.getByTestId("customer-linked")).toHaveCount(0);
  await shotBoth(page, "member-03-home-loginbar");
  expect(submit.requests).toHaveLength(1);
});

test("零之零 Q7 / C3-D06 ⑦-2:服務人員開「客戶預約自動接受」+ 店家自訂會員完成頁文字 ⇒ 預約成功", async ({
  page,
}) => {
  const svc = serviceClient();
  const custom = "謝謝你的預約！\n服務前一天會再傳訊息提醒你。";
  const set = await fixture.c2.c1.admin.from("merchant_booking_settings").upsert(
    {
      merchant_id: fixture.c2.c1.merchantAId,
      completion_message_member: custom,
    } as never,
    { onConflict: "merchant_id" },
  );
  expect(set.error).toBeNull();
  const auto = await svc
    .from("merchant_staff")
    .update({ auto_accept_booking: true })
    .eq("id", fixture.c2.c1.staffMingId)
    .select("id");
  expect(auto.data).toHaveLength(1);
  try {
    track(page);
    await asLinkedCustomer(page);
    const submit = await mockBookingSubmit(page);
    await walkToForm(page, fixture.c2.c1.slugA, {
      item: ITEM_INDOOR,
      name: CUSTOMER_NAME,
      staffId: fixture.c2.c1.staffMingId,
    });
    // 已登入且接上會員 ⇒ 下一步「確認送出」、沒有提示句
    await expect(page.getByTestId("public-booking-step-label")).toContainText("下一步：確認送出");
    await expect(page.getByTestId("public-booking-next-step-hint")).toHaveCount(0);
    await page.getByTestId("public-booking-submit").click();
    const confirm = page.getByTestId("customer-linked");
    await expect(confirm).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(page.getByTestId("public-booking-step-label")).toContainText("步驟 5／5");
    await expect(page.getByTestId("public-booking-step-label")).toContainText("確認送出");
    await expect(confirm.getByTestId("customer-login-bar")).toContainText(CUSTOMER_NAME);
    await expect(confirm.getByTestId("public-booking-summary")).toContainText("松仁路 58 號");
    await shotBoth(page, "member-04-confirm");
    await page.getByTestId("customer-linked-submit").click();

    await expect(page.getByTestId("booking-complete")).toHaveAttribute(
      "data-kind",
      "member_accepted",
      { timeout: LOAD_TIMEOUT },
    );
    await expect(page.getByTestId("booking-complete-title")).toHaveText("預約成功");
    await expect(page.getByTestId("booking-complete-staff")).toHaveText(STAFF_MING);
    // 純文字、保留換行
    expect(await page.getByTestId("booking-complete-message").textContent()).toBe(custom);
    await shotBoth(page, "member-05-complete-accepted-custom");
    const b = await bookingBySubmission(String(submit.requests[0]!["submission_id"]));
    expect(b.status).toBe("accepted");
    expect(b.staff_id).toBe(fixture.c2.c1.staffMingId);
  } finally {
    await svc
      .from("merchant_staff")
      .update({ auto_accept_booking: false })
      .eq("id", fixture.c2.c1.staffMingId);
    await fixture.c2.c1.admin
      .from("merchant_booking_settings")
      .update({ completion_message_member: null } as never)
      .eq("merchant_id", fixture.c2.c1.merchantAId);
  }
});

test("C3-D05 slot_taken:確認畫面停著時時段被店家排走 ⇒ 回 ④ 提示、資料保留;重選後送出成功", async ({
  page,
}) => {
  track(page);
  await asLinkedCustomer(page);
  const submit = await mockBookingSubmit(page);
  const picked = await walkToForm(page, fixture.c2.c1.slugA, {
    item: ITEM_INDOOR,
    name: CUSTOMER_NAME,
    staffId: fixture.c2.c1.staffMingId,
    note: "請先打電話",
  });
  await page.getByTestId("public-booking-submit").click();
  await expect(page.getByTestId("customer-linked")).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 店家在後台把同一個時段排給阿明
  const admin = fixture.c2.c1.admin;
  const item = await admin
    .from("service_items")
    .select("id")
    .eq("merchant_id", fixture.c2.c1.merchantAId)
    .eq("name", ITEM_INDOOR)
    .single();
  const pm = await admin
    .from("payment_methods")
    .select("id")
    .eq("merchant_id", fixture.c2.c1.merchantAId)
    .eq("status", "active")
    .limit(1)
    .single();
  const occupy = await admin.rpc("create_booking", {
    p_merchant_id: fixture.c2.c1.merchantAId,
    p_staff_id: fixture.c2.c1.staffMingId,
    p_service_items: [{ service_item_id: item.data!.id, quantity: 1, unit_price: 2500 }],
    p_start_at: buildTaipeiIso(picked.date, picked.time),
    p_customer_name: "後台搶先的客人",
    p_customer_phone: testPhone(fixture.c2, 41),
    p_customer_address: "台北市測試路 2 號",
    p_notes: null,
    p_customer_notes: null,
    p_assistant_staff_ids: [],
    p_payment_method_id: pm.data!.id,
  });
  expect(occupy.error).toBeNull();

  await page.getByTestId("customer-linked-submit").click();
  await expect(page.getByTestId("public-booking-slot-taken")).toContainText(
    "這個時段剛剛被約走了，請重新選一個時間。",
    { timeout: LOAD_TIMEOUT },
  );
  await shotBoth(page, "member-06-slot-taken");
  await expect(page.getByTestId(`public-booking-time-${picked.time}`)).toHaveCount(0, {
    timeout: LOAD_TIMEOUT,
  });
  await page.getByTestId("public-booking-times").locator("button").first().click();
  await page.getByTestId("public-booking-next").click();
  await expect(page.locator("#public-booking-name")).toHaveValue(CUSTOMER_NAME);
  await expect(page.locator("#public-booking-note")).toHaveValue("請先打電話");
  await page.getByTestId("public-booking-submit").click();
  await page.getByTestId("customer-linked-submit").click();
  await expect(page.getByTestId("booking-complete")).toBeVisible({ timeout: LOAD_TIMEOUT });
  // 兩次送出用不同的 submission_id(重選時間 = 重新進確認畫面);第一次沒有建單
  expect(submit.requests).toHaveLength(2);
  expect(submit.requests[0]!["submission_id"]).not.toBe(submit.requests[1]!["submission_id"]);
  const none = await serviceClient()
    .from("bookings")
    .select("id")
    .eq("customer_submission_id", String(submit.requests[0]!["submission_id"]));
  expect(none.data).toEqual([]);
});

test("C3-D07:已接上會員的客人直接開預約頁 ⇒ ① 顯示登入列;登出 ⇒ 登入列消失", async ({ page }) => {
  track(page);
  await asLinkedCustomer(page);
  await page.goto(`/booking/${fixture.c2.c1.slugA}`);
  await expect(page.getByTestId("public-booking-shop-name")).toHaveText(SHOP_A_NAME, {
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByTestId("customer-login-bar")).toContainText(CUSTOMER_NAME);
  // 登出 ⇒ 登入列消失(只登出這間店的客戶 client)
  await page.getByTestId("customer-login-bar-logout").click();
  await expect(page.getByTestId("customer-login-bar")).toHaveCount(0);
});
