// 模組 15(服務人員推播通知)前端部分的 Playwright 測試,重用模組 14 既有的
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
//      實際訂閱/取消訂閱是真的呼叫 staff_push_subscriptions 這張表的 RLS 保護 insert/delete
//      (不是 mock),驗證的是前端邏輯 + RLS 政策的真實互動。

import { expect, test } from "@playwright/test";

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
    console.error("[push-notifications] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownStaffPortalFixture(fixture);
  console.log("[push-notifications] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

async function stubServiceWorkerAndPushManager(page: import("@playwright/test").Page): Promise<void> {
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
    Object.defineProperty(window.navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve(fakeRegistration),
        register: async () => fakeRegistration,
        addEventListener: () => {},
        controller: null,
      },
    });
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

test("推播通知設定頁(§7.9):管理員切換開關並編輯文案後正確儲存,重新整理後仍然生效", async ({
  page,
}) => {
  await injectAdminSession(page, fixture);
  await page.goto("/app");
  await expect(page.getByText("目前操作中的商家")).toBeVisible({ timeout: LOAD_TIMEOUT });

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

test("服務人員開啟/關閉推播通知(§7.2):訂閱成功寫入裝置清單,取消訂閱後移除", async ({ page }) => {
  await stubServiceWorkerAndPushManager(page);
  await injectStaffSession(page, fixture);
  await page.goto("/app");
  await expect(page.getByText(fixture.staffName)).toBeVisible({ timeout: LOAD_TIMEOUT });

  await expect(page.getByText("訂單通知", { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText("目前沒有任何裝置開通推播通知。")).toBeVisible({ timeout: LOAD_TIMEOUT });

  await page.getByRole("button", { name: "開啟訂單通知" }).click();
  await expect(page.getByText("已開啟訂單通知")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText("這台裝置已開啟通知")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("button", { name: "移除這台裝置" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  await page.getByRole("button", { name: "關閉此裝置通知" }).click();
  await expect(page.getByText("已關閉這台裝置的通知")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("button", { name: "開啟訂單通知" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByText("目前沒有任何裝置開通推播通知。")).toBeVisible({ timeout: LOAD_TIMEOUT });
});
