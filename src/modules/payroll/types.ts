// 模組 8:薪資與帳務 — 型別定義
// 對應規格書第一節資料表 + 第三節報表函式的回傳形狀。其他模組若需要用到抽成/薪資/帳務相關型別,
// 一律從這個檔案或 api.ts 匯出的 hooks/functions 取得(呼應規格書第五節「對外介面」的模組獨立性
// 設計),不要直接查詢本模組的五張資料表。

import type { Tables } from "@/integrations/supabase/types";
import type { StaffCompensationType } from "@/modules/staff-agent/types";

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

/** §3.9 get_staff_commission_summary 回傳形狀(抽成制服務人員報表)。商家端三項調整規格書
 * §二 2.7.5:拿掉單一比例欄位 commission_rate_percentage(服務項目層級抽成之下不再具有單一
 * 比例的意義),改成逐項明細 item_breakdown;legacy_rate_percentage 只有改版前的舊制紀錄
 * (item_breakdown 是空陣列)才會有值,用來顯示「這筆是舊制紀錄,抽成比例 X%」。 */
export interface StaffCommissionSummary {
  details: Array<{
    booking_id: string;
    /** #780(規格書 .project/specs/服務人員報表歸月基準修正.md):原本叫 order_date,但 #767
     * 把歸月基準改成「完成時間」之後,這個欄位裝的是 bcr.computed_at(按下完成的那一刻),
     * 名字還叫「訂單日期」會直接誤導下一個維護者,所以改名。
     * ⚠️ 資料庫那一側**過渡期同時輸出 completion_date 與 order_date 兩個 key(值相同)**,
     * 因為 migration 與 Vercel 部署不是同一個原子操作;但前端這裡**刻意只留新名字**,
     * 讓 tsc 幫忙抓出任何還在讀舊欄位的地方。舊 key 的移除登記為 #783。 */
    completion_date: string;
    customer_name: string;
    commission_base_amount: number;
    /** #985 第 8 批 8-11:這筆抽成先扣掉的料錢(完成當時的設定;不扣料錢時是 0)。
     * 資料庫先上、前端後上的過渡期間舊回應沒有這個 key ⇒ optional,缺鍵時畫面顯示「—」、CSV 輸出空白。 */
    material_cost_deducted?: number;
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

/** §3.10 get_staff_monthly_payroll_summary 回傳形狀(月薪制服務人員報表,規則 2.8)。§11.7(2026-09-22
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
    /** #1035 B 批:多了 daily_wage / hourly_wage。 */
    compensation_type: StaffCompensationType;
    order_count: number;
    /** 月薪制服務人員的月薪淨額。抽成制的人本來就是 null;月薪制的人在
     * salary_applicable=false 時也是 null。 */
    net_pay: number | null;
    commission_amount: number | null;
    /** #1035 A 批 PA-B01:月薪獎金(區間內完整月份的合計)。月薪列在 salary_applicable=true 時是數字
     * (沒有方案 = 0);月薪列在 salary_applicable=false 時、以及非月薪列一律 null。
     * 資料庫先上、前端後上的過渡期間舊回應沒有這個 key ⇒ optional。 */
    bonus_amount?: number | null;
    /** #1035 B 批 PB-B01:日薪／時薪列才有(其他列沒有這幾個 key)。區間內只算到今天。 */
    wage_amount?: number | null;
    worked_minutes?: number | null;
    work_days?: number | null;
    /** 區間內有某天費率 0,或目前還沒設定金額 ⇒ 報表標黃「還沒設定日薪／時薪金額」。 */
    wage_missing?: boolean | null;
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
  /** 紅利系統重構 §3.15(#848):期間內已完成訂單的紅利折抵金額加總(points_redeem_amount_snapshot)。
   * 資訊欄,營收 / 抽成 / 淨利都**不扣**它(§2.11)。 */
  total_points_redeem_amount: number;
  /** 紅利系統重構 §3.15:商家目前紅利功能是否開啟(SECURITY DEFINER 讀的,查無設定列 = true)。
   * 只有 billing 鑰匙的客服讀不到 merchant_member_settings,所以「紅利折抵金額」卡片的開關只能看這個。 */
  points_feature_enabled: boolean;
  /** 這次查詢的區間是不是「完整月份」(起始日是某月 1 號 且 結束日是某月最後一天,可跨多月,
   * 例如 2/1~4/30 也算)。按年月查詢的 get_merchant_billing_summary 永遠是完整月份,固定 true。
   *
   * ✅ 2026-09-24:資料庫端已上線,這支 RPC 一定會回傳這個欄位,所以型別是必填的 boolean
   * (開發期間曾為了「前端可能先上線、拿到還沒有這個欄位的舊回應」標成 optional 並在呼叫端寫
   * `?? true`,那個過渡防禦已經收掉)。false 時月薪相關數字一律顯示「需選擇完整月份才能計算」,
   * 不顯示 0。 */
  salary_applicable: boolean;
  /** #985 第 8 批 8-8:商家「目前」的「料錢影響服務人員抽成」設定(查無設定 = false)。
   * 以下三個資訊鍵都是 optional:舊資料庫回應沒有這些 key 時,前端不顯示小字、CSV 不加列。 */
  material_cost_affects_commission_now?: boolean;
  /** 期間內(跟總抽成支出同一個期間判斷)抽成先扣料錢的訂單筆數。 */
  commission_orders_material_deducted_count?: number;
  /** 期間內抽成沒有扣料錢的訂單筆數。 */
  commission_orders_material_not_deducted_count?: number;
  /** #1035 A 批 PA-B01:月薪獎金合計。跟月薪同一個「完整月份」條件:salary_applicable=false 時是
   * **null(不是 0)**;沒有任何方案的店是 0。estimated_net_margin 已經扣掉它。 */
  total_monthly_bonus?: number | null;
  /** #1035 A 批 PA-B02:這間店有沒有任何獎金方案(含已封存)。false ⇒ 「月薪獎金」卡與 CSV 那一列都不出現。 */
  bonus_feature_used?: boolean;
  /** #1035 B 批 PB-B01:日薪／時薪支出合計(按天算,不需要完整月份;只算到今天)。estimated_net_margin 已經扣掉它。 */
  total_wage_payout?: number | null;
  /** 區間包含今天 ⇒ true(今天的工資是預估)。 */
  wage_includes_estimate?: boolean;
  /** 這間店歷史上有沒有任何日薪／時薪制的人。false ⇒ 「日薪／時薪支出」卡與 CSV 那一列都不出現。 */
  wage_feature_used?: boolean;
}

// =========================================================================
// #1035 彈性計薪 A 批:月薪獎金方案(規格書 PA-R01 / PA-F01~F06)
// =========================================================================

/** 「給什麼」:每單加錢 / 每份加錢 / 業績百分比 / 達標給一筆。 */
export type BonusRuleKind = "per_order" | "per_unit" | "percent" | "lump_sum";

/** 「用什麼量判斷達標」:單數 / 份數 / 業績(元)。 */
export type BonusMetric = "orders" | "units" | "revenue";

/** 資料庫存的一條規則(public.save_staff_bonus_plan 驗證、正規化後的形狀)。 */
export interface BonusRule {
  key: string;
  label: string;
  kind: BonusRuleKind;
  metric: BonusMetric;
  service_item_ids: string[];
  threshold: number;
  cap: number | null;
  amount: number | null;
  percent: number | null;
  retroactive: boolean;
}

export interface BonusPlanVersion {
  /** YYYY-MM-01 */
  effective_month: string;
  rules: BonusRule[];
}

export interface BonusPlan {
  id: string;
  name: string;
  status: "active" | "archived";
  created_at: string;
  /** 目前在職的月薪人員中,指派這個方案的人數 / 姓名。 */
  staff_count: number;
  staff_names: string[];
  /** effective_month ≤ 本月的最新一版;方案選「從下個月起」建立時本月是 null。 */
  current_version: BonusPlanVersion | null;
  /** 下個月起另有設定(有的話)。 */
  next_version: BonusPlanVersion | null;
}

export interface BonusServiceItemOption {
  id: string;
  name: string;
  status: string;
}

/** public.list_staff_bonus_plans 回傳形狀。 */
export interface BonusPlansListing {
  /** 台北時間本月 1 號(YYYY-MM-DD)。 */
  this_month: string;
  plans: BonusPlan[];
  assignments: Array<{ staff_id: string; plan_id: string }>;
  service_items: BonusServiceItemOption[];
}

/** 一條規則算出來的結果(報表 / 試算明細)。 */
export interface BonusRuleResult {
  key: string;
  label: string;
  kind: BonusRuleKind;
  metric: BonusMetric;
  /** 這條規則看的量(單數 / 份數 / 業績元)。 */
  quantity: number;
  /** 實際計入的量(單 / 份:計入幾個;業績:計入多少元;達標給一筆:1 = 有給、0 = 沒給)。 */
  counted_quantity: number;
  /** 每單 / 每份:計入的是第幾個到第幾個(沒有計入時 null)。 */
  range_start: number | null;
  range_end: number | null;
  /** 只有「達標給一筆」才有值。 */
  achieved: boolean | null;
  amount: number;
}

/** private.compute_staff_monthly_bonus / preview_staff_bonus 回傳形狀(服務人員本人看時沒有方案欄位)。 */
export interface StaffMonthlyBonus {
  /** YYYY-MM-01 */
  month: string;
  has_plan: boolean;
  plan_id?: string | null;
  plan_name?: string | null;
  plan_status?: "active" | "archived" | null;
  version_effective_month?: string | null;
  amount: number;
  rules: BonusRuleResult[];
  /** 目前只有 "capped"(合計超過 1,000,000 封頂)。 */
  flags: string[];
}

// =========================================================================
// #1035 彈性計薪 B 批:日薪／時薪(規格書 PB-R04 / PB-F01~F03)
// =========================================================================

/** 每天明細的狀態:已結算(凍結紀錄)/ 尚未結算(過去日但排程還沒跑,即時算)/ 預估(今天)。 */
export type WageDayState = "settled" | "unsettled" | "estimated";

/** get_staff_wage_by_range 的一天。 */
export interface StaffWageDay {
  date: string;
  compensation_type: "daily_wage" | "hourly_wage";
  /** 當天的費率(日薪 = 元/天;時薪 = 元/小時)。 */
  wage_amount: number;
  /** 可預約時段(營業時間 ∩ 每週時段 − 關閉的格子)。 */
  shift_minutes: number;
  /** 落在時段外的訂單時間。 */
  extra_booking_minutes: number;
  /** 合計(重疊只算一次)。 */
  worked_minutes: number;
  is_leave: boolean;
  leave_type_name: string | null;
  pay_amount: number;
  state: WageDayState;
}

/** public.get_staff_wage_by_range 回傳形狀(區間只算到今天)。 */
export interface StaffWageByRange {
  total_pay: number;
  total_worked_minutes: number;
  /** 有上工(worked_minutes > 0)的天數。 */
  work_days: number;
  days: StaffWageDay[];
  /** 區間內某天費率 0,或目前還沒設定金額。 */
  wage_missing: boolean;
  latest_compensation_type: "daily_wage" | "hourly_wage" | null;
  latest_wage_amount: number | null;
  includes_estimate: boolean;
}

/** public.list_staff_wages 的一列(目前在職的日薪／時薪人員)。 */
export interface StaffWageSetting {
  staff_id: string;
  name: string;
  compensation_type: "daily_wage" | "hourly_wage";
  wage_amount: number;
  has_setting: boolean;
}

/** public.get_staff_bonus_by_range 回傳形狀。 */
export interface StaffBonusByRange {
  months: StaffMonthlyBonus[];
  total_amount: number;
  /** 區間裡不是完整月份、所以沒有計算獎金的月份(YYYY-MM-01)。 */
  partial_months: string[];
  has_any_plan: boolean;
}
