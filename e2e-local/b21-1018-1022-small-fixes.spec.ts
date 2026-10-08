// 第 21 批(#1018 ~ #1022)測試回饋小修 + 行事曆格子。本機 Supabase 專用(e2e-local 設定,loopback guard 生效,
// 不碰正式庫)。規格書:.project/specs/測試回饋小修與行事曆格子-第21批.md
//
//   R1 #1018 店家報表:有抽成紀錄時「總抽成支出」下方小字出現;服務人員明細說明拿掉「…對得起來。」(1280 / 375)
//   R2 #1019 鈴鐺:已完成訂單被取消 / 還原的原因完整換行顯示,不截成「…」;一般通知照舊一行(1280 / 375)
//   R3 #1020 三種視窗:全頁層(預約詳情)有空白條、滑過不反白、游標手指、點了關;確認窗疊在上面時
//      確認窗沒有空白條、點下層空白條位置不會穿透;小卡窗(新增付款方式)沒有空白條、點上方不關、✕ / Esc 關、
//      填過資料 Esc 先問放棄(1280 / 375)
//   R4 #1021 + #1022 商家端時間軸:服務人員 A(每週 09:00–12:00)時段內空格淡綠、時段外灰;
//      服務人員 B(後台無時段限制 ⇒ 整段營業時間)淡綠;可以點的格子 / 週曆日期格是手指(1280 / 375)
//   R5 #1021 設定頁改色(第 4 種「服務人員可預約時段」)⇒ 行事曆即時換色;舊值預設 #dcfce7
//   R6 #1021 + #1022 服務人員端時間軸:A(可新增編輯訂單)時段內空格同色、手指;B(唯讀)格子不能點 ⇒ 一般箭頭
//
// fixture 沿用 e2e-local/support/staff-live-sync-fixture.ts,teardown 一樣三段核對。
// 截圖存 B21_SHOTS(預設 test-results/b21-shots/;🔴 不寫進 .project/notes/ui-ref-2026-10-01/after/)。
// 執行:E2E_LOCAL_PORT=5304 npx playwright test --config playwright.local.config.ts b21-1018-1022-small-fixes
//
// 用語:一律「服務人員」。
import { mkdirSync } from "node:fs";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { Session } from "@supabase/supabase-js";

import { primeStaffCurrentMerchant } from "../e2e/support/app-shell";
import { buildTaipeiIso } from "../src/modules/booking/dateUtils";
import { getCurrentMerchantStorageKey } from "../src/modules/merchant/constants";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";
import {
  adminCreateBooking,
  adminRpc,
  injectSession,
  serviceClient,
  setupLiveSyncFixture,
  teardownLiveSyncFixture,
  type CreatedBooking,
  type LiveSyncFixture,
} from "./support/staff-live-sync-fixture";

const LOAD_TIMEOUT = 20_000;
const SHOTS = process.env["B21_SHOTS"] ?? "test-results/b21-shots";
const STRIP = "[data-overlay-dismiss-strip]";
const DISCARD_TITLE = "確定放棄這次輸入？";
const GREEN = "rgb(220, 252, 231)"; // #dcfce7
const NEW_COLOR_HEX = "#fde68a";
const NEW_COLOR = "rgb(253, 230, 138)";
const LONG_REASON =
  "客人臨時說家裡有事要改到下個月，而且這次要多加一台冷氣一起保養，所以這張先取消，之後再重新建一張新的訂單";
const TRANSPARENT = "rgba(0, 0, 0, 0)";

test.use({ timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "serial", timeout: 240_000 });

let fixture: LiveSyncFixture;
let setupFailed = false;
let adminSession: Session;
let detailBooking: CreatedBooking;
let completedBookingId = "";
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

    // 服務人員 A:關掉「後台無時段限制」、只開今天 09:00–12:00;開「新增編輯訂單」+ 排班自助(服務人員端可點格子)。
    // 台北中午 12:00 = UTC 04:00,同一天 ⇒ getUTCDay() 就是台北的星期幾。
    const taipeiDow = new Date(buildTaipeiIso(fixture.dateKey, "12:00")).getUTCDay();
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
    must(
      "服務人員 A 每週時段",
      (
        await svc.from("staff_availability_windows").insert({
          staff_id: fixture.staffA.staffId,
          day_of_week: taipeiDow,
          start_time: "09:00",
          end_time: "12:00",
        })
      ).error,
    );

    // #1018:一張已完成的單 ⇒ 有抽成紀錄。
    const done = await adminCreateBooking(fixture, fixture.m1, {
      staffId: fixture.staffA.staffId,
      time: "10:00",
      customerName: "E2E第21批完成客",
    });
    completedBookingId = done.id;
    await adminRpc(fixture.m1, "confirm_booking", { p_booking_id: done.id });
    await adminRpc(fixture.m1, "complete_booking", { p_booking_id: done.id });

    // #1020:預約詳情 / 取消確認窗用的單(服務人員 B 15:00)。
    detailBooking = await adminCreateBooking(fixture, fixture.m1, {
      staffId: fixture.staffB.staffId,
      time: "15:00",
      customerName: "E2E第21批詳情客",
    });

    // #1019:鈴鐺兩則長原因 + 一則一般通知(直接寫通知列;內文格式同資料庫 reverse_booking_completion)。
    const adminRow = await svc
      .from("merchant_admins")
      .select("id")
      .eq("merchant_id", fixture.m1.merchantId)
      .eq("user_id", fixture.m1.adminUserId)
      .single();
    must("查管理員列", adminRow.error);
    const targetId = (adminRow.data as { id: string }).id;
    const base = {
      user_id: fixture.m1.adminUserId,
      merchant_id: fixture.m1.merchantId,
      target_type: "admin",
      target_id: targetId,
      booking_id: done.id,
    };
    const bell = await svc.from("user_notifications").insert([
      {
        ...base,
        event_type: "booking_completed_cancelled",
        title: "已完成訂單被取消",
        body: `管理員乙 將 2026/10/08 10:00「E2E第21批完成客」的已完成訂單取消。原因：${LONG_REASON}`,
        created_at: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        ...base,
        event_type: "booking_completed_reverted",
        title: "已完成訂單被還原",
        body: `管理員乙 將 2026/10/08 10:00「E2E第21批完成客」的已完成訂單還原為已確認。原因：${LONG_REASON}`,
        created_at: new Date(Date.now() - 120_000).toISOString(),
      },
      {
        ...base,
        event_type: "booking_created",
        title: "新預約",
        body: `一般通知的內文很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長`,
        created_at: new Date(Date.now() - 180_000).toISOString(),
      },
    ]);
    must("寫鈴鐺通知", bell.error);
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
  console.log(`[b21 teardown] ${actions.join(";")}`);
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

/** 某一欄某個時間那一格(用 top 換算:第 0 格 = 營業時間開始 08:00,每格 30 分鐘)。 */
async function slotAt(p: Page, gridTestId: string, time: string) {
  const grid = p.getByTestId(gridTestId);
  const [h, m] = time.split(":").map(Number) as [number, number];
  const index = (h * 60 + m - 8 * 60) / 30;
  const handle = await grid.evaluateHandle((el, i) => {
    const cells = [...el.querySelectorAll<HTMLElement>("[data-slot-state]")];
    const sorted = cells.sort(
      (a, b) => Number.parseFloat(a.style.top) - Number.parseFloat(b.style.top),
    );
    return sorted[i] ?? null;
  }, index);
  const el = handle.asElement();
  if (!el) throw new Error(`${gridTestId} 找不到 ${time} 那一格`);
  return el;
}

async function look(el: Awaited<ReturnType<typeof slotAt>>) {
  return el.evaluate((node) => {
    const cs = getComputedStyle(node);
    return {
      state: node.getAttribute("data-slot-state"),
      bg: cs.backgroundColor,
      cursor: cs.cursor,
      tag: node.tagName,
    };
  });
}

test("R1 #1018 店家報表:總抽成支出小字、服務人員明細說明拿掉開發者口吻", async ({ browser }) => {
  const recs = await serviceClient()
    .from("booking_commission_records")
    .select("id")
    .eq("booking_id", completedBookingId);
  expect(recs.error).toBeNull();
  const hasCommission = (recs.data ?? []).length > 0;
  console.log(`[R1] 完成單的抽成紀錄筆數:${(recs.data ?? []).length}`);
  for (const width of [1280, 375]) {
    const p = await newPage(browser, width);
    await asAdmin(p, "/app/billing-report");
    await expect(p.getByText("服務人員明細")).toBeVisible({ timeout: LOAD_TIMEOUT });
    const desc = p.getByText(/查詢期間內在職的服務人員，依姓名排序。/);
    await expect(desc).toHaveText(/期間內在職、現在已離職的人也會列出來\(標示「已離職」\)。$/);
    await expect(p.getByText(/對得起來/)).toHaveCount(0);
    // 第 21 批 QA:JSX 跨行造成的「中文 空白 中文」不能再出現
    await expect(p.getByText(/只是概估，不含房租/)).toBeVisible();
    await expect(p.getByText(/只是 概估|標示 「已離職」/)).toHaveCount(0);
    if (hasCommission) {
      await expect(p.getByTestId("summary-card-note")).toBeVisible();
      console.log(`[R1 ${width}] 小字:${await p.getByTestId("summary-card-note").textContent()}`);
    }
    await p.screenshot({ path: `${SHOTS}/R1-billing-report-${width}.png`, fullPage: true });
    await p.context().close();
  }
  expect(hasCommission, "有完成單 ⇒ 應該有抽成紀錄(小字才會出現)").toBe(true);
});

test("R2 #1019 鈴鐺:已完成訂單被取消 / 還原的原因完整換行顯示", async ({ browser }) => {
  for (const width of [1280, 375]) {
    const p = await newPage(browser, width);
    await asAdmin(p, "/app/manage");
    await expect(p.getByTestId("manage-page")).toBeVisible({ timeout: LOAD_TIMEOUT });
    await p.getByTestId("notification-bell").click();
    const rows = p.getByTestId("notification-row");
    await expect(rows).toHaveCount(3, { timeout: LOAD_TIMEOUT });
    const bodies = p.getByTestId("notification-body");
    for (const i of [0, 1]) {
      const b = bodies.nth(i);
      await expect(b).toContainText(LONG_REASON);
      const m = await b.evaluate((el) => ({
        h: el.getBoundingClientRect().height,
        lineH: Number.parseFloat(getComputedStyle(el).lineHeight) || 16,
        clipped: el.scrollWidth > el.clientWidth + 1,
        overflow: getComputedStyle(el).textOverflow,
      }));
      console.log(`[R2 ${width}] 第 ${i + 1} 則:高 ${m.h}px、行高 ${m.lineH}px`);
      expect(m.h, "換行成多行").toBeGreaterThan(m.lineH * 1.5);
      expect(m.clipped).toBe(false);
      expect(m.overflow).not.toBe("ellipsis");
    }
    const normal = await bodies.nth(2).evaluate((el) => ({
      overflow: getComputedStyle(el).textOverflow,
      clipped: el.scrollWidth > el.clientWidth + 1,
    }));
    expect(normal.overflow, "一般通知照舊一行截斷").toBe("ellipsis");
    expect(normal.clipped).toBe(true);
    await p.waitForTimeout(500); // 手機版是底部抽屜,等滑入動畫結束再截圖
    await p.screenshot({ path: `${SHOTS}/R2-bell-${width}.png` });
    await p.context().close();
  }
});

async function openDetail(p: Page) {
  await asAdmin(p, "/app/orders");
  await expect(p.getByRole("heading", { name: "訂單管理" })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await p
    .getByRole("button", { name: new RegExp(detailBooking.customerName) })
    .click({ timeout: LOAD_TIMEOUT });
  const layer = p.getByRole("dialog");
  await expect(layer.getByText("預約詳情")).toBeVisible({ timeout: LOAD_TIMEOUT });
  return layer;
}

async function settle(p: Page) {
  await p.waitForTimeout(450);
}

test("R3 #1020 全頁層 / 確認窗 / 小卡窗:空白條只剩全頁層、滑過不反白", async ({ browser }) => {
  const p = await newPage(browser, 1280, 800);
  // ① 全頁層(預約詳情)
  let layer = await openDetail(p);
  await settle(p);
  const strip = p.locator(STRIP);
  await expect(strip).toHaveCount(1);
  expect(await strip.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
  await strip.hover();
  await settle(p);
  expect(await strip.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(TRANSPARENT);
  await p.screenshot({ path: `${SHOTS}/R3-full-layer-hover-1280.png` });

  // ② 疊上確認窗:確認窗沒有空白條;點確認窗上方 / 下層空白條位置都不關;Esc 只關確認窗
  await layer.getByRole("button", { name: "取消預約" }).click();
  const alert = p.getByRole("alertdialog").filter({ hasText: "確定要取消這筆預約嗎？" });
  await expect(alert).toBeVisible();
  await settle(p);
  await expect(strip).toHaveCount(1);
  const ab = (await alert.boundingBox())!;
  await p.screenshot({ path: `${SHOTS}/R3-confirm-over-layer-1280.png` });
  await p.mouse.click(ab.x + ab.width / 2, ab.y - 24);
  await p.mouse.click(640, 28);
  await expect(alert).toBeVisible();
  // 確認窗開著時下層被 Radix 設 aria-hidden ⇒ 用 CSS 選擇器找下層(getByRole 會找不到)。
  const layerRaw = p.locator('[role="dialog"]').filter({ hasText: "預約詳情" });
  await expect(layerRaw).toBeVisible();
  await p.keyboard.press("Escape");
  await expect(alert).toHaveCount(0);
  await expect(layer).toBeVisible();
  // 「取消」鈕(確認窗的返回)照舊
  await layer.getByRole("button", { name: "取消預約" }).click();
  await expect(alert).toBeVisible();
  await alert.getByRole("button").first().click();
  await expect(alert).toHaveCount(0);
  const st = await serviceClient()
    .from("bookings")
    .select("status")
    .eq("id", detailBooking.id)
    .single();
  expect((st.data as { status: string }).status).not.toBe("cancelled");
  // 全頁層空白條照樣 = 關
  await p.mouse.click(640, 28);
  await expect(layer).toHaveCount(0);

  // ③ 小卡窗(新增付款方式)
  await p.goto("/app/payment-methods");
  const openCard = async () => {
    await p.getByRole("button", { name: "新增付款方式" }).first().click({ timeout: LOAD_TIMEOUT });
    const d = p
      .getByRole("dialog")
      .filter({ has: p.getByRole("heading", { name: "新增付款方式" }) });
    await expect(d).toBeVisible({ timeout: LOAD_TIMEOUT });
    await settle(p);
    return d;
  };
  let card = await openCard();
  await expect(p.locator(STRIP)).toHaveCount(0);
  const cb = (await card.boundingBox())!;
  console.log(`[R3] 小卡窗 1280:上緣 ${cb.y.toFixed(1)}px、高 ${cb.height.toFixed(1)}px`);
  await p.screenshot({ path: `${SHOTS}/R3-card-dialog-1280.png` });
  await p.mouse.click(cb.x + cb.width / 2, cb.y - 24);
  await p.mouse.click(20, 400);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "關閉" }).click();
  await expect(card).toHaveCount(0);
  card = await openCard();
  await p.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  card = await openCard();
  await card.locator("#payment-method-name").fill("E2E第21批轉帳");
  await p.keyboard.press("Escape");
  await expect(p.getByText(DISCARD_TITLE)).toBeVisible();
  await expect(p.locator(STRIP)).toHaveCount(0);
  await p.getByTestId("discard-changes-confirm").getByRole("button", { name: "繼續編輯" }).click();
  await expect(card.locator("#payment-method-name")).toHaveValue("E2E第21批轉帳");
  await card.getByRole("button", { name: "取消" }).click();
  await expect(card).toHaveCount(0);
  await p.context().close();

  // ④ 手機 375:截圖三種窗
  const m = await newPage(browser, 375, 812);
  layer = await openDetail(m);
  await settle(m);
  await expect(m.locator(STRIP)).toHaveCount(0);
  await m.screenshot({ path: `${SHOTS}/R3-full-layer-375.png` });
  await layer.getByRole("button", { name: "取消預約" }).click();
  await expect(m.getByRole("alertdialog")).toBeVisible();
  await settle(m);
  await m.screenshot({ path: `${SHOTS}/R3-confirm-375.png` });
  await m.keyboard.press("Escape");
  await m.goto("/app/payment-methods");
  await m.getByRole("button", { name: "新增付款方式" }).first().click({ timeout: LOAD_TIMEOUT });
  await settle(m);
  await expect(m.locator(STRIP)).toHaveCount(0);
  await m.screenshot({ path: `${SHOTS}/R3-card-dialog-375.png` });
  await m.context().close();
});

test("R4 #1021 + #1022 商家端時間軸:每週可預約時段淡綠、可點的格子是手指", async ({ browser }) => {
  const A = `staff-grid-${fixture.staffA.staffId}`;
  const B = `staff-grid-${fixture.staffB.staffId}`;
  for (const width of [1280, 375]) {
    const p = await newPage(browser, width);
    await openMerchantCalendar(p);
    const a0900 = await look(await slotAt(p, A, "09:00"));
    const a1130 = await look(await slotAt(p, A, "11:30"));
    const a1300 = await look(await slotAt(p, A, "13:00"));
    const b1600 = await look(await slotAt(p, B, "16:00"));
    console.log(`[R4 ${width}]`, JSON.stringify({ a0900, a1130, a1300, b1600 }));
    expect(a0900).toMatchObject({ state: "available", bg: GREEN, cursor: "pointer" });
    expect(a1130).toMatchObject({ state: "available", bg: GREEN, cursor: "pointer" });
    // 時段外灰格:外觀不變(不是淡綠);第 22 批 #1023 起時段外沒有「開啟時段」⇒ 點了沒反應 ⇒ 一般箭頭、不是按鈕。
    expect(a1300.state).toBe("unavailable");
    expect(a1300.bg).not.toBe(GREEN);
    expect(a1300.cursor).not.toBe("pointer");
    expect(a1300.tag).toBe("DIV");
    // B 後台無時段限制 ⇒ 整段營業時間都是可預約 ⇒ 淡綠
    expect(b1600).toMatchObject({ state: "available", bg: GREEN });
    // 週曆日期格可點 ⇒ 手指
    const dayBtn = p.getByRole("button", { name: `切換到 ${fixture.dateKey}` });
    expect(await dayBtn.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
    // 滑過有回饋(變暗),不再是 hover:bg 被 inline 蓋掉的「沒反應」(只有電腦有 hover)
    if (width >= 768) {
      const cell = await slotAt(p, A, "09:30");
      await cell.scrollIntoViewIfNeeded();
      await cell.hover();
      await p.waitForTimeout(200);
      expect(await cell.evaluate((el) => getComputedStyle(el).filter)).toContain("brightness");
      await p.mouse.move(1, 1);
    }
    await (await slotAt(p, A, "09:00")).scrollIntoViewIfNeeded();
    await p.screenshot({ path: `${SHOTS}/R4-merchant-timeline-${width}.png` });
    await p.context().close();
  }
});

test("R5 #1021 設定頁:第 4 種預設 #dcfce7、改色後行事曆換色", async ({ browser }) => {
  const before = await serviceClient()
    .from("merchant_calendar_state_styles")
    .select("color")
    .eq("merchant_id", fixture.m1.merchantId)
    .eq("state_type", "staff_available_slot")
    .single();
  expect((before.data as { color: string }).color).toBe("#dcfce7");
  const p = await newPage(browser, 1280);
  await asAdmin(p, "/app/settings");
  const input = p.getByLabel("「服務人員可預約時段」的色碼");
  await expect(input).toHaveValue("#dcfce7", { timeout: LOAD_TIMEOUT });
  const cardEl = p
    .getByText("行事曆排程狀態顏色設定", { exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space()='儲存']][1]");
  await cardEl.scrollIntoViewIfNeeded();
  await p.screenshot({ path: `${SHOTS}/R5-settings-before-1280.png` });
  // 亂打 ⇒ 資料庫擋下,顯示錯誤
  await input.fill("red;x");
  await cardEl.getByRole("button", { name: "儲存" }).click();
  await expect(p.getByText("更新失敗")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await input.fill(NEW_COLOR_HEX);
  await cardEl.getByRole("button", { name: "儲存" }).click();
  await expect(p.getByText("已更新行事曆排程狀態顏色設定")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await p.screenshot({ path: `${SHOTS}/R5-settings-after-1280.png` });
  const after = await serviceClient()
    .from("merchant_calendar_state_styles")
    .select("color")
    .eq("merchant_id", fixture.m1.merchantId)
    .eq("state_type", "staff_available_slot")
    .single();
  expect((after.data as { color: string }).color).toBe(NEW_COLOR_HEX);
  // 同一個分頁切到行事曆(react-query 已失效重抓)⇒ 新顏色
  await p.goto(`/app/calendar?date=${fixture.dateKey}`);
  await p
    .getByRole("radiogroup", { name: "檢視模式" })
    .getByRole("radio", { name: "週檢視" })
    .click({ timeout: LOAD_TIMEOUT });
  await expect(p.getByTestId(`staff-grid-${fixture.staffA.staffId}`)).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  const a0900 = await look(await slotAt(p, `staff-grid-${fixture.staffA.staffId}`, "09:00"));
  expect(a0900.bg).toBe(NEW_COLOR);
  await p.screenshot({ path: `${SHOTS}/R5-merchant-timeline-new-color-1280.png` });
  await p.context().close();
});

async function openStaffTimeline(p: Page, session: Session) {
  await injectSession(p, session);
  await primeStaffCurrentMerchant(p, LOAD_TIMEOUT);
  await p.goto("/app/calendar");
  await expect(p.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await p.getByRole("button", { name: "時間軸格線" }).click();
  await expect(p.getByTestId("my-timeline-grid")).toBeVisible({ timeout: LOAD_TIMEOUT });
}

test("R6 #1021 + #1022 服務人員端時間軸:可預約時段同色、可點才是手指", async ({ browser }) => {
  for (const width of [1280, 375]) {
    const p = await newPage(browser, width);
    await openStaffTimeline(p, fixture.staffA.session);
    await expect(p.getByTestId("my-timeline-grid")).toHaveAttribute("data-interactive", "true", {
      timeout: LOAD_TIMEOUT,
    });
    await expect
      .poll(async () => (await look(await slotAt(p, "my-timeline-grid", "09:00"))).bg, {
        timeout: LOAD_TIMEOUT,
      })
      .toBe(NEW_COLOR);
    const s0900 = await look(await slotAt(p, "my-timeline-grid", "09:00"));
    const s1300 = await look(await slotAt(p, "my-timeline-grid", "13:00"));
    console.log(`[R6 A ${width}]`, JSON.stringify({ s0900, s1300 }));
    expect(s0900).toMatchObject({ state: "available", cursor: "pointer", tag: "BUTTON" });
    expect(s1300.state).toBe("unavailable");
    expect(s1300.bg).not.toBe(NEW_COLOR);
    // 第 22 批 #1023:時段外灰格不再有「開啟時段」(原本 A 有排班自助 ⇒ 手指)⇒ 點了沒反應 ⇒ 一般箭頭、不是按鈕
    expect(s1300.cursor).not.toBe("pointer");
    expect(s1300.tag).toBe("DIV");
    const day = p.locator(`[data-date-key="${fixture.dateKey}"]`);
    if ((await day.count()) > 0) {
      expect(await day.first().evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
    }
    await (await slotAt(p, "my-timeline-grid", "09:00")).scrollIntoViewIfNeeded();
    await p.screenshot({ path: `${SHOTS}/R6-staff-a-timeline-${width}.png` });
    await p.context().close();
  }

  // B:沒開「新增編輯訂單」⇒ 唯讀時間軸,格子點了沒反應 ⇒ 一般箭頭(不是手指)
  const p = await newPage(browser, 1280);
  await openStaffTimeline(p, fixture.staffB.session);
  await p.waitForTimeout(800);
  expect(await p.getByTestId("my-timeline-grid").getAttribute("data-interactive")).toBeNull();
  const cursors = await p.getByTestId("my-timeline-grid").evaluate((el) =>
    [...el.children]
      .filter((c) => (c as HTMLElement).style.top !== "" && c.tagName === "DIV")
      .slice(0, 6)
      .map((c) => getComputedStyle(c).cursor),
  );
  console.log(`[R6 B] 唯讀格子游標:${cursors.join(",")}`);
  expect(cursors.length).toBeGreaterThan(0);
  for (const c of cursors) expect(c).not.toBe("pointer");
  await p.screenshot({ path: `${SHOTS}/R6-staff-b-readonly-1280.png` });
  await p.context().close();
});

test("R7 設定頁:訂單狀態顏色 / 行事曆排程狀態顏色兩張卡的標題欄一樣寬(sm:w-32)", async ({
  browser,
}) => {
  for (const width of [1280, 375]) {
    const p = await newPage(browser, width);
    await asAdmin(p, "/app/settings");
    const statusLabel = p.getByLabel("「已取消」的代表色").locator("xpath=preceding-sibling::*[1]");
    const stateLabel = p
      .getByLabel("「服務人員可預約時段」的底色")
      .locator("xpath=preceding-sibling::*[1]");
    await expect(statusLabel).toBeVisible({ timeout: LOAD_TIMEOUT });
    const w1 = (await statusLabel.boundingBox())!.width;
    const w2 = (await stateLabel.boundingBox())!.width;
    console.log(
      `[R7 ${width}] 訂單狀態標題欄 ${w1.toFixed(1)}px、行事曆狀態標題欄 ${w2.toFixed(1)}px`,
    );
    if (width >= 640) {
      expect(Math.round(w1)).toBe(128);
      expect(Math.round(w2)).toBe(128);
    }
    // 第 21 批:4 列排法一致 —— 每列的色塊和色碼在同一行;手機上標題自己一行、色塊 / 色碼在下一行。
    for (const name of ["全天休假", "時段排休", "跨店佔用", "服務人員可預約時段"]) {
      const swatch = p.getByLabel(`「${name}」的底色`);
      const code = p.getByLabel(`「${name}」的色碼`);
      const title = swatch.locator("xpath=preceding-sibling::*[1]");
      await swatch.scrollIntoViewIfNeeded();
      const sb = (await swatch.boundingBox())!;
      const cb = (await code.boundingBox())!;
      const tb = (await title.boundingBox())!;
      const sameRow = Math.abs(sb.y + sb.height / 2 - (cb.y + cb.height / 2)) <= 2;
      const pb = (await p
        .getByLabel(`「${name}」的色碼`)
        .locator("xpath=following-sibling::*[1]")
        .boundingBox())!;
      const previewSameRow = Math.abs(pb.y + pb.height / 2 - (cb.y + cb.height / 2)) <= 2;
      expect(previewSameRow, `${name} 預覽和色碼同一行`).toBe(true);
      const titleAbove = tb.y + tb.height <= sb.y + 1;
      console.log(`[R7 ${width}] ${name}:色塊與色碼同一行=${sameRow}、標題在上一行=${titleAbove}`);
      expect(sameRow, `${name} 色塊和色碼同一行`).toBe(true);
      expect(titleAbove, `${name} 標題位置`).toBe(width < 640);
    }
    // 手機整頁截圖會把固定頂欄拼進中間 ⇒ 改成兩張卡各捲到頂端截一張視窗畫面。
    for (const [title, tag] of [
      ["訂單狀態顏色設定", "booking-status"],
      ["行事曆排程狀態顏色設定", "calendar-state"],
    ] as const) {
      await p
        .getByText(title, { exact: true })
        .evaluate((el) => el.scrollIntoView({ block: "start" }));
      await p.evaluate(() => window.scrollBy(0, -72));
      await p.waitForTimeout(200);
      await p.screenshot({ path: `${SHOTS}/R7-settings-${tag}-${width}.png` });
    }
    await p.context().close();
  }
});
