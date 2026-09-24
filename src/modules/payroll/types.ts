// 模組 8:薪資與帳務 — 型別定義
// 對應規格書第一節資料表 + 第三節報表函式的回傳形狀。其他模組若需要用到抽成/薪資/帳務相關型別,
// 一律從這個檔案或 api.ts 匯出的 hooks/functions 取得(呼應規格書第五節「對外介面」的模組獨立性
// 設計),不要直接查詢本模組的五張資料表。

import type { Tables } from "@/integrations/supabase/types";

/** §1.1 商家層級薪資設定,一商家一列。商家端三項調整規格書 §二 2.2.2 拿掉了
 * default_commission_rate_percentage 這個欄位的使用(改成服務項目層級抽成),但資料庫欄位本身
 * 是否已經實際 drop 視遷移進度而定,型別上不排除它,前端一律不再讀寫這個欄位。 */
export type MerchantPayrollSettings = Tables<"merchant_payroll_settings">;

/** 商家端三項調整規格書 §二 2.2.1:服務項目層級抽成設定,取代原本一人一個籠統比例的
 * StaffCommissionRate(該表已經 drop)。 */
export type StaffServiceCommissionRate = Tables<"staff_service_commission_rates">;

export type CommissionMode = "percentage" | "fixed_amount";

export const COMMISSION_MODE_LABELS: Record<CommissionMode, string> = {
  percentage: "固定百分比",
  fixed_amount: "固定金額",
};

/** §1.3 月薪制服務人員薪資設定。 */
export type StaffSalarySettings = Tables<"staff_salary_settings">;

/** §1.4 假別扣款規則。 */
export type LeaveTypeDeductionRule = Tables<"leave_type_deduction_rules">;

/** §1.5 抽成快照紀錄。 */
export type BookingCommissionRecord = Tables<"booking_commission_records">;

/** 商家端三項調整規格書 §二 2.2.4:抽成明細快照,附屬在 BookingCommissionRecord 底下。 */
export type BookingCommissionItemRecord = Tables<"booking_commission_item_records">;

export type CommissionBasisType = "gross" | "net_of_material_cost";

export const COMMISSION_BASIS_TYPE_LABELS: Record<CommissionBasisType, string> = {
  gross: "服務金額全額",
  net_of_material_cost: "扣除料錢成本後淨額",
};

export type DeductionMode =
  "no_deduction" | "full_day_rate" | "percentage_of_day_rate" | "fixed_amount_per_day";

export const DEDUCTION_MODE_LABELS: Record<DeductionMode, string> = {
  no_deduction: "不扣款",
  full_day_rate: "扣一天全薪",
  percentage_of_day_rate: "扣一天薪水的某個百分比",
  fixed_amount_per_day: "扣固定金額",
};

/** 商家端三項調整規格書 §二 2.7.5:單一服務項目的抽成明細,展開訂單明細時顯示。 */
export interface StaffCommissionItemBreakdown {
  service_item_name: string;
  quantity: number;
  commission_mode: CommissionMode;
  commission_value: number;
  commission_amount: number;
}

/** 對外介面:把一筆訂單的抽成明細攤平成一行可讀文字,CSV 匯出/畫面展開共用同一套格式(例如
 * 「分離式 x1(20%): 200元; 保養 x2(100元/件): 200元」)。舊制紀錄(item_breakdown 是空陣列,
 * legacy_rate_percentage 有值)顯示「單一比例 X%」,供模組 12(報表匯出中心)/StaffReportPage.tsx
 * 共用,不需要各自重新實作同一套攤平邏輯。 */
export function formatStaffCommissionItemBreakdown(d: {
  item_breakdown: StaffCommissionItemBreakdown[];
  legacy_rate_percentage: number | null;
}): string {
  if (d.item_breakdown.length === 0) {
    return d.legacy_rate_percentage !== null
      ? `單一比例 ${d.legacy_rate_percentage}%`
      : "沒有抽成明細";
  }
  return d.item_breakdown
    .map((item) => {
      const valueLabel =
        item.commission_mode === "percentage"
          ? `${item.commission_value}%`
          : `${item.commission_value}元/件`;
      return `${item.service_item_name} x${item.quantity}(${valueLabel}): ${item.commission_amount}元`;
    })
    .join("; ");
}

/** §3.9 get_staff_commission_summary 回傳形狀(按件計酬師傅報表)。商家端三項調整規格書
 * §二 2.7.5:拿掉單一比例欄位 commission_rate_percentage(服務項目層級抽成之下不再具有單一
 * 比例的意義),改成逐項明細 item_breakdown;legacy_rate_percentage 只有改版前的舊制紀錄
 * (item_breakdown 是空陣列)才會有值,用來顯示「這筆是舊制紀錄,抽成比例 X%」。 */
export interface StaffCommissionSummary {
  details: Array<{
    booking_id: string;
    order_date: string;
    customer_name: string;
    commission_base_amount: number;
    commission_amount: number;
    recalculated: boolean;
    legacy_rate_percentage: number | null;
    item_breakdown: StaffCommissionItemBreakdown[];
  }>;
  total_orders: number;
  total_commission_amount: number;
  assistant_booking_count: number;
  /** 模組 14(服務人員端)v2 §10.4.2:訂單原始總額(sum(bookings.final_amount_snapshot),
   * 未扣抽成前的訂單實收金額加總)。跟 commission_base_amount(抽成計算基準,已先扣折扣、
   * 可能還扣稅金/料錢成本)是不同的數字,不要混為一談。 */
  total_amount: number;
}

/** §3.10 get_staff_monthly_payroll_summary 回傳形狀(月薪制師傅報表,規則 2.8)。§11.7(2026-09-22
 * 新增):monthly_base_salary 改查「該月當時」的歷史值(區間版本改成逐月加總),新增
 * salary_history_estimated——查詢的月份/區間早於機制上線前時為 true(此時金額是用機制上線種子
 * 回推估算,僅供參考);查詢的月份早於這位服務人員實際加入商家的時間點時,金額顯示 0 且這個欄位
 * 是 false(不是估算,是誠實顯示「那時候還沒有這個人」)。 */
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
  salary_history_estimated: boolean;
}

/** §3.11 get_merchant_billing_summary 回傳形狀(店家端帳務報表)。商家端三項調整規格書 §三 3.1:
 * 原本單一的 total_revenue(含稅)拆成 total_revenue_excl_tax(未稅)+ total_tax_amount(稅金)。
 * §三 3.2:estimated_net_margin 改用未稅營收計算(原本誤用含稅營收,虛增這個數字),前端顯示
 * 名稱也從「概估毛利」改成「商家總淨利」,JSON 欄位名稱不變。§11.8(2026-09-22 新增):
 * total_monthly_salary_base 改用歷史資料逐月加總,新增 salary_estimation_applied——查詢區間涵蓋
 * 機制上線前的月份時為 true(僅供參考)。per_staff_breakdown 維持現況,不逐月還原歷史人員名單
 * (§11.9,決策記錄)。
 *
 * 2026-09-24 使用者裁決(月薪只在「選了完整月份」時才計算):新增 salary_applicable,月薪相關的
 * 三個數字改成 `number | null`——salary_applicable=false(自訂區間不是完整月份)時它們一律是
 * **null,不是 0**,呼叫端必須顯示「需選擇完整月份才能計算」而不是顯示 0(顯示 0 會讓商家以為
 * 真的沒有月薪成本)。營收/稅金/料錢/抽成/訂單數不受影響,照常有值。 */
export interface MerchantBillingSummary {
  total_revenue_excl_tax: number;
  total_tax_amount: number;
  total_material_cost: number;
  total_commission_payout: number;
  /** salary_applicable=false 時是 null(不是 0)。 */
  total_monthly_salary_base: number | null;
  /** salary_applicable=false 時是 null(不是 0)。 */
  total_monthly_salary_deduction: number | null;
  /** 商家總淨利。計算式含月薪成本,所以 salary_applicable=false 時也是 null(不是 0)。 */
  estimated_net_margin: number | null;
  per_staff_breakdown: Array<{
    staff_id: string;
    staff_name: string;
    compensation_type: "monthly_salary" | "piece_rate";
    order_count: number;
    /** 月薪制服務人員的月薪淨額。按件計酬的人本來就是 null;月薪制的人在
     * salary_applicable=false 時也是 null。 */
    net_pay: number | null;
    commission_amount: number | null;
    /** 這個人**現在**是否仍在職。false = 現在已離職,但在查詢的那個期間是在職的,所以他的數字
     * 照算、照出現在明細裡。
     *
     * 2026-09-24 使用者裁決(「一樣是留歷史紀錄的概念,即便這個人離職,紀錄還是存在…既然有紀錄
     * 怎麼可能跨月就把紀錄刪除了?」):明細表的在職判斷從「**現在**誰在職」改成「**那個時間點**
     * 誰在職」,跟月薪基本額那一邊的判斷基準對齊。改版前兩邊問的問題不一樣(基本額回頭查歷史、
     * 扣款與明細表只看現在),導致離職人員的當月請假扣款漏掉、整個人也不出現在明細裡,明細加總
     * 跟上方卡片永遠對不起來。
     *
     * ✅ 2026-09-24:資料庫端已上線,這支 RPC 一定會回傳這個欄位,所以型別是必填的 boolean
     * (開發期間曾為了「前端可能先拿到還沒有這個欄位的舊回應」標成 optional 並在呼叫端寫
     * `?? true`,那個過渡防禦已經收掉)。false 時明細列要顯示「已離職」標籤。 */
    is_active_as_of: boolean;
  }>;
  salary_estimation_applied: boolean;
  /** 這次查詢的區間是不是「完整月份」(起始日是某月 1 號 且 結束日是某月最後一天,可跨多月,
   * 例如 2/1~4/30 也算)。按年月查詢的 get_merchant_billing_summary 永遠是完整月份,固定 true。
   *
   * ✅ 2026-09-24:資料庫端已上線,這支 RPC 一定會回傳這個欄位,所以型別是必填的 boolean
   * (開發期間曾為了「前端可能先上線、拿到還沒有這個欄位的舊回應」標成 optional 並在呼叫端寫
   * `?? true`,那個過渡防禦已經收掉)。false 時月薪相關數字一律顯示「需選擇完整月份才能計算」,
   * 不顯示 0。 */
  salary_applicable: boolean;
}
