// 模組 5:行事曆與預約核心引擎 — 型別定義
// 對應規格書第一節資料表。其他模組若需要用到營業時間/可預約時段/預約相關型別,一律從這個檔案或
// context.tsx 匯出的 hooks 取得,不要直接 import Supabase 產生的 Tables<'bookings'> 等型別
// (呼應規格書第五節「對外介面」的模組獨立性設計)。

import type { Tables } from "@/integrations/supabase/types";

export type MerchantBusinessHours = Tables<"merchant_business_hours">;
export type StaffAvailabilityWindow = Tables<"staff_availability_windows">;
export type Booking = Tables<"bookings">;
export type BookingServiceItem = Tables<"booking_service_items">;
export type BookingAssistant = Tables<"booking_assistants">;
export type MaterialCostItem = Tables<"material_cost_items">;
export type BookingMaterialCost = Tables<"booking_material_costs">;

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

/** 0=星期日...6=星期六,對應 merchant_business_hours.day_of_week /
 * staff_availability_windows.day_of_week 跟 Postgres extract(dow from ...) 的回傳值。 */
export const DAY_OF_WEEK_LABELS = ["日", "一", "二", "三", "四", "五", "六"] as const;

export interface DayScheduleAvailableWindow {
  start_time: string;
  end_time: string;
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

/** 建單表單細節修正規格書第五節:預約詳情用的服務項目,比 DayScheduleServiceItemRef 多一個
 * price 欄位。**這是查詢當下 service_items.price 的即時值,不是建立/編輯當下鎖定的金額快照**
 * ——之後服務項目改價,舊預約顯示的金額會跟著變動,不是像 booking_service_items 的
 * duration_minutes_snapshot 那樣寫死。金額快照策略明確保留給未來模組 6(訂單管理)通盤設計,
 * 這裡刻意不做,避免變成之後模組 6 的絆腳石或要推翻重做。
 * price 是 null 代表這個服務項目已經下架/被刪除,查不到目前的價格(fallback 顯示「—」,
 * 不要顯示 0,那看起來像「免費」,會誤導使用者)。 */
export interface BookingDetailServiceItem extends DayScheduleServiceItemRef {
  price: number | null;
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
