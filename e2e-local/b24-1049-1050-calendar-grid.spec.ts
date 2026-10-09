// SPECS-INDEX #1049 / #1050:行事曆格子顯示一致化 + 排程狀態顏色透明度 —— 本機 e2e。
// 規格書:.project/specs/行事曆格子顯示與顏色透明度.md(第六節驗收)。
// 執行:npx playwright test --config playwright.local.config.ts b24-1049(只連本機 Docker Supabase)。
//
//   情境:營業 09:00–18:00(每天),服務人員 A / B 的每週時段 09:00–15:00。
//     A:有開「新增編輯訂單」(可操作畫法);B:沒開(唯讀畫法),而且是月薪制、沒有自己排休權限
//        ⇒ 直接查 staff_availability_windows 讀不到自己的時段(R6 要解的情況)。
//   G1 商家端:每位服務人員一欄 48 格;00–09 與 18–24 深色、09–15 自訂色、15–18 白色;打開時捲到 09:00
//   G2 服務人員 A(有新增編輯訂單):同上;營業時間外的格子不是按鈕
//   G3 服務人員 B(唯讀):同上(唯讀也讀得到自己的時段)
//   G4 R2:使用者自己捲走之後,管理員改時段(即時同步)⇒ 格子跟著變,但畫面不會被拉回 09:00
//   G5 透明度:設定頁把「營業時間外」調到 50% 儲存 ⇒ 商家端、A、B 的深色格子都變成 50%
//   G6 QA M1:B(唯讀)開了商家後台編輯無時段限制 ⇒ 營業時間內全部自訂色,跟商家端一致
//   G7 QA L1:同一天格線容器重掛(商家 週→月→週、服務人員 卡片列表→時間軸)⇒ 再捲到 09:00
//   全部:console 沒有 same key 警告;只打本機。
//
// 截圖存 B24_SHOTS(預設 test-results/b24-shots/;🔴 不寫進 .project/notes/ui-ref-2026-10-01/after/)。
// 用語:一律「服務人員」。
import { mkdirSync } from "node:fs";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { primeStaffCurrentMerchant } from "../e2e/support/app-shell";
import { buildTaipeiIso } from "../src/modules/booking/dateUtils";
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
  type LiveSyncStaff,
} from "./support/staff-live-sync-fixture";

const LOAD_TIMEOUT = 20_000;
const REALTIME_TIMEOUT = 5_000;
const SHOTS = process.env["B24_SHOTS"] ?? "test-results/b24-shots";
const SLOT_PX = 30;
/** 預設「營業時間外」#334155。 */
const DARK = "rgb(51, 65, 85)";
const DARK_50 = "rgba(51, 65, 85, 0.5)";
/** 預設「服務人員可預約時段」#dcfce7。 */
const GREEN = "rgb(220, 252, 231)";

test.describe.configure({ mode: "serial", timeout: 180_000 });

let fixture: LiveSyncFixture;
let setupFailed = false;
let dow = 0;
let windowAId = "";
const recorders: RequestRecorder[] = [];
const contexts: BrowserContext[] = [];
const pageErrors: string[] = [];
const sameKeyWarnings: string[] = [];

let merchantPage: Page;
let staffAPage: Page;
let staffBPage: Page;

function must(label: string, error: { message: string } | null): void {
  if (error) throw new Error(`${label}失敗:${error.message}`);
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  try {
    mkdirSync(SHOTS, { recursive: true });
    fixture = await setupLiveSyncFixture();
    const svc = serviceClient();
    dow = new Date(buildTaipeiIso(fixture.dateKey, "12:00")).getUTCDay();

    // 營業 09:00–18:00(每天)。用管理員身分改(= 營業時間設定頁同一條 RLS 路徑)。
    must(
      "改營業時間",
      (
        await fixture.m1.admin.from("merchant_business_hours").upsert(
          Array.from({ length: 7 }, (_, d) => ({
            merchant_id: fixture.m1.merchantId,
            day_of_week: d,
            is_closed: false,
            open_time: "09:00",
            close_time: "18:00",
          })),
          { onConflict: "merchant_id,day_of_week" },
        )
      ).error,
    );
    must(
      "改服務人員 A",
      (
        await svc
          .from("merchant_staff")
          .update({
            unlimited_backend_edit: false,
            no_time_slot_limit: false,
            can_create_edit_orders: true,
            show_member_info: true,
            compensation_type: "piece_rate",
          })
          .eq("id", fixture.staffA.staffId)
      ).error,
    );
    must(
      "改服務人員 B(唯讀、月薪制、沒有自己排休)",
      (
        await svc
          .from("merchant_staff")
          .update({
            unlimited_backend_edit: false,
            no_time_slot_limit: false,
            can_create_edit_orders: false,
            compensation_type: "monthly_salary",
          })
          .eq("id", fixture.staffB.staffId)
      ).error,
    );
    must(
      "清 A / B 既有時段",
      (
        await svc
          .from("staff_availability_windows")
          .delete()
          .in("staff_id", [fixture.staffA.staffId, fixture.staffB.staffId])
      ).error,
    );
    const w = await svc
      .from("staff_availability_windows")
      .insert(
        [fixture.staffA, fixture.staffB].map((s) => ({
          staff_id: s.staffId,
          day_of_week: dow,
          start_time: "09:00",
          end_time: "15:00",
        })),
      )
      .select("id, staff_id");
    must("布置每週時段", w.error);
    windowAId = (w.data as { id: string; staff_id: string }[]).find(
      (r) => r.staff_id === fixture.staffA.staffId,
    )!.id;
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  for (const c of contexts) await c.close();
  for (const r of recorders) expectOnlyLocalRequests(r);
  expect(pageErrors, "頁面沒有任何未處理的錯誤").toEqual([]);
  expect(sameKeyWarnings, "console 沒有 same key 警告").toEqual([]);
  if (setupFailed || !fixture) return;
  const actions = await teardownLiveSyncFixture(fixture);
  console.log("[b24 本機] 清理結果:\n" + actions.map((x) => `  - ${x}`).join("\n"));
});

async function newPage(browser: Browser, width = 1280): Promise<Page> {
  const mobile = width < 768;
  const context = await browser.newContext({
    viewport: { width, height: 900 },
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
  p.on("console", (msg) => {
    if (/same key/i.test(msg.text())) sameKeyWarnings.push(msg.text());
  });
  await p.route("**/functions/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  return p;
}

async function openMerchantCalendar(p: Page): Promise<void> {
  const s = await fixture.m1.admin.auth.getSession();
  if (!s.data.session) throw new Error("讀不到管理員的 session");
  await injectSession(p, s.data.session);
  await p.addInitScript(([k, v]) => window.localStorage.setItem(k, v), [
    getCurrentMerchantStorageKey(fixture.m1.adminUserId),
    fixture.m1.merchantId,
  ] as [string, string]);
  await p.goto(`/app/calendar?date=${fixture.dateKey}`);
  await p
    .getByRole("radiogroup", { name: "檢視模式" })
    .getByRole("radio", { name: "週檢視" })
    .click({ timeout: LOAD_TIMEOUT });
  await expect(p.getByTestId(`staff-grid-${fixture.staffA.staffId}`)).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
}

async function openStaffTimeline(p: Page, staff: LiveSyncStaff): Promise<void> {
  await injectSession(p, staff.session);
  await primeStaffCurrentMerchant(p, LOAD_TIMEOUT);
  await p.goto("/app/calendar");
  await expect(p.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await p.getByRole("button", { name: "時間軸格線" }).click();
  await expect(p.getByTestId("my-timeline-grid")).toBeVisible({ timeout: LOAD_TIMEOUT });
}

/** 一欄所有背景格(00:00 起每 30 分一格)。 */
function cellsOf(p: Page, gridTestId: string) {
  return p.getByTestId(gridTestId).locator(":scope > [data-slot-state]");
}
function cellAt(p: Page, gridTestId: string, hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return cellsOf(p, gridTestId).nth((h * 60 + m) / 30);
}
async function bgOf(p: Page, gridTestId: string, hhmm: string): Promise<string> {
  return cellAt(p, gridTestId, hhmm).evaluate((el) => getComputedStyle(el).backgroundColor);
}

/** 規格驗收:00–09 / 18–24 深色、09–15 自訂色、15–18 白色。 */
async function expectAcceptanceColors(p: Page, gridTestId: string, who: string): Promise<void> {
  await expect(cellsOf(p, gridTestId), `${who}:48 格`).toHaveCount(48, { timeout: LOAD_TIMEOUT });
  await expect(cellAt(p, gridTestId, "09:00")).toHaveAttribute("data-slot-state", "available", {
    timeout: LOAD_TIMEOUT,
  });
  const pageBg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  for (const t of ["00:00", "04:30", "08:30", "18:00", "21:00", "23:30"]) {
    await expect(cellAt(p, gridTestId, t), `${who} ${t} 營業時間外`).toHaveAttribute(
      "data-slot-state",
      "outside-business-hours",
    );
    expect(await bgOf(p, gridTestId, t), `${who} ${t} 深色`).toBe(DARK);
  }
  for (const t of ["09:00", "12:00", "14:30"]) {
    await expect(cellAt(p, gridTestId, t)).toHaveAttribute("data-slot-state", "available");
    expect(await bgOf(p, gridTestId, t), `${who} ${t} 自訂色`).toBe(GREEN);
  }
  for (const t of ["15:00", "16:30", "17:30"]) {
    await expect(cellAt(p, gridTestId, t)).toHaveAttribute("data-slot-state", "unavailable");
    expect(await bgOf(p, gridTestId, t), `${who} ${t} 白色(= 頁面底色)`).toBe(pageBg);
  }
}

test("G1 商家端:48 格、營業時間外深色、時段內自訂色、時段外白色,打開時捲到 09:00", async ({
  browser,
}) => {
  merchantPage = await newPage(browser);
  await openMerchantCalendar(merchantPage);
  for (const s of [fixture.staffA, fixture.staffB]) {
    await expectAcceptanceColors(merchantPage, `staff-grid-${s.staffId}`, `商家端 ${s.name}`);
  }
  await expect
    .poll(() => merchantPage.getByTestId("calendar-day-grid").evaluate((el) => el.scrollTop), {
      message: "打開時捲到 09:00(9 × 2 格 × 30px)",
      timeout: LOAD_TIMEOUT,
    })
    .toBe(18 * SLOT_PX);
  // 營業時間外的格子不是按鈕(R4)
  expect(
    await cellAt(merchantPage, `staff-grid-${fixture.staffA.staffId}`, "08:30").evaluate(
      (el) => el.tagName,
    ),
  ).toBe("DIV");
  await merchantPage.screenshot({ path: `${SHOTS}/G1-merchant-1280.png` });
});

test("G2 服務人員 A(有開新增編輯訂單):同一套顏色,營業時間外不是按鈕,打開時捲到 09:00", async ({
  browser,
}) => {
  staffAPage = await newPage(browser, 390);
  await openStaffTimeline(staffAPage, fixture.staffA);
  await expect(staffAPage.getByTestId("my-timeline-grid")).toHaveAttribute(
    "data-interactive",
    "true",
    { timeout: LOAD_TIMEOUT },
  );
  await expectAcceptanceColors(staffAPage, "my-timeline-grid", "服務人員 A");
  expect(await cellAt(staffAPage, "my-timeline-grid", "08:30").evaluate((el) => el.tagName)).toBe(
    "DIV",
  );
  expect(await cellAt(staffAPage, "my-timeline-grid", "09:00").evaluate((el) => el.tagName)).toBe(
    "BUTTON",
  );
  // 深色格子的時間文字是淺色(看得清楚)
  const ink = await cellAt(staffAPage, "my-timeline-grid", "08:30")
    .locator("span")
    .evaluate((el) => getComputedStyle(el).color);
  expect(ink).toBe("rgb(248, 250, 252)");
  await expect
    .poll(() => staffAPage.getByTestId("my-timeline-scroll").evaluate((el) => el.scrollTop), {
      message: "打開時捲到 09:00",
      timeout: LOAD_TIMEOUT,
    })
    .toBe(18 * SLOT_PX);
  await staffAPage.screenshot({ path: `${SHOTS}/G2-staffA-390.png` });
});

test("G3 服務人員 B(唯讀、讀表沒權限):一樣讀得到自己的時段,顏色跟商家端一致", async ({
  browser,
}) => {
  staffBPage = await newPage(browser, 390);
  await openStaffTimeline(staffBPage, fixture.staffB);
  expect(
    await staffBPage.getByTestId("my-timeline-grid").getAttribute("data-interactive"),
  ).toBeNull();
  await expectAcceptanceColors(staffBPage, "my-timeline-grid", "服務人員 B");
  await expect(staffBPage.getByTestId("my-timeline-grid").getByRole("button")).toHaveCount(0);
  await expect
    .poll(() => staffBPage.getByTestId("my-timeline-scroll").evaluate((el) => el.scrollTop), {
      timeout: LOAD_TIMEOUT,
    })
    .toBe(18 * SLOT_PX);
  await staffBPage.screenshot({ path: `${SHOTS}/G3-staffB-readonly-390.png` });
});

test("G4 R2 / R7:自己捲走之後,管理員改時段 ⇒ 5 秒內格子跟著變,畫面不被拉回 09:00", async () => {
  for (const p of [staffAPage, staffBPage]) {
    await p.getByTestId("my-timeline-scroll").evaluate((el) => {
      el.scrollTop = 0;
    });
  }
  await merchantPage.getByTestId("calendar-day-grid").evaluate((el) => {
    el.scrollTop = 0;
  });

  // 管理員把 A 的時段改成 09:00–16:00(= 商家端編輯服務人員時段同一條 RLS 路徑)
  const upd = await fixture.m1.admin
    .from("staff_availability_windows")
    .update({ end_time: "16:00" })
    .eq("id", windowAId)
    .select("id");
  expect(upd.error).toBeNull();
  expect(upd.data?.length).toBe(1);

  await expect(
    cellAt(staffAPage, "my-timeline-grid", "15:00"),
    "A 的 15:00 那格 5 秒內變可預約",
  ).toHaveAttribute("data-slot-state", "available", { timeout: REALTIME_TIMEOUT });
  expect(await staffAPage.getByTestId("my-timeline-scroll").evaluate((el) => el.scrollTop)).toBe(0);

  // B 的時段也改(唯讀畫法也要即時跟著變)
  const updB = await fixture.m1.admin
    .from("staff_availability_windows")
    .update({ end_time: "12:00" })
    .eq("staff_id", fixture.staffB.staffId)
    .select("id");
  expect(updB.error).toBeNull();
  await expect(
    cellAt(staffBPage, "my-timeline-grid", "12:00"),
    "B(唯讀)的 12:00 那格 5 秒內變白色",
  ).toHaveAttribute("data-slot-state", "unavailable", { timeout: REALTIME_TIMEOUT });
  expect(await staffBPage.getByTestId("my-timeline-scroll").evaluate((el) => el.scrollTop)).toBe(0);

  // 商家端(即時同步重抓)也不拉回去
  await expect(
    cellAt(merchantPage, `staff-grid-${fixture.staffA.staffId}`, "15:00"),
  ).toHaveAttribute("data-slot-state", "available", { timeout: LOAD_TIMEOUT });
  expect(await merchantPage.getByTestId("calendar-day-grid").evaluate((el) => el.scrollTop)).toBe(
    0,
  );
});

test("G5 透明度:設定頁把「營業時間外」調到 50% 儲存 ⇒ 商家端與服務人員端的深色格子都變淡", async () => {
  await merchantPage.goto("/app/settings");
  const slider = merchantPage.getByRole("slider", { name: "「營業時間外」的透明度" });
  await expect(slider).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(slider).toHaveValue("100");
  await slider.fill("50");
  await expect(slider).toHaveValue("50");
  // 預覽即時跟著變、旁邊顯示百分比
  await expect(merchantPage.getByTestId("calendar-state-preview-outside_business_hours")).toHaveCSS(
    "background-color",
    DARK_50,
  );
  await expect(slider.locator("xpath=following-sibling::span[1]")).toHaveText("50%");
  await slider.scrollIntoViewIfNeeded();
  await merchantPage.screenshot({ path: `${SHOTS}/G5-settings-1280.png` });
  // 「行事曆排程狀態顏色設定」那張卡片裡的儲存
  const card = slider.locator(
    "xpath=ancestor::div[.//*[normalize-space(text())='行事曆排程狀態顏色設定']][1]",
  );
  await card.getByRole("button", { name: "儲存", exact: true }).click();
  await expect(merchantPage.getByText("已更新行事曆排程狀態顏色設定")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 資料庫實際寫入(service_role 唯讀核對)
  const row = await serviceClient()
    .from("merchant_calendar_state_styles")
    .select("color, opacity")
    .eq("merchant_id", fixture.m1.merchantId)
    .eq("state_type", "outside_business_hours")
    .single();
  expect(row.error).toBeNull();
  expect(row.data).toEqual({ color: "#334155", opacity: 50 });

  await openMerchantCalendar(merchantPage);
  const gridA = `staff-grid-${fixture.staffA.staffId}`;
  await expect(cellAt(merchantPage, gridA, "08:30")).toHaveCSS("background-color", DARK_50, {
    timeout: LOAD_TIMEOUT,
  });
  // 其他狀態不受影響
  expect(await bgOf(merchantPage, gridA, "09:00")).toBe(GREEN);

  for (const [p, staff] of [
    [staffAPage, fixture.staffA],
    [staffBPage, fixture.staffB],
  ] as const) {
    await p.reload();
    await expect(p.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({ timeout: LOAD_TIMEOUT });
    await p.getByRole("button", { name: "時間軸格線" }).click();
    await expect(cellAt(p, "my-timeline-grid", "08:30"), `${staff.name} 深色變 50%`).toHaveCSS(
      "background-color",
      DARK_50,
      { timeout: LOAD_TIMEOUT },
    );
    await p.screenshot({
      path: `${SHOTS}/G5-${staff === fixture.staffA ? "A" : "B"}-50pct-390.png`,
    });
  }
});

test("G6 QA M1:服務人員 B(唯讀)開了商家後台編輯無時段限制 ⇒ 營業時間內全部自訂色,跟商家端一致", async () => {
  must(
    "開 B 的商家後台編輯無時段限制",
    (
      await serviceClient()
        .from("merchant_staff")
        .update({ unlimited_backend_edit: true })
        .eq("id", fixture.staffB.staffId)
    ).error,
  );
  const gridB = `staff-grid-${fixture.staffB.staffId}`;
  // 即時同步(my-staff-record / 商家行事曆頻道)5 秒內兩端都跟著變
  for (const t of ["12:00", "15:00", "17:30"]) {
    await expect(cellAt(staffBPage, "my-timeline-grid", t), `B ${t} 變可預約`).toHaveAttribute(
      "data-slot-state",
      "available",
      { timeout: REALTIME_TIMEOUT },
    );
    await expect(cellAt(merchantPage, gridB, t), `商家端 B ${t} 可預約`).toHaveAttribute(
      "data-slot-state",
      "available",
      { timeout: REALTIME_TIMEOUT },
    );
    expect(await bgOf(staffBPage, "my-timeline-grid", t)).toBe(GREEN);
    expect(await bgOf(merchantPage, gridB, t)).toBe(GREEN);
  }
  await expect(cellAt(staffBPage, "my-timeline-grid", "18:00")).toHaveAttribute(
    "data-slot-state",
    "outside-business-hours",
  );
  expect(
    await staffBPage.getByTestId("my-timeline-grid").getAttribute("data-interactive"),
  ).toBeNull();
  await expect(staffBPage.getByTestId("my-timeline-grid").getByRole("button")).toHaveCount(0);
});

test("G7 QA L1:同一天格線容器重掛(服務人員 卡片列表→時間軸)⇒ 再捲到 09:00;商家 週→月→週 容器沒重掛 ⇒ 不拉回", async () => {
  // 商家端:週 / 月切換只換上方日期列,下方時間軸格線是同一個元素(實測,用標記確認沒有重掛)
  // ⇒ 屬於「使用者自己捲走之後的資料更新」,維持不拉回(R2)。真的重掛的情況由 vitest 鎖住。
  const merchantGrid = merchantPage.getByTestId("calendar-day-grid");
  await merchantGrid.evaluate((el) => {
    el.scrollTop = 0;
    (el as unknown as Record<string, unknown>)["__b24Mark"] = true;
  });
  const modes = merchantPage.getByRole("radiogroup", { name: "檢視模式" });
  await modes.getByRole("radio", { name: "月檢視" }).click();
  await modes.getByRole("radio", { name: "週檢視" }).click();
  await expect(cellAt(merchantPage, `staff-grid-${fixture.staffA.staffId}`, "09:00")).toBeVisible();
  const sameNode = await merchantPage
    .getByTestId("calendar-day-grid")
    .evaluate((el) => (el as unknown as Record<string, unknown>)["__b24Mark"] === true);
  const top = await merchantPage.getByTestId("calendar-day-grid").evaluate((el) => el.scrollTop);
  console.log(`[G7] 商家端週→月→週:同一個格線元素=${sameNode}、scrollTop=${top}`);
  if (sameNode) {
    expect(top, "同一個容器 ⇒ 不拉回").toBe(0);
  } else {
    expect(top, "換了新容器 ⇒ 再捲到 09:00").toBe(18 * SLOT_PX);
  }

  await staffAPage.getByTestId("my-timeline-scroll").evaluate((el) => {
    el.scrollTop = 0;
  });
  await staffAPage.getByRole("button", { name: "卡片列表" }).click();
  await expect(staffAPage.getByTestId("my-timeline-scroll")).toHaveCount(0);
  await staffAPage.getByRole("button", { name: "時間軸格線" }).click();
  await expect
    .poll(() => staffAPage.getByTestId("my-timeline-scroll").evaluate((el) => el.scrollTop), {
      message: "服務人員端切回時間軸 ⇒ 再捲到 09:00",
      timeout: LOAD_TIMEOUT,
    })
    .toBe(18 * SLOT_PX);
});
