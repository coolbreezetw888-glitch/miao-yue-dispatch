// 對應規格書 4.3(行事曆總覽頁)、4.4(手動建單表單)、4.5(標記完成/取消預約操作),
// 建單功能擴充第一節(月/週切換、日期預約標示、排程色塊視覺優化)、5.1(建單表單擴充)、
// 5.2(預約詳情操作按鈕擴充)、5.3(編輯預約表單)。
//
// 时区說明:系統目前假設所有商家都在 Asia/Taipei(規格書「本模組明確不做的事」),這裡的日期/時間
// 一律以 Asia/Taipei 的日曆日/時鐘時間為準,送往後端的 start_at 一律明確帶 +08:00 偏移量,
// 不依賴瀏覽器本機時區(避免使用者瀏覽器時區設定不是台灣時導致算錯)。
//
// ui-v1-full 第二階段第 2 批(2026-09-29,盤點 A10):
//   - 新增 / 編輯預約表單(全系統最大的表單)從 Sheet(底部 92vh)換成 ui-overlay-patterns 的全頁層
//     FullPageLayer(手機滿版 / 電腦置中面板、標題列與按鈕列固定、只有中間捲動),底部「取消 / 建立預約
//     或儲存變更」等寬(skill 二之三)。
//   - 依 skill 二之九 分成七組:客戶 → 人員 → 時間 → 服務項目 → 金額 → 料錢成本 → 備註。
//     ⚠️ skill 原文的順序是「客戶 → 時間 → 人員」,這裡把「人員」排在「時間」前面,因為日期時間選擇器要先知道
//     是哪位服務人員才列得出可預約時段(選單裡會顯示「請先選擇服務人員」)——照原文順序會讓人填到一半得往下
//     跳。這是 engineer 的判斷,已在交付回報中列出請主腦裁決。
//   - 服務項目:選中的展開成一張卡(定價 + 數量 + 單價輸入框),沒選的縮成可點的小方塊排在下面
//     (skill 二之九);分類篩選只影響下面沒選的方塊,已選的卡永遠看得到。
//   - 金額整組用色塊包起來,三個開關改 SwitchRow、#829 的鎖定說明改 `!` 常駐放在開關列底下;折扣模式與
//     付款方式改 ChoiceChipGroup(skill 二之七 單選);即時預覽改明細列(小計 / 折扣 / 稅金 / 最終金額 26px)。
//   - 助手、料錢成本的多選改可點方塊(ChoiceChip);欄位改 FormField / FieldInput / FieldAmountInput /
//     FieldSelect / FieldTextarea。
//   - 行事曆主頁:頁首改 PageHeader、週 / 月檢視切換改 ChoiceChipGroup、切換按鈕改次要樣式、載入中改骨架、
//     空狀態改 EmptyState(+ 下一步);時間軸格線套 skill 六:時間欄固定在左邊(sticky)、服務人員欄有最小
//     寬度、右緣漸層陰影暗示還有內容。手勢(#641 點擊 vs 拖曳、#811 長按拖拉)完全不動。
// **只動外觀與版面,不動任何行為**:所有驗證、送出、金額 / 工時計算、#829 的鎖定判斷、幽靈空值防護照舊。
//
// 🔴 2026-09-30 回歸修正(品管第二次打回):上面那句「不動任何行為」在金額欄位上是錯的 ——
// 把 `type="number" min={0} step="1"` 換成 `FieldAmountInput`(`type="text"`)就等於把原生約束拆掉了,
// 而本檔 4 個金額欄位(自訂總金額 / 折扣金額 / 稅額 / 每個已選服務項目的單價)當時都沒補上驗證,
// 送出路徑也還是裸 `Number()`(預覽 5 處 + 送出 4 處,共 9 處)。現在一律走
// `bookingAmountFields.ts` 的 `resolveBookingAmountFields`,**預覽、#829 單價調整判定、送出 payload
// 三處共用同一份解析結果**,任何一格解析失敗就標紅 + 送出按鈕 disabled + 底部常駐 `!` 說明原因。
// 📌 教訓:**換掉輸入元件的 type 就是改行為**,不是純外觀改動。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  ActionBar,
  AlertNote,
  ChoiceChip,
  ChoiceChipGroup,
  DetailDivider,
  DetailRow,
  DetailSection,
  EmptyState,
  ErrorState,
  FieldAmountInput,
  FieldInput,
  FieldSelect,
  FieldTextarea,
  FormField,
  FullPageLayer,
  FullPageLayerClose,
  FullPageLayerContent,
  LoadingSkeleton,
  PageHeader,
  SwitchRow,
  useHorizontalScrollHint,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { cn } from "@/lib/utils";
// 2026-09-24 稽核修正(問題 3):Radix Select 幽靈空值事件的共用防護,見該檔案開頭的完整說明。
import { guardPhantomEmptyChange } from "@/lib/radixSelectGuard";
// 2026-09-24 稽核修正(問題 2):客戶 Email 欄位的格式驗證,沿用電話驗證既有的共用檔案。
import {
  EMAIL_ERROR_MESSAGE,
  isValidEmail,
  isValidTaiwanPhone,
  TW_PHONE_ERROR_MESSAGE,
} from "@/lib/validation";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { getFeatureFlag } from "@/modules/merchant/api";
import { INDUSTRY_REQUIRES_CUSTOMER_ADDRESS, type IndustryType } from "@/modules/merchant/types";
import {
  useAgentPermission,
  useCurrentMerchantRole,
  useMerchantStaffList,
} from "@/modules/staff-agent/context";
import {
  useMerchantServiceCategories,
  useMerchantServiceItems,
} from "@/modules/service-items/context";
import { UNCATEGORIZED_LABEL } from "@/modules/service-items/types";
import {
  MemberPhoneMatchPanel,
  type SelectedMember,
} from "@/modules/members/MemberPhoneMatchPanel";
// 模組 15(服務人員推播通知)規則 4.5:訂單內容異動的一句話摘要,由前端在呼叫 update_booking
// 之前先算好(見下方 handleSubmit),當作參數傳給 updateBooking → dispatchPushNotification。
import { computeBookingChangeSummary } from "@/modules/push-notifications/changeSummary";

import {
  createBooking,
  getBooking,
  updateBooking,
  MATERIAL_COST_ENABLED_FEATURE_KEY,
  type BookingServiceItemSelectionInput,
} from "./api";
import { BookingDetailDialog } from "./BookingDetailDialog";
import {
  setStaffDayOverride,
  useMerchantBookings,
  useMerchantBookingStatusColors,
  useMerchantBusinessHours,
  useMerchantCalendarStateStyles,
  useMerchantDaySchedule,
  useMerchantMaterialCostItems,
  useMerchantPaymentMethods,
  useMerchantTaxSettings,
} from "./context";
// 建單與訂單管理介面優化 §1:拿掉 DayOverrideDialog 互動流程,不再需要 timeToMinutes/minutesToTime
// 之外的「選時間範圍」相關計算——這兩支仍然給 BookingDateTimeField/背景格線切格使用,繼續 import。
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
// 2026-09-24 稽核修正(問題 5):時段清單要排除整天請假/單日排休,計算邏輯抽成純函式方便測試。
import { buildBookingSlotOptions } from "./bookingSlotOptions";
// SPECS-INDEX #811~#817:行事曆拖拉改時間/轉派的接線層(色塊手勢、殘影、toast/復原、過去時間確認框),
// 模式判定與落點計算的純邏輯在 bookingDragMove.ts,這個檔案只傳資料、不重複實作任何規則。
import {
  BookingDragGhost,
  DraggableBookingBlock,
  PastDropConfirmDialog,
  useCalendarBookingDrag,
} from "./calendarBookingDrag";
// 2026-09-24 稽核修正(問題 1):數量欄位清空時三處 fallback 不一致(畫面顯示 $0、實際送出全額),
// 統一走這支共用解析函式,見該檔案開頭的完整說明。
import { parseItemQuantity } from "./itemQuantity";
import {
  resolveBookingAmountFields,
  resolveEnteredUnitPrice,
  resolveUnitPrice,
} from "./bookingAmountFields";
import { calculateBookingAmountPreview, formatAmount } from "./orderAmount";
import { RequireBookingAccess } from "./RequireBookingAccess";
// 模組 14(服務人員端)規格書 4.3:目前這位使用者該看服務人員端時渲染服務人員自助行事曆,不渲染
// 下面給管理員/客服看的跨服務人員行事曆(CalendarPageInner)。這是本檔案唯一一處依賴模組 14 的地方。
import MyCalendarPage from "@/modules/staff-portal/MyCalendarPage";
// 2026-09-24 修正:CalendarPageRoleGate 改讀共用外殼算好的 isStaffView/isViewResolved,
// 不再自己用 role==='staff' 判斷(雙重身分使用者會被誤判),詳見該元件上方註解。
import { useAppLayoutContext } from "@/routes/AppLayout";
import {
  AMOUNT_ADJUSTMENT_MODE_LABELS,
  bookingBlockStyle,
  buildPaymentMethodOptions,
  calendarStateBlockStyle,
  DEFAULT_BOOKING_STATUS_COLORS,
  DEFAULT_CALENDAR_STATE_STYLES,
  filterServiceItemsByCategory,
  getTaxModeHelperText,
  type AmountAdjustmentMode,
  type BookingStatus,
  type CalendarStateStyleMap,
  type DayScheduleOwnBooking,
  type ServiceItemCategoryFilter,
} from "./types";

// SPECS-INDEX #811(行事曆拖拉):這兩個格線常數改成 export,拖拉的落點計算(bookingDragMove.ts
// computeDropTarget)與 Playwright 座標計算都要用同一組數字,不在別處再抄一份。
export const SLOT_MINUTES = 30;
export const SLOT_PX = 30;

/** 建單與訂單管理介面優化 §3:付款方式下拉選單的「(未選擇/尚未設定)」sentinel 值。 */
const PAYMENT_METHOD_UNSET = "__unset__";

type CalendarViewMode = "week" | "month";

const CALENDAR_VIEW_OPTIONS: ReadonlyArray<{ value: CalendarViewMode; label: string }> = [
  { value: "week", label: "週檢視" },
  { value: "month", label: "月檢視" },
];

/** 折扣 / 稅金的「固定金額 / 百分比」二選一,白名單直接取 AMOUNT_ADJUSTMENT_MODE_LABELS 的 key。 */
const AMOUNT_ADJUSTMENT_MODE_OPTIONS = (
  Object.keys(AMOUNT_ADJUSTMENT_MODE_LABELS) as AmountAdjustmentMode[]
).map((mode) => ({ value: mode, label: AMOUNT_ADJUSTMENT_MODE_LABELS[mode] }));

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
  id,
  merchantId,
  staffId,
  totalDurationMinutes,
  dateKey,
  time,
  closedWeekdays,
  onChange,
}: {
  id?: string | undefined;
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

  // 2026-09-24 稽核修正(問題 5):這位服務人員這一天是不是整天請假。有值時下面的時段清單
  // 一定是空的,改成顯示「這天休假」的說明,不要讓客服把整張表單填完送出才被後端擋下。
  const onLeave = staffBlock?.on_leave ?? null;

  // 第 3 點:只列出總工時能完整放進某個可預約區間的起始時間點,以現有的 SLOT_MINUTES 切格。
  // 2026-09-24 稽核修正(問題 5):同時排除整天請假(on_leave)跟單日排休
  // (availability_overrides 且 is_available=false)——這兩份資料本來就在同一包
  // get_merchant_day_schedule 回傳值裡,以前只讀了 available_windows 沒讀它們,
  // 導致行事曆主畫面已經整欄灰掉的師傅,在建單表單裡照樣列得出所有時段。
  // 實際計算搬到 bookingSlotOptions.ts(純函式,有單元測試),這裡只負責把資料餵進去。
  const slotOptions = useMemo(() => {
    if (!staffBlock) return [];
    return buildBookingSlotOptions({
      availableWindows: staffBlock.available_windows,
      availabilityOverrides: staffBlock.availability_overrides,
      onLeave: Boolean(staffBlock.on_leave),
      totalDurationMinutes,
      slotMinutes: SLOT_MINUTES,
    });
  }, [staffBlock, totalDurationMinutes]);

  const label = dateKey && time ? formatDisplayDateTime(dateKey, time) : "請選擇日期時間";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="neutral"
          size="touch"
          className="w-full justify-start font-normal tabular-nums"
        >
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
          ) : onLeave ? (
            /* 2026-09-24 稽核修正(問題 5):整天請假時明確說明原因(含假別名稱快照),
               不要只顯示「這天沒有可預約的時段」讓客服猜是哪裡設錯。
               這是體驗層引導,真正擋下建單的仍然是後端 create_booking 的驗證。 */
            <AlertNote>這位服務人員這天休假({onLeave.leave_type_name}),無法建立預約。</AlertNote>
          ) : slotOptions.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground">這天沒有可預約的時段</p>
          ) : (
            <div className="grid max-h-48 grid-cols-3 gap-1.5 overflow-y-auto">
              {slotOptions.map((t) => (
                <Button
                  key={t}
                  type="button"
                  size="card"
                  variant={time === t ? "primary" : "neutral"}
                  className="tabular-nums"
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

/** 建單功能擴充規格書 2.3:料錢成本功能開關(查無資料視為關閉)。跟 MaterialCostsPage.tsx
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
  // SPECS-INDEX #598(訂單管理.md §9.2):服務項目勾選區塊上方的分類篩選下拉選單,純前端依既有
  // 分類值篩選,不新增或調整任何資料結構。
  const { data: serviceCategories } = useMerchantServiceCategories(merchantId);
  const { data: materialCostItems } = useMerchantMaterialCostItems(merchantId);
  const { data: materialCostEnabled } = useMaterialCostEnabled(merchantId);
  const { data: businessHours } = useMerchantBusinessHours(merchantId);
  // 模組 9(支付方式)v2 §5.2:建單表單下拉選單只列出商家自訂清單裡目前上架中(status='active')
  // 的項目,商家可以自己新增/編輯/下架,不是系統固定清單。
  const { data: paymentMethods } = useMerchantPaymentMethods(merchantId);

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
  // SPECS-INDEX #598:分類篩選只影響「顯示哪些選項讓你勾」,不影響「已經勾了哪些」(serviceItemIds
  // 是獨立狀態,不受篩選影響,切換篩選不會弄丟已經勾選的項目)。
  const [categoryFilter, setCategoryFilter] = useState<ServiceItemCategoryFilter>("all");
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
  // SPECS-INDEX #850~#853/#857(2026-09-30 使用者需求):這一筆訂單的內部備註要不要對服務人員隱藏。
  // 🔴 編輯模式一定要把既有值帶入(下面 useEffect),送出時一定要無條件帶出去(handleSubmit)——
  //    漏掉任何一邊,客服只要編輯一次訂單,原本藏起來的備註就自動公開給服務人員了,而且不報錯、
  //    畫面上也看不出來(跟 member 那個既有陷阱同一個形狀,見 api.ts 的 ⚠️ 註解)。
  const [hideNotesFromStaff, setHideNotesFromStaff] = useState(false);
  // SPECS-INDEX #614(會員與紅利.md §10.2):選填的會員連結,不選就是訪客訂單。編輯模式下用既有的
  // member_id/member_name_snapshot 帶入初始值,避免正常編輯流程意外清空既有連結(判斷 9)。
  const [member, setMember] = useState<SelectedMember | null>(null);
  const [saving, setSaving] = useState(false);

  // 模組 6(訂單管理)§4.1/4.2:每個已勾選服務項目的數量/單價(字串狀態,方便控制輸入框,
  // 送出時再轉數字)。key 是 service_item_id。
  const [itemQuantities, setItemQuantities] = useState<Record<string, string>>({});
  const [itemUnitPrices, setItemUnitPrices] = useState<Record<string, string>>({});
  // SPECS-INDEX #829 使用者裁決修正(2026-09-29 第三輪):編輯既有訂單時,「單價有沒有被個別調整」的
  // 比對基準。開啟表單、editingDetail 載入時,把每個服務項目的 unit_price_snapshot(以及名稱,下架
  // 項目不在 serviceItems 清單裡時要靠這裡的名稱顯示)另存一份,之後 adjustedUnitPriceItemNames
  // 就拿目前輸入值跟這份基準比,而不是跟 service_items.price 現價比。新增預約模式這份永遠是空的。
  const [loadedUnitPriceSnapshots, setLoadedUnitPriceSnapshots] = useState<
    Record<string, { price: number; name: string }>
  >({});

  // §4.3 自訂工時開關(裁決 Q3 方向一):開啟後 end_at 直接改用這裡輸入的總服務時長計算,
  // 會真的影響排程佔用與衝突檢查邊界(含第五節單日例外第三層),不是只影響前端顯示。
  const [customDurationEnabled, setCustomDurationEnabled] = useState(false);
  const [customDurationMinutes, setCustomDurationMinutes] = useState("");

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
  // 模組 9(支付方式)v2 §5.2:付款方式,存的是 payment_methods.id(uuid 字串),留空
  // 代表「尚未設定」。用 PAYMENT_METHOD_UNSET 這個 sentinel 值代表「(未選擇/尚未設定)」
  // (沿用建單與訂單管理介面優化 §3 既有的 sentinel 寫法)。
  const [paymentMethodValue, setPaymentMethodValue] = useState<string>(PAYMENT_METHOD_UNSET);

  // 模組 9 v2 §5.2:選項 = 商家目前上架中的付款方式,再加上「這筆訂單編輯前本來就選的
  // 那一筆」(即使它現在已經下架),詳見 types.ts buildPaymentMethodOptions 的說明。
  const paymentMethodOptions = useMemo(
    () =>
      buildPaymentMethodOptions(
        paymentMethods ?? [],
        isEdit ? (editingDetail?.payment_method_id ?? null) : null,
        isEdit ? (editingDetail?.payment_method_name_snapshot ?? null) : null,
      ),
    [paymentMethods, isEdit, editingDetail],
  );

  const { data: merchantTaxSettings } = useMerchantTaxSettings(merchantId);

  // 每次開啟時重設表單:新建模式依 prefill(金額相關欄位一律回到「全部關閉」,稅金數字預設帶入
  // 商家目前設定,這是「建立當下」唯一允許讀取即時資料當作預設值的地方,§2.4 第 2 點);
  // 編輯模式等 editingDetail 載入後帶入既有的金額快照值,不重新查詢商家目前設定。
  useEffect(() => {
    if (!open) return;
    setCategoryFilter("all"); // #598:每次開啟表單,分類篩選重設為「全部」。
    if (isEdit) {
      if (!editingDetail) return; // 還在載入中,等資料回來再帶入
      setStaffId(editingDetail.staff_id);
      setServiceItemIds(editingDetail.serviceItems.map((i) => i.id));
      setItemQuantities(
        Object.fromEntries(editingDetail.serviceItems.map((i) => [i.id, String(i.quantity)])),
      );
      setItemUnitPrices(
        Object.fromEntries(
          editingDetail.serviceItems.map((i) => [i.id, String(i.unitPriceSnapshot)]),
        ),
      );
      // #829 使用者裁決修正:同一份快照另存成「已調整判定」的基準,見 loadedUnitPriceSnapshots 說明。
      setLoadedUnitPriceSnapshots(
        Object.fromEntries(
          editingDetail.serviceItems.map((i) => [
            i.id,
            { price: Number(i.unitPriceSnapshot), name: i.name },
          ]),
        ),
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
      // SPECS-INDEX #857:帶入既有的隱藏設定。**這一行跟 handleSubmit 無條件帶值是同一件事的
      // 兩面,不要只做一半** —— 少了它,客服編輯一筆已經藏起來的訂單、完全沒碰那個開關,
      // 送出後旗標就被送成 false,備註靜默公開。
      setHideNotesFromStaff(editingDetail.hide_notes_from_staff);
      setMember(
        editingDetail.member_id && editingDetail.member_name_snapshot
          ? { id: editingDetail.member_id, name: editingDetail.member_name_snapshot }
          : null,
      );
      setCustomTotalAmountEnabled(editingDetail.custom_total_amount_enabled);
      setCustomTotalAmount(
        editingDetail.custom_total_amount !== null ? String(editingDetail.custom_total_amount) : "",
      );
      setDiscountEnabled(editingDetail.discount_enabled);
      setDiscountMode((editingDetail.discount_mode as AmountAdjustmentMode | null) ?? "fixed");
      setDiscountValue(
        editingDetail.discount_value !== null ? String(editingDetail.discount_value) : "",
      );
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
      // 模組 9 v2 §5.2 邊界情況:編輯既有訂單時,即使商家事後把這筆訂單原本的付款方式下架,
      // 這裡仍要沿用既有值(不強制清空成「未選擇」)——舊訂單顯示/編輯不受商家事後下架影響。
      setPaymentMethodValue(editingDetail.payment_method_id ?? PAYMENT_METHOD_UNSET);
      // §4.3/§2.4:編輯表單一律用既有快照值預先帶入,不重新計算。
      setCustomDurationEnabled(editingDetail.custom_duration_enabled);
      setCustomDurationMinutes(
        editingDetail.custom_duration_minutes !== null
          ? String(editingDetail.custom_duration_minutes)
          : "",
      );
    } else {
      setStaffId(prefill.staffId ?? "");
      setServiceItemIds([]);
      setItemQuantities({});
      setItemUnitPrices({});
      setLoadedUnitPriceSnapshots({});
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
      // SPECS-INDEX #850:新建訂單一律從「不隱藏」開始(= 使用者要的「預設服務人員看得到」),
      // 跟資料庫 default false 一致。
      setHideNotesFromStaff(false);
      setMember(null);
      setCustomTotalAmountEnabled(false);
      setCustomTotalAmount("");
      setDiscountEnabled(false);
      setDiscountMode("fixed");
      setDiscountValue("");
      setTaxEnabled(false);
      setTaxMode(merchantTaxSettings?.taxMode ?? "percentage");
      setTaxValue(merchantTaxSettings ? String(merchantTaxSettings.taxValue) : "");
      setPaymentMethodValue(PAYMENT_METHOD_UNSET);
      setCustomDurationEnabled(false);
      setCustomDurationMinutes("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isEdit, editingDetail, merchantTaxSettings]);

  // 🔴 2026-09-30(品管第二次打回 + 主腦複查):四個金額欄位(自訂總金額 / 折扣金額 / 稅額 /
  // 每個服務項目的單價)全部是 FieldAmountInput(type="text"),原生的 min / step 已經不存在,
  // 送出路徑卻還留著 9 處裸 `Number()`。實測 `abc` 會讓最終金額變 NaN 且毫無提示就能送出,
  // `Infinity` / `1e3` / `0x10` 也全部通過,單價填錯字會靜默算成 0 元(這項服務變免費)。
  // 解析集中在 resolveBookingAmountFields 這一支,**畫面預覽、#829 單價調整判定、送出 payload
  // 三處一律從這個物件取值**,不允許任何一處自己再 Number()——否則又會出現「畫面算得出來、
  // 按儲存卻被擋」這種對不起來的狀況。完整背景見 bookingAmountFields.ts 開頭。
  const amountFields = useMemo(
    () =>
      resolveBookingAmountFields({
        serviceItemIds,
        itemUnitPrices,
        customTotalAmountEnabled,
        customTotalAmount,
        discountEnabled,
        discountMode,
        discountValue,
        taxEnabled,
        taxMode,
        taxValue,
      }),
    [
      serviceItemIds,
      itemUnitPrices,
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

  // 模組 6 §2.2 新公式:每個服務項目的工時貢獻 = duration_minutes × quantity。
  const itemsTotalDurationMinutes = useMemo(() => {
    return serviceItemIds.reduce((sum, id) => {
      const item = (serviceItems ?? []).find((s) => s.id === id);
      // 2026-09-24 稽核修正(問題 1):跟金額預覽、實際送出三處一律走同一支 parseItemQuantity。
      const quantity = parseItemQuantity(itemQuantities[id]);
      return sum + (item?.duration_minutes ?? 0) * quantity;
    }, 0);
  }, [serviceItemIds, serviceItems, itemQuantities]);

  // §4.3(裁決 Q3 方向一):自訂工時開啟時,實際用來排時段/顯示的總工時直接改用自訂值,
  // 取代逐項加總結果——這裡只是「顯示用/日期時間選擇器用」的體驗層計算,真正落地的 end_at
  // 由後端 create_booking/update_booking 依同一套規則重算(§4.3 第 2 點)。
  const totalDurationMinutes = customDurationEnabled
    ? Number(customDurationMinutes) || 0
    : itemsTotalDurationMinutes;

  // §2.3 步驟 1 的「逐項小計」= Σ(unit_price × quantity)。
  const itemsSubtotal = useMemo(() => {
    return serviceItemIds.reduce((sum, id) => {
      // 2026-09-24 稽核修正(問題 1):這裡原本的 fallback 是 `|| 0`,跟工時加總、實際送出的
      // `|| 1` 不一致——數量格子清空時,畫面上的小計/最終金額會顯示 $0,後端卻收到 quantity=1
      // 存成全額,對帳時完全對不上。三處統一改用 parseItemQuantity。
      const quantity = parseItemQuantity(itemQuantities[id]);
      // 🔴 2026-09-30:原本是 `Number(itemUnitPrices[id] ?? "0") || 0` —— 那個 `|| 0` 就是
      // 「單價打錯字 → 這項服務靜默變免費」的來源。改走 resolveUnitPrice,跟 handleSubmit
      // 送出的 unitPrice 是同一支函式、同一份解析結果;解析失敗時送出會被 amountFields.hasError 擋下。
      const unitPrice = resolveUnitPrice(amountFields, id);
      return sum + quantity * unitPrice;
    }, 0);
  }, [serviceItemIds, itemQuantities, amountFields]);

  // SPECS-INDEX #829(2026-09-29 使用者巡檢回報第 5 項,裁決 Q1 採 (B) 方案):「自訂總金額」跟
  // 「逐項改單價」是兩套會互相打架的算法——已經手動改過任一個服務項目的單價之後,再用一個總金額
  // 蓋掉它,對帳時看不出哪個才是本意。任一個已勾選項目目前填的單價 ≠ 它的「基準值」,就算
  // 「已個別調整金額」。單價欄位的解析方式刻意跟 handleSubmit 實際送出的值走同一支
  // resolveEnteredUnitPrice(同一份 amountFields 解析結果),不再各寫一次 `Number(x) || 0`。
  // 🔴 2026-09-30:欄位被清空、或填了 `abc` / `1e3` 這種解析不出來的字串時,回傳 null ⇒
  // 一律視為「已調整」。舊寫法把這些都算成 0 元,雖然也算已調整,但那是靠 `|| 0` 的巧合,
  // 不是刻意的;現在是明確判斷(而且這種情況送出本來就會被 amountFields.hasError 擋下)。
  //
  // 「基準值」依模式不同(2026-09-29 第三輪使用者裁決修正,推翻第一版「一律比對現價」的做法):
  //   ・新增預約:基準 = service_items.price 當下的值(維持第一版行為)。
  //   ・編輯既有訂單:基準 = 開啟這張訂單時載入進來的 unit_price_snapshot(loadedUnitPriceSnapshots)。
  //     使用者原話:「歷史訂單就留當時的快照,不要因為未來的價格調整去有所改變。」第一版拿快照去比
  //     現價,商家事後調漲定價後,打開任何一張舊訂單都會被誤判成「已手動調整」、自訂總金額被鎖住
  //     ——使用者明確不接受。所以編輯模式只有「這次編輯過程中真的動了單價」才算已調整;一打開還沒動
  //     任何東西時,不管快照跟現價差多少,都不能被判成已調整。⚠️ 不要再改回比對現價。
  //     - 快照裡有的項目(含已下架、不在 serviceItems 清單裡的):一律用快照比,名稱也從快照取,
  //       不因為項目下架就跳過判定(否則改了下架項目的單價卻不會被鎖住,是漏洞)。
  //     - 這次編輯才「新勾選」、快照裡沒有的項目:沒有快照可比,退回比對 service_items.price;
  //       取消勾選再重新勾選的項目也算這一類(toggleServiceItem 會把它的快照基準拿掉,重新勾選時
  //       單價會被填回現價,跟新勾選一樣)。
  //   ・兩種模式共通:不在快照裡、也不在 serviceItems 清單裡的項目沒有任何基準可比,不列入判定。
  const adjustedUnitPriceItemNames = useMemo(() => {
    return serviceItemIds.flatMap((id) => {
      const snapshot = isEdit ? loadedUnitPriceSnapshots[id] : undefined;
      const item = (serviceItems ?? []).find((s) => s.id === id);
      const baseline: { price: number; name: string } | undefined =
        snapshot ?? (item ? { price: Number(item.price), name: item.name } : undefined);
      if (!baseline) return [];
      const enteredPrice = resolveEnteredUnitPrice(amountFields, id, baseline.price);
      return enteredPrice === baseline.price ? [] : [baseline.name];
    });
  }, [serviceItemIds, serviceItems, amountFields, isEdit, loadedUnitPriceSnapshots]);
  const hasAdjustedUnitPrice = adjustedUnitPriceItemNames.length > 0;
  // #829 裁決:「不自動把已經開啟的開關關掉」。所以 disabled 只擋「從關 → 開」這個方向;如果客服
  // 先開了自訂總金額、之後才去改單價,開關維持開啟、仍然可以自己關掉(不然會卡死在開啟狀態,
  // 除非把單價改回去),只在旁邊顯示警示說明目前以總金額為準、關掉之後就不能再開。
  const customTotalAmountLocked = hasAdjustedUnitPrice && !customTotalAmountEnabled;

  // §4.8 金額即時預覽:跟後端 private.calculate_booking_amount 相同公式,體驗層預覽,
  // 真正落地金額由後端重算(規則 2.2)。
  // 🔴 2026-09-30:三個值原本是 `x.trim() ? Number(x) : null`,現在一律取 amountFields 解析好的值
  // (跟 handleSubmit 送出的完全同一份),所以不可能再把 NaN / Infinity 餵進計算公式。
  // 有任何一格解析失敗時,直接回一個帶錯誤訊息的結果——不要拿「把壞值當 0」算出來的假金額給人看,
  // 那正是「折扣填 abc → 最終金額 NaN 卻沒人提醒」的翻版。
  const amountPreview = useMemo(
    () =>
      amountFields.hasError
        ? {
            // NaN ⇒ formatAmount 顯示「—」。刻意不顯示 $0:0 元是一個看起來合理的金額,
            // 使用者可能以為那就是答案;「—」+ 下面的紅字才講得清楚「現在算不出來」。
            subtotalAmount: Number.NaN,
            discountAmount: Number.NaN,
            taxAmount: Number.NaN,
            finalAmount: Number.NaN,
            error: "有金額欄位填錯了(上面標紅的那幾格),修好之後才算得出金額。",
          }
        : calculateBookingAmountPreview({
            itemsSubtotal,
            customTotalAmountEnabled,
            customTotalAmount: amountFields.customTotalAmount.value,
            discountEnabled,
            discountMode,
            discountValue: amountFields.discountValue.value,
            taxEnabled,
            taxMode,
            taxValue: amountFields.taxValue.value,
          }),
    [
      amountFields,
      itemsSubtotal,
      customTotalAmountEnabled,
      discountEnabled,
      discountMode,
      taxEnabled,
      taxMode,
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
    // #829 使用者裁決修正:編輯模式下取消勾選一個項目,同時把它的快照基準拿掉——之後若再重新勾選,
    // 單價會被填回 service_items.price 現價,此時應該跟「新勾選」一樣拿現價當基準,不能還拿舊快照
    // 來比(否則重新勾選後畫面顯示的就是預設值,卻被判成「已調整」,提示叫人「改回預設值」會無所適從)。
    setLoadedUnitPriceSnapshots((prev) => {
      if (!(itemId in prev)) return prev;
      const next = { ...prev };
      delete next[itemId];
      return next;
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
    // SPECS-INDEX #822(2026-09-27 使用者裁決):客戶電話格式驗證,手機或市話皆可、市話可帶 # 分機、
    // 分隔符號不強制。規則本體與「為什麼不列舉區碼」見 src/lib/validation.ts 的 isValidTaiwanPhone。
    // 這裡是體驗層先擋一次,真正的邊界在後端 create_booking/update_booking 的
    // private.is_valid_taiwan_phone(同一條規則);資料庫 CHECK 約束因舊髒資料還沒清(#638)暫時補不上。
    // 註:仍然刻意**不**用服務人員/客服那套 isValidTaiwanMobilePhone(只收手機),客戶可能留市話。
    if (!isValidTaiwanPhone(customerPhone)) {
      toast.error(TW_PHONE_ERROR_MESSAGE);
      return;
    }
    // 2026-09-24 稽核修正(問題 2):客戶 Email 格式驗證。
    // 欄位雖然寫了 type="email",但送出鈕是 type="button" + onClick、外面也沒有 <form>,
    // 所以瀏覽器的原生格式驗證從來不會觸發,客服隨手打 abc 就會直接存進資料庫。
    // **空白要放行**——這是選填欄位,不填是正常情況,只有「填了但格式不對」才擋。
    if (customerEmail.trim() && !isValidEmail(customerEmail)) {
      toast.error(EMAIL_ERROR_MESSAGE);
      return;
    }
    if (requiresCustomerAddress && !customerAddress.trim()) {
      toast.error("請填寫客戶地址");
      return;
    }
    // SPECS-INDEX #604:付款方式改為必填。新建訂單一律擋下未選擇;編輯既有訂單只在「維持原值」
    // (原本就沒有值)時放行,主動把有值改成沒有值一樣擋下。體驗層先擋一次,真正的邊界仍在後端
    // private.validate_booking_selection(見規格書 §3.1.1)。
    if (paymentMethodValue === PAYMENT_METHOD_UNSET) {
      const isMaintainingOriginalNullValue = isEdit && !editingDetail?.payment_method_id;
      if (!isMaintainingOriginalNullValue) {
        toast.error("請選擇付款方式");
        return;
      }
    }
    // 🔴 2026-09-30:四個金額欄位任何一格解析不出數字就擋在這裡。按鈕本身也已經 disabled
    // (見底部 ActionBar),這一道是防呆:欄位錯誤絕對不可以只顯示紅字就讓人送出去。
    if (amountFields.hasError) {
      toast.error("金額欄位有填錯的地方", {
        description: "請看金額區塊裡標紅的欄位,只能填數字和小數點。",
      });
      return;
    }
    if (amountPreview.error) {
      // §4.8:金額預覽算出來的錯誤(例如折扣超過小計),體驗層先擋一次,避免明知道會被後端
      // 擋下還讓客服白跑一趟(真正的邊界仍在後端 create_booking/update_booking)。
      toast.error(amountPreview.error);
      return;
    }
    if (
      customDurationEnabled &&
      (!customDurationMinutes.trim() || Number(customDurationMinutes) <= 0)
    ) {
      // §4.3 邊界情況:開啟自訂工時但沒有填(或填了 <=0)的總服務時長,體驗層先擋一次,
      // 真正的邊界仍在後端 private.validate_booking_selection。
      toast.error("已開啟自訂工時,請輸入大於 0 的總服務時長(分鐘)");
      return;
    }

    setSaving(true);
    try {
      const shared = {
        staffId,
        serviceItems: serviceItemIds.map<BookingServiceItemSelectionInput>((id) => ({
          serviceItemId: id,
          // 2026-09-24 稽核修正(問題 1):跟畫面上的工時加總/金額預覽走同一支解析函式,
          // 確保「畫面顯示的數量」跟「真正送出的數量」永遠是同一個數字。
          quantity: parseItemQuantity(itemQuantities[id]),
          // 🔴 2026-09-30:跟畫面上的 itemsSubtotal 走同一支 resolveUnitPrice(同一份解析結果),
          // 不再各寫一次 `Number(x ?? "0") || 0`。
          unitPrice: resolveUnitPrice(amountFields, id),
        })),
        startAt: buildTaipeiIso(dateKey, time),
        customerName,
        customerPhone,
        customerEmail: customerEmail.trim() ? customerEmail.trim() : null,
        customerAddress: customerAddress.trim() ? customerAddress.trim() : null,
        notes: notes.trim() ? notes.trim() : null,
        customerNotes: customerNotes.trim() ? customerNotes.trim() : null,
        // 🔴 SPECS-INDEX #857:無條件帶值(不是 `hideNotesFromStaff ? … : undefined`)。
        // 編輯模式下這個值是開啟表單時從 editingDetail 帶進來的現值,所以「使用者沒碰開關」
        // 送出的就是原值,不會把藏起來的備註靜默公開。有 Vitest 測試鎖住這條(#857)。
        hideNotesFromStaff,
        memberId: member?.id ?? null,
        assistantStaffIds,
        materialCostItemIds,
        customTotalAmountEnabled,
        // 🔴 2026-09-30:這三個值原本是 `enabled && x.trim() ? Number(x) : null`,現在一律取
        // amountFields 解析好的值——跟上面金額預覽用的是同一份結果,所以「畫面上看到的金額」
        // 跟「真正送出去的金額」不可能再對不起來(開關關閉時 amountFields 本來就回 null)。
        customTotalAmount: amountFields.customTotalAmount.value,
        discountEnabled,
        discountMode: discountEnabled ? discountMode : null,
        discountValue: amountFields.discountValue.value,
        taxEnabled,
        taxMode: taxEnabled ? taxMode : null,
        taxValue: amountFields.taxValue.value,
        paymentMethodId: paymentMethodValue === PAYMENT_METHOD_UNSET ? null : paymentMethodValue,
        // §4.3 邊界情況:關閉時 customDurationMinutes 一律傳 null,避免留著舊值造成混淆
        // (後端 create_booking/update_booking 也會在關閉時一律存 null,這裡是雙重保險)。
        customDurationEnabled,
        customDurationMinutes:
          customDurationEnabled && customDurationMinutes.trim()
            ? Number(customDurationMinutes)
            : null,
      };

      if (isEdit && editingBookingId) {
        // 模組 15(服務人員推播通知)規則 4.5:送出前比較「原始訂單資料」(editingDetail,查詢
        // 當下的既有值)跟「這次要送出的新值」(shared),算出一句話摘要,RPC 成功後由
        // updateBooking 內部疊加呼叫 dispatchPushNotification 用。
        const changeSummary = editingDetail
          ? computeBookingChangeSummary({
              original: {
                startAt: editingDetail.start_at,
                serviceItemIds: editingDetail.serviceItems.map((item) => item.id),
                staffId: editingDetail.staff_id,
              },
              next: {
                startAt: shared.startAt,
                serviceItemIds,
                staffId,
                staffName: staffList?.find((s) => s.id === staffId)?.name ?? null,
                formattedStartAt: `${dateKey} ${time}`,
                serviceNames: serviceItemIds
                  .map((id) => serviceItems?.find((si) => si.id === id)?.name)
                  .filter((name): name is string => Boolean(name)),
              },
            })
          : undefined;
        await updateBooking({
          bookingId: editingBookingId,
          ...shared,
          ...(changeSummary ? { changeSummary } : {}),
        });
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

  // skill 二之九:選中的服務項目展開成卡片(永遠顯示,不受分類篩選影響),沒選的縮成小方塊排在下面
  // (受分類篩選影響)。已勾選但目前不在上架清單裡的項目(編輯舊訂單時遇到已下架項目)維持改版前的
  // 行為:表單上看不到、但送出時仍原封不動帶回去。
  const selectedServiceItems = serviceItemIds.flatMap((id) => {
    const item = (serviceItems ?? []).find((s) => s.id === id);
    return item ? [item] : [];
  });
  const filteredServiceItems = filterServiceItemsByCategory(serviceItems ?? [], categoryFilter);
  const unselectedServiceItems = filteredServiceItems.filter(
    (item) => !serviceItemIds.includes(item.id),
  );

  // ui-v1-full:外殼從 Sheet(底部 92vh)換成全頁層(skill 三):手機滿版、電腦置中面板,標題列與
  // 底部按鈕列固定、只有中間會捲動;「取消 / 建立預約(儲存變更)」兩顆等寬(skill 二之三)。
  return (
    <FullPageLayer open={open} onOpenChange={onOpenChange}>
      <FullPageLayerContent
        title={isEdit ? "編輯預約" : "新增預約"}
        subtitle={!isEdit ? "建立後狀態是「待確認」,需要再次確認才會正式成立。" : undefined}
        footer={
          /* 🔴 2026-09-30:金額欄位有填錯時「送出按鈕要擋住」,不能只在欄位下面顯示紅字。
             按鈕變灰就一定要說明原因(skill 二之三:不能按的按鈕旁邊一定要有 `!` 說明),
             所以這裡在按鈕列上方放常駐的 AlertNote,不是收進 `?`。 */
          <div className="flex flex-col gap-2.5">
            {amountFields.hasError ? (
              <AlertNote>
                金額欄位有填錯的地方(上面標紅的那幾格),修好之後才能送出。金額只能填數字和小數點。
              </AlertNote>
            ) : null}
            <ActionBar>
              <FullPageLayerClose asChild>
                <Button type="button" variant="neutral" size="touch">
                  取消
                </Button>
              </FullPageLayerClose>
              <Button
                type="button"
                variant="primary"
                size="touch"
                disabled={saving || amountFields.hasError}
                onClick={handleSubmit}
              >
                {saving ? "儲存中⋯" : isEdit ? "儲存變更" : "建立預約"}
              </Button>
            </ActionBar>
          </div>
        }
      >
        {/* min-w-0:內容區是 flex 容器的子項,預設 min-width:auto 會被裡面過長的文字(例如服務人員
            下拉選單目前選中的長姓名)撐寬,進而撐寬整個面板超出手機螢幕。 */}
        <div className="flex min-w-0 flex-col gap-7">
          {/* ───────── 客戶 ───────── */}
          <DetailSection label="客戶" className="gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="客戶姓名" htmlFor="booking-customer-name" required>
                <FieldInput
                  id="booking-customer-name"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                />
              </FormField>
              <FormField label="客戶電話" htmlFor="booking-customer-phone" required>
                <FieldInput
                  id="booking-customer-phone"
                  type="tel"
                  inputMode="tel"
                  className="tabular-nums"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                />
              </FormField>
            </div>
            {/* SPECS-INDEX #614(會員與紅利.md §10.2,取代舊版 §4.4 獨立的「會員(選填)」欄位):
                電話當查詢索引,不當唯一鍵。輸入客戶電話後,這裡列出這支電話底下這個商家既有的所有
                客戶,可以連結既有客戶或視為新客戶,歸在既有的 orders 權限底下(規則 2.10),不選
                就是訪客訂單,對既有建單流程完全沒有強制性影響。 */}
            <MemberPhoneMatchPanel
              merchantId={merchantId}
              phone={customerPhone}
              customerName={customerName}
              selectedMember={member}
              onSelectMember={setMember}
            />
            <FormField label="客戶 Email" htmlFor="booking-customer-email">
              <FieldInput
                id="booking-customer-email"
                type="email"
                inputMode="email"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
              />
            </FormField>
            {/* 建單表單細節修正第二節:只有 industry_type 需要地址的產業(見
                INDUSTRY_REQUIRES_CUSTOMER_ADDRESS)才顯示這個欄位並標記必填,不需要地址的產業
                整個欄位不顯示。真正擋住不合法的空地址還是 create_booking/update_booking 資料庫層。 */}
            {requiresCustomerAddress ? (
              <FormField label="客戶地址" htmlFor="booking-customer-address" required>
                <FieldInput
                  id="booking-customer-address"
                  value={customerAddress}
                  onChange={(e) => setCustomerAddress(e.target.value)}
                />
              </FormField>
            ) : null}
          </DetailSection>

          {/* ───────── 人員 ───────── */}
          <DetailSection label="人員" className="gap-4">
            <FormField label="服務人員" htmlFor="booking-staff" required>
              {/* 2026-09-24 稽核修正(問題 3):這個欄位是最容易踩到「幽靈空值事件」的地方——
                  在行事曆點某位服務人員的空格建單時,prefill.staffId 是在掛載當下的 useEffect
                  才灌進 staffId 的,那一刻隱藏原生 select 的選項可能還沒註冊完,會補發一次
                  空字串把剛選好的服務人員洗掉,客服按送出才被擋下卻不知道哪裡沒選。
                  合法值是資料庫來的動態清單(服務人員 id),所以判斷條件是「不是空字串」。 */}
              <FieldSelect
                id="booking-staff"
                value={staffId}
                onValueChange={guardPhantomEmptyChange((v) => {
                  setStaffId(v);
                  setAssistantStaffIds((prev) => prev.filter((id) => id !== v));
                })}
                placeholder="請選擇"
                options={(staffList ?? []).map((s) => ({ value: s.id, label: s.name }))}
              />
            </FormField>

            {/* 建單功能擴充 2.2/5.1 第 2 點,建單表單細節修正第四節:助手欄位排除已選為主要服務人員
                的那一位,可留空;未選定主要服務人員前整個區塊停用(方塊 disabled + `!` 說明原因),
                因為助手是依附在「這次由誰負責」之下的角色,順序上要先決定主要服務人員。
                skill 二之七:多選用可點的方塊(ChoiceChip),不用打勾方框。 */}
            <FormField label="助手(可留空,可多選)">
              <div className="flex flex-col gap-2.5">
                {!staffId ? <AlertNote>請先選擇服務人員,才能指派助手。</AlertNote> : null}
                {assistantCandidates.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">沒有其他可指派的服務人員。</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {assistantCandidates.map((s) => (
                      <ChoiceChip
                        key={s.id}
                        selected={assistantStaffIds.includes(s.id)}
                        disabled={!staffId}
                        onClick={() => setAssistantStaffIds((prev) => toggleInArray(prev, s.id))}
                      >
                        {s.name}
                      </ChoiceChip>
                    ))}
                  </div>
                )}
              </div>
            </FormField>
          </DetailSection>

          {/* ───────── 時間 ───────── */}
          <DetailSection label="時間" className="gap-4">
            <FormField label="預約日期時間" htmlFor="booking-datetime" required>
              <BookingDateTimeField
                id="booking-datetime"
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
            </FormField>

            {/* 模組 6(訂單管理)§4.3(裁決 Q3 方向一):自訂工時開關。關閉時沿用服務項目逐項加總的工時
                計算 end_at;開啟後改用這裡輸入的總服務時長,會真的影響排程佔用與衝突檢查邊界
                (含單日例外第三層),不是只影響畫面顯示。 */}
            <SwitchRow
              title="自訂工時"
              description="開啟後用輸入的總服務時長取代逐項加總,實際佔用的時段跟衝突檢查都會依這個值計算。"
              checked={customDurationEnabled}
              onCheckedChange={setCustomDurationEnabled}
            >
              {customDurationEnabled ? (
                <FormField label="總服務時長(分鐘)" htmlFor="booking-custom-duration" required>
                  <FieldInput
                    id="booking-custom-duration"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    className="tabular-nums"
                    placeholder="輸入這筆訂單的總服務時長(分鐘)"
                    value={customDurationMinutes}
                    onChange={(e) => setCustomDurationMinutes(e.target.value)}
                  />
                </FormField>
              ) : null}
            </SwitchRow>
          </DetailSection>

          {/* ───────── 服務項目 ───────── */}
          {/* 建單功能擴充 2.1/5.1 第 1 點,模組 6 §4.1/4.2:服務項目改多選,每項可調整數量
              (預設 1,最小 1,整數)跟單價(預設帶入 service_items.price,可手動修改),
              即時顯示工時加總(§2.2:duration_minutes × quantity)。 */}
          <DetailSection label="服務項目" className="gap-4">
            <FormField
              label="服務項目(可多選)"
              required
              helpLabel="說明:服務項目怎麼選"
              help="點下方的方塊加入項目,加入後會展開成一張卡,可以調整數量與單價;按卡片上的「移除」取消。"
            >
              <div className="flex flex-col gap-3">
                {/* 已選的項目:一張卡(定價 + 數量 + 單價)。 */}
                {selectedServiceItems.length > 0 ? (
                  <ul className="flex flex-col gap-2.5">
                    {selectedServiceItems.map((item) => (
                      <li
                        key={item.id}
                        className="flex flex-col gap-3 rounded-lg border border-brand/40 bg-brand-soft/30 p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="break-words text-sm font-semibold text-foreground">
                              {item.name}
                            </p>
                            <p className="text-xs tabular-nums text-muted-foreground">
                              定價 {formatAmount(Number(item.price))}・{item.duration_minutes} 分鐘
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="text"
                            size="card"
                            className="-mr-2 -mt-1 shrink-0"
                            onClick={() => toggleServiceItem(item.id, Number(item.price))}
                          >
                            移除
                          </Button>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <FormField label="數量" htmlFor={`booking-item-qty-${item.id}`}>
                            <FieldInput
                              id={`booking-item-qty-${item.id}`}
                              type="number"
                              inputMode="numeric"
                              min={1}
                              step={1}
                              className="tabular-nums"
                              value={itemQuantities[item.id] ?? "1"}
                              onChange={(e) =>
                                setItemQuantities((prev) => ({
                                  ...prev,
                                  [item.id]: e.target.value,
                                }))
                              }
                              // 2026-09-24 稽核修正(問題 1)配套:離開欄位時如果還是空的,
                              // 自動填回 "1",讓畫面不會停在「空白格子」這種容易誤會的狀態
                              // (送出時的 parseItemQuantity 本來就會當成 1,這裡只是讓畫面
                              // 跟實際送出的值一眼看起來就一致)。輸入過程中不干擾,只在離開時補。
                              onBlur={(e) => {
                                if (e.target.value.trim() !== "") return;
                                setItemQuantities((prev) => ({ ...prev, [item.id]: "1" }));
                              }}
                            />
                          </FormField>
                          {/* 🔴 2026-09-30:單價是 FieldAmountInput(type="text"),沒有原生
                              min / step,所以錯誤一律靠 parseAmountInput + FormField error=
                              (skill 二之七:框變紅 + 下面一行 `!` 說明,不可以只把框變紅)。
                              錯誤訊息是從目前輸入內容即時算出來的,改成正確的數字就會自己消失。 */}
                          <FormField
                            label="單價"
                            htmlFor={`booking-item-price-${item.id}`}
                            error={amountFields.unitPriceErrors[item.id] ?? null}
                          >
                            <FieldAmountInput
                              id={`booking-item-price-${item.id}`}
                              value={itemUnitPrices[item.id] ?? String(item.price)}
                              onChange={(e) =>
                                setItemUnitPrices((prev) => ({
                                  ...prev,
                                  [item.id]: e.target.value,
                                }))
                              }
                            />
                          </FormField>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {/* SPECS-INDEX #598(訂單管理.md §9.2):分類篩選下拉選單,「全部」為預設值(等同既有
                    行為)。只影響下面沒選的方塊顯示哪些,不影響已經選的項目(切換篩選不會弄丟
                    已選的項目,見 handleSubmit 附近的 serviceItemIds 獨立狀態)。商家沒有使用分類
                    功能時,不顯示這個下拉,不影響既有操作流程。 */}
                {(serviceCategories ?? []).length > 0 ? (
                  /* 2026-09-24 稽核修正(問題 3):合法值是 "all"/"uncategorized" 兩個 sentinel
                     加上資料庫來的動態分類 id,沒有固定白名單可以比對,判斷條件是「不是空字串」。
                     (categoryFilter 會在每次開啟表單的 useEffect 裡被重設,一樣有時序風險。) */
                  <FieldSelect
                    aria-label="服務項目分類篩選"
                    value={categoryFilter}
                    onValueChange={guardPhantomEmptyChange<ServiceItemCategoryFilter>(
                      setCategoryFilter,
                    )}
                    options={[
                      { value: "all", label: "全部分類" },
                      { value: "uncategorized", label: UNCATEGORIZED_LABEL },
                      ...(serviceCategories ?? []).map((category) => ({
                        value: category.id,
                        label: category.name,
                      })),
                    ]}
                  />
                ) : null}

                {/* 沒選的項目:縮成可點的小方塊(skill 二之九),商家有 30 個項目時畫面也不會爆掉。 */}
                {(serviceItems ?? []).length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">目前沒有上架中的服務項目。</p>
                ) : filteredServiceItems.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">這個分類目前沒有服務項目。</p>
                ) : unselectedServiceItems.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">這個分類的項目都已加入。</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {unselectedServiceItems.map((item) => (
                      <ChoiceChip
                        key={item.id}
                        selected={false}
                        onClick={() => toggleServiceItem(item.id, Number(item.price))}
                      >
                        <span className="break-words text-left">
                          {item.name}
                          <span className="ml-1 tabular-nums text-muted-foreground">
                            {formatAmount(Number(item.price))}
                          </span>
                        </span>
                      </ChoiceChip>
                    ))}
                  </div>
                )}

                <p className="text-xs tabular-nums text-muted-foreground">
                  已選 {serviceItemIds.length} 項,逐項加總工時 {itemsTotalDurationMinutes} 分鐘
                  {customDurationEnabled ? "(已套用自訂工時,實際採用上方輸入的總服務時長)" : ""}。
                </p>
              </div>
            </FormField>
          </DetailSection>

          {/* ───────── 金額 ───────── */}
          {/* 模組 6(訂單管理)§4.4~4.8:金額彈性三個開關(自訂總金額/折扣/稅金)+ 付款方式 +
              即時金額預覽。skill 二之九:金額整組用色塊包起來,三個開關 + 付款方式都在裡面。 */}
          <DetailSection label="金額" tone="amount" className="gap-3">
            <SwitchRow
              title="自訂總金額"
              description="開啟後用輸入的總金額取代逐項小計。"
              checked={customTotalAmountEnabled}
              disabled={customTotalAmountLocked}
              onCheckedChange={setCustomTotalAmountEnabled}
              className="bg-background"
            >
              {/* SPECS-INDEX #829:兩種狀態的 `!` 常駐說明(skill 二:「為什麼這顆按鈕按不了」絕對不能
                  收進 `?`)——(a) 已改單價且目前關閉:開關變灰,寫清楚原因跟怎麼解;(b) 已改單價但開關
                  本來就開著:不偷關,寫清楚目前以哪個為準。 */}
              {customTotalAmountLocked || hasAdjustedUnitPrice || customTotalAmountEnabled ? (
                <div className="flex flex-col gap-2.5">
                  {customTotalAmountLocked ? (
                    <AlertNote>
                      {`已手動調整「${adjustedUnitPriceItemNames.join("、")}」的單價,無法再套用自訂總金額。要改用自訂總金額,請先把單價改回預設值。`}
                    </AlertNote>
                  ) : hasAdjustedUnitPrice ? (
                    <AlertNote>
                      {`已手動調整「${adjustedUnitPriceItemNames.join("、")}」的單價,但自訂總金額仍在開啟中,金額會以下方輸入的總金額為準;關閉後,在單價改回預設值之前無法再開啟。`}
                    </AlertNote>
                  ) : null}
                  {customTotalAmountEnabled ? (
                    <FormField
                      label="總金額"
                      htmlFor="booking-custom-total"
                      required
                      error={amountFields.customTotalAmount.error}
                      helpLabel="說明:總金額要怎麼填"
                      help="只能填數字和小數點,例如 1200 或 1200.5。不接受 1e3、0x10 這種寫法,也不能填文字。"
                    >
                      <FieldAmountInput
                        id="booking-custom-total"
                        placeholder="輸入這筆訂單的總金額"
                        value={customTotalAmount}
                        onChange={(e) => setCustomTotalAmount(e.target.value)}
                      />
                    </FormField>
                  ) : null}
                </div>
              ) : null}
            </SwitchRow>

            <SwitchRow
              title="折扣優惠"
              description="固定金額或百分比二選一。"
              checked={discountEnabled}
              onCheckedChange={setDiscountEnabled}
              className="bg-background"
            >
              {discountEnabled ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField label="折扣方式">
                    {/* 2026-09-24 稽核修正(問題 3)當時是 Select + 白名單 guard;現在改 ChoiceChipGroup
                        (只有真的點擊 / 鍵盤切換才會觸發),沒有幽靈空值事件,不再需要 guard。 */}
                    <ChoiceChipGroup
                      aria-label="折扣方式"
                      value={discountMode}
                      onValueChange={setDiscountMode}
                      options={AMOUNT_ADJUSTMENT_MODE_OPTIONS}
                    />
                  </FormField>
                  {/* 🔴 2026-09-30:兩種模式都掛 error。固定金額模式是 FieldAmountInput
                      (type="text",沒有原生約束);百分比模式雖然是 type="number" + min/max,
                      但這張表單的送出鈕是 type="button" 且外面沒有 <form>,瀏覽器的原生驗證
                      從來不會觸發(見 handleSubmit 裡 Email 驗證那段註解),而 type="number"
                      依 HTML 規格本來就吃 `1e3` —— 所以兩種模式一律靠 parseAmountInput 擋。 */}
                  <FormField
                    label={discountMode === "percentage" ? "折扣比例(%)" : "折扣金額"}
                    htmlFor="booking-discount-value"
                    error={amountFields.discountValue.error}
                  >
                    {discountMode === "percentage" ? (
                      <FieldInput
                        id="booking-discount-value"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        max={100}
                        step="0.01"
                        className="tabular-nums"
                        placeholder="0~100 的數字"
                        value={discountValue}
                        onChange={(e) => setDiscountValue(e.target.value)}
                      />
                    ) : (
                      <FieldAmountInput
                        id="booking-discount-value"
                        placeholder="折扣金額"
                        value={discountValue}
                        onChange={(e) => setDiscountValue(e.target.value)}
                      />
                    )}
                  </FormField>
                </div>
              ) : null}
            </SwitchRow>

            <SwitchRow
              title="稅金"
              // 建單與訂單管理介面優化 §2:文字依商家目前稅金模式(比例/固定金額)切換,
              // 不能寫死成只有百分比的版本;純顯示文字調整,tax_mode 判斷邏輯不變。
              description={getTaxModeHelperText(taxMode)}
              checked={taxEnabled}
              onCheckedChange={setTaxEnabled}
              className="bg-background"
            >
              {/* 🔴 2026-09-30:稅額 / 稅率兩種模式都掛 error,理由同上面折扣欄位的註解。 */}
              {taxEnabled ? (
                <FormField
                  label={taxMode === "percentage" ? "稅率(%)" : "稅額"}
                  htmlFor="booking-tax-value"
                  error={amountFields.taxValue.error}
                >
                  {taxMode === "percentage" ? (
                    /* §2 第 1 點:比例模式時在輸入框旁明確標示「%」,避免使用者誤以為是輸入金額。 */
                    <div className="relative">
                      <FieldInput
                        id="booking-tax-value"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        max={100}
                        step="0.01"
                        className="pr-8 tabular-nums"
                        placeholder="稅率(0~100 的數字)"
                        value={taxValue}
                        onChange={(e) => setTaxValue(e.target.value)}
                      />
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[15px] text-muted-foreground"
                      >
                        %
                      </span>
                    </div>
                  ) : (
                    <FieldAmountInput
                      id="booking-tax-value"
                      placeholder="稅額"
                      value={taxValue}
                      onChange={(e) => setTaxValue(e.target.value)}
                    />
                  )}
                </FormField>
              ) : null}
            </SwitchRow>

            {/* 建單與訂單管理介面優化 §3/模組 9(支付方式)v2 §5.2/SPECS-INDEX #604(付款方式改為
                必填):選項是商家自訂清單裡目前上架中的項目(paymentMethodOptions,含編輯模式下維持原值
                即使已下架的附加項)。#604:新建模式下不再提供「(未選擇/尚未設定)」這個選項(拿掉
                之後客服在新建流程一定會選到一個實際的付款方式);編輯模式維持顯示這個選項——
                對應後端「維持原值放行,只有主動改成空值才擋」的規則,選了它會在送出時被擋下
                (見 handleSubmit 的驗證),不是完全禁止選取。
                skill 二之七:付款方式是單選 ⇒ ChoiceChipGroup;不是 Radix Select,沒有幽靈空值事件。 */}
            <FormField label="付款方式" required>
              <ChoiceChipGroup
                aria-label="付款方式"
                value={paymentMethodValue}
                onValueChange={setPaymentMethodValue}
                options={[
                  ...(isEdit ? [{ value: PAYMENT_METHOD_UNSET, label: "(未選擇/尚未設定)" }] : []),
                  ...paymentMethodOptions.map((option) => ({
                    value: option.id,
                    label: option.name,
                  })),
                ]}
              />
            </FormField>

            {/* §4.8 金額即時預覽,體驗層,真正落地金額由後端重算(規則 2.2)。
                skill 二之六 明細列:標籤淡、值粗、最終金額 26px、tabular-nums。 */}
            <div className="flex flex-col gap-1.5 rounded-md bg-background/80 px-3.5 py-3">
              <DetailRow label="小計" size="sm">
                {formatAmount(amountPreview.subtotalAmount)}
              </DetailRow>
              {discountEnabled ? (
                <DetailRow label="折扣" size="sm">
                  -{formatAmount(amountPreview.discountAmount)}
                </DetailRow>
              ) : null}
              {taxEnabled ? (
                <DetailRow label="稅金" size="sm">
                  +{formatAmount(amountPreview.taxAmount)}
                </DetailRow>
              ) : null}
              <DetailDivider className="my-1 bg-brand/20" />
              <DetailRow label="最終金額" size="xl">
                {formatAmount(amountPreview.finalAmount)}
              </DetailRow>
            </div>
            {amountPreview.error ? <AlertNote>{amountPreview.error}</AlertNote> : null}
          </DetailSection>

          {/* ───────── 料錢成本 ───────── */}
          {/* 建單功能擴充 2.3/5.1 第 3 點:料錢成本區塊,只有商家開啟功能時才顯示。 */}
          {materialCostEnabled ? (
            <DetailSection label="料錢成本" className="gap-4">
              <FormField
                label="料錢成本(可留空,可多選)"
                helpLabel="說明:料錢成本是什麼"
                help="記錄這次服務預期會用掉的材料成本,僅供操作者參考與之後算抽成基準用,不代表訂單金額。"
              >
                <div className="flex flex-col gap-2.5">
                  {(materialCostItems ?? []).length === 0 ? (
                    <p className="text-[13px] text-muted-foreground">
                      目前沒有上架中的料錢成本品項。
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {(materialCostItems ?? []).map((item) => (
                        <ChoiceChip
                          key={item.id}
                          selected={materialCostItemIds.includes(item.id)}
                          onClick={() =>
                            setMaterialCostItemIds((prev) => toggleInArray(prev, item.id))
                          }
                        >
                          <span className="break-words text-left">
                            {item.name}
                            <span className="ml-1 tabular-nums text-muted-foreground">
                              ${Number(item.amount).toFixed(0)}
                            </span>
                          </span>
                        </ChoiceChip>
                      ))}
                    </div>
                  )}
                  {materialCostItemIds.length > 0 ? (
                    <p className="text-xs tabular-nums text-muted-foreground">
                      已選 {materialCostItemIds.length} 項,金額加總 ${materialCostTotal.toFixed(0)}
                      (僅供操作者參考,不代表訂單金額)。
                    </p>
                  ) : null}
                </div>
              </FormField>
            </DetailSection>
          ) : null}

          {/* ───────── 備註 ───────── */}
          {/* 預約詳情資訊擴充與建單備註分類第一節:備註分成「內部備註」(既有 notes 欄位,
              商家內部看、客戶看不到,欄位本身不改名)跟「客戶備註」(customer_notes,客戶看得到),
              兩個欄位並排顯示。建單與訂單管理介面優化 §4:兩個備註欄位的高度都是 5 列。
              skill 二之六:誰看得到要寫清楚 —— **預設**服務人員看得到內部備註
              (2026-09-29 使用者確認),客服可以用下面那個開關逐單關閉(SPECS-INDEX #853)。 */}
          <DetailSection label="備註" className="gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                label={
                  <>
                    內部備註{" "}
                    {/* SPECS-INDEX #859:這裡刻意只寫「客戶看不到」。「服務人員看不看得到」交給
                        下面那個開關自己的說明文字去講 —— 旁邊就有一個可以改變這件事的開關,
                        這裡再寫死「服務人員看得到」會變成同一個畫面上兩句話互相矛盾。 */}
                    <span className="font-normal text-muted-foreground">(客戶看不到)</span>
                  </>
                }
                htmlFor="booking-notes"
              >
                <FieldTextarea
                  id="booking-notes"
                  rows={5}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </FormField>
              <FormField
                label={
                  <>
                    客戶備註 <span className="font-normal text-muted-foreground">(客戶看得到)</span>
                  </>
                }
                htmlFor="booking-customer-notes"
              >
                <FieldTextarea
                  id="booking-customer-notes"
                  rows={5}
                  value={customerNotes}
                  onChange={(e) => setCustomerNotes(e.target.value)}
                />
              </FormField>
            </div>

            {/* SPECS-INDEX #853(2026-09-30 使用者需求):逐單關閉「服務人員看得到內部備註」。
                🔴 用 SwitchRow 不是打勾方框 —— skill 二之七 同時寫了「開關做成一整列」與
                   「不用打勾方框(手機好按)」,而且這顆表單的自訂總金額/折扣/稅金三個設定都是
                   SwitchRow,一致性最好。使用者原話說的「勾選」是在描述行為,不是在指定元件
                   (主腦裁決 T3)。
                🔴 位置在兩欄格線的**下方、整條寬**,不是塞進左邊那半欄(主腦裁決 T6)——
                   SwitchRow 本身就是一個有邊框的整列元件,塞進半寬欄位裡手機上標題會被擠到換行、
                   開關被推到很窄的地方;放在下面整條寬,視覺上也很清楚它是「備註這一組」的設定。
                🔴 說明文字一定要講「只影響這一筆」—— 使用者的需求原話是「當次如果勾選」,
                   這是逐單設定不是全店設定,不講清楚會有客服以為勾一次以後每一單都藏。 */}
            <SwitchRow
              id="booking-hide-notes-from-staff"
              title="不讓服務人員看到這則內部備註"
              description="開啟後,這一筆訂單的內部備註只有商家內部看得到,指派的服務人員在自己的手機上不會看到。只影響這一筆,不影響其他訂單。"
              checked={hideNotesFromStaff}
              onCheckedChange={setHideNotesFromStaff}
            />
          </DetailSection>
        </div>
      </FullPageLayerContent>
    </FullPageLayer>
  );
}

// ---------------------------------------------------------------------------
// 5.2:預約詳情 + 確認/標記完成/編輯/取消操作。這顆彈窗已經抽成獨立檔案
// BookingDetailDialog.tsx(模組 6/訂單管理 §1.1 要求「沿用既有元件,不重做」,讓訂單管理頁
// 也能直接複用同一顆彈窗),這裡只保留 import,不再重複定義。
// ---------------------------------------------------------------------------
// 1.3:排程色塊視覺(bookingBlockClasses)/建單與訂單管理介面優化 §7.5 訂單卡片色條
// (bookingCardAccentBorderClass)這兩支「狀態 -> 樣式」的純函式,搬到 types.ts 統一管理
// (不是 React 元件,放在只有元件的檔案裡會觸發 react-refresh/only-export-components 警告,
// 而且 OrdersPage.tsx 也需要用到,放在 types.ts 讓兩邊都能 import,不用互相依賴對方的內部實作)。

// ---------------------------------------------------------------------------
// SPECS-INDEX #641:服務人員時間軸單一時段格子——手機版橫向滑動誤觸建單/開關時段修復。
//
// 背景:格子本身是 Radix DropdownMenuTrigger(asChild 包一個 <button>),Radix 內建行為是
// 「pointerdown 當下就開啟選單」,這是為了桌面版滑鼠點擊的即時回饋設計的。但在手機上,使用者
// 想要左右滑動瀏覽不同服務人員時,手指一碰到格子就會被 Radix 判定成「按下」而立刻彈出選單,
// 打斷原生的橫向捲動手勢,體驗上就是「滑動誤觸建單/開關時段」。
//
// 修法:把 DropdownMenu 改成受控元件(open/onOpenChange 自己管),攔下 Radix 這次自動開啟的
// 請求,改成自己用 pointerdown/pointermove/pointerup 量測這次的移動距離——超過閾值視為「拖曳
// 滑動」,不開啟選單(交給瀏覽器原生橫向捲動繼續跑,這裡完全不對 pointermove/touchmove 呼叫
// preventDefault,不會擋到原生捲動);沒有超過閾值、放開時才是真正的「點擊」,這時候才真的
// 呼叫 setOpen(true) 開啟選單。
//
// 2026-09-24 使用者回報後擴大適用範圍:原本這套判斷只在 pointerType==="touch" 時生效,滑鼠
// 維持 Radix 原本「按下就開啟」的行為。實際使用後使用者明確要求滑鼠也要一致——「要放掉左鍵
// 才出現,按住則可左右橫移」,所以現在**不分指標裝置**(滑鼠/觸控/觸控筆)一律套用同一套
// 判斷。附帶效果:桌面用滑鼠按住格子左右拖曳時不會再彈出選單,可以直接拖曳瀏覽時間軸。
//
// 邊界情況(拖曳到格子外面才放開):該格子收不到 pointerup,選單不會開啟——這正是想要的行為;
// 而且下一次重新按下時 onPointerDown 會重設狀態、放開時 onPointerUp 會直接 setOpen(true),
// 不會被上一次殘留的攔截旗標卡住(見 onPointerUp 的實作)。
// SPECS-INDEX #812:拖拉色塊的「點擊 vs 拖曳」閾值沿用這個數字(export 給 useCalendarBookingDrag 傳進
// useBookingDragState),不另外定義第二個閾值。
export const SLOT_TAP_VS_DRAG_THRESHOLD_PX = 10;

/** 這裡指的「指標事件」只取用 pointerType/clientX/clientY 三個欄位,故意不寫成
 * `React.PointerEvent`——這樣 Vitest 測試(touchTapVsDragOpen.test.ts)可以直接傳一般物件
 * 呼叫這個 hook 回傳的 handler,不需要真的建立一個瀏覽器 PointerEvent 才能測。 */
interface MinimalPointerEvent {
  pointerType: string;
  clientX: number;
  clientY: number;
}

/** SPECS-INDEX #641:把「觸控點擊 vs 拖曳滑動」的判斷邏輯抽成獨立的 hook,好處是可以直接用
 * Vitest + @testing-library/react 的 renderHook 單獨測試這段手勢判斷邏輯,不需要整個渲染
 * CalendarPage(牽動大量 context/react-query mocking)。實際的行為說明見 DaySlotCell 元件
 * 上方註解。 */
export function useTapVsDragOpenState(thresholdPx: number = SLOT_TAP_VS_DRAG_THRESHOLD_PX) {
  const [open, setOpen] = useState(false);
  // 這次的開啟請求是不是 Radix 對觸控 pointerdown 的內建自動反應——是的話先攔下來,改由
  // onPointerUp 依照這次觸控實際有沒有拖曳超過閾值,再決定要不要真的開啟。
  const suppressAutoOpenRef = useRef(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const draggedRef = useRef(false);

  function onOpenChange(next: boolean) {
    if (next && suppressAutoOpenRef.current) return;
    setOpen(next);
  }

  // 2026-09-24 起不分指標裝置一律套用(見上方 DaySlotCell 區塊註解的說明),所以這三支
  // handler 不再有 pointerType 的提前 return。
  function onPointerDown(e: MinimalPointerEvent) {
    suppressAutoOpenRef.current = true;
    draggedRef.current = false;
    touchStartRef.current = { x: e.clientX, y: e.clientY };
  }

  function onPointerMove(e: MinimalPointerEvent) {
    if (!touchStartRef.current) return;
    const dx = Math.abs(e.clientX - touchStartRef.current.x);
    const dy = Math.abs(e.clientY - touchStartRef.current.y);
    if (dx > thresholdPx || dy > thresholdPx) {
      draggedRef.current = true;
    }
  }

  function onPointerUp() {
    const wasTap = touchStartRef.current !== null && !draggedRef.current;
    touchStartRef.current = null;
    suppressAutoOpenRef.current = false;
    if (wasTap) setOpen(true);
  }

  function onPointerCancel() {
    // 瀏覽器判定這次觸控變成原生捲動手勢時會直接發 pointercancel,不會再有 pointerup——
    // 一併重置狀態,避免下一次觸控被誤判成延續上一次的拖曳/攔截狀態。
    touchStartRef.current = null;
    suppressAutoOpenRef.current = false;
    draggedRef.current = false;
  }

  return { open, onOpenChange, onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}

/** 2026-09-24 新增(可測試性):每一格背景格線目前是哪一種狀態。
 *
 * 2026-09-24 使用者要求「例外開啟/例外關閉這個色塊不需要文字說明,只有跨店占用需要文字」之後
 * (見下方 badgeText="" 的說明),這幾種狀態在畫面上只剩下底色/斜線圖樣的差別,而圖樣本身是
 * 商家可自訂的動態 inline style(SPECS-INDEX #644),沒有任何穩定的 class 或文字可以選取。
 * e2e 測試(e2e/staff-portal-v2.spec.ts 10.3.2/10.3.3 核心必測項目)需要驗證「整天/單一時段
 * 排休之後,商家管理員視角這幾格確實呈現成例外關閉」,所以把狀態本身以 data-slot-state 屬性
 * 明確標出來,改成斷言狀態而不是斷言文字。這是純粹的可測試性標記,不影響任何畫面呈現。 */
type DaySlotState =
  /** 落在可預約時段內,沒有單日例外。 */
  | "available"
  /** 不在可預約時段內,也沒有單日例外(預設關閉)。 */
  | "unavailable"
  /** 單日例外把這一格「開啟」成可預約。 */
  | "override-open"
  /** 單日例外把這一格「關閉」(時段排休/整天排休都走這個狀態)。 */
  | "override-closed"
  /** 這位服務人員在同一時段被別家商家的預約佔用。 */
  | "cross-store-occupied";

function daySlotState(isOverride: boolean, finalAvailable: boolean): DaySlotState {
  if (isOverride) return finalAvailable ? "override-open" : "override-closed";
  return finalAvailable ? "available" : "unavailable";
}

function DaySlotCell({
  top,
  height,
  cellClassName,
  cellStyle,
  ariaLabel,
  slotState,
  badgeText,
  showCreateOption,
  onCreateBooking,
  showOverrideOption,
  overrideOptionLabel,
  onToggleOverride,
}: {
  top: number;
  height: number;
  cellClassName: string;
  // SPECS-INDEX #644:時段排休(單日例外關閉)這一格改讀商家自訂顏色 + 圖樣,不能只靠
  // Tailwind class(build-time 就固定,無法接受任意動態色碼),所以額外開這個可選的 inline style
  // 插槽,查無資料的其他分支繼續維持純 className,不受影響。
  cellStyle?:
    | { backgroundColor: string; backgroundImage: string; borderColor: string; color: string }
    | undefined;
  ariaLabel: string;
  /** 見上方 DaySlotState 的說明:輸出成 data-slot-state 屬性,給 e2e 測試穩定選取用。 */
  slotState: DaySlotState;
  badgeText: string;
  showCreateOption: boolean;
  onCreateBooking: () => void;
  showOverrideOption: boolean;
  overrideOptionLabel: string;
  onToggleOverride: () => void;
}) {
  const { open, onOpenChange, onPointerDown, onPointerMove, onPointerUp, onPointerCancel } =
    useTapVsDragOpenState();

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "absolute inset-x-0 border-b border-border p-1 text-left text-[9px] leading-tight",
            cellClassName,
          )}
          style={{ top, height, ...cellStyle }}
          aria-label={ariaLabel}
          data-slot-state={slotState}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          {badgeText}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {showCreateOption ? (
          <DropdownMenuItem className="h-10 cursor-pointer" onClick={onCreateBooking}>
            新增預約
          </DropdownMenuItem>
        ) : null}
        {showOverrideOption ? (
          <DropdownMenuItem className="h-10 cursor-pointer" onClick={onToggleOverride}>
            {overrideOptionLabel}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// 4.3:主頁面
// ---------------------------------------------------------------------------
function CalendarPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();
  const { data: staffList } = useMerchantStaffList(merchantId);
  // 模組 7(排班與休假管理)§4.4 第 3 點:排班一覽頁的儲存格會連結跳轉到
  // /app/calendar?date=YYYY-MM-DD,這裡只在「第一次掛載」時讀取這個查詢參數決定初始日期,
  // 之後使用者在行事曆頁面自己切換日期不受這個參數影響(不用 useSearchParams 持續同步,
  // 避免使用者切換日期後網址列舊的 date 參數反過來把畫面拉回去)。
  const [searchParams] = useSearchParams();
  const initialDateParam = searchParams.get("date");

  // 模組 6(訂單管理)§5.4:「開啟/關閉時段」的權限歸在 business_hours,不是 orders(建立訂單
  // 沿用既有頁面層級的 orders 權限,這裡不用另外判斷)。同一個時段點擊選單裡,兩個選項各自依
  // 不同的權限判斷顯示/隱藏,不能誤植成同一把鑰匙(§5.5 第 1 點)。
  const { data: merchantRole } = useCurrentMerchantRole();
  const { data: canManageBusinessHoursPermission } = useAgentPermission("business_hours");
  const canManageDayOverride =
    merchantRole === "admin" ||
    (merchantRole === "agent" && canManageBusinessHoursPermission === true);

  // 建單與訂單管理介面優化 §10.5(SPECS-INDEX #621):排程色塊改讀商家自訂顏色表,查無資料/
  // 載入中時 fallback 成 DEFAULT_BOOKING_STATUS_COLORS(等同改版前寫死的顏色),不會因為查詢
  // 還沒回來而短暫顯示錯誤的顏色。
  const { data: statusColors } = useMerchantBookingStatusColors(merchantId);
  const effectiveStatusColors = statusColors ?? DEFAULT_BOOKING_STATUS_COLORS;

  // SPECS-INDEX #644:全天休假/時段排休/跨店佔用三種排程狀態改讀商家自訂顏色表,查無資料/
  // 載入中時 fallback 成 DEFAULT_CALENDAR_STATE_STYLES,做法比照上面訂單狀態顏色的既有慣例。
  const { data: calendarStateStyles } = useMerchantCalendarStateStyles(merchantId);
  const effectiveCalendarStateStyles: CalendarStateStyleMap =
    calendarStateStyles ?? DEFAULT_CALENDAR_STATE_STYLES;

  const staffNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of staffList ?? []) map.set(s.id, s.name);
    return map;
  }, [staffList]);

  // 1.1:月/週檢視切換。
  // SPECS-INDEX #640:預設開啟行事曆時要先看到月檢視,使用者要看週檢視自己再切換過去
  // (這個切換功能本身不變,只改初始值)。
  const [viewMode, setViewMode] = useState<CalendarViewMode>("month");
  const [selectedDate, setSelectedDate] = useState<Date>(() =>
    initialDateParam ? new Date(`${initialDateParam}T00:00:00`) : getTaipeiNow(),
  );
  const [monthAnchor, setMonthAnchor] = useState<Date>(() =>
    startOfMonth(initialDateParam ? new Date(`${initialDateParam}T00:00:00`) : getTaipeiNow()),
  );
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

  // 🔴 2026-09-30(品管第二次打回,🟡 第 3 項):原本只取 isLoading,查詢失敗時 schedule 是
  // undefined ⇒ 整天的時間軸畫成「目前沒有在職的服務人員」+ 一顆「前往服務人員管理」,
  // 商家以為人員都不見了(行事曆是最常用的一頁,誤導成本最高)。isError 分支排在空狀態之前。
  const {
    data: schedule,
    isLoading: scheduleLoading,
    isError: scheduleError,
    refetch: refetchSchedule,
  } = useMerchantDaySchedule(merchantId, selectedDateKey);

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

  // 建單與訂單管理介面優化 §1:拿掉 DayOverrideDialog(選時間範圍+開關的對話框),改成點擊
  // 選單項目直接切換,範圍固定是目前點擊的這一格半小時(不是選一段時間範圍)。方向跟目前顯示
  // 狀態相反(目前可預約就關閉,不可預約就開啟),呼叫既有的 set_staff_day_override,不新增
  // 任何後端邏輯。
  async function handleToggleDayOverride(
    staffId: string,
    startTime: string,
    endTime: string,
    currentlyAvailable: boolean,
  ) {
    try {
      const conflictCount = await setStaffDayOverride(
        staffId,
        selectedDateKey,
        startTime,
        endTime,
        !currentlyAvailable,
      );
      if (conflictCount > 0) {
        // §1 第 4 點:不阻擋操作,只提示既有預約筆數,不做自動取消/自動通知。
        toast.warning(
          `這個時段目前還有 ${conflictCount} 筆既有預約,系統不會自動取消或搬移,請自行確認是否需要另外處理。`,
        );
      } else {
        toast.success(currentlyAvailable ? "已關閉這個時段" : "已開啟這個時段");
      }
      refetchAll();
    } catch (err) {
      toast.error("設定失敗", { description: getErrorMessage(err) });
    }
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

  // SPECS-INDEX #811~#817:拖拉控制器。格線常數與 #641 的閾值從這裡傳進去(bookingDragMove.ts 不自己定義數字);
  // 成功/40001 之後用既有的 refetchAll 重抓;點一下(≤ 閾值)開詳情沿用 setDetailBookingId。
  const dragController = useCalendarBookingDrag({
    dateKey: selectedDateKey,
    staffBlocks: schedule?.staff,
    staffNameById,
    gridStartMin,
    slotCount: slots.length,
    slotMinutes: SLOT_MINUTES,
    slotPx: SLOT_PX,
    thresholdPx: SLOT_TAP_VS_DRAG_THRESHOLD_PX,
    onOpenDetail: setDetailBookingId,
    onMoved: refetchAll,
  });

  // 右緣漸層要不要顯示(skill 六;2026-09-30 QA:原本永遠顯示)。捲動容器已經被 dragController
  // 的 setGridRoot 佔著,所以用一個組合 ref 把兩邊都掛上去,不要二選一。
  const gridScrollHint = useHorizontalScrollHint();
  // ⚠️ 這個組合 ref 必須**永遠是同一個函式**:ref 換身分 React 就會先用 null 呼叫舊的、再呼叫新的,
  // 等於每次 render 都把捲動監聽與 touchmove 監聽拆掉重掛。所以兩個目標函式放進 ref 讀,
  // useCallback 的依賴陣列是空的(把 dragController / gridScrollHint 放進依賴會讓它每次 render 都變)。
  const setGridRootFnRef = useRef(dragController.setGridRoot);
  setGridRootFnRef.current = dragController.setGridRoot;
  const attachScrollHintRef = useRef(gridScrollHint.attach);
  attachScrollHintRef.current = gridScrollHint.attach;
  const setGridScrollRoot = useCallback((node: HTMLDivElement | null) => {
    setGridRootFnRef.current(node);
    attachScrollHintRef.current(node);
  }, []);

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-5 py-10">
      <PageHeader
        title="行事曆"
        description={`「${merchant!.name}」的預約總覽`}
        action={
          <Button
            type="button"
            variant="primary"
            size="touch"
            onClick={() => openCreateForm({ dateKey: selectedDateKey })}
          >
            新增預約
          </Button>
        }
      />

      {/* 1.1:週 / 月檢視切換(skill 二之七 單選方塊)。 */}
      <ChoiceChipGroup
        aria-label="檢視模式"
        value={viewMode}
        onValueChange={setViewMode}
        options={CALENDAR_VIEW_OPTIONS}
      />

      {viewMode === "week" ? (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="neutral"
            size="card"
            onClick={() => setSelectedDate((d) => addDays(d, -7))}
          >
            上一週
          </Button>
          <div className="grid min-w-0 flex-1 grid-cols-7 gap-1.5">
            {weekDays.map((d) => {
              const key = toDateKey(d);
              const isSelected = key === selectedDateKey;
              return (
                <button
                  key={key}
                  type="button"
                  aria-label={`切換到 ${key}`}
                  onClick={() => setSelectedDate(d)}
                  className={cn(
                    "flex min-h-11 flex-col items-center gap-1 rounded-md border px-1 py-2 text-xs transition-colors",
                    isSelected
                      ? "border-brand bg-brand-soft font-semibold text-brand"
                      : "border-border text-muted-foreground hover:border-brand/50",
                  )}
                >
                  <span>週{"日一二三四五六"[d.getDay()]}</span>
                  <span className="text-sm tabular-nums">{d.getDate()}</span>
                  {datesWithBookings.has(key) ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
                  ) : (
                    <span className="h-1.5 w-1.5" aria-hidden />
                  )}
                </button>
              );
            })}
          </div>
          <Button
            type="button"
            variant="neutral"
            size="card"
            onClick={() => setSelectedDate((d) => addDays(d, 7))}
          >
            下一週
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="neutral"
              size="card"
              onClick={() => setMonthAnchor((d) => addMonths(d, -1))}
            >
              上一月
            </Button>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {monthAnchor.getFullYear()} 年 {monthAnchor.getMonth() + 1} 月
            </span>
            <Button
              type="button"
              variant="neutral"
              size="card"
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
                    "flex min-h-11 flex-col items-center gap-1 rounded-md border px-1 py-2 text-xs tabular-nums transition-colors",
                    isSelected
                      ? "border-brand bg-brand-soft font-semibold text-brand"
                      : "border-border hover:border-brand/50",
                    !inCurrentMonth && !isSelected ? "text-muted-foreground/40" : "text-foreground",
                  )}
                >
                  <span>{date.getDate()}</span>
                  {datesWithBookings.has(key) ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
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
        <LoadingSkeleton variant="lines" rows={6} />
      ) : scheduleError ? (
        <ErrorState
          title="讀不到這天的排班與預約"
          reason="可能是網路斷了;現在先不顯示時間軸,避免你把空白當成「服務人員都不見了」或「這天沒有任何預約」"
          onRetry={() => void refetchSchedule()}
        />
      ) : !schedule || schedule.staff.length === 0 ? (
        <EmptyState
          title="目前沒有在職的服務人員"
          description="新增服務人員並設定可預約時段後,這裡會出現每個人的時間軸,就能開始排預約。"
          action={
            <Button asChild variant="primary" size="touch">
              <Link to="/app/staff">前往服務人員管理</Link>
            </Button>
          }
        />
      ) : !businessHours?.has_setting ? (
        <EmptyState
          title="尚未設定這天的營業時間"
          description="目前無法被預約,請先到營業時間設定完成設定。"
          action={
            <Button asChild variant="primary" size="touch">
              <Link to="/app/business-hours">前往營業時間設定</Link>
            </Button>
          }
        />
      ) : businessHours.is_closed ? (
        <EmptyState
          title="商家這天公休"
          description="公休日無法建立預約,可以切換到其他日期,或到營業時間設定調整。"
        />
      ) : (
        // skill 六:放不下橫向捲、時間欄固定在左邊、服務人員名字列固定在上面、右緣漸層陰影暗示還有內容。
        // 外面多包一層 relative 只是為了放右緣漸層,捲動容器本身(dragController.setGridRoot)不變。
        <div className="relative">
          <div
            // #811:捲動容器同時是拖拉的格線根節點——原生 touchmove 攔截(只在 dragging 才 preventDefault)
            // 與靠邊自動橫向捲動都掛在它身上;§5.9 committing 期間整個格線 pointer-events-none。
            // 2026-09-30:再串一個 scrollHint.attach(右緣漸層要不要顯示),兩個 ref 都要掛,不是二選一。
            ref={setGridScrollRoot}
            data-testid="calendar-day-grid"
            data-drag-phase={dragController.phase}
            className={cn(
              // 🔴 max-h + overflow-y-auto 是「服務人員名字列固定在上面」的前提(skill 六):
              // position: sticky 是相對**最近的捲動容器**算的,這一層有 overflow-x-auto 就已經是
              // y 軸的捲動容器(CSS:另一軸是 auto 時,visible 會被計算成 auto),所以名字列的
              // sticky top-0 只有在「這一層自己能直向捲」的時候才有效果——不給高度上限的話,
              // 直向捲的是整個頁面,名字列會跟著跑掉(= 2026-09-30 QA 抓到的「沒做 sticky」)。
              "max-h-[70vh] overflow-x-auto overflow-y-auto rounded-md border border-border",
              dragController.isCommitting && "pointer-events-none",
            )}
          >
            {/* 🔴 這一層是時間欄 sticky 的 containing block,所以**必須真的長到內容寬**。
                原本寫 min-w-[640px]:flex 子項溢出時不會把 flex 容器撐大,父層寬度永遠停在
                max(640, 捲動容器寬),時間欄最多只能跟著捲「父層寬 − 72」,超過就被丟在後面整條捲出
                畫面(捲到右邊之後完全看不到時間,色塊是幾點的認不出來)。
                w-max = width: max-content(跟著內容成長),min-w-full 保證螢幕夠寬時仍然鋪滿容器。

                🔴 **舊寫法的壞掉門檻:用公式自己算,不要抄下面的數字。**
                   這個數字已經被抄錯兩次(skill 一度寫「1280px 14 位就壞」、一度寫「1278px 19 位」,
                   兩個都是錯的),所以**引用時一律重算一次**:

                     父層寬 P = max(640, W)    ← 640 是舊寫法的 min-w,W = **捲動容器**寬(不是螢幕寬)
                     內容寬   = 72 + 120N       ← 時間欄 72px + 每位服務人員 120px
                     壞掉條件:內容寬 − W > P − 72   即   **72 + 120N > W + P − 72**
                     (左邊是可捲距離,右邊是 sticky 能跟著位移的上限;可捲距離超過上限就被丟在後面)

                   W ≥ 640 時 P = W,化簡成 `72 + 120N > 2W − 72`;
                   W < 640 時 P = 640,是 `72 + 120N > W + 568` ——
                   🔴 **小螢幕不能用化簡版**,320px 用化簡版會算出 4 位,實際是 7 位。
                   代進去的結果(W 是捲動容器寬,不是螢幕寬):
                     W = 278px(320px 螢幕)→ **7 位**起壞     W = 350px(390px 螢幕)→ **8 位**起壞
                     W = 1110px(1280px 螢幕)→ **18 位**起壞  W = 1278px → **21 位**起壞
                   ⇒ 所以「1280px 14 位就壞」是錯的:QA 用舊寫法做負向對照,1280px × 14 位量到
                     掉出 0px、根本沒壞(14 < 18)。

                ⚠️ jsdom 測不出這一條(它不做版面計算),改這裡一定要回 320px 真瀏覽器用 8 位以上重測。
                真瀏覽器實測(2026-09-30,headless chromium)。判斷標準是**「捲到最右端時,時間欄有沒有
                被推出容器左緣」**,不是某一個絕對 x 座標——座標會隨容器位置、頁面邊距、瀏覽器捲軸寬度
                而變,寫死數字會讓下一個人量到別的數字就以為壞了。以「掉出容器左緣幾 px」記錄:
                  320px: 7 人 / 8 人 / 12 人  舊:掉出 66 / 186 / 666px  →  新:全部掉出 0px ✅
                  390px: 8 人 / 14 人         舊:掉出 116 / 836px       →  新:全部掉出 0px ✅
                  1280px:14 人               舊:父層寬 1110、內容 1752,掉出 0px(**沒壞,門檻是 18 位**)
                                             新:父層寬 1752、時間欄不動 ✅
                  欄寬:320px 12 人 = 120px(下限),1280px 6 人 = 173px(有空間就均分,行為不變) */}
            <div className="flex w-max min-w-full">
              {/* 時間欄:sticky 固定在左邊,橫向捲時不跟著跑(skill 六)。
                  🔴 **層級階梯**(2026-09-30 使用者實機巡檢抓到:往下捲時訂單色塊畫在服務人員名字列
                  上面、把名字蓋掉)。根因是名字列跟色塊**都是 z-10**,同一級 ⇒ DOM 順序後畫的
                  (色塊)蓋住先畫的(名字列)。這四個元素必須是**四個不同的層級**,不可以有兩個同級:

                    | 元素 | 層級 | 為什麼 |
                    |---|---|---|
                    | 訂單色塊(calendarBookingDrag.tsx 的 DraggableBookingBlock) | **z-10** 最低 | 兩個固定欄都要蓋得住它 |
                    | 服務人員名字列(sticky top) | **z-20** | 直向捲時要蓋住色塊 |
                    | 時間欄(sticky left,就是這一層) | **z-30** | 橫向捲時要蓋住色塊**與名字列** |
                    | 左上角那一格(兩邊都 sticky) | **z-40** | 最上層 |

                  🔴 **時間欄一定要比名字列高,不能兩個都 z-20。** 橫向捲到右邊時,時間欄會蓋在
                  服務人員欄上面(**包含它們的表頭格**);兩者同級的話 DOM 順序(名字列在後)會讓
                  名字列畫在時間欄上面 —— 那就是同一個 bug 換一個方向再發生一次。
                  📌 為什麼直接比大小就對:服務人員欄是 `relative` 但**沒有** z-index(= z-index auto),
                  所以它不建立 stacking context,裡面的名字列/色塊的 z 值是跟時間欄放在**同一個**
                  stacking context 比的。反過來說,這一層有了 z-30 就**變成** stacking context,
                  所以裡面那格「左上角」的 z-40 只跟時間欄自己的子元素比,不會跟外面搶。
                  🔴 jsdom 測不出層級遮擋(不做版面計算與繪製),改完一定要用真瀏覽器
                  `document.elementFromPoint()` 在「往下捲」與「往右捲」兩種狀態下各驗一次。 */}
              <div className="sticky left-0 z-30 flex w-[72px] shrink-0 flex-col bg-background">
                <div
                  // 左上角那一格:同時 sticky left(跟著時間欄)與 sticky top(跟著名字列),
                  // 層級階梯最上層 z-40(見上面那張表)——它必須同時蓋住名字列與時間格。
                  // data-drag-time-gutter:#846 拖拉落點要知道「被固定欄視覺蓋住的那一段 x」是哪裡,
                  // 讀的就是這個元素的右邊界(見 calendarBookingDrag 的 readColumnGeometry)。
                  data-drag-time-gutter="true"
                  className="sticky top-0 z-40 flex h-9 items-center border-b border-r border-border bg-surface p-2 text-xs font-medium text-muted-foreground"
                >
                  時間
                </div>
                <div className="relative" style={{ height: gridTotalPx }}>
                  {slots.map((slot, i) => (
                    <div
                      key={slot.start}
                      className="absolute inset-x-0 border-b border-r border-border p-1 text-right text-[11px] tabular-nums text-muted-foreground"
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
                  data-testid={`staff-column-${s.staff_id}`}
                  data-drop-target={
                    dragController.highlightedStaffId === s.staff_id ? "true" : undefined
                  }
                  className={cn(
                    // w-[120px] shrink-0 grow 取代原本的 min-w-[120px] flex-1:兩者在畫面上等效
                    // (最小 120px、有多餘空間就均分),但 flex-basis 是確定值,父層的 w-max
                    // 才算得出「內容到底多寬」(flex-1 = basis 0%,max-content 會被 flex 分數規則
                    // 拉成「所有欄都跟最寬那一欄的內容一樣寬」,不是我們要的 72+120×N)。
                    "relative w-[120px] shrink-0 grow border-r border-border last:border-r-0",
                    // §5.4:拖拉中游標下方的欄位加 ring;forbidden 時換成警示色。
                    dragController.highlightedStaffId === s.staff_id &&
                      (dragController.highlightForbidden
                        ? "ring-2 ring-inset ring-destructive"
                        : "ring-2 ring-inset ring-brand"),
                  )}
                >
                  {/* skill 六:服務人員名字列固定在上面,直向捲時不跟著跑。bg-surface 不能省
                      (透明的話色塊會從底下透出來)。
                      🔴 z-20:必須**嚴格大於**訂單色塊的 z-10(2026-09-30 使用者實機巡檢:兩邊都是
                      z-10 時,DOM 順序讓後畫的色塊蓋住名字列,往下捲名字就消失),並且**嚴格小於**
                      時間欄的 z-30(橫向捲時時間欄要蓋住名字列,含這個表頭格)。完整的四層階梯表
                      寫在上面時間欄那一段的註解裡,改任何一層之前先讀那張表。 */}
                  <div className="sticky top-0 z-20 flex h-9 flex-col items-center justify-center border-b border-border bg-surface p-1 text-center text-xs font-medium text-foreground">
                    <span className="max-w-full truncate">{s.staff_name}</span>
                    {/* 模組 7(排班與休假管理)§4.5:請假整欄灰底顯示假別名稱。主腦裁示:請假一律擋下
                        建單,不論 unlimited_backend_edit 是否開啟都沒有覆寫例外,所以這裡不需要規格書
                        原文提到的「可透過無限制編輯覆寫」特殊標示。 */}
                    {s.on_leave ? (
                      <span className="max-w-full truncate text-[10px] font-normal text-muted-foreground">
                        休假:{s.on_leave.leave_type_name}
                      </span>
                    ) : null}
                  </div>
                  <div
                    className="relative"
                    style={{ height: gridTotalPx }}
                    // #811:這一層是「第 0 格頂端」所在的元素,拖拉落點計算(computeDropTarget)用它的
                    // getBoundingClientRect 當 gridTopClientY 與欄位左右邊界;Playwright 也用這個 testid 算座標。
                    data-drag-column={s.staff_id}
                    data-testid={`staff-grid-${s.staff_id}`}
                  >
                    {/* 模組 7 §4.5:請假整天,整欄改成不可點擊建單——不進入下面複雜的背景格線/
                        DropdownMenu 邏輯,直接渲染一個涵蓋全高的區塊。既有的預約(s.bookings)
                        仍然疊在上面顯示,方便管理員看到這天已經有哪些預約需要自己判斷處理
                        (規則 2.6:系統只警示不代為處理),但不能再新增新的預約。
                        SPECS-INDEX #644:底色/圖樣改讀商家自訂的「全天休假」設定(密集 45 度斜線),
                        不再是寫死的 bg-muted/60。 */}
                    {s.on_leave ? (
                      <div
                        className="absolute inset-0"
                        style={calendarStateBlockStyle(
                          effectiveCalendarStateStyles,
                          "full_day_leave",
                        )}
                        aria-label={`休假:${s.on_leave.leave_type_name},無法預約`}
                      />
                    ) : null}
                    {/* 背景格線:依可預約時段/單日例外/跨店占用著色。模組 6 §5.3/§5.5 第 4 點:
                        每格先看有沒有落在某個 availability_overrides 區間內,有則採用該區間的
                        is_available 值決定顯示狀態,沒有則沿用既有的商家營業時間∩服務人員時段判斷
                        (available_windows,第一層∩第二層,後端算好的結果)。 */}
                    {s.on_leave
                      ? null
                      : slots.map((slot, i) => {
                          const slotStartMin = timeToMinutes(slot.start);
                          const slotEndMin = timeToMinutes(slot.end);

                          const inWindow = s.available_windows.some(
                            (w) =>
                              timeToMinutes(w.start_time) <= slotStartMin &&
                              timeToMinutes(w.end_time) >= slotEndMin,
                          );

                          const matchedOverride = s.availability_overrides.find(
                            (o) =>
                              timeToMinutes(o.start_time) <= slotStartMin &&
                              timeToMinutes(o.end_time) >= slotEndMin,
                          );
                          const isOverride = Boolean(matchedOverride);
                          // §5.3 第 1 點:有例外直接採用例外值,不論第一層∩第二層原本判斷結果是什麼。
                          const finalAvailable = matchedOverride
                            ? matchedOverride.is_available
                            : inWindow;

                          const foreignBusy = s.foreign_bookings.some((b) => {
                            const bStart = timeToMinutes(isoToTaipeiTime(b.start_at));
                            const bEnd = timeToMinutes(isoToTaipeiTime(b.end_at));
                            return bStart < slotEndMin && bEnd > slotStartMin;
                          });

                          if (foreignBusy) {
                            // SPECS-INDEX #644:底色/圖樣改讀商家自訂的「跨店佔用」設定(交叉網格紋),
                            // 不再是寫死的 bg-warn/15(避免跟「待確認」訂單狀態的黃橘色混淆)。
                            return (
                              <div
                                key={slot.start}
                                className="absolute inset-x-0 border-b border-border p-1 text-[10px]"
                                style={{
                                  top: i * SLOT_PX,
                                  height: SLOT_PX,
                                  ...calendarStateBlockStyle(
                                    effectiveCalendarStateStyles,
                                    "cross_store_occupied",
                                  ),
                                }}
                                data-slot-state="cross-store-occupied"
                              >
                                外店預約中
                              </div>
                            );
                          }

                          // 沒有任何可用操作(建單需要可預約,開啟/關閉時段需要 business_hours 權限)時,
                          // 維持既有的純視覺格子,不包 DropdownMenu(避免點了沒有反應造成困惑)。
                          if (!finalAvailable && !canManageDayOverride) {
                            return (
                              <div
                                key={slot.start}
                                className="absolute inset-x-0 border-b border-border bg-muted/40"
                                style={{ top: i * SLOT_PX, height: SLOT_PX }}
                                aria-label="不可預約"
                                // 沒有 business_hours 權限的人走這個純視覺分支,一樣標出狀態,
                                // 讓「不同權限視角看到的同一格是不是同一個狀態」也能被測試比對。
                                data-slot-state={daySlotState(isOverride, finalAvailable)}
                              />
                            );
                          }

                          // §5.5 第 4 點:「例外關閉」「例外開啟」給跟預設狀態視覺上有區別的樣式,方便
                          // 管理員一眼看出這是臨時調整過的,不是預設狀態。
                          // SPECS-INDEX #644:「例外關閉」(時段排休)這一分支不再用寫死的
                          // bg-destructive/10 ring,改讀商家自訂顏色 + 稀疏 45 度斜線圖樣(下面的
                          // cellStyle),圖樣本身已經足夠跟其他狀態視覺區隔,不需要再疊加 ring。
                          const cellClassName = finalAvailable
                            ? isOverride
                              ? "bg-brand-soft/70 ring-1 ring-inset ring-brand hover:bg-brand-soft"
                              : "bg-background hover:bg-brand-soft/40"
                            : isOverride
                              ? "hover:opacity-80"
                              : "bg-muted/40 hover:bg-muted/60";
                          const cellStyle =
                            isOverride && !finalAvailable
                              ? calendarStateBlockStyle(
                                  effectiveCalendarStateStyles,
                                  "partial_leave",
                                )
                              : undefined;

                          // SPECS-INDEX #641:格子本體(觸控手勢區分拖曳滑動/點擊)抽成 DaySlotCell,
                          // 見該元件上方註解說明修法。這裡只負責把這一格的資料/權限判斷結果轉成 props。
                          return (
                            <DaySlotCell
                              key={slot.start}
                              top={i * SLOT_PX}
                              height={SLOT_PX}
                              cellClassName={cellClassName}
                              cellStyle={cellStyle}
                              ariaLabel={finalAvailable ? "可預約" : "不可預約"}
                              // 見 DaySlotState 的說明:斜線圖樣不帶文字之後,這是唯一能穩定
                              // 分辨「例外關閉」跟「預設關閉」的標記。
                              slotState={daySlotState(isOverride, finalAvailable)}
                              // 使用者要求:「例外開啟/例外關閉」這個色塊(斜線圖樣)不需要疊加文字說明,
                              // 圖樣本身已經足夠跟預設狀態區隔——只有跨店占用(上面 foreignBusy 那個
                              // 分支的「外店預約中」)才需要文字,因為那個狀態光靠顏色/圖樣不足以說明
                              // 「這是被別家佔用,不是本店自己的例外設定」這件事。
                              badgeText=""
                              // §5.5 第 1 點:「新增預約」(建單與訂單管理介面優化 §6 改名,原本叫
                              // 「建立訂單」)依既有 orders 權限判斷(頁面層級已限定),只有這一格
                              // 實際可預約時才提供。
                              showCreateOption={finalAvailable}
                              onCreateBooking={() =>
                                openCreateForm({
                                  staffId: s.staff_id,
                                  dateKey: selectedDateKey,
                                  time: slot.start,
                                })
                              }
                              // §5.4/§5.5 第 1 點:「開啟/關閉時段」依 business_hours 權限判斷,跟上面
                              // 的「新增預約」是不同的權限鑰匙。建單與訂單管理介面優化 §1:文字依這一格
                              // 目前的可預約狀態動態顯示,點擊後直接切換,範圍固定是目前這一格半小時,
                              // 不再跳對話框選時間範圍。
                              showOverrideOption={canManageDayOverride}
                              overrideOptionLabel={finalAvailable ? "關閉時段" : "開啟時段"}
                              onToggleOverride={() =>
                                handleToggleDayOverride(
                                  s.staff_id,
                                  slot.start,
                                  slot.end,
                                  finalAvailable,
                                )
                              }
                            />
                          );
                        })}

                    {/* 1.3:同一筆預約合併顯示成一個跨越多格高度的連續色塊,疊在背景格線上方。 */}
                    {s.bookings.map((b: DayScheduleOwnBooking) => {
                      const bStartMin = timeToMinutes(isoToTaipeiTime(b.start_at));
                      const bEndMin = timeToMinutes(isoToTaipeiTime(b.end_at));
                      const top = Math.max(
                        0,
                        ((bStartMin - gridStartMin) / SLOT_MINUTES) * SLOT_PX,
                      );
                      const height = Math.max(
                        SLOT_PX / 2,
                        ((bEndMin - bStartMin) / SLOT_MINUTES) * SLOT_PX,
                      );
                      // #811~#817:色塊改成 DraggableBookingBlock(calendarBookingDrag.tsx)。原本這裡的
                      // onClick={() => setDetailBookingId(b.id)} 已拿掉——可拖的色塊改由手勢 hook 判定
                      // 「≤ 閾值就放開 = 點擊」才開詳情,否則拖完放開瀏覽器補發的 click 會把詳情彈出來。
                      return (
                        <DraggableBookingBlock
                          key={b.id}
                          booking={b}
                          staffId={s.staff_id}
                          style={{
                            top,
                            height,
                            ...bookingBlockStyle(effectiveStatusColors, b.status),
                          }}
                          controller={dragController}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {/* skill 六:右緣漸層陰影,暗示右邊還有服務人員欄可以捲。pointer-events-none,不影響拖拉與捲動。
              🔴 2026-09-30 QA:原本永遠顯示,沒東西可捲時也把最右 24px 蓋住,而且捲到最右端之後還在
              暗示「右邊還有」。漸層的語意就是「這個方向還有內容」⇒ 只有真的還能往右捲才顯示。 */}
          {gridScrollHint.canScrollRight ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-0 w-6 rounded-r-md bg-gradient-to-l from-background/90 to-transparent"
            />
          ) : null}
        </div>
      )}

      {/* #811 殘影(position: fixed,放在捲動容器外面,不被 overflow 裁切);#816 過去時間確認框。 */}
      <BookingDragGhost ghost={dragController.ghost} />
      <PastDropConfirmDialog
        request={dragController.pastConfirm}
        onResolve={dragController.resolvePastConfirm}
      />

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

// 模組 14(服務人員端)規格書 4.3:服務人員登入後看到的是簡化版自助行事曆
// (src/modules/staff-portal/MyCalendarPage.tsx),不是下面給管理員/客服看的
// CalendarPageInner——這裡刻意不套用 RequireBookingAccess(那個守衛只認 admin/agent,
// 服務人員一律會被導回 /app),角色判斷放在 RequireBookingAccess 之外先做分流。
//
// 2026-09-24 修正:原本這裡判斷 `role === "staff"`,對「同時是管理員/客服 + 同一間商家的服務
// 人員」的雙重身分使用者是 false(角色優先序會把他解析成 admin/agent),所以他切換到服務人員端
// 之後點「行事曆」會掉到商家版 CalendarPageInner,再被 RequireBookingAccess 擋掉,變成空白畫面。
// 改讀 AppLayout 已經算好並透過 outlet context 傳下來的 isStaffView(/app/calendar 是
// <Route element={<AppLayout />}> 的子路由),跟 HomePage/ManagePage 用同一個判斷來源,
// 不要在這裡自己重算一次角色。
function CalendarPageRoleGate() {
  const { isStaffView, isViewResolved } = useAppLayoutContext();

  // isViewResolved 這道守衛不能省:角色/服務人員紀錄還在查的時候 isStaffView 一律是 false,
  // 少了這一關,雙重身分的人會先閃一下商家版行事曆(甚至閃一下被擋掉的空白畫面)才切回來。
  if (!isViewResolved) {
    return (
      <div className="mx-auto max-w-6xl px-5 py-10">
        <LoadingSkeleton variant="lines" rows={6} />
      </div>
    );
  }

  if (isStaffView) {
    return (
      <main className="mx-auto max-w-3xl px-5 py-12">
        <MyCalendarPage />
      </main>
    );
  }

  return (
    <RequireBookingAccess>
      <CalendarPageInner />
    </RequireBookingAccess>
  );
}

export default function CalendarPage() {
  return <CalendarPageRoleGate />;
}
