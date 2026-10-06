// 「權限收緊與服務人員開關修正 第 3 批」(#976 / #977)本機 e2e。
// 規格書:.project/specs/權限收緊與服務人員開關修正-第3批.md 第五節第 3 點。
// 只連本機 Docker 的 Supabase(`npm run test:e2e:local`),瀏覽器一律 Playwright headless;
// 每一條都斷言「這一頁只打本機」(request-guard)。
//
//   B1 客服沒有 line_marketing(只有 line_notification):功能頁看不到「再行銷通知」卡片,打網址被導回(首頁 / 功能頁)
//   B2 客服有 line_marketing:功能頁看得到卡片,點進去看得到已綁定 LINE 的會員名單
//   B3 Edge Function line-send-marketing(本機實際執行):line_marketing 客服 200(沒綁定的會員被跳過,不會真的打 LINE);
//      只有 line_notification 的客服 403
//   B4 服務人員端:「服務人員是否顯示會員資料」關閉 ⇒ 列表與詳情只看得到客戶姓名,沒有電話、地址;
//      打開之後重新整理 ⇒ 看得到
//   B5 排班一覽:商家管理員打 /app/scheduling ⇒ 導回功能頁
import { expect, test, type Page } from "@playwright/test";

import { expectOnlyLocalRequests, recordRequestHosts } from "./support/request-guard";
import {
  clientAs,
  CUSTOMER_NAME,
  injectSession,
  setShowMemberInfo,
  setupBatch3Fixture,
  teardownBatch3Fixture,
  type Batch3Fixture,
} from "./support/permission-batch3-fixture";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial" });

let fixture: Batch3Fixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupBatch3Fixture();
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownBatch3Fixture(fixture);
  console.log("[權限第3批] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

async function openManage(page: Page) {
  await page.goto("/app");
  await page.goto("/app/manage");
  // 前提:功能頁真的載入完成(看得到「報表匯出中心」以外任何卡片前,先等頁面標題列)。
  await expect(page.getByRole("link", { name: /LINE 通知設定/ })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
}

test("B1 沒有 line_marketing 的客服:看不到「再行銷通知」卡片,打網址被導回", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await injectSession(page, fixture.notifySession);
  await openManage(page); // 前提:他有 LINE 通知設定權限,所以這張卡片看得到(證明頁面真的渲染了卡片)
  await expect(page.getByRole("link", { name: /再行銷通知/ })).toHaveCount(0);

  await page.goto("/app/line-marketing");
  // 守衛導回 /app(首頁);客服的首頁外殼會再把他帶到功能頁 ⇒ 兩者都算「被導回」,重點是不能停在再行銷通知頁。
  await expect(page).toHaveURL(/\/app(\/manage)?$/, { timeout: LOAD_TIMEOUT });
  await expect(page.getByText(fixture.boundMemberName)).toHaveCount(0);
  expectOnlyLocalRequests(recorder);
});

test("B2 有 line_marketing 的客服:看得到卡片、進得去、名單載得出來", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await injectSession(page, fixture.marketingSession);
  await page.goto("/app");
  await page.goto("/app/manage");
  const card = page.getByRole("link", { name: /再行銷通知/ });
  await expect(card).toBeVisible({ timeout: LOAD_TIMEOUT });
  // 對照:他沒有 LINE 通知設定權限,那張卡片看不到(兩把獨立的鑰匙)
  await expect(page.getByRole("link", { name: /LINE 通知設定/ })).toHaveCount(0);

  await card.click();
  await expect(page).toHaveURL(/\/app\/line-marketing$/);
  await expect(
    page.getByTestId("line-marketing-individual-list").getByText(fixture.boundMemberName),
  ).toBeVisible({ timeout: LOAD_TIMEOUT });
  expectOnlyLocalRequests(recorder);
});

test("B3 Edge Function line-send-marketing:line_marketing 客服 200、只有 LINE 通知權限的客服 403", async () => {
  const body = {
    merchant_id: fixture.merchantId,
    member_ids: [fixture.unboundMemberId],
    message: "E2E 第 3 批測試訊息(對象沒綁定 LINE,會被跳過)",
  };

  const allowed = await clientAs(fixture.marketingSession).functions.invoke("line-send-marketing", {
    body,
  });
  expect(allowed.error, `line_marketing 客服應該放行:${allowed.error?.message}`).toBeNull();
  expect(allowed.data).toEqual({ sentCount: 0, failedCount: 0, skippedCount: 1 });

  const denied = await clientAs(fixture.notifySession).functions.invoke("line-send-marketing", {
    body,
  });
  expect(denied.error).not.toBeNull();
  const status = (denied.error as { context?: Response } | null)?.context?.status;
  expect(status).toBe(403);
});

test("B4 服務人員端:關閉「顯示會員資料」只看得到客戶姓名;打開後看得到電話地址", async ({
  page,
}) => {
  const recorder = recordRequestHosts(page);
  await injectSession(page, fixture.staffSession);
  await page.goto("/app");
  await page.goto("/app/calendar");
  await expect(page.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 前提:這張單真的在畫面上
  const card = page.getByText(CUSTOMER_NAME, { exact: true });
  await expect(card).toBeVisible({ timeout: LOAD_TIMEOUT });
  // 列表:沒有電話、沒有地址
  await expect(page.getByText(fixture.customerPhone)).toHaveCount(0);
  await expect(page.getByText(fixture.customerAddress)).toHaveCount(0);

  // 詳情:只有姓名
  await card.click();
  await expect(page.getByText("預約詳情")).toBeVisible({ timeout: LOAD_TIMEOUT });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(CUSTOMER_NAME)).toBeVisible();
  await expect(dialog.locator('a[href^="tel:"]')).toHaveCount(0);
  await expect(dialog.getByText(fixture.customerPhone)).toHaveCount(0);
  await expect(dialog.getByText(fixture.customerAddress)).toHaveCount(0);

  // 打開開關 ⇒ 重新整理後看得到(證明上面「看不到」不是因為根本沒資料)
  await setShowMemberInfo(fixture, true);
  await page.reload();
  await expect(page.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText(fixture.customerAddress)).toBeVisible({ timeout: LOAD_TIMEOUT });
  // 開啟後卡片那一行是「姓名・電話」,改點地址那一行打開同一張卡片的詳情。
  await expect(page.getByText(`${CUSTOMER_NAME}・${fixture.customerPhone}`)).toBeVisible();
  await page.getByText(fixture.customerAddress).click();
  await expect(page.getByRole("dialog").locator('a[href^="tel:"]')).toHaveCount(1);
  await setShowMemberInfo(fixture, false);
  expectOnlyLocalRequests(recorder);
});

test("B5 排班一覽隱藏中:商家管理員打 /app/scheduling 被導回功能頁", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await injectSession(page, fixture.adminSession);
  await page.goto("/app");
  await page.goto("/app/scheduling");
  await expect(page).toHaveURL(/\/app\/manage$/, { timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("link", { name: /排班一覽/ })).toHaveCount(0);
  expectOnlyLocalRequests(recorder);
});
