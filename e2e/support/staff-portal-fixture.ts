// 模組 14(服務人員端)規格書第七節要求的 Playwright 測試共用 fixture——建立/清理
// e2e/staff-portal.spec.ts 用的真實測試資料。完全比照既有 e2e/support/payroll-fixture.ts 的做法:
// 用 @supabase/supabase-js 以 publishable key 真實 signUp() 建立兩個全新測試帳號(商家管理員 +
// 服務人員),呼叫真正的 RPC/Edge Function/資料表操作(跟前端呼叫的是同一組),打正式 Supabase
// 專案(.env 的 wjtbmmnakcriuaqoknsq)。
//
// 邀請服務人員登入這一步刻意讓 login_email 帶入「服務人員測試帳號自己的 email」(已經有帳號)——
// 這樣會走 invite-merchant-staff Edge Function 的「既有帳號直接開通」分支(規則 2.6),
// login_status 立刻變成 active,完全不需要真的收信點連結,e2e 才能在無人介入的情況下自動跑完
// 整個「邀請 → 登入 → 看到自助功能」的流程。
//
// 測試資料清理:跟 payroll-fixture.ts 同一套做法,client 端 anon key 只能做到軟停用/軟移除,
// 真正的硬刪除(auth.users/merchants 一併清空)由這次交付流程用資料庫直接 SQL 存取權限另外處理
// 並查證,記錄在回報內容裡。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { getSupabaseAuthStorageKey } from "./supabase-storage-key";
import { disableFixtureMerchant } from "./merchant-teardown-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readEnvValue(key: string): string {
  const envPath = resolve(__dirname, "../../.env");
  const content = readFileSync(envPath, "utf-8");
  const line = content
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`) || l.startsWith(`${key} =`));
  if (!line) {
    throw new Error(
      `找不到 .env 裡的 ${key}——staff-portal 這個 e2e 測試需要它來建立 fixture 資料。`,
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

export const STAFF_NAME_PREFIX = "E2E測試服務人員";

export interface StaffPortalFixture {
  runId: string;
  merchantId: string;
  merchantName: string;
  adminEmail: string;
  adminSession: Session;
  staffEmail: string;
  staffSession: Session;
  staffId: string;
  staffName: string;
}

/** 建立這次測試需要的全部 fixture 資料:一個新商家(管理員帳號)+ 一位按件計酬服務人員,
 * 走真正的 invite-merchant-staff Edge Function 完成邀請登入(既有帳號分支,不需要收信)。 */
export async function setupStaffPortalFixture(): Promise<StaffPortalFixture> {
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const adminEmail = `e2e-staffportal-admin-please-ignore-${runId}@example-overflow-test-domain.test`;
  const staffEmail = `e2e-staffportal-staff-please-ignore-${runId}@example-overflow-test-domain.test`;
  const password = `E2eStaffPortal!${runId}Aa`;

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

  const merchantName = `E2E服務人員端測試商家${runId}`;
  const { data: merchantId, error: merchantError } = await adminClient.rpc(
    "create_group_and_merchant",
    {
      p_name: merchantName,
      p_industry_type: "on_site_dispatch",
      p_address: "測試地址",
      p_contact_email: adminEmail,
      p_intro: "e2e-staff-portal 自動化測試用商家,測試完會清除,不是真實商家。",
    },
  );
  if (merchantError || !merchantId) {
    throw new Error(`建立測試商家失敗:${merchantError?.message ?? "沒有回傳 merchant id"}`);
  }

  const staffName = `${STAFF_NAME_PREFIX}${runId}`;
  // #636(SPECS-INDEX):merchant_staff.phone 這次改成 NOT NULL + CHECK(^09\d{8}$)(#595/#596),
  // 這裡補一個合法格式的佔位電話(用 runId 後 8 碼湊成 09 開頭 10 碼)。
  const staffPhone = `09${runId.slice(-8)}`;
  const { data: staffRow, error: addStaffErr } = await adminClient
    .from("merchant_staff")
    .insert({
      merchant_id: merchantId as string,
      name: staffName,
      phone: staffPhone,
      compensation_type: "piece_rate",
    })
    .select("id")
    .single();
  if (addStaffErr || !staffRow) {
    throw new Error(`建立測試服務人員失敗:${addStaffErr?.message}`);
  }
  const staffId = (staffRow as { id: string }).id;

  // 走真正的 Edge Function(不是直接呼叫 record_invited_staff_login),跟前端
  // src/modules/staff-portal/api.ts 的 inviteMerchantStaff() 打的是同一個端點。
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
  };
}

/**
 * 模組 15 擴充 §7.4:用管理員身份切換「商家總開關」。
 * e2e 要驗「商家總開關關閉時,個人開關那一列會灰掉並寫明原因」,而新商家種出來的 4 種事件
 * 預設全部是關的(seed_default_push_event_settings),所以「關閉」不用特別做,
 * 「打開」才需要這支 helper。
 */
export async function setMerchantPushEventEnabled(
  fixture: StaffPortalFixture,
  eventType: string,
  enabled: boolean,
): Promise<void> {
  const client = createFixtureSupabaseClient();
  const { error: sessionError } = await client.auth.setSession({
    access_token: fixture.adminSession.access_token,
    refresh_token: fixture.adminSession.refresh_token,
  });
  if (sessionError) throw new Error(`還原管理員 session 失敗:${sessionError.message}`);

  const { error } = await client.rpc("update_push_event_setting", {
    p_merchant_id: fixture.merchantId,
    p_event_type: eventType,
    p_enabled: enabled,
    p_message_title: "E2E 推播標題",
    p_message_body: "E2E 推播內文",
  });
  if (error) throw new Error(`切換商家推播總開關失敗:${error.message}`);
}

/**
 * 模組 15 擴充:清掉這次 e2e 在 push_subscriptions / push_event_subscriptions 留下的列。
 *
 * ⚠️ **一定要在 teardownStaffPortalFixture() 之前呼叫**:這兩張表的 RLS 分別是
 * `user_id = auth.uid()` 與 `private.owns_push_target(...)`,而 owns_push_target 要求
 * 服務人員 status='active' —— teardown 會把服務人員軟移除,之後本人就再也刪不掉自己的
 * 事件訂閱列了(會變成永遠清不掉的孤兒,正是 automated-testing SKILL 第五節記錄的那個問題)。
 */
export async function cleanupPushFixtureRows(fixture: StaffPortalFixture): Promise<string[]> {
  const actions: string[] = [];
  const client = createFixtureSupabaseClient();
  const { error: sessionError } = await client.auth.setSession({
    access_token: fixture.staffSession.access_token,
    refresh_token: fixture.staffSession.refresh_token,
  });
  if (sessionError) {
    return [`警告:無法還原服務人員 session,略過推播資料清理(${sessionError.message})`];
  }

  // CLAUDE.md 第 5-1 條:刪除前先用相同篩選條件 SELECT 核對到底會刪到什麼。
  const { data: devices } = await client.from("push_subscriptions").select("id, endpoint");
  actions.push(`push_subscriptions 準備刪除 ${devices?.length ?? 0} 列(全部是這個 e2e 帳號自己的)`);
  if (devices && devices.length > 0) {
    const { error } = await client
      .from("push_subscriptions")
      .delete()
      .in(
        "id",
        devices.map((d) => (d as { id: string }).id),
      );
    actions.push(
      error ? `push_subscriptions 刪除失敗:${error.message}` : "push_subscriptions 已刪除",
    );
  }

  const { data: events } = await client
    .from("push_event_subscriptions")
    .select("id")
    .eq("merchant_id", fixture.merchantId);
  actions.push(`push_event_subscriptions 準備刪除 ${events?.length ?? 0} 列`);
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

  return actions;
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

export async function injectStaffSession(page: Page, fixture: StaffPortalFixture): Promise<void> {
  await injectSession(page, fixture.staffSession);
}

export async function injectAdminSession(page: Page, fixture: StaffPortalFixture): Promise<void> {
  await injectSession(page, fixture.adminSession);
}

/** 測試結束後盡量把 fixture 清乾淨(client 端 anon key 只能做到軟停用/軟移除,見檔案開頭說明,
 * 真正的硬刪除由本次交付流程用資料庫直接 SQL 存取權限另外處理並查證,見回報內容)。 */
export async function teardownStaffPortalFixture(fixture: StaffPortalFixture): Promise<string[]> {
  const client = createFixtureSupabaseClient();
  const { error: sessionError } = await client.auth.setSession({
    access_token: fixture.adminSession.access_token,
    refresh_token: fixture.adminSession.refresh_token,
  });
  if (sessionError) {
    return [`警告:無法還原管理員 session,略過軟清理(${sessionError.message})`];
  }

  const actions: string[] = [];

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
