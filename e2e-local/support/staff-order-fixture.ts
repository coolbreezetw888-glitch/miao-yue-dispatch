// 「服務人員新增編輯訂單 第 7 批」(#977)本機 e2e fixture。
// 規格書:.project/specs/服務人員新增編輯訂單-第7批.md 第六節 6-4。
// 只在 playwright.local.config.ts 底下用(`npm run test:e2e:local`),只連本機 Docker 的 Supabase。
// 寫法比照 staff-confirm-fixture.ts(第 4 批):網址 / 金鑰一律 readLocalSupabaseTarget();業務資料以商家管理員身分
// 走前端同一組 RPC / 表格;service_role 只用在開通服務人員登入、查核與 teardown。
//
// 一間商家(美業,不需要客戶地址)、一個管理員、四位已開通登入的服務人員(都「商家後台編輯無時段限制」):
//   S   按件計酬 + 新增編輯訂單開 + 顯示會員資料開 + 排班自助權限 ⇒ 可以自己下單、也能開關時段(方案 B2)
//   M   月薪制 + 新增編輯訂單開 + 顯示會員資料開 ⇒ 可以自己下單,但不能開關時段(B2)
//   A   按件計酬 + 兩個開關都開(當 S 那張單的協助人員,驗「協助身分打開別人的單沒有按鈕」)
//   OFF 兩個開關都關(驗「開關關閉時維持唯讀」;也是商家端連動小卡窗的編輯對象)
// 明天(台北)的單(管理員建):
//   B1 S 11:00 + 協助 A(待確認)/ B2 S 13:00(待確認,要取消)/ B3 S 14:00(已確認,要完成)/
//   B4 S 17:00(待確認,要拖拉)/ B5 OFF 11:00(待確認)
//
// teardown:service_role 硬刪除。刪前 SELECT 核對(商家名稱前綴、帳號 email 格式),刪後再 SELECT 全部為 0;
// 服務人員頻道的即時訊號列(realtime.messages)也一併清掉。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { buildFetch } from "../../e2e/support/fixture-supabase-client";
import {
  addDays,
  buildTaipeiIso,
  getTaipeiNow,
  toDateKey,
} from "../../src/modules/booking/dateUtils";
import { staffScheduleTopic } from "../../src/modules/staff-portal/staffScheduleChannel";
import { localAuthStorageKey, readLocalSupabaseTarget } from "./local-target";

export const MERCHANT_NAME_PREFIX = "E2E第7批服務人員下單本機測試商家";
export const ITEM_NAME = "E2E第7批服務60分";
export const CUSTOMER_B1 = "E2E第7批協助單客戶";
export const CUSTOMER_B2 = "E2E第7批要取消客戶";
export const CUSTOMER_B3 = "E2E第7批要完成客戶";
export const CUSTOMER_B4 = "E2E第7批要拖拉客戶";
export const CUSTOMER_B5 = "E2E第7批開關關閉客戶";
const EMAIL_PATTERN = /^e2e-order7-(admin|s|m|a|off)-\d+@example-local-test\.test$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface StaffLogin {
  staffId: string;
  name: string;
  session: Session;
  userId: string;
}

export interface StaffOrderFixture {
  runId: string;
  dateKey: string;
  merchantId: string;
  groupId: string;
  admin: SupabaseClient;
  adminSession: Session;
  s: StaffLogin;
  m: StaffLogin;
  a: StaffLogin;
  off: StaffLogin;
  bookings: { b1: string; b2: string; b3: string; b4: string; b5: string };
  serviceItemId: string;
  paymentMethodId: string;
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
  const email = `e2e-order7-${role}-${runId}@example-local-test.test`;
  const r = await anonClient().auth.signUp({ email, password });
  const session = must(`建立帳號(${role})`, r.data.session, r.error);
  return { session, userId: session.user.id, email };
}

export async function setupStaffOrderFixture(): Promise<StaffOrderFixture> {
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const password = `E2eOrder7!${runId}Aa`;
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
    p_industry_type: "in_store_beauty",
    p_address: "E2E第7批測試商家地址",
    p_contact_email: adminUser.email,
    p_intro: "#977 第 7 批本機 e2e 測試商家,測試完硬刪除。",
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

  const defs = [
    { key: "s", name: `E2E第7批服務人員甲${runId}`, comp: "piece_rate", on: true },
    { key: "m", name: `E2E第7批月薪乙${runId}`, comp: "monthly_salary", on: true },
    { key: "a", name: `E2E第7批協助丙${runId}`, comp: "piece_rate", on: true },
    { key: "off", name: `E2E第7批開關關丁${runId}`, comp: "piece_rate", on: false },
  ] as const;
  const staffRes = await admin
    .from("merchant_staff")
    .insert(
      defs.map((d, i) => ({
        merchant_id: merchantId,
        name: d.name,
        phone: phone(i + 1),
        is_listed: true,
        unlimited_backend_edit: true,
        compensation_type: d.comp,
        can_create_edit_orders: d.on,
        show_member_info: d.on,
      })),
    )
    .select("id,name");
  const staffRows = must("建立服務人員", staffRes.data, staffRes.error) as {
    id: string;
    name: string;
  }[];

  const logins: Record<string, StaffLogin> = {};
  for (const d of defs) {
    const staffId = staffRows.find((r) => r.name === d.name)!.id;
    const user = await signUp(runId, d.key, password);
    const invite = await svc.rpc("record_invited_staff_login", {
      p_staff_id: staffId,
      p_user_id: user.userId,
      p_invited_login_email: user.email,
      p_login_status: "active",
    });
    if (invite.error) throw new Error(`開通服務人員登入失敗:${invite.error.message}`);
    logins[d.key] = { staffId, name: d.name, session: user.session, userId: user.userId };
  }
  // S 與 M 都開排班自助權限;B2 只有按件計酬的 S 生效(M 是月薪制)。
  for (const key of ["s", "m"]) {
    const r = await admin.rpc("set_staff_permission", {
      p_staff_id: logins[key]!.staffId,
      p_section_key: "staff_availability_self_manage",
      p_granted: true,
    });
    if (r.error) throw new Error(`開排班自助權限失敗:${r.error.message}`);
  }

  const dateKey = toDateKey(addDays(getTaipeiNow(), 1));
  async function book(
    staffId: string,
    time: string,
    customer: string,
    n: number,
    assistants: string[] = [],
  ) {
    const r = await admin.rpc("create_booking", {
      p_merchant_id: merchantId,
      p_staff_id: staffId,
      p_service_items: [{ service_item_id: serviceItemId, quantity: 1, unit_price: 1500 }],
      p_start_at: buildTaipeiIso(dateKey, time),
      p_customer_name: customer,
      p_customer_phone: phone(n),
      p_payment_method_id: pm.id,
      p_assistant_staff_ids: assistants,
    });
    return (must(`建立預約 ${time}`, r.data, r.error) as { id: string }).id;
  }
  const b1 = await book(logins["s"]!.staffId, "11:00", CUSTOMER_B1, 11, [logins["a"]!.staffId]);
  const b2 = await book(logins["s"]!.staffId, "13:00", CUSTOMER_B2, 12);
  const b3 = await book(logins["s"]!.staffId, "14:00", CUSTOMER_B3, 13);
  const b4 = await book(logins["s"]!.staffId, "17:00", CUSTOMER_B4, 14);
  const b5 = await book(logins["off"]!.staffId, "11:00", CUSTOMER_B5, 15);
  const conf = await admin.rpc("confirm_booking", { p_booking_id: b3 });
  if (conf.error) throw new Error(`管理員確認 B3 失敗:${conf.error.message}`);

  return {
    runId,
    dateKey,
    merchantId,
    groupId,
    admin,
    adminSession: adminUser.session,
    s: logins["s"]!,
    m: logins["m"]!,
    a: logins["a"]!,
    off: logins["off"]!,
    bookings: { b1, b2, b3, b4, b5 },
    serviceItemId,
    paymentMethodId: pm.id,
    paymentMethodName: pm.name,
    userIds: [adminUser.userId, ...defs.map((d) => logins[d.key]!.userId)],
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

export async function teardownStaffOrderFixture(fixture: StaffOrderFixture): Promise<string[]> {
  const svc = serviceClient();
  const actions: string[] = [];

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
  const staffIds = [fixture.s, fixture.m, fixture.a, fixture.off].map((x) => x.staffId);
  if (!staffIds.every((id) => UUID_RE.test(id))) throw new Error("teardown 中止:staff id 格式不對");
  const bookingCount = await svc
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", fixture.merchantId);
  actions.push(
    `核對通過:商家 1 間、帳號 ${fixture.userIds.length} 個、預約 ${bookingCount.count ?? "?"} 筆,都是本次 fixture 建立的`,
  );

  const m = [fixture.merchantId];
  const steps: [
    string,
    () => PromiseLike<{ error: { message: string } | null; data: unknown[] | null }>,
  ][] = [
    ["站內通知", () => svc.from("user_notifications").delete().in("merchant_id", m).select("id")],
    [
      "LINE 發送記錄",
      () => svc.from("line_notification_log").delete().in("merchant_id", m).select("id"),
    ],
    [
      "推播發送記錄",
      () => svc.from("push_notification_log").delete().in("merchant_id", m).select("id"),
    ],
    // booking_commission_item_records → booking_service_items 沒有 cascade(標記完成會產生抽成快照)⇒ 先刪抽成快照。
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
    (await count("user_notifications", "merchant_id", fixture.merchantId)) +
    (await count("line_notification_log", "merchant_id", fixture.merchantId)) +
    (await count("push_notification_log", "merchant_id", fixture.merchantId));
  let usersLeft = 0;
  for (const id of fixture.userIds) {
    const r = await svc.auth.admin.getUserById(id);
    if (r.data.user) usersLeft += 1;
  }
  if (left + usersLeft !== 0)
    throw new Error(`teardown 後仍有殘留:${left} 列資料、${usersLeft} 個帳號`);
  actions.push(
    "刪後核對:商家 / 集團 / 訂單 / 會員 / 服務人員 / 站內通知 / LINE / 推播記錄 / 帳號 全部 0",
  );

  for (const sid of staffIds) {
    const where = `topic = '${staffScheduleTopic(sid)}'`;
    const before = psqlLocal(`select count(*) from realtime.messages where ${where};`);
    psqlLocal(`delete from realtime.messages where ${where};`);
    const after = psqlLocal(`select count(*) from realtime.messages where ${where};`);
    if (after !== "0") throw new Error(`teardown 後 realtime.messages 仍有 ${after} 列`);
    actions.push(`已硬刪除服務人員 ${sid.slice(0, 8)} 頻道的訊號列 ${before} 列,刪後 0 列`);
  }
  return actions;
}
