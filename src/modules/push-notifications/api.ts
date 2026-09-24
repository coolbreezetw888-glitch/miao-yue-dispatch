// 模組 15(服務人員推播通知)— 資料存取層 + 第八節「對外介面」的實作。
// 這裡是唯一直接呼叫 supabase.from('staff_push_subscriptions' / 'merchant_push_event_settings' /
// 'push_notification_log')、supabase.rpc('update_push_event_setting' /
// 'get_staff_push_subscription_count')、supabase.functions.invoke('push-notify-dispatch') 的地方。
// 其他模組不應該直接操作這些表/函式,一律 import 這個檔案匯出的 hooks/functions
// (比照模組 11 api.ts 的既有慣例)。

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type {
  MerchantPushEventSetting,
  PushNotificationLogRow,
  StaffPushSubscription,
} from "./types";

// =========================================================================
// 7.2:服務人員自己的推播訂閱讀寫(直接開放 RLS,比照 staff_availability_windows 既有模式)。
// =========================================================================
export async function fetchStaffPushSubscriptions(
  staffId: string,
): Promise<StaffPushSubscription[]> {
  const { data, error } = await supabase
    .from("staff_push_subscriptions")
    .select("*")
    .eq("staff_id", staffId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export function useStaffPushSubscriptions(
  staffId: string | null | undefined,
): UseQueryResult<StaffPushSubscription[]> {
  return useQuery({
    queryKey: ["push-notifications-module", "staff-subscriptions", staffId],
    queryFn: () => fetchStaffPushSubscriptions(staffId as string),
    enabled: Boolean(staffId),
  });
}

export interface InsertStaffPushSubscriptionInput {
  merchantId: string;
  staffId: string;
  endpoint: string;
  p256dhKey: string;
  authKey: string;
  userAgent: string | null;
}

/** 7.2 第 3 點:訂閱物件直接 insert 進資料表,不需要額外 RPC(RLS 已經保護)。 */
export async function insertStaffPushSubscription(
  input: InsertStaffPushSubscriptionInput,
): Promise<StaffPushSubscription> {
  const { data, error } = await supabase
    .from("staff_push_subscriptions")
    .insert({
      merchant_id: input.merchantId,
      staff_id: input.staffId,
      endpoint: input.endpoint,
      p256dh_key: input.p256dhKey,
      auth_key: input.authKey,
      user_agent: input.userAgent,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/** 7.2 第 5 點:依 id 刪除一筆訂閱(RLS 只允許刪除自己名下的)。 */
export async function deleteStaffPushSubscriptionById(id: string): Promise<void> {
  const { error } = await supabase.from("staff_push_subscriptions").delete().eq("id", id);
  if (error) throw error;
}

/** 7.2 第 5 點:依 endpoint 刪除(「關閉此裝置通知」按鈕用這個裝置目前的 endpoint 比對)。 */
export async function deleteStaffPushSubscriptionByEndpoint(endpoint: string): Promise<void> {
  const { error } = await supabase
    .from("staff_push_subscriptions")
    .delete()
    .eq("endpoint", endpoint);
  if (error) throw error;
}

// =========================================================================
// 7.5 對外介面:get_staff_push_subscription_count,供模組 3 服務人員詳情頁疊加顯示用。
// =========================================================================
export async function fetchStaffPushSubscriptionCount(staffId: string): Promise<number> {
  const { data, error } = await supabase.rpc("get_staff_push_subscription_count", {
    p_staff_id: staffId,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

export function useStaffPushSubscriptionCount(
  staffId: string | null | undefined,
): UseQueryResult<number> {
  return useQuery({
    queryKey: ["push-notifications-module", "subscription-count", staffId],
    queryFn: () => fetchStaffPushSubscriptionCount(staffId as string),
    enabled: Boolean(staffId),
  });
}

// =========================================================================
// 7.9:推播事件設定讀寫(直接開放 RLS,比照 merchant_line_event_settings 既有模式)。
// =========================================================================
export async function fetchMerchantPushEventSettings(
  merchantId: string,
): Promise<MerchantPushEventSetting[]> {
  const { data, error } = await supabase
    .from("merchant_push_event_settings")
    .select("*")
    .eq("merchant_id", merchantId);
  if (error) throw error;
  return data ?? [];
}

export function useMerchantPushEventSettings(
  merchantId: string | null | undefined,
): UseQueryResult<MerchantPushEventSetting[]> {
  return useQuery({
    queryKey: ["push-notifications-module", "event-settings", merchantId],
    queryFn: () => fetchMerchantPushEventSettings(merchantId as string),
    enabled: Boolean(merchantId),
  });
}

export interface UpdatePushEventSettingInput {
  merchantId: string;
  eventType: string;
  enabled: boolean;
  messageTitle: string;
  messageBody: string;
}

export async function updatePushEventSetting(
  input: UpdatePushEventSettingInput,
): Promise<MerchantPushEventSetting> {
  const { data, error } = await supabase.rpc("update_push_event_setting", {
    p_merchant_id: input.merchantId,
    p_event_type: input.eventType,
    p_enabled: input.enabled,
    p_message_title: input.messageTitle,
    p_message_body: input.messageBody,
  });
  if (error) throw error;
  return data as MerchantPushEventSetting;
}

// =========================================================================
// 2.3 發送記錄查詢(比照模組 11 4.3 發送記錄頁的既有模式,直接開放 RLS,不需要另外的 RPC)。
// =========================================================================
export async function fetchPushNotificationLog(
  merchantId: string,
  limit: number,
  offset: number,
): Promise<PushNotificationLogRow[]> {
  const { data, error } = await supabase
    .from("push_notification_log")
    .select("*")
    .eq("merchant_id", merchantId)
    .order("attempted_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data ?? [];
}

export function usePushNotificationLog(
  merchantId: string | null | undefined,
  page: number,
  pageSize = 20,
): UseQueryResult<PushNotificationLogRow[]> {
  return useQuery({
    queryKey: ["push-notifications-module", "notification-log", merchantId, page, pageSize],
    queryFn: () => fetchPushNotificationLog(merchantId as string, pageSize, page * pageSize),
    enabled: Boolean(merchantId),
  });
}

// =========================================================================
// 第八節「對外介面」:8.1 dispatchPushNotification。供模組 6(訂單管理)的 create_booking/
// cancel_booking/update_booking 三個 mutation 呼叫成功之後直接 import 使用。
// =========================================================================
export type DispatchablePushEventType = "booking_created" | "booking_cancelled" | "booking_updated";

export interface DispatchPushNotificationInput {
  merchantId: string;
  bookingId: string;
  eventType: DispatchablePushEventType;
  /** 規則 4.5:訂單內容異動的一句話摘要,只有 eventType === 'booking_updated' 時需要帶。 */
  changeSummary?: string;
}

/**
 * 8.1/規則 4.3 第 4 點(本模組最重要的邊界原則,完全比照模組 11 dispatchLineNotification 的既有
 * 寫法):不等待、吞掉錯誤地呼叫 push-notify-dispatch Edge Function。即使這支 Edge Function
 * 整個掛掉或逾時,也絕對不會讓錯誤往外拋、影響原本呼叫端的訂單操作。
 *
 * 2026-09-24 深夜巡檢修正(跟 line-notifications/api.ts 的 dispatchLineNotification 同一個問題,
 * 同樣的修法):這裡原本只掛 `.catch()`。但 `supabase.functions.invoke` 對非 2xx 回應是
 * 「resolve 成 { data: null, error: FunctionsHttpError }」,不是 reject——所以 .catch() 只有在
 * 網路整個斷掉時才會跑,HTTP 401/500 這類「推播真的送不出去」的情況完全靜默,下面註解承諾的
 * 那行 console.error 從來不會出現。現在 .then 負責非 2xx、.catch 負責網路層失敗,兩條路都會留下
 * 紀錄;邊界原則完全不變——一樣不彈任何訊息給使用者、一樣不影響訂單操作。
 */
export function dispatchPushNotification(input: DispatchPushNotificationInput): void {
  void supabase.functions
    .invoke("push-notify-dispatch", {
      body: {
        merchant_id: input.merchantId,
        booking_id: input.bookingId,
        event_type: input.eventType,
        ...(input.changeSummary ? { change_summary: input.changeSummary } : {}),
      },
    })
    .then(({ error }) => {
      // 規則 4.3 第 4 點:只留一行 console.error,不彈出任何錯誤訊息給使用者,不影響原本操作。
      if (error) {
        console.error("[push-notify-dispatch] 呼叫失敗(不影響訂單操作)", error);
      }
    })
    .catch((err: unknown) => {
      // 網路整個斷掉/請求被瀏覽器擋下來這類真正 reject 的情況,行為同上。
      console.error("[push-notify-dispatch] 呼叫失敗(不影響訂單操作)", err);
    });
}
