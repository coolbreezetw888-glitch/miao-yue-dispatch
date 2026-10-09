// 「服務人員新增編輯訂單 第 7 批」(#977)本機 e2e。
// 規格書:.project/specs/服務人員新增編輯訂單-第7批.md 第六節 6-4(方案 A1、B2,料錢不顯示)。
// 只連本機 Docker 的 Supabase(`npm run test:e2e:local`),瀏覽器一律 Playwright headless;
// 每一條都斷言「這一頁只打本機」(request-guard)。
//
//   E1 服務人員 S 在時間軸點空白格 → 新增預約 → 送出 → 時間軸出現色塊、待確認;資料庫:主要 = S、沒有協助人員、
//      created_by_role = staff、操作紀錄是 S 的名字
//   E2 S 關閉一格時段 → 商家端(get_merchant_day_schedule)同格變例外關閉;再開啟 → 恢復
//   E3 S 編輯 B1(有協助人員)改成自訂總金額送出 → 協助人員還在、金額已改
//   E4 S 取消 B2、標記完成 B3;協助人員 A 打開 B1 沒有任何新按鈕
//   E5 S 用滑鼠拖 B4 往下兩格 → 改到 18:00;按「復原」→ 回到 17:00
//   E6 開關關閉的 OFF:時間軸點格子沒有選單、詳情沒有新按鈕
//   E7 方案 B2:月薪制 M 點空白格只有「新增預約」,沒有「開啟 / 關閉時段」
//   E8 商家編輯服務人員畫面:兩種連動小卡窗(取消不變 / 確認一起變)
//   E9 手機 375 寬:時間軸直向捲動不誤開選單;選單、建單畫面、編輯畫面排得下(截圖存 test-results)
import { mkdirSync } from "node:fs";

import { devices, expect, test, type Browser, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import { expectOnlyLocalRequests, recordRequestHosts } from "./support/request-guard";
import {
  CUSTOMER_B1,
  CUSTOMER_B2,
  CUSTOMER_B3,
  CUSTOMER_B4,
  CUSTOMER_B5,
  injectSession,
  ITEM_NAME,
  serviceClient,
  setupStaffOrderFixture,
  teardownStaffOrderFixture,
  type StaffOrderFixture,
} from "./support/staff-order-fixture";

const LOAD_TIMEOUT = 20_000;
const SHOT_DIR = "test-results/req977-batch7-shots";

test.describe.configure({ mode: "serial" });

let fixture: StaffOrderFixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupStaffOrderFixture();
  } catch (err) {
    setupFailed = true;
    throw err;
  }
  mkdirSync(SHOT_DIR, { recursive: true });
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownStaffOrderFixture(fixture);
  console.log(
    "[服務人員下單第7批] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"),
  );
});

/** 服務人員登入 → 行事曆 → 選明天 → 切到「時間軸格線」。 */
async function openStaffTimeline(page: Page, session: StaffOrderFixture["s"]["session"]) {
  await injectSession(page, session);
  await page.goto("/app");
  await page.goto("/app/calendar");
  await page.locator(`button[data-date-key="${fixture.dateKey}"]`).click({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.getByRole("button", { name: "時間軸格線" }).click();
  await expect(page.getByTestId("my-timeline-grid")).toBeVisible({ timeout: LOAD_TIMEOUT });
}

function slot(page: Page, time: string) {
  return page.getByRole("button", { name: new RegExp(`^${time} (可預約|不可預約)$`) });
}

async function mobilePage(browser: Browser) {
  const iphone = devices["iPhone SE (3rd gen)"];
  const context = await browser.newContext({
    viewport: { width: 375, height: 667 },
    userAgent: iphone.userAgent,
    deviceScaleFactor: iphone.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    timezoneId: "Asia/Taipei",
  });
  return { context, page: await context.newPage() };
}

test("E1 服務人員在時間軸點空白格 → 新增預約 → 送出;資料庫記成服務人員本人", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await openStaffTimeline(page, fixture.s.session);
  const grid = page.getByTestId("my-timeline-grid");
  await expect(grid).toHaveAttribute("data-interactive", "true");

  await slot(page, "09:00").click();
  await page.getByRole("menuitem", { name: "新增預約" }).click();
  const form = page.getByRole("dialog");
  await expect(form.getByText("新增預約").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(form.getByTestId("booking-form-staff-readonly")).toContainText(fixture.s.name);
  await expect(form.locator("#booking-staff")).toHaveCount(0);
  await expect(form.getByTestId("booking-form-assistants")).toHaveCount(0);
  await expect(form.getByText("料錢成本")).toHaveCount(0);

  await form.locator("#booking-customer-name").fill("E2E第7批自建客戶");
  await form.locator("#booking-customer-phone").fill(`09${fixture.runId.slice(-8)}`);
  await form.locator("#booking-service-items").click();
  const picker = page.getByTestId("service-item-picker");
  await picker.getByRole("checkbox", { name: new RegExp(ITEM_NAME) }).click();
  await picker.getByRole("button", { name: /^確認/ }).click();
  await form.locator("#booking-payment-method").click();
  await page.getByRole("option", { name: fixture.paymentMethodName }).click();
  await form.getByRole("button", { name: "建立預約" }).click();
  await expect(page.getByText(/已送出訂單/).first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(grid.getByText("E2E第7批自建客戶")).toBeVisible({ timeout: LOAD_TIMEOUT });

  const svc = serviceClient();
  const b = await svc
    .from("bookings")
    .select("id,staff_id,status,created_by_role,created_by_user_id")
    .eq("merchant_id", fixture.merchantId)
    .eq("customer_name", "E2E第7批自建客戶")
    .single();
  expect(b.data).toMatchObject({
    staff_id: fixture.s.staffId,
    status: "pending_confirmation",
    created_by_role: "staff",
    created_by_user_id: fixture.s.userId,
  });
  const assistants = await svc
    .from("booking_assistants")
    .select("staff_id")
    .eq("booking_id", b.data!.id);
  expect(assistants.data).toEqual([]);
  const log = await svc
    .from("booking_status_change_logs")
    .select("actor_role_snapshot,actor_name_snapshot")
    .eq("booking_id", b.data!.id)
    .single();
  expect(log.data).toEqual({ actor_role_snapshot: "staff", actor_name_snapshot: fixture.s.name });
  // 商家端「建立者」也認得服務人員(7-15)。
  const names = await fixture.admin.rpc("get_booking_actor_names", {
    p_merchant_id: fixture.merchantId,
    p_user_ids: [fixture.s.userId],
  });
  expect((names.data as { display_name: string }[])[0]?.display_name).toBe(fixture.s.name);
  expectOnlyLocalRequests(recorder);
});

test("E2 服務人員關閉 / 再開啟自己的一格時段,商家端同格跟著變", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await openStaffTimeline(page, fixture.s.session);
  await slot(page, "15:00").click();
  await page.getByRole("menuitem", { name: "關閉時段" }).click();
  await expect(page.getByText("已關閉這個時段")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(slot(page, "15:00")).toHaveAttribute("data-slot-state", "override-closed", {
    timeout: LOAD_TIMEOUT,
  });
  const schedule = async () => {
    const r = await fixture.admin.rpc("get_merchant_day_schedule", {
      p_merchant_id: fixture.merchantId,
      p_date: fixture.dateKey,
    });
    const staff = (
      r.data as {
        staff: {
          staff_id: string;
          availability_overrides: { start_time: string; is_available: boolean }[];
        }[];
      }
    ).staff;
    return staff.find((x) => x.staff_id === fixture.s.staffId)!.availability_overrides;
  };
  expect(await schedule()).toEqual([
    expect.objectContaining({ start_time: "15:00:00", is_available: false }),
  ]);

  await slot(page, "15:00").click();
  await page.getByRole("menuitem", { name: "開啟時段" }).click();
  await expect(page.getByText("已開啟這個時段")).toBeVisible({ timeout: LOAD_TIMEOUT });
  // #1004(第 14 批):再開啟 = 回到每週時段原本的狀態 ⇒ 刪掉例外(白色 available),
  // 不再留一筆 is_available=true 的「例外開啟」(畫成淡紫底 + 紫框,使用者回報的 bug)。
  await expect(slot(page, "15:00")).toHaveAttribute("data-slot-state", "available", {
    timeout: LOAD_TIMEOUT,
  });
  expect(await schedule()).toEqual([]);
  expectOnlyLocalRequests(recorder);
});

test("E3 服務人員編輯有協助人員的單、改金額 → 協助人員原樣保留、金額已改", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await openStaffTimeline(page, fixture.s.session);
  await page.getByTestId("my-timeline-grid").getByText(CUSTOMER_B1).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("staff-edit-booking-button").click();
  const form = page.getByRole("dialog");
  await expect(form.getByTestId("booking-form-assistants-readonly")).toContainText(
    `${fixture.a.name}（由商家指派）`,
    { timeout: LOAD_TIMEOUT },
  );
  await form.getByRole("switch", { name: "自訂總金額" }).click();
  await form.locator("#booking-custom-total").fill("999");
  // 紅利預覽要等「這份輸入」算完才能送(畫面上的數字過期時送出會被擋下並提示,跟客服一樣)。
  await expect(form.getByText("最終金額")).toBeVisible();
  await page.waitForTimeout(1500);
  await form.getByRole("button", { name: "儲存變更" }).click();
  // 有自訂總金額 + 紅利功能開著(商家預設)⇒ 送出前跳「請確認這筆訂單的派點數」小卡窗(跟客服一樣,裁決 7)。
  const confirmPoints = page.getByRole("alertdialog").getByRole("button", { name: "確認送出" });
  await expect(confirmPoints).toBeEnabled({ timeout: LOAD_TIMEOUT });
  await confirmPoints.click();
  await expect(page.getByText("已更新預約")).toBeVisible({ timeout: LOAD_TIMEOUT });

  const svc = serviceClient();
  const b = await svc
    .from("bookings")
    .select("final_amount_snapshot,staff_id")
    .eq("id", fixture.bookings.b1)
    .single();
  expect(Number(b.data!.final_amount_snapshot)).toBe(999);
  expect(b.data!.staff_id).toBe(fixture.s.staffId);
  const assistants = await svc
    .from("booking_assistants")
    .select("staff_id")
    .eq("booking_id", fixture.bookings.b1);
  expect(assistants.data).toEqual([{ staff_id: fixture.a.staffId }]);
  expectOnlyLocalRequests(recorder);
});

test("E4 取消 / 標記完成自己的單;協助人員打開別人的單沒有按鈕", async ({ page, browser }) => {
  const recorder = recordRequestHosts(page);
  await openStaffTimeline(page, fixture.s.session);
  const grid = page.getByTestId("my-timeline-grid");

  await grid.getByText(CUSTOMER_B2).click();
  await page.getByTestId("staff-cancel-booking-button").click();
  const confirm = page.getByRole("alertdialog");
  await confirm.getByPlaceholder("取消原因(選填)").fill("客人改期");
  await confirm.getByRole("button", { name: "確定取消" }).click();
  await expect(page.getByText("已取消預約")).toBeVisible({ timeout: LOAD_TIMEOUT });

  await grid.getByText(CUSTOMER_B3).click();
  await page.getByTestId("staff-complete-booking-button").click();
  await expect(page.getByText("已標記完成")).toBeVisible({ timeout: LOAD_TIMEOUT });

  const svc = serviceClient();
  const rows = await svc
    .from("bookings")
    .select("id,status,cancelled_reason")
    .in("id", [fixture.bookings.b2, fixture.bookings.b3]);
  const byId = new Map((rows.data ?? []).map((r) => [r.id as string, r]));
  expect(byId.get(fixture.bookings.b2)).toMatchObject({
    status: "cancelled",
    cancelled_reason: "客人改期",
  });
  expect(byId.get(fixture.bookings.b3)).toMatchObject({ status: "completed" });

  // 已完成的單:方案 A1 ⇒ 常駐說明、沒有按鈕
  await grid.getByText(CUSTOMER_B3).click();
  await expect(page.getByTestId("staff-cannot-reverse-note")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByTestId("staff-cancel-booking-button")).toHaveCount(0);
  expectOnlyLocalRequests(recorder);

  // 協助人員 A
  const context = await browser.newContext({ timezoneId: "Asia/Taipei" });
  const pageA = await context.newPage();
  const recorderA = recordRequestHosts(pageA);
  await openStaffTimeline(pageA, fixture.a.session);
  await pageA.getByTestId("my-timeline-grid").getByText(CUSTOMER_B1).click();
  await expect(pageA.getByRole("dialog").getByText("協助", { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(pageA.getByTestId("staff-cancel-booking-button")).toHaveCount(0);
  await expect(pageA.getByTestId("staff-edit-booking-button")).toHaveCount(0);
  await expect(pageA.getByTestId("staff-complete-booking-button")).toHaveCount(0);
  expectOnlyLocalRequests(recorderA);
  await context.close();
});

test("E5 滑鼠拖自己的待確認單往下兩格 → 改到 18:00;按「復原」→ 回到 17:00", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await openStaffTimeline(page, fixture.s.session);
  const block = page.getByTestId(`booking-block-${fixture.bookings.b4}-main`);
  await expect(block).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(block).toHaveAttribute("data-booking-draggable", "true");
  await page.evaluate(() => {
    const w = window as unknown as { __toasts?: string[] };
    w.__toasts = [];
    new MutationObserver(() => {
      document.querySelectorAll("[data-sonner-toast]").forEach((el) => {
        const t = (el.textContent ?? "").trim();
        if (t && !w.__toasts!.includes(t)) w.__toasts!.push(t);
      });
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  // 17:00 在畫面下方 ⇒ 先捲進畫面再量座標(boundingBox 是相對視窗)。
  await block.scrollIntoViewIfNeeded();
  const box = (await block.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + 6 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 12);
  await page.mouse.move(start.x, start.y + 60, { steps: 8 });
  await page.mouse.up();
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: /改到 18:00/ });
  await expect
    .poll(
      () => page.evaluate(() => (window as unknown as { __toasts?: string[] }).__toasts ?? []),
      { timeout: LOAD_TIMEOUT, message: "拖拉放開後應該出現「改到 18:00」的提示" },
    )
    .toContainEqual(expect.stringMatching(/改到 18:00/));
  await expect(toast).toBeVisible();

  const svc = serviceClient();
  const startAt = async () =>
    (await svc.from("bookings").select("start_at,staff_id").eq("id", fixture.bookings.b4).single())
      .data!;
  await expect
    .poll(async () => new Date((await startAt()).start_at).getTime())
    .toBe(new Date(`${fixture.dateKey}T18:00:00+08:00`).getTime());
  expect((await startAt()).staff_id).toBe(fixture.s.staffId);

  await toast.getByRole("button", { name: "復原" }).click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "已復原" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect
    .poll(async () => new Date((await startAt()).start_at).getTime())
    .toBe(new Date(`${fixture.dateKey}T17:00:00+08:00`).getTime());
  expectOnlyLocalRequests(recorder);
});

test("E6 開關關閉的服務人員:時間軸沒有可點的格子,詳情沒有新按鈕", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await openStaffTimeline(page, fixture.off.session);
  const grid = page.getByTestId("my-timeline-grid");
  await expect(grid).not.toHaveAttribute("data-interactive", "true");
  await expect(page.getByRole("button", { name: /^\d\d:\d\d (可預約|不可預約)$/ })).toHaveCount(0);
  await grid.getByText(CUSTOMER_B5).click();
  await expect(page.getByRole("dialog").getByText("預約詳情")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByTestId("staff-cancel-booking-button")).toHaveCount(0);
  await expect(page.getByTestId("staff-edit-booking-button")).toHaveCount(0);
  expectOnlyLocalRequests(recorder);
});

test("E7 方案 B2:月薪制服務人員點空白格只有「新增預約」,沒有開關時段", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await openStaffTimeline(page, fixture.m.session);
  await slot(page, "10:00").click();
  await expect(page.getByRole("menuitem", { name: "新增預約" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByRole("menuitem", { name: /時段/ })).toHaveCount(0);
  expectOnlyLocalRequests(recorder);
});

test("E8 商家編輯服務人員:兩種連動小卡窗(取消不變 / 確認一起變)", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
  await page.goto("/app/staff");
  const card = page.locator("li").filter({ hasText: fixture.off.name });
  await card.getByRole("button", { name: "編輯" }).click({ timeout: LOAD_TIMEOUT });
  const orders = page.getByRole("switch", { name: /服務人員新增編輯訂單/ });
  const member = page.getByRole("switch", { name: /服務人員是否顯示會員資料/ });
  await expect(orders).toHaveAttribute("data-state", "unchecked", { timeout: LOAD_TIMEOUT });
  await expect(
    page.getByText("服務人員新增編輯訂單").locator("..").getByText("即將推出"),
  ).toHaveCount(0);

  // ① 打開「新增編輯訂單」→ 小卡窗 → 取消 ⇒ 兩個都不變
  await orders.click();
  const confirm = page.getByTestId("order-switch-confirm");
  await expect(confirm).toContainText("要一起開啟「服務人員是否顯示會員資料」嗎？");
  await confirm.getByRole("button", { name: "取消" }).click();
  await expect(orders).toHaveAttribute("data-state", "unchecked");
  await expect(member).toHaveAttribute("data-state", "unchecked");
  // ② 再打開 → 一起開啟 ⇒ 兩個都開
  await orders.click();
  await page.getByTestId("order-switch-confirm").getByRole("button", { name: "一起開啟" }).click();
  await expect(orders).toHaveAttribute("data-state", "checked");
  await expect(member).toHaveAttribute("data-state", "checked");
  // ③ 關「顯示會員資料」→ 小卡窗 → 取消 ⇒ 不變;再關 → 一起關閉 ⇒ 兩個都關
  await member.click();
  await expect(page.getByTestId("order-switch-confirm")).toContainText(
    "要一起關閉「服務人員新增編輯訂單」嗎？",
  );
  await page.getByTestId("order-switch-confirm").getByRole("button", { name: "取消" }).click();
  await expect(member).toHaveAttribute("data-state", "checked");
  await member.click();
  await page.getByTestId("order-switch-confirm").getByRole("button", { name: "一起關閉" }).click();
  await expect(orders).toHaveAttribute("data-state", "unchecked");
  await expect(member).toHaveAttribute("data-state", "unchecked");
  // 只改表單,沒按儲存 ⇒ 資料庫不變
  const row = await serviceClient()
    .from("merchant_staff")
    .select("can_create_edit_orders,show_member_info")
    .eq("id", fixture.off.staffId)
    .single();
  expect(row.data).toEqual({ can_create_edit_orders: false, show_member_info: false });
  expectOnlyLocalRequests(recorder);
});

test("E9 手機 375 寬:直向捲動不誤開選單;選單、建單、編輯畫面排得下(截圖)", async ({ browser }) => {
  const { context, page } = await mobilePage(browser);
  const recorder = recordRequestHosts(page);
  try {
    await openStaffTimeline(page, fixture.s.session);
    const cell = slot(page, "10:00");
    await cell.scrollIntoViewIfNeeded();
    const box = (await cell.boundingBox())!;
    const cdp = await context.newCDPSession(page);
    const from = { x: box.x + 30, y: box.y + box.height / 2 };
    // #1049:時間軸改成自己一個捲動框(24 小時),手指直向滑先捲的是那個框;頁面捲動也算(兩者相加)。
    const scrolled = () =>
      page.evaluate(
        () =>
          window.scrollY +
          (document.querySelector<HTMLElement>('[data-testid="my-timeline-scroll"]')?.scrollTop ??
            0),
      );
    const before = await scrolled();
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: from.x, y: from.y }],
    });
    for (let i = 1; i <= 8; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: from.x, y: from.y - 25 * i }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect
      .poll(async () => (await scrolled()) - before, { timeout: 5_000 })
      .toBeGreaterThan(40);
    await page.waitForTimeout(500);
    await expect(page.getByRole("menu")).toHaveCount(0);

    await slot(page, "10:00").tap();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible({ timeout: 5_000 });
    const mbox = (await menu.boundingBox())!;
    expect(mbox.x).toBeGreaterThanOrEqual(0);
    expect(mbox.x + mbox.width).toBeLessThanOrEqual(375);
    await page.screenshot({ path: `${SHOT_DIR}/375-timeline-slot-menu.png` });

    await page.getByRole("menuitem", { name: "新增預約" }).tap();
    await expect(page.getByTestId("booking-form-staff-readonly")).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOT_DIR}/375-create-form-staff-mode.png` });
    await page.getByRole("button", { name: "取消" }).first().tap();

    await page.getByTestId("my-timeline-grid").getByText(CUSTOMER_B1).tap();
    await page.getByTestId("staff-edit-booking-button").tap();
    await expect(page.getByTestId("booking-form-assistants-readonly")).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    const overflow2 = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow2).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOT_DIR}/375-edit-form-staff-mode.png` });
    expectOnlyLocalRequests(recorder);
  } finally {
    await context.close();
  }
});

// 保留供 B4 的客戶名稱在檔內被引用(拖拉用 testid 定位)。
void CUSTOMER_B4;
