// 模組 15(服務人員推播通知)7.6/7.7:用真正的 service role client(supabase-js)實作
// PushDispatchDeps 介面,供兩支 Edge Function 各自組出完整的 deps 物件,呼叫共用的
// dispatchPushForBooking(pushDispatchCore.ts)。
//
// 這裡直接使用 supabase-js 的 SupabaseClient(比照模組 11 line-notify-dispatch 的既有寫法,
// index.ts 內直接用 createClient 建出的物件操作 .from()/.rpc()),不另外定義一層窄介面——
// dispatchPushForBooking 本身已經是可以用假 deps 測試的核心邏輯,這一層只是接上真正的資料庫,
// 不需要重複做一次可測試性抽象。

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

import type {
  PushDispatchDeps,
  PushDispatchEventType,
  PushEventSettingRow,
  PushNotificationLogInsert,
  StaffPushSubscriptionRow,
} from "./pushDispatchCore.ts";
import { sendWebPush, type VapidDetails } from "./webpushAdapter.ts";

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

    async getStaffSubscriptions(staffId: string) {
      const { data, error } = await adminClient
        .from("staff_push_subscriptions")
        .select("id, endpoint, p256dh_key, auth_key")
        .eq("staff_id", staffId);
      if (error) {
        console.error("[push-dispatch] getStaffSubscriptions 失敗", error);
        return [];
      }
      return (data as StaffPushSubscriptionRow[] | null) ?? [];
    },

    async deleteSubscription(id: string) {
      const { error } = await adminClient.from("staff_push_subscriptions").delete().eq("id", id);
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

    async sendPush(subscription, payload) {
      return sendWebPush(vapidDetails, subscription, payload);
    },
  };
}
