// 模組 12(資料匯入/報表匯出)規格書 §4.3/§7 明確要求、品管打回重做(2026-09-21)指出完全沒有
// 寫的 Playwright 測試:報表匯出中心——訂單/會員/抽成三種報表類型至少各測一次下載成功。
//
// fixture 資料建立/清理見 e2e/support/report-export-fixture.ts。

import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

import {
  injectReportExportFixtureSession,
  setupReportExportFixture,
  teardownReportExportFixture,
  type ReportExportFixture,
} from "./support/report-export-fixture";
import { primeCurrentMerchant } from "./support/app-shell";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial", timeout: 60_000 });

let fixture: ReportExportFixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupReportExportFixture();
  } catch (err) {
    setupFailed = true;
    console.error("[reports-export] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownReportExportFixture(fixture);
  console.log("[reports-export] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(async ({ page }) => {
  await injectReportExportFixtureSession(page, fixture);
  await primeCurrentMerchant(page);
});

test("報表匯出中心(§4.3):訂單/會員/抽成三種報表類型皆下載成功", async ({ page }) => {
  await page.goto("/app/reports");
  await expect(page.getByRole("heading", { name: "報表匯出中心" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 訂單報表(預設分頁,無篩選 = 匯出全部)。
  await expect(page.getByText("訂單報表", { exact: true })).toBeVisible();
  const [ordersDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: LOAD_TIMEOUT }),
    page.getByRole("button", { name: "匯出 CSV" }).click(),
  ]);
  await expect(page.getByText("已匯出 1 筆訂單")).toBeVisible({ timeout: LOAD_TIMEOUT });
  const ordersPath = await ordersDownload.path();
  expect(ordersPath).not.toBeNull();
  const ordersCsv = readFileSync(ordersPath!, "utf-8");
  expect(ordersCsv).toContain(fixture.customerName);

  // 會員報表。
  await page.getByRole("tab", { name: "會員" }).click();
  await expect(page.getByText("會員報表", { exact: true })).toBeVisible();
  const [membersDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: LOAD_TIMEOUT }),
    page.getByRole("button", { name: "匯出 CSV" }).click(),
  ]);
  // #849(行為改變,#872 建單自動建立會員):fixture 那筆訂單的客戶電話(0955444099)跟 fixture 會員
  // (0955444001)不同,建單時後端會自動替這位客戶建一筆會員 ⇒ 這間商家現在有 2 位會員,
  // 匯出筆數從 1 變 2,CSV 裡兩位都要在(多驗了自動建立的那一位真的會被匯出)。
  await expect(page.getByText("已匯出 2 筆會員")).toBeVisible({ timeout: LOAD_TIMEOUT });
  const membersPath = await membersDownload.path();
  expect(membersPath).not.toBeNull();
  const membersCsv = readFileSync(membersPath!, "utf-8");
  expect(membersCsv).toContain(fixture.memberName);
  expect(membersCsv).toContain(fixture.customerName);

  // 抽成報表(預設年月 = 本月,服務人員預設「全部服務人員」,剛好對應 fixture 完成的那筆訂單)。
  await page.getByRole("tab", { name: "抽成" }).click();
  await expect(page.getByText("抽成報表", { exact: true })).toBeVisible();
  const [commissionDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: LOAD_TIMEOUT }),
    page.getByRole("button", { name: "匯出 CSV" }).click(),
  ]);
  await expect(page.getByText("已匯出 1 筆抽成明細")).toBeVisible({ timeout: LOAD_TIMEOUT });
  const commissionPath = await commissionDownload.path();
  expect(commissionPath).not.toBeNull();
  const commissionCsv = readFileSync(commissionPath!, "utf-8");
  expect(commissionCsv).toContain(fixture.staffName);
  expect(commissionCsv).toContain(fixture.customerName);
});
