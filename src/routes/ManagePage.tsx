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
import { isValidTaiwanMobilePhone, TW_MOBILE_PHONE_ERROR_MESSAGE } from "@/lib/validation";
import { updateMyAdminProfile } from "@/modules/merchant/api";
import { useCurrentMerchant, useMyAdminProfile } from "@/modules/merchant/context";
// 2026-09-24:updateMyAgentProfile 已經不再 import——update_merchant_agent 補上 p_job_title 之後
// 它能寫的 nickname/job_title 都被涵蓋了,這裡收斂成單一呼叫(那支函式本身依主腦指示先保留不刪)。
import { clearAgentPendingLoginEmail, updateMerchantAgent } from "@/modules/staff-agent/api";
import {
  useCurrentMerchantRole,
  useAgentPermission,
  useMyAgentProfile,
} from "@/modules/staff-agent/context";
import type { MerchantAgent } from "@/modules/staff-agent/types";
import { MyLineBindingCard } from "@/modules/line-notifications/MyLineBindingCard";
import { MyPushSubscriptionCard } from "@/modules/push-notifications/MyPushSubscriptionCard";

import { useAppLayoutContext } from "./AppLayout";
import {
  emailNamePrefix,
  LoginEmailSection,
  PendingAdminLoginEmailSuggestionCard,
} from "./ProfileCardShared";

interface EditProfileDialogProps {
  role: "admin" | "agent";
  merchantId: string;
  /** 這個欄位對 admin 是 merchant_admins.display_name、對 agent 是 merchant_agents.nickname
   * (不是 name)。標籤文字由呼叫端給,兩邊語意不同所以不能寫死。 */
  nameLabel: string;
  currentName: string;
  currentJobTitle: string;
  /** 2026-09-24:電話現在是「管理員與客服都有」的欄位,所以現值由呼叫端統一傳進來
   * (admin 來自 merchant_admins、agent 來自 merchant_agents),元件內不再各自去猜來源。 */
  currentPhone: string;
  /** 2026-09-24 使用者裁決(客服可自行編輯):role === "agent" 時必給——需要 agent.id 才能呼叫
   * update_merchant_agent,也需要 agent.name 當「姓名」欄位的現值。admin 不需要。 */
  agent?: MerchantAgent | null;
  onSaved: () => void;
}

/** 使用者決策(2026-09-23):從舊版 HomePage.tsx 原封不動搬過來——「編輯個人資料」按鈕點擊開啟
 * 的小對話框,儲存後由呼叫端 onSaved() 重新整理卡片顯示的資料。
 * 服務人員版本(EditMyStaffProfileDialog)不在這裡,那個留在 HomePage.tsx 給服務人員自己用。
 *
 * 2026-09-24 使用者裁決(「客服可自行編輯」那一半):客服這邊多開放兩個欄位——姓名
 * (merchant_agents.name)、電話。原本這個對話框只有兩個欄位,而且客服那個「暱稱」欄位寫的是
 * nickname,真正的 name 是邀請時由商家管理員填的,客服自己完全改不到,也沒有任何地方能改電話。
 *
 * 2026-09-24 使用者追加裁決(管理員那一半也要做):原話「我認為需要,因為這會影響到整個系統判斷
 * 這個管理員與集團的關聯或者這個管理員在系統內的資料(以我這個廠商視角)」——使用者是平台方,
 * 要能掌握每位商家管理員的聯絡方式。所以電話現在是「兩種角色都有」的欄位,狀態共用同一組 state,
 * 不再是客服專屬。
 * ⚠️ 但兩邊的「必填/選填」不一樣,不能照抄:
 *     客服(merchant_agents.phone 是 NOT NULL)→ 電話必填
 *     管理員(merchant_admins.phone 是 nullable,既有管理員沒有這個值)→ 選填
 *   選填欄位留空時要送 null(不是空字串),由 handleSubmit 正規化。
 *
 * 2026-09-24 後續裁決:三種「人」的角色(管理員/客服/服務人員)都只保留一個登入 Email,所以原本
 * 這個對話框的「聯絡 Email」欄位(merchant_admins/merchant_agents.contact_email)連同資料庫欄位
 * 一起移除。⚠️ 商家本身對外給消費者看的 merchants.contact_email 是另一回事,不受這次異動影響。 */
function EditProfileDialog({
  role,
  merchantId,
  nameLabel,
  currentName,
  currentJobTitle,
  currentPhone,
  agent,
  onSaved,
}: EditProfileDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(currentName);
  const [jobTitle, setJobTitle] = useState(currentJobTitle);
  // 電話兩種角色共用。agentName 是真正的 merchant_agents.name,跟上面的 name
  // (管理員=display_name、客服=nickname)是不同欄位,刻意用不同變數名避免自己搞混。
  const [phone, setPhone] = useState(currentPhone);
  const [agentName, setAgentName] = useState(agent?.name ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(currentName);
      setJobTitle(currentJobTitle);
      setPhone(currentPhone);
      setAgentName(agent?.name ?? "");
    }
  }, [open, currentName, currentJobTitle, currentPhone, agent]);

  const isAgentRole = role === "agent";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    // 電話用既有的共用函式 isValidTaiwanMobilePhone,跟 AgentListPage.tsx(管理員協助編輯)、
    // StaffListPage.tsx §8.1 同一支,不另外寫一份正規表示式。
    const trimmedPhone = phone.trim();
    if (isAgentRole) {
      if (!agent) {
        toast.error("讀不到你的客服資料,請重新整理頁面再試一次");
        return;
      }
      if (!agentName.trim()) {
        toast.error("請填寫姓名");
        return;
      }
      // merchant_agents.phone 是 NOT NULL 欄位,所以客服的電話必填。
      if (!trimmedPhone) {
        toast.error("請填寫電話");
        return;
      }
      if (!isValidTaiwanMobilePhone(trimmedPhone)) {
        toast.error(TW_MOBILE_PHONE_ERROR_MESSAGE);
        return;
      }
    } else {
      // 管理員:merchant_admins.phone 是 nullable,既有管理員本來就沒有這個值,所以「選填」——
      // 不能照抄客服那邊的必填邏輯,否則既有管理員一打開對話框就被擋著不能存任何東西。
      // 但「有填就要填對」:填了卻格式錯誤還是要擋,不然存進去的是無效號碼,平台方照樣聯絡不到人。
      if (trimmedPhone && !isValidTaiwanMobilePhone(trimmedPhone)) {
        toast.error(TW_MOBILE_PHONE_ERROR_MESSAGE);
        return;
      }
    }

    setSaving(true);
    try {
      if (role === "admin") {
        // ⚠️ update_my_admin_profile 2026-09-24 從 3 參數改成 4 參數(舊重載已 drop;原本一度是
        // 5 參數,contact_email 移除後收斂成 4)。參數順序見 merchant/api.ts 的說明。
        // 選填欄位留空要送 null,不是空字串。
        await updateMyAdminProfile(merchantId, name, jobTitle, trimmedPhone || null);
      } else if (agent) {
        // 2026-09-24:update_merchant_agent 已經補上 p_job_title(舊 5 參數重載已 drop),所以
        // 這裡從原本「兩支 RPC 都呼叫」收斂成單一呼叫——四個欄位現在在同一個 UPDATE 語句裡,
        // 是天然的原子交易,原本那段「新的成功、既有的失敗」的部分儲存錯誤處理已經不需要,一併刪除。
        // update_my_agent_profile 的功能已被完全涵蓋(它能寫的 nickname/job_title 這裡都有),
        // 依主腦指示這次先不刪除那支函式,但呼叫端不再使用它。
        await updateMerchantAgent(agent.id, {
          name: agentName,
          nickname: name,
          jobTitle,
          phone: trimmedPhone,
        });
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
      {/* 手機版:客服版本現在有 4 個欄位,比原本的 2 個高很多,所以補上
          max-h-[90vh] + overflow-y-auto,照 StaffListPage.tsx / AgentListPage.tsx 既有對話框
          同一組寫法,避免在矮螢幕上內容被切掉、儲存按鈕按不到。 */}
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>編輯個人資料</DialogTitle>
          <DialogDescription>只會更新你自己的資料,不會影響到其他人。</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* 窄螢幕單欄、sm 以上兩欄,比照 AgentListPage.tsx 管理員協助編輯客服那個對話框的排法
              ——同一組欄位、兩個入口,版面刻意做成一樣的,使用者不用重新學。 */}
          <div className="grid gap-4 sm:grid-cols-2">
            {/* 2026-09-24 使用者裁決:客服新增「姓名」欄位。放在最前面,因為這是真正的姓名
                (merchant_agents.name),原本只有商家管理員在邀請時填得到,客服自己改不了。 */}
            {isAgentRole ? (
              <div>
                <Label htmlFor="profile-agent-name">姓名 *</Label>
                <Input
                  id="profile-agent-name"
                  className="mt-2"
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  required
                />
              </div>
            ) : null}
            <div>
              <Label htmlFor="profile-name">{nameLabel}</Label>
              <Input
                id="profile-name"
                className="mt-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              {/* 2026-09-24 主腦裁決把顯示 fallback 改成「暱稱 → 姓名 → 登入信箱前半段」之後,
                  這句說明也要跟著改成實際行為——原本寫「留空會顯示登入信箱前半段」現在只在姓名
                  也沒填的時候才成立,照實改寫成「會顯示你的姓名」。 */}
              {isAgentRole ? (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  給客戶看的稱呼,可以跟本名不一樣;留空的話畫面上會顯示你的姓名。
                </p>
              ) : null}
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
            {/* 2026-09-24:電話兩種角色都顯示(管理員那一半是使用者這次追加裁決的)。
                必填與否不同——客服的電話是必填(NOT NULL 欄位),管理員是選填(nullable,
                既有管理員本來就沒填過)。所以星號、required、說明文字都要跟著角色變,不能寫死。 */}
            <div>
              <Label htmlFor="profile-phone">電話{isAgentRole ? " *" : ""}</Label>
              <Input
                id="profile-phone"
                className="mt-2"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0912345678"
                required={isAgentRole}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                請輸入台灣手機號碼,09 開頭共 10 碼數字,例如 0912345678。
                {isAgentRole ? "" : "可以留空,但填了就要填對格式。"}
              </p>
            </div>
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

/** ⚠️ 2026-09-24 使用者指示:「排班一覽這個功能可以先拔掉(隱藏起來),對應的權限開關也要跟著
 * 拔掉(隱藏起來)。」——關鍵字是**隱藏**,不是刪除,所以做成一個開關常數,不是把程式碼刪掉。
 *
 * 這是刻意隱藏,不是遺漏。**要還原就把下面這一行改成 false**,「排班一覽」卡片就會照原本的
 * scheduling 權限判斷(showSchedulingCard)重新出現,不需要改任何其他地方。
 *
 * 一起被隱藏、還原時要一起改回來的地方只有另外一處:
 *   ・src/modules/staff-agent/types.ts 的 AGENT_PERMISSION_SECTIONS 裡 key: "scheduling" 那一項
 *     的 hidden 旗標(客服權限設定頁的開關)。
 *
 * 刻意**沒有**被動到、所以還原時不用處理的東西:
 *   ・路由 /app/scheduling(src/App.tsx)、頁面 src/modules/scheduling/SchedulingOverviewPage.tsx、
 *     RequireSchedulingAccess.tsx、describeScheduleCell 與其測試 —— 全部保留可用。
 *     ⚠️ 路由保留是必要的:src/routes/appLayoutLogic.test.ts 有一條結構性測試會直接讀 App.tsx,
 *        要求每一條 /app/* 路由都有對應的頁首標題,所以 appLayoutLogic.ts 裡
 *        `{ pattern: "/app/scheduling", title: "排班一覽" }` 那一列也必須留著。
 *   ・資料庫裡既有的 scheduling 權限授權紀錄 —— 一列都不動,入口不顯示就沒有副作用,
 *     還原之後原本開通過的客服依然是開通狀態,不用重新授權。 */
const SCHEDULING_FEATURE_HIDDEN = true;

export default function ManagePage() {
  const navigate = useNavigate();
  const { data: merchantRole } = useCurrentMerchantRole();
  const isAdmin = merchantRole === "admin";
  const isAgent = merchantRole === "agent";
  const {
    email,
    newEmail,
    userId,
    isStaffView,
    isViewResolved,
    isDualRoleEligible,
    onToggleStaffView,
  } = useAppLayoutContext();
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
  // 2026-09-24:守衛條件從「角色查詢還在載入中就先不動作」換成共用的 isViewResolved(見
  // AppLayout.tsx / appLayoutLogic.ts)——原本只看角色查詢的載入狀態,漏掉「商家還沒選定」跟
  // 「自己的服務人員紀錄還在查」這兩種也還沒有答案的情況。
  useEffect(() => {
    if (!isViewResolved) return;
    if (isStaffView) {
      navigate("/app", { replace: true });
    }
  }, [isViewResolved, isStaffView, navigate]);

  // 使用者決策(2026-09-23):「首頁」分頁籤拔掉,個人資料卡片(姓名/職位/登入信箱)搬到這裡
  // 最上方,邏輯原封不動搬自舊版 HomePage.tsx(服務人員版本留在 HomePage.tsx,這裡只有
  // 管理員/客服兩種)。
  const adminProfileQuery = useMyAdminProfile(merchantId, userId, isAdmin);
  const agentProfileQuery = useMyAgentProfile(merchantId, userId, isAgent);

  // 2026-09-24 主腦裁決(顯示層 fallback 順序):客服這一段從「暱稱 → 登入信箱前半段」改成
  // 「暱稱 → 姓名 → 登入信箱前半段」。理由:「顯示信箱前半段」本來就是最後不得已的 fallback,
  // 有本名卻跳過去顯示 abc123 沒道理;而且客服這次才剛能自己填姓名,填完如果卡片沒變化,會
  // 誤以為沒存成功。暱稱仍然優先(那是「給人看的稱呼」,本來就該蓋過本名)。
  //
  // ⚠️ 已確認這個改動「只影響客服」,沒有波及其他角色:
  //   ・商家管理員:merchant_admins 這張表只有 display_name,根本沒有 name 欄位,中間沒有值
  //     可以插進來,所以那一段刻意原樣不動(不是漏改)。
  //   ・服務人員:根本不走這裡——ManagePage 對 isStaffView 會直接 navigate 走,服務人員的卡片
  //     在 HomePage.tsx,而且那邊用的是完全不同的格式(「姓名(暱稱)」兩個一起顯示,連
  //     emailNamePrefix 都沒用到),本來就已經看得到本名,不受影響也不需要跟著改。
  const emailPrefix = emailNamePrefix(email);
  const displayName = isAdmin
    ? adminProfileQuery.data?.displayName || emailPrefix
    : isAgent
      ? agentProfileQuery.data?.nickname || agentProfileQuery.data?.name || emailPrefix
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
  // 2026-09-24:電話兩種角色都有,來源不同(管理員來自 merchant_admins、客服來自
  // merchant_agents),在這裡統一成一個變數餵給對話框,元件內不用再判斷來源。
  const rawPhone = isAdmin
    ? (adminProfileQuery.data?.phone ?? "")
    : isAgent
      ? (agentProfileQuery.data?.phone ?? "")
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
  // 「抽成與薪資設定」「服務人員報表」兩張卡片的顯示權限。「店家帳務報表」(billing)2026-09-23
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
      description: "管理服務人員名錄與可承接的服務項目",
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
      // 2026-09-24 使用者指定改名:「假別設定」→「月薪人員假別設定」。要跟 appLayoutLogic.ts 的
      // 頁首標題、LeaveTypesPage.tsx 的 <h1> 三處一致。
      label: "月薪人員假別設定",
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
      // ⚠️ 刻意隱藏(2026-09-24 使用者指示),不是遺漏、也不是權限判斷壞掉:
      //    SCHEDULING_FEATURE_HIDDEN 改成 false 就會還原成原本的 showSchedulingCard 判斷。
      //    完整的還原說明見這個檔案上方 SCHEDULING_FEATURE_HIDDEN 的註解。
      visible: !SCHEDULING_FEATURE_HIDDEN && showSchedulingCard,
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
      // 2026-09-24 使用者指定改名:「師傅報表」→「服務人員報表」。要跟 appLayoutLogic.ts 的
      // /app/staff-report 頁首標題、StaffReportPage.tsx 自己的 <h1> 保持完全一致。
      label: "服務人員報表",
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
            /* 2026-09-24 使用者裁決(客服可自行編輯):agent 這個 prop 讓客服自助編輯姓名/電話
               ——需要自己那一列的 id 與現值。admin 傳 null(那一半這次不動,見元件註解)。 */
            <EditProfileDialog
              role={isAdmin ? "admin" : "agent"}
              merchantId={merchantId}
              nameLabel={isAdmin ? "姓名/暱稱" : "暱稱"}
              currentName={rawName}
              currentJobTitle={rawJobTitle}
              currentPhone={rawPhone}
              agent={isAdmin ? null : (agentProfileQuery.data ?? null)}
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
        /* 2026-09-24 線上故障修正:這個空狀態就是那位雙重身分使用者實際卡住的畫面。原本只有一句
           「目前沒有開放給你的功能,請聯絡商家管理員開通權限。」—— 對一位「同時是這間商家服務人員」
           的人來說,這句話是錯誤的指引(他該做的不是聯絡管理員,而是切換到服務人員端),而對
           「在這間商家只有客服身分、服務人員身分在另一間分店」的人來說,他該做的是先切換商家。
           所以這裡依情境補上實際可以按的出路,不只留一句死路文字。 */
        <div className="space-y-3 rounded-md border border-dashed border-border px-3 py-8 text-center">
          <p className="text-sm text-muted-foreground">
            目前沒有開放給你的功能,請聯絡商家管理員開通權限。
          </p>
          {isDualRoleEligible ? (
            <div className="space-y-2">
              <p className="text-sm text-foreground">
                你同時也是這間商家的<span className="font-semibold">服務人員</span>
                ——你要找的個人資料、行事曆、休假設定與薪資報表都在服務人員端。
              </p>
              <Button type="button" size="sm" onClick={onToggleStaffView}>
                切換到服務人員端
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              如果你是<span className="font-medium">其他分店</span>
              的服務人員,請先用左上角的商家切換器切換到那間商家。
            </p>
          )}
        </div>
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

      {/* 模組 15 擴充 §7.2:管理員/客服的「手機推播通知」卡片,刻意緊接在 LINE 綁定卡片
          後面 —— 服務人員端 HomePage 的順序也是「LINE 綁定 → 手機推播」,兩個頁面一致。
          元件本身依角色判斷是否顯示(不是 admin/agent 時回傳 null)。 */}
      <MyPushSubscriptionCard />
    </div>
  );
}
