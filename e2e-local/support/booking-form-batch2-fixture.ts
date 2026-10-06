// 「建單畫面與下拉刷新 第 2 批」(#979 / #980 / #982)的本機 e2e fixture。
// 規格書:.project/specs/建單畫面與下拉刷新-第2批.md 第四節第 3 點。
// 只在 playwright.local.config.ts 底下用(`npm run test:e2e:local`),只連本機 Docker 的 Supabase。
//
// 寫法比照 e2e-local/support/calendar-gesture-fixture.ts:
//   ・網址 / 金鑰一律取自 readLocalSupabaseTarget()(本機),不讀 `.env`。
//   ・業務資料走前端同一組 RPC / 表格,以商家管理員身分建立;service_role 只用在查核與 teardown。
//
// 一間商家(一個管理員帳號、一個集團):
//   營業時間:七天都 09:00~23:59(#980 QA:要能測到「結束時間落在 23:30~24:00」的 45 分鐘單)
//   分類:「E2E批2壁掛」「E2E批2吊隱」;各一個 60 分鐘的服務項目(2200 / 3500 元)
//   服務人員甲:沒有「無時段限制」、也沒有「後台無時段限制」;每週時段七天都 10:00~16:00;
//              D(明天)12:00~12:30 單日排休;D+1 整天請假(特休)
//   服務人員乙:無時段限制(= 營業時間),給手機下拉刷新 / 行事曆拖拉用
//              #977 第 3 批(2026-10-06):no_time_slot_limit 後台不再看 ⇒ 改成「每週時段七天都 00:00~24:00」,
//              跟商家營業時間取交集後 = 營業時間,判斷結果跟改前一模一樣(不改用 unlimited_backend_edit,
//              因為那個會連營業時間都略過,時間清單會變成 00:00~23:30,跟這支測試要驗的不同)。
//   日期:D = 台北的「明天」;D+3 給建單送出用;D+4 給手機組用(各自錯開,不會互相撞時段)
//
// teardown:service_role 硬刪除。刪前 SELECT 核對(集團底下商家名稱是本 fixture 前綴、帳號 email 是本 fixture
// 格式,對不上就整個不刪),刪後再 SELECT 一次全部必須為 0。
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

export const MERCHANT_NAME_PREFIX = "E2E建單第2批本機測試商家";
export const CATEGORY_WALL = "E2E批2壁掛";
export const CATEGORY_DUCT = "E2E批2吊隱";
export const ITEM_WALL = "E2E批2壁掛清洗";
export const ITEM_DUCT = "E2E批2吊隱清洗";
/** 45 分鐘(非 30 倍數)項目,#980 QA 打回補測。 */
export const ITEM_QUICK = "E2E批2快速保養45分";
export const STAFF_A = "E2E批2服務人員甲";
export const STAFF_B = "E2E批2服務人員乙";
const EMAIL_PATTERN = /^e2e-bookform2-\d+@example-local-test\.test$/;

export interface BookingFormBatch2Fixture {
  runId: string;
  merchantId: string;
  groupId: string;
  userId: string;
  adminSession: Session;
  /** 管理員身分的 client(模擬「另一個 session」新增訂單用)。 */
  admin: SupabaseClient;
  staffAId: string;
  staffBId: string;
  itemWallId: string;
  itemDuctId: string;
  paymentMethodId: string;
  /** 明天(甲 12:00 單日排休)。 */
  dateD: string;
  /** D+1(甲整天請假)。 */
  dateLeave: string;
  /** D+3(建單送出用)。 */
  dateCreate: string;
  /** D+4(手機組用)。 */
  dateMobile: string;
  leaveTypeName: string;
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

export async function setupBookingFormBatch2Fixture(): Promise<BookingFormBatch2Fixture> {
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const seed = Number(runId.slice(-7)) * 10;
  const email = `e2e-bookform2-${runId}@example-local-test.test`;
  const password = `E2eBookForm2!${runId}Aa`;
  const admin = makeClient(readLocalSupabaseTarget().publishableKey);
  const signUp = await admin.auth.signUp({ email, password });
  const adminSession = must("建立管理員帳號", signUp.data.session, signUp.error);
  const userId = must("取得管理員 id", signUp.data.user?.id, null);

  const merchantRes = await admin.rpc("create_group_and_merchant", {
    p_name: `${MERCHANT_NAME_PREFIX}${runId}`,
    p_industry_type: "in_store_beauty",
    p_contact_email: email,
    p_intro: "建單畫面與下拉刷新第 2 批本機 e2e 測試商家,測試完硬刪除。",
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
      open_time: "09:00",
      close_time: "23:59",
    })),
    { onConflict: "merchant_id,day_of_week" },
  );
  if (hoursRes.error) throw new Error(`營業時間失敗:${hoursRes.error.message}`);

  const catRes = await admin
    .from("service_categories")
    .insert([
      { merchant_id: merchantId, name: CATEGORY_WALL },
      { merchant_id: merchantId, name: CATEGORY_DUCT },
    ])
    .select("id,name");
  const cats = must("建立分類", catRes.data, catRes.error) as { id: string; name: string }[];
  const catId = (name: string) => cats.find((c) => c.name === name)!.id;

  const itemRes = await admin
    .from("service_items")
    .insert([
      {
        merchant_id: merchantId,
        name: ITEM_WALL,
        price: 2200,
        item_type: "primary",
        duration_minutes: 60,
        category_id: catId(CATEGORY_WALL),
      },
      {
        merchant_id: merchantId,
        name: ITEM_DUCT,
        price: 3500,
        item_type: "primary",
        duration_minutes: 60,
        category_id: catId(CATEGORY_DUCT),
      },
      {
        merchant_id: merchantId,
        name: ITEM_QUICK,
        price: 800,
        item_type: "primary",
        duration_minutes: 45,
        category_id: catId(CATEGORY_WALL),
      },
    ])
    .select("id,name");
  const items = must("建立服務項目", itemRes.data, itemRes.error) as { id: string; name: string }[];
  const itemWallId = items.find((i) => i.name === ITEM_WALL)!.id;
  const itemDuctId = items.find((i) => i.name === ITEM_DUCT)!.id;

  // 甲要登記請假 ⇒ 必須是月薪制(create_staff_leave 只收月薪制的服務人員)。
  async function addStaff(
    name: string,
    noLimit: boolean,
    n: number,
    monthly = false,
  ): Promise<string> {
    const digits = String((seed + n) % 100_000_000).padStart(8, "0");
    const r = await admin
      .from("merchant_staff")
      .insert({
        merchant_id: merchantId,
        name,
        phone: `09${digits}`,
        is_listed: true,
        no_time_slot_limit: noLimit,
        unlimited_backend_edit: false,
        ...(monthly ? { compensation_type: "monthly_salary" } : {}),
      })
      .select("id")
      .single();
    return must(`建立服務人員 ${name}`, r.data, r.error).id as string;
  }
  const staffAId = await addStaff(STAFF_A, false, 1, true);
  const staffBId = await addStaff(STAFF_B, true, 2);
  const fullDayRes = await admin.from("staff_availability_windows").insert(
    Array.from({ length: 7 }, (_, d) => ({
      staff_id: staffBId,
      day_of_week: d,
      start_time: "00:00",
      end_time: "24:00",
    })),
  );
  if (fullDayRes.error) throw new Error(`乙的全天每週時段失敗:${fullDayRes.error.message}`);

  const winRes = await admin.from("staff_availability_windows").insert(
    Array.from({ length: 7 }, (_, d) => ({
      staff_id: staffAId,
      day_of_week: d,
      start_time: "10:00",
      end_time: "16:00",
    })),
  );
  if (winRes.error) throw new Error(`每週時段失敗:${winRes.error.message}`);

  const today = getTaipeiNow();
  const dateD = toDateKey(addDays(today, 1));
  const dateLeave = toDateKey(addDays(today, 2));
  const dateCreate = toDateKey(addDays(today, 4));
  const dateMobile = toDateKey(addDays(today, 5));

  const ovRes = await admin.rpc("set_staff_day_override", {
    p_staff_id: staffAId,
    p_override_date: dateD,
    p_start_time: "12:00",
    p_end_time: "12:30",
    p_is_available: false,
  });
  if (ovRes.error) throw new Error(`單日排休失敗:${ovRes.error.message}`);

  const ltRes = await admin
    .from("merchant_leave_types")
    .select("id,name")
    .eq("merchant_id", merchantId)
    .order("name")
    .limit(1)
    .single();
  const leaveType = must("查假別", ltRes.data, ltRes.error) as { id: string; name: string };
  const leaveRes = await admin.rpc("create_staff_leave", {
    p_staff_id: staffAId,
    p_leave_type_id: leaveType.id,
    p_start_date: dateLeave,
    p_end_date: dateLeave,
    p_confirm_despite_conflicts: false,
  });
  if (leaveRes.error) throw new Error(`請假失敗:${leaveRes.error.message}`);

  const pmRes = await admin
    .from("payment_methods")
    .select("id")
    .eq("merchant_id", merchantId)
    .eq("status", "active")
    .limit(1)
    .single();
  const paymentMethodId = must("查付款方式", pmRes.data, pmRes.error).id as string;

  return {
    runId,
    merchantId,
    groupId,
    userId,
    adminSession,
    admin,
    staffAId,
    staffBId,
    itemWallId,
    itemDuctId,
    paymentMethodId,
    dateD,
    dateLeave,
    dateCreate,
    dateMobile,
    leaveTypeName: leaveType.name,
  };
}

/** 以管理員身分建一筆已確認的預約(模擬「另一個 session」新增訂單)。 */
export async function createBookingAsAdmin(
  fixture: BookingFormBatch2Fixture,
  input: { staffId: string; dateKey: string; time: string; customerName: string },
): Promise<string> {
  const res = await fixture.admin.rpc("create_booking", {
    p_merchant_id: fixture.merchantId,
    p_staff_id: input.staffId,
    p_service_items: [{ service_item_id: fixture.itemWallId, quantity: 1, unit_price: 2200 }],
    p_start_at: buildTaipeiIso(input.dateKey, input.time),
    p_customer_name: input.customerName,
    p_customer_phone: `09${String((Number(fixture.runId.slice(-7)) * 10 + 77) % 100_000_000).padStart(8, "0")}`,
    p_assistant_staff_ids: [],
    p_payment_method_id: fixture.paymentMethodId,
  });
  const id = (must(`建立預約「${input.customerName}」`, res.data, res.error) as { id: string }).id;
  const confirm = await fixture.admin.rpc("confirm_booking", { p_booking_id: id });
  if (confirm.error) throw new Error(`確認預約失敗:${confirm.error.message}`);
  return id;
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

export async function teardownBookingFormBatch2Fixture(
  fixture: BookingFormBatch2Fixture,
): Promise<string[]> {
  const svc = serviceClient();
  const actions: string[] = [];

  // ① 核對範圍
  const merchants = await svc
    .from("merchants")
    .select("id,name,group_id")
    .eq("group_id", fixture.groupId);
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
  const u = await svc.auth.admin.getUserById(fixture.userId);
  const email = u.data.user?.email ?? "";
  if (u.error || !EMAIL_PATTERN.test(email)) {
    throw new Error(`teardown 中止:使用者不是本 fixture 建立的帳號(${email}),不刪任何東西`);
  }
  const merchantIds = [fixture.merchantId];
  const staffIds = [fixture.staffAId, fixture.staffBId];
  const bookingCount = await svc
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .in("merchant_id", merchantIds);
  actions.push(
    `核對通過:商家 1 間、帳號 1 個、預約 ${bookingCount.count ?? "?"} 筆,都是本次 fixture 建立的`,
  );

  // ② 依外鍵順序硬刪除
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
    [
      "請假紀錄",
      () => svc.from("staff_leave_records").delete().in("staff_id", staffIds).select("id"),
    ],
    ["商家", () => svc.from("merchants").delete().in("id", merchantIds).select("id")],
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
  const count = async (table: string, column: string, values: string[]) => {
    const r = await svc.from(table).select("id", { count: "exact", head: true }).in(column, values);
    if (r.error) throw new Error(`teardown 核對 ${table} 失敗:${r.error.message}`);
    return r.count ?? 0;
  };
  const left =
    (await count("merchants", "id", merchantIds)) +
    (await count("groups", "id", [fixture.groupId])) +
    (await count("bookings", "merchant_id", merchantIds)) +
    (await count("merchant_staff", "merchant_id", merchantIds)) +
    (await count("service_items", "merchant_id", merchantIds)) +
    (await count("service_categories", "merchant_id", merchantIds)) +
    (await count("staff_leave_records", "staff_id", staffIds));
  const userLeft = (await svc.auth.admin.getUserById(fixture.userId)).data.user ? 1 : 0;
  if (left + userLeft !== 0) throw new Error(`teardown 後仍有殘留 ${left + userLeft} 筆`);
  actions.push("刪後核對:商家 / 集團 / 訂單 / 服務人員 / 服務項目 / 分類 / 請假 / 帳號 全部 0");
  return actions;
}
