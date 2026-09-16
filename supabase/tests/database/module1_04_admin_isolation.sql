-- 模組 1 RLS/規則回歸測試 ④:一般帳號看不到別人的商家/集團。
-- 對應 supabase/migrations/20260915100000_merchant_group_schema.sql 的 merchants_select /
-- groups_select RLS 政策——兩個互不相干的商家管理員,彼此完全看不到對方的資料。
begin;

select plan(8);

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
  ('d1000000-0000-4000-8000-000000000001', 'pgtap-owner-a@test.local'),
  ('d1000000-0000-4000-8000-000000000002', 'pgtap-owner-b@test.local');

insert into groups (id) values
  ('d1000000-0000-4000-8000-000000000011'),
  ('d1000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('d1000000-0000-4000-8000-000000000021', 'd1000000-0000-4000-8000-000000000011', '涼風工匠(A的商家)', 'on_site_dispatch'),
  ('d1000000-0000-4000-8000-000000000022', 'd1000000-0000-4000-8000-000000000012', '美甲(B的商家)', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('d1000000-0000-4000-8000-000000000021', 'd1000000-0000-4000-8000-000000000001'),
  ('d1000000-0000-4000-8000-000000000022', 'd1000000-0000-4000-8000-000000000002');

-- 以帳號 A 的身份查詢。
select pg_temp.test_set_auth('d1000000-0000-4000-8000-000000000001');

select ok(
  private.is_merchant_admin('d1000000-0000-4000-8000-000000000021'),
  '帳號 A 是自己商家的管理員(正向對照組)'
);

select ok(
  not private.is_merchant_admin('d1000000-0000-4000-8000-000000000022'),
  '帳號 A 不是帳號 B 商家的管理員'
);

select is(
  (select count(*) from merchants where id = 'd1000000-0000-4000-8000-000000000022')::int,
  0,
  '帳號 A 透過 RLS 查詢完全看不到帳號 B 的商家'
);

select is(
  (select count(*) from groups where id = 'd1000000-0000-4000-8000-000000000012')::int,
  0,
  '帳號 A 透過 RLS 查詢完全看不到帳號 B 的集團'
);

select is(
  (select count(*) from merchants)::int,
  1,
  '帳號 A 查詢 merchants 這張表時,總共只看得到自己的 1 間商家(不會意外多看到別人的列)'
);

select pg_temp.test_clear_auth();

-- 反過來,以帳號 B 的身份查詢,結果應該完全對稱。
select pg_temp.test_set_auth('d1000000-0000-4000-8000-000000000002');

select ok(
  not private.is_merchant_admin('d1000000-0000-4000-8000-000000000021'),
  '帳號 B 不是帳號 A 商家的管理員'
);

select is(
  (select count(*) from merchants where id = 'd1000000-0000-4000-8000-000000000021')::int,
  0,
  '帳號 B 透過 RLS 查詢完全看不到帳號 A 的商家'
);

select is(
  (select count(*) from merchants)::int,
  1,
  '帳號 B 查詢 merchants 這張表時,總共只看得到自己的 1 間商家'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
