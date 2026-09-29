// 模組 11(LINE 通知)§4.8/規則 2.5:訂單確認彈窗。由既有「確認訂單」按鈕的處理邏輯
// (src/modules/booking/BookingDetailDialog.tsx)import 使用。
//
// 這顆彈窗本身不呼叫 confirm_booking/line-notify-dispatch——它只是純顯示 + 回報使用者選擇的
// 元件,實際的 RPC/Edge Function 呼叫留在呼叫端(規則 2.5:「是」「否」兩個按鈕都會執行
// confirm_booking(),差別只在於「是」之後才呼叫 line-notify-dispatch),避免這個對外掛載元件
// 反過來依賴模組 6 的 booking API,保持模組獨立性。
//
// ui-v1-full 第 3 批(2026-09-30,盤點 #30 —— 盤點時就登記、前兩批都沒改到的舊殼):
// 改用小卡窗殼 CardAlertDialog(ui-overlay-patterns skill 三、兩種窗 → 小卡窗)。
//   - 這是「純確認、二選一、沒有輸入欄位」⇒ AlertDialog 版(點遮罩 / 按 Esc 不會關,一定要選一顆)。
//   - 兩顆按鈕在手機左右各半、電腦靠右,由 CardAlertDialogFooter 統一(skill 二之三)。
//   - 🔴「否,只確認不通知」**不標紅**:它不是危險動作,只是不發通知而已(第 1 / 2 批已定案的
//     裁決——紅色只留給真正不可逆的刪除)。所以否 = ② 次要(Cancel 白底灰框)、
//     是 = ① 主要(實心主題色,這是使用者最可能要做的那件事)。
//   - 「不論選是或否這筆訂單都會照常確認」屬於 skill 二「🟡 `!` 常駐」的第三類(現在的狀態跟
//     使用者以為的不一樣)—— 使用者看到這顆窗會以為「按否就不確認了」,所以這句用 AlertNote
//     常駐,不收進 `?`,也不埋在一長段灰色說明文字裡。
//
// **只動外觀,不動行為**:open / busy / onOpenChange / onChoice 的語意與呼叫時機完全照舊,
// 兩顆按鈕各自呼叫 onChoice(false) / onChoice(true) 也照舊。

import {
  AlertNote,
  CardAlertDialog,
  CardAlertDialogAction,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
} from "@/components/patterns";

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
    <CardAlertDialog open={open} onOpenChange={onOpenChange}>
      <CardAlertDialogContent>
        <CardAlertDialogHeader>
          <CardAlertDialogTitle>要透過 LINE 通知這次確認嗎?</CardAlertDialogTitle>
          <CardAlertDialogDescription>
            將會通知:{targetSummary || "(無)"}
          </CardAlertDialogDescription>
        </CardAlertDialogHeader>
        {/* 🟡 常駐提醒(skill 二、`!` 第三類:現在的狀態跟使用者以為的不一樣)。 */}
        <AlertNote>
          不論選「是」或「否」,<strong>這筆訂單都會照常確認</strong>
          。這裡只決定要不要額外發送這一次的 LINE 通知,不會更改長期的通知設定。
        </AlertNote>
        <CardAlertDialogFooter>
          <CardAlertDialogCancel disabled={busy} onClick={() => onChoice(false)}>
            否,只確認不通知
          </CardAlertDialogCancel>
          <CardAlertDialogAction disabled={busy} onClick={() => onChoice(true)}>
            是,確認並通知
          </CardAlertDialogAction>
        </CardAlertDialogFooter>
      </CardAlertDialogContent>
    </CardAlertDialog>
  );
}
