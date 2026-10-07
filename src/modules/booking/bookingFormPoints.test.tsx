// 紅利系統重構 批次 7(§4.6,#842 / #799):建單 / 編輯表單的紅利區塊,整張表單掛起來測。
//
// 這支釘住的是「畫面看起來正常、送出去的東西錯了」那一類(純函式的細節在 bookingPointsLogic.test.ts):
//   ・功能關閉 ⇒ 區塊整個不渲染(不是靠 useMerchantMemberSettings,是預覽回的 feature_enabled)
//   ・預覽回 error ⇒ 顯示原因,不是「0 點」(v2.4 裁決 8 ④)
//   ・商家沒設規則 ⇒ 「商家尚未設定派點規則」(#799)
//   ・有折扣 ⇒ 送出前跳確認小卡窗(疊在全頁層上 = 全站唯一的兩層重疊),確認後才呼叫 RPC
//   ・折抵:即時換算、金額預覽多「紅利折抵 / 實付」、超過餘額擋送出、會員變了自動歸零(判斷 24)
//   ・編輯:沒改 ⇒ pointsOverride null、pointsRedeemed 帶原值;「改用建議值」⇒ pointsOverrideReset true

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getBookingMock, createBookingMock, updateBookingMock, previewMock, toastMock } = vi.hoisted(
  () => ({
    getBookingMock: vi.fn(),
    createBookingMock: vi.fn(),
    updateBookingMock: vi.fn(),
    previewMock: vi.fn(),
    toastMock: { success: vi.fn(), error: vi.fn() },
  }),
);

const MERCHANT_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ITEM_ID = "33333333-3333-4333-8333-333333333333";
const BOOKING_ID = "44444444-4444-4444-8444-444444444444";
const MEMBER_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_MEMBER_ID = "66666666-6666-4666-8666-666666666666";
const PAYMENT_METHOD_ID = "77777777-7777-4777-8777-777777777777";

vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("./api", () => ({
  getBooking: getBookingMock,
  createBooking: createBookingMock,
  updateBooking: updateBookingMock,
  previewBookingPoints: previewMock,
  // SPECS-INDEX #980:時間選單改問資料庫;這裡讓整天都能約(這支只測紅利區塊)。
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
  useMerchantPaymentMethods: () => ({ data: [{ id: PAYMENT_METHOD_ID, name: "現金" }] }),
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
import { ALL_DAY_START_TIMES, pickServiceItems, selectPaymentMethod } from "./bookingFormTestUtils";

// ---------------------------------------------------------------------------
// 假資料
// ---------------------------------------------------------------------------

function previewOk(overrides: Record<string, unknown> = {}, redeem: Record<string, unknown> = {}) {
  return {
    feature_enabled: true,
    member: { resolution: "existing", member_id: MEMBER_ID, name: "王小明", balance: 120 },
    rules_configured: true,
    earn_mode: "basic",
    auto_points: 10,
    review_required: false,
    eligible: true,
    ineligible_reason: null,
    reward_condition_mode: null,
    breakdown: [],
    redeem: {
      enabled: true,
      points_unit: 100,
      amount_unit: 10,
      max_ratio_percent: 50,
      payable: 1000,
      available_points: 120,
      max_points: 120,
      max_amount: 12,
      cap_amount: 500,
      ...redeem,
    },
    ...overrides,
  };
}

function editingDetail(points: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    merchant_id: MERCHANT_ID,
    staff_id: STAFF_ID,
    start_at: "2036-01-05T02:00:00+00:00",
    end_at: "2036-01-05T03:00:00+00:00",
    status: "accepted",
    customer_name: "王小明",
    customer_phone: "0912345678",
    customer_email: null,
    customer_address: null,
    notes: null,
    customer_notes: null,
    hide_notes_from_staff: false,
    member_id: MEMBER_ID,
    member_name_snapshot: "王小明",
    custom_total_amount_enabled: false,
    custom_total_amount: null,
    discount_enabled: false,
    discount_mode: null,
    discount_value: null,
    tax_enabled: false,
    tax_mode_snapshot: null,
    tax_value_snapshot: null,
    final_amount_snapshot: 1000,
    payment_method_id: PAYMENT_METHOD_ID,
    payment_method_name_snapshot: "現金",
    custom_duration_enabled: false,
    custom_duration_minutes: null,
    points_planned: 10,
    points_planned_auto: 10,
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
    ...points,
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

/** 新增模式填到「可以直接按建立」:姓名、電話、選服務項目、選付款方式。
 * SPECS-INDEX #979(2026-10-06):服務項目改從「選擇項目」整頁勾選、付款方式改下拉選單,只改操作步驟。 */
async function fillCreateForm(phone = "0912345678") {
  fireEvent.change(document.getElementById("booking-customer-name") as HTMLElement, {
    target: { value: "王小明" },
  });
  fireEvent.change(document.getElementById("booking-customer-phone") as HTMLElement, {
    target: { value: phone },
  });
  pickServiceItems([/冷氣清洗/]);
  await selectPaymentMethod("現金");
}

/**
 * v2.4 裁決 22 ① (b):預覽還沒跟上目前輸入時,用到紅利數字的送出會被擋。正常操作是「改完、等預覽回來、再按」,
 * 所以先等過 debounce(300ms)+ 預覽回來,再按送出。
 */
async function settlePreview() {
  // 兩段 act:第一段讓 debounce 的 setState 套用(act 結束才會 flush),第二段讓預覽查詢跑完、結果套進畫面。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

async function clickSubmit(name: "建立預約" | "儲存變更") {
  await settlePreview();
  fireEvent.click(screen.getByRole("button", { name }));
}

function lastPreviewArgs(): Record<string, unknown> {
  return previewMock.mock.calls[previewMock.mock.calls.length - 1]?.[0] as Record<string, unknown>;
}

describe("建單表單的紅利區塊(紅利系統重構 §4.6)", () => {
  beforeEach(() => {
    createBookingMock.mockResolvedValue({
      id: BOOKING_ID,
      merchant_id: MERCHANT_ID,
      final_amount_snapshot: 1000,
      member_id: MEMBER_ID,
      member_name_snapshot: "王小明",
      member_auto_created: false,
      points_planned: 10,
      points_redeemed: 0,
      points_redeem_amount_snapshot: 0,
    });
    updateBookingMock.mockResolvedValue({ id: BOOKING_ID, merchant_id: MERCHANT_ID });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("功能關閉(預覽只回 feature_enabled:false)⇒ 整個「紅利點數」區塊不渲染", async () => {
    previewMock.mockResolvedValue({ feature_enabled: false });
    renderForm(null);
    await waitFor(() => expect(previewMock).toHaveBeenCalled());
    // 等預覽結果套進畫面(骨架消失)。
    await waitFor(() => expect(screen.queryByText("紅利點數")).not.toBeInTheDocument());
    expect(screen.queryByRole("switch", { name: /手動修改派點/ })).not.toBeInTheDocument();
  });

  it("新增模式:預覽帶電話、不帶會員(§12.1);existing 會員顯示建議點數與會員姓名", async () => {
    previewMock.mockResolvedValue(previewOk());
    renderForm(null);
    await fillCreateForm();
    await waitFor(() => expect(screen.getByText("會員：王小明")).toBeInTheDocument());
    expect(screen.getByText("10 點")).toBeInTheDocument();
    expect(screen.getByText("訂單完成後才入帳")).toBeInTheDocument();
    await waitFor(() =>
      expect(previewMock).toHaveBeenCalledWith(
        expect.objectContaining({ customerPhone: "0912345678", memberId: null, bookingId: null }),
      ),
    );
  });

  it("🔴 v2.4 裁決 8 ④:預覽回 error ⇒ 顯示原因,不顯示「0 點」", async () => {
    previewMock.mockResolvedValue({ feature_enabled: true, error: "折扣金額不能超過訂單小計" });
    renderForm(null);
    await fillCreateForm();
    await waitFor(() =>
      expect(
        screen.getByText(/目前算不出這筆訂單的紅利點數：折扣金額不能超過訂單小計/),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("0 點")).not.toBeInTheDocument();
  });

  it("#799:商家沒設派點規則 ⇒ 「商家尚未設定派點規則」,不寫 0 點", async () => {
    previewMock.mockResolvedValue(previewOk({ rules_configured: false, auto_points: 0 }));
    renderForm(null);
    await fillCreateForm();
    await waitFor(() => expect(screen.getByText("商家尚未設定派點規則")).toBeInTheDocument());
    expect(screen.queryByText("0 點")).not.toBeInTheDocument();
  });

  it("新客戶 ⇒ 標「新客戶(送出後自動建立會員)」,有派點但沒有折抵開關", async () => {
    previewMock.mockResolvedValue(
      previewOk(
        { member: { resolution: "new", member_id: null, name: null, balance: null } },
        { enabled: false, available_points: 0, max_points: 0, max_amount: 0 },
      ),
    );
    renderForm(null);
    await fillCreateForm();
    await waitFor(() => expect(screen.getByText("新客戶(送出後自動建立會員)")).toBeInTheDocument());
    expect(screen.getByRole("switch", { name: /手動修改派點/ })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /使用點數折抵/ })).not.toBeInTheDocument();
  });

  it("不折抵、不手動修改就建立 ⇒ pointsRedeemed 0、pointsOverride null", async () => {
    previewMock.mockResolvedValue(previewOk());
    renderForm(null);
    await fillCreateForm();
    await waitFor(() => expect(screen.getByText("會員：王小明")).toBeInTheDocument());
    await clickSubmit("建立預約");
    await waitFor(() => expect(createBookingMock).toHaveBeenCalledTimes(1));
    const payload = createBookingMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["pointsRedeemed"]).toBe(0);
    expect(payload["pointsOverride"]).toBeNull();
    // #916:建單成功提示框多了紅利那一行。
    const description = toastMock.success.mock.calls[0]?.[1]?.description;
    render(<>{description}</>);
    expect(screen.getByText("紅利點數 10 點(訂單完成後入帳)")).toBeInTheDocument();
  });

  it("手動修改派點:超過 100,000 ⇒ 欄位標紅 + 擋送出;改成合法數字 ⇒ 送 pointsOverride", async () => {
    previewMock.mockResolvedValue(previewOk());
    renderForm(null);
    await fillCreateForm();
    await waitFor(() => expect(screen.getByText("會員：王小明")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("switch", { name: /手動修改派點/ }));
    const input = await screen.findByLabelText(/本單派點/);
    // 打開時預設帶入系統建議值。
    expect(input).toHaveValue("10");
    fireEvent.change(input, { target: { value: "100001" } });
    expect(
      screen.getByText("單筆訂單最多只能設定 100,000 點，請確認是否多打了零"),
    ).toBeInTheDocument();
    await clickSubmit("建立預約");
    expect(createBookingMock).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "30" } });
    await clickSubmit("建立預約");
    await waitFor(() => expect(createBookingMock).toHaveBeenCalledTimes(1));
    expect(createBookingMock.mock.calls[0]?.[0]).toMatchObject({ pointsOverride: 30 });
  });

  it("🔴 §2.5 有折扣 ⇒ 送出先跳確認小卡窗(疊在全頁層上,兩層遮罩),確認後才呼叫 create_booking", async () => {
    previewMock.mockResolvedValue(previewOk({ review_required: true }));
    renderForm(null);
    await fillCreateForm();
    fireEvent.click(screen.getByRole("switch", { name: /折扣優惠/ }));
    fireEvent.change(document.getElementById("booking-discount-value") as HTMLElement, {
      target: { value: "100" },
    });
    await waitFor(() =>
      expect(
        screen.getByText("本單有自訂總金額/折扣，系統建議值僅供參考，請確認派點數"),
      ).toBeInTheDocument(),
    );
    await clickSubmit("建立預約");
    const dialog = await screen.findByRole("alertdialog");
    expect(createBookingMock).not.toHaveBeenCalled();
    expect(within(dialog).getByText("系統建議 10 點")).toBeInTheDocument();
    expect(within(dialog).getByText("本單將派 10 點")).toBeInTheDocument();
    // 兩層重疊:全頁層的 dialog + 確認窗的 alertdialog 同時存在,各自一層遮罩(Radix 各自 portal)。
    // (確認窗開著時 Radix 會把底下的全頁層標成 aria-hidden,所以用 hidden: true 找。)
    expect(screen.getByRole("dialog", { hidden: true })).toBeInTheDocument();
    expect(
      document.querySelectorAll("[data-state='open'][class*='bg-foreground/40']"),
    ).toHaveLength(2);

    fireEvent.click(within(dialog).getByRole("button", { name: "確認送出" }));
    await waitFor(() => expect(createBookingMock).toHaveBeenCalledTimes(1));
  });

  it("確認窗按「返回修改」⇒ 不送出", async () => {
    previewMock.mockResolvedValue(previewOk({ review_required: true }));
    renderForm(null);
    await fillCreateForm();
    fireEvent.click(screen.getByRole("switch", { name: /折扣優惠/ }));
    fireEvent.change(document.getElementById("booking-discount-value") as HTMLElement, {
      target: { value: "100" },
    });
    await waitFor(() => expect(screen.getByText("會員：王小明")).toBeInTheDocument());
    await clickSubmit("建立預約");
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "返回修改" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(createBookingMock).not.toHaveBeenCalled();
  });

  it("折抵:輸入 55 點 ⇒ 即時顯示折抵 $5、金額預覽多「紅利折抵 / 實付」,送出 pointsRedeemed 55", async () => {
    previewMock.mockResolvedValue(previewOk());
    renderForm(null);
    await fillCreateForm();
    await waitFor(() => expect(screen.getByText("會員：王小明")).toBeInTheDocument());
    expect(screen.getByText(/目前可用 120 點；本單最多可折 120 點\(\$12\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: /使用點數折抵/ }));
    fireEvent.change(await screen.findByLabelText(/折抵點數/), { target: { value: "55" } });
    expect(screen.getByText("折抵 $5")).toBeInTheDocument();
    expect(screen.getByText("以 100 點為單位可折得最划算")).toBeInTheDocument();
    expect(screen.getByText("−$5")).toBeInTheDocument();
    expect(screen.getByText("$995")).toBeInTheDocument();
    await clickSubmit("建立預約");
    await waitFor(() => expect(createBookingMock).toHaveBeenCalledTimes(1));
    // v2.4 裁決 22 ①:一定同時帶「要扣誰」= 預覽對到的會員。
    expect(createBookingMock.mock.calls[0]?.[0]).toMatchObject({
      pointsRedeemed: 55,
      pointsRedeemMemberId: MEMBER_ID,
    });
  });

  it("折抵超過可用點數 ⇒ 標紅並擋送出", async () => {
    previewMock.mockResolvedValue(previewOk());
    renderForm(null);
    await fillCreateForm();
    await waitFor(() => expect(screen.getByText("會員：王小明")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("switch", { name: /使用點數折抵/ }));
    fireEvent.change(await screen.findByLabelText(/折抵點數/), { target: { value: "200" } });
    expect(screen.getByText("這位會員目前只有 120 點，無法折抵 200 點")).toBeInTheDocument();
    await clickSubmit("建立預約");
    expect(createBookingMock).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalled();
  });

  it("🔴 判斷 24:預覽對到的會員變了(改電話)⇒ 折抵開關關掉、點數歸零,並提示", async () => {
    previewMock.mockImplementation(async (input: { customerPhone: string }) =>
      input.customerPhone === "0912345678"
        ? previewOk()
        : previewOk({
            member: {
              resolution: "existing",
              member_id: OTHER_MEMBER_ID,
              name: "李小華",
              balance: 900,
            },
          }),
    );
    renderForm(null);
    await fillCreateForm();
    await waitFor(() => expect(screen.getByText("會員：王小明")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("switch", { name: /使用點數折抵/ }));
    fireEvent.change(await screen.findByLabelText(/折抵點數/), { target: { value: "100" } });

    fireEvent.change(document.getElementById("booking-customer-phone") as HTMLElement, {
      target: { value: "0922333444" },
    });
    await waitFor(() => expect(screen.getByText("會員：李小華")).toBeInTheDocument());
    expect(screen.getByText("客戶電話已變更，紅利折抵已重設")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /使用點數折抵/ })).toHaveAttribute(
      "data-state",
      "unchecked",
    );
  });
});

describe("v2.4 裁決 22(批次 7 QA 打回)", () => {
  beforeEach(() => {
    createBookingMock.mockResolvedValue({
      id: BOOKING_ID,
      merchant_id: MERCHANT_ID,
      final_amount_snapshot: 1000,
      member_id: OTHER_MEMBER_ID,
      member_name_snapshot: "李小華",
      member_auto_created: false,
      points_planned: 10,
      points_redeemed: 0,
      points_redeem_amount_snapshot: 0,
    });
    updateBookingMock.mockResolvedValue({ id: BOOKING_ID, merchant_id: MERCHANT_ID });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("🔴 ① QA 重現:王小明開折抵 50 點 → 改成李小華電話立刻送出 ⇒ 擋下並提示;預覽回來後折抵已歸零,再送出不帶舊折抵", async () => {
    previewMock.mockImplementation(async (input: { customerPhone: string }) =>
      input.customerPhone === "0912345678"
        ? previewOk()
        : previewOk({
            member: {
              resolution: "existing",
              member_id: OTHER_MEMBER_ID,
              name: "李小華",
              balance: 900,
            },
          }),
    );
    renderForm(null);
    await fillCreateForm();
    await waitFor(() => expect(screen.getByText("會員：王小明")).toBeInTheDocument());
    await settlePreview();
    fireEvent.click(screen.getByRole("switch", { name: /使用點數折抵/ }));
    fireEvent.change(await screen.findByLabelText(/折抵點數/), { target: { value: "50" } });

    fireEvent.change(document.getElementById("booking-customer-phone") as HTMLElement, {
      target: { value: "0922333444" },
    });
    // 立刻按(預覽還沒跟上新電話)。
    fireEvent.click(screen.getByRole("button", { name: "建立預約" }));
    expect(createBookingMock).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith("紅利點數正在重新計算，請稍候再送出");

    await settlePreview();
    expect(screen.getByText("會員：李小華")).toBeInTheDocument();
    expect(screen.getByText("客戶電話已變更，紅利折抵已重設")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "建立預約" }));
    await waitFor(() => expect(createBookingMock).toHaveBeenCalledTimes(1));
    const payload = createBookingMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["pointsRedeemed"]).toBe(0);
    expect(payload["pointsRedeemMemberId"]).toBeNull();
    // 從頭到尾沒有任何一次送出帶著 50 點。
    expect(
      createBookingMock.mock.calls.every(
        (call) => (call[0] as { pointsRedeemed?: number }).pointsRedeemed !== 50,
      ),
    ).toBe(true);
  });

  it("① 不碰紅利的單純建單,預覽還在算也照樣能送(不用等)", async () => {
    previewMock.mockResolvedValue(previewOk());
    renderForm(null);
    await fillCreateForm();
    fireEvent.click(screen.getByRole("button", { name: "建立預約" }));
    await waitFor(() => expect(createBookingMock).toHaveBeenCalledTimes(1));
  });

  it("① 人工確認:有折扣、預覽還沒跟上就按 ⇒ 不跳確認窗、直接提示稍候", async () => {
    previewMock.mockResolvedValue(previewOk());
    renderForm(null);
    await fillCreateForm();
    fireEvent.click(screen.getByRole("switch", { name: /折扣優惠/ }));
    fireEvent.change(document.getElementById("booking-discount-value") as HTMLElement, {
      target: { value: "100" },
    });
    await waitFor(() => expect(screen.getByText("會員：王小明")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "建立預約" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(toastMock.error).toHaveBeenCalledWith("紅利點數正在重新計算，請稍候再送出");
  });

  it("L4:可用 0 點 ⇒ 沒有折抵開關,改一行灰字", async () => {
    previewMock.mockResolvedValue(
      previewOk({}, { available_points: 0, max_points: 0, max_amount: 0 }),
    );
    renderForm(null);
    await fillCreateForm();
    await waitFor(() =>
      expect(screen.getByText("這位會員目前沒有可用點數，無法使用點數折抵")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("switch", { name: /使用點數折抵/ })).not.toBeInTheDocument();
  });

  it("L1:已下架會員的舊單 ⇒ 「這位會員已下架,本單維持原本的派點 N 點與折抵」,送出折抵 null(維持)", async () => {
    getBookingMock.mockResolvedValue(
      editingDetail({
        points_planned: 30,
        points_redeemed: 100,
        points_redeem_amount_snapshot: 10,
      }),
    );
    previewMock.mockResolvedValue(
      previewOk({ member: { resolution: "none", member_id: null, name: null, balance: null } }),
    );
    renderForm(BOOKING_ID);
    await waitFor(() =>
      expect(
        screen.getByText("這位會員已下架，本單維持原本的派點 30 點與折抵"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("這筆訂單沒有連結會員，不會派點")).not.toBeInTheDocument();
    await clickSubmit("儲存變更");
    await waitFor(() => expect(updateBookingMock).toHaveBeenCalledTimes(1));
    const payload = updateBookingMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["pointsRedeemed"]).toBeNull();
    expect(payload["pointsRedeemMemberId"]).toBeNull();
  });
});

describe("編輯表單的紅利區塊(紅利系統重構 §4.6 編輯模式)", () => {
  beforeEach(() => {
    updateBookingMock.mockResolvedValue({ id: BOOKING_ID, merchant_id: MERCHANT_ID });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("預覽帶 bookingId + 已連結會員 id;沒改任何紅利欄位就儲存 ⇒ pointsOverride null、pointsRedeemed = 原值", async () => {
    getBookingMock.mockResolvedValue(
      editingDetail({ points_redeemed: 100, points_redeem_amount_snapshot: 10 }),
    );
    previewMock.mockResolvedValue(
      previewOk({
        member: { resolution: "given", member_id: MEMBER_ID, name: "王小明", balance: 20 },
      }),
    );
    renderForm(BOOKING_ID);
    await waitFor(() => expect(screen.getByText("會員：王小明")).toBeInTheDocument());
    const args = lastPreviewArgs();
    expect(args["bookingId"]).toBe(BOOKING_ID);
    expect(args["memberId"]).toBe(MEMBER_ID);
    // 開表單時就帶入原本的折抵(開關開著、100 點)。
    expect(screen.getByRole("switch", { name: /使用點數折抵/ })).toHaveAttribute(
      "data-state",
      "checked",
    );
    expect(screen.getByLabelText(/折抵點數/)).toHaveValue("100");

    await clickSubmit("儲存變更");
    await waitFor(() => expect(updateBookingMock).toHaveBeenCalledTimes(1));
    const payload = updateBookingMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["pointsRedeemed"]).toBe(100);
    expect(payload["pointsRedeemMemberId"]).toBe(MEMBER_ID);
    expect(payload["pointsOverride"]).toBeNull();
    expect(payload["pointsOverrideReset"]).toBe(false);
  });

  it("🔴 #939 A-3:把電話改成原會員自己目前的電話(預覽 given:A → existing:A)⇒ 折抵維持、不提示重設,送出照原折抵", async () => {
    getBookingMock.mockResolvedValue(
      editingDetail({ points_redeemed: 100, points_redeem_amount_snapshot: 10 }),
    );
    previewMock.mockImplementation(async (input: { customerPhone: string }) =>
      input.customerPhone === "0912345678"
        ? previewOk({
            member: { resolution: "given", member_id: MEMBER_ID, name: "王小明", balance: 20 },
          })
        : previewOk({
            member: { resolution: "existing", member_id: MEMBER_ID, name: "王小明", balance: 20 },
          }),
    );
    renderForm(BOOKING_ID);
    await waitFor(() => expect(screen.getByText("會員：王小明")).toBeInTheDocument());
    expect(screen.getByLabelText(/折抵點數/)).toHaveValue("100");

    fireEvent.change(document.getElementById("booking-customer-phone") as HTMLElement, {
      target: { value: "0955666777" },
    });
    await settlePreview();
    await waitFor(() => expect(lastPreviewArgs()["customerPhone"]).toBe("0955666777"));
    await settlePreview();
    expect(screen.queryByText("客戶電話已變更，紅利折抵已重設")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /使用點數折抵/ })).toHaveAttribute(
      "data-state",
      "checked",
    );
    expect(screen.getByLabelText(/折抵點數/)).toHaveValue("100");

    await clickSubmit("儲存變更");
    await waitFor(() => expect(updateBookingMock).toHaveBeenCalledTimes(1));
    const payload = updateBookingMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["pointsRedeemed"]).toBe(100);
    expect(payload["pointsRedeemMemberId"]).toBe(MEMBER_ID);
  });

  it("#939:改成另一位會員的電話(given:A → existing:B)⇒ 照舊重設折抵並提示", async () => {
    getBookingMock.mockResolvedValue(
      editingDetail({ points_redeemed: 100, points_redeem_amount_snapshot: 10 }),
    );
    previewMock.mockImplementation(async (input: { customerPhone: string }) =>
      input.customerPhone === "0912345678"
        ? previewOk({
            member: { resolution: "given", member_id: MEMBER_ID, name: "王小明", balance: 20 },
          })
        : previewOk({
            member: {
              resolution: "existing",
              member_id: OTHER_MEMBER_ID,
              name: "李小華",
              balance: 900,
            },
          }),
    );
    renderForm(BOOKING_ID);
    await waitFor(() => expect(screen.getByText("會員：王小明")).toBeInTheDocument());
    fireEvent.change(document.getElementById("booking-customer-phone") as HTMLElement, {
      target: { value: "0922333444" },
    });
    await waitFor(() => expect(screen.getByText("會員：李小華")).toBeInTheDocument());
    expect(screen.getByText("客戶電話已變更，紅利折抵已重設")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /使用點數折抵/ })).toHaveAttribute(
      "data-state",
      "unchecked",
    );
  });

  it("未人工設定、重算後建議值變了 ⇒ 提示「派點數已從 A 點變成 B 點」", async () => {
    getBookingMock.mockResolvedValue(editingDetail());
    previewMock.mockResolvedValue(
      previewOk({
        auto_points: 25,
        member: { resolution: "given", member_id: MEMBER_ID, name: "王小明", balance: 120 },
      }),
    );
    renderForm(BOOKING_ID);
    await waitFor(() => expect(screen.getByText("派點數已從 10 點變成 25 點")).toBeInTheDocument());
  });

  it("🔴 第 6 題:已人工設定 + 建議值變了 ⇒ 提示 + 「改用建議值」;按了才送 pointsOverrideReset", async () => {
    getBookingMock.mockResolvedValue(
      editingDetail({
        points_planned: 50,
        points_planned_auto: 10,
        points_planned_overridden: true,
      }),
    );
    previewMock.mockResolvedValue(
      previewOk({
        auto_points: 25,
        member: { resolution: "given", member_id: MEMBER_ID, name: "王小明", balance: 120 },
      }),
    );
    renderForm(BOOKING_ID);
    await waitFor(() =>
      expect(
        screen.getByText("系統建議值已從 10 點變成 25 點，目前人工設定為 50 點"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByLabelText(/本單派點/)).toHaveValue("50");
    fireEvent.click(screen.getByRole("button", { name: "改用建議值" }));
    await clickSubmit("儲存變更");
    await waitFor(() => expect(updateBookingMock).toHaveBeenCalledTimes(1));
    const payload = updateBookingMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["pointsOverrideReset"]).toBe(true);
    expect(payload["pointsOverride"]).toBeNull();
  });

  it("已人工設定、沒動 ⇒ 送 pointsOverride null(保留客服的數字由後端處理,不重送)", async () => {
    getBookingMock.mockResolvedValue(
      editingDetail({
        points_planned: 50,
        points_planned_auto: 10,
        points_planned_overridden: true,
      }),
    );
    previewMock.mockResolvedValue(
      previewOk({
        auto_points: 10,
        member: { resolution: "given", member_id: MEMBER_ID, name: "王小明", balance: 120 },
      }),
    );
    renderForm(BOOKING_ID);
    await waitFor(() => expect(screen.getByLabelText(/本單派點/)).toHaveValue("50"));
    await clickSubmit("儲存變更");
    await waitFor(() => expect(updateBookingMock).toHaveBeenCalledTimes(1));
    const payload = updateBookingMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["pointsOverride"]).toBeNull();
    expect(payload["pointsOverrideReset"]).toBe(false);
  });
});
