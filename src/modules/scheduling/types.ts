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
// 2026-09-24 深夜巡檢修正(問題 3、問題 4),這兩條原本都不是刻意的取捨(舊註解寫「簡化判斷,見
// 檔頭說明」,但檔頭從來沒有對應的說明文字):
//
//   問題 3:規格書 §4.4 第 2 點的優先權 2 原文是「單日例外**全天**關閉」,強調的是「全天」。舊版
//   只要「這天有任何一段關閉的單日例外、且沒有任何一段開啟的例外」就判定成整天「臨時關閉」,於是
//   某位服務人員 09:00-18:00 正常上班、只把 14:00-14:30 這一格點成關閉時,排班一覽會整格變成
//   「臨時關閉」,原本該顯示的「09:00-18:00・N 筆預約」整個消失,管理員會誤以為這位服務人員整天
//   不能排工作(實際上他還有 8.5 小時可接單)。改成真正的「時間覆蓋」判斷:把「原本可預約的時間
//   範圍」扣掉「關閉的時間範圍」之後,一分鐘都不剩才算全天關閉;只關掉其中一部分時,照常走優先權
//   4 顯示時段+預約筆數,另外附一個輕量標記「部分時段臨時關閉」提醒管理員這天有例外。
//
//   問題 4:只有單日例外開啟、沒有每週固定時段的那天(管理員臨時把某天 10:00-12:00 打開),舊版
//   落到優先權 4 時 day.windows 是空陣列,windowsText 變成空字串,畫面顯示成開頭掛著一個頓號的
//   「・0 筆預約」,完全看不出這天其實被臨時開放了。改成 windows 為空時改用 is_available=true 的
//   單日例外區間文字,並標示「(臨時開放)」。
//
// 這裡做的是「當天之內、以分鐘為單位」的區間交集/差集運算,不跨日、不查資料庫,仍然是純函式
// (§3.8 是唯讀彙整查詢,回傳格式不強制規定成固定格式,在前端多算一層沒有資料正確性風險)。
// ---------------------------------------------------------------------------
export type ScheduleCellTone = "leave" | "closed" | "unset" | "normal";

export interface ScheduleCellDescription {
  tone: ScheduleCellTone;
  label: string;
}

const MINUTES_PER_DAY = 24 * 60;

/** 當天之內的一段時間區間,單位是「從當天 00:00 起算的分鐘數」,end 不含(半開區間)。 */
interface MinuteRange {
  start: number;
  end: number;
}

function parseTimeToMinutes(value: string): number {
  const parts = value.slice(0, 5).split(":");
  const h = Number(parts[0] ?? 0);
  const m = Number(parts[1] ?? 0);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return Number.NaN;
  return h * 60 + m;
}

/** 把 'HH:MM:SS' 的起訖時間轉成分鐘區間。結束時間 <= 開始時間視為「跨到隔天 00:00」,一律當成
 * 當天結束(24:00)——後端 3.8 合併相鄰半小時格子時用的是 `max(slot_start_time) + 30 minutes`,
 * 最後一格 23:30 加 30 分鐘在 PostgreSQL 的 time 型別會繞回 '00:00:00',不特別處理的話整天關閉
 * 會被算成長度 0。 */
function toMinuteRange(
  startTime: string | undefined,
  endTime: string | undefined,
): MinuteRange | null {
  if (!startTime || !endTime) return null;
  const start = parseTimeToMinutes(startTime);
  const rawEnd = parseTimeToMinutes(endTime);
  if (Number.isNaN(start) || Number.isNaN(rawEnd)) return null;
  const end = rawEnd <= start ? MINUTES_PER_DAY : rawEnd;
  if (end <= start) return null;
  return { start, end };
}

/** 排序後合併重疊/相鄰的區間(聯集)。 */
function mergeRanges(ranges: MinuteRange[]): MinuteRange[] {
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  const merged: MinuteRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** base 扣掉 cuts(差集)。 */
function subtractRanges(base: MinuteRange[], cuts: MinuteRange[]): MinuteRange[] {
  let remaining = base.map((r) => ({ ...r }));
  for (const cut of cuts) {
    const next: MinuteRange[] = [];
    for (const range of remaining) {
      if (cut.end <= range.start || cut.start >= range.end) {
        next.push(range);
        continue;
      }
      if (cut.start > range.start) next.push({ start: range.start, end: cut.start });
      if (cut.end < range.end) next.push({ start: cut.end, end: range.end });
    }
    remaining = next;
  }
  return remaining;
}

function totalMinutes(ranges: MinuteRange[]): number {
  return ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0");
  const m = (minutes % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

function formatRanges(ranges: MinuteRange[]): string {
  return ranges.map((r) => `${formatMinutes(r.start)}-${formatMinutes(r.end)}`).join("、");
}

function collectRanges(items: { start_time?: string; end_time?: string }[]): MinuteRange[] {
  const ranges: MinuteRange[] = [];
  for (const item of items) {
    const range = toMinuteRange(item.start_time, item.end_time);
    if (range) ranges.push(range);
  }
  return mergeRanges(ranges);
}

export function describeScheduleCell(
  day: ScheduleOverviewDay,
  noTimeSlotLimit: boolean,
): ScheduleCellDescription {
  // 優先權 1:請假。
  if (day.on_leave) {
    return { tone: "leave", label: `休假:${day.on_leave.leave_type_name}` };
  }

  const openOverrideRanges = collectRanges(day.overrides.filter((o) => o.is_available));
  const closedOverrideRanges = collectRanges(day.overrides.filter((o) => !o.is_available));

  // 「原本可預約」的時間範圍:不受時段限制 = 整天(00:00-24:00);否則 = 當天的每週固定時段。
  const baseOpenRanges = noTimeSlotLimit
    ? [{ start: 0, end: MINUTES_PER_DAY }]
    : collectRanges(day.windows);
  // 實際上這天會開放的時間 = 每週固定時段 ∪ 單日例外開啟的時段。
  const effectiveOpenRanges = mergeRanges([...baseOpenRanges, ...openOverrideRanges]);
  const remainingOpenRanges = subtractRanges(effectiveOpenRanges, closedOverrideRanges);
  const remainingMinutes = totalMinutes(remainingOpenRanges);

  const normallyOpen = baseOpenRanges.length > 0;
  const hasAnyOpenOverride = openOverrideRanges.length > 0;

  // 優先權 2:單日例外「全天」關閉——原本會開放的時間被例外整段吃光,一分鐘都不剩。
  if (effectiveOpenRanges.length > 0 && closedOverrideRanges.length > 0 && remainingMinutes <= 0) {
    return { tone: "closed", label: "臨時關閉" };
  }

  // 優先權 3:無時段設定。
  if (!normallyOpen && !hasAnyOpenOverride) {
    return { tone: "unset", label: "未設定" };
  }

  // 優先權 4:正常有時段,附上當天預約筆數。
  let scheduleText: string;
  if (noTimeSlotLimit) {
    scheduleText = "不受時段限制";
  } else if (day.windows.length > 0) {
    // 沿用改版前的顯示格式:直接照 windows 原本的順序逐段列出,不做合併(合併只用在上面的
    // 「全天關閉/部分關閉」判斷,不改變既有的畫面文字)。
    scheduleText = day.windows
      .map((w) => `${(w.start_time ?? "").slice(0, 5)}-${(w.end_time ?? "").slice(0, 5)}`)
      .join("、");
  } else {
    // 問題 4:這天沒有每週固定時段,只有單日例外把某幾段臨時打開。
    scheduleText = `${formatRanges(openOverrideRanges)}(臨時開放)`;
  }

  const parts = [`${scheduleText}・${day.booking_count} 筆預約`];
  // 問題 3:關掉一部分(但沒關完)時,照常顯示時段,另外附一個輕量標記。
  if (closedOverrideRanges.length > 0 && totalMinutes(effectiveOpenRanges) > remainingMinutes) {
    parts.push("部分時段臨時關閉");
  }
  return { tone: "normal", label: parts.join("・") };
}
