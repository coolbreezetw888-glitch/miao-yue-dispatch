import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { AuthShell } from "@/components/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/signin")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "登入｜秒約 Miao Yue" },
      { name: "description", content: "登入秒約派工預約系統，管理訂單、排程與結算。" },
      { property: "og:title", content: "登入｜秒約 Miao Yue" },
      { property: "og:description", content: "登入秒約派工預約系統。" },
    ],
  }),
  component: SignIn,
});

function SignIn() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/app", replace: true });
    });
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
    navigate({ to: "/app", replace: true });
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
