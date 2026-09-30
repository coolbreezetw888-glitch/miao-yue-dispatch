-- 商家端三項調整規格書 §一(設定搬家權限放寬)、§二 2.9(merchant_staff_service_items 權限
-- 補強)、§三(店家帳務報表:總營收拆分未稅/稅金、商家總淨利公式修正)— 核心必測。
-- 🔴 2026-10-01 修掉一整類「跟執行時間有關」的不穩定測試(只改**月份的計算基準**,
--    沒有改任何期望數字,也沒有改 plan(N))。
--
-- 症狀:同一份程式碼,台北時間跨過某個月的午夜之前跑是綠的、之後跑就紅。
-- 根因:本機測試資料庫的 TimeZone = UTC,所以測試裡裸寫的 now() / clock_timestamp() /
--       current_date 取到的是 **UTC** 的年月;但帳務/薪資報表函式一律是用 **Asia/Taipei**
--       切月的(v_month_start::timestamp at time zone 'Asia/Taipei',
--       見 20260924040000_billing_summary_completion_time_basis.sql:502-503 與
--       20260925020000_staff_commission_summary_completion_time_basis.sql:121-122)。
--       而資料這一側是 complete_booking 寫的 completed_at = now()。
-- ⇒ 每個月 1 號的台北 00:00–08:00(= UTC 上個月最後一天 16:00–24:00)這 8 小時,
--   台北已經進新月、UTC 還在舊月:訂單被報表算進「新月」,測試卻去查「舊月」⇒ 撈到 0 ⇒ 紅。
--   2026-10-01 台北 00:04 實測到這個現象(午夜前 PASS、午夜後 FAIL)。
-- 修法:凡是要拿年/月/日去問報表函式,一律先 `at time zone 'Asia/Taipei'` 再 extract/date_trunc,
--   跟報表自己的切月基準對齊。本檔案原本就有一部分是這樣寫的(那些是對的),這次把漏掉的補齊。
-- ⚠️ 跟 timestamptz 欄位比較時要再 `at time zone 'Asia/Taipei'` 轉回 timestamptz
--   (date_trunc 吃的是 naive timestamp,直接拿去跟 timestamptz 比會被當成 UTC,等於沒修)。
begin;

select plan(16);

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
-- Fixture:一間商家,管理員 + 四種客服(business_hours only / material_costs only /
-- payment_methods only / commission_settings + billing)。
-- =========================================================================
insert into auth.users (id, email) values
  ('ed000000-0000-4000-8000-000000000001', 'pgtap-m16b-admin@test.local'),
  ('ed000000-0000-4000-8000-000000000002', 'pgtap-m16b-agent-bh@test.local'),
  ('ed000000-0000-4000-8000-000000000003', 'pgtap-m16b-agent-mc@test.local'),
  ('ed000000-0000-4000-8000-000000000004', 'pgtap-m16b-agent-pm@test.local'),
  ('ed000000-0000-4000-8000-000000000005', 'pgtap-m16b-agent-cs@test.local');

insert into groups (id) values ('ed000000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('ed000000-0000-4000-8000-000000000021', 'ed000000-0000-4000-8000-000000000011', '設定搬家測試店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('ed000000-0000-4000-8000-000000000021', 'ed000000-0000-4000-8000-000000000001');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'ed000000-0000-4000-8000-000000000021', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('ed000000-0000-4000-8000-000000000031', 'ed000000-0000-4000-8000-000000000021', '洗髮', 1000, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, compensation_type) values
  ('ed000000-0000-4000-8000-000000000041', 'ed000000-0000-4000-8000-000000000021', '按件服務人員P', '0901000101', true, 'piece_rate');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('ed000000-0000-4000-8000-000000000051', 'ed000000-0000-4000-8000-000000000021', 'ed000000-0000-4000-8000-000000000002', '客服-business_hours', 'pgtap-m16b-agent-bh@test.local', 'active', now(), '0900000101'),
  ('ed000000-0000-4000-8000-000000000052', 'ed000000-0000-4000-8000-000000000021', 'ed000000-0000-4000-8000-000000000003', '客服-material_costs', 'pgtap-m16b-agent-mc@test.local', 'active', now(), '0900000102'),
  ('ed000000-0000-4000-8000-000000000053', 'ed000000-0000-4000-8000-000000000021', 'ed000000-0000-4000-8000-000000000004', '客服-payment_methods', 'pgtap-m16b-agent-pm@test.local', 'active', now(), '0900000103'),
  ('ed000000-0000-4000-8000-000000000054', 'ed000000-0000-4000-8000-000000000021', 'ed000000-0000-4000-8000-000000000005', '客服-commission_settings+billing', 'pgtap-m16b-agent-cs@test.local', 'active', now(), '0900000104');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('ed000000-0000-4000-8000-000000000051', 'business_hours', true),
  ('ed000000-0000-4000-8000-000000000052', 'material_costs', true),
  ('ed000000-0000-4000-8000-000000000053', 'payment_methods', true),
  ('ed000000-0000-4000-8000-000000000054', 'commission_settings', true),
  ('ed000000-0000-4000-8000-000000000054', 'billing', true);

insert into merchant_payroll_settings (merchant_id, commission_basis_type) values
  ('ed000000-0000-4000-8000-000000000021', 'gross');

-- =========================================================================
-- ① §一 1.3/1.4:merchant_feature_flags(material_cost_enabled)key 層級放寬。
-- =========================================================================
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000003');

select lives_ok(
  $$insert into merchant_feature_flags (merchant_id, feature_key, enabled)
    values ('ed000000-0000-4000-8000-000000000021', 'material_cost_enabled', true)
    on conflict (merchant_id, feature_key) do update set enabled = true$$,
  '§1.3:被開通 material_costs(沒有 business_hours)的客服可以讀寫 material_cost_enabled 這個 feature flag'
);

select throws_ok(
  $$insert into merchant_feature_flags (merchant_id, feature_key, enabled)
    values ('ed000000-0000-4000-8000-000000000021', 'strict_conflict_check', false)
    on conflict (merchant_id, feature_key) do update set enabled = false$$,
  '42501', null,
  '§1.3(key 層級精細控制):被開通 material_costs 的客服寫入 strict_conflict_check 這個 key 被擋下,不是整張表都放行'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ② §一 1.3/1.4:merchant_tax_settings 整張表放寬給 payment_methods。
-- =========================================================================
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000004');

select lives_ok(
  $$insert into merchant_tax_settings (merchant_id, tax_mode, tax_value)
    values ('ed000000-0000-4000-8000-000000000021', 'percentage', 5)
    on conflict (merchant_id) do update set tax_mode = 'percentage', tax_value = 5$$,
  '§1.3:被開通 payment_methods(沒有 business_hours)的客服可以讀寫 merchant_tax_settings'
);

select is(
  (select tax_value from merchant_tax_settings where merchant_id = 'ed000000-0000-4000-8000-000000000021'),
  5.00,
  '§1.3:寫入的稅金設定確實生效'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ③ 對照組:原本只有 business_hours 權限的客服,兩項操作依然全部正常
-- (沒有因為這次修正被意外收回權限)。
-- =========================================================================
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000002');

select lives_ok(
  $$update merchant_feature_flags set enabled = false
    where merchant_id = 'ed000000-0000-4000-8000-000000000021' and feature_key = 'material_cost_enabled'$$,
  '對照組:原本只有 business_hours 權限的客服,仍然可以正常操作 material_cost_enabled'
);

select lives_ok(
  $$update merchant_tax_settings set tax_value = 8
    where merchant_id = 'ed000000-0000-4000-8000-000000000021'$$,
  '對照組:原本只有 business_hours 權限的客服,仍然可以正常操作 merchant_tax_settings'
);

select lives_ok(
  $$update merchant_feature_flags set enabled = false
    where merchant_id = 'ed000000-0000-4000-8000-000000000021' and feature_key = 'strict_conflict_check'$$,
  '對照組:原本只有 business_hours 權限的客服,仍然可以正常操作 strict_conflict_check(這把鑰匙本來就該由它管)'
);

update merchant_tax_settings set tax_value = 5 where merchant_id = 'ed000000-0000-4000-8000-000000000021';
update merchant_feature_flags set enabled = true where merchant_id = 'ed000000-0000-4000-8000-000000000021' and feature_key in ('material_cost_enabled', 'strict_conflict_check');

select pg_temp.test_clear_auth();

-- =========================================================================
-- ④ §二 2.9:merchant_staff_service_items 權限補強(被授權 commission_settings 的客服)。
-- =========================================================================
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000005');

select lives_ok(
  format(
    $$insert into merchant_staff_service_items (staff_id, service_item_id) values ('%s', '%s')$$,
    'ed000000-0000-4000-8000-000000000041', 'ed000000-0000-4000-8000-000000000031'
  ),
  '§2.9:被開通 commission_settings(非管理員)的客服可以新增 merchant_staff_service_items'
);

select is(
  (select count(*)::int from merchant_staff_service_items where staff_id = 'ed000000-0000-4000-8000-000000000041'),
  1,
  '§2.9:被開通 commission_settings 的客服可以讀取(SELECT)merchant_staff_service_items,不會因為 RLS 被擋成 0 筆'
);

select lives_ok(
  format(
    $$delete from merchant_staff_service_items where staff_id = '%s' and service_item_id = '%s'$$,
    'ed000000-0000-4000-8000-000000000041', 'ed000000-0000-4000-8000-000000000031'
  ),
  '§2.9:被開通 commission_settings 的客服可以刪除 merchant_staff_service_items'
);

select pg_temp.test_clear_auth();

-- 對照組:完全沒有授權的客服(business_hours only)不能操作這張表。
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000002');

select throws_ok(
  format(
    $$insert into merchant_staff_service_items (staff_id, service_item_id) values ('%s', '%s')$$,
    'ed000000-0000-4000-8000-000000000041', 'ed000000-0000-4000-8000-000000000031'
  ),
  '42501', null,
  '§2.9 對照組:只有 business_hours 權限(沒有 commission_settings、不是管理員)的客服不能新增 merchant_staff_service_items'
);

select is(
  (select count(*)::int from merchant_staff_service_items where staff_id = 'ed000000-0000-4000-8000-000000000041'),
  0,
  '§2.9 對照組:同一位客服 SELECT 這張表也是 0 筆(RLS 擋下讀取)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑤ §三 3.1/3.2:total_revenue 拆分未稅/稅金,estimated_net_margin 改用未稅營收計算。
-- =========================================================================
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001');

insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value) values
  ('ed000000-0000-4000-8000-000000000041', 'ed000000-0000-4000-8000-000000000031', 'percentage', 20);
-- SPECS-INDEX #604(2026-09-23 批次修正,機械性補參數,不改變測試本身要驗證的邏輯):
-- create_booking 新建訂單付款方式改為必填,下面既有的 create_booking/update_booking 呼叫
-- 補上 p_payment_method_id。
insert into payment_methods (id, merchant_id, name) values ('d58ebc73-40eb-5a2b-b8ca-3151a781e8bf', 'ed000000-0000-4000-8000-000000000021', '現場付款');


-- 一筆有稅(1000元,10%稅=100元,final=1100)、一筆無稅(500元,final=500)。
--
-- 🔴 這兩筆 fixture 訂單踩過**兩個**不同的「跟執行時間有關」的不穩定測試。兩個都已經修好了,
--    但它們是**兩件事**、修的地方也不同 —— 分開寫清楚,免得後人以為只有一個問題。
--    (兩次都沒有動任何斷言,16 條期望數字一個字都沒改,plan(16) 也沒改。)
--
--    ① 【跨午夜】2026-09-30 修。原本寫 `p_start_at => now()` 與 `now() + interval '1 hour'`。
--       服務項目工時 30 分鐘,而 private.check_staff_booking_slot 有一條
--       「date(start_at at time zone 'Asia/Taipei') <> date(end_at at time zone 'Asia/Taipei')
--         ⇒ raise 預約時段跨到隔天」的規則。
--       ⇒ 這套測試只要在**台北 23:30 之後**跑,now() + 30 分鐘就跨過午夜、建單直接失敗,
--         而且因為是 \gset,psql 當場中止 ⇒ 整檔變成「planned 16 / ran 12」。
--         2026-09-30 深夜(台北 23:48)實際踩到:這一檔是全套 87 檔裡唯一的紅燈。
--       ⇒ **修在下面這兩行 fixture**:固定綁成「now() 當天的台北 10:00 / 11:00」,永遠落在同一個
--         台北日期內 ⇒ 不可能再跨午夜。(complete_booking 沒有「不能完成未來訂單」的限制,
--         只檢查 status = 'accepted',所以清晨跑也不會壞。)
--
--    ② 【月份基準:UTC 月 vs 台北月】2026-10-01 修。①修好之後**還是紅** —— 而且原因完全不同:
--       下面 §3.1/§3.2 那四個查詢原本裸寫 `extract(month from now())`,本機測試庫的 TimeZone
--       是 UTC ⇒ 拿到的是 **UTC 月**;但帳務報表函式是用 **Asia/Taipei** 切月的,資料這一側
--       又是 complete_booking 寫的 completed_at = now()。
--       ⇒ 每個月 1 號的**台北 00:00–08:00**這 8 小時,台北已進新月、UTC 還在舊月:訂單被報表
--         算進新月、測試卻去查舊月 ⇒ 撈到 0 ⇒ 紅。2026-10-01 台北 00:04 實測到(午夜前 PASS、
--         午夜後 FAIL)。
--       ⇒ **修在下面那四個 get_merchant_billing_summary 的呼叫**:年/月一律先
--         `at time zone 'Asia/Taipei'` 再 extract,跟報表自己的切月基準對齊。
--         這不是 fixture 的問題,所以①那次改 fixture 完全沒有、也不可能修到它。
--       📌 同一類問題在本檔案開頭那段說明裡有完整的根因紀錄(還有其他檔案也一起修了)。
--
--    ⚠️ 給後人的重點:這兩筆訂單的時間是**台北當天 10:00 / 11:00**,所以它落在哪一個月,
--       要用**台北**的月份去問報表,不能用 now() 的裸月份。①和②都修好了,現在不管幾點跑都綠。
select id from create_booking(
  p_merchant_id => 'ed000000-0000-4000-8000-000000000021',
  p_staff_id => 'ed000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ed000000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => (((now() at time zone 'Asia/Taipei')::date + time '10:00') at time zone 'Asia/Taipei'),
  p_customer_name => '含稅訂單測試客戶',
  p_customer_phone => '0966020001',
  p_tax_enabled => true,
  p_tax_mode => 'percentage',
  p_tax_value => 10
, p_payment_method_id => 'd58ebc73-40eb-5a2b-b8ca-3151a781e8bf') \gset tax_booking_

select confirm_booking(:'tax_booking_id'::uuid);
select complete_booking(:'tax_booking_id'::uuid);

select id from create_booking(
  p_merchant_id => 'ed000000-0000-4000-8000-000000000021',
  p_staff_id => 'ed000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ed000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  -- 同上,固定成當天台北時間 11:00(跟 10:00 那筆相隔 1 小時,兩筆 30 分鐘的時段不會重疊)。
  p_start_at => (((now() at time zone 'Asia/Taipei')::date + time '11:00') at time zone 'Asia/Taipei'),
  p_customer_name => '無稅訂單測試客戶',
  p_customer_phone => '0966020002'
, p_payment_method_id => 'd58ebc73-40eb-5a2b-b8ca-3151a781e8bf') \gset no_tax_booking_

select confirm_booking(:'no_tax_booking_id'::uuid);
select complete_booking(:'no_tax_booking_id'::uuid);

select is(
  (get_merchant_billing_summary('ed000000-0000-4000-8000-000000000021', extract(year from now() at time zone 'Asia/Taipei')::int, extract(month from now() at time zone 'Asia/Taipei')::int) ->> 'total_revenue_excl_tax')::numeric,
  1500.00,
  '§3.1:total_revenue_excl_tax = 1000(含稅單未稅金額) + 500(無稅單) = 1500.00,不含稅金'
);

select is(
  (get_merchant_billing_summary('ed000000-0000-4000-8000-000000000021', extract(year from now() at time zone 'Asia/Taipei')::int, extract(month from now() at time zone 'Asia/Taipei')::int) ->> 'total_tax_amount')::numeric,
  100.00,
  '§3.1:total_tax_amount = 100.00(只有含稅那一筆的稅金)'
);

-- §3.2:estimated_net_margin = 1500(未稅營收) - 0(無料錢成本) - 300(抽成:1000×20%+500×20%) - 0(無月薪)
select is(
  (get_merchant_billing_summary('ed000000-0000-4000-8000-000000000021', extract(year from now() at time zone 'Asia/Taipei')::int, extract(month from now() at time zone 'Asia/Taipei')::int) ->> 'estimated_net_margin')::numeric,
  1200.00,
  '§3.2:estimated_net_margin 用未稅營收計算,1500 - 300(抽成) = 1200.00'
);

-- 對照組:如果沿用舊版「用含稅營收計算」的錯誤口徑,會得到 1300.00(1600-300),
-- 證明這次修正確實生效,不是恰好兩個數字一樣矇混過關。
select isnt(
  (get_merchant_billing_summary('ed000000-0000-4000-8000-000000000021', extract(year from now() at time zone 'Asia/Taipei')::int, extract(month from now() at time zone 'Asia/Taipei')::int) ->> 'estimated_net_margin')::numeric,
  1300.00,
  '§3.2(修正生效驗證):如果沿用舊版含稅營收口徑會得到 1300.00,新公式不會得出這個錯誤數字'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
