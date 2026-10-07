// SPECS-INDEX #997 第 11 批 H:已完成訂單被取消 / 被還原 ⇒ 鈴鐺通知店裡其他管理員與有訂單管理權限的客服。
// 規格書 .project/specs/改掛會員與預設文案全形-第11批.md §15.7 e2e-local。**只在本機跑**:
//   npx playwright test --config playwright.local.config.ts b11-h-completed-reversal-bell
// (只連本機 Docker;Playwright 自己開獨立 headless Chromium,不碰使用者的瀏覽器)。
//
// 涵蓋:
//   ① 管理員 A 還原 → 管理員 B 登入,鈴鐺有「已完成訂單被還原時」、內文含原因 → 點了到訂單管理
//   ② A 取消(通知開關關)→ 有訂單管理權限的客服 C 鈴鐺有「已完成訂單被取消時」
//   ③ A 自己的鈴鐺沒有這兩種
//   ④ 取消時打開通知開關:本機沒有跑 Edge Function,這裡用 service_role 補一列跟 Edge Function 一模一樣的
//      booking_cancelled 鈴鐺(B、30 秒後)⇒ B 鈴鐺同一張單只看到**一列**(畫面合併),點了兩列一起標已讀
// 還原 / 取消走正式 RPC(以 A 的身分,權限照常生效);畫面上的還原 / 取消流程已由 completed-booking-reversal.spec.ts 涵蓋。
//
// 測試資料:沿用 setupBonusFixture(管理員 A、客服 C、商家…),本檔再補第二位管理員 B 與 C 的「訂單」鑰匙。
// teardown 同一支 teardownBonusFixture(刪前核對名稱 / email 格式、刪後全部 0;B 的 email 也照同一格式)。
import { expect, test, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";
import {
  anonClient,
  clientAs,
  injectSession,
  SERVICE_ITEM_PRICE,
  serviceClient,
  setupBonusFixture,
  teardownBonusFixture,
  type BonusFixture,
} from "./support/bonus-fixture";
import type { Session } from "@supabase/supabase-js";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial", timeout: 120_000 });

let fixture: BonusFixture;
let setupFailed = false;
let recorder: RequestRecorder | null = null;
let adminBSession: Session;
let adminBRowId: string;
let adminBUserId: string;
let bookingCounter = 0;

const CUSTOMER_REVERT = "H還原客人";
const CUSTOMER_CANCEL = "H取消客人";
const CUSTOMER_CANCEL_NOTIFY = "H開關客人";
const REASON_REVERT = "客人說時間記錯了";
const REASON_CANCEL = "客人不要了";
const REASON_CANCEL_NOTIFY = "改天再來";

function taipeiDateKey(offsetDays: number): string {
  const d = new Date(Date.now() + 8 * 3600_000 + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function createCompletedBooking(customerName: string): Promise<string> {
  bookingCounter += 1;
  const admin = await clientAs(fixture.adminSession);
  const hour = String(8 + bookingCounter).padStart(2, "0");
  const created = await admin.rpc("create_booking", {
    p_merchant_id: fixture.merchantId,
    p_staff_id: fixture.staffIds[bookingCounter % fixture.staffIds.length],
    p_service_items: [
      { service_item_id: fixture.serviceItemId, quantity: 1, unit_price: SERVICE_ITEM_PRICE },
    ],
    p_start_at: `${taipeiDateKey(1)}T${hour}:00:00+08:00`,
    p_customer_name: customerName,
    p_customer_phone: `09661009${String(bookingCounter).padStart(2, "0")}`,
    p_payment_method_id: fixture.paymentMethodId,
  });
  if (created.error || !created.data) throw new Error(`建單失敗:${created.error?.message}`);
  const id = (created.data as { id: string }).id;
  const c1 = await admin.rpc("confirm_booking", { p_booking_id: id });
  if (c1.error) throw new Error(`確認失敗:${c1.error.message}`);
  const c2 = await admin.rpc("complete_booking", { p_booking_id: id });
  if (c2.error) throw new Error(`完成失敗:${c2.error.message}`);
  return id;
}

async function openBell(page: Page, session: Session) {
  await injectSession(page, session);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
  await page.getByTestId("notification-bell").click();
}

let revertBookingId = "";
let cancelBookingId = "";
let notifyBookingId = "";

test.beforeAll(async () => {
  try {
    fixture = await setupBonusFixture();
    const svc = serviceClient();
    const admin = await clientAs(fixture.adminSession);

    // 第二位管理員 B(email 格式跟 fixture 一致,teardown 的核對才會放行)。
    const emailB = `e2e-bonus-admin-${fixture.runId}9@example-local-test.test`;
    const signUp = await anonClient().auth.signUp({
      email: emailB,
      password: `E2eBonus!${fixture.runId}Bb`,
    });
    if (signUp.error || !signUp.data.session || !signUp.data.user) {
      throw new Error(`建立管理員 B 失敗:${signUp.error?.message}`);
    }
    adminBSession = signUp.data.session;
    adminBUserId = signUp.data.user.id;
    fixture.userIds.push(adminBUserId);
    const maRes = await svc
      .from("merchant_admins")
      .insert({
        merchant_id: fixture.merchantId,
        user_id: adminBUserId,
        display_name: "E2E管理員乙",
      })
      .select("id")
      .single();
    if (maRes.error || !maRes.data) throw new Error(`加管理員 B 失敗:${maRes.error?.message}`);
    adminBRowId = (maRes.data as { id: string }).id;

    // 客服 C 加開「訂單」鑰匙。
    const agentRow = await svc
      .from("merchant_agents")
      .select("id")
      .eq("merchant_id", fixture.merchantId)
      .single();
    if (agentRow.error) throw new Error(`查客服失敗:${agentRow.error.message}`);
    const perm = await admin.rpc("set_agent_permission", {
      p_agent_id: (agentRow.data as { id: string }).id,
      p_section_key: "orders",
      p_granted: true,
    });
    if (perm.error) throw new Error(`開客服 orders 權限失敗:${perm.error.message}`);

    revertBookingId = await createCompletedBooking(CUSTOMER_REVERT);
    cancelBookingId = await createCompletedBooking(CUSTOMER_CANCEL);
    notifyBookingId = await createCompletedBooking(CUSTOMER_CANCEL_NOTIFY);

    // 建單 / 完成過程可能已經寫了別的鈴鐺:先清掉本店的,之後只看本項。刪前同條件 SELECT 核對(CLAUDE.md 5-1)。
    const before = await svc
      .from("user_notifications")
      .select("id, merchant_id")
      .eq("merchant_id", fixture.merchantId);
    if (before.error) throw new Error(`核對鈴鐺失敗:${before.error.message}`);
    if (
      (before.data ?? []).some(
        (r) => (r as { merchant_id: string }).merchant_id !== fixture.merchantId,
      )
    ) {
      throw new Error("核對失敗:出現別店的鈴鐺,不刪");
    }
    const del = await svc.from("user_notifications").delete().eq("merchant_id", fixture.merchantId);
    if (del.error) throw new Error(`清鈴鐺失敗:${del.error.message}`);

    // A 還原 / 取消(開關關)/ 取消(開關開)。
    const r1 = await admin.rpc("revert_completed_booking", {
      p_booking_id: revertBookingId,
      p_reason: REASON_REVERT,
    });
    if (r1.error) throw new Error(`還原失敗:${r1.error.message}`);
    const r2 = await admin.rpc("cancel_completed_booking", {
      p_booking_id: cancelBookingId,
      p_reason: REASON_CANCEL,
      p_notify_requested: false,
    });
    if (r2.error) throw new Error(`取消失敗:${r2.error.message}`);
    const r3 = await admin.rpc("cancel_completed_booking", {
      p_booking_id: notifyBookingId,
      p_reason: REASON_CANCEL_NOTIFY,
      p_notify_requested: true,
    });
    if (r3.error) throw new Error(`取消(開關開)失敗:${r3.error.message}`);

    // 開關開:模擬 Edge Function(push-notify-dispatch)替 B 寫的 booking_cancelled 鈴鐺,時間在資料庫那列之後 30 秒。
    const dbRow = await svc
      .from("user_notifications")
      .select("created_at")
      .eq("booking_id", notifyBookingId)
      .eq("user_id", adminBUserId)
      .eq("event_type", "booking_completed_cancelled")
      .single();
    if (dbRow.error || !dbRow.data) throw new Error(`查 B 的取消鈴鐺失敗:${dbRow.error?.message}`);
    const pushAt = new Date(
      new Date((dbRow.data as { created_at: string }).created_at).getTime() + 30_000,
    ).toISOString();
    const ins = await svc.from("user_notifications").insert({
      user_id: adminBUserId,
      merchant_id: fixture.merchantId,
      target_type: "admin",
      target_id: adminBRowId,
      event_type: "booking_cancelled",
      booking_id: notifyBookingId,
      title: "預約已取消",
      body: `${CUSTOMER_CANCEL_NOTIFY} 的預約已取消(模擬推播那一列)`,
      created_at: pushAt,
    });
    if (ins.error) throw new Error(`模擬推播鈴鐺失敗:${ins.error.message}`);
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownBonusFixture(fixture);
  console.log("[b11-h 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(async ({ page }) => {
  recorder = recordRequestHosts(page);
  await page.route("**/functions/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
});

test.afterEach(() => {
  if (recorder) expectOnlyLocalRequests(recorder);
});

test("① A 還原 ⇒ 管理員 B 鈴鐺有「已完成訂單被還原時」、內文含原因,點了到訂單管理", async ({
  page,
}) => {
  await openBell(page, adminBSession);
  const row = page.getByTestId("notification-row").filter({ hasText: CUSTOMER_REVERT });
  await expect(row).toHaveCount(1, { timeout: LOAD_TIMEOUT });
  await expect(row).toContainText("已完成訂單被還原時");
  await expect(row).toContainText("已完成訂單被還原");
  await expect(row).toContainText(`原因：${REASON_REVERT}`);
  await row.click();
  await expect(page).toHaveURL(/\/app\/orders$/, { timeout: LOAD_TIMEOUT });
});

test("② A 取消(開關關)⇒ 有訂單管理權限的客服 C 鈴鐺有「已完成訂單被取消時」", async ({ page }) => {
  await openBell(page, fixture.agentSession);
  const row = page.getByTestId("notification-row").filter({ hasText: CUSTOMER_CANCEL });
  await expect(row.filter({ hasText: "已完成訂單被取消時" })).toHaveCount(1, {
    timeout: LOAD_TIMEOUT,
  });
  await expect(row.first()).toContainText(`原因：${REASON_CANCEL}`);
  // C 也收到還原那則
  await expect(
    page.getByTestId("notification-row").filter({ hasText: CUSTOMER_REVERT }),
  ).toHaveCount(1);
});

test("③ 操作者 A 自己的鈴鐺沒有這兩種", async ({ page }) => {
  await openBell(page, fixture.adminSession);
  await expect(page.getByTestId("notification-empty")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(
    page.getByTestId("notification-row").filter({ hasText: "已完成訂單被" }),
  ).toHaveCount(0);
  // 資料庫層再確認一次
  const r = await serviceClient()
    .from("user_notifications")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", fixture.merchantId)
    .in("event_type", ["booking_completed_cancelled", "booking_completed_reverted"])
    .eq("user_id", fixture.userIds[0]!);
  expect(r.count).toBe(0);
});

test("④ 取消時開關開:推播另寫的 booking_cancelled 跟資料庫那則併成一列,點了兩列一起標已讀", async ({
  page,
}) => {
  await openBell(page, adminBSession);
  const rows = page.getByTestId("notification-row").filter({ hasText: CUSTOMER_CANCEL_NOTIFY });
  await expect(rows).toHaveCount(1, { timeout: LOAD_TIMEOUT });
  await expect(rows).toContainText("已完成訂單被取消時");
  await expect(rows).toContainText(`原因：${REASON_CANCEL_NOTIFY}`);
  await expect(rows).not.toContainText("模擬推播那一列");
  await rows.click();
  await expect(page).toHaveURL(/\/app\/orders$/, { timeout: LOAD_TIMEOUT });
  // 資料庫兩列都保留,而且兩列都被標已讀
  await expect
    .poll(
      async () => {
        const r = await serviceClient()
          .from("user_notifications")
          .select("event_type, read_at")
          .eq("booking_id", notifyBookingId)
          .eq("user_id", adminBUserId);
        return (r.data ?? [])
          .map(
            (x) =>
              `${(x as { event_type: string }).event_type}:${(x as { read_at: string | null }).read_at ? "read" : "unread"}`,
          )
          .sort();
      },
      { timeout: LOAD_TIMEOUT },
    )
    .toEqual(["booking_cancelled:read", "booking_completed_cancelled:read"]);
});
