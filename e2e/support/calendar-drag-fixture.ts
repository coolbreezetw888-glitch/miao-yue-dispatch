// 行事曆拖拉改時間與轉派(.project/specs/行事曆拖拉改時間與轉派.md §9.3,SPECS-INDEX #821)——
// 建立/清理 e2e/calendar-drag-move.spec.ts 用的真實 fixture 資料。
//
// 為什麼不沿用 mobile-overflow-fixture.ts:那支只有「一位主服務人員 + 一位助手」兩欄,而 §9.3 的
// #2 / #3 / #4 都需要「第三人 C 的欄位」;而且 §9.3 的九條情境彼此會改同一筆單的時間/人員,
// 如果全部共用一筆預約,測試之間就會互相依賴(#1 改完時間,#2 的「start_at 不變」就要拿改完的值
// 當基準),一條紅了後面全部跟著失真。所以這裡改成「一條情境一筆預約」,全部排在同一天、彼此
// 至少隔一小時,任何一條怎麼拖都不會撞到別條的單:
//
//   時間   主  助手  用途(對應 §9.3 的編號)
//   08:00  A   B     #1 規則 1:同欄往下拖 4 格 → 10:00(A、B 在 10:00 都是空的)
//   12:00  A   B     #5 復原:先拖到 14:00,再按 toast 的「復原」回 12:00
//   16:00  A   B     #2 規則 2:主色塊拖到 C 欄(同一列)→ staff_id = C
//   17:00  A   B     #3 規則 3:助手色塊拖到 C 欄 → booking_assistants.staff_id = C
//   18:00  A   B     #4 衝突:主色塊拖到 C 欄,但 C 在 18:00 已經有下面那筆單 → 被擋、仍是 A
//   18:00  C   —     (#4 的擋路單,沒有助手)
//   19:00  A   B     #6 已完成訂單(confirm_booking + complete_booking)→ 不可拖
//   20:00  A   B     #7 #641 回歸(移動 3px 放開 = 點擊開詳情)、#8 放開在原位、#9 手機版
//
// 日期一律用「明天」(Asia/Taipei),不是今天:規格書 Q3=B 規定「拖到已經過去的時間」會先跳確認框,
// 用今天的話,測試在下午跑就會多出一個確認框、早上跑就沒有,結果會隨執行時刻改變。明天的任何時段
// 都在未來,九條的行為就跟時鐘無關。CalendarPage 支援 `?date=YYYY-MM-DD` 直接開到那一天。
//
// 每一筆單只掛一個 30 分鐘的服務項目 → 色塊剛好一格高(SLOT_PX = 30),座標計算最單純。
//
// 三位服務人員都開 unlimited_backend_edit + no_time_slot_limit(略過營業時間/可預約時段/跨日檢查,
// 但「同一時段已經有其他預約」的衝突檢查**不在**這個略過範圍內——見
// supabase/migrations/20260917100200_booking_expansion_functions.sql 的 check_staff_booking_slot,
// strict_conflict_check 預設開啟),所以 #4 的衝突情境仍然會被後端擋下。
//
// 資料建立方式比照 e2e/support/mobile-overflow-fixture.ts:用 @supabase/supabase-js 以 publishable key
// 走真實 signUp() → 呼叫真正的 RPC/資料表(跟前端 src/modules/*/api.ts 打的是同一組),打的是正式
// Supabase 專案。**已知限制**同 mobile-overflow-fixture.ts 檔頭:這個專案刻意只做軟刪除,teardown
// 只能取消預約/軟移除服務人員/停用商家,底層資料列會留在正式庫(名稱以 `E2E測試`、email 以
// `e2e-calendar-drag-` 開頭清楚標記)。teardown 全部是 **id-based**(`.eq("id", …)` / `.in("id", […])`),
// 不靠名稱前綴篩選,比照 .claude/skills/automated-testing/SKILL.md 第五節的既有慣例。
//
// ⚠️ Supabase client 的建立(publishable key 要拿掉 Authorization 標頭那段)一律 import 共用的
//    e2e/support/fixture-supabase-client.ts(SPECS-INDEX #766,2026-09-28 收斂完成)。這支檔案剛寫的時候
//    是借用 industry-transfer-fixture.ts export 的那一份、刻意不複製第 14 份;收斂後改成跟其他 15 支一樣
//    走共用 helper。
import type { Page } from "@playwright/test";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

import {
  addDays,
  buildTaipeiIso,
  getTaipeiNow,
  toDateKey,
} from "../../src/modules/booking/dateUtils";
import { createFixtureSupabaseClient } from "./fixture-supabase-client";
import { disableFixtureMerchant } from "./merchant-teardown-helper";
import { getSupabaseAuthStorageKey } from "./supabase-storage-key";

export const STAFF_A_NAME = "E2E測試服務人員A主要";
export const STAFF_B_NAME = "E2E測試服務人員B助手";
export const STAFF_C_NAME = "E2E測試服務人員C第三人";
export const SERVICE_ITEM_NAME = "E2E測試拖拉服務30分";
/** 每筆單只掛這一個 30 分鐘的服務項目 → 色塊高度 = 一格。 */
export const SERVICE_DURATION_MINUTES = 30;

export interface FixtureBooking {
  id: string;
  /** 建單時的 "HH:MM"(Asia/Taipei)。 */
  startTime: string;
  /** 建單時送出的 ISO 字串(含 +08:00)。 */
  startAt: string;
  customerName: string;
}

export interface CalendarDragFixture {
  runId: string;
  email: string;
  password: string;
  session: Session;
  /** 已經帶著 fixture 商家管理員 session 的 client,spec 用它查 bookings / booking_assistants 驗最終狀態。 */
  client: SupabaseClient;
  merchantId: string;
  staffAId: string;
  staffBId: string;
  staffCId: string;
  serviceItemId: string;
  /** 所有預約所在的日期(YYYY-MM-DD,Asia/Taipei 的「明天」)。 */
  dateKey: string;
  bookings: {
    rule1: FixtureBooking;
    undo: FixtureBooking;
    reassignMain: FixtureBooking;
    reassignAssistant: FixtureBooking;
    conflict: FixtureBooking;
    conflictBlocker: FixtureBooking;
    completed: FixtureBooking;
    tapNoop: FixtureBooking;
  };
}

interface BookingPlan {
  key: keyof CalendarDragFixture["bookings"];
  startTime: string;
  customerName: string;
  mainStaff: "A" | "C";
  withAssistantB: boolean;
  complete: boolean;
}

const BOOKING_PLAN: readonly BookingPlan[] = [
  {
    key: "rule1",
    startTime: "08:00",
    customerName: "E2E測試客戶規則一",
    mainStaff: "A",
    withAssistantB: true,
    complete: false,
  },
  {
    key: "undo",
    startTime: "12:00",
    customerName: "E2E測試客戶復原",
    mainStaff: "A",
    withAssistantB: true,
    complete: false,
  },
  {
    key: "reassignMain",
    startTime: "16:00",
    customerName: "E2E測試客戶規則二",
    mainStaff: "A",
    withAssistantB: true,
    complete: false,
  },
  {
    key: "reassignAssistant",
    startTime: "17:00",
    customerName: "E2E測試客戶規則三",
    mainStaff: "A",
    withAssistantB: true,
    complete: false,
  },
  {
    key: "conflict",
    startTime: "18:00",
    customerName: "E2E測試客戶衝突",
    mainStaff: "A",
    withAssistantB: true,
    complete: false,
  },
  {
    key: "conflictBlocker",
    startTime: "18:00",
    customerName: "E2E測試客戶擋路",
    mainStaff: "C",
    withAssistantB: false,
    complete: false,
  },
  {
    key: "completed",
    startTime: "19:00",
    customerName: "E2E測試客戶已完成",
    mainStaff: "A",
    withAssistantB: true,
    complete: true,
  },
  {
    key: "tapNoop",
    startTime: "20:00",
    customerName: "E2E測試客戶原位",
    mainStaff: "A",
    withAssistantB: true,
    complete: false,
  },
];

async function insertStaff(
  client: SupabaseClient,
  merchantId: string,
  name: string,
  phone: string,
): Promise<string> {
  const { data, error } = await client
    .from("merchant_staff")
    .insert({
      merchant_id: merchantId,
      name,
      // merchant_staff.phone 是 NOT NULL + CHECK(^09\d{8}$)(#595/#596),每位用不同尾碼避免撞號。
      phone,
      is_listed: true,
      no_time_slot_limit: true,
      unlimited_backend_edit: true,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`建立測試服務人員「${name}」失敗:${error?.message}`);
  return (data as { id: string }).id;
}

/** 建立這次測試需要的全部 fixture 資料。任何一步失敗就整個丟出例外,讓測試直接失敗、不留半套資料誤導判斷。 */
export async function setupCalendarDragFixture(): Promise<CalendarDragFixture> {
  const client = createFixtureSupabaseClient();
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `e2e-calendar-drag-${runId}@example-calendar-drag-test.test`;
  const password = `E2eCalendarDrag!${runId}Aa`;

  const { data: signUpData, error: signUpError } = await client.auth.signUp({ email, password });
  if (signUpError) throw new Error(`建立 e2e 測試帳號失敗(signUp):${signUpError.message}`);
  let session = signUpData.session;
  if (!session) {
    const { data: signInData, error: signInError } = await client.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError || !signInData.session) {
      throw new Error(
        "建立 e2e 測試帳號後拿不到可用的 session——這個 Supabase 專案可能開啟了「需要驗證信箱才能登入」," +
          `跟過去 e2e fixture 的行為不一致,請確認 Authentication 設定。原始錯誤:${signInError?.message ?? "signUp 沒有回傳 session"}`,
      );
    }
    session = signInData.session;
  }

  const { data: merchantId, error: merchantError } = await client.rpc("create_group_and_merchant", {
    p_name: `E2E行事曆拖拉測試商家${runId}`,
    p_industry_type: "in_store_beauty",
    p_address: "e2e-calendar-drag 測試用地址",
    p_contact_email: email,
    p_intro: "e2e/calendar-drag-move.spec.ts 自動化測試用商家,測試完會停用,不是真實商家。",
  });
  if (merchantError || !merchantId) {
    throw new Error(`建立測試商家失敗:${merchantError?.message ?? "沒有回傳 merchant id"}`);
  }
  const merchant = merchantId as string;

  // 七天都開 08:00-21:00:格線第 0 格 = 08:00,共 26 格;測試不依賴「明天剛好是星期幾」。
  const { error: hoursError } = await client.from("merchant_business_hours").upsert(
    Array.from({ length: 7 }, (_, dayOfWeek) => ({
      merchant_id: merchant,
      day_of_week: dayOfWeek,
      is_closed: false,
      open_time: "08:00",
      close_time: "21:00",
    })),
    { onConflict: "merchant_id,day_of_week" },
  );
  if (hoursError) throw new Error(`寫入測試商家營業時間失敗:${hoursError.message}`);

  const phoneBase = runId.slice(-7);
  const staffAId = await insertStaff(client, merchant, STAFF_A_NAME, `09${phoneBase}0`);
  const staffBId = await insertStaff(client, merchant, STAFF_B_NAME, `09${phoneBase}1`);
  const staffCId = await insertStaff(client, merchant, STAFF_C_NAME, `09${phoneBase}2`);

  const { data: serviceItem, error: serviceItemError } = await client
    .from("service_items")
    .insert({
      merchant_id: merchant,
      name: SERVICE_ITEM_NAME,
      price: 500,
      item_type: "primary",
      duration_minutes: SERVICE_DURATION_MINUTES,
    })
    .select("id")
    .single();
  if (serviceItemError || !serviceItem) {
    throw new Error(`建立測試服務項目失敗:${serviceItemError?.message}`);
  }
  const serviceItemId = (serviceItem as { id: string }).id;

  // #604:create_booking 付款方式必填;create_group_and_merchant 已自動 seed 預設付款方式,直接查一筆來用。
  const { data: paymentMethod, error: paymentMethodError } = await client
    .from("payment_methods")
    .select("id")
    .eq("merchant_id", merchant)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (paymentMethodError || !paymentMethod) {
    throw new Error(
      `查詢測試商家的預設付款方式失敗:${paymentMethodError?.message ?? "查無啟用中的付款方式"}`,
    );
  }
  const paymentMethodId = (paymentMethod as { id: string }).id;

  const dateKey = toDateKey(addDays(getTaipeiNow(), 1));
  // #822:客戶電話要通過 private.is_valid_taiwan_phone(手機 09 開頭共 10 碼)。
  const customerPhone = `09${runId.slice(-8)}`;

  const bookings = {} as CalendarDragFixture["bookings"];
  for (const plan of BOOKING_PLAN) {
    const startAt = buildTaipeiIso(dateKey, plan.startTime);
    const { data: booking, error: bookingError } = await client.rpc("create_booking", {
      p_merchant_id: merchant,
      p_staff_id: plan.mainStaff === "A" ? staffAId : staffCId,
      p_service_items: [{ service_item_id: serviceItemId, quantity: 1, unit_price: 500 }],
      p_start_at: startAt,
      p_customer_name: plan.customerName,
      p_customer_phone: customerPhone,
      p_assistant_staff_ids: plan.withAssistantB ? [staffBId] : [],
      p_payment_method_id: paymentMethodId,
    });
    if (bookingError || !booking) {
      throw new Error(`建立測試預約「${plan.customerName}」失敗:${bookingError?.message}`);
    }
    const id = (booking as { id: string }).id;
    if (plan.complete) {
      // 比照 e2e/support/members-fixture.ts:pending_confirmation → accepted → completed。
      const { error: confirmError } = await client.rpc("confirm_booking", { p_booking_id: id });
      if (confirmError)
        throw new Error(`確認測試預約「${plan.customerName}」失敗:${confirmError.message}`);
      const { error: completeError } = await client.rpc("complete_booking", { p_booking_id: id });
      if (completeError)
        throw new Error(`完成測試預約「${plan.customerName}」失敗:${completeError.message}`);
    }
    bookings[plan.key] = {
      id,
      startTime: plan.startTime,
      startAt,
      customerName: plan.customerName,
    };
  }

  return {
    runId,
    email,
    password,
    session,
    client,
    merchantId: merchant,
    staffAId,
    staffBId,
    staffCId,
    serviceItemId,
    dateKey,
    bookings,
  };
}

/** 把 fixture 的真實 session 灌進瀏覽器 localStorage,讓頁面一開就是「已登入」狀態(比照 mobile-overflow-fixture.ts)。 */
export async function injectFixtureSession(
  page: Page,
  fixture: CalendarDragFixture,
): Promise<void> {
  const storageKey = getSupabaseAuthStorageKey();
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(fixture.session)] as [string, string],
  );
}

/** 測試結束後盡量把 fixture 清乾淨(軟刪除為主,見檔頭「已知限制」)。全部 id-based。
 * 回傳值列出實際做了哪些清理動作,spec 會印在終端機,方便核對 teardown 真的跑了。 */
export async function teardownCalendarDragFixture(fixture: CalendarDragFixture): Promise<string[]> {
  const client = createFixtureSupabaseClient();
  const { error: sessionError } = await client.auth.setSession({
    access_token: fixture.session.access_token,
    refresh_token: fixture.session.refresh_token,
  });
  if (sessionError) {
    return [`警告:無法還原測試帳號 session,略過軟清理(${sessionError.message})`];
  }

  const actions: string[] = [];

  // 已完成的那筆 cancel_booking 會被後端擋下(已完成不能取消),那是預期行為,只記錄不當失敗。
  let cancelled = 0;
  const cancelFailures: string[] = [];
  for (const [key, booking] of Object.entries(fixture.bookings)) {
    const { error } = await client.rpc("cancel_booking", {
      p_booking_id: booking.id,
      p_reason: "e2e/calendar-drag-move 測試結束,自動取消 fixture 預約。",
    });
    if (error) cancelFailures.push(`${key}:${error.message}`);
    else cancelled += 1;
  }
  actions.push(
    `已取消 ${cancelled}/${Object.keys(fixture.bookings).length} 筆 fixture 預約` +
      (cancelFailures.length > 0 ? `(未取消:${cancelFailures.join(";")})` : ""),
  );

  const { error: staffError } = await client
    .from("merchant_staff")
    .update({ status: "removed" })
    .in("id", [fixture.staffAId, fixture.staffBId, fixture.staffCId]);
  actions.push(
    staffError
      ? `移除 fixture 服務人員失敗:${staffError.message}`
      : "已移除 fixture 服務人員 A/B/C(軟刪除)",
  );

  const { error: svcError } = await client
    .from("service_items")
    .update({ status: "removed" })
    .eq("id", fixture.serviceItemId);
  actions.push(
    svcError ? `下架 fixture 服務項目失敗:${svcError.message}` : "已下架 fixture 服務項目(軟刪除)",
  );

  const { error: hoursError } = await client
    .from("merchant_business_hours")
    .delete()
    .eq("merchant_id", fixture.merchantId);
  actions.push(
    hoursError
      ? `刪除 fixture 營業時間設定失敗:${hoursError.message}`
      : "已刪除 fixture 營業時間設定",
  );

  // #638:直接停用會被「集團底下至少要保留一間啟用中商家」擋下,helper 會先建空殼佔位商家再停用。
  actions.push(await disableFixtureMerchant(client, fixture.merchantId));

  return actions;
}
