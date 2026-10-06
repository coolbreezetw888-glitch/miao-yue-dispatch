// SPECS-INDEX #977 第 4 批(2026-10-06):鈴鐺的兩個新行為。
// 規格書 .project/specs/服務人員接單確認-第4批.md 第二節第 4 點、第三節第 4 點。
//
//   ① 新事件 booking_confirmed(服務人員確認接單 ⇒ 商家管理員收到):顯示「服務人員確認接單時」,
//      點了照既有規則依身份導頁(管理員 ⇒ 訂單管理),並標已讀
//   ② 服務人員視角:清單最上方固定一條「你有 N 筆訂單待確認」,點了打開我的行事曆;N 算進紅點;0 筆時不顯示;
//      「全部標為已讀」只管資料表裡的通知(只有待確認提醒時不能按)
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserNotification } from "./types";

const useMyNotificationsMock = vi.fn();
const useMyUnreadNotificationCountMock = vi.fn();
const markReadMutateMock = vi.fn();
const navigateMock = vi.fn();

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    useMyNotifications: (...args: unknown[]) => useMyNotificationsMock(...args),
    useMyUnreadNotificationCount: () => useMyUnreadNotificationCountMock(),
    useMarkNotificationsRead: () => ({ mutate: markReadMutateMock, isPending: false }),
  };
});

vi.mock("@/modules/merchant/context", () => ({
  useMerchantSwitcherState: () => ({
    merchants: [{ id: "m1", name: "涼風工匠" }],
    currentMerchantId: "m1",
    setCurrentMerchantId: vi.fn(),
    isLoading: false,
  }),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({}), rpc: () => ({}) },
}));

import { NotificationBell } from "./NotificationBell";
import { BELL_ONLY_EVENT_LABELS, formatStaffPendingReminder } from "./notificationLink";

function makeRow(overrides: Partial<UserNotification> = {}): UserNotification {
  return {
    id: "n1",
    user_id: "u1",
    merchant_id: "m1",
    target_type: "admin",
    target_id: "admin-1",
    event_type: "booking_confirmed",
    booking_id: "b1",
    title: "服務人員已確認訂單",
    body: "服務人員「主要甲」已確認 2026/11/12 14:00「陳小美」的訂單。",
    read_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  window.matchMedia = (query: string) =>
    ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
});

beforeEach(() => {
  useMyNotificationsMock
    .mockReset()
    .mockReturnValue({ data: [], isLoading: false, isError: false });
  useMyUnreadNotificationCountMock.mockReset().mockReturnValue({ data: 0 });
  markReadMutateMock.mockReset();
  navigateMock.mockReset();
});

afterEach(() => cleanup());

describe("鈴鐺:booking_confirmed 新事件(#977 第 4 批)", () => {
  it("顯示事件名稱「服務人員確認接單時」與通知內文;點了標已讀並導到訂單管理", () => {
    useMyNotificationsMock.mockReturnValue({ data: [makeRow()], isLoading: false, isError: false });
    useMyUnreadNotificationCountMock.mockReturnValue({ data: 1 });
    render(<NotificationBell />);
    fireEvent.click(screen.getByTestId("notification-bell"));

    expect(screen.getByText("服務人員確認接單時")).toBeTruthy();
    expect(
      screen.getByText("服務人員「主要甲」已確認 2026/11/12 14:00「陳小美」的訂單。"),
    ).toBeTruthy();
    expect(screen.queryByText("booking_confirmed")).toBeNull();

    fireEvent.click(screen.getByTestId("notification-row"));
    expect(markReadMutateMock).toHaveBeenCalledWith(["n1"]);
    expect(navigateMock).toHaveBeenCalledWith("/app/orders");
  });
});

describe("鈴鐺:服務人員待確認提醒(#977 第 4 批)", () => {
  it("有待確認 ⇒ 清單最上方「你有 N 筆訂單待確認」,紅點 = 未讀 + 待確認", () => {
    useMyNotificationsMock.mockReturnValue({
      data: [makeRow({ target_type: "staff", event_type: "booking_created", title: "新訂單" })],
      isLoading: false,
      isError: false,
    });
    useMyUnreadNotificationCountMock.mockReturnValue({ data: 2 });
    render(<NotificationBell staffPendingCount={3} />);

    expect(screen.getByTestId("notification-unread-badge").textContent).toBe("5");
    fireEvent.click(screen.getByTestId("notification-bell"));

    const reminder = screen.getByTestId("notification-staff-pending-reminder");
    expect(reminder.textContent).toContain("你有 3 筆訂單待確認");
    // 位置:在第一則通知前面。
    const firstRow = screen.getByTestId("notification-row");
    expect(
      reminder.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("點提醒 ⇒ 打開我的行事曆、不呼叫標已讀", () => {
    render(<NotificationBell staffPendingCount={1} />);
    fireEvent.click(screen.getByTestId("notification-bell"));
    fireEvent.click(screen.getByTestId("notification-staff-pending-reminder"));
    expect(navigateMock).toHaveBeenCalledWith("/app/calendar");
    expect(markReadMutateMock).not.toHaveBeenCalled();
  });

  it("只有待確認、沒有未讀通知 ⇒ 紅點有數字,但「全部標為已讀」不能按", () => {
    render(<NotificationBell staffPendingCount={2} />);
    expect(screen.getByTestId("notification-unread-badge").textContent).toBe("2");
    fireEvent.click(screen.getByTestId("notification-bell"));
    expect((screen.getByTestId("notification-mark-all-read") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("0 筆(或非服務人員視角不傳)⇒ 不顯示提醒、紅點維持只算未讀", () => {
    useMyUnreadNotificationCountMock.mockReturnValue({ data: 0 });
    render(<NotificationBell staffPendingCount={0} />);
    expect(screen.queryByTestId("notification-unread-badge")).toBeNull();
    fireEvent.click(screen.getByTestId("notification-bell"));
    expect(screen.queryByTestId("notification-staff-pending-reminder")).toBeNull();
  });
});

describe("文案守門:全形標點(#977 第 4 批)", () => {
  it("新文字不含半形 , : ( ) ;", () => {
    const texts = [formatStaffPendingReminder(3), ...Object.values(BELL_ONLY_EVENT_LABELS)];
    expect(texts.filter((t) => /[,:();]/.test(t))).toEqual([]);
  });
});
