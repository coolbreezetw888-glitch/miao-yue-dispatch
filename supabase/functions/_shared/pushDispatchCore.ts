// 模組 15(服務人員推播通知)— push-notify-dispatch(7.6)/push-notify-reminder-dispatch(7.7)
// 共用的內部發送邏輯(對應規格書 7.7「engineer 實作時把這段共用邏輯抽成同一支內部函式,7.6/7.7
// 兩支 Edge Function 各自呼叫,避免邏輯分岔」)。
//
// 設計:這裡不直接依賴 supabase-js 的 client 型別,而是定義一組窄介面(PushDispatchDeps),
// 每個方法對應一個具體的資料庫操作。兩支 Edge Function 的 index.ts 各自用真正的 service role
// client 實作這組介面;Deno 測試則傳入假的 deps 物件,不需要模擬 supabase-js 的完整鏈式呼叫
// (`.from().select().eq()...`),比照模組 11 line-notify-dispatch 用窄介面 RpcClient 做測試替身
// 的既有精神,只是這裡的介面涵蓋範圍更大(本模組要查詢/寫入的表比模組 11 這支函式更多)。

export type PushDispatchEventType =
  "booking_created" | "booking_cancelled" | "booking_updated" | "booking_reminder_next_day";

export interface PushEventSettingRow {
  enabled: boolean;
  message_title: string;
  message_body: string;
}

export interface StaffPushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
}

export interface SendPushResult {
  ok: boolean;
  status: number;
  errorDetail: string | null;
}

export interface PushNotificationLogInsert {
  merchant_id: string;
  event_type: PushDispatchEventType;
  booking_id: string | null;
  staff_id: string | null;
  status: "sent" | "partially_sent" | "failed" | "skipped";
  skip_reason: "event_disabled" | "no_subscription" | "no_target" | null;
  device_count: number;
  success_count: number;
  error_detail: string | null;
  rendered_title: string | null;
  rendered_body: string | null;
}

/** 兩支 Edge Function 各自用真正的 service role client 實作這組介面。 */
export interface PushDispatchDeps {
  getEventSetting(
    merchantId: string,
    eventType: PushDispatchEventType,
  ): Promise<PushEventSettingRow | null>;
  getBookingStaffId(bookingId: string): Promise<string | null>;
  getStaffSubscriptions(staffId: string): Promise<StaffPushSubscriptionRow[]>;
  deleteSubscription(id: string): Promise<void>;
  renderBookingVariables(bookingId: string): Promise<Record<string, string>>;
  writeLog(row: PushNotificationLogInsert): Promise<void>;
  sendPush(
    subscription: StaffPushSubscriptionRow,
    payload: { title: string; body: string; url: string },
  ): Promise<SendPushResult>;
}

export interface DispatchPushForBookingParams {
  merchantId: string;
  bookingId: string;
  eventType: PushDispatchEventType;
  /** 規則 4.5:訂單內容異動的一句話摘要,只有 eventType === 'booking_updated' 時有意義。 */
  changeSummary?: string | null;
}

export interface DispatchPushForBookingResult {
  dispatched: boolean;
  reason?: "event_disabled" | "no_target" | "no_subscription";
  deviceCount?: number;
  successCount?: number;
}

// =========================================================================
// 判斷 11 對等寫法:文案範本變數替換的純函式。找 {{變數名稱}} 換成對應的值,對應不到的變數維持
// 原樣不變動(規則 4.3「安靜」精神延伸到這裡)。
// =========================================================================
export function renderMessageTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match;
  });
}

/** 規則 4.6:404/410 代表這個 endpoint 已經失效,要刪除訂閱。其他錯誤只記錄失敗,不刪除。 */
export function shouldDeleteSubscriptionOnFailure(status: number): boolean {
  return status === 404 || status === 410;
}

/** 2.3:依裝置數量/成功數量判斷這次發送記錄的整體狀態。 */
export function computeLogStatus(
  deviceCount: number,
  successCount: number,
): "sent" | "partially_sent" | "failed" {
  if (deviceCount === 0 || successCount === 0) return "failed";
  if (successCount === deviceCount) return "sent";
  return "partially_sent";
}

/**
 * 核心編排函式:規則 4.3(安靜跳過)+ 4.5(異動摘要信任前端)+ 4.6(404/410 清除訂閱)+
 * 2.3(彙總寫入 push_notification_log)。7.6/7.7 兩支 Edge Function 都呼叫這一支,不各自
 * 重寫一次判斷邏輯。
 */
export async function dispatchPushForBooking(
  deps: PushDispatchDeps,
  params: DispatchPushForBookingParams,
): Promise<DispatchPushForBookingResult> {
  const { merchantId, bookingId, eventType, changeSummary } = params;

  const eventSetting = await deps.getEventSetting(merchantId, eventType);
  if (!eventSetting || !eventSetting.enabled) {
    await deps.writeLog({
      merchant_id: merchantId,
      event_type: eventType,
      booking_id: bookingId,
      staff_id: null,
      status: "skipped",
      skip_reason: "event_disabled",
      device_count: 0,
      success_count: 0,
      error_detail: null,
      rendered_title: null,
      rendered_body: null,
    });
    return { dispatched: false, reason: "event_disabled" };
  }

  const staffId = await deps.getBookingStaffId(bookingId);
  if (!staffId) {
    await deps.writeLog({
      merchant_id: merchantId,
      event_type: eventType,
      booking_id: bookingId,
      staff_id: null,
      status: "skipped",
      skip_reason: "no_target",
      device_count: 0,
      success_count: 0,
      error_detail: null,
      rendered_title: null,
      rendered_body: null,
    });
    return { dispatched: false, reason: "no_target" };
  }

  const subscriptions = await deps.getStaffSubscriptions(staffId);
  if (subscriptions.length === 0) {
    await deps.writeLog({
      merchant_id: merchantId,
      event_type: eventType,
      booking_id: bookingId,
      staff_id: staffId,
      status: "skipped",
      skip_reason: "no_subscription",
      device_count: 0,
      success_count: 0,
      error_detail: null,
      rendered_title: null,
      rendered_body: null,
    });
    return { dispatched: false, reason: "no_subscription" };
  }

  const variables = await deps.renderBookingVariables(bookingId);
  if (eventType === "booking_updated" && changeSummary) {
    variables.change_summary = changeSummary;
  }

  const renderedTitle = renderMessageTemplate(eventSetting.message_title, variables);
  const renderedBody = renderMessageTemplate(eventSetting.message_body, variables);

  let successCount = 0;
  let lastErrorDetail: string | null = null;

  for (const subscription of subscriptions) {
    const result = await deps.sendPush(subscription, {
      title: renderedTitle,
      body: renderedBody,
      url: "/app/my-calendar",
    });

    if (result.ok) {
      successCount += 1;
    } else {
      lastErrorDetail = result.errorDetail;
      if (shouldDeleteSubscriptionOnFailure(result.status)) {
        await deps.deleteSubscription(subscription.id);
      }
    }
  }

  const status = computeLogStatus(subscriptions.length, successCount);

  await deps.writeLog({
    merchant_id: merchantId,
    event_type: eventType,
    booking_id: bookingId,
    staff_id: staffId,
    status,
    skip_reason: null,
    device_count: subscriptions.length,
    success_count: successCount,
    error_detail: status === "sent" ? null : lastErrorDetail,
    rendered_title: renderedTitle,
    rendered_body: renderedBody,
  });

  return { dispatched: true, deviceCount: subscriptions.length, successCount };
}
