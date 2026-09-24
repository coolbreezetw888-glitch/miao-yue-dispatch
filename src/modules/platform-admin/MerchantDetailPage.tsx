// 對應規格書 4.4(商家詳情頁)、4.5(集團管理者設定區塊)。
// 管理員名單沿用模組 1 現成的 useMerchantAdmins(見規則 2.3:查詢邏輯不重工)。
// industry_type 這裡維持唯讀顯示(要改請到商家自己的商家設定頁)——2026-09-23 起規則 2.1
// (建立後鎖定)已被使用者推翻,industry_type 可隨時切換,這裡單純沒有另外做一份編輯控制項,
// 不是資料庫層還鎖著。

import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import { disableMerchant, enableMerchant, updateMerchantSettings } from "@/modules/merchant/api";
import { adminDisplayName, adminJobTitle, adminPhone } from "@/modules/merchant/adminDisplay";
import { useMerchantAdmins } from "@/modules/merchant/context";
import { INDUSTRY_TYPE_LABELS } from "@/modules/merchant/types";
import type { IndustryType } from "@/modules/merchant/types";
// 規則 6:所有中文標籤都從既有常數 import,不要在這個檔案裡再寫死一次字串。
// 用語的「家」在模組 3(merchant_staff / merchant_agents 這兩張表屬於模組 3),
// platform-admin 本來就已經在 import @/modules/merchant/*,再 import
// @/modules/staff-agent/types(純型別/常數,不含 React 也不含 supabase client)方向一致。
import {
  AGENT_STATUS_LABELS,
  STAFF_COMPENSATION_TYPE_LABELS,
  STAFF_LOGIN_STATUS_LABELS,
  type AgentStatus,
  type StaffCompensationType,
  type StaffLoginStatus,
} from "@/modules/staff-agent/types";

import {
  platformAddMerchantAdmin,
  platformFetchGroupById,
  platformFetchMerchantAgents,
  platformFetchMerchantById,
  platformFetchMerchantStaff,
  platformGetUserEmail,
  platformRemoveMerchantAdmin,
  platformSetGroupAdmin,
} from "./api";
import { getErrorMessage } from "./getErrorMessage";
import { agentJobTitle, personDisplayName, personLoginEmail } from "./personDisplay";
import { PlatformAdminShell } from "./PlatformAdminShell";

const ALL_MERCHANTS_QUERY_KEY = ["platform-admin", "all-merchants"] as const;
const merchantQueryKey = (id: string) => ["platform-admin", "merchant", id] as const;
const groupQueryKey = (id: string) => ["platform-admin", "group", id] as const;
const userEmailQueryKey = (id: string) => ["platform-admin", "user-email", id] as const;
const merchantAdminsQueryKey = (merchantId: string) =>
  ["merchant-module", "merchant-admins", merchantId] as const;
// 規格書「超級管理員商家詳情強化」#702/#703:兩張唯讀名單卡片的 queryKey,
// 沿用這個檔案既有的 ["platform-admin", …] 前綴命名慣例。
const merchantStaffQueryKey = (merchantId: string) =>
  ["platform-admin", "merchant-staff", merchantId] as const;
const merchantAgentsQueryKey = (merchantId: string) =>
  ["platform-admin", "merchant-agents", merchantId] as const;

/** 客服狀態徽章的顏色,規則完全比照 AgentListPage.tsx 既有的 statusBadgeVariant()。
 *  刻意在這裡複製一份三行的規則、而不是從 AgentListPage.tsx import:那個檔案是一整頁
 *  商家端畫面(帶著表單、dialog、mutation),平台端只為了一個 variant 去 import 它,
 *  會把整頁的相依一起拉進這個 bundle。 */
function agentStatusBadgeVariant(status: string): "default" | "secondary" | "destructive" {
  if (status === "active") return "default";
  if (status === "invited") return "secondary";
  return "destructive";
}

/** #704 第 3 點:卡片底部的人數統計。removedCount === 0 時不顯示括號那一段。
 *  total === 0 時回傳 null,由呼叫端改走 #705 的空清單文案。 */
function personCountSummary(total: number, removedCount: number): string | null {
  if (total === 0) return null;
  return removedCount > 0 ? `共 ${total} 位(其中 ${removedCount} 位已移除)` : `共 ${total} 位`;
}

export default function MerchantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const {
    data: merchant,
    isLoading: merchantLoading,
    error: merchantError,
  } = useQuery({
    queryKey: merchantQueryKey(id ?? ""),
    queryFn: () => platformFetchMerchantById(id as string),
    enabled: Boolean(id),
  });

  const { data: group, isLoading: groupLoading } = useQuery({
    queryKey: groupQueryKey(merchant?.group_id ?? ""),
    queryFn: () => platformFetchGroupById(merchant!.group_id),
    enabled: Boolean(merchant?.group_id),
  });

  const { data: groupAdminEmail } = useQuery({
    queryKey: userEmailQueryKey(group?.group_admin_user_id ?? ""),
    queryFn: () => platformGetUserEmail(group!.group_admin_user_id as string),
    enabled: Boolean(group?.group_admin_user_id),
  });

  const { data: admins, isLoading: adminsLoading } = useMerchantAdmins(id);

  // #702/#703:兩張唯讀名單。`enabled: Boolean(id)` 避免 id 還沒解析出來時白跑一次
  // (函式端對 p_merchant_id => null 會回 0 筆不 raise,但沒必要浪費一次往返)。
  // ⚠️ 這兩個 query 刻意**只有** useQuery、沒有任何 mutation——規格書第五節規則 1:
  //    這兩張卡片永遠不寫入資料庫。
  const {
    data: staffList,
    isLoading: staffLoading,
    error: staffError,
  } = useQuery({
    queryKey: merchantStaffQueryKey(id ?? ""),
    queryFn: () => platformFetchMerchantStaff(id as string),
    enabled: Boolean(id),
  });

  const {
    data: agentList,
    isLoading: agentsLoading,
    error: agentsError,
  } = useQuery({
    queryKey: merchantAgentsQueryKey(id ?? ""),
    queryFn: () => platformFetchMerchantAgents(id as string),
    enabled: Boolean(id),
  });

  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [intro, setIntro] = useState("");
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [newAdminEmail, setNewAdminEmail] = useState("");
  const [addingAdmin, setAddingAdmin] = useState(false);
  const [removingAdminId, setRemovingAdminId] = useState<string | null>(null);
  const [groupAdminEmailInput, setGroupAdminEmailInput] = useState("");
  const [savingGroupAdmin, setSavingGroupAdmin] = useState(false);

  useEffect(() => {
    if (!merchant) return;
    setName(merchant.name);
    setAddress(merchant.address ?? "");
    setContactEmail(merchant.contact_email ?? "");
    setIntro(merchant.intro ?? "");
  }, [merchant?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setGroupAdminEmailInput(groupAdminEmail ?? "");
  }, [groupAdminEmail]);

  async function refetchMerchant() {
    if (!id) return;
    await queryClient.invalidateQueries({ queryKey: merchantQueryKey(id) });
    await queryClient.invalidateQueries({ queryKey: ALL_MERCHANTS_QUERY_KEY });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!merchant) return;
    setSaving(true);
    try {
      await updateMerchantSettings(merchant.id, {
        name,
        address: address || null,
        contactEmail: contactEmail || null,
        intro: intro || null,
      });
      await refetchMerchant();
      toast.success("商家資料已儲存");
    } catch (err) {
      toast.error("儲存失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleStatus() {
    if (!merchant) return;
    setToggling(true);
    try {
      if (merchant.status === "active") {
        await disableMerchant(merchant.id);
        toast.success("已停用這間商家");
      } else {
        await enableMerchant(merchant.id);
        toast.success("已啟用這間商家");
      }
      await refetchMerchant();
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    } finally {
      setToggling(false);
    }
  }

  async function handleAddAdmin(e: FormEvent) {
    e.preventDefault();
    if (!merchant || !newAdminEmail.trim()) return;
    setAddingAdmin(true);
    try {
      await platformAddMerchantAdmin(merchant.id, newAdminEmail);
      setNewAdminEmail("");
      await queryClient.invalidateQueries({ queryKey: merchantAdminsQueryKey(merchant.id) });
      toast.success("已新增管理員");
    } catch (err) {
      toast.error("新增失敗", { description: getErrorMessage(err) });
    } finally {
      setAddingAdmin(false);
    }
  }

  async function handleRemoveAdmin(userId: string) {
    if (!merchant) return;
    setRemovingAdminId(userId);
    try {
      await platformRemoveMerchantAdmin(merchant.id, userId);
      await queryClient.invalidateQueries({ queryKey: merchantAdminsQueryKey(merchant.id) });
      toast.success("已移除管理員");
    } catch (err) {
      // 規則 2.4 的防呆訊息(移除後這間店會沒有任何人能登入管理)會透過 getErrorMessage(err) 顯示
      // (見 getErrorMessage.ts / api.ts 的說明:不能只判斷 instanceof Error,否則會被吞成通用文字)。
      toast.error("移除失敗", { description: getErrorMessage(err) });
    } finally {
      setRemovingAdminId(null);
    }
  }

  async function handleSetGroupAdmin(e: FormEvent) {
    e.preventDefault();
    if (!group || !groupAdminEmailInput.trim()) return;
    setSavingGroupAdmin(true);
    try {
      await platformSetGroupAdmin(group.id, groupAdminEmailInput);
      await queryClient.invalidateQueries({ queryKey: groupQueryKey(group.id) });
      toast.success("集團管理者已更新");
    } catch (err) {
      toast.error("設定失敗", { description: getErrorMessage(err) });
    } finally {
      setSavingGroupAdmin(false);
    }
  }

  async function handleClearGroupAdmin() {
    if (!group) return;
    setSavingGroupAdmin(true);
    try {
      await platformSetGroupAdmin(group.id, null);
      setGroupAdminEmailInput("");
      await queryClient.invalidateQueries({ queryKey: groupQueryKey(group.id) });
      toast.success("已清空集團管理者");
    } catch (err) {
      // 規則 2.5 的防呆訊息(清空後會有商家沒人能管)會透過 getErrorMessage(err) 顯示
      // (見 getErrorMessage.ts / api.ts 的說明:不能只判斷 instanceof Error,否則會被吞成通用文字)。
      toast.error("清空失敗", { description: getErrorMessage(err) });
    } finally {
      setSavingGroupAdmin(false);
    }
  }

  if (merchantLoading) {
    return (
      <PlatformAdminShell>
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      </PlatformAdminShell>
    );
  }

  if (merchantError || !merchant) {
    return (
      <PlatformAdminShell>
        <p className="text-sm text-destructive">
          找不到這間商家{merchantError ? `:${(merchantError as Error).message}` : ""}
        </p>
      </PlatformAdminShell>
    );
  }

  return (
    <PlatformAdminShell>
      <div className="space-y-6">
        <div>
          <Link to="/platform-admin" className="text-sm text-muted-foreground hover:underline">
            ← 返回商家總覽
          </Link>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">
            {merchant.name}
          </h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>基本資料</CardTitle>
            <CardDescription>可編輯店名、地址、對外聯絡信箱與簡介</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {merchant.status === "active" ? "目前啟用中" : "目前已停用"}
                </p>
                <p className="text-xs text-muted-foreground">
                  停用後客戶無法透過預約網址下單，資料不會被刪除，隨時可以再啟用。
                </p>
              </div>
              <Switch
                checked={merchant.status === "active"}
                onCheckedChange={handleToggleStatus}
                disabled={toggling}
              />
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <Label htmlFor="detail-name">店名</Label>
                <Input
                  id="detail-name"
                  className="mt-2"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div>
                <Label>產業模組</Label>
                <p className="mt-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                  {INDUSTRY_TYPE_LABELS[merchant.industry_type as IndustryType] ??
                    merchant.industry_type}
                  <span className="ml-2 text-xs">(唯讀,可在商家設定頁隨時切換)</span>
                </p>
              </div>
              <div>
                <Label htmlFor="detail-address">地址</Label>
                <Input
                  id="detail-address"
                  className="mt-2"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="detail-contact-email">對外聯絡 Email</Label>
                <Input
                  id="detail-contact-email"
                  type="email"
                  className="mt-2"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="detail-intro">商家簡介</Label>
                <Input
                  id="detail-intro"
                  className="mt-2"
                  value={intro}
                  onChange={(e) => setIntro(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={saving}>
                {saving ? "儲存中⋯" : "儲存變更"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>管理員名單</CardTitle>
            <CardDescription>代替商家新增/移除管理員(對方需已註冊過秒約帳號)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {adminsLoading ? (
              <p className="text-sm text-muted-foreground">載入中⋯</p>
            ) : (
              <ul className="space-y-2">
                {(admins ?? []).map((admin) => (
                  <li
                    key={admin.id}
                    className="flex flex-col gap-2 rounded-md border border-border px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
                  >
                    {/* 手機版容器寬度溢出修正:跟 MerchantAdminList.tsx 同一種 bug——email
                        長度不固定,窄螢幕下不能跟右側按鈕擠在同一個 nowrap 列,否則會撐開整個
                        <li> 超出手機螢幕寬度。改成手機寬度垂直堆疊、sm 以上橫向排列。

                        2026-09-24 使用者裁決(「超級管理員後台要不要也看得到這些欄位 = 要」,
                        理由是「以我這個廠商視角」——平台方需要掌握每位商家管理員的聯絡方式):
                        這一列從「只有一個 email」擴充成「暱稱・職位 / 手機 / Email」,
                        顯示的資訊跟商家端 MerchantAdminList.tsx 完全一致,
                        fallback 規則也共用 @/modules/merchant/adminDisplay 同一份,不各自複製。
                        排版刻意比商家端更緊湊(見下方說明),因為這一頁是平台維運視角。

                        ⚠️ 同日使用者又裁決「登入和聯絡信箱應該要是一致的(所以理論上不該出現
                        不同的信箱)」,所以原本還有的第四行「聯絡信箱」
                        (merchant_admins.contact_email + adminContactEmailToShow())已經移除,
                        一個人只有一個 Email。不要加回來。 */}
                    <div className="min-w-0 space-y-0.5">
                      {/* 平台維運視角:一次可能看很多商家、每家又有多位管理員,所以「暱稱・職位」
                          壓在同一行(商家端是暱稱大字、職位小字跟在後面),讓每一列高度更矮、
                          一個畫面塞得下更多筆。資訊內容一樣,只有密度不同。 */}
                      <p className="break-words font-medium text-foreground">
                        {adminDisplayName(admin)}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {adminJobTitle(admin)}
                        </span>
                      </p>
                      {/* 手機與 email 沒有空白可以斷行,必須 break-all(只有 break-words 仍會
                          撐開容器)。手機/Email 在寬螢幕併成一行、窄螢幕自動換行,
                          用 flex-wrap + gap 而不是兩個獨立段落,進一步壓低列高。 */}
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        <span className="break-all">手機:{adminPhone(admin)}</span>
                        <span className="break-all">Email:{admin.email}</span>
                      </div>
                    </div>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="self-start sm:self-auto"
                          disabled={removingAdminId === admin.user_id}
                        >
                          移除
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>確定要移除這位管理員嗎?</AlertDialogTitle>
                          {/* 2026-09-24:確認訊息一併帶上暱稱——名單現在以暱稱為主要辨識資訊,
                              確認視窗只講 email 會讓人要自己回頭對照是哪一位,而移除是不可逆的
                              操作。比照商家端 MerchantAdminList.tsx 的同一個處理。 */}
                          <AlertDialogDescription>
                            {adminDisplayName(admin)}({admin.email})將無法再登入管理「
                            {merchant.name}」。如果這是最後一位管理員(且集團也沒有設定集團
                            管理者),系統會擋下這個操作並提示。
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>取消</AlertDialogCancel>
                          <AlertDialogAction onClick={() => handleRemoveAdmin(admin.user_id)}>
                            確定移除
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </li>
                ))}
                {(admins ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">目前沒有管理員紀錄</p>
                ) : null}
              </ul>
            )}

            <form onSubmit={handleAddAdmin} className="flex items-end gap-3">
              <div className="flex-1">
                <Label htmlFor="new-admin-email">新增管理員(Email)</Label>
                <Input
                  id="new-admin-email"
                  type="email"
                  className="mt-2"
                  value={newAdminEmail}
                  onChange={(e) => setNewAdminEmail(e.target.value)}
                  placeholder="對方需已註冊過秒約帳號"
                />
              </div>
              <Button type="submit" disabled={addingAdmin || !newAdminEmail.trim()}>
                {addingAdmin ? "新增中⋯" : "新增"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>集團管理者</CardTitle>
            <CardDescription>
              {group?.name ? `所屬集團:${group.name}` : "所屬集團"}
              。設定了集團管理者的人，會自動可以管理集團底下所有分店。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {groupLoading ? (
              <p className="text-sm text-muted-foreground">載入中⋯</p>
            ) : (
              <>
                {/* 手機版容器寬度溢出修正(編號 190 同類排查補充):email 沒有空白字元,
                    預設文字換行規則不會自動斷行,長 email 會撐出這個區塊,加 break-words。 */}
                <p className="break-words text-sm text-muted-foreground">
                  目前的集團管理者:
                  <span className="ml-1 font-medium text-foreground">
                    {group?.group_admin_user_id ? (groupAdminEmail ?? "讀取中⋯") : "尚未設定"}
                  </span>
                </p>
                <form onSubmit={handleSetGroupAdmin} className="flex items-end gap-3">
                  <div className="flex-1">
                    <Label htmlFor="group-admin-email">設定集團管理者(Email)</Label>
                    <Input
                      id="group-admin-email"
                      type="email"
                      className="mt-2"
                      value={groupAdminEmailInput}
                      onChange={(e) => setGroupAdminEmailInput(e.target.value)}
                      placeholder="對方需已註冊過秒約帳號"
                    />
                  </div>
                  <Button type="submit" disabled={savingGroupAdmin || !groupAdminEmailInput.trim()}>
                    {savingGroupAdmin ? "儲存中⋯" : "設定"}
                  </Button>
                  {group?.group_admin_user_id ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={savingGroupAdmin}
                      onClick={handleClearGroupAdmin}
                    >
                      清空
                    </Button>
                  ) : null}
                </form>
              </>
            )}
          </CardContent>
        </Card>

        {/* ⚠️ 這兩張卡片刻意是唯讀的,沒有編輯/移除/權限按鈕,這是使用者裁決的結果,不是漏做。
            理由(規格書「超級管理員商家詳情強化」2.2):
              ① 責任界線:服務人員/客服是商家自己僱用、自己管理的人。平台方越過商家去改別人家的
                 員工,改錯了責任歸屬會很亂,而系統裡沒有稽核軌跡可以分辨是誰改的。
              ② 這兩張表的寫入都帶連動副作用(排班、可預約時段、抽成/薪資、通知對象、
                 agent_permissions),平台端開一條繞過商家的寫入路徑,等於要把模組 3/6/7/8/11/15
                 的規則在平台端全部再驗證一次。
              ③ 這次需求的痛點是「看不到」,不是「改不了」。
            ⚠️ 也不要因為「三張卡片要一致」就把上面的「管理員名單」改成唯讀——那張本來就可以
               新增/移除,是模組 2 的既有功能(功能 3.4/3.5)。
            ⚠️ 位置刻意放在「集團管理者」之後(整頁最後兩張):前三張都跟「誰能管理這間店」有關,
               這兩張性質不同(是「這間店有哪些人在做事」),而且附加在最後對既有 JSX 的侵入最小。 */}

        <Card>
          <CardHeader>
            <CardTitle>服務人員名單</CardTitle>
            <CardDescription>
              唯讀。這間店目前登記的服務人員。新增/修改/移除請由商家自己在「人員管理」頁操作,平台方不代為修改。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* #705 三種狀態。⚠️「讀取失敗」這個分支不能省、也不能靜默當成空清單:
                如果哪天權限退化(函式被誤 revoke、或 SECURITY DEFINER 被拿掉),失敗的表現
                形式很可能是「空清單」而不是例外——把 error 分支明確畫出來,是唯一能讓人分辨
                「這間店真的沒有服務人員」和「我讀不到」的辦法。
                ⚠️ 用 getErrorMessage(err),不要用 `err instanceof Error ? …`——Supabase 回傳的
                   error 不是 Error 子類別(見 getErrorMessage.ts 檔頭)。 */}
            {staffLoading ? (
              <p className="text-sm text-muted-foreground">載入中⋯</p>
            ) : staffError ? (
              <p className="text-sm text-destructive">載入失敗:{getErrorMessage(staffError)}</p>
            ) : (staffList ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">目前沒有服務人員紀錄</p>
            ) : (
              <>
                <ul className="space-y-2">
                  {/* #704 第 2 點:排序完全由資料庫決定(在職 → 已移除,同組內依姓名),
                      前端不要再排一次。 */}
                  {(staffList ?? []).map((staff) => (
                    <li
                      key={staff.id}
                      className="flex flex-col gap-2 rounded-md border border-border px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
                    >
                      {/* #706 手機版不溢出:窄螢幕上下堆疊、sm 以上左右排;左側資訊區 min-w-0;
                          姓名 break-words(不要 truncate——姓名是最重要的資訊,寧可換行也不要
                          切掉);手機與 Email 用 break-all(這兩種字串沒有空白可以斷行,只有
                          break-words 仍會撐開容器)。不要在外層補 overflow-x-auto。 */}
                      <div className="min-w-0 space-y-0.5">
                        <p className="break-words font-medium text-foreground">
                          {personDisplayName(staff)}
                        </p>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                          <span className="break-all">手機:{staff.phone}</span>
                          <span className="break-all">Email:{personLoginEmail(staff)}</span>
                        </div>
                      </div>
                      {/* 最多會同時出現三顆徽章,所以要 flex-wrap;寬螢幕時不要被壓縮。 */}
                      <div className="flex flex-wrap gap-1.5 sm:shrink-0">
                        <Badge variant="outline">
                          {
                            STAFF_COMPENSATION_TYPE_LABELS[
                              staff.compensation_type as StaffCompensationType
                            ]
                          }
                        </Badge>
                        <Badge variant="secondary">
                          {STAFF_LOGIN_STATUS_LABELS[staff.login_status as StaffLoginStatus]}
                        </Badge>
                        {/* #704 第 1 點:已移除的人也要顯示(removed 是軟刪除,平台維運常見的
                            問題是「這個人到底有沒有在這間店做過」,過濾掉就查不到了)。 */}
                        {staff.status === "removed" ? (
                          <Badge variant="destructive">已移除</Badge>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  {personCountSummary(
                    (staffList ?? []).length,
                    (staffList ?? []).filter((s) => s.status === "removed").length,
                  )}
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>客服名單</CardTitle>
            <CardDescription>
              唯讀。這間店目前登記的客服。新增/修改/移除與權限設定請由商家自己在「人員管理」頁操作,平台方不代為修改。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {agentsLoading ? (
              <p className="text-sm text-muted-foreground">載入中⋯</p>
            ) : agentsError ? (
              <p className="text-sm text-destructive">載入失敗:{getErrorMessage(agentsError)}</p>
            ) : (agentList ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">目前沒有客服紀錄</p>
            ) : (
              <>
                <ul className="space-y-2">
                  {(agentList ?? []).map((agent) => (
                    <li
                      key={agent.id}
                      className="flex flex-col gap-2 rounded-md border border-border px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 space-y-0.5">
                        {/* 暱稱 + 小字職稱壓在同一行,比照同一頁「管理員名單」的既有做法
                            (平台維運視角:一次可能看很多商家,列高越矮越好)。 */}
                        <p className="break-words font-medium text-foreground">
                          {personDisplayName(agent)}
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            {agentJobTitle(agent)}
                          </span>
                        </p>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                          <span className="break-all">手機:{agent.phone}</span>
                          <span className="break-all">Email:{personLoginEmail(agent)}</span>
                        </div>
                      </div>
                      {/* ⚠️ 客服沒有計酬類型、也沒有 login_status(實查 information_schema),
                          不要為了跟服務人員對稱而硬湊這兩顆徽章。客服的「有沒有開通登入」
                          就是看 status(invited = 邀請信已寄出但還沒接受)。 */}
                      <div className="flex flex-wrap gap-1.5 sm:shrink-0">
                        <Badge variant={agentStatusBadgeVariant(agent.status)}>
                          {AGENT_STATUS_LABELS[agent.status as AgentStatus]}
                        </Badge>
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  {personCountSummary(
                    (agentList ?? []).length,
                    (agentList ?? []).filter((a) => a.status === "removed").length,
                  )}
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </PlatformAdminShell>
  );
}
