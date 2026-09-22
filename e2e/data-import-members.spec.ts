// 模組 12(資料匯入/報表匯出)規格書 §3.3/§4.1/§7 明確要求、品管打回重做(2026-09-21)指出
// 完全沒有寫的 Playwright 測試:會員匯入精靈完整流程(上傳 CSV → 欄位對應 → 預覽 → 確認匯入 →
// 結果報告)。
//
// 這支測試同時涵蓋這次品管抓到的真實 bug 修正驗證:步驟四「預覽」的 rowLooksValid() 過去只檢查
// 姓名，沒有檢查商家的 phone_required_to_create 設定，導致缺電話的會員在預覽階段顯示「看起來會
// 成功」，但送出後實際失敗——修正後這支測試確認預覽結果跟送出後的實際結果一致（缺電話的列兩邊
// 都判定失敗，不會出現落差）。
//
// fixture 資料建立/清理見 e2e/support/data-import-members-fixture.ts。

import { readFileSync } from "node:fs";
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
    console.error("[data-import-members] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownDataImportMembersFixture(fixture);
  console.log("[data-import-members] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(async ({ page }) => {
  await injectDataImportMembersFixtureSession(page, fixture);
  // 已知既有問題(跟本次修正主題無關,e2e/mobile-overflow.spec.ts / payroll-reports.spec.ts 開頭
  // 已記錄):先訪問一次 /app 讓「目前操作中商家」正確寫進 localStorage,避免 Require*Access
  // 在 currentMerchantId 還沒就緒前誤判導回 /app。
  await page.goto("/app");
  await expect(page.getByText("目前操作中的商家")).toBeVisible({ timeout: LOAD_TIMEOUT });
});

async function mapColumn(page: import("@playwright/test").Page, fieldKey: string, header: string) {
  const row = page.getByTestId(`mapping-row-${fieldKey}`);
  await row.getByRole("combobox").click();
  await page.getByRole("option", { name: header, exact: true }).click();
}

async function readStatCard(page: import("@playwright/test").Page, label: string): Promise<string> {
  const card = page.locator(".rounded-md.border", { hasText: label });
  return (await card.locator("p.text-2xl").innerText()).trim();
}

test("會員匯入精靈完整流程(§3.3/§4.1):含缺電話列在預覽階段就正確顯示會失敗", async ({ page }) => {
  await page.goto("/app/data-import");
  await expect(page.getByRole("heading", { name: "資料匯入" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 步驟一:選擇匯入類型。
  await page.getByRole("button", { name: "會員資料" }).click();
  await expect(page.getByText("步驟二:上傳 CSV + 欄位對應", { exact: true })).toBeVisible();

  // 步驟二:上傳 CSV(1 筆有電話、1 筆缺電話) + 欄位對應。
  const csv = [
    "姓名,電話",
    `${fixture.validMemberName},0955000001`,
    `${fixture.invalidMemberName},`,
  ].join("\n");
  await page.setInputFiles("#csv-file", {
    name: "members.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf-8"),
  });
  await expect(page.getByText("已解析 2 筆資料")).toBeVisible({ timeout: LOAD_TIMEOUT });

  await mapColumn(page, "name", "姓名");
  await mapColumn(page, "phone", "電話");

  await page.getByRole("button", { name: "下一步" }).click();

  // 步驟四:預覽——核心 bug 修正驗證:缺電話那一列必須顯示「會失敗」，不能顯示「看起來會成功」。
  await expect(page.getByText("步驟四:預覽", { exact: true })).toBeVisible();
  const rows = page.locator("table tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("看起來會成功");
  await expect(rows.nth(0)).toContainText(fixture.validMemberName);
  await expect(rows.nth(1)).toContainText("這個商家要求建立會員時必須填寫電話");
  await expect(rows.nth(1)).toContainText(fixture.invalidMemberName);

  // 步驟五:確認匯入。
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByText("步驟五:確認匯入", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "確認匯入" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "確認匯入" })
    .click();

  // 步驟六:結果報告——驗證預覽判斷跟實際匯入結果一致:1 成功 + 1 失敗，且失敗原因跟預覽相同。
  await expect(page.getByText("步驟六:結果報告", { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(readStatCard(page, "總筆數")).resolves.toBe("2");
  await expect(readStatCard(page, "成功")).resolves.toBe("1");
  await expect(readStatCard(page, "失敗")).resolves.toBe("1");
  await expect(readStatCard(page, "略過")).resolves.toBe("0");
  await expect(page.getByText("這個商家要求建立會員時必須填寫電話")).toBeVisible();
});

// SPECS-INDEX #603(§10.4):會員資料匯入模板——欄位需對照 import_members_batch 實際會處理的
// 欄位,下載回來的模板填入範例資料後直接送出必須能成功匯入,不是好看但用不了的文件。
test("會員資料匯入模板下載(§10.4):欄位跟解析邏輯一致,填入範例資料後可成功匯入", async ({
  page,
}) => {
  await page.goto("/app/data-import");
  await expect(page.getByRole("heading", { name: "資料匯入" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await page.getByRole("button", { name: "會員資料" }).click();
  await expect(page.getByText("步驟二:上傳 CSV + 欄位對應", { exact: true })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: LOAD_TIMEOUT }),
    page.getByRole("button", { name: "下載 CSV 模板" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("會員資料匯入模板.csv");
  const path = await download.path();
  expect(path).not.toBeNull();
  const csv = readFileSync(path!, "utf-8");
  const [headerLine, exampleLine] = csv.replace(/^\uFEFF/, "").split(/\r\n/) as [string, string];
  expect(headerLine.split(",")).toEqual([
    "姓名",
    "電話",
    "Email",
    "生日",
    "備註",
    "推薦人電話/推薦碼",
    "起始點數餘額",
  ]);
  expect(exampleLine).toContain("王小明");
  expect(exampleLine).toContain("0912345678");

  // 用下載回來的模板原封不動重新上傳,證明模板真的可用(§10.4 測試要求)。
  await page.setInputFiles("#csv-file", {
    name: "會員資料匯入模板.csv",
    mimeType: "text/csv",
    buffer: readFileSync(path!),
  });
  await expect(page.getByText("已解析 1 筆資料")).toBeVisible({ timeout: LOAD_TIMEOUT });

  await mapColumn(page, "name", "姓名");
  await mapColumn(page, "phone", "電話");

  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByText("步驟四:預覽", { exact: true })).toBeVisible();
  await expect(page.locator("table tbody tr")).toHaveCount(1);
  await expect(page.locator("table tbody tr").first()).toContainText("看起來會成功");

  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "確認匯入" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "確認匯入" }).click();

  await expect(page.getByText("步驟六:結果報告", { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(readStatCard(page, "成功")).resolves.toBe("1");
  await expect(readStatCard(page, "失敗")).resolves.toBe("0");
});
