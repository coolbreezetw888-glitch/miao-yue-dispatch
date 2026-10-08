// SPECS-INDEX #973(功能頁說明收成「?」)+ #981(服務人員端行事曆訂單卡片白底)的本機 e2e。
// 規格書:.project/specs/商家端文案與說明調整-第1批.md 第六節第 2 點。本機 Supabase 專用(e2e-local 設定,
// loopback guard 生效,不碰正式庫)。
//
//   ① 手機 375px:功能頁(服務人員管理)→ 說明不常駐 → 點「?」看到說明 → 點外面關閉
//   ② 電腦 1280px:功能頁(LINE 串接設定)→ 點「?」看到說明(含官方 LINE@ 與設定費)→ 點外面關閉;
//      另驗 Esc 也能關
//   ③ 320px:說明框打開時整頁不產生橫向捲動,說明框不超出畫面
//   ④ 服務人員端行事曆:卡片列表 + 時間軸格線兩種檢視,每張訂單卡片背景都是白色,左側 4px 狀態色條還在
//
// 執行:npx playwright test --config playwright.local.config.ts ui-973-981-help-and-staff-cards

import { expect, test, type Browser, type Page } from "@playwright/test";

import { assertNoHorizontalOverflow } from "../e2e/support/overflow-assert";
import {
  adminCreateBooking,
  adminRpc,
  injectSession,
  setupLiveSyncFixture,
  teardownLiveSyncFixture,
  type LiveSyncFixture,
} from "./support/staff-live-sync-fixture";

const LOAD_TIMEOUT = 20_000;
const WHITE = ["rgb(255, 255, 255)", "oklch(1 0 0)"];

test.use({ timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "default", timeout: 180_000 });

let fixture: LiveSyncFixture;

test.beforeAll(async () => {
  test.setTimeout(150_000);
  fixture = await setupLiveSyncFixture();
});

test.afterAll(async () => {
  if (fixture) await teardownLiveSyncFixture(fixture);
});

async function openAsAdmin(browser: Browser, width: number, path: string): Promise<Page> {
  const session = (await fixture.m1.admin.auth.getSession()).data.session;
  expect(session).not.toBeNull();
  const mobile = width < 768;
  const context = await browser.newContext({
    viewport: { width, height: mobile ? 812 : 900 },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
    timezoneId: "Asia/Taipei",
  });
  const page = await context.newPage();
  await page.route("**/functions/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await injectSession(page, session!);
  // 全新 session 第一次深連結受保護頁面,先訪問 /app 讓「目前商家」寫進 localStorage(既有已知問題)。
  await page.goto("/app");
  await expect(page.getByTestId("manage-page")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.goto(path);
  return page;
}

test("#973 手機 375px:服務人員管理頁的說明收進「?」,點開看得到、點外面關閉", async ({
  browser,
}) => {
  const page = await openAsAdmin(browser, 375, "/app/staff");
  await expect(page.getByRole("heading", { level: 1, name: "服務人員管理" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  const desc = page.getByText("的服務人員名錄。");
  await expect(desc).toHaveCount(0);

  const trigger = page.getByRole("button", { name: "說明", exact: true });
  await trigger.click();
  await expect(page.getByTestId("page-help-popover")).toBeVisible();
  await expect(desc).toBeVisible();

  // 點框外(頁面標題)
  await page.getByRole("heading", { level: 1, name: "服務人員管理" }).click();
  await expect(page.getByTestId("page-help-popover")).toHaveCount(0);
  await expect(desc).toHaveCount(0);
  await page.context().close();
});

test("#973 電腦 1280px:LINE 串接設定頁「?」說明含官方 LINE@ 與設定費,點外面 / Esc 都會關", async ({
  browser,
}) => {
  const page = await openAsAdmin(browser, 1280, "/app/line-settings");
  await expect(page.getByRole("heading", { level: 1, name: "LINE 串接設定" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByText("將酌收設定費 $3000")).toHaveCount(0);

  const trigger = page.getByRole("button", { name: "說明", exact: true });
  await trigger.click();
  const popover = page.getByTestId("page-help-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("串接 LINE 官方帳號，之後訂單、請假等通知才能真正送出。");
  await expect(popover).toContainText("官方 LINE@ 協助設定");
  await expect(popover).toContainText("將酌收設定費 $3000。");
  // 官方 LINE@ 網址還沒申請 ⇒ 純文字,不是連結。
  await expect(popover.getByRole("link")).toHaveCount(0);

  await page.mouse.click(1200, 850);
  await expect(popover).toHaveCount(0);

  await trigger.click();
  await expect(page.getByTestId("page-help-popover")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("page-help-popover")).toHaveCount(0);
  await page.context().close();
});

test("#973 320px:說明框打開時不產生橫向捲動,框也不超出畫面", async ({ browser }) => {
  // 用說明最長的頁(月薪人員假別設定,標題也最長)壓測。
  const page = await openAsAdmin(browser, 320, "/app/leave-types");
  await expect(page.getByRole("heading", { level: 1, name: "月薪人員假別設定" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await page.getByRole("button", { name: "說明", exact: true }).click();
  const popover = page.getByTestId("page-help-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("假別的扣款規則也在這一頁設定");
  const box = await popover.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  await assertNoHorizontalOverflow(page, "320px 月薪人員假別設定(說明框打開)");
  await page.context().close();
});

test("#981 服務人員端行事曆:卡片列表與時間軸格線的訂單卡片都是白底,左側狀態色條還在", async ({
  browser,
}) => {
  const staff = fixture.staffA;
  await adminCreateBooking(fixture, fixture.m1, {
    staffId: staff.staffId,
    time: "09:00",
    customerName: "E2E981待確認",
  });
  const confirmed = await adminCreateBooking(fixture, fixture.m1, {
    staffId: staff.staffId,
    time: "10:30",
    customerName: "E2E981已確認",
  });
  await adminRpc(fixture.m1, "confirm_booking", { p_booking_id: confirmed.id });
  // 📌 已取消的單不會出現在服務人員端行事曆(get_my_booking_schedule 不回傳),所以第三張用「已完成」。
  const completed = await adminCreateBooking(fixture, fixture.m1, {
    staffId: staff.staffId,
    time: "12:00",
    customerName: "E2E981已完成",
  });
  await adminRpc(fixture.m1, "confirm_booking", { p_booking_id: completed.id });
  await adminRpc(fixture.m1, "complete_booking", { p_booking_id: completed.id });

  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    timezoneId: "Asia/Taipei",
  });
  const page = await context.newPage();
  await page.route("**/functions/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await injectSession(page, staff.session);
  await page.goto("/app");
  await page.goto("/app/calendar");
  await expect(page.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({ timeout: LOAD_TIMEOUT });
  for (const name of ["E2E981待確認", "E2E981已確認", "E2E981已完成"]) {
    await expect(page.getByText(name).first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  }

  // ① 卡片列表
  const listStyles = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("li div.border-l-4")).map((el) => {
      const cs = getComputedStyle(el);
      return {
        text: el.innerText.slice(0, 40),
        bg: cs.backgroundColor,
        borderLeftWidth: cs.borderLeftWidth,
      };
    }),
  );
  console.log("[#981] 卡片列表樣式:", JSON.stringify(listStyles));
  expect(listStyles.length).toBeGreaterThanOrEqual(3);
  for (const s of listStyles) {
    expect(WHITE).toContain(s.bg);
    expect(s.borderLeftWidth).toBe("4px");
  }
  for (const label of ["待確認", "已確認", "已完成"]) {
    expect(listStyles.some((s) => s.text.includes(label))).toBe(true);
  }

  // ② 時間軸格線
  await page.getByRole("button", { name: "時間軸格線" }).click();
  const block = page.getByRole("button", { name: /E2E981已確認/ });
  await expect(block).toBeVisible({ timeout: LOAD_TIMEOUT });
  const blockStyles = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("button"))
      .filter((b) => /E2E981/.test(b.innerText))
      .map((b) => {
        const cs = getComputedStyle(b);
        return {
          text: b.innerText,
          bg: cs.backgroundColor,
          color: cs.color,
          borderLeftWidth: cs.borderLeftWidth,
        };
      }),
  );
  console.log("[#981] 時間軸色塊樣式:", JSON.stringify(blockStyles));
  expect(blockStyles.length).toBeGreaterThanOrEqual(3);
  // #1012(第 18 批):時間軸卡片改成整張填滿狀態色 + 白字(#981 的時間軸白底作廢;卡片清單仍白底,見上面 ①)。
  for (const s of blockStyles) {
    expect(WHITE).not.toContain(s.bg);
    expect(s.color).toBe("rgb(255, 255, 255)");
    expect(s.borderLeftWidth).toBe("4px");
  }
  await context.close();
});
