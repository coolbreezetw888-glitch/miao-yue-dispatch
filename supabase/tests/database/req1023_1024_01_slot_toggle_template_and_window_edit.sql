-- SPECS-INDEX #1023 / #1024(第 22 批):
--   #1023 set_staff_day_override:每週可預約時段外不能「開放」;關閉、清除、時段內開放照舊。
--   #1024 staff_availability_windows 新增 / 修改:開始 < 結束、同一天不能重疊(相接可以),白話錯誤;RLS 照舊;
--         沒有權限的人不會從錯誤訊息看到別人的時段(直接 42501)。
-- migration:20261008140000_req1023_1024_slot_toggle_template_and_window_edit.sql
begin;

select plan(32);

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

-- 布置:商家甲週二 09:00–18:00 營業、週三公休。
--   服務人員 A:週二每週時段 10:00–12:00、14:00–16:00(一般)
--   服務人員 B:沒有每週時段,但「商家後台編輯無時段限制」開 ⇒ 整段營業時間都算時段內
--   商家乙的管理員:不能動商家甲的時段
insert into auth.users (id, email) values
  ('d1023000-0000-4000-8000-000000000001', 'pgtap-b22-admin@test.local'),
  ('d1023000-0000-4000-8000-000000000002', 'pgtap-b22-other-admin@test.local');

insert into groups (id) values ('d1023000-0000-4000-8000-000000000010'), ('d1023000-0000-4000-8000-000000000011');
insert into merchants (id, group_id, name, industry_type) values
  ('d1023000-0000-4000-8000-000000000020', 'd1023000-0000-4000-8000-000000000010', '第22批測試商家', 'in_store_beauty'),
  ('d1023000-0000-4000-8000-000000000021', 'd1023000-0000-4000-8000-000000000011', '第22批別家商家', 'in_store_beauty');
insert into merchant_admins (merchant_id, user_id) values
  ('d1023000-0000-4000-8000-000000000020', 'd1023000-0000-4000-8000-000000000001'),
  ('d1023000-0000-4000-8000-000000000021', 'd1023000-0000-4000-8000-000000000002');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time) values
  ('d1023000-0000-4000-8000-000000000020', 2, false, '09:00', '18:00'),
  ('d1023000-0000-4000-8000-000000000020', 3, true, null, null);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, unlimited_backend_edit) values
  ('d1023000-0000-4000-8000-000000000040', 'd1023000-0000-4000-8000-000000000020', '第22批服務人員A', '0901023040', false, false),
  ('d1023000-0000-4000-8000-000000000041', 'd1023000-0000-4000-8000-000000000020', '第22批服務人員B', '0901023041', false, true);

insert into staff_availability_windows (id, staff_id, day_of_week, start_time, end_time) values
  ('d1023000-0000-4000-8000-000000000060', 'd1023000-0000-4000-8000-000000000040', 2, '10:00', '12:00'),
  ('d1023000-0000-4000-8000-000000000061', 'd1023000-0000-4000-8000-000000000040', 2, '14:00', '16:00');

-- 已經存在的「時段外開放」殘留列(#1023 之前留下的):週二 2036-06-03 17:00
insert into staff_availability_overrides (staff_id, override_date, slot_start_time, is_available)
values ('d1023000-0000-4000-8000-000000000040', '2036-06-03', '17:00', true);

-- =========================================================================
-- #1023
-- =========================================================================
select pg_temp.test_set_auth('d1023000-0000-4000-8000-000000000001');

select throws_ok(
  $$select set_staff_day_override('d1023000-0000-4000-8000-000000000040', '2036-06-03', '12:30', '13:00', true)$$,
  'P0001',
  '這段時間不在這位服務人員的每週可預約時段內，無法開放。需要在時段外排單時，請由商家開啟「商家後台編輯無時段限制」。',
  '① 營業時間內、每週時段外(12:30)開放 ⇒ 擋,白話全形訊息'
);
select throws_ok(
  $$select set_staff_day_override('d1023000-0000-4000-8000-000000000040', '2036-06-03', '08:00', '08:30', true)$$,
  'P0001', null,
  '② 營業時間外(08:00)開放 ⇒ 擋'
);
select throws_ok(
  $$select set_staff_day_override('d1023000-0000-4000-8000-000000000040', '2036-06-03', '11:30', '12:30', true)$$,
  'P0001', null,
  '③ 一段裡只要有一格在時段外(11:30 在內、12:00 在外)⇒ 整段擋'
);
select throws_ok(
  $$select set_staff_day_override('d1023000-0000-4000-8000-000000000040', '2036-06-04', '10:00', '10:30', true)$$,
  'P0001', null,
  '④ 公休日(週三)開放 ⇒ 擋'
);
select pg_temp.test_clear_auth();
select is(
  (select count(*)::int from staff_availability_overrides
    where staff_id = 'd1023000-0000-4000-8000-000000000040' and slot_start_time <> '17:00'),
  0,
  '⑤ 被擋下的開放一筆都沒寫進去'
);

select pg_temp.test_set_auth('d1023000-0000-4000-8000-000000000001');
select is(
  set_staff_day_override('d1023000-0000-4000-8000-000000000040', '2036-06-03', '10:00', '11:00', false),
  0,
  '⑥ 時段內關閉照舊'
);
select is(
  set_staff_day_override('d1023000-0000-4000-8000-000000000040', '2036-06-03', '10:00', '10:30', true),
  0,
  '⑦ 時段內(關掉之後)再開放照舊'
);
select lives_ok(
  $$select set_staff_day_override('d1023000-0000-4000-8000-000000000040', '2036-06-03', '12:00', '13:00', false)$$,
  '⑧ 時段外「關閉」不擋(例:時段排休 / 整天休假)'
);
select lives_ok(
  $$select set_staff_day_override('d1023000-0000-4000-8000-000000000040', '2036-06-05', '00:00', '24:00', false)$$,
  '⑨ 整天休假 00:00–24:00 關閉照舊'
);
select lives_ok(
  $$select set_staff_day_override('d1023000-0000-4000-8000-000000000040', '2036-06-03', '17:00', '17:30', false)$$,
  '⑩ 既有殘留的時段外開放列可以「關閉」'
);
select lives_ok(
  $$select clear_staff_day_override('d1023000-0000-4000-8000-000000000040', '2036-06-03', '17:00', '17:30')$$,
  '⑪ 也可以清除(回到原本的灰格)'
);
select is(
  set_staff_day_override('d1023000-0000-4000-8000-000000000041', '2036-06-03', '12:30', '13:00', true),
  0,
  '⑫ 「商家後台編輯無時段限制」⇒ 整段營業時間都算時段內,可以開放'
);
select throws_ok(
  $$select set_staff_day_override('d1023000-0000-4000-8000-000000000041', '2036-06-03', '18:00', '18:30', true)$$,
  'P0001', null,
  '⑬ 「商家後台編輯無時段限制」也不能開在營業時間外'
);
select pg_temp.test_clear_auth();

select is(
  (select array_agg(privilege_type::text order by privilege_type)::text
     from information_schema.role_routine_grants
    where routine_schema = 'private' and routine_name = 'staff_slot_in_weekly_template'
      and grantee in ('anon', 'authenticated', 'PUBLIC')),
  null,
  '⑭ private.staff_slot_in_weekly_template:anon / authenticated / PUBLIC 都沒有 EXECUTE'
);

-- =========================================================================
-- #1024
-- =========================================================================
select pg_temp.test_set_auth('d1023000-0000-4000-8000-000000000001');

select lives_ok(
  $$update staff_availability_windows set start_time = '09:30', end_time = '12:30'
     where id = 'd1023000-0000-4000-8000-000000000060'$$,
  '⑮ 直接改開始 / 結束時間 ⇒ 成功'
);
select is(
  (select start_time::text || '-' || end_time::text from staff_availability_windows
    where id = 'd1023000-0000-4000-8000-000000000060'),
  '09:30:00-12:30:00',
  '⑯ 寫進去的是新時間(同一列,不是刪掉再新增)'
);
select throws_ok(
  $$update staff_availability_windows set start_time = '13:00', end_time = '12:00'
     where id = 'd1023000-0000-4000-8000-000000000060'$$,
  'P0001', '開始時間必須早於結束時間',
  '⑰ 開始晚於結束 ⇒ 白話錯誤(不是 CHECK 約束的英文)'
);
select throws_ok(
  $$update staff_availability_windows set start_time = '12:00', end_time = '12:00'
     where id = 'd1023000-0000-4000-8000-000000000060'$$,
  'P0001', '開始時間必須早於結束時間',
  '⑱ 開始等於結束 ⇒ 擋'
);
select throws_ok(
  $$update staff_availability_windows set end_time = '14:30'
     where id = 'd1023000-0000-4000-8000-000000000060'$$,
  'P0001', '這個時段跟同一天已設定的「14:00–16:00」重疊，請調整時間。',
  '⑲ 跟同一天另一組重疊 ⇒ 擋,訊息講出是哪一組'
);
select lives_ok(
  $$update staff_availability_windows set end_time = '14:00'
     where id = 'd1023000-0000-4000-8000-000000000060'$$,
  '⑳ 剛好相接(…–14:00 與 14:00–…)不算重疊'
);
select lives_ok(
  $$update staff_availability_windows set day_of_week = 3, start_time = '14:00', end_time = '16:00'
     where id = 'd1023000-0000-4000-8000-000000000060'$$,
  '㉑ 不同天的同一段時間不算重疊'
);
select pg_temp.test_clear_auth();

-- 別家商家的管理員:RLS 照舊擋(0 列被改)
select pg_temp.test_set_auth('d1023000-0000-4000-8000-000000000002');
update staff_availability_windows set start_time = '08:00'
 where id = 'd1023000-0000-4000-8000-000000000061';
select pg_temp.test_clear_auth();
select is(
  (select start_time::text from staff_availability_windows where id = 'd1023000-0000-4000-8000-000000000061'),
  '14:00:00',
  '㉒ 別家商家的管理員改不到(RLS 照舊)'
);

select is(
  (select array_agg(privilege_type::text order by privilege_type)::text
     from information_schema.role_routine_grants
    where routine_schema = 'private' and routine_name = 'tg_staff_availability_windows_validate'
      and grantee in ('anon', 'authenticated', 'PUBLIC')),
  null,
  '㉓ trigger 函式:anon / authenticated / PUBLIC 都沒有 EXECUTE'
);

-- 主腦裁決:新增時段也一樣擋(前後規則一致)
select pg_temp.test_set_auth('d1023000-0000-4000-8000-000000000001');
select throws_ok(
  $$insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    values ('d1023000-0000-4000-8000-000000000040', 2, '15:00', '17:00')$$,
  'P0001', '這個時段跟同一天已設定的「14:00–16:00」重疊，請調整時間。',
  '㉔ 新增一組跟同一天重疊的時段 ⇒ 擋,訊息跟編輯時一字不差'
);
select throws_ok(
  $$insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    values ('d1023000-0000-4000-8000-000000000040', 2, '18:00', '17:00')$$,
  'P0001', '開始時間必須早於結束時間',
  '㉕ 新增開始晚於結束 ⇒ 白話錯誤'
);
select lives_ok(
  $$insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    values ('d1023000-0000-4000-8000-000000000040', 2, '16:00', '17:00')$$,
  '㉖ 新增剛好相接(14:00–16:00 之後接 16:00–17:00)⇒ 可以'
);
select pg_temp.test_clear_auth();

-- 別家商家的管理員新增到這位服務人員(會重疊的時段):RLS 擋(42501),錯誤訊息不能出現本店的時段
select pg_temp.test_set_auth('d1023000-0000-4000-8000-000000000002');
select throws_ok(
  $$insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    values ('d1023000-0000-4000-8000-000000000040', 2, '15:00', '15:30')$$,
  '42501', '沒有權限設定這位服務人員的可預約時段',
  '㉗ 沒有權限的人新增 ⇒ 42501,訊息裡沒有任何時段(不是「跟「14:00–16:00」重疊」)'
);
select pg_temp.test_clear_auth();

-- 資料庫直接操作(沒有登入者,例如 service_role)也照樣擋重疊
select throws_ok(
  $$insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    values ('d1023000-0000-4000-8000-000000000040', 2, '16:30', '18:00')$$,
  'P0001', '這個時段跟同一天已設定的「16:00–17:00」重疊，請調整時間。',
  '㉘ 沒有登入者(service_role / 直接 SQL)新增重疊 ⇒ 一樣擋'
);

-- ===== 第 22 批 QA 打回:依「誰在寫」決定 =====
-- anon(auth.uid() 是 null)寫入會重疊的時段 ⇒ 42501,訊息不含任何時段
select pg_temp.test_set_auth(null, 'anon');
select throws_ok(
  $$insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    values ('d1023000-0000-4000-8000-000000000040', 2, '15:00', '15:30')$$,
  '42501', '沒有權限設定這位服務人員的可預約時段',
  '㉙ anon 寫入重疊時段 ⇒ 42501,訊息不含任何時段'
);
select pg_temp.test_clear_auth();
select is(
  (select count(*)::int from staff_availability_windows
    where staff_id = 'd1023000-0000-4000-8000-000000000040' and start_time = '15:00'),
  0,
  '㉚ anon 那一筆沒有寫進去'
);

-- service_role 帶著別家商家管理員的 sub(對這位服務人員沒有權限)寫入重疊 ⇒ 照樣做重疊檢查、被擋
select pg_temp.test_set_auth('d1023000-0000-4000-8000-000000000002', 'service_role');
select throws_ok(
  $$insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    values ('d1023000-0000-4000-8000-000000000040', 2, '15:00', '15:30')$$,
  'P0001', '這個時段跟同一天已設定的「14:00–16:00」重疊，請調整時間。',
  '㉛ service_role 帶別人的 sub 寫入重疊 ⇒ 被擋(RLS 繞過,所以 trigger 一定要檢查)'
);
select pg_temp.test_clear_auth();

-- service_role 不帶 sub ⇒ 也被擋
set local role service_role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
select throws_ok(
  $$insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    values ('d1023000-0000-4000-8000-000000000040', 2, '15:00', '15:30')$$,
  'P0001', '這個時段跟同一天已設定的「14:00–16:00」重疊，請調整時間。',
  '㉜ service_role 不帶 sub 寫入重疊 ⇒ 被擋'
);
select pg_temp.test_clear_auth();

select * from finish();

rollback;
