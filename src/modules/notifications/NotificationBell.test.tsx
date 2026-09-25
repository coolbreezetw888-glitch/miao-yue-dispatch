// 站內通知中心(鈴鐺)元件測試。對應規格書 §十之二 的:
//   §13.5 未讀數 badge 的三種顯示規則(在真的渲染出來的 DOM 上驗,不只驗純函式)
//   §13.6 三種角色下都渲染鈴鐺
//   §13.7 面板內容:空狀態、合併顯示標出兩個身份、商家名稱只在多商家時顯示、
//         點一列 → 標已讀 + 跨商家先切商家 + 導到正確頁面
//   §13.8 「全部標為已讀」傳 null(= 全部清掉,包含不在這 20 則裡面的)
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserNotification } from "./types";

const useMyNotificationsMock = vi.fn();
const useMyUnreadNotificationCountMock = vi.fn();
const markReadMutateMock = vi.fn();
const setCurrentMerchantIdMock = vi.fn();
const navigateMock = vi.fn();
const useMerchantSwitcherStateMock = vi.fn();

vi.mock("./api", async () => {
  // MY_NOTIFICATIONS_DEFAULT_LIMIT 是常數,照原樣拿(用真的值,面板底部「只顯示最近 N 則」
  // 的斷言才不會跟產品碼分岔)。
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    useMyNotifications: (...args: unknown[]) => useMyNotificationsMock(...args),
    useMyUnreadNotificationCount: () => useMyUnreadNotificationCountMock(),
    useMarkNotificationsRead: () => ({ mutate: markReadMutateMock, isPending: false }),
  };
});

vi.mock("@/modules/merchant/context", () => ({
  useMerchantSwitcherState: () => useMerchantSwitcherStateMock(),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

// api.ts 會 import supabase client,即使 hook 全部被 mock 掉,模組載入時仍然會執行它。
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({}), rpc: () => ({}) },
}));

import { MY_NOTIFICATIONS_DEFAULT_LIMIT } from "./api";
import { NotificationBell } from "./NotificationBell";

function makeRow(overrides: Partial<UserNotification> = {}): UserNotification {
  return {
    id: "n1",
    user_id: "u1",
    merchant_id: "m1",
    target_type: "staff",
    target_id: "staff-1",
    event_type: "booking_created",
    booking_id: "b1",
    title: "新訂單通知",
    body: "2026-10-01 10:00 王小明",
    read_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function openPanel() {
  fireEvent.click(screen.getByTestId("notification-bell"));
}

beforeAll(() => {
  // Radix Popover(內部用 floating-ui)在 jsdom 下需要 ResizeObserver。刻意只在這個測試檔案裡
  // 補,不動 src/test/setup.ts —— 那是全專案共用的設定檔,為了一支測試去改它影響面太大。
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

describe("NotificationBell", () => {
  beforeEach(() => {
    useMyNotificationsMock.mockReset().mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    });
    useMyUnreadNotificationCountMock.mockReset().mockReturnValue({ data: 0 });
    markReadMutateMock.mockReset();
    setCurrentMerchantIdMock.mockReset();
    navigateMock.mockReset();
    useMerchantSwitcherStateMock.mockReset().mockReturnValue({
      merchants: [{ id: "m1", name: "涼風工匠" }],
      currentMerchantId: "m1",
      setCurrentMerchantId: setCurrentMerchantIdMock,
      isLoading: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  // -----------------------------------------------------------------------
  // §13.5 badge 三種顯示規則
  // -----------------------------------------------------------------------
  it("§13.5:未讀 0 筆時鈴鐺渲染但**不**顯示 badge", () => {
    render(<NotificationBell />);
    expect(screen.getByTestId("notification-bell")).toBeInTheDocument();
    expect(screen.queryByTestId("notification-unread-badge")).not.toBeInTheDocument();
  });

  it("§13.5:未讀 1~99 顯示數字", () => {
    useMyUnreadNotificationCountMock.mockReturnValue({ data: 7 });
    render(<NotificationBell />);
    expect(screen.getByTestId("notification-unread-badge")).toHaveTextContent("7");
  });

  it("§13.5:未讀 ≥100 顯示 99+", () => {
    useMyUnreadNotificationCountMock.mockReturnValue({ data: 128 });
    render(<NotificationBell />);
    expect(screen.getByTestId("notification-unread-badge")).toHaveTextContent("99+");
  });

  it("§13.6:badge 用 absolute 疊在鈴鐺上(硬性要求,排在 flex 流裡會吃掉頁首 20 多 px)", () => {
    useMyUnreadNotificationCountMock.mockReturnValue({ data: 3 });
    render(<NotificationBell />);
    const badge = screen.getByTestId("notification-unread-badge");
    expect(badge.className).toContain("absolute");
    // 鈴鐺按鈕本身要是定位基準,而且尺寸是 32px(h-8 w-8),不是 Button size="icon" 的 36px。
    const bell = screen.getByTestId("notification-bell");
    expect(bell.className).toContain("relative");
    expect(bell.className).toContain("h-8");
    expect(bell.className).toContain("w-8");
  });

  // -----------------------------------------------------------------------
  // §13.6:三種角色都有鈴鐺(共用同一份程式碼,不用寫三次)
  // -----------------------------------------------------------------------
  it("§13.6 / §13.10:鈴鐺不依賴任何角色判斷 —— 三種角色下都渲染", () => {
    // 這個元件刻意沒有任何 role 參數/判斷(§13.10 的表格:管理員/客服/服務人員都是 ✅ 有,
    // 而且「同一份程式碼,不用寫三次」)。這條測試釘住「沒有人偷偷加上角色判斷」。
    for (const merchants of [
      [{ id: "m1", name: "涼風工匠" }],
      [
        { id: "m1", name: "涼風工匠" },
        { id: "m2", name: "美甲二店" },
      ],
    ]) {
      useMerchantSwitcherStateMock.mockReturnValue({
        merchants,
        currentMerchantId: "m1",
        setCurrentMerchantId: setCurrentMerchantIdMock,
        isLoading: false,
      });
      const { unmount } = render(<NotificationBell />);
      expect(screen.getByTestId("notification-bell")).toBeInTheDocument();
      unmount();
    }
  });

  // -----------------------------------------------------------------------
  // §13.7 面板
  // -----------------------------------------------------------------------
  it("§13.7:點鈴鐺打開面板;沒有通知時顯示空狀態文字", () => {
    render(<NotificationBell />);
    expect(screen.queryByTestId("notification-panel")).not.toBeInTheDocument();
    openPanel();
    expect(screen.getByTestId("notification-panel")).toBeInTheDocument();
    expect(screen.getByTestId("notification-empty")).toHaveTextContent(
      "目前沒有通知。手機推播的內容會同步留在這裡,滑掉了也找得回來。",
    );
  });

  it("§13.7:每一列顯示事件標籤(沿用 PUSH_NOTIFICATION_EVENT_LABELS)、標題、內容", () => {
    useMyNotificationsMock.mockReturnValue({
      data: [makeRow()],
      isLoading: false,
      isError: false,
    });
    render(<NotificationBell />);
    openPanel();
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    // 「有新訂單建立時」= PUSH_NOTIFICATION_EVENT_LABELS.booking_created,不是另寫一套白話名稱。
    expect(screen.getByText("有新訂單建立時")).toBeInTheDocument();
    expect(screen.getByText("新訂單通知")).toBeInTheDocument();
    expect(screen.getByText("2026-10-01 10:00 王小明")).toBeInTheDocument();
  });

  it("§13.7:未讀的列有未讀圓點,已讀的沒有", () => {
    useMyNotificationsMock.mockReturnValue({
      data: [
        makeRow({ id: "unread", booking_id: "b-unread", read_at: null }),
        makeRow({ id: "read", booking_id: "b-read", read_at: new Date().toISOString() }),
      ],
      isLoading: false,
      isError: false,
    });
    render(<NotificationBell />);
    openPanel();
    expect(screen.getAllByTestId("notification-row")).toHaveLength(2);
    expect(screen.getAllByTestId("notification-unread-dot")).toHaveLength(1);
  });

  it("§13.2 邊界情況:同一事件兩個身份合併成一列,並標出兩個身份", () => {
    const createdAt = new Date().toISOString();
    useMyNotificationsMock.mockReturnValue({
      data: [
        makeRow({
          id: "n-agent",
          target_type: "agent",
          target_id: "agent-1",
          created_at: createdAt,
        }),
        makeRow({
          id: "n-staff",
          target_type: "staff",
          target_id: "staff-1",
          created_at: createdAt,
        }),
      ],
      isLoading: false,
      isError: false,
    });
    render(<NotificationBell />);
    openPanel();
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getByTestId("notification-identity")).toHaveTextContent("以客服、服務人員身份");
  });

  it("§13.7:單一商家的使用者不顯示商家名稱那一行(避免雜訊)", () => {
    useMyNotificationsMock.mockReturnValue({
      data: [makeRow()],
      isLoading: false,
      isError: false,
    });
    render(<NotificationBell />);
    openPanel();
    expect(screen.queryByTestId("notification-merchant-name")).not.toBeInTheDocument();
  });

  it("§13.7:可存取商家超過一間時,每一列多顯示一行商家名稱", () => {
    useMerchantSwitcherStateMock.mockReturnValue({
      merchants: [
        { id: "m1", name: "涼風工匠" },
        { id: "m2", name: "美甲二店" },
      ],
      currentMerchantId: "m1",
      setCurrentMerchantId: setCurrentMerchantIdMock,
      isLoading: false,
    });
    useMyNotificationsMock.mockReturnValue({
      data: [makeRow({ merchant_id: "m2" })],
      isLoading: false,
      isError: false,
    });
    render(<NotificationBell />);
    openPanel();
    expect(screen.getByTestId("notification-merchant-name")).toHaveTextContent("美甲二店");
  });

  it("§13.7:超過 20 則時底部顯示「只顯示最近 20 則」", () => {
    useMyNotificationsMock.mockReturnValue({
      data: Array.from({ length: MY_NOTIFICATIONS_DEFAULT_LIMIT }, (_, i) =>
        makeRow({ id: `n${i}`, booking_id: `b${i}` }),
      ),
      isLoading: false,
      isError: false,
    });
    render(<NotificationBell />);
    openPanel();
    expect(screen.getByTestId("notification-limit-hint")).toHaveTextContent(
      `只顯示最近 ${MY_NOTIFICATIONS_DEFAULT_LIMIT} 則`,
    );
  });

  // -----------------------------------------------------------------------
  // §13.7 點一列 + §13.8 標已讀
  // -----------------------------------------------------------------------
  it("§13.7 / §13.8:點一列 → 只標那一列(合併的列把底下兩個 id 一起標)+ 導到正確頁面", () => {
    const createdAt = new Date().toISOString();
    useMyNotificationsMock.mockReturnValue({
      data: [
        makeRow({
          id: "n-agent",
          target_type: "agent",
          target_id: "agent-1",
          created_at: createdAt,
        }),
        makeRow({
          id: "n-staff",
          target_type: "staff",
          target_id: "staff-1",
          created_at: createdAt,
        }),
      ],
      isLoading: false,
      isError: false,
    });
    render(<NotificationBell />);
    openPanel();
    fireEvent.click(screen.getByTestId("notification-row"));

    expect(markReadMutateMock).toHaveBeenCalledTimes(1);
    const markedIds = markReadMutateMock.mock.calls[0]![0] as string[];
    expect([...markedIds].sort()).toEqual(["n-agent", "n-staff"]);
    // 合併後的主要身份是 agent(優先權較高)→ /app/orders
    expect(navigateMock).toHaveBeenCalledWith("/app/orders");
  });

  it("§13.7:服務人員身份的通知導到 /app/calendar(不是那個不存在的 /app/my-calendar)", () => {
    useMyNotificationsMock.mockReturnValue({
      data: [makeRow({ target_type: "staff" })],
      isLoading: false,
      isError: false,
    });
    render(<NotificationBell />);
    openPanel();
    fireEvent.click(screen.getByTestId("notification-row"));
    expect(navigateMock).toHaveBeenCalledWith("/app/calendar");
  });

  it("🔴 §13.7 第 2 點:跨商家的那一列點下去會**先切換商家**再導頁", () => {
    useMerchantSwitcherStateMock.mockReturnValue({
      merchants: [
        { id: "m1", name: "涼風工匠" },
        { id: "m2", name: "美甲二店" },
      ],
      currentMerchantId: "m1",
      setCurrentMerchantId: setCurrentMerchantIdMock,
      isLoading: false,
    });
    useMyNotificationsMock.mockReturnValue({
      data: [makeRow({ merchant_id: "m2", target_type: "admin" })],
      isLoading: false,
      isError: false,
    });
    render(<NotificationBell />);
    openPanel();
    fireEvent.click(screen.getByTestId("notification-row"));
    // 不切商家就直接導到 /app/orders,使用者會看到另一間店的訂單列表,以為系統壞了。
    expect(setCurrentMerchantIdMock).toHaveBeenCalledWith("m2");
    expect(navigateMock).toHaveBeenCalledWith("/app/orders");
  });

  it("§13.7:同一間商家的那一列**不會**多呼叫一次切換商家", () => {
    useMyNotificationsMock.mockReturnValue({
      data: [makeRow({ merchant_id: "m1" })],
      isLoading: false,
      isError: false,
    });
    render(<NotificationBell />);
    openPanel();
    fireEvent.click(screen.getByTestId("notification-row"));
    expect(setCurrentMerchantIdMock).not.toHaveBeenCalled();
  });

  it("§13.8:已讀的列點下去不會再送一次標已讀(避免白打一次 RPC)", () => {
    useMyNotificationsMock.mockReturnValue({
      data: [makeRow({ read_at: new Date().toISOString() })],
      isLoading: false,
      isError: false,
    });
    render(<NotificationBell />);
    openPanel();
    fireEvent.click(screen.getByTestId("notification-row"));
    expect(markReadMutateMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith("/app/calendar");
  });

  it("§13.8:「全部標為已讀」傳 null(把自己全部未讀標完,含不在這 20 則裡面的)", () => {
    useMyUnreadNotificationCountMock.mockReturnValue({ data: 5 });
    render(<NotificationBell />);
    openPanel();
    fireEvent.click(screen.getByTestId("notification-mark-all-read"));
    expect(markReadMutateMock).toHaveBeenCalledWith(null);
  });

  it("§13.8:沒有未讀時「全部標為已讀」是停用的", () => {
    useMyUnreadNotificationCountMock.mockReturnValue({ data: 0 });
    render(<NotificationBell />);
    openPanel();
    expect(screen.getByTestId("notification-mark-all-read")).toBeDisabled();
  });

  it("§13.8:打開面板**不會**自動全部標為已讀(否則未讀數字就失去意義)", () => {
    useMyUnreadNotificationCountMock.mockReturnValue({ data: 5 });
    useMyNotificationsMock.mockReturnValue({
      data: [makeRow()],
      isLoading: false,
      isError: false,
    });
    render(<NotificationBell />);
    openPanel();
    expect(markReadMutateMock).not.toHaveBeenCalled();
  });

  it("查詢失敗時面板顯示載入失敗,不是假裝「沒有通知」", () => {
    useMyNotificationsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    render(<NotificationBell />);
    openPanel();
    expect(screen.getByTestId("notification-error")).toBeInTheDocument();
    expect(screen.queryByTestId("notification-empty")).not.toBeInTheDocument();
  });

  it("面板關閉時不查清單(只有 20 列完整資料要省,未讀 count 本來就很省)", () => {
    render(<NotificationBell />);
    // 第三個實際傳入的參數是 enabled,關閉時必須是 false。
    expect(useMyNotificationsMock).toHaveBeenCalledWith(MY_NOTIFICATIONS_DEFAULT_LIMIT, false);
    openPanel();
    expect(useMyNotificationsMock).toHaveBeenCalledWith(MY_NOTIFICATIONS_DEFAULT_LIMIT, true);
  });
});
