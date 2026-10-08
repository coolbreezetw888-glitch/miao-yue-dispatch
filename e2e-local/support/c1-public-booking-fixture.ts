// 客戶端第 1 批(C1)本機 e2e fixture:公開預約頁 + 商家設定「線上預約」卡片。
// 規格書:.project/specs/客戶端第1批-公開預約頁.md(C1-A01~A10、C1-D01/D02、C1-E01/E02、C1-F02、C1-G02)。
// 只在 playwright.local.config.ts 底下用,只連本機 Docker 的 Supabase(寫法比照 booking-form-batch2-fixture.ts)。
//
// 一個管理員帳號、一個集團、三間商家:
//   A「到府」:主題色沉穩藍;地址 / 電話 / 簡介 / 公告(開)/ LINE 好友連結都有;對外 Email 是哨兵字串。
//      營業時間:週日休息,其他天 09:00~18:00。
//      分類「分離式冷氣」:室內機清洗(主要 2500 / 90 分)、室外機清洗(主要 1200 / 60 分)、
//      一對二室外機清洗(主要 1600 / 80 分);「加購項目」抗菌塗層(加購 300 / 15 分);
//      已下架項目 SENTINEL_REMOVED_ITEM。
//      服務人員(都是月薪制才能請假;每週時段七天 09:00~18:00;最少提前 1 天、最遠 20 天):
//        甲 本名 SENTINEL_STAFF_REALNAME、暱稱「阿明」、電話 0900111222、line_user_id / 邀請信箱是哨兵
//        乙 暱稱「小陳」,只對應「室外機清洗」⇒ 選了室內機就不會出現在 ③
//        丙 沒有暱稱,本名「志豪」
//        丁 未上架,暱稱 SENTINEL_UNLISTED
//      日期:F = 明天起第一個非週日(甲乙丙整天都有預約 ⇒「已滿」,客戶姓名 / 備註是哨兵字串);
//            L = F 之後第一個非週日(甲乙丙都請假 ⇒「已滿」);今天 = 範圍外(最少提前 1 天)
//   B「到店」:主題色溫暖綠;只有電話;公告關(內容是哨兵字串);一個主要項目、一位服務人員。
//   C:名稱含 SENTINEL_OTHER_SHOP,建好後停用(暫停線上預約頁用)。
//
// teardown:service_role 硬刪除。刪前 SELECT 核對(集團底下三間商家名稱都是本 fixture 前綴、帳號 email 是本 fixture
// 格式,對不上就整個不刪),刪後再 SELECT 一次全部必須為 0。
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { buildFetch } from "../../e2e/support/fixture-supabase-client";
import { buildTaipeiIso, getTaipeiNow, toDateKey } from "../../src/modules/booking/dateUtils";
import { localAuthStorageKey, readLocalSupabaseTarget } from "./local-target";

export const MERCHANT_NAME_PREFIX = "E2E客戶端C1本機";
export const SHOP_A_NAME = "涼風工匠";
export const SHOP_B_NAME = "小美美甲";
export const THEME_A = "#2563EB";
export const THEME_B = "#16A34A";
export const LINE_URL_A = "https://lin.ee/c1e2eTest";
export const PHONE_A = "02-2345-6789";
export const PHONE_B = "0912-000-111";
export const ITEM_INDOOR = "室內機清洗";
export const ITEM_OUTDOOR = "室外機清洗";
export const ITEM_ONE_TWO = "一對二室外機清洗";
export const ITEM_ADDON = "抗菌塗層";
export const ITEM_B = "單色凝膠";
export const STAFF_MING = "阿明";
export const STAFF_CHEN = "小陳";
export const STAFF_HAO = "志豪";
const EMAIL_PATTERN = /^e2e-c1public-\d+@example-local-test\.test$/;

/** C1-F02 的哨兵字串(公開函式的回應原文裡一個都不能出現)。 */
export const SENTINELS = {
  staffRealName: "SENTINEL_STAFF_REALNAME",
  staffPhone: "0900111222",
  lineUserId: "SENTINEL_LINE_UID",
  invitedEmail: "sentinel-staff@example.com",
  merchantEmail: "sentinel-merchant@example.com",
  announcementOff: "SENTINEL_ANNOUNCEMENT_OFF",
  removedItem: "SENTINEL_REMOVED_ITEM",
  unlistedStaff: "SENTINEL_UNLISTED",
  customer: "SENTINEL_CUSTOMER",
  note: "SENTINEL_NOTE",
  otherShop: "SENTINEL_OTHER_SHOP",
} as const;

export interface C1Fixture {
  runId: string;
  userId: string;
  adminSession: Session;
  admin: SupabaseClient;
  groupId: string;
  merchantAId: string;
  merchantBId: string;
  merchantCId: string;
  slugA: string;
  slugB: string;
  slugC: string;
  staffIds: string[];
  staffMingId: string;
  /** 台北的今天。 */
  today: string;
  /** 甲乙丙整天都有預約的那天(「已滿」)。 */
  dateFull: string;
  /** 甲乙丙都請假的那天(「已滿」)。 */
  dateLeave: string;
  /** 第一週裡的週日(「公休」)。 */
  dateSunday: string;
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

/** 沒登入的 client(跟客人的瀏覽器一樣,只有 publishable key)。 */
export function anonClient(): SupabaseClient {
  return makeClient(readLocalSupabaseTarget().publishableKey);
}

function must<T>(label: string, data: T | null | undefined, error: { message: string } | null): T {
  if (error || data === null || data === undefined) {
    throw new Error(`${label}失敗:${error?.message ?? "沒有回傳資料"}`);
  }
  return data;
}

function dayOfWeek(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function plusDays(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export async function setupC1Fixture(): Promise<C1Fixture> {
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const seed = Number(runId.slice(-7)) * 10;
  const email = `e2e-c1public-${runId}@example-local-test.test`;
  const password = `E2eC1Public!${runId}Aa`;
  const admin = makeClient(readLocalSupabaseTarget().publishableKey);
  const svc = serviceClient();
  const signUp = await admin.auth.signUp({ email, password });
  const adminSession = must("建立管理員帳號", signUp.data.session, signUp.error);
  const userId = must("取得管理員 id", signUp.data.user?.id, null);
  const partial: PartialState = { userId, groupId: null };
  try {
    return await buildFixture({ runId, seed, admin, svc, adminSession, userId, partial });
  } catch (err) {
    // 建到一半失敗 ⇒ 盡量把已經建好的東西清掉(只清這次建的集團與帳號),再把原本的錯誤丟出去。
    await cleanupPartial(partial).catch((e) => console.error("[c1 fixture] 清理半成品失敗:", e));
    throw err;
  }
}

interface PartialState {
  userId: string;
  groupId: string | null;
}

async function cleanupPartial(partial: PartialState): Promise<void> {
  const svc = serviceClient();
  const u = await svc.auth.admin.getUserById(partial.userId);
  if (!EMAIL_PATTERN.test(u.data.user?.email ?? "")) return;
  if (partial.groupId) {
    const m = await svc.from("merchants").select("id").eq("group_id", partial.groupId);
    const ids = ((m.data ?? []) as { id: string }[]).map((r) => r.id);
    if (ids.length > 0) {
      const staff = await svc.from("merchant_staff").select("id").in("merchant_id", ids);
      const staffIds = ((staff.data ?? []) as { id: string }[]).map((r) => r.id);
      await svc.from("booking_commission_records").delete().in("merchant_id", ids);
      await svc.from("bookings").delete().in("merchant_id", ids);
      await svc.from("members").delete().in("merchant_id", ids);
      if (staffIds.length > 0)
        await svc.from("staff_leave_records").delete().in("staff_id", staffIds);
      await svc.from("merchants").delete().in("id", ids);
    }
    await svc.from("groups").delete().eq("id", partial.groupId);
  }
  await svc.auth.admin.deleteUser(partial.userId);
}

async function buildFixture(ctx: {
  runId: string;
  seed: number;
  admin: SupabaseClient;
  svc: SupabaseClient;
  adminSession: Session;
  userId: string;
  partial: PartialState;
}): Promise<C1Fixture> {
  const { runId, seed, admin, svc, adminSession, userId, partial } = ctx;

  // ─── A:到府 ───
  const aRes = await admin.rpc("create_group_and_merchant", {
    p_name: `${MERCHANT_NAME_PREFIX}A${runId}`,
    p_industry_type: "on_site_dispatch",
    p_contact_email: SENTINELS.merchantEmail,
    p_intro:
      "專做家用冷氣清洗十年，分離式、窗型、吊隱式都能洗。到府施工全程鋪設防護墊，洗完當場試機。",
  });
  const merchantAId = must("建立商家 A", aRes.data as string | null, aRes.error);
  const groupRow = await svc.from("merchants").select("group_id").eq("id", merchantAId).single();
  const groupId = must("查詢集團", groupRow.data, groupRow.error).group_id as string;
  partial.groupId = groupId;

  const bRes = await admin.rpc("create_merchant_in_group", {
    p_group_id: groupId,
    p_name: `${MERCHANT_NAME_PREFIX}B${runId}`,
    p_industry_type: "in_store_beauty",
  });
  const merchantBId = must("建立商家 B", bRes.data as string | null, bRes.error);
  const cRes = await admin.rpc("create_merchant_in_group", {
    p_group_id: groupId,
    p_name: `${MERCHANT_NAME_PREFIX}C${SENTINELS.otherShop}${runId}`,
    p_industry_type: "in_store_beauty",
  });
  const merchantCId = must("建立商家 C", cRes.data as string | null, cRes.error);

  // 店名改成畫面上看的名字(前綴只留在 C,teardown 用 id + 集團核對)。
  // ⚠️ A、B 的店名改掉之後,teardown 改用「集團底下就是這三個 id」+ 帳號 email 格式核對。
  const upA = await admin
    .from("merchants")
    .update({
      name: SHOP_A_NAME,
      address: "台北市大安區復興南路一段 100 號",
      phone: PHONE_A,
      theme_custom_color: THEME_A,
      announcement_enabled: true,
      announcement_content: "十月起週日公休。夏季預約量大，建議提早三天預約。",
      line_friend_url: LINE_URL_A,
    } as never)
    .eq("id", merchantAId);
  if (upA.error) throw new Error(`設定商家 A 失敗:${upA.error.message}`);
  const upB = await admin
    .from("merchants")
    .update({
      name: SHOP_B_NAME,
      phone: PHONE_B,
      intro: "日系凝膠美甲，一人工作室。",
      theme_custom_color: THEME_B,
      announcement_enabled: false,
      announcement_content: SENTINELS.announcementOff,
    } as never)
    .eq("id", merchantBId);
  if (upB.error) throw new Error(`設定商家 B 失敗:${upB.error.message}`);
  const upC = await admin.from("merchants").update({ status: "disabled" }).eq("id", merchantCId);
  if (upC.error) throw new Error(`停用商家 C 失敗:${upC.error.message}`);

  const slugs = await svc
    .from("merchants")
    .select("id,booking_slug")
    .in("id", [merchantAId, merchantBId, merchantCId]);
  const slugRows = must("查預約網址代碼", slugs.data, slugs.error) as {
    id: string;
    booking_slug: string;
  }[];
  const slugOf = (id: string) => slugRows.find((r) => r.id === id)!.booking_slug;

  // ─── 營業時間 ───
  for (const merchantId of [merchantAId, merchantBId]) {
    const hoursRes = await admin.from("merchant_business_hours").upsert(
      Array.from({ length: 7 }, (_, d) => ({
        merchant_id: merchantId,
        day_of_week: d,
        is_closed: d === 0,
        open_time: d === 0 ? null : "09:00",
        close_time: d === 0 ? null : "18:00",
      })),
      { onConflict: "merchant_id,day_of_week" },
    );
    if (hoursRes.error) throw new Error(`營業時間失敗:${hoursRes.error.message}`);
  }

  // ─── 服務項目 ───
  const catRes = await admin
    .from("service_categories")
    .insert([{ merchant_id: merchantAId, name: "分離式冷氣" }])
    .select("id")
    .single();
  const catId = must("建立分類", catRes.data, catRes.error).id as string;
  const itemRes = await admin
    .from("service_items")
    .insert([
      {
        merchant_id: merchantAId,
        name: ITEM_INDOOR,
        description: "拆洗濾網、鰭片、出風口，含高壓水洗。",
        price: 2500,
        item_type: "primary",
        status: "active",
        duration_minutes: 90,
        category_id: catId,
      },
      {
        merchant_id: merchantAId,
        name: ITEM_OUTDOOR,
        description: "散熱片清洗與排水檢查。",
        price: 1200,
        item_type: "primary",
        status: "active",
        duration_minutes: 60,
        category_id: catId,
      },
      {
        merchant_id: merchantAId,
        name: ITEM_ONE_TWO,
        price: 1600,
        item_type: "primary",
        status: "active",
        duration_minutes: 80,
        category_id: catId,
      },
      {
        merchant_id: merchantAId,
        name: ITEM_ADDON,
        price: 300,
        item_type: "addon",
        status: "active",
        duration_minutes: 15,
        category_id: catId,
      },
      {
        merchant_id: merchantAId,
        name: SENTINELS.removedItem,
        price: 100,
        item_type: "primary",
        duration_minutes: 30,
        category_id: catId,
        status: "removed",
      },
      {
        merchant_id: merchantBId,
        name: ITEM_B,
        price: 1200,
        item_type: "primary",
        status: "active",
        duration_minutes: 90,
      },
    ])
    .select("id,name");
  const items = must("建立服務項目", itemRes.data, itemRes.error) as { id: string; name: string }[];
  const itemId = (name: string) => items.find((i) => i.name === name)!.id;

  // ─── 服務人員 ───
  async function addStaff(input: {
    merchantId: string;
    name: string;
    nickname: string | null;
    phone?: string;
    intro?: string | null;
    listed?: boolean;
    n: number;
  }): Promise<string> {
    const digits = String((seed + input.n) % 100_000_000).padStart(8, "0");
    const r = await admin
      .from("merchant_staff")
      .insert({
        merchant_id: input.merchantId,
        name: input.name,
        nickname: input.nickname,
        phone: input.phone ?? `09${digits}`,
        intro: input.intro ?? null,
        is_listed: input.listed ?? true,
        compensation_type: "monthly_salary",
        advance_booking_days: 1,
        booking_window_max_days: 20,
      })
      .select("id")
      .single();
    return must(`建立服務人員 ${input.name}`, r.data, r.error).id as string;
  }
  const staffMingId = await addStaff({
    merchantId: merchantAId,
    name: SENTINELS.staffRealName,
    nickname: STAFF_MING,
    phone: SENTINELS.staffPhone,
    intro: "冷氣清洗　資歷 8 年",
    n: 1,
  });
  const staffChenId = await addStaff({
    merchantId: merchantAId,
    name: "陳志明",
    nickname: STAFF_CHEN,
    intro: "冷氣清洗、室外機保養",
    n: 2,
  });
  const staffHaoId = await addStaff({
    merchantId: merchantAId,
    name: STAFF_HAO,
    nickname: null,
    intro: "吊隱式冷氣專長",
    n: 3,
  });
  const staffUnlistedId = await addStaff({
    merchantId: merchantAId,
    name: "未上架本名",
    nickname: SENTINELS.unlistedStaff,
    listed: false,
    n: 4,
  });
  const staffBId = await addStaff({ merchantId: merchantBId, name: "小美", nickname: null, n: 5 });
  const listedA = [staffMingId, staffChenId, staffHaoId];
  const staffIds = [...listedA, staffUnlistedId, staffBId];

  // 甲的 LINE / 邀請信箱哨兵(這兩欄前端不能直接寫,用 service_role 填;只在本機)。
  const sentinelRes = await svc
    .from("merchant_staff")
    .update({ line_user_id: SENTINELS.lineUserId, invited_login_email: SENTINELS.invitedEmail })
    .eq("id", staffMingId);
  if (sentinelRes.error) throw new Error(`甲的哨兵欄位失敗:${sentinelRes.error.message}`);

  const mapRes = await admin
    .from("merchant_staff_service_items")
    .insert({ staff_id: staffChenId, service_item_id: itemId(ITEM_OUTDOOR) });
  if (mapRes.error) throw new Error(`乙的服務項目對應失敗:${mapRes.error.message}`);

  const winRes = await admin.from("staff_availability_windows").insert(
    [...listedA, staffBId].flatMap((staffId) =>
      Array.from({ length: 7 }, (_, d) => ({
        staff_id: staffId,
        day_of_week: d,
        start_time: "09:00",
        end_time: "18:00",
      })),
    ),
  );
  if (winRes.error) throw new Error(`每週時段失敗:${winRes.error.message}`);

  // ─── 日期 ───
  const today = toDateKey(getTaipeiNow());
  let dateFull = plusDays(today, 1);
  if (dayOfWeek(dateFull) === 0) dateFull = plusDays(dateFull, 1);
  let dateLeave = plusDays(dateFull, 1);
  if (dayOfWeek(dateLeave) === 0) dateLeave = plusDays(dateLeave, 1);
  let dateSunday = today;
  while (dayOfWeek(dateSunday) !== 0) dateSunday = plusDays(dateSunday, 1);

  // F:甲乙丙整天都有預約(09:00~18:00,自訂工時 540 分鐘),客戶姓名 / 備註是哨兵字串。
  const pmRes = await admin
    .from("payment_methods")
    .select("id")
    .eq("merchant_id", merchantAId)
    .eq("status", "active")
    .limit(1)
    .single();
  const paymentMethodId = must("查付款方式", pmRes.data, pmRes.error).id as string;
  for (const [i, staffId] of listedA.entries()) {
    const res = await admin.rpc("create_booking", {
      p_merchant_id: merchantAId,
      p_staff_id: staffId,
      p_service_items: [{ service_item_id: itemId(ITEM_INDOOR), quantity: 1, unit_price: 2500 }],
      p_start_at: buildTaipeiIso(dateFull, "09:00"),
      p_customer_name: SENTINELS.customer,
      p_customer_phone: `09${String((seed + 50 + i) % 100_000_000).padStart(8, "0")}`,
      p_customer_address: "台北市測試路 1 號",
      p_notes: SENTINELS.note,
      p_customer_notes: SENTINELS.note,
      p_assistant_staff_ids: [],
      p_payment_method_id: paymentMethodId,
      p_custom_duration_enabled: true,
      p_custom_duration_minutes: 540,
    });
    must(`建立整天預約 ${i}`, res.data, res.error);
  }

  // L:甲乙丙都請假。
  const ltRes = await admin
    .from("merchant_leave_types")
    .select("id")
    .eq("merchant_id", merchantAId)
    .order("name")
    .limit(1)
    .single();
  const leaveTypeId = must("查假別", ltRes.data, ltRes.error).id as string;
  for (const staffId of listedA) {
    const leaveRes = await admin.rpc("create_staff_leave", {
      p_staff_id: staffId,
      p_leave_type_id: leaveTypeId,
      p_start_date: dateLeave,
      p_end_date: dateLeave,
      p_confirm_despite_conflicts: false,
    });
    if (leaveRes.error) throw new Error(`請假失敗:${leaveRes.error.message}`);
  }

  // E02:紅利功能開著(紅利點數頁才看得到分頁)+ 一位會員(會員詳細頁)。
  const settingsRes = await admin
    .from("merchant_member_settings")
    .upsert(
      { merchant_id: merchantAId, points_feature_enabled: true },
      { onConflict: "merchant_id" },
    );
  if (settingsRes.error) throw new Error(`會員設定失敗:${settingsRes.error.message}`);

  return {
    runId,
    userId,
    adminSession,
    admin,
    groupId,
    merchantAId,
    merchantBId,
    merchantCId,
    slugA: slugOf(merchantAId),
    slugB: slugOf(merchantBId),
    slugC: slugOf(merchantCId),
    staffIds,
    staffMingId,
    today,
    dateFull,
    dateLeave,
    dateSunday,
  };
}

export async function createMemberForFixture(
  fixture: C1Fixture,
  name: string,
  phoneSuffix = "88",
): Promise<string> {
  const res = await fixture.admin.rpc("create_member", {
    p_merchant_id: fixture.merchantAId,
    p_name: name,
    p_phone: `09${String((Number(fixture.runId.slice(-7)) * 10 + Number(phoneSuffix)) % 100_000_000).padStart(8, "0")}`,
  });
  return (must(`建立會員 ${name}`, res.data, res.error) as { id: string }).id;
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

export async function teardownC1Fixture(fixture: C1Fixture): Promise<string[]> {
  const svc = serviceClient();
  const actions: string[] = [];
  const merchantIds = [fixture.merchantAId, fixture.merchantBId, fixture.merchantCId];

  // ① 核對範圍:集團底下剛好就是這三間;C 的名稱是本 fixture 前綴;帳號 email 是本 fixture 格式。
  const merchants = await svc.from("merchants").select("id,name").eq("group_id", fixture.groupId);
  if (merchants.error) throw new Error(`teardown 查商家失敗:${merchants.error.message}`);
  const rows = (merchants.data ?? []) as { id: string; name: string }[];
  const sameSet =
    rows.length === 3 &&
    rows.every((r) => merchantIds.includes(r.id)) &&
    rows.find((r) => r.id === fixture.merchantCId)?.name.startsWith(MERCHANT_NAME_PREFIX) === true;
  if (!sameSet) {
    throw new Error(
      `teardown 中止:集團底下的商家不是本 fixture 建立的(${JSON.stringify(rows)}),不刪任何東西`,
    );
  }
  const u = await svc.auth.admin.getUserById(fixture.userId);
  const email = u.data.user?.email ?? "";
  if (u.error || !EMAIL_PATTERN.test(email)) {
    throw new Error(`teardown 中止:使用者不是本 fixture 建立的帳號(${email}),不刪任何東西`);
  }
  const bookingCount = await svc
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .in("merchant_id", merchantIds);
  actions.push(
    `核對通過:商家 3 間、帳號 1 個、預約 ${bookingCount.count ?? "?"} 筆,都是本次 fixture 建立的`,
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
      () => svc.from("staff_leave_records").delete().in("staff_id", fixture.staffIds).select("id"),
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
    const r = await svc
      .from(table)
      .select(column, { count: "exact", head: true })
      .in(column, values);
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
    (await count("merchant_booking_settings", "merchant_id", merchantIds)) +
    (await count("staff_leave_records", "staff_id", fixture.staffIds));
  const userLeft = (await svc.auth.admin.getUserById(fixture.userId)).data.user ? 1 : 0;
  if (left + userLeft !== 0) throw new Error(`teardown 後仍有殘留 ${left + userLeft} 筆`);
  actions.push(
    "刪後核對:商家 / 集團 / 訂單 / 服務人員 / 服務項目 / 分類 / 預約設定 / 請假 / 帳號 全部 0",
  );
  return actions;
}
