// SPECS-INDEX #977 第 7 批(2026-10-07):建單 / 編輯表單的「服務人員模式」+ 商家模式送出參數鎖住不變。
//
//   ・商家模式(預設):編輯送出的 updateBooking 參數整包比對(含主要服務人員、協助人員、會員、隱藏備註、料錢)
//     ⇒ 這批加了資料來源層與服務人員分支之後,商家端送出的東西一個 key 都沒變(故障注入 11 的守門)
//   ・服務人員模式:沒有服務人員下拉(唯讀一行自己的名字)、沒有協助人員欄位(編輯時唯讀「由商家指派」)、
//     沒有會員比對面板、沒有「不讓服務人員看到」開關;內部備註被藏起來的單沒有內部備註欄;
//     送出打 staffCreateBooking / staffUpdateBooking,參數裡沒有協助人員 / 會員 / 隱藏備註 / 其他服務人員
//   ・#986 第 9 批(使用者裁決推翻主腦決定 C):服務人員模式「有料錢」—— 商家料錢總開關開著才出現(關著就沒有),
//     編輯時預帶這張單的料錢,送出一律帶 materialCostItems(含空陣列;第 11 批 F 起含數量 / 單價)
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getBooking: vi.fn(),
  createBooking: vi.fn(),
  updateBooking: vi.fn(),
  staffCreateBooking: vi.fn(),
  staffUpdateBooking: vi.fn(),
  fetchStaffBookingFormOptions: vi.fn(),
  fetchStaffBookingForEdit: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

const MERCHANT_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_ID = "22222222-2222-4222-8222-222222222222";
const ASSISTANT_ID = "55555555-5555-4555-8555-555555555555";
const SERVICE_ITEM_ID = "33333333-3333-4333-8333-333333333333";
const BOOKING_ID = "44444444-4444-4444-8444-444444444444";
const MEMBER_ID = "66666666-6666-4666-8666-666666666666";
const PM_ID = "77777777-7777-4777-8777-777777777777";
const MATERIAL_ID = "88888888-8888-4888-8888-888888888888";

vi.mock("sonner", () => ({ toast: m.toast }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({}), rpc: () => ({}), channel: () => ({}) },
}));

vi.mock("./api", () => ({
  getBooking: m.getBooking,
  createBooking: m.createBooking,
  updateBooking: m.updateBooking,
  previewBookingPoints: vi.fn(async () => ({ feature_enabled: false })),
  fetchStaffBookableStartTimes: vi.fn(async () => ALL_DAY_START_TIMES),
  MATERIAL_COST_ENABLED_FEATURE_KEY: "material_cost_enabled",
}));

vi.mock("@/modules/staff-portal/api", () => ({
  fetchStaffBookingFormOptions: m.fetchStaffBookingFormOptions,
  fetchStaffBookingForEdit: m.fetchStaffBookingForEdit,
  fetchMyBookableStartTimes: vi.fn(async () => ALL_DAY_START_TIMES),
  staffPreviewBookingPoints: vi.fn(async () => ({ feature_enabled: false })),
  staffCreateBooking: m.staffCreateBooking,
  staffUpdateBooking: m.staffUpdateBooking,
}));
vi.mock("@/modules/staff-portal/context", () => ({
  useMyDayScheduleState: () => ({
    data: { on_leave: null, availability_overrides: [], foreign_bookings: [] },
  }),
}));
vi.mock("@/modules/staff-portal/MyCalendarPage", () => ({ default: () => null }));

vi.mock("./BookingDetailDialog", () => ({ BookingDetailDialog: () => null }));
vi.mock("@/modules/members/MemberPhoneMatchPanel", () => ({
  MemberPhoneMatchPanel: () => <div data-testid="member-phone-match-panel" />,
}));

vi.mock("./context", () => ({
  setStaffDayOverride: vi.fn(),
  useMerchantBookings: () => ({ data: [], isLoading: false, error: null }),
  useMerchantBookingStatusColors: () => ({ data: undefined }),
  useMerchantBusinessHours: () => ({
    data: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, is_closed: false })),
  }),
  useMerchantCalendarStateStyles: () => ({ data: undefined }),
  useMerchantDaySchedule: () => ({
    data: { business_hours: { has_setting: true, is_closed: false }, staff: [] },
    isLoading: false,
    error: null,
  }),
  useMerchantMaterialCostItems: () => ({ data: [{ id: MATERIAL_ID, name: "冷媒", amount: 200 }] }),
  useMerchantPaymentMethods: () => ({ data: [{ id: PM_ID, name: "現金" }] }),
  useMerchantTaxSettings: () => ({ data: null }),
}));

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({
    merchant: { id: MERCHANT_ID, name: "測試商家", industry_type: "in_store_beauty" },
    isLoading: false,
  }),
}));
vi.mock("@/modules/merchant/api", () => ({ getFeatureFlag: vi.fn(async () => true) }));

vi.mock("@/modules/staff-agent/context", () => ({
  useAgentPermission: () => ({ data: true, isLoading: false }),
  useCurrentMerchantRole: () => ({ data: "admin", isLoading: false }),
  useMerchantStaffList: () => ({
    data: [
      { id: STAFF_ID, name: "服務人員甲" },
      { id: ASSISTANT_ID, name: "服務人員乙" },
    ],
  }),
}));

vi.mock("@/modules/service-items/context", () => ({
  useMerchantServiceCategories: () => ({ data: [] }),
  useMerchantServiceItems: () => ({
    data: [
      {
        id: SERVICE_ITEM_ID,
        name: "冷氣清洗",
        price: 1000,
        duration_minutes: 60,
        category_id: null,
      },
    ],
  }),
}));

import { BookingFormDialog } from "./CalendarPage";
import {
  ALL_DAY_START_TIMES,
  pickMaterialCosts,
  pickServiceItems,
  selectPaymentMethod,
} from "./bookingFormTestUtils";

const STAFF_ACTOR = { kind: "staff" as const, staffId: STAFF_ID, staffName: "服務人員甲" };

function merchantEditingDetail() {
  return {
    id: BOOKING_ID,
    merchant_id: MERCHANT_ID,
    staff_id: STAFF_ID,
    start_at: "2036-01-05T02:00:00+00:00",
    end_at: "2036-01-05T03:00:00+00:00",
    status: "accepted",
    customer_name: "陳先生",
    customer_phone: "0912345678",
    customer_email: null,
    customer_address: null,
    notes: "上次尾款沒收",
    customer_notes: "有養狗",
    hide_notes_from_staff: true,
    member_id: MEMBER_ID,
    member_name_snapshot: "陳先生",
    custom_total_amount_enabled: false,
    custom_total_amount: null,
    discount_enabled: false,
    discount_mode: null,
    discount_value: null,
    tax_enabled: false,
    tax_mode_snapshot: null,
    tax_value_snapshot: null,
    final_amount_snapshot: 1000,
    payment_method_id: PM_ID,
    payment_method_name_snapshot: "現金",
    custom_duration_enabled: false,
    custom_duration_minutes: null,
    points_planned: 0,
    points_planned_auto: 0,
    points_planned_overridden: false,
    points_redeemed: 0,
    points_redeem_amount_snapshot: 0,
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
    assistants: [{ staffId: ASSISTANT_ID, staffName: "服務人員乙" }],
    materialCosts: [
      { materialCostItemId: MATERIAL_ID, name: "冷媒", quantity: 1, amountSnapshot: 200 },
    ],
  };
}

function staffEditRow(notesHidden: boolean) {
  return {
    id: BOOKING_ID,
    merchant_id: MERCHANT_ID,
    staff_id: STAFF_ID,
    status: "accepted",
    start_at: "2036-01-05T02:00:00+00:00",
    end_at: "2036-01-05T03:00:00+00:00",
    customer_name: "陳先生",
    customer_phone: "0912345678",
    customer_email: null,
    customer_address: null,
    customer_notes: "有養狗",
    notes: notesHidden ? null : "一般備註",
    notes_hidden: notesHidden,
    custom_total_amount_enabled: false,
    custom_total_amount: null,
    discount_enabled: false,
    discount_mode: null,
    discount_value: null,
    tax_enabled: false,
    tax_mode_snapshot: null,
    tax_value_snapshot: null,
    payment_method_id: PM_ID,
    payment_method_name_snapshot: "現金",
    custom_duration_enabled: false,
    custom_duration_minutes: null,
    member_id: MEMBER_ID,
    member_name_snapshot: "陳先生",
    points_planned: 0,
    points_planned_auto: 0,
    points_planned_overridden: false,
    points_redeemed: 0,
    points_redeem_amount_snapshot: 0,
    service_items: [
      {
        service_item_id: SERVICE_ITEM_ID,
        name: "冷氣清洗",
        quantity: 1,
        unit_price_snapshot: 1000,
      },
    ],
    assistant_names: ["服務人員乙"],
  };
}

const STAFF_OPTIONS = {
  staff_id: STAFF_ID,
  staff_name: "服務人員甲",
  industry_type: "in_store_beauty",
  service_items: [
    { id: SERVICE_ITEM_ID, name: "冷氣清洗", price: 1000, duration_minutes: 60, category_id: null },
  ],
  service_categories: [],
  payment_methods: [{ id: PM_ID, name: "現金" }],
  tax_settings: null,
  business_hours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, is_closed: false })),
};

function renderForm(props: { editingBookingId: string | null; staff?: boolean }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <BookingFormDialog
          merchantId={MERCHANT_ID}
          industryType="in_store_beauty"
          open
          onOpenChange={() => {}}
          prefill={{ staffId: STAFF_ID, dateKey: "2036-01-05", time: "10:00" }}
          editingBookingId={props.editingBookingId}
          onSaved={() => {}}
          {...(props.staff ? { actor: STAFF_ACTOR } : {})}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  m.getBooking.mockResolvedValue(merchantEditingDetail());
  m.updateBooking.mockResolvedValue({ id: BOOKING_ID, merchant_id: MERCHANT_ID });
  m.staffUpdateBooking.mockResolvedValue({ id: BOOKING_ID, merchant_id: MERCHANT_ID });
  m.staffCreateBooking.mockResolvedValue({
    id: BOOKING_ID,
    merchant_id: MERCHANT_ID,
    status: "pending_confirmation",
    member_id: null,
    member_name_snapshot: null,
    member_auto_created: false,
    final_amount_snapshot: 1000,
    points_planned: 0,
    points_redeemed: 0,
    points_redeem_amount_snapshot: 0,
  });
  m.fetchStaffBookingFormOptions.mockResolvedValue(STAFF_OPTIONS);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// #986 第 9 批:materialCostItemIds 不再是禁止的 key(服務人員可看可改料錢)。
const FORBIDDEN_STAFF_KEYS = ["assistantStaffIds", "memberId", "hideNotesFromStaff", "merchantId"];

const REMOVED_MATERIAL_ID = "99999999-9999-4999-8999-999999999999";
const STAFF_OPTIONS_WITH_MATERIAL = {
  ...STAFF_OPTIONS,
  material_cost_enabled: true,
  material_cost_items: [{ id: MATERIAL_ID, name: "冷媒", amount: 200 }],
  start_time_interval_minutes: 30,
};

describe("商家模式:送出參數跟改版前完全一樣(#977 第 7 批鎖住)", () => {
  it("編輯送出 updateBooking 的整包參數(主要服務人員、協助人員、會員、隱藏備註、料錢都照原值帶)", async () => {
    renderForm({ editingBookingId: BOOKING_ID });
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /不讓服務人員看到這則內部備註/ })).toHaveAttribute(
        "data-state",
        "checked",
      ),
    );
    expect(screen.getByTestId("member-phone-match-panel")).toBeInTheDocument();
    screen.getByRole("button", { name: "儲存變更" }).click();
    await waitFor(() => expect(m.updateBooking).toHaveBeenCalledTimes(1));
    expect(m.updateBooking.mock.calls[0]?.[0]).toEqual({
      bookingId: BOOKING_ID,
      staffId: STAFF_ID,
      serviceItems: [{ serviceItemId: SERVICE_ITEM_ID, quantity: 1, unitPrice: 1000 }],
      startAt: "2036-01-05T10:00:00+08:00",
      customerName: "陳先生",
      customerPhone: "0912345678",
      customerEmail: null,
      customerAddress: null,
      notes: "上次尾款沒收",
      customerNotes: "有養狗",
      hideNotesFromStaff: true,
      memberId: MEMBER_ID,
      assistantStaffIds: [ASSISTANT_ID],
      // 第 11 批 F #993:料錢改送 {品項, 數量, 單價};沒動 ⇒ 數量 1、單價 = 單上快照 200。
      materialCostItems: [{ materialCostItemId: MATERIAL_ID, quantity: 1, unitPrice: 200 }],
      customTotalAmountEnabled: false,
      customTotalAmount: null,
      discountEnabled: false,
      discountMode: null,
      discountValue: null,
      taxEnabled: false,
      taxMode: null,
      taxValue: null,
      paymentMethodId: PM_ID,
      customDurationEnabled: false,
      customDurationMinutes: null,
      pointsRedeemed: null,
      pointsOverride: null,
      pointsOverrideReset: false,
      pointsRedeemMemberId: null,
      changeSummary: expect.any(String),
    });
    expect(m.staffUpdateBooking).not.toHaveBeenCalled();
    expect(m.fetchStaffBookingFormOptions).not.toHaveBeenCalled();
  });
});

describe("服務人員模式(#977 第 7 批)", () => {
  it("編輯:唯讀自己的名字與「由商家指派」的協助人員;沒有下拉 / 協助人員欄位 / 會員面板 / 隱藏開關;料錢總開關關 ⇒ 沒有料錢", async () => {
    m.fetchStaffBookingForEdit.mockResolvedValue(staffEditRow(false));
    renderForm({ editingBookingId: BOOKING_ID, staff: true });
    expect(await screen.findByTestId("booking-form-assistants-readonly")).toHaveTextContent(
      "服務人員乙（由商家指派）",
    );
    expect(screen.getByTestId("booking-form-staff-readonly")).toHaveTextContent("服務人員甲");
    expect(document.getElementById("booking-staff")).toBeNull();
    expect(screen.queryByTestId("booking-form-assistants")).toBeNull();
    expect(screen.queryByTestId("member-phone-match-panel")).toBeNull();
    expect(screen.queryByRole("switch", { name: /不讓服務人員看到這則內部備註/ })).toBeNull();
    expect(screen.queryByText("料錢成本")).toBeNull();
    expect(document.getElementById("booking-notes")).not.toBeNull();
    expect(m.getBooking).not.toHaveBeenCalled();
  });

  it("編輯:內部備註被藏起來的單 ⇒ 沒有內部備註欄", async () => {
    m.fetchStaffBookingForEdit.mockResolvedValue(staffEditRow(true));
    renderForm({ editingBookingId: BOOKING_ID, staff: true });
    await screen.findByTestId("booking-form-assistants-readonly");
    expect(document.getElementById("booking-notes")).toBeNull();
  });

  it("編輯送出 ⇒ staffUpdateBooking,參數裡沒有協助人員 / 會員 / 隱藏備註 / 服務人員 id;料錢帶目前的陣列(這張單沒有 ⇒ [])", async () => {
    m.fetchStaffBookingForEdit.mockResolvedValue(staffEditRow(true));
    renderForm({ editingBookingId: BOOKING_ID, staff: true });
    await screen.findByTestId("booking-form-assistants-readonly");
    await waitFor(() =>
      expect((document.getElementById("booking-customer-name") as HTMLInputElement).value).toBe(
        "陳先生",
      ),
    );
    screen.getByRole("button", { name: "儲存變更" }).click();
    await waitFor(() => expect(m.staffUpdateBooking).toHaveBeenCalledTimes(1));
    const payload = m.staffUpdateBooking.mock.calls[0]?.[0] as Record<string, unknown>;
    for (const key of [...FORBIDDEN_STAFF_KEYS, "staffId"]) {
      expect(Object.prototype.hasOwnProperty.call(payload, key)).toBe(false);
    }
    expect(payload).toMatchObject({ bookingId: BOOKING_ID, notes: null, paymentMethodId: PM_ID });
    // #986 第 9 批:編輯一律帶目前勾選的陣列(不送 undefined / null)。第 11 批 F 改名 materialCostItems。
    expect(payload["materialCostItems"]).toEqual([]);
    expect(m.updateBooking).not.toHaveBeenCalled();
  });

  it("新增送出 ⇒ staffCreateBooking(staffId = 自己),沒有協助人員 / 會員 / 隱藏備註;沒勾料錢 ⇒ materialCostItems = []", async () => {
    renderForm({ editingBookingId: null, staff: true });
    await waitFor(() => expect(m.fetchStaffBookingFormOptions).toHaveBeenCalledWith(STAFF_ID));
    await screen.findByTestId("booking-form-staff-readonly");
    fireEvent.change(document.getElementById("booking-customer-name") as HTMLElement, {
      target: { value: "王小姐" },
    });
    fireEvent.change(document.getElementById("booking-customer-phone") as HTMLElement, {
      target: { value: "0988000111" },
    });
    await waitFor(() => expect(document.getElementById("booking-service-items")).not.toBeNull());
    pickServiceItems([/冷氣清洗/]);
    await selectPaymentMethod("現金");
    screen.getByRole("button", { name: "建立預約" }).click();
    await waitFor(() => expect(m.staffCreateBooking).toHaveBeenCalledTimes(1));
    const payload = m.staffCreateBooking.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["staffId"]).toBe(STAFF_ID);
    for (const key of FORBIDDEN_STAFF_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(payload, key)).toBe(false);
    }
    expect(payload).toMatchObject({
      customerName: "王小姐",
      customerPhone: "0988000111",
      startAt: "2036-01-05T10:00:00+08:00",
      paymentMethodId: PM_ID,
    });
    expect(payload["materialCostItems"]).toEqual([]);
    expect(m.createBooking).not.toHaveBeenCalled();
  });
});

describe("服務人員模式的料錢(#986 第 9 批,9-1 / 9-2)", () => {
  it("總開關開 ⇒ 有料錢區塊;新增時在「選擇料錢」整頁勾一個品項 ⇒ staffCreateBooking 帶 materialCostItems", async () => {
    m.fetchStaffBookingFormOptions.mockResolvedValue(STAFF_OPTIONS_WITH_MATERIAL);
    renderForm({ editingBookingId: null, staff: true });
    expect(await screen.findByText("料錢成本")).toBeInTheDocument();
    fireEvent.change(document.getElementById("booking-customer-name") as HTMLElement, {
      target: { value: "王小姐" },
    });
    fireEvent.change(document.getElementById("booking-customer-phone") as HTMLElement, {
      target: { value: "0988000111" },
    });
    await waitFor(() => expect(document.getElementById("booking-service-items")).not.toBeNull());
    pickServiceItems([/冷氣清洗/]);
    await selectPaymentMethod("現金");
    pickMaterialCosts([/冷媒/]);
    screen.getByRole("button", { name: "建立預約" }).click();
    await waitFor(() => expect(m.staffCreateBooking).toHaveBeenCalledTimes(1));
    const payload = m.staffCreateBooking.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["materialCostItems"]).toEqual([
      { materialCostItemId: MATERIAL_ID, quantity: 1, unitPrice: 200 },
    ]);
  });

  it("編輯:預帶這張單的料錢(含已下架的舊品項,數量 / 單價一起帶);拿掉上架那一項 ⇒ 送出只剩已下架那一項(原樣保留,後端不擋)", async () => {
    m.fetchStaffBookingFormOptions.mockResolvedValue(STAFF_OPTIONS_WITH_MATERIAL);
    m.fetchStaffBookingForEdit.mockResolvedValue({
      ...staffEditRow(false),
      material_costs: [
        {
          material_cost_item_id: MATERIAL_ID,
          name: "冷媒",
          amount_snapshot: 200,
          quantity: 1,
          is_active: true,
        },
        {
          material_cost_item_id: REMOVED_MATERIAL_ID,
          name: "舊銅管",
          amount_snapshot: 90,
          quantity: 2,
          is_active: false,
        },
      ],
    });
    renderForm({ editingBookingId: BOOKING_ID, staff: true });
    // 第 11 批 F #993(F-6):摘要列出兩項(已下架的標「(已下架)」並算進合計 200×1 + 90×2 = 380)。
    const summary = await screen.findByTestId("booking-material-summary");
    expect(summary).toHaveTextContent("冷媒 × 1");
    expect(summary).toHaveTextContent("舊銅管 × 2(已下架)");
    expect(screen.getByTestId("booking-material-summary-total")).toHaveTextContent(
      "已選 2 項，料錢合計 $380(僅供操作者參考，不代表訂單金額)",
    );
    // 整頁:已下架但本來就在單上的品項看得到(標「(已下架)」),可以取消勾選;這裡只拿掉上架那一項。
    pickMaterialCosts([/冷媒/]);
    screen.getByRole("button", { name: "儲存變更" }).click();
    await waitFor(() => expect(m.staffUpdateBooking).toHaveBeenCalledTimes(1));
    const payload = m.staffUpdateBooking.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["materialCostItems"]).toEqual([
      { materialCostItemId: REMOVED_MATERIAL_ID, quantity: 2, unitPrice: 90 },
    ]);
  });
});

// SPECS-INDEX #939(第 11 批 A,規格書 §1.7):服務人員改了有會員的單的電話 ⇒ 電話欄下方常駐 `!`。
describe("服務人員模式:改電話的改掛提示(#939)", () => {
  const phone = () => document.getElementById("booking-customer-phone") as HTMLInputElement;

  it("這張單有會員、電話改了才出現 `!`;改回原電話(含只改格式)就消失", async () => {
    m.fetchStaffBookingForEdit.mockResolvedValue(staffEditRow(false));
    renderForm({ editingBookingId: BOOKING_ID, staff: true });
    await waitFor(() => expect(phone().value).toBe("0912345678"));
    expect(screen.queryByTestId("staff-relink-notice")).toBeNull();

    fireEvent.change(phone(), { target: { value: "0933111222" } });
    expect(screen.getByTestId("staff-relink-notice")).toHaveTextContent(
      "電話已更改，儲存後這筆訂單會改掛到這支電話的會員(沒有的話會自動建立)，紅利會重新計算。",
    );

    fireEvent.change(phone(), { target: { value: "0912-345-678" } });
    expect(screen.queryByTestId("staff-relink-notice")).toBeNull();
  });

  it("這張單沒有會員 ⇒ 改電話也不出現", async () => {
    m.fetchStaffBookingForEdit.mockResolvedValue({
      ...staffEditRow(false),
      member_id: null,
      member_name_snapshot: null,
    });
    renderForm({ editingBookingId: BOOKING_ID, staff: true });
    await waitFor(() => expect(phone().value).toBe("0912345678"));
    fireEvent.change(phone(), { target: { value: "0933111222" } });
    expect(screen.queryByTestId("staff-relink-notice")).toBeNull();
  });

  it("商家模式不出現這則(商家端由會員面板說明)", async () => {
    renderForm({ editingBookingId: BOOKING_ID });
    await waitFor(() => expect(phone().value).not.toBe(""));
    fireEvent.change(phone(), { target: { value: "0933111222" } });
    expect(screen.queryByTestId("staff-relink-notice")).toBeNull();
  });
});
