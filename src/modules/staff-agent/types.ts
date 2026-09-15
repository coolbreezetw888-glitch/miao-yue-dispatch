// 模組 3:人員與權限管理 — 型別定義
// 對應規格書第一節資料表。其他模組若需要用到服務人員/客服相關型別,一律從這個檔案或
// context.tsx 匯出的 hooks 取得,不要直接 import Supabase 產生的 Tables<'merchant_staff'> 等型別
// (呼應規格書第五節「對外介面」的模組獨立性設計)。

import type { Tables } from "@/integrations/supabase/types";

export type MerchantStaff = Tables<"merchant_staff">;
export type MerchantAgent = Tables<"merchant_agents">;
export type MerchantAgentPermission = Tables<"merchant_agent_permissions">;

export type StaffStatus = "active" | "removed";
export type AgentStatus = "invited" | "active" | "removed";

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  invited: "邀請信已寄出",
  active: "已啟用",
  removed: "已移除",
};

/** 5.1 對外介面:目前使用者在某間商家的角色。 */
export type MerchantRole = "admin" | "agent" | null;

/** 1.1.1 權限功能開關欄位,對應規格表「服務人員-權限功能」逐條(白話文字給 4.2 畫面使用)。 */
export interface StaffPermissionFieldDef {
  key: keyof Pick<
    MerchantStaff,
    | "advance_booking_days"
    | "booking_window_min_days"
    | "booking_window_max_days"
    | "no_time_slot_limit"
    | "unlimited_backend_edit"
    | "direct_accept_after_merchant_confirm"
    | "auto_accept_booking"
    | "show_member_info"
    | "google_calendar_sync_enabled"
    | "can_create_edit_orders"
    | "can_upload_construction_photos"
  >;
  label: string;
  description: string;
  type: "boolean" | "number";
}

export const STAFF_BOOLEAN_PERMISSION_FIELDS: StaffPermissionFieldDef[] = [
  {
    key: "no_time_slot_limit",
    label: "無時段限制",
    description: "開啟後,客戶預約這位服務人員時不受時段限制。",
    type: "boolean",
  },
  {
    key: "unlimited_backend_edit",
    label: "後台編輯無限制時段",
    description: "開啟後,商家後台編輯這位服務人員的行程時不受時段限制。",
    type: "boolean",
  },
  {
    key: "direct_accept_after_merchant_confirm",
    label: "商家確認後直接接單",
    description: "開啟後,商家確認訂單後,這位服務人員不需要再次確認即可接單。",
    type: "boolean",
  },
  {
    key: "auto_accept_booking",
    label: "預約自動接受",
    description: "開啟後,客戶預約這位服務人員時系統自動接受,不需要人工確認。",
    type: "boolean",
  },
  {
    key: "show_member_info",
    label: "顯示會員資料",
    description: "開啟後,這位服務人員可以看到預約客戶的會員資料。",
    type: "boolean",
  },
  {
    key: "google_calendar_sync_enabled",
    label: "Google 日曆同步",
    description: "開啟後,這位服務人員的行程會同步到 Google 日曆(實際串接留給之後的模組)。",
    type: "boolean",
  },
  {
    key: "can_create_edit_orders",
    label: "新增編輯訂單",
    description: "開啟後,這位服務人員可以自行新增/編輯訂單。",
    type: "boolean",
  },
  {
    key: "can_upload_construction_photos",
    label: "施工圖片上傳",
    description: "開啟後,這位服務人員可以上傳施工圖片。",
    type: "boolean",
  },
];

export const STAFF_NUMBER_PERMISSION_FIELDS: StaffPermissionFieldDef[] = [
  {
    key: "advance_booking_days",
    label: "提前預約天數",
    description: "客戶最多可以提前幾天預約這位服務人員(留空代表不限制)。",
    type: "number",
  },
  {
    key: "booking_window_min_days",
    label: "預約天數範圍(下限)",
    description: "可預約區間的下限天數(3~180)。",
    type: "number",
  },
  {
    key: "booking_window_max_days",
    label: "預約天數範圍(上限)",
    description: "可預約區間的上限天數(3~180),需大於等於下限。",
    type: "number",
  },
];

/** 1.4 section_key 初稿清單(不做強制白名單,只是前端自動完成/預設勾選項目)。 */
export interface AgentPermissionSectionDef {
  key: string;
  label: string;
  description: string;
}

export const AGENT_PERMISSION_SECTIONS: AgentPermissionSectionDef[] = [
  {
    key: "orders",
    label: "訂單管理",
    description: "開放後客服可以看到並操作訂單列表(此功能尚未開發,先設定值)。",
  },
  {
    key: "billing",
    label: "帳務管理",
    description: "開放後客服可以看到並操作帳務相關資料(此功能尚未開發,先設定值)。",
  },
  {
    key: "team_leave",
    label: "團隊休假",
    description: "開放後客服可以看到並操作團隊休假安排(此功能尚未開發,先設定值)。",
  },
  {
    key: "members",
    label: "會員管理",
    description: "開放後客服可以看到並操作會員資料(此功能尚未開發,先設定值)。",
  },
  {
    key: "staff_report",
    label: "師傅報表",
    description: "開放後客服可以查看師傅相關報表(此功能尚未開發,先設定值)。",
  },
  {
    key: "scheduling",
    label: "排班一覽",
    description: "開放後客服可以查看排班總覽(此功能尚未開發,先設定值)。",
  },
  {
    key: "business_hours",
    label: "營業時間設定",
    description: "開放後客服可以調整營業時間設定(此功能尚未開發,先設定值)。",
  },
  {
    key: "commission_settings",
    label: "抽成設定",
    description: "開放後客服可以調整抽成設定(此功能尚未開發,先設定值)。",
  },
  {
    key: "line_notification",
    label: "LINE 通知設定",
    description: "開放後客服可以調整 LINE 通知設定(此功能尚未開發,先設定值)。",
  },
  {
    key: "payment_methods",
    label: "支付方式設定",
    description: "開放後客服可以調整支付方式設定(此功能尚未開發,先設定值)。",
  },
  {
    key: "report_export",
    label: "下載報表",
    description: "開放後客服可以下載報表(此功能尚未開發,先設定值)。",
  },
  {
    key: "data_import",
    label: "資料匯入",
    description: "開放後客服可以執行資料匯入(此功能尚未開發,先設定值)。",
  },
  {
    key: "member_system",
    label: "會員系統設定",
    description: "開放後客服可以調整會員系統設定(此功能尚未開發,先設定值)。",
  },
  {
    key: "member_bonus",
    label: "會員紅利設定",
    description: "開放後客服可以調整會員紅利設定(此功能尚未開發,先設定值)。",
  },
];
