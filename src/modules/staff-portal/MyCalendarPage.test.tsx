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
// SPECS-INDEX #860:卡片的左側色條與狀態膠囊改讀商家自訂的訂單狀態顏色。
const useMyBookingStatusColorsMock = vi.fn();
// SPECS-INDEX #874(#895):即時同步 hook。這個檔案只驗「頁面有用對的參數呼叫它」;
// hook 本身的訂閱 / 退訂 / 去抖行為由 useStaffScheduleLiveSync.test.tsx 鎖住。
const useStaffScheduleLiveSyncMock = vi.fn();

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => useCurrentMerchantMock(),
}));

vi.mock("./context", () => ({
  useMyStaffPermission: (...args: unknown[]) => useMyStaffPermissionMock(...args),
  useActiveMyStaffRecord: (...args: unknown[]) => useActiveMyStaffRecordMock(...args),
  useMyBookingSchedule: (...args: unknown[]) => useMyBookingScheduleMock(...args),
  useMyBookingStatusColors: (...args: unknown[]) => useMyBookingStatusColorsMock(...args),
  useStaffScheduleLiveSync: (...args: unknown[]) => useStaffScheduleLiveSyncMock(...args),
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
    // 沒自訂過顏色 → 元件自己 fallback 成 DEFAULT_BOOKING_STATUS_COLORS。
    useMyBookingStatusColorsMock.mockReturnValue({ data: undefined });
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

    // 🔴 2026-09-30(skill 二之八):等待畫面從「載入中⋯」四個字改成灰色骨架(GuardLoading),
    // 骨架沒有文字,所以改查它外層的 aria-label="載入中"。**不要把它改回查那四個字**
    // —— 那等於要求程式碼退回被 skill 明文禁止的做法。
    expect(screen.getByLabelText("載入中")).toBeInTheDocument();
    expect(screen.queryByText(/尚未開放此功能/)).not.toBeInTheDocument();
  });

  it("問題 6:商家本身還在載入時同樣顯示載入中,不先下權限結論", async () => {
    useCurrentMerchantMock.mockReturnValue({ merchant: null, isLoading: true });
    useActiveMyStaffRecordMock.mockReturnValue({ data: null, isLoading: false });
    useMyStaffPermissionMock.mockReturnValue({ data: undefined, isLoading: false });
    const MyCalendarPage = await importMyCalendarPage();

    render(<MyCalendarPage />);

    // 🔴 2026-09-30(skill 二之八):等待畫面從「載入中⋯」四個字改成灰色骨架(GuardLoading),
    // 骨架沒有文字,所以改查它外層的 aria-label="載入中"。**不要把它改回查那四個字**
    // —— 那等於要求程式碼退回被 skill 明文禁止的做法。
    expect(screen.getByLabelText("載入中")).toBeInTheDocument();
    expect(screen.queryByText(/尚未開放此功能/)).not.toBeInTheDocument();
  });

  // =========================================================================
  // SPECS-INDEX #874(#895):行事曆頁掛上即時同步訂閱。
  // =========================================================================
  it("#895:用自己的 staff_id 與行事曆檢視權限呼叫即時同步 hook", async () => {
    const MyCalendarPage = await importMyCalendarPage();

    render(<MyCalendarPage />);

    expect(useStaffScheduleLiveSyncMock).toHaveBeenCalledWith("staff-1", { hasCalendarView: true });
  });

  it("#895:載入中(early return 之前)也照樣呼叫 hook,只是參數讓它不訂閱", async () => {
    useActiveMyStaffRecordMock.mockReturnValue({ data: null, isLoading: true });
    useMyStaffPermissionMock.mockReturnValue({ data: undefined, isLoading: false });
    const MyCalendarPage = await importMyCalendarPage();

    render(<MyCalendarPage />);

    expect(screen.getByLabelText("載入中")).toBeInTheDocument();
    expect(useStaffScheduleLiveSyncMock).toHaveBeenCalledWith(null, { hasCalendarView: undefined });
  });

  it("#903:沒有行事曆檢視權限時,傳給 hook 的權限是 false(hook 內部因此不訂閱)", async () => {
    useMyStaffPermissionMock.mockReturnValue({ data: false, isLoading: false });
    const MyCalendarPage = await importMyCalendarPage();

    render(<MyCalendarPage />);

    expect(useStaffScheduleLiveSyncMock).toHaveBeenCalledWith("staff-1", {
      hasCalendarView: false,
    });
  });

  it("真的沒有權限時(載入都結束了)仍然照既有行為顯示空狀態文字", async () => {
    useActiveMyStaffRecordMock.mockReturnValue({ data: { id: "staff-1" }, isLoading: false });
    useMyStaffPermissionMock.mockReturnValue({ data: false, isLoading: false });
    const MyCalendarPage = await importMyCalendarPage();

    render(<MyCalendarPage />);

    expect(
      screen.getByText("尚未開放此功能，請洽商家管理員開通「行事曆檢視」權限。"),
    ).toBeInTheDocument();
  });

  // =========================================================================
  // SPECS-INDEX #856:「旗標沒開的訂單,服務人員一定看得到內部備註」的回歸測試。
  //
  // 🔴 為什麼要補這一條:這個顯示邏輯從 2026-09-21(commit 1caf4d5 / 25b2402)就存在,
  // 但**完全沒有測試在保護它** —— 這個檔案原本的測試資料把 notes 設成 null(見 makeBooking),
  // 等於「有值的情況」從來沒被測到;module14 那支 pgTAP 測了 customer_name / is_member /
  // role_in_booking,就是沒測 notes。使用者 2026-09-30 回報「服務人員端看不到內部備註」,
  // 主腦與 planner 覆核後確認**那是那筆訂單沒填備註**,不是功能缺失(使用者自己也確認「是有顯示的」)。
  // ⇒ 需求 1 要做的不是新功能,是**把這個沒人保護的行為釘住**,以後任何人改這一頁
  //   (例如這次 #861 把卡片整個換成 ListCard)都不會把它弄掉。
  //
  // 【故障注入驗證(2026-09-30 實際跑過並還原)】
  //   MyCalendarPage.tsx 的 `{booking.notes ? <span>內部備註:{booking.notes}</span> : null}` 拿掉
  //   → 下面第 1 條轉紅;第 2 條(旗標打開 = notes 為 null 時不顯示)仍綠。
  // =========================================================================
  it("#856:內部備註有值時,卡片上要顯示「內部備註:…」(預設服務人員看得到)", async () => {
    useMyBookingScheduleMock.mockReturnValue({
      data: [makeBooking({ notes: "上次尾款沒收", customer_notes: "有養狗" })],
      isLoading: false,
      error: null,
    });
    const MyCalendarPage = await importMyCalendarPage();

    render(<MyCalendarPage />);

    expect(screen.getByText("內部備註：上次尾款沒收")).toBeInTheDocument();
    // 兩種備註要分得開(skill 二之六):客戶備註有自己的前綴,不會被混在一起。
    expect(screen.getByText("客戶備註：有養狗")).toBeInTheDocument();
  });

  it("#851/#855:客服勾了「不讓服務人員看到」時 notes 已經在資料層被遮成 null,卡片上整塊不出現", async () => {
    // 遮蔽是做在 get_my_booking_schedule 裡(不是前端 if 掉),所以前端拿到的就是 notes = null。
    // 主腦裁決 T1=A:不顯示任何「有東西被藏起來」的提示 —— 所以連「內部備註」這四個字都不該出現。
    useMyBookingScheduleMock.mockReturnValue({
      data: [makeBooking({ notes: null, customer_notes: "有養狗" })],
      isLoading: false,
      error: null,
    });
    const MyCalendarPage = await importMyCalendarPage();

    render(<MyCalendarPage />);

    expect(screen.queryByText(/內部備註/)).not.toBeInTheDocument();
    // 客戶備註不受影響(它從來不是這個旗標的範圍)。
    expect(screen.getByText("客戶備註：有養狗")).toBeInTheDocument();
  });

  // =========================================================================
  // SPECS-INDEX #861 第 4 項:「主要服務人員 / 協助」要更顯眼 + 兩者顏色要區分。
  // 改版前兩顆都是灰底 Badge,服務人員分不出自己這一單是主手還是副手。
  // =========================================================================
  it("#861:主要服務人員的標籤用主題色(attributeStrong),協助用安靜灰底,兩者 class 不同", async () => {
    useMyBookingScheduleMock.mockReturnValue({
      data: [
        makeBooking({ id: "b-primary", role_in_booking: "primary" }),
        makeBooking({
          id: "b-assistant",
          role_in_booking: "assistant",
          start_at: "2026-09-24T18:30:00+00:00",
          end_at: "2026-09-24T19:30:00+00:00",
        }),
      ],
      isLoading: false,
      error: null,
    });
    const MyCalendarPage = await importMyCalendarPage();

    render(<MyCalendarPage />);

    const primaryTag = screen.getByText("主要服務人員");
    const assistantTag = screen.getByText("協助");
    // 🔴 顏色不能是唯一的差別(skill 二之四)—— 兩顆都有完整文字,上面兩行就是在確認這件事。
    expect(primaryTag.className).not.toBe(assistantTag.className);
    expect(primaryTag.className).toContain("text-brand");
    expect(assistantTag.className).toContain("text-muted-foreground");
  });
});
