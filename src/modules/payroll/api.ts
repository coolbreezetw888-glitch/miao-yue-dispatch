// 模組 8:薪資與帳務 — 資料存取層 + 第五節「對外介面」。
// 這裡是唯一直接呼叫 supabase.from('merchant_payroll_settings' / 'staff_commission_rates' /
// 'staff_salary_settings' / 'leave_type_deduction_rules' / 'booking_commission_records') 或
// supabase.rpc('get_staff_commission_summary' / 'get_staff_monthly_payroll_summary' /
// 'get_merchant_billing_summary' / 'recalculate_booking_commission') 的地方。其他模組不應該
// 直接操作這五張表(規格書第五節「對外介面」),一律 import 這個檔案匯出的 hooks/functions。
//
// 這個模組刻意把 hooks 跟底層 supabase 呼叫都放在同一個檔案(規格書 §5 明講「src/modules/payroll/
// api.ts 暴露 hooks/functions」,只提到單一檔案),不像模組 7 額外拆一支 context.tsx——這是規模
// 考量下的簡化,不影響對外呼叫方式(其他模組一樣是 import 具名的 hook/function 使用)。
//
// 錯誤訊息顯示注意事項(沿用模組 1/3/4/5/6/7/9 已經確立的踩坑):`error` 不是真正的 Error 實例,
// 一律用 `if (error) throw error` 丟出,畫面上用 getErrorMessage() 取訊息。

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import type {
  BonusPlansListing,
  BonusRule,
  BookingCommissionRecord,
  CommissionBasisType,
  CommissionMode,
  DeductionMode,
  LeaveTypeDeductionRule,
  MerchantBillingSummary,
  MerchantPayrollSettings,
  StaffCommissionSummary,
  StaffMonthlyPayrollSummary,
  StaffSalarySettings,
  StaffBonusByRange,
  StaffMonthlyBonus,
  BonusFormulaPreview,
  StaffServiceCommissionRate,
  StaffWageByRange,
  StaffWageSetting,
} from "./types";
import { validateDateRange } from "./dateRangeUtils";

// =========================================================================
// §1.1 的預設值(查無資料時前端一律套用,對應規格書「查無資料時的預設值」段落——
// 財務謹慎設計,不能自己在這裡「幫」商家填入非零數字)。商家端三項調整規格書 §二 2.2.2 拿掉
// 商家層級預設抽成比例欄位、§十 10.1 拿掉 pay_days_per_month 欄位(改成系統動態計算,不再是
// 商家可填寫的設定值)之後,這裡的預設值只剩 commission_basis_type。
// =========================================================================
export const DEFAULT_MERCHANT_PAYROLL_SETTINGS: Pick<
  MerchantPayrollSettings,
  "commission_basis_type"
> = {
  commission_basis_type: "gross",
};

// =========================================================================
// §3.2/§5.1:merchant_payroll_settings 讀寫。不包 RPC,直接開放 RLS,前端 upsert。
// =========================================================================
export async function fetchMerchantPayrollSettings(
  merchantId: string,
): Promise<MerchantPayrollSettings | null> {
  const { data, error } = await supabase
    .from("merchant_payroll_settings")
    .select("*")
    .eq("merchant_id", merchantId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** §5.1 對外介面:回傳某商家目前的薪資設定;查無資料(還沒特別設定過)時 fallback 成預設值,
 * 不回傳 null,讓呼叫端不用每次都自己判斷「有沒有這筆資料」。 */
export function useMerchantPayrollSettings(
  merchantId: string | null | undefined,
): UseQueryResult<MerchantPayrollSettings | typeof DEFAULT_MERCHANT_PAYROLL_SETTINGS> {
  return useQuery({
    queryKey: ["payroll-module", "merchant-payroll-settings", merchantId],
    queryFn: async () => {
      const row = await fetchMerchantPayrollSettings(merchantId as string);
      return row ?? DEFAULT_MERCHANT_PAYROLL_SETTINGS;
    },
    enabled: Boolean(merchantId),
  });
}

export interface UpsertMerchantPayrollSettingsInput {
  commissionBasisType: CommissionBasisType;
}

/** §5.1 對外介面:沒有既有列時新增,已有則更新(upsert on primary key merchant_id)。商家端
 * 三項調整規格書 §二 2.2.2:不再寫入 default_commission_rate_percentage(欄位不再使用,抽成
 * 完全改成服務項目層級)。§十 10.1:不再寫入 pay_days_per_month(欄位已移除,「月折算天數」
 * 改成系統依當月實際天數自動計算,不是商家可填寫的設定值)。 */
export async function upsertMerchantPayrollSettings(
  merchantId: string,
  input: UpsertMerchantPayrollSettingsInput,
): Promise<void> {
  const { error } = await supabase.from("merchant_payroll_settings").upsert(
    {
      merchant_id: merchantId,
      commission_basis_type: input.commissionBasisType,
    },
    { onConflict: "merchant_id" },
  );
  if (error) throw error;
}

// =========================================================================
// 商家端三項調整規格書 §二:staff_service_commission_rates 讀寫(服務項目層級抽成設定),
// 取代原本一人一個籠統比例的 staff_commission_rates(該表已經 drop)。
// =========================================================================

/** 查詢某位服務人員目前所有服務項目層級的抽成設定,唯讀。查無資料的服務項目一律視為
 * commission_mode='percentage', commission_value=0(規則 2.4,財務保守預設)。回傳一個以
 * service_item_id 為 key 的 map,方便畫面逐項查詢。 */
export const staffServiceCommissionRatesQueryKey = (staffId: string | null | undefined) =>
  ["payroll-module", "staff-service-commission-rates", staffId] as const;

/** 同上,但是不帶 hook 的版本——抽成設定頁需要一次算「整份名單」的統計(判斷這家商家到底有沒有在
 * 用逐項抽成),那裡走 useQueries,不能用 hook 版。兩邊共用同一個 queryKey,所以 react-query 會
 * 去重,不會因此多打一次 API。 */
export async function fetchStaffServiceCommissionRates(
  staffId: string,
): Promise<Map<string, StaffServiceCommissionRate>> {
  const { data, error } = await supabase
    .from("staff_service_commission_rates")
    .select("*")
    .eq("staff_id", staffId);
  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.service_item_id, row]));
}

export function useStaffServiceCommissionRates(
  staffId: string | null | undefined,
): UseQueryResult<Map<string, StaffServiceCommissionRate>> {
  return useQuery({
    queryKey: staffServiceCommissionRatesQueryKey(staffId),
    queryFn: () => fetchStaffServiceCommissionRates(staffId as string),
    enabled: Boolean(staffId),
  });
}

export interface UpsertStaffServiceCommissionRateInput {
  commissionMode: CommissionMode;
  commissionValue: number;
}

/** 新增/更新單一「服務人員 × 服務項目」的抽成設定。RLS WITH CHECK 只允許
 * compensation_type=piece_rate 的服務人員,對月薪制服務人員呼叫會被資料庫擋下,錯誤訊息由
 * 呼叫端用 getErrorMessage() 顯示。 */
export async function upsertStaffServiceCommissionRate(
  staffId: string,
  serviceItemId: string,
  input: UpsertStaffServiceCommissionRateInput,
): Promise<void> {
  const { error } = await supabase.from("staff_service_commission_rates").upsert(
    {
      staff_id: staffId,
      service_item_id: serviceItemId,
      commission_mode: input.commissionMode,
      commission_value: input.commissionValue,
    },
    { onConflict: "staff_id,service_item_id" },
  );
  if (error) throw error;
}

/** 移除單一「服務人員 × 服務項目」的抽成設定,恢復成「尚未設定=0元」(規則 2.10:允許
 * DELETE,不是危險操作)。 */
export async function removeStaffServiceCommissionRate(
  staffId: string,
  serviceItemId: string,
): Promise<void> {
  const { error } = await supabase
    .from("staff_service_commission_rates")
    .delete()
    .eq("staff_id", staffId)
    .eq("service_item_id", serviceItemId);
  if (error) throw error;
}

/** 商家端三項調整規格書 §二 2.7.4:批量套用抽成——用一支資料庫函式一次寫完全部項目,
 * 不是前端迴圈呼叫 N 次個別 upsert,避免半套用狀態。 */
export async function batchApplyStaffServiceCommissionRates(
  staffId: string,
  serviceItemIds: string[],
  commissionMode: CommissionMode,
  commissionValue: number,
): Promise<void> {
  const { error } = await supabase.rpc("batch_apply_staff_service_commission_rates", {
    p_staff_id: staffId,
    p_service_item_ids: serviceItemIds,
    p_commission_mode: commissionMode,
    p_commission_value: commissionValue,
  });
  if (error) throw error;
}

// =========================================================================
// §3.4/§5.2:staff_salary_settings 讀寫(月薪制服務人員薪資設定)。
// =========================================================================
export function useStaffSalarySettings(
  staffId: string | null | undefined,
): UseQueryResult<StaffSalarySettings | null> {
  return useQuery({
    queryKey: ["payroll-module", "staff-salary-settings", staffId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_salary_settings")
        .select("*")
        .eq("staff_id", staffId as string)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: Boolean(staffId),
  });
}

export interface UpsertStaffSalarySettingsInput {
  monthlyBaseSalary: number;
  monthlyLeaveQuotaDays: number | null;
}

/** 新增/更新月薪設定。RLS WITH CHECK 只允許 compensation_type=monthly_salary 的服務人員(§3.4)。 */
export async function upsertStaffSalarySettings(
  staffId: string,
  input: UpsertStaffSalarySettingsInput,
): Promise<void> {
  const { error } = await supabase.from("staff_salary_settings").upsert(
    {
      staff_id: staffId,
      monthly_base_salary: input.monthlyBaseSalary,
      monthly_leave_quota_days: input.monthlyLeaveQuotaDays,
    },
    { onConflict: "staff_id" },
  );
  if (error) throw error;
}

// =========================================================================
// §3.5/§5.3:leave_type_deduction_rules 讀寫(假別扣款規則)。
// =========================================================================
export const DEFAULT_LEAVE_TYPE_DEDUCTION_RULE: {
  deduction_mode: DeductionMode;
  percentage_value: number | null;
  fixed_amount_value: number | null;
} = {
  deduction_mode: "no_deduction",
  percentage_value: null,
  fixed_amount_value: null,
};

/** §5.3 對外介面:查詢單一假別目前的扣款規則;查無資料時 fallback 成 no_deduction(規則 2.7
 * 開頭原則:不預設任何假別要扣款)。 */
export function useLeaveTypeDeductionRule(
  leaveTypeId: string | null | undefined,
): UseQueryResult<LeaveTypeDeductionRule | typeof DEFAULT_LEAVE_TYPE_DEDUCTION_RULE> {
  return useQuery({
    queryKey: ["payroll-module", "leave-type-deduction-rule", leaveTypeId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leave_type_deduction_rules")
        .select("*")
        .eq("leave_type_id", leaveTypeId as string)
        .maybeSingle();
      if (error) throw error;
      return data ?? DEFAULT_LEAVE_TYPE_DEDUCTION_RULE;
    },
    enabled: Boolean(leaveTypeId),
  });
}

export interface UpsertLeaveTypeDeductionRuleInput {
  deductionMode: DeductionMode;
  percentageValue: number | null;
  fixedAmountValue: number | null;
}

/** §5.3 對外介面:新增/更新單一假別的扣款規則(upsert on conflict (leave_type_id))。 */
export async function upsertLeaveTypeDeductionRule(
  merchantId: string,
  leaveTypeId: string,
  input: UpsertLeaveTypeDeductionRuleInput,
): Promise<void> {
  const { error } = await supabase.from("leave_type_deduction_rules").upsert(
    {
      merchant_id: merchantId,
      leave_type_id: leaveTypeId,
      deduction_mode: input.deductionMode,
      percentage_value: input.percentageValue,
      fixed_amount_value: input.fixedAmountValue,
    },
    { onConflict: "leave_type_id" },
  );
  if (error) throw error;
}

// =========================================================================
// §3.9/§5.4:服務人員報表(抽成制)。
// =========================================================================
export async function fetchStaffCommissionSummary(
  staffId: string,
  year: number,
  month: number,
): Promise<StaffCommissionSummary> {
  const { data, error } = await supabase.rpc("get_staff_commission_summary", {
    p_staff_id: staffId,
    p_year: year,
    p_month: month,
  });
  if (error) throw error;
  return data as unknown as StaffCommissionSummary;
}

/** §5.4 對外介面:某位抽成制服務人員某年月的抽成明細+總計,供 4.4 服務人員報表頁使用。 */
export function useStaffCommissionSummary(
  staffId: string | null | undefined,
  year: number | null | undefined,
  month: number | null | undefined,
): UseQueryResult<StaffCommissionSummary> {
  return useQuery({
    queryKey: ["payroll-module", "staff-commission-summary", staffId, year, month],
    queryFn: () => fetchStaffCommissionSummary(staffId as string, year as number, month as number),
    enabled: Boolean(staffId) && Boolean(year) && Boolean(month),
  });
}

// =========================================================================
// §3.10/§5.4:服務人員報表(月薪制,規則 2.8)。
// =========================================================================
export async function fetchStaffMonthlyPayrollSummary(
  staffId: string,
  year: number,
  month: number,
): Promise<StaffMonthlyPayrollSummary> {
  const { data, error } = await supabase.rpc("get_staff_monthly_payroll_summary", {
    p_staff_id: staffId,
    p_year: year,
    p_month: month,
  });
  if (error) throw error;
  return data as unknown as StaffMonthlyPayrollSummary;
}

/** §5.4 對外介面:某位月薪制服務人員某年月的請假扣款明細與淨額,供 4.4 服務人員報表頁使用。 */
export function useStaffMonthlyPayrollSummary(
  staffId: string | null | undefined,
  year: number | null | undefined,
  month: number | null | undefined,
): UseQueryResult<StaffMonthlyPayrollSummary> {
  return useQuery({
    queryKey: ["payroll-module", "staff-monthly-payroll-summary", staffId, year, month],
    queryFn: () =>
      fetchStaffMonthlyPayrollSummary(staffId as string, year as number, month as number),
    enabled: Boolean(staffId) && Boolean(year) && Boolean(month),
  });
}

// =========================================================================
// §3.11/§5.5:店家端帳務報表。
// =========================================================================
export async function fetchMerchantBillingSummary(
  merchantId: string,
  year: number,
  month: number,
): Promise<MerchantBillingSummary> {
  const { data, error } = await supabase.rpc("get_merchant_billing_summary", {
    p_merchant_id: merchantId,
    p_year: year,
    p_month: month,
  });
  if (error) throw error;
  return data as unknown as MerchantBillingSummary;
}

/** §5.5 對外介面:某商家某年月的營收/成本/抽成/薪資/概估毛利彙整,供 4.3 帳務報表頁使用。 */
export function useMerchantBillingSummary(
  merchantId: string | null | undefined,
  year: number | null | undefined,
  month: number | null | undefined,
): UseQueryResult<MerchantBillingSummary> {
  return useQuery({
    queryKey: ["payroll-module", "merchant-billing-summary", merchantId, year, month],
    queryFn: () =>
      fetchMerchantBillingSummary(merchantId as string, year as number, month as number),
    enabled: Boolean(merchantId) && Boolean(year) && Boolean(month),
  });
}

// =========================================================================
// §3.8/§5.6:手動重新計算抽成。
// #996 第 11 批 K 起:商家管理員,或有「抽成與薪資設定」(commission_settings)權限的在職客服
// (推翻原規則 2.6「僅商家管理員」);主要服務人員目前不是抽成制時後端擋下。
// =========================================================================
/** §5.6 對外介面:重新計算某筆已完成訂單的抽成金額。權限由資料庫層
 * private.can_manage_commission_settings(訂單所屬商家)判斷,這裡不重複判斷,前端只負責
 * 把沒權限的人擋在按鈕外(預約詳情的「服務人員抽成」區塊,見 booking/BookingCommissionSection.tsx)。
 * 商家端三項調整規格書 §二 2.7.3:拿掉「臨時指定一個特別比例」的參數,語意改成「依商家目前
 * 最新的 staff_service_commission_rates 設定,重新算一次」。 */
export async function recalculateBookingCommission(
  bookingId: string,
): Promise<BookingCommissionRecord> {
  const { data, error } = await supabase.rpc("recalculate_booking_commission", {
    p_booking_id: bookingId,
  });
  if (error) throw error;
  return data as BookingCommissionRecord;
}

/** #996 第 11 批 K-3:預約詳情「服務人員抽成」區塊用的總額摘要(只回總額,不回明細與比例)。
 * 權限同重算(管理員或有「抽成與薪資設定」的客服);無權限與訂單不存在都是 42501。 */
export interface BookingCommissionSummary {
  has_record: boolean;
  commission_amount: number | null;
  computed_at: string | null;
  recalculated_at: string | null;
  staff_name: string | null;
  /** 主要服務人員目前是不是抽成制(主腦裁決:不是就不能重算)。has_record = false 時為 null。 */
  staff_is_piece_rate: boolean | null;
}

export async function fetchBookingCommissionSummary(
  bookingId: string,
): Promise<BookingCommissionSummary> {
  const { data, error } = await supabase.rpc("get_booking_commission_summary", {
    p_booking_id: bookingId,
  });
  if (error) throw error;
  const raw = data as unknown as BookingCommissionSummary;
  return {
    ...raw,
    commission_amount: raw.commission_amount === null ? null : Number(raw.commission_amount),
  };
}

// =========================================================================
// 商家端三項調整規格書 §3.6/服務人員端規格書 §15.2:時間篩選從單一年/月改成可選區間(最長一年)。
// 這三支是對應 3.9/3.10/3.11 的「_by_range」overload,不取代原本按年月查詢的版本(那些繼續給
// 商家管理員視角的 StaffReportPage.tsx 使用,見服務人員端規格書 §15.2 第 4 點)。三支的 enabled
// 條件都額外檢查 validateDateRange(...) === null,避免區間不合法(起訖為空/結束早於起始/超過
// 一年)時還送出注定失敗的請求——跟後端的區間上限保護是「前端也擋一次」的關係,不是取代後端。
// =========================================================================

export async function fetchMerchantBillingSummaryByRange(
  merchantId: string,
  startDate: string,
  endDate: string,
): Promise<MerchantBillingSummary> {
  const { data, error } = await supabase.rpc("get_merchant_billing_summary_by_range", {
    p_merchant_id: merchantId,
    p_start_date: startDate,
    p_end_date: endDate,
  });
  if (error) throw error;
  return data as unknown as MerchantBillingSummary;
}

/** §3.6 對外介面:某商家某段區間(最長一年)的營收/成本/抽成/薪資/概估毛利彙整,供 4.3 帳務
 * 報表頁使用。 */
export function useMerchantBillingSummaryByRange(
  merchantId: string | null | undefined,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): UseQueryResult<MerchantBillingSummary> {
  return useQuery({
    queryKey: ["payroll-module", "merchant-billing-summary-range", merchantId, startDate, endDate],
    queryFn: () =>
      fetchMerchantBillingSummaryByRange(
        merchantId as string,
        startDate as string,
        endDate as string,
      ),
    enabled:
      Boolean(merchantId) &&
      Boolean(startDate) &&
      Boolean(endDate) &&
      validateDateRange(startDate as string, endDate as string) === null,
  });
}

export async function fetchStaffCommissionSummaryByRange(
  staffId: string,
  startDate: string,
  endDate: string,
): Promise<StaffCommissionSummary> {
  const { data, error } = await supabase.rpc("get_staff_commission_summary_by_range", {
    p_staff_id: staffId,
    p_start_date: startDate,
    p_end_date: endDate,
  });
  if (error) throw error;
  return data as unknown as StaffCommissionSummary;
}

/** §3.6/§15.2 對外介面:某位抽成制服務人員某段區間(最長一年)的抽成明細+總計。 */
export function useStaffCommissionSummaryByRange(
  staffId: string | null | undefined,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): UseQueryResult<StaffCommissionSummary> {
  return useQuery({
    queryKey: ["payroll-module", "staff-commission-summary-range", staffId, startDate, endDate],
    queryFn: () =>
      fetchStaffCommissionSummaryByRange(staffId as string, startDate as string, endDate as string),
    enabled:
      Boolean(staffId) &&
      Boolean(startDate) &&
      Boolean(endDate) &&
      validateDateRange(startDate as string, endDate as string) === null,
  });
}

export async function fetchStaffMonthlyPayrollSummaryByRange(
  staffId: string,
  startDate: string,
  endDate: string,
): Promise<StaffMonthlyPayrollSummary> {
  const { data, error } = await supabase.rpc("get_staff_monthly_payroll_summary_by_range", {
    p_staff_id: staffId,
    p_start_date: startDate,
    p_end_date: endDate,
  });
  if (error) throw error;
  return data as unknown as StaffMonthlyPayrollSummary;
}

/** §3.6/§15.2 對外介面:某位月薪制服務人員某段區間(最長一年)的請假扣款明細與淨額。⚠️
 * monthly_base_salary/monthly_leave_quota_days 維持單月快照值,不因區間跨月而放大,詳見
 * migration 20260922130300 的函式註解。 */
export function useStaffMonthlyPayrollSummaryByRange(
  staffId: string | null | undefined,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): UseQueryResult<StaffMonthlyPayrollSummary> {
  return useQuery({
    queryKey: [
      "payroll-module",
      "staff-monthly-payroll-summary-range",
      staffId,
      startDate,
      endDate,
    ],
    queryFn: () =>
      fetchStaffMonthlyPayrollSummaryByRange(
        staffId as string,
        startDate as string,
        endDate as string,
      ),
    enabled:
      Boolean(staffId) &&
      Boolean(startDate) &&
      Boolean(endDate) &&
      validateDateRange(startDate as string, endDate as string) === null,
  });
}

// =========================================================================
// #1035 彈性計薪 A 批:月薪獎金方案(規格書 PA-F01~F06)。全部走 SECURITY DEFINER RPC,
// 三張新表 0 policy、前端不能直接讀寫。
// =========================================================================

export const staffBonusPlansQueryKey = (merchantId: string | null | undefined) =>
  ["payroll-module", "staff-bonus-plans", merchantId] as const;

/** PA-F01:方案清單 + 每位服務人員目前的指派 + 本店全部服務項目(含已下架)。 */
export async function fetchStaffBonusPlans(merchantId: string): Promise<BonusPlansListing> {
  const { data, error } = await supabase.rpc("list_staff_bonus_plans", {
    p_merchant_id: merchantId,
  });
  if (error) throw error;
  return data as unknown as BonusPlansListing;
}

export function useStaffBonusPlans(
  merchantId: string | null | undefined,
): UseQueryResult<BonusPlansListing> {
  return useQuery({
    queryKey: staffBonusPlansQueryKey(merchantId),
    queryFn: () => fetchStaffBonusPlans(merchantId as string),
    enabled: Boolean(merchantId),
  });
}

export type BonusPlanEffective = "this_month" | "next_month";

/** PA-F02:新增(planId = null)或修改方案 + 寫版本;回方案 id。 */
export async function saveStaffBonusPlan(input: {
  merchantId: string;
  planId: string | null;
  name: string;
  rules: BonusRule[];
  effective: BonusPlanEffective;
}): Promise<string> {
  const { data, error } = await supabase.rpc("save_staff_bonus_plan", {
    p_merchant_id: input.merchantId,
    // 產生的型別把 p_plan_id 標成 string(資料庫參數本身允許 null = 新增)。
    p_plan_id: input.planId as string,
    p_name: input.name,
    p_rules: input.rules as unknown as Json,
    p_effective: input.effective,
  });
  if (error) throw error;
  return data as string;
}

/** PA-F03:指派 / 取消指派(planId = null = 不給獎金)。 */
export async function setStaffBonusPlan(staffId: string, planId: string | null): Promise<void> {
  const { error } = await supabase.rpc("set_staff_bonus_plan", {
    p_staff_id: staffId,
    p_plan_id: planId as string,
  });
  if (error) throw error;
}

/** PA-F04:封存(有人正在用時資料庫會擋下並說是誰)。 */
export async function archiveStaffBonusPlan(planId: string): Promise<void> {
  const { error } = await supabase.rpc("archive_staff_bonus_plan", { p_plan_id: planId });
  if (error) throw error;
}

/** PA-F05:用還沒存檔的規則對某人某月試算(month = YYYY-MM-01)。 */
export async function previewStaffBonus(input: {
  merchantId: string;
  rules: BonusRule[];
  staffId: string;
  month: string;
}): Promise<StaffMonthlyBonus> {
  const { data, error } = await supabase.rpc("preview_staff_bonus", {
    p_merchant_id: input.merchantId,
    p_rules: input.rules as unknown as Json,
    p_staff_id: input.staffId,
    p_month: input.month,
  });
  if (error) throw error;
  return data as unknown as StaffMonthlyBonus;
}

/**
 * #1035 C 批 PC-E04:自訂公式的檢查 / 試算(資料庫編譯與計算,前端不做任何公式求值)。
 *   - 只給 text ⇒ 只檢查(value = null)
 *   - 給 staffId + month(YYYY-MM-01)⇒ 用那人那月的實際數字
 *   - 給 sample ⇒ 用範例數字(orders / units / revenue / salary / leave_days)
 * 公式寫錯時資料庫回 ok = false(不丟錯);權限、月份、範例格式錯才丟錯。
 */
export async function previewBonusFormula(input: {
  merchantId: string;
  text: string;
  staffId?: string | null;
  month?: string | null;
  sample?: Partial<Record<"orders" | "units" | "revenue" | "salary" | "leave_days", number>> | null;
}): Promise<BonusFormulaPreview> {
  const args: {
    p_merchant_id: string;
    p_text: string;
    p_staff_id?: string;
    p_month?: string;
    p_sample?: Json;
  } = { p_merchant_id: input.merchantId, p_text: input.text };
  if (input.staffId) {
    args.p_staff_id = input.staffId;
    if (input.month) args.p_month = input.month;
  } else if (input.sample) {
    args.p_sample = input.sample as unknown as Json;
  }
  const { data, error } = await supabase.rpc("preview_bonus_formula", args);
  if (error) throw error;
  return data as unknown as BonusFormulaPreview;
}

export async function fetchStaffBonusByRange(
  staffId: string,
  startDate: string,
  endDate: string,
): Promise<StaffBonusByRange> {
  const { data, error } = await supabase.rpc("get_staff_bonus_by_range", {
    p_staff_id: staffId,
    p_start_date: startDate,
    p_end_date: endDate,
  });
  if (error) throw error;
  return data as unknown as StaffBonusByRange;
}

/** PA-F06:某位服務人員區間內完整月份的獎金(服務人員本人看時沒有方案資訊)。 */
export function useStaffBonusByRange(
  staffId: string | null | undefined,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): UseQueryResult<StaffBonusByRange> {
  return useQuery({
    queryKey: ["payroll-module", "staff-bonus-range", staffId, startDate, endDate],
    queryFn: () =>
      fetchStaffBonusByRange(staffId as string, startDate as string, endDate as string),
    enabled:
      Boolean(staffId) &&
      Boolean(startDate) &&
      Boolean(endDate) &&
      validateDateRange(startDate as string, endDate as string) === null,
  });
}

// =========================================================================
// #1035 彈性計薪 B 批:日薪／時薪(PB-F01~F03)
// =========================================================================

export function staffWagesQueryKey(merchantId: string | null | undefined) {
  return ["payroll-module", "staff-wages", merchantId] as const;
}

/** PB-F02:目前在職的日薪／時薪人員 + 金額(沒有設定 = 0)。 */
export async function fetchStaffWages(merchantId: string): Promise<StaffWageSetting[]> {
  const { data, error } = await supabase.rpc("list_staff_wages", { p_merchant_id: merchantId });
  if (error) throw error;
  return (data ?? []) as unknown as StaffWageSetting[];
}

export function useStaffWages(
  merchantId: string | null | undefined,
  enabled = true,
): UseQueryResult<StaffWageSetting[]> {
  return useQuery({
    queryKey: staffWagesQueryKey(merchantId),
    queryFn: () => fetchStaffWages(merchantId as string),
    enabled: Boolean(merchantId) && enabled,
  });
}

/** PB-F01:設定日薪／時薪金額(資料庫驗證範圍與小數位;錯誤訊息直接給使用者看)。 */
export async function setStaffWage(staffId: string, amount: number): Promise<void> {
  const { error } = await supabase.rpc("set_staff_wage", { p_staff_id: staffId, p_amount: amount });
  if (error) throw error;
}

/** PB-F03:某位日薪／時薪人員區間內每天的上工時間與工資(只算到今天)。 */
export async function fetchStaffWageByRange(
  staffId: string,
  startDate: string,
  endDate: string,
): Promise<StaffWageByRange> {
  const { data, error } = await supabase.rpc("get_staff_wage_by_range", {
    p_staff_id: staffId,
    p_start_date: startDate,
    p_end_date: endDate,
  });
  if (error) throw error;
  return data as unknown as StaffWageByRange;
}

export function useStaffWageByRange(
  staffId: string | null | undefined,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): UseQueryResult<StaffWageByRange> {
  return useQuery({
    queryKey: ["payroll-module", "staff-wage-range", staffId, startDate, endDate],
    queryFn: () => fetchStaffWageByRange(staffId as string, startDate as string, endDate as string),
    enabled:
      Boolean(staffId) &&
      Boolean(startDate) &&
      Boolean(endDate) &&
      validateDateRange(startDate as string, endDate as string) === null,
  });
}
