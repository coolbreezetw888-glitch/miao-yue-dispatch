// 模組 11(LINE 通知)前端部分的 Playwright 測試共用 fixture——建立/清理
// e2e/line-notifications.spec.ts 用的真實測試資料。做法完全比照 e2e/support/members-fixture.ts
// 的既有慣例:用 @supabase/supabase-js 以 publishable key 真實 signUp() 建立一個全新測試帳號,
// 呼叫正式的 RPC/資料表操作,打正式 Supabase 專案(.env 的 wjtbmmnakcriuaqoknsq)。
//
// 範圍說明(§0 第二段已在回報時向主腦說明):這次沒有任何真實 LINE 官方帳號可以實測「真的收發
// 訊息」,也沒有 service role 金鑰可以在前端測試環境裡繞過 Webhook 直接把某個目標的 line_bound
// 灌成 true(merchant_line_configs/line_binding_codes 完全沒有開放給 anon/authenticated 的
// RLS 政策,merchant_admins/merchant_agents/members 的 line_bound/line_user_id 只能透過
// consume_line_binding_code 這支只給 service role 呼叫的函式寫入,merchant_staff 額外多一層
// BEFORE UPDATE 觸發器擋下非 service role 的異動)。因此這裡的 fixture 只能準備「尚未串接
// LINE/尚未綁定」的初始狀態,涵蓋:
//   1. 完全不會顯示通知彈窗的路徑(商家未串接 LINE → has_any_target 一定是 false)。
//   2. 產生綁定碼的完整互動(不需要真的綁定成功就能驗證 UI)。
//   3. 需要「已經有綁定對象」的彈窗顯示邏輯,改用 Playwright page.route() 攔截
//      preview_line_notification_targets 這支 RPC 的回應直接注入假資料(規格書七/主腦任務
//      說明明確允許「mock Edge Function 回應」,這支雖然是 RPC 不是 Edge Function,但一樣是
//      走 HTTP 呼叫,攔截方式相同,測的是前端收到這個回應之後的畫面邏輯,不是後端判斷邏輯本身
//      ——後端判斷邏輯已經由 pgTAP/Deno 測試覆蓋,見規格書第七節)。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { getSupabaseAuthStorageKey } from "./supabase-storage-key";
import { addDays, buildTaipeiIso, getTaipeiNow, toDateKey } from "../../src/modules/booking/dateUtils";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readEnvValue(key: string): string {
  const envPath = resolve(__dirname, "../../.env");
  const content = readFileSync(envPath, "utf-8");
  const line = content
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`) || l.startsWith(`${key} =`));
  if (!line) {
    throw new Error(
      `找不到 .env 裡的 ${key}——line-notifications 這個 e2e 測試需要它來建立 fixture 資料。`,
    );
  }
  const value = line.slice(line.indexOf("=") + 1).trim();
  return value.replace(/^["']|["']$/g, "");
}

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
  const url = readEnvValue("VITE_SUPABASE_URL");
  const key = readEnvValue("VITE_SUPABASE_PUBLISHABLE_KEY");
  return createClient(url, key, {
    global: { fetch: buildFetch(key) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const STAFF_NAME_PREFIX = "E2E測試LINE模組師傅";
export const MEMBER_NAME_PREFIX = "E2E測試LINE模組會員";

export interface LineNotificationsFixture {
  runId: string;
  email: string;
  session: Session;
  merchantId: string;
  staffId: string;
  staffName: string;
  serviceItemId: string;
  memberId: string;
  memberName: string;
}

/** 建立這次測試需要的全部 fixture 資料:一個新商家(刻意不串接 LINE,見檔案開頭說明)+
 * 一位服務人員 + 一個服務項目 + 一位會員(尚未綁定 LINE)。 */
export async function setupLineNotificationsFixture(): Promise<LineNotificationsFixture> {
  const client = createFixtureSupabaseClient();
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `e2e-line-notif-please-ignore-${runId}@example-overflow-test-domain.test`;
  const password = `E2eLineNotif!${runId}Aa`;

  const { data: signUpData, error: signUpError } = await client.auth.signUp({ email, password });
  if (signUpError) throw new Error(`建立 e2e 測試帳號失敗(signUp):${signUpError.message}`);
  const session = signUpData.session;
  if (!session) {
    throw new Error("建立 e2e 測試帳號後拿不到可用的 session,請確認 Authentication 設定。");
  }

  const merchantName = `E2ELINE通知模組測試商家${runId}`;
  const { data: merchantId, error: merchantError } = await client.rpc("create_group_and_merchant", {
    p_name: merchantName,
    p_industry_type: "in_store_beauty",
    p_contact_email: email,
    p_intro: "e2e-line-notifications 自動化測試用商家,測試完會清除,不是真實商家。",
  });
  if (merchantError || !merchantId) {
    throw new Error(`建立測試商家失敗:${merchantError?.message ?? "沒有回傳 merchant id"}`);
  }

  const businessHoursRows = Array.from({ length: 7 }, (_, dayOfWeek) => ({
    merchant_id: merchantId as string,
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
      merchant_id: merchantId as string,
      name: "E2E測試服務項目(LINE通知模組)",
      price: 800,
      item_type: "primary",
      duration_minutes: 30,
    })
    .select("id")
    .single();
  if (serviceItemError || !serviceItem) {
    throw new Error(`建立測試服務項目失敗:${serviceItemError?.message}`);
  }

  const staffName = `${STAFF_NAME_PREFIX}${runId}`;
  // #636(SPECS-INDEX):merchant_staff.phone 這次改成 NOT NULL + CHECK(^09\d{8}$)(#595/#596),
  // 這裡補一個合法格式的佔位電話(用 runId 後 8 碼湊成 09 開頭 10 碼),避免建立 fixture 時
  // 直接違反資料庫層約束(這是這次 QA 打回 #612 的阻斷性問題,見回報)。
  const staffPhone = `09${runId.slice(-8)}`;
  const { data: staff, error: staffError } = await client
    .from("merchant_staff")
    .insert({
      merchant_id: merchantId as string,
      name: staffName,
      phone: staffPhone,
      no_time_slot_limit: true,
    })
    .select("id")
    .single();
  if (staffError || !staff) {
    throw new Error(`建立測試服務人員失敗:${staffError?.message}`);
  }

  const memberName = `${MEMBER_NAME_PREFIX}${runId}`;
  const { data: member, error: memberError } = await client.rpc("create_member", {
    p_merchant_id: merchantId as string,
    p_name: memberName,
    p_phone: "0955889001",
  });
  if (memberError || !member) {
    throw new Error(`建立測試會員失敗:${memberError?.message}`);
  }

  return {
    runId,
    email,
    session,
    merchantId: merchantId as string,
    staffId: (staff as { id: string }).id,
    staffName,
    serviceItemId: (serviceItem as { id: string }).id,
    memberId: (member as { id: string }).id,
    memberName,
  };
}

/** 把 fixture 的真實 session 灌進瀏覽器 localStorage,比照 payroll-fixture.ts/members-fixture.ts
 * 的做法。 */
export async function injectLineNotificationsFixtureSession(
  page: Page,
  fixture: LineNotificationsFixture,
): Promise<void> {
  const storageKey = getSupabaseAuthStorageKey();
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(fixture.session)] as [string, string],
  );
}

/** 用 fixture 的 session 建立一個可以直接呼叫 RPC 的 client,供測試案例在 UI 操作之外,
 * 額外準備/查驗某些畫面操作不到的資料狀態(例如建立一筆 pending_confirmation 訂單)。 */
export async function getAuthedFixtureClient(
  fixture: LineNotificationsFixture,
): Promise<SupabaseClient> {
  const client = createFixtureSupabaseClient();
  const { error } = await client.auth.setSession({
    access_token: fixture.session.access_token,
    refresh_token: fixture.session.refresh_token,
  });
  if (error) throw new Error(`還原測試帳號 session 失敗:${error.message}`);
  return client;
}

// OrdersPage(§1.1)依 start_at 由舊到新排序,不是依建立時間——同一支電話號碼在跨測試案例
// 重複使用時,`.first()` 抓到的列不保證是「這次剛建立的那一筆」。這裡讓每一次呼叫都用不同的
// 電話號碼尾碼 + 遞增的預約時間,讓每個測試案例可以用自己專屬、不會跟其他測試案例混淆的電話
// 號碼精準定位到那唯一一列。
let pendingBookingCounter = 0;

export interface PendingBookingResult {
  bookingId: string;
  customerPhone: string;
}

/** 建立一筆 pending_confirmation 狀態的測試訂單,供「確認訂單」相關測試使用。 */
export async function createPendingBooking(
  fixture: LineNotificationsFixture,
  options?: { memberId?: string | null },
): Promise<PendingBookingResult> {
  pendingBookingCounter += 1;
  const client = await getAuthedFixtureClient(fixture);
  // 固定約在「明天(台北時間)上午 9 點」起、每次呼叫往後錯開 1 小時(服務項目本身是 30
  // 分鐘,錯開 1 小時確保同一個 staff 的多筆測試訂單彼此時段不重疊),同時確保同一天內不會跨到
  // 隔天(create_booking 目前不支援跨日預約)。比照 members-fixture.ts 既有慣例,用
  // buildTaipeiIso 而不是裸的 Date 建構子,避免這台機器本身的時區設定影響「上午 9 點」實際
  // 對應到哪個時刻。
  const tomorrowDateKey = toDateKey(addDays(getTaipeiNow(), 1));
  const hour = 9 + pendingBookingCounter;
  const minute = 0;
  const startAt = buildTaipeiIso(
    tomorrowDateKey,
    `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`,
  );
  const customerPhone = `09558${(90000 + pendingBookingCounter).toString().slice(-5)}`;

  // #604(SPECS-INDEX,對應 supabase/migrations/20260922160600_req604_payment_method_required.sql):
  // create_booking 這次改成付款方式必填(p_payment_method_id 不能是 null),否則 RPC 直接
  // raise exception「請選擇付款方式」——這是這次盤點 #636(fixture 缺 phone)時額外發現的
  // 另一個既有缺口(fixture 沒有跟上 #604 這個規則調整),已在回報中向主腦說明。
  // create_group_and_merchant 建立商家時已經自動呼叫 seed_default_payment_methods(),
  // 所以這裡直接查一筆該商家目前的啟用中付款方式來用,不用另外建立。
  const { data: paymentMethod, error: paymentMethodError } = await client
    .from("payment_methods")
    .select("id")
    .eq("merchant_id", fixture.merchantId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (paymentMethodError || !paymentMethod) {
    throw new Error(
      `查詢測試商家的預設付款方式失敗:${paymentMethodError?.message ?? "查無啟用中的付款方式"}`,
    );
  }

  const { data, error } = await client.rpc("create_booking", {
    p_merchant_id: fixture.merchantId,
    p_staff_id: fixture.staffId,
    p_service_items: [{ service_item_id: fixture.serviceItemId, quantity: 1, unit_price: 800 }],
    p_start_at: startAt,
    p_customer_name: "E2E測試客戶(LINE通知模組)",
    p_customer_phone: customerPhone,
    p_payment_method_id: (paymentMethod as { id: string }).id,
    ...(options?.memberId ? { p_member_id: options.memberId } : {}),
  });
  if (error || !data) throw new Error(`建立測試訂單失敗:${error?.message}`);
  return { bookingId: (data as { id: string }).id, customerPhone };
}

/** 測試結束後盡量把 fixture 清乾淨(client 端 publishable key 只能做到軟停用/軟移除,真正的
 * 硬刪除由本次交付流程用資料庫直接 SQL 存取權限另外處理並查證,見回報內容)。 */
export async function teardownLineNotificationsFixture(
  fixture: LineNotificationsFixture,
): Promise<string[]> {
  const client = createFixtureSupabaseClient();
  const { error: sessionError } = await client.auth.setSession({
    access_token: fixture.session.access_token,
    refresh_token: fixture.session.refresh_token,
  });
  if (sessionError) {
    return [`警告:無法還原測試帳號 session,略過軟清理(${sessionError.message})`];
  }

  const actions: string[] = [];

  const { error: memberError } = await client
    .from("members")
    .update({ status: "removed" })
    .eq("id", fixture.memberId);
  actions.push(
    memberError ? `下架 fixture 會員失敗:${memberError.message}` : "已下架 fixture 會員(軟刪除)",
  );

  const { error: staffError } = await client
    .from("merchant_staff")
    .update({ status: "removed" })
    .eq("id", fixture.staffId);
  actions.push(
    staffError ? `移除 fixture 服務人員失敗:${staffError.message}` : "已移除 fixture 服務人員(軟刪除)",
  );

  const { error: disableError } = await client
    .from("merchants")
    .update({ status: "disabled" })
    .eq("id", fixture.merchantId);
  actions.push(
    disableError ? `停用 fixture 商家失敗:${disableError.message}` : "已停用 fixture 商家(軟刪除)",
  );

  return actions;
}
