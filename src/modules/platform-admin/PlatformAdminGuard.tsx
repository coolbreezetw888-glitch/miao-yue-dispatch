// 對應規格書 4.1:超級管理員後台路由守衛。
// 比照 src/routes/app.tsx 的寫法(supabase.auth.getUser() + onAuthStateChange),
// 額外呼叫 am_i_platform_admin()。不是平台管理員就導回 /app(不是 404 頁),
// 避免洩漏「這個路徑其實存在,只是你沒權限」這種資訊,直接當作路徑不存在對待。

import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { supabase } from "@/integrations/supabase/client";
import { getVerifiedUser } from "@/lib/auth-guard";
import { amIPlatformAdmin } from "./api";

export function PlatformAdminGuard({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"checking" | "allowed">("checking");

  useEffect(() => {
    let active = true;

    async function check() {
      // 2026-09 修正:改用 getVerifiedUser(),取代直接呼叫 supabase.auth.getUser()。原因跟
      // src/routes/app.tsx 同一次修正一致(完整原因見 src/lib/auth-guard.ts)。
      const user = await getVerifiedUser();
      if (!active) return;
      if (!user) {
        navigate("/signin", { replace: true });
        return;
      }
      try {
        const isPlatformAdmin = await amIPlatformAdmin();
        if (!active) return;
        if (!isPlatformAdmin) {
          navigate("/app", { replace: true });
          return;
        }
        setStatus("allowed");
      } catch {
        // 呼叫失敗時保守處理成「不是平台管理員」，不讓畫面卡在載入中。
        if (!active) return;
        navigate("/app", { replace: true });
      }
    }

    check();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) navigate("/signin", { replace: true });
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [navigate]);

  if (status !== "allowed") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      </div>
    );
  }

  return <>{children}</>;
}
