// SPECS-INDEX #600(.project/specs/資料匯入與報表匯出.md §10.1):資料匯入精靈、報表匯出中心、
// 產業轉移精靈三個頁面統一補「← 返回功能」按鈕,固定導回 /app/manage,不是瀏覽器上一頁。
//
// 這支測試涵蓋:
// 1. 三個頁面的「← 返回功能」都正確導向 /app/manage。
// 2. 匯入精靈(唯一多步驟精靈,進到步驟二後)畫面上同時看得到「← 返回功能」(離開整個匯入流程)
//    跟精靈自己的「上一步」(留在匯入流程內、回到前一步驟)兩顆文字不同、位置分開的按鈕,不會
//    讓使用者混淆成同一顆按鈕(§10.1 邊界情況的核心要求)。
//
// 重用既有的 data-import-members fixture(只需要一個商家管理員 session,不需要額外建立資料),
// 比照 data-import-members.spec.ts 的既有慣例。

import { expect, test } from "@playwright/test";

import {
  injectDataImportMembersFixtureSession,
  setupDataImportMembersFixture,
  teardownDataImportMembersFixture,
  type DataImportMembersFixture,
} from "./support/data-import-members-fixture";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial", timeout: 60_000 });

let fixture: DataImportMembersFixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupDataImportMembersFixture();
  } catch (err) {
    setupFailed = true;
    console.error("[data-tools-return-button] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownDataImportMembersFixture(fixture);
  console.log(
    "[data-tools-return-button] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"),
  );
});

test.beforeEach(async ({ page }) => {
  await injectDataImportMembersFixtureSession(page, fixture);
  await page.goto("/app");
  await expect(page.getByText("目前操作中的商家")).toBeVisible({ timeout: LOAD_TIMEOUT });
});

test("資料匯入精靈(§10.1):「← 返回功能」導向 /app/manage,且跟「上一步」是兩顆不同按鈕", async ({
  page,
}) => {
  await page.goto("/app/data-import");
  await expect(page.getByRole("heading", { name: "資料匯入" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 進到步驟二,確認「← 返回功能」跟「上一步」同時可見、文字不同。
  await page.getByRole("button", { name: "會員資料" }).click();
  await expect(page.getByText("步驟二:上傳 CSV + 欄位對應", { exact: true })).toBeVisible();

  const returnLink = page.getByRole("link", { name: "← 返回功能" });
  const previousStepButton = page.getByRole("button", { name: "上一步" });
  await expect(returnLink).toBeVisible();
  await expect(previousStepButton).toBeVisible();

  // 「上一步」只會留在精靈內回到步驟一,不會離開頁面。
  await previousStepButton.click();
  await expect(page.getByText("步驟一:選擇匯入類型", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/app\/data-import$/);

  // 「← 返回功能」才會離開整個匯入流程,導回 /app/manage。
  await page.getByRole("link", { name: "← 返回功能" }).click();
  await expect(page).toHaveURL(/\/app\/manage$/);
});

test("報表匯出中心(§10.1):「← 返回功能」導向 /app/manage", async ({ page }) => {
  await page.goto("/app/reports");
  await expect(page.getByRole("heading", { name: "報表匯出中心" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await page.getByRole("link", { name: "← 返回功能" }).click();
  await expect(page).toHaveURL(/\/app\/manage$/);
});

test("產業轉移精靈(§10.1):「← 返回功能」導向 /app/manage(直接輸入網址仍可正常開啟,呼應 #601 只隱藏入口)", async ({
  page,
}) => {
  await page.goto("/app/industry-transfer");
  await expect(page.getByRole("heading", { name: "產業轉移" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await page.getByRole("link", { name: "← 返回功能" }).click();
  await expect(page).toHaveURL(/\/app\/manage$/);
});
