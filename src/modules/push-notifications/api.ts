// 模組 15(手機推播通知)— 資料存取層 + 第八節「對外介面」的實作。
// 這裡是唯一直接呼叫 supabase.from('push_subscriptions' / 'push_event_subscriptions' /
// 'merchant_push_event_settings' / 'push_notification_log')、
// supabase.rpc('upsert_my_push_subscription' / 'update_push_event_setting' /
// 'get_staff_push_status' / 'get_merchant_push_event_enabled_map')、
// supabase.functions.invoke('push-notify-dispatch' / 'push-send-test') 的地方。
// 其他模組不應該直接操作這些表/函式,一律 import 這個檔案匯出的 hooks/functions
// (比照模組 11 api.ts 的既有慣例)。

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type {
  MerchantPushEventSetting,
  PushEventSubscription,
  PushNotificationEventType,
  PushNotificationLogRow,
  PushSubscription,
  PushTargetType,
} from "./types";

// =========================================================================
// §2.1:裝置登記(主體是登入帳號,不是某間店的某個職務)。
// =========================================================================
export async function fetchMyPushSubscriptions(): Promise<PushSubscription[]> {
  // RLS(user_id = auth.uid())保證只會拿到自己的,不需要也不應該在這裡帶 user_id 條件。
  const { data, error } = await supabase
    .from("push_subscriptions")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export const MY_PUSH_SUBSCRIPTIONS_QUERY_KEY = [
  "push-notifications-module",
  "my-push-subscriptions",
] as const;

export function usePushSubscriptions(enabled = true): UseQueryResult<PushSubscription[]> {
  return useQuery({
    queryKey: MY_PUSH_SUBSCRIPTIONS_QUERY_KEY,
    queryFn: fetchMyPushSubscriptions,
    enabled,
  });
}

export interface UpsertMyPushSubscriptionInput {
  endpoint: string;
  p256dhKey: string;
  authKey: string;
  userAgent: string | null;
}

/**
 * §2.1 邊界情況:同一台裝置重複點「開啟通知」不可以噴 UNIQUE 錯誤;同一支手機換人登入時
 * endpoint 不變但主人要改掉。兩件事都靠 upsert_my_push_subscription 這支 SECURITY DEFINER
 * 函式處理(表上刻意沒有 UPDATE 政策)。
 * §4.1:這裡**沒有也不能有** user_id 參數 —— 身分一律由資料庫從 auth.uid() 解析。
 */
export async function upsertMyPushSubscription(
  input: UpsertMyPushSubscriptionInput,
): Promise<PushSubscription> {
  const { data, error } = await supabase.rpc("upsert_my_push_subscription", {
    p_endpoint: input.endpoint,
    p_p256dh_key: input.p256dhKey,
    p_auth_key: input.authKey,
    // 產生的 Args 型別是 `p_user_agent?: string`(有 default 值的參數),不吃 null。
    ...(input.userAgent ? { p_user_agent: input.userAgent } : {}),
  });
  if (error) throw error;
  return data as PushSubscription;
}

/** 依 id 刪除一筆裝置登記(RLS 只允許刪除自己名下的)。 */
export async function deletePushSubscriptionById(id: string): Promise<void> {
  const { error } = await supabase.from("push_subscriptions").delete().eq("id", id);
  if (error) throw error;
}

/** 依 endpoint 刪除(「關閉此裝置通知」按鈕用這個裝置目前的 endpoint 比對)。 */
export async function deletePushSubscriptionByEndpoint(endpoint: string): Promise<void> {
  const { error } = await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
  if (error) throw error;
}

// =========================================================================
// §2.2:每個人自己的事件開關。
// =========================================================================
export async function fetchMyPushEventSubscriptions(
  merchantId: string,
  targetType: PushTargetType,
  targetId: string,
): Promise<PushEventSubscription[]> {
  const { data, error } = await supabase
    .from("push_event_subscriptions")
    .select("*")
    .eq("merchant_id", merchantId)
    .eq("target_type", targetType)
    .eq("target_id", targetId);
  if (error) throw error;
  return data ?? [];
}

export function pushEventSubscriptionsQueryKey(
  merchantId: string | null | undefined,
  targetType: PushTargetType | null | undefined,
  targetId: string | null | undefined,
) {
  return ["push-notifications-module", "my-event-subscriptions", merchantId, targetType, targetId];
}

export function useMyPushEventSubscriptions(
  merchantId: string | null | undefined,
  targetType: PushTargetType | null | undefined,
  targetId: string | null | undefined,
): UseQueryResult<PushEventSubscription[]> {
  return useQuery({
    queryKey: pushEventSubscriptionsQueryKey(merchantId, targetType, targetId),
    queryFn: () =>
      fetchMyPushEventSubscriptions(
        merchantId as string,
        targetType as PushTargetType,
        targetId as string,
      ),
    enabled: Boolean(merchantId) && Boolean(targetType) && Boolean(targetId),
  });
}

export interface SetPushEventSubscriptionInput {
  merchantId: string;
  targetType: PushTargetType;
  targetId: string;
  eventType: PushNotificationEventType;
  enabled: boolean;
}

/**
 * §7.4 第 6 點:切換一個事件開關。直接 upsert 進表,不需要 RPC —— RLS 的
 * private.owns_push_target 會擋住「帶別人的 target_id」(§4.1 第 1 點)。
 */
export async function setMyPushEventSubscription(
  input: SetPushEventSubscriptionInput,
): Promise<void> {
  const { error } = await supabase.from("push_event_subscriptions").upsert(
    {
      merchant_id: input.merchantId,
      target_type: input.targetType,
      target_id: input.targetId,
      event_type: input.eventType,
      enabled: input.enabled,
    },
    { onConflict: "merchant_id,target_type,target_id,event_type" },
  );
  if (error) throw error;
}

/**
 * §7.5 / 裁決 Q7:使用者按下「開啟通知」時,把四種事件一次種成 enabled = true。
 * 理由(Q7):全關會直接造成「我明明開了卻什麼都沒收到」,而那正是這次要解決的困惑。
 * 已經存在的列**不覆蓋**(do nothing)—— 他之前自己關掉的選擇要保留。
 */
export async function seedMyPushEventSubscriptions(
  merchantId: string,
  targetType: PushTargetType,
  targetId: string,
  eventTypes: readonly PushNotificationEventType[],
): Promise<void> {
  const { error } = await supabase.from("push_event_subscriptions").upsert(
    eventTypes.map((eventType) => ({
      merchant_id: merchantId,
      target_type: targetType,
      target_id: targetId,
      event_type: eventType,
      enabled: true,
    })),
    { onConflict: "merchant_id,target_type,target_id,event_type", ignoreDuplicates: true },
  );
  if (error) throw error;
}

// =========================================================================
// §2.6:商家總開關狀態的窄窗口(服務人員/沒有權限的客服也讀得到)。
// =========================================================================
export type MerchantPushEventEnabledMap = Partial<Record<PushNotificationEventType, boolean>>;

export async function fetchMerchantPushEventEnabledMap(
  merchantId: string,
): Promise<MerchantPushEventEnabledMap> {
  const { data, error } = await supabase.rpc("get_merchant_push_event_enabled_map", {
    p_merchant_id: merchantId,
  });
  if (error) throw error;
  const map: MerchantPushEventEnabledMap = {};
  for (const row of (data ?? []) as { event_type: string; enabled: boolean }[]) {
    map[row.event_type as PushNotificationEventType] = row.enabled;
  }
  return map;
}

export function useMerchantPushEventEnabledMap(
  merchantId: string | null | undefined,
): UseQueryResult<MerchantPushEventEnabledMap> {
  return useQuery({
    queryKey: ["push-notifications-module", "merchant-event-enabled-map", merchantId],
    queryFn: () => fetchMerchantPushEventEnabledMap(merchantId as string),
    enabled: Boolean(merchantId),
  });
}

// =========================================================================
// §3.3 對外介面:get_staff_push_status,供模組 3 服務人員詳情頁疊加顯示用。
// =========================================================================
export interface StaffPushStatus {
  deviceCount: number;
  anyEventEnabled: boolean;
}

export async function fetchStaffPushStatus(staffId: string): Promise<StaffPushStatus> {
  const { data, error } = await supabase.rpc("get_staff_push_status", { p_staff_id: staffId });
  if (error) throw error;
  const row = (data ?? {}) as { device_count?: number; any_event_enabled?: boolean };
  return {
    deviceCount: row.device_count ?? 0,
    anyEventEnabled: row.any_event_enabled ?? false,
  };
}

export function useStaffPushStatus(
  staffId: string | null | undefined,
): UseQueryResult<StaffPushStatus> {
  return useQuery({
    queryKey: ["push-notifications-module", "staff-push-status", staffId],
    queryFn: () => fetchStaffPushStatus(staffId as string),
    enabled: Boolean(staffId),
  });
}

// =========================================================================
// 7.9:推播事件設定讀寫(商家層級,§2.3 這張表一個字都不改)。
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
// §6.1:測試推播。
// =========================================================================
export interface SendTestPushResult {
  sent: number;
  failed: number;
  reason?: string;
  ackTokens: string[];
}

/** 測試推播被頻率限制擋下時丟的錯誤(§6.6),呼叫端靠 `isRateLimited` 分辨要顯示哪一句話。 */
export class PushTestRateLimitedError extends Error {
  readonly isRateLimited = true;
  constructor() {
    super("測試通知發太多次了,請等一分鐘再試");
    this.name = "PushTestRateLimitedError";
  }
}

/**
 * §6.1 / §6.2:對「我自己的裝置」發一則測試通知。
 * ⚠️ 請求 body 只有 merchant_id 與 endpoint —— **沒有、也不可以有 user_id / target_id**。
 *    收件人一律由 Edge Function 用呼叫者自己的 JWT + RLS 解析(§4.1 第 2 點)。
 */
export async function sendTestPush(
  merchantId: string,
  endpoint?: string | null,
): Promise<SendTestPushResult> {
  const { data, error } = await supabase.functions.invoke("push-send-test", {
    body: { merchant_id: merchantId, ...(endpoint ? { endpoint } : {}) },
  });
  if (error) {
    // supabase-js 對非 2xx 回應是 resolve 成 { data: null, error: FunctionsHttpError },
    // 不是 reject(模組 11/15 都踩過這個坑)。429 要能被呼叫端分辨出來。
    const status = (error as { context?: { status?: number } }).context?.status;
    if (status === 429) throw new PushTestRateLimitedError();
    throw error;
  }
  const row = (data ?? {}) as {
    sent?: number;
    failed?: number;
    reason?: string;
    ack_tokens?: string[];
  };
  return {
    sent: row.sent ?? 0,
    failed: row.failed ?? 0,
    ...(row.reason ? { reason: row.reason } : {}),
    ackTokens: row.ack_tokens ?? [],
  };
}

/**
 * §6.3 第 4 點:查這幾個 ack token 有沒有任何一個已經回報送達(postMessage 主路徑的備援)。
 *
 * 🔴 2026-09-25 品管上線後複查抓到的真缺陷,這裡記錄為什麼**不能**直接查 push_notification_log:
 *    那張表的 SELECT 政策是 `private.can_manage_push_notification(merchant_id)`,
 *    = 商家管理員 OR「被開通 push_notification 權限的在職客服」。
 *    **服務人員完全不在這個判斷裡**,而客服那條路徑在正式環境也走不通
 *    (merchant_agent_permissions 2026-09-25 實查是 0 筆)。
 *    而 RLS 是「靜默過濾」不是丟錯 —— 服務人員會拿到空陣列、被判定成「還沒回報」,
 *    15 秒後必定看到「⚠️ 通知已送出,但系統沒有收到你裝置的回報」這個**假警告**。
 *    而服務人員正是這個功能的主要使用者。
 *
 *    修法是開一支只回 boolean 的窄函式(比照 §2.6 的既有做法),
 *    **不是**放寬那張表的 RLS —— 放寬會順手改掉「誰能看全店發送記錄」這件事。
 */
export async function hasAnyAckedTestPush(ackTokens: string[]): Promise<boolean> {
  if (ackTokens.length === 0) return false;
  const { data, error } = await supabase.rpc("have_my_test_pushes_been_acked", {
    p_ack_tokens: ackTokens,
  });
  if (error) throw error;
  return data === true;
}

// =========================================================================
// 第八節「對外介面」:8.1 dispatchPushNotification。供模組 6(訂單管理)的 create_booking/
// cancel_booking/update_booking 三個 mutation 呼叫成功之後直接 import 使用。
//
// ⚠️ 簽章完全不變 —— 收件人從「單一服務人員」擴充到三種角色,整個發生在 Edge Function 與
//    資料庫層,模組 6 的三個 mutation hook 一行都不用改(§8.1)。
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
