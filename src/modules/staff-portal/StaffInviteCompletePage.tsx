// 對應規格書 4.8(新路由 /app/staff-invite-complete)/3.12(mark_staff_login_active_if_self)。
// 完全比照既有 src/modules/staff-agent/AgentInviteCompletePage.tsx 的結構——服務人員點擊邀請信
// 連結後,Supabase 會先建立一個暫時的登入狀態並導回這裡(URL 帶著一次性的驗證資訊,
// supabase-js 預設的 detectSessionInUrl 會自動處理掉),但這個人還沒有設定密碼——這頁負責:
//   1. 確認真的有一個由邀請連結建立的登入狀態(呼叫 getVerifiedUser(),規則 2.12)。
//   2. 請對方設定一組密碼(supabase.auth.updateUser({ password }))。
//   3. 密碼設定成功後呼叫 mark_staff_login_active_if_self(),把自己所有 login_status=invited
//      的服務人員紀錄轉為 active。
//   4. 導去 /app,這時候 merchants_select 已經能看到這間商家,AppLayout 不會誤導去 Onboarding,
//      後續就是一般服務人員登入後台的流程。
//
// 2026-09-21 使用者人工測試回報問題 3 修正:第 4 步原本直接 navigate("/app"),沒有先讓
// 「目前使用者能存取哪些商家」這份 react-query 快取重新抓一次。這份快取(src/modules/merchant/
// context.tsx 的 CurrentMerchantProvider)包在 <App> 最外層,整個 SPA 只掛載一次、不會因為
// 從這頁換到 /app 而重新 mount——使用者一進到這頁,session 剛從邀請連結的網址建立,
// CurrentMerchantProvider 立刻用這個 session 打了一次「我能存取哪些商家」的查詢,但那個當下
// login_status 還是 invited(還沒設定密碼),所以查回來合法地是「0 間商家」,react-query 把
// 這個 0 筆結果快取起來。等這裡呼叫完 mark_staff_login_active_if_self() 把 login_status
// 改成 active,直接 navigate("/app") 並不會讓那份已經快取住的「0 筆」自動變新,AppLayout 讀到
// 的還是舊的 0 筆,就誤判成「沒有任何商家」導去 /app/onboarding,顯示出「開始使用秒約」的
// 建立商家表單——不是 Supabase Auth 轉址設定的問題,也不是資料庫權限的問題(用真實帳號實測
// 過,mark_staff_login_active_if_self 呼叫後資料庫裡 login_status 確實變成 active,直接用
// 這個使用者的 JWT 呼叫 REST API 查 merchants 也查得到這間商家,純粹是前端快取沒有在這個時間點
// 重新抓)。修法完全比照既有 src/modules/merchant/OnboardingPage.tsx 建店成功後的既有寫法:
// 呼叫 useRefetchAccessibleMerchants() 拿到的函式會回傳 react-query invalidateQueries 的
// promise,await 它讓快取真正重新抓完、確認新商家已經在清單裡,才 navigate("/app")。
//
// 對應調整:同一個 bug 理論上也存在於 src/modules/staff-agent/AgentInviteCompletePage.tsx
// (客服邀請完成頁,同樣的模式、同樣沒有呼叫 refetch)——已用同樣的方式實際重現一次並確認症狀
// 完全相同,但這次任務只要求修服務人員這條、客服那條回報給主腦即可,這裡刻意不動。

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

import { markStaffLoginActiveIfSelf } from "./api";

export default function StaffInviteCompletePage() {
  const navigate = useNavigate();
  const refetchAccessibleMerchants = useRefetchAccessibleMerchants();
  const [status, setStatus] = useState<"checking" | "ready" | "invalid">("checking");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    // 規則 2.12:一律用 getVerifiedUser() 判斷登入狀態,不自己另外呼叫 Supabase Auth API。
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

      await markStaffLoginActiveIfSelf();
      // 修正問題 3:先讓「目前使用者能存取哪些商家」的快取重新抓完(此時 login_status 已經是
      // active,查得到這間商家了),再導去 /app,避免 AppLayout 讀到邀請連結剛載入頁面時
      // 快取住的舊值(那個當下 login_status 還是 invited,查回來合法地是 0 間商家)。
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
    <AuthShell title="設定你的密碼" subtitle="完成後就能以服務人員身份登入秒約後台">
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <Label htmlFor="staff-invite-password">新密碼</Label>
          <Input
            id="staff-invite-password"
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
          <Label htmlFor="staff-invite-password-confirm">再輸入一次</Label>
          <Input
            id="staff-invite-password-confirm"
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
