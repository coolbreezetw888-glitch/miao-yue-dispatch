-- SPECS-INDEX #977 第 3 批(2026-10-06):「服務人員是否顯示會員資料」關閉時,服務人員端只看得到客戶姓名 — pgTAP
-- migration 20261006130300_req977_staff_hide_customer_contact.sql
-- 規格書「權限收緊與服務人員開關修正-第3批」第四節(使用者裁決 H-13)。
--
--   ①~④ get_my_booking_schedule(服務人員端行事曆列表 / 時間軸 / 詳情的唯一資料來源):
--        關閉 ⇒ customer_phone / customer_address 是 null(回應裡就沒有那段文字),會員資料照舊是 null;客戶姓名照常
--   ⑤~⑦ 開啟 ⇒ 電話、地址、會員資料照舊回傳;同一位服務人員切換開關,下一次查詢立即生效
--   ⑧   商家端不受影響:管理員的 get_merchant_day_schedule 照樣看得到電話
--   ⑨~⑪ 其他服務人員看得到的出口也拿不到電話地址:
--        get_my_day_schedule_state(服務人員端單日狀態)、bookings 表層 SELECT、通知文案變數
--        (render_booking_notification_variables 沒有電話 / 地址變數,且只給 service_role)
--   ⑫   ACL 跟改前完全相同
--
-- 故障注入(engineer 已做,見回報):把 'customer_phone' 那行改回 bb.customer_phone ⇒ ① ③ 轉紅。
begin;

select plan(12);

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
  ('f9772000-0000-4000-8000-000000000001', 'pgtap-r977b-admin@test.local'),
  ('f9772000-0000-4000-8000-000000000002', 'pgtap-r977b-staff-off@test.local'),
  ('f9772000-0000-4000-8000-000000000003', 'pgtap-r977b-staff-on@test.local');

insert into groups (id) values ('f9772000-0000-4000-8000-000000000010');
insert into merchants (id, group_id, name, industry_type) values
  ('f9772000-0000-4000-8000-000000000020', 'f9772000-0000-4000-8000-000000000010', '#977 會員資料測試店', 'on_site_dispatch');
insert into merchant_admins (merchant_id, user_id) values
  ('f9772000-0000-4000-8000-000000000020', 'f9772000-0000-4000-8000-000000000001');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('f9772000-0000-4000-8000-000000000030', 'f9772000-0000-4000-8000-000000000020', '到府服務', 800, 'primary', 60);
insert into payment_methods (id, merchant_id, name) values
  ('f9772000-0000-4000-8000-000000000050', 'f9772000-0000-4000-8000-000000000020', '現金');

-- 兩位服務人員都已開通登入、開「行事曆檢視」;差別只在 show_member_info。後台無時段限制 ⇒ 建單不用布置時段。
insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, unlimited_backend_edit, show_member_info, phone) values
  ('f9772000-0000-4000-8000-000000000040', 'f9772000-0000-4000-8000-000000000020', 'f9772000-0000-4000-8000-000000000002', '關閉者', 'piece_rate', 'active', 'active', now(), true, false, '0900977240'),
  ('f9772000-0000-4000-8000-000000000041', 'f9772000-0000-4000-8000-000000000020', 'f9772000-0000-4000-8000-000000000003', '開啟者', 'piece_rate', 'active', 'active', now(), true, true, '0900977241');
insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('f9772000-0000-4000-8000-000000000040', 'staff_calendar_view', true),
  ('f9772000-0000-4000-8000-000000000041', 'staff_calendar_view', true);

insert into members (id, merchant_id, name, phone, referral_code, points_balance) values
  ('f9772000-0000-4000-8000-000000000060', 'f9772000-0000-4000-8000-000000000020', '會員王大明', '0955977260', 'R9772A', 42);

select pg_temp.test_set_auth('f9772000-0000-4000-8000-000000000001');
select id from create_booking(
  p_merchant_id => 'f9772000-0000-4000-8000-000000000020',
  p_staff_id => 'f9772000-0000-4000-8000-000000000040',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9772000-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
  p_start_at => '2026-11-10 10:00:00+08',
  p_customer_name => '王大明',
  p_customer_phone => '0955977260',
  p_customer_address => '台北市秘密路 77 號',
  p_member_id => 'f9772000-0000-4000-8000-000000000060'::uuid,
  p_payment_method_id => 'f9772000-0000-4000-8000-000000000050'
) \gset off_
select id from create_booking(
  p_merchant_id => 'f9772000-0000-4000-8000-000000000020',
  p_staff_id => 'f9772000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9772000-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
  p_start_at => '2026-11-10 14:00:00+08',
  p_customer_name => '王大明',
  p_customer_phone => '0955977260',
  p_customer_address => '台北市秘密路 77 號',
  p_member_id => 'f9772000-0000-4000-8000-000000000060'::uuid,
  p_payment_method_id => 'f9772000-0000-4000-8000-000000000050'
) \gset on_
select pg_temp.test_clear_auth();

-- =========================================================================
-- ①~④ 關閉
-- =========================================================================
select pg_temp.test_set_auth('f9772000-0000-4000-8000-000000000002');
create temp table r977_off on commit drop as
  select get_my_booking_schedule('f9772000-0000-4000-8000-000000000040', '2026-11-01', '2026-11-30') as j;

select is(
  (select jsonb_build_object('phone', j -> 0 -> 'customer_phone', 'address', j -> 0 -> 'customer_address') from r977_off),
  '{"phone": null, "address": null}'::jsonb,
  '① 關閉:服務人員拿到的預約 customer_phone、customer_address 都是 null'
);
select is(
  (select j -> 0 ->> 'customer_name' from r977_off),
  '王大明',
  '② 關閉:客戶姓名照常回傳'
);
select ok(
  (select position('0955977260' in j::text) = 0 and position('秘密路' in j::text) = 0 from r977_off),
  '③ 關閉:整份回應原文裡找不到電話與地址字串(不是「有送出、前端不顯示」)'
);
select is(
  (select jsonb_build_object('m', j -> 0 -> 'is_member', 'n', j -> 0 -> 'member_name', 'p', j -> 0 -> 'member_points_balance') from r977_off),
  '{"m": null, "n": null, "p": null}'::jsonb,
  '④ 關閉:會員身分、會員姓名、點數餘額照舊不回傳'
);

-- =========================================================================
-- ⑤~⑦ 開啟
-- =========================================================================
select pg_temp.test_set_auth('f9772000-0000-4000-8000-000000000003');
select is(
  (select jsonb_build_object(
     'phone', j -> 0 ->> 'customer_phone', 'address', j -> 0 ->> 'customer_address',
     'member', j -> 0 ->> 'member_name', 'points', (j -> 0 ->> 'member_points_balance')::int)
   from (select get_my_booking_schedule('f9772000-0000-4000-8000-000000000041', '2026-11-01', '2026-11-30') as j) x),
  '{"phone": "0955977260", "address": "台北市秘密路 77 號", "member": "會員王大明", "points": 42}'::jsonb,
  '⑤ 開啟:電話、地址、會員姓名、點數餘額照舊回傳'
);
select pg_temp.test_clear_auth();
update merchant_staff set show_member_info = true where id = 'f9772000-0000-4000-8000-000000000040';
select pg_temp.test_set_auth('f9772000-0000-4000-8000-000000000002');
select is(
  (select get_my_booking_schedule('f9772000-0000-4000-8000-000000000040', '2026-11-01', '2026-11-30') -> 0 ->> 'customer_phone'),
  '0955977260',
  '⑥ 同一位服務人員打開開關後,下一次查詢立即看得到電話'
);
select pg_temp.test_clear_auth();
update merchant_staff set show_member_info = false where id = 'f9772000-0000-4000-8000-000000000040';
select pg_temp.test_set_auth('f9772000-0000-4000-8000-000000000002');
select is(
  (select get_my_booking_schedule('f9772000-0000-4000-8000-000000000040', '2026-11-01', '2026-11-30') -> 0 ->> 'customer_address'),
  null,
  '⑦ 再關掉 ⇒ 又看不到地址'
);

-- =========================================================================
-- ⑧ 商家端不受影響
-- =========================================================================
select pg_temp.test_set_auth('f9772000-0000-4000-8000-000000000001');
select is(
  (select b ->> 'customer_phone'
   from jsonb_array_elements(get_merchant_day_schedule('f9772000-0000-4000-8000-000000000020', '2026-11-10') -> 'staff') s,
        jsonb_array_elements(s -> 'bookings') b
   where s ->> 'staff_id' = 'f9772000-0000-4000-8000-000000000040'),
  '0955977260',
  '⑧ 商家管理員的行事曆照樣看得到這位(關閉者)名下訂單的客戶電話'
);

-- =========================================================================
-- ⑨~⑪ 其他服務人員可碰到的出口
-- =========================================================================
select pg_temp.test_set_auth('f9772000-0000-4000-8000-000000000002');
select ok(
  position('0955977260' in coalesce(get_my_day_schedule_state('f9772000-0000-4000-8000-000000000040', '2026-11-10')::text, '')) = 0
  and position('秘密路' in coalesce(get_my_day_schedule_state('f9772000-0000-4000-8000-000000000040', '2026-11-10')::text, '')) = 0,
  '⑨ get_my_day_schedule_state(服務人員端單日狀態)不含客戶電話、地址'
);
select is(
  (select count(*)::int from bookings where merchant_id = 'f9772000-0000-4000-8000-000000000020'),
  0,
  '⑩ 服務人員直接讀 bookings 表:0 筆(表層 SELECT 本來就不開給服務人員)'
);
select pg_temp.test_clear_auth();
select ok(
  not has_function_privilege('authenticated', 'public.render_booking_notification_variables(uuid, uuid)', 'execute')
  and not ((select render_booking_notification_variables(:'off_id'::uuid, 'f9772000-0000-4000-8000-000000000020')) ?| array['customer_phone', 'customer_address']),
  '⑪ 推播 / 站內鈴鐺 / LINE 的文案變數沒有電話、地址(且一般登入者不能直接呼叫)'
);

-- =========================================================================
-- ⑫ ACL 不變
-- =========================================================================
select is(
  (select array_to_string(proacl, ' ') from pg_proc where oid = 'public.get_my_booking_schedule(uuid, date, date)'::regprocedure),
  'postgres=X/postgres authenticated=X/postgres service_role=X/postgres',
  '⑫ get_my_booking_schedule 的 ACL 跟改前完全相同'
);

select * from finish();

rollback;
