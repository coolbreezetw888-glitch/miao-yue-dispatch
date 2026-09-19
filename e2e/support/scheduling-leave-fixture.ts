// 模組 7(排班與休假管理)規格書 §8 自動化測試規劃要求的兩支 Playwright 測試(4.4 排班一覽/
// 4.5 行事曆疊加請假顯示)共用的 fixture——建立/清理 e2e/scheduling-leave-display.spec.ts 用的
// 真實測試資料。
//
// 為什麼要真的建立資料,不用 mock:這兩支測試驗證的是「跨頁面的視覺呈現行為」(排班一覽表格
// 疊加請假/行事曆整欄灰底),只有真的呼叫後端 RPC 建立一筆請假紀錄、再看真實畫面渲染結果,
// 才測得出來。資料建立方式比照 e2e/support/mobile-overflow-fixture.ts 的既有做法:用
// @supabase/supabase-js 以 publishable key 真實 signUp() 建立一個全新測試帳號,呼叫真正的
// RPC/資料表操作(跟前端 src/modules/scheduling/api.ts 呼叫的是同一組 RPC),打正式 Supabase
// 專案(.env 的 wjtbmmnakcriuaqoknsq)。
//
// **已知限制(跟 mobile-overflow-fixture.ts 相同)**:merchants/merchant_staff 都只有軟刪除
// (規則:分店只能停用不能真刪除),teardown 只能做到軟停用/軟移除,底層資料列的真刪除需要有
// 資料庫直接存取權限的人另外用 SQL 清除(這次交付驗收時已經用 Supabase 的直接 SQL 存取權限
// 清乾淨並查證過,見交付報告)。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { getSupabaseAuthStorageKey } from "./supabase-storage-key";
import { getTaipeiNow, toDateKey } from "../../src/modules/booking/dateUtils";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readEnvValue(key: string): string {
  const envPath = resolve(__dirname, "../../.env");
  const content = readFileSync(envPath, "utf-8");
  const line = content
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`) || l.startsWith(`${key} =`));
  if (!line) {
    throw new Error(
      `找不到 .env 裡的 ${key}——scheduling-leave 這個 e2e 測試需要它來建立 fixture 資料。`,
    );
  }
  const value = line.slice(line.indexOf("=") + 1).trim();
  return value.replace(/^["']|["']$/g, "");
}

// 比照 src/integrations/supabase/client.ts / mobile-overflow-fixture.ts 的做法:新格式
// publishable key(sb_publishable_...)不是合法的 JWT,supabase-js 預設可能還是塞一個
// `Authorization: Bearer <publishable key>` 標頭,要在真正送出的 fetch 裡拿掉。
function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith("sb_publishable_") || value.startsWith("sb_secret_");
}

function buildFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    if (
      isNewSupabaseApiKey(supabaseKey) &&
      headers.get("Authorization") === `Bearer ${supabaseKey}`
    ) {
      headers.delete("Authorization");
    }
    headers.set("apikey", supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

function createFixtureSupabaseClient(): SupabaseClient {
  const url = readEnvValue("VITE_SUPABASE_URL");
  const key = readEnvValue("VITE_SUPABASE_PUBLISHABLE_KEY");
  return createClient(url, key, {
    global: { fetch: buildFetch(key) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const STAFF_ON_LEAVE_NAME_PREFIX = "E2E測試請假師傅";
export const STAFF_NORMAL_NAME_PREFIX = "E2E測試正常師傅";
export const LEAVE_TYPE_NAME = "病假"; // 商家建立時自動種入的三筆預設假別之一(規則 3.9)。

export interface SchedulingLeaveFixture {
  runId: string;
  email: string;
  password: string;
  session: Session;
  merchantId: string;
  staffOnLeaveId: string;
  staffOnLeaveName: string;
  staffNormalId: string;
  staffNormalName: string;
  leaveTypeId: string;
  leaveTypeName: string;
  leaveRecordId: string;
  todayDateKey: string;
  /** 這一週裡「不是今天」的另一天(YYYY-MM-DD),供 4.5 測試驗證「非請假日期不受影響」用。 */
  otherDateKeyInSameWeek: string;
}

/** 建立這次測試需要的全部 fixture 資料:一個新商家 + 兩位服務人員(一位月薪制、一位按件計酬)+
 * 一筆涵蓋「今天」的整天請假紀錄(月薪制那位)。回傳建立好的各項 id,供 spec 檔案在畫面上定位
 * 元素,也供 teardown 使用。任何一步失敗就整個丟出例外,不留半套資料誤導判斷。 */
export async function setupSchedulingLeaveFixture(): Promise<SchedulingLeaveFixture> {
  const client = createFixtureSupabaseClient();
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `e2e-scheduling-leave-please-ignore-${runId}@example-overflow-test-domain.test`;
  const password = `E2eLeave!${runId}Aa`;

  const { data: signUpData, error: signUpError } = await client.auth.signUp({ email, password });
  if (signUpError) throw new Error(`建立 e2e 測試帳號失敗(signUp):${signUpError.message}`);
  const session = signUpData.session;
  if (!session) {
    throw new Error(
      "建立 e2e 測試帳號後拿不到可用的 session——這個 Supabase 專案可能開啟了「需要驗證信箱才能" +
        "登入」,跟過去 QA 複驗時的行為不一致,請確認 Authentication 設定。",
    );
  }

  // 3.2/3.9:一次原子性建立集團+商家,並自動種入三筆預設假別(事假/病假/特休)。
  const merchantName = `E2E排班休假顯示測試商家${runId}`;
  const { data: merchantId, error: merchantError } = await client.rpc("create_group_and_merchant", {
    p_name: merchantName,
    p_industry_type: "on_site_dispatch",
    p_contact_email: email,
    p_intro: "e2e-scheduling-leave 自動化測試用商家,測試完會清除/停用,不是真實商家。",
  });
  if (merchantError || !merchantId) {
    throw new Error(`建立測試商家失敗:${merchantError?.message ?? "沒有回傳 merchant id"}`);
  }

  // 4.5 驗證「非請假日期不受影響」需要今天以外至少還有一天可以正常顯示,不特別依賴營業時間
  // (兩位服務人員都設 no_time_slot_limit=true,不受營業時間/固定時段限制,見下方)。
  const businessHoursRows = Array.from({ length: 7 }, (_, dayOfWeek) => ({
    merchant_id: merchantId as string,
    day_of_week: dayOfWeek,
    is_closed: false,
    open_time: "08:00",
    close_time: "21:00",
  }));
  const { error: hoursError } = await client
    .from("merchant_business_hours")
    .upsert(businessHoursRows, { onConflict: "merchant_id,day_of_week" });
  if (hoursError) throw new Error(`寫入測試商家營業時間失敗:${hoursError.message}`);

  const staffOnLeaveName = `${STAFF_ON_LEAVE_NAME_PREFIX}${runId}`;
  const { data: staffOnLeave, error: staffOnLeaveError } = await client
    .from("merchant_staff")
    .insert({
      merchant_id: merchantId as string,
      name: staffOnLeaveName,
      is_listed: true,
      no_time_slot_limit: true,
      compensation_type: "monthly_salary", // 規則 2.2:只有月薪制服務人員能登記請假紀錄。
    })
    .select("id")
    .single();
  if (staffOnLeaveError || !staffOnLeave) {
    throw new Error(`建立測試請假服務人員失敗:${staffOnLeaveError?.message}`);
  }

  const staffNormalName = `${STAFF_NORMAL_NAME_PREFIX}${runId}`;
  const { data: staffNormal, error: staffNormalError } = await client
    .from("merchant_staff")
    .insert({
      merchant_id: merchantId as string,
      name: staffNormalName,
      is_listed: true,
      no_time_slot_limit: true,
      // compensation_type 不填,沿用預設值 piece_rate(按件計酬,規則 2.2 不適用請假)。
    })
    .select("id")
    .single();
  if (staffNormalError || !staffNormal) {
    throw new Error(`建立測試正常服務人員失敗:${staffNormalError?.message}`);
  }

  const { data: leaveType, error: leaveTypeError } = await client
    .from("merchant_leave_types")
    .select("id, name")
    .eq("merchant_id", merchantId as string)
    .eq("name", LEAVE_TYPE_NAME)
    .single();
  if (leaveTypeError || !leaveType) {
    throw new Error(
      `查詢測試商家的預設假別「${LEAVE_TYPE_NAME}」失敗——預期新商家建立時應該自動種入這筆` +
        `(規則 3.9),請確認 seed_default_leave_types 是否正常運作:${leaveTypeError?.message}`,
    );
  }

  const todayDateKey = toDateKey(getTaipeiNow());
  // 4.5 需要「同一週、不是今天」的另一天當作對照組。今天是星期幾就往後推一天(如果今天已經是
  // 週六,改往前推一天),確保這一天一定落在同一個週檢視(週日~週六)裡,不會跨到下一週。
  const today = getTaipeiNow();
  const isSaturday = today.getDay() === 6;
  const otherDate = new Date(today);
  otherDate.setDate(today.getDate() + (isSaturday ? -1 : 1));
  const otherDateKeyInSameWeek = toDateKey(otherDate);

  const { data: leaveRecord, error: leaveRecordError } = await client.rpc("create_staff_leave", {
    p_staff_id: (staffOnLeave as { id: string }).id,
    p_leave_type_id: (leaveType as { id: string }).id,
    p_start_date: todayDateKey,
    p_end_date: todayDateKey,
    p_confirm_despite_conflicts: false,
  });
  if (leaveRecordError || !leaveRecord) {
    throw new Error(`建立測試請假紀錄失敗:${leaveRecordError?.message}`);
  }

  return {
    runId,
    email,
    password,
    session,
    merchantId: merchantId as string,
    staffOnLeaveId: (staffOnLeave as { id: string }).id,
    staffOnLeaveName,
    staffNormalId: (staffNormal as { id: string }).id,
    staffNormalName,
    leaveTypeId: (leaveType as { id: string }).id,
    leaveTypeName: (leaveType as { id: string; name: string }).name,
    leaveRecordId: (leaveRecord as { id: string }).id,
    todayDateKey,
    otherDateKeyInSameWeek,
  };
}

/** 把 fixture 的真實 session 灌進瀏覽器 localStorage,比照 mobile-overflow-fixture.ts 的做法。 */
export async function injectSchedulingLeaveFixtureSession(
  page: Page,
  fixture: SchedulingLeaveFixture,
): Promise<void> {
  const storageKey = getSupabaseAuthStorageKey();
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(fixture.session)] as [string, string],
  );
}

/** 4.5 測試獨立於 4.4 測試(不依賴 4.4 測試有沒有先跑過、跑到哪個階段)——4.4 測試結束時
 * 已經把 fixture 原本那筆請假紀錄取消掉了,這裡重新替 `staffOnLeaveId` 建立一筆新的(範圍一樣是
 * 「今天」),並更新 `fixture.leaveRecordId`,供 teardown 收尾時一併確保清成 cancelled。 */
export async function createStaffLeaveForCalendarTest(
  fixture: SchedulingLeaveFixture,
): Promise<void> {
  const client = createFixtureSupabaseClient();
  const { error: sessionError } = await client.auth.setSession({
    access_token: fixture.session.access_token,
    refresh_token: fixture.session.refresh_token,
  });
  if (sessionError) throw new Error(`還原測試帳號 session 失敗:${sessionError.message}`);

  const { data: leaveRecord, error } = await client.rpc("create_staff_leave", {
    p_staff_id: fixture.staffOnLeaveId,
    p_leave_type_id: fixture.leaveTypeId,
    p_start_date: fixture.todayDateKey,
    p_end_date: fixture.todayDateKey,
    p_confirm_despite_conflicts: false,
  });
  if (error || !leaveRecord) {
    throw new Error(`重新建立測試請假紀錄失敗(供 4.5 測試使用):${error?.message}`);
  }
  fixture.leaveRecordId = (leaveRecord as { id: string }).id;
}

/** 4.4 測試中段需要驗證「取消請假後恢復正常顯示」,直接呼叫跟前端相同的 cancel_staff_leave
 * RPC(不透過 UI 點擊——取消按鈕本身的互動流程已經在其他驗收過程涵蓋,見 SPECS-INDEX 編號 258;
 * 這裡要驗證的是排班一覽頁面「畫面會不會正確反映最新狀態」這件事,呼叫跟前端相同的 RPC 已經
 * 足以驗證這一點)。 */
export async function cancelFixtureLeave(fixture: SchedulingLeaveFixture): Promise<void> {
  const client = createFixtureSupabaseClient();
  const { error: sessionError } = await client.auth.setSession({
    access_token: fixture.session.access_token,
    refresh_token: fixture.session.refresh_token,
  });
  if (sessionError) throw new Error(`還原測試帳號 session 失敗:${sessionError.message}`);

  const { error } = await client.rpc("cancel_staff_leave", { p_leave_id: fixture.leaveRecordId });
  if (error) throw new Error(`取消測試請假紀錄失敗:${error.message}`);
}

/** 測試結束後盡量把 fixture 清乾淨。見檔案開頭已知限制:只能做到 RLS 允許 client 端操作的
 * 「軟停用/軟移除」,沒辦法把底層資料列真的從資料庫刪掉。回傳值列出實際做了哪些清理動作。 */
export async function teardownSchedulingLeaveFixture(
  fixture: SchedulingLeaveFixture,
): Promise<string[]> {
  const client = createFixtureSupabaseClient();
  const { error: sessionError } = await client.auth.setSession({
    access_token: fixture.session.access_token,
    refresh_token: fixture.session.refresh_token,
  });
  if (sessionError) {
    return [`警告:無法還原測試帳號 session,略過軟清理(${sessionError.message})`];
  }

  const actions: string[] = [];

  // 請假紀錄可能已經在測試中段被取消過,重複呼叫只是回傳「已經是 cancelled」的既有紀錄,
  // 不會報錯,忽略回傳的錯誤內容也沒關係(這裡的目的單純是確保它一定是 cancelled 狀態收尾)。
  await client.rpc("cancel_staff_leave", { p_leave_id: fixture.leaveRecordId });
  actions.push("已確保 fixture 請假紀錄為 cancelled 狀態");

  const { error: staffError } = await client
    .from("merchant_staff")
    .update({ status: "removed" })
    .in("id", [fixture.staffOnLeaveId, fixture.staffNormalId]);
  actions.push(
    staffError
      ? `移除 fixture 服務人員失敗:${staffError.message}`
      : "已移除 fixture 服務人員(軟刪除)",
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

  const { error: disableError } = await client
    .from("merchants")
    .update({ status: "disabled" })
    .eq("id", fixture.merchantId);
  actions.push(
    disableError ? `停用 fixture 商家失敗:${disableError.message}` : "已停用 fixture 商家(軟刪除)",
  );

  return actions;
}
