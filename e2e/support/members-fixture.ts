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
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { createFixtureSupabaseClient } from "./fixture-supabase-client";
import { getSupabaseAuthStorageKey } from "./supabase-storage-key";
import { buildTaipeiIso, getTaipeiNow, toDateKey } from "../../src/modules/booking/dateUtils";
import { disableFixtureMerchant } from "./merchant-teardown-helper";

const FIXTURE_PURPOSE = "members 這個 e2e 測試";

// #826(SPECS-INDEX,2026-10-01):測試資料名稱前綴改成現行用語「服務人員」。舊前綴 `E2E測試會員模組師傅`
// 建立的孤兒資料仍留在正式庫,#638 清理時新舊前綴都要涵蓋 —— 完整清單集中寫在 payroll-fixture.ts。
// teardown 是 id-based,不靠前綴篩選,改名不影響清理邏輯;spec 只透過這個常數 / fixture 回傳值比對。
export const STAFF_NAME_PREFIX = "E2E測試會員模組服務人員";
export const EXISTING_MEMBER_NAME_PREFIX = "E2E測試既有會員";
/** 既有會員的電話。§10.2(SPECS-INDEX #614)之後,建單表單是用「客戶電話」欄位去比對既有客戶,
 * 測試需要知道這支電話才能觸發 MemberPhoneMatchPanel 的候選名單,所以從寫死在下面的建立參數
 * 提升成具名常數。被推薦會員刻意用另一支電話(0955888002),確保這支電話只會比對到一位。 */
export const EXISTING_MEMBER_PHONE = "0955888001";
export const REFERRED_MEMBER_NAME_PREFIX = "E2E測試被推薦會員";
export const BOOKING_SUBTOTAL = 1000;
/** 紅利系統重構批次 6:舊的「每 N 元 1 點」欄位已刪除,改用基本模式「每滿額累計」表達同一個規則:
 * 每滿 BASIC_TIER_AMOUNT 元給 1 點(1000 元的訂單 = 10 點,跟改版前的斷言數字相同)。 */
export const BASIC_TIER_AMOUNT = 100;
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
  const client = createFixtureSupabaseClient(FIXTURE_PURPOSE);
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
      // #977 第 3 批(2026-10-06):no_time_slot_limit 改成只管客戶線上預約,後台建單不再看它。
      // 這個 fixture 原本靠它「不用布置每週時段」,改用後台的「商家後台編輯無時段限制」達到同樣效果
      // (行事曆可約時段也改看這個欄位,畫面一樣是整段營業時間可點)。
      unlimited_backend_edit: true,
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
      // 紅利系統重構:派點改由「紅利計算」的基本模式決定(建單當下定案、完成時入帳);
      // 推薦獎勵要開關 1(referral_inviter_reward_enabled)才會發。
      earn_mode: "basic",
      basic_points_per_order: 1,
      basic_min_amount: BASIC_TIER_AMOUNT,
      basic_tiered_enabled: true,
      referral_inviter_reward_enabled: true,
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
    p_phone: EXISTING_MEMBER_PHONE,
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

  // #604(SPECS-INDEX,對應 supabase/migrations/20260922160600_req604_payment_method_required.sql):
  // create_booking 付款方式已改為必填(p_payment_method_id 不能是 null),否則 RPC 直接 raise
  // exception「請選擇付款方式」。create_group_and_merchant 建立商家時已經自動呼叫
  // seed_default_payment_methods(),這裡直接查一筆該商家目前的啟用中付款方式來用(比照
  // e2e/support/line-notifications-fixture.ts 既有做法)。
  const { data: paymentMethod, error: paymentMethodError } = await client
    .from("payment_methods")
    .select("id")
    .eq("merchant_id", merchantId as string)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (paymentMethodError || !paymentMethod) {
    throw new Error(
      `查詢測試商家的預設付款方式失敗:${paymentMethodError?.message ?? "查無啟用中的付款方式"}`,
    );
  }

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
    p_payment_method_id: (paymentMethod as { id: string }).id,
  });
  if (bookingError || !bookingRow) {
    throw new Error(`建立測試訂單失敗:${bookingError?.message}`);
  }
  const bookingId = (bookingRow as { id: string }).id;

  const { error: confirmError } = await client.rpc("confirm_booking", { p_booking_id: bookingId });
  if (confirmError) throw new Error(`確認測試訂單失敗:${confirmError.message}`);

  const { error: completeError } = await client.rpc("complete_booking", {
    p_booking_id: bookingId,
  });
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
export async function injectMembersFixtureSession(
  page: Page,
  fixture: MembersFixture,
): Promise<void> {
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
  const client = createFixtureSupabaseClient(FIXTURE_PURPOSE);
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
    staffError
      ? `移除 fixture 服務人員失敗:${staffError.message}`
      : "已移除 fixture 服務人員(軟刪除)",
  );

  actions.push(await disableFixtureMerchant(client, fixture.merchantId));

  return actions;
}
