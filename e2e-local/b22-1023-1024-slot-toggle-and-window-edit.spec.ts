// 第 22 批(#1023、#1024)本機 e2e。本機 Supabase 專用(e2e-local 設定,loopback guard 生效,不碰正式庫)。
// 規格書:.project/specs/可預約時段規則與直接調時間-第22批.md
//
//   K1 #1023 商家端時間軸:服務人員 A(每週 09:00–12:00)時段外灰格不是按鈕、一般箭頭、點了沒有選單;
//      時段內照舊有「新增預約」+「關閉時段」(1280 / 375)
//   K2 #1023 直接呼叫 set_staff_day_override 在時段外「開放」⇒ 白話錯誤、沒寫進資料庫;時段內照舊
//   K3 #1023 服務人員端時間軸(A 可以新增編輯訂單 + 排班自助):時段外灰格不是按鈕(1280 / 375)
//   K4 #1024 商家端 編輯服務人員 → 可預約時段:直接改結束時間 ⇒ 儲存成功(同一列);重疊 / 倒置 ⇒ `!` + 儲存不能按;
//      改了沒存按 Esc ⇒ 先問「確定放棄這次輸入？」(1280 / 375 截圖)
//   K5 #1024 服務人員端 休假設定:直接改開始時間 ⇒ 儲存;商家端另一個分頁的行事曆 5 秒內自己更新(即時同步)
//
// fixture 沿用 e2e-local/support/staff-live-sync-fixture.ts,teardown 一樣三段核對。
// 截圖存 B22_SHOTS(預設 test-results/b22-shots/;🔴 不寫進 .project/notes/ui-ref-2026-10-01/after/)。
// 執行:E2E_LOCAL_PORT=5306 npx playwright test --config playwright.local.config.ts b22-1023-1024
//
// 用語:一律「服務人員」。
import { mkdirSync } from "node:fs";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { Session } from "@supabase/supabase-js";

import { primeStaffCurrentMerchant } from "../e2e/support/app-shell";
import { buildTaipeiIso } from "../src/modules/booking/dateUtils";
import { DAY_OF_WEEK_LABELS } from "../src/modules/booking/types";
import { getCurrentMerchantStorageKey } from "../src/modules/merchant/constants";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";
import {
  injectSession,
  serviceClient,
  setupLiveSyncFixture,
  teardownLiveSyncFixture,
  type LiveSyncFixture,
} from "./support/staff-live-sync-fixture";

const LOAD_TIMEOUT = 20_000;
const SHOTS = process.env["B22_SHOTS"] ?? "test-results/b22-shots";
const DISCARD_TITLE = "確定放棄這次輸入？";
const OUTSIDE_MSG =
  "這段時間不在這位服務人員的每週可預約時段內，無法開放。需要在時段外排單時，請由商家開啟「商家後台編輯無時段限制」。";

test.use({ timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "serial", timeout: 240_000 });

let fixture: LiveSyncFixture;
let setupFailed = false;
let adminSession: Session;
let dayLabel = "";
let windowAId = "";
let windowA2Id = "";
const recorders: RequestRecorder[] = [];
const contexts: BrowserContext[] = [];
const pageErrors: string[] = [];

function must(label: string, error: { message: string } | null): void {
  if (error) throw new Error(`${label}失敗:${error.message}`);
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  try {
    mkdirSync(SHOTS, { recursive: true });
    fixture = await setupLiveSyncFixture();
    const s = await fixture.m1.admin.auth.getSession();
    if (!s.data.session) throw new Error("讀不到管理員甲的 session");
    adminSession = s.data.session;
    const svc = serviceClient();

    // 服務人員 A:有時段限制、可以新增編輯訂單、按件計酬 + 排班自助(服務人員端可點格子、可進休假設定)。
    const taipeiDow = new Date(buildTaipeiIso(fixture.dateKey, "12:00")).getUTCDay();
    dayLabel = `星期${DAY_OF_WEEK_LABELS[taipeiDow]}`;
    must(
      "改服務人員 A 設定",
      (
        await svc
          .from("merchant_staff")
          .update({
            unlimited_backend_edit: false,
            can_create_edit_orders: true,
            show_member_info: true,
            compensation_type: "piece_rate",
          })
          .eq("id", fixture.staffA.staffId)
      ).error,
    );
    must(
      "開服務人員 A 排班自助",
      (
        await svc.from("merchant_staff_permissions").upsert(
          {
            staff_id: fixture.staffA.staffId,
            section_key: "staff_availability_self_manage",
            granted: true,
          },
          { onConflict: "staff_id,section_key" },
        )
      ).error,
    );
    const w = await svc
      .from("staff_availability_windows")
      .insert([
        {
          staff_id: fixture.staffA.staffId,
          day_of_week: taipeiDow,
          start_time: "09:00",
          end_time: "12:00",
        },
        {
          staff_id: fixture.staffA.staffId,
          day_of_week: taipeiDow,
          start_time: "14:00",
          end_time: "16:00",
        },
      ])
      .select("id, start_time");
    must("服務人員 A 每週時段", w.error);
    const rows = w.data as { id: string; start_time: string }[];
    windowAId = rows.find((r) => r.start_time.startsWith("09:00"))!.id;
    windowA2Id = rows.find((r) => r.start_time.startsWith("14:00"))!.id;
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  for (const c of contexts) await c.close();
  for (const r of recorders) expectOnlyLocalRequests(r);
  if (setupFailed || !fixture) return;
  const actions = await teardownLiveSyncFixture(fixture);
  console.log(`[b22 teardown] ${actions.join(";")}`);
  expect(pageErrors, "頁面沒有 JS 錯誤").toEqual([]);
});

async function newPage(browser: Browser, width: number, height = 900): Promise<Page> {
  const mobile = width < 768;
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
    timezoneId: "Asia/Taipei",
  });
  contexts.push(context);
  const p = await context.newPage();
  recorders.push(recordRequestHosts(p));
  p.on("pageerror", (err) => {
    if (!/ServiceWorker|sw\.js|unsupported MIME type|ERR_NAME_NOT_RESOLVED/.test(err.message)) {
      pageErrors.push(err.message);
    }
  });
  await p.route("**/functions/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  return p;
}

async function asAdmin(p: Page, path: string): Promise<void> {
  await injectSession(p, adminSession);
  await p.addInitScript(([k, v]) => window.localStorage.setItem(k, v), [
    getCurrentMerchantStorageKey(fixture.m1.adminUserId),
    fixture.m1.merchantId,
  ] as [string, string]);
  await p.goto(path);
}

async function openMerchantCalendar(p: Page): Promise<void> {
  await asAdmin(p, `/app/calendar?date=${fixture.dateKey}`);
  await p
    .getByRole("radiogroup", { name: "檢視模式" })
    .getByRole("radio", { name: "週檢視" })
    .click({ timeout: LOAD_TIMEOUT });
  await expect(p.getByTestId(`staff-grid-${fixture.staffA.staffId}`)).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
}

/** 某一欄某個時間那一格(#1049 起格線 00:00 開始,每格 30 分鐘;按 top 排序)。 */
function slotAt(p: Page, gridTestId: string, time: string) {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const index = (h * 60 + m) / 30;
  return p.getByTestId(gridTestId).locator(":scope > [data-slot-state]").nth(index);
}

async function look(p: Page, gridTestId: string, time: string) {
  return slotAt(p, gridTestId, time).evaluate((node) => ({
    state: node.getAttribute("data-slot-state"),
    cursor: getComputedStyle(node).cursor,
    tag: node.tagName,
  }));
}

async function openStaffTimeline(p: Page, session: Session) {
  await injectSession(p, session);
  await primeStaffCurrentMerchant(p, LOAD_TIMEOUT);
  await p.goto("/app/calendar");
  await expect(p.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await p.getByRole("button", { name: "時間軸格線" }).click();
  await expect(p.getByTestId("my-timeline-grid")).toHaveAttribute("data-interactive", "true", {
    timeout: LOAD_TIMEOUT,
  });
}

test("K1 #1023 商家端:時段外灰格沒有開關選項、不可點;時段內照舊", async ({ browser }) => {
  const grid = `staff-grid-${fixture.staffA.staffId}`;
  for (const width of [1280, 375]) {
    const p = await newPage(browser, width);
    await openMerchantCalendar(p);
    const inside = await look(p, grid, "09:00");
    const outside = await look(p, grid, "13:00");
    console.log(`[K1 ${width}]`, JSON.stringify({ inside, outside }));
    expect(inside).toMatchObject({ state: "available", tag: "BUTTON", cursor: "pointer" });
    expect(outside).toMatchObject({ state: "unavailable", tag: "DIV" });
    expect(outside.cursor).not.toBe("pointer");

    await slotAt(p, grid, "13:00").scrollIntoViewIfNeeded();
    await slotAt(p, grid, "13:00").click({ force: true });
    await expect(p.getByRole("menuitem")).toHaveCount(0);
    await p.screenshot({ path: `${SHOTS}/K1-merchant-outside-no-menu-${width}.png` });

    await slotAt(p, grid, "09:00").scrollIntoViewIfNeeded();
    await slotAt(p, grid, "09:00").click();
    await expect(p.getByRole("menuitem", { name: "新增預約" })).toBeVisible();
    await expect(p.getByRole("menuitem", { name: "關閉時段" })).toBeVisible();
    await p.screenshot({ path: `${SHOTS}/K1-merchant-inside-menu-${width}.png` });
    await p.keyboard.press("Escape");
    await p.context().close();
  }
});

test("K2 #1023 直接呼叫 RPC:時段外開放被擋、沒寫進資料庫;時段內關閉 / 再開照舊", async () => {
  const bad = await fixture.m1.admin.rpc("set_staff_day_override", {
    p_staff_id: fixture.staffA.staffId,
    p_override_date: fixture.dateKey,
    p_start_time: "13:00",
    p_end_time: "13:30",
    p_is_available: true,
  });
  expect(bad.error?.message).toBe(OUTSIDE_MSG);
  // (服務人員本人走 staff_set_my_slot 也一樣擋 —— 由 pgTAP req977_08 ⑯b 驗)
  const rows = await serviceClient()
    .from("staff_availability_overrides")
    .select("slot_start_time")
    .eq("staff_id", fixture.staffA.staffId)
    .eq("override_date", fixture.dateKey);
  expect(rows.error).toBeNull();
  expect(rows.data, "被擋下的開放沒有寫進去").toEqual([]);

  const close = await fixture.m1.admin.rpc("set_staff_day_override", {
    p_staff_id: fixture.staffA.staffId,
    p_override_date: fixture.dateKey,
    p_start_time: "10:00",
    p_end_time: "10:30",
    p_is_available: false,
  });
  expect(close.error).toBeNull();
  const reopen = await fixture.m1.admin.rpc("set_staff_day_override", {
    p_staff_id: fixture.staffA.staffId,
    p_override_date: fixture.dateKey,
    p_start_time: "10:00",
    p_end_time: "10:30",
    p_is_available: true,
  });
  expect(reopen.error, "時段內再開照舊可以").toBeNull();
  const clear = await fixture.m1.admin.rpc("clear_staff_day_override", {
    p_staff_id: fixture.staffA.staffId,
    p_override_date: fixture.dateKey,
    p_start_time: "10:00",
    p_end_time: "10:30",
  });
  expect(clear.error).toBeNull();
});

test("K3 #1023 服務人員端時間軸:時段外灰格不是按鈕;時段內照舊", async ({ browser }) => {
  for (const width of [1280, 375]) {
    const p = await newPage(browser, width);
    await openStaffTimeline(p, fixture.staffA.session);
    const inside = await look(p, "my-timeline-grid", "09:00");
    const outside = await look(p, "my-timeline-grid", "13:00");
    console.log(`[K3 ${width}]`, JSON.stringify({ inside, outside }));
    expect(inside).toMatchObject({ state: "available", tag: "BUTTON", cursor: "pointer" });
    expect(outside).toMatchObject({ state: "unavailable", tag: "DIV" });
    expect(outside.cursor).not.toBe("pointer");
    await slotAt(p, "my-timeline-grid", "13:00").scrollIntoViewIfNeeded();
    await p.screenshot({ path: `${SHOTS}/K3-staff-timeline-${width}.png` });
    await p.context().close();
  }
});

async function openStaffEdit(p: Page, firstRange = "09:00 - 12:00"): Promise<void> {
  await asAdmin(p, "/app/staff");
  const row = p.locator("li", { hasText: fixture.staffA.name }).first();
  await expect(row).toBeVisible({ timeout: LOAD_TIMEOUT });
  await row.getByRole("button", { name: "編輯" }).click();
  await expect(p.getByText(`${dayLabel} ${firstRange}`)).toBeVisible({ timeout: LOAD_TIMEOUT });
}

test("K4 #1024 商家端編輯服務人員:直接改時間、重疊 / 倒置擋下、改了沒存 Esc 先問", async ({
  browser,
}) => {
  const label = `${dayLabel} 09:00 - 12:00`;
  for (const width of [375, 1280]) {
    const p = await newPage(browser, width);
    await openStaffEdit(p);
    const end = p.getByLabel(`${label}的結束時間`);
    await end.scrollIntoViewIfNeeded();
    await expect(p.getByRole("button", { name: `刪除${label}` })).toBeVisible();

    // 重疊 ⇒ `!` + 儲存不能按
    await end.fill("15:00");
    await expect(
      p.getByText(`這個時段跟同一天已設定的「14:00–16:00」重疊，請調整時間。`),
    ).toBeVisible();
    await expect(p.getByRole("button", { name: `儲存${label}` })).toBeDisabled();
    await p.screenshot({ path: `${SHOTS}/K4-merchant-overlap-${width}.png` });

    // 倒置
    await end.fill("08:30");
    await expect(p.getByText("開始時間必須早於結束時間")).toBeVisible();
    await expect(p.getByRole("button", { name: `儲存${label}` })).toBeDisabled();

    // 改了沒存 ⇒ Esc 先問
    await end.fill("12:30");
    await p.keyboard.press("Escape");
    await expect(p.getByText(DISCARD_TITLE)).toBeVisible();
    await p.getByRole("button", { name: "繼續編輯" }).click();
    await expect(p.getByText(DISCARD_TITLE)).toHaveCount(0);

    if (width === 375) {
      // 375 這一輪只驗擋下與 dirty,按「還原」不存
      await p.getByRole("button", { name: `還原${label}` }).click();
      await expect(p.getByRole("button", { name: `刪除${label}` })).toBeVisible();
      await p.screenshot({ path: `${SHOTS}/K4-merchant-reverted-${width}.png` });
      await p.context().close();
      continue;
    }

    await p.screenshot({ path: `${SHOTS}/K4-merchant-dirty-${width}.png` });
    await p.getByRole("button", { name: `儲存${label}` }).click();
    await expect(p.getByText("已更新可預約時段")).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(p.getByText(`${dayLabel} 09:00 - 12:30`)).toBeVisible({ timeout: LOAD_TIMEOUT });
    await p.screenshot({ path: `${SHOTS}/K4-merchant-saved-${width}.png` });
    // 存完 = 沒有填過 ⇒ Esc 直接關
    await p.keyboard.press("Escape");
    await expect(p.getByText(DISCARD_TITLE)).toHaveCount(0);

    const row = await serviceClient()
      .from("staff_availability_windows")
      .select("id, start_time, end_time")
      .eq("id", windowAId)
      .single();
    expect(row.error).toBeNull();
    expect(row.data, "同一列(id 不變)改成新時間").toMatchObject({
      id: windowAId,
      start_time: "09:00:00",
      end_time: "12:30:00",
    });
    await p.context().close();
  }
});

test("K5 #1024 服務人員端休假設定:直接改時間 ⇒ 商家端另一個分頁行事曆即時更新", async ({
  browser,
}) => {
  const merchant = await newPage(browser, 1280);
  await openMerchantCalendar(merchant);
  const grid = `staff-grid-${fixture.staffA.staffId}`;
  await expect(slotAt(merchant, grid, "13:30")).toHaveAttribute("data-slot-state", "unavailable");
  await merchant.waitForTimeout(1_500); // 等商家頻道 join

  for (const width of [375, 1280]) {
    const p = await newPage(browser, width);
    await injectSession(p, fixture.staffA.session);
    await primeStaffCurrentMerchant(p, LOAD_TIMEOUT);
    await p.goto("/app/my-availability");
    await expect(p.getByRole("heading", { name: "休假設定" })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    const label = `${dayLabel} 14:00 - 16:00`;
    await expect(p.getByText(label)).toBeVisible({ timeout: LOAD_TIMEOUT });
    if (width === 375) {
      await p.getByLabel(`${label}的開始時間`).fill("15:00");
      await p.getByLabel(`${label}的開始時間`).scrollIntoViewIfNeeded();
      await p.screenshot({ path: `${SHOTS}/K5-staff-dirty-${width}.png` });
      await p.getByRole("button", { name: `還原${label}` }).click();
      await p.context().close();
      continue;
    }
    await p.getByLabel(`${label}的開始時間`).fill("13:30");
    await p.getByRole("button", { name: `儲存${label}` }).click();
    await expect(p.getByText("已更新可預約時段")).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(p.getByText(`${dayLabel} 13:30 - 16:00`)).toBeVisible({ timeout: LOAD_TIMEOUT });
    await p.screenshot({ path: `${SHOTS}/K5-staff-saved-${width}.png` });
    await p.context().close();
  }

  // 商家端沒重整,5 秒內 13:30 那一格自己變成可預約
  await expect(slotAt(merchant, grid, "13:30")).toHaveAttribute("data-slot-state", "available", {
    timeout: 5_000,
  });
  await slotAt(merchant, grid, "13:30").scrollIntoViewIfNeeded();
  await merchant.screenshot({ path: `${SHOTS}/K5-merchant-live-updated-1280.png` });
  const row = await serviceClient()
    .from("staff_availability_windows")
    .select("start_time")
    .eq("id", windowA2Id)
    .single();
  expect((row.data as { start_time: string }).start_time).toBe("13:30:00");
});

test("K6 主腦裁決:新增時段跟同一天已設定的重疊 ⇒ 畫面擋下(訊息跟編輯一致)、沒寫進資料庫", async ({
  browser,
}) => {
  const p = await newPage(browser, 1280);
  await openStaffEdit(p, "09:00 - 12:30"); // K4 已把這一組改成 09:00–12:30
  const before = await serviceClient()
    .from("staff_availability_windows")
    .select("id")
    .eq("staff_id", fixture.staffA.staffId);
  const taipeiDow = new Date(buildTaipeiIso(fixture.dateKey, "12:00")).getUTCDay();
  await p.getByRole("combobox", { name: "星期" }).selectOption(String(taipeiDow));
  await p.getByLabel("開始時間", { exact: true }).fill("11:00");
  await p.getByLabel("結束時間", { exact: true }).fill("13:00");
  await p.getByRole("button", { name: "新增時段" }).click();
  await expect(
    p.getByText("這個時段跟同一天已設定的「09:00–12:30」重疊，請調整時間。"),
  ).toBeVisible({ timeout: LOAD_TIMEOUT });
  await p.screenshot({ path: `${SHOTS}/K6-merchant-add-overlap-1280.png` });
  const after = await serviceClient()
    .from("staff_availability_windows")
    .select("id")
    .eq("staff_id", fixture.staffA.staffId);
  expect(after.data?.length).toBe(before.data?.length);
  await p.context().close();
});
