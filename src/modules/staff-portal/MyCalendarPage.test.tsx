// 2026-09-24 深夜巡檢:服務人員自助行事曆(4.3 MyCalendarPage.tsx)的兩條回歸測試。
//
//   問題 5:這一頁原本用 `toDateKey(new Date(b.start_at))` 分組、用沒帶 timeZone 的
//   toLocaleTimeString 顯示時間,兩者都跟著**瀏覽器本機時區**跑。服務人員的手機/瀏覽器時區不是
//   UTC+8 時(出國、手機自動時區抓錯、境外機器),跨日的預約(例如台北時間 00:30)會被歸到前一天
//   的格子,當天列表變成「這一天沒有預約」;時間也顯示錯誤,而且同一頁切到「時間軸格線」檢視時
//   (那邊用的是正確的 isoToTaipeiTime)同一筆預約會顯示出兩種時間。所以這個測試檔案刻意把整個
//   測試行程的時區設成 America/New_York——在台北時區的機器上跑,修正前的寫法「剛好」也會是對的,
//   測不出東西。
//
//   問題 6:權限查詢(useMyStaffPermission)內部要先解出自己的 staff_id 才問得到答案。這一頁原本
//   只等 permissionLoading,沒等 useActiveMyStaffRecord 的載入狀態,於是一位權限完全正常的服務
//   人員(網路較慢的手機)會先閃出一次「尚未開放此功能,請洽商家管理員開通『行事曆檢視』權限」。

// 測試結束後會還原(vitest 的 worker 行程會被後面的測試檔案重複使用,不還原可能影響別的檔案)。
const ORIGINAL_TZ = process.env["TZ"];
process.env["TZ"] = "America/New_York";

import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MyBookingScheduleItem } from "./api";

const useCurrentMerchantMock = vi.fn();
const useMyStaffPermissionMock = vi.fn();
const useActiveMyStaffRecordMock = vi.fn();
const useMyBookingScheduleMock = vi.fn();

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => useCurrentMerchantMock(),
}));

vi.mock("./context", () => ({
  useMyStaffPermission: (...args: unknown[]) => useMyStaffPermissionMock(...args),
  useActiveMyStaffRecord: (...args: unknown[]) => useActiveMyStaffRecordMock(...args),
  useMyBookingSchedule: (...args: unknown[]) => useMyBookingScheduleMock(...args),
}));

// 這兩個子元件不是這次的測試對象,換成最小的替身,避免把它們自己的資料查詢也拖進來。
vi.mock("./MyCalendarTimelineView", () => ({
  MyCalendarTimelineView: () => null,
}));
vi.mock("./MyBookingDetailDialog", () => ({
  MyBookingDetailDialog: () => null,
}));

async function importMyCalendarPage() {
  const mod = await import("./MyCalendarPage");
  return mod.default;
}

function makeBooking(overrides: Partial<MyBookingScheduleItem> = {}): MyBookingScheduleItem {
  return {
    id: "booking-1",
    // 台北時間 2026-09-25 00:30 ~ 01:30(在紐約時區是 09-24 12:30 ~ 13:30,日期跟時間都不同)。
    start_at: "2026-09-24T16:30:00+00:00",
    end_at: "2026-09-24T17:30:00+00:00",
    status: "accepted",
    role_in_booking: "primary",
    customer_name: "陳先生",
    customer_phone: "0912345678",
    customer_address: null,
    notes: null,
    customer_notes: null,
    service_item_names: ["冷氣清洗"],
    final_amount_snapshot: 1200,
    is_member: false,
    member_name: null,
    member_points_balance: null,
    ...overrides,
  };
}

afterAll(() => {
  process.env["TZ"] = ORIGINAL_TZ;
});

describe("MyCalendarPage", () => {
  beforeEach(() => {
    // 固定「現在」= 台北時間 2026-09-25 12:00,讓頁面預設選取的日期是 2026-09-25。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T04:00:00+00:00"));

    useCurrentMerchantMock.mockReturnValue({ merchant: { id: "merchant-1" }, isLoading: false });
    useActiveMyStaffRecordMock.mockReturnValue({ data: { id: "staff-1" }, isLoading: false });
    useMyStaffPermissionMock.mockReturnValue({ data: true, isLoading: false });
    useMyBookingScheduleMock.mockReturnValue({ data: [], isLoading: false, error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
  });

  it("測試環境本身確實不是台北時區(否則問題 5 的測試會失去意義)", () => {
    expect(new Date("2026-09-24T16:30:00+00:00").getDate()).toBe(24);
    expect(process.env["TZ"]).toBe("America/New_York");
  });

  it("問題 5:跨日預約依台北日期分組,不會因為瀏覽器時區被歸到前一天", async () => {
    useMyBookingScheduleMock.mockReturnValue({
      data: [makeBooking()],
      isLoading: false,
      error: null,
    });
    const MyCalendarPage = await importMyCalendarPage();

    render(<MyCalendarPage />);

    // 預設選取 2026-09-25(台北的今天),那筆台北 00:30 的預約必須出現在這一天。
    expect(screen.getByText("2026-09-25 的預約")).toBeInTheDocument();
    expect(screen.queryByText("這一天沒有預約。")).not.toBeInTheDocument();
    expect(screen.getByText("陳先生・0912345678")).toBeInTheDocument();
  });

  it("問題 5:卡片上的時間是台北時間,不是瀏覽器本機時間", async () => {
    useMyBookingScheduleMock.mockReturnValue({
      data: [makeBooking()],
      isLoading: false,
      error: null,
    });
    const MyCalendarPage = await importMyCalendarPage();

    render(<MyCalendarPage />);

    // 台北 00:30-01:30;修正前在紐約時區會顯示成 12:30-13:30。
    expect(screen.getByText("00:30 - 01:30")).toBeInTheDocument();
    expect(screen.queryByText("12:30 - 13:30")).not.toBeInTheDocument();
  });

  it("問題 6:staff_id 還沒解出來時顯示載入中,不能先閃出「尚未開放此功能」", async () => {
    // 這正是網路較慢的手機會遇到的中間狀態:staff 紀錄還在載入,權限查詢因此還沒有答案。
    useActiveMyStaffRecordMock.mockReturnValue({ data: null, isLoading: true });
    useMyStaffPermissionMock.mockReturnValue({ data: undefined, isLoading: false });
    const MyCalendarPage = await importMyCalendarPage();

    render(<MyCalendarPage />);

    expect(screen.getByText("載入中⋯")).toBeInTheDocument();
    expect(screen.queryByText(/尚未開放此功能/)).not.toBeInTheDocument();
  });

  it("問題 6:商家本身還在載入時同樣顯示載入中,不先下權限結論", async () => {
    useCurrentMerchantMock.mockReturnValue({ merchant: null, isLoading: true });
    useActiveMyStaffRecordMock.mockReturnValue({ data: null, isLoading: false });
    useMyStaffPermissionMock.mockReturnValue({ data: undefined, isLoading: false });
    const MyCalendarPage = await importMyCalendarPage();

    render(<MyCalendarPage />);

    expect(screen.getByText("載入中⋯")).toBeInTheDocument();
    expect(screen.queryByText(/尚未開放此功能/)).not.toBeInTheDocument();
  });

  it("真的沒有權限時(載入都結束了)仍然照既有行為顯示空狀態文字", async () => {
    useActiveMyStaffRecordMock.mockReturnValue({ data: { id: "staff-1" }, isLoading: false });
    useMyStaffPermissionMock.mockReturnValue({ data: false, isLoading: false });
    const MyCalendarPage = await importMyCalendarPage();

    render(<MyCalendarPage />);

    expect(
      screen.getByText("尚未開放此功能,請洽商家管理員開通「行事曆檢視」權限。"),
    ).toBeInTheDocument();
  });
});
