// 建單與訂單管理介面優化 §7:訂單管理頁(OrdersPage.tsx)重新設計用到的純函式邏輯。
// 抽成獨立檔案(不寫進 OrdersPage.tsx 裡)是為了讓分頁籤篩選/關鍵字比對範圍/日期分組/
// 業績加總這幾條邏輯可以直接寫 Vitest,不用整個渲染頁面元件(比照 dateUtils.ts/orderAmount.ts
// 既有的抽離慣例)。這支檔案刻意不 import 任何會建立 supabase client 的模組(api.ts/context.tsx),
// 只依賴 dateUtils.ts/types.ts 這兩個純函式/純型別檔案,確保 Vitest 匯入時不會意外觸發
// supabase client 初始化(缺環境變數時會直接 throw,見 integrations/supabase/client.ts)。

import { isoToTaipeiDateKey, isoToTaipeiTime } from "./dateUtils";
import { BOOKING_STATUS_LABELS, type Booking, type BookingStatus } from "./types";

// ---------------------------------------------------------------------------
// §7.1:狀態分頁籤。
// ---------------------------------------------------------------------------

export type OrderStatusTab =
  "all" | "pending_confirmation" | "accepted" | "completed" | "cancelled";

export const ORDER_STATUS_TABS: { key: OrderStatusTab; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "pending_confirmation", label: BOOKING_STATUS_LABELS.pending_confirmation },
  { key: "accepted", label: BOOKING_STATUS_LABELS.accepted },
  { key: "completed", label: BOOKING_STATUS_LABELS.completed },
  { key: "cancelled", label: BOOKING_STATUS_LABELS.cancelled },
];

/** 分頁籤 -> 要傳給 fetchMerchantBookings 的 status 篩選陣列。「全部」回傳 undefined,
 * 代表不限狀態(呼叫端據此決定要不要帶 status 篩選參數)。 */
export function tabToStatusFilter(tab: OrderStatusTab): BookingStatus[] | undefined {
  if (tab === "all") return undefined;
  return [tab];
}

// ---------------------------------------------------------------------------
// §7.3:依建單時間/依預約時間切換。
// ---------------------------------------------------------------------------

export type OrderDateFieldMode = "created_at" | "start_at";

// ---------------------------------------------------------------------------
// §7.2:關鍵字搜尋比對範圍——姓名/電話/地址/單號(id)/備註(內部備註+客戶備註),模糊比對,
// 符合任一欄位就算命中。刻意在前端比對(不是資料庫層 ilike 疊加),原因見 api.ts
// fetchMerchantBookings 的說明:id 是 uuid 型別,直接對 uuid 欄位做 ilike 需要額外的型別轉換,
// 風險比在前端比對高;§7.4 本來就不做真正分頁,符合其他篩選條件的訂單本來就會一次全部載入到
// 前端,前端比對不會造成額外的資料量問題。
// ---------------------------------------------------------------------------

export interface KeywordMatchableBooking {
  id: string;
  customer_name: string;
  customer_phone: string;
  customer_address: string | null;
  notes: string | null;
  customer_notes: string | null;
}

export function bookingMatchesKeyword(
  booking: KeywordMatchableBooking,
  rawKeyword: string,
): boolean {
  const keyword = rawKeyword.trim().toLowerCase();
  if (!keyword) return true;
  const haystacks = [
    booking.id,
    booking.customer_name,
    booking.customer_phone,
    booking.customer_address,
    booking.notes,
    booking.customer_notes,
  ];
  return haystacks.some((value) => (value ?? "").toLowerCase().includes(keyword));
}

// ---------------------------------------------------------------------------
// §7.4:業績加總——不含已取消訂單。訂單筆數(N)不受這裡影響,呼叫端直接用篩選結果陣列的
// length,取消的訂單如果符合目前分頁籤/篩選條件一樣算進筆數,只是金額不計入這裡的加總。
// ---------------------------------------------------------------------------

export function sumBookingRevenue(
  bookings: Pick<Booking, "status" | "final_amount_snapshot">[],
): number {
  return bookings.reduce((sum, b) => {
    if (b.status === "cancelled") return sum;
    return sum + (b.final_amount_snapshot ?? 0);
  }, 0);
}

// ---------------------------------------------------------------------------
// §7.5:依日期分組(依 §7.3 選定的日期欄位),日期新到舊排序。
// ---------------------------------------------------------------------------

export interface OrderDateGroup<T> {
  dateKey: string;
  bookings: T[];
}

export function groupBookingsByDateField<T extends { start_at: string; created_at: string }>(
  bookings: T[],
  dateField: OrderDateFieldMode,
): OrderDateGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const b of bookings) {
    const iso = dateField === "created_at" ? b.created_at : b.start_at;
    const key = isoToTaipeiDateKey(iso);
    const list = map.get(key);
    if (list) list.push(b);
    else map.set(key, [b]);
  }
  return Array.from(map.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)) // 日期新到舊
    .map(([dateKey, list]) => ({ dateKey, bookings: list }));
}

/** 分組標題格式,例如「9/9(三)」。 */
export function formatGroupDateHeading(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00`);
  const weekday = "日一二三四五六"[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}(${weekday})`;
}

/** 卡片上「M/D(週幾) HH:mm」格式的日期時間顯示(不含秒數,秒數精度只給建單時間用,
 * 見 dateUtils.ts isoToTaipeiDateTimeWithSeconds 的說明)。 */
export function formatCardDateTime(iso: string): string {
  const dateKey = isoToTaipeiDateKey(iso);
  return `${formatGroupDateHeading(dateKey)} ${isoToTaipeiTime(iso)}`;
}
