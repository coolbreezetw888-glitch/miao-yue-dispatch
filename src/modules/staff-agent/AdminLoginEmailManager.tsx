// 對應規格書(帳號登入安全性優化).md 2.5.3:人員管理頁(StaffListPage.tsx/AgentListPage.tsx)
// 管理員視角的「登入信箱」欄位與修改入口。服務人員/客服共用同一套元件,呼叫端只要傳入對應的
// query/mutation 包裝函式即可,不因為角色不同而有兩套 UI。
//
// ui-v1-full 第二階段第 1 批(盤點 #2 / #3,同一元件、兩個入口):「修改登入信箱」對話框改用
// ui-overlay-patterns 的小卡窗殼(CardDialog,1 欄短表單),欄位改用 FormField / FieldInput,
// 底部改成「取消 / 送出建議」兩顆(手機左右各半、電腦靠右)。入口按鈕改成 ④ 純文字階層
// (variant="text"),因為它現在住在列表卡片的次要資訊區裡,不該跟右側的主要動作搶眼。
// **只動外觀,不動行為**:onSubmit / onWithdraw、送出後的提示文案、每次開啟都清空欄位,全部照舊。

import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import {
  CardDialog,
  CardDialogClose,
  CardDialogContent,
  CardDialogDescription,
  CardDialogFooter,
  CardDialogHeader,
  CardDialogTitle,
  CardDialogTrigger,
  FieldInput,
  FormField,
  StatusTag,
  TodoTag,
  useFormDirty,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import type { UseQueryResult } from "@tanstack/react-query";
import type { LoginEmailStatus } from "./api";

/**
 * 對應規格書 2.5.3 第 1 點/規則 2.3.3:顯示目前實際的登入信箱,以及兩種待驗證狀態徽章
 * (分開顯示,不合併成一句混淆的文字)。只在 statusQuery 有資料時渲染。
 *
 * 載入中(2026-09-30,skill 二之八):原本顯示「登入信箱:載入中⋯」。改成**只有值那一段**是灰色骨架
 * 條、「登入信箱:」這幾個字照樣顯示 —— 標籤本身不是在載入的東西,把它一起藏掉只會讓人看不懂
 * 這一行是什麼。骨架高度/寬度配合這一行 text-xs 的尺寸,不套頁面骨架(這是卡片裡的一行小字)。
 *
 * 標籤改用 skill 二之四的三類:「已建議新信箱,待本人確認套用」是要人去處理的 → 待辦標籤(TodoTag);
 * 「待驗證變更中,尚未生效」是進行中的狀態 → 狀態標籤(StatusTag warning)。
 * 兩個標籤裡都夾著使用者自填的 email,長度不固定,所以開 Tags 的 `wrap`(允許任意字元折行),
 * 320px 才不會撐爆卡片。
 */
export function LoginEmailStatusDisplay({
  statusQuery,
}: {
  statusQuery: UseQueryResult<LoginEmailStatus>;
}) {
  if (statusQuery.isLoading) {
    return (
      /* 用 <span className="flex"> 而不是 <p>:Skeleton 本身是 <div>,包在 <p> 裡是不合法的
         HTML 嵌套(React 會在 dev console 噴 validateDOMNesting 警告)。 */
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-busy="true">
        登入信箱：
        <Skeleton className="h-2.5 w-36 rounded-sm bg-muted" />
      </span>
    );
  }
  const status = statusQuery.data;
  if (!status) return null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <span className="break-all">登入信箱：{status.currentLoginEmail ?? "-"}</span>
      {status.pendingAdminSuggestedEmail ? (
        <TodoTag wrap>已建議新信箱「{status.pendingAdminSuggestedEmail}」，待本人確認套用</TodoTag>
      ) : null}
      {status.pendingConfirmationEmail ? (
        <StatusTag tone="warning" wrap>
          待驗證變更中(新信箱：{status.pendingConfirmationEmail})，尚未生效
        </StatusTag>
      ) : null}
    </div>
  );
}

const SUGGEST_FORM_ID = "admin-suggest-login-email-form";

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
  // 第 11 批 J(#995):打開那一刻的內容當基準,改過 ⇒ Esc / 上方空白先問放棄。
  const emailDirty = useFormDirty(email);

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
          "這只是建議，要等對方本人登入後自己按套用、新信箱主人也點了驗證信，才會真的改成這個信箱。",
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
    <CardDialog
      open={open}
      onOpenChange={(next) => {
        if (next) emailDirty.markClean(email);
        setOpen(next);
      }}
    >
      <CardDialogTrigger asChild>
        <Button type="button" variant="text" size="card" className="-ml-2 h-8 px-2">
          修改登入信箱
        </Button>
      </CardDialogTrigger>
      <CardDialogContent dirty={emailDirty.dirty}>
        <CardDialogHeader>
          <CardDialogTitle className="break-words">
            建議「{personLabel}」的新登入信箱
          </CardDialogTitle>
          <CardDialogDescription>
            這只是建議，不會立刻生效，也不會馬上寄出任何驗證信——要等對方本人登入後自己按套用、
            新信箱主人也點了驗證信，才會真的改成這個信箱。
          </CardDialogDescription>
        </CardDialogHeader>

        {currentSuggestion ? (
          <div className="rounded-md border border-border bg-muted/50 px-3.5 py-3 text-sm">
            <p className="break-all">
              目前已建議的新信箱：<span className="font-medium">{currentSuggestion}</span>
            </p>
            <Button
              type="button"
              variant="neutral"
              size="card"
              className="mt-2"
              disabled={withdrawing}
              onClick={handleWithdraw}
            >
              {withdrawing ? "撤回中⋯" : "撤回建議"}
            </Button>
          </div>
        ) : null}

        {/* 底部按鈕列在 <form> 外面(小卡窗的 Footer 是獨立區塊),送出鈕用 form 屬性指回這張表單,
            Enter 鍵送出與按鈕送出走的都是同一個 handleSubmit。 */}
        <form id={SUGGEST_FORM_ID} onSubmit={handleSubmit}>
          <FormField
            label={currentSuggestion ? "改成其他信箱" : "建議的新登入 Email"}
            htmlFor="admin-suggest-login-email"
            required
          >
            <FieldInput
              id="admin-suggest-login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </FormField>
        </form>
        <CardDialogFooter>
          <CardDialogClose asChild>
            <Button type="button" variant="neutral" size="touch">
              取消
            </Button>
          </CardDialogClose>
          <Button
            type="submit"
            form={SUGGEST_FORM_ID}
            variant="primary"
            size="touch"
            disabled={submitting || !email.trim()}
          >
            {submitting ? "送出中⋯" : "送出建議"}
          </Button>
        </CardDialogFooter>
      </CardDialogContent>
    </CardDialog>
  );
}
