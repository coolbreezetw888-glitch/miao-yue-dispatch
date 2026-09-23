// 使用者決策(2026-09-23):「首頁」分頁籤拔掉,原本掛在那裡的個人資料相關 UI 分散到不同地方
// (詳見 HomePage.tsx/ManagePage.tsx 開頭的說明)。這幾個小元件同時被兩邊用到,抽出來共用,
// 不要各自複製一份。

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ChangeLoginEmailDialog } from "@/components/ChangeLoginEmailDialog";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { supabase } from "@/integrations/supabase/client";

/** 兩者都沒填時 fallback 顯示帳號 email 的 @ 前半段。 */
export function emailNamePrefix(email: string | null): string {
  if (!email) return "使用者";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

/** 三種角色共用的「登入信箱」小區塊——顯示目前的登入 email +「更改登入信箱」按鈕 +
 * 如果有 Supabase 原生待驗證的新信箱,附註小字提示。 */
export function LoginEmailSection({
  email,
  newEmail,
}: {
  email: string | null;
  newEmail: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
      <div className="text-sm">
        <span className="text-muted-foreground">登入信箱:</span>
        <span className="font-medium text-foreground">{email ?? "-"}</span>
        {newEmail ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            ・已寄出驗證信到 {newEmail},尚未完成驗證
          </p>
        ) : null}
      </div>
      <ChangeLoginEmailDialog
        trigger={
          <Button variant="outline" size="sm">
            更改登入信箱
          </Button>
        }
      />
    </div>
  );
}

/** 只有 isAgent/isStaff 才會用到——商家管理員建議了新信箱、本人還沒按套用時顯示。 */
export function PendingAdminLoginEmailSuggestionCard({
  pendingEmail,
  onClear,
}: {
  pendingEmail: string;
  onClear: () => Promise<unknown>;
}) {
  const [applying, setApplying] = useState(false);
  const [ignoring, setIgnoring] = useState(false);

  async function handleApply() {
    setApplying(true);
    try {
      const { error } = await supabase.auth.updateUser(
        { email: pendingEmail },
        { emailRedirectTo: `${window.location.origin}/app/email-change-confirmed` },
      );
      if (error) throw error;
      await onClear();
      toast.success("驗證信已寄出", {
        description: `請到「${pendingEmail}」收信,點連結完成確認後登入信箱才會真正生效。`,
      });
    } catch (err) {
      toast.error("套用失敗", { description: getErrorMessage(err) });
    } finally {
      setApplying(false);
    }
  }

  async function handleIgnore() {
    setIgnoring(true);
    try {
      await onClear();
      toast.success("已忽略這筆建議");
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    } finally {
      setIgnoring(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand/40 bg-brand-soft/40 p-5">
      <p className="text-sm text-foreground">
        商家管理員建議把你的登入信箱改成「<span className="font-semibold">{pendingEmail}</span>
        」,要套用嗎？套用後系統會寄一封驗證信到這個新信箱,你點連結確認後才會真正生效。
      </p>
      <div className="flex shrink-0 gap-2">
        <Button variant="outline" size="sm" disabled={ignoring || applying} onClick={handleIgnore}>
          {ignoring ? "處理中⋯" : "忽略"}
        </Button>
        <Button size="sm" disabled={applying || ignoring} onClick={handleApply}>
          {applying ? "送出中⋯" : "套用並寄出驗證信"}
        </Button>
      </div>
    </div>
  );
}
