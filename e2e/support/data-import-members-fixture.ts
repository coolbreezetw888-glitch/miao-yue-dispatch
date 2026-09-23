// 模組 12(資料匯入/報表匯出)品管打回重做(2026-09-21)要求補上的 Playwright 測試共用
// fixture——e2e/data-import-members.spec.ts 用的真實測試資料(§3.3/§4.1 會員匯入精靈)。
//
// 做法完全比照 e2e/support/payroll-fixture.ts / members-fixture.ts 的既有慣例:用
// @supabase/supabase-js 以 publishable key 真實 signUp() 建立一個全新測試帳號，呼叫正式的
// RPC(create_group_and_merchant)，打正式 Supabase 專案(.env 的 wjtbmmnakcriuaqoknsq)。
// 不用瀏覽器點 /signup(這個專案已知這樣做會卡住)。
//
// 這裡刻意不特別調整 merchant_member_settings.phone_required_to_create——新商家種入的預設值就是
// true(module10 §1.1)，這正是這次品管抓到的 bug(ImportWizardPage.tsx 的 rowLooksValid()
// 沒有檢查這個設定)要驗證的情境，維持預設值才是最貼近真實情況的測試。
//
// 測試資料清理:teardown 做「軟停用」(client 端 publishable key 權限不足以硬刪除
// auth.users/merchants)；測試跑完後，由工程師用有資料庫直接 SQL 存取權限的管道
// (mcp__claude_ai_Supabase__execute_sql)把這個 runId 底下建立的 auth.users/groups/merchants
// 整組硬刪除乾淨，並用 SQL 查詢逐表確認歸零——這件事記錄在回報內容裡。
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

export interface DataImportMembersFixture {
  runId: string;
  email: string;
  session: Session;
  merchantId: string;
  validMemberName: string;
  invalidMemberName: string; // 缺電話，用來驗證預覽/實際匯入判斷一致
}

export async function setupDataImportMembersFixture(): Promise<DataImportMembersFixture> {
  const client = createFixtureSupabaseClient();
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `e2e-data12-members-please-ignore-${runId}@example-overflow-test-domain.test`;
  const password = `E2eData12M!${runId}Aa`;

  const { data: signUpData, error: signUpError } = await client.auth.signUp({ email, password });
  if (signUpError) throw new Error(`建立 e2e 測試帳號失敗(signUp):${signUpError.message}`);
  const session = signUpData.session;
  if (!session) {
    throw new Error("建立 e2e 測試帳號後拿不到可用的 session,請確認 Authentication 設定。");
  }

  const merchantName = `E2E資料匯入會員測試商家${runId}`;
  const { data: merchantId, error: merchantError } = await client.rpc("create_group_and_merchant", {
    p_name: merchantName,
    p_industry_type: "in_store_beauty",
    p_contact_email: email,
    p_intro: "e2e-data-import-members 自動化測試用商家,測試完會清除,不是真實商家。",
  });
  if (merchantError || !merchantId) {
    throw new Error(`建立測試商家失敗:${merchantError?.message ?? "沒有回傳 merchant id"}`);
  }

  return {
    runId,
    email,
    session,
    merchantId: merchantId as string,
    validMemberName: `E2E會員甲${runId}`,
    invalidMemberName: `E2E會員乙缺電話${runId}`,
  };
}

export async function injectDataImportMembersFixtureSession(
  page: Page,
  fixture: DataImportMembersFixture,
): Promise<void> {
  const storageKey = getSupabaseAuthStorageKey();
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(fixture.session)] as [string, string],
  );
}

export async function teardownDataImportMembersFixture(
  fixture: DataImportMembersFixture,
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
  actions.push(await disableFixtureMerchant(client, fixture.merchantId));
  return actions;
}
