import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { getVerifiedUser } from "@/lib/auth-guard";
import { MerchantSwitcher } from "@/modules/merchant/MerchantSwitcher";
import {
  useClearCurrentMerchantSelection,
  useCurrentMerchant,
  useGroupMerchants,
} from "@/modules/merchant/context";
import { INDUSTRY_TYPE_LABELS } from "@/modules/merchant/types";
import type { IndustryType } from "@/modules/merchant/types";
import { useCurrentMerchantRole } from "@/modules/staff-agent/context";

export default function AppShell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  const { merchants, isLoading: merchantsLoading } = useGroupMerchants();
  const { merchant: currentMerchant } = useCurrentMerchant();
  const clearCurrentMerchantSelection = useClearCurrentMerchantSelection();
  // 對應規格書(人員與權限管理)4.5:客服登入後,不顯示「新增分店」「商家設定」「人員/客服管理」
  // 這些管理員專屬的操作按鈕。isAdmin 在角色還沒判斷完成時(role === undefined,含 role
  // 尚未 enabled)先當作 false,避免畫面短暫誤閃管理員按鈕。
  const { data: merchantRole } = useCurrentMerchantRole();
  const isAdmin = merchantRole === "admin";

  useEffect(() => {
    let active = true;
    // 2026-09 修正:改用 getVerifiedUser()(內部呼叫 supabase.auth.getUser() 並保證不會
    // reject),取代直接呼叫 supabase.auth.getUser()。原本這裡沒有 .catch(),萬一 getUser()
    // 意外 reject,authChecked 永遠不會變成 true,畫面會卡死在「載入中」;另外憑證確實無效時,
    // getVerifiedUser() 會順手清掉本機那份無效憑證,避免 /signin 頁面誤判成「已登入」導回這裡,
    // 形成無限跳轉迴圈(完整原因見 src/lib/auth-guard.ts)。
    getVerifiedUser().then((user) => {
      if (!active) return;
      if (!user) {
        navigate("/signin", { replace: true });
        return;
      }
      setEmail(user.email ?? null);
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

  function handleSignOut() {
    // 2026-09-15 主腦複查修正(QA 複驗抓到:登出後每次都穩定卡在 /app/onboarding 5-9 秒才跳轉，
    // 不是偶發)。深入排查後找到確切原因，不是單純呼叫順序問題：
    //
    // 原本的寫法是 await 完 queryClient.clear() 跟 supabase.auth.signOut() 才 navigate。
    // queryClient.clear() 執行的當下，supabase.auth.signOut() 都還沒開始呼叫，這個 provider
    // 的 userId/authChecked 都還是「登入中」的狀態——clear() 把商家清單快取清空後，會出現一次
    // merchants.length === 0 但 authChecked 仍是 true 的畫面，讓 4.6 AppShell 自己那條
    // 「沒有商家 → 導去 Onboarding」的判斷搶先觸發，導去 /app/onboarding。
    // 導去 /app/onboarding 後 AppShell 整個 unmount，連帶它自己監聽 onAuthStateChange、
    // 原本會負責導回 /signin 的那個 effect 也被清掉——剩下唯一還會導去 /signin 的，只有
    // handleSignOut 這個 async function 自己殘留的 promise chain 尾端，而它前面卡在
    // await supabase.auth.signOut():這是打去 Supabase Auth 伺服器的真實網路請求，
    // 實測就是卡住的那 5-9 秒的來源。
    //
    // 修法:「登出」這個操作，使用者體感上要立即生效，不應該等任何非同步網路請求跑完才轉場。
    // 改成先同步導向 /signin，實際清 session 的網路請求、清 react-query 快取這些收尾動作都
    // 改成背景執行、不擋畫面——這樣從源頭就不會再出現「clear() 先跑，搶先觸發 Onboarding
    // 判斷」這個時序問題，不只是治標地調整呼叫順序。
    navigate("/signin", { replace: true });
    clearCurrentMerchantSelection();
    void queryClient.cancelQueries().then(() => queryClient.clear());
    void supabase.auth.signOut();
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
            {isAdmin ? (
              <>
                <Button variant="outline" size="sm" asChild>
                  <Link to="/app/staff">服務人員</Link>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <Link to="/app/agents">客服管理</Link>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <Link to="/app/new-merchant">新增分店</Link>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <Link to="/app/settings">商家設定</Link>
                </Button>
              </>
            ) : null}
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
