-- SPECS-INDEX #977 第 4 批(2026-10-06):服務人員接單確認 — pgTAP
-- migration 20261006140000_req977_staff_confirm_booking.sql
-- 規格書 .project/specs/服務人員接單確認-第4批.md 第一、二、六、七節。
--
--   ①~⑨  放行 / 擋下:未登入、協助人員、別人的單、別家商家服務人員、別家商家管理員、已移除、未開通登入、
--          行事曆檢視關閉;被擋下時訂單狀態、操作紀錄、通知都沒有變
--   ⑩~⑬  主要服務人員本人確認:回傳只有 {id, status}(不含客戶資料)、狀態變 accepted、
--          操作紀錄 actor_role=staff 與服務人員姓名、last_modified_by
--   ⑭~⑱  鈴鐺通知:商家每一位管理員各一筆(target_type admin、target_id=merchant_admins.id)、
--          客服 / 服務人員 / 別家管理員沒收到、文字內容(含客戶姓名、不含電話地址)、管理員透過 RLS 看得到
--   ⑲~㉑  非待確認:已確認再按一次、已取消、已完成都擋下
--   ㉒~㉔  user_notifications CHECK 放寬只多 booking_confirmed;權限 ACL / SECURITY DEFINER / search_path
--   ㉕     沒有呼叫任何 LINE / 推播(push_notification_log、line 記錄都沒有新列)
begin;

select plan(26);

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
  ('f9774000-0000-4000-8000-000000000001', 'pgtap-r977d-admin1@test.local'),
  ('f9774000-0000-4000-8000-000000000002', 'pgtap-r977d-admin2@test.local'),
  ('f9774000-0000-4000-8000-000000000003', 'pgtap-r977d-agent@test.local'),
  ('f9774000-0000-4000-8000-000000000004', 'pgtap-r977d-primary@test.local'),
  ('f9774000-0000-4000-8000-000000000005', 'pgtap-r977d-assistant@test.local'),
  ('f9774000-0000-4000-8000-000000000006', 'pgtap-r977d-other@test.local'),
  ('f9774000-0000-4000-8000-000000000007', 'pgtap-r977d-removed@test.local'),
  ('f9774000-0000-4000-8000-000000000008', 'pgtap-r977d-nocal@test.local'),
  ('f9774000-0000-4000-8000-000000000009', 'pgtap-r977d-adminB@test.local'),
  ('f9774000-0000-4000-8000-000000000010', 'pgtap-r977d-staffB@test.local'),
  ('f9774000-0000-4000-8000-000000000011', 'pgtap-r977d-invited@test.local'),
  ('f9774000-0000-4000-8000-000000000014', 'pgtap-r977d-ex-assistant@test.local');

insert into groups (id) values
  ('f9774000-0000-4000-8000-000000000012'),
  ('f9774000-0000-4000-8000-000000000013');
insert into merchants (id, group_id, name, industry_type) values
  ('f9774000-0000-4000-8000-000000000020', 'f9774000-0000-4000-8000-000000000012', '#977 接單確認 A 店', 'on_site_dispatch'),
  ('f9774000-0000-4000-8000-000000000021', 'f9774000-0000-4000-8000-000000000013', '#977 接單確認 B 店', 'on_site_dispatch');
insert into merchant_admins (id, merchant_id, user_id) values
  ('f9774000-0000-4000-8000-000000000025', 'f9774000-0000-4000-8000-000000000020', 'f9774000-0000-4000-8000-000000000001'),
  ('f9774000-0000-4000-8000-000000000026', 'f9774000-0000-4000-8000-000000000020', 'f9774000-0000-4000-8000-000000000002'),
  ('f9774000-0000-4000-8000-000000000027', 'f9774000-0000-4000-8000-000000000021', 'f9774000-0000-4000-8000-000000000009');
insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('f9774000-0000-4000-8000-000000000028', 'f9774000-0000-4000-8000-000000000020', 'f9774000-0000-4000-8000-000000000003', '客服甲', 'pgtap-r977d-agent@test.local', 'active', now(), '0900977428');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('f9774000-0000-4000-8000-000000000028', 'orders', true);

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('f9774000-0000-4000-8000-000000000030', 'f9774000-0000-4000-8000-000000000020', '到府服務', 800, 'primary', 60),
  ('f9774000-0000-4000-8000-000000000031', 'f9774000-0000-4000-8000-000000000021', '到府服務', 800, 'primary', 60);
insert into payment_methods (id, merchant_id, name) values
  ('f9774000-0000-4000-8000-000000000050', 'f9774000-0000-4000-8000-000000000020', '現金'),
  ('f9774000-0000-4000-8000-000000000051', 'f9774000-0000-4000-8000-000000000021', '現金');

-- 服務人員(都開「後台無時段限制」⇒ 建單不用布置時段)。
--   40 主要甲(本人)/ 41 協助乙 / 42 別人丙 / 43 已移除丁 / 44 行事曆關閉戊 / 45 未開通登入己 / 46 B 店庚
insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, unlimited_backend_edit, phone) values
  ('f9774000-0000-4000-8000-000000000040', 'f9774000-0000-4000-8000-000000000020', 'f9774000-0000-4000-8000-000000000004', '主要甲', 'piece_rate', 'active', 'active', now(), true, '0900977440'),
  ('f9774000-0000-4000-8000-000000000041', 'f9774000-0000-4000-8000-000000000020', 'f9774000-0000-4000-8000-000000000005', '協助乙', 'piece_rate', 'active', 'active', now(), true, '0900977441'),
  ('f9774000-0000-4000-8000-000000000042', 'f9774000-0000-4000-8000-000000000020', 'f9774000-0000-4000-8000-000000000006', '別人丙', 'piece_rate', 'active', 'active', now(), true, '0900977442'),
  ('f9774000-0000-4000-8000-000000000043', 'f9774000-0000-4000-8000-000000000020', 'f9774000-0000-4000-8000-000000000007', '移除丁', 'piece_rate', 'active', 'active', now(), true, '0900977443'),
  ('f9774000-0000-4000-8000-000000000044', 'f9774000-0000-4000-8000-000000000020', 'f9774000-0000-4000-8000-000000000008', '無行事曆戊', 'piece_rate', 'active', 'active', now(), true, '0900977444'),
  ('f9774000-0000-4000-8000-000000000045', 'f9774000-0000-4000-8000-000000000020', 'f9774000-0000-4000-8000-000000000011', '未開通己', 'piece_rate', 'active', 'active', now(), true, '0900977445'),
  ('f9774000-0000-4000-8000-000000000046', 'f9774000-0000-4000-8000-000000000021', 'f9774000-0000-4000-8000-000000000010', 'B店庚', 'piece_rate', 'active', 'active', now(), true, '0900977446'),
  ('f9774000-0000-4000-8000-000000000047', 'f9774000-0000-4000-8000-000000000020', 'f9774000-0000-4000-8000-000000000014', '前協助辛', 'piece_rate', 'active', 'active', now(), true, '0900977447');
insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('f9774000-0000-4000-8000-000000000040', 'staff_calendar_view', true),
  ('f9774000-0000-4000-8000-000000000041', 'staff_calendar_view', true),
  ('f9774000-0000-4000-8000-000000000042', 'staff_calendar_view', true),
  ('f9774000-0000-4000-8000-000000000043', 'staff_calendar_view', true),
  ('f9774000-0000-4000-8000-000000000044', 'staff_calendar_view', false),
  ('f9774000-0000-4000-8000-000000000045', 'staff_calendar_view', true),
  ('f9774000-0000-4000-8000-000000000046', 'staff_calendar_view', true),
  ('f9774000-0000-4000-8000-000000000047', 'staff_calendar_view', true);

-- 建單(管理員 1)。
create function pg_temp.mk(p_staff uuid, p_start timestamptz, p_assistants uuid[] default '{}')
returns uuid language sql as $$
  select id from public.create_booking(
    p_merchant_id => 'f9774000-0000-4000-8000-000000000020',
    p_staff_id => p_staff,
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9774000-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
    p_start_at => p_start,
    p_customer_name => '陳小美',
    p_customer_phone => '0955977400',
    p_customer_address => '台北市保密路 9 號',
    p_assistant_staff_ids => p_assistants,
    p_payment_method_id => 'f9774000-0000-4000-8000-000000000050'
  );
$$;
grant execute on function pg_temp.mk(uuid, timestamptz, uuid[]) to authenticated;

select pg_temp.test_set_auth('f9774000-0000-4000-8000-000000000001');
select pg_temp.mk('f9774000-0000-4000-8000-000000000040', '2026-11-12 14:00:00+08', array['f9774000-0000-4000-8000-000000000041'::uuid, 'f9774000-0000-4000-8000-000000000047'::uuid]) as id \gset b1_
select pg_temp.mk('f9774000-0000-4000-8000-000000000043', '2026-11-12 10:00:00+08') as id \gset b4_
select pg_temp.mk('f9774000-0000-4000-8000-000000000044', '2026-11-12 10:00:00+08') as id \gset b5_
select pg_temp.mk('f9774000-0000-4000-8000-000000000045', '2026-11-12 10:00:00+08') as id \gset b6_
select pg_temp.mk('f9774000-0000-4000-8000-000000000040', '2026-11-13 10:00:00+08') as id \gset bc_
select pg_temp.mk('f9774000-0000-4000-8000-000000000040', '2026-11-14 10:00:00+08') as id \gset bd_
select id from public.cancel_booking(:'bc_id'::uuid) \gset ignore_
select id from public.confirm_booking(:'bd_id'::uuid) \gset ignore_
select id from public.complete_booking(:'bd_id'::uuid) \gset ignore_
select pg_temp.test_clear_auth();

-- 事後把丁改成已移除、己改成未開通登入(建單時要在職,才排得進去)。
update merchant_staff set status = 'removed' where id = 'f9774000-0000-4000-8000-000000000043';
update merchant_staff set login_status = 'invited' where id = 'f9774000-0000-4000-8000-000000000045';
-- 辛:建單時是 b1 的協助人員,事後被移除(前協助人員)。
update merchant_staff set status = 'removed' where id = 'f9774000-0000-4000-8000-000000000047';

-- 擋下情境前的基準。
create temp table r977d_base on commit drop as
  select
    (select count(*) from booking_status_change_logs where booking_id = :'b1_id'::uuid) as logs,
    (select count(*) from user_notifications) as notes;
grant select on r977d_base to authenticated;

-- =========================================================================
-- ①~⑨ 擋下
-- =========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '', true);
select throws_ok(
  format('select public.staff_confirm_booking(%L)', :'b1_id'),
  '42501', '請先登入',
  '① 未登入(沒有 auth.uid())⇒ 擋下'
);
reset role;
select ok(
  not has_function_privilege('anon', 'public.staff_confirm_booking(uuid)', 'execute'),
  '② anon 沒有 EXECUTE(未登入的瀏覽器直接打 RPC 也進不來)'
);

select pg_temp.test_set_auth('f9774000-0000-4000-8000-000000000005');
select throws_ok(
  format('select public.staff_confirm_booking(%L)', :'b1_id'),
  '42501', '只有這筆訂單的主要服務人員可以確認接單',
  '③ 協助人員不能確認(主腦裁決 ①)'
);
select pg_temp.test_set_auth('f9774000-0000-4000-8000-000000000014');
select throws_ok(
  format('select public.staff_confirm_booking(%L)', :'b1_id'),
  '42501', '沒有權限確認這筆訂單',
  '③-2 已移除的前協助人員 ⇒「沒有權限確認這筆訂單」(不透露這張單存在)'
);
select pg_temp.test_set_auth('f9774000-0000-4000-8000-000000000006');
select throws_ok(
  format('select public.staff_confirm_booking(%L)', :'b1_id'),
  '42501', '沒有權限確認這筆訂單',
  '④ 同店別的服務人員不能確認別人的單'
);
select pg_temp.test_set_auth('f9774000-0000-4000-8000-000000000010');
select throws_ok(
  format('select public.staff_confirm_booking(%L)', :'b1_id'),
  '42501', '沒有權限確認這筆訂單',
  '⑤ 別家商家的服務人員不能確認'
);
select pg_temp.test_set_auth('f9774000-0000-4000-8000-000000000009');
select throws_ok(
  format('select public.staff_confirm_booking(%L)', :'b1_id'),
  '42501', '沒有權限確認這筆訂單',
  '⑥ 別家商家管理員(不是服務人員)也不能用這支確認'
);
select pg_temp.test_set_auth('f9774000-0000-4000-8000-000000000007');
select throws_ok(
  format('select public.staff_confirm_booking(%L)', :'b4_id'),
  '42501', '沒有權限確認這筆訂單',
  '⑦ 已移除的服務人員不能確認自己名下的單'
);
select pg_temp.test_set_auth('f9774000-0000-4000-8000-000000000011');
select throws_ok(
  format('select public.staff_confirm_booking(%L)', :'b6_id'),
  '42501', '沒有權限確認這筆訂單',
  '⑧ 未開通登入(login_status 不是 active)的服務人員不能確認'
);
select pg_temp.test_set_auth('f9774000-0000-4000-8000-000000000008');
select throws_ok(
  format('select public.staff_confirm_booking(%L)', :'b5_id'),
  '42501', '沒有權限確認這筆訂單',
  '⑨ 「行事曆檢視」權限關閉的服務人員不能確認'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑩~⑬ 本人確認
-- =========================================================================
select is(
  (select jsonb_build_object(
     'b1', (select status from bookings where id = :'b1_id'::uuid),
     'b4', (select status from bookings where id = :'b4_id'::uuid),
     'b5', (select status from bookings where id = :'b5_id'::uuid),
     'b6', (select status from bookings where id = :'b6_id'::uuid),
     'logs_same', (select count(*) from booking_status_change_logs where booking_id = :'b1_id'::uuid) = (select logs from r977d_base),
     'notes_same', (select count(*) from user_notifications) = (select notes from r977d_base))),
  '{"b1": "pending_confirmation", "b4": "pending_confirmation", "b5": "pending_confirmation", "b6": "pending_confirmation", "logs_same": true, "notes_same": true}'::jsonb,
  '⑩ 上面所有被擋下的呼叫:訂單狀態、操作紀錄、通知都沒有任何變化'
);

select pg_temp.test_set_auth('f9774000-0000-4000-8000-000000000004');
select is(
  public.staff_confirm_booking(:'b1_id'::uuid),
  jsonb_build_object('id', :'b1_id'::uuid, 'status', 'accepted'),
  '⑪ 主要服務人員本人確認成功;回傳只有 id 與 status(不回傳客戶電話 / 地址等整列資料)'
);
select pg_temp.test_clear_auth();

select is(
  (select row(status, last_modified_by_user_id)::text from bookings where id = :'b1_id'::uuid),
  row('accepted', 'f9774000-0000-4000-8000-000000000004'::uuid)::text,
  '⑫ 訂單變成 accepted(畫面「已確認」),最後修改人是這位服務人員'
);
select is(
  (select jsonb_build_object('from', from_status, 'to', to_status, 'role', actor_role_snapshot,
                             'name', actor_name_snapshot, 'uid', actor_user_id)
   from booking_status_change_logs where booking_id = :'b1_id'::uuid and to_status = 'accepted'),
  jsonb_build_object('from', 'pending_confirmation', 'to', 'accepted', 'role', 'staff',
                     'name', '主要甲', 'uid', 'f9774000-0000-4000-8000-000000000004'),
  '⑬ 操作紀錄:待確認 → 已確認、角色 staff、姓名是服務人員本人(不會被記成客服 / 已移除的人員)'
);

-- =========================================================================
-- ⑭~⑱ 鈴鐺通知
-- =========================================================================
select is(
  (select array_agg(row(user_id, target_type, target_id, merchant_id)::text order by user_id::text)
   from user_notifications where booking_id = :'b1_id'::uuid and event_type = 'booking_confirmed'),
  array[
    row('f9774000-0000-4000-8000-000000000001'::uuid, 'admin', 'f9774000-0000-4000-8000-000000000025'::uuid, 'f9774000-0000-4000-8000-000000000020'::uuid)::text,
    row('f9774000-0000-4000-8000-000000000002'::uuid, 'admin', 'f9774000-0000-4000-8000-000000000026'::uuid, 'f9774000-0000-4000-8000-000000000020'::uuid)::text
  ],
  '⑭ 這間商家的兩位管理員各收到一筆 booking_confirmed(target_type admin、target_id = merchant_admins.id)'
);
select is(
  (select count(*)::int from user_notifications
   where user_id in ('f9774000-0000-4000-8000-000000000003', 'f9774000-0000-4000-8000-000000000004',
                     'f9774000-0000-4000-8000-000000000005', 'f9774000-0000-4000-8000-000000000009',
                     'f9774000-0000-4000-8000-000000000014')),
  0,
  '⑮ 客服、服務人員本人、協助人員、別家管理員都沒有收到(主腦裁決 ②:只通知商家管理員)'
);
select is(
  (select distinct title || '|' || body from user_notifications where booking_id = :'b1_id'::uuid),
  '服務人員已確認訂單|服務人員「主要甲」已確認 2026/11/12 14:00「陳小美」的訂單。',
  '⑯ 通知文字:服務人員姓名、預約日期時間(台北時間)、客戶姓名'
);
select ok(
  (select bool_and(position('0955977400' in title || body) = 0 and position('保密路' in title || body) = 0)
   from user_notifications where booking_id = :'b1_id'::uuid),
  '⑰ 通知內容不含客戶電話、地址'
);
select pg_temp.test_set_auth('f9774000-0000-4000-8000-000000000002');
select is(
  (select count(*)::int from user_notifications where event_type = 'booking_confirmed' and read_at is null),
  1,
  '⑱ 管理員 2 透過 RLS 只看得到自己那一筆未讀(鈴鐺紅點會 +1)'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑲~㉑ 非待確認
-- =========================================================================
select pg_temp.test_set_auth('f9774000-0000-4000-8000-000000000004');
select throws_ok(
  format('select public.staff_confirm_booking(%L)', :'b1_id'),
  null, '這筆訂單已經不是待確認狀態，請重新整理',
  '⑲ 已確認的單再按一次 ⇒ 清楚的中文錯誤(不會重複寫紀錄 / 通知)'
);
select throws_ok(
  format('select public.staff_confirm_booking(%L)', :'bc_id'),
  null, '這筆訂單已經不是待確認狀態，請重新整理',
  '⑳ 已取消的單不能確認'
);
select throws_ok(
  format('select public.staff_confirm_booking(%L)', :'bd_id'),
  null, '這筆訂單已經不是待確認狀態，請重新整理',
  '㉑ 已完成的單不能確認'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ㉒~㉕ CHECK、權限、沒有 LINE / 推播
-- =========================================================================
select ok(
  (select pg_get_constraintdef(oid) like '%booking_confirmed%'
          and pg_get_constraintdef(oid) like '%booking_reminder_next_day%'
          and pg_get_constraintdef(oid) not like '%test%'
   from pg_constraint where conname = 'user_notifications_event_type_check'),
  '㉒ user_notifications 事件 CHECK 多了 booking_confirmed,原本四種都在,仍然不收 test'
);
select is(
  (select array_to_string(proacl, ' ') from pg_proc where oid = 'public.staff_confirm_booking(uuid)'::regprocedure),
  'postgres=X/postgres authenticated=X/postgres service_role=X/postgres',
  '㉓ staff_confirm_booking 的 ACL:沒有 PUBLIC / anon,只給 authenticated 與 service_role'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=public'] from pg_proc
   where oid = 'public.staff_confirm_booking(uuid)'::regprocedure),
  '㉔ SECURITY DEFINER 且固定 search_path'
);
select is(
  (select (select count(*) from push_notification_log where booking_id = :'b1_id'::uuid)
        + (select count(*) from line_notification_log where booking_id = :'b1_id'::uuid)
        + (select count(*) from user_notifications where booking_id = :'b1_id'::uuid and event_type <> 'booking_confirmed'))::int,
  0,
  '㉕ 確認接單沒有產生任何推播 / LINE 紀錄或其他事件的通知(不發 LINE / 推播)'
);

select * from finish();

rollback;
