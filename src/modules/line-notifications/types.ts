// 模組 11(LINE 通知)共用型別/常數。比照模組 7/8/10 的既有慣例,`Tables<...>` 直接沿用
// Supabase 產生的資料表型別,不重複手刻欄位。

import type { Tables } from "@/integrations/supabase/types";

export type MerchantLineEventSetting = Tables<"merchant_line_event_settings">;
export type LineNotificationLogRow = Tables<"line_notification_log">;

/** 1.2:五種通知事件的固定清單(對應 event_type CHECK 約束),UI 依這個順序渲染 5 張卡片。 */
export const LINE_NOTIFICATION_EVENT_TYPES = [
  "booking_created",
  "booking_confirmed",
  "booking_cancelled",
  "booking_completed",
  "staff_leave_created",
] as const;

export type LineNotificationEventType = (typeof LINE_NOTIFICATION_EVENT_TYPES)[number];

export const LINE_NOTIFICATION_EVENT_LABELS: Record<LineNotificationEventType, string> = {
  booking_created: "有新訂單建立時",
  booking_confirmed: "訂單確認時",
  booking_cancelled: "訂單取消時",
  booking_completed: "訂單完成時",
  staff_leave_created: "登記請假時",
};

/** 1.2 邊界情況:staff_leave_created 這個事件沒有「服務人員/會員」這兩個自然對象,前端表單
 * 直接隱藏(不是禁用)這兩個開關。 */
export function eventSupportsStaffTarget(eventType: LineNotificationEventType): boolean {
  return eventType !== "staff_leave_created";
}
/** 發送記錄(3.18/4.3)用的狀態/事件/對象白話標籤。 */
export const LINE_LOG_STATUS_LABELS: Record<string, string> = {
  sent: "成功",
  failed: "失敗",
  skipped: "跳過",
};

export const LINE_LOG_SKIP_REASON_LABELS: Record<string, string> = {
  not_configured: "商家尚未串接 LINE",
  event_disabled: "這個事件的通知開關是關閉的",
  target_not_bound: "對象尚未綁定 LINE",
  no_target: "找不到可通知的對象(例如訂單沒有連結會員)",
  // SPECS-INDEX #962:服務人員已離職/停用(status = removed)就不寄訂單 LINE。
  staff_inactive: "服務人員已離職或停用",
  // SPECS-INDEX #876/#962:管理員關掉這位服務人員的「行事曆檢視」,就不寄會帶出客戶資料的訂單 LINE。
  staff_calendar_view_off: "服務人員未開放「行事曆檢視」，不寄訂單通知",
  // 客戶端第 5 批 C5-K03:通知客人的略過原因。
  customer_opted_out: "客人關閉通知",
  not_friend: "客人沒加好友",
  monthly_cap: "已達本月上限",
  quota_exhausted: "LINE 額度用完",
  stale: "狀態已變更",
  superseded: "時間已改回",
};

/** 客戶端第 5 批 C5-K03:通知客人的事件中文(5-B 的也先放,發送記錄裡出現時才看得懂)。 */
export const CUSTOMER_LINE_LOG_EVENT_LABELS: Record<string, string> = {
  customer_submitted: "通知客人：收到線上預約",
  customer_scheduled_by_store: "通知客人：店家建了預約",
  customer_confirmed: "通知客人：店家確認",
  customer_rescheduled: "通知客人：改時間",
  customer_cancelled_by_store: "通知客人：店家取消",
  customer_cancelled_by_customer: "通知客人：其他聯絡人取消",
  customer_reminder: "通知客人：服務前提醒",
  customer_completed: "通知客人：服務完成",
  customer_contact_request: "通知客人：聯絡人申請",
  customer_contact_removed: "通知客人：聯絡人被移除",
  customer_contact_request_resolved: "通知客人：聯絡人申請結果",
};

/** 發送記錄頁「通知客人」分類篩選(c5-contract 2-5 p_category = 'customer')。 */
export const LINE_LOG_CUSTOMER_CATEGORY_FILTER = "category:customer";

export const LINE_LOG_EVENT_TYPE_LABELS: Record<string, string> = {
  ...LINE_NOTIFICATION_EVENT_LABELS,
  marketing_manual: "再行銷通知",
};

/** 發送記錄每一列顯示的事件中文(篩選下拉仍只列 LINE_LOG_EVENT_TYPE_LABELS + 「通知客人」分類)。 */
export function lineLogEventLabel(eventType: string): string {
  return (
    LINE_LOG_EVENT_TYPE_LABELS[eventType] ?? CUSTOMER_LINE_LOG_EVENT_LABELS[eventType] ?? eventType
  );
}

/**
 * C5-K03 對象欄:會員的列顯示「會員〇〇(聯絡人：LINE 顯示名)」;沒有顯示名只寫「會員〇〇」;
 * 其他照舊顯示對象種類。
 */
export function lineLogTargetLabel(row: {
  target_type: string;
  target_member_name?: string | null;
  target_contact_display_name?: string | null;
}): string {
  const typeLabel = LINE_TARGET_TYPE_LABELS[row.target_type] ?? row.target_type;
  if (row.target_type !== "member") return typeLabel;
  const name = row.target_member_name?.trim();
  if (!name) return typeLabel;
  const contact = row.target_contact_display_name?.trim();
  return contact ? `會員${name}（聯絡人：${contact}）` : `會員${name}`;
}

export const LINE_TARGET_TYPE_LABELS: Record<string, string> = {
  admin: "商家管理員",
  agent: "客服",
  staff: "服務人員",
  member: "會員",
};

/** 3.2:LINE 串接狀態(遮蔽過的內容,完整金鑰永遠不會出現在這裡)。 */
export interface MerchantLineConfigStatus {
  isConnected: boolean;
  channelId: string | null;
  channelAccessTokenMasked: string | null;
  displayName: string | null;
  lineBotBasicId: string | null;
  lastTestedAt: string | null;
  lastTestResult: string | null;
}

/** 3.4~3.7:產生綁定碼的共同回傳格式。 */
export interface LineBindingCodeResult {
  code: string;
  expiresAt: string;
}

/** 3.10:確認訂單前預覽通知對象。 */
export interface PendingLineNotificationTarget {
  type: "admin" | "agent" | "staff" | "member";
  name: string;
}

export interface PendingLineNotificationPreview {
  hasAnyTarget: boolean;
  targets: PendingLineNotificationTarget[];
}

/** 這個模組四種可以綁定 LINE 個人帳號的身份。 */
export type LineBindingTargetType = "admin" | "agent" | "staff" | "member";
