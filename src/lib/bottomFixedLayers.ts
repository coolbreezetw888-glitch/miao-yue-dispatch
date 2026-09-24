// ⚠️ 這個檔案已經只是一層「相容外殼」,裡面沒有任何定義。
//
// 2026-09-24(頁首吸頂改版):原本這裡是「底部固定元件疊放順序」的單一事實來源,但這次頁首也要
// 吸頂、也需要登記一個層級,而「一個叫 bottomFixedLayers 的檔案裡放 top 層的常數」下一個人根本
// 不會想到要來這裡找。所以常數與說明整份搬到 **src/lib/fixedLayers.ts**(上下兩軸的 z-index 階梯
// 寫在同一份註解裡,才看得出彼此的關係),這裡只留 re-export。
//
// 為什麼不直接把這個檔案刪掉、把 import 全部改掉:src/modules/merchant/MerchantSettingsPage.tsx
// 還在 import 這個路徑,而這次的分工明確限定「src/modules/merchant/ 底下只有 MerchantSwitcher*
// 可以動」,不能順手改它。
//
// ⇒ 新增任何層級請寫在 src/lib/fixedLayers.ts,不要寫在這裡。
// ⇒ 新的 import 請直接用 "@/lib/fixedLayers";之後有人動到 MerchantSettingsPage.tsx 時,順手把
//    那行 import 換成新路徑,這個檔案就可以整個刪掉了。

export {
  acquireBottomActionBarSlot,
  BOTTOM_LAYER_ACTION_BAR,
  BOTTOM_LAYER_HINT,
  BOTTOM_LAYER_HINT_ABOVE_ACTION_BAR,
  BOTTOM_LAYER_TAB_BAR,
  resetBottomActionBarsForTest,
  TOP_LAYER_HEADER,
  useHasBottomActionBar,
} from "./fixedLayers";
