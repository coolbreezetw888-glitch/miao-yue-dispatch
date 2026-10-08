// SPECS-INDEX #873(規格書 .project/specs/副服務人員移除修正.md):移除協助人員(副服務人員)之後的
// 「擋流程二選一」提示,以及判斷要不要跳這個提示的純邏輯。
//
// 使用者裁決(2026-09-30,SPECS-INDEX #873 備註欄原話):
//   「須選一個(再加助手 / 維持現狀)才能繼續。維持現狀的意思是移除掉副服務人員,但主服務人員的單保留。」
// ⇒ ① 不能用 ✕ / 點背景 / Esc 跳過(這顆窗沒有 ✕;Radix AlertDialog 點背景本來就關不掉;Esc 另外擋掉);
//   ② 「維持現狀」= 移除已經生效,只是關掉提示 —— **不是**還原、也不會呼叫任何取消;
//   ③ 「再加助手」= 直接打開既有的編輯表單並捲到「助手」欄位(沿用既有加助手 UI,不另做一套)。
//
// 兩條會跳這個提示的路徑:
//   (a) 行事曆上從「(協助)」色塊打開詳情 → 「移除協助人員」(remove_booking_assistant RPC)
//   (b) 編輯表單裡把助手取消勾選後儲存(update_booking),而且這次**沒有**同時加新的助手
//       (換人 = 拿掉一位又加一位,問「要再加一位嗎」沒有意義)。

import {
  CardAlertDialog,
  CardAlertDialogAction,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
} from "@/components/patterns";

import {
  ASSISTANT_REMOVED_ADD_LABEL,
  ASSISTANT_REMOVED_KEEP_LABEL,
  ASSISTANT_REMOVED_TITLE,
  buildAssistantRemovedMessage,
  type AssistantRemovedInfo,
} from "./assistantRemovalLogic";

/**
 * 擋流程的二選一小卡窗(ui-overlay-patterns 三、小卡窗;只有一段文字 + 兩顆按鈕)。
 * - 「維持現狀」是次要(白底灰框)、「再加助手」是主要(實心主題色);兩顆都不標紅(都不是不可逆的動作)。
 * - 開窗焦點落在「維持現狀」(Radix AlertDialog 預設聚焦 Cancel 那顆)= 什麼都不會再發生的那一顆。
 * - onOpenChange 刻意不處理關閉:只有按兩顆按鈕其中一顆才會收掉(info 交回 null 由呼叫端負責)。
 */
export function AssistantRemovedPrompt({
  info,
  onKeep,
  onAddAnother,
}: {
  info: AssistantRemovedInfo | null;
  onKeep: () => void;
  onAddAnother: (bookingId: string) => void;
}) {
  return (
    <CardAlertDialog
      open={info !== null}
      onOpenChange={() => {
        // 刻意留空:使用者裁決「須選一個才能繼續」,Esc / 點背景都不可以把它關掉。
      }}
    >
      <CardAlertDialogContent
        data-testid="assistant-removed-prompt"
        // 必須選一個 ⇒ Esc 不能關。第 21 批 #1020 起確認窗本來就沒有上方空白條。
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <CardAlertDialogHeader>
          <CardAlertDialogTitle>{ASSISTANT_REMOVED_TITLE}</CardAlertDialogTitle>
          <CardAlertDialogDescription className="break-words">
            {info ? buildAssistantRemovedMessage(info) : ""}
          </CardAlertDialogDescription>
        </CardAlertDialogHeader>
        <CardAlertDialogFooter>
          <CardAlertDialogCancel onClick={onKeep}>
            {ASSISTANT_REMOVED_KEEP_LABEL}
          </CardAlertDialogCancel>
          <CardAlertDialogAction
            onClick={() => {
              if (info) onAddAnother(info.bookingId);
            }}
          >
            {ASSISTANT_REMOVED_ADD_LABEL}
          </CardAlertDialogAction>
        </CardAlertDialogFooter>
      </CardAlertDialogContent>
    </CardAlertDialog>
  );
}
