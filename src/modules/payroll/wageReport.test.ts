// #1035 彈性計薪 B 批(日薪／時薪制)— 前端純函式
//   PT(vitest):COMPENSATION_TYPE_LABELS 四種;報表卡片顯示條件(wage_feature_used);工資時數格式「37 小時 20 分」;
//   時薪小計算機「2 小時 20 分 × 200 = 467」;CSV 新欄位與注入防護;canToggleSlots 日薪／時薪為 false;
//   沒用到日薪／時薪的店,CSV 總計區塊與淨利說明跟改版前一字不差。
import { describe, expect, it } from "vitest";

import { resolveStaffOrderAbility } from "@/modules/staff-portal/staffOrderLogic";
import {
  STAFF_COMPENSATION_TYPE_LABELS,
  STAFF_COMPENSATION_TYPE_OPTIONS,
  isWageCompensationType,
} from "@/modules/staff-agent/types";

import {
  BILLING_SUMMARY_LABELS,
  NET_MARGIN_BONUS_HELP,
  NET_MARGIN_MATERIAL_COST_HELP,
  NET_MARGIN_WAGE_HELP,
  buildBillingCsvSummaryItems,
  commissionCsvCell,
  extraWageCellText,
  isWageRow,
  netMarginFormulaText,
  netMarginHelpText,
  shouldShowWagePayout,
  wageCellText,
  wageCsvCell,
  workedHoursCsvCell,
  type BillingCsvSummaryFields,
  type StaffBreakdownRow,
} from "./billingReportDisplay";
import { buildCsvContentFromRows } from "./csvExport";
import type { StaffWageDay } from "./types";
import {
  HOURLY_PREVIEW_EXAMPLE_MINUTES,
  computeHourlyPay,
  formatWageDayLabel,
  formatWorkedMinutes,
  hourlyPreviewText,
  isWageTypeSwitch,
  wageDayDetailText,
  wageRateSummaryText,
  wageUnitLabel,
} from "./wageLogic";

function row(overrides: Partial<StaffBreakdownRow> = {}): StaffBreakdownRow {
  return {
    staff_id: "s-1",
    staff_name: "時薪阿惠",
    compensation_type: "hourly_wage",
    order_count: 3,
    net_pay: null,
    commission_amount: null,
    bonus_amount: null,
    wage_amount: 11160,
    worked_minutes: 3720,
    work_days: 31,
    wage_missing: false,
    is_active_as_of: true,
    ...overrides,
  };
}

const BASE_SUMMARY: BillingCsvSummaryFields = {
  total_revenue_excl_tax: 50000,
  total_tax_amount: 0,
  total_material_cost: 0,
  total_commission_payout: 0,
  salary_applicable: true,
  total_monthly_salary_base: 30000,
  total_monthly_salary_deduction: 0,
  estimated_net_margin: 20000,
  points_feature_enabled: false,
  total_points_redeem_amount: 0,
};

function day(overrides: Partial<StaffWageDay> = {}): StaffWageDay {
  return {
    date: "2026-03-02",
    compensation_type: "hourly_wage",
    wage_amount: 200,
    shift_minutes: 210,
    extra_booking_minutes: 90,
    worked_minutes: 300,
    is_leave: false,
    leave_type_name: null,
    pay_amount: 1000,
    state: "settled",
    ...overrides,
  };
}

describe("計酬類型四種(PB-D01 / PB-U01)", () => {
  it("中文名稱:抽成制、月薪制、日薪制、時薪制;下拉順序照規格", () => {
    expect(STAFF_COMPENSATION_TYPE_OPTIONS).toEqual([
      "piece_rate",
      "monthly_salary",
      "daily_wage",
      "hourly_wage",
    ]);
    expect(STAFF_COMPENSATION_TYPE_OPTIONS.map((t) => STAFF_COMPENSATION_TYPE_LABELS[t])).toEqual([
      "抽成制",
      "月薪制",
      "日薪制",
      "時薪制",
    ]);
  });
  it("isWageCompensationType 只認日薪／時薪", () => {
    expect(isWageCompensationType("daily_wage")).toBe(true);
    expect(isWageCompensationType("hourly_wage")).toBe(true);
    expect(isWageCompensationType("monthly_salary")).toBe(false);
    expect(isWageCompensationType("piece_rate")).toBe(false);
    expect(isWageCompensationType(null)).toBe(false);
  });
  it("日薪↔時薪互換才提醒「請確認金額」", () => {
    expect(isWageTypeSwitch("daily_wage", "hourly_wage")).toBe(true);
    expect(isWageTypeSwitch("hourly_wage", "daily_wage")).toBe(true);
    expect(isWageTypeSwitch("piece_rate", "hourly_wage")).toBe(false);
    expect(isWageTypeSwitch("daily_wage", "daily_wage")).toBe(false);
  });
});

describe("時數格式與小計算機(PB-B02 / PB-U02)", () => {
  it("formatWorkedMinutes", () => {
    expect(formatWorkedMinutes(2240)).toBe("37 小時 20 分");
    expect(formatWorkedMinutes(180)).toBe("3 小時");
    expect(formatWorkedMinutes(45)).toBe("45 分");
    expect(formatWorkedMinutes(0)).toBe("0 分");
    expect(formatWorkedMinutes(null)).toBe("0 分");
  });
  it("時薪 200 × 2 小時 20 分 = 467(四捨五入,跟資料庫同一條算式)", () => {
    expect(HOURLY_PREVIEW_EXAMPLE_MINUTES).toBe(140);
    expect(computeHourlyPay(140, 200)).toBe(467);
    expect(hourlyPreviewText(200, 140)).toBe("時薪 200 元 × 2 小時 20 分 = 467 元");
    expect(computeHourlyPay(0, 200)).toBe(0);
    expect(computeHourlyPay(60, 0)).toBe(0);
  });
  it("金額單位", () => {
    expect(wageUnitLabel("daily_wage")).toBe("元／天");
    expect(wageUnitLabel("hourly_wage")).toBe("元／小時");
  });
});

describe("服務人員報表文字(WageStaffReport)", () => {
  it("費率說明:日薪 × 天數;時薪只寫時薪;費率中途改過要註明", () => {
    expect(
      wageRateSummaryText({
        days: [day({ compensation_type: "daily_wage", wage_amount: 1500 })],
        work_days: 12,
      }),
    ).toBe("日薪 1,500 元 × 12 天");
    expect(wageRateSummaryText({ days: [day()], work_days: 1 })).toBe("時薪 200 元");
    expect(
      wageRateSummaryText({
        days: [day({ wage_amount: 180 }), day({ wage_amount: 200 })],
        work_days: 2,
      }),
    ).toBe("時薪 200 元（以最後一天的金額顯示）");
    expect(wageRateSummaryText({ days: [], work_days: 0 })).toBeNull();
  });
  it("每天明細說明:時段 / 時段外訂單 / 合計;請假顯示假別", () => {
    expect(wageDayDetailText(day())).toBe(
      "時段 3 小時 30 分 ・ 時段外訂單 1 小時 30 分 ・ 合計 5 小時",
    );
    expect(wageDayDetailText(day({ extra_booking_minutes: 0, worked_minutes: 210 }))).toBe(
      "時段 3 小時 30 分 ・ 合計 3 小時 30 分",
    );
    expect(wageDayDetailText(day({ is_leave: true, leave_type_name: "事假" }))).toBe(
      "請假（事假）",
    );
  });
  it("日期標籤帶星期", () => {
    expect(formatWageDayLabel("2026-03-02")).toBe("3/2（一）");
  });
});

describe("店家報表(PB-B02)", () => {
  it("「日薪／時薪支出」只看 wage_feature_used;缺 key / 載入中 ⇒ 不顯示", () => {
    expect(shouldShowWagePayout({ wage_feature_used: true })).toBe(true);
    expect(shouldShowWagePayout({ wage_feature_used: false })).toBe(false);
    expect(shouldShowWagePayout({})).toBe(false);
    expect(shouldShowWagePayout(undefined)).toBe(false);
  });

  it("沒有日薪／時薪人員的店:CSV 總計區塊一字不差(不多一列)", () => {
    const before = buildBillingCsvSummaryItems(BASE_SUMMARY);
    const after = buildBillingCsvSummaryItems({
      ...BASE_SUMMARY,
      wage_feature_used: false,
      total_wage_payout: 0,
    });
    expect(after).toEqual(before);
    expect(after.some((i) => i.label === BILLING_SUMMARY_LABELS.wagePayout)).toBe(false);
  });

  it("有日薪／時薪人員:總計區塊最後多一列「日薪／時薪支出」(不完整月份也有值)", () => {
    const items = buildBillingCsvSummaryItems({
      ...BASE_SUMMARY,
      salary_applicable: false,
      wage_feature_used: true,
      total_wage_payout: 3120,
    });
    expect(items[items.length - 1]).toEqual({ label: "日薪／時薪支出", value: 3120 });
  });

  it("淨利說明與算式:沒用到新功能的店 = 改版前原字串", () => {
    expect(netMarginHelpText(false, false)).toBe(NET_MARGIN_MATERIAL_COST_HELP);
    expect(netMarginHelpText(true, false)).toBe(
      `${NET_MARGIN_MATERIAL_COST_HELP}${NET_MARGIN_BONUS_HELP}`,
    );
    expect(netMarginHelpText(false, true)).toBe(
      `${NET_MARGIN_MATERIAL_COST_HELP}${NET_MARGIN_WAGE_HELP}`,
    );
    expect(netMarginFormulaText(false, false)).toBe(
      "總營收(未稅)− 總料錢成本 − 總抽成支出 −(月薪基本額合計 − 月薪扣款合計)。",
    );
    expect(netMarginFormulaText(true, false)).toBe(
      "總營收(未稅)− 總料錢成本 − 總抽成支出 −(月薪基本額合計 − 月薪扣款合計)− 月薪獎金。",
    );
    expect(netMarginFormulaText(true, true)).toBe(
      "總營收(未稅)− 總料錢成本 − 總抽成支出 −(月薪基本額合計 − 月薪扣款合計)− 月薪獎金 − 日薪／時薪支出。",
    );
    expect(netMarginFormulaText(false, true)).toBe(
      "總營收(未稅)− 總料錢成本 − 總抽成支出 −(月薪基本額合計 − 月薪扣款合計)− 日薪／時薪支出。",
    );
  });

  it("明細列 / CSV 儲存格:日薪／時薪列帶工資與時數、抽成欄空白;其他列工資欄空白、抽成照舊", () => {
    const wageRow = row();
    expect(isWageRow(wageRow)).toBe(true);
    expect(wageCellText(wageRow)).toBe("工資 11,160 元（上工 62 小時）");
    expect(wageCsvCell(wageRow)).toBe(11160);
    expect(workedHoursCsvCell(wageRow)).toBe("62 小時");
    expect(commissionCsvCell(wageRow)).toBe("");

    const pieceRow = row({
      compensation_type: "piece_rate",
      commission_amount: null,
      wage_amount: null,
    });
    expect(isWageRow(pieceRow)).toBe(false);
    expect(wageCsvCell(pieceRow)).toBe("");
    expect(workedHoursCsvCell(pieceRow)).toBe("");
    expect(commissionCsvCell(pieceRow)).toBe(0);
  });

  it("CSV 注入防護:日薪／時薪人員姓名以 = 開頭照樣被跳脫", () => {
    const content = buildCsvContentFromRows([
      [row({ staff_name: "=1+1" }).staff_name, 11160, "62 小時"],
    ]);
    expect(content).not.toMatch(/(^|,)=1\+1/m);
    expect(content).toContain("1+1");
  });
});

describe("主腦裁決 M1:中途改制的人,月薪 / 抽成列多帶工資", () => {
  it("月薪列帶 wage_amount ⇒ 畫面多一段工資文字、CSV 工資 / 時數有值;抽成欄照舊", () => {
    const switched = row({
      compensation_type: "monthly_salary",
      net_pay: 0,
      wage_amount: 3240,
      worked_minutes: 1080,
    });
    expect(extraWageCellText(switched)).toBe("工資 3,240 元（上工 18 小時）");
    expect(wageCsvCell(switched)).toBe(3240);
    expect(workedHoursCsvCell(switched)).toBe("18 小時");
    expect(commissionCsvCell(switched)).toBe(0);
  });
  it("沒有工資 key 的月薪 / 抽成列 ⇒ 不多任何文字(沒用到日薪／時薪的店一字不差)", () => {
    const plain = { compensation_type: "monthly_salary" as const };
    expect(extraWageCellText(plain)).toBeNull();
    expect(wageCsvCell(plain)).toBe("");
    expect(workedHoursCsvCell(plain)).toBe("");
  });
  it("日薪／時薪列本身不重複接一段", () => {
    expect(extraWageCellText(row())).toBeNull();
  });
});

describe("Q4 = A:日薪／時薪不能自己開關時段(PB-U04)", () => {
  it("canToggleSlots:日薪／時薪即使開了新增編輯訂單與排班自助權限也是 false", () => {
    for (const compensation_type of ["daily_wage", "hourly_wage"]) {
      expect(
        resolveStaffOrderAbility({
          staffRow: { can_create_edit_orders: true, show_member_info: true, compensation_type },
          hasCalendarView: true,
          hasSelfManageAvailability: true,
          hasOrderEditingFeature: true,
        }),
      ).toEqual({ canEditOrders: true, canToggleSlots: false });
    }
  });
});
