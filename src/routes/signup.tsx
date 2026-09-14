import { Link, useNavigate } from "react-router-dom";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { AuthShell } from "@/components/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

export default function SignUp() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin },
    });
    setLoading(false);
    if (error) {
      toast.error("註冊失敗", { description: error.message });
      return;
    }
    if (data.session) {
      navigate("/app", { replace: true });
      return;
    }
    toast.success("帳號已建立", { description: "請使用剛剛的 Email 與密碼登入。" });
    navigate("/signin", { replace: true });
  }

  return (
    <AuthShell title="建立秒約帳號" subtitle="只需要 Email 與密碼，馬上開始。">
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
            minLength={6}
            autoComplete="new-password"
            className="mt-2"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 6 個字元"
          />
        </div>
        <Button type="submit" variant="cta" size="lg" className="w-full" disabled={loading}>
          {loading ? "建立中⋯" : "建立帳號"}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        已經有帳號？{" "}
        <Link to="/signin" className="font-semibold text-primary hover:underline">
          登入
        </Link>
      </p>
    </AuthShell>
  );
}
