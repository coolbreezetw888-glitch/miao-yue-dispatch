// SPECS-INDEX #811~#817(規格書 .project/specs/行事曆拖拉改時間與轉派.md §四、§五、§八、§十一之〇)。
// 行事曆拖拉**接線層**的元件測試:用一個小小的假格線(三欄 A/B/C、跟 CalendarPage 一樣的
// data-drag-column / staff-column-* 結構)渲染**同一份** useCalendarBookingDrag + DraggableBookingBlock +
// BookingDragGhost + PastDropConfirmDialog,直接對 DOM 發 pointer 事件,驗:
//   - 點一下(≤ 閾值)開詳情、拖(> 閾值)不開詳情(坑 3:拖完瀏覽器補發的 click 不能開詳情)
//   - setPointerCapture 有被呼叫(坑 2)
//   - 拖助手時 expectedStaffId 是主服務人員、draggedStaffId 是助手欄(坑 4)
//   - 三條規則的殘影小字、助手斜拖殘影吸附回原高度(Q2 衍生邊界 2)
//   - 放開在原位不打 RPC、Escape 取消、格線外取消
//   - 成功 toast 帶「復原」、復原用 buildUndoInput 再打一次;失敗「無法移動」+ 原文;40001 額外 refetch
//   - Q3:過去時間先跳確認框
//   - 手機:長按前滑動 = 捲動(touchmove 不 preventDefault)、長按 500ms 後 = 拖(touchmove 才 preventDefault)
//
// 這裡測不到、只能瀏覽器/實機驗的(規格書 §十二 風險 2):「touchmove preventDefault 真的擋住原生捲動」
// 與「短滑動真的捲得動」—— jsdom 沒有捲動引擎;這裡只能驗「該不該 preventDefault」的判斷是對的。
//
// 【故障注入紀錄(automated-testing 第四節,2026-09-28 實際跑過;每次注入後還原並用 git diff --stat 確認乾淨)】
//   除了這裡的 jsdom 測試,同一份注入也對「真的 Chromium(Playwright,含 CDP 觸控)+ 跟 CalendarPage
//   同結構的假格線」跑過一輪(53 條瀏覽器檢查,腳本在 engineer 回報),下面一併記瀏覽器端的紅字。
//   (a) 拿掉 onBlockPointerDown 的 setPointerCapture → 1 條紅(27 綠):
//       「按下時對色塊 setPointerCapture」:expected "spy" to be called 1 times, but got 0 times
//   (b) handleDrop 的 expectedStaffId 改成 payload.source.staffId(填成被拖的那一欄)→ 1 條紅(27 綠):
//       「規則 3(坑 4)」:- "expectedStaffId": "staff-a" / + "expectedStaffId": "staff-b"
//       瀏覽器:「桌面規則3:RPC dragged=B expectedStaff=A」FAIL,p_expected_staff_id 送成 B(52/53)
//   (c) 色塊放回舊的無條件 onClick={() => openDetail(b.id)} → 1 條紅(27 綠):
//       「拖(> 10px)之後放開,瀏覽器補發的 click 不開詳情」:expected "spy" to not be called at all, but actually been called 1 times
//       瀏覽器:「拖完放開沒有開詳情(坑 3)」FAIL(log 多了 detail:t1),另外 2 條連帶 FAIL(32/35)
//   (d1) 原生 touchmove handler 改成無條件 preventDefault → 2 條紅(26 綠):
//       「① 長按前移動 > 閾值 = 捲動」與「② …touchmove 才 preventDefault」:expected true to be false
//       🔴 瀏覽器:「手機①:短滑 120px → scrollLeft 真的變大」FAIL,scrollLeft 0 → 0(這就是 #641 被弄壞的症狀,jsdom 只能驗判斷、驗不到捲動本身)
//   (d2) 原生 touchmove handler 從不 preventDefault(等同只用 React onTouchMove / 只設 touch-action)→ 1 條紅(27 綠):
//       「② …touchmove 才 preventDefault」:expected false to be true
//       🔴 瀏覽器:「手機②:長按後移動 → 殘影吸附到第 6 格」FAIL(殘影 null)、「拖動期間 phase 仍是 dragging」FAIL
//       (被 pointercancel 打斷、之後沒有任何 toast:長按後的拖拉整個被原生捲動吃掉)(45/47)
//   (f) handleDrop 拿掉 noop 守門 → 2 條紅(26 綠):
//       「列 6:助手在自己欄位上下拖」「§5.8 放開在原位」:expected "spy" to not be called at all, but actually been called 1 times
//   全部還原後 npm run test:unit 69 檔 935 條全綠(含 touchTapVsDragOpen 8 條、bookingDragMove 49 條)。

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildUndoInput, type MoveBookingResult } from "./bookingDragMove";
import type { DayScheduleOwnBooking, DayScheduleStaffBlock } from "./types";

const { moveBookingMock } = vi.hoisted(() => ({ moveBookingMock: vi.fn() }));

vi.mock("./api", () => ({ moveBooking: moveBookingMock }));

vi.mock("sonner", () => {
  const t = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  });
  return { toast: t };
});

import {
  BookingDragGhost,
  DraggableBookingBlock,
  PastDropConfirmDialog,
  useCalendarBookingDrag,
} from "./calendarBookingDrag";

// ---------------------------------------------------------------------------
// fixture:跟 pgTAP / bookingDragMove.test.ts 同一組角色:A 主、B 助手、C 第三人。
// 格線 09:00–19:00(20 格 × 30px),第 0 格頂端在視窗 y=100;三欄各 200px 寬,從 x=72 起。
// ---------------------------------------------------------------------------
const A = "staff-a";
const B = "staff-b";
const C = "staff-c";
const NAMES = new Map([
  [A, "服務人員A"],
  [B, "服務人員B"],
  [C, "服務人員C"],
]);
const SLOT_MINUTES = 30;
const SLOT_PX = 30;
const THRESHOLD = 10;
const GRID_START_MIN = 9 * 60;
const SLOT_COUNT = 20;
const GRID_TOP = 100;
const COLUMN_X: Record<string, [number, number]> = {
  [A]: [72, 272],
  [B]: [272, 472],
  [C]: [472, 672],
};

/** 2036 年的日期:永遠在未來,Q3 的「過去時間」守門不會誤觸;過去時間的案例另外用 2016 年。 */
const FUTURE_DATE = "2036-01-05";
const PAST_DATE = "2016-01-05";

function iso(dateKey: string, hhmm: string): string {
  // 用 +00:00 表達,跟 get_merchant_day_schedule 回傳 jsonb 的 timestamptz 一樣不是 +08:00 —— 這正是
  // 「timeChanged 要用 isoToTaipeiTime 轉成台北時鐘再比」的原因。
  return new Date(`${dateKey}T${hhmm}:00+08:00`).toISOString().replace(".000Z", "+00:00");
}

function booking(
  id: string,
  role: "main" | "assistant",
  start: string,
  end: string,
  dateKey: string,
  over: Partial<DayScheduleOwnBooking> = {},
): DayScheduleOwnBooking {
  return {
    id,
    start_at: iso(dateKey, start),
    end_at: iso(dateKey, end),
    status: "accepted",
    customer_name: "陳小姐",
    customer_phone: "0912345678",
    notes: null,
    role,
    service_items: [],
    ...over,
  };
}

function staffBlock(staffId: string, bookings: DayScheduleOwnBooking[]): DayScheduleStaffBlock {
  return {
    staff_id: staffId,
    staff_name: NAMES.get(staffId)!,
    unlimited_backend_edit: false,
    available_windows: [],
    availability_overrides: [],
    on_leave: null,
    bookings,
    foreign_bookings: [],
  };
}

/** T1:A 主 + B 助手 10:00–11:00(在 A 欄一顆 main、B 欄一顆 assistant);T2:A 的已完成單 13:00–14:00。 */
function makeSchedule(dateKey: string): DayScheduleStaffBlock[] {
  return [
    staffBlock(A, [
      booking("t1", "main", "10:00", "11:00", dateKey),
      booking("t2", "main", "13:00", "14:00", dateKey, {
        status: "completed",
        customer_name: "王先生",
      }),
    ]),
    staffBlock(B, [booking("t1", "assistant", "10:00", "11:00", dateKey)]),
    staffBlock(C, []),
  ];
}

function Harness({
  dateKey,
  staffBlocks,
  onOpenDetail,
  onMoved,
}: {
  dateKey: string;
  staffBlocks: DayScheduleStaffBlock[];
  onOpenDetail: (id: string, opener: { role: "main" | "assistant"; staffId: string }) => void;
  onMoved: () => void;
}) {
  const controller = useCalendarBookingDrag({
    dateKey,
    staffBlocks,
    staffNameById: NAMES,
    gridStartMin: GRID_START_MIN,
    slotCount: SLOT_COUNT,
    slotMinutes: SLOT_MINUTES,
    slotPx: SLOT_PX,
    thresholdPx: THRESHOLD,
    onOpenDetail,
    onMoved,
  });
  return (
    <>
      <div
        ref={controller.setGridRoot}
        data-testid="grid-root"
        data-drag-phase={controller.phase}
        data-committing={controller.isCommitting ? "true" : undefined}
      >
        {staffBlocks.map((s) => (
          <div
            key={s.staff_id}
            data-testid={`staff-column-${s.staff_id}`}
            data-drop-target={controller.highlightedStaffId === s.staff_id ? "true" : undefined}
          >
            <div data-drag-column={s.staff_id} data-testid={`staff-grid-${s.staff_id}`}>
              {s.bookings.map((b) => {
                const startMin =
                  Number(b.start_at.slice(11, 13)) * 60 + 8 * 60 + Number(b.start_at.slice(14, 16));
                const endMin =
                  Number(b.end_at.slice(11, 13)) * 60 + 8 * 60 + Number(b.end_at.slice(14, 16));
                const top = ((startMin - GRID_START_MIN) / SLOT_MINUTES) * SLOT_PX;
                const height = ((endMin - startMin) / SLOT_MINUTES) * SLOT_PX;
                return (
                  <DraggableBookingBlock
                    key={b.id}
                    booking={b}
                    staffId={s.staff_id}
                    style={{ top, height }}
                    controller={controller}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <BookingDragGhost ghost={controller.ghost} />
      <PastDropConfirmDialog
        request={controller.pastConfirm}
        onResolve={controller.resolvePastConfirm}
      />
    </>
  );
}

// jsdom 沒有版面引擎:用 data 屬性 / inline style 算出每個元素「應該」在哪。
function fakeRect(el: Element): DOMRect {
  const make = (left: number, top: number, width: number, height: number): DOMRect =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  const column = (el as HTMLElement).dataset?.["dragColumn"];
  if (column && COLUMN_X[column]) {
    const [l, r] = COLUMN_X[column]!;
    return make(l, GRID_TOP, r - l, SLOT_COUNT * SLOT_PX);
  }
  const bookingId = (el as HTMLElement).dataset?.["bookingId"];
  if (bookingId) {
    const col = el.closest<HTMLElement>("[data-drag-column]");
    const staffId = col?.dataset["dragColumn"] ?? A;
    const [l, r] = COLUMN_X[staffId]!;
    const style = (el as HTMLElement).style;
    return make(
      l,
      GRID_TOP + parseFloat(style.top || "0"),
      r - l,
      parseFloat(style.height || "30"),
    );
  }
  if ((el as HTMLElement).dataset?.["testid"] === "grid-root") return make(72, 64, 600, 700);
  return make(0, 0, 0, 0);
}

const T1_MAIN_CENTER = { x: 172, y: 190 }; // A 欄 10:00–11:00 的色塊中心(top 160、高 60)
const T1_ASSISTANT_CENTER = { x: 372, y: 190 };

/** 組 pointer 事件的 init;`x` / `y` 是 clientX / clientY 的簡寫(讓 T1_MAIN_CENTER 這種座標常數可以直接餵)。 */
function ptr(
  over: Partial<{
    pointerType: string;
    clientX: number;
    clientY: number;
    x: number;
    y: number;
    button: number;
  }>,
) {
  const { x, y, ...rest } = over;
  return {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    clientX: x ?? 0,
    clientY: y ?? 0,
    ...rest,
  };
}

function mainBlock() {
  return screen.getByTestId("booking-block-t1-main");
}
function assistantBlock() {
  return screen.getByTestId("booking-block-t1-assistant");
}

/** 滑鼠拖:按下 → 移到 (x, y) → 放開 → 補一個瀏覽器一定會發的 click(坑 3 就是靠這個 click 抓的)。 */
function mouseDrag(el: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  fireEvent.pointerDown(el, ptr({ clientX: from.x, clientY: from.y }));
  fireEvent.pointerMove(el, ptr({ clientX: to.x, clientY: to.y }));
  fireEvent.pointerUp(el, ptr({ clientX: to.x, clientY: to.y }));
  fireEvent.click(el);
}

function makeResult(over: Partial<MoveBookingResult> = {}): MoveBookingResult {
  return {
    mode: "time",
    booking: { id: "t1", merchant_id: "m1" },
    previous: {
      start_at: iso(FUTURE_DATE, "10:00"),
      end_at: iso(FUTURE_DATE, "11:00"),
      staff_id: A,
      assistant_staff_id: B,
    },
    next: {
      start_at: iso(FUTURE_DATE, "12:00"),
      end_at: iso(FUTURE_DATE, "13:00"),
      staff_id: A,
      assistant_staff_id: B,
    },
    time_changed: true,
    staff_changed: false,
    ...over,
  };
}

let onOpenDetail: ReturnType<typeof vi.fn>;
let onMoved: ReturnType<typeof vi.fn>;
let setPointerCaptureSpy: ReturnType<typeof vi.fn>;

function renderHarness(dateKey = FUTURE_DATE, blocks = makeSchedule(dateKey)) {
  return render(
    <Harness
      dateKey={dateKey}
      staffBlocks={blocks}
      onOpenDetail={onOpenDetail}
      onMoved={onMoved}
    />,
  );
}

beforeAll(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return fakeRect(this);
  });
  // jsdom 沒有 pointer capture API(Radix 也會摸 hasPointerCapture),補上可觀察的 stub。
  setPointerCaptureSpy = vi.fn();
  Object.defineProperty(Element.prototype, "setPointerCapture", {
    configurable: true,
    writable: true,
    value: setPointerCaptureSpy,
  });
  Object.defineProperty(Element.prototype, "releasePointerCapture", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  Object.defineProperty(Element.prototype, "hasPointerCapture", {
    configurable: true,
    writable: true,
    value: () => false,
  });
});

beforeEach(() => {
  onOpenDetail = vi.fn();
  onMoved = vi.fn();
  moveBookingMock.mockReset();
  moveBookingMock.mockResolvedValue(makeResult());
  setPointerCaptureSpy.mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.info).mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ===========================================================================
describe("點擊 vs 拖曳(#812;坑 2、坑 3)", () => {
  it("按下後移動 ≤ 10px 就放開 = 點擊 → 開詳情,不打 RPC", () => {
    renderHarness();
    mouseDrag(mainBlock(), T1_MAIN_CENTER, { x: 175, y: 195 });
    expect(onOpenDetail).toHaveBeenCalledWith("t1", { role: "main", staffId: A });
    expect(moveBookingMock).not.toHaveBeenCalled();
  });

  // SPECS-INDEX #873:從「(協助)」色塊點開詳情時,要告訴詳情「是協助卡、是哪一欄」,
  // 詳情才會給「移除協助人員」而不是「取消預約」(原本只傳 booking id,協助卡按取消 = 整張單被取消)。
  it("#873 點「(協助)」色塊 → 開詳情時帶 role=assistant + 那一欄的服務人員 id", () => {
    renderHarness();
    mouseDrag(assistantBlock(), T1_ASSISTANT_CENTER, {
      x: T1_ASSISTANT_CENTER.x + 3,
      y: T1_ASSISTANT_CENTER.y + 3,
    });
    expect(onOpenDetail).toHaveBeenCalledWith("t1", { role: "assistant", staffId: B });
    expect(moveBookingMock).not.toHaveBeenCalled();
  });

  it("拖(> 10px)之後放開,瀏覽器補發的 click **不**開詳情(坑 3:色塊沒有舊的 onClick)", async () => {
    renderHarness();
    mouseDrag(mainBlock(), T1_MAIN_CENTER, { x: 172, y: 310 });
    await waitFor(() => expect(moveBookingMock).toHaveBeenCalledTimes(1));
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("按下時對色塊 setPointerCapture(坑 2:游標離開色塊仍收得到 pointermove / pointerup)", () => {
    renderHarness();
    fireEvent.pointerDown(
      mainBlock(),
      ptr({ clientX: T1_MAIN_CENTER.x, clientY: T1_MAIN_CENTER.y }),
    );
    expect(setPointerCaptureSpy).toHaveBeenCalledTimes(1);
    expect(setPointerCaptureSpy).toHaveBeenCalledWith(1);
    fireEvent.pointerUp(mainBlock(), ptr(T1_MAIN_CENTER));
  });

  it("已完成的色塊:cursor-default、按下不進入 pressing、不 capture;點一下仍照舊開詳情(§5.1)", () => {
    renderHarness();
    const done = screen.getByTestId("booking-block-t2-main");
    expect(done.className).toContain("cursor-default");
    expect(mainBlock().className).toContain("cursor-grab");
    fireEvent.pointerDown(done, ptr({ clientX: 172, clientY: 250 }));
    fireEvent.pointerMove(done, ptr({ clientX: 172, clientY: 400 }));
    fireEvent.pointerUp(done, ptr({ clientX: 172, clientY: 400 }));
    expect(screen.getByTestId("grid-root").dataset["dragPhase"]).toBe("idle");
    expect(setPointerCaptureSpy).not.toHaveBeenCalled();
    expect(moveBookingMock).not.toHaveBeenCalled();
    fireEvent.click(done);
    expect(onOpenDetail).toHaveBeenCalledWith("t2", { role: "main", staffId: A });
  });

  it("滑鼠右鍵按下不啟動拖拉", () => {
    renderHarness();
    fireEvent.pointerDown(mainBlock(), ptr({ ...T1_MAIN_CENTER, button: 2 }));
    expect(screen.getByTestId("grid-root").dataset["dragPhase"]).toBe("idle");
  });
});

// ===========================================================================
describe("三條規則的落點與送出的 MoveBookingInput(#811 #813;坑 4、坑 5)", () => {
  it("規則 1:主色塊在同一欄往下拖 4 格 → mode time,targetStartAt = 12:00(+08:00),expected 用畫面上的舊值", async () => {
    renderHarness();
    const el = mainBlock();
    fireEvent.pointerDown(el, ptr(T1_MAIN_CENTER));
    fireEvent.pointerMove(el, ptr({ clientX: 172, clientY: 310 }));
    // 拖拉中:殘影吸附到第 6 格(top 100 + 6×30 = 280)、小字「改時間 → 12:00」、A 欄高亮、原色塊 opacity-40。
    const ghost = screen.getByTestId("booking-drag-ghost");
    expect(ghost.style.top).toBe("280px");
    expect(ghost.style.left).toBe("72px");
    expect(screen.getByTestId("booking-drag-hint")).toHaveTextContent("改時間 → 12:00");
    expect(screen.getByTestId(`staff-column-${A}`).dataset["dropTarget"]).toBe("true");
    expect(el.dataset["dragSource"]).toBe("true");
    expect(document.body.style.userSelect).toBe("none");

    fireEvent.pointerUp(el, ptr({ clientX: 172, clientY: 310 }));
    await waitFor(() => expect(moveBookingMock).toHaveBeenCalledTimes(1));
    expect(moveBookingMock.mock.calls[0]![0]).toEqual({
      bookingId: "t1",
      draggedStaffId: A,
      targetStaffId: A,
      targetStartAt: `${FUTURE_DATE}T12:00:00+08:00`,
      expectedStartAt: iso(FUTURE_DATE, "10:00"),
      expectedStaffId: A,
    });
    expect(moveBookingMock.mock.calls[0]![1]).toEqual({ targetStaffName: "服務人員A" });
    await waitFor(() => expect(onMoved).toHaveBeenCalledTimes(1));
    // #963:onMoved 被呼叫時,拖拉狀態機還停在 committing(isDragging 仍是 true)——要等 handleDrop 的
    // Promise 結束 → commit(IDLE) → React 重新渲染 → effect 清掉 userSelect。這一串是在 act 之外、由
    // React 排程器(Node 的 setImmediate)跑的,跟 waitFor 收尾的 setTimeout(0) 誰先誰後不固定 ⇒
    // 原本這裡「立刻」斷言 userSelect === "" 偶爾會讀到還沒清掉的 "none"。改成等狀態真的回到 idle。
    await waitFor(() => expect(screen.getByTestId("grid-root").dataset["dragPhase"]).toBe("idle"));
    await waitFor(() => expect(document.body.style.userSelect).toBe(""));
  });

  it("規則 2:主色塊拖到 C 欄同一列 → 小字「轉派給 服務人員C」,targetStaffId = C、時間不變", async () => {
    renderHarness();
    const el = mainBlock();
    fireEvent.pointerDown(el, ptr(T1_MAIN_CENTER));
    fireEvent.pointerMove(el, ptr({ clientX: 572, clientY: 190 }));
    expect(screen.getByTestId("booking-drag-hint")).toHaveTextContent("轉派給 服務人員C");
    expect(screen.getByTestId("booking-drag-hint").textContent).not.toContain("並改時間");
    expect(screen.getByTestId(`staff-column-${C}`).dataset["dropTarget"]).toBe("true");
    fireEvent.pointerUp(el, ptr({ clientX: 572, clientY: 190 }));
    await waitFor(() => expect(moveBookingMock).toHaveBeenCalledTimes(1));
    expect(moveBookingMock.mock.calls[0]![0]).toMatchObject({
      draggedStaffId: A,
      targetStaffId: C,
      targetStartAt: `${FUTURE_DATE}T10:00:00+08:00`,
      expectedStaffId: A,
    });
  });

  it("Q1=B 斜拖:主色塊拖到 C 欄 + 往下 2 格 → 小字「轉派給 服務人員C,並改時間 → 11:00」", async () => {
    renderHarness();
    const el = mainBlock();
    fireEvent.pointerDown(el, ptr(T1_MAIN_CENTER));
    fireEvent.pointerMove(el, ptr({ clientX: 572, clientY: 250 }));
    expect(screen.getByTestId("booking-drag-hint")).toHaveTextContent(
      "轉派給 服務人員C,並改時間 → 11:00",
    );
    expect(screen.getByTestId("booking-drag-ghost").style.top).toBe("220px");
    fireEvent.pointerUp(el, ptr({ clientX: 572, clientY: 250 }));
    await waitFor(() => expect(moveBookingMock).toHaveBeenCalledTimes(1));
    expect(moveBookingMock.mock.calls[0]![0]).toMatchObject({
      targetStaffId: C,
      targetStartAt: `${FUTURE_DATE}T11:00:00+08:00`,
    });
  });

  it("規則 3(坑 4):拖 B 欄的助手色塊到 C 欄 → draggedStaffId = B、expectedStaffId = **A(主服務人員)**", async () => {
    renderHarness();
    const el = assistantBlock();
    fireEvent.pointerDown(el, ptr(T1_ASSISTANT_CENTER));
    // 斜拖(往下 2 格):殘影要吸附回**原本的高度**(top 160),小字只講換人(Q2 衍生邊界 2)。
    fireEvent.pointerMove(el, ptr({ clientX: 572, clientY: 250 }));
    expect(screen.getByTestId("booking-drag-hint")).toHaveTextContent("助手改為 服務人員C");
    expect(screen.getByTestId("booking-drag-ghost").style.top).toBe("160px");
    fireEvent.pointerUp(el, ptr({ clientX: 572, clientY: 250 }));
    await waitFor(() => expect(moveBookingMock).toHaveBeenCalledTimes(1));
    expect(moveBookingMock.mock.calls[0]![0]).toEqual({
      bookingId: "t1",
      draggedStaffId: B,
      targetStaffId: C,
      targetStartAt: `${FUTURE_DATE}T11:00:00+08:00`,
      expectedStartAt: iso(FUTURE_DATE, "10:00"),
      expectedStaffId: A,
    });
  });

  it("Q5=A:主色塊拖到本單助手 B 的欄位 → 小字 ❌、欄位高亮成警示、放開不打 RPC", () => {
    renderHarness();
    const el = mainBlock();
    fireEvent.pointerDown(el, ptr(T1_MAIN_CENTER));
    fireEvent.pointerMove(el, ptr({ clientX: 372, clientY: 190 }));
    expect(screen.getByTestId("booking-drag-hint")).toHaveTextContent("❌ 服務人員B已經是助手");
    fireEvent.pointerUp(el, ptr({ clientX: 372, clientY: 190 }));
    expect(moveBookingMock).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("列 6:助手色塊在自己欄位上下拖 → 無操作,不打 RPC,只給輕提示", () => {
    renderHarness();
    const el = assistantBlock();
    fireEvent.pointerDown(el, ptr(T1_ASSISTANT_CENTER));
    fireEvent.pointerMove(el, ptr({ clientX: 372, clientY: 310 }));
    expect(screen.getByTestId("booking-drag-hint")).toHaveTextContent("助手沒有自己的時間");
    fireEvent.pointerUp(el, ptr({ clientX: 372, clientY: 310 }));
    expect(moveBookingMock).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("助手沒有自己的時間,要改時間請拖主服務人員的色塊");
  });

  it("坑 5:10:10 起的單放回「原位」也算 timeChanged(吸附到 10:00),會打 RPC —— 這是規格書 §七 的預期行為", async () => {
    const blocks = makeSchedule(FUTURE_DATE);
    blocks[0]!.bookings[0] = booking("t1", "main", "10:10", "11:10", FUTURE_DATE);
    blocks[1]!.bookings[0] = booking("t1", "assistant", "10:10", "11:10", FUTURE_DATE);
    renderHarness(FUTURE_DATE, blocks);
    const el = mainBlock();
    // 色塊 top = 170;抓中心 (172, 200);拖 12px 再拖回原位放開。
    fireEvent.pointerDown(el, ptr({ clientX: 172, clientY: 200 }));
    fireEvent.pointerMove(el, ptr({ clientX: 172, clientY: 215 }));
    fireEvent.pointerMove(el, ptr({ clientX: 172, clientY: 200 }));
    expect(screen.getByTestId("booking-drag-hint")).toHaveTextContent("改時間 → 10:00");
    fireEvent.pointerUp(el, ptr({ clientX: 172, clientY: 200 }));
    await waitFor(() => expect(moveBookingMock).toHaveBeenCalledTimes(1));
    expect(moveBookingMock.mock.calls[0]![0]).toMatchObject({
      targetStartAt: `${FUTURE_DATE}T10:00:00+08:00`,
    });
  });
});

// ===========================================================================
describe("取消路徑(§5.6 §5.7 §5.8)", () => {
  it("§5.8 放開在原位(先拖出去再拖回來)→ 不打 RPC、不 toast、殘影消失", () => {
    renderHarness();
    const el = mainBlock();
    fireEvent.pointerDown(el, ptr(T1_MAIN_CENTER));
    fireEvent.pointerMove(el, ptr({ clientX: 172, clientY: 240 }));
    expect(screen.getByTestId("booking-drag-ghost")).toBeInTheDocument();
    fireEvent.pointerMove(el, ptr(T1_MAIN_CENTER));
    // 列 1:放開在原位不顯示小字。
    expect(screen.queryByTestId("booking-drag-hint")).toBeNull();
    fireEvent.pointerUp(el, ptr(T1_MAIN_CENTER));
    expect(moveBookingMock).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    expect(screen.queryByTestId("booking-drag-ghost")).toBeNull();
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("§5.6 Escape → 取消、殘影消失、之後放開不打 RPC", () => {
    renderHarness();
    const el = mainBlock();
    fireEvent.pointerDown(el, ptr(T1_MAIN_CENTER));
    fireEvent.pointerMove(el, ptr({ clientX: 172, clientY: 310 }));
    expect(screen.getByTestId("booking-drag-ghost")).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(screen.queryByTestId("booking-drag-ghost")).toBeNull();
    expect(screen.getByTestId("grid-root").dataset["dragPhase"]).toBe("idle");
    fireEvent.pointerUp(el, ptr({ clientX: 172, clientY: 310 }));
    expect(moveBookingMock).not.toHaveBeenCalled();
  });

  it("§5.6 pointercancel → 取消", () => {
    renderHarness();
    const el = mainBlock();
    fireEvent.pointerDown(el, ptr(T1_MAIN_CENTER));
    fireEvent.pointerMove(el, ptr({ clientX: 172, clientY: 310 }));
    fireEvent.pointerCancel(el, ptr({ clientX: 172, clientY: 310 }));
    expect(screen.getByTestId("grid-root").dataset["dragPhase"]).toBe("idle");
    expect(moveBookingMock).not.toHaveBeenCalled();
  });

  it("§5.7 放開在格線外(左邊時間軸 x=30)→ 殘影小字「放開會取消」、不打 RPC", () => {
    renderHarness();
    const el = mainBlock();
    fireEvent.pointerDown(el, ptr(T1_MAIN_CENTER));
    fireEvent.pointerMove(el, ptr({ clientX: 30, clientY: 310 }));
    expect(screen.getByTestId("booking-drag-hint")).toHaveTextContent("放開會取消");
    fireEvent.pointerUp(el, ptr({ clientX: 30, clientY: 310 }));
    expect(moveBookingMock).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

// ===========================================================================
describe("成功 / 失敗 / 復原(#814 #815)", () => {
  it("成功:refetch、toast.success 帶客戶姓名與時間、8 秒、附「復原」;committing 期間格線 pointer-events-none", async () => {
    let resolveMove!: (r: MoveBookingResult) => void;
    moveBookingMock.mockImplementationOnce(
      () => new Promise<MoveBookingResult>((resolve) => (resolveMove = resolve)),
    );
    renderHarness();
    const el = mainBlock();
    fireEvent.pointerDown(el, ptr(T1_MAIN_CENTER));
    fireEvent.pointerMove(el, ptr({ clientX: 172, clientY: 310 }));
    fireEvent.pointerUp(el, ptr({ clientX: 172, clientY: 310 }));

    // §5.9 / §四 [3]:committing —— 殘影停在目標格標「移動中…」,格線 pointer-events-none。
    await waitFor(() =>
      expect(screen.getByTestId("grid-root").dataset["dragPhase"]).toBe("committing"),
    );
    expect(screen.getByTestId("grid-root").dataset["committing"]).toBe("true");
    expect(screen.getByTestId("booking-drag-ghost").dataset["dragCommitting"]).toBe("true");
    expect(screen.getByTestId("booking-drag-hint")).toHaveTextContent("移動中…");

    await act(async () => {
      resolveMove(makeResult());
    });
    await waitFor(() => expect(screen.getByTestId("grid-root").dataset["dragPhase"]).toBe("idle"));
    expect(screen.queryByTestId("booking-drag-ghost")).toBeNull();
    expect(onMoved).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
    const [message, options] = vi.mocked(toast.success).mock.calls[0]!;
    expect(message).toBe("已把 陳小姐 的預約改到 12:00");
    expect(options).toMatchObject({ duration: 8000, action: { label: "復原" } });
  });

  it("toast 文案:reassign_main / 斜拖 / reassign_assistant 三種", async () => {
    renderHarness();
    const el = mainBlock();
    moveBookingMock.mockResolvedValueOnce(
      makeResult({
        mode: "reassign_main",
        time_changed: false,
        staff_changed: true,
        next: { ...makeResult().previous, staff_id: C },
      }),
    );
    mouseDrag(el, T1_MAIN_CENTER, { x: 572, y: 190 });
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(vi.mocked(toast.success).mock.calls[0]![0]).toBe("已把 陳小姐 的預約轉派給 服務人員C");

    moveBookingMock.mockResolvedValueOnce(
      makeResult({
        mode: "reassign_main",
        time_changed: true,
        staff_changed: true,
        next: { ...makeResult().next, staff_id: C, start_at: iso(FUTURE_DATE, "11:00") },
      }),
    );
    mouseDrag(el, T1_MAIN_CENTER, { x: 572, y: 250 });
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));
    expect(vi.mocked(toast.success).mock.calls[1]![0]).toBe(
      "已把 陳小姐 的預約轉派給 服務人員C,並改到 11:00",
    );

    moveBookingMock.mockResolvedValueOnce(
      makeResult({
        mode: "reassign_assistant",
        time_changed: false,
        staff_changed: true,
        next: { ...makeResult().previous, assistant_staff_id: C },
      }),
    );
    mouseDrag(assistantBlock(), T1_ASSISTANT_CENTER, { x: 572, y: 190 });
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(3));
    expect(vi.mocked(toast.success).mock.calls[2]![0]).toBe("陳小姐 預約的助手已改為 服務人員C");
  });

  it("復原:按 toast 的「復原」→ 用 buildUndoInput(result) 再打一次 move_booking,成功 toast「已復原」", async () => {
    const result = makeResult();
    moveBookingMock.mockResolvedValueOnce(result);
    renderHarness();
    mouseDrag(mainBlock(), T1_MAIN_CENTER, { x: 172, y: 310 });
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const options = vi.mocked(toast.success).mock.calls[0]![1] as unknown as {
      action: { onClick: () => void };
    };
    moveBookingMock.mockResolvedValueOnce(
      makeResult({ previous: result.next, next: result.previous }),
    );
    await act(async () => {
      options.action.onClick();
    });
    await waitFor(() => expect(moveBookingMock).toHaveBeenCalledTimes(2));
    expect(moveBookingMock.mock.calls[1]![0]).toEqual(buildUndoInput(result));
    // 復原時 targetStaffId = previous.staff_id = A,推播文案用的名字也要對。
    expect(moveBookingMock.mock.calls[1]![1]).toEqual({ targetStaffName: "服務人員A" });
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));
    expect(vi.mocked(toast.success).mock.calls[1]![0]).toBe("已復原");
    expect(onMoved).toHaveBeenCalledTimes(2);
  });

  it("失敗(一般錯誤):toast.error 標題「無法移動」+ 後端訊息原文;不 refetch;回到 idle", async () => {
    moveBookingMock.mockRejectedValueOnce({
      code: "P0001",
      message: "助手「服務人員B」在這個時段已經有其他預約",
    });
    renderHarness();
    mouseDrag(mainBlock(), T1_MAIN_CENTER, { x: 172, y: 310 });
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith("無法移動", {
      description: "助手「服務人員B」在這個時段已經有其他預約",
    });
    expect(onMoved).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("grid-root").dataset["dragPhase"]).toBe("idle"));
    expect(screen.queryByTestId("booking-drag-ghost")).toBeNull();
  });

  it("失敗(40001 畫面過期):toast.warning + 額外 refetch", async () => {
    moveBookingMock.mockRejectedValueOnce({
      code: "40001",
      message: "這筆預約剛剛被其他人改過,畫面已重新整理,請再拖一次",
    });
    renderHarness();
    mouseDrag(mainBlock(), T1_MAIN_CENTER, { x: 172, y: 310 });
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(toast.warning).toHaveBeenCalledWith(
      "這筆預約剛剛被其他人改過,畫面已重新整理,請再拖一次",
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(onMoved).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
describe("Q3=B:拖到過去的時間先確認(#816)", () => {
  it("取消 → 不打 RPC、回到 idle", async () => {
    renderHarness(PAST_DATE);
    mouseDrag(mainBlock(), T1_MAIN_CENTER, { x: 172, y: 310 });
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("你正在把 陳小姐 的預約移到已經過去的 12:00");
    expect(moveBookingMock).not.toHaveBeenCalled();
    // 等待確認期間仍是 committing(格線鎖住,避免連續拖兩次)。
    expect(screen.getByTestId("grid-root").dataset["dragPhase"]).toBe("committing");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.getByTestId("grid-root").dataset["dragPhase"]).toBe("idle"));
    expect(moveBookingMock).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("確定 → 才打 RPC", async () => {
    renderHarness(PAST_DATE);
    mouseDrag(mainBlock(), T1_MAIN_CENTER, { x: 172, y: 310 });
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "確定移動" }));
    await waitFor(() => expect(moveBookingMock).toHaveBeenCalledTimes(1));
    expect(moveBookingMock.mock.calls[0]![0]).toMatchObject({
      targetStartAt: `${PAST_DATE}T12:00:00+08:00`,
    });
  });

  it("純轉派(時間沒變)即使日期在過去也不問 —— isDropInPast 只看 timeChanged", async () => {
    renderHarness(PAST_DATE);
    mouseDrag(mainBlock(), T1_MAIN_CENTER, { x: 572, y: 190 });
    await waitFor(() => expect(moveBookingMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

// ===========================================================================
describe("手機觸控:長按才拖,長按前滑動 = 捲動(#817 Q4=B;坑 1、坑 6)", () => {
  function touchmoveOn(el: HTMLElement): boolean {
    const ev = new Event("touchmove", { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  }

  it("① 長按前手指移動 > 閾值 = 捲動:不進入拖拉、touchmove **不** preventDefault、放開也不開詳情", () => {
    vi.useFakeTimers();
    renderHarness();
    const el = mainBlock();
    fireEvent.pointerDown(el, ptr({ pointerType: "touch", ...T1_MAIN_CENTER }));
    expect(touchmoveOn(el)).toBe(false); // pressing 期間放行原生捲動
    fireEvent.pointerMove(el, ptr({ pointerType: "touch", clientX: 212, clientY: 190 }));
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByTestId("grid-root").dataset["dragPhase"]).toBe("pressing");
    expect(touchmoveOn(el)).toBe(false);
    expect(screen.queryByTestId("booking-drag-ghost")).toBeNull();
    fireEvent.pointerUp(el, ptr({ pointerType: "touch", clientX: 212, clientY: 190 }));
    expect(onOpenDetail).not.toHaveBeenCalled();
    expect(moveBookingMock).not.toHaveBeenCalled();
  });

  it("② 按住不動 500ms → 進入拖拉(殘影浮起),之後 touchmove 才 preventDefault,移動放開 → 打 RPC", async () => {
    vi.useFakeTimers();
    renderHarness();
    const el = mainBlock();
    fireEvent.pointerDown(el, ptr({ pointerType: "touch", ...T1_MAIN_CENTER }));
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(screen.getByTestId("grid-root").dataset["dragPhase"]).toBe("pressing");
    expect(touchmoveOn(el)).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("grid-root").dataset["dragPhase"]).toBe("dragging");
    // 浮起:殘影本體 scale-[1.03]。
    expect(screen.getByTestId("booking-drag-ghost").firstElementChild?.className).toContain(
      "scale-[1.03]",
    );
    expect(touchmoveOn(el)).toBe(true); // 🔴 只有 dragging 才擋原生捲動
    fireEvent.pointerMove(el, ptr({ pointerType: "touch", clientX: 172, clientY: 310 }));
    expect(screen.getByTestId("booking-drag-hint")).toHaveTextContent("改時間 → 12:00");
    fireEvent.pointerUp(el, ptr({ pointerType: "touch", clientX: 172, clientY: 310 }));
    vi.useRealTimers();
    await waitFor(() => expect(moveBookingMock).toHaveBeenCalledTimes(1));
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("觸控點一下(沒滿 500ms 就放開)= 點擊 → 開詳情", () => {
    vi.useFakeTimers();
    renderHarness();
    const el = mainBlock();
    fireEvent.pointerDown(el, ptr({ pointerType: "touch", ...T1_MAIN_CENTER }));
    act(() => {
      vi.advanceTimersByTime(120);
    });
    fireEvent.pointerUp(el, ptr({ pointerType: "touch", ...T1_MAIN_CENTER }));
    expect(onOpenDetail).toHaveBeenCalledWith("t1", { role: "main", staffId: A });
  });

  it("坑 6:色塊 contextmenu 被 preventDefault,且有 select-none / -webkit-touch-callout 靜態 class", () => {
    renderHarness();
    const el = mainBlock();
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(el.className).toContain("select-none");
    expect(el.className).toContain("[-webkit-touch-callout:none]");
  });
});
