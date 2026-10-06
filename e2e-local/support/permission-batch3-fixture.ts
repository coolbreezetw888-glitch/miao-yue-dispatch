// 「權限收緊與服務人員開關修正 第 3 批」(#976 / #977)的本機 e2e fixture。
// 規格書:.project/specs/權限收緊與服務人員開關修正-第3批.md 第五節第 3 點。
// 只在 playwright.local.config.ts 底下用(`npm run test:e2e:local`),只連本機 Docker 的 Supabase。
//
// 寫法比照 e2e-local/support/staff-live-sync-fixture.ts / bonus-fixture.ts:
//   ・網址 / 金鑰一律取自 readLocalSupabaseTarget()(本機),不讀 `.env`;Node 端 fetch 已被 config 鎖成只准打本機。
//   ・業務資料以商家管理員身分走前端同一組 RPC / 表格;service_role 只用在:建 active 客服列(正式流程是
//     Edge Function invite-merchant-agent)、開通服務人員登入(record_invited_staff_login)、
//     建已綁定 LINE 的會員(綁定流程要真的 LINE)、查核與 teardown。
//
// 一間商家(到府派工,地址是正式欄位),一個管理員:
//   客服「再行銷」:只開 line_marketing
//   客服「LINE 通知」:只開 line_notification(對照組:不能用再行銷通知)
//   服務人員 S:已開通登入、行事曆檢視開、「服務人員是否顯示會員資料」關閉;今天 10:00 一張單(帶電話、地址)
//   會員:一位已綁定 LINE(名單頁要列得出來)、一位沒綁定(Edge Function 呼叫用:會被跳過,不會真的打 LINE)
//
// teardown:service_role 硬刪除。刪前 SELECT 核對(商家名稱是本 fixture 前綴、帳號 email 是本 fixture 格式,
// 對不上就整個不刪),刪後再 SELECT 一次全部必須為 0;服務人員頻道的即時訊號列(realtime.messages)也一併清掉
// (不清會干擾 pgTAP module14_07)。
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

export const MERCHANT_NAME_PREFIX = "E2E權限第3批本機測試商家";
export const CUSTOMER_NAME = "E2E第3批客戶王先生";
const EMAIL_PATTERN = /^e2e-perm3-(admin|marketing|notify|staff)-\d+@example-local-test\.test$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Batch3Fixture {
  runId: string;
  dateKey: string;
  merchantId: string;
  groupId: string;
  admin: SupabaseClient;
  adminSession: Session;
  marketingSession: Session;
  notifySession: Session;
  staffSession: Session;
  staffId: string;
  bookingId: string;
  customerPhone: string;
  customerAddress: string;
  boundMemberName: string;
  unboundMemberId: string;
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

function serviceClient(): SupabaseClient {
  return makeClient(readLocalSupabaseTarget().serviceRoleKey);
}

/** 用某位使用者的 session 當呼叫者(給 Edge Function 呼叫用:Authorization 帶他的 JWT)。 */
export function clientAs(session: Session): SupabaseClient {
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
  const email = `e2e-perm3-${role}-${runId}@example-local-test.test`;
  const r = await anonClient().auth.signUp({ email, password });
  const session = must(`建立帳號(${role})`, r.data.session, r.error);
  return { session, userId: session.user.id, email };
}

export async function setupBatch3Fixture(): Promise<Batch3Fixture> {
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const password = `E2ePerm3!${runId}Aa`;
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
    p_address: "E2E第3批測試商家地址",
    p_contact_email: adminUser.email,
    p_intro: "#976 / #977 第 3 批本機 e2e 測試商家,測試完硬刪除。",
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
      name: "E2E第3批服務60分",
      price: 1500,
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

  // 兩位客服(本機不跑 invite-merchant-agent,直接用 service_role 建 active 客服列;權限走正式的 set_agent_permission)
  async function addAgent(role: "marketing" | "notify", sectionKey: string, n: number) {
    const u = await signUp(runId, role, password);
    const agentRes = await svc
      .from("merchant_agents")
      .insert({
        merchant_id: merchantId,
        user_id: u.userId,
        name: `E2E第3批客服${role}${runId}`,
        phone: phone(n),
        invited_email: u.email,
        status: "active",
        activated_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    const agentId = must(`建立客服(${role})`, agentRes.data, agentRes.error).id as string;
    const perm = await admin.rpc("set_agent_permission", {
      p_agent_id: agentId,
      p_section_key: sectionKey,
      p_granted: true,
    });
    if (perm.error) throw new Error(`開客服 ${sectionKey} 權限失敗:${perm.error.message}`);
    return u;
  }
  const marketing = await addAgent("marketing", "line_marketing", 1);
  const notify = await addAgent("notify", "line_notification", 2);

  // 服務人員 S:「服務人員是否顯示會員資料」關閉;後台無時段限制(建單不用布置每週時段)。
  const staffRes = await admin
    .from("merchant_staff")
    .insert({
      merchant_id: merchantId,
      name: `E2E第3批服務人員${runId}`,
      phone: phone(3),
      is_listed: true,
      unlimited_backend_edit: true,
      show_member_info: false,
    })
    .select("id")
    .single();
  const staffId = must("建立服務人員", staffRes.data, staffRes.error).id as string;
  const staffUser = await signUp(runId, "staff", password);
  const invite = await svc.rpc("record_invited_staff_login", {
    p_staff_id: staffId,
    p_user_id: staffUser.userId,
    p_invited_login_email: staffUser.email,
    p_login_status: "active",
  });
  if (invite.error) throw new Error(`開通服務人員登入失敗:${invite.error.message}`);
  const perm = await svc
    .from("merchant_staff_permissions")
    .select("granted")
    .eq("staff_id", staffId)
    .eq("section_key", "staff_calendar_view")
    .single();
  if (must("核對行事曆檢視權限", perm.data, perm.error).granted !== true) {
    throw new Error("fixture 前提不成立:服務人員的行事曆檢視沒有開");
  }

  // 會員:一位已綁定 LINE、一位沒綁定。以管理員身分走正式的 create_member;綁定要真的 LINE,所以 line_bound /
  // line_user_id 用本機容器的 psql 直接寫(service_role 寫不了 members:電話唯一索引用到 private.normalize_phone)。
  const boundMemberName = `E2E第3批已綁定會員${runId}`;
  const boundRes = await admin.rpc("create_member", {
    p_merchant_id: merchantId,
    p_name: boundMemberName,
    p_phone: phone(4),
  });
  const boundMemberId = (must("建立已綁定會員", boundRes.data, boundRes.error) as { id: string })
    .id;
  const unboundRes = await admin.rpc("create_member", {
    p_merchant_id: merchantId,
    p_name: `E2E第3批未綁定會員${runId}`,
    p_phone: phone(5),
  });
  const unboundMemberId = (
    must("建立未綁定會員", unboundRes.data, unboundRes.error) as { id: string }
  ).id;
  if (!UUID_RE.test(boundMemberId) || !/^\d+$/.test(runId))
    throw new Error("fixture 中止:會員 id / runId 格式不對");
  const bound = psqlLocal(
    `update public.members set line_bound = true, line_user_id = 'Ue2eperm3${runId}' where id = '${boundMemberId}' and merchant_id = '${merchantId}' returning id;`,
  );
  if (bound !== boundMemberId) throw new Error(`設定會員 LINE 綁定失敗:${bound}`);

  // 今天 10:00 一張 S 的單,帶電話與地址(服務人員端關閉時看不到)
  const dateKey = toDateKey(getTaipeiNow());
  const customerPhone = phone(77);
  const customerAddress = `E2E第3批祕密地址${runId}`;
  const bookingRes = await admin.rpc("create_booking", {
    p_merchant_id: merchantId,
    p_staff_id: staffId,
    p_service_items: [{ service_item_id: serviceItemId, quantity: 1, unit_price: 1500 }],
    p_start_at: buildTaipeiIso(dateKey, "10:00"),
    p_customer_name: CUSTOMER_NAME,
    p_customer_phone: customerPhone,
    p_customer_address: customerAddress,
    p_payment_method_id: paymentMethodId,
  });
  const bookingId = (must("建立預約", bookingRes.data, bookingRes.error) as { id: string }).id;

  return {
    runId,
    dateKey,
    merchantId,
    groupId,
    admin,
    adminSession: adminUser.session,
    marketingSession: marketing.session,
    notifySession: notify.session,
    staffSession: staffUser.session,
    staffId,
    bookingId,
    customerPhone,
    customerAddress,
    boundMemberName,
    unboundMemberId,
    userIds: [adminUser.userId, marketing.userId, notify.userId, staffUser.userId],
  };
}

/** 以商家管理員身分切換服務人員 S 的「服務人員是否顯示會員資料」,並讀回確認。 */
export async function setShowMemberInfo(fixture: Batch3Fixture, value: boolean): Promise<void> {
  const r = await fixture.admin
    .from("merchant_staff")
    .update({ show_member_info: value })
    .eq("id", fixture.staffId)
    .select("show_member_info");
  const rows = must("切換顯示會員資料", r.data, r.error) as { show_member_info: boolean }[];
  if (rows.length !== 1 || rows[0]!.show_member_info !== value) {
    throw new Error(`切換顯示會員資料結果不對:${JSON.stringify(rows)}`);
  }
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

export async function teardownBatch3Fixture(fixture: Batch3Fixture): Promise<string[]> {
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
    const r = await svc.from(table).select("id", { count: "exact", head: true }).eq(column, value);
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
    (await count("line_notification_log", "merchant_id", fixture.merchantId));
  let usersLeft = 0;
  for (const id of fixture.userIds) {
    const r = await svc.auth.admin.getUserById(id);
    if (r.data.user) usersLeft += 1;
  }
  if (left + usersLeft !== 0)
    throw new Error(`teardown 後仍有殘留:${left} 列資料、${usersLeft} 個帳號`);
  actions.push(
    "刪後核對:商家 / 集團 / 訂單 / 會員 / 服務人員 / 客服 / LINE 發送記錄 / 帳號 全部 0",
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
