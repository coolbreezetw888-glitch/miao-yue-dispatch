// 客戶端第 4-A 批 — customer-booking-cancel 測試(注入假 admin、假推播)
// 涵蓋:C4-D03 全分支、C4-D05 推播呼叫方式、C4-F05 log 不印 token / 電話 / 訂單 id
import { assert, assertEquals } from "jsr:@std/assert";
import { handleRequest, type CancelDeps } from "./index.ts";
import type { DispatchPushForBookingParams } from "../_shared/pushDispatchCore.ts";

const SITE = "https://miao-yue-dispatch.vercel.app";
const BOOKING_ID = "11111111-2222-4333-8444-555555555555";
const USER_ID = "c0000000-0000-4000-8000-000000000001";
const TOKEN = "eyJ.TOKEN_SENTINEL.sig";

const VIEW = {
  id: BOOKING_ID,
  start_at: "2026-10-13T02:00:00+00:00",
  end_at: "2026-10-13T03:00:00+00:00",
  status: "cancelled",
  staff_display: "阿明",
  items: [{ name: "室內機清洗", quantity: 2 }],
  address: null,
  customer_name: "王小明",
  customer_notes: null,
  amount: 2000,
  points_redeemed: 0,
  booked_online: false,
  booked_by: null,
  can_cancel: false,
  cancel_deadline_at: null,
  cancelled_at: "2026-10-09T02:00:00+00:00",
};
const CANCELLED = {
  state: "cancelled",
  booking: VIEW,
  _internal: { booking_id: BOOKING_ID, merchant_id: "m-1", push_title: "客人取消了預約", push_body: "客人「王小明」取消了…" },
};

interface Fake {
  deps: CancelDeps;
  rpcCalls: { fn: string; args: Record<string, unknown> }[];
  pushCalls: DispatchPushForBookingParams[];
  userCalls: string[];
  logs: string[];
}

function makeFake(opts: {
  env?: Record<string, string | undefined>;
  rateLimit?: boolean | "error";
  cancel?: { data: unknown; error: { code?: string; hint?: string; message?: string } | null };
  user?: { id: string; app_metadata: Record<string, unknown> | null } | null;
  pushThrows?: boolean;
  rpcThrows?: boolean;
} = {}): Fake {
  const env: Record<string, string | undefined> = {
    PUBLIC_SITE_URL: SITE,
    SUPABASE_URL: "https://wjtbmmnakcriuaqoknsq.supabase.co",
    ...(opts.env ?? {}),
  };
  const f: Fake = { rpcCalls: [], pushCalls: [], userCalls: [], logs: [], deps: null as unknown as CancelDeps };
  const push = (...args: unknown[]) => f.logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  f.deps = {
    env: (k) => env[k],
    rpc(fn, args) {
      f.rpcCalls.push({ fn, args });
      if (opts.rpcThrows) return Promise.reject(new Error("db down"));
      if (fn === "internal_rate_limit_hit") {
        if (opts.rateLimit === "error") return Promise.resolve({ data: null, error: { code: "XX000" } });
        return Promise.resolve({ data: opts.rateLimit ?? true, error: null });
      }
      if (fn === "internal_customer_cancel_booking") {
        return Promise.resolve(opts.cancel ?? { data: structuredClone(CANCELLED), error: null });
      }
      return Promise.resolve({ data: null, error: { message: "unexpected" } });
    },
    getUser: (token) => {
      f.userCalls.push(token);
      return Promise.resolve(opts.user === undefined ? { id: USER_ID, app_metadata: { account_type: "customer" } } : opts.user);
    },
    dispatchPush(params) {
      f.pushCalls.push(params);
      if (opts.pushThrows) return Promise.reject(new Error("push down"));
      return Promise.resolve({ dispatched: true });
    },
    log: { info: push, warn: push, error: push },
  };
  return f;
}

function req(body: unknown, headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request("https://x.supabase.co/functions/v1/customer-booking-cancel", {
    method,
    headers: { "Content-Type": "application/json", "x-forwarded-for": "6.6.6.6, 203.0.113.9", ...headers },
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
}
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const okBody = () => ({ slug: " Shop-CD0E4D ", booking_id: BOOKING_ID.toUpperCase() });

async function call(f: Fake, r: Request) {
  const res = await handleRequest(r, f.deps);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text, headers: res.headers };
}
const cancelCall = (f: Fake) => f.rpcCalls.find((c) => c.fn === "internal_customer_cancel_booking");

// ---------------------------------------------------------------------------
Deno.test("D03 來源不允許 ⇒ 403;OPTIONS 允許的來源 204、不允許的 403;GET ⇒ 405", async () => {
  const f = makeFake();
  assertEquals((await call(f, req(okBody(), { ...AUTH, Origin: "https://evil.example" }))).status, 403);
  const opt = await handleRequest(req(null, { Origin: SITE }, "OPTIONS"), f.deps);
  assertEquals(opt.status, 204);
  assertEquals(opt.headers.get("Access-Control-Allow-Origin"), SITE);
  assertEquals((await handleRequest(req(null, { Origin: "https://evil.example" }, "OPTIONS"), f.deps)).status, 403);
  assertEquals((await call(f, req(null, AUTH, "GET"))).status, 405);
  assertEquals(f.rpcCalls.length, 0);
});

Deno.test("D03 本機開發網址可以呼叫(CORS 回自己的來源)", async () => {
  const f = makeFake();
  const r = await call(f, req(okBody(), { ...AUTH, Origin: "http://127.0.0.1:5191" }));
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("Access-Control-Allow-Origin"), "http://127.0.0.1:5191");
});

Deno.test("D03 格式錯 ⇒ 400:壞 JSON、陣列、超過 4KB、沒有 slug、booking_id 不是 uuid", async () => {
  const f = makeFake();
  assertEquals((await call(f, req("{not json", AUTH))).body, { state: "invalid_request" });
  assertEquals((await call(f, req([1, 2], AUTH))).status, 400);
  assertEquals((await call(f, req({ ...okBody(), pad: "x".repeat(5000) }, AUTH))).status, 400);
  assertEquals((await call(f, req({ booking_id: BOOKING_ID }, AUTH))).status, 400);
  assertEquals((await call(f, req({ slug: "  ", booking_id: BOOKING_ID }, AUTH))).status, 400);
  assertEquals((await call(f, req({ slug: "shop", booking_id: "abc" }, AUTH))).status, 400);
  assertEquals((await call(f, req({ slug: "shop", booking_id: 123 }, AUTH))).status, 400);
  assertEquals(f.rpcCalls.length, 0);
});

Deno.test("D03 同一 IP 10 分鐘超過 20 次 ⇒ rate_limited;IP 用 XFF 最後一段;不驗 token、不取消", async () => {
  const f = makeFake({ rateLimit: false });
  const r = await call(f, req(okBody(), AUTH));
  assertEquals(r.body, { state: "rate_limited" });
  assertEquals(f.rpcCalls[0].args, { p_bucket: "customer_cancel_ip", p_key: "ip:203.0.113.9", p_window_seconds: 600, p_max: 20 });
  assertEquals(f.userCalls.length, 0);
  assertEquals(cancelCall(f), undefined);
});

Deno.test("D03 頻率限制查詢失敗 ⇒ 500", async () => {
  const f = makeFake({ rateLimit: "error" });
  const r = await call(f, req(okBody(), AUTH));
  assertEquals(r.status, 500);
  assertEquals(r.body, { state: "server_error" });
  assertEquals(cancelCall(f), undefined);
});

Deno.test("D03 沒帶 token / token 無效 / 不是客人帳號 ⇒ not_linked,不取消", async () => {
  const f0 = makeFake();
  assertEquals((await call(f0, req(okBody()))).body, { state: "not_linked" });
  assertEquals(f0.userCalls.length, 0);
  const f1 = makeFake({ user: null });
  assertEquals((await call(f1, req(okBody(), AUTH))).body, { state: "not_linked" });
  const f2 = makeFake({ user: { id: USER_ID, app_metadata: { account_type: "staff" } } });
  assertEquals((await call(f2, req(okBody(), AUTH))).body, { state: "not_linked" });
  const f3 = makeFake({ user: { id: USER_ID, app_metadata: null } });
  assertEquals((await call(f3, req(okBody(), AUTH))).body, { state: "not_linked" });
  for (const f of [f0, f1, f2, f3]) assertEquals(cancelCall(f), undefined);
});

Deno.test("D03 / D05 成功:參數(slug 小寫去空白、booking_id 小寫、user = token 的人);回應刪掉 _internal;推播 booking_cancelled + skipInAppNotification + messageOverride", async () => {
  const f = makeFake();
  const r = await call(f, req(okBody(), AUTH));
  assertEquals(r.status, 200);
  assertEquals(f.userCalls, [TOKEN]);
  assertEquals(cancelCall(f)?.args, { p_slug: "shop-cd0e4d", p_user_id: USER_ID, p_booking_id: BOOKING_ID });
  assertEquals(r.body, { state: "cancelled", booking: VIEW });
  assert(!r.raw.includes("_internal"));
  assert(!r.raw.includes("m-1"));
  assertEquals(f.pushCalls, [{
    merchantId: "m-1",
    bookingId: BOOKING_ID,
    eventType: "booking_cancelled",
    skipInAppNotification: true,
    messageOverride: { title: "客人取消了預約", body: "客人「王小明」取消了…" },
  }]);
});

Deno.test("D05 推播失敗不影響回應", async () => {
  const f = makeFake({ pushThrows: true });
  const r = await call(f, req(okBody(), AUTH));
  assertEquals(r.status, 200);
  assertEquals(r.body.state, "cancelled");
  assertEquals(f.pushCalls.length, 1);
});

Deno.test("D05 _internal 沒有推播文字 ⇒ messageOverride null(仍照店家範本發)", async () => {
  const f = makeFake({ cancel: { data: { state: "cancelled", booking: VIEW, _internal: { booking_id: BOOKING_ID, merchant_id: "m-1" } }, error: null } });
  await call(f, req(okBody(), AUTH));
  assertEquals(f.pushCalls[0].messageOverride, null);
});

for (const state of ["already_cancelled", "deadline_passed", "not_cancellable", "not_found", "not_linked", "unavailable"]) {
  Deno.test(`D03 資料庫回 ${state} ⇒ 200 原樣回傳、不推播`, async () => {
    const f = makeFake({ cancel: { data: { state }, error: null } });
    const r = await call(f, req(okBody(), AUTH));
    assertEquals(r.status, 200);
    assertEquals(r.body, { state });
    assertEquals(f.pushCalls.length, 0);
  });
}

Deno.test("D03 資料庫錯誤 / 回傳格式不對 / 例外 ⇒ 500 server_error,不推播", async () => {
  const f1 = makeFake({ cancel: { data: null, error: { code: "XX000", message: "boom SECRET_DETAIL" } } });
  const r1 = await call(f1, req(okBody(), AUTH));
  assertEquals(r1.status, 500);
  assertEquals(r1.body, { state: "server_error" });
  assert(!r1.raw.includes("SECRET_DETAIL"));
  const f2 = makeFake({ cancel: { data: { state: "weird" }, error: null } });
  assertEquals((await call(f2, req(okBody(), AUTH))).status, 500);
  const f3 = makeFake({ rpcThrows: true });
  assertEquals((await call(f3, req(okBody(), AUTH))).body, { state: "server_error" });
  for (const f of [f1, f2, f3]) assertEquals(f.pushCalls.length, 0);
});

Deno.test("F05 log 不印 token、訂單 id、客人姓名;回應沒有 Cache", async () => {
  const fs = [
    makeFake(),
    makeFake({ user: null }),
    makeFake({ cancel: { data: null, error: { code: "XX000" } } }),
    makeFake({ pushThrows: true }),
    makeFake({ rateLimit: "error" }),
  ];
  for (const f of fs) {
    const r = await call(f, req(okBody(), AUTH));
    assertEquals(r.headers.get("Cache-Control"), "no-store");
    const all = f.logs.join("\n");
    assert(!all.includes("TOKEN_SENTINEL"), all);
    assert(!all.toLowerCase().includes(BOOKING_ID), all);
    assert(!all.includes("王小明"), all);
    assert(!all.includes("203.0.113.9"), all);
  }
});
