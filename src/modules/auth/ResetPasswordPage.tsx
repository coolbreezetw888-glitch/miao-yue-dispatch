// 對應規格書 .project/specs/帳號登入安全性優化.md 3.2.2:忘記密碼重設頁(新路由
// /app/reset-password),是 forgot-password.tsx 呼叫 resetPasswordForEmail 時帶的 redirectTo
// 目標。三種登入身份(商家管理員/客服/服務人員)共用同一套邏輯(規則 3.1.1),角色判斷完全交給
// 密碼設定成功、導向 /app 之後的既有 useMerchantRole 機制,這裡完全不涉及角色判斷。
//
// 完全比照既有 src/modules/staff-agent/AgentInviteCompletePage.tsx 的結構改寫,差異只有
// (規格書 3.2.2 明講的三點):
//   1. 文案改成「重設密碼」情境,不是「第一次設定密碼加入」。
//   2. 不呼叫任何 mark_agent_active_if_self/mark_staff_login_active_if_self 這類狀態轉換函式——
//      會走到這個流程的人本來就已經是 active 狀態,重設密碼不改變任何 status/login_status。
//   3. 密碼設定成功後,仍然比照既有的防呆修正,呼叫 useRefetchAccessibleMerchants() 的 await
//      再導向 /app,確保商家清單快取是最新的(保持跟既有轉場頁一致的防呆寫法,成本低)。

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

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const refetchAccessibleMerchants = useRefetchAccessibleMerchants();
  const [status, setStatus] = useState<"checking" | "ready" | "invalid">("checking");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
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

      // 3.2.2 第 3 點:比照既有轉場頁的防呆寫法,確保「目前使用者能存取哪些商家」的快取是最新的
      // 再導向 /app。
      await refetchAccessibleMerchants();

      toast.success("密碼已重設完成");
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
      <AuthShell title="重設密碼連結已失效" subtitle="這個連結可能已經使用過或過期了">
        <p className="text-sm text-muted-foreground">
          請回到忘記密碼頁重新申請一次重設密碼信。
        </p>
        <Button className="mt-6 w-full" variant="outline" onClick={() => navigate("/forgot-password")}>
          重新申請
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="重設你的密碼" subtitle="設定完成後就能用新密碼登入秒約後台">
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <Label htmlFor="reset-password-new">新密碼</Label>
          <Input
            id="reset-password-new"
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
          <Label htmlFor="reset-password-confirm">再輸入一次</Label>
          <Input
            id="reset-password-confirm"
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
          {submitting ? "設定中⋯" : "完成重設"}
        </Button>
      </form>
    </AuthShell>
  );
}
