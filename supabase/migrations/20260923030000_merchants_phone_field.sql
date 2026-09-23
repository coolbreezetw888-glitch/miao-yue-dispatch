-- 對應使用者需求:商家設定頁(MerchantSettingsPage.tsx)「基本資料」區塊缺少商家自己的電話欄位
-- (地址/對外聯絡 Email/簡介都有,唯獨電話一直沒開放填寫)。
--
-- 設計決定:跟 address/contact_email 同一套規則——單純可空白的自由文字欄位,不加 NOT NULL、
-- 不加格式 CHECK 約束。原因:這是「商家(店家)」自己的聯絡電話,不是模組 3(人員與權限管理)
-- 那次 merchant_staff/merchant_agents 特別要求的「台灣手機號碼」(20260922140000_req595_596
-- migration),商家電話可能是市話(02-xxxxxxxx 這類格式),不應該沿用同一份 09 開頭手機正規表示式,
-- 也沒有任何規格書要求商家電話必填,所以維持跟地址/Email 一致的「選填自由文字」設計。

alter table public.merchants
  add column phone text null;
