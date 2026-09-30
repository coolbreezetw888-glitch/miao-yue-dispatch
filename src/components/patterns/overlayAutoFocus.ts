// SPECS-INDEX #861:全站彈窗「開窗時不要自動聚焦第一個可聚焦元素」—— 共用的 hook。
//
// ═══ 為什麼要有這個東西(使用者 2026-09-30 實機巡檢)════════════════════════════════
// 使用者原話:手機一打開彈窗就自動彈出鍵盤,不方便。
// 根因**不是我們自己寫的 autoFocus** —— 全 src/ 只有 ServiceItemsPage.tsx 一處自己寫過
// (#861 已一併拿掉)。真正的來源是 **Radix Dialog 的預設行為**:
// DialogContent 內部用 FocusScope,mount 時會自動把焦點送進對話框裡**第一個可聚焦的元素**。
// 我們的短表單/長表單第一個可聚焦元素通常就是輸入框 ⇒ 手機的虛擬鍵盤就跟著跳出來。
// 所以要關掉的是 Radix 那一層的 onOpenAutoFocus,而不是去每個頁面找 autoFocus。
//
// ═══ 🔴 關掉之後一定要自己接手焦點,不能讓焦點留在窗外面 ════════════════════════════
// 只 event.preventDefault() 就收工的話,焦點會留在「開窗那顆按鈕」上(它在對話框外面),
// 鍵盤使用者按 Tab 會在窗外面繞,完全迷路;而且 FocusScope 的 trap 行為在「一次都沒聚焦過」
// 的狀態下也不好預期。所以這裡 preventDefault 之後**明確把焦點放到對話框容器本身**:
//   - 容器已經有 tabIndex={-1}(Radix FocusScope 以 asChild 傳給 Content 的 DOM 節點),
//     所以 .focus() 一定成功,而且它不是輸入框 ⇒ 不會彈鍵盤。
//   - 焦點在容器裡面 ⇒ Tab 會從容器往下走到第一個按鈕/欄位、Esc 關得掉、
//     關掉之後 Radix 的 onCloseAutoFocus 照舊把焦點還給原本那顆觸發按鈕。
//   - 三個殼的 class 都有 focus:outline-none,所以容器拿到焦點不會出現一圈外框。
//
// ⚠️ 頁面如果**自己傳** onOpenAutoFocus,以頁面的為準(完全交給它,這裡不再疊加)——
//    留一個逃生門給「這個窗真的需要自動聚焦某個東西」的未來個案,但目前全站沒有任何使用點。

import * as React from "react";

/**
 * 回傳要掛到 Radix Content 上的 `ref` 與 `onOpenAutoFocus`。
 *
 * @param forwardedRef 外層 forwardRef 收到的 ref(會一起轉發,不能吃掉)
 * @param onOpenAutoFocus 呼叫端自己傳的處理函式;有傳就完全以它為準
 */
export function useOverlayOpenAutoFocus<T extends HTMLElement>(
  forwardedRef: React.ForwardedRef<T>,
  onOpenAutoFocus?: ((event: Event) => void) | undefined,
): {
  ref: React.RefCallback<T>;
  onOpenAutoFocus: (event: Event) => void;
} {
  const contentRef = React.useRef<T | null>(null);

  const ref = React.useCallback<React.RefCallback<T>>(
    (node) => {
      contentRef.current = node;
      // 轉發給外層的 ref,函式型與物件型都要支援(不轉發的話呼叫端的 ref 會永遠是 null)。
      if (typeof forwardedRef === "function") {
        forwardedRef(node);
      } else if (forwardedRef) {
        forwardedRef.current = node;
      }
    },
    [forwardedRef],
  );

  const handleOpenAutoFocus = React.useCallback(
    (event: Event) => {
      if (onOpenAutoFocus) {
        onOpenAutoFocus(event);
        return;
      }
      // 擋掉 Radix 的「自動聚焦第一個可聚焦元素」(= 手機彈鍵盤的來源)……
      event.preventDefault();
      // ……然後自己把焦點放到對話框容器本身,不是放在輸入框,也不是留在窗外面。
      // preventScroll:純粹避免 iOS 上把頁面往上頂一下,跟焦點落點無關。
      contentRef.current?.focus({ preventScroll: true });
    },
    [onOpenAutoFocus],
  );

  return { ref, onOpenAutoFocus: handleOpenAutoFocus };
}
