-- 模組 2 RLS/規則回歸測試 ②:平台管理員能看到系統裡所有商家/集團。
-- 對應 supabase/migrations/20260915120100_platform_admin_rls_overlay.sql 疊加的
-- `or private.is_platform_admin()` 判斷式。
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
  ('f1000000-0000-4000-8000-000000000001', 'pgtap-platform-admin@test.local'),
  ('f1000000-0000-4000-8000-000000000002', 'pgtap-merchant-owner-a@test.local'),
  ('f1000000-0000-4000-8000-000000000003', 'pgtap-merchant-owner-b@test.local');

insert into platform_admins (user_id) values ('f1000000-0000-4000-8000-000000000001');

insert into groups (id) values
  ('f1000000-0000-4000-8000-000000000011'),
  ('f1000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('f1000000-0000-4000-8000-000000000021', 'f1000000-0000-4000-8000-000000000011', '涼風工匠', 'on_site_dispatch'),
  ('f1000000-0000-4000-8000-000000000022', 'f1000000-0000-4000-8000-000000000012', '美甲', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('f1000000-0000-4000-8000-000000000021', 'f1000000-0000-4000-8000-000000000002'),
  ('f1000000-0000-4000-8000-000000000022', 'f1000000-0000-4000-8000-000000000003');

select pg_temp.test_set_auth('f1000000-0000-4000-8000-000000000001');

select ok(
  private.is_platform_admin(),
  '平台管理員身份確實成立(am_i_platform_admin 的底層判斷)'
);

select is(
  (select count(*) from merchants where id in (
    'f1000000-0000-4000-8000-000000000021', 'f1000000-0000-4000-8000-000000000022'
  ))::int,
  2,
  '平台管理員可以同時看到兩間互不相干、分屬不同一般帳號的商家'
);

select is(
  (select count(*) from groups where id in (
    'f1000000-0000-4000-8000-000000000011', 'f1000000-0000-4000-8000-000000000012'
  ))::int,
  2,
  '平台管理員可以同時看到兩個互不相干的集團'
);

select lives_ok(
  $$select * from platform_get_merchant_admin_counts()$$,
  '平台管理員呼叫 platform_get_merchant_admin_counts 不會被拒絕'
);

select is(
  (
    select admin_count from platform_get_merchant_admin_counts()
    where merchant_id = 'f1000000-0000-4000-8000-000000000021'
  ),
  1::bigint,
  '平台管理員可以讀到「別人的商家」的管理員人數(涼風工匠有 1 位管理員)'
);

select is(
  am_i_platform_admin(),
  true,
  '前端會呼叫的 am_i_platform_admin() 對平台管理員回傳 true'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
