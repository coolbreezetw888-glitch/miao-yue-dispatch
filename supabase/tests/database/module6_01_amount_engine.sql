-- 模組 6(訂單管理)§2.2/§2.3/§2.4:金額計算引擎 + 工時加總公式調整(數量對工時的影響)。
-- 對應規格書:
--   §2.2 每個服務項目的工時貢獻 = duration_minutes_snapshot × quantity。
--   §2.3 金額計算順序:①小計(自訂總金額或逐項小計)②折扣(固定/百分比,不可超過小計)
--        ③稅金(以折扣後金額為課稅基礎)④最終金額。
--   §2.4 金額快照寫入時機與「編輯不變動」原則:建立/編輯當下一律直接使用呼叫端傳入值寫入,
--        不重新查詢 service_items.price;工時快照(duration_minutes_snapshot)則相反,每次都
--        重新查詢——這是兩條刻意不同的規則,這個檔案分開驗證,不要混為一談。
begin;

select plan(20);

create function pg_temp.test_set_auth(p_user_id uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', p_role)::text, true);
  execute format('set local role %I', p_role);
end;
$$;

create function pg_temp.test_clear_auth()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  reset role;
end;
$$;

insert into auth.users (id, email) values
  ('c1000000-0000-4000-8000-000000000001', 'pgtap-m6-admin@test.local');

insert into groups (id) values ('c1000000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('c1000000-0000-4000-8000-000000000020', 'c1000000-0000-4000-8000-000000000010', '金額測試商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('c1000000-0000-4000-8000-000000000020', 'c1000000-0000-4000-8000-000000000001');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
values ('c1000000-0000-4000-8000-000000000020', 2, false, '00:00', '23:59');

-- 洗髮:60 分鐘、目前上架價 300(用來驗證「不重新查詢即時價格」時,快照跟這個現在的值不一樣也沒關係)。
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('c1000000-0000-4000-8000-000000000030', 'c1000000-0000-4000-8000-000000000020', '洗髮', 300, 'primary', 60);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit)
values ('c1000000-0000-4000-8000-000000000040', 'c1000000-0000-4000-8000-000000000020', '服務人員', '0901000101', true);

-- 模組 9(支付方式)v2:payment_method 欄位已改成 payment_method_id(uuid,指向 payment_methods)+
-- payment_method_name_snapshot(text 快照),這裡補一筆商家自訂付款方式供下面 ⑩ 的測試使用。
insert into payment_methods (id, merchant_id, name)
values ('c1000000-0000-4000-8000-000000000091', 'c1000000-0000-4000-8000-000000000020', '現場付款');

select pg_temp.test_set_auth('c1000000-0000-4000-8000-000000000001');

-- ① §2.2:quantity=2 的 60 分鐘服務項目,工時貢獻正確算成 120 分鐘(end_at = start + 120 分)。
select id, end_at from create_booking(
  'c1000000-0000-4000-8000-000000000020', 'c1000000-0000-4000-8000-000000000040',
  jsonb_build_array(jsonb_build_object('service_item_id', 'c1000000-0000-4000-8000-000000000030', 'quantity', 2, 'unit_price', 500)),
  '2026-09-22 10:00:00+08', '客戶一', '0911000001'
) \gset qty2_

select is(
  :'qty2_end_at'::timestamptz,
  '2026-09-22 12:00:00+08'::timestamptz,
  '§2.2:數量 2 的 60 分鐘服務項目,工時貢獻正確算成 120 分鐘'
);

-- ② §2.1/§2.4:unit_price_snapshot 直接採用呼叫端傳入值(500),不是 service_items.price 目前值(300)。
select is(
  (select unit_price_snapshot from booking_service_items where booking_id = :'qty2_id'::uuid),
  500.00,
  '§2.4:unit_price_snapshot 直接採用呼叫端傳入值,不重新查詢 service_items.price'
);

-- ③ §2.2:duration_minutes_snapshot 依然是重新查詢的即時值(60),跟金額快照的行為刻意不同。
select is(
  (select duration_minutes_snapshot from booking_service_items where booking_id = :'qty2_id'::uuid),
  60,
  '§2.2:duration_minutes_snapshot 依然是每次重新查詢的即時值(這條規則不變)'
);

-- ④ §2.3 全部開關關閉:小計 = Σ(unit_price × quantity) = 500 × 2 = 1000,無折扣無稅金,
--    final_amount_snapshot = 1000。
select is(
  (select final_amount_snapshot from bookings where id = :'qty2_id'::uuid),
  1000.00,
  '§2.3:全部開關關閉時,最終金額 = 逐項小計(500 × 2 = 1000)'
);

-- ⑤ §4.4/§2.3:開啟自訂總金額,取代逐項小計。
select id from create_booking(
  'c1000000-0000-4000-8000-000000000020', 'c1000000-0000-4000-8000-000000000040',
  jsonb_build_array(jsonb_build_object('service_item_id', 'c1000000-0000-4000-8000-000000000030', 'quantity', 1, 'unit_price', 300)),
  '2026-09-22 13:00:00+08', '客戶二', '0911000002',
  null, null, '{}', '{}', null, null,
  true, 800
) \gset custom_

select is(
  (select subtotal_amount_snapshot from bookings where id = :'custom_id'::uuid),
  800.00,
  '§4.4/§2.3:開啟自訂總金額後,小計取代成自訂值(800),不是逐項小計(300)'
);
select is(
  (select final_amount_snapshot from bookings where id = :'custom_id'::uuid),
  800.00,
  '§4.4:自訂總金額且無折扣稅金時,最終金額 = 自訂總金額'
);

-- ⑥ §4.5/§2.3:折扣固定金額模式。小計 300,折扣 50 -> 最終 250。
select id from create_booking(
  'c1000000-0000-4000-8000-000000000020', 'c1000000-0000-4000-8000-000000000040',
  jsonb_build_array(jsonb_build_object('service_item_id', 'c1000000-0000-4000-8000-000000000030', 'quantity', 1, 'unit_price', 300)),
  '2026-09-22 14:00:00+08', '客戶三', '0911000003',
  null, null, '{}', '{}', null, null,
  false, null, true, 'fixed', 50
) \gset discount_fixed_

select is(
  (select discount_amount_snapshot from bookings where id = :'discount_fixed_id'::uuid),
  50.00,
  '§4.5:折扣固定金額模式,discount_amount_snapshot = 50'
);
select is(
  (select final_amount_snapshot from bookings where id = :'discount_fixed_id'::uuid),
  250.00,
  '§4.5:折扣固定金額 50,最終金額 = 300 - 50 = 250'
);

-- ⑦ §4.5/§2.3:折扣百分比模式。小計 300,折扣 10% -> 折扣金額 30,最終 270。
select id from create_booking(
  'c1000000-0000-4000-8000-000000000020', 'c1000000-0000-4000-8000-000000000040',
  jsonb_build_array(jsonb_build_object('service_item_id', 'c1000000-0000-4000-8000-000000000030', 'quantity', 1, 'unit_price', 300)),
  '2026-09-22 15:00:00+08', '客戶四', '0911000004',
  null, null, '{}', '{}', null, null,
  false, null, true, 'percentage', 10
) \gset discount_pct_

select is(
  (select discount_amount_snapshot from bookings where id = :'discount_pct_id'::uuid),
  30.00,
  '§4.5:折扣百分比模式(10%),discount_amount_snapshot = 300 × 10% = 30'
);
select is(
  (select final_amount_snapshot from bookings where id = :'discount_pct_id'::uuid),
  270.00,
  '§4.5:折扣百分比 10%,最終金額 = 300 - 30 = 270'
);

-- ⑧ 邊界情況(§2.3):折扣金額不可大於小計,超過就白話報錯擋下。
select throws_ok(
  $$select create_booking(
    'c1000000-0000-4000-8000-000000000020', 'c1000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id', 'c1000000-0000-4000-8000-000000000030', 'quantity', 1, 'unit_price', 300)),
    '2026-09-22 16:00:00+08', '客戶五', '0911000005',
    null, null, '{}', '{}', null, null,
    false, null, true, 'fixed', 500
  )$$,
  'P0001', null,
  '§2.3 邊界情況:折扣金額(500)超過小計(300)時被擋下'
);

-- ⑨ §4.6/§2.3:稅金以「折扣後金額」為課稅基礎,不是原始小計。
--    小計 1000(500×2),折扣固定 200 -> 折扣後 800,稅金比例 5% -> 40,最終 = 1000-200+40=840。
select id from create_booking(
  'c1000000-0000-4000-8000-000000000020', 'c1000000-0000-4000-8000-000000000040',
  jsonb_build_array(jsonb_build_object('service_item_id', 'c1000000-0000-4000-8000-000000000030', 'quantity', 2, 'unit_price', 500)),
  '2026-09-22 17:00:00+08', '客戶六', '0911000006',
  null, null, '{}', '{}', null, null,
  false, null, true, 'fixed', 200, true, 'percentage', 5
) \gset tax_

select is((select discount_amount_snapshot from bookings where id = :'tax_id'::uuid), 200.00, '§4.6:折扣先扣完');
select is(
  (select tax_amount_snapshot from bookings where id = :'tax_id'::uuid),
  40.00,
  '§4.6/§2.3:稅金以折扣後金額(800)為課稅基礎,5% = 40,不是以原始小計(1000)算'
);
select is(
  (select final_amount_snapshot from bookings where id = :'tax_id'::uuid),
  840.00,
  '§4.6/§2.3:最終金額 = 1000 - 200 + 40 = 840'
);

-- ⑩ 模組 9 v2:payment_method_id/payment_method_name_snapshot 正常寫入/查詢,留空時是 null。
select is(
  (select (payment_method_id is null and payment_method_name_snapshot is null) from bookings where id = :'tax_id'::uuid),
  true,
  '模組 9 v2:沒有傳 payment_method_id 時,payment_method_id/payment_method_name_snapshot 查詢結果都是 null(尚未設定)'
);

-- tax_id 那筆是 17:00-19:00(quantity 2 的 60 分鐘服務),這裡刻意排到 19:00 之後,避免時段重疊
-- (跟金額計算本身無關,純粹是測試資料的時間安排)。
select id from create_booking(
  'c1000000-0000-4000-8000-000000000020', 'c1000000-0000-4000-8000-000000000040',
  jsonb_build_array(jsonb_build_object('service_item_id', 'c1000000-0000-4000-8000-000000000030', 'quantity', 1, 'unit_price', 300)),
  '2026-09-22 19:00:00+08', '客戶七', '0911000007',
  null, null, '{}', '{}', null, null,
  false, null, false, null, null, false, null, null, 'c1000000-0000-4000-8000-000000000091'
) \gset payment_

select is(
  (select payment_method_name_snapshot from bookings where id = :'payment_id'::uuid),
  '現場付款',
  '模組 9 v2:payment_method_id/payment_method_name_snapshot 正常寫入/查詢'
);

-- ⑪ §2.4 核心情境:建立一筆訂單記錄金額 -> 修改該服務項目 service_items.price ->
--    編輯這筆訂單但只改客戶電話,不碰服務項目/金額欄位(重新送出原本的快照值)->
--    確認 unit_price_snapshot/final_amount_snapshot 完全沒有變動。
update service_items set price = 999 where id = 'c1000000-0000-4000-8000-000000000030';

select update_booking(
  :'qty2_id'::uuid, 'c1000000-0000-4000-8000-000000000040',
  jsonb_build_array(jsonb_build_object('service_item_id', 'c1000000-0000-4000-8000-000000000030', 'quantity', 2, 'unit_price', 500)),
  '2026-09-22 10:00:00+08', '客戶一(改電話)', '0911999999'
);

select is(
  (select unit_price_snapshot from booking_service_items where booking_id = :'qty2_id'::uuid),
  500.00,
  '§2.4 核心情境:編輯時沒有主動調整金額欄位,unit_price_snapshot 完全不受 service_items.price 異動影響'
);
select is(
  (select final_amount_snapshot from bookings where id = :'qty2_id'::uuid),
  1000.00,
  '§2.4 核心情境:編輯時沒有主動調整金額欄位,final_amount_snapshot 維持原值(1000),不會被洗成最新價格'
);

-- ⑫ §2.4 對照組:同一筆訂單,這次客服主動把單價從 500 調整成 700(重新選擇/調整),
--    確認金額快照確實依新輸入值更新。
select update_booking(
  :'qty2_id'::uuid, 'c1000000-0000-4000-8000-000000000040',
  jsonb_build_array(jsonb_build_object('service_item_id', 'c1000000-0000-4000-8000-000000000030', 'quantity', 2, 'unit_price', 700)),
  '2026-09-22 10:00:00+08', '客戶一(改電話)', '0911999999'
);

select is(
  (select unit_price_snapshot from booking_service_items where booking_id = :'qty2_id'::uuid),
  700.00,
  '§2.4 對照組:客服主動調整單價後,unit_price_snapshot 確實依新輸入值更新'
);
select is(
  (select final_amount_snapshot from bookings where id = :'qty2_id'::uuid),
  1400.00,
  '§2.4 對照組:單價調整後,final_amount_snapshot 正確重新計算(700 × 2 = 1400)'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
