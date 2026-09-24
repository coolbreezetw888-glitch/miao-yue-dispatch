// 模組 7(排班與休假管理)§6.5:安裝提示元件。
// 邏輯(純函式抽到檔案底部,方便 Vitest 測試,不用整個渲染這個元件):
// 1. 監聽 beforeinstallprompt 事件(Android/Chrome 等支援的瀏覽器會觸發),觸發後顯示提示條
//    +「安裝」按鈕,點擊呼叫存下來的 prompt event 觸發瀏覽器原生安裝流程。
// 2. 沒有觸發 beforeinstallprompt、且 User Agent 判斷是 iOS Safari 時,顯示不同文案的提示條
//    (手動教學,沒有「安裝」按鈕,因為做不到程式化觸發)。
// 3. 已經是「已安裝身份開啟」時,完全不顯示這個提示條。
// 4. 使用者按下「稍後再說」或關閉提示,寫入 localStorage 一個時間戳記,7 天內不再顯示。
//
// 2026-09-24 深夜巡檢修正(重疊事故):這個提示條原本寫死 `fixed inset-x-0 bottom-16 z-40`,
// 跟商家設定頁「尚未儲存變更 / 儲存變更」提示列的 class 字面完全一樣,在 DOM 裡又排在 <main>
// 之後,結果把那顆儲存按鈕整個蓋掉。現在一律從 src/lib/bottomFixedLayers.ts 取 class:
// 提示條是底部三層裡優先度最低的一層(z-30,低於動作列的 z-40),而且畫面上只要有動作列存在,
// 就自動往上挪到動作列上方,兩者不會再有任何重疊。完整原委見那個檔案開頭的說明。

import { useEffect, useState } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  BOTTOM_LAYER_HINT,
  BOTTOM_LAYER_HINT_ABOVE_ACTION_BAR,
  useHasBottomActionBar,
} from "@/lib/bottomFixedLayers";
import { cn } from "@/lib/utils";

const DISMISS_STORAGE_KEY = "miaoyue_pwa_install_hint_dismissed_at";
const DISMISS_THROTTLE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export default function InstallPwaHint() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isIosSafari, setIsIosSafari] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  // 畫面上同時有動作列(目前是商家設定頁的「尚未儲存變更」提示列)時,這條提示往上讓開。
  const hasBottomActionBar = useHasBottomActionBar();

  useEffect(() => {
    setIsStandalone(isRunningStandalone());
    setIsIosSafari(detectIosSafari(navigator.userAgent));
    setDismissed(isRecentlyDismissed(readDismissedAt(), Date.now()));

    function handleBeforeInstallPrompt(e: Event) {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    }
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    };
  }, []);

  function handleDismiss() {
    try {
      window.localStorage.setItem(DISMISS_STORAGE_KEY, String(Date.now()));
    } catch {
      // localStorage 不可用(例如無痕模式限制)時靜默失敗,不影響其他功能。
    }
    setDismissed(true);
  }

  async function handleInstallClick() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
  }

  if (isStandalone || dismissed) return null;
  if (!deferredPrompt && !isIosSafari) return null;

  return (
    <div
      className={cn(
        hasBottomActionBar ? BOTTOM_LAYER_HINT_ABOVE_ACTION_BAR : BOTTOM_LAYER_HINT,
        "mx-auto flex max-w-md items-center justify-between gap-3 rounded-lg border border-border bg-background px-4 py-3 shadow-lg",
      )}
    >
      <div className="min-w-0 flex-1">
        {deferredPrompt ? (
          <p className="text-sm text-foreground">安裝秒約 App,以後更快打開</p>
        ) : (
          <p className="text-sm text-foreground">
            點選下方分享按鈕 →「加入主畫面」,把秒約加到手機桌面
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {deferredPrompt ? (
          <Button size="sm" onClick={handleInstallClick}>
            安裝
          </Button>
        ) : null}
        <button
          type="button"
          onClick={handleDismiss}
          className="rounded p-1 text-muted-foreground hover:bg-muted"
          aria-label="關閉提示"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 純函式(6.5 測試要求:UA 判斷、localStorage 節流邏輯抽成純函式測試,不需要真的測瀏覽器
// 安裝行為本身)。
// ---------------------------------------------------------------------------

/** 判斷是不是 iOS 上的 Safari(不含 iOS 上的 Chrome/Firefox 等第三方瀏覽器——那些同樣不支援
 * beforeinstallprompt,但引導使用者去按「不存在的分享選單加入主畫面」按鈕會誤導,所以刻意窄化
 * 只判斷真正的 Safari)。 */
export function detectIosSafari(userAgent: string): boolean {
  const isIos = /iPad|iPhone|iPod/.test(userAgent);
  if (!isIos) return false;
  const isSafari = /Safari/.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(userAgent);
  return isSafari;
}

/** 判斷目前是不是已經以「已安裝」的獨立視窗模式開啟。 */
export function isRunningStandalone(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(display-mode: standalone)").matches;
}

export function readDismissedAt(): number | null {
  try {
    const raw = window.localStorage.getItem(DISMISS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 純函式版本的節流判斷,方便 Vitest 直接傳入時間戳記測試,不用 mock localStorage/Date.now。 */
export function isRecentlyDismissed(dismissedAt: number | null, now: number): boolean {
  if (dismissedAt === null) return false;
  return now - dismissedAt < DISMISS_THROTTLE_MS;
}
