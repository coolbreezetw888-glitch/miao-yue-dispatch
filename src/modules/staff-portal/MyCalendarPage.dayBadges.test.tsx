// SPECS-INDEX #977 第 4 批(2026-10-06):服務人員月曆日期格兩色數量。
// 規格書 .project/specs/服務人員接單確認-第4批.md 第三節第 3 點:
//   原本一顆數字徽章 ⇒ 兩個數字:待確認(商家「待確認」顏色)、已確認(商家「已確認」顏色);
//   只算這兩種狀態,已完成不算;數量為 0 的那顆不顯示;手機 375 寬排得下(不換行,whitespace-nowrap)。
//   詳情彈窗收到商家自訂顏色(跟列表卡片同一份)。
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MyBookingScheduleItem } from "./api";

const useCurrentMerchantMock = vi.fn();
const useMyStaffPermissionMock = vi.fn();
const useActiveMyStaffRecordMock = vi.fn();
const useMyBookingScheduleMock = vi.fn();
const useMyBookingStatusColorsMock = vi.fn();
const dialogPropsMock = vi.fn();

// SPECS-INDEX #1025 FG-3:平台功能開關全開(這支測試不測開關;開關的行為見 staffFeatureGates.test.tsx)。
vi.mock("@/modules/merchant/features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/merchant/features")>()),
  useMerchantFeatures: () => ({
    features: [],
    hasFeature: () => true,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => useCurrentMerchantMock(),
}));

vi.mock("./context", () => ({
  useMyStaffPermission: (...args: unknown[]) => useMyStaffPermissionMock(...args),
  useActiveMyStaffRecord: (...args: unknown[]) => useActiveMyStaffRecordMock(...args),
  useMyBookingSchedule: (...args: unknown[]) => useMyBookingScheduleMock(...args),
  useMyBookingStatusColors: (...args: unknown[]) => useMyBookingStatusColorsMock(...args),
  useStaffScheduleLiveSync: () => undefined,
}));

vi.mock("./MyCalendarTimelineView", () => ({
  MyCalendarTimelineView: () => null,
}));
vi.mock("./MyBookingDetailDialog", () => ({
  MyBookingDetailDialog: (props: unknown) => {
    dialogPropsMock(props);
    return null;
  },
}));

import MyCalendarPage from "./MyCalendarPage";

let seq = 0;
function makeBooking(overrides: Partial<MyBookingScheduleItem> = {}): MyBookingScheduleItem {
  seq += 1;
  return {
    id: `booking-${seq}`,
    // 台北 2026-10-12 10:00
    start_at: "2026-10-12T02:00:00+00:00",
    end_at: "2026-10-12T03:00:00+00:00",
    status: "pending_confirmation",
    role_in_booking: "primary",
    customer_name: "陳先生",
    customer_phone: null,
    customer_address: null,
    notes: null,
    customer_notes: null,
    service_item_names: ["冷氣清洗"],
    final_amount_snapshot: 1200,
    is_member: null,
    member_name: null,
    member_points_balance: null,
    ...overrides,
  };
}

const STATUS_COLORS = {
  pendingConfirmation: "#662deb",
  accepted: "#ff42dc",
  completed: "#07cf68",
  cancelled: "#ffaa33",
};

/** 月曆格線裡「某一天」那顆按鈕(日期數字是按鈕裡第一個 span)。 */
function dayCell(day: number): HTMLElement {
  const cells = screen
    .getAllByRole("button")
    .filter((el) => el.querySelector("span")?.textContent === String(day));
  // 月曆格會出現上個月 / 下個月補位的同號日期;這裡測的日子在 10 月中間,只會有一格。
  expect(cells).toHaveLength(1);
  return cells[0]!;
}

describe("MyCalendarPage 月曆日期格兩色數量(#977 第 4 批)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 台北 2026-10-06 12:00
    vi.setSystemTime(new Date("2026-10-06T04:00:00+00:00"));
    useCurrentMerchantMock.mockReturnValue({ merchant: { id: "merchant-1" }, isLoading: false });
    useActiveMyStaffRecordMock.mockReturnValue({
      data: { id: "staff-1", name: "甲" },
      isLoading: false,
    });
    useMyStaffPermissionMock.mockReturnValue({ data: true, isLoading: false });
    useMyBookingStatusColorsMock.mockReturnValue({ data: STATUS_COLORS });
    dialogPropsMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
  });

  it("待確認 2、已確認 1、已完成 1 ⇒ 顯示 2(待確認色)與 1(已確認色),已完成不算", () => {
    useMyBookingScheduleMock.mockReturnValue({
      data: [
        makeBooking(),
        makeBooking({ role_in_booking: "assistant" }),
        makeBooking({ status: "accepted" }),
        makeBooking({ status: "completed" }),
      ],
      isLoading: false,
      error: null,
    });
    render(<MyCalendarPage />);

    const cell = dayCell(12);
    const pending = within(cell).getByTestId("day-pending-count");
    const accepted = within(cell).getByTestId("day-accepted-count");
    expect(pending.textContent).toBe("2");
    expect(accepted.textContent).toBe("1");
    expect(pending.style.backgroundColor).toBe("rgb(102, 45, 235)");
    expect(accepted.style.backgroundColor).toBe("rgb(255, 66, 220)");
    // 手機 375 寬:兩顆在同一列、不換行。
    expect(pending.parentElement?.className).toContain("whitespace-nowrap");
  });

  it("數量為 0 的那顆不顯示;只有已完成 / 已取消的日子兩顆都不顯示", () => {
    useMyBookingScheduleMock.mockReturnValue({
      data: [
        makeBooking({ status: "accepted" }),
        makeBooking({
          status: "completed",
          start_at: "2026-10-13T02:00:00+00:00",
          end_at: "2026-10-13T03:00:00+00:00",
        }),
      ],
      isLoading: false,
      error: null,
    });
    render(<MyCalendarPage />);

    expect(within(dayCell(12)).queryByTestId("day-pending-count")).toBeNull();
    expect(within(dayCell(12)).getByTestId("day-accepted-count").textContent).toBe("1");
    expect(within(dayCell(13)).queryByTestId("day-pending-count")).toBeNull();
    expect(within(dayCell(13)).queryByTestId("day-accepted-count")).toBeNull();
  });

  it("詳情彈窗收到商家自訂的狀態顏色", () => {
    useMyBookingScheduleMock.mockReturnValue({ data: [], isLoading: false, error: null });
    render(<MyCalendarPage />);
    const lastProps = dialogPropsMock.mock.calls.at(-1)?.[0] as { statusColors?: unknown };
    expect(lastProps.statusColors).toEqual(STATUS_COLORS);
  });
});
