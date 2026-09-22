-- 商家端三項調整規格書 §二(服務項目層級抽成)— 核心必測:2.3/2.4(分攤/計算公式)、
-- 2.6(快照鎖定)、2.7.1(計算引擎各種情境)、2.7.3(重算新簽章)、2.7.4(批量套用)、
-- 2.7.6(新表 RLS)。
begin;

select plan(43);

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
-- Fixture:一間商家,管理員 + 被授權 commission_settings 的客服 + 完全無授權的客服。
-- 兩個服務項目(A 500 元、B 1000 元)+ 按件計酬服務人員 P + 月薪制服務人員 M。
-- =========================================================================
insert into auth.users (id, email) values
  ('ec000000-0000-4000-8000-000000000001', 'pgtap-m16-admin@test.local'),
  ('ec000000-0000-4000-8000-000000000002', 'pgtap-m16-agent-commission@test.local'),
  ('ec000000-0000-4000-8000-000000000003', 'pgtap-m16-agent-none@test.local'),
  ('ec000000-0000-4000-8000-000000000004', 'pgtap-m16-agent-billing@test.local');

insert into groups (id) values ('ec000000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000011', '服務項目抽成測試店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000001');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'ec000000-0000-4000-8000-000000000021', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('ec000000-0000-4000-8000-000000000031', 'ec000000-0000-4000-8000-000000000021', 'A項目', 500, 'primary', 30),
  ('ec000000-0000-4000-8000-000000000032', 'ec000000-0000-4000-8000-000000000021', 'B項目', 1000, 'primary', 60),
  ('ec000000-0000-4000-8000-000000000033', 'ec000000-0000-4000-8000-000000000021', 'C項目(0元)', 0, 'primary', 15);

insert into material_cost_items (id, merchant_id, name, amount) values
  ('ec000000-0000-4000-8000-000000000034', 'ec000000-0000-4000-8000-000000000021', '材料', 300);

insert into merchant_feature_flags (merchant_id, feature_key, enabled) values
  ('ec000000-0000-4000-8000-000000000021', 'material_cost_enabled', true);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, compensation_type) values
  ('ec000000-0000-4000-8000-000000000041', 'ec000000-0000-4000-8000-000000000021', '按件服務人員P', '0901000101', true, 'piece_rate'),
  ('ec000000-0000-4000-8000-000000000042', 'ec000000-0000-4000-8000-000000000021', '月薪服務人員M', '0901000102', true, 'monthly_salary');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('ec000000-0000-4000-8000-000000000051', 'ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000002', '客服-commission_settings', 'pgtap-m16-agent-commission@test.local', 'active', now(), '0900000101'),
  ('ec000000-0000-4000-8000-000000000052', 'ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000003', '客服-無授權', 'pgtap-m16-agent-none@test.local', 'active', now(), '0900000102'),
  ('ec000000-0000-4000-8000-000000000053', 'ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000004', '客服-billing', 'pgtap-m16-agent-billing@test.local', 'active', now(), '0900000103');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('ec000000-0000-4000-8000-000000000051', 'commission_settings', true),
  ('ec000000-0000-4000-8000-000000000053', 'billing', true);

insert into merchant_payroll_settings (merchant_id, commission_basis_type) values
  ('ec000000-0000-4000-8000-000000000021', 'gross');

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');

-- =========================================================================
-- ① §2.2.1 CHECK 約束(取代原本 staff_commission_rates 的 1.2)。
-- =========================================================================
select throws_ok(
  format(
    $$insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value)
      values ('%s', '%s', 'percentage', 150)$$,
    'ec000000-0000-4000-8000-000000000041', 'ec000000-0000-4000-8000-000000000031'
  ),
  '23514', null,
  '§2.2.1:commission_mode=percentage 時 commission_value 超過 100 被 CHECK 約束擋下'
);

select lives_ok(
  format(
    $$insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value)
      values ('%s', '%s', 'fixed_amount', 500)$$,
    'ec000000-0000-4000-8000-000000000041', 'ec000000-0000-4000-8000-000000000033'
  ),
  '§2.2.1:commission_mode=fixed_amount 時,commission_value 沒有 100 的上限限制(500 可以正常寫入)'
);
delete from staff_service_commission_rates
where staff_id = 'ec000000-0000-4000-8000-000000000041' and service_item_id = 'ec000000-0000-4000-8000-000000000033';

insert into staff_service_commission_rates (staff_id, service_item_id) values
  ('ec000000-0000-4000-8000-000000000041', 'ec000000-0000-4000-8000-000000000031');

select throws_ok(
  format(
    $$insert into staff_service_commission_rates (staff_id, service_item_id) values ('%s', '%s')$$,
    'ec000000-0000-4000-8000-000000000041', 'ec000000-0000-4000-8000-000000000031'
  ),
  '23505', null,
  '§2.2.1:同一個 (staff_id, service_item_id) 組合只能有一筆(unique 約束)'
);

delete from staff_service_commission_rates
where staff_id = 'ec000000-0000-4000-8000-000000000041' and service_item_id = 'ec000000-0000-4000-8000-000000000031';

-- =========================================================================
-- ② §2.3/2.4:分攤與計算公式核心情境。
-- =========================================================================
-- A=10%(percentage)、B=20%(percentage)。訂單 A(qty1)+B(qty1),折扣 150(固定金額)。
-- raw_total=1500,ratio_A=1/3,ratio_B=2/3。effective_subtotal_A=500,discount_share_A=50,
-- base_A=450,commission_A=45.00。effective_subtotal_B=1000,discount_share_B=100,
-- base_B=900,commission_B=180.00。total=225.00,total_base=1350.00。
insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value) values
  ('ec000000-0000-4000-8000-000000000041', 'ec000000-0000-4000-8000-000000000031', 'percentage', 10),
  ('ec000000-0000-4000-8000-000000000041', 'ec000000-0000-4000-8000-000000000032', 'percentage', 20);
-- SPECS-INDEX #604(2026-09-23 批次修正,機械性補參數,不改變測試本身要驗證的邏輯):
-- create_booking 新建訂單付款方式改為必填,下面既有的 create_booking/update_booking 呼叫
-- 補上 p_payment_method_id。
insert into payment_methods (id, merchant_id, name) values ('6044747d-245c-5c27-ba98-63d61997fb5d', 'ec000000-0000-4000-8000-000000000021', '現場付款');


select id from create_booking(
  p_merchant_id => 'ec000000-0000-4000-8000-000000000021',
  p_staff_id => 'ec000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(
    jsonb_build_object('service_item_id','ec000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500),
    jsonb_build_object('service_item_id','ec000000-0000-4000-8000-000000000032','quantity',1,'unit_price',1000)
  ),
  p_start_at => '2026-11-10 10:00:00+08',
  p_customer_name => '多項目測試客戶1',
  p_customer_phone => '0966010001',
  p_discount_enabled => true,
  p_discount_mode => 'fixed',
  p_discount_value => 150
, p_payment_method_id => '6044747d-245c-5c27-ba98-63d61997fb5d') \gset multi_item_booking_

select confirm_booking(:'multi_item_booking_id'::uuid);
select complete_booking(:'multi_item_booking_id'::uuid);

select is(
  (select row(commission_amount, commission_base_amount_snapshot, commission_rate_percentage_snapshot)
   from booking_commission_records where booking_id = :'multi_item_booking_id'::uuid)::text,
  row(225.00, 1350.00, null)::text,
  '§2.3/2.4:多服務項目依金額佔比分攤,彙總金額 45+180=225.00,彙總基準 450+900=1350.00,commission_rate_percentage_snapshot 一律為 null'
);

select is(
  (select row(bcir.service_item_name_snapshot, bcir.commission_mode_snapshot, bcir.commission_base_amount_snapshot, bcir.commission_amount)
   from booking_commission_item_records bcir
   join booking_commission_records bcr on bcr.id = bcir.commission_record_id
   where bcr.booking_id = :'multi_item_booking_id'::uuid and bcir.service_item_name_snapshot = 'A項目')::text,
  row('A項目', 'percentage', 450.00, 45.00)::text,
  '§2.4:A項目明細正確——base=450.00(佔比1/3),45.00=450×10%'
);

select is(
  (select row(bcir.service_item_name_snapshot, bcir.commission_mode_snapshot, bcir.commission_base_amount_snapshot, bcir.commission_amount)
   from booking_commission_item_records bcir
   join booking_commission_records bcr on bcr.id = bcir.commission_record_id
   where bcr.booking_id = :'multi_item_booking_id'::uuid and bcir.service_item_name_snapshot = 'B項目')::text,
  row('B項目', 'percentage', 900.00, 180.00)::text,
  '§2.4:B項目明細正確——base=900.00(佔比2/3),180.00=900×20%'
);

-- 混用模式:A 改成 fixed_amount 60 元/件,B 維持 percentage 20%。訂單 A(qty2)+B(qty1),無折扣。
update staff_service_commission_rates set commission_mode = 'fixed_amount', commission_value = 60
where staff_id = 'ec000000-0000-4000-8000-000000000041' and service_item_id = 'ec000000-0000-4000-8000-000000000031';

select id from create_booking(
  p_merchant_id => 'ec000000-0000-4000-8000-000000000021',
  p_staff_id => 'ec000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(
    jsonb_build_object('service_item_id','ec000000-0000-4000-8000-000000000031','quantity',2,'unit_price',500),
    jsonb_build_object('service_item_id','ec000000-0000-4000-8000-000000000032','quantity',1,'unit_price',1000)
  ),
  p_start_at => '2026-11-10 12:00:00+08',
  p_customer_name => '混用模式測試客戶',
  p_customer_phone => '0966010002'
, p_payment_method_id => '6044747d-245c-5c27-ba98-63d61997fb5d') \gset mixed_mode_booking_

select confirm_booking(:'mixed_mode_booking_id'::uuid);
select complete_booking(:'mixed_mode_booking_id'::uuid);

select is(
  (select row(bcir.commission_mode_snapshot, bcir.commission_base_amount_snapshot, bcir.commission_amount)
   from booking_commission_item_records bcir
   join booking_commission_records bcr on bcr.id = bcir.commission_record_id
   where bcr.booking_id = :'mixed_mode_booking_id'::uuid and bcir.service_item_name_snapshot = 'A項目')::text,
  row('fixed_amount', 0.00, 120.00)::text,
  '§2.4:fixed_amount 模式不看基準(base 固定寫 0),120.00 = 60元/件 × 2件,不受訂單金額影響'
);

select is(
  (select commission_amount from booking_commission_records where booking_id = :'mixed_mode_booking_id'::uuid),
  320.00,
  '§2.3/2.4:混用模式彙總正確,120(A,fixed) + 200(B,1000×20%) = 320.00'
);

-- 決策2:查無設定的服務項目視為 percentage/0,不擋單。C項目(0元,測完全沒設定)。
update staff_service_commission_rates set commission_mode = 'percentage', commission_value = 10
where staff_id = 'ec000000-0000-4000-8000-000000000041' and service_item_id = 'ec000000-0000-4000-8000-000000000031';

-- SPECS-INDEX #604:補上 p_payment_method_id(重用上面已建立的 6044747d... 付款方式)。
select lives_ok(
  format(
    $$select id from create_booking(
      p_merchant_id => '%s', p_staff_id => '%s',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','%s','quantity',1,'unit_price',800)),
      p_start_at => '2026-11-10 14:30:00+08', p_customer_name => '未設定抽成測試客戶', p_customer_phone => '0966010003',
      p_payment_method_id => '6044747d-245c-5c27-ba98-63d61997fb5d'
    )$$,
    'ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000041', 'ec000000-0000-4000-8000-000000000032'
  ),
  '判斷2:B項目雖然目前有設定,先刪掉再測——建單本身不受抽成設定影響,能正常建立'
);

delete from staff_service_commission_rates
where staff_id = 'ec000000-0000-4000-8000-000000000041' and service_item_id = 'ec000000-0000-4000-8000-000000000032';

select id from create_booking(
  p_merchant_id => 'ec000000-0000-4000-8000-000000000021',
  p_staff_id => 'ec000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ec000000-0000-4000-8000-000000000032','quantity',1,'unit_price',1000)),
  p_start_at => '2026-11-10 16:00:00+08',
  p_customer_name => '判斷2測試客戶',
  p_customer_phone => '0966010004'
, p_payment_method_id => '6044747d-245c-5c27-ba98-63d61997fb5d') \gset no_rate_booking_

select confirm_booking(:'no_rate_booking_id'::uuid);

select lives_ok(
  format($$select complete_booking('%s')$$, :'no_rate_booking_id'::text),
  '判斷2(核心):查無 staff_service_commission_rates 設定的服務項目,complete_booking 不會被擋下,正常完成'
);

select is(
  (select commission_amount from booking_commission_records where booking_id = :'no_rate_booking_id'::uuid),
  0.00,
  '判斷2(核心):查無設定的服務項目,commission_amount = 0.00(不是報錯,也不是隨便給非零數字)'
);

select is(
  (select row(commission_mode_snapshot, commission_value_snapshot)
   from booking_commission_item_records bcir
   join booking_commission_records bcr on bcr.id = bcir.commission_record_id
   where bcr.booking_id = :'no_rate_booking_id'::uuid)::text,
  row('percentage', 0.00)::text,
  '判斷2:明細正確記錄成 percentage/0,而不是省略這筆明細'
);

-- custom_total_amount_enabled:實際成交小計蓋過逐項加總,分攤仍依原始金額佔比計算。
insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value) values
  ('ec000000-0000-4000-8000-000000000041', 'ec000000-0000-4000-8000-000000000032', 'percentage', 10);

select id from create_booking(
  p_merchant_id => 'ec000000-0000-4000-8000-000000000021',
  p_staff_id => 'ec000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(
    jsonb_build_object('service_item_id','ec000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500),
    jsonb_build_object('service_item_id','ec000000-0000-4000-8000-000000000032','quantity',1,'unit_price',1000)
  ),
  p_start_at => '2026-11-10 18:00:00+08',
  p_customer_name => '套餐優惠價測試客戶',
  p_customer_phone => '0966010005',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 900
, p_payment_method_id => '6044747d-245c-5c27-ba98-63d61997fb5d') \gset custom_total_booking_

select confirm_booking(:'custom_total_booking_id'::uuid);
select complete_booking(:'custom_total_booking_id'::uuid);

-- ratio 仍依原始單價(500:1000=1:2)算,effective_subtotal_A = 900×1/3=300.00,
-- effective_subtotal_B = 900×2/3=600.00。A是percentage10%→30.00,B是percentage10%→60.00,合計90.00。
select is(
  (select commission_amount from booking_commission_records where booking_id = :'custom_total_booking_id'::uuid),
  90.00,
  '§2.3 邊界情況:custom_total_amount_enabled 開啟時,用「實際成交小計」900 分攤(而非逐項原價加總的1500),90.00 = 30(A) + 60(B)'
);

-- raw_total=0 極端邊界情況:兩個服務項目單價都是 0,退回平均分攤。
insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value) values
  ('ec000000-0000-4000-8000-000000000041', 'ec000000-0000-4000-8000-000000000033', 'percentage', 50)
on conflict (staff_id, service_item_id) do update set commission_mode = 'percentage', commission_value = 50;

select id from create_booking(
  p_merchant_id => 'ec000000-0000-4000-8000-000000000021',
  p_staff_id => 'ec000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(
    jsonb_build_object('service_item_id','ec000000-0000-4000-8000-000000000033','quantity',1,'unit_price',0)
  ),
  p_start_at => '2026-11-10 20:00:00+08',
  p_customer_name => '零元項目測試客戶',
  p_customer_phone => '0966010006',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000
, p_payment_method_id => '6044747d-245c-5c27-ba98-63d61997fb5d') \gset zero_price_booking_

select confirm_booking(:'zero_price_booking_id'::uuid);
select complete_booking(:'zero_price_booking_id'::uuid);

select is(
  (select commission_amount from booking_commission_records where booking_id = :'zero_price_booking_id'::uuid),
  500.00,
  '§2.3 邊界情況:raw_total=0(唯一項目單價0元)時退回平均分攤,整筆自訂總額1000全數分給這一項,500.00=1000×50%'
);

-- net_of_material_cost:料錢成本依佔比分攤扣除。
update merchant_payroll_settings set commission_basis_type = 'net_of_material_cost'
where merchant_id = 'ec000000-0000-4000-8000-000000000021';

select id from create_booking(
  p_merchant_id => 'ec000000-0000-4000-8000-000000000021',
  p_staff_id => 'ec000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(
    jsonb_build_object('service_item_id','ec000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500),
    jsonb_build_object('service_item_id','ec000000-0000-4000-8000-000000000032','quantity',1,'unit_price',1000)
  ),
  p_start_at => '2026-11-10 21:00:00+08',
  p_customer_name => '料錢成本分攤測試客戶',
  p_customer_phone => '0966010007',
  p_material_cost_item_ids => array['ec000000-0000-4000-8000-000000000034']::uuid[]
, p_payment_method_id => '6044747d-245c-5c27-ba98-63d61997fb5d') \gset material_cost_booking_

select confirm_booking(:'material_cost_booking_id'::uuid);
select complete_booking(:'material_cost_booking_id'::uuid);

-- raw_total=1500,材料成本300,ratio_A=1/3→分攤100,ratio_B=2/3→分攤200。
-- base_A=500-100=400,commission_A(fixed 60 already? no,回復percentage10%)。
-- 先確認 A 目前是 percentage 10%,B percentage 10%(前面設定)。
-- base_A=400→A=40.00;base_B=1000-200=800→B=80.00;合計120.00,material_cost_deducted彙總=300.00。
select is(
  (select row(commission_amount, material_cost_deducted_snapshot)
   from booking_commission_records where booking_id = :'material_cost_booking_id'::uuid)::text,
  row(120.00, 300.00)::text,
  '§2.3:net_of_material_cost 模式,料錢成本依原始金額佔比分攤扣除,彙總抽成120.00、彙總扣除料錢成本300.00'
);

update merchant_payroll_settings set commission_basis_type = 'gross'
where merchant_id = 'ec000000-0000-4000-8000-000000000021';

-- =========================================================================
-- ③ 規則 2.6(核心必測):服務項目層級抽成設定改動後,只影響「之後」新完成的訂單。
-- =========================================================================
select is(
  (select commission_amount from booking_commission_records where booking_id = :'multi_item_booking_id'::uuid),
  225.00,
  '規則 2.6 步驟①:調整前,multi_item_booking 的彙總金額是 225.00'
);

update staff_service_commission_rates set commission_value = 90
where staff_id = 'ec000000-0000-4000-8000-000000000041' and service_item_id = 'ec000000-0000-4000-8000-000000000031';

select is(
  (select commission_amount from booking_commission_records where booking_id = :'multi_item_booking_id'::uuid),
  225.00,
  '規則 2.6(核心):調整 A 項目抽成比例後,已完成訂單 multi_item_booking 的舊彙總金額完全沒有變動'
);

select is(
  (select bcir.commission_amount from booking_commission_item_records bcir
   join booking_commission_records bcr on bcr.id = bcir.commission_record_id
   where bcr.booking_id = :'multi_item_booking_id'::uuid and bcir.service_item_name_snapshot = 'A項目'),
  45.00,
  '規則 2.6(核心):明細子表也完全沒有變動,A項目仍是 45.00'
);

select id from create_booking(
  p_merchant_id => 'ec000000-0000-4000-8000-000000000021',
  p_staff_id => 'ec000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ec000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-10 23:00:00+08',
  p_customer_name => '規則26新訂單測試客戶',
  p_customer_phone => '0966010008'
, p_payment_method_id => '6044747d-245c-5c27-ba98-63d61997fb5d') \gset rule26_new_booking_

select confirm_booking(:'rule26_new_booking_id'::uuid);
select complete_booking(:'rule26_new_booking_id'::uuid);

select is(
  (select commission_amount from booking_commission_records where booking_id = :'rule26_new_booking_id'::uuid),
  450.00,
  '規則 2.6:新完成的訂單採用調整後的新比例 90%,500×90%=450.00'
);

update staff_service_commission_rates set commission_value = 10
where staff_id = 'ec000000-0000-4000-8000-000000000041' and service_item_id = 'ec000000-0000-4000-8000-000000000031';

-- =========================================================================
-- ④ §2.7.3:recalculate_booking_commission 新簽章(拿掉 override 參數)。
-- =========================================================================
select throws_ok(
  $$select recalculate_booking_commission('deadbeef-0000-4000-8000-000000000000', 25)$$,
  '42883', null,
  '§2.7.3:舊簽章 recalculate_booking_commission(uuid, numeric) 已經不存在,呼叫會直接報函式不存在'
);

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000002');

select throws_ok(
  format($$select recalculate_booking_commission('%s')$$, :'multi_item_booking_id'::text),
  '42501', '重新計算已完成訂單的抽成金額,只有商家管理員可以操作',
  '§2.7.3:被授權 commission_settings 的客服呼叫 recalculate_booking_commission(新簽章)一樣被擋下,只有管理員能操作'
);

select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');

select lives_ok(
  format($$select recalculate_booking_commission('%s')$$, :'multi_item_booking_id'::text),
  '§2.7.3:商家管理員呼叫新簽章 recalculate_booking_commission(單一參數)成功'
);

-- 這裡的「目前最新設定」是動工到這裡累積下來的實際狀態:A 項目前面規則2.6測試改成90%又
-- 改回10%;B 項目在後面§2.3的 custom_total_amount 情境測試時被重新 insert 成10%(不是原本
-- 的20%)。重算應該完全依「目前」的設定重新算(45(A,10%) + 90(B,已改成10%) = 135.00),
-- 用來驗證 recalculate_booking_commission 是真的重新跑一次計算引擎抓最新設定,不是回傳
-- 快取的舊值。
select is(
  (select commission_amount from booking_commission_records where booking_id = :'multi_item_booking_id'::uuid),
  135.00,
  '§2.7.3:管理員重算後,金額依目前最新設定(A=10%,B=10%)重新算出 135.00,recalculated_at 有值'
);

select is(
  (select recalculated_at is not null from booking_commission_records where booking_id = :'multi_item_booking_id'::uuid),
  true,
  '§2.7.3:重算後 recalculated_at 正確寫入'
);

select is(
  (select count(*)::int from booking_commission_item_records bcir
   join booking_commission_records bcr on bcr.id = bcir.commission_record_id
   where bcr.booking_id = :'multi_item_booking_id'::uuid),
  2,
  '§2.7.3:重算後明細子表先刪除再重新插入,筆數仍然是 2 筆(不是變成 4 筆殘留舊資料)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑤ §2.7.4:batch_apply_staff_service_commission_rates。
-- =========================================================================
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');

select lives_ok(
  format(
    $$select batch_apply_staff_service_commission_rates('%s', array['%s','%s']::uuid[], 'percentage', 15)$$,
    'ec000000-0000-4000-8000-000000000041',
    'ec000000-0000-4000-8000-000000000031', 'ec000000-0000-4000-8000-000000000032'
  ),
  '§2.7.4:批量套用成功'
);

select is(
  (select array_agg(commission_value order by service_item_id)::text from staff_service_commission_rates
   where staff_id = 'ec000000-0000-4000-8000-000000000041'
     and service_item_id in ('ec000000-0000-4000-8000-000000000031', 'ec000000-0000-4000-8000-000000000032')),
  '{15.00,15.00}',
  '§2.7.4:批量套用後,指定的兩個項目 commission_value 都變成 15'
);

select is(
  (select commission_mode from staff_service_commission_rates
   where staff_id = 'ec000000-0000-4000-8000-000000000041' and service_item_id = 'ec000000-0000-4000-8000-000000000033'),
  'percentage',
  '§2.7.4:不在批量套用清單內的 C項目 不受影響(維持原本 50%,mode 仍是 percentage)'
);

select is(
  (select commission_value from staff_service_commission_rates
   where staff_id = 'ec000000-0000-4000-8000-000000000041' and service_item_id = 'ec000000-0000-4000-8000-000000000033'),
  50.00,
  '§2.7.4:C項目數值確實維持 50,沒有被批量套用波及'
);

select throws_ok(
  format(
    $$select batch_apply_staff_service_commission_rates('%s', array['%s']::uuid[], 'percentage', 10)$$,
    'ec000000-0000-4000-8000-000000000042', 'ec000000-0000-4000-8000-000000000031'
  ),
  'P0001', '只有按件計酬的服務人員可以設定抽成',
  '§2.7.4:對月薪制服務人員呼叫批量套用被擋下'
);

select throws_ok(
  format(
    $$select batch_apply_staff_service_commission_rates('%s', array['%s']::uuid[], 'percentage', 150)$$,
    'ec000000-0000-4000-8000-000000000041', 'ec000000-0000-4000-8000-000000000031'
  ),
  'P0001', '百分比模式下,抽成數值必須介於 0~100 之間',
  '§2.7.4:百分比模式下數值超過 100 被擋下'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000003');

select throws_ok(
  format(
    $$select batch_apply_staff_service_commission_rates('%s', array['%s']::uuid[], 'percentage', 10)$$,
    'ec000000-0000-4000-8000-000000000041', 'ec000000-0000-4000-8000-000000000031'
  ),
  '42501', null,
  '§2.7.4:完全無授權的客服呼叫批量套用被擋下'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑥ §2.7.6:staff_service_commission_rates / booking_commission_item_records RLS。
-- =========================================================================
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000002');

select lives_ok(
  format(
    $$select * from staff_service_commission_rates where staff_id = '%s'$$,
    'ec000000-0000-4000-8000-000000000041'
  ),
  '§2.7.6:被授權 commission_settings 的客服可以 SELECT staff_service_commission_rates'
);

select lives_ok(
  format(
    $$insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value)
      values ('%s', '%s', 'percentage', 5)
      on conflict (staff_id, service_item_id) do update set commission_value = 5$$,
    'ec000000-0000-4000-8000-000000000041', 'ec000000-0000-4000-8000-000000000031'
  ),
  '§2.7.6:被授權 commission_settings 的客服可以 INSERT/UPDATE staff_service_commission_rates'
);

select throws_ok(
  format(
    $$insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value)
      values ('%s', '%s', 'percentage', 5)$$,
    'ec000000-0000-4000-8000-000000000042', 'ec000000-0000-4000-8000-000000000031'
  ),
  '42501', null,
  '§2.7.6 WITH CHECK:對月薪制服務人員寫入 staff_service_commission_rates 被 RLS 擋下'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000003');

select is(
  (select count(*)::int from staff_service_commission_rates where staff_id = 'ec000000-0000-4000-8000-000000000041'),
  0,
  '§2.7.6:完全無授權的客服 SELECT staff_service_commission_rates 是空陣列(RLS 擋下,不是報錯)'
);

select throws_ok(
  format(
    $$insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value)
      values ('%s', '%s', 'percentage', 5)$$,
    'ec000000-0000-4000-8000-000000000041', 'ec000000-0000-4000-8000-000000000032'
  ),
  '42501', null,
  '§2.7.6:完全無授權的客服不能新增 staff_service_commission_rates'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');

-- booking_commission_item_records 只有 SELECT 政策。
select is(
  (select array_agg(cmd order by cmd)::text from pg_policies where schemaname = 'public' and tablename = 'booking_commission_item_records'),
  '{SELECT}',
  '§2.7.6:booking_commission_item_records 唯一的政策是 SELECT,一律透過內部函式寫入'
);

select throws_ok(
  format(
    $$insert into booking_commission_item_records (
        commission_record_id, booking_service_item_id, service_item_name_snapshot,
        quantity_snapshot, commission_mode_snapshot, commission_value_snapshot, commission_amount
      ) values (
        (select id from booking_commission_records where booking_id = '%s'),
        gen_random_uuid(), '測試', 1, 'percentage', 10, 0
      )$$,
    :'multi_item_booking_id'::text
  ),
  '42501', null,
  '§2.7.6:即使是商家管理員,也不能直接手動 INSERT booking_commission_item_records(沒有 INSERT 政策)'
);

select lives_ok(
  format($$select * from booking_commission_item_records bcir
    join booking_commission_records bcr on bcr.id = bcir.commission_record_id
    where bcr.booking_id = '%s'$$, :'multi_item_booking_id'::text),
  '§2.7.6:商家管理員(can_view_payroll_reports)可以 SELECT booking_commission_item_records'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑦ §2.7.5:get_staff_commission_summary 補上 item_breakdown,legacy_rate_percentage 處理舊制紀錄。
-- =========================================================================
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');

select is(
  (
    select jsonb_array_length(elem -> 'item_breakdown')
    from jsonb_array_elements(
      get_staff_commission_summary('ec000000-0000-4000-8000-000000000041', 2026, 11) -> 'details'
    ) elem
    where elem ->> 'booking_id' = :'multi_item_booking_id'::text
  ),
  2,
  '§2.7.5:get_staff_commission_summary 對新制訂單正確回傳 2 筆 item_breakdown(對應 A/B 兩個項目)'
);

select is(
  (
    select elem ->> 'legacy_rate_percentage'
    from jsonb_array_elements(
      get_staff_commission_summary('ec000000-0000-4000-8000-000000000041', 2026, 11) -> 'details'
    ) elem
    where elem ->> 'booking_id' = :'multi_item_booking_id'::text
  ),
  null,
  '§2.7.5:新制紀錄的 legacy_rate_percentage 是 null'
);

-- 模擬改版前的舊制紀錄:直接插入一筆 commission_rate_percentage_snapshot 非 null、
-- 完全沒有明細子表的彙總紀錄。bookings 表沒有 INSERT 政策(一律只能透過 create_booking 這個
-- SECURITY DEFINER 函式寫入),所以這裡先清空 auth context,以 postgres 身分繞過 RLS 插入,
-- 插入完再切回商家管理員身分繼續後面的查詢測試。
select pg_temp.test_clear_auth();

insert into bookings (id, merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, status) values
  ('ec000000-0000-4000-8000-000000000090', 'ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000041', '2026-11-15 10:00:00+08', '2026-11-15 10:30:00+08', '舊制紀錄模擬客戶', '0966019999', 'admin', 'completed');
insert into booking_commission_records (
  booking_id, staff_id, merchant_id, commission_basis_type_snapshot,
  commission_base_amount_snapshot, material_cost_deducted_snapshot,
  commission_rate_percentage_snapshot, commission_amount
) values (
  'ec000000-0000-4000-8000-000000000090', 'ec000000-0000-4000-8000-000000000041', 'ec000000-0000-4000-8000-000000000021',
  'gross', 1000, 0, 30, 300
);

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');

select is(
  (
    select row(elem ->> 'legacy_rate_percentage', jsonb_array_length(elem -> 'item_breakdown'))::text
    from jsonb_array_elements(
      get_staff_commission_summary('ec000000-0000-4000-8000-000000000041', 2026, 11) -> 'details'
    ) elem
    where elem ->> 'booking_id' = 'ec000000-0000-4000-8000-000000000090'
  ),
  row('30.00', 0)::text,
  '§2.7.5:改版前的舊制紀錄,legacy_rate_percentage 正確顯示 30.00,item_breakdown 是空陣列'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
