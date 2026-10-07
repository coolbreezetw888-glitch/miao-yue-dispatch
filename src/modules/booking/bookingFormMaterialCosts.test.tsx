// 第 11 批 F #993(2026-10-07):建單 / 編輯表單的料錢 ——「選擇料錢」整頁 + 數量 + 自訂成本單價。
// 規格:.project/specs/改掛會員與預設文案全形-第11批.md §十三(13.3 / 13.4 / 13.7 vitest)。
//
// 整張表單掛起來測(商家模式;服務人員模式的料錢在 bookingFormStaffMode.test.tsx):
//   ・整頁料錢模式:標題「選擇料錢」、沒有分類頁籤、沒有工時 / 描述、開關名「自訂成本單價」、testid 前綴 material-picker
//   ・A ×3、B 自訂單價 12.5 → 確認 → 摘要逐字(名稱 × 數量、小計、自訂單價小字、合計含小數)→ 送出 payload
//   ・編輯:數量與單價快照帶入(用快照不用現價);自訂過的單價再打開整頁 ⇒ 開關亮著、帶回數字
//   ・數量上限 999:+ 到 999 停;手打 1000 ⇒ 標紅 + 確認擋住
//   ・功能關閉:新增時整區不見;編輯的單上有料錢 ⇒ 照樣顯示,整頁只列單上原有的(已下架標「(已下架)」)
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getBooking: vi.fn(),
  createBooking: vi.fn(),
  updateBooking: vi.fn(),
  getFeatureFlag: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

const MERCHANT_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ITEM_ID = "33333333-3333-4333-8333-333333333333";
const BOOKING_ID = "44444444-4444-4444-8444-444444444444";
const PM_ID = "77777777-7777-4777-8777-777777777777";
const MAT_A = "88888888-8888-4888-8888-888888888881";
const MAT_B = "88888888-8888-4888-8888-888888888882";
const MAT_OFF = "88888888-8888-4888-8888-888888888889";

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
  fetchStaffBookingFormOptions: vi.fn(),
  fetchStaffBookingForEdit: vi.fn(),
  fetchMyBookableStartTimes: vi.fn(async () => ALL_DAY_START_TIMES),
  staffPreviewBookingPoints: vi.fn(async () => ({ feature_enabled: false })),
  staffCreateBooking: vi.fn(),
  staffUpdateBooking: vi.fn(),
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
  // 上架中的料錢:冷媒 200、銅管 600(MAT_OFF 已下架,不在清單裡)。
  useMerchantMaterialCostItems: () => ({
    data: [
      { id: MAT_A, name: "冷媒", amount: 200 },
      { id: MAT_B, name: "銅管", amount: 600 },
    ],
  }),
  useMerchantPaymentMethods: () => ({ data: [{ id: PM_ID, name: "現金" }] }),
  useMerchantTaxSettings: () => ({ data: null }),
}));
vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({
    merchant: { id: MERCHANT_ID, name: "測試商家", industry_type: "in_store_beauty" },
    isLoading: false,
  }),
}));
vi.mock("@/modules/merchant/api", () => ({ getFeatureFlag: m.getFeatureFlag }));
vi.mock("@/modules/staff-agent/context", () => ({
  useAgentPermission: () => ({ data: true, isLoading: false }),
  useCurrentMerchantRole: () => ({ data: "admin", isLoading: false }),
  useMerchantStaffList: () => ({ data: [{ id: STAFF_ID, name: "服務人員甲" }] }),
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
import { ALL_DAY_START_TIMES, pickServiceItems, selectPaymentMethod } from "./bookingFormTestUtils";

function editingDetail(
  materialCosts: {
    materialCostItemId: string;
    name: string;
    quantity: number;
    amountSnapshot: number;
  }[],
) {
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
    assistants: [],
    materialCosts,
  };
}

function renderForm(editingBookingId: string | null) {
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
          editingBookingId={editingBookingId}
          onSaved={() => {}}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function setMaterialFeature(enabled: boolean) {
  m.getFeatureFlag.mockImplementation(async (_merchantId: string, key: string) =>
    key === "material_cost_enabled" ? enabled : true,
  );
}

async function openMaterialPicker(): Promise<HTMLElement> {
  const button = await screen.findByTestId("booking-material-picker-open");
  fireEvent.click(button);
  return screen.getByTestId("material-picker");
}

function card(picker: HTMLElement, id: string): HTMLElement {
  return within(picker).getByTestId(`material-picker-item-${id}`);
}

beforeEach(() => {
  setMaterialFeature(true);
  m.createBooking.mockResolvedValue({
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
  m.updateBooking.mockResolvedValue({ id: BOOKING_ID, merchant_id: MERCHANT_ID });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("選擇料錢整頁(料錢模式)", () => {
  it("標題「選擇料錢」、沒有分類頁籤、沒有工時;勾選後開關名「自訂成本單價」;testid 前綴 material-picker", async () => {
    renderForm(null);
    const picker = await openMaterialPicker();
    expect(within(picker).getByRole("heading", { name: "選擇料錢" })).toBeInTheDocument();
    expect(within(picker).queryByRole("tablist")).toBeNull();
    expect(within(picker).queryByText(/大約/)).toBeNull();
    expect(screen.queryByTestId("service-item-picker")).toBeNull();
    // 兩個上架品項一個清單;已下架的不在(新增模式沒有單上原有的品項)。
    expect(card(picker, MAT_A)).toHaveTextContent("冷媒");
    expect(card(picker, MAT_B)).toHaveTextContent("銅管");
    expect(within(picker).queryByTestId(`material-picker-item-${MAT_OFF}`)).toBeNull();
    fireEvent.click(within(card(picker, MAT_A)).getByRole("checkbox", { name: /冷媒/ }));
    expect(
      within(card(picker, MAT_A)).getByRole("switch", { name: /自訂成本單價/ }),
    ).toBeInTheDocument();
  });

  it("A ×3(原價)、B 自訂單價 12.5 → 確認 ⇒ 摘要逐字、合計含小數;送出 materialCostItems 帶數量與單價", async () => {
    renderForm(null);
    fireEvent.change(document.getElementById("booking-customer-name") as HTMLElement, {
      target: { value: "王小姐" },
    });
    fireEvent.change(document.getElementById("booking-customer-phone") as HTMLElement, {
      target: { value: "0988000111" },
    });
    await waitFor(() => expect(document.getElementById("booking-service-items")).not.toBeNull());
    pickServiceItems([/冷氣清洗/]);
    await selectPaymentMethod("現金");

    const picker = await openMaterialPicker();
    const a = card(picker, MAT_A);
    fireEvent.click(within(a).getByRole("button", { name: "增加「冷媒」的數量" }));
    fireEvent.click(within(a).getByRole("button", { name: "增加「冷媒」的數量" }));
    fireEvent.click(within(a).getByRole("button", { name: "增加「冷媒」的數量" }));
    expect(within(a).getByRole("spinbutton", { name: "「冷媒」的數量" })).toHaveValue(3);
    const b = card(picker, MAT_B);
    fireEvent.click(within(b).getByRole("checkbox", { name: /銅管/ }));
    fireEvent.click(within(b).getByRole("switch", { name: /自訂成本單價/ }));
    fireEvent.change(within(b).getByLabelText("單價"), { target: { value: "12.5" } });
    fireEvent.click(within(picker).getByRole("button", { name: "確認（已選 2 項）" }));

    expect(screen.queryByTestId("material-picker")).toBeNull();
    const summary = screen.getByTestId("booking-material-summary");
    expect(summary).toHaveTextContent("冷媒 × 3$600");
    expect(summary).toHaveTextContent("銅管 × 1(自訂單價 $12.5)$12.5");
    expect(screen.getByTestId("booking-material-summary-total")).toHaveTextContent(
      "已選 2 項，料錢合計 $612.5(僅供操作者參考，不代表訂單金額)",
    );

    screen.getByRole("button", { name: "建立預約" }).click();
    await waitFor(() => expect(m.createBooking).toHaveBeenCalledTimes(1));
    expect(m.createBooking.mock.calls[0]?.[0]).toMatchObject({
      materialCostItems: [
        { materialCostItemId: MAT_A, quantity: 3, unitPrice: 200 },
        { materialCostItemId: MAT_B, quantity: 1, unitPrice: 12.5 },
      ],
    });
    expect(m.createBooking.mock.calls[0]?.[0]).not.toHaveProperty("materialCostItemIds");
  });

  it("小數單價:33.33 × 3 ⇒ 小計與合計 $99.99(不會被四捨五入成整數)", async () => {
    renderForm(null);
    const picker = await openMaterialPicker();
    const b = card(picker, MAT_B);
    fireEvent.click(within(b).getByRole("checkbox", { name: /銅管/ }));
    fireEvent.change(within(b).getByRole("spinbutton", { name: "「銅管」的數量" }), {
      target: { value: "3" },
    });
    fireEvent.click(within(b).getByRole("switch", { name: /自訂成本單價/ }));
    fireEvent.change(within(b).getByLabelText("單價"), { target: { value: "33.33" } });
    fireEvent.click(within(picker).getByRole("button", { name: /^確認/ }));
    expect(screen.getByTestId("booking-material-summary")).toHaveTextContent(
      "銅管 × 3(自訂單價 $33.33)$99.99",
    );
    expect(screen.getByTestId("booking-material-summary-total")).toHaveTextContent(
      "料錢合計 $99.99",
    );
  });

  it("自訂成本單價最多小數兩位、不能超過 99,999,999.99 ⇒ 標紅 + 確認擋住", async () => {
    renderForm(null);
    const picker = await openMaterialPicker();
    const a = card(picker, MAT_A);
    fireEvent.click(within(a).getByRole("checkbox", { name: /冷媒/ }));
    fireEvent.click(within(a).getByRole("switch", { name: /自訂成本單價/ }));
    fireEvent.change(within(a).getByLabelText("單價"), { target: { value: "1.234" } });
    expect(within(a).getByText("最多只能填到小數點後 2 位")).toBeInTheDocument();
    expect(within(picker).getByRole("button", { name: /^確認/ })).toBeDisabled();
    expect(within(picker).getByText(/有項目的自訂成本單價填錯了/)).toBeInTheDocument();
    fireEvent.change(within(a).getByLabelText("單價"), { target: { value: "100000000" } });
    expect(within(picker).getByRole("button", { name: /^確認/ })).toBeDisabled();
    // 單價本身的上限 99,999,999.99 不算格式錯,但主腦裁決的單一小計上限 1,000,000 會擋。
    fireEvent.change(within(a).getByLabelText("單價"), { target: { value: "99999999.99" } });
    expect(within(a).queryByText("不能大於 99999999.99")).toBeNull();
    expect(within(picker).getByRole("button", { name: /^確認/ })).toBeDisabled();
    fireEvent.change(within(a).getByLabelText("單價"), { target: { value: "1000000" } });
    expect(within(picker).getByRole("button", { name: /^確認/ })).toBeEnabled();
  });

  it("數量上限 999:+ 到 999 就停;手打 1000 ⇒「數量最多 999」標紅 + 確認擋住", async () => {
    renderForm(null);
    const picker = await openMaterialPicker();
    const a = card(picker, MAT_A);
    fireEvent.click(within(a).getByRole("checkbox", { name: /冷媒/ }));
    const input = within(a).getByRole("spinbutton", { name: "「冷媒」的數量" });
    fireEvent.change(input, { target: { value: "998" } });
    fireEvent.click(within(a).getByRole("button", { name: "增加「冷媒」的數量" }));
    expect(input).toHaveValue(999);
    expect(within(a).getByRole("button", { name: "增加「冷媒」的數量" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "1000" } });
    expect(within(picker).getByTestId(`material-picker-quantity-error-${MAT_A}`)).toHaveTextContent(
      "數量最多 999",
    );
    expect(within(picker).getByRole("button", { name: /^確認/ })).toBeDisabled();
  });
});

describe("編輯帶入 / 已下架 / 功能關閉", () => {
  it("編輯:數量與單價快照帶入(快照 150 ≠ 現價 200,用快照);自訂過再打開整頁 ⇒ 開關亮著、帶回數字", async () => {
    m.getBooking.mockResolvedValue(
      editingDetail([
        { materialCostItemId: MAT_A, name: "冷媒", quantity: 2, amountSnapshot: 150 },
      ]),
    );
    renderForm(BOOKING_ID);
    const summary = await screen.findByTestId("booking-material-summary");
    expect(summary).toHaveTextContent("冷媒 × 2$300");
    expect(summary).not.toHaveTextContent("自訂單價");

    let picker = await openMaterialPicker();
    let a = card(picker, MAT_A);
    expect(within(a).getByRole("spinbutton", { name: "「冷媒」的數量" })).toHaveValue(2);
    const sw = within(a).getByRole("switch", { name: /自訂成本單價/ });
    expect(sw).toHaveAttribute("data-state", "unchecked");
    expect(a).toHaveTextContent("使用原價（NT$ 150）");
    fireEvent.click(sw);
    fireEvent.change(within(a).getByLabelText("單價"), { target: { value: "88" } });
    fireEvent.click(within(picker).getByRole("button", { name: /^確認/ }));
    expect(screen.getByTestId("booking-material-summary")).toHaveTextContent(
      "冷媒 × 2(自訂單價 $88)$176",
    );

    picker = await openMaterialPicker();
    a = card(picker, MAT_A);
    expect(within(a).getByRole("switch", { name: /自訂成本單價/ })).toHaveAttribute(
      "data-state",
      "checked",
    );
    expect(within(a).getByLabelText("單價")).toHaveValue("88");
    fireEvent.click(within(picker).getByRole("button", { name: /^確認/ }));

    screen.getByRole("button", { name: "儲存變更" }).click();
    await waitFor(() => expect(m.updateBooking).toHaveBeenCalledTimes(1));
    expect(m.updateBooking.mock.calls[0]?.[0]).toMatchObject({
      materialCostItems: [{ materialCostItemId: MAT_A, quantity: 2, unitPrice: 88 }],
    });
  });

  it("已下架但在單上的品項:摘要標「(已下架)」並算進合計;整頁看得到、可以取消勾選;沒在單上的已下架品項不會出現", async () => {
    m.getBooking.mockResolvedValue(
      editingDetail([
        { materialCostItemId: MAT_A, name: "冷媒", quantity: 1, amountSnapshot: 200 },
        { materialCostItemId: MAT_OFF, name: "舊銅管", quantity: 3, amountSnapshot: 12.5 },
      ]),
    );
    renderForm(BOOKING_ID);
    const summary = await screen.findByTestId("booking-material-summary");
    expect(summary).toHaveTextContent("舊銅管 × 3(已下架)$37.5");
    expect(screen.getByTestId("booking-material-summary-total")).toHaveTextContent(
      "已選 2 項，料錢合計 $237.5(僅供操作者參考，不代表訂單金額)",
    );
    const picker = await openMaterialPicker();
    expect(card(picker, MAT_OFF)).toHaveTextContent("舊銅管(已下架)");
    fireEvent.click(within(card(picker, MAT_OFF)).getByRole("checkbox", { name: /舊銅管/ }));
    fireEvent.click(within(picker).getByRole("button", { name: /^確認/ }));
    expect(screen.getByTestId("booking-material-summary")).not.toHaveTextContent("舊銅管");
    screen.getByRole("button", { name: "儲存變更" }).click();
    await waitFor(() => expect(m.updateBooking).toHaveBeenCalledTimes(1));
    expect(m.updateBooking.mock.calls[0]?.[0]).toMatchObject({
      materialCostItems: [{ materialCostItemId: MAT_A, quantity: 1, unitPrice: 200 }],
    });
  });

  it("功能關閉 + 新增 ⇒ 沒有料錢區;功能關閉 + 編輯的單上有料錢 ⇒ 照樣顯示,整頁只列單上原有的品項", async () => {
    setMaterialFeature(false);
    const view = renderForm(null);
    await waitFor(() => expect(m.getFeatureFlag).toHaveBeenCalled());
    await waitFor(() => expect(document.getElementById("booking-service-items")).not.toBeNull());
    expect(screen.queryByTestId("booking-material-picker-open")).toBeNull();
    view.unmount();

    m.getBooking.mockResolvedValue(
      editingDetail([
        { materialCostItemId: MAT_B, name: "銅管", quantity: 2, amountSnapshot: 600 },
      ]),
    );
    renderForm(BOOKING_ID);
    const picker = await openMaterialPicker();
    expect(card(picker, MAT_B)).toBeInTheDocument();
    expect(within(picker).queryByTestId(`material-picker-item-${MAT_A}`)).toBeNull();
  });
});

describe("主腦裁決(防溢位):前端擋下", () => {
  it("整頁:單一料錢小計超過 $1,000,000 ⇒ 該格紅字 + 確認擋住;剛好 1,000,000 ⇒ 可以確認", async () => {
    renderForm(null);
    const picker = await openMaterialPicker();
    const a = card(picker, MAT_A);
    fireEvent.click(within(a).getByRole("checkbox", { name: /冷媒/ }));
    fireEvent.change(within(a).getByRole("spinbutton", { name: "「冷媒」的數量" }), {
      target: { value: "2" },
    });
    fireEvent.click(within(a).getByRole("switch", { name: /自訂成本單價/ }));
    fireEvent.change(within(a).getByLabelText("單價"), { target: { value: "500000.01" } });
    expect(within(picker).getByTestId(`material-picker-quantity-error-${MAT_A}`)).toHaveTextContent(
      "單一料錢小計不能超過 $1,000,000",
    );
    expect(within(picker).getByRole("button", { name: /^確認/ })).toBeDisabled();
    fireEvent.change(within(a).getByLabelText("單價"), { target: { value: "500000" } });
    expect(within(picker).getByRole("button", { name: /^確認/ })).toBeEnabled();
  });

  it("表單:料錢合計超過 $9,999,999.99 ⇒ 料錢區與按鈕列顯示訊息,「儲存變更」不能按", async () => {
    // 10 個品項各 1,000,000(都是單上原有、已下架的,只為了湊出合計 10,000,000)。
    m.getBooking.mockResolvedValue(
      editingDetail(
        Array.from({ length: 10 }, (_, i) => ({
          materialCostItemId: `99999999-9999-4999-8999-99999999999${i}`,
          name: `大額料錢${i}`,
          quantity: 1,
          amountSnapshot: 1_000_000,
        })),
      ),
    );
    renderForm(BOOKING_ID);
    expect(await screen.findByTestId("booking-material-limit-error")).toHaveTextContent(
      "料錢合計不能超過 $9,999,999.99，請調整單價或數量",
    );
    expect(screen.getByRole("button", { name: "儲存變更" })).toBeDisabled();
    expect(
      screen.getByText("料錢合計不能超過 $9,999,999.99，請調整單價或數量，修好之後才能送出。"),
    ).toBeInTheDocument();
  });

  it("表單:合計剛好 $9,999,999.99 ⇒ 不顯示訊息,可以儲存", async () => {
    m.getBooking.mockResolvedValue(
      editingDetail([
        ...Array.from({ length: 9 }, (_, i) => ({
          materialCostItemId: `99999999-9999-4999-8999-99999999999${i}`,
          name: `大額料錢${i}`,
          quantity: 1,
          amountSnapshot: 1_000_000,
        })),
        { materialCostItemId: MAT_A, name: "冷媒", quantity: 1, amountSnapshot: 999_999.99 },
      ]),
    );
    renderForm(BOOKING_ID);
    await screen.findByTestId("booking-material-summary");
    expect(screen.queryByTestId("booking-material-limit-error")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "儲存變更" })).toBeEnabled());
  });
});
