// 客戶端第 2 批(C2)本機 e2e fixture:LINE 登入、⑥ 系列畫面、後台 LINE 登入設定卡、會員詳細頁登入狀態。
// 規格書:.project/specs/客戶端第2批-LINE登入與訪客預約.md(🔴 零之二優先)。
// 只在 playwright.local.config.ts 底下用,只連本機 Docker 的 Supabase。
//
// 沿用第 1 批的 fixture(setupC1Fixture:A 到府、B 到店、C 停用),再加上:
//   ・A 設定並啟用 LINE 登入(Channel Secret 是哨兵字串,C2-F01 用);會員政策打開。
//   ・B 不設定 LINE 登入(⑤ 維持第 1 批停用按鈕)。
//   ・客服 G(只有「會員管理」權限,看不到 LINE 串接設定頁)、本機暫時超級管理員 P。
//
// LINE 登入怎麼「模擬」(規格書 T 區 e2e-local 那一列):
//   ・瀏覽器打 /functions/v1/customer-line-login 一律被 page.route 攔下,不真的跑 Edge Function。
//   ・start ⇒ 回 authorize_url = 本站 /auth/line/callback?code=MOCK&state=<測試值>(= LINE 立刻同意並導回)。
//   ・complete ⇒ 這裡用**本機** service role 真的去本機 GoTrue 建「客戶帳號」(app_metadata.account_type=customer)、
//     寫 customer_line_identities、generateLink 拿真的 token_hash ⇒ 前端 verifyOtp 拿到**真的本機登入狀態**,
//     之後 customer_complete_profile、get_customer_session_state、後台會員頁全部打真的本機資料庫。
//
// teardown:先刪 LINE 登入設定(連 Vault secret 一起)、客服、超級管理員列,再走第 1 批 teardown,
// 最後刪客戶帳號(email 一律本 fixture 格式,對不上就不刪);刪前 SELECT 核對、刪後再 SELECT 一次。
import { randomBytes, randomUUID } from "node:crypto";

import type { Page, Route } from "@playwright/test";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

import {
  serviceClient,
  setupC1Fixture,
  teardownC1Fixture,
  type C1Fixture,
} from "./c1-public-booking-fixture";
import { readLocalSupabaseTarget } from "./local-target";
import { buildFetch } from "../../e2e/support/fixture-supabase-client";
import { createClient } from "@supabase/supabase-js";

export const CHANNEL_ID_A = "1650000001";
/** C2-F01 哨兵:32 碼英數(格式合法),任何回應原文 / 畫面都不能出現。 */
export const SECRET_SENTINEL = "SENTINELSECRET0123456789abcdef01";
export const MEMBER_POLICY_A = "會員點數一年內有效，請準時赴約。";
const CUSTOMER_EMAIL_RE = /^e2e-c2line-\d+-\d+@customer\.miaoyue\.invalid$/;
const STAFF_EMAIL_RE = /^e2e-c2(agent|platform)-\d+@example-local-test\.test$/;
const PLATFORM_ADMIN_NOTE = "E2E客戶端C2本機暫時超級管理員(teardown 硬刪除)";

export interface C2Fixture {
  c1: C1Fixture;
  runId: string;
  agent: { agentId: string; userId: string; session: Session };
  platform: { userId: string; session: Session };
  customerUserIds: string[];
}

function must<T>(label: string, data: T | null | undefined, error: { message: string } | null): T {
  if (error || data === null || data === undefined) {
    throw new Error(`${label}失敗:${error?.message ?? "沒有回傳資料"}`);
  }
  return data;
}

function anon(): SupabaseClient {
  const { url, publishableKey } = readLocalSupabaseTarget();
  return createClient(url, publishableKey, {
    global: { fetch: buildFetch(publishableKey) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function signUp(runId: string, role: "agent" | "platform") {
  const email = `e2e-c2${role}-${runId}@example-local-test.test`;
  const r = await anon().auth.signUp({ email, password: `E2eC2Line!${runId}Aa` });
  const session = must(`建立 ${role} 帳號`, r.data.session, r.error);
  return { email, session, userId: session.user.id };
}

export async function setupC2Fixture(): Promise<C2Fixture> {
  const c1 = await setupC1Fixture();
  const svc = serviceClient();
  const runId = c1.runId;
  try {
    // A:LINE 登入(管理員自己設定,走前端同一支函式)+ 啟用 + 會員政策。
    const set = await c1.admin.rpc("set_merchant_line_login_config", {
      p_merchant_id: c1.merchantAId,
      p_channel_id: CHANNEL_ID_A,
      p_channel_secret: SECRET_SENTINEL,
    });
    if (set.error) throw new Error(`設定 LINE 登入失敗:${set.error.message}`);
    const en = await c1.admin.rpc("set_merchant_line_login_enabled", {
      p_merchant_id: c1.merchantAId,
      p_enabled: true,
    });
    if (en.error) throw new Error(`啟用 LINE 登入失敗:${en.error.message}`);
    const pol = await svc
      .from("merchant_member_settings")
      .update({ policy_enabled: true, policy_content: MEMBER_POLICY_A })
      .eq("merchant_id", c1.merchantAId)
      .select("merchant_id");
    if (pol.error || (pol.data ?? []).length !== 1) {
      throw new Error(`開會員政策失敗:${pol.error?.message ?? "沒有會員設定列"}`);
    }

    // 客服 G:只有「會員管理」。
    const agentUser = await signUp(runId, "agent");
    const ag = await svc
      .from("merchant_agents")
      .insert({
        merchant_id: c1.merchantAId,
        user_id: agentUser.userId,
        name: `E2E客戶端C2客服${runId}`,
        phone: `09${runId.slice(-8)}`,
        invited_email: agentUser.email,
        status: "active",
        activated_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    const agentId = must("建立客服", ag.data, ag.error).id as string;
    const perm = await c1.admin.rpc("set_agent_permission", {
      p_agent_id: agentId,
      p_section_key: "members",
      p_granted: true,
    });
    if (perm.error) throw new Error(`開客服會員權限失敗:${perm.error.message}`);

    // 本機暫時超級管理員。
    const platformUser = await signUp(runId, "platform");
    const pa = await svc
      .from("platform_admins")
      .insert({ user_id: platformUser.userId, note: PLATFORM_ADMIN_NOTE });
    if (pa.error) throw new Error(`建立本機超級管理員失敗:${pa.error.message}`);

    return {
      c1,
      runId,
      agent: { agentId, userId: agentUser.userId, session: agentUser.session },
      platform: { userId: platformUser.userId, session: platformUser.session },
      customerUserIds: [],
    };
  } catch (err) {
    await teardownC1Fixture(c1).catch((e) => console.error("[c2 fixture] 清理半成品失敗:", e));
    throw err;
  }
}

// =========================================================================
// 模擬 LINE 登入(攔截 customer-line-login)
// =========================================================================

export interface MockLineLoginOptions {
  /** complete 時的結果:ok = 登入成功;cancelled = 客人在 LINE 按取消。 */
  outcome?: "ok" | "cancelled" | "line_error";
  /** 這位 LINE 使用者(同一個 sub 第二次登入 ⇒ 同一個客戶帳號)。 */
  sub: string;
  displayName: string;
}

export interface MockLineLogin {
  /** 前端 start 送出的原始 body(驗 draft 用)。 */
  startBodies: Record<string, unknown>[];
  /** Edge Function 回應原文(C2-F01 搜哨兵用)。 */
  responseBodies: string[];
  /** 這次建立 / 沿用的客戶帳號。 */
  userIds: string[];
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** 找或建「客戶帳號」:同一個 channel + sub 只會有一個。 */
async function findOrCreateCustomer(
  fixture: C2Fixture,
  sub: string,
  displayName: string,
): Promise<{ userId: string; email: string }> {
  const svc = serviceClient();
  const found = await svc
    .from("customer_line_identities")
    .select("user_id")
    .eq("line_channel_id", CHANNEL_ID_A)
    .eq("line_sub", sub)
    .maybeSingle();
  if (found.error) throw new Error(`查客戶身分失敗:${found.error.message}`);
  const now = new Date().toISOString();
  if (found.data) {
    const userId = found.data.user_id as string;
    const u = await svc.auth.admin.getUserById(userId);
    const upd = await svc
      .from("customer_line_identities")
      .update({ display_name: displayName, last_login_at: now })
      .eq("user_id", userId);
    if (upd.error) throw new Error(`更新客戶身分失敗:${upd.error.message}`);
    return { userId, email: must("取客戶 email", u.data.user?.email, u.error) };
  }
  const email = `e2e-c2line-${fixture.runId}-${fixture.customerUserIds.length + 1}@customer.miaoyue.invalid`;
  const created = await svc.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: { account_type: "customer" },
  });
  const userId = must("建客戶帳號", created.data.user?.id, created.error);
  fixture.customerUserIds.push(userId);
  const ins = await svc.from("customer_line_identities").insert({
    user_id: userId,
    line_channel_id: CHANNEL_ID_A,
    line_sub: sub,
    display_name: displayName,
    picture_url: null,
    first_login_at: now,
    last_login_at: now,
  });
  if (ins.error) throw new Error(`寫客戶身分失敗:${ins.error.message}`);
  return { userId, email };
}

export async function mockLineLogin(
  page: Page,
  fixture: C2Fixture,
  options: MockLineLoginOptions,
): Promise<MockLineLogin> {
  const record: MockLineLogin = { startBodies: [], responseBodies: [], userIds: [] };
  const states = new Map<string, Record<string, unknown>>();
  const svc = serviceClient();

  async function reply(route: Route, body: Record<string, unknown>) {
    const text = JSON.stringify(body);
    record.responseBodies.push(text);
    await route.fulfill({
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: text,
    });
  }

  await page.route("**/functions/v1/customer-line-login", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    if (body["action"] === "start") {
      record.startBodies.push(body);
      const state = randomBytes(24).toString("base64url");
      states.set(state, (body["draft"] ?? null) as Record<string, unknown>);
      const origin = new URL(page.url()).origin;
      await reply(route, {
        status: "ok",
        authorize_url: `${origin}/auth/line/callback?code=MOCK&state=${state}`,
      });
      return;
    }
    if (body["action"] === "complete") {
      const state = String(body["state"] ?? "");
      if (!states.has(state)) {
        await reply(route, { status: "login_expired" });
        return;
      }
      const draft = states.get(state) ?? null;
      states.delete(state); // 單次有效
      if (options.outcome === "cancelled" || options.outcome === "line_error") {
        await reply(route, { status: options.outcome, slug: fixture.c1.slugA, draft });
        return;
      }
      const { userId, email } = await findOrCreateCustomer(
        fixture,
        options.sub,
        options.displayName,
      );
      record.userIds.push(userId);
      const link = await svc.auth.admin.generateLink({ type: "magiclink", email });
      const tokenHash = must("generateLink", link.data.properties?.hashed_token, link.error);
      await reply(route, {
        status: "ok",
        slug: fixture.c1.slugA,
        draft,
        token_hash: tokenHash,
        verify_type: "email",
      });
      return;
    }
    await reply(route, { status: "invalid_request" });
  });
  return record;
}

/**
 * C2-H01 用:直接在 Node 端做出一份「客人帳號」的真的本機登入狀態(generateLink → verifyOtp)。
 * 拿來塞進**後台** client 的儲存位置,模擬「後台 client 萬一拿到客人帳號」。
 */
export async function createCustomerSession(
  fixture: C2Fixture,
  sub: string,
  displayName: string,
): Promise<Session> {
  const { email } = await findOrCreateCustomer(fixture, sub, displayName);
  const link = await serviceClient().auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = must("generateLink", link.data.properties?.hashed_token, link.error);
  const verified = await anon().auth.verifyOtp({ token_hash: tokenHash, type: "email" });
  return must("換客人登入狀態", verified.data.session, verified.error);
}

/** 測試用的 LINE sub(每次不一樣,避免撞到上一次的客戶帳號)。 */
export function newLineSub(): string {
  return `U${randomUUID().replace(/-/g, "")}`;
}

/** 本機建一位會員(以管理員身分,走前端同一支 create_member)。 */
export async function createMemberA(
  fixture: C2Fixture,
  name: string,
  phone: string,
): Promise<string> {
  const res = await fixture.c1.admin.rpc("create_member", {
    p_merchant_id: fixture.c1.merchantAId,
    p_name: name,
    p_phone: phone,
  });
  return (must(`建立會員 ${name}`, res.data, res.error) as { id: string }).id;
}

/** 測試用電話:09 + 8 碼,依 runId 與序號錯開。 */
export function testPhone(fixture: C2Fixture, n: number): string {
  return `09${String((Number(fixture.runId.slice(-6)) * 100 + n) % 100_000_000).padStart(8, "0")}`;
}

export async function teardownC2Fixture(fixture: C2Fixture): Promise<string[]> {
  const svc = serviceClient();
  const actions: string[] = [];
  const { c1 } = fixture;

  // ① LINE 登入設定(連 Vault secret)— 用管理員走前端同一支刪除函式。
  const del = await c1.admin.rpc("delete_merchant_line_login_config", {
    p_merchant_id: c1.merchantAId,
  });
  if (del.error) throw new Error(`teardown 刪 LINE 登入設定失敗:${del.error.message}`);
  actions.push("已刪除 A 的 LINE 登入設定(含 Vault secret)");

  // ② 客服 / 超級管理員列(核對 email 格式後才刪)。
  for (const uid of [fixture.agent.userId, fixture.platform.userId]) {
    const u = await svc.auth.admin.getUserById(uid);
    if (!STAFF_EMAIL_RE.test(u.data.user?.email ?? "")) {
      throw new Error(`teardown 中止:${uid} 不是本 fixture 的帳號`);
    }
  }
  const pa = await svc
    .from("platform_admins")
    .select("id,note")
    .eq("user_id", fixture.platform.userId);
  if ((pa.data ?? []).some((r) => r.note !== PLATFORM_ADMIN_NOTE)) {
    throw new Error("teardown 中止:超級管理員列的 note 對不上");
  }
  const paDel = await svc
    .from("platform_admins")
    .delete()
    .eq("user_id", fixture.platform.userId)
    .select("id");
  if (paDel.error) throw new Error(`teardown 刪超級管理員列失敗:${paDel.error.message}`);
  const perms = await svc
    .from("merchant_agent_permissions")
    .delete()
    .eq("agent_id", fixture.agent.agentId)
    .select("agent_id");
  if (perms.error) throw new Error(`teardown 刪客服權限失敗:${perms.error.message}`);
  const agDel = await svc
    .from("merchant_agents")
    .delete()
    .eq("id", fixture.agent.agentId)
    .select("id");
  if (agDel.error) throw new Error(`teardown 刪客服失敗:${agDel.error.message}`);
  actions.push(
    `已刪除客服 ${agDel.data?.length ?? 0} 位、超級管理員列 ${paDel.data?.length ?? 0} 列`,
  );

  // ③ 第 1 批的 teardown(商家 / 會員 / 集團 / 管理員帳號)。
  actions.push(...(await teardownC1Fixture(c1)));

  // ④ 客戶帳號 + 客服 / 超管帳號(email 格式核對後才刪)。
  for (const uid of fixture.customerUserIds) {
    const u = await svc.auth.admin.getUserById(uid);
    if (!CUSTOMER_EMAIL_RE.test(u.data.user?.email ?? "")) {
      throw new Error(`teardown 中止:客戶帳號 ${uid} 不是本 fixture 建立的`);
    }
  }
  const allUsers = [...fixture.customerUserIds, fixture.agent.userId, fixture.platform.userId];
  for (const uid of allUsers) {
    const r = await svc.auth.admin.deleteUser(uid);
    if (r.error) throw new Error(`teardown 刪帳號失敗:${r.error.message}`);
  }
  let left = 0;
  for (const uid of allUsers) {
    if ((await svc.auth.admin.getUserById(uid)).data.user) left += 1;
  }
  const ident = await svc
    .from("customer_line_identities")
    .select("user_id", { count: "exact", head: true })
    .in("user_id", fixture.customerUserIds.length ? fixture.customerUserIds : [randomUUID()]);
  const cfg = await svc
    .from("merchant_line_login_configs")
    .select("merchant_id", { count: "exact", head: true })
    .eq("merchant_id", c1.merchantAId);
  left += (ident.count ?? 0) + (cfg.count ?? 0);
  if (left !== 0) throw new Error(`teardown 後仍有殘留 ${left} 筆`);
  actions.push(
    `已刪除客戶帳號 ${fixture.customerUserIds.length} 個、客服 / 超管帳號 2 個;刪後核對帳號 / 客戶身分 / LINE 登入設定全部 0`,
  );
  return actions;
}
