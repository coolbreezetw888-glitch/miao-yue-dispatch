-- SPECS-INDEX #980 追加:商家「建單時間間隔」(5 / 10 / 15 / 30 分鐘)— pgTAP
-- migration 20261006120000_req980_booking_start_time_interval.sql
--
--   ①~⑥ merchant_booking_settings 權限:anon 沒有任何權限;本店管理員可寫可讀;別家管理員寫不進去、讀不到;
--         只接受 5 / 10 / 15 / 30
--   ⑦   沒有設定 ⇒ 間隔 30(跟改版前一樣)
--   ⑧~⑩ 間隔 15:45 分鐘工時、無時段限制服務人員(營業 00:00~23:59)⇒ 00:00~23:00 每 15 分鐘(23:15 起會跨日)
--   ⑪~⑬ 間隔 5:一般服務人員(每週時段 09:00~12:00、13:00~18:00,10:00 單日排休、15:00 有預約)45 分鐘 ⇒
--         起點不在整點 / 半點也照「整段必須落在可約範圍內」判斷;288 個候選在 2 秒內算完
--   ⑭   間隔 5 的清單 = 288 個起點裡 check_staff_booking_slot 不擋的那些(前後端同一套規則)
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

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

select plan(14);

set local statement_timeout = '5s';

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
  ('e9820000-0000-4000-8000-000000000001', 'pgtap-req980c-admin-a@test.local'),
  ('e9820000-0000-4000-8000-000000000002', 'pgtap-req980c-admin-b@test.local');
insert into groups (id) values
  ('e9820000-0000-4000-8000-000000000011'),
  ('e9820000-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type) values
  ('e9820000-0000-4000-8000-000000000021', 'e9820000-0000-4000-8000-000000000011', '間隔測試A店', 'in_store_beauty'),
  ('e9820000-0000-4000-8000-000000000022', 'e9820000-0000-4000-8000-000000000012', '間隔測試B店', 'in_store_beauty');
insert into merchant_admins (merchant_id, user_id) values
  ('e9820000-0000-4000-8000-000000000021', 'e9820000-0000-4000-8000-000000000001'),
  ('e9820000-0000-4000-8000-000000000022', 'e9820000-0000-4000-8000-000000000002');
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'e9820000-0000-4000-8000-000000000021'::uuid, d, false, '00:00', '23:59' from generate_series(0, 6) as d;
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, unlimited_backend_edit) values
  ('e9820000-0000-4000-8000-000000000031', 'e9820000-0000-4000-8000-000000000021', '服務人員N', '0900098201', true, false),
  ('e9820000-0000-4000-8000-000000000033', 'e9820000-0000-4000-8000-000000000021', '服務人員R', '0900098203', false, false);
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
select 'e9820000-0000-4000-8000-000000000033'::uuid, d, w.s::time, w.e::time
from generate_series(0, 6) as d, (values ('09:00', '12:00'), ('13:00', '18:00')) as w(s, e);
insert into staff_availability_overrides (staff_id, override_date, slot_start_time, is_available) values
  ('e9820000-0000-4000-8000-000000000033', '2026-12-09', '10:00', false);
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('e9820000-0000-4000-8000-000000000041', 'e9820000-0000-4000-8000-000000000021', '一小時', 1000, 'primary', 60);
insert into payment_methods (id, merchant_id, name) values
  ('e9820000-0000-4000-8000-000000000051', 'e9820000-0000-4000-8000-000000000021', '現場付款');
select seed_default_member_settings('e9820000-0000-4000-8000-000000000021');

select pg_temp.test_set_auth('e9820000-0000-4000-8000-000000000001');
select id from create_booking(
  p_merchant_id => 'e9820000-0000-4000-8000-000000000021',
  p_staff_id => 'e9820000-0000-4000-8000-000000000033',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e9820000-0000-4000-8000-000000000041','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-09 15:00:00+08',
  p_customer_name => '間隔測試客戶',
  p_customer_phone => '0955098201',
  p_payment_method_id => 'e9820000-0000-4000-8000-000000000051') \gset bk_
select pg_temp.test_clear_auth();

-- =========================================================================
-- ①~⑥ 權限
-- =========================================================================
select ok(
  not has_table_privilege('anon', 'public.merchant_booking_settings', 'select')
  and not has_table_privilege('anon', 'public.merchant_booking_settings', 'insert')
  and not has_table_privilege('anon', 'public.merchant_booking_settings', 'update'),
  '① anon 對 merchant_booking_settings 沒有任何權限');

select pg_temp.test_set_auth('e9820000-0000-4000-8000-000000000002');
select throws_ok(
  $$insert into public.merchant_booking_settings (merchant_id, start_time_interval_minutes)
    values ('e9820000-0000-4000-8000-000000000021', 5)$$,
  '42501', null,
  '② B 店管理員寫 A 店的間隔 ⇒ 被 RLS 擋下');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e9820000-0000-4000-8000-000000000001');
select lives_ok(
  $$insert into public.merchant_booking_settings (merchant_id, start_time_interval_minutes)
    values ('e9820000-0000-4000-8000-000000000021', 15)$$,
  '③ A 店管理員可以設定自己店的間隔');
select throws_ok(
  $$update public.merchant_booking_settings set start_time_interval_minutes = 7
    where merchant_id = 'e9820000-0000-4000-8000-000000000021'$$,
  '23514', null,
  '④ 只接受 5 / 10 / 15 / 30(7 ⇒ CHECK 擋下)');
select is(
  (select start_time_interval_minutes::int from public.merchant_booking_settings
   where merchant_id = 'e9820000-0000-4000-8000-000000000021'),
  15,
  '⑤ A 店管理員讀得到自己店的設定');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e9820000-0000-4000-8000-000000000002');
select is(
  (select count(*)::int from public.merchant_booking_settings
   where merchant_id = 'e9820000-0000-4000-8000-000000000021'),
  0,
  '⑥ B 店管理員讀不到 A 店的設定');
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑦ 沒有設定 ⇒ 30
-- =========================================================================
delete from public.merchant_booking_settings where merchant_id = 'e9820000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('e9820000-0000-4000-8000-000000000001');
select is(
  cardinality(public.list_staff_bookable_start_times('e9820000-0000-4000-8000-000000000021', 'e9820000-0000-4000-8000-000000000031', '2026-12-08', 30, null)),
  47,
  '⑦ 沒有設定 ⇒ 每 30 分鐘一個起點(00:00~23:00 共 47 個,23:30 起 30 分鐘會跨日;跟改版前一樣)');
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑧~⑩ 間隔 15
-- =========================================================================
insert into public.merchant_booking_settings (merchant_id, start_time_interval_minutes)
values ('e9820000-0000-4000-8000-000000000021', 15);
select pg_temp.test_set_auth('e9820000-0000-4000-8000-000000000001');
select is(
  public.list_staff_bookable_start_times('e9820000-0000-4000-8000-000000000021', 'e9820000-0000-4000-8000-000000000031', '2026-12-08', 45, null),
  (select array_agg(to_char(make_time(m / 60, m % 60, 0), 'HH24:MI') order by m) from generate_series(0, 1380, 15) as m),
  '⑧ 間隔 15、45 分鐘:00:00~23:00 每 15 分鐘一個(23:15 起會跨日)');
select ok(
  '23:00' = any(public.list_staff_bookable_start_times('e9820000-0000-4000-8000-000000000021', 'e9820000-0000-4000-8000-000000000031', '2026-12-08', 45, null))
  and not ('23:15' = any(public.list_staff_bookable_start_times('e9820000-0000-4000-8000-000000000021', 'e9820000-0000-4000-8000-000000000031', '2026-12-08', 45, null))),
  '⑨ 間隔 15:23:00 起(結束 23:45)列得出來、不會卡住;23:15 起(結束 24:00)跨日不列');
select is(
  public.list_staff_bookable_start_times('e9820000-0000-4000-8000-000000000021', 'e9820000-0000-4000-8000-000000000033', '2026-12-09', 45, null),
  array['09:00','09:15','10:30','10:45','11:00','11:15','13:00','13:15','13:30','13:45','14:00','14:15','16:00','16:15','16:30','16:45','17:00','17:15']::text[],
  '⑩ 間隔 15、R、45 分鐘:避開 10:00~10:30 排休(09:30、09:45、10:00、10:15 起會碰到)、12:00 之後、15:00 的預約、18:00 之後');
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑪~⑭ 間隔 5
-- =========================================================================
update public.merchant_booking_settings set start_time_interval_minutes = 5
where merchant_id = 'e9820000-0000-4000-8000-000000000021';

create temporary table timing (ms numeric, result text[]);
grant all on timing to authenticated;
select pg_temp.test_set_auth('e9820000-0000-4000-8000-000000000001');
do $$
declare t0 timestamptz := clock_timestamp(); r text[];
begin
  r := public.list_staff_bookable_start_times('e9820000-0000-4000-8000-000000000021', 'e9820000-0000-4000-8000-000000000033', '2026-12-09', 45, null);
  insert into timing values (extract(epoch from clock_timestamp() - t0) * 1000, r);
end;
$$;
select pg_temp.test_clear_auth();

select diag('間隔 5 分鐘(288 個候選)本機耗時:' || round((select ms from timing))::text || ' ms');
select ok((select ms from timing) < 2000, '⑪ 間隔 5 分鐘、288 個候選在 2 秒內算完');
select ok(
  (select '09:05' = any(result) and '09:15' = any(result) and not ('09:20' = any(result))
     and '11:15' = any(result) and not ('11:20' = any(result)) from timing),
  '⑫ 起點不在整點:09:05 / 09:15 可以;09:20 起(到 10:05)碰到 10:00 排休不行;11:15 可以、11:20(到 12:05)超出時段不行');
select ok(
  (select '14:15' = any(result) and not ('14:20' = any(result)) and not ('12:50' = any(result))
     and '13:00' = any(result) and '17:15' = any(result) and not ('17:20' = any(result)) from timing),
  '⑬ 14:15(到 15:00)可以、14:20 跟 15:00 的預約重疊不行;12:50 還沒到時段不行;17:15 可以、17:20(到 18:05)不行');

create function pg_temp.slot_passes(p_minutes integer) returns boolean
language plpgsql as $$
declare
  v_staff public.merchant_staff;
  v_start timestamptz := ('2026-12-09'::timestamp + make_interval(mins => p_minutes)) at time zone 'Asia/Taipei';
begin
  select * into v_staff from public.merchant_staff where id = 'e9820000-0000-4000-8000-000000000033';
  perform private.check_staff_booking_slot('e9820000-0000-4000-8000-000000000021', v_staff, v_start,
    v_start + interval '45 minutes', null, '主要服務人員');
  return true;
exception when raise_exception then
  return false;
end;
$$;
select is(
  (select result from timing),
  (select array_agg(to_char(make_time(m / 60, m % 60, 0), 'HH24:MI') order by m)
   from generate_series(0, 1435, 5) as m where pg_temp.slot_passes(m)),
  '⑭ 間隔 5 的清單 = 288 個起點裡 check_staff_booking_slot 不擋的那些');

select * from finish();
rollback;
