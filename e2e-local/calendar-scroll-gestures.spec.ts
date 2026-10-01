// #845「行事曆橫向捲動與手勢」本機 e2e(規格書 .project/specs/行事曆橫向捲動與手勢.md §七)。
// **只在本機跑**:`npm run test:e2e:local`(playwright.local.config.ts,只連本機 Docker;Playwright 自己開
// 獨立 Chromium,不碰使用者的瀏覽器)。fixture 見 e2e-local/support/calendar-gesture-fixture.ts 檔頭。
//
// =========================================================================
// 批次 1「先把現況釘住」:**不改任何產品程式**,下面每一條都應該對著現況就綠。
//   手機組(375×667,isMobile + hasTouch,自己開 context):T0 ~ T7
//   電腦組(1280×800,滑鼠):D11 固定欄回歸
//   批次 2 / 3 會在這支檔案補 D0 ~ D10、K1(滑鼠拖曳捲動、滑軌、層級),到時再加。
//
// 🔴 手機的「直接滑 = 捲動」靠的是**我們什麼都不攔**(規格書 R2):格線內不准 touch-action:none、
//    不准無條件 preventDefault。T1 ~ T3 就是在守這件事;如果哪天它們紅了,先查有沒有人加了這兩種東西。
//
// 觸控手勢用 CDP `Input.dispatchTouchEvent`(page.touchscreen 只有 tap);舊 e2e/calendar-drag-move.spec.ts #9
// 已證實這個方法在 Chromium 會觸發原生捲動。手機 context 只挑欄位、不整包 spread devices[...]
// (整包會把 defaultBrowserType 帶成沒裝的 webkit),同一個 worker 內自己開,避免重建 fixture。
//
// 為什麼 mode: "default" 不是 serial:serial 一條紅,後面全部 skipped(看起來像正常)。T5 會真的改 P1 的
// 服務人員,所以排在 T3 / T4 之後;任何一條紅了 Playwright 會重開 worker、重建一組 fixture,不互相汙染。
//
// 守門(每一條):① afterEach 斷言瀏覽器打到 supabase.co 的請求 = 0(而且確實有打到本機);
//   ② 手勢前用 elementFromPoint 確認「手指 / 游標按下去的那一點」真的落在預期的元素上(不是被頁首或別的層蓋住),
//      避免「按到別的東西 → 什麼都沒發生 → 綠燈」這種假綠。
//
// =========================================================================
// 🔴 故障注入(規格書 X5;不改任何產品檔,用環境變數在**測試裡**對頁面注入樣式,跑完不設變數即還原):
//
//   E2E_FAULT_INJECT=touch-action-none
//     → 在格線容器與其所有子孫注入 `touch-action: none !important`(= R2 明文禁止的寫法)。
//     預期 T1、T2、T3 轉紅(手指滑動不再捲動格線)。實際紅字見回報 / 下方紀錄。
//
//   E2E_FAULT_INJECT=sticky-off
//     → 把時間欄與名字列的 `position: sticky` 注入成 `static`(= 2026-09-30 sticky 回歸的同類壞法)。
//     預期 D11 轉紅。
//
//   執行方式(PowerShell):$env:E2E_FAULT_INJECT='touch-action-none'; npx playwright test --config playwright.local.config.ts calendar-scroll-gestures -g "T1|T2|T3"
//   跑完 Remove-Item Env:E2E_FAULT_INJECT。不設這個變數時注入程式碼完全不會執行。
//
//   2026-10-01 實際紀錄:見檔尾「故障注入紀錄」。
// =========================================================================
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
import { assertNoHorizontalOverflow } from "../e2e/support/overflow-assert";
import {
  injectSession,
  readBooking,
  setupCalendarGestureFixture,
  STAFF_NAME_PREFIX,
  teardownCalendarGestureFixture,
  type CalendarGestureFixture,
  type GestureBooking,
  type GestureMerchant,
} from "./support/calendar-gesture-fixture";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";

const LOAD_TIMEOUT = 20_000;
/** = CalendarPage.tsx 的 SLOT_PX;openDayGrid 會用「26 格 × 30px」反查,對不上當場紅。 */
const SLOT_PX = 30;
const GRID_SLOT_COUNT = 26;
const MOVE_BOOKING_RPC_PATH = "/rest/v1/rpc/move_booking";
const FAULT = process.env["E2E_FAULT_INJECT"] ?? "";

test.use({ viewport: { width: 1280, height: 800 }, timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "default", timeout: 90_000 });

let fixture: CalendarGestureFixture;
let setupFailed = false;
/** 這條測試開過的每一個 page 的請求紀錄(手機組自己開 context,所以不只一個)。 */
let recorders: RequestRecorder[] = [];

test.beforeAll(async () => {
  test.setTimeout(150_000);
  try {
    fixture = await setupCalendarGestureFixture();
    console.log(
      `[calendar-scroll-gestures 本機] fixture 建好(多人商家 ${fixture.many.merchantId.slice(0, 8)}、` +
        `少人商家 ${fixture.few.merchantId.slice(0, 8)},日期 ${fixture.dateKey})` +
        (FAULT ? `;🔴 故障注入:${FAULT}` : ""),
    );
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(150_000);
  if (setupFailed || !fixture) return;
  const actions = await teardownCalendarGestureFixture(fixture);
  console.log(
    "[calendar-scroll-gestures 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"),
  );
});

test.beforeEach(() => {
  recorders = [];
});

test.afterEach(() => {
  expect(recorders.length, "前提:這條測試至少開過一個頁面").toBeGreaterThan(0);
  for (const r of recorders) expectOnlyLocalRequests(r);
});

// ---------------------------------------------------------------------------------------------
// 共用:開頁、量測、紀錄
// ---------------------------------------------------------------------------------------------
function guard(page: Page): void {
  recorders.push(recordRequestHosts(page));
}

/** 收集 move_booking 請求 body(有沒有送、送了什麼)。 */
function trackMoveBooking(page: Page): Record<string, unknown>[] {
  const sent: Record<string, unknown>[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes(MOVE_BOOKING_RPC_PATH)) {
      sent.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
    }
  });
  return sent;
}

function grid(page: Page): Locator {
  return page.getByTestId("calendar-day-grid");
}
function staffGrid(page: Page, staffId: string): Locator {
  return page.getByTestId(`staff-grid-${staffId}`);
}
function blockOf(page: Page, b: GestureBooking): Locator {
  return page.getByTestId(`booking-block-${b.id}-main`);
}
/** 某位服務人員欄裡的第 i 格空白格(DaySlotCell 的 <button data-slot-state>;i = 0 是 08:00)。 */
function slotCell(page: Page, staffId: string, index: number): Locator {
  return staffGrid(page, staffId).locator("button[data-slot-state]").nth(index);
}
/** 時間欄裡的第 i 個時間標籤(i = 0 是 08:00)。 */
function timeLabel(page: Page, index: number): Locator {
  return grid(page).locator("[data-drag-time-gutter] + div > div").nth(index);
}

/** 手機 context:375×667(或指定寬)、isMobile + hasTouch、台北時區。只挑欄位,不整包 spread。 */
async function newMobileContext(
  browser: Browser,
  width = 375,
  height = 667,
): Promise<BrowserContext> {
  const iphone = devices["iPhone SE (3rd gen)"];
  return browser.newContext({
    viewport: { width, height },
    userAgent: iphone.userAgent,
    deviceScaleFactor: iphone.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    timezoneId: "Asia/Taipei",
  });
}

/** 登入 → 行事曆 → 週檢視、fixture 那一天 → 等格線與(多人商家的)色塊真的渲染出來。 */
async function openDayGrid(page: Page, merchant: GestureMerchant): Promise<void> {
  guard(page);
  await injectSession(page, merchant.adminSession);
  await primeCurrentMerchant(page);
  await page.goto(`/app/calendar?date=${fixture.dateKey}`);
  await page
    .getByRole("radiogroup", { name: "檢視模式" })
    .getByRole("radio", { name: "週檢視" })
    .click({ timeout: LOAD_TIMEOUT });
  await expect(grid(page)).toBeVisible({ timeout: LOAD_TIMEOUT });
  for (const id of merchant.staffIds) {
    await expect(staffGrid(page, id)).toHaveCount(1, { timeout: LOAD_TIMEOUT });
  }
  if (merchant === fixture.many) {
    await expect(blockOf(page, fixture.bookings.p1)).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(blockOf(page, fixture.bookings.p2)).toHaveCount(1);
  }
  const h = await staffGrid(page, merchant.staffIds[0] as string).evaluate(
    (el) => el.getBoundingClientRect().height,
  );
  expect(Math.round(h), "前提:格線高度 = 26 格 × 30px(08:00–21:00),SLOT_PX 常數才對").toBe(
    GRID_SLOT_COUNT * SLOT_PX,
  );
  await startToastRecorder(page);
  await applyFaultInjection(page);
}

async function applyFaultInjection(page: Page): Promise<void> {
  if (FAULT === "touch-action-none") {
    await page.addStyleTag({
      content:
        '[data-testid="calendar-day-grid"], [data-testid="calendar-day-grid"] * { touch-action: none !important; }',
    });
  } else if (FAULT === "sticky-off") {
    await page.addStyleTag({
      content: '[data-testid="calendar-day-grid"] .sticky { position: static !important; }',
    });
  } else if (FAULT !== "") {
    throw new Error(`不認得的 E2E_FAULT_INJECT=${FAULT}`);
  }
}

/** 讓格線容器頂端落在畫面上方、頁首下面(頁首約 64px),手勢點才不會被頁首蓋住。 */
async function bringGridToTop(page: Page, offsetTop = 80): Promise<void> {
  await grid(page).evaluate((el, off) => {
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top - off));
  }, offsetTop);
}

async function scrollState(page: Page): Promise<{
  left: number;
  top: number;
  maxLeft: number;
  maxTop: number;
}> {
  return grid(page).evaluate((el) => ({
    left: el.scrollLeft,
    top: el.scrollTop,
    maxLeft: el.scrollWidth - el.clientWidth,
    maxTop: el.scrollHeight - el.clientHeight,
  }));
}

async function setScroll(page: Page, left: number, top: number): Promise<void> {
  await grid(page).evaluate(
    (el, [l, t]) => {
      el.scrollLeft = l as number;
      el.scrollTop = t as number;
    },
    [left, top],
  );
  // 等 sticky / 版面在下一幀更新
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}

/** 元素中心點(視窗座標)。 */
async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("量不到 boundingBox(元素可能沒渲染或不在畫面上)");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** 🔴 假綠燈守門:按下去的那一點,elementFromPoint 必須是目標元素(或它的子孫)。 */
async function expectHit(
  page: Page,
  point: { x: number; y: number },
  target: Locator,
  label: string,
) {
  const handle = await target.elementHandle();
  if (!handle) throw new Error(`${label}:目標元素不存在`);
  const hit = await page.evaluate(
    ([x, y, el]) => {
      const e = document.elementFromPoint(x as number, y as number);
      return !!e && (el as Element).contains(e);
    },
    [point.x, point.y, handle] as const,
  );
  expect(
    hit,
    `前提:${label}——(${Math.round(point.x)}, ${Math.round(point.y)}) 這一點必須真的落在目標上`,
  ).toBe(true);
}

type Pt = { x: number; y: number };
async function touchStart(cdp: CDPSession, p: Pt): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: p.x, y: p.y }],
  });
}
async function touchMove(cdp: CDPSession, p: Pt): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: p.x, y: p.y }],
  });
}
async function touchEnd(cdp: CDPSession): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
/** 手指從 from 直接滑 (dx, dy),分 steps 步(長按前就移動 = 捲動手勢)。 */
async function swipe(cdp: CDPSession, from: Pt, dx: number, dy: number, steps = 8): Promise<void> {
  await touchStart(cdp, from);
  for (let i = 1; i <= steps; i++) {
    await touchMove(cdp, { x: from.x + (dx * i) / steps, y: from.y + (dy * i) / steps });
  }
  await touchEnd(cdp);
}

/** toast「曾經出現過」記錄器(toast 會自己消失,toHaveCount(0) 會等到它消失後假通過;見舊 calendar-drag-move 檔頭)。 */
async function startToastRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __e2eToastTexts?: string[] };
    w.__e2eToastTexts = [];
    const record = () => {
      document.querySelectorAll("[data-sonner-toast]").forEach((el) => {
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text && !w.__e2eToastTexts!.includes(text)) w.__e2eToastTexts!.push(text);
      });
    };
    record();
    new MutationObserver(record).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}
async function recordedToasts(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __e2eToastTexts?: string[] }).__e2eToastTexts ?? [],
  );
}

/** 拖拉流程「什麼都沒發生」:phase 回 idle、沒殘影、沒 toast、沒 move_booking。 */
async function expectNoDragEffect(page: Page, sent: Record<string, unknown>[]): Promise<void> {
  await expect(grid(page)).toHaveAttribute("data-drag-phase", "idle", { timeout: LOAD_TIMEOUT });
  await page.waitForTimeout(800);
  await expect(page.getByTestId("booking-drag-ghost")).toHaveCount(0);
  expect(await recordedToasts(page), "不應該出現任何 toast(含已自動消失的)").toEqual([]);
  expect(sent, "不應該送出任何 move_booking 請求").toHaveLength(0);
}

/** 用 MutationObserver 記錄手勢期間 data-drag-phase 曾經變成過哪些值(手勢很快,事後查不到中間狀態)。 */
async function startPhaseRecorder(page: Page): Promise<void> {
  await grid(page).evaluate((el) => {
    const w = window as unknown as { __e2ePhases?: string[] };
    w.__e2ePhases = [el.getAttribute("data-drag-phase") ?? ""];
    new MutationObserver(() => {
      const v = el.getAttribute("data-drag-phase") ?? "";
      if (w.__e2ePhases![w.__e2ePhases!.length - 1] !== v) w.__e2ePhases!.push(v);
    }).observe(el, { attributes: true, attributeFilter: ["data-drag-phase"] });
  });
}
async function recordedPhases(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __e2ePhases?: string[] }).__e2ePhases ?? []);
}

/** 共用的手機開頁:多人商家、375×667;回傳 page / cdp / move_booking 紀錄。 */
async function openMobile(
  browser: Browser,
  merchant: GestureMerchant = fixture.many,
  width = 375,
  height = 667,
): Promise<{
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  sent: Record<string, unknown>[];
}> {
  const context = await newMobileContext(browser, width, height);
  const page = await context.newPage();
  const sent = trackMoveBooking(page);
  await openDayGrid(page, merchant);
  const cdp = await context.newCDPSession(page);
  return { context, page, cdp, sent };
}

// =============================================================================================
// 手機組(375×667,觸控)
// =============================================================================================
test.describe("手機組:直接滑 = 捲動、長按才拖、短按開詳情(現況就該綠)", () => {
  test("T0 前提:375px 多人商家格線可以橫捲(也可以直捲);少人商家放得下不用橫捲(對照)", async ({
    browser,
  }) => {
    const { context, page } = await openMobile(browser);
    try {
      const s = await scrollState(page);
      expect(s.maxLeft, "多人商家 375px:格線應該可以橫向捲動").toBeGreaterThan(100);
      expect(s.maxTop, "多人商家 375px:格線應該可以直向捲動(26 格 > 70vh)").toBeGreaterThan(50);
    } finally {
      await context.close();
    }
    // 對照:同一個寬度,2 位服務人員(72 + 120×2 = 312px)放得下 ⇒ 不需要橫捲。證明上面的「可以橫捲」不是永遠成立。
    const few = await openMobile(browser, fixture.few);
    try {
      const s = await scrollState(few.page);
      expect(s.maxLeft, "少人商家 375px:放得下,不應該需要橫捲").toBeLessThanOrEqual(1);
    } finally {
      await few.context.close();
    }
  });

  test("T1 空白格上手指往左滑 160px → 格線往右捲;不開選單、沒殘影;正向對照:點一下才開選單", async ({
    browser,
  }) => {
    const { context, page, cdp, sent } = await openMobile(browser);
    try {
      await bringGridToTop(page);
      await setScroll(page, 0, 0);
      await startPhaseRecorder(page);
      // 第 2 位服務人員(整天沒預約)10:00 那一格:375px 下第 2 欄在 x ≈ 212~332,往左滑 160 還在畫面內。
      const cell = slotCell(page, fixture.many.staffIds[1] as string, 4);
      const from = await centerOf(cell);
      await expectHit(page, from, cell, "空白格");
      const before = await scrollState(page);

      await swipe(cdp, from, -160, 0);

      await expect
        .poll(async () => (await scrollState(page)).left - before.left, {
          message: "手指往左滑 160px,格線 scrollLeft 應該明顯變大(原生捲動)",
          timeout: 5_000,
        })
        .toBeGreaterThan(80);
      await page.waitForTimeout(500);
      await expect(page.getByRole("menu"), "滑動不應該打開格子選單").toHaveCount(0);
      expect(await recordedPhases(page), "空白格不是色塊,phase 應該一直是 idle").toEqual(["idle"]);
      await expectNoDragEffect(page, sent);

      // 正向對照:同一格點一下(不移動)→ 選單打開(證明上面的「選單 0」不是因為選單根本打不開)。
      await setScroll(page, 0, 0);
      await bringGridToTop(page);
      await cell.tap();
      await expect(page.getByRole("menu"), "點一下空白格應該打開選單").toHaveCount(1, {
        timeout: 5_000,
      });
    } finally {
      await context.close();
    }
  });

  test("T2 時間欄上手指往上滑 → 格線往下捲(scrollTop 變大),時間欄仍在左邊", async ({ browser }) => {
    const { context, page, cdp, sent } = await openMobile(browser);
    try {
      await bringGridToTop(page);
      await setScroll(page, 0, 0);
      // 11:00 那個時間標籤(第 6 格):格線頂端 + 名字列 36 + 180 ⇒ 375×667 畫面內。
      const label = timeLabel(page, 6);
      await expect(label).toHaveText("11:00");
      const from = await centerOf(label);
      await expectHit(page, from, label, "時間欄");
      const before = await scrollState(page);
      expect(before.maxTop, "前提:格線可以直向捲").toBeGreaterThan(150);

      await swipe(cdp, from, 0, -150);

      await expect
        .poll(async () => (await scrollState(page)).top - before.top, {
          message: "手指往上滑 150px,格線 scrollTop 應該明顯變大(原生捲動)",
          timeout: 5_000,
        })
        .toBeGreaterThan(60);
      // 時間欄是 sticky left:直向捲不影響它的 x。
      const gutterLeft = await grid(page).evaluate((el) => {
        const g = el.querySelector("[data-drag-time-gutter]")!.parentElement!;
        return g.getBoundingClientRect().left - (el.getBoundingClientRect().left + el.clientLeft);
      });
      expect(Math.abs(gutterLeft), "時間欄左緣應該貼著容器左緣").toBeLessThanOrEqual(1);
      await page.waitForTimeout(300);
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expectNoDragEffect(page, sent);
    } finally {
      await context.close();
    }
  });

  test("T3 P1 色塊上「立刻」往左滑(< 500ms)→ 不進拖拉、沒殘影、格線捲動、不打 RPC", async ({
    browser,
  }) => {
    const p1 = fixture.bookings.p1;
    const dbBefore = await readBooking(p1.id);
    const { context, page, cdp, sent } = await openMobile(browser);
    try {
      await bringGridToTop(page);
      await setScroll(page, 0, 0);
      await startPhaseRecorder(page);
      const block = blockOf(page, p1);
      await expect(block, "前提:P1 是可拖的色塊").toHaveClass(/cursor-grab/);
      const from = await centerOf(block);
      await expectHit(page, from, block, "P1 色塊");
      const before = await scrollState(page);

      // 立刻滑:touchStart 之後馬上連續 move,總共遠小於 500ms。
      const t0 = Date.now();
      await touchStart(cdp, from);
      for (let i = 1; i <= 8; i++) await touchMove(cdp, { x: from.x - i * 12, y: from.y });
      const elapsed = Date.now() - t0;
      // 手指還沒放開就先驗(放開後殘影本來就會消失)。
      await expect(grid(page), "短滑不應該進入 dragging").not.toHaveAttribute(
        "data-drag-phase",
        "dragging",
      );
      expect(await page.getByTestId("booking-drag-ghost").count(), "短滑不應該出現殘影").toBe(0);
      await touchEnd(cdp);
      expect(elapsed, "前提:這次滑動在長按門檻 500ms 之內完成").toBeLessThan(450);

      await expect
        .poll(async () => (await scrollState(page)).left - before.left, {
          message: "從色塊上立刻滑走,格線應該橫向捲動",
          timeout: 5_000,
        })
        .toBeGreaterThan(40);
      expect(await recordedPhases(page), "全程不應該出現 dragging").not.toContain("dragging");
      await expectNoDragEffect(page, sent);
      const dbAfter = await readBooking(p1.id);
      expect(dbAfter, "P1 資料庫不應該有任何變化").toEqual(dbBefore);
    } finally {
      await context.close();
    }
  });

  test("T4 P1 長按 700ms → 進拖拉、殘影浮起;手指小移 6px 不捲動;原位放開 → 不打 RPC", async ({
    browser,
  }) => {
    const p1 = fixture.bookings.p1;
    const dbBefore = await readBooking(p1.id);
    const { context, page, cdp, sent } = await openMobile(browser);
    try {
      await bringGridToTop(page);
      await setScroll(page, 0, 0);
      const block = blockOf(page, p1);
      const from = await centerOf(block);
      await expectHit(page, from, block, "P1 色塊");
      const before = await scrollState(page);

      await touchStart(cdp, from);
      await expect(grid(page)).toHaveAttribute("data-drag-phase", "pressing");
      await page.waitForTimeout(700);
      await expect(grid(page), "長按 500ms 之後應該進入 dragging").toHaveAttribute(
        "data-drag-phase",
        "dragging",
      );
      const ghost = page.getByTestId("booking-drag-ghost");
      await expect(ghost).toBeVisible();
      await expect(
        ghost.locator("> div").first(),
        "長按進入的拖拉,殘影要「浮起」(scale-[1.03])",
      ).toHaveClass(/scale-\[1\.03\]/);
      await expect(block).toHaveAttribute("data-drag-source", "true");
      for (let i = 1; i <= 3; i++) await touchMove(cdp, { x: from.x + i * 2, y: from.y });
      await page.waitForTimeout(200);
      expect((await scrollState(page)).left, "拖拉中手指移動不應該捲動格線").toBe(before.left);
      await touchEnd(cdp);

      await expectNoDragEffect(page, sent);
      expect(await readBooking(p1.id), "原位放開,P1 資料庫不應該有任何變化").toEqual(dbBefore);
    } finally {
      await context.close();
    }
  });

  test("T5 P1 長按 700ms 後拖到第 2 位服務人員(空的)放開 → 送出 move_booking,資料庫 staff_id = 第 2 位", async ({
    browser,
  }) => {
    const p1 = fixture.bookings.p1;
    const target = fixture.many.staffIds[1] as string;
    const targetName = fixture.many.staffNames[1] as string;
    const dbBefore = await readBooking(p1.id);
    expect(dbBefore.staffId, "前提:P1 目前在第 1 位服務人員").toBe(fixture.many.staffIds[0]);
    const { context, page, cdp, sent } = await openMobile(browser);
    try {
      await bringGridToTop(page);
      await setScroll(page, 0, 0);
      const block = blockOf(page, p1);
      const from = await centerOf(block);
      await expectHit(page, from, block, "P1 色塊");
      const col = await staffGrid(page, target).boundingBox();
      if (!col) throw new Error("量不到第 2 位服務人員欄");
      const toX = col.x + col.width / 2;

      await touchStart(cdp, from);
      await page.waitForTimeout(700);
      await expect(grid(page)).toHaveAttribute("data-drag-phase", "dragging");
      for (let i = 1; i <= 8; i++) {
        await touchMove(cdp, { x: from.x + ((toX - from.x) * i) / 8, y: from.y });
      }
      await expect(page.getByTestId("booking-drag-hint")).toHaveText(`轉派給 ${targetName}`);
      await expect(page.getByTestId(`staff-column-${target}`)).toHaveAttribute(
        "data-drop-target",
        "true",
      );
      await touchEnd(cdp);
      await expect(grid(page)).toHaveAttribute("data-drag-phase", "idle", {
        timeout: LOAD_TIMEOUT,
      });

      expect(sent, "應該剛好送出一次 move_booking").toHaveLength(1);
      expect(sent[0]!["p_target_staff_id"]).toBe(target);
      await expect
        .poll(async () => (await readBooking(p1.id)).staffId, {
          message: "資料庫 P1 的 staff_id 應該變成第 2 位服務人員",
          timeout: LOAD_TIMEOUT,
        })
        .toBe(target);
      const dbAfter = await readBooking(p1.id);
      expect(dbAfter.startAtMs, "時間不應該改變").toBe(dbBefore.startAtMs);
      expect(dbAfter.status).toBe("accepted");
    } finally {
      await context.close();
    }
  });

  test("T6 點一下 P2(已完成)→ 預約詳情打開", async ({ browser }) => {
    const p2 = fixture.bookings.p2;
    const { context, page, sent } = await openMobile(browser);
    try {
      const block = blockOf(page, p2);
      await expect(block, "前提:P2 是不可拖的色塊").toHaveClass(/cursor-default/);
      await block.tap();
      const layer = page.getByRole("dialog");
      await expect(layer.getByText("預約詳情")).toBeVisible({ timeout: LOAD_TIMEOUT });
      await expect(layer.getByText(p2.customerName).first()).toBeVisible({ timeout: LOAD_TIMEOUT });
      expect(sent).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  // T7 拆成兩條(每個寬度一條),其中一條紅了不會蓋掉另一條的結果。
  // 🔴 2026-10-01 批次 1 實跑:320px 這條**對著現況是紅的**,原因跟手勢 / 格線無關 —— 是格線**上方的週列**
  //    (「上一週 / 7 個日期鈕 / 下一週」,CalendarPage.tsx 週檢視那一段,HEAD 既有程式、不在未 commit 改動裡):
  //    320px 時 7 個日期鈕被擠到內寬約 9px,兩位數日期(27、28、29、30)的寬度 13px 塞不下,
  //    畫面上看起來是「27282930」黏成一串。375px 不會發生(e2e/mobile-overflow.spec.ts 只測 375,所以沒抓到)。
  //    批次 1 規定不改產品程式 ⇒ 不改成 skip、不放寬斷言。
  // 🔴 已知問題 #961:週列日期鈕在 320px 擠壓;修好後移除 test.fail。
  //    (主腦 2026-10-01 裁決:320px 這條標成 test.fail(),斷言一字不改。問題修好時它會變成「意外通過」而轉紅,
  //     提醒我們把這個標記拿掉——不是放寬斷言。375px 那條照常必須通過。)
  for (const [w, h] of [
    [375, 667],
    [320, 568],
  ] as const) {
    test(`T7 版面 ${w}px:行事曆週檢視(12 位服務人員)沒有橫向溢出;滑軌不存在`, async ({
      browser,
    }) => {
      // 已知問題 #961:週列日期鈕在 320px 擠壓;修好後移除 test.fail。
      test.fail(w === 320, "已知問題 #961:週列日期鈕在 320px 擠壓;修好後移除 test.fail");
      const { context, page } = await openMobile(browser, fixture.many, w, h);
      try {
        await expect(page.getByTestId("calendar-scroll-rail"), "手機不顯示滑軌").toHaveCount(0);
        // 正向對照:格線本身確實比畫面寬(溢出斷言之所以通過,是因為它被收在可橫捲的容器裡,不是因為內容太窄)。
        expect((await scrollState(page)).maxLeft).toBeGreaterThan(100);
        await assertNoHorizontalOverflow(page, `行事曆週檢視(${w}px,12 位服務人員)`);
      } finally {
        await context.close();
      }
    });
  }
});

// =============================================================================================
// 電腦組(1280×800)—— 批次 1 只有 D11
// =============================================================================================
test.describe("電腦組:固定欄回歸", () => {
  test("D11 捲到最右:時間欄貼容器左緣;捲到最下:名字列貼容器上緣;elementFromPoint 量到的是固定欄不是色塊", async ({
    page,
  }) => {
    await openDayGrid(page, fixture.many);
    // 格線放在畫面中間(頁首在上面,不會擋到量測點)。
    await grid(page).evaluate((el) => el.scrollIntoView({ block: "center" }));
    const s0 = await scrollState(page);
    expect(s0.maxLeft, "前提:1280px、12 位服務人員一定要橫捲").toBeGreaterThan(100);
    expect(s0.maxTop, "前提:26 格 > 70vh 一定要直捲").toBeGreaterThan(50);

    const edges = () =>
      grid(page).evaluate((el) => {
        const r = el.getBoundingClientRect();
        const gutter = el
          .querySelector("[data-drag-time-gutter]")!
          .parentElement!.getBoundingClientRect();
        const firstColumn = el.querySelector('[data-testid^="staff-column-"]')!;
        const header = (firstColumn.firstElementChild as HTMLElement).getBoundingClientRect();
        return {
          gutterOffset: gutter.left - (r.left + el.clientLeft),
          headerOffset: header.top - (r.top + el.clientTop),
        };
      });

    // ① 捲到最右:時間欄左緣 = 容器左緣(±1)
    await setScroll(page, s0.maxLeft, 0);
    expect((await scrollState(page)).left).toBe(s0.maxLeft);
    expect(
      Math.abs((await edges()).gutterOffset),
      "捲到最右之後,時間欄必須還貼在容器左緣",
    ).toBeLessThanOrEqual(1);

    // ② 捲到最下:名字列上緣 = 容器上緣(±1)
    await setScroll(page, 0, s0.maxTop);
    expect(
      Math.abs((await edges()).headerOffset),
      "捲到最下之後,名字列必須還貼在容器上緣",
    ).toBeLessThanOrEqual(1);

    // P1 在內容裡的位置(T5 會把它轉派到第 2 位,所以不寫死欄位,現場量)。
    const p1Block = blockOf(page, fixture.bookings.p1);
    await setScroll(page, 0, 0);
    const content = await page.evaluate(
      ([blockId]) => {
        const el = document.querySelector('[data-testid="calendar-day-grid"]') as HTMLElement;
        const r = el.getBoundingClientRect();
        const b = document
          .querySelector(`[data-testid="booking-block-${blockId}-main"]`)!
          .getBoundingClientRect();
        return {
          left: b.left - (r.left + el.clientLeft) + el.scrollLeft,
          top: b.top - (r.top + el.clientTop) + el.scrollTop,
        };
      },
      [fixture.bookings.p1.id],
    );
    const readGeo = () =>
      page.evaluate(
        ([blockId]) => {
          const b = document
            .querySelector(`[data-testid="booking-block-${blockId}-main"]`)!
            .getBoundingClientRect();
          const root = document.querySelector('[data-testid="calendar-day-grid"]')!;
          const g = root
            .querySelector("[data-drag-time-gutter]")!
            .parentElement!.getBoundingClientRect();
          const col = document
            .querySelector(`[data-testid="booking-block-${blockId}-main"]`)!
            .closest('[data-testid^="staff-column-"]') as HTMLElement;
          const header = (col.firstElementChild as HTMLElement).getBoundingClientRect();
          return {
            bLeft: b.left,
            bRight: b.right,
            bTop: b.top,
            bBottom: b.bottom,
            bMidX: b.left + b.width / 2,
            bMidY: b.top + b.height / 2,
            gRight: g.right,
            hBottom: header.bottom,
            headerText: (col.firstElementChild as HTMLElement).textContent ?? "",
          };
        },
        [fixture.bookings.p1.id],
      );
    const pointInfo = (x: number, y: number) =>
      page.evaluate(
        ([px, py]) => {
          const e = document.elementFromPoint(px as number, py as number);
          return {
            inBlock: !!e?.closest('[data-testid^="booking-block-"]'),
            inGrid: !!e?.closest('[data-testid="calendar-day-grid"]'),
            text: (e?.textContent ?? "").trim(),
          };
        },
        [x, y] as const,
      );

    // ③ 時間欄蓋住色塊:往右捲到 P1 左緣滑進時間欄底下 12px 處。
    await setScroll(page, Math.max(0, content.left - 12), 0);
    const geo = await readGeo();
    expect(geo.bLeft, "前提:P1 色塊左半段要真的滑進時間欄底下").toBeLessThan(geo.gRight - 20);
    const hitGutter = await pointInfo(geo.gRight - 8, geo.bMidY);
    expect(hitGutter.inGrid, "量測點必須在格線裡(不是被頁首蓋住)").toBe(true);
    expect(hitGutter.inBlock, "時間欄位置量到的不可以是色塊(時間欄 z-30 必須蓋住色塊 z-10)").toBe(
      false,
    );
    expect(hitGutter.text, "時間欄位置應該量到時間文字").toMatch(/^\d{2}:\d{2}$/);
    // 正向對照:同一個 y、時間欄右邊一點,量到的就是 P1 色塊(證明色塊真的在那一列)。
    await expectHit(
      page,
      { x: Math.min(geo.bRight - 6, geo.gRight + 20), y: geo.bMidY },
      p1Block,
      "時間欄右邊的 P1 色塊",
    );

    // ④ 名字列蓋住色塊:往下捲到 P1 上緣滑進名字列底下 20px 處。
    await setScroll(page, Math.max(0, content.left - 72 - 10), content.top - 20);
    const geo2 = await readGeo();
    expect(geo2.bTop, "前提:P1 色塊上緣要真的滑進名字列底下").toBeLessThan(geo2.hBottom - 6);
    const hitHeader = await pointInfo(geo2.bMidX, geo2.hBottom - 4);
    expect(hitHeader.inGrid, "量測點必須在格線裡(不是被頁首蓋住)").toBe(true);
    expect(hitHeader.inBlock, "名字列位置量到的不可以是色塊(名字列 z-20 必須蓋住色塊 z-10)").toBe(
      false,
    );
    expect(geo2.headerText, "前提:這一欄的名字列有服務人員名字").toContain(STAFF_NAME_PREFIX);
    expect(hitHeader.text, "名字列位置應該量到服務人員名字").toContain(STAFF_NAME_PREFIX);
    await expectHit(
      page,
      { x: geo2.bMidX, y: Math.min(geo2.bBottom - 4, geo2.hBottom + 8) },
      p1Block,
      "名字列下方的 P1 色塊",
    );
  });
});

// =============================================================================================
// 故障注入紀錄(2026-10-01,台北時間;見檔頭「故障注入」)
// =============================================================================================
// 注入 A:E2E_FAULT_INJECT=touch-action-none,只跑 T1|T2|T3 ⇒ 3 條全紅(下午 2:40 實跑),紅字:
//   T1  Error: 手指往左滑 160px,格線 scrollLeft 應該明顯變大(原生捲動)   Expected: > 80   Received: 0
//   T2  Error: 手指往上滑 150px,格線 scrollTop 應該明顯變大(原生捲動)    Expected: > 60   Received: 0
//   T3  Error: 從色塊上立刻滑走,格線應該橫向捲動                         Expected: > 40   Received: 0
//   不設變數重跑 ⇒ 回綠(注入只活在那一次的測試頁面,產品檔沒有任何改動)。
//
// 注入 B:E2E_FAULT_INJECT=sticky-off,只跑 D11 ⇒ 紅(下午 2:40 實跑),紅字:
//   D11 Error: 捲到最右之後,時間欄必須還貼在容器左緣   Expected: <= 1   Received: 402
//   (402 = 1512 − 1110,時間欄跟著內容整段捲走 = 2026-09-30 sticky 回歸的樣子)。不設變數重跑 ⇒ 回綠。
