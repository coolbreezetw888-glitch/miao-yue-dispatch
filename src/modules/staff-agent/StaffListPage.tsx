// 對應規格書 4.2:服務人員管理頁(新路由 /app/staff)。
// 清單 + 新增/編輯表單(姓名/暱稱/電話/Email/頭像上傳/簡介/上架開關)+ 服務項目勾選區塊
// (目前系統沒有任何服務項目,顯示空狀態文字,不報錯,見規格書 1.2 邊界情況)+
// 權限功能區塊(1.1.1 的 11 個欄位逐一列出,附白話說明)。
//
// ui-v1-full 第二階段第 1 批(2026-09-29,盤點 A3 / A4 / #4 / #5 / #6):
//   - 「新增 / 編輯服務人員」(10+ 欄)改用全頁層殼 FullPageLayer,底部固定「取消 / 儲存」等寬兩顆;
//     欄位改用 FormField / FieldInput / FieldTextarea / SwitchRow / ChoiceChip(skill 二之七),
//     服務項目多選從打勾方框改成可點的方塊。
//   - 「邀請登入」(1 欄)改用小卡窗 CardDialog;「移除」「真正刪除」確認窗改用 CardAlertDialog。
//   - 服務人員列改成 ListCard:右側只放「一顆主要動作 + 一個 ⋯」,其餘動作收進 ⋯。
//     尚未開通登入的整張變黃 + 待辦標籤,已移除整張變灰。因為觸發點變成選單項目,五個對話框改成
//     受控開關、整頁各只有一顆實例。
// 🔴 2026-09-30 使用者裁決(SPECS-INDEX #846):黃卡改成「只在這家商家已經有至少一位在職服務人員
//    開通登入時,其他尚未開通的人才標黃」。服務人員登入是選配功能,不用它的商家名單本來會永遠整頁黃,
//    黃色就失去「這張要你處理」的意義。判斷基準是整份名單(切分頁不會讓結果跟著變)、已移除的不算;
//    不標黃時「尚未開通登入」標籤仍然顯示,只是從 TodoTag 降級成 AttributeTag(中性、無警示感)。
//    邏輯在 staffListLogic.ts 的 merchantUsesStaffLogin / shouldMarkPendingLoginAsTodo(附單元測試),
//    規範在 .claude/skills/ui-overlay-patterns/SKILL.md 二之八末段。
//   - 篩選分頁籤改底線式、頁首改 PageHeader、載入中改骨架、空狀態補下一步按鈕(skill 二之八)。
// ui-v1-full 第二階段回填(2026-09-29 主腦裁決):
//   - 主要動作:「編輯」永遠是主要動作(已移除的人才換成「恢復」);「邀請登入」放 ⋯ 第一項。
//   - ⋯ 選單:「移除」是可逆的 ⇒ 一般項目不標紅,只有「真正刪除」紅字;「服務人員權限」改成真正的
//     連結(ListCard menuItems 的 `to`),可以右鍵 / 中鍵開新分頁。
//   - 計酬類型單選改 ChoiceChipGroup(radiogroup 語意);可預約時段的原生 select / time 改共用
//     FieldNativeSelect / FieldTime;表單全頁層改 size="wide"(760px)。
// **只動外觀與版面,不動任何行為**:按鈕顯示條件(isAdmin / login_status / status)、驗證、送出、
// 服務項目勾選即存、頭像上傳即存、可預約時段增刪,全部照舊。

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  ActionBar,
  AlertNote,
  AttributeTag,
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
  ChoiceChip,
  ChoiceChipGroup,
  EmptyState,
  FieldInput,
  FieldNativeSelect,
  FieldTextarea,
  FieldTime,
  FormField,
  FullPageLayer,
  FullPageLayerClose,
  FullPageLayerContent,
  ListCard,
  LoadingSkeleton,
  PageHeader,
  StatusTag,
  SwitchRow,
  TodoTag,
  UnderlineTabsList,
  UnderlineTabsTrigger,
  type ListCardMenuItem,
} from "@/components/patterns";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";

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
import { useCurrentMerchantRole, useStaffLoginEmailStatus } from "./context";
import { RequireStaffManagementAccess } from "./RequireStaffManagementAccess";
import { StaffAvatarUploader } from "./StaffAvatarUploader";
import {
  countStaffByFilter,
  matchesStaffListFilter,
  merchantUsesStaffLogin,
  shouldMarkPendingLoginAsTodo,
  STAFF_LIST_FILTER_TABS,
  validateStaffBookingDays,
  type StaffListFilter,
} from "./staffListLogic";
import {
  DEFAULT_MAX_BOOKING_DAYS_AHEAD,
  DEFAULT_MIN_ADVANCE_BOOKING_DAYS,
  MAX_BOOKING_DAYS_AHEAD_LIMIT,
  MIN_ADVANCE_BOOKING_DAYS_LIMIT,
  MIN_BOOKING_DAYS_AHEAD_LIMIT,
  STAFF_BOOLEAN_PERMISSION_FIELDS,
  STAFF_COMPENSATION_TYPE_LABELS,
  STAFF_LOGIN_STATUS_LABELS,
  STAFF_NUMBER_PERMISSION_FIELDS,
  type MerchantStaff,
  type StaffCompensationType,
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
  intro: "",
  avatarUrl: null,
  isListed: false,
  advanceBookingDays: null,
  bookingWindowMaxDays: null,
  noTimeSlotLimit: false,
  unlimitedBackendEdit: false,
  directAcceptAfterMerchantConfirm: false,
  autoAcceptBooking: false,
  showMemberInfo: false,
  googleCalendarSyncEnabled: false,
  canCreateEditOrders: false,
  canUploadConstructionPhotos: false,
  // 模組 7(排班與休假管理)§4.1/第〇節判斷 1:預先選取「抽成制」為預設選項,對既有資料
  // 行為影響最小,但要求管理員明確看過再送出,不是隱藏欄位。
  // ⚠️ 2026-09-24 使用者決定:畫面上的中文一律改稱「抽成制」(原本叫「按件計酬」,使用者認為
  //    不夠直覺)。資料庫存的值仍然是英文 'piece_rate',只有前端顯示文字改,不動資料庫。
  compensationType: "piece_rate",
};

function staffToFormState(staff: MerchantStaff): StaffFormState {
  return {
    name: staff.name,
    nickname: staff.nickname ?? "",
    phone: staff.phone ?? "",
    intro: staff.intro ?? "",
    avatarUrl: staff.avatar_url,
    isListed: staff.is_listed,
    advanceBookingDays: staff.advance_booking_days,
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

/** 全頁層表單裡每一個區塊的小標題(跟 FormField 的標籤同一套 13px 粗體)。 */
function FormSectionTitle({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] font-semibold leading-none text-foreground">{children}</p>;
}

/** 表單裡「目前還沒有 / 請先儲存」這類提示的虛線框。 */
function FormPlaceholder({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
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
    <div className="flex flex-col gap-2">
      <FormSectionTitle>可預約時段</FormSectionTitle>
      <p className="text-xs leading-relaxed text-muted-foreground">
        這位服務人員自己願意接單的時段,不必等於商家整體營業時間。
      </p>
      {/* skill 二:「現在的狀態跟使用者以為的不一樣」用 `!` 常駐——開了無時段限制,底下的設定會被忽略;
          或是完全沒設定時段,這個人其實還約不到。 */}
      <AlertNote>
        {noTimeSlotLimit
          ? "目前已開啟「無時段限制」,以下設定會被忽略,只受商家整體營業時間限制。"
          : "完全沒有設定任何時段時,這位服務人員這次還不可預約,除非開啟「無時段限制」。"}
      </AlertNote>

      {isLoading ? (
        <LoadingSkeleton variant="lines" rows={2} />
      ) : !windows || windows.length === 0 ? (
        <FormPlaceholder>尚未設定任何可預約時段</FormPlaceholder>
      ) : (
        <ul className="flex flex-col gap-2">
          {windows.map((w) => (
            <li key={w.id}>
              <ListCard
                title={
                  <span className="text-sm font-medium tabular-nums">
                    星期{DAY_OF_WEEK_LABELS[w.day_of_week]} {w.start_time.slice(0, 5)} -{" "}
                    {w.end_time.slice(0, 5)}
                  </span>
                }
                menuItems={[
                  { label: "刪除", danger: true, onSelect: () => void handleRemove(w.id) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}

      {/* skill 二之七:原生 select / time 用共用的 FieldNativeSelect / FieldTime(高度 / 圓角 / 字級由元件
          決定,這裡的 className 只管一列裡各佔多寬)。手機直向堆疊、電腦排成一列。 */}
      <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <FieldNativeSelect
          aria-label="星期"
          className="sm:w-32"
          value={dayOfWeek}
          onChange={(e) => setDayOfWeek(e.target.value)}
          options={DAY_OF_WEEK_LABELS.map((label, index) => ({
            value: String(index),
            label: `星期${label}`,
          }))}
        />
        <div className="flex items-center gap-2">
          <FieldTime
            aria-label="開始時間"
            className="flex-1 sm:w-36 sm:flex-none"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
          />
          <span className="shrink-0 text-sm text-muted-foreground">至</span>
          <FieldTime
            aria-label="結束時間"
            className="flex-1 sm:w-36 sm:flex-none"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
          />
        </div>
        <Button type="button" variant="neutral" size="touch" disabled={adding} onClick={handleAdd}>
          新增時段
        </Button>
      </div>
    </div>
  );
}

const STAFF_FORM_ID = "staff-form";

// 全頁層(盤點 A3 / A4):受控開關,新增與編輯共用同一個元件,只差 staff 是不是 null。
function StaffFormDialog({
  merchantId,
  staff,
  open,
  onOpenChange,
  onSaved,
}: {
  merchantId: string;
  staff: MerchantStaff | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const isEdit = Boolean(staff);
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
  // 用來判斷「商家是否有任何服務項目可選」跟渲染真正的多選清單,不是只讀已勾選數量。
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
    // 「預約天數」兩個欄位的驗證邏輯抽到 staffListLogic.ts 的 validateStaffBookingDays()
    // (純函式,有單元測試釘住負數/0/上限/小數/留空/跨欄位這些邊界)。這裡只負責把訊息丟給 toast。
    // 範圍必須跟資料庫端的 CHECK 約束一致,常數都放在 types.ts 兩邊共用,見那支函式的說明。
    const bookingDaysError = validateStaffBookingDays({
      advanceBookingDays: form.advanceBookingDays ?? null,
      bookingWindowMaxDays: form.bookingWindowMaxDays ?? null,
    });
    if (bookingDaysError) {
      toast.error(bookingDaysError);
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
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(isEdit ? "更新失敗" : "新增失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <FullPageLayer open={open} onOpenChange={onOpenChange}>
      {/* size="wide":這張表有兩欄格線 + 8 個開關列 + LINE / 推播區塊,560px 的電腦面板偏長,
          760px 較合適(2026-09-29 主腦同意)。手機無差(照樣滿版)。 */}
      <FullPageLayerContent
        title={isEdit ? "編輯服務人員" : "新增服務人員"}
        size="wide"
        footer={
          // skill 二之三:底部動作列等寬,階層靠顏色(取消白底 / 儲存實心)。儲存鈕在 <form> 外面,
          // 用 form 屬性指回表單,Enter 鍵與按鈕送出走同一個 handleSubmit。
          <ActionBar>
            <FullPageLayerClose asChild>
              <Button type="button" variant="neutral" size="touch">
                取消
              </Button>
            </FullPageLayerClose>
            <Button
              type="submit"
              form={STAFF_FORM_ID}
              variant="primary"
              size="touch"
              disabled={saving}
            >
              {saving ? "儲存中⋯" : "儲存"}
            </Button>
          </ActionBar>
        }
      >
        <form id={STAFF_FORM_ID} onSubmit={handleSubmit} className="flex flex-col gap-6">
          {/* 模組 14(服務人員端)上線後,原本這裡「服務人員這次不開放登入帳號」的說明文字已經過時
              (服務人員現在可以自己登入)——2026-09-21 使用者人工測試回報問題 1 修正:這裡只負責
              建立/編輯基本資料,登入帳號要等這裡儲存完成後,回到人員清單按「邀請登入」才會真的
              開通(見 4.7 第 2 點的 InviteStaffLoginDialog)。
              skill 二:這是「現在的狀態跟使用者以為的不一樣」(存了不等於能登入)→ `!` 常駐。 */}
          <AlertNote>
            {isEdit
              ? "這裡只會更新基本資料,不會影響登入帳號——登入帳號的開通/權限,請到人員清單使用「邀請登入」或「服務人員權限」。"
              : "這裡先建立基本資料,登入帳號要在儲存完成後,回到人員清單裡按「邀請登入」才會真的開通。"}
          </AlertNote>

          <div className="flex flex-col gap-4">
            <StaffAvatarUploader currentAvatarUrl={form.avatarUrl} onUpload={handleAvatarUpload} />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="姓名" htmlFor="staff-name" required>
                <FieldInput
                  id="staff-name"
                  value={form.name}
                  onChange={(e) => setField("name", e.target.value)}
                  required
                />
              </FormField>
              <FormField label="暱稱(對客戶顯示)" htmlFor="staff-nickname">
                <FieldInput
                  id="staff-nickname"
                  value={form.nickname ?? ""}
                  onChange={(e) => setField("nickname", e.target.value)}
                />
              </FormField>
              <FormField
                label="電話"
                htmlFor="staff-phone"
                required
                helpLabel="說明:電話要怎麼填"
                help="請輸入台灣手機號碼,09 開頭共 10 碼數字,例如 0912345678。"
              >
                <FieldInput
                  id="staff-phone"
                  type="tel"
                  inputMode="numeric"
                  value={form.phone ?? ""}
                  onChange={(e) => setField("phone", e.target.value)}
                  placeholder="0912345678"
                  required
                />
              </FormField>
              {/* ⚠️ 這裡原本有一個「對外聯絡 Email」欄位(merchant_staff.contact_email)。
                  2026-09-24 使用者裁決把它整個廢除了(欄位本身也 drop 了,見 migration
                  20260924040800):
                    「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的信箱)」
                    「A,客服和服務人員應該也是一樣只需要一個 Email 即可。」
                  服務人員唯一的 Email 就是登入 Email——在人員清單上按「邀請登入」時輸入。
                  (2026-09-21 使用者人工測試回報的問題 2「這個欄位容易被誤會成登入帳號」,
                   這次是用「拿掉那個欄位」根本解決,不再需要那段說明文字。)
                  不要把這個欄位加回來。 */}
            </div>

            <FormField label="簡介" htmlFor="staff-intro">
              <FieldTextarea
                id="staff-intro"
                rows={3}
                value={form.intro ?? ""}
                onChange={(e) => setField("intro", e.target.value)}
              />
            </FormField>

            <SwitchRow
              title="上架"
              description="開啟後客戶或客服可以選擇預約這位服務人員。"
              checked={form.isListed ?? false}
              onCheckedChange={(v) => setField("isListed", v)}
            />

            {/* 模組 7(排班與休假管理)§4.1:計酬類型單選,預設選取「抽成制」(第〇節判斷 1)。
                只有月薪制的服務人員才能登記請假紀錄(規則 2.2),抽成制對應的是「調整可預約
                時段」(既有的 staff_availability_windows/unlimited_backend_edit 機制)。
                ⚠️ 2026-09-24:選項的中文從「按件計酬」改成「抽成制」,底層的值 'piece_rate'
                   完全不動(資料庫存的是英文,中文只在這一層顯示)。
                ui-v1-full:單選改成 ChoiceChipGroup(skill 二之七,radiogroup 語意、方向鍵可切換),
                值直接來自常數白名單。 */}
            <FormField
              label="計酬類型"
              helpLabel="說明:計酬類型會影響什麼"
              help="月薪制服務人員才能登記請假紀錄(見「請假紀錄」功能);抽成制則是用「可預約時段」調整接單時間。"
            >
              <ChoiceChipGroup
                aria-label="計酬類型"
                value={form.compensationType ?? "piece_rate"}
                onValueChange={(type) => setField("compensationType", type)}
                options={(["piece_rate", "monthly_salary"] as StaffCompensationType[]).map(
                  (type) => ({ value: type, label: STAFF_COMPENSATION_TYPE_LABELS[type] }),
                )}
              />
            </FormField>
          </div>

          <div className="flex flex-col gap-2">
            <FormSectionTitle>服務項目</FormSectionTitle>
            {/* 模組 4 規格書 4.4:先判斷「商家是否有任何 status='active' 的服務項目」,
                不是只看「這位服務人員目前已勾選幾項」——避免把「商家根本沒有服務項目可選」
                跟「有服務項目、只是這位人員還沒被勾選任何一項」這兩種情況搞混。
                ui-v1-full:多選改成可點的方塊(skill 二之七:選中 = 主題色框 + 勾,手機好按),
                點一下就立刻寫入 / 移除關聯(行為跟原本的打勾方框一模一樣)。 */}
            {activeServiceItemsLoading ? (
              <LoadingSkeleton variant="lines" rows={2} />
            ) : !merchantHasAnyServiceItems ? (
              <FormPlaceholder>目前尚無服務項目可選,請先到服務項目管理設定</FormPlaceholder>
            ) : !staff ? (
              <FormPlaceholder>
                請先儲存這位服務人員的基本資料,儲存後重新點選「編輯」即可勾選服務項目。
              </FormPlaceholder>
            ) : (
              <div className="flex flex-wrap gap-2">
                {activeServiceItems!.map((item) => {
                  const checked = serviceItemIds?.includes(item.id) ?? false;
                  return (
                    <ChoiceChip
                      key={item.id}
                      selected={checked}
                      onClick={() => handleToggleServiceItem(item.id, !checked)}
                      className="max-w-full"
                    >
                      <span className="min-w-0 break-words text-left">
                        {item.name}
                        {/* 分類名稱是商家自訂文字、長度不固定,放在名稱後面用淡字帶過。 */}
                        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                          {categoryName(item.category_id)} ・ ${Number(item.price).toFixed(0)}
                        </span>
                      </span>
                    </ChoiceChip>
                  );
                })}
                {removedSelectedItems && removedSelectedItems.length > 0
                  ? removedSelectedItems.map((item) => (
                      <ChoiceChip
                        key={item.id}
                        selected
                        onClick={() => handleToggleServiceItem(item.id, false)}
                        className="max-w-full border-dashed opacity-70"
                      >
                        <span className="min-w-0 break-words text-left">
                          {item.name}
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            (已下架)
                          </span>
                          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                            {categoryName(item.category_id)} ・ ${Number(item.price).toFixed(0)}
                          </span>
                        </span>
                      </ChoiceChip>
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
            <div className="flex flex-col gap-2">
              <FormSectionTitle>可預約時段</FormSectionTitle>
              <FormPlaceholder>
                請先儲存這位服務人員的基本資料,儲存後重新點選「編輯」即可設定可預約時段。
              </FormPlaceholder>
            </div>
          )}

          <div className="flex flex-col gap-3">
            <FormSectionTitle>權限功能</FormSectionTitle>
            {/* skill 二:「現在的狀態跟使用者以為的不一樣」(開了不等於生效)→ `!` 常駐,不收進 `?`。 */}
            <AlertNote>這些開關目前先存值,對應的功能上線後才會實際生效。</AlertNote>
            {/* 2026-09-24 使用者裁決:三個「預約天數」欄位收斂成兩個(見 types.ts
                STAFF_NUMBER_PERMISSION_FIELDS 上方的完整裁決註解)。欄位數從 3 變 2,所以格線
                也從 sm:grid-cols-3 改成 sm:grid-cols-2,兩欄才不會留下一格空白。 */}
            <div className="grid gap-4 sm:grid-cols-2">
              {STAFF_NUMBER_PERMISSION_FIELDS.map((field) => {
                // 明確窄化成兩個具體欄位(而不是用泛型 toCamel),避免 form[key] 的型別被推成
                // StaffFormState 全部欄位型別的聯集(含 boolean),導致 <input value> 型別檢查出錯。
                const numberKey: "advanceBookingDays" | "bookingWindowMaxDays" =
                  field.key === "advance_booking_days"
                    ? "advanceBookingDays"
                    : "bookingWindowMaxDays";
                return (
                  <FormField
                    key={field.key}
                    label={field.label}
                    htmlFor={`staff-${field.key}`}
                    helpLabel={`說明:${field.label}怎麼填`}
                    help={field.description}
                  >
                    {/* min/max:刻意跟資料庫端的 CHECK 約束對齊(常數都在 types.ts,兩邊共用同一份)。
                        ・「最少要提前幾天」:min=0,對應資料庫的 advance_booking_days >= 0。
                          這條約束是 2026-09-24 資料庫工程師主動補的——原本這欄完全沒有約束,
                          打 -5 會被靜默存進資料庫,之後實作預約邏輯的人就會拿到一個荒謬的值。
                        ・「最遠可以預約到幾天後」:min=0、max=3650,對應資料庫的
                          `between 0 and 3650`(舊的 3~180 會擋掉使用者自己舉例的 365,已放寬;
                          3650 ≈ 10 年,純粹防打錯字,避免多打幾個 0 變成 99999 天)。
                          下限 2026-09-24 從 1 放寬成 0——0 = 最遠只能約到今天 = 只接受當天預約
                          當天服務(使用者澄清後的定義)。資料庫那條約束的放寬還在進行中,見
                          types.ts 的 MIN_BOOKING_DAYS_AHEAD_LIMIT 說明。
                        這兩個 HTML 屬性只讓瀏覽器的數字微調鈕不走出範圍,真正的擋關在
                        validateStaffBookingDays()(給白話中文訊息),資料庫的 CHECK 再擋第三層。
                        placeholder:兩個欄位留空時會套用的預設值不一樣(0 天 vs 180 天),光靠下方
                        說明文字容易被略過,所以直接把留空時會用的數字顯示在空白輸入框裡。文案句型
                        跟說明文字統一成「留空 = N 天」(2026-09-24 主腦裁決),兩欄一致。 */}
                    <FieldInput
                      id={`staff-${field.key}`}
                      type="number"
                      inputMode="numeric"
                      className="tabular-nums"
                      min={
                        field.key === "advance_booking_days"
                          ? MIN_ADVANCE_BOOKING_DAYS_LIMIT
                          : MIN_BOOKING_DAYS_AHEAD_LIMIT
                      }
                      max={
                        field.key === "advance_booking_days"
                          ? undefined
                          : MAX_BOOKING_DAYS_AHEAD_LIMIT
                      }
                      placeholder={
                        field.key === "advance_booking_days"
                          ? `留空 = ${DEFAULT_MIN_ADVANCE_BOOKING_DAYS} 天`
                          : `留空 = ${DEFAULT_MAX_BOOKING_DAYS_AHEAD} 天`
                      }
                      value={form[numberKey] ?? ""}
                      onChange={(e) =>
                        setField(numberKey, e.target.value === "" ? null : Number(e.target.value))
                      }
                    />
                  </FormField>
                );
              })}
            </div>
            <div className="flex flex-col gap-2">
              {STAFF_BOOLEAN_PERMISSION_FIELDS.map((field) => (
                <SwitchRow
                  key={field.key}
                  title={field.label}
                  description={field.description}
                  checked={Boolean(form[toCamel(field.key)])}
                  onCheckedChange={(v) => setField(toCamel(field.key), v)}
                />
              ))}
            </div>
          </div>

          {/* 模組 11(LINE 通知)§4.6:服務人員詳情/編輯頁疊加「LINE 綁定」區塊,只有編輯既有
              服務人員(已經有 staff.id)時才顯示,新增流程還沒有 id 可以綁定。 */}
          {isEdit && staff ? <StaffLineBindingSection staffId={staff.id} /> : null}
          {/* 模組 15(服務人員推播通知)§7.5(選配):同樣只在編輯既有服務人員時顯示。 */}
          {isEdit && staff ? <StaffPushSubscriptionSummary staffId={staff.id} /> : null}
        </form>
      </FullPageLayerContent>
    </FullPageLayer>
  );
}

// snake_case 欄位 key 轉成 StaffFormState 的 camelCase key,避免逐一手寫對照表。
function toCamel<K extends keyof StaffFormState>(key: string): K {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) as K;
}

const INVITE_FORM_ID = "invite-staff-login-form";

// 模組 14(服務人員端)規格書 4.7 第 2 點:邀請服務人員登入的小卡窗(盤點 #4,1 欄)。
// ⚠️ 2026-09-24 使用者裁決之後,這個欄位**沒有預設值**,一律由管理員手動輸入。
//    原本規格書寫「可以預先帶入既有的 contact_email 當預設值」,但 contact_email 這個欄位已經
//    整個廢除了(「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的信箱)」
//    「A,客服和服務人員應該也是一樣只需要一個 Email 即可。」),沒有其他欄位可以拿來預填
//    ——這裡輸入的 Email 從此就是這位服務人員**唯一**的 Email。
//    留空比亂猜一個好:預填一個猜的值,管理員很可能直接按下送出,邀請信就寄到錯的信箱。
// 送出後的提示文字區分「邀請信已寄出」跟
// 「這個 email 已經有秒約帳號,已直接開通登入」兩種情境文案(比照模組 3 §4.3 的既有精神)。
function InviteStaffLoginDialog({
  merchantId,
  staff,
  open,
  onOpenChange,
  onInvited,
}: {
  merchantId: string;
  staff: MerchantStaff | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvited: () => void;
}) {
  const [loginEmail, setLoginEmail] = useState("");
  const [inviting, setInviting] = useState(false);

  // 每次打開對話框都清空(而不是留著上次沒送出的內容),沿用本檔案其他對話框的既有慣例。
  // 沒有可以預填的來源了,理由見上方註解。
  useEffect(() => {
    if (open) {
      setLoginEmail("");
    }
  }, [open]);

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    if (!staff) return;
    if (!loginEmail.trim()) return;
    setInviting(true);
    try {
      const result = await inviteMerchantStaff({
        merchantId,
        staffId: staff.id,
        loginEmail,
      });
      onOpenChange(false);
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
    <CardDialog open={open} onOpenChange={onOpenChange}>
      <CardDialogContent>
        <CardDialogHeader>
          <CardDialogTitle className="break-words">邀請「{staff?.name}」開通登入</CardDialogTitle>
          <CardDialogDescription>
            對方會收到一封邀請信,點連結設定密碼後即可用手機登入;如果這個 email
            已經有秒約帳號,會直接開通登入。
          </CardDialogDescription>
        </CardDialogHeader>
        <form id={INVITE_FORM_ID} onSubmit={handleInvite}>
          <FormField label="登入 Email" htmlFor="staff-login-email" required>
            <FieldInput
              id="staff-login-email"
              type="email"
              value={loginEmail}
              onChange={(e) => setLoginEmail(e.target.value)}
              required
            />
          </FormField>
        </form>
        <CardDialogFooter>
          <CardDialogClose asChild>
            <Button type="button" variant="neutral" size="touch">
              取消
            </Button>
          </CardDialogClose>
          <Button
            type="submit"
            form={INVITE_FORM_ID}
            variant="primary"
            size="touch"
            disabled={inviting || !loginEmail.trim()}
          >
            {inviting ? "送出中⋯" : "送出邀請"}
          </Button>
        </CardDialogFooter>
      </CardDialogContent>
    </CardDialog>
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
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
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
  // 使用者決策(2026-09-23):「服務人員管理」開放給有 staff_management 權限的客服使用,但邀請
  // 服務人員登入(帳號/密碼授權)、指派服務人員權限、真正刪除這三項比照「客服管理」同一類的
  // 帳號/敏感操作,維持永遠只給商家管理員(見下方各自的 isAdmin 判斷)——底層 Edge Function
  // invite-merchant-staff、RPC set_staff_permission、hard_delete_merchant_staff 也都還是只認
  // is_merchant_admin,這裡的 isAdmin 判斷只是提早不顯示這些操作入口,避免客服點了才發現被擋。
  const { data: merchantRole } = useCurrentMerchantRole();
  const isAdmin = merchantRole === "admin";
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

  // 🔴 #846(2026-09-30 使用者裁決):這家商家「有沒有真的在用服務人員登入功能」。
  // 只有 true 時,其他「尚未開通登入」的人才標黃卡(理由與規則寫在 staffListLogic.ts 的說明區塊,
  // 規範在 .claude/skills/ui-overlay-patterns/SKILL.md 二之八末段)。
  // 🔴 相依陣列刻意是 `staffList`(整份未篩選的名單)**不是** `filteredStaffList` ——
  //    切分頁不可以讓黃不黃的結果跟著變。
  const usesStaffLogin = useMemo(() => merchantUsesStaffLogin(staffList ?? []), [staffList]);

  // ui-v1-full:五個對話框的受控開關(觸發點在 ListCard 的按鈕 / ⋯ 選單裡)。編輯 / 邀請用
  // 「記住是哪一位 + 開關」兩個 state,關閉時只關開關、不清掉人,避免關閉動畫期間內容閃動。
  const [createOpen, setCreateOpen] = useState(false);
  const [editingStaff, setEditingStaff] = useState<MerchantStaff | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [invitingStaff, setInvitingStaff] = useState<MerchantStaff | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removingStaff, setRemovingStaff] = useState<MerchantStaff | null>(null);
  const [hardDeletingStaff, setHardDeletingStaff] = useState<MerchantStaff | null>(null);

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
      <PageHeader
        backTo="/app/manage"
        title="服務人員管理"
        description={`「${merchant!.name}」的服務人員名錄`}
        action={
          <Button type="button" variant="primary" size="touch" onClick={() => setCreateOpen(true)}>
            新增服務人員
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>服務人員名單</CardTitle>
          <CardDescription>包含已上架、未上架與已移除的服務人員,可用下方分類篩選</CardDescription>
          {staffList && staffList.length > 0 ? (
            <Tabs
              value={listFilter}
              onValueChange={(v) => setListFilter(v as StaffListFilter)}
              className="pt-2"
            >
              {/* ui-v1-full:篩選分頁籤改成底線式切換列(skill 二之四),數量用 count 顯示在文字後面。
                  🔴 variant="filter":四顆篩選必須在 320px 一眼全部看到——不橫向捲、不換行、不截字
                  (2026-09-29 使用者裁決;第 1 批做成橫向捲動時第四顆「已移除」要滑才看得到)。
                  換行也不行,會讓下面的內容整個往下跳。 */}
              <UnderlineTabsList variant="filter">
                {STAFF_LIST_FILTER_TABS.map((tab) => (
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
          ) : !staffList || staffList.length === 0 ? (
            <EmptyState
              title="還沒有任何服務人員"
              description="新增服務人員後,就能為他們排預約、設定可預約時段與服務項目。"
              action={
                <Button
                  type="button"
                  variant="primary"
                  size="touch"
                  onClick={() => setCreateOpen(true)}
                >
                  新增第一位服務人員
                </Button>
              }
            />
          ) : filteredStaffList.length === 0 ? (
            <p className="text-sm text-muted-foreground">這個分類目前沒有服務人員。</p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {filteredStaffList.map((staff) => {
                const loginStatus = staff.login_status as StaffLoginStatus;
                const isRemoved = staff.status !== "active";
                // 🔴 #846:「尚未開通登入」要不要當成待辦(整張卡變黃 + 待辦標籤)。
                // false 時標籤照樣顯示,只是降級成中性的屬性標籤、卡片不變黃。
                const pendingLoginIsTodo = shouldMarkPendingLoginAsTodo(staff, usesStaffLogin);
                // 模組 14(服務人員端)規格書 4.7 第 2 點:尚未開通登入時顯示邀請入口(只給管理員)。
                const canInvite = isAdmin && !isRemoved && loginStatus === "not_invited";
                // 2026-09-29 主腦裁決(skill 二之三「位置固定」的精神是不要讓人每次都得重新找):
                //   - 「編輯」是天天用的動作 ⇒ 永遠是主要動作;唯一例外是已移除的人(主要動作換成「恢復」,
                //     那時編輯沒有意義)。
                //   - 「邀請登入」一個人一輩子按一次 ⇒ 放 ⋯ 選單第一項(顯示條件 canInvite 照舊)。
                //   - 「服務人員權限」是跳頁 ⇒ 用 `to`(底層是真正的 <Link>,可右鍵 / 中鍵開新分頁)。
                //   - 「移除」是可逆的(有「恢復」)⇒ 一般項目、不標紅;只有不可逆的「真正刪除」才紅字。
                const menuItems: ListCardMenuItem[] | undefined = isRemoved
                  ? isAdmin
                    ? [
                        // 對應規格書「服務人員管理優化與硬刪除」§3.4:只在「已移除」狀態出現。
                        // 2026-09-23:「真正刪除」不在服務人員管理開放給客服的範圍內,永遠只給商家
                        // 管理員(底層 hard_delete_merchant_staff 也是同一個限制)。
                        {
                          label: "真正刪除",
                          danger: true,
                          onSelect: () => setHardDeletingStaff(staff),
                        },
                      ]
                    : undefined
                  : [
                      ...(canInvite
                        ? [
                            {
                              label: "邀請登入",
                              onSelect: () => {
                                setInvitingStaff(staff);
                                setInviteOpen(true);
                              },
                            },
                          ]
                        : []),
                      ...(isAdmin && loginStatus === "active"
                        ? [{ label: "服務人員權限", to: `/app/staff/${staff.id}/permissions` }]
                        : []),
                      { label: "移除", onSelect: () => setRemovingStaff(staff) },
                    ];

                return (
                  <li key={staff.id}>
                    {/* skill 二之五 列表卡片:頭像 → 姓名 + 狀態標籤 + 屬性標籤 + 待辦標籤 → 次要資訊
                        (登入信箱狀態)→ 右側「一顆主要動作 + ⋯」。已移除整張變灰、名稱變淡。
                        🔴 #846:「尚未開通登入」只在這家已經有人開通登入時才整張變黃(見上方
                        pendingLoginIsTodo),否則維持一般白卡 —— 不用登入功能的商家名單不該整頁黃。 */}
                    <ListCard
                      state={isRemoved ? "inactive" : pendingLoginIsTodo ? "attention" : "default"}
                      leading={
                        <Avatar className="h-10 w-10">
                          {staff.avatar_url ? (
                            <AvatarImage src={staff.avatar_url} alt={staff.name} />
                          ) : null}
                          <AvatarFallback className="bg-brand-soft text-sm font-semibold text-brand">
                            {staff.name.slice(0, 1)}
                          </AvatarFallback>
                        </Avatar>
                      }
                      title={
                        <>
                          {staff.name}
                          {staff.nickname ? `(${staff.nickname})` : ""}
                        </>
                      }
                      tags={
                        <>
                          {/* 狀態標籤一個人只有一個:已移除優先;否則看上架與否。 */}
                          {isRemoved ? (
                            <StatusTag tone="danger">已移除</StatusTag>
                          ) : staff.is_listed ? (
                            <StatusTag tone="success">已上架</StatusTag>
                          ) : (
                            <StatusTag tone="neutral">未上架</StatusTag>
                          )}
                          {/* 2026-09-24:標籤文字「按件計酬」→「抽成制」,判斷用的欄位值不變。 */}
                          <AttributeTag>
                            {
                              STAFF_COMPENSATION_TYPE_LABELS[
                                staff.compensation_type as StaffCompensationType
                              ]
                            }
                          </AttributeTag>
                          {/* 模組 14(服務人員端)規格書 4.7 第 1 點:登入狀態。
                              邀請信已寄出 = 等對方動作的黃色狀態;已開通則由下方「登入信箱:…」那行
                              表達,不再多一顆標籤。已移除的人不顯示登入標籤(沒有動作可做)。

                              🔴 #846(2026-09-30 使用者裁決):「尚未開通登入」這個標籤**一定要顯示**
                              (它是事實資訊,而且「邀請登入」就在 ⋯ 選單裡,使用者需要知道現在是什麼狀態),
                              但樣式分兩種:
                                - 這家已經有人開通登入 ⇒ 真的是待辦 ⇒ TodoTag(黃底 + `!`)
                                - 這家一位都沒開通 ⇒ 這是「永久狀態」不是待辦 ⇒ 降級成 AttributeTag
                                  (方角灰底、安靜、沒有警示感),卡片也不變黃。
                              skill 二之八末段的通則:「標成待辦之前先問一句,這個狀態對某些使用者
                              是不是永久狀態?」是的話它就是屬性,屬性不給警示色。 */}
                          {!isRemoved && loginStatus === "not_invited" ? (
                            pendingLoginIsTodo ? (
                              <TodoTag>尚未開通登入</TodoTag>
                            ) : (
                              <AttributeTag>尚未開通登入</AttributeTag>
                            )
                          ) : null}
                          {!isRemoved && loginStatus === "invited" ? (
                            <StatusTag tone="warning">
                              {STAFF_LOGIN_STATUS_LABELS.invited}
                            </StatusTag>
                          ) : null}
                        </>
                      }
                      meta={
                        // 對應規格書(帳號登入安全性優化)2.5.3 第 1 點:已開通登入才顯示登入信箱
                        // 狀態與修改入口。
                        loginStatus === "active" ? (
                          <StaffLoginEmailManagement staff={staff} />
                        ) : null
                      }
                      primaryAction={
                        isRemoved ? (
                          <Button
                            type="button"
                            variant="neutral"
                            size="card"
                            onClick={() => handleReactivate(staff.id)}
                          >
                            恢復
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="neutral"
                            size="card"
                            onClick={() => {
                              setEditingStaff(staff);
                              setEditOpen(true);
                            }}
                          >
                            編輯
                          </Button>
                        )
                      }
                      menuItems={menuItems}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* 全頁層(盤點 A3):新增。 */}
      <StaffFormDialog
        merchantId={merchantId}
        staff={null}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={refetch}
      />
      {/* 全頁層(盤點 A4):編輯。 */}
      <StaffFormDialog
        merchantId={merchantId}
        staff={editingStaff}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={refetch}
      />
      {/* 小卡窗(盤點 #4):邀請登入。 */}
      <InviteStaffLoginDialog
        merchantId={merchantId}
        staff={invitingStaff}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={refetch}
      />

      {/* 小卡窗(盤點 #5):移除(軟刪除)確認。 */}
      <CardAlertDialog
        open={removingStaff !== null}
        onOpenChange={(open) => {
          if (!open) setRemovingStaff(null);
        }}
      >
        <CardAlertDialogContent>
          <CardAlertDialogHeader>
            <CardAlertDialogTitle>確定要移除這位服務人員嗎?</CardAlertDialogTitle>
            <CardAlertDialogDescription>
              這是軟刪除,資料不會不見,之後隨時可以重新上架恢復。
            </CardAlertDialogDescription>
          </CardAlertDialogHeader>
          <CardAlertDialogFooter>
            <CardAlertDialogCancel>取消</CardAlertDialogCancel>
            <CardAlertDialogAction
              tone="danger"
              onClick={() => {
                if (removingStaff) void handleRemove(removingStaff.id);
              }}
            >
              確定移除
            </CardAlertDialogAction>
          </CardAlertDialogFooter>
        </CardAlertDialogContent>
      </CardAlertDialog>

      {/* 小卡窗(盤點 #6):真正刪除(不可逆)確認,文案照舊。 */}
      <CardAlertDialog
        open={hardDeletingStaff !== null}
        onOpenChange={(open) => {
          if (!open) setHardDeletingStaff(null);
        }}
      >
        <CardAlertDialogContent>
          <CardAlertDialogHeader>
            <CardAlertDialogTitle className="break-words">
              確定要真正刪除「{hardDeletingStaff?.name}」嗎?
            </CardAlertDialogTitle>
            <CardAlertDialogDescription>
              這個動作無法復原!只有在這位服務人員完全沒有任何歷史訂單/請假/
              抽成紀錄時,系統才會真的允許刪除;如果有歷史紀錄牽連,系統會擋下
              並告訴你原因,這個人會維持「已移除」狀態。
            </CardAlertDialogDescription>
          </CardAlertDialogHeader>
          <CardAlertDialogFooter>
            <CardAlertDialogCancel>取消</CardAlertDialogCancel>
            <CardAlertDialogAction
              tone="danger"
              onClick={() => {
                if (hardDeletingStaff) void handleHardDelete(hardDeletingStaff.id);
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

export default function StaffListPage() {
  return (
    <RequireStaffManagementAccess>
      <StaffListInner />
    </RequireStaffManagementAccess>
  );
}
