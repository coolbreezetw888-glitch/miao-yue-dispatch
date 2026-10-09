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
    // 🔴 SPECS-INDEX #882:原本只寫「查看自己的行事曆/預約排程」—— 就「行事曆是誰的」而言沒錯,
    // 但完全沒提到點進單筆預約明細會看到客戶個資。管理員實際撥開關時眼睛看的是開關旁邊這一行,
    // 不是卡片標題下方那段說明(#879 ① 只補了一半),所以這裡一定要自己講清楚。
    // 查證來源:MyBookingDetailDialog.tsx L158-186 顯示 customer_name / customer_phone /
    // customer_address / customer_notes / notes(內部備註),外加這筆的金額。
    // 🔴 SPECS-INDEX #928:上面那一行**列得比實際寬**,其中兩個欄位是「有條件」的,說明文字必須寫出條件:
    //   ① `customer_address` —— 畫面那一行是 `showCustomerAddress && booking.customer_address`,
    //      而 `showCustomerAddress` 由**商家目前的產業**決定(MyCalendarPage.tsx 的
    //      `INDUSTRY_REQUIRES_CUSTOMER_ADDRESS[merchant.industry_type]`:on_site_dispatch=true、
    //      in_store_beauty=false,見 merchant/types.ts L33-37)⇒ **到店服務的商家根本不顯示地址**。
    //      ⚠️ 但 `customer_address` **照樣會被 get_my_booking_schedule 送到服務人員的裝置上**
    //         (只是前端沒渲染)⇒ 就「要不要讓他碰客戶個資」這個判斷來說**寧可講多不講少**,
    //         所以做法是**講清楚條件,不是把地址從說明裡刪掉**。
    //   ② `notes`(內部備註)—— 受 SPECS-INDEX #851 **逐單**控制:
    //      `'notes', case when bb.hide_notes_from_staff then null else bb.notes end`
    //      (20260930010100_req851_*.sql L89)。`customer_notes`(客戶備註)才是一律回傳的。
    //      ⇒ 說明只寫「備註」會讓商家以為 #851 那個逐單開關沒用,必須把兩種備註分開講。
    // 🔴 SPECS-INDEX #883:同一個明細畫面**還會顯示會員資料**(is_member / member_name /
    // member_points_balance),但那三個欄位**不是這一項開放的** —— 它們被
    // `merchant_staff.show_member_info`(標籤「顯示會員資料」,staff-agent/types.ts)這個**獨立開關**
    // 包在 `case when v_show_member_info … else null end` 裡(20260930010100_req851_*.sql L95-103)。
    // ⚠️ 所以**不要**把會員點數加進下面這段說明裡 —— 那會變成「這一項會給點數」的錯誤暗示。
    //    正確做法是像下面那樣指路到「顯示會員資料」那個開關(#883 ②)。
    // 🔴 SPECS-INDEX #876(2026-09-30 使用者裁決 a):關掉這一項之後,這位服務人員也**不會再收到**
    //    訂單推播(含站內鈴鐺)與 LINE 通知 —— 那些通知內容會帶客戶姓名,等於另一條看到客戶的管道。
    //    資料庫端由 private.staff_calendar_view_allows_notifications 守門
    //    (resolve_push_recipients / resolve_line_notification_targets 的服務人員分支)。
    // 🔴 SPECS-INDEX #977 第 3 批(2026-10-06):客戶電話、地址改成「要同時開啟『服務人員是否顯示會員資料』
    //    才會顯示」(get_my_booking_schedule 在後端就不回傳,migration 20261006130300),說明照實改寫;
    //    整段改寫成全形標點。
    description:
      "開放後這位服務人員可以查看自己的行事曆／預約排程（含以助手身份參與的預約）。點進單筆預約明細，會看到客戶姓名、客戶備註與這筆的金額；客戶電話、地址需同時開啟「服務人員是否顯示會員資料」才會顯示（地址只有到府派工類型的商家才會顯示）。開啟這一項等於讓他接觸客戶個資，不只是看到自己的班表。內部備註可以逐單另外隱藏。客戶的會員資料（是不是會員、會員姓名、紅利點數餘額）同樣要開啟「服務人員是否顯示會員資料」才看得到。關閉後也不會收到訂單推播與 LINE 通知。",
  },
  {
    key: "staff_availability_self_manage",
    label: "可預約時段/休假自助調整",
    // 🔴 SPECS-INDEX #882 順手盤點:原本寫「標記單日臨時休假」把範圍講小了。實際的「排休設定」
    // (DayOffTabsSection.tsx)有兩個分頁 —— 整天排休 + 時段排休,時段排休可以精細到單一半小時時段。
    // 另外 WholeDayOffTab/BySlotOffTab 排休時若該時段已有預約,系統不會自動取消(只跳提示),
    // 這點對管理員判斷份量也有影響,一併寫出來。
    description:
      "開放後這位服務人員可以自己設定每週固定可預約時段，並自行排休 —— 除了整天排休，也可以精細到單一半小時時段。排休時如果那段時間已經有預約，系統不會自動取消那些預約。僅抽成制服務人員可以使用，月薪制、日薪制、時薪制服務人員即使開通這項也不會生效。",
  },
  {
    key: "staff_payroll_view",
    label: "抽成/薪資報表檢視",
    // 🔴 SPECS-INDEX #879 ②:原本寫「某個月」是錯的。實際畫面(MyPayrollPage.tsx)用的是
    // DateRangePicker,可以自訂起訖日期或起訖月份區間,上限跟後端 `p_end_date - p_start_date <= 366`
    // 對齊(dateRangeUtils.ts 的 MAX_RANGE_RAW_DAYS),對使用者一律講「最長一年」。
    // 🔴 SPECS-INDEX #882 順手盤點:這一項也有「說明範圍比實際小」的同類落差 —— 抽成制的訂單明細
    // 是用客戶姓名當每張卡片的標題(StaffReportPage.tsx L236 `<ListCard title={d.customer_name}>`),
    // 所以開這一項也會看到客戶姓名。範圍比行事曆檢視小:只有姓名,沒有電話/地址/備註,
    // 而且自助視角的 CSV 匯出是關掉的(MyPayrollPage.tsx 傳 showCsvExport={false}),這點一併寫清楚。
    description:
      "開放後這位服務人員可以自訂起訖日期(或起訖月份)區間，查詢自己該期間的抽成明細或薪資扣款明細，一次最長查一年。抽成制的訂單明細會逐筆列出，每一筆都顯示客戶姓名(只有姓名，不含電話、地址與備註)。",
  },
  {
    key: "staff_profile_edit",
    label: "個人資料編輯",
    // 🔴 SPECS-INDEX #879 ③:五個欄位確實都能改,只是原本沒寫出電話的必填與格式限制
    // (EditMyStaffProfileDialog.tsx 用 isValidTaiwanMobilePhone,資料庫也有 NOT NULL + CHECK)。
    description:
      "開放後這位服務人員可以自己修改姓名/暱稱/電話/頭像/簡介。其中電話是必填，而且必須是 09 開頭的 10 碼手機號碼。",
  },
];
