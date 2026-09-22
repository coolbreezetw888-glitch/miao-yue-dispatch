// 後台導覽外殼「功能」分頁籤(路由 /app/manage,新增)。
//
// 2026-09-16 修正:規格書從「管理功能/設定功能」兩個分頁籤合併成單一個「功能」分頁籤——
// 使用者澄清不需要分類區隔,所有功能入口(服務人員/客服管理/服務項目管理/商家設定)
// 全部放在同一個卡片網格裡,不分類別。之後模組 6-13 只要在下面 CARDS 陣列多加一筆設定就好,
// 不用再回頭改外殼,也不用煩惱要分到哪一類。
//
// 卡片的顯示判斷邏輯直接沿用模組 3 對外介面(useCurrentMerchantRole/useAgentPermission),
// 不重新發明——這次改版只是把「判斷結果拿去決定要不要渲染頂端按鈕」改成「拿去決定要不要
// 渲染卡片」,底層權限判斷完全不變。
//
// 規格書明講:分頁籤本身永遠顯示,不因角色隱藏整個分頁籤——如果目前登入的人一張卡片都看不到
// (例如客服完全沒被開放任何功能),顯示空狀態文字,不是讓這個分頁籤消失或顯示空白。

import type { ComponentType } from "react";
import {
  ArrowLeftRight,
  Bell,
  CalendarClock,
  CalendarOff,
  CalendarRange,
  ClipboardList,
  Coins,
  Download,
  FileBarChart,
  Gift,
  Headset,
  History,
  Megaphone,
  MessageCircle,
  Percent,
  Receipt,
  Settings,
  Smartphone,
  TrendingUp,
  Upload,
  UserMinus,
  UserRound,
  Users,
  Wallet,
} from "lucide-react";
import { Link } from "react-router-dom";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useCurrentMerchantRole, useAgentPermission } from "@/modules/staff-agent/context";
import { MyLineBindingCard } from "@/modules/line-notifications/MyLineBindingCard";
// 模組 14(服務人員端)規格書 4.2:role==='staff' 時渲染完全獨立的卡片清單,這是本檔案唯一
// 一處依賴模組 14 的地方。
import { useActiveMyStaffRecord, useMyStaffPermission } from "@/modules/staff-portal/context";
import { useCurrentMerchant } from "@/modules/merchant/context";

interface FunctionCardDef {
  key: string;
  to: string;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  visible: boolean;
}

/** 模組 14(服務人員端)規格書 4.2:服務人員版本的「功能」分頁籤,只有兩張卡片,完全獨立於
 * 下面 ManagePage 主體的 cards 陣列(不是併入同一個清單)。 */
function StaffManagePage() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant?.id ?? null;
  const { data: staffRow } = useActiveMyStaffRecord(merchantId);
  const { data: canSelfManageAvailability } = useMyStaffPermission("staff_availability_self_manage");
  const { data: canViewPayroll } = useMyStaffPermission("staff_payroll_view");

  // 規則 2.2:月薪制服務人員即使被開通權限也不顯示這張卡片,避免點進去才發現不能用。
  const showAvailabilityCard =
    canSelfManageAvailability === true && staffRow?.compensation_type === "piece_rate";
  const showPayrollCard = canViewPayroll === true;

  const staffCards: FunctionCardDef[] = [
    {
      key: "my-availability",
      to: "/app/my-availability",
      label: "休假設定",
      description: "設定每週固定接單時段、整天排休或時段排休(僅按件計酬服務人員)",
      icon: CalendarOff,
      visible: showAvailabilityCard,
    },
    {
      key: "my-payroll",
      to: "/app/my-payroll",
      label: "薪資報表",
      description: "查看自己每個月的抽成明細或薪資扣款明細",
      icon: FileBarChart,
      visible: showPayrollCard,
    },
  ];
  const visibleStaffCards = staffCards.filter((card) => card.visible);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-5 py-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">功能</h1>
        <p className="mt-1 text-sm text-muted-foreground">依照你的權限,顯示你能操作的功能項目</p>
      </div>

      {visibleStaffCards.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          目前沒有開放給你的功能,請聯絡商家管理員開通權限。
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {visibleStaffCards.map((card) => {
            const Icon = card.icon;
            return (
              <Link key={card.key} to={card.to}>
                <Card className="h-full transition-colors hover:border-brand hover:bg-brand-soft/40">
                  <CardHeader className="items-center gap-3 text-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-soft text-brand">
                      <Icon className="h-6 w-6" />
                    </span>
                    <CardTitle className="text-base">{card.label}</CardTitle>
                    <CardDescription className="text-xs">{card.description}</CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function ManagePage() {
  const { data: merchantRole } = useCurrentMerchantRole();
  const isAdmin = merchantRole === "admin";
  const isStaff = merchantRole === "staff";
  // 模組 4 規格書 4.3/2.5 既有邏輯:商家管理員一律顯示,客服則透過這支 hook 判斷。
  const { data: canManageServiceItems } = useAgentPermission("service_items");
  const showServiceItemsCard = isAdmin || canManageServiceItems === true;
  // 模組 5 規格書 4.7/規則 2.12:business_hours 這個 section_key 涵蓋營業時間設定卡片的顯示權限。
  const { data: canManageBusinessHours } = useAgentPermission("business_hours");
  const showBusinessHoursCard = isAdmin || canManageBusinessHours === true;
  // 建單功能擴充規格書 5.6:material_costs 這個 section_key 決定料錢成本管理卡片的顯示權限。
  const { data: canManageMaterialCosts } = useAgentPermission("material_costs");
  const showMaterialCostsCard = isAdmin || canManageMaterialCosts === true;
  // 模組 9(支付方式)v2 規格書 §5.5:payment_methods 這個 section_key 決定付款方式管理卡片的
  // 顯示權限。跟「建單時選擇既有付款方式」是兩件不同的事(那個只要有 orders 權限即可,不影響
  // 這裡的顯示判斷)。
  const { data: canManagePaymentMethods } = useAgentPermission("payment_methods");
  const showPaymentMethodsCard = isAdmin || canManagePaymentMethods === true;
  // 模組 6(訂單管理)規格書 §1.4:訂單管理卡片沿用既有 orders section_key(模組 5 擴充
  // 已用這個 section_key 判斷建單/確認/編輯/取消/完成的權限,列表頁檢視權限沿用同一個
  // section_key,不新增權限項目;跟 RequireBookingAccess.tsx 用的判斷邏輯一致)。
  const { data: canManageOrders } = useAgentPermission("orders");
  const showOrdersCard = isAdmin || canManageOrders === true;
  // 模組 7(排班與休假管理)規則 2.11/§4.7:team_leave 這個 section_key 決定「假別設定」
  // 「請假紀錄」兩張卡片的顯示權限,scheduling 是獨立的另一把鑰匙決定「排班一覽」卡片。
  const { data: canManageTeamLeave } = useAgentPermission("team_leave");
  const showTeamLeaveCards = isAdmin || canManageTeamLeave === true;
  const { data: canViewScheduling } = useAgentPermission("scheduling");
  const showSchedulingCard = isAdmin || canViewScheduling === true;
  // 模組 8(薪資與帳務)§4.6:commission_settings/billing/staff_report 三把獨立鑰匙,分別決定
  // 「抽成與薪資設定」「店家帳務報表」「師傅報表」三張卡片的顯示權限。
  const { data: canManageCommissionSettings } = useAgentPermission("commission_settings");
  const showPayrollSettingsCard = isAdmin || canManageCommissionSettings === true;
  const { data: canViewBilling } = useAgentPermission("billing");
  const showBillingReportCard = isAdmin || canViewBilling === true;
  const { data: canViewStaffReport } = useAgentPermission("staff_report");
  const showStaffReportCard = isAdmin || canViewStaffReport === true;
  // 模組 10(會員與紅利)§4.7:members/member_settings 兩把獨立鑰匙,分別決定「會員管理」
  // 「會員系統設定」兩張卡片的顯示權限。
  const { data: canManageMembers } = useAgentPermission("members");
  const showMembersCard = isAdmin || canManageMembers === true;
  const { data: canManageMemberSettings } = useAgentPermission("member_settings");
  const showMemberSettingsCard = isAdmin || canManageMemberSettings === true;
  // 模組 11(LINE 通知)§4.10:line_notification 這把鑰匙決定「LINE 通知設定」「LINE 發送記錄」
  // 兩張卡片的顯示權限;「LINE 串接設定」「行銷再通知」永遠只給商家管理員(規則 2.1/2.6)。
  const { data: canManageLineNotification } = useAgentPermission("line_notification");
  const showLineNotificationCards = isAdmin || canManageLineNotification === true;
  // 模組 15(服務人員推播通知)7.3/7.9:push_notification 這把鑰匙決定「推播通知設定」卡片
  // 的顯示權限,完全比照模組 11 line_notification 的既有模式。
  const { data: canManagePushNotification } = useAgentPermission("push_notification");
  const showPushNotificationCard = isAdmin || canManagePushNotification === true;
  // 模組 12(資料匯入與報表匯出)§4.6:「資料匯入」「產業轉移」永遠只給商家管理員(規則 2.1/2.10，
  // 不透過 section_key 開放客服)；「報表匯出中心」沿用一般客服權限開關模式(report_export，規則 2.9)。
  const { data: canExportReports } = useAgentPermission("report_export");
  const showReportExportCard = isAdmin || canExportReports === true;

  // 模組 14 規格書 4.2:服務人員登入後看到完全獨立的卡片清單(StaffManagePage),不會看到
  // 下面任何管理員/客服導向的卡片。放在這裡(所有 useAgentPermission hook 呼叫完之後)提早
  // return,不影響上面 hooks 呼叫順序的一致性(StaffManagePage 是獨立元件,有自己的 hooks)。
  if (isStaff) {
    return <StaffManagePage />;
  }

  const cards: FunctionCardDef[] = [
    {
      key: "staff",
      to: "/app/staff",
      label: "服務人員",
      description: "管理師傅/服務人員名錄與可承接的服務項目",
      icon: Users,
      visible: isAdmin,
    },
    {
      key: "agents",
      to: "/app/agents",
      label: "客服管理",
      description: "邀請客服、設定後台功能權限",
      icon: Headset,
      visible: isAdmin,
    },
    {
      key: "service-items",
      to: "/app/service-items",
      label: "服務項目管理",
      description: "管理服務分類與服務項目、金額、工時",
      icon: ClipboardList,
      visible: showServiceItemsCard,
    },
    {
      key: "business-hours",
      to: "/app/business-hours",
      label: "營業時間設定",
      description: "每週營業時間、嚴格工時衝突檢查開關",
      icon: CalendarClock,
      visible: showBusinessHoursCard,
    },
    {
      key: "material-costs",
      to: "/app/material-costs",
      label: "料錢成本管理",
      description: "管理建單時可選用的料錢成本品項清單",
      icon: Coins,
      visible: showMaterialCostsCard,
    },
    {
      key: "payment-methods",
      to: "/app/payment-methods",
      label: "付款方式管理",
      description: "管理建單時可選用的付款方式清單",
      icon: Wallet,
      visible: showPaymentMethodsCard,
    },
    {
      key: "orders",
      to: "/app/orders",
      label: "訂單管理",
      description: "查看與管理所有預約訂單、篩選狀態與金額",
      icon: Receipt,
      visible: showOrdersCard,
    },
    {
      key: "leave-types",
      to: "/app/leave-types",
      label: "假別設定",
      description: "管理商家自訂的請假分類清單",
      icon: CalendarOff,
      visible: showTeamLeaveCards,
    },
    {
      key: "leave-records",
      to: "/app/leave-records",
      label: "請假紀錄",
      description: "登記/取消月薪制服務人員的請假",
      icon: UserMinus,
      visible: showTeamLeaveCards,
    },
    {
      key: "scheduling",
      to: "/app/scheduling",
      label: "排班一覽",
      description: "跨服務人員的每週時段/例外/請假總覽",
      icon: CalendarRange,
      visible: showSchedulingCard,
    },
    {
      key: "payroll-settings",
      to: "/app/payroll-settings",
      label: "抽成與薪資設定",
      description: "設定抽成基準/比例、月薪與月休天數",
      icon: Percent,
      visible: showPayrollSettingsCard,
    },
    {
      key: "billing-report",
      to: "/app/billing-report",
      label: "店家帳務報表",
      description: "查看月度營收、成本、抽成支出與概估毛利",
      icon: TrendingUp,
      visible: showBillingReportCard,
    },
    {
      key: "staff-report",
      to: "/app/staff-report",
      label: "師傅報表",
      description: "查看個別服務人員的抽成或薪資明細",
      icon: FileBarChart,
      visible: showStaffReportCard,
    },
    {
      key: "members",
      to: "/app/members",
      label: "會員管理",
      description: "管理會員資料、紅利點數、推薦名單",
      icon: UserRound,
      visible: showMembersCard,
    },
    {
      key: "member-settings",
      to: "/app/member-settings",
      label: "會員系統設定",
      description: "設定電話驗證政策、消費點數比例、推薦與生日獎勵",
      icon: Gift,
      visible: showMemberSettingsCard,
    },
    {
      key: "line-settings",
      to: "/app/line-settings",
      label: "LINE 串接設定",
      description: "串接商家自己的 LINE 官方帳號憑證、測試連線",
      icon: MessageCircle,
      visible: isAdmin,
    },
    {
      key: "line-events",
      to: "/app/line-events",
      label: "LINE 通知設定",
      description: "設定每類事件要不要通知、通知誰、文案內容",
      icon: Bell,
      visible: showLineNotificationCards,
    },
    {
      key: "line-logs",
      to: "/app/line-logs",
      label: "LINE 發送記錄",
      description: "查看每一次 LINE 通知的成功/失敗/跳過記錄",
      icon: History,
      visible: showLineNotificationCards,
    },
    {
      key: "line-marketing",
      to: "/app/line-marketing",
      label: "行銷再通知",
      description: "手動挑選已綁定會員名單,發送一次性自訂訊息",
      icon: Megaphone,
      visible: isAdmin,
    },
    {
      key: "push-events",
      to: "/app/push-events",
      label: "推播通知設定",
      description: "設定服務人員手機/瀏覽器推播要不要開、文案內容",
      icon: Smartphone,
      visible: showPushNotificationCard,
    },
    {
      key: "data-import",
      to: "/app/data-import",
      label: "資料匯入",
      description: "把舊系統的會員/歷史訂單資料匯入到秒約(含匯入紀錄與一鍵復原)",
      icon: Upload,
      visible: isAdmin,
    },
    {
      key: "reports",
      to: "/app/reports",
      label: "報表匯出中心",
      description: "統一匯出訂單/會員/抽成/請假四種報表 CSV",
      icon: Download,
      visible: showReportExportCard,
    },
    {
      key: "industry-transfer",
      to: "/app/industry-transfer",
      label: "產業轉移",
      description: "建立新產業的分店，並選擇性把會員與紅利點數搬過去",
      icon: ArrowLeftRight,
      visible: isAdmin,
    },
    {
      key: "settings",
      to: "/app/settings",
      label: "商家設定",
      description: "LOGO、店名、地址、主題色、公告等基本設定",
      icon: Settings,
      visible: isAdmin,
    },
  ];

  const visibleCards = cards.filter((card) => card.visible);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-5 py-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">功能</h1>
        <p className="mt-1 text-sm text-muted-foreground">依照你的權限,顯示你能操作的功能項目</p>
      </div>

      {/* 模組 11(LINE 通知)§4.5:「我的 LINE 綁定」個人設定區塊,商家管理員/客服都會經過這個
          頁面,不需要另外找個人設定選單掛載點。元件本身依角色判斷是否顯示,非管理員/客服(理論上
          不會發生)或還沒有選定商家時回傳 null。 */}
      <MyLineBindingCard />

      {visibleCards.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          目前沒有開放給你的功能,請聯絡商家管理員開通權限。
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {visibleCards.map((card) => {
            const Icon = card.icon;
            return (
              <Link key={card.key} to={card.to}>
                <Card className="h-full transition-colors hover:border-brand hover:bg-brand-soft/40">
                  <CardHeader className="items-center gap-3 text-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-soft text-brand">
                      <Icon className="h-6 w-6" />
                    </span>
                    <CardTitle className="text-base">{card.label}</CardTitle>
                    <CardDescription className="text-xs">{card.description}</CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
