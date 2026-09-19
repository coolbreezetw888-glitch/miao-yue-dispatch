// 模組 7:排班與休假管理 — 型別定義
// 對應規格書第一節資料表。其他模組若需要用到假別/請假紀錄/排班一覽相關型別,一律從這個檔案或
// context.tsx 匯出的 hooks 取得(呼應規格書第五節「對外介面」的模組獨立性設計)。

import type { Tables } from "@/integrations/supabase/types";

/** 商家自訂的請假分類清單(§1.2),比照 payment_methods/material_cost_items 的既有設計語言。 */
export type MerchantLeaveType = Tables<"merchant_leave_types">;

/** 某位月薪制服務人員在某個日期區間請假的一筆登記(§1.3)。 */
export type StaffLeaveRecord = Tables<"staff_leave_records">;

/** §3.4 preview_staff_leave_conflicts 回傳的一筆既有預約衝突。 */
export interface StaffLeaveConflictBooking {
  bookingId: string;
  startAt: string;
  endAt: string;
  customerName: string;
  serviceItemNames: string[];
}

/** §3.8 get_staff_schedule_overview 回傳的每一天摘要資料。 */
export interface ScheduleOverviewWindow {
  start_time?: string;
  end_time?: string;
  unrestricted?: boolean;
}

export interface ScheduleOverviewOverride {
  start_time: string;
  end_time: string;
  is_available: boolean;
}

export interface ScheduleOverviewOnLeave {
  leave_record_id: string;
  leave_type_name: string;
}

export interface ScheduleOverviewDay {
  date: string;
  windows: ScheduleOverviewWindow[];
  overrides: ScheduleOverviewOverride[];
  on_leave: ScheduleOverviewOnLeave | null;
  booking_count: number;
}

export interface ScheduleOverviewStaffBlock {
  staff_id: string;
  staff_name: string;
  no_time_slot_limit: boolean;
  days: ScheduleOverviewDay[];
}

export interface StaffScheduleOverview {
  start_date: string;
  end_date: string;
  staff: ScheduleOverviewStaffBlock[];
}

/** 4.3 請假紀錄管理頁:依日期/status 綜合判斷顯示文字用的狀態(不是資料庫欄位,單純畫面顯示)。 */
export type LeaveRecordDisplayStatus = "upcoming" | "ongoing" | "ended" | "cancelled";

/** 依 status 欄位 + 今天日期(Asia/Taipei,傳入 todayDateKey 方便測試,不在函式內部呼叫 new Date())
 * 判斷一筆請假紀錄目前該顯示「即將開始/進行中/已結束/已取消」哪一種文字,純函式方便 Vitest 測試。 */
export function getLeaveRecordDisplayStatus(
  record: Pick<StaffLeaveRecord, "status" | "start_date" | "end_date">,
  todayDateKey: string,
): LeaveRecordDisplayStatus {
  if (record.status === "cancelled") return "cancelled";
  if (todayDateKey < record.start_date) return "upcoming";
  if (todayDateKey > record.end_date) return "ended";
  return "ongoing";
}

export const LEAVE_RECORD_DISPLAY_STATUS_LABELS: Record<LeaveRecordDisplayStatus, string> = {
  upcoming: "即將開始",
  ongoing: "進行中",
  ended: "已結束",
  cancelled: "已取消",
};

// ---------------------------------------------------------------------------
// 4.4 排班一覽頁:單一儲存格的顯示優先權判斷(規格書 §4.4 第 2 點),抽成純函式方便 Vitest 測試,
// 不用整個渲染 SchedulingOverviewPage.tsx。
//
// 邊界情況說明(規格書 §3.8 明講這是唯讀彙整查詢,回傳格式不強制規定成固定格式,調整空間風險
// 低):「單日例外全天關閉」這裡採簡化判斷——這天原本會開放(無時段限制,或有設定當週固定時段)、
// 且這天至少有一段單日例外設定為關閉、且沒有任何一段例外設定為開啟,視為「臨時關閉」;不做逐分鐘
// 級的完整交集運算(那是行事曆頁面 CalendarPage.tsx 半小時格線才需要的精細度,排班一覽是總覽,
// 不是取代行事曆頁面看明細)。
// ---------------------------------------------------------------------------
export type ScheduleCellTone = "leave" | "closed" | "unset" | "normal";

export interface ScheduleCellDescription {
  tone: ScheduleCellTone;
  label: string;
}

export function describeScheduleCell(
  day: ScheduleOverviewDay,
  noTimeSlotLimit: boolean,
): ScheduleCellDescription {
  // 優先權 1:請假。
  if (day.on_leave) {
    return { tone: "leave", label: `休假:${day.on_leave.leave_type_name}` };
  }

  const hasAnyOpenOverride = day.overrides.some((o) => o.is_available);
  const hasAnyClosedOverride = day.overrides.some((o) => !o.is_available);
  const normallyOpen = noTimeSlotLimit || day.windows.length > 0;

  // 優先權 2:單日例外全天關閉(簡化判斷,見檔頭說明)。
  if (normallyOpen && hasAnyClosedOverride && !hasAnyOpenOverride) {
    return { tone: "closed", label: "臨時關閉" };
  }

  // 優先權 3:無時段設定。
  if (!normallyOpen && !hasAnyOpenOverride) {
    return { tone: "unset", label: "未設定" };
  }

  // 優先權 4:正常有時段,附上當天預約筆數。
  const windowsText = noTimeSlotLimit
    ? "不受時段限制"
    : day.windows
        .map((w) => `${(w.start_time ?? "").slice(0, 5)}-${(w.end_time ?? "").slice(0, 5)}`)
        .join("、");
  return { tone: "normal", label: `${windowsText}・${day.booking_count} 筆預約` };
}
