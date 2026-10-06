// SPECS-INDEX #985 第 8 批 8-9 / 8-10 / 8-11:報表透明化(不改任何既有數字)。
//   ・店家報表「總抽成支出」小字三種情境 + 缺鍵 / 沒有抽成紀錄不顯示
//   ・店家報表 CSV:兩列資訊列一律接在最尾端,既有 8 列(+ 紅利那 1 列)順序與值完全不變
//   ・服務人員報表:畫面「扣除料錢」0 顯示「—」、CSV 在「抽成基準」左邊加欄(0 輸出 0)
//   ・服務人員報表頁真的 render、真的按匯出:欄位位置正確

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { downloadMock } = vi.hoisted(() => ({ downloadMock: vi.fn() }));

vi.mock("./csvExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./csvExport")>();
  return { ...actual, downloadCsv: downloadMock };
});

const COMMISSION_SUMMARY = {
  details: [
    {
      booking_id: "b1",
      completion_date: "2026-10-01",
      customer_name: "林小姐",
      commission_base_amount: 2500,
      material_cost_deducted: 500,
      commission_amount: 1000,
      recalculated: false,
      legacy_rate_percentage: null,
      item_breakdown: [],
    },
    {
      booking_id: "b2",
      completion_date: "2026-10-02",
      customer_name: "王先生",
      commission_base_amount: 3000,
      material_cost_deducted: 0,
      commission_amount: 1200,
      recalculated: false,
      legacy_rate_percentage: null,
      item_breakdown: [],
    },
  ],
  total_orders: 2,
  total_commission_amount: 2200,
  assistant_booking_count: 0,
  total_amount: 6000,
};

const okQuery = (data: unknown) => ({ data, isLoading: false, error: null, refetch: vi.fn() });

vi.mock("./api", () => ({
  useStaffCommissionSummary: () => okQuery(COMMISSION_SUMMARY),
  useStaffMonthlyPayrollSummary: () => okQuery(undefined),
  useStaffCommissionSummaryByRange: () => okQuery(COMMISSION_SUMMARY),
  useStaffMonthlyPayrollSummaryByRange: () => okQuery(undefined),
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

import {
  BILLING_SUMMARY_LABELS,
  COMMISSION_MATERIAL_CSV_LABELS,
  NET_MARGIN_MATERIAL_COST_HELP,
  buildBillingCsvSummaryItems,
  commissionMaterialNoteText,
  type BillingCsvSummaryFields,
} from "./billingReportDisplay";
import {
  MATERIAL_COST_DEDUCTED_LABEL,
  materialCostDeductedCsvValue,
  materialCostDeductedText,
} from "./materialCostDeductedDisplay";
import { PieceRateStaffReport } from "./StaffReportPage";

afterEach(() => {
  cleanup();
  downloadMock.mockReset();
});

function fields(overrides: Partial<BillingCsvSummaryFields> = {}): BillingCsvSummaryFields {
  return {
    total_revenue_excl_tax: 2000,
    total_tax_amount: 100,
    total_material_cost: 500,
    total_commission_payout: 1000,
    salary_applicable: true,
    total_monthly_salary_base: 30000,
    total_monthly_salary_deduction: 0,
    estimated_net_margin: -29500,
    points_feature_enabled: false,
    total_points_redeem_amount: 0,
    ...overrides,
  };
}

describe("店家報表 總抽成支出小字(8-9)", () => {
  it("全部扣 / 全部沒扣 / 混合 三種說法", () => {
    expect(
      commissionMaterialNoteText({
        commission_orders_material_deducted_count: 3,
        commission_orders_material_not_deducted_count: 0,
      }),
    ).toBe("這段期間的抽成都已先扣料錢再算。");
    expect(
      commissionMaterialNoteText({
        commission_orders_material_deducted_count: 0,
        commission_orders_material_not_deducted_count: 2,
      }),
    ).toBe("這段期間的抽成都沒有扣料錢。");
    expect(
      commissionMaterialNoteText({
        commission_orders_material_deducted_count: 3,
        commission_orders_material_not_deducted_count: 2,
      }),
    ).toBe("這段期間有 3 筆抽成先扣料錢、2 筆沒有扣（期間中切換過設定）。");
  });

  it("沒有任何抽成紀錄、或舊資料庫沒有這兩個 key ⇒ 不顯示", () => {
    expect(
      commissionMaterialNoteText({
        commission_orders_material_deducted_count: 0,
        commission_orders_material_not_deducted_count: 0,
      }),
    ).toBeNull();
    expect(commissionMaterialNoteText({})).toBeNull();
    expect(commissionMaterialNoteText(undefined)).toBeNull();
  });

  it("商家總淨利 `?` 補充句:料錢一律店家成本", () => {
    expect(NET_MARGIN_MATERIAL_COST_HELP).toContain("料錢一律算店家成本");
  });
});

describe("店家報表 CSV 尾端兩列(8-10)", () => {
  const BASE_LABELS = [
    "總營收(未稅)",
    "稅金小計",
    "總料錢成本",
    "總抽成支出",
    "月薪基本額合計",
    "月薪扣款合計",
    "月薪實發合計",
    "商家總淨利",
  ];

  it("有計數 ⇒ 既有 8 列順序與值不變,兩列接在最後", () => {
    const before = buildBillingCsvSummaryItems(fields());
    const after = buildBillingCsvSummaryItems(
      fields({
        commission_orders_material_deducted_count: 3,
        commission_orders_material_not_deducted_count: 2,
      }),
    );
    expect(before.map((i) => i.label)).toEqual(BASE_LABELS);
    expect(after.slice(0, 8)).toEqual(before);
    expect(after.slice(8)).toEqual([
      { label: COMMISSION_MATERIAL_CSV_LABELS.deducted, value: 3 },
      { label: COMMISSION_MATERIAL_CSV_LABELS.notDeducted, value: 2 },
    ]);
  });

  it("紅利那一列出現時,兩列接在紅利後面", () => {
    const after = buildBillingCsvSummaryItems(
      fields({
        points_feature_enabled: true,
        total_points_redeem_amount: 35,
        commission_orders_material_deducted_count: 0,
        commission_orders_material_not_deducted_count: 4,
      }),
    );
    expect(after.map((i) => i.label)).toEqual([
      ...BASE_LABELS,
      BILLING_SUMMARY_LABELS.pointsRedeemAmount,
      COMMISSION_MATERIAL_CSV_LABELS.deducted,
      COMMISSION_MATERIAL_CSV_LABELS.notDeducted,
    ]);
    expect(after[10]).toEqual({ label: COMMISSION_MATERIAL_CSV_LABELS.notDeducted, value: 4 });
  });

  it("舊資料庫沒有計數 key ⇒ 不加列", () => {
    expect(buildBillingCsvSummaryItems(fields())).toHaveLength(8);
  });
});

describe("服務人員報表 扣除料錢(8-11)", () => {
  it("畫面:0 或缺鍵 ⇒「—」;有扣 ⇒ 金額", () => {
    expect(materialCostDeductedText({ material_cost_deducted: 0 })).toBe("—");
    expect(materialCostDeductedText({})).toBe("—");
    expect(materialCostDeductedText({ material_cost_deducted: 500 })).toBe("$500");
  });

  it("CSV:0 輸出 0;缺鍵輸出空白(不猜)", () => {
    expect(materialCostDeductedCsvValue({ material_cost_deducted: 0 })).toBe(0);
    expect(materialCostDeductedCsvValue({ material_cost_deducted: 500 })).toBe(500);
    expect(materialCostDeductedCsvValue({})).toBe("");
  });

  it("服務人員報表頁:每筆顯示扣除料錢;CSV 欄位在「抽成基準」左邊", async () => {
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <PieceRateStaffReport
            staffId="s1"
            staffName="服務人員甲"
            dateRange={{ startDate: "2026-10-01", endDate: "2026-10-31" }}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getAllByText(MATERIAL_COST_DEDUCTED_LABEL)).toHaveLength(2);
    expect(screen.getByText("$500")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /匯出這份報表為 CSV/ }));
    const csv = downloadMock.mock.calls[0]?.[1] as string;
    const lines = csv.replace(new RegExp("^" + String.fromCharCode(0xfeff)), "").split("\r\n");
    expect(lines[0]).toBe("完成日期,客戶,扣除料錢,抽成基準,服務項目明細,抽成金額,已被人工重算");
    expect(lines[1]?.startsWith("2026-10-01,林小姐,500,2500,")).toBe(true);
    expect(lines[2]?.startsWith("2026-10-02,王先生,0,3000,")).toBe(true);
  });
});
