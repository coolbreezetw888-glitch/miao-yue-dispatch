// 模組 11(LINE 通知)§4.6/§5.3:服務人員詳情頁疊加「LINE 綁定」區塊(對外掛載元件)。
// 本模組擁有並匯出,模組 3 的服務人員編輯表單(StaffFormDialog,src/modules/staff-agent/
// StaffListPage.tsx)只負責在編輯既有服務人員時掛載這個元件,不重寫任何綁定邏輯。
// 產生綁定碼僅商家管理員可操作(呼叫 3.6 generate_staff_line_binding_code,沿用模組 3 既有
// 「服務人員異動只有商家管理員能做」的權限邊界,一之二節第 1 點/第〇節判斷 5)。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 「已綁定 / 未綁定」由 shadcn Badge 改成 StatusTag(skill 二之四:狀態標籤,淺底 + 深字 +
//     左邊小圓點;success = 已綁定、neutral = 未綁定)。
//   - 「產生綁定碼後,請…」這段「怎麼用」收進 `?`(skill 二:看過一次就懂的內容要能收起來),
//     標題列是 `flex flex-wrap`,展開的說明區塊會自己換到下一行(HelpToggle 的版面要求)。
//   - 「綁定碼已過期」改成 🟡 常駐 `!`(AlertNote):這是「現在的狀態跟使用者以為的不一樣」,
//     不能只用一行灰字帶過(skill 二)。
//   - 🔴「解除綁定」是可逆動作(解除後可以再產生綁定碼重綁)⇒ **不標紅**,用 ② 次要
//     (neutral):第 1 / 2 批已定案的裁決,紅色只留給真正不可逆的刪除。
//   - 載入中改成灰色骨架方塊,不用「載入中⋯」四個字(skill 二之八)。
//   - 綁定碼數字加 tabular-nums(skill 二之六第 5 點)。
//
// **只動外觀,不動行為**:產生 / 解除綁定的 API 呼叫、倒數計時、toast 文案、過期判斷全部照舊。

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { AlertNote, HelpToggle, StatusTag } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

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
      toast.success("已產生綁定碼，請把這組碼交給這位服務人員");
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
    <div className="flex flex-col gap-3 rounded-lg border border-border px-3.5 py-3">
      {/* HelpToggle 展開的說明區塊是 basis-full,所以這一列必須是 flex flex-wrap。 */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <p className="text-sm font-semibold text-foreground">LINE 綁定</p>
        {isLoading ? (
          <Skeleton className="h-5 w-16 rounded-full bg-muted" />
        ) : bindingStatus?.lineBound ? (
          <StatusTag tone="success">已綁定</StatusTag>
        ) : (
          <StatusTag tone="neutral">未綁定</StatusTag>
        )}
        <HelpToggle label="說明：服務人員的 LINE 綁定碼怎麼用">
          產生綁定碼後，請這位<strong>服務人員</strong>在 LINE
          加商家官方帳號好友，把這組數字當作訊息傳送過去，就完成綁定。綁定碼有時效，過期就重新產生一組。
        </HelpToggle>
      </div>

      {bindingStatus?.lineBound ? (
        // 🔴 可逆動作(解除後可以再產生綁定碼重綁)⇒ 不標紅,用 ② 次要。
        <Button
          type="button"
          variant="neutral"
          size="card"
          className="self-start"
          disabled={unbinding}
          onClick={handleUnbind}
        >
          {unbinding ? "處理中⋯" : "解除綁定"}
        </Button>
      ) : (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="neutral"
            size="card"
            className="self-start"
            disabled={generating}
            onClick={handleGenerate}
          >
            {generating ? "產生中⋯" : "產生綁定碼"}
          </Button>
          {issuedCode && !codeExpired ? (
            <div className="rounded-md border border-dashed border-border bg-muted/30 px-3.5 py-2.5">
              <p className="text-2xl font-bold tracking-widest tabular-nums text-foreground">
                {issuedCode.code}
              </p>
              <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                剩餘時間 {formatCountdown(msRemaining)}
              </p>
            </div>
          ) : issuedCode && codeExpired ? (
            <AlertNote>這組綁定碼已經過期，請按「產生綁定碼」重新產生一組。</AlertNote>
          ) : null}
        </div>
      )}
    </div>
  );
}
