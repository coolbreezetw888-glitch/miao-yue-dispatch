// SPECS-INDEX #1025 第三輪 ③:「功能開關」頁與商家詳情「功能開關」卡改成「先調整、按儲存才生效」,
// 未儲存就離開要先提醒(ui-overlay-patterns 三之六的「填過資料」精神,延伸到整頁)。
//
// 這個專案用 <BrowserRouter>(不是資料路由),沒有 useBlocker 可用,所以分兩種離開:
//   ・關分頁 / 重新整理 / 打別的網址:beforeunload ⇒ 瀏覽器自己的「確定離開？」提示。
//   ・點頁面上的站內連結(超級管理員導覽、返回、商家名稱⋯):在 document 的「捕獲階段」先攔下 <a href> 點擊,
//     跳確認窗「確定放棄這次的變更？」;按「放棄變更」才照原本的網址走。
//   ⚠️ 已知限制:瀏覽器的「上一頁」按鈕(popstate)攔不到,會直接離開(BrowserRouter 沒有可靠的攔法)。
// 只有 dirty = true 時才掛監聽;儲存中 / 儲存完一定要先讓 dirty 變 false(三之六第 5 點)。

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

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

import { LEAVE_GUARD_COPY, interceptedLeaveTarget } from "./leaveGuardLogic";

export function useLeaveGuard(dirty: boolean) {
  const navigate = useNavigate();
  const [pendingTo, setPendingTo] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // 舊版瀏覽器要設 returnValue 才會跳提示(內容不會顯示)。
      event.returnValue = "";
    };
    const onClickCapture = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
      const to = interceptedLeaveTarget(event, anchor, window.location);
      if (!to) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingTo(to);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClickCapture, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [dirty]);

  const leaveDialog = (
    <CardAlertDialog
      open={pendingTo !== null}
      onOpenChange={(open) => {
        if (!open) setPendingTo(null);
      }}
    >
      <CardAlertDialogContent data-testid="feature-leave-guard">
        <CardAlertDialogHeader>
          <CardAlertDialogTitle>{LEAVE_GUARD_COPY.title}</CardAlertDialogTitle>
          <CardAlertDialogDescription>{LEAVE_GUARD_COPY.body}</CardAlertDialogDescription>
        </CardAlertDialogHeader>
        <CardAlertDialogFooter>
          <CardAlertDialogCancel>{LEAVE_GUARD_COPY.keepEditing}</CardAlertDialogCancel>
          <CardAlertDialogAction
            tone="danger"
            onClick={() => {
              const to = pendingTo;
              setPendingTo(null);
              if (to) navigate(to);
            }}
          >
            {LEAVE_GUARD_COPY.discard}
          </CardAlertDialogAction>
        </CardAlertDialogFooter>
      </CardAlertDialogContent>
    </CardAlertDialog>
  );

  return { leaveDialog };
}
