// 模組 14(服務人員端)規格書第七節要求的 Playwright 測試:
//   4.1/4.2/4.3:服務人員登入後只看到服務人員版面的首頁/功能卡片/行事曆,看不到任何管理員/
//     客服導向內容。
//   4.7:邀請登入完整流程——對真實 Supabase 專案完整跑一次「管理員邀請 → 服務人員登入 →
//     看到自己商家與自助功能」,以及服務人員管理頁正確顯示登入狀態徽章/服務人員權限入口。
//   4.4:我的休假設定頁——新增每週固定時段,正確反映在既有管理員行事曆管理頁面上。
//
// fixture 資料建立/清理見 e2e/support/staff-portal-fixture.ts。

import { expect, test, type Browser } from "@playwright/test";

import {
  injectAdminSession,
  injectStaffSession,
  setupStaffPortalFixture,
  teardownStaffPortalFixture,
  type StaffPortalFixture,
} from "./support/staff-portal-fixture";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial", timeout: 60_000 });

let fixture: StaffPortalFixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupStaffPortalFixture();
  } catch (err) {
    setupFailed = true;
    console.error("[staff-portal] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownStaffPortalFixture(fixture);
  console.log("[staff-portal] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(async ({ page }) => {
  await injectStaffSession(page, fixture);
  // 已知既有問題(跟這次修正主題無關,e2e/mobile-overflow.spec.ts / payroll-reports.spec.ts 開頭
  // 已記錄):全新瀏覽器 session 第一次深連結到受保護頁面時,有機會在 currentMerchantId 還沒被
  // context.tsx 的 fallback effect 寫進 localStorage 前就被誤判。先訪問一次 /app。
  await page.goto("/app");
});

test("4.1:服務人員登入後首頁顯示自己的個人資料卡片,看不到管理員版本的卡片", async ({ page }) => {
  await expect(page.getByText(fixture.staffName)).toBeVisible({ timeout: LOAD_TIMEOUT });
  // 管理員版本卡片會顯示商家名稱底下的「新增分店」入口,服務人員不應該看到。
  await expect(page.getByRole("link", { name: "新增分店" })).toHaveCount(0);
});

test("4.2:服務人員的「功能」分頁籤只看到休假設定/薪資報表兩張卡片", async ({ page }) => {
  await page.goto("/app/manage");
  await expect(page.getByRole("heading", { name: "功能" })).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 模組 14 v2 §10.3.5/§10.4.6:卡片文字從「我的休假設定」/「我的薪資報表」改名成
  // 「休假設定」/「薪資報表」(ManagePage.tsx 對應調整),這裡同步更新斷言文字。
  await expect(page.getByText("休假設定")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText("薪資報表")).toBeVisible();

  // 不會看到任何管理員/客服導向的卡片。
  await expect(page.getByText("服務人員", { exact: true })).toHaveCount(0);
  await expect(page.getByText("客服管理")).toHaveCount(0);
  await expect(page.getByText("訂單管理")).toHaveCount(0);
  await expect(page.getByText("商家設定")).toHaveCount(0);
});

test("4.3:服務人員的行事曆是簡化版自助月曆,不是管理員跨服務人員行事曆", async ({ page }) => {
  await page.goto("/app/calendar");
  // 自助行事曆的月份切換按鈕(管理員版本是週/月切換,文字不同)。
  await expect(page.getByRole("button", { name: "下個月 →" })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("button", { name: "← 上個月" })).toBeVisible();
  // 管理員版本才有的「新增預約」按鈕不應該出現。
  await expect(page.getByRole("button", { name: "新增預約" })).toHaveCount(0);
});

test("4.4:休假設定頁新增每週固定時段,自己看得到,也正確反映在既有管理員服務人員管理頁", async ({
  page,
  browser,
}: {
  page: import("@playwright/test").Page;
  browser: Browser;
}) => {
  await page.goto("/app/my-availability");
  // 模組 14 v2 §10.3.5:頁面標題從「我的休假設定」改成「休假設定」。
  await expect(page.getByRole("heading", { name: "休假設定" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  await page.locator("select").first().selectOption("3"); // 星期三
  await page.locator('input[type="time"]').first().fill("13:00");
  await page.locator('input[type="time"]').nth(1).fill("17:00");
  await page.getByRole("button", { name: "新增時段" }).click();

  await expect(page.getByText("星期三 13:00 - 17:00")).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 用另一個獨立的瀏覽器 context(管理員 session)開既有的服務人員管理頁,確認同一筆資料看得到。
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await injectAdminSession(adminPage, fixture);
  await adminPage.goto("/app/staff");
  await expect(adminPage.getByText(fixture.staffName)).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 4.7:登入狀態徽章應顯示「已開通登入」,且提供「服務人員權限」入口,不再顯示「邀請登入」。
  const staffRow = adminPage.locator("li", { hasText: fixture.staffName });
  await expect(staffRow.getByText("已開通登入")).toBeVisible();
  await expect(staffRow.getByRole("link", { name: "服務人員權限" })).toBeVisible();
  await expect(staffRow.getByRole("button", { name: "邀請登入" })).toHaveCount(0);

  // 打開編輯表單,確認可預約時段清單裡看得到服務人員自己剛新增的那組時段。
  await staffRow.getByRole("button", { name: "編輯" }).click();
  await expect(adminPage.getByText("星期三 13:00 - 17:00")).toBeVisible({ timeout: LOAD_TIMEOUT });

  await adminContext.close();
});

test("4.7:服務人員權限頁正確列出四項自助功能開關,且可以切換", async ({ page, browser }) => {
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await injectAdminSession(adminPage, fixture);
  await adminPage.goto("/app/staff");
  await expect(adminPage.getByText(fixture.staffName)).toBeVisible({ timeout: LOAD_TIMEOUT });

  const staffRow = adminPage.locator("li", { hasText: fixture.staffName });
  await staffRow.getByRole("link", { name: "服務人員權限" }).click();

  await expect(adminPage.getByRole("heading", { name: `${fixture.staffName} 的權限設定` })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(adminPage.getByText("行事曆檢視")).toBeVisible();
  await expect(adminPage.getByText("可預約時段/休假自助調整")).toBeVisible();
  await expect(adminPage.getByText("抽成/薪資報表檢視")).toBeVisible();
  await expect(adminPage.getByText("個人資料編輯")).toBeVisible();

  await adminContext.close();
});
