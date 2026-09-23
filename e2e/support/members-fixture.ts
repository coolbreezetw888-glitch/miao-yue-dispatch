// 模組 10(會員與紅利)規格書 §7/§8 要求的 Playwright 測試(4.1 會員管理列表頁/4.2 會員詳情頁/
// 4.4 建單疊加/4.5 訂單詳情頁會員連結)共用的 fixture——建立/清理 e2e/members.spec.ts 用的
// 真實測試資料。做法完全比照 e2e/support/payroll-fixture.ts 的既有慣例:用
// @supabase/supabase-js 以 publishable key 真實 signUp() 建立一個全新測試帳號,呼叫正式的
// RPC/資料表操作(跟前端 src/modules/members/api.ts 呼叫的是同一組 RPC),打正式 Supabase 專案
// (.env 的 wjtbmmnakcriuaqoknsq)。
//
// 測試資料清理:teardown 做「軟停用/軟移除」(client 端 publishable key 權限不足以硬刪除
// auth.users/merchants);測試跑完後,由工程師用有資料庫直接 SQL 存取權限的管道
// (mcp__claude_ai_Supabase__execute_sql)把這個 runId 底下建立的 auth.users/groups/merchants
// 整組硬刪除乾淨(merchants 硬刪除會 cascade 掉底下所有 merchant_staff/bookings/members/
// member_point_transactions 等關聯資料),並用 SQL 查詢逐表確認歸零——這件事記錄在回報內容裡。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { getSupabaseAuthStorageKey } from "./supabase-storage-key";
import { buildTaipeiIso, getTaipeiNow, toDateKey } from "../../src/modules/booking/dateUtils";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readEnvValue(key: string): string {
  const envPath = resolve(__dirname, "../../.env");
  const content = readFileSync(envPath, "utf-8");
  const line = content
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`) || l.startsWith(`${key} =`));
  if (!line) {
    throw new Error(`找不到 .env 裡的 ${key}——members 這個 e2e 測試需要它來建立 fixture 資料。`);
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

export const STAFF_NAME_PREFIX = "E2E測試會員模組師傅";
export const EXISTING_MEMBER_NAME_PREFIX = "E2E測試既有會員";
export const REFERRED_MEMBER_NAME_PREFIX = "E2E測試被推薦會員";
export const BOOKING_SUBTOTAL = 1000;
export const POINTS_EARN_RATE = 100; // 每 100 元 1 點
export const INITIAL_POINTS_BALANCE = 30; // 手動灌點,方便測試兌換

export interface MembersFixture {
  runId: string;
  email: string;
  session: Session;
  merchantId: string;
  staffId: string;
  serviceItemId: string;
  existingMemberId: string;
  existingMemberName: string;
  referredMemberId: string;
  referredMemberName: string;
  completedBookingId: string;
  todayDateKey: string;
}

/** 建立這次測試需要的全部 fixture 資料:一個新商家 + 一位服務人員 + 一位既有會員(手動灌點,
 * 方便測兌換)+ 一位被這位會員推薦的會員 + 一筆已連結既有會員並完成的訂單(方便測相關訂單/
 * 訂單詳情頁會員連結)。任何一步失敗就整個丟出例外,不留半套資料誤導判斷。 */
export async function setupMembersFixture(): Promise<MembersFixture> {
  const client = createFixtureSupabaseClient();
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `e2e-members-please-ignore-${runId}@example-overflow-test-domain.test`;
  const password = `E2eMembers!${runId}Aa`;

  const { data: signUpData, error: signUpError } = await client.auth.signUp({ email, password });
  if (signUpError) throw new Error(`建立 e2e 測試帳號失敗(signUp):${signUpError.message}`);
  const session = signUpData.session;
  if (!session) {
    throw new Error("建立 e2e 測試帳號後拿不到可用的 session,請確認 Authentication 設定。");
  }

  const merchantName = `E2E會員模組測試商家${runId}`;
  const { data: merchantId, error: merchantError } = await client.rpc("create_group_and_merchant", {
    p_name: merchantName,
    p_industry_type: "in_store_beauty",
    p_contact_email: email,
    p_intro: "e2e-members 自動化測試用商家,測試完會清除,不是真實商家。",
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
      name: "E2E測試服務項目(會員模組)",
      price: BOOKING_SUBTOTAL,
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
  // 這裡補一個合法格式的佔位電話(用 runId 後 8 碼湊成 09 開頭 10 碼)。
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

  // §1.1/§3.15:新商家已經自動種入預設會員設定(全部 0/false),這裡改成固定數字方便斷言。
  const { error: memberSettingsError } = await client.from("merchant_member_settings").upsert(
    {
      merchant_id: merchantId as string,
      points_earn_rate: POINTS_EARN_RATE,
      referral_bonus_points: 20,
      birthday_bonus_points: 0,
    },
    { onConflict: "merchant_id" },
  );
  if (memberSettingsError) {
    throw new Error(`更新測試商家會員設定失敗:${memberSettingsError.message}`);
  }

  const existingMemberName = `${EXISTING_MEMBER_NAME_PREFIX}${runId}`;
  const { data: existingMember, error: existingMemberError } = await client.rpc("create_member", {
    p_merchant_id: merchantId as string,
    p_name: existingMemberName,
    p_phone: "0955888001",
  });
  if (existingMemberError || !existingMember) {
    throw new Error(`建立測試既有會員失敗:${existingMemberError?.message}`);
  }
  const existingMemberId = (existingMember as { id: string }).id;

  const { error: adjustError } = await client.rpc("adjust_member_points", {
    p_member_id: existingMemberId,
    p_points_delta: INITIAL_POINTS_BALANCE,
    p_note: "e2e 測試灌點,方便測試兌換流程",
  });
  if (adjustError) throw new Error(`fixture 灌點失敗:${adjustError.message}`);

  const referredMemberName = `${REFERRED_MEMBER_NAME_PREFIX}${runId}`;
  const { data: referredMember, error: referredMemberError } = await client.rpc("create_member", {
    p_merchant_id: merchantId as string,
    p_name: referredMemberName,
    p_phone: "0955888002",
    p_referred_by_member_id: existingMemberId,
  });
  if (referredMemberError || !referredMember) {
    throw new Error(`建立測試被推薦會員失敗:${referredMemberError?.message}`);
  }

  const today = getTaipeiNow();
  const todayDateKey = toDateKey(today);

  // §3.6/§3.7/§3.8:建單(連結既有會員)→ 確認 → 完成,驗證相關訂單/訂單詳情頁會員連結。
  const { data: bookingRow, error: bookingError } = await client.rpc("create_booking", {
    p_merchant_id: merchantId as string,
    p_staff_id: (staff as { id: string }).id,
    p_service_items: [
      {
        service_item_id: (serviceItem as { id: string }).id,
        quantity: 1,
        unit_price: BOOKING_SUBTOTAL,
      },
    ],
    p_start_at: buildTaipeiIso(todayDateKey, "10:00"),
    p_customer_name: "E2E測試客戶(會員模組)",
    p_customer_phone: "0955888099",
    p_custom_total_amount_enabled: true,
    p_custom_total_amount: BOOKING_SUBTOTAL,
    p_member_id: existingMemberId,
  });
  if (bookingError || !bookingRow) {
    throw new Error(`建立測試訂單失敗:${bookingError?.message}`);
  }
  const bookingId = (bookingRow as { id: string }).id;

  const { error: confirmError } = await client.rpc("confirm_booking", { p_booking_id: bookingId });
  if (confirmError) throw new Error(`確認測試訂單失敗:${confirmError.message}`);

  const { error: completeError } = await client.rpc("complete_booking", { p_booking_id: bookingId });
  if (completeError) throw new Error(`完成測試訂單失敗:${completeError.message}`);

  return {
    runId,
    email,
    session,
    merchantId: merchantId as string,
    staffId: (staff as { id: string }).id,
    serviceItemId: (serviceItem as { id: string }).id,
    existingMemberId,
    existingMemberName,
    referredMemberId: (referredMember as { id: string }).id,
    referredMemberName,
    completedBookingId: bookingId,
    todayDateKey,
  };
}

/** 把 fixture 的真實 session 灌進瀏覽器 localStorage,比照 payroll-fixture.ts 的做法。 */
export async function injectMembersFixtureSession(page: Page, fixture: MembersFixture): Promise<void> {
  const storageKey = getSupabaseAuthStorageKey();
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(fixture.session)] as [string, string],
  );
}

/** 測試結束後盡量把 fixture 清乾淨(client 端 publishable key 只能做到軟停用/軟移除,見檔案
 * 開頭說明,真正的硬刪除由本次交付流程用資料庫直接 SQL 存取權限另外處理並查證,見回報內容)。 */
export async function teardownMembersFixture(fixture: MembersFixture): Promise<string[]> {
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
    .in("id", [fixture.existingMemberId, fixture.referredMemberId]);
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
