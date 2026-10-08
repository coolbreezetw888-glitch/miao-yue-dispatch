-- 客戶端第 1 批 — migration 1 / 權限:C1-C03 新欄位、C1-F01 不放寬 RLS、C1-F03 收回兩支函式權限、新函式 ACL
-- 規格書 .project/specs/客戶端第1批-公開預約頁.md
--   ①~⑦   C1-C03:預設值、check 上下界、line_friend_url 格式
--   ⑧~⑬   C1-C03:管理員寫得進去;有「營業時間」權限的客服仍能改建單間隔,但改不了新三欄;別家管理員寫不進去
--   ⑭~⑲   C1-F03:anon / authenticated 呼叫 apply_industry_preset / generate_booking_slug 都是權限錯誤;
--          PUBLIC 沒有 EXECUTE;一般登入者呼叫 create_group_and_merchant 仍成功且有 booking_slug
--   ⑳~㉖   C1-F01:anon 政策數 = 0;anon 直接讀 5 張表拿不到資料
--   ㉗~㉜   新函式 ACL:兩支 public 函式 anon / authenticated 可執行、PUBLIC 不行;private 新函式三個角色都不行
begin;

select plan(37);

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

-- ─── Fixture ───────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c1a00000-0000-4000-8000-000000000001', 'pgtap-c1acl-admin-a@test.local'),
  ('c1a00000-0000-4000-8000-000000000002', 'pgtap-c1acl-admin-b@test.local'),
  ('c1a00000-0000-4000-8000-000000000003', 'pgtap-c1acl-agent-a@test.local'),
  ('c1a00000-0000-4000-8000-000000000004', 'pgtap-c1acl-newuser@test.local');

insert into groups (id) values
  ('c1a00000-0000-4000-8000-000000000011'),
  ('c1a00000-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type, booking_slug) values
  ('c1a00000-0000-4000-8000-000000000021', 'c1a00000-0000-4000-8000-000000000011', '權限測試A店', 'on_site_dispatch', 'pgtap-c1acl-a'),
  ('c1a00000-0000-4000-8000-000000000022', 'c1a00000-0000-4000-8000-000000000012', '權限測試B店', 'in_store_beauty', 'pgtap-c1acl-b');
insert into merchant_admins (merchant_id, user_id) values
  ('c1a00000-0000-4000-8000-000000000021', 'c1a00000-0000-4000-8000-000000000001'),
  ('c1a00000-0000-4000-8000-000000000022', 'c1a00000-0000-4000-8000-000000000002');
insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('c1a00000-0000-4000-8000-000000000031', 'c1a00000-0000-4000-8000-000000000021', 'c1a00000-0000-4000-8000-000000000003',
   '客服甲', '0900161001', 'pgtap-c1acl-agent-a@test.local', 'active');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('c1a00000-0000-4000-8000-000000000031', 'business_hours', true);

-- ① ~ ③ 預設值(插入時只給 merchant_id)
insert into merchant_booking_settings (merchant_id) values ('c1a00000-0000-4000-8000-000000000021');
select is(
  (select min_lead_hours::int from merchant_booking_settings where merchant_id = 'c1a00000-0000-4000-8000-000000000021'),
  2, '① min_lead_hours 預設 2');
select is(
  (select travel_buffer_minutes::int from merchant_booking_settings where merchant_id = 'c1a00000-0000-4000-8000-000000000021'),
  0, '② travel_buffer_minutes 預設 0');
select is(
  (select allow_guest_booking from merchant_booking_settings where merchant_id = 'c1a00000-0000-4000-8000-000000000021'),
  true, '③ allow_guest_booking 預設 true');

-- ④ ⑤ check 上下界
select lives_ok(
  $$update merchant_booking_settings set min_lead_hours = 0, travel_buffer_minutes = 0 where merchant_id = 'c1a00000-0000-4000-8000-000000000021';
    update merchant_booking_settings set min_lead_hours = 72, travel_buffer_minutes = 240 where merchant_id = 'c1a00000-0000-4000-8000-000000000021'$$,
  '④ 上下界 0 / 72、0 / 240 都可以存');
select throws_ok(
  $$update merchant_booking_settings set min_lead_hours = 73 where merchant_id = 'c1a00000-0000-4000-8000-000000000021'$$,
  '23514', null, '⑤-1 min_lead_hours = 73 被 check 擋下');
select throws_ok(
  $$update merchant_booking_settings set min_lead_hours = -1 where merchant_id = 'c1a00000-0000-4000-8000-000000000021'$$,
  '23514', null, '⑤-2 min_lead_hours = -1 被 check 擋下');
select throws_ok(
  $$update merchant_booking_settings set travel_buffer_minutes = 241 where merchant_id = 'c1a00000-0000-4000-8000-000000000021'$$,
  '23514', null, '⑤-3 travel_buffer_minutes = 241 被 check 擋下');
select throws_ok(
  $$update merchant_booking_settings set travel_buffer_minutes = -1 where merchant_id = 'c1a00000-0000-4000-8000-000000000021'$$,
  '23514', null, '⑤-4 travel_buffer_minutes = -1 被 check 擋下');

-- ⑥ ⑦ line_friend_url 格式
select lives_ok(
  $$update merchants set line_friend_url = 'https://lin.ee/abc' where id = 'c1a00000-0000-4000-8000-000000000021';
    update merchants set line_friend_url = null where id = 'c1a00000-0000-4000-8000-000000000021'$$,
  '⑥ line_friend_url 可存 https:// 開頭網址,也可清成 null');
select throws_ok(
  $$update merchants set line_friend_url = 'javascript:alert(1)' where id = 'c1a00000-0000-4000-8000-000000000021'$$,
  '23514', null, '⑦-1 javascript: 被擋');
select throws_ok(
  $$update merchants set line_friend_url = 'http://line.me/x' where id = 'c1a00000-0000-4000-8000-000000000021'$$,
  '23514', null, '⑦-2 http:// 被擋');
select throws_ok(
  format($$update merchants set line_friend_url = 'https://line.me/%s' where id = 'c1a00000-0000-4000-8000-000000000021'$$, repeat('a', 290)),
  '23514', null, '⑦-3 超過 300 字被擋');

update merchant_booking_settings set min_lead_hours = 2, travel_buffer_minutes = 0 where merchant_id = 'c1a00000-0000-4000-8000-000000000021';

-- ⑧ 管理員可以改新三欄 + line_friend_url
select pg_temp.test_set_auth('c1a00000-0000-4000-8000-000000000001');
select lives_ok(
  $$update merchant_booking_settings set min_lead_hours = 5, travel_buffer_minutes = 30, allow_guest_booking = false
      where merchant_id = 'c1a00000-0000-4000-8000-000000000021';
    update merchants set line_friend_url = 'https://line.me/R/ti/p/@abc' where id = 'c1a00000-0000-4000-8000-000000000021'$$,
  '⑧ 管理員可以改線上預約設定與 LINE 好友連結');
select pg_temp.test_clear_auth();
select is(
  (select row(min_lead_hours, travel_buffer_minutes, allow_guest_booking)::text from merchant_booking_settings
    where merchant_id = 'c1a00000-0000-4000-8000-000000000021'),
  '(5,30,f)', '⑨ 管理員寫入的值有存進去');

-- ⑩ 有「營業時間」權限的客服:建單間隔照舊能改
select pg_temp.test_set_auth('c1a00000-0000-4000-8000-000000000003');
select lives_ok(
  $$update merchant_booking_settings set start_time_interval_minutes = 15 where merchant_id = 'c1a00000-0000-4000-8000-000000000021'$$,
  '⑩ 客服(營業時間權限)仍可改建單時間間隔(既有行為不變)');
-- ⑪ 客服改不了新三欄
select throws_ok(
  $$update merchant_booking_settings set min_lead_hours = 0 where merchant_id = 'c1a00000-0000-4000-8000-000000000021'$$,
  '42501', '只有商家管理員可以修改線上預約設定', '⑪-1 客服改 min_lead_hours ⇒ 42501');
select throws_ok(
  $$update merchant_booking_settings set travel_buffer_minutes = 0 where merchant_id = 'c1a00000-0000-4000-8000-000000000021'$$,
  '42501', '只有商家管理員可以修改線上預約設定', '⑪-2 客服改 travel_buffer_minutes ⇒ 42501');
select throws_ok(
  $$update merchant_booking_settings set allow_guest_booking = true where merchant_id = 'c1a00000-0000-4000-8000-000000000021'$$,
  '42501', '只有商家管理員可以修改線上預約設定', '⑪-3 客服改 allow_guest_booking ⇒ 42501');
-- ⑫ 客服改不了 merchants.line_friend_url(沒有 merchants UPDATE 政策 ⇒ 0 列)
update merchants set line_friend_url = 'https://lin.ee/agent' where id = 'c1a00000-0000-4000-8000-000000000021';
select pg_temp.test_clear_auth();
select is(
  (select line_friend_url from merchants where id = 'c1a00000-0000-4000-8000-000000000021'),
  'https://line.me/R/ti/p/@abc', '⑫ 客服改 LINE 好友連結沒有效果');

-- ⑬ 別家管理員:upsert 自己沒權限的商家 ⇒ 被擋;update 只會是 0 列
select pg_temp.test_set_auth('c1a00000-0000-4000-8000-000000000002');
select throws_ok(
  $$insert into merchant_booking_settings (merchant_id, min_lead_hours) values ('c1a00000-0000-4000-8000-000000000021', 0)
      on conflict (merchant_id) do update set min_lead_hours = excluded.min_lead_hours$$,
  '42501', null, '⑬-1 別家管理員 upsert A 店設定 ⇒ 42501');
update merchant_booking_settings set min_lead_hours = 0 where merchant_id = 'c1a00000-0000-4000-8000-000000000021';
update merchants set line_friend_url = 'https://lin.ee/other' where id = 'c1a00000-0000-4000-8000-000000000021';
select pg_temp.test_clear_auth();
select is(
  (select min_lead_hours::text || '|' || (select line_friend_url from merchants where id = 'c1a00000-0000-4000-8000-000000000021')
     from merchant_booking_settings where merchant_id = 'c1a00000-0000-4000-8000-000000000021'),
  '5|https://line.me/R/ti/p/@abc', '⑬-2 別家管理員的 update 沒有改到 A 店任何值');

-- ⑭ ~ ⑰ C1-F03
select pg_temp.test_set_auth('c1a00000-0000-4000-8000-000000000001', 'anon');
select throws_ok($$select public.apply_industry_preset('c1a00000-0000-4000-8000-000000000021')$$, '42501', null,
  '⑭ anon 呼叫 apply_industry_preset ⇒ 權限錯誤');
select throws_ok($$select public.generate_booking_slug('abc')$$, '42501', null,
  '⑮ anon 呼叫 generate_booking_slug ⇒ 權限錯誤');
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('c1a00000-0000-4000-8000-000000000001');
select throws_ok($$select public.apply_industry_preset('c1a00000-0000-4000-8000-000000000021')$$, '42501', null,
  '⑯ authenticated 呼叫 apply_industry_preset ⇒ 權限錯誤');
select throws_ok($$select public.generate_booking_slug('abc')$$, '42501', null,
  '⑰ authenticated 呼叫 generate_booking_slug ⇒ 權限錯誤');
select pg_temp.test_clear_auth();

select is(
  (select bool_or(has_function_privilege(r, f, 'execute'))
     from unnest(array['public', 'anon', 'authenticated']) r,
          unnest(array['public.apply_industry_preset(uuid)', 'public.generate_booking_slug(text)']) f
     where r <> 'public')
  or exists (select 1 from pg_proc p, aclexplode(p.proacl) a
             where p.oid in ('public.apply_industry_preset(uuid)'::regprocedure, 'public.generate_booking_slug(text)'::regprocedure)
               and a.grantee = 0),
  false, '⑱ 兩支函式的 ACL 不含 PUBLIC / anon / authenticated');

-- ⑲ 一般登入者呼叫 create_group_and_merchant 仍成功,且有 booking_slug
select pg_temp.test_set_auth('c1a00000-0000-4000-8000-000000000004');
select lives_ok(
  $$select public.create_group_and_merchant('權限收回後新開的店', 'in_store_beauty')$$,
  '⑲-1 一般登入者 create_group_and_merchant 仍成功');
select pg_temp.test_clear_auth();
select ok(
  (select booking_slug is not null and booking_slug <> '' from merchants m
     join merchant_admins ma on ma.merchant_id = m.id
    where ma.user_id = 'c1a00000-0000-4000-8000-000000000004'),
  '⑲-2 新商家有 booking_slug');

-- ⑳ ~ ㉕ C1-F01
select is(
  (select count(*)::int from pg_policy where 'anon'::regrole = any(polroles)),
  0, '⑳ 沒有任何給 anon 的 RLS 政策');
select pg_temp.test_set_auth('c1a00000-0000-4000-8000-000000000001', 'anon');
select is((select count(*)::int from merchants), 0, '㉑ anon 直接讀 merchants ⇒ 0 列');
select is((select count(*)::int from merchant_staff), 0, '㉒ anon 直接讀 merchant_staff ⇒ 0 列');
select is((select count(*)::int from service_items), 0, '㉓ anon 直接讀 service_items ⇒ 0 列');
select is((select count(*)::int from bookings), 0, '㉔ anon 直接讀 bookings ⇒ 0 列');
select throws_ok($$select count(*) from merchant_booking_settings$$, '42501', null,
  '㉕ anon 直接讀 merchant_booking_settings ⇒ 沒有權限');
select pg_temp.test_clear_auth();

-- ㉖ ~ ㉘ 新函式 ACL
select ok(
  has_function_privilege('anon', 'public.get_public_booking_page(text)', 'execute')
  and has_function_privilege('authenticated', 'public.get_public_booking_page(text)', 'execute')
  and has_function_privilege('anon', 'public.get_public_available_slots(text, jsonb, uuid, date, integer)', 'execute')
  and has_function_privilege('authenticated', 'public.get_public_available_slots(text, jsonb, uuid, date, integer)', 'execute'),
  '㉖ 兩支公開函式 anon / authenticated 可以執行');
select is(
  (select count(*)::int from pg_proc p, aclexplode(p.proacl) a
    where p.oid in ('public.get_public_booking_page(text)'::regprocedure,
                    'public.get_public_available_slots(text, jsonb, uuid, date, integer)'::regprocedure)
      and a.grantee = 0),
  0, '㉗ 兩支公開函式的 ACL 沒有 PUBLIC');
select is(
  (select count(*)::int
     from unnest(array[
       'private.customer_slot_range_ok(public.merchant_staff, smallint, boolean, boolean, time, time, time, time)',
       'private.check_customer_booking_slot(uuid, public.merchant_staff, timestamptz, timestamptz, timestamptz, uuid)',
       'private.customer_staff_can_do_items(uuid, uuid[])',
       'private.public_available_slots_at(text, jsonb, uuid, date, integer, timestamptz)',
       'private.protect_merchant_booking_settings_online_columns()'
     ]) f,
     unnest(array['anon', 'authenticated']) r
    where has_function_privilege(r, f, 'execute'))
  + (select count(*)::int from pg_proc p, aclexplode(p.proacl) a
      where p.proname in ('customer_slot_range_ok', 'check_customer_booking_slot', 'customer_staff_can_do_items',
                          'public_available_slots_at', 'protect_merchant_booking_settings_online_columns')
        and p.pronamespace = 'private'::regnamespace
        and a.grantee = 0),
  0, '㉘ private 新函式 PUBLIC / anon / authenticated 都不能執行');

select * from finish();
rollback;
