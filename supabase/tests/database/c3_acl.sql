-- 客戶端第 3 批 — 權限總表(C3-F02、C3-G01、supabase-permission-hygiene 規則 1、第 1 批鐵律 1)
begin;

select plan(9);

create function pg_temp.test_set_auth(p_user_id uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', p_role)::text, true);
  execute format('set local role %I', p_role);
end;
$$;

-- private 新函式:anon / authenticated / PUBLIC 都不能執行
select is(
  (select array_agg(p.proname || ':' || r order by p.proname, r)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated', 'public']) r
   where n.nspname = 'private'
     and p.proname in ('rate_limit_hit', 'prune_rate_limit_hits', 'tg_merchant_staff_display_order_insert', 'protect_merchant_staff_display_order',
                       'normalize_merchant_booking_completion_messages', 'customer_parse_booking_items', 'request_client_ip',
                       'enforce_public_rate_limit', 'customer_link_state', 'customer_booking_initial_status',
                       'notify_customer_booking_created', 'customer_booking_result')
     and (case when r = 'public' then exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
               else has_function_privilege(r, p.oid, 'execute') end)),
  null, 'ACL-1 private 新函式 anon / authenticated / PUBLIC 都不能執行');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private'
     and p.proname in ('rate_limit_hit', 'tg_merchant_staff_display_order_insert', 'protect_merchant_staff_display_order',
                       'normalize_merchant_booking_completion_messages', 'customer_parse_booking_items', 'request_client_ip',
                       'enforce_public_rate_limit', 'customer_link_state', 'customer_booking_initial_status',
                       'notify_customer_booking_created', 'customer_booking_result')),
  11, 'ACL-2 前置:11 支 private 新函式都存在');

-- internal_*:只有 service_role
select is(
  (select array_agg(p.proname || ':' || r order by p.proname, r)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated', 'public']) r
   where n.nspname = 'public' and p.proname in ('internal_customer_submit_booking', 'internal_rate_limit_hit')
     and (case when r = 'public' then exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
               else has_function_privilege(r, p.oid, 'execute') end)),
  null, 'ACL-3 / F02 internal_customer_submit_booking、internal_rate_limit_hit:anon / authenticated / PUBLIC 都不能執行');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('internal_customer_submit_booking', 'internal_rate_limit_hit')
     and has_function_privilege('service_role', p.oid, 'execute')),
  2, 'ACL-4 兩支 internal_* service_role 可以執行');

-- F02:登入者真的叫叫看
select pg_temp.test_set_auth('c3c00000-0000-4000-8000-000000000001');
select throws_ok($$select public.internal_customer_submit_booking('x', null, '0912345678', '{}'::jsonb, true, gen_random_uuid())$$,
  '42501', null, 'ACL-5 / F02 authenticated 直接呼叫送出核心 ⇒ 權限錯誤(訪客不能繞過 Edge 的 Turnstile)');
reset role;
set local role anon;
select throws_ok($$select public.internal_customer_submit_booking('x', null, '0912345678', '{}'::jsonb, true, gen_random_uuid())$$,
  '42501', null, 'ACL-6 / F02 anon 直接呼叫送出核心 ⇒ 權限錯誤');
reset role;

-- move_merchant_staff_order:只給 authenticated(函式內再檢查權限)
select is(
  (select array[has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute'),
                exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')]
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'move_merchant_staff_order'),
  array[false, true, false], 'ACL-7 move_merchant_staff_order:anon 不行、authenticated 可以、PUBLIC 沒有');

-- 計數表:沒有任何表層權限、沒有 policy
select is(
  (select array_agg(r || ':' || pr order by r, pr)
   from unnest(array['anon', 'authenticated']) r, unnest(array['select', 'insert', 'update', 'delete']) pr
   where has_table_privilege(r, 'private.rate_limit_hits', pr)),
  null, 'ACL-8 private.rate_limit_hits:anon / authenticated 沒有任何表層權限');

-- 第 1 批鐵律 1:給 anon 的 policy 仍為 0
select is(
  (select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
   where 'anon'::regrole = any(p.polroles)
      or (n.nspname = 'public' and 0::oid = any(p.polroles))),
  0, 'ACL-9 給 anon 的 policy 仍為 0');

select * from finish();
rollback;
