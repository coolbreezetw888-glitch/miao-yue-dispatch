-- SPECS-INDEX #644:行事曆排程狀態顏色設定(全天休假/時段排休/跨店佔用)——
-- merchant_calendar_state_styles 資料表/預設值/種子函式/權限/update_merchant_calendar_state_styles/
-- 服務人員自助函式 get_my_calendar_state_styles/get_my_day_schedule_state。
--
-- ⚠️ 這支測試檔案是 engineer 實作階段隨手一併撰寫,尚未實際在本機 Docker 執行過(worktree 環境
-- 是多個 agent 共用同一個本機 Supabase 容器,直接跑 `supabase test db --local` 有覆蓋/干擾其他
-- 並行 agent 測試狀態的風險,這次刻意沒有執行,已在回報中向主腦說明,請 QA 或主腦找一個獨立的
-- 本機環境實際跑一次 `npm run test:db` 驗證)。
begin;

select plan(23);

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
-- Fixture:兩間商家(一店/二店,用於跨店佔用測試)、一店管理員、一店兩位客服(orders 授權/無授權)、
-- 一店服務人員 X(月薪制,用於 on_leave/partial_leave 測試)、服務人員 Z(隔離測試對象)、
-- 二店服務人員(電話跟一店 X 相同,代表「同一人跨店」,製造跨店佔用)。
-- =========================================================================
insert into auth.users (id, email) values
  ('c6440000-0000-4000-8000-000000000001', 'pgtap-m644-admin1@test.local'),
  ('c6440000-0000-4000-8000-000000000002', 'pgtap-m644-agent-orders@test.local'),
  ('c6440000-0000-4000-8000-000000000003', 'pgtap-m644-agent-none@test.local'),
  ('c6440000-0000-4000-8000-000000000004', 'pgtap-m644-staff-x@test.local'),
  ('c6440000-0000-4000-8000-000000000005', 'pgtap-m644-staff-z@test.local'),
  ('c6440000-0000-4000-8000-000000000006', 'pgtap-m644-admin2@test.local');

insert into groups (id) values
  ('c6440000-0000-4000-8000-000000000011'),
  ('c6440000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('c6440000-0000-4000-8000-000000000021', 'c6440000-0000-4000-8000-000000000011', '排程狀態顏色測試一店', 'in_store_beauty'),
  ('c6440000-0000-4000-8000-000000000022', 'c6440000-0000-4000-8000-000000000012', '排程狀態顏色測試二店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('c6440000-0000-4000-8000-000000000021', 'c6440000-0000-4000-8000-000000000001'),
  ('c6440000-0000-4000-8000-000000000022', 'c6440000-0000-4000-8000-000000000006');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('c6440000-0000-4000-8000-000000000031', 'c6440000-0000-4000-8000-000000000021', 'c6440000-0000-4000-8000-000000000002', '客服-orders', 'pgtap-m644-agent-orders@test.local', 'active', now(), '0900000401'),
  ('c6440000-0000-4000-8000-000000000032', 'c6440000-0000-4000-8000-000000000021', 'c6440000-0000-4000-8000-000000000003', '客服-無授權', 'pgtap-m644-agent-none@test.local', 'active', now(), '0900000402');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('c6440000-0000-4000-8000-000000000031', 'orders', true);

insert into merchant_leave_types (id, merchant_id, name) values
  ('c6440000-0000-4000-8000-000000000050', 'c6440000-0000-4000-8000-000000000021', '特休');

insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, no_time_slot_limit, phone) values
  ('c6440000-0000-4000-8000-000000000041', 'c6440000-0000-4000-8000-000000000021', 'c6440000-0000-4000-8000-000000000004', '服務人員X(一店)', 'monthly_salary', 'active', 'active', now(), true, '0977222001'),
  ('c6440000-0000-4000-8000-000000000042', 'c6440000-0000-4000-8000-000000000021', 'c6440000-0000-4000-8000-000000000005', '服務人員Z(隔離測試)', 'piece_rate', 'active', 'active', now(), true, '0977222002');

-- 二店的「同一位」服務人員(電話跟一店 X 完全相同,代表同一個人跨店排班,製造跨店占用)。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('c6440000-0000-4000-8000-000000000043', 'c6440000-0000-4000-8000-000000000022', '服務人員X(二店)', '0977222001', true);

insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('c6440000-0000-4000-8000-000000000041', 'staff_calendar_view', true),
  ('c6440000-0000-4000-8000-000000000042', 'staff_calendar_view', true);

-- =========================================================================
-- ① §schema:商家還沒特別設定過時,merchant_calendar_state_styles 查無資料。
-- =========================================================================
select is(
  (select count(*)::int from merchant_calendar_state_styles where merchant_id = 'c6440000-0000-4000-8000-000000000021'),
  0,
  'SPECS-INDEX #644:商家還沒特別設定過行事曆排程狀態顏色時,查無資料'
);

-- =========================================================================
-- ② seed_default_merchant_calendar_state_styles:三個預設色碼、冪等。
-- =========================================================================
select lives_ok(
  $$select seed_default_merchant_calendar_state_styles('c6440000-0000-4000-8000-000000000021')$$,
  'seed_default_merchant_calendar_state_styles(postgres 角色)執行成功'
);

select is(
  (select color from merchant_calendar_state_styles where merchant_id = 'c6440000-0000-4000-8000-000000000021' and state_type = 'full_day_leave'),
  '#78716c',
  '全天休假預設色碼是 #78716c(暖灰,跟訂單狀態顏色既有 4 色區隔)'
);

select is(
  (select color from merchant_calendar_state_styles where merchant_id = 'c6440000-0000-4000-8000-000000000021' and state_type = 'partial_leave'),
  '#a8a29e',
  '時段排休預設色碼是 #a8a29e(較淺的暖灰,視覺上比全天休假輕)'
);

select is(
  (select color from merchant_calendar_state_styles where merchant_id = 'c6440000-0000-4000-8000-000000000021' and state_type = 'cross_store_occupied'),
  '#c2410c',
  '跨店佔用預設色碼是 #c2410c(深赭橘,避免跟 warn 的 #ebaa2d 混淆)'
);

-- 冪等:先手動改一個值,重複呼叫 seed 不會覆蓋。
update merchant_calendar_state_styles set color = '#123456' where merchant_id = 'c6440000-0000-4000-8000-000000000021' and state_type = 'full_day_leave';
select seed_default_merchant_calendar_state_styles('c6440000-0000-4000-8000-000000000021');

select is(
  (select count(*)::int from merchant_calendar_state_styles where merchant_id = 'c6440000-0000-4000-8000-000000000021'),
  3,
  '重複呼叫 seed_default_merchant_calendar_state_styles 不會產生第二批(仍然是 3 列)'
);

select is(
  (select color from merchant_calendar_state_styles where merchant_id = 'c6440000-0000-4000-8000-000000000021' and state_type = 'full_day_leave'),
  '#123456',
  '重複呼叫不會覆蓋商家已經自訂過的顏色(on conflict do nothing)'
);

-- =========================================================================
-- ③ 新商家建立時(create_group_and_merchant)自動種好三筆。
-- =========================================================================
select pg_temp.test_set_auth('c6440000-0000-4000-8000-000000000002');

select create_group_and_merchant('排程狀態顏色自動種子測試店', 'in_store_beauty') \gset new_merchant_

select pg_temp.test_clear_auth();

select is(
  (select count(*)::int from merchant_calendar_state_styles where merchant_id = :'new_merchant_create_group_and_merchant'::uuid),
  3,
  'create_group_and_merchant 建立新商家時自動種入三筆 merchant_calendar_state_styles'
);

-- =========================================================================
-- ④ §RLS SELECT:can_manage_bookings(比照 merchant_booking_status_colors)。
-- =========================================================================
select pg_temp.test_set_auth('c6440000-0000-4000-8000-000000000001'); -- 一店管理員
select is(
  (select count(*)::int from merchant_calendar_state_styles where merchant_id = 'c6440000-0000-4000-8000-000000000021'),
  3,
  '一店管理員可以 SELECT 到三筆行事曆排程狀態顏色設定'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('c6440000-0000-4000-8000-000000000003'); -- 無 orders 授權的客服
select is(
  (select count(*)::int from merchant_calendar_state_styles where merchant_id = 'c6440000-0000-4000-8000-000000000021'),
  0,
  '沒有 orders 權限的客服讀不到行事曆排程狀態顏色設定(RLS 靜默過濾)'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑤ update_merchant_calendar_state_styles:權限 + upsert。
-- =========================================================================
select pg_temp.test_set_auth('c6440000-0000-4000-8000-000000000003'); -- 無授權客服
select throws_ok(
  $$select update_merchant_calendar_state_styles(
    'c6440000-0000-4000-8000-000000000021', '#111111', '#222222', '#333333'
  )$$,
  '42501', null,
  '沒有 orders 權限的客服不能修改行事曆排程狀態顏色'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('c6440000-0000-4000-8000-000000000002'); -- 有 orders 授權客服
select lives_ok(
  $$select update_merchant_calendar_state_styles(
    'c6440000-0000-4000-8000-000000000021', '#111111', '#222222', '#333333'
  )$$,
  '被授權 orders 的客服可以修改行事曆排程狀態顏色'
);
select pg_temp.test_clear_auth();

select is(
  (select row(
    (select color from merchant_calendar_state_styles where merchant_id = 'c6440000-0000-4000-8000-000000000021' and state_type = 'full_day_leave'),
    (select color from merchant_calendar_state_styles where merchant_id = 'c6440000-0000-4000-8000-000000000021' and state_type = 'partial_leave'),
    (select color from merchant_calendar_state_styles where merchant_id = 'c6440000-0000-4000-8000-000000000021' and state_type = 'cross_store_occupied')
  ))::text,
  row('#111111', '#222222', '#333333')::text,
  'update_merchant_calendar_state_styles 正確 upsert 三個狀態的顏色值'
);

-- =========================================================================
-- ⑥ get_my_calendar_state_styles:服務人員自助讀取(讀到 ⑤ 剛更新的顏色)+ 規則 2.4。
-- =========================================================================
select pg_temp.test_set_auth('c6440000-0000-4000-8000-000000000004'); -- 服務人員 X

select is(
  (get_my_calendar_state_styles('c6440000-0000-4000-8000-000000000041'::uuid) ->> 'full_day_leave'),
  '#111111',
  'X 自助讀取到商家設定的全天休假顏色(跟商家設定頁看到的一致)'
);

select is(
  (get_my_calendar_state_styles('c6440000-0000-4000-8000-000000000041'::uuid) ->> 'cross_store_occupied'),
  '#333333',
  'X 自助讀取到商家設定的跨店佔用顏色'
);

select throws_ok(
  $$select get_my_calendar_state_styles('c6440000-0000-4000-8000-000000000042'::uuid)$$,
  '42501', null,
  '規則 2.4(核心必測):X 傳入服務人員 Z 的 staff_id 呼叫 get_my_calendar_state_styles 被擋下'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑦ get_my_day_schedule_state:on_leave(整天請假)。
-- =========================================================================
insert into staff_leave_records (staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date)
values ('c6440000-0000-4000-8000-000000000041', 'c6440000-0000-4000-8000-000000000050', '特休', '2026-11-20', '2026-11-20');

select pg_temp.test_set_auth('c6440000-0000-4000-8000-000000000004'); -- X

select is(
  (get_my_day_schedule_state('c6440000-0000-4000-8000-000000000041'::uuid, '2026-11-20'::date) -> 'on_leave' ->> 'leave_type_name'),
  '特休',
  'X 查詢自己整天請假那天,on_leave.leave_type_name 正確帶出快照假別名稱'
);

select is(
  (get_my_day_schedule_state('c6440000-0000-4000-8000-000000000041'::uuid, '2026-11-21'::date) -> 'on_leave'),
  'null'::jsonb,
  '沒有請假的日期,on_leave 正確回傳 null'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑧ get_my_day_schedule_state:availability_overrides(時段排休)——含 23:30 那格 +30 分鐘
-- 的 24:00 跨日回捲邊界值測試(比照 get_merchant_day_schedule/get_my_day_business_hours 已經
-- 修過的同一種 bug)。
-- =========================================================================
insert into staff_availability_overrides (staff_id, override_date, slot_start_time, is_available) values
  ('c6440000-0000-4000-8000-000000000041', '2026-11-22', '14:00', false),
  ('c6440000-0000-4000-8000-000000000041', '2026-11-22', '23:30', false);

select pg_temp.test_set_auth('c6440000-0000-4000-8000-000000000004'); -- X

select is(
  (
    select (o ->> 'is_available')::boolean
    from jsonb_array_elements(get_my_day_schedule_state('c6440000-0000-4000-8000-000000000041'::uuid, '2026-11-22'::date) -> 'availability_overrides') o
    where (o ->> 'start_time') = '14:00:00'
  ),
  false,
  '14:00 那格時段排休(is_available=false)正確回傳'
);

select is(
  (
    select (o ->> 'end_time')
    from jsonb_array_elements(get_my_day_schedule_state('c6440000-0000-4000-8000-000000000041'::uuid, '2026-11-22'::date) -> 'availability_overrides') o
    where (o ->> 'start_time') = '23:30:00'
  ),
  '24:00:00',
  '23:30 那格 +30 分鐘正確算出 24:00:00,不會回捲成 00:00:00(跟 get_merchant_day_schedule 已修過的同一種邊界值 bug)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑨ get_my_day_schedule_state:foreign_bookings(跨店佔用)+ 隱私邊界(不洩漏對方客戶姓名)。
-- =========================================================================
select pg_temp.test_set_auth('c6440000-0000-4000-8000-000000000006'); -- 二店管理員
select pg_temp.test_clear_auth();

insert into bookings (
  id, merchant_id, staff_id, start_at, end_at,
  customer_name, customer_phone, source, created_by_role, status
) values (
  'c6440000-0000-4000-8000-000000000091',
  'c6440000-0000-4000-8000-000000000022', 'c6440000-0000-4000-8000-000000000043',
  '2026-11-23 11:00:00+08', '2026-11-23 12:00:00+08',
  '二店的秘密客戶', '0988000000', 'manual', 'admin', 'accepted'
);

select pg_temp.test_set_auth('c6440000-0000-4000-8000-000000000004'); -- 一店 X

select is(
  (
    select (get_my_day_schedule_state('c6440000-0000-4000-8000-000000000041'::uuid, '2026-11-23'::date) -> 'foreign_bookings' -> 0 ->> 'start_at')::timestamptz
  ),
  '2026-11-23 11:00:00+08'::timestamptz,
  'X(一店)查自己 2026-11-23 的排程狀態,能看到跨店占用(二店同一人那筆預約)的起訖時間'
);

select ok(
  (get_my_day_schedule_state('c6440000-0000-4000-8000-000000000041'::uuid, '2026-11-23'::date)::text not like '%二店的秘密客戶%'),
  '隱私邊界:foreign_bookings 完全不包含對方商家的客戶姓名'
);

select throws_ok(
  $$select get_my_day_schedule_state('c6440000-0000-4000-8000-000000000042'::uuid, '2026-11-23'::date)$$,
  '42501', null,
  '規則 2.4(核心必測):X 傳入服務人員 Z 的 staff_id 呼叫 get_my_day_schedule_state 被擋下'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
