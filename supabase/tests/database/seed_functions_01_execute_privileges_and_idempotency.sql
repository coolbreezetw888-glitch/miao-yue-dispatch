-- 安全回歸測試:5 支 seed_default_* 函式不得對外曝光,且必須冪等。
-- 對應 migration:20260924010000_revoke_public_execute_on_seed_functions.sql
--
-- 【為什麼需要這份測試】
-- public schema 底下的函式會被 PostgREST 自動曝光成 /rest/v1/rpc/<name>,而 PostgreSQL 對新建
-- 函式預設就 grant execute to PUBLIC。這 5 支 seed 函式內部完全沒有權限檢查、參數又直接收
-- merchant_id,一旦 anon/authenticated 拿得到 EXECUTE,任何人都能往別人的商家塞預設資料。
-- 這份測試把「不能被 anon/authenticated/PUBLIC 呼叫」釘成回歸測試,避免之後有人重寫這些函式
-- 時(尤其是 create or replace / drop + create)不小心又把權限放回去。
--
-- 比照 module2_03_private_functions_access_control.sql 的既有寫法,用 has_function_privilege
-- 直接斷言資料庫層的 ACL。
begin;

select plan(24);

-- =========================================================================
-- ①~⑮ 權限邊界:5 支函式對 anon / authenticated / PUBLIC 都沒有 EXECUTE。
-- =========================================================================
select ok(
  not has_function_privilege('anon', 'public.seed_default_leave_types(uuid)', 'execute'),
  'anon 不能執行 seed_default_leave_types'
);
select ok(
  not has_function_privilege('authenticated', 'public.seed_default_leave_types(uuid)', 'execute'),
  'authenticated 不能執行 seed_default_leave_types'
);
select ok(
  not has_function_privilege('public', 'public.seed_default_leave_types(uuid)', 'execute'),
  'PUBLIC 虛擬角色也沒有 seed_default_leave_types 的執行權'
);

select ok(
  not has_function_privilege('anon', 'public.seed_default_payment_methods(uuid)', 'execute'),
  'anon 不能執行 seed_default_payment_methods'
);
select ok(
  not has_function_privilege('authenticated', 'public.seed_default_payment_methods(uuid)', 'execute'),
  'authenticated 不能執行 seed_default_payment_methods'
);
select ok(
  not has_function_privilege('public', 'public.seed_default_payment_methods(uuid)', 'execute'),
  'PUBLIC 虛擬角色也沒有 seed_default_payment_methods 的執行權'
);

select ok(
  not has_function_privilege('anon', 'public.seed_default_leave_deduction_rules(uuid)', 'execute'),
  'anon 不能執行 seed_default_leave_deduction_rules'
);
select ok(
  not has_function_privilege('authenticated', 'public.seed_default_leave_deduction_rules(uuid)', 'execute'),
  'authenticated 不能執行 seed_default_leave_deduction_rules'
);
select ok(
  not has_function_privilege('public', 'public.seed_default_leave_deduction_rules(uuid)', 'execute'),
  'PUBLIC 虛擬角色也沒有 seed_default_leave_deduction_rules 的執行權'
);

select ok(
  not has_function_privilege('anon', 'public.seed_default_member_settings(uuid)', 'execute'),
  'anon 不能執行 seed_default_member_settings'
);
select ok(
  not has_function_privilege('authenticated', 'public.seed_default_member_settings(uuid)', 'execute'),
  'authenticated 不能執行 seed_default_member_settings'
);
select ok(
  not has_function_privilege('public', 'public.seed_default_member_settings(uuid)', 'execute'),
  'PUBLIC 虛擬角色也沒有 seed_default_member_settings 的執行權'
);

select ok(
  not has_function_privilege('anon', 'public.seed_default_payroll_settings(uuid)', 'execute'),
  'anon 不能執行 seed_default_payroll_settings'
);
select ok(
  not has_function_privilege('authenticated', 'public.seed_default_payroll_settings(uuid)', 'execute'),
  'authenticated 不能執行 seed_default_payroll_settings'
);
select ok(
  not has_function_privilege('public', 'public.seed_default_payroll_settings(uuid)', 'execute'),
  'PUBLIC 虛擬角色也沒有 seed_default_payroll_settings 的執行權'
);

-- =========================================================================
-- ⑯~⑳ service_role 保有執行權(建立商家的內部流程與後台維運需要)。
-- =========================================================================
select ok(
  has_function_privilege('service_role', 'public.seed_default_leave_types(uuid)', 'execute'),
  'service_role 保有 seed_default_leave_types 的執行權'
);
select ok(
  has_function_privilege('service_role', 'public.seed_default_payment_methods(uuid)', 'execute'),
  'service_role 保有 seed_default_payment_methods 的執行權'
);
select ok(
  has_function_privilege('service_role', 'public.seed_default_leave_deduction_rules(uuid)', 'execute'),
  'service_role 保有 seed_default_leave_deduction_rules 的執行權'
);
select ok(
  has_function_privilege('service_role', 'public.seed_default_member_settings(uuid)', 'execute'),
  'service_role 保有 seed_default_member_settings 的執行權'
);
select ok(
  has_function_privilege('service_role', 'public.seed_default_payroll_settings(uuid)', 'execute'),
  'service_role 保有 seed_default_payroll_settings 的執行權'
);

-- =========================================================================
-- Fixture:一間乾淨的商家(直接 insert,不走 create_merchant_in_group,
-- 這樣才能自己控制 seed 函式被呼叫的次數)。
-- =========================================================================
insert into groups (id) values ('f0000000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('f0000000-0000-4000-8000-000000000021', 'f0000000-0000-4000-8000-000000000011', 'Seed 冪等測試店', 'in_store_beauty');

-- =========================================================================
-- (21)~(24) 冪等性:呼叫兩次不會變成兩倍。
-- =========================================================================
select public.seed_default_payment_methods('f0000000-0000-4000-8000-000000000021');

select is(
  (select count(*) from public.payment_methods where merchant_id = 'f0000000-0000-4000-8000-000000000021'),
  2::bigint,
  '第一次呼叫 seed_default_payment_methods 種入 2 筆預設付款方式'
);

select public.seed_default_payment_methods('f0000000-0000-4000-8000-000000000021');

select is(
  (select count(*) from public.payment_methods where merchant_id = 'f0000000-0000-4000-8000-000000000021'),
  2::bigint,
  '重複呼叫 seed_default_payment_methods 不會變成 4 筆(冪等)'
);

select public.seed_default_leave_types('f0000000-0000-4000-8000-000000000021');

select is(
  (select count(*) from public.merchant_leave_types where merchant_id = 'f0000000-0000-4000-8000-000000000021'),
  3::bigint,
  '第一次呼叫 seed_default_leave_types 種入 3 筆預設假別'
);

select public.seed_default_leave_types('f0000000-0000-4000-8000-000000000021');

select is(
  (select count(*) from public.merchant_leave_types where merchant_id = 'f0000000-0000-4000-8000-000000000021'),
  3::bigint,
  '重複呼叫 seed_default_leave_types 不會變成 6 筆(冪等)'
);

select * from finish();
rollback;
