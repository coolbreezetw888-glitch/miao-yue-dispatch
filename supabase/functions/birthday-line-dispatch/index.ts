// 紅利系統重構 批次 5(#841)— Edge Function birthday-line-dispatch(排程 B)
// 對應規格書 .project/specs/紅利系統重構.md §3.7、§1.7、§2.9 第 4 點。
//
// 由 pg_cron 排程 birthday-line-dispatch-daily 每天 UTC 01:10(台北 09:10)呼叫(migration
// 20261001060000_bonus_refactor_batch5_birthday.sql)。cron 身上沒有使用者 JWT ⇒ 部署時必須
// verify_jwt = false(已寫進 supabase/config.toml,權限衛生規則 7),改用 X-Cron-Secret 共用密鑰。
//
// 流程:
//   1. 驗 X-Cron-Secret(比照 push-notify-reminder-dispatch 的 isValidCronSecret),不符回 401,
//      完全不做任何查詢或發送。
//   2. 呼叫 public.claim_birthday_line_pending(service_role 專用):資料庫那一側已經把「會員未綁 LINE」
//      「商家未連線」兩種情況直接標成略過,這裡拿到的只有真的要發的列。
//   3. 每一列:代入文案 → LINE Push → 寫 line_notification_log(event_type = 'birthday_bonus')→
//      呼叫 public.mark_birthday_line_result 回寫結果。
//   4. 失敗的列維持 failed,不自動重試(避免同一個人收到兩次);點數早在排程 A 就發好了,
//      這裡任何失敗都不會影響點數。
//
// 🔒 安全:
//   ・商家輸入的文案一律當「純文字」:LINE text message 本身不解析 HTML / Markdown;變數代入只做一次、
//     代入的值不會再被當成範本展開(會員把名字取成 "{{points}}" 也不會被二次替換);不 eval、不組 HTML。
//   ・LINE channel access token 只在記憶體中使用,不寫進 log、不回傳給呼叫端。
//   ・回應只回統計數字,不回任何會員資料。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// pushLineMessage / renderMessageTemplate 跟 line-send-marketing / line-notify-dispatch 裡的寫法
// 一致——刻意不跨 function 目錄 import(每個 function 是獨立部署單位,見 line-send-marketing 檔頭)。

export interface LinePushResult {
  ok: boolean;
  status: number;
  errorDetail: string | null;
}

/** 呼叫 LINE Push API,注入 fetch 方便測試。 */
export async function pushLineMessage(
  fetchImpl: typeof fetch,
  channelAccessToken: string,
  lineUserId: string,
  text: string,
): Promise<LinePushResult> {
  try {
    const res = await fetchImpl("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${channelAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to: lineUserId, messages: [{ type: "text", text }] }),
    });
    if (res.ok) {
      return { ok: true, status: res.status, errorDetail: null };
    }
    const errorBody = await res.text().catch(() => "");
    return { ok: false, status: res.status, errorDetail: `HTTP ${res.status} ${errorBody}`.trim() };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      errorDetail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** {{變數}} 範本替換(單次、不遞迴;不認得的變數原樣保留)。 */
export function renderMessageTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match;
  });
}

/** LINE 文字訊息上限 5000 字;文案本身 ≤ 1000 字,這裡只是防止姓名 / 店名異常過長時整則被 LINE 退件。 */
export const LINE_TEXT_MAX_LENGTH = 5000;

/** 代入生日文案的三個變數,並整理成可以送出的純文字。 */
export function renderBirthdayMessage(row: {
  message_template: string;
  member_name: string;
  points: number;
  merchant_name: string;
}): string {
  const text = renderMessageTemplate(row.message_template ?? "", {
    member_name: row.member_name ?? "",
    points: String(row.points ?? ""),
    merchant_name: row.merchant_name ?? "",
  });
  return Array.from(text).slice(0, LINE_TEXT_MAX_LENGTH).join("");
}

/** 比對 X-Cron-Secret;環境變數沒設時一律擋下(避免空字串比對空字串放行)。 */
export function isValidCronSecret(headerValue: string | null, expected: string): boolean {
  if (!expected) return false;
  if (headerValue === null || headerValue.length !== expected.length) return false;
  // 固定時間比對,不因第一個不同字元的位置提早結束。
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= headerValue.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export interface ClaimedBirthdayRow {
  grant_id: string;
  merchant_id: string;
  member_id: string;
  line_user_id: string;
  channel_access_token: string;
  message_template: string;
  member_name: string;
  points: number;
  merchant_name: string;
}

export interface BirthdayLogInsert {
  merchant_id: string;
  event_type: "birthday_bonus";
  target_type: "member";
  target_id: string;
  target_line_user_id: string;
  status: "sent" | "failed";
  error_detail: string | null;
  rendered_message: string;
}

/** 資料庫端的三個動作,注入進來方便測試(正式環境由 buildDbDeps 用 service_role client 實作)。 */
export interface BirthdayDispatchDb {
  claimPending(limit: number): Promise<ClaimedBirthdayRow[]>;
  insertLog(row: BirthdayLogInsert): Promise<string | null>;
  markResult(grantId: string, status: "sent" | "failed", error: string | null, logId: string | null): Promise<void>;
}

export interface DispatchSummary {
  claimed: number;
  sent: number;
  failed: number;
}

export const CLAIM_BATCH_SIZE = 100;
/** 單次執行最多處理幾批(防呆:正常一天的生日人數遠低於此)。 */
export const MAX_BATCHES = 50;

/** 主流程(不含 HTTP / 密鑰),獨立出來方便測試。 */
export async function runBirthdayDispatch(
  db: BirthdayDispatchDb,
  fetchImpl: typeof fetch,
): Promise<DispatchSummary> {
  const summary: DispatchSummary = { claimed: 0, sent: 0, failed: 0 };

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const rows = await db.claimPending(CLAIM_BATCH_SIZE);
    summary.claimed += rows.length;

    for (const row of rows) {
      const text = renderBirthdayMessage(row);
      let result: LinePushResult;
      if (text.trim() === "") {
        // 商家把文案清成空白:LINE 不收空訊息,直接記失敗,不打 LINE。
        result = { ok: false, status: 0, errorDetail: "生日 LINE 文案是空白，沒有發送" };
      } else {
        result = await pushLineMessage(fetchImpl, row.channel_access_token, row.line_user_id, text);
      }
      const status: "sent" | "failed" = result.ok ? "sent" : "failed";

      let logId: string | null = null;
      try {
        logId = await db.insertLog({
          merchant_id: row.merchant_id,
          event_type: "birthday_bonus",
          target_type: "member",
          target_id: row.member_id,
          target_line_user_id: row.line_user_id,
          status,
          error_detail: result.ok ? null : result.errorDetail,
          rendered_message: text,
        });
      } catch (err) {
        console.error("[birthday-line-dispatch] 寫入 line_notification_log 失敗", row.grant_id, err);
      }

      try {
        await db.markResult(row.grant_id, status, result.ok ? null : result.errorDetail, logId);
      } catch (err) {
        // 回寫失敗:這筆維持「已認領、pending」,30 分鐘後下一次認領會把它標成 failed(不重送)。
        console.error("[birthday-line-dispatch] 回寫結果失敗", row.grant_id, err);
      }

      if (result.ok) summary.sent += 1;
      else summary.failed += 1;
    }

    if (rows.length < CLAIM_BATCH_SIZE) break;
  }

  return summary;
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// deno-lint-ignore no-explicit-any
type AnySupabaseClient = any;

export function buildDbDeps(adminClient: AnySupabaseClient): BirthdayDispatchDb {
  return {
    async claimPending(limit) {
      const { data, error } = await adminClient.rpc("claim_birthday_line_pending", { p_limit: limit });
      if (error) throw error;
      return (data ?? []) as ClaimedBirthdayRow[];
    },
    async insertLog(row) {
      const { data, error } = await adminClient
        .from("line_notification_log")
        .insert(row)
        .select("id")
        .single();
      if (error) throw error;
      return (data?.id as string) ?? null;
    },
    async markResult(grantId, status, errorText, logId) {
      const { error } = await adminClient.rpc("mark_birthday_line_result", {
        p_grant_id: grantId,
        p_status: status,
        p_error: errorText,
        p_log_id: logId,
      });
      if (error) throw error;
    },
  };
}

export interface HandleRequestDeps {
  db?: BirthdayDispatchDb;
  fetchImpl?: typeof fetch;
}

export async function handleRequest(req: Request, deps?: HandleRequestDeps): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "只接受 POST 請求" }, 405);
  }

  const expectedSecret = Deno.env.get("BIRTHDAY_LINE_CRON_SECRET") ?? "";
  if (!isValidCronSecret(req.headers.get("X-Cron-Secret"), expectedSecret)) {
    return jsonResponse({ error: "未授權" }, 401);
  }

  let db = deps?.db;
  if (!db) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("[birthday-line-dispatch] 缺少必要的環境變數");
      return jsonResponse({ error: "伺服器設定不完整" }, 500);
    }
    db = buildDbDeps(createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } }));
  }

  try {
    const summary = await runBirthdayDispatch(db, deps?.fetchImpl ?? fetch);
    return jsonResponse({ ...summary }, 200);
  } catch (err) {
    console.error("[birthday-line-dispatch] 執行失敗", err);
    return jsonResponse({ error: "執行失敗" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
