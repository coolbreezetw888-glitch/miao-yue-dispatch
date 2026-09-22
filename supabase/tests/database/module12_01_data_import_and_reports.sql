-- 模組 12(資料匯入/報表匯出，含產業轉移機制)— 對應規格書
-- .project/specs/資料匯入與報表匯出.md §1.1~§1.3、§2.1~§2.11(核心必測)、§3.1~§3.9。
-- 涵蓋:兩張新表 CHECK 約束、bookings.source 擴充、僅限管理員邊界(2.1)、電話必填沿用(2.2)、
-- 兩種寫入模式(2.5)、起始點數走既有函式(2.6)、不檢查排程衝突(2.3 核心)、不觸發抽成/紅利(2.4
-- 核心)、復原機制與安全檢查(2.7/2.8 核心)、報表匯出權限不繞過來源模組(2.9)、產業轉移安全邊界
-- (2.10 核心)、轉移後訂單連結斷開(2.11 核心)、3.7/3.8 唯讀查詢。
begin;

select plan(59);

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
-- Fixture
-- =========================================================================
insert into auth.users (id, email) values
  ('ec000000-0000-4000-8000-000000000001', 'pgtap-m12-admin-a@test.local'),
  ('ec000000-0000-4000-8000-000000000002', 'pgtap-m12-admin-b@test.local'),
  ('ec000000-0000-4000-8000-000000000003', 'pgtap-m12-admin-c@test.local'),
  ('ec000000-0000-4000-8000-000000000004', 'pgtap-m12-agent-none@test.local'),
  ('ec000000-0000-4000-8000-000000000005', 'pgtap-m12-agent-report@test.local'),
  ('ec000000-0000-4000-8000-000000000006', 'pgtap-m12-platform-admin@test.local');

insert into groups (id) values
  ('ec000000-0000-4000-8000-000000000011'),
  ('ec000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000011', '資料匯入測試A店', 'in_store_beauty'),
  ('ec000000-0000-4000-8000-000000000022', 'ec000000-0000-4000-8000-000000000011', '資料匯入測試B店(同集團)', 'in_store_beauty'),
  ('ec000000-0000-4000-8000-000000000023', 'ec000000-0000-4000-8000-000000000012', '資料匯入測試C店(不同集團)', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000001'),
  ('ec000000-0000-4000-8000-000000000022', 'ec000000-0000-4000-8000-000000000002'),
  ('ec000000-0000-4000-8000-000000000023', 'ec000000-0000-4000-8000-000000000003');

insert into platform_admins (user_id) values ('ec000000-0000-4000-8000-000000000006');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'ec000000-0000-4000-8000-000000000021', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('ec000000-0000-4000-8000-000000000031', 'ec000000-0000-4000-8000-000000000021', '洗髮', 500, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, compensation_type) values
  ('ec000000-0000-4000-8000-000000000041', 'ec000000-0000-4000-8000-000000000021', '匯入測試服務人員P', '0901000101', true, 'piece_rate');

insert into merchant_payroll_settings (merchant_id, commission_basis_type)
values ('ec000000-0000-4000-8000-000000000021', 'gross');

insert into merchant_member_settings (merchant_id, points_earn_rate, referral_bonus_points, birthday_bonus_points)
values ('ec000000-0000-4000-8000-000000000021', 100, 0, 0);

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('ec000000-0000-4000-8000-000000000051', 'ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000004', '客服-無授權', 'pgtap-m12-agent-none@test.local', 'active', now(), '0900000101'),
  ('ec000000-0000-4000-8000-000000000052', 'ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000005', '客服-report_export', 'pgtap-m12-agent-report@test.local', 'active', now(), '0900000102');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('ec000000-0000-4000-8000-000000000052', 'report_export', true);

-- =========================================================================
-- ① §1.1/1.2/1.3:CHECK 約束、bookings.source 擴充。
-- =========================================================================
select throws_ok(
  $$insert into merchant_bulk_operations (merchant_id, operation_type)
    values ('ec000000-0000-4000-8000-000000000021', 'not_a_real_type')$$,
  '23514', null,
  '1.1:operation_type CHECK 約束擋下不合法的值'
);

select throws_ok(
  $$insert into merchant_bulk_operations (merchant_id, operation_type, write_mode)
    values ('ec000000-0000-4000-8000-000000000021', 'member_import', 'not_a_mode')$$,
  '23514', null,
  '1.1:write_mode CHECK 約束擋下不合法的值'
);

select throws_ok(
  $$insert into merchant_bulk_operations (merchant_id, operation_type, status)
    values ('ec000000-0000-4000-8000-000000000021', 'member_import', 'not_a_status')$$,
  '23514', null,
  '1.1:status CHECK 約束擋下不合法的值'
);

insert into merchant_bulk_operations (id, merchant_id, operation_type)
values ('ec000000-0000-4000-8000-000000000900', 'ec000000-0000-4000-8000-000000000021', 'member_import');

select throws_ok(
  $$insert into merchant_bulk_operation_items (operation_id, entity_table, entity_id, action)
    values ('ec000000-0000-4000-8000-000000000900', 'not_a_table', gen_random_uuid(), 'created')$$,
  '23514', null,
  '1.2:entity_table CHECK 約束擋下不合法的值'
);

select throws_ok(
  $$insert into merchant_bulk_operation_items (operation_id, entity_table, entity_id, action)
    values ('ec000000-0000-4000-8000-000000000900', 'members', gen_random_uuid(), 'not_an_action')$$,
  '23514', null,
  '1.2:action CHECK 約束擋下不合法的值'
);

delete from merchant_bulk_operations where id = 'ec000000-0000-4000-8000-000000000900';

select lives_ok(
  format($$update bookings set source = 'import' where false$$),
  '1.3:bookings.source 擴充後 ''import'' 是合法值(語法層級確認，不影響任何列)'
);

select throws_ok(
  $$insert into bookings (merchant_id, staff_id, customer_name, customer_phone, start_at, end_at, source, created_by_role)
    values ('ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000041', '約束測試', '0900000000', now(), now() + interval '1 hour', 'not_a_source', 'admin')$$,
  '23514', null,
  '1.3:bookings.source 仍然擋下 import/manual/smart/customer 以外的值'
);

-- =========================================================================
-- ② 規則 2.1(核心):僅限商家管理員，客服(含被授權 report_export 者)一律被擋下。
-- =========================================================================
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000004');
select throws_ok(
  $$select import_members_batch('ec000000-0000-4000-8000-000000000021', 'insert_only', '[]'::jsonb)$$,
  '42501', null,
  '2.1:無授權客服呼叫 import_members_batch 被擋下'
);
select throws_ok(
  $$select import_historical_bookings_batch('ec000000-0000-4000-8000-000000000021', '[]'::jsonb)$$,
  '42501', null,
  '2.1:無授權客服呼叫 import_historical_bookings_batch 被擋下'
);
select throws_ok(
  $$select transfer_members_to_merchant('ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000022', array[gen_random_uuid()])$$,
  '42501', null,
  '2.1:無授權客服呼叫 transfer_members_to_merchant 被擋下'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000005');
select throws_ok(
  $$select import_members_batch('ec000000-0000-4000-8000-000000000021', 'insert_only', '[]'::jsonb)$$,
  '42501', null,
  '2.1:被授權 report_export 的客服呼叫 import_members_batch 依然被擋下(對照組:report_export 不能繞過管理員限制)'
);
select throws_ok(
  $$select transfer_members_to_merchant('ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000022', array[gen_random_uuid()])$$,
  '42501', null,
  '2.1:被授權 report_export 的客服呼叫 transfer_members_to_merchant 依然被擋下'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ③ 規則 2.9:report_export 只控制畫面開關，不繞過來源模組本身的權限邊界。
-- =========================================================================
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000005');
select throws_ok(
  $$select get_merchant_billing_summary('ec000000-0000-4000-8000-000000000021', 2026, 1)$$,
  '42501', null,
  '2.9:被授權 report_export、但沒有 billing/staff_report 權限的客服，呼叫帳務報表仍被擋下'
);
select is(
  (select count(*)::int from members where merchant_id = 'ec000000-0000-4000-8000-000000000021'),
  0,
  '2.9:被授權 report_export、但沒有 members 權限的客服，直接查 members 表仍是 0 筆(RLS 沒有被繞過)'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ④ 規則 2.2:電話必填政策沿用(merchant_member_settings 預設 phone_required_to_create=true)。
-- ⑤ 規則 2.5:insert_only / upsert_by_phone 兩種寫入模式。
-- ⑥ 規則 2.6:起始點數餘額走既有 adjust_member_points。
-- =========================================================================
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');

select import_members_batch(
  'ec000000-0000-4000-8000-000000000021',
  'insert_only',
  jsonb_build_array(
    jsonb_build_object('row_number', 1, 'name', '匯入會員甲', 'phone', '0911100001', 'starting_points_balance', 200),
    jsonb_build_object('row_number', 2, 'name', '缺電話會員', 'phone', null),
    jsonb_build_object('row_number', 3, 'name', '匯入會員乙', 'phone', '0911100002', 'starting_points_balance', -50)
  )
) \gset op1_

-- 3 筆資料:甲(有電話+正數起始點數)成功；缺電話這筆因為 phone_required_to_create=true 失敗；
-- 乙(負數起始點數)因為規則 2.6 邊界情況失敗。預期 success=1、failed=2、skipped=0。
select is(
  (select row(total_rows, success_rows, failed_rows, skipped_duplicate_rows) from merchant_bulk_operations where id = :'op1_import_members_batch'::uuid)::text,
  row(3, 1, 2, 0)::text,
  '2.2/2.6/3.1:3 筆資料，甲成功(1)，缺電話+負數起始點數各失敗(共 2)，單列失敗不影響其他列，都不計入略過'
);

select is(
  jsonb_array_length((select error_report from merchant_bulk_operations where id = :'op1_import_members_batch'::uuid)),
  2,
  '2.2/2.6:error_report 正確記錄 2 筆失敗(缺電話、負數起始點數)的原因'
);

select id from members where merchant_id = 'ec000000-0000-4000-8000-000000000021' and phone = '0911100001' \gset member_甲_

select is(
  (select points_balance from members where id = :'member_甲_id'::uuid),
  200,
  '2.6:起始點數餘額透過 adjust_member_points 正確寫入 points_balance'
);

select is(
  (select row(transaction_type, points_delta) from member_point_transactions where member_id = :'member_甲_id'::uuid)::text,
  row('manual_adjustment', 200)::text,
  '2.6:起始點數在 member_point_transactions 正確產生一筆 manual_adjustment 分類帳紀錄'
);

select is(
  (select count(*)::int from members where merchant_id = 'ec000000-0000-4000-8000-000000000021' and name = '匯入會員乙'),
  0,
  '2.6:負數起始點數的資料列正確被記錄為失敗，不寫入會員'
);

-- insert_only 模式:同一支電話再匯入一次，應該被略過，不修改既有資料。
select import_members_batch(
  'ec000000-0000-4000-8000-000000000021',
  'insert_only',
  jsonb_build_array(
    jsonb_build_object('row_number', 1, 'name', '改名攻擊測試', 'phone', '0911100001')
  )
) \gset op2_

select is(
  (select row(success_rows, failed_rows, skipped_duplicate_rows) from merchant_bulk_operations where id = :'op2_import_members_batch'::uuid)::text,
  row(0, 0, 1)::text,
  '2.5.1:insert_only 模式下，電話重複的資料列正確略過(不計入失敗也不計入成功)'
);

select is(
  (select name from members where id = :'member_甲_id'::uuid),
  '匯入會員甲',
  '2.5.1:insert_only 模式下重複電話不會修改既有會員的任何資料'
);

-- upsert_by_phone 模式:同一支電話應該更新既有會員。
select import_members_batch(
  'ec000000-0000-4000-8000-000000000021',
  'upsert_by_phone',
  jsonb_build_array(
    jsonb_build_object('row_number', 1, 'name', '匯入會員甲(改名)', 'phone', '0911100001', 'notes', '更新測試')
  )
) \gset op3_

select is(
  (select row(name, notes) from members where id = :'member_甲_id'::uuid)::text,
  row('匯入會員甲(改名)', '更新測試')::text,
  '2.5.2:upsert_by_phone 模式下，電話重複時正確更新既有會員資料'
);

select is(
  (select pre_operation_snapshot -> 'members' -> :'member_甲_id' ->> 'name' from merchant_bulk_operations where id = :'op3_import_members_batch'::uuid),
  '匯入會員甲',
  '2.7:upsert_by_phone 模式的 pre_operation_snapshot 正確記錄更新前的原始姓名'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑦ 規則 2.3(核心必測):歷史訂單匯入不檢查排程衝突，且不影響既有排程驗證邏輯。
-- =========================================================================
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');

-- 先建立一筆真實的預約，佔用 P 服務人員 2026-11-01 10:00-10:30。
select id from create_booking(
  p_merchant_id => 'ec000000-0000-4000-8000-000000000021',
  p_staff_id => 'ec000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id', 'ec000000-0000-4000-8000-000000000031', 'quantity', 1, 'unit_price', 500)),
  p_start_at => '2026-11-01 10:00:00+08',
  p_customer_name => '既有真實訂單',
  p_customer_phone => '0922200001'
) \gset real_booking_

-- 匯入一筆跟這筆真實預約完全重疊時段、同一位服務人員的歷史訂單，應該要成功(不做衝突檢查)。
select import_historical_bookings_batch(
  'ec000000-0000-4000-8000-000000000021',
  jsonb_build_array(
    jsonb_build_object(
      'row_number', 1,
      'customer_name', '歷史重疊訂單',
      'customer_phone', '0922200002',
      'staff_id', 'ec000000-0000-4000-8000-000000000041',
      'start_at', '2026-11-01T10:00:00+08:00',
      'duration_minutes', 30,
      'status', '已完成',
      'final_amount', 800
    )
  )
) \gset op4_

select is(
  (select success_rows from merchant_bulk_operations where id = :'op4_import_historical_bookings_batch'::uuid),
  1,
  '2.3(核心):跟既有預約完全重疊時段的歷史訂單成功匯入，沒有被排程衝突驗證擋下'
);

-- 匯入完成後，重新確認既有的 create_booking 排程衝突驗證邏輯仍然正常運作，不受匯入影響。
select throws_ok(
  format($$select create_booking(
    p_merchant_id => 'ec000000-0000-4000-8000-000000000021',
    p_staff_id => 'ec000000-0000-4000-8000-000000000041',
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ec000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
    p_start_at => '2026-11-01 10:00:00+08',
    p_customer_name => '衝突測試',
    p_customer_phone => '0922200003'
  )$$),
  'P0001', null,
  '2.3(核心):匯入之後，同一服務人員同一時段再用 create_booking 建立真實訂單，仍然正常被既有排程衝突驗證擋下(互不干擾)'
);

select ok(
  (select service_description_snapshot is null and source = 'import'
   from bookings where customer_phone = '0922200002'),
  '3.4:歷史匯入訂單的 source 正確標記為 import'
);

-- =========================================================================
-- ⑧ 規則 2.4(核心必測):歷史訂單匯入不觸發抽成/紅利點數計算。
-- =========================================================================
select import_members_batch(
  'ec000000-0000-4000-8000-000000000021',
  'insert_only',
  jsonb_build_array(jsonb_build_object('row_number', 1, 'name', '抽成測試會員', 'phone', '0933300001'))
) \gset op5_
select id from members where phone = '0933300001' \gset commission_member_

select import_historical_bookings_batch(
  'ec000000-0000-4000-8000-000000000021',
  jsonb_build_array(
    jsonb_build_object(
      'row_number', 1,
      'customer_name', '抽成/紅利測試訂單',
      'customer_phone', '0933300001',
      'member_phone', '0933300001',
      'staff_id', 'ec000000-0000-4000-8000-000000000041',
      'start_at', '2026-11-02T10:00:00+08:00',
      'duration_minutes', 60,
      'status', 'completed',
      'final_amount', 1000
    )
  )
) \gset op6_

select id from bookings where customer_phone = '0933300001' and source = 'import' \gset commission_booking_

select is(
  (select count(*)::int from booking_commission_records where booking_id = :'commission_booking_id'::uuid),
  0,
  '2.4(核心):匯入 completed 狀態的歷史訂單，完全不會產生 booking_commission_records'
);

select is(
  (select count(*)::int from member_point_transactions where booking_id = :'commission_booking_id'::uuid),
  0,
  '2.4(核心):匯入 completed 狀態、且有連結會員的歷史訂單，完全不會產生 member_point_transactions(紅利點數)'
);

select is(
  (select member_id from bookings where id = :'commission_booking_id'::uuid),
  :'commission_member_id'::uuid,
  '3.4:歷史訂單匯入正確依電話比對連結到既有會員'
);

-- 對照組:正常走 create_booking + complete_booking 的真實訂單，抽成/紅利依然正常計算。
select id from create_booking(
  p_merchant_id => 'ec000000-0000-4000-8000-000000000021',
  p_staff_id => 'ec000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ec000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-03 10:00:00+08',
  p_customer_name => '對照組真實訂單',
  p_customer_phone => '0933300002',
  p_member_id => :'commission_member_id'::uuid
) \gset control_booking_

select confirm_booking(:'control_booking_id'::uuid);
select complete_booking(:'control_booking_id'::uuid);

select is(
  (select count(*)::int from booking_commission_records where booking_id = :'control_booking_id'::uuid),
  1,
  '2.4(對照組):正常完成的真實訂單，抽成計算完全不受歷史匯入邏輯影響，正常產生 1 筆抽成紀錄'
);

select is(
  (select count(*)::int from member_point_transactions where booking_id = :'control_booking_id'::uuid and transaction_type = 'earn_booking'),
  1,
  '2.4(對照組):正常完成的真實訂單，紅利點數計算完全不受歷史匯入邏輯影響，正常產生 1 筆 earn_booking 紀錄'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑨ 規則 2.7/2.8(核心必測):復原機制與安全檢查。
-- =========================================================================
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');

-- (a) member_import:一筆全新會員完全沒被動過 -> 可以完整復原(刪除)。
--     另一筆全新會員之後被用在真實訂單上 -> 應該被跳過。
select import_members_batch(
  'ec000000-0000-4000-8000-000000000021',
  'insert_only',
  jsonb_build_array(
    jsonb_build_object('row_number', 1, 'name', '復原測試-乾淨', 'phone', '0944400001'),
    jsonb_build_object('row_number', 2, 'name', '復原測試-已使用', 'phone', '0944400002')
  )
) \gset op7_
select id from members where phone = '0944400001' \gset rollback_clean_member_
select id from members where phone = '0944400002' \gset rollback_used_member_

select create_booking(
  p_merchant_id => 'ec000000-0000-4000-8000-000000000021',
  p_staff_id => 'ec000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ec000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-04 10:00:00+08',
  p_customer_name => '佔用復原測試會員的真實訂單',
  p_customer_phone => '0944400099',
  p_member_id => :'rollback_used_member_id'::uuid
);

select rollback_bulk_operation(:'op7_import_members_batch'::uuid) \gset rollback1_result_

select is(
  (:'rollback1_result_rollback_bulk_operation'::jsonb ->> 'restored_count')::int,
  1,
  '2.8①:member_import 復原，乾淨未被動過的會員成功復原(刪除)，計入 restored_count'
);
select is(
  (:'rollback1_result_rollback_bulk_operation'::jsonb ->> 'skipped_count')::int,
  1,
  '2.8①:member_import 復原，已被用在真實訂單上的會員正確跳過'
);
select is(
  (select count(*)::int from members where id = :'rollback_clean_member_id'::uuid),
  0,
  '2.8①:乾淨的會員確實被刪除'
);
select is(
  (select count(*)::int from members where id = :'rollback_used_member_id'::uuid),
  1,
  '2.8①:已被使用的會員沒有被強行刪除，資料保留'
);
select is(
  (select status from merchant_bulk_operations where id = :'op7_import_members_batch'::uuid),
  'rolled_back',
  '2.8④:復原完成後，batch 狀態正確更新為 rolled_back'
);

-- (b) 同一個批次不能復原兩次。
select throws_ok(
  format($$select rollback_bulk_operation('%s')$$, (:'op7_import_members_batch')),
  'P0001', null,
  '2.8⑤:已經復原過的批次，再次呼叫 rollback_bulk_operation 被擋下'
);

-- (c) member_import upsert_by_phone:未被動過的更新可以復原；已被編輯過的更新應該跳過。
select import_members_batch(
  'ec000000-0000-4000-8000-000000000021',
  'upsert_by_phone',
  jsonb_build_array(
    jsonb_build_object('row_number', 1, 'name', '更新復原測試-乾淨(匯入後)', 'phone', '0911100001'),
    jsonb_build_object('row_number', 2, 'name', '更新復原測試-之後被編輯(匯入後)', 'phone', '0933300001')
  )
) \gset op8_

-- 匯入後，其中一位又被手動編輯(模擬管理員自己改了資料)。注意:這整支 pgTAP 測試檔案從頭到尾
-- 包在同一個 begin/rollback 交易裡，Postgres 的 now() 在同一交易內是常數，直接呼叫
-- update_member 沒辦法產生一個「比 op8 這個批次晚」的 updated_at(在真實環境每一次 RPC 呼叫是
-- 各自獨立的交易，這個問題不存在)。這裡刻意暫時關閉 set_updated_at trigger，改用能自訂
-- updated_at 的原始 UPDATE 語法，模擬「匯入後過了一段時間才被人工編輯」的真實情境，測完立刻
-- 恢復 trigger，不影響其他測試。
select pg_temp.test_clear_auth();
alter table public.members disable trigger members_set_updated_at;
update public.members
set name = '之後被編輯的最終姓名', phone = '0933300001', updated_at = now() + interval '1 second'
where id = :'commission_member_id'::uuid;
alter table public.members enable trigger members_set_updated_at;
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');

select rollback_bulk_operation(:'op8_import_members_batch'::uuid) \gset rollback2_result_

select is(
  (:'rollback2_result_rollback_bulk_operation'::jsonb ->> 'restored_count')::int,
  1,
  '2.8①(更新情境):未被動過的更新正確復原'
);
select is(
  (:'rollback2_result_rollback_bulk_operation'::jsonb ->> 'skipped_count')::int,
  1,
  '2.8①(更新情境):匯入後又被編輯過的會員正確跳過，不會強行覆蓋掉之後的編輯'
);
select is(
  (select name from members where id = :'member_甲_id'::uuid),
  '匯入會員甲(改名)',
  '2.8①(更新情境):未被動過的會員正確還原成匯入前的姓名'
);
select is(
  (select name from members where id = :'commission_member_id'::uuid),
  '之後被編輯的最終姓名',
  '2.8①(更新情境):匯入後又被編輯過的會員，維持編輯後的最終狀態，沒有被復原蓋掉'
);

-- (d) historical_booking_import:未被動過的可以復原；被人工編輯過的應該跳過。
select import_historical_bookings_batch(
  'ec000000-0000-4000-8000-000000000021',
  jsonb_build_array(
    jsonb_build_object('row_number', 1, 'customer_name', '訂單復原-乾淨', 'customer_phone', '0955500001', 'staff_id', 'ec000000-0000-4000-8000-000000000041', 'start_at', '2026-11-05T09:00:00+08:00', 'status', 'completed', 'final_amount', 500),
    jsonb_build_object('row_number', 2, 'customer_name', '訂單復原-之後被編輯', 'customer_phone', '0955500002', 'staff_id', 'ec000000-0000-4000-8000-000000000041', 'start_at', '2026-11-05T11:00:00+08:00', 'status', 'completed', 'final_amount', 600)
  )
) \gset op9_
select id from bookings where customer_phone = '0955500001' \gset booking_rollback_clean_
select id from bookings where customer_phone = '0955500002' \gset booking_rollback_edited_

-- 同樣的道理(見上方 members 的說明):直接關閉 trigger 自訂 updated_at，模擬「匯入後過了
-- 一段時間才被人工編輯」。
select pg_temp.test_clear_auth();
alter table public.bookings disable trigger bookings_set_updated_at;
update public.bookings
set customer_notes = '匯入後人工補充備註', updated_at = now() + interval '1 second'
where id = :'booking_rollback_edited_id'::uuid;
alter table public.bookings enable trigger bookings_set_updated_at;
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');

select rollback_bulk_operation(:'op9_import_historical_bookings_batch'::uuid) \gset rollback3_result_

select is(
  (:'rollback3_result_rollback_bulk_operation'::jsonb ->> 'restored_count')::int,
  1,
  '2.8②(歷史訂單情境):未被動過的匯入訂單正確復原(刪除)'
);
select is(
  (:'rollback3_result_rollback_bulk_operation'::jsonb ->> 'skipped_count')::int,
  1,
  '2.8②(歷史訂單情境):匯入後被人工編輯過的訂單正確跳過'
);
select is(
  (select count(*)::int from bookings where id = :'booking_rollback_clean_id'::uuid),
  0,
  '2.8②:乾淨的匯入訂單確實被刪除'
);
select is(
  (select count(*)::int from bookings where id = :'booking_rollback_edited_id'::uuid),
  1,
  '2.8②:被編輯過的匯入訂單沒有被強行刪除'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑩ 規則 2.10(核心必測):產業轉移安全邊界。
-- =========================================================================
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');
select id from create_member('ec000000-0000-4000-8000-000000000021', '轉移測試會員1', '0966600001') \gset transfer_member1_
select id from create_member('ec000000-0000-4000-8000-000000000021', '轉移測試會員2', '0966600002') \gset transfer_member2_

-- ①只是來源商家管理員，不是目標商家管理員 -> 被擋下(目標商家 C，A 的管理員不是 C 的管理員)。
select throws_ok(
  format($$select transfer_members_to_merchant('ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000023', array['%s'::uuid])$$, (:'transfer_member1_id')),
  '42501', null,
  '2.10①(核心):呼叫者只是來源商家管理員、不是目標商家管理員時被擋下'
);
select pg_temp.test_clear_auth();

-- ②兩間商家不同集團 -> 被擋下(用平台管理員身份繞過 admin 檢查，單獨測集團檢查)。
-- 改用 admin_a 同時也是... 這裡改成讓 admin_c 也把自己加成 A 的管理員，純粹測「集團」檢查本身。
insert into merchant_admins (merchant_id, user_id) values ('ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000003');
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000003');
select throws_ok(
  format($$select transfer_members_to_merchant('ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000023', array['%s'::uuid])$$, (:'transfer_member1_id')),
  'P0001', null,
  '2.10②(核心):兩間商家不屬於同一個集團時被擋下，即使呼叫者同時是兩間商家的管理員'
);
select pg_temp.test_clear_auth();
delete from merchant_admins where merchant_id = 'ec000000-0000-4000-8000-000000000021' and user_id = 'ec000000-0000-4000-8000-000000000003';

-- ③同一集團、呼叫者同時是兩間商家管理員 -> 成功(A -> B，同集團)。
insert into merchant_admins (merchant_id, user_id) values ('ec000000-0000-4000-8000-000000000022', 'ec000000-0000-4000-8000-000000000001');
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');

-- =========================================================================
-- ⑪ 規則 2.11(核心必測):轉移後訂單連結斷開，姓名快照保留。
-- =========================================================================
select id from create_booking(
  p_merchant_id => 'ec000000-0000-4000-8000-000000000021',
  p_staff_id => 'ec000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ec000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-06 10:00:00+08',
  p_customer_name => '轉移前既有訂單',
  p_customer_phone => '0966600099',
  p_member_id => :'transfer_member1_id'::uuid
) \gset transfer_related_booking_

select transfer_members_to_merchant(
  'ec000000-0000-4000-8000-000000000021',
  'ec000000-0000-4000-8000-000000000022',
  array[:'transfer_member1_id'::uuid, :'transfer_member2_id'::uuid]
) \gset op10_

select is(
  (select merchant_id from members where id = :'transfer_member1_id'::uuid),
  'ec000000-0000-4000-8000-000000000022'::uuid,
  '2.10③(核心):同一集團、雙邊管理員身份都滿足時，會員成功搬到目標商家'
);

select is(
  (select points_balance from members where id = :'transfer_member1_id'::uuid),
  0,
  '判斷 7:搬遷只是資料搬家，points_balance 完全不變(這裡沒有預先加點，維持 0 也代表沒有被意外歸零/累加)'
);

select is(
  (select row(member_id, member_name_snapshot) from bookings where id = :'transfer_related_booking_id'::uuid)::text,
  row(null, '轉移測試會員1')::text,
  '2.11(核心):轉移後，舊商家該會員的歷史訂單 member_id 設為 null，但 member_name_snapshot 文字保留'
);

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000002');
select is(
  (select count(*)::int from get_member_related_bookings(:'transfer_member1_id'::uuid) where id = :'transfer_related_booking_id'::uuid),
  0,
  '2.11(核心):新商家管理員透過搬過去的會員查詢相關訂單，查不到任何屬於舊商家的訂單(沒有跨商家資料外洩)'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑫ 3.7/3.8:唯讀查詢函式。
-- =========================================================================
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');
select ok(
  (select count(*)::int from get_merchant_bulk_operations('ec000000-0000-4000-8000-000000000021')) > 0,
  '3.7:商家管理員可以查詢自己商家的批次操作歷史'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000004');
select throws_ok(
  $$select * from get_merchant_bulk_operations('ec000000-0000-4000-8000-000000000021')$$,
  '42501', null,
  '3.7:一般客服(非管理員)呼叫 get_merchant_bulk_operations 被擋下'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000006');
select ok(
  (select count(*)::int from platform_list_merchant_bulk_operations('ec000000-0000-4000-8000-000000000021')) > 0,
  '3.8:平台管理員可以查詢任何商家的批次操作歷史'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000004');
select throws_ok(
  $$select * from platform_list_merchant_bulk_operations('ec000000-0000-4000-8000-000000000021')$$,
  '42501', null,
  '3.8:一般客服呼叫 platform_list_merchant_bulk_operations 被擋下'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑬ 一之二節:既有 RLS 政策定義完全沒有變動(比對政策內容字串，回歸驗證)。
-- =========================================================================
select is(
  (select pg_get_expr(polqual, polrelid)::text from pg_policy where polname = 'bookings_select'),
  'private.can_manage_bookings(merchant_id)',
  '一之二節:bookings_select 政策定義完全沒有變動'
);

select is(
  (select pg_get_expr(polqual, polrelid)::text from pg_policy where polname = 'members_select'),
  '(private.can_manage_members(merchant_id) OR private.can_manage_bookings(merchant_id))',
  '一之二節:members_select 政策定義完全沒有變動'
);

select is(
  (select pg_get_expr(polqual, polrelid)::text from pg_policy where polname = 'merchant_staff_select'),
  '(private.is_merchant_admin(merchant_id) OR private.can_manage_bookings(merchant_id) OR private.can_manage_team_leave(merchant_id) OR private.can_manage_commission_settings(merchant_id) OR private.can_view_payroll_reports(merchant_id) OR (user_id = auth.uid()))',
  '一之二節:merchant_staff_select 政策定義本模組沒有變動(2026-09-21 模組 14 服務人員端規格書 3.3 疊加了 or user_id = auth.uid() 分支,這裡的期望值已同步更新,不是本模組造成的變動)'
);

-- 新增兩張表的 RLS：沒有 INSERT/UPDATE/DELETE 政策，一般角色直接寫入被擋下。
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');
select throws_ok(
  $$insert into merchant_bulk_operations (merchant_id, operation_type) values ('ec000000-0000-4000-8000-000000000021', 'member_import')$$,
  '42501', null,
  '3.9:merchant_bulk_operations 沒有 INSERT 政策，一般角色直接 insert 被 RLS 擋下'
);
select pg_temp.test_clear_auth();

select * from finish();
rollback;
