// 第 13 批 #1002:invite-merchant-agent / invite-merchant-staff 共用的「這個 email 該怎麼邀請」判斷。
// 規格書:.project/specs/重複邀請未開通帳號狀態錯誤-第13批.md
//
// 原本兩支 Edge Function 只看「auth 有沒有這個帳號」,有就直接寫 active。但第一家商家寄邀請信時
// Supabase 就已經建好一個還沒開通的帳號,所以第二家商家查到「有帳號」就誤判成已啟用。
//
// 現在分四種情況(開通標準見 migration 20261007150000 的 lookup_auth_account_by_email):
//   1. 查無帳號                     → inviteUserByEmail 寄邀請信,狀態 invited(原行為)。
//   2. 有帳號、已開通              → 不寄信,狀態 active(原行為,同一帳號跨商家)。
//      「已開通」= email 已確認,而且本人沒有任何還停在 invited 的客服 / 服務人員紀錄
//      (轉場頁設定密碼後 mark_*_active_if_self 會把它們全部轉掉,跟既有轉換同一個標準)。
//   3. 有帳號、還沒點過連結          → 再呼叫一次 inviteUserByEmail。Supabase 對「已存在但 email 未確認」
//                                       的帳號會重寄邀請信(同一個 user_id、換新的驗證碼),狀態 invited。
//                                       ⚠️ 副作用:前一封邀請信的連結會失效,對方要點最新那封。
//   4. 有帳號、點過連結但還沒走完轉場頁(email 已確認、仍有 invited 紀錄) → Supabase 的 invite 會拒絕已確認的 email(email_exists),
//                                       改寄「設定密碼」信(resetPasswordForEmail,導回同一個轉場頁),
//                                       狀態 invited。
// 3、4 寄出的連結都導回各自的轉場頁,對方設好密碼後 mark_*_active_if_self 會把他在所有商家、
// 客服與服務人員兩張表裡的 invited 紀錄一次轉成 active。
//
// 資安:回傳給前端的只有「這次寫成 invited 或 active」——跟改版前一樣多,不會多透露這個信箱
// 在別家商家是不是「已邀請未開通」(already_had_account 只在 active 時為 true,見兩支 index.ts)。
//
// 所有外部呼叫都透過 deps 注入,方便用 scripts/run-edge-function-tests.mjs 跑 Deno 測試。

export interface AuthAccountLookup {
  user_id: string;
  email_confirmed: boolean;
  is_activated: boolean;
}

export interface InviteAccountDeps {
  /** 呼叫 lookup_auth_account_by_email(service role),查無帳號時 data 為 null。 */
  lookupAccount(email: string): Promise<{ data: AuthAccountLookup | null; error: unknown }>;
  /** auth.admin.inviteUserByEmail;成功回傳 userId。 */
  inviteUserByEmail(
    email: string,
    redirectTo: string,
  ): Promise<{ userId: string | null; errorMessage: string | null }>;
  /** auth.resetPasswordForEmail(寄「設定密碼」信)。 */
  sendPasswordSetupEmail(
    email: string,
    redirectTo: string,
  ): Promise<{ errorMessage: string | null }>;
}

export type InviteAccountResult =
  | { kind: "ok"; userId: string; status: "invited" | "active" }
  | { kind: "lookup_error"; error: unknown }
  | { kind: "send_error"; message: string };

/** `.invalid` 結尾的網域(RFC 2606 保留,永遠收不到信)。 */
export function isUndeliverableEmail(email: string): boolean {
  return /\.invalid\s*$/i.test(email.trim());
}

export async function resolveInviteAccount(
  email: string,
  redirectTo: string,
  deps: InviteAccountDeps,
): Promise<InviteAccountResult> {
  // 客戶端第 2 批(QA):`.invalid` 網域依 RFC 2606 永遠收不到信 —— 客戶端 LINE 登入建立的客人帳號就是用這種
  // 合成信箱。直接擋下,不查帳號、不呼叫 Supabase 寄信(資料庫的 lookup_auth_account_by_email 也已排除客人帳號,
  // 這裡是第二道)。訊息只說「收不到信」,不透露那是不是某個客人的帳號。
  if (isUndeliverableEmail(email)) {
    return { kind: "send_error", message: "這個 Email 收不到信，請確認是否打錯" };
  }
  const { data: account, error: lookupError } = await deps.lookupAccount(email);
  if (lookupError) {
    return { kind: "lookup_error", error: lookupError };
  }

  if (account?.user_id && account.is_activated) {
    return { kind: "ok", userId: account.user_id, status: "active" };
  }

  if (account?.user_id && account.email_confirmed) {
    const { errorMessage } = await deps.sendPasswordSetupEmail(email, redirectTo);
    if (errorMessage) {
      return { kind: "send_error", message: errorMessage };
    }
    return { kind: "ok", userId: account.user_id, status: "invited" };
  }

  const { userId, errorMessage } = await deps.inviteUserByEmail(email, redirectTo);
  if (errorMessage || !userId) {
    return { kind: "send_error", message: errorMessage ?? "請稍後再試" };
  }
  if (account?.user_id && userId !== account.user_id) {
    // 理論上不會發生(重寄邀請回傳的是同一個帳號);真的不一致就不要寫入,避免綁錯人。
    return { kind: "send_error", message: "帳號資料不一致，請稍後再試" };
  }
  return { kind: "ok", userId, status: "invited" };
}

// 用 service role client 組出真正的 deps。型別只描述用得到的那幾個方法,避免這個檔案 import esm.sh
// (測試執行器沒有網路解析 esm.sh 的能力)。
interface AdminClientLike {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> };
  auth: {
    admin: {
      inviteUserByEmail(
        email: string,
        options: { redirectTo: string },
      ): PromiseLike<{
        data: { user: { id: string } | null } | null;
        error: { message: string } | null;
      }>;
    };
    resetPasswordForEmail(
      email: string,
      options: { redirectTo: string },
    ): PromiseLike<{ error: { message: string } | null }>;
  };
}

export function supabaseInviteAccountDeps(adminClient: AdminClientLike): InviteAccountDeps {
  return {
    async lookupAccount(email) {
      const { data, error } = await adminClient
        .rpc("lookup_auth_account_by_email", { p_email: email })
        .maybeSingle();
      return { data: (data as AuthAccountLookup | null) ?? null, error };
    },
    async inviteUserByEmail(email, redirectTo) {
      const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email, { redirectTo });
      if (error || !data?.user) {
        console.error("[inviteAccountResolver] inviteUserByEmail 失敗", error);
        return { userId: null, errorMessage: error?.message ?? "請稍後再試" };
      }
      return { userId: data.user.id, errorMessage: null };
    },
    async sendPasswordSetupEmail(email, redirectTo) {
      const { error } = await adminClient.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) {
        console.error("[inviteAccountResolver] resetPasswordForEmail 失敗", error);
        return { errorMessage: error.message };
      }
      return { errorMessage: null };
    },
  };
}
