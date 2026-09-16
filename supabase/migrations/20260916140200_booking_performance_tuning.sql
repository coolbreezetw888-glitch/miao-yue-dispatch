-- 模組 5:行事曆與預約核心引擎 — 效能優化
-- 對應 Supabase 顧問(performance advisor)在套用 20260916140000/20260916140100 之後掃描出的
-- unindexed_foreign_keys 結果,不對應規格書新增需求(比照模組 1/3 既有的 _performance_tuning
-- migration 慣例):bookings.created_by_user_id、bookings.service_item_id 這兩個外鍵欄位補上索引,
-- 避免之後查詢量變大時全表掃描。
create index if not exists idx_bookings_created_by_user_id on public.bookings (created_by_user_id);
create index if not exists idx_bookings_service_item_id on public.bookings (service_item_id);
