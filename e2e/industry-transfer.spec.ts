// 模組 12(資料匯入/報表匯出)規格書 §4.4/§7 明確要求、品管打回重做(2026-09-21)指出完全沒有
// 寫的 Playwright 測試:產業轉移精靈完整流程(建立新商家 → 選擇要搬遷的會員 → 確認搬遷 →
// 結果頁)。
//
// 2026-09-21 品管第二輪複驗(缺口 2):規格書 §4.4 自行標記「核心必測」的規則 2.11——
// 「舊商家該會員的歷史訂單,轉移後不再顯示可點擊的會員連結」,原本 fixture 完全沒有建立任何
// 訂單,這次補上完整驗證(資料庫層 + 畫面層)。
//
// fixture 資料建立/清理見 e2e/support/industry-transfer-fixture.ts。

import { expect, test } from "@playwright/test";

import {
  createFixtureSupabaseClient,
  injectIndustryTransferFixtureSession,
  setupIndustryTransferFixture,
  teardownIndustryTransferFixture,
  INITIAL_POINTS_BALANCE,
  type IndustryTransferFixture,
} from "./support/industry-transfer-fixture";
import { primeCurrentMerchant } from "./support/app-shell";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial", timeout: 60_000 });

let fixture: IndustryTransferFixture;
let setupFailed = false;
let createdTargetMerchantId: string | null = null;

test.beforeAll(async () => {
  try {
    fixture = await setupIndustryTransferFixture();
  } catch (err) {
    setupFailed = true;
    console.error("[industry-transfer] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownIndustryTransferFixture(fixture, createdTargetMerchantId);
  console.log(
    "[industry-transfer] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"),
  );
});

test.beforeEach(async ({ page }) => {
  await injectIndustryTransferFixtureSession(page, fixture);
  await primeCurrentMerchant(page);
});

test("產業轉移精靈完整流程(§4.4):建立新商家 → 選會員 → 確認搬遷 → 結果頁", async ({ page }) => {
  await page.goto("/app/industry-transfer");
  await expect(page.getByRole("heading", { name: "產業轉移" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 步驟一:建立新商家(直接沿用既有的新增分店表單,選一個跟來源商家不同的產業:到府派工)。
  await expect(page.getByText("步驟一:建立新商家", { exact: true })).toBeVisible();
  await page.locator("#merchant-name").fill(fixture.newMerchantName);
  await page.locator("#merchant-industry").click();
  await page.getByRole("option", { name: "到府派工" }).click();
  await page.getByRole("button", { name: "建立新商家並繼續" }).click();

  // 步驟二:選擇要搬遷的會員。
  await expect(page.getByText("步驟二:選擇要搬遷的會員", { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  const memberRow = page.locator("label", { hasText: fixture.memberName });
  await expect(memberRow).toBeVisible();
  await memberRow.getByRole("checkbox").click();
  await page.getByRole("button", { name: /下一步\(已選 1 位\)/ }).click();

  // 步驟三:確認搬遷。
  await expect(page.getByText("步驟三:確認搬遷", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "確認搬遷" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "確認搬遷" }).click();

  // 步驟四:結果 + 後續提醒。
  await expect(page.getByText("步驟四:結果 + 後續提醒", { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(
    page.getByText(`已成功把 1 位會員(含紅利點數)搬到「${fixture.newMerchantName}」`),
  ).toBeVisible();

  // 直接查資料庫驗證:會員 merchant_id 正確搬到新商家、點數餘額完全不變。
  const verifyClient = createFixtureSupabaseClient();
  await verifyClient.auth.setSession({
    access_token: fixture.session.access_token,
    refresh_token: fixture.session.refresh_token,
  });

  const { data: newMerchant, error: newMerchantError } = await verifyClient
    .from("merchants")
    .select("id, industry_type")
    .eq("name", fixture.newMerchantName)
    .single();
  expect(newMerchantError).toBeNull();
  createdTargetMerchantId = (newMerchant as { id: string }).id;
  expect((newMerchant as { industry_type: string }).industry_type).toBe("on_site_dispatch");

  const { data: memberRowData, error: memberRowError } = await verifyClient
    .from("members")
    .select("merchant_id, points_balance")
    .eq("id", fixture.memberId)
    .single();
  expect(memberRowError).toBeNull();
  expect((memberRowData as { merchant_id: string }).merchant_id).toBe(createdTargetMerchantId);
  expect((memberRowData as { points_balance: number }).points_balance).toBe(INITIAL_POINTS_BALANCE);

  // 缺口 2(規則 2.11 核心必測,對應規格書 §4.4/§7):舊商家(來源商家)該會員的歷史訂單,
  // 轉移後 member_id 應該被斷開(null),但 member_name_snapshot 這個純文字欄位保留不變。
  const { data: sourceBookingRow, error: sourceBookingError } = await verifyClient
    .from("bookings")
    .select("member_id, member_name_snapshot")
    .eq("id", fixture.sourceBookingId)
    .single();
  expect(sourceBookingError).toBeNull();
  expect((sourceBookingRow as { member_id: string | null }).member_id).toBeNull();
  expect((sourceBookingRow as { member_name_snapshot: string | null }).member_name_snapshot).toBe(
    fixture.memberName,
  );

  // 畫面層驗證:轉移精靈流程自始至終「目前操作中的商家」都是來源商家(步驟一建立新商家的
  // createMerchantInGroup 只是新增一筆商家資料,不會切換目前操作中商家),所以轉移完成後
  // 直接前往來源商家的訂單頁即可,確認會員姓名不再是可以點進去查看完整會員資料的連結。
  await page.goto("/app/orders");
  await expect(page.getByRole("heading", { name: "訂單管理" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await page.getByRole("button", { name: new RegExp(fixture.sourceBookingCustomerPhone) }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(dialog.getByText(fixture.memberName)).toBeVisible();
  await expect(dialog.getByRole("link", { name: fixture.memberName })).toHaveCount(0);
});
