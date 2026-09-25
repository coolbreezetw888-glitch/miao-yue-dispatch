// 對應規格書 4.3:客服管理頁(新路由 /app/agents)。
// 清單(姓名/暱稱/email/狀態徽章)+ 新增表單(呼叫 Edge Function)+ 移除按鈕。
// 2026-09-24:補上「編輯」(#789)與「恢復」(#790)。
// 2026-09-25(規格書「客服編輯功能」#797 / #798,使用者裁決「選 A+C」):補上「全部 / 在職 / 已移除」
// 分頁籤,以及已移除那一列旁的「真正刪除」——兩者都照抄 StaffListPage.tsx 服務人員頁的既有做法,
// 使用者不用多學一套操作。

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

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

function statusBadgeVariant(status: AgentStatus): "default" | "secondary" | "destructive" {
  if (status === "active") return "default";
  if (status === "invited") return "secondary";
  return "destructive";
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
    <div className="mt-1 flex flex-wrap items-center gap-2">
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

// 2026-09-24 使用者裁決(客服管理補上「編輯」):使用者裁決原文「客服可自行編輯或管理員可協助
// 編輯。」——這裡是「管理員協助編輯」那一半;「客服自行編輯」那一半在「功能」頁的個人資料卡片
// (ManagePage.tsx 的 EditProfileDialog),兩邊走的是同一支 updateMerchantAgent(),欄位與版面
// 刻意做成一致的,使用者不用重新學。
// 互動方式刻意照抄 StaffListPage.tsx 的 StaffFormDialog 既有模式,不自創一套:
//   ・Dialog + DialogTrigger asChild 包一顆傳進來的 trigger 按鈕。
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
  trigger,
  onSaved,
}: {
  agent: MerchantAgent;
  trigger: React.ReactNode;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(agent.name);
  const [nickname, setNickname] = useState(agent.nickname ?? "");
  const [phone, setPhone] = useState(agent.phone ?? "");
  // 2026-09-24 主腦裁決:職位也開放給管理員協助編輯。原本只是 round-trip 現值(避免被靜默清空),
  // 但這個對話框已經是「管理員幫客服改基本資料」的完整入口,少一個職位欄位反而奇怪。
  const [jobTitle, setJobTitle] = useState(agent.job_title ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(agent.name);
      setNickname(agent.nickname ?? "");
      setPhone(agent.phone ?? "");
      setJobTitle(agent.job_title ?? "");
    }
  }, [open, agent]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
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
      setOpen(false);
      onSaved();
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>編輯客服資料</DialogTitle>
          <DialogDescription>
            這裡只會更新基本資料,不會影響對方的登入帳號——登入信箱要用清單上的「修改登入信箱」
            另外處理,權限要用「權限設定」另外調整。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor={`agent-edit-name-${agent.id}`}>姓名 *</Label>
              <Input
                id={`agent-edit-name-${agent.id}`}
                className="mt-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor={`agent-edit-nickname-${agent.id}`}>暱稱</Label>
              <Input
                id={`agent-edit-nickname-${agent.id}`}
                className="mt-2"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
              />
            </div>
            {/* 2026-09-24 主腦裁決:職位開放給管理員協助編輯。欄位順序跟「功能」頁個人資料卡片的
                對話框一致(姓名 → 暱稱 → 職位 → 電話),兩個入口刻意做成同一組欄位、
                同一個順序,使用者不用重新學。 */}
            <div>
              <Label htmlFor={`agent-edit-job-title-${agent.id}`}>職位</Label>
              <Input
                id={`agent-edit-job-title-${agent.id}`}
                className="mt-2"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor={`agent-edit-phone-${agent.id}`}>電話 *</Label>
              <Input
                id={`agent-edit-phone-${agent.id}`}
                className="mt-2"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0912345678"
                required
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                請輸入台灣手機號碼,09 開頭共 10 碼數字,例如 0912345678。
              </p>
            </div>
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
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">客服管理</h1>
        <p className="mt-1 text-sm text-muted-foreground">「{merchant!.name}」的客服名單與邀請</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>邀請新客服</CardTitle>
          <CardDescription>
            對方會收到一封邀請信,點連結設定密碼後即可登入;如果對方已經有秒約帳號,會直接加為客服。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleInvite} className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="agent-email">Email *</Label>
              <Input
                id="agent-email"
                type="email"
                className="mt-2"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="agent-name">姓名 *</Label>
              <Input
                id="agent-name"
                className="mt-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="agent-nickname">暱稱</Label>
              <Input
                id="agent-nickname"
                className="mt-2"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="agent-phone">電話 *</Label>
              <Input
                id="agent-phone"
                className="mt-2"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0912345678"
                required
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                請輸入台灣手機號碼,09 開頭共 10 碼數字,例如 0912345678。
              </p>
            </div>
            <div className="sm:col-span-2">
              <Button
                type="submit"
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
              ⚠️ 客服只有三顆、沒有服務人員頁的「未上架 / 已上架」——客服沒有 is_listed(#792)。 */}
          {agents && agents.length > 0 ? (
            <Tabs
              value={listFilter}
              onValueChange={(v) => setListFilter(v as AgentListFilter)}
              className="pt-2"
            >
              {/* 手機版面(照抄 StaffListPage.tsx L958-962 的踩坑紀錄):服務人員頁四顆分頁籤在 375px
                  手機上總寬 327px、放不進 285px 的卡片內寬,預設 TabsList 既不換行也不橫向捲動,後面
                  的分頁籤會直接被裁掉看不到。客服雖然只有三顆、比較寬鬆,但規格書 #797 要求「仍然要實測、
                  不要假設放得下」,所以這裡沿用同一組 h-auto + w-full + flex-wrap 解法,並由
                  e2e/agent-management.spec.ts T7 在 375px 實測不溢出。 */}
              <TabsList className="h-auto w-full flex-wrap justify-start gap-1 bg-muted p-1">
                {AGENT_LIST_FILTER_TABS.map((tab) => (
                  <TabsTrigger key={tab.value} value={tab.value}>
                    {tab.label}
                    {tab.value === "all" ? "" : ` (${filterCounts[tab.value]})`}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          ) : null}
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : !agents || agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">目前還沒有任何客服。</p>
          ) : filteredAgents.length === 0 ? (
            <p className="text-sm text-muted-foreground">這個分類目前沒有客服。</p>
          ) : (
            /* 手機版版面(2026-09-24):這一列這次多出「編輯」(所有未移除的客服)跟「恢復」
               (已移除的客服)兩顆按鈕,右側按鈕群組會變成「權限設定 + 編輯 + 移除」三顆。
               StaffListPage.tsx 剛因為同樣的情形踩過坑——右側按鈕群組是 shrink-0,左側資訊區被
               壓到只剩 5px,實際畫面上完全看不到客服叫什麼名字、是什麼狀態。這裡直接沿用那邊
               已驗證過的同一組修法,不重蹈覆轍也不自己發明新寫法:
                 ・窄螢幕改成上下兩段式(資訊一段、按鈕一段):flex-col + sm:flex-row。
                 ・左側資訊區 min-w-0,姓名用 break-words(不是 truncate)——姓名是這一列最重要
                   的資訊,寧可換行多佔一行,也不要把長姓名切掉只剩前半段。
                 ・按鈕群組 flex-wrap(窄螢幕放不下就換行)+ sm:shrink-0(寬螢幕維持原本行為)。
               刻意不在外層補 overflow-x-auto:那只是把「看不到」換成「要左右滑才看得到」。 */
            <ul className="space-y-2">
              {filteredAgents.map((agent) => (
                <li
                  key={agent.id}
                  className="flex flex-col gap-2 rounded-md border border-border px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                >
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-foreground">
                      {agent.name}
                      {agent.nickname ? `(${agent.nickname})` : ""}
                    </p>
                    {/* invited_email 是使用者自己輸入的信箱,長度不固定,break-all 讓它願意在
                        任意字元換行(email 沒有空白可以斷),不會撐開容器。 */}
                    <p className="break-all text-xs text-muted-foreground">{agent.invited_email}</p>
                    {/* 對應規格書(帳號登入安全性優化)2.5.3 第 1 點:已開通登入才顯示登入信箱
                        狀態與修改入口。 */}
                    {agent.status === "active" ? <AgentLoginEmailManagement agent={agent} /> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                    <Badge variant={statusBadgeVariant(agent.status as AgentStatus)}>
                      {AGENT_STATUS_LABELS[agent.status as AgentStatus]}
                    </Badge>
                    {agent.status !== "removed" ? (
                      <>
                        <Button variant="outline" size="sm" asChild>
                          <Link to={`/app/agents/${agent.id}/permissions`}>權限設定</Link>
                        </Button>
                        {/* 2026-09-24 使用者裁決:「編輯」按鈕。放在「權限設定」跟「移除」之間,
                            順序比照 StaffListPage.tsx(其他入口 → 編輯 → 移除)。 */}
                        <AgentFormDialog
                          agent={agent}
                          trigger={
                            <Button variant="outline" size="sm">
                              編輯
                            </Button>
                          }
                          onSaved={refetch}
                        />
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="outline" size="sm" disabled={removingId === agent.id}>
                              移除
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>確定要移除這位客服嗎?</AlertDialogTitle>
                              <AlertDialogDescription>
                                移除後對方無法再看到這間店的任何資料,但對方的秒約帳號本身不受影響,
                                資料採軟刪除,之後仍可查詢紀錄。
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction onClick={() => handleRemove(agent.id)}>
                                確定移除
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </>
                    ) : (
                      <>
                        {/* 2026-09-24 使用者裁決:已移除的客服補上「恢復」按鈕。做法照抄
                            StaffListPage.tsx 服務人員「恢復」那顆——同樣是 variant="outline"
                            size="sm" 直接觸發、不套確認對話框(恢復是可逆的良性操作,再按一次
                            「移除」就回去了,不像「真正刪除」那種不可逆動作需要 AlertDialog 攔一道)。 */}
                        <Button variant="outline" size="sm" onClick={() => handleRestore(agent.id)}>
                          恢復
                        </Button>
                        {/* #798(2026-09-25 使用者裁決「選 A+C」):「真正刪除」只在「已移除」狀態旁顯示,
                            用 variant="destructive" 讓視覺上明顯跟「恢復」不同,避免手滑點錯;
                            按鈕、對話框、確認文案的嚴謹度全部照抄 StaffListPage.tsx 服務人員那顆。
                            這一頁整頁走 RequireMerchantAdmin,所以不需要像服務人員頁再判斷 isAdmin
                            (那頁對有「服務人員管理」權限的客服也開放,客服管理頁沒有這種情況);
                            底層 hard_delete_merchant_agent 仍然自己檢查 is_merchant_admin。 */}
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={hardDeletingId === agent.id}
                            >
                              真正刪除
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>確定要真正刪除「{agent.name}」嗎?</AlertDialogTitle>
                              <AlertDialogDescription>
                                這個動作無法復原!這位客服的紀錄與權限設定會被徹底刪除,之後在名單上
                                再也找不到,也無法用「恢復」救回。對方的秒約帳號本身不受影響,同一個
                                Email 之後仍然可以重新邀請。只有在確定不再需要這筆資料(例如邀請時
                                Email 打錯字、對方永遠不會來註冊)時才使用;若只是暫時停用,請維持
                                「已移除」狀態即可。
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleHardDelete(agent.id)}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              >
                                確定真正刪除
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
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
