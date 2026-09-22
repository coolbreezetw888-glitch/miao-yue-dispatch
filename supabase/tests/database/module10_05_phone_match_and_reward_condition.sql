-- 模組 10(會員與紅利)— SPECS-INDEX #614(§10.2/§10.2.1)+ #619(§10.7)。
-- get_members_by_phone(電話查詢索引,不當唯一鍵)+ reward_condition_mode 五選一(核心必測:
-- line_bound/either/both 的交集/聯集邏輯,phone_verified/none 已在 module10_02 覆蓋)。
begin;

select plan(14);

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
-- Fixture。
-- =========================================================================
insert into auth.users (id, email) values
  ('ee000000-0000-4000-8000-000000000001', 'pgtap-m10e-admin-a@test.local'),
  ('ee000000-0000-4000-8000-000000000002', 'pgtap-m10e-admin-b@test.local'),
  ('ee000000-0000-4000-8000-000000000003', 'pgtap-m10e-agent-orders@test.local');

insert into groups (id) values
  ('ee000000-0000-4000-8000-000000000011'),
  ('ee000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('ee000000-0000-4000-8000-000000000021', 'ee000000-0000-4000-8000-000000000011', '電話比對條件測試A店', 'in_store_beauty'),
  ('ee000000-0000-4000-8000-000000000022', 'ee000000-0000-4000-8000-000000000012', '電話比對條件測試B店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('ee000000-0000-4000-8000-000000000021', 'ee000000-0000-4000-8000-000000000001'),
  ('ee000000-0000-4000-8000-000000000022', 'ee000000-0000-4000-8000-000000000002');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'ee000000-0000-4000-8000-000000000021', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('ee000000-0000-4000-8000-000000000031', 'ee000000-0000-4000-8000-000000000021', '洗髮', 1000, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('ee000000-0000-4000-8000-000000000041', 'ee000000-0000-4000-8000-000000000021', '服務人員', '0901000101', true);

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('ee000000-0000-4000-8000-000000000051', 'ee000000-0000-4000-8000-000000000021', 'ee000000-0000-4000-8000-000000000003', '客服-僅訂單', 'pgtap-m10e-agent-orders@test.local', 'active', now(), '0900000101');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('ee000000-0000-4000-8000-000000000051', 'orders', true);

-- SPECS-INDEX #604(本次同批次疊加):create_booking 新建訂單付款方式改為必填,這個檔案的每一筆
-- create_booking 呼叫都要帶一個有效的 payment_method_id,否則會被 #604 的必填規則擋下。
insert into payment_methods (id, merchant_id, name) values
  ('ee000000-0000-4000-8000-000000000071', 'ee000000-0000-4000-8000-000000000021', '現場付款');

insert into merchant_member_settings (merchant_id, points_earn_rate, referral_bonus_points, birthday_bonus_points)
values ('ee000000-0000-4000-8000-000000000021', 100, 0, 0);

select pg_temp.test_set_auth('ee000000-0000-4000-8000-000000000001');

select id from create_member('ee000000-0000-4000-8000-000000000021', '同電話會員一', '0988000001') \gset phone_member1_
select id from create_member('ee000000-0000-4000-8000-000000000021', '同電話會員二', '(09) 88-000-001') \gset phone_member2_

select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('ee000000-0000-4000-8000-000000000002');
select id from create_member('ee000000-0000-4000-8000-000000000022', 'B店同電話會員', '0988000001') \gset other_merchant_phone_member_
select pg_temp.test_clear_auth();

-- =========================================================================
-- ① §10.2.1:get_members_by_phone——電話不當唯一鍵,正規化後相同電話回傳同商家所有客戶。
-- =========================================================================
select pg_temp.test_set_auth('ee000000-0000-4000-8000-000000000003');

select is(
  jsonb_array_length(get_members_by_phone('ee000000-0000-4000-8000-000000000021', '0988000001')),
  2,
  '#614①:同一支電話(不同格式,正規化後相同)在同商家底下有 2 位既有客戶,全部列出'
);

select ok(
  not exists (
    select 1 from jsonb_array_elements(get_members_by_phone('ee000000-0000-4000-8000-000000000021', '0988000001')) elem
    where (elem ->> 'member_id')::uuid = :'other_merchant_phone_member_id'::uuid
  ),
  '#614①:不會查到別間商家的同電話客戶(只在本商家內比對)'
);

select is(
  jsonb_array_length(get_members_by_phone('ee000000-0000-4000-8000-000000000021', '')),
  0,
  '#614:電話為空字串時直接回傳空陣列,不報錯'
);

select is(
  jsonb_array_length(get_members_by_phone('ee000000-0000-4000-8000-000000000021', '0900999999')),
  0,
  '#614:查無資料的新電話,回傳空陣列(前端視為新客戶,不用額外提示)'
);

-- 建單本身的權限邊界:只有 orders 權限(沒有 members 權限)的客服一樣能查詢。
select ok(
  jsonb_array_length(get_members_by_phone('ee000000-0000-4000-8000-000000000021', '0988000001')) = 2,
  '規則 2.10 精神:只有 orders 權限、沒有 members 權限的客服一樣可以呼叫 get_members_by_phone(建單本身的權限邊界)'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ee000000-0000-4000-8000-000000000001');

-- last_booking_date:完成一筆訂單後,正確反映最近一筆預約日期。
select id from create_booking(
  p_merchant_id => 'ee000000-0000-4000-8000-000000000021',
  p_staff_id => 'ee000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ee000000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-15 10:00:00+08',
  p_customer_name => '電話比對訂單測試',
  p_customer_phone => '0988000001',
  p_payment_method_id => 'ee000000-0000-4000-8000-000000000071',
  p_member_id => :'phone_member1_id'::uuid
) \gset phone_match_booking_

select ok(
  exists (
    select 1 from jsonb_array_elements(get_members_by_phone('ee000000-0000-4000-8000-000000000021', '0988000001')) elem
    where (elem ->> 'member_id')::uuid = :'phone_member1_id'::uuid
      and (elem ->> 'last_booking_date') is not null
  ),
  '#614:有連結訂單的會員,last_booking_date 正確帶出(不限訂單狀態)'
);

select ok(
  exists (
    select 1 from jsonb_array_elements(get_members_by_phone('ee000000-0000-4000-8000-000000000021', '0988000001')) elem
    where (elem ->> 'member_id')::uuid = :'phone_member2_id'::uuid
      and (elem ->> 'last_booking_date') is null
  ),
  '#614:沒有任何訂單的同電話會員,last_booking_date 為 null,查無訂單則為 null'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ② §10.7(SPECS-INDEX #619 核心必測):reward_condition_mode 五選一裡的 line_bound/either/both,
-- 逐一驗證交集/聯集邏輯。用消費紅利路徑(compute_member_loyalty_points)驗證,四種會員狀態組合:
-- 只驗證電話/只綁LINE/兩者都有/兩者都沒有。
-- =========================================================================
select pg_temp.test_set_auth('ee000000-0000-4000-8000-000000000001');

select id from create_member('ee000000-0000-4000-8000-000000000021', '只驗證電話會員', '0977000001') \gset cond_phone_only_
select id from create_member('ee000000-0000-4000-8000-000000000021', '只綁LINE會員', '0977000002') \gset cond_line_only_
select id from create_member('ee000000-0000-4000-8000-000000000021', '兩者都有會員', '0977000003') \gset cond_both_
select id from create_member('ee000000-0000-4000-8000-000000000021', '兩者都沒有會員', '0977000004') \gset cond_neither_

select set_member_phone_verified(:'cond_phone_only_id'::uuid, true);
select set_member_phone_verified(:'cond_both_id'::uuid, true);

select pg_temp.test_clear_auth();

update members set line_bound = true where id in (:'cond_line_only_id'::uuid, :'cond_both_id'::uuid);

-- mode = 'line_bound':只看 LINE 已綁定。
update merchant_member_settings set reward_condition_mode = 'line_bound'
where merchant_id = 'ee000000-0000-4000-8000-000000000021';

select pg_temp.test_set_auth('ee000000-0000-4000-8000-000000000001');

select id from create_booking(
  p_merchant_id => 'ee000000-0000-4000-8000-000000000021', p_staff_id => 'ee000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ee000000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-16 09:00:00+08', p_customer_name => 'line_bound模式-只驗電話', p_customer_phone => '0977000001',
  p_payment_method_id => 'ee000000-0000-4000-8000-000000000071',
  p_member_id => :'cond_phone_only_id'::uuid
) \gset lb_booking_phone_only_
select confirm_booking(:'lb_booking_phone_only_id'::uuid);
select complete_booking(:'lb_booking_phone_only_id'::uuid);

select id from create_booking(
  p_merchant_id => 'ee000000-0000-4000-8000-000000000021', p_staff_id => 'ee000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ee000000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-16 10:00:00+08', p_customer_name => 'line_bound模式-只綁LINE', p_customer_phone => '0977000002',
  p_payment_method_id => 'ee000000-0000-4000-8000-000000000071',
  p_member_id => :'cond_line_only_id'::uuid
) \gset lb_booking_line_only_
select confirm_booking(:'lb_booking_line_only_id'::uuid);
select complete_booking(:'lb_booking_line_only_id'::uuid);

select is(
  (select count(*)::int from member_point_transactions where booking_id = :'lb_booking_phone_only_id'::uuid),
  0,
  '#619(line_bound 模式):只驗證電話、沒綁 LINE 的會員,不核發(mode=line_bound 只看 LINE)'
);

select is(
  (select count(*)::int from member_point_transactions where booking_id = :'lb_booking_line_only_id'::uuid),
  1,
  '#619(line_bound 模式):只綁 LINE 的會員正確核發'
);

-- mode = 'either':任一即可。
update merchant_member_settings set reward_condition_mode = 'either'
where merchant_id = 'ee000000-0000-4000-8000-000000000021';

select id from create_booking(
  p_merchant_id => 'ee000000-0000-4000-8000-000000000021', p_staff_id => 'ee000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ee000000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-16 11:00:00+08', p_customer_name => 'either模式-只驗電話', p_customer_phone => '0977000001',
  p_payment_method_id => 'ee000000-0000-4000-8000-000000000071',
  p_member_id => :'cond_phone_only_id'::uuid
) \gset either_booking_phone_
select confirm_booking(:'either_booking_phone_id'::uuid);
select complete_booking(:'either_booking_phone_id'::uuid);

select id from create_booking(
  p_merchant_id => 'ee000000-0000-4000-8000-000000000021', p_staff_id => 'ee000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ee000000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-16 12:00:00+08', p_customer_name => 'either模式-都沒有', p_customer_phone => '0977000004',
  p_payment_method_id => 'ee000000-0000-4000-8000-000000000071',
  p_member_id => :'cond_neither_id'::uuid
) \gset either_booking_neither_
select confirm_booking(:'either_booking_neither_id'::uuid);
select complete_booking(:'either_booking_neither_id'::uuid);

select is(
  (select count(*)::int from member_point_transactions where booking_id = :'either_booking_phone_id'::uuid),
  1,
  '#619(either 模式):只驗證電話(沒綁 LINE)的會員一樣核發(任一即可)'
);

select is(
  (select count(*)::int from member_point_transactions where booking_id = :'either_booking_neither_id'::uuid),
  0,
  '#619(either 模式):兩者都沒有的會員不核發'
);

-- mode = 'both':兩者都要。
update merchant_member_settings set reward_condition_mode = 'both'
where merchant_id = 'ee000000-0000-4000-8000-000000000021';

select id from create_booking(
  p_merchant_id => 'ee000000-0000-4000-8000-000000000021', p_staff_id => 'ee000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ee000000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-16 13:00:00+08', p_customer_name => 'both模式-只驗電話', p_customer_phone => '0977000001',
  p_payment_method_id => 'ee000000-0000-4000-8000-000000000071',
  p_member_id => :'cond_phone_only_id'::uuid
) \gset both_booking_phone_only_
select confirm_booking(:'both_booking_phone_only_id'::uuid);
select complete_booking(:'both_booking_phone_only_id'::uuid);

select id from create_booking(
  p_merchant_id => 'ee000000-0000-4000-8000-000000000021', p_staff_id => 'ee000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ee000000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-16 14:00:00+08', p_customer_name => 'both模式-兩者都有', p_customer_phone => '0977000003',
  p_payment_method_id => 'ee000000-0000-4000-8000-000000000071',
  p_member_id => :'cond_both_id'::uuid
) \gset both_booking_both_
select confirm_booking(:'both_booking_both_id'::uuid);
select complete_booking(:'both_booking_both_id'::uuid);

select is(
  (select count(*)::int from member_point_transactions where booking_id = :'both_booking_phone_only_id'::uuid),
  0,
  '#619(both 模式,核心):只驗證電話、沒綁 LINE 的會員不核發(兩者都要)'
);

select is(
  (select count(*)::int from member_point_transactions where booking_id = :'both_booking_both_id'::uuid),
  1,
  '#619(both 模式,核心):兩者都有的會員正確核發'
);

-- mode = 'phone_verified':對照組,只看電話已驗證,不看 LINE(跟 module10_02 的驗證方向互補)。
update merchant_member_settings set reward_condition_mode = 'phone_verified'
where merchant_id = 'ee000000-0000-4000-8000-000000000021';

select id from create_booking(
  p_merchant_id => 'ee000000-0000-4000-8000-000000000021', p_staff_id => 'ee000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ee000000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-16 15:00:00+08', p_customer_name => 'phone_verified模式-只綁LINE', p_customer_phone => '0977000002',
  p_payment_method_id => 'ee000000-0000-4000-8000-000000000071',
  p_member_id => :'cond_line_only_id'::uuid
) \gset pv_booking_line_only_
select confirm_booking(:'pv_booking_line_only_id'::uuid);
select complete_booking(:'pv_booking_line_only_id'::uuid);

select is(
  (select count(*)::int from member_point_transactions where booking_id = :'pv_booking_line_only_id'::uuid),
  0,
  '#619(phone_verified 模式,對照組):只綁 LINE、沒驗證電話的會員不核發(這個模式只看電話)'
);

select pg_temp.test_clear_auth();

select * from finish();
rollback;
