// 模組 11(LINE 通知)前端部分的 Playwright 測試:
//   1. LINE 串接設定頁(§4.1):填寫假憑證,讓「測試連線」真的打一次已部署的 line-test-connection
//      Edge Function(它會真的呼叫 LINE 官方 API,因為憑證是假的,預期真的失敗)——這是規格書
//      §0 第二段明講的間接驗證方式之一(貼一個假 token,確認系統正確顯示「驗證失敗」),不需要
//      任何 mock。另外用 page.route mock 一次「成功」回應,驗證畫面正確渲染成功訊息(不依賴真實
//      LINE 帳號,規格書§0 第二段另一種間接驗證方式)。
//   2. 我的 LINE 綁定卡片(§4.5)/服務人員 LINE 綁定區塊(§4.6)/會員 LINE 綁定區塊(§4.7):
//      產生綁定碼後正確顯示 6 碼數字 + 倒數計時。這三處呼叫的是三支不同的真實 RPC
//      (generate_own_admin_line_binding_code/generate_staff_line_binding_code/
//      generate_member_line_binding_code),不需要 mock。
//   3. 確認訂單通知彈窗(規則 2.5/§4.8):
//      a. 商家完全沒有串接 LINE 時,preview_line_notification_targets 真的呼叫、真的回傳
//         has_any_target=false,確認訂單直接執行、不顯示彈窗(不需要 mock)。
//      b. mock preview_line_notification_targets 回傳「有目標」,驗證彈窗正確顯示名單;
//         選「否」不會呼叫 line-notify-dispatch,選「是」才會呼叫(mock line-notify-dispatch
//         記錄呼叫次數)。
//   4. LINE 通知設定頁(§4.2):切換開關/編輯文案後正確儲存並在重新整理後仍然生效。
//   5. 行銷通知頁(§4.4,原「行銷再通知頁」,§10.1/SPECS-INDEX #584 改名):目前沒有任何會員
//      完成 LINE 綁定時的空狀態文字正確顯示;填入含 {{member_name}} 變數的文字,即時預覽正確
//      顯示替換後的白話文字;可用變數說明清單正確列出。
//   6. 行銷通知頁會員選擇擴充(§10.2,SPECS-INDEX #612):依會員分類批量選擇/排除清單(黑名單
//      預設自動排除)。這兩項一樣需要「已綁定 LINE 的會員」才測得出行為,而且還額外依賴 #615
//      會員分級/#616 會員黑名單的資料——比照第 3 點的既有做法,用 page.route 直接攔截
//      `members`/`merchant_member_tiers` 這兩個 PostgREST 查詢,注入假資料驗證前端的選取/
//      排除計算邏輯跟畫面呈現是否正確,不依賴任何真實 LINE 綁定或真實建立的分級/黑名單資料。
//
// 範圍外说明(已在回報中向主腦說明):§4.1 的「測試連線成功 → 狀態卡片顯示已連線」、
// 4.5/4.6/4.7「產生的碼真的被使用完成綁定 → 狀態變成已綁定」、行銷通知頁「真的選取已綁定
// 會員發送」這幾條,都需要「真的有一個已綁定 LINE 帳號的對象」,而 merchant_line_configs/
// line_binding_codes 完全沒有開放給前端 anon/authenticated 角色的 RLS 政策、
// consume_line_binding_code 只給 service role 呼叫、merchant_staff 額外有 BEFORE UPDATE
// 觸發器擋下非 service role 的綁定欄位異動——這個測試環境(只有 publishable key)沒有辦法繞過
// Webhook 真的完成一次綁定,因此無法涵蓋。

import { expect, test } from "@playwright/test";

import {
  createPendingBooking,
  getAuthedFixtureClient,
  injectLineNotificationsFixtureSession,
  MEMBER_NAME_PREFIX,
  setupLineNotificationsFixture,
  STAFF_NAME_PREFIX,
  teardownLineNotificationsFixture,
  type LineNotificationsFixture,
} from "./support/line-notifications-fixture";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial", timeout: 60_000 });

let fixture: LineNotificationsFixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupLineNotificationsFixture();
  } catch (err) {
    setupFailed = true;
    console.error("[line-notifications] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownLineNotificationsFixture(fixture);
  console.log("[line-notifications] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(async ({ page }) => {
  await injectLineNotificationsFixtureSession(page, fixture);

  // 已知既有問題(跟這次修正主題無關,e2e/members.spec.ts 開頭同一段說明已記錄):全新瀏覽器
  // session 第一次深連結到受保護頁面時,有機會在 currentMerchantId 還沒被 context.tsx 的
  // fallback effect 寫進 localStorage 前,就先讀到 merchant === null 而被 Require*Access
  // 誤判導回 /app。先訪問一次 /app 讓「目前操作中商家」正確寫進 localStorage。
  await page.goto("/app");
  await expect(page.getByText("目前操作中的商家")).toBeVisible({ timeout: LOAD_TIMEOUT });
});

test("LINE 串接設定頁(§4.1):貼假憑證測試連線真的失敗,正確顯示錯誤訊息且不顯示解除串接按鈕", async ({
  page,
}) => {
  await page.goto("/app/line-settings");
  await expect(page.getByRole("heading", { name: "LINE 串接設定" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByText("尚未串接")).toBeVisible();

  await page.getByLabel("Channel ID *").fill(`e2e-fake-channel-id-${fixture.runId}`);
  await page.getByLabel("Channel Secret *").fill(`e2e-fake-channel-secret-${fixture.runId}`);
  await page.getByLabel("Channel Access Token *").fill(`e2e-fake-access-token-${fixture.runId}`);
  await page.getByRole("button", { name: "儲存並測試連線" }).click();

  // 這裡刻意不 mock——讓已經部署上線的 line-test-connection Edge Function 真的打一次
  // LINE 官方 API(GET /v2/bot/info),假憑證預期真的收到 401,對應規格書§0 第二段「貼一個假
  // token,確認系統正確顯示驗證失敗」的間接驗證方式。訊息同時會出現在表單下方的紅字、狀態卡片
  // 的「最後測試時間」那一行、以及一則 toast,這裡只鎖定表單下方那個紅字段落,避免 strict mode
  // 因為同一段文字出現在多處而衝突。
  await expect(page.locator("p.text-destructive")).toHaveText(
    /連線失敗|無效或已過期/,
    { timeout: LOAD_TIMEOUT },
  );
  await expect(page.getByText("尚未串接")).toBeVisible();
  await expect(page.getByRole("button", { name: "解除串接" })).toHaveCount(0);
});

test("LINE 串接設定頁(§4.1):mock 測試連線成功時正確顯示成功訊息(不依賴真實 LINE 帳號)", async ({
  page,
}) => {
  await page.route("**/functions/v1/line-test-connection", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, message: "連線成功" }),
    });
  });

  await page.goto("/app/line-settings");
  await expect(page.getByRole("heading", { name: "LINE 串接設定" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  await page.getByLabel("Channel ID *").fill(`e2e-fake-channel-id-mock-${fixture.runId}`);
  await page.getByLabel("Channel Secret *").fill(`e2e-fake-channel-secret-mock-${fixture.runId}`);
  await page.getByLabel("Channel Access Token *").fill(`e2e-fake-access-token-mock-${fixture.runId}`);
  await page.getByRole("button", { name: "儲存並測試連線" }).click();

  // 「連線成功」同時會出現在表單下方的訊息段落跟一則 toast,這裡只鎖定表單下方那一段
  // (class 帶 text-cta,對應成功訊息的樣式),避免 strict mode 因為同一段文字出現在多處而衝突。
  await expect(page.locator("p.text-cta").filter({ hasText: "連線成功" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
});

test("我的 LINE 綁定卡片(§4.5):產生綁定碼後正確顯示 6 碼數字與倒數計時", async ({ page }) => {
  await page.goto("/app/manage");
  // CardTitle 底層渲染成 <div>,不是實際的 heading 元素,這裡用 getByText 而非 getByRole。
  await expect(page.getByText("我的 LINE 綁定")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByText("未綁定")).toBeVisible();

  await page.getByRole("button", { name: "產生綁定碼" }).click();

  const codeLocator = page.locator("p.text-2xl.font-bold.tracking-widest");
  await expect(codeLocator).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(codeLocator).toHaveText(/^\d{6}$/);
  await expect(page.getByText(/剩餘時間 \d+:\d{2}/)).toBeVisible();
});

test("服務人員 LINE 綁定區塊(§4.6):編輯服務人員時可以產生綁定碼", async ({ page }) => {
  await page.goto("/app/staff");
  await expect(page.getByRole("heading", { name: "服務人員管理" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByText(STAFF_NAME_PREFIX, { exact: false })).toBeVisible();

  const staffRow = page.locator("li", { hasText: fixture.staffName });
  await staffRow.getByRole("button", { name: "編輯" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "編輯服務人員" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("LINE 綁定")).toBeVisible();
  await expect(dialog.getByText("未綁定")).toBeVisible();

  await dialog.getByRole("button", { name: "產生綁定碼" }).click();
  const codeLocator = dialog.locator("p.text-2xl.font-bold.tracking-widest");
  await expect(codeLocator).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(codeLocator).toHaveText(/^\d{6}$/);
});

test("會員 LINE 綁定區塊(§4.7):會員詳情頁可以產生綁定碼", async ({ page }) => {
  await page.goto(`/app/members/${fixture.memberId}`);
  await expect(page.getByRole("heading", { name: fixture.memberName })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // CardTitle 底層渲染成 <div>,不是實際的 heading 元素,這裡用 getByText 而非 getByRole;
  // exact:true 避免跟區塊內文字「LINE 綁定狀態」衝突。
  await expect(page.getByText("LINE 綁定", { exact: true })).toBeVisible();
  await expect(page.getByText("未綁定")).toBeVisible();

  await page.getByRole("button", { name: "產生綁定碼" }).click();
  const codeLocator = page.locator("p.text-2xl.font-bold.tracking-widest");
  await expect(codeLocator).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(codeLocator).toHaveText(/^\d{6}$/);
});

test("確認訂單通知彈窗(規則 2.5/§4.8):商家未串接 LINE 時直接確認、不顯示彈窗", async ({ page }) => {
  const { bookingId, customerPhone } = await createPendingBooking(fixture);

  await page.goto("/app/orders");
  await expect(page.getByRole("heading", { name: "訂單管理" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  const bookingRow = page.getByRole("button", { name: new RegExp(customerPhone) });
  await bookingRow.click();
  await expect(page.getByText("預約詳情")).toBeVisible({ timeout: LOAD_TIMEOUT });

  await page.getByRole("button", { name: "確認訂單" }).click();

  // 沒有任何綁定對象(商家根本沒有串接 LINE)→ 不應該出現 2.5 的通知彈窗。
  await expect(page.getByText("要透過 LINE 通知這次確認嗎?")).toHaveCount(0, {
    timeout: 3_000,
  });
  // 「已確認」這個文字同時也是 OrdersPage 上方狀態分頁籤的名稱,這裡改用 Badge 的樣式
  // class(bg-primary,對應 accepted 狀態)精準定位這一列的狀態徽章,不用純文字比對整個頁面。
  await expect(bookingRow.locator(".bg-primary", { hasText: "已確認" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  const client = await getAuthedFixtureClient(fixture);
  const { data: logs } = await client
    .from("line_notification_log")
    .select("id")
    .eq("booking_id", bookingId);
  expect(logs ?? []).toHaveLength(0);
});

test("確認訂單通知彈窗(規則 2.5/§4.8):mock 有通知目標時彈窗正確顯示,選「否」不觸發 dispatch", async ({
  page,
}) => {
  await page.route(/\/rest\/v1\/rpc\/preview_line_notification_targets/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        has_any_target: true,
        targets: [{ type: "staff", name: fixture.staffName }],
      }),
    });
  });
  let dispatchCallCount = 0;
  await page.route("**/functions/v1/line-notify-dispatch", async (route) => {
    dispatchCallCount += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  const { customerPhone } = await createPendingBooking(fixture);

  await page.goto("/app/orders");
  await expect(page.getByRole("heading", { name: "訂單管理" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  const bookingRow = page.getByRole("button", { name: new RegExp(customerPhone) });
  await bookingRow.click();
  await expect(page.getByText("預約詳情")).toBeVisible({ timeout: LOAD_TIMEOUT });

  await page.getByRole("button", { name: "確認訂單" }).click();

  await expect(page.getByText("要透過 LINE 通知這次確認嗎?")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByRole("alertdialog").getByText(new RegExp(fixture.staffName))).toBeVisible();

  await page.getByRole("button", { name: "否,只確認不通知" }).click();
  await expect(bookingRow.locator(".bg-primary", { hasText: "已確認" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 給 fire-and-forget 的呼叫一點時間,確認真的沒有被觸發(不是還沒來得及)。
  await page.waitForTimeout(1_000);
  expect(dispatchCallCount).toBe(0);
});

test("確認訂單通知彈窗(規則 2.5/§4.8):mock 有通知目標時,選「是」才會呼叫 dispatch", async ({
  page,
}) => {
  await page.route(/\/rest\/v1\/rpc\/preview_line_notification_targets/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        has_any_target: true,
        targets: [{ type: "staff", name: fixture.staffName }],
      }),
    });
  });
  let dispatchCallCount = 0;
  let dispatchBody: Record<string, unknown> | null = null;
  await page.route("**/functions/v1/line-notify-dispatch", async (route) => {
    dispatchCallCount += 1;
    dispatchBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  const { bookingId, customerPhone } = await createPendingBooking(fixture);

  await page.goto("/app/orders");
  await expect(page.getByRole("heading", { name: "訂單管理" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  const bookingRow = page.getByRole("button", { name: new RegExp(customerPhone) });
  await bookingRow.click();
  await expect(page.getByText("預約詳情")).toBeVisible({ timeout: LOAD_TIMEOUT });

  await page.getByRole("button", { name: "確認訂單" }).click();
  await expect(page.getByText("要透過 LINE 通知這次確認嗎?")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  await page.getByRole("button", { name: "是,確認並通知" }).click();
  await expect(bookingRow.locator(".bg-primary", { hasText: "已確認" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  await page.waitForTimeout(1_000);
  expect(dispatchCallCount).toBe(1);
  expect(dispatchBody).toMatchObject({
    merchant_id: fixture.merchantId,
    booking_id: bookingId,
    event_type: "booking_confirmed",
  });
});

test("LINE 通知設定頁(§4.2):切換開關並編輯文案後正確儲存,重新整理後仍然生效", async ({ page }) => {
  await page.goto("/app/line-events");
  await expect(page.getByRole("heading", { name: "LINE 通知設定" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  const createdCard = page.getByTestId("line-event-card-booking_created");
  await expect(createdCard).toBeVisible({ timeout: LOAD_TIMEOUT });
  const toggle = createdCard.getByRole("switch");

  const newTemplate = `E2E測試文案${fixture.runId} {{customer_name}}`;
  await createdCard.locator("textarea").fill(newTemplate);
  // 切一次開關(不論原本開/關,切一次再存檔,順便驗證開關本身可以正常互動)。
  await toggle.click();
  await createdCard.getByRole("button", { name: "儲存" }).click();
  await expect(page.getByText("已儲存通知設定")).toBeVisible({ timeout: LOAD_TIMEOUT });

  await page.reload();
  await expect(page.getByRole("heading", { name: "LINE 通知設定" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  const reloadedCard = page.getByTestId("line-event-card-booking_created");
  await expect(reloadedCard.locator("textarea")).toHaveValue(newTemplate);
});

test("行銷通知頁(§4.4):沒有任何會員完成 LINE 綁定時顯示對應的空狀態文字", async ({ page }) => {
  await page.goto("/app/line-marketing");
  await expect(page.getByRole("heading", { name: "行銷通知" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByText("目前沒有任何會員完成 LINE 綁定。")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByRole("button", { name: "發送" })).toBeDisabled();

  void MEMBER_NAME_PREFIX;
});

test("行銷通知頁(§10.1,SPECS-INDEX #584):可用變數說明 + 即時預覽正確顯示", async ({ page }) => {
  await page.goto("/app/line-marketing");
  await expect(page.getByRole("heading", { name: "行銷通知" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // §10.1 要求複用 §4.2/§385 既有的「可用變數說明 + 即時預覽」UI 模式。
  await expect(page.getByText("可用變數:", { exact: false })).toBeVisible();
  await expect(page.getByText("{{member_name}}", { exact: false })).toBeVisible();

  const textarea = page.locator("textarea");
  await textarea.fill("{{member_name}} 您好,本月有優惠活動");

  await expect(page.getByText("即時預覽(套用範例假資料)")).toBeVisible();
  await expect(page.getByText("王小姐 您好,本月有優惠活動")).toBeVisible();
});

// §10.2(SPECS-INDEX #612)假資料:3 位 VIP 等級會員(其中 1 位同時是黑名單)+ 1 位一般等級會員,
// 全部都是「已綁定 LINE」(這個測試環境沒辦法真的做出已綁定 LINE 的會員,見檔案開頭第 6 點說明,
// 直接用 page.route 攔截 members/merchant_member_tiers 這兩個 PostgREST 查詢注入假資料)。
const TIER_TEST_TIERS = [
  { id: "tier-vip", merchant_id: "mock", name: "VIP會員", sort_order: 0, status: "active" },
  { id: "tier-general", merchant_id: "mock", name: "一般會員", sort_order: 1, status: "active" },
];
const TIER_TEST_MEMBERS = [
  { id: "vip-1", name: "VIP會員一", phone: "0911111111", tier_id: "tier-vip", is_blacklisted: false },
  { id: "vip-2", name: "VIP會員二", phone: "0922222222", tier_id: "tier-vip", is_blacklisted: false },
  {
    id: "vip-blacklist",
    name: "VIP黑名單會員",
    phone: "0933333333",
    tier_id: "tier-vip",
    is_blacklisted: true,
  },
  {
    id: "general-1",
    name: "一般會員一",
    phone: "0944444444",
    tier_id: "tier-general",
    is_blacklisted: false,
  },
];

async function mockTierAndMemberQueries(page: import("@playwright/test").Page) {
  await page.route(/\/rest\/v1\/members\?/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("line_bound") === "eq.true") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(TIER_TEST_MEMBERS),
      });
      return;
    }
    await route.continue();
  });
  await page.route(/\/rest\/v1\/merchant_member_tiers\?/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(TIER_TEST_TIERS),
    });
  });
}

test("行銷通知頁(§10.2,SPECS-INDEX #612):依會員分類批量選擇正確整批勾選該分類的會員,黑名單會員即使被批量選中也自動從最終送出名單排除", async ({
  page,
}) => {
  await mockTierAndMemberQueries(page);

  await page.goto("/app/line-marketing");
  await expect(page.getByRole("heading", { name: "行銷通知" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  await page.getByRole("tab", { name: "依會員分類批量選擇" }).click();
  const tierList = page.getByTestId("line-marketing-tier-list");
  await expect(tierList.getByText("VIP會員")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(tierList.getByText("3 位已綁定 LINE 的會員")).toBeVisible();

  await tierList.getByRole("checkbox").first().click();

  // 目前選取(尚未扣除排除清單/黑名單)應該是這個等級的 3 位全部整批選入。
  await expect(page.getByText("目前選取 3 位會員", { exact: false })).toBeVisible();
  // 實際會送出要扣掉黑名單會員(vip-blacklist),所以是 2 位。
  await expect(page.getByText("實際會送出 2 位會員", { exact: false })).toBeVisible();

  // 切回單獨選擇分頁,確認這個等級的 3 位會員(包含黑名單那一位)都已經被勾選,且黑名單那一位
  // 有清楚標示「將自動從送出名單排除」。
  await page.getByRole("tab", { name: "單獨選擇" }).click();
  const individualList = page.getByTestId("line-marketing-individual-list");
  const vip1Row = individualList.locator("li", { hasText: "VIP會員一" });
  await expect(vip1Row.getByRole("checkbox")).toBeChecked();
  const blacklistRow = individualList.locator("li", { hasText: "VIP黑名單會員" });
  await expect(blacklistRow.getByRole("checkbox")).toBeChecked();
  await expect(blacklistRow.getByText("將自動從送出名單排除", { exact: false })).toBeVisible();
  const generalRow = individualList.locator("li", { hasText: "一般會員一" });
  await expect(generalRow.getByRole("checkbox")).not.toBeChecked();
});

test("行銷通知頁(§10.2,SPECS-INDEX #612):黑名單客戶預設自動排除且不出現在手動排除清單裡,手動排除清單正確把選中的會員從最終送出名單移除", async ({
  page,
}) => {
  await mockTierAndMemberQueries(page);

  await page.goto("/app/line-marketing");
  await expect(page.getByRole("heading", { name: "行銷通知" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 黑名單會員(§10.2 排除清單「系統自動排除」區塊)唯讀顯示,不出現在下面「手動排除」的可勾選
  // 清單裡(避免同一個人同時出現在兩個排除區塊造成混淆)。
  const blacklistSection = page.getByTestId("line-marketing-blacklist-list");
  await expect(blacklistSection.getByText("VIP黑名單會員")).toBeVisible({ timeout: LOAD_TIMEOUT });
  const manualExcludeList = page.getByTestId("line-marketing-manual-exclude-list");
  await expect(manualExcludeList.getByText("VIP黑名單會員")).toHaveCount(0);

  // 單獨選擇 VIP會員一 + 一般會員一,尚未排除時實際會送出 2 位。
  const individualList = page.getByTestId("line-marketing-individual-list");
  await individualList.locator("li", { hasText: "VIP會員一" }).getByRole("checkbox").click();
  await individualList.locator("li", { hasText: "一般會員一" }).getByRole("checkbox").click();
  await expect(page.getByText("實際會送出 2 位會員", { exact: false })).toBeVisible();

  // 在手動排除清單裡勾選 VIP會員一,最終送出名單應該只剩一般會員一(1 位)。
  await manualExcludeList
    .locator("li", { hasText: "VIP會員一" })
    .getByRole("checkbox")
    .click();
  await expect(page.getByText("實際會送出 1 位會員", { exact: false })).toBeVisible();
});
