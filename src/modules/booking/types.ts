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
/** 模組 9(支付方式)v2:商家自訂付款方式清單,取代 v1 的固定 7 代碼設計。比照
 * material_cost_items 的既有模式,商家自己命名,想新增幾筆都可以。 */
export type PaymentMethod = Tables<"payment_methods">;
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

/** 模組 9(支付方式)v2 §5.3:把 bookings.payment_method_name_snapshot 轉成畫面顯示文字。
 * null/空字串顯示「尚未設定」。這裡不做任何代碼查表(v1 才需要,因為 v1 是固定代碼;v2 商家
 * 自訂名稱,存的就是要顯示的文字本身),直接顯示快照文字,商家事後改名/下架不影響已建立訂單的
 * 顯示(模組 9 v2 核心要求)。 */
export function getPaymentMethodLabel(nameSnapshot: string | null | undefined): string {
  if (!nameSnapshot || nameSnapshot.trim() === "") return "尚未設定";
  return nameSnapshot;
}

/** 建單表單下拉選單顯示用的最小欄位集合(§5.2)。 */
export interface PaymentMethodOption {
  id: string;
  name: string;
}

/** 模組 9 v2 §5.2:建單表單付款方式下拉選單的選項組成邏輯(從 CalendarPage.tsx 抽出成純函式,
 * 方便 Vitest 測試,不用 import supabase client)。
 * 選項 = 商家目前上架中的付款方式,再加上「這筆訂單編輯前本來就選的那一筆」(即使它現在已經
 * 下架)——理由跟後端 private.validate_booking_selection 的放行邏輯一致,前後端要一致,不能
 * 前端讓你選、後端卻擋下。顯示文字用「快照文字」,不是重新查詢這個付款方式目前叫什麼名字——
 * 商家可能已經改名,快照文字才是這筆訂單當初實際顯示過的內容。 */
export function buildPaymentMethodOptions(
  activeMethods: PaymentMethodOption[],
  editingCurrentId: string | null | undefined,
  editingNameSnapshot: string | null | undefined,
): PaymentMethodOption[] {
  if (editingCurrentId && !activeMethods.some((pm) => pm.id === editingCurrentId)) {
    return [
      ...activeMethods,
      {
        id: editingCurrentId,
        name: `${editingNameSnapshot ?? "(已刪除的付款方式)"}(已下架)`,
      },
    ];
  }
  return activeMethods;
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
 * cancelled 這次額外選用既有的灰階 token(muted-foreground),不新增自訂顏色。
 *
 * ⚠️ 這兩支「Tailwind class」版本(bookingBlockClasses/bookingCardAccentBorderClass)保留給
 * 目前唯一還在用它們的呼叫端:src/modules/staff-portal/MyCalendarTimelineView.tsx(服務人員自助
 * 行事曆,模組 14)。建單與訂單管理介面優化 §10.5(SPECS-INDEX #621)明確只要求 CalendarPage.tsx/
 * OrdersPage.tsx 這兩處改成讀 merchant_booking_status_colors 動態顏色表,MyCalendarTimelineView.tsx
 * 不在這次規格範圍內,所以刻意不刪除/不改動這兩支既有函式,下面另外新增一組
 * bookingBlockStyle/bookingCardAccentBorderStyle 給 CalendarPage.tsx/OrdersPage.tsx 改用
 * (詳見下方「§10.5 動態顏色」區塊的說明)。 */
export function bookingCardAccentBorderClass(status: BookingStatus): string {
  if (status === "completed") return "border-l-cta";
  if (status === "pending_confirmation") return "border-l-warn";
  if (status === "cancelled") return "border-l-muted-foreground/40";
  return "border-l-brand"; // accepted(已確認)
}

// ---------------------------------------------------------------------------
// 建單與訂單管理介面優化 §10.5(SPECS-INDEX #621):CalendarPage.tsx(色塊)/OrdersPage.tsx
// (色條)改讀 merchant_booking_status_colors 動態顏色表,取代上面兩支寫死 Tailwind class 的
// 函式。Tailwind class 在建置時就已經固定,無法動態接受任意色碼,所以這裡改用 inline style。
//
// 設計決定(規格書把「視覺呈現方式」的具體做法留給 engineer 判斷,§10.5 只要求「兩處都讀同一張
// 顏色設定表」+「用 inline style 套用」+「不強制對比度自動計算」+「灰階邊框跟動態色條各自獨立
// 設定,不互相覆蓋」):
//   - 訂單管理頁色條(bookingCardAccentBorderStyle):直接把設定表裡的色碼當
//     `borderLeftColor` 使用,不做任何透明度轉換——改版前色條本來就是純色(border-l-{token}),
//     商家沒自訂過顏色時套用量測後的真實色碼,肉眼跟改版前完全一致(§10.5 回歸測試要求)。
//   - 行事曆色塊(bookingBlockStyle):改版前是「淺色背景+同色系文字」的柔和配色(例如
//     bg-cta-soft text-cta),不是純色實心背景。單一色碼無法同時重現「背景」跟「文字」兩種
//     語意不同的顏色,這裡統一規則:背景 = 設定色碼疊加 16% 透明度(近似原本柔和背景的視覺
//     效果)、文字/邊框 = 設定色碼本身(飽和度足夠,在淺色背景上維持可讀)。四種狀態(含商家
//     自訂的任意顏色)套用同一條規則,不再需要像改版前那樣每種狀態各自手動挑一組「背景 token +
//     文字 token」的搭配。
// ---------------------------------------------------------------------------

/** 建單與訂單管理介面優化 §10.1/§10.5:商家目前設定的 4 種訂單狀態代表色。
 * 查無資料(還沒特別設定過)時,呼叫端(useMerchantBookingStatusColors,見 context.tsx)一律
 * fallback 成 DEFAULT_BOOKING_STATUS_COLORS,不回傳 undefined 欄位。 */
export interface BookingStatusColorMap {
  pendingConfirmation: string;
  accepted: string;
  completed: string;
  cancelled: string;
}

/** §10.1:查無資料時的預設值,跟資料庫 migration(20260922160200_req620_...)的 DEFAULT 值
 * 逐字一致——都是實際量測 src/styles.css 的 warn/brand/cta/muted-foreground 四個 design token
 * 換算出來的真實色碼,不是估算值。前端/後端各自維護一份常數字面值是刻意的(呼應第五節「對外
 * 介面」模組獨立性原則:前端不應該為了取得一組預設色碼而多發一支 RPC 查詢),兩邊的值必須保持
 * 一致,之後如果要調整預設色碼,兩邊都要一起改(pgTAP/Vitest 測試都各自驗證了各自檔案裡的值,
 * 沒有一支測試同時比對兩邊,這是已知的維護風險,已在回報中提出)。 */
export const DEFAULT_BOOKING_STATUS_COLORS: BookingStatusColorMap = {
  pendingConfirmation: "#ebaa2d",
  accepted: "#1c6fd2",
  completed: "#1ea25d",
  cancelled: "#606d7f",
};

/** 依狀態值從顏色表挑出對應色碼。pending_reply/dispatching 這兩種狀態這次的顏色表沒有涵蓋
 * (跟 bookingBlockClasses 舊版一致的既有 fallback 行為),沿用 accepted 的顏色。 */
export function getBookingStatusColor(
  colors: BookingStatusColorMap,
  status: BookingStatus,
): string {
  if (status === "completed") return colors.completed;
  if (status === "pending_confirmation") return colors.pendingConfirmation;
  if (status === "cancelled") return colors.cancelled;
  return colors.accepted;
}

/** 把 6 碼 hex 色碼轉成指定透明度的 rgba() 字串,供行事曆色塊的柔和背景使用。
 * 商家這次允許輸入任意合法 CSS color 字串(§10.1 不做嚴格 hex CHECK 約束),不是合法 6 碼 hex
 * 時(例如輸入 `rgb(...)`/CSS 顏色名稱)無法安全計算透明度,直接原樣回傳當背景色使用——
 * 退化成實心背景,不會噴錯,只是視覺上少了柔和透明的效果(邊界情況,不阻擋操作)。 */
export function hexToRgba(hex: string, alpha: number): string {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!match) return hex;
  const r = parseInt(match[1]!, 16);
  const g = parseInt(match[2]!, 16);
  const b = parseInt(match[3]!, 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 建單與訂單管理介面優化 §10.5:CalendarPage.tsx 排程色塊改用的 inline style。 */
export function bookingBlockStyle(
  colors: BookingStatusColorMap,
  status: BookingStatus,
): { backgroundColor: string; color: string; borderColor: string } {
  const color = getBookingStatusColor(colors, status);
  return {
    backgroundColor: hexToRgba(color, 0.16),
    color,
    borderColor: hexToRgba(color, 0.5),
  };
}

/** 建單與訂單管理介面優化 §10.5:OrdersPage.tsx 訂單卡片左側色條改用的 inline style。
 * 只設定 borderLeftColor 這一個屬性,跟灰階的上/右邊框(className 裡的 border-y border-r
 * border-border)各自獨立設定,不會互相覆蓋(§10.5 第 3 點)。 */
export function bookingCardAccentBorderStyle(
  colors: BookingStatusColorMap,
  status: BookingStatus,
): { borderLeftColor: string } {
  return { borderLeftColor: getBookingStatusColor(colors, status) };
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

/** 模組 7(排班與休假管理)§3.7:這位服務人員這一天是否整天請假。查無資料時是 null。
 * leave_type_name 是建立請假紀錄當下的假別名稱快照,不是即時查詢的目前名稱(假別事後改名/
 * 下架不影響這裡顯示的文字,比照模組 9 §234 付款方式名稱快照的既有教訓)。 */
export interface DayScheduleOnLeave {
  leave_record_id: string;
  leave_type_name: string;
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
  /** 模組 7 §3.7(新增):不是 null 時代表這位服務人員這一天整天請假,規則 2.7(主腦裁示版本)
   * 不論 unlimited_backend_edit 是否開啟一律擋下建單,前端(4.5)整欄改成灰底顯示、不可點擊建單,
   * 沒有覆寫例外(取代規格書原文「unlimited_backend_edit=true 時仍可透過覆寫」的設計)。 */
  on_leave: DayScheduleOnLeave | null;
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

/** 模組 6 §9.1(SPECS-INDEX #597):操作記錄清單裡的一筆紀錄,由 getBookingStatusChangeLogs
 * 回傳。fromStatus 為 null 代表「建立」這個動作本身。status 型別刻意沿用 BookingStatus | null
 * (不是任意 string),因為後端 CHECK 約束/寫入路徑只會產生這個狀態機裡的合法值。 */
export interface BookingStatusChangeLog {
  id: string;
  fromStatus: BookingStatus | null;
  toStatus: BookingStatus;
  actorNameSnapshot: string;
  actorRoleSnapshot: "merchant_admin" | "agent" | "staff" | "system";
  createdAt: string;
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
