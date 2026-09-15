import { Link, useNavigate } from "react-router-dom";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { AuthShell } from "@/components/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { getVerifiedUser } from "@/lib/auth-guard";

export default function SignIn() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    // 2026-09 修正:原本用 supabase.auth.getSession() 判斷「已登入就導去 /app」,但 getSession()
    // 只讀本機快取、不會跟伺服器確認憑證是否還有效。如果本機留著一份已經失效的憑證(過期/被撤銷),
    // 會誤判成「已登入」導回 /app,而 /app 那邊用會打伺服器驗證的 getUser() 發現憑證無效又導回
    // /signin,兩邊各自「信任」不同來源的登入狀態,形成 /app <-> /signin 無限跳轉的迴圈(詳見
    // src/lib/auth-guard.ts 開頭的完整說明)。改用 getVerifiedUser(),確保這裡看到的「已登入」
    // 一定是經伺服器驗證過的結果,不是只讀本機快取。
    getVerifiedUser().then((user) => {
      if (!active) return;
      if (user) navigate("/app", { replace: true });
    });
    return () => {
      active = false;
    };
  }, [navigate]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      toast.error("登入失敗", { description: error.message });
      return;
    }
    navigate("/app", { replace: true });
  }

  return (
    <AuthShell title="登入秒約" subtitle="用 Email 與密碼登入您的派工管理後台。">
      <form onSubmit={onSubmit} className="space-y-5">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            required
            autoComplete="email"
            className="mt-2"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </div>
        <div>
          <Label htmlFor="password">密碼</Label>
          <Input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            className="mt-2"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>
        <Button type="submit" variant="cta" size="lg" className="w-full" disabled={loading}>
          {loading ? "登入中⋯" : "登入"}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        還沒有帳號？{" "}
        <Link to="/signup" className="font-semibold text-primary hover:underline">
          建立帳號
        </Link>
      </p>
    </AuthShell>
  );
}
