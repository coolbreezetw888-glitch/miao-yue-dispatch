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
//
// =========================================================================
// 2026-09-25「站內通知中心(鈴鐺)」批次(規格書 §13.4,#753/#754)追加:
//   PushDispatchDeps 多一支 writeInAppNotification,在「套完文案之後、呼叫 sendPush 之前」
//   逐收件人寫一列 user_notifications。一個收件人 → 一列 log + 一列站內通知,一對一。
//
//   📌 §13.4 有一個 🔴 警告說「現行程式碼在 subscriptions.length === 0 時直接 return,而套文案
//      在那個 return 之後才做,所以有訂閱但沒裝置的人根本沒算出過文案,必須把套文案往前搬」。
//      **那件事在同一天稍早的 §5.2 改寫裡就已經做完了**(見下面「⚠️ §5.2 / §〇.11」那一段註解),
//      這一批只是**依賴**那個順序,沒有再搬一次。順序已經是對的,不要再搬回去。
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
  "event_disabled" | "no_subscription" | "no_target" | "personal_disabled" | "no_recipient";

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

/**
 * §13.2 / §13.4:站內通知中心(鈴鐺)的一列。
 *
 * ⚠️ 刻意不含「點下去要去哪裡」的網址 —— 只存 event_type / target_type / booking_id,
 *    點擊時由前端用純函式即時算出目的地(§13.7)。理由是 §〇.5 那個 bug 的直接教訓:
 *    把目的地網址存進資料庫,錯誤就會被永久冷凍在每一列歷史紀錄裡。
 *
 * ⚠️ title 刻意是 renderedTitle **本身**,不是 buildRecipientTitle() 加過商家名稱前綴的版本。
 *    §13.2 明文要求「就是 push_notification_log.rendered_title / rendered_body 的同一份內容」,
 *    而 §4.8 的商家名稱前綴是為了「手機通知列上分不出是哪一間店」才加的 —— 鈴鐺面板本身就會
 *    另外顯示商家名稱(§13.7),再加一次前綴是重複。
 */
export interface UserNotificationInsert {
  user_id: string;
  merchant_id: string;
  target_type: PushTargetType;
  target_id: string;
  event_type: PushDispatchEventType;
  booking_id: string | null;
  title: string;
  body: string;
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
  /** #972:一律帶 merchantId,只查這間商家的訂單(別家的訂單編號 → 視同查無 → null)。 */
  getBookingStaffId(bookingId: string, merchantId: string): Promise<string | null>;
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
  /** #972:一律帶 merchantId,資料庫 render_booking_notification_variables 會確認訂單屬於這間商家。 */
  renderBookingVariables(bookingId: string, merchantId: string): Promise<Record<string, string>>;
  writeLog(row: PushNotificationLogInsert): Promise<void>;
  /**
   * §13.4:站內通知中心(鈴鐺)的寫入。一個收件人 → 一列 log + 一列站內通知,一對一。
   *
   * 🔴 這一支寫失敗**絕對不能**讓推播不發(§13.4 最後一段)。呼叫端(下面的
   *    dispatchPushForBooking)已經把每一次呼叫包在 try/catch 裡,所以就算實作本身丟例外也不會
   *    中斷派送 —— 但實作端仍然應該比照既有的 writeLog 自己 console.error 後 resolve,
   *    這樣錯誤訊息才會留在 Edge Function 的日誌裡。
   */
  writeInAppNotification(row: UserNotificationInsert): Promise<void>;
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
  /**
   * SPECS-INDEX #823(2026-09-28):這筆訂單**被換掉的**主服務人員。只有 eventType === 'booking_updated'
   * 時有意義。有帶、而且跟目前的主服務人員不同 → 原本那位也會收到一則「這筆單已經不是你的了」。
   *
   * 為什麼一定要由呼叫端帶進來(不是資料庫自己推導):這個專案的訂單**沒有編輯歷史表**
   * (booking_status_change_logs 只記狀態變更;update_booking 直接 set staff_id = p_staff_id 覆蓋),
   * 所以 Edge Function 執行的時候,舊的那位是誰在資料庫裡已經查不到了。
   */
  previousStaffId?: string | null;
  /**
   * #986 第 9 批(使用者裁決:服務人員改單 / 拖拉不通知客戶):true ⇒ 收件人清單只留商家內部的人
   * (INTERNAL_PUSH_TARGET_TYPES)。push-notify-dispatch 在「服務人員路徑 + booking_updated」時帶 true。
   */
  internalRecipientsOnly?: boolean;
}

/**
 * #986 第 9 批:商家內部的收件人型別。現在 PushTargetType 本來就只有這三種(刻意不含 member),
 * 這份清單是給 internalRecipientsOnly 做「明確的硬過濾」用的 —— 以後就算有人替推播加了客戶收件人,
 * 服務人員改單 / 拖拉也不會送到客戶。不要只靠型別。
 */
export const INTERNAL_PUSH_TARGET_TYPES: readonly string[] = ["admin", "agent", "staff"];

export function filterInternalRecipients<T extends { target_type: string }>(recipients: T[]): T[] {
  return recipients.filter((r) => INTERNAL_PUSH_TARGET_TYPES.includes(r.target_type));
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

export function pickPayloadForDevice(
  recipientsOnThisDevice: PushRecipient[],
): PushRecipient | null {
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

// =========================================================================
// SPECS-INDEX #823:訂單被轉派之後,原本那位服務人員要收到「這筆單已經不是你的了」。
//
// 文字刻意用白話、寫給服務人員本人看,不是寫給工程師看:
//   - 有查到接手的人 → 「這筆預約已改由 王小明 負責,已從你的行程移除」
//   - 查不到(render_booking_notification_variables 的 staff_name 是空字串)→ 不要生出
//     「已改由  負責」這種中間空一格的怪句子,改用不點名的版本。
// =========================================================================
export function buildReassignedAwaySummary(newStaffName: string | null | undefined): string {
  const name = (newStaffName ?? "").trim();
  if (!name) return "這筆預約已改派給其他服務人員,已從你的行程移除";
  return `這筆預約已改由 ${name} 負責,已從你的行程移除`;
}

/**
 * #823:把「已從你的行程移除」這句話套進商家自己設定的 booking_updated 文案。
 *
 * 正常情況(預設範本 `{{booking_date}} {{customer_name}}:{{change_summary}}`)只要把 change_summary
 * 換成那句話就好。但商家可以自己改範本,如果他把 {{change_summary}} 拿掉了,套完之後那句話會
 * 整個消失 —— 對接手的人來說少一句無妨(他還是知道這單是他的),對被換掉的人來說卻是整個重點
 * 不見了,他會以為這單還是自己的。所以這裡多一道保險:套完之後找不到那句話,就補在最後一行。
 */
export function renderReassignedAwayBody(
  template: string,
  variables: Record<string, string>,
  reassignedAwaySummary: string,
): string {
  const rendered = renderMessageTemplate(template, {
    ...variables,
    change_summary: reassignedAwaySummary,
  });
  if (rendered.includes(reassignedAwaySummary)) return rendered;
  return rendered.trim() ? `${rendered}\n${reassignedAwaySummary}` : reassignedAwaySummary;
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
  const {
    merchantId,
    bookingId,
    eventType,
    changeSummary,
    onlyStaffRecipients,
    previousStaffId,
    internalRecipientsOnly,
  } = params;

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

  const bookingStaffId = await deps.getBookingStaffId(bookingId, merchantId);

  // ---------------------------------------------------------------------
  // §4.2 第 2 層 + §5.1:找出這間商家訂閱了這個事件、而且本人開關是開的所有人。
  // ---------------------------------------------------------------------
  const allRecipients = await deps.resolveRecipients(merchantId, eventType, bookingStaffId);
  // §5.4:排程提醒只發給服務人員(裁決 Q2)。這一行就是「之後要開放給管理員時要改的那一行」。
  // 複製一份:下面 #823 可能會往這個清單 push 一個人,不要動到 deps 回傳的那個陣列本身。
  const recipients = onlyStaffRecipients
    ? allRecipients.filter((r) => r.target_type === "staff")
    : [...allRecipients];

  // ---------------------------------------------------------------------
  // SPECS-INDEX #823:訂單被轉派時,原本那位主服務人員也要收到通知。
  //
  // 做法:拿 previousStaffId 再問一次 resolve_push_recipients,只取「staff 而且 target_id 就是他」
  // 的那一列。這樣他要不要收,走的是**跟接手的人一模一樣**的門檻(訂閱了 booking_updated、個人開關
  // 是開的、在職、可登入、有 user_id),不另外發明一套判斷,也不用改資料庫函式的簽章。
  //
  // 只在 booking_updated、而且他真的跟目前的主服務人員不是同一個人的時候做;排程提醒
  // (onlyStaffRecipients)不會帶 previousStaffId,這裡也不處理。
  // ---------------------------------------------------------------------
  const recipientKey = (r: PushRecipient) => `${r.target_type}:${r.target_id}`;
  let reassignedAwayRecipient: PushRecipient | null = null;
  if (
    eventType === "booking_updated" &&
    previousStaffId &&
    previousStaffId !== bookingStaffId &&
    !recipients.some((r) => r.target_type === "staff" && r.target_id === previousStaffId)
  ) {
    const previousStaffCandidates = await deps.resolveRecipients(
      merchantId,
      eventType,
      previousStaffId,
    );
    reassignedAwayRecipient =
      previousStaffCandidates.find(
        (r) => r.target_type === "staff" && r.target_id === previousStaffId,
      ) ?? null;
    if (reassignedAwayRecipient) recipients.push(reassignedAwayRecipient);
  }

  // #986 第 9 批:服務人員路徑的改單 / 拖拉 ⇒ 收件人只留商家內部(管理員 / 客服 / 服務人員)。
  // 放在所有收件人都加完之後,原地過濾(recipients 是 const,下面都用同一個陣列)。
  if (internalRecipientsOnly) {
    const internalOnly = filterInternalRecipients(recipients);
    recipients.length = 0;
    recipients.push(...internalOnly);
  }

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
  const variables = await deps.renderBookingVariables(bookingId, merchantId);
  if (eventType === "booking_updated" && changeSummary) {
    variables.change_summary = changeSummary;
  }

  const renderedTitle = renderMessageTemplate(eventSetting.message_title, variables);
  const renderedBody = renderMessageTemplate(eventSetting.message_body, variables);
  const merchantName = variables["merchant_name"] ?? null;

  // #823:被換掉的那位,內文跟其他人不一樣(其他人看到的是「服務人員改為 X」之類的異動摘要;
  // 他看到的必須是「這筆單已經不是你的了」)。標題沿用商家設定的標題,不另外硬編一個。
  // 其他收件人一律拿 renderedBody,所以這裡用「查不到就用預設」的方式,不動既有流程的任何一行。
  const bodyOverrideByRecipientKey = new Map<string, string>();
  if (reassignedAwayRecipient) {
    bodyOverrideByRecipientKey.set(
      recipientKey(reassignedAwayRecipient),
      renderReassignedAwayBody(
        eventSetting.message_body,
        variables,
        buildReassignedAwaySummary(variables["staff_name"]),
      ),
    );
  }
  const bodyFor = (recipient: PushRecipient): string =>
    bodyOverrideByRecipientKey.get(recipientKey(recipient)) ?? renderedBody;

  // ---------------------------------------------------------------------
  // §13.4:站內通知中心(鈴鐺)。**位置是規格明文要求的**——「算出收件人清單、套完文案之後、
  //        實際呼叫 sendPush 之前」就寫入,而且完全不看發送結果:
  //          - 推播回 500、回 404/410(裝置失效被刪除)→ 站內通知照樣在;
  //          - 連「這個收件人一台裝置都沒開通」(no_subscription)也要寫 —— 那時候站內通知是他
  //            唯一看得到的東西,正是「留得住紀錄」最有價值的場合。
  //        不寫的只有一種情況:**他根本不是收件人**(商家總開關關閉、或他自己把事件關掉了)。
  //        上面兩個 early return 已經涵蓋這件事,所以這裡不需要再判斷一次。
  //
  // 🔴 這個迴圈的每一次呼叫都包在 try/catch 裡:站內通知只是「留一份副本」,**絕對不能**因為
  //    它寫失敗就讓推播不發(§13.4)。這一層防護刻意寫在核心編排函式裡,而不是只依賴
  //    pushDbAdapter 自己吞錯 —— 這樣不論 deps 是誰實作的,這個保證都成立。
  // ---------------------------------------------------------------------
  for (const recipient of recipients) {
    try {
      await deps.writeInAppNotification({
        user_id: recipient.target_user_id,
        merchant_id: merchantId,
        target_type: recipient.target_type,
        target_id: recipient.target_id,
        event_type: eventType,
        booking_id: bookingId,
        title: renderedTitle,
        body: bodyFor(recipient),
      });
    } catch (err) {
      console.error("[push-dispatch] writeInAppNotification 失敗(推播照樣繼續)", err);
    }
  }

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
      body: bodyFor(chosen),
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
        rendered_body: bodyFor(recipient),
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
      rendered_body: bodyFor(recipient),
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
