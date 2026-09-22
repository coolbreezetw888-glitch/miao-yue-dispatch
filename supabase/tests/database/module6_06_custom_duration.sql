-- 模組 6(訂單管理,第二批)§4.3:建單表單自訂工時開關。
-- 驗證重點(規格書 §4.3 邊界情況與測試要求):
--   ①關閉時沿用逐項加總計算 end_at;②開啟時 end_at 直接採用自訂總服務時長,取代逐項加總;
--   ③自訂工時算出的區間一樣要完整跑過既有排程驗證(超出服務人員時段/落在單日例外關閉時段一樣
--     會被擋下,證明沒有繞過既有驗證);④助手的驗證也套用自訂後的區間,不網開一面;
--   ⑤custom_duration_minutes 未開啟時必須存 null,避免留著舊值;⑥開啟但未填/填 <=0 時被擋下;
--   ⑦update_booking 關閉自訂工時開關後,end_at 正確恢復成逐項加總、minutes 正確恢復成 null。
begin;

select plan(13);

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
  ('c6000000-0000-4000-8000-000000000001', 'pgtap-m6b-duration-admin@test.local');

insert into groups (id) values ('c6000000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('c6000000-0000-4000-8000-000000000020', 'c6000000-0000-4000-8000-000000000010', '自訂工時測試商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('c6000000-0000-4000-8000-000000000020', 'c6000000-0000-4000-8000-000000000001');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
values ('c6000000-0000-4000-8000-000000000020', 2, false, '09:00', '18:00');

-- 服務項目本身只有 15 分鐘,刻意設得很短——開啟自訂工時後 end_at 應該完全不理會這個 15 分鐘,
-- 直接採用客服輸入的總服務時長,藉此清楚證明「取代」而不是「疊加」。
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('c6000000-0000-4000-8000-000000000030', 'c6000000-0000-4000-8000-000000000020', '極短服務', 200, 'primary', 15);

-- 服務人員 J:窗口 10:00-11:30(90 分鐘寬),用來測「自訂工時算出的區間一樣要跑過既有邊界驗證」。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit)
values ('c6000000-0000-4000-8000-000000000040', 'c6000000-0000-4000-8000-000000000020', '服務人員J', '0901000101', false);
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
values ('c6000000-0000-4000-8000-000000000040', 2, '10:00', '11:30');

-- 服務人員 K:窗口跟 J 相同,專門測「自訂工時算出的區間橫跨到單日例外關閉時段一樣會被擋下」。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit)
values ('c6000000-0000-4000-8000-000000000041', 'c6000000-0000-4000-8000-000000000020', '服務人員K', '0901000102', false);
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
values ('c6000000-0000-4000-8000-000000000041', 2, '10:00', '11:30');

-- 服務人員 L(主要):窗口很寬(10:00-18:00),用來測「助手的驗證也套用自訂後的區間」;
-- 助手 M 的窗口很窄(10:00-10:30),自訂工時延伸到助手窗口之外時應該整筆被擋下。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit)
values ('c6000000-0000-4000-8000-000000000042', 'c6000000-0000-4000-8000-000000000020', '服務人員L', '0901000103', false);
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
values ('c6000000-0000-4000-8000-000000000042', 2, '10:00', '18:00');

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit)
values ('c6000000-0000-4000-8000-000000000043', 'c6000000-0000-4000-8000-000000000020', '助手M', '0901000104', false);
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
values ('c6000000-0000-4000-8000-000000000043', 2, '10:00', '10:30');

-- 服務人員 N:專門給 update_booking 測試用(§4.3 第 7 點:關閉自訂工時開關後正確恢復)。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit)
values ('c6000000-0000-4000-8000-000000000044', 'c6000000-0000-4000-8000-000000000020', '服務人員N', '0901000105', false);
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
values ('c6000000-0000-4000-8000-000000000044', 2, '10:00', '18:00');

-- 服務人員 P/Q/R:分別給 C1/C2/C5 各自獨立使用,避免這幾筆會真的成功寫入的預約彼此時段重疊
-- (strict_conflict_check 預設開啟)。P/Q 窗口跟 J 相同(10:00-11:30),R 窗口很寬,單純測
-- 「關閉自訂工時」的既有行為,不需要窄窗口。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('c6000000-0000-4000-8000-000000000045', 'c6000000-0000-4000-8000-000000000020', '服務人員P', '0901000106', false),
  ('c6000000-0000-4000-8000-000000000046', 'c6000000-0000-4000-8000-000000000020', '服務人員Q', '0901000107', false),
  ('c6000000-0000-4000-8000-000000000047', 'c6000000-0000-4000-8000-000000000020', '服務人員R', '0901000108', true);
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time) values
  ('c6000000-0000-4000-8000-000000000045', 2, '10:00', '11:30'),
  ('c6000000-0000-4000-8000-000000000046', 2, '10:00', '11:30');

select pg_temp.test_set_auth('c6000000-0000-4000-8000-000000000001');
-- SPECS-INDEX #604(2026-09-23 批次修正,機械性補參數,不改變測試本身要驗證的邏輯):
-- create_booking 新建訂單付款方式改為必填,下面既有的 create_booking/update_booking 呼叫
-- 補上 p_payment_method_id。
insert into payment_methods (id, merchant_id, name) values ('8f20edea-4d28-5157-93f3-dc5e1103328f', 'c6000000-0000-4000-8000-000000000020', '現場付款');


-- ① 關閉自訂工時(預設):end_at 沿用逐項加總(15 分鐘服務,10:00 開始 → end_at = 10:15)。
select id, end_at from create_booking(
  'c6000000-0000-4000-8000-000000000020', 'c6000000-0000-4000-8000-000000000045',
  jsonb_build_array(jsonb_build_object('service_item_id','c6000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
  'C1客戶', '0931000001'
, p_payment_method_id => '8f20edea-4d28-5157-93f3-dc5e1103328f') \gset c1_

select is(
  (:'c1_end_at'::timestamptz),
  '2026-09-22 10:15:00+08'::timestamptz,
  '§4.3①:自訂工時關閉時,end_at 沿用逐項加總結果(15 分鐘服務 → 10:00-10:15)'
);

-- ② 開啟自訂工時(70 分鐘,10:00-11:10,落在服務人員Q的窗口 10:00-11:30 內,且總長度
--    刻意不是 30 的倍數,用來驗證最後一格「多算」的部分不會被誤判超出邊界,見 private.
--    check_staff_booking_slot 的 v_check_end 修正):應該成功,且 end_at 直接採用自訂值
--    (10:00+70分=11:10),完全不理會服務項目本身的 15 分鐘。
select id, end_at from create_booking(
  'c6000000-0000-4000-8000-000000000020', 'c6000000-0000-4000-8000-000000000046',
  jsonb_build_array(jsonb_build_object('service_item_id','c6000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
  'C2客戶', '0931000002',
  p_custom_duration_enabled => true, p_custom_duration_minutes => 70
, p_payment_method_id => '8f20edea-4d28-5157-93f3-dc5e1103328f') \gset c2_

select is(
  (:'c2_end_at'::timestamptz),
  '2026-09-22 11:10:00+08'::timestamptz,
  '§4.3②:自訂工時開啟時,end_at 直接採用自訂值(70 分鐘,非半小時整數倍),取代逐項加總(15 分鐘)'
);

select is(
  (select custom_duration_minutes from bookings where id = :'c2_id'::uuid),
  70,
  '§4.3②:custom_duration_minutes 正確寫入 70'
);

-- ③ 開啟自訂工時,但延伸超出服務人員 J 的窗口(10:00-11:30):100 分鐘從 14:00 開始 → 15:40,
--    超出窗口,應該被擋下,證明自訂工時算出的區間一樣要完整跑過既有排程驗證。
select throws_ok(
  $$select create_booking(
    'c6000000-0000-4000-8000-000000000020', 'c6000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','c6000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 14:00:00+08',
    'C3客戶', '0931000003',
    p_custom_duration_enabled => true, p_custom_duration_minutes => 100
  , p_payment_method_id => '8f20edea-4d28-5157-93f3-dc5e1103328f')$$,
  'P0001', null,
  '§4.3③:自訂工時延伸超出服務人員可預約時段,整筆被擋下(沒有繞過既有邊界驗證)'
);

-- ④ 開啟自訂工時,延伸到單日例外「關閉」的時段:服務人員K窗口 10:00-11:30,先關閉 11:00-11:30,
--    90 分鐘自訂工時從 10:00 開始(10:00-11:30,橫跨到已關閉的格子),應該被擋下,證明自訂工時
--    算出的區間一樣要通過第五節單日例外第三層驗證(這是本次「自訂工時 + 單日例外」最容易漏接的
--    交集情境,務必個別驗證,不能假設兩邊各自測過就一定沒問題)。
select set_staff_day_override('c6000000-0000-4000-8000-000000000041', '2026-09-22', '11:00', '11:30', false);

select throws_ok(
  $$select create_booking(
    'c6000000-0000-4000-8000-000000000020', 'c6000000-0000-4000-8000-000000000041',
    jsonb_build_array(jsonb_build_object('service_item_id','c6000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    'C4客戶', '0931000004',
    p_custom_duration_enabled => true, p_custom_duration_minutes => 90
  , p_payment_method_id => '8f20edea-4d28-5157-93f3-dc5e1103328f')$$,
  'P0001', null,
  '§4.3④:自訂工時延伸到單日例外關閉的時段,整筆被擋下(自訂工時 × 第三層單日例外的交集驗證)'
);

-- ④對照組:把該格子的例外清除後,同一筆自訂工時預約應該可以成功建立,證明擋下確實是因為
-- 那個例外設定,不是別的原因誤判。
select clear_staff_day_override('c6000000-0000-4000-8000-000000000041', '2026-09-22', '11:00', '11:30');

select lives_ok(
  $$select create_booking(
    'c6000000-0000-4000-8000-000000000020', 'c6000000-0000-4000-8000-000000000041',
    jsonb_build_array(jsonb_build_object('service_item_id','c6000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    'C4對照客戶', '0931000005',
    p_custom_duration_enabled => true, p_custom_duration_minutes => 90
  , p_payment_method_id => '8f20edea-4d28-5157-93f3-dc5e1103328f')$$,
  '§4.3④對照組:清除例外後,同一筆自訂工時預約成功建立,證明④確實是被例外擋下'
);

-- ⑤ 關閉自訂工時開關時,custom_duration_minutes 一律存 null,即使呼叫端不小心多傳了舊值。
select id from create_booking(
  'c6000000-0000-4000-8000-000000000020', 'c6000000-0000-4000-8000-000000000047',
  jsonb_build_array(jsonb_build_object('service_item_id','c6000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 11:00:00+08',
  'C5客戶', '0931000006',
  p_custom_duration_enabled => false, p_custom_duration_minutes => 999
, p_payment_method_id => '8f20edea-4d28-5157-93f3-dc5e1103328f') \gset c5_

select is(
  (select custom_duration_minutes from bookings where id = :'c5_id'::uuid),
  null,
  '§4.3⑤:自訂工時關閉時,custom_duration_minutes 一律存 null(即使呼叫端多傳了舊值 999)'
);

-- ⑥ 開啟自訂工時但沒有填總服務時長(null)或填了不合理的值(<=0),都應該被擋下。
select throws_ok(
  $$select create_booking(
    'c6000000-0000-4000-8000-000000000020', 'c6000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','c6000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 15:00:00+08',
    'C6客戶a', '0931000007',
    p_custom_duration_enabled => true, p_custom_duration_minutes => null
  , p_payment_method_id => '8f20edea-4d28-5157-93f3-dc5e1103328f')$$,
  'P0001', null,
  '§4.3⑥:開啟自訂工時但沒有填總服務時長,被擋下'
);

select throws_ok(
  $$select create_booking(
    'c6000000-0000-4000-8000-000000000020', 'c6000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','c6000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 15:00:00+08',
    'C6客戶b', '0931000008',
    p_custom_duration_enabled => true, p_custom_duration_minutes => -5
  , p_payment_method_id => '8f20edea-4d28-5157-93f3-dc5e1103328f')$$,
  'P0001', null,
  '§4.3⑥:開啟自訂工時但填了 <=0 的總服務時長,被擋下'
);

-- ⑦ 助手的驗證也套用自訂後的區間:主要人員L窗口很寬(10:00-18:00),助手M窗口很窄
--    (10:00-10:30)。自訂工時 60 分鐘(10:00-11:00)超出助手M的窗口,即使主要人員完全沒問題,
--    整筆也應該被擋下,證明沒有對助手網開一面。
select throws_ok(
  format(
    $$select create_booking(
      'c6000000-0000-4000-8000-000000000020', 'c6000000-0000-4000-8000-000000000042',
      jsonb_build_array(jsonb_build_object('service_item_id','c6000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
      'C7客戶', '0931000009',
      p_assistant_staff_ids => array['%s']::uuid[],
      p_custom_duration_enabled => true, p_custom_duration_minutes => 60
    , p_payment_method_id => '8f20edea-4d28-5157-93f3-dc5e1103328f')$$,
    'c6000000-0000-4000-8000-000000000043'
  ),
  'P0001', null,
  '§4.3⑦:助手的驗證也套用自訂後的區間,超出助手可預約時段整筆被擋下'
);

-- ⑧ update_booking:先用自訂工時 90 分鐘建立一筆預約(服務人員N,10:00-11:30),
--    再編輯成關閉自訂工時,應該恢復成逐項加總(15 分鐘,10:00-10:15),
--    且 custom_duration_minutes 正確恢復成 null。
select id from create_booking(
  'c6000000-0000-4000-8000-000000000020', 'c6000000-0000-4000-8000-000000000044',
  jsonb_build_array(jsonb_build_object('service_item_id','c6000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
  'C8客戶', '0931000010',
  p_custom_duration_enabled => true, p_custom_duration_minutes => 90
, p_payment_method_id => '8f20edea-4d28-5157-93f3-dc5e1103328f') \gset c8_

select is(
  (select end_at from bookings where id = :'c8_id'::uuid),
  '2026-09-22 11:30:00+08'::timestamptz,
  '§4.3⑧前置:自訂工時 90 分鐘建立成功,end_at 正確是 11:30'
);

-- SPECS-INDEX #604:維持原付款方式不變(c8_ 建立時已帶 payment_method_id)。
select update_booking(
  :'c8_id'::uuid, 'c6000000-0000-4000-8000-000000000044',
  jsonb_build_array(jsonb_build_object('service_item_id','c6000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
  'C8客戶', '0931000010',
  p_custom_duration_enabled => false, p_custom_duration_minutes => null,
  p_payment_method_id => '8f20edea-4d28-5157-93f3-dc5e1103328f'
);

select is(
  (select end_at from bookings where id = :'c8_id'::uuid),
  '2026-09-22 10:15:00+08'::timestamptz,
  '§4.3⑧:update_booking 關閉自訂工時後,end_at 正確恢復成逐項加總(10:00-10:15)'
);

select is(
  (select custom_duration_minutes from bookings where id = :'c8_id'::uuid),
  null,
  '§4.3⑧:update_booking 關閉自訂工時後,custom_duration_minutes 正確恢復成 null'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
