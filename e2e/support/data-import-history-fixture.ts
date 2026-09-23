// 模組 12 品管打回重做(2026-09-21)要求補上的 Playwright 測試共用 fixture——
// e2e/data-import-history.spec.ts 用的真實測試資料(§4.2 匯入紀錄頁 + 一鍵復原)。
//
// 做法比照 e2e/support/data-import-members-fixture.ts。這支測試需要 3 筆會員 CSV 資料
// (2 筆成功、1 筆刻意缺電話失敗)，複製一份獨立的商家，避免跟 data-import-members.spec.ts
// 的 fixture 資料互相干擾(兩支測試檔案 fullyParallel 平行執行)。
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

export function createFixtureSupabaseClient(): SupabaseClient {
  const url = readEnvValue("VITE_SUPABASE_URL");
  const key = readEnvValue("VITE_SUPABASE_PUBLISHABLE_KEY");
  return createClient(url, key, {
    global: { fetch: buildFetch(key) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface DataImportHistoryFixture {
  runId: string;
  email: string;
  session: Session;
  merchantId: string;
  validMemberName1: string;
  validMemberName2: string;
  invalidMemberName: string;
  /** 缺口 1(2026-09-21 品管第二輪複驗):情境②——第二批匯入,其中一位匯入後被手動編輯過,
   * 復原時應該被正確跳過,另一位維持乾淨可以正常復原(刪除)。 */
  editedAfterImportMemberName: string;
  editedAfterImportMemberPhone: string;
  cleanSecondBatchMemberName: string;
  cleanSecondBatchMemberPhone: string;
}

export async function setupDataImportHistoryFixture(): Promise<DataImportHistoryFixture> {
  const client = createFixtureSupabaseClient();
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `e2e-data12-history-please-ignore-${runId}@example-overflow-test-domain.test`;
  const password = `E2eData12H2!${runId}Aa`;

  const { data: signUpData, error: signUpError } = await client.auth.signUp({ email, password });
  if (signUpError) throw new Error(`建立 e2e 測試帳號失敗(signUp):${signUpError.message}`);
  const session = signUpData.session;
  if (!session) {
    throw new Error("建立 e2e 測試帳號後拿不到可用的 session,請確認 Authentication 設定。");
  }

  const merchantName = `E2E資料匯入紀錄復原測試商家${runId}`;
  const { data: merchantId, error: merchantError } = await client.rpc("create_group_and_merchant", {
    p_name: merchantName,
    p_industry_type: "in_store_beauty",
    p_contact_email: email,
    p_intro: "e2e-data-import-history 自動化測試用商家,測試完會清除,不是真實商家。",
  });
  if (merchantError || !merchantId) {
    throw new Error(`建立測試商家失敗:${merchantError?.message ?? "沒有回傳 merchant id"}`);
  }

  return {
    runId,
    email,
    session,
    merchantId: merchantId as string,
    validMemberName1: `E2E會員一${runId}`,
    validMemberName2: `E2E會員二${runId}`,
    invalidMemberName: `E2E會員三缺電話${runId}`,
    editedAfterImportMemberName: `E2E會員四待編輯${runId}`,
    editedAfterImportMemberPhone: "0955333003",
    cleanSecondBatchMemberName: `E2E會員五維持乾淨${runId}`,
    cleanSecondBatchMemberPhone: "0955333004",
  };
}

export async function injectDataImportHistoryFixtureSession(
  page: Page,
  fixture: DataImportHistoryFixture,
): Promise<void> {
  const storageKey = getSupabaseAuthStorageKey();
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(fixture.session)] as [string, string],
  );
}

export async function teardownDataImportHistoryFixture(
  fixture: DataImportHistoryFixture,
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
    .eq("merchant_id", fixture.merchantId);
  actions.push(
    memberError
      ? `下架 fixture 會員失敗:${memberError.message}`
      : "已下架 fixture 商家底下剩餘會員(軟刪除，如果復原有成功執行，這裡預期已經沒有資料列)",
  );

  actions.push(await disableFixtureMerchant(client, fixture.merchantId));

  return actions;
}
