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
//   4. 透過 <Outlet context={...}> 把 email/使用者 id/登出函式往下傳給子路由(例如「首頁」分頁籤
//      的個人資料卡片需要 userId 查詢自己的管理員/客服紀錄),子路由不用重新呼叫一次登入驗證。
//
// 商家端調整批次(2026-09-22,對應 .project/SPECS-INDEX.md #609/#610,.project/specs/
// 後台導覽外殼.md 該批次章節 + .project/specs/服務人員端.md §15.1):底部分頁籤依角色不同,
// 依 useCurrentMerchantRole() 的結果挑選對應的分頁籤組合:
//   - 商家管理員/客服(role !== 'staff',含角色還在載入中的預設情況)。
//   - 服務人員(role === 'staff'):首頁/休假設定(原「功能」卡片獨立升級)/薪資報表(原「功能」
//     卡片獨立升級)/行事曆。服務人員不再看到「功能」分頁籤,ManagePage.tsx 對服務人員角色而言
//     已經沒有對應的分頁籤入口。
// 「分頁籤永遠顯示、不因角色/權限隱藏」這條既有規則延續適用(.project/SPECS-INDEX.md #118)——
// 「訂單管理」「店家報表」這兩個分頁籤沒有對應權限的客服一樣看得到分頁籤本身,點進去分別由
// OrdersPage.tsx/BillingReportPage.tsx 顯示空狀態文字,不是分頁籤消失。
//
// 使用者決策(2026-09-23,大改版,詳見各檔案自己的說明):
//   - 拔掉「首頁」分頁籤(商家管理員/客服視角)——內容分散到「功能」頁最上方(個人資料卡片)/
//     「商家設定」頁最下方(新增分店),見 HomePage.tsx/ManagePage.tsx/MerchantSettingsPage.tsx。
//     服務人員視角維持有「首頁」分頁籤,HomePage.tsx(/app)現在專職服務人員自己的個人資料首頁。
//   - 商家管理員/客服分頁籤順序改成:功能/行事曆/訂單管理/店家報表(原「店家帳務報表」卡片
//     獨立升級成分頁籤並改名「店家報表」)。
//   - 新增雙重身份切換(管理員/客服同時也是這間商家的服務人員時,可以在 MerchantSwitcher 的
//     下拉選單裡手動切換要看商家端還是服務人員端內容),見下方 isDualRoleEligible/forcedStaffView/
//     isStaffView 三個變數的說明,以及 MerchantSwitcher.tsx 的切換選項渲染。
//
// 例外(不套用這個外殼,見規格書「例外」一節):/app/onboarding、/app/agent-invite-complete
// 維持獨立全螢幕流程,在 src/App.tsx 裡刻意放在 <AppLayout> 巢狀路由之外。

import { useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  CalendarOff,
  FileBarChart,
  Home,
  LayoutGrid,
  Receipt,
  TrendingUp,
} from "lucide-react";
import { Link, Outlet, useLocation, useNavigate, useOutletContext } from "react-router-dom";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import InstallPwaHint from "@/components/InstallPwaHint";
import UpdateAvailableHint from "@/components/UpdateAvailableHint";
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
// #609/#610:底部分頁籤這次依角色不同(商家管理員/客服 vs 服務人員),需要在外殼層級就知道
// 目前使用者的角色。
import { useCurrentMerchantRole } from "@/modules/staff-agent/context";
// 使用者決策(2026-09-23):管理員/客服同時也是服務人員時的雙重身份切換——直接查自己的
// merchant_staff 紀錄(不透過 useCurrentMerchantRole 的角色優先權判斷),判斷「除了目前解析出來
// 的角色之外,我是不是也能切到服務人員端」。
import { useActiveMyStaffRecord } from "@/modules/staff-portal/context";

export interface AppLayoutContext {
  email: string | null;
  userId: string | null;
  /** 對應規格書(帳號登入安全性優化)2.5.1:目前登入者自己有沒有一筆 Supabase 原生的待驗證新
   * 信箱(auth.users.new_email)。三種角色共用,不用各自重新呼叫一次 getVerifiedUser()。 */
  newEmail: string | null;
  onSignOut: () => void;
  /** 使用者決策(2026-09-23):目前實際要不要顯示服務人員端內容——純服務人員角色永遠 true;
   * 管理員/客服同時也是服務人員時,依 MerchantSwitcher 的雙重身份切換選擇決定。HomePage.tsx
   * 用這個值決定要渲染服務人員自己的個人資料首頁,還是導去 /app/manage。 */
  isStaffView: boolean;
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

const HOME_TAB: TabDef = {
  to: "/app",
  label: "首頁",
  icon: Home,
  isActive: (pathname) => pathname === "/app",
};

const CALENDAR_TAB: TabDef = {
  to: "/app/calendar",
  label: "行事曆",
  icon: CalendarDays,
  isActive: (pathname) => pathname.startsWith("/app/calendar"),
};

// 使用者決策(2026-09-23):拔掉「首頁」分頁籤(內容搬到功能頁最上方/商家設定頁最下方,見
// HomePage.tsx/ManagePage.tsx/MerchantSettingsPage.tsx 開頭的說明),順序改成
// 功能/行事曆/訂單管理/店家報表(原本「店家帳務報表」卡片獨立升級成分頁籤,同時改名「店家報表」,
// 比照訂單管理當初升級成分頁籤的既有模式——沒有 billing 權限的客服一樣看得到分頁籤本身,點進去由
// BillingReportPage.tsx 顯示空狀態文字,不會被導離,見 RequireBillingAccess.tsx 的對應調整)。
const MERCHANT_TABS: TabDef[] = [
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
  CALENDAR_TAB,
  {
    to: "/app/orders",
    label: "訂單管理",
    icon: Receipt,
    isActive: (pathname) => pathname.startsWith("/app/orders"),
  },
  {
    to: "/app/billing-report",
    label: "店家報表",
    icon: TrendingUp,
    isActive: (pathname) => pathname.startsWith("/app/billing-report"),
  },
];

// 服務人員(#609,.project/specs/服務人員端.md §15.1):首頁/休假設定/薪資報表/行事曆——原本
// 「功能」分頁籤底下的兩張卡片各自升級成獨立分頁籤,「功能」分頁籤本身移除(ManagePage.tsx
// 對服務人員角色而言已經沒有對應入口)。
const STAFF_TABS: TabDef[] = [
  HOME_TAB,
  {
    to: "/app/my-availability",
    label: "休假設定",
    icon: CalendarOff,
    isActive: (pathname) => pathname.startsWith("/app/my-availability"),
  },
  {
    to: "/app/my-payroll",
    label: "薪資報表",
    icon: FileBarChart,
    isActive: (pathname) => pathname.startsWith("/app/my-payroll"),
  },
  CALENDAR_TAB,
];

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
  // 客服那組當預設——多數使用者是管理員/客服,先顯示那組風險最低,role 一解出來是 'staff'
  // 馬上就會切換,不會卡在錯的分頁籤組合太久。
  const { data: merchantRole } = useCurrentMerchantRole();

  // 使用者決策(2026-09-23):管理員/客服同時也是服務人員時,可以在 MerchantSwitcher 的下拉選單
  // 裡手動切換要看商家端還是服務人員端——直接查自己的 merchant_staff 紀錄(不透過
  // useCurrentMerchantRole 的角色優先權判斷,那支 hook 身兼多重角色時永遠回傳較高權限角色,
  // 見該檔案註解「規則 2.10」),判斷「除了目前解析出來的角色之外,我是不是也能切到服務人員端」。
  const { data: myStaffRow } = useActiveMyStaffRecord(currentMerchant?.id ?? null);
  const isDualRoleEligible =
    (merchantRole === "admin" || merchantRole === "agent") && myStaffRow != null;
  const [forcedStaffView, setForcedStaffView] = useState(false);
  // 切換商家時重置回預設檢視,避免帶著「在 A 店選擇服務人員端」的狀態誤套用到剛切過去的 B 店
  // (B 店不一定也有這位使用者的服務人員身份)。
  useEffect(() => {
    setForcedStaffView(false);
  }, [currentMerchant?.id]);
  const isStaffView = merchantRole === "staff" || (isDualRoleEligible && forcedStaffView);
  const tabs = isStaffView ? STAFF_TABS : MERCHANT_TABS;

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
  };

  return (
    <div className="min-h-screen bg-surface font-sans antialiased">
      {/* 對應規格書「首頁外殼與主題色優化」一、1.1:商家切換器(含商家 LOGO)取代秒約 LOGO,
          常駐在頂端列左側;登出按鈕搬到同一列右側。不管切到哪一個分頁籤,頂端都能直接切換商家、
          直接登出。2026-09-23:雙重身份(管理員/客服同時也是服務人員)的切換入口也掛在這個
          下拉選單裡(見 MerchantSwitcher.tsx),不是另外的按鈕。 */}
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-5">
          <MerchantSwitcher
            canSwitchToStaffView={isDualRoleEligible}
            isStaffView={isStaffView}
            onToggleView={() => setForcedStaffView((prev) => !prev)}
          />
          <Button variant="outline" size="sm" onClick={handleSignOut}>
            登出
          </Button>
        </div>
      </header>

      <main className="pb-24">
        <Outlet context={outletContext} />
      </main>

      {/* 模組 7(排班與休假管理)§6.5:安裝提示元件,掛在共用後台殼層(見第〇節判斷 8,
          PWA 這次疊加在既有 /app 殼層上,不是獨立師傅端)。 */}
      <InstallPwaHint />
      {/* 模組 7 §6.4 修正(2026-09-20 主腦複查):新版本待套用時的提示條,掛在同一個共用殼層。
          刻意放在畫面頂部,跟 InstallPwaHint(畫面底部)分開,避免兩個提示條同時出現時互相重疊。 */}
      <UpdateAvailableHint />

      <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background">
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
