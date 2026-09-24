// 模組 14:服務人員端 — 型別定義。
// 對應規格書第一節 1.2(merchant_staff_permissions)、名詞對照。其他模組若需要用到服務人員自助
// 權限相關型別,一律從這個檔案或 context.tsx/api.ts 匯出的內容取得,不要直接
// import Supabase 產生的 Tables<'merchant_staff_permissions'> 型別(呼應規格書第五節「對外介面」
// 的模組獨立性設計)。

import type { Tables } from "@/integrations/supabase/types";

export type MerchantStaffPermission = Tables<"merchant_staff_permissions">;

/** 名詞對照:服務人員自助功能權限的四個 section_key(規格書 1.2)。 */
export type StaffPermissionSectionKey =
  | "staff_calendar_view"
  | "staff_availability_self_manage"
  | "staff_payroll_view"
  | "staff_profile_edit";

export interface StaffPermissionSectionDef {
  key: StaffPermissionSectionKey;
  label: string;
  description: string;
}

export const STAFF_PERMISSION_SECTIONS: StaffPermissionSectionDef[] = [
  {
    key: "staff_calendar_view",
    label: "行事曆檢視",
    description: "開放後這位服務人員登入後可以查看自己的行事曆/預約排程(含以助手身份參與的預約)。",
  },
  {
    key: "staff_availability_self_manage",
    label: "可預約時段/休假自助調整",
    description:
      "開放後這位服務人員可以自己設定每週固定可預約時段、標記單日臨時休假。僅按件計酬服務人員可以使用,月薪制服務人員即使開通這項也不會生效。",
  },
  {
    key: "staff_payroll_view",
    label: "抽成/薪資報表檢視",
    description: "開放後這位服務人員可以查詢自己某個月的抽成明細或薪資扣款明細。",
  },
  {
    key: "staff_profile_edit",
    label: "個人資料編輯",
    description: "開放後這位服務人員可以自己修改姓名/暱稱/電話/頭像/簡介。",
  },
];
