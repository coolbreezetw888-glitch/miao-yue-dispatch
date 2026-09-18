-- 模組 5 規則 2.12(客服權限開關套用範圍:business_hours / orders 兩把鑰匙)、
-- 1.4/規則 2.4(merchant_feature_flags 的 UPDATE 政策比照 business_hours)。
-- 對應規格書 3.1(private.can_manage_business_hours/can_manage_bookings)、3.7(RLS 政策總覽)。
--
-- 2026-09-16 品管打回修正(SPECS-INDEX 編號 123/127/142)補充:merchant_feature_flags 這時候
-- 補上了 INSERT 政策(20260916150000_merchant_feature_flags_insert_policy.sql),讓
-- setFeatureFlag() 能改成 upsert,新商家 0 筆資料時也寫得進去。⑤a/⑤b 兩項測試對應驗證這條
-- 新政策同樣比照 can_manage_business_hours 判斷,不是開放給任何登入者。
--
-- 2026-09-16 品管複驗「額外發現」小修正:SELECT 政策原本沒有跟著 UPDATE/INSERT 一起改成
-- can_manage_business_hours,補上 ⑤c/⑤d 兩項測試驗證 SELECT 政策也已對齊
-- (20260916160000_merchant_feature_flags_select_policy_fix.sql)。
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

insert into auth.users (id, email) values
  ('b4000000-0000-4000-8000-000000000001', 'pgtap-m5-admin@test.local'),
  ('b4000000-0000-4000-8000-000000000002', 'pgtap-m5-agent-none@test.local'),
  ('b4000000-0000-4000-8000-000000000003', 'pgtap-m5-agent-bh@test.local'),
  ('b4000000-0000-4000-8000-000000000004', 'pgtap-m5-agent-orders@test.local');

insert into groups (id) values ('b4000000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('b4000000-0000-4000-8000-000000000020', 'b4000000-0000-4000-8000-000000000010', '權限測試商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('b4000000-0000-4000-8000-000000000020', 'b4000000-0000-4000-8000-000000000001');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
values ('b4000000-0000-4000-8000-000000000020', 2, false, '00:00', '23:59');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('b4000000-0000-4000-8000-000000000030', 'b4000000-0000-4000-8000-000000000020', '洗髮', 300, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit)
values ('b4000000-0000-4000-8000-000000000040', 'b4000000-0000-4000-8000-000000000020', '服務人員', null, true);

-- 三位客服:agent-none(什麼都沒被授權)、agent-bh(被授權 business_hours)、agent-orders(被授權 orders)。
insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at) values
  ('b4000000-0000-4000-8000-000000000051', 'b4000000-0000-4000-8000-000000000020', 'b4000000-0000-4000-8000-000000000002', '客服-無授權', 'pgtap-m5-agent-none@test.local', 'active', now()),
  ('b4000000-0000-4000-8000-000000000052', 'b4000000-0000-4000-8000-000000000020', 'b4000000-0000-4000-8000-000000000003', '客服-營業時間', 'pgtap-m5-agent-bh@test.local', 'active', now()),
  ('b4000000-0000-4000-8000-000000000053', 'b4000000-0000-4000-8000-000000000020', 'b4000000-0000-4000-8000-000000000004', '客服-訂單', 'pgtap-m5-agent-orders@test.local', 'active', now());

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('b4000000-0000-4000-8000-000000000052', 'business_hours', true),
  ('b4000000-0000-4000-8000-000000000053', 'orders', true);

-- 先用目前的 postgres 超級使用者身份布置好 strict_conflict_check 這筆初始列(已存在的情境),
-- 之後才切換成客服身份測試 UPDATE 政策(規則 2.4/2.12)。⑤a/⑤b 另外測試「0 筆時的 INSERT
-- 政策」,故意用一個目前還沒有任何列的 feature_key('m5qa_new_flag'),不能沿用這筆既有列。
insert into merchant_feature_flags (merchant_id, feature_key, enabled)
values ('b4000000-0000-4000-8000-000000000020', 'strict_conflict_check', true);

-- ① 無授權客服:不能寫入 merchant_business_hours(business_hours 權限)。
-- RLS 的 UPDATE 政策不符合條件時是「靜默 0 筆」,不是拋例外,所以用「更新後仍是原值」驗證,
-- 不用 throws_ok(避免對 RLS 行為的斷言方式產生誤判)。
select pg_temp.test_set_auth('b4000000-0000-4000-8000-000000000002');
update merchant_business_hours set close_time = '20:00'
where merchant_id = 'b4000000-0000-4000-8000-000000000020' and day_of_week = 2;
select pg_temp.test_clear_auth();

-- 改用商家管理員身份確認值真的沒被改掉(無授權客服自己的 SELECT 也會被同一條 RLS 擋下,
-- 直接拿無授權客服的 session 查詢只會得到 0 筆/NULL,不能用來證明「值沒被改掉」,要換一個
-- 看得到資料的身份來驗證)。
select pg_temp.test_set_auth('b4000000-0000-4000-8000-000000000001');

select is(
  (select close_time::text from merchant_business_hours
   where merchant_id = 'b4000000-0000-4000-8000-000000000020' and day_of_week = 2),
  '23:59:00',
  '規則 2.12:無授權客服的 UPDATE 被 RLS 靜默擋下,close_time 沒有真的被改掉'
);

select pg_temp.test_clear_auth();

-- ② 無授權客服:不能呼叫 create_booking(orders 權限)。
select pg_temp.test_set_auth('b4000000-0000-4000-8000-000000000002');

select throws_ok(
  $$select create_booking(
    'b4000000-0000-4000-8000-000000000020', 'b4000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','b4000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    '客戶', '0966000001'
  )$$,
  '42501', null,
  '規則 2.12:無授權客服不能呼叫 create_booking'
);

select pg_temp.test_clear_auth();

-- ③ 被授權 business_hours 的客服:可以修改 merchant_business_hours。
select pg_temp.test_set_auth('b4000000-0000-4000-8000-000000000003');

update merchant_business_hours set close_time = '21:00'
where merchant_id = 'b4000000-0000-4000-8000-000000000020' and day_of_week = 2;

select is(
  (select close_time::text from merchant_business_hours
   where merchant_id = 'b4000000-0000-4000-8000-000000000020' and day_of_week = 2),
  '21:00:00',
  '規則 2.12:被授權 business_hours 的客服可以成功修改 merchant_business_hours'
);

-- ④ 被授權 business_hours 的客服:可以寫入 staff_availability_windows。
select lives_ok(
  $$insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    values ('b4000000-0000-4000-8000-000000000040', 3, '09:00', '12:00')$$,
  '規則 2.12:被授權 business_hours 的客服可以新增 staff_availability_windows'
);

-- ⑤ 被授權 business_hours 的客服:可以修改 merchant_feature_flags 的 strict_conflict_check
--    (1.4/規則 2.4:寫入權限歸在 business_hours 底下;這筆列已在 fixture 階段以 postgres
--    身份布置好,這裡只測 UPDATE 政策)。
select lives_ok(
  $$update merchant_feature_flags set enabled = false
    where merchant_id = 'b4000000-0000-4000-8000-000000000020' and feature_key = 'strict_conflict_check'$$,
  '規則 1.4/2.4/2.12:被授權 business_hours 的客服可以修改嚴格工時衝突檢查開關'
);

-- ⑤a 被授權 business_hours 的客服:可以 INSERT 一筆全新的 feature flag(0 筆的情境,
--    對應編號 123/127/142 打回的 bug——新商家第一次設定開關時必須寫得進去,不是只能 UPDATE)。
select lives_ok(
  $$insert into merchant_feature_flags (merchant_id, feature_key, enabled)
    values ('b4000000-0000-4000-8000-000000000020', 'm5qa_new_flag', false)$$,
  '規則 1.4/2.4/2.12:被授權 business_hours 的客服可以 INSERT 一筆全新的功能開關(0 筆情境)'
);

select pg_temp.test_clear_auth();

-- ⑤b 被授權 orders(但沒被授權 business_hours)的客服:不能 INSERT 新的 feature flag。
--    跟 UPDATE 的 USING 子句(不符合條件時靜默篩掉、影響 0 筆)不同,INSERT 只有 WITH CHECK
--    可用,新資料列不符合條件時 Postgres 會直接拋出 42501 錯誤,所以這裡用 throws_ok
--    (比照assertion②),不是assertion①那種「事後查詢確認沒被改到」的寫法。
select pg_temp.test_set_auth('b4000000-0000-4000-8000-000000000004');

select throws_ok(
  $$insert into merchant_feature_flags (merchant_id, feature_key, enabled)
    values ('b4000000-0000-4000-8000-000000000020', 'm5qa_orders_should_not_insert', false)$$,
  '42501', null,
  '規則 1.4/2.4/2.12:被授權 orders 但沒被授權 business_hours 的客服,不能 INSERT 新的功能開關'
);

select pg_temp.test_clear_auth();

-- ⑤c 被授權 orders(但沒被授權 business_hours)的客服:不能 SELECT merchant_feature_flags
--    (SELECT 政策這次一併改成比照 can_manage_business_hours,不是只開放給管理員讀,但也
--    不是任何登入者都能讀——沒被授權 business_hours 的客服一樣被擋下,RLS 篩成 0 筆/NULL)。
select pg_temp.test_set_auth('b4000000-0000-4000-8000-000000000004');

select is(
  (select enabled from merchant_feature_flags
   where merchant_id = 'b4000000-0000-4000-8000-000000000020' and feature_key = 'strict_conflict_check'),
  null,
  '規則 1.4/2.4/2.12:被授權 orders 但沒被授權 business_hours 的客服,SELECT 被 RLS 擋下(0 筆)'
);

select pg_temp.test_clear_auth();

-- ⑤d 被授權 business_hours 的客服:可以 SELECT 讀回目前的實際值(assertion ⑤已經把這筆
--    strict_conflict_check 改成 enabled=false,這裡驗證同一位客服讀回的就是自己剛設定的值,
--    不會被 SELECT 政策擋成 0 筆而讓前端誤判成預設值)。
select pg_temp.test_set_auth('b4000000-0000-4000-8000-000000000003');

select is(
  (select enabled from merchant_feature_flags
   where merchant_id = 'b4000000-0000-4000-8000-000000000020' and feature_key = 'strict_conflict_check'),
  false,
  '規則 1.4/2.4/2.12:被授權 business_hours 的客服可以 SELECT 讀回自己剛設定的實際值'
);

select pg_temp.test_clear_auth();

-- ⑥ 被授權 business_hours 的客服:不能呼叫 create_booking(沒有被授權 orders)。
select throws_ok(
  $$select create_booking(
    'b4000000-0000-4000-8000-000000000020', 'b4000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','b4000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    '客戶', '0966000002'
  )$$,
  '42501', null,
  '規則 2.12:被授權 business_hours 但沒被授權 orders 的客服,不能呼叫 create_booking'
);

select pg_temp.test_clear_auth();

-- ⑦ 被授權 orders 的客服:可以呼叫 create_booking。
select pg_temp.test_set_auth('b4000000-0000-4000-8000-000000000004');

select id, status from create_booking(
  'b4000000-0000-4000-8000-000000000020', 'b4000000-0000-4000-8000-000000000040',
  jsonb_build_array(jsonb_build_object('service_item_id','b4000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
  '客戶', '0966000003'
) \gset orders_agent_

select is(:'orders_agent_status'::text, 'pending_confirmation'::text, '規則 2.12:被授權 orders 的客服可以成功呼叫 create_booking(建立後狀態是 pending_confirmation,決策記錄 5)');

-- ⑧ 被授權 orders 的客服:也可以取消/完成自己商家的預約。
select is(
  (select status from cancel_booking(:'orders_agent_id', '測試取消')),
  'cancelled',
  '規則 2.12:被授權 orders 的客服可以呼叫 cancel_booking'
);

-- ⑨ 被授權 orders 的客服:不能修改 merchant_business_hours(沒有被授權 business_hours)。
update merchant_business_hours set close_time = '18:00'
where merchant_id = 'b4000000-0000-4000-8000-000000000020' and day_of_week = 2;

select pg_temp.test_clear_auth();

-- 換成商家管理員身份驗證(orders 客服自己看不到 merchant_business_hours,原因同assertion①)。
select pg_temp.test_set_auth('b4000000-0000-4000-8000-000000000001');

select is(
  (select close_time::text from merchant_business_hours
   where merchant_id = 'b4000000-0000-4000-8000-000000000020' and day_of_week = 2),
  '21:00:00',
  '規則 2.12:被授權 orders 但沒被授權 business_hours 的客服,無法修改 merchant_business_hours(RLS 靜默擋下)'
);

select pg_temp.test_clear_auth();

-- ⑩ 商家管理員永遠可以,不受任何 section_key 授權狀態影響。
select pg_temp.test_set_auth('b4000000-0000-4000-8000-000000000001');

select lives_ok(
  $$update merchant_business_hours set close_time = '19:00'
    where merchant_id = 'b4000000-0000-4000-8000-000000000020' and day_of_week = 2$$,
  '規則 2.12:商家管理員永遠可以修改 merchant_business_hours,不需要任何 section_key 授權'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
