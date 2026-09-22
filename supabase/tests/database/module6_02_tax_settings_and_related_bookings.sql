-- 模組 6(訂單管理)§2.1(merchant_tax_settings CHECK 約束/RLS/預設值)、
-- §3.3/§6.3(get_customer_related_bookings)、§3.2/§6.2(update_booking_payment_method)。
begin;

select plan(19);

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
  ('c2000000-0000-4000-8000-000000000001', 'pgtap-m6b-admin1@test.local'),
  ('c2000000-0000-4000-8000-000000000002', 'pgtap-m6b-admin2@test.local'),
  ('c2000000-0000-4000-8000-000000000003', 'pgtap-m6b-agent-none@test.local'),
  ('c2000000-0000-4000-8000-000000000004', 'pgtap-m6b-agent-bh@test.local');

insert into groups (id) values
  ('c2000000-0000-4000-8000-000000000011'),
  ('c2000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('c2000000-0000-4000-8000-000000000021', 'c2000000-0000-4000-8000-000000000011', '相關訂單測試一店', 'in_store_beauty'),
  ('c2000000-0000-4000-8000-000000000022', 'c2000000-0000-4000-8000-000000000012', '相關訂單測試二店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('c2000000-0000-4000-8000-000000000021', 'c2000000-0000-4000-8000-000000000001'),
  ('c2000000-0000-4000-8000-000000000022', 'c2000000-0000-4000-8000-000000000002');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('c2000000-0000-4000-8000-000000000031', 'c2000000-0000-4000-8000-000000000021', 'c2000000-0000-4000-8000-000000000003', '客服-無授權', 'pgtap-m6b-agent-none@test.local', 'active', now(), '0900000101'),
  ('c2000000-0000-4000-8000-000000000032', 'c2000000-0000-4000-8000-000000000021', 'c2000000-0000-4000-8000-000000000004', '客服-營業時間', 'pgtap-m6b-agent-bh@test.local', 'active', now(), '0900000102');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('c2000000-0000-4000-8000-000000000032', 'business_hours', true),
  ('c2000000-0000-4000-8000-000000000031', 'orders', true);

-- =========================================================================
-- §2.1 merchant_tax_settings:CHECK 約束(直接以 postgres 身分測,約束是最後一道防線)。
-- =========================================================================
select throws_ok(
  $$insert into merchant_tax_settings (merchant_id, tax_mode, tax_value)
    values ('c2000000-0000-4000-8000-000000000021', 'percentage', 150)$$,
  '23514', null,
  '§2.1:merchant_tax_settings 百分比模式數值超過 100 被 CHECK 約束擋下'
);

select throws_ok(
  $$insert into merchant_tax_settings (merchant_id, tax_mode, tax_value)
    values ('c2000000-0000-4000-8000-000000000021', 'fixed', -5)$$,
  '23514', null,
  '§2.1:merchant_tax_settings 固定金額模式數值為負數被 CHECK 約束擋下'
);

select throws_ok(
  $$insert into merchant_tax_settings (merchant_id, tax_mode) values ('c2000000-0000-4000-8000-000000000021', 'not_a_real_mode')$$,
  '23514', null,
  '§2.1:merchant_tax_settings.tax_mode 不在 fixed/percentage 之內被 CHECK 約束擋下'
);

-- §2.1:查無資料時,查詢回傳 0 筆(前端/後端據此 fallback 成預設值 percentage/5.00)。
select is(
  (select count(*)::int from merchant_tax_settings where merchant_id = 'c2000000-0000-4000-8000-000000000021'),
  0,
  '§2.1:商家還沒特別設定過稅金時,merchant_tax_settings 查無資料(前端 fallback 預設值)'
);

-- =========================================================================
-- §2.1 merchant_tax_settings:RLS(要求 private.can_manage_business_hours)。
-- =========================================================================
select pg_temp.test_set_auth('c2000000-0000-4000-8000-000000000003');

select throws_ok(
  $$insert into merchant_tax_settings (merchant_id, tax_mode, tax_value)
    values ('c2000000-0000-4000-8000-000000000021', 'percentage', 8)$$,
  '42501', null,
  '§2.1:無授權 business_hours 的客服不能寫入 merchant_tax_settings'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('c2000000-0000-4000-8000-000000000004');

select lives_ok(
  $$insert into merchant_tax_settings (merchant_id, tax_mode, tax_value)
    values ('c2000000-0000-4000-8000-000000000021', 'percentage', 8)$$,
  '§2.1:被授權 business_hours 的客服可以寫入 merchant_tax_settings'
);

select is(
  (select tax_value from merchant_tax_settings where merchant_id = 'c2000000-0000-4000-8000-000000000021'),
  8.00,
  '§2.1:寫入後查詢得到正確的數值'
);

select lives_ok(
  $$update merchant_tax_settings set tax_mode = 'fixed', tax_value = 20
    where merchant_id = 'c2000000-0000-4000-8000-000000000021'$$,
  '§2.1:被授權 business_hours 的客服可以更新 merchant_tax_settings(改變模式)'
);

-- §2.1:沒有 DELETE 政策,真刪除不會真的刪掉。
delete from merchant_tax_settings where merchant_id = 'c2000000-0000-4000-8000-000000000021';

select is(
  (select count(*)::int from merchant_tax_settings where merchant_id = 'c2000000-0000-4000-8000-000000000021'),
  1,
  '§2.1:merchant_tax_settings 沒有 DELETE 政策,執行 DELETE 沒有真的刪掉'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- §3.3/§6.3 get_customer_related_bookings。
-- =========================================================================
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time) values
  ('c2000000-0000-4000-8000-000000000021', 2, false, '00:00', '23:59'),
  ('c2000000-0000-4000-8000-000000000022', 2, false, '00:00', '23:59');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('c2000000-0000-4000-8000-000000000041', 'c2000000-0000-4000-8000-000000000021', '洗髮', 300, 'primary', 30),
  ('c2000000-0000-4000-8000-000000000042', 'c2000000-0000-4000-8000-000000000022', '洗髮', 300, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('c2000000-0000-4000-8000-000000000051', 'c2000000-0000-4000-8000-000000000021', '一店服務人員', '0901000101', true),
  ('c2000000-0000-4000-8000-000000000052', 'c2000000-0000-4000-8000-000000000022', '二店服務人員', '0901000102', true);

-- 模組 9(支付方式)v2:update_booking_payment_method 的參數已改成 p_payment_method_id(uuid),
-- 補一筆一店的付款方式供下面 §6.2 測試使用。
insert into payment_methods (id, merchant_id, name) values
  ('c2000000-0000-4000-8000-000000000091', 'c2000000-0000-4000-8000-000000000021', '現場付款');

-- SPECS-INDEX #604(2026-09-23 批次修正,機械性補參數,不改變測試本身要驗證的邏輯):
-- create_booking 新建訂單付款方式改為必填,下面既有的 create_booking/update_booking 呼叫
-- 補上 p_payment_method_id。這兩筆(含二店那筆)一樣用還沒 test_set_auth 任何角色的 postgres
-- 超級使用者身分布置,避免用「一店管理員」身分插入「二店」的付款方式時被 RLS 擋下。
insert into payment_methods (id, merchant_id, name) values ('638acea5-dfd1-564e-9b22-ab9cbd3282ab', 'c2000000-0000-4000-8000-000000000021', '現場付款');
insert into payment_methods (id, merchant_id, name) values ('257a215d-f307-5955-adf0-24127d0362db', 'c2000000-0000-4000-8000-000000000022', '現場付款');

select pg_temp.test_set_auth('c2000000-0000-4000-8000-000000000001');

-- 同一位客戶(0955000001)在一店有三筆訂單。
select id from create_booking(
  'c2000000-0000-4000-8000-000000000021', 'c2000000-0000-4000-8000-000000000051',
  jsonb_build_array(jsonb_build_object('service_item_id', 'c2000000-0000-4000-8000-000000000041', 'quantity', 1, 'unit_price', 300)),
  '2026-09-22 09:00:00+08', '客戶甲', '0955000001'
, p_payment_method_id => '638acea5-dfd1-564e-9b22-ab9cbd3282ab') \gset booking_a_

select id from create_booking(
  'c2000000-0000-4000-8000-000000000021', 'c2000000-0000-4000-8000-000000000051',
  jsonb_build_array(jsonb_build_object('service_item_id', 'c2000000-0000-4000-8000-000000000041', 'quantity', 1, 'unit_price', 300)),
  '2026-09-22 10:00:00+08', '客戶甲', '0955000001'
, p_payment_method_id => '638acea5-dfd1-564e-9b22-ab9cbd3282ab') \gset booking_b_

-- 另一位客戶(0955000002)在一店的訂單,不應該出現在客戶甲的相關訂單清單裡。
select id from create_booking(
  'c2000000-0000-4000-8000-000000000021', 'c2000000-0000-4000-8000-000000000051',
  jsonb_build_array(jsonb_build_object('service_item_id', 'c2000000-0000-4000-8000-000000000041', 'quantity', 1, 'unit_price', 300)),
  '2026-09-22 11:00:00+08', '客戶乙', '0955000002'
, p_payment_method_id => '638acea5-dfd1-564e-9b22-ab9cbd3282ab') \gset booking_c_

-- ⑤ 同電話比對正確抓出同商家內其他訂單,不含自己(排除 booking_a 本身)。
select is(
  (select count(*)::int from get_customer_related_bookings(
    'c2000000-0000-4000-8000-000000000021', '0955000001', :'booking_a_id'::uuid
  )),
  1,
  '§3.3:同電話比對正確抓出同商家內其他訂單(排除自己),客戶甲應該只查到 1 筆(booking_b)'
);

select is(
  (select id from get_customer_related_bookings(
    'c2000000-0000-4000-8000-000000000021', '0955000001', :'booking_a_id'::uuid
  ) limit 1),
  :'booking_b_id'::uuid,
  '§3.3:查到的那一筆確實是 booking_b,不是 booking_a 自己'
);

-- ⑥ 不傳排除 id 時,兩筆都查得到。
select is(
  (select count(*)::int from get_customer_related_bookings('c2000000-0000-4000-8000-000000000021', '0955000001')),
  2,
  '§3.3:不排除自己時,客戶甲的兩筆訂單都查得到'
);

-- ⑦ 電話為 null 時回傳空清單,不報錯。
select lives_ok(
  $$select * from get_customer_related_bookings('c2000000-0000-4000-8000-000000000021', null)$$,
  '§3.3 邊界情況:電話為 null 時不報錯'
);
select is(
  (select count(*)::int from get_customer_related_bookings('c2000000-0000-4000-8000-000000000021', null)),
  0,
  '§3.3 邊界情況:電話為 null 時回傳空清單'
);

select pg_temp.test_clear_auth();

-- ⑧ 不同商家即使電話相同也不會查到彼此的訂單:二店幫同一個電話(0955000001)建一筆預約,
--    一店查詢時不應該看到二店這筆。
select pg_temp.test_set_auth('c2000000-0000-4000-8000-000000000002');

select id from create_booking(
  'c2000000-0000-4000-8000-000000000022', 'c2000000-0000-4000-8000-000000000052',
  jsonb_build_array(jsonb_build_object('service_item_id', 'c2000000-0000-4000-8000-000000000042', 'quantity', 1, 'unit_price', 300)),
  '2026-09-22 09:00:00+08', '客戶甲(二店)', '0955000001'
, p_payment_method_id => '257a215d-f307-5955-adf0-24127d0362db') \gset booking_foreign_

select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('c2000000-0000-4000-8000-000000000001');

select is(
  (select count(*)::int from get_customer_related_bookings('c2000000-0000-4000-8000-000000000021', '0955000001')),
  2,
  '§3.3:不做跨商家查詢,一店查詢客戶甲的相關訂單,不會因為二店有相同電話的訂單而多出一筆'
);

-- =========================================================================
-- 模組 9(支付方式)v2:update_booking_payment_method,p_payment_method_id 改成 uuid。
-- =========================================================================
select lives_ok(
  format($$select update_booking_payment_method('%s', '%s')$$, :'booking_a_id'::text, 'c2000000-0000-4000-8000-000000000091'),
  '模組 9 v2:pending_confirmation 狀態的訂單可以設定付款方式'
);

select is(
  (select payment_method_name_snapshot from bookings where id = :'booking_a_id'::uuid),
  '現場付款',
  '模組 9 v2:update_booking_payment_method 正確寫入 payment_method_id + payment_method_name_snapshot 快照'
);

-- 完成訂單後不能再改付款方式。
select confirm_booking(:'booking_a_id'::uuid);
select complete_booking(:'booking_a_id'::uuid);

select throws_ok(
  format($$select update_booking_payment_method('%s', '%s')$$, :'booking_a_id'::text, 'c2000000-0000-4000-8000-000000000091'),
  'P0001', null,
  '§6.2:已完成的訂單不能再修改付款方式'
);

select pg_temp.test_clear_auth();

-- 無權限的另一間商家管理員不能修改別人商家的付款方式。
select pg_temp.test_set_auth('c2000000-0000-4000-8000-000000000002');

select throws_ok(
  format($$select update_booking_payment_method('%s', '%s')$$, :'booking_b_id'::text, 'c2000000-0000-4000-8000-000000000091'),
  '42501', null,
  '§6.2:無權限的商家管理員不能修改別人商家訂單的付款方式'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
