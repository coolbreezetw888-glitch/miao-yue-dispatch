// SPECS-INDEX #802(規格書 .project/specs/手機推播擴及三種角色.md §13.7 / §十之二「面板與點擊」):
// 站內通知中心(鈴鐺)面板「點一列」的端對端測試。
//
// 這支測試驗四件事(§13.7),順序刻意是「前提 → 行為」兩段式(automated-testing SKILL 第四節:
// 對空面板做斷言等於什麼都沒驗):
//   ① 前提:鈴鐺上真的出現未讀數字(證明通知真的透過產品路徑寫進 user_notifications 了)
//   ② 點開面板 → 看得到那一則,標題/內文正確
//   ③ 點一列 → 變成已讀(未讀 badge 消失、未讀圓點消失、資料庫 read_at 真的被寫入)
//   ④ 點一列 → 導到正確的頁面(管理員 → /app/orders;純函式 resolveNotificationLink)
//      ⚠️ 絕對不能是 /app/my-calendar —— 那是個不存在的路由(§〇.5 的既有教訓)
//
// 🔴 通知怎麼來的:見 e2e/support/notification-bell-fixture.ts 檔頭。一句話:user_notifications
//    只有 service role 寫得進去,e2e 環境沒有(也不該有)那把 key,所以 fixture 用測試帳號自己的
//    JWT 走「create_booking RPC → push-notify-dispatch Edge Function」這條產品正常路徑,讓通知
//    自然產生。沒有任何權限被放寬。
//
// ⚠️ 這支測試會呼叫**正式環境**的 Edge Function 並在正式資料庫留下測試商家(SPECS-INDEX #638
//    的既知技術債),請不要無故重跑。
//
// 🔴 檔名一定要是 *.spec.ts:*.test.ts 放進 e2e/ 會讓整套 Playwright 靜默歸零
//    (automated-testing SKILL 第三節)。
import { expect, test } from "@playwright/test";

import {
  fetchFixtureNotificationReadStates,
  injectNotificationBellFixtureSession,
  setupNotificationBellFixture,
  teardownNotificationBellFixture,
  type NotificationBellFixture,
} from "./support/notification-bell-fixture";
import { primeCurrentMerchant } from "./support/app-shell";

const LOAD_TIMEOUT = 20_000;

/** §13.7 第 3 點 / §5.5 的角色→網址對照表:admin → /app/orders。 */
const EXPECTED_ADMIN_DESTINATION = "/app/orders";
const EXPECTED_ADMIN_DESTINATION_TITLE = "訂單管理";

test.describe.configure({ mode: "serial", timeout: 90_000 });

let fixture: NotificationBellFixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupNotificationBellFixture();
    console.log(
      "[notification-bell] push-notify-dispatch 回傳:",
      JSON.stringify(fixture.dispatchResult),
      `;fixture 帳號自己查到的站內通知列數:${fixture.notificationRowCount}`,
    );
  } catch (err) {
    setupFailed = true;
    console.error("[notification-bell] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownNotificationBellFixture(fixture);
  console.log(
    "[notification-bell] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"),
  );
});

test.beforeEach(async ({ page }) => {
  await injectNotificationBellFixtureSession(page, fixture);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
});

test("§13.7 ①②:鈴鐺出現未讀數字,點開面板看得到那一則通知(標題/內文正確、未讀圓點在)", async ({
  page,
}) => {
  // 前提斷言(資料層):fixture 用測試帳號自己的 RLS 視角查到「恰好一列」。
  // 恰好一列是刻意的:訂單只指派了一位沒有登入身份的服務人員,收件人只有管理員本人。
  // 這個數字不對,後面對 badge 的「1」與「消失」兩個斷言就沒有意義。
  expect(fixture.notificationRowCount).toBe(1);

  // 前提斷言(畫面層):鈴鐺上真的有未讀數字,而且就是 1。
  const bell = page.getByTestId("notification-bell");
  await expect(bell).toBeVisible({ timeout: LOAD_TIMEOUT });
  const badge = page.getByTestId("notification-unread-badge");
  await expect(badge).toHaveText("1", { timeout: LOAD_TIMEOUT });

  // ② 點開面板 → 看得到那一則。
  await bell.click();
  const panel = page.getByTestId("notification-panel");
  await expect(panel).toBeVisible({ timeout: LOAD_TIMEOUT });

  const rows = panel.getByTestId("notification-row");
  await expect(rows).toHaveCount(1, { timeout: LOAD_TIMEOUT });
  const row = rows.first();
  // 標題:商家總開關那張表設定的標題(帶 runId,不可能跟別的資料撞到);管理員這個身份的
  // title 會被 Edge Function 組成「<顯示名稱>·<標題>」(pushDispatchCore buildRecipientTitle)。
  await expect(row).toContainText(fixture.expectedTitleFragment);
  // 內文:預設模板 `{{booking_date}} {{customer_name}}‧{{service_names}}` 套完之後要帶出客戶姓名
  // —— 這同時證明 §13.4 的「取變數 + 套文案在裝置查詢之前」沒有退步(沒裝置的人也有內文)。
  await expect(row).toContainText(fixture.customerName);
  // 事件標籤沿用 PUSH_NOTIFICATION_EVENT_LABELS(§13.7),不是另一套白話名稱。
  await expect(row).toContainText("新訂單");
  // 還沒點過,未讀圓點要在。
  await expect(row.getByTestId("notification-unread-dot")).toHaveCount(1);
  // 單一商家的使用者不顯示商家名稱那一行(§13.7:那是雜訊)。
  await expect(row.getByTestId("notification-merchant-name")).toHaveCount(0);
});

test("§13.7 ③④:點一列 → 變成已讀(badge 消失、read_at 寫入)並導到 /app/orders(不是 /app/my-calendar)", async ({
  page,
}) => {
  // 前提斷言:進來的時候還是未讀(上一條測試沒有點過它;serial 模式保證順序)。
  const badge = page.getByTestId("notification-unread-badge");
  await expect(badge).toHaveText("1", { timeout: LOAD_TIMEOUT });
  const before = await fetchFixtureNotificationReadStates(fixture);
  expect(before).toHaveLength(1);
  expect(before[0]!.read_at).toBeNull();

  await page.getByTestId("notification-bell").click();
  const panel = page.getByTestId("notification-panel");
  await expect(panel).toBeVisible({ timeout: LOAD_TIMEOUT });
  const row = panel.getByTestId("notification-row").first();
  await expect(row).toContainText(fixture.expectedTitleFragment, { timeout: LOAD_TIMEOUT });

  await row.click();

  // ④ 導到正確的頁面:管理員 → /app/orders(resolveNotificationLink 的對照表)。
  //    用 URL 結尾精準比對,/app/my-calendar 這種不存在的路由會直接紅。
  await expect(page).toHaveURL(/\/app\/orders$/, { timeout: LOAD_TIMEOUT });
  expect(new URL(page.url()).pathname).toBe(EXPECTED_ADMIN_DESTINATION);
  // 頁面真的渲染出來了(不是 404 / 空白):頁首標題是「訂單管理」(appLayoutLogic 的標題規則)。
  await expect(page.getByTestId("app-header-title")).toHaveText(EXPECTED_ADMIN_DESTINATION_TITLE, {
    timeout: LOAD_TIMEOUT,
  });
  // §13.7 第 4 步:面板要關閉。
  await expect(panel).toBeHidden({ timeout: LOAD_TIMEOUT });

  // ③ 變成已讀 —— 畫面層:唯一那則未讀被標掉之後,badge 要消失(0 → 不顯示,§13.5)。
  await expect(badge).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  // ③ 變成已讀 —— 資料層:read_at 真的被 mark_my_notifications_read 寫進去了(不是只有前端快取變了)。
  await expect
    .poll(async () => (await fetchFixtureNotificationReadStates(fixture))[0]?.read_at ?? null, {
      timeout: LOAD_TIMEOUT,
    })
    .not.toBeNull();

  // 再打開一次面板:那一列還在(已讀未讀一起顯示),但未讀圓點不見了。
  await page.getByTestId("notification-bell").click();
  await expect(panel).toBeVisible({ timeout: LOAD_TIMEOUT });
  const rowAfter = panel.getByTestId("notification-row").first();
  await expect(rowAfter).toContainText(fixture.expectedTitleFragment, { timeout: LOAD_TIMEOUT });
  await expect(rowAfter.getByTestId("notification-unread-dot")).toHaveCount(0);
});
