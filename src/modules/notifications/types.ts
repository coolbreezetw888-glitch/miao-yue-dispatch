// 站內通知中心(鈴鐺)— 共用型別/常數。對應規格書 .project/specs/手機推播擴及三種角色.md §十三。
//
// ⚠️ 為什麼跟 src/modules/push-notifications/ 分成兩個資料夾(§13.11):一個管「會響的」
//    (推播:手機跳出來、滑掉就沒了),一個管「留得住的」(站內通知:存在 user_notifications
//    這張表裡)。依賴方向是**單向**的 —— 通知中心不知道推播是怎麼送出去的,它只讀這張表。
//
// 📌 唯一刻意保留的跨模組引用是**文案常數**:§13.7 明文要求「事件標籤沿用既有的
//    PUSH_NOTIFICATION_EVENT_LABELS,不要重寫一套白話名稱」。所以 NotificationBell 會
//    import push-notifications/types 的 PUSH_NOTIFICATION_EVENT_LABELS / PUSH_TARGET_TYPE_LABELS。
//    那是「同一個詞在兩個地方要長一樣」的需求,跟邏輯依賴不同,不算破壞模組獨立性。

import type { Tables } from "@/integrations/supabase/types";

/** §13.2:站內通知的一列。 */
export type UserNotification = Tables<"user_notifications">;

/** §13.2:通知是「以什麼身份收到的」。跟 push_event_subscriptions 同一套多型語彙,刻意不含 member。 */
export const NOTIFICATION_TARGET_TYPES = ["admin", "agent", "staff"] as const;
export type NotificationTargetType = (typeof NOTIFICATION_TARGET_TYPES)[number];

/**
 * §13.2 邊界情況 / §13.7:同一個人在同一間商家以兩個身份同時命中同一個事件時,資料層是**兩列**
 * (跟 push_notification_log 一樣一個身份一列),但顯示層要合併成一列並標出兩個身份。
 * 這是合併之後的形狀。
 */
export interface MergedNotification {
  /** 被合併進這一列的所有原始 id(標已讀時要一起標,所以是陣列不是單一 id)。 */
  ids: string[];
  /** 代表列的 id(最新的那一列),給 React key 用。 */
  key: string;
  merchant_id: string;
  booking_id: string | null;
  event_type: string;
  title: string;
  body: string;
  /** 合併進來的所有身份,依 admin → agent → staff 的固定順序排好,方便顯示與斷言。 */
  targetTypes: NotificationTargetType[];
  /** 導航要用哪一個身份算目的地:優先權最高的那一個(admin > agent > staff),跟 §5.5 一致。 */
  primaryTargetType: NotificationTargetType;
  /** 合併後的建立時間 = 最新那一列的時間。 */
  created_at: string;
  /** 合併後只要**還有任何一列未讀**就算未讀(顯示未讀圓點)。 */
  read_at: string | null;
}
