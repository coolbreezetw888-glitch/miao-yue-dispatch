// 對應規格書 4.2:服務人員管理頁(新路由 /app/staff)。
// 清單 + 新增/編輯表單(姓名/暱稱/電話/Email/頭像上傳/簡介/上架開關)+ 服務項目勾選區塊
// (目前系統沒有任何服務項目,顯示空狀態文字,不報錯,見規格書 1.2 邊界情況)+
// 權限功能區塊(1.1.1 的 11 個欄位逐一列出,附白話說明)。

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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { isValidTaiwanMobilePhone, TW_MOBILE_PHONE_ERROR_MESSAGE } from "@/lib/validation";
import { useCurrentMerchant } from "@/modules/merchant/context";
import {
  getServiceItem,
  useMerchantServiceCategories,
  useMerchantServiceItems,
} from "@/modules/service-items/context";
import { UNCATEGORIZED_LABEL, type ServiceItem } from "@/modules/service-items/types";
import { addStaffAvailabilityWindow, removeStaffAvailabilityWindow } from "@/modules/booking/api";
import { useStaffAvailabilityWindows } from "@/modules/booking/context";
import { DAY_OF_WEEK_LABELS } from "@/modules/booking/types";
import { StaffLineBindingSection } from "@/modules/line-notifications/StaffLineBindingSection";
// 模組 15(服務人員推播通知)§7.5(選配):服務人員詳情頁疊加顯示已開通推播裝置數,比照上面
// StaffLineBindingSection 同樣的掛載模式,純唯讀顯示。
import { StaffPushSubscriptionSummary } from "@/modules/push-notifications/StaffPushSubscriptionSummary";
// 模組 14(服務人員端)規格書 4.7 第 1/2 點:邀請服務人員登入的入口,直接呼叫模組 14 對外暴露的
// Edge Function 包裝(inviteMerchantStaff)。這是本檔案唯一一處依賴模組 14 的地方,方向是
// 「模組 3 既有畫面疊加模組 14 的功能」,規格書 4.7 明講要在這個既有檔案上擴充,不是另起新檔案。
import { inviteMerchantStaff } from "@/modules/staff-portal/api";

import {
  addMerchantStaff,
  addStaffServiceItem,
  clearStaffPendingLoginEmail,
  fetchMerchantStaff,
  fetchStaffServiceItemIds,
  hardDeleteMerchantStaff,
  reactivateMerchantStaff,
  removeMerchantStaff,
  removeStaffServiceItem,
  requestStaffLoginEmailChange,
  updateMerchantStaff,
  uploadStaffAvatar,
  type UpsertMerchantStaffInput,
} from "./api";
import { AdminSuggestLoginEmailDialog, LoginEmailStatusDisplay } from "./AdminLoginEmailManager";
import { useStaffLoginEmailStatus } from "./context";
import { RequireMerchantAdmin } from "./RequireMerchantAdmin";
import { StaffAvatarUploader } from "./StaffAvatarUploader";
import {
  countStaffByFilter,
  matchesStaffListFilter,
  STAFF_LIST_FILTER_TABS,
  type StaffListFilter,
} from "./staffListLogic";
import {
  STAFF_BOOLEAN_PERMISSION_FIELDS,
  STAFF_LOGIN_STATUS_LABELS,
  STAFF_NUMBER_PERMISSION_FIELDS,
  type MerchantStaff,
  type StaffLoginStatus,
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
  // 模組 7(排班與休假管理)§4.1/第〇節判斷 1:預先選取「按件計酬」為預設選項,對既有資料
  // 行為影響最小,但要求管理員明確看過再送出,不是隱藏欄位。
  compensationType: "piece_rate",
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
    compensationType: staff.compensation_type as "monthly_salary" | "piece_rate",
  };
}

// 模組 5 規格書 4.2:比照模組 4 4.4 節先例,新增一週可預約時段設定區塊。允許同一天多組時段
// (規格書 1.2)。空狀態(規則 2.5):完全沒設定任何時段、且 no_time_slot_limit=false 時,
// 這位服務人員這次還不可預約,這裡用提示文字說明,不做任何攔阻(攔阻邏輯在 create_booking 裡)。
function AvailabilityWindowsEditor({
  staffId,
  noTimeSlotLimit,
}: {
  staffId: string;
  noTimeSlotLimit: boolean;
}) {
  const queryClient = useQueryClient();
  const windowsQueryKey = ["booking-module", "staff-availability-windows", staffId] as const;
  const { data: windows, isLoading } = useStaffAvailabilityWindows(staffId);

  const [dayOfWeek, setDayOfWeek] = useState("1");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("18:00");
  const [adding, setAdding] = useState(false);

  function refetch() {
    return queryClient.invalidateQueries({ queryKey: windowsQueryKey });
  }

  async function handleAdd() {
    if (startTime >= endTime) {
      toast.error("開始時間必須早於結束時間");
      return;
    }
    setAdding(true);
    try {
      await addStaffAvailabilityWindow(staffId, {
        dayOfWeek: Number(dayOfWeek),
        startTime,
        endTime,
      });
      await refetch();
      toast.success("已新增可預約時段");
    } catch (err) {
      toast.error("新增失敗", { description: getErrorMessage(err) });
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(windowId: string) {
    try {
      await removeStaffAvailabilityWindow(windowId);
      await refetch();
      toast.success("已刪除這組時段");
    } catch (err) {
      toast.error("刪除失敗", { description: getErrorMessage(err) });
    }
  }

  return (
    <div>
      <Label className="text-sm font-semibold">可預約時段</Label>
      <p className="mt-1 text-xs text-muted-foreground">
        這位服務人員自己願意接單的時段,不必等於商家整體營業時間。
        {noTimeSlotLimit
          ? "目前已開啟「無時段限制」,以下設定會被忽略,只受商家整體營業時間限制。"
          : "完全沒有設定任何時段時,這位服務人員這次還不可預約,除非開啟「無時段限制」。"}
      </p>

      {isLoading ? (
        <p className="mt-2 text-sm text-muted-foreground">載入中⋯</p>
      ) : !windows || windows.length === 0 ? (
        <p className="mt-2 rounded-md border border-dashed border-border px-3 py-3 text-center text-sm text-muted-foreground">
          尚未設定任何可預約時段
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {windows.map((w) => (
            <li
              key={w.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5 text-sm"
            >
              <span>
                星期{DAY_OF_WEEK_LABELS[w.day_of_week]} {w.start_time.slice(0, 5)} -{" "}
                {w.end_time.slice(0, 5)}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={() => handleRemove(w.id)}>
                刪除
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          value={dayOfWeek}
          onChange={(e) => setDayOfWeek(e.target.value)}
        >
          {DAY_OF_WEEK_LABELS.map((label, index) => (
            <option key={label} value={index}>
              星期{label}
            </option>
          ))}
        </select>
        <input
          type="time"
          className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
        />
        <span className="text-sm text-muted-foreground">至</span>
        <input
          type="time"
          className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          value={endTime}
          onChange={(e) => setEndTime(e.target.value)}
        />
        <Button type="button" variant="outline" size="sm" disabled={adding} onClick={handleAdd}>
          新增時段
        </Button>
      </div>
    </div>
  );
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
  const queryClient = useQueryClient();

  const staffServiceItemsQueryKey = ["staff-agent-module", "staff-service-items", staff?.id];

  const { data: serviceItemIds } = useQuery({
    queryKey: staffServiceItemsQueryKey,
    queryFn: () => fetchStaffServiceItemIds(staff!.id),
    enabled: open && Boolean(staff?.id),
  });

  // 模組 4 規格書 4.4:讀取這間商家目前 status='active' 的服務項目清單(對外介面 5.1),
  // 用來判斷「商家是否有任何服務項目可選」跟渲染真正的 checkbox 清單,不是只讀已勾選數量。
  const { data: activeServiceItems, isLoading: activeServiceItemsLoading } =
    useMerchantServiceItems(open ? merchantId : null);
  const { data: categories } = useMerchantServiceCategories(open ? merchantId : null);

  const merchantHasAnyServiceItems = (activeServiceItems?.length ?? 0) > 0;

  // 規則 2.3 邊界情況:已下架但仍被這位服務人員勾選的項目,不會自動從關聯表消失,只是不會出現在
  // 「可選」的 activeServiceItems 清單裡——這裡額外查出這些項目的名稱,加註「(已下架)」提示。
  const removedSelectedIds = useMemo(() => {
    if (!serviceItemIds || !activeServiceItems) return [];
    const activeIds = new Set(activeServiceItems.map((item) => item.id));
    return serviceItemIds.filter((id) => !activeIds.has(id));
  }, [serviceItemIds, activeServiceItems]);

  const { data: removedSelectedItems } = useQuery({
    queryKey: [
      "staff-agent-module",
      "removed-selected-service-items",
      staff?.id,
      removedSelectedIds,
    ],
    queryFn: async () => {
      const results = await Promise.all(removedSelectedIds.map((id) => getServiceItem(id)));
      return results.filter((item): item is ServiceItem => item !== null);
    },
    enabled: open && Boolean(staff?.id) && removedSelectedIds.length > 0,
  });

  function categoryName(categoryId: string | null): string {
    if (!categoryId) return UNCATEGORIZED_LABEL;
    return categories?.find((c) => c.id === categoryId)?.name ?? UNCATEGORIZED_LABEL;
  }

  async function handleToggleServiceItem(serviceItemId: string, checked: boolean) {
    if (!staff) return;
    try {
      if (checked) {
        await addStaffServiceItem(staff.id, serviceItemId);
      } else {
        await removeStaffServiceItem(staff.id, serviceItemId);
      }
      await queryClient.invalidateQueries({ queryKey: staffServiceItemsQueryKey });
    } catch (err) {
      toast.error("更新服務項目失敗", { description: getErrorMessage(err) });
    }
  }

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
    // 規格書 §8.1:電話這次改為必填,且必須符合台灣手機號碼格式(09 開頭共 10 碼),
    // 驗證邏輯共用 §8.3 的 isValidTaiwanMobilePhone,不在這裡自己另外寫一份正規表示式。
    const trimmedPhone = (form.phone ?? "").trim();
    if (!trimmedPhone) {
      toast.error("請填寫電話");
      return;
    }
    if (!isValidTaiwanMobilePhone(trimmedPhone)) {
      toast.error(TW_MOBILE_PHONE_ERROR_MESSAGE);
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
            {/* 模組 14(服務人員端)上線後,原本這裡「服務人員這次不開放登入帳號」的說明文字已經過時
                (服務人員現在可以自己登入)——2026-09-21 使用者人工測試回報問題 1 修正:這裡只負責
                建立/編輯基本資料,登入帳號要等這裡儲存完成後,回到人員清單按「邀請登入」才會真的
                開通(見 4.7 第 2 點的 InviteStaffLoginDialog)。 */}
            {isEdit
              ? "這裡只會更新基本資料,不會影響登入帳號——登入帳號的開通/權限,請到人員清單使用「邀請登入」或「服務人員權限」。"
              : "這裡先建立基本資料,登入帳號要在儲存完成後,回到人員清單裡按「邀請登入」才會真的開通。"}
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
                <Label htmlFor="staff-phone">電話 *</Label>
                <Input
                  id="staff-phone"
                  className="mt-2"
                  value={form.phone ?? ""}
                  onChange={(e) => setField("phone", e.target.value)}
                  placeholder="0912345678"
                  required
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  請輸入台灣手機號碼,09 開頭共 10 碼數字,例如 0912345678。
                </p>
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
                {/* 2026-09-21 使用者人工測試回報問題 2 修正:這欄位(contact_email)容易被誤會成
                    登入帳號的 email——這裡只是顯示給客戶看的聯絡資訊,登入帳號是完全分開的另一件事
                    (見 4.7 第 2 點,登入 email 在「邀請登入」Dialog 裡另外輸入,雖然預設會帶入這欄
                    的值當作起始值,但送出前可以改成不同的 email)。不改欄位名稱/資料結構,只加說明。 */}
                <p className="mt-1 text-[11px] text-muted-foreground">
                  顯示給客戶看的聯絡信箱,不是登入帳號。登入帳號要在儲存完成後,另外用「邀請登入」設定。
                </p>
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

            {/* 模組 7(排班與休假管理)§4.1:計酬類型單選,預設選取「按件計酬」(第〇節判斷 1)。
                只有月薪制的服務人員才能登記請假紀錄(規則 2.2),按件計酬對應的是「調整可預約
                時段」(既有的 staff_availability_windows/unlimited_backend_edit 機制)。 */}
            <div className="rounded-md border border-border px-3 py-2">
              <p className="text-sm font-medium text-foreground">計酬類型</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                月薪制服務人員才能登記請假紀錄(見「請假紀錄」功能)。
              </p>
              <RadioGroup
                className="mt-2 grid-flow-col justify-start gap-6"
                value={form.compensationType ?? "piece_rate"}
                onValueChange={(v) =>
                  setField("compensationType", v as "monthly_salary" | "piece_rate")
                }
              >
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <RadioGroupItem value="piece_rate" id="staff-compensation-piece-rate" />
                  按件計酬
                </label>
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <RadioGroupItem value="monthly_salary" id="staff-compensation-monthly-salary" />
                  月薪制
                </label>
              </RadioGroup>
            </div>
          </div>

          <div>
            <Label className="text-sm font-semibold">服務項目</Label>
            {/* 模組 4 規格書 4.4:先判斷「商家是否有任何 status='active' 的服務項目」,
                不是只看「這位服務人員目前已勾選幾項」——避免把「商家根本沒有服務項目可選」
                跟「有服務項目、只是這位人員還沒被勾選任何一項」這兩種情況搞混。 */}
            {activeServiceItemsLoading ? (
              <p className="mt-2 text-sm text-muted-foreground">載入中⋯</p>
            ) : !merchantHasAnyServiceItems ? (
              <p className="mt-2 rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
                目前尚無服務項目可選,請先到服務項目管理設定
              </p>
            ) : !staff ? (
              <p className="mt-2 rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
                請先儲存這位服務人員的基本資料,儲存後重新點選「編輯」即可勾選服務項目。
              </p>
            ) : (
              <div className="mt-2 space-y-2">
                {activeServiceItems!.map((item) => {
                  const checked = serviceItemIds?.includes(item.id) ?? false;
                  return (
                    <label
                      key={item.id}
                      className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm text-foreground">{item.name}</p>
                        {/* 手機版容器寬度溢出修正(編號 190 同類排查補充):分類名稱是商家自訂
                            文字、長度不固定,加 break-words 讓這行願意換行,不會撐開容器。 */}
                        <p className="break-words text-xs text-muted-foreground">
                          {categoryName(item.category_id)} ・ ${Number(item.price).toFixed(0)}
                        </p>
                      </div>
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => handleToggleServiceItem(item.id, v === true)}
                      />
                    </label>
                  );
                })}
                {removedSelectedItems && removedSelectedItems.length > 0
                  ? removedSelectedItems.map((item) => (
                      <label
                        key={item.id}
                        className="flex items-center justify-between gap-3 rounded-md border border-dashed border-border px-3 py-2 opacity-70"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm text-foreground">
                            {item.name}
                            <span className="ml-1 text-xs text-muted-foreground">(已下架)</span>
                          </p>
                          {/* 手機版容器寬度溢出修正(編號 190 同類排查補充):同上,分類名稱
                              長度不固定,加 break-words 避免撐開容器。 */}
                          <p className="break-words text-xs text-muted-foreground">
                            {categoryName(item.category_id)} ・ ${Number(item.price).toFixed(0)}
                          </p>
                        </div>
                        <Checkbox
                          checked
                          onCheckedChange={(v) => handleToggleServiceItem(item.id, v === true)}
                        />
                      </label>
                    ))
                  : null}
              </div>
            )}
          </div>

          {staff ? (
            <AvailabilityWindowsEditor
              staffId={staff.id}
              noTimeSlotLimit={form.noTimeSlotLimit ?? false}
            />
          ) : (
            <div>
              <Label className="text-sm font-semibold">可預約時段</Label>
              <p className="mt-2 rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
                請先儲存這位服務人員的基本資料,儲存後重新點選「編輯」即可設定可預約時段。
              </p>
            </div>
          )}

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

          {/* 模組 11(LINE 通知)§4.6:服務人員詳情/編輯頁疊加「LINE 綁定」區塊,只有編輯既有
              服務人員(已經有 staff.id)時才顯示,新增流程還沒有 id 可以綁定。 */}
          {isEdit && staff ? <StaffLineBindingSection staffId={staff.id} /> : null}
          {/* 模組 15(服務人員推播通知)§7.5(選配):同樣只在編輯既有服務人員時顯示。 */}
          {isEdit && staff ? <StaffPushSubscriptionSummary staffId={staff.id} /> : null}

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

function loginStatusBadgeVariant(
  loginStatus: StaffLoginStatus,
): "default" | "secondary" | "outline" {
  if (loginStatus === "active") return "default";
  if (loginStatus === "invited") return "secondary";
  return "outline";
}

// 模組 14(服務人員端)規格書 4.7 第 2 點:邀請服務人員登入的小 Dialog。可以預先帶入既有的
// contact_email 當預設值,但允許改成不同的 email。送出後的提示文字區分「邀請信已寄出」跟
// 「這個 email 已經有秒約帳號,已直接開通登入」兩種情境文案(比照模組 3 §4.3 的既有精神)。
function InviteStaffLoginDialog({
  merchantId,
  staff,
  onInvited,
}: {
  merchantId: string;
  staff: MerchantStaff;
  onInvited: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loginEmail, setLoginEmail] = useState(staff.contact_email ?? "");
  const [inviting, setInviting] = useState(false);

  useEffect(() => {
    if (open) {
      setLoginEmail(staff.contact_email ?? "");
    }
  }, [open, staff.contact_email]);

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    if (!loginEmail.trim()) return;
    setInviting(true);
    try {
      const result = await inviteMerchantStaff({
        merchantId,
        staffId: staff.id,
        loginEmail,
      });
      setOpen(false);
      onInvited();
      if (result.alreadyHadAccount) {
        toast.success("已直接開通登入", {
          description: "這個 email 已經有秒約帳號,已直接開通登入,對方下次登入就能看到這間店。",
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          邀請登入
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>邀請「{staff.name}」開通登入</DialogTitle>
          <DialogDescription>
            對方會收到一封邀請信,點連結設定密碼後即可用手機登入;如果這個 email
            已經有秒約帳號,會直接開通登入。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleInvite} className="space-y-4">
          <div>
            <Label htmlFor={`staff-login-email-${staff.id}`}>登入 Email *</Label>
            <Input
              id={`staff-login-email-${staff.id}`}
              type="email"
              className="mt-2"
              value={loginEmail}
              onChange={(e) => setLoginEmail(e.target.value)}
              required
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={inviting || !loginEmail.trim()}>
              {inviting ? "送出中⋯" : "送出邀請"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// 對應規格書(帳號登入安全性優化)2.5.3:已開通登入的服務人員旁,顯示目前登入信箱狀態
// (2.4.3)+「修改登入信箱」入口(2.4.1/2.4.2)。只在 staff.login_status === 'active' 時
// 由呼叫端渲染這個元件(未開通登入的人不能設定登入信箱建議,見 2.4.1 邊界情況)。
function StaffLoginEmailManagement({ staff }: { staff: MerchantStaff }) {
  const queryClient = useQueryClient();
  const statusQuery = useStaffLoginEmailStatus(staff.id, true);
  const statusQueryKey = ["staff-agent-module", "staff-login-email-status", staff.id] as const;

  async function refetchStatus() {
    await queryClient.invalidateQueries({ queryKey: statusQueryKey });
  }

  async function handleSubmit(newEmail: string) {
    await requestStaffLoginEmailChange(staff.id, newEmail);
    await refetchStatus();
  }

  async function handleWithdraw() {
    await clearStaffPendingLoginEmail(staff.id);
    await refetchStatus();
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <LoginEmailStatusDisplay statusQuery={statusQuery} />
      <AdminSuggestLoginEmailDialog
        personLabel={staff.name}
        currentSuggestion={statusQuery.data?.pendingAdminSuggestedEmail}
        onSubmit={handleSubmit}
        onWithdraw={handleWithdraw}
      />
    </div>
  );
}

function StaffListInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();
  const [listFilter, setListFilter] = useState<StaffListFilter>("all");

  const { data: staffList, isLoading } = useQuery({
    queryKey: staffListQueryKey(merchantId),
    queryFn: () => fetchMerchantStaff(merchantId),
  });

  const filterCounts = useMemo(() => countStaffByFilter(staffList ?? []), [staffList]);

  const filteredStaffList = useMemo(
    () => (staffList ?? []).filter((staff) => matchesStaffListFilter(staff, listFilter)),
    [staffList, listFilter],
  );

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

  // 對應規格書「服務人員管理優化與硬刪除」§3.4:失敗時(通常是有歷史紀錄牽連,或不是
  // removed 狀態)用 getErrorMessage() 顯示資料庫端回傳的完整中文說明(已包含具體筆數),
  // 不要被截斷或改寫成通用文字。
  async function handleHardDelete(staffId: string) {
    try {
      await hardDeleteMerchantStaff(staffId);
      await refetch();
      toast.success("已真正刪除");
    } catch (err) {
      toast.error("無法真正刪除", { description: getErrorMessage(err) });
    }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
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
          <CardDescription>包含已上架、未上架與已移除的服務人員,可用下方分類篩選</CardDescription>
          {staffList && staffList.length > 0 ? (
            <Tabs
              value={listFilter}
              onValueChange={(v) => setListFilter(v as StaffListFilter)}
              className="pt-2"
            >
              <TabsList>
                {STAFF_LIST_FILTER_TABS.map((tab) => (
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
          ) : !staffList || staffList.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              目前還沒有任何服務人員,點右上角新增一位。
            </p>
          ) : filteredStaffList.length === 0 ? (
            <p className="text-sm text-muted-foreground">這個分類目前沒有服務人員。</p>
          ) : (
            <ul className="space-y-2">
              {filteredStaffList.map((staff) => (
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
                        <Badge variant="outline">
                          {staff.compensation_type === "monthly_salary" ? "月薪制" : "按件計酬"}
                        </Badge>
                        {/* 模組 14(服務人員端)規格書 4.7 第 1 點:登入狀態徽章。 */}
                        <Badge
                          variant={loginStatusBadgeVariant(staff.login_status as StaffLoginStatus)}
                        >
                          {STAFF_LOGIN_STATUS_LABELS[staff.login_status as StaffLoginStatus]}
                        </Badge>
                        {staff.status === "removed" ? (
                          <Badge variant="destructive">已移除</Badge>
                        ) : null}
                      </div>
                      {/* 對應規格書(帳號登入安全性優化)2.5.3 第 1 點:已開通登入才顯示登入信箱
                          狀態與修改入口。 */}
                      {staff.login_status === "active" ? (
                        <StaffLoginEmailManagement staff={staff} />
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {staff.status === "active" ? (
                      <>
                        {/* 模組 14(服務人員端)規格書 4.7 第 2 點:尚未開通登入時顯示邀請按鈕。
                            第 3 點(服務人員權限入口)留待該模組後續階段實作,這裡先不加。 */}
                        {staff.login_status === "not_invited" ? (
                          <InviteStaffLoginDialog
                            merchantId={merchantId}
                            staff={staff}
                            onInvited={refetch}
                          />
                        ) : null}
                        {staff.login_status === "active" ? (
                          <Button variant="outline" size="sm" asChild>
                            <Link to={`/app/staff/${staff.id}/permissions`}>服務人員權限</Link>
                          </Button>
                        ) : null}
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
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleReactivate(staff.id)}
                        >
                          恢復
                        </Button>
                        {/* 對應規格書「服務人員管理優化與硬刪除」§3.4:只在「已移除」狀態旁顯示,
                            用 variant="destructive" 讓視覺上明顯跟「恢復」不同,避免手滑點錯。 */}
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="destructive" size="sm">
                              真正刪除
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>確定要真正刪除「{staff.name}」嗎?</AlertDialogTitle>
                              <AlertDialogDescription>
                                這個動作無法復原!只有在這位服務人員完全沒有任何歷史訂單/請假/
                                抽成紀錄時,系統才會真的允許刪除;如果有歷史紀錄牽連,系統會擋下
                                並告訴你原因,這個人會維持「已移除」狀態。
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>取消</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleHardDelete(staff.id)}
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

export default function StaffListPage() {
  return (
    <RequireMerchantAdmin>
      <StaffListInner />
    </RequireMerchantAdmin>
  );
}
