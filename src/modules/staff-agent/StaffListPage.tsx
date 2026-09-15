// 對應規格書 4.2:服務人員管理頁(新路由 /app/staff)。
// 清單 + 新增/編輯表單(姓名/暱稱/電話/Email/頭像上傳/簡介/上架開關)+ 服務項目勾選區塊
// (目前系統沒有任何服務項目,顯示空狀態文字,不報錯,見規格書 1.2 邊界情況)+
// 權限功能區塊(1.1.1 的 11 個欄位逐一列出,附白話說明)。

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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";

import {
  addMerchantStaff,
  fetchMerchantStaff,
  fetchStaffServiceItemIds,
  reactivateMerchantStaff,
  removeMerchantStaff,
  updateMerchantStaff,
  uploadStaffAvatar,
  type UpsertMerchantStaffInput,
} from "./api";
import { RequireMerchantAdmin } from "./RequireMerchantAdmin";
import { StaffAvatarUploader } from "./StaffAvatarUploader";
import {
  STAFF_BOOLEAN_PERMISSION_FIELDS,
  STAFF_NUMBER_PERMISSION_FIELDS,
  type MerchantStaff,
} from "./types";

const staffListQueryKey = (merchantId: string) =>
  ["staff-agent-module", "staff-admin-list", merchantId] as const;

interface StaffFormState extends UpsertMerchantStaffInput {
  avatarUrl: string | null;
}

const EMPTY_FORM: StaffFormState = {
  name: "",
  nickname: "",
  phone: "",
  contactEmail: "",
  intro: "",
  avatarUrl: null,
  isListed: false,
  advanceBookingDays: null,
  bookingWindowMinDays: null,
  bookingWindowMaxDays: null,
  noTimeSlotLimit: false,
  unlimitedBackendEdit: false,
  directAcceptAfterMerchantConfirm: false,
  autoAcceptBooking: false,
  showMemberInfo: false,
  googleCalendarSyncEnabled: false,
  canCreateEditOrders: false,
  canUploadConstructionPhotos: false,
};

function staffToFormState(staff: MerchantStaff): StaffFormState {
  return {
    name: staff.name,
    nickname: staff.nickname ?? "",
    phone: staff.phone ?? "",
    contactEmail: staff.contact_email ?? "",
    intro: staff.intro ?? "",
    avatarUrl: staff.avatar_url,
    isListed: staff.is_listed,
    advanceBookingDays: staff.advance_booking_days,
    bookingWindowMinDays: staff.booking_window_min_days,
    bookingWindowMaxDays: staff.booking_window_max_days,
    noTimeSlotLimit: staff.no_time_slot_limit,
    unlimitedBackendEdit: staff.unlimited_backend_edit,
    directAcceptAfterMerchantConfirm: staff.direct_accept_after_merchant_confirm,
    autoAcceptBooking: staff.auto_accept_booking,
    showMemberInfo: staff.show_member_info,
    googleCalendarSyncEnabled: staff.google_calendar_sync_enabled,
    canCreateEditOrders: staff.can_create_edit_orders,
    canUploadConstructionPhotos: staff.can_upload_construction_photos,
  };
}

function StaffFormDialog({
  merchantId,
  staff,
  trigger,
  onSaved,
}: {
  merchantId: string;
  staff: MerchantStaff | null;
  trigger: React.ReactNode;
  onSaved: () => void;
}) {
  const isEdit = Boolean(staff);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<StaffFormState>(staff ? staffToFormState(staff) : EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const { data: serviceItemIds } = useQuery({
    queryKey: ["staff-agent-module", "staff-service-items", staff?.id],
    queryFn: () => fetchStaffServiceItemIds(staff!.id),
    enabled: open && Boolean(staff?.id),
  });

  useEffect(() => {
    if (open) {
      setForm(staff ? staffToFormState(staff) : EMPTY_FORM);
    }
  }, [open, staff]);

  function setField<K extends keyof StaffFormState>(key: K, value: StaffFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleAvatarUpload(file: File) {
    const url = await uploadStaffAvatar(merchantId, file);
    setField("avatarUrl", url);
    // 編輯既有服務人員時直接存檔頭像,避免關掉對話框後遺失剛上傳的圖片。
    if (staff) {
      await updateMerchantStaff(staff.id, { avatarUrl: url });
      onSaved();
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("請填寫姓名");
      return;
    }
    if (
      form.bookingWindowMinDays != null &&
      form.bookingWindowMaxDays != null &&
      form.bookingWindowMinDays > form.bookingWindowMaxDays
    ) {
      toast.error("預約天數範圍下限不能大於上限");
      return;
    }

    setSaving(true);
    try {
      if (isEdit && staff) {
        await updateMerchantStaff(staff.id, form);
        toast.success("服務人員資料已更新");
      } else {
        await addMerchantStaff(merchantId, form);
        toast.success("已新增服務人員");
      }
      setOpen(false);
      onSaved();
    } catch (err) {
      toast.error(isEdit ? "更新失敗" : "新增失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "編輯服務人員" : "新增服務人員"}</DialogTitle>
          <DialogDescription>
            服務人員這次不開放登入帳號,只是商家維護的一份人員名錄。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-4">
            <StaffAvatarUploader currentAvatarUrl={form.avatarUrl} onUpload={handleAvatarUpload} />

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="staff-name">姓名 *</Label>
                <Input
                  id="staff-name"
                  className="mt-2"
                  value={form.name}
                  onChange={(e) => setField("name", e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="staff-nickname">暱稱(對客戶顯示)</Label>
                <Input
                  id="staff-nickname"
                  className="mt-2"
                  value={form.nickname ?? ""}
                  onChange={(e) => setField("nickname", e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="staff-phone">電話</Label>
                <Input
                  id="staff-phone"
                  className="mt-2"
                  value={form.phone ?? ""}
                  onChange={(e) => setField("phone", e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="staff-email">對外聯絡 Email</Label>
                <Input
                  id="staff-email"
                  type="email"
                  className="mt-2"
                  value={form.contactEmail ?? ""}
                  onChange={(e) => setField("contactEmail", e.target.value)}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="staff-intro">簡介</Label>
              <Textarea
                id="staff-intro"
                className="mt-2"
                rows={3}
                value={form.intro ?? ""}
                onChange={(e) => setField("intro", e.target.value)}
              />
            </div>

            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium text-foreground">上架</p>
                <p className="text-xs text-muted-foreground">
                  開啟後客戶或客服可以選擇預約這位服務人員。
                </p>
              </div>
              <Switch
                checked={form.isListed ?? false}
                onCheckedChange={(v) => setField("isListed", v)}
              />
            </div>
          </div>

          <div>
            <Label className="text-sm font-semibold">服務項目</Label>
            {serviceItemIds && serviceItemIds.length > 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                (已選 {serviceItemIds.length} 項服務項目)
              </p>
            ) : (
              <p className="mt-2 rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
                目前尚無服務項目可選,請先到服務項目管理設定
              </p>
            )}
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <Label className="text-sm font-semibold">權限功能</Label>
              <span className="text-xs text-muted-foreground">
                這些開關目前先存值,對應的功能上線後才會實際生效
              </span>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {STAFF_NUMBER_PERMISSION_FIELDS.map((field) => {
                // 明確窄化成三個具體欄位(而不是用泛型 toCamel),避免 form[key] 的型別被推成
                // StaffFormState 全部欄位型別的聯集(含 boolean),導致 <input value> 型別檢查出錯。
                const numberKey:
                  "advanceBookingDays" | "bookingWindowMinDays" | "bookingWindowMaxDays" =
                  field.key === "advance_booking_days"
                    ? "advanceBookingDays"
                    : field.key === "booking_window_min_days"
                      ? "bookingWindowMinDays"
                      : "bookingWindowMaxDays";
                return (
                  <div key={field.key}>
                    <Label htmlFor={`staff-${field.key}`} className="text-xs">
                      {field.label}
                    </Label>
                    <Input
                      id={`staff-${field.key}`}
                      type="number"
                      min={field.key === "advance_booking_days" ? 0 : 3}
                      max={field.key === "advance_booking_days" ? undefined : 180}
                      className="mt-1"
                      value={form[numberKey] ?? ""}
                      onChange={(e) =>
                        setField(numberKey, e.target.value === "" ? null : Number(e.target.value))
                      }
                    />
                    <p className="mt-1 text-[11px] text-muted-foreground">{field.description}</p>
                  </div>
                );
              })}
            </div>
            <div className="mt-4 space-y-2">
              {STAFF_BOOLEAN_PERMISSION_FIELDS.map((field) => (
                <div
                  key={field.key}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                >
                  <div>
                    <p className="text-sm text-foreground">{field.label}</p>
                    <p className="text-xs text-muted-foreground">{field.description}</p>
                  </div>
                  <Switch
                    checked={Boolean(form[toCamel(field.key)])}
                    onCheckedChange={(v) => setField(toCamel(field.key), v)}
                  />
                </div>
              ))}
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

// snake_case 欄位 key 轉成 StaffFormState 的 camelCase key,避免逐一手寫對照表。
function toCamel<K extends keyof StaffFormState>(key: string): K {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) as K;
}

function StaffListInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();

  const { data: staffList, isLoading } = useQuery({
    queryKey: staffListQueryKey(merchantId),
    queryFn: () => fetchMerchantStaff(merchantId),
  });

  function refetch() {
    return queryClient.invalidateQueries({ queryKey: staffListQueryKey(merchantId) });
  }

  async function handleRemove(staffId: string) {
    try {
      await removeMerchantStaff(staffId);
      await refetch();
      toast.success("已移除服務人員");
    } catch (err) {
      toast.error("移除失敗", { description: getErrorMessage(err) });
    }
  }

  async function handleReactivate(staffId: string) {
    try {
      await reactivateMerchantStaff(staffId);
      await refetch();
      toast.success("已重新上架這位服務人員");
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    }
  }

  return (
    <div className="min-h-screen bg-surface font-sans antialiased">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-5">
          <Link to="/app" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-brand-foreground">
              秒
            </span>
            <span className="text-lg font-bold tracking-tight text-foreground">秒約</span>
          </Link>
          <Button variant="outline" size="sm" asChild>
            <Link to="/app">返回後台</Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-6 px-5 py-12">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">服務人員管理</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              「{merchant!.name}」的師傅/服務人員名錄
            </p>
          </div>
          <StaffFormDialog
            merchantId={merchantId}
            staff={null}
            trigger={<Button variant="cta">新增服務人員</Button>}
            onSaved={refetch}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>人員名單</CardTitle>
            <CardDescription>包含已上架與未上架的服務人員</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">載入中⋯</p>
            ) : !staffList || staffList.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                目前還沒有任何服務人員,點右上角新增一位。
              </p>
            ) : (
              <ul className="space-y-2">
                {staffList.map((staff) => (
                  <li
                    key={staff.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                  >
                    <div className="flex items-center gap-3 overflow-hidden">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
                        {staff.avatar_url ? (
                          <img
                            src={staff.avatar_url}
                            alt={staff.name}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">無</span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {staff.name}
                          {staff.nickname ? `(${staff.nickname})` : ""}
                        </p>
                        <div className="mt-0.5 flex gap-1.5">
                          <Badge variant={staff.is_listed ? "default" : "secondary"}>
                            {staff.is_listed ? "已上架" : "未上架"}
                          </Badge>
                          {staff.status === "removed" ? (
                            <Badge variant="destructive">已移除</Badge>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {staff.status === "active" ? (
                        <>
                          <StaffFormDialog
                            merchantId={merchantId}
                            staff={staff}
                            trigger={
                              <Button variant="outline" size="sm">
                                編輯
                              </Button>
                            }
                            onSaved={refetch}
                          />
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="outline" size="sm">
                                移除
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>確定要移除這位服務人員嗎?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  這是軟刪除,資料不會不見,之後隨時可以重新上架恢復。
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>取消</AlertDialogCancel>
                                <AlertDialogAction onClick={() => handleRemove(staff.id)}>
                                  確定移除
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleReactivate(staff.id)}
                        >
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
    </div>
  );
}

export default function StaffListPage() {
  return (
    <RequireMerchantAdmin>
      <StaffListInner />
    </RequireMerchantAdmin>
  );
}
