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

/** 5.1 對外介面:目前使用者在某間商家的角色。
 * 模組 14(服務人員端)規格書規則 2.10 擴充新增 'staff' 這個值——判斷順序:admin > agent > staff,
 * 同一人身兼多重角色時一律顯示較高權限角色對應的完整既有介面,不會被限縮成服務人員視角。 */
export type MerchantRole = "admin" | "agent" | "staff" | null;

/** 模組 14(服務人員端)規格書 1.1/規則 2.1:服務人員登入身份進度,跟 StaffStatus(是否仍是
 * 有效服務人員名錄項目)完全脫鉤獨立記錄,兩者互不影響。 */
export type StaffLoginStatus = "not_invited" | "invited" | "active";

export const STAFF_LOGIN_STATUS_LABELS: Record<StaffLoginStatus, string> = {
  not_invited: "尚未開通",
  invited: "邀請信已寄出",
  active: "已開通登入",
};

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
    key: "staff_management",
    label: "服務人員管理",
    // 2026-09-24:補上兩件原本沒寫進來的事實——(1)服務人員個別的每週可預約時段是在這頁的編輯
    // 畫面設定的,歸這把鑰匙,不是歸「營業時間設定」(那條的舊描述誤植了,已一併修正);
    // (2)除了「真正刪除」,「邀請服務人員登入」「指派服務人員權限」也同樣永遠只給商家管理員
    // (見 StaffListPage.tsx 2026-09-23 使用者決策那段註解與各自的 isAdmin 判斷)。
    description:
      "開放後客服可以新增/編輯/軟刪除服務人員、指派可承接的服務項目,以及設定服務人員個別的每週可預約時段(對應模組 3)。注意:「真正刪除」(硬刪除已移除的服務人員)、「邀請服務人員登入」、「指派服務人員權限」這三個帳號/敏感操作永遠只有商家管理員能做,不受這個開關影響。",
  },
  {
    key: "service_items",
    label: "服務項目管理",
    description:
      "開放後客服可以新增/編輯/上下架服務項目與服務分類(對應模組 4 規則 2.5,這個開關同時涵蓋服務項目跟服務分類兩者)。",
  },
  {
    key: "orders",
    label: "訂單管理",
    description: "開放後客服可以在行事曆建立新預約、取消預約、把預約標記為完成。",
  },
  {
    key: "billing",
    label: "帳務管理",
    description:
      "開放後客服可以查看店家端帳務報表(對應模組 8 薪資與帳務)。這把鑰匙也「連帶」讓客服可以查看師傅報表(師傅報表檢查的權限範圍比較寬,billing 或 staff_report 任一即可),但反過來不成立——只開 staff_report 不能看帳務報表。",
  },
  {
    key: "team_leave",
    label: "團隊休假",
    description:
      "開放後客服可以新增/編輯/下架商家自訂的假別清單,以及登記/取消月薪制服務人員的請假紀錄(對應模組 7 排班與休假管理)。「建單時因為服務人員請假被擋下」不需要這個權限,那是「訂單管理」的範圍。",
  },
  {
    key: "members",
    label: "會員管理",
    description:
      "開放後客服可以新增/編輯/下架會員資料、標記電話已驗證、查看點數異動歷史、登記兌換點數(對應模組 10 會員與紅利)。注意:手動調整會員點數這個敏感操作永遠只有商家管理員能做,不受這個開關影響。建單時選擇/快速建立會員不需要這個權限,只要有「訂單管理」權限即可。",
  },
  {
    key: "staff_report",
    label: "師傅報表",
    description:
      "開放後客服可以查看個別服務人員的抽成/薪資報表(對應模組 8 薪資與帳務)。注意:重新計算已完成訂單抽成金額這個敏感操作永遠只有商家管理員能做,不受這個開關影響。",
  },
  {
    key: "scheduling",
    label: "排班一覽",
    description:
      "開放後客服可以檢視跨服務人員的每週時段/單日例外/請假彙整總覽頁(對應模組 7 排班與休假管理),是純唯讀檢視權限,跟「團隊休假」(有寫入行為)是兩把獨立的鑰匙。",
  },
  {
    key: "business_hours",
    label: "營業時間設定",
    // 2026-09-24:原本這條寫的「服務人員個別可預約時段」其實不歸這把鑰匙——那是在服務人員編輯
    // 畫面(StaffListPage.tsx,整頁走 RequireStaffManagementAccess)裡設定的,屬於
    // staff_management。反過來,行事曆上的「開啟/關閉時段」(單日例外)確實歸這把鑰匙
    // (見 CalendarPage.tsx canManageDayOverride),原本卻沒寫進來。兩邊都照實修正。
    description:
      "開放後客服可以調整商家整體每週營業時間、嚴格工時衝突檢查開關,以及在行事曆上開啟/關閉個別日期的時段(單日例外)。注意:「服務人員個別可預約時段」不在這把鑰匙的範圍內,那是在服務人員編輯畫面裡設定的,屬於「服務人員管理」那把鑰匙。",
  },
  {
    key: "commission_settings",
    label: "抽成設定",
    description:
      "開放後客服可以調整商家抽成基準/預設比例、月折算天數、按件計酬服務人員個人抽成比例覆寫、月薪制服務人員薪資設定、假別扣款規則(對應模組 8 薪資與帳務)。注意:重新計算已完成訂單抽成金額這個敏感操作永遠只有商家管理員能做,不受這個開關影響。",
  },
  {
    key: "line_notification",
    label: "LINE 通知設定",
    description:
      "開放後客服可以調整每類事件要不要通知、通知誰、文案內容,以及查看發送記錄(對應模組 11 LINE 通知)。",
  },
  {
    key: "push_notification",
    label: "推播通知設定",
    description:
      "開放後客服可以設定服務人員手機/瀏覽器推播要不要開、文案內容(對應模組 15 服務人員推播通知)。",
  },
  {
    key: "payment_methods",
    label: "支付方式設定",
    description:
      "開放後客服可以新增/編輯/下架商家自訂的付款方式清單,也可以設定稅金設定(商家端三項調整規格書 §一 1.2/1.3,原本歸在「營業時間設定」底下,這次搬過來)。建單/編輯時選擇既有付款方式不需要這個權限,只要有「訂單管理」權限即可。",
  },
  {
    key: "report_export",
    label: "下載報表",
    description:
      "開放後客服可以打開報表匯出中心(對應模組 12 資料匯入與報表匯出)。這個開關只控制「能不能打開這個畫面、按下匯出按鈕」，實際能匯出到什麼資料範圍，完全由訂單/會員/抽成/請假各自來源模組的既有權限決定，不會讓客服多看到原本看不到的資料。",
  },
  {
    key: "member_settings",
    label: "會員系統設定",
    // 2026-09-24:原本這條列的「電話驗證政策、消費點數比例、推薦獎勵點數、生日贈點」四項現在
    // 全都不在會員系統設定頁了(電話驗證政策 #618 整個移除;點數三個欄位 #642 搬去紅利點數管理;
    // 核發獎勵資格條件 2026-09-24 也搬去紅利點數管理),照這把鑰匙目前實際開放的範圍改寫。
    description:
      "開放後客服可以調整會員系統設定頁的兩個區塊:會員政策(啟用開關與政策內容)、會員等級清單(新增/編輯/下架/重新上架)(對應模組 10 會員與紅利)。注意:紅利點數相關設定(啟用開關、核發獎勵資格條件、消費點數比例、推薦獎勵、生日贈點)已經全部集中到「紅利點數管理」頁,那一頁走的是「會員管理」這把鑰匙,不在這把鑰匙的範圍內。",
  },
  {
    key: "material_costs",
    label: "料錢成本管理",
    description:
      "開放後客服可以新增/編輯/下架料錢成本品項清單(對應建單功能擴充規格書 2.3 決策記錄 4),也可以設定料錢成本功能開關(商家端三項調整規格書 §一 1.2/1.3,原本歸在「營業時間設定」底下,這次搬過來)。建單/編輯時勾選既有品項不需要這個權限,只要有「訂單管理」權限即可。",
  },
];
