-- 客戶端第 3 批 — C3-C01 鈴鐺 private.notify_customer_booking_created(一定發,不看推播開關)
--   收件人:管理員、在職且有 orders 權限的客服、被排到的主要服務人員(在職 + 已開通 + 行事曆檢視)
--   同一個帳號只寫一則(管理員 > 客服 > 服務人員);文字:待確認 / 已成立、訪客句、待確認句、黑名單句只給管理員 / 客服
--   回傳 {title, body}(推播用,不含黑名單句)
begin;

select plan(15);

create temp table c3n_ctx as select ((now() at time zone 'Asia/Taipei')::date + 3) as d0;
create function pg_temp.ts(n integer, t time) returns timestamptz language sql stable as
  $$ select ((select d0 from c3n_ctx) + n + t) at time zone 'Asia/Taipei' $$;
create function pg_temp.md(n integer) returns text language sql stable as $$
  select to_char(d0 + n, 'FMMM/FMDD') || '（' || (array['日', '一', '二', '三', '四', '五', '六'])[extract(dow from d0 + n)::int + 1] || '）'
  from c3n_ctx $$;
create function pg_temp.bells(p_booking uuid) returns text[] language sql stable as $$
  select coalesce(array_agg(un.target_type || ':' || u.email order by un.target_type, u.email), '{}')
  from user_notifications un join auth.users u on u.id = un.user_id
  where un.booking_id = p_booking and un.event_type = 'customer_booking_created' $$;

insert into auth.users (id, email) values
  ('c3e00000-0000-4000-8000-000000000001', 'n-admin@test.local'),
  ('c3e00000-0000-4000-8000-000000000002', 'n-agent-orders@test.local'),
  ('c3e00000-0000-4000-8000-000000000003', 'n-agent-no-orders@test.local'),
  ('c3e00000-0000-4000-8000-000000000004', 'n-agent-removed@test.local'),
  ('c3e00000-0000-4000-8000-000000000005', 'n-staff-ok@test.local'),
  ('c3e00000-0000-4000-8000-000000000006', 'n-staff-noview@test.local'),
  ('c3e00000-0000-4000-8000-000000000007', 'n-staff-invited@test.local');
insert into groups (id) values ('c3e00000-0000-4000-8000-000000000091');
insert into merchants (id, group_id, name, industry_type, booking_slug) values
  ('c3e00000-0000-4000-8000-000000000021', 'c3e00000-0000-4000-8000-000000000091', 'C3通知店', 'in_store_beauty', 'pgtap-c3-notify');
insert into merchant_admins (merchant_id, user_id) values ('c3e00000-0000-4000-8000-000000000021', 'c3e00000-0000-4000-8000-000000000001');
insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('c3e00000-0000-4000-8000-000000000071', 'c3e00000-0000-4000-8000-000000000021', 'c3e00000-0000-4000-8000-000000000001', '管理員兼客服', '0900310071', 'n-admin@test.local', 'active'),
  ('c3e00000-0000-4000-8000-000000000072', 'c3e00000-0000-4000-8000-000000000021', 'c3e00000-0000-4000-8000-000000000002', '訂單客服', '0900310072', 'n-agent-orders@test.local', 'active'),
  ('c3e00000-0000-4000-8000-000000000073', 'c3e00000-0000-4000-8000-000000000021', 'c3e00000-0000-4000-8000-000000000003', '沒訂單權限', '0900310073', 'n-agent-no-orders@test.local', 'active'),
  ('c3e00000-0000-4000-8000-000000000074', 'c3e00000-0000-4000-8000-000000000021', 'c3e00000-0000-4000-8000-000000000004', '已移除客服', '0900310074', 'n-agent-removed@test.local', 'removed');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('c3e00000-0000-4000-8000-000000000071', 'orders', true),
  ('c3e00000-0000-4000-8000-000000000072', 'orders', true),
  ('c3e00000-0000-4000-8000-000000000073', 'members', true),
  ('c3e00000-0000-4000-8000-000000000074', 'orders', true);
insert into merchant_staff (id, merchant_id, name, nickname, phone, is_listed, status, user_id, login_status) values
  ('c3e00000-0000-4000-8000-000000000031', 'c3e00000-0000-4000-8000-000000000021', '通知阿明', '阿明暱稱', '0900310031', true, 'active', 'c3e00000-0000-4000-8000-000000000005', 'active'),
  ('c3e00000-0000-4000-8000-000000000032', 'c3e00000-0000-4000-8000-000000000021', '沒開檢視', null, '0900310032', true, 'active', 'c3e00000-0000-4000-8000-000000000006', 'active'),
  ('c3e00000-0000-4000-8000-000000000033', 'c3e00000-0000-4000-8000-000000000021', '未開通', null, '0900310033', true, 'active', 'c3e00000-0000-4000-8000-000000000007', 'invited'),
  ('c3e00000-0000-4000-8000-000000000034', 'c3e00000-0000-4000-8000-000000000021', '已離職', null, '0900310034', true, 'removed', 'c3e00000-0000-4000-8000-000000000005', 'active'),
  ('c3e00000-0000-4000-8000-000000000035', 'c3e00000-0000-4000-8000-000000000021', '管理員本人當服務人員', null, '0900310035', true, 'active', 'c3e00000-0000-4000-8000-000000000001', 'active');
insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('c3e00000-0000-4000-8000-000000000031', 'staff_calendar_view', true),
  ('c3e00000-0000-4000-8000-000000000033', 'staff_calendar_view', true),
  ('c3e00000-0000-4000-8000-000000000034', 'staff_calendar_view', true),
  ('c3e00000-0000-4000-8000-000000000035', 'staff_calendar_view', true);
insert into members (id, merchant_id, name, phone, referral_code, is_blacklisted) values
  ('c3e00000-0000-4000-8000-000000000041', 'c3e00000-0000-4000-8000-000000000021', '黑名單會員', '0912310041', 'C3NREF41', true),
  ('c3e00000-0000-4000-8000-000000000042', 'c3e00000-0000-4000-8000-000000000021', '一般會員', '0912310042', 'C3NREF42', false);

insert into bookings (id, merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, status, source, is_guest_booking, member_id, customer_address) values
  ('c3e00000-0000-4000-8000-0000000000b1', 'c3e00000-0000-4000-8000-000000000021', 'c3e00000-0000-4000-8000-000000000031', pg_temp.ts(1, '10:00'), pg_temp.ts(1, '11:00'),
   E'王\n小明', '0912310041', 'customer', 'pending_confirmation', 'customer', true, 'c3e00000-0000-4000-8000-000000000041', 'C3N_ADDRESS_SENTINEL'),
  ('c3e00000-0000-4000-8000-0000000000b2', 'c3e00000-0000-4000-8000-000000000021', 'c3e00000-0000-4000-8000-000000000032', pg_temp.ts(2, '14:30'), pg_temp.ts(2, '15:30'),
   '會員甲', '0912310042', 'customer', 'pending_confirmation', 'customer', false, 'c3e00000-0000-4000-8000-000000000042', null),
  ('c3e00000-0000-4000-8000-0000000000b3', 'c3e00000-0000-4000-8000-000000000021', 'c3e00000-0000-4000-8000-000000000033', pg_temp.ts(3, '09:00'), pg_temp.ts(3, '10:00'),
   '會員乙', '0912310042', 'customer', 'accepted', 'customer', false, 'c3e00000-0000-4000-8000-000000000042', null),
  ('c3e00000-0000-4000-8000-0000000000b4', 'c3e00000-0000-4000-8000-000000000021', 'c3e00000-0000-4000-8000-000000000034', pg_temp.ts(4, '09:00'), pg_temp.ts(4, '10:00'),
   '會員丙', '0912310042', 'customer', 'pending_confirmation', 'customer', false, 'c3e00000-0000-4000-8000-000000000042', null),
  ('c3e00000-0000-4000-8000-0000000000b5', 'c3e00000-0000-4000-8000-000000000021', 'c3e00000-0000-4000-8000-000000000035', pg_temp.ts(5, '09:00'), pg_temp.ts(5, '10:00'),
   '會員丁', '0912310042', 'customer', 'pending_confirmation', 'customer', false, 'c3e00000-0000-4000-8000-000000000042', null);

create temp table c3n_push as
select 'b1'::text as k, private.notify_customer_booking_created('c3e00000-0000-4000-8000-0000000000b1') as v
union all select 'b2', private.notify_customer_booking_created('c3e00000-0000-4000-8000-0000000000b2')
union all select 'b3', private.notify_customer_booking_created('c3e00000-0000-4000-8000-0000000000b3')
union all select 'b4', private.notify_customer_booking_created('c3e00000-0000-4000-8000-0000000000b4')
union all select 'b5', private.notify_customer_booking_created('c3e00000-0000-4000-8000-0000000000b5');

select is(pg_temp.bells('c3e00000-0000-4000-8000-0000000000b1'),
  array['admin:n-admin@test.local', 'agent:n-agent-orders@test.local', 'staff:n-staff-ok@test.local'],
  'C01-1 三種收件人;管理員兼客服只收一則;沒 orders 權限 / 已移除的客服不收');
select is(pg_temp.bells('c3e00000-0000-4000-8000-0000000000b2'),
  array['admin:n-admin@test.local', 'agent:n-agent-orders@test.local'], 'C01-2 服務人員沒開行事曆檢視 ⇒ 不收');
select is(pg_temp.bells('c3e00000-0000-4000-8000-0000000000b3'),
  array['admin:n-admin@test.local', 'agent:n-agent-orders@test.local'], 'C01-3 服務人員未開通登入 ⇒ 不收');
select is(pg_temp.bells('c3e00000-0000-4000-8000-0000000000b4'),
  array['admin:n-admin@test.local', 'agent:n-agent-orders@test.local'], 'C01-4 已離職的服務人員 ⇒ 不收');
select is(pg_temp.bells('c3e00000-0000-4000-8000-0000000000b5'),
  array['admin:n-admin@test.local', 'agent:n-agent-orders@test.local'], 'C01-5 服務人員帳號 = 管理員帳號 ⇒ 只收管理員那一則');

select is((select title || '|' || body from user_notifications where booking_id = 'c3e00000-0000-4000-8000-0000000000b1' and target_type = 'admin'),
  '新的線上預約（待確認）|客人「王 小明」預約 ' || pg_temp.md(1) || '10:00，服務人員：通知阿明。訪客預約（未登入），請自行與客戶電話確認。這位客人是黑名單會員，請留意。',
  'C01-6 訪客 + 黑名單:管理員那則有訪客句與黑名單句;姓名換行去掉;服務人員用本名');
select is((select body from user_notifications where booking_id = 'c3e00000-0000-4000-8000-0000000000b1' and target_type = 'agent'),
  (select body from user_notifications where booking_id = 'c3e00000-0000-4000-8000-0000000000b1' and target_type = 'admin'),
  'C01-7 客服那則跟管理員一樣(含黑名單句)');
select is((select body from user_notifications where booking_id = 'c3e00000-0000-4000-8000-0000000000b1' and target_type = 'staff'),
  '客人「王 小明」預約 ' || pg_temp.md(1) || '10:00，服務人員：通知阿明。訪客預約（未登入），請自行與客戶電話確認。',
  'C01-8 服務人員那則沒有黑名單句');
select is((select title || '|' || body from user_notifications where booking_id = 'c3e00000-0000-4000-8000-0000000000b2' and target_type = 'admin'),
  '新的線上預約（待確認）|客人「會員甲」預約 ' || pg_temp.md(2) || '14:30，服務人員：沒開檢視。請確認接單。',
  'C01-9 會員待確認:「請確認接單。」');
select is((select title || '|' || body from user_notifications where booking_id = 'c3e00000-0000-4000-8000-0000000000b3' and target_type = 'admin'),
  '新的線上預約（已成立）|客人「會員乙」預約 ' || pg_temp.md(3) || '09:00，服務人員：未開通。',
  'C01-10 直接成立:標題「已成立」、沒有後綴');
select is((select v from c3n_push where k = 'b1'),
  jsonb_build_object('title', '新的線上預約（待確認）',
                     'body', '客人「王 小明」預約 ' || pg_temp.md(1) || '10:00，服務人員：通知阿明。訪客預約（未登入），請自行與客戶電話確認。'),
  'C01-11 回傳推播文字 = 服務人員那則(不含黑名單句,鎖定畫面看得到)');
select is((select count(*)::int from user_notifications
           where booking_id in ('c3e00000-0000-4000-8000-0000000000b1', 'c3e00000-0000-4000-8000-0000000000b2')
             and (body like '%0912310041%' or body like '%C3N_ADDRESS_SENTINEL%')),
  0, 'C01-12 鈴鐺不放電話、地址');

-- 整合:真的送出一張(訪客)⇒ 鈴鐺 3 則;跟推播總開關無關(這間店沒有任何推播設定)
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'c3e00000-0000-4000-8000-000000000021'::uuid, d, false, '09:00', '18:00' from generate_series(0, 6) d;
insert into merchant_booking_settings (merchant_id, min_lead_hours) values ('c3e00000-0000-4000-8000-000000000021', 0);
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
select 'c3e00000-0000-4000-8000-000000000031'::uuid, d, '09:00', '18:00' from generate_series(0, 6) d;
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('c3e00000-0000-4000-8000-000000000081', 'c3e00000-0000-4000-8000-000000000021', '通知項目', 500, 'primary', 60);
create temp table c3n_sub as select public.internal_customer_submit_booking('pgtap-c3-notify', null, '0912310099',
  jsonb_build_object('items', jsonb_build_array(jsonb_build_object('service_item_id', 'c3e00000-0000-4000-8000-000000000081', 'quantity', 1)),
                     'staff_id', 'c3e00000-0000-4000-8000-000000000031', 'date', to_char((select d0 from c3n_ctx) + 8, 'YYYY-MM-DD'),
                     'time', '10:00', 'name', '整合訪客'), true, gen_random_uuid()) as r;
select is((select r ->> 'state' from c3n_sub), 'created', 'C01-13 前置:訪客送出成功');
select is(pg_temp.bells(((select r -> '_internal' ->> 'booking_id' from c3n_sub))::uuid),
  array['admin:n-admin@test.local', 'agent:n-agent-orders@test.local', 'staff:n-staff-ok@test.local'],
  'C01-14 送出後同一個交易內寫好三則鈴鐺(不看推播開關)');
select is((select count(*)::int from merchant_push_event_settings where merchant_id = 'c3e00000-0000-4000-8000-000000000021'),
  0, 'C01-15 前置:這間店完全沒有推播設定(證明鈴鐺不看推播開關)');

select * from finish();
rollback;
