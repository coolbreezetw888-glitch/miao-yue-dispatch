// 後台導覽外殼(跨模組共用外殼,非編號模組)。對應規格書「後台導覽外殼.md」。
//
// 2026-09-16 修正:規格書從「4 個分頁籤(我的帳號/管理功能/設定功能/行事曆)」改成
// 「3 個分頁籤(首頁/功能/行事曆)」——使用者澄清參考圖的分類方式不是要照抄,「管理功能」跟
// 「設定功能」這兩類合併成單一個「功能」分頁籤,單頁列出所有功能卡片,不分類別;原本的
// 「我的帳號」分頁籤改名「首頁」,定位是暫時佔位,之後會被使用者另外提供的「主控台」設計取代,
// 這次不用預先做成帳號頁面的樣子。見規格書「⚠️ 重要修正」一節。
//
// 2026-09-16 再次修正,對應規格書「首頁外殼與主題色優化」一、1.1/1.3、二、2.1:
//   - 品牌列改成常駐顯示 MerchantSwitcher(左側,取代原本的秒約 LOGO/文字)+ 登出按鈕(右側),
//     搬自原本 HomePage.tsx 內容區裡的同一組元件,不管切到哪個分頁籤都能直接切商家/登出。
//   - 新增主題色套用:讀取目前操作中商家的 theme_preset/theme_custom_color,動態覆寫
//     styles.css 定義的 --brand/--cta 系列 CSS 變數(見 src/modules/merchant/theme.ts),
//     商家設定頁存的主題色從此真的會套用到整個後台,不再是存進資料庫後沒有任何地方讀出來用。
//
// 這個檔案取代原本 AppShell(src/routes/app.tsx)的角色,職責:
//   1. 登入驗證/導向邏輯——原封不動從舊版 AppShell 搬過來,不重寫判斷邏輯本身,只是把生效範圍從
//      「只在 /app 這個路由」擴大成「所有 /app/* 底下、套用這個外殼的路由都適用」。
//   2. 渲染常駐頂端列:左側商家切換器、右側登出按鈕(見上方 2026-09-16 修正)。
//   3. 渲染底部分頁籤列:4 個分頁籤永遠固定顯示,不因權限隱藏整個分頁籤(規格書「新外殼結構」
//      一節明講的刻意設計,分頁籤本身常駐,權限只決定分頁籤「裡面」顯示什麼)。在所有螢幕寬度都
//      套用同一種底部分頁籤外殼,不做手機/桌面兩種版型。
//   4. 透過 <Outlet context={...}> 把 email/使用者 id/登出函式往下傳給子路由(例如服務人員端
//      「個人資料」分頁籤
//      的個人資料卡片需要 userId 查詢自己的管理員/客服紀錄),子路由不用重新呼叫一次登入驗證。
//
// 商家端調整批次(2026-09-22,對應 .project/SPECS-INDEX.md #609/#610,.project/specs/
// 後台導覽外殼.md 該批次章節 + .project/specs/服務人員端.md §15.1):底部分頁籤依角色不同,
// 依 useCurrentMerchantRole() 的結果挑選對應的分頁籤組合:
//   - 商家管理員/客服(role !== 'staff',含角色還在載入中的預設情況)。
//   - 服務人員(role === 'staff'):休假設定/薪資報表(都是原「功能」卡片獨立升級而來)。
//     服務人員不再看到「功能」分頁籤,ManagePage.tsx 對服務人員角色而言已經沒有對應的分頁籤入口。
//     ⚠️ 服務人員這一組的順序與第一個分頁籤標籤在 2026-09-24 由使用者重新指定過,見下方。
// 「分頁籤永遠顯示、不因角色/權限隱藏」這條既有規則延續適用(.project/SPECS-INDEX.md #118)——
// 「訂單管理」「店家報表」這兩個分頁籤沒有對應權限的客服一樣看得到分頁籤本身,點進去分別由
// OrdersPage.tsx/BillingReportPage.tsx 顯示空狀態文字,不是分頁籤消失。
//
// 使用者決策(2026-09-23,大改版,詳見各檔案自己的說明):
//   - 拔掉「首頁」分頁籤(商家管理員/客服視角)——內容分散到「功能」頁最上方(個人資料卡片)/
//     「商家設定」頁最下方(新增分店),見 HomePage.tsx/ManagePage.tsx/MerchantSettingsPage.tsx。
//     服務人員視角維持有這個分頁籤,HomePage.tsx(/app)現在專職服務人員自己的個人資料頁
//     (2026-09-24 使用者指定把標籤從「首頁」改成「個人資料」)。
//   - 商家管理員/客服分頁籤順序改成:功能/行事曆/訂單管理/店家報表(原「店家帳務報表」卡片
//     獨立升級成分頁籤並改名「店家報表」)。
//   - 新增雙重身份切換(管理員/客服同時也是這間商家的服務人員時,可以手動切換要看商家端還是
//     服務人員端內容),見 appLayoutLogic.ts 的 resolveIsDualRoleEligible/resolveIsStaffView。
//
// 2026-09-24 線上故障修正(雙重身分的人完全進不去服務人員端):
//   1. 所有角色/分頁籤判斷搬到 src/routes/appLayoutLogic.ts 這個純函式檔案,並補上單元測試
//      (appLayoutLogic.test.ts)。原因:這條路徑當時零測試覆蓋,而唯一的進入路徑(藏在商家
//      切換器下拉選單最底部的一個選項)從來沒有在實機上被驗證過,結果實機上使用者根本沒找到它。
//   2. 切換入口從「只在下拉選單最底部」改成「常駐在頂端列正下方的一整條橫幅」
//      (DualRoleViewSwitchBar.tsx),下拉選單裡原本那個選項保留不動。
//   3. 雙重身分選擇的檢視會記住(依「使用者 + 商家」分開存 localStorage),重新整理/下次登入
//      不會被打回商家端。
//   4. 修掉載入競態:isViewResolved 往下傳給 HomePage/ManagePage,角色還沒解出來時顯示載入中,
//      不再讓純服務人員先被彈到 /app/manage 再彈回來(見 appLayoutLogic.ts isStaffViewResolved)。
//
// 例外(不套用這個外殼,見規格書「例外」一節):/app/onboarding、/app/agent-invite-complete
// 維持獨立全螢幕流程,在 src/App.tsx 裡刻意放在 <AppLayout> 巢狀路由之外。
//
// =========================================================================
// 站內通知中心(鈴鐺)批次(2026-09-25,.project/SPECS-INDEX.md #755/#756,
// .project/specs/手機推播擴及三種角色.md §13.5/§13.6/§13.7):
//   1. 頁首右側改成「鈴鐺 + 登出」一個群組(§13.6),鈴鐺在登出**左邊**(使用者原話:
//      「登出的左側要有一個鈴鐺圖示(通知)」)。
//   2. 為了在 320px 下塞得進去,版面做了四件事,全部是算過的,不是隨手調的(§13.6):
//        ・容器水平內距 `px-5` → `px-3 sm:px-5`(手機省 16px,640px 以上完全不變)
//        ・鈴鐺與登出之間用 `gap-1`(4px),整組當成**一個** flex 子項 → 不會多一道 `gap-2`
//        ・鈴鐺尺寸 `h-8 w-8`(32px),不是 Button 預設的 `size="icon"`(36px) → 省 4px
//        ・拿掉左右兩格的 `min-w-[3.25rem]` 底線(`shrink-0` 保留)→ 省 20px
//   3. 🔴 **使用者 2026-09-25 對 Q9 的裁決(A)**:手機上放棄「標題幾何置中」,換取「標題完整
//      顯示不截斷」;大螢幕(≥640px)維持原樣。這**不是**推翻 2026-09-24 的設計 —— 使用者當時的
//      原話就是「置中的部分不是說一定要在中間,只是盡可能在中間(logo 與登出的中間置中)」,
//      而「logo 與登出的中點」恰恰就是拿掉 `min-w-[3.25rem]` 之後的行為。原本那兩個
//      `min-w-[3.25rem]` 是額外加的一層,讓那個中點剛好也等於畫面正中央;A 只是不再強求後面那一半。
//      **看到標題偏左不要當成做壞了。**
//   4. service worker 收到推播時會對所有開著的分頁 postMessage,這裡掛一個監聽器讓鈴鐺重新查
//      (§13.5 第 3 個觸發點)。判斷邏輯在 src/modules/notifications/serviceWorkerBridge.ts,
//      這裡只負責掛上/拆掉監聽器。
// =========================================================================

import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useNavigate, useOutletContext } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import InstallPwaHint from "@/components/InstallPwaHint";
import UpdateAvailableHint from "@/components/UpdateAvailableHint";
import { cn } from "@/lib/utils";
// 所有 fixed/sticky 邊緣元件的疊放順序單一事實來源。頁首吸頂(TOP_LAYER_HEADER)與底部分頁籤
// (BOTTOM_LAYER_TAB_BAR)都從這裡取 class,不在這個檔案裡寫死 top-*/bottom-*/z-*。
import { BOTTOM_LAYER_TAB_BAR, TOP_LAYER_HEADER } from "@/lib/fixedLayers";
import { supabase } from "@/integrations/supabase/client";
import { getVerifiedUser } from "@/lib/auth-guard";
import {
  useClearCurrentMerchantSelection,
  useCurrentMerchant,
  useGroupMerchants,
} from "@/modules/merchant/context";
import { MerchantSwitcher } from "@/modules/merchant/MerchantSwitcher";
import { applyThemeColorToDocument, resolveMerchantThemeColor } from "@/modules/merchant/theme";
// §13.6:站內通知中心(鈴鐺)。這是 <NotificationBell /> 全系統**唯一**的掛載處(§13.11)。
import { NotificationBell } from "@/modules/notifications/NotificationBell";
import { handleServiceWorkerNotificationMessage } from "@/modules/notifications/serviceWorkerBridge";
// #609/#610:底部分頁籤這次依角色不同(商家管理員/客服 vs 服務人員),需要在外殼層級就知道
// 目前使用者的角色。
import { useCurrentMerchantRole } from "@/modules/staff-agent/context";
// 使用者決策(2026-09-23):管理員/客服同時也是服務人員時的雙重身份切換——直接查自己的
// merchant_staff 紀錄(不透過 useCurrentMerchantRole 的角色優先權判斷),判斷「除了目前解析出來
// 的角色之外,我是不是也能切到服務人員端」。
import { useActiveMyStaffRecord } from "@/modules/staff-portal/context";

import {
  isStaffViewResolved,
  readStoredStaffViewPreference,
  resolveAppHeaderTitle,
  resolveIsStaffView,
  resolveTabs,
  shouldShowStaffViewSwitch,
  writeStoredStaffViewPreference,
} from "./appLayoutLogic";
import { DualRoleViewSwitchBar } from "./DualRoleViewSwitchBar";

/** localStorage 在某些瀏覽器設定下光是「存取這個屬性」就會丟例外,所以包起來取用。
 * 讀寫本身的 try/catch 在 appLayoutLogic.ts 裡。 */
function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export interface AppLayoutContext {
  email: string | null;
  userId: string | null;
  /** 對應規格書(帳號登入安全性優化)2.5.1:目前登入者自己有沒有一筆 Supabase 原生的待驗證新
   * 信箱(auth.users.new_email)。三種角色共用,不用各自重新呼叫一次 getVerifiedUser()。 */
  newEmail: string | null;
  onSignOut: () => void;
  /** 使用者決策(2026-09-23):目前實際要不要顯示服務人員端內容——純服務人員角色永遠 true;
   * 管理員/客服同時也是服務人員時,依雙重身分切換選擇決定。HomePage.tsx 用這個值決定要渲染
   * 服務人員自己的個人資料頁,還是導去 /app/manage。 */
  isStaffView: boolean;
  /** 2026-09-24 修正:「該看商家端還是服務人員端」這件事現在已經有確定答案了嗎?
   * 角色/服務人員紀錄還在查的時候是 false —— 子路由必須先等這個值變 true 才能做任何導向判斷,
   * 否則會拿「還沒解出來的角色」當成「不是服務人員」用(見 appLayoutLogic.ts isStaffViewResolved)。 */
  isViewResolved: boolean;
  /** 這位使用者是不是雙重身分(管理員/客服 + 同一間商家的服務人員)。ManagePage 用來在
   * 「一張卡片都沒有」的空狀態裡直接給出切換到服務人員端的按鈕。 */
  isDualRoleEligible: boolean;
  /** 切換商家端/服務人員端。isDualRoleEligible 為 false 時呼叫不會有任何效果。 */
  onToggleStaffView: () => void;
}

/** 給子路由(HomePage/ManagePage 等)用,取得共用外殼已經驗證好的 email 跟登出函式,
 * 不用自己重新監聽一次 auth 狀態。 */
export function useAppLayoutContext(): AppLayoutContext {
  return useOutletContext<AppLayoutContext>();
}

// 分頁籤定義(MERCHANT_TABS/STAFF_TABS)與所有角色判斷都搬到 ./appLayoutLogic.ts,並在
// ./appLayoutLogic.test.ts 有對應的單元測試。2026-09-24 線上故障的教訓:這段判斷邏輯寫在元件
// 本體裡就沒辦法被測,而它一錯就是「整個 App 對某一類使用者而言直接壞掉」等級的後果。

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  const { merchants, isLoading: merchantsLoading } = useGroupMerchants();
  const clearCurrentMerchantSelection = useClearCurrentMerchantSelection();
  const { merchant: currentMerchant } = useCurrentMerchant();
  // #609/#610:底部分頁籤依角色挑選,role 還沒解出來之前(或不是 'staff')一律用商家管理員/
  // 客服那組當預設——多數使用者是管理員/客服,先顯示那組風險最低。
  // ⚠️ 但「先用商家端那組當預設」只適用於分頁籤這種可以事後補正的顯示;任何「導向」判斷都必須
  // 等 isViewResolved 才能做,見下面的說明。
  const { data: merchantRole, isLoading: roleLoading } = useCurrentMerchantRole();

  // 使用者決策(2026-09-23):管理員/客服同時也是服務人員時,可以手動切換要看商家端還是服務人員端
  // ——直接查自己的 merchant_staff 紀錄(不透過 useCurrentMerchantRole 的角色優先權判斷,那支
  // hook 身兼多重角色時永遠回傳較高權限角色,見該檔案註解「規則 2.10」),判斷「除了目前解析出來
  // 的角色之外,我是不是也能切到服務人員端」。
  const { data: myStaffRow, isLoading: staffRecordLoading } = useActiveMyStaffRecord(
    currentMerchant?.id ?? null,
  );
  const isDualRoleEligible = shouldShowStaffViewSwitch(merchantRole, myStaffRow != null);

  const [forcedStaffView, setForcedStaffView] = useState(false);
  // 2026-09-24 修正:切換商家時不再單純重置成 false,而是讀回「這個使用者在這間商家」上次的選擇。
  // 原本的做法(一律重置)造成雙重身分的人每次重新整理/每次切回這間商家都被打回商家端,而商家端
  // 對一個沒有客服權限的人來說就是一片空的功能頁——等於每次都要重新找一次切換入口。
  // key 依「使用者 + 商家」分開(見 appLayoutLogic.ts staffViewPreferenceKey),所以 A 店的選擇
  // 不會外溢到 B 店(B 店不一定也有這位使用者的服務人員身分),換帳號也不會讀到上一個人的選擇。
  useEffect(() => {
    setForcedStaffView(
      readStoredStaffViewPreference(safeLocalStorage(), userId, currentMerchant?.id ?? null),
    );
  }, [userId, currentMerchant?.id]);

  const handleToggleStaffView = useCallback(() => {
    setForcedStaffView((prev) => {
      const next = !prev;
      writeStoredStaffViewPreference(safeLocalStorage(), userId, currentMerchant?.id ?? null, next);
      return next;
    });
  }, [userId, currentMerchant?.id]);

  const isStaffView = resolveIsStaffView({
    merchantRole,
    hasActiveStaffRecord: myStaffRow != null,
    forcedStaffView,
  });
  const tabs = resolveTabs(isStaffView);
  // 2026-09-24 使用者回報「頁首應該要顯示目前在哪個功能頁」。判斷邏輯本身是純函式(涵蓋 App.tsx
  // 底下全部 34 條子路由,認不出來的路徑回空字串、永遠不會是 undefined),測試見
  // appLayoutLogic.test.ts。
  const headerTitle = resolveAppHeaderTitle({ pathname: location.pathname, isStaffView });
  // 角色/服務人員紀錄都查完了才算「有答案」。子路由(HomePage/ManagePage)拿這個值決定要不要
  // 先顯示載入中,不能在還沒有答案的時候就把人導走。
  const isViewResolved = isStaffViewResolved({
    hasCurrentMerchant: currentMerchant != null,
    roleLoading,
    staffRecordLoading,
  });

  // 以下這段登入驗證/導向邏輯,原封不動搬自舊版 src/routes/app.tsx(AppShell),行為完全不變,
  // 只多存一份 userId(user.id)供 1.2 首頁個人資料卡片查詢自己的管理員/客服紀錄使用。
  useEffect(() => {
    let active = true;
    getVerifiedUser().then((user) => {
      if (!active) return;
      if (!user) {
        navigate("/signin", { replace: true });
        return;
      }
      setEmail(user.email ?? null);
      setUserId(user.id);
      setNewEmail(user.new_email ?? null);
      setAuthChecked(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) navigate("/signin", { replace: true });
      else {
        setEmail(session.user.email ?? null);
        setUserId(session.user.id);
        setNewEmail(session.user.new_email ?? null);
      }
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [navigate]);

  // §13.5 第 3 個觸發點:service worker 收到推播 → 對所有開著的分頁 postMessage → 鈴鐺重新查。
  // 判斷「這則訊息該不該重查」的邏輯在 serviceWorkerBridge.ts(純函式,有 Vitest 釘住
  // 「收到 push-received 會 invalidate、收到其他 type 不會」),這裡只掛/拆監聽器。
  // ⚠️ navigator.serviceWorker 在不支援的瀏覽器(以及 jsdom 測試環境)裡是 undefined,要先擋掉。
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    const container = navigator.serviceWorker;
    const onMessage = (event: MessageEvent) => {
      handleServiceWorkerNotificationMessage(queryClient, event.data);
    };
    container.addEventListener("message", onMessage);
    return () => container.removeEventListener("message", onMessage);
  }, [queryClient]);

  // 對應規格書「首頁外殼與主題色優化」二、2.1:主題色實際套用的核心 bug 修正。
  // 讀取目前操作中商家的 theme_preset/theme_custom_color,動態覆寫 styles.css 定義的
  // --brand/--cta 系列 CSS 變數,讓整個 /app/* 後台的功能卡片外光暈/hover 顏色、主要按鈕填色
  // 都跟著商家設定的主題色變。dependency 刻意包含 theme_preset/theme_custom_color 本身
  // (不只 currentMerchant.id)——商家設定頁存檔後,react-query 快取會被
  // refetchAccessibleMerchants() 更新,這裡才會在「沒有切換商家」的情況下也重新套用一次剛存的顏色。
  useEffect(() => {
    applyThemeColorToDocument(resolveMerchantThemeColor(currentMerchant));
  }, [currentMerchant?.id, currentMerchant?.theme_preset, currentMerchant?.theme_custom_color]);

  // 對應規格書(商家與集團管理)4.6:登入後檢查目前使用者是否至少是一間商家的管理員/客服,
  // 不是的話導向 Onboarding。這段判斷邏輯不變,只是現在套用在整個外殼層級。
  useEffect(() => {
    if (!authChecked || merchantsLoading) return;
    if (merchants.length === 0) {
      navigate("/app/onboarding", { replace: true });
    }
  }, [authChecked, merchantsLoading, merchants.length, navigate]);

  function handleSignOut() {
    // 沿用舊版 AppShell 的登出寫法(2026-09-15 主腦複查修正過的版本):登出要讓使用者體感上
    // 立即生效,先同步導向 /signin,實際清 session/清快取這些非同步收尾動作改成背景執行、不擋畫面,
    // 避免清快取的瞬間讓「沒有商家 → 導去 Onboarding」的判斷搶先觸發、卡住轉場。完整原因見
    // 舊版 src/routes/app.tsx 的說明(該檔案已由這個外殼取代,說明保留在 git 歷史)。
    navigate("/signin", { replace: true });
    clearCurrentMerchantSelection();
    void queryClient.cancelQueries().then(() => queryClient.clear());
    void supabase.auth.signOut();
  }

  if (!authChecked || merchantsLoading || (merchants.length === 0 && authChecked)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      </div>
    );
  }

  const outletContext: AppLayoutContext = {
    email,
    userId,
    newEmail,
    onSignOut: handleSignOut,
    isStaffView,
    isViewResolved,
    isDualRoleEligible,
    onToggleStaffView: handleToggleStaffView,
  };

  return (
    <div className="min-h-screen bg-surface font-sans antialiased">
      {/* 2026-09-24 頁首吸頂(使用者實機回報:「頁首滑下去就不見了,希望它固定在最上面」)。
          吸頂的 class 一律從 src/lib/fixedLayers.ts 取(TOP_LAYER_HEADER = "sticky top-0 z-40"),
          不在這裡寫死數字 —— 那個檔案是本專案所有 fixed/sticky 元件疊放順序的單一事實來源,
          存在的原因是之前真的發生過兩個元件各自寫死同一組 bottom/z 導致「儲存變更」按鈕被提示條
          蓋掉、使用者按不到的事故(完整經過見該檔案開頭)。

          ⚠️ 新版本提示條(UpdateAvailableHint)刻意放在**這個 sticky 容器裡面、頁首正下方**:
          它原本是 `fixed inset-x-0 top-0 z-40`,頁首一旦吸頂,兩個東西就會搶同一塊位置 ——
          而這個提示條刻意沒有「稍後再說」的關閉選項,一旦蓋住頁首,使用者就再也按不到「登出」跟
          「切換商家」,直到他願意按下重新整理為止,那正是上述事故的同一類問題。放進文件流裡
          (排在頁首下面、跟著頁首一起吸頂)就從根本上不可能蓋住任何東西,也不必再挑 z-index。 */}
      <div className={TOP_LAYER_HEADER}>
        {/* 對應規格書「首頁外殼與主題色優化」一、1.1:商家切換器(含商家 LOGO)取代秒約 LOGO,
            常駐在頂端列左側;登出按鈕搬到同一列右側。不管切到哪一個分頁籤,頂端都能直接切換商家、
            直接登出。2026-09-23:雙重身份(管理員/客服同時也是服務人員)的切換入口也掛在這個
            下拉選單裡(見 MerchantSwitcher.tsx),不是另外的按鈕。

            2026-09-24 使用者回報「頁首應該要顯示目前在哪個功能頁」:商家切換器縮成只剩 LOGO
            (variant="compact",點下去照樣展開原本的下拉選單),原本商家名稱的位置改放目前功能頁
            的名稱。使用者原話:「置中的部分不是說一定要在中間,只是盡可能在中間(logo 與登出的
            中間置中)。」

            版面怎麼做到「盡量置中」又不撐出橫向捲軸(e2e/mobile-overflow.spec.ts 在守這件事,
            320px 下溢出就會失敗):三格 flex —— 左右兩格 shrink-0(LOGO 32px、右側群組約 86px),
            中間那格 min-w-0 flex-1 text-center + truncate(長標題自己截斷,絕對不會把登出按鈕
            推出畫面)。刻意不用 absolute 定位去做「數學上完美置中」——那種做法一旦標題變長就會
            疊到按鈕上,而使用者已經明講不要求絕對置中。

            🔴 2026-09-25(鈴鐺批次 §13.6 + 使用者對 Q9 的裁決 A):原本左右兩格各有一個
            `min-w-[3.25rem]`(52px),用途是「把版位撐成一樣寬,中間那格才會落在畫面正中央」。
            右側多了一顆鈴鐺之後,「左右一樣寬」在 320px 下**已經不可能跟「標題完整顯示」同時
            成立**(要讓左邊也撐到 86px,中間就只剩 108px,而最長的標題「月薪人員假別設定」
            實測 128px,一定被截成省略號)。使用者裁決:**選標題完整顯示**,所以這兩個 min-w 被
            拿掉了(`shrink-0` 保留)。截斷的標題會讓使用者讀不到自己在哪一頁(實質功能損失),
            偏左的標題只是不夠漂亮(美觀問題)。**不要為了「看起來比較正」把 min-w 加回來。**
            守門員:e2e/app-header-320.spec.ts。 */}
        <header className="border-b border-border bg-background">
          {/* px-3 sm:px-5:手機 12px(比原本的 20px 省下 16px,鈴鐺的空間就是這樣賺回來的),
              640px 以上維持原本的 20px,大螢幕視覺完全不變。 */}
          <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-3 sm:px-5">
            <div className="flex shrink-0 items-center justify-start">
              <MerchantSwitcher
                variant="compact"
                canSwitchToStaffView={isDualRoleEligible}
                isStaffView={isStaffView}
                onToggleView={handleToggleStaffView}
              />
            </div>
            {/* 刻意用 <p> 而不是 <h1>:每一個子頁面自己已經有一個 <h1> 寫著同一個標題
                (這裡的文字就是從那些 <h1> 抄過來的,見 appLayoutLogic.ts 的說明),頁首再放一個
                <h1> 會讓同一頁出現兩個第一級標題、把標題大綱弄亂。
                2026-09-24 使用者反映頁首標題字太小,從 text-sm(14px)放大。手機跟寬螢幕刻意用不同尺寸,
                `sm:text-lg` 不是多餘的:這個 <p> 是 flex-1 truncate,左邊是商家切換器、右邊是
                「鈴鐺 + 登出」群組;目前最長的標題「月薪人員假別設定」8 個字實測 16px 下 128px、
                18px 下 144px——18px 在 320px 手機上餘裕太小,之後標題再長一個字就會被截成省略號,
                所以手機維持 text-base(16px),640px 以上才放到 text-lg(18px)。

                📌 320px 下中間這一格的**實測**寬度(2026-09-25 鈴鐺批次改完之後,Chromium
                320×568 + isMobile,量測與斷言見 e2e/app-header-320.spec.ts 的 console 輸出):
                **160px**(規格書 §13.6 的算式估 162px,實測少 2px —— 跟 §〇.9 當初「算式 160 vs
                實測 158」一樣有 2px 誤差,算式不等於實測)。改動前是 158px。
                也就是說**多塞了一顆鈴鐺之後,標題可用寬度反而比以前多 2px**,而最長的標題
                「月薪人員假別設定」實測 scrollWidth = clientWidth = 160,沒有被截斷。 */}
            <p
              data-testid="app-header-title"
              className="min-w-0 flex-1 truncate text-center text-base font-semibold text-foreground sm:text-lg"
            >
              {headerTitle}
            </p>
            {/* §13.6 第 2 點:鈴鐺與登出合併成「右側群組」,兩者之間 gap-1(4px),整個群組當成
                **一個** flex 子項 —— 這樣整體仍然是三個 flex 子項,不會多一道 gap-2(8px)。
                DOM 順序即視覺順序:鈴鐺在登出**左邊**(使用者明講的位置)。 */}
            <div className="flex shrink-0 items-center justify-end gap-1">
              <NotificationBell />
              <Button variant="outline" size="sm" onClick={handleSignOut}>
                登出
              </Button>
            </div>
          </div>
        </header>

        {/* 模組 7 §6.4 修正(2026-09-20 主腦複查):新版本待套用時的提示條。
            2026-09-24:從 `fixed top-0` 改成排在頁首正下方、跟著頁首一起吸頂,原因見上方 ⚠️。 */}
        <UpdateAvailableHint />
      </div>

      {/* 2026-09-24 線上故障修正:雙重身分的切換入口從「只在商家切換器下拉選單最底部」改成
          常駐橫幅,見 DualRoleViewSwitchBar.tsx 開頭的完整原因。
          ⚠️ 這條橫幅刻意**不**跟著吸頂:它只是一個切換入口,常駐佔掉頂部空間會讓手機的可視範圍
          再少一截(頁首已經佔了 56px)。跟著內容捲走就好。 */}
      {isDualRoleEligible ? (
        <DualRoleViewSwitchBar isStaffView={isStaffView} onToggle={handleToggleStaffView} />
      ) : null}

      <main className="pb-24">
        <Outlet context={outletContext} />
      </main>

      {/* 模組 7(排班與休假管理)§6.5:安裝提示元件,掛在共用後台殼層(見第〇節判斷 8,
          PWA 這次疊加在既有 /app 殼層上,不是獨立服務人員端)。 */}
      <InstallPwaHint />

      {/* 位置/層級取自 src/lib/fixedLayers.ts 的 BOTTOM_LAYER_TAB_BAR,不在這裡寫死
          `fixed inset-x-0 bottom-0 z-50`(2026-09-24 的待辦:那個常數原本只是登記在該檔案裡當
          文件,這次改由這裡真的 import 它,行為完全一樣)。 */}
      <nav className={cn(BOTTOM_LAYER_TAB_BAR, "border-t border-border bg-background")}>
        <div className="mx-auto flex max-w-5xl items-stretch justify-around">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = tab.isActive(location.pathname);
            return (
              <Link
                key={tab.to}
                to={tab.to}
                className={cn(
                  "flex flex-1 flex-col items-center gap-1 py-2.5 text-xs transition-colors",
                  active
                    ? "font-semibold text-brand"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-5 w-5" />
                <span>{tab.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
