// SPECS-INDEX #765(規格書 .project/specs/測試覆蓋補強.md §三 #765):
// 「會建立客服(merchant_agent)」的 e2e fixture —— #764 客服權限設定頁
// (/app/agents/:agentId/permissions)瀏覽器測試的硬前提。
//
// **為什麼要新寫一支,不共用既有 fixture**(查證結果,不是推測):
//   `grep -rn -i "merchant_agents|invite-merchant-agent" e2e/` 在這支檔案出現之前**零命中**;
//   `e2e/support/line-notifications-fixture.ts` 只有檔頭 L9 一行註解提到 merchant_agents,
//   沒有任何建立客服的程式碼,它導出的介面也沒有 agentId。
//   ⇒ 在這支檔案出現之前,全 repo 沒有任何 e2e fixture 會建立客服。
//
// **建立客服的做法完全照抄既有正確先例** `e2e/support/staff-portal-v2-fixture.ts` L108-186:
// 先用 signUp() 把「未來要當客服」的那個帳號建好,再用商家管理員的 client 呼叫
// invite-merchant-agent Edge Function。因為帳號已經存在,Edge Function 會走
// 「既有帳號直接開通」分支(見 supabase/functions/invite-merchant-agent/index.ts 檔頭步驟 2
// 與 L146-151:lookup_user_id_by_email 查得到 ⇒ status='active'、already_had_account=true),
// **不會寄出任何邀請信**,也就不需要收信。invite-merchant-agent 跟 invite-merchant-staff
// 是同一個模式。
//
// 🔴 **這支 fixture 刻意先打開 2 項權限**(ORDERS / MEMBERS,見 GRANTED_SECTION_KEYS):
//    全新客服的 merchant_agent_permissions 是空的 ⇒ 畫面上 16 個開關**全部都是關的**,
//    這時候斷言「開關存在」等於什麼都沒驗(這個專案已經連續踩過兩次這種「空清單假通過」)。
//    有「開 / 關混合」的狀態,才驗得出「畫面真的在讀資料庫」,不是渲染一堆預設 false。
//    ⚠️ 改動這兩個 key 之前,先看 e2e/agent-permissions.spec.ts 的對應斷言。
//
// **已知限制(比照全 repo 既有 fixture,誠實記在這裡)**:
//   ① 這支 fixture 會產生 **2 個 auth.users 列**(商家管理員 + 客服),client 端的
//      publishable key 沒有硬刪除 auth.users 的權限,teardown 刪不掉。
//   ② teardown 是 **id-based**(remove_merchant_agent + disableFixtureMerchant),
//      **只在同一次 run 內有效**——測試被中斷、teardown 沒跑到的資料會變成孤兒,
//      需要有資料庫直接存取權限的人定期清理(SPECS-INDEX #638)。
//   ③ 商家只能軟停用(規則 2.2:分店只能停用不能真刪除),客服只能軟移除
//      (status='removed',規則 2.8)。
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { getSupabaseAuthStorageKey } from "./supabase-storage-key";
import { disableFixtureMerchant } from "./merchant-teardown-helper";
// 🔴 SPECS-INDEX #714:新 fixture 一律 import 共用的 .env 解析器,**不要再手刻第 14 份**
//    (既有 13 份區域 readEnvValue 的收斂本批刻意不做,理由見 env-file.ts 檔頭)。
import { readRequiredEnvValue } from "./env-file";

const FIXTURE_PURPOSE = "agent-permissions 這個 e2e 測試";

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
  const url = readRequiredEnvValue("VITE_SUPABASE_URL", FIXTURE_PURPOSE);
  const key = readRequiredEnvValue("VITE_SUPABASE_PUBLISHABLE_KEY", FIXTURE_PURPOSE);
  return createClient(url, key, {
    global: { fetch: buildFetch(key) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const AGENT_NAME_PREFIX = "E2E測試客服";

/** fixture 預先打開的 2 項權限(section_key)。挑這兩項的理由:它們是
 * src/modules/staff-agent/types.ts AGENT_PERMISSION_SECTIONS 裡**沒有** hidden 標記、
 * 名稱短且不會互相包含子字串的項目(「訂單管理」「會員管理」),斷言時好定位。
 * 對應的畫面 label 是「訂單管理」與「會員管理」。 */
export const GRANTED_SECTION_KEYS = ["orders", "members"] as const;

export interface AgentPermissionsFixture {
  runId: string;
  adminEmail: string;
  adminSession: Session;
  merchantId: string;
  merchantName: string;
  agentId: string;
  agentEmail: string;
  agentName: string;
  /** setup 當下真的成功寫進 merchant_agent_permissions 的 section_key(= GRANTED_SECTION_KEYS)。 */
  grantedSectionKeys: string[];
}

/** 建立這次測試需要的全部 fixture 資料。任何一步失敗就整個丟出例外,不留半套資料誤導判斷。 */
export async function setupAgentPermissionsFixture(): Promise<AgentPermissionsFixture> {
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const adminEmail = `e2e-agentperm-admin-please-ignore-${runId}@example-overflow-test-domain.test`;
  const agentEmail = `e2e-agentperm-agent-please-ignore-${runId}@example-overflow-test-domain.test`;
  const password = `E2eAgentPerm!${runId}Aa`;

  const adminClient = createFixtureSupabaseClient();
  const agentClient = createFixtureSupabaseClient();

  const { data: adminSignUp, error: adminSignUpErr } = await adminClient.auth.signUp({
    email: adminEmail,
    password,
  });
  if (adminSignUpErr || !adminSignUp.session) {
    throw new Error(`建立 e2e 管理員測試帳號失敗:${adminSignUpErr?.message ?? "沒有 session"}`);
  }

  // 🔴 **這一步的順序不能調換**:客服帳號必須在 invoke Edge Function **之前**就先建好,
  //    Edge Function 才會走「既有帳號直接開通」分支、不寄邀請信。
  const { data: agentSignUp, error: agentSignUpErr } = await agentClient.auth.signUp({
    email: agentEmail,
    password,
  });
  if (agentSignUpErr || !agentSignUp.user) {
    throw new Error(`建立 e2e 客服測試帳號失敗:${agentSignUpErr?.message ?? "沒有 user"}`);
  }

  const merchantName = `E2E客服權限測試商家${runId}`;
  const { data: merchantId, error: merchantError } = await adminClient.rpc(
    "create_group_and_merchant",
    {
      p_name: merchantName,
      p_industry_type: "in_store_beauty",
      p_contact_email: adminEmail,
      p_intro: "e2e-agent-permissions 自動化測試用商家,測試完會清除,不是真實商家。",
    },
  );
  if (merchantError || !merchantId) {
    throw new Error(`建立測試商家失敗:${merchantError?.message ?? "沒有回傳 merchant id"}`);
  }

  const agentName = `${AGENT_NAME_PREFIX}${runId}`;
  // invite-merchant-agent §8.2:phone 是必填,而且 Edge Function 內部會用
  // isValidTaiwanMobilePhone() 再驗一次(09 開頭共 10 碼),格式不合直接 400。
  const agentPhone = `09${runId.slice(-8)}`;

  const { data: inviteResult, error: inviteErr } = await adminClient.functions.invoke(
    "invite-merchant-agent",
    {
      body: {
        merchant_id: merchantId as string,
        email: agentEmail,
        name: agentName,
        phone: agentPhone,
      },
    },
  );
  if (inviteErr) {
    throw new Error(`邀請測試客服失敗:${inviteErr.message}`);
  }

  const invite = inviteResult as {
    agent_id?: string;
    status?: string;
    already_had_account?: boolean;
  };
  // 🔴 規格書 §三 #765 步驟 5:拿不到預期結果就直接 throw,**不要重試到成功為止**——
  //    重試只會在正式環境累積更多殘留帳號。如果這裡真的丟錯(代表上面的 signUp 沒建成功、
  //    Edge Function 走了寄信分支),要停手回報主腦,不要自己繞過。
  if (invite?.status !== "active" || invite?.already_had_account !== true) {
    throw new Error(
      `邀請結果非預期(應該是既有帳號直接開通 status=active / already_had_account=true):` +
        `${JSON.stringify(inviteResult)}`,
    );
  }
  if (!invite.agent_id) {
    throw new Error(`邀請成功但沒有回傳 agent_id:${JSON.stringify(inviteResult)}`);
  }
  const agentId = invite.agent_id;

  // 🔴 先打開 2 項權限,讓客服權限設定頁上有「開 / 關混合」的狀態(理由見檔頭說明)。
  for (const sectionKey of GRANTED_SECTION_KEYS) {
    const { error: permErr } = await adminClient.rpc("set_agent_permission", {
      p_agent_id: agentId,
      p_section_key: sectionKey,
      p_granted: true,
    });
    if (permErr) {
      throw new Error(`開通測試客服權限「${sectionKey}」失敗:${permErr.message}`);
    }
  }

  return {
    runId,
    adminEmail,
    adminSession: adminSignUp.session,
    merchantId: merchantId as string,
    merchantName,
    agentId,
    agentEmail,
    agentName,
    grantedSectionKeys: [...GRANTED_SECTION_KEYS],
  };
}

/** 把 fixture 的商家管理員 session 灌進瀏覽器 localStorage(客服權限設定頁走
 * RequireMerchantAdmin,要用管理員身分看,不是用客服自己的身分)。 */
export async function injectAgentPermissionsFixtureSession(
  page: Page,
  fixture: AgentPermissionsFixture,
): Promise<void> {
  const storageKey = getSupabaseAuthStorageKey();
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(fixture.adminSession)] as [string, string],
  );
}

/** 測試結束後盡量把 fixture 清乾淨(client 端 publishable key 只能做到軟停用/軟移除,
 * 見檔案開頭的已知限制)。回傳一組可讀的清理紀錄,比照全 repo 既有慣例。 */
export async function teardownAgentPermissionsFixture(
  fixture: AgentPermissionsFixture,
): Promise<string[]> {
  const client = createFixtureSupabaseClient();
  const { error: sessionError } = await client.auth.setSession({
    access_token: fixture.adminSession.access_token,
    refresh_token: fixture.adminSession.refresh_token,
  });
  if (sessionError) {
    return [`警告:無法還原管理員 session,略過軟清理(${sessionError.message})`];
  }

  const actions: string[] = [];

  // 規則 2.8/3.7:客服只能軟移除(status='removed'),走跟前端「移除客服」同一支 RPC。
  const { error: removeAgentError } = await client.rpc("remove_merchant_agent", {
    p_agent_id: fixture.agentId,
  });
  actions.push(
    removeAgentError
      ? `移除 fixture 客服失敗:${removeAgentError.message}`
      : "已移除 fixture 客服(軟刪除,status='removed')",
  );

  actions.push(await disableFixtureMerchant(client, fixture.merchantId));

  return actions;
}
