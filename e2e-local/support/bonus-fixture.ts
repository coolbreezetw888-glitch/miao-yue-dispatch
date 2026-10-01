// 紅利系統重構批次 8 的本機 e2e fixture(只在 playwright.local.config.ts 底下用)。
//
// 跟 e2e/support 的 fixture 最大不同:
//   ・網址 / 金鑰一律取自 readLocalSupabaseTarget()(本機 Docker),不讀 `.env`,而且會再檢查一次是本機。
//   ・本機才有 service_role 金鑰可用 ⇒ 兩件正式庫做不到的事改用它:
//       ① 建「只有會員管理鑰匙」的客服(正式流程要呼叫 Edge Function invite-merchant-agent,本機沒跑 Edge);
//       ② teardown 直接硬刪除(商家 cascade + auth 使用者),不留殘骸;以及測試裡查核餘額 / 訂單數字。
//   ・業務資料(商家、服務項目、會員、灌點、權限)仍走前端同一組 RPC / 表格,權限邊界照常生效。
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { buildFetch } from "../../e2e/support/fixture-supabase-client";
import { localAuthStorageKey, readLocalSupabaseTarget } from "./local-target";

export const SERVICE_ITEM_NAME = "E2E紅利測試服務項目";
export const SERVICE_ITEM_PRICE = 1000;
export const STAFF_NAME_PREFIX = "E2E紅利測試服務人員";
/** 會員甲:灌 300 點。 */
export const MEMBER_A_PHONE = "0966100001";
export const MEMBER_A_INITIAL = 300;
/** 會員乙:灌 500 點(「改電話立刻送出」要換成的另一位會員)。 */
export const MEMBER_B_PHONE = "0966100002";
export const MEMBER_B_INITIAL = 500;
/** 店裡沒有這支電話的會員 ⇒ 預覽應該是「新客戶」。 */
export const NEW_CUSTOMER_PHONE = "0966100099";
/** 基本模式:每滿 100 元 1 點(累計)⇒ 1000 元 = 10 點、2000 元 = 20 點。 */
export const BASIC_MIN_AMOUNT = 100;
/** 折抵:10 點 = 1 元,單次最多折應付金額 50%。 */
export const REDEEM_POINTS_UNIT = 10;
export const REDEEM_AMOUNT_UNIT = 1;
export const REDEEM_MAX_RATIO = 50;

export interface BonusFixture {
  runId: string;
  adminSession: Session;
  agentSession: Session;
  merchantId: string;
  groupId: string;
  staffIds: string[];
  staffNames: string[];
  serviceItemId: string;
  paymentMethodId: string;
  memberAId: string;
  memberAName: string;
  memberBId: string;
  memberBName: string;
  userIds: string[];
}

function makeClient(key: string): SupabaseClient {
  const { url } = readLocalSupabaseTarget();
  return createClient(url, key, {
    global: { fetch: buildFetch(key) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function anonClient(): SupabaseClient {
  return makeClient(readLocalSupabaseTarget().publishableKey);
}

/** service_role(只存在本機)。只給 fixture 建客服、查核數字、teardown 用。 */
export function serviceClient(): SupabaseClient {
  return makeClient(readLocalSupabaseTarget().serviceRoleKey);
}

/** 用某個 session 建一個「以該使用者身分」呼叫 RPC 的 client(權限照常生效)。 */
export async function clientAs(session: Session): Promise<SupabaseClient> {
  const client = anonClient();
  const { error } = await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (error) throw new Error(`還原 session 失敗:${error.message}`);
  return client;
}

function must<T>(label: string, data: T | null | undefined, error: { message: string } | null): T {
  if (error || data === null || data === undefined) {
    throw new Error(`${label}失敗:${error?.message ?? "沒有回傳資料"}`);
  }
  return data;
}

export async function setupBonusFixture(): Promise<BonusFixture> {
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const password = `E2eBonus!${runId}Aa`;
  const adminEmail = `e2e-bonus-admin-${runId}@example-local-test.test`;
  const agentEmail = `e2e-bonus-agent-${runId}@example-local-test.test`;

  const admin = anonClient();
  const adminSignUp = await admin.auth.signUp({ email: adminEmail, password });
  const adminSession = must("建立管理員帳號", adminSignUp.data.session, adminSignUp.error);

  const agentAuth = anonClient();
  const agentSignUp = await agentAuth.auth.signUp({ email: agentEmail, password });
  const agentSession = must("建立客服帳號", agentSignUp.data.session, agentSignUp.error);

  const merchantRes = await admin.rpc("create_group_and_merchant", {
    p_name: `E2E紅利本機測試商家${runId}`,
    p_industry_type: "in_store_beauty",
    p_contact_email: adminEmail,
    p_intro: "紅利系統重構批次 8 本機 e2e 測試商家。",
  });
  const merchantId = must("建立測試商家", merchantRes.data as string | null, merchantRes.error);

  const svc = serviceClient();
  const merchantRow = await svc.from("merchants").select("group_id").eq("id", merchantId).single();
  const groupId = must("查詢集團", merchantRow.data, merchantRow.error).group_id as string;

  const hours = Array.from({ length: 7 }, (_, d) => ({
    merchant_id: merchantId,
    day_of_week: d,
    is_closed: false,
    open_time: "00:00",
    close_time: "23:59",
  }));
  const hoursRes = await admin
    .from("merchant_business_hours")
    .upsert(hours, { onConflict: "merchant_id,day_of_week" });
  if (hoursRes.error) throw new Error(`營業時間失敗:${hoursRes.error.message}`);

  const itemRes = await admin
    .from("service_items")
    .insert({
      merchant_id: merchantId,
      name: SERVICE_ITEM_NAME,
      price: SERVICE_ITEM_PRICE,
      item_type: "primary",
      duration_minutes: 30,
    })
    .select("id")
    .single();
  const serviceItemId = must("建立服務項目", itemRes.data, itemRes.error).id as string;

  // 三位服務人員:每條「真的建單」的測試各用一位,避免表單預設的同一個時段撞到「這個時段已經有其他預約」。
  const staffNames = [1, 2, 3].map((n) => `${STAFF_NAME_PREFIX}${n}號${runId}`);
  const staffIds: string[] = [];
  for (const [index, name] of staffNames.entries()) {
    const digits = String((Number(runId.slice(-8)) + 10 + index) % 100_000_000).padStart(8, "0");
    const staffRes = await admin
      .from("merchant_staff")
      .insert({ merchant_id: merchantId, name, phone: `09${digits}`, no_time_slot_limit: true })
      .select("id")
      .single();
    staffIds.push(must(`建立服務人員 ${name}`, staffRes.data, staffRes.error).id as string);
  }

  const settingsRes = await admin.from("merchant_member_settings").upsert(
    {
      merchant_id: merchantId,
      points_feature_enabled: true,
      earn_mode: "basic",
      basic_points_per_order: 1,
      basic_min_amount: BASIC_MIN_AMOUNT,
      basic_tiered_enabled: true,
      redeem_points_unit: REDEEM_POINTS_UNIT,
      redeem_amount_unit: REDEEM_AMOUNT_UNIT,
      redeem_max_ratio_percent: REDEEM_MAX_RATIO,
      // 推薦開關 1(推薦者邀請累積紅利)開啟:member-points-settings.spec.ts §4.4 要看到兩個數字欄位。
      // 這支 fixture 沒有任何「被推薦」的會員,所以不會真的發推薦獎勵,不影響 bonus-refactor 的數字。
      referral_inviter_reward_enabled: true,
      referral_bonus_points: 20,
    },
    { onConflict: "merchant_id" },
  );
  if (settingsRes.error) throw new Error(`會員設定失敗:${settingsRes.error.message}`);

  async function createMember(name: string, phone: string, points: number): Promise<string> {
    const res = await admin.rpc("create_member", {
      p_merchant_id: merchantId,
      p_name: name,
      p_phone: phone,
    });
    const id = (must(`建立會員 ${name}`, res.data, res.error) as { id: string }).id;
    const adj = await admin.rpc("adjust_member_points", {
      p_member_id: id,
      p_points_delta: points,
      p_note: "e2e 本機灌點",
    });
    if (adj.error) throw new Error(`灌點失敗:${adj.error.message}`);
    return id;
  }
  const memberAName = `E2E紅利會員甲${runId}`;
  const memberBName = `E2E紅利會員乙${runId}`;
  const memberAId = await createMember(memberAName, MEMBER_A_PHONE, MEMBER_A_INITIAL);
  const memberBId = await createMember(memberBName, MEMBER_B_PHONE, MEMBER_B_INITIAL);

  const pmRes = await admin
    .from("payment_methods")
    .select("id")
    .eq("merchant_id", merchantId)
    .eq("status", "active")
    .limit(1)
    .single();
  const paymentMethodId = must("查付款方式", pmRes.data, pmRes.error).id as string;

  // 只有「會員管理」鑰匙的客服:本機沒有跑 Edge Function,直接用 service_role 建 active 客服列,
  // 權限則用管理員身分走正式的 set_agent_permission。
  const agentPhoneDigits = String((Number(runId.slice(-8)) + 1) % 100_000_000).padStart(8, "0");
  const agentRes = await svc
    .from("merchant_agents")
    .insert({
      merchant_id: merchantId,
      user_id: agentSignUp.data.user?.id,
      name: `E2E紅利客服${runId}`,
      phone: `09${agentPhoneDigits}`,
      invited_email: agentEmail,
      status: "active",
      activated_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  const agentId = must("建立客服", agentRes.data, agentRes.error).id as string;
  const permRes = await admin.rpc("set_agent_permission", {
    p_agent_id: agentId,
    p_section_key: "members",
    p_granted: true,
  });
  if (permRes.error) throw new Error(`開客服 members 權限失敗:${permRes.error.message}`);

  return {
    runId,
    adminSession,
    agentSession,
    merchantId,
    groupId,
    staffIds,
    staffNames,
    serviceItemId,
    paymentMethodId,
    memberAId,
    memberAName,
    memberBId,
    memberBName,
    userIds: [adminSignUp.data.user?.id, agentSignUp.data.user?.id].filter(
      (v): v is string => typeof v === "string",
    ),
  };
}

export async function injectSession(page: Page, session: Session): Promise<void> {
  const key = localAuthStorageKey(readLocalSupabaseTarget().url);
  await page.addInitScript(
    ([k, v]) => {
      window.localStorage.setItem(k, v);
    },
    [key, JSON.stringify(session)] as [string, string],
  );
}

export async function getBalance(memberId: string): Promise<number> {
  const res = await serviceClient()
    .from("members")
    .select("points_balance")
    .eq("id", memberId)
    .single();
  return Number(must("查會員餘額", res.data, res.error).points_balance);
}

export interface BookingPointsRow {
  id: string;
  status: string;
  member_id: string | null;
  points_planned: number | null;
  points_redeemed: number | null;
  points_redeem_amount_snapshot: number | null;
  customer_phone: string;
}

export async function listBookings(merchantId: string): Promise<BookingPointsRow[]> {
  const res = await serviceClient()
    .from("bookings")
    .select(
      "id,status,member_id,points_planned,points_redeemed,points_redeem_amount_snapshot,customer_phone,created_at",
    )
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: true });
  if (res.error) throw new Error(`查訂單失敗:${res.error.message}`);
  return (res.data ?? []) as BookingPointsRow[];
}

export async function setPointsFeature(fixture: BonusFixture, enabled: boolean): Promise<void> {
  const admin = await clientAs(fixture.adminSession);
  const res = await admin
    .from("merchant_member_settings")
    .update({ points_feature_enabled: enabled })
    .eq("merchant_id", fixture.merchantId)
    .select("merchant_id");
  if (res.error || (res.data ?? []).length !== 1) {
    throw new Error(`切換紅利功能失敗:${res.error?.message ?? "沒有更新到任何一列"}`);
  }
}

export const MERCHANT_NAME_PREFIX = "E2E紅利本機測試商家";
const EMAIL_PATTERN = /^e2e-bonus-(admin|agent)-\d+@example-local-test\.test$/;

/** 硬刪除本次建立的一切(本機才做得到,一律 service_role):
 *  ① 先 SELECT 核對範圍:集團底下的商家名稱必須全部是本 fixture 的前綴、使用者 email 必須是本 fixture 的格式,
 *     任何一筆對不上就**整個不刪**(回報出來,不冒險);
 *  ② 依外鍵順序硬刪除:抽成快照 → 訂單 → 會員 → 商家(其餘子表 cascade)→ 集團 → auth 使用者;
 *  ③ 刪完再 SELECT 一次,商家 / 集團 / 訂單 / 會員 / 使用者都必須是 0,否則丟錯讓測試結果顯示出來。 */
export async function teardownBonusFixture(fixture: BonusFixture): Promise<string[]> {
  const svc = serviceClient();
  const actions: string[] = [];

  // ① 核對範圍
  const merchants = await svc.from("merchants").select("id,name").eq("group_id", fixture.groupId);
  if (merchants.error) throw new Error(`teardown 查商家失敗:${merchants.error.message}`);
  const merchantRows = (merchants.data ?? []) as { id: string; name: string }[];
  const foreign = merchantRows.filter((m) => !m.name.startsWith(MERCHANT_NAME_PREFIX));
  if (foreign.length > 0 || !merchantRows.some((m) => m.id === fixture.merchantId)) {
    throw new Error(
      `teardown 中止:集團底下有不是本 fixture 建立的商家(${foreign.map((m) => m.name).join("、")}),不刪任何東西`,
    );
  }
  const users: { id: string; email: string }[] = [];
  for (const id of fixture.userIds) {
    const u = await svc.auth.admin.getUserById(id);
    const email = u.data.user?.email ?? "";
    if (u.error || !EMAIL_PATTERN.test(email)) {
      throw new Error(
        `teardown 中止:使用者 ${id.slice(0, 8)} 不是本 fixture 建立的帳號(${email}),不刪任何東西`,
      );
    }
    users.push({ id, email });
  }
  const merchantIds = merchantRows.map((m) => m.id);
  actions.push(
    `核對通過:商家 ${merchantIds.length} 間、帳號 ${users.length} 個,都是本次 fixture 建立的`,
  );

  // ② 依外鍵順序硬刪除。
  //   booking_commission_item_records → booking_service_items 沒有 cascade ⇒ 先刪抽成快照;
  //   booking_service_items → service_items 沒有 cascade ⇒ 再刪訂單,最後才刪商家。
  const steps: [
    string,
    () => PromiseLike<{ error: { message: string } | null; data: unknown[] | null }>,
  ][] = [
    [
      "抽成快照",
      () =>
        svc.from("booking_commission_records").delete().in("merchant_id", merchantIds).select("id"),
    ],
    ["訂單", () => svc.from("bookings").delete().in("merchant_id", merchantIds).select("id")],
    ["會員", () => svc.from("members").delete().in("merchant_id", merchantIds).select("id")],
    ["商家", () => svc.from("merchants").delete().in("id", merchantIds).select("id")],
    ["集團", () => svc.from("groups").delete().eq("id", fixture.groupId).select("id")],
  ];
  for (const [label, run] of steps) {
    const r = await run();
    if (r.error) throw new Error(`teardown 刪${label}失敗:${r.error.message}`);
    actions.push(`已硬刪除${label} ${r.data?.length ?? 0} 筆`);
  }
  for (const u of users) {
    const r = await svc.auth.admin.deleteUser(u.id);
    if (r.error) throw new Error(`teardown 刪帳號失敗:${r.error.message}`);
  }
  actions.push(`已硬刪除 auth 帳號 ${users.length} 個`);

  // ③ 刪完再核對一次:這次建立的東西全部歸 0。
  const count = async (table: string, column: string, values: string[]) => {
    const r = await svc.from(table).select("id", { count: "exact", head: true }).in(column, values);
    if (r.error) throw new Error(`teardown 核對 ${table} 失敗:${r.error.message}`);
    return r.count ?? 0;
  };
  const left = {
    merchants: await count("merchants", "id", merchantIds),
    groups: await count("groups", "id", [fixture.groupId]),
    bookings: await count("bookings", "merchant_id", merchantIds),
    members: await count("members", "merchant_id", merchantIds),
  };
  let usersLeft = 0;
  for (const u of users) {
    const r = await svc.auth.admin.getUserById(u.id);
    if (r.data.user) usersLeft += 1;
  }
  const total = left.merchants + left.groups + left.bookings + left.members + usersLeft;
  if (total !== 0) {
    throw new Error(`teardown 後仍有殘留:${JSON.stringify({ ...left, users: usersLeft })}`);
  }
  actions.push("刪後核對:商家 / 集團 / 訂單 / 會員 / 帳號 全部 0");
  return actions;
}
