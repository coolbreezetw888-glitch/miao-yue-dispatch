// SPECS-INDEX #1012(第 18 批):時間軸預約卡片整張填色 + 白字;時間標籤左上半透明白底深色字;
// 姓名粗體、在虛線下方剩餘空間垂直 + 水平置中;追加:卡片之間留間隔(左右各 3px、前後相連 3px)。
// #1017(第 20 批):虛線改在卡片**垂直正中間**(50%),上半時間標籤靠左上、下半姓名上下左右置中;
//   每張三層卡片量「虛線中心 ÷ 卡片高度」,誤差 ≤ 1px;時間標籤不能被裁切、不能壓到虛線。
//   fixture 的服務項目一格 30 分鐘、做不出真的 45 分鐘單 ⇒ 45 分鐘高度用一小時卡複製一份、
//   把高度改成 45 分鐘卡實際畫出的 42px 來量(同一個元件、同一組 class,只差高度)。
// 執行:`npm run test:e2e:local -- b18-timeline-filled-cards`(只連本機 Docker Supabase)。
//
//   M1 商家端 1280 / 375:半小時 / 一小時 / 兩小時卡片、待確認 / 已確認 / 已完成三種狀態色(已取消的單
//      時間軸本來就不顯示,實際色碼由 vitest 驗),協助卡;相鄰兩位服務人員之間的間隔、前後相連的上下間隔;
//      點卡片照樣開預約詳情(手機寬度也點)
//   M2 服務人員端 1280 / 375:同一套外觀與間隔;點卡片照樣開詳情
//
// fixture 沿用 e2e-local/support/staff-live-sync-fixture.ts(一店 A / B、別家店 E),teardown 一樣三段核對。
// 截圖存 B18_SHOTS(預設 test-results/b18-shots/;🔴 不寫進 .project/notes/ui-ref-2026-10-01/after/)。
//
// 用語:一律「服務人員」。
import { mkdirSync } from "node:fs";

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import type { Session } from "@supabase/supabase-js";

import { primeStaffCurrentMerchant } from "../e2e/support/app-shell";
import { getCurrentMerchantStorageKey } from "../src/modules/merchant/constants";
import { buildTaipeiIso } from "../src/modules/booking/dateUtils";
import { DEFAULT_BOOKING_STATUS_COLORS } from "../src/modules/booking/types";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";
import {
  adminRpc,
  injectSession,
  setupLiveSyncFixture,
  teardownLiveSyncFixture,
  type LiveSyncFixture,
} from "./support/staff-live-sync-fixture";

const LOAD_TIMEOUT = 20_000;
const SHOTS = process.env["B18_SHOTS"] ?? "test-results/b18-shots";
const WHITE_INK = "rgb(255, 255, 255)";
const LABEL_BG = "rgba(255, 255, 255, 0.75)";
const LABEL_INK = "rgb(17, 24, 39)";

test.describe.configure({ mode: "serial", timeout: 180_000 });

const hexToRgb = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
};

let fixture: LiveSyncFixture;
let setupFailed = false;
let adminSessionM1: Session;
const recorders: RequestRecorder[] = [];
const contexts: BrowserContext[] = [];
const pageErrors: string[] = [];

interface Card {
  id: string;
  name: string;
  time: string;
  minutes: number;
  status: "pending_confirmation" | "accepted" | "completed" | "cancelled";
  staff: "A" | "B";
  assistantA?: boolean;
}

/** 卡片配置:A 欄 09:00 起前後相連三張(半小時待確認 / 一小時已確認 / 兩小時已完成),
 *  B 欄同一時段兩小時待確認(跟 A 欄左右相鄰),B 13:00 一小時、A 當協助;另一張已取消。 */
const CARDS: Card[] = [
  {
    id: "",
    name: "王半時",
    time: "09:00",
    minutes: 30,
    status: "pending_confirmation",
    staff: "A",
  },
  { id: "", name: "李一時", time: "09:30", minutes: 60, status: "accepted", staff: "A" },
  {
    id: "",
    name: "陳兩時",
    time: "10:30",
    minutes: 120,
    status: "completed",
    staff: "A",
  },
  { id: "", name: "林取消", time: "12:30", minutes: 30, status: "cancelled", staff: "A" },
  {
    id: "",
    name: "周隔壁欄",
    time: "09:00",
    minutes: 120,
    status: "pending_confirmation",
    staff: "B",
  },
  {
    id: "",
    name: "張協助",
    time: "13:00",
    minutes: 60,
    status: "accepted",
    staff: "B",
    assistantA: true,
  },
];
const card = (name: string) => CARDS.find((c) => c.name === name)!;
const statusRgb = (s: Card["status"]) =>
  hexToRgb(
    {
      pending_confirmation: DEFAULT_BOOKING_STATUS_COLORS.pendingConfirmation,
      accepted: DEFAULT_BOOKING_STATUS_COLORS.accepted,
      completed: DEFAULT_BOOKING_STATUS_COLORS.completed,
      cancelled: DEFAULT_BOOKING_STATUS_COLORS.cancelled,
    }[s],
  );

async function createCards(f: LiveSyncFixture): Promise<void> {
  const [notes, customerNotes, address, phone] = f.secrets as [string, string, string, string];
  for (const c of CARDS) {
    const res = await f.m1.admin.rpc("create_booking", {
      p_merchant_id: f.m1.merchantId,
      p_staff_id: c.staff === "A" ? f.staffA.staffId : f.staffB.staffId,
      p_service_items: [
        { service_item_id: f.m1.serviceItemId, quantity: c.minutes / 30, unit_price: 500 },
      ],
      p_start_at: buildTaipeiIso(f.dateKey, c.time),
      p_customer_name: c.name,
      p_customer_phone: phone,
      p_notes: notes,
      p_customer_notes: customerNotes,
      p_customer_address: address,
      p_assistant_staff_ids: c.assistantA ? [f.staffA.staffId] : [],
      p_payment_method_id: f.m1.paymentMethodId,
    });
    if (res.error || !res.data) throw new Error(`建立「${c.name}」失敗:${res.error?.message}`);
    c.id = (res.data as { id: string }).id;
    if (c.status === "accepted" || c.status === "completed") {
      await adminRpc(f.m1, "confirm_booking", { p_booking_id: c.id });
    }
    if (c.status === "completed") await adminRpc(f.m1, "complete_booking", { p_booking_id: c.id });
    if (c.status === "cancelled") await adminRpc(f.m1, "cancel_booking", { p_booking_id: c.id });
  }
}

async function newPage(browser: Browser, width: number): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
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

async function openMerchantCalendar(p: Page): Promise<void> {
  await injectSession(p, adminSessionM1);
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

async function openStaffTimeline(p: Page): Promise<void> {
  await injectSession(p, fixture.staffA.session);
  await primeStaffCurrentMerchant(p, LOAD_TIMEOUT);
  await p.goto("/app/calendar");
  await expect(p.getByText(`${fixture.dateKey} 的預約`)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await p.getByRole("button", { name: "時間軸格線" }).click();
  await expect(p.getByTestId("my-timeline-grid")).toBeVisible({ timeout: LOAD_TIMEOUT });
}

interface CardLook {
  bg: string;
  color: string;
  borderLeftWidth: string;
  borderLeftColor: string;
  labelBg: string;
  labelColor: string;
  nameWeight: string;
  layout: string | null;
  dividerColor: string | null;
  dividerStyle: string | null;
  /** 姓名中心 與「虛線下方(或整張)剩餘空間」中心 的垂直 / 水平差距(px) */
  nameDy: number;
  nameDx: number;
  /** #1017:卡片畫出來的高度(px) */
  cardH: number;
  /** #1017:虛線中心離卡片上緣的距離(px);沒有虛線 = null */
  dividerY: number | null;
  /** #1017:時間標籤上緣 / 下緣離卡片上緣的距離(px) */
  labelTop: number;
  labelBottom: number;
  /** #1017:時間標籤有沒有被上半部裁切(內容高 > 可見高) */
  labelClipped: boolean;
}

/** 讀一張卡片的外觀,並量姓名有沒有在剩餘空間正中間。 */
async function readCard(block: Locator): Promise<CardLook> {
  return block.evaluate((el) => {
    const cs = getComputedStyle(el);
    const label = el.querySelector<HTMLElement>("[data-booking-block-time]")!;
    const name = el.querySelector<HTMLElement>("[data-booking-block-name]")!;
    const divider = el.querySelector<HTMLElement>("[data-booking-block-divider]");
    const root = el.querySelector<HTMLElement>("[data-booking-block-layout]")!;
    const lcs = getComputedStyle(label);
    const nameBox = name.parentElement!.getBoundingClientRect(); // 置中用的那個區塊
    const n = name.getBoundingClientRect();
    const card = el.getBoundingClientRect();
    const d = divider?.getBoundingClientRect();
    const l = label.getBoundingClientRect();
    const top = label.parentElement!;
    return {
      cardH: card.height,
      dividerY: d ? d.top + d.height / 2 - card.top : null,
      labelTop: l.top - card.top,
      labelBottom: l.bottom - card.top,
      labelClipped: top.getBoundingClientRect().height + 0.5 < l.height,
      bg: cs.backgroundColor,
      color: cs.color,
      borderLeftWidth: cs.borderLeftWidth,
      borderLeftColor: cs.borderLeftColor,
      labelBg: lcs.backgroundColor,
      labelColor: lcs.color,
      nameWeight: getComputedStyle(name).fontWeight,
      layout: root.getAttribute("data-booking-block-layout"),
      dividerColor: divider ? getComputedStyle(divider).borderTopColor : null,
      dividerStyle: divider ? getComputedStyle(divider).borderTopStyle : null,
      nameDy: Math.abs(n.top + n.height / 2 - (nameBox.top + nameBox.height / 2)),
      nameDx: Math.abs(n.left + n.width / 2 - (nameBox.left + nameBox.width / 2)),
    };
  });
}

function expectFilledLook(look: CardLook, c: Card, layout: "stacked" | "inline") {
  expect(look.bg, `${c.name} 底色 = 狀態色原色`).toBe(statusRgb(c.status));
  expect(look.color, `${c.name} 白字`).toBe(WHITE_INK);
  expect(look.borderLeftWidth).toBe("4px");
  expect(look.borderLeftColor, `${c.name} 左色條比底色亮`).not.toBe(look.bg);
  expect(look.labelBg, `${c.name} 時間標籤固定半透明白底`).toBe(LABEL_BG);
  expect(look.labelColor, `${c.name} 時間標籤深色字`).toBe(LABEL_INK);
  expect(Number(look.nameWeight), `${c.name} 姓名粗體`).toBeGreaterThanOrEqual(700);
  expect(look.layout).toBe(layout);
  if (layout === "stacked") {
    expect(look.dividerStyle).toBe("dashed");
    expect(look.dividerColor).toBe("rgba(255, 255, 255, 0.6)");
    expectDividerCentered(look, c.name);
  } else {
    expect(look.dividerColor).toBeNull();
  }
  expect(look.nameDy, `${c.name} 姓名垂直置中`).toBeLessThanOrEqual(1.5);
  expect(look.nameDx, `${c.name} 姓名水平置中`).toBeLessThanOrEqual(1.5);
}

/** #1017:虛線在卡片垂直正中間(誤差 ≤ 1px);時間標籤在上半部、沒被裁切、沒壓到虛線。 */
function expectDividerCentered(look: CardLook, label: string) {
  const y = look.dividerY!;
  const pct = (y / look.cardH) * 100;
  console.log(
    `[#1017] ${label}:卡高 ${look.cardH.toFixed(1)}px、虛線中心 ${y.toFixed(2)}px = ${pct.toFixed(1)}%;` +
      `時間標籤 ${look.labelTop.toFixed(1)}~${look.labelBottom.toFixed(1)}px`,
  );
  expect(Math.abs(y - look.cardH / 2), `${label} 虛線在正中間`).toBeLessThanOrEqual(1);
  expect(look.labelClipped, `${label} 時間標籤沒被裁切`).toBe(false);
  expect(look.labelTop, `${label} 時間標籤在卡片內`).toBeGreaterThanOrEqual(0);
  expect(look.labelBottom, `${label} 時間標籤在虛線上方`).toBeLessThanOrEqual(y);
}

/** #1017:把一張三層卡片複製一份、高度改成 heightPx,量完就拿掉(45 分鐘卡做不出真的單)。 */
async function readCardAtHeight(block: Locator, heightPx: number): Promise<CardLook> {
  const marker = `b18-probe-${heightPx}`;
  await block.evaluate(
    (el, [h, m]) => {
      const clone = el.cloneNode(true) as HTMLElement;
      clone.style.height = `${h}px`;
      clone.removeAttribute("data-testid");
      clone.setAttribute("data-b18-probe", m as string);
      clone.style.pointerEvents = "none";
      el.parentElement!.appendChild(clone);
    },
    [heightPx, marker] as [number, string],
  );
  const probe = block.page().locator(`[data-b18-probe="${marker}"]`);
  const look = await readCard(probe);
  await probe.evaluate((el) => el.remove());
  return look;
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  try {
    mkdirSync(SHOTS, { recursive: true });
    fixture = await setupLiveSyncFixture();
    const s = await fixture.m1.admin.auth.getSession();
    if (!s.data.session) throw new Error("讀不到管理員甲的 session");
    adminSessionM1 = s.data.session;
    await createCards(fixture);
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
  console.log(`[b18 teardown] ${actions.join(";")}`);
  expect(pageErrors, "頁面沒有 JS 錯誤").toEqual([]);
});

test("M1 #1012 商家端:整張填色白字、標籤固定、姓名置中;欄與欄、前後卡片之間有間隔;點卡片照樣開詳情", async ({
  browser,
}) => {
  const A = fixture.staffA.staffId;
  const B = fixture.staffB.staffId;
  for (const width of [1280, 375]) {
    const page = await newPage(browser, width);
    await openMerchantCalendar(page);
    const block = (c: Card, staffId = c.staff === "A" ? A : B, role = "main") =>
      page
        .getByTestId(`booking-block-${c.id}-${role}`)
        .and(page.locator(`[data-staff-id="${staffId}"]`));
    const half = card("王半時");
    const hour = card("李一時");
    const two = card("陳兩時");
    const neighbour = card("周隔壁欄");
    const assist = card("張協助");
    await expect(block(two)).toBeVisible({ timeout: LOAD_TIMEOUT });

    expectFilledLook(await readCard(block(half)), half, "inline");
    expectFilledLook(await readCard(block(hour)), hour, "stacked");
    expectFilledLook(await readCard(block(two)), two, "stacked");
    expectFilledLook(await readCard(block(neighbour)), neighbour, "stacked");
    const assistBlock = block(assist, A, "assistant");
    await expect(assistBlock).toContainText("張協助(協助)");
    expectFilledLook(await readCard(assistBlock), assist, "stacked");
    // #1017:45 分鐘卡(畫出來 42px = 45px 扣上下間隔 3px)
    const m45 = await readCardAtHeight(block(hour), 42);
    expect(m45.layout).toBe("stacked");
    expectDividerCentered(m45, `商家端 ${width} 45 分鐘(複製)`);
    expect(m45.nameDy, "45 分鐘姓名在下半部垂直置中").toBeLessThanOrEqual(1.5);
    // 已取消的單時間軸本來就不顯示(不變)
    await expect(page.getByTestId(`booking-block-${card("林取消").id}-main`)).toHaveCount(0);

    // 前後相連:上下間隔 2~4px
    const bHalf = (await block(half).boundingBox())!;
    const bHour = (await block(hour).boundingBox())!;
    const bTwo = (await block(two).boundingBox())!;
    const vGap1 = bHour.y - (bHalf.y + bHalf.height);
    const vGap2 = bTwo.y - (bHour.y + bHour.height);
    console.log(`[M1 ${width}] 上下間隔 ${vGap1.toFixed(1)} / ${vGap2.toFixed(1)}px`);
    expect(vGap1).toBeGreaterThanOrEqual(2);
    expect(vGap1).toBeLessThanOrEqual(4);
    expect(vGap2).toBeGreaterThanOrEqual(2);
    expect(vGap2).toBeLessThanOrEqual(4);
    // 相鄰兩位服務人員:左右間隔 6~8px(兩邊各內縮 3px,中間夾 1px 欄線)
    const gridA = (await page.getByTestId(`staff-grid-${A}`).boundingBox())!;
    const gridB = (await page.getByTestId(`staff-grid-${B}`).boundingBox())!;
    const bNb = (await block(neighbour).boundingBox())!;
    const [left, right] = gridA.x < gridB.x ? [bHalf, bNb] : [bNb, bHalf];
    const hGap = right.x - (left.x + left.width);
    console.log(
      `[M1 ${width}] 左右間隔 ${hGap.toFixed(1)}px;卡片寬 ${bHalf.width.toFixed(0)}px、半小時卡高 ${bHalf.height.toFixed(0)}px`,
    );
    expect(hGap).toBeGreaterThanOrEqual(6);
    expect(hGap).toBeLessThanOrEqual(8);
    // 點擊範圍:半小時卡至少 26px 高、卡片寬只少 6px
    expect(bHalf.height).toBeGreaterThanOrEqual(26);
    expect(gridA.width - bHalf.width).toBeLessThanOrEqual(7);

    await block(two).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/M1-merchant-timeline-${width}.png` });
    // 近看多欄 + 相連卡片
    const union = {
      x: Math.min(gridA.x, gridB.x) - 2,
      y: bHalf.y - 8,
      width: Math.abs(gridB.x - gridA.x) + gridB.width + 4,
      height: bTwo.y + bTwo.height - bHalf.y + 16,
    };
    await page.screenshot({
      path: `${SHOTS}/M1-merchant-columns-closeup-${width}.png`,
      clip: {
        x: Math.max(0, union.x),
        y: Math.max(0, union.y),
        width: Math.min(union.width, width - Math.max(0, union.x)),
        height: union.height,
      },
    });

    // 點卡片照樣開詳情:半小時(可拖、靠手勢判定點擊)與兩小時(已完成,不可拖)
    for (const c of [half, two]) {
      await block(c).click();
      await expect(page.getByRole("dialog").getByText("預約詳情").first()).toBeVisible({
        timeout: LOAD_TIMEOUT,
      });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: LOAD_TIMEOUT });
    }
  }
});

test("M2 #1012 服務人員端:同一套填色白字與間隔;點卡片照樣開詳情", async ({ browser }) => {
  for (const width of [1280, 375]) {
    const page = await newPage(browser, width);
    await openStaffTimeline(page);
    const grid = page.getByTestId("my-timeline-grid");
    const block = (name: string) =>
      grid.locator("button", { has: page.locator("[data-booking-block-layout]") }).filter({
        hasText: name,
      });
    const half = card("王半時");
    const hour = card("李一時");
    const two = card("陳兩時");
    const assist = card("張協助");
    await expect(block("陳兩時")).toBeVisible({ timeout: LOAD_TIMEOUT });
    expectFilledLook(await readCard(block("王半時")), half, "inline");
    expectFilledLook(await readCard(block("李一時")), hour, "stacked");
    expectFilledLook(await readCard(block("陳兩時")), two, "stacked");
    await expect(block("張協助")).toContainText("張協助(協助)");
    expectFilledLook(await readCard(block("張協助")), assist, "stacked");
    // #1017:45 分鐘卡(複製一小時卡、高度 42px)
    const m45 = await readCardAtHeight(block("李一時"), 42);
    expect(m45.layout).toBe("stacked");
    expectDividerCentered(m45, `服務人員端 ${width} 45 分鐘(複製)`);
    expect(m45.nameDy, "45 分鐘姓名在下半部垂直置中").toBeLessThanOrEqual(1.5);
    await expect(block("林取消")).toHaveCount(0);

    const g = (await grid.boundingBox())!;
    const bHalf = (await block("王半時").boundingBox())!;
    const bHour = (await block("李一時").boundingBox())!;
    const bTwo = (await block("陳兩時").boundingBox())!;
    const vGap1 = bHour.y - (bHalf.y + bHalf.height);
    const vGap2 = bTwo.y - (bHour.y + bHour.height);
    console.log(
      `[M2 ${width}] 上下間隔 ${vGap1.toFixed(1)} / ${vGap2.toFixed(1)}px;左 ${(bHalf.x - g.x).toFixed(1)}px 右 ${(g.x + g.width - bHalf.x - bHalf.width).toFixed(1)}px`,
    );
    for (const gap of [vGap1, vGap2]) {
      expect(gap).toBeGreaterThanOrEqual(2);
      expect(gap).toBeLessThanOrEqual(4);
    }
    // 左邊時間欄 64px + 內縮 3px、右邊內縮 3px,再各加格線外框 1px
    expect(Math.abs(bHalf.x - g.x - 68)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(g.x + g.width - (bHalf.x + bHalf.width) - 4)).toBeLessThanOrEqual(1.5);
    expect(bHalf.height).toBeGreaterThanOrEqual(26);

    await block("陳兩時").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/M2-staff-timeline-${width}.png` });
    await page.screenshot({
      path: `${SHOTS}/M2-staff-closeup-${width}.png`,
      clip: {
        x: g.x,
        y: Math.max(0, bHalf.y - 8),
        width: g.width,
        height: bTwo.y + bTwo.height - bHalf.y + 16,
      },
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "服務人員端沒有橫向捲出").toBeLessThanOrEqual(0);

    // 點卡片照樣開詳情
    for (const name of ["王半時", "陳兩時"]) {
      await block(name).click();
      await expect(page.getByRole("dialog").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: LOAD_TIMEOUT });
    }
  }
});
