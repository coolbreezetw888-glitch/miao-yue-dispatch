-- SPECS-INDEX #980:建單 / 改單時間選單只列出能約的開始時間 — pgTAP
-- 規格書 .project/specs/建單畫面與下拉刷新-第2批.md 第二節 / migration 20261006100000
--
-- 驗證:
--   ①~③ 權限衛生:PUBLIC / anon 不能執行、authenticated 可以
--   ④~⑥ 函式內權限:別家商家的管理員查不到(42501);別家商家的訂單不能拿來當「排除自己」(42501);
--         別家商家的服務人員回空陣列
--   ⑦~⑬ 結果正確性(全部跟 private.check_staff_booking_slot 同一套規則):
--         營業時間 / 每週時段外不列、單日排休不列、單日例外開啟可超出平常時段、嚴格衝突開 / 關、
--         編輯時排除自己、請假整天沒有、unlimited_backend_edit 列全部但請假仍拿掉
--   ⑭ 一致性:清單裡的每一個起點,丟回 check_staff_booking_slot 都不會被擋;清單外的都會被擋
--
-- 故障注入(engineer 已做,見回報):把 check_staff_booking_slot 的請假判斷拿掉 → ⑪⑬ 轉紅
begin;

-- ─── SPECS-INDEX #977(2026-10-06,第 3 批)測試墊片:no_time_slot_limit 不再影響後台 ───────────────
-- 「客戶預約無時段限制」(no_time_slot_limit)改成只管客戶線上預約,後台建單 / 改單 / 行事曆一律不看它
-- (migration 20261006130200)。這支測試的 fixture 原本用 no_time_slot_limit=true 代表「這位服務人員不用另外
-- 布置每週時段,只受商家營業時間限制」——那是情境布置的捷徑,不是這支測試要驗的主題。
-- 為了讓原本的情境一字不差地成立,這裡在本交易內暫時掛一個 trigger:no_time_slot_limit=true 的服務人員
-- 自動補上 7 天 00:00–24:00 的每週時段(= 改前「只受營業時間限制」的效果);改回 false 時拿掉這幾列。
-- 整支測試結束 rollback,不留任何東西。新行為本身由 req977_01 驗證(那支不掛這個墊片)。
create function pg_temp.req977_full_day_windows()
returns trigger
language plpgsql
security definer
set search_path = public
as $req977$
begin
  if new.no_time_slot_limit then
    insert into public.staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    select new.id, d::smallint, '00:00'::time, '24:00'::time
    from generate_series(0, 6) d
    on conflict (staff_id, day_of_week, start_time, end_time) do nothing;
  elsif tg_op = 'UPDATE' and old.no_time_slot_limit then
    delete from public.staff_availability_windows
    where staff_id = new.id and start_time = '00:00'::time and end_time = '24:00'::time;
  end if;
  return new;
end;
$req977$;

create trigger req977_full_day_windows
  after insert or update of no_time_slot_limit on public.merchant_staff
  for each row execute function pg_temp.req977_full_day_windows();
-- ─── 墊片結束 ──────────────────────────────────────────────────────────────────────────────

select plan(15);

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

-- =========================================================================
-- Fixture
--   A 商家:每天 09:00-18:00 營業;
--     服務人員 S1:每週時段每天 10:00-16:00;12/07 12:00-12:30 單日排休、17:00-17:30 單日開啟;
--                12/07 14:00-15:00 已有一筆預約;12/08 整天請假
--     服務人員 S2:unlimited_backend_edit = true、沒有任何每週時段;12/08 整天請假
--   B 商家:管理員乙、服務人員 SB、訂單 bkB
-- =========================================================================
insert into auth.users (id, email) values
  ('e9800000-0000-4000-8000-000000000001', 'pgtap-req980-admin-a@test.local'),
  ('e9800000-0000-4000-8000-000000000002', 'pgtap-req980-admin-b@test.local');

insert into groups (id) values
  ('e9800000-0000-4000-8000-000000000011'),
  ('e9800000-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type) values
  ('e9800000-0000-4000-8000-000000000021', 'e9800000-0000-4000-8000-000000000011', '可約時段A店', 'in_store_beauty'),
  ('e9800000-0000-4000-8000-000000000022', 'e9800000-0000-4000-8000-000000000012', '可約時段B店', 'in_store_beauty');
insert into merchant_admins (merchant_id, user_id) values
  ('e9800000-0000-4000-8000-000000000021', 'e9800000-0000-4000-8000-000000000001'),
  ('e9800000-0000-4000-8000-000000000022', 'e9800000-0000-4000-8000-000000000002');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select m, d, false, '09:00', '18:00'
from generate_series(0, 6) as d,
     unnest(array['e9800000-0000-4000-8000-000000000021'::uuid, 'e9800000-0000-4000-8000-000000000022'::uuid]) as m;

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, unlimited_backend_edit) values
  ('e9800000-0000-4000-8000-000000000031', 'e9800000-0000-4000-8000-000000000021', '服務人員S1', '0900098001', false, false),
  ('e9800000-0000-4000-8000-000000000032', 'e9800000-0000-4000-8000-000000000021', '服務人員S2', '0900098002', false, true),
  ('e9800000-0000-4000-8000-000000000033', 'e9800000-0000-4000-8000-000000000022', '服務人員SB', '0900098003', true, false);
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
select 'e9800000-0000-4000-8000-000000000031'::uuid, d, '10:00', '16:00' from generate_series(0, 6) as d;

insert into staff_availability_overrides (staff_id, override_date, slot_start_time, is_available) values
  ('e9800000-0000-4000-8000-000000000031', '2026-12-07', '12:00', false),
  ('e9800000-0000-4000-8000-000000000031', '2026-12-07', '17:00', true);

insert into merchant_leave_types (id, merchant_id, name) values
  ('e9800000-0000-4000-8000-000000000041', 'e9800000-0000-4000-8000-000000000021', '特休');
insert into staff_leave_records (staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date, status) values
  ('e9800000-0000-4000-8000-000000000031', 'e9800000-0000-4000-8000-000000000041', '特休', '2026-12-08', '2026-12-08', 'confirmed'),
  ('e9800000-0000-4000-8000-000000000032', 'e9800000-0000-4000-8000-000000000041', '特休', '2026-12-08', '2026-12-08', 'confirmed');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('e9800000-0000-4000-8000-000000000051', 'e9800000-0000-4000-8000-000000000021', '一小時服務A', 1000, 'primary', 60),
  ('e9800000-0000-4000-8000-000000000052', 'e9800000-0000-4000-8000-000000000022', '一小時服務B', 1000, 'primary', 60);
insert into payment_methods (id, merchant_id, name) values
  ('e9800000-0000-4000-8000-000000000061', 'e9800000-0000-4000-8000-000000000021', '現場付款A'),
  ('e9800000-0000-4000-8000-000000000062', 'e9800000-0000-4000-8000-000000000022', '現場付款B');
select seed_default_member_settings('e9800000-0000-4000-8000-000000000021');
select seed_default_member_settings('e9800000-0000-4000-8000-000000000022');

select pg_temp.test_set_auth('e9800000-0000-4000-8000-000000000001');
select id from create_booking(
  p_merchant_id => 'e9800000-0000-4000-8000-000000000021',
  p_staff_id => 'e9800000-0000-4000-8000-000000000031',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e9800000-0000-4000-8000-000000000051','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-07 14:00:00+08',
  p_customer_name => 'A店客戶',
  p_customer_phone => '0955098001',
  p_payment_method_id => 'e9800000-0000-4000-8000-000000000061') \gset bkA_
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e9800000-0000-4000-8000-000000000002');
select id from create_booking(
  p_merchant_id => 'e9800000-0000-4000-8000-000000000022',
  p_staff_id => 'e9800000-0000-4000-8000-000000000033',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e9800000-0000-4000-8000-000000000052','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-07 10:00:00+08',
  p_customer_name => 'B店客戶',
  p_customer_phone => '0955098002',
  p_payment_method_id => 'e9800000-0000-4000-8000-000000000062') \gset bkB_
select pg_temp.test_clear_auth();

-- =========================================================================
-- ①~③ 權限衛生
-- =========================================================================
select ok(not has_function_privilege('public', 'public.list_staff_bookable_start_times(uuid,uuid,date,integer,uuid)', 'execute'),
  '① PUBLIC 不能執行 list_staff_bookable_start_times');
select ok(not has_function_privilege('anon', 'public.list_staff_bookable_start_times(uuid,uuid,date,integer,uuid)', 'execute'),
  '② anon 不能執行 list_staff_bookable_start_times');
select ok(has_function_privilege('authenticated', 'public.list_staff_bookable_start_times(uuid,uuid,date,integer,uuid)', 'execute'),
  '③ authenticated 可以執行(函式內部再用 can_manage_bookings 檢查)');

-- =========================================================================
-- ④~⑥ 函式內權限:只能查自己商家
-- =========================================================================
select pg_temp.test_set_auth('e9800000-0000-4000-8000-000000000002');
select throws_ok(
  $$select public.list_staff_bookable_start_times('e9800000-0000-4000-8000-000000000021', 'e9800000-0000-4000-8000-000000000031', '2026-12-07', 60, null)$$,
  '42501', null,
  '④ B 店管理員查 A 店的可約時間 → 42501');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e9800000-0000-4000-8000-000000000001');
select throws_ok(
  format($$select public.list_staff_bookable_start_times('e9800000-0000-4000-8000-000000000021', 'e9800000-0000-4000-8000-000000000031', '2026-12-07', 60, %L)$$, :'bkB_id'),
  '42501', null,
  '⑤ 拿 B 店的訂單當「排除自己」→ 42501(不能跨店試探)');
select is(
  public.list_staff_bookable_start_times('e9800000-0000-4000-8000-000000000021', 'e9800000-0000-4000-8000-000000000033', '2026-12-07', 60, null),
  '{}'::text[],
  '⑥ 帶 B 店的服務人員 id 查 A 店 → 空陣列(不洩漏 B 店排班)');

-- =========================================================================
-- ⑦~⑬ 結果正確性
-- =========================================================================
-- 60 分鐘:每週時段 10:00-16:00 ⇒ 起點 10:00~15:00;
--   拿掉 11:30 / 12:00(碰到 12:00-12:30 單日排休)、13:30 / 14:00 / 14:30(跟 14:00-15:00 的預約重疊,嚴格檢查預設開啟);
--   17:00 雖然單日開啟,但 17:30-18:00 不在每週時段內 ⇒ 不列。
select is(
  public.list_staff_bookable_start_times('e9800000-0000-4000-8000-000000000021', 'e9800000-0000-4000-8000-000000000031', '2026-12-07', 60, null),
  array['10:00','10:30','11:00','12:30','13:00','15:00']::text[],
  '⑦ 60 分鐘:只列營業時間 ∩ 每週時段內、避開單日排休與既有訂單(嚴格檢查預設開啟)');

select ok(
  '17:00' = any(public.list_staff_bookable_start_times('e9800000-0000-4000-8000-000000000021', 'e9800000-0000-4000-8000-000000000031', '2026-12-07', 30, null))
  and not ('16:00' = any(public.list_staff_bookable_start_times('e9800000-0000-4000-8000-000000000021', 'e9800000-0000-4000-8000-000000000031', '2026-12-07', 30, null)))
  and not ('09:30' = any(public.list_staff_bookable_start_times('e9800000-0000-4000-8000-000000000021', 'e9800000-0000-4000-8000-000000000031', '2026-12-07', 30, null))),
  '⑧ 30 分鐘:單日例外開啟的 17:00 列得出來;每週時段外的 16:00、09:30 不列');

select is(
  public.list_staff_bookable_start_times('e9800000-0000-4000-8000-000000000021', 'e9800000-0000-4000-8000-000000000031', '2026-12-07', 60, :'bkA_id'),
  array['10:00','10:30','11:00','12:30','13:00','13:30','14:00','14:30','15:00']::text[],
  '⑨ 編輯那筆 14:00 的訂單時排除自己 ⇒ 13:30 / 14:00 / 14:30 回來');
select pg_temp.test_clear_auth();

insert into merchant_feature_flags (merchant_id, feature_key, enabled)
values ('e9800000-0000-4000-8000-000000000021', 'strict_conflict_check', false);

select pg_temp.test_set_auth('e9800000-0000-4000-8000-000000000001');
select is(
  public.list_staff_bookable_start_times('e9800000-0000-4000-8000-000000000021', 'e9800000-0000-4000-8000-000000000031', '2026-12-07', 60, null),
  array['10:00','10:30','11:00','12:30','13:00','13:30','14:00','14:30','15:00']::text[],
  '⑩ 嚴格工時衝突檢查關閉 ⇒ 不因為跟既有訂單重疊而拿掉');

select is(
  public.list_staff_bookable_start_times('e9800000-0000-4000-8000-000000000021', 'e9800000-0000-4000-8000-000000000031', '2026-12-08', 60, null),
  '{}'::text[],
  '⑪ 整天請假 ⇒ 沒有任何可約時間');

select is(
  cardinality(public.list_staff_bookable_start_times('e9800000-0000-4000-8000-000000000021', 'e9800000-0000-4000-8000-000000000032', '2026-12-05', 60, null)),
  48,
  '⑫ unlimited_backend_edit ⇒ 列出全部 48 個起點(後端也不擋;12/05 前後兩天都沒請假)');

select is(
  public.list_staff_bookable_start_times('e9800000-0000-4000-8000-000000000021', 'e9800000-0000-4000-8000-000000000032', '2026-12-08', 60, null),
  '{}'::text[],
  '⑬ unlimited_backend_edit 但請假 ⇒ 仍然沒有可約時間(後端也擋請假)');
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑭ 一致性:48 個起點逐一丟給 check_staff_booking_slot,「沒被擋」的集合必須等於清單。
--     (嚴格檢查已關閉,這裡把它打開回來,用預設行為比對。)
-- =========================================================================
delete from merchant_feature_flags
where merchant_id = 'e9800000-0000-4000-8000-000000000021' and feature_key = 'strict_conflict_check';

create function pg_temp.slot_passes(p_minutes integer) returns boolean
language plpgsql as $$
declare
  v_staff public.merchant_staff;
  v_start timestamptz := ('2026-12-07'::timestamp + make_interval(mins => p_minutes)) at time zone 'Asia/Taipei';
begin
  select * into v_staff from public.merchant_staff where id = 'e9800000-0000-4000-8000-000000000031';
  perform private.check_staff_booking_slot('e9800000-0000-4000-8000-000000000021', v_staff, v_start,
    v_start + interval '60 minutes', null, '主要服務人員');
  return true;
exception when raise_exception then
  return false;
end;
$$;

-- 期望值用 postgres 身分算(private.check_staff_booking_slot 不開放給 authenticated)。
select array_agg(to_char(make_time(m / 60, m % 60, 0), 'HH24:MI') order by m) as expected
from generate_series(0, 1410, 30) as m
where pg_temp.slot_passes(m) \gset consistency_

select pg_temp.test_set_auth('e9800000-0000-4000-8000-000000000001');
select is(
  public.list_staff_bookable_start_times('e9800000-0000-4000-8000-000000000021', 'e9800000-0000-4000-8000-000000000031', '2026-12-07', 60, null),
  :'consistency_expected'::text[],
  '⑭ 清單 = 48 個起點裡 check_staff_booking_slot 不擋的那些(前後端同一套規則)');
select pg_temp.test_clear_auth();

-- ⑮(#980 QA 打回補):非 30 倍數工時 45 分鐘 —— 不卡住,而且結果正確
--   11:30(11:30~12:15 碰到 12:00 排休)、12:00、13:30 / 14:00 / 14:30(跟 14:00~15:00 的預約重疊)不列;
--   15:00(到 15:45)可以;15:30(到 16:15)超出每週時段。
set local statement_timeout = '3s';
select pg_temp.test_set_auth('e9800000-0000-4000-8000-000000000001');
select is(
  public.list_staff_bookable_start_times('e9800000-0000-4000-8000-000000000021', 'e9800000-0000-4000-8000-000000000031', '2026-12-07', 45, null),
  array['10:00','10:30','11:00','12:30','13:00','15:00']::text[],
  '⑮ 45 分鐘工時:不會卡住,只列能約的起點');
select pg_temp.test_clear_auth();

select * from finish();
rollback;
