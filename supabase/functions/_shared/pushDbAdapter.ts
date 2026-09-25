// 模組 15(手機推播通知)7.6/7.7:用真正的 service role client(supabase-js)實作
// PushDispatchDeps 介面,供兩支 Edge Function 各自組出完整的 deps 物件,呼叫共用的
// dispatchPushForBooking(pushDispatchCore.ts)。
//
// 這裡直接使用 supabase-js 的 SupabaseClient(比照模組 11 line-notify-dispatch 的既有寫法,
// index.ts 內直接用 createClient 建出的物件操作 .from()/.rpc()),不另外定義一層窄介面——
// dispatchPushForBooking 本身已經是可以用假 deps 測試的核心邏輯,這一層只是接上真正的資料庫,
// 不需要重複做一次可測試性抽象。
//
// 2026-09-25「手機推播擴及三種角色」批次:
//   - getStaffSubscriptions(staffId) → getSubscriptionsForUsers(userIds)(§4.3)
//   - 新增 resolveRecipients(§5.1)與 isStaffEventDisabled(§4.2 第 3 點)
//   - 訂閱表 staff_push_subscriptions → push_subscriptions(§2.1/§3.1)
//
// 2026-09-25「站內通知中心(鈴鐺)」批次(§13.4,#753):新增 writeInAppNotification。

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

import type {
  PushDispatchDeps,
  PushDispatchEventType,
  PushEventSettingRow,
  PushNotificationLogInsert,
  PushRecipient,
  PushSubscriptionRow,
  UserNotificationInsert,
} from "./pushDispatchCore.ts";
import { sendWebPush, type VapidDetails } from "./webpushAdapter.ts";

// ⚠️ 這裡的 `any` 是刻意的:supabase-js 的 SupabaseClient 泛型要吃這個專案自動產生的
// Database 型別,而 Edge Function(Deno)這一側沒有那份檔案。ESLint 看不懂 Deno 的
// `// deno-lint-ignore` 指令,所以 supabase/functions/** 整個排除在 ESLint 掃描之外
// (見 eslint.config.js 的 ignores 與 #713);Deno 自己的 linter 仍然會檢查這個檔案。
// deno-lint-ignore no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

export function buildPushDispatchDeps(
  adminClient: AnySupabaseClient,
  vapidDetails: VapidDetails,
): PushDispatchDeps {
  return {
    async getEventSetting(merchantId: string, eventType: PushDispatchEventType) {
      const { data, error } = await adminClient
        .from("merchant_push_event_settings")
        .select("enabled, message_title, message_body")
        .eq("merchant_id", merchantId)
        .eq("event_type", eventType)
        .maybeSingle();
      if (error) {
        console.error("[push-dispatch] getEventSetting 失敗", error);
        return null;
      }
      return (data as PushEventSettingRow | null) ?? null;
    },

    async getBookingStaffId(bookingId: string) {
      const { data, error } = await adminClient
        .from("bookings")
        .select("staff_id")
        .eq("id", bookingId)
        .maybeSingle();
      if (error) {
        console.error("[push-dispatch] getBookingStaffId 失敗", error);
        return null;
      }
      const row = data as { staff_id: string | null } | null;
      return row?.staff_id ?? null;
    },

    // §5.1:收件人解析一律走資料庫函式,不在這裡拼 SQL。
    async resolveRecipients(
      merchantId: string,
      eventType: PushDispatchEventType,
      bookingStaffId: string | null,
    ) {
      const { data, error } = await adminClient.rpc("resolve_push_recipients", {
        p_merchant_id: merchantId,
        p_event_type: eventType,
        p_booking_staff_id: bookingStaffId,
      });
      if (error) {
        console.error("[push-dispatch] resolve_push_recipients 失敗", error);
        return [];
      }
      return (data as PushRecipient[] | null) ?? [];
    },

    // §4.3:一次把所有收件人的裝置撈回來,依 user_id 分組。
    async getSubscriptionsForUsers(userIds: string[]) {
      const grouped = new Map<string, PushSubscriptionRow[]>();
      if (userIds.length === 0) return grouped;

      const { data, error } = await adminClient
        .from("push_subscriptions")
        .select("id, endpoint, p256dh_key, auth_key, user_id")
        .in("user_id", userIds);
      if (error) {
        console.error("[push-dispatch] getSubscriptionsForUsers 失敗", error);
        return grouped;
      }

      const rows = (data as (PushSubscriptionRow & { user_id: string })[] | null) ?? [];
      for (const row of rows) {
        const list = grouped.get(row.user_id);
        const entry: PushSubscriptionRow = {
          id: row.id,
          endpoint: row.endpoint,
          p256dh_key: row.p256dh_key,
          auth_key: row.auth_key,
        };
        if (list) list.push(entry);
        else grouped.set(row.user_id, [entry]);
      }
      return grouped;
    },

    async isStaffEventDisabled(
      merchantId: string,
      staffId: string,
      eventType: PushDispatchEventType,
    ) {
      const { data, error } = await adminClient.rpc("is_staff_push_event_disabled", {
        p_merchant_id: merchantId,
        p_staff_id: staffId,
        p_event_type: eventType,
      });
      if (error) {
        console.error("[push-dispatch] is_staff_push_event_disabled 失敗", error);
        return false;
      }
      return data === true;
    },

    async deleteSubscription(id: string) {
      const { error } = await adminClient.from("push_subscriptions").delete().eq("id", id);
      if (error) console.error("[push-dispatch] deleteSubscription 失敗", error);
    },

    async renderBookingVariables(bookingId: string) {
      const { data, error } = await adminClient.rpc("render_booking_notification_variables", {
        p_booking_id: bookingId,
      });
      if (error) {
        console.error("[push-dispatch] render_booking_notification_variables 失敗", error);
        return {};
      }
      return (data as Record<string, string>) ?? {};
    },

    async writeLog(row: PushNotificationLogInsert) {
      const { error } = await adminClient.from("push_notification_log").insert(row);
      if (error) console.error("[push-dispatch] writeLog 失敗", error);
    },

    // §13.4:站內通知中心(鈴鐺)。這張表沒有任何 INSERT 政策,而且表層 GRANT 也把
    // anon/authenticated 的 insert 收掉了(§13.2 第 3/4 點),所以**只有 service role 寫得進去**
    // —— 這裡用的正是 service role client。
    //
    // 🔴 比照上面的 writeLog:寫失敗只 console.error 後繼續,絕對不能因為站內通知寫失敗就讓
    //    推播不發(§13.4 最後一段)。
    async writeInAppNotification(row: UserNotificationInsert) {
      const { error } = await adminClient.from("user_notifications").insert(row);
      if (error) console.error("[push-dispatch] writeInAppNotification 失敗", error);
    },

    async sendPush(subscription, payload) {
      return sendWebPush(vapidDetails, subscription, payload);
    },
  };
}
