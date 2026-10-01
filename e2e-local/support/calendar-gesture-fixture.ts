// #845「行事曆橫向捲動與手勢」的本機 e2e fixture(規格書 .project/specs/行事曆橫向捲動與手勢.md §7.2)。
// 只在 playwright.local.config.ts 底下用(`npm run test:e2e:local`),只連本機 Docker 的 Supabase。
//
// 寫法比照 e2e-local/support/bonus-fixture.ts:
//   ・網址 / 金鑰一律取自 readLocalSupabaseTarget()(本機),不讀 `.env`;Node 端 fetch 已被 config 鎖成只准打本機。
//   ・業務資料(商家、服務人員、服務項目、預約、確認 / 完成)走前端同一組 RPC / 表格,以商家管理員身分建立,
//     權限邊界照常生效;service_role 只用在「查核資料庫最終狀態」與 teardown 硬刪除。
//
// 兩間商家(各自一個管理員帳號、各自一個集團):
//   商家 A(多人):12 位服務人員。1280×800 下捲動容器約 1110px,內容 72 + 120×12 = 1512px ⇒ 一定要橫捲;
//     375px 手機更一定要捲。營業時間 08:00~21:00(26 格 × 30px = 780px,+ 名字列 36px > 70vh ⇒ 直向也要捲)。
//     預約一律排在「明天」(Asia/Taipei;避開「拖到過去時間」確認框,理由同 e2e/support/calendar-drag-fixture.ts 檔頭):
//       P1:第 1 位服務人員 10:00,已確認(可拖)—— T3 / T4 / T5(T5 會真的把它轉派給第 2 位)
//       P2:第 1 位服務人員 14:00,已完成(不可拖)—— T6、批次 2 的 D6
//       P3:第 3 位服務人員 10:00,已確認 —— 批次 2 的 D5 真的拖一次用(不跟 T5 共用,避免互相依賴)
//       第 2 位服務人員整天沒有任何預約(T5 轉派的目標欄,一定要空,否則被衝突檢查擋下)
//   商家 B(少人):2 位服務人員,給「放得下就不需要橫捲 / 不顯示滑軌與漸層」當對照。
//   每位服務人員都開 unlimited_backend_edit + no_time_slot_limit(比照舊 fixture,避免營業時間 / 時段擋拖拉;
//   「同一時段已有其他預約」的衝突檢查不在略過範圍內)。
//   每筆預約只掛一個 30 分鐘服務項目、沒有助手 ⇒ 每筆剛好一顆一格高的主色塊,座標最單純。
//
// teardown:service_role 硬刪除。刪前 SELECT 核對(集團底下商家名稱都是本 fixture 前綴、帳號 email 都是本 fixture
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

export const MERCHANT_NAME_PREFIX = "E2E行事曆手勢本機測試商家";
export const STAFF_NAME_PREFIX = "E2E手勢服務人員";
export const SERVICE_ITEM_NAME = "E2E手勢測試服務30分";
export const MANY_STAFF_COUNT = 12;
export const FEW_STAFF_COUNT = 2;
const EMAIL_PATTERN = /^e2e-calgesture-(many|few)-\d+@example-local-test\.test$/;

export interface GestureBooking {
  id: string;
  customerName: string;
  /** "HH:MM"(Asia/Taipei)。 */
  startTime: string;
  startAt: string;
  staffId: string;
}

export interface GestureMerchant {
  merchantId: string;
  groupId: string;
  adminSession: Session;
  userId: string;
  staffIds: string[];
  staffNames: string[];
  serviceItemId: string;
}

export interface CalendarGestureFixture {
  runId: string;
  /** 所有預約所在的日期(YYYY-MM-DD,台北的「明天」)。 */
  dateKey: string;
  many: GestureMerchant;
  few: GestureMerchant;
  bookings: {
    /** 第 1 位 10:00 已確認(可拖)。 */
    p1: GestureBooking;
    /** 第 1 位 14:00 已完成(不可拖)。 */
    p2: GestureBooking;
    /** 第 3 位 10:00 已確認(批次 2 D5 用)。 */
    p3: GestureBooking;
  };
}

function makeClient(key: string): SupabaseClient {
  const { url } = readLocalSupabaseTarget();
  return createClient(url, key, {
    global: { fetch: buildFetch(key) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function anonClient(): SupabaseClient {
  return makeClient(readLocalSupabaseTarget().publishableKey);
}

/** service_role(只存在本機)。只給查核資料庫最終狀態與 teardown 用。 */
export function serviceClient(): SupabaseClient {
  return makeClient(readLocalSupabaseTarget().serviceRoleKey);
}

function must<T>(label: string, data: T | null | undefined, error: { message: string } | null): T {
  if (error || data === null || data === undefined) {
    throw new Error(`${label}失敗:${error?.message ?? "沒有回傳資料"}`);
  }
  return data;
}

async function createMerchant(
  runId: string,
  kind: "many" | "few",
  staffCount: number,
  phoneSeed: number,
): Promise<{ merchant: GestureMerchant; admin: SupabaseClient; paymentMethodId: string }> {
  const email = `e2e-calgesture-${kind}-${runId}@example-local-test.test`;
  const password = `E2eCalGesture!${runId}Aa`;
  const admin = anonClient();
  const signUp = await admin.auth.signUp({ email, password });
  const adminSession = must(`建立管理員帳號(${kind})`, signUp.data.session, signUp.error);
  const userId = must(`取得管理員 id(${kind})`, signUp.data.user?.id, null);

  const merchantRes = await admin.rpc("create_group_and_merchant", {
    p_name: `${MERCHANT_NAME_PREFIX}${kind === "many" ? "多人" : "少人"}${runId}`,
    p_industry_type: "in_store_beauty",
    p_contact_email: email,
    p_intro: "#845 行事曆手勢本機 e2e 測試商家,測試完硬刪除。",
  });
  const merchantId = must(
    `建立測試商家(${kind})`,
    merchantRes.data as string | null,
    merchantRes.error,
  );

  const groupRow = await serviceClient()
    .from("merchants")
    .select("group_id")
    .eq("id", merchantId)
    .single();
  const groupId = must("查詢集團", groupRow.data, groupRow.error).group_id as string;

  // 七天都開 08:00-21:00:格線第 0 格 = 08:00,共 26 格;測試不依賴「明天剛好是星期幾」。
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

  const staffIds: string[] = [];
  const staffNames: string[] = [];
  for (let n = 1; n <= staffCount; n++) {
    // 名字放得下 120px 欄寬(名字列 truncate),序號放前面方便肉眼對照。
    const name = `${STAFF_NAME_PREFIX}${String(n).padStart(2, "0")}`;
    // merchant_staff.phone:NOT NULL + CHECK(^09\d{8}$);每位用不同尾碼。
    const digits = String((phoneSeed + n) % 100_000_000).padStart(8, "0");
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

  return {
    merchant: { merchantId, groupId, adminSession, userId, staffIds, staffNames, serviceItemId },
    admin,
    paymentMethodId,
  };
}

export async function setupCalendarGestureFixture(): Promise<CalendarGestureFixture> {
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const seed = Number(runId.slice(-7)) * 10;
  const many = await createMerchant(runId, "many", MANY_STAFF_COUNT, seed);
  const few = await createMerchant(runId, "few", FEW_STAFF_COUNT, seed + 50);

  const dateKey = toDateKey(addDays(getTaipeiNow(), 1));
  const customerPhone = `09${String((seed + 99) % 100_000_000).padStart(8, "0")}`;
  const { admin, merchant, paymentMethodId } = many;

  async function book(
    staffIndex: number,
    startTime: string,
    customerName: string,
    finalStatus: "accepted" | "completed",
  ): Promise<GestureBooking> {
    const staffId = merchant.staffIds[staffIndex] as string;
    const startAt = buildTaipeiIso(dateKey, startTime);
    const res = await admin.rpc("create_booking", {
      p_merchant_id: merchant.merchantId,
      p_staff_id: staffId,
      p_service_items: [{ service_item_id: merchant.serviceItemId, quantity: 1, unit_price: 500 }],
      p_start_at: startAt,
      p_customer_name: customerName,
      p_customer_phone: customerPhone,
      p_assistant_staff_ids: [],
      p_payment_method_id: paymentMethodId,
    });
    const id = (must(`建立預約「${customerName}」`, res.data, res.error) as { id: string }).id;
    const confirm = await admin.rpc("confirm_booking", { p_booking_id: id });
    if (confirm.error) throw new Error(`確認預約「${customerName}」失敗:${confirm.error.message}`);
    if (finalStatus === "completed") {
      const done = await admin.rpc("complete_booking", { p_booking_id: id });
      if (done.error) throw new Error(`完成預約「${customerName}」失敗:${done.error.message}`);
    }
    return { id, customerName, startTime, startAt, staffId };
  }

  const p1 = await book(0, "10:00", "E2E手勢客戶P1已確認", "accepted");
  const p2 = await book(0, "14:00", "E2E手勢客戶P2已完成", "completed");
  const p3 = await book(2, "10:00", "E2E手勢客戶P3已確認", "accepted");

  // 前提核對(用 service_role 讀實際資料庫,不信任上面的回傳值):狀態正確、第 2 位服務人員整天沒有預約。
  const svc = serviceClient();
  const rows = await svc
    .from("bookings")
    .select("id,status,staff_id")
    .eq("merchant_id", merchant.merchantId);
  const list = must("核對預約", rows.data, rows.error) as {
    id: string;
    status: string;
    staff_id: string;
  }[];
  const statusOf = (id: string) => list.find((r) => r.id === id)?.status;
  if (
    statusOf(p1.id) !== "accepted" ||
    statusOf(p3.id) !== "accepted" ||
    statusOf(p2.id) !== "completed"
  ) {
    throw new Error(`fixture 預約狀態不對:${JSON.stringify(list)}`);
  }
  if (list.some((r) => r.staff_id === merchant.staffIds[1])) {
    throw new Error("fixture 前提不成立:第 2 位服務人員應該整天沒有預約");
  }

  return { runId, dateKey, many: many.merchant, few: few.merchant, bookings: { p1, p2, p3 } };
}

/** 把某位管理員的真實 session 灌進瀏覽器 localStorage(本機的 storage key 用本機網址現算)。 */
export async function injectSession(page: Page, session: Session): Promise<void> {
  const key = localAuthStorageKey(readLocalSupabaseTarget().url);
  await page.addInitScript(
    ([k, v]) => {
      window.localStorage.setItem(k, v);
    },
    [key, JSON.stringify(session)] as [string, string],
  );
}

export interface BookingDbRow {
  staffId: string;
  startAtMs: number;
  status: string;
}

export async function readBooking(bookingId: string): Promise<BookingDbRow> {
  const r = await serviceClient()
    .from("bookings")
    .select("staff_id,start_at,status")
    .eq("id", bookingId)
    .single();
  const row = must(`查預約 ${bookingId.slice(0, 8)}`, r.data, r.error) as {
    staff_id: string;
    start_at: string;
    status: string;
  };
  return { staffId: row.staff_id, startAtMs: new Date(row.start_at).getTime(), status: row.status };
}

/** 硬刪除本次建立的一切(兩間商家、兩個集團、兩個帳號)。三段:① 核對範圍 ② 依外鍵順序刪 ③ 刪後查 0。 */
export async function teardownCalendarGestureFixture(
  fixture: CalendarGestureFixture,
): Promise<string[]> {
  const svc = serviceClient();
  const actions: string[] = [];
  const merchantsIn = [fixture.many, fixture.few];
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
  const userIds = merchantsIn.map((m) => m.userId);
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

  // ② 依外鍵順序硬刪除(同 bonus-fixture:抽成快照 → 訂單 → 會員 → 商家(其餘子表 cascade)→ 集團 → 帳號)
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
  return actions;
}
