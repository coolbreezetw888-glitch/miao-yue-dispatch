// 客戶端第 1 批(C1):公開預約頁 `/booking/<代碼>` 的型別。
// 規格:.project/specs/客戶端第1批-公開預約頁.md 第 C 節(C1-C01 / C1-C02 的回傳結構)。
//
// 🔴 這兩支函式是給「沒登入的人」呼叫的,回傳只有白名單欄位(資料庫用 jsonb_build_object 逐欄組出)。
//    前端這裡的型別**只能少、不能多** —— 不要因為畫面想多顯示什麼,就在這裡加一個欄位、再去要求資料庫多回傳。
//    要加欄位一律先回規格書(C1-C01 的「明確不回傳」黑名單)確認。
//
// 📌 為什麼自己定義、不用 src/integrations/supabase/types.ts:那份檔案只會把 RPC 的回傳寫成 `Json`,
//    看不出裡面的結構;這裡把結構寫清楚,api.ts 拿到資料後用 parse 函式逐欄檢查再轉成這些型別。

export type PublicIndustryType = "on_site_dispatch" | "in_store_beauty";

export interface PublicMerchant {
  name: string;
  industry_type: PublicIndustryType;
  logo_url: string | null;
  address: string | null;
  phone: string | null;
  intro: string | null;
  theme_preset: string | null;
  theme_custom_color: string | null;
  /** 只有商家開了公告才有內容;沒開 = null(資料庫那一層就擋掉,不是前端藏)。 */
  announcement: string | null;
  line_friend_url: string | null;
}

export interface PublicBookingSettings {
  /** 允許不登入預約(⑥-1 的「不登入，直接預約」、⑥-4)。 */
  allow_guest_booking: boolean;
  /** = 商家產業是到府。 */
  is_on_site: boolean;
  /** C2-C01:有設定 LINE 登入而且已啟用。沒回傳(舊版函式)= false。 */
  line_login_enabled: boolean;
}

/**
 * C2-C06:同意勾選框要用的會員政策。商家沒開或內容空白 ⇒ 勾選框只寫「隱私權政策」。
 * 內容是商家自己打的純文字,只在「會員政策」小卡窗裡顯示。
 */
export interface PublicMemberPolicy {
  enabled: boolean;
  content: string | null;
}

export interface PublicCategory {
  id: string;
  name: string;
}

export type PublicServiceItemType = "primary" | "addon";

export interface PublicServiceItem {
  id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  price: number;
  duration_minutes: number;
  item_type: PublicServiceItemType;
}

export interface PublicStaff {
  id: string;
  /** 有暱稱用暱稱,沒有用本名(資料庫決定)。 */
  display_name: string;
  avatar_url: string | null;
  intro: string | null;
  /** 這個人對應的「主要」項目 id;null = 沒設定任何對應 = 什麼都會做。 */
  primary_service_item_ids: string[] | null;
}

export interface PublicBookingPageOk {
  status: "ok";
  merchant: PublicMerchant;
  booking_settings: PublicBookingSettings;
  member_policy: PublicMemberPolicy;
  categories: PublicCategory[];
  service_items: PublicServiceItem[];
  staff: PublicStaff[];
}

/** not_found / unavailable:除了 status 以外什麼都沒有。 */
export type PublicBookingPage =
  PublicBookingPageOk | { status: "not_found" } | { status: "unavailable" };

export type PublicDayState = "open" | "closed" | "full" | "out_of_range";

export interface PublicSlotDay {
  date: string; // YYYY-MM-DD(台北日曆日)
  state: PublicDayState;
  times: string[]; // "HH:MM"
}

export interface PublicAvailableSlots {
  duration_minutes: number;
  days: PublicSlotDay[];
}

/** 送給時段函式的項目(只收這兩個欄位)。 */
export interface PublicSelectedItem {
  service_item_id: string;
  quantity: number;
}
