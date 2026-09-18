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
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
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
import { INDUSTRY_REQUIRES_CUSTOMER_ADDRESS, type IndustryType } from "@/modules/merchant/types";
import { useMerchantStaffList } from "@/modules/staff-agent/context";
import { useMerchantServiceItems } from "@/modules/service-items/context";

import {
  createBooking,
  getBooking,
  updateBooking,
  MATERIAL_COST_ENABLED_FEATURE_KEY,
  type BookingServiceItemSelectionInput,
} from "./api";
import { BookingDetailDialog } from "./BookingDetailDialog";
import {
  useMerchantBookings,
  useMerchantBusinessHours,
  useMerchantDaySchedule,
  useMerchantMaterialCostItems,
  useMerchantTaxSettings,
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
import { calculateBookingAmountPreview, formatAmount } from "./orderAmount";
import { RequireBookingAccess } from "./RequireBookingAccess";
import {
  AMOUNT_ADJUSTMENT_MODE_LABELS,
  PAYMENT_METHOD_OPTIONS,
  type AmountAdjustmentMode,
  type BookingStatus,
  type DayScheduleOwnBooking,
} from "./types";

const SLOT_MINUTES = 30;
const SLOT_PX = 30;

type CalendarViewMode = "week" | "month";

/** 建單表單細節修正第三節第 5 點:合併日期時間選擇器的觸發按鈕文字,例如「9月20日(六) 14:00」,
 * 沒選之前顯示「請選擇日期時間」(由呼叫端自行處理沒選的情況,這支只負責已選定時的格式)。
 * 用跟 dateUtils.ts 一致的「本機 Date getter 讀出來就是台北當地日期」慣例解析 dateKey,
 * 不涉及任何時區換算(dateKey 本身已經是台北當地日曆日字串)。 */
function formatDisplayDateTime(dateKey: string, time: string): string {
  const d = new Date(`${dateKey}T00:00:00`);
  const weekday = "日一二三四五六"[d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日(${weekday}) ${time}`;
}

// ---------------------------------------------------------------------------
// 建單表單細節修正第三節:日期時間合併選擇器(Popover:上方月曆+下方時段清單)。
// 取代原本兩個獨立的原生 date/time 輸入框。時段資料來源複用既有的 useMerchantDaySchedule
// (第 3 點:不重新開一支新的資料查詢),只列出「以目前已選服務項目總工時,能完整放進某個
// available_window」的起始時間點(第 3 點)。這次的篩選是體驗層引導,不是安全邊界
// (第 7 點)——真正擋住不合法時段的還是 create_booking/update_booking 資料庫層的驗證。
// ---------------------------------------------------------------------------
function BookingDateTimeField({
  merchantId,
  staffId,
  totalDurationMinutes,
  dateKey,
  time,
  closedWeekdays,
  onChange,
}: {
  merchantId: string;
  staffId: string;
  totalDurationMinutes: number;
  dateKey: string;
  time: string;
  closedWeekdays: Set<number>;
  onChange: (dateKey: string, time: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: schedule } = useMerchantDaySchedule(merchantId, dateKey || null);

  const staffBlock = (schedule?.staff ?? []).find((s) => s.staff_id === staffId);

  // 第 3 點:只列出總工時能完整放進某個可預約區間的起始時間點,以現有的 SLOT_MINUTES 切格。
  const slotOptions = useMemo(() => {
    if (!staffBlock) return [];
    const starts = new Set<string>();
    for (const w of staffBlock.available_windows) {
      const windowStart = timeToMinutes(w.start_time);
      const windowEnd = timeToMinutes(w.end_time);
      for (let m = windowStart; m + totalDurationMinutes <= windowEnd; m += SLOT_MINUTES) {
        starts.add(minutesToTime(m));
      }
    }
    return Array.from(starts).sort();
  }, [staffBlock, totalDurationMinutes]);

  const label = dateKey && time ? formatDisplayDateTime(dateKey, time) : "請選擇日期時間";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="w-full justify-start font-normal">
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={dateKey ? new Date(`${dateKey}T00:00:00`) : undefined}
          defaultMonth={dateKey ? new Date(`${dateKey}T00:00:00`) : getTaipeiNow()}
          onSelect={(d) => {
            if (!d) return;
            onChange(toDateKey(d), time);
          }}
          disabled={(d) => closedWeekdays.has(d.getDay())}
        />
        <div className="border-t border-border p-3">
          {!staffId ? (
            <p className="text-center text-sm text-muted-foreground">請先選擇服務人員</p>
          ) : !dateKey ? (
            <p className="text-center text-sm text-muted-foreground">請先選擇日期</p>
          ) : slotOptions.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">這天沒有可預約的時段</p>
          ) : (
            <div className="grid max-h-48 grid-cols-3 gap-1.5 overflow-y-auto">
              {slotOptions.map((t) => (
                <Button
                  key={t}
                  type="button"
                  size="sm"
                  variant={time === t ? "default" : "outline"}
                  onClick={() => {
                    onChange(dateKey, t);
                    setOpen(false);
                  }}
                >
                  {t}
                </Button>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

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

// 模組 6(訂單管理)§1.1:訂單管理頁(OrdersPage.tsx)點開一筆訂單的詳情後,一樣需要能編輯,
// 所以這顆建單/編輯共用表單也 export 出來給它複用,不重做一份幾乎一樣的表單。
export function BookingFormDialog({
  merchantId,
  industryType,
  open,
  onOpenChange,
  prefill,
  editingBookingId,
  onSaved,
}: {
  merchantId: string;
  industryType: IndustryType;
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
  const { data: businessHours } = useMerchantBusinessHours(merchantId);

  // 建單表單細節修正第二節第 2/3 點:依商家 industry_type 判斷客戶地址是否必填。
  const requiresCustomerAddress = INDUSTRY_REQUIRES_CUSTOMER_ADDRESS[industryType];

  // 建單表單細節修正第三節第 1 點:淡化商家公休/查無設定的日子(不強制隱藏,能點但下方時段清單
  // 一定是空的)。這裡只依「星期幾公休」淡化,不逐日期查詢,已經覆蓋規格書要求的視覺提示。
  const closedWeekdays = useMemo(() => {
    const set = new Set([0, 1, 2, 3, 4, 5, 6]);
    for (const h of businessHours ?? []) {
      if (!h.is_closed) set.delete(h.day_of_week);
    }
    return set;
  }, [businessHours]);

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
  const [customerAddress, setCustomerAddress] = useState("");
  const [notes, setNotes] = useState("");
  // 預約詳情資訊擴充與建單備註分類第一節:客戶備註(客戶看得到),跟上面的 notes(內部備註,
  // 商家內部看、客戶看不到)分開存放,對應 bookings.customer_notes。
  const [customerNotes, setCustomerNotes] = useState("");
  const [saving, setSaving] = useState(false);

  // 模組 6(訂單管理)§4.1/4.2:每個已勾選服務項目的數量/單價(字串狀態,方便控制輸入框,
  // 送出時再轉數字)。key 是 service_item_id。
  const [itemQuantities, setItemQuantities] = useState<Record<string, string>>({});
  const [itemUnitPrices, setItemUnitPrices] = useState<Record<string, string>>({});

  // §4.4 自訂總金額開關。
  const [customTotalAmountEnabled, setCustomTotalAmountEnabled] = useState(false);
  const [customTotalAmount, setCustomTotalAmount] = useState("");
  // §4.5 折扣開關(固定金額/百分比二選一)。
  const [discountEnabled, setDiscountEnabled] = useState(false);
  const [discountMode, setDiscountMode] = useState<AmountAdjustmentMode>("fixed");
  const [discountValue, setDiscountValue] = useState("");
  // §4.6 稅金開關:模式固定依商家目前 merchant_tax_settings.tax_mode 決定(客服不能在表單裡改),
  // 數字預設帶入商家設定,可個別調整。編輯既有訂單時改成沿用這筆訂單既有的快照
  // (§2.4:編輯表單一律用既有快照值預先帶入,不重新查詢 merchant_tax_settings 的目前設定)。
  const [taxEnabled, setTaxEnabled] = useState(false);
  const [taxMode, setTaxMode] = useState<AmountAdjustmentMode>("percentage");
  const [taxValue, setTaxValue] = useState("");
  // §3.2/裁決 Q10:付款方式,這次只有「現場付款」一個暫時選項,留空代表「尚未設定」。
  const [paymentMethodOnSite, setPaymentMethodOnSite] = useState(false);

  const { data: merchantTaxSettings } = useMerchantTaxSettings(merchantId);

  // 每次開啟時重設表單:新建模式依 prefill(金額相關欄位一律回到「全部關閉」,稅金數字預設帶入
  // 商家目前設定,這是「建立當下」唯一允許讀取即時資料當作預設值的地方,§2.4 第 2 點);
  // 編輯模式等 editingDetail 載入後帶入既有的金額快照值,不重新查詢商家目前設定。
  useEffect(() => {
    if (!open) return;
    if (isEdit) {
      if (!editingDetail) return; // 還在載入中,等資料回來再帶入
      setStaffId(editingDetail.staff_id);
      setServiceItemIds(editingDetail.serviceItems.map((i) => i.id));
      setItemQuantities(
        Object.fromEntries(editingDetail.serviceItems.map((i) => [i.id, String(i.quantity)])),
      );
      setItemUnitPrices(
        Object.fromEntries(editingDetail.serviceItems.map((i) => [i.id, String(i.unitPriceSnapshot)])),
      );
      setAssistantStaffIds(editingDetail.assistants.map((a) => a.staffId));
      setMaterialCostItemIds(editingDetail.materialCosts.map((c) => c.materialCostItemId));
      setDateKey(isoToTaipeiDateKey(editingDetail.start_at));
      setTime(isoToTaipeiTime(editingDetail.start_at));
      setCustomerName(editingDetail.customer_name);
      setCustomerPhone(editingDetail.customer_phone);
      setCustomerEmail(editingDetail.customer_email ?? "");
      setCustomerAddress(editingDetail.customer_address ?? "");
      setNotes(editingDetail.notes ?? "");
      setCustomerNotes(editingDetail.customer_notes ?? "");
      setCustomTotalAmountEnabled(editingDetail.custom_total_amount_enabled);
      setCustomTotalAmount(
        editingDetail.custom_total_amount !== null ? String(editingDetail.custom_total_amount) : "",
      );
      setDiscountEnabled(editingDetail.discount_enabled);
      setDiscountMode((editingDetail.discount_mode as AmountAdjustmentMode | null) ?? "fixed");
      setDiscountValue(editingDetail.discount_value !== null ? String(editingDetail.discount_value) : "");
      setTaxEnabled(editingDetail.tax_enabled);
      // 這筆訂單從沒開過稅金時沒有既有快照(null),此時 fallback 商家目前設定當預設值,
      // 純粹是「第一次在這筆訂單上開啟稅金」的合理預設,不影響已經存在的快照(§2.4 的精神:
      // 不覆寫既有值,只在「原本沒有值」時才需要提供一個起始點)。
      setTaxMode(
        (editingDetail.tax_mode_snapshot as AmountAdjustmentMode | null) ??
          merchantTaxSettings?.taxMode ??
          "percentage",
      );
      setTaxValue(
        editingDetail.tax_value_snapshot !== null
          ? String(editingDetail.tax_value_snapshot)
          : merchantTaxSettings
            ? String(merchantTaxSettings.taxValue)
            : "",
      );
      setPaymentMethodOnSite(editingDetail.payment_method === "on_site");
    } else {
      setStaffId(prefill.staffId ?? "");
      setServiceItemIds([]);
      setItemQuantities({});
      setItemUnitPrices({});
      setAssistantStaffIds([]);
      setMaterialCostItemIds([]);
      setDateKey(prefill.dateKey ?? toDateKey(getTaipeiNow()));
      setTime(prefill.time ?? "10:00");
      setCustomerName("");
      setCustomerPhone("");
      setCustomerEmail("");
      setCustomerAddress("");
      setNotes("");
      setCustomerNotes("");
      setCustomTotalAmountEnabled(false);
      setCustomTotalAmount("");
      setDiscountEnabled(false);
      setDiscountMode("fixed");
      setDiscountValue("");
      setTaxEnabled(false);
      setTaxMode(merchantTaxSettings?.taxMode ?? "percentage");
      setTaxValue(merchantTaxSettings ? String(merchantTaxSettings.taxValue) : "");
      setPaymentMethodOnSite(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isEdit, editingDetail, merchantTaxSettings]);

  // 模組 6 §2.2 新公式:每個服務項目的工時貢獻 = duration_minutes × quantity(這次不實作自訂工時
  // 開關,留給下一批獨立處理,見規格書 §4.3)。
  const totalDurationMinutes = useMemo(() => {
    return serviceItemIds.reduce((sum, id) => {
      const item = (serviceItems ?? []).find((s) => s.id === id);
      const quantity = Number(itemQuantities[id] ?? "1") || 1;
      return sum + (item?.duration_minutes ?? 0) * quantity;
    }, 0);
  }, [serviceItemIds, serviceItems, itemQuantities]);

  // §2.3 步驟 1 的「逐項小計」= Σ(unit_price × quantity)。
  const itemsSubtotal = useMemo(() => {
    return serviceItemIds.reduce((sum, id) => {
      const quantity = Number(itemQuantities[id] ?? "1") || 0;
      const unitPrice = Number(itemUnitPrices[id] ?? "0") || 0;
      return sum + quantity * unitPrice;
    }, 0);
  }, [serviceItemIds, itemQuantities, itemUnitPrices]);

  // §4.8 金額即時預覽:跟後端 private.calculate_booking_amount 相同公式,體驗層預覽,
  // 真正落地金額由後端重算(規則 2.2)。
  const amountPreview = useMemo(
    () =>
      calculateBookingAmountPreview({
        itemsSubtotal,
        customTotalAmountEnabled,
        customTotalAmount: customTotalAmount.trim() ? Number(customTotalAmount) : null,
        discountEnabled,
        discountMode,
        discountValue: discountValue.trim() ? Number(discountValue) : null,
        taxEnabled,
        taxMode,
        taxValue: taxValue.trim() ? Number(taxValue) : null,
      }),
    [
      itemsSubtotal,
      customTotalAmountEnabled,
      customTotalAmount,
      discountEnabled,
      discountMode,
      discountValue,
      taxEnabled,
      taxMode,
      taxValue,
    ],
  );

  const materialCostTotal = useMemo(() => {
    return materialCostItemIds.reduce((sum, id) => {
      const item = (materialCostItems ?? []).find((m) => m.id === id);
      return sum + (item ? Number(item.amount) : 0);
    }, 0);
  }, [materialCostItemIds, materialCostItems]);

  function toggleInArray(current: string[], id: string): string[] {
    return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
  }

  /** 服務項目勾選/取消勾選:勾選時初始化數量=1、單價=service_items.price 當下的即時值
   * (§4.2:這是「建立當下」唯一允許讀取即時資料當作預設值的地方,客服可以手動修改);
   * 取消勾選時把對應的數量/單價從狀態裡移除,避免殘留舊值造成混淆。 */
  function toggleServiceItem(itemId: string, defaultPrice: number) {
    setServiceItemIds((prev) => toggleInArray(prev, itemId));
    setItemQuantities((prev) => {
      if (itemId in prev) {
        const next = { ...prev };
        delete next[itemId];
        return next;
      }
      return { ...prev, [itemId]: "1" };
    });
    setItemUnitPrices((prev) => {
      if (itemId in prev) {
        const next = { ...prev };
        delete next[itemId];
        return next;
      }
      return { ...prev, [itemId]: String(defaultPrice) };
    });
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
    if (requiresCustomerAddress && !customerAddress.trim()) {
      toast.error("請填寫客戶地址");
      return;
    }
    if (amountPreview.error) {
      // §4.8:金額預覽算出來的錯誤(例如折扣超過小計),體驗層先擋一次,避免明知道會被後端
      // 擋下還讓客服白跑一趟(真正的邊界仍在後端 create_booking/update_booking)。
      toast.error(amountPreview.error);
      return;
    }

    setSaving(true);
    try {
      const shared = {
        staffId,
        serviceItems: serviceItemIds.map<BookingServiceItemSelectionInput>((id) => ({
          serviceItemId: id,
          quantity: Number(itemQuantities[id] ?? "1") || 1,
          unitPrice: Number(itemUnitPrices[id] ?? "0") || 0,
        })),
        startAt: buildTaipeiIso(dateKey, time),
        customerName,
        customerPhone,
        customerEmail: customerEmail.trim() ? customerEmail.trim() : null,
        customerAddress: customerAddress.trim() ? customerAddress.trim() : null,
        notes: notes.trim() ? notes.trim() : null,
        customerNotes: customerNotes.trim() ? customerNotes.trim() : null,
        assistantStaffIds,
        materialCostItemIds,
        customTotalAmountEnabled,
        customTotalAmount: customTotalAmountEnabled && customTotalAmount.trim() ? Number(customTotalAmount) : null,
        discountEnabled,
        discountMode: discountEnabled ? discountMode : null,
        discountValue: discountEnabled && discountValue.trim() ? Number(discountValue) : null,
        taxEnabled,
        taxMode: taxEnabled ? taxMode : null,
        taxValue: taxEnabled && taxValue.trim() ? Number(taxValue) : null,
        paymentMethod: paymentMethodOnSite ? "on_site" : null,
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

        {/* min-w-0:同樣的原因,DialogContent 是 grid,這個 div 是它的直接子元素(grid item),
            預設 min-width:auto 會被裡面過長的文字(例如服務人員下拉選單目前選中的長姓名)撐寬,
            進而撐寬整個對話框超出手機螢幕,見 BookingDetailDialog 那邊同一個修法的說明。 */}
        <div className="min-w-0 space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
            <div className="sm:col-span-2">
              <Label>預約日期時間 *</Label>
              <div className="mt-2">
                <BookingDateTimeField
                  merchantId={merchantId}
                  staffId={staffId}
                  totalDurationMinutes={totalDurationMinutes}
                  dateKey={dateKey}
                  time={time}
                  closedWeekdays={closedWeekdays}
                  onChange={(d, t) => {
                    setDateKey(d);
                    setTime(t);
                  }}
                />
              </div>
            </div>
          </div>

          {/* 建單功能擴充 2.1/5.1 第 1 點,模組 6 §4.1/4.2:服務項目改多選,每項可調整數量
              (預設 1,最小 1,整數)跟單價(預設帶入 service_items.price,可手動修改),
              即時顯示工時加總(§2.2:duration_minutes × quantity)。 */}
          <div>
            <Label>服務項目(可多選) *</Label>
            <div className="mt-2 max-h-64 space-y-2 overflow-y-auto rounded-md border border-border p-2">
              {(serviceItems ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">目前沒有上架中的服務項目。</p>
              ) : (
                (serviceItems ?? []).map((item) => {
                  const checked = serviceItemIds.includes(item.id);
                  return (
                    <div key={item.id} className="rounded px-1 py-1 hover:bg-muted/50">
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleServiceItem(item.id, Number(item.price))}
                        />
                        <span>
                          {item.name}({item.duration_minutes} 分鐘・預設 {formatAmount(Number(item.price))})
                        </span>
                      </label>
                      {checked ? (
                        <div className="ml-6 mt-1.5 flex flex-wrap items-center gap-3 text-xs">
                          <div className="flex items-center gap-1.5">
                            <span className="text-muted-foreground">數量</span>
                            <Input
                              type="number"
                              min={1}
                              step={1}
                              className="h-8 w-16"
                              value={itemQuantities[item.id] ?? "1"}
                              onChange={(e) =>
                                setItemQuantities((prev) => ({ ...prev, [item.id]: e.target.value }))
                              }
                            />
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-muted-foreground">單價</span>
                            <Input
                              type="number"
                              min={0}
                              step="0.01"
                              className="h-8 w-24"
                              value={itemUnitPrices[item.id] ?? String(item.price)}
                              onChange={(e) =>
                                setItemUnitPrices((prev) => ({ ...prev, [item.id]: e.target.value }))
                              }
                            />
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              已選 {serviceItemIds.length} 項,總工時 {totalDurationMinutes} 分鐘。
            </p>
          </div>

          {/* 建單功能擴充 2.2/5.1 第 2 點,建單表單細節修正第四節:助手欄位排除已選為主要服務人員
              的那一位,可留空;未選定主要服務人員前整個區塊停用(checkbox disabled + 提示文字),
              因為助手是依附在「這次由誰負責」之下的角色,順序上要先決定主要服務人員。 */}
          <div>
            <Label>助手(可留空,可多選)</Label>
            {!staffId ? (
              <p className="mt-2 text-[11px] text-muted-foreground">請先選擇服務人員,才能指派助手。</p>
            ) : null}
            <div
              className={cn(
                "mt-2 max-h-32 space-y-1.5 overflow-y-auto rounded-md border border-border p-2",
                !staffId && "pointer-events-none opacity-50",
              )}
            >
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
                      disabled={!staffId}
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

          {/* 模組 6(訂單管理)§4.4~4.8:金額彈性三個開關(自訂總金額/折扣/稅金)+ 付款方式 +
              即時金額預覽。不含 §4.3 自訂工時開關(留給下一批獨立處理)。 */}
          <div className="space-y-3 rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label>自訂總金額</Label>
                <p className="text-[11px] text-muted-foreground">開啟後用輸入的總金額取代逐項小計。</p>
              </div>
              <Switch checked={customTotalAmountEnabled} onCheckedChange={setCustomTotalAmountEnabled} />
            </div>
            {customTotalAmountEnabled ? (
              <Input
                type="number"
                min={0}
                step="0.01"
                placeholder="輸入這筆訂單的總金額"
                value={customTotalAmount}
                onChange={(e) => setCustomTotalAmount(e.target.value)}
              />
            ) : null}

            <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
              <div>
                <Label>折扣優惠</Label>
                <p className="text-[11px] text-muted-foreground">固定金額或百分比二選一。</p>
              </div>
              <Switch checked={discountEnabled} onCheckedChange={setDiscountEnabled} />
            </div>
            {discountEnabled ? (
              <div className="flex gap-2">
                <Select value={discountMode} onValueChange={(v) => setDiscountMode(v as AmountAdjustmentMode)}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed">{AMOUNT_ADJUSTMENT_MODE_LABELS.fixed}</SelectItem>
                    <SelectItem value="percentage">{AMOUNT_ADJUSTMENT_MODE_LABELS.percentage}</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  min={0}
                  max={discountMode === "percentage" ? 100 : undefined}
                  step="0.01"
                  placeholder={discountMode === "percentage" ? "0~100 的數字" : "折扣金額"}
                  value={discountValue}
                  onChange={(e) => setDiscountValue(e.target.value)}
                />
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
              <div>
                <Label>稅金</Label>
                <p className="text-[11px] text-muted-foreground">
                  模式固定依商家設定(目前:{AMOUNT_ADJUSTMENT_MODE_LABELS[taxMode]}),數字可個別調整。
                </p>
              </div>
              <Switch checked={taxEnabled} onCheckedChange={setTaxEnabled} />
            </div>
            {taxEnabled ? (
              <Input
                type="number"
                min={0}
                max={taxMode === "percentage" ? 100 : undefined}
                step="0.01"
                placeholder={taxMode === "percentage" ? "稅率(0~100 的數字)" : "稅額"}
                value={taxValue}
                onChange={(e) => setTaxValue(e.target.value)}
              />
            ) : null}

            <label className="flex items-center gap-2 border-t border-border pt-3 text-sm">
              <Checkbox checked={paymentMethodOnSite} onCheckedChange={(v) => setPaymentMethodOnSite(v === true)} />
              <span>付款方式:{PAYMENT_METHOD_OPTIONS["on_site"]}</span>
            </label>

            {/* §4.8 金額即時預覽,體驗層,真正落地金額由後端重算(規則 2.2)。 */}
            <div className="space-y-1 rounded-md bg-muted/40 p-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">小計</span>
                <span>{formatAmount(amountPreview.subtotalAmount)}</span>
              </div>
              {discountEnabled ? (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">折扣</span>
                  <span>-{formatAmount(amountPreview.discountAmount)}</span>
                </div>
              ) : null}
              {taxEnabled ? (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">稅金</span>
                  <span>+{formatAmount(amountPreview.taxAmount)}</span>
                </div>
              ) : null}
              <div className="flex items-center justify-between border-t border-border pt-1 font-semibold text-foreground">
                <span>最終金額</span>
                <span>{formatAmount(amountPreview.finalAmount)}</span>
              </div>
              {amountPreview.error ? <p className="text-warn">{amountPreview.error}</p> : null}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
            {/* 建單表單細節修正第二節:只有 industry_type 需要地址的產業(見
                INDUSTRY_REQUIRES_CUSTOMER_ADDRESS)才顯示這個欄位並標記必填,不需要地址的產業
                整個欄位不顯示。真正擋住不合法的空地址還是 create_booking/update_booking 資料庫層。 */}
            {requiresCustomerAddress ? (
              <div className="sm:col-span-2">
                <Label htmlFor="booking-customer-address">客戶地址 *</Label>
                <Input
                  id="booking-customer-address"
                  className="mt-2"
                  value={customerAddress}
                  onChange={(e) => setCustomerAddress(e.target.value)}
                />
              </div>
            ) : null}
            {/* 預約詳情資訊擴充與建單備註分類第一節:備註分成「內部備註」(既有 notes 欄位,
                商家內部看、客戶看不到,這次只改標籤文字,欄位本身不改名)跟「客戶備註」
                (新欄位 customer_notes,客戶看得到),兩個欄位並排顯示。 */}
            <div>
              <Label htmlFor="booking-notes">內部備註</Label>
              <Textarea
                id="booking-notes"
                className="mt-2"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="booking-customer-notes">客戶備註</Label>
              <Textarea
                id="booking-customer-notes"
                className="mt-2"
                rows={2}
                value={customerNotes}
                onChange={(e) => setCustomerNotes(e.target.value)}
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
// 5.2:預約詳情 + 確認/標記完成/編輯/取消操作。這顆彈窗已經抽成獨立檔案
// BookingDetailDialog.tsx(模組 6/訂單管理 §1.1 要求「沿用既有元件,不重做」,讓訂單管理頁
// 也能直接複用同一顆彈窗),這裡只保留 import,不再重複定義。
// ---------------------------------------------------------------------------
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
        industryType={merchant!.industry_type as IndustryType}
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
