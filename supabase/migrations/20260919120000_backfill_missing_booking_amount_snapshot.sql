-- 修正一個上線時遺漏的資料回填問題:「訂單管理第一批」上線時
-- (20260918110000_order_management_schema.sql / 20260918110100_order_management_data_migration.sql),
-- 有把 booking_service_items.unit_price_snapshot 正確回填成當時的 service_items.price,
-- 但漏了連帶重新計算既有 bookings 資料列的 subtotal_amount_snapshot/final_amount_snapshot——
-- 這兩欄新增時只給了預設值 0,對已存在的預約資料列沒有任何回填邏輯,導致這筆 2026-09-17
-- 就存在的真實預約(涼風工匠商家),金額欄位停留在 0,不是真正的金額。使用者實際操作
-- 開啟這筆舊訂單的預約詳情時發現金額顯示 $0,回報後查證確認是這個疏漏。
--
-- 修法:只回填「subtotal_amount_snapshot = final_amount_snapshot = 0(還沒真正計算過)」的
-- 既有資料列,依 booking_service_items 的 unit_price_snapshot × quantity 加總算出正確小計,
-- 因為這些舊資料列的 discount_enabled/tax_enabled/custom_total_amount_enabled 都是 false
-- (功能上線前建立,不可能有開過這些開關),所以 final_amount_snapshot 直接等於小計,
-- discount/tax 金額維持 0 不變。執行前後都印出受影響筆數,方便核對。
--
-- 這支 migration 已經直接套用到正式環境(專案 wjtbmmnakcriuaqoknsq),這裡補存檔案是為了
-- 留在版控紀錄裡,不是「待套用」的狀態——本機/未來環境重跑遷移時,這個條件式回填邏輯
-- 本身是冪等的(只影響「金額仍是 0 且沒開任何金額開關」的資料列,已經回填過的資料列
-- 不會符合條件,重跑不會有副作用)。
do $$
declare
  v_affected_count int;
begin
  with candidates as (
    select b.id
    from public.bookings b
    where b.subtotal_amount_snapshot = 0
      and b.final_amount_snapshot = 0
      and b.discount_enabled = false
      and b.tax_enabled = false
      and b.custom_total_amount_enabled = false
      and exists (select 1 from public.booking_service_items bsi where bsi.booking_id = b.id)
  ),
  computed as (
    select bsi.booking_id, sum(bsi.unit_price_snapshot * bsi.quantity) as total
    from public.booking_service_items bsi
    where bsi.booking_id in (select id from candidates)
    group by bsi.booking_id
  )
  update public.bookings b
  set subtotal_amount_snapshot = computed.total,
      final_amount_snapshot = computed.total
  from computed
  where b.id = computed.booking_id;

  get diagnostics v_affected_count = row_count;
  raise notice '已回填 % 筆預約的金額欄位(小計/最終金額,補算成服務項目單價快照加總)。', v_affected_count;
end;
$$;
