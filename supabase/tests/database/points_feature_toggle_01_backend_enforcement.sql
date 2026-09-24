-- 紅利點數開關(merchant_member_settings.points_feature_enabled)的後端行為回歸測試。
-- 對應 migration:20260924030000_points_feature_enabled_backend_enforcement.sql
--
-- 【使用者裁決原文】「關閉後就不計算點數了。」
--
-- 【為什麼需要這份測試】
-- 這個開關原本(SPECS-INDEX #617)刻意設計成「只隱藏前端畫面,後端照算」,結果商家把功能
-- 關掉半年之後,會員仍然默默累積了一大筆可兌換的點數,商家必須認帳。這份測試把修正後的
-- 語意釘住,兩個方向都要驗:
--   ① 負面:關閉後三條「系統自動核發」的路徑全部停擺——
--      消費累點(compute_member_loyalty_points)、推薦獎勵(referral_bonus)、
--      生日贈點(grant_pending_birthday_bonuses)。
--   ② 「不留標記」:關閉期間不能把 last_birthday_bonus_year / referral_rewarded_at 標記掉,
--      否則重新打開後連「立刻補發」都做不到,還會留下假紀錄讓之後查帳對不上。
--      這幾條是這份測試裡最容易被寫錯的部分,刻意在重新打開後再驗一次「補發得回來」。
--      ⚠️ 兩條路徑「不標記」實際換到的東西不一樣,讀這份測試時不要誤會成同一件事:
--        ・推薦獎勵:真的完整保住,沒有時間限制(關閉期間沒寫 earn_booking,「第一筆消費累點」
--          的資格還在,重新打開後被推薦人下次消費完成就會觸發)。
--        ・生日贈點:只在「同一個月內」補得回來。grant_pending_birthday_bonuses 只撈
--          「生日在本月」的會員,跨月之後不管有沒有標記年份都撈不到(例:1 月關掉、3 月打開,
--          2 月生日的會員不會補發)。下面第 ⑯⑰ 條之所以驗得出「補得回來」,是因為整份測試在
--          同一個交易、同一個月份內把開關關掉又打開——那正是這個「不標記」唯一真正救得到的情境,
--          不要把它讀成「關多久都補得回來」。
--   ③ 正面回歸(重要):關閉狀態下「手動調整」(adjust_member_points)與「兌換」
--      (redeem_member_points)仍然必須可用。商家關閉功能後既有餘額不會消失,他需要靠這兩支
--      把餘額清算掉;一起擋掉會讓商家無法收尾。這幾條是防止之後有人「順手」把保護範圍改寬。
begin;

select plan(20);

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
  ('d3000000-0000-4000-8000-000000000001', 'pgtap-pft-admin@test.local');

insert into groups (id) values ('d3000000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('d3000000-0000-4000-8000-000000000020', 'd3000000-0000-4000-8000-000000000010',
        '紅利點數開關測試商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('d3000000-0000-4000-8000-000000000020', 'd3000000-0000-4000-8000-000000000001');

-- 全天營業,避免建單被營業時間擋下(跟 module10_05 的既有做法一致)。
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'd3000000-0000-4000-8000-000000000020', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('d3000000-0000-4000-8000-000000000031', 'd3000000-0000-4000-8000-000000000020', '洗剪吹', 1000, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('d3000000-0000-4000-8000-000000000041', 'd3000000-0000-4000-8000-000000000020', '服務人員', '0901000501', true);

-- #604:create_booking 的付款方式必填。
insert into payment_methods (id, merchant_id, name) values
  ('d3000000-0000-4000-8000-000000000071', 'd3000000-0000-4000-8000-000000000020', '現場付款');

-- points_feature_enabled 不指定,用 schema 預設 true(先驗「開啟時照常累積」)。
-- reward_condition_mode 也用預設 'none'(不設資格條件),讓這份測試只變動「開關」這一個變數。
insert into merchant_member_settings (
  merchant_id, points_earn_rate, referral_bonus_points, birthday_bonus_points
) values ('d3000000-0000-4000-8000-000000000020', 100, 50, 30);

select pg_temp.test_set_auth('d3000000-0000-4000-8000-000000000001');

select id from create_member('d3000000-0000-4000-8000-000000000020', '一般會員', '0955000001') \gset member_a_

-- =========================================================================
-- ① 對照組:開關「開啟」時,完成訂單照常累積點數(1000 / 100 = 10 點)。
--    這一條先跑,確保後面「關閉後不累積」不是因為 fixture 本身就算不出點數。
-- =========================================================================
select id from create_booking(
  p_merchant_id => 'd3000000-0000-4000-8000-000000000020',
  p_staff_id => 'd3000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','d3000000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-10 10:00:00+08',
  p_customer_name => '開關開啟-對照組',
  p_customer_phone => '0955000001',
  p_payment_method_id => 'd3000000-0000-4000-8000-000000000071',
  p_member_id => :'member_a_id'::uuid
) \gset booking_enabled_
select confirm_booking(:'booking_enabled_id'::uuid);
select complete_booking(:'booking_enabled_id'::uuid);

select is(
  (select points_balance from members where id = :'member_a_id'::uuid),
  10,
  '對照組:points_feature_enabled=true(預設)時,完成訂單照常累積 10 點'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- 從這裡開始把開關關閉。以 postgres 身分改設定(跟 module10_05 改 reward_condition_mode
-- 的既有做法一致,避免把測試焦點分散到設定頁的權限上)。
-- =========================================================================
update merchant_member_settings set points_feature_enabled = false
where merchant_id = 'd3000000-0000-4000-8000-000000000020';

select pg_temp.test_set_auth('d3000000-0000-4000-8000-000000000001');

-- =========================================================================
-- ②③ 核心:關閉後完成訂單,完全不產生點數異動、餘額一點都不動。
-- =========================================================================
select id from create_booking(
  p_merchant_id => 'd3000000-0000-4000-8000-000000000020',
  p_staff_id => 'd3000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','d3000000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-10 11:00:00+08',
  p_customer_name => '開關關閉-消費累點',
  p_customer_phone => '0955000001',
  p_payment_method_id => 'd3000000-0000-4000-8000-000000000071',
  p_member_id => :'member_a_id'::uuid
) \gset booking_disabled_
select confirm_booking(:'booking_disabled_id'::uuid);
select complete_booking(:'booking_disabled_id'::uuid);

select is(
  (select count(*)::int from member_point_transactions where booking_id = :'booking_disabled_id'::uuid),
  0,
  '核心(使用者裁決「關閉後就不計算點數了」):關閉後完成訂單,不寫入任何 member_point_transactions'
);

select is(
  (select points_balance from members where id = :'member_a_id'::uuid),
  10,
  '核心:關閉後完成訂單,members.points_balance 停留在關閉前的 10 點,沒有默默累積'
);

-- =========================================================================
-- ④⑤⑥ 生日贈點:關閉狀態下整批不處理,而且「不標記年份」
--      (不標記是關鍵——標記了就連「同月內把開關再打開」都補不回來,還會留下一筆
--       「今年已發過」的假紀錄;跨月之後本來就補不回來,那是查詢條件只撈本月生日決定的,
--       不是這個標記能救的,見檔頭 ② 的說明)。
-- =========================================================================
select id from create_member(
  'd3000000-0000-4000-8000-000000000020', '本月生日會員', '0955000002',
  p_birthday => (date_trunc('month', current_date) + interval '2 days')::date
) \gset birthday_member_

select is(
  grant_pending_birthday_bonuses('d3000000-0000-4000-8000-000000000020'),
  0,
  '核心:關閉狀態下 grant_pending_birthday_bonuses 一位會員都不處理,回傳 0'
);

select is(
  (select points_balance from members where id = :'birthday_member_id'::uuid),
  0,
  '核心:關閉狀態下本月生日會員的餘額仍是 0(生日贈點沒有發出去)'
);

select ok(
  (select last_birthday_bonus_year is null from members where id = :'birthday_member_id'::uuid),
  '核心:關閉狀態下不標記 last_birthday_bonus_year(否則同月內重新打開也補不回來,還會留下假紀錄)'
);

-- =========================================================================
-- ⑦~⑩ 推薦獎勵:關閉狀態下被推薦人完成第一筆訂單,推薦人拿不到獎勵,
--      而且被推薦人的 referral_rewarded_at 不能被標記掉(同樣是「不能被靜默消耗」)。
-- =========================================================================
select id from create_member('d3000000-0000-4000-8000-000000000020', '推薦人', '0955000003') \gset referrer_
select id from create_member(
  'd3000000-0000-4000-8000-000000000020', '被推薦人', '0955000004',
  p_referred_by_member_id => :'referrer_id'::uuid
) \gset referred_

select id from create_booking(
  p_merchant_id => 'd3000000-0000-4000-8000-000000000020',
  p_staff_id => 'd3000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','d3000000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-10 13:00:00+08',
  p_customer_name => '開關關閉-推薦獎勵',
  p_customer_phone => '0955000004',
  p_payment_method_id => 'd3000000-0000-4000-8000-000000000071',
  p_member_id => :'referred_id'::uuid
) \gset referral_booking_disabled_
select confirm_booking(:'referral_booking_disabled_id'::uuid);
select complete_booking(:'referral_booking_disabled_id'::uuid);

select is(
  (select points_balance from members where id = :'referrer_id'::uuid),
  0,
  '核心:關閉狀態下,被推薦人完成第一筆訂單,推薦人的餘額仍是 0(推薦獎勵沒有核發)'
);

select is(
  (select count(*)::int from member_point_transactions
    where member_id = :'referrer_id'::uuid and transaction_type = 'referral_bonus'),
  0,
  '核心:關閉狀態下完全沒有產生 referral_bonus 異動紀錄'
);

select ok(
  (select referral_rewarded_at is null from members where id = :'referred_id'::uuid),
  '核心:關閉狀態下不標記被推薦人的 referral_rewarded_at(推薦資格留著,重新打開後還能發)'
);

select is(
  (select count(*)::int from member_point_transactions
    where member_id = :'referred_id'::uuid and transaction_type = 'earn_booking'),
  0,
  '關閉狀態下被推薦人自己的消費累點也沒有產生(同一條路徑的前半段)'
);

-- =========================================================================
-- ⑪~⑮ 正面回歸(重要):關閉狀態下,商家仍然必須能「手動調整」與「兌換」既有餘額。
--      關閉功能不代表既有點數消失,商家要靠這兩支收尾;擋掉會把商家鎖死。
--      這幾條刻意在「開關仍然是 false」的狀態下跑。
-- =========================================================================
select lives_ok(
  format($$select adjust_member_points('%s', 25, '關閉功能後手動補點')$$, :'member_a_id'),
  '正面回歸:關閉狀態下,商家管理員仍然可以手動調整點數(adjust_member_points 不受開關影響)'
);

select is(
  (select points_balance from members where id = :'member_a_id'::uuid),
  35,
  '正面回歸:手動調整真的生效(10 + 25 = 35),不是被靜默擋下'
);

select lives_ok(
  format($$select redeem_member_points('%s', 5, '關閉功能後清算既有餘額')$$, :'member_a_id'),
  '正面回歸:關閉狀態下,仍然可以登記兌換點數(redeem_member_points 不受開關影響,商家要能清算餘額)'
);

select is(
  (select points_balance from members where id = :'member_a_id'::uuid),
  30,
  '正面回歸:兌換真的生效(35 - 5 = 30)'
);

select is(
  (select count(*)::int from member_point_transactions
    where member_id = :'member_a_id'::uuid
      and transaction_type in ('manual_adjustment', 'redeem')),
  2,
  '正面回歸:手動調整與兌換各留下一筆異動紀錄(關閉狀態下歷史一樣照記)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- 重新打開開關,驗證「關閉期間沒有被靜默消耗掉的東西,現在都補得回來」。
-- ⚠️ 這裡是「同一個交易、同一個月份」內關掉又打開,所以生日贈點補得回來;跨月就不行了
--    (查詢條件只撈生日在本月的會員),別把下面第 ⑯⑰ 條讀成「關多久都補得回來」。
--    推薦獎勵那兩條(⑱~⑳)沒有這個時間限制。
-- =========================================================================
update merchant_member_settings set points_feature_enabled = true
where merchant_id = 'd3000000-0000-4000-8000-000000000020';

select pg_temp.test_set_auth('d3000000-0000-4000-8000-000000000001');

-- ⑯⑰ 生日贈點補得回來(關閉期間沒有標記年份,而且現在還在同一個月份內,
--     所以這位「本月生日」的會員仍然在待處理名單裡)。
select is(
  grant_pending_birthday_bonuses('d3000000-0000-4000-8000-000000000020'),
  1,
  '重新打開(同月內):關閉期間沒發的生日贈點補得回來(grant_pending_birthday_bonuses 回傳 1)'
);

select is(
  (select points_balance from members where id = :'birthday_member_id'::uuid),
  30,
  '重新打開:生日贈點正確發出 30 點'
);

-- ⑱~⑳ 推薦獎勵也補得回來:關閉期間被推薦人沒有產生任何 earn_booking,
--      所以重新打開後他完成的這一筆才是「第一筆」,推薦獎勵這時才正確觸發。
select id from create_booking(
  p_merchant_id => 'd3000000-0000-4000-8000-000000000020',
  p_staff_id => 'd3000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','d3000000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-11 10:00:00+08',
  p_customer_name => '重新打開-推薦獎勵',
  p_customer_phone => '0955000004',
  p_payment_method_id => 'd3000000-0000-4000-8000-000000000071',
  p_member_id => :'referred_id'::uuid
) \gset referral_booking_enabled_
select confirm_booking(:'referral_booking_enabled_id'::uuid);
select complete_booking(:'referral_booking_enabled_id'::uuid);

select is(
  (select points_balance from members where id = :'referrer_id'::uuid),
  50,
  '重新打開:推薦獎勵正確核發給推薦人(referral_bonus_points = 50)'
);

select is(
  (select count(*)::int from member_point_transactions
    where member_id = :'referrer_id'::uuid and transaction_type = 'referral_bonus'),
  1,
  '重新打開:referral_bonus 只有一筆(關閉期間那一筆訂單沒有多算一次)'
);

select ok(
  (select referral_rewarded_at is not null from members where id = :'referred_id'::uuid),
  '重新打開:被推薦人的 referral_rewarded_at 這時才被標記'
);

select pg_temp.test_clear_auth();

select * from finish();
rollback;
