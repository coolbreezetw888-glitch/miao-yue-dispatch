// 對應規格書 .project/specs/帳號登入安全性優化.md 3.2.1:忘記密碼申請頁(新路由
// /forgot-password),公開頁面,跟 /signin、/signup 同層級,不需要登入狀態。三種登入身份
// (商家管理員/客服/服務人員)共用同一個入口,不分角色處理(規則 3.1.1)。
//
// 規則 3.1.2(資安補強,規劃階段主動加上,不是使用者要求項目):不管輸入的 email 有沒有對應到
// 任何帳號,一律顯示同一句模糊化文案,避免有心人拿一串 email 去試,從系統回應的差異反推
// 「這個 email 是不是秒約的客戶」。resetPasswordForEmail 本身查無帳號也不會報錯,原生就適合
// 搭配這種寫法——這裡刻意不特別去分辨「成功」跟「查無帳號」兩種情況,兩者都當同一種結果處理。

import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { AuthShell } from "@/components/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    // 規則 3.1.2:不論 error 是否存在,都不影響下面顯示的文案——一律當作同一種結果處理。
    await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: `${window.location.origin}/app/reset-password`,
    });
    setLoading(false);
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <AuthShell title="請檢查信箱" subtitle="重設密碼信可能需要幾分鐘才會送達">
        <p className="text-sm text-muted-foreground">
          如果這個 email 有對應的帳號,系統已經寄出重設密碼信,請檢查收件匣(含垃圾郵件夾)。
        </p>
        <Button className="mt-6 w-full" variant="outline" asChild>
          <Link to="/signin">返回登入頁</Link>
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="忘記密碼" subtitle="輸入登入用的 Email,我們會寄一封重設密碼信給你。">
      <form onSubmit={onSubmit} className="space-y-5">
        <div>
          <Label htmlFor="forgot-password-email">Email</Label>
          <Input
            id="forgot-password-email"
            type="email"
            required
            autoComplete="email"
            className="mt-2"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </div>
        <Button type="submit" variant="cta" size="lg" className="w-full" disabled={loading}>
          {loading ? "寄送中⋯" : "寄送重設密碼信"}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        想起密碼了？{" "}
        <Link to="/signin" className="font-semibold text-primary hover:underline">
          返回登入
        </Link>
      </p>
    </AuthShell>
  );
}
