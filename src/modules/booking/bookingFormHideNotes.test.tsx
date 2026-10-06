// SPECS-INDEX #853 / #857:建單/編輯表單的「不讓服務人員看到這則內部備註」開關。
//
// 🔴 為什麼這一支測試非寫不可(整個 #850~#859 只有這一條是真的資安後果):
// update_booking 對 notes / customer_notes / member_id / hide_notes_from_staff 這些欄位是
// **無條件覆寫**,不是「有帶才更新」。新參數 p_hide_notes_from_staff 的預設值是 false ⇒
//   前端漏帶  →  後端拿 default false  →  **原本藏起來的內部備註,客服編輯一次就自動公開給服務人員**
// 而且它**不會報錯、畫面上也看不出來**。這個系統已經被一模一樣的陷阱咬過一次
//(api.ts:UpdateBookingInput.memberId 旁邊那段 ⚠️ 註解就是上次的紀念品)。
//
// 所以這裡釘住三件事:
//   1. 編輯模式開啟表單時,開關要帶入這筆訂單**目前**的值(不是一律 false)
//   2. 使用者**完全沒碰**那個開關就按儲存 → 送出的 payload 旗標等於開啟時讀到的值
//   3. 關掉開關 → 送出的是 `false`,而且真的有帶這個欄位(不是被省略掉)
//
// 【故障注入驗證(照 automated-testing skill「怎麼確認測試不是假的」做,2026-09-30 實際跑過,
//   兩次都已還原,還原後 `git diff --stat` 只剩本次要做的 40 insertions / 4 deletions)】
//   (a) CalendarPage.tsx 拿掉 `setHideNotesFromStaff(editingDetail.hide_notes_from_staff);`
//       → 6 條裡 **3 條轉紅**:「開啟表單時開關就是開著的」、「沒碰開關就儲存 → payload 仍是 true」、
//         「關掉開關送出 false」(第三條紅是因為開關本來就沒開,點一下反而變成開啟)。
//         另外 3 條(開關存在 / 標籤文案 / 新建預設關)仍綠 —— 正好證明它們測的是別的東西,
//         不是「永遠綠的假測試」。
//   (b) handleSubmit 的 `hideNotesFromStaff,` 改成 `hideNotesFromStaff: undefined,`
//       → **2 條轉紅**(兩條 payload 斷言);「開啟表單時開關是開著的」仍綠 —— 這正是這個 bug
//         在真實世界的樣子:**畫面上完全正常,只有送出去的東西不對**。這也是為什麼「看畫面」
//         驗收不了這一條,一定要斷言 payload。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getBookingMock, createBookingMock, updateBookingMock, toastMock } = vi.hoisted(() => ({
  getBookingMock: vi.fn(),
  createBookingMock: vi.fn(),
  updateBookingMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}));

const MERCHANT_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ITEM_ID = "33333333-3333-4333-8333-333333333333";
const BOOKING_ID = "44444444-4444-4444-8444-444444444444";

vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("./api", () => ({
  getBooking: getBookingMock,
  createBooking: createBookingMock,
  updateBooking: updateBookingMock,
  // 紅利系統重構 批次 7:表單會呼叫紅利預覽。這支測試只管「隱藏備註」,讓紅利功能維持關閉
  // (區塊整個不渲染),紅利區塊自己的測試在 bookingFormPoints.test.tsx。
  previewBookingPoints: vi.fn(async () => ({ feature_enabled: false })),
  // SPECS-INDEX #980:時間選單改問資料庫;這裡讓整天都能約(這支只測隱藏備註)。
  fetchStaffBookableStartTimes: vi.fn(async () => ALL_DAY_START_TIMES),
  MATERIAL_COST_ENABLED_FEATURE_KEY: "material_cost_enabled",
}));

vi.mock("./BookingDetailDialog", () => ({ BookingDetailDialog: () => null }));
vi.mock("@/modules/members/MemberPhoneMatchPanel", () => ({
  MemberPhoneMatchPanel: () => null,
}));

vi.mock("./context", () => ({
  setStaffDayOverride: vi.fn(),
  useMerchantBookings: () => ({ data: [], isLoading: false, error: null }),
  useMerchantBookingStatusColors: () => ({ data: undefined }),
  useMerchantBusinessHours: () => ({
    data: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      day_of_week: d,
      is_closed: false,
      open_time: "00:00",
      close_time: "23:59",
    })),
  }),
  useMerchantCalendarStateStyles: () => ({ data: undefined }),
  // 時段選擇器用的:這一天完全空著、整天可預約。
  useMerchantDaySchedule: () => ({
    data: {
      business_hours: {
        has_setting: true,
        is_closed: false,
        open_time: "00:00",
        close_time: "23:59",
      },
      staff: [],
    },
    isLoading: false,
    error: null,
  }),
  useMerchantMaterialCostItems: () => ({ data: [] }),
  useMerchantPaymentMethods: () => ({ data: [] }),
  useMerchantTaxSettings: () => ({ data: null }),
}));

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({
    merchant: { id: MERCHANT_ID, name: "測試商家", industry_type: "in_store_beauty" },
    isLoading: false,
  }),
}));
vi.mock("@/modules/merchant/api", () => ({ getFeatureFlag: vi.fn(async () => false) }));

vi.mock("@/modules/staff-agent/context", () => ({
  useAgentPermission: () => ({ data: true, isLoading: false }),
  useCurrentMerchantRole: () => ({ data: "admin", isLoading: false }),
  useMerchantStaffList: () => ({
    data: [{ id: STAFF_ID, name: "服務人員甲", no_time_slot_limit: true }],
  }),
}));

vi.mock("@/modules/service-items/context", () => ({
  useMerchantServiceCategories: () => ({ data: [] }),
  useMerchantServiceItems: () => ({
    data: [
      {
        id: SERVICE_ITEM_ID,
        merchant_id: MERCHANT_ID,
        name: "冷氣清洗",
        price: 1000,
        item_type: "primary",
        duration_minutes: 60,
        category: null,
        status: "active",
      },
    ],
  }),
}));

import { BookingFormDialog } from "./CalendarPage";
import { ALL_DAY_START_TIMES } from "./bookingFormTestUtils";

/** 一筆「合法到可以直接按儲存」的既有訂單,hide_notes_from_staff 由呼叫端決定。 */
function editingDetail(hideNotesFromStaff: boolean) {
  return {
    id: BOOKING_ID,
    merchant_id: MERCHANT_ID,
    staff_id: STAFF_ID,
    // 台北時間 2036-01-05 10:00 ~ 11:00(用未來日期,避免「過去時間」相關的既有分支)。
    start_at: "2036-01-05T02:00:00+00:00",
    end_at: "2036-01-05T03:00:00+00:00",
    status: "accepted",
    customer_name: "陳先生",
    customer_phone: "0912345678",
    customer_email: null,
    customer_address: null,
    notes: "上次尾款沒收",
    customer_notes: null,
    hide_notes_from_staff: hideNotesFromStaff,
    member_id: null,
    member_name_snapshot: null,
    custom_total_amount_enabled: false,
    custom_total_amount: null,
    discount_enabled: false,
    discount_mode: null,
    discount_value: null,
    tax_enabled: false,
    tax_mode_snapshot: null,
    tax_value_snapshot: null,
    final_amount_snapshot: 1000,
    payment_method_id: null,
    payment_method_name_snapshot: null,
    custom_duration_enabled: false,
    custom_duration_minutes: null,
    // 紅利系統重構 批次 7:編輯表單會帶入這幾個欄位(這張單沒派點、沒折抵)。
    points_planned: 0,
    points_planned_auto: 0,
    points_planned_overridden: false,
    points_redeemed: 0,
    points_redeem_amount_snapshot: 0,
    created_at: "2036-01-01T00:00:00+00:00",
    last_modified_at: null,
    createdByName: "客服小美",
    lastModifiedByName: null,
    serviceItems: [
      {
        id: SERVICE_ITEM_ID,
        name: "冷氣清洗",
        quantity: 1,
        unitPriceSnapshot: 1000,
        lineTotal: 1000,
      },
    ],
    assistants: [],
    materialCosts: [],
  };
}

function renderForm(editingBookingId: string | null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <BookingFormDialog
          merchantId={MERCHANT_ID}
          industryType="in_store_beauty"
          open
          onOpenChange={() => {}}
          prefill={{ staffId: STAFF_ID, dateKey: "2036-01-05", time: "10:00" }}
          editingBookingId={editingBookingId}
          onSaved={() => {}}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** 那顆開關:SwitchRow 的 Label htmlFor 指到 Switch,所以用 role=switch + 可存取名稱找它。 */
function hideNotesSwitch(): HTMLElement {
  return screen.getByRole("switch", { name: /不讓服務人員看到這則內部備註/ });
}

describe("建單/編輯表單:不讓服務人員看到這則內部備註(#853 / #857)", () => {
  beforeEach(() => {
    updateBookingMock.mockResolvedValue({ id: BOOKING_ID, merchant_id: MERCHANT_ID });
    createBookingMock.mockResolvedValue({ id: BOOKING_ID, merchant_id: MERCHANT_ID });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("#853:開關存在,而且說明文字講清楚「只影響這一筆」(不是全店設定)", async () => {
    getBookingMock.mockResolvedValue(editingDetail(false));
    renderForm(BOOKING_ID);
    await waitFor(() => expect(hideNotesSwitch()).toBeInTheDocument());
    expect(screen.getByText(/只影響這一筆，不影響其他訂單/)).toBeInTheDocument();
  });

  it("#859:內部備註欄位的標籤只寫「客戶看不到」,不再寫死「服務人員看得到」", async () => {
    getBookingMock.mockResolvedValue(editingDetail(false));
    renderForm(BOOKING_ID);
    await waitFor(() => expect(hideNotesSwitch()).toBeInTheDocument());
    // 旁邊就有一個可以改變這件事的開關,再寫死「服務人員看得到」會是同一畫面兩句話互相矛盾。
    expect(screen.queryByText(/客戶看不到，服務人員看得到/)).not.toBeInTheDocument();
  });

  it("#857:編輯一筆「已經勾起來」的訂單,開啟表單時開關就是開著的", async () => {
    getBookingMock.mockResolvedValue(editingDetail(true));
    renderForm(BOOKING_ID);
    await waitFor(() => expect(hideNotesSwitch()).toHaveAttribute("data-state", "checked"));
  });

  it("🔴 #857:編輯已勾起來的訂單、完全沒碰開關就儲存 → payload 仍然是 true(不會被靜默清掉)", async () => {
    getBookingMock.mockResolvedValue(editingDetail(true));
    renderForm(BOOKING_ID);
    await waitFor(() => expect(hideNotesSwitch()).toHaveAttribute("data-state", "checked"));

    screen.getByRole("button", { name: "儲存變更" }).click();

    await waitFor(() => expect(updateBookingMock).toHaveBeenCalledTimes(1));
    expect(updateBookingMock.mock.calls[0]?.[0]).toMatchObject({
      bookingId: BOOKING_ID,
      hideNotesFromStaff: true,
    });
  });

  it("#852:關掉開關之後送出的是 false,而且這個欄位真的有帶(不是被 falsy 判斷省略掉)", async () => {
    getBookingMock.mockResolvedValue(editingDetail(true));
    renderForm(BOOKING_ID);
    await waitFor(() => expect(hideNotesSwitch()).toHaveAttribute("data-state", "checked"));

    hideNotesSwitch().click();
    await waitFor(() => expect(hideNotesSwitch()).toHaveAttribute("data-state", "unchecked"));

    screen.getByRole("button", { name: "儲存變更" }).click();

    await waitFor(() => expect(updateBookingMock).toHaveBeenCalledTimes(1));
    const payload = updateBookingMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["hideNotesFromStaff"]).toBe(false);
    // 「有這個 key」跟「值是 false」是兩件事,兩個都要測 —— 漏帶 key 是這次最危險的那個 bug。
    expect(Object.prototype.hasOwnProperty.call(payload, "hideNotesFromStaff")).toBe(true);
  });

  it("🔴 紅利系統重構批次 3/7:紅利區塊沒出現(功能關閉)時,編輯表單儲存明確送 pointsRedeemed = null(= 維持原折抵),而且 memberId 這個 key 一定在", async () => {
    // 批次 7 起編輯表單有紅利區塊,但功能關閉時整塊不渲染 ⇒ 不可以拿「沒有折抵開關」當成 0 送出
    //(那會把客人已折抵的點數默默退掉,§〇.4 判斷 15);派點也不可以帶值(功能關閉時後端會擋)。
    // memberId 漏帶則會讓後端把會員清空(v2.4 裁決 5 R7)。
    // 用「已勾起來」的那筆:開關變成 checked = 訂單詳情已經載入完成,才按儲存。
    getBookingMock.mockResolvedValue(editingDetail(true));
    renderForm(BOOKING_ID);
    await waitFor(() => expect(hideNotesSwitch()).toHaveAttribute("data-state", "checked"));

    screen.getByRole("button", { name: "儲存變更" }).click();

    await waitFor(() => expect(updateBookingMock).toHaveBeenCalledTimes(1));
    const payload = updateBookingMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(payload, "pointsRedeemed")).toBe(true);
    expect(payload["pointsRedeemed"]).toBeNull();
    expect(payload["pointsOverride"]).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(payload, "memberId")).toBe(true);
  });

  it("#850:新建訂單時開關預設是關的(= 使用者要的「預設服務人員看得到」)", async () => {
    renderForm(null);
    await waitFor(() => expect(hideNotesSwitch()).toHaveAttribute("data-state", "unchecked"));
    // 新建模式不會去查既有訂單詳情。
    expect(getBookingMock).not.toHaveBeenCalled();
    // 📌 「新建時送出的 payload 帶 false」刻意**不在這裡**測:新建流程還要先選服務項目、選付款
    //    方式才過得了送出前驗證,把那些都鋪出來會讓這條測試變成在測「建單驗證」而不是在測旗標。
    //    payload 這一段改在 api.ts 那一層釘死(bookingHideNotesRpc.test.ts),更直接也更穩。
  });
});
