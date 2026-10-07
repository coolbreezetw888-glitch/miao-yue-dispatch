// SPECS-INDEX #873「移除協助人員不該連主服務人員的訂單一起取消」本機 e2e。
// **只在本機跑**:`npm run test:e2e:local`(playwright.local.config.ts,只連本機 Docker;Playwright 自己開
// 獨立 headless Chromium,不碰使用者的瀏覽器)。fixture 見 e2e-local/support/assistant-removal-fixture.ts 檔頭。
//
//   E1:行事曆點「(協助)」色塊 → 詳情只有「移除協助人員」(沒有「取消預約」)→ 確定移除 → 擋流程二選一
//       (Esc / 點背景關不掉)→「維持現狀」⇒ 訂單仍是已確認、主服務人員 / 時間 / 金額不變、協助人員 0 位;
//       行事曆上協助卡消失、主卡還在;整個過程沒有打 cancel_booking、沒有打任何通知 Edge Function。
//   E2:同上但按「再加助手」⇒ 打開這張單的編輯表單、助手欄位在畫面內;加一位新助手儲存 ⇒ 寫進資料庫,
//       而且「換人」不會再跳一次提示。
//   E2b:從主卡打開(維持原樣有「取消預約」)→ 編輯 → 把助手取消勾選後儲存 ⇒ 一樣跳擋流程提示,
//       Esc 關不掉,「維持現狀」後訂單仍是已確認、協助人員 0 位。
//   E3:主服務人員被移除(管理員改 status=removed,跟前端 removeMerchantStaff 同一個寫法)⇒ 協助人員那一欄
//       不再殘留「(協助)」卡,資料庫協助人員 0 位。
//
// 故障注入:把 BookingDetailDialog 的 handleRemoveAssistant 改回呼叫 cancelBooking ⇒ E1 轉紅(見回報)。
import { expect, test, type Locator, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import {
  injectSession,
  readBookingState,
  removeStaffAsAdmin,
  setupAssistantRemovalFixture,
  teardownAssistantRemovalFixture,
  type AssistantRemovalFixture,
} from "./support/assistant-removal-fixture";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";

const LOAD_TIMEOUT = 20_000;
const SHOT_DIR = process.env["E2E_SHOT_DIR"] ?? "test-results";

test.use({ viewport: { width: 1280, height: 800 }, timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "serial", timeout: 90_000 });

let fixture: AssistantRemovalFixture;
let setupFailed = false;
let recorder: RequestRecorder | null = null;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  try {
    fixture = await setupAssistantRemovalFixture();
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  if (setupFailed || !fixture) return;
  const actions = await teardownAssistantRemovalFixture(fixture);
  console.log("[assistant-removal 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.afterEach(() => {
  if (recorder) expectOnlyLocalRequests(recorder);
  recorder = null;
});

/** 記下所有 RPC / Edge Function 呼叫的路徑。 */
function trackCalls(page: Page): string[] {
  const calls: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("/rest/v1/rpc/") || url.includes("/functions/v1/")) {
      calls.push(new URL(url).pathname);
    }
  });
  return calls;
}

async function openCalendar(page: Page): Promise<void> {
  recorder = recordRequestHosts(page);
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page);
  await page.goto(`/app/calendar?date=${fixture.dateKey}`);
  await page
    .getByRole("radiogroup", { name: "檢視模式" })
    .getByRole("radio", { name: "週檢視" })
    .click({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("calendar-day-grid")).toBeVisible({ timeout: LOAD_TIMEOUT });
}

function block(page: Page, bookingId: string, role: "main" | "assistant"): Locator {
  return page.getByTestId(`booking-block-${bookingId}-${role}`);
}

async function removeFromAssistantBlock(page: Page, bookingId: string): Promise<Locator> {
  const assistantBlock = block(page, bookingId, "assistant");
  await expect(assistantBlock).toBeVisible({ timeout: LOAD_TIMEOUT });
  await assistantBlock.scrollIntoViewIfNeeded();
  await assistantBlock.click();
  const removeBtn = page.getByRole("button", { name: "移除協助人員" });
  await expect(removeBtn).toBeVisible({ timeout: LOAD_TIMEOUT });
  // 成因修正:從協助卡打開的詳情沒有「取消預約」。
  await expect(page.getByRole("button", { name: "取消預約" })).toHaveCount(0);
  await expect(page.getByTestId("opened-as-assistant-note")).toBeVisible();
  await removeBtn.click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("從這張訂單移除嗎");
  await confirm.getByRole("button", { name: "確定移除" }).click();
  const prompt = page.getByTestId("assistant-removed-prompt");
  await expect(prompt).toBeVisible({ timeout: LOAD_TIMEOUT });
  return prompt;
}

test("E1 從協助卡移除 → 擋流程提示關不掉 → 維持現狀:主服務人員的單完全不變", async ({ page }) => {
  const r1 = fixture.bookings.r1;
  const before = await readBookingState(r1.id);
  await openCalendar(page);
  const calls = trackCalls(page);
  await expect(block(page, r1.id, "main")).toBeVisible({ timeout: LOAD_TIMEOUT });

  const prompt = await removeFromAssistantBlock(page, r1.id);
  await expect(prompt).toContainText("已移除協助人員");
  await expect(prompt).toContainText(
    `${fixture.staffNames[1]} 已從這張訂單移除，主服務人員 ${fixture.staffNames[0]} 的訂單維持不變。要再加一位協助人員嗎？`,
  );
  await page.screenshot({ path: `${SHOT_DIR}/req873-E1-prompt-1280.png` });

  // 擋流程:Esc、點背景都關不掉。
  await page.keyboard.press("Escape");
  await expect(prompt).toBeVisible();
  await page.mouse.click(8, 400);
  await expect(prompt).toBeVisible();
  // 第 11 批 J(#995 J-8):必須選一個 ⇒ 這個確認窗上方沒有「點了取消」的空白條,點它上方也關不掉。
  await expect(page.locator("[data-overlay-dismiss-strip]")).toHaveCount(0);
  {
    const p = await prompt.boundingBox();
    await page.mouse.click(p!.x + p!.width / 2, p!.y - 24);
    await expect(prompt).toBeVisible();
  }

  // 手機寬度下小卡窗不超出畫面。
  await page.setViewportSize({ width: 375, height: 667 });
  const box = await prompt.boundingBox();
  expect(box, "量得到提示框").not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  await page.screenshot({ path: `${SHOT_DIR}/req873-E1-prompt-375.png` });
  await page.setViewportSize({ width: 1280, height: 800 });

  // 這時移除已經生效(不是等按鈕才生效)。
  const afterRemove = await readBookingState(r1.id);
  expect(afterRemove.assistantStaffIds).toEqual([]);

  await prompt.getByRole("button", { name: "維持現狀" }).click();
  await expect(prompt).toHaveCount(0);

  const after = await readBookingState(r1.id);
  expect(after.status, "訂單沒有被取消").toBe("accepted");
  expect(after.staffId).toBe(before.staffId);
  expect(after.startAt).toBe(before.startAt);
  expect(after.finalAmount).toBe(before.finalAmount);
  expect(after.assistantStaffIds).toEqual([]);

  await expect(block(page, r1.id, "assistant")).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  await expect(block(page, r1.id, "main")).toBeVisible();

  expect(calls.filter((c) => c.endsWith("/rpc/remove_booking_assistant"))).toHaveLength(1);
  expect(
    calls.filter((c) => c.endsWith("/rpc/cancel_booking")),
    "不可以呼叫取消",
  ).toEqual([]);
  expect(
    calls.filter((c) => c.includes("/functions/v1/")),
    "不可以發任何通知",
  ).toEqual([]);
});

test("E2 從協助卡移除 → 再加助手:進到編輯表單的助手欄位,加新助手儲存成功", async ({ page }) => {
  const r2 = fixture.bookings.r2;
  await openCalendar(page);
  const calls = trackCalls(page);
  const prompt = await removeFromAssistantBlock(page, r2.id);
  expect((await readBookingState(r2.id)).assistantStaffIds).toEqual([]);

  await prompt.getByRole("button", { name: "再加助手" }).click();
  await expect(prompt).toHaveCount(0);
  await expect(page.getByText("編輯預約")).toBeVisible({ timeout: LOAD_TIMEOUT });
  const assistantsField = page.getByTestId("booking-form-assistants");
  await expect(assistantsField).toBeInViewport({ timeout: LOAD_TIMEOUT });
  await page.screenshot({ path: `${SHOT_DIR}/req873-E2-add-assistant-form.png` });

  // 加第 2 位服務人員當新助手(那一位 13:00 沒有其他預約)。
  const newAssistantName = fixture.staffNames[1] as string;
  await assistantsField.getByRole("button", { name: newAssistantName }).click();
  await page.getByRole("button", { name: "儲存變更" }).click();
  await expect(page.getByText("編輯預約")).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  // 這次是「加人」不是「拿掉人」⇒ 不會再跳提示。
  await expect(page.getByTestId("assistant-removed-prompt")).toHaveCount(0);

  const after = await readBookingState(r2.id);
  expect(after.status).toBe("accepted");
  expect(after.staffId).toBe(r2.primaryStaffId);
  expect(after.assistantStaffIds).toEqual([fixture.staffIds[1]]);
  expect(calls.filter((c) => c.endsWith("/rpc/cancel_booking"))).toEqual([]);
});

test("E2b 編輯表單把助手拿掉儲存 → 一樣跳擋流程提示,維持現狀後訂單仍有效", async ({ page }) => {
  const r2 = fixture.bookings.r2;
  // 前提:E2 已經把第 2 位服務人員加成 R2 的助手。
  expect((await readBookingState(r2.id)).assistantStaffIds).toEqual([fixture.staffIds[1]]);
  await openCalendar(page);
  const calls = trackCalls(page);
  const mainBlock = block(page, r2.id, "main");
  await expect(mainBlock).toBeVisible({ timeout: LOAD_TIMEOUT });
  await mainBlock.scrollIntoViewIfNeeded();
  await mainBlock.click();
  // 從主卡打開:維持原樣,有「取消預約」、沒有「移除協助人員」。
  await expect(page.getByRole("button", { name: "取消預約" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByRole("button", { name: "移除協助人員" })).toHaveCount(0);
  await page.getByRole("button", { name: "編輯", exact: true }).click();
  const assistantsField = page.getByTestId("booking-form-assistants");
  await expect(assistantsField).toBeVisible({ timeout: LOAD_TIMEOUT });
  const chip = assistantsField.getByRole("button", { name: fixture.staffNames[1] as string });
  await expect(chip).toHaveAttribute("aria-pressed", "true", { timeout: LOAD_TIMEOUT });
  await chip.click();
  await page.getByRole("button", { name: "儲存變更" }).click();

  const prompt = page.getByTestId("assistant-removed-prompt");
  await expect(prompt).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(prompt).toContainText(`${fixture.staffNames[1]} 已從這張訂單移除`);
  await page.keyboard.press("Escape");
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "維持現狀" }).click();
  await expect(prompt).toHaveCount(0);

  const after = await readBookingState(r2.id);
  expect(after.status).toBe("accepted");
  expect(after.staffId).toBe(r2.primaryStaffId);
  expect(after.assistantStaffIds).toEqual([]);
  expect(calls.filter((c) => c.endsWith("/rpc/cancel_booking"))).toEqual([]);
});

test("E3 主服務人員被移除 → 協助人員那一欄不殘留「(協助)」卡", async ({ page }) => {
  const r3 = fixture.bookings.r3;
  await openCalendar(page);
  await expect(block(page, r3.id, "assistant")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(block(page, r3.id, "main")).toBeVisible();

  await removeStaffAsAdmin(fixture, r3.primaryStaffId);
  const after = await readBookingState(r3.id);
  expect(after.assistantStaffIds).toEqual([]);
  expect(after.status, "訂單本身不動").toBe("accepted");

  await page.reload();
  await page
    .getByRole("radiogroup", { name: "檢視模式" })
    .getByRole("radio", { name: "週檢視" })
    .click({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("calendar-day-grid")).toBeVisible({ timeout: LOAD_TIMEOUT });
  // 正向對照:同一欄(S3)的 R2 協助卡如果還在,代表格線真的載入了。
  await expect(block(page, fixture.bookings.r2.id, "main")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(block(page, r3.id, "assistant")).toHaveCount(0);
  await expect(block(page, r3.id, "main")).toHaveCount(0);
});
