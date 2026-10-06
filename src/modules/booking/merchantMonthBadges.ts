// SPECS-INDEX #984(2026-10-07):商家端行事曆「月曆日期格兩色數字」的純函式(方便 Vitest 直接測)。
// 規格書:.project/specs/商家端月曆兩色數字.md。
//
// 名詞:畫面「待確認」= 資料庫 pending_confirmation;畫面「已確認」= 資料庫 accepted。
// 已完成、已取消、其他狀態一律不算(跟服務人員端 staffConfirmLogic.countDayStatusBadges 同一套規則)。
//
// 計算範圍 = 「目前行事曆畫面可見的服務人員」:跟時間軸欄位同一份名單(get_merchant_day_schedule 的
// merchant_staff.status = 'active',前端是 useMerchantStaffList,同一個篩選)。一張單只要「主要服務人員」
// 或「任何一位協助人員」在這份名單裡就算進去,而且**一張單只算一次**(同一張單同時出現在主要欄與協助欄
// 也不會因為協助人員重複計算)。

import type { Booking } from "./types";
import { isoToTaipeiDateKey } from "./dateUtils";

export interface DayStatusCounts {
  pending: number;
  accepted: number;
}

type BadgeBooking = Pick<Booking, "id" | "status" | "start_at" | "staff_id">;

/** 只有這兩種狀態會算進月曆數字。 */
function isCountedStatus(status: string): boolean {
  return status === "pending_confirmation" || status === "accepted";
}

/**
 * 哪些單需要另外查協助人員才知道算不算:狀態會被算、但主要服務人員不在可見名單裡的單
 * (例如主要服務人員已經停用,協助人員還在職)。主要服務人員可見的單不用查 —— 已經確定要算,
 * 查協助人員也不會讓它多算一次。可見名單還沒載入(null)時回空陣列(什麼都還不算)。
 */
export function bookingIdsNeedingAssistantLookup(
  bookings: readonly BadgeBooking[] | null | undefined,
  visibleStaffIds: ReadonlySet<string> | null | undefined,
): string[] {
  if (!visibleStaffIds) return [];
  const ids = new Set<string>();
  for (const b of bookings ?? []) {
    if (!isCountedStatus(b.status)) continue;
    if (visibleStaffIds.has(b.staff_id)) continue;
    ids.add(b.id);
  }
  return Array.from(ids).sort();
}

/**
 * 依日期(台北日期 YYYY-MM-DD,以開始時間為準)算兩色數字。
 * - visibleStaffIds 為 null / undefined(名單還沒載入)⇒ 回空 Map(寧可先不顯示,不要先顯示錯的數字)。
 * - assistantStaffIdsByBooking:booking id → 協助人員 staff id 清單;沒給或查無 ⇒ 視為沒有協助人員。
 * - 數量 0 的日期不會出現在 Map 裡;某一色是 0 由畫面決定不顯示那一顆。
 */
export function countMerchantDayStatusBadges(
  bookings: readonly BadgeBooking[] | null | undefined,
  visibleStaffIds: ReadonlySet<string> | null | undefined,
  assistantStaffIdsByBooking?: ReadonlyMap<string, readonly string[]> | null,
): Map<string, DayStatusCounts> {
  const result = new Map<string, DayStatusCounts>();
  if (!visibleStaffIds) return result;
  const seen = new Set<string>();
  for (const b of bookings ?? []) {
    if (seen.has(b.id)) continue;
    if (!isCountedStatus(b.status)) continue;
    const primaryVisible = visibleStaffIds.has(b.staff_id);
    const assistantVisible =
      !primaryVisible &&
      (assistantStaffIdsByBooking?.get(b.id) ?? []).some((sid) => visibleStaffIds.has(sid));
    if (!primaryVisible && !assistantVisible) continue;
    seen.add(b.id);
    const key = isoToTaipeiDateKey(b.start_at);
    const counts = result.get(key) ?? { pending: 0, accepted: 0 };
    if (b.status === "pending_confirmation") counts.pending += 1;
    else counts.accepted += 1;
    result.set(key, counts);
  }
  return result;
}
