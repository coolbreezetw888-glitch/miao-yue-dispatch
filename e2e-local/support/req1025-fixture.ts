// SPECS-INDEX #1025 功能開關 第 1 批(FG1-T04)本機 e2e fixture。
// 規格書:.project/specs/功能開關.md(第 2 版)。只在 playwright.local.config.ts 底下用,只連本機 Docker 的 Supabase。
//
// 建立:
//   ・商家管理員帳號 + 一間到府派工商家(走 create_group_and_merchant ⇒ 開店時自動套產業預設,三個功能全開)
//   ・本機暫時超級管理員(platform_admins 沒有自助寫入 ⇒ service_role 建列,note 標記)
// teardown:service_role 硬刪除。刪前 SELECT 核對(商家名稱前綴、帳號 email 格式、超管列 note 都對得上才刪),
// 刪後再 SELECT 一次全部必須為 0。商家刪掉時,merchant_feature_grants / merchant_feature_grant_logs 會 cascade。
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

import { buildFetch } from "../../e2e/support/fixture-supabase-client";
import { readLocalSupabaseTarget } from "./local-target";

export const MERCHANT_NAME_PREFIX = "E2E功能開關1025本機";
const EMAIL_RE = /^e2e-1025(admin|platform)-\d+@example-local-test\.test$/;
const PLATFORM_ADMIN_NOTE = "E2E功能開關1025本機暫時超級管理員(teardown 硬刪除)";

export interface Req1025Fixture {
  runId: string;
  merchantId: string;
  merchantName: string;
  groupId: string;
  slug: string;
  admin: { userId: string; session: Session };
  platform: { userId: string; session: Session };
}

function makeClient(key: string): SupabaseClient {
  const { url } = readLocalSupabaseTarget();
  return createClient(url, key, {
    global: { fetch: buildFetch(key) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function serviceClient(): SupabaseClient {
  return makeClient(readLocalSupabaseTarget().serviceRoleKey);
}

function must<T>(label: string, data: T | null | undefined, error: { message: string } | null): T {
  if (error || data === null || data === undefined) {
    throw new Error(`${label}失敗:${error?.message ?? "沒有回傳資料"}`);
  }
  return data;
}

async function signUp(runId: string, role: "admin" | "platform") {
  const client = makeClient(readLocalSupabaseTarget().publishableKey);
  const email = `e2e-1025${role}-${runId}@example-local-test.test`;
  const r = await client.auth.signUp({ email, password: `E2e1025!${runId}Aa` });
  const session = must(`建立 ${role} 帳號`, r.data.session, r.error);
  return { client, email, session, userId: session.user.id };
}

export async function setupReq1025Fixture(): Promise<Req1025Fixture> {
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const svc = serviceClient();
  const admin = await signUp(runId, "admin");
  let groupId: string | null = null;
  let platformUserId: string | null = null;
  try {
    const merchantName = `${MERCHANT_NAME_PREFIX}${runId}`;
    const m = await admin.client.rpc("create_group_and_merchant", {
      p_name: merchantName,
      p_industry_type: "on_site_dispatch",
    });
    const merchantId = must("建立商家", m.data as string | null, m.error);
    const row = await svc
      .from("merchants")
      .select("group_id, booking_slug")
      .eq("id", merchantId)
      .single();
    const merchantRow = must("查詢商家", row.data, row.error) as {
      group_id: string;
      booking_slug: string;
    };
    groupId = merchantRow.group_id;

    const platform = await signUp(runId, "platform");
    platformUserId = platform.userId;
    const pa = await svc
      .from("platform_admins")
      .insert({ user_id: platform.userId, note: PLATFORM_ADMIN_NOTE });
    if (pa.error) throw new Error(`建立本機超級管理員失敗:${pa.error.message}`);

    return {
      runId,
      merchantId,
      merchantName,
      groupId,
      slug: merchantRow.booking_slug,
      admin: { userId: admin.userId, session: admin.session },
      platform: { userId: platform.userId, session: platform.session },
    };
  } catch (err) {
    // 建到一半失敗:只清這次建的東西。
    if (groupId) {
      await svc.from("merchants").delete().eq("group_id", groupId);
      await svc.from("groups").delete().eq("id", groupId);
    }
    if (platformUserId) {
      await svc.from("platform_admins").delete().eq("user_id", platformUserId);
      await svc.auth.admin.deleteUser(platformUserId);
    }
    await svc.auth.admin.deleteUser(admin.userId);
    throw err;
  }
}

/** 查這間店某個功能目前在資料庫的值(service_role 唯讀)。 */
export async function readGrant(
  fixture: Req1025Fixture,
  featureKey: string,
): Promise<boolean | null> {
  const r = await serviceClient()
    .from("merchant_feature_grants")
    .select("enabled")
    .eq("merchant_id", fixture.merchantId)
    .eq("feature_key", featureKey)
    .maybeSingle();
  if (r.error) throw new Error(`查功能開關失敗:${r.error.message}`);
  return (r.data as { enabled: boolean } | null)?.enabled ?? null;
}

export async function teardownReq1025Fixture(fixture: Req1025Fixture): Promise<string[]> {
  const svc = serviceClient();
  const actions: string[] = [];

  // ① 核對範圍
  const merchants = await svc.from("merchants").select("id,name").eq("group_id", fixture.groupId);
  if (merchants.error) throw new Error(`teardown 查商家失敗:${merchants.error.message}`);
  const rows = (merchants.data ?? []) as { id: string; name: string }[];
  if (
    rows.length !== 1 ||
    rows[0]!.id !== fixture.merchantId ||
    !rows[0]!.name.startsWith(MERCHANT_NAME_PREFIX)
  ) {
    throw new Error(`teardown 中止:集團底下的商家不是本 fixture 建立的(${JSON.stringify(rows)})`);
  }
  for (const uid of [fixture.admin.userId, fixture.platform.userId]) {
    const u = await svc.auth.admin.getUserById(uid);
    if (!EMAIL_RE.test(u.data.user?.email ?? "")) {
      throw new Error(`teardown 中止:${uid} 不是本 fixture 的帳號`);
    }
  }
  const pa = await svc
    .from("platform_admins")
    .select("id,note")
    .eq("user_id", fixture.platform.userId);
  if (pa.error) throw new Error(`teardown 查超級管理員列失敗:${pa.error.message}`);
  if ((pa.data ?? []).some((r) => (r as { note: string | null }).note !== PLATFORM_ADMIN_NOTE)) {
    throw new Error("teardown 中止:超級管理員列的 note 對不上");
  }
  const logs = await svc
    .from("merchant_feature_grant_logs")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", fixture.merchantId);
  actions.push(
    `核對通過:商家 1 間、帳號 2 個、超管列 ${pa.data?.length ?? 0} 列、功能開關紀錄 ${logs.count ?? "?"} 筆,都是本次 fixture 建立的`,
  );

  // ② 硬刪除(商家 cascade 帶走 merchant_feature_grants / merchant_feature_grant_logs)
  const paDel = await svc
    .from("platform_admins")
    .delete()
    .eq("user_id", fixture.platform.userId)
    .select("id");
  if (paDel.error) throw new Error(`teardown 刪超級管理員列失敗:${paDel.error.message}`);
  const mDel = await svc.from("merchants").delete().eq("id", fixture.merchantId).select("id");
  if (mDel.error) throw new Error(`teardown 刪商家失敗:${mDel.error.message}`);
  const gDel = await svc.from("groups").delete().eq("id", fixture.groupId).select("id");
  if (gDel.error) throw new Error(`teardown 刪集團失敗:${gDel.error.message}`);
  for (const uid of [fixture.admin.userId, fixture.platform.userId]) {
    const d = await svc.auth.admin.deleteUser(uid);
    if (d.error) throw new Error(`teardown 刪帳號失敗:${d.error.message}`);
  }
  actions.push(
    `已硬刪除超管列 ${paDel.data?.length ?? 0}、商家 ${mDel.data?.length ?? 0}、集團 ${gDel.data?.length ?? 0}、帳號 2`,
  );

  // ③ 刪後核對
  const count = async (table: string, column: string, value: string) => {
    const r = await svc
      .from(table)
      .select(column, { count: "exact", head: true })
      .eq(column, value);
    if (r.error) throw new Error(`teardown 核對 ${table} 失敗:${r.error.message}`);
    return r.count ?? 0;
  };
  const left =
    (await count("merchants", "id", fixture.merchantId)) +
    (await count("groups", "id", fixture.groupId)) +
    (await count("merchant_feature_grants", "merchant_id", fixture.merchantId)) +
    (await count("merchant_feature_grant_logs", "merchant_id", fixture.merchantId)) +
    (await count("platform_admins", "user_id", fixture.platform.userId));
  const usersLeft =
    ((await svc.auth.admin.getUserById(fixture.admin.userId)).data.user ? 1 : 0) +
    ((await svc.auth.admin.getUserById(fixture.platform.userId)).data.user ? 1 : 0);
  if (left + usersLeft !== 0) throw new Error(`teardown 後仍有殘留 ${left + usersLeft} 筆`);
  actions.push("刪後核對:商家 / 集團 / 功能開關 / 紀錄 / 超管列 / 帳號 全部 0");
  return actions;
}
