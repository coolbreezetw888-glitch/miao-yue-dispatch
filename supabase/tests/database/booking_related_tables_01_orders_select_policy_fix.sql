-- SPECS-INDEX 編號 240/241/242 — 對應規格書 .project/specs/建單相關資料表權限缺口修正.md。
-- 驗證 migration 20260919140000_booking_related_tables_select_policy_orders_fix.sql:
-- merchant_feature_flags / merchant_staff / service_items 三張表的 SELECT 政策,
-- 只要客服有「訂單管理」(orders)權限就放行,即使沒有各自的專屬管理權限;
-- 但 INSERT/UPDATE 仍然只給專屬管理權限,不因為有 orders 權限就能寫入。
begin;

select plan(14);

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
-- Fixture:一間商家,一位管理員,三種客服——
--   agent-orders:只有 orders 權限(本次修正要放行讀取的對象)
--   agent-specific:同時擁有 business_hours/staff/service_items 三個專屬管理權限(既有行為不變)
--   agent-none:完全無授權(仍然兩邊都不行)
-- =========================================================================
insert into auth.users (id, email) values
  ('da000000-0000-4000-8000-000000000001', 'pgtap-bkrt-admin@test.local'),
  ('da000000-0000-4000-8000-000000000002', 'pgtap-bkrt-agent-orders@test.local'),
  ('da000000-0000-4000-8000-000000000003', 'pgtap-bkrt-agent-specific@test.local'),
  ('da000000-0000-4000-8000-000000000004', 'pgtap-bkrt-agent-none@test.local');

insert into groups (id) values ('da000000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('da000000-0000-4000-8000-000000000021', 'da000000-0000-4000-8000-000000000011', '建單權限缺口測試店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('da000000-0000-4000-8000-000000000021', 'da000000-0000-4000-8000-000000000001');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('da000000-0000-4000-8000-000000000031', 'da000000-0000-4000-8000-000000000021', 'da000000-0000-4000-8000-000000000002', '客服-僅訂單', 'pgtap-bkrt-agent-orders@test.local', 'active', now(), '0900000101'),
  ('da000000-0000-4000-8000-000000000032', 'da000000-0000-4000-8000-000000000021', 'da000000-0000-4000-8000-000000000003', '客服-專屬權限', 'pgtap-bkrt-agent-specific@test.local', 'active', now(), '0900000102'),
  ('da000000-0000-4000-8000-000000000033', 'da000000-0000-4000-8000-000000000021', 'da000000-0000-4000-8000-000000000004', '客服-無授權', 'pgtap-bkrt-agent-none@test.local', 'active', now(), '0900000103');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('da000000-0000-4000-8000-000000000031', 'orders', true),
  ('da000000-0000-4000-8000-000000000032', 'business_hours', true),
  ('da000000-0000-4000-8000-000000000032', 'service_items', true);

-- merchant_feature_flags 一筆旗標(布置者用管理員身分)。
select pg_temp.test_set_auth('da000000-0000-4000-8000-000000000001');

insert into merchant_feature_flags (merchant_id, feature_key, enabled) values
  ('da000000-0000-4000-8000-000000000021', 'material_cost_enabled', true);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('da000000-0000-4000-8000-000000000041', 'da000000-0000-4000-8000-000000000021', '測試店服務人員', '0900000100', true);

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('da000000-0000-4000-8000-000000000051', 'da000000-0000-4000-8000-000000000021', '測試服務項目', 500, 'primary', 30);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ① merchant_feature_flags:只有 orders 權限的客服可以 SELECT,但不能 INSERT/UPDATE。
-- =========================================================================
select pg_temp.test_set_auth('da000000-0000-4000-8000-000000000002');

select is(
  (select count(*)::int from merchant_feature_flags where merchant_id = 'da000000-0000-4000-8000-000000000021' and feature_key = 'material_cost_enabled'),
  1,
  '編號 240:只有 orders 權限、沒有 business_hours 權限的客服,可以 SELECT 到 merchant_feature_flags'
);

select throws_ok(
  $$insert into merchant_feature_flags (merchant_id, feature_key, enabled)
    values ('da000000-0000-4000-8000-000000000021', 'another_flag', true)$$,
  '42501', null,
  '編號 240:只有 orders 權限的客服不能新增 merchant_feature_flags(管理仍需 business_hours 權限)'
);

update merchant_feature_flags set enabled = false
  where merchant_id = 'da000000-0000-4000-8000-000000000021' and feature_key = 'material_cost_enabled';

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('da000000-0000-4000-8000-000000000001');

select is(
  (select enabled from merchant_feature_flags where merchant_id = 'da000000-0000-4000-8000-000000000021' and feature_key = 'material_cost_enabled'),
  true,
  '編號 240:只有 orders 權限的客服的 UPDATE 因 RLS USING 條件不成立而 0 筆受影響,旗標值沒有被改動'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ② merchant_staff:只有 orders 權限的客服可以 SELECT,但不能 INSERT/UPDATE。
-- =========================================================================
select pg_temp.test_set_auth('da000000-0000-4000-8000-000000000002');

select is(
  (select count(*)::int from merchant_staff where merchant_id = 'da000000-0000-4000-8000-000000000021'),
  1,
  '編號 241:只有 orders 權限的客服,可以 SELECT 到 merchant_staff 清單(建單表單服務人員下拉選單)'
);

select throws_ok(
  $$insert into merchant_staff (merchant_id, name, phone, no_time_slot_limit)
    values ('da000000-0000-4000-8000-000000000021', '僅訂單客服嘗試新增', '0900000199', true)$$,
  '42501', null,
  '編號 241:只有 orders 權限的客服不能新增 merchant_staff(管理仍需商家管理員身分,用合法格式的電話確保擋下原因單純是權限不足)'
);

update merchant_staff set name = '僅訂單客服嘗試改名' where id = 'da000000-0000-4000-8000-000000000041';

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('da000000-0000-4000-8000-000000000001');

select is(
  (select name from merchant_staff where id = 'da000000-0000-4000-8000-000000000041'),
  '測試店服務人員',
  '編號 241:只有 orders 權限的客服的 UPDATE 因 RLS 看不到寫入條件而 0 筆受影響,名字沒有被改到'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ③ service_items:只有 orders 權限的客服可以 SELECT,但不能 INSERT/UPDATE。
-- =========================================================================
select pg_temp.test_set_auth('da000000-0000-4000-8000-000000000002');

select is(
  (select count(*)::int from service_items where merchant_id = 'da000000-0000-4000-8000-000000000021'),
  1,
  '編號 242:只有 orders 權限的客服,可以 SELECT 到 service_items 清單(建單表單服務項目多選清單)'
);

select throws_ok(
  $$insert into service_items (merchant_id, name, price, item_type, duration_minutes)
    values ('da000000-0000-4000-8000-000000000021', '僅訂單客服嘗試新增', 100, 'primary', 15)$$,
  '42501', null,
  '編號 242:只有 orders 權限的客服不能新增 service_items(管理仍需 service_items 權限)'
);

update service_items set name = '僅訂單客服嘗試改名' where id = 'da000000-0000-4000-8000-000000000051';

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('da000000-0000-4000-8000-000000000001');

select is(
  (select name from service_items where id = 'da000000-0000-4000-8000-000000000051'),
  '測試服務項目',
  '編號 242:只有 orders 權限的客服的 UPDATE 因 RLS 看不到寫入條件而 0 筆受影響,名字沒有被改到'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ④ 既有專屬權限客服的行為完全不變(業務照舊):有 business_hours/service_items 專屬權限的
--    客服,仍然可以 SELECT + INSERT/UPDATE(這兩張表各自有獨立的專屬管理權限)。
--    merchant_staff 的 INSERT/UPDATE 規格書明載固定只給 is_merchant_admin,沒有獨立的專屬
--    客服授權可以寫入,不因本次修正而新增這種權限(已在②驗證過:只有 orders 權限的客服
--    UPDATE 仍然 0 筆受影響)。
-- =========================================================================
select pg_temp.test_set_auth('da000000-0000-4000-8000-000000000003');

select lives_ok(
  $$update merchant_feature_flags set enabled = true
    where merchant_id = 'da000000-0000-4000-8000-000000000021' and feature_key = 'material_cost_enabled'$$,
  '既有行為不變:被授權 business_hours 的客服仍可以 UPDATE merchant_feature_flags'
);

select lives_ok(
  $$update service_items set name = '測試服務項目(專屬客服改名)' where id = 'da000000-0000-4000-8000-000000000051'$$,
  '既有行為不變:被授權 service_items 的客服仍可以 UPDATE service_items'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑤ 完全無授權的客服(既沒有 orders 也沒有任何專屬權限):SELECT 都看不到。
-- =========================================================================
select pg_temp.test_set_auth('da000000-0000-4000-8000-000000000004');

select is(
  (select count(*)::int from merchant_feature_flags where merchant_id = 'da000000-0000-4000-8000-000000000021'),
  0,
  '完全無授權的客服看不到 merchant_feature_flags(SELECT 政策兩個條件都不成立)'
);

select is(
  (select count(*)::int from merchant_staff where merchant_id = 'da000000-0000-4000-8000-000000000021'),
  0,
  '完全無授權的客服看不到 merchant_staff(SELECT 政策兩個條件都不成立)'
);

select is(
  (select count(*)::int from service_items where merchant_id = 'da000000-0000-4000-8000-000000000021'),
  0,
  '完全無授權的客服看不到 service_items(SELECT 政策兩個條件都不成立)'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
