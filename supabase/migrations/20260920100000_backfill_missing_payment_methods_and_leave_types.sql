-- 修正一個上線前遺漏的資料回填問題(主腦複查發現,不屬於任何模組 7 規格書編號):
-- seed_default_payment_methods(模組 9 v2,20260919130100)/seed_default_leave_types
-- (模組 7 排班與休假管理,20260919150100)都只在 create_group_and_merchant/
-- create_merchant_in_group「建立新商家當下」被呼叫一次,對「這兩個功能上線前就已經存在的
-- 商家」完全沒有補做這件事。查證正式環境 wjtbmmnakcriuaqoknsq,受影響的是這兩間真實商家:
--   「美甲」:0 筆付款方式、0 筆假別
--   「涼風工匠」:1 筆付款方式(QA/測試過程中手動新增,不是種子資料)、0 筆假別
-- 這代表這兩間商家目前完全沒有辦法登記任何請假紀錄——create_staff_leave 的 p_leave_type_id
-- 是必填參數(沒有預設值),商家假別清單是空的話,前端下拉選單沒有任何選項可選,
-- 根本無法送出請假登記(已在動工前重新讀過 20260919150100_scheduling_leave_functions.sql
-- 第 179~250 行確認這個隱性假設,不是猜測)。付款方式則不受影響到「完全無法使用」的程度——
-- validate_booking_selection 第 6 步只在 p_payment_method_id 不是 null 時才驗證,留空可以
-- 正常不選付款方式建單,但體驗上跟「新商家一開店就有預設值可用」不一致。
--
-- 修法:比照 20260919120000_backfill_missing_booking_amount_snapshot.sql 的既有 do $$ 區塊
-- 回填慣例——只針對「目前 payment_methods 筆數為 0」的商家呼叫 seed_default_payment_methods、
-- 「目前 merchant_leave_types 筆數為 0」的商家呼叫 seed_default_leave_types,用迴圈遍歷符合
-- 條件的商家 id,不寫死商家 id(未來如果又有其他商家因為某種例外情況也是 0 筆,同一份邏輯一樣
-- 適用)。這兩支 seed 函式本身沒有做「先檢查是否已有資料才插入」的冪等保護(設計時就明講
-- 只在建立商家當下呼叫一次,見函式上的 comment),所以冪等保護要由這支 migration 自己做:
-- 呼叫前先用 count(*) = 0 篩出候選商家,已經有資料的商家不會被選中,重跑這支 migration
-- 不會造成重複資料。執行前後都印出受影響的商家數量,方便核對。
do $$
declare
  v_merchant record;
  v_payment_seeded_count int := 0;
  v_leave_seeded_count int := 0;
begin
  for v_merchant in
    select m.id
    from public.merchants m
    where not exists (
      select 1 from public.payment_methods pm where pm.merchant_id = m.id
    )
  loop
    perform public.seed_default_payment_methods(v_merchant.id);
    v_payment_seeded_count := v_payment_seeded_count + 1;
  end loop;

  for v_merchant in
    select m.id
    from public.merchants m
    where not exists (
      select 1 from public.merchant_leave_types lt where lt.merchant_id = m.id
    )
  loop
    perform public.seed_default_leave_types(v_merchant.id);
    v_leave_seeded_count := v_leave_seeded_count + 1;
  end loop;

  raise notice '已補種預設付款方式的商家數量:%;已補種預設假別的商家數量:%', v_payment_seeded_count, v_leave_seeded_count;
end;
$$;
