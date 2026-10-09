// #1035 追加(使用者 2026-10-09 選 B):服務人員端「我的薪資報表」預設區間。
//   ・目前月薪制、上個月(月底當時)有獎金方案 ⇒ 上個月整月、按月份(主腦 2026-10-09 裁決)
//   ・沒有方案 / 只有本月才剛有方案 / 不是月薪制 / 查詢失敗 ⇒ 照舊(本月 1 號到今天、按日期)
//     「只有本月才有方案」= 查上個月整月得到 has_any_plan false,跟「沒有方案」走同一條路
//   ・還在查「有沒有方案」時只顯示骨架,不先畫本月再跳上個月

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bonusPlanProbeRange,
  myPayrollInitialRange,
  shouldProbeBonusPlan,
} from "./myPayrollDefaultRange";

const { staffRowMock, bonusProbeMock } = vi.hoisted(() => ({
  staffRowMock: vi.fn(),
  bonusProbeMock: vi.fn(),
}));

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({ merchant: { id: "m-1" } }),
}));
vi.mock("./context", () => ({
  useActiveMyStaffRecord: () => ({ data: staffRowMock() }),
}));
vi.mock("./RequireStaffPayrollAccess", () => ({
  RequireStaffPayrollAccess: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/modules/payroll/api", () => ({
  useStaffBonusByRange: (
    staffId: string | null,
    start: string,
    end: string,
    options?: { retry?: boolean },
  ) => bonusProbeMock(staffId, start, end, options),
}));
function StubReport({ dateRange }: { dateRange: { startDate: string; endDate: string } }) {
  return <div data-testid="report-range">{`${dateRange.startDate}~${dateRange.endDate}`}</div>;
}
vi.mock("@/modules/payroll/StaffReportPage", () => ({
  MonthlySalaryStaffReport: StubReport,
  PieceRateStaffReport: StubReport,
}));
vi.mock("@/modules/payroll/WageStaffReport", () => ({ WageStaffReport: StubReport }));

import MyPayrollPage from "./MyPayrollPage";

// 2026-10-09(四)台北中午;月中、跨年都另外測。
const NOW = new Date(2026, 9, 9, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  staffRowMock.mockReset();
  bonusProbeMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("純函式", () => {
  it("probe 區間 = 上個月整月(只看上個月,不含本月);1 月時是前一年 12 月", () => {
    expect(bonusPlanProbeRange()).toEqual({ startDate: "2026-09-01", endDate: "2026-09-30" });
    vi.setSystemTime(new Date(2027, 0, 15, 9, 0, 0));
    expect(bonusPlanProbeRange()).toEqual({ startDate: "2026-12-01", endDate: "2026-12-31" });
  });

  it("只有月薪制要查", () => {
    expect(shouldProbeBonusPlan("monthly_salary")).toBe(true);
    expect(shouldProbeBonusPlan("piece_rate")).toBe(false);
    expect(shouldProbeBonusPlan("daily_wage")).toBe(false);
    expect(shouldProbeBonusPlan("hourly_wage")).toBe(false);
    expect(shouldProbeBonusPlan(undefined)).toBe(false);
  });

  it("月薪制 + 有方案 ⇒ 上個月整月、按月份", () => {
    expect(
      myPayrollInitialRange({ compensationType: "monthly_salary", hasBonusPlan: true }),
    ).toEqual({
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      granularity: "month",
    });
  });

  it("沒有方案、或不是月薪制 ⇒ 照舊:本月 1 號到今天、按日期", () => {
    const unchanged = { startDate: "2026-10-01", endDate: "2026-10-09", granularity: "day" };
    expect(
      myPayrollInitialRange({ compensationType: "monthly_salary", hasBonusPlan: false }),
    ).toEqual(unchanged);
    expect(myPayrollInitialRange({ compensationType: "piece_rate", hasBonusPlan: true })).toEqual(
      unchanged,
    );
    expect(myPayrollInitialRange({ compensationType: "daily_wage", hasBonusPlan: true })).toEqual(
      unchanged,
    );
  });

  it("1 月有方案 ⇒ 前一年 12 月整月", () => {
    vi.setSystemTime(new Date(2027, 0, 5, 9, 0, 0));
    expect(
      myPayrollInitialRange({ compensationType: "monthly_salary", hasBonusPlan: true }),
    ).toEqual({
      startDate: "2026-12-01",
      endDate: "2026-12-31",
      granularity: "month",
    });
  });
});

const monthly = { id: "s-1", name: "小明", compensation_type: "monthly_salary" };

function chipChecked(name: string) {
  return screen.getByRole("radio", { name }).getAttribute("aria-checked");
}

describe("MyPayrollPage 預設區間", () => {
  it("月薪制、有方案 ⇒ 一進來就是上個月整月 + 按月份", () => {
    staffRowMock.mockReturnValue(monthly);
    bonusProbeMock.mockReturnValue({
      isSuccess: true,
      isError: false,
      data: { has_any_plan: true },
    });
    render(<MyPayrollPage />);
    expect(bonusProbeMock).toHaveBeenCalledWith("s-1", "2026-09-01", "2026-09-30", {
      retry: false,
    });
    expect(screen.getByTestId("report-range")).toHaveTextContent("2026-09-01~2026-09-30");
    expect(chipChecked("按月份")).toBe("true");
    expect((document.getElementById("date-range-start") as HTMLInputElement).value).toBe("2026-09");
    expect((document.getElementById("date-range-end") as HTMLInputElement).value).toBe("2026-09");
  });

  it("月薪制、上個月沒有方案(沒有方案或本月才剛有)⇒ 照舊(本月 1 號到今天、按日期)", () => {
    staffRowMock.mockReturnValue(monthly);
    bonusProbeMock.mockReturnValue({
      isSuccess: true,
      isError: false,
      data: { has_any_plan: false },
    });
    render(<MyPayrollPage />);
    expect(screen.getByTestId("report-range")).toHaveTextContent("2026-10-01~2026-10-09");
    expect(chipChecked("按日期")).toBe("true");
    expect((document.getElementById("date-range-start") as HTMLInputElement).value).toBe(
      "2026-10-01",
    );
  });

  it("抽成制 ⇒ 不查方案(staffId 傳 null)、照舊", () => {
    staffRowMock.mockReturnValue({ ...monthly, compensation_type: "piece_rate" });
    bonusProbeMock.mockReturnValue({ isSuccess: false, isError: false, data: undefined });
    render(<MyPayrollPage />);
    expect(bonusProbeMock).toHaveBeenCalledWith(null, "2026-09-01", "2026-09-30", {
      retry: false,
    });
    expect(screen.getByTestId("report-range")).toHaveTextContent("2026-10-01~2026-10-09");
    expect(chipChecked("按日期")).toBe("true");
  });

  it("查詢失敗 ⇒ 當沒有方案,照舊顯示", () => {
    staffRowMock.mockReturnValue(monthly);
    bonusProbeMock.mockReturnValue({ isSuccess: false, isError: true, data: undefined });
    render(<MyPayrollPage />);
    expect(screen.getByTestId("report-range")).toHaveTextContent("2026-10-01~2026-10-09");
  });

  it("還在查 ⇒ 只顯示骨架,不先畫區間篩選與報表", () => {
    staffRowMock.mockReturnValue(monthly);
    bonusProbeMock.mockReturnValue({ isSuccess: false, isError: false, data: undefined });
    render(<MyPayrollPage />);
    expect(screen.queryByTestId("report-range")).toBeNull();
    expect(screen.queryByRole("radio", { name: "按日期" })).toBeNull();
  });
});
