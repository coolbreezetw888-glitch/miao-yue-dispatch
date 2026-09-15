import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { MerchantSwitcher } from "@/modules/merchant/MerchantSwitcher";
import { useCurrentMerchant, useGroupMerchants } from "@/modules/merchant/context";
import { INDUSTRY_TYPE_LABELS } from "@/modules/merchant/types";
import type { IndustryType } from "@/modules/merchant/types";

export default function AppShell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  const { merchants, isLoading: merchantsLoading } = useGroupMerchants();
  const { merchant: currentMerchant } = useCurrentMerchant();

  useEffect(() => {
    let active = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!active) return;
      if (!data.user) {
        navigate("/signin", { replace: true });
        return;
      }
      setEmail(data.user.email ?? null);
      setAuthChecked(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) navigate("/signin", { replace: true });
      else setEmail(session.user.email ?? null);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [navigate]);

  // 對應規格書 4.6:登入後檢查目前使用者是否至少是一間商家的管理員，不是的話導向 Onboarding(4.1)。
  useEffect(() => {
    if (!authChecked || merchantsLoading) return;
    if (merchants.length === 0) {
      navigate("/app/onboarding", { replace: true });
    }
  }, [authChecked, merchantsLoading, merchants.length, navigate]);

  async function handleSignOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate("/signin", { replace: true });
  }

  if (!authChecked || merchantsLoading || (merchants.length === 0 && authChecked)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface font-sans antialiased">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-5">
          <Link to="/" className="flex shrink-0 items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-brand-foreground">
              秒
            </span>
            <span className="text-lg font-bold tracking-tight text-foreground">秒約</span>
          </Link>
          <div className="flex flex-1 items-center justify-end gap-2">
            <MerchantSwitcher />
            <Button variant="outline" size="sm" asChild>
              <Link to="/app/new-merchant">新增分店</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to="/app/settings">商家設定</Link>
            </Button>
            <Button variant="outline" size="sm" onClick={handleSignOut}>
              登出
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-20">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Hi {email}</h1>
        <div className="mt-8 rounded-2xl border border-border bg-card p-8">
          {currentMerchant ? (
            <>
              <p className="text-sm text-muted-foreground">目前操作中的商家</p>
              <p className="mt-1 text-xl font-semibold text-foreground">{currentMerchant.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {INDUSTRY_TYPE_LABELS[currentMerchant.industry_type as IndustryType] ??
                  currentMerchant.industry_type}
                {currentMerchant.status === "disabled" ? "・已停用" : ""}
              </p>
            </>
          ) : null}
          <p className="mt-6 text-base leading-relaxed text-muted-foreground">
            你的派工管理後台即將上線 — 下一個里程碑會加上人員、服務項目與訂單管理功能。
          </p>
        </div>
      </main>
    </div>
  );
}
