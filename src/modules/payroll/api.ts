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
import type {
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
  StaffServiceCommissionRate,
} from "./types";

// =========================================================================
// §1.1 的預設值(查無資料時前端一律套用,對應規格書「查無資料時的預設值」段落——
// 財務謹慎設計,不能自己在這裡「幫」商家填入非零數字)。商家端三項調整規格書 §二 2.2.2 拿掉
// 商家層級預設抽成比例欄位之後,這裡的預設值不再包含它。
// =========================================================================
export const DEFAULT_MERCHANT_PAYROLL_SETTINGS: Pick<
  MerchantPayrollSettings,
  "commission_basis_type" | "pay_days_per_month"
> = {
  commission_basis_type: "gross",
  pay_days_per_month: 30,
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
  payDaysPerMonth: number;
}

/** §5.1 對外介面:沒有既有列時新增,已有則更新(upsert on primary key merchant_id)。商家端
 * 三項調整規格書 §二 2.2.2:不再寫入 default_commission_rate_percentage(欄位不再使用,抽成
 * 完全改成服務項目層級)。 */
export async function upsertMerchantPayrollSettings(
  merchantId: string,
  input: UpsertMerchantPayrollSettingsInput,
): Promise<void> {
  const { error } = await supabase.from("merchant_payroll_settings").upsert(
    {
      merchant_id: merchantId,
      commission_basis_type: input.commissionBasisType,
      pay_days_per_month: input.payDaysPerMonth,
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
export function useStaffServiceCommissionRates(
  staffId: string | null | undefined,
): UseQueryResult<Map<string, StaffServiceCommissionRate>> {
  return useQuery({
    queryKey: ["payroll-module", "staff-service-commission-rates", staffId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_service_commission_rates")
        .select("*")
        .eq("staff_id", staffId as string);
      if (error) throw error;
      return new Map((data ?? []).map((row) => [row.service_item_id, row]));
    },
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
// §3.9/§5.4:師傅報表(按件計酬)。
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

/** §5.4 對外介面:某位按件計酬服務人員某年月的抽成明細+總計,供 4.4 師傅報表頁使用。 */
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
// §3.10/§5.4:師傅報表(月薪制,規則 2.8)。
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

/** §5.4 對外介面:某位月薪制服務人員某年月的請假扣款明細與淨額,供 4.4 師傅報表頁使用。 */
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
// §3.8/§5.6:手動重新計算抽成(僅商家管理員,規則 2.6)。
// =========================================================================
/** §5.6 對外介面:重新計算某筆已完成訂單的抽成金額。只有商家管理員能成功(規則 2.6,資料庫層
 * 用 private.is_merchant_admin 檢查,這裡不重複判斷,前端只需要把管理員以外的人擋在按鈕外)。
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
