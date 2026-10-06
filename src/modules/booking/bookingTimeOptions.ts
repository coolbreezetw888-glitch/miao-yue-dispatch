// SPECS-INDEX #980:建單 / 改單「日期時間」選單只列出能約的開始時間 —— 前端這一側的純邏輯。
//
// ─── 分工 ──────────────────────────────────────────────────────────────────────
// 「哪些起點能約」**全部由資料庫決定**(public.list_staff_bookable_start_times,逐格呼叫送出時
// 真正擋時段的 private.check_staff_booking_slot),營業時間 / 每週時段 / 單日例外 / 請假 /
// 無時段限制 / 嚴格衝突 / 同集團跨店 / 編輯時排除自己,這些規則的測試在 pgTAP
// (supabase/tests/database/req980_01_list_staff_bookable_start_times.sql)。
// 這個檔案只處理「前端要決定的事」:要拿多長的工時去問、畫面該顯示哪一種狀態、
// 原本選的時間變得不能選時要不要清掉。
//
// 取代了舊的 bookingSlotOptions.ts(第 2 批已刪除;前端自己用 available_windows / overrides 算)——那份只看
// 營業時間、每週時段、單日排休與整天請假,**沒有**看既有訂單、無時段限制、單日例外開啟,
// 跟送出時的後端檢查對不起來(規格書第二節第 5 點要求兩邊一致)。

/** 跟 CalendarPage 的 SLOT_MINUTES 一致:一格 30 分鐘。 */
export const BOOKING_TIME_SLOT_MINUTES = 30;
/** 資料庫函式接受的工時上限(一天)。 */
export const BOOKING_TIME_MAX_DURATION_MINUTES = 1440;

export const TIME_NO_LONGER_AVAILABLE_MESSAGE = "這個時間已無法預約，請重新選擇";
export const NO_BOOKABLE_TIME_MESSAGE = "這天沒有可預約的時間";

/**
 * 要拿多長的工時去問「哪些起點能約」。
 *   - 還沒選任何項目(0 分鐘)/ 自訂工時還沒填好:用一格 30 分鐘問 —— 至少這一格要能約,
 *     跟行事曆主畫面「這格是不是灰的」一致。
 *   - 自訂工時可能填小數:無條件進位成整數分鐘(資料庫參數是 integer;多算不到一分鐘只會更保守)。
 *   - 超過一天(1440 分鐘):後端本來就約不進去 ⇒ 回 null,畫面直接顯示「這天沒有可預約的時間」。
 */
export function resolveSlotQueryDuration(totalDurationMinutes: number): number | null {
  if (!Number.isFinite(totalDurationMinutes) || totalDurationMinutes <= 0) {
    return BOOKING_TIME_SLOT_MINUTES;
  }
  const minutes = Math.ceil(totalDurationMinutes);
  if (minutes > BOOKING_TIME_MAX_DURATION_MINUTES) return null;
  return minutes;
}

export type BookingTimePanelState =
  | { kind: "need-staff" }
  | { kind: "need-date" }
  | { kind: "on-leave"; leaveTypeName: string }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "empty" }
  | { kind: "list"; options: string[] };

/**
 * 時段清單區塊要顯示什麼。順序就是判斷優先序:
 *   沒選服務人員 → 沒選日期 → 整天請假(講清楚假別,比「沒有可約時間」好懂)→ 載入中 → 查詢失敗 →
 *   工時超過一天 / 清單是空的 → 列出時間。
 * 「尚未選服務人員」維持改版前的行為(顯示「請先選擇服務人員」),見回報。
 */
export function resolveBookingTimePanelState(input: {
  staffId: string;
  dateKey: string;
  leaveTypeName: string | null;
  queryDuration: number | null;
  isLoading: boolean;
  isError: boolean;
  options: string[] | undefined;
}): BookingTimePanelState {
  if (!input.staffId) return { kind: "need-staff" };
  if (!input.dateKey) return { kind: "need-date" };
  if (input.leaveTypeName !== null) return { kind: "on-leave", leaveTypeName: input.leaveTypeName };
  if (input.queryDuration === null) return { kind: "empty" };
  if (input.isLoading) return { kind: "loading" };
  if (input.isError || input.options === undefined) return { kind: "error" };
  if (input.options.length === 0) return { kind: "empty" };
  return { kind: "list", options: input.options };
}

/**
 * 規格書第二節第 4 點:改了日期、服務人員或項目之後,原本選的時間如果變成不能選,要清空並提示。
 *
 * - 只有在「這次的清單已經確定拿到」(不是載入中、不是查詢失敗)才判斷 —— 查詢失敗時清掉使用者的
 *   選擇會讓人以為系統亂改資料。
 * - `keepOriginal`:編輯既有訂單、而且服務人員 / 日期 / 時間 / 工時都還是這筆訂單原本的值 ⇒ 不清。
 *   (清單已經排除自己了,正常情況本來就列得出來;這是保險:例如商家事後改了營業時間,
 *   客服只是進來改個電話,不應該一打開表單時間就被清掉。送出時後端會照常檢查。)
 */
export function shouldClearSelectedTime(input: {
  time: string;
  state: BookingTimePanelState;
  keepOriginal: boolean;
}): boolean {
  if (!input.time || input.keepOriginal) return false;
  if (input.state.kind === "list") return !input.state.options.includes(input.time);
  if (input.state.kind === "empty" || input.state.kind === "on-leave") return true;
  return false;
}

/** 編輯既有訂單時,目前的選擇是不是還是這筆訂單原本的值(給 shouldClearSelectedTime 的 keepOriginal)。 */
export function isOriginalBookingSelection(input: {
  original: { staffId: string; dateKey: string; time: string; durationMinutes: number } | null;
  staffId: string;
  dateKey: string;
  time: string;
  durationMinutes: number;
}): boolean {
  const o = input.original;
  if (!o) return false;
  return (
    o.staffId === input.staffId &&
    o.dateKey === input.dateKey &&
    o.time === input.time &&
    o.durationMinutes === input.durationMinutes
  );
}

/**
 * 主腦裁決(第 2 批第 3 項):時間被自動清空時,要不要顯示「這個時間已無法預約，請重新選擇」。
 *   ・使用者自己選的時間(含行事曆點格子進來、編輯既有訂單的原時間)⇒ 要提示,不然他會以為自己選的還在
 *   ・系統自動帶的預設值(按「新增預約」帶的 10:00)⇒ 安靜清空,只顯示一般的「請選擇日期時間」佔位
 */
export function shouldShowTimeClearedNotice(timeChosenByUser: boolean): boolean {
  return timeChosenByUser;
}

/**
 * SPECS-INDEX #980 追加:時間選單打開時要捲到哪一個時間附近(間隔 5 分鐘時一天有 288 個,不捲會停在 00:00)。
 *   ・目前選的時間在清單裡 ⇒ 就是它
 *   ・不在(例如剛被清空、或還沒選)⇒ 第一個 ≥ 目前時間的;目前時間是空的 ⇒ 第一個 ≥ 09:00 的(一般營業開始附近)
 *   ・都沒有 ⇒ 最後一個;清單是空的 ⇒ null
 * 時間字串都是「HH:MM」,可以直接用字串比大小。
 */
export function resolveScrollAnchorTime(options: string[], time: string): string | null {
  if (options.length === 0) return null;
  if (time && options.includes(time)) return time;
  const target = time || "09:00";
  return options.find((t) => t >= target) ?? options[options.length - 1]!;
}
