// SPECS-INDEX #802(規格書 .project/specs/手機推播擴及三種角色.md §13.7 / §十之二「面板與點擊」):
// e2e/notification-bell.spec.ts 用的 fixture —— 一個商家管理員 + 一間商家 + 讓這位管理員
// **真的收到一則站內通知**所需的最少資料。
//
// =========================================================================
// 🔴 為什麼這支 fixture 不能像別的 fixture 一樣「直接 insert 一列測試資料」
// =========================================================================
// `user_notifications` 只有 1 條 SELECT 政策,而且 INSERT/UPDATE/DELETE 對 anon/authenticated
// 已經 revoke(#752 的核心交付:通知內容只能由 service role 寫入,使用者連自己那一列都改不了)。
// e2e 環境**沒有** service role key(而且不該有)。所以這裡讓通知**走產品自己的正常路徑**產生:
//
//   前端建單 → src/modules/booking/api.ts createBooking() 成功後 fire-and-forget 呼叫
//   supabase.functions.invoke("push-notify-dispatch") → Edge Function 用呼叫者的 JWT 過
//   can_manage_bookings 授權 → 用 service role 跑 dispatchPushForBooking() → 逐收件人寫一列
//   push_notification_log + 一列 user_notifications(§13.4)。
//
// 這支 fixture 做的就是把上面那條路徑用 supabase-js 從 Node 端重演一次(同一個 RPC、同一支
// Edge Function、同一組 JWT),**沒有任何一步繞過產品的權限檢查**。
//
// 這條路徑能在 e2e 成立,靠的是兩個查證過的事實:
//   ① 依 §13.4(#754),「收件人一台裝置都沒開通」時站內通知**照樣寫入**(skip_reason
//      = no_subscription 只影響推播,不影響站內通知)。所以不用假造手機裝置訂閱。
//   ② 收件人的判定(§5.1 resolve_push_recipients)只看 push_event_subscriptions +
//      merchant_admins,兩者都是管理員自己能透過既有 RLS/RPC 寫入的。
//
// 不寫站內通知的只有兩種情況,fixture 兩層都要打開:
//   ・商家總開關(merchant_push_event_settings.enabled,預設 false)→ update_push_event_setting RPC
//   ・本人的事件開關(push_event_subscriptions,列不存在 = 沒訂閱)→ 直接 upsert(RLS owns_push_target)
//
// ⚠️ 已知限制(SPECS-INDEX #638):商家只能軟停用;而 user_notifications 的列使用者自己刪不掉
//    (刻意的),會由 §13.9 的每日排程 prune_user_notifications 在 30 天後清除。
//
// 🔴 `.env` 的讀取**一律**走 e2e/support/env-file.ts(SPECS-INDEX #714)。
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { readRequiredEnvValue } from "./env-file";
import { getSupabaseAuthStorageKey } from "./supabase-storage-key";
import { disableFixtureMerchant } from "./merchant-teardown-helper";
import {
  addDays,
  buildTaipeiIso,
  getTaipeiNow,
  toDateKey,
} from "../../src/modules/booking/dateUtils";

export const NOTIFICATION_BELL_MERCHANT_NAME_PREFIX = "E2E鈴鐺通知測試商家";

const ENV_PURPOSE = "站內通知中心(notification-bell)這支 e2e 測試";

// 比照 e2e/support/app-header-fixture.ts:新格式 publishable key(sb_publishable_...)不是合法的
// JWT,supabase-js 仍可能塞一個 `Authorization: Bearer <publishable key>` 標頭,要在真正送出的
// fetch 裡拿掉。SPECS-INDEX #766 登記了這組三連發的重複技術債,本批不擴大範圍去收斂。
function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith("sb_publishable_") || value.startsWith("sb_secret_");
}

function buildFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    if (
      isNewSupabaseApiKey(supabaseKey) &&
      headers.get("Authorization") === `Bearer ${supabaseKey}`
    ) {
      headers.delete("Authorization");
    }
    headers.set("apikey", supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

function createFixtureSupabaseClient(): SupabaseClient {
  const url = readRequiredEnvValue("VITE_SUPABASE_URL", ENV_PURPOSE);
  const key = readRequiredEnvValue("VITE_SUPABASE_PUBLISHABLE_KEY", ENV_PURPOSE);
  return createClient(url, key, {
    global: { fetch: buildFetch(key) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface NotificationBellFixture {
  runId: string;
  email: string;
  session: Session;
  merchantId: string;
  staffId: string;
  bookingId: string;
  /** 商家總開關那張表裡設定的 booking_created 標題;收件人看到的 title 會是「<顯示名稱>·<這段>」。 */
  expectedTitleFragment: string;
  /** 建單時填的客戶姓名;預設內文模板 `{{booking_date}} {{customer_name}}‧{{service_names}}` 會帶出它。 */
  customerName: string;
  /** Edge Function 回傳的派送結果,測試檔印出來方便查案。 */
  dispatchResult: unknown;
  /** setup 結束時,用 fixture 帳號自己的 RLS 視角查到的站內通知列數(前提斷言用)。 */
  notificationRowCount: number;
}

async function restoreSession(client: SupabaseClient, session: Session): Promise<void> {
  const { error } = await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (error) throw new Error(`還原測試帳號 session 失敗:${error.message}`);
}

export async function setupNotificationBellFixture(): Promise<NotificationBellFixture> {
  const client = createFixtureSupabaseClient();
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `e2e-notification-bell-please-ignore-${runId}@example-bell-test-domain.test`;
  const password = `E2eBell!${runId}Aa`;

  // ---- 1. 帳號 + 商家(跟 app-header-fixture 一模一樣的起手式) ----
  const { data: signUpData, error: signUpError } = await client.auth.signUp({ email, password });
  if (signUpError) throw new Error(`建立 e2e 測試帳號失敗(signUp):${signUpError.message}`);

  let session = signUpData.session;
  if (!session) {
    const { data: signInData, error: signInError } = await client.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError || !signInData.session) {
      throw new Error(
        "建立 e2e 測試帳號後拿不到可用的 session —— 這個 Supabase 專案可能開啟了「需要驗證信箱才能登入」。" +
          `原始錯誤:${signInError?.message ?? "signUp 沒有回傳 session"}`,
      );
    }
    session = signInData.session;
  }

  const { data: merchantId, error: merchantError } = await client.rpc("create_group_and_merchant", {
    p_name: `${NOTIFICATION_BELL_MERCHANT_NAME_PREFIX}${runId}`,
    p_industry_type: "in_store_beauty",
    p_contact_email: email,
    p_intro: "e2e notification-bell 站內通知測試用商家,測試完會停用,不是真實商家。",
  });
  if (merchantError || !merchantId) {
    throw new Error(`建立測試商家失敗:${merchantError?.message ?? "沒有回傳 merchant id"}`);
  }
  const merchantIdStr = merchantId as string;

  // ---- 2. 建單所需的最少資料:營業時間、一個服務項目、一位服務人員(比照 line-notifications-fixture) ----
  const businessHoursRows = Array.from({ length: 7 }, (_, dayOfWeek) => ({
    merchant_id: merchantIdStr,
    day_of_week: dayOfWeek,
    is_closed: false,
    open_time: "00:00",
    close_time: "23:59",
  }));
  const { error: hoursError } = await client
    .from("merchant_business_hours")
    .upsert(businessHoursRows, { onConflict: "merchant_id,day_of_week" });
  if (hoursError) throw new Error(`寫入測試商家營業時間失敗:${hoursError.message}`);

  const { data: serviceItem, error: serviceItemError } = await client
    .from("service_items")
    .insert({
      merchant_id: merchantIdStr,
      name: "E2E測試服務項目(鈴鐺通知)",
      price: 800,
      item_type: "primary",
      duration_minutes: 30,
    })
    .select("id")
    .single();
  if (serviceItemError || !serviceItem) {
    throw new Error(`建立測試服務項目失敗:${serviceItemError?.message}`);
  }

  // 這位服務人員刻意**沒有** user_id、也沒有事件訂閱 —— 他不會成為收件人(§5.1 服務人員分支
  // 要求 user_id is not null 且有訂閱列),通知只會落到管理員身上,測試才能精準斷言一列。
  const { data: staff, error: staffError } = await client
    .from("merchant_staff")
    .insert({
      merchant_id: merchantIdStr,
      name: `E2E鈴鐺測試服務人員${runId}`,
      phone: `09${runId.slice(-8)}`,
      no_time_slot_limit: true,
    })
    .select("id")
    .single();
  if (staffError || !staff) throw new Error(`建立測試服務人員失敗:${staffError?.message}`);
  const staffId = (staff as { id: string }).id;

  // ---- 3. 兩層開關都打開(否則 §13.4:一列站內通知都不寫) ----
  // 3a. 商家總開關:走產品自己的 update_push_event_setting RPC(security invoker,RLS 把關)。
  //     標題帶 runId 讓測試能精準比對「就是這一則」,不會被別的資料混淆。
  const expectedTitleFragment = `E2E鈴鐺新訂單${runId}`;
  const { error: settingError } = await client.rpc("update_push_event_setting", {
    p_merchant_id: merchantIdStr,
    p_event_type: "booking_created",
    p_enabled: true,
    p_message_title: expectedTitleFragment,
    p_message_body: "{{booking_date}} {{customer_name}}‧{{service_names}}",
  });
  if (settingError) throw new Error(`打開商家推播總開關失敗:${settingError.message}`);

  // 3b. 本人的事件開關:先用 get_my_push_identity 反查自己在這間店的 admin target_id
  //     (§4.1:身分一律由後端從 auth.uid() 解析),再 upsert push_event_subscriptions
  //     (完全比照 src/modules/push-notifications/api.ts 的 setMyPushEventSubscription)。
  const { data: identity, error: identityError } = await client.rpc("get_my_push_identity", {
    p_merchant_id: merchantIdStr,
  });
  if (identityError || !identity) {
    throw new Error(`反查測試帳號的推播身份失敗:${identityError?.message ?? "沒有回傳"}`);
  }
  const { target_type: targetType, target_id: targetId } = identity as {
    target_type: string;
    target_id: string;
  };
  if (targetType !== "admin") {
    throw new Error(`預期測試帳號在這間店的身份是 admin,實際是 ${targetType}`);
  }
  const { error: subscriptionError } = await client.from("push_event_subscriptions").upsert(
    {
      merchant_id: merchantIdStr,
      target_type: targetType,
      target_id: targetId,
      event_type: "booking_created",
      enabled: true,
    },
    { onConflict: "merchant_id,target_type,target_id,event_type" },
  );
  if (subscriptionError) {
    throw new Error(`打開測試帳號自己的事件開關失敗:${subscriptionError.message}`);
  }

  // ---- 4. 建一筆訂單(create_booking RPC;#604 之後付款方式必填,拿商家預設種好的那一筆) ----
  const { data: paymentMethod, error: paymentMethodError } = await client
    .from("payment_methods")
    .select("id")
    .eq("merchant_id", merchantIdStr)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (paymentMethodError || !paymentMethod) {
    throw new Error(
      `查詢測試商家的預設付款方式失敗:${paymentMethodError?.message ?? "查無啟用中的付款方式"}`,
    );
  }
  const customerName = `E2E鈴鐺客戶${runId}`;
  const startAt = buildTaipeiIso(toDateKey(addDays(getTaipeiNow(), 1)), "10:00");
  const { data: booking, error: bookingError } = await client.rpc("create_booking", {
    p_merchant_id: merchantIdStr,
    p_staff_id: staffId,
    p_service_items: [
      { service_item_id: (serviceItem as { id: string }).id, quantity: 1, unit_price: 800 },
    ],
    p_start_at: startAt,
    p_customer_name: customerName,
    p_customer_phone: `09${runId.slice(-8)}`,
    p_payment_method_id: (paymentMethod as { id: string }).id,
  });
  if (bookingError || !booking) throw new Error(`建立測試訂單失敗:${bookingError?.message}`);
  const bookingId = (booking as { id: string }).id;

  // ---- 5. 重演前端建單成功後的那一行:呼叫 push-notify-dispatch(同一支 Edge Function、同一組 JWT) ----
  // 前端是 fire-and-forget(§8.1),這裡刻意 await —— 測試需要確定通知真的寫進去了才往下走。
  const { data: dispatchResult, error: dispatchError } = await client.functions.invoke(
    "push-notify-dispatch",
    {
      body: { merchant_id: merchantIdStr, booking_id: bookingId, event_type: "booking_created" },
    },
  );
  if (dispatchError) {
    // FunctionsHttpError 的 message 只有「non-2xx」,真正的原因在 context(Response)的本文裡,
    // 一定要讀出來,否則出錯時完全無從查起。
    let detail = "";
    const ctx = (dispatchError as { context?: Response }).context;
    if (ctx && typeof ctx.text === "function") {
      try {
        detail = ` HTTP ${ctx.status}:${await ctx.text()}`;
      } catch {
        detail = ` HTTP ${ctx.status}`;
      }
    }
    throw new Error(
      `呼叫 push-notify-dispatch 失敗:${dispatchError.message}${detail} —— 站內通知不會產生,測試無法繼續。`,
    );
  }
  // 預期結果:recipientCount >= 1(管理員本人),而 dispatched 會是 false / reason
  // "no_subscription"(沒有任何手機裝置),這正是 §13.4 說「站內通知照樣存在」的情境。
  const result = (dispatchResult ?? {}) as { recipientCount?: number; reason?: string };
  if (!result.recipientCount || result.recipientCount < 1) {
    throw new Error(
      `push-notify-dispatch 沒有算出任何收件人(回傳 ${JSON.stringify(dispatchResult)})—— ` +
        "代表兩層開關沒打開成功或 resolve_push_recipients 沒把管理員算進去。",
    );
  }

  // ---- 6. 用 fixture 帳號自己的 RLS 視角確認站內通知真的在(只讀,不需要 service role) ----
  const { data: rows, error: rowsError } = await client
    .from("user_notifications")
    .select("id, title, body, target_type, merchant_id, read_at")
    .eq("merchant_id", merchantIdStr)
    .eq("booking_id", bookingId);
  if (rowsError) throw new Error(`查詢站內通知失敗:${rowsError.message}`);

  return {
    runId,
    email,
    session,
    merchantId: merchantIdStr,
    staffId,
    bookingId,
    expectedTitleFragment,
    customerName,
    dispatchResult,
    notificationRowCount: rows?.length ?? 0,
  };
}

/** 把 fixture 帳號的 session 塞進瀏覽器 localStorage,讓 /app/* 直接進得去。 */
export async function injectNotificationBellFixtureSession(
  page: Page,
  fixture: NotificationBellFixture,
): Promise<void> {
  const storageKey = getSupabaseAuthStorageKey();
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(fixture.session)] as [string, string],
  );
}

/** 用 fixture 帳號的 RLS 視角讀回這次那則通知的 read_at(測試用來確認「點一列 → 真的寫進資料庫」)。 */
export async function fetchFixtureNotificationReadStates(
  fixture: NotificationBellFixture,
): Promise<{ id: string; read_at: string | null }[]> {
  const client = createFixtureSupabaseClient();
  await restoreSession(client, fixture.session);
  const { data, error } = await client
    .from("user_notifications")
    .select("id, read_at")
    .eq("merchant_id", fixture.merchantId)
    .eq("booking_id", fixture.bookingId);
  if (error) throw new Error(`查詢站內通知已讀狀態失敗:${error.message}`);
  return (data ?? []) as { id: string; read_at: string | null }[];
}

export async function teardownNotificationBellFixture(
  fixture: NotificationBellFixture,
): Promise<string[]> {
  const client = createFixtureSupabaseClient();
  const { error: sessionError } = await client.auth.setSession({
    access_token: fixture.session.access_token,
    refresh_token: fixture.session.refresh_token,
  });
  if (sessionError) {
    return [`警告:無法還原測試帳號 session,略過清理(${sessionError.message})`];
  }
  const actions: string[] = [];

  // CLAUDE.md 第 5-1 條:刪除前先用相同篩選條件 SELECT 核對到底會刪到什麼。
  // push_event_subscriptions 的 RLS 是 owns_push_target(管理員存在即有效),先於停用商家處理。
  const { data: events } = await client
    .from("push_event_subscriptions")
    .select("id")
    .eq("merchant_id", fixture.merchantId);
  actions.push(
    `push_event_subscriptions 準備刪除 ${events?.length ?? 0} 列(全部是這個 e2e 帳號自己的)`,
  );
  if (events && events.length > 0) {
    const { error } = await client
      .from("push_event_subscriptions")
      .delete()
      .in(
        "id",
        events.map((e) => (e as { id: string }).id),
      );
    actions.push(
      error
        ? `push_event_subscriptions 刪除失敗:${error.message}`
        : "push_event_subscriptions 已刪除",
    );
  }

  const { error: staffError } = await client
    .from("merchant_staff")
    .update({ status: "removed" })
    .eq("id", fixture.staffId);
  actions.push(
    staffError
      ? `移除 fixture 服務人員失敗:${staffError.message}`
      : "已移除 fixture 服務人員(軟刪除)",
  );

  actions.push(await disableFixtureMerchant(client, fixture.merchantId));
  actions.push(
    "user_notifications / push_notification_log 的列刻意不由使用者端刪除(權限本來就沒開)," +
      "由 §13.9 的 prune_user_notifications 排程在 30 天後清除。",
  );
  return actions;
}
