// 客戶端第 3 批(C3)本機 e2e fixture:送出預約(會員 / 訪客)、完成頁、後台標示、順位、完成頁文字設定。
// 規格書:.project/specs/客戶端第3批-送出預約與通知店家.md(🔴 零之零優先);介面:.project/notes/c3-contract.md。
// 只在 playwright.local.config.ts 底下用,只連本機 Docker 的 Supabase。
//
// 沿用第 2 批 fixture(A 到府 + 啟用 LINE 登入 + 會員政策;B 到店、沒有 LINE 登入;C 停用),再加上:
//   ・A 的服務人員「阿明」開通登入(服務人員端預約詳細的截圖 / 標籤用)。
//
// 不跑真的 Edge Function(c3-contract 第 7 節):
//   ・/functions/v1/customer-booking-submit 用 page.route 攔下,在 Node 端用本機 service role 直接呼叫
//     internal_customer_submit_booking(資料庫核心,所有規則都在裡面),🔴 回給頁面前刪掉 `_internal`。
//   ・會員:用 admin.auth.getUser(token) 驗客人 token(跟 Edge 一樣看 app_metadata.account_type)。
//   ・訪客:Turnstile token 不是官方測試 token「XXXX.DUMMY.TOKEN.XXXX」⇒ 回 bot_check_failed(模擬伺服器驗證失敗)。
//   ・Turnstile 腳本(challenges.cloudflare.com)也攔下,換成假的 window.turnstile(本機瀏覽器本來就連不到外網)。
//
// teardown:先刪本 fixture 多建的服務人員登入帳號(email 格式核對),再走第 2 批 teardown
// (商家 / 訂單 / 會員 / 通知 / 同意紀錄都跟著商家一起硬刪除;刪前 SELECT 核對、刪後再 SELECT)。
import type { Page, Route } from "@playwright/test";
import type { Session } from "@supabase/supabase-js";

import { anonClient, serviceClient } from "./c1-public-booking-fixture";
import { setupC2Fixture, teardownC2Fixture, type C2Fixture } from "./c2-line-login-fixture";

export const TURNSTILE_PASS_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const STAFF_EMAIL_RE = /^e2e-c3staff-\d+@example-local-test\.test$/;

export interface C3Fixture {
  c2: C2Fixture;
  staffUser: { userId: string; email: string; session: Session };
}

function must<T>(label: string, data: T | null | undefined, error: { message: string } | null): T {
  if (error || data === null || data === undefined) {
    throw new Error(`${label}失敗:${error?.message ?? "沒有回傳資料"}`);
  }
  return data;
}

export async function setupC3Fixture(): Promise<C3Fixture> {
  const c2 = await setupC2Fixture();
  const svc = serviceClient();
  try {
    const email = `e2e-c3staff-${c2.runId}@example-local-test.test`;
    const r = await anonClient().auth.signUp({ email, password: `E2eC3Staff!${c2.runId}Aa` });
    const session = must("建立服務人員帳號", r.data.session, r.error);
    const invite = await svc.rpc("record_invited_staff_login", {
      p_staff_id: c2.c1.staffMingId,
      p_user_id: session.user.id,
      p_invited_login_email: email,
      p_login_status: "active",
    });
    if (invite.error) throw new Error(`開通服務人員登入失敗:${invite.error.message}`);
    return { c2, staffUser: { userId: session.user.id, email, session } };
  } catch (err) {
    await teardownC2Fixture(c2).catch((e) => console.error("[c3 fixture] 清理半成品失敗:", e));
    throw err;
  }
}

export async function teardownC3Fixture(fixture: C3Fixture): Promise<string[]> {
  const svc = serviceClient();
  const actions: string[] = [];
  const u = await svc.auth.admin.getUserById(fixture.staffUser.userId);
  if (!STAFF_EMAIL_RE.test(u.data.user?.email ?? "")) {
    throw new Error(`teardown 中止:${fixture.staffUser.userId} 不是本 fixture 的服務人員帳號`);
  }
  // 商家硬刪除時 merchant_staff 會一起刪;帳號最後再刪(先解除 user_id 對應,避免外鍵擋)。
  const unlink = await svc
    .from("merchant_staff")
    .update({ user_id: null, login_status: "not_invited" })
    .eq("id", fixture.c2.c1.staffMingId)
    .eq("user_id", fixture.staffUser.userId)
    .select("id");
  if (unlink.error) throw new Error(`teardown 解除服務人員登入失敗:${unlink.error.message}`);
  actions.push(...(await teardownC2Fixture(fixture.c2)));
  const del = await svc.auth.admin.deleteUser(fixture.staffUser.userId);
  if (del.error) throw new Error(`teardown 刪服務人員帳號失敗:${del.error.message}`);
  const left = (await svc.auth.admin.getUserById(fixture.staffUser.userId)).data.user ? 1 : 0;
  if (left !== 0) throw new Error("teardown 後服務人員帳號仍在");
  actions.push("已刪除本 fixture 的服務人員登入帳號 1 個(刪後核對 0)");
  return actions;
}

// =========================================================================
// 模擬 Edge Function customer-booking-submit(c3-contract 第 7 節)
// =========================================================================

export interface MockSubmit {
  requests: Record<string, unknown>[];
  /** 回給頁面的原文(搜哨兵、確認沒有 _internal)。 */
  responseBodies: string[];
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export async function mockBookingSubmit(page: Page): Promise<MockSubmit> {
  const record: MockSubmit = { requests: [], responseBodies: [] };
  const svc = serviceClient();

  async function reply(route: Route, status: number, body: Record<string, unknown>) {
    const text = JSON.stringify(body);
    record.responseBodies.push(text);
    await route.fulfill({
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: text,
    });
  }

  await page.route("**/functions/v1/customer-booking-submit", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    record.requests.push(body);
    const guest = (body["guest"] ?? null) as Record<string, unknown> | null;
    const auth = req.headers()["authorization"] ?? "";
    let userId: string | null = null;
    if (!guest) {
      const token = auth.replace(/^Bearer\s+/i, "");
      if (!token) return reply(route, 400, { state: "invalid_request" });
      const { data } = await svc.auth.getUser(token);
      if (data.user?.app_metadata?.["account_type"] !== "customer") {
        return reply(route, 200, { state: "not_linked" });
      }
      userId = data.user.id;
    } else if (guest["turnstile_token"] !== TURNSTILE_PASS_TOKEN) {
      return reply(route, 200, { state: "bot_check_failed" });
    }
    const { data, error } = await svc.rpc("internal_customer_submit_booking", {
      p_slug: body["slug"],
      p_user_id: userId,
      p_guest_phone: guest ? (guest["phone"] ?? null) : null,
      p_draft: body["draft"],
      p_agree_policy: guest ? guest["agree_policy"] === true : true,
      p_submission_id: body["submission_id"],
    });
    if (error) return reply(route, 400, { state: "invalid_request", hint: error.hint ?? null });
    // 🔴 c3-contract:一定要刪掉 _internal(booking_id、member、推播文字)再回給客人。
    const { _internal, ...result } = (data ?? {}) as Record<string, unknown>;
    void _internal;
    return reply(route, 200, result);
  });
  return record;
}

// =========================================================================
// 假的 Cloudflare Turnstile(本機瀏覽器連不到外網;行為照官方測試 sitekey)
// =========================================================================

export type TurnstileMode = "pass" | "bad_token" | "error";

export async function mockTurnstile(page: Page, mode: TurnstileMode = "pass"): Promise<void> {
  const token = mode === "bad_token" ? "WRONG.TOKEN" : TURNSTILE_PASS_TOKEN;
  const script = `window.turnstile = {
    render(el, o) { window.__c3ts = o; return "w-e2e"; },
    execute() { const o = window.__c3ts; setTimeout(() => {
      if (${JSON.stringify(mode)} === "error") o["error-callback"]("300030");
      else o.callback(${JSON.stringify(token)});
    }, 30); },
    reset() {}, remove() {} };`;
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: script }),
  );
}

/** 直接在資料庫建一張客人訂單(後台 spec 用;跟 Edge 呼叫同一支核心函式)。 */
export async function createCustomerBookingDirect(input: {
  slug: string;
  userId: string | null;
  guestPhone: string | null;
  draft: Record<string, unknown>;
  submissionId: string;
}): Promise<Record<string, unknown>> {
  const { data, error } = await serviceClient().rpc("internal_customer_submit_booking", {
    p_slug: input.slug,
    p_user_id: input.userId,
    p_guest_phone: input.guestPhone,
    p_draft: input.draft,
    p_agree_policy: true,
    p_submission_id: input.submissionId,
  });
  if (error) throw new Error(`建立客人訂單失敗:${error.message}(${error.hint ?? ""})`);
  return data as Record<string, unknown>;
}
