// 第 13 批 #1002:同一信箱被第二家商家邀請時,狀態不可以誤變「已啟用」。本機 Supabase 專用
// (e2e-local 設定,loopback guard 生效,不碰正式庫)。規格書:.project/specs/重複邀請未開通帳號狀態錯誤-第13批.md
//
// 走真的 Edge Function(本機 edge runtime 的 invite-merchant-agent / invite-merchant-staff)+ 真的 Mailpit 收信
// + 真的轉場頁設定密碼:
//   客服:
//     1. A 商家邀請新信箱 → invited;B 商家再邀同一信箱 → 也是 invited(A 不變),Mailpit 收到第二封邀請信
//     2. 該人點最新那封信、在客服轉場頁設好密碼 → A、B 兩家都變 active
//     3. 已開通的人被 C 商家邀請 → 直接 active(原行為不變),不寄信
//   服務人員:同樣三條(服務人員轉場頁)。
//
// 為什麼不直接讓瀏覽器點信裡的連結:本機 edge runtime 沒有設定 PUBLIC_SITE_URL,邀請信的 redirect_to 會是
// 正式網址,本機 GoTrue 不認得就退回 site_url。所以由 Node 端去打信裡的驗證連結(redirect: manual),
// 取出 Location 裡的 #access_token…,再讓瀏覽器打開本機 dev server 的轉場頁並帶上同一段 hash——
// 轉場頁的處理邏輯(detectSessionInUrl → 設密碼 → mark_*_active_if_self)跟正式環境完全一樣。
//
// 「點過連結但沒設密碼 → 改寄設定密碼信」這條分支不放進這支 spec:那條會打 /recover,本機 config.toml 的
// rate_limit.email_sent = 2(每小時),重跑容易被限流變成假失敗。該分支由
// supabase/functions/_shared/inviteAccountResolver.test.ts 覆蓋,並已手動對本機 edge function 實測一次。
//
// teardown:先 SELECT 核對(商家名稱前綴、帳號 email 格式都是本 spec 建的才刪),刪後再 SELECT 全部為 0。
//
// 執行:npx playwright test --config playwright.local.config.ts b13-1002-reinvite-unactivated

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { buildFetch } from "../e2e/support/fixture-supabase-client";
import { expectOnlyLocalRequests, recordRequestHosts } from "./support/request-guard";
import { readLocalSupabaseTarget } from "./support/local-target";

const MERCHANT_PREFIX = "E2E第13批1002本機商家";
const EMAIL_RE = /^e2e-b13-(admin[abc]|agentee|staffee)-\d+@example-local-test\.test$/;
const MAILPIT = "http://127.0.0.1:55324";
const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial", timeout: 240_000 });

interface MerchantCtx {
  merchantId: string;
  groupId: string;
  admin: SupabaseClient;
  userId: string;
}

let runId: string;
let password: string;
const userIds: string[] = [];
const merchants: Record<"A" | "B" | "C", MerchantCtx> = {} as never;
const staffIds: Record<"A" | "B" | "C", string> = {} as never;

function makeClient(key: string, accessToken?: string): SupabaseClient {
  const { url } = readLocalSupabaseTarget();
  return createClient(url, key, {
    global: {
      fetch: buildFetch(key),
      ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
const anon = () => makeClient(readLocalSupabaseTarget().publishableKey);
const svc = () => makeClient(readLocalSupabaseTarget().serviceRoleKey);

function email(role: string): string {
  return `e2e-b13-${role}-${runId}@example-local-test.test`;
}

async function signUp(role: string): Promise<Session> {
  const r = await anon().auth.signUp({ email: email(role), password });
  if (r.error || !r.data.session) throw new Error(`建立帳號 ${role} 失敗:${r.error?.message}`);
  userIds.push(r.data.session.user.id);
  return r.data.session;
}

async function setupMerchant(key: "A" | "B" | "C", n: number): Promise<void> {
  const session = await signUp(`admin${key.toLowerCase()}`);
  const admin = makeClient(readLocalSupabaseTarget().publishableKey, session.access_token);
  const m = await admin.rpc("create_group_and_merchant", {
    p_name: `${MERCHANT_PREFIX}${key}${runId}`,
    p_industry_type: "on_site_dispatch",
    p_address: "E2E第13批測試地址",
    p_contact_email: email(`admin${key.toLowerCase()}`),
    p_intro: "#1002 本機 e2e,測完硬刪除。",
  });
  if (m.error) throw new Error(`建立商家 ${key} 失敗:${m.error.message}`);
  const merchantId = m.data as string;
  const g = await svc().from("merchants").select("group_id").eq("id", merchantId).single();
  if (g.error) throw new Error(g.error.message);
  merchants[key] = {
    merchantId,
    groupId: g.data.group_id as string,
    admin,
    userId: session.user.id,
  };
  const seed = Number(runId.slice(-6));
  const s = await admin
    .from("merchant_staff")
    .insert({
      merchant_id: merchantId,
      name: `E2E第13批服務人員${key}`,
      phone: `09${String((seed * 10 + n) % 100_000_000).padStart(8, "0")}`,
    })
    .select("id")
    .single();
  if (s.error) throw new Error(`建立服務人員 ${key} 失敗:${s.error.message}`);
  staffIds[key] = s.data.id as string;
}

async function invokeOk(
  ctx: MerchantCtx,
  fn: "invite-merchant-agent" | "invite-merchant-staff",
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = await ctx.admin.functions.invoke(fn, { body });
  if (r.error) {
    const detail = await (r.error as { context?: Response }).context?.text?.();
    throw new Error(`${fn} 失敗:${r.error.message} ${detail ?? ""}`);
  }
  return r.data as Record<string, unknown>;
}

function inviteAgent(key: "A" | "B" | "C", n: number) {
  const seed = Number(runId.slice(-6));
  return invokeOk(merchants[key], "invite-merchant-agent", {
    merchant_id: merchants[key].merchantId,
    email: email("agentee"),
    name: `E2E第13批客服${key}`,
    phone: `09${String((seed * 10 + 5 + n) % 100_000_000).padStart(8, "0")}`,
  });
}

function inviteStaff(key: "A" | "B" | "C") {
  return invokeOk(merchants[key], "invite-merchant-staff", {
    merchant_id: merchants[key].merchantId,
    staff_id: staffIds[key],
    login_email: email("staffee"),
  });
}

async function agentStatus(key: "A" | "B" | "C"): Promise<string | null> {
  const r = await svc()
    .from("merchant_agents")
    .select("status")
    .eq("merchant_id", merchants[key].merchantId)
    .eq("invited_email", email("agentee"))
    .maybeSingle();
  if (r.error) throw new Error(r.error.message);
  return (r.data?.status as string | undefined) ?? null;
}

async function staffLoginStatus(key: "A" | "B" | "C"): Promise<string> {
  const r = await svc()
    .from("merchant_staff")
    .select("login_status")
    .eq("id", staffIds[key])
    .single();
  if (r.error) throw new Error(r.error.message);
  return r.data.login_status as string;
}

interface MailSummary {
  ID: string;
  Subject: string;
}

async function mailsTo(address: string): Promise<MailSummary[]> {
  const res = await fetch(
    `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
  );
  if (!res.ok) throw new Error(`Mailpit 查詢失敗 ${res.status}`);
  const json = (await res.json()) as { messages: MailSummary[] };
  return json.messages; // 新的在前
}

async function confirmationUrlOf(mailId: string): Promise<string> {
  const res = await fetch(`${MAILPIT}/api/v1/message/${mailId}`);
  const json = (await res.json()) as { HTML: string };
  const href = json.HTML.match(/href="([^"]*\/auth\/v1\/verify[^"]*)"/)?.[1];
  if (!href) throw new Error("信裡找不到驗證連結");
  return href.replace(/&amp;/g, "&");
}

/** 打信裡的驗證連結(不跟隨轉址),回傳 Location 的 hash(成功時帶 access_token)。 */
async function verifyHash(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "manual" });
  const location = res.headers.get("location") ?? "";
  const i = location.indexOf("#");
  return i >= 0 ? location.slice(i) : "";
}

async function completeOnPage(
  page: Page,
  path: "/app/agent-invite-complete" | "/app/staff-invite-complete",
  hash: string,
  inputPrefix: "invite" | "staff-invite",
): Promise<void> {
  const rec = recordRequestHosts(page);
  await page.goto(`${path}${hash}`);
  await expect(page.locator(`#${inputPrefix}-password`)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.locator(`#${inputPrefix}-password`).fill(password);
  await page.locator(`#${inputPrefix}-password-confirm`).fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(new RegExp(path), { timeout: LOAD_TIMEOUT });
  expectOnlyLocalRequests(rec);
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  password = `E2eB13!${runId}Aa`;
  await setupMerchant("A", 1);
  await setupMerchant("B", 2);
  await setupMerchant("C", 3);
});

test.afterAll(async () => {
  const s = svc();
  const keys = Object.keys(merchants) as ("A" | "B" | "C")[];
  // ① 刪前核對:商家名稱前綴、帳號 email 格式都是本 spec 建的
  const ids = keys.map((k) => merchants[k].merchantId);
  const groupIds = keys.map((k) => merchants[k].groupId);
  const rows = await s.from("merchants").select("id,name").in("group_id", groupIds);
  if (rows.error) throw new Error(rows.error.message);
  const rowList = rows.data as { id: string; name: string }[];
  if (
    rowList.length !== ids.length ||
    !rowList.every((r) => ids.includes(r.id) && r.name.startsWith(MERCHANT_PREFIX))
  ) {
    throw new Error(`teardown 中止:集團底下有非本 spec 的商家 ${JSON.stringify(rowList)}`);
  }
  for (const addr of [email("agentee"), email("staffee")]) {
    const r = await s.rpc("lookup_user_id_by_email", { p_email: addr });
    if (r.data && !userIds.includes(r.data as string)) userIds.push(r.data as string);
  }
  for (const id of userIds) {
    const u = await s.auth.admin.getUserById(id);
    if (u.error || !EMAIL_RE.test(u.data.user?.email ?? "")) {
      throw new Error(`teardown 中止:帳號 ${id.slice(0, 8)} 不是本 spec 建的`);
    }
  }
  // ② 硬刪除(merchant_agents / merchant_staff 隨商家 cascade)
  const delM = await s.from("merchants").delete().in("id", ids).select("id");
  if (delM.error) throw new Error(delM.error.message);
  const delG = await s.from("groups").delete().in("id", groupIds).select("id");
  if (delG.error) throw new Error(delG.error.message);
  for (const id of userIds) {
    const r = await s.auth.admin.deleteUser(id);
    if (r.error) throw new Error(`刪帳號失敗:${r.error.message}`);
  }
  // ③ 刪後核對
  const left =
    ((await s.from("merchants").select("id", { count: "exact", head: true }).in("id", ids)).count ??
      0) +
    ((
      await s
        .from("merchant_agents")
        .select("id", { count: "exact", head: true })
        .in("merchant_id", ids)
    ).count ?? 0) +
    ((
      await s
        .from("merchant_staff")
        .select("id", { count: "exact", head: true })
        .in("merchant_id", ids)
    ).count ?? 0);
  let usersLeft = 0;
  for (const id of userIds) if ((await s.auth.admin.getUserById(id)).data.user) usersLeft += 1;
  expect(left + usersLeft, "teardown 後不可殘留").toBe(0);
});

test("客服:B 再邀未開通信箱仍是邀請信已寄出;設好密碼後 A、B 一起啟用;C 邀請已開通者直接啟用", async ({
  page,
}) => {
  const a = await inviteAgent("A", 1);
  expect(a["status"]).toBe("invited");
  expect(a["already_had_account"]).toBe(false);
  expect(await agentStatus("A")).toBe("invited");

  const b = await inviteAgent("B", 2);
  expect(b["status"], "#1002 核心:第二家商家邀請未開通的信箱,不能變 active").toBe("invited");
  expect(b["already_had_account"], "不可透露這個信箱被別家邀請過").toBe(false);
  expect(await agentStatus("B")).toBe("invited");
  expect(await agentStatus("A"), "A 商家狀態不變").toBe("invited");

  const mails = await mailsTo(email("agentee"));
  expect(mails.length, "A、B 各寄一封邀請信").toBe(2);
  // 舊那封(A 寄的)連結已被重寄換掉,只剩最新那封有效
  const oldHash = await verifyHash(await confirmationUrlOf(mails[1]!.ID));
  expect(oldHash).not.toContain("access_token");
  const newHash = await verifyHash(await confirmationUrlOf(mails[0]!.ID));
  expect(newHash).toContain("access_token");

  await completeOnPage(page, "/app/agent-invite-complete", newHash, "invite");
  await expect.poll(() => agentStatus("A")).toBe("active");
  await expect.poll(() => agentStatus("B")).toBe("active");

  const c = await inviteAgent("C", 3);
  expect(c["status"], "已開通的人:原行為,直接 active").toBe("active");
  expect(c["already_had_account"]).toBe(true);
  expect(await agentStatus("C")).toBe("active");
  expect((await mailsTo(email("agentee"))).length, "直接加入不寄信").toBe(2);
});

test("服務人員:同樣三條", async ({ page }) => {
  const a = await inviteStaff("A");
  expect(a["login_status"]).toBe("invited");
  expect(a["already_had_account"]).toBe(false);

  const b = await inviteStaff("B");
  expect(b["login_status"], "#1002 核心:第二家商家邀請未開通的信箱,不能變 active").toBe("invited");
  expect(b["already_had_account"]).toBe(false);
  expect(await staffLoginStatus("A")).toBe("invited");
  expect(await staffLoginStatus("B")).toBe("invited");

  const mails = await mailsTo(email("staffee"));
  expect(mails.length).toBe(2);
  const newHash = await verifyHash(await confirmationUrlOf(mails[0]!.ID));
  expect(newHash).toContain("access_token");

  await completeOnPage(page, "/app/staff-invite-complete", newHash, "staff-invite");
  await expect.poll(() => staffLoginStatus("A")).toBe("active");
  await expect.poll(() => staffLoginStatus("B")).toBe("active");

  const c = await inviteStaff("C");
  expect(c["login_status"]).toBe("active");
  expect(c["already_had_account"]).toBe(true);
  expect(await staffLoginStatus("C")).toBe("active");
  expect((await mailsTo(email("staffee"))).length).toBe(2);
});
