-- SPECS-INDEX #986 第 9 批(2026-10-07):確認接單後客服也收到鈴鐺 + 服務項目描述
-- migration 20261007120200_req986_staff_confirm_notify_agents.sql
--           20261007120000_req986_service_item_description.sql
-- 規格書 .project/specs/使用者裁決小項與第7批調整-第9批.md 3-3、3-5、5-1。
--
--   ①~③    staff_confirm_booking:指紋(拿掉本批段落、註解換回原文 = 改前)、ACL、SECURITY DEFINER
--   ④~⑩    鈴鐺:管理員照舊;有 orders 的在職客服收到 agent 一則;沒 orders / granted = false / 已移除 /
--            邀請中 / 沒有 user_id / 別家客服 / 其他服務人員收不到;管理員兼客服只收到一則
--   ⑪~⑱    服務項目描述:201 字擋、200 字可、null 可;管理員、service_items 客服可寫;
--            沒權限客服、服務人員寫不進去
begin;

select plan(18);

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

-- =========================================================================
-- ①~③ 結構
-- =========================================================================
select is(
  (select md5(replace(
     regexp_replace(replace(p.prosrc, E'\r\n', E'\n'),
       '[ ]*?-- \[req986-batch9 begin\].*?-- \[req986-batch9 end\]\n', '', 'g'),
     '(merchant_admins 每一列),以及有「訂單管理」權限的在職客服(#986 第 9 批);不含其他服務人員。',
     '(merchant_admins 每一列;不含客服、不含其他服務人員)。'))
   from pg_proc p where p.oid = 'public.staff_confirm_booking(uuid)'::regprocedure),
  '6e2bf9642b01b633ac0275f7fc85996a',
  '① staff_confirm_booking 拿掉本批段落、第 7 步註解換回原文後 = 改前指紋'
);
select is(
  (select array_to_string(proacl, ' ') from pg_proc where oid = 'public.staff_confirm_booking(uuid)'::regprocedure),
  'postgres=X/postgres authenticated=X/postgres service_role=X/postgres',
  '② ACL:沒有 PUBLIC / anon,只給 authenticated 與 service_role'
);
select is(
  (select prosecdef::text || '/' || provolatile::text from pg_proc where oid = 'public.staff_confirm_booking(uuid)'::regprocedure),
  'true/v',
  '③ 仍是 SECURITY DEFINER、VOLATILE'
);

-- =========================================================================
-- Fixture
--   01 A 店管理員 / 02 A 店管理員兼客服(orders)/ 03 客服 O(orders)/ 04 客服 N(沒有 orders,只有 service_items)/
--   05 客服 F(orders granted = false)/ 06 客服 R(已移除,orders)/ 07 客服 I(邀請中,orders)/
--   09 B 店客服(orders)/ 10 服務人員 P(主要)/ 11 服務人員 Z(同店其他服務人員)
--   另有一位 A 店客服 U(在職、orders,但 user_id 是 null)
-- =========================================================================
insert into auth.users (id, email) values
  ('f9861000-0000-4000-8000-000000000001', 'pgtap-r986b-admin@test.local'),
  ('f9861000-0000-4000-8000-000000000002', 'pgtap-r986b-dual@test.local'),
  ('f9861000-0000-4000-8000-000000000003', 'pgtap-r986b-agentO@test.local'),
  ('f9861000-0000-4000-8000-000000000004', 'pgtap-r986b-agentN@test.local'),
  ('f9861000-0000-4000-8000-000000000005', 'pgtap-r986b-agentF@test.local'),
  ('f9861000-0000-4000-8000-000000000006', 'pgtap-r986b-agentR@test.local'),
  ('f9861000-0000-4000-8000-000000000007', 'pgtap-r986b-agentI@test.local'),
  ('f9861000-0000-4000-8000-000000000009', 'pgtap-r986b-agentB@test.local'),
  ('f9861000-0000-4000-8000-000000000010', 'pgtap-r986b-staffP@test.local'),
  ('f9861000-0000-4000-8000-000000000011', 'pgtap-r986b-staffZ@test.local'),
  ('f9861000-0000-4000-8000-000000000012', 'pgtap-r986b-adminB@test.local');

insert into groups (id) values
  ('f9861000-0000-4000-8000-000000000015'),
  ('f9861000-0000-4000-8000-000000000016');
insert into merchants (id, group_id, name, industry_type) values
  ('f9861000-0000-4000-8000-000000000020', 'f9861000-0000-4000-8000-000000000015', '#986b A 店', 'on_site_dispatch'),
  ('f9861000-0000-4000-8000-000000000021', 'f9861000-0000-4000-8000-000000000016', '#986b B 店', 'on_site_dispatch');
insert into merchant_admins (id, merchant_id, user_id, display_name) values
  ('f9861000-0000-4000-8000-000000000025', 'f9861000-0000-4000-8000-000000000020', 'f9861000-0000-4000-8000-000000000001', '店主甲'),
  ('f9861000-0000-4000-8000-000000000026', 'f9861000-0000-4000-8000-000000000020', 'f9861000-0000-4000-8000-000000000002', '店主兼客服'),
  ('f9861000-0000-4000-8000-000000000027', 'f9861000-0000-4000-8000-000000000021', 'f9861000-0000-4000-8000-000000000012', '店主乙');
insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('f9861000-0000-4000-8000-000000000032', 'f9861000-0000-4000-8000-000000000020', 'f9861000-0000-4000-8000-000000000002', '兼任客服', 'pgtap-r986b-dual@test.local', 'active', now(), '0900986132'),
  ('f9861000-0000-4000-8000-000000000033', 'f9861000-0000-4000-8000-000000000020', 'f9861000-0000-4000-8000-000000000003', '客服O', 'pgtap-r986b-agentO@test.local', 'active', now(), '0900986133'),
  ('f9861000-0000-4000-8000-000000000034', 'f9861000-0000-4000-8000-000000000020', 'f9861000-0000-4000-8000-000000000004', '客服N', 'pgtap-r986b-agentN@test.local', 'active', now(), '0900986134'),
  ('f9861000-0000-4000-8000-000000000035', 'f9861000-0000-4000-8000-000000000020', 'f9861000-0000-4000-8000-000000000005', '客服F', 'pgtap-r986b-agentF@test.local', 'active', now(), '0900986135'),
  ('f9861000-0000-4000-8000-000000000036', 'f9861000-0000-4000-8000-000000000020', 'f9861000-0000-4000-8000-000000000006', '客服R', 'pgtap-r986b-agentR@test.local', 'removed', now(), '0900986136'),
  ('f9861000-0000-4000-8000-000000000037', 'f9861000-0000-4000-8000-000000000020', 'f9861000-0000-4000-8000-000000000007', '客服I', 'pgtap-r986b-agentI@test.local', 'invited', null, '0900986137'),
  ('f9861000-0000-4000-8000-000000000038', 'f9861000-0000-4000-8000-000000000020', null, '客服U', 'pgtap-r986b-agentU@test.local', 'active', now(), '0900986138'),
  ('f9861000-0000-4000-8000-000000000039', 'f9861000-0000-4000-8000-000000000021', 'f9861000-0000-4000-8000-000000000009', '客服B', 'pgtap-r986b-agentB@test.local', 'active', now(), '0900986139');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('f9861000-0000-4000-8000-000000000032', 'orders', true),
  ('f9861000-0000-4000-8000-000000000033', 'orders', true),
  ('f9861000-0000-4000-8000-000000000034', 'service_items', true),
  ('f9861000-0000-4000-8000-000000000035', 'orders', false),
  ('f9861000-0000-4000-8000-000000000036', 'orders', true),
  ('f9861000-0000-4000-8000-000000000037', 'orders', true),
  ('f9861000-0000-4000-8000-000000000038', 'orders', true),
  ('f9861000-0000-4000-8000-000000000039', 'orders', true);

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('f9861000-0000-4000-8000-000000000040', 'f9861000-0000-4000-8000-000000000020', '到府服務', 800, 'primary', 60);
insert into payment_methods (id, merchant_id, name) values
  ('f9861000-0000-4000-8000-000000000050', 'f9861000-0000-4000-8000-000000000020', '現金');
insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, unlimited_backend_edit, phone) values
  ('f9861000-0000-4000-8000-000000000060', 'f9861000-0000-4000-8000-000000000020', 'f9861000-0000-4000-8000-000000000010', '主要甲', 'piece_rate', 'active', 'active', now(), true, '0900986160'),
  ('f9861000-0000-4000-8000-000000000061', 'f9861000-0000-4000-8000-000000000020', 'f9861000-0000-4000-8000-000000000011', '其他乙', 'piece_rate', 'active', 'active', now(), true, '0900986161');
insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('f9861000-0000-4000-8000-000000000060', 'staff_calendar_view', true),
  ('f9861000-0000-4000-8000-000000000061', 'staff_calendar_view', true);
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'f9861000-0000-4000-8000-000000000020', d, false, '08:00', '22:00' from generate_series(0, 6) d;

select pg_temp.test_set_auth('f9861000-0000-4000-8000-000000000001');
select (public.create_booking(
  p_merchant_id => 'f9861000-0000-4000-8000-000000000020',
  p_staff_id => 'f9861000-0000-4000-8000-000000000060',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9861000-0000-4000-8000-000000000040','quantity',1,'unit_price',800)),
  p_start_at => '2036-09-01 14:00+08',
  p_customer_name => '陳小美',
  p_customer_phone => '0955986100',
  p_customer_address => '台北市保密路 1 號',
  p_payment_method_id => 'f9861000-0000-4000-8000-000000000050'
)).id as id \gset b_
select pg_temp.test_set_auth('f9861000-0000-4000-8000-000000000010');
select public.staff_confirm_booking(:'b_id'::uuid);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ④~⑩ 鈴鐺
-- =========================================================================
select is(
  (select array_agg(target_type || ':' || target_id::text order by target_id::text)
   from user_notifications where booking_id = :'b_id'::uuid and event_type = 'booking_confirmed' and target_type = 'admin'),
  array['admin:f9861000-0000-4000-8000-000000000025', 'admin:f9861000-0000-4000-8000-000000000026'],
  '④ 兩位管理員照舊各收到一則(target_type admin)'
);
select is(
  (select array_agg(user_id::text || '/' || target_id::text order by user_id::text)
   from user_notifications where booking_id = :'b_id'::uuid and event_type = 'booking_confirmed' and target_type = 'agent'),
  array['f9861000-0000-4000-8000-000000000003/f9861000-0000-4000-8000-000000000033'],
  '⑤ 只有「在職 + 有訂單管理權限 + 不是管理員」的客服 O 收到 agent 一則(target_id = merchant_agents.id)'
);
select is(
  (select count(*)::int from user_notifications
   where booking_id = :'b_id'::uuid
     and user_id in ('f9861000-0000-4000-8000-000000000004', 'f9861000-0000-4000-8000-000000000005')),
  0,
  '⑥ 沒有 orders 權限 / orders granted = false 的客服收不到'
);
select is(
  (select count(*)::int from user_notifications
   where booking_id = :'b_id'::uuid
     and user_id in ('f9861000-0000-4000-8000-000000000006', 'f9861000-0000-4000-8000-000000000007')),
  0,
  '⑦ 已移除 / 邀請中的客服收不到'
);
select is(
  (select count(*)::int from user_notifications
   where booking_id = :'b_id'::uuid
     and (target_id = 'f9861000-0000-4000-8000-000000000038'
          or user_id in ('f9861000-0000-4000-8000-000000000009', 'f9861000-0000-4000-8000-000000000012'))),
  0,
  '⑧ user_id 是 null 的客服、別家商家客服與管理員收不到'
);
select is(
  (select count(*)::int from user_notifications
   where booking_id = :'b_id'::uuid and user_id = 'f9861000-0000-4000-8000-000000000002'),
  1,
  '⑨ 同一人既是管理員又是有訂單管理權限的客服 ⇒ 只收到一則(以管理員身分)'
);
select is(
  (select count(*)::int from user_notifications
   where booking_id = :'b_id'::uuid
     and user_id in ('f9861000-0000-4000-8000-000000000010', 'f9861000-0000-4000-8000-000000000011')),
  0,
  '⑩ 主要服務人員本人、其他服務人員收不到'
);

-- =========================================================================
-- ⑪~⑱ 服務項目描述
-- =========================================================================
select throws_ok(
  $$update service_items set description = repeat('字', 201) where id = 'f9861000-0000-4000-8000-000000000040'$$,
  '23514', NULL, '⑪ 201 字被 CHECK 擋'
);
select lives_ok(
  $$update service_items set description = repeat('字', 200) where id = 'f9861000-0000-4000-8000-000000000040'$$,
  '⑫ 200 字可以存'
);
select lives_ok(
  $$update service_items set description = null where id = 'f9861000-0000-4000-8000-000000000040'$$,
  '⑬ null 可以存(= 沒填)'
);

select pg_temp.test_set_auth('f9861000-0000-4000-8000-000000000001');
update service_items set description = '管理員寫的' where id = 'f9861000-0000-4000-8000-000000000040';
select pg_temp.test_clear_auth();
select is((select description from service_items where id = 'f9861000-0000-4000-8000-000000000040'), '管理員寫的', '⑭ 管理員可以寫描述');

select pg_temp.test_set_auth('f9861000-0000-4000-8000-000000000004');
update service_items set description = '服務項目客服寫的' where id = 'f9861000-0000-4000-8000-000000000040';
select lives_ok(
  $$insert into service_items (merchant_id, name, price, item_type, duration_minutes, description)
    values ('f9861000-0000-4000-8000-000000000020', '客服新增的項目', 500, 'primary', 30, '新增時就填描述')$$,
  '⑮ 有 service_items 權限的客服新增項目時可以帶描述'
);
select pg_temp.test_clear_auth();
select is((select description from service_items where id = 'f9861000-0000-4000-8000-000000000040'), '服務項目客服寫的', '⑯ 有 service_items 權限的客服可以改描述');

select pg_temp.test_set_auth('f9861000-0000-4000-8000-000000000003');
update service_items set description = '訂單客服亂改' where id = 'f9861000-0000-4000-8000-000000000040';
select pg_temp.test_set_auth('f9861000-0000-4000-8000-000000000010');
update service_items set description = '服務人員亂改' where id = 'f9861000-0000-4000-8000-000000000040';
select throws_ok(
  $$insert into service_items (merchant_id, name, price, item_type, duration_minutes, description)
    values ('f9861000-0000-4000-8000-000000000020', '服務人員新增', 500, 'primary', 30, 'x')$$,
  '42501', NULL, '⑰ 服務人員不能新增服務項目(RLS)'
);
select pg_temp.test_clear_auth();
select is((select description from service_items where id = 'f9861000-0000-4000-8000-000000000040'), '服務項目客服寫的',
  '⑱ 沒有 service_items 權限的客服、服務人員改描述都沒有生效(表層 RLS 沒放寬)');

select * from finish();
rollback;
