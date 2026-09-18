-- 模組 6:訂單管理 — 資料層(第二支):unit_price_snapshot 安全回填 + set not null。
-- 比照 20260917100100_booking_expansion_data_migration.sql 的既有安全遷移手法:上一支 migration
-- 先允許 null 新增欄位,這支負責回填既有資料列、驗證無 null 後才收緊成 not null,任何一步失敗就讓
-- 整支 migration 失敗、自動 rollback。
--
-- 背景(主腦複查時發現、務必謹慎處理):正式環境(專案 miaoyue,ref wjtbmmnakcriuaqoknsq)目前
-- 已有 2 筆真實商家「涼風工匠」的 booking_service_items 既有資料列,這些資料列在
-- unit_price_snapshot 欄位新增當下是 null,如果直接 set not null 會因為既有資料列違反約束而
-- 整支 migration 失敗。
--
-- 回填規則:用 service_items.price(當下查到的價格)回填 unit_price_snapshot,join service_items
-- 用 service_item_id 對應;如果對應的服務項目已經被刪除(查無資料),用 0 回填。**這是既有資料的
-- 權宜回填,不是新建立/編輯訂單的正常路徑**——正常路徑 create_booking/update_booking 一律使用
-- 呼叫端傳入的值寫入,完全不重新查詢 service_items.price(見 §2.4)。回填之後這兩筆既有資料列的
-- 金額顯示可能跟真實成交價不完全一致,是可接受的已知限制,不影響往後新建立/編輯訂單的正確性。

do $$
declare
  v_total_count bigint;
  v_null_count_before bigint;
  v_null_count_after bigint;
begin
  select count(*) into v_total_count from public.booking_service_items;
  select count(*) into v_null_count_before
  from public.booking_service_items where unit_price_snapshot is null;

  -- 用 service_items.price 回填(join 得到才回填,查無對應服務項目的列維持 null,交給下一步處理)。
  update public.booking_service_items bsi
  set unit_price_snapshot = si.price
  from public.service_items si
  where bsi.service_item_id = si.id
    and bsi.unit_price_snapshot is null;

  -- 對應的服務項目已經被刪除、join 不到的既有資料列,回填 0(權宜值,見本檔案開頭說明)。
  update public.booking_service_items
  set unit_price_snapshot = 0
  where unit_price_snapshot is null;

  select count(*) into v_null_count_after
  from public.booking_service_items where unit_price_snapshot is null;

  if v_null_count_after <> 0 then
    raise exception 'unit_price_snapshot 回填後仍有 % 筆是 null(共 % 筆資料列,回填前 % 筆是 null),整個 migration rollback',
      v_null_count_after, v_total_count, v_null_count_before;
  end if;

  raise notice 'unit_price_snapshot 回填完成:共 % 筆資料列,回填前 % 筆是 null,回填後全數有值,準備收緊成 not null。',
    v_total_count, v_null_count_before;
end;
$$;

-- 驗證通過(上面 DO 區塊沒有拋例外)才收緊成 not null,並補上「不可為負數」的 CHECK 約束
-- (回填值 coalesce 過,理論上一定 >= 0,這裡是最後一道防線)。
alter table public.booking_service_items
  alter column unit_price_snapshot set not null;

alter table public.booking_service_items
  add constraint booking_service_items_unit_price_snapshot_non_negative check (unit_price_snapshot >= 0);

comment on column public.booking_service_items.unit_price_snapshot is '建立/編輯當下鎖定的單價快照(規格書 §2.1/§2.4)。create_booking/update_booking 一律直接使用呼叫端傳入的值寫入,不重新查詢 service_items.price——這跟 duration_minutes_snapshot(每次重新查詢,§2.2)刻意不同。既有資料列(2026-09-18 這批 migration 套用之前建立的)這個欄位是回填值(用當下的 service_items.price,查無對應服務項目則回填 0),不是原始成交價快照,見 20260918110100_order_management_data_migration.sql 的說明。';
