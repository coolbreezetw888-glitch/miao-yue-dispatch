-- 客戶端第 4-A 批 — 權限總表(C4-F01、F03、supabase-permission-hygiene 規則 1、第 1 批鐵律 1)
begin;

select plan(12);

-- private 新函式:anon / authenticated / PUBLIC 都不能執行
select is(
  (select array_agg(p.proname || ':' || r order by p.proname, r)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated', 'public']) r
   where n.nspname = 'private'
     and p.proname in ('customer_member_of', 'customer_me_context', 'customer_cancel_deadline_hours', 'customer_can_cancel',
                       'customer_booking_view', 'customer_booking_summary_text', 'customer_point_history_page',
                       'notify_customer_booking_cancelled', 'protect_merchant_booking_settings_online_columns')
     and (case when r = 'public' then exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
               else has_function_privilege(r, p.oid, 'execute') end)),
  null, 'ACL-1 private 新函式(+ 改過的保護 trigger)anon / authenticated / PUBLIC 都不能執行');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private'
     and p.proname in ('customer_member_of', 'customer_me_context', 'customer_cancel_deadline_hours', 'customer_can_cancel',
                       'customer_booking_view', 'customer_booking_summary_text', 'customer_point_history_page',
                       'notify_customer_booking_cancelled')),
  8, 'ACL-2 前置:8 支 private 新函式都存在(且各只有一個簽章)');

-- internal_customer_cancel_booking:只有 service_role
select is(
  (select array[has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute'),
                exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'),
                has_function_privilege('service_role', p.oid, 'execute')]
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'internal_customer_cancel_booking'),
  array[false, false, false, true], 'ACL-3 internal_customer_cancel_booking:只有 service_role');
set local role authenticated;
select throws_ok($$select public.internal_customer_cancel_booking('x', gen_random_uuid(), gen_random_uuid())$$,
  '42501', null, 'ACL-4 authenticated 直接呼叫取消核心 ⇒ 權限錯誤(一定要經過 Edge)');
reset role;
set local role anon;
select throws_ok($$select public.internal_customer_cancel_booking('x', gen_random_uuid(), gen_random_uuid())$$,
  '42501', null, 'ACL-5 anon 直接呼叫取消核心 ⇒ 權限錯誤');
select throws_ok($$select public.customer_get_member_home('x')$$, '42501', null, 'ACL-6 anon 不能呼叫會員中心函式');
reset role;

-- 客人函式:只給 authenticated(函式內再擋 is_customer_account)
select is(
  (select array_agg(p.proname || ':' || has_function_privilege('anon', p.oid, 'execute')::text || ':'
                    || has_function_privilege('authenticated', p.oid, 'execute')::text || ':'
                    || exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')::text
                    order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('customer_get_member_home', 'customer_list_my_bookings', 'customer_get_wallet',
                                                'customer_get_profile', 'customer_update_profile')),
  array['customer_get_member_home:false:true:false', 'customer_get_profile:false:true:false', 'customer_get_wallet:false:true:false',
        'customer_list_my_bookings:false:true:false', 'customer_update_profile:false:true:false'],
  'ACL-7 五支客人函式:anon 不行、authenticated 可以、PUBLIC 沒有');
select is(
  (select array_to_string(p.proacl, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'customer_get_member_home'),
  'postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres', 'ACL-8 proacl 範例(customer_get_member_home;service_role 是 Supabase 預設權限)');

-- update_member 換簽章後 ACL 照舊(權限衛生:drop + create 要整組重寫)
select is(
  (select array_agg(pg_get_function_identity_arguments(p.oid) || '|' || array_to_string(p.proacl, ','))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'update_member'),
  array['p_member_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_tier_id uuid, p_address text|postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres'],
  'ACL-9 update_member 只剩 8 參數一個簽章,ACL 同改前(PUBLIC / anon 沒有)');

-- 第 1 批鐵律 1:給 anon 的 policy 仍為 0;members / bookings 沒有新增 policy
select is(
  (select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
   where 'anon'::regrole = any(p.polroles)
      or (n.nspname = 'public' and 0::oid = any(p.polroles))),
  0, 'ACL-10 給 anon 的 policy 仍為 0');
select is(
  (select array_agg(p.polname::text order by p.polname) from pg_policy p where p.polrelid = 'public.members'::regclass),
  array['members_select'], 'ACL-11 members 仍只有 members_select 一條 policy(沒有放寬)');
select is(
  (select array_agg(p.polname::text order by p.polname) from pg_policy p
   where p.polrelid in ('public.bookings'::regclass, 'public.member_point_transactions'::regclass)),
  array['bookings_select', 'member_point_transactions_select'],
  'ACL-12 bookings / 點數分類帳仍各只有一條 select policy(客人一律走函式,沒有放寬)');

select * from finish();
rollback;
