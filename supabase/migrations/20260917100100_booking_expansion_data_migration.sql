-- 模組 5 擴充:建單功能擴充 — 2.1 資料搬遷(破壞性 schema 變更,獨立成一支 migration)
-- 對應規格書 2.1「資料搬遷」三步驟:
--   1. 新增 booking_service_items(上一支 migration 20260917100000 已完成)。
--   2. 把每一筆既有 bookings 的 service_item_id、以及該筆預約既有 start_at/end_at 差值反推出的
--      分鐘數,各寫一筆進 booking_service_items(不重新查 service_items 當下的 duration_minutes,
--      避免搬遷當下服務項目工時已經異動導致跟原本的 end_at 對不上)。
--   3. 確認搬遷筆數與 bookings 既有筆數一致後,才 alter table bookings drop column service_item_id。
--
-- 交易邊界:Supabase CLI/apply_migration 對每一支 migration 檔案本身就是在單一交易內執行
-- (整支檔案要嘛全部成功、要嘛全部 rollback,不需要額外手動包 begin/commit,這也是整個專案目前
-- 所有既有 migration 檔案一致的寫法,沒有任何一支手動包過交易)。下方 DO 區塊用 raise exception
-- 讓「筆數對不上」這件事直接讓整支 migration 失敗、自動整個 rollback,滿足規格書「任何一步失敗就
-- 整個 rollback」的要求。
--
-- 2026-09-17 實作前已用 mcp__claude_ai_Supabase__execute_sql 確認正式資料庫(專案 miaoyue,
-- ref wjtbmmnakcriuaqoknsq)目前 bookings 是 0 筆,這支搬遷實際套用到正式環境時风险最低
-- (0 筆情況下,下方的搬遷/驗證邏輯一樣會正確執行,只是搬 0 筆、驗證 0=0 通過)。這支 migration
-- 寫成通用、正確處理任意筆數的版本,不因為「目前是 0 筆」就抄捷徑寫死行為,確保之後如果在
-- 別的環境(例如本機 pgTAP 測試資料庫)套用、且真的有既有資料時一樣安全。

do $$
declare
  v_bookings_count bigint;
  v_migrated_count bigint;
begin
  select count(*) into v_bookings_count from public.bookings;

  insert into public.booking_service_items (booking_id, service_item_id, duration_minutes_snapshot)
  select
    b.id,
    b.service_item_id,
    -- 用既有 start_at/end_at 差值反推分鐘數,不重新查 service_items 當下的 duration_minutes
    -- (規格書 2.1:避免服務項目工時異動後跟原本的 end_at 對不上)。
    greatest(0, round(extract(epoch from (b.end_at - b.start_at)) / 60)::integer)
  from public.bookings b;

  select count(*) into v_migrated_count from public.booking_service_items;

  if v_migrated_count <> v_bookings_count then
    raise exception '資料搬遷筆數不一致(bookings=% / booking_service_items=%),整個 migration rollback',
      v_bookings_count, v_migrated_count;
  end if;

  raise notice '2.1 資料搬遷完成:bookings=% 筆,已全部搬進 booking_service_items,筆數一致。', v_bookings_count;
end;
$$;

-- 筆數驗證通過後才移除舊欄位。Postgres 會自動一併移除只依附在這個欄位上的索引
-- (20260916140200_booking_performance_tuning.sql 建立的 idx_bookings_service_item_id),
-- 不需要另外手動 drop index。
alter table public.bookings drop column service_item_id;

comment on table public.bookings is
  '預約/訂單共用資料表(對應模組5規格書 1.3,2026-09-17 建單功能擴充後說明更新)。模組5負責排程相關欄位跟功能;
   模組6(訂單管理)之後直接在這張表新增金額/付款狀態/紅利點數等業務欄位,並做清單/篩選 UI,
   不建第二張表、不做同步機制。2026-09-17 起,服務項目改用 booking_service_items 多對多關聯表
   (取代原本的 service_item_id 單一外鍵,見建單功能擴充規格書 2.1),本表不再有 service_item_id 欄位。';
