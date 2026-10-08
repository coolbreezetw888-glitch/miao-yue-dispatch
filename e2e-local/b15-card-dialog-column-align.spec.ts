// 第 15 批(#1009):電腦版小卡窗(CardDialog)左右邊界對齊底下頁面的主要內容欄。本機 Supabase 專用
// (e2e-local 設定,loopback guard 生效,不碰正式庫)。規格書:.project/specs/小卡窗寬度對齊頁面內容欄-第15批.md
//
//   1. 全站 15 處 CardDialog 在 1280 / 1920 寬逐一打開:小卡窗 x / 寬 = 頁面容器扣掉左右內距的那一欄
//      (= 頁面裡內容卡片的左右邊界,使用者截圖的紅框);console 印「內容欄寬 / 小卡窗寬」對照表 + 截圖。
//   2. 拉動瀏覽器寬度(1280 → 900 → 1920 → 700):小卡窗跟著變。
//   3. 全頁層開著時:量測函式改對齊全頁層面板;行事曆頁內容欄量得到(行事曆本身沒有小卡窗,用量測函式驗)。
//   4. 全頁層(FullPageLayer)檢查(只量、不改):各頁內容欄 vs 全頁層寬,印在 console。
//   5. 手機 375:小卡窗位置 / 寬度跟改版前一樣(x=16、寬 343);確認窗 1280 仍 400 寬。
//   6. QA 打回(寬度「先寬後縮」):逐畫面記錄 offsetWidth / left,第 1 個畫面就是最終值、之後不變;
//      進場淡入動畫照跑(前幾個畫面透明度 < 1);拉視窗寬度後下一個畫面就到位(沒有 200ms 過渡)。
//
// 截圖存 B15_SHOTS(預設 test-results/b15-shots/;🔴 不寫進 .project/notes/ui-ref-2026-10-01/after/)。
//
// 執行:npx playwright test --config playwright.local.config.ts b15-card-dialog-column-align

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

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
const SHOTS = process.env["B15_SHOTS"] ?? "test-results/b15-shots";
const AGENT_NAME = "E2E第15批客服";
const MATERIAL_NAME = "E2E第15批料錢";
const MEMBER_NAME = "E2E第15批會員";
const LEAVE_TYPE_NAME = "E2E第15批假別";
const UNINVITED_STAFF_NAME = "E2E第15批未開通";

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
  must(
    "建立測試客服",
    (
      await svc
        .from("merchant_agents")
        .insert({
          merchant_id: m.merchantId,
          name: AGENT_NAME,
          phone: "0911000150",
          invited_email: `e2e-b15-agent-${fixture.runId}@example.test`,
          status: "invited",
        })
        .select("id")
        .single()
    ).data,
    null,
  );
  const item = await m.admin
    .from("material_cost_items")
    .insert({ merchant_id: m.merchantId, name: MATERIAL_NAME, amount: 300 })
    .select("id")
    .single();
  must("建立料錢品項", item.data, item.error);
  const flag = await svc
    .from("merchant_feature_flags")
    .upsert(
      { merchant_id: m.merchantId, feature_key: "material_cost_enabled", enabled: true },
      { onConflict: "merchant_id,feature_key" },
    )
    .select("id");
  must("開啟料錢成本功能", flag.data, flag.error);
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
  const leave = await svc
    .from("merchant_leave_types")
    .insert({ merchant_id: m.merchantId, name: LEAVE_TYPE_NAME })
    .select("id");
  must("建立假別", leave.data, leave.error);
  const staff = await m.admin
    .from("merchant_staff")
    .insert({ merchant_id: m.merchantId, name: UNINVITED_STAFF_NAME, phone: "0911000151" })
    .select("id");
  must("建立未開通服務人員", staff.data, staff.error);
  const perm = await svc
    .from("merchant_staff_permissions")
    .upsert(
      { staff_id: fixture.staffA.staffId, section_key: "staff_profile_edit", granted: true },
      { onConflict: "staff_id,section_key" },
    )
    .select("id");
  must("開服務人員 A 編輯個人資料權限", perm.data, perm.error);
  detailBooking = await adminCreateBooking(fixture, m, {
    staffId: fixture.staffA.staffId,
    time: "14:00",
    customerName: "E2E第15批詳情客",
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
  /** 頁面容器扣掉左右內距(= 內容欄)。 */
  left: number;
  width: number;
  /** 頁面容器 class 裡的 max-w-*(回報用)。 */
  maxW: string;
  /** 頁面裡第一張有框線的內容卡片(使用者截圖的紅框)。 */
  card: { left: number; width: number } | null;
}

/** 獨立量測(不用正式程式的函式):App 殼層 root 底下第一個子元素 = 頁面容器。 */
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

/** 直接呼叫正式程式的量測函式(Vite dev server 會直接提供原始碼模組)。 */
async function measureByApp(page: Page): Promise<{ center: number; width: number } | null> {
  // 路徑當參數傳進瀏覽器(不寫成字面值),TypeScript 才不會試著在 Node 端解析這個網址路徑。
  return page.evaluate(async (modulePath) => {
    const mod = (await import(/* @vite-ignore */ modulePath)) as {
      measureCardColumnAlign: (card: HTMLElement) => { center: number; width: number } | null;
    };
    return mod.measureCardColumnAlign(document.createElement("div"));
  }, "/src/components/patterns/cardDialogColumnAlign.ts");
}

interface Case {
  key: string;
  label: string;
  who: "admin" | "staffA";
  path: () => string;
  open: (page: Page) => Promise<Locator>;
}

function dialogByHeading(page: Page, name: string | RegExp): Locator {
  return page.getByRole("dialog").filter({ has: page.getByRole("heading", { name }) });
}

async function clickAndGet(page: Page, trigger: Locator, heading: string | RegExp) {
  await trigger.click({ timeout: LOAD_TIMEOUT });
  const dialog = dialogByHeading(page, heading);
  await expect(dialog).toBeVisible({ timeout: LOAD_TIMEOUT });
  return dialog;
}

async function openRowMenu(page: Page, rowText: string, item: string) {
  const row = page.locator("li").filter({ hasText: rowText });
  await row.getByRole("button", { name: "更多動作" }).click({ timeout: LOAD_TIMEOUT });
  await page.getByRole("menuitem", { name: item }).click();
}

const CASES: Case[] = [
  {
    key: "01-manage-edit-profile",
    label: "功能頁 > 編輯個人資料(ManagePage)",
    who: "admin",
    path: () => "/app/manage",
    open: (p) => clickAndGet(p, p.getByRole("button", { name: "編輯個人資料" }), "編輯個人資料"),
  },
  {
    key: "02-manage-change-login-email",
    label: "功能頁 > 更改登入信箱(ChangeLoginEmailDialog)",
    who: "admin",
    path: () => "/app/manage",
    open: (p) => clickAndGet(p, p.getByRole("button", { name: "更改登入信箱" }), "更改登入信箱"),
  },
  {
    key: "03-material-commission-confirm",
    label: "料錢成本 > 影響抽成開關確認(MaterialCostsPage:252)",
    who: "admin",
    path: () => "/app/material-costs",
    open: async (p) => {
      await p.locator("#material-cost-affects-commission").click({ timeout: LOAD_TIMEOUT });
      const d = p.getByRole("dialog");
      await expect(d).toBeVisible({ timeout: LOAD_TIMEOUT });
      return d;
    },
  },
  {
    key: "04-material-edit",
    label: "料錢成本 > 編輯品項(MaterialCostsPage:376)",
    who: "admin",
    path: () => "/app/material-costs",
    open: (p) =>
      clickAndGet(
        p,
        p.locator("li").filter({ hasText: MATERIAL_NAME }).getByRole("button", { name: "編輯" }),
        "編輯料錢成本品項",
      ),
  },
  {
    key: "05-payment-method-new",
    label: "付款方式 > 新增(PaymentMethodsPage)",
    who: "admin",
    path: () => "/app/payment-methods",
    open: (p) =>
      clickAndGet(p, p.getByRole("button", { name: "新增付款方式" }).first(), "新增付款方式"),
  },
  {
    key: "06-member-blacklist",
    label: "會員詳情 > 列入黑名單(MemberDetailPage)",
    who: "admin",
    path: () => `/app/members/${memberId}`,
    open: (p) => clickAndGet(p, p.getByRole("button", { name: "列入黑名單" }), "列入黑名單"),
  },
  {
    key: "07-member-points-redeem",
    label: "會員詳情 > 登記兌換點數(MemberPointsPanel:140)",
    who: "admin",
    path: () => `/app/members/${memberId}`,
    open: (p) => clickAndGet(p, p.getByRole("button", { name: "登記兌換" }), "登記兌換點數"),
  },
  {
    key: "08-member-points-adjust",
    label: "會員詳情 > 手動調整點數(MemberPointsPanel:269)",
    who: "admin",
    path: () => `/app/members/${memberId}`,
    open: (p) => clickAndGet(p, p.getByRole("button", { name: "手動調整" }), "手動調整點數"),
  },
  {
    key: "09-member-tier-new",
    label: "會員系統設定 > 新增會員等級(MemberSettingsPage)",
    who: "admin",
    path: () => "/app/member-settings",
    open: (p) => clickAndGet(p, p.getByRole("button", { name: "新增等級" }), "新增會員等級"),
  },
  {
    key: "10-leave-type-new",
    label: "假別設定 > 新增假別(LeaveTypesPage)",
    who: "admin",
    path: () => "/app/leave-types",
    open: (p) => clickAndGet(p, p.getByRole("button", { name: "新增假別" }).first(), "新增假別"),
  },
  {
    key: "11-leave-deduction-rule",
    label: "假別設定 > 扣款規則(LeaveDeductionRuleDialog)",
    who: "admin",
    path: () => "/app/leave-types",
    open: async (p) => {
      await openRowMenu(p, LEAVE_TYPE_NAME, "扣款規則");
      const d = dialogByHeading(p, /的扣款規則/);
      await expect(d).toBeVisible({ timeout: LOAD_TIMEOUT });
      return d;
    },
  },
  {
    key: "12-staff-suggest-login-email",
    label: "服務人員管理 > 修改登入信箱(AdminLoginEmailManager)",
    who: "admin",
    path: () => "/app/staff",
    open: (p) =>
      clickAndGet(
        p,
        p
          .locator("li")
          .filter({ hasText: fixture.staffA.name })
          .getByRole("button", { name: "修改登入信箱" }),
        /登入信箱/,
      ),
  },
  {
    key: "13-agent-edit",
    label: "客服管理 > 編輯客服資料(AgentListPage)",
    who: "admin",
    path: () => "/app/agents",
    open: (p) =>
      clickAndGet(
        p,
        p
          .locator("li")
          .filter({ hasText: AGENT_NAME })
          .getByRole("button", { name: "編輯", exact: true }),
        "編輯客服資料",
      ),
  },
  {
    key: "14-staff-invite-login",
    label: "服務人員管理 > 邀請開通登入(StaffListPage:995)",
    who: "admin",
    path: () => "/app/staff",
    open: async (p) => {
      // 第 20 批 #1015:「邀請登入」從 ⋯ 搬到卡片上的按鈕。
      await p
        .locator("li")
        .filter({ hasText: UNINVITED_STAFF_NAME })
        .getByRole("button", { name: "邀請登入", exact: true })
        .click({ timeout: LOAD_TIMEOUT });
      const d = dialogByHeading(p, /開通登入/);
      await expect(d).toBeVisible({ timeout: LOAD_TIMEOUT });
      return d;
    },
  },
  {
    key: "15-staff-portal-edit-profile",
    label: "服務人員端 > 編輯個人資料(EditMyStaffProfileDialog)",
    who: "staffA",
    path: () => "/app",
    open: (p) => clickAndGet(p, p.getByRole("button", { name: "編輯個人資料" }), "編輯個人資料"),
  },
];

const TABLE: string[] = [];

for (const width of [1280, 1920]) {
  test(`1. 15 處小卡窗 @${width}:左右邊界 = 頁面內容欄`, async ({ browser }) => {
    for (const c of CASES) {
      const page = await openAs(browser, c.who, width, 900, c.path());
      const recorder = recordRequestHosts(page);
      const dialog = await c.open(page);
      const box = await settledBox(dialog);
      const col = await pageColumn(page);
      const line =
        `${width} | ${c.key} | ${c.label} | 頁面容器 ${col.maxW} | 內容欄 x=${col.left.toFixed(1)} 寬=${col.width.toFixed(1)}` +
        ` | 內容卡片 ${col.card ? `x=${col.card.left.toFixed(1)} 寬=${col.card.width.toFixed(1)}` : "(無)"}` +
        ` | 小卡窗 x=${box.x.toFixed(1)} 寬=${box.width.toFixed(1)}`;
      TABLE.push(line);
      console.log(`[b15] ${line}`);
      await page.screenshot({ path: `${SHOTS}/${width}-${c.key}.png` });
      expect(Math.abs(box.x - col.left), `${c.key} 左邊界`).toBeLessThanOrEqual(1);
      expect(Math.abs(box.width - col.width), `${c.key} 寬度`).toBeLessThanOrEqual(1);
      if (col.card) {
        expect(Math.abs(box.x - col.card.left), `${c.key} 對齊內容卡片左緣`).toBeLessThanOrEqual(1);
        expect(Math.abs(box.width - col.card.width), `${c.key} 對齊內容卡片寬`).toBeLessThanOrEqual(
          1,
        );
      }
      // 第 21 批 #1020:小卡窗已沒有上方空白條(原本這裡驗「空白條寬 = 卡片寬」),改由
      // b21-1018-1022-small-fixes.spec.ts 驗「小卡窗沒有空白條」。
      expectOnlyLocalRequests(recorder);
      await page.context().close();
    }
  });
}

test("2. 拉動瀏覽器寬度:小卡窗跟著內容欄變", async ({ browser }) => {
  const page = await openAs(browser, "admin", 1280, 900, "/app/material-costs");
  const dialog = await CASES[3]!.open(page);
  for (const w of [1280, 900, 1920, 700]) {
    await page.setViewportSize({ width: w, height: 900 });
    const col = await pageColumn(page);
    await expect
      .poll(async () => {
        const b = await dialog.boundingBox();
        return b ? Math.abs(b.x - col.left) + Math.abs(b.width - col.width) : 999;
      })
      .toBeLessThanOrEqual(1.5);
    const b = (await dialog.boundingBox())!;
    console.log(
      `[b15] resize ${w}: 內容欄 x=${col.left} 寬=${col.width} / 小卡窗 x=${b.x} 寬=${b.width}`,
    );
    await page.screenshot({ path: `${SHOTS}/resize-${w}-material-edit.png` });
  }
  await page.context().close();
});

test("3. 全頁層開著 ⇒ 對齊全頁層面板;行事曆頁內容欄量得到", async ({ browser }) => {
  const page = await openAs(browser, "admin", 1280, 900, "/app/orders");
  await expect(page.getByRole("heading", { name: "訂單管理" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await page
    .getByRole("button", { name: new RegExp(detailBooking.customerName) })
    .click({ timeout: LOAD_TIMEOUT });
  const layer = page.getByRole("dialog");
  await expect(layer.getByText("預約詳情")).toBeVisible({ timeout: LOAD_TIMEOUT });
  const lb = await settledBox(layer);
  const m = await measureByApp(page);
  expect(m).not.toBeNull();
  expect(Math.abs(m!.width - lb.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(m!.center - (lb.x + lb.width / 2))).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(layer).toHaveCount(0);

  for (const w of [1280, 1920]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto("/app/calendar");
    await expect(page.locator("[data-app-content-root] > main")).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    const col = await pageColumn(page);
    const cal = await measureByApp(page);
    console.log(
      `[b15] 行事曆 ${w}: 內容欄 ${col.maxW} x=${col.left} 寬=${col.width} / 小卡窗會是 中心=${cal?.center} 寬=${cal?.width}`,
    );
    expect(cal).not.toBeNull();
    expect(Math.abs(cal!.width - col.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(cal!.center - (col.left + col.width / 2))).toBeLessThanOrEqual(1);
  }
  await page.context().close();
});

const FULL_PAGE_LAYER_PAGES = [
  "/app/calendar",
  "/app/orders",
  "/app/staff",
  "/app/service-items",
  "/app/members",
  `MEMBER`,
  "/app/member-settings",
  "/app/payroll-settings",
  "/app/leave-records",
];

test("4. 全頁層檢查(只量、不改):各頁內容欄寬 vs 全頁層寬", async ({ browser }) => {
  for (const w of [1280, 1920]) {
    const page = await openAs(browser, "admin", w, 900, "/app/manage");
    await expect(page.getByTestId("manage-page")).toBeVisible({ timeout: LOAD_TIMEOUT });
    for (const raw of FULL_PAGE_LAYER_PAGES) {
      const path = raw === "MEMBER" ? `/app/members/${memberId}` : raw;
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const col = await pageColumn(page);
      // 第 15 批當時的全頁層規則:min(畫面寬 − 32, 1152)(只是對照用的舊數字)。
      // 第 16 批 #1010 起全頁層也對齊內容欄,實際寬度改在 b16-full-page-layer-column-align.spec.ts 量。
      const vw = await page.evaluate(() => document.documentElement.clientWidth);
      const layer = Math.min(vw - 32, 1152);
      console.log(
        `[b15] 全頁層 ${w} | ${path} | 頁面容器 ${col.maxW} | 內容欄寬 ${col.width.toFixed(0)} | 全頁層寬 ${layer} | 差 ${(layer - col.width).toFixed(0)}`,
      );
    }
    await page.context().close();
  }
});

test("5. 手機 375 小卡窗不變;1280 確認窗仍 400", async ({ browser }) => {
  const page = await openAs(browser, "admin", 375, 812, "/app/material-costs");
  const card = await CASES[3]!.open(page);
  const cb = await settledBox(card);
  expect(Math.round(cb.x)).toBe(16);
  expect(Math.round(cb.width)).toBe(343);
  await page.screenshot({ path: `${SHOTS}/375-material-edit.png` });
  await page.context().close();

  const desk = await openAs(browser, "admin", 1280, 800, "/app/orders");
  await desk
    .getByRole("button", { name: new RegExp(detailBooking.customerName) })
    .click({ timeout: LOAD_TIMEOUT });
  const layer = desk.getByRole("dialog");
  await expect(layer.getByText("預約詳情")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await layer.getByRole("button", { name: "取消預約" }).click();
  const alert = desk.getByRole("alertdialog").filter({ hasText: "確定要取消這筆預約嗎？" });
  const ab = await settledBox(alert);
  expect(Math.round(ab.width)).toBe(400);
  await desk.screenshot({ path: `${SHOTS}/1280-confirm.png` });
  await desk.context().close();
  console.log(`[b15] 對照表\n${TABLE.join("\n")}`);
});

interface Frame {
  width: number;
  left: string;
  opacity: number;
}

/** 在瀏覽器裡掛一個記錄器:小卡窗一出現就每個畫面記一次 offsetWidth / left / 透明度,記 40 個畫面。 */
async function armFrameRecorder(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __b15Frames: Frame[] };
    w.__b15Frames = [];
    const findCard = () =>
      document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]');
    const tick = () => {
      const el = findCard();
      if (el) {
        const cs = getComputedStyle(el);
        w.__b15Frames.push({
          width: el.offsetWidth,
          left: cs.left,
          opacity: Number.parseFloat(cs.opacity),
        });
      }
      if (w.__b15Frames.length < 40) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function readFrames(page: Page): Promise<Frame[]> {
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __b15Frames: Frame[] }).__b15Frames.length),
    )
    .toBeGreaterThanOrEqual(40);
  return page.evaluate(() => (window as unknown as { __b15Frames: Frame[] }).__b15Frames);
}

for (const [width, idx, label] of [
  [1280, 3, "料錢成本編輯"],
  [1920, 9, "新增假別"],
] as const) {
  test(`6. 打開時寬度不會先寬後縮 @${width} ${label}`, async ({ browser }) => {
    const c = CASES[idx]!;
    const page = await openAs(browser, c.who, width, 900, c.path());
    // 先等頁面內容出來(open 裡會等觸發按鈕),再掛記錄器;記錄器只在小卡窗出現後才開始記。
    await page.waitForLoadState("networkidle");
    await armFrameRecorder(page);
    const dialog = await c.open(page);
    const frames = await readFrames(page);
    const col = await pageColumn(page);
    console.log(
      `[b15] 逐畫面 ${width} ${label}: 內容欄 ${col.width} | 寬 ${frames.map((f) => f.width).join(",")} | 透明度 ${frames
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
    // 進場淡入(animation)沒被取消:前幾個畫面還沒完全不透明。
    expect(frames[0]!.opacity).toBeLessThan(1);

    // 拉視窗寬度:改完後第 1 個畫面就到位,之後不變。
    await settledBox(dialog);
    // 拉到 700:內容欄寬 660(寬度、位置都要變,才驗得到過渡)。
    const nextW = 700;
    await page.setViewportSize({ width: nextW, height: 900 });
    await armFrameRecorder(page);
    const after = await readFrames(page);
    const col2 = await pageColumn(page);
    console.log(
      `[b15] 拉到 ${nextW}: 內容欄 ${col2.width} | 寬 ${after.map((f) => f.width).join(",")}`,
    );
    // 量測在 resize 後的下一個 frame 才跑 ⇒ 允許第 1 個畫面還是舊值,第 2 個起必須是最終值且不變(沒有 200ms 過渡)。
    for (const f of after.slice(1)) {
      expect(Math.abs(f.width - col2.width)).toBeLessThanOrEqual(1);
    }
    await page.context().close();
  });
}
