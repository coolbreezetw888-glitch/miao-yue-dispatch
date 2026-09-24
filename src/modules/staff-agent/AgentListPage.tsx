// 對應規格書 4.3:客服管理頁(新路由 /app/agents)。
// 清單(姓名/暱稱/email/狀態徽章)+ 新增表單(呼叫 Edge Function)+ 移除按鈕。

import { useEffect, useState, type FormEvent } from "react";
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

import { useCurrentMerchant } from "@/modules/merchant/context";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { isValidTaiwanMobilePhone, TW_MOBILE_PHONE_ERROR_MESSAGE } from "@/lib/validation";

import {
  clearAgentPendingLoginEmail,
  fetchMerchantAgents,
  inviteMerchantAgent,
  removeMerchantAgent,
  requestAgentLoginEmailChange,
  restoreMerchantAgent,
  updateMerchantAgent,
} from "./api";
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
  // 注意:客服這邊刻意「沒有」對應的「真正刪除」按鈕——服務人員那顆是規格書
  // 「服務人員管理優化與硬刪除」§3.4 特別要求的,客服這次的裁決只提到恢復,不自己加碼。
  async function handleRestore(agentId: string) {
    try {
      await restoreMerchantAgent(agentId);
      await refetch();
      toast.success("已恢復這位客服");
    } catch (err) {
      toast.error("恢復失敗", { description: getErrorMessage(err) });
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
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : !agents || agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">目前還沒有任何客服。</p>
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
              {agents.map((agent) => (
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
                      /* 2026-09-24 使用者裁決:已移除的客服補上「恢復」按鈕。做法照抄
                         StaffListPage.tsx 服務人員「恢復」那顆——同樣是 variant="outline"
                         size="sm" 直接觸發、不套確認對話框(恢復是可逆的良性操作,再按一次
                         「移除」就回去了,不像「真正刪除」那種不可逆動作需要 AlertDialog 攔一道)。 */
                      <Button variant="outline" size="sm" onClick={() => handleRestore(agent.id)}>
                        恢復
                      </Button>
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
