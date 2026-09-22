// 模組 14(服務人員端)v2 規格書第十二節要求、上一輪只更新既有測試 fixture、沒有補上的
// Playwright 測試(SPECS-INDEX 編號 484/485 品管打回重做,另外一併補齊 10.2.4/10.4.6 核心情境)
// 共用的 fixture——建立/清理 e2e/staff-portal-v2.spec.ts 用的真實測試資料。
//
// 做法完全比照既有 e2e/support/staff-portal-fixture.ts / payroll-fixture.ts:用
// @supabase/supabase-js 以 publishable key 真實 signUp() 建立商家管理員 + 服務人員兩個全新測試
// 帳號,走真正的 invite-merchant-staff Edge Function 完成邀請登入(既有帳號分支,不需要收信),
// 呼叫真正的 RPC(create_booking/confirm_booking/complete_booking/set_staff_day_override/
// clear_staff_day_override)建立測試資料,打正式 Supabase 專案(.env 的 wjtbmmnakcriuaqoknsq)。
//
// 這個 fixture 額外準備了 SPECS-INDEX 編號 485(品管打回重做的真實 bug)驗證所需的營業時間設定
// (07 天全開,09:00-18:00,確保「整天排休」一定會產生跨 24:00 的邊界情況可以被觀察到)、
// 一筆已完成訂單(供 10.2.4 行事曆兩種檢視 + 10.4.6 薪資報表跨視角一致性測試共用)。
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
    throw new Error(`找不到 .env 裡的 ${key}——staff-portal-v2 這個 e2e 測試需要它來建立 fixture 資料。`);
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

export const STAFF_NAME_PREFIX = "E2E服務人員v2測試";
export const BOOKING_SUBTOTAL = 1000; // 自訂總金額,固定方便斷言(final_amount_snapshot/total_amount)。
export const COMMISSION_RATE_PERCENTAGE = 50; // 固定方便斷言(我的抽成 = 500)。
export const EXPECTED_COMMISSION_AMOUNT = (BOOKING_SUBTOTAL * COMMISSION_RATE_PERCENTAGE) / 100; // 500

export interface StaffPortalV2Fixture {
  runId: string;
  merchantId: string;
  merchantName: string;
  adminEmail: string;
  adminSession: Session;
  staffEmail: string;
  staffSession: Session;
  staffId: string;
  staffName: string;
  serviceItemId: string;
  bookingId: string;
  todayDateKey: string;
  /** SPECS-INDEX 編號 485(核心必測)專用:今天以外、沒有任何既有預約的日期,用來標記
   * 「整天排休」,確保衝突筆數斷言乾淨(=0),也不會跟今天那筆已完成訂單互相干擾。 */
  wholeDayOffDateKey: string;
  /** 10.3.3 時段排休測試專用,跟上面那天不同,避免兩個測試互相汙染彼此的斷言。 */
  slotOffDateKey: string;
}

/** 建立這次測試需要的全部 fixture 資料。任何一步失敗就整個丟出例外,不留半套資料誤導判斷。 */
export async function setupStaffPortalV2Fixture(): Promise<StaffPortalV2Fixture> {
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const adminEmail = `e2e-staffportalv2-admin-please-ignore-${runId}@example-overflow-test-domain.test`;
  const staffEmail = `e2e-staffportalv2-staff-please-ignore-${runId}@example-overflow-test-domain.test`;
  const password = `E2eStaffPortalV2!${runId}Aa`;

  const adminClient = createFixtureSupabaseClient();
  const staffClient = createFixtureSupabaseClient();

  const { data: adminSignUp, error: adminSignUpErr } = await adminClient.auth.signUp({
    email: adminEmail,
    password,
  });
  if (adminSignUpErr || !adminSignUp.session) {
    throw new Error(`建立 e2e 管理員測試帳號失敗:${adminSignUpErr?.message ?? "沒有 session"}`);
  }

  const { data: staffSignUp, error: staffSignUpErr } = await staffClient.auth.signUp({
    email: staffEmail,
    password,
  });
  if (staffSignUpErr || !staffSignUp.session) {
    throw new Error(`建立 e2e 服務人員測試帳號失敗:${staffSignUpErr?.message ?? "沒有 session"}`);
  }

  const merchantName = `E2E服務人員端v2測試商家${runId}`;
  const { data: merchantId, error: merchantError } = await adminClient.rpc(
    "create_group_and_merchant",
    {
      p_name: merchantName,
      p_industry_type: "on_site_dispatch",
      p_address: "測試地址",
      p_contact_email: adminEmail,
      p_intro: "e2e-staff-portal-v2 自動化測試用商家,測試完會清除,不是真實商家。",
    },
  );
  if (merchantError || !merchantId) {
    throw new Error(`建立測試商家失敗:${merchantError?.message ?? "沒有回傳 merchant id"}`);
  }

  // SPECS-INDEX 編號 485 需要「整天排休一定會產生跨 24:00 的合併區間」這個情境能被商家管理員
  // 視角觀察到,所以七天全開店(不挑特定星期幾,避免週末公休造成測試在不同執行日期得到不同結果)。
  const businessHoursRows = Array.from({ length: 7 }, (_, dayOfWeek) => ({
    merchant_id: merchantId as string,
    day_of_week: dayOfWeek,
    is_closed: false,
    open_time: "09:00",
    close_time: "18:00",
  }));
  const { error: hoursError } = await adminClient
    .from("merchant_business_hours")
    .upsert(businessHoursRows, { onConflict: "merchant_id,day_of_week" });
  if (hoursError) throw new Error(`寫入測試商家營業時間失敗:${hoursError.message}`);

  const staffName = `${STAFF_NAME_PREFIX}${runId}`;
  const { data: staffRow, error: addStaffErr } = await adminClient
    .from("merchant_staff")
    .insert({
      merchant_id: merchantId as string,
      name: staffName,
      compensation_type: "piece_rate",
      no_time_slot_limit: true,
    })
    .select("id")
    .single();
  if (addStaffErr || !staffRow) {
    throw new Error(`建立測試服務人員失敗:${addStaffErr?.message}`);
  }
  const staffId = (staffRow as { id: string }).id;

  // 走真正的 Edge Function(不是直接呼叫 record_invited_staff_login),跟前端
  // src/modules/staff-portal/api.ts 的 inviteMerchantStaff() 打的是同一個端點。這一步也會連帶
  // 呼叫 seed_default_staff_permissions,四項自助權限(含 10.2/10.3/10.4 這次測試都需要的
  // staff_calendar_view/staff_availability_self_manage/staff_payroll_view)預設全部開通。
  const { data: inviteResult, error: inviteErr } = await adminClient.functions.invoke(
    "invite-merchant-staff",
    { body: { merchant_id: merchantId, staff_id: staffId, login_email: staffEmail } },
  );
  if (inviteErr) {
    throw new Error(`邀請測試服務人員登入失敗:${inviteErr.message}`);
  }
  if ((inviteResult as { login_status?: string })?.login_status !== "active") {
    throw new Error(`邀請結果非預期(應該是既有帳號直接開通):${JSON.stringify(inviteResult)}`);
  }

  const { data: serviceItem, error: serviceItemError } = await adminClient
    .from("service_items")
    .insert({
      merchant_id: merchantId as string,
      name: "E2E測試服務項目v2",
      price: BOOKING_SUBTOTAL,
      item_type: "primary",
      duration_minutes: 60,
    })
    .select("id")
    .single();
  if (serviceItemError || !serviceItem) {
    throw new Error(`建立測試服務項目失敗:${serviceItemError?.message}`);
  }
  const serviceItemId = (serviceItem as { id: string }).id;

  // 新商家已自動種入預設薪資設定(gross),這裡明確 upsert 確保 commission_basis_type='gross'
  // 不受其他測試/預設值變動影響,方便斷言。
  const { error: payrollSettingsError } = await adminClient.from("merchant_payroll_settings").upsert(
    { merchant_id: merchantId as string, commission_basis_type: "gross" },
    { onConflict: "merchant_id" },
  );
  if (payrollSettingsError) {
    throw new Error(`更新測試商家薪資設定失敗:${payrollSettingsError.message}`);
  }

  const { error: commissionRateError } = await adminClient.from("staff_service_commission_rates").upsert(
    {
      staff_id: staffId,
      service_item_id: serviceItemId,
      commission_mode: "percentage",
      commission_value: COMMISSION_RATE_PERCENTAGE,
    },
    { onConflict: "staff_id,service_item_id" },
  );
  if (commissionRateError) {
    throw new Error(`更新測試服務人員抽成設定失敗:${commissionRateError.message}`);
  }

  const today = getTaipeiNow();
  const todayDateKey = toDateKey(today);
  const wholeDayOffDateKey = toDateKey(addDays(today, 10));
  const slotOffDateKey = toDateKey(addDays(today, 11));

  // 10.2.4/10.4.6 共用:今天一筆已完成訂單,自訂總金額 1000、抽成 50% = 500,方便斷言
  // 「服務人員自助視角」與「商家管理員視角」看到的是同一個數字(跨視角一致性)。
  const { data: bookingRow, error: bookingError } = await adminClient.rpc("create_booking", {
    p_merchant_id: merchantId as string,
    p_staff_id: staffId,
    p_service_items: [{ service_item_id: serviceItemId, quantity: 1, unit_price: BOOKING_SUBTOTAL }],
    p_start_at: buildTaipeiIso(todayDateKey, "10:00"),
    p_customer_name: "E2E測試客戶v2",
    p_customer_phone: "0955888000",
    p_customer_address: "測試地址一號",
    p_custom_total_amount_enabled: true,
    p_custom_total_amount: BOOKING_SUBTOTAL,
  });
  if (bookingError || !bookingRow) {
    throw new Error(`建立測試訂單失敗:${bookingError?.message}`);
  }
  const bookingId = (bookingRow as { id: string }).id;

  const { error: confirmError } = await adminClient.rpc("confirm_booking", { p_booking_id: bookingId });
  if (confirmError) throw new Error(`確認測試訂單失敗:${confirmError.message}`);

  const { error: completeError } = await adminClient.rpc("complete_booking", { p_booking_id: bookingId });
  if (completeError) throw new Error(`完成測試訂單失敗:${completeError.message}`);

  return {
    runId,
    merchantId: merchantId as string,
    merchantName,
    adminEmail,
    adminSession: adminSignUp.session,
    staffEmail,
    staffSession: staffSignUp.session,
    staffId,
    staffName,
    serviceItemId,
    bookingId,
    todayDateKey,
    wholeDayOffDateKey,
    slotOffDateKey,
  };
}

async function injectSession(page: Page, session: Session): Promise<void> {
  const storageKey = getSupabaseAuthStorageKey();
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(session)] as [string, string],
  );
}

export async function injectStaffSession(page: Page, fixture: StaffPortalV2Fixture): Promise<void> {
  await injectSession(page, fixture.staffSession);
}

export async function injectAdminSession(page: Page, fixture: StaffPortalV2Fixture): Promise<void> {
  await injectSession(page, fixture.adminSession);
}

/** 測試結束後盡量把 fixture 清乾淨(client 端 anon key 只能做到軟停用/軟移除,真正的硬刪除由
 * 這次交付流程用資料庫直接 SQL 存取權限另外處理並查證,記錄在回報內容裡)。 */
export async function teardownStaffPortalV2Fixture(fixture: StaffPortalV2Fixture): Promise<string[]> {
  const client = createFixtureSupabaseClient();
  const { error: sessionError } = await client.auth.setSession({
    access_token: fixture.adminSession.access_token,
    refresh_token: fixture.adminSession.refresh_token,
  });
  if (sessionError) {
    return [`警告:無法還原管理員 session,略過軟清理(${sessionError.message})`];
  }

  const actions: string[] = [];

  // 測試過程中會呼叫 set_staff_day_override 標記整天排休/時段排休,測試結束後先清除,避免
  // 殘留的例外資料影響同一位服務人員之後(理論上不會再被其他測試用到,但清乾淨比較保險)。
  const { error: clearOverridesError } = await client
    .from("staff_availability_overrides")
    .delete()
    .eq("staff_id", fixture.staffId);
  actions.push(
    clearOverridesError
      ? `清除 fixture 單日例外設定失敗:${clearOverridesError.message}`
      : "已清除 fixture 單日例外設定",
  );

  const { error: staffError } = await client
    .from("merchant_staff")
    .update({ status: "removed" })
    .eq("id", fixture.staffId);
  actions.push(
    staffError ? `移除 fixture 服務人員失敗:${staffError.message}` : "已移除 fixture 服務人員(軟刪除)",
  );

  const { error: hoursError } = await client
    .from("merchant_business_hours")
    .delete()
    .eq("merchant_id", fixture.merchantId);
  actions.push(
    hoursError
      ? `刪除 fixture 營業時間設定失敗:${hoursError.message}`
      : "已刪除 fixture 營業時間設定",
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
