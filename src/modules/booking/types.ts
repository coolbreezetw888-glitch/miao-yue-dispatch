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

/** SPECS-INDEX #598(訂單管理.md §9.2):建單表單服務項目分類篩選下拉選單的值——'all' 顯示全部
 * (預設,等同目前既有行為)、'uncategorized' 只顯示 category_id 為 null 的項目(§4.1 邊界情況既有
 * 的「未分類」虛擬分類),其餘值是實際的 service_categories.id。從 CalendarPage.tsx 抽出成純函式,
 * 方便 Vitest 測試,不用 import supabase client。篩選只影響「顯示哪些選項讓你勾」,不影響「已經
 * 勾了哪些」(已勾選項目切換篩選後不會被清除,呼叫端維持獨立的勾選狀態,不受這支函式回傳結果限制)。 */
export type ServiceItemCategoryFilter = "all" | "uncategorized" | (string & {});

export function filterServiceItemsByCategory<T extends { category_id: string | null }>(
  items: T[],
  filter: ServiceItemCategoryFilter,
): T[] {
  if (filter === "all") return items;
  if (filter === "uncategorized") return items.filter((item) => item.category_id === null);
  return items.filter((item) => item.category_id === filter);
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
    ? "依商家設定稅率百分比，數字可個別調整。"
    : "依商家設定稅額，金額可個別調整。";
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

/**
 * ui-overlay-patterns skill 二之四:訂單狀態 → 狀態標籤色調(StatusTag 的 tone)。
 * 正常 = 綠系 / 要處理 = 黃系 / 結束或停用 = 灰系 / 出事 = 紅系。
 * 集中在這裡是為了讓預約詳情、訂單管理、行事曆、服務人員端的同一個狀態永遠同一個顏色。
 */
export function bookingStatusTone(
  status: BookingStatus,
): "success" | "warning" | "neutral" | "danger" {
  switch (status) {
    case "accepted":
      return "success";
    case "pending_reply":
    case "pending_confirmation":
    case "dispatching":
      return "warning";
    case "completed":
      return "neutral";
    case "cancelled":
      return "danger";
  }
}

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
 * 🔴 2026-09-30(SPECS-INDEX #860):這兩支「Tailwind class」版本**已經沒有任何呼叫端了**。
 * 最後一個呼叫端是 src/modules/staff-portal/MyCalendarTimelineView.tsx(服務人員自助行事曆,
 * 模組 14),它原本用 bookingBlockClasses 寫死顏色,導致商家在「訂單狀態顏色設定」改的顏色
 * 完全不會反映到服務人員的手機上(當初寫死的原因是服務人員讀不到 merchant_booking_status_colors
 * 那張表;#860 已用 SECURITY DEFINER 的 get_my_booking_status_colors 解掉),現在它跟商家端
 * CalendarPage.tsx 一樣用下面的 bookingBlockStyle。
 * ⚠️ 所以**不要再拿這兩支來寫新畫面** —— 新畫面一律用下面那組讀商家自訂顏色的
 * bookingBlockStyle / bookingCardAccentBorderStyle。這兩支刻意先留著不刪(刪除不在 #860 的
 * 範圍內,已在回報中向主腦提出當作後續清理的候選),但它們的顏色是寫死的,用了就會再製造一次
 * 「兩端顏色不一致」。 */
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

/** 訂單卡片 hover 外框顏色:原本 hover 邊框是寫死的商家主題色(border-brand/40),使用者要求
 * 改成跟著這筆訂單的狀態色走,跟左側色條同一個狀態色碼,套用跟 bookingBlockStyle.borderColor
 * 一致的 0.5 透明度(維持既有「邊框比實色淡一點」的視覺慣例)。 */
export function bookingCardHoverBorderColor(
  colors: BookingStatusColorMap,
  status: BookingStatus,
): string {
  return hexToRgba(getBookingStatusColor(colors, status), 0.5);
}

// ---------------------------------------------------------------------------
// SPECS-INDEX #644:行事曆排程狀態顏色設定(全天休假/時段排休/跨店佔用)。跟上面§10.5的
// 「訂單狀態顏色」(BookingStatusColorMap)是平行但完全獨立的新功能——這次對應的是行事曆本身的
// 排程狀態,不是訂單狀態,資料表(merchant_calendar_state_styles)也是完全獨立的一張表。
// CalendarPage.tsx(商家/客服端)/MyCalendarTimelineView.tsx(服務人員自助端)都讀這裡的純函式,
// 兩邊套用同一套「顏色 + 固定圖樣」渲染規則,不各自維護一份。
// ---------------------------------------------------------------------------

/** 有固定圖樣(斜線 / 交叉網格)的三種排程狀態(#644)。 */
export type CalendarPatternStateType = "full_day_leave" | "partial_leave" | "cross_store_occupied";

/** 對應資料表 merchant_calendar_state_styles.state_type 的五個枚舉值。
 * SPECS-INDEX #1021 第 21 批新增第 4 種 staff_available_slot(服務人員每週可預約時段的空格子底色,純色、無圖樣)。
 * SPECS-INDEX #1049 新增第 5 種 outside_business_hours(營業時間外的格子,深色、純色無圖樣)。 */
export type CalendarSolidStateType = "staff_available_slot" | "outside_business_hours";
export type CalendarStateType = CalendarPatternStateType | CalendarSolidStateType;

/** #1050:每種狀態的透明度(百分比 10~100,100 = 跟改版前一模一樣)。key 跟 CalendarStateStyleMap 的顏色欄位一一對應。 */
export interface CalendarStateOpacityMap {
  fullDayLeave: number;
  partialLeave: number;
  crossStoreOccupied: number;
  staffAvailableSlot: number;
  outsideBusinessHours: number;
}

/** 商家目前設定的 5 種行事曆排程狀態代表色 + 透明度。查無資料(還沒特別設定過)時,呼叫端一律 fallback
 * 成 DEFAULT_CALENDAR_STATE_STYLES,不回傳 undefined 欄位。 */
export interface CalendarStateStyleMap {
  fullDayLeave: string;
  partialLeave: string;
  crossStoreOccupied: string;
  /** #1021:服務人員每週可預約時段內、可預約的空格子底色(純色)。 */
  staffAvailableSlot: string;
  /** #1049:營業時間外的格子底色(純色,預設深灰藍)。 */
  outsideBusinessHours: string;
  /** #1050:各狀態透明度。 */
  opacity: CalendarStateOpacityMap;
}

/** 顏色欄位的 key(不含 opacity),設定頁、讀取函式共用。 */
export type CalendarStateColorKey = keyof CalendarStateOpacityMap;

/** 資料表 state_type ⇄ 前端 key 對照(讀取 / 儲存共用,不各寫一份)。 */
export const CALENDAR_STATE_TYPE_TO_KEY: Readonly<
  Record<CalendarStateType, CalendarStateColorKey>
> = {
  full_day_leave: "fullDayLeave",
  partial_leave: "partialLeave",
  cross_store_occupied: "crossStoreOccupied",
  staff_available_slot: "staffAvailableSlot",
  outside_business_hours: "outsideBusinessHours",
};

/** #1050:透明度合法範圍(跟資料庫 CHECK 一致)。 */
export const CALENDAR_STATE_OPACITY_MIN = 10;
export const CALENDAR_STATE_OPACITY_MAX = 100;

/** 把任意輸入整理成合法透明度:不是有限數字 ⇒ 100;超出範圍夾到 10~100;四捨五入成整數。 */
export function normalizeCalendarStateOpacity(input: unknown): number {
  const n = typeof input === "number" ? input : typeof input === "string" ? Number(input) : NaN;
  if (!Number.isFinite(n)) return CALENDAR_STATE_OPACITY_MAX;
  return Math.min(CALENDAR_STATE_OPACITY_MAX, Math.max(CALENDAR_STATE_OPACITY_MIN, Math.round(n)));
}

/** #1050:透明度乘在既有 alpha 上(例:0.12 × 50% = 0.06)。100% 時原值原樣回傳(逐像素跟改版前相同)。 */
export function scaleCalendarAlpha(alpha: number, opacity: number): number {
  const o = normalizeCalendarStateOpacity(opacity);
  if (o === CALENDAR_STATE_OPACITY_MAX) return alpha;
  return Math.round(alpha * o * 100) / 10000;
}

/** 查無資料時的預設值,跟資料庫 seed 函式(20260923020100_req644_...)的預設色碼逐字一致。
 * 刻意跟 DEFAULT_BOOKING_STATUS_COLORS 的既有 4 色區隔開(暖灰色系 + 深赭橘,不是冷灰藍/淺黃橘),
 * 避免兩套獨立的顏色設定在同一張行事曆上撞色造成混淆。 */
export const DEFAULT_CALENDAR_STATE_STYLES: CalendarStateStyleMap = {
  fullDayLeave: "#78716c",
  partialLeave: "#a8a29e",
  crossStoreOccupied: "#c2410c",
  // #1021 第 21 批:淡綠(tailwind green-100)。跟填色預約卡片(實色)、時段外灰格、特別開放的淡紫底紫框、
  // 斜線 / 網格圖樣都分得開;跟資料庫 seed_default_merchant_calendar_state_styles 逐字一致。
  staffAvailableSlot: "#dcfce7",
  // #1049:深灰藍(tailwind slate-700),跟資料庫 seed 逐字一致。理由見 migration 20261010210000_req1049_1050_*。
  outsideBusinessHours: "#334155",
  opacity: {
    fullDayLeave: 100,
    partialLeave: 100,
    crossStoreOccupied: 100,
    staffAvailableSlot: 100,
    outsideBusinessHours: 100,
  },
};

/**
 * 把資料庫一列一狀態(state_type, color, opacity)轉成 CalendarStateStyleMap。
 * 商家端直接讀表、服務人員端 get_my_calendar_state_styles 都走這一支(#1049 / #1050),缺的狀態 / 透明度一律用預設值。
 * 不認得的 state_type 直接略過。
 */
export function buildCalendarStateStyleMap(
  rows: readonly { state_type: string; color: string | null | undefined; opacity?: unknown }[],
): CalendarStateStyleMap {
  const result: CalendarStateStyleMap = {
    ...DEFAULT_CALENDAR_STATE_STYLES,
    opacity: { ...DEFAULT_CALENDAR_STATE_STYLES.opacity },
  };
  for (const row of rows) {
    const key = (CALENDAR_STATE_TYPE_TO_KEY as Record<string, CalendarStateColorKey | undefined>)[
      row.state_type
    ];
    if (!key) continue;
    if (typeof row.color === "string") result[key] = row.color;
    if (row.opacity !== undefined && row.opacity !== null) {
      result.opacity[key] = normalizeCalendarStateOpacity(row.opacity);
    }
  }
  return result;
}

/** #1050:依狀態拿透明度(舊資料 / 缺欄位 ⇒ 100)。 */
export function getCalendarStateOpacity(
  colors: CalendarStateStyleMap,
  state: CalendarStateType,
): number {
  return normalizeCalendarStateOpacity(colors.opacity?.[CALENDAR_STATE_TYPE_TO_KEY[state]]);
}

/** 依狀態值從顏色表挑出對應色碼。 */
export function getCalendarStateColor(
  colors: CalendarStateStyleMap,
  state: CalendarStateType,
): string {
  if (state === "full_day_leave") return colors.fullDayLeave;
  if (state === "partial_leave") return colors.partialLeave;
  if (state === "staff_available_slot") return colors.staffAvailableSlot;
  if (state === "outside_business_hours") return colors.outsideBusinessHours;
  return colors.crossStoreOccupied;
}

/** 三種狀態各自固定搭配的圖樣(不是純色塊,肉眼要能一眼分辨是哪一種狀態,不能只靠顏色):
 * 全天休假 = 密集 45 度斜線、時段排休 = 稀疏 45 度斜線(比全天休假稀疏,視覺上比較「輕」)、
 * 跨店佔用 = 交叉網格紋(45 度 + 135 度疊加,跟斜線類明顯不同,一眼就能分辨是「別的原因」造成
 * 的占用,不是休假)。純 CSS repeating-linear-gradient 做,不需要圖片資源。商家允許輸入任意合法
 * CSS color 字串(不強制 hex),hexToRgba 對非 hex 字串會原樣回傳(退化成不透明實色,不會噴錯),
 * 這裡沿用同一個既有函式,不另外重寫一套顏色格式判斷。 */
export function calendarStateBlockStyle(
  colors: CalendarStateStyleMap,
  state: CalendarPatternStateType,
): { backgroundColor: string; backgroundImage: string; borderColor: string; color: string } {
  const color = getCalendarStateColor(colors, state);
  // #1050:透明度乘在既有 alpha 上;文字色(color)不跟著變淡。100% 時三個值跟改版前逐字相同。
  const opacity = getCalendarStateOpacity(colors, state);
  const line = hexToRgba(color, scaleCalendarAlpha(0.55, opacity));
  const base = hexToRgba(color, scaleCalendarAlpha(0.12, opacity));
  const borderColor = hexToRgba(color, scaleCalendarAlpha(0.55, opacity));

  if (state === "cross_store_occupied") {
    return {
      backgroundColor: base,
      backgroundImage:
        `repeating-linear-gradient(45deg, ${line} 0px, ${line} 2px, transparent 2px, transparent 9px), ` +
        `repeating-linear-gradient(135deg, ${line} 0px, ${line} 2px, transparent 2px, transparent 9px)`,
      borderColor,
      color,
    };
  }

  // 全天休假:斜線間距 6px(密集)。時段排休:斜線間距 12px(稀疏,視覺上比較「輕」)。
  const period = state === "full_day_leave" ? 6 : 12;
  return {
    backgroundColor: base,
    backgroundImage: `repeating-linear-gradient(45deg, ${line} 0px, ${line} 2px, transparent 2px, transparent ${period}px)`,
    borderColor,
    color,
  };
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
  /** SPECS-INDEX #977 第 3 批(2026-10-06):改前這裡是 no_time_slot_limit。後台行事曆的可約時段放寬改看
   * 「商家後台編輯無時段限制」(true ⇒ available_windows = 整段營業時間);no_time_slot_limit 只留給客戶線上預約。
   * 行事曆畫面沒有直接讀這個值(只讀 available_windows),保留欄位方便除錯對照。 */
  unlimited_backend_edit: boolean;
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
  /** 客戶端第 3 批(C3-A01):客人自己線上送出的單,建立那一列是 customer(姓名快照「客人 王小明」/「訪客 王小明」)。 */
  actorRoleSnapshot: "merchant_admin" | "agent" | "staff" | "system" | "customer";
  createdAt: string;
  /** #844 §2.2/§4.6:操作備註。「還原完成」「取消已完成訂單」會帶管理員填的原因(只有原因,
   * 不含點數/餘額);其他轉換為 null。 */
  note: string | null;
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
  /** 第 11 批 F #993:數量(既有資料 = 1)。 */
  quantity: number;
  /** 第 11 批 F #993 起語意是「單價」快照;小計 = amountSnapshot × quantity。 */
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

// ---------------------------------------------------------------------------
// #844 已完成訂單取消/還原(規格書 .project/specs/已完成訂單取消與還原.md §4.2~§4.5)。
// 鍵名照 migration 20261001090100_req844_completion_reversal_functions.sql 原文。
// ⚠️ 預覽與執行結果含會員 / 推薦人的姓名與餘額 —— 只有商家管理員拿得到(後端 42501 擋)。
// ---------------------------------------------------------------------------

/** 兩個入口:還原完成(completed → accepted)/ 取消已完成訂單(completed → cancelled)。 */
export type CompletedBookingReversalAction = "revert" | "cancel";

export interface ReversalCodeMessage {
  code: string;
  /** 後端已寫成白話,前端原樣顯示(純文字)。 */
  message: string;
}

export interface CompletedBookingReversalPreviewMember {
  member_id: string;
  name: string;
  status: string;
  balance: number;
  due_expected: number;
  frozen_refund_expected: number;
  shortfall_if_revert: number;
  shortfall_if_cancel: number;
}

export interface CompletedBookingReversalPreviewReferral {
  referrer_member_id: string;
  referrer_name: string | null;
  referrer_balance: number | null;
  due_expected: number;
  shortfall_expected: number;
  shortfall_if_revert: number;
  shortfall_if_cancel: number;
}

/** public.get_completed_booking_reversal_preview 回傳(§4.2)。 */
export interface CompletedBookingReversalPreview {
  booking_id: string;
  status: string;
  source: string;
  can_revert: boolean;
  can_cancel: boolean;
  blocked_reasons: ReversalCodeMessage[];
  staff: { id: string; name: string; status: string; compensation_type_now: string } | null;
  commission: {
    exists: boolean;
    amount: number | string;
    recalculated: boolean;
    computed_at: string | null;
  };
  completed_at: string;
  /** 'YYYY-MM'(台北時區)。 */
  report_month: string;
  is_cross_month: boolean;
  months_ago: number;
  revenue_amount: number | string;
  member: { id: string; name: string; status: string; balance: number } | null;
  /** 本單從來沒有任何點數交易時為 null。 */
  points: {
    members: CompletedBookingReversalPreviewMember[];
    points_due_expected: number;
    frozen_points: number;
    referral: CompletedBookingReversalPreviewReferral | null;
  } | null;
  warnings: ReversalCodeMessage[];
}

/** revert_completed_booking / cancel_completed_booking 回傳(§4.1;**沒有頂層 status**,狀態在 booking 裡)。 */
export interface CompletedBookingReversalResult {
  booking: Booking;
  action: "revert_to_accepted" | "cancel_completed";
  commission_amount_reversed: number | string;
  report_month: string;
  is_cross_month: boolean;
  points: {
    points_due: number;
    points_recovered: number;
    points_shortfall: number;
    referral_due: number;
    referral_recovered: number;
    referral_shortfall: number;
    referrer_member_id: string | null;
    /** 有差額才有值;純文字顯示,不解析連結(v1.2:裡面沒有訂單 ID)。 */
    shortfall_hint: string | null;
    frozen_points_refunded: number;
  };
}
