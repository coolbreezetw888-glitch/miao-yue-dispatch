// 模組 12 品管打回重做(2026-09-21)要求補上的 Playwright 測試共用 fixture——
// e2e/data-import-historical-bookings.spec.ts 用的真實測試資料(§3.3/§4.1 歷史訂單匯入，
// 含步驟三數值對應:一個既有服務人員 + 一個當場建立的新服務人員)。
//
// 做法比照 e2e/support/data-import-members-fixture.ts。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { getSupabaseAuthStorageKey } from "./supabase-storage-key";

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

export interface DataImportHistoricalFixture {
  runId: string;
  email: string;
  session: Session;
  merchantId: string;
  existingStaffId: string;
  existingStaffName: string;
  newStaffName: string; // 在數值對應步驟當場按「建立新服務人員」建立
}

export async function setupDataImportHistoricalFixture(): Promise<DataImportHistoricalFixture> {
  const client = createFixtureSupabaseClient();
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `e2e-data12-hist-please-ignore-${runId}@example-overflow-test-domain.test`;
  const password = `E2eData12H!${runId}Aa`;

  const { data: signUpData, error: signUpError } = await client.auth.signUp({ email, password });
  if (signUpError) throw new Error(`建立 e2e 測試帳號失敗(signUp):${signUpError.message}`);
  const session = signUpData.session;
  if (!session) {
    throw new Error("建立 e2e 測試帳號後拿不到可用的 session,請確認 Authentication 設定。");
  }

  const merchantName = `E2E資料匯入歷史訂單測試商家${runId}`;
  const { data: merchantId, error: merchantError } = await client.rpc("create_group_and_merchant", {
    p_name: merchantName,
    p_industry_type: "in_store_beauty",
    p_contact_email: email,
    p_intro: "e2e-data-import-historical 自動化測試用商家,測試完會清除,不是真實商家。",
  });
  if (merchantError || !merchantId) {
    throw new Error(`建立測試商家失敗:${merchantError?.message ?? "沒有回傳 merchant id"}`);
  }

  // 注意(非本次任務範圍,順手修正):SPECS-INDEX #595/#596(人員與權限管理模組,
  // 20260922140000_req595_596_staff_agent_phone_not_null_check.sql)在同一個正式 Supabase
  // 專案上把 merchant_staff.phone 改成 NOT NULL + 台灣手機號碼格式檢查(^09\d{8}$),這支
  // fixture 原本沒有帶 phone,會被這個新約束擋下,不是這次 #600/#602/#603 任務造成的迴歸——
  // 補一個依 runId 產生、符合格式的佔位電話,讓既有的歷史訂單匯入 e2e 測試恢復可執行。
  const existingStaffName = `E2E既有服務人員${runId}`;
  const existingStaffPhone = `09${runId.slice(-8).padStart(8, "0")}`;
  const { data: staff, error: staffError } = await client
    .from("merchant_staff")
    .insert({
      merchant_id: merchantId as string,
      name: existingStaffName,
      phone: existingStaffPhone,
      no_time_slot_limit: true,
    })
    .select("id")
    .single();
  if (staffError || !staff) {
    throw new Error(`建立測試既有服務人員失敗:${staffError?.message}`);
  }

  return {
    runId,
    email,
    session,
    merchantId: merchantId as string,
    existingStaffId: (staff as { id: string }).id,
    existingStaffName,
    newStaffName: `E2E新服務人員小美${runId}`,
  };
}

export async function injectDataImportHistoricalFixtureSession(
  page: Page,
  fixture: DataImportHistoricalFixture,
): Promise<void> {
  const storageKey = getSupabaseAuthStorageKey();
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(fixture.session)] as [string, string],
  );
}

export async function teardownDataImportHistoricalFixture(
  fixture: DataImportHistoricalFixture,
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

  const { error: staffError } = await client
    .from("merchant_staff")
    .update({ status: "removed" })
    .eq("merchant_id", fixture.merchantId);
  actions.push(
    staffError
      ? `移除 fixture 服務人員失敗:${staffError.message}`
      : "已移除 fixture 全部服務人員(軟刪除，含測試中建立的新服務人員)",
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
