-- 模組 10(會員與紅利)— SPECS-INDEX #614(§10.2/§10.2.1)+ #619(§10.7)。
-- get_members_by_phone(電話查詢索引,不當唯一鍵)+ reward_condition_mode(核心必測:line_bound)。
-- 第 11 批 D(#991,2026-10-07):either / both / phone_verified 已退場,改測 CHECK 擋下這三個值。
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

-- ─── SPECS-INDEX #977(2026-10-06,第 3 批)測試墊片:no_time_slot_limit 不再影響後台 ───────────────
-- 「客戶預約無時段限制」(no_time_slot_limit)改成只管客戶線上預約,後台建單 / 改單 / 行事曆一律不看它
-- (migration 20261006130200)。這支測試的 fixture 原本用 no_time_slot_limit=true 代表「這位服務人員不用另外
-- 布置每週時段,只受商家營業時間限制」——那是情境布置的捷徑,不是這支測試要驗的主題。
-- 為了讓原本的情境一字不差地成立,這裡在本交易內暫時掛一個 trigger:no_time_slot_limit=true 的服務人員
-- 自動補上 7 天 00:00–24:00 的每週時段(= 改前「只受營業時間限制」的效果);改回 false 時拿掉這幾列。
-- 整支測試結束 rollback,不留任何東西。新行為本身由 req977_01 驗證(那支不掛這個墊片)。
create function pg_temp.req977_full_day_windows()
returns trigger
language plpgsql
security definer
set search_path = public
as $req977$
begin
  if new.no_time_slot_limit then
    insert into public.staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    select new.id, d::smallint, '00:00'::time, '24:00'::time
    from generate_series(0, 6) d
    on conflict (staff_id, day_of_week, start_time, end_time) do nothing;
  elsif tg_op = 'UPDATE' and old.no_time_slot_limit then
    delete from public.staff_availability_windows
    where staff_id = new.id and start_time = '00:00'::time and end_time = '24:00'::time;
  end if;
  return new;
end;
$req977$;

create trigger req977_full_day_windows
  after insert or update of no_time_slot_limit on public.merchant_staff
  for each row execute function pg_temp.req977_full_day_windows();
-- ─── 墊片結束 ──────────────────────────────────────────────────────────────────────────────

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

-- 🔴 紅利系統重構 批次 4(2026-10-01):完成時改入帳建單定案的 points_planned 快照,不再讀舊的「消費點數比例」欄位。
-- 這裡用等價的基本模式設定(每滿 100 元 1 點,與舊的「每 100 元 1 點」算出相同點數);推薦獎勵要開關 1。
-- (批次 6 已 drop 舊欄位,fixture 一併拿掉。)
insert into merchant_member_settings (
  merchant_id, referral_bonus_points, birthday_bonus_points,
  earn_mode, basic_min_amount, basic_points_per_order, basic_tiered_enabled, referral_inviter_reward_enabled
) values ('ee000000-0000-4000-8000-000000000021', 0, 0, 'basic', 100, 1, true, true);

select pg_temp.test_set_auth('ee000000-0000-4000-8000-000000000001');

-- 🔴 2026-09-30 SPECS-INDEX #931(使用者裁決,推翻 #614 當初「電話不當唯一鍵」的前提):
--    **同一間商家底下,一支電話只能有一位 active 會員。**
--    這裡原本刻意建兩位同電話(0988000001 / (09) 88-000-001)的會員來驗「家庭成員共用電話」,
--    現在 create_member 會直接把第二位擋下來(而且是 \gset,psql 會當場噴錯、整檔崩),
--    所以第二位改成**另一支電話**。「同一支電話會被擋下來」這件事本身改由
--    module10_09_auto_member_on_booking.sql 的 E1/E2 斷言(含「訊息要指名是誰」)。
select id from create_member('ee000000-0000-4000-8000-000000000021', '電話比對會員一', '0988000001') \gset phone_member1_
select id from create_member('ee000000-0000-4000-8000-000000000021', '電話比對會員二', '(09) 88-000-002') \gset phone_member2_

select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('ee000000-0000-4000-8000-000000000002');
select id from create_member('ee000000-0000-4000-8000-000000000022', 'B店同電話會員', '0988000001') \gset other_merchant_phone_member_
select pg_temp.test_clear_auth();

-- =========================================================================
-- ① §10.2.1:get_members_by_phone——只在本商家內比對,回傳這支電話的既有客戶。
--    🔴 #931(2026-09-30)之後「同一支電話多位客戶」不再成立,所以這裡的期望值從 2 改成 1。
-- =========================================================================
select pg_temp.test_set_auth('ee000000-0000-4000-8000-000000000003');

select is(
  jsonb_array_length(get_members_by_phone('ee000000-0000-4000-8000-000000000021', '0988000001')),
  1,
  '#614①/#931:一支電話在同商家只會對到 1 位既有客戶(#931 之後不可能有第二位)'
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
  jsonb_array_length(get_members_by_phone('ee000000-0000-4000-8000-000000000021', '0988000001')) = 1,
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

-- #931 之後「同電話的另一位會員」不存在了,所以這一條改成查**另一支電話**的那位會員
-- (原本要驗的東西沒變:沒有任何訂單的會員 last_booking_date 必須是 null)。
select ok(
  exists (
    select 1 from jsonb_array_elements(get_members_by_phone('ee000000-0000-4000-8000-000000000021', '0988000002')) elem
    where (elem ->> 'member_id')::uuid = :'phone_member2_id'::uuid
      and (elem ->> 'last_booking_date') is null
  ),
  '#614:沒有任何訂單的會員,last_booking_date 為 null,查無訂單則為 null'
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

-- 第 11 批 D(#991):set_member_phone_verified 已退場 ⇒ 原本把「只驗證電話」「兩者都有」兩位會員標成
-- 電話已驗證的兩行刪除(phone_verified 恆為 false);line_bound 那段的意圖不受影響。

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

-- 第 11 批 D(#991,2026-10-07):人工電話驗證標記退場 ⇒ 資料庫 CHECK 收緊成 none / line_bound。
-- 原本 either / both / phone_verified 三段(5 條)改成「CHECK 擋下這三個值」(3 條),plan 14 → 12。
select pg_temp.test_clear_auth();

select throws_ok(
  $$update merchant_member_settings set reward_condition_mode = 'either'
    where merchant_id = 'ee000000-0000-4000-8000-000000000021'$$,
  '23514', null,
  '第 11 批 D:reward_condition_mode = either 已退場,被 CHECK 擋下'
);

select throws_ok(
  $$update merchant_member_settings set reward_condition_mode = 'both'
    where merchant_id = 'ee000000-0000-4000-8000-000000000021'$$,
  '23514', null,
  '第 11 批 D:reward_condition_mode = both 已退場,被 CHECK 擋下'
);

select throws_ok(
  $$update merchant_member_settings set reward_condition_mode = 'phone_verified'
    where merchant_id = 'ee000000-0000-4000-8000-000000000021'$$,
  '23514', null,
  '第 11 批 D:reward_condition_mode = phone_verified 已退場,被 CHECK 擋下'
);

select pg_temp.test_clear_auth();

select * from finish();
rollback;
