// 行事曆「拖拉改時間 / 轉派」端對端測試(.project/specs/行事曆拖拉改時間與轉派.md §9.3,SPECS-INDEX #821)。
// 九條情境對應規格書 §9.3 的表格編號;fixture 與每條用哪一筆預約見 e2e/support/calendar-drag-fixture.ts 檔頭。
//
// =========================================================================
// 🔴🔴 先讀這段:這個檔案裡有 5 條「已寫好、等 migration」的測試,**現在跑會紅,而且應該要紅**
//
//   #1 規則 1(改時間)、#2 規則 2(主轉派)、#3 規則 3(助手轉派)、#4 衝突、#5 復原
//   → 全部要打資料庫函式 public.move_booking(supabase/migrations/20260928010000_move_booking.sql)。
//   → 這支 migration 在寫這份測試時(2026-09-28)**還沒有套用到正式資料庫**(SPECS-INDEX #807,
//     使用者裁決「等行事曆拖拉整批做完再一起上線」)。Playwright 對著 `npm run dev` 跑、連的是正式 Supabase,
//     所以這 5 條在 migration 套上去之前必然失敗。
//   → 預期轉綠的時間點:主腦跟使用者一起套用 20260928010000_move_booking.sql 之後,重跑這支 spec。
//
//   🔴 它們是用 **明確的紅字** 失敗的(見 requireMoveBookingMigration():訊息會直接說「move_booking 尚未套用」),
//      **不是 test.skip / test.fixme / 註解掉**。這是刻意的:這個專案已經踩過「skip 看起來像正常」的坑
//      (.claude/skills/automated-testing/SKILL.md 第三節:#711 那 3 條 skipped 從專案建立至今一次都沒跑過,
//      畫面上只顯示「N skipped」),而 #714 / #804 這整個家族的失效方式都是「不是變紅,是沒有跑」。
//   🔴 **如果有人把這 5 條改成 test.skip / test.fixme,就違反了這個專案的核心測試原則。** 紅字才會有人看;
//      skipped 不會。要讓它們轉綠,唯一正確的做法是套用 migration。
//
//   順序上把這 5 條放在最後一個 describe:Playwright 在一條測試失敗後會關掉那個 worker 重開一個
//   (node_modules/playwright/lib/worker/workerProcessEntry.js:`if (testInfo._isFailure()) this._isStopped = true`),
//   重開的 worker 會再跑一次 beforeAll(= 再建一組 fixture)。把會過的 4 條排前面,pre-migration 時最多
//   重建 4 次、不是 5 次;每一個被關掉的 worker 都會先跑 afterAll(teardown),終端機會各印一段清理結果。
//   migration 套上之後全綠,就只會建一組 fixture。
//
// =========================================================================
// 為什麼不是 test.describe.configure({ mode: "serial" })(跟其他 spec 不一樣,刻意的):
//   serial 模式下前面任何一條失敗,後面全部顯示 skipped——跟「沒設定環境變數」的 skipped 長得一模一樣
//   (SKILL 第三節)。這支 spec 在 migration 套用前一定會有 5 條紅,用 serial 的話第一條紅之後其餘 8 條全
//   skipped,連現在就應該綠的 #6~#9 都看不到結果。改用 mode: "default":同一個 worker、依序執行、
//   一條失敗不影響其餘(playwright.config.ts 的 fullyParallel 會被這個檔案層級的設定覆蓋,
//   見 node_modules/playwright/lib/runner/index.js 的 outerMostSequentialSuite 分組)。
//
// =========================================================================
// 規格書 §十二 風險 3「Playwright 拖拉測試寫成假測試」的對策,每一條都照做:
//   ① 前提斷言:每條開頭 expect(色塊數).toBe(2)(主欄一顆、助手欄一顆),避免「空格線假通過」。
//   ② 手勢中斷言 data-drag-phase = dragging、被拖色塊 data-drag-source、殘影小字(formatMoveHint 的原文),
//      證明座標真的落在預期的格子/欄位,不是「放開在原位 → 不打 RPC → 沒有錯誤」那種綠。
//   ③ 送出的 RPC 參數:用 page.on("request") 收 POST /rest/v1/rpc/move_booking 的 body,逐欄比對
//      (這一層不依賴 migration,所以 pre-migration 也驗得到前端算的落點對不對)。
//   ④ 🔴 最終狀態一律用 fixture 的 admin client 查 bookings / booking_assistants,畫面只當前提。
//   ⑤ 不該打 RPC 的情境(#6 #7 #8 #9)反過來斷言「一個 move_booking 請求都沒有送出」+「沒有 toast」。
//
// =========================================================================
// 🔴 故障注入紀錄(規格書 §9.3 要求「必做,寫在檔頭」;兩個注入都不依賴 migration,2026-09-28 實際跑過):
//
//   注入 A:calendarBookingDrag.tsx handleDrop 的 targetStartAt 改成 info.booking.start_at(等於「沒改」)
//     → #1 轉紅(只跑 #1),實際紅字(pre-migration 時紅在 RPC 參數那一層,比 gate 更早):
//       Error: p_target_start_at(送出的是 2026-09-29T00:00:00+00:00)
//       expect(received).toBe(expected) // Object.is equality
//       Expected: 1790647200000
//       Received: 1790640000000          ← 差 7,200,000 ms = 剛好少了那 120 分鐘
//         at expectRpcBody (e2e/calendar-drag-move.spec.ts)
//     還原後 git diff 乾淨,#1 回到「紅在 requireMoveBookingMigration」(pre-migration 的預期狀態)。
//     migration 套用後,同一個注入會改紅在後端(放開的位置跟原本一樣 → toast「無法移動」→ DB start_at 沒有 +120)。
//
//   注入 B:bookingDragMove.ts 的 canDrag() 改成永遠 return true
//     → #6 轉紅(只跑 #6),同一次執行裡四層一起紅(前三層是 expect.soft,所以會全部報出來):
//       Error: 已完成的色塊應該是 cursor-default(不可拖)
//         Expected pattern: /cursor-default/
//         Received string:  "absolute inset-x-0 z-10 select-none … shadow-sm [-webkit-touch-callout:none] cursor-grab"
//       Error: 不可拖的色塊按下並移動後,phase 應該仍是 idle
//         Expected: "idle"   Received: "dragging"
//       Error: 不可拖的色塊不應該出現殘影
//         Expected: 0   Received: 1
//       Error: 不應該出現任何 toast(這是手勢期間曾經出現過的全部 toast 文字)
//         - Array []
//         + Array [ "無法移動Could not find the function public.move_booking(p_booking_id, p_dragged_staff_id,
//                    p_expected_staff_id, p_expected_start_at, p_target_staff_id, p_target_start_at) in the schema cache" ]
//       (再往下的「不應該送出任何 move_booking 請求」在前一輪也抓到過:Expected length: 0 / Received length: 1,
//        Received array 裡是 p_target_start_at "2026-09-29T20:30:00+08:00"——19:00 的單被拖到格線底部夾到 20:30。)
//     還原後 git diff 乾淨,#6 回綠。
//     migration 套用後,同一個注入的 toast 會變成後端的「已完成或已取消的預約不能移動」,其餘紅字不變。
//
//   🔴 注入 B 順便抓到一個測試本身的假綠燈(已修):「沒有 toast」原本寫成 `await expect(toasts).toHaveCount(0)`,
//      它會重試到通過為止,而錯誤 toast 只活 4 秒——trace 裡看得到「無法移動」出現了,斷言卻等到它消失後通過。
//      現在改用 startToastRecorder()(MutationObserver 記錄「曾經出現過」的 toast),見該函式的說明。
// =========================================================================
import { devices, expect, test, type Locator, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "./support/app-shell";
import {
  injectFixtureSession,
  setupCalendarDragFixture,
  STAFF_C_NAME,
  teardownCalendarDragFixture,
  type CalendarDragFixture,
  type FixtureBooking,
} from "./support/calendar-drag-fixture";
import { assertNoHorizontalOverflow } from "./support/overflow-assert";
import { minutesToTime, timeToMinutes } from "../src/modules/booking/dateUtils";

// = CalendarPage.tsx 的 SLOT_PX / SLOT_MINUTES。不直接 import CalendarPage.tsx(會把整個 React 頁面拉進 Node
// 端),改用 assertGridGeometry() 在畫面上反查「26 格 × 30px = 780px」,數字錯了會當場紅。
const SLOT_PX = 30;
const SLOT_MINUTES = 30;
/** fixture 營業時間 08:00–21:00 → 26 格。 */
const GRID_SLOT_COUNT = 26;
const LOAD_TIMEOUT = 20_000;
const MOVE_BOOKING_RPC_PATH = "/rest/v1/rpc/move_booking";
const MINUTE_MS = 60_000;

test.use({ viewport: { width: 1280, height: 800 }, timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "default", timeout: 60_000 });

let fixture: CalendarDragFixture;
let setupFailed = false;
let migrationProbe: { applied: boolean; detail: string };

test.beforeAll(async () => {
  test.setTimeout(150_000);
  try {
    fixture = await setupCalendarDragFixture();
    migrationProbe = await probeMoveBookingMigration(fixture);
    console.log(
      `[calendar-drag-move] fixture 建好(商家 ${fixture.merchantId},日期 ${fixture.dateKey});` +
        `move_booking migration:${migrationProbe.applied ? "已套用" : "🔴 尚未套用(#1~#5 會以明確紅字失敗,見檔頭)"}` +
        `——${migrationProbe.detail}`,
    );
  } catch (err) {
    setupFailed = true;
    console.error("[calendar-drag-move] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(150_000);
  if (setupFailed || !fixture) return;
  const actions = await teardownCalendarDragFixture(fixture);
  console.log(
    `[calendar-drag-move] fixture 清理結果(商家 ${fixture.merchantId}):\n` +
      actions.map((a) => `  - ${a}`).join("\n"),
  );
});

// ---------------------------------------------------------------------------
// migration 探測:用一個「後端一定會擋下、絕不會寫入」的呼叫問一次 move_booking 存不存在。
//   - 函式不存在 → PostgREST 回 PGRST202(Could not find the function ... in the schema cache)。
//   - 函式存在   → 送「放開在原位」的參數,後端在寫入前就 raise P0001「放開的位置跟原本一樣,沒有需要變更的內容」
//                 (對照表 §二 列 1),等於一次不落地的握手,同時也證明簽章對得上。
//   其他任何結果都當成「無法判定」直接丟錯,不猜。
// ---------------------------------------------------------------------------
async function probeMoveBookingMigration(
  fx: CalendarDragFixture,
): Promise<{ applied: boolean; detail: string }> {
  const b = fx.bookings.tapNoop;
  const { error } = await fx.client.rpc("move_booking", {
    p_booking_id: b.id,
    p_dragged_staff_id: fx.staffAId,
    p_target_staff_id: fx.staffAId,
    p_target_start_at: b.startAt,
    p_expected_start_at: b.startAt,
    p_expected_staff_id: fx.staffAId,
  });
  if (!error) {
    throw new Error(
      "move_booking 探測呼叫(放開在原位)竟然成功了——後端應該要 raise「放開的位置跟原本一樣」。" +
        "這代表 move_booking 的行為跟對照表 §二 列 1 不一致,請先查 migration,不要繼續跑。",
    );
  }
  if (error.code === "PGRST202") {
    return { applied: false, detail: `${error.code}:${error.message}` };
  }
  if (error.message.includes("放開的位置跟原本一樣")) {
    return { applied: true, detail: `探測呼叫如預期被擋下(${error.message})` };
  }
  throw new Error(
    `無法判定 move_booking 是否已套用:探測呼叫回了預期之外的錯誤 ${error.code ?? "(無 code)"}:${error.message}`,
  );
}

function requireMoveBookingMigration(testLabel: string): void {
  if (migrationProbe.applied) return;
  throw new Error(
    `move_booking 尚未套用到正式資料庫(SPECS-INDEX #807)。${testLabel} 這一條是「已寫好、等 migration」,不是壞掉。` +
      `套用 supabase/migrations/20260928010000_move_booking.sql 之後應該轉綠。` +
      `到這一步之前的手勢、殘影小字、送出的 RPC 參數都已經驗證正確,只差資料庫端還沒有這支函式` +
      `(探測結果:${migrationProbe.detail})。` +
      `🔴 不可以為了讓它變綠而改成 test.skip / test.fixme——那違反這個專案的核心測試原則(automated-testing SKILL 第三節)。`,
  );
}

// ---------------------------------------------------------------------------
// 資料庫最終狀態(fixture 的 admin client;RLS 下商家管理員可讀自己商家的 bookings / booking_assistants)
// ---------------------------------------------------------------------------
interface BookingDbState {
  startAtMs: number;
  endAtMs: number;
  staffId: string;
  status: string;
  assistantStaffIds: string[];
}

async function readBookingDbState(bookingId: string): Promise<BookingDbState> {
  const { data, error } = await fixture.client
    .from("bookings")
    .select("start_at,end_at,staff_id,status")
    .eq("id", bookingId)
    .single();
  if (error || !data) throw new Error(`查詢 bookings(${bookingId})失敗:${error?.message}`);
  const row = data as { start_at: string; end_at: string; staff_id: string; status: string };
  const { data: assistants, error: assistantsError } = await fixture.client
    .from("booking_assistants")
    .select("staff_id")
    .eq("booking_id", bookingId);
  if (assistantsError) {
    throw new Error(`查詢 booking_assistants(${bookingId})失敗:${assistantsError.message}`);
  }
  return {
    startAtMs: new Date(row.start_at).getTime(),
    endAtMs: new Date(row.end_at).getTime(),
    staffId: row.staff_id,
    status: row.status,
    assistantStaffIds: ((assistants ?? []) as { staff_id: string }[]).map((a) => a.staff_id).sort(),
  };
}

// ---------------------------------------------------------------------------
// 畫面輔助
// ---------------------------------------------------------------------------
type MoveBookingRpcBody = Record<string, unknown>;

/** 收集這個 page 送出的每一個 move_booking 請求 body(有沒有送、送了什麼,兩種斷言都靠它)。 */
function trackMoveBookingRequests(page: Page): MoveBookingRpcBody[] {
  const sent: MoveBookingRpcBody[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes(MOVE_BOOKING_RPC_PATH)) {
      sent.push((req.postDataJSON() ?? {}) as MoveBookingRpcBody);
    }
  });
  return sent;
}

function grid(page: Page): Locator {
  return page.getByTestId("calendar-day-grid");
}

function blocksOf(page: Page, booking: FixtureBooking): Locator {
  return page.locator(`[data-testid^="booking-block-${booking.id}-"]`);
}

function blockOf(page: Page, booking: FixtureBooking, role: "main" | "assistant"): Locator {
  return page.getByTestId(`booking-block-${booking.id}-${role}`);
}

function staffGrid(page: Page, staffId: string): Locator {
  return page.getByTestId(`staff-grid-${staffId}`);
}

/** 登入 → 進行事曆 → 切到週檢視、開到 fixture 那一天 → 等格線與色塊真的渲染出來。 */
async function openDayGrid(page: Page): Promise<void> {
  await injectFixtureSession(page, fixture);
  await primeCurrentMerchant(page);
  await page.goto(`/app/calendar?date=${fixture.dateKey}`);
  // SPECS-INDEX #640:預設是月檢視,拖拉功能在週檢視的服務人員分欄格線上。
  await page.getByRole("button", { name: "週檢視" }).click();
  await expect(grid(page)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(staffGrid(page, fixture.staffAId)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(staffGrid(page, fixture.staffCId)).toBeVisible();
  // 等 get_merchant_day_schedule 真的回來(不能只等格線:格線是靜態的,色塊才是資料)。
  await expect(blockOf(page, fixture.bookings.tapNoop, "main")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await assertGridGeometry(page);
  await startToastRecorder(page);
}

/** 正向對照:格線高度 = 26 格 × 30px。這裡的 SLOT_PX 常數如果跟 CalendarPage 對不上,座標全錯,所以先驗。 */
async function assertGridGeometry(page: Page): Promise<void> {
  const box = await staffGrid(page, fixture.staffAId).boundingBox();
  expect(box, "量不到 staff-grid 的 boundingBox").not.toBeNull();
  expect(
    Math.round(box!.height),
    `staff-grid 高度應該是 ${GRID_SLOT_COUNT} 格 × ${SLOT_PX}px(營業時間 08:00–21:00),否則 SLOT_PX 常數跟 CalendarPage 不一致`,
  ).toBe(GRID_SLOT_COUNT * SLOT_PX);
}

/** 前提斷言(規格書 §9.3):這筆單在主欄與助手欄各一顆色塊,總共 2 顆。 */
async function expectTwoBlocks(page: Page, booking: FixtureBooking): Promise<void> {
  await expect(
    blocksOf(page, booking),
    `前提:「${booking.customerName}」應該在主服務人員欄與助手欄各有一顆色塊(共 2 顆)`,
  ).toHaveCount(2, { timeout: LOAD_TIMEOUT });
  await expect(blockOf(page, booking, "main")).toHaveAttribute("data-staff-id", fixture.staffAId);
  await expect(blockOf(page, booking, "assistant")).toHaveAttribute(
    "data-staff-id",
    fixture.staffBId,
  );
}

/** 讓色塊落在視窗中間,往下拖 4 格(120px)也還在視窗內;每個手勢前都要重新量 boundingBox(版面會位移)。 */
async function centerInViewport(locator: Locator): Promise<{ x: number; y: number }> {
  await locator.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
  const box = await locator.boundingBox();
  if (!box) throw new Error("色塊量不到 boundingBox(可能沒渲染出來)");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

interface MouseDragOptions {
  /** 往下幾格(負數往上);0 = 同一列。 */
  slots: number;
  /** 放到哪一欄;不給 = 原欄。 */
  toStaffId?: string;
  /** 放開前殘影小字必須是這個(formatMoveHint 的原文),證明落點/模式正確。 */
  expectHint: string | RegExp;
}

/** 滑鼠拖拉:move → down → (第一步就 > 10px 閾值) → 多步 move → 斷言 dragging / 來源 / 小字 → up。 */
async function dragWithMouse(page: Page, block: Locator, opts: MouseDragOptions): Promise<void> {
  const start = await centerInViewport(block);
  let endX = start.x;
  if (opts.toStaffId) {
    const col = await staffGrid(page, opts.toStaffId).boundingBox();
    if (!col) throw new Error(`量不到 staff-grid-${opts.toStaffId} 的 boundingBox`);
    endX = col.x + col.width / 2;
  }
  // grabOffsetY 會被保留,所以整數格的 Y 位移剛好吸附 n 格。
  const endY = start.y + opts.slots * SLOT_PX;

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await expect(grid(page)).toHaveAttribute("data-drag-phase", "pressing");
  // 第一步就要超過 SLOT_TAP_VS_DRAG_THRESHOLD_PX(10px),否則 hook 還停在 pressing。
  await page.mouse.move(start.x + 12, start.y + (opts.slots < 0 ? -12 : 12));
  await expect(grid(page)).toHaveAttribute("data-drag-phase", "dragging");
  await page.mouse.move(endX, endY, { steps: 8 });

  await expect(block).toHaveAttribute("data-drag-source", "true");
  await expect(page.getByTestId("booking-drag-ghost")).toBeVisible();
  await expect(page.getByTestId("booking-drag-hint")).toHaveText(opts.expectHint);
  if (opts.toStaffId) {
    await expect(page.getByTestId(`staff-column-${opts.toStaffId}`)).toHaveAttribute(
      "data-drop-target",
      "true",
    );
  }
  await page.mouse.up();
}

/** 🔴 DB 斷言前一定要等 phase 回 idle(committing 期間 RPC 還在飛)。 */
async function waitForIdle(page: Page): Promise<void> {
  await expect(grid(page)).toHaveAttribute("data-drag-phase", "idle", { timeout: LOAD_TIMEOUT });
}

function toasts(page: Page): Locator {
  return page.locator("[data-sonner-toast]");
}

/**
 * 🔴 「沒有 toast」**不能**寫成 `await expect(toasts(page)).toHaveCount(0)`:那是會重試到通過為止的斷言,
 * 而 toast 只活 4 秒(錯誤)/ 8 秒(成功)。2026-09-28 做故障注入 B 時真的發生過:「無法移動」toast 明明出現了
 * (trace 的 DOM 快照裡看得到),toHaveCount(0) 等到它自動消失之後照樣通過——一條假的綠燈。
 * 改成在手勢前裝一個 MutationObserver,把「曾經出現過的每一個 toast 文字」記下來,事後一次讀出來比對。
 * openDayGrid() 最後會自動裝上,每條測試不用自己記得。
 */
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

/** 讀出 startToastRecorder() 之後曾經出現過的全部 toast 文字(含已經自動消失的)。 */
async function recordedToasts(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __e2eToastTexts?: string[] }).__e2eToastTexts ?? [],
  );
}

/** 「什麼都沒發生」:phase 回 idle、殘影消失、**從頭到尾**沒有任何 toast、一個 move_booking 請求都沒送。 */
async function expectNothingHappened(page: Page, sent: MoveBookingRpcBody[]): Promise<void> {
  await waitForIdle(page);
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId("booking-drag-ghost")).toHaveCount(0);
  expect(
    await recordedToasts(page),
    "不應該出現任何 toast(這是手勢期間曾經出現過的全部 toast 文字)",
  ).toEqual([]);
  expect(sent, "不應該送出任何 move_booking 請求").toHaveLength(0);
}

function expectSameDbState(after: BookingDbState, before: BookingDbState): void {
  expect(after.startAtMs, "start_at 不應該改變").toBe(before.startAtMs);
  expect(after.endAtMs, "end_at 不應該改變").toBe(before.endAtMs);
  expect(after.staffId, "staff_id 不應該改變").toBe(before.staffId);
  expect(after.assistantStaffIds, "助手不應該改變").toEqual(before.assistantStaffIds);
}

// ===========================================================================
// 第一組:不依賴 move_booking migration,現在就應該全綠
// ===========================================================================
test.describe("不會打 RPC 的情境(現在就應該綠)", () => {
  test("#6 已完成訂單:色塊不可拖,拖了沒有 toast、沒有 RPC、start_at 不變", async ({ page }) => {
    const booking = fixture.bookings.completed;
    const before = await readBookingDbState(booking.id);
    expect(before.status, "前提:fixture 這筆應該已經是 completed").toBe("completed");
    const sent = trackMoveBookingRequests(page);
    await openDayGrid(page);
    await expectTwoBlocks(page, booking);

    const block = blockOf(page, booking, "main");
    // 下面三個「畫面層」的檢查用 expect.soft:它們紅了不中斷,讓後面「沒有 toast / 沒有 RPC / DB 不變」
    // 這幾層真正的行為斷言也跑到,一次把每一層的結果都報出來(故障注入 B 的紅字就是這樣拿到的,見檔頭)。
    await expect
      .soft(block, "已完成的色塊應該是 cursor-default(不可拖)")
      .toHaveClass(/cursor-default/, { timeout: 2_000 });

    const start = await centerInViewport(block);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 12, start.y + 12);
    // 不可拖的色塊連 pressing 都不會進入(hook 的 canDrag 擋在 pointerdown)。
    await expect
      .soft(grid(page), "不可拖的色塊按下並移動後,phase 應該仍是 idle")
      .toHaveAttribute("data-drag-phase", "idle", { timeout: 2_000 });
    await page.mouse.move(start.x, start.y + 4 * SLOT_PX, { steps: 8 });
    await expect
      .soft(page.getByTestId("booking-drag-ghost"), "不可拖的色塊不應該出現殘影")
      .toHaveCount(0, { timeout: 2_000 });
    await page.mouse.up();

    await expectNothingHappened(page, sent);
    const after = await readBookingDbState(booking.id);
    expectSameDbState(after, before);
    expect(after.status).toBe("completed");
  });

  test("#7 #641 回歸:按下、移動 3px、放開 = 點擊 → 開詳情,start_at 不變", async ({ page }) => {
    const booking = fixture.bookings.tapNoop;
    const before = await readBookingDbState(booking.id);
    const sent = trackMoveBookingRequests(page);
    await openDayGrid(page);
    await expectTwoBlocks(page, booking);

    const block = blockOf(page, booking, "main");
    await expect(block, "可拖的色塊應該是 cursor-grab").toHaveClass(/cursor-grab/);
    const start = await centerInViewport(block);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await expect(grid(page)).toHaveAttribute("data-drag-phase", "pressing");
    await page.mouse.move(start.x + 3, start.y + 3);
    // 3px < 10px 閾值:還在 pressing,不能進 dragging。
    await expect(grid(page)).toHaveAttribute("data-drag-phase", "pressing");
    await page.mouse.up();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("預約詳情")).toBeVisible();
    await expect(dialog.getByText(booking.customerName, { exact: false })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });

    await waitForIdle(page);
    expect(sent, "點一下不應該送出 move_booking").toHaveLength(0);
    const after = await readBookingDbState(booking.id);
    expectSameDbState(after, before);
  });

  test("#8 放開在原位:進入拖拉又拖回原格 → 沒有 toast、沒有 RPC、start_at 不變", async ({
    page,
  }) => {
    const booking = fixture.bookings.tapNoop;
    const before = await readBookingDbState(booking.id);
    const sent = trackMoveBookingRequests(page);
    await openDayGrid(page);
    await expectTwoBlocks(page, booking);

    const block = blockOf(page, booking, "main");
    const start = await centerInViewport(block);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 12, start.y + 12);
    await expect(grid(page)).toHaveAttribute("data-drag-phase", "dragging");
    await page.mouse.move(start.x, start.y + SLOT_PX, { steps: 4 });
    // 正向對照:真的有進拖拉(往下一格時小字會出現),再拖回原位。
    await expect(page.getByTestId("booking-drag-hint")).toHaveText(
      `改時間 → ${minutesToTime(timeToMinutes(booking.startTime) + SLOT_MINUTES)}`,
    );
    await page.mouse.move(start.x, start.y, { steps: 4 });
    await expect(block).toHaveAttribute("data-drag-source", "true");
    await expect(page.getByTestId("booking-drag-ghost")).toBeVisible();
    // 對照表 §二 列 1:主色塊放開在原位 = 無操作,殘影旁沒有小字。
    await expect(page.getByTestId("booking-drag-hint")).toHaveCount(0);
    await page.mouse.up();

    await expectNothingHappened(page, sent);
    expectSameDbState(await readBookingDbState(booking.id), before);

    // 正向對照(讓上面「沒有 toast」的斷言有意義,automated-testing SKILL 第四節):助手色塊在**自己的欄位**內
    // 換個時間放開 = 對照表 §二 列 6 的無操作——前端會給一個輕提示 toast.info,但同樣不打 RPC。
    // 這證明 toast 記錄器真的看得到 toast(不是永遠回空陣列),也順便釘住列 6 的行為。
    const assistantNoopHint = "助手沒有自己的時間";
    await dragWithMouse(page, blockOf(page, booking, "assistant"), {
      slots: 1,
      expectHint: new RegExp(assistantNoopHint),
    });
    await waitForIdle(page);
    await expect(toasts(page).filter({ hasText: assistantNoopHint })).toBeVisible();
    const seen = await recordedToasts(page);
    expect(seen, "toast 記錄器應該剛好記到那一個輕提示").toHaveLength(1);
    expect(seen[0]).toContain(assistantNoopHint);
    expect(sent, "助手放回自己欄位不應該送出 move_booking").toHaveLength(0);
    expectSameDbState(await readBookingDbState(booking.id), before);
  });

  test("#9 375px:行事曆頁沒有被拖拉功能撐爆;短滑 = 捲動、長按才進拖拉(#641 不變)", async ({
    browser,
  }) => {
    // 為什麼不用 test.use({ ...iPhone }):不同的 fixture 選項會讓 Playwright 把這條丟到另一個 worker,
    // 那個 worker 會再跑一次 beforeAll、再建一組 fixture。這裡自己開一個手機 context,留在同一個 worker。
    // 只挑需要的欄位、不整包 spread(見 mobile-overflow.spec.ts:defaultBrowserType 會拉到沒裝的 webkit)。
    const iphone = devices["iPhone SE (3rd gen)"];
    const context = await browser.newContext({
      viewport: iphone.viewport,
      userAgent: iphone.userAgent,
      deviceScaleFactor: iphone.deviceScaleFactor,
      isMobile: iphone.isMobile,
      hasTouch: iphone.hasTouch,
      timezoneId: "Asia/Taipei",
    });
    try {
      const page = await context.newPage();
      const booking = fixture.bookings.tapNoop;
      const before = await readBookingDbState(booking.id);
      const sent = trackMoveBookingRequests(page);
      await openDayGrid(page);
      await expectTwoBlocks(page, booking);

      // (a) 版面:規格書 §9.3 #9 的主斷言。
      await assertNoHorizontalOverflow(page, "行事曆 /app/calendar 週檢視(375px,含拖拉功能)");

      // 前提:格線本身在 375px 下一定是可以橫向捲動的(min-w-[640px]),否則下面的「短滑 = 捲動」沒有意義。
      const gridEl = grid(page);
      const scrollable = await gridEl.evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(scrollable, "前提:375px 下格線容器應該可以橫向捲動").toBe(true);

      const block = blockOf(page, booking, "main");
      const cdp = await context.newCDPSession(page);

      // (b) 長按 ≥ 500ms 才進拖拉;拖拉中手指移動不會捲動格線。
      //     page.touchscreen 只有 tap,這裡用 CDP 的 Input.dispatchTouchEvent 送真正的觸控序列。
      let start = await centerInViewport(block);
      const scrollLeftBefore = await gridEl.evaluate((el) => el.scrollLeft);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: start.x, y: start.y }],
      });
      await expect(gridEl).toHaveAttribute("data-drag-phase", "pressing");
      await page.waitForTimeout(700);
      await expect(gridEl, "長按 500ms 之後應該進入 dragging").toHaveAttribute(
        "data-drag-phase",
        "dragging",
      );
      await expect(page.getByTestId("booking-drag-ghost")).toBeVisible();
      for (let i = 1; i <= 3; i++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: start.x + i * 2, y: start.y }],
        });
      }
      expect(await gridEl.evaluate((el) => el.scrollLeft), "拖拉中手指移動不應該捲動格線").toBe(
        scrollLeftBefore,
      );
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      // 只移了 6px、同一格同一欄 → 放開在原位 = 無操作。
      await expectNothingHappened(page, sent);

      // (c) 短滑(長按前就移動)= 原生捲動,不進拖拉、沒有殘影。
      start = await centerInViewport(block);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: start.x, y: start.y }],
      });
      for (let i = 1; i <= 8; i++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: start.x - i * 20, y: start.y }],
        });
      }
      // 手指還沒放開就先驗:沒有進 dragging、沒有殘影(放開之後殘影本來就會消失,那時再驗沒有意義)。
      await expect(gridEl, "短滑不應該進入 dragging").not.toHaveAttribute(
        "data-drag-phase",
        "dragging",
      );
      expect(await page.getByTestId("booking-drag-ghost").count(), "短滑不應該出現殘影").toBe(0);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect
        .poll(() => gridEl.evaluate((el) => el.scrollLeft), {
          message: "短滑應該讓格線橫向捲動(scrollLeft 變大)",
        })
        .toBeGreaterThan(scrollLeftBefore);
      await expectNothingHappened(page, sent);

      const after = await readBookingDbState(booking.id);
      expectSameDbState(after, before);
    } finally {
      await context.close();
    }
  });
});

// ===========================================================================
// 第二組:🔴 依賴 move_booking migration(SPECS-INDEX #807)。套用前 5 條都會紅在 requireMoveBookingMigration(),
//         紅字會寫明原因;**不要**改成 skip(見檔頭)。
// ===========================================================================
test.describe("會打 move_booking 的情境(migration 套用前會以明確紅字失敗)", () => {
  test("#1 規則 1:主色塊在同欄往下拖 4 格 → start_at/end_at +120 分,人員不變,成功 toast", async ({
    page,
  }) => {
    const booking = fixture.bookings.rule1;
    const before = await readBookingDbState(booking.id);
    expect(before.staffId).toBe(fixture.staffAId);
    expect(before.assistantStaffIds).toEqual([fixture.staffBId]);
    const sent = trackMoveBookingRequests(page);
    await openDayGrid(page);
    await expectTwoBlocks(page, booking);

    const targetTime = minutesToTime(timeToMinutes(booking.startTime) + 4 * SLOT_MINUTES); // 08:00 → 10:00
    await dragWithMouse(page, blockOf(page, booking, "main"), {
      slots: 4,
      expectHint: `改時間 → ${targetTime}`,
    });
    await waitForIdle(page);

    expect(sent, "應該剛好送出一次 move_booking").toHaveLength(1);
    expectRpcBody(sent[0]!, {
      bookingId: booking.id,
      draggedStaffId: fixture.staffAId,
      targetStaffId: fixture.staffAId,
      targetStartAtMs: before.startAtMs + 120 * MINUTE_MS,
      expectedStartAtMs: before.startAtMs,
      expectedStaffId: fixture.staffAId,
    });

    requireMoveBookingMigration("#1");

    await expect(
      toasts(page).filter({ hasText: `已把 ${booking.customerName} 的預約改到 ${targetTime}` }),
    ).toBeVisible();
    const after = await readBookingDbState(booking.id);
    expect(after.startAtMs, "start_at 應該 +120 分").toBe(before.startAtMs + 120 * MINUTE_MS);
    expect(after.endAtMs, "end_at 應該 +120 分").toBe(before.endAtMs + 120 * MINUTE_MS);
    expect(after.staffId, "staff_id 不應該改變").toBe(fixture.staffAId);
    expect(after.assistantStaffIds, "booking_assistants.staff_id 不應該改變").toEqual([
      fixture.staffBId,
    ]);
  });

  test("#2 規則 2:主色塊拖到第三人 C 的欄(同一列)→ staff_id = C,時間與助手不變", async ({
    page,
  }) => {
    const booking = fixture.bookings.reassignMain;
    const before = await readBookingDbState(booking.id);
    const sent = trackMoveBookingRequests(page);
    await openDayGrid(page);
    await expectTwoBlocks(page, booking);

    await dragWithMouse(page, blockOf(page, booking, "main"), {
      slots: 0,
      toStaffId: fixture.staffCId,
      expectHint: `轉派給 ${STAFF_C_NAME}`,
    });
    await waitForIdle(page);

    expect(sent).toHaveLength(1);
    expectRpcBody(sent[0]!, {
      bookingId: booking.id,
      draggedStaffId: fixture.staffAId,
      targetStaffId: fixture.staffCId,
      targetStartAtMs: before.startAtMs,
      expectedStartAtMs: before.startAtMs,
      expectedStaffId: fixture.staffAId,
    });

    requireMoveBookingMigration("#2");

    await expect(
      toasts(page).filter({ hasText: `已把 ${booking.customerName} 的預約轉派給 ${STAFF_C_NAME}` }),
    ).toBeVisible();
    const after = await readBookingDbState(booking.id);
    expect(after.staffId, "staff_id 應該變成 C").toBe(fixture.staffCId);
    expect(after.startAtMs, "start_at 不應該改變").toBe(before.startAtMs);
    expect(after.endAtMs, "end_at 不應該改變").toBe(before.endAtMs);
    expect(after.assistantStaffIds, "助手不應該改變").toEqual([fixture.staffBId]);
  });

  test("#3 規則 3:助手色塊拖到 C 欄 → booking_assistants.staff_id = C,bookings.staff_id 不變", async ({
    page,
  }) => {
    const booking = fixture.bookings.reassignAssistant;
    const before = await readBookingDbState(booking.id);
    const sent = trackMoveBookingRequests(page);
    await openDayGrid(page);
    await expectTwoBlocks(page, booking);

    await dragWithMouse(page, blockOf(page, booking, "assistant"), {
      slots: 0,
      toStaffId: fixture.staffCId,
      expectHint: `助手改為 ${STAFF_C_NAME}`,
    });
    await waitForIdle(page);

    expect(sent).toHaveLength(1);
    // 🔴 坑 4:拖助手時 expectedStaffId 是主服務人員 A,draggedStaffId 才是助手 B。
    expectRpcBody(sent[0]!, {
      bookingId: booking.id,
      draggedStaffId: fixture.staffBId,
      targetStaffId: fixture.staffCId,
      targetStartAtMs: before.startAtMs,
      expectedStartAtMs: before.startAtMs,
      expectedStaffId: fixture.staffAId,
    });

    requireMoveBookingMigration("#3");

    await expect(
      toasts(page).filter({ hasText: `${booking.customerName} 預約的助手已改為 ${STAFF_C_NAME}` }),
    ).toBeVisible();
    const after = await readBookingDbState(booking.id);
    expect(after.assistantStaffIds, "booking_assistants.staff_id 應該變成 C").toEqual([
      fixture.staffCId,
    ]);
    expect(after.staffId, "bookings.staff_id 不應該改變").toBe(fixture.staffAId);
    expect(after.startAtMs, "start_at 不應該改變").toBe(before.startAtMs);
    expect(after.endAtMs, "end_at 不應該改變").toBe(before.endAtMs);
  });

  test("#4 衝突:C 在目標時段已有預約 → 被擋,staff_id 仍是 A,toast「無法移動」含「已經有其他預約」", async ({
    page,
  }) => {
    const booking = fixture.bookings.conflict;
    const blocker = fixture.bookings.conflictBlocker;
    const before = await readBookingDbState(booking.id);
    const blockerBefore = await readBookingDbState(blocker.id);
    expect(blockerBefore.staffId, "前提:擋路單的主服務人員是 C").toBe(fixture.staffCId);
    expect(blockerBefore.startAtMs, "前提:擋路單跟被拖的單同一個時段").toBe(before.startAtMs);
    const sent = trackMoveBookingRequests(page);
    await openDayGrid(page);
    await expectTwoBlocks(page, booking);
    await expect(blocksOf(page, blocker), "前提:擋路單在 C 欄有一顆色塊").toHaveCount(1);
    await expect(blockOf(page, blocker, "main")).toHaveAttribute("data-staff-id", fixture.staffCId);

    await dragWithMouse(page, blockOf(page, booking, "main"), {
      slots: 0,
      toStaffId: fixture.staffCId,
      // 前端不知道 C 那格有單(衝突是後端才擋的),小字仍是一般的轉派提示。
      expectHint: `轉派給 ${STAFF_C_NAME}`,
    });
    await waitForIdle(page);

    expect(sent, "衝突要由後端擋,所以前端仍會送出一次 move_booking").toHaveLength(1);

    requireMoveBookingMigration("#4");

    const errorToast = toasts(page).filter({ hasText: "無法移動" });
    await expect(errorToast).toBeVisible();
    await expect(errorToast).toContainText("已經有其他預約");
    // 色塊回到原位(仍在 A 欄、不再是拖拉來源)。
    const mainBlock = blockOf(page, booking, "main");
    await expect(mainBlock).toHaveAttribute("data-staff-id", fixture.staffAId);
    await expect(mainBlock).not.toHaveAttribute("data-drag-source", "true");
    const after = await readBookingDbState(booking.id);
    expect(after.staffId, "staff_id 仍然應該是 A").toBe(fixture.staffAId);
    expectSameDbState(after, before);
  });

  test("#5 復原:改時間成功後 8 秒內按 toast 的「復原」→ start_at 回到原值", async ({ page }) => {
    const booking = fixture.bookings.undo;
    const before = await readBookingDbState(booking.id);
    const sent = trackMoveBookingRequests(page);
    await openDayGrid(page);
    await expectTwoBlocks(page, booking);

    const targetTime = minutesToTime(timeToMinutes(booking.startTime) + 4 * SLOT_MINUTES); // 12:00 → 14:00
    await dragWithMouse(page, blockOf(page, booking, "main"), {
      slots: 4,
      expectHint: `改時間 → ${targetTime}`,
    });
    await waitForIdle(page);
    expect(sent).toHaveLength(1);
    expectRpcBody(sent[0]!, {
      bookingId: booking.id,
      draggedStaffId: fixture.staffAId,
      targetStaffId: fixture.staffAId,
      targetStartAtMs: before.startAtMs + 120 * MINUTE_MS,
      expectedStartAtMs: before.startAtMs,
      expectedStaffId: fixture.staffAId,
    });

    requireMoveBookingMigration("#5");

    const successToast = toasts(page).filter({
      hasText: `已把 ${booking.customerName} 的預約改到 ${targetTime}`,
    });
    await expect(successToast).toBeVisible();
    const moved = await readBookingDbState(booking.id);
    expect(moved.startAtMs, "前提:復原前 start_at 應該已經 +120 分").toBe(
      before.startAtMs + 120 * MINUTE_MS,
    );

    await successToast.getByRole("button", { name: "復原" }).click();
    await expect(toasts(page).filter({ hasText: "已復原" })).toBeVisible();
    await expect.poll(() => sent.length, { message: "復原應該再送一次 move_booking" }).toBe(2);
    // 對照表 §三 復原輸入:target = previous.start_at、expected = next.start_at。
    expectRpcBody(sent[1]!, {
      bookingId: booking.id,
      draggedStaffId: fixture.staffAId,
      targetStaffId: fixture.staffAId,
      targetStartAtMs: before.startAtMs,
      expectedStartAtMs: before.startAtMs + 120 * MINUTE_MS,
      expectedStaffId: fixture.staffAId,
    });

    const after = await readBookingDbState(booking.id);
    expect(after.startAtMs, "start_at 應該回到原值").toBe(before.startAtMs);
    expect(after.endAtMs, "end_at 應該回到原值").toBe(before.endAtMs);
    expect(after.staffId).toBe(fixture.staffAId);
    expect(after.assistantStaffIds).toEqual([fixture.staffBId]);
  });
});

// ---------------------------------------------------------------------------
// RPC body 比對:時間欄位用毫秒比(前端送 "+08:00" 格式、get_merchant_day_schedule 回的是 "+00:00",字串不能直接比)。
// ---------------------------------------------------------------------------
function expectRpcBody(
  body: MoveBookingRpcBody,
  expected: {
    bookingId: string;
    draggedStaffId: string;
    targetStaffId: string;
    targetStartAtMs: number;
    expectedStartAtMs: number;
    expectedStaffId: string;
  },
): void {
  expect(body["p_booking_id"], "p_booking_id").toBe(expected.bookingId);
  expect(body["p_dragged_staff_id"], "p_dragged_staff_id").toBe(expected.draggedStaffId);
  expect(body["p_target_staff_id"], "p_target_staff_id").toBe(expected.targetStaffId);
  expect(body["p_expected_staff_id"], "p_expected_staff_id").toBe(expected.expectedStaffId);
  expect(
    new Date(String(body["p_target_start_at"])).getTime(),
    `p_target_start_at(送出的是 ${String(body["p_target_start_at"])})`,
  ).toBe(expected.targetStartAtMs);
  expect(
    new Date(String(body["p_expected_start_at"])).getTime(),
    `p_expected_start_at(送出的是 ${String(body["p_expected_start_at"])})`,
  ).toBe(expected.expectedStartAtMs);
}
