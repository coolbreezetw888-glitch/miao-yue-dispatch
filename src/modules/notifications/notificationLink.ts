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

/**
 * 客戶端第 2 批:跟訂單無關的鈴鐺事件,點了直接去對應的頁面(不看身份)。
 * member_line_login_linked(會員用 LINE 登入接上)⇒ 會員列表。推播沒有這個事件,所以不影響上面三份對照表的一致性。
 */
export const EVENT_TARGET_URLS: Readonly<Record<string, string>> = {
  member_line_login_linked: "/app/members",
};

/** §4.7 第 4 點:唯一允許的 fallback(這個路由一定存在,HomePage 本身會依角色自動導到落點)。 */
export const NOTIFICATION_FALLBACK_URL = "/app";

/**
 * §13.7:算出「點這一列之後要去哪裡」。
 * 刻意只吃 target_type 一個欄位 —— 深層連結(點進去直接開那一筆訂單)v1 不做,
 * `booking_id` 已經存進資料庫了,之後要做只是改這支函式,不用動資料庫(§13.7 最後一段)。
 */
export function resolveNotificationLink(input: {
  target_type: string | null | undefined;
  /** 客戶端第 2 批:少數「跟訂單無關」的事件有自己的目的地(見 EVENT_TARGET_URLS)。 */
  event_type?: string | null | undefined;
}): string {
  const byEvent = input.event_type ? EVENT_TARGET_URLS[input.event_type] : undefined;
  if (byEvent) return byEvent;
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

  const merged = absorbCompletedCancellationDuplicates([...groups.values()]);
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
 * SPECS-INDEX #997 第 11 批 H:取消「已完成」訂單時,資料庫先寫一則 `booking_completed_cancelled`;
 * 管理員若打開「同時發送取消通知」,前端在 RPC 成功後才呼叫推播,Edge Function 再寫一則
 * `booking_cancelled`。兩則講的是同一件事 ⇒ **只在鈴鐺畫面**併成一則(資料庫兩列都保留,
 * Edge Function 不用動、不用重新部署)。
 */
export const COMPLETED_CANCELLATION_MERGE_WINDOW_MS = 120_000;

/**
 * 吸收規則(§15.4):某組 `booking_cancelled`,若有一組 `booking_completed_cancelled` 是同 `merchant_id` +
 * 同 `booking_id`,且 `booking_cancelled` 那組的時間比它**晚 0 ~ 120 秒**(資料庫那則一定先寫)⇒
 * 把 `booking_cancelled` 組的 ids 併進去(點一下兩列都標已讀;任一列未讀就算未讀;身份聯集),
 * 畫面只顯示 `booking_completed_cancelled` 那組的標題 / 內文 / 時間。不符合條件就各自顯示。
 */
function absorbCompletedCancellationDuplicates(groups: MergedNotification[]): MergedNotification[] {
  const completed = groups.filter(
    (g) => g.event_type === "booking_completed_cancelled" && g.booking_id !== null,
  );
  if (completed.length === 0) return groups;

  const absorbed = new Set<MergedNotification>();
  for (const group of groups) {
    if (group.event_type !== "booking_cancelled" || group.booking_id === null) continue;
    const cancelledAt = new Date(group.created_at).getTime();
    if (Number.isNaN(cancelledAt)) continue;

    let target: MergedNotification | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const candidate of completed) {
      if (candidate.merchant_id !== group.merchant_id) continue;
      if (candidate.booking_id !== group.booking_id) continue;
      const diff = cancelledAt - new Date(candidate.created_at).getTime();
      if (Number.isNaN(diff) || diff < 0 || diff > COMPLETED_CANCELLATION_MERGE_WINDOW_MS) continue;
      if (diff < bestDiff) {
        bestDiff = diff;
        target = candidate;
      }
    }
    if (!target) continue;

    target.ids.push(...group.ids);
    if (group.read_at === null) target.read_at = null;
    for (const t of group.targetTypes) {
      if (!target.targetTypes.includes(t)) target.targetTypes.push(t);
    }
    absorbed.add(group);
  }

  return absorbed.size === 0 ? groups : groups.filter((g) => !absorbed.has(g));
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

/**
 * SPECS-INDEX #977 第 4 批:只會出現在鈴鐺、推播設定沒有的事件標籤。刻意不加進 push-notifications 的
 * PUSH_NOTIFICATION_EVENT_LABELS —— 那份清單同時決定推播設定頁要畫幾張事件卡,加進去會多出一張不能用的卡片。
 */
export const BELL_ONLY_EVENT_LABELS: Readonly<Record<string, string>> = {
  booking_confirmed: "服務人員確認接單時",
  // SPECS-INDEX #997 第 11 批 H:由資料庫寫給其他管理員與有訂單管理權限的在職客服(純站內,推播設定沒有)。
  booking_completed_cancelled: "已完成訂單被取消時",
  booking_completed_reverted: "已完成訂單被還原時",
  // 客戶端第 2 批(零之二第 1 點):客人用 LINE 登入接上「既有」會員時,資料庫寫給管理員與有會員權限的客服(純站內)。
  member_line_login_linked: "會員用 LINE 登入接上時",
};

/**
 * SPECS-INDEX #1019 第 21 批:「已完成訂單被取消 / 被還原」這兩種通知的內文(含原因)在鈴鐺清單裡**完整換行顯示**,
 * 不再截成一行「…」。其他通知種類照舊一行截斷(排版不變)。
 * 鈴鐺把重複的 booking_cancelled 併進 booking_completed_cancelled 時,畫面顯示的是後者的 event_type ⇒ 一樣會換行。
 */
const BELL_FULL_BODY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "booking_completed_cancelled",
  "booking_completed_reverted",
]);

export function shouldWrapNotificationBody(eventType: string): boolean {
  return BELL_FULL_BODY_EVENT_TYPES.has(eventType);
}

/** SPECS-INDEX #977 第 4 批:服務人員視角鈴鐺頂端的待確認提醒文字。 */
export function formatStaffPendingReminder(count: number): string {
  return `你有 ${count} 筆訂單待確認`;
}
