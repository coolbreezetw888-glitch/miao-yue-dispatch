// SPECS-INDEX #925 整合測試:報表匯出中心四份 CSV(訂單 / 會員 / 抽成 / 請假)都經過共用的
// 公式注入防護(src/lib/csv.ts escapeCsvCell)。真的渲染頁面、真的按「匯出 CSV」,攔下要下載的
// 內容來檢查;buildCsvContent 用的是真的那一支,只把 downloadCsv(瀏覽器下載)換成替身。
//
// 【故障注入】拿掉 neutralizeCsvFormula 的判斷 → 本檔四條全部轉紅。
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { downloadMock } = vi.hoisted(() => ({ downloadMock: vi.fn() }));

vi.mock("@/lib/csv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/csv")>();
  return { ...actual, downloadCsv: downloadMock };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./RequireReportExportAccess", () => ({
  RequireReportExportAccess: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({ merchant: { id: "m1", name: "測試商家" }, isLoading: false }),
}));
vi.mock("@/modules/staff-agent/context", () => ({
  useMerchantStaffList: () => ({ data: [{ id: "s1", name: "=服務人員" }], isLoading: false }),
}));
vi.mock("@/modules/booking/api", () => ({
  fetchMerchantBookings: vi.fn(async () => [
    {
      id: "b1",
      customer_name: '=HYPERLINK("http://evil","點我")',
      customer_phone: "+886912345678",
      start_at: "2026-10-01T10:00:00+08:00",
      status: "completed",
      final_amount_snapshot: -100,
      source: "@line",
    },
  ]),
}));
vi.mock("@/modules/members/api", () => ({
  fetchMerchantMembersList: vi.fn(async () => [
    {
      name: "-2+3",
      phone: "0912345678",
      referralCode: "@ref",
      pointsBalance: -5,
      status: "active",
      identityVerifiedAt: null,
    },
  ]),
}));
vi.mock("@/modules/payroll/api", () => ({
  fetchStaffCommissionSummary: vi.fn(async () => ({
    details: [
      {
        booking_id: "b1",
        completion_date: "2026-10-01",
        customer_name: "\t=cmd",
        commission_base_amount: -300,
        item_breakdown: [],
        legacy_rate_percentage: null,
        commission_amount: -30,
      },
    ],
  })),
}));
vi.mock("@/modules/scheduling/api", () => ({
  fetchStaffLeaveRecords: vi.fn(async () => [
    {
      staff_id: "s1",
      leave_type_id: "t1",
      start_date: "2026-10-01",
      end_date: "2026-10-02",
      status: "approved",
      notes: "=1+1,有逗號",
    },
  ]),
  fetchMerchantLeaveTypesAll: vi.fn(async () => [{ id: "t1", name: "+特休" }]),
}));

import ReportExportCenterPage from "./ReportExportCenterPage";

afterEach(() => {
  cleanup();
  downloadMock.mockReset();
});

async function exportOn(tabLabel: string): Promise<string> {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <ReportExportCenterPage />
    </MemoryRouter>,
  );
  if (tabLabel !== "訂單") {
    await user.click(screen.getByRole("tab", { name: tabLabel }));
  }
  await user.click(screen.getByRole("button", { name: "匯出 CSV" }));
  await waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(1));
  return downloadMock.mock.calls[0]?.[1] as string;
}

describe("報表匯出中心 CSV 公式注入防護(#925)", () => {
  it("訂單報表:客戶姓名 / 電話 / 來源補單引號;金額負數(number)不動", async () => {
    const csv = await exportOn("訂單");
    const line = csv.split("\r\n")[1] ?? "";
    expect(line).toContain(`"'=HYPERLINK(""http://evil"",""點我"")"`);
    expect(line).toContain(",'+886912345678,");
    expect(line).toContain(",-100,");
    expect(line.endsWith(",'@line")).toBe(true);
  });

  it("會員報表:姓名 / 推薦碼補單引號;點數負數(number)不動", async () => {
    const csv = await exportOn("會員");
    const line = csv.split("\r\n")[1] ?? "";
    expect(line.startsWith("'-2+3,0912345678,'@ref,-5,")).toBe(true);
  });

  it("抽成報表:服務人員姓名 / 客戶姓名(Tab 開頭)補單引號;金額負數不動", async () => {
    const csv = await exportOn("抽成");
    const line = csv.split("\r\n")[1] ?? "";
    expect(line.startsWith("'=服務人員,b1,2026-10-01,'\t=cmd,-300,")).toBe(true);
    expect(line.endsWith(",-30")).toBe(true);
  });

  it("請假報表:服務人員 / 假別 / 備註補單引號(備註含逗號仍正確包雙引號)", async () => {
    const csv = await exportOn("請假");
    const line = csv.split("\r\n")[1] ?? "";
    expect(line).toBe(`'=服務人員,'+特休,2026-10-01,2026-10-02,approved,"'=1+1,有逗號"`);
  });
});
