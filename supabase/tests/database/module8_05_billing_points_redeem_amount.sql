-- 紅利系統重構 批次 1:§3.15(#848 後端)帳務報表兩支 overload 新增的兩個鍵。
-- 對應 migration 20261001020100_bonus_refactor_batch1_billing_redeem_amount.sql。
--
-- 測的東西:
--   ① 兩支 overload 都回傳 total_points_redeem_amount、points_feature_enabled
--   ② 只算 status = completed;取消、待確認的單不算
--   ③ 期間基準是完成時間 coalesce(completed_at, start_at)(8 月預約、9 月完成的單算在 9 月)
--   ④ points_feature_enabled:查無設定列 → true;設定列關閉 → false;只有 billing 鑰匙的客服也拿得到
--   ⑤ 回歸:有折抵金額時,既有鍵(營收、稅金、淨利、明細…)跟「沒有折抵時」完全相同(第 3 題定案 A:不扣)
--
-- 🔴 時間:本檔的業務時間全部寫死成台北時間 2026-08 / 2026-09(查的是寫死的年月),
--    completed_at 由 postgres 身分直接改寫成固定台北時間,不依賴「現在幾月」——
--    跑測試的當下是幾號都一樣(automated-testing §「現在是幾年幾月」規則 1/2)。
--    服務人員的薪資歷史起點也釘到 2025-01-01(規則 3,避免 per_staff_breakdown 因「當時還不存在」而漂移)。
begin;

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

select plan(17);

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
  ('e8050000-0000-4000-8000-000000000001', 'pgtap-m805-admin@test.local'),
  ('e8050000-0000-4000-8000-000000000002', 'pgtap-m805-agent-billing@test.local');

insert into groups (id) values ('e8050000-0000-4000-8000-000000000010');

-- 刻意直接 insert merchants(不走 create_group_and_merchant)⇒ 一開始**沒有** merchant_member_settings 列。
insert into merchants (id, group_id, name, industry_type)
values ('e8050000-0000-4000-8000-000000000020', 'e8050000-0000-4000-8000-000000000010',
        '報表紅利折抵測試店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('e8050000-0000-4000-8000-000000000020', 'e8050000-0000-4000-8000-000000000001');

insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('e8050000-0000-4000-8000-000000000051', 'e8050000-0000-4000-8000-000000000020',
   'e8050000-0000-4000-8000-000000000002', '客服(只有帳務報表)', '0900008051',
   'pgtap-m805-agent-billing@test.local', 'active');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('e8050000-0000-4000-8000-000000000051', 'billing', true);

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'e8050000-0000-4000-8000-000000000020', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('e8050000-0000-4000-8000-000000000031', 'e8050000-0000-4000-8000-000000000020', '測試服務', 1000, 'primary', 30);

insert into payment_methods (id, merchant_id, name) values
  ('e8050000-0000-4000-8000-000000000071', 'e8050000-0000-4000-8000-000000000020', '現場付款');

insert into merchant_staff (id, merchant_id, name, phone, compensation_type, no_time_slot_limit) values
  ('e8050000-0000-4000-8000-000000000041', 'e8050000-0000-4000-8000-000000000020',
   '按件計酬服務人員', '0900008041', 'piece_rate', true);

update staff_payroll_status_history
set effective_from = '2025-01-01 00:00:00+08'::timestamptz
where staff_id = 'e8050000-0000-4000-8000-000000000041' and effective_to is null;

-- 5 張單(全部 8 月預約,各自不同電話 ⇒ #912 各自自動建立會員,member_id 都有值):
--   A:8/10 完成 —— 算進 8 月
--   B:8/11 完成 —— 算進 8 月
--   C:取消 —— 不算
--   D:待確認 —— 不算
--   E:8/20 預約、9/02 完成 —— 算進 9 月,不算 8 月(完成時間基準)
select pg_temp.test_set_auth('e8050000-0000-4000-8000-000000000001');

select id from create_booking(
  p_merchant_id => 'e8050000-0000-4000-8000-000000000020',
  p_staff_id => 'e8050000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object(
    'service_item_id','e8050000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-08-10 10:00:00+08', p_customer_name => '客A', p_customer_phone => '0955080501',
  p_payment_method_id => 'e8050000-0000-4000-8000-000000000071'
) \gset bka_
select id from create_booking(
  p_merchant_id => 'e8050000-0000-4000-8000-000000000020',
  p_staff_id => 'e8050000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object(
    'service_item_id','e8050000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-08-11 10:00:00+08', p_customer_name => '客B', p_customer_phone => '0955080502',
  p_payment_method_id => 'e8050000-0000-4000-8000-000000000071'
) \gset bkb_
select id from create_booking(
  p_merchant_id => 'e8050000-0000-4000-8000-000000000020',
  p_staff_id => 'e8050000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object(
    'service_item_id','e8050000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-08-12 10:00:00+08', p_customer_name => '客C', p_customer_phone => '0955080503',
  p_payment_method_id => 'e8050000-0000-4000-8000-000000000071'
) \gset bkc_
select id from create_booking(
  p_merchant_id => 'e8050000-0000-4000-8000-000000000020',
  p_staff_id => 'e8050000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object(
    'service_item_id','e8050000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-08-13 10:00:00+08', p_customer_name => '客D', p_customer_phone => '0955080504',
  p_payment_method_id => 'e8050000-0000-4000-8000-000000000071'
) \gset bkd_
select id from create_booking(
  p_merchant_id => 'e8050000-0000-4000-8000-000000000020',
  p_staff_id => 'e8050000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object(
    'service_item_id','e8050000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-08-20 10:00:00+08', p_customer_name => '客E', p_customer_phone => '0955080505',
  p_payment_method_id => 'e8050000-0000-4000-8000-000000000071'
) \gset bke_

select confirm_booking(:'bka_id'::uuid);
select complete_booking(:'bka_id'::uuid);
select confirm_booking(:'bkb_id'::uuid);
select complete_booking(:'bkb_id'::uuid);
select cancel_booking(:'bkc_id'::uuid, '客人取消');
select confirm_booking(:'bke_id'::uuid);
select complete_booking(:'bke_id'::uuid);

select pg_temp.test_clear_auth();

-- fixture:把完成時間釘到固定的台北時間(complete_booking 一律寫 now())。
-- 抽成紀錄的 computed_at 跟著搬,維持「computed_at ≡ completed_at」的既有不變式。
update bookings set completed_at = '2026-08-10 15:00:00+08' where id = :'bka_id'::uuid;
update bookings set completed_at = '2026-08-11 15:00:00+08' where id = :'bkb_id'::uuid;
update bookings set completed_at = '2026-09-02 15:00:00+08' where id = :'bke_id'::uuid;
update booking_commission_records bcr set computed_at = b.completed_at
from bookings b where b.id = bcr.booking_id
  and b.id in (:'bka_id'::uuid, :'bkb_id'::uuid, :'bke_id'::uuid);

-- 回歸基準:還沒有任何折抵時的兩支報表結果(去掉兩個新鍵)。
select pg_temp.test_set_auth('e8050000-0000-4000-8000-000000000001');
select (get_merchant_billing_summary('e8050000-0000-4000-8000-000000000020', 2026, 8)
        - 'total_points_redeem_amount' - 'points_feature_enabled')::text as before_month \gset
select (get_merchant_billing_summary_by_range('e8050000-0000-4000-8000-000000000020', '2026-08-01', '2026-08-31')
        - 'total_points_redeem_amount' - 'points_feature_enabled')::text as before_range \gset
select pg_temp.test_clear_auth();

-- 寫入折抵(批次 3 才有正式寫入路徑,這裡以 postgres 身分直接布置)。
update bookings set points_redeemed = 300, points_redeem_amount_snapshot = 30 where id = :'bka_id'::uuid;
update bookings set points_redeemed = 125, points_redeem_amount_snapshot = 12.5 where id = :'bkb_id'::uuid;
update bookings set points_redeemed = 990, points_redeem_amount_snapshot = 99 where id = :'bkc_id'::uuid;
update bookings set points_redeemed = 70, points_redeem_amount_snapshot = 7 where id = :'bkd_id'::uuid;
update bookings set points_redeemed = 500, points_redeem_amount_snapshot = 50 where id = :'bke_id'::uuid;

select pg_temp.test_set_auth('e8050000-0000-4000-8000-000000000001');

-- ① ② 兩支 overload 都有新鍵、只算已完成
select is(
  (get_merchant_billing_summary('e8050000-0000-4000-8000-000000000020', 2026, 8) ->> 'total_points_redeem_amount')::numeric,
  42.50,
  '§3.15 ①②(按年月):8 月紅利折抵金額 = A 30 + B 12.5 = 42.5;取消的 C(99)、待確認的 D(7)、9 月才完成的 E(50)都不算'
);
select is(
  (get_merchant_billing_summary_by_range('e8050000-0000-4000-8000-000000000020', '2026-08-01', '2026-08-31') ->> 'total_points_redeem_amount')::numeric,
  42.50,
  '§3.15 ①②(按區間):8/1~8/31 紅利折抵金額同樣是 42.5'
);

-- ③ 完成時間基準
select is(
  (get_merchant_billing_summary('e8050000-0000-4000-8000-000000000020', 2026, 9) ->> 'total_points_redeem_amount')::numeric,
  50.00,
  '§3.15 ③(按年月):E 單 8 月預約、9 月完成 ⇒ 折抵金額算在 9 月(跟營收同一條完成時間基準)'
);
select is(
  (get_merchant_billing_summary_by_range('e8050000-0000-4000-8000-000000000020', '2026-09-01', '2026-09-15') ->> 'total_points_redeem_amount')::numeric,
  50.00,
  '§3.15 ③(按區間,非完整月份):9/1~9/15 包含 E 單的 50'
);
select is(
  (get_merchant_billing_summary_by_range('e8050000-0000-4000-8000-000000000020', '2026-08-11', '2026-08-11') ->> 'total_points_redeem_amount')::numeric,
  12.50,
  '§3.15 ③(按區間,單日):只查 8/11(台北)只會拿到 B 單的 12.5,區間邊界用台北時間'
);
select is(
  (get_merchant_billing_summary('e8050000-0000-4000-8000-000000000020', 2026, 7) ->> 'total_points_redeem_amount')::numeric,
  0.00,
  '§3.15:沒有任何已完成訂單的月份 ⇒ 0(不是 null)'
);

-- ⑤ 回歸:既有鍵完全不受折抵影響
select is(
  (get_merchant_billing_summary('e8050000-0000-4000-8000-000000000020', 2026, 8)
   - 'total_points_redeem_amount' - 'points_feature_enabled')::text,
  :'before_month',
  '§3.15 ⑤ 回歸必測(按年月):寫入折抵金額之後,既有的每一個鍵(營收、稅金、料錢、抽成、月薪、淨利、明細…)跟寫入前完全相同——折抵不從營收扣(第 3 題定案 A)'
);
select is(
  (get_merchant_billing_summary_by_range('e8050000-0000-4000-8000-000000000020', '2026-08-01', '2026-08-31')
   - 'total_points_redeem_amount' - 'points_feature_enabled')::text,
  :'before_range',
  '§3.15 ⑤ 回歸必測(按區間):同上'
);
select is(
  (get_merchant_billing_summary('e8050000-0000-4000-8000-000000000020', 2026, 8) ->> 'total_revenue_excl_tax')::numeric,
  (select sum(subtotal_amount_snapshot - discount_amount_snapshot) from bookings
   where id in (:'bka_id'::uuid, :'bkb_id'::uuid)),
  '§3.15 ⑤:8 月營收 = A、B 兩張單的「小計 − 折扣」,沒有減掉任何折抵金額'
);
select is(
  (select count(*)::int from jsonb_object_keys(get_merchant_billing_summary('e8050000-0000-4000-8000-000000000020', 2026, 8))),
  -- #985 第 8 批 8-8:尾端再加 3 個資訊鍵(material_cost_affects_commission_now + 兩個計數),鍵數預期 12 → 15;既有鍵逐鍵相等另由 req985_02 驗。
  15,
  '§3.15:按年月版回傳 15 個鍵(既有 10 個 + #848 新增 2 個 + #985 新增 3 個),沒有多也沒有少'
);
select is(
  (select count(*)::int from jsonb_object_keys(get_merchant_billing_summary_by_range('e8050000-0000-4000-8000-000000000020', '2026-08-01', '2026-08-31'))),
  -- #985 第 8 批 8-8:尾端再加 3 個資訊鍵(material_cost_affects_commission_now + 兩個計數),鍵數預期 12 → 15;既有鍵逐鍵相等另由 req985_02 驗。
  -- #1035 A 批 PA-B01:區間版再加 2 個鍵(total_monthly_bonus、bonus_feature_used),15 → 17(單月舊版 Q11 不改,仍 15)。
  -- #1035 B 批 PB-B01:區間版再加 3 個鍵(total_wage_payout、wage_includes_estimate、wage_feature_used),17 → 20。
  20,
  '§3.15:按區間版回傳 20 個鍵(#1035 A 批多 2 個、B 批多 3 個)'
);

-- ④ points_feature_enabled
select is(
  (get_merchant_billing_summary('e8050000-0000-4000-8000-000000000020', 2026, 8) -> 'points_feature_enabled'),
  'true'::jsonb,
  '§3.15 ④:商家還沒有 merchant_member_settings 列 ⇒ points_feature_enabled = true(跟前端 DEFAULT_MERCHANT_MEMBER_SETTINGS 一致)'
);
select pg_temp.test_clear_auth();

insert into merchant_member_settings (merchant_id, points_feature_enabled)
values ('e8050000-0000-4000-8000-000000000020', false);

select pg_temp.test_set_auth('e8050000-0000-4000-8000-000000000001');
select is(
  (get_merchant_billing_summary('e8050000-0000-4000-8000-000000000020', 2026, 8) -> 'points_feature_enabled'),
  'false'::jsonb,
  '§3.15 ④(按年月):紅利功能關閉 ⇒ points_feature_enabled = false'
);
select is(
  (get_merchant_billing_summary_by_range('e8050000-0000-4000-8000-000000000020', '2026-08-01', '2026-08-31') -> 'points_feature_enabled'),
  'false'::jsonb,
  '§3.15 ④(按區間):紅利功能關閉 ⇒ points_feature_enabled = false'
);
select is(
  (get_merchant_billing_summary('e8050000-0000-4000-8000-000000000020', 2026, 8) ->> 'total_points_redeem_amount')::numeric,
  42.50,
  '§3.15:功能關閉時金額照算(要不要顯示由前端依 points_feature_enabled 決定,後端不藏數字)'
);
select pg_temp.test_clear_auth();

-- ④ 只有 billing 鑰匙的客服:讀不到設定表,但報表函式照樣回傳正確的開關值(§〇.3 判斷 13)。
select pg_temp.test_set_auth('e8050000-0000-4000-8000-000000000002');
select is(
  (select count(*)::int from merchant_member_settings),
  0,
  '§〇.3 判斷 13 前提:只有 billing 鑰匙的客服直接讀 merchant_member_settings 是 0 列(所以前端不能自己查)'
);
select is(
  (get_merchant_billing_summary_by_range('e8050000-0000-4000-8000-000000000020', '2026-08-01', '2026-08-31') -> 'points_feature_enabled'),
  'false'::jsonb,
  '§3.15 ④(核心):只有 billing 鑰匙的客服透過報表函式拿到正確的 false——不是前端 hook 退回預設的 true'
);
select pg_temp.test_clear_auth();

select * from finish();

rollback;
