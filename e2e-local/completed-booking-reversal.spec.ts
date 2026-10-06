// #844「已完成訂單取消 / 還原」批次 5 的端對端測試(規格書 .project/specs/已完成訂單取消與還原.md
// §十 Playwright e2e、§七 邊界、§五 UI)。**只在本機跑**:`npm run test:e2e:local`
// (playwright.local.config.ts;只連本機 Docker,Playwright 自己開獨立 Chromium,不碰使用者的瀏覽器)。
//
// 涵蓋(同一個本機測試商家,serial 依序跑,每條各用自己的一張已完成訂單,互不影響):
//   1. 管理員「還原完成」(同月):兩顆按鈕、原因空白不能送、成功後狀態 / 抽成 / 點數 / 稽核 / 操作紀錄;
//      還原後行事曆色塊是「已確認」且實際拖一次(時間有變);再按「標記完成」⇒ 抽成重新寫入、
//      服務人員報表看得到該筆抽成、詳情與會員頁相關訂單都是「已入帳 N 點(曾收回 N 點)」
//   2. 取消 + 通知開關:開關預設關、文案守門(抽成 / 報表 / 退款);打開開關 ⇒ 稽核 notified=true、
//      LINE(line-notify-dispatch)與推播(push-notify-dispatch)各呼叫 1 次
//   3. 跨月取消 + 差額:service role 把 completed_at 調到上個月 ⇒ 紅色跨月警告、按鈕「我了解影響,確定取消」;
//      成功後跳「兩層重疊」差額小卡窗:焦點在「知道了」、點遮罩不關、Esc 關;沒開開關 ⇒ 不發通知
//   4. 還原有差額 ⇒ 小卡窗 Enter 關;再完成 ⇒ 點數補到應得(Q11 A),詳情與資料庫都是有效入帳 = 派點
//   4b. #965:差額小卡窗剛插入 DOM 就送 Esc(Radix 還沒登記最上層的空窗)⇒ 仍走「知道了」收尾;
//       另一條是正常時機(焦點已在「知道了」)按 Esc
//   5. 匯入單只能取消(還原被擋、按鈕灰掉並說明原因)
//   6. 狀態已改變(別人剛處理過)⇒ toast 說明並回到預約詳情、顯示最新狀態
//   7. 客服(訂單鑰匙)看已完成訂單:沒有兩顆按鈕、有常駐 `!`;直接呼叫 RPC 也被擋
//   8. 320px 寬:預約詳情 + 兩個確認子畫面(含跨月長文案)沒有橫向捲出
// 成功類情境(1~5)另外監聽:瀏覽器 console error / pageerror 與本機 API 的 4xx/5xx 回應必須是 0
// (批次 4 QA 打回 3:成功後不可以多打一次預覽而出現 400「狀態已經改變」)。
//
// 測試資料:沿用紅利批次 8 的 setupBonusFixture(管理員、客服、商家、3 位服務人員、服務項目 1000 元、
// 會員甲 300 點 / 乙 500 點、基本模式 1000 元 = 10 點),本檔再補「抽成 20%」與客服的「訂單」鑰匙。
// teardown 同一支 teardownBonusFixture:service_role 硬刪除,刪前核對名稱 / email 格式、刪後全部 0
// (稽核表 booking_completion_reversals 對 bookings / merchants 都是 on delete cascade)。
import { expect, test, type Locator, type Page, type Response } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import { assertNoHorizontalOverflow } from "../e2e/support/overflow-assert";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";
import {
  clientAs,
  getBalance,
  injectSession,
  MEMBER_A_INITIAL,
  MEMBER_A_PHONE,
  MEMBER_B_INITIAL,
  MEMBER_B_PHONE,
  SERVICE_ITEM_PRICE,
  serviceClient,
  setupBonusFixture,
  teardownBonusFixture,
  type BonusFixture,
} from "./support/bonus-fixture";

const LOAD_TIMEOUT = 20_000;
/** 服務項目 1000 元、基本模式每滿 100 元 1 點 ⇒ 每張單派 10 點。 */
const POINTS_PER_BOOKING = 10;
/** 抽成 20% ⇒ 1000 元的單抽成 200 元。 */
const COMMISSION_PERCENT = 20;
const COMMISSION_AMOUNT = 200;
/** 不在任何會員名下的電話(create_booking 會自動建會員,所以這幾張單也會有會員,但不影響甲乙餘額)。 */
const OTHER_PHONE_IMPORT = "0966100071";
const OTHER_PHONE_STALE = "0966100072";
const OTHER_PHONE_MOBILE = "0966100073";

/** 跟 #844 無關、本機模式必然出現的兩種雜訊(只排除這兩種,其他 console error 一律算問題):
 *  ① 開發伺服器沒有 sw.js(PWA service worker 只在 build 後存在)⇒ 註冊失敗;
 *  ② config 的 Chromium DNS 規則刻意讓 localhost 以外的網域解析失敗(例如外部字型)⇒ ERR_NAME_NOT_RESOLVED。
 *  兩者都不是 HTTP 回應,所以「4xx/5xx 回應」那條監聽不受影響:400「狀態已經改變」一定抓得到。 */
function isEnvironmentNoise(text: string): boolean {
  return (
    /ServiceWorker|sw\.js|unsupported MIME type \('text\/html'\)/.test(text) ||
    text.includes("net::ERR_NAME_NOT_RESOLVED")
  );
}

test.describe.configure({ mode: "serial", timeout: 150_000 });

let fixture: BonusFixture;
let setupFailed = false;
let recorder: RequestRecorder | null = null;
/** 成功類情境才收集:console error、pageerror、本機 API 的 4xx/5xx。 */
let problems: string[] = [];
let watchProblems = false;
// #947:原本這裡有「會員詳情頁 <div> 在 <p> 裡」兩句 React 結構警告的排除例外;PageHeader 的說明區
// 改成 <div> 之後警告已消失,例外已拿掉 ⇒ 會員頁那一步任何 console error 都會算問題。
/** 通知 Edge Function(本機沒跑 Edge)一律攔下回 200,並記下被呼叫了幾次。 */
interface DispatchCall {
  url: string;
  bookingId: string | null;
  eventType: string | null;
}
let dispatchCalls: DispatchCall[] = [];
/** 每條測試建的已完成訂單:customer_name → booking id。 */
const bookingIds = new Map<string, string>();
let bookingCounter = 0;

// ---------------------------------------------------------------------------------------------
// setup / teardown
// ---------------------------------------------------------------------------------------------
test.beforeAll(async () => {
  try {
    fixture = await setupBonusFixture();
    const admin = await clientAs(fixture.adminSession);
    // 抽成:三位服務人員 × 服務項目 20%(按件制是新服務人員的預設)。
    for (const staffId of fixture.staffIds) {
      const r = await admin.from("staff_service_commission_rates").upsert(
        {
          staff_id: staffId,
          service_item_id: fixture.serviceItemId,
          commission_mode: "percentage",
          commission_value: COMMISSION_PERCENT,
        },
        { onConflict: "staff_id,service_item_id" },
      );
      if (r.error) throw new Error(`設定抽成失敗:${r.error.message}`);
    }
    // 客服加開「訂單」鑰匙(fixture 只開了「會員管理」),才能進訂單管理頁看已完成訂單。
    const agentRow = await serviceClient()
      .from("merchant_agents")
      .select("id")
      .eq("merchant_id", fixture.merchantId)
      .single();
    if (agentRow.error) throw new Error(`查客服失敗:${agentRow.error.message}`);
    const perm = await admin.rpc("set_agent_permission", {
      p_agent_id: (agentRow.data as { id: string }).id,
      p_section_key: "orders",
      p_granted: true,
    });
    if (perm.error) throw new Error(`開客服 orders 權限失敗:${perm.error.message}`);
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownBonusFixture(fixture);
  console.log(
    "[completed-booking-reversal 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"),
  );
});

test.beforeEach(async ({ page }) => {
  recorder = recordRequestHosts(page);
  problems = [];
  watchProblems = false;
  dispatchCalls = [];
  page.on("console", (msg) => {
    if (watchProblems && msg.type() === "error" && !isEnvironmentNoise(msg.text())) {
      problems.push(`console: ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    if (watchProblems && !isEnvironmentNoise(err.message)) {
      problems.push(`pageerror: ${err.message}`);
    }
  });
  page.on("response", (res: Response) => {
    if (!watchProblems) return;
    const url = res.url();
    if (url.startsWith("http://127.0.0.1:") && res.status() >= 400) {
      problems.push(`HTTP ${res.status()} ${res.request().method()} ${url}`);
    }
  });
  await page.route("**/functions/v1/**", async (route) => {
    // 前端送的 body 是 { merchant_id, booking_id, event_type, ... }(line-notifications / push-notifications api.ts)。
    let body: { booking_id?: string; event_type?: string } = {};
    try {
      body = (route.request().postDataJSON() ?? {}) as typeof body;
    } catch {
      body = {};
    }
    dispatchCalls.push({
      url: route.request().url(),
      bookingId: body.booking_id ?? null,
      eventType: body.event_type ?? null,
    });
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
});

test.afterEach(async () => {
  if (recorder) expectOnlyLocalRequests(recorder);
  if (watchProblems) {
    expect(problems, "成功類情境不可以出現 console error 或 4xx/5xx 回應").toEqual([]);
  }
});

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
function taipeiDateKey(offsetDays: number): string {
  const d = new Date(Date.now() + 8 * 3600_000 + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** 上個月 15 日中午(台北)—— 讓 completed_at 一定落在「上個月」。 */
function previousMonthMiddayIso(): string {
  const taipeiNow = new Date(Date.now() + 8 * 3600_000);
  let y = taipeiNow.getUTCFullYear();
  let m = taipeiNow.getUTCMonth(); // 0-based;上個月 = m - 1
  if (m === 0) {
    y -= 1;
    m = 12;
  }
  return `${y}-${String(m).padStart(2, "0")}-15T12:00:00+08:00`;
}

/** 以管理員身分建單 → 確認 → 完成,回傳 booking id(走正式 RPC,權限照常生效)。 */
async function createCompletedBooking(
  customerName: string,
  phone: string,
  staffIndex: number,
): Promise<string> {
  bookingCounter += 1;
  const admin = await clientAs(fixture.adminSession);
  const hour = String(8 + bookingCounter).padStart(2, "0");
  const created = await admin.rpc("create_booking", {
    p_merchant_id: fixture.merchantId,
    p_staff_id: fixture.staffIds[staffIndex],
    p_service_items: [
      { service_item_id: fixture.serviceItemId, quantity: 1, unit_price: SERVICE_ITEM_PRICE },
    ],
    p_start_at: `${taipeiDateKey(1)}T${hour}:00:00+08:00`,
    p_customer_name: customerName,
    p_customer_phone: phone,
    p_payment_method_id: fixture.paymentMethodId,
  });
  if (created.error || !created.data) throw new Error(`建單失敗:${created.error?.message}`);
  const id = (created.data as { id: string }).id;
  const c1 = await admin.rpc("confirm_booking", { p_booking_id: id });
  if (c1.error) throw new Error(`確認失敗:${c1.error.message}`);
  const c2 = await admin.rpc("complete_booking", { p_booking_id: id });
  if (c2.error) throw new Error(`完成失敗:${c2.error.message}`);
  bookingIds.set(customerName, id);
  return id;
}

async function adjustPoints(memberId: string, delta: number) {
  const admin = await clientAs(fixture.adminSession);
  const r = await admin.rpc("adjust_member_points", {
    p_member_id: memberId,
    p_points_delta: delta,
    p_note: "e2e 本機:模擬會員已經花掉點數",
  });
  if (r.error) throw new Error(`調整點數失敗:${r.error.message}`);
}

interface BookingState {
  status: string;
  completed_at: string | null;
  cancelled_reason: string | null;
}
async function bookingState(id: string): Promise<BookingState> {
  const r = await serviceClient()
    .from("bookings")
    .select("status,completed_at,cancelled_reason")
    .eq("id", id)
    .single();
  if (r.error) throw new Error(`查訂單失敗:${r.error.message}`);
  return r.data as BookingState;
}

async function commissionCount(id: string): Promise<number> {
  const r = await serviceClient()
    .from("booking_commission_records")
    .select("id", { count: "exact", head: true })
    .eq("booking_id", id);
  if (r.error) throw new Error(`查抽成失敗:${r.error.message}`);
  return r.count ?? 0;
}

interface ReversalAuditRow {
  action: string;
  reason: string;
  is_cross_month: boolean;
  notified: boolean;
  commission_amount_reversed: number;
  points_due: number;
  points_recovered: number;
  points_shortfall: number;
  shortfall_hint: string | null;
}
async function audits(id: string): Promise<ReversalAuditRow[]> {
  const r = await serviceClient()
    .from("booking_completion_reversals")
    .select(
      "action,reason,is_cross_month,notified,commission_amount_reversed,points_due,points_recovered,points_shortfall,shortfall_hint,created_at",
    )
    .eq("booking_id", id)
    .order("created_at", { ascending: true });
  if (r.error) throw new Error(`查稽核失敗:${r.error.message}`);
  return (r.data ?? []) as ReversalAuditRow[];
}

/** 本單的分類帳:入帳(earn_booking)合計與收回(earn_booking_reversal)合計。 */
async function earnLedger(id: string): Promise<{ earned: number; reversed: number }> {
  const r = await serviceClient()
    .from("member_point_transactions")
    .select("transaction_type,points_delta")
    .eq("booking_id", id);
  if (r.error) throw new Error(`查分類帳失敗:${r.error.message}`);
  let earned = 0;
  let reversed = 0;
  for (const row of (r.data ?? []) as { transaction_type: string; points_delta: number }[]) {
    if (row.transaction_type === "earn_booking") earned += Number(row.points_delta);
    if (row.transaction_type === "earn_booking_reversal") reversed += -Number(row.points_delta);
  }
  return { earned, reversed };
}

async function loginAs(page: Page, who: "admin" | "agent") {
  await injectSession(page, who === "admin" ? fixture.adminSession : fixture.agentSession);
  await primeCurrentMerchant(page);
}

/** 台北時間的年 / 月(服務人員報表網址參數用)。 */
function taipeiYearMonth(): { year: number; month: number } {
  const d = new Date(Date.now() + 8 * 3600_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

/** 毫秒時間 → 台北 'HH:MM'。 */
function taipeiHHMM(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(11, 16);
}

/** 行事曆格線常數(= CalendarPage 的 SLOT_MINUTES / SLOT_PX;e2e/calendar-drag-move.spec.ts 同一組)。 */
const CALENDAR_SLOT_PX = 30;
const CALENDAR_SLOT_MINUTES = 30;
/** 已確認(accepted)預設狀態色 #1c6fd2(types.ts DEFAULT_BOOKING_STATUS_COLORS;測試商家沒有自訂顏色)。
 *  色塊文字色 = 狀態色本身(bookingBlockStyle),已完成會是 #1ea25d。 */
const ACCEPTED_TEXT_COLOR = "rgb(28, 111, 210)";

/**
 * §十 情境 A:還原後到行事曆(週檢視、服務人員分欄)找這張單的主色塊 →
 * ① 確認是「已確認」:文字色 = 已確認狀態色,而且是可拖的游標(只有待確認 / 已確認可拖);
 * ② 用滑鼠往下拖 2 格(= 60 分鐘),放開前殘影小字要是「改時間 → HH:MM」,等拖拉流程回到 idle;
 * ③ 資料庫 start_at 真的往後 60 分鐘、狀態仍是已確認。手勢照 e2e/calendar-drag-move.spec.ts 的做法。
 */
async function dragRevertedBlockInCalendar(page: Page, bookingId: string): Promise<void> {
  const readStartMs = async (): Promise<number> => {
    const r = await serviceClient()
      .from("bookings")
      .select("start_at")
      .eq("id", bookingId)
      .single();
    if (r.error) throw new Error(`查訂單時間失敗:${r.error.message}`);
    return new Date((r.data as { start_at: string }).start_at).getTime();
  };
  const startMs = await readStartMs();
  const dateKey = new Date(startMs + 8 * 3600_000).toISOString().slice(0, 10);

  await page.goto(`/app/calendar?date=${dateKey}`);
  // 預設是月檢視;切換鈕是單選群組(role="radio",ui-v1-full 之後;e2e/ 舊檔還寫 button)。
  await page
    .getByRole("radiogroup", { name: "檢視模式" })
    .getByRole("radio", { name: "週檢視" })
    .click({ timeout: LOAD_TIMEOUT });
  const grid = page.getByTestId("calendar-day-grid");
  await expect(grid).toBeVisible({ timeout: LOAD_TIMEOUT });
  const block = page.getByTestId(`booking-block-${bookingId}-main`);
  await expect(block).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(block).toHaveCSS("color", ACCEPTED_TEXT_COLOR);
  await expect(block).toHaveClass(/cursor-grab/);

  const slots = 2;
  const deltaMs = slots * CALENDAR_SLOT_MINUTES * 60_000;
  await block.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
  const box = await block.boundingBox();
  if (!box) throw new Error("色塊量不到 boundingBox");
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await expect(grid).toHaveAttribute("data-drag-phase", "pressing");
  // 第一步就超過 10px 閾值,否則還停在 pressing。
  await page.mouse.move(start.x + 12, start.y + 12);
  await expect(grid).toHaveAttribute("data-drag-phase", "dragging");
  await page.mouse.move(start.x, start.y + slots * CALENDAR_SLOT_PX, { steps: 8 });
  await expect(page.getByTestId("booking-drag-hint")).toHaveText(
    `改時間 → ${taipeiHHMM(startMs + deltaMs)}`,
  );
  await page.mouse.up();
  await expect(grid).toHaveAttribute("data-drag-phase", "idle", { timeout: LOAD_TIMEOUT });

  await expect
    .poll(async () => (await readStartMs()) - startMs, {
      timeout: LOAD_TIMEOUT,
      message: "拖完之後 start_at 應該往後 60 分鐘",
    })
    .toBe(deltaMs);
  expect((await bookingState(bookingId)).status).toBe("accepted");
}

function orderCard(page: Page, customerName: string): Locator {
  return page.getByRole("button", { name: new RegExp(customerName) });
}

/** 在訂單管理頁打開某張單的預約詳情(全頁層)。 */
async function openDetail(page: Page, customerName: string): Promise<Locator> {
  await page.goto("/app/orders");
  await expect(page.getByRole("heading", { name: "訂單管理" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await orderCard(page, customerName).click();
  const layer = page.getByRole("dialog");
  await expect(layer.getByText("預約詳情")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(layer.getByText(customerName).first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  return layer;
}

/** 從預約詳情點兩顆按鈕之一,等確認子畫面的連帶影響清單出現。 */
async function openReversal(layer: Locator, action: "revert" | "cancel"): Promise<void> {
  await layer.getByRole("button", { name: action === "revert" ? "還原完成" : "取消訂單" }).click();
  await expect(
    layer.getByText(action === "revert" ? "還原完成" : "取消已完成的訂單").first(),
  ).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(layer.getByText("這次會連帶影響")).toBeVisible({ timeout: LOAD_TIMEOUT });
}

function reasonBox(layer: Locator): Locator {
  return layer.locator("textarea[id^='completed-reversal-reason-']");
}

// ---------------------------------------------------------------------------------------------
// 1. 還原完成(同月)→ 再完成
// ---------------------------------------------------------------------------------------------
test("§十 情境 A:管理員還原完成(同月),原因必填;成功後抽成 / 點數 / 稽核正確,再完成點數與抽成回來", async ({
  page,
}) => {
  const name = `E2E反轉還原客戶${fixture.runId}`;
  const id = await createCompletedBooking(name, MEMBER_A_PHONE, 0);
  expect(await getBalance(fixture.memberAId)).toBe(MEMBER_A_INITIAL + POINTS_PER_BOOKING);
  expect(await commissionCount(id)).toBe(1);

  watchProblems = true;
  await loginAs(page, "admin");
  const layer = await openDetail(page, name);

  // §5.1:兩顆按鈕都在、沒有客服提示。
  await expect(layer.getByRole("button", { name: "取消訂單" })).toBeVisible();
  await expect(layer.getByRole("button", { name: "還原完成" })).toBeVisible();
  await expect(layer.getByTestId("agent-cannot-reverse-note")).toHaveCount(0);

  await openReversal(layer, "revert");
  // 同月:沒有紅色跨月警告,按鈕是一般文字。
  await expect(layer.getByTestId("reversal-cross-month")).toHaveCount(0);
  await expect(layer.getByTestId("reversal-explanation")).toContainText("退回「已確認」");
  await expect(layer).toContainText(`−$${COMMISSION_AMOUNT}`);
  await expect(layer).toContainText(`預計收回 ${POINTS_PER_BOOKING} 點`);
  // 還原沒有通知開關。
  await expect(layer.getByRole("switch")).toHaveCount(0);

  // 原因空白 ⇒ 確定鈕灰掉、旁邊 `!` 說明。
  const confirm = layer.getByRole("button", { name: "確定還原" });
  await expect(confirm).toBeDisabled();
  await expect(layer.getByTestId("reversal-confirm-disabled-reason")).toContainText("請先填寫原因");
  // 純空白(含全形空白)也不行。
  await reasonBox(layer).fill("  　 ");
  await expect(confirm).toBeDisabled();
  await reasonBox(layer).fill("e2e:誤按完成");
  await expect(confirm).toBeEnabled();
  await expect(layer.getByTestId("reversal-confirm-disabled-reason")).toHaveCount(0);
  await confirm.click();

  await expect(page.getByText("已還原為已確認").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  // 沒有差額 ⇒ 不跳小卡窗。
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  // 列表上這張單變「已確認」(onChanged 重抓)。
  await expect(orderCard(page, name)).toContainText("已確認", { timeout: LOAD_TIMEOUT });

  const s = await bookingState(id);
  expect(s.status).toBe("accepted");
  expect(s.completed_at).toBeNull();
  expect(await commissionCount(id)).toBe(0);
  expect(await getBalance(fixture.memberAId)).toBe(MEMBER_A_INITIAL);
  const a = await audits(id);
  expect(a).toHaveLength(1);
  expect(a[0]).toMatchObject({
    action: "revert_to_accepted",
    reason: "e2e:誤按完成",
    is_cross_month: false,
    notified: false,
    points_due: POINTS_PER_BOOKING,
    points_recovered: POINTS_PER_BOOKING,
    points_shortfall: 0,
  });
  expect(Number(a[0]?.commission_amount_reversed)).toBe(COMMISSION_AMOUNT);
  // 還原一律不發通知。
  expect(dispatchCalls).toEqual([]);

  // §十 情境 A ①:行事曆色塊變「已確認」而且真的拖得動(拖完時間有變)。
  await dragRevertedBlockInCalendar(page, id);

  // 再打開:已確認的單顯示「已收回 10 點」、有「標記完成」;操作記錄看得到原因。
  const again = await openDetail(page, name);
  await expect(again).toContainText(`已收回 ${POINTS_PER_BOOKING} 點`, { timeout: LOAD_TIMEOUT });
  await again.getByText("操作記錄", { exact: true }).click();
  await expect(again).toContainText("e2e:誤按完成", { timeout: LOAD_TIMEOUT });
  await again.getByText(/返回/).first().click();
  await expect(again.getByRole("button", { name: "標記完成" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 重新完成(§3.9):抽成重新寫入、點數再入帳。
  await again.getByRole("button", { name: "標記完成" }).click();
  await expect(page.getByText("已標記完成").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  expect((await bookingState(id)).status).toBe("completed");
  expect(await commissionCount(id)).toBe(1);
  expect(await getBalance(fixture.memberAId)).toBe(MEMBER_A_INITIAL + POINTS_PER_BOOKING);

  const done = await openDetail(page, name);
  await expect(done).toContainText(
    `已入帳 ${POINTS_PER_BOOKING} 點(曾收回 ${POINTS_PER_BOOKING} 點)`,
    { timeout: LOAD_TIMEOUT },
  );

  // §十 情境 A ②:服務人員報表(本月)看得到重新完成後的那筆抽成。
  const { year, month } = taipeiYearMonth();
  await page.goto(`/app/staff-report?staffId=${fixture.staffIds[0]}&year=${year}&month=${month}`);
  await expect(page.getByRole("heading", { name: "服務人員報表" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  // 訂單明細是 ListCard 清單(ui-v1-full 起不是表格):客戶名 + 完成日期 + 金額明細列。
  // 這位服務人員本月只有這一張單(還原時刪掉的那筆不能還在、重新完成的新快照要在)⇒ 剛好 1 張卡。
  const reportCard = page.locator("li").filter({ hasText: name });
  await expect(reportCard).toHaveCount(1, { timeout: LOAD_TIMEOUT });
  await expect(reportCard).toContainText(`$${COMMISSION_AMOUNT}`);

  // §十 情境 A ③:會員頁「相關訂單」也是「已入帳 10 點(曾收回 10 點)」。
  // 會員甲在這條之前沒有別的訂單 ⇒ 相關訂單只有這一張。
  await page.goto(`/app/members/${fixture.memberAId}`);
  await expect(page.getByText("相關訂單", { exact: true }).first()).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(
    page.getByText(`已入帳 ${POINTS_PER_BOOKING} 點(曾收回 ${POINTS_PER_BOOKING} 點)`, {
      exact: true,
    }),
  ).toHaveCount(1, { timeout: LOAD_TIMEOUT });
});

// ---------------------------------------------------------------------------------------------
// 2. 取消 + 通知開關
// ---------------------------------------------------------------------------------------------
test("§3.7 / Q2 C:取消已完成訂單,通知開關預設關;打開後稽核記下 notified 並發出取消通知", async ({
  page,
}) => {
  const name = `E2E反轉取消通知客戶${fixture.runId}`;
  const id = await createCompletedBooking(name, MEMBER_B_PHONE, 1);
  expect(await getBalance(fixture.memberBId)).toBe(MEMBER_B_INITIAL + POINTS_PER_BOOKING);

  watchProblems = true;
  await loginAs(page, "admin");
  const layer = await openDetail(page, name);
  await openReversal(layer, "cancel");

  // §3.12 文案守門:抽成、報表會更新;退款要另外處理。
  const explanation = layer.getByTestId("reversal-explanation");
  await expect(explanation).toContainText("抽成");
  await expect(explanation).toContainText("報表");
  await expect(explanation).toContainText("退款");

  const notifySwitch = layer.getByRole("switch");
  await expect(notifySwitch).toHaveCount(1);
  await expect(notifySwitch).toHaveAttribute("aria-checked", "false");
  await expect(layer).toContainText("同時發送取消通知");
  await notifySwitch.click();
  await expect(notifySwitch).toHaveAttribute("aria-checked", "true");

  await reasonBox(layer).fill("e2e:客人要求作廢");
  await layer.getByRole("button", { name: "確定取消訂單" }).click();
  await expect(page.getByText("已取消訂單").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  await expect(orderCard(page, name)).toContainText("已取消", { timeout: LOAD_TIMEOUT });

  const s = await bookingState(id);
  expect(s.status).toBe("cancelled");
  expect(s.completed_at).toBeNull();
  expect(s.cancelled_reason).toBe("e2e:客人要求作廢");
  expect(await commissionCount(id)).toBe(0);
  expect(await getBalance(fixture.memberBId)).toBe(MEMBER_B_INITIAL);
  const a = await audits(id);
  expect(a).toHaveLength(1);
  expect(a[0]).toMatchObject({ action: "cancel_completed", notified: true, points_shortfall: 0 });
  // 開關打開 ⇒ 前端有呼叫 LINE 與推播的發送(本機攔下回 200)。
  // LINE 與推播分開數:這張單的 booking_cancelled 各剛好 1 次,而且沒有別的通知。
  const cancelDispatch = (fn: string) =>
    dispatchCalls.filter(
      (c) =>
        c.url.includes(`/functions/v1/${fn}`) &&
        c.bookingId === id &&
        c.eventType === "booking_cancelled",
    ).length;
  await expect
    .poll(() => cancelDispatch("line-notify-dispatch"), { timeout: LOAD_TIMEOUT })
    .toBe(1);
  await expect
    .poll(() => cancelDispatch("push-notify-dispatch"), { timeout: LOAD_TIMEOUT })
    .toBe(1);
  expect(dispatchCalls, "除了 LINE、推播各 1 次之外沒有別的通知").toHaveLength(2);
});

// ---------------------------------------------------------------------------------------------
// 3. 跨月取消 + 差額小卡窗(焦點、點遮罩不關、Esc 關)
// ---------------------------------------------------------------------------------------------
test("§3.8 / §5.3 / §5.4:上個月完成的單取消 ⇒ 紅色跨月警告;有差額 ⇒ 兩層重疊小卡窗(焦點、遮罩、Esc)", async ({
  page,
}) => {
  const name = `E2E反轉跨月客戶${fixture.runId}`;
  const id = await createCompletedBooking(name, MEMBER_A_PHONE, 2);
  // 本機 service role:把完成時間調到上個月(正式流程做不到,只為了測跨月畫面)。
  const moved = await serviceClient()
    .from("bookings")
    .update({ completed_at: previousMonthMiddayIso() })
    .eq("id", id)
    .eq("merchant_id", fixture.merchantId)
    .eq("status", "completed")
    .select("id");
  expect(moved.error).toBeNull();
  expect(moved.data).toHaveLength(1);
  // 會員甲已經把點數花到只剩 3 點 ⇒ 收回 3 點、差額 7 點。
  const balance = await getBalance(fixture.memberAId);
  await adjustPoints(fixture.memberAId, -(balance - 3));
  expect(await getBalance(fixture.memberAId)).toBe(3);

  watchProblems = true;
  await loginAs(page, "admin");
  const layer = await openDetail(page, name);
  await openReversal(layer, "cancel");

  const cross = layer.getByTestId("reversal-cross-month");
  await expect(cross).toBeVisible();
  await expect(cross).toContainText("1 個月前");
  await expect(cross).toContainText("可能已經結算發放");
  await expect(cross).toContainText(`$${COMMISSION_AMOUNT}`);
  // 紅色(danger)那一塊在說明之前、最上面。
  const crossBox = await cross.boundingBox();
  const explanationBox = await layer.getByTestId("reversal-explanation").boundingBox();
  expect(crossBox && explanationBox && crossBox.y < explanationBox.y).toBe(true);
  await expect(layer.getByTestId("reversal-expected-shortfall")).toContainText(
    "預計有 7 點收不回來",
  );
  await expect(layer.getByRole("switch")).toHaveAttribute("aria-checked", "false");

  const confirm = layer.getByRole("button", { name: "我了解影響，確定取消" });
  await expect(confirm).toBeDisabled();
  await reasonBox(layer).fill("e2e:上個月的單作廢");
  await confirm.click();

  // §5.4:差額 ⇒ 小卡窗;疊在全頁層之上(兩層重疊),焦點在「知道了」。
  const card = page.getByRole("alertdialog");
  await expect(card).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(card).toContainText("有 7 點未能收回");
  const hint = card.getByTestId("reversal-shortfall-hint");
  await expect(hint).not.toBeEmpty();
  // 純文字:提示裡沒有任何連結。
  await expect(hint.locator("a")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "知道了" })).toBeFocused();
  await expect(page.locator('[role="dialog"]', { hasText: "我了解影響" })).toBeVisible();

  // 點遮罩(左上角,小卡窗之外)關不掉。
  await page.mouse.click(4, 4);
  await expect(card).toBeVisible();
  // Esc = 知道了 ⇒ 小卡窗與全頁層都關掉。
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  await expect(orderCard(page, name)).toContainText("已取消", { timeout: LOAD_TIMEOUT });

  expect((await bookingState(id)).status).toBe("cancelled");
  expect(await getBalance(fixture.memberAId)).toBe(0);
  const a = await audits(id);
  expect(a).toHaveLength(1);
  expect(a[0]).toMatchObject({
    action: "cancel_completed",
    is_cross_month: true,
    notified: false,
    points_due: POINTS_PER_BOOKING,
    points_recovered: 3,
    points_shortfall: 7,
  });
  expect(a[0]?.shortfall_hint).toBeTruthy();
  // 開關沒開 ⇒ 沒有發任何通知。
  expect(dispatchCalls).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// 4. 還原有差額(Enter 關小卡窗)→ 再完成補到應得(Q11 A)
// ---------------------------------------------------------------------------------------------
test("Q11 A:還原時有差額 ⇒ 小卡窗 Enter 關;再完成點數補到應得,詳情顯示有效入帳", async ({
  page,
}) => {
  const name = `E2E反轉補點客戶${fixture.runId}`;
  const id = await createCompletedBooking(name, MEMBER_B_PHONE, 0);
  const balance = await getBalance(fixture.memberBId);
  await adjustPoints(fixture.memberBId, -(balance - 4)); // 只剩 4 點 ⇒ 收回 4、差額 6
  expect(await getBalance(fixture.memberBId)).toBe(4);

  watchProblems = true;
  await loginAs(page, "admin");
  const layer = await openDetail(page, name);
  await openReversal(layer, "revert");
  await expect(layer.getByTestId("reversal-expected-shortfall")).toContainText(
    "預計有 6 點收不回來",
  );
  await reasonBox(layer).fill("e2e:誤按完成(點數已花掉)");
  await layer.getByRole("button", { name: "確定還原" }).click();

  const card = page.getByRole("alertdialog");
  await expect(card).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(card).toContainText("有 6 點未能收回");
  await expect(card.getByRole("button", { name: "知道了" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: LOAD_TIMEOUT });

  expect((await bookingState(id)).status).toBe("accepted");
  expect(await getBalance(fixture.memberBId)).toBe(0);

  // 已確認的單:顯示收回與差額。
  const reverted = await openDetail(page, name);
  await expect(reverted).toContainText("已收回 4 點，差額 6 點未收回", { timeout: LOAD_TIMEOUT });

  // 再完成:補 10 −(10 − 4)= 4 點,有效入帳 = 10。
  await reverted.getByRole("button", { name: "標記完成" }).click();
  await expect(page.getByText("已標記完成").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  expect(await getBalance(fixture.memberBId)).toBe(4);
  const ledger = await earnLedger(id);
  expect(ledger.earned - ledger.reversed).toBe(POINTS_PER_BOOKING);
  expect(ledger).toEqual({ earned: POINTS_PER_BOOKING + 4, reversed: 4 });

  const done = await openDetail(page, name);
  await expect(done).toContainText(`已入帳 ${POINTS_PER_BOOKING} 點(曾收回 4 點)`, {
    timeout: LOAD_TIMEOUT,
  });
});

// ---------------------------------------------------------------------------------------------
// 4b. #965:差額小卡窗剛插入畫面的那一刻就按 Esc(Radix 還沒把它登記成最上層的空窗)
// ---------------------------------------------------------------------------------------------
/**
 * 在頁面裡裝一個 MutationObserver:差額小卡窗(role=alertdialog)一插進 DOM,就在同一個 observer
 * callback(DOM 插入後的第一個微任務)裡對目前焦點送出 Esc keydown。這正是 #965 QA 量到會「關錯層」的時機
 * (DOM 插入時 / 下一個微任務 / 下一幀 / setTimeout 0 都會;兩幀之後才正常)。
 * 回傳的 window.__eng965 記錄:送出時小卡窗是否在 DOM 裡、全頁層是否還在。
 */
async function armEscapeOnShortfallInsert(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __eng965?: { fired: boolean; cardInDom: boolean; layerInDom: boolean };
    };
    w.__eng965 = { fired: false, cardInDom: false, layerInDom: false };
    const obs = new MutationObserver(() => {
      const card = document.querySelector('[role="alertdialog"]');
      if (!card || w.__eng965?.fired) return;
      obs.disconnect();
      const target = (document.activeElement as HTMLElement | null) ?? document.body;
      w.__eng965 = {
        fired: true,
        cardInDom: document.contains(card),
        layerInDom: document.querySelector('[role="dialog"]') !== null,
      };
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    obs.observe(document.body, { childList: true, subtree: true });
  });
}

test("#965:差額小卡窗一插入畫面就按 Esc ⇒ 仍然走「知道了」的收尾(兩層都關、列表重抓、狀態更新)", async ({
  page,
}) => {
  const name = `E2E反轉急Esc客戶${fixture.runId}`;
  const id = await createCompletedBooking(name, MEMBER_A_PHONE, 1);
  const balance = await getBalance(fixture.memberAId);
  await adjustPoints(fixture.memberAId, -(balance - 4)); // 只剩 4 點 ⇒ 收回 4、差額 6
  expect(await getBalance(fixture.memberAId)).toBe(4);

  watchProblems = true;
  await loginAs(page, "admin");
  const layer = await openDetail(page, name);
  // 送出前列表卡片是「已完成」;收尾有跑 ⇒ 會重抓成「已確認」。
  // 全頁層開著時背景是 aria-hidden,所以用 includeHidden 讀底下的列表卡片。
  await expect(
    page.getByRole("button", { name: new RegExp(name), includeHidden: true }),
  ).toContainText("已完成");
  await openReversal(layer, "revert");
  await expect(layer.getByTestId("reversal-expected-shortfall")).toContainText(
    "預計有 6 點收不回來",
  );
  await reasonBox(layer).fill("e2e:#965 小卡窗剛出現就按 Esc");

  await armEscapeOnShortfallInsert(page);
  await layer.getByRole("button", { name: "確定還原" }).click();

  // 探針真的在「小卡窗剛插入、全頁層還在」的那一刻送出了 Esc。
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as { __eng965?: { fired: boolean } }).__eng965?.fired,
        ),
      {
        timeout: LOAD_TIMEOUT,
      },
    )
    .toBe(true);
  const probe = await page.evaluate(
    () =>
      (window as unknown as { __eng965?: { cardInDom: boolean; layerInDom: boolean } }).__eng965,
  );
  expect(probe).toMatchObject({ cardInDom: true, layerInDom: true });

  // 收尾 = 跟按「知道了」一樣:小卡窗與全頁層都關掉、列表重抓、卡片變「已確認」。
  await expect(page.getByText("已還原為已確認").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("alertdialog")).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  await expect(orderCard(page, name)).toContainText("已確認", { timeout: LOAD_TIMEOUT });
  await expect(orderCard(page, name)).not.toContainText("已完成");

  expect((await bookingState(id)).status).toBe("accepted");
  expect(await getBalance(fixture.memberAId)).toBe(0);
  const a = await audits(id);
  expect(a).toHaveLength(1);
  expect(a[0]).toMatchObject({
    action: "revert_to_accepted",
    points_recovered: 4,
    points_shortfall: 6,
  });

  // 差額資訊沒有遺失:重開詳情看得到「已收回 4 點,差額 6 點未收回」。
  const reopened = await openDetail(page, name);
  await expect(reopened).toContainText("已收回 4 點，差額 6 點未收回", { timeout: LOAD_TIMEOUT });
});

test("#965:差額小卡窗正常出現(焦點已在「知道了」)後再按 Esc ⇒ 同樣收尾", async ({ page }) => {
  const name = `E2E反轉慢Esc客戶${fixture.runId}`;
  const id = await createCompletedBooking(name, MEMBER_B_PHONE, 2);
  const balance = await getBalance(fixture.memberBId);
  await adjustPoints(fixture.memberBId, -(balance - 4));
  expect(await getBalance(fixture.memberBId)).toBe(4);

  watchProblems = true;
  await loginAs(page, "admin");
  const layer = await openDetail(page, name);
  // 全頁層開著時背景是 aria-hidden,所以用 includeHidden 讀底下的列表卡片。
  await expect(
    page.getByRole("button", { name: new RegExp(name), includeHidden: true }),
  ).toContainText("已完成");
  await openReversal(layer, "revert");
  await reasonBox(layer).fill("e2e:#965 正常時機按 Esc");
  await layer.getByRole("button", { name: "確定還原" }).click();

  const card = page.getByRole("alertdialog");
  await expect(card).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(card).toContainText("有 6 點未能收回");
  await expect(card.getByRole("button", { name: "知道了" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  await expect(orderCard(page, name)).toContainText("已確認", { timeout: LOAD_TIMEOUT });

  expect((await bookingState(id)).status).toBe("accepted");
  const a = await audits(id);
  expect(a).toHaveLength(1);
  expect(a[0]).toMatchObject({
    action: "revert_to_accepted",
    points_recovered: 4,
    points_shortfall: 6,
  });
});

// ---------------------------------------------------------------------------------------------
// 5. 匯入單只能取消
// ---------------------------------------------------------------------------------------------
test("§3.13 / Q3 A:匯入的歷史訂單不能還原(按鈕灰掉並說明),可以取消", async ({ page }) => {
  const name = `E2E反轉匯入客戶${fixture.runId}`;
  const id = await createCompletedBooking(name, OTHER_PHONE_IMPORT, 1);
  // 本機 service role:標成匯入單(正式匯入流程走 Edge,本機不跑)。
  const marked = await serviceClient()
    .from("bookings")
    .update({ source: "import" })
    .eq("id", id)
    .eq("merchant_id", fixture.merchantId)
    .select("id");
  expect(marked.error).toBeNull();
  expect(marked.data).toHaveLength(1);

  watchProblems = true;
  await loginAs(page, "admin");
  const layer = await openDetail(page, name);
  await openReversal(layer, "revert");
  await expect(layer.getByTestId("reversal-blocked-import_cannot_revert")).toBeVisible();
  await reasonBox(layer).fill("e2e:想還原匯入單");
  const revertBtn = layer.getByRole("button", { name: /確定還原/ });
  await expect(revertBtn).toBeDisabled();
  await expect(layer.getByTestId("reversal-confirm-disabled-reason")).toContainText(
    "匯入的歷史訂單不能還原",
  );

  // 回到詳情改按取消:可以。
  await layer.getByRole("button", { name: "返回", exact: true }).click();
  await openReversal(layer, "cancel");
  await expect(layer.getByTestId("reversal-blocked-import_cannot_revert")).toHaveCount(0);
  await reasonBox(layer).fill("e2e:匯錯了");
  await layer.getByRole("button", { name: /確定取消/ }).click();
  await expect(page.getByText("已取消訂單").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  expect((await bookingState(id)).status).toBe("cancelled");
  expect((await audits(id)).map((r) => r.action)).toEqual(["cancel_completed"]);
});

// ---------------------------------------------------------------------------------------------
// 6. 狀態已改變
// ---------------------------------------------------------------------------------------------
test("§3.11 / 主腦紀錄:確認畫面開著時別人先還原了 ⇒ toast 說明並回到預約詳情、顯示最新狀態", async ({
  page,
}) => {
  const name = `E2E反轉狀態改變客戶${fixture.runId}`;
  const id = await createCompletedBooking(name, OTHER_PHONE_STALE, 2);

  await loginAs(page, "admin");
  const layer = await openDetail(page, name);
  await openReversal(layer, "revert");
  await reasonBox(layer).fill("e2e:我也想還原");

  // 另一位管理員(同一帳號另一條連線)搶先還原。
  const other = await clientAs(fixture.adminSession);
  const first = await other.rpc("revert_completed_booking", {
    p_booking_id: id,
    p_reason: "e2e:別人先處理",
  });
  expect(first.error).toBeNull();

  await layer.getByRole("button", { name: "確定還原" }).click();
  await expect(page.getByText(/狀態已經改變.*畫面已重新整理/).first()).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  // 回到預約詳情(不是停在確認畫面),而且是最新狀態:已確認 ⇒ 有「標記完成」、沒有兩顆反轉按鈕。
  await expect(layer.getByText("預約詳情")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(layer.getByText("這次會連帶影響")).toHaveCount(0);
  await expect(layer.getByRole("button", { name: "標記完成" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(layer.getByRole("button", { name: "還原完成" })).toHaveCount(0);

  // 只有一筆稽核(第二次被擋下、整筆沒寫)。
  const a = await audits(id);
  expect(a).toHaveLength(1);
  expect(a[0]?.reason).toBe("e2e:別人先處理");
});

// ---------------------------------------------------------------------------------------------
// 7. 客服看不到按鈕
// ---------------------------------------------------------------------------------------------
test("§5.1 / Q4 A:客服(訂單鑰匙)看已完成訂單:沒有兩顆按鈕、有常駐提示;直接呼叫 RPC 也被擋", async ({
  page,
}) => {
  const name = `E2E反轉還原客戶${fixture.runId}`; // 情境 1 重新完成的那張(目前是已完成)
  const id = bookingIds.get(name);
  expect(id, "需要情境 1 先跑過").toBeTruthy();
  expect((await bookingState(id as string)).status).toBe("completed");

  await loginAs(page, "agent");
  const layer = await openDetail(page, name);
  await expect(layer.getByTestId("agent-cannot-reverse-note")).toContainText(
    "只有商家管理員可以還原或取消",
    { timeout: LOAD_TIMEOUT },
  );
  await expect(layer.getByRole("button", { name: "取消訂單" })).toHaveCount(0);
  await expect(layer.getByRole("button", { name: "還原完成" })).toHaveCount(0);

  const agent = await clientAs(fixture.agentSession);
  for (const [fn, args] of [
    ["get_completed_booking_reversal_preview", { p_booking_id: id }],
    ["revert_completed_booking", { p_booking_id: id, p_reason: "e2e:客服試試" }],
    ["cancel_completed_booking", { p_booking_id: id, p_reason: "e2e:客服試試" }],
  ] as const) {
    const r = await agent.rpc(fn, args);
    expect(r.error?.code, `${fn} 客服應該被擋`).toBe("42501");
  }
  expect((await bookingState(id as string)).status).toBe("completed");
});

// ---------------------------------------------------------------------------------------------
// 8. 320px
// ---------------------------------------------------------------------------------------------
test("§5.6:320px 寬,預約詳情與兩個確認子畫面(含跨月長文案)沒有橫向捲出", async ({ page }) => {
  const name = `E2E反轉手機客戶${fixture.runId}`;
  const id = await createCompletedBooking(name, OTHER_PHONE_MOBILE, 0);
  const moved = await serviceClient()
    .from("bookings")
    .update({ completed_at: previousMonthMiddayIso() })
    .eq("id", id)
    .eq("merchant_id", fixture.merchantId)
    .eq("status", "completed")
    .select("id");
  expect(moved.data).toHaveLength(1);

  await page.setViewportSize({ width: 320, height: 720 });
  await loginAs(page, "admin");
  const layer = await openDetail(page, name);
  await assertNoHorizontalOverflow(page, "320px 已完成訂單的預約詳情");

  await openReversal(layer, "cancel");
  await expect(layer.getByTestId("reversal-cross-month")).toBeVisible();
  await assertNoHorizontalOverflow(page, "320px 取消已完成訂單確認子畫面(跨月)");
  await layer.getByRole("button", { name: "返回", exact: true }).click();

  await openReversal(layer, "revert");
  await expect(layer.getByTestId("reversal-cross-month")).toBeVisible();
  await assertNoHorizontalOverflow(page, "320px 還原完成確認子畫面(跨月)");
  // 底部兩顆按鈕都完整在畫面內。
  for (const label of ["返回", "我了解影響，確定還原"]) {
    const box = await layer.getByRole("button", { name: label, exact: true }).boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 321, `${label} 在 320px 內`).toBe(true);
  }
  // 沒有執行任何動作:仍是已完成。
  expect((await bookingState(id)).status).toBe("completed");
});
