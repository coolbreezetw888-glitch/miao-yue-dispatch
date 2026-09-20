// 模組 14:服務人員端 — 第五節「對外介面」的實作。
// 其他模組要判斷「目前使用者是不是這間店的服務人員本人」「這位服務人員有沒有被開放某個自助功能
// 區塊」,一律 import 這個檔案匯出的 hooks,不要自己 import supabase client 直接查
// merchant_staff_permissions 這張表。

import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { getVerifiedUser } from "@/lib/auth-guard";
import { useCurrentMerchant } from "@/modules/merchant/context";
import {
  addStaffAvailabilityWindow,
  removeStaffAvailabilityWindow,
  setStaffDayOverride,
  clearStaffDayOverride,
  type AddStaffAvailabilityWindowInput,
} from "@/modules/booking/api";
import { useStaffAvailabilityWindows } from "@/modules/booking/context";
import type { StaffAvailabilityWindow } from "@/modules/booking/types";
import { fetchMyStaffRow } from "@/modules/staff-agent/api";
import type { MerchantStaff } from "@/modules/staff-agent/types";
import { useStaffCommissionSummary, useStaffMonthlyPayrollSummary } from "@/modules/payroll/api";
import type {
  StaffCommissionSummary,
  StaffMonthlyPayrollSummary,
} from "@/modules/payroll/types";

import {
  fetchMyAvailabilityOverrides,
  fetchMyBookingSchedule,
  type MyBookingScheduleItem,
  type StaffAvailabilityOverride,
} from "./api";
import type { StaffPermissionSectionKey } from "./types";

/** 5.6 對外介面:唯讀,回傳目前登入者在指定商家的 merchant_staff 那一列(受模組 3 規格書 3.3
 * 疊加後的 RLS 保護)。供本模組所有其他 hook 內部取得 staff_id,也保留給之後任何模組需要判斷
 * 「目前使用者是不是這間商家的服務人員本人」時直接複用。 */
export function useMyStaffRecord(
  merchantId: string | null | undefined,
): UseQueryResult<MerchantStaff | null> {
  return useQuery({
    queryKey: ["staff-portal-module", "my-staff-record", merchantId],
    queryFn: async (): Promise<MerchantStaff | null> => {
      const user = await getVerifiedUser();
      if (!user) return null;
      return fetchMyStaffRow(merchantId as string, user.id);
    },
    enabled: Boolean(merchantId),
    staleTime: 30_000,
  });
}

/** 只有「目前是這間商家有效且已開通登入的服務人員」時,才回傳那一筆紀錄,否則回傳 null——
 * 內部給 5.1-5.5 各個自助功能 hook 共用,避免每個 hook 各自重複判斷 status/login_status。
 * 對外 export(比照 useMyStaffRecord)供頁面元件/路由守衛直接判斷「我現在算不算一個能用自助
 * 功能的服務人員」,不用自己重複寫一次 status/login_status 的判斷條件。 */
export function useActiveMyStaffRecord(
  merchantId: string | null | undefined,
): UseQueryResult<MerchantStaff | null> {
  const query = useMyStaffRecord(merchantId);
  const isActiveStaff =
    query.data != null && query.data.status === "active" && query.data.login_status === "active";
  return {
    ...query,
    data: isActiveStaff ? query.data : null,
  } as UseQueryResult<MerchantStaff | null>;
}

/** 5.7 對外介面:回傳目前使用者(如果是「目前有效且已開通登入」的服務人員)是否被開放某個自助
 * 功能區塊。不是服務人員身份時回傳 null,代表「不適用這個判斷」(比照模組 3 useAgentPermission
 * 的既有精神)。 */
export function useMyStaffPermission(
  sectionKey: StaffPermissionSectionKey | string,
): UseQueryResult<boolean | null> {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant?.id ?? null;
  const { data: staffRow } = useActiveMyStaffRecord(merchantId);
  const staffId = staffRow?.id ?? null;

  return useQuery({
    queryKey: ["staff-portal-module", "my-staff-permission", staffId, sectionKey],
    queryFn: async (): Promise<boolean | null> => {
      if (!staffId) return null;

      const { data, error } = await supabase
        .from("merchant_staff_permissions")
        .select("granted")
        .eq("staff_id", staffId)
        .eq("section_key", sectionKey)
        .maybeSingle();
      if (error) throw error;

      return data?.granted ?? false;
    },
    enabled: Boolean(merchantId),
  });
}

// =========================================================================
// 5.1:我的行事曆彙整查詢(對應規格書 3.15/規則 2.5/2.6)。內部先呼叫 useMyStaffRecord 取得
// 自己的 staff_id,再呼叫 3.15,供 4.3 MyCalendarPage.tsx 使用。
// =========================================================================
export function useMyBookingSchedule(
  merchantId: string | null | undefined,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): UseQueryResult<MyBookingScheduleItem[]> {
  const { data: staffRow } = useActiveMyStaffRecord(merchantId);
  const staffId = staffRow?.id ?? null;

  return useQuery({
    queryKey: ["staff-portal-module", "my-booking-schedule", staffId, startDate, endDate],
    queryFn: () => fetchMyBookingSchedule(staffId as string, startDate as string, endDate as string),
    enabled: Boolean(staffId) && Boolean(startDate) && Boolean(endDate),
  });
}

// =========================================================================
// 5.2:讀寫自己的 staff_availability_windows(受 3.13 疊加後的 RLS 保護,前端直接
// supabase.from(...) 操作即可)。內部複用模組 5 對外介面 useStaffAvailabilityWindows/
// addStaffAvailabilityWindow/removeStaffAvailabilityWindow,不重新實作一套查詢邏輯。
// =========================================================================
export function useMyAvailabilityWindows(
  merchantId: string | null | undefined,
): UseQueryResult<StaffAvailabilityWindow[]> {
  const { data: staffRow } = useActiveMyStaffRecord(merchantId);
  return useStaffAvailabilityWindows(staffRow?.id ?? null);
}

export async function upsertMyAvailabilityWindow(
  staffId: string,
  input: AddStaffAvailabilityWindowInput,
): Promise<StaffAvailabilityWindow> {
  return addStaffAvailabilityWindow(staffId, input);
}

export async function deleteMyAvailabilityWindow(windowId: string): Promise<void> {
  return removeStaffAvailabilityWindow(windowId);
}

// =========================================================================
// 5.3:單日例外自助讀寫。呼叫 3.14 疊加後的 set_staff_day_override/clear_staff_day_override
// (模組 5 既有對外介面,已疊加自助分支,呼叫端只要傳入自己的 staff_id 即可)+ 讀取自己的
// staff_availability_overrides。
//
// 命名跟規格書 5.3 字面(useMySetDayOverride/useMyClearDayOverride)差一個 use 前綴——這兩支
// 是單純的非同步寫入函式,不是 React hook(不呼叫任何其他 hook、可以在事件處理常式裡直接
// await),沿用 use 前綴會誤導成 hook、也會被 eslint-plugin-react-hooks 的 rules-of-hooks
// 檢查誤判。比照本檔案/booking 模組既有的 setStaffDayOverride/clearStaffDayOverride、
// createBooking 等寫入函式一律不加 use 前綴的既有命名慣例,已在回報中向主腦說明這個小幅偏離。
// =========================================================================
export async function setMyDayOverride(
  staffId: string,
  overrideDate: string,
  startTime: string,
  endTime: string,
  isAvailable: boolean,
): Promise<number> {
  return setStaffDayOverride(staffId, overrideDate, startTime, endTime, isAvailable);
}

export async function clearMyDayOverride(
  staffId: string,
  overrideDate: string,
  startTime: string,
  endTime: string,
): Promise<void> {
  return clearStaffDayOverride(staffId, overrideDate, startTime, endTime);
}

export function useMyAvailabilityOverrides(
  merchantId: string | null | undefined,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): UseQueryResult<StaffAvailabilityOverride[]> {
  const { data: staffRow } = useActiveMyStaffRecord(merchantId);
  const staffId = staffRow?.id ?? null;

  return useQuery({
    queryKey: ["staff-portal-module", "my-availability-overrides", staffId, startDate, endDate],
    queryFn: () =>
      fetchMyAvailabilityOverrides(staffId as string, startDate as string, endDate as string),
    enabled: Boolean(staffId) && Boolean(startDate) && Boolean(endDate),
  });
}

/** 供 4.4 頁面在寫入後 invalidate 相關查詢用,集中管理 query key 前綴,避免各頁面各自拼字串。 */
export function useInvalidateMyAvailability(): {
  invalidate: (merchantId: string, staffId: string) => Promise<void>;
} {
  const queryClient = useQueryClient();
  return {
    invalidate: async (merchantId: string, staffId: string) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["booking-module", "staff-availability-windows", staffId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["staff-portal-module", "my-availability-overrides"],
        }),
      ]);
      void merchantId;
    },
  };
}

// =========================================================================
// 5.4:抽成/薪資報表自助檢視。內部取得自己的 staff_id 後呼叫模組 8 既有對外介面
// (已在 3.17 疊加自助檢視分支),直接複用同一套查詢邏輯,不另外開發平行的「自助版」函式。
// =========================================================================
export function useMyStaffCommissionSummary(
  merchantId: string | null | undefined,
  year: number | null | undefined,
  month: number | null | undefined,
): UseQueryResult<StaffCommissionSummary> {
  const { data: staffRow } = useActiveMyStaffRecord(merchantId);
  return useStaffCommissionSummary(staffRow?.id ?? null, year, month);
}

export function useMyStaffMonthlyPayrollSummary(
  merchantId: string | null | undefined,
  year: number | null | undefined,
  month: number | null | undefined,
): UseQueryResult<StaffMonthlyPayrollSummary> {
  const { data: staffRow } = useActiveMyStaffRecord(merchantId);
  return useStaffMonthlyPayrollSummary(staffRow?.id ?? null, year, month);
}
