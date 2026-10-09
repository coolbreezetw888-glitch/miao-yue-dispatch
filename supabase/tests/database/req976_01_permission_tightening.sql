-- SPECS-INDEX #976 第 3 批(2026-10-06):前後端權限不一致收緊 — pgTAP
-- migration 20261006130000_req976_permission_tightening.sql
-- 規格書「權限收緊與服務人員開關修正-第3批」第一節 C-1 ~ C-3(C-4 是純前端,由 Vitest / e2e-local 驗)。
--
-- 原則:後端權限 = 畫面允許的範圍,不多也不少。每一點都驗「有權限的放行、沒權限的擋」,含 anon、別家商家、
-- 只有其他權限的客服;管理員照舊可用。
--
--   C-1 稅金:付款方式管理(pm)能寫;營業時間(bh)不能寫、也讀不到;訂單(orders)讀得到(建單表單預設值);別家管理員寫不進
--   C-1 功能開關:嚴格工時衝突檢查 ↔ bh、料錢總開關 ↔ 料錢(mc);互相不能借道(含改 feature_key);其他 key 只有管理員
--   C-2 服務人員報表:只有 staff_report(與管理員);店家報表(billing)只看得到店家報表
--   C-3 報表匯出中心:report_export(與管理員)能用四份報表的後端;沒有 report_export 的客服(即使有訂單權限)、
--       別家管理員、anon 都被擋;回傳欄位只有 CSV 需要的;請假報表限定這間商家
--
-- 故障注入(engineer 已做,見回報):
--   ・把 merchant_tax_settings_insert 改回含 can_manage_business_hours ⇒ ① 轉紅(② 連帶紅:bh 已先寫進一列)
--   ・把 merchant_feature_flags_insert 改回「bh 可寫任何 key」⇒ ⑫ ⑭ 轉紅
--   ・把 can_view_payroll_reports 改回含 can_view_billing ⇒ ⑱ ⑲ ⑳ ㉑ ㉓ 轉紅
--   ・把 export_orders_report 的權限判斷拿掉 ⇒ ㉝ 轉紅
begin;

select plan(49);

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
--   商家 A(...0020)、商家 B(...0021,不同集團)
--   使用者:01 A 管理員、02 B 管理員、03 客服 bh、04 客服 mc、05 客服 pm、06 客服 billing、
--           07 客服 staff_report、08 客服 report_export、09 客服 orders、10 客服(什麼都沒開)
-- =========================================================================
insert into auth.users (id, email) values
  ('f9760000-0000-4000-8000-000000000001', 'pgtap-r976-admin-a@test.local'),
  ('f9760000-0000-4000-8000-000000000002', 'pgtap-r976-admin-b@test.local'),
  ('f9760000-0000-4000-8000-000000000003', 'pgtap-r976-bh@test.local'),
  ('f9760000-0000-4000-8000-000000000004', 'pgtap-r976-mc@test.local'),
  ('f9760000-0000-4000-8000-000000000005', 'pgtap-r976-pm@test.local'),
  ('f9760000-0000-4000-8000-000000000006', 'pgtap-r976-billing@test.local'),
  ('f9760000-0000-4000-8000-000000000007', 'pgtap-r976-staffreport@test.local'),
  ('f9760000-0000-4000-8000-000000000008', 'pgtap-r976-export@test.local'),
  ('f9760000-0000-4000-8000-000000000009', 'pgtap-r976-orders@test.local'),
  ('f9760000-0000-4000-8000-000000000010', 'pgtap-r976-none@test.local');

insert into groups (id) values
  ('f9760000-0000-4000-8000-000000000011'),
  ('f9760000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('f9760000-0000-4000-8000-000000000020', 'f9760000-0000-4000-8000-000000000011', '#976 權限測試 A 店', 'in_store_beauty'),
  ('f9760000-0000-4000-8000-000000000021', 'f9760000-0000-4000-8000-000000000012', '#976 權限測試 B 店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('f9760000-0000-4000-8000-000000000020', 'f9760000-0000-4000-8000-000000000001'),
  ('f9760000-0000-4000-8000-000000000021', 'f9760000-0000-4000-8000-000000000002');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('f9760000-0000-4000-8000-000000000033', 'f9760000-0000-4000-8000-000000000020', 'f9760000-0000-4000-8000-000000000003', '客服bh', 'pgtap-r976-bh@test.local', 'active', now(), '0900976003'),
  ('f9760000-0000-4000-8000-000000000034', 'f9760000-0000-4000-8000-000000000020', 'f9760000-0000-4000-8000-000000000004', '客服mc', 'pgtap-r976-mc@test.local', 'active', now(), '0900976004'),
  ('f9760000-0000-4000-8000-000000000035', 'f9760000-0000-4000-8000-000000000020', 'f9760000-0000-4000-8000-000000000005', '客服pm', 'pgtap-r976-pm@test.local', 'active', now(), '0900976005'),
  ('f9760000-0000-4000-8000-000000000036', 'f9760000-0000-4000-8000-000000000020', 'f9760000-0000-4000-8000-000000000006', '客服billing', 'pgtap-r976-billing@test.local', 'active', now(), '0900976006'),
  ('f9760000-0000-4000-8000-000000000037', 'f9760000-0000-4000-8000-000000000020', 'f9760000-0000-4000-8000-000000000007', '客服staffreport', 'pgtap-r976-staffreport@test.local', 'active', now(), '0900976007'),
  ('f9760000-0000-4000-8000-000000000038', 'f9760000-0000-4000-8000-000000000020', 'f9760000-0000-4000-8000-000000000008', '客服export', 'pgtap-r976-export@test.local', 'active', now(), '0900976008'),
  ('f9760000-0000-4000-8000-000000000039', 'f9760000-0000-4000-8000-000000000020', 'f9760000-0000-4000-8000-000000000009', '客服orders', 'pgtap-r976-orders@test.local', 'active', now(), '0900976009'),
  ('f9760000-0000-4000-8000-000000000040', 'f9760000-0000-4000-8000-000000000020', 'f9760000-0000-4000-8000-000000000010', '客服none', 'pgtap-r976-none@test.local', 'active', now(), '0900976010');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('f9760000-0000-4000-8000-000000000033', 'business_hours', true),
  ('f9760000-0000-4000-8000-000000000034', 'material_costs', true),
  ('f9760000-0000-4000-8000-000000000035', 'payment_methods', true),
  ('f9760000-0000-4000-8000-000000000036', 'billing', true),
  ('f9760000-0000-4000-8000-000000000037', 'staff_report', true),
  ('f9760000-0000-4000-8000-000000000038', 'report_export', true),
  ('f9760000-0000-4000-8000-000000000039', 'orders', true),
  -- 對照:none 客服有一筆 granted=false 的 report_export(關閉 ≠ 沒有列,兩種都要擋)
  ('f9760000-0000-4000-8000-000000000040', 'report_export', false);

-- 服務人員:A 店一位在職(後台無時段限制,建單不用布置時段)、一位已移除;B 店一位。
insert into merchant_staff (id, merchant_id, name, phone, unlimited_backend_edit, compensation_type, status) values
  ('f9760000-0000-4000-8000-000000000050', 'f9760000-0000-4000-8000-000000000020', '甲服務人員', '0911976050', true, 'monthly_salary', 'active'),
  ('f9760000-0000-4000-8000-000000000051', 'f9760000-0000-4000-8000-000000000020', '乙已移除', '0911976051', true, 'monthly_salary', 'removed'),
  ('f9760000-0000-4000-8000-000000000052', 'f9760000-0000-4000-8000-000000000021', '丙B店', '0911976052', true, 'monthly_salary', 'active');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('f9760000-0000-4000-8000-000000000060', 'f9760000-0000-4000-8000-000000000020', '#976 服務', 1000, 'primary', 60);
insert into payment_methods (id, merchant_id, name) values
  ('f9760000-0000-4000-8000-000000000061', 'f9760000-0000-4000-8000-000000000020', '現金');

insert into members (id, merchant_id, name, phone, referral_code, email, notes) values
  ('f9760000-0000-4000-8000-000000000070', 'f9760000-0000-4000-8000-000000000020', '會員一', '0922976070', 'R976A1', 'secret@test.local', '私人備註不可外流');

insert into merchant_leave_types (id, merchant_id, name, status) values
  ('f9760000-0000-4000-8000-000000000080', 'f9760000-0000-4000-8000-000000000020', '特休', 'active'),
  ('f9760000-0000-4000-8000-000000000081', 'f9760000-0000-4000-8000-000000000020', '舊假別', 'removed'),
  ('f9760000-0000-4000-8000-000000000082', 'f9760000-0000-4000-8000-000000000021', 'B店假別', 'active');

insert into staff_leave_records (staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date, status, notes) values
  ('f9760000-0000-4000-8000-000000000050', 'f9760000-0000-4000-8000-000000000080', '特休', '2026-11-02', '2026-11-03', 'confirmed', '在職者請假'),
  ('f9760000-0000-4000-8000-000000000051', 'f9760000-0000-4000-8000-000000000081', '舊假別', '2026-11-05', '2026-11-05', 'confirmed', '已移除者請假'),
  ('f9760000-0000-4000-8000-000000000052', 'f9760000-0000-4000-8000-000000000082', 'B店假別', '2026-11-02', '2026-11-02', 'confirmed', 'B店請假');

-- 料錢總開關已存在一列(測 UPDATE);嚴格工時衝突檢查刻意**沒有**列(測 0 筆時 bh 客服的 INSERT)。
insert into merchant_feature_flags (merchant_id, feature_key, enabled) values
  ('f9760000-0000-4000-8000-000000000020', 'material_cost_enabled', true);

-- 稅金設定刻意先不建,由 pm 客服第一次寫入(測 INSERT)。

-- 一筆訂單:管理員建。
select pg_temp.test_set_auth('f9760000-0000-4000-8000-000000000001');
select id from create_booking(
  'f9760000-0000-4000-8000-000000000020', 'f9760000-0000-4000-8000-000000000050',
  jsonb_build_array(jsonb_build_object('service_item_id','f9760000-0000-4000-8000-000000000060','quantity',1,'unit_price',1000)),
  '2026-11-10 10:00:00+08', '訂單客戶', '0933976001',
  p_payment_method_id => 'f9760000-0000-4000-8000-000000000061'
) \gset booking_
select pg_temp.test_clear_auth();

-- =========================================================================
-- C-1 稅金
-- =========================================================================
select pg_temp.test_set_auth('f9760000-0000-4000-8000-000000000003'); -- bh
select throws_ok(
  $$insert into merchant_tax_settings (merchant_id, tax_mode, tax_value) values ('f9760000-0000-4000-8000-000000000020', 'percentage', 9)$$,
  '42501', null,
  '① C-1:只有營業時間設定(bh)的客服不能新增稅金設定'
);
select pg_temp.test_set_auth('f9760000-0000-4000-8000-000000000005'); -- pm
select lives_ok(
  $$insert into merchant_tax_settings (merchant_id, tax_mode, tax_value) values ('f9760000-0000-4000-8000-000000000020', 'percentage', 8)$$,
  '② C-1:付款方式管理(pm)的客服可以新增稅金設定'
);
select lives_ok(
  $$update merchant_tax_settings set tax_value = 7 where merchant_id = 'f9760000-0000-4000-8000-000000000020'$$,
  '③ C-1:付款方式管理(pm)的客服可以修改稅金設定'
);
select pg_temp.test_set_auth('f9760000-0000-4000-8000-000000000003'); -- bh
update merchant_tax_settings set tax_value = 99 where merchant_id = 'f9760000-0000-4000-8000-000000000020';
select is(
  (select count(*)::int from merchant_tax_settings where merchant_id = 'f9760000-0000-4000-8000-000000000020'),
  0,
  '④ C-1:bh 客服讀不到稅金設定(營業時間頁不顯示稅金)'
);
select pg_temp.test_clear_auth();
select is(
  (select tax_value from merchant_tax_settings where merchant_id = 'f9760000-0000-4000-8000-000000000020'),
  7.00::numeric,
  '⑤ C-1:bh 客服改稅金影響 0 列,值仍是 pm 設定的 7'
);
select pg_temp.test_set_auth('f9760000-0000-4000-8000-000000000009'); -- orders
select is(
  (select tax_value from merchant_tax_settings where merchant_id = 'f9760000-0000-4000-8000-000000000020'),
  7.00::numeric,
  '⑥ C-1:訂單權限的客服讀得到稅金(建單表單帶入商家稅金預設值)'
);
select throws_ok(
  $$insert into merchant_tax_settings (merchant_id, tax_mode, tax_value) values ('f9760000-0000-4000-8000-000000000020', 'percentage', 5)$$,
  '42501', null,
  '⑦ C-1:訂單權限的客服不能寫稅金'
);
select pg_temp.test_set_auth('f9760000-0000-4000-8000-000000000002'); -- B 店管理員
select throws_ok(
  $$insert into merchant_tax_settings (merchant_id, tax_mode, tax_value) values ('f9760000-0000-4000-8000-000000000020', 'percentage', 1)$$,
  '42501', null,
  '⑧ C-1:別家商家管理員不能寫 A 店稅金(RLS with check 在唯一鍵檢查之前就擋下)'
);
update merchant_tax_settings set tax_value = 1 where merchant_id = 'f9760000-0000-4000-8000-000000000020';
select pg_temp.test_set_auth('f9760000-0000-4000-8000-000000000001'); -- A 管理員
select is(
  (select tax_value from merchant_tax_settings where merchant_id = 'f9760000-0000-4000-8000-000000000020'),
  7.00::numeric,
  '⑨ C-1:別家商家管理員改 A 店稅金影響 0 列;A 店管理員照舊讀得到'
);
select lives_ok(
  $$update merchant_tax_settings set tax_value = 6 where merchant_id = 'f9760000-0000-4000-8000-000000000020'$$,
  '⑩ C-1:商家管理員照舊可以改稅金'
);

-- =========================================================================
-- C-1 功能開關
-- =========================================================================
select pg_temp.test_set_auth('f9760000-0000-4000-8000-000000000003'); -- bh
select lives_ok(
  $$insert into merchant_feature_flags (merchant_id, feature_key, enabled) values ('f9760000-0000-4000-8000-000000000020', 'strict_conflict_check', false)$$,
  '⑪ C-1:bh 客服可以新增「嚴格工時衝突檢查」(0 筆情境,編號 123/127/142 那個 bug 不可回來)'
);
select throws_ok(
  $$insert into merchant_feature_flags (merchant_id, feature_key, enabled) values ('f9760000-0000-4000-8000-000000000020', 'material_cost_enabled', false)$$,
  '42501', null,
  '⑫ C-1:bh 客服不能寫料錢總開關(RLS with check 在唯一鍵檢查之前,所以是 42501 而不是重複鍵)'
);
update merchant_feature_flags set enabled = false
  where merchant_id = 'f9760000-0000-4000-8000-000000000020' and feature_key = 'material_cost_enabled';
select throws_ok(
  $$update merchant_feature_flags set feature_key = 'material_cost_enabled'
     where merchant_id = 'f9760000-0000-4000-8000-000000000020' and feature_key = 'strict_conflict_check'$$,
  null, null,
  '⑬ C-1:bh 客服不能把嚴格工時衝突那一列的 key 改成料錢總開關來借道(新列過不了 with check)'
);
select throws_ok(
  $$insert into merchant_feature_flags (merchant_id, feature_key, enabled) values ('f9760000-0000-4000-8000-000000000020', 'some_other_flag', true)$$,
  '42501', null,
  '⑭ C-1:bh 客服不能新增其他任何功能開關'
);
select pg_temp.test_set_auth('f9760000-0000-4000-8000-000000000004'); -- mc
select is(
  (select enabled from merchant_feature_flags where merchant_id = 'f9760000-0000-4000-8000-000000000020' and feature_key = 'material_cost_enabled'),
  true,
  '⑮ C-1:bh 客服改料錢總開關影響 0 列(料錢客服讀回來仍是 true)'
);
select lives_ok(
  $$update merchant_feature_flags set enabled = false
     where merchant_id = 'f9760000-0000-4000-8000-000000000020' and feature_key = 'material_cost_enabled'$$,
  '⑯ C-1:料錢(mc)客服可以改料錢總開關'
);
update merchant_feature_flags set enabled = true
  where merchant_id = 'f9760000-0000-4000-8000-000000000020' and feature_key = 'strict_conflict_check';
select pg_temp.test_set_auth('f9760000-0000-4000-8000-000000000001'); -- A 管理員
select ok(
  (select enabled = false from merchant_feature_flags where merchant_id = 'f9760000-0000-4000-8000-000000000020' and feature_key = 'strict_conflict_check')
  and (select enabled = false from merchant_feature_flags where merchant_id = 'f9760000-0000-4000-8000-000000000020' and feature_key = 'material_cost_enabled'),
  '⑰ C-1:mc 客服改嚴格工時衝突影響 0 列(仍是 bh 設的 false);mc 自己改的料錢總開關生效(false)'
);
-- SPECS-INDEX #1025 ⚠️2(FG1-A07,20261010150000):merchant_feature_flags 加了 CHECK,只允許
-- material_cost_enabled / strict_conflict_check 兩種 key。商家管理員仍過得了 RLS(所以拿到的是 23514 CHECK 錯誤,
-- 不是 42501),但不能再寫其他名稱。
select throws_ok(
  $$insert into merchant_feature_flags (merchant_id, feature_key, enabled) values ('f9760000-0000-4000-8000-000000000020', 'some_other_flag', true)$$,
  '23514', null,
  '⑰b C-1:商家管理員過得了 RLS,但其他名稱被 #1025 ⚠️2 的 CHECK 擋下(23514)'
);

-- =========================================================================
-- C-2 服務人員報表只給 staff_report
-- =========================================================================
select pg_temp.test_set_auth('f9760000-0000-4000-8000-000000000006'); -- billing
select throws_ok(
  $$select get_staff_commission_summary('f9760000-0000-4000-8000-000000000050', 2026, 11)$$,
  '42501', null,
  '⑱ C-2:店家報表(billing)客服不能查服務人員抽成報表'
);
select throws_ok(
  $$select get_staff_monthly_payroll_summary('f9760000-0000-4000-8000-000000000050', 2026, 11)$$,
  '42501', null,
  '⑲ C-2:billing 客服不能查服務人員薪資報表'
);
select throws_ok(
  $$select get_staff_commission_summary_by_range('f9760000-0000-4000-8000-000000000050', '2026-11-01', '2026-11-30')$$,
  '42501', null,
  '⑳ C-2:billing 客服不能查服務人員抽成報表(區間版)'
);
select throws_ok(
  $$select get_staff_monthly_payroll_summary_by_range('f9760000-0000-4000-8000-000000000050', '2026-11-01', '2026-11-30')$$,
  '42501', null,
  '㉑ C-2:billing 客服不能查服務人員薪資報表(區間版)'
);
select lives_ok(
  $$select get_merchant_billing_summary_by_range('f9760000-0000-4000-8000-000000000020', '2026-11-01', '2026-11-30')$$,
  '㉒ C-2:billing 客服照舊可以查店家報表'
);
select ok(
  not private.can_view_payroll_reports('f9760000-0000-4000-8000-000000000020'),
  '㉓ C-2:can_view_payroll_reports 對 billing 客服為假(booking_commission_records 等表層 SELECT 一併收緊)'
);
select pg_temp.test_set_auth('f9760000-0000-4000-8000-000000000007'); -- staff_report
select lives_ok(
  $$select get_staff_commission_summary('f9760000-0000-4000-8000-000000000050', 2026, 11)$$,
  '㉔ C-2:staff_report 客服可以查服務人員抽成報表'
);
select lives_ok(
  $$select get_staff_monthly_payroll_summary_by_range('f9760000-0000-4000-8000-000000000050', '2026-11-01', '2026-11-30')$$,
  '㉕ C-2:staff_report 客服可以查服務人員薪資報表(區間版)'
);
select throws_ok(
  $$select get_merchant_billing_summary_by_range('f9760000-0000-4000-8000-000000000020', '2026-11-01', '2026-11-30')$$,
  '42501', null,
  '㉖ C-2:staff_report 客服不能查店家報表(對照組:兩把鑰匙對稱)'
);
select pg_temp.test_set_auth('f9760000-0000-4000-8000-000000000001'); -- A 管理員
select ok(
  private.can_view_payroll_reports('f9760000-0000-4000-8000-000000000020'),
  '㉗ C-2:商家管理員照舊可以看服務人員報表'
);

-- =========================================================================
-- C-3 報表匯出中心
-- =========================================================================
select pg_temp.test_set_auth('f9760000-0000-4000-8000-000000000008'); -- report_export
select is(
  jsonb_array_length(export_orders_report('f9760000-0000-4000-8000-000000000020')),
  1,
  '㉘ C-3:只有 report_export 的客服可以匯出訂單報表(改前讀 bookings 表會是空的)'
);
select is(
  (select array_agg(k order by k) from jsonb_object_keys(export_orders_report('f9760000-0000-4000-8000-000000000020') -> 0) k),
  array['customer_name','customer_phone','final_amount_snapshot','id','source','start_at','status'],
  '㉙ C-3:訂單報表只回傳 CSV 的 7 個欄位'
);
select is(
  (select array_agg(k order by k) from jsonb_object_keys(export_members_report('f9760000-0000-4000-8000-000000000020') -> 0) k),
  array['identity_verified_at','name','phone','points_balance','referral_code','status'],
  '㉚ C-3:會員報表只回傳 CSV 的 6 個欄位(沒有 email、私人備註等)'
);
select is(
  (select jsonb_agg(jsonb_build_object('n', r ->> 'staff_name', 't', r ->> 'leave_type_name') order by r ->> 'start_date')
   from jsonb_array_elements(export_leave_report('f9760000-0000-4000-8000-000000000020')) r),
  '[{"n": "甲服務人員", "t": "特休"}, {"n": null, "t": "舊假別"}]'::jsonb,
  '㉛ C-3:請假報表只含 A 店(沒有 B 店那筆);已移除服務人員姓名回 null(前端退回顯示 id);已下架假別照樣有名稱'
);
select is(
  list_report_export_staff('f9760000-0000-4000-8000-000000000020'),
  '[{"id": "f9760000-0000-4000-8000-000000000050", "name": "甲服務人員"}]'::jsonb,
  '㉜ C-3:服務人員下拉只有在職的 id / name'
);
select lives_ok(
  $$select get_staff_commission_summary('f9760000-0000-4000-8000-000000000050', 2026, 11)$$,
  '㉜b C-3:report_export 客服可以呼叫抽成報表(匯出中心與服務人員報表頁共用的那支)'
);
select throws_ok(
  $$select get_staff_monthly_payroll_summary('f9760000-0000-4000-8000-000000000050', 2026, 11)$$,
  '42501', null,
  '㉜c C-3:report_export 不會連帶打開匯出中心沒用到的薪資報表'
);

select pg_temp.test_set_auth('f9760000-0000-4000-8000-000000000009'); -- orders(沒有 report_export)
select throws_ok(
  $$select export_orders_report('f9760000-0000-4000-8000-000000000020')$$,
  '42501', null,
  '㉝ C-3:有訂單權限但沒有 report_export 的客服不能用匯出中心的訂單報表'
);
select pg_temp.test_set_auth('f9760000-0000-4000-8000-000000000010'); -- none(report_export=false)
select throws_ok(
  $$select export_members_report('f9760000-0000-4000-8000-000000000020')$$,
  '42501', null,
  '㉞ C-3:report_export 明確關閉的客服被擋'
);
select pg_temp.test_set_auth('f9760000-0000-4000-8000-000000000002'); -- B 店管理員
select throws_ok(
  $$select export_leave_report('f9760000-0000-4000-8000-000000000020')$$,
  '42501', null,
  '㉟ C-3:別家商家管理員不能匯出 A 店'
);
select throws_ok(
  $$select list_report_export_staff('f9760000-0000-4000-8000-000000000020')$$,
  '42501', null,
  '㊱ C-3:別家商家管理員不能讀 A 店服務人員下拉'
);
select pg_temp.test_set_auth('f9760000-0000-4000-8000-000000000001'); -- A 管理員
select is(
  jsonb_array_length(export_members_report('f9760000-0000-4000-8000-000000000020')),
  2,
  '㊲ C-3:商家管理員照舊可以匯出(2 位 = fixture 的會員一 + 建單時自動建立的訂單客戶會員)'
);
select is(
  jsonb_array_length(export_orders_report('f9760000-0000-4000-8000-000000000020', p_status => 'cancelled')),
  0,
  '㊳ C-3:狀態篩選有作用(沒有已取消的訂單 ⇒ 0 筆)'
);
select pg_temp.test_clear_auth();

-- anon:連 EXECUTE 都沒有
select ok(
  not has_function_privilege('anon', 'public.export_orders_report(uuid, timestamptz, timestamptz, text)', 'execute')
  and not has_function_privilege('anon', 'public.export_members_report(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.export_leave_report(uuid, uuid, date, date)', 'execute')
  and not has_function_privilege('anon', 'public.list_report_export_staff(uuid)', 'execute'),
  '㊴ C-3:anon 對四支匯出函式都沒有 EXECUTE'
);
select ok(
  has_function_privilege('authenticated', 'public.export_orders_report(uuid, timestamptz, timestamptz, text)', 'execute')
  and has_function_privilege('authenticated', 'public.export_members_report(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.export_leave_report(uuid, uuid, date, date)', 'execute')
  and has_function_privilege('authenticated', 'public.list_report_export_staff(uuid)', 'execute'),
  '㊵ C-3:authenticated 有 EXECUTE(對照組,證明 ㊴ 不是查法錯)'
);
select ok(
  not has_function_privilege('anon', 'private.can_export_reports(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.can_view_payroll_reports(uuid)', 'execute'),
  '㊶ anon 對兩支 private 權限判斷沒有 EXECUTE'
);
select is(
  (select count(*)::int from pg_proc p
   where p.oid in (
     'public.export_orders_report(uuid, timestamptz, timestamptz, text)'::regprocedure,
     'public.export_members_report(uuid)'::regprocedure,
     'public.export_leave_report(uuid, uuid, date, date)'::regprocedure,
     'public.list_report_export_staff(uuid)'::regprocedure,
     'private.can_export_reports(uuid)'::regprocedure
   )
   and p.prosecdef and p.provolatile = 's'
   and array_to_string(p.proconfig, ',') = 'search_path=public'),
  5,
  '㊷ 新函式都是 SECURITY DEFINER + STABLE(唯讀)+ search_path=public'
);

-- anon 實際呼叫:permission denied(42501)
select pg_temp.test_set_auth('00000000-0000-0000-0000-000000000000', 'anon');
select throws_ok(
  $$select export_orders_report('f9760000-0000-4000-8000-000000000020')$$,
  '42501', null,
  '㊸ C-3:anon 實際呼叫匯出函式被擋(42501)'
);
select throws_ok(
  $$insert into merchant_tax_settings (merchant_id, tax_mode, tax_value) values ('f9760000-0000-4000-8000-000000000021', 'percentage', 5)$$,
  '42501', null,
  '㊹ C-1:anon 不能寫稅金'
);
select pg_temp.test_clear_auth();

-- 訂單報表日期篩選(跟改前 PostgREST gte / lt 同語意)
select pg_temp.test_set_auth('f9760000-0000-4000-8000-000000000008');
select is(
  jsonb_array_length(export_orders_report('f9760000-0000-4000-8000-000000000020', '2026-11-10 10:00:00+08', '2026-11-10 10:00:01+08')),
  1,
  '㊺ C-3:start_at >= 起點(含)、< 終點(不含)'
);
select is(
  jsonb_array_length(export_orders_report('f9760000-0000-4000-8000-000000000020', '2026-11-10 10:00:01+08', null)),
  0,
  '㊻ C-3:起點晚於訂單時間 ⇒ 0 筆'
);
select pg_temp.test_clear_auth();

select * from finish();

rollback;
