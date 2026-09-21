// 對應規格書(帳號登入安全性優化).md 2.5.3:人員管理頁(StaffListPage.tsx/AgentListPage.tsx)
// 管理員視角的「登入信箱」欄位與修改入口。服務人員/客服共用同一套元件,呼叫端只要傳入對應的
// query/mutation 包裝函式即可,不因為角色不同而有兩套 UI。

import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import type { UseQueryResult } from "@tanstack/react-query";
import type { LoginEmailStatus } from "./api";

/**
 * 對應規格書 2.5.3 第 1 點/規則 2.3.3:顯示目前實際的登入信箱,以及兩種待驗證狀態徽章
 * (分開顯示,不合併成一句混淆的文字)。只在 statusQuery 有資料時渲染,載入中顯示「載入中⋯」。
 */
export function LoginEmailStatusDisplay({
  statusQuery,
}: {
  statusQuery: UseQueryResult<LoginEmailStatus>;
}) {
  if (statusQuery.isLoading) {
    return <p className="text-xs text-muted-foreground">登入信箱:載入中⋯</p>;
  }
  const status = statusQuery.data;
  if (!status) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <span>登入信箱:{status.currentLoginEmail ?? "-"}</span>
      {status.pendingAdminSuggestedEmail ? (
        <Badge variant="secondary">
          已建議新信箱「{status.pendingAdminSuggestedEmail}」,待本人確認套用
        </Badge>
      ) : null}
      {status.pendingConfirmationEmail ? (
        <Badge variant="outline">
          待驗證變更中(新信箱:{status.pendingConfirmationEmail}),尚未生效
        </Badge>
      ) : null}
    </div>
  );
}

/**
 * 對應規格書 2.5.3 第 2/3 點:管理員輸入建議的新信箱(呼叫 onSubmit)或撤回既有建議
 * (呼叫 onWithdraw)。送出成功的提示文案明確說明「這只是建議,要等本人套用+新信箱主人驗證
 * 才會真的生效」,避免管理員誤以為按下去就立刻生效。
 */
export function AdminSuggestLoginEmailDialog({
  personLabel,
  currentSuggestion,
  onSubmit,
  onWithdraw,
}: {
  personLabel: string;
  currentSuggestion: string | null | undefined;
  onSubmit: (newEmail: string) => Promise<void>;
  onWithdraw: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit(email.trim());
      setEmail("");
      setOpen(false);
      toast.success("已送出建議", {
        description:
          "這只是建議,要等對方本人登入後自己按套用、新信箱主人也點了驗證信,才會真的改成這個信箱。",
      });
    } catch (err) {
      toast.error("送出失敗", { description: getErrorMessage(err) });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleWithdraw() {
    setWithdrawing(true);
    try {
      await onWithdraw();
      toast.success("已撤回建議");
    } catch (err) {
      toast.error("撤回失敗", { description: getErrorMessage(err) });
    } finally {
      setWithdrawing(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          修改登入信箱
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>建議「{personLabel}」的新登入信箱</DialogTitle>
          <DialogDescription>
            這只是建議,不會立刻生效,也不會馬上寄出任何驗證信——要等對方本人登入後自己按套用、
            新信箱主人也點了驗證信,才會真的改成這個信箱。
          </DialogDescription>
        </DialogHeader>

        {currentSuggestion ? (
          <div className="rounded-md border border-border bg-muted/50 p-3 text-sm">
            <p>
              目前已建議的新信箱:<span className="font-medium">{currentSuggestion}</span>
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={withdrawing}
              onClick={handleWithdraw}
            >
              {withdrawing ? "撤回中⋯" : "撤回建議"}
            </Button>
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="admin-suggest-login-email">
              {currentSuggestion ? "改成其他信箱" : "建議的新登入 Email"}
            </Label>
            <Input
              id="admin-suggest-login-email"
              type="email"
              className="mt-2"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting || !email.trim()}>
              {submitting ? "送出中⋯" : "送出建議"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
