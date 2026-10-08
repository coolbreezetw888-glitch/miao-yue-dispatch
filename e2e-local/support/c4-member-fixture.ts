// 客戶端第 4 批 4-A 本機 e2e 共用:模擬 Edge Function customer-booking-cancel、客人資料庫 client、建會員訂單。
// 介面:.project/notes/c4-contract.md(第 9 節 e2e fixture)。只在 playwright.local.config.ts 底下用,只連本機。
//
// 不跑真的 Edge Function:/functions/v1/customer-booking-cancel 用 page.route 攔下,在 Node 端用本機 service role
// 呼叫 internal_customer_cancel_booking(資料庫核心,所有規則都在裡面),🔴 回給頁面前刪掉 `_internal`。
import { randomUUID } from "node:crypto";

import type { Page, Route } from "@playwright/test";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

import { buildFetch } from "../../e2e/support/fixture-supabase-client";
import { serviceClient } from "./c1-public-booking-fixture";
import { createCustomerBookingDirect } from "./c3-submit-fixture";
import { readLocalSupabaseTarget } from "./local-target";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export interface MockCancel {
  requests: Record<string, unknown>[];
  /** 回給頁面的原文(確認沒有 _internal)。 */
  responseBodies: string[];
}

export async function mockBookingCancel(page: Page): Promise<MockCancel> {
  const record: MockCancel = { requests: [], responseBodies: [] };
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

  await page.route("**/functions/v1/customer-booking-cancel", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    record.requests.push(body);
    const token = (req.headers()["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return reply(route, 200, { state: "not_linked" });
    const { data: u } = await svc.auth.getUser(token);
    if (u.user?.app_metadata?.["account_type"] !== "customer") {
      return reply(route, 200, { state: "not_linked" });
    }
    const { data, error } = await svc.rpc("internal_customer_cancel_booking", {
      p_slug: body["slug"],
      p_user_id: u.user.id,
      p_booking_id: body["booking_id"],
    });
    if (error) return reply(route, 500, { state: "server_error" });
    // 🔴 c4-contract:一定要刪掉 _internal 再回給客人。
    const { _internal, ...result } = (data ?? {}) as Record<string, unknown>;
    void _internal;
    return reply(route, 200, result);
  });
  return record;
}

/** 帶著客人登入狀態的資料庫 client(Node 端用,跟瀏覽器的客戶 client 同一個身分)。 */
export async function customerDbClient(session: Session): Promise<SupabaseClient> {
  const { url, publishableKey } = readLocalSupabaseTarget();
  const client = createClient(url, publishableKey, {
    global: { fetch: buildFetch(publishableKey) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  return client;
}

/** 用客人 client 走 ⑥-2(customer_complete_profile)接上 / 建立會員。回傳會員 id。 */
export async function linkCustomerToMember(input: {
  session: Session;
  slug: string;
  merchantId: string;
  phone: string;
  name: string;
}): Promise<string> {
  const customer = await customerDbClient(input.session);
  const linked = await customer.rpc("customer_complete_profile", {
    p_slug: input.slug,
    p_phone: input.phone,
    p_name: input.name,
    p_agree_policy: true,
  });
  const state = (linked.data as { state?: string } | null)?.state;
  if (state !== "linked") {
    throw new Error(`接上會員失敗:${linked.error?.message ?? JSON.stringify(linked.data)}`);
  }
  const m = await serviceClient()
    .from("members")
    .select("id")
    .eq("merchant_id", input.merchantId)
    .eq("user_id", input.session.user.id)
    .single();
  if (m.error || !m.data) throw new Error(`找不到剛接上的會員:${m.error?.message ?? ""}`);
  return m.data.id as string;
}

/** 會員線上下一張單(= Edge 呼叫的同一支核心);回傳訂單 id。 */
export async function createMemberBooking(input: {
  slug: string;
  userId: string;
  itemId: string;
  staffId: string;
  date: string;
  time: string;
  name: string;
}): Promise<string> {
  const submissionId = randomUUID();
  const r = await createCustomerBookingDirect({
    slug: input.slug,
    userId: input.userId,
    guestPhone: null,
    draft: {
      items: [{ service_item_id: input.itemId, quantity: 2 }],
      staff_id: input.staffId,
      date: input.date,
      time: input.time,
      name: input.name,
      address: "台北市信義區松仁路 58 號 12 樓",
      notes: null,
    },
    submissionId,
  });
  if (r["state"] !== "created") throw new Error(`建立會員訂單失敗:${JSON.stringify(r)}`);
  const b = await serviceClient()
    .from("bookings")
    .select("id")
    .eq("customer_submission_id", submissionId)
    .single();
  if (b.error || !b.data) throw new Error(`找不到剛建立的訂單:${b.error?.message ?? ""}`);
  return b.data.id as string;
}

/** 收集頁面上所有會員中心函式(/rest/v1/rpc/customer_*)與取消 Edge 的回應原文(搜哨兵用)。 */
export function collectMemberResponses(page: Page): string[] {
  const bodies: string[] = [];
  page.on("response", (res) => {
    const u = res.url();
    if (!/\/rest\/v1\/rpc\/customer_|\/functions\/v1\/customer-booking-cancel/.test(u)) return;
    void res
      .text()
      .then((t) => bodies.push(t))
      .catch(() => undefined);
  });
  return bodies;
}
