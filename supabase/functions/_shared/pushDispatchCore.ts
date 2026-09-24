// 模組 15(手機推播通知)— push-notify-dispatch(7.6)/push-notify-reminder-dispatch(7.7)
// 共用的內部發送邏輯(對應規格書 7.7「engineer 實作時把這段共用邏輯抽成同一支內部函式,7.6/7.7
// 兩支 Edge Function 各自呼叫,避免邏輯分岔」)。
//
// 設計:這裡不直接依賴 supabase-js 的 client 型別,而是定義一組窄介面(PushDispatchDeps),
// 每個方法對應一個具體的資料庫操作。兩支 Edge Function 的 index.ts 各自用真正的 service role
// client 實作這組介面;Deno 測試則傳入假的 deps 物件,不需要模擬 supabase-js 的完整鏈式呼叫
// (`.from().select().eq()...`),比照模組 11 line-notify-dispatch 用窄介面 RpcClient 做測試替身
// 的既有精神,只是這裡的介面涵蓋範圍更大(本模組要查詢/寫入的表比模組 11 這支函式更多)。
//
// =========================================================================
// 2026-09-25「手機推播擴及三種角色」批次(規格書 §5.2)改寫:
//   舊流程的假設是「收件人 = 這筆訂單被指派的那一位服務人員」,整支函式沒有任何地方會查到
//   管理員或客服。現在改成「一份收件人清單」(§5.1 resolve_push_recipients),同一件事可能同時
//   通知到管理員 / 客服 / 被指派的服務人員。
//
//   三支既有純函式 renderMessageTemplate / shouldDeleteSubscriptionOnFailure / computeLogStatus
//   **一個字都沒有動**(§5.2 第 4 點),既有的 Deno 測試也沒有被刪掉重寫。
// =========================================================================

export type PushDispatchEventType =
  "booking_created" | "booking_cancelled" | "booking_updated" | "booking_reminder_next_day";

/** §2.2:沿用模組 11 line_binding_codes 的多型語彙。這一批刻意不含 'member'。 */
export type PushTargetType = "admin" | "agent" | "staff";

export interface PushEventSettingRow {
  enabled: boolean;
  message_title: string;
  message_body: string;
}

/** §2.1:裝置登記。主體是登入帳號(user_id),不是某間店的某個職務。 */
export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
}

/**
 * 舊名稱保留成別名,避免既有 import(webpushAdapter.ts 等)一次全部要改。
 * 語意已經變了(不再屬於「服務人員」),新程式碼一律用 PushSubscriptionRow。
 */
export type StaffPushSubscriptionRow = PushSubscriptionRow;

/** §5.1 resolve_push_recipients 回傳的一列。 */
export interface PushRecipient {
  target_type: PushTargetType;
  target_id: string;
  target_user_id: string;
  target_name: string;
}

export interface SendPushResult {
  ok: boolean;
  status: number;
  errorDetail: string | null;
}

export type PushLogSkipReason =
  | "event_disabled"
  | "no_subscription"
  | "no_target"
  | "personal_disabled"
  | "no_recipient";

export interface PushNotificationLogInsert {
  merchant_id: string;
  /** §2.4:'test' 只由 push-send-test 寫入,不會從這支函式產生。 */
  event_type: PushDispatchEventType;
  booking_id: string | null;
  /** §2.4:收件人的角色。跳過整件事的那幾種情況為 null。 */
  target_type: PushTargetType | null;
  target_id: string | null;
  status: "sent" | "partially_sent" | "failed" | "skipped";
  skip_reason: PushLogSkipReason | null;
  device_count: number;
  success_count: number;
  error_detail: string | null;
  rendered_title: string | null;
  rendered_body: string | null;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  /** §6.3:只有測試推播會帶。public/push-sw.js 看到 kind === "test" 才會回報送達。 */
  kind?: "test";
  /** §6.3:完整絕對網址(含一次性 token)。push-sw.js 是靜態檔案,拿不到 import.meta.env,
   * 所以網址與 token 一定要從 payload 帶進去。 */
  ack_url?: string;
}

/** 兩支 Edge Function 各自用真正的 service role client 實作這組介面。 */
export interface PushDispatchDeps {
  getEventSetting(
    merchantId: string,
    eventType: PushDispatchEventType,
  ): Promise<PushEventSettingRow | null>;
  getBookingStaffId(bookingId: string): Promise<string | null>;
  /** §5.1:把「這個事件要通知誰」收斂成一支資料庫函式,不在 TypeScript 裡各自拼 SQL。 */
  resolveRecipients(
    merchantId: string,
    eventType: PushDispatchEventType,
    bookingStaffId: string | null,
  ): Promise<PushRecipient[]>;
  /** §4.3:收件人清單是以「身份」為單位算出來的,實際發送是以「裝置」為單位。 */
  getSubscriptionsForUsers(userIds: string[]): Promise<Map<string, PushSubscriptionRow[]>>;
  /** §4.2 第 3 點 / §5.2 第 3 點:被指派的服務人員是不是自己把這個事件關掉了。 */
  isStaffEventDisabled(
    merchantId: string,
    staffId: string,
    eventType: PushDispatchEventType,
  ): Promise<boolean>;
  deleteSubscription(id: string): Promise<void>;
  renderBookingVariables(bookingId: string): Promise<Record<string, string>>;
  writeLog(row: PushNotificationLogInsert): Promise<void>;
  sendPush(subscription: PushSubscriptionRow, payload: PushPayload): Promise<SendPushResult>;
}

export interface DispatchPushForBookingParams {
  merchantId: string;
  bookingId: string;
  eventType: PushDispatchEventType;
  /** 規則 4.5:訂單內容異動的一句話摘要,只有 eventType === 'booking_updated' 時有意義。 */
  changeSummary?: string | null;
  /**
   * §5.4:排程提醒(push-notify-reminder-dispatch)只發給服務人員 —— 裁決 Q2:這個事件是逐筆
   * 發送的,管理員/客服收的是全店的單,明天 20 筆預約就是早上連收 20 則。
   * ⚠️ 之後如果要開放給管理員/客服,要改的就是呼叫端傳進來的這個旗標,不用動這支函式。
   */
  onlyStaffRecipients?: boolean;
}

export interface DispatchPushForBookingResult {
  dispatched: boolean;
  reason?: "event_disabled" | "no_target" | "no_subscription" | "no_recipient";
  deviceCount?: number;
  successCount?: number;
  recipientCount?: number;
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

// =========================================================================
// §4.7 / §5.5:通知點擊後的目的地依角色決定。
//
// ⚠️ 這裡修掉一個既有的真實 bug:原本所有裝置都收到 url: '/app/my-calendar',而 src/App.tsx
//    裡**根本沒有這個路由**(服務人員的行事曆實際掛在 /app/calendar)。也就是說一旦真的有人
//    收到推播並點下去,會直接落到「找不到頁面」。這個 bug 沒被抓到,正是因為正式環境的訂閱表
//    一筆資料都沒有 —— 從來沒有人真的收到過一則推播。
// =========================================================================
export const PUSH_TARGET_URLS: Record<PushTargetType, string> = {
  staff: "/app/calendar",
  admin: "/app/orders",
  agent: "/app/orders",
};

export function resolvePushUrlForTarget(targetType: PushTargetType): string {
  return PUSH_TARGET_URLS[targetType] ?? "/app";
}

/**
 * §4.8:管理員/客服的通知標題加上商家名稱前綴。
 * 理由:同一個人可能同時是好幾間商家的客服,而裝置登記是共用的(§2.1),所以他的手機會混收
 * 兩間店的通知。標題只寫「新訂單通知」他無法分辨是哪一間店的。
 * 服務人員不加前綴(一個服務人員同時在多間店上班的情況遠少於客服,而標題空間很寸土寸金)。
 */
export function buildRecipientTitle(
  targetType: PushTargetType,
  renderedTitle: string,
  merchantName: string | null | undefined,
): string {
  if (targetType === "staff") return renderedTitle;
  const name = (merchantName ?? "").trim();
  if (!name) return renderedTitle;
  return `${name}·${renderedTitle}`;
}

/**
 * §5.5 邊界情況:同一台裝置對應兩個身份、兩份不同的 payload 怎麼辦。
 * 規則:保留「角色優先權較高」的那一份(admin > agent > staff),跟 useMerchantRole 的既有
 * 優先權一致,不另發明一套。
 */
export const PUSH_TARGET_PRIORITY: Record<PushTargetType, number> = {
  admin: 3,
  agent: 2,
  staff: 1,
};

export function pickPayloadForDevice(recipientsOnThisDevice: PushRecipient[]): PushRecipient | null {
  let picked: PushRecipient | null = null;
  for (const recipient of recipientsOnThisDevice) {
    if (
      picked === null ||
      PUSH_TARGET_PRIORITY[recipient.target_type] > PUSH_TARGET_PRIORITY[picked.target_type]
    ) {
      picked = recipient;
    }
  }
  return picked;
}

/**
 * 核心編排函式:規則 4.2(兩層開關)+ 4.3(endpoint 去重)+ 4.4(收件範圍)+ 4.5(異動摘要)+
 * 4.6(404/410 清除訂閱)+ 4.7/4.8/5.5(payload 依角色組裝)+ 2.4(逐收件人寫入
 * push_notification_log)。7.6/7.7 兩支 Edge Function 都呼叫這一支,不各自重寫一次判斷邏輯。
 */
export async function dispatchPushForBooking(
  deps: PushDispatchDeps,
  params: DispatchPushForBookingParams,
): Promise<DispatchPushForBookingResult> {
  const { merchantId, bookingId, eventType, changeSummary, onlyStaffRecipients } = params;

  // ---------------------------------------------------------------------
  // §4.2 第 1 層:商家總開關。關 → 整件事跳過(行為跟改寫前完全一樣)。
  // ---------------------------------------------------------------------
  const eventSetting = await deps.getEventSetting(merchantId, eventType);
  if (!eventSetting || !eventSetting.enabled) {
    await deps.writeLog({
      merchant_id: merchantId,
      event_type: eventType,
      booking_id: bookingId,
      target_type: null,
      target_id: null,
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

  const bookingStaffId = await deps.getBookingStaffId(bookingId);

  // ---------------------------------------------------------------------
  // §4.2 第 2 層 + §5.1:找出這間商家訂閱了這個事件、而且本人開關是開的所有人。
  // ---------------------------------------------------------------------
  const allRecipients = await deps.resolveRecipients(merchantId, eventType, bookingStaffId);
  // §5.4:排程提醒只發給服務人員(裁決 Q2)。這一行就是「之後要開放給管理員時要改的那一行」。
  const recipients = onlyStaffRecipients
    ? allRecipients.filter((r) => r.target_type === "staff")
    : allRecipients;

  // §4.2 第 3 點 / §5.2 第 3 點:被指派的服務人員如果自己關掉了這個事件,要補寫一列
  // personal_disabled。理由:這是商家最可能來問「為什麼阿明沒收到通知」的情境,記錄裡要看得出
  // 答案是「他自己關掉了」,而不是一片空白讓人以為系統壞了。
  // 其他角色(管理員/客服)關閉個人開關屬於「本來就沒有訂閱」,不寫記錄,避免每筆訂單都在
  // 記錄表裡塞一堆雜訊。
  async function writePersonalDisabledLogIfNeeded(): Promise<void> {
    if (!bookingStaffId) return;
    if (recipients.some((r) => r.target_type === "staff" && r.target_id === bookingStaffId)) return;
    const disabled = await deps.isStaffEventDisabled(merchantId, bookingStaffId, eventType);
    if (!disabled) return;
    await deps.writeLog({
      merchant_id: merchantId,
      event_type: eventType,
      booking_id: bookingId,
      target_type: "staff",
      target_id: bookingStaffId,
      status: "skipped",
      skip_reason: "personal_disabled",
      device_count: 0,
      success_count: 0,
      error_detail: null,
      rendered_title: null,
      rendered_body: null,
    });
  }

  if (recipients.length === 0) {
    await writePersonalDisabledLogIfNeeded();
    // §5.3 的語意表:no_target 已經縮小成「這筆訂單沒有指定服務人員,所以服務人員這條路線沒有
    // 收件人」;「總開關開了,但全店沒有一個人自己打開這個事件」是 no_recipient。
    const skipReason: PushLogSkipReason = bookingStaffId === null ? "no_target" : "no_recipient";
    await deps.writeLog({
      merchant_id: merchantId,
      event_type: eventType,
      booking_id: bookingId,
      target_type: null,
      target_id: null,
      status: "skipped",
      skip_reason: skipReason,
      device_count: 0,
      success_count: 0,
      error_detail: null,
      rendered_title: null,
      rendered_body: null,
    });
    return { dispatched: false, reason: skipReason, recipientCount: 0 };
  }

  // ---------------------------------------------------------------------
  // ⚠️ §5.2 / §〇.11:「取變數 + 套文案」必須在**裝置查詢之前**。
  //
  //    改寫前的順序是「查裝置 → 沒有裝置就直接 return → 才套文案」,所以一個「有訂閱事件但
  //    一台裝置都沒開通」的人,程式碼根本沒有算出過通知文案,寫進 push_notification_log 的
  //    rendered_title/rendered_body 永遠是 null。那是「這個人為什麼沒收到」最需要留下線索的
  //    情境,卻剛好一片空白;之後的站內通知中心(鈴鐺)更是直接依賴這兩個值。
  //    這一段位置調換是刻意的,不要再搬回去。
  // ---------------------------------------------------------------------
  const variables = await deps.renderBookingVariables(bookingId);
  if (eventType === "booking_updated" && changeSummary) {
    variables.change_summary = changeSummary;
  }

  const renderedTitle = renderMessageTemplate(eventSetting.message_title, variables);
  const renderedBody = renderMessageTemplate(eventSetting.message_body, variables);
  const merchantName = variables["merchant_name"] ?? null;

  // ---------------------------------------------------------------------
  // §4.3:依 endpoint 去重之後才逐台發送。
  //
  // ⚠️ 給之後維護的人:同一台裝置同時命中一個人的兩個身份時,sendPush 只會被呼叫一次,但
  //    push_notification_log 仍然「一個身份一列」(身份層級才是商家關心的單位)。所以
  //    **不要把 sum(success_count) 當成「總共送出幾則通知」來算,算出來會偏大。**
  // ---------------------------------------------------------------------
  const userIds = [...new Set(recipients.map((r) => r.target_user_id))];
  const subscriptionsByUser = await deps.getSubscriptionsForUsers(userIds);

  interface DeviceEntry {
    subscription: PushSubscriptionRow;
    recipients: PushRecipient[];
  }
  const devicesByEndpoint = new Map<string, DeviceEntry>();
  /** 每個收件人「自己名下」的 endpoint 清單(同一台裝置可能同時屬於兩個身份)。 */
  const endpointsByRecipientKey = new Map<string, string[]>();
  const recipientKey = (r: PushRecipient) => `${r.target_type}:${r.target_id}`;

  for (const recipient of recipients) {
    const subs = subscriptionsByUser.get(recipient.target_user_id) ?? [];
    const endpoints: string[] = [];
    for (const sub of subs) {
      endpoints.push(sub.endpoint);
      const existing = devicesByEndpoint.get(sub.endpoint);
      if (existing) {
        existing.recipients.push(recipient);
      } else {
        devicesByEndpoint.set(sub.endpoint, { subscription: sub, recipients: [recipient] });
      }
    }
    endpointsByRecipientKey.set(recipientKey(recipient), endpoints);
  }

  const resultByEndpoint = new Map<string, SendPushResult>();

  for (const [endpoint, entry] of devicesByEndpoint) {
    // §5.5 邊界情況:一台裝置一份 payload,取角色優先權較高的那一份。
    const chosen = pickPayloadForDevice(entry.recipients) ?? entry.recipients[0];
    const result = await deps.sendPush(entry.subscription, {
      title: buildRecipientTitle(chosen.target_type, renderedTitle, merchantName),
      body: renderedBody,
      url: resolvePushUrlForTarget(chosen.target_type),
    });
    resultByEndpoint.set(endpoint, result);

    if (!result.ok && shouldDeleteSubscriptionOnFailure(result.status)) {
      await deps.deleteSubscription(entry.subscription.id);
    }
  }

  // ---------------------------------------------------------------------
  // §2.4:每個收件人各寫一列 log。
  // ---------------------------------------------------------------------
  let totalDeviceCount = 0;
  let totalSuccessCount = 0;

  for (const recipient of recipients) {
    const endpoints = endpointsByRecipientKey.get(recipientKey(recipient)) ?? [];

    if (endpoints.length === 0) {
      // §5.3:他打開了事件開關,但從來沒在手機上按過「開啟通知」。
      // ⚠️ rendered_title/rendered_body 在這裡是**有值的**(見上面「套文案提前」那段)。
      await deps.writeLog({
        merchant_id: merchantId,
        event_type: eventType,
        booking_id: bookingId,
        target_type: recipient.target_type,
        target_id: recipient.target_id,
        status: "skipped",
        skip_reason: "no_subscription",
        device_count: 0,
        success_count: 0,
        error_detail: null,
        rendered_title: renderedTitle,
        rendered_body: renderedBody,
      });
      continue;
    }

    let successCount = 0;
    let lastErrorDetail: string | null = null;
    for (const endpoint of endpoints) {
      const result = resultByEndpoint.get(endpoint);
      if (result?.ok) successCount += 1;
      else if (result) lastErrorDetail = result.errorDetail;
    }

    const status = computeLogStatus(endpoints.length, successCount);
    totalDeviceCount += endpoints.length;
    totalSuccessCount += successCount;

    await deps.writeLog({
      merchant_id: merchantId,
      event_type: eventType,
      booking_id: bookingId,
      target_type: recipient.target_type,
      target_id: recipient.target_id,
      status,
      skip_reason: null,
      device_count: endpoints.length,
      success_count: successCount,
      error_detail: status === "sent" ? null : lastErrorDetail,
      rendered_title: renderedTitle,
      rendered_body: renderedBody,
    });
  }

  await writePersonalDisabledLogIfNeeded();

  if (totalDeviceCount === 0) {
    // 所有收件人都沒有任何裝置 —— 對呼叫端來說跟改寫前的 no_subscription 是同一件事。
    return { dispatched: false, reason: "no_subscription", recipientCount: recipients.length };
  }

  return {
    dispatched: true,
    deviceCount: totalDeviceCount,
    successCount: totalSuccessCount,
    recipientCount: recipients.length,
  };
}
