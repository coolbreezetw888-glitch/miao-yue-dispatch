// SPECS-INDEX #979 / #980(2026-10-06):建單表單整張掛起來測「選擇項目」整頁、付款方式下拉、時間選單。
//
// 釘住的是「畫面看起來對、送出去的東西錯了」那一類:
//   ・整頁:切頁籤、跨分類勾兩項、調數量、自訂金額 → 確認 → 表單摘要 + 送出的 payload 正確
//   ・返回箭頭 / Esc = 放棄這次修改(表單維持原狀、整張表單不會被關掉)
//   ・跨頁籤保留勾選
//   ・付款方式是下拉選單,選了才送得出去
//   ・時間:拿什麼參數問資料庫(工時、編輯時排除自己);原本的時間變得不能選 ⇒ 清空 + 常駐提示
// 純邏輯細節在 serviceItemPickerLogic.test.ts / bookingTimeOptions.test.ts。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getBookingMock, createBookingMock, updateBookingMock, slotsMock, toastMock } = vi.hoisted(
  () => ({
    getBookingMock: vi.fn(),
    createBookingMock: vi.fn(),
    updateBookingMock: vi.fn(),
    slotsMock: vi.fn(),
    toastMock: { success: vi.fn(), error: vi.fn() },
  }),
);

const MERCHANT_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_ID = "22222222-2222-4222-8222-222222222222";
const BOOKING_ID = "44444444-4444-4444-8444-444444444444";
const PAYMENT_METHOD_ID = "77777777-7777-4777-8777-777777777777";
const CAT_WALL = "c0000000-0000-4000-8000-000000000001";
const CAT_DUCT = "c0000000-0000-4000-8000-000000000002";
const ITEM_WALL = "a0000000-0000-4000-8000-000000000001";
const ITEM_WALL_SPECIAL = "a0000000-0000-4000-8000-000000000002";
const ITEM_DUCT = "a0000000-0000-4000-8000-000000000003";

vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("./api", () => ({
  getBooking: getBookingMock,
  createBooking: createBookingMock,
  updateBooking: updateBookingMock,
  previewBookingPoints: vi.fn(async () => ({ feature_enabled: false })),
  fetchStaffBookableStartTimes: slotsMock,
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
      open_time: "09:00",
      close_time: "18:00",
    })),
  }),
  useMerchantCalendarStateStyles: () => ({ data: undefined }),
  useMerchantDaySchedule: () => ({
    data: {
      business_hours: {
        has_setting: true,
        is_closed: false,
        open_time: "09:00",
        close_time: "18:00",
      },
      staff: [],
    },
    isLoading: false,
    error: null,
  }),
  useMerchantMaterialCostItems: () => ({ data: [] }),
  useMerchantPaymentMethods: () => ({
    data: [
      { id: PAYMENT_METHOD_ID, name: "現金" },
      { id: "88888888-8888-4888-8888-888888888888", name: "轉帳" },
    ],
  }),
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
    data: [{ id: STAFF_ID, name: "服務人員甲", no_time_slot_limit: false }],
  }),
}));

vi.mock("@/modules/service-items/context", () => ({
  useMerchantServiceCategories: () => ({
    data: [
      { id: CAT_WALL, name: "壁掛分離式" },
      { id: CAT_DUCT, name: "吊隱式" },
    ],
  }),
  useMerchantServiceItems: () => ({
    data: [
      {
        id: ITEM_WALL,
        name: "壁掛普通",
        price: 2200,
        duration_minutes: 60,
        category_id: CAT_WALL,
        status: "active",
      },
      {
        id: ITEM_WALL_SPECIAL,
        name: "壁掛特殊",
        price: 2700,
        duration_minutes: 90,
        category_id: CAT_WALL,
        status: "active",
      },
      {
        id: ITEM_DUCT,
        name: "吊隱清洗",
        price: 3500,
        duration_minutes: 120,
        category_id: CAT_DUCT,
        status: "active",
      },
    ],
  }),
}));

import { BookingFormDialog } from "./CalendarPage";
import { ALL_DAY_START_TIMES, selectPaymentMethod } from "./bookingFormTestUtils";

function renderForm(
  opts: {
    editingBookingId?: string | null;
    onOpenChange?: (o: boolean) => void;
    /** 不給 = 從行事曆點 10:00 那一格進來(使用者選的);null = 按「新增預約」按鈕(系統預設 10:00)。 */
    prefillTime?: string | null;
  } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <BookingFormDialog
          merchantId={MERCHANT_ID}
          industryType="in_store_beauty"
          open
          onOpenChange={opts.onOpenChange ?? (() => {})}
          prefill={{
            staffId: STAFF_ID,
            dateKey: "2036-01-07",
            ...(opts.prefillTime === null ? {} : { time: opts.prefillTime ?? "10:00" }),
          }}
          editingBookingId={opts.editingBookingId ?? null}
          onSaved={() => {}}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function openPicker() {
  fireEvent.click(document.getElementById("booking-service-items") as HTMLElement);
  return screen.getByTestId("service-item-picker");
}

function tab(picker: HTMLElement, name: string) {
  const t = within(picker).getByRole("tab", { name });
  // Radix Tabs 在 jsdom 用 mouseDown 切換(跟 click 不同)。
  fireEvent.mouseDown(t, { button: 0 });
  return t;
}

describe("建單表單 × 選擇項目整頁(#979)", () => {
  beforeEach(() => {
    slotsMock.mockResolvedValue(ALL_DAY_START_TIMES);
    createBookingMock.mockResolvedValue({
      id: BOOKING_ID,
      merchant_id: MERCHANT_ID,
      final_amount_snapshot: 0,
      member_id: null,
      member_name_snapshot: null,
      member_auto_created: false,
      points_planned: 0,
      points_redeemed: 0,
      points_redeem_amount_snapshot: 0,
    });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("表單上只剩「選擇項目 >」一列;沒選時顯示「選擇項目」,不再有一顆顆方塊", () => {
    renderForm();
    const row = document.getElementById("booking-service-items") as HTMLElement;
    expect(row).toHaveTextContent("選擇項目");
    expect(screen.queryByRole("button", { name: /壁掛普通/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("服務項目分類篩選")).not.toBeInTheDocument();
  });

  it("切頁籤 → 跨分類勾兩項 → 調數量 → 自訂金額 → 確認 ⇒ 摘要正確、送出的單價 / 數量正確", async () => {
    renderForm();
    const picker = openPicker();
    // 預設停在第一個有項目的分類
    expect(within(picker).getByRole("checkbox", { name: /壁掛普通/ })).toBeInTheDocument();
    expect(within(picker).queryByRole("checkbox", { name: /吊隱清洗/ })).not.toBeInTheDocument();

    tab(picker, "吊隱式");
    fireEvent.click(within(picker).getByRole("checkbox", { name: /吊隱清洗/ }));
    // 勾選後展開自訂金額,預設「使用原價」
    expect(within(picker).getByText("使用原價（NT$ 3,500）")).toBeInTheDocument();
    fireEvent.click(within(picker).getByRole("switch", { name: "自訂金額" }));
    const priceInput = within(picker).getByLabelText("單價");
    fireEvent.change(priceInput, { target: { value: "3000" } });

    tab(picker, "壁掛分離式");
    fireEvent.click(within(picker).getByRole("checkbox", { name: /壁掛普通/ }));
    fireEvent.click(within(picker).getByRole("button", { name: "增加「壁掛普通」的數量" }));
    expect(within(picker).getByLabelText("「壁掛普通」的數量")).toHaveValue(2);

    fireEvent.click(within(picker).getByRole("button", { name: "確認（已選 2 項）" }));
    expect(screen.queryByTestId("service-item-picker")).not.toBeInTheDocument();

    const summary = screen.getByTestId("booking-selected-items-summary");
    expect(within(summary).getByText("吊隱清洗 × 1")).toBeInTheDocument();
    expect(within(summary).getByText("壁掛普通 × 2")).toBeInTheDocument();
    expect(within(summary).getByText("$3,000")).toBeInTheDocument();
    expect(within(summary).getByText("$4,400")).toBeInTheDocument();
    expect(within(summary).getByText("$7,400")).toBeInTheDocument();

    fireEvent.change(document.getElementById("booking-customer-name") as HTMLElement, {
      target: { value: "王小明" },
    });
    fireEvent.change(document.getElementById("booking-customer-phone") as HTMLElement, {
      target: { value: "0912345678" },
    });
    await selectPaymentMethod("現金");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "建立預約" }));
    });
    await waitFor(() => expect(createBookingMock).toHaveBeenCalledTimes(1));
    const payload = createBookingMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["serviceItems"]).toEqual([
      { serviceItemId: ITEM_DUCT, quantity: 1, unitPrice: 3000 },
      { serviceItemId: ITEM_WALL, quantity: 2, unitPrice: 2200 },
    ]);
    expect(payload["paymentMethodId"]).toBe(PAYMENT_METHOD_ID);
  });

  it("跨頁籤保留勾選狀態", () => {
    renderForm();
    const picker = openPicker();
    fireEvent.click(within(picker).getByRole("checkbox", { name: /壁掛特殊/ }));
    tab(picker, "吊隱式");
    tab(picker, "壁掛分離式");
    expect(within(picker).getByRole("checkbox", { name: /壁掛特殊/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("返回箭頭 = 放棄這次修改:表單維持打開前的狀態", () => {
    renderForm();
    let picker = openPicker();
    fireEvent.click(within(picker).getByRole("checkbox", { name: /壁掛普通/ }));
    fireEvent.click(within(picker).getByRole("button", { name: "確認（已選 1 項）" }));
    expect(screen.getByText("壁掛普通 × 1")).toBeInTheDocument();

    picker = openPicker();
    fireEvent.click(within(picker).getByRole("checkbox", { name: /壁掛普通/ })); // 取消
    fireEvent.click(within(picker).getByRole("checkbox", { name: /壁掛特殊/ })); // 新勾
    fireEvent.click(within(picker).getByRole("button", { name: "返回，不套用這次的修改" }));

    expect(screen.queryByTestId("service-item-picker")).not.toBeInTheDocument();
    expect(screen.getByText("壁掛普通 × 1")).toBeInTheDocument();
    expect(screen.queryByText(/壁掛特殊 ×/)).not.toBeInTheDocument();
  });

  it("整頁開著按 Esc ⇒ 只關整頁(等同返回),整張建單表單不會被關掉", () => {
    const onOpenChange = vi.fn();
    renderForm({ onOpenChange });
    const picker = openPicker();
    fireEvent.click(within(picker).getByRole("checkbox", { name: /壁掛普通/ }));
    fireEvent.keyDown(picker, { key: "Escape" });
    expect(screen.queryByTestId("service-item-picker")).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.queryByTestId("booking-selected-items-summary")).not.toBeInTheDocument();
  });

  it("自訂金額填錯 ⇒ 標紅 + 確認鈕擋住 + 常駐 `!`", () => {
    renderForm();
    const picker = openPicker();
    fireEvent.click(within(picker).getByRole("checkbox", { name: /壁掛普通/ }));
    fireEvent.click(within(picker).getByRole("switch", { name: "自訂金額" }));
    fireEvent.change(within(picker).getByLabelText("單價"), { target: { value: "abc" } });
    expect(within(picker).getByRole("button", { name: /^確認/ })).toBeDisabled();
    expect(within(picker).getByText(/自訂金額填錯了/)).toBeInTheDocument();
  });

  it("付款方式是下拉選單(不再是一排單選方塊),選項是商家上架中的付款方式", async () => {
    renderForm();
    expect(screen.queryByRole("radio", { name: "現金" })).not.toBeInTheDocument();
    expect(document.getElementById("booking-payment-method")).toHaveAttribute("role", "combobox");
    await selectPaymentMethod("轉帳");
    expect(document.getElementById("booking-payment-method")).toHaveTextContent("轉帳");
  });
});

describe("建單表單 × 時間只列能約的(#980)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("新增:用一格 30 分鐘問、不帶排除;選了 60 分鐘的項目 ⇒ 改用 60 分鐘重問", async () => {
    slotsMock.mockResolvedValue(ALL_DAY_START_TIMES);
    renderForm();
    await waitFor(() =>
      expect(slotsMock).toHaveBeenCalledWith({
        merchantId: MERCHANT_ID,
        staffId: STAFF_ID,
        date: "2036-01-07",
        durationMinutes: 30,
        excludeBookingId: null,
      }),
    );
    const picker = openPicker();
    fireEvent.click(within(picker).getByRole("checkbox", { name: /壁掛普通/ }));
    fireEvent.click(within(picker).getByRole("button", { name: /^確認/ }));
    await waitFor(() =>
      expect(slotsMock).toHaveBeenCalledWith(expect.objectContaining({ durationMinutes: 60 })),
    );
  });

  // 主腦裁決(第 2 批第 3 項):只有「使用者自己選的時間」變得不能約才提示;系統預設值安靜清空。
  it("🔴 系統預設的 10:00(按「新增預約」按鈕)不能約 ⇒ 安靜清空,不跳提示", async () => {
    slotsMock.mockResolvedValue(["11:00", "11:30"]);
    renderForm({ prefillTime: null });
    await waitFor(() =>
      expect(document.getElementById("booking-datetime")).toHaveTextContent("請選擇日期時間"),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByText("這個時間已無法預約，請重新選擇")).not.toBeInTheDocument();
  });

  it("系統預設的 10:00 可以約 ⇒ 照舊保留", async () => {
    slotsMock.mockResolvedValue(ALL_DAY_START_TIMES);
    renderForm({ prefillTime: null });
    await waitFor(() => expect(slotsMock).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(document.getElementById("booking-datetime")).toHaveTextContent("10:00");
  });

  it("🔴 使用者自己在清單選的時間,改了項目後變得不能約 ⇒ 清空並常駐提示", async () => {
    // 30 分鐘(還沒選項目)整天都能約;選了 60 分鐘的項目之後只剩 13:00。
    slotsMock.mockImplementation(async (p: { durationMinutes: number }) =>
      p.durationMinutes === 30 ? ALL_DAY_START_TIMES : ["13:00"],
    );
    renderForm({ prefillTime: null });
    await waitFor(() => expect(slotsMock).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(document.getElementById("booking-datetime") as HTMLElement);
    });
    const panel = await screen.findByTestId("booking-time-options");
    fireEvent.click(await within(panel).findByRole("button", { name: "11:00" }));
    expect(document.getElementById("booking-datetime")).toHaveTextContent("11:00");
    expect(screen.queryByText("這個時間已無法預約，請重新選擇")).not.toBeInTheDocument();

    const picker = openPicker();
    fireEvent.click(within(picker).getByRole("checkbox", { name: /壁掛普通/ }));
    fireEvent.click(within(picker).getByRole("button", { name: /^確認/ }));
    expect(await screen.findByText("這個時間已無法預約，請重新選擇")).toBeInTheDocument();
    expect(document.getElementById("booking-datetime")).toHaveTextContent("請選擇日期時間");
  });

  it("從行事曆點格子進來的時間(使用者選的)不在可約清單裡 ⇒ 清空並常駐提示「這個時間已無法預約，請重新選擇」", async () => {
    slotsMock.mockResolvedValue(["11:00", "11:30"]);
    renderForm();
    expect(await screen.findByText("這個時間已無法預約，請重新選擇")).toBeInTheDocument();
    expect(document.getElementById("booking-datetime")).toHaveTextContent("請選擇日期時間");
  });

  it("時間清單只列資料庫回來的時間;空的 ⇒「這天沒有可預約的時間」", async () => {
    slotsMock.mockResolvedValue(["10:00", "15:00"]);
    renderForm();
    await waitFor(() => expect(slotsMock).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(document.getElementById("booking-datetime") as HTMLElement);
    });
    const panel = await screen.findByTestId("booking-time-options");
    await waitFor(() =>
      expect(within(panel).getByRole("button", { name: "15:00" })).toBeInTheDocument(),
    );
    expect(within(panel).getAllByRole("button")).toHaveLength(2);
    cleanup();

    slotsMock.mockResolvedValue([]);
    renderForm();
    await act(async () => {
      fireEvent.click(document.getElementById("booking-datetime") as HTMLElement);
    });
    expect(await screen.findByText("這天沒有可預約的時間")).toBeInTheDocument();
  });

  it("編輯既有訂單 ⇒ 帶這筆的 id 當排除(自己原本的時間不算衝突),原本的時間不會被清掉", async () => {
    slotsMock.mockResolvedValue(["09:00"]); // 刻意不含原本的 10:00
    getBookingMock.mockResolvedValue({
      id: BOOKING_ID,
      merchant_id: MERCHANT_ID,
      staff_id: STAFF_ID,
      start_at: "2036-01-07T02:00:00+00:00",
      end_at: "2036-01-07T03:00:00+00:00",
      status: "accepted",
      customer_name: "王小明",
      customer_phone: "0912345678",
      customer_email: null,
      customer_address: null,
      notes: null,
      customer_notes: null,
      hide_notes_from_staff: false,
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
      final_amount_snapshot: 2200,
      payment_method_id: PAYMENT_METHOD_ID,
      payment_method_name_snapshot: "現金",
      custom_duration_enabled: false,
      custom_duration_minutes: null,
      points_planned: 0,
      points_planned_auto: 0,
      points_planned_overridden: false,
      points_redeemed: 0,
      points_redeem_amount_snapshot: 0,
      serviceItems: [
        { id: ITEM_WALL, name: "壁掛普通", quantity: 1, unitPriceSnapshot: 2200, lineTotal: 2200 },
      ],
      assistants: [],
      materialCosts: [],
    });
    renderForm({ editingBookingId: BOOKING_ID });
    await waitFor(() =>
      expect(slotsMock).toHaveBeenCalledWith(
        expect.objectContaining({ excludeBookingId: BOOKING_ID, durationMinutes: 60 }),
      ),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(document.getElementById("booking-datetime")).toHaveTextContent("10:00");
    expect(screen.queryByText("這個時間已無法預約，請重新選擇")).not.toBeInTheDocument();
  });
});

// 第 11 批 J(#995 J-13 / J-14 L1):建單 / 編輯預約的「填過資料」接線。
// 打開不改 ⇒ Esc 直接關;改一個字 ⇒ Esc 先問「確定放棄這次輸入？」。
// 特別釘住「基準拍太早」那一類(一打開就問放棄):編輯資料非同步載入、系統預設 10:00 被自動清空。
describe("建單表單 × 填過資料才問放棄(第 11 批 J)", () => {
  const EDIT_DETAIL = {
    id: BOOKING_ID,
    merchant_id: MERCHANT_ID,
    staff_id: STAFF_ID,
    start_at: "2036-01-07T02:00:00+00:00",
    end_at: "2036-01-07T03:00:00+00:00",
    status: "accepted",
    customer_name: "王小明",
    customer_phone: "0912345678",
    customer_email: null,
    customer_address: null,
    notes: null,
    customer_notes: null,
    hide_notes_from_staff: false,
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
    final_amount_snapshot: 2200,
    payment_method_id: PAYMENT_METHOD_ID,
    payment_method_name_snapshot: "現金",
    custom_duration_enabled: false,
    custom_duration_minutes: null,
    points_planned: 0,
    points_planned_auto: 0,
    points_planned_overridden: false,
    points_redeemed: 0,
    points_redeem_amount_snapshot: 0,
    serviceItems: [
      { id: ITEM_WALL, name: "壁掛普通", quantity: 1, unitPriceSnapshot: 2200, lineTotal: 2200 },
    ],
    assistants: [],
    materialCosts: [],
  };

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  async function settle() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }

  function pressEscOnForm() {
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  }

  it("新增:不改 ⇒ Esc 直接關", async () => {
    slotsMock.mockResolvedValue(ALL_DAY_START_TIMES);
    const onOpenChange = vi.fn();
    renderForm({ onOpenChange });
    await settle();
    pressEscOnForm();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText("確定放棄這次輸入？")).not.toBeInTheDocument();
  });

  it("新增:填客戶姓名一個字 ⇒ Esc 先問放棄,不關", async () => {
    slotsMock.mockResolvedValue(ALL_DAY_START_TIMES);
    const onOpenChange = vi.fn();
    renderForm({ onOpenChange });
    await settle();
    fireEvent.change(document.getElementById("booking-customer-name") as HTMLElement, {
      target: { value: "王" },
    });
    pressEscOnForm();
    expect(await screen.findByText("確定放棄這次輸入？")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("新增:在「選擇項目」整頁勾項目、按確認寫回表單 ⇒ 算填過", async () => {
    slotsMock.mockResolvedValue(ALL_DAY_START_TIMES);
    const onOpenChange = vi.fn();
    renderForm({ onOpenChange });
    await settle();
    const picker = openPicker();
    fireEvent.click(within(picker).getByRole("checkbox", { name: /壁掛普通/ }));
    fireEvent.click(within(picker).getByRole("button", { name: /^確認/ }));
    await settle();
    pressEscOnForm();
    expect(await screen.findByText("確定放棄這次輸入？")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("🔴 系統預設 10:00 不能約、被自動清空 ⇒ 不算填過,Esc 直接關", async () => {
    slotsMock.mockResolvedValue(["11:00", "11:30"]);
    const onOpenChange = vi.fn();
    renderForm({ onOpenChange, prefillTime: null });
    await waitFor(() =>
      expect(document.getElementById("booking-datetime")).toHaveTextContent("請選擇日期時間"),
    );
    await settle();
    pressEscOnForm();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText("確定放棄這次輸入？")).not.toBeInTheDocument();
  });

  it("編輯:資料載入後不改 ⇒ Esc 直接關;改一個字 ⇒ Esc 先問", async () => {
    slotsMock.mockResolvedValue(ALL_DAY_START_TIMES);
    getBookingMock.mockResolvedValue(EDIT_DETAIL);
    const onOpenChange = vi.fn();
    renderForm({ editingBookingId: BOOKING_ID, onOpenChange });
    await waitFor(() =>
      expect(document.getElementById("booking-customer-name")).toHaveValue("王小明"),
    );
    await settle();
    pressEscOnForm();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();

    fireEvent.change(document.getElementById("booking-customer-name") as HTMLElement, {
      target: { value: "王小明2" },
    });
    pressEscOnForm();
    expect(await screen.findByText("確定放棄這次輸入？")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
