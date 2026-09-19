// 模組 7:排班與休假管理 — 第五節「對外介面」的實作
// 其他模組要查詢假別清單/請假紀錄/排班一覽,或要建立/取消請假,一律 import 這個檔案匯出的
// hooks/函式,不要自己 import supabase client 直接查 merchant_leave_types/staff_leave_records
// 這兩張表(規格書第五節)。

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import {
  cancelStaffLeave as apiCancelStaffLeave,
  createStaffLeave as apiCreateStaffLeave,
  fetchMerchantLeaveTypes,
  fetchStaffLeaveRecords,
  fetchStaffScheduleOverview,
  previewStaffLeaveConflicts as apiPreviewStaffLeaveConflicts,
  type CreateStaffLeaveInput,
  type StaffLeaveRecordFilters,
} from "./api";
import type {
  MerchantLeaveType,
  StaffLeaveConflictBooking,
  StaffLeaveRecord,
  StaffScheduleOverview,
} from "./types";

/** §5.2 對外介面:回傳某商家目前上架中(status='active')的假別清單,唯讀。供 4.3 請假登記表單
 * 使用,也保留給模組 8(假別扣款公式設定畫面需要列出假別清單)直接複用。 */
export function useMerchantLeaveTypes(
  merchantId: string | null | undefined,
): UseQueryResult<MerchantLeaveType[]> {
  return useQuery({
    queryKey: ["scheduling-module", "merchant-leave-types", merchantId],
    queryFn: () => fetchMerchantLeaveTypes(merchantId as string),
    enabled: Boolean(merchantId),
  });
}

/** §5.3 對外介面:依服務人員 id/日期區間篩選請假紀錄清單,唯讀。供 4.3 頁面使用,也保留給
 * 模組 8(薪資計算需要彙總某個月薪制服務人員在特定月份的請假天數/假別)直接複用。 */
export function useStaffLeaveRecords(
  filters: StaffLeaveRecordFilters = {},
): UseQueryResult<StaffLeaveRecord[]> {
  return useQuery({
    queryKey: ["scheduling-module", "staff-leave-records", filters],
    queryFn: () => fetchStaffLeaveRecords(filters),
  });
}

/** §5.4 對外介面:建立一筆請假紀錄。 */
export async function createStaffLeave(input: CreateStaffLeaveInput): Promise<StaffLeaveRecord> {
  return apiCreateStaffLeave(input);
}

/** §5.4 對外介面:取消一筆請假紀錄。 */
export async function cancelStaffLeave(leaveId: string): Promise<StaffLeaveRecord> {
  return apiCancelStaffLeave(leaveId);
}

/** §5.4 對外介面:送出建立請假紀錄前,先查這段期間該服務人員既有的預約衝突清單。 */
export async function previewStaffLeaveConflicts(
  staffId: string,
  startDate: string,
  endDate: string,
): Promise<StaffLeaveConflictBooking[]> {
  return apiPreviewStaffLeaveConflicts(staffId, startDate, endDate);
}

/** §5.5 對外介面:某商家在指定日期區間的跨服務人員排班一覽彙整,供 4.4 頁面使用,也保留給之後
 * 任何需要「跨服務人員排班總覽」資料的模組(例如模組 8 報表)直接複用。 */
export function useStaffScheduleOverview(
  merchantId: string | null | undefined,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): UseQueryResult<StaffScheduleOverview> {
  return useQuery({
    queryKey: ["scheduling-module", "schedule-overview", merchantId, startDate, endDate],
    queryFn: () =>
      fetchStaffScheduleOverview(merchantId as string, startDate as string, endDate as string),
    enabled: Boolean(merchantId) && Boolean(startDate) && Boolean(endDate),
  });
}
