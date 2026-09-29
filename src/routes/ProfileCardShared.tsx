// 使用者決策(2026-09-23):「首頁」分頁籤拔掉,原本掛在那裡的個人資料相關 UI 分散到不同地方
// (詳見 HomePage.tsx/ManagePage.tsx 開頭的說明)。這幾個小元件同時被兩邊用到,抽出來共用,
// 不要各自複製一份。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 「更改登入信箱」改 ② 次要(這兩個小區塊都不是頁面的主要動作)。
//   - 🔴「已寄出驗證信到 …,尚未完成驗證」改成 🟡 常駐 `!`(AlertNote):這是「現在的狀態跟
//     使用者以為的不一樣」—— 他以為信箱已經改好了,其實還沒生效(skill 二,第三類)。
//   - 商家管理員建議新信箱那張卡:「套用並寄出驗證信」是那張卡片最主要的動作 ⇒ ① 主要,
//     「忽略」⇒ ② 次要;卡片圓角/間距對齊 skill 的一套規格。
// **只動外觀,不動行為**:套用 / 忽略的 API 呼叫與 toast 文案全部照舊。

import { useState } from "react";
import { toast } from "sonner";

import { AlertNote } from "@/components/patterns";
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
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-sm">
          <span className="text-muted-foreground">登入信箱:</span>
          <span className="break-all font-semibold text-foreground">{email ?? "-"}</span>
        </div>
        <ChangeLoginEmailDialog
          trigger={
            // ② 次要:這不是頁面的主要動作(skill 二之三)。
            <Button type="button" variant="neutral" size="card" className="shrink-0">
              更改登入信箱
            </Button>
          }
        />
      </div>
      {newEmail ? (
        // 🟡 常駐 `!`:他以為信箱已經改好了,其實還沒生效(skill 二,第三類)。
        <AlertNote>
          已寄出驗證信到 <span className="break-all font-semibold">{newEmail}</span>,
          <strong>還沒完成驗證</strong>
          ,所以目前登入還是要用上面那個舊信箱。請到新信箱收信並點連結完成確認。
        </AlertNote>
      ) : null}
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
    <div className="flex flex-col gap-3 rounded-xl border border-brand/40 bg-brand-soft/40 p-4">
      <p className="text-sm leading-relaxed text-foreground">
        商家管理員建議把你的登入信箱改成「
        <span className="break-all font-semibold">{pendingEmail}</span>
        」,要套用嗎？套用後系統會寄一封驗證信到這個新信箱,你點連結確認後才會真正生效。
      </p>
      <div className="flex flex-wrap gap-2">
        {/* 這張卡片最主要的動作 ⇒ ① 主要;「忽略」⇒ ② 次要(skill 二之三)。 */}
        <Button
          type="button"
          variant="primary"
          size="touch"
          disabled={applying || ignoring}
          onClick={handleApply}
        >
          {applying ? "送出中⋯" : "套用並寄出驗證信"}
        </Button>
        <Button
          type="button"
          variant="neutral"
          size="touch"
          disabled={ignoring || applying}
          onClick={handleIgnore}
        >
          {ignoring ? "處理中⋯" : "忽略"}
        </Button>
      </div>
    </div>
  );
}
