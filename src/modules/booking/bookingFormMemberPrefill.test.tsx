// SPECS-INDEX #915 / #936(規格書 §12.2、§12.6):建單表單 + 真正的 MemberPhoneMatchPanel 接在一起測。
//
// 純函式(三種狀態判斷、三欄帶入)已經在 memberPhoneMatch.test.ts 測過;這一支釘的是「接線」——
// 面板點選之後,CalendarPage 的欄位是不是真的被帶入、之後能不能改、狀態 C 會不會偷偷覆蓋、
// 編輯模式的會員連結是不是逐字照舊。只 mock 資料來源(useMembersByPhone),面板本身用真的。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IndustryType } from "@/modules/merchant/types";
import type { MemberPhoneMatchCandidate } from "@/modules/members/types";

const { getBookingMock, createBookingMock, updateBookingMock, toastMock, useMembersByPhoneMock } =
  vi.hoisted(() => ({
    getBookingMock: vi.fn(),
    createBookingMock: vi.fn(),
    updateBookingMock: vi.fn(),
    toastMock: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
    useMembersByPhoneMock: vi.fn(),
  }));

const MERCHANT_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ITEM_ID = "33333333-3333-4333-8333-333333333333";
const BOOKING_ID = "44444444-4444-4444-8444-444444444444";
const LINKED_MEMBER_ID = "55555555-5555-4555-8555-555555555555";
const PAYMENT_METHOD_ID = "66666666-6666-4666-8666-666666666666";

vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("./api", () => ({
  getBooking: getBookingMock,
  createBooking: createBookingMock,
  updateBooking: updateBookingMock,
  // 紅利系統重構 批次 7:表單會呼叫紅利預覽;這支只測會員面板,讓紅利功能維持關閉(區塊不渲染)。
  previewBookingPoints: vi.fn(async () => ({ feature_enabled: false })),
  // SPECS-INDEX #980:時間選單改問資料庫;這裡讓整天都能約(這支只測會員面板)。
  fetchStaffBookableStartTimes: vi.fn(async () => ALL_DAY_START_TIMES),
  MATERIAL_COST_ENABLED_FEATURE_KEY: "material_cost_enabled",
}));

vi.mock("@/modules/members/api", () => ({ useMembersByPhone: useMembersByPhoneMock }));

vi.mock("./BookingDetailDialog", () => ({ BookingDetailDialog: () => null }));

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
  // §12.8 第 3 點:新增模式要真的按到「建立預約」,付款方式是必填 ⇒ 給一個可選的付款方式。
  useMerchantPaymentMethods: () => ({ data: [{ id: PAYMENT_METHOD_ID, name: "現場付款" }] }),
  useMerchantTaxSettings: () => ({ data: null }),
}));

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({
    merchant: { id: MERCHANT_ID, name: "測試商家", industry_type: "on_site_dispatch" },
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

/** 假的會員資料:模擬 get_members_by_phone(前綴比對、至少 4 位數字、完全相等排第一)。 */
const MEMBERS: MemberPhoneMatchCandidate[] = [
  {
    memberId: "m-lee",
    name: "李小華",
    phone: "0903111111",
    lastBookingDate: null,
    isBlacklisted: false,
    blacklistReason: null,
    lastBookingAddress: "台北市信義路 1 號",
    matchedContactPhone: null,
  },
  {
    memberId: "m-chen",
    name: "陳大同",
    phone: "0903222222",
    lastBookingDate: null,
    isBlacklisted: true,
    blacklistReason: "多次爽約",
    lastBookingAddress: null,
    matchedContactPhone: null,
  },
];

function fakeMembersByPhone(merchantId: string | undefined, phone: string) {
  if (!merchantId) return { data: undefined };
  const digits = phone.split("#")[0]?.replace(/\D/g, "") ?? "";
  if (digits.length < 4) return { data: [] };
  const hits = MEMBERS.filter((m) => (m.phone ?? "").startsWith(digits));
  hits.sort((a, b) => Number(b.phone === digits) - Number(a.phone === digits));
  return { data: hits };
}

function renderForm(industryType: IndustryType, editingBookingId: string | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <BookingFormDialog
          merchantId={MERCHANT_ID}
          industryType={industryType}
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

const phoneInput = () => document.getElementById("booking-customer-phone") as HTMLInputElement;
const nameInput = () => document.getElementById("booking-customer-name") as HTMLInputElement;
const addressInput = () =>
  document.getElementById("booking-customer-address") as HTMLInputElement | null;

function type(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

describe("建單表單 × 會員面板(#915 / #936)", () => {
  beforeEach(() => {
    useMembersByPhoneMock.mockImplementation(fakeMembersByPhone);
    updateBookingMock.mockResolvedValue({ id: BOOKING_ID, merchant_id: MERCHANT_ID });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("A:電話不足 4 位 ⇒ 面板完全不顯示", () => {
    renderForm("on_site_dispatch");
    type(phoneInput(), "090");
    expect(screen.queryByText(/開頭相符的客戶/)).not.toBeInTheDocument();
    expect(screen.queryByText(/將連結既有客戶/)).not.toBeInTheDocument();
  });

  it("B:只有開頭相符 ⇒ 列出候選,而且不再出現「這支電話有既有客戶紀錄」這種假話", () => {
    renderForm("on_site_dispatch");
    type(phoneInput(), "0903");
    expect(screen.getByText("開頭相符的客戶(點一下帶入資料)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /李小華/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /陳大同/ })).toBeInTheDocument();
    expect(screen.queryByText(/這支電話有既有客戶紀錄/)).not.toBeInTheDocument();
  });

  it("#915:舊的三個入口全部消失(新客戶按鈕 / 清除連結 / 建立正式會員小卡窗)", () => {
    renderForm("on_site_dispatch");
    type(phoneInput(), "0903");
    expect(screen.queryByText(/這支電話的新客戶/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "清除連結" })).not.toBeInTheDocument();
    expect(screen.queryByText("建立正式會員")).not.toBeInTheDocument();
  });

  it("#936 到府派工:點選候選 ⇒ 電話 / 姓名 / 地址一次帶入(覆蓋原本打的字),面板切到狀態 C", () => {
    renderForm("on_site_dispatch");
    type(nameInput(), "客服先打的名字");
    type(addressInput() as HTMLInputElement, "先打的地址");
    type(phoneInput(), "0903");

    fireEvent.click(screen.getByRole("button", { name: /李小華/ }));

    expect(phoneInput().value).toBe("0903111111");
    expect(nameInput().value).toBe("李小華");
    expect(addressInput()?.value).toBe("台北市信義路 1 號");
    expect(screen.getByText("將連結既有客戶：")).toBeInTheDocument();
    // 狀態 C 不再列出其他開頭相符的候選;#1013 起只列電話完全相等的那一位(可再點一次帶入)
    expect(screen.getAllByRole("button", { name: /李小華|陳大同/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /陳大同/ })).not.toBeInTheDocument();
  });

  it("#936:帶入之後三個欄位都可以直接改,改了不會被再次帶回", () => {
    renderForm("on_site_dispatch");
    type(phoneInput(), "0903");
    fireEvent.click(screen.getByRole("button", { name: /李小華/ }));

    type(nameInput(), "李小華(女兒代訂)");
    type(addressInput() as HTMLInputElement, "新北市板橋區 2 號");

    expect(nameInput().value).toBe("李小華(女兒代訂)");
    expect(addressInput()?.value).toBe("新北市板橋區 2 號");
    expect(phoneInput().value).toBe("0903111111");
  });

  it("#936 到店服務:沒有地址欄位,點選只帶入電話與姓名", () => {
    renderForm("in_store_beauty");
    expect(addressInput()).toBeNull();
    type(phoneInput(), "0903");
    fireEvent.click(screen.getByRole("button", { name: /李小華/ }));
    expect(phoneInput().value).toBe("0903111111");
    expect(nameInput().value).toBe("李小華");
  });

  it("🔴 狀態 C:客服自己把電話打完整(沒有點選)⇒ 不自動覆蓋姓名 / 地址", () => {
    renderForm("on_site_dispatch");
    type(nameInput(), "客服自己打的名字");
    type(addressInput() as HTMLInputElement, "客服自己打的地址");
    type(phoneInput(), "0903111111");

    expect(screen.getByText("將連結既有客戶：").parentElement).toHaveTextContent(
      "將連結既有客戶：李小華",
    );
    expect(nameInput().value).toBe("客服自己打的名字");
    expect(addressInput()?.value).toBe("客服自己打的地址");
  });

  // ─── #1013(第 19 批):電話打完整、對到既有客戶 ⇒ 清單照樣列出那一位,點了就帶入 ───
  it("#1013 狀態 C:打完整電話 ⇒「將連結既有客戶」保留,下方清單只列那一位,點了三欄帶入(同打一半點選)", () => {
    renderForm("on_site_dispatch");
    type(nameInput(), "客服先打的名字");
    type(addressInput() as HTMLInputElement, "先打的地址");
    type(phoneInput(), "0903111111");

    expect(screen.getByText("將連結既有客戶：")).toBeInTheDocument();
    expect(screen.getByText("開頭相符的客戶(點一下帶入資料)")).toBeInTheDocument();
    const rows = screen.getAllByRole("button", { name: /李小華|陳大同/ });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("李小華");
    expect(rows[0]?.className).not.toMatch(/\bbg-(brand|primary)\b/);
    // 沒點之前不自動帶入
    expect(nameInput().value).toBe("客服先打的名字");
    expect(addressInput()?.value).toBe("先打的地址");

    fireEvent.click(rows[0] as HTMLElement);
    expect(phoneInput().value).toBe("0903111111");
    expect(nameInput().value).toBe("李小華");
    expect(addressInput()?.value).toBe("台北市信義路 1 號");
    expect(screen.getByText("將連結既有客戶：")).toBeInTheDocument();
  });

  it("#1013 狀態 C 帶分隔符號的完整電話(0903-111-111)也列出那一位可點", () => {
    renderForm("on_site_dispatch");
    type(phoneInput(), "0903-111-111");
    fireEvent.click(screen.getByRole("button", { name: /李小華/ }));
    expect(nameInput().value).toBe("李小華");
  });

  it("#1013 狀態 C + 黑名單:清單那一位帶「黑名單」標籤,常駐 `!` 照舊", () => {
    renderForm("on_site_dispatch");
    type(phoneInput(), "0903222222");
    const row = screen.getByRole("button", { name: /陳大同/ });
    expect(row).toHaveTextContent("黑名單");
    expect(screen.getByRole("note")).toHaveTextContent("這位客戶被列入黑名單：多次爽約");
    fireEvent.click(row);
    expect(nameInput().value).toBe("陳大同");
  });

  it("#1013 打滿一個不存在的號碼 ⇒ 不出現清單也沒有「將連結」(新客戶流程)", () => {
    renderForm("on_site_dispatch");
    type(phoneInput(), "0912345678");
    expect(screen.queryByText(/開頭相符的客戶/)).not.toBeInTheDocument();
    expect(screen.queryByText(/將連結既有客戶/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /李小華|陳大同/ })).not.toBeInTheDocument();
  });

  it("狀態 C + 黑名單 ⇒ 常駐 `!`(不是一閃即逝的 toast)", () => {
    renderForm("on_site_dispatch");
    type(phoneInput(), "0903222222");
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("這位客戶被列入黑名單：多次爽約");
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it("面板裡沒有任何實心主題色按鈕(表單唯一的 ① 主要按鈕是「建立預約」)", () => {
    renderForm("on_site_dispatch");
    type(phoneInput(), "0903");
    // Button variant="primary" 會帶 bg-brand(舊 default 是 bg-primary);面板的候選列是列表項,兩個都不會有。
    const panelButtons = screen
      .getAllByRole("button")
      .filter((b) => /李小華|陳大同/.test(b.textContent ?? ""));
    expect(panelButtons).toHaveLength(2);
    for (const b of panelButtons) expect(b.className).not.toMatch(/\bbg-(brand|primary)\b/);
  });

  it("🔴 §12.8 ③ 新增模式:點選候選後按「建立預約」⇒ 送出的 memberId 是 null(會員由後端依電話決定)", async () => {
    createBookingMock.mockResolvedValue({
      id: BOOKING_ID,
      merchant_id: MERCHANT_ID,
      member_id: "m-lee",
      member_auto_created: false,
      member_name_snapshot: "李小華",
      final_amount_snapshot: 1000,
    });
    renderForm("on_site_dispatch");
    type(phoneInput(), "0903");
    fireEvent.click(screen.getByRole("button", { name: /李小華/ }));
    expect(screen.getByText("將連結既有客戶：")).toBeInTheDocument();

    // SPECS-INDEX #979:服務項目改從「選擇項目」整頁勾選、付款方式改下拉選單(只改操作步驟)。
    pickServiceItems([/冷氣清洗/]);
    await selectPaymentMethod("現場付款");
    screen.getByRole("button", { name: "建立預約" }).click();

    await waitFor(() => expect(createBookingMock).toHaveBeenCalledTimes(1));
    const payload = createBookingMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["customerPhone"]).toBe("0903111111");
    expect(payload["customerName"]).toBe("李小華");
    expect(Object.prototype.hasOwnProperty.call(payload, "memberId")).toBe(true);
    expect(payload["memberId"]).toBeNull();
    // 順便確認成功提示框用的是會員姓名那一行(#916)
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("已送出訂單（待確認）", expect.anything()),
    );
  });

  describe("🔴 編輯模式(§12.1 已連結照舊 + §12.7 未連結可補掛)", () => {
    function editingDetail(memberId: string | null, memberName: string | null) {
      return {
        id: BOOKING_ID,
        merchant_id: MERCHANT_ID,
        staff_id: STAFF_ID,
        start_at: "2036-01-05T02:00:00+00:00",
        end_at: "2036-01-05T03:00:00+00:00",
        status: "accepted",
        customer_name: "陳先生",
        customer_phone: "0903111111",
        customer_email: null,
        customer_address: "台北市某處",
        notes: null,
        customer_notes: null,
        hide_notes_from_staff: false,
        member_id: memberId,
        member_name_snapshot: memberName,
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

    it("已連結會員的訂單:顯示「已連結會員」,沒動就儲存 ⇒ payload 帶回同一個 member_id", async () => {
      getBookingMock.mockResolvedValue(editingDetail(LINKED_MEMBER_ID, "王小明"));
      renderForm("on_site_dispatch", BOOKING_ID);
      await waitFor(() => expect(screen.getByText("已連結會員：")).toBeInTheDocument());
      expect(screen.getByText("王小明")).toBeInTheDocument();
      // 編輯模式不查候選、不顯示「將連結」(update_booking 不會依電話自動比對,那會是一句假話)
      expect(screen.queryByText(/將連結既有客戶/)).not.toBeInTheDocument();
      // 表單載入前那一瞬間還不知道是否已連結;一旦確定已連結,之後就不再查候選。
      expect(useMembersByPhoneMock.mock.calls.at(-1)?.[0]).toBeUndefined();

      screen.getByRole("button", { name: "儲存變更" }).click();
      await waitFor(() => expect(updateBookingMock).toHaveBeenCalledTimes(1));
      expect(updateBookingMock.mock.calls[0]?.[0]).toMatchObject({ memberId: LINKED_MEMBER_ID });
    });

    it("§12.7 未連結的訂單:狀態 C 改用不說假話的文案,而且不會自動補掛", async () => {
      getBookingMock.mockResolvedValue(editingDetail(null, null));
      renderForm("on_site_dispatch", BOOKING_ID);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /這支電話是既有客戶：/ })).toBeInTheDocument(),
      );
      expect(screen.getByText("(點一下即可連結到這筆訂單)")).toBeInTheDocument();
      expect(screen.queryByText(/將連結既有客戶/)).not.toBeInTheDocument();
      expect(screen.queryByText(/儲存後會連結到會員/)).not.toBeInTheDocument();
    });

    it("§12.7 ③ 未連結的訂單:點狀態 C 那一行 ⇒ 顯示「儲存後會連結」,儲存時補掛這位會員", async () => {
      getBookingMock.mockResolvedValue(editingDetail(null, null));
      renderForm("on_site_dispatch", BOOKING_ID);
      const row = await screen.findByRole("button", { name: /這支電話是既有客戶：/ });
      fireEvent.click(row);

      expect(screen.getByText("儲存後會連結到會員：")).toBeInTheDocument();
      expect(nameInput().value).toBe("李小華");

      screen.getByRole("button", { name: "儲存變更" }).click();
      await waitFor(() => expect(updateBookingMock).toHaveBeenCalledTimes(1));
      expect(updateBookingMock.mock.calls[0]?.[0]).toMatchObject({ memberId: "m-lee" });
    });

    it("§12.7 ③ 未連結的訂單:從開頭相符清單點選 ⇒ 補掛那一位", async () => {
      getBookingMock.mockResolvedValue(editingDetail(null, null));
      renderForm("on_site_dispatch", BOOKING_ID);
      await waitFor(() => expect(phoneInput().value).toBe("0903111111"));
      type(phoneInput(), "0903");
      fireEvent.click(screen.getByRole("button", { name: /陳大同/ }));
      expect(phoneInput().value).toBe("0903222222");
      expect(screen.getByText("儲存後會連結到會員：")).toBeInTheDocument();
      // 點選後面板切到「儲存後會連結到會員」;陳大同是黑名單客戶,黑名單 `!` 提醒會繼續常駐(§12.8 ①,另有專門測試)
      screen.getByRole("button", { name: "儲存變更" }).click();
      await waitFor(() => expect(updateBookingMock).toHaveBeenCalledTimes(1));
      expect(updateBookingMock.mock.calls[0]?.[0]).toMatchObject({ memberId: "m-chen" });
    });

    it("🔴 §12.8 ① 點選黑名單客戶補掛後,黑名單 `!` 提醒仍然常駐(不會因為切到「儲存後會連結」而消失)", async () => {
      getBookingMock.mockResolvedValue(editingDetail(null, null));
      renderForm("on_site_dispatch", BOOKING_ID);
      await waitFor(() => expect(phoneInput().value).toBe("0903111111"));
      type(phoneInput(), "0903");
      fireEvent.click(screen.getByRole("button", { name: /陳大同/ }));

      expect(screen.getByText("儲存後會連結到會員：")).toBeInTheDocument();
      expect(screen.getByRole("note")).toHaveTextContent("這位客戶被列入黑名單：多次爽約");
      expect(toastMock.warning).not.toHaveBeenCalled();
    });

    it("§12.8 ① 補掛的不是黑名單客戶 ⇒ 沒有黑名單提醒", async () => {
      getBookingMock.mockResolvedValue(editingDetail(null, null));
      renderForm("on_site_dispatch", BOOKING_ID);
      fireEvent.click(await screen.findByRole("button", { name: /這支電話是既有客戶：/ }));
      expect(screen.getByText("儲存後會連結到會員：")).toBeInTheDocument();
      expect(screen.queryByRole("note")).not.toBeInTheDocument();
    });

    it("🔴 §12.7 ④ 點選補掛之後又改了電話 ⇒ 面板當下取消補掛,儲存送出 null", async () => {
      getBookingMock.mockResolvedValue(editingDetail(null, null));
      renderForm("on_site_dispatch", BOOKING_ID);
      fireEvent.click(await screen.findByRole("button", { name: /這支電話是既有客戶：/ }));
      expect(screen.getByText("儲存後會連結到會員：")).toBeInTheDocument();

      type(phoneInput(), "0912345678");
      expect(screen.queryByText("儲存後會連結到會員：")).not.toBeInTheDocument();

      // 改回原本那支電話也**不會**自己恢復 —— 補掛一定要客服再點一次
      type(phoneInput(), "0903111111");
      expect(screen.queryByText("儲存後會連結到會員：")).not.toBeInTheDocument();

      screen.getByRole("button", { name: "儲存變更" }).click();
      await waitFor(() => expect(updateBookingMock).toHaveBeenCalledTimes(1));
      const payload = updateBookingMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(payload["memberId"]).toBeNull();
    });

    it("沒有連結會員的訂單:沒動就儲存 ⇒ payload 的 memberId 仍是 null(不會因為電話相符被偷偷連上)", async () => {
      getBookingMock.mockResolvedValue(editingDetail(null, null));
      renderForm("on_site_dispatch", BOOKING_ID);
      await waitFor(() => expect(phoneInput().value).toBe("0903111111"));
      expect(screen.queryByText("已連結會員：")).not.toBeInTheDocument();

      screen.getByRole("button", { name: "儲存變更" }).click();
      await waitFor(() => expect(updateBookingMock).toHaveBeenCalledTimes(1));
      const payload = updateBookingMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(payload["memberId"]).toBeNull();
    });

    // ─── SPECS-INDEX #939(第 11 批 A,規格書 §1.7 / §5.2):已連結會員的單改電話 ⇒ 改掛會員 ───
    describe("#939 已連結會員的單改電話(E0~E4)", () => {
      const relinkPanel = () => screen.getByTestId("member-relink-panel");
      const consequence = () => screen.getByTestId("member-relink-consequence");

      it("E0:只改格式(0903-111-111)不算改電話 ⇒ 仍是「已連結會員」,沒有改掛提示", async () => {
        getBookingMock.mockResolvedValue(editingDetail(LINKED_MEMBER_ID, "王小明"));
        renderForm("on_site_dispatch", BOOKING_ID);
        await waitFor(() => expect(screen.getByText("已連結會員：")).toBeInTheDocument());
        type(phoneInput(), "0903-111-111");
        expect(screen.getByText("已連結會員：")).toBeInTheDocument();
        expect(screen.queryByTestId("member-relink-panel")).not.toBeInTheDocument();
        expect(screen.queryByTestId("member-relink-consequence")).not.toBeInTheDocument();
      });

      it("E1:打到一半 ⇒ 列開頭相符的客戶;點選只帶入資料、不設定補掛,送出仍帶原會員 id(由後端依電話改掛)", async () => {
        getBookingMock.mockResolvedValue(editingDetail(LINKED_MEMBER_ID, "王小明"));
        renderForm("on_site_dispatch", BOOKING_ID);
        await waitFor(() => expect(screen.getByText("已連結會員：")).toBeInTheDocument());
        type(phoneInput(), "0903");
        expect(screen.getByText("開頭相符的客戶(點一下帶入資料)")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /陳大同/ }));
        expect(phoneInput().value).toBe("0903222222");
        expect(nameInput().value).toBe("陳大同");
        expect(addressInput()?.value).toBe("台北市某處"); // 陳大同沒有地址 ⇒ 不覆蓋
        expect(screen.queryByText("儲存後會連結到會員：")).not.toBeInTheDocument();
        expect(relinkPanel()).toHaveTextContent("電話已更改，儲存後這筆訂單會改掛到：陳大同");

        screen.getByRole("button", { name: "儲存變更" }).click();
        await waitFor(() => expect(updateBookingMock).toHaveBeenCalledTimes(1));
        expect(updateBookingMock.mock.calls[0]?.[0]).toMatchObject({
          memberId: LINKED_MEMBER_ID,
          customerPhone: "0903222222",
        });
      });

      it("E1:到府產業點選有地址的候選 ⇒ 地址一起帶入", async () => {
        getBookingMock.mockResolvedValue(editingDetail(LINKED_MEMBER_ID, "王小明"));
        renderForm("on_site_dispatch", BOOKING_ID);
        await waitFor(() => expect(screen.getByText("已連結會員：")).toBeInTheDocument());
        type(phoneInput(), "0903");
        fireEvent.click(screen.getByRole("button", { name: /李小華/ }));
        expect(nameInput().value).toBe("李小華");
        expect(addressInput()?.value).toBe("台北市信義路 1 號");
      });

      it("E2 + 黑名單:一行「會改掛到」+ 黑名單常駐 `!` + 後果 `!`(沒折抵版)", async () => {
        getBookingMock.mockResolvedValue(editingDetail(LINKED_MEMBER_ID, "王小明"));
        renderForm("on_site_dispatch", BOOKING_ID);
        await waitFor(() => expect(screen.getByText("已連結會員：")).toBeInTheDocument());
        type(phoneInput(), "0903222222");
        expect(relinkPanel()).toHaveTextContent("電話已更改，儲存後這筆訂單會改掛到：陳大同");
        const notes = screen.getAllByRole("note").map((n) => n.textContent);
        expect(notes).toContain("!這位客戶被列入黑名單：多次爽約");
        expect(consequence()).toHaveTextContent(
          "儲存後，這筆訂單的紅利改算給新的會員，派點依新會員重新計算。",
        );
        expect(screen.queryByText("已連結會員：")).not.toBeInTheDocument();
      });

      it("#1013 E2:打完整電話對到別位會員 ⇒ 下方列出那一位可點,點了只帶入資料,送出仍帶原會員 id", async () => {
        getBookingMock.mockResolvedValue(editingDetail(LINKED_MEMBER_ID, "王小明"));
        renderForm("on_site_dispatch", BOOKING_ID);
        await waitFor(() => expect(screen.getByText("已連結會員：")).toBeInTheDocument());
        type(phoneInput(), "0903222222");
        expect(relinkPanel()).toHaveTextContent("電話已更改，儲存後這筆訂單會改掛到：陳大同");
        const rows = screen.getAllByRole("button", { name: /李小華|陳大同/ });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toHaveTextContent("陳大同");
        fireEvent.click(rows[0] as HTMLElement);
        expect(nameInput().value).toBe("陳大同");
        expect(addressInput()?.value).toBe("台北市某處"); // 陳大同沒有地址 ⇒ 不覆蓋
        expect(screen.queryByText("儲存後會連結到會員：")).not.toBeInTheDocument();

        screen.getByRole("button", { name: "儲存變更" }).click();
        await waitFor(() => expect(updateBookingMock).toHaveBeenCalledTimes(1));
        expect(updateBookingMock.mock.calls[0]?.[0]).toMatchObject({
          memberId: LINKED_MEMBER_ID,
          customerPhone: "0903222222",
        });
      });

      it("E2 不是黑名單 ⇒ 只有後果 `!`(一則)", async () => {
        getBookingMock.mockResolvedValue({
          ...editingDetail(LINKED_MEMBER_ID, "王小明"),
          customer_phone: "0912000000",
        });
        renderForm("on_site_dispatch", BOOKING_ID);
        await waitFor(() => expect(screen.getByText("已連結會員：")).toBeInTheDocument());
        type(phoneInput(), "0903111111");
        expect(relinkPanel()).toHaveTextContent("電話已更改，儲存後這筆訂單會改掛到：李小華");
        expect(screen.getAllByRole("note")).toHaveLength(1);
      });

      it("E3:完全相等的那位就是原會員(會員資料上的電話改過)⇒ 顯示同 E0", async () => {
        getBookingMock.mockResolvedValue({
          ...editingDetail("m-lee", "李小華"),
          customer_phone: "0912000000",
        });
        renderForm("on_site_dispatch", BOOKING_ID);
        await waitFor(() => expect(screen.getByText("已連結會員：")).toBeInTheDocument());
        type(phoneInput(), "0903111111");
        expect(screen.getByText("已連結會員：")).toBeInTheDocument();
        expect(screen.queryByTestId("member-relink-panel")).not.toBeInTheDocument();
      });

      it("E4:沒有會員的完整電話 ⇒「會用這支電話建立新會員:{表單姓名}」+ 後果 `!`(有折抵版,逐字)", async () => {
        getBookingMock.mockResolvedValue({
          ...editingDetail(LINKED_MEMBER_ID, "王小明"),
          points_redeemed: 30,
        });
        renderForm("on_site_dispatch", BOOKING_ID);
        await waitFor(() => expect(screen.getByText("已連結會員：")).toBeInTheDocument());
        type(phoneInput(), "0912345678");
        type(nameInput(), "林新客");
        expect(relinkPanel()).toHaveTextContent("電話已更改，儲存後會用這支電話建立新會員：林新客");
        expect(consequence()).toHaveTextContent(
          "儲存後，這筆訂單的紅利改算給新的會員。原會員「王小明」的紅利折抵 30 點會全部退回給他，派點依新會員重新計算。",
        );
      });

      it("面板裡沒有實心主題色按鈕(E1 候選列也一樣)", async () => {
        getBookingMock.mockResolvedValue(editingDetail(LINKED_MEMBER_ID, "王小明"));
        renderForm("on_site_dispatch", BOOKING_ID);
        await waitFor(() => expect(screen.getByText("已連結會員：")).toBeInTheDocument());
        type(phoneInput(), "0903");
        for (const b of screen.getAllByRole("button", { name: /李小華|陳大同/ })) {
          expect(b.className).not.toMatch(/\bbg-(brand|primary)\b/);
        }
      });

      it("儲存成功:會員真的換了 ⇒ 提示加描述「已改掛會員:{會員姓名}」(6 秒)", async () => {
        getBookingMock.mockResolvedValue(editingDetail(LINKED_MEMBER_ID, "王小明"));
        updateBookingMock.mockResolvedValue({
          id: BOOKING_ID,
          merchant_id: MERCHANT_ID,
          member_id: "m-chen",
          member_name_snapshot: "陳大同",
        });
        renderForm("on_site_dispatch", BOOKING_ID);
        await waitFor(() => expect(screen.getByText("已連結會員：")).toBeInTheDocument());
        type(phoneInput(), "0903222222");
        screen.getByRole("button", { name: "儲存變更" }).click();
        await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
        expect(toastMock.success).toHaveBeenCalledWith("已更新預約", {
          description: "已改掛會員：陳大同",
          duration: 6000,
        });
      });

      it("儲存成功:會員沒換 ⇒ 提示只有標題「已更新預約」", async () => {
        getBookingMock.mockResolvedValue(editingDetail(LINKED_MEMBER_ID, "王小明"));
        updateBookingMock.mockResolvedValue({
          id: BOOKING_ID,
          merchant_id: MERCHANT_ID,
          member_id: LINKED_MEMBER_ID,
          member_name_snapshot: "王小明",
        });
        renderForm("on_site_dispatch", BOOKING_ID);
        await waitFor(() => expect(screen.getByText("已連結會員：")).toBeInTheDocument());
        screen.getByRole("button", { name: "儲存變更" }).click();
        await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
        expect(toastMock.success).toHaveBeenCalledWith("已更新預約");
      });
    });
  });
});
