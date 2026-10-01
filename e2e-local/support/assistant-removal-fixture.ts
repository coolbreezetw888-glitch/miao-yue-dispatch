// SPECS-INDEX #873「移除協助人員不該連主服務人員的訂單一起取消」的本機 e2e fixture。
// 只在 playwright.local.config.ts 底下用(`npm run test:e2e:local`),只連本機 Docker 的 Supabase。
//
// 寫法比照 e2e-local/support/calendar-gesture-fixture.ts:
//   ・網址 / 金鑰一律取自 readLocalSupabaseTarget()(本機);Node 端 fetch 已被 config 鎖成只准打本機。
//   ・業務資料走前端同一組 RPC / 表格,以商家管理員身分建立;service_role 只用在查核與 teardown。
//
// 一間商家、4 位服務人員(S1~S4),預約一律排在台北的「明天」:
//   R1:S1 主 + S2 協助,10:00,已確認 —— E1(從協助卡移除 → 維持現狀)
//   R2:S1 主 + S3 協助,13:00,已確認 —— E2(從協助卡移除 → 再加助手)
//   R3:S4 主 + S3 協助,16:00,已確認 —— E3(主服務人員 S4 被移除 → S3 的協助卡要消失)
//
// teardown:service_role 硬刪除。刪前 SELECT 核對(商家名稱前綴、帳號 email 格式),刪後再 SELECT 全部為 0。
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { buildFetch } from "../../e2e/support/fixture-supabase-client";
import {
  addDays,
  buildTaipeiIso,
  getTaipeiNow,
  toDateKey,
} from "../../src/modules/booking/dateUtils";
import { localAuthStorageKey, readLocalSupabaseTarget } from "./local-target";

export const MERCHANT_NAME_PREFIX = "E2E協助人員移除本機測試商家";
export const STAFF_NAME_PREFIX = "E2E873服務人員";
const EMAIL_PATTERN = /^e2e-req873-\d+@example-local-test\.test$/;

export interface AssistantRemovalBooking {
  id: string;
  customerName: string;
  primaryStaffId: string;
  assistantStaffId: string;
}

export interface AssistantRemovalFixture {
  runId: string;
  dateKey: string;
  merchantId: string;
  groupId: string;
  userId: string;
  adminSession: Session;
  staffIds: string[];
  staffNames: string[];
  bookings: {
    r1: AssistantRemovalBooking;
    r2: AssistantRemovalBooking;
    r3: AssistantRemovalBooking;
  };
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

export async function setupAssistantRemovalFixture(): Promise<AssistantRemovalFixture> {
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const seed = Number(runId.slice(-7)) * 10;
  const email = `e2e-req873-${runId}@example-local-test.test`;
  const password = `E2eReq873!${runId}Aa`;
  const admin = makeClient(readLocalSupabaseTarget().publishableKey);
  const signUp = await admin.auth.signUp({ email, password });
  const adminSession = must("建立管理員帳號", signUp.data.session, signUp.error);
  const userId = must("取得管理員 id", signUp.data.user?.id, null);

  const merchantRes = await admin.rpc("create_group_and_merchant", {
    p_name: `${MERCHANT_NAME_PREFIX}${runId}`,
    p_industry_type: "in_store_beauty",
    p_contact_email: email,
    p_intro: "#873 協助人員移除本機 e2e 測試商家,測試完硬刪除。",
  });
  const merchantId = must("建立測試商家", merchantRes.data as string | null, merchantRes.error);
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
      name: "E2E873測試服務60分",
      price: 500,
      item_type: "primary",
      duration_minutes: 60,
    })
    .select("id")
    .single();
  const serviceItemId = must("建立服務項目", itemRes.data, itemRes.error).id as string;

  const staffIds: string[] = [];
  const staffNames: string[] = [];
  for (let n = 1; n <= 4; n++) {
    const name = `${STAFF_NAME_PREFIX}${n}`;
    const digits = String((seed + n) % 100_000_000).padStart(8, "0");
    const staffRes = await admin
      .from("merchant_staff")
      .insert({
        merchant_id: merchantId,
        name,
        phone: `09${digits}`,
        is_listed: true,
        no_time_slot_limit: true,
        unlimited_backend_edit: true,
      })
      .select("id")
      .single();
    staffIds.push(must(`建立服務人員 ${name}`, staffRes.data, staffRes.error).id as string);
    staffNames.push(name);
  }

  const pmRes = await admin
    .from("payment_methods")
    .select("id")
    .eq("merchant_id", merchantId)
    .eq("status", "active")
    .limit(1)
    .single();
  const paymentMethodId = must("查付款方式", pmRes.data, pmRes.error).id as string;

  const dateKey = toDateKey(addDays(getTaipeiNow(), 1));

  async function book(
    primaryIndex: number,
    assistantIndex: number,
    startTime: string,
    customerName: string,
    phoneOffset: number,
  ): Promise<AssistantRemovalBooking> {
    const primaryStaffId = staffIds[primaryIndex] as string;
    const assistantStaffId = staffIds[assistantIndex] as string;
    const res = await admin.rpc("create_booking", {
      p_merchant_id: merchantId,
      p_staff_id: primaryStaffId,
      p_service_items: [{ service_item_id: serviceItemId, quantity: 1, unit_price: 500 }],
      p_start_at: buildTaipeiIso(dateKey, startTime),
      p_customer_name: customerName,
      p_customer_phone: `09${String((seed + 90 + phoneOffset) % 100_000_000).padStart(8, "0")}`,
      p_assistant_staff_ids: [assistantStaffId],
      p_payment_method_id: paymentMethodId,
    });
    const id = (must(`建立預約「${customerName}」`, res.data, res.error) as { id: string }).id;
    const confirm = await admin.rpc("confirm_booking", { p_booking_id: id });
    if (confirm.error) throw new Error(`確認預約「${customerName}」失敗:${confirm.error.message}`);
    return { id, customerName, primaryStaffId, assistantStaffId };
  }

  const r1 = await book(0, 1, "10:00", "E2E873客戶R1", 1);
  const r2 = await book(0, 2, "13:00", "E2E873客戶R2", 2);
  const r3 = await book(3, 2, "16:00", "E2E873客戶R3", 3);

  // 前提核對(service_role 讀實際資料庫)。
  for (const b of [r1, r2, r3]) {
    const row = await readBookingState(b.id);
    if (row.status !== "accepted" || row.assistantStaffIds.join() !== b.assistantStaffId) {
      throw new Error(`fixture 前提不對:${b.customerName} ${JSON.stringify(row)}`);
    }
  }

  return {
    runId,
    dateKey,
    merchantId,
    groupId,
    userId,
    adminSession,
    staffIds,
    staffNames,
    bookings: { r1, r2, r3 },
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

export interface BookingState {
  status: string;
  staffId: string;
  startAt: string;
  finalAmount: number | null;
  assistantStaffIds: string[];
}

export async function readBookingState(bookingId: string): Promise<BookingState> {
  const svc = serviceClient();
  const r = await svc
    .from("bookings")
    .select("status,staff_id,start_at,final_amount_snapshot")
    .eq("id", bookingId)
    .single();
  const row = must(`查預約 ${bookingId.slice(0, 8)}`, r.data, r.error) as {
    status: string;
    staff_id: string;
    start_at: string;
    final_amount_snapshot: number | null;
  };
  const a = await svc.from("booking_assistants").select("staff_id").eq("booking_id", bookingId);
  const assistants = must("查協助人員", a.data, a.error) as { staff_id: string }[];
  return {
    status: row.status,
    staffId: row.staff_id,
    startAt: row.start_at,
    finalAmount: row.final_amount_snapshot,
    assistantStaffIds: assistants.map((x) => x.staff_id).sort(),
  };
}

/** 跟前端 removeMerchantStaff 同一個寫法(商家管理員身分直接 update status,走 RLS)。 */
export async function removeStaffAsAdmin(
  fixture: AssistantRemovalFixture,
  staffId: string,
): Promise<void> {
  const client = makeClient(readLocalSupabaseTarget().publishableKey);
  const s = await client.auth.setSession({
    access_token: fixture.adminSession.access_token,
    refresh_token: fixture.adminSession.refresh_token,
  });
  if (s.error) throw new Error(`管理員登入失敗:${s.error.message}`);
  const r = await client
    .from("merchant_staff")
    .update({ status: "removed" })
    .eq("id", staffId)
    .select("id");
  if (r.error || (r.data ?? []).length !== 1) {
    throw new Error(`移除服務人員失敗:${r.error?.message ?? "沒有更新到任何一列"}`);
  }
}

export async function teardownAssistantRemovalFixture(
  fixture: AssistantRemovalFixture,
): Promise<string[]> {
  const svc = serviceClient();
  const actions: string[] = [];

  // ① 核對範圍
  const merchants = await svc.from("merchants").select("id,name").eq("group_id", fixture.groupId);
  if (merchants.error) throw new Error(`teardown 查商家失敗:${merchants.error.message}`);
  const rows = (merchants.data ?? []) as { id: string; name: string }[];
  if (
    rows.length !== 1 ||
    rows[0]?.id !== fixture.merchantId ||
    !rows[0].name.startsWith(MERCHANT_NAME_PREFIX)
  ) {
    throw new Error(
      `teardown 中止:集團底下的商家對不上本 fixture(${JSON.stringify(rows)}),不刪任何東西`,
    );
  }
  const u = await svc.auth.admin.getUserById(fixture.userId);
  if (u.error || !EMAIL_PATTERN.test(u.data.user?.email ?? "")) {
    throw new Error(
      `teardown 中止:帳號不是本 fixture 建立的(${u.data.user?.email ?? ""}),不刪任何東西`,
    );
  }
  actions.push("核對通過:商家 1 間、帳號 1 個,都是本次 fixture 建立的");

  // ② 硬刪除
  const steps: [
    string,
    () => PromiseLike<{ error: { message: string } | null; data: unknown[] | null }>,
  ][] = [
    [
      "抽成快照",
      () =>
        svc
          .from("booking_commission_records")
          .delete()
          .eq("merchant_id", fixture.merchantId)
          .select("id"),
    ],
    [
      "訂單",
      () => svc.from("bookings").delete().eq("merchant_id", fixture.merchantId).select("id"),
    ],
    ["會員", () => svc.from("members").delete().eq("merchant_id", fixture.merchantId).select("id")],
    ["商家", () => svc.from("merchants").delete().eq("id", fixture.merchantId).select("id")],
    ["集團", () => svc.from("groups").delete().eq("id", fixture.groupId).select("id")],
  ];
  for (const [label, run] of steps) {
    const r = await run();
    if (r.error) throw new Error(`teardown 刪${label}失敗:${r.error.message}`);
    actions.push(`已硬刪除${label} ${r.data?.length ?? 0} 筆`);
  }
  const del = await svc.auth.admin.deleteUser(fixture.userId);
  if (del.error) throw new Error(`teardown 刪帳號失敗:${del.error.message}`);
  actions.push("已硬刪除 auth 帳號 1 個");

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
    (await count("merchant_staff", "merchant_id", fixture.merchantId)) +
    ((await svc.auth.admin.getUserById(fixture.userId)).data.user ? 1 : 0);
  if (left !== 0) throw new Error(`teardown 後仍有殘留 ${left} 筆`);
  actions.push("刪後核對:商家 / 集團 / 訂單 / 服務人員 / 帳號 全部 0");
  return actions;
}
