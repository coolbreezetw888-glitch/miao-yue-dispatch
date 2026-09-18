// 模組 5:行事曆與預約核心引擎 — 型別定義
// 對應規格書第一節資料表。其他模組若需要用到營業時間/可預約時段/預約相關型別,一律從這個檔案或
// context.tsx 匯出的 hooks 取得,不要直接 import Supabase 產生的 Tables<'bookings'> 等型別
// (呼應規格書第五節「對外介面」的模組獨立性設計)。

import type { Tables } from "@/integrations/supabase/types";

export type MerchantBusinessHours = Tables<"merchant_business_hours">;
export type StaffAvailabilityWindow = Tables<"staff_availability_windows">;
/** 模組 6(訂單管理)§5.1:單日例外(開啟/關閉時段),半小時為單位,只影響「特定那一天」。 */
export type StaffAvailabilityOverride = Tables<"staff_availability_overrides">;
export type Booking = Tables<"bookings">;
export type BookingServiceItem = Tables<"booking_service_items">;
export type BookingAssistant = Tables<"booking_assistants">;
export type MaterialCostItem = Tables<"material_cost_items">;
export type BookingMaterialCost = Tables<"booking_material_costs">;
/** 模組 6(訂單管理)§2.1:商家整體稅金模式統一設定,一商家一列,查無資料時前端/後端一律
 * fallback 成 DEFAULT_MERCHANT_TAX_SETTINGS(裁決 Q5)。 */
export type MerchantTaxSettings = Tables<"merchant_tax_settings">;

/** 模組 6 §2.1 裁決 Q4/Q5:折扣/稅金都是「固定金額」或「百分比」二選一。 */
export type AmountAdjustmentMode = "fixed" | "percentage";

export const AMOUNT_ADJUSTMENT_MODE_LABELS: Record<AmountAdjustmentMode, string> = {
  fixed: "固定金額",
  percentage: "百分比",
};

/** 模組 6 §2.1:merchant_tax_settings 查無資料時,前端/後端一律套用這組預設值
 * (tax_mode='percentage'、tax_value=5.00)。 */
export const DEFAULT_MERCHANT_TAX_SETTINGS: { taxMode: AmountAdjustmentMode; taxValue: number } = {
  taxMode: "percentage",
  taxValue: 5.0,
};

/** 模組 9(支付方式)§1.1:全平台固定的 7 個付款方式代碼,產品方定義,不是商家自訂文字,
 * 不因產業類型(到府派工/美業到店)增減(§2.2)。用穩定的代碼值存資料庫,顯示文字放對照表,
 * 方便之後要改文案時不用動資料庫裡已經存在的值。原本模組 6 §3.2/裁決 Q10 只有 on_site 一個
 * 暫時選項,這裡是模組 9 的正式擴充。 */
export const PAYMENT_METHOD_CODES = [
  "on_site",
  "bank_transfer",
  "atm",
  "linepay",
  "jkopay",
  "credit_card",
  "no_payment",
] as const;

export type PaymentMethodCode = (typeof PAYMENT_METHOD_CODES)[number];

/** 模組 9 §1.1 對外介面:代碼 → 中文顯示文字對照表。「無支付」(no_payment)定案語意
 * (Q2 暫定裁決,待使用者確認)是「這筆預約本來就不用收費」(保固維修/免費估價/公關招待),
 * 跟「留空(null)=尚未設定」是兩種不同語意,顯示文字必須有清楚區隔(見下方 getPaymentMethodLabel)。 */
export const PAYMENT_METHOD_OPTIONS: Record<PaymentMethodCode, string> = {
  on_site: "現場付款",
  bank_transfer: "匯款",
  atm: "ATM 轉帳",
  linepay: "LINE Pay",
  jkopay: "街口支付",
  credit_card: "信用卡",
  no_payment: "無支付",
};

/** 模組 9 §1.3/§4 對外介面(Q3 暫定裁決,待使用者確認):merchant_payment_method_settings
 * 查無資料時的 fallback 預設值——只有現場付款預設開啟,其餘 6 項預設關閉,維持模組 6 上線至今的
 * 實際狀態,不因這次擴充選項清單讓既有商家突然多出一堆沒設定過的選項。商家要開放其他付款方式,
 * 必須自己到設定頁(BusinessHoursPage 的 PaymentMethodSettingsCard)勾選。 */
export const DEFAULT_MERCHANT_PAYMENT_METHOD_SETTINGS: Record<PaymentMethodCode, boolean> = {
  on_site: true,
  bank_transfer: false,
  atm: false,
  linepay: false,
  jkopay: false,
  credit_card: false,
  no_payment: false,
};

/** 把 bookings.payment_method 的原始值轉成畫面顯示文字。null/空字串顯示「尚未設定」;
 * 萬一資料庫裡存了一個目前對照表沒有的值(例如以後選項改名但沒轉舊資料,或手動塞的舊資料),
 * 直接顯示原始值,不要讓畫面空白或報錯(模組 9 規格書 §5 邊界情況第 4 點)。 */
export function getPaymentMethodLabel(value: string | null | undefined): string {
  if (!value) return "尚未設定";
  return PAYMENT_METHOD_OPTIONS[value as PaymentMethodCode] ?? value;
}

/** 建單與訂單管理介面優化 §2:建單表單稅金說明文字,依商家目前的稅金模式(比例/固定金額)
 * 顯示對應的文字,不能寫死成只有百分比的版本。這裡只影響顯示文字,不影響
 * merchant_tax_settings.tax_mode 的判斷邏輯或任何資料寫入/計算邏輯。 */
export function getTaxModeHelperText(mode: AmountAdjustmentMode): string {
  return mode === "percentage"
    ? "依商家設定稅率百分比,數字可個別調整。"
    : "依商家設定稅額,金額可個別調整。";
}

/** 規則 2.9,建單功能擴充決策記錄 5 更新:六個狀態值,這次會真的用到
 * pending_confirmation/accepted/completed/cancelled 四種(pending_confirmation 是這次擴充新增的
 * 實際會用到的狀態),其餘兩種(pending_reply/dispatching)是預留給未來智慧建單/客戶自助預約/
 * 派工流程,這裡只需要存在顯示文案對照表裡。 */
export type BookingStatus =
  "pending_reply" | "pending_confirmation" | "dispatching" | "accepted" | "completed" | "cancelled";

/** 決策記錄 5:accepted 這個資料庫欄位值不改名,只改畫面顯示文字從「已接受」改成「已確認」,
 * 更貼近使用者的實際用語習慣。 */
export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  pending_reply: "待回覆",
  pending_confirmation: "待確認",
  dispatching: "派單中",
  accepted: "已確認",
  completed: "已完成",
  cancelled: "已取消",
};

/** 建單功能擴充 2.4:這次還沒進入終止狀態(completed/cancelled)的兩種狀態,月檢視日期標示
 * (1.2)、行事曆色塊(1.3)都要把這兩種狀態算進「這天有預約」。 */
export const ACTIVE_BOOKING_STATUSES: BookingStatus[] = ["pending_confirmation", "accepted"];

// ---------------------------------------------------------------------------
// 1.3:排程色塊視覺(CalendarPage.tsx)/建單與訂單管理介面優化 §7.5:訂單卡片色條
// (OrdersPage.tsx)共用的「狀態 -> 樣式」純函式。放在這支純型別/純函式檔案(不含 React 元件),
// 讓兩個頁面都能 import,不用互相依賴對方的內部實作,也不會觸發
// react-refresh/only-export-components 警告(該警告只在「元件檔案」裡混雜非元件匯出時出現)。
// ---------------------------------------------------------------------------

/** 依狀態決定行事曆排程色塊的樣式,待確認/已確認/已完成/已取消四種可區分。 */
export function bookingBlockClasses(status: BookingStatus): string {
  if (status === "completed") return "bg-cta-soft text-cta";
  if (status === "pending_confirmation") return "border border-warn/50 bg-warn/20 text-warn";
  // 建單與訂單管理介面優化 §7.5:新增 cancelled 的配色(訂單管理頁卡片列表需要),沿用既有的
  // 灰階 token(muted),不新增自訂顏色。
  if (status === "cancelled") return "bg-muted text-muted-foreground";
  return "bg-brand-soft text-accent-foreground"; // accepted(已確認)
}

/** 建單與訂單管理介面優化 §7.5:訂單卡片左側色條專用的邊框顏色 token,跟上面
 * bookingBlockClasses 沿用同一套狀態配色邏輯,只是套用在 border-l(色條)而不是整塊背景色。
 * cancelled 這次額外選用既有的灰階 token(muted-foreground),不新增自訂顏色。 */
export function bookingCardAccentBorderClass(status: BookingStatus): string {
  if (status === "completed") return "border-l-cta";
  if (status === "pending_confirmation") return "border-l-warn";
  if (status === "cancelled") return "border-l-muted-foreground/40";
  return "border-l-brand"; // accepted(已確認)
}

/** 0=星期日...6=星期六,對應 merchant_business_hours.day_of_week /
 * staff_availability_windows.day_of_week 跟 Postgres extract(dow from ...) 的回傳值。 */
export const DAY_OF_WEEK_LABELS = ["日", "一", "二", "三", "四", "五", "六"] as const;

export interface DayScheduleAvailableWindow {
  start_time: string;
  end_time: string;
}

/** 模組 6 §5.5 第 3 點:get_merchant_day_schedule 回傳的單日例外區間(合併相鄰同值半小時格子)。 */
export interface DayScheduleAvailabilityOverride {
  start_time: string;
  end_time: string;
  is_available: boolean;
}

/** 建單功能擴充 2.1:取代原本單一 service_item_id/service_item_name 字串。 */
export interface DayScheduleServiceItemRef {
  id: string;
  name: string;
}

/** 建單功能擴充 4.2 第 2 點:標示這位服務人員在這筆預約裡是「主要」還是「協助」。 */
export type BookingParticipantRole = "main" | "assistant";

export interface DayScheduleOwnBooking {
  id: string;
  start_at: string;
  end_at: string;
  status: BookingStatus;
  customer_name: string;
  customer_phone: string;
  notes: string | null;
  role: BookingParticipantRole;
  service_items: DayScheduleServiceItemRef[];
}

export interface DayScheduleForeignBooking {
  start_at: string;
  end_at: string;
}

export interface DayScheduleStaffBlock {
  staff_id: string;
  staff_name: string;
  no_time_slot_limit: boolean;
  available_windows: DayScheduleAvailableWindow[];
  /** 模組 6 §5.5 第 3 點(新增):這位服務人員這一天的單日例外設定,前端疊加規則(§5.3):
   * 落在某個區間內就採用該區間的 is_available 值,沒有落在任何區間就沿用 available_windows
   * 既有的判斷,不要漏接這個疊加順序。 */
  availability_overrides: DayScheduleAvailabilityOverride[];
  bookings: DayScheduleOwnBooking[];
  foreign_bookings: DayScheduleForeignBooking[];
}

/** 3.6/5.3 對外介面 get_merchant_day_schedule() 的回傳結構(jsonb)。 */
export interface MerchantDaySchedule {
  date: string;
  business_hours: {
    has_setting: boolean;
    is_closed: boolean;
    open_time: string | null;
    close_time: string | null;
  };
  staff: DayScheduleStaffBlock[];
}

/** 建單功能擴充 4.3:getBooking(id) 擴充後的完整詳情,供 5.2 預約詳情彈窗顯示、
 * 5.3 編輯表單帶入預設值使用。商家未開啟料錢成本功能時 materialCosts 固定回傳空陣列。 */
export interface BookingDetailAssistant {
  staffId: string;
  staffName: string;
}

/** 模組 6(訂單管理)§3.1:取代原本的即時查價顯示(BookingDetailServiceItem.price 曾經是
 * 查詢當下 service_items.price 的即時值,不是金額快照——這個舊行為已經被取代)。現在一律讀
 * booking_service_items 的 quantity/unit_price_snapshot 這兩個金額快照欄位,不論
 * service_items.price 之後怎麼改,這裡顯示的數字永遠鎖定建立/編輯當下的值。
 * name 的下架/刪除 fallback 邏輯不變(見 api.ts getBooking 的說明:繼續顯示真實名稱,只有金額
 * 相關欄位才需要 fallback,而这裡的金額欄位是快照,不受下架影響,不需要 fallback)。 */
export interface BookingDetailServiceItem extends DayScheduleServiceItemRef {
  quantity: number;
  unitPriceSnapshot: number;
  /** 方便顯示用的小計 = unitPriceSnapshot × quantity,不是另外存的欄位。 */
  lineTotal: number;
}

/** 模組 6 §3.3/§6.3:相關訂單清單裡的一筆訂單摘要,由 getCustomerRelatedBookings 回傳。 */
export interface CustomerRelatedBooking {
  id: string;
  startAt: string;
  endAt: string;
  status: BookingStatus;
  finalAmountSnapshot: number;
  serviceItemNames: string[];
}

export interface BookingDetailMaterialCost {
  materialCostItemId: string;
  name: string;
  amountSnapshot: number;
}

/** 預約詳情資訊擴充與建單備註分類第三節 3.2/3.3:建立者/最後修改者轉成的可讀姓名,
 * 由 get_booking_actor_names 這支 RPC 查詢得來。createdByName 一定有值(每筆預約都有
 * created_by_user_id);lastModifiedByName 只有在 booking.last_modified_by_user_id
 * 不是 null 時才會有值(從未被 confirm_booking/update_booking/cancel_booking/complete_booking
 * 異動過的訂單維持 undefined,對應規格書「這一列不顯示」)。 */
export interface BookingDetail extends Booking {
  serviceItems: BookingDetailServiceItem[];
  assistants: BookingDetailAssistant[];
  materialCosts: BookingDetailMaterialCost[];
  createdByName: string;
  lastModifiedByName: string | null;
}
