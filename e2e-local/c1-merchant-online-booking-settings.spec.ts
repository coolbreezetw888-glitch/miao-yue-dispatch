// 客戶端第 1 批(C1)本機 e2e:商家設定「線上預約」卡片、後台「預約網址」卡片、推薦畫面隱藏。
// 規格書:.project/specs/客戶端第1批-公開預約頁.md(C1-D01、C1-D02、C1-E01、C1-E02、C1-G02)。
// fixture 見 support/c1-public-booking-fixture.ts(跟 c1-public-booking-page 共用,各自建一份、各自清掉)。
// **只在本機跑**:`npx playwright test --config playwright.local.config.ts c1-merchant-online-booking-settings`
import { expect, test, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import {
  createMemberForFixture,
  injectSession,
  serviceClient,
  setupC1Fixture,
  SHOP_A_NAME,
  teardownC1Fixture,
  type C1Fixture,
} from "./support/c1-public-booking-fixture";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";

const LOAD_TIMEOUT = 20_000;
const SHOT_DIR = process.env["E2E_SHOT_DIR"] ?? "test-results/c1-shots";

test.use({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "default", timeout: 120_000 });

let fixture: C1Fixture;
let setupFailed = false;
let recorders: RequestRecorder[] = [];

test.beforeAll(async () => {
  test.setTimeout(180_000);
  try {
    fixture = await setupC1Fixture();
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  if (setupFailed || !fixture) return;
  const actions = await teardownC1Fixture(fixture);
  console.log("[c1-settings 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(() => {
  recorders = [];
});
test.afterEach(() => {
  expect(recorders.length, "前提:這條測試至少開過一個頁面").toBeGreaterThan(0);
  for (const r of recorders) expectOnlyLocalRequests(r);
});

async function login(page: Page): Promise<void> {
  recorders.push(recordRequestHosts(page));
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page);
}

async function openSettings(page: Page) {
  await page.goto("/app/settings");
  await expect(page.getByRole("heading", { name: "商家設定", level: 1 })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByRole("button", { name: `切換商家(目前：${SHOP_A_NAME})` })).toBeVisible();
  const card = page.getByTestId("online-booking-settings-card");
  await expect(card.locator("#settings-min-lead-hours")).toBeVisible({ timeout: LOAD_TIMEOUT });
  return card;
}

async function readSettingsRow() {
  const svc = serviceClient();
  const [settings, merchant] = await Promise.all([
    svc
      .from("merchant_booking_settings")
      .select("min_lead_hours,travel_buffer_minutes,allow_guest_booking")
      .eq("merchant_id", fixture.merchantAId)
      .maybeSingle(),
    svc.from("merchants").select("line_friend_url").eq("id", fixture.merchantAId).single(),
  ]);
  return {
    settings: settings.data as Record<string, unknown> | null,
    merchant: merchant.data as Record<string, unknown> | null,
  };
}

test("C1-D01 / D02:預設值、四個欄位改完儲存、重新整理仍是新值;錯誤值擋下並有中文提示", async ({
  page,
}) => {
  await login(page);
  const card = await openSettings(page);

  // 沒有那一列 = 預設值
  expect((await readSettingsRow()).settings).toBeNull();
  await expect(card.locator("#settings-min-lead-hours")).toHaveValue("2");
  await expect(card.locator("#settings-travel-buffer-minutes")).toHaveValue("0");
  await expect(card.getByRole("switch", { name: "允許不登入預約" })).toBeChecked();
  // 客戶端第 3 批(C3-E03):送出預約已上線 ⇒「登入功能推出後才生效」常駐提醒拿掉;
  // C3-H05:多兩個完成頁文字欄(留空 = 預設句,當 placeholder 顯示)。
  await expect(card.getByText("這個設定會在登入功能推出後才生效。")).toHaveCount(0);
  await expect(card.locator("#settings-completion-message-member")).toHaveAttribute(
    "placeholder",
    "店家確認後會通知您。",
  );
  await expect(card.locator("#settings-completion-message-guest")).toHaveAttribute(
    "placeholder",
    "店家確認後會與您聯絡。",
  );
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({
    path: `${SHOT_DIR}/c1-06-settings-card-1280.png`,
    animations: "disabled",
  });

  // 錯誤值
  await card.locator("#settings-line-friend-url").fill("https://example.com/abc");
  await expect(
    card.getByText("請貼上 LINE 官方帳號的加入好友網址（line.me 或 lin.ee 開頭）"),
  ).toBeVisible();
  await card.locator("#settings-min-lead-hours").fill("73");
  await expect(card.getByText("請填 0～72 之間的整數（單位：小時）。")).toBeVisible();
  await card.locator("#settings-travel-buffer-minutes").fill("241");
  await expect(card.getByText("請填 0～240 之間的整數（單位：分鐘）。")).toBeVisible();
  await card.locator("#settings-travel-buffer-minutes").fill("-1");
  await expect(card.getByText("請填 0～240 之間的整數（單位：分鐘）。")).toBeVisible();
  await card.screenshot({
    path: `${SHOT_DIR}/c1-06-settings-card-errors-1280.png`,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "儲存變更" }).first().click();
  await expect(page.getByText("「線上預約」有欄位填錯了，請先修正標紅的欄位")).toBeVisible();
  expect((await readSettingsRow()).settings).toBeNull();

  // 正確值 → 儲存
  await card.locator("#settings-line-friend-url").fill("https://lin.ee/c1Saved");
  await card.locator("#settings-min-lead-hours").fill("5");
  await card.locator("#settings-travel-buffer-minutes").fill("30");
  await card.getByRole("switch", { name: "允許不登入預約" }).click();
  await page.getByRole("button", { name: "儲存變更" }).first().click();
  await expect(page.getByText("商家設定已儲存")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect
    .poll(async () => (await readSettingsRow()).settings)
    .toEqual({ min_lead_hours: 5, travel_buffer_minutes: 30, allow_guest_booking: false });
  expect((await readSettingsRow()).merchant).toEqual({ line_friend_url: "https://lin.ee/c1Saved" });

  await page.reload();
  const card2 = await openSettings(page);
  await expect(card2.locator("#settings-line-friend-url")).toHaveValue("https://lin.ee/c1Saved");
  await expect(card2.locator("#settings-min-lead-hours")).toHaveValue("5");
  await expect(card2.locator("#settings-travel-buffer-minutes")).toHaveValue("30");
  await expect(card2.getByRole("switch", { name: "允許不登入預約" })).not.toBeChecked();
  await expect(page.getByText("尚未儲存變更")).toHaveCount(0);

  // 清空 LINE 好友連結 = 清除(null)
  await card2.locator("#settings-line-friend-url").fill("");
  await page.getByRole("button", { name: "儲存變更" }).first().click();
  await expect(page.getByText("商家設定已儲存")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect
    .poll(async () => (await readSettingsRow()).merchant)
    .toEqual({ line_friend_url: null });
});

test("C1-D01:產業選到店 ⇒ 車程緩衝欄位不顯示", async ({ page }) => {
  await login(page);
  const card = await openSettings(page);
  await expect(card.locator("#settings-travel-buffer-minutes")).toBeVisible();
  await page.locator("#settings-industry-type").click();
  await page.getByRole("option", { name: "到店服務" }).click();
  await expect(card.locator("#settings-travel-buffer-minutes")).toHaveCount(0);
  await expect(card.locator("#settings-min-lead-hours")).toBeVisible();
});

test.describe("375 寬", () => {
  test.use({ viewport: { width: 375, height: 780 } });

  test("C1-G02:線上預約卡片、預約網址卡片 375 截圖;沒有橫向捲動", async ({ page }) => {
    await login(page);
    const card = await openSettings(page);
    await card.scrollIntoViewIfNeeded();
    const sw = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(sw).toBe(true);
    await card.screenshot({
      path: `${SHOT_DIR}/c1-06-settings-card-375.png`,
      animations: "disabled",
    });
    await page.goto("/app/manage");
    const urlCard = page.getByText("預約網址", { exact: true }).locator("xpath=../..");
    await expect(urlCard).toBeVisible({ timeout: LOAD_TIMEOUT });
    await urlCard.screenshot({
      path: `${SHOT_DIR}/c1-07-booking-url-card-375.png`,
      animations: "disabled",
    });
  });
});

test("C1-E01:預約網址卡片的說明文字、「開啟」另開新分頁到 /booking/<代碼>", async ({
  page,
  context,
}) => {
  await login(page);
  const urlCard = page.getByText("預約網址", { exact: true }).locator("xpath=../..");
  await expect(urlCard).toBeVisible({ timeout: LOAD_TIMEOUT });
  // 客戶端第 3 批(C3-E03)文案。
  await expect(urlCard).toContainText("顧客預約用的專屬連結。客人可以看服務、選時間並送出預約。");
  await expect(urlCard).not.toContainText("即將開放");
  await expect(urlCard.getByRole("button", { name: "複製連結" })).toBeVisible();
  await urlCard.screenshot({
    path: `${SHOT_DIR}/c1-07-booking-url-card-1280.png`,
    animations: "disabled",
  });
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    urlCard.getByRole("link", { name: "開啟" }).click(),
  ]);
  recorders.push(recordRequestHosts(popup));
  await popup.waitForLoadState();
  expect(new URL(popup.url()).pathname).toBe(`/booking/${fixture.slugA}`);
  await expect(popup.getByTestId("public-booking-shop-name")).toHaveText(SHOP_A_NAME, {
    timeout: LOAD_TIMEOUT,
  });
  await popup.close();
});

test("C1-E02:紅利點數只剩三個分頁;會員詳細頁看不到推薦碼與推薦名單", async ({ page }) => {
  await login(page);
  await page.goto("/app/member-points");
  await expect(page.getByRole("tab", { name: "紅利計算" })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("tab")).toHaveText(["紅利計算", "點數使用", "生日獎勵"]);
  await expect(page.getByRole("tab", { name: "推薦系統" })).toHaveCount(0);

  const memberId = await createMemberForFixture(fixture, "E2E客戶端C1會員");
  await page.goto(`/app/members/${memberId}`);
  await expect(page.getByRole("heading", { name: "E2E客戶端C1會員" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByText("會員等級")).toBeVisible();
  await expect(page.getByText("推薦碼", { exact: true })).toHaveCount(0);
  await expect(page.getByText("推薦名單", { exact: true })).toHaveCount(0);
});

test("C1-E02 第 2 輪:會員列表卡片沒有推薦碼、新增會員沒有推薦人、編輯視窗沒有推薦人、功能頁說明不提推薦名單", async ({
  page,
}) => {
  await login(page);
  // 功能頁「會員管理」卡片說明
  const membersCard = page.getByRole("link", { name: /會員管理/ });
  await expect(membersCard).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(membersCard).toContainText("管理會員基本資料，以及各會員的點數兌換、調整與異動歷史");
  await expect(membersCard).not.toContainText("推薦");

  const memberId = await createMemberForFixture(fixture, "E2E客戶端C1會員乙", "77");
  await page.goto("/app/members");
  const card = page.getByText("E2E客戶端C1會員乙").first();
  await expect(card).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.locator("body")).not.toContainText("推薦碼");
  await expect(page.getByPlaceholder("搜尋姓名/電話", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "新增會員" }).click();
  const createDialog = page.getByRole("dialog");
  await expect(createDialog.getByLabel(/^姓名/)).toBeVisible();
  await expect(createDialog).not.toContainText("推薦人");
  await page.screenshot({
    path: `${SHOT_DIR}/c1-08-new-member-no-referrer-1280.png`,
    animations: "disabled",
  });
  await createDialog.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.goto(`/app/members/${memberId}`);
  await page.getByRole("button", { name: "編輯" }).click();
  const editDialog = page.getByRole("dialog");
  await expect(editDialog).toContainText("只有姓名是必填的。");
  await expect(editDialog).not.toContainText("推薦");
});
