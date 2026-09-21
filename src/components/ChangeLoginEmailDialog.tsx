// 對應規格書(帳號登入安全性優化).md 2.5.2:「更改登入信箱」共用對話框,角色無關(商家管理員/
// 客服/服務人員本人改自己的登入信箱都是同一套呼叫,規則 2.3.2)。
//
// 送出後呼叫 supabase.auth.updateUser({ email, options: { emailRedirectTo } }),這支呼叫本來就
// 只會影響「呼叫者自己」的 auth.users 那一列,技術上不可能改到別人的,所以這裡不需要額外的角色/
// 權限檢查(規則 2.3.2 理由)。emailRedirectTo 固定指向 2.4.4 新增的 EmailChangeConfirmedPage
// (/app/email-change-confirmed),不使用 Supabase 專案設定的預設 Site URL(語意不清楚)。

import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

export function ChangeLoginEmailDialog({
  trigger,
  onSubmitted,
}: {
  trigger: React.ReactNode;
  /** 驗證信寄出成功後呼叫(呼叫端目前不需要做任何事,保留擴充彈性,比照既有 onSaved 慣例)。 */
  onSubmitted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function resetForm() {
    setEmail("");
    setConfirmEmail("");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const newEmail = email.trim().toLowerCase();
    if (!newEmail) return;
    if (newEmail !== confirmEmail.trim().toLowerCase()) {
      toast.error("兩次輸入的信箱不一致");
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await supabase.auth.updateUser(
        { email: newEmail },
        { emailRedirectTo: `${window.location.origin}/app/email-change-confirmed` },
      );
      if (error) throw error;

      toast.success("驗證信已寄出到新信箱", {
        description: "請點連結完成確認,目前登入信箱在你確認前不會改變。",
      });
      setOpen(false);
      resetForm();
      onSubmitted?.();
    } catch (err) {
      toast.error("送出失敗", { description: getErrorMessage(err) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) resetForm();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>更改登入信箱</DialogTitle>
          <DialogDescription>
            送出後系統會寄一封驗證信到新信箱,你需要點連結確認後,登入信箱才會真的改變。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="change-login-email-new">新的登入 Email</Label>
            <Input
              id="change-login-email-new"
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
            <Label htmlFor="change-login-email-confirm">再輸入一次新信箱</Label>
            <Input
              id="change-login-email-confirm"
              type="email"
              required
              autoComplete="email"
              className="mt-2"
              value={confirmEmail}
              onChange={(e) => setConfirmEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting || !email.trim() || !confirmEmail.trim()}>
              {submitting ? "送出中⋯" : "送出並寄出驗證信"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
