-- SPECS-INDEX #977 第 7 批(2026-10-07):服務人員新增編輯訂單 — pgTAP ③:編輯、取消、標記完成
-- migration 20261007100100_req977_staff_order_rpcs.sql
-- 規格書 .project/specs/服務人員新增編輯訂單-第7批.md 第三節 3-3 ②、3-4 ②③④,第六節 6-1。
--
--   ①~⑨    staff_get_booking_for_edit:隱藏的內部備註不回原文(notes_hidden)、協助人員只回姓名;
--            協助人員 / 別人 / 別人的單 / 已完成 / 開關關 / 未登入 / 找不到 一律擋
--   ⑩~⑲    staff_update_booking:回傳 key 清單;協助人員原樣保留、主要服務人員不變、會員不變、
--            隱藏的內部備註原文保留(前端送什麼都不採用)、付款方式 / 金額照 update_booking 生效、
--            料錢保留原快照、最後修改者 = 甲、沒藏的備註可以改、標記已清掉
--   ⑳~㉓   staff_update_booking 擋下:協助人員、別人的單、已完成、顯示會員資料關
--   ㉔~㉘   staff_cancel_booking:協助人員 / 別人的單擋;已完成的單不能取消(方案 A1);
--            本人取消 ⇒ 已取消 + 原因 + 操作紀錄 staff;回傳 key 清單
--   ㉙~㉜   staff_complete_booking:本人 ⇒ 已完成 + 操作紀錄 staff;待確認不能完成;協助人員擋;
--            已完成訂單的還原 / 取消(管理員專用)服務人員仍被擋(方案 A1)
--   ㉝~㉞   後台不受影響:管理員取消 / 完成的操作紀錄仍是 merchant_admin
begin;

select plan(34);

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

create function pg_temp.sup(p_booking uuid, p_start timestamptz, p_notes text, p_discount numeric default null,
                            p_pm uuid default 'f9777000-0000-4000-8000-000000000052', p_name text default '林小姐(改)')
returns jsonb language sql as $$
  select public.staff_update_booking(
    p_booking_id => p_booking,
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9777000-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
    p_start_at => p_start,
    p_customer_name => p_name,
    p_customer_phone => '0955977700',
    p_customer_address => '台北市測試路 7 號',
    p_notes => p_notes,
    p_discount_enabled => p_discount is not null,
    p_discount_mode => case when p_discount is not null then 'fixed' end,
    p_discount_value => p_discount,
    p_payment_method_id => p_pm
  );
$$;
grant execute on function pg_temp.sup(uuid, timestamptz, text, numeric, uuid, text) to authenticated;

-- 布置(管理員建):
--   b1 甲主要 + 協助乙,內部備註藏起來;料錢一筆(快照 150,品項現價 200)
--   b2 甲主要,內部備註沒藏 / b3 丙主要 / b4 甲主要且已完成 / b6 甲主要已確認 / b7 甲主要已確認 + 協助乙
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000001');
select pg_temp.mk('f9777000-0000-4000-8000-000000000040', '2036-05-01 10:00:00+08',
  array['f9777000-0000-4000-8000-000000000041'::uuid], '機密備註', true) as id \gset b1_
select pg_temp.mk('f9777000-0000-4000-8000-000000000040', '2036-05-02 10:00:00+08', '{}', '一般備註', false) as id \gset b2_
select pg_temp.mk('f9777000-0000-4000-8000-000000000042', '2036-05-01 10:00:00+08') as id \gset b3_
select pg_temp.mk('f9777000-0000-4000-8000-000000000040', '2036-05-03 10:00:00+08') as id \gset b4_
select pg_temp.mk('f9777000-0000-4000-8000-000000000040', '2036-05-04 10:00:00+08') as id \gset b6_
select pg_temp.mk('f9777000-0000-4000-8000-000000000040', '2036-05-05 10:00:00+08',
  array['f9777000-0000-4000-8000-000000000041'::uuid]) as id \gset b7_
select pg_temp.mk('f9777000-0000-4000-8000-000000000042', '2036-05-06 10:00:00+08') as id \gset b8_
select pg_temp.mk('f9777000-0000-4000-8000-000000000042', '2036-05-07 10:00:00+08') as id \gset b9_
select id from public.confirm_booking(:'b4_id'::uuid) \gset ignore_
select id from public.complete_booking(:'b4_id'::uuid) \gset ignore_
select id from public.confirm_booking(:'b6_id'::uuid) \gset ignore_
select id from public.confirm_booking(:'b7_id'::uuid) \gset ignore_
select id from public.confirm_booking(:'b9_id'::uuid) \gset ignore_
select pg_temp.test_clear_auth();
insert into merchant_feature_flags (merchant_id, feature_key, enabled)
values ('f9777000-0000-4000-8000-000000000020', 'material_cost_enabled', true);
insert into booking_material_costs (booking_id, material_cost_item_id, amount_snapshot)
values (:'b1_id'::uuid, 'f9777000-0000-4000-8000-000000000055', 150);

create temp table r977i_before on commit drop as
  select member_id, hide_notes_from_staff, notes from bookings where id = :'b1_id'::uuid;

-- =========================================================================
-- ①~⑨ staff_get_booking_for_edit
-- =========================================================================
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
create temp table r977i_e1 on commit drop as select public.staff_get_booking_for_edit(:'b1_id'::uuid) as o;
create temp table r977i_e2 on commit drop as select public.staff_get_booking_for_edit(:'b2_id'::uuid) as o;
select is(
  (select coalesce(o ->> 'notes', 'NULL') || '/' || (o ->> 'notes_hidden') || '/' || (o -> 'assistant_names')::text
          || '/' || (o::text like '%機密備註%')::text || '/' || (o ? 'hide_notes_from_staff')::text from r977i_e1),
  'NULL/true/["乙服務人員"]/false/false',
  '① 內部備註被藏起來 ⇒ notes = null、notes_hidden = true、回應裡完全沒有原文;協助人員只回姓名'
);
select is(
  (select (o ->> 'notes') || '/' || (o ->> 'notes_hidden') || '/' || jsonb_array_length(o -> 'service_items') from r977i_e2),
  '一般備註/false/1',
  '② 沒藏的內部備註照常回傳;服務項目 1 筆'
);
select throws_ok(format('select public.staff_get_booking_for_edit(%L)', :'b3_id'), '42501', '沒有權限操作這筆訂單', '③ 甲讀丙的單 ⇒ 擋');
select throws_ok(format('select public.staff_get_booking_for_edit(%L)', :'b4_id'), NULL, '已完成或已取消的預約不能編輯，請重新整理', '④ 已完成的單不能編輯');
select throws_ok($$select public.staff_get_booking_for_edit('f9777000-0000-4000-8000-0000000009ff')$$, '42501', '沒有權限操作這筆訂單', '⑤ 找不到的訂單 ⇒ 同一句(不透露存不存在)');
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000005');
select throws_ok(format('select public.staff_get_booking_for_edit(%L)', :'b1_id'), '42501', '只有這筆訂單的主要服務人員可以編輯這筆訂單', '⑥ 協助人員乙 ⇒ 清楚原因');
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000006');
select throws_ok(format('select public.staff_get_booking_for_edit(%L)', :'b1_id'), '42501', '沒有權限操作這筆訂單', '⑦ 同店丙讀甲的單 ⇒ 擋');
select pg_temp.test_clear_auth();
update merchant_staff set can_create_edit_orders = false where id = 'f9777000-0000-4000-8000-000000000040';
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
select throws_ok(format('select public.staff_get_booking_for_edit(%L)', :'b1_id'), '42501', '沒有權限操作這筆訂單', '⑧ 甲的「新增編輯訂單」關掉 ⇒ 自己的單也擋');
select pg_temp.test_clear_auth();
update merchant_staff set can_create_edit_orders = true where id = 'f9777000-0000-4000-8000-000000000040';
set local role authenticated;
select set_config('request.jwt.claims', '', true);
select throws_ok(format('select public.staff_get_booking_for_edit(%L)', :'b1_id'), '42501', '請先登入', '⑨ 未登入 ⇒ 請先登入');
reset role;

-- =========================================================================
-- ⑩~⑲ staff_update_booking 本人
-- =========================================================================
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
create temp table r977i_u1 on commit drop as
  select pg_temp.sup(:'b1_id'::uuid, '2036-05-01 10:00:00+08', '我想清掉備註', 100) as r,
         current_setting('miaoyue.staff_order_actor', true) as marker_after;
select pg_temp.sup(:'b2_id'::uuid, '2036-05-02 10:00:00+08', '改過的備註') \gset ignore_
select pg_temp.test_clear_auth();

select is(
  (select array_agg(k order by k) from r977i_u1, jsonb_object_keys(r) k),
  array['id','merchant_id','staff_id','start_at','status'],
  '⑩ 回傳只有 id / merchant_id / status / start_at / staff_id'
);
select is(
  (select array_agg(staff_id::text) from booking_assistants where booking_id = :'b1_id'::uuid),
  array['f9777000-0000-4000-8000-000000000041'],
  '⑪ 既有協助人員乙原樣保留(裁決 4)'
);
select is((select staff_id::text from bookings where id = :'b1_id'::uuid), 'f9777000-0000-4000-8000-000000000040', '⑫ 主要服務人員仍是甲');
select is((select b.member_id from bookings b where b.id = :'b1_id'::uuid), (select member_id from r977i_before), '⑬ 會員不變');
select is(
  (select notes || '/' || hide_notes_from_staff::text from bookings where id = :'b1_id'::uuid),
  '機密備註/true',
  '⑭ 被藏起來的內部備註原文保留(前端送的「我想清掉備註」不採用)、隱藏旗標不變'
);
select is(
  (select customer_name || '/' || payment_method_id::text || '/' || final_amount_snapshot::text || '/' || last_modified_by_user_id::text
   from bookings where id = :'b1_id'::uuid),
  '林小姐(改)/f9777000-0000-4000-8000-000000000052/700.00/f9777000-0000-4000-8000-000000000004',
  '⑮ 客戶姓名、付款方式、折扣後金額照 update_booking 生效;最後修改者 = 甲'
);
select is(
  (select count(*)::text || '/' || max(amount_snapshot)::text from booking_material_costs where booking_id = :'b1_id'::uuid),
  '1/150.00',
  '⑯ 料錢保留原值與原快照(主腦決定 C)'
);
select is((select notes from bookings where id = :'b2_id'::uuid), '改過的備註', '⑰ 沒藏的內部備註可以改');
select is((select marker_after from r977i_u1), '', '⑱ 呼叫完標記已清掉');
select is((select status from bookings where id = :'b1_id'::uuid), 'pending_confirmation', '⑲ 狀態不變(仍是待確認)');

-- =========================================================================
-- ⑳~㉓ staff_update_booking 擋下
-- =========================================================================
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000005');
select throws_ok(format($$select public.staff_update_booking(%L,
    jsonb_build_array(jsonb_build_object('service_item_id','f9777000-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
    '2036-05-01 10:00:00+08', '林小姐', '0955977700', null, null, '台北市')$$, :'b1_id'),
  '42501', '只有這筆訂單的主要服務人員可以編輯這筆訂單', '⑳ 協助人員乙改單 ⇒ 擋(故障注入 1 的守門)');
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
select throws_ok(format($$select public.staff_update_booking(%L,
    jsonb_build_array(jsonb_build_object('service_item_id','f9777000-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
    '2036-05-01 10:00:00+08', '林小姐', '0955977700', null, null, '台北市')$$, :'b3_id'),
  '42501', '沒有權限操作這筆訂單', '㉑ 甲改丙的單 ⇒ 擋');
select throws_like(format($$select public.staff_update_booking(%L,
    jsonb_build_array(jsonb_build_object('service_item_id','f9777000-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
    '2036-05-03 10:00:00+08', '林小姐', '0955977700', null, null, '台北市')$$, :'b4_id'),
  '%已完成或已取消的預約不能編輯%', '㉒ 已完成的單不能改(update_booking 自己擋)');
select pg_temp.test_clear_auth();
update merchant_staff set show_member_info = false where id = 'f9777000-0000-4000-8000-000000000040';
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
select throws_ok(format($$select public.staff_update_booking(%L,
    jsonb_build_array(jsonb_build_object('service_item_id','f9777000-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
    '2036-05-01 10:00:00+08', '林小姐', '0955977700', null, null, '台北市')$$, :'b2_id'),
  '42501', '沒有權限操作這筆訂單', '㉓ 甲的「顯示會員資料」關掉 ⇒ 改單被擋(裁決 6 後端保證)');
select pg_temp.test_clear_auth();
update merchant_staff set show_member_info = true where id = 'f9777000-0000-4000-8000-000000000040';

-- =========================================================================
-- ㉔~㉘ staff_cancel_booking
-- =========================================================================
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000005');
select throws_ok(format('select public.staff_cancel_booking(%L)', :'b1_id'), '42501', '只有這筆訂單的主要服務人員可以取消這筆訂單', '㉔ 協助人員乙取消 ⇒ 擋');
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
select throws_ok(format('select public.staff_cancel_booking(%L)', :'b3_id'), '42501', '沒有權限操作這筆訂單', '㉕ 甲取消丙的單 ⇒ 擋');
select throws_like(format('select public.staff_cancel_booking(%L)', :'b4_id'), '%只有「待確認」或「已確認」狀態的預約可以取消%', '㉖ 已完成的單不能用這支取消(方案 A1)');
create temp table r977i_c on commit drop as select public.staff_cancel_booking(:'b2_id'::uuid, '客人改期') as r;
select pg_temp.test_clear_auth();
select is(
  (select array_agg(k order by k) from r977i_c, jsonb_object_keys(r) k)::text || '/' || (select r ->> 'status' from r977i_c),
  '{id,merchant_id,status}/cancelled',
  '㉗ 回傳只有 id / merchant_id / status,狀態已取消'
);
select is(
  (select b.cancelled_reason || '/' || l.actor_role_snapshot || '/' || l.actor_name_snapshot
   from bookings b join booking_status_change_logs l on l.booking_id = b.id and l.to_status = 'cancelled'
   where b.id = :'b2_id'::uuid),
  '客人改期/staff/甲服務人員',
  '㉘ 取消原因照存;操作紀錄 staff / 甲服務人員'
);

-- =========================================================================
-- ㉙~㉜ staff_complete_booking
-- =========================================================================
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
select public.staff_complete_booking(:'b6_id'::uuid) \gset ignore_
select throws_like(format('select public.staff_complete_booking(%L)', :'b1_id'), '%只有「已接受」狀態的預約可以標記完成%', '㉚ 待確認的單不能標記完成');
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000005');
select throws_ok(format('select public.staff_complete_booking(%L)', :'b7_id'), '42501', '只有這筆訂單的主要服務人員可以標記完成', '㉛ 協助人員乙標記完成 ⇒ 擋');
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
select throws_ok(format($$select public.revert_completed_booking(%L, '誤按')$$, :'b4_id'), '42501', NULL,
  '㉜ 方案 A1:服務人員不能還原自己的已完成訂單(管理員專用的 revert_completed_booking 仍擋)');
select pg_temp.test_clear_auth();
select is(
  (select b.status || '/' || l.actor_role_snapshot || '/' || l.actor_name_snapshot
   from bookings b join booking_status_change_logs l on l.booking_id = b.id and l.to_status = 'completed'
   where b.id = :'b6_id'::uuid),
  'completed/staff/甲服務人員',
  '㉙ 甲標記完成 ⇒ 已完成;操作紀錄 staff / 甲服務人員'
);

-- =========================================================================
-- ㉝~㉞ 後台不受影響
-- =========================================================================
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000001');
select id from public.cancel_booking(:'b8_id'::uuid) \gset ignore_
select id from public.complete_booking(:'b9_id'::uuid) \gset ignore_
select pg_temp.test_clear_auth();
select is(
  (select actor_role_snapshot || '/' || actor_name_snapshot from booking_status_change_logs where booking_id = :'b8_id'::uuid and to_status = 'cancelled'),
  'merchant_admin/店主甲',
  '㉝ 管理員取消的操作紀錄仍是 merchant_admin / 管理員姓名'
);
select is(
  (select actor_role_snapshot from booking_status_change_logs where booking_id = :'b9_id'::uuid and to_status = 'completed'),
  'merchant_admin',
  '㉞ 管理員標記完成的操作紀錄仍是 merchant_admin'
);

select * from finish();
rollback;
