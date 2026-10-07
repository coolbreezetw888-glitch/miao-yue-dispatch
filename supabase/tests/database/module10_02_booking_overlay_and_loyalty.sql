-- 模組 10(會員與紅利)— 對應規格書 §3.6~§3.8、規則 2.1/2.2/2.4/2.8/2.10。
-- 涵蓋:create_booking/update_booking 疊加 p_member_id(連結成功/跨商家/不存在/已下架被擋下/
-- 完成後鎖定/不帶參數的既有呼叫端行為不變/orders-only 客服可以連結會員)、
-- compute_member_loyalty_points(含稅計算基準、快照建立後不自動重算、推薦獎勵、電話驗證政策)、
-- complete_booking 疊加不互相覆蓋模組 8 的抽成計算(核心必測)。
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

select plan(30);

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
-- Fixture:两間商家(A/B)。A 商家:管理員 + orders-only 客服(沒有 members 權限,測規則 2.10)。
-- A 商家有一位按件計酬服務人員(測 3.7/3.8 疊加不互相覆蓋)跟一位月薪制服務人員(測規則 2.1
-- 紅利不受計酬類型影響)。
-- =========================================================================
insert into auth.users (id, email) values
  ('eb000000-0000-4000-8000-000000000001', 'pgtap-m10b-admin-a@test.local'),
  ('eb000000-0000-4000-8000-000000000002', 'pgtap-m10b-admin-b@test.local'),
  ('eb000000-0000-4000-8000-000000000003', 'pgtap-m10b-agent-orders@test.local');

insert into groups (id) values
  ('eb000000-0000-4000-8000-000000000011'),
  ('eb000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('eb000000-0000-4000-8000-000000000021', 'eb000000-0000-4000-8000-000000000011', '會員紅利疊加測試A店', 'in_store_beauty'),
  ('eb000000-0000-4000-8000-000000000022', 'eb000000-0000-4000-8000-000000000012', '會員紅利疊加測試B店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('eb000000-0000-4000-8000-000000000021', 'eb000000-0000-4000-8000-000000000001'),
  ('eb000000-0000-4000-8000-000000000022', 'eb000000-0000-4000-8000-000000000002');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'eb000000-0000-4000-8000-000000000021', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('eb000000-0000-4000-8000-000000000031', 'eb000000-0000-4000-8000-000000000021', '洗髮', 500, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, compensation_type) values
  ('eb000000-0000-4000-8000-000000000041', 'eb000000-0000-4000-8000-000000000021', '按件服務人員P', '0901000101', true, 'piece_rate'),
  ('eb000000-0000-4000-8000-000000000042', 'eb000000-0000-4000-8000-000000000021', '月薪服務人員M', '0901000102', true, 'monthly_salary');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('eb000000-0000-4000-8000-000000000051', 'eb000000-0000-4000-8000-000000000021', 'eb000000-0000-4000-8000-000000000003', '客服-僅訂單', 'pgtap-m10b-agent-orders@test.local', 'active', now(), '0900000101');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('eb000000-0000-4000-8000-000000000051', 'orders', true);

-- SPECS-INDEX #604(本次同批次疊加):create_booking 新建訂單付款方式改為必填,這個檔案原本所有
-- create_booking 呼叫都沒有帶 p_payment_method_id,#604 上線後會被必填規則擋下——這裡補一筆
-- 付款方式,下面所有呼叫統一補上這個參數(用 sed 風格的批次取代,不逐一手動改寫每一段測資)。
insert into payment_methods (id, merchant_id, name) values
  ('eb000000-0000-4000-8000-000000000061', 'eb000000-0000-4000-8000-000000000021', '現場付款');

-- 模組 8 抽成設定(用來驗證 3.7/3.8 疊加不互相覆蓋,商家端三項調整規格書改成服務項目層級抽成
-- 之後,改成針對「按件服務人員P × 洗髮」這個組合設定 10%)。
insert into merchant_payroll_settings (merchant_id, commission_basis_type)
values ('eb000000-0000-4000-8000-000000000021', 'gross');
insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value)
values ('eb000000-0000-4000-8000-000000000041', 'eb000000-0000-4000-8000-000000000031', 'percentage', 10);

-- 模組 10 會員設定:每消費 100 元得 1 點,推薦獎勵 50 點。
-- 🔴 紅利系統重構 批次 4(2026-10-01):compute_member_loyalty_points 改成入帳建單時的 points_planned
--    快照,不再讀 points_earn_rate。這裡改用「基本模式 + 每滿額累計」(每滿 100 元 1 點)表達同一個
--    規則 —— 算出來的點數跟舊的 floor(final/100) 完全相同,所以下面各斷言的數字都不用改。
--    推薦獎勵要開關 1 referral_inviter_reward_enabled(批次 1 回填只作用在既有資料列,測試資料要自己開)。
insert into merchant_member_settings (
  merchant_id, referral_bonus_points, birthday_bonus_points,
  earn_mode, basic_min_amount, basic_points_per_order, basic_tiered_enabled, referral_inviter_reward_enabled
)
values ('eb000000-0000-4000-8000-000000000021', 50, 0, 'basic', 100, 1, true, true);

select pg_temp.test_set_auth('eb000000-0000-4000-8000-000000000001');

select id from create_member('eb000000-0000-4000-8000-000000000021', '推薦人', '0966000001') \gset referrer_
select id from create_member('eb000000-0000-4000-8000-000000000021', '被推薦人', '0966000002', p_referred_by_member_id => :'referrer_id'::uuid) \gset referred_
select id from create_member('eb000000-0000-4000-8000-000000000021', '一般會員', '0966000003') \gset plain_member_
select id from create_member('eb000000-0000-4000-8000-000000000021', '即將下架的會員', '0966000004') \gset removed_member_
select deactivate_member(:'removed_member_id'::uuid);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('eb000000-0000-4000-8000-000000000002');
select id from create_member('eb000000-0000-4000-8000-000000000022', 'B店會員', '0977000001') \gset other_merchant_member_
select pg_temp.test_clear_auth();

-- =========================================================================
-- ① §3.6:create_booking 疊加 p_member_id。
-- =========================================================================
select pg_temp.test_set_auth('eb000000-0000-4000-8000-000000000001');

-- 成功連結會員。
select id from create_booking(
  p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
  p_payment_method_id => 'eb000000-0000-4000-8000-000000000061',
  p_staff_id =>'eb000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-12-01 10:00:00+08',
  p_customer_name => '含稅測試客戶',
  p_customer_phone => '0955030001',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000,
  p_tax_enabled => true,
  p_tax_mode => 'fixed',
  p_tax_value => 50,
  p_member_id => :'plain_member_id'::uuid
) \gset booking1_

select is(
  (select row(member_id, member_name_snapshot) from bookings where id = :'booking1_id'::uuid)::text,
  row(:'plain_member_id'::uuid, '一般會員')::text,
  '3.6:create_booking 成功連結會員,member_id/member_name_snapshot 正確寫入快照'
);

-- 🔴 2026-09-30 SPECS-INDEX #912(使用者需求,改變了這裡原本要驗的東西):
--    「不帶 p_member_id 建單」以前產生**訪客訂單**(member_id / member_name_snapshot 都是 null),
--    現在 create_booking 會**自動建立一筆會員並連結**(這支電話 0955030002 在這個商家查無會員)。
--    所以下面那條斷言從「兩個欄位都是 null」改成「自動建立並連結」。
--    ⚠️ 原本那句描述「既有呼叫端行為完全不變」在改完之後是錯的,一併刪掉。
select id from create_booking(
  p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
  p_payment_method_id => 'eb000000-0000-4000-8000-000000000061',
  p_staff_id =>'eb000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-12-01 11:00:00+08',
  p_customer_name => '訪客訂單測試',
  p_customer_phone => '0955030002'
) \gset guest_booking_

select ok(
  (select b.member_id is not null
            and b.member_name_snapshot = '訪客訂單測試'
            and b.member_auto_created = true
     from bookings b where b.id = :'guest_booking_id'::uuid)
  and exists (
    select 1 from members m
    where m.id = (select member_id from bookings where id = :'guest_booking_id'::uuid)
      and m.merchant_id = 'eb000000-0000-4000-8000-000000000021'
      and m.status = 'active'
      and private.normalize_phone(m.phone) = '0955030002'
      and m.identity_verified_at is null
  ),
  '3.6/#912/#911:不帶 p_member_id 且電話查無會員時,自動建立一筆會員並連結(member_auto_created=true、member_name_snapshot 帶出姓名、新會員屬於本商家且是「尚未驗證」)'
);

-- 跨商家的會員被擋下。
select throws_ok(
  format(
    $$select create_booking(
      p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
      p_payment_method_id => 'eb000000-0000-4000-8000-000000000061',
      p_staff_id => 'eb000000-0000-4000-8000-000000000041',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
      p_start_at => '2026-12-01 12:00:00+08',
      p_customer_name => '跨商家會員測試',
      p_customer_phone => '0955030003',
      p_member_id => '%s'
    )$$,
    (:'other_merchant_member_id')
  ),
  'P0001', null,
  '3.6:create_booking 連結跨商家的會員被擋下'
);

-- 不存在的會員被擋下。
select throws_ok(
  format(
    $$select create_booking(
      p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
      p_payment_method_id => 'eb000000-0000-4000-8000-000000000061',
      p_staff_id => 'eb000000-0000-4000-8000-000000000041',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
      p_start_at => '2026-12-01 13:00:00+08',
      p_customer_name => '不存在會員測試',
      p_customer_phone => '0955030004',
      p_member_id => '%s'
    )$$,
    gen_random_uuid()
  ),
  'P0001', null,
  '3.6:create_booking 連結不存在的會員被擋下'
);

-- 已下架的會員被擋下。
select throws_ok(
  format(
    $$select create_booking(
      p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
      p_payment_method_id => 'eb000000-0000-4000-8000-000000000061',
      p_staff_id => 'eb000000-0000-4000-8000-000000000041',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
      p_start_at => '2026-12-01 14:00:00+08',
      p_customer_name => '已下架會員測試',
      p_customer_phone => '0955030005',
      p_member_id => '%s'
    )$$,
    (:'removed_member_id')
  ),
  'P0001', null,
  '3.6:create_booking 連結已下架的會員被擋下'
);

-- 規則 2.10:只有 orders 權限、沒有 members 權限的客服,呼叫 create_booking 帶入 p_member_id 一樣成功。
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('eb000000-0000-4000-8000-000000000003');

select lives_ok(
  format(
    $$select create_booking(
      p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
      p_payment_method_id => 'eb000000-0000-4000-8000-000000000061',
      p_staff_id => 'eb000000-0000-4000-8000-000000000041',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
      p_start_at => '2026-12-01 15:00:00+08',
      p_customer_name => '客服建單連結會員測試',
      p_customer_phone => '0955030006',
      p_member_id => '%s'
    )$$,
    (:'plain_member_id')
  ),
  '規則 2.10:只有 orders 權限、沒有 members 權限的客服,建單時仍可以連結會員(建單本身的權限邊界不因附帶用到會員模組資料而變嚴格)'
);

select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('eb000000-0000-4000-8000-000000000001');

-- =========================================================================
-- ② §3.6:update_booking 疊加 p_member_id(可在未完成前變更;完成後永久鎖定)。
-- =========================================================================
-- guest_booking 目前 member_id 是 null,pending_confirmation 狀態下用 update_booking 補上連結。
select update_booking(
  p_booking_id => :'guest_booking_id'::uuid,
  p_staff_id => 'eb000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-12-01 11:00:00+08',
  p_customer_name => '訪客訂單測試',
  p_customer_phone => '0955030002',
  -- SPECS-INDEX #604:這筆訂單建立時已經帶了付款方式(見上方 create_booking),update_booking
  -- 維持原值放行,一樣要帶同一個 payment_method_id,不然預設 null 會被判定成「主動清空」而擋下。
  p_payment_method_id => 'eb000000-0000-4000-8000-000000000061',
  p_member_id => :'plain_member_id'::uuid
);

select is(
  (select member_id from bookings where id = :'guest_booking_id'::uuid),
  :'plain_member_id'::uuid,
  '3.6:update_booking 在 pending_confirmation 狀態下可以補上會員連結'
);

-- 完成訂單之後,member_id 永久鎖定(update_booking 本身既有邏輯已經擋下已完成訂單的任何編輯)。
select confirm_booking(:'guest_booking_id'::uuid);
select complete_booking(:'guest_booking_id'::uuid);

select throws_ok(
  format(
    $$select update_booking(
      p_booking_id => '%s',
      p_staff_id => 'eb000000-0000-4000-8000-000000000041',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
      p_start_at => '2026-12-01 11:00:00+08',
      p_customer_name => '訪客訂單測試',
      p_customer_phone => '0955030002',
      p_member_id => null
    )$$,
    (:'guest_booking_id')
  ),
  null, null,
  '判斷 9:訂單完成後無法再透過 update_booking 變更(既有的狀態限制自然達成永久鎖定的效果)'
);

select is(
  (select member_id from bookings where id = :'guest_booking_id'::uuid),
  :'plain_member_id'::uuid,
  '判斷 9:完成後 member_id 維持原本連結的會員,沒有被上面失敗的呼叫清空'
);

-- =========================================================================
-- ③ 規則 2.1(含稅計算基準)+ 3.7/3.8(疊加不互相覆蓋模組 8 抽成)核心必測。
-- booking1(P 服務人員,已於上面建立,custom_total_amount=1000、tax fixed 50 → final=1050)。
-- 模組 8 commission 基準用 subtotal-discount(排除稅金)= 1000 × 10% = 100.00。
-- 模組 10 紅利基準用 final_amount_snapshot(含稅)= 1050,points_earn_rate=100 → floor(1050/100)=10 點。
-- =========================================================================
select confirm_booking(:'booking1_id'::uuid);
select complete_booking(:'booking1_id'::uuid);

select is(
  (select commission_amount from booking_commission_records where booking_id = :'booking1_id'::uuid),
  100.00,
  '3.7/3.8(核心):模組 8 抽成快照正確產生(排除稅金,1000 × 10% = 100.00),不受本模組疊加影響'
);

select is(
  (select points_delta from member_point_transactions where booking_id = :'booking1_id'::uuid and transaction_type = 'earn_booking'),
  10,
  '規則 2.1 / 紅利重構 §2.2(核心):派點基準採含稅應付總額(1050),每滿 100 元 1 點 = 10 點,建單時定案、完成時入帳 points_planned;跟模組 8 抽成基準(排除稅金)刻意不同'
);

select is(
  (select points_balance from members where id = :'plain_member_id'::uuid),
  15,
  '規則 2.3:members.points_balance 正確累加(guest_booking 於②已補上連結並完成得 5 點 + booking1 得 10 點 = 15)'
);

-- 規則 2.1:紅利點數不受服務人員計酬類型影響——月薪制服務人員的訂單一樣正確核發會員點數。
select id from create_booking(
  p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
  p_payment_method_id => 'eb000000-0000-4000-8000-000000000061',
  p_staff_id =>'eb000000-0000-4000-8000-000000000042',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-12-02 10:00:00+08',
  p_customer_name => '月薪服務人員紅利測試',
  p_customer_phone => '0955030007',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 300,
  p_member_id => :'plain_member_id'::uuid
) \gset monthly_staff_booking_

select confirm_booking(:'monthly_staff_booking_id'::uuid);
select complete_booking(:'monthly_staff_booking_id'::uuid);

select is(
  (select points_delta from member_point_transactions where booking_id = :'monthly_staff_booking_id'::uuid and transaction_type = 'earn_booking'),
  3,
  '規則 2.1:月薪制服務人員的訂單一樣正確核發會員點數(300/100=3 點),不受計酬類型影響(模組 8 抽成則完全不會有紀錄)'
);

select is(
  (select count(*)::int from booking_commission_records where booking_id = :'monthly_staff_booking_id'::uuid),
  0,
  '對照組:月薪制服務人員的這筆訂單完全不會產生模組 8 的抽成紀錄(兩個模組各自獨立判斷)'
);

-- =========================================================================
-- ④ 規則 2.2(核心必測):快照建立後不自動重算 + 重複呼叫不重複入帳的防呆生效驗證
--    (#844 migration C 起防呆從「唯一索引 + on conflict do nothing」改成「鎖會員列後的淨額判斷」)。
-- =========================================================================
-- 批次 4:原本改 points_earn_rate = 10,改成等價的「每滿 10 元 1 點」。
update merchant_member_settings set basic_min_amount = 10
where merchant_id = 'eb000000-0000-4000-8000-000000000021';

select is(
  (select points_delta from member_point_transactions where booking_id = :'booking1_id'::uuid and transaction_type = 'earn_booking'),
  10,
  '規則 2.2(核心):調整派點規則後,booking1 的舊紀錄 points_delta 完全沒有變動(仍是 10)'
);

select id from create_booking(
  p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
  p_payment_method_id => 'eb000000-0000-4000-8000-000000000061',
  p_staff_id =>'eb000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-12-03 10:00:00+08',
  p_customer_name => '規則2.2新比例測試',
  p_customer_phone => '0955030008',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000,
  p_member_id => :'plain_member_id'::uuid
) \gset booking_new_rate_

select confirm_booking(:'booking_new_rate_id'::uuid);
select complete_booking(:'booking_new_rate_id'::uuid);

select is(
  (select points_delta from member_point_transactions where booking_id = :'booking_new_rate_id'::uuid and transaction_type = 'earn_booking'),
  100,
  '規則 2.2:調整後新建立並完成的訂單採用新規則(每滿 10 元 1 點,1000/10=100 點)'
);

-- 沒有連結會員的訂單完全不會產生任何分類帳紀錄(補一筆真正沒有連結會員的訂單來測)。
select id from create_booking(
  p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
  p_payment_method_id => 'eb000000-0000-4000-8000-000000000061',
  p_staff_id =>'eb000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-12-03 11:00:00+08',
  p_customer_name => '真正的訪客訂單',
  p_customer_phone => '0955030009',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000
) \gset real_guest_booking_

-- 🔴 2026-09-30 SPECS-INDEX #912:create_booking 現在會自動建立/連結會員,**已經沒有辦法用
--    create_booking 造出一筆真正的訪客訂單**。但「member_id 為 null 的訂單不發點數」這條規則
--    (compute_member_loyalty_points 開頭那個 `if v_member_id is null then return`)仍然必須有人守,
--    否則哪天有人把它拿掉不會有任何測試變紅 —— 例如 update_booking 把會員清空、或
--    import_historical_bookings_batch 匯入沒有會員的歷史訂單,都還是會產生 member_id 為 null 的訂單。
--    ⇒ 這裡以 postgres 身分(繞過 RLS)把剛剛自動連結上的會員清掉,還原成真正的訪客訂單,
--      再 confirm/complete,原本要驗的東西就完整保留下來。
select pg_temp.test_clear_auth();
update bookings set member_id = null, member_name_snapshot = null
where id = :'real_guest_booking_id'::uuid;
select pg_temp.test_set_auth('eb000000-0000-4000-8000-000000000001');

select confirm_booking(:'real_guest_booking_id'::uuid);
select complete_booking(:'real_guest_booking_id'::uuid);

select is(
  (select count(*)::int from member_point_transactions where booking_id = :'real_guest_booking_id'::uuid),
  0,
  '規則 2.2:member_id 為 null 的訂單完成後,完全不會產生任何 earn_booking 分類帳紀錄'
);

-- 驗證測試真的有效:直接對 booking1 再呼叫一次 compute_member_loyalty_points(模擬萬一被重複
-- 觸發的極端情境),確認防呆真的生效,不會重複核發。#844 migration C(20261001090200)起唯一索引已移除,
-- 防呆改成淨額判斷(本單本會員有效入帳 = points_planned ⇒ 補 0 點、不寫);斷言內容不變。以 postgres 身分
-- 呼叫(bypass 刻意加上的 revoke)。
select pg_temp.test_clear_auth();

select public.compute_member_loyalty_points(:'booking1_id'::uuid);

select is(
  (select count(*)::int from member_point_transactions where booking_id = :'booking1_id'::uuid and transaction_type = 'earn_booking'),
  1,
  '規則 2.2(核心,防呆生效驗證):即使直接對同一筆訂單再呼叫一次 compute_member_loyalty_points,仍然只有 1 筆 earn_booking 紀錄,金額不會被重複核發'
);

select is(
  (select points_balance from members where id = :'plain_member_id'::uuid),
  118,
  '規則 2.2:重複呼叫不會讓餘額被重複累加(5 + 10 + 3 + 100 = 118,維持正確)'
);

select pg_temp.test_set_auth('eb000000-0000-4000-8000-000000000001');

-- =========================================================================
-- ⑤ 規則 2.4(核心必測):推薦獎勵——被推薦人第一筆訂單完成時,一次性核發給推薦人。
-- =========================================================================
select id from create_booking(
  p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
  p_payment_method_id => 'eb000000-0000-4000-8000-000000000061',
  p_staff_id =>'eb000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-12-04 10:00:00+08',
  p_customer_name => '被推薦人第一筆消費',
  p_customer_phone => '0955030010',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000,
  p_member_id => :'referred_id'::uuid
) \gset referral_booking1_

select confirm_booking(:'referral_booking1_id'::uuid);
select complete_booking(:'referral_booking1_id'::uuid);

select is(
  (select points_balance from members where id = :'referrer_id'::uuid),
  50,
  '規則 2.4(核心):被推薦人第一筆訂單完成,推薦人正確拿到 50 點推薦獎勵'
);

select is(
  (select count(*)::int from member_point_transactions where member_id = :'referrer_id'::uuid and transaction_type = 'referral_bonus'),
  1,
  '規則 2.4:推薦獎勵分類帳紀錄剛好一筆'
);

select isnt(
  (select referral_rewarded_at from members where id = :'referred_id'::uuid),
  null,
  '規則 2.4:被推薦人的 referral_rewarded_at 已標記'
);

-- 同一位被推薦人第二筆訂單完成,推薦人不會重複拿到獎勵。
select id from create_booking(
  p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
  p_payment_method_id => 'eb000000-0000-4000-8000-000000000061',
  p_staff_id =>'eb000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-12-04 11:00:00+08',
  p_customer_name => '被推薦人第二筆消費',
  p_customer_phone => '0955030011',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000,
  p_member_id => :'referred_id'::uuid
) \gset referral_booking2_

select confirm_booking(:'referral_booking2_id'::uuid);
select complete_booking(:'referral_booking2_id'::uuid);

select is(
  (select points_balance from members where id = :'referrer_id'::uuid),
  50,
  '規則 2.4(核心):被推薦人第二筆訂單完成,推薦人不會重複拿到獎勵(維持 50 點)'
);

-- 沒有推薦人的會員完成訂單,不觸發任何 referral_bonus 紀錄。
select is(
  (select count(*)::int from member_point_transactions where transaction_type = 'referral_bonus' and related_member_id = :'plain_member_id'::uuid),
  0,
  '規則 2.4:沒有推薦人的會員(plain_member)完成訂單,不會觸發任何 referral_bonus 紀錄'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑥ 規則 2.4 第 4 點:referral_bonus_points=0 時,referral_rewarded_at 依然正確標記,
-- 不會因為之後調高金額而重複觸發。
-- =========================================================================
update merchant_member_settings set referral_bonus_points = 0
where merchant_id = 'eb000000-0000-4000-8000-000000000021';

select pg_temp.test_set_auth('eb000000-0000-4000-8000-000000000001');

select id from create_member('eb000000-0000-4000-8000-000000000021', '推薦人2(零獎勵測試)', '0966000005') \gset referrer2_
select id from create_member('eb000000-0000-4000-8000-000000000021', '被推薦人2(零獎勵測試)', '0966000006', p_referred_by_member_id => :'referrer2_id'::uuid) \gset referred2_

select id from create_booking(
  p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
  p_payment_method_id => 'eb000000-0000-4000-8000-000000000061',
  p_staff_id =>'eb000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-12-05 10:00:00+08',
  p_customer_name => '零獎勵推薦測試',
  p_customer_phone => '0955030012',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000,
  p_member_id => :'referred2_id'::uuid
) \gset referral_zero_booking_

select confirm_booking(:'referral_zero_booking_id'::uuid);
select complete_booking(:'referral_zero_booking_id'::uuid);

select isnt(
  (select referral_rewarded_at from members where id = :'referred2_id'::uuid),
  null,
  '規則 2.4 第 4 點:referral_bonus_points=0 時,referral_rewarded_at 依然正確標記'
);

select is(
  (select points_balance from members where id = :'referrer2_id'::uuid),
  0,
  '規則 2.4 第 4 點:referral_bonus_points=0 時,推薦人餘額不變(0 點)'
);

-- 之後調高 referral_bonus_points,同一位被推薦人的下一筆訂單不會重複觸發。
update merchant_member_settings set referral_bonus_points = 50
where merchant_id = 'eb000000-0000-4000-8000-000000000021';

select id from create_booking(
  p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
  p_payment_method_id => 'eb000000-0000-4000-8000-000000000061',
  p_staff_id =>'eb000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-12-05 11:00:00+08',
  p_customer_name => '零獎勵推薦測試第二筆',
  p_customer_phone => '0955030013',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000,
  p_member_id => :'referred2_id'::uuid
) \gset referral_zero_booking2_

select confirm_booking(:'referral_zero_booking2_id'::uuid);
select complete_booking(:'referral_zero_booking2_id'::uuid);

select is(
  (select points_balance from members where id = :'referrer2_id'::uuid),
  0,
  '規則 2.4 第 4 點(核心):即使之後調高 referral_bonus_points,同一位被推薦人的第二筆訂單也不會重複觸發推薦獎勵'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑦ 規則 2.8/§10.7(SPECS-INDEX #619 疊加):資格條件判斷改用 reward_condition_mode。這裡沿用
-- 原本規則 2.8 的測試骨架,只把開關 require_verified_phone_for_rewards(true/false)換成
-- reward_condition_mode('phone_verified'/'none'),驗證行為完全對應(mode='phone_verified' 等同
-- 舊版開啟開關,mode='none' 等同舊版關閉開關)。mode='line_bound'/'either'/'both' 的完整交集/
-- 聯集驗證另外在 module10_04_reward_condition_mode.sql 覆蓋。
-- 第 11 批 D(#991,2026-10-07):人工電話驗證標記退場,資格條件只剩 none / line_bound ⇒ 本段改用
-- mode='line_bound' 表達同一個意圖(資格條件會擋 / 符合就放行);「符合」改由 fixture 直接把
-- members.line_bound 設成 true(測試交易內,postgres 身分)。
-- =========================================================================
select pg_temp.test_set_auth('eb000000-0000-4000-8000-000000000001');

update merchant_member_settings set reward_condition_mode = 'line_bound'
where merchant_id = 'eb000000-0000-4000-8000-000000000021';

select id from create_member('eb000000-0000-4000-8000-000000000021', '未驗證電話會員', '0966000007') \gset unverified_member_

select id from create_booking(
  p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
  p_payment_method_id => 'eb000000-0000-4000-8000-000000000061',
  p_staff_id =>'eb000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-12-06 10:00:00+08',
  p_customer_name => '未驗證電話測試',
  p_customer_phone => '0955030014',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000,
  p_member_id => :'unverified_member_id'::uuid
) \gset unverified_booking_

select confirm_booking(:'unverified_booking_id'::uuid);
select complete_booking(:'unverified_booking_id'::uuid);

select is(
  (select count(*)::int from member_point_transactions where booking_id = :'unverified_booking_id'::uuid),
  0,
  '規則 2.8/#619:reward_condition_mode=line_bound 時,未綁 LINE 的會員完成訂單,消費核發路徑被跳過(靜默略過,不算錯誤)'
);

select pg_temp.test_clear_auth();
update members set line_bound = true where id = :'unverified_member_id'::uuid;
select pg_temp.test_set_auth('eb000000-0000-4000-8000-000000000001');

select id from create_booking(
  p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
  p_payment_method_id => 'eb000000-0000-4000-8000-000000000061',
  p_staff_id =>'eb000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-12-06 11:00:00+08',
  p_customer_name => '已驗證電話測試',
  p_customer_phone => '0955030015',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000,
  p_member_id => :'unverified_member_id'::uuid
) \gset verified_booking_

select confirm_booking(:'verified_booking_id'::uuid);
select complete_booking(:'verified_booking_id'::uuid);

select is(
  (select count(*)::int from member_point_transactions where booking_id = :'verified_booking_id'::uuid and transaction_type = 'earn_booking'),
  1,
  '規則 2.8/#619:綁定 LINE 之後,同一位會員完成新訂單正常核發'
);

-- reward_condition_mode='none' 時,不論是否驗證都正常核發(對應舊版政策關閉行為)。
update merchant_member_settings set reward_condition_mode = 'none'
where merchant_id = 'eb000000-0000-4000-8000-000000000021';

select id from create_member('eb000000-0000-4000-8000-000000000021', '政策關閉測試會員', '0966000008') \gset policy_off_member_

select id from create_booking(
  p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
  p_payment_method_id => 'eb000000-0000-4000-8000-000000000061',
  p_staff_id =>'eb000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-12-06 12:00:00+08',
  p_customer_name => '政策關閉測試',
  p_customer_phone => '0955030016',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000,
  p_member_id => :'policy_off_member_id'::uuid
) \gset policy_off_booking_

select confirm_booking(:'policy_off_booking_id'::uuid);
select complete_booking(:'policy_off_booking_id'::uuid);

select is(
  (select count(*)::int from member_point_transactions where booking_id = :'policy_off_booking_id'::uuid and transaction_type = 'earn_booking'),
  1,
  '規則 2.8/#619:reward_condition_mode=none 時,即使會員電話未驗證,依然正常核發'
);

select pg_temp.test_clear_auth();

select * from finish();
rollback;
