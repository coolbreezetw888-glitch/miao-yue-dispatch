// 模組 8(薪資與帳務)規格書 §7/§8 要求的 Playwright 測試(4.3 店家帳務報表/4.4 師傅報表)共用的
// fixture——建立/清理 e2e/payroll-reports.spec.ts 用的真實測試資料。
//
// 為什麼要真的建立資料,不用 mock:這兩支測試驗證的是「後端計算結果有沒有真的正確傳到畫面上」
// (完成一筆按件計酬訂單後,帳務報表/師傅報表正確出現對應抽成金額;登記一筆月薪制服務人員的
// 請假紀錄後,報表正確反映扣款;切換不同計酬類型的服務人員,報表版面正確切換),只有真的呼叫
// 後端 RPC(create_booking/confirm_booking/complete_booking/create_staff_leave)、再看真實畫面
// 渲染結果,才測得出來。資料建立方式完全比照 e2e/support/scheduling-leave-fixture.ts 的既有做法:
// 用 @supabase/supabase-js 以 publishable key 真實 signUp() 建立一個全新測試帳號,呼叫真正的
// RPC/資料表操作(跟前端 src/modules/payroll/api.ts 呼叫的是同一組 RPC/資料表),打正式 Supabase
// 專案(.env 的 wjtbmmnakcriuaqoknsq)。
//
// **測試資料清理(比 scheduling-leave-fixture.ts 更進一步)**:teardown 除了比照既有做法做
// 「軟停用/軟移除」,這次額外在測試跑完後,由主腦/工程師用有資料庫直接 SQL 存取權限的管道
// (mcp__claude_ai_Supabase__execute_sql)把這個 runId 底下建立的 auth.users/groups/merchants
// 整組硬刪除乾淨(merchants 硬刪除會 cascade 掉底下所有 merchant_staff/bookings/
// booking_commission_records/staff_salary_settings/leave_type_deduction_rules 等關聯資料),
// 並用 SQL 查詢逐表確認歸零——這件事記錄在這次模組 8 的回報內容裡,不是這個檔案本身能自動做到的
// (client 端的 anon/publishable key 權限不足以硬刪除 auth.users/merchants)。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { getSupabaseAuthStorageKey } from "./supabase-storage-key";
import { buildTaipeiIso, getTaipeiNow, toDateKey } from "../../src/modules/booking/dateUtils";
import { disableFixtureMerchant } from "./merchant-teardown-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readEnvValue(key: string): string {
  const envPath = resolve(__dirname, "../../.env");
  const content = readFileSync(envPath, "utf-8");
  const line = content
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`) || l.startsWith(`${key} =`));
  if (!line) {
    throw new Error(`找不到 .env 裡的 ${key}——payroll 這個 e2e 測試需要它來建立 fixture 資料。`);
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

export const PIECE_RATE_STAFF_NAME_PREFIX = "E2E測試按件師傅";
export const MONTHLY_SALARY_STAFF_NAME_PREFIX = "E2E測試月薪師傅";
export const COMMISSION_RATE_PERCENTAGE = 20; // 商家預設抽成比例,固定用這個數字方便斷言。
export const BOOKING_SUBTOTAL = 1000; // 自訂總金額,固定用這個數字方便斷言。
export const EXPECTED_COMMISSION_AMOUNT = (BOOKING_SUBTOTAL * COMMISSION_RATE_PERCENTAGE) / 100; // 200
export const MONTHLY_BASE_SALARY = 3000;
// #578(SPECS-INDEX,對應 supabase/migrations/20260922130200_req578_drop_pay_days_per_month_column.sql):
// merchant_payroll_settings.pay_days_per_month 欄位已經整個移除,「月折算天數」改成後端
// private.compute_staff_payroll 依「這筆扣款實際落在的年月」呼叫 private.get_days_in_month
// 動態算出(28~31,含閏年判斷),不再是商家可以填寫的固定值。這裡改成用跟後端相同的邏輯
// (JS 版的「當月實際天數」)在測試執行當下(Asia/Taipei)動態算出,取代原本寫死的 30,
// 讓斷言在任何月份執行都能對得上後端的真實計算結果。
const payDaysNow = getTaipeiNow();
export const PAY_DAYS_PER_MONTH = new Date(
  payDaysNow.getFullYear(),
  payDaysNow.getMonth() + 1,
  0,
).getDate();
// 比照後端 round(v_day_rate * overlap_days, 2) 的四捨五入方式(overlap_days 固定請假 1 天),
// 避免非 30 天的月份(例如 31 天)算出來的小數位跟後端顯示的四捨五入結果對不上。
export const EXPECTED_LEAVE_DEDUCTION =
  Math.round((MONTHLY_BASE_SALARY / PAY_DAYS_PER_MONTH) * 100) / 100;

export interface PayrollFixture {
  runId: string;
  email: string;
  password: string;
  session: Session;
  groupId: string;
  merchantId: string;
  pieceRateStaffId: string;
  pieceRateStaffName: string;
  monthlySalaryStaffId: string;
  monthlySalaryStaffName: string;
  leaveTypeId: string;
  bookingId: string;
  leaveRecordId: string;
  todayDateKey: string;
  currentYear: number;
  currentMonth: number;
}

/** 建立這次測試需要的全部 fixture 資料:一個新商家 + 一位按件計酬服務人員(完成一筆訂單,
 * 產生一筆抽成快照紀錄)+ 一位月薪制服務人員(登記一筆整天請假,產生扣款)。任何一步失敗就整個
 * 丟出例外,不留半套資料誤導判斷。 */
export async function setupPayrollFixture(): Promise<PayrollFixture> {
  const client = createFixtureSupabaseClient();
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `e2e-payroll-please-ignore-${runId}@example-overflow-test-domain.test`;
  const password = `E2ePayroll!${runId}Aa`;

  const { data: signUpData, error: signUpError } = await client.auth.signUp({ email, password });
  if (signUpError) throw new Error(`建立 e2e 測試帳號失敗(signUp):${signUpError.message}`);
  const session = signUpData.session;
  if (!session) {
    throw new Error("建立 e2e 測試帳號後拿不到可用的 session,請確認 Authentication 設定。");
  }

  const merchantName = `E2E薪資帳務測試商家${runId}`;
  const { data: merchantId, error: merchantError } = await client.rpc("create_group_and_merchant", {
    p_name: merchantName,
    p_industry_type: "in_store_beauty",
    p_contact_email: email,
    p_intro: "e2e-payroll 自動化測試用商家,測試完會清除,不是真實商家。",
  });
  if (merchantError || !merchantId) {
    throw new Error(`建立測試商家失敗:${merchantError?.message ?? "沒有回傳 merchant id"}`);
  }

  const { data: merchantRow, error: merchantRowError } = await client
    .from("merchants")
    .select("group_id")
    .eq("id", merchantId as string)
    .single();
  if (merchantRowError || !merchantRow) {
    throw new Error(`查詢測試商家所屬集團失敗:${merchantRowError?.message}`);
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
      name: "E2E測試服務項目",
      price: BOOKING_SUBTOTAL,
      item_type: "primary",
      duration_minutes: 30,
    })
    .select("id")
    .single();
  if (serviceItemError || !serviceItem) {
    throw new Error(`建立測試服務項目失敗:${serviceItemError?.message}`);
  }

  // #636(SPECS-INDEX):merchant_staff.phone 這次改成 NOT NULL + CHECK(^09\d{8}$)(#595/#596),
  // 這裡補合法格式的佔位電話(用 runId 後 7 碼 + 一碼區分兩位服務人員,湊成 09 開頭 10 碼,
  // 避免同一次測試 run 建立的兩位服務人員撞號)。
  const pieceRateStaffPhone = `09${runId.slice(-7)}0`;
  const monthlySalaryStaffPhone = `09${runId.slice(-7)}1`;

  const pieceRateStaffName = `${PIECE_RATE_STAFF_NAME_PREFIX}${runId}`;
  const { data: pieceRateStaff, error: pieceRateStaffError } = await client
    .from("merchant_staff")
    .insert({
      merchant_id: merchantId as string,
      name: pieceRateStaffName,
      phone: pieceRateStaffPhone,
      no_time_slot_limit: true,
      // compensation_type 不填,沿用預設值 piece_rate。
    })
    .select("id")
    .single();
  if (pieceRateStaffError || !pieceRateStaff) {
    throw new Error(`建立測試按件計酬服務人員失敗:${pieceRateStaffError?.message}`);
  }

  const monthlySalaryStaffName = `${MONTHLY_SALARY_STAFF_NAME_PREFIX}${runId}`;
  const { data: monthlySalaryStaff, error: monthlySalaryStaffError } = await client
    .from("merchant_staff")
    .insert({
      merchant_id: merchantId as string,
      name: monthlySalaryStaffName,
      phone: monthlySalaryStaffPhone,
      no_time_slot_limit: true,
      compensation_type: "monthly_salary",
    })
    .select("id")
    .single();
  if (monthlySalaryStaffError || !monthlySalaryStaff) {
    throw new Error(`建立測試月薪制服務人員失敗:${monthlySalaryStaffError?.message}`);
  }

  // §1.1/§3.12:新商家已經自動種入預設薪資設定(gross),這裡明確 upsert 確保
  // commission_basis_type='gross' 不受其他測試/預設值變動影響,方便斷言;抽成比例已經改成
  // 服務項目層級(商家端三項調整規格書 §二 2.2.2),見下面 staff_service_commission_rates
  // 那筆設定。#578:pay_days_per_month 欄位已移除,不再寫入這個欄位(見上面 PAY_DAYS_PER_MONTH
  // 常數的說明,「月折算天數」改成後端動態計算)。
  const { error: payrollSettingsError } = await client.from("merchant_payroll_settings").upsert(
    {
      merchant_id: merchantId as string,
      commission_basis_type: "gross",
    },
    { onConflict: "merchant_id" },
  );
  if (payrollSettingsError) {
    throw new Error(`更新測試商家薪資設定失敗:${payrollSettingsError.message}`);
  }

  // 商家端三項調整規格書 §二 2.2.1:抽成比例改成「服務人員 × 服務項目」層級設定,固定 20% 方便
  // 斷言(對應 EXPECTED_COMMISSION_AMOUNT)。
  const { error: commissionRateError } = await client.from("staff_service_commission_rates").upsert(
    {
      staff_id: (pieceRateStaff as { id: string }).id,
      service_item_id: (serviceItem as { id: string }).id,
      commission_mode: "percentage",
      commission_value: COMMISSION_RATE_PERCENTAGE,
    },
    { onConflict: "staff_id,service_item_id" },
  );
  if (commissionRateError) {
    throw new Error(`更新測試服務人員抽成設定失敗:${commissionRateError.message}`);
  }

  const { data: salarySettings, error: salarySettingsError } = await client
    .from("staff_salary_settings")
    .insert({
      staff_id: (monthlySalaryStaff as { id: string }).id,
      monthly_base_salary: MONTHLY_BASE_SALARY,
    })
    .select("id")
    .single();
  if (salarySettingsError || !salarySettings) {
    throw new Error(`建立測試月薪設定失敗:${salarySettingsError?.message}`);
  }

  // §3.12:新商家已經自動種入三筆預設假別(事假/病假/特休)+ 對應的 no_deduction 扣款規則,
  // 這裡挑「事假」改成 full_day_rate,方便斷言扣款金額。
  const { data: leaveType, error: leaveTypeError } = await client
    .from("merchant_leave_types")
    .select("id")
    .eq("merchant_id", merchantId as string)
    .eq("name", "事假")
    .single();
  if (leaveTypeError || !leaveType) {
    throw new Error(`查詢測試商家的預設假別「事假」失敗:${leaveTypeError?.message}`);
  }
  const leaveTypeId = (leaveType as { id: string }).id;

  const { error: deductionRuleError } = await client.from("leave_type_deduction_rules").upsert(
    {
      merchant_id: merchantId as string,
      leave_type_id: leaveTypeId,
      deduction_mode: "full_day_rate",
    },
    { onConflict: "leave_type_id" },
  );
  if (deductionRuleError) {
    throw new Error(`更新測試假別扣款規則失敗:${deductionRuleError.message}`);
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

  // §3.6/§3.7:建單 → 確認 → 完成,完成當下觸發 compute_booking_commission 產生抽成快照。
  const { data: bookingRow, error: bookingError } = await client.rpc("create_booking", {
    p_merchant_id: merchantId as string,
    p_staff_id: (pieceRateStaff as { id: string }).id,
    p_service_items: [
      {
        service_item_id: (serviceItem as { id: string }).id,
        quantity: 1,
        unit_price: BOOKING_SUBTOTAL,
      },
    ],
    p_start_at: buildTaipeiIso(todayDateKey, "10:00"),
    p_customer_name: "E2E測試客戶",
    p_customer_phone: "0955999000",
    p_custom_total_amount_enabled: true,
    p_custom_total_amount: BOOKING_SUBTOTAL,
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

  // §3.3(regel 2.2 情境):登記一筆「事假」整天請假,產生扣款(規則 2.7/2.8)。
  const { data: leaveRecord, error: leaveRecordError } = await client.rpc("create_staff_leave", {
    p_staff_id: (monthlySalaryStaff as { id: string }).id,
    p_leave_type_id: leaveTypeId,
    p_start_date: todayDateKey,
    p_end_date: todayDateKey,
    p_confirm_despite_conflicts: false,
  });
  if (leaveRecordError || !leaveRecord) {
    throw new Error(`建立測試請假紀錄失敗:${leaveRecordError?.message}`);
  }

  return {
    runId,
    email,
    password,
    session,
    groupId: (merchantRow as { group_id: string }).group_id,
    merchantId: merchantId as string,
    pieceRateStaffId: (pieceRateStaff as { id: string }).id,
    pieceRateStaffName,
    monthlySalaryStaffId: (monthlySalaryStaff as { id: string }).id,
    monthlySalaryStaffName,
    leaveTypeId,
    bookingId,
    leaveRecordId: (leaveRecord as { id: string }).id,
    todayDateKey,
    currentYear: today.getFullYear(),
    currentMonth: today.getMonth() + 1,
  };
}

/** 把 fixture 的真實 session 灌進瀏覽器 localStorage,比照 scheduling-leave-fixture.ts 的做法。 */
export async function injectPayrollFixtureSession(
  page: Page,
  fixture: PayrollFixture,
): Promise<void> {
  const storageKey = getSupabaseAuthStorageKey();
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(fixture.session)] as [string, string],
  );
}

/** 測試結束後盡量把 fixture 清乾淨(client 端 anon key 只能做到軟停用/軟移除,見檔案開頭說明,
 * 真正的硬刪除由本次交付流程用資料庫直接 SQL 存取權限另外處理並查證,見回報內容)。 */
export async function teardownPayrollFixture(fixture: PayrollFixture): Promise<string[]> {
  const client = createFixtureSupabaseClient();
  const { error: sessionError } = await client.auth.setSession({
    access_token: fixture.session.access_token,
    refresh_token: fixture.session.refresh_token,
  });
  if (sessionError) {
    return [`警告:無法還原測試帳號 session,略過軟清理(${sessionError.message})`];
  }

  const actions: string[] = [];

  const { error: staffError } = await client
    .from("merchant_staff")
    .update({ status: "removed" })
    .in("id", [fixture.pieceRateStaffId, fixture.monthlySalaryStaffId]);
  actions.push(
    staffError
      ? `移除 fixture 服務人員失敗:${staffError.message}`
      : "已移除 fixture 服務人員(軟刪除)",
  );

  actions.push(await disableFixtureMerchant(client, fixture.merchantId));

  return actions;
}
