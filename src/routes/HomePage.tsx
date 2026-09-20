// 後台導覽外殼「首頁」分頁籤(路由 /app)。
//
// 2026-09-16 修正:這個分頁籤原本規劃叫「我的帳號」,使用者澄清之後,這裡實際定位是
// 「暫時佔位」——之後會被使用者另外提供的「主控台」設計取代(產品最後階段才會做),這次不用
// 預先做成帳號頁面的樣子,單純堪用即可。
//
// 2026-09-16 再次修正,對應規格書「首頁外殼與主題色優化」一、1.1/1.2:
//   - MerchantSwitcher、登出按鈕已經搬到 AppLayout.tsx 的常駐頂端列,這裡不再重複渲染,
//     避免同一組 UI 在畫面上出現兩次。
//   - 原本「Hi {email}」的問候文字,改成個人資料卡片:頭像(姓名/暱稱首字)+ 姓名/暱稱 + 職位 +
//     「編輯個人資料」按鈕。角色判斷方式(isAdmin)沿用既有的 useCurrentMerchantRole(),完全不變。

import { Link } from "react-router-dom";
import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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

import { updateMyAdminProfile } from "@/modules/merchant/api";
import { useCurrentMerchant, useMyAdminProfile } from "@/modules/merchant/context";
import { INDUSTRY_TYPE_LABELS } from "@/modules/merchant/types";
import type { IndustryType } from "@/modules/merchant/types";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { updateMyAgentProfile } from "@/modules/staff-agent/api";
import { useCurrentMerchantRole, useMyAgentProfile } from "@/modules/staff-agent/context";
// 模組 14(服務人員端)規格書 4.1:role==='staff' 時顯示服務人員版本的個人資料卡片,
// 這是本檔案唯一一處依賴模組 14 的地方。
import { EditMyStaffProfileDialog } from "@/modules/staff-portal/EditMyStaffProfileDialog";
import { useActiveMyStaffRecord, useMyStaffPermission } from "@/modules/staff-portal/context";

import { useAppLayoutContext } from "./AppLayout";

/** 1.2:兩者都沒填時 fallback 顯示帳號 email 的 @ 前半段。 */
function emailNamePrefix(email: string | null): string {
  if (!email) return "使用者";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

interface EditProfileDialogProps {
  role: "admin" | "agent";
  merchantId: string;
  nameLabel: string;
  currentName: string;
  currentJobTitle: string;
  onSaved: () => void;
}

/** 1.2:「編輯個人資料」按鈕點擊開啟的小對話框,可以編輯姓名/暱稱、職位兩個欄位,
 * 儲存後由呼叫端 onSaved() 重新整理卡片顯示的資料。 */
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

  // 每次打開對話框時,把表單重新灌成目前實際存的值(不是卡片上顯示的 fallback 文字,
  // 避免使用者沒改任何東西就儲存,結果把 fallback 文字誤存成真正的資料)。
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

export default function HomePage() {
  const { email, userId } = useAppLayoutContext();
  const { merchant: currentMerchant } = useCurrentMerchant();
  const merchantId = currentMerchant?.id ?? null;

  // 對應規格書(人員與權限管理)4.5 的既有判斷方式:role 還沒判斷完成時(undefined)先當作
  // false,避免畫面短暫誤閃管理員專屬的「新增分店」入口——這裡沿用同一個判斷方式決定要抓
  // 管理員還是客服的個人資料。
  const { data: merchantRole } = useCurrentMerchantRole();
  const isAdmin = merchantRole === "admin";
  const isAgent = merchantRole === "agent";
  const isStaff = merchantRole === "staff";

  const adminProfileQuery = useMyAdminProfile(merchantId, userId, isAdmin);
  const agentProfileQuery = useMyAgentProfile(merchantId, userId, isAgent);
  const { data: staffRow } = useActiveMyStaffRecord(isStaff ? merchantId : null);
  const { data: canEditStaffProfile } = useMyStaffPermission("staff_profile_edit");
  const queryClient = useQueryClient();
  function refetchStaffProfile() {
    void queryClient.invalidateQueries({
      queryKey: ["staff-portal-module", "my-staff-record", merchantId],
    });
  }

  // 卡片顯示用的「有 fallback 文字」版本:兩者都沒填時顯示 email 的 @ 前半段/依角色判斷的通用文字。
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

  // 編輯對話框用的「原始值」版本(可能是空字串),不能用上面那份已經套過 fallback 的顯示文字,
  // 否則打開對話框時會誤把 fallback 文字當成真正存的資料。
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

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-5 py-10">
      {isStaff && staffRow ? (
        // 模組 14 規格書 4.1:服務人員版本的個人資料卡片(姓名/暱稱/電話/對外聯絡 email/簡介/
        // 頭像),不顯示上面管理員/客服版本的卡片內容。「編輯」依 staff_profile_edit 權限決定
        // 是否顯示(規則 2.8:檢視自己的資料永遠可以,編輯需要額外開通)。
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center gap-4">
            <Avatar className="h-12 w-12">
              {staffRow.avatar_url ? (
                <img
                  src={staffRow.avatar_url}
                  alt={staffRow.name}
                  className="h-full w-full rounded-full object-cover"
                />
              ) : (
                <AvatarFallback className="bg-brand-soft text-lg font-semibold text-brand">
                  {staffRow.name.slice(0, 1)}
                </AvatarFallback>
              )}
            </Avatar>
            <div>
              <p className="text-lg font-semibold text-foreground">
                {staffRow.name}
                {staffRow.nickname ? `(${staffRow.nickname})` : ""}
              </p>
              <p className="text-sm text-muted-foreground">
                {[staffRow.phone, staffRow.contact_email].filter(Boolean).join(" ・ ") || "服務人員"}
              </p>
              {staffRow.intro ? (
                <p className="mt-1 text-sm text-muted-foreground">{staffRow.intro}</p>
              ) : null}
            </div>
          </div>
          {canEditStaffProfile ? (
            <EditMyStaffProfileDialog
              merchantId={merchantId as string}
              staff={staffRow}
              trigger={
                <Button variant="outline" size="sm">
                  編輯個人資料
                </Button>
              }
              onSaved={refetchStaffProfile}
            />
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card p-6">
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
      )}

      <div className="rounded-2xl border border-border bg-card p-8">
        {currentMerchant ? (
          <>
            <p className="text-sm text-muted-foreground">目前操作中的商家</p>
            <p className="mt-1 text-xl font-semibold text-foreground">{currentMerchant.name}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {INDUSTRY_TYPE_LABELS[currentMerchant.industry_type as IndustryType] ??
                currentMerchant.industry_type}
              {currentMerchant.status === "disabled" ? "・已停用" : ""}
            </p>
          </>
        ) : null}
        <p className="mt-6 text-base leading-relaxed text-muted-foreground">
          你的派工管理後台即將上線 — 下一個里程碑會加上人員、服務項目與訂單管理功能。
        </p>
      </div>

      {isAdmin ? (
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-card p-5">
          <div>
            <p className="text-sm font-medium text-foreground">新增分店</p>
            <p className="mt-1 text-xs text-muted-foreground">在同一個集團底下再開一間新的分店</p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to="/app/new-merchant">新增分店</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
