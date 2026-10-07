// 第 16 批(#1010):電腦版全頁層(FullPageLayer)寬度與水平位置也對齊底下頁面的主要內容欄。本機 Supabase 專用
// (e2e-local 設定,loopback guard 生效,不碰正式庫)。規格書:.project/specs/全頁層寬度對齊頁面內容欄-第16批.md
//
//   1. 全站全頁層使用處在 1280 / 1920 寬、從各自會被打開的頁面逐一打開:全頁層 x / 寬 = 頁面內容欄
//      (= 內容卡片左右邊界);console 印「頁面內容欄寬 / 全頁層寬」對照表 + 截圖。
//      另外量「有沒有擠壞」(橫向捲軸、文字被截斷、按鈕換行),只印出來、不判失敗(規格書:回報主腦決定)。
//   2. 拉動瀏覽器寬度(1280 → 900 → 1920 → 700):全頁層跟著變。
//   3. 打開瞬間不閃寬:逐畫面記錄 offsetWidth / left,第 1 個畫面就是最終值、之後不變;進場淡入照跑。
//   4. 全頁層上疊小卡窗:量測函式對齊全頁層外框(全頁層變窄後照樣成立);全頁層自己不會去對齊疊在上面的窗。
//   5. 手機 375:全頁層滿版(x=0、寬 375),跟改版前一樣。
//
// 截圖存 B16_SHOTS(預設 test-results/b16-shots/;🔴 不寫進 .project/notes/ui-ref-2026-10-01/after/)。
//
// 執行:npx playwright test --config playwright.local.config.ts b16-full-page-layer-column-align

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { primeStaffCurrentMerchant } from "../e2e/support/app-shell";
import { expectOnlyLocalRequests, recordRequestHosts } from "./support/request-guard";
import {
  adminCreateBooking,
  injectSession,
  serviceClient,
  setupLiveSyncFixture,
  teardownLiveSyncFixture,
  type CreatedBooking,
  type LiveSyncFixture,
} from "./support/staff-live-sync-fixture";

const LOAD_TIMEOUT = 20_000;
const SHOTS = process.env["B16_SHOTS"] ?? "test-results/b16-shots";
const MEMBER_NAME = "E2E第16批會員";

test.use({ timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "serial", timeout: 600_000 });

let fixture: LiveSyncFixture;
let memberId: string;
let detailBooking: CreatedBooking;

function must<T>(label: string, data: T | null, error: { message: string } | null): T {
  if (error || data === null) throw new Error(`${label}失敗:${error?.message ?? "沒有資料"}`);
  return data;
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  fixture = await setupLiveSyncFixture();
  const m = fixture.m1;
  const svc = serviceClient();
  // 服務人員 B 改成月薪制(本次 fixture 商家底下的測試資料),「薪資設定」全頁層才打得開;A 維持預設抽成制。
  const b = await svc
    .from("merchant_staff")
    .update({ compensation_type: "monthly_salary" })
    .eq("id", fixture.staffB.staffId)
    .eq("merchant_id", m.merchantId)
    .select("id");
  must("服務人員 B 改月薪制", b.data, b.error);
  const settings = await svc
    .from("merchant_member_settings")
    .upsert({ merchant_id: m.merchantId, points_feature_enabled: true })
    .select("merchant_id");
  must("開啟紅利點數", settings.data, settings.error);
  const member = await m.admin.rpc("create_member", {
    p_merchant_id: m.merchantId,
    p_name: MEMBER_NAME,
    p_phone: `09${fixture.runId.slice(-8)}`,
  });
  memberId = must("建立會員", member.data, member.error).id as string;
  detailBooking = await adminCreateBooking(fixture, m, {
    staffId: fixture.staffA.staffId,
    time: "14:00",
    customerName: "E2E第16批詳情客",
  });
});

test.afterAll(async () => {
  // 上面建的資料全掛在本次 fixture 的商家底下:teardown 先 SELECT 核對範圍,再刪商家(子表 cascade)、會員、帳號。
  if (fixture) await teardownLiveSyncFixture(fixture);
});

async function openAs(
  browser: Browser,
  who: "admin" | "staffA",
  width: number,
  height: number,
  path: string,
): Promise<Page> {
  const session =
    who === "admin"
      ? (await fixture.m1.admin.auth.getSession()).data.session
      : fixture.staffA.session;
  expect(session).not.toBeNull();
  const mobile = width < 768;
  const context = await browser.newContext({
    viewport: { width, height },
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
  if (who === "staffA") await primeStaffCurrentMerchant(page, LOAD_TIMEOUT);
  await page.goto(path);
  return page;
}

/** 等進場動畫結束、位置穩定後的框。 */
async function settledBox(locator: Locator) {
  let last = "";
  await expect
    .poll(
      async () => {
        const b = await locator.boundingBox();
        const now = JSON.stringify(b);
        const same = now === last;
        last = now;
        return same && b !== null;
      },
      { timeout: 5_000, intervals: [150] },
    )
    .toBe(true);
  return (await locator.boundingBox())!;
}

interface Column {
  left: number;
  width: number;
  maxW: string;
  card: { left: number; width: number } | null;
}

/** 獨立量測(不用正式程式的函式):App 殼層 root 底下第一個子元素 = 頁面容器,扣掉左右內距 = 內容欄。 */
async function pageColumn(page: Page): Promise<Column> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-app-content-root]")!;
    const main = root.firstElementChild as HTMLElement;
    const r = main.getBoundingClientRect();
    const cs = getComputedStyle(main);
    const pl = Number.parseFloat(cs.paddingLeft);
    const pr = Number.parseFloat(cs.paddingRight);
    let card: { left: number; width: number } | null = null;
    for (const el of Array.from(main.querySelectorAll<HTMLElement>("*"))) {
      const s = getComputedStyle(el);
      if (Number.parseFloat(s.borderLeftWidth) > 0 && Number.parseFloat(s.borderRightWidth) > 0) {
        const b = el.getBoundingClientRect();
        if (b.width > r.width / 2) {
          card = { left: b.left, width: b.width };
          break;
        }
      }
    }
    return {
      left: r.left + pl,
      width: r.width - pl - pr,
      maxW: main.className.split(" ").find((c) => c.startsWith("max-w-")) ?? "(無)",
      card,
    };
  });
}

/** 全頁層裡「擠壞」的跡象:只量、不判失敗(規格書 §要逐一檢查 2:有的話回報主腦)。 */
async function crampReport(layer: Locator): Promise<string[]> {
  return layer.evaluate((root) => {
    const issues: string[] = [];
    const name = (el: Element) => {
      const t = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
      const id = el.id ? `#${el.id}` : "";
      const tid = el.getAttribute("data-testid");
      return `${el.tagName.toLowerCase()}${id}${tid ? `[${tid}]` : ""}「${t}」`;
    };
    // 1. 橫向捲軸:任何可捲動的區塊內容比框寬。
    for (const el of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
      if (!(el instanceof HTMLElement) || el.offsetWidth === 0) continue;
      const cs = getComputedStyle(el);
      if (
        (cs.overflowX === "auto" || cs.overflowX === "scroll") &&
        el.scrollWidth > el.clientWidth + 1
      ) {
        issues.push(`橫向捲軸:${name(el)} 內容寬 ${el.scrollWidth} > 框 ${el.clientWidth}`);
      }
    }
    // 2. 文字被截斷(truncate / ellipsis 而且真的放不下)。
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      if (el.offsetWidth === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1) {
        issues.push(`文字被截斷:${name(el)}`);
      }
    }
    // 3. 按鈕文字換行:按鈕裡「看得到的文字」排成 2 行以上(只量文字節點;略過螢幕閱讀器專用的 sr-only 字、圖示)。
    for (const btn of Array.from(root.querySelectorAll<HTMLElement>("button"))) {
      if (btn.offsetWidth === 0) continue;
      const lines: number[] = [];
      const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const parent = n.parentElement;
        if (!parent || !(n.textContent ?? "").trim()) continue;
        if (parent.closest(".sr-only") || parent.offsetWidth <= 1) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const lh = Number.parseFloat(getComputedStyle(parent).fontSize) || 14;
        for (const r of Array.from(range.getClientRects())) {
          if (r.width === 0) continue;
          if (!lines.some((t) => Math.abs(t - r.top) < lh / 2)) lines.push(r.top);
        }
      }
      if (lines.length > 1) issues.push(`按鈕文字換行:${name(btn)}`);
    }
    // 4. 底部按鈕列換成兩排。
    const footer = root.querySelector("footer");
    if (footer) {
      const tops = new Set(
        Array.from(footer.querySelectorAll<HTMLElement>("button"))
          .filter((b) => b.offsetWidth > 0)
          .map((b) => Math.round(b.getBoundingClientRect().top)),
      );
      if (tops.size > 1) issues.push(`按鈕列換成 ${tops.size} 排`);
    }
    return issues;
  });
}

function layerByHeading(page: Page, name: string | RegExp): Locator {
  return page.getByRole("dialog").filter({ has: page.getByRole("heading", { name }) });
}

async function clickAndGet(page: Page, trigger: Locator, heading: string | RegExp) {
  await trigger.click({ timeout: LOAD_TIMEOUT });
  const layer = layerByHeading(page, heading);
  await expect(layer).toBeVisible({ timeout: LOAD_TIMEOUT });
  return layer;
}

async function openWeekView(page: Page) {
  await page
    .getByRole("radiogroup", { name: "檢視模式" })
    .getByRole("radio", { name: "週檢視" })
    .click({ timeout: LOAD_TIMEOUT });
}

interface Case {
  key: string;
  label: string;
  who: "admin" | "staffA";
  path: () => string;
  open: (page: Page) => Promise<Locator>;
}

const CASES: Case[] = [
  {
    key: "01-calendar-new-booking",
    label: "行事曆 > 新增預約(CalendarPage 建單表單)",
    who: "admin",
    path: () => `/app/calendar?date=${fixture.dateKey}`,
    open: (p) => clickAndGet(p, p.getByRole("button", { name: "新增預約" }).first(), "新增預約"),
  },
  {
    key: "02-calendar-booking-detail",
    label: "行事曆 > 預約詳情(BookingDetailDialog)",
    who: "admin",
    path: () => `/app/calendar?date=${fixture.dateKey}`,
    open: async (p) => {
      await openWeekView(p);
      return clickAndGet(
        p,
        p.getByTestId(`booking-block-${detailBooking.id}-main`).first(),
        "預約詳情",
      );
    },
  },
  {
    key: "03-orders-booking-detail",
    label: "訂單管理 > 預約詳情(BookingDetailDialog)",
    who: "admin",
    path: () => "/app/orders",
    open: (p) =>
      clickAndGet(
        p,
        p.getByRole("button", { name: new RegExp(detailBooking.customerName) }).first(),
        "預約詳情",
      ),
  },
  {
    key: "04-staff-edit",
    label: "服務人員管理 > 編輯服務人員(StaffFormDialog)",
    who: "admin",
    path: () => "/app/staff",
    open: (p) =>
      clickAndGet(
        p,
        p
          .locator("li")
          .filter({ hasText: fixture.staffA.name })
          .getByRole("button", { name: "編輯", exact: true }),
        "編輯服務人員",
      ),
  },
  {
    key: "05-staff-new",
    label: "服務人員管理 > 新增服務人員(StaffFormDialog)",
    who: "admin",
    path: () => "/app/staff",
    open: (p) =>
      clickAndGet(p, p.getByRole("button", { name: "新增服務人員" }).first(), "新增服務人員"),
  },
  {
    key: "06-service-item-new",
    label: "服務項目 > 新增服務項目(ServiceItemsPage)",
    who: "admin",
    path: () => "/app/service-items",
    open: (p) =>
      clickAndGet(p, p.getByRole("button", { name: "新增服務項目" }).first(), "新增服務項目"),
  },
  {
    key: "07-members-new",
    label: "會員管理 > 新增會員(MembersListPage)",
    who: "admin",
    path: () => "/app/members",
    open: (p) => clickAndGet(p, p.getByRole("button", { name: "新增會員" }).first(), "新增會員"),
  },
  {
    key: "08-member-edit",
    label: "會員詳情 > 編輯會員資料(MemberDetailPage)",
    who: "admin",
    path: () => `/app/members/${memberId}`,
    open: (p) =>
      clickAndGet(p, p.getByRole("button", { name: "編輯", exact: true }).first(), "編輯會員資料"),
  },
  {
    key: "09-member-policy-preview",
    label: "會員系統設定 > 會員政策預覽(MemberSettingsPage)",
    who: "admin",
    path: () => "/app/member-settings",
    open: (p) => clickAndGet(p, p.getByRole("button", { name: "預覽效果" }).first(), /會員政策/),
  },
  {
    key: "10-payroll-commission",
    label: "抽成與薪資設定 > 服務人員抽成設定(PayrollSettingsPage:416)",
    who: "admin",
    path: () => "/app/payroll-settings",
    open: (p) =>
      clickAndGet(
        p,
        p
          .locator("li")
          .filter({ hasText: fixture.staffA.name })
          .getByRole("button", { name: "編輯", exact: true }),
        /的抽成設定/,
      ),
  },
  {
    key: "11-payroll-salary",
    label: "抽成與薪資設定 > 服務人員薪資設定(PayrollSettingsPage:769)",
    who: "admin",
    path: () => "/app/payroll-settings",
    open: (p) =>
      clickAndGet(
        p,
        p
          .locator("li")
          .filter({ hasText: fixture.staffB.name })
          .getByRole("button", { name: "編輯", exact: true }),
        /的薪資設定/,
      ),
  },
  {
    key: "12-leave-record-new",
    label: "請假紀錄 > 登記請假(LeaveRecordsPage)",
    who: "admin",
    path: () => "/app/leave-records",
    open: (p) => clickAndGet(p, p.getByRole("button", { name: "登記請假" }).first(), "登記請假"),
  },
  {
    key: "13-staff-portal-booking-detail",
    label: "服務人員端行事曆 > 預約詳情(MyBookingDetailDialog)",
    who: "staffA",
    path: () => "/app/calendar",
    open: (p) =>
      clickAndGet(p, p.getByText(detailBooking.customerName, { exact: true }).first(), "預約詳情"),
  },
];

const TABLE: string[] = [];
const CRAMP: string[] = [];

for (const width of [1280, 1920]) {
  test(`1. 全頁層 @${width}:左右邊界 = 頁面內容欄;擠壞檢查`, async ({ browser }) => {
    for (const c of CASES) {
      const page = await openAs(browser, c.who, width, 900, c.path());
      const recorder = recordRequestHosts(page);
      const layer = await c.open(page);
      const box = await settledBox(layer);
      const col = await pageColumn(page);
      const line =
        `${width} | ${c.key} | ${c.label} | 頁面容器 ${col.maxW} | 內容欄 x=${col.left.toFixed(1)} 寬=${col.width.toFixed(1)}` +
        ` | 內容卡片 ${col.card ? `x=${col.card.left.toFixed(1)} 寬=${col.card.width.toFixed(1)}` : "(無)"}` +
        ` | 全頁層 x=${box.x.toFixed(1)} 寬=${box.width.toFixed(1)}`;
      TABLE.push(line);
      console.log(`[b16] ${line}`);
      const cramp = await crampReport(layer);
      for (const issue of cramp) {
        const l = `${width} | ${c.key} | ${issue}`;
        CRAMP.push(l);
        console.log(`[b16][擠壞?] ${l}`);
      }
      await page.screenshot({ path: `${SHOTS}/${width}-${c.key}.png` });
      expect(Math.abs(box.x - col.left), `${c.key} 左邊界`).toBeLessThanOrEqual(1);
      expect(Math.abs(box.width - col.width), `${c.key} 寬度`).toBeLessThanOrEqual(1);
      if (col.card) {
        expect(Math.abs(box.x - col.card.left), `${c.key} 對齊內容卡片左緣`).toBeLessThanOrEqual(1);
        expect(Math.abs(box.width - col.card.width), `${c.key} 對齊內容卡片寬`).toBeLessThanOrEqual(
          1,
        );
      }
      // 不變的部分:上緣 56、下緣離底 18;空白條寬 = 面板寬。
      expect(Math.round(box.y), `${c.key} 上緣`).toBe(56);
      expect(Math.round(900 - (box.y + box.height)), `${c.key} 下緣`).toBe(18);
      const strip = page.locator("[data-overlay-dismiss-strip]").last();
      const sb = await settledBox(strip);
      expect(Math.abs(sb.width - box.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(sb.x - box.x)).toBeLessThanOrEqual(1);
      expectOnlyLocalRequests(recorder);
      await page.context().close();
    }
  });
}

test("2. 拉動瀏覽器寬度:全頁層跟著內容欄變", async ({ browser }) => {
  for (const idx of [0, 7]) {
    const c = CASES[idx]!;
    const page = await openAs(browser, c.who, 1280, 900, c.path());
    const layer = await c.open(page);
    for (const w of [1280, 900, 1920, 700]) {
      await page.setViewportSize({ width: w, height: 900 });
      const col = await pageColumn(page);
      await expect
        .poll(async () => {
          const b = await layer.boundingBox();
          return b ? Math.abs(b.x - col.left) + Math.abs(b.width - col.width) : 999;
        })
        .toBeLessThanOrEqual(1.5);
      const b = (await layer.boundingBox())!;
      console.log(
        `[b16] resize ${c.key} ${w}: 內容欄 x=${col.left} 寬=${col.width} / 全頁層 x=${b.x} 寬=${b.width}`,
      );
      await page.screenshot({ path: `${SHOTS}/resize-${w}-${c.key}.png` });
    }
    await page.context().close();
  }
});

interface Frame {
  width: number;
  left: string;
  opacity: number;
}

/** 全頁層一出現就每個畫面記一次 offsetWidth / left / 透明度,記 40 個畫面。 */
async function armFrameRecorder(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __b16Frames: Frame[] };
    w.__b16Frames = [];
    const tick = () => {
      const el = document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]');
      if (el) {
        const cs = getComputedStyle(el);
        w.__b16Frames.push({
          width: el.offsetWidth,
          left: cs.left,
          opacity: Number.parseFloat(cs.opacity),
        });
      }
      if (w.__b16Frames.length < 40) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function readFrames(page: Page): Promise<Frame[]> {
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __b16Frames: Frame[] }).__b16Frames.length),
    )
    .toBeGreaterThanOrEqual(40);
  return page.evaluate(() => (window as unknown as { __b16Frames: Frame[] }).__b16Frames);
}

for (const [width, idx, label] of [
  [1280, 7, "會員詳情 > 編輯會員資料(3xl)"],
  [1920, 3, "服務人員管理 > 編輯服務人員(4xl)"],
  [1280, 2, "訂單管理 > 預約詳情(6xl)"],
] as const) {
  test(`3. 打開時寬度不會先寬後縮 @${width} ${label}`, async ({ browser }) => {
    const c = CASES[idx]!;
    const page = await openAs(browser, c.who, width, 900, c.path());
    await page.waitForLoadState("networkidle");
    await armFrameRecorder(page);
    const layer = await c.open(page);
    const frames = await readFrames(page);
    const col = await pageColumn(page);
    console.log(
      `[b16] 逐畫面 ${width} ${label}: 內容欄 ${col.width} | 寬 ${frames.map((f) => f.width).join(",")} | 透明度 ${frames
        .slice(0, 12)
        .map((f) => f.opacity.toFixed(2))
        .join(",")}`,
    );
    expect(Math.abs(frames[0]!.width - col.width), "第 1 個畫面就是最終寬度").toBeLessThanOrEqual(
      1,
    );
    for (const f of frames) {
      expect(f.width).toBe(frames[0]!.width);
      expect(f.left).toBe(frames[0]!.left);
    }
    // 進場淡入(animation)沒被取消。
    expect(frames[0]!.opacity).toBeLessThan(1);

    // 拉視窗寬度:第 2 個畫面起就是最終值(沒有過渡動畫)。
    await settledBox(layer);
    await page.setViewportSize({ width: 700, height: 900 });
    await armFrameRecorder(page);
    const after = await readFrames(page);
    const col2 = await pageColumn(page);
    console.log(`[b16] 拉到 700: 內容欄 ${col2.width} | 寬 ${after.map((f) => f.width).join(",")}`);
    for (const f of after.slice(1)) {
      expect(Math.abs(f.width - col2.width)).toBeLessThanOrEqual(1);
    }
    await page.context().close();
  });
}

test("4. 全頁層上疊小卡窗 ⇒ 小卡窗對齊全頁層外框;全頁層不會反過來對齊上面的窗", async ({
  browser,
}) => {
  // 3xl 頁面(會員詳情,全頁層變窄 728)開全頁層,再用正式程式的量測函式算「疊在上面的小卡窗」該在哪。
  const c = CASES[7]!;
  const page = await openAs(browser, c.who, 1280, 900, c.path());
  const layer = await c.open(page);
  const lb = await settledBox(layer);
  const col = await pageColumn(page);
  expect(Math.abs(lb.width - col.width)).toBeLessThanOrEqual(1);
  const result = await page.evaluate(async (modulePath) => {
    const mod = (await import(/* @vite-ignore */ modulePath)) as {
      measureCardColumnAlign: (card: HTMLElement) => { center: number; width: number } | null;
    };
    // 模擬疊在上面的小卡窗:Radix 每層各自 portal 到 body 尾端 ⇒ 後開的接在後面。
    const card = document.createElement("div");
    card.setAttribute("role", "dialog");
    card.setAttribute("data-state", "open");
    card.style.cssText = "position:fixed;left:0;top:0;width:400px;height:100px;";
    document.body.append(card);
    const onCard = mod.measureCardColumnAlign(card);
    // 全頁層自己重量時:上面那個窗不能算「底下」⇒ 仍然對齊頁面內容欄。
    const panel = document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]')!;
    const onPanel = mod.measureCardColumnAlign(panel);
    card.remove();
    return { onCard, onPanel };
  }, "/src/components/patterns/cardDialogColumnAlign.ts");
  console.log(
    `[b16] 疊小卡窗:全頁層 x=${lb.x} 寬=${lb.width} / 小卡窗會是 中心=${result.onCard?.center} 寬=${result.onCard?.width} / 全頁層重量 中心=${result.onPanel?.center} 寬=${result.onPanel?.width}`,
  );
  expect(result.onCard).not.toBeNull();
  expect(Math.abs(result.onCard!.width - lb.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(result.onCard!.center - (lb.x + lb.width / 2))).toBeLessThanOrEqual(1);
  expect(result.onPanel).not.toBeNull();
  expect(Math.abs(result.onPanel!.width - col.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(result.onPanel!.center - (col.left + col.width / 2))).toBeLessThanOrEqual(1);

  // 真的疊一層(確認窗是 400 寬的 CardAlertDialog,不受影響):預約詳情 → 取消預約。
  const desk = await openAs(browser, "admin", 1280, 900, CASES[2]!.path());
  const detail = await CASES[2]!.open(desk);
  const db = await settledBox(detail);
  await detail.getByRole("button", { name: "取消預約" }).click();
  const alert = desk.getByRole("alertdialog").filter({ hasText: "確定要取消這筆預約嗎？" });
  const ab = await settledBox(alert);
  expect(Math.round(ab.width)).toBe(400);
  // 全頁層在確認窗打開後不會跑位(確認窗開著時底下被 aria-hidden,改用 CSS 選擇器找面板)。
  const db2 = await settledBox(desk.locator('[role="dialog"][data-state="open"]').first());
  expect(Math.abs(db2.x - db.x) + Math.abs(db2.width - db.width)).toBeLessThanOrEqual(1);
  await desk.screenshot({ path: `${SHOTS}/1280-detail-with-confirm.png` });
  await desk.context().close();
  await page.context().close();
});

test("5. 手機 375:全頁層滿版不變", async ({ browser }) => {
  for (const idx of [0, 2, 7]) {
    const c = CASES[idx]!;
    const page = await openAs(browser, c.who, 375, 812, c.path());
    const layer = await c.open(page);
    const box = await settledBox(layer);
    expect(Math.round(box.x), `${c.key} x`).toBe(0);
    expect(Math.round(box.y), `${c.key} y`).toBe(0);
    expect(Math.round(box.width), `${c.key} 寬`).toBe(375);
    expect(Math.round(box.height), `${c.key} 高`).toBe(812);
    await page.screenshot({ path: `${SHOTS}/375-${c.key}.png` });
    await page.context().close();
  }
  console.log(`[b16] 對照表\n${TABLE.join("\n")}`);
  console.log(`[b16] 擠壞檢查(${CRAMP.length} 筆)\n${CRAMP.join("\n")}`);
});
