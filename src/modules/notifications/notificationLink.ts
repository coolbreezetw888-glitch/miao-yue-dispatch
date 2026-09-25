// 站內通知中心(鈴鐺)的純函式:目的地解析、多身份合併顯示、未讀 badge 文字。
// 對應規格書 §13.5 / §13.7 / §13.11。全部是純函式,方便 Vitest 直接測。

import {
  NOTIFICATION_TARGET_TYPES,
  type MergedNotification,
  type NotificationTargetType,
  type UserNotification,
} from "./types";

/**
 * §13.7 第 3 點 / §5.5:收件人身份 → 點一列之後要去哪裡。
 *
 * ⚠️ 這張對照表在這個專案裡總共有**三份實作**,這是刻意的,不是漏收斂:
 *   ① supabase/functions/_shared/pushDispatchCore.ts 的 PUSH_TARGET_URLS(Deno,組推播 payload)
 *   ② src/modules/push-notifications/pushPayload.ts 的 PUSH_TARGET_URLS(Vite,service worker 邏輯的
 *      純函式版本)
 *   ③ 這一份(Vite,鈴鐺點擊導航)
 *
 *   ①跟②之所以不共用,是因為兩個執行環境不共用程式碼(既有先例見 pushPayload.ts 檔頭與模組 11
 *   判斷 11)。②跟③之所以分開,是 §13.11 要求「通知中心不知道推播的存在」的模組獨立性。
 *
 * 🔴 三份不可以靜默分岔。防護做法:notificationLink.test.ts 有一條測試**直接 import
 *    push-notifications 的 PUSH_TARGET_URLS**,逐一比對三種角色的結果必須相同。
 *    所以只要有人改了其中一份、忘了另一份,那條測試就會紅。
 */
export const NOTIFICATION_TARGET_URLS: Record<NotificationTargetType, string> = {
  staff: "/app/calendar",
  admin: "/app/orders",
  agent: "/app/orders",
};

/** §4.7 第 4 點:唯一允許的 fallback(這個路由一定存在,HomePage 本身會依角色自動導到落點)。 */
export const NOTIFICATION_FALLBACK_URL = "/app";

/**
 * §13.7:算出「點這一列之後要去哪裡」。
 * 刻意只吃 target_type 一個欄位 —— 深層連結(點進去直接開那一筆訂單)v1 不做,
 * `booking_id` 已經存進資料庫了,之後要做只是改這支函式,不用動資料庫(§13.7 最後一段)。
 */
export function resolveNotificationLink(input: { target_type: string | null | undefined }): string {
  const targetType = input.target_type;
  if (!targetType) return NOTIFICATION_FALLBACK_URL;
  return (
    NOTIFICATION_TARGET_URLS[targetType as NotificationTargetType] ?? NOTIFICATION_FALLBACK_URL
  );
}

/**
 * §5.5 / §13.7:同一列合併了兩個身份時,用哪一個身份算目的地。
 * 優先權 admin > agent > staff,跟 useMerchantRole 與 Edge Function 的 PUSH_TARGET_PRIORITY
 * 完全一致,不另發明一套。
 */
export const NOTIFICATION_TARGET_PRIORITY: Record<NotificationTargetType, number> = {
  admin: 3,
  agent: 2,
  staff: 1,
};

function isKnownTargetType(value: string): value is NotificationTargetType {
  return (NOTIFICATION_TARGET_TYPES as readonly string[]).includes(value);
}

/** 同一分鐘 = 把 ISO 時間字串截到分鐘。用 Date 取值而不是字串切片,才不會被時區寫法差異騙。 */
function minuteBucket(createdAt: string): string {
  const time = new Date(createdAt).getTime();
  if (Number.isNaN(time)) return `raw:${createdAt}`;
  return String(Math.floor(time / 60_000));
}

/**
 * §13.2 邊界情況 / §13.7:**顯示層**合併,資料層一個字都不動。
 *
 * 為什麼需要它:同一個人在同一間商家同時是客服又是服務人員時(`goldtw2021` 的實際情形),
 * 一個事件會產生**兩列**站內通知(一個身份一列,跟 push_notification_log 一致),但手機上只會
 * 跳一則(§4.3 的 endpoint 去重)。如果鈴鐺照原樣列出兩列、標題還一模一樣,使用者會以為系統
 * 重複發送。
 *
 * 合併條件(四個都要相同):`merchant_id` + `booking_id` + `event_type` + **同一分鐘**。
 * 刻意用「同一分鐘」而不是「時間完全相等」:兩列是兩次獨立的 insert,`created_at` 預設值
 * `now()` 在同一個 statement 內才保證相同,跨 statement 會差幾毫秒到幾秒。
 *
 * 回傳順序維持「最新的在前」(輸入本來就是 created_at desc,合併後用代表列的時間重新排一次,
 * 避免呼叫端傳進未排序的資料時結果不可預期)。
 */
export function mergeNotificationRows(rows: UserNotification[]): MergedNotification[] {
  const groups = new Map<string, MergedNotification>();

  for (const row of rows) {
    const groupKey = [
      row.merchant_id,
      row.booking_id ?? "no-booking",
      row.event_type,
      minuteBucket(row.created_at),
    ].join("|");

    const targetType = isKnownTargetType(row.target_type)
      ? (row.target_type as NotificationTargetType)
      : null;

    const existing = groups.get(groupKey);
    if (!existing) {
      groups.set(groupKey, {
        ids: [row.id],
        key: row.id,
        merchant_id: row.merchant_id,
        booking_id: row.booking_id,
        event_type: row.event_type,
        title: row.title,
        body: row.body,
        targetTypes: targetType ? [targetType] : [],
        primaryTargetType: targetType ?? "staff",
        created_at: row.created_at,
        read_at: row.read_at,
      });
      continue;
    }

    existing.ids.push(row.id);
    if (targetType && !existing.targetTypes.includes(targetType)) {
      existing.targetTypes.push(targetType);
    }
    // 只要還有任何一列未讀,整列就算未讀 —— 未讀圓點要提醒的是「這件事你還沒看過」。
    if (row.read_at === null) existing.read_at = null;
    // 代表列 = 最新的那一列(時間較新者勝),這樣相對時間顯示的是最後一次發生的時間。
    if (new Date(row.created_at).getTime() > new Date(existing.created_at).getTime()) {
      existing.created_at = row.created_at;
      existing.key = row.id;
      existing.title = row.title;
      existing.body = row.body;
    }
  }

  const merged = [...groups.values()];
  for (const item of merged) {
    // 固定顯示順序 admin → agent → staff,不受輸入順序影響(顯示文字與測試斷言才穩定)。
    item.targetTypes.sort(
      (a, b) => NOTIFICATION_TARGET_PRIORITY[b] - NOTIFICATION_TARGET_PRIORITY[a],
    );
    item.primaryTargetType = item.targetTypes[0] ?? item.primaryTargetType;
  }
  merged.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return merged;
}

/**
 * §13.5 顯示規則:0 → 不顯示 badge(回 null);1~99 → 數字;≥100 → `99+`。
 * 回 null 而不是空字串,是為了讓呼叫端用 `=== null` 明確判斷「不要渲染那個節點」。
 */
export function formatUnreadBadgeText(count: number | null | undefined): string | null {
  if (count === null || count === undefined) return null;
  if (!Number.isFinite(count) || count <= 0) return null;
  if (count >= 100) return "99+";
  return String(Math.floor(count));
}

/**
 * §13.7:每一列右側的相對時間。「3 分鐘前」/「昨天 14:30」這種白話寫法。
 * 刻意自己寫一小支,不引進 date-fns 的 locale 設定 —— 這個專案的日期顯示一向是自己組字串
 * (見 src/modules/booking/dateUtils.ts),而這裡只需要五種說法。
 */
export function formatRelativeNotificationTime(createdAt: string, now: Date = new Date()): string {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return "";

  const diffMs = now.getTime() - created.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) return "剛剛";
  if (diffMinutes < 60) return `${diffMinutes} 分鐘前`;

  const hhmm = `${String(created.getHours()).padStart(2, "0")}:${String(
    created.getMinutes(),
  ).padStart(2, "0")}`;

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const createdDayStart = new Date(
    created.getFullYear(),
    created.getMonth(),
    created.getDate(),
  ).getTime();
  const dayDiff = Math.round((startOfToday - createdDayStart) / 86_400_000);

  if (dayDiff <= 0) return hhmm;
  if (dayDiff === 1) return `昨天 ${hhmm}`;
  return `${created.getMonth() + 1}/${created.getDate()} ${hhmm}`;
}
