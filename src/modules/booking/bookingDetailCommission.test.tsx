// SPECS-INDEX #996(第 11 批 K):預約詳情「服務人員抽成」區塊 + 「重新計算抽成」按鈕。
// 規格書 §十八 18.7 vitest ①~⑦ + 主腦裁決(目前不是抽成制 ⇒ 不顯示按鈕、改灰字)。
// 把 BookingDetailDialog 真的 render 起來,booking / payroll api 與兩個權限 hook 全部 mock。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBooking: vi.fn(),
  fetchBookingCommissionSummary: vi.fn(),
  recalculateBookingCommission: vi.fn(),
  role: { current: "admin" as string | null | undefined },
  perms: { current: {} as Record<string, boolean | null | undefined> },
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));

vi.mock("./api", () => ({
  getBooking: mocks.getBooking,
  getBookingPointsLedger: vi.fn(async () => null),
  fetchCompletedBookingReversalPreview: vi.fn(),
  revertCompletedBooking: vi.fn(),
  cancelCompletedBooking: vi.fn(),
  cancelBooking: vi.fn(),
  completeBooking: vi.fn(),
  confirmBooking: vi.fn(),
  removeBookingAssistant: vi.fn(),
  getCustomerRelatedBookings: vi.fn(async () => []),
}));

vi.mock("@/modules/payroll/api", () => ({
  fetchBookingCommissionSummary: mocks.fetchBookingCommissionSummary,
  recalculateBookingCommission: mocks.recalculateBookingCommission,
}));

vi.mock("./context", () => ({
  useBookingStatusChangeLogs: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({
    merchant: { id: "merchant-1", name: "測試商家", industry_type: "in_store_beauty" },
    isLoading: false,
  }),
}));

vi.mock("@/modules/staff-agent/context", () => ({
  useCurrentMerchantRole: () => ({ data: mocks.role.current, isLoading: false }),
  useAgentPermission: (key: string) => ({ data: mocks.perms.current[key] }),
}));

vi.mock("@/modules/line-notifications/api", () => ({
  dispatchLineNotification: vi.fn(),
  usePendingLineNotificationPreview: () => ({ refetch: vi.fn() }),
}));

vi.mock("@/modules/line-notifications/ConfirmBookingLineDialog", () => ({
  ConfirmBookingLineDialog: () => null,
}));

import { BookingDetailDialog } from "./BookingDetailDialog";
import { BOOKING_COMMISSION_COPY } from "./bookingCommissionCopy";

const BOOKING_ID = "booking-1";

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    merchant_id: "merchant-1",
    staff_id: "staff-1",
    status: "completed",
    start_at: "2026-09-30T06:00:00Z",
    end_at: "2026-09-30T07:00:00Z",
    custom_duration_enabled: false,
    custom_duration_minutes: null,
    assistants: [],
    createdByName: "客服甲",
    lastModifiedByName: null,
    last_modified_at: null,
    created_at: "2026-09-29T06:00:00Z",
    serviceItems: [{ id: "i-1", name: "清洗", quantity: 1, lineTotal: 12000 }],
    subtotal_amount_snapshot: 12000,
    custom_total_amount_enabled: false,
    discount_enabled: false,
    tax_enabled: false,
    final_amount_snapshot: 12000,
    payment_method_name_snapshot: "現金",
    materialCosts: [{ materialCostItemId: "mc-1", name: "冷媒", quantity: 1, amountSnapshot: 500 }],
    customer_name: "王小美",
    customer_phone: "0912345678",
    customer_address: null,
    customer_notes: null,
    notes: null,
    hide_notes_from_staff: false,
    member_id: null,
    member_name_snapshot: null,
    points_planned: 0,
    points_planned_overridden: false,
    points_redeemed: 0,
    points_redeem_amount_snapshot: 0,
    ...overrides,
  };
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    has_record: true,
    commission_amount: 1200,
    computed_at: "2026-09-30T06:00:00Z",
    recalculated_at: null,
    staff_name: "服務人員甲",
    staff_is_piece_rate: true,
    ...overrides,
  };
}

let queryClient: QueryClient;
let onChanged: ReturnType<typeof vi.fn>;
let onOpenChange: ReturnType<typeof vi.fn>;

function renderDialog() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  onChanged = vi.fn();
  onOpenChange = vi.fn();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <BookingDetailDialog
          bookingId={BOOKING_ID}
          staffNameById={new Map([["staff-1", "服務人員甲"]])}
          open
          onOpenChange={onOpenChange}
          onChanged={onChanged}
          onEdit={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function waitDetail() {
  await screen.findByText("王小美");
}

beforeEach(() => {
  mocks.role.current = "admin";
  mocks.perms.current = {};
  mocks.getBooking.mockResolvedValue(booking());
  mocks.fetchBookingCommissionSummary.mockResolvedValue(summary());
  mocks.recalculateBookingCommission.mockReset();
  mocks.toast.success.mockReset();
  mocks.toast.error.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("K-4 誰看得到", () => {
  it("① 管理員 + 已完成 ⇒ 區塊與按鈕出現、顯示 $1,200 與最後計算時間(台北)", async () => {
    renderDialog();
    const section = await screen.findByTestId("booking-commission-section");
    expect(await within(section).findByTestId("booking-commission-amount")).toHaveTextContent(
      "$1,200",
    );
    expect(within(section).getByTestId("booking-commission-computed-at")).toHaveTextContent(
      "最後計算：2026/09/30 14:00",
    );
    expect(within(section).getByRole("button", { name: "重新計算抽成" })).toBeInTheDocument();
    expect(screen.getByText("服務人員抽成")).toBeInTheDocument();
    expect(mocks.fetchBookingCommissionSummary).toHaveBeenCalledWith(BOOKING_ID);
  });

  it("① 區塊排在「料錢成本」之後、「記錄」之前", async () => {
    renderDialog();
    await screen.findByTestId("booking-commission-section");
    const material = screen.getByText("料錢成本");
    const commission = screen.getByText("服務人員抽成");
    const record = screen.getByText("記錄");
    expect(
      material.compareDocumentPosition(commission) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      commission.compareDocumentPosition(record) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("② 客服有「抽成與薪資設定」⇒ 出現", async () => {
    mocks.role.current = "agent";
    mocks.perms.current = { commission_settings: true };
    renderDialog();
    expect(await screen.findByTestId("booking-commission-recalculate")).toBeInTheDocument();
  });

  it.each([
    [
      "客服沒有這把鑰匙(就算有服務人員報表)",
      "agent",
      { commission_settings: false, staff_report: true },
      "completed",
    ],
    ["客服權限還在讀取中", "agent", { commission_settings: undefined }, "completed"],
    ["角色還在讀取中", undefined, {}, "completed"],
    ["服務人員", "staff", { commission_settings: null }, "completed"],
    ["管理員但訂單不是已完成", "admin", {}, "accepted"],
  ] as const)("③ %s ⇒ 不出現、也不讀抽成", async (_label, role, perms, status) => {
    mocks.role.current = role;
    mocks.perms.current = { ...perms };
    mocks.getBooking.mockResolvedValue(booking({ status }));
    renderDialog();
    await waitDetail();
    expect(screen.queryByTestId("booking-commission-section")).toBeNull();
    expect(screen.queryByText("服務人員抽成")).toBeNull();
    expect(mocks.fetchBookingCommissionSummary).not.toHaveBeenCalled();
  });

  it("③ 切去看相關訂單(不是原本那一筆)⇒ 不出現", async () => {
    const user = userEvent.setup();
    const api = await import("./api");
    vi.mocked(api.getCustomerRelatedBookings).mockResolvedValue([
      {
        id: "booking-2",
        startAt: "2026-09-01T06:00:00Z",
        status: "completed",
        serviceItemNames: ["清洗"],
        finalAmountSnapshot: 1000,
      } as never,
    ]);
    mocks.getBooking.mockImplementation(async (id: string) =>
      booking({ id, customer_name: id === BOOKING_ID ? "王小美" : "王小美(舊單)" }),
    );
    renderDialog();
    await screen.findByTestId("booking-commission-section");
    await user.click(screen.getByText("相關訂單"));
    await user.click(await screen.findByRole("button", { name: /清洗/ }));
    await screen.findByText("王小美(舊單)");
    expect(screen.queryByTestId("booking-commission-section")).toBeNull();
  });
});

describe("K-5 區塊內容", () => {
  it("④ has_record = false ⇒ 灰字、沒有按鈕", async () => {
    mocks.fetchBookingCommissionSummary.mockResolvedValue(
      summary({
        has_record: false,
        commission_amount: null,
        computed_at: null,
        staff_name: null,
        staff_is_piece_rate: null,
      }),
    );
    renderDialog();
    expect(await screen.findByTestId("booking-commission-no-record")).toHaveTextContent(
      "這筆訂單沒有抽成紀錄(月薪制、日薪制、時薪制服務人員不計抽成，或完成時沒有產生)，不能重新計算。",
    );
    expect(screen.queryByTestId("booking-commission-recalculate")).toBeNull();
  });

  it("主腦裁決:目前不是抽成制 ⇒ 顯示目前抽成 + 灰字說明、沒有按鈕", async () => {
    mocks.fetchBookingCommissionSummary.mockResolvedValue(summary({ staff_is_piece_rate: false }));
    renderDialog();
    expect(await screen.findByTestId("booking-commission-not-piece-rate")).toHaveTextContent(
      "這位服務人員目前不是抽成制，無法重新計算抽成。",
    );
    expect(screen.getByTestId("booking-commission-amount")).toHaveTextContent("$1,200");
    expect(screen.queryByTestId("booking-commission-recalculate")).toBeNull();
  });

  it("讀取失敗 ⇒ 錯誤畫面 + 重試,沒有按鈕", async () => {
    const user = userEvent.setup();
    mocks.fetchBookingCommissionSummary.mockRejectedValueOnce(new Error("boom"));
    renderDialog();
    expect(await screen.findByText("讀不到這筆訂單的抽成")).toBeInTheDocument();
    expect(screen.queryByTestId("booking-commission-recalculate")).toBeNull();
    await user.click(screen.getByRole("button", { name: "重試" }));
    expect(await screen.findByTestId("booking-commission-recalculate")).toBeInTheDocument();
  });

  it("有重算過 ⇒ 最後計算顯示 recalculated_at", async () => {
    mocks.fetchBookingCommissionSummary.mockResolvedValue(
      summary({ recalculated_at: "2026-10-07T01:05:00Z" }),
    );
    renderDialog();
    expect(await screen.findByTestId("booking-commission-computed-at")).toHaveTextContent(
      "最後計算：2026/10/07 09:05",
    );
  });
});

describe("K-6~K-8 確認窗與送出", () => {
  async function openConfirm(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByTestId("booking-commission-recalculate"));
    return screen.findByTestId("booking-commission-confirm");
  }

  it("⑤ 確認窗文字逐字(含目前金額)→ 確定 ⇒ 呼叫一次;toast 新舊金額;區塊重抓", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openConfirm(user);
    expect(within(dialog).getByText(BOOKING_COMMISSION_COPY.confirmTitle)).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "會用目前的抽成比例和「料錢影響抽成」設定，依這筆訂單當時的金額與料錢重新算一次，並取代原本的抽成(目前 $1,200)。服務人員報表會跟著變，這個動作不能復原。",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["取消", "重新計算"]);

    mocks.recalculateBookingCommission.mockResolvedValue({ commission_amount: 1080 });
    mocks.fetchBookingCommissionSummary.mockResolvedValue(
      summary({ commission_amount: 1080, recalculated_at: "2026-10-07T01:05:00Z" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "重新計算" }));
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith("抽成已重新計算：$1,200 → $1,080"),
    );
    expect(mocks.recalculateBookingCommission).toHaveBeenCalledTimes(1);
    expect(mocks.recalculateBookingCommission).toHaveBeenCalledWith(BOOKING_ID);
    await waitFor(() => expect(screen.queryByTestId("booking-commission-confirm")).toBeNull());
    await waitFor(() =>
      expect(screen.getByTestId("booking-commission-amount")).toHaveTextContent("$1,080"),
    );
    expect(screen.getByTestId("booking-commission-computed-at")).toHaveTextContent(
      "最後計算：2026/10/07 09:05",
    );
  });

  it("⑤ 金額沒變 ⇒「金額沒有變動($1,200)」", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openConfirm(user);
    mocks.recalculateBookingCommission.mockResolvedValue({ commission_amount: 1200 });
    await user.click(within(dialog).getByRole("button", { name: "重新計算" }));
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith("抽成已重新計算，金額沒有變動($1,200)"),
    );
  });

  it("按取消 ⇒ 不呼叫", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByTestId("booking-commission-confirm")).toBeNull());
    expect(mocks.recalculateBookingCommission).not.toHaveBeenCalled();
  });

  it("⑥ 送出中:兩顆按鈕 disabled、文字「計算中⋯」;Esc 關不掉確認窗也關不掉詳情", async () => {
    const user = userEvent.setup();
    let resolve!: (v: unknown) => void;
    mocks.recalculateBookingCommission.mockReturnValue(new Promise((r) => (resolve = r)));
    renderDialog();
    const dialog = await openConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: "重新計算" }));
    const busyBtn = await within(dialog).findByRole("button", { name: "計算中⋯" });
    expect(busyBtn).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("booking-commission-confirm")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    resolve({ commission_amount: 1200 });
    await waitFor(() => expect(screen.queryByTestId("booking-commission-confirm")).toBeNull());
  });

  it("⑦ 失敗(別人剛還原)⇒ toast 錯誤 + 後端訊息,重抓訂單詳情與抽成", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openConfirm(user);
    const summaryCalls = mocks.fetchBookingCommissionSummary.mock.calls.length;
    const bookingCalls = mocks.getBooking.mock.calls.length;
    mocks.recalculateBookingCommission.mockRejectedValue({
      message: "只有已完成的訂單才能重新計算抽成",
      code: "P0001",
    });
    await user.click(within(dialog).getByRole("button", { name: "重新計算" }));
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith("重新計算失敗", {
        description: "只有已完成的訂單才能重新計算抽成",
      }),
    );
    await waitFor(() => expect(mocks.getBooking.mock.calls.length).toBeGreaterThan(bookingCalls));
    await waitFor(() =>
      expect(mocks.fetchBookingCommissionSummary.mock.calls.length).toBeGreaterThan(summaryCalls),
    );
    expect(onChanged).toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it("⑦ 其他失敗(例如權限)⇒ toast 錯誤,不重抓詳情", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openConfirm(user);
    const bookingCalls = mocks.getBooking.mock.calls.length;
    mocks.recalculateBookingCommission.mockRejectedValue({
      message:
        "重新計算已完成訂單的抽成金額，只有商家管理員或有「抽成與薪資設定」權限的客服可以操作",
      code: "42501",
    });
    await user.click(within(dialog).getByRole("button", { name: "重新計算" }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    expect(mocks.getBooking.mock.calls.length).toBe(bookingCalls);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("文案守門", () => {
  it("不含半形逗號冒號、不寫「師傅」", () => {
    const texts = [
      BOOKING_COMMISSION_COPY.sectionLabel,
      BOOKING_COMMISSION_COPY.noRecord,
      BOOKING_COMMISSION_COPY.notPieceRate,
      BOOKING_COMMISSION_COPY.loadError,
      BOOKING_COMMISSION_COPY.confirmTitle,
      BOOKING_COMMISSION_COPY.confirmBody("$1,200"),
      BOOKING_COMMISSION_COPY.lastComputed("2026/10/07 09:05"),
      BOOKING_COMMISSION_COPY.successChanged("$1", "$2"),
      BOOKING_COMMISSION_COPY.successSame("$1"),
    ].map((t) => t.replace(/\$[\d,]+/g, "").replace(/\d{2}:\d{2}/g, ""));
    for (const t of texts) {
      expect(t).not.toMatch(/[,:]/);
      expect(t).not.toContain("師傅");
    }
  });
});
