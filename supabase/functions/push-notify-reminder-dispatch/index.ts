// 模組 15(服務人員推播通知)— Edge Function push-notify-reminder-dispatch
// 對應規格書 7.7,第五節排程機制,規則 4.8(排程共用密鑰),2.4(冪等表)。
//
// 這支函式不是由瀏覽器呼叫,是由資料庫的 pg_cron 排程任務在背景呼叫(見 migration
// 20260922100200_push_notifications_cron.sql),天生沒有任何使用者的 JWT 可以驗證——改用規則
// 4.8 的共用密鑰(X-Cron-Secret 標頭)。
//
// 流程:
//   1. 驗證共用密鑰,不符合直接回 401,完全不執行任何查詢或發送。
//   2. 查詢「明天(台北時區)」的所有已確認(status='accepted')且已指定服務人員的訂單。
//   3. 對每一筆訂單,先寫入 push_reminder_dedupe_log(booking_id, reminder_date=今天台北日期),
//      插入失敗(已經處理過)直接跳過這筆,插入成功才繼續。
//   4. 呼叫共用的 dispatchPushForBooking(跟 push-notify-dispatch 完全一樣的判斷/發送/記錄邏輯)。
//
// ⚠️ 實作偏離規格書之處:規格書 7.7 步驟 2 的示意 SQL 寫 `status = 'confirmed'`,查證
// bookings.status 的實際 CHECK 約束後,這個系統沒有 'confirmed' 這個值,對應「已確認」的實際
// 資料庫值是 'accepted'(模組 6 決策記錄 5:只改畫面顯示文字成「已確認」,資料庫欄位值維持
// 'accepted' 不改名)。這裡查詢用 'accepted',不是規格書字面上的 'confirmed'。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

import { dispatchPushForBooking } from "../_shared/pushDispatchCore.ts";
import { buildPushDispatchDeps } from "../_shared/pushDbAdapter.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "";
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const PUSH_REMINDER_CRON_SECRET = Deno.env.get("PUSH_REMINDER_CRON_SECRET") ?? "";

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 規則 4.8 步驟 3:比對 X-Cron-Secret 標頭是否等於環境變數裡的密鑰。獨立成純函式方便測試。 */
export function isValidCronSecret(headerValue: string | null, expected: string): boolean {
  if (!expected) return false;
  return headerValue === expected;
}

export interface TaipeiTomorrowRange {
  /** 明天(台北時區)00:00 對應的真實 UTC 時間戳(毫秒),查詢 start_at >= 這個值。 */
  tomorrowStartUtcMs: number;
  /** 明天(台北時區)24:00(即後天 00:00)對應的真實 UTC 時間戳,查詢 start_at < 這個值。 */
  tomorrowEndUtcMs: number;
  /** 今天(台北時區)的日期字串 'YYYY-MM-DD',寫入 push_reminder_dedupe_log.reminder_date 用。 */
  todayTaipeiDate: string;
}

/** 純函式:給定「現在」的時間戳,算出「明天(台北時區)」的查詢邊界跟「今天(台北時區)」日期。
 * 抽出來方便 Deno 測試,不依賴 `new Date()` 的當下時間。 */
export function computeTaipeiTomorrowRange(nowUtcMs: number): TaipeiTomorrowRange {
  const taipeiNowMs = nowUtcMs + TAIPEI_OFFSET_MS;
  const taipeiNowDate = new Date(taipeiNowMs);
  const taipeiTodayLocalMidnightMs = Date.UTC(
    taipeiNowDate.getUTCFullYear(),
    taipeiNowDate.getUTCMonth(),
    taipeiNowDate.getUTCDate(),
  );
  const tomorrowStartLocalMs = taipeiTodayLocalMidnightMs + ONE_DAY_MS;
  const tomorrowStartUtcMs = tomorrowStartLocalMs - TAIPEI_OFFSET_MS;
  const tomorrowEndUtcMs = tomorrowStartUtcMs + ONE_DAY_MS;

  const y = taipeiNowDate.getUTCFullYear();
  const m = String(taipeiNowDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(taipeiNowDate.getUTCDate()).padStart(2, "0");

  return { tomorrowStartUtcMs, tomorrowEndUtcMs, todayTaipeiDate: `${y}-${m}-${d}` };
}

interface UpcomingBookingRow {
  id: string;
  merchant_id: string;
  staff_id: string;
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "只接受 POST 請求" }, 405);
  }

  const cronSecretHeader = req.headers.get("X-Cron-Secret");
  if (!isValidCronSecret(cronSecretHeader, PUSH_REMINDER_CRON_SECRET)) {
    return jsonResponse({ error: "未授權" }, 401);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[push-notify-reminder-dispatch] 缺少必要的環境變數");
    return jsonResponse({ error: "伺服器設定不完整" }, 500);
  }
  if (!VAPID_SUBJECT || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.error(
      "[push-notify-reminder-dispatch] 缺少 VAPID 環境變數,尚未完成規則 4.2 的一次性設定",
    );
    return jsonResponse({ error: "伺服器設定不完整" }, 500);
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { tomorrowStartUtcMs, tomorrowEndUtcMs, todayTaipeiDate } = computeTaipeiTomorrowRange(
    Date.now(),
  );

  const { data: bookings, error: bookingsError } = await adminClient
    .from("bookings")
    .select("id, merchant_id, staff_id")
    .eq("status", "accepted")
    .not("staff_id", "is", null)
    .gte("start_at", new Date(tomorrowStartUtcMs).toISOString())
    .lt("start_at", new Date(tomorrowEndUtcMs).toISOString());

  if (bookingsError) {
    console.error("[push-notify-reminder-dispatch] 查詢明天訂單失敗", bookingsError);
    return jsonResponse({ error: "查詢明天訂單時發生錯誤" }, 500);
  }

  const upcomingBookings = (bookings ?? []) as UpcomingBookingRow[];

  const deps = buildPushDispatchDeps(adminClient, {
    subject: VAPID_SUBJECT,
    publicKey: VAPID_PUBLIC_KEY,
    privateKey: VAPID_PRIVATE_KEY,
  });

  let processedCount = 0;
  let dedupedCount = 0;

  for (const booking of upcomingBookings) {
    // 2.4:插入冪等紀錄,插入成功(回傳這一筆)才繼續發送,插入失敗(已經處理過,回傳空陣列)
    // 直接跳過這筆。用 upsert + ignoreDuplicates,靠複合主鍵 (booking_id, reminder_date) 判斷。
    const { data: dedupeRows, error: dedupeError } = await adminClient
      .from("push_reminder_dedupe_log")
      .upsert(
        { booking_id: booking.id, reminder_date: todayTaipeiDate },
        { onConflict: "booking_id,reminder_date", ignoreDuplicates: true },
      )
      .select();

    if (dedupeError) {
      console.error("[push-notify-reminder-dispatch] 寫入冪等紀錄失敗", booking.id, dedupeError);
      continue;
    }
    if (!dedupeRows || dedupeRows.length === 0) {
      dedupedCount += 1;
      continue;
    }

    await dispatchPushForBooking(deps, {
      merchantId: booking.merchant_id,
      bookingId: booking.id,
      eventType: "booking_reminder_next_day",
    });
    processedCount += 1;
  }

  return jsonResponse(
    { totalUpcoming: upcomingBookings.length, processedCount, dedupedCount },
    200,
  );
}

if (import.meta.main) {
  Deno.serve(handleRequest);
}
