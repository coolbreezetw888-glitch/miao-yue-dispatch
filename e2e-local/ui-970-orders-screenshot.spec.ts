// #970(訂單管理列表卡片一律白底)的改後截圖 + 底色斷言。本機 Supabase 專用(e2e-local 設定)。
// 建 4 張單:待確認 / 已確認 / 已完成 / 已取消,截 375px 的訂單管理列表,並斷言每張卡片背景都是白色、
// 左側色條仍然存在(border-left-width 4px)。
//
// 執行:npx playwright test --config playwright.local.config.ts ui-970-orders-screenshot
// 截圖:../.project/notes/ui-ref-2026-10-01/after/after-970-orders-375.png

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import {
  adminCreateBooking,
  adminRpc,
  injectSession,
  setupLiveSyncFixture,
  teardownLiveSyncFixture,
  type LiveSyncFixture,
} from "./support/staff-live-sync-fixture";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, "../../.project/notes/ui-ref-2026-10-01/after");

test.use({ timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "default", timeout: 180_000 });

let fixture: LiveSyncFixture;

test.beforeAll(async () => {
  test.setTimeout(150_000);
  mkdirSync(OUT_DIR, { recursive: true });
  fixture = await setupLiveSyncFixture();
});

test.afterAll(async () => {
  if (fixture) await teardownLiveSyncFixture(fixture);
});

test("#970 訂單管理卡片一律白底", async ({ browser }) => {
  const staffId = fixture.staffA.staffId;
  const pending = await adminCreateBooking(fixture, fixture.m1, {
    staffId,
    time: "09:00",
    customerName: "E2E白底待確認",
  });
  const confirmed = await adminCreateBooking(fixture, fixture.m1, {
    staffId,
    time: "10:00",
    customerName: "E2E白底已確認",
  });
  await adminRpc(fixture.m1, "confirm_booking", { p_booking_id: confirmed.id });
  const completed = await adminCreateBooking(fixture, fixture.m1, {
    staffId,
    time: "11:00",
    customerName: "E2E白底已完成",
  });
  await adminRpc(fixture.m1, "confirm_booking", { p_booking_id: completed.id });
  await adminRpc(fixture.m1, "complete_booking", { p_booking_id: completed.id });
  const cancelled = await adminCreateBooking(fixture, fixture.m1, {
    staffId,
    time: "12:00",
    customerName: "E2E白底已取消",
  });
  await adminRpc(fixture.m1, "cancel_booking", {
    p_booking_id: cancelled.id,
    p_reason: "e2e 本機:#970 截圖",
  });
  expect(pending.id).toBeTruthy();

  const adminSession = (await fixture.m1.admin.auth.getSession()).data.session;
  expect(adminSession).not.toBeNull();
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    timezoneId: "Asia/Taipei",
  });
  const page = await context.newPage();
  await injectSession(page, adminSession!);
  await page.goto("/app/orders");

  const labels = ["待確認", "已確認", "已完成", "已取消"];
  for (const name of ["E2E白底待確認", "E2E白底已確認", "E2E白底已完成", "E2E白底已取消"]) {
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
  }
  // 每張卡片:背景白色、左側色條 4px 還在。
  const styles = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>("div.border-l-4"));
    return cards.map((el) => {
      const cs = getComputedStyle(el);
      return {
        text: el.innerText.slice(0, 40),
        bg: cs.backgroundColor,
        borderLeftWidth: cs.borderLeftWidth,
        borderLeftColor: cs.borderLeftColor,
      };
    });
  });
  console.log("[#970] 卡片樣式:", JSON.stringify(styles, null, 1));
  expect(styles.length).toBeGreaterThanOrEqual(4);
  for (const s of styles) {
    expect(["rgb(255, 255, 255)", "oklch(1 0 0)"]).toContain(s.bg);
    expect(s.borderLeftWidth).toBe("4px");
  }
  for (const label of labels) {
    expect(styles.some((s) => s.text.includes(label))).toBe(true);
  }

  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(OUT_DIR, "after-970-orders-375.png"), fullPage: true });
  await context.close();
});
