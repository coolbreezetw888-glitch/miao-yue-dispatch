/**
 * 全頁層 / 小卡窗共用:「Esc 或點上方空白條」時的關閉流程 —— ui-overlay-patterns skill 三之六
 * (第 11 批 J,#995 J-7、J-9、J-10)。🔴 只給 FullPageLayer / CardDialog 兩個殼用,頁面不要 import。
 *
 * 流程(Esc 與空白條走同一條路):
 *   1. 先呼叫頁面傳進來的 onEscapeKeyDown(例:建單「選擇項目」整頁開著 ⇒ Esc = 返回整頁,preventDefault 後到此為止)。
 *   2. 沒被攔下、dirty === true ⇒ 不關,打開殼內建的「確定放棄這次輸入？」確認窗。
 *   3. 沒被攔下、dirty === false ⇒ 直接關(Esc 交給 Radix;空白條觸發殼裡隱藏的 Close ⇒ onOpenChange(false),
 *      頁面原本的關閉守門全部照跑,例如預約詳情的 handleLayerOpenChange、儲存中不關)。
 *
 * ✕ 與底部「取消」鈕不經過這裡(J-11:刻意按的,一按就關)。
 */

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import {
  CardAlertDialog,
  CardAlertDialogAction,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
} from "./CardAlertDialog";
import { createDismissEscapeEvent, DISCARD_CHANGES_COPY } from "./overlayDismissLogic";

export function useOverlayDirtyDismiss({
  dirty,
  onEscapeKeyDown,
}: {
  dirty: boolean;
  onEscapeKeyDown?: ((event: KeyboardEvent) => void) | undefined;
}) {
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  // 比照第 11 批 E / #999 / K:每次打開換 key 整組重新掛載,避免上一次還在退場的確認窗跟新的遮罩疊錯順序。
  const [confirmSeq, setConfirmSeq] = React.useState(0);

  const openConfirm = React.useCallback(() => {
    setConfirmSeq((n) => n + 1);
    setConfirmOpen(true);
  }, []);

  const handleEscapeKeyDown = React.useCallback(
    (event: KeyboardEvent) => {
      onEscapeKeyDown?.(event);
      if (event.defaultPrevented) return;
      if (dirty) {
        event.preventDefault();
        openConfirm();
      }
    },
    [dirty, onEscapeKeyDown, openConfirm],
  );

  /** 空白條被點:等同按 Esc。 */
  const requestDismiss = React.useCallback(() => {
    const event = createDismissEscapeEvent();
    handleEscapeKeyDown(event);
    if (event.defaultPrevented) return;
    closeRef.current?.click();
  }, [handleEscapeKeyDown]);

  const hiddenClose = (
    <DialogPrimitive.Close
      ref={closeRef}
      hidden
      tabIndex={-1}
      aria-hidden="true"
      style={{ display: "none" }}
      data-overlay-hidden-close=""
    />
  );

  const discardConfirm = (
    <CardAlertDialog key={confirmSeq} open={confirmOpen} onOpenChange={setConfirmOpen}>
      <CardAlertDialogContent data-testid="discard-changes-confirm">
        <CardAlertDialogHeader>
          <CardAlertDialogTitle>{DISCARD_CHANGES_COPY.title}</CardAlertDialogTitle>
          <CardAlertDialogDescription>{DISCARD_CHANGES_COPY.body}</CardAlertDialogDescription>
        </CardAlertDialogHeader>
        <CardAlertDialogFooter>
          <CardAlertDialogCancel>{DISCARD_CHANGES_COPY.keepEditing}</CardAlertDialogCancel>
          <CardAlertDialogAction
            tone="danger"
            onClick={() => {
              closeRef.current?.click();
            }}
          >
            {DISCARD_CHANGES_COPY.discard}
          </CardAlertDialogAction>
        </CardAlertDialogFooter>
      </CardAlertDialogContent>
    </CardAlertDialog>
  );

  return { handleEscapeKeyDown, requestDismiss, hiddenClose, discardConfirm };
}
