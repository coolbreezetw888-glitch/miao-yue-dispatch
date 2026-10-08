// 客戶端第 5-A 批 — Edge Function customer-line-notify-dispatch(C5-S05、S06)
// 規格書 .project/specs/客戶端第5批-LINE通知與綁定.md 第二節、C5-S04 / S05 / S06、X02。
//
// 由 pg_cron 排程 customer-line-dispatch-every-minute 每分鐘呼叫(只有待發清單有到期列、而且 Vault 有
// customer_line_cron_secret 時才會呼叫)。cron 身上沒有使用者 JWT ⇒ verify_jwt = false(寫在 config.toml,
// 權限衛生規則 7),改驗 X-Cron-Secret(Edge secret CUSTOMER_LINE_CRON_SECRET;沒設 ⇒ 一律 401、什麼都不發)。
//
// 流程(每一批最多 50 列,一次最多 4 批):
//   1. internal_claim_customer_line_outbox:領到期列(skip locked)、標 processing。
//   2. internal_prepare_customer_line_job:資料庫重新檢查(過時 / 時間改回)、算收件人、給範本 + 變數 + 這間店的 token。
//   3. 每位收件人 LINE push,帶 X-Line-Retry-Key(由 outbox_id + 收件人算出、重試時同一把)⇒ LINE 不會重複發。
//   4. 每位收件人寫一筆 line_notification_log(略過的也寫)。
//   5. internal_finish_customer_line_job:sent / skipped / failed / retry(5xx、網路、429 太頻繁)/ quota_exhausted(429 每月額度)。
//
// LINE 回應怎麼分(2026-10 查 LINE Messaging API 文件):
//   ・2xx ⇒ 成功。409 ⇒ 同一把 retry key 的請求 LINE 已經收過(之前其實送出去了)⇒ 當成功,不重送。
//   ・429 + message 含 "monthly limit"(You have reached your monthly limit.)⇒ 本月額度用完:不重試、整店停發。
//     其他 429(The API rate limit has been exceeded...)⇒ 太頻繁:當暫時錯誤重試。
//   ・5xx / 連線失敗 ⇒ 暫時錯誤(1、5、15 分鐘後重試,共 3 次)。
//   ・其他 4xx(例如對方 userId 無效)⇒ 該收件人 failed,不重試。
//   ⚠️ 傳給已封鎖 / 非好友的人 LINE 回什麼、算不算則數、兩種 429 的實際內容,要用真 LINE 實測(C5-T04)。
//
// 🔒 安全(C5-X02):
//   ・token 只在記憶體使用:不寫 log、不寫 error_detail / last_error、不回應。
//   ・console 只印 outbox id 與數字,不印 token / LINE userId / 電話 / 訊息內容。
//   ・回應只回統計數字。
//   ・pushLineMessage / renderMessageTemplate 跟其他 LINE function 一樣各寫一份(不跨 function import),這支多 retry key。

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

import { isLocalSupabaseUrl, siteOrigin } from "../_shared/customerOrigin.ts";

// =========================================================================
// 純函式
// =========================================================================

/** 比對 X-Cron-Secret;環境變數沒設時一律擋下。固定時間比對。 */
export function isValidCronSecret(headerValue: string | null, expected: string): boolean {
  if (!expected) return false;
  if (headerValue === null || headerValue.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= headerValue.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** {{變數}} 單次替換(不遞迴;不認得的原樣保留)。店家這邊(模組 11 範本)用這支,行為跟 line-notify-dispatch 一致。 */
export function renderMessageTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match;
  });
}

export const LINE_TEXT_MAX_LENGTH = 5000;

/**
 * C5-N13 客人通知的代入規則(前端預覽照同一套,見 .project/notes/c5-contract.md 2-3):
 *   1. merchant_phone 是空的 ⇒ 範本裡含 {{merchant_phone}} 的那一整行拿掉。
 *   2. 每個值裡的換行換成半形空白、去頭尾空白。
 *   3. 單次替換、不遞迴。
 *   4. 截到 5,000 字(Unicode 字元)。
 */
export function renderCustomerLineMessage(template: string, variables: Record<string, string>): string {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(variables)) {
    clean[k] = String(v ?? "").replace(/[\r\n]+/g, " ").trim();
  }
  let source = template ?? "";
  if (!clean.merchant_phone) {
    source = source.split("\n").filter((line) => !line.includes("{{merchant_phone}}")).join("\n");
  }
  const text = renderMessageTemplate(source, clean);
  return Array.from(text).slice(0, LINE_TEXT_MAX_LENGTH).join("");
}

/** 會員中心網址:<網站>/booking/<代碼>/me/bookings;網站網址沒設 ⇒ 空字串。 */
export function memberCenterUrl(site: string | null, slug: string | null | undefined): string {
  if (!site || !slug) return "";
  return `${site}/booking/${encodeURIComponent(slug)}/me/bookings`;
}

/**
 * X-Line-Retry-Key:LINE 要求 UUID 格式(任何版本皆可),24 小時內同一把 key 的重送會回 409 而不重複發。
 * 由 outbox_id + 收件人 userId 做 SHA-256,取前 16 bytes 套 UUID v4 版本 / variant 位元 ⇒ 重試時一定同一把。
 */
export async function lineRetryKey(outboxId: string, to: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`c5:${outboxId}:${to}`)),
  );
  const b = digest.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type PushKind = "ok" | "quota" | "transient" | "permanent";
export interface LinePushResult {
  kind: PushKind;
  status: number;
  errorDetail: string | null;
}

/** 錯誤內容:截 500 字、遮掉任何長得像 LINE userId 的字串(token 本來就不會在 LINE 的回應裡)。 */
export function sanitizeError(text: string): string {
  return Array.from(text.replace(/U[0-9a-f]{32}/g, "U***")).slice(0, 500).join("");
}

export function classifyLineResponse(status: number, bodyText: string): PushKind {
  if ((status >= 200 && status < 300) || status === 409) return "ok";
  if (status === 429) {
    let message = "";
    try {
      message = String((JSON.parse(bodyText) as { message?: unknown })?.message ?? "");
    } catch {
      message = bodyText;
    }
    return /monthly limit/i.test(message) ? "quota" : "transient";
  }
  if (status === 0 || status >= 500) return "transient";
  return "permanent";
}

/** LINE Push(注入 fetch 方便測試)。 */
export async function pushLineMessage(
  fetchImpl: typeof fetch,
  apiBase: string,
  channelAccessToken: string,
  lineUserId: string,
  text: string,
  retryKey: string,
): Promise<LinePushResult> {
  try {
    const res = await fetchImpl(`${apiBase}/v2/bot/message/push`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${channelAccessToken}`,
        "Content-Type": "application/json",
        "X-Line-Retry-Key": retryKey,
      },
      body: JSON.stringify({ to: lineUserId, messages: [{ type: "text", text }] }),
    });
    const body = res.ok ? "" : await res.text().catch(() => "");
    const kind = classifyLineResponse(res.status, body);
    return {
      kind,
      status: res.status,
      errorDetail: kind === "ok" ? null : sanitizeError(`HTTP ${res.status} ${body}`.trim()),
    };
  } catch (err) {
    return {
      kind: "transient",
      status: 0,
      errorDetail: sanitizeError(err instanceof Error ? err.message : String(err)),
    };
  }
}

/** LINE API 網址:正式一律官方;只有 SUPABASE_URL 是本機 + LINE_MOCK_MODE=1 才用假端點(比照 C2-F08)。 */
export function resolveLineApiBase(env: (k: string) => string | undefined): string {
  const official = "https://api.line.me";
  if (env("LINE_MOCK_MODE") !== "1" || !isLocalSupabaseUrl(env("SUPABASE_URL"))) return official;
  return (env("LINE_MOCK_API_BASE") || official).replace(/\/+$/, "");
}

// =========================================================================
// 資料庫介面
// =========================================================================

export interface PreparedRecipient {
  to: string;
  target_type: "member" | "admin" | "agent" | "staff";
  target_id: string | null;
  target_user_id: string | null;
}
export interface PreparedSkipped {
  target_type: "member" | "admin" | "agent" | "staff";
  target_id: string | null;
  target_user_id: string | null;
  reason: string;
}
export interface PreparedJob {
  state: "send" | "stale" | "superseded" | "skip" | "not_claimed";
  reason?: string;
  outbox_id?: string;
  kind?: string;
  merchant_id?: string;
  booking_id?: string | null;
  member_id?: string | null;
  attempts?: number;
  log_event_type?: string;
  channel_access_token?: string;
  template_code?: string | null;
  template?: string;
  variables?: Record<string, string>;
  slug?: string | null;
  recipients?: PreparedRecipient[];
  skipped?: PreparedSkipped[];
}

export interface LogInsert {
  merchant_id: string;
  event_type: string;
  booking_id: string | null;
  target_type: string;
  target_id: string | null;
  target_user_id: string | null;
  target_line_user_id: string | null;
  status: "sent" | "failed" | "skipped";
  skip_reason: string | null;
  error_detail: string | null;
  rendered_message: string | null;
  outbox_id: string;
}

export type FinishOutcome = "sent" | "skipped" | "failed" | "retry" | "quota_exhausted";

export interface CustomerLineDb {
  claim(limit: number): Promise<string[]>;
  prepare(outboxId: string): Promise<PreparedJob>;
  insertLog(row: LogInsert): Promise<void>;
  finish(outboxId: string, outcome: FinishOutcome, error: string | null): Promise<void>;
}

export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface DispatchSummary {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  retried: number;
  quota_exhausted: number;
}

export const CLAIM_BATCH_SIZE = 50;
export const MAX_BATCHES = 4;
const MAX_ATTEMPTS = 3;

// =========================================================================
// 主流程
// =========================================================================

export async function processJob(
  db: CustomerLineDb,
  fetchImpl: typeof fetch,
  apiBase: string,
  site: string | null,
  outboxId: string,
  summary: DispatchSummary,
  log: Logger,
): Promise<void> {
  const job = await db.prepare(outboxId);
  if (job.state === "not_claimed") return;

  if (job.state === "skip") {
    await db.finish(outboxId, "skipped", job.reason ?? null);
    summary.skipped += 1;
    return;
  }

  const isCustomerKind = (job.kind ?? "").startsWith("customer_");

  if (job.state === "stale" || job.state === "superseded") {
    if (isCustomerKind) {
      await db.insertLog({
        merchant_id: job.merchant_id!,
        event_type: job.kind!,
        booking_id: job.booking_id ?? null,
        target_type: "member",
        target_id: job.member_id ?? null,
        target_user_id: null,
        target_line_user_id: null,
        status: "skipped",
        skip_reason: job.state,
        error_detail: null,
        rendered_message: null,
        outbox_id: outboxId,
      });
    }
    await db.finish(outboxId, "skipped", job.state);
    summary.skipped += 1;
    return;
  }

  const eventType = job.log_event_type ?? job.kind ?? "";
  const baseLog = {
    merchant_id: job.merchant_id!,
    event_type: eventType,
    booking_id: job.booking_id ?? null,
    outbox_id: outboxId,
  };

  for (const s of job.skipped ?? []) {
    await db.insertLog({
      ...baseLog,
      target_type: s.target_type,
      target_id: s.target_id,
      target_user_id: s.target_user_id,
      target_line_user_id: null,
      status: "skipped",
      skip_reason: s.reason,
      error_detail: null,
      rendered_message: null,
    });
  }

  const recipients = job.recipients ?? [];
  if (recipients.length === 0) {
    await db.finish(outboxId, "skipped", (job.skipped ?? []).length ? null : "no_recipient");
    summary.skipped += 1;
    return;
  }

  const variables = { ...(job.variables ?? {}) };
  let text: string;
  if (isCustomerKind) {
    variables.member_center_url = memberCenterUrl(site, job.slug);
    text = renderCustomerLineMessage(job.template ?? "", variables);
  } else {
    text = renderMessageTemplate(job.template ?? "", variables);
  }

  const recipientLog = (r: PreparedRecipient) => ({
    ...baseLog,
    target_type: r.target_type,
    target_id: r.target_id,
    target_user_id: r.target_user_id,
    target_line_user_id: r.to,
  });

  if (text.trim() === "") {
    for (const r of recipients) {
      await db.insertLog({
        ...recipientLog(r),
        status: "failed",
        skip_reason: null,
        error_detail: "通知文字是空白，沒有發送",
        rendered_message: null,
      });
    }
    await db.finish(outboxId, "failed", "empty_message");
    summary.failed += 1;
    return;
  }

  let sent = 0;
  let failed = 0;
  let quotaHit = false;
  const transient: { r: PreparedRecipient; error: string | null }[] = [];

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const result = await pushLineMessage(
      fetchImpl,
      apiBase,
      job.channel_access_token ?? "",
      r.to,
      text,
      await lineRetryKey(outboxId, r.to),
    );
    if (result.kind === "ok") {
      sent += 1;
      await db.insertLog({ ...recipientLog(r), status: "sent", skip_reason: null, error_detail: null, rendered_message: text });
    } else if (result.kind === "permanent") {
      failed += 1;
      await db.insertLog({
        ...recipientLog(r),
        status: "failed",
        skip_reason: null,
        error_detail: result.errorDetail,
        rendered_message: text,
      });
    } else if (result.kind === "transient") {
      transient.push({ r, error: result.errorDetail });
    } else {
      // 本月額度用完:這一位與還沒發的、等著重試的,全部略過(quota_exhausted),不重試。
      quotaHit = true;
      const rest = [...transient.map((t) => t.r), ...recipients.slice(i)];
      for (const x of rest) {
        await db.insertLog({ ...recipientLog(x), status: "skipped", skip_reason: "quota_exhausted", error_detail: null, rendered_message: null });
      }
      break;
    }
  }

  if (quotaHit) {
    log.warn(`[customer-line-notify-dispatch] LINE 本月額度用完(outbox ${outboxId})，這間店停發到下個月`);
    await db.finish(outboxId, "quota_exhausted", "quota_exhausted");
    summary.quota_exhausted += 1;
    return;
  }

  if (transient.length > 0) {
    const lastError = transient[transient.length - 1].error;
    if ((job.attempts ?? 0) >= MAX_ATTEMPTS) {
      for (const t of transient) {
        await db.insertLog({ ...recipientLog(t.r), status: "failed", skip_reason: null, error_detail: t.error, rendered_message: text });
      }
      await db.finish(outboxId, "failed", lastError);
      summary.failed += 1;
    } else {
      await db.finish(outboxId, "retry", lastError);
      summary.retried += 1;
    }
    return;
  }

  if (sent > 0) {
    await db.finish(outboxId, "sent", failed > 0 ? "partial_failed" : null);
    summary.sent += 1;
  } else {
    await db.finish(outboxId, "failed", "all_failed");
    summary.failed += 1;
  }
}

export async function runCustomerLineDispatch(
  db: CustomerLineDb,
  fetchImpl: typeof fetch,
  apiBase: string,
  site: string | null,
  log: Logger,
): Promise<DispatchSummary> {
  const summary: DispatchSummary = { claimed: 0, sent: 0, skipped: 0, failed: 0, retried: 0, quota_exhausted: 0 };
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const ids = await db.claim(CLAIM_BATCH_SIZE);
    summary.claimed += ids.length;
    for (const id of ids) {
      try {
        await processJob(db, fetchImpl, apiBase, site, id, summary, log);
      } catch (_err) {
        // 單一列出錯不中斷整批;那一列留在 processing,10 分鐘後下一次領取時放回 pending(attempts + 1)。
        log.error(`[customer-line-notify-dispatch] 處理失敗(outbox ${id})`);
      }
    }
    if (ids.length < CLAIM_BATCH_SIZE) break;
  }
  return summary;
}

// deno-lint-ignore no-explicit-any
type AnySupabaseClient = any;

export function buildDbDeps(client: AnySupabaseClient): CustomerLineDb {
  return {
    async claim(limit) {
      const { data, error } = await client.rpc("internal_claim_customer_line_outbox", { p_limit: limit });
      if (error) throw new Error("claim failed");
      return ((data ?? []) as { id: string }[]).map((r) => r.id);
    },
    async prepare(outboxId) {
      const { data, error } = await client.rpc("internal_prepare_customer_line_job", { p_outbox_id: outboxId });
      if (error) throw new Error("prepare failed");
      return (data ?? { state: "not_claimed" }) as PreparedJob;
    },
    async insertLog(row) {
      const { error } = await client.from("line_notification_log").insert(row);
      if (error) throw new Error("insert log failed");
    },
    async finish(outboxId, outcome, errorText) {
      const { error } = await client.rpc("internal_finish_customer_line_job", {
        p_outbox_id: outboxId,
        p_outcome: outcome,
        p_error: errorText,
      });
      if (error) throw new Error("finish failed");
    },
  };
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export interface HandleRequestDeps {
  env?: (k: string) => string | undefined;
  db?: CustomerLineDb;
  fetchImpl?: typeof fetch;
  log?: Logger;
}

export async function handleRequest(req: Request, deps?: HandleRequestDeps): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "只接受 POST 請求" }, 405);
  }
  const env = deps?.env ?? ((k: string) => Deno.env.get(k));
  const log = deps?.log ?? console;

  if (!isValidCronSecret(req.headers.get("X-Cron-Secret"), env("CUSTOMER_LINE_CRON_SECRET") ?? "")) {
    return jsonResponse({ error: "未授權" }, 401);
  }

  let db = deps?.db;
  if (!db) {
    const supabaseUrl = env("SUPABASE_URL") ?? "";
    const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !serviceRoleKey) {
      log.error("[customer-line-notify-dispatch] 缺少必要的環境變數");
      return jsonResponse({ error: "伺服器設定不完整" }, 500);
    }
    db = buildDbDeps(createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } }));
  }

  try {
    const summary = await runCustomerLineDispatch(
      db,
      deps?.fetchImpl ?? fetch,
      resolveLineApiBase(env),
      siteOrigin(env),
      log,
    );
    return jsonResponse({ ...summary }, 200);
  } catch (_err) {
    log.error("[customer-line-notify-dispatch] 執行失敗");
    return jsonResponse({ error: "執行失敗" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
