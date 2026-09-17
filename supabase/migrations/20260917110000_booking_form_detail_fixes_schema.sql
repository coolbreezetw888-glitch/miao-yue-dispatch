-- 建單表單細節修正(資料層)
-- 對應規格書 D:\SaaS-tool-scaffold(預約系統)\.project\specs\建單表單細節修正.md 第二節第 1 點:
-- bookings 新增 customer_address text(nullable)。到府派工(on_site_dispatch)這類產業需要記錄
-- 客戶指定的服務地點,到店服務(in_store_beauty)不需要,所以資料庫層不強制必填,必填驗證放在
-- create_booking/update_booking 裡依產業類型判斷(見下一支 migration 20260917110100)。
--
-- nullable 欄位,既有預約資料(含目前正式環境「涼風工匠」商家已存在的真實預約列)不會因為這支
-- migration 出錯,新增欄位一律回填 null,不影響任何既有列。

alter table public.bookings add column customer_address text;

comment on column public.bookings.customer_address is
  '客戶指定的服務地點(對應建單表單細節修正規格書第二節)。nullable——只有 industry_type=on_site_dispatch(到府派工)這類商家的建單/編輯表單會要求必填,in_store_beauty(到店服務)不需要,判斷邏輯見 private.industry_requires_customer_address()。這次只是單純文字輸入框,不做地址格式驗證/地圖選點/自動完成。';
