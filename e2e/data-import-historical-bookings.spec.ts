// 模組 12(資料匯入/報表匯出)規格書 §3.3/§4.1/§7 明確要求、品管打回重做(2026-09-21)指出
// 完全沒有寫的 Playwright 測試:歷史訂單匯入精靈完整流程，含步驟三「數值對應」——CSV 裡的服務
// 人員文字姓名一個對應到既有服務人員、一個當場按「建立新服務人員」建立成功並可選用。
//
// fixture 資料建立/清理見 e2e/support/data-import-historical-fixture.ts。

import { expect, test, type Page } from "@playwright/test";

import {
  createFixtureSupabaseClient,
  injectDataImportHistoricalFixtureSession,
  setupDataImportHistoricalFixture,
  teardownDataImportHistoricalFixture,
  type DataImportHistoricalFixture,
} from "./support/data-import-historical-fixture";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial", timeout: 60_000 });

let fixture: DataImportHistoricalFixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupDataImportHistoricalFixture();
  } catch (err) {
    setupFailed = true;
    console.error("[data-import-historical-bookings] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownDataImportHistoricalFixture(fixture);
  console.log(
    "[data-import-historical-bookings] fixture 清理結果:\n" +
      actions.map((a) => `  - ${a}`).join("\n"),
  );
});

test.beforeEach(async ({ page }) => {
  await injectDataImportHistoricalFixtureSession(page, fixture);
  await page.goto("/app");
  await expect(page.getByText("目前操作中的商家")).toBeVisible({ timeout: LOAD_TIMEOUT });
});

async function mapColumn(page: Page, fieldKey: string, header: string) {
  const row = page.getByTestId(`mapping-row-${fieldKey}`);
  await row.getByRole("combobox").click();
  await page.getByRole("option", { name: header, exact: true }).click();
}

test("歷史訂單匯入精靈(§3.3/§4.1):數值對應——既有服務人員 + 當場建立新服務人員", async ({
  page,
}) => {
  await page.goto("/app/data-import");
  await expect(page.getByRole("heading", { name: "資料匯入" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 步驟一。
  await page.getByRole("button", { name: "歷史訂單" }).click();
  await expect(page.getByText("步驟二:上傳 CSV + 欄位對應", { exact: true })).toBeVisible();

  // 步驟二:上傳 CSV + 欄位對應。
  const customerA = `E2E客戶甲${fixture.runId}`;
  const customerB = `E2E客戶乙${fixture.runId}`;
  const csv = [
    "客戶姓名,客戶電話,服務人員,預約時間,訂單金額",
    `${customerA},0955222111,${fixture.existingStaffName},2024-03-01T10:00:00+08:00,1500`,
    `${customerB},0955222112,${fixture.newStaffName},2024-03-02T14:00:00+08:00,2000`,
  ].join("\n");
  await page.setInputFiles("#csv-file", {
    name: "historical-bookings.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf-8"),
  });
  await expect(page.getByText("已解析 2 筆資料")).toBeVisible({ timeout: LOAD_TIMEOUT });

  await mapColumn(page, "customer_name", "客戶姓名");
  await mapColumn(page, "customer_phone", "客戶電話");
  await mapColumn(page, "staff_name", "服務人員");
  await mapColumn(page, "start_at", "預約時間");
  await mapColumn(page, "final_amount", "訂單金額");

  await page.getByRole("button", { name: "下一步" }).click();

  // 步驟三:數值對應。
  await expect(page.getByText("步驟三:服務人員數值對應", { exact: true })).toBeVisible();

  const existingRow = page.getByTestId(`staff-mapping-${fixture.existingStaffName}`);
  await existingRow.getByRole("combobox").click();
  await page.getByRole("option", { name: fixture.existingStaffName, exact: true }).click();
  await expect(existingRow).toContainText("已對應");

  const newRow = page.getByTestId(`staff-mapping-${fixture.newStaffName}`);
  await newRow.getByRole("button", { name: "建立新服務人員" }).click();
  await expect(page.getByText(`已建立新服務人員「${fixture.newStaffName}」`)).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(newRow).toContainText("已對應");

  await page.getByRole("button", { name: "下一步" }).click();

  // 步驟四:預覽——兩列都應該顯示「看起來會成功」。
  await expect(page.getByText("步驟四:預覽", { exact: true })).toBeVisible();
  const rows = page.locator("table tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("看起來會成功");
  await expect(rows.nth(1)).toContainText("看起來會成功");

  // 步驟五:確認匯入。
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "確認匯入" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "確認匯入" }).click();

  // 步驟六:結果報告。
  await expect(page.getByText("步驟六:結果報告", { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.locator(".rounded-md.border", { hasText: "成功" }).locator("p.text-2xl")).toHaveText(
    "2",
  );
  await expect(page.locator(".rounded-md.border", { hasText: "失敗" }).locator("p.text-2xl")).toHaveText(
    "0",
  );

  // 直接查資料庫驗證:兩筆訂單的 staff_id 分別正確連到既有服務人員 / 新建立的服務人員。
  const verifyClient = createFixtureSupabaseClient();
  await verifyClient.auth.setSession({
    access_token: fixture.session.access_token,
    refresh_token: fixture.session.refresh_token,
  });

  const { data: newStaffRow, error: newStaffError } = await verifyClient
    .from("merchant_staff")
    .select("id")
    .eq("merchant_id", fixture.merchantId)
    .eq("name", fixture.newStaffName)
    .single();
  expect(newStaffError).toBeNull();
  const newStaffId = (newStaffRow as { id: string }).id;

  const { data: bookings, error: bookingsError } = await verifyClient
    .from("bookings")
    .select("customer_name, staff_id, source, final_amount_snapshot")
    .eq("merchant_id", fixture.merchantId)
    .order("customer_name", { ascending: true });
  expect(bookingsError).toBeNull();
  expect(bookings).toHaveLength(2);
  const bookingA = bookings!.find((b) => b.customer_name === customerA);
  const bookingB = bookings!.find((b) => b.customer_name === customerB);
  expect(bookingA?.staff_id).toBe(fixture.existingStaffId);
  expect(bookingA?.source).toBe("import");
  expect(Number(bookingA?.final_amount_snapshot)).toBe(1500);
  expect(bookingB?.staff_id).toBe(newStaffId);
  expect(Number(bookingB?.final_amount_snapshot)).toBe(2000);

  // §3.3 明確要求:選擇「建立新服務人員」後，確實在服務人員管理頁看得到這筆新資料。
  await page.goto("/app/staff");
  await expect(page.getByRole("heading", { name: "服務人員管理" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByText(fixture.newStaffName)).toBeVisible();
});
