// 對應規格書 3.5(Edge Function 的 redirectTo 目標)/3.8(mark_agent_active_if_self)。
// 客服點邀請信裡的連結後,Supabase 會先建立一個暫時的登入狀態並導回這裡(URL 帶著一次性的驗證資訊,
// supabase-js 預設的 detectSessionInUrl 會自動處理掉),但這個人還沒有設定密碼——這頁負責:
//   1. 確認真的有一個由邀請連結建立的登入狀態(呼叫 getVerifiedUser(),規則 2.10)。
//   2. 請對方設定一組密碼(supabase.auth.updateUser({ password }))。
//   3. 密碼設定成功後呼叫 mark_agent_active_if_self(),把自己所有 invited 狀態的客服紀錄轉為 active。
//   4. 導去 /app,後續就是一般客服登入後台的流程。
// 這個路由本身不在規格書第四節(4.1-4.5)逐條列出,是 3.8 描述的流程必須存在的轉場頁,
// 已在回報中向主腦/使用者說明(見規格書 3.5/3.8 沒有明講這頁要長什麼樣子,這是工程師依流程需要補上的頁面)。
//
// 2026-09-21 主腦要求比照模組 14 服務人員端問題 3 的修法一併修正(同一個 bug,同一種程式碼模式):
// 第 4 步原本直接 navigate("/app"),沒有先讓「目前使用者能存取哪些商家」這份 react-query 快取
// 重新抓一次。這份快取(src/modules/merchant/context.tsx 的 CurrentMerchantProvider)包在
// <App> 最外層,整個 SPA 只掛載一次、不會因為從這頁換到 /app 而重新 mount——使用者一進到這頁,
// session 剛從邀請連結的網址建立,CurrentMerchantProvider 立刻用這個 session 打了一次「我能存取
// 哪些商家」的查詢,但那個當下客服的 status 還是 invited(還沒設定密碼),所以查回來合法地是
// 「0 間商家」,react-query 把這個 0 筆結果快取起來。等這裡呼叫完 mark_agent_active_if_self()
// 把 status 改成 active,直接 navigate("/app") 並不會讓那份已經快取住的「0 筆」自動變新,
// AppLayout 讀到的還是舊的 0 筆,就誤判成「沒有任何商家」導去 /app/onboarding——已用本機完整
// Supabase stack(gotrue+mailpit+edge-runtime)實際重現一次真實邀請流程(建測試商家+客服帳號、
// 走 invite-merchant-agent、Mailpit 收信、瀏覽器點連結設密碼)確認症狀,跟服務人員那條完全一樣。
// 修法完全比照既有 src/modules/merchant/OnboardingPage.tsx 建店成功後的既有寫法,以及
// src/modules/staff-portal/StaffInviteCompletePage.tsx 問題 3 的修正:呼叫
// useRefetchAccessibleMerchants() 拿到的函式會回傳 react-query invalidateQueries 的 promise,
// await 它讓快取真正重新抓完、確認這間商家已經在清單裡,才 navigate("/app")。

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { AuthShell } from "@/components/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { getVerifiedUser } from "@/lib/auth-guard";
import { useRefetchAccessibleMerchants } from "@/modules/merchant/context";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import { markAgentActiveIfSelf } from "./api";

export default function AgentInviteCompletePage() {
  const navigate = useNavigate();
  const refetchAccessibleMerchants = useRefetchAccessibleMerchants();
  const [status, setStatus] = useState<"checking" | "ready" | "invalid">("checking");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    // 規則 2.10:一律用 getVerifiedUser() 判斷登入狀態,不自己另外呼叫 Supabase Auth API。
    getVerifiedUser().then((user) => {
      if (!active) return;
      setStatus(user ? "ready" : "invalid");
    });
    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 6) {
      toast.error("密碼至少需要 6 個字元");
      return;
    }
    if (password !== confirmPassword) {
      toast.error("兩次輸入的密碼不一致");
      return;
    }

    setSubmitting(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;

      await markAgentActiveIfSelf();
      // 修正(比照模組 14 服務人員端問題 3):先讓「目前使用者能存取哪些商家」的快取重新抓完
      // (此時 status 已經是 active,查得到這間商家了),再導去 /app,避免 AppLayout 讀到
      // 邀請連結剛載入頁面時快取住的舊值(那個當下 status 還是 invited,查回來合法地是 0 間商家)。
      await refetchAccessibleMerchants();

      toast.success("密碼設定完成,歡迎加入!");
      navigate("/app", { replace: true });
    } catch (err) {
      toast.error("設定失敗", { description: getErrorMessage(err) });
    } finally {
      setSubmitting(false);
    }
  }

  if (status === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      </div>
    );
  }

  if (status === "invalid") {
    return (
      <AuthShell title="邀請連結已失效" subtitle="這個連結可能已經使用過或過期了">
        <p className="text-sm text-muted-foreground">
          請聯絡邀請你的商家管理員,請對方重新寄送一次邀請信。
        </p>
        <Button className="mt-6 w-full" variant="outline" onClick={() => navigate("/signin")}>
          前往登入頁
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="設定你的密碼" subtitle="完成後就能以客服身份登入秒約後台">
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <Label htmlFor="invite-password">新密碼</Label>
          <Input
            id="invite-password"
            type="password"
            required
            minLength={6}
            autoComplete="new-password"
            className="mt-2"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 6 個字元"
          />
        </div>
        <div>
          <Label htmlFor="invite-password-confirm">再輸入一次</Label>
          <Input
            id="invite-password-confirm"
            type="password"
            required
            minLength={6}
            autoComplete="new-password"
            className="mt-2"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </div>
        <Button type="submit" variant="cta" size="lg" className="w-full" disabled={submitting}>
          {submitting ? "設定中⋯" : "完成設定"}
        </Button>
      </form>
    </AuthShell>
  );
}
