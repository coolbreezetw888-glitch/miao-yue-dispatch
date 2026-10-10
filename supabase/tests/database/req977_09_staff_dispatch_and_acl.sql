-- SPECS-INDEX #977 第 7 批(2026-10-07):服務人員新增編輯訂單 — pgTAP ⑤:通知權限、全部新函式的 ACL
-- migration 20261007100100_req977_staff_order_rpcs.sql
-- 規格書 .project/specs/服務人員新增編輯訂單-第7批.md 第三節 3-5,第六節 6-1、第七節資安自檢。
--
--   ①~⑤    can_staff_dispatch_booking_notification 放行:本人主要 + 事件符合現況
--            (建單 / 改單 ⇒ 未取消;取消 ⇒ 已取消;完成 ⇒ 已完成)
--   ⑥~⑮    一律 false:事件不符、協助人員、同店別人、別家商家的服務人員、商家 id 對不上、開關關、
--            不認得的事件、未登入、沒帶訂單 id
--   ⑯~⑰    11 支新的 public 函式:SECURITY DEFINER + search_path=public;anon / PUBLIC 沒有 EXECUTE、
--            authenticated 有(⑯ 是「清單真的有 11 支」的前提斷言,避免空清單假通過)
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

select plan(17);

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

-- 只換 auth.uid(),連線角色維持 postgres(用來直接問 private helper:那幾支 authenticated 沒有 EXECUTE)。
create function pg_temp.test_set_uid(p_user_id uuid)
returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
end;
$$;

-- ── Fixture(共用,#977 第 7 批 req977_05 ~ 09 同一份)────────────────────────────────
--   使用者:01 A 店管理員 / 03 A 店客服(orders)/ 04 甲(可以自己下單)/ 05 乙(協助,也可以自己下單)/
--           06 丙(同店另一位可以自己下單)/ 07 丁(已移除)/ 08 戊(行事曆檢視關)/ 09 B 店管理員 /
--           10 B 店庚(可以自己下單)/ 11 己(未開通登入)/ 12 辛(新增編輯訂單關)/ 13 壬(顯示會員資料關)/
--           14 A 店管理員兼服務人員癸(可以自己下單)
insert into auth.users (id, email) values
  ('f9777000-0000-4000-8000-000000000001', 'pgtap-r977g-admin@test.local'),
  ('f9777000-0000-4000-8000-000000000003', 'pgtap-r977g-agent@test.local'),
  ('f9777000-0000-4000-8000-000000000004', 'pgtap-r977g-jia@test.local'),
  ('f9777000-0000-4000-8000-000000000005', 'pgtap-r977g-yi@test.local'),
  ('f9777000-0000-4000-8000-000000000006', 'pgtap-r977g-bing@test.local'),
  ('f9777000-0000-4000-8000-000000000007', 'pgtap-r977g-ding@test.local'),
  ('f9777000-0000-4000-8000-000000000008', 'pgtap-r977g-wu@test.local'),
  ('f9777000-0000-4000-8000-000000000009', 'pgtap-r977g-adminB@test.local'),
  ('f9777000-0000-4000-8000-000000000010', 'pgtap-r977g-geng@test.local'),
  ('f9777000-0000-4000-8000-000000000011', 'pgtap-r977g-ji@test.local'),
  ('f9777000-0000-4000-8000-000000000012', 'pgtap-r977g-xin@test.local'),
  ('f9777000-0000-4000-8000-000000000013', 'pgtap-r977g-ren@test.local'),
  ('f9777000-0000-4000-8000-000000000014', 'pgtap-r977g-gui@test.local');

insert into groups (id) values
  ('f9777000-0000-4000-8000-000000000015'),
  ('f9777000-0000-4000-8000-000000000016');
insert into merchants (id, group_id, name, industry_type) values
  ('f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000015', '#977-7 A 店', 'on_site_dispatch'),
  ('f9777000-0000-4000-8000-000000000021', 'f9777000-0000-4000-8000-000000000016', '#977-7 B 店', 'on_site_dispatch');
insert into merchant_admins (id, merchant_id, user_id, display_name) values
  ('f9777000-0000-4000-8000-000000000025', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000001', '店主甲'),
  ('f9777000-0000-4000-8000-000000000026', 'f9777000-0000-4000-8000-000000000021', 'f9777000-0000-4000-8000-000000000009', '店主乙'),
  ('f9777000-0000-4000-8000-000000000027', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000014', '店主癸');
insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('f9777000-0000-4000-8000-000000000028', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000003', '客服甲', 'pgtap-r977g-agent@test.local', 'active', now(), '0900977728');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('f9777000-0000-4000-8000-000000000028', 'orders', true);

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('f9777000-0000-4000-8000-000000000030', 'f9777000-0000-4000-8000-000000000020', '到府服務', 800, 'primary', 60),
  ('f9777000-0000-4000-8000-000000000031', 'f9777000-0000-4000-8000-000000000021', '到府服務', 800, 'primary', 60),
  ('f9777000-0000-4000-8000-000000000032', 'f9777000-0000-4000-8000-000000000020', '加購清潔', 300, 'primary', 30);
insert into payment_methods (id, merchant_id, name) values
  ('f9777000-0000-4000-8000-000000000050', 'f9777000-0000-4000-8000-000000000020', '現金'),
  ('f9777000-0000-4000-8000-000000000052', 'f9777000-0000-4000-8000-000000000020', '轉帳'),
  ('f9777000-0000-4000-8000-000000000051', 'f9777000-0000-4000-8000-000000000021', '現金');
insert into material_cost_items (id, merchant_id, name, amount) values
  ('f9777000-0000-4000-8000-000000000055', 'f9777000-0000-4000-8000-000000000020', '冷媒', 200);

-- 服務人員(都開「商家後台編輯無時段限制」⇒ 建單不用布置時段)。
--   40 甲 / 41 乙 / 42 丙 / 43 丁(建單後改已移除)/ 44 戊(行事曆關)/ 46 B 店庚 / 45 己(建單後改未開通)/
--   47 辛(新增編輯訂單關)/ 48 壬(顯示會員資料關)/ 49 癸(管理員兼服務人員)
insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, unlimited_backend_edit, phone, can_create_edit_orders, show_member_info) values
  ('f9777000-0000-4000-8000-000000000040', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000004', '甲服務人員', 'monthly_salary', 'active', 'active', now(), true, '0900977740', true, true),
  ('f9777000-0000-4000-8000-000000000041', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000005', '乙服務人員', 'piece_rate', 'active', 'active', now(), true, '0900977741', true, true),
  ('f9777000-0000-4000-8000-000000000042', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000006', '丙服務人員', 'piece_rate', 'active', 'active', now(), true, '0900977742', true, true),
  ('f9777000-0000-4000-8000-000000000043', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000007', '丁服務人員', 'piece_rate', 'active', 'active', now(), true, '0900977743', true, true),
  ('f9777000-0000-4000-8000-000000000044', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000008', '戊服務人員', 'piece_rate', 'active', 'active', now(), true, '0900977744', true, true),
  ('f9777000-0000-4000-8000-000000000045', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000011', '己服務人員', 'piece_rate', 'active', 'active', now(), true, '0900977745', true, true),
  ('f9777000-0000-4000-8000-000000000046', 'f9777000-0000-4000-8000-000000000021', 'f9777000-0000-4000-8000-000000000010', '庚服務人員', 'piece_rate', 'active', 'active', now(), true, '0900977746', true, true),
  ('f9777000-0000-4000-8000-000000000047', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000012', '辛服務人員', 'piece_rate', 'active', 'active', now(), true, '0900977747', false, true),
  ('f9777000-0000-4000-8000-000000000048', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000013', '壬服務人員', 'piece_rate', 'active', 'active', now(), true, '0900977748', true, false),
  ('f9777000-0000-4000-8000-000000000049', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000014', '癸服務人員', 'piece_rate', 'active', 'active', now(), true, '0900977749', true, true);
insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('f9777000-0000-4000-8000-000000000040', 'staff_calendar_view', true),
  ('f9777000-0000-4000-8000-000000000041', 'staff_calendar_view', true),
  ('f9777000-0000-4000-8000-000000000042', 'staff_calendar_view', true),
  ('f9777000-0000-4000-8000-000000000043', 'staff_calendar_view', true),
  ('f9777000-0000-4000-8000-000000000044', 'staff_calendar_view', false),
  ('f9777000-0000-4000-8000-000000000045', 'staff_calendar_view', true),
  ('f9777000-0000-4000-8000-000000000046', 'staff_calendar_view', true),
  ('f9777000-0000-4000-8000-000000000047', 'staff_calendar_view', true),
  ('f9777000-0000-4000-8000-000000000048', 'staff_calendar_view', true),
  ('f9777000-0000-4000-8000-000000000049', 'staff_calendar_view', true);

-- 管理員建單用。
create function pg_temp.mk(p_staff uuid, p_start timestamptz, p_assistants uuid[] default '{}',
                           p_notes text default null, p_hide boolean default false, p_phone text default '0955977700')
returns uuid language sql as $$
  select id from public.create_booking(
    p_merchant_id => 'f9777000-0000-4000-8000-000000000020',
    p_staff_id => p_staff,
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9777000-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
    p_start_at => p_start,
    p_customer_name => '林小姐',
    p_customer_phone => p_phone,
    p_customer_address => '台北市測試路 7 號',
    p_notes => p_notes,
    p_hide_notes_from_staff => p_hide,
    p_assistant_staff_ids => p_assistants,
    p_payment_method_id => 'f9777000-0000-4000-8000-000000000050'
  );
$$;
grant execute on function pg_temp.mk(uuid, timestamptz, uuid[], text, boolean, text) to authenticated;

-- A 店每天 08:00–22:00 營業(時間清單 / 時段開關要用)。
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'f9777000-0000-4000-8000-000000000020', d, false, '08:00', '22:00' from generate_series(0, 6) d;

select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000001');
select pg_temp.mk('f9777000-0000-4000-8000-000000000040', '2036-07-01 10:00:00+08',
  array['f9777000-0000-4000-8000-000000000041'::uuid]) as id \gset b1_
select pg_temp.mk('f9777000-0000-4000-8000-000000000040', '2036-07-02 10:00:00+08') as id \gset b2_
select pg_temp.mk('f9777000-0000-4000-8000-000000000040', '2036-07-03 10:00:00+08') as id \gset b3_
select id from public.confirm_booking(:'b3_id'::uuid) \gset ignore_
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
select public.staff_cancel_booking(:'b2_id'::uuid) \gset ignore_
select public.staff_complete_booking(:'b3_id'::uuid) \gset ignore_

create function pg_temp.can(p_merchant uuid, p_booking uuid, p_event text)
returns boolean language sql as $$
  select public.can_staff_dispatch_booking_notification(p_merchant, p_booking, p_event);
$$;
grant execute on function pg_temp.can(uuid, uuid, text) to authenticated;

-- =========================================================================
-- ①~⑥ 放行
-- =========================================================================
select ok(pg_temp.can('f9777000-0000-4000-8000-000000000020', :'b1_id', 'booking_created'), '① 甲自己的待確認單 + booking_created ⇒ true');
select ok(pg_temp.can('f9777000-0000-4000-8000-000000000020', :'b1_id', 'booking_updated'), '② 甲自己的待確認單 + booking_updated ⇒ true');
select ok(pg_temp.can('f9777000-0000-4000-8000-000000000020', :'b2_id', 'booking_cancelled'), '③ 已取消的單 + booking_cancelled ⇒ true');
select ok(pg_temp.can('f9777000-0000-4000-8000-000000000020', :'b3_id', 'booking_completed'), '④ 已完成的單 + booking_completed ⇒ true');
select ok(pg_temp.can('f9777000-0000-4000-8000-000000000020', :'b3_id', 'booking_updated'), '⑤ 已完成的單 + booking_updated ⇒ true(未取消就算符合)');
select ok(not pg_temp.can('f9777000-0000-4000-8000-000000000020', :'b2_id', 'booking_updated'), '⑥ 已取消的單 + booking_updated ⇒ false');

-- =========================================================================
-- ⑦~⑭ 擋下
-- =========================================================================
select ok(not pg_temp.can('f9777000-0000-4000-8000-000000000020', :'b1_id', 'booking_cancelled')
          and not pg_temp.can('f9777000-0000-4000-8000-000000000020', :'b1_id', 'booking_completed'),
  '⑦ 事件跟現況不符(待確認的單發取消 / 完成)⇒ false');
select ok(not pg_temp.can('f9777000-0000-4000-8000-000000000020', :'b1_id', 'booking_reminder_next_day')
          and not pg_temp.can('f9777000-0000-4000-8000-000000000020', :'b1_id', 'staff_leave_created'),
  '⑧ 不認得的事件 ⇒ false');
select ok(not pg_temp.can('f9777000-0000-4000-8000-000000000021', :'b1_id', 'booking_created'), '⑨ 商家 id 對不上 ⇒ false');
select ok(not pg_temp.can('f9777000-0000-4000-8000-000000000020', null, 'booking_created'), '⑩ 沒帶訂單 id ⇒ false');
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000005');
select ok(not pg_temp.can('f9777000-0000-4000-8000-000000000020', :'b1_id', 'booking_created'), '⑪ 協助人員乙 ⇒ false');
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000006');
select ok(not pg_temp.can('f9777000-0000-4000-8000-000000000020', :'b1_id', 'booking_created'), '⑫ 同店別人丙 ⇒ false');
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000010');
select ok(not pg_temp.can('f9777000-0000-4000-8000-000000000020', :'b1_id', 'booking_created')
          and not pg_temp.can('f9777000-0000-4000-8000-000000000021', :'b1_id', 'booking_created'),
  '⑬ 別家商家的服務人員庚 ⇒ false');
select pg_temp.test_clear_auth();
update merchant_staff set show_member_info = false where id = 'f9777000-0000-4000-8000-000000000040';
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
select ok(not pg_temp.can('f9777000-0000-4000-8000-000000000020', :'b1_id', 'booking_created'), '⑭ 甲的顯示會員資料關 ⇒ false');
select pg_temp.test_clear_auth();
update merchant_staff set show_member_info = true where id = 'f9777000-0000-4000-8000-000000000040';
set local role authenticated;
select set_config('request.jwt.claims', '', true);
select ok(not pg_temp.can('f9777000-0000-4000-8000-000000000020', :'b1_id', 'booking_created'), '⑮ 未登入 ⇒ false');
reset role;

-- =========================================================================
-- ⑯~⑰ 新的 public 函式 ACL / SECURITY DEFINER / search_path
-- =========================================================================
create temp table r977k_fns on commit drop as
  select p.oid::regprocedure::text as sig, p.oid
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'staff_get_booking_form_options', 'staff_get_booking_for_edit', 'staff_list_my_bookable_start_times',
      'staff_preview_booking_points', 'staff_create_booking', 'staff_update_booking', 'staff_cancel_booking',
      'staff_complete_booking', 'staff_move_booking', 'staff_set_my_slot', 'can_staff_dispatch_booking_notification'
    );
select is((select count(*)::int from r977k_fns), 11, '⑯(前提)11 支新函式都在,而且沒有同名多載');
select is(
  (select string_agg(sig, ', ') from r977k_fns f join pg_proc p on p.oid = f.oid
   where not (
     p.prosecdef
     and 'search_path=public' = any(p.proconfig)
     and not has_function_privilege('anon', p.oid, 'execute')
     and not has_function_privilege('public', p.oid, 'execute')
     and has_function_privilege('authenticated', p.oid, 'execute')
   )),
  null,
  '⑰ 每一支都是 SECURITY DEFINER + search_path=public;anon / PUBLIC 沒有 EXECUTE、authenticated 有(不符合的清單應該是空的)'
);

select * from finish();
rollback;
