-- 模組 5 規則 2.6 第 3 點/3.6:get_merchant_day_schedule 的隱私邊界——本店預約完整顯示,
-- 跨商家占用只顯示起訖時間、不顯示對方客戶姓名/服務項目等細節。也一併驗證可預約邊界交集
-- (規則 2.1 ∩ 2.2)跟查無權限時被擋下。
--
-- 2026-09-22 補充說明(對應 .project/SPECS-INDEX.md #595/#596):merchant_staff.phone 改成
-- NOT NULL + CHECK(phone ~ '^09\d{8}$')之後,資料庫層不再可能存下帶符號的格式,下面兩位
-- 「A師傅(同一人跨店)」的電話字串改成完全相同(這是現在唯一能表示「同一人跨店」的方式,
-- 見 module5_02_conflict_and_phone_matching.sql 開頭同一天補充的說明)。
begin;

select plan(10);

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
  ('b5000000-0000-4000-8000-000000000001', 'pgtap-m5-store1-admin@test.local'),
  ('b5000000-0000-4000-8000-000000000002', 'pgtap-m5-store2-admin@test.local'),
  ('b5000000-0000-4000-8000-000000000009', 'pgtap-m5-outsider@test.local');

insert into groups (id) values
  ('b5000000-0000-4000-8000-000000000011'),
  ('b5000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('b5000000-0000-4000-8000-000000000021', 'b5000000-0000-4000-8000-000000000011', '一店', 'in_store_beauty'),
  ('b5000000-0000-4000-8000-000000000022', 'b5000000-0000-4000-8000-000000000012', '二店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('b5000000-0000-4000-8000-000000000021', 'b5000000-0000-4000-8000-000000000001'),
  ('b5000000-0000-4000-8000-000000000022', 'b5000000-0000-4000-8000-000000000002');

-- 一店週二 09:00-18:00 營業;二店週二公休(方便驗證「查無占用時 foreign_bookings 為空陣列」)。
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time) values
  ('b5000000-0000-4000-8000-000000000021', 2, false, '09:00', '18:00'),
  ('b5000000-0000-4000-8000-000000000022', 2, true, null, null);

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('b5000000-0000-4000-8000-000000000031', 'b5000000-0000-4000-8000-000000000021', '洗髮', 300, 'primary', 60),
  ('b5000000-0000-4000-8000-000000000032', 'b5000000-0000-4000-8000-000000000022', '洗髮', 300, 'primary', 60);

-- 一店 A 師傅:個人時段 10:00-14:00(比營業時間窄)。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('b5000000-0000-4000-8000-000000000041', 'b5000000-0000-4000-8000-000000000021', 'A師傅(一店)', '0977111111', false);
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
values ('b5000000-0000-4000-8000-000000000041', 2, '10:00', '14:00');

-- 二店 A 師傅(同一人,電話字串完全相同,二店本身公休但這位師傅仍可能被其他店預約走)。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('b5000000-0000-4000-8000-000000000042', 'b5000000-0000-4000-8000-000000000022', 'A師傅(二店)', '0977111111', true);

select pg_temp.test_set_auth('b5000000-0000-4000-8000-000000000002');
-- 二店幫「A師傅(二店)」建一筆 2026-09-22 11:00-12:00 的預約(即使二店本身公休,這裡直接測 3.6 的
-- 跨店占用顯示,不透過 create_booking 走二店自己的營業時間檢查,避免測試互相干擾;直接 insert
-- 一筆資料布置情境,聚焦測 get_merchant_day_schedule 的隱私邊界)。
select pg_temp.test_clear_auth();

insert into bookings (
  id, merchant_id, staff_id, start_at, end_at,
  customer_name, customer_phone, source, created_by_role, status
) values (
  'b5000000-0000-4000-8000-000000000091',
  'b5000000-0000-4000-8000-000000000022', 'b5000000-0000-4000-8000-000000000042',
  '2026-09-22 11:00:00+08', '2026-09-22 12:00:00+08',
  '二店的秘密客戶', '0988000000', 'manual', 'admin', 'accepted'
);

insert into booking_service_items (booking_id, service_item_id, duration_minutes_snapshot, unit_price_snapshot)
values ('b5000000-0000-4000-8000-000000000091', 'b5000000-0000-4000-8000-000000000032', 60, 100);

-- 一店也幫 A 師傅(一店)建一筆本店預約 10:00-11:00(在時段內)。
select pg_temp.test_set_auth('b5000000-0000-4000-8000-000000000001');

select id, status from create_booking(
  'b5000000-0000-4000-8000-000000000021', 'b5000000-0000-4000-8000-000000000041',
  jsonb_build_array(jsonb_build_object('service_item_id','b5000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
  '一店的客戶', '0966000000'
) \gset own_

-- ① 一店管理員查自己商家的當日行事曆,應該能成功查到(has_setting=true, is_closed=false)。
select is(
  (select (get_merchant_day_schedule('b5000000-0000-4000-8000-000000000021', '2026-09-22')->'business_hours'->>'is_closed')),
  'false',
  '3.6:一店當天有營業,is_closed 回傳 false'
);

-- ② 可預約邊界交集(規則 2.1 ∩ 2.2):A 師傅(一店)個人時段 10:00-14:00 比營業時間窄,
--    available_windows 應該回傳交集後的 10:00-14:00(而不是營業時間的 09:00-18:00)。
select is(
  (
    select s->'available_windows'->0->>'start_time'
    from jsonb_array_elements(get_merchant_day_schedule('b5000000-0000-4000-8000-000000000021', '2026-09-22')->'staff') s
    where s->>'staff_id' = 'b5000000-0000-4000-8000-000000000041'
  ),
  '10:00:00',
  '3.6:可預約邊界交集正確反映服務人員個人時段(比營業時間窄)'
);

-- ③ 本店預約(customer_name)應該完整顯示。
select is(
  (
    select s->'bookings'->0->>'customer_name'
    from jsonb_array_elements(get_merchant_day_schedule('b5000000-0000-4000-8000-000000000021', '2026-09-22')->'staff') s
    where s->>'staff_id' = 'b5000000-0000-4000-8000-000000000041'
  ),
  '一店的客戶',
  '3.6:本店預約完整顯示客戶姓名'
);

-- ③a 建單功能擴充 4.2 第 1/2 點:本店預約應該回傳 service_items 陣列(而不是舊的單一
--    service_item_name 字串),且主要服務人員身份的 role 應該是 'main'。
select is(
  (
    select s->'bookings'->0->'service_items'->0->>'name'
    from jsonb_array_elements(get_merchant_day_schedule('b5000000-0000-4000-8000-000000000021', '2026-09-22')->'staff') s
    where s->>'staff_id' = 'b5000000-0000-4000-8000-000000000041'
  ),
  '洗髮',
  '建單功能擴充 4.2:本店預約正確回傳 service_items 陣列(取代原本的 service_item_name 單一字串)'
);

select is(
  (
    select s->'bookings'->0->>'role'
    from jsonb_array_elements(get_merchant_day_schedule('b5000000-0000-4000-8000-000000000021', '2026-09-22')->'staff') s
    where s->>'staff_id' = 'b5000000-0000-4000-8000-000000000041'
  ),
  'main',
  '建單功能擴充 4.2:主要服務人員身份的預約,role 標示為 main'
);

-- ④ 跨商家占用(規則 2.6 第 3 點):應該能看到 foreign_bookings 有一筆,起訖時間跟二店那筆一致。
select is(
  (
    select (s->'foreign_bookings'->0->>'start_at')::timestamptz
    from jsonb_array_elements(get_merchant_day_schedule('b5000000-0000-4000-8000-000000000021', '2026-09-22')->'staff') s
    where s->>'staff_id' = 'b5000000-0000-4000-8000-000000000041'
  ),
  '2026-09-22 11:00:00+08'::timestamptz,
  '3.6:跨商家占用的起訖時間正確顯示'
);

-- ⑤ 隱私邊界:foreign_bookings 這個 jsonb 物件裡,絕對不能出現「二店的秘密客戶」這個字串
--    (規則 2.6 第 3 點核心要求:不能洩漏對方商家的客戶姓名等細節)。
select ok(
  (
    select (s->'foreign_bookings')::text not like '%二店的秘密客戶%'
    from jsonb_array_elements(get_merchant_day_schedule('b5000000-0000-4000-8000-000000000021', '2026-09-22')->'staff') s
    where s->>'staff_id' = 'b5000000-0000-4000-8000-000000000041'
  ),
  '3.6 隱私邊界:foreign_bookings 完全不包含對方商家的客戶姓名'
);

-- ⑥ 隱私邊界:foreign_bookings 也不該出現服務項目名稱這種細節欄位鍵(整個物件只有 start_at/end_at
--    兩個鍵)。
select ok(
  (
    select not (s->'foreign_bookings'->0 ? 'service_item_name')
      and not (s->'foreign_bookings'->0 ? 'customer_name')
    from jsonb_array_elements(get_merchant_day_schedule('b5000000-0000-4000-8000-000000000021', '2026-09-22')->'staff') s
    where s->>'staff_id' = 'b5000000-0000-4000-8000-000000000041'
  ),
  '3.6 隱私邊界:foreign_bookings 物件結構只有起訖時間,沒有 service_item_name/customer_name 這些鍵'
);

select pg_temp.test_clear_auth();

-- ⑦ 沒有權限的第三方(不是任何一間商家的管理員/客服)呼叫應該被擋下。
select pg_temp.test_set_auth('b5000000-0000-4000-8000-000000000009');

select throws_ok(
  $$select get_merchant_day_schedule('b5000000-0000-4000-8000-000000000021', '2026-09-22')$$,
  '42501', null,
  '3.6:沒有權限的使用者呼叫 get_merchant_day_schedule 被擋下'
);

select pg_temp.test_clear_auth();

-- ⑧ 二店當天公休:is_closed 應該回傳 true,且 A 師傅(二店)的 available_windows 應為空陣列
--    (即使 no_time_slot_limit=true,商家公休時第一層邊界仍然優先)。
select pg_temp.test_set_auth('b5000000-0000-4000-8000-000000000002');

select is(
  (
    select jsonb_array_length(s->'available_windows')
    from jsonb_array_elements(get_merchant_day_schedule('b5000000-0000-4000-8000-000000000022', '2026-09-22')->'staff') s
    where s->>'staff_id' = 'b5000000-0000-4000-8000-000000000042'
  ),
  0,
  '3.6:商家當天公休時,即使服務人員 no_time_slot_limit=true,available_windows 仍為空陣列'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
