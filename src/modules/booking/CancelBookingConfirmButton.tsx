// SPECS-INDEX #977 第 7 批(2026-10-07):「取消預約」按鈕 + 二次確認小卡窗(可填原因),從商家端 BookingDetailDialog
// 抽出來,服務人員端詳情(MyBookingDetailDialog)共用同一份,畫面與文字完全一樣,不再寫第二份。
// 小卡窗殼 CardAlertDialog(疊在全頁層之上,ui-overlay-patterns 三「兩層重疊」);取消是危險樣式(白底紅字)。

import {
  CardAlertDialog,
  CardAlertDialogAction,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
  CardAlertDialogTrigger,
  FieldTextarea,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";

export function CancelBookingConfirmButton({
  disabled,
  reason,
  onReasonChange,
  onConfirm,
  triggerTestId,
}: {
  disabled: boolean;
  reason: string;
  onReasonChange: (value: string) => void;
  onConfirm: () => void;
  triggerTestId?: string | undefined;
}) {
  return (
    <CardAlertDialog>
      <CardAlertDialogTrigger asChild>
        <Button
          type="button"
          variant="danger"
          size="touch"
          disabled={disabled}
          data-testid={triggerTestId}
        >
          取消預約
        </Button>
      </CardAlertDialogTrigger>
      <CardAlertDialogContent>
        <CardAlertDialogHeader>
          <CardAlertDialogTitle>確定要取消這筆預約嗎?</CardAlertDialogTitle>
          <CardAlertDialogDescription>
            取消後這個時段會恢復可預約，可以填寫取消原因(選填)。
          </CardAlertDialogDescription>
        </CardAlertDialogHeader>
        <FieldTextarea
          placeholder="取消原因(選填)"
          value={reason}
          onChange={(e) => onReasonChange(e.target.value)}
          rows={2}
          className="min-h-0"
        />
        <CardAlertDialogFooter>
          <CardAlertDialogCancel>再想想</CardAlertDialogCancel>
          <CardAlertDialogAction tone="danger" onClick={onConfirm}>
            確定取消
          </CardAlertDialogAction>
        </CardAlertDialogFooter>
      </CardAlertDialogContent>
    </CardAlertDialog>
  );
}
