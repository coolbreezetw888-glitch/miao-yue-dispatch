// SPECS-INDEX #861 第 6 項:薪資報表的日期填反時,不要再跳一塊會誤導人的 ErrorState。
//
// 使用者實機巡檢回報:把結束日期填得比起始日期早,畫面上**同時**出現兩件事 ——
//   ① 日期欄位下面一行紅字「結束日期不能早於起始日期」(這是對的,而且已經指到正確的地方)
//   ② 下面一整塊「讀不到這份報表 / 可能是網路斷了,或你沒有查看這位服務人員報表的權限」(這是錯的)
// ②會把「你把日期填反了」誤導成「系統壞了 / 你沒有權限」,使用者(非工程師)只會更慌,
// 而且真正該修的地方完全沒被指出來。
//
// 查詢本身早就不會送出了:三支 *_by_range hook 的 enabled 都帶了 `validateDateRange(...) === null`
//(payroll/api.ts)。問題純粹是「查詢被停用時 data 是 undefined,而報表元件的條件寫成
// `if (error || !summary) return <ErrorState/>`」—— undefined 被當成失敗。
//
// 【故障注入驗證(2026-09-30 實際跑過並還原)】
//   StaffReportPage.tsx 兩個報表元件的 `if (dateRangeError) return null;` 拿掉
//   → 下面 4 條「不可以出現 ErrorState」全部轉紅(抽成制/月薪制 × 日期填反/超過一年),
//     「日期合法時照樣顯示報表」那 2 條仍綠 —— 證明這一組不是把 ErrorState 整個測掉了。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { commissionRangeMock, payrollRangeMock } = vi.hoisted(() => ({
  commissionRangeMock: vi.fn(),
  payrollRangeMock: vi.fn(),
}));

vi.mock("./api", () => ({
  // 兩支「單一年月」的 hook 在這一組測試裡不會被真的使用(我們一律傳 dateRange),
  // 但元件無條件呼叫它們(react hooks 規則),所以要有替身。
  useStaffCommissionSummary: () => ({
    data: undefined,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useStaffMonthlyPayrollSummary: () => ({
    data: undefined,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useStaffCommissionSummaryByRange: (...args: unknown[]) => commissionRangeMock(...args),
  useStaffMonthlyPayrollSummaryByRange: (...args: unknown[]) => payrollRangeMock(...args),
  // #1035 A 批:月薪制報表多查一次獎金;這組測試不測獎金,一律回「沒有資料」。
  useStaffBonusByRange: () => ({
    data: undefined,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({ merchant: { id: "m1", name: "測試商家" }, isLoading: false }),
}));
vi.mock("@/modules/staff-agent/context", () => ({
  useMerchantStaffList: () => ({ data: [], isLoading: false }),
}));
vi.mock("./RequireStaffReportAccess", () => ({
  RequireStaffReportAccess: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { MonthlySalaryStaffReport, PieceRateStaffReport } from "./StaffReportPage";

/** react-query 被停用(enabled: false)時的真實回傳形狀:data undefined、error null、isLoading false。
 *  這正是「日期不合法」時三支 *_by_range hook 的狀態,也是這個 bug 的來源。 */
const DISABLED_QUERY = {
  data: undefined,
  isLoading: false,
  error: null,
  refetch: vi.fn(),
};

function renderWithProviders(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const REVERSED = { startDate: "2026-09-30", endDate: "2026-09-01" };
const TOO_LONG = { startDate: "2025-01-01", endDate: "2026-09-30" };
const VALID = { startDate: "2026-09-01", endDate: "2026-09-30" };

describe("薪資報表:日期不合法時不顯示 ErrorState(#861 第 6 項)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("抽成制:結束日期早於起始日期 → 不可以出現「讀不到這份報表」", () => {
    commissionRangeMock.mockReturnValue(DISABLED_QUERY);
    renderWithProviders(
      <PieceRateStaffReport staffId="s1" staffName="服務人員甲" dateRange={REVERSED} />,
    );
    expect(screen.queryByText("讀不到這份報表")).not.toBeInTheDocument();
    expect(screen.queryByText(/可能是網路斷了/)).not.toBeInTheDocument();
  });

  it("抽成制:區間超過一年 → 同樣不可以出現 ErrorState(另一種不合法)", () => {
    commissionRangeMock.mockReturnValue(DISABLED_QUERY);
    renderWithProviders(
      <PieceRateStaffReport staffId="s1" staffName="服務人員甲" dateRange={TOO_LONG} />,
    );
    expect(screen.queryByText("讀不到這份報表")).not.toBeInTheDocument();
  });

  it("月薪制:結束日期早於起始日期 → 不可以出現 ErrorState", () => {
    payrollRangeMock.mockReturnValue(DISABLED_QUERY);
    renderWithProviders(
      <MonthlySalaryStaffReport staffId="s1" staffName="服務人員乙" dateRange={REVERSED} />,
    );
    expect(screen.queryByText("讀不到這份報表")).not.toBeInTheDocument();
    expect(screen.queryByText(/可能是網路斷了/)).not.toBeInTheDocument();
  });

  it("月薪制:區間超過一年 → 同樣不可以出現 ErrorState", () => {
    payrollRangeMock.mockReturnValue(DISABLED_QUERY);
    renderWithProviders(
      <MonthlySalaryStaffReport staffId="s1" staffName="服務人員乙" dateRange={TOO_LONG} />,
    );
    expect(screen.queryByText("讀不到這份報表")).not.toBeInTheDocument();
  });

  it("🔴 反向對照:日期合法但查詢**真的**失敗時,ErrorState 還是要出現(不可以被一併關掉)", () => {
    commissionRangeMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("permission denied"),
      refetch: vi.fn(),
    });
    renderWithProviders(
      <PieceRateStaffReport staffId="s1" staffName="服務人員甲" dateRange={VALID} />,
    );
    expect(screen.getByText("讀不到這份報表")).toBeInTheDocument();
  });

  it("🔴 反向對照:日期合法且查得到資料時照樣顯示報表內容", () => {
    commissionRangeMock.mockReturnValue({
      data: {
        staff_id: "s1",
        total_commission: 0,
        total_commission_base: 0,
        booking_count: 0,
        assistant_booking_count: 0,
        details: [],
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    renderWithProviders(
      <PieceRateStaffReport staffId="s1" staffName="服務人員甲" dateRange={VALID} />,
    );
    expect(screen.queryByText("讀不到這份報表")).not.toBeInTheDocument();
    expect(screen.getByText("這段期間沒有已完成的訂單")).toBeInTheDocument();
  });
});
