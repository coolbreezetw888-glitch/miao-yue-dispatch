-- SPECS-INDEX #977 第 7 批(2026-10-07):服務人員新增編輯訂單 — pgTAP ④:拖拉改時間、開關自己的時段
-- migration 20261007100100_req977_staff_order_rpcs.sql
-- 規格書 .project/specs/服務人員新增編輯訂單-第7批.md 第三節 3-4 ⑤⑥,第六節 6-1。
--
--   ①~⑦    staff_move_booking 本人:回傳 key 清單(booking 只有 id / merchant_id)、只改時間、
--            主要服務人員與協助人員不變、最後修改者 = 甲、標記已清掉;簽章只有 3 個參數(沒有轉派的路)
--   ⑧~⑫    staff_move_booking 擋下:畫面過期 40001、協助人員、別人的單、已完成、開關關
--   ⑬~㉑    staff_set_my_slot(方案 B2,使用者 2026-10-07 裁決):月薪制即使開了新增編輯訂單仍不能開關時段;
--            按件計酬 + 排班自助 + 可以自己下單 ⇒ 可以關 / 開自己的時段,有既有預約時回傳衝突筆數(只提示不擋);
--            別人的 staff id、沒有排班自助、顯示會員資料關、未登入擋
begin;

select plan(21);

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
select pg_temp.mk('f9777000-0000-4000-8000-000000000040', '2036-06-01 10:00:00+08',
  array['f9777000-0000-4000-8000-000000000041'::uuid]) as id \gset b1_
select pg_temp.mk('f9777000-0000-4000-8000-000000000042', '2036-06-01 10:00:00+08') as id \gset b3_
select pg_temp.mk('f9777000-0000-4000-8000-000000000040', '2036-06-02 10:00:00+08') as id \gset b4_
select id from public.confirm_booking(:'b4_id'::uuid) \gset ignore_
select id from public.complete_booking(:'b4_id'::uuid) \gset ignore_
select pg_temp.test_clear_auth();

-- =========================================================================
-- ①~⑦ staff_move_booking 本人
-- =========================================================================
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
create temp table r977j_m on commit drop as
  select public.staff_move_booking(:'b1_id'::uuid, '2036-06-01 11:00:00+08', '2036-06-01 10:00:00+08') as r,
         current_setting('miaoyue.staff_order_actor', true) as marker_after;
select pg_temp.test_clear_auth();

select is(
  (select array_agg(k order by k) from r977j_m, jsonb_object_keys(r) k),
  array['booking','mode','next','previous','staff_changed','time_changed'],
  '① 回傳的頂層 key'
);
select is(
  (select array_agg(k order by k) from r977j_m, jsonb_object_keys(r -> 'booking') k),
  array['id','merchant_id'],
  '② booking 只有 id / merchant_id(不把整列訂單原樣丟出去)'
);
select is(
  (select (r ->> 'mode') || '/' || (r ->> 'time_changed') || '/' || (r ->> 'staff_changed') || '/' || (r -> 'next' ->> 'staff_id') from r977j_m),
  'time/true/false/f9777000-0000-4000-8000-000000000040',
  '③ 模式 = 只改時間,服務人員沒變'
);
select is(
  (select to_char(start_at at time zone 'Asia/Taipei', 'HH24:MI') || '/' || staff_id::text || '/' || last_modified_by_user_id::text from bookings where id = :'b1_id'::uuid),
  '11:00/f9777000-0000-4000-8000-000000000040/f9777000-0000-4000-8000-000000000004',
  '④ 時間改成 11:00、主要服務人員不變、最後修改者 = 甲'
);
select is(
  (select array_agg(staff_id::text) from booking_assistants where booking_id = :'b1_id'::uuid),
  array['f9777000-0000-4000-8000-000000000041'],
  '⑤ 協助人員不變'
);
select is((select marker_after from r977j_m), '', '⑥ 呼叫完標記已清掉');
select is(
  (select pronargs::int from pg_proc where oid = 'public.staff_move_booking(uuid, timestamptz, timestamptz)'::regprocedure),
  3,
  '⑦ 簽章只有 訂單 / 目標時間 / 畫面上看到的時間 三個參數 ⇒ 沒有任何轉派到別人欄位的路'
);

-- =========================================================================
-- ⑧~⑫ staff_move_booking 擋下
-- =========================================================================
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
select throws_ok(
  format($$select public.staff_move_booking(%L, '2036-06-01 12:00:00+08', '2036-06-01 10:00:00+08')$$, :'b1_id'),
  '40001', NULL, '⑧ 畫面上的時間跟現況不符(別人剛改過)⇒ 40001'
);
select throws_ok(
  format($$select public.staff_move_booking(%L, '2036-06-01 12:00:00+08', '2036-06-01 10:00:00+08')$$, :'b3_id'),
  '42501', '沒有權限操作這筆訂單', '⑨ 甲拖丙的單 ⇒ 擋'
);
select throws_like(
  format($$select public.staff_move_booking(%L, '2036-06-02 12:00:00+08', '2036-06-02 10:00:00+08')$$, :'b4_id'),
  '%已完成或已取消的預約不能移動%', '⑩ 已完成的單不能拖'
);
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000005');
select throws_ok(
  format($$select public.staff_move_booking(%L, '2036-06-01 12:00:00+08', '2036-06-01 11:00:00+08')$$, :'b1_id'),
  '42501', '只有這筆訂單的主要服務人員可以移動這筆訂單', '⑪ 協助人員乙拖協助色塊 ⇒ 擋'
);
select pg_temp.test_clear_auth();
update merchant_staff set can_create_edit_orders = false where id = 'f9777000-0000-4000-8000-000000000040';
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
select throws_ok(
  format($$select public.staff_move_booking(%L, '2036-06-01 12:00:00+08', '2036-06-01 11:00:00+08')$$, :'b1_id'),
  '42501', '沒有權限操作這筆訂單', '⑫ 開關關掉 ⇒ 擋'
);
select pg_temp.test_clear_auth();
update merchant_staff set can_create_edit_orders = true where id = 'f9777000-0000-4000-8000-000000000040';

-- =========================================================================
-- ⑬~⑳ staff_set_my_slot(方案 B2:可以自己下單 + 按件計酬 + 排班自助權限)
-- =========================================================================
insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('f9777000-0000-4000-8000-000000000040', 'staff_availability_self_manage', true),
  ('f9777000-0000-4000-8000-000000000041', 'staff_availability_self_manage', true),
  ('f9777000-0000-4000-8000-000000000048', 'staff_availability_self_manage', true);

select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
select throws_ok(
  $$select public.staff_set_my_slot('f9777000-0000-4000-8000-000000000040', '2036-06-03', '14:00', '14:30', false)$$,
  '42501', '沒有權限設定這位服務人員的可預約狀態',
  '⑬ 方案 B2:甲是月薪制,就算「新增編輯訂單」與排班自助權限都開了,仍不能自己開關時段'
);
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000005');
select is(
  public.staff_set_my_slot('f9777000-0000-4000-8000-000000000041', '2036-06-03', '14:00', '14:30', false),
  0,
  '⑭ 乙(按件計酬 + 排班自助 + 可以自己下單)關掉自己的時段 ⇒ 沒有衝突回 0'
);
select pg_temp.test_clear_auth();
select is(
  (select is_available::text from staff_availability_overrides
   where staff_id = 'f9777000-0000-4000-8000-000000000041' and override_date = '2036-06-03' and slot_start_time = '14:00'),
  'false',
  '⑮ 那一格寫成單日例外關閉'
);
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000005');
select is(
  public.staff_set_my_slot('f9777000-0000-4000-8000-000000000041', '2036-06-03', '14:00', '14:30', true),
  0,
  '⑯ 再開啟 ⇒ 0'
);
select is(
  public.staff_set_my_slot('f9777000-0000-4000-8000-000000000041', '2036-06-01', '11:00', '11:30', false),
  1,
  '⑰ 關掉的時段已有一筆(他是協助人員的)預約 ⇒ 回傳 1(只提示不擋,跟商家端一樣)'
);
select throws_ok(
  $$select public.staff_set_my_slot('f9777000-0000-4000-8000-000000000042', '2036-06-03', '14:00', '14:30', false)$$,
  '42501', '沒有權限設定這位服務人員的可預約狀態', '⑱ 乙關丙的時段 ⇒ 擋'
);
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000006');
select throws_ok(
  $$select public.staff_set_my_slot('f9777000-0000-4000-8000-000000000042', '2036-06-03', '14:00', '14:30', false)$$,
  '42501', '沒有權限設定這位服務人員的可預約狀態', '⑲ 丙按件計酬但沒有排班自助權限 ⇒ 擋'
);
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000013');
select throws_ok(
  $$select public.staff_set_my_slot('f9777000-0000-4000-8000-000000000048', '2036-06-03', '14:00', '14:30', false)$$,
  '42501', '沒有權限設定這位服務人員的可預約狀態', '⑳ 壬有排班自助但顯示會員資料關 ⇒ 擋(要先能自己下單)'
);
set local role authenticated;
select set_config('request.jwt.claims', '', true);
select throws_ok(
  $$select public.staff_set_my_slot('f9777000-0000-4000-8000-000000000041', '2036-06-03', '14:00', '14:30', false)$$,
  '42501', '請先登入', '㉑ 未登入 ⇒ 請先登入'
);
reset role;

select * from finish();
rollback;
