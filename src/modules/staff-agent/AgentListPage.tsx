// 對應規格書 4.3:客服管理頁(新路由 /app/agents)。
// 清單(姓名/暱稱/email/狀態徽章)+ 新增表單(呼叫 Edge Function)+ 移除按鈕。
// 2026-09-24:補上「編輯」(#789)與「恢復」(#790)。
// 2026-09-25(規格書「客服編輯功能」#797 / #798,使用者裁決「選 A+C」):補上「全部 / 在職 / 已移除」
// 分頁籤,以及已移除那一列旁的「真正刪除」——兩者都照抄 StaffListPage.tsx 服務人員頁的既有做法,
// 使用者不用多學一套操作。
//
// ui-v1-full 第二階段第 1 批(2026-09-29,盤點 Q2 / #7 / #8):
//   - 「編輯客服資料」(4 欄,使用者已裁決歸小卡窗)改用 CardDialog,欄位單欄直排。
//   - 「移除」「真正刪除」兩個確認窗改用 CardAlertDialog(確認鈕白底紅字)。
//   - 客服列改成 ListCard:右側只放「一顆主要動作(編輯 / 恢復)+ 一個 ⋯」,權限設定、移除、
//     真正刪除收進 ⋯。因為觸發點變成選單項目,三個對話框改成受控開關,
//     整頁各只有一顆實例,不再每一列各包一顆 Trigger。
//   - 篩選分頁籤改成底線式(UnderlineTabs,skill 二之四末段)、邀請表單欄位改用 FormField、
//     頁首改 PageHeader、載入中改骨架、空狀態補說明(skill 二之八)。
// ui-v1-full 第二階段回填(2026-09-29 主腦裁決):「移除」可逆 ⇒ ⋯ 一般項目不標紅,只有「真正刪除」
//   紅字;「權限設定」改成真正的連結(ListCard menuItems 的 `to`);空狀態拿掉「聚焦上方欄位」的
//   按鈕 hack,改成一句話指路(邀請表單就在正上方,skill 二之八的例外,見 EmptyState 註解)。
// **只動外觀與版面,不動任何行為**:驗證、送出、移除 / 恢復 / 真正刪除、篩選邏輯全部照舊。

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  CardAlertDialog,
  CardAlertDialogAction,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
  CardDialog,
  CardDialogClose,
  CardDialogContent,
  CardDialogDescription,
  CardDialogFooter,
  CardDialogHeader,
  CardDialogTitle,
  EmptyState,
  FieldInput,
  FormField,
  ListCard,
  LoadingSkeleton,
  PageHeader,
  StatusTag,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { isValidTaiwanMobilePhone, TW_MOBILE_PHONE_ERROR_MESSAGE } from "@/lib/validation";

import {
  clearAgentPendingLoginEmail,
  fetchMerchantAgents,
  hardDeleteMerchantAgent,
  inviteMerchantAgent,
  removeMerchantAgent,
  requestAgentLoginEmailChange,
  restoreMerchantAgent,
  updateMerchantAgent,
} from "./api";
import {
  AGENT_LIST_FILTER_TABS,
  countAgentsByFilter,
  matchesAgentListFilter,
  type AgentListFilter,
} from "./agentListLogic";
import { AdminSuggestLoginEmailDialog, LoginEmailStatusDisplay } from "./AdminLoginEmailManager";
import { useAgentLoginEmailStatus } from "./context";
import { RequireMerchantAdmin } from "./RequireMerchantAdmin";
import { AGENT_STATUS_LABELS, type AgentStatus, type MerchantAgent } from "./types";

const agentListQueryKey = (merchantId: string) =>
  ["staff-agent-module", "agent-admin-list", merchantId] as const;

// skill 二之四 狀態標籤配色:正常 = 綠 / 要處理(等對方設密碼)= 黃 / 已移除 = 紅。
function agentStatusTone(status: AgentStatus): "success" | "warning" | "danger" {
  if (status === "active") return "success";
  if (status === "invited") return "warning";
  return "danger";
}

// 對應規格書(帳號登入安全性優化)2.5.3:已開通登入(status='active')的客服旁,顯示目前
// 登入信箱狀態(2.4.3)+「修改登入信箱」入口(2.4.1/2.4.2),設計理由完全比照
// StaffListPage.tsx 的 StaffLoginEmailManagement。
function AgentLoginEmailManagement({ agent }: { agent: MerchantAgent }) {
  const queryClient = useQueryClient();
  const statusQuery = useAgentLoginEmailStatus(agent.id, true);
  const statusQueryKey = ["staff-agent-module", "agent-login-email-status", agent.id] as const;

  async function refetchStatus() {
    await queryClient.invalidateQueries({ queryKey: statusQueryKey });
  }

  async function handleSubmit(newEmail: string) {
    await requestAgentLoginEmailChange(agent.id, newEmail);
    await refetchStatus();
  }

  async function handleWithdraw() {
    await clearAgentPendingLoginEmail(agent.id);
    await refetchStatus();
  }

  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <LoginEmailStatusDisplay statusQuery={statusQuery} />
      <AdminSuggestLoginEmailDialog
        personLabel={agent.name}
        currentSuggestion={statusQuery.data?.pendingAdminSuggestedEmail}
        onSubmit={handleSubmit}
        onWithdraw={handleWithdraw}
      />
    </div>
  );
}

const AGENT_FORM_ID = "agent-edit-form";

// 2026-09-24 使用者裁決(客服管理補上「編輯」):使用者裁決原文「客服可自行編輯或管理員可協助
// 編輯。」——這裡是「管理員協助編輯」那一半;「客服自行編輯」那一半在「功能」頁的個人資料卡片
// (ManagePage.tsx 的 EditProfileDialog),兩邊走的是同一支 updateMerchantAgent(),欄位與版面
// 刻意做成一致的,使用者不用重新學。
// 互動方式刻意照抄 StaffListPage.tsx 的 StaffFormDialog 既有模式,不自創一套:
//   ・受控的 open / onOpenChange(ui-v1-full 起改由清單頁持有開關,因為觸發點是卡片按鈕)。
//   ・useState 存整份表單、useEffect 在 open 變 true 時從最新的 agent 重新灌值(避免關掉再打開
//     還留著上次沒送出的編輯內容,也避免清單重新抓回來後對話框停在舊值)。
//   ・送出前先做前端驗證,失敗一律用 toast.error,不擋在 HTML required 上。
//   ・錯誤訊息一律走 getErrorMessage(err),不用 err instanceof Error。
// 開放的欄位就是資料庫函式 update_merchant_agent 開放的那四個:姓名/暱稱/職位/電話。
// 刻意「不」放 invited_email(邀請/登入用的信箱)——那是另一條有驗證流程的路徑
// (AgentLoginEmailManagement 的「修改登入信箱」),混在一起會讓管理員以為改這裡就換了登入帳號。
// ⚠️ 2026-09-24 使用者裁決:原本這裡還有一個「聯絡 Email」欄位(merchant_agents.contact_email),
//    連同欄位本身一起廢除了(migration 20260924040800)。原話:
//      「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的信箱)」
//      「A,客服和服務人員應該也是一樣只需要一個 Email 即可。」
//    客服唯一的 Email 就是登入信箱,改它請走清單上的「修改登入信箱」。不要把欄位加回來。
function AgentFormDialog({
  agent,
  open,
  onOpenChange,
  onSaved,
}: {
  agent: MerchantAgent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(agent?.name ?? "");
  const [nickname, setNickname] = useState(agent?.nickname ?? "");
  const [phone, setPhone] = useState(agent?.phone ?? "");
  // 2026-09-24 主腦裁決:職位也開放給管理員協助編輯。原本只是 round-trip 現值(避免被靜默清空),
  // 但這個對話框已經是「管理員幫客服改基本資料」的完整入口,少一個職位欄位反而奇怪。
  const [jobTitle, setJobTitle] = useState(agent?.job_title ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && agent) {
      setName(agent.name);
      setNickname(agent.nickname ?? "");
      setPhone(agent.phone ?? "");
      setJobTitle(agent.job_title ?? "");
    }
  }, [open, agent]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!agent) return;
    if (!name.trim()) {
      toast.error("請填寫姓名");
      return;
    }
    // 電話驗證複用 §8.3 的共用函式(跟這頁上方的邀請表單、StaffListPage.tsx §8.1 同一支),
    // 不另外寫一份正規表示式。merchant_agents.phone 是 NOT NULL 欄位,所以維持必填。
    const trimmedPhone = phone.trim();
    if (!trimmedPhone) {
      toast.error("請填寫電話");
      return;
    }
    if (!isValidTaiwanMobilePhone(trimmedPhone)) {
      toast.error(TW_MOBILE_PHONE_ERROR_MESSAGE);
      return;
    }
    setSaving(true);
    try {
      await updateMerchantAgent(agent.id, {
        name,
        nickname,
        phone: trimmedPhone,
        // 2026-09-24:update_merchant_agent 是整列覆蓋,job_title 每次都會被寫入。這裡送的是
        // 對話框裡的值(主腦裁決後已開放編輯),不再是原值 round-trip。
        jobTitle,
      });
      toast.success("客服資料已更新");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <CardDialog open={open} onOpenChange={onOpenChange}>
      <CardDialogContent>
        <CardDialogHeader>
          <CardDialogTitle>編輯客服資料</CardDialogTitle>
          <CardDialogDescription>
            這裡只會更新基本資料,不會影響對方的登入帳號——登入信箱要用清單上的「修改登入信箱」
            另外處理,權限要用「權限設定」另外調整。
          </CardDialogDescription>
        </CardDialogHeader>
        {/* 底部按鈕列在 <form> 外面(小卡窗的 Footer 是獨立區塊),儲存鈕用 form 屬性指回這張表單。 */}
        <form id={AGENT_FORM_ID} onSubmit={handleSubmit} className="flex flex-col gap-4">
          <FormField label="姓名" htmlFor="agent-edit-name" required>
            <FieldInput
              id="agent-edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </FormField>
          <FormField label="暱稱" htmlFor="agent-edit-nickname">
            <FieldInput
              id="agent-edit-nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
            />
          </FormField>
          {/* 2026-09-24 主腦裁決:職位開放給管理員協助編輯。欄位順序跟「功能」頁個人資料卡片的
              對話框一致(姓名 → 暱稱 → 職位 → 電話),兩個入口刻意做成同一組欄位、
              同一個順序,使用者不用重新學。 */}
          <FormField label="職位" htmlFor="agent-edit-job-title">
            <FieldInput
              id="agent-edit-job-title"
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
            />
          </FormField>
          <FormField
            label="電話"
            htmlFor="agent-edit-phone"
            required
            helpLabel="說明:電話要怎麼填"
            help="請輸入台灣手機號碼,09 開頭共 10 碼數字,例如 0912345678。"
          >
            <FieldInput
              id="agent-edit-phone"
              type="tel"
              inputMode="numeric"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="0912345678"
              required
            />
          </FormField>
          {/* ⚠️ 這裡原本有一個「聯絡 Email」欄位(merchant_agents.contact_email),
              2026-09-24 使用者裁決連同欄位本身一起廢除(見本檔上方 AgentFormDialog 的註解)。
              客服唯一的 Email 就是登入信箱,要改請用清單上的「修改登入信箱」。
              (2026-09-21 使用者人工測試回報的問題 2「這個欄位容易被誤會成登入帳號」,
               這次是用「拿掉那個欄位」根本解決。)不要加回來。 */}
          {/* ⚠️ 規格書「客服編輯功能」#792(2026-09-25 裁決):這個表單刻意**沒有**「是否上架」開關,
              也**沒有**「狀態」欄位,不要加。
              ・客服沒有「上架」這個概念:merchant_agents 根本沒有 is_listed 欄位(服務人員才有),
                客服是內勤角色、不會被客戶挑選,做出來是純裝飾。
              ・status(邀請信已寄出 / 已啟用 / 已移除)是登入開通進度,由邀請流程與
                mark_agent_active_if_self() 自動推進;做成手動開關會讓管理員把從沒登入過的人標成
                「已啟用」,那個人之後真的去設密碼時 mark_agent_active_if_self()(只撈 invited)
                撈不到他,會永遠卡在錯誤狀態。要改狀態請用清單上的「移除 / 恢復」。 */}
        </form>
        <CardDialogFooter>
          <CardDialogClose asChild>
            <Button type="button" variant="neutral" size="touch">
              取消
            </Button>
          </CardDialogClose>
          <Button
            type="submit"
            form={AGENT_FORM_ID}
            variant="primary"
            size="touch"
            disabled={saving}
          >
            {saving ? "儲存中⋯" : "儲存"}
          </Button>
        </CardDialogFooter>
      </CardDialogContent>
    </CardDialog>
  );
}

function AgentListInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();

  const { data: agents, isLoading } = useQuery({
    queryKey: agentListQueryKey(merchantId),
    queryFn: () => fetchMerchantAgents(merchantId),
  });

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [nickname, setNickname] = useState("");
  const [phone, setPhone] = useState("");
  const [inviting, setInviting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [hardDeletingId, setHardDeletingId] = useState<string | null>(null);

  // ui-v1-full:三個對話框的受控開關(觸發點在 ListCard 的按鈕 / ⋯ 選單裡)。編輯用「記住是哪一位 +
  // 開關」兩個 state,關閉時只關開關、不清掉人,避免關閉動畫期間表單閃成空白。
  const [editingAgent, setEditingAgent] = useState<MerchantAgent | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [removingAgent, setRemovingAgent] = useState<MerchantAgent | null>(null);
  const [hardDeletingAgent, setHardDeletingAgent] = useState<MerchantAgent | null>(null);

  // #797:名單狀態篩選(全部 / 在職 / 已移除)。篩選與計數邏輯在 agentListLogic.ts(有 Vitest),
  // 這裡只負責接上 UI,做法比照 StaffListPage.tsx 的 listFilter / filterCounts / filteredStaffList。
  const [listFilter, setListFilter] = useState<AgentListFilter>("all");
  const filterCounts = useMemo(() => countAgentsByFilter(agents ?? []), [agents]);
  const filteredAgents = useMemo(
    () => (agents ?? []).filter((agent) => matchesAgentListFilter(agent, listFilter)),
    [agents, listFilter],
  );

  function refetch() {
    return queryClient.invalidateQueries({ queryKey: agentListQueryKey(merchantId) });
  }

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !name.trim()) return;
    // 規格書 §8.2:電話這次改為必填,格式驗證邏輯直接複用 §8.3 的共用函式,
    // 不另外在這裡寫一份正規表示式(跟 StaffListPage.tsx §8.1 共用同一支 isValidTaiwanMobilePhone)。
    const trimmedPhone = phone.trim();
    if (!trimmedPhone) {
      toast.error("請填寫電話");
      return;
    }
    if (!isValidTaiwanMobilePhone(trimmedPhone)) {
      toast.error(TW_MOBILE_PHONE_ERROR_MESSAGE);
      return;
    }
    setInviting(true);
    try {
      const result = await inviteMerchantAgent({ merchantId, email, name, nickname, phone });
      await refetch();
      setEmail("");
      setName("");
      setNickname("");
      setPhone("");
      if (result.alreadyHadAccount) {
        toast.success("已加為客服", {
          description: "這個 email 已經有秒約帳號,已直接加為客服,對方下次登入就能看到這間店。",
        });
      } else {
        toast.success("邀請信已寄出", {
          description: "請提醒對方檢查信箱(含垃圾郵件夾),點連結設定密碼後即可登入。",
        });
      }
    } catch (err) {
      toast.error("邀請失敗", { description: getErrorMessage(err) });
    } finally {
      setInviting(false);
    }
  }

  async function handleRemove(agentId: string) {
    setRemovingId(agentId);
    try {
      await removeMerchantAgent(agentId);
      await refetch();
      toast.success("已移除客服");
    } catch (err) {
      toast.error("移除失敗", { description: getErrorMessage(err) });
    } finally {
      setRemovingId(null);
    }
  }

  // 2026-09-24 使用者裁決(客服管理補上「恢復」):使用者原文「重新啟用…指的應該是移除後
  // [恢復/真正刪除]按鈕的恢復對吧?如果是的話那就要增加恢復按鈕。」「要做。」
  // 按鈕文字與 toast 用語刻意跟 StaffListPage.tsx 服務人員那邊的「恢復」對齊(那邊的 toast 是
  // 「已重新上架這位服務人員」,客服沒有「上架」這個概念,所以這裡講「已恢復這位客服」)。
  async function handleRestore(agentId: string) {
    try {
      await restoreMerchantAgent(agentId);
      await refetch();
      toast.success("已恢復這位客服");
    } catch (err) {
      toast.error("恢復失敗", { description: getErrorMessage(err) });
    }
  }

  // #798(2026-09-25 使用者裁決「選 A+C」):「真正刪除」。2026-09-24 這裡原本刻意沒有做(當時的裁決
  // 只點名「恢復」,不自己加碼),後來查出「邀請信 Email 打錯字 → 那一列永遠停在邀請中 → 移除也只是
  // 軟移除 → 名單上永遠掛著一筆清不掉的幽靈資料」這個會真的發生的後果,使用者裁決補上。
  // 做法完全照抄 StaffListPage.tsx 的 handleHardDelete:toast 用語、錯誤顯示都一致。
  // 權限檢查(只有商家管理員、而且必須先軟移除)在資料庫函式 hard_delete_merchant_agent 裡,
  // 這一頁整頁走 RequireMerchantAdmin 只是體驗上不讓非管理員看到入口,不是安全邊界。
  async function handleHardDelete(agentId: string) {
    setHardDeletingId(agentId);
    try {
      await hardDeleteMerchantAgent(agentId);
      await refetch();
      toast.success("已真正刪除");
    } catch (err) {
      toast.error("無法真正刪除", { description: getErrorMessage(err) });
    } finally {
      setHardDeletingId(null);
    }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-12">
      <PageHeader
        backTo="/app/manage"
        helpMode
        title="客服管理"
        description={`「${merchant!.name}」的客服名單、邀請、權限設定。`}
      />

      <Card>
        <CardHeader>
          <CardTitle>邀請新客服</CardTitle>
          <CardDescription>
            對方會收到一封邀請信,點連結設定密碼後即可登入;如果對方已經有秒約帳號,會直接加為客服。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleInvite} className="grid gap-4 sm:grid-cols-2">
            <FormField label="Email" htmlFor="agent-email" required>
              <FieldInput
                id="agent-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </FormField>
            <FormField label="姓名" htmlFor="agent-name" required>
              <FieldInput
                id="agent-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </FormField>
            <FormField label="暱稱" htmlFor="agent-nickname">
              <FieldInput
                id="agent-nickname"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
              />
            </FormField>
            <FormField
              label="電話"
              htmlFor="agent-phone"
              required
              helpLabel="說明:電話要怎麼填"
              help="請輸入台灣手機號碼,09 開頭共 10 碼數字,例如 0912345678。"
            >
              <FieldInput
                id="agent-phone"
                type="tel"
                inputMode="numeric"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0912345678"
                required
              />
            </FormField>
            <div className="sm:col-span-2">
              <Button
                type="submit"
                variant="primary"
                size="touch"
                className="w-full sm:w-auto"
                disabled={inviting || !email.trim() || !name.trim() || !phone.trim()}
              >
                {inviting ? "送出中⋯" : "送出邀請"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>客服名單</CardTitle>
          <CardDescription>包含在職與已移除的客服,可用下方分類篩選</CardDescription>
          {/* #797:三顆分頁籤「全部 / 在職 (n) / 已移除 (n)」。只有名單非空才顯示(比照服務人員頁),
              空名單顯示分頁籤沒有意義。
              ⚠️ 客服只有三顆、沒有服務人員頁的「未上架 / 已上架」——客服沒有 is_listed(#792)。
              ui-v1-full:改成底線式切換列(skill 二之四),數量用 count 顯示在文字後面。
              🔴 variant="filter":篩選列必須一眼全部看到,不橫向捲、不換行、不截字(2026-09-29 使用者裁決)。 */}
          {agents && agents.length > 0 ? (
            <Tabs
              value={listFilter}
              onValueChange={(v) => setListFilter(v as AgentListFilter)}
              className="pt-2"
            >
              <UnderlineTabsList variant="filter">
                {AGENT_LIST_FILTER_TABS.map((tab) => (
                  <UnderlineTabsTrigger
                    key={tab.value}
                    value={tab.value}
                    count={tab.value === "all" ? undefined : filterCounts[tab.value]}
                  >
                    {tab.label}
                  </UnderlineTabsTrigger>
                ))}
              </UnderlineTabsList>
            </Tabs>
          ) : null}
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingSkeleton variant="cards" rows={3} />
          ) : !agents || agents.length === 0 ? (
            // skill 二之八的例外(見 EmptyState 元件註解):下一步(邀請表單)就在這個空狀態正上方、
            // 一眼看得到,所以不做按鈕、用一句話指路就夠了。
            <EmptyState
              title="還沒有任何客服"
              description="邀請客服加入後,可以指派權限,讓他們協助建單、管理會員等日常工作。用上方的邀請表單新增第一位客服。"
            />
          ) : filteredAgents.length === 0 ? (
            <p className="text-sm text-muted-foreground">這個分類目前沒有客服。</p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {filteredAgents.map((agent) => {
                const status = agent.status as AgentStatus;
                const isRemoved = status === "removed";
                return (
                  <li key={agent.id}>
                    {/* skill 二之五 列表卡片:姓名 + 狀態標籤 → 次要資訊(email、登入信箱狀態)→
                        右側「一顆主要動作 + ⋯」。已移除整張變灰。主要動作隨狀態換字(編輯 / 恢復),
                        位置固定;權限設定、移除、真正刪除收進 ⋯。
                        2026-09-29 主腦裁決:「移除」是可逆的(有「恢復」)⇒ 一般項目不標紅,只有不可逆的
                        「真正刪除」才紅字;「權限設定」是跳頁 ⇒ 用 `to`(真正的連結,可右鍵開新分頁)。 */}
                    <ListCard
                      state={isRemoved ? "inactive" : "default"}
                      title={
                        <>
                          {agent.name}
                          {agent.nickname ? `(${agent.nickname})` : ""}
                        </>
                      }
                      tags={
                        <StatusTag tone={agentStatusTone(status)}>
                          {AGENT_STATUS_LABELS[status]}
                        </StatusTag>
                      }
                      meta={
                        <>
                          {/* invited_email 是使用者自己輸入的信箱,長度不固定,break-all 讓它願意在
                              任意字元換行(email 沒有空白可以斷),不會撐開容器。 */}
                          <p className="break-all">{agent.invited_email}</p>
                          {/* 對應規格書(帳號登入安全性優化)2.5.3 第 1 點:已開通登入才顯示登入信箱
                              狀態與修改入口。 */}
                          {status === "active" ? <AgentLoginEmailManagement agent={agent} /> : null}
                        </>
                      }
                      primaryAction={
                        isRemoved ? (
                          // 2026-09-24 使用者裁決:已移除的客服補上「恢復」按鈕。直接觸發、不套確認
                          // 對話框(恢復是可逆的良性操作,再按一次「移除」就回去了,不像「真正刪除」
                          // 那種不可逆動作需要確認窗攔一道)。
                          <Button
                            type="button"
                            variant="neutral"
                            size="card"
                            onClick={() => handleRestore(agent.id)}
                          >
                            恢復
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="neutral"
                            size="card"
                            onClick={() => {
                              setEditingAgent(agent);
                              setEditOpen(true);
                            }}
                          >
                            編輯
                          </Button>
                        )
                      }
                      menuItems={
                        isRemoved
                          ? [
                              // #798:「真正刪除」只在「已移除」狀態出現(兩段式防呆)。
                              {
                                label: "真正刪除",
                                danger: true,
                                disabled: hardDeletingId === agent.id,
                                onSelect: () => setHardDeletingAgent(agent),
                              },
                            ]
                          : [
                              { label: "權限設定", to: `/app/agents/${agent.id}/permissions` },
                              {
                                label: "移除",
                                disabled: removingId === agent.id,
                                onSelect: () => setRemovingAgent(agent),
                              },
                            ]
                      }
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <AgentFormDialog
        agent={editingAgent}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={refetch}
      />

      {/* 盤點 #7:移除(軟刪除)確認 → 小卡窗純確認版。 */}
      <CardAlertDialog
        open={removingAgent !== null}
        onOpenChange={(open) => {
          if (!open) setRemovingAgent(null);
        }}
      >
        <CardAlertDialogContent>
          <CardAlertDialogHeader>
            <CardAlertDialogTitle>確定要移除這位客服嗎?</CardAlertDialogTitle>
            <CardAlertDialogDescription>
              移除後對方無法再看到這間店的任何資料,但對方的秒約帳號本身不受影響,
              資料採軟刪除,之後仍可查詢紀錄。
            </CardAlertDialogDescription>
          </CardAlertDialogHeader>
          <CardAlertDialogFooter>
            <CardAlertDialogCancel>取消</CardAlertDialogCancel>
            <CardAlertDialogAction
              tone="danger"
              onClick={() => {
                if (removingAgent) void handleRemove(removingAgent.id);
              }}
            >
              確定移除
            </CardAlertDialogAction>
          </CardAlertDialogFooter>
        </CardAlertDialogContent>
      </CardAlertDialog>

      {/* 盤點 #8:真正刪除(不可逆)確認 → 小卡窗純確認版,文案照舊。 */}
      <CardAlertDialog
        open={hardDeletingAgent !== null}
        onOpenChange={(open) => {
          if (!open) setHardDeletingAgent(null);
        }}
      >
        <CardAlertDialogContent>
          <CardAlertDialogHeader>
            <CardAlertDialogTitle className="break-words">
              確定要真正刪除「{hardDeletingAgent?.name}」嗎?
            </CardAlertDialogTitle>
            <CardAlertDialogDescription>
              這個動作無法復原!這位客服的紀錄與權限設定會被徹底刪除,之後在名單上
              再也找不到,也無法用「恢復」救回。對方的秒約帳號本身不受影響,同一個 Email
              之後仍然可以重新邀請。只有在確定不再需要這筆資料(例如邀請時 Email
              打錯字、對方永遠不會來註冊)時才使用;若只是暫時停用,請維持 「已移除」狀態即可。
            </CardAlertDialogDescription>
          </CardAlertDialogHeader>
          <CardAlertDialogFooter>
            <CardAlertDialogCancel>取消</CardAlertDialogCancel>
            <CardAlertDialogAction
              tone="danger"
              onClick={() => {
                if (hardDeletingAgent) void handleHardDelete(hardDeletingAgent.id);
              }}
            >
              確定真正刪除
            </CardAlertDialogAction>
          </CardAlertDialogFooter>
        </CardAlertDialogContent>
      </CardAlertDialog>
    </main>
  );
}

export default function AgentListPage() {
  return (
    <RequireMerchantAdmin>
      <AgentListInner />
    </RequireMerchantAdmin>
  );
}
