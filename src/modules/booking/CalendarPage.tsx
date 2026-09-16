// 對應規格書 4.3(行事曆總覽頁,取代 /app/calendar 原本的佔位畫面)、4.4(手動建單表單)、
// 4.5(標記完成/取消預約操作)。畫面描述是參考截圖的概念轉譯,視覺風格沿用既有設計系統
// (ARCHITECTURE.md 第十節第 9 點原則,不逐模組打磨)。
//
// 时区說明:系統目前假設所有商家都在 Asia/Taipei(規格書「本模組明確不做的事」),這裡的日期/時間
// 一律以 Asia/Taipei 的日曆日/時鐘時間為準,送往後端的 start_at 一律明確帶 +08:00 偏移量,
// 不依賴瀏覽器本機時區(避免使用者瀏覽器時區設定不是台灣時導致算錯)。

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { useMerchantStaffList } from "@/modules/staff-agent/context";
import { useMerchantServiceItems } from "@/modules/service-items/context";

import { cancelBooking, completeBooking, createBooking } from "./api";
import { useMerchantBookings, useMerchantDaySchedule } from "./context";
import {
  addDays,
  buildTaipeiIso,
  getTaipeiNow,
  isoToTaipeiDateKey,
  isoToTaipeiTime,
  minutesToTime,
  startOfWeek,
  timeToMinutes,
  toDateKey,
} from "./dateUtils";
import { RequireBookingAccess } from "./RequireBookingAccess";
import {
  BOOKING_STATUS_LABELS,
  DAY_OF_WEEK_LABELS,
  type BookingStatus,
  type DayScheduleOwnBooking,
} from "./types";

const SLOT_MINUTES = 30;

// ---------------------------------------------------------------------------
// 4.4:手動建單表單
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
  onCreated,
}: {
  merchantId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefill: BookingFormPrefill;
  onCreated: () => void;
}) {
  const { data: staffList } = useMerchantStaffList(merchantId);
  const { data: serviceItems } = useMerchantServiceItems(merchantId);

  const [staffId, setStaffId] = useState("");
  const [serviceItemId, setServiceItemId] = useState("");
  const [dateKey, setDateKey] = useState("");
  const [time, setTime] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  // 每次開啟時依 prefill 重設表單(不是只在第一次 mount 時設定)。
  useMemo(() => {
    if (open) {
      setStaffId(prefill.staffId ?? "");
      setServiceItemId("");
      setDateKey(prefill.dateKey ?? toDateKey(getTaipeiNow()));
      setTime(prefill.time ?? "10:00");
      setCustomerName("");
      setCustomerPhone("");
      setCustomerEmail("");
      setNotes("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleSubmit() {
    if (!staffId) {
      toast.error("請選擇服務人員");
      return;
    }
    if (!serviceItemId) {
      toast.error("請選擇服務項目");
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
      await createBooking({
        merchantId,
        staffId,
        serviceItemId,
        startAt: buildTaipeiIso(dateKey, time),
        customerName,
        customerPhone,
        customerEmail: customerEmail.trim() ? customerEmail.trim() : null,
        notes: notes.trim() ? notes.trim() : null,
      });
      toast.success("已建立預約");
      onOpenChange(false);
      onCreated();
    } catch (err) {
      // 3.3 的擋下原因(超出營業時間/超出服務人員時段/時段衝突/外店已被預約/無時段設定)
      // 都會透過資料庫的中文錯誤訊息回傳,getErrorMessage() 直接取用,不顯示通用文字。
      toast.error("建立預約失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>新增預約</DialogTitle>
          <DialogDescription>建立後狀態直接是「已接受」,不需要另外確認。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>服務人員 *</Label>
              <Select value={staffId} onValueChange={setStaffId}>
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
              <Label>服務項目 *</Label>
              <Select value={serviceItemId} onValueChange={setServiceItemId}>
                <SelectTrigger className="mt-2">
                  <SelectValue placeholder="請選擇" />
                </SelectTrigger>
                <SelectContent>
                  {(serviceItems ?? []).map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}({item.duration_minutes} 分鐘)
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
            {saving ? "建立中⋯" : "建立預約"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 4.5:預約詳情 + 標記完成/取消操作
// ---------------------------------------------------------------------------
function bookingStatusBadgeVariant(status: BookingStatus): "default" | "secondary" | "outline" {
  if (status === "completed") return "secondary";
  if (status === "cancelled") return "outline";
  return "default";
}

function BookingDetailDialog({
  booking,
  staffName,
  open,
  onOpenChange,
  onChanged,
}: {
  booking: DayScheduleOwnBooking | null;
  staffName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  if (!booking) return null;

  async function handleComplete() {
    setBusy(true);
    try {
      await completeBooking(booking!.id);
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
    setBusy(true);
    try {
      await cancelBooking(booking!.id, reason.trim() ? reason.trim() : null);
      toast.success("已取消預約");
      onOpenChange(false);
      onChanged();
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  // 規則 2.9:completed/cancelled 狀態下不顯示這兩個操作按鈕(比照截圖 1「取消按鈕未完成的訂單才有」)。
  const showActions = booking.status === "accepted";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>預約詳情</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">狀態</span>
            <Badge variant={bookingStatusBadgeVariant(booking.status)}>
              {BOOKING_STATUS_LABELS[booking.status]}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">服務人員</span>
            <span className="font-medium text-foreground">{staffName}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">服務項目</span>
            <span className="font-medium text-foreground">{booking.service_item_name}</span>
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
          {booking.notes ? (
            <div>
              <span className="text-muted-foreground">備註</span>
              <p className="mt-1 text-foreground">{booking.notes}</p>
            </div>
          ) : null}
        </div>

        {showActions ? (
          <DialogFooter className="gap-2 sm:justify-between">
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
            <Button type="button" onClick={handleComplete} disabled={busy}>
              標記完成
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 4.3:主頁面
// ---------------------------------------------------------------------------
function CalendarPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();

  const [selectedDate, setSelectedDate] = useState<Date>(() => getTaipeiNow());
  const selectedDateKey = toDateKey(selectedDate);
  const weekStart = useMemo(() => startOfWeek(selectedDate), [selectedDate]);
  const weekDays = useMemo(
    () => [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(weekStart, i)),
    [weekStart],
  );

  const weekStartKey = toDateKey(weekStart);
  const weekEndKey = toDateKey(addDays(weekStart, 7));

  // 4.3 第 1 點:查詢本週哪幾天有預約,用來在週日期列標示提示。
  const { data: weekBookings } = useMerchantBookings(merchantId, {
    startAt: buildTaipeiIso(weekStartKey, "00:00"),
    endAt: buildTaipeiIso(weekEndKey, "00:00"),
  });
  const datesWithBookings = useMemo(() => {
    const set = new Set<string>();
    for (const b of weekBookings ?? []) {
      if (b.status !== "cancelled") set.add(isoToTaipeiDateKey(b.start_at));
    }
    return set;
  }, [weekBookings]);

  const { data: schedule, isLoading: scheduleLoading } = useMerchantDaySchedule(
    merchantId,
    selectedDateKey,
  );

  const [formOpen, setFormOpen] = useState(false);
  const [formPrefill, setFormPrefill] = useState<BookingFormPrefill>({});
  const [detailBooking, setDetailBooking] = useState<{
    booking: DayScheduleOwnBooking;
    staffName: string;
  } | null>(null);

  function refetchAll() {
    void queryClient.invalidateQueries({ queryKey: ["booking-module"] });
  }

  function openCreateForm(prefill: BookingFormPrefill) {
    setFormPrefill(prefill);
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

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-5 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">行事曆</h1>
          <p className="mt-1 text-sm text-muted-foreground">「{merchant!.name}」的預約總覽</p>
        </div>
        <Button variant="cta" onClick={() => openCreateForm({ dateKey: selectedDateKey })}>
          新增預約
        </Button>
      </div>

      {/* 4.3 第 1 點:頂端週日期列 */}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setSelectedDate((d) => addDays(d, -7))}>
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
                <span>週{DAY_OF_WEEK_LABELS[d.getDay()]}</span>
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

      {/* 4.3 第 2 點:服務人員分欄時間軸格線 */}
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
          <div
            className="grid min-w-[640px]"
            style={{ gridTemplateColumns: `72px repeat(${schedule.staff.length}, 1fr)` }}
          >
            <div className="sticky left-0 z-10 border-b border-r border-border bg-surface p-2 text-xs font-medium text-muted-foreground">
              時間
            </div>
            {schedule.staff.map((s) => (
              <div
                key={s.staff_id}
                className="border-b border-border bg-surface p-2 text-center text-xs font-medium text-foreground"
              >
                {s.staff_name}
              </div>
            ))}

            {slots.map((slot) => (
              <div key={slot.start} className="contents">
                <div className="border-b border-r border-border p-1.5 text-right text-[11px] text-muted-foreground">
                  {slot.start}
                </div>
                {schedule.staff.map((s) => {
                  const slotStartMin = timeToMinutes(slot.start);
                  const slotEndMin = timeToMinutes(slot.end);

                  const inWindow = s.available_windows.some(
                    (w) =>
                      timeToMinutes(w.start_time) <= slotStartMin &&
                      timeToMinutes(w.end_time) >= slotEndMin,
                  );

                  const ownBooking = s.bookings.find((b) => {
                    const bStart = timeToMinutes(isoToTaipeiTime(b.start_at));
                    const bEnd = timeToMinutes(isoToTaipeiTime(b.end_at));
                    return bStart < slotEndMin && bEnd > slotStartMin;
                  });

                  const foreignBusy = s.foreign_bookings.some((b) => {
                    const bStart = timeToMinutes(isoToTaipeiTime(b.start_at));
                    const bEnd = timeToMinutes(isoToTaipeiTime(b.end_at));
                    return bStart < slotEndMin && bEnd > slotStartMin;
                  });

                  if (!inWindow) {
                    return (
                      <div
                        key={s.staff_id}
                        className="border-b border-border bg-muted/40"
                        aria-label="不可預約"
                      />
                    );
                  }

                  if (ownBooking) {
                    const isCompleted = ownBooking.status === "completed";
                    return (
                      <button
                        key={s.staff_id}
                        type="button"
                        onClick={() =>
                          setDetailBooking({ booking: ownBooking, staffName: s.staff_name })
                        }
                        className={cn(
                          "border-b border-border p-1 text-left text-[11px] leading-tight",
                          isCompleted
                            ? "bg-cta-soft text-cta"
                            : "bg-brand-soft text-accent-foreground",
                        )}
                      >
                        <p className="truncate font-medium">{ownBooking.customer_name}</p>
                      </button>
                    );
                  }

                  if (foreignBusy) {
                    return (
                      <div
                        key={s.staff_id}
                        className="border-b border-border bg-warn/15 p-1 text-[11px] text-warn"
                      >
                        外店預約中
                      </div>
                    );
                  }

                  return (
                    <button
                      key={s.staff_id}
                      type="button"
                      onClick={() =>
                        openCreateForm({
                          staffId: s.staff_id,
                          dateKey: selectedDateKey,
                          time: slot.start,
                        })
                      }
                      className="border-b border-border bg-background hover:bg-brand-soft/40"
                      aria-label="可預約"
                    />
                  );
                })}
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
        onCreated={refetchAll}
      />

      <BookingDetailDialog
        booking={detailBooking?.booking ?? null}
        staffName={detailBooking?.staffName ?? ""}
        open={detailBooking !== null}
        onOpenChange={(open) => {
          if (!open) setDetailBooking(null);
        }}
        onChanged={refetchAll}
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
