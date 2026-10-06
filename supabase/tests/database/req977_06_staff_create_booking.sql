-- SPECS-INDEX #977 第 7 批(2026-10-07):服務人員新增編輯訂單 — pgTAP ②:建單、選項、時間清單、紅利預覽
-- migration 20261007100100_req977_staff_order_rpcs.sql
-- 規格書 .project/specs/服務人員新增編輯訂單-第7批.md 第三節 3-3、3-4 ①,第六節 6-1。
--
--   ①~⑥    staff_get_booking_form_options:回傳 key 清單、只有本店上架項目 / 付款方式、不含客戶資料;
--            顯示會員資料關 / 未登入 / 拿別人的 staff id 一律擋
--   ⑦~⑲    staff_create_booking:回傳 key 清單(沒有 notes)、主要服務人員 = 自己、0 位協助人員、
--            created_by_role = staff、待確認、會員依電話自動建立、操作紀錄 staff + 姓名、標記已清掉;
--            直接接單開 ⇒ accepted;同一支電話第二次 ⇒ 連到既有會員(不再新建)
--   ⑳~㉗   staff_create_booking 擋下:未登入、anon 沒有 EXECUTE、別人的 staff id、別家的 staff id、
--            已移除、未開通登入、行事曆關、新增編輯訂單關、顯示會員資料關(9 種情境,合併成 8 條)
--   ㉘~㉛   staff_list_my_bookable_start_times:本人可以查、標記已清掉;排除別人的單 / 顯示會員資料關 ⇒ 擋
--   ㉜~㉟   staff_preview_booking_points:新增模式、編輯自己的單可以;別人的單 / 顯示會員資料關 ⇒ 擋
begin;

select plan(35);

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

create function pg_temp.smk(p_staff uuid, p_start timestamptz, p_phone text default '0955977711')
returns jsonb language sql as $$
  select public.staff_create_booking(
    p_staff_id => p_staff,
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9777000-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
    p_start_at => p_start,
    p_customer_name => '自建客人',
    p_customer_phone => p_phone,
    p_customer_address => '新北市自建路 1 號',
    p_notes => '服務人員自己寫的內部備註',
    p_customer_notes => '有養狗',
    p_payment_method_id => 'f9777000-0000-4000-8000-000000000050'
  );
$$;
grant execute on function pg_temp.smk(uuid, timestamptz, text) to authenticated;

-- 丙的一張單(給「排除別人的單」「預覽別人的單」用)、甲的一張單(編輯模式預覽)。
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000001');
select pg_temp.mk('f9777000-0000-4000-8000-000000000042', '2036-04-01 10:00:00+08') as id \gset bbing_
select pg_temp.mk('f9777000-0000-4000-8000-000000000040', '2036-04-01 15:00:00+08') as id \gset bjia_
select pg_temp.test_clear_auth();
update merchant_staff set status = 'removed' where id = 'f9777000-0000-4000-8000-000000000043';
update merchant_staff set login_status = 'invited' where id = 'f9777000-0000-4000-8000-000000000045';

-- =========================================================================
-- ①~⑥ staff_get_booking_form_options
-- =========================================================================
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
create temp table r977h_opt on commit drop as
  select public.staff_get_booking_form_options('f9777000-0000-4000-8000-000000000040') as o;
grant select on r977h_opt to authenticated;
select is(
  (select array_agg(k order by k) from r977h_opt, jsonb_object_keys(o) k),
  array['business_hours','industry_type','payment_methods','service_categories','service_items','staff_id','staff_name','tax_settings'],
  '① 選項回傳的 key 清單(沒有客戶 / 會員 / 其他服務人員 / 料錢)'
);
select is(
  (select string_agg(e ->> 'name', ',' order by e ->> 'name') from r977h_opt, jsonb_array_elements(o -> 'service_items') e),
  '到府服務,加購清潔',
  '② 只有本店上架中的服務項目(B 店的不在裡面)'
);
select is(
  (select jsonb_array_length(o -> 'payment_methods') || '/' || (o ->> 'staff_name') || '/' || jsonb_array_length(o -> 'business_hours')
   from r977h_opt),
  '2/甲服務人員/7',
  '③ 本店 2 種付款方式、自己的姓名、7 天營業時間'
);
select ok(
  (select o::text not like '%林小姐%' and o::text not like '%0955977700%' and o::text not like '%丙服務人員%' from r977h_opt),
  '④ 不含任何客戶資料與其他服務人員'
);
select throws_ok(
  $$select public.staff_get_booking_form_options('f9777000-0000-4000-8000-000000000042')$$,
  '42501', '沒有權限新增或編輯預約', '⑤ 甲拿丙的 staff id ⇒ 擋'
);
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000013');
select throws_ok(
  $$select public.staff_get_booking_form_options('f9777000-0000-4000-8000-000000000048')$$,
  '42501', '沒有權限新增或編輯預約', '⑥ 壬(顯示會員資料關)⇒ 擋'
);

-- =========================================================================
-- ⑦~⑲ staff_create_booking 本人
-- =========================================================================
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
create temp table r977h_c1 on commit drop as
  select pg_temp.smk('f9777000-0000-4000-8000-000000000040', '2036-04-02 10:00:00+08') as r,
         current_setting('miaoyue.staff_order_actor', true) as marker_after;
grant select on r977h_c1 to authenticated;
select pg_temp.test_clear_auth();
select (r ->> 'id') as id from r977h_c1 \gset c1_

select is(
  (select array_agg(k order by k) from r977h_c1, jsonb_object_keys(r) k),
  array['final_amount_snapshot','id','member_auto_created','member_id','member_name_snapshot','merchant_id','points_planned','points_redeem_amount_snapshot','points_redeemed','status'],
  '⑦ 回傳只有成功提示要用的 10 個 key(沒有 notes、電話、地址)'
);
select is((select marker_after from r977h_c1), '', '⑧ 包裝 RPC 呼叫完,同一交易內的標記已清掉');
select is((select staff_id::text from bookings where id = :'c1_id'::uuid), 'f9777000-0000-4000-8000-000000000040', '⑨ 主要服務人員 = 自己');
select is((select count(*)::int from booking_assistants where booking_id = :'c1_id'::uuid), 0, '⑩ 協助人員 0 位');
select is((select created_by_role from bookings where id = :'c1_id'::uuid), 'staff', '⑪ created_by_role = staff');
select is((select status from bookings where id = :'c1_id'::uuid), 'pending_confirmation', '⑫ 沒開「商家後台確認後直接接單」⇒ 待確認');
select is(
  (select (member_id is not null)::text || '/' || member_auto_created::text from bookings where id = :'c1_id'::uuid),
  'true/true',
  '⑬ 新電話 ⇒ 依電話自動建立會員(跟後台新增模式一樣)'
);
select is(
  (select actor_role_snapshot || '/' || actor_name_snapshot || '/' || to_status from booking_status_change_logs where booking_id = :'c1_id'::uuid),
  'staff/甲服務人員/pending_confirmation',
  '⑭ 操作紀錄:角色 staff、姓名 = 服務人員姓名'
);
select is(
  (select hide_notes_from_staff::text || '/' || notes || '/' || created_by_user_id::text from bookings where id = :'c1_id'::uuid),
  'false/服務人員自己寫的內部備註/f9777000-0000-4000-8000-000000000004',
  '⑮ 內部備註照存、不隱藏;建立者 = 甲的 user id'
);
select is(
  (select count(*)::int from booking_material_costs where booking_id = :'c1_id'::uuid),
  0,
  '⑯ 料錢 0 筆(主腦決定 C:服務人員模式不帶料錢)'
);

update merchant_staff set direct_accept_after_merchant_confirm = true where id = 'f9777000-0000-4000-8000-000000000040';
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
select (pg_temp.smk('f9777000-0000-4000-8000-000000000040', '2036-04-03 10:00:00+08') ->> 'id') as id \gset c2_
select pg_temp.test_clear_auth();
select is(
  (select b.status || '/' || l.to_status from bookings b join booking_status_change_logs l on l.booking_id = b.id where b.id = :'c2_id'::uuid),
  'accepted/accepted',
  '⑰ 開了「商家後台確認後直接接單」⇒ 直接已確認(裁決 5,跟後台同一套)'
);
select is(
  (select member_id from bookings where id = :'c2_id'::uuid),
  (select member_id from bookings where id = :'c1_id'::uuid),
  '⑱ 同一支電話第二次 ⇒ 連到同一位會員'
);
select is(
  (select member_auto_created::text from bookings where id = :'c2_id'::uuid),
  'false',
  '⑲ 第二次是「連結既有會員」,不是新建'
);
update merchant_staff set direct_accept_after_merchant_confirm = false where id = 'f9777000-0000-4000-8000-000000000040';

-- =========================================================================
-- ⑳~㉗ staff_create_booking 擋下
-- =========================================================================
set local role authenticated;
select set_config('request.jwt.claims', '', true);
select throws_ok(
  $$select pg_temp.smk('f9777000-0000-4000-8000-000000000040', '2036-04-04 10:00:00+08')$$,
  '42501', '請先登入', '⑳ 未登入 ⇒ 請先登入'
);
reset role;
select ok(
  not has_function_privilege('anon', 'public.staff_create_booking(uuid, jsonb, timestamptz, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.staff_create_booking(uuid, jsonb, timestamptz, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, uuid)', 'execute'),
  '㉑ anon 沒有 EXECUTE(正向對照:authenticated 有)'
);
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
select throws_ok(
  $$select pg_temp.smk('f9777000-0000-4000-8000-000000000042', '2036-04-04 10:00:00+08')$$,
  '42501', '沒有權限新增預約', '㉒ 甲拿丙的 staff id 建單(幫別人建)⇒ 擋'
);
select throws_ok(
  $$select pg_temp.smk('f9777000-0000-4000-8000-000000000046', '2036-04-04 10:00:00+08')$$,
  '42501', '沒有權限新增預約', '㉓ 甲拿 B 店庚的 staff id ⇒ 擋'
);
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000007');
select throws_ok(
  $$select pg_temp.smk('f9777000-0000-4000-8000-000000000043', '2036-04-04 10:00:00+08')$$,
  '42501', '沒有權限新增預約', '㉔ 已移除的丁 ⇒ 擋'
);
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000011');
select throws_ok(
  $$select pg_temp.smk('f9777000-0000-4000-8000-000000000045', '2036-04-04 10:00:00+08')$$,
  '42501', '沒有權限新增預約', '㉕ 未開通登入的己 ⇒ 擋'
);
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000008');
select throws_ok(
  $$select pg_temp.smk('f9777000-0000-4000-8000-000000000044', '2036-04-04 10:00:00+08')$$,
  '42501', '沒有權限新增預約', '㉖ 行事曆檢視關的戊 ⇒ 擋'
);
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000012');
select throws_ok(
  $$select pg_temp.smk('f9777000-0000-4000-8000-000000000047', '2036-04-04 10:00:00+08')$$,
  '42501', '沒有權限新增預約', '㉗ 新增編輯訂單關的辛 ⇒ 擋(顯示會員資料關的壬見 ㉚ / ㉟)'
);

-- =========================================================================
-- ㉘~㉛ staff_list_my_bookable_start_times
-- =========================================================================
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
create temp table r977h_t on commit drop as
  select public.staff_list_my_bookable_start_times('f9777000-0000-4000-8000-000000000040', '2036-04-08', 60) as t,
         current_setting('miaoyue.staff_order_actor', true) as marker_after;
grant select on r977h_t to authenticated;
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000001');
create temp table r977h_t_admin on commit drop as
  select public.list_staff_bookable_start_times('f9777000-0000-4000-8000-000000000020',
    'f9777000-0000-4000-8000-000000000040', '2036-04-08', 60) as t;
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
select ok(
  (select cardinality(s.t) > 0 and s.t = a.t from r977h_t s, r977h_t_admin a),
  '㉘ 甲查自己這天能約的起點 = 管理員用 list_staff_bookable_start_times 查的結果(同一份邏輯,非空)'
);
select is((select marker_after from r977h_t), '', '㉙ 查完標記已清掉');
select throws_ok(
  format($$select public.staff_list_my_bookable_start_times('f9777000-0000-4000-8000-000000000040', '2036-04-01', 60, %L)$$, :'bbing_id'),
  '42501', '沒有權限操作這筆訂單', '㉚ 排除的訂單是丙的 ⇒ 擋'
);
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000013');
select throws_ok(
  $$select public.staff_list_my_bookable_start_times('f9777000-0000-4000-8000-000000000048', '2036-04-08', 60)$$,
  '42501', '沒有權限新增或編輯預約', '㉛ 顯示會員資料關的壬 ⇒ 擋'
);

-- =========================================================================
-- ㉜~㉟ staff_preview_booking_points
-- =========================================================================
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
select ok(
  public.staff_preview_booking_points('f9777000-0000-4000-8000-000000000040', null, '0955977711',
    jsonb_build_array(jsonb_build_object('service_item_id','f9777000-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
    false, null, false, null, null, false, null, null) ? 'feature_enabled',
  '㉜ 新增模式預覽可以用(會員由後端依電話決定)'
);
select ok(
  public.staff_preview_booking_points('f9777000-0000-4000-8000-000000000040', :'bjia_id'::uuid, '0955977700',
    jsonb_build_array(jsonb_build_object('service_item_id','f9777000-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
    false, null, false, null, null, false, null, null) ? 'feature_enabled',
  '㉝ 編輯自己的單預覽可以用'
);
select throws_ok(
  format($$select public.staff_preview_booking_points('f9777000-0000-4000-8000-000000000040', %L, '0955977700',
    jsonb_build_array(jsonb_build_object('service_item_id','f9777000-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
    false, null, false, null, null, false, null, null)$$, :'bbing_id'),
  '42501', '沒有權限操作這筆訂單', '㉞ 預覽丙的單 ⇒ 擋'
);
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000013');
select throws_ok(
  $$select public.staff_preview_booking_points('f9777000-0000-4000-8000-000000000048', null, '0955977711',
    jsonb_build_array(jsonb_build_object('service_item_id','f9777000-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
    false, null, false, null, null, false, null, null)$$,
  '42501', '沒有權限新增或編輯預約', '㉟ 顯示會員資料關的壬 ⇒ 擋'
);
select pg_temp.test_clear_auth();

select * from finish();
rollback;
