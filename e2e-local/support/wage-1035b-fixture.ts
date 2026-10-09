// #1035 彈性計薪 B 批(日薪／時薪制)的本機 e2e fixture。
// 規格書:母版 .project/specs/彈性計薪.md 第七節 PT e2e-local(B)。
// 只在 playwright.local.config.ts 底下用(`npm run test:e2e:local`),只連本機 Docker 的 Supabase。
//
// 寫法比照 e2e-local/support/bonus-1035a-fixture.ts:
//   ・網址 / 金鑰一律取自 readLocalSupabaseTarget()(本機),不讀 `.env`;Node 端 fetch 已被 config 鎖成只准打本機。
//   ・業務資料以商家管理員身分走前端同一組 RPC / 表格;service_role 只用在開通服務人員登入、查核與 teardown。
//   ・「歷史往前挪」與「用固定時間跑凍結」只能直接動資料庫(本機 docker psql,前面有本機目標檢查):
//       moveWageHistoryBack()   把這位服務人員的薪資歷史收成一列、effective_from 往前挪 40 天
//                               (模擬「40 天前就是時薪制、時薪 200」,過去的日子才算得到錢)
//       runFreezeWorkDays()     呼叫 private.freeze_work_days()(排程那支;authenticated 不能呼叫)
//
// 一間商家、一個管理員、一位服務人員 H(一開始是抽成制,測試裡改成時薪制;可登入、可看自己的薪資報表);
// 營業時間每天 08:00~21:00;H 每週時段每天 10:00~12:00(⇒ 時薪 200 時每天 400 元)。
//
// teardown:service_role 硬刪除。刪前 SELECT 核對(商家名稱是本 fixture 前綴、帳號 email 是本 fixture 格式,
// 對不上就整個不刪),刪後再 SELECT 一次全部必須為 0(含工資兩張表);即時訊號列一併清掉。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { buildFetch } from "../../e2e/support/fixture-supabase-client";
import { staffScheduleTopic } from "../../src/modules/staff-portal/staffScheduleChannel";
import { localAuthStorageKey, readLocalSupabaseTarget } from "./local-target";

export const MERCHANT_NAME_PREFIX = "E2E彈性計薪B批本機測試商家";
const EMAIL_PATTERN = /^e2e-b1035b-(admin|staff)-\d+@example-local-test\.test$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Wage1035bFixture {
  runId: string;
  merchantId: string;
  groupId: string;
  admin: SupabaseClient;
  adminSession: Session;
  staffSession: Session;
  staffId: string;
  staffName: string;
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

export function psqlLocal(sql: string): string {
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
  const email = `e2e-b1035b-${role}-${runId}@example-local-test.test`;
  const r = await anonClient().auth.signUp({ email, password });
  const session = must(`建立帳號(${role})`, r.data.session, r.error);
  return { session, userId: session.user.id, email };
}

export async function setupWage1035bFixture(): Promise<Wage1035bFixture> {
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const password = `E2eB1035b!${runId}Aa`;
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
    p_address: "E2E彈性計薪B批測試商家地址",
    p_contact_email: adminUser.email,
    p_intro: "#1035 B 批本機 e2e 測試商家,測試完硬刪除。",
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

  // 服務人員 H:先建成抽成制(測試 B1 在畫面上改成時薪制)。
  const staffName = `E2E時薪服務人員${runId.slice(-4)}`;
  const staffRes = await admin
    .from("merchant_staff")
    .insert({ merchant_id: merchantId, name: staffName, phone: phone(1), is_listed: true })
    .select("id")
    .single();
  const staffId = must("建立服務人員", staffRes.data, staffRes.error).id as string;
  const windowsRes = await admin.from("staff_availability_windows").insert(
    Array.from({ length: 7 }, (_, d) => ({
      staff_id: staffId,
      day_of_week: d,
      start_time: "10:00",
      end_time: "12:00",
    })),
  );
  if (windowsRes.error) throw new Error(`每週時段失敗:${windowsRes.error.message}`);

  const staffUser = await signUp(runId, "staff", password);
  const invite = await svc.rpc("record_invited_staff_login", {
    p_staff_id: staffId,
    p_user_id: staffUser.userId,
    p_invited_login_email: staffUser.email,
    p_login_status: "active",
  });
  if (invite.error) throw new Error(`開通服務人員登入失敗:${invite.error.message}`);
  for (const key of ["staff_payroll_view", "staff_availability_self_manage"]) {
    const perm = await admin.rpc("set_staff_permission", {
      p_staff_id: staffId,
      p_section_key: key,
      p_granted: true,
    });
    if (perm.error) throw new Error(`開服務人員權限 ${key} 失敗:${perm.error.message}`);
  }

  return {
    runId,
    merchantId,
    groupId,
    admin,
    adminSession: adminUser.session,
    staffSession: staffUser.session,
    staffId,
    staffName,
    userIds: [adminUser.userId, staffUser.userId],
  };
}

/** 把這位服務人員的薪資歷史收成「目前那一列」,effective_from 往前挪 40 天(只動本 fixture 的這一個人)。 */
export function moveWageHistoryBack(fixture: Wage1035bFixture): void {
  if (!UUID_RE.test(fixture.staffId)) throw new Error("staff id 格式不對");
  const where = `staff_id = '${fixture.staffId}' and merchant_id = '${fixture.merchantId}'`;
  // 核對:這個人在本 fixture 的商家底下,而且目前是時薪制。
  const check = psqlLocal(
    `select count(*) from public.merchant_staff ms join public.merchants m on m.id = ms.merchant_id
      where ms.id = '${fixture.staffId}' and m.name like '${MERCHANT_NAME_PREFIX}%' and ms.compensation_type = 'hourly_wage';`,
  );
  if (check !== "1") throw new Error(`moveWageHistoryBack 中止:核對不通過(${check})`);
  psqlLocal(
    `begin;
     delete from public.staff_payroll_status_history where ${where} and effective_to is not null;
     update public.staff_payroll_status_history set effective_from = now() - interval '40 days' where ${where};
     commit;`,
  );
}

/** 跑一次每天凌晨的凍結排程(private.freeze_work_days,台北今天),回傳這個人目前有幾筆上工紀錄。 */
export function runFreezeWorkDays(fixture: Wage1035bFixture): number {
  psqlLocal("select private.freeze_work_days();");
  return Number(
    psqlLocal(
      `select count(*) from public.staff_work_day_records where staff_id = '${fixture.staffId}';`,
    ),
  );
}

export function workDayRecord(fixture: Wage1035bFixture, date: string): string {
  return psqlLocal(
    `select concat_ws('/', worked_minutes, pay_amount, coalesce(refrozen_reason, '-'))
       from public.staff_work_day_records where staff_id = '${fixture.staffId}' and work_date = '${date}';`,
  );
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

export async function teardownWage1035bFixture(fixture: Wage1035bFixture): Promise<string[]> {
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

  // ② 依外鍵順序硬刪除(工資兩張表跟著服務人員 / 商家 on delete cascade)
  const m = [fixture.merchantId];
  const steps: [
    string,
    () => PromiseLike<{ error: { message: string } | null; data: unknown[] | null }>,
  ][] = [
    [
      "LINE 發送記錄",
      () => svc.from("line_notification_log").delete().in("merchant_id", m).select("id"),
    ],
    [
      "請假紀錄",
      () => svc.from("staff_leave_records").delete().eq("staff_id", fixture.staffId).select("id"),
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
    (await count("staff_wage_settings", "merchant_id", fixture.merchantId)) +
    (await count("staff_work_day_records", "merchant_id", fixture.merchantId)) +
    (await count("staff_payroll_status_history", "merchant_id", fixture.merchantId));
  let usersLeft = 0;
  for (const id of fixture.userIds) {
    const r = await svc.auth.admin.getUserById(id);
    if (r.data.user) usersLeft += 1;
  }
  if (left + usersLeft !== 0)
    throw new Error(`teardown 後仍有殘留:${left} 列資料、${usersLeft} 個帳號`);
  actions.push(
    "刪後核對:商家 / 集團 / 訂單 / 服務人員 / 工資設定 / 上工紀錄 / 薪資歷史 / 帳號 全部 0",
  );

  // ④ 即時訊號列(服務人員頻道 + 商家頻道)
  const where = `topic in ('${staffScheduleTopic(fixture.staffId)}', 'merchant:${fixture.merchantId}:calendar')`;
  const before = psqlLocal(`select count(*) from realtime.messages where ${where};`);
  psqlLocal(`delete from realtime.messages where ${where};`);
  const after = psqlLocal(`select count(*) from realtime.messages where ${where};`);
  if (after !== "0") throw new Error(`teardown 後 realtime.messages 仍有 ${after} 列`);
  actions.push(`已硬刪除本次頻道的訊號列 ${before} 列,刪後 0 列`);
  return actions;
}
