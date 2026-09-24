// 模組 12 品管打回重做(2026-09-21)要求補上的 Playwright 測試共用 fixture——
// e2e/reports-export.spec.ts 用的真實測試資料(§4.3 報表匯出中心:訂單/會員/抽成三種報表類型)。
//
// 做法比照 e2e/support/payroll-fixture.ts:建立一個按件計酬服務人員 + 完成一筆訂單(產生抽成
// 快照紀錄，訂單報表跟抽成報表都用得到)+ 一位會員(會員報表用)。
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
    throw new Error(`找不到 .env 裡的 ${key}——這個 e2e 測試需要它來建立 fixture 資料。`);
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

export const BOOKING_SUBTOTAL = 1000;
export const COMMISSION_RATE_PERCENTAGE = 20;

export interface ReportExportFixture {
  runId: string;
  email: string;
  session: Session;
  merchantId: string;
  staffId: string;
  staffName: string;
  memberId: string;
  memberName: string;
  customerName: string;
  bookingId: string;
  currentYear: number;
  currentMonth: number;
}

export async function setupReportExportFixture(): Promise<ReportExportFixture> {
  const client = createFixtureSupabaseClient();
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `e2e-data12-reports-please-ignore-${runId}@example-overflow-test-domain.test`;
  const password = `E2eData12R!${runId}Aa`;

  const { data: signUpData, error: signUpError } = await client.auth.signUp({ email, password });
  if (signUpError) throw new Error(`建立 e2e 測試帳號失敗(signUp):${signUpError.message}`);
  const session = signUpData.session;
  if (!session) {
    throw new Error("建立 e2e 測試帳號後拿不到可用的 session,請確認 Authentication 設定。");
  }

  const merchantName = `E2E報表匯出中心測試商家${runId}`;
  const { data: merchantId, error: merchantError } = await client.rpc("create_group_and_merchant", {
    p_name: merchantName,
    p_industry_type: "in_store_beauty",
    p_contact_email: email,
    p_intro: "e2e-reports-export 自動化測試用商家,測試完會清除,不是真實商家。",
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
      name: "E2E報表測試服務項目",
      price: BOOKING_SUBTOTAL,
      item_type: "primary",
      duration_minutes: 30,
    })
    .select("id")
    .single();
  if (serviceItemError || !serviceItem) {
    throw new Error(`建立測試服務項目失敗:${serviceItemError?.message}`);
  }

  const staffName = `E2E報表測試服務人員${runId}`;
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
      // compensation_type 不填,沿用預設值 piece_rate。
    })
    .select("id")
    .single();
  if (staffError || !staff) {
    throw new Error(`建立測試服務人員失敗:${staffError?.message}`);
  }

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
  // 斷言(抽成報表需要有非零金額可以顯示)。
  const { error: commissionRateError } = await client.from("staff_service_commission_rates").upsert(
    {
      staff_id: (staff as { id: string }).id,
      service_item_id: (serviceItem as { id: string }).id,
      commission_mode: "percentage",
      commission_value: COMMISSION_RATE_PERCENTAGE,
    },
    { onConflict: "staff_id,service_item_id" },
  );
  if (commissionRateError) {
    throw new Error(`更新測試服務人員抽成設定失敗:${commissionRateError.message}`);
  }

  const memberName = `E2E報表測試會員${runId}`;
  const { data: member, error: memberError } = await client.rpc("create_member", {
    p_merchant_id: merchantId as string,
    p_name: memberName,
    p_phone: "0955444001",
  });
  if (memberError || !member) {
    throw new Error(`建立測試會員失敗:${memberError?.message}`);
  }

  const today = getTaipeiNow();
  const todayDateKey = toDateKey(today);
  const customerName = `E2E報表測試客戶${runId}`;

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
    p_customer_name: customerName,
    p_customer_phone: "0955444099",
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

  return {
    runId,
    email,
    session,
    merchantId: merchantId as string,
    staffId: (staff as { id: string }).id,
    staffName,
    memberId: (member as { id: string }).id,
    memberName,
    customerName,
    bookingId,
    currentYear: today.getFullYear(),
    currentMonth: today.getMonth() + 1,
  };
}

export async function injectReportExportFixtureSession(
  page: Page,
  fixture: ReportExportFixture,
): Promise<void> {
  const storageKey = getSupabaseAuthStorageKey();
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(fixture.session)] as [string, string],
  );
}

export async function teardownReportExportFixture(fixture: ReportExportFixture): Promise<string[]> {
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
    staffError
      ? `移除 fixture 服務人員失敗:${staffError.message}`
      : "已移除 fixture 服務人員(軟刪除)",
  );

  actions.push(await disableFixtureMerchant(client, fixture.merchantId));

  return actions;
}
