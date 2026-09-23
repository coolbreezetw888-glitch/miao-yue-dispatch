// 模組 12 品管打回重做(2026-09-21)要求補上的 Playwright 測試共用 fixture——
// e2e/industry-transfer.spec.ts 用的真實測試資料(§4.4 產業轉移精靈完整流程)。
//
// 這支測試會在精靈流程「步驟一」自己透過 UI 建立一間新商家(到府派工 on_site_dispatch，
// 跟來源商家的到店服務 in_store_beauty 不同產業，貼近真實的「產業轉移」情境)，所以 setup
// 只需要準備「來源商家 + 一位要搬遷的既有會員(有點數餘額)」，新商家 id 由測試本身在流程跑完
// 後取得，一併交回 teardown 硬清理範圍(見回報內容)。
//
// 2026-09-21 品管第二輪複驗(缺口 2):補上規則 2.11「舊商家該會員的歷史訂單，轉移後不再顯示
// 可點擊的會員連結」這個核心必測情境——setup 額外在來源商家建立營業時間/服務項目/服務人員，
// 並用既有的 create_booking 建一筆連結到待搬遷會員的訂單(比照 e2e/support/report-export-fixture.ts
// 的做法)，供 industry-transfer.spec.ts 在轉移完成後驗證這筆訂單的 member_id 是否正確斷開。
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

export function createFixtureSupabaseClient(): SupabaseClient {
  const url = readEnvValue("VITE_SUPABASE_URL");
  const key = readEnvValue("VITE_SUPABASE_PUBLISHABLE_KEY");
  return createClient(url, key, {
    global: { fetch: buildFetch(key) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const INITIAL_POINTS_BALANCE = 50;

export interface IndustryTransferFixture {
  runId: string;
  email: string;
  session: Session;
  sourceMerchantId: string;
  memberId: string;
  memberName: string;
  newMerchantName: string;
  /** 缺口 2:來源商家一筆連結到待搬遷會員的歷史訂單,轉移後應該斷開 member_id。 */
  sourceBookingId: string;
  sourceBookingCustomerPhone: string;
}

export async function setupIndustryTransferFixture(): Promise<IndustryTransferFixture> {
  const client = createFixtureSupabaseClient();
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `e2e-data12-transfer-please-ignore-${runId}@example-overflow-test-domain.test`;
  const password = `E2eData12T!${runId}Aa`;

  const { data: signUpData, error: signUpError } = await client.auth.signUp({ email, password });
  if (signUpError) throw new Error(`建立 e2e 測試帳號失敗(signUp):${signUpError.message}`);
  const session = signUpData.session;
  if (!session) {
    throw new Error("建立 e2e 測試帳號後拿不到可用的 session,請確認 Authentication 設定。");
  }

  const merchantName = `E2E產業轉移來源商家${runId}`;
  const { data: merchantId, error: merchantError } = await client.rpc("create_group_and_merchant", {
    p_name: merchantName,
    p_industry_type: "in_store_beauty",
    p_contact_email: email,
    p_intro: "e2e-industry-transfer 自動化測試用來源商家,測試完會清除,不是真實商家。",
  });
  if (merchantError || !merchantId) {
    throw new Error(`建立測試商家失敗:${merchantError?.message ?? "沒有回傳 merchant id"}`);
  }

  const memberName = `E2E待搬遷會員${runId}`;
  const { data: member, error: memberError } = await client.rpc("create_member", {
    p_merchant_id: merchantId as string,
    p_name: memberName,
    p_phone: "0955555001",
  });
  if (memberError || !member) {
    throw new Error(`建立測試會員失敗:${memberError?.message}`);
  }
  const memberId = (member as { id: string }).id;

  const { error: adjustError } = await client.rpc("adjust_member_points", {
    p_member_id: memberId,
    p_points_delta: INITIAL_POINTS_BALANCE,
    p_note: "e2e 產業轉移測試灌點,方便驗證搬遷後點數餘額不變",
  });
  if (adjustError) throw new Error(`fixture 灌點失敗:${adjustError.message}`);

  // 缺口 2(規則 2.11 核心必測):在來源商家建立一筆連結到這位待搬遷會員的訂單,轉移後
  // 驗證這筆訂單的 member_id 被斷開、member_name_snapshot 保留文字。比照
  // e2e/support/report-export-fixture.ts 的做法,先把營業時間開好、建一個服務項目跟一位不受
  // 時段限制的服務人員,再呼叫既有的 create_booking 建單,避免因為排程驗證失敗導致 fixture 不穩定。
  // 補充:整個轉移精靈流程(IndustryTransferWizardPage.tsx)自始至終都以
  // useCurrentMerchant() 讀到的來源商家當作 sourceMerchantId,過程中不會呼叫
  // setCurrentMerchantId 切換「目前操作中的商家」——即使畫面上已經多了一間新商家,轉移完成後
  // 「目前操作中的商家」仍然是來源商家,測試不需要額外切換就能直接查看來源商家的訂單。
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
      name: "E2E產業轉移測試服務項目",
      price: 500,
      item_type: "primary",
      duration_minutes: 30,
    })
    .select("id")
    .single();
  if (serviceItemError || !serviceItem) {
    throw new Error(`建立測試服務項目失敗:${serviceItemError?.message}`);
  }

  // #636(SPECS-INDEX):merchant_staff.phone 這次改成 NOT NULL + CHECK(^09\d{8}$)(#595/#596),
  // 這裡補一個合法格式的佔位電話(用 runId 後 8 碼湊成 09 開頭 10 碼)。
  const staffPhone = `09${runId.slice(-8)}`;
  const { data: staff, error: staffError } = await client
    .from("merchant_staff")
    .insert({
      merchant_id: merchantId as string,
      name: `E2E產業轉移測試服務人員${runId}`,
      phone: staffPhone,
      no_time_slot_limit: true,
    })
    .select("id")
    .single();
  if (staffError || !staff) {
    throw new Error(`建立測試服務人員失敗:${staffError?.message}`);
  }

  const today = getTaipeiNow();
  const todayDateKey = toDateKey(today);
  const sourceBookingCustomerPhone = "0955555099";

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
        unit_price: 500,
      },
    ],
    p_start_at: buildTaipeiIso(todayDateKey, "10:00"),
    p_customer_name: `E2E產業轉移訂單客戶${runId}`,
    p_customer_phone: sourceBookingCustomerPhone,
    p_custom_total_amount_enabled: true,
    p_custom_total_amount: 500,
    p_member_id: memberId,
    p_payment_method_id: (paymentMethod as { id: string }).id,
  });
  if (bookingError || !bookingRow) {
    throw new Error(`建立測試訂單失敗:${bookingError?.message}`);
  }
  const sourceBookingId = (bookingRow as { id: string }).id;

  return {
    runId,
    email,
    session,
    sourceMerchantId: merchantId as string,
    memberId,
    memberName,
    newMerchantName: `E2E產業轉移新商家${runId}`,
    sourceBookingId,
    sourceBookingCustomerPhone,
  };
}

export async function injectIndustryTransferFixtureSession(
  page: Page,
  fixture: IndustryTransferFixture,
): Promise<void> {
  const storageKey = getSupabaseAuthStorageKey();
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(fixture.session)] as [string, string],
  );
}

/** teardown 需要額外知道測試流程中建立的目標商家 id(setup 時還不存在，測試跑完才知道)。 */
export async function teardownIndustryTransferFixture(
  fixture: IndustryTransferFixture,
  createdTargetMerchantId: string | null,
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

  // 來源商家跟測試中建立的目標商家各自是「自己集團裡僅存的一間商家」(分別由
  // create_group_and_merchant/轉移精靈流程各自建立在不同集團底下),不能合併成一次
  // `.in("id", merchantIds)` 停用——disableFixtureMerchant 需要針對每一間各自查詢自己的
  // group_id、各自建立佔位商家,所以這裡逐一呼叫。
  const merchantIds = [fixture.sourceMerchantId, ...(createdTargetMerchantId ? [createdTargetMerchantId] : [])];
  for (const merchantId of merchantIds) {
    actions.push(await disableFixtureMerchant(client, merchantId));
  }

  return actions;
}
