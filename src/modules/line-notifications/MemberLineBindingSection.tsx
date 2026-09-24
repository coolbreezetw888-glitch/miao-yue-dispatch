// 模組 11(LINE 通知)§4.7/§5.3:會員詳情頁疊加「LINE 綁定」區塊(對外掛載元件)。
// 本模組擁有並匯出,模組 10 的會員詳情頁(src/modules/members/MemberDetailPage.tsx)只負責
// 掛載這個元件,不重寫任何綁定邏輯。歸在既有 members 權限底下(第〇節判斷 3/5),不是本模組
// 新增的權限項目——能看到會員詳情頁的人(商家管理員或被授權 members 的客服)就能操作這個區塊,
// 資料庫端 generate_member_line_binding_code/unbind_line_account 也是檢查
// private.can_manage_members,前端不需要再重複判斷一次權限。

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import {
  generateMemberLineBindingCode,
  unbindLineAccount,
  useMemberLineBindingStatus,
} from "./api";

function formatCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function MemberLineBindingSection({ memberId }: { memberId: string }) {
  const queryClient = useQueryClient();
  const { data: bindingStatus, isLoading } = useMemberLineBindingStatus(memberId);

  const [generating, setGenerating] = useState(false);
  const [unbinding, setUnbinding] = useState(false);
  const [issuedCode, setIssuedCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!issuedCode) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [issuedCode]);

  function refetch() {
    return queryClient.invalidateQueries({
      queryKey: ["line-notifications-module", "member-binding-status", memberId],
    });
  }

  async function handleGenerate() {
    setGenerating(true);
    try {
      const result = await generateMemberLineBindingCode(memberId);
      setIssuedCode({ code: result.code, expiresAt: result.expiresAt });
      setNow(Date.now());
      toast.success("已產生綁定碼,可以出示或口頭告知這位會員");
    } catch (err) {
      toast.error("產生綁定碼失敗", { description: getErrorMessage(err) });
    } finally {
      setGenerating(false);
    }
  }

  async function handleUnbind() {
    setUnbinding(true);
    try {
      await unbindLineAccount("member", memberId);
      toast.success("已解除這位會員的 LINE 綁定");
      setIssuedCode(null);
      await refetch();
    } catch (err) {
      toast.error("解除綁定失敗", { description: getErrorMessage(err) });
    } finally {
      setUnbinding(false);
    }
  }

  const msRemaining = issuedCode ? new Date(issuedCode.expiresAt).getTime() - now : 0;
  const codeExpired = issuedCode !== null && msRemaining <= 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">LINE 綁定狀態</span>
        {isLoading ? (
          <span className="text-xs text-muted-foreground">載入中⋯</span>
        ) : bindingStatus?.lineBound ? (
          <Badge variant="default">已綁定</Badge>
        ) : (
          <Badge variant="secondary">未綁定</Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        產生綁定碼後,當面出示或口頭告知這位會員,請對方在 LINE 加商家官方帳號好友,把這組數字當作
        訊息傳送過去完成綁定,不需要會員先有系統登入帳號。
      </p>

      {bindingStatus?.lineBound ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={unbinding}
          onClick={handleUnbind}
        >
          {unbinding ? "處理中⋯" : "解除綁定"}
        </Button>
      ) : (
        <div className="space-y-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={generating}
            onClick={handleGenerate}
          >
            {generating ? "產生中⋯" : "產生綁定碼"}
          </Button>
          {issuedCode && !codeExpired ? (
            <div className="rounded-md border border-dashed border-border px-3 py-2">
              <p className="text-2xl font-bold tracking-widest text-foreground">
                {issuedCode.code}
              </p>
              <p className="text-xs text-muted-foreground">
                剩餘時間 {formatCountdown(msRemaining)}
              </p>
            </div>
          ) : issuedCode && codeExpired ? (
            <p className="text-xs text-muted-foreground">綁定碼已過期,請重新產生。</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
