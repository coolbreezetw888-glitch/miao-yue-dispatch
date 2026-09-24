// 模組 15(手機推播通知)共用型別/常數。比照模組 11 的既有慣例,`Tables<...>` 直接沿用
// Supabase 產生的資料表型別,不重複手刻欄位。

import type { Tables } from "@/integrations/supabase/types";

/** §2.1:裝置登記(取代舊的 StaffPushSubscription —— 主體已經從服務人員改成登入帳號)。 */
export type PushSubscription = Tables<"push_subscriptions">;
/** §2.2:每個人自己的事件開關。 */
export type PushEventSubscription = Tables<"push_event_subscriptions">;
export type MerchantPushEventSetting = Tables<"merchant_push_event_settings">;
export type PushNotificationLogRow = Tables<"push_notification_log">;

/** §2.2:沿用模組 11 line_binding_codes 的多型語彙。這一批刻意不含 'member'。 */
export const PUSH_TARGET_TYPES = ["admin", "agent", "staff"] as const;
export type PushTargetType = (typeof PUSH_TARGET_TYPES)[number];

/** §7.1:卡片標題顯示用的角色白話名稱。 */
export const PUSH_TARGET_TYPE_LABELS: Record<PushTargetType, string> = {
  admin: "商家管理員",
  agent: "客服",
  staff: "服務人員",
};

/** 2.2:四種推播事件的固定清單(對應 event_type CHECK 約束),UI 依這個順序渲染卡片。 */
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

/**
 * §4.5 / 裁決 Q2:「前一天提醒隔天預約」是**逐筆**發送的。服務人員收的是自己的單;管理員/客服
 * 收的是全店的單 —— 明天 20 筆預約就是早上連收 20 則。所以這一批對管理員/客服**隱藏**這個選項。
 * ⚠️ 資料庫層刻意不擋(CHECK 沒有限制角色),之後要開放只要改這個清單。
 */
export function visibleEventTypesForTarget(
  targetType: PushTargetType,
): readonly PushNotificationEventType[] {
  if (targetType === "staff") return PUSH_NOTIFICATION_EVENT_TYPES;
  return PUSH_NOTIFICATION_EVENT_TYPES.filter((t) => t !== "booking_reminder_next_day");
}

/** §7.4 第 2 點:同一個事件對不同角色要講清楚「量有多大」(§4.4 第 3 點)。 */
export function eventDescriptionForTarget(
  eventType: PushNotificationEventType,
  targetType: PushTargetType,
): string {
  if (targetType === "staff") {
    switch (eventType) {
      case "booking_created":
        return "指派給你的訂單有新單時通知你";
      case "booking_cancelled":
        return "指派給你的訂單被取消時通知你";
      case "booking_updated":
        return "指派給你的訂單內容有異動時通知你";
      case "booking_reminder_next_day":
        return "前一天提醒你明天有哪些預約";
    }
  }
  switch (eventType) {
    case "booking_created":
      return "這間店每一筆新訂單都會通知你";
    case "booking_cancelled":
      return "這間店每一筆訂單被取消都會通知你";
    case "booking_updated":
      return "這間店每一筆訂單內容異動都會通知你";
    case "booking_reminder_next_day":
      return "前一天提醒明天的預約";
  }
}

export const PUSH_LOG_STATUS_LABELS: Record<string, string> = {
  sent: "成功",
  partially_sent: "部分成功",
  failed: "失敗",
  skipped: "跳過",
};

/**
 * §5.3:跳過原因的白話說明。
 * ⚠️ 這份清單必須跟資料庫 push_notification_log.skip_reason 的 CHECK 允許值**完全一致**
 * (有一條 Vitest 測試釘住這件事)。加了新的 skip_reason 一定要同步補這裡的文案,
 * 否則畫面上會出現看不懂的英文代碼。
 */
export const PUSH_LOG_SKIP_REASONS = [
  "event_disabled",
  "no_subscription",
  "no_target",
  "personal_disabled",
  "no_recipient",
] as const;

export const PUSH_LOG_SKIP_REASON_LABELS: Record<string, string> = {
  event_disabled: "這個事件的商家總開關是關閉的",
  no_recipient: "沒有任何人訂閱這個事件的通知",
  personal_disabled: "這位服務人員自己關掉了這種通知",
  no_subscription: "這個人還沒在任何裝置上開通推播",
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
