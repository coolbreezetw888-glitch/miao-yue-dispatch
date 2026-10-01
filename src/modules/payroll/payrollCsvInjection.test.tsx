// SPECS-INDEX #925 整合測試:模組 8 的三個 CSV 匯出按鈕(服務人員報表 抽成制 / 月薪制、店家帳務報表)
// 都經過共用的公式注入防護。真的渲染元件、真的按「匯出這份報表為 CSV」,攔下要下載的內容檢查;
// buildCsvContent / buildCsvContentFromRows 用真的那一支(它們內部 import @/lib/csv 的 escapeCsvCell),
// 只把 downloadCsv(瀏覽器下載)換成替身。
//
// 【故障注入】拿掉 src/lib/csv.ts neutralizeCsvFormula 的判斷 → 本檔三條全部轉紅。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { downloadMock, billingMock } = vi.hoisted(() => ({
  downloadMock: vi.fn(),
  billingMock: vi.fn(),
}));

vi.mock("./csvExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./csvExport")>();
  return { ...actual, downloadCsv: downloadMock };
});

const COMMISSION_SUMMARY = {
  details: [
    {
      booking_id: "b1",
      completion_date: "2026-10-01",
      customer_name: '=HYPERLINK("http://evil")',
      commission_base_amount: -300,
      commission_amount: -30,
      recalculated: false,
      legacy_rate_percentage: 10,
      item_breakdown: [],
    },
  ],
  total_orders: 1,
  total_commission_amount: -30,
  assistant_booking_count: 0,
  total_amount: -300,
};

const PAYROLL_SUMMARY = {
  monthly_base_salary: 30000,
  details: [
    {
      leave_type_id: "t1",
      leave_type_name: "@病假",
      days: 1,
      deduction_mode: "full",
      deduction_amount: -1000,
    },
  ],
  total_deduction_amount: -1000,
  net_pay: 29000,
  over_deduction_warning: false,
  monthly_leave_quota_days: null,
  total_leave_days: 1,
  salary_history_estimated: false,
};

const okQuery = (data: unknown) => ({ data, isLoading: false, error: null, refetch: vi.fn() });

vi.mock("./api", () => ({
  useStaffCommissionSummary: () => okQuery(COMMISSION_SUMMARY),
  useStaffMonthlyPayrollSummary: () => okQuery(PAYROLL_SUMMARY),
  useStaffCommissionSummaryByRange: () => okQuery(COMMISSION_SUMMARY),
  useStaffMonthlyPayrollSummaryByRange: () => okQuery(PAYROLL_SUMMARY),
  useMerchantBillingSummaryByRange: (...args: unknown[]) => billingMock(...args),
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
vi.mock("./RequireBillingAccess", () => ({
  RequireBillingAccess: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import BillingReportPage from "./BillingReportPage";
import { MonthlySalaryStaffReport, PieceRateStaffReport } from "./StaffReportPage";

function renderWithProviders(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

async function clickExport(): Promise<string> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /匯出這份報表為 CSV/ }));
  expect(downloadMock).toHaveBeenCalledTimes(1);
  return downloadMock.mock.calls[0]?.[1] as string;
}

afterEach(() => {
  cleanup();
  downloadMock.mockReset();
});

const VALID = { startDate: "2026-09-01", endDate: "2026-09-30" };

describe("模組 8 CSV 匯出的公式注入防護(#925)", () => {
  it("服務人員報表(抽成制):客戶姓名補單引號,金額負數(number)不動", async () => {
    renderWithProviders(
      <PieceRateStaffReport staffId="s1" staffName="服務人員甲" dateRange={VALID} />,
    );
    const line = (await clickExport()).split("\r\n")[1] ?? "";
    expect(line.startsWith(`2026-10-01,"'=HYPERLINK(""http://evil"")",-300,`)).toBe(true);
    expect(line).toContain(",-30,");
  });

  it("服務人員報表(月薪制):假別名稱補單引號,扣款負數(number)不動", async () => {
    renderWithProviders(
      <MonthlySalaryStaffReport staffId="s1" staffName="服務人員乙" dateRange={VALID} />,
    );
    const line = (await clickExport()).split("\r\n")[1] ?? "";
    expect(line.startsWith("'@病假,1,")).toBe(true);
    expect(line.endsWith(",-1000")).toBe(true);
  });

  it("店家帳務報表:服務人員姓名補單引號;總計區塊的負數淨利(number)不動", async () => {
    billingMock.mockReturnValue(
      okQuery({
        total_revenue_excl_tax: 1000,
        total_tax_amount: 50,
        total_material_cost: 0,
        total_commission_payout: 100,
        total_monthly_salary_base: 30000,
        total_monthly_salary_deduction: 0,
        estimated_net_margin: -29100,
        per_staff_breakdown: [
          {
            staff_id: "s1",
            staff_name: "+886甲",
            compensation_type: "piece_rate",
            order_count: 1,
            net_pay: null,
            commission_amount: 100,
            is_active_as_of: true,
          },
        ],
        salary_estimation_applied: false,
        salary_applicable: true,
        total_points_redeem_amount: 0,
        points_feature_enabled: false,
      }),
    );
    renderWithProviders(<BillingReportPage />);
    const csv = await clickExport();
    const lines = csv.split("\r\n");
    expect(lines.some((l) => l.startsWith("'+886甲,"))).toBe(true);
    expect(lines.some((l) => l.endsWith(",-29100"))).toBe(true);
    expect(csv).not.toContain("'-29100");
  });
});
