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
// 風險比在前端比對高;符合其他篩選條件的訂單本來就會一次全部載入到前端(查詢帶 unpaged:true,
// 見 OrdersPage.tsx),前端比對不會造成額外的資料量問題。分頁只發生在「畫面渲染」這一層
// (見下方 sliceBookingsForPage),不影響關鍵字比對的完整性。
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

// ---------------------------------------------------------------------------
// 2026-09-24 深夜巡檢問題 1 + 使用者裁決:訂單管理頁的「渲染上限」改成**真正的分頁**。
//
// 背景兩層,不要混為一談:
//   ① 資料層:這個頁面的查詢帶 unpaged:true,把符合篩選條件的訂單**全部**撈回來。這是為了讓
//      統計列的「共 N 筆訂單」「總業績」跟關鍵字搜尋(前端比對)都算在完整資料上,不會少報。
//      這一層這次完全不動。
//   ② 畫面層:每一筆訂單都會渲染成一張卡片,上萬張卡片會讓瀏覽器卡住。原本的做法是硬性截斷
//      (只畫最新 500 筆、更早的訂單看不到,只叫使用者縮小日期範圍)——使用者明確不接受,
//      要求改成「後面的都能看到,只是不要一次全部渲染」,所以這裡改成分頁切片:
//      每頁筆數可選(50/100/200/500),翻頁就看得到更早的訂單,一次仍然只渲染一頁的量。
//
// 排序基準跟 §7.3 目前選定的日期欄位一致(依建單時間/依預約時間),也就是跟分組標題用同一個
// 欄位,不會出現「分頁順序跟分組依據不一致」的錯亂。第 1 頁是**最新**的那一頁(手機使用者最常
// 看的就是最近的訂單),往後翻是更早的訂單。每一頁回傳的陣列會還原成「由舊到新」,跟
// fetchMerchantBookings 既有的 order by start_at ascending 一致,群組內的卡片順序不受影響。
// ---------------------------------------------------------------------------

/** 每頁筆數選項(使用者自選)。手機為主的產品,預設刻意取最小的 50。 */
export const ORDERS_PAGE_SIZE_OPTIONS = [50, 100, 200, 500] as const;

export type OrdersPageSize = (typeof ORDERS_PAGE_SIZE_OPTIONS)[number];

export const DEFAULT_ORDERS_PAGE_SIZE: OrdersPageSize = 50;

/** 每頁筆數的記憶(localStorage)。
 *
 * 刻意用**不含使用者 id** 的全域 key,跟 merchant/constants.ts 那條「使用者專屬狀態要依使用者 id
 * 分開存」的慣例不同,理由:那條慣例針對的是「會誤導/洩漏成別的帳號的資料」的狀態(例如目前操作
 * 中的商家 id,換帳號讀到舊值會看到不屬於自己的商家)。這裡存的只是「一頁畫幾張卡片」這個純顯示
 * 偏好,不含任何資料、也不會指向任何帳號或商家,同一台裝置上共用反而符合直覺(換帳號登入也不用
 * 重新調)。值不合法/讀不到(無痕視窗、瀏覽器封鎖 localStorage、舊版本殘留值)時一律退回
 * DEFAULT_ORDERS_PAGE_SIZE,不讓畫面因為一個偏好設定壞掉。 */
export const ORDERS_PAGE_SIZE_STORAGE_KEY = "miaoyue.ordersPageSize";

export function isOrdersPageSize(value: unknown): value is OrdersPageSize {
  return (
    typeof value === "number" && (ORDERS_PAGE_SIZE_OPTIONS as readonly number[]).includes(value)
  );
}

export function readStoredOrdersPageSize(): OrdersPageSize {
  try {
    const raw = window.localStorage.getItem(ORDERS_PAGE_SIZE_STORAGE_KEY);
    if (raw === null) return DEFAULT_ORDERS_PAGE_SIZE;
    const parsed = Number(raw);
    return isOrdersPageSize(parsed) ? parsed : DEFAULT_ORDERS_PAGE_SIZE;
  } catch {
    // 無痕視窗/瀏覽器封鎖 localStorage 時不擋畫面,直接用預設值。
    return DEFAULT_ORDERS_PAGE_SIZE;
  }
}

export function writeStoredOrdersPageSize(pageSize: OrdersPageSize): void {
  try {
    window.localStorage.setItem(ORDERS_PAGE_SIZE_STORAGE_KEY, String(pageSize));
  } catch {
    // 寫不進去就算了,只是下次進頁面要重選一次,不影響任何功能。
  }
}

export interface OrdersPageSlice<T> {
  /** 這一頁要渲染的訂單(由舊到新,跟後端既有排序方向一致)。 */
  bookings: T[];
  /** 實際採用的頁碼(1 起算,已經夾在 1 ~ totalPages 之間)。 */
  page: number;
  /** 總頁數,至少 1(總筆數 0 時也是 1,代表「第 1 / 1 頁、這一頁是空的」)。 */
  totalPages: number;
  /** 符合篩選條件的總筆數(全量,不是這一頁的筆數)。 */
  totalCount: number;
  /** 實際採用的每頁筆數(傳進來的值不合法時會退回預設值)。 */
  pageSize: number;
  /** 這一頁是全部訂單裡的第幾筆到第幾筆(1 起算,方便直接顯示給使用者)。總筆數 0 時兩者都是 0。 */
  rangeStart: number;
  rangeEnd: number;
}

/**
 * 把「全部訂單」切出目前這一頁要渲染的那些。純函式,沒有任何 React/瀏覽器依賴,§7.6 有單元測試。
 *
 * - `requestedPage` 超出範圍(小於 1、大於總頁數、NaN)一律夾回合法範圍,呼叫端直接用回傳的
 *   `page` 當作「目前頁碼」顯示與加減,不需要自己再寫一套校正,也不會出現停在空白第 5 頁的情況。
 * - `pageSize` 不合法(0、負數、NaN)時退回 DEFAULT_ORDERS_PAGE_SIZE,不會回傳空清單。
 */
export function sliceBookingsForPage<T extends { start_at: string; created_at: string }>(
  bookings: T[],
  dateField: OrderDateFieldMode,
  requestedPage: number,
  pageSize: number,
): OrdersPageSlice<T> {
  const totalCount = bookings.length;
  const size =
    Number.isFinite(pageSize) && pageSize >= 1
      ? Math.floor(pageSize)
      : (DEFAULT_ORDERS_PAGE_SIZE as number);
  const totalPages = Math.max(1, Math.ceil(totalCount / size));
  const page = clampOrdersPage(requestedPage, totalPages);

  if (totalCount === 0) {
    return {
      bookings: [],
      page,
      totalPages,
      totalCount,
      pageSize: size,
      rangeStart: 0,
      rangeEnd: 0,
    };
  }

  const startIndex = (page - 1) * size;
  const endIndex = Math.min(startIndex + size, totalCount);
  const pick = (b: T) => (dateField === "created_at" ? b.created_at : b.start_at);
  const pageBookings = bookings
    .slice()
    .sort((a, b) => (pick(a) < pick(b) ? 1 : pick(a) > pick(b) ? -1 : 0)) // 新到舊:第 1 頁最新
    .slice(startIndex, endIndex)
    .reverse(); // 還原成「由舊到新」,跟後端既有的排序方向一致

  return {
    bookings: pageBookings,
    page,
    totalPages,
    totalCount,
    pageSize: size,
    rangeStart: startIndex + 1,
    rangeEnd: endIndex,
  };
}

/** 頁碼夾回 1 ~ totalPages(NaN/非整數一律當成第 1 頁)。 */
export function clampOrdersPage(requestedPage: number, totalPages: number): number {
  const max = Math.max(1, Math.floor(totalPages) || 1);
  if (!Number.isFinite(requestedPage)) return 1;
  return Math.min(Math.max(1, Math.floor(requestedPage)), max);
}

/**
 * 每頁筆數改變時,頁碼要怎麼跟著調整。
 *
 * 做法:讓「目前這一頁的第一筆訂單」在新的每頁筆數下仍然落在畫面上(例如每頁 50 筆的第 3 頁
 * 是第 101 筆起,改成每頁 100 筆之後,第 101 筆落在第 2 頁,所以回傳 2)。這樣使用者調整每頁
 * 筆數時視線不會被彈到完全不相干的位置;第 1 頁永遠還是第 1 頁。
 * 回傳值仍可能大於新的總頁數(例如筆數變少),呼叫端不用擔心——sliceBookingsForPage 會再夾一次。
 */
export function adjustPageForPageSizeChange(
  page: number,
  previousPageSize: number,
  nextPageSize: number,
): number {
  if (!Number.isFinite(page) || page <= 1) return 1;
  if (!Number.isFinite(previousPageSize) || previousPageSize < 1) return 1;
  if (!Number.isFinite(nextPageSize) || nextPageSize < 1) return 1;
  const firstItemIndex = (Math.floor(page) - 1) * Math.floor(previousPageSize); // 0 起算
  return Math.floor(firstItemIndex / Math.floor(nextPageSize)) + 1;
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
