// 「服務人員接單確認 第 4 批」(#977)本機 e2e fixture。
// 規格書:.project/specs/服務人員接單確認-第4批.md 第六節(e2e-local)。
// 只在 playwright.local.config.ts 底下用(`npm run test:e2e:local`),只連本機 Docker 的 Supabase。
//
// 寫法比照 e2e-local/support/permission-batch3-fixture.ts:
//   ・網址 / 金鑰一律取自 readLocalSupabaseTarget()(本機),不讀 `.env`;Node 端 fetch 已被 config 鎖成只准打本機。
//   ・業務資料以商家管理員身分走前端同一組 RPC / 表格;service_role 只用在:開通服務人員登入
//     (record_invited_staff_login)、查核與 teardown。
//
// 一間商家(美業,不需要客戶地址),一個管理員:
//   服務人員 S(「確認者」):已開通登入、行事曆檢視開、「商家後台確認後直接接單」關閉;今天三張單:
//     10:00 待確認(要按確認的那張)、14:00 已確認(管理員確認)、16:00 待確認(留著當對照)
//   服務人員 D(「直接接單者」):「商家後台確認後直接接單」開啟,不用登入(只是被指派)
//
// teardown:service_role 硬刪除。刪前 SELECT 核對(商家名稱是本 fixture 前綴、帳號 email 是本 fixture 格式,
// 對不上就整個不刪),刪後再 SELECT 一次全部必須為 0;兩位服務人員頻道的即時訊號列(realtime.messages)也一併清掉。
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

export const MERCHANT_NAME_PREFIX = "E2E接單確認第4批本機測試商家";
export const CUSTOMER_CONFIRM = "E2E第4批要確認的客戶";
export const CUSTOMER_ACCEPTED = "E2E第4批已確認客戶";
export const CUSTOMER_PENDING = "E2E第4批待確認客戶";
export const ITEM_NAME = "E2E第4批服務60分";
const EMAIL_PATTERN = /^e2e-confirm4-(admin|staff)-\d+@example-local-test\.test$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface StaffConfirmFixture {
  runId: string;
  dateKey: string;
  tomorrowKey: string;
  merchantId: string;
  groupId: string;
  admin: SupabaseClient;
  adminSession: Session;
  adminEmail: string;
  staffSession: Session;
  staffId: string;
  staffName: string;
  directStaffId: string;
  directStaffName: string;
  bookingToConfirmId: string;
  serviceItemId: string;
  paymentMethodId: string;
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
  const email = `e2e-confirm4-${role}-${runId}@example-local-test.test`;
  const r = await anonClient().auth.signUp({ email, password });
  const session = must(`建立帳號(${role})`, r.data.session, r.error);
  return { session, userId: session.user.id, email };
}

export async function setupStaffConfirmFixture(): Promise<StaffConfirmFixture> {
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const password = `E2eConfirm4!${runId}Aa`;
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
    p_address: "E2E第4批測試商家地址",
    p_contact_email: adminUser.email,
    p_intro: "#977 第 4 批本機 e2e 測試商家,測試完硬刪除。",
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
    .select("id")
    .eq("merchant_id", merchantId)
    .eq("status", "active")
    .limit(1)
    .single();
  const paymentMethodId = must("查付款方式", pmRes.data, pmRes.error).id as string;

  // 服務人員 S(確認者):開關關閉;D(直接接單者):開關開啟。兩位都「後台無時段限制」(建單不用布置每週時段)。
  const staffName = `E2E第4批確認者${runId}`;
  const directStaffName = `E2E第4批直接接單者${runId}`;
  const staffRes = await admin
    .from("merchant_staff")
    .insert([
      {
        merchant_id: merchantId,
        name: staffName,
        phone: phone(1),
        is_listed: true,
        unlimited_backend_edit: true,
        direct_accept_after_merchant_confirm: false,
      },
      {
        merchant_id: merchantId,
        name: directStaffName,
        phone: phone(2),
        is_listed: true,
        unlimited_backend_edit: true,
        direct_accept_after_merchant_confirm: true,
      },
    ])
    .select("id,name");
  const staffRows = must("建立服務人員", staffRes.data, staffRes.error) as {
    id: string;
    name: string;
  }[];
  const staffId = staffRows.find((r) => r.name === staffName)!.id;
  const directStaffId = staffRows.find((r) => r.name === directStaffName)!.id;

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

  // 今天三張 S 的單(管理員建單 ⇒ 開關關閉 ⇒ 都是待確認;14:00 那張再由管理員確認)。
  const dateKey = toDateKey(getTaipeiNow());
  const tomorrowKey = toDateKey(addDays(getTaipeiNow(), 1));
  async function book(time: string, customer: string, n: number): Promise<string> {
    const r = await admin.rpc("create_booking", {
      p_merchant_id: merchantId,
      p_staff_id: staffId,
      p_service_items: [{ service_item_id: serviceItemId, quantity: 1, unit_price: 1500 }],
      p_start_at: buildTaipeiIso(dateKey, time),
      p_customer_name: customer,
      p_customer_phone: phone(n),
      p_payment_method_id: paymentMethodId,
    });
    const row = must(`建立預約 ${time}`, r.data, r.error) as { id: string; status: string };
    if (row.status !== "pending_confirmation") {
      throw new Error(`fixture 前提不成立:開關關閉時新單應是待確認,實際 ${row.status}`);
    }
    return row.id;
  }
  const bookingToConfirmId = await book("10:00", CUSTOMER_CONFIRM, 11);
  const acceptedId = await book("14:00", CUSTOMER_ACCEPTED, 12);
  await book("16:00", CUSTOMER_PENDING, 13);
  const conf = await admin.rpc("confirm_booking", { p_booking_id: acceptedId });
  if (conf.error) throw new Error(`管理員確認 14:00 那張失敗:${conf.error.message}`);

  return {
    runId,
    dateKey,
    tomorrowKey,
    merchantId,
    groupId,
    admin,
    adminSession: adminUser.session,
    adminEmail: adminUser.email,
    staffSession: staffUser.session,
    staffId,
    staffName,
    directStaffId,
    directStaffName,
    bookingToConfirmId,
    serviceItemId,
    paymentMethodId,
    userIds: [adminUser.userId, staffUser.userId],
  };
}

/**
 * E4 兩位數情境用:以商家管理員身分在今天替服務人員 S 加幾張單(開關關閉 ⇒ 待確認),
 * accept=true 的再由管理員確認。每張 60 分鐘,時間由呼叫端給(避開既有的 10:00 / 14:00 / 16:00)。
 */
export async function addTodayBookings(
  fixture: StaffConfirmFixture,
  times: string[],
  accept: boolean,
): Promise<void> {
  for (const [i, time] of times.entries()) {
    const r = await fixture.admin.rpc("create_booking", {
      p_merchant_id: fixture.merchantId,
      p_staff_id: fixture.staffId,
      p_service_items: [{ service_item_id: fixture.serviceItemId, quantity: 1, unit_price: 1500 }],
      p_start_at: buildTaipeiIso(fixture.dateKey, time),
      p_customer_name: `E2E第4批兩位數客戶${accept ? "A" : "P"}${i}`,
      p_customer_phone: `09${String((Number(fixture.runId.slice(-6)) * 100 + i + (accept ? 50 : 0)) % 100_000_000).padStart(8, "0")}`,
      p_payment_method_id: fixture.paymentMethodId,
    });
    const row = must(`加單 ${time}`, r.data, r.error) as { id: string };
    if (accept) {
      const c = await fixture.admin.rpc("confirm_booking", { p_booking_id: row.id });
      if (c.error) throw new Error(`確認 ${time} 失敗:${c.error.message}`);
    }
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

export async function teardownStaffConfirmFixture(fixture: StaffConfirmFixture): Promise<string[]> {
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
  if (!UUID_RE.test(fixture.staffId) || !UUID_RE.test(fixture.directStaffId)) {
    throw new Error("teardown 中止:staff id 格式不對");
  }
  const bookingCount = await svc
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", fixture.merchantId);
  actions.push(
    `核對通過:商家 1 間、帳號 ${fixture.userIds.length} 個、預約 ${bookingCount.count ?? "?"} 筆,都是本次 fixture 建立的`,
  );

  // ② 依外鍵順序硬刪除
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
    // #984:商家端月曆 e2e 會把一張單標記完成 ⇒ 產生抽成快照;booking_commission_item_records →
    // booking_service_items 沒有 cascade ⇒ 先刪抽成快照(寫法比照 staff-order-fixture)。
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

  // ④ 兩位服務人員頻道的即時訊號列
  for (const sid of [fixture.staffId, fixture.directStaffId]) {
    const where = `topic = '${staffScheduleTopic(sid)}'`;
    const before = psqlLocal(`select count(*) from realtime.messages where ${where};`);
    psqlLocal(`delete from realtime.messages where ${where};`);
    const after = psqlLocal(`select count(*) from realtime.messages where ${where};`);
    if (after !== "0") throw new Error(`teardown 後 realtime.messages 仍有 ${after} 列`);
    actions.push(`已硬刪除服務人員 ${sid.slice(0, 8)} 頻道的訊號列 ${before} 列,刪後 0 列`);
  }
  return actions;
}
