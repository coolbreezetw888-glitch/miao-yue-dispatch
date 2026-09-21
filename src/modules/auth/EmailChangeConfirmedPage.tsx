// 對應規格書(帳號登入安全性優化).md 2.4.4:登入信箱變更確認後的轉場頁(新路由
// /app/email-change-confirmed),是 2.5.2 ChangeLoginEmailDialog.tsx 呼叫 updateUser({ email })
// 時帶的 emailRedirectTo 目標。完全比照既有 AgentInviteCompletePage.tsx 的轉場頁結構,但這裡
// 不需要設密碼、也不需要呼叫任何「轉為 active」的函式——單純呼叫 getVerifiedUser() 確認連結有效,
// 顯示對應的成功/待確認訊息。
//
// 2.3.2 動工前查證:Supabase 專案的 Authentication → Sign In / Providers → Email 裡「Secure
// email change」已經是開啟狀態(2026-09-21 用瀏覽器實際確認過,不是用猜的)——代表新舊信箱都要
// 各自點一次驗證連結,email 才會真的改變。但這裡刻意不寫死「一定要顯示雙重確認文案」,而是每次
// 都用 getVerifiedUser() 讀回來的 user.new_email 動態判斷:
//   - new_email 還有值 → 代表还在等另一封信的驗證,顯示「已確認其中一封信,請完成另一封信」。
//   - new_email 是 null → 代表這次點擊已經是最後一次確認,email 已經真的改變,顯示成功訊息。
// 這個判斷方式比「寫死看 Secure email change 是否開啟」更穩健——不管之後這個專案設定被誰改掉,
// 畫面都會照當下真實的驗證狀態顯示正確文案,不需要跟著改程式碼。

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { AuthShell } from "@/components/AuthShell";
import { Button } from "@/components/ui/button";
import { getVerifiedUser } from "@/lib/auth-guard";

type PageState =
  | { kind: "checking" }
  | { kind: "invalid" }
  | { kind: "confirmed"; email: string }
  | { kind: "partially-confirmed"; pendingEmail: string };

export default function EmailChangeConfirmedPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<PageState>({ kind: "checking" });

  useEffect(() => {
    let active = true;
    getVerifiedUser().then((user) => {
      if (!active) return;
      if (!user) {
        setState({ kind: "invalid" });
        return;
      }
      if (user.new_email) {
        // 「Secure email change」雙重確認開啟時,這裡代表使用者剛點完其中一封信,
        // 另一封信(new_email 指向的信箱)還沒點。
        setState({ kind: "partially-confirmed", pendingEmail: user.new_email });
      } else {
        setState({ kind: "confirmed", email: user.email ?? "" });
      }
    });
    return () => {
      active = false;
    };
  }, []);

  if (state.kind === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      </div>
    );
  }

  if (state.kind === "invalid") {
    return (
      <AuthShell title="連結已失效" subtitle="這個連結可能已經使用過或過期了">
        <p className="text-sm text-muted-foreground">
          請重新登入後,在個人資料卡片重新發起一次「更改登入信箱」。
        </p>
        <Button className="mt-6 w-full" variant="outline" onClick={() => navigate("/signin")}>
          前往登入頁
        </Button>
      </AuthShell>
    );
  }

  if (state.kind === "partially-confirmed") {
    return (
      <AuthShell title="已確認其中一封信" subtitle="還差一步,信箱才會真的更新">
        <p className="text-sm text-muted-foreground">
          這個信箱啟用了雙重確認,新舊信箱都要各自點一次驗證連結。請到「{state.pendingEmail}
          」這個信箱收信,點擊裡面的連結完成另一半確認,登入信箱才會真正生效。
        </p>
        <Button className="mt-6 w-full" onClick={() => navigate("/app", { replace: true })}>
          我知道了,前往後台
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="登入信箱已更新" subtitle={`已成功更新為「${state.email}」`}>
      <p className="text-sm text-muted-foreground">下次登入請使用這個新信箱。</p>
      <Button className="mt-6 w-full" onClick={() => navigate("/app", { replace: true })}>
        前往後台
      </Button>
    </AuthShell>
  );
}
