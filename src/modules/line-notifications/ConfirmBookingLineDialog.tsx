// 模組 11(LINE 通知)§4.8/規則 2.5:訂單確認彈窗。由既有「確認訂單」按鈕的處理邏輯
// (src/modules/booking/BookingDetailDialog.tsx)import 使用。
//
// 這顆彈窗本身不呼叫 confirm_booking/line-notify-dispatch——它只是純顯示 + 回報使用者選擇的
// 元件,實際的 RPC/Edge Function 呼叫留在呼叫端(規則 2.5:「是」「否」兩個按鈕都會執行
// confirm_booking(),差別只在於「是」之後才呼叫 line-notify-dispatch),避免這個對外掛載元件
// 反過來依賴模組 6 的 booking API,保持模組獨立性。

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { LINE_TARGET_TYPE_LABELS } from "./types";
import type { PendingLineNotificationTarget } from "./types";

export function ConfirmBookingLineDialog({
  open,
  targets,
  busy,
  onOpenChange,
  onChoice,
}: {
  open: boolean;
  targets: PendingLineNotificationTarget[];
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onChoice: (shouldNotify: boolean) => void;
}) {
  const targetSummary = targets
    .map((t) => `${LINE_TARGET_TYPE_LABELS[t.type] ?? t.type} ${t.name}(LINE)`)
    .join("、");

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>要透過 LINE 通知這次確認嗎?</AlertDialogTitle>
          <AlertDialogDescription>
            將會通知:{targetSummary || "(無)"}。不論選擇是或否,這筆訂單都會照常確認,這裡只決定
            要不要額外發送 LINE 通知,不會更改長期的通知設定。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={() => onChoice(false)}>
            否,只確認不通知
          </AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={() => onChoice(true)}>
            是,確認並通知
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
