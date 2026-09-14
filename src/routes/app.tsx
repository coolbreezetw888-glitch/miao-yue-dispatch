import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/app")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "派工後台｜秒約 Miao Yue" },
      { name: "description", content: "秒約派工管理後台。" },
      { property: "og:title", content: "派工後台｜秒約 Miao Yue" },
      { property: "og:description", content: "秒約派工管理後台。" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AppShell,
});

function AppShell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let active = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!active) return;
      if (!data.user) {
        navigate({ to: "/signin", replace: true });
        return;
      }
      setEmail(data.user.email ?? null);
      setChecked(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) navigate({ to: "/signin", replace: true });
      else setEmail(session.user.email ?? null);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [navigate]);

  async function handleSignOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/signin", replace: true });
  }

  if (!checked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface font-sans antialiased">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-5">
          <Link to="/" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-brand-foreground">
              秒
            </span>
            <span className="text-lg font-bold tracking-tight text-foreground">秒約</span>
          </Link>
          <Button variant="outline" size="sm" onClick={handleSignOut}>
            登出
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-20">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Hi {email}</h1>
        <div className="mt-8 rounded-2xl border border-border bg-card p-8">
          <p className="text-base leading-relaxed text-muted-foreground">
            你的派工管理後台即將上線 — 下一個里程碑會加上商家、師傅與訂單管理功能。
          </p>
        </div>
      </main>
    </div>
  );
}
