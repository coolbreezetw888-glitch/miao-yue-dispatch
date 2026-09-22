// 模組 15(服務人員推播通知)共用型別/常數。比照模組 11 的既有慣例,`Tables<...>` 直接沿用
// Supabase 產生的資料表型別,不重複手刻欄位。

import type { Tables } from "@/integrations/supabase/types";

export type StaffPushSubscription = Tables<"staff_push_subscriptions">;
export type MerchantPushEventSetting = Tables<"merchant_push_event_settings">;
export type PushNotificationLogRow = Tables<"push_notification_log">;

/** 2.2:四種推播事件的固定清單(對應 event_type CHECK 約束),UI 依這個順序渲染 4 張卡片。 */
export const PUSH_NOTIFICATION_EVENT_TYPES = [
  "booking_created",
  "booking_cancelled",
  "booking_updated",
  "booking_reminder_next_day",
] as const;

export type PushNotificationEventType = (typeof PUSH_NOTIFICATION_EVENT_TYPES)[number];

export const PUSH_NOTIFICATION_EVENT_LABELS: Record<PushNotificationEventType, string> = {
  booking_created: "有新訂單建立時",
  booking_cancelled: "訂單取消時",
  booking_updated: "訂單內容異動時",
  booking_reminder_next_day: "前一天提醒隔天預約",
};

export const PUSH_LOG_STATUS_LABELS: Record<string, string> = {
  sent: "成功",
  partially_sent: "部分成功",
  failed: "失敗",
  skipped: "跳過",
};

export const PUSH_LOG_SKIP_REASON_LABELS: Record<string, string> = {
  event_disabled: "這個事件的通知開關是關閉的",
  no_subscription: "這位服務人員尚未開通任何裝置的推播",
  no_target: "這筆訂單沒有指定服務人員",
};

/** 7.2:已開通裝置清單顯示用,把 user_agent 原始字串簡化成白話裝置名稱。 */
export function simplifyUserAgent(userAgent: string | null | undefined): string {
  if (!userAgent) return "未知裝置";
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/Android/i.test(userAgent)) return "Android 裝置";
  if (/Macintosh/i.test(userAgent)) return "Mac 電腦";
  if (/Windows/i.test(userAgent)) return "Windows 電腦";
  return "其他裝置";
}
