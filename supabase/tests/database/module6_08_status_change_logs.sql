-- 模組 6(訂單管理)§9.1(SPECS-INDEX #597):booking_status_change_logs 寫入時機/查詢函式/權限。
begin;

select plan(15);

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
  ('c8000000-0000-4000-8000-000000000001', 'pgtap-m6h-admin1@test.local'),
  ('c8000000-0000-4000-8000-000000000002', 'pgtap-m6h-admin2@test.local'),
  ('c8000000-0000-4000-8000-000000000003', 'pgtap-m6h-agent-orders@test.local'),
  ('c8000000-0000-4000-8000-000000000004', 'pgtap-m6h-agent-none@test.local');

insert into groups (id) values
  ('c8000000-0000-4000-8000-000000000011'),
  ('c8000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('c8000000-0000-4000-8000-000000000021', 'c8000000-0000-4000-8000-000000000011', '操作記錄測試一店', 'in_store_beauty'),
  ('c8000000-0000-4000-8000-000000000022', 'c8000000-0000-4000-8000-000000000012', '操作記錄測試二店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id, display_name) values
  ('c8000000-0000-4000-8000-000000000021', 'c8000000-0000-4000-8000-000000000001', '管理員甲'),
  ('c8000000-0000-4000-8000-000000000022', 'c8000000-0000-4000-8000-000000000002', '管理員乙');

insert into merchant_agents (id, merchant_id, user_id, name, nickname, invited_email, status, activated_at, phone) values
  ('c8000000-0000-4000-8000-000000000031', 'c8000000-0000-4000-8000-000000000021', 'c8000000-0000-4000-8000-000000000003', '客服王小美', '小美', 'pgtap-m6h-agent-orders@test.local', 'active', now(), '0900000201'),
  ('c8000000-0000-4000-8000-000000000032', 'c8000000-0000-4000-8000-000000000021', 'c8000000-0000-4000-8000-000000000004', '客服-無授權', null, 'pgtap-m6h-agent-none@test.local', 'active', now(), '0900000202');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('c8000000-0000-4000-8000-000000000031', 'orders', true);

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time) values
  ('c8000000-0000-4000-8000-000000000021', 2, false, '00:00', '23:59'),
  ('c8000000-0000-4000-8000-000000000022', 2, false, '00:00', '23:59');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('c8000000-0000-4000-8000-000000000041', 'c8000000-0000-4000-8000-000000000021', '洗髮', 300, 'primary', 30),
  ('c8000000-0000-4000-8000-000000000042', 'c8000000-0000-4000-8000-000000000022', '洗髮', 300, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('c8000000-0000-4000-8000-000000000051', 'c8000000-0000-4000-8000-000000000021', '一店服務人員', '0901000201', true),
  ('c8000000-0000-4000-8000-000000000052', 'c8000000-0000-4000-8000-000000000022', '二店服務人員', '0901000202', true);

-- SPECS-INDEX #604(合併「會員生命週期與建單表單整合」分支時修正,2026-09-23):create_booking
-- 新建訂單付款方式改為必填,這個檔案原本兩個 create_booking 呼叫都用位置參數、沒有帶付款方式
-- (依賴預設值 null)——補一筆付款方式,下面每個呼叫在既有位置參數清單最後面補上具名參數
-- p_payment_method_id(PostgreSQL 允許位置參數之後接具名參數),不改變任何測試原本要驗證的
-- 操作記錄邏輯。比照 module5_01_create_booking_boundaries.sql 已經確立的修正手法。
insert into payment_methods (id, merchant_id, name) values
  ('c8000000-0000-4000-8000-000000000061', 'c8000000-0000-4000-8000-000000000021', '現場付款');

-- =========================================================================
-- ① create_booking 寫入一筆 from_status=null, to_status=pending_confirmation,
--    actor_name_snapshot 正確帶出客服的 nickname。
-- =========================================================================
select pg_temp.test_set_auth('c8000000-0000-4000-8000-000000000003');

select id from create_booking(
  'c8000000-0000-4000-8000-000000000021', 'c8000000-0000-4000-8000-000000000051',
  jsonb_build_array(jsonb_build_object('service_item_id', 'c8000000-0000-4000-8000-000000000041', 'quantity', 1, 'unit_price', 300)),
  '2026-09-22 09:00:00+08', '客戶甲', '0955000301',
  p_payment_method_id => 'c8000000-0000-4000-8000-000000000061'
) \gset booking_a_

select is(
  (select count(*)::int from booking_status_change_logs where booking_id = :'booking_a_id'::uuid),
  1,
  '§9.1:create_booking 成功後寫入剛好一筆操作記錄'
);

select is(
  (select from_status from booking_status_change_logs where booking_id = :'booking_a_id'::uuid),
  null,
  '§9.1:建立訂單這一筆的 from_status 是 null,代表「建立」這個動作本身'
);

select is(
  (select to_status from booking_status_change_logs where booking_id = :'booking_a_id'::uuid),
  'pending_confirmation',
  '§9.1:建立訂單這一筆的 to_status 是 pending_confirmation'
);

select is(
  (select actor_name_snapshot from booking_status_change_logs where booking_id = :'booking_a_id'::uuid),
  '小美',
  '§9.1:actor_name_snapshot 正確帶出客服的 nickname'
);

select is(
  (select actor_role_snapshot from booking_status_change_logs where booking_id = :'booking_a_id'::uuid),
  'agent',
  '§9.1:actor_role_snapshot 正確標記為 agent(不是 merchant_admin)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ② confirm_booking/complete_booking 依序各再寫入一筆,actor 這次是管理員。
-- =========================================================================
select pg_temp.test_set_auth('c8000000-0000-4000-8000-000000000001');

select confirm_booking(:'booking_a_id'::uuid);
select complete_booking(:'booking_a_id'::uuid);

select is(
  (select count(*)::int from booking_status_change_logs where booking_id = :'booking_a_id'::uuid),
  3,
  '§9.1:建立+確認+完成,一共累積三筆操作記錄'
);

select is(
  (select to_status from booking_status_change_logs
   where booking_id = :'booking_a_id'::uuid and from_status = 'pending_confirmation'),
  'accepted',
  '§9.1:confirm_booking 寫入 from_status=pending_confirmation, to_status=accepted'
);

select is(
  (select to_status from booking_status_change_logs
   where booking_id = :'booking_a_id'::uuid and from_status = 'accepted'),
  'completed',
  '§9.1:complete_booking 寫入 from_status=accepted, to_status=completed'
);

select is(
  (select actor_role_snapshot from booking_status_change_logs
   where booking_id = :'booking_a_id'::uuid and to_status = 'accepted'),
  'merchant_admin',
  '§9.1:管理員操作時 actor_role_snapshot 標記為 merchant_admin(不是 agent)'
);

select is(
  (select actor_name_snapshot from booking_status_change_logs
   where booking_id = :'booking_a_id'::uuid and to_status = 'accepted'),
  '管理員甲',
  '§9.1:管理員操作時 actor_name_snapshot 正確帶出 display_name'
);

-- 依時間新到舊排序:第一筆應該是最後發生的 completed。
select is(
  (select to_status from get_booking_status_change_logs(:'booking_a_id'::uuid) limit 1),
  'completed',
  '§9.1:get_booking_status_change_logs 依時間新到舊排序,第一筆是最後發生的 completed'
);

-- 沒有 UPDATE/DELETE 政策(append-only)。表格只有 SELECT 政策,UPDATE 沒有任何政策時,
-- Postgres RLS 預設 USING 條件視為 false,這筆 UPDATE 會靜默影響 0 筆(不是報錯),
-- 比照 merchant_tax_settings「沒有 DELETE 政策」既有測試的驗證手法。**必須在還是登入使用者身分
-- 時(這裡沿用 test_clear_auth 前的 c8...001 管理員身分)下這道 UPDATE 才有意義**——如果等
-- test_clear_auth() 把連線角色還原成 postgres(pgTAP 測試檔案本身的連線角色,擁有繞過 RLS 的
-- 權限),直接 UPDATE 反而會「成功」改掉資料,不能拿來驗證 RLS 邊界(這是實作測試時實際踩到的坑,
-- 已修正)。
update booking_status_change_logs set to_status = 'hacked'
where booking_id = :'booking_a_id'::uuid and from_status is null;

select is(
  (select to_status from booking_status_change_logs
   where booking_id = :'booking_a_id'::uuid and from_status is null),
  'pending_confirmation',
  '§9.1:booking_status_change_logs 沒有 UPDATE 政策,即使是管理員身分直接 UPDATE 也沒有真的改掉任何一筆'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ③ cancel_booking 也寫入一筆(用另一筆訂單測試,避免跟上面已完成的訂單狀態衝突)。
-- =========================================================================
select pg_temp.test_set_auth('c8000000-0000-4000-8000-000000000001');

select id from create_booking(
  'c8000000-0000-4000-8000-000000000021', 'c8000000-0000-4000-8000-000000000051',
  jsonb_build_array(jsonb_build_object('service_item_id', 'c8000000-0000-4000-8000-000000000041', 'quantity', 1, 'unit_price', 300)),
  '2026-09-22 11:00:00+08', '客戶乙', '0955000302',
  p_payment_method_id => 'c8000000-0000-4000-8000-000000000061'
) \gset booking_b_

select cancel_booking(:'booking_b_id'::uuid, '客戶臨時取消');

select is(
  (select to_status from booking_status_change_logs
   where booking_id = :'booking_b_id'::uuid and from_status = 'pending_confirmation'),
  'cancelled',
  '§9.1:cancel_booking 寫入 from_status=pending_confirmation, to_status=cancelled'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ④ 權限:沒有 orders 權限的客服不能查詢操作記錄;跨商家隔離。
-- =========================================================================
select pg_temp.test_set_auth('c8000000-0000-4000-8000-000000000004');

select throws_ok(
  format($$select * from get_booking_status_change_logs('%s')$$, :'booking_a_id'::text),
  '42501', null,
  '§9.1:沒有 orders 權限的客服不能查詢操作記錄'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('c8000000-0000-4000-8000-000000000002');

select throws_ok(
  format($$select * from get_booking_status_change_logs('%s')$$, :'booking_a_id'::text),
  '42501', null,
  '§9.1:跨商家隔離——二店管理員不能查詢一店訂單的操作記錄'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
