// 模組 7(排班與休假管理)§6.4:PWA service worker「有新版本」提示。
//
// ── 2026-10-01(SPECS-INDEX #966)改版:改成參考系統那種「底部深色浮動卡片」 ─────────────────
// 使用者看了參考系統(.project/notes/ui-ref-2026-10-01/55-參考-更新提示卡片.png)後要求照做:
//   ・深色圓角卡片、左側更新圖示(品牌色)、兩行字(粗體標題 + 小字說明)、右側「稍後」+「立即更新」。
//   ・顏色用商家主題色(bg-brand / text-brand),**不照抄參考系統的橘色**。
//   ・位置(主腦裁定):螢幕底部、**浮在底部分頁籤列上方,不可蓋住分頁籤列**。參考系統的卡片是
//     `bottom-0 z-[9999]` 直接壓在分頁籤上,這點刻意不照抄。
//   ・跟其他底部固定層的堆疊沿用 src/lib/fixedLayers.ts 那一套(BOTTOM_LAYER_UPDATE_CARD* +
//     acquireBottomUpdateCardSlot):有動作列(尚未儲存變更)時排到動作列上方;PWA 安裝提示看到
//     卡片在,會自己排到卡片上方。不在這個檔案寫死任何 bottom-* / z-*。
//   ・不是 Radix 彈窗、沒有遮罩:卡片外層 pointer-events-none,只有卡片本體可點,使用者照常操作頁面。
//     ui-overlay-patterns skill 的分類:要使用者「選一個動作」但不擋畫面 ⇒ 不是小卡窗(會擋)、
//     也不是 toast(toast 不能放唯一的操作入口,而且會自己消失)⇒ 常駐到使用者按掉為止的浮動卡片。
//
// 按鈕行為:
//   ・「立即更新」= 原本的「重新整理」:呼叫 applyLatestServiceWorkerUpdate() 送出 SKIP_WAITING,
//     真正的 window.location.reload() 由 pwaUpdate.ts 的 controllerchange 監聽器負責,
//     這個元件**不自己 reload**(避免自己猜時機)。按下後改成「更新中⋯」並停用,避免重複點擊。
//     #1016(第 20 批):按下後會先向伺服器問一次最新版、有更新的就等它下載好再套用(最多約 15 秒,
//     離線/逾時就套用手上那一版)⇒ 按一次就到最新版,不會重新整理後又跳一次。這段期間一直顯示「更新中⋯」。
//     萬一手上已經沒有任何可套用的版本(回傳 false),把按鈕恢復可按,不讓使用者卡住。
//   ・「稍後」= 收起卡片,**本次瀏覽期間不再跳出**:寫 sessionStorage(分頁關掉 / 重新開啟 App 就清空)。
//     但如果這段期間**又偵測到一個新的版本**(pwaUpdate.ts 回呼帶 isNewDetection: true),
//     那是另一個新版本,清掉「稍後」的紀錄、重新跳出。sessionStorage 讀寫一律 try/catch
//     (無痕模式 / 被封鎖時讀不到就當作沒按過「稍後」,寫不進去就只靠元件 state)。
//
// 歷史:2026-09-20 起原本是「頁首正下方、整條滿版、沒有關閉鈕」的橫條(放在文件流裡避免蓋住頁首);
// 這次改成可收起的浮動卡片後,那個「關不掉又蓋住東西」的顧慮已經不存在,所以回到底部浮動。

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import {
  acquireBottomUpdateCardSlot,
  pickBottomUpdateCardLayer,
  useHasBottomActionBar,
} from "@/lib/fixedLayers";
import { cn } from "@/lib/utils";
import { applyLatestServiceWorkerUpdate, onServiceWorkerUpdateAvailable } from "@/pwaUpdate";

/** sessionStorage 的 key:這個分頁(這次瀏覽)使用者已經按過「稍後」。 */
export const UPDATE_CARD_DISMISSED_SESSION_KEY = "miaoyue_update_card_dismissed";

function readDismissedThisSession(): boolean {
  try {
    return window.sessionStorage.getItem(UPDATE_CARD_DISMISSED_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissedThisSession(dismissed: boolean): void {
  try {
    if (dismissed) window.sessionStorage.setItem(UPDATE_CARD_DISMISSED_SESSION_KEY, "1");
    else window.sessionStorage.removeItem(UPDATE_CARD_DISMISSED_SESSION_KEY);
  } catch {
    // sessionStorage 不可用時靜默失敗:元件 state 仍然會把卡片收起來,只是重新整理後可能再跳一次。
  }
}

interface UpdateAvailableHintProps {
  /**
   * `above-tab-bar`(預設):頁面有底部分頁籤列(AppLayout),卡片浮在分頁籤列上方。
   * `no-tab-bar`:頁面沒有底部選單(登入頁 / 客戶端等),卡片貼齊畫面底部的安全區上方。
   * 目前只有 AppLayout 掛這個元件(AppLayout 在所有寬度都有分頁籤列)。
   */
  placement?: "above-tab-bar" | "no-tab-bar";
}

export default function UpdateAvailableHint({
  placement = "above-tab-bar",
}: UpdateAvailableHintProps) {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(readDismissedThisSession);
  const [applying, setApplying] = useState(false);
  const hasBottomActionBar = useHasBottomActionBar();

  useEffect(() => {
    return onServiceWorkerUpdateAvailable(({ isNewDetection }) => {
      if (isNewDetection) {
        // 又偵測到一個新的版本 ⇒ 之前按的「稍後」是針對上一個版本的,這次要再提醒。
        writeDismissedThisSession(false);
        setDismissed(false);
      }
      setUpdateAvailable(true);
    });
  }, []);

  const visible = updateAvailable && !dismissed;

  // 卡片在畫面上時登記一個「新版本卡片」訊號,讓 PWA 安裝提示知道要排到卡片上方(不互相遮擋)。
  useEffect(() => {
    if (!visible) return;
    return acquireBottomUpdateCardSlot();
  }, [visible]);

  function handleApplyClick() {
    if (applying) return;
    setApplying(true);
    void applyLatestServiceWorkerUpdate().then((applied) => {
      if (!applied) setApplying(false);
    });
  }

  function handleLaterClick() {
    writeDismissedThisSession(true);
    setDismissed(true);
  }

  if (!visible) return null;

  const hasTabBar = placement === "above-tab-bar";

  return (
    // 外層:定位 + 左右 12px 邊距;pointer-events-none 讓卡片兩側露出來的空白處點得到底下的頁面。
    // 底部留白含 env(safe-area-inset-bottom):iPhone 底部橫條區。目前 index.html 沒有
    // viewport-fit=cover,這個值在所有裝置都是 0,寫上去是為了之後開 cover 時不必再回來改。
    <div
      data-testid="update-available-card"
      className={cn(
        pickBottomUpdateCardLayer({ hasTabBar, hasActionBar: hasBottomActionBar }),
        "pointer-events-none px-3 pt-2",
        hasTabBar
          ? "pb-[calc(env(safe-area-inset-bottom)+0.5rem)]"
          : "pb-[calc(env(safe-area-inset-bottom)+0.75rem)]",
      )}
    >
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "pointer-events-auto mx-auto flex max-w-md items-center gap-2.5 rounded-2xl bg-foreground px-4 py-3 text-background shadow-2xl sm:gap-3",
          // 進場:由下往上淡入;使用者開了「減少動態效果」就完全不播(motion-safe)。
          "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-300",
        )}
      >
        <RefreshCw aria-hidden="true" className="size-5 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-tight font-bold">有新版本可更新</p>
          <p className="mt-0.5 text-[11px] leading-tight text-background/70">
            點擊立即套用最新版功能
          </p>
        </div>
        {/* 兩顆按鈕視覺高度 32px(照參考系統的小按鈕),用 before 偽元素把可點範圍上下各延伸 6px
            ⇒ 實際觸控目標 44px(ui-overlay-patterns skill 一、觸控目標 44px 以上)。 */}
        <button
          type="button"
          onClick={handleLaterClick}
          disabled={applying}
          className="relative h-8 shrink-0 rounded-lg px-2 text-xs text-background/60 transition-colors before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-[''] hover:text-background disabled:opacity-50"
        >
          稍後
        </button>
        <button
          type="button"
          onClick={handleApplyClick}
          disabled={applying}
          className="relative h-8 shrink-0 rounded-lg bg-brand px-3 text-xs font-bold text-brand-foreground ring-1 ring-background/15 ring-inset transition-transform before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-[''] active:scale-95 disabled:opacity-70"
        >
          {applying ? "更新中⋯" : "立即更新"}
        </button>
      </div>
    </div>
  );
}
