// 模組 12(資料匯入/報表匯出)規格書 §4.2/§7 明確要求、品管打回重做(2026-09-21)指出完全沒有
// 寫的 Playwright 測試:匯入紀錄頁——列出過去批次、展開查看失敗明細、對未復原的批次按
// 「一鍵復原」並確認畫面顯示正確的復原結果摘要。
//
// 2026-09-21 品管第二輪複驗(缺口 1):規格書 §4.2 明確要求兩種情境——①乾淨復原②匯入後手動
// 編輯其中一位會員,復原時該筆被正確跳過。原本這支測試只做了情境①,這次補上情境②
// (見下方第二個 test 區塊)。資料庫層 rollback_bulk_operation 對「created 但匯入後被編輯過」
// 這個分支的行為(supabase/migrations/20260920170400_data_import_rollback.sql 第 57~65 行)
// 已經是既有邏輯,這裡只是把這個已知會通過的行為包成 Playwright 測試,不重新設計邏輯。
//
// fixture 資料建立/清理見 e2e/support/data-import-history-fixture.ts。

import { expect, test, type Page } from "@playwright/test";

import {
  createFixtureSupabaseClient,
  injectDataImportHistoryFixtureSession,
  setupDataImportHistoryFixture,
  teardownDataImportHistoryFixture,
  type DataImportHistoryFixture,
} from "./support/data-import-history-fixture";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial", timeout: 60_000 });

let fixture: DataImportHistoryFixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupDataImportHistoryFixture();
  } catch (err) {
    setupFailed = true;
    console.error("[data-import-history] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownDataImportHistoryFixture(fixture);
  console.log(
    "[data-import-history] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"),
  );
});

test.beforeEach(async ({ page }) => {
  await injectDataImportHistoryFixtureSession(page, fixture);
  await page.goto("/app");
  await expect(page.getByText("目前操作中的商家")).toBeVisible({ timeout: LOAD_TIMEOUT });
});

async function mapColumn(page: Page, fieldKey: string, header: string) {
  const row = page.getByTestId(`mapping-row-${fieldKey}`);
  await row.getByRole("combobox").click();
  await page.getByRole("option", { name: header, exact: true }).click();
}

test("匯入紀錄頁(§4.2):列出批次、展開失敗明細、一鍵復原並顯示正確摘要", async ({ page }) => {
  // 先透過匯入精靈建立一個「2 成功 + 1 失敗」的批次(比照品管 2026-09-21 的手動驗證情境)。
  await page.goto("/app/data-import");
  await page.getByRole("button", { name: "會員資料" }).click();

  const csv = [
    "姓名,電話",
    `${fixture.validMemberName1},0955333001`,
    `${fixture.validMemberName2},0955333002`,
    `${fixture.invalidMemberName},`,
  ].join("\n");
  await page.setInputFiles("#csv-file", {
    name: "members.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf-8"),
  });
  await expect(page.getByText("已解析 3 筆資料")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await mapColumn(page, "name", "姓名");
  await mapColumn(page, "phone", "電話");
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByText("步驟四:預覽", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "確認匯入" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "確認匯入" }).click();
  await expect(page.getByText("步驟六:結果報告", { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 前往匯入紀錄頁。
  await page.getByRole("link", { name: "查看匯入紀錄" }).click();
  await expect(page.getByRole("heading", { name: "匯入紀錄" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  const card = page.locator(".rounded-xl.border", { hasText: "會員匯入" }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("總筆數:3");
  await expect(card).toContainText("成功:2");
  await expect(card).toContainText("失敗:1");
  await expect(card).toContainText("略過:0");
  await expect(card.getByText("已完成")).toBeVisible();

  // 展開失敗明細。
  await card.getByRole("button", { name: /展開失敗明細/ }).click();
  await expect(card).toContainText("這個商家要求建立會員時必須填寫電話");

  // 一鍵復原。
  await card.getByRole("button", { name: "復原" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "確認復原" })
    .click();
  await expect(page.getByText(/復原完成:成功復原 2 筆，跳過 0 筆/)).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(card).toContainText("復原結果:成功 2 筆，跳過 0 筆");
  await expect(card.getByText("已復原")).toBeVisible();
  await expect(card.getByRole("button", { name: "復原" })).toHaveCount(0);

  // 直接查資料庫驗證:兩位成功建立的會員已經被復原刪除；批次狀態正確變成 rolled_back。
  const verifyClient = createFixtureSupabaseClient();
  await verifyClient.auth.setSession({
    access_token: fixture.session.access_token,
    refresh_token: fixture.session.refresh_token,
  });

  const { data: members, error: membersError } = await verifyClient
    .from("members")
    .select("id")
    .eq("merchant_id", fixture.merchantId);
  expect(membersError).toBeNull();
  expect(members).toHaveLength(0);

  const { data: operations, error: opsError } = await verifyClient
    .from("merchant_bulk_operations")
    .select("status")
    .eq("merchant_id", fixture.merchantId)
    .eq("operation_type", "member_import");
  expect(opsError).toBeNull();
  expect(operations).toHaveLength(1);
  expect(operations![0]!.status).toBe("rolled_back");
});

test("匯入紀錄頁(§4.2)情境②:匯入後手動編輯其中一位會員,復原時該筆正確跳過且維持編輯後狀態", async ({
  page,
}) => {
  // 第二批匯入:兩位都合法(這批不需要重覆測失敗列,情境①已經測過),之後手動編輯其中一位。
  await page.goto("/app/data-import");
  await page.getByRole("button", { name: "會員資料" }).click();

  const csv = [
    "姓名,電話",
    `${fixture.editedAfterImportMemberName},${fixture.editedAfterImportMemberPhone}`,
    `${fixture.cleanSecondBatchMemberName},${fixture.cleanSecondBatchMemberPhone}`,
  ].join("\n");
  await page.setInputFiles("#csv-file", {
    name: "members-batch2.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf-8"),
  });
  await expect(page.getByText("已解析 2 筆資料")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await mapColumn(page, "name", "姓名");
  await mapColumn(page, "phone", "電話");
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByText("步驟四:預覽", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByRole("button", { name: "確認匯入" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "確認匯入" }).click();
  await expect(page.getByText("步驟六:結果報告", { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 比照既有測試做法(呼叫 update_member),手動編輯剛匯入的其中一位會員——匯入後
  // updated_at 不再等於 created_at,復原時應該被正確跳過,資料維持編輯後的狀態。
  const verifyClient = createFixtureSupabaseClient();
  await verifyClient.auth.setSession({
    access_token: fixture.session.access_token,
    refresh_token: fixture.session.refresh_token,
  });

  const { data: editedMemberRow, error: editedMemberFindError } = await verifyClient
    .from("members")
    .select("id, phone")
    .eq("merchant_id", fixture.merchantId)
    .eq("name", fixture.editedAfterImportMemberName)
    .single();
  expect(editedMemberFindError).toBeNull();
  const editedMemberId = (editedMemberRow as { id: string }).id;
  const editedMemberName = `${fixture.editedAfterImportMemberName}(已編輯)`;

  const { error: updateError } = await verifyClient.rpc("update_member", {
    p_member_id: editedMemberId,
    p_name: editedMemberName,
    p_phone: (editedMemberRow as { phone: string }).phone,
    p_email: null,
    p_birthday: null,
    p_notes: "e2e 情境②:匯入後手動編輯,驗證復原時正確跳過這一筆。",
  });
  expect(updateError).toBeNull();

  // 前往匯入紀錄頁,找到這次(第二批)的批次卡片——用「總筆數:2」跟第一批(總筆數:3)區分開。
  await page.goto("/app/data-import/history");
  await expect(page.getByRole("heading", { name: "匯入紀錄" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  const card = page
    .locator(".rounded-xl.border", { hasText: "會員匯入" })
    .filter({ hasText: "總筆數:2" })
    .first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("成功:2");
  await expect(card.getByText("已完成")).toBeVisible();

  // 一鍵復原:預期 1 筆成功復原(乾淨的那位)、1 筆跳過(被編輯過的那位)。
  await card.getByRole("button", { name: "復原" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "確認復原" }).click();
  await expect(page.getByText(/復原完成:成功復原 1 筆，跳過 1 筆/)).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(card).toContainText("復原結果:成功 1 筆，跳過 1 筆");
  await expect(card).toContainText("這位會員匯入後已被編輯過，無法自動復原，請手動確認處理");
  await expect(card.getByText("已復原")).toBeVisible();
  await expect(card.getByRole("button", { name: "復原" })).toHaveCount(0);

  // 直接查資料庫驗證:被編輯過的會員沒有被刪除,姓名維持編輯後的狀態(沒有被復原蓋掉);
  // 維持乾淨的那位確實被刪除。
  const { data: stillEditedMember, error: stillEditedError } = await verifyClient
    .from("members")
    .select("id, name")
    .eq("id", editedMemberId)
    .maybeSingle();
  expect(stillEditedError).toBeNull();
  expect(stillEditedMember).not.toBeNull();
  expect((stillEditedMember as { name: string }).name).toBe(editedMemberName);

  const { data: cleanMemberRows, error: cleanMemberError } = await verifyClient
    .from("members")
    .select("id")
    .eq("merchant_id", fixture.merchantId)
    .eq("name", fixture.cleanSecondBatchMemberName);
  expect(cleanMemberError).toBeNull();
  expect(cleanMemberRows).toHaveLength(0);
});
