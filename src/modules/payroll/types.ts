// 模組 8:薪資與帳務 — 型別定義
// 對應規格書第一節資料表 + 第三節報表函式的回傳形狀。其他模組若需要用到抽成/薪資/帳務相關型別,
// 一律從這個檔案或 api.ts 匯出的 hooks/functions 取得(呼應規格書第五節「對外介面」的模組獨立性
// 設計),不要直接查詢本模組的五張資料表。

import type { Tables } from "@/integrations/supabase/types";

/** §1.1 商家層級薪資設定,一商家一列。 */
export type MerchantPayrollSettings = Tables<"merchant_payroll_settings">;

/** §1.2 按件計酬服務人員個人抽成比例覆寫。 */
export type StaffCommissionRate = Tables<"staff_commission_rates">;

/** §1.3 月薪制服務人員薪資設定。 */
export type StaffSalarySettings = Tables<"staff_salary_settings">;

/** §1.4 假別扣款規則。 */
export type LeaveTypeDeductionRule = Tables<"leave_type_deduction_rules">;

/** §1.5 抽成快照紀錄。 */
export type BookingCommissionRecord = Tables<"booking_commission_records">;

export type CommissionBasisType = "gross" | "net_of_material_cost";

export const COMMISSION_BASIS_TYPE_LABELS: Record<CommissionBasisType, string> = {
  gross: "服務金額全額",
  net_of_material_cost: "扣除料錢成本後淨額",
};

export type DeductionMode =
  | "no_deduction"
  | "full_day_rate"
  | "percentage_of_day_rate"
  | "fixed_amount_per_day";

export const DEDUCTION_MODE_LABELS: Record<DeductionMode, string> = {
  no_deduction: "不扣款",
  full_day_rate: "扣一天全薪",
  percentage_of_day_rate: "扣一天薪水的某個百分比",
  fixed_amount_per_day: "扣固定金額",
};

/** §3.9 get_staff_commission_summary 回傳形狀(按件計酬師傅報表)。 */
export interface StaffCommissionSummary {
  details: Array<{
    booking_id: string;
    order_date: string;
    customer_name: string;
    commission_base_amount: number;
    commission_rate_percentage: number;
    commission_amount: number;
    recalculated: boolean;
  }>;
  total_orders: number;
  total_commission_amount: number;
  assistant_booking_count: number;
}

/** §3.10 get_staff_monthly_payroll_summary 回傳形狀(月薪制師傅報表,規則 2.8)。 */
export interface StaffMonthlyPayrollSummary {
  monthly_base_salary: number;
  details: Array<{
    leave_type_id: string;
    leave_type_name: string;
    days: number;
    deduction_mode: DeductionMode;
    deduction_amount: number;
  }>;
  total_deduction_amount: number;
  net_pay: number;
  over_deduction_warning: boolean;
  monthly_leave_quota_days: number | null;
  total_leave_days: number;
}

/** §3.11 get_merchant_billing_summary 回傳形狀(店家端帳務報表)。 */
export interface MerchantBillingSummary {
  total_revenue: number;
  total_material_cost: number;
  total_commission_payout: number;
  total_monthly_salary_base: number;
  total_monthly_salary_deduction: number;
  estimated_net_margin: number;
  per_staff_breakdown: Array<{
    staff_id: string;
    staff_name: string;
    compensation_type: "monthly_salary" | "piece_rate";
    order_count: number;
    net_pay: number | null;
    commission_amount: number | null;
  }>;
}
