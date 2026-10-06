// #986 第 9 批(使用者裁決小項 + 第 7 批調整)本機 e2e fixture。
// 規格書:.project/specs/使用者裁決小項與第7批調整-第9批.md 5-4。
// 只在 playwright.local.config.ts 底下用(`npm run test:e2e:local`),只連本機 Docker 的 Supabase。
// 寫法比照 staff-order-fixture.ts(第 7 批):網址 / 金鑰一律 readLocalSupabaseTarget();業務資料以商家管理員身分
// 走前端同一組 RPC / 表格;service_role 只用在開通服務人員登入、建客服列、建超級管理員列、查核與 teardown。
//
// 一間商家(美業)、一個管理員、一位可以自己下單的服務人員 S、兩位客服(O 有「訂單管理」、N 沒有)、
// 一位本機專用的超級管理員 P(只拿來看超級管理員頁標點改完有沒有爆版)。
//   料錢成本功能開 + 一個料錢品項;建單時間間隔 = 10 分鐘。
// 明天(台北)的單(管理員建,主要服務人員都是 S):
//   BM 09:00(商家端拖拉)/ BS 13:00(服務人員端拖拉)/ BC 15:00(服務人員確認接單 ⇒ 客服 O 收到鈴鐺)
//
// teardown:service_role 硬刪除。刪前 SELECT 核對(商家名稱前綴、帳號 email 格式、超級管理員列 note),
// 刪後再 SELECT 全部為 0;服務人員頻道的即時訊號列(realtime.messages)也一併清掉。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

import { buildFetch } from "../../e2e/support/fixture-supabase-client";
import {
  addDays,
  buildTaipeiIso,
  getTaipeiNow,
  toDateKey,
} from "../../src/modules/booking/dateUtils";
import { staffScheduleTopic } from "../../src/modules/staff-portal/staffScheduleChannel";
import { readLocalSupabaseTarget } from "./local-target";

export const MERCHANT_NAME_PREFIX = "E2E第9批本機測試商家";
export const ITEM_NAME = "E2E第9批服務60分";
export const MATERIAL_NAME = "E2E第9批料錢冷媒";
export const CUSTOMER_BM = "E2E第9批商家拖拉客戶";
export const CUSTOMER_BS = "E2E第9批服務人員拖拉客戶";
export const CUSTOMER_BC = "E2E第9批確認接單客戶";
const PLATFORM_ADMIN_NOTE = "E2E第9批本機暫時超級管理員(teardown 硬刪除)";
const EMAIL_PATTERN = /^e2e-batch9-(admin|s|agento|agentn|platform)-\d+@example-local-test\.test$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Batch9Fixture {
  runId: string;
  dateKey: string;
  merchantId: string;
  groupId: string;
  admin: SupabaseClient;
  adminSession: Session;
  staff: {
    staffId: string;
    name: string;
    session: Session;
    userId: string;
    client: SupabaseClient;
  };
  agentO: { agentId: string; name: string; session: Session; userId: string };
  agentN: { agentId: string; name: string; session: Session; userId: string };
  platform: { session: Session; userId: string };
  bookings: { bm: string; bs: string; bc: string };
  serviceItemId: string;
  materialId: string;
  paymentMethodName: string;
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

export function serviceClient(): SupabaseClient {
  return makeClient(readLocalSupabaseTarget().serviceRoleKey);
}

function userClient(session: Session): SupabaseClient {
  return makeClient(readLocalSupabaseTarget().publishableKey, session.access_token);
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
  const email = `e2e-batch9-${role}-${runId}@example-local-test.test`;
  const r = await anonClient().auth.signUp({ email, password });
  const session = must(`建立帳號(${role})`, r.data.session, r.error);
  return { session, userId: session.user.id, email };
}

export async function setupBatch9Fixture(): Promise<Batch9Fixture> {
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const password = `E2eBatch9!${runId}Aa`;
  const seed = Number(runId.slice(-7)) * 10;
  const phone = (n: number) => `09${String((seed + n) % 100_000_000).padStart(8, "0")}`;
  const svc = serviceClient();

  const adminUser = await signUp(runId, "admin", password);
  const admin = userClient(adminUser.session);
  const merchantRes = await admin.rpc("create_group_and_merchant", {
    p_name: `${MERCHANT_NAME_PREFIX}${runId}`,
    p_industry_type: "in_store_beauty",
    p_address: "E2E第9批測試商家地址",
    p_contact_email: adminUser.email,
    p_intro: "#986 第 9 批本機 e2e 測試商家,測試完硬刪除。",
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
  // 建單時間間隔 10 分鐘(9-10 / 9-11)。
  const intervalRes = await admin
    .from("merchant_booking_settings")
    .upsert(
      { merchant_id: merchantId, start_time_interval_minutes: 10 },
      { onConflict: "merchant_id" },
    );
  if (intervalRes.error) throw new Error(`建單時間間隔失敗:${intervalRes.error.message}`);

  const itemRes = await admin
    .from("service_items")
    .insert({
      merchant_id: merchantId,
      name: ITEM_NAME,
      price: 1500,
      item_type: "primary",
      duration_minutes: 60,
    })
    .select("id")
    .single();
  const serviceItemId = must("建立服務項目", itemRes.data, itemRes.error).id as string;
  const pmRes = await admin
    .from("payment_methods")
    .select("id,name")
    .eq("merchant_id", merchantId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  const pm = must("查付款方式", pmRes.data, pmRes.error) as { id: string; name: string };

  // 料錢:功能開 + 一個品項。
  const flagRes = await admin
    .from("merchant_feature_flags")
    .upsert(
      { merchant_id: merchantId, feature_key: "material_cost_enabled", enabled: true },
      { onConflict: "merchant_id,feature_key" },
    );
  if (flagRes.error) throw new Error(`開啟料錢成本功能失敗:${flagRes.error.message}`);
  const mcRes = await admin
    .from("material_cost_items")
    .insert({ merchant_id: merchantId, name: MATERIAL_NAME, amount: 300 })
    .select("id")
    .single();
  const materialId = must("建立料錢品項", mcRes.data, mcRes.error).id as string;

  // 服務人員 S:按件計酬 + 新增編輯訂單開 + 顯示會員資料開 + 後台無時段限制。
  const staffName = `E2E第9批服務人員${runId}`;
  const staffRes = await admin
    .from("merchant_staff")
    .insert({
      merchant_id: merchantId,
      name: staffName,
      phone: phone(1),
      is_listed: true,
      unlimited_backend_edit: true,
      compensation_type: "piece_rate",
      can_create_edit_orders: true,
      show_member_info: true,
    })
    .select("id")
    .single();
  const staffId = must("建立服務人員", staffRes.data, staffRes.error).id as string;
  const staffUser = await signUp(runId, "s", password);
  const invite = await svc.rpc("record_invited_staff_login", {
    p_staff_id: staffId,
    p_user_id: staffUser.userId,
    p_invited_login_email: staffUser.email,
    p_login_status: "active",
  });
  if (invite.error) throw new Error(`開通服務人員登入失敗:${invite.error.message}`);

  // 客服 O(訂單管理)、N(只有服務項目,沒有訂單管理)。
  async function makeAgent(role: "agento" | "agentn", label: string, section: string, n: number) {
    const user = await signUp(runId, role, password);
    const name = `E2E第9批${label}${runId}`;
    const res = await svc
      .from("merchant_agents")
      .insert({
        merchant_id: merchantId,
        user_id: user.userId,
        name,
        phone: phone(n),
        invited_email: user.email,
        status: "active",
        activated_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    const agentId = must(`建立客服 ${label}`, res.data, res.error).id as string;
    const perm = await admin.rpc("set_agent_permission", {
      p_agent_id: agentId,
      p_section_key: section,
      p_granted: true,
    });
    if (perm.error) throw new Error(`開客服 ${section} 權限失敗:${perm.error.message}`);
    return { agentId, name, session: user.session, userId: user.userId };
  }
  const agentO = await makeAgent("agento", "訂單客服", "orders", 2);
  const agentN = await makeAgent("agentn", "項目客服", "service_items", 3);

  // 本機暫時超級管理員(platform_admins 沒有自助寫入,service_role 建列;teardown 依 note 核對後硬刪除)。
  const platformUser = await signUp(runId, "platform", password);
  const paRes = await svc
    .from("platform_admins")
    .insert({ user_id: platformUser.userId, note: PLATFORM_ADMIN_NOTE });
  if (paRes.error) throw new Error(`建立本機超級管理員失敗:${paRes.error.message}`);

  const dateKey = toDateKey(addDays(getTaipeiNow(), 1));
  async function book(time: string, customer: string, n: number) {
    const r = await admin.rpc("create_booking", {
      p_merchant_id: merchantId,
      p_staff_id: staffId,
      p_service_items: [{ service_item_id: serviceItemId, quantity: 1, unit_price: 1500 }],
      p_start_at: buildTaipeiIso(dateKey, time),
      p_customer_name: customer,
      p_customer_phone: phone(n),
      p_payment_method_id: pm.id,
    });
    return (must(`建立預約 ${time}`, r.data, r.error) as { id: string }).id;
  }
  const bm = await book("09:00", CUSTOMER_BM, 11);
  const bs = await book("13:00", CUSTOMER_BS, 12);
  const bc = await book("15:00", CUSTOMER_BC, 13);

  return {
    runId,
    dateKey,
    merchantId,
    groupId,
    admin,
    adminSession: adminUser.session,
    staff: {
      staffId,
      name: staffName,
      session: staffUser.session,
      userId: staffUser.userId,
      client: userClient(staffUser.session),
    },
    agentO,
    agentN,
    platform: { session: platformUser.session, userId: platformUser.userId },
    bookings: { bm, bs, bc },
    serviceItemId,
    materialId,
    paymentMethodName: pm.name,
    userIds: [
      adminUser.userId,
      staffUser.userId,
      agentO.userId,
      agentN.userId,
      platformUser.userId,
    ],
  };
}

export async function teardownBatch9Fixture(fixture: Batch9Fixture): Promise<string[]> {
  const svc = serviceClient();
  const actions: string[] = [];

  // ① 刪前 SELECT 核對
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
  const pa = await svc
    .from("platform_admins")
    .select("id,user_id,note")
    .eq("user_id", fixture.platform.userId);
  const paRows = (pa.data ?? []) as { id: string; note: string | null }[];
  if (pa.error || paRows.length !== 1 || paRows[0]!.note !== PLATFORM_ADMIN_NOTE) {
    throw new Error(`teardown 中止:超級管理員列不是本 fixture 建立的(${JSON.stringify(paRows)})`);
  }
  if (!UUID_RE.test(fixture.staff.staffId)) throw new Error("teardown 中止:staff id 格式不對");
  actions.push(
    `核對通過:商家 1 間、帳號 ${fixture.userIds.length} 個、超級管理員列 1 列,都是本次 fixture 建立的`,
  );

  // ② 依外鍵順序硬刪除
  const m = [fixture.merchantId];
  const steps: [
    string,
    () => PromiseLike<{ error: { message: string } | null; data: unknown[] | null }>,
  ][] = [
    [
      "本機超級管理員列",
      () => svc.from("platform_admins").delete().eq("id", paRows[0]!.id).select("id"),
    ],
    ["站內通知", () => svc.from("user_notifications").delete().in("merchant_id", m).select("id")],
    [
      "LINE 發送記錄",
      () => svc.from("line_notification_log").delete().in("merchant_id", m).select("id"),
    ],
    [
      "推播發送記錄",
      () => svc.from("push_notification_log").delete().in("merchant_id", m).select("id"),
    ],
    [
      "抽成快照",
      () => svc.from("booking_commission_records").delete().in("merchant_id", m).select("id"),
    ],
    ["訂單", () => svc.from("bookings").delete().in("merchant_id", m).select("id")],
    ["會員", () => svc.from("members").delete().in("merchant_id", m).select("id")],
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
    (await count("members", "merchant_id", fixture.merchantId)) +
    (await count("merchant_staff", "merchant_id", fixture.merchantId)) +
    (await count("merchant_agents", "merchant_id", fixture.merchantId)) +
    (await count("material_cost_items", "merchant_id", fixture.merchantId)) +
    (await count("service_items", "merchant_id", fixture.merchantId)) +
    (await count("merchant_booking_settings", "merchant_id", fixture.merchantId)) +
    (await count("user_notifications", "merchant_id", fixture.merchantId)) +
    (await count("line_notification_log", "merchant_id", fixture.merchantId)) +
    (await count("push_notification_log", "merchant_id", fixture.merchantId)) +
    (await count("platform_admins", "user_id", fixture.platform.userId));
  let usersLeft = 0;
  for (const id of fixture.userIds) {
    const r = await svc.auth.admin.getUserById(id);
    if (r.data.user) usersLeft += 1;
  }
  if (left + usersLeft !== 0)
    throw new Error(`teardown 後仍有殘留:${left} 列資料、${usersLeft} 個帳號`);
  actions.push(
    "刪後核對:商家 / 集團 / 訂單 / 會員 / 服務人員 / 客服 / 料錢 / 服務項目 / 間隔設定 / 通知 / 記錄 / 超級管理員列 / 帳號 全部 0",
  );

  const where = `topic = '${staffScheduleTopic(fixture.staff.staffId)}'`;
  const before = psqlLocal(`select count(*) from realtime.messages where ${where};`);
  psqlLocal(`delete from realtime.messages where ${where};`);
  const after = psqlLocal(`select count(*) from realtime.messages where ${where};`);
  if (after !== "0") throw new Error(`teardown 後 realtime.messages 仍有 ${after} 列`);
  actions.push(`已硬刪除服務人員頻道的訊號列 ${before} 列,刪後 0 列`);
  return actions;
}
