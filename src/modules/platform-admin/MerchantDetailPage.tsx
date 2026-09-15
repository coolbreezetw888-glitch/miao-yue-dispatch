// 對應規格書 4.4(商家詳情頁)、4.5(集團管理者設定區塊)。
// 管理員名單沿用模組 1 現成的 useMerchantAdmins(見規則 2.3:查詢邏輯不重工)。
// industry_type 這裡也只顯示、不可編輯,理由同模組 1 規則 2.1(建立後鎖定)——超級管理員也不例外。

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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import { disableMerchant, enableMerchant, updateMerchantSettings } from "@/modules/merchant/api";
import { useMerchantAdmins } from "@/modules/merchant/context";
import { INDUSTRY_TYPE_LABELS } from "@/modules/merchant/types";
import type { IndustryType } from "@/modules/merchant/types";

import {
  platformAddMerchantAdmin,
  platformFetchGroupById,
  platformFetchMerchantById,
  platformGetUserEmail,
  platformRemoveMerchantAdmin,
  platformSetGroupAdmin,
} from "./api";
import { getErrorMessage } from "./getErrorMessage";
import { PlatformAdminShell } from "./PlatformAdminShell";

const ALL_MERCHANTS_QUERY_KEY = ["platform-admin", "all-merchants"] as const;
const merchantQueryKey = (id: string) => ["platform-admin", "merchant", id] as const;
const groupQueryKey = (id: string) => ["platform-admin", "group", id] as const;
const userEmailQueryKey = (id: string) => ["platform-admin", "user-email", id] as const;
const merchantAdminsQueryKey = (merchantId: string) =>
  ["merchant-module", "merchant-admins", merchantId] as const;

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
                  <span className="ml-2 text-xs">(建立後無法修改，超級管理員也不例外)</span>
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
                    className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
                  >
                    <span className="text-foreground">{admin.email}</span>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={removingAdminId === admin.user_id}
                        >
                          移除
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>確定要移除這位管理員嗎?</AlertDialogTitle>
                          <AlertDialogDescription>
                            {admin.email} 將無法再登入管理「{merchant.name}」。如果這是最後一位
                            管理員(且集團也沒有設定集團管理者),系統會擋下這個操作並提示。
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
                <p className="text-sm text-muted-foreground">
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
      </div>
    </PlatformAdminShell>
  );
}
