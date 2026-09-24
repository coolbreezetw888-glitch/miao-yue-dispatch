-- 2026-09-24 主腦裁決(migration 20260924040300 §6)的回歸測試:
--   推薦獎勵必須跟 points_earn_rate(消費點數比例)**脫鉤**。
--
-- 【主腦裁決原文】
--   「推薦獎勵必須跟 points_earn_rate 脫鉤。理由:referral_bonus_points 是一個獨立的設定,
--     商家可能刻意『不做消費累點、但要做推薦獎勵』。用『消費幾元累積一點』的設定值去決定
--     『推薦獎勵發不發』,在產品語意上講不通。」
--
-- 【原本的問題(查證過的實際控制流,不是推測)】
-- public.compute_member_loyalty_points 原本的步驟順序是:
--     步驟 4:if v_earn_rate <= 0 then return; end if;
--     步驟 5:if v_points <= 0 then return; end if;         (金額太小算不到 1 點)
--     步驟 6:if not v_inserted then return; end if;
--     步驟 7:推薦獎勵 ← 在三個 return 的後面
-- 所以商家只要沒設定消費點數比例(points_earn_rate = 0),推薦獎勵就**永遠發不出去**。
--
-- 這同時是兩件事:
--   (a) 一個既有 bug(earn_rate 一直是 0 的商家,推薦獎勵從來不會發)。
--   (b) 被這一批「推薦獎勵的第一筆消費改成數已完成訂單」放大成更糟的情境:
--       被推薦人第一筆訂單完成時 earn_rate=0(沒發推薦獎勵),商家後來把 earn_rate 設起來,
--       第二筆訂單完成 → 已完成訂單數是 2 不是 1 → 推薦獎勵**永久失去**。
--       舊邏輯在這個情境下反而發得出來(第二筆才是第 1 筆 earn_booking)。
--
-- 這份測試把兩個情境都釘住。
begin;

select plan(9);

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
-- Fixture:商家刻意「不做消費累點(points_earn_rate = 0)、只做推薦獎勵(50 點)」。
-- =========================================================================
insert into auth.users (id, email) values
  ('da080000-0000-4000-8000-000000000001', 'pgtap-m1008-admin@test.local');

insert into groups (id) values ('da080000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('da080000-0000-4000-8000-000000000020', 'da080000-0000-4000-8000-000000000010',
        '只做推薦獎勵測試店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('da080000-0000-4000-8000-000000000020', 'da080000-0000-4000-8000-000000000001');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'da080000-0000-4000-8000-000000000020', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('da080000-0000-4000-8000-000000000031', 'da080000-0000-4000-8000-000000000020', '洗剪吹', 1000, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('da080000-0000-4000-8000-000000000041', 'da080000-0000-4000-8000-000000000020', '服務人員', '0900001081', true);

insert into payment_methods (id, merchant_id, name) values
  ('da080000-0000-4000-8000-000000000071', 'da080000-0000-4000-8000-000000000020', '現場付款');

-- ⚠️ 核心 fixture:points_earn_rate = 0(不做消費累點),referral_bonus_points = 50(要做推薦獎勵)。
insert into merchant_member_settings (
  merchant_id, points_earn_rate, referral_bonus_points, birthday_bonus_points
) values ('da080000-0000-4000-8000-000000000020', 0, 50, 0);

select pg_temp.test_set_auth('da080000-0000-4000-8000-000000000001');

-- =========================================================================
-- ① 核心:earn_rate = 0 + referral_bonus_points = 50 → 推薦人要拿到 50 點。
-- =========================================================================
select id from create_member('da080000-0000-4000-8000-000000000020', '推薦人', '0955100801') \gset referrer_
select id from create_member(
  'da080000-0000-4000-8000-000000000020', '被推薦人', '0955100802',
  p_referred_by_member_id => :'referrer_id'::uuid
) \gset referred_

select id from create_booking(
  p_merchant_id => 'da080000-0000-4000-8000-000000000020',
  p_staff_id => 'da080000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object(
    'service_item_id','da080000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-20 10:00:00+08',
  p_customer_name => '不做累點只做推薦',
  p_customer_phone => '0955100802',
  p_payment_method_id => 'da080000-0000-4000-8000-000000000071',
  p_member_id => :'referred_id'::uuid
) \gset booking_
select confirm_booking(:'booking_id'::uuid);
select complete_booking(:'booking_id'::uuid);

select is(
  (select points_balance from members where id = :'referrer_id'::uuid),
  50,
  '核心(主腦裁決):商家 points_earn_rate = 0(刻意不做消費累點)但 referral_bonus_points = 50 → 推薦人仍然拿到 50 點。原本步驟 4 的 `if v_earn_rate <= 0 then return` 會讓推薦獎勵永遠發不出去'
);

select is(
  (select count(*)::int from member_point_transactions
    where member_id = :'referrer_id'::uuid and transaction_type = 'referral_bonus'),
  1,
  '核心:確實產生了一筆 referral_bonus 異動紀錄'
);

select ok(
  (select referral_rewarded_at is not null from members where id = :'referred_id'::uuid),
  '核心:被推薦人的 referral_rewarded_at 被正確標記(規則 2.4 第 5 點的冪等標記)'
);

-- 消費累點那一邊仍然正確地「不發」——脫鉤不等於把 earn_rate=0 也當成要累點。
select is(
  (select points_balance from members where id = :'referred_id'::uuid),
  0,
  '脫鉤不是把兩件事都打開:points_earn_rate = 0 時被推薦人自己的消費累點仍然是 0 點(該不發的還是不發)'
);

select is(
  (select count(*)::int from member_point_transactions
    where member_id = :'referred_id'::uuid and transaction_type = 'earn_booking'),
  0,
  '脫鉤不是把兩件事都打開:完全沒有產生 earn_booking 異動紀錄'
);

-- 冪等:同一筆訂單的推薦獎勵不會重複發(原本靠 `if not v_inserted then return` 擋,
-- 改成靠步驟 7 自己的 referral_rewarded_at is null 條件擋,這一條驗證那個防線真的有效)。
-- ⚠️ 這裡必須先 test_clear_auth() 改用 postgres 身分呼叫:compute_member_loyalty_points 的
--    EXECUTE 權限是 `revoke ... from public, anon, authenticated`(它是內部函式,正常只由
--    complete_booking 內部 perform 呼叫),以 authenticated 身分直接呼叫會拿到權限錯誤,
--    那不是這一條要測的東西。
select pg_temp.test_clear_auth();

select lives_ok(
  format($$select compute_member_loyalty_points('%s')$$, :'booking_id'),
  '冪等:對同一筆訂單重複呼叫 compute_member_loyalty_points 不會拋錯'
);

select is(
  (select points_balance from members where id = :'referrer_id'::uuid),
  50,
  '冪等(核心):重複呼叫後推薦人餘額仍然是 50(沒有變成 100)——原本靠「earn_booking 沒插入就 return」擋重複觸發,現在改由步驟 7 自己的 referral_rewarded_at is null 條件承擔,這條防線真的有效'
);

select pg_temp.test_set_auth('da080000-0000-4000-8000-000000000001');

-- =========================================================================
-- ② 情境 (b):被推薦人第一筆訂單在 earn_rate=0 時完成,商家後來才把 earn_rate 設起來。
--    脫鉤之後推薦獎勵在**第一筆**就發掉了,所以不會出現「永久失去」的情況。
-- =========================================================================
update merchant_member_settings set points_earn_rate = 100
where merchant_id = 'da080000-0000-4000-8000-000000000020';

select id from create_booking(
  p_merchant_id => 'da080000-0000-4000-8000-000000000020',
  p_staff_id => 'da080000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object(
    'service_item_id','da080000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-21 10:00:00+08',
  p_customer_name => '第二筆訂單',
  p_customer_phone => '0955100802',
  p_payment_method_id => 'da080000-0000-4000-8000-000000000071',
  p_member_id => :'referred_id'::uuid
) \gset booking2_
select confirm_booking(:'booking2_id'::uuid);
select complete_booking(:'booking2_id'::uuid);

select is(
  (select points_balance from members where id = :'referrer_id'::uuid),
  50,
  '情境(b):商家之後把 points_earn_rate 設成 100,被推薦人完成第二筆訂單 → 推薦人餘額仍然是 50,不會再多發一次(獎勵已經在第一筆就正確發掉了,不是「永久失去」也不是「重複發」)'
);

select is(
  (select points_balance from members where id = :'referred_id'::uuid),
  10,
  '情境(b):被推薦人第二筆訂單正常累到 10 點(1000/100)——消費累點在 earn_rate 設起來之後照常運作'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
