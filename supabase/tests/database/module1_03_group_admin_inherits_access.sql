-- 模組 1 RLS/規則回歸測試 ③:集團管理者自動取得集團底下所有商家的管理權限。
-- 對應 supabase/migrations/20260915100000_merchant_group_schema.sql 的 private.is_merchant_admin()
-- 判斷式(規則 2.4)——集團管理者不需要在 merchant_admins 裡另外掛一筆,光靠
-- groups.group_admin_user_id 指到自己就自動有權限。
begin;

select plan(5);

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
  ('c1000000-0000-4000-8000-000000000001', 'pgtap-group-admin@test.local'),
  ('c1000000-0000-4000-8000-000000000002', 'pgtap-stranger@test.local');

insert into groups (id, group_admin_user_id)
values ('c1000000-0000-4000-8000-000000000010', 'c1000000-0000-4000-8000-000000000001');

insert into merchants (id, group_id, name, industry_type)
values (
  'c1000000-0000-4000-8000-000000000020',
  'c1000000-0000-4000-8000-000000000010',
  '集團管理者測試商家',
  'on_site_dispatch'
);

-- 刻意「不」在 merchant_admins 插入集團管理者的紀錄——這正是要驗證的重點:
-- 集團管理者的權限完全來自 groups.group_admin_user_id,不需要額外一筆 merchant_admins。

select pg_temp.test_set_auth('c1000000-0000-4000-8000-000000000001');

select ok(
  private.is_merchant_admin('c1000000-0000-4000-8000-000000000020'),
  '規則 2.4:集團管理者對集團底下的商家,is_merchant_admin() 自動回傳 true(即使沒有 merchant_admins 紀錄)'
);

select ok(
  private.is_group_member('c1000000-0000-4000-8000-000000000010'),
  '集團管理者對自己管理的集團,is_group_member() 回傳 true'
);

select is(
  (select count(*) from merchants where id = 'c1000000-0000-4000-8000-000000000020')::int,
  1,
  '集團管理者透過 merchants_select RLS 政策可以直接查到集團底下的商家'
);

select pg_temp.test_clear_auth();

-- 對照組:跟這個集團完全無關的一般帳號,不應該有任何權限。
select pg_temp.test_set_auth('c1000000-0000-4000-8000-000000000002');

select ok(
  not private.is_merchant_admin('c1000000-0000-4000-8000-000000000020'),
  '跟集團無關的一般帳號,is_merchant_admin() 回傳 false'
);

select is(
  (select count(*) from merchants where id = 'c1000000-0000-4000-8000-000000000020')::int,
  0,
  '跟集團無關的一般帳號,透過 RLS 查詢完全看不到這間商家'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
