-- 客戶端第 1 批 — C1-C02 public.get_public_available_slots / private.check_customer_booking_slot(B 區全部)
-- 規格書 .project/specs/客戶端第1批-公開預約頁.md
--
--   B01  等價測試:同一組資料(沒開 no_time_slot_limit、unlimited_backend_edit 關、提前 0 天 0 小時、
--        最遠不限、車程 0)客戶版與後台 list_staff_bookable_start_times 回傳完全相同;
--        6 種情境:單日例外開、單日例外關、請假、既有訂單、助手訂單、同集團他店重疊;另加工時 90 分、間隔 15 分
--        差異:unlimited_backend_edit 對客戶端無效;strict_conflict_check 關掉時客戶端仍擋重疊
--   B02  最少提前天數 / 最遠可預約天數(空值 = 60)
--   B03  no_time_slot_limit:跳過每週時段、營業時間照守、請假照擋
--   B04  至少提前幾小時(固定「現在時間」用 private.public_available_slots_at)
--   B05  未上架 / 已移除 / 別家店的服務人員 ⇒ 同一個錯誤代碼與訊息
--   B06  會不會做這些服務(只檢查主要項目)
--   B07  不指定 = 合併;回傳搜不到服務人員 id / 名字
--   B08  車程緩衝(只到府);後台清單不受影響
--   F04  p_days = 8、p_items 51 筆等輸入防護
--   C02  效能:10 位上架服務人員、間隔 5 分、不指定、7 天(最壞情境:每個候選都要問完 10 個人)< 2 秒
begin;

select plan(55);

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

-- 基準日 d(0) = 台北今天 + 14 天(在「最遠可預約」預設 60 天內)
create temp table c1_ctx as select ((now() at time zone 'Asia/Taipei')::date + 14) as d0;
grant select on c1_ctx to anon, authenticated;
create function pg_temp.d(n integer) returns date language sql stable as $$ select d0 + n from c1_ctx $$;
create function pg_temp.ts(n integer, t time) returns timestamptz language sql stable as
  $$ select ((select d0 from c1_ctx) + n + t) at time zone 'Asia/Taipei' $$;
create function pg_temp.items1(p_item uuid, p_qty integer default 1) returns jsonb language sql immutable as
  $$ select jsonb_build_array(jsonb_build_object('service_item_id', p_item, 'quantity', p_qty)) $$;
-- 客戶版:某天的時間清單(text[])
create function pg_temp.cust(p_slug text, p_items jsonb, p_staff uuid, p_n integer, p_now timestamptz default now())
returns text[] language sql stable as $$
  select coalesce(array(select jsonb_array_elements_text(
    private.public_available_slots_at(p_slug, p_items, p_staff, pg_temp.d(p_n), 1, p_now) -> 'days' -> 0 -> 'times')), '{}')
$$;
create function pg_temp.cust_state(p_slug text, p_items jsonb, p_staff uuid, p_n integer, p_now timestamptz default now())
returns text language sql stable as $$
  select private.public_available_slots_at(p_slug, p_items, p_staff, pg_temp.d(p_n), 1, p_now) -> 'days' -> 0 ->> 'state'
$$;

-- =========================================================================
-- Fixture
-- =========================================================================
insert into auth.users (id, email) values
  ('c1500000-0000-4000-8000-000000000001', 'pgtap-c1slots-admin-eq@test.local'),
  ('c1500000-0000-4000-8000-000000000002', 'pgtap-c1slots-admin-trv@test.local');

insert into groups (id) values
  ('c1500000-0000-4000-8000-000000000011'),
  ('c1500000-0000-4000-8000-000000000012'),
  ('c1500000-0000-4000-8000-000000000013');

-- 商家:EQ / EQ2 同集團;WIN、LEAD、UNI、TRV(到府)、TRV2(到店)、PERF 各自
insert into merchants (id, group_id, name, industry_type, booking_slug) values
  ('c1500000-0000-4000-8000-000000000021', 'c1500000-0000-4000-8000-000000000011', '等價A店', 'in_store_beauty', 'pgtap-c1s-eq'),
  ('c1500000-0000-4000-8000-000000000022', 'c1500000-0000-4000-8000-000000000011', '等價A2店', 'in_store_beauty', 'pgtap-c1s-eq2'),
  ('c1500000-0000-4000-8000-000000000023', 'c1500000-0000-4000-8000-000000000012', '範圍店', 'in_store_beauty', 'pgtap-c1s-win'),
  ('c1500000-0000-4000-8000-000000000024', 'c1500000-0000-4000-8000-000000000012', '提前店', 'in_store_beauty', 'pgtap-c1s-lead'),
  ('c1500000-0000-4000-8000-000000000025', 'c1500000-0000-4000-8000-000000000012', '合併店', 'in_store_beauty', 'pgtap-c1s-uni'),
  ('c1500000-0000-4000-8000-000000000026', 'c1500000-0000-4000-8000-000000000013', '到府車程店', 'on_site_dispatch', 'pgtap-c1s-trv'),
  ('c1500000-0000-4000-8000-000000000027', 'c1500000-0000-4000-8000-000000000013', '到店車程店', 'in_store_beauty', 'pgtap-c1s-trv2'),
  ('c1500000-0000-4000-8000-000000000028', 'c1500000-0000-4000-8000-000000000013', '效能店', 'in_store_beauty', 'pgtap-c1s-perf');
insert into merchant_admins (merchant_id, user_id) values
  ('c1500000-0000-4000-8000-000000000021', 'c1500000-0000-4000-8000-000000000001'),
  ('c1500000-0000-4000-8000-000000000026', 'c1500000-0000-4000-8000-000000000002');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select m, d, false, '09:00', '18:00'
from generate_series(0, 6) d,
     unnest(array['c1500000-0000-4000-8000-000000000021', 'c1500000-0000-4000-8000-000000000022',
                  'c1500000-0000-4000-8000-000000000023', 'c1500000-0000-4000-8000-000000000025']::uuid[]) m;
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select m, d, false, '08:00', '18:00'
from generate_series(0, 6) d,
     unnest(array['c1500000-0000-4000-8000-000000000024', 'c1500000-0000-4000-8000-000000000026',
                  'c1500000-0000-4000-8000-000000000027']::uuid[]) m;
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'c1500000-0000-4000-8000-000000000028'::uuid, d, false, '08:00', '22:00' from generate_series(0, 6) d;

-- 等價 / 範圍 / 合併 / 車程店:提前 0 小時;提前店:2 小時、間隔 5 分;車程店:60 分;效能店:間隔 5 分
insert into merchant_booking_settings (merchant_id, start_time_interval_minutes, min_lead_hours, travel_buffer_minutes) values
  ('c1500000-0000-4000-8000-000000000021', 30, 0, 0),
  ('c1500000-0000-4000-8000-000000000023', 30, 0, 0),
  ('c1500000-0000-4000-8000-000000000024', 5, 2, 0),
  ('c1500000-0000-4000-8000-000000000025', 30, 0, 0),
  ('c1500000-0000-4000-8000-000000000026', 30, 0, 60),
  ('c1500000-0000-4000-8000-000000000027', 30, 0, 60),
  ('c1500000-0000-4000-8000-000000000028', 5, 0, 0);

-- 服務人員
insert into merchant_staff (id, merchant_id, name, nickname, phone, is_listed, status, advance_booking_days, booking_window_max_days) values
  ('c1500000-0000-4000-8000-000000000031', 'c1500000-0000-4000-8000-000000000021', '等價S1本名', null, '0900162001', true, 'active', null, 365),
  ('c1500000-0000-4000-8000-000000000032', 'c1500000-0000-4000-8000-000000000021', '等價S2本名', null, '0900162002', true, 'active', null, 365),
  ('c1500000-0000-4000-8000-000000000033', 'c1500000-0000-4000-8000-000000000022', '等價S1分身', null, '0900162001', true, 'active', null, null),
  ('c1500000-0000-4000-8000-000000000041', 'c1500000-0000-4000-8000-000000000023', '範圍W1', null, '0900162011', true, 'active', 1, null),
  ('c1500000-0000-4000-8000-000000000042', 'c1500000-0000-4000-8000-000000000023', '範圍W2', null, '0900162012', true, 'active', null, 7),
  ('c1500000-0000-4000-8000-000000000043', 'c1500000-0000-4000-8000-000000000023', '範圍W3', null, '0900162013', true, 'active', null, null),
  ('c1500000-0000-4000-8000-000000000044', 'c1500000-0000-4000-8000-000000000023', '範圍W4', null, '0900162014', true, 'active', null, null),
  ('c1500000-0000-4000-8000-000000000045', 'c1500000-0000-4000-8000-000000000023', '範圍W5未上架', null, '0900162015', false, 'active', null, null),
  ('c1500000-0000-4000-8000-000000000046', 'c1500000-0000-4000-8000-000000000023', '範圍W6已移除', null, '0900162016', true, 'removed', null, null),
  ('c1500000-0000-4000-8000-000000000047', 'c1500000-0000-4000-8000-000000000023', '範圍W7只會P1', null, '0900162017', true, 'active', null, null),
  ('c1500000-0000-4000-8000-000000000048', 'c1500000-0000-4000-8000-000000000023', '範圍W8會P1P2', null, '0900162018', true, 'active', null, null),
  ('c1500000-0000-4000-8000-000000000049', 'c1500000-0000-4000-8000-000000000024', '提前L1', null, '0900162019', true, 'active', null, null),
  ('c1500000-0000-4000-8000-000000000051', 'c1500000-0000-4000-8000-000000000025', 'UNI_STAFF_A_REALNAME', '合併阿明', '0900162021', true, 'active', null, null),
  ('c1500000-0000-4000-8000-000000000052', 'c1500000-0000-4000-8000-000000000025', 'UNI_STAFF_B_REALNAME', '合併小陳', '0900162022', true, 'active', null, null),
  ('c1500000-0000-4000-8000-000000000061', 'c1500000-0000-4000-8000-000000000026', '車程T1', null, '0900162031', true, 'active', null, null),
  ('c1500000-0000-4000-8000-000000000062', 'c1500000-0000-4000-8000-000000000027', '車程T2', null, '0900162032', true, 'active', null, null);
insert into merchant_staff (id, merchant_id, name, phone, is_listed, status)
select ('c1500000-0000-4000-8000-0000000007' || lpad(i::text, 2, '0'))::uuid,
       'c1500000-0000-4000-8000-000000000028', '效能P' || i, '09001627' || lpad(i::text, 2, '0'), true, 'active'
from generate_series(1, 10) i;

-- 每週時段
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
select s, d, '10:00', '16:00' from generate_series(0, 6) d, unnest(array['c1500000-0000-4000-8000-000000000031']::uuid[]) s;
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
select s, d, '09:00', '18:00' from generate_series(0, 6) d,
  unnest(array['c1500000-0000-4000-8000-000000000032', 'c1500000-0000-4000-8000-000000000033',
               'c1500000-0000-4000-8000-000000000041', 'c1500000-0000-4000-8000-000000000042',
               'c1500000-0000-4000-8000-000000000043', 'c1500000-0000-4000-8000-000000000045',
               'c1500000-0000-4000-8000-000000000046', 'c1500000-0000-4000-8000-000000000047',
               'c1500000-0000-4000-8000-000000000048']::uuid[]) s;
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
select 'c1500000-0000-4000-8000-000000000044'::uuid, d, '09:00', '12:00' from generate_series(0, 6) d;
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
select s, d, '08:00', '18:00' from generate_series(0, 6) d,
  unnest(array['c1500000-0000-4000-8000-000000000049', 'c1500000-0000-4000-8000-000000000061',
               'c1500000-0000-4000-8000-000000000062']::uuid[]) s;
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
select 'c1500000-0000-4000-8000-000000000051'::uuid, d, '09:00', '12:00' from generate_series(0, 6) d;
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
select 'c1500000-0000-4000-8000-000000000052'::uuid, d, '13:00', '18:00' from generate_series(0, 6) d;
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
select s.id, d, '08:00', '22:00' from generate_series(0, 6) d, merchant_staff s
where s.merchant_id = 'c1500000-0000-4000-8000-000000000028';

-- 服務項目
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('c1500000-0000-4000-8000-000000000081', 'c1500000-0000-4000-8000-000000000021', '等價60分', 1000, 'primary', 60),
  ('c1500000-0000-4000-8000-000000000082', 'c1500000-0000-4000-8000-000000000021', '等價30分', 500, 'primary', 30),
  ('c1500000-0000-4000-8000-000000000083', 'c1500000-0000-4000-8000-000000000023', '範圍P1', 1000, 'primary', 60),
  ('c1500000-0000-4000-8000-000000000084', 'c1500000-0000-4000-8000-000000000023', '範圍P2', 1000, 'primary', 30),
  ('c1500000-0000-4000-8000-000000000085', 'c1500000-0000-4000-8000-000000000023', '範圍A1加購', 100, 'addon', 30),
  ('c1500000-0000-4000-8000-000000000086', 'c1500000-0000-4000-8000-000000000024', '提前60分', 1000, 'primary', 60),
  ('c1500000-0000-4000-8000-000000000087', 'c1500000-0000-4000-8000-000000000025', '合併60分', 1000, 'primary', 60),
  ('c1500000-0000-4000-8000-000000000088', 'c1500000-0000-4000-8000-000000000026', '車程60分', 1000, 'primary', 60),
  ('c1500000-0000-4000-8000-000000000089', 'c1500000-0000-4000-8000-000000000027', '車程到店60分', 1000, 'primary', 60),
  ('c1500000-0000-4000-8000-000000000090', 'c1500000-0000-4000-8000-000000000028', '效能120分', 1000, 'primary', 120),
  ('c1500000-0000-4000-8000-000000000091', 'c1500000-0000-4000-8000-000000000021', '等價0分', 0, 'primary', 0);

insert into merchant_staff_service_items (staff_id, service_item_id) values
  ('c1500000-0000-4000-8000-000000000047', 'c1500000-0000-4000-8000-000000000083'),
  ('c1500000-0000-4000-8000-000000000048', 'c1500000-0000-4000-8000-000000000083'),
  ('c1500000-0000-4000-8000-000000000048', 'c1500000-0000-4000-8000-000000000084');

-- 假別 / 請假
insert into merchant_leave_types (id, merchant_id, name) values
  ('c1500000-0000-4000-8000-000000000101', 'c1500000-0000-4000-8000-000000000021', '特休'),
  ('c1500000-0000-4000-8000-000000000102', 'c1500000-0000-4000-8000-000000000023', '特休'),
  ('c1500000-0000-4000-8000-000000000103', 'c1500000-0000-4000-8000-000000000025', '特休');
insert into staff_leave_records (staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date, status) values
  ('c1500000-0000-4000-8000-000000000031', 'c1500000-0000-4000-8000-000000000101', '特休', pg_temp.d(2), pg_temp.d(2), 'confirmed'),
  ('c1500000-0000-4000-8000-000000000044', 'c1500000-0000-4000-8000-000000000102', '特休', pg_temp.d(3), pg_temp.d(3), 'confirmed'),
  ('c1500000-0000-4000-8000-000000000051', 'c1500000-0000-4000-8000-000000000103', '特休', pg_temp.d(2), pg_temp.d(2), 'confirmed');

-- 等價店 S1 的單日例外:d0 例外開 17:00、17:30(時段外、營業內)與 08:00、08:30(營業外);d1 例外關 12:00
insert into staff_availability_overrides (staff_id, override_date, slot_start_time, is_available) values
  ('c1500000-0000-4000-8000-000000000031', pg_temp.d(0), '17:00', true),
  ('c1500000-0000-4000-8000-000000000031', pg_temp.d(0), '17:30', true),
  ('c1500000-0000-4000-8000-000000000031', pg_temp.d(0), '08:00', true),
  ('c1500000-0000-4000-8000-000000000031', pg_temp.d(0), '08:30', true),
  ('c1500000-0000-4000-8000-000000000031', pg_temp.d(1), '12:00', false);

-- 訂單:d3 S1 14:00-15:00;d4 S2 11:00-12:00(S1 當助手);d5 同集團分身 13:00-14:00;
--       車程店 d1 10:00-12:00;效能店每人 d0~d6 08:00-22:00(全滿)
insert into bookings (id, merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role) values
  ('c1500000-0000-4000-8000-000000000201', 'c1500000-0000-4000-8000-000000000021', 'c1500000-0000-4000-8000-000000000031',
   pg_temp.ts(3, '14:00'), pg_temp.ts(3, '15:00'), '客戶', '0955162001', 'admin'),
  ('c1500000-0000-4000-8000-000000000202', 'c1500000-0000-4000-8000-000000000021', 'c1500000-0000-4000-8000-000000000032',
   pg_temp.ts(4, '11:00'), pg_temp.ts(4, '12:00'), '客戶', '0955162002', 'admin'),
  ('c1500000-0000-4000-8000-000000000203', 'c1500000-0000-4000-8000-000000000022', 'c1500000-0000-4000-8000-000000000033',
   pg_temp.ts(5, '13:00'), pg_temp.ts(5, '14:00'), '客戶', '0955162003', 'admin'),
  ('c1500000-0000-4000-8000-000000000204', 'c1500000-0000-4000-8000-000000000026', 'c1500000-0000-4000-8000-000000000061',
   pg_temp.ts(1, '10:00'), pg_temp.ts(1, '12:00'), '客戶', '0955162004', 'admin'),
  ('c1500000-0000-4000-8000-000000000205', 'c1500000-0000-4000-8000-000000000027', 'c1500000-0000-4000-8000-000000000062',
   pg_temp.ts(1, '10:00'), pg_temp.ts(1, '12:00'), '客戶', '0955162005', 'admin');
insert into booking_assistants (booking_id, staff_id) values
  ('c1500000-0000-4000-8000-000000000202', 'c1500000-0000-4000-8000-000000000031');
insert into bookings (merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role)
select 'c1500000-0000-4000-8000-000000000028', s.id, pg_temp.ts(n, '08:00'), pg_temp.ts(n, '22:00'), '客戶', '0955162009', 'admin'
from merchant_staff s, generate_series(0, 6) n
where s.merchant_id = 'c1500000-0000-4000-8000-000000000028';

-- 後台清單(要以管理員身分呼叫)先存起來
create temp table c1_backend (k text primary key, times text[]);
grant all on c1_backend to authenticated;
select pg_temp.test_set_auth('c1500000-0000-4000-8000-000000000001');
insert into c1_backend
select 'eq60_' || n, public.list_staff_bookable_start_times(
         'c1500000-0000-4000-8000-000000000021', 'c1500000-0000-4000-8000-000000000031', pg_temp.d(n), 60)
from generate_series(0, 5) n;
insert into c1_backend
select 'eq90_' || n, public.list_staff_bookable_start_times(
         'c1500000-0000-4000-8000-000000000021', 'c1500000-0000-4000-8000-000000000031', pg_temp.d(n), 90)
from generate_series(0, 5) n;
select pg_temp.test_clear_auth();

-- =========================================================================
-- B01 等價測試
-- =========================================================================
select is(pg_temp.cust('pgtap-c1s-eq', pg_temp.items1('c1500000-0000-4000-8000-000000000081'), 'c1500000-0000-4000-8000-000000000031', 0),
          (select times from c1_backend where k = 'eq60_0'), 'B01-1 單日例外開啟:客戶版 = 後台版');
select is(pg_temp.cust('pgtap-c1s-eq', pg_temp.items1('c1500000-0000-4000-8000-000000000081'), 'c1500000-0000-4000-8000-000000000031', 1),
          (select times from c1_backend where k = 'eq60_1'), 'B01-2 單日例外關閉:客戶版 = 後台版');
select is(pg_temp.cust('pgtap-c1s-eq', pg_temp.items1('c1500000-0000-4000-8000-000000000081'), 'c1500000-0000-4000-8000-000000000031', 2),
          (select times from c1_backend where k = 'eq60_2'), 'B01-3 請假:客戶版 = 後台版');
select is(pg_temp.cust('pgtap-c1s-eq', pg_temp.items1('c1500000-0000-4000-8000-000000000081'), 'c1500000-0000-4000-8000-000000000031', 3),
          (select times from c1_backend where k = 'eq60_3'), 'B01-4 既有訂單:客戶版 = 後台版');
select is(pg_temp.cust('pgtap-c1s-eq', pg_temp.items1('c1500000-0000-4000-8000-000000000081'), 'c1500000-0000-4000-8000-000000000031', 4),
          (select times from c1_backend where k = 'eq60_4'), 'B01-5 助手訂單:客戶版 = 後台版');
select is(pg_temp.cust('pgtap-c1s-eq', pg_temp.items1('c1500000-0000-4000-8000-000000000081'), 'c1500000-0000-4000-8000-000000000031', 5),
          (select times from c1_backend where k = 'eq60_5'), 'B01-6 同集團他店重疊:客戶版 = 後台版');
select is(
  (select array_agg(array_to_string(pg_temp.cust('pgtap-c1s-eq',
            jsonb_build_array(jsonb_build_object('service_item_id', 'c1500000-0000-4000-8000-000000000081', 'quantity', 1),
                              jsonb_build_object('service_item_id', 'c1500000-0000-4000-8000-000000000082', 'quantity', 1)),
            'c1500000-0000-4000-8000-000000000031', n), ',') order by n) from generate_series(0, 5) n),
  (select array_agg(array_to_string(times, ',') order by k) from c1_backend where k like 'eq90_%'),
  'B01-7 工時 90 分(兩項相加)6 天全部一致');
-- 情境本身有生效(避免兩邊都回空陣列的假等價)
select ok(
  (select times from c1_backend where k = 'eq60_0') @> array['08:00', '17:00']
  and not ((select times from c1_backend where k = 'eq60_1') @> array['12:00'])
  and cardinality((select times from c1_backend where k = 'eq60_2')) = 0
  and not ((select times from c1_backend where k = 'eq60_3') @> array['14:00'])
  and not ((select times from c1_backend where k = 'eq60_4') @> array['11:00'])
  and not ((select times from c1_backend where k = 'eq60_5') @> array['13:00'])
  and (select times from c1_backend where k = 'eq60_5') @> array['10:00', '12:00', '14:00'],
  'B01-8 六種情境都真的有改變結果(不是兩邊剛好都空)');

-- 間隔 15 分也一致
update merchant_booking_settings set start_time_interval_minutes = 15 where merchant_id = 'c1500000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('c1500000-0000-4000-8000-000000000001');
insert into c1_backend
select 'eq15_' || n, public.list_staff_bookable_start_times(
         'c1500000-0000-4000-8000-000000000021', 'c1500000-0000-4000-8000-000000000031', pg_temp.d(n), 60)
from generate_series(0, 5) n;
select pg_temp.test_clear_auth();
select is(
  (select array_agg(array_to_string(pg_temp.cust('pgtap-c1s-eq', pg_temp.items1('c1500000-0000-4000-8000-000000000081'),
            'c1500000-0000-4000-8000-000000000031', n), ',') order by n) from generate_series(0, 5) n),
  (select array_agg(array_to_string(times, ',') order by k) from c1_backend where k like 'eq15_%'),
  'B01-9 建單間隔 15 分:6 天全部一致');
update merchant_booking_settings set start_time_interval_minutes = 30 where merchant_id = 'c1500000-0000-4000-8000-000000000021';

-- 差異 1:unlimited_backend_edit 對客戶端無效
update merchant_staff set unlimited_backend_edit = true where id = 'c1500000-0000-4000-8000-000000000031';
select is(pg_temp.cust('pgtap-c1s-eq', pg_temp.items1('c1500000-0000-4000-8000-000000000081'), 'c1500000-0000-4000-8000-000000000031', 3),
          (select times from c1_backend where k = 'eq60_3'), 'B01-10 unlimited_backend_edit 開著,客戶版結果不變');
select pg_temp.test_set_auth('c1500000-0000-4000-8000-000000000001');
select ok(
  public.list_staff_bookable_start_times('c1500000-0000-4000-8000-000000000021', 'c1500000-0000-4000-8000-000000000031', pg_temp.d(3), 60)
    @> array['00:00', '20:00'],
  'B01-11 對照:後台版在 unlimited_backend_edit 開時確實會放寬(00:00、20:00 都列)');
select pg_temp.test_clear_auth();
update merchant_staff set unlimited_backend_edit = false where id = 'c1500000-0000-4000-8000-000000000031';

-- 差異 2:strict_conflict_check 關掉時客戶端仍擋重疊
insert into merchant_feature_flags (merchant_id, feature_key, enabled)
values ('c1500000-0000-4000-8000-000000000021', 'strict_conflict_check', false)
on conflict (merchant_id, feature_key) do update set enabled = false;
select ok(
  not (pg_temp.cust('pgtap-c1s-eq', pg_temp.items1('c1500000-0000-4000-8000-000000000081'), 'c1500000-0000-4000-8000-000000000031', 3) @> array['14:00']),
  'B01-12 嚴格衝突檢查關掉,客戶端仍不列已有訂單的 14:00');
select pg_temp.test_set_auth('c1500000-0000-4000-8000-000000000001');
select ok(
  public.list_staff_bookable_start_times('c1500000-0000-4000-8000-000000000021', 'c1500000-0000-4000-8000-000000000031', pg_temp.d(3), 60)
    @> array['14:00'],
  'B01-13 對照:後台版在嚴格衝突檢查關掉時會列 14:00');
select pg_temp.test_clear_auth();
update merchant_feature_flags set enabled = true
where merchant_id = 'c1500000-0000-4000-8000-000000000021' and feature_key = 'strict_conflict_check';

-- =========================================================================
-- B02 最少提前天數 / 最遠可預約天數(固定現在 = d0 10:00,提前 0 小時)
-- =========================================================================
select is(pg_temp.cust_state('pgtap-c1s-win', pg_temp.items1('c1500000-0000-4000-8000-000000000083'), 'c1500000-0000-4000-8000-000000000041', 0, pg_temp.ts(0, '10:00')),
          'out_of_range', 'B02-1 提前 1 天:今天整天範圍外');
select ok(cardinality(pg_temp.cust('pgtap-c1s-win', pg_temp.items1('c1500000-0000-4000-8000-000000000083'), 'c1500000-0000-4000-8000-000000000041', 1, pg_temp.ts(0, '10:00'))) > 0,
          'B02-2 提前 1 天:明天有時段');
select ok(cardinality(pg_temp.cust('pgtap-c1s-win', pg_temp.items1('c1500000-0000-4000-8000-000000000083'), 'c1500000-0000-4000-8000-000000000042', 7, pg_temp.ts(0, '10:00'))) > 0,
          'B02-3 最遠 7 天:第 7 天有時段');
select is(pg_temp.cust_state('pgtap-c1s-win', pg_temp.items1('c1500000-0000-4000-8000-000000000083'), 'c1500000-0000-4000-8000-000000000042', 8, pg_temp.ts(0, '10:00')),
          'out_of_range', 'B02-4 最遠 7 天:第 8 天範圍外');
select ok(cardinality(pg_temp.cust('pgtap-c1s-win', pg_temp.items1('c1500000-0000-4000-8000-000000000083'), 'c1500000-0000-4000-8000-000000000043', 60, pg_temp.ts(0, '10:00'))) > 0,
          'B02-5 空值 = 60 天:第 60 天有時段');
select is(pg_temp.cust_state('pgtap-c1s-win', pg_temp.items1('c1500000-0000-4000-8000-000000000083'), 'c1500000-0000-4000-8000-000000000043', 61, pg_temp.ts(0, '10:00')),
          'out_of_range', 'B02-6 空值 = 60 天:第 61 天範圍外');
select is(pg_temp.cust_state('pgtap-c1s-win', pg_temp.items1('c1500000-0000-4000-8000-000000000083'), 'c1500000-0000-4000-8000-000000000043', -1, pg_temp.ts(0, '10:00')),
          'out_of_range', 'B02-7 早於今天的日期 = 範圍外');

-- =========================================================================
-- B03 no_time_slot_limit(W4:每週時段 09-12,營業 09-18)
-- =========================================================================
select ok(not (pg_temp.cust('pgtap-c1s-win', pg_temp.items1('c1500000-0000-4000-8000-000000000083'), 'c1500000-0000-4000-8000-000000000044', 2) @> array['14:00']),
          'B03-1 關閉時 14:00 不列');
update merchant_staff set no_time_slot_limit = true where id = 'c1500000-0000-4000-8000-000000000044';
select ok(pg_temp.cust('pgtap-c1s-win', pg_temp.items1('c1500000-0000-4000-8000-000000000083'), 'c1500000-0000-4000-8000-000000000044', 2) @> array['14:00', '17:00'],
          'B03-2 開啟時 14:00、17:00 列出(每週時段外但營業時間內)');
select ok(not (pg_temp.cust('pgtap-c1s-win', pg_temp.items1('c1500000-0000-4000-8000-000000000083'), 'c1500000-0000-4000-8000-000000000044', 2) && array['17:30', '18:00', '19:00', '08:30']),
          'B03-3 開啟時營業時間外(17:30 開始做 60 分、19:00、08:30)仍不列');
select is(cardinality(pg_temp.cust('pgtap-c1s-win', pg_temp.items1('c1500000-0000-4000-8000-000000000083'), 'c1500000-0000-4000-8000-000000000044', 3)),
          0, 'B03-4 開啟時請假日仍全部不列');
update merchant_staff set no_time_slot_limit = false where id = 'c1500000-0000-4000-8000-000000000044';
select ok(not (pg_temp.cust('pgtap-c1s-eq', pg_temp.items1('c1500000-0000-4000-8000-000000000081'), 'c1500000-0000-4000-8000-000000000031', 1) @> array['12:00'])
          and (select times from c1_backend where k = 'eq60_1') @> array['11:00'],
          'B03-5 單日例外臨時關閉照擋(對照組:11:00 有)');

-- =========================================================================
-- B04 至少提前幾小時(提前店:2 小時、間隔 5 分;現在 = d0 10:00)
-- =========================================================================
select ok(
  not (pg_temp.cust('pgtap-c1s-lead', pg_temp.items1('c1500000-0000-4000-8000-000000000086'), 'c1500000-0000-4000-8000-000000000049', 0, pg_temp.ts(0, '10:00')) && array['11:30', '11:55'])
  and pg_temp.cust('pgtap-c1s-lead', pg_temp.items1('c1500000-0000-4000-8000-000000000086'), 'c1500000-0000-4000-8000-000000000049', 0, pg_temp.ts(0, '10:00')) @> array['12:00'],
  'B04-1 設 2 小時、10:00 查:11:30 / 11:55 不列,12:00 列');
select is(
  (pg_temp.cust('pgtap-c1s-lead', pg_temp.items1('c1500000-0000-4000-8000-000000000086'), 'c1500000-0000-4000-8000-000000000049', 0, pg_temp.ts(0, '10:00')))[1],
  '12:00', 'B04-2 設 2 小時:當天第一個可約時間就是 12:00');
update merchant_booking_settings set min_lead_hours = 0 where merchant_id = 'c1500000-0000-4000-8000-000000000024';
select ok(
  pg_temp.cust('pgtap-c1s-lead', pg_temp.items1('c1500000-0000-4000-8000-000000000086'), 'c1500000-0000-4000-8000-000000000049', 0, pg_temp.ts(0, '10:00')) @> array['10:00', '10:05']
  and not (pg_temp.cust('pgtap-c1s-lead', pg_temp.items1('c1500000-0000-4000-8000-000000000086'), 'c1500000-0000-4000-8000-000000000049', 0, pg_temp.ts(0, '10:00')) @> array['09:55']),
  'B04-3 設 0:10:00、10:05 列,已經過去的 09:55 不列');
select ok(
  pg_temp.cust('pgtap-c1s-lead', pg_temp.items1('c1500000-0000-4000-8000-000000000086'), 'c1500000-0000-4000-8000-000000000049', 1, pg_temp.ts(0, '10:00')) @> array['08:00'],
  'B04-4 提前小時只影響今天附近:明天 08:00 照常列');
delete from merchant_booking_settings where merchant_id = 'c1500000-0000-4000-8000-000000000024';
select ok(
  not (pg_temp.cust('pgtap-c1s-lead', pg_temp.items1('c1500000-0000-4000-8000-000000000086'), 'c1500000-0000-4000-8000-000000000049', 0, pg_temp.ts(0, '10:00')) && array['11:30', '11:55'])
  and pg_temp.cust('pgtap-c1s-lead', pg_temp.items1('c1500000-0000-4000-8000-000000000086'), 'c1500000-0000-4000-8000-000000000049', 0, pg_temp.ts(0, '10:00')) @> array['12:00'],
  'B04-5 沒有設定列的商家 = 預設 2 小時');

-- 第 3 批送出預約會直接呼叫 private.check_customer_booking_slot(不經過清單的預先略過),
-- 所以每條規則在這支函式本身也要成立(故障注入:拿掉函式內的提前小時判斷,這條會紅)
select is(
  array[
    private.check_customer_booking_slot('c1500000-0000-4000-8000-000000000024',
      (select s from merchant_staff s where id = 'c1500000-0000-4000-8000-000000000049'),
      pg_temp.ts(0, '11:55'), pg_temp.ts(0, '12:55'), pg_temp.ts(0, '10:00')),
    coalesce(private.check_customer_booking_slot('c1500000-0000-4000-8000-000000000024',
      (select s from merchant_staff s where id = 'c1500000-0000-4000-8000-000000000049'),
      pg_temp.ts(0, '12:00'), pg_temp.ts(0, '13:00'), pg_temp.ts(0, '10:00')), 'OK'),
    private.check_customer_booking_slot('c1500000-0000-4000-8000-000000000023',
      (select s from merchant_staff s where id = 'c1500000-0000-4000-8000-000000000041'),
      pg_temp.ts(0, '15:00'), pg_temp.ts(0, '16:00'), pg_temp.ts(0, '10:00')),
    private.check_customer_booking_slot('c1500000-0000-4000-8000-000000000023',
      (select s from merchant_staff s where id = 'c1500000-0000-4000-8000-000000000044'),
      pg_temp.ts(3, '10:00'), pg_temp.ts(3, '11:00'), pg_temp.ts(0, '10:00')),
    private.check_customer_booking_slot('c1500000-0000-4000-8000-000000000023',
      (select s from merchant_staff s where id = 'c1500000-0000-4000-8000-000000000045'),
      pg_temp.ts(1, '10:00'), pg_temp.ts(1, '11:00'), pg_temp.ts(0, '10:00')),
    private.check_customer_booking_slot('c1500000-0000-4000-8000-000000000026',
      (select s from merchant_staff s where id = 'c1500000-0000-4000-8000-000000000061'),
      pg_temp.ts(1, '12:30'), pg_temp.ts(1, '13:30'), pg_temp.ts(0, '10:00'))
  ],
  array['lead_time', 'OK', 'out_of_window', 'leave', 'staff_unavailable', 'conflict'],
  'B04-6 check_customer_booking_slot 本身:提前小時 / 通過 / 提前天數 / 請假 / 未上架 / 車程重疊 的原因代碼');

-- =========================================================================
-- B05 / B06 指定服務人員不可預約 ⇒ 同一個錯誤
-- =========================================================================
select throws_ok(
  format($$select public.get_public_available_slots('pgtap-c1s-win', '[{"service_item_id":"c1500000-0000-4000-8000-000000000083","quantity":1}]', 'c1500000-0000-4000-8000-000000000045', %L, 1)$$, pg_temp.d(1)),
  'P0002', '這位服務人員目前無法預約，請改選其他服務人員或「不指定」', 'B05-1 未上架');
select throws_ok(
  format($$select public.get_public_available_slots('pgtap-c1s-win', '[{"service_item_id":"c1500000-0000-4000-8000-000000000083","quantity":1}]', 'c1500000-0000-4000-8000-000000000046', %L, 1)$$, pg_temp.d(1)),
  'P0002', '這位服務人員目前無法預約，請改選其他服務人員或「不指定」', 'B05-2 已移除');
select throws_ok(
  format($$select public.get_public_available_slots('pgtap-c1s-win', '[{"service_item_id":"c1500000-0000-4000-8000-000000000083","quantity":1}]', 'c1500000-0000-4000-8000-000000000031', %L, 1)$$, pg_temp.d(1)),
  'P0002', '這位服務人員目前無法預約，請改選其他服務人員或「不指定」', 'B05-3 別家店的服務人員');
select throws_ok(
  format($$select public.get_public_available_slots('pgtap-c1s-win', '[{"service_item_id":"c1500000-0000-4000-8000-000000000083","quantity":1},{"service_item_id":"c1500000-0000-4000-8000-000000000084","quantity":1}]', 'c1500000-0000-4000-8000-000000000047', %L, 1)$$, pg_temp.d(1)),
  'P0002', '這位服務人員目前無法預約，請改選其他服務人員或「不指定」', 'B06-1 有對應但缺一個主要項目 ⇒ 同一個錯誤');
select lives_ok(
  format($$select public.get_public_available_slots('pgtap-c1s-win', '[{"service_item_id":"c1500000-0000-4000-8000-000000000083","quantity":1},{"service_item_id":"c1500000-0000-4000-8000-000000000084","quantity":1},{"service_item_id":"c1500000-0000-4000-8000-000000000085","quantity":2}]', 'c1500000-0000-4000-8000-000000000048', %L, 1)$$, pg_temp.d(1)),
  'B06-2 只缺加購項目的對應 ⇒ 仍可查');
select lives_ok(
  format($$select public.get_public_available_slots('pgtap-c1s-win', '[{"service_item_id":"c1500000-0000-4000-8000-000000000083","quantity":1},{"service_item_id":"c1500000-0000-4000-8000-000000000084","quantity":1}]', 'c1500000-0000-4000-8000-000000000043', %L, 1)$$, pg_temp.d(1)),
  'B06-3 沒有任何對應 ⇒ 視為全會');

-- =========================================================================
-- B07 不指定 = 合併(合併店:阿明 09-12、小陳 13-18;d2 阿明請假)
-- =========================================================================
select ok(pg_temp.cust('pgtap-c1s-uni', pg_temp.items1('c1500000-0000-4000-8000-000000000087'), null, 1) @> array['09:00', '11:00', '13:00', '17:00'],
          'B07-1 不指定:上午(阿明)與下午(小陳)都有');
select ok(not (pg_temp.cust('pgtap-c1s-uni', pg_temp.items1('c1500000-0000-4000-8000-000000000087'), null, 2) && array['09:00', '10:00', '11:00'])
          and pg_temp.cust('pgtap-c1s-uni', pg_temp.items1('c1500000-0000-4000-8000-000000000087'), null, 2) @> array['13:00'],
          'B07-2 阿明請假:只剩小陳的下午');
select ok(
  (select bool_and(strpos(r::text, needle) = 0)
     from (select public.get_public_available_slots('pgtap-c1s-uni', pg_temp.items1('c1500000-0000-4000-8000-000000000087'), null, pg_temp.d(0), 7) as r) x,
          unnest(array['c1500000-0000-4000-8000-000000000051', 'c1500000-0000-4000-8000-000000000052',
                       'UNI_STAFF_A_REALNAME', 'UNI_STAFF_B_REALNAME', '合併阿明', '合併小陳']) needle),
  'B07-3 不指定的回傳整包搜不到服務人員 id、本名、暱稱');
select is(
  (select array_agg(k order by k) from jsonb_object_keys(
     public.get_public_available_slots('pgtap-c1s-uni', pg_temp.items1('c1500000-0000-4000-8000-000000000087'), null, pg_temp.d(0), 1)) k),
  array['days', 'duration_minutes'], 'B07-4 回傳最上層只有 duration_minutes、days');

-- =========================================================================
-- B08 車程緩衝(到府 60 分;已有 d1 10:00-12:00;D = 60、間隔 30)
-- =========================================================================
select ok(
  pg_temp.cust('pgtap-c1s-trv', pg_temp.items1('c1500000-0000-4000-8000-000000000088'), null, 1) @> array['08:00', '13:00']
  and not (pg_temp.cust('pgtap-c1s-trv', pg_temp.items1('c1500000-0000-4000-8000-000000000088'), null, 1) && array['08:30', '09:00', '12:00', '12:30']),
  'B08-1 到府 60 分:08:00 可、08:30 不可、12:30 不可、13:00 可');
select ok(
  pg_temp.cust('pgtap-c1s-trv2', pg_temp.items1('c1500000-0000-4000-8000-000000000089'), null, 1) @> array['08:00', '09:00', '12:00', '12:30'],
  'B08-2 到店(設定有 60 分也當 0):09:00、12:00 都可');
select pg_temp.test_set_auth('c1500000-0000-4000-8000-000000000002');
select ok(
  public.list_staff_bookable_start_times('c1500000-0000-4000-8000-000000000026', 'c1500000-0000-4000-8000-000000000061', pg_temp.d(1), 60)
    @> array['09:00', '12:00'],
  'B08-3 後台 list_staff_bookable_start_times 不受車程緩衝影響');
select pg_temp.test_clear_auth();
select ok(
  pg_temp.cust('pgtap-c1s-trv', pg_temp.items1('c1500000-0000-4000-8000-000000000088'), null, 1) @> array['17:00']
  and not (pg_temp.cust('pgtap-c1s-trv', pg_temp.items1('c1500000-0000-4000-8000-000000000088'), null, 1) @> array['17:30']),
  'B08-4 營業時間不因車程延長(17:00 做到 18:00 可;17:30 超出營業不可)');

-- =========================================================================
-- 參數 / 輸入防護(F04 與 C02 錯誤代碼)
-- =========================================================================
select throws_ok(
  format($$select public.get_public_available_slots('pgtap-c1s-uni', '[{"service_item_id":"c1500000-0000-4000-8000-000000000087","quantity":1}]', null, %L, 8)$$, pg_temp.d(0)),
  '22023', '查詢的日期範圍不正確', 'F04-1 p_days = 8 報錯');
select throws_ok(
  format($$select public.get_public_available_slots('pgtap-c1s-uni', %L, null, %L, 1)$$,
         (select jsonb_agg(jsonb_build_object('service_item_id', 'c1500000-0000-4000-8000-000000000087', 'quantity', 1)) from generate_series(1, 51)),
         pg_temp.d(0)),
  '22023', '選擇的服務項目不正確，請重新選擇', 'F04-2 p_items 51 筆報錯');
select throws_ok(
  format($$select public.get_public_available_slots('pgtap-c1s-uni', '[{"service_item_id":"c1500000-0000-4000-8000-000000000087","quantity":21}]', null, %L, 1)$$, pg_temp.d(0)),
  '22023', '選擇的服務項目不正確，請重新選擇', 'F04-3 數量 21 報錯');
select throws_ok(
  format($$select public.get_public_available_slots('pgtap-c1s-uni', '[{"service_item_id":"c1500000-0000-4000-8000-000000000087","quantity":1},{"service_item_id":"c1500000-0000-4000-8000-000000000087","quantity":1}]', null, %L, 1)$$, pg_temp.d(0)),
  '22023', '選擇的服務項目不正確，請重新選擇', 'F04-4 同一項目重複報錯');
select throws_ok(
  format($$select public.get_public_available_slots('pgtap-c1s-win', '[{"service_item_id":"c1500000-0000-4000-8000-000000000085","quantity":1}]', null, %L, 1)$$, pg_temp.d(0)),
  '22023', '請至少選一項主要服務', 'F04-5 只選加購項目報錯');
select throws_ok(
  format($$select public.get_public_available_slots('pgtap-c1s-uni', '[{"service_item_id":"c1500000-0000-4000-8000-000000000081","quantity":1}]', null, %L, 1)$$, pg_temp.d(0)),
  '22023', '選擇的服務項目不正確，請重新選擇', 'F04-6 別家店的服務項目報錯');
select throws_ok(
  format($$select public.get_public_available_slots('pgtap-no-such-slug', '[{"service_item_id":"c1500000-0000-4000-8000-000000000087","quantity":1}]', null, %L, 1)$$, pg_temp.d(0)),
  'P0002', '找不到這個預約頁，請向店家確認連結是否正確', 'C02-1 代碼不存在');
select is(
  (public.get_public_available_slots('  PGTAP-C1S-UNI ', pg_temp.items1('c1500000-0000-4000-8000-000000000087', 3), null, pg_temp.d(0), 2)) ->> 'duration_minutes',
  '180', 'C02-2 代碼不分大小寫、去頭尾空白;工時 = 工時 × 數量,由伺服器算');

-- =========================================================================
-- 效能:10 位上架服務人員、間隔 5 分、不指定、7 天,而且全滿(每個候選都要問完 10 個人)
-- =========================================================================
create temp table c1_perf (ms numeric, result jsonb);
grant all on c1_perf to anon;
select pg_temp.test_set_auth('c1500000-0000-4000-8000-000000000001', 'anon');
do $$
declare
  v_t0 timestamptz;
  v_r jsonb;
begin
  v_t0 := clock_timestamp();
  v_r := public.get_public_available_slots('pgtap-c1s-perf',
           '[{"service_item_id":"c1500000-0000-4000-8000-000000000090","quantity":1}]'::jsonb,
           null, (select d0 from c1_ctx), 7);
  insert into c1_perf values (extract(epoch from clock_timestamp() - v_t0) * 1000, v_r);
end;
$$;
select pg_temp.test_clear_auth();
select diag('效能(全滿最壞情境)耗時 ms = ' || round(ms)::text) from c1_perf;
select ok((select ms < 2000 from c1_perf), 'PERF-1 最壞情境單次呼叫 < 2 秒');
select is(
  (select array_agg(distinct d ->> 'state') from c1_perf, jsonb_array_elements(result -> 'days') d),
  array['full'], 'PERF-2 全滿情境:7 天都是 full(確認真的逐格問完)');

select * from finish();
rollback;
