// SPECS-INDEX #977 第 7 批(2026-10-07):服務人員端時間軸「點空白格子」選單(裁決 1 / 2,方案 B2)。
//   ・開關沒生效(orderActions = null)⇒ 完全維持唯讀,沒有任何可點的格子
//   ・生效 ⇒ 可預約的格子選單有「新增預約」(+ B2 的人才有「關閉時段」);不可預約的格子只有「開啟時段」
//     (B2 以外的人不可預約的格子連選單都沒有)
//   ・按下去移動超過 10px(= 捲動)不開選單(#641 同一套判斷)
//   ・選單「關閉時段」⇒ staffSetMySlot(只能動自己,staffId 固定)
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const staffSetMySlotMock = vi.fn(async () => 0);

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({}), rpc: () => ({}), channel: () => ({}) },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    staffSetMySlot: (...args: unknown[]) => staffSetMySlotMock(...(args as [])),
    staffMoveBooking: vi.fn(),
  };
});

vi.mock("./context", () => ({
  useMyDayBusinessHours: () => ({
    data: { has_setting: true, is_closed: false, open_time: "09:00:00", close_time: "11:00:00" },
    isLoading: false,
  }),
  useMyDayScheduleState: () => ({
    data: {
      on_leave: null,
      // 10:30 這一格被排休(單日例外關閉)
      availability_overrides: [
        { start_time: "10:30:00", end_time: "11:00:00", is_available: false },
      ],
      foreign_bookings: [],
    },
  }),
  useMyCalendarStateStyles: () => ({ data: undefined }),
  useMyBookingStatusColors: () => ({ data: undefined }),
}));

vi.mock("@/modules/booking/context", () => ({
  // 每週三 09:00–10:00 可預約(2036-03-12 是星期三)
  useStaffAvailabilityWindows: (staffId: string | null) => ({
    data: staffId ? [{ day_of_week: 3, start_time: "09:00:00", end_time: "10:00:00" }] : undefined,
  }),
}));

import { MyCalendarTimelineView, type MyTimelineOrderActions } from "./MyCalendarTimelineView";

const STAFF_ID = "33333333-3333-4333-8333-333333333333";

function renderView(orderActions: MyTimelineOrderActions | null) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MyCalendarTimelineView
        staffId={STAFF_ID}
        selectedDateKey="2036-03-12"
        bookings={[]}
        onSelectBooking={() => {}}
        orderActions={orderActions}
      />
    </QueryClientProvider>,
  );
}

function tap(el: HTMLElement, move = 0) {
  act(() => {
    fireEvent.pointerDown(el, { pointerType: "mouse", clientX: 10, clientY: 10, button: 0 });
    if (move) fireEvent.pointerMove(el, { pointerType: "mouse", clientX: 10, clientY: 10 + move });
    fireEvent.pointerUp(el, { pointerType: "mouse", clientX: 10, clientY: 10 + move });
  });
}

beforeEach(() => {
  staffSetMySlotMock.mockClear();
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto["hasPointerCapture"]) proto["hasPointerCapture"] = () => false;
  if (!proto["releasePointerCapture"]) proto["releasePointerCapture"] = () => {};
  if (!proto["scrollIntoView"]) proto["scrollIntoView"] = () => {};
});
afterEach(() => cleanup());

describe("服務人員時間軸點格子(#977 第 7 批)", () => {
  it("開關沒生效 ⇒ 沒有任何可點的格子(維持唯讀現況)", () => {
    renderView(null);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByTestId("my-timeline-grid").getAttribute("data-interactive")).toBeNull();
  });

  it("生效 + B2(可開關時段):可預約格子有「新增預約」+「關閉時段」,排休的格子只有「開啟時段」", async () => {
    const onCreateBooking = vi.fn();
    renderView({ unlimitedBackendEdit: false, canToggleSlots: true, onCreateBooking });

    const available = screen.getByRole("button", { name: "09:00 可預約" });
    expect(available.getAttribute("data-slot-state")).toBe("available");
    tap(available);
    expect(await screen.findByRole("menuitem", { name: "新增預約" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "關閉時段" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "新增預約" }));
    expect(onCreateBooking).toHaveBeenCalledWith("2036-03-12", "09:00");

    const closed = screen.getByRole("button", { name: "10:30 不可預約" });
    expect(closed.getAttribute("data-slot-state")).toBe("override-closed");
    tap(closed);
    expect(await screen.findByRole("menuitem", { name: "開啟時段" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "新增預約" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "開啟時段" }));
    });
    expect(staffSetMySlotMock).toHaveBeenCalledWith({
      staffId: STAFF_ID,
      date: "2036-03-12",
      startTime: "10:30",
      endTime: "11:00",
      isAvailable: true,
    });
  });

  it("生效但不是 B2(月薪制 / 沒排班自助):只有「新增預約」,不可預約的格子沒有選單", async () => {
    renderView({ unlimitedBackendEdit: false, canToggleSlots: false, onCreateBooking: vi.fn() });
    tap(screen.getByRole("button", { name: "09:00 可預約" }));
    expect(await screen.findByRole("menuitem", { name: "新增預約" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "關閉時段" })).toBeNull();
    // 10:00 不在每週時段內、10:30 排休 ⇒ 都是純顯示,不是按鈕
    expect(screen.queryByRole("button", { name: /10:00/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /10:30/ })).toBeNull();
  });

  it("按下去拖超過 10px(= 捲動)不開選單", () => {
    renderView({ unlimitedBackendEdit: false, canToggleSlots: true, onCreateBooking: vi.fn() });
    tap(screen.getByRole("button", { name: "09:00 可預約" }), 30);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("商家後台編輯無時段限制 ⇒ 整段營業時間都可預約(跟商家端同一條規則)", () => {
    renderView({ unlimitedBackendEdit: true, canToggleSlots: false, onCreateBooking: vi.fn() });
    expect(
      screen.getByRole("button", { name: "10:00 可預約" }).getAttribute("data-slot-state"),
    ).toBe("available");
  });
});
