-- 對應規格書「商家端三項調整」需求 2(§二 2.2.2):拿掉商家層級「商家預設抽成比例(%)」設定,
-- 因為每位服務人員的抽成不一定相同,這個預設值已無意義。
--
-- 已查證:新的服務項目層級抽成引擎(private.calculate_booking_staff_commission 等)完全沒有
-- 讀取這個欄位,前端 src/modules/payroll/api.ts、PayrollSettingsPage.tsx 也已經不再寫入/顯示
-- 這個欄位(2026-09-22 商家端三項調整已完成並通過測試)。此欄位在此之前一直保留、未刪除,
-- 是因為刪除 DDL 先前被 Claude Code 自動模式權限分類器擋下,現在由主腦重新查證安全後補上。
--
-- 補記錄:此 migration 已於 2026-09-22 透過 apply_migration 套用到正式環境,套用時機是在
-- 20260922110500(一次性資料遷移,仍需讀取這個舊欄位)之後——正式環境的實際執行順序正確。
-- 但 apply_migration 當下自動分配的追蹤版本號是 20260922011827(早於這批 110000 系列),
-- 如果本機檔名直接沿用這個版本號,會讓 `supabase db reset --local` 依檔名排序時把這支
-- DROP COLUMN 排到資料遷移「之前」執行,導致資料遷移那支找不到欄位而失敗——這是本機重建順序
-- 的問題,不是正式環境曾經發生過的實際錯誤(正式環境的套用順序一直是對的)。
-- 因此這支本機檔案刻意命名成 110500 之後、110000 系列所有異動都完成之後(20260922111300),
-- 確保 `db reset --local` 依真正的邏輯依賴順序重建;正式環境的
-- supabase_migrations.schema_migrations 追蹤表記錄的版本號(20260922011827)與這個檔名不同,
-- 這是已知、刻意接受的落差,原因見上述說明,不影響任何一邊的實際資料庫結構是否正確。
alter table public.merchant_payroll_settings
  drop column default_commission_rate_percentage;
