// 第 13 批 #1002:inviteAccountResolver 的 Deno 測試(四種情況 + 錯誤分支)。
// 跑法:npm run test:edge 或
//   node scripts/run-edge-function-tests.mjs supabase/functions/_shared/inviteAccountResolver.test.ts

import { assertEquals } from "jsr:@std/assert@1";

import {
  type AuthAccountLookup,
  type InviteAccountDeps,
  resolveInviteAccount,
} from "./inviteAccountResolver.ts";

const EMAIL = "someone@example.test";
const REDIRECT = "https://example.test/app/agent-invite-complete";

interface Calls {
  invite: [string, string][];
  setup: [string, string][];
}

function makeDeps(opts: {
  account?: AuthAccountLookup | null;
  lookupError?: unknown;
  inviteResult?: { userId: string | null; errorMessage: string | null };
  setupError?: string | null;
}): { deps: InviteAccountDeps; calls: Calls } {
  const calls: Calls = { invite: [], setup: [] };
  const deps: InviteAccountDeps = {
    lookupAccount() {
      return Promise.resolve({ data: opts.account ?? null, error: opts.lookupError ?? null });
    },
    inviteUserByEmail(email, redirectTo) {
      calls.invite.push([email, redirectTo]);
      return Promise.resolve(opts.inviteResult ?? { userId: "new-user", errorMessage: null });
    },
    sendPasswordSetupEmail(email, redirectTo) {
      calls.setup.push([email, redirectTo]);
      return Promise.resolve({ errorMessage: opts.setupError ?? null });
    },
  };
  return { deps, calls };
}

Deno.test("查無帳號:寄邀請信,狀態 invited(原行為)", async () => {
  const { deps, calls } = makeDeps({ account: null });
  const r = await resolveInviteAccount(EMAIL, REDIRECT, deps);
  assertEquals(r, { kind: "ok", userId: "new-user", status: "invited" });
  assertEquals(calls.invite, [[EMAIL, REDIRECT]]);
  assertEquals(calls.setup.length, 0);
});

Deno.test("已開通(email 已確認、沒有 invited 紀錄):不寄信,狀態 active(原行為)", async () => {
  const { deps, calls } = makeDeps({
    account: { user_id: "u1", email_confirmed: true, is_activated: true },
  });
  const r = await resolveInviteAccount(EMAIL, REDIRECT, deps);
  assertEquals(r, { kind: "ok", userId: "u1", status: "active" });
  assertEquals(calls.invite.length, 0);
  assertEquals(calls.setup.length, 0);
});

Deno.test("#1002 核心:別家邀請過、還沒點連結 → 重寄邀請信,狀態 invited 不是 active", async () => {
  const { deps, calls } = makeDeps({
    account: { user_id: "u1", email_confirmed: false, is_activated: false },
    inviteResult: { userId: "u1", errorMessage: null },
  });
  const r = await resolveInviteAccount(EMAIL, REDIRECT, deps);
  assertEquals(r, { kind: "ok", userId: "u1", status: "invited" });
  assertEquals(calls.invite, [[EMAIL, REDIRECT]]);
  assertEquals(calls.setup.length, 0);
});

Deno.test("點過連結但還沒走完轉場頁 → 寄設定密碼信,狀態 invited", async () => {
  const { deps, calls } = makeDeps({
    account: { user_id: "u1", email_confirmed: true, is_activated: false },
  });
  const r = await resolveInviteAccount(EMAIL, REDIRECT, deps);
  assertEquals(r, { kind: "ok", userId: "u1", status: "invited" });
  assertEquals(calls.invite.length, 0);
  assertEquals(calls.setup, [[EMAIL, REDIRECT]]);
});

Deno.test("查詢失敗 → lookup_error,不寄任何信", async () => {
  const { deps, calls } = makeDeps({ lookupError: { message: "boom" } });
  const r = await resolveInviteAccount(EMAIL, REDIRECT, deps);
  assertEquals(r.kind, "lookup_error");
  assertEquals(calls.invite.length + calls.setup.length, 0);
});

Deno.test("寄邀請信失敗 → send_error 帶原始訊息", async () => {
  const { deps } = makeDeps({
    account: null,
    inviteResult: { userId: null, errorMessage: "rate limit" },
  });
  assertEquals(await resolveInviteAccount(EMAIL, REDIRECT, deps), {
    kind: "send_error",
    message: "rate limit",
  });
});

Deno.test("寄設定密碼信失敗 → send_error", async () => {
  const { deps } = makeDeps({
    account: { user_id: "u1", email_confirmed: true, is_activated: false },
    setupError: "too frequent",
  });
  assertEquals(await resolveInviteAccount(EMAIL, REDIRECT, deps), {
    kind: "send_error",
    message: "too frequent",
  });
});

Deno.test("重寄邀請回傳的帳號跟查到的不一致 → send_error,不寫入", async () => {
  const { deps } = makeDeps({
    account: { user_id: "u1", email_confirmed: false, is_activated: false },
    inviteResult: { userId: "u2", errorMessage: null },
  });
  assertEquals((await resolveInviteAccount(EMAIL, REDIRECT, deps)).kind, "send_error");
});

Deno.test("客戶端第 2 批:客人帳號的合成信箱(.invalid)→ send_error,不查帳號、不寄任何信", async () => {
  let looked = 0;
  const { deps, calls } = makeDeps({ account: { user_id: "customer-uid", email_confirmed: true, is_activated: true } });
  const wrapped: InviteAccountDeps = { ...deps, lookupAccount(e) { looked += 1; return deps.lookupAccount(e); } };
  for (const e of ["line-0000@customer.miaoyue.invalid", "  LINE-AB@Customer.Miaoyue.INVALID "]) {
    const r = await resolveInviteAccount(e, REDIRECT, wrapped);
    assertEquals(r, { kind: "send_error", message: "這個 Email 收不到信，請確認是否打錯" });
  }
  assertEquals([looked, calls.invite.length, calls.setup.length], [0, 0, 0]);
});

Deno.test("客戶端第 2 批:資料庫把客人帳號當查無帳號時,一般信箱仍照原流程(寄邀請信)", async () => {
  const { deps, calls } = makeDeps({ account: null });
  const r = await resolveInviteAccount("invalid.user@example.com", REDIRECT, deps);
  assertEquals(r, { kind: "ok", userId: "new-user", status: "invited" });
  assertEquals(calls.invite.length, 1);
});
