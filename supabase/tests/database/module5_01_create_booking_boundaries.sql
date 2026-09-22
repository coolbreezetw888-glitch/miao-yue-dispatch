-- 模組 5 規則 2.1、2.2、2.3:create_booking 的邊界檢查(商家營業時間 / 服務人員可預約時段 /
-- unlimited_backend_edit 覆寫例外)。對應規格書 3.3、2.1、2.2、2.3。
--
-- 情境布置:一間商家「邊界測試商家」,週二(day_of_week=2)09:00-12:00 營業,週三公休。
-- 一位服務人員 A(電話 NULL,避免跟其他測試檔案的電話比對規則互相干擾),
-- 週二可預約時段只有 10:00-11:00(比營業時間窄),no_time_slot_limit=false,unlimited_backend_edit=false。
-- 一位服務人員 B,設定跟 A 完全相同,但 unlimited_backend_edit=true,用來測規則 2.3 的覆寫例外。
begin;

select plan(8);

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
  ('b1000000-0000-4000-8000-000000000001', 'pgtap-m5-admin@test.local');

insert into groups (id) values ('b1000000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('b1000000-0000-4000-8000-000000000020', 'b1000000-0000-4000-8000-000000000010', '邊界測試商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('b1000000-0000-4000-8000-000000000020', 'b1000000-0000-4000-8000-000000000001');

-- 週二 09:00-12:00 營業,週三公休(day_of_week: 0=日...3=三)。
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
values
  ('b1000000-0000-4000-8000-000000000020', 2, false, '09:00', '12:00'),
  ('b1000000-0000-4000-8000-000000000020', 3, true, null, null);

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('b1000000-0000-4000-8000-000000000030', 'b1000000-0000-4000-8000-000000000020', '剪髮', 500, 'primary', 60);

-- 服務人員 A:一般情況,時段比營業時間窄(10:00-11:00)。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, unlimited_backend_edit)
values ('b1000000-0000-4000-8000-000000000040', 'b1000000-0000-4000-8000-000000000020', '服務人員A', '0901000101', false, false);

insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
values ('b1000000-0000-4000-8000-000000000040', 2, '10:00', '11:00');

-- 服務人員 B:unlimited_backend_edit = true,用來測規則 2.3 覆寫例外。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, unlimited_backend_edit)
values ('b1000000-0000-4000-8000-000000000041', 'b1000000-0000-4000-8000-000000000020', '服務人員B', '0901000102', false, true);

-- SPECS-INDEX #604(2026-09-23 批次修正):create_booking 新建訂單付款方式改為必填,這個檔案原本
-- 所有 create_booking 呼叫都用位置參數、沒有帶付款方式(依賴預設值 null)——補一筆付款方式,下面
-- 每個呼叫在既有位置參數清單最後面補上具名參數 p_payment_method_id(PostgreSQL 允許位置參數之後
-- 接具名參數),不改變任何測試原本要驗證的排程邊界邏輯。
insert into payment_methods (id, merchant_id, name) values
  ('b1000000-0000-4000-8000-000000000060', 'b1000000-0000-4000-8000-000000000020', '現場付款');

select pg_temp.test_set_auth('b1000000-0000-4000-8000-000000000001');

-- ① 規則 2.2:落在服務人員時段內(10:00-11:00,剛好一小時)應該成功。
select lives_ok(
  $$select create_booking(
    'b1000000-0000-4000-8000-000000000020', 'b1000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','b1000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    '客戶一', '0911000001',
    p_payment_method_id => 'b1000000-0000-4000-8000-000000000060'
  )$$,
  '規則 2.1+2.2:2026-09-22(週二)10:00 落在商家營業時間跟服務人員時段內,建立成功'
);

-- ② 規則 2.2:11:00-12:00 落在商家營業時間內,但超出服務人員時段(10:00-11:00),應該被擋下。
select throws_ok(
  $$select create_booking(
    'b1000000-0000-4000-8000-000000000020', 'b1000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','b1000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 11:00:00+08',
    '客戶二', '0911000002',
    p_payment_method_id => 'b1000000-0000-4000-8000-000000000060'
  )$$,
  'P0001', null,
  '規則 2.2:超出服務人員可預約時段,被擋下'
);

-- ③ 規則 2.1:08:00 早於商家開店時間(09:00),即使沒有服務人員時段設定,也應該先被商家營業時間擋下。
select throws_ok(
  $$select create_booking(
    'b1000000-0000-4000-8000-000000000020', 'b1000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','b1000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 08:00:00+08',
    '客戶三', '0911000003',
    p_payment_method_id => 'b1000000-0000-4000-8000-000000000060'
  )$$,
  'P0001', null,
  '規則 2.1:早於商家營業時間,被擋下'
);

-- ④ 規則 2.1:週三(2026-09-23)公休,即使服務人員理論上有空,也應該被擋下。
select throws_ok(
  $$select create_booking(
    'b1000000-0000-4000-8000-000000000020', 'b1000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','b1000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-23 10:00:00+08',
    '客戶四', '0911000004',
    p_payment_method_id => 'b1000000-0000-4000-8000-000000000060'
  )$$,
  'P0001', null,
  '規則 2.1:當天公休,被擋下'
);

-- ⑤ 規則 2.1:週四(2026-09-24)完全沒有設定營業時間列,一律視為不可預約,應被擋下。
select throws_ok(
  $$select create_booking(
    'b1000000-0000-4000-8000-000000000020', 'b1000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','b1000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-24 10:00:00+08',
    '客戶五', '0911000005',
    p_payment_method_id => 'b1000000-0000-4000-8000-000000000060'
  )$$,
  'P0001', null,
  '規則 2.1:查無當天營業時間設定,視為不可預約,被擋下'
);

-- ⑥ 規則 2.3:服務人員 B(unlimited_backend_edit=true)在管理員操作下,08:00(超出商家營業時間)
--    也能成功建立,證明覆寫例外生效。
select lives_ok(
  $$select create_booking(
    'b1000000-0000-4000-8000-000000000020', 'b1000000-0000-4000-8000-000000000041',
    jsonb_build_array(jsonb_build_object('service_item_id','b1000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 08:00:00+08',
    '客戶六', '0911000006',
    p_payment_method_id => 'b1000000-0000-4000-8000-000000000060'
  )$$,
  '規則 2.3:unlimited_backend_edit=true 且操作者是管理員,跳過邊界檢查,建立成功'
);

select pg_temp.test_clear_auth();

-- ⑦ 規則 2.5 邊界情況(在 create_booking 內以規則 2.2 的形式體現):服務人員完全沒設定任何時段時,
--    視為不可預約。新增服務人員 C,不給任何 staff_availability_windows。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, unlimited_backend_edit)
values ('b1000000-0000-4000-8000-000000000042', 'b1000000-0000-4000-8000-000000000020', '服務人員C', '0901000103', false, false);

select pg_temp.test_set_auth('b1000000-0000-4000-8000-000000000001');

select throws_ok(
  $$select create_booking(
    'b1000000-0000-4000-8000-000000000020', 'b1000000-0000-4000-8000-000000000042',
    jsonb_build_array(jsonb_build_object('service_item_id','b1000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    '客戶七', '0911000007',
    p_payment_method_id => 'b1000000-0000-4000-8000-000000000060'
  )$$,
  'P0001', null,
  '規則 2.5:服務人員完全沒設定任何可預約時段,視為不可預約,被擋下'
);

-- ⑧ 規則 2.5 的例外:no_time_slot_limit=true 時,即使沒有設定任何 staff_availability_windows,
--    只受商家整體營業時間限制,應該成功。
update merchant_staff set no_time_slot_limit = true where id = 'b1000000-0000-4000-8000-000000000042';

select lives_ok(
  $$select create_booking(
    'b1000000-0000-4000-8000-000000000020', 'b1000000-0000-4000-8000-000000000042',
    jsonb_build_array(jsonb_build_object('service_item_id','b1000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    '客戶八', '0911000008',
    p_payment_method_id => 'b1000000-0000-4000-8000-000000000060'
  )$$,
  '規則 2.2 例外:no_time_slot_limit=true 時只受商家營業時間限制,建立成功'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
