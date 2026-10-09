// 客戶端第 5-B 批 — line-quota-status 的 Deno 測試(C5-Q02、X02)。
// 權限本身(管理員 / 有 LINE 通知權限的客服 / 其他人)由 pgTAP c5b_cap_usage_marketing.sql 測 get_customer_line_usage;
// 這裡測:沒權限 ⇒ 403、LINE 查詢成功 / 沒有上限 / 失敗、沒接上官方帳號、token 不出現在回應與 console。
// 跑法:npm run test:edge

import { assert, assertEquals } from "jsr:@std/assert@1";

import { fetchLineQuota, handleRequest, type UsageRow } from "./index.ts";

const URL_ = "https://example.supabase.co/functions/v1/line-quota-status";
const TOKEN = "SENTINEL-QUOTA-TOKEN-abc";
const MID = "11111111-2222-4333-8444-555555555555";

const USAGE: UsageRow = {
  connected: true,
  month: "2026-10",
  by_category: { customer: 80, store: 40, marketing: 12, birthday: 0 },
  total_sent: 132,
  cap: 150,
  blocked_until: null,
};

function req(body: unknown = { merchant_id: MID }, auth: string | null = "Bearer user-jwt") {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = auth;
  return new Request(URL_, { method: "POST", headers, body: JSON.stringify(body) });
}

function lineFetch(quota: { status?: number; body: unknown }, consumption: { status?: number; body: unknown }, seen: string[]) {
  return ((input: string, init: RequestInit) => {
    seen.push(`${String(input)} ${new Headers(init.headers).get("Authorization")}`);
    const r = String(input).endsWith("/quota") ? quota : consumption;
    return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status ?? 200 }));
  }) as unknown as typeof fetch;
}

function deps(opts: { usage?: UsageRow | null; usageError?: string; token?: string | null; fetchImpl?: typeof fetch; logs?: string[] }) {
  return {
    env: (k: string) => ({ SUPABASE_URL: "https://example.supabase.co" } as Record<string, string>)[k],
    getUsage: (auth: string, mid: string) => {
      assertEquals(auth, "Bearer user-jwt");
      assertEquals(mid, MID);
      return Promise.resolve(opts.usageError ? { data: null, error: { code: opts.usageError } } : { data: opts.usage ?? USAGE, error: null });
    },
    getToken: () => Promise.resolve(opts.token === undefined ? TOKEN : opts.token),
    fetchImpl: opts.fetchImpl,
    log: { error: (...a: unknown[]) => opts.logs?.push(a.map(String).join(" ")) },
  };
}

Deno.test("Q02-1 LINE 有上限:回 plan_limit / used + 本系統分類統計 + 上限;用該店 token 查兩支 API", async () => {
  const seen: string[] = [];
  const res = await handleRequest(req(), deps({ fetchImpl: lineFetch({ body: { type: "limited", value: 200 } }, { body: { totalUsage: 132 } }, seen) }));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    line_status: "ok", quota_type: "limited", plan_limit: 200, used: 132, month: "2026-10",
    by_category: { customer: 80, store: 40, marketing: 12, birthday: 0 }, total_sent: 132, cap: 150, blocked_until: null,
  });
  assertEquals(seen.sort(), [
    `https://api.line.me/v2/bot/message/quota Bearer ${TOKEN}`,
    `https://api.line.me/v2/bot/message/quota/consumption Bearer ${TOKEN}`,
  ]);
});

Deno.test("Q02-2 LINE 沒有上限(type none)⇒ plan_limit null、used 有值", async () => {
  const res = await handleRequest(req(), deps({ fetchImpl: lineFetch({ body: { type: "none" } }, { body: { totalUsage: 5 } }, []) }));
  const body = await res.json();
  assertEquals([body.line_status, body.quota_type, body.plan_limit, body.used], ["ok", "none", null, 5]);
});

Deno.test("Q02-3 LINE 查詢失敗 ⇒ plan_limit / used null、line_status unavailable,只顯示本系統統計", async () => {
  const res = await handleRequest(req(), deps({ fetchImpl: lineFetch({ status: 500, body: {} }, { body: { totalUsage: 5 } }, []) }));
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals([body.line_status, body.quota_type, body.plan_limit, body.used, body.by_category.customer], ["unavailable", null, null, null, 80]);
});

Deno.test("Q02-4 沒接上官方帳號 ⇒ 不呼叫 LINE,line_status not_connected", async () => {
  const seen: string[] = [];
  const res = await handleRequest(req(), deps({ usage: { ...USAGE, connected: false }, fetchImpl: lineFetch({ body: {} }, { body: {} }, seen) }));
  assertEquals((await res.json()).line_status, "not_connected");
  assertEquals(seen.length, 0);
});

Deno.test("Q02-5 沒權限(資料庫 42501)⇒ 403;其他錯誤 ⇒ 500;沒帶登入 ⇒ 401;merchant_id 不是 uuid ⇒ 400;GET ⇒ 405", async () => {
  assertEquals((await handleRequest(req(), deps({ usageError: "42501" }))).status, 403);
  assertEquals((await handleRequest(req(), deps({ usageError: "XX000" }))).status, 500);
  assertEquals((await handleRequest(req({ merchant_id: MID }, null), deps({}))).status, 401);
  assertEquals((await handleRequest(req({ merchant_id: "abc" }), deps({}))).status, 400);
  assertEquals((await handleRequest(new Request(URL_, { method: "GET" }), deps({}))).status, 405);
  assertEquals((await handleRequest(new Request(URL_, { method: "OPTIONS" }), deps({}))).status, 200);
});

Deno.test("X02 token 不出現在回應與 console(LINE 失敗、丟例外時也一樣)", async () => {
  for (const f of [
    lineFetch({ body: { type: "limited", value: 200 } }, { body: { totalUsage: 1 } }, []),
    lineFetch({ status: 401, body: { message: `bad ${TOKEN}` } }, { body: {} }, []),
    (() => Promise.reject(new Error(`boom ${TOKEN}`))) as unknown as typeof fetch,
  ]) {
    const logs: string[] = [];
    const res = await handleRequest(req(), deps({ fetchImpl: f, logs }));
    const text = await res.text();
    assert(![text, ...logs].join("\n").includes(TOKEN));
  }
});

Deno.test("fetchLineQuota:回應格式不對 ⇒ null", async () => {
  assertEquals(await fetchLineQuota(lineFetch({ body: { type: "limited", value: 0 } }, { body: { totalUsage: 1 } }, []), "https://api.line.me", TOKEN), null);
  assertEquals(await fetchLineQuota(lineFetch({ body: { type: "weird" } }, { body: { totalUsage: 1 } }, []), "https://api.line.me", TOKEN), null);
});
