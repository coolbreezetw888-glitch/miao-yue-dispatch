-- 跨模組修正批次「首頁外殼與主題色優化」1.3/驗收四.2 要求的必測項目:
-- 本人可以更新自己的姓名/職位;呼叫時帶別人的 merchant_id/嘗試更新別人的列會被擋下
-- (找不到符合條件的列,不會誤改到別人)。
--
-- 對應 supabase/migrations/20260916170000_homepage_shell_profile_fields.sql 的
-- update_my_admin_profile() / update_my_agent_profile()。
begin;

select plan(12);

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

-- ---------------------------------------------------------------------------
-- fixture:兩個商家(不同集團),M1 有兩位管理員+兩位客服,M2 只是用來測試
-- 「帶別人商家的 merchant_id」時會不會被擋下,呼叫者在 M2 完全沒有任何紀錄。
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('a3000000-0000-4000-8000-000000000001', 'pgtap-admin-a@test.local'),
  ('a3000000-0000-4000-8000-000000000002', 'pgtap-admin-b@test.local'),
  ('a3000000-0000-4000-8000-000000000003', 'pgtap-agent-a@test.local'),
  ('a3000000-0000-4000-8000-000000000004', 'pgtap-agent-b@test.local');

insert into groups (id) values
  ('a3000000-0000-4000-8000-000000000010'),
  ('a3000000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type)
values
  ('a3000000-0000-4000-8000-000000000020', 'a3000000-0000-4000-8000-000000000010', '個人資料測試商家 M1', 'on_site_dispatch'),
  ('a3000000-0000-4000-8000-000000000021', 'a3000000-0000-4000-8000-000000000011', '個人資料測試商家 M2', 'on_site_dispatch');

insert into merchant_admins (merchant_id, user_id)
values
  ('a3000000-0000-4000-8000-000000000020', 'a3000000-0000-4000-8000-000000000001'),
  ('a3000000-0000-4000-8000-000000000020', 'a3000000-0000-4000-8000-000000000002');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at)
values
  ('a3000000-0000-4000-8000-000000000030', 'a3000000-0000-4000-8000-000000000020', 'a3000000-0000-4000-8000-000000000003', 'pgTAP 客服 A', 'pgtap-agent-a@test.local', 'active', now()),
  ('a3000000-0000-4000-8000-000000000031', 'a3000000-0000-4000-8000-000000000020', 'a3000000-0000-4000-8000-000000000004', 'pgTAP 客服 B', 'pgtap-agent-b@test.local', 'active', now());

-- ---------------------------------------------------------------------------
-- ① 管理員 A 更新自己的姓名/職位,應該成功。
-- ---------------------------------------------------------------------------
select pg_temp.test_set_auth('a3000000-0000-4000-8000-000000000001');

select lives_ok(
  $$select update_my_admin_profile('a3000000-0000-4000-8000-000000000020', '管理員 A 姓名', '店長')$$,
  '管理員 A 可以成功更新自己在 M1 的 display_name/job_title'
);

select is(
  (select display_name from merchant_admins
   where merchant_id = 'a3000000-0000-4000-8000-000000000020' and user_id = 'a3000000-0000-4000-8000-000000000001'),
  '管理員 A 姓名',
  '管理員 A 自己的 display_name 確實被更新'
);

select is(
  (select job_title from merchant_admins
   where merchant_id = 'a3000000-0000-4000-8000-000000000020' and user_id = 'a3000000-0000-4000-8000-000000000001'),
  '店長',
  '管理員 A 自己的 job_title 確實被更新'
);

-- 隔離檢查:管理員 B(同一間商家)的資料完全沒被動到。
select is(
  (select display_name from merchant_admins
   where merchant_id = 'a3000000-0000-4000-8000-000000000020' and user_id = 'a3000000-0000-4000-8000-000000000002'),
  null,
  '管理員 A 更新自己的資料,不會影響到同一間商家另一位管理員 B 的 display_name'
);

-- 帶別人的 merchant_id(M2,管理員 A 在這間店完全沒有 merchant_admins 紀錄):找不到符合條件的列,
-- 應該拋出例外,不會誤改到任何資料。
select throws_ok(
  $$select update_my_admin_profile('a3000000-0000-4000-8000-000000000021', '竄改姓名', '竄改職位')$$,
  'P0002',
  NULL,
  '管理員 A 帶別人商家(M2)的 merchant_id 呼叫時,找不到符合條件的列,直接被擋下'
);

select pg_temp.test_clear_auth();

-- ---------------------------------------------------------------------------
-- ② 客服 A 更新自己的暱稱/職位,應該成功。
-- ---------------------------------------------------------------------------
select pg_temp.test_set_auth('a3000000-0000-4000-8000-000000000003');

select lives_ok(
  $$select update_my_agent_profile('a3000000-0000-4000-8000-000000000020', '客服 A 暱稱', '客服專員')$$,
  '客服 A 可以成功更新自己在 M1 的 nickname/job_title'
);

select is(
  (select nickname from merchant_agents where id = 'a3000000-0000-4000-8000-000000000030'),
  '客服 A 暱稱',
  '客服 A 自己的 nickname 確實被更新'
);

select is(
  (select job_title from merchant_agents where id = 'a3000000-0000-4000-8000-000000000030'),
  '客服專員',
  '客服 A 自己的 job_title 確實被更新'
);

-- 隔離檢查:客服 B 的資料完全沒被動到。
select is(
  (select nickname from merchant_agents where id = 'a3000000-0000-4000-8000-000000000031'),
  null,
  '客服 A 更新自己的資料,不會影響到同一間商家另一位客服 B 的 nickname'
);

-- 帶別人的 merchant_id(M2):找不到符合條件的列,應該拋出例外。
select throws_ok(
  $$select update_my_agent_profile('a3000000-0000-4000-8000-000000000021', '竄改暱稱', '竄改職位')$$,
  'P0002',
  NULL,
  '客服 A 帶別人商家(M2)的 merchant_id 呼叫時,找不到符合條件的列,直接被擋下'
);

select pg_temp.test_clear_auth();

-- ---------------------------------------------------------------------------
-- ③ 權限邊界:anon 不能呼叫這兩支函式(比照既有 RPC 的 revoke 檢查方式)。
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.update_my_admin_profile(uuid, text, text)', 'execute'),
  'anon 角色不能執行 update_my_admin_profile'
);

select ok(
  not has_function_privilege('anon', 'public.update_my_agent_profile(uuid, text, text)', 'execute'),
  'anon 角色不能執行 update_my_agent_profile'
);

select * from finish();

rollback;
