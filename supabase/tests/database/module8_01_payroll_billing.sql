-- 模組 8(薪資與帳務)— 對應規格書 .project/specs/薪資與帳務.md 全文。
-- 核心必測:規則 2.4(抽成快照建立後不自動重算)、規則 2.6(手動重算僅限管理員)。
begin;

select plan(77);

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
-- Fixture:兩間商家(A/B,測跨商家隔離)。A 商家:管理員 + 4 種客服(無授權/commission_settings/
-- billing/staff_report)+ 服務人員(P=按件計酬主測試對象/M=月薪制主測試對象/AST=按件計酬助手/
-- M2~M4=月薪制,各自獨立用於規則 2.8 特定情境/P2=按件計酬,獨立用於 3.9~3.11 報表測試)。
-- =========================================================================
insert into auth.users (id, email) values
  ('e8000000-0000-4000-8000-000000000001', 'pgtap-m8-admin-a@test.local'),
  ('e8000000-0000-4000-8000-000000000002', 'pgtap-m8-admin-b@test.local'),
  ('e8000000-0000-4000-8000-000000000003', 'pgtap-m8-agent-none@test.local'),
  ('e8000000-0000-4000-8000-000000000004', 'pgtap-m8-agent-commission@test.local'),
  ('e8000000-0000-4000-8000-000000000005', 'pgtap-m8-agent-billing@test.local'),
  ('e8000000-0000-4000-8000-000000000006', 'pgtap-m8-agent-staffreport@test.local');

insert into groups (id) values
  ('e8000000-0000-4000-8000-000000000011'),
  ('e8000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('e8000000-0000-4000-8000-000000000021', 'e8000000-0000-4000-8000-000000000011', '薪資帳務測試A店', 'in_store_beauty'),
  ('e8000000-0000-4000-8000-000000000022', 'e8000000-0000-4000-8000-000000000012', '薪資帳務測試B店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('e8000000-0000-4000-8000-000000000021', 'e8000000-0000-4000-8000-000000000001'),
  ('e8000000-0000-4000-8000-000000000022', 'e8000000-0000-4000-8000-000000000002');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'e8000000-0000-4000-8000-000000000021', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('e8000000-0000-4000-8000-000000000031', 'e8000000-0000-4000-8000-000000000021', '洗髮', 500, 'primary', 30);

insert into material_cost_items (id, merchant_id, name, amount) values
  ('e8000000-0000-4000-8000-000000000032', 'e8000000-0000-4000-8000-000000000021', '染劑', 200);

-- 規則 2.1 net_of_material_cost 測試需要用到料錢成本品項,先開啟這個商家的 material_cost_enabled
-- 功能開關(建單功能擴充規格書 2.3:兩層權限,商家開關 + 客服權限,這裡只需要商家開關)。
insert into merchant_feature_flags (merchant_id, feature_key, enabled) values
  ('e8000000-0000-4000-8000-000000000021', 'material_cost_enabled', true);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, compensation_type) values
  ('e8000000-0000-4000-8000-000000000041', 'e8000000-0000-4000-8000-000000000021', '按件服務人員P', null, true, 'piece_rate'),
  ('e8000000-0000-4000-8000-000000000042', 'e8000000-0000-4000-8000-000000000021', '月薪服務人員M', null, true, 'monthly_salary'),
  ('e8000000-0000-4000-8000-000000000043', 'e8000000-0000-4000-8000-000000000021', '按件助手AST', null, true, 'piece_rate'),
  ('e8000000-0000-4000-8000-000000000045', 'e8000000-0000-4000-8000-000000000021', '月薪服務人員M2(跨月測試)', null, true, 'monthly_salary'),
  ('e8000000-0000-4000-8000-000000000046', 'e8000000-0000-4000-8000-000000000021', '月薪服務人員M3(無薪資設定)', null, true, 'monthly_salary'),
  ('e8000000-0000-4000-8000-000000000047', 'e8000000-0000-4000-8000-000000000021', '月薪服務人員M4(超額扣款測試)', null, true, 'monthly_salary'),
  ('e8000000-0000-4000-8000-000000000048', 'e8000000-0000-4000-8000-000000000021', '按件服務人員P2(報表測試專用)', null, true, 'piece_rate');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at) values
  ('e8000000-0000-4000-8000-000000000051', 'e8000000-0000-4000-8000-000000000021', 'e8000000-0000-4000-8000-000000000003', '客服-無授權', 'pgtap-m8-agent-none@test.local', 'active', now()),
  ('e8000000-0000-4000-8000-000000000052', 'e8000000-0000-4000-8000-000000000021', 'e8000000-0000-4000-8000-000000000004', '客服-commission_settings', 'pgtap-m8-agent-commission@test.local', 'active', now()),
  ('e8000000-0000-4000-8000-000000000053', 'e8000000-0000-4000-8000-000000000021', 'e8000000-0000-4000-8000-000000000005', '客服-billing', 'pgtap-m8-agent-billing@test.local', 'active', now()),
  ('e8000000-0000-4000-8000-000000000054', 'e8000000-0000-4000-8000-000000000021', 'e8000000-0000-4000-8000-000000000006', '客服-staff_report', 'pgtap-m8-agent-staffreport@test.local', 'active', now());

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('e8000000-0000-4000-8000-000000000052', 'commission_settings', true),
  ('e8000000-0000-4000-8000-000000000053', 'billing', true),
  ('e8000000-0000-4000-8000-000000000054', 'staff_report', true);

insert into merchant_leave_types (id, merchant_id, name) values
  ('e8000000-0000-4000-8000-000000000061', 'e8000000-0000-4000-8000-000000000021', '事假'),
  ('e8000000-0000-4000-8000-000000000062', 'e8000000-0000-4000-8000-000000000021', '特休'),
  ('e8000000-0000-4000-8000-000000000063', 'e8000000-0000-4000-8000-000000000021', '育嬰假'),
  ('e8000000-0000-4000-8000-000000000064', 'e8000000-0000-4000-8000-000000000021', '病假'),
  ('e8000000-0000-4000-8000-000000000065', 'e8000000-0000-4000-8000-000000000021', '忘記設定規則的假別');

-- =========================================================================
-- ① §1.1~§1.5:CHECK 約束 + 預設值 + 跨表判斷落實在 RLS(不是 CHECK 約束能做到的部分先跳過,
-- 留到 ⑥ 用 RLS 直接測)。全部先以 postgres 超級使用者身分測(bypass RLS,只測 CHECK 本身)。
-- =========================================================================
-- 1.1
select throws_ok(
  $$insert into merchant_payroll_settings (merchant_id, commission_basis_type)
    values ('e8000000-0000-4000-8000-000000000021', 'invalid_mode')$$,
  '23514', null,
  '1.1:commission_basis_type 只能是 gross/net_of_material_cost,非法值被 CHECK 約束擋下'
);

select throws_ok(
  $$insert into merchant_payroll_settings (merchant_id, default_commission_rate_percentage)
    values ('e8000000-0000-4000-8000-000000000021', 150)$$,
  '23514', null,
  '1.1:default_commission_rate_percentage 超過 100 被 CHECK 約束擋下'
);

select throws_ok(
  $$insert into merchant_payroll_settings (merchant_id, pay_days_per_month)
    values ('e8000000-0000-4000-8000-000000000021', 0)$$,
  '23514', null,
  '1.1:pay_days_per_month 必須介於 1~31,0 被 CHECK 約束擋下'
);

insert into merchant_payroll_settings (merchant_id) values ('e8000000-0000-4000-8000-000000000021');

select is(
  (select row(commission_basis_type, default_commission_rate_percentage, pay_days_per_month)
   from merchant_payroll_settings where merchant_id = 'e8000000-0000-4000-8000-000000000021')::text,
  row('gross', 0.00, 30)::text,
  '1.1:不指定任何欄位時,預設值為 gross/0/30(第〇節開頭原則:預設不套用非零抽成比例)'
);

-- 1.2
select throws_ok(
  format(
    $$insert into staff_commission_rates (staff_id, rate_percentage) values ('%s', 150)$$,
    'e8000000-0000-4000-8000-000000000041'
  ),
  '23514', null,
  '1.2:rate_percentage 超過 100 被 CHECK 約束擋下'
);

insert into staff_commission_rates (staff_id, rate_percentage)
values ('e8000000-0000-4000-8000-000000000041', 30);

select throws_ok(
  format(
    $$insert into staff_commission_rates (staff_id, rate_percentage) values ('%s', 40)$$,
    'e8000000-0000-4000-8000-000000000041'
  ),
  '23505', null,
  '1.2:同一位服務人員只能有一筆覆寫(unique staff_id)'
);

delete from staff_commission_rates where staff_id = 'e8000000-0000-4000-8000-000000000041';

-- 1.3
select throws_ok(
  format(
    $$insert into staff_salary_settings (staff_id, monthly_base_salary) values ('%s', -1)$$,
    'e8000000-0000-4000-8000-000000000042'
  ),
  '23514', null,
  '1.3:monthly_base_salary 不可為負數,被 CHECK 約束擋下'
);

-- 1.4
select throws_ok(
  format(
    $$insert into leave_type_deduction_rules (merchant_id, leave_type_id, deduction_mode)
      values ('e8000000-0000-4000-8000-000000000021', '%s', 'invalid_mode')$$,
    'e8000000-0000-4000-8000-000000000061'
  ),
  '23514', null,
  '1.4:deduction_mode 只能是四選一,非法值被 CHECK 約束擋下'
);

select throws_ok(
  format(
    $$insert into leave_type_deduction_rules (merchant_id, leave_type_id, deduction_mode, percentage_value)
      values ('e8000000-0000-4000-8000-000000000021', '%s', 'percentage_of_day_rate', null)$$,
    'e8000000-0000-4000-8000-000000000063'
  ),
  '23514', null,
  '1.4:deduction_mode=percentage_of_day_rate 時 percentage_value 不可為 NULL,被 CHECK 約束擋下'
);

select throws_ok(
  format(
    $$insert into leave_type_deduction_rules (merchant_id, leave_type_id, deduction_mode, fixed_amount_value)
      values ('e8000000-0000-4000-8000-000000000021', '%s', 'fixed_amount_per_day', null)$$,
    'e8000000-0000-4000-8000-000000000064'
  ),
  '23514', null,
  '1.4:deduction_mode=fixed_amount_per_day 時 fixed_amount_value 不可為 NULL,被 CHECK 約束擋下'
);

insert into leave_type_deduction_rules (merchant_id, leave_type_id, deduction_mode) values
  ('e8000000-0000-4000-8000-000000000021', 'e8000000-0000-4000-8000-000000000061', 'full_day_rate');
insert into leave_type_deduction_rules (merchant_id, leave_type_id, deduction_mode, percentage_value) values
  ('e8000000-0000-4000-8000-000000000021', 'e8000000-0000-4000-8000-000000000063', 'percentage_of_day_rate', 50);
insert into leave_type_deduction_rules (merchant_id, leave_type_id, deduction_mode, fixed_amount_value) values
  ('e8000000-0000-4000-8000-000000000021', 'e8000000-0000-4000-8000-000000000064', 'fixed_amount_per_day', 80);
-- 062(特休)/065(忘記設定)刻意不建立規則列,測「查無資料視為 no_deduction」。

-- 1.5(booking_commission_records,直接測 CHECK 約束,booking_id 用假的,不需要真的存在
-- 才能測 CHECK——CHECK 約束檢查早於 FK 約束檢查前就會先被擋下,這裡用 lives_ok/throws_ok
-- 純粹測 gross 模式下 material_cost_deducted_snapshot 必須是 0 這條 CHECK)。
select throws_ok(
  $$insert into booking_commission_records (
      booking_id, staff_id, merchant_id, commission_basis_type_snapshot,
      commission_base_amount_snapshot, material_cost_deducted_snapshot,
      commission_rate_percentage_snapshot, commission_amount
    ) values (
      gen_random_uuid(), 'e8000000-0000-4000-8000-000000000041', 'e8000000-0000-4000-8000-000000000021',
      'gross', 1000, 50, 10, 100
    )$$,
  '23514', null,
  '1.5:CHECK 約束——commission_basis_type_snapshot=gross 時 material_cost_deducted_snapshot 必須是 0'
);

-- =========================================================================
-- ② 規則 2.1/2.2/2.3/2.5:核心抽成計算(gross/net、個人覆寫優先、按件才產生、不含助手)。
-- =========================================================================
select pg_temp.test_set_auth('e8000000-0000-4000-8000-000000000001');

-- 2.2:無個人覆寫,套用商家預設 10%。base = 1000(自訂總額) - 100(固定折扣) = 900。
update merchant_payroll_settings
set commission_basis_type = 'gross', default_commission_rate_percentage = 10, pay_days_per_month = 30
where merchant_id = 'e8000000-0000-4000-8000-000000000021';

select id from create_booking(
  p_merchant_id => 'e8000000-0000-4000-8000-000000000021',
  p_staff_id => 'e8000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e8000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-05 10:00:00+08',
  p_customer_name => '測試客戶A',
  p_customer_phone => '0955010001',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000,
  p_discount_enabled => true,
  p_discount_mode => 'fixed',
  p_discount_value => 100
) \gset default_rate_booking_

select confirm_booking(:'default_rate_booking_id'::uuid);
select complete_booking(:'default_rate_booking_id'::uuid);

select is(
  (select row(commission_basis_type_snapshot, commission_base_amount_snapshot, commission_rate_percentage_snapshot, commission_amount, material_cost_deducted_snapshot)
   from booking_commission_records where booking_id = :'default_rate_booking_id'::uuid)::text,
  row('gross', 900.00, 10.00, 90.00, 0.00)::text,
  '規則 2.1/2.2:gross 模式排除稅金、無覆寫套用商家預設 10%,900 × 10% = 90.00'
);

-- 2.2:個人覆寫優先於商家預設。P 設定覆寫 20%。base = 1000(無折扣)。
insert into staff_commission_rates (staff_id, rate_percentage)
values ('e8000000-0000-4000-8000-000000000041', 20);

select id from create_booking(
  p_merchant_id => 'e8000000-0000-4000-8000-000000000021',
  p_staff_id => 'e8000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e8000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-05 11:00:00+08',
  p_customer_name => '測試客戶B',
  p_customer_phone => '0955010002',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000
) \gset override_rate_booking_

select confirm_booking(:'override_rate_booking_id'::uuid);
select complete_booking(:'override_rate_booking_id'::uuid);

select is(
  (select commission_amount from booking_commission_records where booking_id = :'override_rate_booking_id'::uuid),
  200.00,
  '規則 2.2:個人覆寫(20%)優先於商家預設(10%),1000 × 20% = 200.00'
);

-- 規則 2.5:主要服務人員 P + 助手 AST,只有 P 產生抽成紀錄,AST 完全沒有。
select id from create_booking(
  p_merchant_id => 'e8000000-0000-4000-8000-000000000021',
  p_staff_id => 'e8000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e8000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-05 12:00:00+08',
  p_customer_name => '測試客戶C(含助手)',
  p_customer_phone => '0955010003',
  p_assistant_staff_ids => array['e8000000-0000-4000-8000-000000000043']::uuid[],
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000
) \gset assistant_booking_

select confirm_booking(:'assistant_booking_id'::uuid);
select complete_booking(:'assistant_booking_id'::uuid);

select is(
  (select count(*)::int from booking_commission_records where booking_id = :'assistant_booking_id'::uuid and staff_id = 'e8000000-0000-4000-8000-000000000041'),
  1,
  '規則 2.5:主要服務人員 P 正確產生抽成紀錄'
);

select is(
  (select count(*)::int from booking_commission_records where staff_id = 'e8000000-0000-4000-8000-000000000043'),
  0,
  '規則 2.5:助手 AST 完全不會產生抽成紀錄'
);

-- 規則 2.3:月薪制服務人員 M 完成訂單,完全不進 booking_commission_records。
select id from create_booking(
  p_merchant_id => 'e8000000-0000-4000-8000-000000000021',
  p_staff_id => 'e8000000-0000-4000-8000-000000000042',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e8000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-05 13:00:00+08',
  p_customer_name => '測試客戶D(月薪制)',
  p_customer_phone => '0955010004',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000
) \gset monthly_staff_booking_

select confirm_booking(:'monthly_staff_booking_id'::uuid);
select complete_booking(:'monthly_staff_booking_id'::uuid);

select is(
  (select count(*)::int from booking_commission_records where booking_id = :'monthly_staff_booking_id'::uuid),
  0,
  '規則 2.3:月薪制服務人員 M 完成訂單,不會產生任何抽成紀錄(不是金額 0 的紀錄,是完全沒有這筆列)'
);

-- 規則 2.1:net_of_material_cost 模式,扣除料錢成本。base = 1000 - 200(材料) = 800,20% = 160。
update merchant_payroll_settings set commission_basis_type = 'net_of_material_cost'
where merchant_id = 'e8000000-0000-4000-8000-000000000021';

select id from create_booking(
  p_merchant_id => 'e8000000-0000-4000-8000-000000000021',
  p_staff_id => 'e8000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e8000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-05 14:00:00+08',
  p_customer_name => '測試客戶E(net模式)',
  p_customer_phone => '0955010005',
  p_material_cost_item_ids => array['e8000000-0000-4000-8000-000000000032']::uuid[],
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000
) \gset net_mode_booking_

select confirm_booking(:'net_mode_booking_id'::uuid);
select complete_booking(:'net_mode_booking_id'::uuid);

select is(
  (select row(commission_basis_type_snapshot, commission_base_amount_snapshot, material_cost_deducted_snapshot, commission_amount)
   from booking_commission_records where booking_id = :'net_mode_booking_id'::uuid)::text,
  row('net_of_material_cost', 800.00, 200.00, 160.00)::text,
  '規則 2.1:net_of_material_cost 模式正確再扣除料錢成本(1000-200=800),160 = 800 × 20%'
);

-- 規則 2.1:扣除後小於 0 一律以 0 計。base(pre-material) = 100 - 100(折扣) = 0,再扣 200 材料 = -200 → 0。
select id from create_booking(
  p_merchant_id => 'e8000000-0000-4000-8000-000000000021',
  p_staff_id => 'e8000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e8000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-05 15:00:00+08',
  p_customer_name => '測試客戶F(負數以0計)',
  p_customer_phone => '0955010006',
  p_material_cost_item_ids => array['e8000000-0000-4000-8000-000000000032']::uuid[],
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 100,
  p_discount_enabled => true,
  p_discount_mode => 'fixed',
  p_discount_value => 100
) \gset negative_clip_booking_

select confirm_booking(:'negative_clip_booking_id'::uuid);
select complete_booking(:'negative_clip_booking_id'::uuid);

select is(
  (select row(commission_base_amount_snapshot, commission_amount)
   from booking_commission_records where booking_id = :'negative_clip_booking_id'::uuid)::text,
  row(0.00, 0.00)::text,
  '規則 2.1:扣除料錢成本後小於 0,以 0 計,不出現負的抽成基準'
);

-- 還原成 gross 模式、清除覆寫,供後續 ③ 規則 2.4 測試從乾淨狀態開始。
update merchant_payroll_settings
set commission_basis_type = 'gross', default_commission_rate_percentage = 10
where merchant_id = 'e8000000-0000-4000-8000-000000000021';
delete from staff_commission_rates where staff_id = 'e8000000-0000-4000-8000-000000000041';

-- =========================================================================
-- ③ 規則 2.4(核心必測):抽成快照建立後不自動重算。
-- =========================================================================
-- booking1:完成當下商家預設 10%,base=1000(無折扣)→ commission=100.00。
select id from create_booking(
  p_merchant_id => 'e8000000-0000-4000-8000-000000000021',
  p_staff_id => 'e8000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e8000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-06 10:00:00+08',
  p_customer_name => '規則24測試客戶1',
  p_customer_phone => '0955020001',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000
) \gset rule24_booking1_

select confirm_booking(:'rule24_booking1_id'::uuid);
select complete_booking(:'rule24_booking1_id'::uuid);

select is(
  (select commission_amount from booking_commission_records where booking_id = :'rule24_booking1_id'::uuid),
  100.00,
  '規則 2.4 步驟①:booking1 完成當下,commission_amount = 1000 × 10% = 100.00'
);

-- 調整商家預設抽成比例(10% → 50%)。
update merchant_payroll_settings set default_commission_rate_percentage = 50
where merchant_id = 'e8000000-0000-4000-8000-000000000021';

select is(
  (select commission_amount from booking_commission_records where booking_id = :'rule24_booking1_id'::uuid),
  100.00,
  '規則 2.4 步驟①(核心):調整商家預設抽成比例後,booking1 的舊紀錄金額完全沒有變動(仍是 100.00)'
);

-- 直接呼叫 compute_booking_commission(模擬「萬一被重複觸發」的極端情境,驗證 on conflict do
-- nothing 這道防呆是否真的生效)。以 postgres 身分呼叫(bypass 前面刻意加上的 revoke)。
select pg_temp.test_clear_auth();

select public.compute_booking_commission(:'rule24_booking1_id'::uuid);

select is(
  (select commission_amount from booking_commission_records where booking_id = :'rule24_booking1_id'::uuid),
  100.00,
  '規則 2.4 步驟①(核心,防呆生效驗證):即使直接對同一筆訂單再呼叫一次 compute_booking_commission(模擬萬一被重複觸發),既有紀錄仍然不會被覆寫,金額維持 100.00——這一條斷言就是「拿掉 on conflict do nothing 防呆後應該會 fail」的那一條,已在動工過程中實際做過拿掉/確認 fail/改回/確認 pass 的驗證(細節見本次回報)'
);

select pg_temp.test_set_auth('e8000000-0000-4000-8000-000000000001');

-- booking2:新完成一筆訂單,確認新紀錄採用調整後的新比例(50%)。
select id from create_booking(
  p_merchant_id => 'e8000000-0000-4000-8000-000000000021',
  p_staff_id => 'e8000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e8000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-06 11:00:00+08',
  p_customer_name => '規則24測試客戶2',
  p_customer_phone => '0955020002',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000
) \gset rule24_booking2_

select confirm_booking(:'rule24_booking2_id'::uuid);
select complete_booking(:'rule24_booking2_id'::uuid);

select is(
  (select commission_amount from booking_commission_records where booking_id = :'rule24_booking2_id'::uuid),
  500.00,
  '規則 2.4 步驟②:booking2 在調整後才完成,採用新比例 50%,1000 × 50% = 500.00'
);

-- =========================================================================
-- ④ 規則 2.6(核心必測):手動重新計算抽成,只限商家管理員;規則 2.9 對照組。
-- =========================================================================
-- 客服(被授權 commission_settings)呼叫 recalculate_booking_commission 被擋下。
select pg_temp.test_set_auth('e8000000-0000-4000-8000-000000000004');

select throws_ok(
  format($$select recalculate_booking_commission('%s')$$, :'rule24_booking1_id'::text),
  '42501', '重新計算已完成訂單的抽成金額,只有商家管理員可以操作',
  '規則 2.6(核心):被授權 commission_settings 的客服呼叫 recalculate_booking_commission 被擋下,即使已經被開通商家設定權限也一樣'
);

-- 對照組:同一個被擋下的客服,呼叫本模組其他一般設定功能(commission_settings 涵蓋範圍)可以成功——
-- 證明不是整個模組都鎖死,只有這一支函式特別敏感。
select lives_ok(
  $$update merchant_payroll_settings set default_commission_rate_percentage = 15
    where merchant_id = 'e8000000-0000-4000-8000-000000000021'$$,
  '規則 2.6 對照組:同一個被 recalculate_booking_commission 擋下的客服,仍然可以正常操作 merchant_payroll_settings(一般設定功能沒有被連坐鎖死)'
);

update merchant_payroll_settings set default_commission_rate_percentage = 50
where merchant_id = 'e8000000-0000-4000-8000-000000000021';

select pg_temp.test_clear_auth();

-- 商家管理員呼叫成功,金額依目前設定重算(目前商家預設已改為 50%),recalculated_at 正確寫入。
select pg_temp.test_set_auth('e8000000-0000-4000-8000-000000000001');

select lives_ok(
  format($$select recalculate_booking_commission('%s')$$, :'rule24_booking1_id'::text),
  '規則 2.6:商家管理員呼叫 recalculate_booking_commission 成功'
);

select is(
  (select row(commission_rate_percentage_snapshot, commission_amount, recalculated_at is not null)
   from booking_commission_records where booking_id = :'rule24_booking1_id'::uuid)::text,
  row(50.00, 500.00, true)::text,
  '規則 2.6:管理員重算後,booking1 改採目前設定(50%),金額變成 500.00,recalculated_at 正確寫入'
);

-- 帶入 p_override_rate_percentage 時採用指定比例(個案調整)。
select recalculate_booking_commission(:'rule24_booking1_id'::uuid, 25);

select is(
  (select row(commission_rate_percentage_snapshot, commission_amount)
   from booking_commission_records where booking_id = :'rule24_booking1_id'::uuid)::text,
  row(25.00, 250.00)::text,
  '規則 2.6:帶入 p_override_rate_percentage=25 時,直接採用這個指定比例,不查詢設定值'
);

select throws_ok(
  format($$select recalculate_booking_commission('%s', 150)$$, :'rule24_booking1_id'::text),
  'P0001', '指定的抽成比例必須介於 0~100 之間',
  '規則 2.6 邊界情況:p_override_rate_percentage 超過 100 被擋下'
);

-- 邊界情況:對月薪制訂單(完全沒有抽成紀錄)呼叫 recalculate_booking_commission 應該被擋下。
select throws_ok(
  format($$select recalculate_booking_commission('%s')$$, :'monthly_staff_booking_id'::text),
  'P0001', '這筆訂單目前沒有抽成紀錄,無法重新計算(可能是月薪制服務人員,不適用抽成)',
  '規則 2.6 邊界情況:對月薪制服務人員的訂單(沒有抽成紀錄)呼叫 recalculate_booking_commission 被擋下,訊息正確'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑤ 規則 2.9:客服權限套用範圍(commission_settings 寫入邊界)。
-- =========================================================================
select pg_temp.test_set_auth('e8000000-0000-4000-8000-000000000003');

-- UPDATE 沒有命中任何 RLS 可見的列時,Postgres 不會拋例外,只會 0 筆受影響——比照模組 7
-- §234 回歸測試的既有寫法,用「更新後數值沒有真的變動」驗證,而不是 throws_ok。
update merchant_payroll_settings set default_commission_rate_percentage = 99
  where merchant_id = 'e8000000-0000-4000-8000-000000000021';

select isnt(
  (select default_commission_rate_percentage from merchant_payroll_settings where merchant_id = 'e8000000-0000-4000-8000-000000000021'),
  99.00,
  '規則 2.9:無授權客服的 UPDATE 因 RLS 看不到寫入條件而 0 筆受影響,merchant_payroll_settings 沒有被改到'
);

select throws_ok(
  format(
    $$insert into staff_commission_rates (staff_id, rate_percentage) values ('%s', 5)$$,
    'e8000000-0000-4000-8000-000000000041'
  ),
  '42501', null,
  '規則 2.9:無授權客服不能新增 staff_commission_rates'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e8000000-0000-4000-8000-000000000004');

select lives_ok(
  format(
    $$insert into staff_commission_rates (staff_id, rate_percentage) values ('%s', 20)$$,
    'e8000000-0000-4000-8000-000000000041'
  ),
  '規則 2.9:被授權 commission_settings 的客服可以新增 staff_commission_rates'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑥ §3.3/§3.4:跨表判斷落實在 RLS WITH CHECK(只能替對應計酬類型的服務人員建立設定)。
-- =========================================================================
select pg_temp.test_set_auth('e8000000-0000-4000-8000-000000000001');

select throws_ok(
  format(
    $$insert into staff_commission_rates (staff_id, rate_percentage) values ('%s', 10)$$,
    'e8000000-0000-4000-8000-000000000042'
  ),
  '42501', null,
  '§3.3:對月薪制服務人員(M)寫入 staff_commission_rates 被 RLS WITH CHECK 擋下'
);

select throws_ok(
  format(
    $$insert into staff_salary_settings (staff_id, monthly_base_salary) values ('%s', 30000)$$,
    'e8000000-0000-4000-8000-000000000041'
  ),
  '42501', null,
  '§3.4:對按件計酬服務人員(P)寫入 staff_salary_settings 被 RLS WITH CHECK 擋下'
);

-- §3.3 測試:刪除覆寫後,新完成的訂單改採商家預設比例。
delete from staff_commission_rates where staff_id = 'e8000000-0000-4000-8000-000000000041';

select id from create_booking(
  p_merchant_id => 'e8000000-0000-4000-8000-000000000021',
  p_staff_id => 'e8000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e8000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-06 16:00:00+08',
  p_customer_name => '刪除覆寫測試客戶',
  p_customer_phone => '0955020009',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000
) \gset after_delete_override_booking_

select confirm_booking(:'after_delete_override_booking_id'::uuid);
select complete_booking(:'after_delete_override_booking_id'::uuid);

select is(
  (select commission_amount from booking_commission_records where booking_id = :'after_delete_override_booking_id'::uuid),
  500.00,
  '§3.3:刪除個人覆寫後,新完成的訂單改採商家目前預設比例(50%),1000 × 50% = 500.00'
);

-- =========================================================================
-- ⑦ 規則 2.10:五張表的 DELETE 政策盤點。
-- =========================================================================
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'merchant_payroll_settings' and cmd = 'DELETE'),
  0, '規則 2.10:merchant_payroll_settings 沒有 DELETE 政策'
);
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'staff_salary_settings' and cmd = 'DELETE'),
  0, '規則 2.10:staff_salary_settings 沒有 DELETE 政策'
);
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'leave_type_deduction_rules' and cmd = 'DELETE'),
  0, '規則 2.10:leave_type_deduction_rules 沒有 DELETE 政策'
);
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'booking_commission_records' and cmd = 'DELETE'),
  0, '規則 2.10:booking_commission_records 沒有 DELETE 政策(也沒有 INSERT/UPDATE 政策,見下一條)'
);
select is(
  (select array_agg(cmd order by cmd)::text from pg_policies where schemaname = 'public' and tablename = 'booking_commission_records'),
  '{SELECT}',
  '規則 2.10:booking_commission_records 唯一的政策是 SELECT,一律透過內部函式寫入'
);
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'staff_commission_rates' and cmd = 'DELETE'),
  1, '規則 2.10:staff_commission_rates 允許 DELETE(恢復預設值,不是危險操作)'
);

insert into staff_commission_rates (staff_id, rate_percentage)
values ('e8000000-0000-4000-8000-000000000041', 20);

select lives_ok(
  format($$delete from staff_commission_rates where staff_id = '%s'$$, 'e8000000-0000-4000-8000-000000000041'),
  '規則 2.10:staff_commission_rates 的 DELETE 實際可以成功執行(恢復套用商家預設值)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑧ 規則 2.7/2.8:假別扣款四種模式 + 月薪報表請假天數計算(跨月/同月多筆/查無規則)。
-- 服務人員 M:monthly_base_salary=3000、pay_days_per_month=30 → day_rate=100。
-- =========================================================================
select pg_temp.test_set_auth('e8000000-0000-4000-8000-000000000001');

insert into staff_salary_settings (staff_id, monthly_base_salary, monthly_leave_quota_days)
values ('e8000000-0000-4000-8000-000000000042', 3000, 5);

-- 事假(full_day_rate):兩筆分開的請假,同月多筆同假別需分組加總(3天 + 2天 = 5天 → 500)。
select create_staff_leave('e8000000-0000-4000-8000-000000000042', 'e8000000-0000-4000-8000-000000000061', '2026-11-05', '2026-11-07', null, true);
select create_staff_leave('e8000000-0000-4000-8000-000000000042', 'e8000000-0000-4000-8000-000000000061', '2026-11-20', '2026-11-21', null, true);
-- 特休(查無扣款規則,視為 no_deduction):2 天,扣款應為 0。
select create_staff_leave('e8000000-0000-4000-8000-000000000042', 'e8000000-0000-4000-8000-000000000062', '2026-11-10', '2026-11-11', null, true);
-- 育嬰假(percentage_of_day_rate 50%):2 天 → 100 × 0.5 × 2 = 100。
select create_staff_leave('e8000000-0000-4000-8000-000000000042', 'e8000000-0000-4000-8000-000000000063', '2026-11-15', '2026-11-16', null, true);
-- 病假(fixed_amount_per_day 80):1 天 → 80。
select create_staff_leave('e8000000-0000-4000-8000-000000000042', 'e8000000-0000-4000-8000-000000000064', '2026-11-25', '2026-11-25', null, true);

select is(
  (get_staff_monthly_payroll_summary('e8000000-0000-4000-8000-000000000042', 2026, 11) ->> 'total_deduction_amount')::numeric,
  680.00,
  '規則 2.7/2.8:四種模式 + 同月多筆同假別加總,總扣款 = 500(事假) + 0(特休) + 100(育嬰假) + 80(病假) = 680.00'
);

select is(
  (get_staff_monthly_payroll_summary('e8000000-0000-4000-8000-000000000042', 2026, 11) ->> 'net_pay')::numeric,
  2320.00,
  '規則 2.7:net_pay = 3000 - 680 = 2320.00'
);

select is(
  (get_staff_monthly_payroll_summary('e8000000-0000-4000-8000-000000000042', 2026, 11) ->> 'over_deduction_warning')::boolean,
  false,
  '規則 2.7:扣款金額未超過月薪基本額,over_deduction_warning = false'
);

select is(
  jsonb_array_length(get_staff_monthly_payroll_summary('e8000000-0000-4000-8000-000000000042', 2026, 11) -> 'details'),
  4,
  '規則 2.8:details 陣列有 4 筆(事假/特休/育嬰假/病假各一組,事假的兩筆已分組加總成一筆)'
);

select is(
  (
    select (elem ->> 'days')::numeric
    from jsonb_array_elements(get_staff_monthly_payroll_summary('e8000000-0000-4000-8000-000000000042', 2026, 11) -> 'details') elem
    where elem ->> 'leave_type_id' = 'e8000000-0000-4000-8000-000000000061'
  ),
  5::numeric,
  '規則 2.8:事假分組加總後天數為 5(3+2)'
);

select is(
  (get_staff_monthly_payroll_summary('e8000000-0000-4000-8000-000000000042', 2026, 11) ->> 'monthly_leave_quota_days')::numeric,
  5::numeric,
  '判斷 4:monthly_leave_quota_days 純參考回傳,不牽動扣款計算(即使實際請假天數已超過額度 5 天)'
);

-- 「忘記設定規則的假別」(065):查無規則資料視為 no_deduction。
select create_staff_leave('e8000000-0000-4000-8000-000000000042', 'e8000000-0000-4000-8000-000000000065', '2026-12-01', '2026-12-01', null, true);

select is(
  (get_staff_monthly_payroll_summary('e8000000-0000-4000-8000-000000000042', 2026, 12) ->> 'total_deduction_amount')::numeric,
  0::numeric,
  '規則 2.7 邊界情況:查無扣款規則的假別,視為 no_deduction,扣款金額為 0'
);

-- M2:跨月請假,兩個月份分別只計算重疊的天數(2026-10-30 ~ 2026-11-02,共4天,10月2天/11月2天)。
insert into staff_salary_settings (staff_id, monthly_base_salary)
values ('e8000000-0000-4000-8000-000000000045', 3000);

select create_staff_leave('e8000000-0000-4000-8000-000000000045', 'e8000000-0000-4000-8000-000000000061', '2026-10-30', '2026-11-02', null, true);

select is(
  (
    select (elem ->> 'days')::numeric
    from jsonb_array_elements(get_staff_monthly_payroll_summary('e8000000-0000-4000-8000-000000000045', 2026, 10) -> 'details') elem
    where elem ->> 'leave_type_id' = 'e8000000-0000-4000-8000-000000000061'
  ),
  2::numeric,
  '規則 2.8:跨月請假,10 月份只計算重疊的 2 天(10/30、10/31)'
);

select is(
  (
    select (elem ->> 'days')::numeric
    from jsonb_array_elements(get_staff_monthly_payroll_summary('e8000000-0000-4000-8000-000000000045', 2026, 11) -> 'details') elem
    where elem ->> 'leave_type_id' = 'e8000000-0000-4000-8000-000000000061'
  ),
  2::numeric,
  '規則 2.8:跨月請假,11 月份只計算重疊的 2 天(11/1、11/2)'
);

-- M3:完全沒有 staff_salary_settings 資料列,查無薪資設定時正確顯示 0 且不報錯。
select lives_ok(
  $$select get_staff_monthly_payroll_summary('e8000000-0000-4000-8000-000000000046', 2026, 11)$$,
  '3.10 邊界情況:完全沒有薪資設定的服務人員,呼叫報表函式不會報錯'
);

select is(
  (get_staff_monthly_payroll_summary('e8000000-0000-4000-8000-000000000046', 2026, 11) ->> 'monthly_base_salary')::numeric,
  0::numeric,
  '3.10 邊界情況:查無薪資設定時,monthly_base_salary 正確顯示為 0'
);

-- M4:扣款金額超過月薪基本額,net_pay 不會是負數,異常旗標正確標記。
insert into staff_salary_settings (staff_id, monthly_base_salary)
values ('e8000000-0000-4000-8000-000000000047', 50);
select create_staff_leave('e8000000-0000-4000-8000-000000000047', 'e8000000-0000-4000-8000-000000000064', '2026-11-01', '2026-11-02', null, true);

select is(
  (get_staff_monthly_payroll_summary('e8000000-0000-4000-8000-000000000047', 2026, 11) ->> 'net_pay')::numeric,
  0::numeric,
  '3.10:扣款金額(160)超過月薪基本額(50)時,net_pay 用 greatest(...,0) 確保不會是負數'
);

select is(
  (get_staff_monthly_payroll_summary('e8000000-0000-4000-8000-000000000047', 2026, 11) ->> 'over_deduction_warning')::boolean,
  true,
  '3.10:扣款金額超過月薪基本額時,over_deduction_warning 正確標記為 true(不是靜默把負數藏起來)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑨ §3.9/§3.11:報表彙整正確性(獨立的 P2,獨立月份 2026-12,避免跟前面區塊的資料互相干擾)、
-- 跨商家隔離、billing/staff_report 兩把獨立鑰匙。
-- =========================================================================
select pg_temp.test_set_auth('e8000000-0000-4000-8000-000000000001');

insert into staff_commission_rates (staff_id, rate_percentage)
values ('e8000000-0000-4000-8000-000000000048', 20);

select id from create_booking(
  p_merchant_id => 'e8000000-0000-4000-8000-000000000021',
  p_staff_id => 'e8000000-0000-4000-8000-000000000048',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e8000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-12-03 10:00:00+08',
  p_customer_name => '報表測試客戶R1',
  p_customer_phone => '0955030001',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000
) \gset report_booking_r1_

select confirm_booking(:'report_booking_r1_id'::uuid);
select complete_booking(:'report_booking_r1_id'::uuid);

select id from create_booking(
  p_merchant_id => 'e8000000-0000-4000-8000-000000000021',
  p_staff_id => 'e8000000-0000-4000-8000-000000000048',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e8000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-12-03 11:00:00+08',
  p_customer_name => '報表測試客戶R2',
  p_customer_phone => '0955030002',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 2000,
  p_discount_enabled => true,
  p_discount_mode => 'fixed',
  p_discount_value => 500
) \gset report_booking_r2_

select confirm_booking(:'report_booking_r2_id'::uuid);
select complete_booking(:'report_booking_r2_id'::uuid);
-- R1: 1000 × 20% = 200.00,R2: (2000-500) × 20% = 300.00,總計 500.00,2 筆訂單。

select is(
  (get_staff_commission_summary('e8000000-0000-4000-8000-000000000048', 2026, 12) ->> 'total_orders')::int,
  2,
  '§3.9:get_staff_commission_summary 正確回傳 2 筆訂單'
);

select is(
  (get_staff_commission_summary('e8000000-0000-4000-8000-000000000048', 2026, 12) ->> 'total_commission_amount')::numeric,
  500.00,
  '§3.9:get_staff_commission_summary 總抽成金額正確 = 200 + 300 = 500.00'
);

-- P2 也以助手身份參與一筆 P 的訂單(規則 2.5 參考資訊,不影響金額)。
select id from create_booking(
  p_merchant_id => 'e8000000-0000-4000-8000-000000000021',
  p_staff_id => 'e8000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e8000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-12-03 12:00:00+08',
  p_customer_name => '報表測試客戶R3(P2當助手)',
  p_customer_phone => '0955030003',
  p_assistant_staff_ids => array['e8000000-0000-4000-8000-000000000048']::uuid[],
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000
) \gset report_booking_r3_

select confirm_booking(:'report_booking_r3_id'::uuid);
select complete_booking(:'report_booking_r3_id'::uuid);

select is(
  (get_staff_commission_summary('e8000000-0000-4000-8000-000000000048', 2026, 12) ->> 'assistant_booking_count')::int,
  1,
  '規則 2.5/§3.9:P2 本月以助手身份參與 1 筆訂單(只是參考資訊,不影響上面的抽成總計 500.00)'
);

-- §3.11:店家帳務報表(2026-12,只含 R1/R2/R3 三筆訂單 + P2 覆寫比例造成的抽成)。
select is(
  (get_merchant_billing_summary('e8000000-0000-4000-8000-000000000021', 2026, 12) ->> 'total_revenue')::numeric,
  3500.00,
  '§3.11:total_revenue = 1000(R1) + 1500(R2,已折扣500) + 1000(R3) = 3500.00(含稅口徑,用 final_amount_snapshot)'
);

-- total_commission_payout 用 computed_at(抽成實際「產生」的當下時間,即測試執行當下的 now(),
-- 不是本測試檔案為了方便安排的訂單 start_at 虛構日期)當月份基準,所以這裡不能寫死期待值,
-- 改成直接對照「用同一套 computed_at 篩選條件」手動加總的結果是否一致(驗證彙整邏輯本身正確,
-- 不受測試執行時的實際時間影響)。
select is(
  (get_merchant_billing_summary(
    'e8000000-0000-4000-8000-000000000021',
    extract(year from now())::int,
    extract(month from now())::int
  ) ->> 'total_commission_payout')::numeric,
  (select coalesce(sum(commission_amount), 0) from booking_commission_records
   where merchant_id = 'e8000000-0000-4000-8000-000000000021'
     and computed_at >= date_trunc('month', now())
     and computed_at < date_trunc('month', now()) + interval '1 month'),
  '§3.11:total_commission_payout 用 computed_at(而非訂單日期)當月份基準,跟直接對 booking_commission_records 用相同篩選條件加總的結果一致'
);

select pg_temp.test_clear_auth();

-- 跨商家隔離:B 店管理員不能查詢 A 店的報表。
select pg_temp.test_set_auth('e8000000-0000-4000-8000-000000000002');

select throws_ok(
  $$select get_staff_commission_summary('e8000000-0000-4000-8000-000000000048', 2026, 12)$$,
  '42501', '沒有權限查詢這間商家的師傅報表',
  '§3.9 跨商家隔離:B 店管理員不能查詢 A 店服務人員的師傅報表(函式是 SECURITY DEFINER,查得到 merchant_id,但權限檢查正確擋下)'
);

select throws_ok(
  $$select get_merchant_billing_summary('e8000000-0000-4000-8000-000000000021', 2026, 12)$$,
  '42501', null,
  '§3.11 跨商家隔離:B 店管理員不能查詢 A 店的帳務報表'
);

select pg_temp.test_clear_auth();

-- billing/staff_report 不是完全對稱的兩把鑰匙(規格書 §3.9/§3.10/§3.11 明講):師傅報表
-- (3.9/3.10)檢查較寬的 private.can_view_payroll_reports(billing 或 staff_report 任一即可),
-- 只有店家帳務報表(3.11)檢查較窄的 private.can_view_billing——所以被授權 billing 的客服
-- 「連帶」可以看師傅報表,但被授權 staff_report 的客服不能看店家帳務報表(下面緊接著測試這個方向)。
select pg_temp.test_set_auth('e8000000-0000-4000-8000-000000000005');

select lives_ok(
  $$select get_merchant_billing_summary('e8000000-0000-4000-8000-000000000021', 2026, 12)$$,
  '規則 2.9:被授權 billing 的客服可以查詢店家帳務報表'
);

select lives_ok(
  $$select get_staff_commission_summary('e8000000-0000-4000-8000-000000000048', 2026, 12)$$,
  '規則 2.9:被授權 billing 的客服「連帶」也可以查詢師傅報表(3.9 檢查的是較寬的 can_view_payroll_reports,billing 或 staff_report 任一即可,規格書明講的設計,不是漏洞)'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e8000000-0000-4000-8000-000000000006');

select lives_ok(
  $$select get_staff_commission_summary('e8000000-0000-4000-8000-000000000048', 2026, 12)$$,
  '規則 2.9:被授權 staff_report 的客服可以查詢師傅報表'
);

select throws_ok(
  $$select get_merchant_billing_summary('e8000000-0000-4000-8000-000000000021', 2026, 12)$$,
  '42501', null,
  '規則 2.9:被授權 staff_report(沒有 billing)的客服不能查詢店家帳務報表'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑩ SPECS-INDEX #299/#302 回歸修正(20260920130000_merchant_staff_select_policy_payroll_fix.sql):
-- 「抽成與薪資設定頁」(/app/payroll-settings)跟「師傅報表頁」(/app/staff-report)的服務人員
-- 清單/下拉選單都是透過 useMerchantStaffList 讀 merchant_staff(merchant_id + status=active)。
-- 這兩個頁面的路由守衛明確允許 commission_settings/billing/staff_report 三把鑰匙其中之一的客服
-- 進入,但 merchant_staff_select 政策原本只有 is_merchant_admin/can_manage_bookings/
-- can_manage_team_leave 三種身分放行,導致這三種客服打開頁面時清單永遠是空的(即使商家確實有
-- 在職服務人員)。修法是在政策裡加上 can_manage_commission_settings/can_view_payroll_reports
-- 兩個條件(各自內部已涵蓋 is_merchant_admin)。無授權客服(agent-none)維持讀不到,確保這次放寬
-- 沒有波及完全沒被開通任何權限的客服。
-- =========================================================================
select pg_temp.test_set_auth('e8000000-0000-4000-8000-000000000004');

select is(
  (select count(*)::int from merchant_staff where merchant_id = 'e8000000-0000-4000-8000-000000000021' and status = 'active'),
  7,
  '§299 回歸修正:被授權 commission_settings(沒有 orders/team_leave)的客服現在能讀到 A 店在職服務人員清單(抽成與薪資設定頁用)'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e8000000-0000-4000-8000-000000000005');

select is(
  (select count(*)::int from merchant_staff where merchant_id = 'e8000000-0000-4000-8000-000000000021' and status = 'active'),
  7,
  '§302 回歸修正:被授權 billing(can_view_payroll_reports 涵蓋)的客服現在能讀到 A 店在職服務人員清單(師傅報表頁下拉選單用)'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e8000000-0000-4000-8000-000000000006');

select is(
  (select count(*)::int from merchant_staff where merchant_id = 'e8000000-0000-4000-8000-000000000021' and status = 'active'),
  7,
  '§302 回歸修正:被授權 staff_report 的客服現在能讀到 A 店在職服務人員清單(師傅報表頁下拉選單用)'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e8000000-0000-4000-8000-000000000003');

select is(
  (select count(*)::int from merchant_staff where merchant_id = 'e8000000-0000-4000-8000-000000000021' and status = 'active'),
  0,
  '對照組:完全沒被開通任何權限的客服(agent-none)這次修正後仍然讀不到服務人員清單,確認放寬範圍沒有波及無授權客服'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑪ §3.12:新商家建立時自動種入預設薪資設定與假別扣款規則。
-- =========================================================================
select pg_temp.test_set_auth('e8000000-0000-4000-8000-000000000001');

select public.create_group_and_merchant('薪資帳務種子測試店-群組', 'in_store_beauty') \gset seed_group_merchant_

select is(
  (select count(*)::int from merchant_payroll_settings where merchant_id = :'seed_group_merchant_create_group_and_merchant'::uuid),
  1,
  '§3.12:create_group_and_merchant 建立商家後,merchant_payroll_settings 剛好 1 筆'
);

select is(
  (select row(commission_basis_type, default_commission_rate_percentage, pay_days_per_month)
   from merchant_payroll_settings where merchant_id = :'seed_group_merchant_create_group_and_merchant'::uuid)::text,
  row('gross', 0.00, 30)::text,
  '§3.12:種入的預設薪資設定為 gross/0%/30 天(第〇節開頭原則)'
);

select is(
  (select count(*)::int from merchant_leave_types where merchant_id = :'seed_group_merchant_create_group_and_merchant'::uuid),
  3,
  '§3.12:對照組——create_group_and_merchant 仍然正確種入模組 7 的 3 筆預設假別'
);

select is(
  (select count(*)::int from leave_type_deduction_rules where merchant_id = :'seed_group_merchant_create_group_and_merchant'::uuid),
  3,
  '§3.12:leave_type_deduction_rules 筆數等於當下 merchant_leave_types 筆數(3 筆)'
);

select is(
  (select count(*)::int from leave_type_deduction_rules
   where merchant_id = :'seed_group_merchant_create_group_and_merchant'::uuid and deduction_mode = 'no_deduction'),
  3,
  '§3.12:種入的假別扣款規則全部是 no_deduction(不預設任何假別要扣款)'
);

select group_id from merchants where id = :'seed_group_merchant_create_group_and_merchant'::uuid \gset seed_group_

select public.create_merchant_in_group(:'seed_group_group_id'::uuid, '薪資帳務種子測試店-同集團第二間', 'in_store_beauty') \gset seed_second_merchant_

select is(
  (select count(*)::int from merchant_payroll_settings where merchant_id = :'seed_second_merchant_create_merchant_in_group'::uuid),
  1,
  '§3.12:create_merchant_in_group 建立分店後,merchant_payroll_settings 也剛好 1 筆'
);

select is(
  (select count(*)::int from leave_type_deduction_rules where merchant_id = :'seed_second_merchant_create_merchant_in_group'::uuid),
  3,
  '§3.12:create_merchant_in_group 建立分店後,leave_type_deduction_rules 也剛好 3 筆(對齊假別筆數)'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
