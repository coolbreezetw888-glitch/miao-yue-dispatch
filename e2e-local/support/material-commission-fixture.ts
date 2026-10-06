// 「料錢影響服務人員抽成開關 第 8 批」(#985)的本機 e2e fixture。
// 規格書:.project/specs/料錢是否影響抽成開關-第8批.md 第八節 e2e-local。
// 只在 playwright.local.config.ts 底下用(`npm run test:e2e:local`),只連本機 Docker 的 Supabase。
//
// 寫法比照 e2e-local/support/permission-batch3-fixture.ts:
//   ・網址 / 金鑰一律取自 readLocalSupabaseTarget()(本機),不讀 `.env`;Node 端 fetch 已被 config 鎖成只准打本機。
//   ・業務資料以商家管理員身分走前端同一組 RPC / 表格;service_role 只用在建 active 客服列(正式流程是
//     Edge Function invite-merchant-agent)、查核與 teardown。
//
// 一間商家,一個管理員、一位只有「料錢成本管理」權限的客服、一位抽成制服務人員 S(服務項目 3,000 元抽 40%);
// 料錢品項 M500(500 元)、料錢成本功能開啟;今天 10:00、13:00 各一張 S 的單,都帶 M500(還沒完成)。
//
// teardown:service_role 硬刪除。刪前 SELECT 核對(商家名稱是本 fixture 前綴、帳號 email 是本 fixture 格式,
// 對不上就整個不刪),刪後再 SELECT 一次全部必須為 0;服務人員頻道的即時訊號列一併清掉。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { buildFetch } from "../../e2e/support/fixture-supabase-client";
import { buildTaipeiIso, getTaipeiNow, toDateKey } from "../../src/modules/booking/dateUtils";
import { staffScheduleTopic } from "../../src/modules/staff-portal/staffScheduleChannel";
import { localAuthStorageKey, readLocalSupabaseTarget } from "./local-target";

export const MERCHANT_NAME_PREFIX = "E2E料錢抽成第8批本機測試商家";
const EMAIL_PATTERN = /^e2e-mc985-(admin|agent)-\d+@example-local-test\.test$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface MaterialCommissionFixture {
  runId: string;
  merchantId: string;
  groupId: string;
  admin: SupabaseClient;
  adminSession: Session;
  agentSession: Session;
  staffId: string;
  staffName: string;
  booking1Id: string;
  booking2Id: string;
  userIds: string[];
}

function makeClient(key: string, accessToken?: string): SupabaseClient {
  const { url } = readLocalSupabaseTarget();
  return createClient(url, key, {
    global: {
      fetch: buildFetch(key),
      ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function anonClient(): SupabaseClient {
  return makeClient(readLocalSupabaseTarget().publishableKey);
}

/** 用某位使用者的 session 當呼叫者(直接打 RPC 驗證後端權限)。 */
export function clientAs(session: Session): SupabaseClient {
  return makeClient(readLocalSupabaseTarget().publishableKey, session.access_token);
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

function psqlLocal(sql: string): string {
  readLocalSupabaseTarget();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const projectId = readFileSync(resolve(root, "supabase/config.toml"), "utf8").match(
    /^project_id\s*=\s*"([^"]+)"/m,
  )?.[1];
  if (!projectId) throw new Error("讀不到 supabase/config.toml 的 project_id");
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      `supabase_db_${projectId}`,
      "psql",
      "-U",
      "postgres",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
    ],
    { input: sql, encoding: "utf8" },
  ).trim();
}

async function signUp(runId: string, role: string, password: string) {
  const email = `e2e-mc985-${role}-${runId}@example-local-test.test`;
  const r = await anonClient().auth.signUp({ email, password });
  const session = must(`建立帳號(${role})`, r.data.session, r.error);
  return { session, userId: session.user.id, email };
}

export async function setupMaterialCommissionFixture(): Promise<MaterialCommissionFixture> {
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const password = `E2eMc985!${runId}Aa`;
  const seed = Number(runId.slice(-7)) * 10;
  const phone = (n: number) => `09${String((seed + n) % 100_000_000).padStart(8, "0")}`;
  const svc = serviceClient();

  const adminUser = await signUp(runId, "admin", password);
  const admin = makeClient(
    readLocalSupabaseTarget().publishableKey,
    adminUser.session.access_token,
  );
  const merchantRes = await admin.rpc("create_group_and_merchant", {
    p_name: `${MERCHANT_NAME_PREFIX}${runId}`,
    p_industry_type: "on_site_dispatch",
    p_address: "E2E第8批測試商家地址",
    p_contact_email: adminUser.email,
    p_intro: "#985 第 8 批本機 e2e 測試商家,測試完硬刪除。",
  });
  const merchantId = must("建立測試商家", merchantRes.data as string | null, merchantRes.error);
  const groupRow = await svc.from("merchants").select("group_id").eq("id", merchantId).single();
  const groupId = must("查詢集團", groupRow.data, groupRow.error).group_id as string;

  const hoursRes = await admin.from("merchant_business_hours").upsert(
    Array.from({ length: 7 }, (_, d) => ({
      merchant_id: merchantId,
      day_of_week: d,
      is_closed: false,
      open_time: "08:00",
      close_time: "21:00",
    })),
    { onConflict: "merchant_id,day_of_week" },
  );
  if (hoursRes.error) throw new Error(`營業時間失敗:${hoursRes.error.message}`);
  const itemRes = await admin
    .from("service_items")
    .insert({
      merchant_id: merchantId,
      name: "E2E第8批服務60分",
      price: 3000,
      item_type: "primary",
      duration_minutes: 60,
    })
    .select("id")
    .single();
  const serviceItemId = must("建立服務項目", itemRes.data, itemRes.error).id as string;
  const pmRes = await admin
    .from("payment_methods")
    .select("id")
    .eq("merchant_id", merchantId)
    .eq("status", "active")
    .limit(1)
    .single();
  const paymentMethodId = must("查付款方式", pmRes.data, pmRes.error).id as string;

  // 料錢:功能開啟 + 一個品項 M500。
  const flagRes = await admin
    .from("merchant_feature_flags")
    .upsert(
      { merchant_id: merchantId, feature_key: "material_cost_enabled", enabled: true },
      { onConflict: "merchant_id,feature_key" },
    );
  if (flagRes.error) throw new Error(`開啟料錢成本功能失敗:${flagRes.error.message}`);
  const mcRes = await admin
    .from("material_cost_items")
    .insert({ merchant_id: merchantId, name: "E2E第8批料錢M500", amount: 500 })
    .select("id")
    .single();
  const materialId = must("建立料錢品項", mcRes.data, mcRes.error).id as string;

  // 只有「料錢成本管理」權限的客服。
  const agentUser = await signUp(runId, "agent", password);
  const agentRes = await svc
    .from("merchant_agents")
    .insert({
      merchant_id: merchantId,
      user_id: agentUser.userId,
      name: `E2E第8批料錢客服${runId}`,
      phone: phone(1),
      invited_email: agentUser.email,
      status: "active",
      activated_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  const agentId = must("建立客服", agentRes.data, agentRes.error).id as string;
  const perm = await admin.rpc("set_agent_permission", {
    p_agent_id: agentId,
    p_section_key: "material_costs",
    p_granted: true,
  });
  if (perm.error) throw new Error(`開客服 material_costs 權限失敗:${perm.error.message}`);

  // 抽成制服務人員 S:服務項目抽 40%;後台無時段限制(建單不用布置每週時段)。
  const staffName = `E2E第8批服務人員${runId}`;
  const staffRes = await admin
    .from("merchant_staff")
    .insert({
      merchant_id: merchantId,
      name: staffName,
      phone: phone(2),
      is_listed: true,
      unlimited_backend_edit: true,
      compensation_type: "piece_rate",
    })
    .select("id")
    .single();
  const staffId = must("建立服務人員", staffRes.data, staffRes.error).id as string;
  const rateRes = await admin.from("staff_service_commission_rates").insert({
    staff_id: staffId,
    service_item_id: serviceItemId,
    commission_mode: "percentage",
    commission_value: 40,
  });
  if (rateRes.error) throw new Error(`設定抽成失敗:${rateRes.error.message}`);

  const dateKey = toDateKey(getTaipeiNow());
  async function mk(time: string, n: number) {
    const r = await admin.rpc("create_booking", {
      p_merchant_id: merchantId,
      p_staff_id: staffId,
      p_service_items: [{ service_item_id: serviceItemId, quantity: 1, unit_price: 3000 }],
      p_start_at: buildTaipeiIso(dateKey, time),
      p_customer_name: `E2E第8批客戶${n}`,
      p_customer_phone: phone(10 + n),
      p_customer_address: "E2E第8批客戶地址",
      p_material_cost_item_ids: [materialId],
      p_payment_method_id: paymentMethodId,
    });
    return (must(`建立預約 ${n}`, r.data, r.error) as { id: string }).id;
  }
  const booking1Id = await mk("10:00", 1);
  const booking2Id = await mk("13:00", 2);

  return {
    runId,
    merchantId,
    groupId,
    admin,
    adminSession: adminUser.session,
    agentSession: agentUser.session,
    staffId,
    staffName,
    booking1Id,
    booking2Id,
    userIds: [adminUser.userId, agentUser.userId],
  };
}

/** 以商家管理員身分確認並完成一張單(走正式 RPC)。 */
export async function completeBooking(
  fixture: MaterialCommissionFixture,
  bookingId: string,
): Promise<void> {
  const c = await fixture.admin.rpc("confirm_booking", { p_booking_id: bookingId });
  if (c.error) throw new Error(`確認預約失敗:${c.error.message}`);
  const d = await fixture.admin.rpc("complete_booking", { p_booking_id: bookingId });
  if (d.error) throw new Error(`完成預約失敗:${d.error.message}`);
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

export async function teardownMaterialCommissionFixture(
  fixture: MaterialCommissionFixture,
): Promise<string[]> {
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
    throw new Error(
      `teardown 中止:集團底下的商家不是本 fixture 建立的(${JSON.stringify(rows)}),不刪任何東西`,
    );
  }
  for (const id of fixture.userIds) {
    const u = await svc.auth.admin.getUserById(id);
    const email = u.data.user?.email ?? "";
    if (u.error || !EMAIL_PATTERN.test(email)) {
      throw new Error(
        `teardown 中止:使用者 ${id.slice(0, 8)} 不是本 fixture 建立的帳號(${email}),不刪任何東西`,
      );
    }
  }
  if (!UUID_RE.test(fixture.staffId)) throw new Error("teardown 中止:staff id 格式不對");
  actions.push(`核對通過:商家 1 間、帳號 ${fixture.userIds.length} 個,都是本次 fixture 建立的`);

  // ② 依外鍵順序硬刪除
  const m = [fixture.merchantId];
  const steps: [
    string,
    () => PromiseLike<{ error: { message: string } | null; data: unknown[] | null }>,
  ][] = [
    [
      "LINE 發送記錄",
      () => svc.from("line_notification_log").delete().in("merchant_id", m).select("id"),
    ],
    // 抽成紀錄要先刪:逐項明細(連帶刪除)對 booking_service_items 的外鍵是 no action,
    // 直接刪訂單會被擋。
    [
      "抽成紀錄",
      () => svc.from("booking_commission_records").delete().in("merchant_id", m).select("id"),
    ],
    ["訂單", () => svc.from("bookings").delete().in("merchant_id", m).select("id")],
    ["商家", () => svc.from("merchants").delete().in("id", m).select("id")],
    ["集團", () => svc.from("groups").delete().eq("id", fixture.groupId).select("id")],
  ];
  for (const [label, run] of steps) {
    const r = await run();
    if (r.error) throw new Error(`teardown 刪${label}失敗:${r.error.message}`);
    actions.push(`已硬刪除${label} ${r.data?.length ?? 0} 筆`);
  }
  for (const id of fixture.userIds) {
    const r = await svc.auth.admin.deleteUser(id);
    if (r.error) throw new Error(`teardown 刪帳號失敗:${r.error.message}`);
  }
  actions.push(`已硬刪除 auth 帳號 ${fixture.userIds.length} 個`);

  // ③ 刪後核對
  const count = async (table: string, column: string, value: string) => {
    const r = await svc.from(table).select("*", { count: "exact", head: true }).eq(column, value);
    if (r.error) throw new Error(`teardown 核對 ${table} 失敗:${r.error.message}`);
    return r.count ?? 0;
  };
  const left =
    (await count("merchants", "id", fixture.merchantId)) +
    (await count("groups", "id", fixture.groupId)) +
    (await count("bookings", "merchant_id", fixture.merchantId)) +
    (await count("merchant_staff", "merchant_id", fixture.merchantId)) +
    (await count("merchant_agents", "merchant_id", fixture.merchantId)) +
    (await count("merchant_payroll_settings", "merchant_id", fixture.merchantId)) +
    (await count("material_cost_items", "merchant_id", fixture.merchantId)) +
    (await count("booking_commission_records", "merchant_id", fixture.merchantId));
  let usersLeft = 0;
  for (const id of fixture.userIds) {
    const r = await svc.auth.admin.getUserById(id);
    if (r.data.user) usersLeft += 1;
  }
  if (left + usersLeft !== 0)
    throw new Error(`teardown 後仍有殘留:${left} 列資料、${usersLeft} 個帳號`);
  actions.push(
    "刪後核對:商家 / 集團 / 訂單 / 服務人員 / 客服 / 薪資設定 / 料錢品項 / 抽成紀錄 / 帳號 全部 0",
  );

  // ④ 服務人員頻道的即時訊號列
  const where = `topic = '${staffScheduleTopic(fixture.staffId)}'`;
  const before = psqlLocal(`select count(*) from realtime.messages where ${where};`);
  psqlLocal(`delete from realtime.messages where ${where};`);
  const after = psqlLocal(`select count(*) from realtime.messages where ${where};`);
  if (after !== "0") throw new Error(`teardown 後 realtime.messages 仍有 ${after} 列`);
  actions.push(`已硬刪除本次頻道的訊號列 ${before} 列,刪後 0 列`);
  return actions;
}
