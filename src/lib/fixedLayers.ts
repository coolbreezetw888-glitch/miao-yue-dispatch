// 固定/吸附定位元件的「疊放順序」單一事實來源(跨模組共用,非編號模組)。
//
// ⚠️ 這個檔案的前身是 src/lib/bottomFixedLayers.ts。2026-09-24(頁首吸頂改版)把「頂部」那一層
// 也納進來之後,原本的檔名就不再誠實了(一個叫 bottomFixedLayers 的檔案裡放 top 層的常數,
// 下一個人根本不會想到要來這裡找)。所以常數的定義全部搬到這個檔案,bottomFixedLayers.ts 留成
// 一層純 re-export 的相容外殼——這次的分工不准動 src/modules/merchant/ 底下除 MerchantSwitcher*
// 以外的檔案,而 MerchantSettingsPage.tsx 有 import 舊路徑,不能跟著改。
// ⇒ **新增任何層級一律寫在這個檔案**,不要寫進 bottomFixedLayers.ts。
//
// 為什麼需要集中管理(2026-09-24 深夜巡檢抓到的實際事故):
// 這個產品在畫面邊緣同時會有好幾個脫離文件流的東西,它們分別長在不同檔案、由不同模組維護,
// 誰也看不到誰:
//   1. 後台底部分頁籤列(src/routes/AppLayout.tsx)——永遠在最底、永遠要看得到、永遠可點。
//   2. 各種「動作列」,目前是商家設定頁的「尚未儲存變更 / 儲存變更」提示列
//      (src/modules/merchant/MerchantSettingsPage.tsx)——使用者「正在進行的操作」,優先度僅次於
//      分頁籤,絕對不能被任何提示蓋住。
//   3. 各種「提示條」,目前是 PWA 安裝提示(src/components/InstallPwaHint.tsx)——純粹是建議,
//      隨時可以關掉,優先度最低,該讓位。
//   4.(2026-09-24 新增)後台頁首——吸頂常駐,裡面有「切換商家」跟「登出」,跟分頁籤同一個等級的
//      基礎導覽,不准被任何提示蓋住。
// 實際發生的問題:MerchantSettingsPage 的未儲存提示列跟 InstallPwaHint 兩邊各自寫死
// `fixed inset-x-0 bottom-16 z-40`,字面完全一樣。安裝提示條在 DOM 裡排在 <main> 之後,
// 同樣的 z-index 之下後畫的蓋在先畫的上面,結果「儲存變更」那顆按鈕被安裝提示條整個蓋掉,
// 商家管理員看不到也按不到——而那條提示列本來就是為了解決「以為選了就生效、其實沒按儲存」
// 才加的,被蓋掉等於那次修復整個失效。
// AppLayout.tsx 的註解其實早就寫過「UpdateAvailableHint 刻意放頂部,避免兩個提示條互相重疊」,
// 但那是寫在註解裡的口頭約定,新加的元件沒有任何機制會強迫它遵守。
//
// 所以改成:所有脫離文件流(fixed)或吸附(sticky)的邊緣元件一律從這裡取 class,不要再各自
// 寫死 top-*/bottom-*/z-*。新增元件時先來這個檔案決定它屬於哪一層,不夠用就在這裡新增一層並補上
// 說明,不要在元件檔案裡自己隨手寫一組數字——那正是這次事故的成因。
//
// ---------------------------------------------------------------------------
// 完整的 z-index 階梯(唯一一份,上下兩軸放在一起看才有意義)
// ---------------------------------------------------------------------------
//   z-50  底部分頁籤列(BOTTOM_LAYER_TAB_BAR)
//         + Radix 的彈出層(下拉選單/Dialog/Sheet,shadcn 預設就是 z-50)。Radix 的內容是
//           portal 到 <body> 最後面的,同分時後畫的贏,所以「從頁首打開的下拉選單」會正確蓋在
//           頁首(z-40)上面,不需要為它再加一層。
//   z-40  頂部頁首(TOP_LAYER_HEADER)、底部動作列(BOTTOM_LAYER_ACTION_BAR)
//         這兩個刻意用同一個數字:一個永遠貼在畫面最上面(高 56px),一個永遠貼在畫面下緣,
//         幾何上不可能重疊,所以不需要分出先後;真正要表達的是「它們同屬『使用者當下要操作的
//         東西』這一級,都比提示條高」。
//   z-30  提示條(BOTTOM_LAYER_HINT / BOTTOM_LAYER_HINT_ABOVE_ACTION_BAR)
//         最低優先,重疊時該被蓋住的是它。
//
// ⚠️ 頁首刻意用 `sticky` 而不是 `fixed`:sticky 元件仍然佔著文件流裡的高度,所以 <main> 不需要
// 另外補 padding-top;改成 fixed 的話,忘記補 padding 就會讓每一頁的第一行內容被頁首蓋掉
// (而且是「只有捲到最上面時看不到」這種很容易在開發機上漏掉的症狀)。
//
// ⚠️ 頂部沒有「提示條」這一層是刻意的:新版本提示(src/components/UpdateAvailableHint.tsx)
// 2026-09-24 已經從 `fixed top-0` 改成「在文件流裡、排在頁首正下方、跟著頁首一起吸頂」,
// 它自己不再需要任何 top-*/z-* —— 一個排在文件流裡的元件不可能蓋住別人,這是比「小心挑 z-index」
// 更根本的解法。詳見該檔案與 AppLayout.tsx 的說明。
//
// 版面數字(Tailwind 間距,1 = 0.25rem = 4px):
//   top-0     = 0px    頁首吸頂位置(頁首本體高 h-14 = 56px)
//   bottom-0  = 0px    分頁籤列本體(高約 60px)
//   bottom-16 = 64px   剛好讓開分頁籤列的高度
//   bottom-36 = 144px  讓開分頁籤列(64px)+ 一條動作列(約 64px)+ 16px 呼吸空間

import { useSyncExternalStore } from "react";

// =========================================================================
// 頂部
// =========================================================================

/** 頂部第 1 層:後台頁首(商家 LOGO / 功能標題 / 登出)。
 *
 * 2026-09-24 使用者回報:「頁首滑下去就不見了,希望它固定在最上面。」
 * 用 `sticky top-0` 而不是 `fixed`(理由見檔頭的 ⚠️)。z-40 的理由也見檔頭的 z-index 階梯:
 * 跟底部動作列同級(都是「使用者當下要操作的東西」),比提示條(z-30)高,比 Radix 彈出層
 * 與底部分頁籤(z-50)低。
 *
 * ⚠️ 用在「包住頁首的那個外層 div」上,不是用在 <header> 本身——因為新版本提示條要一起吸頂,
 * 兩個東西共用同一個 sticky 容器(見 AppLayout.tsx)。 */
export const TOP_LAYER_HEADER = "sticky top-0 z-40";

// =========================================================================
// 底部
// =========================================================================

/** 第 1 層(最底、最優先):後台底部分頁籤列。永遠可見、永遠可點,任何東西都不准蓋它。 */
export const BOTTOM_LAYER_TAB_BAR = "fixed inset-x-0 bottom-0 z-50";

/** 第 2 層:動作列(例如「尚未儲存變更 / 儲存變更」)。使用者正在進行的操作,優先度高於提示條。 */
export const BOTTOM_LAYER_ACTION_BAR = "fixed inset-x-0 bottom-16 z-40";

/** 第 3 層(最上、最低優先):提示條(例如 PWA 安裝提示)。沒有動作列時貼在分頁籤上方。 */
export const BOTTOM_LAYER_HINT = "fixed inset-x-0 bottom-16 z-30";

/** 第 3 層的「讓位版本」:畫面上同時存在動作列時,提示條要往上挪到動作列上方。
 * z-index 仍然比動作列低,就算數字沒算準、真的重疊到了,被蓋住的也是可以隨手關掉的提示條,
 * 不會是使用者正要按的那顆儲存按鈕。 */
export const BOTTOM_LAYER_HINT_ABOVE_ACTION_BAR = "fixed inset-x-0 bottom-36 z-30";

// ---------------------------------------------------------------------------
// 「畫面上現在有沒有動作列」的共用訊號。
//
// 為什麼要用這種 module 層級的小型訂閱器,而不是 React Context:
// 動作列(商家設定頁,在 <Outlet /> 底下)跟提示條(InstallPwaHint,掛在 AppLayout 的
// <Outlet /> 外面)分屬兩棵不同的子樹,提示條不是動作列的祖先也不是後代,沒有現成的 Context
// 能同時罩住兩邊。用 useSyncExternalStore 訂閱一個 module 變數是 React 官方對「外部狀態」的
// 標準做法,不需要任何共同祖先,也不會在每次 render 時重新建立物件。
// ---------------------------------------------------------------------------

let activeBottomActionBarCount = 0;
const bottomActionBarListeners = new Set<() => void>();

function emitBottomActionBarChange() {
  for (const listener of bottomActionBarListeners) listener();
}

/**
 * 宣告「我現在有一條底部動作列」。回傳一個「收回宣告」的函式,直接當成 useEffect 的 cleanup 用:
 *
 * ```ts
 * useEffect(() => {
 *   if (!hasUnsavedChanges) return;
 *   return acquireBottomActionBarSlot();
 * }, [hasUnsavedChanges]);
 * ```
 *
 * 用計數而不是布林值,是為了同一時間有兩條動作列(例如之後別的頁面也加了一條)時,先消失的那條
 * 不會把還在畫面上的另一條一起「關掉」。重複呼叫回傳的收回函式不會重複扣數。
 */
export function acquireBottomActionBarSlot(): () => void {
  activeBottomActionBarCount += 1;
  emitBottomActionBarChange();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeBottomActionBarCount -= 1;
    emitBottomActionBarChange();
  };
}

function subscribeBottomActionBar(onStoreChange: () => void): () => void {
  bottomActionBarListeners.add(onStoreChange);
  return () => {
    bottomActionBarListeners.delete(onStoreChange);
  };
}

function getBottomActionBarSnapshot(): boolean {
  return activeBottomActionBarCount > 0;
}

/** 畫面上目前是不是有一條底部動作列。提示條用這個值決定要不要往上讓開。 */
export function useHasBottomActionBar(): boolean {
  return useSyncExternalStore(
    subscribeBottomActionBar,
    getBottomActionBarSnapshot,
    // 伺服器端渲染 / 預先渲染時永遠當作沒有動作列(那時候本來就不會有使用者正在編輯的表單)。
    () => false,
  );
}

/** 測試專用:把計數歸零,避免某個測試沒收乾淨影響到下一個測試。正式程式碼不要呼叫。 */
export function resetBottomActionBarsForTest(): void {
  activeBottomActionBarCount = 0;
  emitBottomActionBarChange();
}
