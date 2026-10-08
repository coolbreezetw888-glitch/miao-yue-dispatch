-- 客戶端第 2 批 — C2-F02 權限總表、第 1 批鐵律 1(anon policy = 0)、C2-C04 清理排程
begin;

select plan(9);

-- 新表:RLS 開、零 policy、anon / authenticated 沒有任何表層權限
select is(
  (select array_agg(c.relname::text order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('merchant_line_login_configs', 'customer_line_identities', 'customer_line_login_attempts', 'customer_policy_consents', 'customer_member_link_blocks')
     and c.relrowsecurity),
  array['customer_line_identities', 'customer_line_login_attempts', 'customer_member_link_blocks', 'customer_policy_consents', 'merchant_line_login_configs'],
  'ACL-1 五張新表都開了 RLS');
select is(
  (select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname in ('merchant_line_login_configs', 'customer_line_identities', 'customer_line_login_attempts', 'customer_policy_consents', 'customer_member_link_blocks')),
  0, 'ACL-2 五張新表零 policy');
select is(
  (select array_agg(t || ':' || r || ':' || pr order by t, r, pr)
   from unnest(array['merchant_line_login_configs', 'customer_line_identities', 'customer_line_login_attempts', 'customer_policy_consents', 'customer_member_link_blocks']) t,
        unnest(array['anon', 'authenticated']) r,
        unnest(array['select', 'insert', 'update', 'delete']) pr
   where has_table_privilege(r, 'public.' || t, pr)),
  null, 'ACL-3 anon / authenticated 對五張新表沒有任何表層權限');

-- 第 1 批鐵律 1:給 anon 的 policy 仍為 0
select is(
  (select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
   where 'anon'::regrole = any(p.polroles)
      or (n.nspname = 'public' and 0::oid = any(p.polroles))),
  0, 'ACL-4 給 anon 的 policy 仍為 0;public schema 也沒有給 PUBLIC 的 policy');

-- internal_*:只有 service_role
select is(
  (select array_agg(p.proname || ':' || r order by p.proname, r)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated', 'public']) r
   where n.nspname = 'public' and (p.proname like 'internal\_%line\_login%' or p.proname like 'internal\_customer\_line\_%')
     and (case when r = 'public' then exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
               else has_function_privilege(r, p.oid, 'execute') end)),
  null, 'ACL-5 internal_* 函式 anon / authenticated / PUBLIC 都不能執行');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and (p.proname like 'internal\_%line\_login%' or p.proname like 'internal\_customer\_line\_%')
     and has_function_privilege('service_role', p.oid, 'execute')),
  6, 'ACL-6 六支 internal_* 函式 service_role 可以執行');

-- private 內部函式:anon / authenticated 都不能執行
select is(
  (select array_agg(p.proname || ':' || r order by p.proname, r)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated']) r
   where n.nspname = 'private'
     and p.proname in ('is_customer_account', 'is_valid_customer_phone', 'create_member_as_customer_flow', 'notify_member_line_login_linked',
                       'link_customer_to_member', 'customer_open_booking_count', 'resolve_guest_member', 'prune_customer_line_login_attempts')
     and has_function_privilege(r, p.oid, 'execute')),
  null, 'ACL-7 private 新函式 anon / authenticated 都不能執行');

-- 對外函式:anon 不能執行(只給 authenticated)
select is(
  (select array_agg(p.proname order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('set_merchant_line_login_config', 'get_merchant_line_login_status', 'set_merchant_line_login_enabled',
                       'delete_merchant_line_login_config', 'customer_complete_profile', 'get_customer_session_state',
                       'get_member_customer_login_status', 'allow_member_customer_relink')
     and (has_function_privilege('anon', p.oid, 'execute') or not has_function_privilege('authenticated', p.oid, 'execute'))),
  null, 'ACL-8 八支對外函式:anon 不能執行、authenticated 可以');

-- C2-C04 清理排程
select is((select schedule from cron.job where jobname = 'customer-line-login-attempts-prune-hourly'), '17 * * * *', 'C04-1 每小時清理排程存在');

select * from finish();
rollback;
