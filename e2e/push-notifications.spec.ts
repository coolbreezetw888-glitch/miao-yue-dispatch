// 模組 15(手機推播通知)前端部分的 Playwright 測試,重用模組 14 既有的
// e2e/support/staff-portal-fixture.ts(已經準備好「商家管理員 + 已完成邀請登入的服務人員」這組
// fixture,不需要另外重新建一份)。
//
//   1. 推播通知設定頁(§7.9):管理員切換開關/編輯文案後正確儲存,重新整理後仍然生效
//      (完全比照 e2e/line-notifications.spec.ts 「LINE 通知設定頁」測試的既有做法)。
//   2. 服務人員開啟/關閉推播通知(§7.2):這個測試環境是 headless Chromium 對著本機
//      `npm run dev` 跑,dev server 不會產生 vite-plugin-pwa 建置出來的 dist/sw.js
//      (那是 `vite build` 才會產生的靜態檔案),所以用 page.addInitScript 在頁面載入前整個替換掉
//      navigator.serviceWorker/window.PushManager(規格書 7.1 測試要求明講:「真正的推播送達
//      無法在自動化測試裡驗證」,這裡驗證的是前端訂閱/取消訂閱的呼叫邏輯跟畫面狀態,不是真的
//      推播送達)。
//      ⚠️ 實測發現(2026-09-22):`browserContext.grantPermissions(["notifications"])` 在這個
//      headless Chromium 環境下,`Notification.permission` 實際還是回報 "denied"(已知的
//      環境限制,不是本模組程式碼的問題),因此改成直接整個替換掉 `window.Notification`
//      (permission 固定 "granted"、requestPermission() 固定 resolve "granted"),驗證重點是
//      我們自己的訂閱/取消訂閱邏輯,不是瀏覽器原生權限對話框本身。
//      實際訂閱/取消訂閱是真的呼叫 push_subscriptions 這張表的 RLS 保護 insert/delete
//      (不是 mock),驗證的是前端邏輯 + RLS 政策的真實互動。
//
// ⚠️ 2026-09-25「手機推播擴及三種角色」批次的異動(規格書 §十之二 的逐項對照表):
//   - 測試 1、2 **完全不動**(驗的是商家層級設定頁,§2.3 明文不碰那張表)。
//   - 測試 3 **最小幅度調整**:訂閱寫入的表從 staff_push_subscriptions 換成 push_subscriptions
//     (§3.1)、卡片文案跟著 §7.1 改版走、並把 §7.5 自動觸發的 push-send-test Edge Function 用
//     page.route 攔下來(否則會對真實 Edge Function 發請求)。**沒有刪掉重寫**——它是編號 584
//     的驗收依據。
//   - 輔助函式 stubServiceWorkerAndPushManager **保留並擴充**:補上可觸發的
//     `navigator.serviceWorker` message 監聽(§6.3 的 postMessage 路徑要能在 e2e 裡被驅動)。
//   - 新增測試 4/5/6:事件開關的預設狀態、商家總開關關閉時停用並寫明原因、切換後重新整理仍生效。

import { expect, test } from "@playwright/test";

import {
  cleanupPushFixtureRows,
  injectAdminSession,
  injectStaffSession,
  setMerchantPushEventEnabled,
  setupStaffPortalFixture,
  teardownStaffPortalFixture,
  type StaffPortalFixture,
} from "./support/staff-portal-fixture";
import { primeCurrentMerchant } from "./support/app-shell";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial", timeout: 60_000 });

let fixture: StaffPortalFixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupStaffPortalFixture();
  } catch (err) {
    setupFailed = true;
    console.error("[push-notifications] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  // ⚠️ 順序不可調換:teardown 會把服務人員軟移除,之後 push_event_subscriptions 的 RLS
  //    (private.owns_push_target 要求 status='active')就再也刪不掉了。
  const pushActions = await cleanupPushFixtureRows(fixture);
  console.log(
    "[push-notifications] 推播資料清理:\n" + pushActions.map((a) => `  - ${a}`).join("\n"),
  );
  const actions = await teardownStaffPortalFixture(fixture);
  console.log(
    "[push-notifications] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"),
  );
});

async function stubServiceWorkerAndPushManager(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.addInitScript(() => {
    const fakeSubscription = {
      endpoint: "https://fcm.example.test/e2e-fake-endpoint",
      toJSON: () => ({
        keys: {
          p256dh: "e2e-fake-p256dh-key-BFg_if7Gen_q313Y3lRXBIdntbLU80t1njSXCDe6DQK",
          auth: "e2e-fake-auth-key-000000000000",
        },
      }),
      unsubscribe: async () => true,
    };
    let currentSubscription: unknown = null;
    const fakeRegistration = {
      pushManager: {
        subscribe: async () => {
          currentSubscription = fakeSubscription;
          return fakeSubscription;
        },
        getSubscription: async () => currentSubscription,
      },
      // src/pwaUpdate.ts 的 registerServiceWorkerAutoUpdate() 每次都會呼叫
      // registration.addEventListener("updatefound", ...),不補這個 no-op 會在 console 留下
      // 一個未處理的 rejection(不影響這支測試驗證的邏輯,但補上比較乾淨)。
      addEventListener: () => {},
      installing: null,
      waiting: null,
    };

    // 2026-09-25 擴充(§6.3):原本 navigator.serviceWorker.addEventListener 是 no-op,
    // 所以「service worker 收到推播 → postMessage 給畫面」這條路在 e2e 裡完全沒辦法被驅動。
    // 改成真的把 listener 收起來,並掛一個 window.__e2eDispatchSwMessage(data) 讓測試可以
    // 模擬 service worker 送訊息給頁面。
    const swListeners: ((event: MessageEvent) => void)[] = [];
    Object.defineProperty(window.navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve(fakeRegistration),
        register: async () => fakeRegistration,
        addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
          if (type === "message") swListeners.push(listener);
        },
        removeEventListener: (type: string, listener: (event: MessageEvent) => void) => {
          if (type !== "message") return;
          const index = swListeners.indexOf(listener);
          if (index >= 0) swListeners.splice(index, 1);
        },
        controller: null,
      },
    });
    // @ts-expect-error 測試專用的觸發器,只存在於 e2e stub 環境。
    window.__e2eDispatchSwMessage = (data: unknown) => {
      for (const listener of [...swListeners]) {
        listener({ data } as MessageEvent);
      }
    };

    // @ts-expect-error 測試環境手動塞入 PushManager 全域建構式,讓 usePushSubscription 的
    // isSupported 判斷通過(dev server 沒有真正的 PWA service worker/PushManager 環境)。
    window.PushManager = function PushManager() {};

    // headless Chromium 底下 browserContext.grantPermissions(["notifications"]) 授權後,
    // Notification.permission 實測仍然回報 "denied"(這個測試環境的已知限制,不是本模組程式碼的
    // 問題——規格書 7.1 測試要求本來就明講「真正的推播送達無法在自動化測試裡驗證」)。這裡直接
    // 整個替換掉 window.Notification,讓 usePushSubscription 讀到的 permission/
    // requestPermission() 行為等同「使用者已經同意」,驗證重點是我們自己的訂閱/取消訂閱邏輯 +
    // 真正的 RLS 保護 insert/delete,不是瀏覽器原生權限對話框本身。
    // @ts-expect-error 測試環境整個替換掉 Notification 全域建構式。
    window.Notification = {
      permission: "granted",
      requestPermission: async () => "granted",
    };
  });
}

/**
 * §7.5:訂閱成功後前端會自動呼叫 push-send-test 這支 Edge Function。e2e 不該對真實的
 * Edge Function 發請求(會真的燒推播配額、也會在 push_notification_log 塞測試資料),
 * 所以一律攔下來。
 *
 * ⚠️ 2026-09-25 品管複查後改寫:原本固定回「沒有裝置」,結果 §7.5 的狀態機**永遠只走到
 *    no_device 那一支**,`[data-testid="push-test-status"]` 的文字一次都沒有被斷言過 ——
 *    而那三句文案正是使用者最在意的 §6.5 誠實紅線。現在改成可以指定回應,讓每一支分支
 *    都真的被畫面驗證到。
 */
type TestPushStubResult =
  { kind: "no_device" } | { kind: "sent"; ackToken: string } | { kind: "rate_limited" };

async function stubTestPushEndpoint(
  page: import("@playwright/test").Page,
  result: TestPushStubResult = { kind: "no_device" },
): Promise<void> {
  await page.route("**/functions/v1/push-send-test", async (route) => {
    if (result.kind === "rate_limited") {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: "測試通知發太多次了,請等一分鐘再試" }),
      });
      return;
    }
    const body =
      result.kind === "sent"
        ? { sent: 1, failed: 0, ack_tokens: [result.ackToken] }
        : { sent: 0, failed: 0, reason: "no_subscription", ack_tokens: [] };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

/** §6.3 第 3 點:模擬 service worker 收到推播之後對所有分頁 postMessage。 */
async function dispatchServiceWorkerMessage(
  page: import("@playwright/test").Page,
  data: unknown,
): Promise<void> {
  await page.evaluate((payload) => {
    (window as unknown as { __e2eDispatchSwMessage: (d: unknown) => void }).__e2eDispatchSwMessage(
      payload,
    );
  }, data);
}

/** 開啟這台裝置的通知,並等到卡片進入「已開通」狀態(測試通知區塊才會出現)。 */
async function subscribeThisDevice(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "開啟通知" }).click();
  await expect(page.getByText("這台裝置已開啟通知")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("push-test-section")).toBeVisible({ timeout: LOAD_TIMEOUT });
}

test("推播通知設定頁(§7.9):管理員切換開關並編輯文案後正確儲存,重新整理後仍然生效", async ({
  page,
}) => {
  await injectAdminSession(page, fixture);
  await primeCurrentMerchant(page);

  await page.goto("/app/push-events");
  await expect(page.getByRole("heading", { name: "推播通知設定" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  const createdCard = page.getByTestId("push-event-card-booking_created");
  await expect(createdCard).toBeVisible({ timeout: LOAD_TIMEOUT });
  const toggle = createdCard.getByRole("switch");

  const newTitle = `E2E測試標題${fixture.runId}`;
  await createdCard.locator("input").fill(newTitle);
  await toggle.click();
  await createdCard.getByRole("button", { name: "儲存" }).click();
  await expect(page.getByText("已儲存推播設定")).toBeVisible({ timeout: LOAD_TIMEOUT });

  await page.reload();
  await expect(page.getByRole("heading", { name: "推播通知設定" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  const reloadedCard = page.getByTestId("push-event-card-booking_created");
  await expect(reloadedCard.locator("input")).toHaveValue(newTitle);
});

test("推播通知設定頁(§13.1,SPECS-INDEX #586):四張卡片都看得到對應事件的可用變數說明,填入文案後標題/內文分開即時預覽", async ({
  page,
}) => {
  await injectAdminSession(page, fixture);
  await primeCurrentMerchant(page);

  await page.goto("/app/push-events");
  await expect(page.getByRole("heading", { name: "推播通知設定" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 4 張卡片各自都要有「可用變數」說明(複用模組 11 §385 的 TemplateVariablePreview 共用元件)。
  const cardEventTypes = [
    "booking_created",
    "booking_cancelled",
    "booking_updated",
    "booking_reminder_next_day",
  ];
  for (const eventType of cardEventTypes) {
    const card = page.getByTestId(`push-event-card-${eventType}`);
    await expect(card.getByText("可用變數:", { exact: false })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
  }

  // booking_updated 只顯示該事件實際會替換到的變數(change_summary),不混入其他事件才有的
  // service_names(對應 §13.1「不把 4 種事件全部變數混在一起列」)。
  //
  // 2026-09-24:原本這兩行是對「整張卡片」找 {{change_summary}},但 booking_updated 的預設
  // 內文範本本身就是 `{{booking_date}} {{customer_name}}:{{change_summary}}`
  // (20260922100100_push_notifications_functions.sql:26 種進去的),所以卡片裡的 textarea
  // 也含有這段文字 → getByText 同時命中「可用變數說明」跟「文案輸入框」兩個節點,
  // Playwright strict mode 直接判定失敗(這支測試從寫出來就沒有真正通過過,只是之前
  // beforeEach 的啟動斷言先逾時,整檔垮掉把它蓋住了)。
  // 驗證意圖完全不變(而且更精準):把斷言限定在「可用變數」那一行說明文字上,確認它列出
  // change_summary、而且沒有混入 service_names——文案輸入框裡剛好也有這串字不該影響判斷。
  const updatedCard = page.getByTestId("push-event-card-booking_updated");
  const updatedVariableHint = updatedCard.getByText("可用變數:", { exact: false });
  await expect(updatedVariableHint).toContainText("{{change_summary}}");
  await expect(updatedVariableHint).not.toContainText("{{service_names}}");

  // 標題/內文分開即時預覽,不合併成一大段文字(§13.1 邊界情況)。
  const createdCard = page.getByTestId("push-event-card-booking_created");
  await createdCard.locator("input").fill("{{customer_name}} 的新預約");
  await createdCard.locator("textarea").fill("{{booking_date}} {{service_names}}");
  // 2026-09-24:同上,這兩行原本沒有 exact:true,「標題」會同時命中欄位標籤「通知標題」跟
  // 即時預覽的段落標籤「標題」兩個節點(strict mode 失敗)。這裡要驗的是「即時預覽分成
  // 標題/內文兩段」,所以用 exact:true 精準指向預覽區的兩個段落標籤。
  await expect(createdCard.getByText("標題", { exact: true })).toBeVisible();
  await expect(createdCard.getByText("內文", { exact: true })).toBeVisible();
  await expect(createdCard.getByText("王小姐 的新預約")).toBeVisible();
  await expect(createdCard.getByText("2026-10-01 14:30 手部保養、單色凝膠")).toBeVisible();
});

test("服務人員開啟/關閉推播通知(§7.2):訂閱成功寫入裝置清單,取消訂閱後移除", async ({ page }) => {
  await stubServiceWorkerAndPushManager(page);
  await stubTestPushEndpoint(page);
  await injectStaffSession(page, fixture);
  await page.goto("/app");
  await expect(page.getByText(fixture.staffName)).toBeVisible({ timeout: LOAD_TIMEOUT });

  await expect(page.getByText("手機推播通知(以服務人員身份)", { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByText("目前沒有任何裝置開通推播通知。")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  await page.getByRole("button", { name: "開啟通知" }).click();
  await expect(page.getByText("已開啟這台裝置的通知")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText("這台裝置已開啟通知")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("button", { name: "移除這台裝置" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  await page.getByRole("button", { name: "關閉此裝置通知" }).click();
  await expect(page.getByText("已關閉這台裝置的通知")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("button", { name: "開啟通知" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByText("目前沒有任何裝置開通推播通知。")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
});

test("事件開關(§7.4/裁決 Q7):服務人員開啟通知後出現 4 個開關且預設全開", async ({ page }) => {
  await stubServiceWorkerAndPushManager(page);
  await stubTestPushEndpoint(page);
  await injectStaffSession(page, fixture);
  await page.goto("/app");
  await expect(page.getByText(fixture.staffName)).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 還沒開通任何裝置時,只給一句說明,不顯示開關清單。
  await expect(page.getByText("先開啟通知,才能選擇要收哪幾種。")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  await page.getByRole("button", { name: "開啟通知" }).click();
  await expect(page.getByText("這台裝置已開啟通知")).toBeVisible({ timeout: LOAD_TIMEOUT });

  const list = page.getByTestId("push-event-toggle-list");
  await expect(list).toBeVisible({ timeout: LOAD_TIMEOUT });
  // §4.5:服務人員看得到四個事件(管理員/客服只有三個)。
  await expect(list.getByRole("switch")).toHaveCount(4);
  for (const eventType of [
    "booking_created",
    "booking_cancelled",
    "booking_updated",
    "booking_reminder_next_day",
  ]) {
    await expect(
      page.getByTestId(`push-event-toggle-${eventType}`).getByRole("switch"),
    ).toHaveAttribute("data-state", "checked");
  }
});

test("事件開關(§4.2 第 4 點):商家總開關關閉的事件要停用並寫明原因,打開之後才能切換", async ({
  page,
}) => {
  await stubServiceWorkerAndPushManager(page);
  await stubTestPushEndpoint(page);
  await injectStaffSession(page, fixture);

  // 新商家種出來的 4 種事件預設全部關閉(seed_default_push_event_settings),先驗「全部灰掉」。
  // ⚠️ 測試 1 已經把 booking_created 打開過了,所以這裡先明確關回去,不依賴前面測試的殘留狀態。
  await setMerchantPushEventEnabled(fixture, "booking_created", false);

  await page.goto("/app");
  await expect(page.getByText(fixture.staffName)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("push-event-toggle-list")).toBeVisible({ timeout: LOAD_TIMEOUT });

  const createdRow = page.getByTestId("push-event-toggle-booking_created");
  await expect(createdRow.getByText("商家尚未開啟這個事件的推播通知")).toBeVisible();
  await expect(createdRow.getByRole("switch")).toBeDisabled();
  // 服務人員看不到「前往推播通知設定」連結(他可能沒有權限進那一頁)。
  await expect(page.getByRole("link", { name: "前往推播通知設定" })).toHaveCount(0);

  // 商家管理員把總開關打開之後,同一列就可以切換了。
  await setMerchantPushEventEnabled(fixture, "booking_created", true);
  await page.reload();
  await expect(page.getByTestId("push-event-toggle-list")).toBeVisible({ timeout: LOAD_TIMEOUT });
  const reloadedRow = page.getByTestId("push-event-toggle-booking_created");
  await expect(reloadedRow.getByText("商家尚未開啟這個事件的推播通知")).toHaveCount(0);
  await expect(reloadedRow.getByRole("switch")).toBeEnabled();
});

test("§4.7(修既有 bug):實際被瀏覽器載入的 push-sw.js 裡不再有 /app/my-calendar 這個不存在的路由", async ({
  request,
}) => {
  // push-sw.js 是 public/ 底下的靜態檔案,dev server 跟 vite build 產出的 dist 都是原封不動
  // 供應同一份內容。這裡直接抓「瀏覽器真的會拿到的那一份」,比讀原始碼更接近實際行為。
  const response = await request.get("/push-sw.js");
  expect(response.status()).toBe(200);
  const source = await response.text();

  // ⚠️ 只看「會被執行的程式碼」,不看註解 —— 檔頭的註解刻意留著 `/app/my-calendar` 這個舊路徑,
  //    因為它在記錄「這次修掉了什麼 bug」(automated-testing SKILL 第五節:記錄改名這件事的
  //    註解要保留舊名)。把註解一起掃進來會讓這條測試永遠紅燈,而且逼人刪掉有價值的紀錄。
  const executable = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  // 這個路由在 src/App.tsx 裡根本不存在 —— 一旦有人收到推播並點下去會落到「找不到頁面」。
  expect(executable).not.toContain("my-calendar");
  // fallback 一律是 /app(這個路由一定存在,HomePage 會依角色自動導到正確落點)。
  expect(executable).toContain('var PUSH_FALLBACK_URL = "/app";');
  // §6.3:測試推播的送達回報與 postMessage 廣播都在這份檔案裡。
  expect(executable).toContain("push-test-received");
  expect(executable).toContain("push-received");
});

test("事件開關(§7.4 第 6 點):切換一個開關之後重新整理仍然生效", async ({ page }) => {
  await stubServiceWorkerAndPushManager(page);
  await stubTestPushEndpoint(page);
  await injectStaffSession(page, fixture);
  await setMerchantPushEventEnabled(fixture, "booking_created", true);

  await page.goto("/app");
  await expect(page.getByTestId("push-event-toggle-list")).toBeVisible({ timeout: LOAD_TIMEOUT });

  const toggle = page.getByTestId("push-event-toggle-booking_created").getByRole("switch");
  await expect(toggle).toHaveAttribute("data-state", "checked");
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-state", "unchecked");

  await page.reload();
  await expect(page.getByTestId("push-event-toggle-list")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(
    page.getByTestId("push-event-toggle-booking_created").getByRole("switch"),
  ).toHaveAttribute("data-state", "unchecked");
});

// =========================================================================
// §6.3 / §7.5:測試通知的狀態機。
//
// 🔴 2026-09-25 品管複查後補上。這一塊特別重要,因為那幾句文案正是使用者最在意的
//    §6.5 誠實紅線所在(裁決 Q5:「文案絕對不可以寫成無法兌現的『已生效』」)。
//    在這之前,紅線只有 Vitest 在守「字串內容」,**沒有任何東西在守「畫面上真的顯示對的那一句」**。
// =========================================================================
test("測試通知(§6.3 核心):送出後先顯示「正在確認」,收到 service worker 回報才改成「已確認你的裝置收到」", async ({
  page,
}) => {
  await stubServiceWorkerAndPushManager(page);
  await stubTestPushEndpoint(page, {
    kind: "sent",
    ackToken: "3f2504e0-4f89-41d3-9a0c-0305e82c33e2",
  });
  await injectStaffSession(page, fixture);
  await page.goto("/app");
  await expect(page.getByText(fixture.staffName)).toBeVisible({ timeout: LOAD_TIMEOUT });

  await subscribeThisDevice(page);

  // 分支一:waiting —— 只陳述「已送出、正在確認」,不承諾任何事。
  const status = page.getByTestId("push-test-status");
  await expect(status).toHaveText("已送出測試通知,正在確認你的裝置是否收到⋯", {
    timeout: LOAD_TIMEOUT,
  });

  // §6.3 第 3 點:service worker 收到推播 → postMessage → 畫面立刻反應(不用等輪詢)。
  await dispatchServiceWorkerMessage(page, { type: "push-test-received" });

  // 分支二:device_acked —— 只說「裝置收到」,而且同一則訊息要誠實提醒「裝置收到 ≠ 你看得到」。
  await expect(status).toContainText("已確認你的裝置收到通知", { timeout: LOAD_TIMEOUT });
  await expect(status).toContainText("靜音或專注模式");

  // 🔴 §6.5 禁止字眼:畫面上這一段絕對不可以出現這些無法兌現的保證。
  const sectionText = (await page.getByTestId("push-test-section").innerText()) || "";
  for (const forbidden of [
    "已生效",
    "已確認生效",
    "通知功能正常",
    "設定完成,你會收到通知",
    "已成功開啟並生效",
  ]) {
    expect(sectionText).not.toContain(forbidden);
  }
});

test("測試通知(§6.3):無關的 service worker 訊息不會讓畫面誤報「已確認」", async ({ page }) => {
  await stubServiceWorkerAndPushManager(page);
  await stubTestPushEndpoint(page, {
    kind: "sent",
    ackToken: "3f2504e0-4f89-41d3-9a0c-0305e82c33e3",
  });
  await injectStaffSession(page, fixture);
  await page.goto("/app");
  await subscribeThisDevice(page);

  const status = page.getByTestId("push-test-status");
  await expect(status).toHaveText("已送出測試通知,正在確認你的裝置是否收到⋯", {
    timeout: LOAD_TIMEOUT,
  });

  // 一般推播的廣播(§13.5 鈴鐺那一批會用到)不是測試推播的回報,不可以拿來當成「已確認」。
  await dispatchServiceWorkerMessage(page, { type: "push-received" });
  await dispatchServiceWorkerMessage(page, { type: "something-else" });

  await expect(status).toHaveText("已送出測試通知,正在確認你的裝置是否收到⋯");
  await expect(status).not.toContainText("已確認");
});

test("測試通知(§6.5 核心):15 秒內沒有任何回報 → 顯示「沒有收到你裝置的回報」+ 排查清單,而不是報喜", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await stubServiceWorkerAndPushManager(page);
  // 用一個資料庫裡不存在的 ack_token:輪詢的 have_my_test_pushes_been_acked 會一直回 false,
  // 15 秒之後狀態機必須落到 no_ack。
  await stubTestPushEndpoint(page, {
    kind: "sent",
    ackToken: "3f2504e0-4f89-41d3-9a0c-0305e82c33e4",
  });
  await injectStaffSession(page, fixture);
  await page.goto("/app");
  await subscribeThisDevice(page);

  const status = page.getByTestId("push-test-status");
  await expect(status).toHaveText("已送出測試通知,正在確認你的裝置是否收到⋯", {
    timeout: LOAD_TIMEOUT,
  });

  // 分支三:no_ack。⚠️ 這裡要等 §6.3 第 4 點的 15 秒逾時,所以 timeout 放寬到 30 秒。
  await expect(status).toContainText("通知已送出,但系統沒有收到你裝置的回報", {
    timeout: 30_000,
  });
  await expect(status).toContainText("如果你的手機剛剛有跳出通知就沒問題");
  // 排查清單要真的列出來(不是只有一句話就結束)。
  await expect(page.getByText("手機開了靜音或專注模式")).toBeVisible();
  await expect(page.getByText("iPhone 沒有先把秒約加到主畫面(Apple 的限制)")).toBeVisible();

  // 🔴 最重要的一條:沒有回報時,畫面絕對不可以出現「已確認」。
  await expect(status).not.toContainText("已確認");
});

test("測試通知(§7.5):這個人一台裝置都沒開通時,顯示「沒有東西可以測試」而不是假警告", async ({
  page,
}) => {
  await stubServiceWorkerAndPushManager(page);
  await stubTestPushEndpoint(page, { kind: "no_device" });
  await injectStaffSession(page, fixture);
  await page.goto("/app");
  await subscribeThisDevice(page);

  await expect(page.getByTestId("push-test-status")).toHaveText(
    "你還沒有在任何裝置上開啟通知,所以沒有東西可以測試",
    { timeout: LOAD_TIMEOUT },
  );
});

test("測試通知(§6.6):「再發一次測試通知」被頻率限制擋下時,顯示等一分鐘再試", async ({ page }) => {
  await stubServiceWorkerAndPushManager(page);
  await stubTestPushEndpoint(page, { kind: "rate_limited" });
  await injectStaffSession(page, fixture);
  await page.goto("/app");
  await subscribeThisDevice(page);

  // 開啟通知時自動打的那一次就已經被擋下了。
  const status = page.getByTestId("push-test-status");
  await expect(status).toHaveText("測試通知發太多次了,請等一分鐘再試", { timeout: LOAD_TIMEOUT });

  // §7.5 第 4 點:測試失敗不可以讓「開啟通知」這件事看起來失敗 —— 卡片仍然是已開通狀態。
  await expect(page.getByText("這台裝置已開啟通知")).toBeVisible();

  // 常駐的「再發一次測試通知」按鈕存在,而且再按一次仍然是同一句話。
  await page.getByRole("button", { name: "再發一次測試通知" }).click();
  await expect(status).toHaveText("測試通知發太多次了,請等一分鐘再試", { timeout: LOAD_TIMEOUT });
});
