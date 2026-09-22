-- 模組 14(服務人員端)第二支 pgTAP — 對應規格書建議實作順序第 7-10 步:
-- 3.13/3.14(可預約時段/單日例外自助讀寫)、3.15(我的行事曆彙整)、3.17(抽成/薪資報表自助檢視)、
-- 3.16(個人資料自助編輯)、3.20(頭像自助上傳 Storage 隔離)。
-- 規則 2.4(核心必測)在這裡針對「已經存在的公開 RPC 函式」(不是只測底層 private 函式)再測一次
-- ——傳入別人的 staff_id 一律被擋下。

begin;

select plan(47);

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
-- Fixture:一間商家,一位管理員,四位服務人員(X=按件計酬主測試對象/Y=月薪制/Z=隔離測試對象/
-- W2=show_member_info=false 對照組),一位會員。
-- =========================================================================
insert into auth.users (id, email) values
  ('e1420000-0000-4000-8000-000000000001', 'pgtap-m14b-admin@test.local'),
  ('e1420000-0000-4000-8000-000000000002', 'pgtap-m14b-staff-x@test.local'),
  ('e1420000-0000-4000-8000-000000000003', 'pgtap-m14b-staff-y@test.local'),
  ('e1420000-0000-4000-8000-000000000004', 'pgtap-m14b-staff-z@test.local'),
  ('e1420000-0000-4000-8000-000000000005', 'pgtap-m14b-staff-w2@test.local');

insert into groups (id) values ('e1420000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('e1420000-0000-4000-8000-000000000020', 'e1420000-0000-4000-8000-000000000010', '服務人員端測試B店', 'on_site_dispatch');

insert into merchant_admins (merchant_id, user_id)
values ('e1420000-0000-4000-8000-000000000020', 'e1420000-0000-4000-8000-000000000001');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'e1420000-0000-4000-8000-000000000020', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('e1420000-0000-4000-8000-000000000030', 'e1420000-0000-4000-8000-000000000020', '到府服務', 500, 'primary', 60);

insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, no_time_slot_limit, show_member_info, phone) values
  ('e1420000-0000-4000-8000-000000000040', 'e1420000-0000-4000-8000-000000000020', 'e1420000-0000-4000-8000-000000000002', '服務人員X(按件)', 'piece_rate', 'active', 'active', now(), true, true, '0900000101'),
  ('e1420000-0000-4000-8000-000000000041', 'e1420000-0000-4000-8000-000000000020', 'e1420000-0000-4000-8000-000000000003', '服務人員Y(月薪)', 'monthly_salary', 'active', 'active', now(), true, false, '0900000102'),
  ('e1420000-0000-4000-8000-000000000042', 'e1420000-0000-4000-8000-000000000020', 'e1420000-0000-4000-8000-000000000004', '服務人員Z(隔離測試)', 'piece_rate', 'active', 'active', now(), true, false, '0900000103'),
  ('e1420000-0000-4000-8000-000000000043', 'e1420000-0000-4000-8000-000000000020', 'e1420000-0000-4000-8000-000000000005', '服務人員W2(不顯示會員)', 'piece_rate', 'active', 'active', now(), true, false, '0900000104');

insert into merchant_staff_permissions (staff_id, section_key, granted)
select s.id, k.key, true
from (values
  ('e1420000-0000-4000-8000-000000000040'::uuid),
  ('e1420000-0000-4000-8000-000000000041'::uuid),
  ('e1420000-0000-4000-8000-000000000042'::uuid),
  ('e1420000-0000-4000-8000-000000000043'::uuid)
) as s(id)
cross join (values
  ('staff_calendar_view'), ('staff_availability_self_manage'), ('staff_payroll_view'), ('staff_profile_edit')
) as k(key);

insert into members (id, merchant_id, name, phone, points_balance, referral_code)
values ('e1420000-0000-4000-8000-000000000090', 'e1420000-0000-4000-8000-000000000020', '會員一', '0911999000', 120, 'M14BTEST01');

-- =========================================================================
-- 建立測試預約(以管理員身份,透過真正的 create_booking/confirm_booking/complete_booking
-- 走完整流程,確保 booking_commission_records 是系統自然算出來的,不是手動塞值)。
-- =========================================================================
select pg_temp.test_set_auth('e1420000-0000-4000-8000-000000000001');
-- SPECS-INDEX #604(2026-09-23 批次修正,機械性補參數,不改變測試本身要驗證的邏輯):
-- create_booking 新建訂單付款方式改為必填,下面既有的 create_booking/update_booking 呼叫
-- 補上 p_payment_method_id。
insert into payment_methods (id, merchant_id, name) values ('3ca8bfce-3296-5bc8-a6fb-c15c1096c000', 'e1420000-0000-4000-8000-000000000020', '現場付款');


-- booking1:X 為主要服務人員,完整跑到 completed(用於 3.15 主要身份 + 3.17 抽成報表)。
select id from create_booking(
  p_merchant_id => 'e1420000-0000-4000-8000-000000000020',
  p_staff_id => 'e1420000-0000-4000-8000-000000000040',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e1420000-0000-4000-8000-000000000030','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-10 10:00:00+08',
  p_customer_name => '客戶一',
  p_customer_phone => '0911000001',
  p_customer_address => '測試地址一號'
, p_payment_method_id => '3ca8bfce-3296-5bc8-a6fb-c15c1096c000') \gset booking1_
select confirm_booking(:'booking1_id'::uuid);
select complete_booking(:'booking1_id'::uuid);

-- booking2:Y 為主要服務人員,X 為助手(用於 3.15 助手身份測試)。
select id from create_booking(
  p_merchant_id => 'e1420000-0000-4000-8000-000000000020',
  p_staff_id => 'e1420000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e1420000-0000-4000-8000-000000000030','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-11 14:00:00+08',
  p_customer_name => '客戶二',
  p_customer_phone => '0911000002',
  p_assistant_staff_ids => array['e1420000-0000-4000-8000-000000000040'::uuid],
  p_customer_address => '測試地址二號'
, p_payment_method_id => '3ca8bfce-3296-5bc8-a6fb-c15c1096c000') \gset booking2_

-- booking3:X 為主要服務人員,連結會員(用於規則 2.6 show_member_info=true)。
select id from create_booking(
  p_merchant_id => 'e1420000-0000-4000-8000-000000000020',
  p_staff_id => 'e1420000-0000-4000-8000-000000000040',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e1420000-0000-4000-8000-000000000030','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-12 09:00:00+08',
  p_customer_name => '客戶三(會員)',
  p_customer_phone => '0911000003',
  p_member_id => 'e1420000-0000-4000-8000-000000000090'::uuid,
  p_customer_address => '測試地址三號'
, p_payment_method_id => '3ca8bfce-3296-5bc8-a6fb-c15c1096c000') \gset booking3_

-- booking4:W2 為主要服務人員,連結同一位會員(用於規則 2.6 show_member_info=false)。
select id from create_booking(
  p_merchant_id => 'e1420000-0000-4000-8000-000000000020',
  p_staff_id => 'e1420000-0000-4000-8000-000000000043',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e1420000-0000-4000-8000-000000000030','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-13 09:00:00+08',
  p_customer_name => '客戶四(會員)',
  p_customer_phone => '0911000004',
  p_member_id => 'e1420000-0000-4000-8000-000000000090'::uuid,
  p_customer_address => '測試地址四號'
, p_payment_method_id => '3ca8bfce-3296-5bc8-a6fb-c15c1096c000') \gset booking4_

select pg_temp.test_clear_auth();

-- =========================================================================
-- 3.13:staff_availability_windows 四政策疊加。
-- =========================================================================
select pg_temp.test_set_auth('e1420000-0000-4000-8000-000000000002'); -- X(按件計酬)

select lives_ok(
  $$insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    values ('e1420000-0000-4000-8000-000000000040', 1, '09:00', '18:00')$$,
  '3.13:按件計酬服務人員 X 可以新增自己的每週固定時段'
);

select is(
  (select count(*)::int from staff_availability_windows where staff_id = 'e1420000-0000-4000-8000-000000000040'),
  1,
  '3.13:X 可以讀到自己剛新增的時段'
);

select throws_ok(
  $$insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    values ('e1420000-0000-4000-8000-000000000042', 1, '09:00', '18:00')$$,
  '42501', null,
  '規則 2.4(核心必測):X 不能新增服務人員 Z 的每週固定時段(RLS 擋下)'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e1420000-0000-4000-8000-000000000003'); -- Y(月薪制)

select throws_ok(
  $$insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    values ('e1420000-0000-4000-8000-000000000041', 1, '09:00', '18:00')$$,
  '42501', null,
  '規則 2.2:月薪制服務人員 Y 即使被開通 staff_availability_self_manage 也無法自助新增時段'
);

select pg_temp.test_clear_auth();

-- 管理員既有行為不受影響。
select pg_temp.test_set_auth('e1420000-0000-4000-8000-000000000001');
select lives_ok(
  $$insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    values ('e1420000-0000-4000-8000-000000000041', 2, '09:00', '18:00')$$,
  '3.13:既有商家管理員行為不受疊加影響,仍能新增任一服務人員的時段'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- 3.14:staff_availability_overrides SELECT 疊加 + set_staff_day_override/clear_staff_day_override
-- 疊加自助分支。用 booking1(2026-11-10 10:00-11:00)驗證既有預約衝突回報邏輯不變(規則 2.3)。
-- =========================================================================
select pg_temp.test_set_auth('e1420000-0000-4000-8000-000000000002'); -- X

select is(
  (select set_staff_day_override('e1420000-0000-4000-8000-000000000040'::uuid, '2026-11-10'::date, '09:00'::time, '12:00'::time, false)),
  1,
  '3.14/規則 2.3:X 自助關閉涵蓋 booking1 的時段,回報既有預約衝突筆數 = 1(跟管理員操作的既有邏輯完全相同)'
);

select is(
  (select count(*)::int from staff_availability_overrides where staff_id = 'e1420000-0000-4000-8000-000000000040' and override_date = '2026-11-10'),
  6,
  '3.14:X 自助關閉 3 小時(09:00-12:00)展開成 6 個半小時格子'
);

select lives_ok(
  $$select clear_staff_day_override('e1420000-0000-4000-8000-000000000040'::uuid, '2026-11-10'::date, '09:00'::time, '12:00'::time)$$,
  '3.14:X 自助清除自己剛設定的單日例外成功'
);

select is(
  (select count(*)::int from staff_availability_overrides where staff_id = 'e1420000-0000-4000-8000-000000000040' and override_date = '2026-11-10'),
  0,
  '3.14:清除後單日例外格子歸零'
);

select throws_ok(
  $$select set_staff_day_override('e1420000-0000-4000-8000-000000000042'::uuid, '2026-11-10'::date, '09:00'::time, '12:00'::time, false)$$,
  '42501', null,
  '規則 2.4(核心必測):X 不能透過 set_staff_day_override 操作服務人員 Z 的單日例外'
);

select throws_ok(
  $$select clear_staff_day_override('e1420000-0000-4000-8000-000000000042'::uuid, '2026-11-10'::date, '09:00'::time, '12:00'::time)$$,
  '42501', null,
  '規則 2.4(核心必測):X 不能透過 clear_staff_day_override 操作服務人員 Z 的單日例外'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e1420000-0000-4000-8000-000000000003'); -- Y(月薪制)
select throws_ok(
  $$select set_staff_day_override('e1420000-0000-4000-8000-000000000041'::uuid, '2026-11-11'::date, '09:00'::time, '12:00'::time, false)$$,
  '42501', null,
  '規則 2.2:月薪制服務人員 Y 呼叫 set_staff_day_override 操作自己的單日例外仍被擋下'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- 3.15:get_my_booking_schedule。
-- =========================================================================
select pg_temp.test_set_auth('e1420000-0000-4000-8000-000000000002'); -- X

select is(
  jsonb_array_length(get_my_booking_schedule('e1420000-0000-4000-8000-000000000040'::uuid, '2026-11-01'::date, '2026-11-30'::date)),
  3,
  '3.15:X 這個月的行事曆包含 booking1(主要)、booking2(助手)、booking3(主要+會員),共 3 筆'
);

select ok(
  exists (
    select 1 from jsonb_array_elements(get_my_booking_schedule('e1420000-0000-4000-8000-000000000040'::uuid, '2026-11-01'::date, '2026-11-30'::date)) e
    where (e ->> 'id') = :'booking2_id' and (e ->> 'role_in_booking') = 'assistant'
  ),
  '規則 2.5:booking2(X 以助手身份參與)正確標記 role_in_booking=assistant'
);

select ok(
  exists (
    select 1 from jsonb_array_elements(get_my_booking_schedule('e1420000-0000-4000-8000-000000000040'::uuid, '2026-11-01'::date, '2026-11-30'::date)) e
    where (e ->> 'id') = :'booking1_id' and (e ->> 'role_in_booking') = 'primary'
  ),
  '規則 2.5:booking1(X 為主要服務人員)正確標記 role_in_booking=primary'
);

select is(
  (
    select (e ->> 'is_member')::boolean
    from jsonb_array_elements(get_my_booking_schedule('e1420000-0000-4000-8000-000000000040'::uuid, '2026-11-01'::date, '2026-11-30'::date)) e
    where (e ->> 'id') = :'booking3_id'
  ),
  true,
  '規則 2.6:X 的 show_member_info=true,booking3(連結會員)正確回傳 is_member=true'
);

select is(
  (
    select (e ->> 'member_points_balance')::int
    from jsonb_array_elements(get_my_booking_schedule('e1420000-0000-4000-8000-000000000040'::uuid, '2026-11-01'::date, '2026-11-30'::date)) e
    where (e ->> 'id') = :'booking3_id'
  ),
  120,
  '規則 2.6:show_member_info=true 時會員專屬欄位(點數餘額)正確帶出'
);

select ok(
  (
    select (e ->> 'customer_name')
    from jsonb_array_elements(get_my_booking_schedule('e1420000-0000-4000-8000-000000000040'::uuid, '2026-11-01'::date, '2026-11-30'::date)) e
    where (e ->> 'id') = :'booking1_id'
  ) = '客戶一',
  '規則 2.6:基本資訊(客戶姓名)不受 show_member_info 影響,一律回傳'
);

select throws_ok(
  $$select get_my_booking_schedule('e1420000-0000-4000-8000-000000000042'::uuid, '2026-11-01'::date, '2026-11-30'::date)$$,
  '42501', null,
  '規則 2.4(核心必測):X 傳入服務人員 Z 的 staff_id 呼叫 get_my_booking_schedule 被擋下'
);

select throws_ok(
  $$select get_my_booking_schedule('e1420000-0000-4000-8000-000000000040'::uuid, '2026-01-01'::date, '2026-12-31'::date)$$,
  '22023', null,
  '3.15:查詢範圍超過 62 天被擋下並提示分批查詢'
);

select pg_temp.test_clear_auth();

-- 規則 2.6 對照組:W2 的 show_member_info=false,booking4(連結同一位會員)不應該顯示會員專屬欄位。
select pg_temp.test_set_auth('e1420000-0000-4000-8000-000000000005'); -- W2

select is(
  (
    select e -> 'is_member'
    from jsonb_array_elements(get_my_booking_schedule('e1420000-0000-4000-8000-000000000043'::uuid, '2026-11-01'::date, '2026-11-30'::date)) e
    where (e ->> 'id') = :'booking4_id'
  ),
  'null'::jsonb,
  '規則 2.6:W2 的 show_member_info=false,即使 booking4 連結會員,is_member 仍回傳 null'
);

select is(
  (
    select e -> 'member_points_balance'
    from jsonb_array_elements(get_my_booking_schedule('e1420000-0000-4000-8000-000000000043'::uuid, '2026-11-01'::date, '2026-11-30'::date)) e
    where (e ->> 'id') = :'booking4_id'
  ),
  'null'::jsonb,
  '規則 2.6:show_member_info=false 時會員專屬欄位一律 null'
);

select ok(
  (
    select (e ->> 'customer_name')
    from jsonb_array_elements(get_my_booking_schedule('e1420000-0000-4000-8000-000000000043'::uuid, '2026-11-01'::date, '2026-11-30'::date)) e
    where (e ->> 'id') = :'booking4_id'
  ) = '客戶四(會員)',
  '規則 2.6:即使 show_member_info=false,基本資訊仍正常回傳'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- 3.17:get_staff_commission_summary/get_staff_monthly_payroll_summary 疊加自助檢視分支。
-- =========================================================================
select pg_temp.test_set_auth('e1420000-0000-4000-8000-000000000002'); -- X(自己查自己)

select lives_ok(
  $$select get_staff_commission_summary('e1420000-0000-4000-8000-000000000040'::uuid, 2026, 11)$$,
  '3.17:X 自助查詢自己 2026-11 的抽成報表成功'
);

select is(
  (select (get_staff_commission_summary('e1420000-0000-4000-8000-000000000040'::uuid, 2026, 11) ->> 'total_orders')::int),
  1,
  '3.17:X 的抽成報表正確顯示 1 筆完成訂單(booking1)'
);

select throws_ok(
  $$select get_staff_commission_summary('e1420000-0000-4000-8000-000000000041'::uuid, 2026, 11)$$,
  '42501', null,
  '規則 2.4(核心必測):X 查詢服務人員 Y 的抽成報表被擋下,即使自己有 staff_payroll_view 權限也一樣'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e1420000-0000-4000-8000-000000000003'); -- Y(月薪制,自己查自己)

select lives_ok(
  $$select get_staff_monthly_payroll_summary('e1420000-0000-4000-8000-000000000041'::uuid, 2026, 11)$$,
  '3.17:Y 自助查詢自己 2026-11 的薪資報表成功'
);

select throws_ok(
  $$select get_staff_monthly_payroll_summary('e1420000-0000-4000-8000-000000000040'::uuid, 2026, 11)$$,
  '42501', null,
  '規則 2.4(核心必測):Y 查詢服務人員 X 的薪資報表被擋下'
);

select pg_temp.test_clear_auth();

-- 既有商家管理員行為不受影響(可以查任何人)。
select pg_temp.test_set_auth('e1420000-0000-4000-8000-000000000001');
select lives_ok(
  $$select get_staff_commission_summary('e1420000-0000-4000-8000-000000000040'::uuid, 2026, 11)$$,
  '3.17:既有商家管理員行為不受疊加影響,仍能查詢任一服務人員的抽成報表'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- 3.16:update_my_staff_profile。
-- =========================================================================
select pg_temp.test_set_auth('e1420000-0000-4000-8000-000000000002'); -- X

select lives_ok(
  $$select update_my_staff_profile('e1420000-0000-4000-8000-000000000040'::uuid, '服務人員X改名', '阿X', '0922000000', 'x-contact@test.local', null, '自我介紹')$$,
  '3.16:X 自助編輯自己的個人資料成功'
);

select is(
  (select row(name, nickname, phone, contact_email, intro) from merchant_staff where id = 'e1420000-0000-4000-8000-000000000040')::text,
  row('服務人員X改名', '阿X', '0922000000', 'x-contact@test.local', '自我介紹')::text,
  '3.16:六個欄位(除頭像外)正確更新'
);

select is(
  (select compensation_type from merchant_staff where id = 'e1420000-0000-4000-8000-000000000040'),
  'piece_rate',
  '規則 2.7:函式簽章不接受 compensation_type 參數,呼叫後其餘欄位完全不受影響'
);

select throws_ok(
  $$select update_my_staff_profile('e1420000-0000-4000-8000-000000000040'::uuid, '', null, null, null, null, null)$$,
  null, null,
  '3.16:姓名不可為空白字串'
);

select throws_ok(
  $$select update_my_staff_profile('e1420000-0000-4000-8000-000000000042'::uuid, '偷改Z的名字', null, null, null, null, null)$$,
  '42501', null,
  '規則 2.4(核心必測):X 不能透過 update_my_staff_profile 修改服務人員 Z 的資料'
);

select pg_temp.test_clear_auth();

-- 規則 2.8:未開通 staff_profile_edit 的服務人員可以讀到自己的資料,但無法編輯。
select pg_temp.test_set_auth('e1420000-0000-4000-8000-000000000001'); -- 管理員關閉 Z 的編輯權限
select set_staff_permission('e1420000-0000-4000-8000-000000000042'::uuid, 'staff_profile_edit', false);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e1420000-0000-4000-8000-000000000004'); -- Z
select is(
  (select count(*)::int from merchant_staff where id = 'e1420000-0000-4000-8000-000000000042'),
  1,
  '規則 2.8:未開通 staff_profile_edit 的 Z 仍然可以讀到自己的資料'
);
select throws_ok(
  $$select update_my_staff_profile('e1420000-0000-4000-8000-000000000042'::uuid, 'Z想自己改名', null, null, null, null, null)$$,
  '42501', null,
  '規則 2.8:未開通 staff_profile_edit 的 Z 無法編輯自己的資料'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- 3.20:頭像自助上傳 Storage 政策隔離(核心必測)。用 storage.objects 直接測 RLS(不經過
-- Storage API 網路層,純測政策邏輯本身)。
--
-- 實測踩過的兩個坑(記錄下來避免之後改測試的人重踩):
--   1. UPDATE/DELETE 的 RLS「USING」子句只決定「這一列對這個角色而言看不看得見/動不動得到」,
--      看不到時是「靜默影響 0 筆」,不是拋出例外——只有 INSERT 的「WITH CHECK」失敗才會真的
--      raise 例外。所以「X 想改/刪 Z 的頭像」這兩個情境不能用 throws_ok,要改成執行完全不報錯
--      (lives_ok)、但實際檢查那一筆資料原封不動(受影響筆數 = 0)。
--   2. storage.objects 這張表本身有一個跟本模組無關的既有保護觸發器 protect_delete()——本機/
--      正式環境預設完全擋下任何直接 DELETE(不管是誰、RLS 政策通不通過都一樣先擋下,
--      errcode 剛好也是 42501,容易誤以為是我們自己的 RLS 政策生效),必須先
--      set_config('storage.allow_delete_query','true',true) 繞過這個全域保護,才測得到
--      本模組 RLS 政策本身真正的隔離效果。
-- =========================================================================
select pg_temp.test_set_auth('e1420000-0000-4000-8000-000000000002'); -- X

select lives_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('staff-avatars', 'e1420000-0000-4000-8000-000000000020/self/e1420000-0000-4000-8000-000000000040/avatar.png')$$,
  '3.20:X 可以上傳自己 self/<staff_id>/ 路徑底下的頭像'
);

select lives_ok(
  $$update storage.objects set name = 'e1420000-0000-4000-8000-000000000020/self/e1420000-0000-4000-8000-000000000040/avatar2.png'
    where bucket_id = 'staff-avatars' and name = 'e1420000-0000-4000-8000-000000000020/self/e1420000-0000-4000-8000-000000000040/avatar.png'$$,
  '3.20:X 可以更新自己路徑底下的頭像檔案'
);

select is(
  (select count(*)::int from storage.objects where name = 'e1420000-0000-4000-8000-000000000020/self/e1420000-0000-4000-8000-000000000040/avatar2.png'),
  1,
  '3.20:X 剛才的更新真的生效(改名成功)'
);

select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('staff-avatars', 'e1420000-0000-4000-8000-000000000020/self/e1420000-0000-4000-8000-000000000042/hacked.png')$$,
  '42501', null,
  '規則 2.4(核心必測)/3.20:X 無法把檔案寫進服務人員 Z 的 self 路徑底下(INSERT 的 WITH CHECK 失敗會真的拋出例外)'
);

select pg_temp.test_clear_auth();

-- 先用超級使用者身分放兩筆「不是 X 的」檔案:Z 自己的頭像 + 既有管理員上傳路徑(沒有 /self/
-- 這一層),再用 X 的身分嘗試覆蓋/刪除,驗證核心隔離。
insert into storage.objects (bucket_id, name) values
  ('staff-avatars', 'e1420000-0000-4000-8000-000000000020/self/e1420000-0000-4000-8000-000000000042/z-avatar.png'),
  ('staff-avatars', 'e1420000-0000-4000-8000-000000000020/admin-uploaded.png');

select pg_temp.test_set_auth('e1420000-0000-4000-8000-000000000002'); -- X

select lives_ok(
  $$update storage.objects set name = 'e1420000-0000-4000-8000-000000000020/self/e1420000-0000-4000-8000-000000000042/z-overwritten.png'
    where bucket_id = 'staff-avatars' and name = 'e1420000-0000-4000-8000-000000000020/self/e1420000-0000-4000-8000-000000000042/z-avatar.png'$$,
  '3.20:X 對 Z 的頭像下 UPDATE 陳述式本身不會報錯(RLS 用 USING 靜默過濾,不是拋例外)'
);

select is(
  (select count(*)::int from storage.objects where name = 'e1420000-0000-4000-8000-000000000020/self/e1420000-0000-4000-8000-000000000042/z-avatar.png'),
  1,
  '3.20(核心必測):實際檢查——Z 的頭像檔名完全沒被 X 改動,證明剛才的 UPDATE 實際影響 0 筆'
);

-- 繞過 protect_delete() 全域保護觸發器,才能真正測到本模組 RLS 政策的隔離效果(見上方說明 2)。
select set_config('storage.allow_delete_query', 'true', true);

select lives_ok(
  $$delete from storage.objects
    where bucket_id = 'staff-avatars' and name = 'e1420000-0000-4000-8000-000000000020/self/e1420000-0000-4000-8000-000000000042/z-avatar.png'$$,
  '3.20:X 對 Z 的頭像下 DELETE 陳述式本身不會報錯(同樣是 RLS 靜默過濾)'
);

select is(
  (select count(*)::int from storage.objects where name = 'e1420000-0000-4000-8000-000000000020/self/e1420000-0000-4000-8000-000000000042/z-avatar.png'),
  1,
  '3.20(核心必測):實際檢查——Z 的頭像檔案完全沒被刪除,證明剛才的 DELETE 實際影響 0 筆'
);

select lives_ok(
  $$delete from storage.objects
    where bucket_id = 'staff-avatars' and name = 'e1420000-0000-4000-8000-000000000020/admin-uploaded.png'$$,
  '3.20:X 對既有管理員上傳路徑(沒有 /self/ 這一層)下 DELETE 陳述式本身不會報錯'
);

select is(
  (select count(*)::int from storage.objects where name = 'e1420000-0000-4000-8000-000000000020/admin-uploaded.png'),
  1,
  '3.20:實際檢查——既有管理員上傳的檔案完全沒被 X 刪除,X 的自助政策不會誤放行沒有 /self/ 這一層的路徑'
);

select pg_temp.test_clear_auth();

-- 公開讀取政策完全不受影響。
select pg_temp.test_set_auth('e1420000-0000-4000-8000-000000000002');
select is(
  (select count(*)::int from storage.objects where bucket_id = 'staff-avatars'),
  3,
  '3.20:既有公開讀取政策(staff_avatars_public_read)不受影響,任何登入者都能讀到 bucket 內所有物件(X 的頭像 1 筆 + Z 的頭像 1 筆 + 既有管理員上傳路徑 1 筆,三筆全部原封不動)'
);
select pg_temp.test_clear_auth();

select * from finish();

rollback;
