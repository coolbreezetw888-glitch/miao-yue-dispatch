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
//   3. 渲染底部分頁籤列:首頁 / 功能 / 行事曆,3 個分頁籤永遠固定顯示,不因角色隱藏整個分頁籤、
//      也不因模組增加而持續往上加分頁籤(規格書「新外殼結構」一節明講的刻意設計,分頁籤本身常駐,
//      權限只決定分頁籤「裡面」顯示什麼)。行事曆之所以獨立成分頁籤,是因為它跟首頁同等級、
//      是核心操作介面(第一版就有),不是先例允許「以後每個模組都能加一個分頁籤」——後續模組
//      (例如模組 6 訂單管理)的頁面級入口,一律放進「功能」分頁籤底下用卡片呈現,見
//      src/routes/ManagePage.tsx。在所有螢幕寬度都套用同一種底部分頁籤外殼,不做手機/
//      桌面兩種版型。
//   4. 透過 <Outlet context={...}> 把 email/使用者 id/登出函式往下傳給子路由(例如「首頁」分頁籤
//      的個人資料卡片需要 userId 查詢自己的管理員/客服紀錄),子路由不用重新呼叫一次登入驗證。
//
// 例外(不套用這個外殼,見規格書「例外」一節):/app/onboarding、/app/agent-invite-complete
// 維持獨立全螢幕流程,在 src/App.tsx 裡刻意放在 <AppLayout> 巢狀路由之外。

import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Home, LayoutGrid } from "lucide-react";
import { Link, Outlet, useLocation, useNavigate, useOutletContext } from "react-router-dom";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { getVerifiedUser } from "@/lib/auth-guard";
import {
  useClearCurrentMerchantSelection,
  useCurrentMerchant,
  useGroupMerchants,
} from "@/modules/merchant/context";
import { MerchantSwitcher } from "@/modules/merchant/MerchantSwitcher";
import { applyThemeColorToDocument, resolveMerchantThemeColor } from "@/modules/merchant/theme";

export interface AppLayoutContext {
  email: string | null;
  userId: string | null;
  onSignOut: () => void;
}

/** 給「首頁」分頁籤(HomePage)用,取得共用外殼已經驗證好的 email 跟登出函式,
 * 不用自己重新監聽一次 auth 狀態。 */
export function useAppLayoutContext(): AppLayoutContext {
  return useOutletContext<AppLayoutContext>();
}

interface TabDef {
  to: string;
  label: string;
  icon: typeof Home;
  isActive: (pathname: string) => boolean;
}

const TABS: TabDef[] = [
  {
    to: "/app",
    label: "首頁",
    icon: Home,
    isActive: (pathname) => pathname === "/app",
  },
  {
    to: "/app/manage",
    label: "功能",
    icon: LayoutGrid,
    isActive: (pathname) =>
      pathname.startsWith("/app/manage") ||
      pathname.startsWith("/app/staff") ||
      pathname.startsWith("/app/agents") ||
      pathname.startsWith("/app/service-items") ||
      pathname.startsWith("/app/settings"),
  },
  {
    to: "/app/calendar",
    label: "行事曆",
    icon: CalendarDays,
    isActive: (pathname) => pathname.startsWith("/app/calendar"),
  },
];

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  const { merchants, isLoading: merchantsLoading } = useGroupMerchants();
  const clearCurrentMerchantSelection = useClearCurrentMerchantSelection();
  const { merchant: currentMerchant } = useCurrentMerchant();

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
      setAuthChecked(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) navigate("/signin", { replace: true });
      else {
        setEmail(session.user.email ?? null);
        setUserId(session.user.id);
      }
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [navigate]);

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

  const outletContext: AppLayoutContext = { email, userId, onSignOut: handleSignOut };

  return (
    <div className="min-h-screen bg-surface font-sans antialiased">
      {/* 對應規格書「首頁外殼與主題色優化」一、1.1:商家切換器(含商家 LOGO)取代秒約 LOGO,
          常駐在頂端列左側;登出按鈕搬到同一列右側。不管切到「首頁/功能/行事曆」哪一個分頁籤,
          頂端都能直接切換商家、直接登出。 */}
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-5">
          <MerchantSwitcher />
          <Button variant="outline" size="sm" onClick={handleSignOut}>
            登出
          </Button>
        </div>
      </header>

      <main className="pb-24">
        <Outlet context={outletContext} />
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background">
        <div className="mx-auto flex max-w-5xl items-stretch justify-around">
          {TABS.map((tab) => {
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
