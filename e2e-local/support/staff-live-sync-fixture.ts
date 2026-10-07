// SPECS-INDEX #874「服務人員端行事曆即時同步」本機 e2e fixture(規格書 #904 第三層)。
// 只在 playwright.local.config.ts 底下用(`npm run test:e2e:local`),只連本機 Docker 的 Supabase。
//
// 寫法比照 e2e-local/support/calendar-gesture-fixture.ts:
//   ・網址 / 金鑰一律取自 readLocalSupabaseTarget()(本機),不讀 `.env`;Node 端 fetch 已被 config 鎖成只准打本機。
//   ・🔴 改單一律以**商家管理員**身分呼叫前端同一組 RPC(create_booking / confirm_booking / complete_booking /
//     revert_completed_booking / cancel_completed_booking / move_booking / update_booking / cancel_booking),
//     不是 service_role ⇒ 權限檢查與資料庫 trigger 都走真的路徑(規格書 #904「做法」)。
//   ・service_role 只用在:① 開通服務人員登入(record_invited_staff_login,= invite-merchant-staff Edge Function
//     的同一支 RPC;本機沒有跑 Edge Function)② E11 關 / 開行事曆檢視權限 ③ teardown 硬刪除。
//
// 兩間商家(各自一個管理員、各自一個集團):
//   商家一:服務人員 A、B(都已開通登入、行事曆檢視預設開)。
//   商家二:服務人員 E(已開通登入)—— 驗「別家店不收」。
//
// teardown:service_role 硬刪除。刪前 SELECT 核對(集團底下商家名稱都是本 fixture 前綴、帳號 email 都是本 fixture
// 格式,對不上就整個不刪),刪後再 SELECT 一次全部必須為 0。
// realtime.messages 裡本次三位服務人員頻道的訊號列也一併硬刪:PostgREST 碰不到 realtime schema,所以比照
// scripts/req874-realtime-authz-probe.mjs 用 `docker exec supabase_db_<project_id> psql`(本機容器)。
// 不刪的話會干擾 pgTAP module14_07(它的 P2 前置斷言「staff:%:schedule 的訊號列 = 1」)。
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 對本機 Docker 的資料庫容器跑一段 SQL(只用在清 realtime.messages)。容器名取自 supabase/config.toml。 */
function psqlLocal(sql: string): string {
  readLocalSupabaseTarget(); // 再確認一次目標是本機
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
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
    ],
    { input: sql, encoding: "utf8" },
  ).trim();
}

export const MERCHANT_NAME_PREFIX = "E2E即時同步本機測試商家";
export const SERVICE_ITEM_NAME = "E2E即時同步服務30分";
const EMAIL_PATTERN =
  /^e2e-livesync-(admin1|admin2|staffa|staffb|staffe)-\d+@example-local-test\.test$/;

export interface LiveSyncStaff {
  staffId: string;
  name: string;
  userId: string;
  email: string;
  session: Session;
}

export interface LiveSyncMerchant {
  merchantId: string;
  groupId: string;
  adminUserId: string;
  admin: SupabaseClient;
  serviceItemId: string;
  paymentMethodId: string;
}

export interface LiveSyncFixture {
  runId: string;
  /** 台北的「今天」(YYYY-MM-DD)—— 服務人員行事曆頁預設選取的那一天。 */
  dateKey: string;
  password: string;
  m1: LiveSyncMerchant;
  m2: LiveSyncMerchant;
  staffA: LiveSyncStaff;
  staffB: LiveSyncStaff;
  staffE: LiveSyncStaff;
  /** 每張單都塞的「不該出現在訊號裡」的字串(#886 / E10)。 */
  secrets: string[];
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

/** service_role(只存在本機)。只給開通登入、切權限、查核與 teardown 用。 */
export function serviceClient(): SupabaseClient {
  return makeClient(readLocalSupabaseTarget().serviceRoleKey);
}

function must<T>(label: string, data: T | null | undefined, error: { message: string } | null): T {
  if (error || data === null || data === undefined) {
    throw new Error(`${label}失敗:${error?.message ?? "沒有回傳資料"}`);
  }
  return data;
}

function emailOf(runId: string, role: string): string {
  return `e2e-livesync-${role}-${runId}@example-local-test.test`;
}

async function signUp(
  runId: string,
  role: string,
  password: string,
): Promise<{ client: SupabaseClient; session: Session; userId: string; email: string }> {
  const email = emailOf(runId, role);
  const client = anonClient();
  const r = await client.auth.signUp({ email, password });
  const session = must(`建立帳號(${role})`, r.data.session, r.error);
  return { client, session, userId: session.user.id, email };
}

async function createMerchant(
  runId: string,
  label: string,
  role: "admin1" | "admin2",
  password: string,
): Promise<LiveSyncMerchant> {
  const { client: admin, userId, email } = await signUp(runId, role, password);
  const merchantRes = await admin.rpc("create_group_and_merchant", {
    p_name: `${MERCHANT_NAME_PREFIX}${label}${runId}`,
    // 到府派工:客戶地址是正式欄位(E10 要確認地址不會出現在訊號裡)。
    p_industry_type: "on_site_dispatch",
    p_address: "E2E即時同步測試地址",
    p_contact_email: email,
    p_intro: "#874 即時同步本機 e2e 測試商家,測試完硬刪除。",
  });
  const merchantId = must(
    `建立測試商家(${label})`,
    merchantRes.data as string | null,
    merchantRes.error,
  );
  const groupRow = await serviceClient()
    .from("merchants")
    .select("group_id")
    .eq("id", merchantId)
    .single();
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
      name: SERVICE_ITEM_NAME,
      price: 500,
      item_type: "primary",
      duration_minutes: 30,
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

  return { merchantId, groupId, adminUserId: userId, admin, serviceItemId, paymentMethodId };
}

async function createLoggedInStaff(
  runId: string,
  m: LiveSyncMerchant,
  role: "staffa" | "staffb" | "staffe",
  name: string,
  phone: string,
  password: string,
): Promise<LiveSyncStaff> {
  const staffRes = await m.admin
    .from("merchant_staff")
    .insert({
      merchant_id: m.merchantId,
      name,
      phone,
      is_listed: true,
      no_time_slot_limit: true,
      unlimited_backend_edit: true,
    })
    .select("id")
    .single();
  const staffId = must(`建立服務人員 ${name}`, staffRes.data, staffRes.error).id as string;

  const { session, userId, email } = await signUp(runId, role, password);
  // = invite-merchant-staff Edge Function「既有帳號直接開通」分支呼叫的同一支 RPC(只授權給 service_role)。
  const invite = await serviceClient().rpc("record_invited_staff_login", {
    p_staff_id: staffId,
    p_user_id: userId,
    p_invited_login_email: email,
    p_login_status: "active",
  });
  if (invite.error) throw new Error(`開通服務人員登入失敗(${name}):${invite.error.message}`);

  return { staffId, name, userId, email, session };
}

export async function setupLiveSyncFixture(): Promise<LiveSyncFixture> {
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const password = `E2eLiveSync!${runId}Aa`;
  const seed = Number(runId.slice(-7)) * 10;
  const phone = (n: number) => `09${String((seed + n) % 100_000_000).padStart(8, "0")}`;

  const m1 = await createMerchant(runId, "一店", "admin1", password);
  const m2 = await createMerchant(runId, "別家店", "admin2", password);
  const staffA = await createLoggedInStaff(
    runId,
    m1,
    "staffa",
    "E2E即時服務人員A",
    phone(1),
    password,
  );
  const staffB = await createLoggedInStaff(
    runId,
    m1,
    "staffb",
    "E2E即時服務人員B",
    phone(2),
    password,
  );
  const staffE = await createLoggedInStaff(
    runId,
    m2,
    "staffe",
    "E2E即時別家服務人員E",
    phone(3),
    password,
  );

  // 前提核對(service_role 讀實際資料庫):三位都在職、已開通登入、行事曆檢視是開的。
  const svc = serviceClient();
  const ids = [staffA.staffId, staffB.staffId, staffE.staffId];
  const rows = await svc
    .from("merchant_staff")
    .select("id,status,login_status,user_id")
    .in("id", ids);
  const list = must("核對服務人員", rows.data, rows.error) as {
    id: string;
    status: string;
    login_status: string;
    user_id: string | null;
  }[];
  if (
    list.length !== 3 ||
    list.some((r) => r.status !== "active" || r.login_status !== "active" || !r.user_id)
  ) {
    throw new Error(`fixture 服務人員狀態不對:${JSON.stringify(list)}`);
  }
  const perms = await svc
    .from("merchant_staff_permissions")
    .select("staff_id,granted")
    .eq("section_key", "staff_calendar_view")
    .in("staff_id", ids);
  const permList = must("核對行事曆檢視權限", perms.data, perms.error) as { granted: boolean }[];
  if (permList.length !== 3 || permList.some((p) => p.granted !== true)) {
    throw new Error(`fixture 行事曆檢視權限不對:${JSON.stringify(permList)}`);
  }

  const secrets = [
    `E2E祕密內部備註${runId}`,
    `E2E祕密客戶備註${runId}`,
    `E2E祕密地址${runId}`,
    phone(77),
  ];

  return {
    runId,
    dateKey: toDateKey(getTaipeiNow()),
    password,
    m1,
    m2,
    staffA,
    staffB,
    staffE,
    secrets,
  };
}

export interface CreatedBooking {
  id: string;
  customerName: string;
  startAt: string;
  staffId: string;
}

/** 以商家管理員身分建一張今天的單(帶齊 E10 要搜的祕密字串)。回傳的單是「待確認」。 */
export async function adminCreateBooking(
  fixture: LiveSyncFixture,
  m: LiveSyncMerchant,
  input: { staffId: string; time: string; customerName: string; assistantIds?: string[] },
): Promise<CreatedBooking> {
  const startAt = buildTaipeiIso(fixture.dateKey, input.time);
  const [notes, customerNotes, address, phone] = fixture.secrets as [
    string,
    string,
    string,
    string,
  ];
  const res = await m.admin.rpc("create_booking", {
    p_merchant_id: m.merchantId,
    p_staff_id: input.staffId,
    p_service_items: [{ service_item_id: m.serviceItemId, quantity: 1, unit_price: 500 }],
    p_start_at: startAt,
    p_customer_name: input.customerName,
    p_customer_phone: phone,
    p_notes: notes,
    p_customer_notes: customerNotes,
    p_customer_address: address,
    p_assistant_staff_ids: input.assistantIds ?? [],
    p_payment_method_id: m.paymentMethodId,
  });
  const id = (must(`建立預約「${input.customerName}」`, res.data, res.error) as { id: string }).id;
  return { id, customerName: input.customerName, startAt, staffId: input.staffId };
}

/** 以商家管理員身分改單(update_booking,全欄位照原樣帶,只換助手名單)。 */
export async function adminSetAssistants(
  fixture: LiveSyncFixture,
  m: LiveSyncMerchant,
  booking: CreatedBooking,
  assistantIds: string[],
): Promise<void> {
  const [notes, customerNotes, address, phone] = fixture.secrets as [
    string,
    string,
    string,
    string,
  ];
  const res = await m.admin.rpc("update_booking", {
    p_booking_id: booking.id,
    p_staff_id: booking.staffId,
    p_service_items: [{ service_item_id: m.serviceItemId, quantity: 1, unit_price: 500 }],
    p_start_at: booking.startAt,
    p_customer_name: booking.customerName,
    p_customer_phone: phone,
    p_notes: notes,
    p_customer_notes: customerNotes,
    p_customer_address: address,
    p_assistant_staff_ids: assistantIds,
    p_payment_method_id: m.paymentMethodId,
  });
  if (res.error) throw new Error(`改助手失敗(${booking.customerName}):${res.error.message}`);
}

/** 以商家管理員身分呼叫一支只需要 booking id(+ 選填參數)的 RPC。 */
export async function adminRpc(
  m: LiveSyncMerchant,
  fn: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await m.admin.rpc(fn, args);
  if (res.error) throw new Error(`${fn} 失敗:${res.error.message}`);
  return res.data;
}

/** E11:以 service_role 切換某位服務人員的行事曆檢視權限,並讀回確認。 */
export async function setCalendarView(staffId: string, granted: boolean): Promise<void> {
  const svc = serviceClient();
  const r = await svc
    .from("merchant_staff_permissions")
    .update({ granted })
    .eq("staff_id", staffId)
    .eq("section_key", "staff_calendar_view")
    .select("granted");
  const rows = must("切換行事曆檢視權限", r.data, r.error) as { granted: boolean }[];
  if (rows.length !== 1 || rows[0]!.granted !== granted) {
    throw new Error(`切換行事曆檢視權限結果不對:${JSON.stringify(rows)}`);
  }
}

/** 把某位使用者的真實 session 灌進瀏覽器 localStorage(本機的 storage key 用本機網址現算)。 */
export async function injectSession(page: Page, session: Session): Promise<void> {
  const key = localAuthStorageKey(readLocalSupabaseTarget().url);
  await page.addInitScript(
    ([k, v]) => {
      window.localStorage.setItem(k, v);
    },
    [key, JSON.stringify(session)] as [string, string],
  );
}

/** 硬刪除本次建立的一切(兩間商家、兩個集團、五個帳號)。三段:① 核對範圍 ② 依外鍵順序刪 ③ 刪後查 0。 */
export async function teardownLiveSyncFixture(fixture: LiveSyncFixture): Promise<string[]> {
  const svc = serviceClient();
  const actions: string[] = [];
  const merchantsIn = [fixture.m1, fixture.m2];
  const groupIds = merchantsIn.map((m) => m.groupId);

  // ① 核對範圍(先 SELECT,任何一筆對不上就整個不刪)
  const merchants = await svc.from("merchants").select("id,name,group_id").in("group_id", groupIds);
  if (merchants.error) throw new Error(`teardown 查商家失敗:${merchants.error.message}`);
  const merchantRows = (merchants.data ?? []) as { id: string; name: string; group_id: string }[];
  const foreign = merchantRows.filter((m) => !m.name.startsWith(MERCHANT_NAME_PREFIX));
  const missing = merchantsIn.filter((m) => !merchantRows.some((r) => r.id === m.merchantId));
  if (foreign.length > 0 || missing.length > 0) {
    throw new Error(
      `teardown 中止:集團底下有不是本 fixture 建立的商家(${foreign.map((m) => m.name).join("、")})` +
        `或找不到本 fixture 的商家(${missing.length} 間),不刪任何東西`,
    );
  }
  const userIds = [
    fixture.m1.adminUserId,
    fixture.m2.adminUserId,
    fixture.staffA.userId,
    fixture.staffB.userId,
    fixture.staffE.userId,
  ];
  for (const id of userIds) {
    const u = await svc.auth.admin.getUserById(id);
    const email = u.data.user?.email ?? "";
    if (u.error || !EMAIL_PATTERN.test(email)) {
      throw new Error(
        `teardown 中止:使用者 ${id.slice(0, 8)} 不是本 fixture 建立的帳號(${email}),不刪任何東西`,
      );
    }
  }
  const merchantIds = merchantRows.map((m) => m.id);
  const bookingCount = await svc
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .in("merchant_id", merchantIds);
  actions.push(
    `核對通過:商家 ${merchantIds.length} 間、帳號 ${userIds.length} 個、預約 ${bookingCount.count ?? "?"} 筆,都是本次 fixture 建立的`,
  );

  // ② 依外鍵順序硬刪除(同 calendar-gesture-fixture:抽成快照 → 訂單 → 會員 → 商家(其餘子表 cascade)→ 集團 → 帳號)
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
    ["集團", () => svc.from("groups").delete().in("id", groupIds).select("id")],
  ];
  for (const [label, run] of steps) {
    const r = await run();
    if (r.error) throw new Error(`teardown 刪${label}失敗:${r.error.message}`);
    actions.push(`已硬刪除${label} ${r.data?.length ?? 0} 筆`);
  }
  for (const id of userIds) {
    const r = await svc.auth.admin.deleteUser(id);
    if (r.error) throw new Error(`teardown 刪帳號失敗:${r.error.message}`);
  }
  actions.push(`已硬刪除 auth 帳號 ${userIds.length} 個`);

  // ③ 刪後核對:全部歸 0
  const count = async (table: string, column: string, values: string[]) => {
    const r = await svc.from(table).select("id", { count: "exact", head: true }).in(column, values);
    if (r.error) throw new Error(`teardown 核對 ${table} 失敗:${r.error.message}`);
    return r.count ?? 0;
  };
  const left = {
    merchants: await count("merchants", "id", merchantIds),
    groups: await count("groups", "id", groupIds),
    bookings: await count("bookings", "merchant_id", merchantIds),
    members: await count("members", "merchant_id", merchantIds),
    staff: await count("merchant_staff", "merchant_id", merchantIds),
    serviceItems: await count("service_items", "merchant_id", merchantIds),
  };
  let usersLeft = 0;
  for (const id of userIds) {
    const r = await svc.auth.admin.getUserById(id);
    if (r.data.user) usersLeft += 1;
  }
  const total = Object.values(left).reduce((a, b) => a + b, 0) + usersLeft;
  if (total !== 0) {
    throw new Error(`teardown 後仍有殘留:${JSON.stringify({ ...left, users: usersLeft })}`);
  }
  actions.push("刪後核對:商家 / 集團 / 訂單 / 會員 / 服務人員 / 服務項目 / 帳號 全部 0");

  // ④ 本次三位服務人員頻道的訊號列(realtime.messages)。先 SELECT 同一個條件,刪完再查一次必須為 0。
  const staffIds = [fixture.staffA.staffId, fixture.staffB.staffId, fixture.staffE.staffId];
  if (staffIds.some((id) => !UUID_RE.test(id))) throw new Error("teardown 中止:staff id 格式不對");
  const topicList = staffIds.map((id) => `'${staffScheduleTopic(id)}'`).join(", ");
  const where = `topic in (${topicList})`;
  const signalRows = psqlLocal(`select count(*) from realtime.messages where ${where};`);
  psqlLocal(`delete from realtime.messages where ${where};`);
  const signalLeft = psqlLocal(`select count(*) from realtime.messages where ${where};`);
  if (signalLeft !== "0") throw new Error(`teardown 後 realtime.messages 仍有 ${signalLeft} 列`);
  actions.push(`已硬刪除本次頻道的訊號列(realtime.messages)${signalRows} 列,刪後 0 列`);

  // ⑤ SPECS-INDEX #1003(第 14 批)起,訂單 / 時段變動也會對商家行事曆頻道 merchant:<id>:calendar 發訊號
  //    ⇒ 本次所有商家(含同集團開的分店)的那幾列也一併清掉,同樣先查、刪、再查必須為 0。
  if (merchantIds.some((id) => !UUID_RE.test(id)))
    throw new Error("teardown 中止:merchant id 格式不對");
  const merchantWhere = `topic in (${merchantIds.map((id) => `'merchant:${id.toLowerCase()}:calendar'`).join(", ")})`;
  const merchantSignalRows = psqlLocal(
    `select count(*) from realtime.messages where ${merchantWhere};`,
  );
  psqlLocal(`delete from realtime.messages where ${merchantWhere};`);
  const merchantSignalLeft = psqlLocal(
    `select count(*) from realtime.messages where ${merchantWhere};`,
  );
  if (merchantSignalLeft !== "0") {
    throw new Error(`teardown 後 realtime.messages 商家頻道仍有 ${merchantSignalLeft} 列`);
  }
  actions.push(`已硬刪除本次商家行事曆頻道的訊號列 ${merchantSignalRows} 列,刪後 0 列`);
  return actions;
}
