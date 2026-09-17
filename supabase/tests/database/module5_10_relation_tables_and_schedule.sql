-- 建單功能擴充規則 3.2:booking_service_items/booking_assistants/booking_material_costs 只有 SELECT
-- 政策,不開放前端直接寫入。也一併驗證 4.2 的 get_merchant_day_schedule 助手身份顯示
-- (role='assistant'、跨商家以助手身份占用的 foreign_bookings)。
begin;

select plan(9);

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
  ('ba000000-0000-4000-8000-000000000001', 'pgtap-m5x-admin1@test.local'),
  ('ba000000-0000-4000-8000-000000000002', 'pgtap-m5x-admin2@test.local');

insert into groups (id) values
  ('ba000000-0000-4000-8000-000000000011'),
  ('ba000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('ba000000-0000-4000-8000-000000000021', 'ba000000-0000-4000-8000-000000000011', '關聯表鎖定測試一店', 'in_store_beauty'),
  ('ba000000-0000-4000-8000-000000000022', 'ba000000-0000-4000-8000-000000000012', '關聯表鎖定測試二店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('ba000000-0000-4000-8000-000000000021', 'ba000000-0000-4000-8000-000000000001'),
  ('ba000000-0000-4000-8000-000000000022', 'ba000000-0000-4000-8000-000000000002');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time) values
  ('ba000000-0000-4000-8000-000000000021', 2, false, '09:00', '18:00'),
  ('ba000000-0000-4000-8000-000000000022', 2, true, null, null);

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('ba000000-0000-4000-8000-000000000031', 'ba000000-0000-4000-8000-000000000021', '洗髮', 300, 'primary', 60);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('ba000000-0000-4000-8000-000000000041', 'ba000000-0000-4000-8000-000000000021', '主要人員', null, true),
  ('ba000000-0000-4000-8000-000000000042', 'ba000000-0000-4000-8000-000000000021', '助手E', '0955-333-333', true);

-- 二店的師傅F,電話跟一店助手E正規化後相同,用來驗證「以助手身份跨商家占用」也會出現在
-- foreign_bookings(4.2 第 3 點)。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit)
values ('ba000000-0000-4000-8000-000000000051', 'ba000000-0000-4000-8000-000000000022', '二店師傅F', '0955333333', true);

select pg_temp.test_set_auth('ba000000-0000-4000-8000-000000000001');

select id from create_booking(
  'ba000000-0000-4000-8000-000000000021', 'ba000000-0000-4000-8000-000000000041',
  array['ba000000-0000-4000-8000-000000000031']::uuid[], '2026-09-22 10:00:00+08',
  '客戶甲', '0966000001', null, null,
  array['ba000000-0000-4000-8000-000000000042']::uuid[]
) \gset booking_

-- ① 規則 3.2:booking_service_items 沒有 INSERT 政策,直接 INSERT 應該被擋下(RLS,42501)。
select throws_ok(
  format(
    $$insert into booking_service_items (booking_id, service_item_id, duration_minutes_snapshot)
      values ('%s', 'ba000000-0000-4000-8000-000000000031', 30)$$,
    :'booking_id'::text
  ),
  '42501', null,
  '規則 3.2:booking_service_items 沒有 INSERT 政策,直接寫入被擋下'
);

-- ② 規則 3.2:booking_assistants 沒有 INSERT 政策。
select throws_ok(
  format(
    $$insert into booking_assistants (booking_id, staff_id)
      values ('%s', 'ba000000-0000-4000-8000-000000000042')$$,
    :'booking_id'::text
  ),
  '42501', null,
  '規則 3.2:booking_assistants 沒有 INSERT 政策,直接寫入被擋下(已存在的那筆是 create_booking 寫的,這裡測的是「再插入一筆」)'
);

-- ③ 規則 3.2:booking_service_items 沒有 UPDATE 政策——用「事後查詢確認沒被改到」驗證
--    (RLS 的 UPDATE 政策不符合條件時是靜默 0 筆,不是拋例外)。
update booking_service_items set duration_minutes_snapshot = 999 where booking_id = :'booking_id'::uuid;

select is(
  (select duration_minutes_snapshot from booking_service_items where booking_id = :'booking_id'::uuid),
  60,
  '規則 3.2:booking_service_items 沒有 UPDATE 政策,直接 UPDATE 沒有真的改到資料'
);

-- ④ 規則 3.2:booking_service_items 沒有 DELETE 政策。
delete from booking_service_items where booking_id = :'booking_id'::uuid;

select is(
  (select count(*)::int from booking_service_items where booking_id = :'booking_id'::uuid),
  1,
  '規則 3.2:booking_service_items 沒有 DELETE 政策,直接 DELETE 沒有真的刪掉資料'
);

-- ⑤ 規則 3.2:booking_material_costs 同樣沒有 INSERT 政策(用一個不存在的料錢品項id測試也一樣
--    會被 RLS 擋下,不會因為找不到品項而先報別的錯——RLS 檢查在寫入階段就先擋)。
select throws_ok(
  format(
    $$insert into booking_material_costs (booking_id, material_cost_item_id, amount_snapshot)
      values ('%s', gen_random_uuid(), 100)$$,
    :'booking_id'::text
  ),
  '42501', null,
  '規則 3.2:booking_material_costs 沒有 INSERT 政策,直接寫入被擋下'
);

-- ⑥ 4.2 第 2 點:助手E的行事曆格線裡,這筆預約應該以 role=assistant 出現。
select is(
  (
    select s->'bookings'->0->>'role'
    from jsonb_array_elements(get_merchant_day_schedule('ba000000-0000-4000-8000-000000000021', '2026-09-22')->'staff') s
    where s->>'staff_id' = 'ba000000-0000-4000-8000-000000000042'
  ),
  'assistant',
  '4.2 第 2 點:助手身份參與的預約,在助手自己的行事曆格線裡 role 標示為 assistant'
);

-- ⑦ 4.2 第 2 點:同一筆預約在主要人員的格線裡則標示 role=main。
select is(
  (
    select s->'bookings'->0->>'role'
    from jsonb_array_elements(get_merchant_day_schedule('ba000000-0000-4000-8000-000000000021', '2026-09-22')->'staff') s
    where s->>'staff_id' = 'ba000000-0000-4000-8000-000000000041'
  ),
  'main',
  '4.2 第 2 點:同一筆預約在主要服務人員的格線裡 role 標示為 main'
);

select pg_temp.test_clear_auth();

-- ⑧ 4.2 第 3 點:二店師傅F(電話跟一店助手E正規化後相同)查自己商家的行事曆時,foreign_bookings
--    應該能看到一店那筆預約的起訖時間(即使一店那邊是「助手身份」佔用,不是主要服務人員)。
select pg_temp.test_set_auth('ba000000-0000-4000-8000-000000000002');

select is(
  (
    select (s->'foreign_bookings'->0->>'start_at')::timestamptz
    from jsonb_array_elements(get_merchant_day_schedule('ba000000-0000-4000-8000-000000000022', '2026-09-22')->'staff') s
    where s->>'staff_id' = 'ba000000-0000-4000-8000-000000000051'
  ),
  '2026-09-22 10:00:00+08'::timestamptz,
  '4.2 第 3 點:跨商家占用同時涵蓋對方以助手身份參與的預約,不會漏掉造成誤判可預約'
);

-- ⑨ 隱私邊界依然成立:即使是助手身份的跨商家占用,foreign_bookings 也不能洩漏客戶姓名。
select ok(
  (
    select (s->'foreign_bookings')::text not like '%客戶甲%'
    from jsonb_array_elements(get_merchant_day_schedule('ba000000-0000-4000-8000-000000000022', '2026-09-22')->'staff') s
    where s->>'staff_id' = 'ba000000-0000-4000-8000-000000000051'
  ),
  '4.2 第 3 點隱私邊界:助手身份的跨商家占用一樣不洩漏客戶姓名等細節'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
