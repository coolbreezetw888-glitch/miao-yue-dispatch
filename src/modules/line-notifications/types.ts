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
export function eventSupportsMemberTarget(eventType: LineNotificationEventType): boolean {
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
};

export const LINE_LOG_EVENT_TYPE_LABELS: Record<string, string> = {
  ...LINE_NOTIFICATION_EVENT_LABELS,
  marketing_manual: "行銷再通知",
};

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
