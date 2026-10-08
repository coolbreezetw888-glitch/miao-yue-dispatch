// 客戶端第 2 批(C2-A05 / C2-F01)本機 e2e:後台「LINE 登入」設定卡(商家端 + 超管商家詳細頁)。
// 規格書:.project/specs/客戶端第2批-LINE登入與訪客預約.md。fixture 見 support/c2-line-login-fixture.ts。
// **只在本機跑**:`npx playwright test --config playwright.local.config.ts c2-merchant-line-login-settings`
// 截圖:E2E_SHOT_DIR(預設 test-results/c2-shots)。
import { expect, test, type Page, type Response } from "@playwright/test";

import { injectSession, serviceClient } from "./support/c1-public-booking-fixture";
import {
  SECRET_SENTINEL,
  setupC2Fixture,
  teardownC2Fixture,
  type C2Fixture,
} from "./support/c2-line-login-fixture";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";

const LOAD_TIMEOUT = 20_000;
const SHOT_DIR = process.env["E2E_SHOT_DIR"] ?? "test-results/c2-shots";
/** 第二組哨兵(重新輸入 secret 用;32 碼英數)。 */
const SECRET_SENTINEL_2 = "SENTINELSECRETB123456789abcdef99";
/** 超管幫 B 設定用(32 碼英數)。 */
const SECRET_SENTINEL_B = "SENTINELSECRETC123456789abcdef77";

test.use({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "default", timeout: 150_000 });

let fixture: C2Fixture;
let setupFailed = false;
let recorders: RequestRecorder[] = [];

test.beforeAll(async () => {
  test.setTimeout(240_000);
  try {
    fixture = await setupC2Fixture();
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(240_000);
  if (setupFailed || !fixture) return;
  const actions = await teardownC2Fixture(fixture);
  console.log(
    "[c2-line-login-settings 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"),
  );
});

test.beforeEach(() => {
  recorders = [];
});
test.afterEach(() => {
  expect(recorders.length, "前提:這條測試至少開過一個頁面").toBeGreaterThan(0);
  for (const r of recorders) expectOnlyLocalRequests(r);
});

function track(page: Page): void {
  recorders.push(recordRequestHosts(page));
}

function collectRpcBodies(page: Page): string[] {
  const bodies: string[] = [];
  page.on("response", (res: Response) => {
    if (!res.url().includes("/rest/v1/")) return;
    void res
      .text()
      .then((t) => bodies.push(t))
      .catch(() => undefined);
  });
  return bodies;
}

async function shotBoth(page: Page, name: string): Promise<void> {
  const card = page.getByTestId("line-login-settings-card");
  await page.setViewportSize({ width: 1280, height: 900 });
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOT_DIR}/${name}_1280.png`, fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${name}:375 寬不可以有橫向捲動`).toBeLessThanOrEqual(clientWidth);
  await page.screenshot({ path: `${SHOT_DIR}/${name}_375.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
}

test("C2-A05 / F01 商家管理員:已啟用狀態與兩種提示;重新輸入 secret 後畫面與回應原文都搜不到", async ({
  page,
}) => {
  track(page);
  const bodies = collectRpcBodies(page);
  await injectSession(page, fixture.c1.adminSession);
  await page.goto("/app/line-settings");
  const card = page.getByTestId("line-login-settings-card");
  await expect(card.getByTestId("line-login-status")).toContainText("已啟用", {
    timeout: LOAD_TIMEOUT,
  });
  await expect(card.getByTestId("line-login-never-succeeded")).toBeVisible();
  await expect(card.getByTestId("line-login-secret-masked")).toHaveText("••••ef01");
  await expect(card.getByTestId("line-login-callback-url")).toHaveValue(/\/auth\/line\/callback$/);
  await shotBoth(page, "10_settings_enabled");

  // 沒連結官方帳號(最近一次登入查到的結果)⇒ 常駐黃色提示。
  const svc = serviceClient();
  const upd = await svc
    .from("merchant_line_login_configs")
    .update({ linked_oa_status: "not_linked", last_login_succeeded_at: new Date().toISOString() })
    .eq("merchant_id", fixture.c1.merchantAId)
    .select("merchant_id");
  expect(upd.error).toBeNull();
  await page.reload();
  await expect(card.getByTestId("line-login-oa-not-linked")).toContainText(
    "客人登入後收不到 LINE 通知",
    { timeout: LOAD_TIMEOUT },
  );
  await expect(card.getByTestId("line-login-never-succeeded")).toHaveCount(0);
  await shotBoth(page, "11_settings_oa_not_linked");

  // 重新輸入 secret ⇒ 存完畫面只剩遮罩。
  await card.getByTestId("line-login-secret-reenter").click();
  await card.getByTestId("line-login-channel-secret").fill(SECRET_SENTINEL_2);
  await card.getByTestId("line-login-save").click();
  await expect(card.getByTestId("line-login-secret-masked")).toHaveText("••••ef99", {
    timeout: LOAD_TIMEOUT,
  });
  await page.reload();
  await expect(card.getByTestId("line-login-secret-masked")).toHaveText("••••ef99", {
    timeout: LOAD_TIMEOUT,
  });
  const html = await page.content();
  expect(html).not.toContain(SECRET_SENTINEL);
  expect(html).not.toContain(SECRET_SENTINEL_2);
  await expect.poll(() => bodies.length).toBeGreaterThan(2);
  const all = bodies.join("\n");
  expect(all).not.toContain(SECRET_SENTINEL);
  expect(all).not.toContain(SECRET_SENTINEL_2);
});

test("C2-A05 客服(只有會員權限)看不到 LINE 登入設定卡", async ({ page }) => {
  track(page);
  await injectSession(page, fixture.agent.session);
  await page.goto("/app/line-settings");
  await expect(page.locator("main")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("line-login-settings-card")).toHaveCount(0);
});

test("C2-A05 超級管理員:商家詳細頁幫 B 設定(尚未設定 → 已設定，尚未啟用),最後刪除設定", async ({
  page,
}) => {
  track(page);
  const bodies = collectRpcBodies(page);
  await injectSession(page, fixture.platform.session);
  await page.goto(`/platform-admin/merchants/${fixture.c1.merchantBId}`);
  const card = page.getByTestId("line-login-settings-card");
  await expect(card.getByTestId("line-login-status")).toContainText("尚未設定", {
    timeout: LOAD_TIMEOUT,
  });
  await expect(card.getByTestId("line-login-enable-blocked")).toBeVisible();
  await card.getByTestId("line-login-steps-toggle").click();
  await expect(card.getByTestId("line-login-steps")).toContainText("同一個 Provider");
  await shotBoth(page, "12_settings_not_configured_platform");

  await card.getByTestId("line-login-channel-id").fill("1650000002");
  await card.getByTestId("line-login-channel-secret").fill(SECRET_SENTINEL_B);
  await card.getByTestId("line-login-save").click();
  await expect(card.getByTestId("line-login-status")).toContainText("已設定，尚未啟用", {
    timeout: LOAD_TIMEOUT,
  });
  await expect(card.getByTestId("line-login-secret-masked")).toHaveText("••••ef77");
  expect(await page.content()).not.toContain(SECRET_SENTINEL_B);
  expect(bodies.join("\n")).not.toContain(SECRET_SENTINEL_B);

  // 刪除設定(危險按鈕 + 確認窗)
  await card.getByTestId("line-login-delete").click();
  await page.getByRole("button", { name: "確定刪除" }).click();
  await expect(card.getByTestId("line-login-status")).toContainText("尚未設定", {
    timeout: LOAD_TIMEOUT,
  });
  const left = await serviceClient()
    .from("merchant_line_login_configs")
    .select("merchant_id", { count: "exact", head: true })
    .eq("merchant_id", fixture.c1.merchantBId);
  expect(left.count).toBe(0);
});
