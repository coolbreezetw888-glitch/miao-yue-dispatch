-- 模組 10(會員與紅利)— 對應規格書 §3.6~§3.8、規則 2.1/2.2/2.4/2.8/2.10。
-- 涵蓋:create_booking/update_booking 疊加 p_member_id(連結成功/跨商家/不存在/已下架被擋下/
-- 完成後鎖定/不帶參數的既有呼叫端行為不變/orders-only 客服可以連結會員)、
-- compute_member_loyalty_points(含稅計算基準、快照建立後不自動重算、推薦獎勵、電話驗證政策)、
-- complete_booking 疊加不互相覆蓋模組 8 的抽成計算(核心必測)。
begin;

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
  ('eb000000-0000-4000-8000-000000000041', 'eb000000-0000-4000-8000-000000000021', '按件服務人員P', null, true, 'piece_rate'),
  ('eb000000-0000-4000-8000-000000000042', 'eb000000-0000-4000-8000-000000000021', '月薪服務人員M', null, true, 'monthly_salary');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at) values
  ('eb000000-0000-4000-8000-000000000051', 'eb000000-0000-4000-8000-000000000021', 'eb000000-0000-4000-8000-000000000003', '客服-僅訂單', 'pgtap-m10b-agent-orders@test.local', 'active', now());

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('eb000000-0000-4000-8000-000000000051', 'orders', true);

-- 模組 8 抽成設定(用來驗證 3.7/3.8 疊加不互相覆蓋,商家端三項調整規格書改成服務項目層級抽成
-- 之後,改成針對「按件服務人員P × 洗髮」這個組合設定 10%)。
insert into merchant_payroll_settings (merchant_id, commission_basis_type)
values ('eb000000-0000-4000-8000-000000000021', 'gross');
insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value)
values ('eb000000-0000-4000-8000-000000000041', 'eb000000-0000-4000-8000-000000000031', 'percentage', 10);

-- 模組 10 會員設定:每消費 100 元得 1 點,推薦獎勵 50 點。
insert into merchant_member_settings (merchant_id, points_earn_rate, referral_bonus_points, birthday_bonus_points)
values ('eb000000-0000-4000-8000-000000000021', 100, 50, 0);

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
  p_staff_id => 'eb000000-0000-4000-8000-000000000041',
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

-- 不帶 p_member_id 的既有呼叫端行為不變:兩個欄位都是 null。
select id from create_booking(
  p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
  p_staff_id => 'eb000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-12-01 11:00:00+08',
  p_customer_name => '訪客訂單測試',
  p_customer_phone => '0955030002'
) \gset guest_booking_

select is(
  (select row(member_id, member_name_snapshot) from bookings where id = :'guest_booking_id'::uuid)::text,
  row(null, null)::text,
  '3.6:不帶 p_member_id 的既有呼叫端行為完全不變,member_id/member_name_snapshot 皆為 null'
);

-- 跨商家的會員被擋下。
select throws_ok(
  format(
    $$select create_booking(
      p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
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
  '規則 2.1(核心):紅利點數計算基準採含稅總額 final_amount_snapshot(1050),floor(1050/100)=10 點,跟模組 8 抽成基準(排除稅金)刻意不同'
);

select is(
  (select points_balance from members where id = :'plain_member_id'::uuid),
  15,
  '規則 2.3:members.points_balance 正確累加(guest_booking 於②已補上連結並完成得 5 點 + booking1 得 10 點 = 15)'
);

-- 規則 2.1:紅利點數不受服務人員計酬類型影響——月薪制服務人員的訂單一樣正確核發會員點數。
select id from create_booking(
  p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
  p_staff_id => 'eb000000-0000-4000-8000-000000000042',
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
-- ④ 規則 2.2(核心必測):快照建立後不自動重算 + on conflict do nothing 防呆生效驗證。
-- =========================================================================
update merchant_member_settings set points_earn_rate = 10
where merchant_id = 'eb000000-0000-4000-8000-000000000021';

select is(
  (select points_delta from member_point_transactions where booking_id = :'booking1_id'::uuid and transaction_type = 'earn_booking'),
  10,
  '規則 2.2(核心):調整 points_earn_rate 後,booking1 的舊紀錄 points_delta 完全沒有變動(仍是 10)'
);

select id from create_booking(
  p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
  p_staff_id => 'eb000000-0000-4000-8000-000000000041',
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
  '規則 2.2:新完成的訂單採用調整後的新比例(1000/10=100 點)'
);

-- 沒有連結會員的訂單完全不會產生任何分類帳紀錄(補一筆真正沒有連結會員的訂單來測)。
select id from create_booking(
  p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
  p_staff_id => 'eb000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','eb000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-12-03 11:00:00+08',
  p_customer_name => '真正的訪客訂單',
  p_customer_phone => '0955030009',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000
) \gset real_guest_booking_

select confirm_booking(:'real_guest_booking_id'::uuid);
select complete_booking(:'real_guest_booking_id'::uuid);

select is(
  (select count(*)::int from member_point_transactions where booking_id = :'real_guest_booking_id'::uuid),
  0,
  '規則 2.2:member_id 為 null 的訂單完成後,完全不會產生任何 earn_booking 分類帳紀錄'
);

-- 驗證測試真的有效:直接對 booking1 再呼叫一次 compute_member_loyalty_points(模擬萬一被重複
-- 觸發的極端情境),確認 on conflict do nothing 這道防呆真的生效,不會重複核發。以 postgres 身分
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
  p_staff_id => 'eb000000-0000-4000-8000-000000000041',
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
  p_staff_id => 'eb000000-0000-4000-8000-000000000041',
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
  p_staff_id => 'eb000000-0000-4000-8000-000000000041',
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
  p_staff_id => 'eb000000-0000-4000-8000-000000000041',
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
-- ⑦ 規則 2.8:電話驗證政策開關。啟用後,未驗證電話的會員核發路徑被跳過;已驗證的正常核發;
-- 政策關閉時,不論是否驗證都正常核發。
-- =========================================================================
select pg_temp.test_set_auth('eb000000-0000-4000-8000-000000000001');

update merchant_member_settings set require_verified_phone_for_rewards = true
where merchant_id = 'eb000000-0000-4000-8000-000000000021';

select id from create_member('eb000000-0000-4000-8000-000000000021', '未驗證電話會員', '0966000007') \gset unverified_member_

select id from create_booking(
  p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
  p_staff_id => 'eb000000-0000-4000-8000-000000000041',
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
  '規則 2.8:啟用電話驗證政策後,未驗證電話的會員完成訂單,消費核發路徑被跳過(靜默略過,不算錯誤)'
);

select set_member_phone_verified(:'unverified_member_id'::uuid, true);

select id from create_booking(
  p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
  p_staff_id => 'eb000000-0000-4000-8000-000000000041',
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
  '規則 2.8:標記已驗證電話之後,同一位會員完成新訂單正常核發'
);

-- 政策關閉時,不論是否驗證都正常核發。
update merchant_member_settings set require_verified_phone_for_rewards = false
where merchant_id = 'eb000000-0000-4000-8000-000000000021';

select id from create_member('eb000000-0000-4000-8000-000000000021', '政策關閉測試會員', '0966000008') \gset policy_off_member_

select id from create_booking(
  p_merchant_id => 'eb000000-0000-4000-8000-000000000021',
  p_staff_id => 'eb000000-0000-4000-8000-000000000041',
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
  '規則 2.8:政策關閉時,即使會員電話未驗證,依然正常核發'
);

select pg_temp.test_clear_auth();

select * from finish();
rollback;
