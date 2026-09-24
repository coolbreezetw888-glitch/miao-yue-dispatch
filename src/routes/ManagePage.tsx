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
//
// 商家端調整批次(2026-09-22)三項同批異動,對應 .project/SPECS-INDEX.md #601/#610/#617:
//   #601(.project/specs/資料匯入與報表匯出.md §10.2):移除「產業轉移」卡片入口——底層路由
//     /app/industry-transfer、頁面、轉移函式、安全邊界、既有測試完全不動,只是不再顯示卡片,
//     未來要恢復只需要把卡片定義加回 cards 陣列,不需要任何資料庫層復原工作。
//   #610(.project/specs/後台導覽外殼.md 該批次章節):移除「訂單管理」卡片——訂單管理已經獨立
//     升級成 AppLayout 底部分頁籤(見 src/routes/AppLayout.tsx),不再是這個頁面的卡片。
//   #617(.project/specs/會員與紅利.md §10.5):新增「紅利點數管理」獨立卡片,原本掛在會員詳情頁
//     的點數操作(兌換/調整/歷史)搬到新頁面 src/modules/members/MemberPointsPage.tsx。
//   服務人員角色(模組 14/15.1):「功能」分頁籤底下原本的「休假設定」「薪資報表」兩張卡片
//   已經各自獨立升級成 AppLayout 底部分頁籤,服務人員不再看到這個頁面,見下方 isStaff 分支。

import { useEffect, useState, type ComponentType, type FormEvent } from "react";
import {
  Award,
  Bell,
  CalendarClock,
  CalendarOff,
  CalendarRange,
  ClipboardList,
  Coins,
  Copy,
  Download,
  FileBarChart,
  Gift,
  Headset,
  History,
  Megaphone,
  MessageCircle,
  Percent,
  Settings,
  Smartphone,
  Upload,
  UserMinus,
  UserRound,
  Users,
  Wallet,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { updateMyAdminProfile } from "@/modules/merchant/api";
import { useCurrentMerchant, useMyAdminProfile } from "@/modules/merchant/context";
import { clearAgentPendingLoginEmail, updateMyAgentProfile } from "@/modules/staff-agent/api";
import {
  useCurrentMerchantRole,
  useAgentPermission,
  useMyAgentProfile,
} from "@/modules/staff-agent/context";
import { MyLineBindingCard } from "@/modules/line-notifications/MyLineBindingCard";

import { useAppLayoutContext } from "./AppLayout";
import {
  emailNamePrefix,
  LoginEmailSection,
  PendingAdminLoginEmailSuggestionCard,
} from "./ProfileCardShared";

interface EditProfileDialogProps {
  role: "admin" | "agent";
  merchantId: string;
  nameLabel: string;
  currentName: string;
  currentJobTitle: string;
  onSaved: () => void;
}

/** 使用者決策(2026-09-23):從舊版 HomePage.tsx 原封不動搬過來——「編輯個人資料」按鈕點擊開啟
 * 的小對話框,可以編輯姓名/暱稱、職位兩個欄位,儲存後由呼叫端 onSaved() 重新整理卡片顯示的資料。
 * 服務人員版本(EditMyStaffProfileDialog)不在這裡,那個留在 HomePage.tsx 給服務人員自己用。 */
function EditProfileDialog({
  role,
  merchantId,
  nameLabel,
  currentName,
  currentJobTitle,
  onSaved,
}: EditProfileDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(currentName);
  const [jobTitle, setJobTitle] = useState(currentJobTitle);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(currentName);
      setJobTitle(currentJobTitle);
    }
  }, [open, currentName, currentJobTitle]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      if (role === "admin") {
        await updateMyAdminProfile(merchantId, name, jobTitle);
      } else {
        await updateMyAgentProfile(merchantId, name, jobTitle);
      }
      onSaved();
      setOpen(false);
      toast.success("個人資料已更新");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          編輯個人資料
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>編輯個人資料</DialogTitle>
          <DialogDescription>只會更新你自己的資料,不會影響到其他人。</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="profile-name">{nameLabel}</Label>
            <Input
              id="profile-name"
              className="mt-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="profile-job-title">職位</Label>
            <Input
              id="profile-job-title"
              className="mt-2"
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={saving}>
              {saving ? "儲存中⋯" : "儲存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 使用者決策(2026-09-23):「預約網址」獨立卡片——搬自商家設定頁「基本資料」區塊,那裡原本
 * 直接印出整段 booking_slug 純文字,這裡改成用「複製連結」按鈕操作,不在畫面上顯示整段網址。
 * 商家設定頁原本那個區塊保留不移除(使用者原話:「原本商家設定內的保留不移除」)。
 * 實際的客戶預約頁面要等「客戶端自助預約」模組(模組 13)推出才會真正上線,這裡先讓連結可以複製
 * 起來備用,不是本模組新增的功能承諾。 */
function BookingUrlCard() {
  const { merchant } = useCurrentMerchant();
  const bookingSlug = merchant?.booking_slug ?? null;

  function handleCopy() {
    if (!bookingSlug) return;
    const url = `${window.location.origin}/booking/${bookingSlug}`;
    void navigator.clipboard.writeText(url).then(
      () => toast.success("已複製預約網址"),
      () => toast.error("複製失敗,請手動到商家設定頁查看"),
    );
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-card p-5">
      <div>
        <p className="text-sm font-medium text-foreground">預約網址</p>
        <p className="mt-1 text-xs text-muted-foreground">
          顧客預約用的專屬連結,實際頁面會在「客戶端自助預約」模組推出後才能使用。
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={handleCopy} disabled={!bookingSlug}>
        <Copy className="mr-1.5 h-3.5 w-3.5" />
        複製連結
      </Button>
    </div>
  );
}

interface FunctionCardDef {
  key: string;
  to: string;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  visible: boolean;
}

export default function ManagePage() {
  const navigate = useNavigate();
  const { data: merchantRole, isLoading: roleLoading } = useCurrentMerchantRole();
  const isAdmin = merchantRole === "admin";
  const isAgent = merchantRole === "agent";
  const { email, newEmail, userId, isStaffView } = useAppLayoutContext();
  const { merchant: currentMerchant } = useCurrentMerchant();
  const merchantId = currentMerchant?.id ?? null;

  // 商家端調整批次(2026-09-22,.project/SPECS-INDEX.md #609,.project/specs/服務人員端.md
  // §15.1):服務人員角色原本在這裡看到的「功能」分頁籤(只有休假設定/薪資報表兩張卡片,舊版
  // StaffManagePage)已經作廢——這兩張卡片各自升級成 AppLayout 底部分頁籤(/app/my-availability、
  // /app/my-payroll),服務人員的底部導覽不再連到這個路由。這裡只保留防呆:萬一服務人員透過
  // 殘留的深連結/書籤仍然打到 /app/manage,直接導回「首頁」分頁籤,不留下一個空的/過期的畫面。
  // 2026-09-23:改用 isStaffView(涵蓋純服務人員角色 + 雙重身份選擇切到服務人員端檢視兩種情境)
  // 判斷,不是只看原始角色——雙重身份的人選了服務人員端之後,不應該還能停留在這個商家管理頁面。
  // 這段 useEffect 故意放在所有 useAgentPermission hook 呼叫「之前」宣告、但實際的提早 return
  // 放在全部 hooks 呼叫「之後」(見下面 isStaffView 判斷式)——確保不管 isStaffView 是 true/false,
  // 每次 render 呼叫的 hooks 數量/順序都一樣,不違反 React hooks 規則。
  useEffect(() => {
    if (roleLoading) return;
    if (isStaffView) {
      navigate("/app", { replace: true });
    }
  }, [roleLoading, isStaffView, navigate]);

  // 使用者決策(2026-09-23):「首頁」分頁籤拔掉,個人資料卡片(姓名/職位/登入信箱)搬到這裡
  // 最上方,邏輯原封不動搬自舊版 HomePage.tsx(服務人員版本留在 HomePage.tsx,這裡只有
  // 管理員/客服兩種)。
  const adminProfileQuery = useMyAdminProfile(merchantId, userId, isAdmin);
  const agentProfileQuery = useMyAgentProfile(merchantId, userId, isAgent);

  const emailPrefix = emailNamePrefix(email);
  const displayName = isAdmin
    ? adminProfileQuery.data?.displayName || emailPrefix
    : isAgent
      ? agentProfileQuery.data?.nickname || emailPrefix
      : emailPrefix;
  const jobTitleFallback = isAgent ? "客服" : "商家管理員";
  const jobTitle = isAdmin
    ? adminProfileQuery.data?.jobTitle || jobTitleFallback
    : isAgent
      ? agentProfileQuery.data?.job_title || jobTitleFallback
      : jobTitleFallback;
  const rawName = isAdmin
    ? (adminProfileQuery.data?.displayName ?? "")
    : isAgent
      ? (agentProfileQuery.data?.nickname ?? "")
      : "";
  const rawJobTitle = isAdmin
    ? (adminProfileQuery.data?.jobTitle ?? "")
    : isAgent
      ? (agentProfileQuery.data?.job_title ?? "")
      : "";

  function refetchProfile() {
    if (isAdmin) void adminProfileQuery.refetch();
    else if (isAgent) void agentProfileQuery.refetch();
  }

  async function clearAgentPendingSuggestion() {
    if (!agentProfileQuery.data) return;
    await clearAgentPendingLoginEmail(agentProfileQuery.data.id);
    await agentProfileQuery.refetch();
  }

  // 使用者決策(2026-09-23):服務人員管理開放給有 staff_management 權限的客服使用。
  const { data: canManageStaff } = useAgentPermission("staff_management");
  const showStaffCard = isAdmin || canManageStaff === true;
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
  // 模組 6(訂單管理)規格書 §1.4:訂單管理原本掛在這裡的卡片,依商家端調整批次(2026-09-22,
  // 對應 .project/specs/後台導覽外殼.md 該批次章節)已經獨立升級成 AppLayout 底部「訂單管理」
  // 分頁籤,不再是這個頁面的卡片,orders 這個 section_key 的判斷邏輯搬到 AppLayout.tsx。
  // 模組 7(排班與休假管理)規則 2.11/§4.7:team_leave 這個 section_key 決定「假別設定」
  // 「請假紀錄」兩張卡片的顯示權限,scheduling 是獨立的另一把鑰匙決定「排班一覽」卡片。
  const { data: canManageTeamLeave } = useAgentPermission("team_leave");
  const showTeamLeaveCards = isAdmin || canManageTeamLeave === true;
  const { data: canViewScheduling } = useAgentPermission("scheduling");
  const showSchedulingCard = isAdmin || canViewScheduling === true;
  // 模組 8(薪資與帳務)§4.6:commission_settings/staff_report 兩把獨立鑰匙,分別決定
  // 「抽成與薪資設定」「師傅報表」兩張卡片的顯示權限。「店家帳務報表」(billing)2026-09-23
  // 已升級成底部分頁籤(見 AppLayout.tsx),billing 這個 section_key 的判斷邏輯搬到
  // RequireBillingAccess.tsx,不再是這個頁面的卡片。
  const { data: canManageCommissionSettings } = useAgentPermission("commission_settings");
  const showPayrollSettingsCard = isAdmin || canManageCommissionSettings === true;
  const { data: canViewStaffReport } = useAgentPermission("staff_report");
  const showStaffReportCard = isAdmin || canViewStaffReport === true;
  // 模組 10(會員與紅利)§4.7:members/member_settings 兩把獨立鑰匙,分別決定「會員管理」
  // 「會員系統設定」兩張卡片的顯示權限。
  const { data: canManageMembers } = useAgentPermission("members");
  const showMembersCard = isAdmin || canManageMembers === true;
  const { data: canManageMemberSettings } = useAgentPermission("member_settings");
  const showMemberSettingsCard = isAdmin || canManageMemberSettings === true;
  // 模組 11(LINE 通知)§4.10:line_notification 這把鑰匙決定「LINE 通知設定」「LINE 發送記錄」
  // 兩張卡片的顯示權限;「LINE 串接設定」「行銷通知」永遠只給商家管理員(規則 2.1/2.6)。
  const { data: canManageLineNotification } = useAgentPermission("line_notification");
  const showLineNotificationCards = isAdmin || canManageLineNotification === true;
  // 模組 15(服務人員推播通知)7.3/7.9:push_notification 這把鑰匙決定「推播通知設定」卡片
  // 的顯示權限,完全比照模組 11 line_notification 的既有模式。
  const { data: canManagePushNotification } = useAgentPermission("push_notification");
  const showPushNotificationCard = isAdmin || canManagePushNotification === true;
  // 模組 12(資料匯入與報表匯出)§4.6:「資料匯入」永遠只給商家管理員(規則 2.1/2.10，不透過
  // section_key 開放客服)；「報表匯出中心」沿用一般客服權限開關模式(report_export，規則 2.9)。
  // 「產業轉移」原本也在這裡(永遠只給商家管理員),商家端調整批次(2026-09-22,#601)之後
  // 卡片入口已移除,見下面 cards 陣列的說明,路由/函式/測試本身完全不動。
  const { data: canExportReports } = useAgentPermission("report_export");
  const showReportExportCard = isAdmin || canExportReports === true;
  // 模組 10(會員與紅利)§10.5(#617):member-points 卡片沿用跟「會員管理」相同的 members
  // section_key——點數餘額檢視/兌換/手動調整這些操作性質上跟既有會員管理權限邊界一致,不新增
  // 權限項目(規格書「涉及元件」一節明講由 engineer 決定歸在 members 還是 member_settings,
  // 這裡選 members)。

  // 所有 useAgentPermission hook 都呼叫完畢,這裡才做服務人員端檢視的提早 return(見上面 useEffect
  // 旁的說明),不影響 hooks 呼叫順序的一致性。
  if (isStaffView) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      </div>
    );
  }

  const cards: FunctionCardDef[] = [
    {
      key: "staff",
      to: "/app/staff",
      label: "服務人員",
      description: "管理師傅/服務人員名錄與可承接的服務項目",
      icon: Users,
      visible: showStaffCard,
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
      description: "管理會員基本資料、電話驗證、推薦名單",
      icon: UserRound,
      visible: showMembersCard,
    },
    {
      key: "member-points",
      to: "/app/member-points",
      label: "紅利點數管理",
      // 2026-09-24:描述補上 #639/#642 搬進這頁的「點數設定」,以及這次搬進來的「核發獎勵資格
      // 條件」——原本的描述只講點數餘額/兌換/異動歷史,使用者從這張卡片看不出設定也在裡面。
      description: "點數餘額、兌換調整、核發資格與點數設定",
      icon: Award,
      visible: showMembersCard,
    },
    {
      key: "member-settings",
      to: "/app/member-settings",
      label: "會員系統設定",
      // 2026-09-24:原本的描述「設定電話驗證政策、消費點數比例、推薦與生日獎勵」三項都已經不在
      // 這頁了(電話驗證政策 #618 整個移除、點數三個欄位 #642 搬去紅利點數管理、核發獎勵資格條件
      // 2026-09-24 搬去紅利點數管理),照這頁目前實際剩下的兩個區塊改寫。
      description: "設定會員政策內容、管理會員等級",
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
      label: "行銷通知",
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
    // data-testid="manage-page":e2e 測試的共用啟動錨點(見 e2e/support/app-shell.ts)。
    // 2026-09-23 後台導覽改版拔掉「首頁」分頁籤之後,/app 對商家管理員/客服會轉址到這裡,
    // 測試需要一個「不管角色/權限怎麼設定都一定存在」的元素來確認外殼已經渲染完成——頁面上的
    // 功能卡片全部會因權限被藏起來,只有這個根容器永遠在,所以錨點掛在這一層。
    <div data-testid="manage-page" className="mx-auto max-w-3xl space-y-6 px-5 py-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">功能</h1>
        <p className="mt-1 text-sm text-muted-foreground">依照你的權限,顯示你能操作的功能項目</p>
      </div>

      {/* 使用者決策(2026-09-23):「首頁」分頁籤拔掉,個人資料卡片搬到這裡最上方
          (原封不動搬自舊版 HomePage.tsx,服務人員版本留在 HomePage.tsx)。 */}
      <div className="space-y-4 rounded-2xl border border-border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Avatar className="h-12 w-12">
              <AvatarFallback className="bg-brand-soft text-lg font-semibold text-brand">
                {displayName.slice(0, 1)}
              </AvatarFallback>
            </Avatar>
            <div>
              <p className="text-lg font-semibold text-foreground">{displayName}</p>
              <p className="text-sm text-muted-foreground">{jobTitle}</p>
            </div>
          </div>
          {merchantId && (isAdmin || isAgent) ? (
            <EditProfileDialog
              role={isAdmin ? "admin" : "agent"}
              merchantId={merchantId}
              nameLabel={isAdmin ? "姓名/暱稱" : "暱稱"}
              currentName={rawName}
              currentJobTitle={rawJobTitle}
              onSaved={refetchProfile}
            />
          ) : null}
        </div>
        <LoginEmailSection email={email} newEmail={newEmail} />
      </div>

      {isAgent && agentProfileQuery.data?.pending_admin_login_email ? (
        <PendingAdminLoginEmailSuggestionCard
          pendingEmail={agentProfileQuery.data.pending_admin_login_email}
          onClear={clearAgentPendingSuggestion}
        />
      ) : null}

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

      {/* 使用者決策(2026-09-23):「預約網址」獨立卡片。 */}
      <BookingUrlCard />

      {/* 模組 11(LINE 通知)§4.5:「我的 LINE 綁定」個人設定區塊,商家管理員/客服都會經過這個
          頁面,不需要另外找個人設定選單掛載點。元件本身依角色判斷是否顯示,非管理員/客服(理論上
          不會發生)或還沒有選定商家時回傳 null。2026-09-23:使用者要求移到頁面最下方。 */}
      <MyLineBindingCard />
    </div>
  );
}
