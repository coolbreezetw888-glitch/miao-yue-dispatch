// 模組 11(LINE 通知)§4.6/§5.3:服務人員詳情頁疊加「LINE 綁定」區塊(對外掛載元件)。
// 本模組擁有並匯出,模組 3 的服務人員編輯表單(StaffFormDialog,src/modules/staff-agent/
// StaffListPage.tsx)只負責在編輯既有服務人員時掛載這個元件,不重寫任何綁定邏輯。
// 產生綁定碼僅商家管理員可操作(呼叫 3.6 generate_staff_line_binding_code,沿用模組 3 既有
// 「服務人員異動只有商家管理員能做」的權限邊界,一之二節第 1 點/第〇節判斷 5)。

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import { generateStaffLineBindingCode, unbindLineAccount, useStaffLineBindingStatus } from "./api";

function formatCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function StaffLineBindingSection({ staffId }: { staffId: string }) {
  const queryClient = useQueryClient();
  const { data: bindingStatus, isLoading } = useStaffLineBindingStatus(staffId);

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
      queryKey: ["line-notifications-module", "staff-binding-status", staffId],
    });
  }

  async function handleGenerate() {
    setGenerating(true);
    try {
      const result = await generateStaffLineBindingCode(staffId);
      setIssuedCode({ code: result.code, expiresAt: result.expiresAt });
      setNow(Date.now());
      toast.success("已產生綁定碼,請把這組碼交給這位服務人員");
    } catch (err) {
      toast.error("產生綁定碼失敗", { description: getErrorMessage(err) });
    } finally {
      setGenerating(false);
    }
  }

  async function handleUnbind() {
    setUnbinding(true);
    try {
      await unbindLineAccount("staff", staffId);
      toast.success("已解除這位服務人員的 LINE 綁定");
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
    <div className="space-y-3 rounded-md border border-border px-3 py-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-foreground">LINE 綁定</p>
        {isLoading ? (
          <span className="text-xs text-muted-foreground">載入中⋯</span>
        ) : bindingStatus?.lineBound ? (
          <Badge variant="default">已綁定</Badge>
        ) : (
          <Badge variant="secondary">未綁定</Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        產生綁定碼後,請這位服務人員在 LINE 加商家官方帳號好友,把這組數字當作訊息傳送過去完成綁定。
      </p>

      {bindingStatus?.lineBound ? (
        <Button type="button" variant="outline" size="sm" disabled={unbinding} onClick={handleUnbind}>
          {unbinding ? "處理中⋯" : "解除綁定"}
        </Button>
      ) : (
        <div className="space-y-2">
          <Button type="button" variant="outline" size="sm" disabled={generating} onClick={handleGenerate}>
            {generating ? "產生中⋯" : "產生綁定碼"}
          </Button>
          {issuedCode && !codeExpired ? (
            <div className="rounded-md border border-dashed border-border px-3 py-2">
              <p className="text-2xl font-bold tracking-widest text-foreground">{issuedCode.code}</p>
              <p className="text-xs text-muted-foreground">剩餘時間 {formatCountdown(msRemaining)}</p>
            </div>
          ) : issuedCode && codeExpired ? (
            <p className="text-xs text-muted-foreground">綁定碼已過期,請重新產生。</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
