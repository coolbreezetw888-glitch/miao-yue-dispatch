// SPECS-INDEX #756/#761(規格書 .project/specs/手機推播擴及三種角色.md §13.6 / §十之二):
// e2e/app-header-320.spec.ts 用的最小 fixture —— 一個商家管理員帳號 + 一間商家,沒有別的東西。
//
// 為什麼要另外寫一支、不共用既有的 fixture:
//   ① 這支 spec 驗的是**頁首版面預算**,跟任何業務資料無關。它只需要「有一個登入得進 /app 的
//      管理員」,不需要服務人員/服務項目/訂單/假別。既有的 payroll-fixture / mobile-overflow-fixture
//      會建出十幾筆資料,每跑一次就在正式環境多留一堆殘留(SPECS-INDEX #638)。
//   ② `e2e/support/payroll-fixture.ts` 目前正被另一個批次(#767)修改中、還沒 commit,
//      import 它會讓這支版面守門員的成敗綁在那個批次上。
//
// ⚠️ 已知限制(跟其他 fixture 同一件事,SPECS-INDEX #638):這個專案的商家只能軟停用、不能真刪除,
//    所以 teardown 只能把測試商家停用。殘留的商家用 `E2E頁首版面測試商家` 開頭的名稱清楚標記,
//    納進 #638 的總清理量。
//
// 🔴 `.env` 的讀取**一律**走 e2e/support/env-file.ts(SPECS-INDEX #714 的規則:不要再手刻
//    第 14 份 `.env` 解析器)。
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { readRequiredEnvValue } from "./env-file";
import { getSupabaseAuthStorageKey } from "./supabase-storage-key";
import { disableFixtureMerchant } from "./merchant-teardown-helper";

export const APP_HEADER_MERCHANT_NAME_PREFIX = "E2E頁首版面測試商家";

// 比照 src/integrations/supabase/client.ts:新格式 publishable key(sb_publishable_...)不是合法的
// JWT,supabase-js 仍可能塞一個 `Authorization: Bearer <publishable key>` 標頭,要在真正送出的
// fetch 裡拿掉,否則伺服器會判斷成一組格式錯誤的 JWT。
// ⚠️ SPECS-INDEX #766 登記了「這組三連發在 e2e/support/ 底下有 13 份逐字複製」的技術債,本批**不動
//    那 13 份**(它們每一支都會對正式資料庫建立資料,「全部 e2e 跑一遍證明沒改壞」這個驗證方式
//    不可接受)。這裡刻意不再抄第 14 份到 spec 檔案裡,而是集中在這支 fixture 內。
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
  const url = readRequiredEnvValue("VITE_SUPABASE_URL", "頁首版面(app-header-320)這支 e2e 測試");
  const key = readRequiredEnvValue(
    "VITE_SUPABASE_PUBLISHABLE_KEY",
    "頁首版面(app-header-320)這支 e2e 測試",
  );
  return createClient(url, key, {
    global: { fetch: buildFetch(key) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface AppHeaderFixture {
  runId: string;
  email: string;
  session: Session;
  merchantId: string;
}

export async function setupAppHeaderFixture(): Promise<AppHeaderFixture> {
  const client = createFixtureSupabaseClient();
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `e2e-app-header-320-please-ignore-${runId}@example-header-test-domain.test`;
  const password = `E2eHeader!${runId}Aa`;

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
    p_name: `${APP_HEADER_MERCHANT_NAME_PREFIX}${runId}`,
    p_industry_type: "in_store_beauty",
    p_contact_email: email,
    p_intro: "e2e app-header-320 版面守門員用的測試商家,測試完會停用,不是真實商家。",
  });
  if (merchantError || !merchantId) {
    throw new Error(`建立測試商家失敗:${merchantError?.message ?? "沒有回傳 merchant id"}`);
  }

  return { runId, email, session, merchantId: merchantId as string };
}

/** 把 fixture 帳號的 session 塞進瀏覽器 localStorage,讓 /app/* 直接進得去。 */
export async function injectAppHeaderFixtureSession(
  page: Page,
  fixture: AppHeaderFixture,
): Promise<void> {
  const storageKey = getSupabaseAuthStorageKey();
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(fixture.session)] as [string, string],
  );
}

export async function teardownAppHeaderFixture(fixture: AppHeaderFixture): Promise<string[]> {
  const client = createFixtureSupabaseClient();
  const { error: sessionError } = await client.auth.setSession({
    access_token: fixture.session.access_token,
    refresh_token: fixture.session.refresh_token,
  });
  if (sessionError) {
    return [`警告:無法還原測試帳號 session,略過清理(${sessionError.message})`];
  }
  return [await disableFixtureMerchant(client, fixture.merchantId)];
}
