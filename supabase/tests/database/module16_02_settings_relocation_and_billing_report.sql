-- 商家端三項調整規格書 §一(設定搬家權限放寬)、§二 2.9(merchant_staff_service_items 權限
-- 補強)、§三(店家帳務報表:總營收拆分未稅/稅金、商家總淨利公式修正)— 核心必測。
begin;

select plan(16);

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
-- Fixture:一間商家,管理員 + 四種客服(business_hours only / material_costs only /
-- payment_methods only / commission_settings + billing)。
-- =========================================================================
insert into auth.users (id, email) values
  ('ed000000-0000-4000-8000-000000000001', 'pgtap-m16b-admin@test.local'),
  ('ed000000-0000-4000-8000-000000000002', 'pgtap-m16b-agent-bh@test.local'),
  ('ed000000-0000-4000-8000-000000000003', 'pgtap-m16b-agent-mc@test.local'),
  ('ed000000-0000-4000-8000-000000000004', 'pgtap-m16b-agent-pm@test.local'),
  ('ed000000-0000-4000-8000-000000000005', 'pgtap-m16b-agent-cs@test.local');

insert into groups (id) values ('ed000000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('ed000000-0000-4000-8000-000000000021', 'ed000000-0000-4000-8000-000000000011', '設定搬家測試店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('ed000000-0000-4000-8000-000000000021', 'ed000000-0000-4000-8000-000000000001');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'ed000000-0000-4000-8000-000000000021', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('ed000000-0000-4000-8000-000000000031', 'ed000000-0000-4000-8000-000000000021', '洗髮', 1000, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, compensation_type) values
  ('ed000000-0000-4000-8000-000000000041', 'ed000000-0000-4000-8000-000000000021', '按件服務人員P', '0901000101', true, 'piece_rate');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('ed000000-0000-4000-8000-000000000051', 'ed000000-0000-4000-8000-000000000021', 'ed000000-0000-4000-8000-000000000002', '客服-business_hours', 'pgtap-m16b-agent-bh@test.local', 'active', now(), '0900000101'),
  ('ed000000-0000-4000-8000-000000000052', 'ed000000-0000-4000-8000-000000000021', 'ed000000-0000-4000-8000-000000000003', '客服-material_costs', 'pgtap-m16b-agent-mc@test.local', 'active', now(), '0900000102'),
  ('ed000000-0000-4000-8000-000000000053', 'ed000000-0000-4000-8000-000000000021', 'ed000000-0000-4000-8000-000000000004', '客服-payment_methods', 'pgtap-m16b-agent-pm@test.local', 'active', now(), '0900000103'),
  ('ed000000-0000-4000-8000-000000000054', 'ed000000-0000-4000-8000-000000000021', 'ed000000-0000-4000-8000-000000000005', '客服-commission_settings+billing', 'pgtap-m16b-agent-cs@test.local', 'active', now(), '0900000104');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('ed000000-0000-4000-8000-000000000051', 'business_hours', true),
  ('ed000000-0000-4000-8000-000000000052', 'material_costs', true),
  ('ed000000-0000-4000-8000-000000000053', 'payment_methods', true),
  ('ed000000-0000-4000-8000-000000000054', 'commission_settings', true),
  ('ed000000-0000-4000-8000-000000000054', 'billing', true);

insert into merchant_payroll_settings (merchant_id, commission_basis_type) values
  ('ed000000-0000-4000-8000-000000000021', 'gross');

-- =========================================================================
-- ① §一 1.3/1.4:merchant_feature_flags(material_cost_enabled)key 層級放寬。
-- =========================================================================
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000003');

select lives_ok(
  $$insert into merchant_feature_flags (merchant_id, feature_key, enabled)
    values ('ed000000-0000-4000-8000-000000000021', 'material_cost_enabled', true)
    on conflict (merchant_id, feature_key) do update set enabled = true$$,
  '§1.3:被開通 material_costs(沒有 business_hours)的客服可以讀寫 material_cost_enabled 這個 feature flag'
);

select throws_ok(
  $$insert into merchant_feature_flags (merchant_id, feature_key, enabled)
    values ('ed000000-0000-4000-8000-000000000021', 'strict_conflict_check', false)
    on conflict (merchant_id, feature_key) do update set enabled = false$$,
  '42501', null,
  '§1.3(key 層級精細控制):被開通 material_costs 的客服寫入 strict_conflict_check 這個 key 被擋下,不是整張表都放行'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ② §一 1.3/1.4:merchant_tax_settings 整張表放寬給 payment_methods。
-- =========================================================================
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000004');

select lives_ok(
  $$insert into merchant_tax_settings (merchant_id, tax_mode, tax_value)
    values ('ed000000-0000-4000-8000-000000000021', 'percentage', 5)
    on conflict (merchant_id) do update set tax_mode = 'percentage', tax_value = 5$$,
  '§1.3:被開通 payment_methods(沒有 business_hours)的客服可以讀寫 merchant_tax_settings'
);

select is(
  (select tax_value from merchant_tax_settings where merchant_id = 'ed000000-0000-4000-8000-000000000021'),
  5.00,
  '§1.3:寫入的稅金設定確實生效'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ③ 對照組:原本只有 business_hours 權限的客服,兩項操作依然全部正常
-- (沒有因為這次修正被意外收回權限)。
-- =========================================================================
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000002');

select lives_ok(
  $$update merchant_feature_flags set enabled = false
    where merchant_id = 'ed000000-0000-4000-8000-000000000021' and feature_key = 'material_cost_enabled'$$,
  '對照組:原本只有 business_hours 權限的客服,仍然可以正常操作 material_cost_enabled'
);

select lives_ok(
  $$update merchant_tax_settings set tax_value = 8
    where merchant_id = 'ed000000-0000-4000-8000-000000000021'$$,
  '對照組:原本只有 business_hours 權限的客服,仍然可以正常操作 merchant_tax_settings'
);

select lives_ok(
  $$update merchant_feature_flags set enabled = false
    where merchant_id = 'ed000000-0000-4000-8000-000000000021' and feature_key = 'strict_conflict_check'$$,
  '對照組:原本只有 business_hours 權限的客服,仍然可以正常操作 strict_conflict_check(這把鑰匙本來就該由它管)'
);

update merchant_tax_settings set tax_value = 5 where merchant_id = 'ed000000-0000-4000-8000-000000000021';
update merchant_feature_flags set enabled = true where merchant_id = 'ed000000-0000-4000-8000-000000000021' and feature_key in ('material_cost_enabled', 'strict_conflict_check');

select pg_temp.test_clear_auth();

-- =========================================================================
-- ④ §二 2.9:merchant_staff_service_items 權限補強(被授權 commission_settings 的客服)。
-- =========================================================================
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000005');

select lives_ok(
  format(
    $$insert into merchant_staff_service_items (staff_id, service_item_id) values ('%s', '%s')$$,
    'ed000000-0000-4000-8000-000000000041', 'ed000000-0000-4000-8000-000000000031'
  ),
  '§2.9:被開通 commission_settings(非管理員)的客服可以新增 merchant_staff_service_items'
);

select is(
  (select count(*)::int from merchant_staff_service_items where staff_id = 'ed000000-0000-4000-8000-000000000041'),
  1,
  '§2.9:被開通 commission_settings 的客服可以讀取(SELECT)merchant_staff_service_items,不會因為 RLS 被擋成 0 筆'
);

select lives_ok(
  format(
    $$delete from merchant_staff_service_items where staff_id = '%s' and service_item_id = '%s'$$,
    'ed000000-0000-4000-8000-000000000041', 'ed000000-0000-4000-8000-000000000031'
  ),
  '§2.9:被開通 commission_settings 的客服可以刪除 merchant_staff_service_items'
);

select pg_temp.test_clear_auth();

-- 對照組:完全沒有授權的客服(business_hours only)不能操作這張表。
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000002');

select throws_ok(
  format(
    $$insert into merchant_staff_service_items (staff_id, service_item_id) values ('%s', '%s')$$,
    'ed000000-0000-4000-8000-000000000041', 'ed000000-0000-4000-8000-000000000031'
  ),
  '42501', null,
  '§2.9 對照組:只有 business_hours 權限(沒有 commission_settings、不是管理員)的客服不能新增 merchant_staff_service_items'
);

select is(
  (select count(*)::int from merchant_staff_service_items where staff_id = 'ed000000-0000-4000-8000-000000000041'),
  0,
  '§2.9 對照組:同一位客服 SELECT 這張表也是 0 筆(RLS 擋下讀取)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑤ §三 3.1/3.2:total_revenue 拆分未稅/稅金,estimated_net_margin 改用未稅營收計算。
-- =========================================================================
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001');

insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value) values
  ('ed000000-0000-4000-8000-000000000041', 'ed000000-0000-4000-8000-000000000031', 'percentage', 20);
-- SPECS-INDEX #604(2026-09-23 批次修正,機械性補參數,不改變測試本身要驗證的邏輯):
-- create_booking 新建訂單付款方式改為必填,下面既有的 create_booking/update_booking 呼叫
-- 補上 p_payment_method_id。
insert into payment_methods (id, merchant_id, name) values ('d58ebc73-40eb-5a2b-b8ca-3151a781e8bf', 'ed000000-0000-4000-8000-000000000021', '現場付款');


-- 一筆有稅(1000元,10%稅=100元,final=1100)、一筆無稅(500元,final=500)。
select id from create_booking(
  p_merchant_id => 'ed000000-0000-4000-8000-000000000021',
  p_staff_id => 'ed000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ed000000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => now(),
  p_customer_name => '含稅訂單測試客戶',
  p_customer_phone => '0966020001',
  p_tax_enabled => true,
  p_tax_mode => 'percentage',
  p_tax_value => 10
, p_payment_method_id => 'd58ebc73-40eb-5a2b-b8ca-3151a781e8bf') \gset tax_booking_

select confirm_booking(:'tax_booking_id'::uuid);
select complete_booking(:'tax_booking_id'::uuid);

select id from create_booking(
  p_merchant_id => 'ed000000-0000-4000-8000-000000000021',
  p_staff_id => 'ed000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ed000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => now() + interval '1 hour',
  p_customer_name => '無稅訂單測試客戶',
  p_customer_phone => '0966020002'
, p_payment_method_id => 'd58ebc73-40eb-5a2b-b8ca-3151a781e8bf') \gset no_tax_booking_

select confirm_booking(:'no_tax_booking_id'::uuid);
select complete_booking(:'no_tax_booking_id'::uuid);

select is(
  (get_merchant_billing_summary('ed000000-0000-4000-8000-000000000021', extract(year from now())::int, extract(month from now())::int) ->> 'total_revenue_excl_tax')::numeric,
  1500.00,
  '§3.1:total_revenue_excl_tax = 1000(含稅單未稅金額) + 500(無稅單) = 1500.00,不含稅金'
);

select is(
  (get_merchant_billing_summary('ed000000-0000-4000-8000-000000000021', extract(year from now())::int, extract(month from now())::int) ->> 'total_tax_amount')::numeric,
  100.00,
  '§3.1:total_tax_amount = 100.00(只有含稅那一筆的稅金)'
);

-- §3.2:estimated_net_margin = 1500(未稅營收) - 0(無料錢成本) - 300(抽成:1000×20%+500×20%) - 0(無月薪)
select is(
  (get_merchant_billing_summary('ed000000-0000-4000-8000-000000000021', extract(year from now())::int, extract(month from now())::int) ->> 'estimated_net_margin')::numeric,
  1200.00,
  '§3.2:estimated_net_margin 用未稅營收計算,1500 - 300(抽成) = 1200.00'
);

-- 對照組:如果沿用舊版「用含稅營收計算」的錯誤口徑,會得到 1300.00(1600-300),
-- 證明這次修正確實生效,不是恰好兩個數字一樣矇混過關。
select isnt(
  (get_merchant_billing_summary('ed000000-0000-4000-8000-000000000021', extract(year from now())::int, extract(month from now())::int) ->> 'estimated_net_margin')::numeric,
  1300.00,
  '§3.2(修正生效驗證):如果沿用舊版含稅營收口徑會得到 1300.00,新公式不會得出這個錯誤數字'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
