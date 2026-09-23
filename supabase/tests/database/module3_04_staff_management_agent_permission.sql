-- 使用者決策(2026-09-23):「服務人員管理」開放成可以用開關授權給客服的功能。
-- 對應 migration 20260923050000_staff_management_agent_permission.sql——
-- private.can_manage_staff(merchant_id) + merchant_staff/merchant_staff_service_items 的
-- SELECT/INSERT/UPDATE(/DELETE)政策新增 staff_management 分支。
begin;

select plan(6);

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
  ('c3000000-0000-4000-8000-000000000001', 'pgtap-m3-04-admin@test.local'),
  ('c3000000-0000-4000-8000-000000000002', 'pgtap-m3-04-agent-none@test.local'),
  ('c3000000-0000-4000-8000-000000000003', 'pgtap-m3-04-agent-staff@test.local');

insert into groups (id) values ('c3000000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('c3000000-0000-4000-8000-000000000020', 'c3000000-0000-4000-8000-000000000010', '服務人員管理權限測試商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('c3000000-0000-4000-8000-000000000020', 'c3000000-0000-4000-8000-000000000001');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('c3000000-0000-4000-8000-000000000030', 'c3000000-0000-4000-8000-000000000020', '剪髮', 500, 'primary', 30);

-- 兩位客服:agent-none(什麼都沒被授權)、agent-staff(被授權 staff_management)。
insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('c3000000-0000-4000-8000-000000000051', 'c3000000-0000-4000-8000-000000000020', 'c3000000-0000-4000-8000-000000000002', '客服-無授權', 'pgtap-m3-04-agent-none@test.local', 'active', now(), '0900000201'),
  ('c3000000-0000-4000-8000-000000000052', 'c3000000-0000-4000-8000-000000000020', 'c3000000-0000-4000-8000-000000000003', '客服-服務人員管理', 'pgtap-m3-04-agent-staff@test.local', 'active', now(), '0900000202');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('c3000000-0000-4000-8000-000000000052', 'staff_management', true);

-- ① 無授權客服:不能 INSERT merchant_staff。
select pg_temp.test_set_auth('c3000000-0000-4000-8000-000000000002');

select throws_ok(
  $$insert into merchant_staff (id, merchant_id, name, phone)
    values ('c3000000-0000-4000-8000-000000000040', 'c3000000-0000-4000-8000-000000000020', '無授權客服建立的服務人員', '0912000001')$$,
  '42501', null,
  '無授權客服不能 INSERT merchant_staff'
);

select pg_temp.test_clear_auth();

-- ② 被授權 staff_management 的客服:可以 INSERT merchant_staff。
select pg_temp.test_set_auth('c3000000-0000-4000-8000-000000000003');

select lives_ok(
  $$insert into merchant_staff (id, merchant_id, name, phone)
    values ('c3000000-0000-4000-8000-000000000040', 'c3000000-0000-4000-8000-000000000020', '被授權客服建立的服務人員', '0912000001')$$,
  '被授權 staff_management 的客服可以 INSERT merchant_staff'
);

-- ③ 同一位客服:可以 UPDATE 剛剛建立的這筆服務人員。
select lives_ok(
  $$update merchant_staff set phone = '0912000002' where id = 'c3000000-0000-4000-8000-000000000040'$$,
  '被授權 staff_management 的客服可以 UPDATE merchant_staff'
);

select is(
  (select phone from merchant_staff where id = 'c3000000-0000-4000-8000-000000000040'),
  '0912000002',
  '被授權 staff_management 的客服 UPDATE 真的生效,不是被靜默擋下'
);

-- ④ 同一位客服:可以指派這位服務人員可承接的服務項目(merchant_staff_service_items)。
select lives_ok(
  $$insert into merchant_staff_service_items (staff_id, service_item_id)
    values ('c3000000-0000-4000-8000-000000000040', 'c3000000-0000-4000-8000-000000000030')$$,
  '被授權 staff_management 的客服可以指派服務人員可承接的服務項目'
);

select pg_temp.test_clear_auth();

-- ⑤ 商家管理員永遠可以,不受 staff_management 授權狀態影響。
select pg_temp.test_set_auth('c3000000-0000-4000-8000-000000000001');

select lives_ok(
  $$update merchant_staff set phone = '0912000003' where id = 'c3000000-0000-4000-8000-000000000040'$$,
  '商家管理員永遠可以修改 merchant_staff,不需要任何 section_key 授權'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
