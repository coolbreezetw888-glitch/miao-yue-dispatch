// 對應規格書 4.3(行事曆總覽頁)、4.4(手動建單表單)、4.5(標記完成/取消預約操作),
// 建單功能擴充第一節(月/週切換、日期預約標示、排程色塊視覺優化)、5.1(建單表單擴充)、
// 5.2(預約詳情操作按鈕擴充)、5.3(編輯預約表單)。
//
// 时区說明:系統目前假設所有商家都在 Asia/Taipei(規格書「本模組明確不做的事」),這裡的日期/時間
// 一律以 Asia/Taipei 的日曆日/時鐘時間為準,送往後端的 start_at 一律明確帶 +08:00 偏移量,
// 不依賴瀏覽器本機時區(避免使用者瀏覽器時區設定不是台灣時導致算錯)。

import { useEffect, useMemo, useState } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { cn } from "@/lib/utils";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { getFeatureFlag } from "@/modules/merchant/api";
import { useMerchantStaffList } from "@/modules/staff-agent/context";
import { useMerchantServiceItems } from "@/modules/service-items/context";

import {
  cancelBooking,
  completeBooking,
  confirmBooking,
  createBooking,
  getBooking,
  updateBooking,
  MATERIAL_COST_ENABLED_FEATURE_KEY,
} from "./api";
import {
  useMerchantBookings,
  useMerchantDaySchedule,
  useMerchantMaterialCostItems,
} from "./context";
import {
  addDays,
  addMonths,
  buildMonthGrid,
  buildTaipeiIso,
  getTaipeiNow,
  isoToTaipeiDateKey,
  isoToTaipeiTime,
  minutesToTime,
  startOfMonth,
  startOfWeek,
  timeToMinutes,
  toDateKey,
} from "./dateUtils";
import { RequireBookingAccess } from "./RequireBookingAccess";
import { BOOKING_STATUS_LABELS, type BookingStatus, type DayScheduleOwnBooking } from "./types";

const SLOT_MINUTES = 30;
const SLOT_PX = 30;

type CalendarViewMode = "week" | "month";

/** 建單功能擴充規格書 2.3:料錢成本功能開關(查無資料視為關閉)。跟 BusinessHoursPage.tsx
 * 的 MaterialCostEnabledToggle 共用同一個 feature key,這裡只需要唯讀查詢決定表單要不要顯示。 */
function useMaterialCostEnabled(merchantId: string) {
  return useQuery({
    queryKey: ["booking-module", "material-cost-enabled", merchantId],
    queryFn: async () => {
      const value = await getFeatureFlag(merchantId, MATERIAL_COST_ENABLED_FEATURE_KEY);
      return value ?? false;
    },
  });
}

// ---------------------------------------------------------------------------
// 5.1/5.3:手動建單表單 + 編輯預約表單(共用同一個對話框元件,決策記錄 6/規格書 5.3)。
// ---------------------------------------------------------------------------
interface BookingFormPrefill {
  staffId?: string;
  dateKey?: string;
  time?: string;
}

function BookingFormDialog({
  merchantId,
  open,
  onOpenChange,
  prefill,
  editingBookingId,
  onSaved,
}: {
  merchantId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefill: BookingFormPrefill;
  editingBookingId: string | null;
  onSaved: () => void;
}) {
  const isEdit = Boolean(editingBookingId);
  const { data: staffList } = useMerchantStaffList(merchantId);
  const { data: serviceItems } = useMerchantServiceItems(merchantId);
  const { data: materialCostItems } = useMerchantMaterialCostItems(merchantId);
  const { data: materialCostEnabled } = useMaterialCostEnabled(merchantId);

  const { data: editingDetail } = useQuery({
    queryKey: ["booking-module", "edit-detail", editingBookingId],
    queryFn: () => getBooking(editingBookingId as string),
    enabled: open && Boolean(editingBookingId),
  });

  const [staffId, setStaffId] = useState("");
  const [serviceItemIds, setServiceItemIds] = useState<string[]>([]);
  const [assistantStaffIds, setAssistantStaffIds] = useState<string[]>([]);
  const [materialCostItemIds, setMaterialCostItemIds] = useState<string[]>([]);
  const [dateKey, setDateKey] = useState("");
  const [time, setTime] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  // 每次開啟時重設表單:新建模式依 prefill,編輯模式等 editingDetail 載入後帶入既有值。
  useEffect(() => {
    if (!open) return;
    if (isEdit) {
      if (!editingDetail) return; // 還在載入中,等資料回來再帶入
      setStaffId(editingDetail.staff_id);
      setServiceItemIds(editingDetail.serviceItems.map((i) => i.id));
      setAssistantStaffIds(editingDetail.assistants.map((a) => a.staffId));
      setMaterialCostItemIds(editingDetail.materialCosts.map((c) => c.materialCostItemId));
      setDateKey(isoToTaipeiDateKey(editingDetail.start_at));
      setTime(isoToTaipeiTime(editingDetail.start_at));
      setCustomerName(editingDetail.customer_name);
      setCustomerPhone(editingDetail.customer_phone);
      setCustomerEmail(editingDetail.customer_email ?? "");
      setNotes(editingDetail.notes ?? "");
    } else {
      setStaffId(prefill.staffId ?? "");
      setServiceItemIds([]);
      setAssistantStaffIds([]);
      setMaterialCostItemIds([]);
      setDateKey(prefill.dateKey ?? toDateKey(getTaipeiNow()));
      setTime(prefill.time ?? "10:00");
      setCustomerName("");
      setCustomerPhone("");
      setCustomerEmail("");
      setNotes("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isEdit, editingDetail]);

  const totalDurationMinutes = useMemo(() => {
    return serviceItemIds.reduce((sum, id) => {
      const item = (serviceItems ?? []).find((s) => s.id === id);
      return sum + (item?.duration_minutes ?? 0);
    }, 0);
  }, [serviceItemIds, serviceItems]);

  const materialCostTotal = useMemo(() => {
    return materialCostItemIds.reduce((sum, id) => {
      const item = (materialCostItems ?? []).find((m) => m.id === id);
      return sum + (item ? Number(item.amount) : 0);
    }, 0);
  }, [materialCostItemIds, materialCostItems]);

  function toggleInArray(current: string[], id: string): string[] {
    return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
  }

  async function handleSubmit() {
    if (!staffId) {
      toast.error("請選擇服務人員");
      return;
    }
    if (serviceItemIds.length === 0) {
      toast.error("請至少選擇一個服務項目");
      return;
    }
    if (!dateKey || !time) {
      toast.error("請選擇日期與時間");
      return;
    }
    if (!customerName.trim()) {
      toast.error("請填寫客戶姓名");
      return;
    }
    if (!customerPhone.trim()) {
      toast.error("請填寫客戶電話");
      return;
    }

    setSaving(true);
    try {
      const shared = {
        staffId,
        serviceItemIds,
        startAt: buildTaipeiIso(dateKey, time),
        customerName,
        customerPhone,
        customerEmail: customerEmail.trim() ? customerEmail.trim() : null,
        notes: notes.trim() ? notes.trim() : null,
        assistantStaffIds,
        materialCostItemIds,
      };

      if (isEdit && editingBookingId) {
        await updateBooking({ bookingId: editingBookingId, ...shared });
        toast.success("已更新預約");
      } else {
        await createBooking({ merchantId, ...shared });
        toast.success("已建立預約");
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      // 助手時段有問題時,資料庫錯誤訊息會明確指出是「助手『姓名』」,前端直接顯示,不用另外解析。
      toast.error(isEdit ? "更新預約失敗" : "建立預約失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  const assistantCandidates = (staffList ?? []).filter((s) => s.id !== staffId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "編輯預約" : "新增預約"}</DialogTitle>
          {!isEdit ? (
            <DialogDescription>建立後狀態是「待確認」,需要再次確認才會正式成立。</DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>服務人員 *</Label>
              <Select
                value={staffId}
                onValueChange={(v) => {
                  setStaffId(v);
                  setAssistantStaffIds((prev) => prev.filter((id) => id !== v));
                }}
              >
                <SelectTrigger className="mt-2">
                  <SelectValue placeholder="請選擇" />
                </SelectTrigger>
                <SelectContent>
                  {(staffList ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="booking-date">日期 *</Label>
              <Input
                id="booking-date"
                type="date"
                className="mt-2"
                value={dateKey}
                onChange={(e) => setDateKey(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="booking-time">時間 *</Label>
              <Input
                id="booking-time"
                type="time"
                className="mt-2"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
          </div>

          {/* 建單功能擴充 2.1/5.1 第 1 點:服務項目改多選,即時顯示工時加總。 */}
          <div>
            <Label>服務項目(可多選) *</Label>
            <div className="mt-2 max-h-40 space-y-1.5 overflow-y-auto rounded-md border border-border p-2">
              {(serviceItems ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">目前沒有上架中的服務項目。</p>
              ) : (
                (serviceItems ?? []).map((item) => (
                  <label
                    key={item.id}
                    className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={serviceItemIds.includes(item.id)}
                      onCheckedChange={() =>
                        setServiceItemIds((prev) => toggleInArray(prev, item.id))
                      }
                    />
                    <span>
                      {item.name}({item.duration_minutes} 分鐘)
                    </span>
                  </label>
                ))
              )}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              已選 {serviceItemIds.length} 項,總工時 {totalDurationMinutes} 分鐘。
            </p>
          </div>

          {/* 建單功能擴充 2.2/5.1 第 2 點:助手欄位,排除已選為主要服務人員的那一位,可留空。 */}
          <div>
            <Label>助手(可留空,可多選)</Label>
            <div className="mt-2 max-h-32 space-y-1.5 overflow-y-auto rounded-md border border-border p-2">
              {assistantCandidates.length === 0 ? (
                <p className="text-xs text-muted-foreground">沒有其他可指派的服務人員。</p>
              ) : (
                assistantCandidates.map((s) => (
                  <label
                    key={s.id}
                    className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={assistantStaffIds.includes(s.id)}
                      onCheckedChange={() =>
                        setAssistantStaffIds((prev) => toggleInArray(prev, s.id))
                      }
                    />
                    <span>{s.name}</span>
                  </label>
                ))
              )}
            </div>
          </div>

          {/* 建單功能擴充 2.3/5.1 第 3 點:料錢成本區塊,只有商家開啟功能時才顯示。 */}
          {materialCostEnabled ? (
            <div>
              <Label>料錢成本(可留空,可多選)</Label>
              <div className="mt-2 max-h-32 space-y-1.5 overflow-y-auto rounded-md border border-border p-2">
                {(materialCostItems ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">目前沒有上架中的料錢成本品項。</p>
                ) : (
                  (materialCostItems ?? []).map((item) => (
                    <label
                      key={item.id}
                      className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/50"
                    >
                      <Checkbox
                        checked={materialCostItemIds.includes(item.id)}
                        onCheckedChange={() =>
                          setMaterialCostItemIds((prev) => toggleInArray(prev, item.id))
                        }
                      />
                      <span>
                        {item.name}(${Number(item.amount).toFixed(0)})
                      </span>
                    </label>
                  ))
                )}
              </div>
              {materialCostItemIds.length > 0 ? (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  已選 {materialCostItemIds.length} 項,金額加總 ${materialCostTotal.toFixed(0)}
                  (僅供操作者參考,不代表訂單金額)。
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="booking-customer-name">客戶姓名 *</Label>
              <Input
                id="booking-customer-name"
                className="mt-2"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="booking-customer-phone">客戶電話 *</Label>
              <Input
                id="booking-customer-phone"
                className="mt-2"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="booking-customer-email">客戶 Email</Label>
              <Input
                id="booking-customer-email"
                type="email"
                className="mt-2"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="booking-notes">備註</Label>
              <Textarea
                id="booking-notes"
                className="mt-2"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" disabled={saving} onClick={handleSubmit}>
            {saving ? "儲存中⋯" : isEdit ? "儲存變更" : "建立預約"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 5.2:預約詳情 + 確認/標記完成/編輯/取消操作。改成用 getBooking(id) 抓完整詳情
// (含服務項目/助手/料錢成本清單),不再只依賴行事曆格線傳進來的簡化資料。
// ---------------------------------------------------------------------------
function bookingStatusBadgeVariant(status: BookingStatus): "default" | "secondary" | "outline" {
  if (status === "completed") return "secondary";
  if (status === "cancelled") return "outline";
  return "default";
}

function BookingDetailDialog({
  bookingId,
  staffNameById,
  open,
  onOpenChange,
  onChanged,
  onEdit,
}: {
  bookingId: string | null;
  staffNameById: Map<string, string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
  onEdit: (bookingId: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: booking, isLoading } = useQuery({
    queryKey: ["booking-module", "booking-detail", bookingId],
    queryFn: () => getBooking(bookingId as string),
    enabled: open && Boolean(bookingId),
  });

  useEffect(() => {
    if (open) setReason("");
  }, [open, bookingId]);

  async function handleConfirm() {
    if (!booking) return;
    setBusy(true);
    try {
      await confirmBooking(booking.id);
      toast.success("已確認訂單");
      onOpenChange(false);
      onChanged();
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function handleComplete() {
    if (!booking) return;
    setBusy(true);
    try {
      await completeBooking(booking.id);
      toast.success("已標記完成");
      onOpenChange(false);
      onChanged();
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!booking) return;
    setBusy(true);
    try {
      await cancelBooking(booking.id, reason.trim() ? reason.trim() : null);
      toast.success("已取消預約");
      onOpenChange(false);
      onChanged();
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  if (!bookingId) return null;

  // 5.2 第 3 點:操作按鈕依狀態調整。
  const showConfirm = booking?.status === "pending_confirmation";
  const showComplete = booking?.status === "accepted";
  const showEditAndCancel =
    booking?.status === "pending_confirmation" || booking?.status === "accepted";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>預約詳情</DialogTitle>
        </DialogHeader>

        {isLoading || !booking ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">狀態</span>
              <Badge variant={bookingStatusBadgeVariant(booking.status as BookingStatus)}>
                {BOOKING_STATUS_LABELS[booking.status as BookingStatus]}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">服務人員</span>
              <span className="font-medium text-foreground">
                {staffNameById.get(booking.staff_id) ?? "(未知人員)"}
              </span>
            </div>
            {booking.assistants.length > 0 ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">助手</span>
                <span className="font-medium text-foreground">
                  {booking.assistants.map((a) => a.staffName).join("、")}
                </span>
              </div>
            ) : null}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">服務項目</span>
              <span className="font-medium text-foreground">
                {booking.serviceItems.map((i) => i.name).join("、")}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">時間</span>
              <span className="font-medium text-foreground">
                {isoToTaipeiTime(booking.start_at)} - {isoToTaipeiTime(booking.end_at)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">客戶</span>
              <span className="font-medium text-foreground">
                {booking.customer_name} ・ {booking.customer_phone}
              </span>
            </div>
            {booking.materialCosts.length > 0 ? (
              <div>
                <span className="text-muted-foreground">料錢成本</span>
                <ul className="mt-1 space-y-0.5">
                  {booking.materialCosts.map((c) => (
                    <li key={c.materialCostItemId} className="text-foreground">
                      {c.name} ・ ${c.amountSnapshot.toFixed(0)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {booking.notes ? (
              <div>
                <span className="text-muted-foreground">備註</span>
                <p className="mt-1 text-foreground">{booking.notes}</p>
              </div>
            ) : null}
          </div>
        )}

        {booking && (showConfirm || showComplete || showEditAndCancel) ? (
          <DialogFooter className="flex-wrap gap-2 sm:justify-between">
            {showEditAndCancel ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button type="button" variant="outline" disabled={busy}>
                    取消預約
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>確定要取消這筆預約嗎?</AlertDialogTitle>
                    <AlertDialogDescription>
                      取消後這個時段會恢復可預約,可以填寫取消原因(選填)。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <Textarea
                    placeholder="取消原因(選填)"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={2}
                  />
                  <AlertDialogFooter>
                    <AlertDialogCancel>再想想</AlertDialogCancel>
                    <AlertDialogAction onClick={handleCancel}>確定取消</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
            <div className="flex gap-2">
              {showEditAndCancel ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onEdit(booking.id)}
                >
                  編輯
                </Button>
              ) : null}
              {showConfirm ? (
                <Button type="button" onClick={handleConfirm} disabled={busy}>
                  確認訂單
                </Button>
              ) : null}
              {showComplete ? (
                <Button type="button" onClick={handleComplete} disabled={busy}>
                  標記完成
                </Button>
              ) : null}
            </div>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 1.3:排程色塊視覺——依狀態決定色塊樣式,待確認/已確認/已完成三種可區分。
// ---------------------------------------------------------------------------
function bookingBlockClasses(status: BookingStatus): string {
  if (status === "completed") return "bg-cta-soft text-cta";
  if (status === "pending_confirmation") return "border border-warn/50 bg-warn/20 text-warn";
  return "bg-brand-soft text-accent-foreground"; // accepted(已確認)
}

// ---------------------------------------------------------------------------
// 4.3:主頁面
// ---------------------------------------------------------------------------
function CalendarPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();
  const { data: staffList } = useMerchantStaffList(merchantId);

  const staffNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of staffList ?? []) map.set(s.id, s.name);
    return map;
  }, [staffList]);

  // 1.1:月/週檢視切換。
  const [viewMode, setViewMode] = useState<CalendarViewMode>("week");
  const [selectedDate, setSelectedDate] = useState<Date>(() => getTaipeiNow());
  const [monthAnchor, setMonthAnchor] = useState<Date>(() => startOfMonth(getTaipeiNow()));
  const selectedDateKey = toDateKey(selectedDate);

  const weekStart = useMemo(() => startOfWeek(selectedDate), [selectedDate]);
  const weekDays = useMemo(
    () => [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(weekStart, i)),
    [weekStart],
  );
  const monthGrid = useMemo(() => buildMonthGrid(monthAnchor), [monthAnchor]);

  // 1.1/1.2:依目前檢視模式決定要查詢的日期範圍(週檢視查這一週,月檢視查整個月曆格線範圍,
  // 含補進來的上下月日期,確保格線邊緣日期的標示也正確)。
  const rangeStartKey = viewMode === "week" ? toDateKey(weekStart) : toDateKey(monthGrid[0]!.date);
  const rangeEndKey =
    viewMode === "week"
      ? toDateKey(addDays(weekStart, 7))
      : toDateKey(addDays(monthGrid[monthGrid.length - 1]!.date, 1));

  const { data: rangeBookings } = useMerchantBookings(merchantId, {
    startAt: buildTaipeiIso(rangeStartKey, "00:00"),
    endAt: buildTaipeiIso(rangeEndKey, "00:00"),
  });

  // 1.2:「有預約」的判斷邏輯包含 pending_confirmation/accepted 兩種未終止狀態,不含 cancelled
  // (沿用既有的「非 cancelled」判斷,ACTIVE_BOOKING_STATUSES 是這個集合的具名對照,completed 也算
  // 「這天有發生過預約」,一併保留既有行為不縮限)。
  const datesWithBookings = useMemo(() => {
    const set = new Set<string>();
    for (const b of rangeBookings ?? []) {
      if (b.status !== "cancelled") set.add(isoToTaipeiDateKey(b.start_at));
    }
    return set;
  }, [rangeBookings]);

  const { data: schedule, isLoading: scheduleLoading } = useMerchantDaySchedule(
    merchantId,
    selectedDateKey,
  );

  const [formOpen, setFormOpen] = useState(false);
  const [formPrefill, setFormPrefill] = useState<BookingFormPrefill>({});
  const [editingBookingId, setEditingBookingId] = useState<string | null>(null);
  const [detailBookingId, setDetailBookingId] = useState<string | null>(null);

  function refetchAll() {
    void queryClient.invalidateQueries({ queryKey: ["booking-module"] });
  }

  function openCreateForm(prefill: BookingFormPrefill) {
    setEditingBookingId(null);
    setFormPrefill(prefill);
    setFormOpen(true);
  }

  function openEditForm(bookingId: string) {
    setDetailBookingId(null);
    setEditingBookingId(bookingId);
    setFormPrefill({});
    setFormOpen(true);
  }

  const businessHours = schedule?.business_hours;
  const slots = useMemo(() => {
    if (!businessHours || !businessHours.has_setting || businessHours.is_closed) return [];
    if (!businessHours.open_time || !businessHours.close_time) return [];
    const startMin = timeToMinutes(businessHours.open_time);
    const endMin = timeToMinutes(businessHours.close_time);
    const result: { start: string; end: string }[] = [];
    for (let m = startMin; m < endMin; m += SLOT_MINUTES) {
      result.push({ start: minutesToTime(m), end: minutesToTime(m + SLOT_MINUTES) });
    }
    return result;
  }, [businessHours]);

  const gridStartMin = slots.length > 0 ? timeToMinutes(slots[0]!.start) : 0;
  const gridTotalPx = slots.length * SLOT_PX;

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-5 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">行事曆</h1>
          <p className="mt-1 text-sm text-muted-foreground">「{merchant!.name}」的預約總覽</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-border p-0.5">
            <Button
              type="button"
              size="sm"
              variant={viewMode === "week" ? "default" : "ghost"}
              onClick={() => setViewMode("week")}
            >
              週檢視
            </Button>
            <Button
              type="button"
              size="sm"
              variant={viewMode === "month" ? "default" : "ghost"}
              onClick={() => setViewMode("month")}
            >
              月檢視
            </Button>
          </div>
          <Button variant="cta" onClick={() => openCreateForm({ dateKey: selectedDateKey })}>
            新增預約
          </Button>
        </div>
      </div>

      {viewMode === "week" ? (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSelectedDate((d) => addDays(d, -7))}
          >
            上一週
          </Button>
          <div className="grid flex-1 grid-cols-7 gap-1.5">
            {weekDays.map((d) => {
              const key = toDateKey(d);
              const isSelected = key === selectedDateKey;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedDate(d)}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-md border px-2 py-2 text-xs transition-colors",
                    isSelected
                      ? "border-brand bg-brand-soft font-semibold text-brand"
                      : "border-border text-muted-foreground hover:border-brand/50",
                  )}
                >
                  <span>週{"日一二三四五六"[d.getDay()]}</span>
                  <span className="text-sm">{d.getDate()}</span>
                  {datesWithBookings.has(key) ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-cta" aria-hidden />
                  ) : (
                    <span className="h-1.5 w-1.5" aria-hidden />
                  )}
                </button>
              );
            })}
          </div>
          <Button variant="outline" size="sm" onClick={() => setSelectedDate((d) => addDays(d, 7))}>
            下一週
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMonthAnchor((d) => addMonths(d, -1))}
            >
              上一月
            </Button>
            <span className="text-sm font-medium text-foreground">
              {monthAnchor.getFullYear()} 年 {monthAnchor.getMonth() + 1} 月
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMonthAnchor((d) => addMonths(d, 1))}
            >
              下一月
            </Button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-muted-foreground">
            {["日", "一", "二", "三", "四", "五", "六"].map((label) => (
              <div key={label}>{label}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {monthGrid.map(({ date, inCurrentMonth }) => {
              const key = toDateKey(date);
              const isSelected = key === selectedDateKey;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedDate(date)}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-md border px-1 py-2 text-xs transition-colors",
                    isSelected
                      ? "border-brand bg-brand-soft font-semibold text-brand"
                      : "border-border hover:border-brand/50",
                    !inCurrentMonth && !isSelected ? "text-muted-foreground/40" : "text-foreground",
                  )}
                >
                  <span>{date.getDate()}</span>
                  {datesWithBookings.has(key) ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-cta" aria-hidden />
                  ) : (
                    <span className="h-1.5 w-1.5" aria-hidden />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 4.3 第 2 點/1.3:服務人員分欄時間軸格線,同一筆預約合併成連續色塊。 */}
      {scheduleLoading ? (
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      ) : !schedule || schedule.staff.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          目前沒有在職的服務人員,請先到服務人員管理新增。
        </p>
      ) : !businessHours?.has_setting || businessHours.is_closed ? (
        <p className="rounded-md border border-dashed border-warn/50 bg-warn/10 px-3 py-8 text-center text-sm text-warn">
          {!businessHours?.has_setting
            ? "尚未設定這天的營業時間,目前無法被預約,請先到營業時間設定完成設定。"
            : "商家這天公休,無法建立預約。"}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <div className="flex min-w-[640px]">
            <div className="flex w-[72px] shrink-0 flex-col">
              <div className="flex h-9 items-center border-b border-r border-border bg-surface p-2 text-xs font-medium text-muted-foreground">
                時間
              </div>
              <div className="relative" style={{ height: gridTotalPx }}>
                {slots.map((slot, i) => (
                  <div
                    key={slot.start}
                    className="absolute inset-x-0 border-b border-r border-border p-1 text-right text-[11px] text-muted-foreground"
                    style={{ top: i * SLOT_PX, height: SLOT_PX }}
                  >
                    {slot.start}
                  </div>
                ))}
              </div>
            </div>

            {schedule.staff.map((s) => (
              <div
                key={s.staff_id}
                className="relative flex-1 border-r border-border last:border-r-0"
              >
                <div className="flex h-9 items-center justify-center border-b border-border bg-surface p-2 text-center text-xs font-medium text-foreground">
                  {s.staff_name}
                </div>
                <div className="relative" style={{ height: gridTotalPx }}>
                  {/* 背景格線:依可預約時段/跨店占用著色,可點擊的空白格用來開啟建單表單。 */}
                  {slots.map((slot, i) => {
                    const slotStartMin = timeToMinutes(slot.start);
                    const slotEndMin = timeToMinutes(slot.end);

                    const inWindow = s.available_windows.some(
                      (w) =>
                        timeToMinutes(w.start_time) <= slotStartMin &&
                        timeToMinutes(w.end_time) >= slotEndMin,
                    );

                    if (!inWindow) {
                      return (
                        <div
                          key={slot.start}
                          className="absolute inset-x-0 border-b border-border bg-muted/40"
                          style={{ top: i * SLOT_PX, height: SLOT_PX }}
                          aria-label="不可預約"
                        />
                      );
                    }

                    const foreignBusy = s.foreign_bookings.some((b) => {
                      const bStart = timeToMinutes(isoToTaipeiTime(b.start_at));
                      const bEnd = timeToMinutes(isoToTaipeiTime(b.end_at));
                      return bStart < slotEndMin && bEnd > slotStartMin;
                    });

                    if (foreignBusy) {
                      return (
                        <div
                          key={slot.start}
                          className="absolute inset-x-0 border-b border-border bg-warn/15 p-1 text-[10px] text-warn"
                          style={{ top: i * SLOT_PX, height: SLOT_PX }}
                        >
                          外店預約中
                        </div>
                      );
                    }

                    return (
                      <button
                        key={slot.start}
                        type="button"
                        onClick={() =>
                          openCreateForm({
                            staffId: s.staff_id,
                            dateKey: selectedDateKey,
                            time: slot.start,
                          })
                        }
                        className="absolute inset-x-0 border-b border-border bg-background hover:bg-brand-soft/40"
                        style={{ top: i * SLOT_PX, height: SLOT_PX }}
                        aria-label="可預約"
                      />
                    );
                  })}

                  {/* 1.3:同一筆預約合併顯示成一個跨越多格高度的連續色塊,疊在背景格線上方。 */}
                  {s.bookings.map((b: DayScheduleOwnBooking) => {
                    const bStartMin = timeToMinutes(isoToTaipeiTime(b.start_at));
                    const bEndMin = timeToMinutes(isoToTaipeiTime(b.end_at));
                    const top = Math.max(0, ((bStartMin - gridStartMin) / SLOT_MINUTES) * SLOT_PX);
                    const height = Math.max(
                      SLOT_PX / 2,
                      ((bEndMin - bStartMin) / SLOT_MINUTES) * SLOT_PX,
                    );
                    return (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => setDetailBookingId(b.id)}
                        className={cn(
                          "absolute inset-x-0 z-10 overflow-hidden rounded-sm p-1 text-left text-[11px] leading-tight shadow-sm",
                          bookingBlockClasses(b.status),
                        )}
                        style={{ top, height }}
                      >
                        <p className="truncate font-medium">
                          {b.customer_name}
                          {b.role === "assistant" ? "(協助)" : ""}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <BookingFormDialog
        merchantId={merchantId}
        open={formOpen}
        onOpenChange={setFormOpen}
        prefill={formPrefill}
        editingBookingId={editingBookingId}
        onSaved={refetchAll}
      />

      <BookingDetailDialog
        bookingId={detailBookingId}
        staffNameById={staffNameById}
        open={detailBookingId !== null}
        onOpenChange={(open) => {
          if (!open) setDetailBookingId(null);
        }}
        onChanged={refetchAll}
        onEdit={openEditForm}
      />
    </main>
  );
}

export default function CalendarPage() {
  return (
    <RequireBookingAccess>
      <CalendarPageInner />
    </RequireBookingAccess>
  );
}
