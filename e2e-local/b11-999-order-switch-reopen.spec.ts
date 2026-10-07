// SPECS-INDEX #999(第 11 批):服務人員編輯頁 `order-switch-confirm` 小卡窗「取消後很快再點開關」的遮罩 bug。
// 本機 Supabase 專用(e2e-local 設定,loopback guard 生效,不碰正式庫)。
//
// 症狀(修之前):按「取消」後約 100~175ms 內再點「服務人員新增編輯訂單」開關,小卡窗會重新打開,
// 但上一次還在播退場動畫的節點留在 body、新的遮罩被插在它後面 ⇒ 遮罩蓋在小卡窗上面,按鈕點不到。
// 修法比照第 11 批 E(AgentPermissionsPage.tsx):每次打開 +1 的 dialogSeq 當 CardAlertDialog 的 key,整組重新掛載。
//
// 這支用**真實滑鼠**(page.mouse 依座標點,不用 locator.click 的自動等待 / 可點檢查)重現:
//   取消 → 等 100 / 140 / 175ms → 點開關 → 小卡窗重開 → 按鈕中心點最上層的元素必須是按鈕本身
//   (elementFromPoint)→ 用滑鼠按「取消」真的關得掉、開關沒變。最後再走一次「一起開啟」確認按得到。
//   測完只動表單、不按儲存 ⇒ 資料庫不變(service client 核對)。
//
// 執行:npx playwright test --config playwright.local.config.ts b11-999-order-switch-reopen
import { expect, test, type Locator, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import { expectOnlyLocalRequests, recordRequestHosts } from "./support/request-guard";
import {
  injectSession,
  serviceClient,
  setupLiveSyncFixture,
  teardownLiveSyncFixture,
  type LiveSyncFixture,
} from "./support/staff-live-sync-fixture";

const LOAD_TIMEOUT = 20_000;

test.use({ timezoneId: "Asia/Taipei", viewport: { width: 1280, height: 900 } });
test.describe.configure({ mode: "serial", timeout: 180_000 });

let fixture: LiveSyncFixture;

test.beforeAll(async () => {
  test.setTimeout(150_000);
  fixture = await setupLiveSyncFixture();
});

test.afterAll(async () => {
  if (!fixture) return;
  const actions = await teardownLiveSyncFixture(fixture);
  console.log("[#999] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

const dialog = (page: Page) => page.getByTestId("order-switch-confirm");

/** 用滑鼠點某個元素的中心(不經過 Playwright 的可點檢查,遮罩擋住就真的點到遮罩)。 */
async function mouseClickCenter(page: Page, target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  if (!box) throw new Error("量不到 boundingBox");
  const p = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.click(p.x, p.y);
  return p;
}

/** 按鈕中心點最上層的元素是不是按鈕本身(或它裡面的字)。 */
async function topmostIsButton(page: Page, button: Locator): Promise<boolean> {
  const box = await button.boundingBox();
  if (!box) return false;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  return button.evaluate(
    (el, [px, py]) => {
      const hit = document.elementFromPoint(px as number, py as number);
      return hit !== null && (hit === el || el.contains(hit));
    },
    [x, y],
  );
}

async function settle(page: Page) {
  await page
    .locator('[data-testid="order-switch-confirm"][data-state="open"]')
    .evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
}

test("#999 取消後 100~190ms 再點開關:小卡窗重開、按鈕在最上層、滑鼠點得到", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await page.route("**/functions/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  const session = (await fixture.m1.admin.auth.getSession()).data.session;
  expect(session).not.toBeNull();
  await injectSession(page, session!);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
  await page.goto("/app/staff");
  const card = page.locator("li").filter({ hasText: fixture.staffA.name });
  await card.getByRole("button", { name: "編輯" }).click({ timeout: LOAD_TIMEOUT });

  const orders = page.getByRole("switch", { name: /服務人員新增編輯訂單/ });
  const member = page.getByRole("switch", { name: /服務人員是否顯示會員資料/ });
  await expect(orders).toHaveAttribute("data-state", "unchecked", { timeout: LOAD_TIMEOUT });
  await expect(member).toHaveAttribute("data-state", "unchecked");
  // 編輯全頁層的開場動畫播完、開關捲進畫面,滑鼠座標才會落在開關上(否則會點到層外)。
  await page
    .getByRole("dialog")
    .first()
    .evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  await orders.scrollIntoViewIfNeeded();

  // 開關的座標先量好(之後不再量,避免量座標的來回時間把點擊推遲到退場動畫結束之後)。
  const ob = (await orders.boundingBox())!;
  const switchPoint = { x: ob.x + ob.width / 2, y: ob.y + ob.height / 2 };

  // 遮罩退場 150ms、小卡窗本體退場 200ms ⇒ 卡在兩者之間重開最容易出事;從 100ms 掃到 190ms。
  // 太早點的那一下可能被「還在退場的遮罩」吃掉(小卡窗沒重開,使用者再點一次就好,不是本 bug)⇒ 記下來跳過;
  // 只要有重開,按鈕就必須在最上層、滑鼠點得到。最後要求至少有一次是在 150ms 之後重開(證明危險區間有被測到)。
  const openDialog = page.locator('[data-testid="order-switch-confirm"][data-state="open"]');
  const reopenedAt: number[] = [];
  const swallowedAt: number[] = [];
  for (const delay of [100, 120, 140, 150, 160, 170, 175, 180, 190]) {
    await expect(dialog(page)).toHaveCount(0, { timeout: 5_000 });
    // ① 打開小卡窗(滑鼠點開關),等開場動畫播完
    await page.mouse.click(switchPoint.x, switchPoint.y);
    await expect(openDialog).toBeVisible();
    await settle(page);
    // ② 滑鼠按「取消」→ 退場動畫還在播的時候(delay ms 後,瀏覽器內計時)再點開關
    const cb = (await openDialog.getByRole("button", { name: "取消" }).boundingBox())!;
    await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), delay);
    await page.mouse.click(switchPoint.x, switchPoint.y);
    // 等所有開場 / 退場動畫都結束,畫面定下來再判斷
    await page.waitForTimeout(500);
    if ((await openDialog.count()) === 0) {
      swallowedAt.push(delay);
      await expect(orders).toHaveAttribute("data-state", "unchecked");
      continue;
    }
    reopenedAt.push(delay);
    // ③ 小卡窗重新打開
    await expect(openDialog).toHaveCount(1);
    await expect(openDialog).toContainText("要一起開啟「服務人員是否顯示會員資料」嗎？");
    // ④ 按鈕中心點最上層的元素必須是按鈕本身(遮罩沒有蓋在上面)
    const cancel = openDialog.getByRole("button", { name: "取消" });
    expect(
      await topmostIsButton(page, cancel),
      `取消後 ${delay}ms 重開:「取消」按鈕被別的元素(遮罩)蓋住`,
    ).toBe(true);
    expect(
      await topmostIsButton(page, openDialog.getByRole("button", { name: "一起開啟" })),
      `取消後 ${delay}ms 重開:「一起開啟」按鈕被別的元素(遮罩)蓋住`,
    ).toBe(true);
    // ⑤ 用滑鼠按「取消」真的關得掉,開關都沒變
    await mouseClickCenter(page, cancel);
    await expect(dialog(page)).toHaveCount(0, { timeout: 5_000 });
    await expect(orders).toHaveAttribute("data-state", "unchecked");
    await expect(member).toHaveAttribute("data-state", "unchecked");
  }
  console.log(
    `[#999] 重開的延遲:${reopenedAt.join(", ")} ms;被退場遮罩吃掉的:${swallowedAt.join(", ") || "無"}`,
  );
  expect(
    reopenedAt.some((d) => d >= 150),
    "150ms 之後至少要有一次重開(危險區間要測到)",
  ).toBe(true);

  // ⑥ 再走一次「取消 → 很快再點 → 一起開啟」:滑鼠點得到,兩個開關一起開
  const lateDelay = Math.max(...reopenedAt);
  await page.mouse.click(switchPoint.x, switchPoint.y);
  await expect(openDialog).toBeVisible();
  await settle(page);
  await mouseClickCenter(page, openDialog.getByRole("button", { name: "取消" }));
  await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), lateDelay);
  await page.mouse.click(switchPoint.x, switchPoint.y);
  await page.waitForTimeout(500);
  await expect(openDialog).toHaveCount(1);
  await mouseClickCenter(page, openDialog.getByRole("button", { name: "一起開啟" }));
  await expect(dialog(page)).toHaveCount(0, { timeout: 5_000 });
  await expect(orders).toHaveAttribute("data-state", "checked");
  await expect(member).toHaveAttribute("data-state", "checked");

  // 只改表單、沒按儲存 ⇒ 資料庫不變
  const row = await serviceClient()
    .from("merchant_staff")
    .select("can_create_edit_orders,show_member_info")
    .eq("id", fixture.staffA.staffId)
    .single();
  expect(row.error).toBeNull();
  expect(row.data).toEqual({ can_create_edit_orders: false, show_member_info: false });
  expectOnlyLocalRequests(recorder);
});
