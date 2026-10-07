// 「建單畫面與下拉刷新 第 2 批」本機 e2e(#979 選擇項目整頁 + 付款方式下拉、#980 時間只列能約的、#982 手機下拉刷新)。
// 規格書:.project/specs/建單畫面與下拉刷新-第2批.md 第四節第 3 點。fixture 見 support/booking-form-batch2-fixture.ts。
// **只在本機跑**:`npx playwright test --config playwright.local.config.ts booking-form-batch2`
// (Playwright 自己開獨立的 headless Chromium,不碰使用者的瀏覽器;只連本機 Docker 的 Supabase)。
//
// 守門(每一條):afterEach 斷言瀏覽器打到 supabase.co 的請求 = 0,且確實有打到本機。
//
// 🔴 故障注入:改產品檔做(拿掉請假判斷、自訂金額不寫回、彈窗開著不停用下拉刷新),做完還原,紀錄在回報裡。
import {
  devices,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Locator,
  type Page,
} from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import {
  CATEGORY_DUCT,
  CATEGORY_WALL,
  createBookingAsAdmin,
  injectSession,
  ITEM_DUCT,
  ITEM_QUICK,
  ITEM_WALL,
  serviceClient,
  setupBookingFormBatch2Fixture,
  STAFF_A,
  STAFF_B,
  teardownBookingFormBatch2Fixture,
  type BookingFormBatch2Fixture,
} from "./support/booking-form-batch2-fixture";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";

const LOAD_TIMEOUT = 20_000;

test.use({ viewport: { width: 1280, height: 800 }, timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "default", timeout: 90_000 });

let fixture: BookingFormBatch2Fixture;
let setupFailed = false;
let recorders: RequestRecorder[] = [];

test.beforeAll(async () => {
  test.setTimeout(150_000);
  try {
    fixture = await setupBookingFormBatch2Fixture();
    console.log(
      `[booking-form-batch2 本機] fixture 建好(商家 ${fixture.merchantId.slice(0, 8)},D=${fixture.dateD})`,
    );
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(150_000);
  if (setupFailed || !fixture) return;
  const actions = await teardownBookingFormBatch2Fixture(fixture);
  console.log("[booking-form-batch2 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(() => {
  recorders = [];
});
test.afterEach(() => {
  expect(recorders.length, "前提:這條測試至少開過一個頁面").toBeGreaterThan(0);
  for (const r of recorders) expectOnlyLocalRequests(r);
});

async function login(page: Page): Promise<void> {
  recorders.push(recordRequestHosts(page));
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page);
}

/** 行事曆(指定日期)→「新增預約」→ 選服務人員。 */
async function openNewBooking(page: Page, dateKey: string, staffName: string): Promise<Locator> {
  await page.goto(`/app/calendar?date=${dateKey}`);
  await page.getByRole("button", { name: "新增預約" }).first().click();
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "新增預約" }) });
  await expect(dialog).toBeVisible({ timeout: LOAD_TIMEOUT });
  await dialog.locator("#booking-staff").click();
  await page.getByRole("option", { name: staffName }).click();
  return dialog;
}

async function pickItems(
  dialog: Locator,
  steps: (picker: Locator) => Promise<void>,
): Promise<void> {
  await dialog.locator("#booking-service-items").click();
  const picker = dialog.getByTestId("service-item-picker");
  await expect(picker).toBeVisible();
  await steps(picker);
  await picker.getByRole("button", { name: /^確認/ }).click();
  await expect(picker).toHaveCount(0);
}

async function openTimeOptions(dialog: Locator): Promise<Locator> {
  await dialog.locator("#booking-datetime").click();
  const panel = dialog.page().getByTestId("booking-time-options");
  await expect(panel).toBeVisible({ timeout: LOAD_TIMEOUT });
  return panel;
}

/** 時間按鈕是不是完整落在清單的可視範圍內(而且清單本身在螢幕內)。只讀版面,不操作。 */
async function isFullyVisibleInList(page: Page, time: string): Promise<boolean> {
  const list = page.getByTestId("booking-time-options-list");
  const lb = await list.boundingBox();
  const pb = await page.getByTestId("booking-datetime-popover").boundingBox();
  const bb = await list.locator(`[data-time="${time}"]`).boundingBox();
  const vp = page.viewportSize()!;
  if (!lb || !bb || !pb) return false;
  // 要同時在:清單的可視範圍、彈出框白框的可視範圍(白框本身也可能在捲)、螢幕裡
  const top = Math.max(lb.y, pb.y, 0);
  const bottom = Math.min(lb.y + lb.height, pb.y + pb.height, vp.height);
  return bb.y >= top - 0.5 && bb.y + bb.height <= bottom + 0.5;
}

/** 清單「看得到的那一段」(扣掉被白框捲走的部分)的中心與上下緣,手勢要從這裡開始。 */
async function visibleListRegion(page: Page): Promise<{ x: number; top: number; bottom: number }> {
  const lb = (await page.getByTestId("booking-time-options-list").boundingBox())!;
  const pb = (await page.getByTestId("booking-datetime-popover").boundingBox())!;
  const vp = page.viewportSize()!;
  const top = Math.max(lb.y, pb.y, 0);
  const bottom = Math.min(lb.y + lb.height, pb.y + pb.height, vp.height);
  // 矮視窗:清單整塊還在白框可視範圍下面(要先捲白框)⇒ 改在白框本身上操作,跟使用者會做的一樣
  if (bottom - top < 40) {
    return {
      x: pb.x + pb.width / 2,
      top: Math.max(pb.y, 0),
      bottom: Math.min(pb.y + pb.height, vp.height),
    };
  }
  return { x: lb.x + lb.width / 2, top, bottom };
}

/**
 * 白框(彈出框)要完整包住時間清單:把白框捲到底之後,清單整塊都在白框裡面。
 * (#980 QA 第二次:矮視窗時清單整塊溢出到白框外、疊在表單文字上。)
 */
async function expectListInsidePopover(page: Page): Promise<void> {
  const lb = (await page.getByTestId("booking-time-options-list").boundingBox())!;
  const pb = (await page.getByTestId("booking-datetime-popover").boundingBox())!;
  expect(lb.y, "時間清單上緣要在白框裡").toBeGreaterThanOrEqual(pb.y - 0.5);
  expect(lb.y + lb.height, "時間清單下緣要在白框裡,不可溢出到框外").toBeLessThanOrEqual(
    pb.y + pb.height + 0.5,
  );
}

async function listScrollTop(page: Page): Promise<number> {
  return page.getByTestId("booking-time-options-list").evaluate((el) => el.scrollTop);
}

/**
 * #980 QA 打回:用**真的滑鼠滾輪**把時間清單捲到目標時間,再用真的點擊選它(不可以用 evaluate 點擊)。
 * 守門:目標一開始必須不在可視範圍(否則這條測不到捲動);捲完 scrollTop 必須真的變大。
 */
async function wheelToTimeAndClick(page: Page, time: string): Promise<void> {
  const list = page.getByTestId("booking-time-options-list");
  await expect(list).toBeVisible({ timeout: LOAD_TIMEOUT });
  const vp = page.viewportSize()!;
  const popover = await page.getByTestId("booking-datetime-popover").boundingBox();
  expect(popover, "量得到時間彈出框").not.toBeNull();
  expect(popover!.y, "彈出框上緣不可超出畫面").toBeGreaterThanOrEqual(0);
  expect(popover!.y + popover!.height, "彈出框下緣不可超出畫面").toBeLessThanOrEqual(vp.height);
  expect(await isFullyVisibleInList(page, time), `前提:${time} 一開始在清單下方看不到`).toBe(false);
  const before = await listScrollTop(page);
  for (let i = 0; i < 80 && !(await isFullyVisibleInList(page, time)); i++) {
    // 每次都重新對準清單看得到的那一段(白框也在捲時,清單會跟著往上移)
    const r = await visibleListRegion(page);
    await page.mouse.move(r.x, (r.top + r.bottom) / 2);
    await page.mouse.wheel(0, 40);
    await page.waitForTimeout(50);
  }
  expect(await listScrollTop(page), "滾輪要真的讓清單往下捲").toBeGreaterThan(before);
  expect(await isFullyVisibleInList(page, time), `滾輪捲完 ${time} 要出現在清單裡`).toBe(true);
  // 清單捲到底時白框也捲到底了 ⇒ 清單整塊要在白框裡(不可溢出到框外疊在表單上)
  if (time === "23:00") await expectListInsidePopover(page);
  await list.locator(`[data-time="${time}"]`).click();
}

// =============================================================================================
// 電腦組(1280×800)
// =============================================================================================
test("C1 建單:選擇項目整頁 → 切頁籤 → 勾兩個不同分類 → 調數量 → 自訂金額 → 確認 → 摘要正確 → 付款方式下拉 → 送出成功", async ({
  page,
}) => {
  await login(page);
  const dialog = await openNewBooking(page, fixture.dateCreate, STAFF_A);
  // 表單上只有「選擇項目 >」一列
  await expect(dialog.locator("#booking-service-items")).toHaveText(/選擇項目/);

  await pickItems(dialog, async (picker) => {
    // 頁籤:兩個分類都在,預設停在第一個(依名稱排序)
    await expect(picker.getByRole("tab", { name: CATEGORY_WALL })).toBeVisible();
    await picker.getByRole("tab", { name: CATEGORY_DUCT }).click();
    await picker.getByRole("checkbox", { name: new RegExp(ITEM_DUCT) }).click();
    await expect(picker.getByText("使用原價（NT$ 3,500）")).toBeVisible();
    await picker.getByRole("tab", { name: CATEGORY_WALL }).click();
    await picker.getByRole("checkbox", { name: new RegExp(ITEM_WALL) }).click();
    await picker.getByRole("button", { name: `增加「${ITEM_WALL}」的數量` }).click();
    await expect(picker.getByRole("spinbutton", { name: `「${ITEM_WALL}」的數量` })).toHaveValue(
      "2",
    );
    await picker.getByRole("switch", { name: "自訂金額" }).click();
    await picker.getByLabel("單價").fill("1800");
    // 跨頁籤保留勾選
    await picker.getByRole("tab", { name: CATEGORY_DUCT }).click();
    await expect(picker.getByRole("checkbox", { name: new RegExp(ITEM_DUCT) })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  const summary = dialog.getByTestId("booking-selected-items-summary");
  await expect(summary).toContainText(`${ITEM_DUCT} × 1`);
  await expect(summary).toContainText(`${ITEM_WALL} × 2`);
  await expect(summary).toContainText("$3,600");
  await expect(summary).toContainText("$7,100");

  // 時間:120+60 = 180 分鐘,甲 10:00~16:00 ⇒ 10:00 仍可約(維持預設)
  await expect(dialog.locator("#booking-datetime")).toContainText("10:00");

  await dialog.locator("#booking-customer-name").fill("E2E批2建單客戶");
  await dialog.locator("#booking-customer-phone").fill("0912000979");
  // 付款方式下拉
  await dialog.locator("#booking-payment-method").click();
  await page.getByRole("option").first().click();
  await dialog.getByRole("button", { name: "建立預約" }).click();
  await expect(dialog).toHaveCount(0, { timeout: LOAD_TIMEOUT });

  // 資料庫:數量 / 單價 / 付款方式都寫進去了
  const svc = serviceClient();
  const b = await svc
    .from("bookings")
    .select("id,payment_method_id,start_at")
    .eq("merchant_id", fixture.merchantId)
    .eq("customer_name", "E2E批2建單客戶")
    .single();
  expect(b.error).toBeNull();
  expect(b.data!.payment_method_id).toBe(fixture.paymentMethodId);
  const lines = await svc
    .from("booking_service_items")
    .select("service_item_id,quantity,unit_price_snapshot")
    .eq("booking_id", b.data!.id);
  const byItem = new Map(
    (lines.data ?? []).map((l) => [
      l.service_item_id as string,
      l as { quantity: number; unit_price_snapshot: number },
    ]),
  );
  expect(byItem.get(fixture.itemWallId)).toMatchObject({ quantity: 2, unit_price_snapshot: 1800 });
  expect(byItem.get(fixture.itemDuctId)).toMatchObject({ quantity: 1, unit_price_snapshot: 3500 });
});

test("C2 時間選單只列能約的:營業時間外、每週時段外、單日排休都不列;請假那天顯示休假", async ({
  page,
}) => {
  await login(page);
  const dialog = await openNewBooking(page, fixture.dateD, STAFF_A);
  await pickItems(dialog, async (picker) => {
    await picker.getByRole("tab", { name: CATEGORY_WALL }).click();
    await picker.getByRole("checkbox", { name: new RegExp(ITEM_WALL) }).click();
  });
  const panel = await openTimeOptions(dialog);
  const buttons = panel.getByRole("button");
  await expect(buttons.first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  const times = await buttons.allTextContents();
  // 60 分鐘、甲 10:00~16:00、12:00~12:30 單日排休 ⇒ 11:30 / 12:00 不能約,15:30 以後放不下
  expect(times).toEqual([
    "10:00",
    "10:30",
    "11:00",
    "12:30",
    "13:00",
    "13:30",
    "14:00",
    "14:30",
    "15:00",
  ]);
  for (const outside of ["08:00", "09:00", "09:30", "16:00", "17:00"]) {
    expect(times, `營業時間 / 每週時段外的 ${outside} 不應該列出`).not.toContain(outside);
  }
  await page.keyboard.press("Escape");

  // 請假那天:沒有任何時間,講清楚是休假
  const dialog2 = await openNewBooking(page, fixture.dateLeave, STAFF_A);
  const panel2 = await openTimeOptions(dialog2);
  await expect(panel2).toContainText(`這位服務人員這天休假(${fixture.leaveTypeName})`);
  await expect(panel2.getByRole("button")).toHaveCount(0);
  // 按「新增預約」帶的 10:00 是系統預設值,不是使用者選的 ⇒ 安靜清空,不跳「這個時間已無法預約」(主腦裁決第 2 批第 3 項)
  await page.keyboard.press("Escape");
  await expect(dialog2.locator("#booking-datetime")).toContainText("請選擇日期時間");
  await expect(dialog2.getByText("這個時間已無法預約，請重新選擇")).toHaveCount(0);
});

test("C3 非 30 倍數工時(45 分鐘項目):時間選單正常列出(含 23:00,不會轉圈卡住);1280 用滑鼠滾輪捲到最底的 23:00 點選、彈出框不超出畫面、送出成功", async ({
  page,
}) => {
  await login(page);
  // 乙:無時段限制 ⇒ 可約範圍 = 營業時間 09:00~23:59。23:00 起 45 分鐘 = 結束 23:45,
  // 正好是 #980 QA 抓到的「結束落在 23:30~24:00 ⇒ 舊函式無限迴圈」情境。
  const dialog = await openNewBooking(page, fixture.dateD, STAFF_B);
  await pickItems(dialog, async (picker) => {
    await picker.getByRole("tab", { name: CATEGORY_WALL }).click();
    await picker.getByRole("checkbox", { name: new RegExp(ITEM_QUICK) }).click();
  });
  const started = Date.now();
  const panel = await openTimeOptions(dialog);
  const last = panel.getByRole("button", { name: "23:00" });
  await expect(last).toBeVisible({ timeout: 8_000 });
  expect(Date.now() - started, "時間選單要在幾秒內出來,不能轉圈卡住").toBeLessThan(8_000);
  const times = await panel.getByRole("button").allTextContents();
  expect(times[0]).toBe("09:00");
  expect(times).not.toContain("23:30"); // 23:30 起會跨到隔天
  expect(times).toHaveLength(29); // 09:00 ~ 23:00,每 30 分一個
  // #980 QA 打回:23:00 在清單最底下 ⇒ 用真的滑鼠滾輪捲下去再點(清單在建單彈窗裡,原本滾輪會被彈窗的捲動鎖吃掉)。
  await wheelToTimeAndClick(page, "23:00");
  await expect(dialog.locator("#booking-datetime")).toContainText("23:00");

  await dialog.locator("#booking-customer-name").fill("E2E批2四十五分客戶");
  await dialog.locator("#booking-customer-phone").fill("0912000980");
  await dialog.locator("#booking-payment-method").click();
  await page.getByRole("option").first().click();
  await dialog.getByRole("button", { name: "建立預約" }).click();
  await expect(dialog).toHaveCount(0, { timeout: LOAD_TIMEOUT });

  const b = await serviceClient()
    .from("bookings")
    .select("start_at,end_at,staff_id")
    .eq("merchant_id", fixture.merchantId)
    .eq("customer_name", "E2E批2四十五分客戶")
    .single();
  expect(b.error).toBeNull();
  expect(b.data!.staff_id).toBe(fixture.staffBId);
  expect(new Date(b.data!.end_at).getTime() - new Date(b.data!.start_at).getTime()).toBe(
    45 * 60_000,
  );
});

function expectedStarts(ranges: [string, string][], step: number): string[] {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const out: string[] = [];
  for (const [from, to] of ranges) {
    for (let m = toMin(from); m <= toMin(to); m += step) {
      out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
    }
  }
  return out;
}

async function setIntervalViaUi(page: Page, minutes: 5 | 15 | 30): Promise<void> {
  await page.goto("/app/business-hours");
  const group = page.getByRole("radiogroup", { name: "建單時間間隔" });
  await expect(group).toBeVisible({ timeout: LOAD_TIMEOUT });
  await group.getByRole("radio", { name: `${minutes} 分鐘`, exact: true }).click();
  await expect(group.getByRole("radio", { name: `${minutes} 分鐘`, exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
    { timeout: LOAD_TIMEOUT },
  );
  await expect
    .poll(async () => {
      const r = await serviceClient()
        .from("merchant_booking_settings")
        .select("start_time_interval_minutes")
        .eq("merchant_id", fixture.merchantId)
        .maybeSingle();
      return r.data?.start_time_interval_minutes ?? null;
    })
    .toBe(minutes);
}

test("C4 建單時間間隔 15 / 5 分鐘:45 分鐘項目只列整段落在每週時段內、避開單日排休的起點(含不在整點的 10:05、15:15);選 14:05 送出成功", async ({
  page,
}) => {
  await login(page);
  try {
    // ── 間隔 15 ──
    await setIntervalViaUi(page, 15);
    let dialog = await openNewBooking(page, fixture.dateD, STAFF_A);
    await pickItems(dialog, async (picker) => {
      await picker.getByRole("tab", { name: CATEGORY_WALL }).click();
      await picker.getByRole("checkbox", { name: new RegExp(ITEM_QUICK) }).click();
    });
    let panel = await openTimeOptions(dialog);
    await expect(panel.getByRole("button").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
    // 甲:每週時段 10:00~16:00;D 當天 12:00~12:30 單日排休。45 分鐘 ⇒
    //   10:00~11:15(11:15 起到 12:00 剛好)、12:30~15:15(15:15 起到 16:00 剛好);11:30~12:15 起都會碰到排休
    expect(await panel.getByRole("button").allTextContents()).toEqual(
      expectedStarts(
        [
          ["10:00", "11:15"],
          ["12:30", "15:15"],
        ],
        15,
      ),
    );
    await page.keyboard.press("Escape");

    // ── 間隔 5 ──
    await setIntervalViaUi(page, 5);
    dialog = await openNewBooking(page, fixture.dateD, STAFF_A);
    await pickItems(dialog, async (picker) => {
      await picker.getByRole("tab", { name: CATEGORY_WALL }).click();
      await picker.getByRole("checkbox", { name: new RegExp(ITEM_QUICK) }).click();
    });
    panel = await openTimeOptions(dialog);
    await expect(panel.getByRole("button").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
    const times = await panel.getByRole("button").allTextContents();
    expect(times).toEqual(
      expectedStarts(
        [
          ["10:00", "11:15"],
          ["12:30", "15:15"],
        ],
        5,
      ),
    );
    expect(times).toContain("10:05");
    expect(times, "11:20 起(到 12:05)會碰到 12:00 單日排休").not.toContain("11:20");
    expect(times, "15:20 起(到 16:05)超出每週時段").not.toContain("15:20");

    // 選 14:05(不在整點)⇒ 重新打開時清單捲到 14:05 附近
    await wheelToTimeAndClick(page, "14:05");
    await expect(dialog.locator("#booking-datetime")).toContainText("14:05");
    await dialog.locator("#booking-datetime").click();
    const list = page.getByTestId("booking-time-options-list");
    await expect(list).toBeVisible();
    await expect
      .poll(() =>
        list.evaluate((el) => {
          const btn = el.querySelector<HTMLElement>('[data-time="14:05"]');
          if (!btn) return "no-button";
          const top = btn.offsetTop - el.scrollTop;
          return el.scrollTop > 0 && top >= 0 && top + btn.offsetHeight <= el.clientHeight
            ? "visible"
            : `scrollTop=${el.scrollTop} top=${top}`;
        }),
      )
      .toBe("visible");
    await page.keyboard.press("Escape");

    await dialog.locator("#booking-customer-name").fill("E2E批2五分間隔客戶");
    await dialog.locator("#booking-customer-phone").fill("0912000985");
    await dialog.locator("#booking-payment-method").click();
    await page.getByRole("option").first().click();
    await dialog.getByRole("button", { name: "建立預約" }).click();
    await expect(dialog).toHaveCount(0, { timeout: LOAD_TIMEOUT });
    const b = await serviceClient()
      .from("bookings")
      .select("start_at,end_at")
      .eq("merchant_id", fixture.merchantId)
      .eq("customer_name", "E2E批2五分間隔客戶")
      .single();
    expect(b.error).toBeNull();
    const start = new Date(b.data!.start_at);
    expect(
      start.toLocaleTimeString("en-GB", {
        timeZone: "Asia/Taipei",
        hour: "2-digit",
        minute: "2-digit",
      }),
    ).toBe("14:05");
    expect(new Date(b.data!.end_at).getTime() - start.getTime()).toBe(45 * 60_000);
  } finally {
    // 其他測試以 30 分鐘為前提 ⇒ 改回 30
    await setIntervalViaUi(page, 30);
  }
});

// =============================================================================================
// 手機組(375×667,觸控)
// =============================================================================================
async function newMobileContext(browser: Browser, height = 667): Promise<BrowserContext> {
  const iphone = devices["iPhone SE (3rd gen)"];
  return browser.newContext({
    viewport: { width: 375, height },
    userAgent: iphone.userAgent,
    deviceScaleFactor: iphone.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    timezoneId: "Asia/Taipei",
  });
}

type Pt = { x: number; y: number };
async function touch(cdp: CDPSession, type: "touchStart" | "touchMove", p: Pt) {
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: [{ x: p.x, y: p.y }] });
}
async function touchEnd(cdp: CDPSession) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/**
 * #980 QA:手機用手指在時間清單上往上滑,直到目標時間完整出現(清單捲到底後會接著捲外面的白框)。
 * 手指停住一下再放開(不甩出去)⇒ 沒有慣性滑動;慣性滑動中點下去,瀏覽器只會「停下滑動」,不會當成點擊。
 */
async function touchScrollToTime(page: Page, cdp: CDPSession, time: string): Promise<void> {
  const before = await listScrollTop(page);
  for (let round = 0; round < 25 && !(await isFullyVisibleInList(page, time)); round++) {
    const r = await visibleListRegion(page);
    const span = Math.max(20, r.bottom - r.top - 20);
    const from = { x: r.x, y: r.bottom - 10 };
    const to = { x: r.x, y: from.y - span };
    await touch(cdp, "touchStart", from);
    for (let i = 1; i <= 8; i++) {
      await touch(cdp, "touchMove", { x: from.x, y: from.y + ((to.y - from.y) * i) / 8 });
    }
    await page.waitForTimeout(200);
    await touch(cdp, "touchMove", to);
    await touchEnd(cdp);
    await page.waitForTimeout(400);
  }
  // 第 6 批(#849)M5 偶發不穩的根因:原本只等「清單自己的 scrollTop」停住。M4(667 高)只有清單會捲,
  // 這樣就夠;M5(375×560 矮視窗)清單捲到底後手勢會接著捲**外面的白框**(白框本身也是捲動容器),
  // 白框還在慣性滑動時清單的 scrollTop 早就不動了 ⇒ 這裡判定「停穩」、馬上 tap ⇒ 瀏覽器把這一下
  // 當成「停下滑動」而不是點擊(見本函式上方註解)⇒ 偶發選不到 23:00。
  // 改成等「目標按鈕在畫面上的位置」停住:不管是清單、白框還是整頁在捲,只要還在動,位置就會變,
  // 一個條件涵蓋所有捲動容器(連續兩次相隔 250ms 量到同一個位置才算停穩)。
  const targetY = async () =>
    (
      await page
        .getByTestId("booking-time-options-list")
        .locator(`[data-time="${time}"]`)
        .boundingBox()
    )?.y ?? Number.NaN;
  await expect
    .poll(async () => {
      const a = await targetY();
      await page.waitForTimeout(250);
      const b = await targetY();
      await page.waitForTimeout(250);
      const c = await targetY();
      return Number.isFinite(a) && a === b && b === c;
    })
    .toBe(true);
  expect(await listScrollTop(page), "手指往上滑要真的讓清單往下捲").toBeGreaterThan(before);
  expect(await isFullyVisibleInList(page, time), `滑完 ${time} 要完整出現`).toBe(true);
}

/** 記錄下拉刷新指示器「曾經出現過」的狀態(手勢很快,事後查不到中間狀態)。 */
async function startIndicatorRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __e2ePullStates?: string[] };
    w.__e2ePullStates = [];
    const record = () => {
      const el = document.querySelector('[data-testid="pull-to-refresh-indicator"]');
      const v = el?.getAttribute("data-state");
      if (v && w.__e2ePullStates![w.__e2ePullStates!.length - 1] !== v) w.__e2ePullStates!.push(v);
    };
    new MutationObserver(record).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
  });
}
async function indicatorStates(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __e2ePullStates?: string[] }).__e2ePullStates ?? [],
  );
}

async function openMobileCalendar(
  browser: Browser,
  options: { blockRealtime?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page; cdp: CDPSession }> {
  const context = await newMobileContext(browser);
  const page = await context.newPage();
  // #1003(第 14 批)起商家端行事曆有即時同步:別的 session 新增訂單,畫面幾秒內就會自己出現。
  // M1 要驗的是「下拉刷新」本身,所以把 Realtime 的 WebSocket 擋掉(等同即時同步斷線),
  // 才能證明訂單是下拉刷新抓回來的。即時同步本身由 b14-calendar-live-sync-and-cards.spec.ts 驗。
  if (options.blockRealtime) {
    await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => ws.close());
  }
  // iPhone UA 會跳「加入主畫面」浮動提示(InstallPwaHint),蓋住格線下半部 ⇒ 先寫入「7 天內不再提示」。
  await page.addInitScript(() => {
    window.localStorage.setItem("miaoyue_pwa_install_hint_dismissed_at", String(Date.now()));
  });
  await login(page);
  await page.goto(`/app/calendar?date=${fixture.dateMobile}`);
  await page
    .getByRole("radiogroup", { name: "檢視模式" })
    .getByRole("radio", { name: "週檢視" })
    .click({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("calendar-day-grid")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId(`staff-grid-${fixture.staffBId}`)).toHaveCount(1, {
    timeout: LOAD_TIMEOUT,
  });
  const cdp = await context.newCDPSession(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await startIndicatorRecorder(page);
  return { context, page, cdp };
}

test("M1 手機 375px:另一個 session 新增訂單 → 頁面頂端往下拉放開 → 新訂單出現(沒有整頁重載)", async ({
  browser,
}) => {
  const { context, page, cdp } = await openMobileCalendar(browser, { blockRealtime: true });
  try {
    const bookingId = await createBookingAsAdmin(fixture, {
      staffId: fixture.staffBId,
      dateKey: fixture.dateMobile,
      time: "15:00",
      customerName: "E2E批2下拉刷新客戶",
    });
    const block = page.getByTestId(`booking-block-${bookingId}-main`);
    await page.waitForTimeout(1500);
    await expect(block, "前提:還沒刷新前,另一個 session 新增的訂單不會自己出現").toHaveCount(0);
    await page.evaluate(() => {
      (window as unknown as { __e2eMarker?: string }).__e2eMarker = "still-here";
    });

    // 手指從頁首下方的標題區往下拉 150px(頁面在最頂端)
    const title = page.getByRole("heading", { level: 1 }).first();
    const box = await title.boundingBox();
    if (!box) throw new Error("量不到頁面標題");
    const from = { x: box.x + 20, y: box.y + box.height / 2 };
    await touch(cdp, "touchStart", from);
    for (let i = 1; i <= 6; i++) await touch(cdp, "touchMove", { x: from.x, y: from.y + i * 25 });
    await touchEnd(cdp);

    await expect(block, "下拉刷新後新訂單應該出現").toHaveCount(1, { timeout: LOAD_TIMEOUT });
    expect(await indicatorStates(page)).toEqual(expect.arrayContaining(["ready", "refreshing"]));
    expect(
      await page.evaluate(() => (window as unknown as { __e2eMarker?: string }).__e2eMarker),
      "重新抓資料,不是整頁重載(整頁重載的話 window 上的標記會消失)",
    ).toBe("still-here");
    await expect(page.getByTestId("pull-to-refresh-indicator")).toHaveCount(0, {
      timeout: LOAD_TIMEOUT,
    });
  } finally {
    await context.close();
  }
});

test("M2 手機 375px:行事曆長按拖拉預約往下拖 → 改時間成功,下拉刷新完全沒有被觸發", async ({
  browser,
}) => {
  const bookingId = await createBookingAsAdmin(fixture, {
    staffId: fixture.staffBId,
    dateKey: fixture.dateMobile,
    time: "10:00",
    customerName: "E2E批2拖拉客戶",
  });
  const { context, page, cdp } = await openMobileCalendar(browser);
  try {
    const sent: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/rest/v1/rpc/move_booking"))
        sent.push(req.url());
    });
    const grid = page.getByTestId("calendar-day-grid");
    await grid.evaluate((el) => {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    });
    const block = page.getByTestId(`booking-block-${bookingId}-main`);
    await expect(block).toBeVisible({ timeout: LOAD_TIMEOUT });
    const box = await block.boundingBox();
    if (!box) throw new Error("量不到預約色塊");
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const hit = await page.evaluate(
      ([x, y]) => {
        const e = document.elementFromPoint(x as number, y as number);
        return !!e?.closest("[data-booking-draggable]");
      },
      [from.x, from.y],
    );
    expect(hit, "前提:手指按下去的那一點真的在可拖的色塊上").toBe(true);
    expect(await page.evaluate(() => window.scrollY), "前提:頁面在最頂端(下拉刷新的觸發條件)").toBe(
      0,
    );

    await touch(cdp, "touchStart", from);
    await page.waitForTimeout(700);
    await expect(grid).toHaveAttribute("data-drag-phase", "dragging");
    for (let i = 1; i <= 8; i++) await touch(cdp, "touchMove", { x: from.x, y: from.y + i * 15 });
    await touchEnd(cdp);
    await expect(grid).toHaveAttribute("data-drag-phase", "idle", { timeout: LOAD_TIMEOUT });

    expect(sent, "拖拉改時間照常送出 move_booking").toHaveLength(1);
    await page.waitForTimeout(800);
    expect(await indicatorStates(page), "下拉刷新指示器一次都不應該出現").toEqual([]);
  } finally {
    await context.close();
  }
});

test("M3 手機 375px:建單表單(彈窗)開著時往下拉 ⇒ 不觸發下拉刷新", async ({ browser }) => {
  const { context, page, cdp } = await openMobileCalendar(browser);
  try {
    await page.getByRole("button", { name: "新增預約" }).first().click();
    const dialog = page
      .getByRole("dialog")
      .filter({ has: page.getByRole("heading", { name: "新增預約" }) });
    await expect(dialog).toBeVisible({ timeout: LOAD_TIMEOUT });
    const from = { x: 180, y: 140 };
    await touch(cdp, "touchStart", from);
    for (let i = 1; i <= 6; i++) await touch(cdp, "touchMove", { x: from.x, y: from.y + i * 25 });
    await touchEnd(cdp);
    await page.waitForTimeout(800);
    expect(await indicatorStates(page)).toEqual([]);
    await expect(dialog).toBeVisible();
  } finally {
    await context.close();
  }
});

test("M4 手機 375px:建單彈窗裡的時間清單用手指往上滑可以捲動,點到原本看不到的 23:00 並送出成功", async ({
  browser,
}) => {
  const context = await newMobileContext(browser);
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.localStorage.setItem("miaoyue_pwa_install_hint_dismissed_at", String(Date.now()));
  });
  try {
    await login(page);
    const cdp = await context.newCDPSession(page);
    const dialog = await openNewBooking(page, fixture.dateCreate, STAFF_B);
    await pickItems(dialog, async (picker) => {
      await picker.getByRole("tab", { name: CATEGORY_WALL }).click();
      await picker.getByRole("checkbox", { name: new RegExp(ITEM_QUICK) }).click();
    });
    await openTimeOptions(dialog);
    const list = page.getByTestId("booking-time-options-list");
    await expect(list.locator('[data-time="23:00"]')).toHaveCount(1, { timeout: LOAD_TIMEOUT });
    const vp = page.viewportSize()!;
    const popover = (await page.getByTestId("booking-datetime-popover").boundingBox())!;
    expect(popover.y).toBeGreaterThanOrEqual(0);
    expect(popover.y + popover.height, "彈出框下緣不可超出手機畫面").toBeLessThanOrEqual(vp.height);
    expect(await isFullyVisibleInList(page, "23:00"), "前提:23:00 一開始在清單下方看不到").toBe(
      false,
    );

    await touchScrollToTime(page, cdp, "23:00");
    expect(await isFullyVisibleInList(page, "23:00")).toBe(true);
    await list.locator('[data-time="23:00"]').tap();
    await expect(dialog.locator("#booking-datetime")).toContainText("23:00");

    await dialog.locator("#booking-customer-name").fill("E2E批2手機捲動客戶");
    await dialog.locator("#booking-customer-phone").fill("0912000986");
    await dialog.locator("#booking-payment-method").click();
    await page.getByRole("option").first().click();
    await dialog.getByRole("button", { name: "建立預約" }).click();
    await expect(dialog).toHaveCount(0, { timeout: LOAD_TIMEOUT });
    const b = await serviceClient()
      .from("bookings")
      .select("start_at,staff_id")
      .eq("merchant_id", fixture.merchantId)
      .eq("customer_name", "E2E批2手機捲動客戶")
      .single();
    expect(b.error).toBeNull();
    expect(
      new Date(b.data!.start_at).toLocaleTimeString("en-GB", {
        timeZone: "Asia/Taipei",
        hour: "2-digit",
        minute: "2-digit",
      }),
    ).toBe("23:00");
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------------------------
// #980 QA 第二次打回:矮視窗(iPhone SE + Safari 工具列這類)時,日期時間白框被壓到約 230~260px,
// 原本時間清單整塊溢出到白框外、疊在表單文字上。現在白框本身可以捲,內容一定包在框裡。
// ---------------------------------------------------------------------------------------------
async function fillAndSubmit(page: Page, dialog: Locator, name: string, phone: string) {
  await dialog.locator("#booking-customer-name").fill(name);
  await dialog.locator("#booking-customer-phone").fill(phone);
  await dialog.locator("#booking-payment-method").click();
  await page.getByRole("option").first().click();
  await dialog.getByRole("button", { name: "建立預約" }).click();
  await expect(dialog).toHaveCount(0, { timeout: LOAD_TIMEOUT });
}

async function expectBookedAt(name: string, time: string) {
  const b = await serviceClient()
    .from("bookings")
    .select("start_at")
    .eq("merchant_id", fixture.merchantId)
    .eq("customer_name", name)
    .single();
  expect(b.error).toBeNull();
  expect(
    new Date(b.data!.start_at).toLocaleTimeString("en-GB", {
      timeZone: "Asia/Taipei",
      hour: "2-digit",
      minute: "2-digit",
    }),
  ).toBe(time);
}

test("C5 矮視窗 1280×560:時間白框不超出畫面、清單整塊包在白框裡;滾輪捲到 23:00 點選送出成功", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await login(page);
  const dialog = await openNewBooking(page, fixture.dateLeave, STAFF_B);
  await pickItems(dialog, async (picker) => {
    await picker.getByRole("tab", { name: CATEGORY_WALL }).click();
    await picker.getByRole("checkbox", { name: new RegExp(ITEM_QUICK) }).click();
  });
  await openTimeOptions(dialog);
  await expect(
    page.getByTestId("booking-time-options-list").locator('[data-time="23:00"]'),
  ).toHaveCount(1, {
    timeout: LOAD_TIMEOUT,
  });
  await wheelToTimeAndClick(page, "23:00");
  await expect(dialog.locator("#booking-datetime")).toContainText("23:00");
  await fillAndSubmit(page, dialog, "E2E批2矮視窗電腦客戶", "0912000987");
  await expectBookedAt("E2E批2矮視窗電腦客戶", "23:00");
});

test("M5 矮視窗 375×560:時間白框不超出畫面、清單整塊包在白框裡;手指捲到 23:00 點選送出成功", async ({
  browser,
}) => {
  const context = await newMobileContext(browser, 560);
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.localStorage.setItem("miaoyue_pwa_install_hint_dismissed_at", String(Date.now()));
  });
  try {
    await login(page);
    const cdp = await context.newCDPSession(page);
    const dialog = await openNewBooking(page, fixture.dateMobile, STAFF_B);
    await pickItems(dialog, async (picker) => {
      await picker.getByRole("tab", { name: CATEGORY_WALL }).click();
      await picker.getByRole("checkbox", { name: new RegExp(ITEM_QUICK) }).click();
    });
    await openTimeOptions(dialog);
    const list = page.getByTestId("booking-time-options-list");
    await expect(list.locator('[data-time="23:00"]')).toHaveCount(1, { timeout: LOAD_TIMEOUT });
    const vp = page.viewportSize()!;
    const pb = (await page.getByTestId("booking-datetime-popover").boundingBox())!;
    expect(pb.y, "白框上緣不可超出畫面").toBeGreaterThanOrEqual(0);
    expect(pb.y + pb.height, "白框下緣不可超出畫面").toBeLessThanOrEqual(vp.height);
    expect(pb.height, "前提:這個高度下白框真的被壓矮(月曆 + 清單放不下)").toBeLessThan(400);
    await touchScrollToTime(page, cdp, "23:00");
    await expectListInsidePopover(page);
    await list.locator('[data-time="23:00"]').tap();
    await expect(dialog.locator("#booking-datetime")).toContainText("23:00");
    await fillAndSubmit(page, dialog, "E2E批2矮視窗手機客戶", "0912000988");
    await expectBookedAt("E2E批2矮視窗手機客戶", "23:00");
  } finally {
    await context.close();
  }
});
