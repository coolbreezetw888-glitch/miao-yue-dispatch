-- 模組 6(訂單管理,第二批)§5.5 第 3 點:get_merchant_day_schedule 擴充回傳 availability_overrides
-- 陣列,驗證合併相鄰同值半小時格子成區間的邏輯正確(含「數值不同不合併」「有間隔不合併」的邊界)。
begin;

select plan(6);

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
  ('c5000000-0000-4000-8000-000000000001', 'pgtap-m6b-schedule-admin@test.local');

insert into groups (id) values ('c5000000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('c5000000-0000-4000-8000-000000000020', 'c5000000-0000-4000-8000-000000000010', '例外行事曆測試商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('c5000000-0000-4000-8000-000000000020', 'c5000000-0000-4000-8000-000000000001');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
values ('c5000000-0000-4000-8000-000000000020', 2, false, '09:00', '18:00');

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit)
values ('c5000000-0000-4000-8000-000000000040', 'c5000000-0000-4000-8000-000000000020', '測試師傅', null, true);

select pg_temp.test_set_auth('c5000000-0000-4000-8000-000000000001');

-- ① 沒有任何單日例外時,availability_overrides 應該是空陣列。
select is(
  (get_merchant_day_schedule('c5000000-0000-4000-8000-000000000020', '2026-09-22')
    -> 'staff' -> 0 -> 'availability_overrides')::text,
  '[]',
  '§5.5 第 3 點:沒有任何單日例外時,availability_overrides 回傳空陣列'
);

-- 設定 10:00-11:30(3 個連續半小時格子,is_available=true)。
select set_staff_day_override('c5000000-0000-4000-8000-000000000040', '2026-09-22', '10:00', '11:30', true);

select is(
  jsonb_array_length(
    get_merchant_day_schedule('c5000000-0000-4000-8000-000000000020', '2026-09-22')
      -> 'staff' -> 0 -> 'availability_overrides'
  ),
  1,
  '§5.5 第 3 點:3 個連續且同值的半小時格子合併成 1 個區間'
);

select is(
  (
    get_merchant_day_schedule('c5000000-0000-4000-8000-000000000020', '2026-09-22')
      -> 'staff' -> 0 -> 'availability_overrides' -> 0 ->> 'start_time'
  ),
  '10:00:00',
  '§5.5 第 3 點:合併後的區間起點正確(10:00)'
);

select is(
  (
    get_merchant_day_schedule('c5000000-0000-4000-8000-000000000020', '2026-09-22')
      -> 'staff' -> 0 -> 'availability_overrides' -> 0 ->> 'end_time'
  ),
  '11:30:00',
  '§5.5 第 3 點:合併後的區間終點正確(11:30,3 格 × 30 分鐘)'
);

-- 緊接著 11:30-12:00 設成 false(跟前一段相鄰但數值不同),應該產生第二個獨立區間,不會被合併。
select set_staff_day_override('c5000000-0000-4000-8000-000000000040', '2026-09-22', '11:30', '12:00', false);

select is(
  jsonb_array_length(
    get_merchant_day_schedule('c5000000-0000-4000-8000-000000000020', '2026-09-22')
      -> 'staff' -> 0 -> 'availability_overrides'
  ),
  2,
  '§5.5 第 3 點:數值不同(true→false)即使時間相鄰,也不會被合併成同一個區間'
);

-- 再設定一段有間隔的 14:00-14:30(true),跟前面的區間不相鄰,應該是第三個獨立區間。
select set_staff_day_override('c5000000-0000-4000-8000-000000000040', '2026-09-22', '14:00', '14:30', true);

select is(
  jsonb_array_length(
    get_merchant_day_schedule('c5000000-0000-4000-8000-000000000020', '2026-09-22')
      -> 'staff' -> 0 -> 'availability_overrides'
  ),
  3,
  '§5.5 第 3 點:有時間間隔的例外設定,即使數值相同,也不會被誤合併'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
