-- 模組 6(訂單管理,第二批)§5.1/§5.2/§5.4:staff_availability_overrides 資料表 CHECK/unique 約束、
-- set_staff_day_override/clear_staff_day_override 兩支函式的權限邊界、半小時對齊驗證、
-- upsert 覆蓋行為、既有預約衝突筆數回報。**這份測試不涉及第三層邏輯是否正確接進
-- create_booking/update_booking(那是 module6_04 的範圍),只測資料表本身跟這兩支函式獨立的行為。**
--
-- 情境布置:一間商家「單日例外測試商家」,一位服務人員「測試師傅」(no_time_slot_limit=true,
-- 避免另外布置 staff_availability_windows 干擾這份測試),一位被授權 business_hours 的客服、
-- 一位只被授權 orders(未被授權 business_hours)的客服,用來驗證 §5.4 權限邊界。
begin;

select plan(18);

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
  ('c3000000-0000-4000-8000-000000000001', 'pgtap-m6b-admin@test.local'),
  ('c3000000-0000-4000-8000-000000000002', 'pgtap-m6b-agent-bh@test.local'),
  ('c3000000-0000-4000-8000-000000000003', 'pgtap-m6b-agent-orders@test.local');

insert into groups (id) values ('c3000000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('c3000000-0000-4000-8000-000000000020', 'c3000000-0000-4000-8000-000000000010', '單日例外測試商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('c3000000-0000-4000-8000-000000000020', 'c3000000-0000-4000-8000-000000000001');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
values ('c3000000-0000-4000-8000-000000000020', 2, false, '09:00', '18:00');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('c3000000-0000-4000-8000-000000000030', 'c3000000-0000-4000-8000-000000000020', '洗髮', 300, 'primary', 60);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit)
values ('c3000000-0000-4000-8000-000000000040', 'c3000000-0000-4000-8000-000000000020', '測試師傅', '0901000101', true);

-- 客服甲:被授權 business_hours(也順便給 orders,方便布置衝突用的既有預約)。
insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone)
values ('c3000000-0000-4000-8000-000000000050', 'c3000000-0000-4000-8000-000000000020', 'c3000000-0000-4000-8000-000000000002', '客服-營業時間', 'pgtap-m6b-agent-bh@test.local', 'active', now(), '0900000101');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('c3000000-0000-4000-8000-000000000050', 'business_hours', true),
  ('c3000000-0000-4000-8000-000000000050', 'orders', true);

-- 客服乙:只被授權 orders,沒有 business_hours(§5.4 權限邊界的對照組)。
insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone)
values ('c3000000-0000-4000-8000-000000000051', 'c3000000-0000-4000-8000-000000000020', 'c3000000-0000-4000-8000-000000000003', '客服-訂單', 'pgtap-m6b-agent-orders@test.local', 'active', now(), '0900000101');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('c3000000-0000-4000-8000-000000000051', 'orders', true);

-- =========================================================================
-- §5.1:CHECK 約束(直接以 postgres 超級使用者身分插入,略過 RLS,單純測資料表本身的約束)。
-- =========================================================================
select throws_ok(
  $$insert into staff_availability_overrides (staff_id, override_date, slot_start_time, is_available)
    values ('c3000000-0000-4000-8000-000000000040', '2026-09-22', '14:15:00', false)$$,
  '23514', null,
  '§5.1:slot_start_time 不是 0/30 分對齊(14:15),被 CHECK 約束擋下'
);

select throws_ok(
  $$insert into staff_availability_overrides (staff_id, override_date, slot_start_time, is_available)
    values ('c3000000-0000-4000-8000-000000000040', '2026-09-22', '14:00:30', false)$$,
  '23514', null,
  '§5.1:slot_start_time 帶秒數(14:00:30),被 CHECK 約束擋下'
);

select lives_ok(
  $$insert into staff_availability_overrides (staff_id, override_date, slot_start_time, is_available)
    values ('c3000000-0000-4000-8000-000000000040', '2026-01-01', '14:30:00', true)$$,
  '§5.1:半小時對齊的時間(14:30:00)可以正常插入'
);

-- §5.1:unique 約束——同一格子重複插入應該被擋下(函式內部是用 upsert 覆蓋,這裡直接測「表格層級」
-- 真的有這個約束存在,不是只靠函式邏輯保證不重複)。
select throws_ok(
  $$insert into staff_availability_overrides (staff_id, override_date, slot_start_time, is_available)
    values ('c3000000-0000-4000-8000-000000000040', '2026-01-01', '14:30:00', false)$$,
  '23505', null,
  '§5.1:unique(staff_id, override_date, slot_start_time) 約束擋下重複插入同一格子'
);

delete from staff_availability_overrides where override_date = '2026-01-01';

-- =========================================================================
-- §5.4:權限邊界——未被授權 business_hours 的客服(乙)呼叫被擋下,管理員/被授權客服(甲)可正常操作。
-- =========================================================================
select pg_temp.test_set_auth('c3000000-0000-4000-8000-000000000003');

select throws_ok(
  $$select set_staff_day_override('c3000000-0000-4000-8000-000000000040', '2026-09-22', '14:00', '15:00', false)$$,
  '42501', null,
  '§5.4:只被授權 orders、未被授權 business_hours 的客服,呼叫 set_staff_day_override 被擋下'
);

select throws_ok(
  $$select clear_staff_day_override('c3000000-0000-4000-8000-000000000040', '2026-09-22', '14:00', '15:00')$$,
  '42501', null,
  '§5.4:只被授權 orders、未被授權 business_hours 的客服,呼叫 clear_staff_day_override 被擋下'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- §5.2:半小時對齊驗證(以被授權 business_hours 的客服甲身分呼叫)。
-- =========================================================================
select pg_temp.test_set_auth('c3000000-0000-4000-8000-000000000002');

select throws_ok(
  $$select set_staff_day_override('c3000000-0000-4000-8000-000000000040', '2026-09-22', '14:15', '15:00', false)$$,
  'P0001', null,
  '§5.2:開始時間未對齊半小時格線,被函式擋下'
);

select throws_ok(
  $$select set_staff_day_override('c3000000-0000-4000-8000-000000000040', '2026-09-22', '14:00', '15:15', false)$$,
  'P0001', null,
  '§5.2:結束時間未對齊半小時格線,被函式擋下'
);

select throws_ok(
  $$select set_staff_day_override('c3000000-0000-4000-8000-000000000040', '2026-09-22', '15:00', '14:00', false)$$,
  'P0001', null,
  '§5.2:結束時間早於開始時間,被函式擋下'
);

-- =========================================================================
-- §5.2:設定成功後查詢有對應資料,一次展開多個半小時格子(14:00-15:30 → 3 格)。
-- =========================================================================
select is(
  (select set_staff_day_override('c3000000-0000-4000-8000-000000000040', '2026-09-22', '14:00', '15:30', false)),
  0,
  '§5.2:關閉一個目前沒有既有預約的時段,回傳受影響筆數 0'
);

select is(
  (select count(*)::int from staff_availability_overrides
   where staff_id = 'c3000000-0000-4000-8000-000000000040' and override_date = '2026-09-22'),
  3,
  '§5.2:14:00-15:30(3 個半小時格子)展開後正確寫入 3 筆資料'
);

select bag_eq(
  $$select slot_start_time::text from staff_availability_overrides
    where staff_id = 'c3000000-0000-4000-8000-000000000040' and override_date = '2026-09-22'$$,
  array['14:00:00', '14:30:00', '15:00:00'],
  '§5.2:展開的半小時格子起點正確(14:00/14:30/15:00)'
);

-- §5.1/§5.2:重複設定同一格子(14:00-14:30)用 upsert 覆蓋,不是新增第二筆。
select set_staff_day_override('c3000000-0000-4000-8000-000000000040', '2026-09-22', '14:00', '14:30', true);

select is(
  (select count(*)::int from staff_availability_overrides
   where staff_id = 'c3000000-0000-4000-8000-000000000040' and override_date = '2026-09-22'),
  3,
  '§5.2:重複設定同一格子用 upsert 覆蓋,筆數不變(還是 3 筆)'
);

select is(
  (select is_available from staff_availability_overrides
   where staff_id = 'c3000000-0000-4000-8000-000000000040' and override_date = '2026-09-22'
     and slot_start_time = '14:00:00'),
  true,
  '§5.2:重複設定同一格子後,is_available 正確覆蓋成最新值(true)'
);

-- =========================================================================
-- §5.2 第 4 點:關閉一個已有既有預約的時段,函式正確回傳既有預約筆數(不阻擋操作)。
-- =========================================================================
select id from create_booking(
  'c3000000-0000-4000-8000-000000000020', 'c3000000-0000-4000-8000-000000000040',
  jsonb_build_array(jsonb_build_object('service_item_id', 'c3000000-0000-4000-8000-000000000030', 'quantity', 1, 'unit_price', 100)),
  '2026-09-22 16:00:00+08', '既有客戶', '0977000000'
) \gset conflict_booking_

select is(
  (select set_staff_day_override('c3000000-0000-4000-8000-000000000040', '2026-09-22', '16:00', '17:00', false)),
  1,
  '§5.2 第 4 點:關閉一個已有 1 筆既有預約(未取消)的時段,正確回報受影響筆數 1,不阻擋操作本身'
);

-- 確認「不阻擋操作」:既有預約狀態沒有被自動取消或改動(§5.2 第 4 點:這次不做自動取消/自動通知)。
select is(
  (select status from bookings where id = :'conflict_booking_id'::uuid),
  'pending_confirmation',
  '§5.2 第 4 點:關閉時段不會自動取消/改動既有預約的狀態'
);

-- =========================================================================
-- §5.2:clear_staff_day_override 清除範圍內的例外列,恢復成查無例外的狀態。
-- =========================================================================
select clear_staff_day_override('c3000000-0000-4000-8000-000000000040', '2026-09-22', '14:00', '15:30');

select is(
  (select count(*)::int from staff_availability_overrides
   where staff_id = 'c3000000-0000-4000-8000-000000000040' and override_date = '2026-09-22'
     and slot_start_time >= '14:00' and slot_start_time < '15:30'),
  0,
  '§5.2:clear_staff_day_override 清除範圍內的例外列後,查無對應資料'
);

-- 16:00-17:00 那筆(關閉時段)不在清除範圍內,應該還在。
select is(
  (select count(*)::int from staff_availability_overrides
   where staff_id = 'c3000000-0000-4000-8000-000000000040' and override_date = '2026-09-22'
     and slot_start_time = '16:00:00'),
  1,
  '§5.2:clear_staff_day_override 只清除指定範圍,範圍外的例外列不受影響'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
