-- 紅利系統重構 批次 4(規格書 .project/specs/紅利系統重構.md §八 批次 4、§2.4、§2.6、§2.7、§3.5、§3.11.2、
-- 檔尾 v2.4 裁決 16)。對應 migration:20261001050000_bonus_refactor_batch4_earn_and_reverse.sql
--
-- 這一檔鎖住的行為:
--   A. 權限與結構:兩支函式都不對 public/anon/authenticated 開放 EXECUTE、SECURITY DEFINER 有 search_path;
--      compute_member_loyalty_points 不再讀 points_earn_rate;complete_booking 本體沒被動;
--      earn_booking 每單一筆唯一索引仍在(由 #844 migration C 處理)
--   B. 完成入帳:入帳 = 建單定案的 points_planned(完成前改規則不影響)、人工派點、派 0 點不寫列、
--      完成時不重查 reward_condition_mode、冪等、功能關閉不入帳、匯入訂單不觸發、非 completed 不處理、
--      已下架會員照發(v2.4 裁決 16,維持現行)
--   C. 推薦獎勵:首次 / 後續 / 派 0 點不觸發後續 / 首次不看派點 / 冪等 / 開關 1 關閉不發也不標記、
--      重新開啟不補發首次 / 開關 2、3 與第 14 題在完成時的組合 / 推薦者資格條件
--   D. 收回合約 §3.11.2:全收回 + note、冪等、p_points_due 不一致擋下、部分收回(扣到 0 + 提示含折抵
--      訂單)、其他訂單折抵完全沒被動、餘額剛好 0 不寫列不 raise、推薦首次收回 + 清 referral_rewarded_at +
--      之後重新發、推薦後續收回且推薦者不足、會員 / 推薦者下架照收、功能關閉照收、找不到訂單、沒入帳全 0
--   E. 跨商家隔離
--   F. v2.4 裁決 17:首次推薦獎勵有差額不清「已拿過首次」標記(下一單不再發首次),補收齊當次才清
--   G. QA 問題 1:推薦獎勵本單淨額 > 0 不再發的專屬測試(部分收回 / 零收回後重跑入帳仍只有 1 筆)
--   H. #844 批次 4 修正(2026-10-01):同一張單有 2 位入帳會員 / 2 位推薦人(#844 邊界 19)時,
--      shortfall_hint 依會員 / 推薦人分句、冠姓名,各自找自己的折抵訂單,不把數字加總混在一起講
begin;

select plan(117);

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

create temporary sequence dayseq;

create function pg_temp.redeem_member(p_phone text)
returns uuid language sql security definer as $$
  select r.member_id from private.resolve_booking_member_by_phone('dc140000-0000-4000-8000-000000000021', p_phone) r
  where r.match_count = 1;
$$;

-- 建單(A 店;不帶 p_member_id,由電話連結既有會員)。每張單自動排在不同天,避免同一位服務人員時段衝突。
create function pg_temp.mk(p_phone text, p_price numeric default 1000,
                           p_override int default null, p_redeemed int default 0)
returns uuid language sql as $$
  select id from public.create_booking(
    p_merchant_id => 'dc140000-0000-4000-8000-000000000021',
    p_staff_id => 'dc140000-0000-4000-8000-000000000041',
    p_service_items => jsonb_build_array(jsonb_build_object(
      'service_item_id', 'dc140000-0000-4000-8000-000000000031', 'quantity', 1, 'unit_price', p_price)),
    p_start_at => timestamptz '2027-02-01 10:00:00+08' + make_interval(days => nextval('pg_temp.dayseq')::int),
    p_customer_name => '批次4客人' || right(p_phone, 3),
    p_customer_phone => p_phone,
    p_payment_method_id => 'dc140000-0000-4000-8000-000000000071',
    p_points_override => p_override,
    p_points_redeemed => p_redeemed,
    -- v2.4 裁決 22 ①:折抵時要帶「要扣誰」= 這支電話對到的會員(正常情況;不符的情境在 module10_13 F 段)。
    p_points_redeem_member_id => case when p_redeemed > 0 then pg_temp.redeem_member(p_phone) end
  );
$$;

-- 確認 + 完成(complete_booking 內部 perform compute_member_loyalty_points)。
create function pg_temp.done(p_booking uuid)
returns void language plpgsql as $$
begin
  perform public.confirm_booking(p_booking);
  perform public.complete_booking(p_booking);
end;
$$;

create function pg_temp.bal(p_member uuid)
returns int language sql as $$ select points_balance from public.members where id = p_member; $$;

create function pg_temp.cnt(p_booking uuid, p_type text)
returns int language sql as $$
  select count(*)::int from public.member_point_transactions where booking_id = p_booking and transaction_type = p_type;
$$;

create function pg_temp.sum_of(p_booking uuid, p_type text)
returns int language sql as $$
  select coalesce(sum(points_delta), 0)::int from public.member_point_transactions
  where booking_id = p_booking and transaction_type = p_type;
$$;

grant usage on sequence pg_temp.dayseq to authenticated;
grant execute on function pg_temp.mk(text, numeric, int, int), pg_temp.done(uuid), pg_temp.redeem_member(text) to authenticated;

-- =========================================================================
-- Fixture
-- =========================================================================
insert into auth.users (id, email) values
  ('dc140000-0000-4000-8000-000000000001', 'pgtap-m1014-admin-a@test.local'),
  ('dc140000-0000-4000-8000-000000000002', 'pgtap-m1014-admin-b@test.local');

insert into groups (id) values
  ('dc140000-0000-4000-8000-000000000011'),
  ('dc140000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('dc140000-0000-4000-8000-000000000021', 'dc140000-0000-4000-8000-000000000011', '紅利批次4測試A店', 'in_store_beauty'),
  ('dc140000-0000-4000-8000-000000000022', 'dc140000-0000-4000-8000-000000000012', '紅利批次4測試B店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('dc140000-0000-4000-8000-000000000021', 'dc140000-0000-4000-8000-000000000001'),
  ('dc140000-0000-4000-8000-000000000022', 'dc140000-0000-4000-8000-000000000002');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select m, d, false, '00:00', '23:59'
from generate_series(0, 6) as d,
     unnest(array['dc140000-0000-4000-8000-000000000021'::uuid, 'dc140000-0000-4000-8000-000000000022'::uuid]) as m;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes, status) values
  ('dc140000-0000-4000-8000-000000000031', 'dc140000-0000-4000-8000-000000000021', '清洗', 1000, 'primary', 30, 'active'),
  ('dc140000-0000-4000-8000-000000000032', 'dc140000-0000-4000-8000-000000000022', 'B店清洗', 1000, 'primary', 30, 'active');

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('dc140000-0000-4000-8000-000000000041', 'dc140000-0000-4000-8000-000000000021', '服務人員A', '0901001401', true),
  ('dc140000-0000-4000-8000-000000000042', 'dc140000-0000-4000-8000-000000000022', '服務人員B', '0901001402', true);

insert into payment_methods (id, merchant_id, name) values
  ('dc140000-0000-4000-8000-000000000071', 'dc140000-0000-4000-8000-000000000021', '現場付款'),
  ('dc140000-0000-4000-8000-000000000072', 'dc140000-0000-4000-8000-000000000022', '現場付款');

-- A 店:基本模式每筆 10 點(最低 500 元);100 點 = 10 元、最多 50%;推薦開關 1 開、首次 20 點、後續 5 點。
insert into merchant_member_settings (
  merchant_id, earn_mode, basic_points_per_order, basic_min_amount,
  redeem_points_unit, redeem_amount_unit, redeem_max_ratio_percent,
  referral_inviter_reward_enabled, referral_bonus_points, referral_subsequent_bonus_points
) values ('dc140000-0000-4000-8000-000000000021', 'basic', 10, 500, 100, 10, 50, true, 20, 5);

-- B 店:每筆 3 點、推薦開關 1 關(用來確認 A 店的完成 / 收回完全不碰 B 店)。
insert into merchant_member_settings (merchant_id, earn_mode, basic_points_per_order, basic_min_amount)
values ('dc140000-0000-4000-8000-000000000022', 'basic', 3, 0);

insert into members (id, merchant_id, name, phone, referral_code, points_balance, status) values
  ('dc140000-0000-4000-8000-000000000101', 'dc140000-0000-4000-8000-000000000021', '快照會員', '0914000101', 'M1014A01', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000102', 'dc140000-0000-4000-8000-000000000021', '人工派點會員', '0914000102', 'M1014A02', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000103', 'dc140000-0000-4000-8000-000000000021', '資格會員', '0914000103', 'M1014A03', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000104', 'dc140000-0000-4000-8000-000000000021', '完成前下架', '0914000104', 'M1014A04', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000105', 'dc140000-0000-4000-8000-000000000021', '功能關閉會員', '0914000105', 'M1014A05', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000110', 'dc140000-0000-4000-8000-000000000021', '推薦人一', '0914000110', 'M1014A10', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000112', 'dc140000-0000-4000-8000-000000000021', '推薦人二', '0914000112', 'M1014A12', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000114', 'dc140000-0000-4000-8000-000000000021', '推薦人三', '0914000114', 'M1014A14', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000116', 'dc140000-0000-4000-8000-000000000021', '推薦人四', '0914000116', 'M1014A16', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000118', 'dc140000-0000-4000-8000-000000000021', '推薦人五', '0914000118', 'M1014A18', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000120', 'dc140000-0000-4000-8000-000000000021', '推薦人六', '0914000120', 'M1014A20', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000122', 'dc140000-0000-4000-8000-000000000021', '推薦人七', '0914000122', 'M1014A22', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000124', 'dc140000-0000-4000-8000-000000000021', '推薦人八', '0914000124', 'M1014A24', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000130', 'dc140000-0000-4000-8000-000000000021', '部分收回會員', '0914000130', 'M1014A30', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000131', 'dc140000-0000-4000-8000-000000000021', '餘額歸零會員', '0914000131', 'M1014A31', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000132', 'dc140000-0000-4000-8000-000000000021', '收回前下架', '0914000132', 'M1014A32', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000133', 'dc140000-0000-4000-8000-000000000021', '收回時功能關閉', '0914000133', 'M1014A33', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000134', 'dc140000-0000-4000-8000-000000000021', '全收回會員', '0914000134', 'M1014A34', 100, 'active'),
  ('dc140000-0000-4000-8000-000000000201', 'dc140000-0000-4000-8000-000000000022', 'B店會員', '0914000201', 'M1014B01', 0, 'active');

-- 被推薦者(referred_by 指向上面的推薦人)。
insert into members (id, merchant_id, name, phone, referral_code, points_balance, status, referred_by_member_id) values
  ('dc140000-0000-4000-8000-000000000111', 'dc140000-0000-4000-8000-000000000021', '被推薦一', '0914000111', 'M1014A11', 0, 'active', 'dc140000-0000-4000-8000-000000000110'),
  ('dc140000-0000-4000-8000-000000000113', 'dc140000-0000-4000-8000-000000000021', '被推薦二', '0914000113', 'M1014A13', 0, 'active', 'dc140000-0000-4000-8000-000000000112'),
  ('dc140000-0000-4000-8000-000000000115', 'dc140000-0000-4000-8000-000000000021', '被推薦三', '0914000115', 'M1014A15', 0, 'active', 'dc140000-0000-4000-8000-000000000114'),
  ('dc140000-0000-4000-8000-000000000117', 'dc140000-0000-4000-8000-000000000021', '被推薦四', '0914000117', 'M1014A17', 0, 'active', 'dc140000-0000-4000-8000-000000000116'),
  ('dc140000-0000-4000-8000-000000000119', 'dc140000-0000-4000-8000-000000000021', '被推薦五', '0914000119', 'M1014A19', 0, 'active', 'dc140000-0000-4000-8000-000000000118'),
  -- 121:同時是被推薦者(推薦人六)也是推薦者(推薦了 125)—— 第 14 題
  ('dc140000-0000-4000-8000-000000000121', 'dc140000-0000-4000-8000-000000000021', '兩者皆是', '0914000121', 'M1014A21', 0, 'active', 'dc140000-0000-4000-8000-000000000120'),
  ('dc140000-0000-4000-8000-000000000123', 'dc140000-0000-4000-8000-000000000021', '被推薦七', '0914000123', 'M1014A23', 0, 'active', 'dc140000-0000-4000-8000-000000000122'),
  ('dc140000-0000-4000-8000-000000000125', 'dc140000-0000-4000-8000-000000000021', '被推薦八', '0914000125', 'M1014A25', 0, 'active', 'dc140000-0000-4000-8000-000000000121'),
  ('dc140000-0000-4000-8000-000000000127', 'dc140000-0000-4000-8000-000000000021', '被推薦九', '0914000127', 'M1014A27', 0, 'active', 'dc140000-0000-4000-8000-000000000124');

-- v2.4 裁決 17 / QA 問題 1 用的三組推薦關係(推薦人先建,被推薦者後建)。
insert into members (id, merchant_id, name, phone, referral_code, points_balance, status) values
  ('dc140000-0000-4000-8000-000000000140', 'dc140000-0000-4000-8000-000000000021', '推薦人十', '0914000140', 'M1014A40', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000142', 'dc140000-0000-4000-8000-000000000021', '推薦人十一', '0914000142', 'M1014A42', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000144', 'dc140000-0000-4000-8000-000000000021', '推薦人十二', '0914000144', 'M1014A44', 0, 'active');
insert into members (id, merchant_id, name, phone, referral_code, points_balance, status, referred_by_member_id) values
  ('dc140000-0000-4000-8000-000000000141', 'dc140000-0000-4000-8000-000000000021', '被推薦十', '0914000141', 'M1014A41', 0, 'active', 'dc140000-0000-4000-8000-000000000140'),
  ('dc140000-0000-4000-8000-000000000143', 'dc140000-0000-4000-8000-000000000021', '被推薦十一', '0914000143', 'M1014A43', 0, 'active', 'dc140000-0000-4000-8000-000000000142'),
  ('dc140000-0000-4000-8000-000000000145', 'dc140000-0000-4000-8000-000000000021', '被推薦十二', '0914000145', 'M1014A45', 0, 'active', 'dc140000-0000-4000-8000-000000000144');

-- =========================================================================
-- A. 權限與結構
-- =========================================================================
select ok(
  not has_function_privilege('anon', 'public.compute_member_loyalty_points(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.compute_member_loyalty_points(uuid)', 'execute'),
  'A1 §3.5:compute_member_loyalty_points 仍然不對 anon / authenticated 開放(只由 complete_booking 內部呼叫)'
);
select ok(
  not has_function_privilege('anon', 'private.reverse_booking_earned_points(uuid, integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.reverse_booking_earned_points(uuid, integer)', 'execute'),
  'A2 §3.11.2:reverse_booking_earned_points 不對 anon / authenticated 開放(只給 #844 的反轉函式內部呼叫)'
);
select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.oid in ('public.compute_member_loyalty_points(uuid)'::regprocedure,
                    'private.reverse_booking_earned_points(uuid, integer)'::regprocedure)
      and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'A3 兩支函式的 EXECUTE 都沒有給 PUBLIC'
);
select ok(
  (select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
   from pg_proc p
   where p.oid in ('public.compute_member_loyalty_points(uuid)'::regprocedure,
                   'private.reverse_booking_earned_points(uuid, integer)'::regprocedure)),
  'A4 兩支函式都是 SECURITY DEFINER 且固定 search_path'
);
select ok(
  (select prosrc not like '%points_earn_rate%' from pg_proc
   where oid = 'public.compute_member_loyalty_points(uuid)'::regprocedure),
  'A5 §3.5 / 判斷 19:compute_member_loyalty_points 新主體不再讀 points_earn_rate(批次 6 要 drop 這個欄位)'
);
-- #844 migration C(20261001090200)之後改寫 A6 / A7(原斷言是「本批不動」那個時間點的快照):
--   A6 原本:complete_booking 指紋 = 正式庫 4cfb1487…/1088。migration C 在讀狀態那一句加了 for update,
--      指紋必然改變 ⇒ 改成「把那個 for update 拿掉之後 = 正式庫指紋」,證明紅利批次 4 沒動它、#844 也只加了這一個字。
--   A7 原本:earn_booking 每單一筆唯一索引仍在。migration C 依規格移除 ⇒ 改成斷言「已不存在」
--      (冪等改淨額判斷,下面 B4/B5「重複呼叫不重複入帳」照守)。
select is(
  (select md5(replace(replace(prosrc, E'\r\n', E'\n'), E'where id = p_booking_id\n  for update;', 'where id = p_booking_id;'))
          || '/' || length(replace(replace(prosrc, E'\r\n', E'\n'), E'where id = p_booking_id\n  for update;', 'where id = p_booking_id;'))
   from pg_proc where oid = 'public.complete_booking(uuid)'::regprocedure),
  '4cfb14875fbb5ffc365373b046907520/1088',
  'A6 §3.5 + #844 §3.11:complete_booking 除了 #844 加的 for update 之外,本體與正式庫指紋一致'
);
select ok(
  not exists (select 1 from pg_indexes where schemaname = 'public'
          and indexname = 'member_point_transactions_earn_booking_unique_idx'),
  'A7 §1.5 / §九末尾:earn_booking 每單一筆唯一索引已由 #844 migration C 移除(冪等改淨額判斷)'
);

-- =========================================================================
-- B. 完成入帳 = points_planned 快照
-- =========================================================================
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000101') as id \gset b1_
select pg_temp.test_clear_auth();

-- 完成前商家把規則改掉(每筆 99 點)—— 入帳仍是建單時定案的 10 點。
update merchant_member_settings set basic_points_per_order = 99 where merchant_id = 'dc140000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.done(:'b1_id'::uuid);
select pg_temp.test_clear_auth();
update merchant_member_settings set basic_points_per_order = 10 where merchant_id = 'dc140000-0000-4000-8000-000000000021';

select is(pg_temp.sum_of(:'b1_id'::uuid, 'earn_booking'), 10,
  'B1 §2.4(核心):入帳 = 建單定案的 points_planned 10 點,不是完成當下用新規則(99 點)現算');
select is(pg_temp.bal('dc140000-0000-4000-8000-000000000101'), 10, 'B2 會員餘額 +10');
select is(
  (select balance_after from member_point_transactions where booking_id = :'b1_id'::uuid and transaction_type = 'earn_booking'),
  10, 'B3 earn_booking 的 balance_after 正確');

-- 冪等:同一張單再呼叫一次入帳。
select public.compute_member_loyalty_points(:'b1_id'::uuid);
select is(pg_temp.cnt(:'b1_id'::uuid, 'earn_booking'), 1, 'B4 冪等:同一張單重複呼叫入帳,仍只有 1 筆 earn_booking');
select is(pg_temp.bal('dc140000-0000-4000-8000-000000000101'), 10, 'B5 冪等:餘額沒有被重複加');

-- 人工派點 77 點 / 人工派 0 點。
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000102', 1000, 77) as id \gset b2_
select pg_temp.done(:'b2_id'::uuid);
select pg_temp.mk('0914000102', 1000, 0) as id \gset b3_
select pg_temp.done(:'b3_id'::uuid);
select pg_temp.test_clear_auth();

select is(pg_temp.sum_of(:'b2_id'::uuid, 'earn_booking'), 77, 'B6 §2.5:客服人工派點 77 點 ⇒ 完成時入帳 77 點');
select is(pg_temp.cnt(:'b3_id'::uuid, 'earn_booking'), 0, 'B7 人工派 0 點 ⇒ 完成時不寫 earn_booking(points_delta <> 0)');
select is(pg_temp.bal('dc140000-0000-4000-8000-000000000102'), 77, 'B8 人工派點會員餘額 = 77');

-- §2.7:資格在建單當下判斷,完成時不重查。
--   (a) 建單時 mode = none(派 10 點),完成前改成 line_bound(會員沒綁 LINE)⇒ 照樣入帳 10 點。
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000103') as id \gset b4_
select pg_temp.test_clear_auth();
update merchant_member_settings set reward_condition_mode = 'line_bound' where merchant_id = 'dc140000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.done(:'b4_id'::uuid);
--   (b) 建單時已是 line_bound ⇒ 派 0 點;完成前改回 none ⇒ 仍然不入帳。
select pg_temp.mk('0914000103') as id \gset b5_
select pg_temp.test_clear_auth();
update merchant_member_settings set reward_condition_mode = 'none' where merchant_id = 'dc140000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.done(:'b5_id'::uuid);
select pg_temp.test_clear_auth();

select is(pg_temp.sum_of(:'b4_id'::uuid, 'earn_booking'), 10,
  'B9 §2.7 / 第 9 題:建單時符合資格(派 10 點),完成前商家改成 line_bound ⇒ 完成時不重查,照樣入帳 10 點');
select is(
  (select row(points_planned, points_planned_auto)::text from bookings where id = :'b5_id'::uuid),
  '(0,0)', 'B10 §2.7:建單時不符資格 ⇒ points_planned = 0');
select is(pg_temp.cnt(:'b5_id'::uuid, 'earn_booking'), 0,
  'B11 §2.7:建單時不符資格(0 點),完成前改回不設條件 ⇒ 完成時也不重算、不入帳');

-- 功能總開關:完成當下關閉 ⇒ 不入帳(建單時派了 10 點)。
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000105') as id \gset b6_
select pg_temp.test_clear_auth();
update merchant_member_settings set points_feature_enabled = false where merchant_id = 'dc140000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.done(:'b6_id'::uuid);
select pg_temp.test_clear_auth();
update merchant_member_settings set points_feature_enabled = true where merchant_id = 'dc140000-0000-4000-8000-000000000021';

select is((select points_planned from bookings where id = :'b6_id'::uuid), 10, 'B12 前提:建單時功能開著,points_planned = 10');
select is(pg_temp.cnt(:'b6_id'::uuid, 'earn_booking'), 0,
  'B13 §2.4 / 第 9 題例外:完成當下紅利功能關閉 ⇒ 不入帳(開關在完成時仍要看)');
select is(pg_temp.bal('dc140000-0000-4000-8000-000000000105'), 0, 'B14 功能關閉期間完成,會員餘額不變');

-- 匯入訂單(source = 'import',直接 completed)不觸發;非 completed 訂單不處理。
insert into bookings (id, merchant_id, staff_id, customer_name, customer_phone, start_at, end_at, status, source,
                      created_by_role, member_id, points_planned)
values ('dc140000-0000-4000-8000-000000000901', 'dc140000-0000-4000-8000-000000000021',
        'dc140000-0000-4000-8000-000000000041', '匯入客人', '0914000101',
        '2020-01-01 10:00+08', '2020-01-01 10:30+08', 'completed', 'import', 'admin',
        'dc140000-0000-4000-8000-000000000101', 50);
select public.compute_member_loyalty_points('dc140000-0000-4000-8000-000000000901');
select is(
  (select count(*)::int from member_point_transactions where booking_id = 'dc140000-0000-4000-8000-000000000901'),
  0, 'B15 §2.4:匯入的歷史訂單(source=import)即使 points_planned > 0 也不觸發入帳');

select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000101') as id \gset b7_
select public.confirm_booking(:'b7_id'::uuid);
select pg_temp.test_clear_auth();
select public.compute_member_loyalty_points(:'b7_id'::uuid);
select is(pg_temp.cnt(:'b7_id'::uuid, 'earn_booking'), 0,
  'B16 非 completed(已確認)的訂單直接呼叫入帳 ⇒ 不處理(只有完成才入帳)');

-- v2.4 裁決 16:已下架會員的訂單完成時維持現行照發(等 #942)。
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000104') as id \gset b8_
select pg_temp.test_clear_auth();
update members set status = 'removed' where id = 'dc140000-0000-4000-8000-000000000104';
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.done(:'b8_id'::uuid);
select pg_temp.test_clear_auth();
select is(pg_temp.sum_of(:'b8_id'::uuid, 'earn_booking'), 10,
  'B17 v2.4 裁決 16:會員在完成前被下架 ⇒ 維持現行照發 10 點(待使用者裁決 #942)');

-- =========================================================================
-- C. 推薦獎勵
-- =========================================================================
-- C-1 被推薦一:第一筆(派 10 點)→ 首次 20;第二筆(派 10 點)→ 後續 5;第三筆(人工派 0 點)→ 不發。
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000111') as id \gset c1_
select pg_temp.done(:'c1_id'::uuid);
select pg_temp.test_clear_auth();

select is(pg_temp.sum_of(:'c1_id'::uuid, 'referral_bonus'), 20, 'C1 §2.6:被推薦者第一筆完成 ⇒ 推薦者得首次獎勵 20 點');
select is(
  (select row(member_id, related_member_id)::text from member_point_transactions
   where booking_id = :'c1_id'::uuid and transaction_type = 'referral_bonus'),
  row('dc140000-0000-4000-8000-000000000110'::uuid, 'dc140000-0000-4000-8000-000000000111'::uuid)::text,
  'C2 首次獎勵發給推薦者,帶 booking_id 與 related_member_id(收回時查得到)');
select isnt((select referral_rewarded_at from members where id = 'dc140000-0000-4000-8000-000000000111'), null,
  'C3 被推薦者 referral_rewarded_at 已標記');
select is(pg_temp.sum_of(:'c1_id'::uuid, 'earn_booking'), 10, 'C4 被推薦者自己照常入帳 10 點');

select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000111') as id \gset c2_
select pg_temp.done(:'c2_id'::uuid);
select pg_temp.mk('0914000111', 1000, 0) as id \gset c3_
select pg_temp.done(:'c3_id'::uuid);
select pg_temp.test_clear_auth();

select is(pg_temp.sum_of(:'c2_id'::uuid, 'referral_repeat_bonus'), 5,
  'C5 §2.6 / 第 7 題:第二筆「有派到點」⇒ 推薦者得後續獎勵 5 點(referral_repeat_bonus)');
select is(pg_temp.cnt(:'c2_id'::uuid, 'referral_bonus'), 0, 'C6 第二筆不會再發首次獎勵');
select is(pg_temp.cnt(:'c3_id'::uuid, 'referral_repeat_bonus'), 0,
  'C7 第 7 題:派 0 點的訂單不算「達標」⇒ 不發後續獎勵');
select is(pg_temp.bal('dc140000-0000-4000-8000-000000000110'), 25, 'C8 推薦人一餘額 = 20 + 5');

-- 冪等:第二筆重複呼叫入帳 ⇒ 後續獎勵不重複發。
select public.compute_member_loyalty_points(:'c2_id'::uuid);
select is(pg_temp.cnt(:'c2_id'::uuid, 'referral_repeat_bonus'), 1, 'C9 冪等:重複呼叫不重複發後續獎勵');
select public.compute_member_loyalty_points(:'c1_id'::uuid);
select is(pg_temp.cnt(:'c1_id'::uuid, 'referral_bonus'), 1, 'C10 冪等:重複呼叫不重複發首次獎勵');
select is(pg_temp.bal('dc140000-0000-4000-8000-000000000110'), 25, 'C11 冪等:推薦人餘額仍是 25');

-- C-2 首次獎勵不看本單有沒有派到點(第 7 題「首次不看」):被推薦二第一筆人工派 0 點。
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000113', 1000, 0) as id \gset c4_
select pg_temp.done(:'c4_id'::uuid);
select pg_temp.mk('0914000113') as id \gset c5_
select pg_temp.done(:'c5_id'::uuid);
select pg_temp.test_clear_auth();
select is(pg_temp.sum_of(:'c4_id'::uuid, 'referral_bonus'), 20,
  'C12 第 7 題:首次獎勵不看本單有沒有派到點(本單派 0 點,推薦者照得 20 點)');
select is(pg_temp.sum_of(:'c5_id'::uuid, 'referral_repeat_bonus'), 5, 'C13 被推薦二第二筆有派到點 ⇒ 後續 5 點');

-- C-3 開關 1 關閉:不發、不標記;重新開啟後第二筆不補發首次,只發後續。
update merchant_member_settings set referral_inviter_reward_enabled = false where merchant_id = 'dc140000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000115') as id \gset c6_
select pg_temp.done(:'c6_id'::uuid);
select pg_temp.test_clear_auth();
select is(
  (select count(*)::int from member_point_transactions
   where booking_id = :'c6_id'::uuid and transaction_type in ('referral_bonus', 'referral_repeat_bonus')),
  0, 'C14 §2.6 開關 1 關閉:被推薦者第一筆完成,推薦者什麼都不拿');
select is((select referral_rewarded_at from members where id = 'dc140000-0000-4000-8000-000000000115'), null,
  'C15 §2.6 開關 1 關閉:不標記 referral_rewarded_at');
select is(pg_temp.sum_of(:'c6_id'::uuid, 'earn_booking'), 10, 'C16 開關 1 只管推薦獎勵,被推薦者自己照常入帳');

update merchant_member_settings set referral_inviter_reward_enabled = true where merchant_id = 'dc140000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000115') as id \gset c7_
select pg_temp.done(:'c7_id'::uuid);
select pg_temp.test_clear_auth();
select is(pg_temp.cnt(:'c7_id'::uuid, 'referral_bonus'), 0,
  'C17 §2.6:開關 1 重新開啟後,被推薦者第二筆完成不補發首次獎勵(關閉期間名額視為用掉)');
select is(pg_temp.sum_of(:'c7_id'::uuid, 'referral_repeat_bonus'), 5, 'C18 重新開啟後第二筆有派到點 ⇒ 發後續 5 點');

-- C-4 開關 3(被推薦者不累積)關閉:被推薦四建單派 0 點 ⇒ 不入帳;首次獎勵仍發,後續不發。
update merchant_member_settings set referral_invitee_earning_enabled = false where merchant_id = 'dc140000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000117') as id \gset c8_
select pg_temp.done(:'c8_id'::uuid);
select pg_temp.mk('0914000117') as id \gset c9_
select pg_temp.done(:'c9_id'::uuid);
-- 推薦人四自己(推薦過人、沒被推薦)在開關 3 關閉時照常累積。
select pg_temp.mk('0914000116') as id \gset c10_
select pg_temp.done(:'c10_id'::uuid);
select pg_temp.test_clear_auth();
update merchant_member_settings set referral_invitee_earning_enabled = true where merchant_id = 'dc140000-0000-4000-8000-000000000021';

select is(pg_temp.cnt(:'c8_id'::uuid, 'earn_booking') + pg_temp.cnt(:'c9_id'::uuid, 'earn_booking'), 0,
  'C19 §2.6 開關 3 關閉:被推薦者自己的兩筆訂單都不入帳');
select is(pg_temp.sum_of(:'c8_id'::uuid, 'referral_bonus'), 20,
  'C20 開關 3 關閉不影響推薦者的首次獎勵(開關 1 開著)');
select is(pg_temp.cnt(:'c9_id'::uuid, 'referral_repeat_bonus'), 0,
  'C21 開關 3 關閉:被推薦者後續訂單沒派到點 ⇒ 推薦者不拿後續獎勵');
select is(pg_temp.sum_of(:'c10_id'::uuid, 'earn_booking'), 10,
  'C22 開關 3 關閉時,推薦者本人(沒被推薦)照常入帳');

-- C-5 開關 2(推薦者不累積)關閉 + 第 14 題:兩者皆是(121)不累積;純被推薦者(125,推薦人是 121)照常,
--     且 121 仍拿推薦獎勵(開關 2 只擋「累積」,不擋推薦獎勵)。
update merchant_member_settings set referral_inviter_earning_enabled = false where merchant_id = 'dc140000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000121') as id \gset c11_
select pg_temp.done(:'c11_id'::uuid);
select pg_temp.mk('0914000125') as id \gset c12_
select pg_temp.done(:'c12_id'::uuid);
select pg_temp.test_clear_auth();
update merchant_member_settings set referral_inviter_earning_enabled = true where merchant_id = 'dc140000-0000-4000-8000-000000000021';

select is(pg_temp.cnt(:'c11_id'::uuid, 'earn_booking'), 0,
  'C23 第 14 題:同時是推薦者與被推薦者,開關 2 關閉 ⇒ 自己的訂單不累積');
select is(pg_temp.sum_of(:'c11_id'::uuid, 'referral_bonus'), 20,
  'C24 兩者皆是的會員第一筆完成 ⇒ 他的推薦人(推薦人六)照得首次獎勵');
select is(pg_temp.sum_of(:'c12_id'::uuid, 'earn_booking'), 10, 'C25 開關 2 關閉不影響純被推薦者的累積');
select is(
  (select sum(points_delta)::int from member_point_transactions
   where booking_id = :'c12_id'::uuid and member_id = 'dc140000-0000-4000-8000-000000000121' and transaction_type = 'referral_bonus'),
  20, 'C26 第 15 題精神:開關 2 關閉只擋推薦者「消費累積」,不擋他拿推薦獎勵');

-- C-6 推薦者在觸發當下不符資格(line_bound,推薦者沒綁)⇒ 不發,但首次名額照樣標記;
--     被推薦者不符資格 ⇒ 推薦獎勵整段不評估、不標記。
update members set line_bound = true where id = 'dc140000-0000-4000-8000-000000000123';
update merchant_member_settings set reward_condition_mode = 'line_bound' where merchant_id = 'dc140000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000123') as id \gset c13_
select pg_temp.done(:'c13_id'::uuid);
select pg_temp.mk('0914000127', 1000, 10) as id \gset c14_
select pg_temp.done(:'c14_id'::uuid);
select pg_temp.test_clear_auth();
update merchant_member_settings set reward_condition_mode = 'none' where merchant_id = 'dc140000-0000-4000-8000-000000000021';

select is(pg_temp.cnt(:'c13_id'::uuid, 'referral_bonus'), 0,
  'C27 推薦者觸發當下不符 reward_condition_mode(沒綁 LINE)⇒ 不發推薦獎勵(沿用既有)');
select isnt((select referral_rewarded_at from members where id = 'dc140000-0000-4000-8000-000000000123'), null,
  'C28 首次資格成立即標記 referral_rewarded_at(不論推薦者是否符合資格,沿用既有規則 2.4 第 5 點)');
select is(pg_temp.sum_of(:'c14_id'::uuid, 'earn_booking'), 10,
  'C29 被推薦者不符資格但客服人工派 10 點 ⇒ 自己照常入帳(完成時不重查資格)');
select ok(
  pg_temp.cnt(:'c14_id'::uuid, 'referral_bonus') = 0
  and (select referral_rewarded_at is null from members where id = 'dc140000-0000-4000-8000-000000000127'),
  'C30 被推薦者觸發當下不符資格 ⇒ 推薦獎勵不評估、也不標記(沿用既有)');

-- =========================================================================
-- D. 收回合約 private.reverse_booking_earned_points
-- =========================================================================
-- D-1 全收回(會員原本 100 點,入帳 10 點 → 110)。
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000134') as id \gset d1_
select pg_temp.done(:'d1_id'::uuid);
select pg_temp.test_clear_auth();

select throws_ok(
  format($$select private.reverse_booking_earned_points('%s', 11)$$, :'d1_id'),
  '22023', null, 'D1 p_points_due 跟分類帳算的不一樣(傳 11、實際 10)⇒ raise,防止呼叫端算錯');
select is(pg_temp.bal('dc140000-0000-4000-8000-000000000134'), 110, 'D2 擋下之後什麼都沒動');

select private.reverse_booking_earned_points(:'d1_id'::uuid, 10) as r \gset d1_
select is(
  :'d1_r'::jsonb - 'referrer_member_id' - 'shortfall_hint',
  '{"points_due":10,"points_recovered":10,"points_shortfall":0,"referral_due":0,"referral_recovered":0,"referral_shortfall":0}'::jsonb,
  'D3 §3.11.2:餘額夠 ⇒ 全收回,回傳三個數字正確、差額 0');
select ok((:'d1_r'::jsonb ->> 'shortfall_hint') is null and (:'d1_r'::jsonb ->> 'referrer_member_id') is null,
  'D4 沒有差額 ⇒ shortfall_hint 為 null;沒有推薦獎勵 ⇒ referrer_member_id 為 null');
select is(pg_temp.bal('dc140000-0000-4000-8000-000000000134'), 100, 'D5 會員餘額扣回 10(110 → 100)');
select is(
  (select row(points_delta, balance_after, note)::text from member_point_transactions
   where booking_id = :'d1_id'::uuid and transaction_type = 'earn_booking_reversal'),
  row(-10, 100, '應收回 10 點、實收回 10 點、差額 0 點未收回')::text,
  'D6 分類帳留一筆 earn_booking_reversal(−10),note 固定格式三個數字(差額 0 也寫)');
select is((select points_planned from bookings where id = :'d1_id'::uuid), 10,
  'D7 §3.11.2 第 5 步:bookings.points_planned 快照不動');

select private.reverse_booking_earned_points(:'d1_id'::uuid) as r \gset d1b_
select is(
  :'d1b_r'::jsonb - 'referrer_member_id' - 'shortfall_hint',
  '{"points_due":0,"points_recovered":0,"points_shortfall":0,"referral_due":0,"referral_recovered":0,"referral_shortfall":0}'::jsonb,
  'D8 冪等:第二次呼叫回傳全 0');
select is(pg_temp.cnt(:'d1_id'::uuid, 'earn_booking_reversal'), 1, 'D9 冪等:第二次呼叫不再寫分類帳');
select lives_ok(
  format($$select private.reverse_booking_earned_points('%s', 0)$$, :'d1_id'),
  'D10 已全部收回後,呼叫端傳 p_points_due = 0 ⇒ 一致,不 raise');

-- D-2 部分收回:入帳 50 點(人工派)→ 在另一張單折抵 40 點 → 剩 10 → 收回 A 單。
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000130', 1000, 50) as id \gset d2a_
select pg_temp.done(:'d2a_id'::uuid);
select pg_temp.mk('0914000130', 1000, null, 40) as id \gset d2b_
select pg_temp.test_clear_auth();

select is(pg_temp.bal('dc140000-0000-4000-8000-000000000130'), 10, 'D11 前提:入帳 50、折抵 40 ⇒ 餘額 10');
select (select count(*) from member_point_transactions where booking_id = :'d2b_id'::uuid) as n,
       (select row(points_redeemed, points_redeem_amount_snapshot, status)::text from bookings where id = :'d2b_id'::uuid) as snap
\gset d2b_before_

select private.reverse_booking_earned_points(:'d2a_id'::uuid) as r \gset d2_
select is(
  :'d2_r'::jsonb - 'referrer_member_id' - 'shortfall_hint',
  '{"points_due":50,"points_recovered":10,"points_shortfall":40,"referral_due":0,"referral_recovered":0,"referral_shortfall":0}'::jsonb,
  'D12 第 1 題定案 A:餘額不夠 ⇒ 扣到 0 為止(應收 50、實收 10、差額 40)');
select is(pg_temp.bal('dc140000-0000-4000-8000-000000000130'), 0, 'D13 餘額扣到 0,沒有變負');
select is(
  (select row(points_delta, balance_after, note)::text from member_point_transactions
   where booking_id = :'d2a_id'::uuid and transaction_type = 'earn_booking_reversal'),
  row(-10, 0, '應收回 50 點、實收回 10 點、差額 40 點未收回')::text,
  'D14 分類帳 −10、balance_after 0、note 三個數字正確');
select ok(
  (:'d2_r'::jsonb ->> 'shortfall_hint') like '應收回 50 點,會員目前只有 10 點,已收回 10 點,差額 40 點未收回。%'
  and (:'d2_r'::jsonb ->> 'shortfall_hint') like '%批次4客人130%取消紅利折抵%手動調整點數%',
  'D15 shortfall_hint:有差額 ⇒ 有提示,且指出在哪張訂單折抵掉(用預約時間 + 客戶姓名辨識)');
select is(
  (select count(*) from member_point_transactions where booking_id = :'d2b_id'::uuid)::text
    || '|' || (select row(points_redeemed, points_redeem_amount_snapshot, status)::text from bookings where id = :'d2b_id'::uuid),
  :'d2b_before_n' || '|' || :'d2b_before_snap',
  'D16 §3.11.3(核心):該會員另一張有折抵的訂單完全沒被動到(分類帳筆數、折抵點數 / 金額、狀態都不變)');
select is((select min(balance_after) from member_point_transactions where member_id = 'dc140000-0000-4000-8000-000000000130'), 0,
  'D17 兩道不可為負 CHECK 沒被觸發(該會員所有分類帳 balance_after >= 0)');

-- D-3 餘額剛好 0:入帳 30 點後餘額被歸 0(模擬已被用掉)⇒ 收回成功、不寫列。
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000131', 1000, 30) as id \gset d3_
select pg_temp.done(:'d3_id'::uuid);
select pg_temp.test_clear_auth();
update members set points_balance = 0 where id = 'dc140000-0000-4000-8000-000000000131';

select lives_ok(
  format($$select private.reverse_booking_earned_points('%s', 30)$$, :'d3_id'),
  'D18 §3.11.2(核心):會員餘額剛好 0 時收回 ⇒ 不 raise(points_delta <> 0 CHECK 不會被撞到)');
select is(pg_temp.cnt(:'d3_id'::uuid, 'earn_booking_reversal'), 0, 'D19 實收回 0 ⇒ 不寫任何分類帳列');
select private.reverse_booking_earned_points(:'d3_id'::uuid) as r \gset d3_
select is(
  :'d3_r'::jsonb - 'referrer_member_id' - 'shortfall_hint',
  '{"points_due":30,"points_recovered":0,"points_shortfall":30,"referral_due":0,"referral_recovered":0,"referral_shortfall":0}'::jsonb,
  'D20 回傳 points_recovered = 0、points_shortfall = due(30),由呼叫端 #844 記錄');
select ok((:'d3_r'::jsonb ->> 'shortfall_hint') like '應收回 30 點,會員目前只有 0 點,已收回 0 點,差額 30 點未收回。%',
  'D21 有差額 ⇒ shortfall_hint 有值(找不到折抵訂單就省略「訂單」那一句)');
select ok((:'d3_r'::jsonb ->> 'shortfall_hint') not like '%訂單「%', 'D22 沒有折抵訂單 ⇒ 提示不提訂單');

-- D-4 推薦獎勵首次收回:被推薦五第一筆 → 推薦人五 +20;模擬 #844 取消 → 收回 → 清 referral_rewarded_at →
--     下一筆完成重新發首次獎勵。
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000119') as id \gset d4_
select pg_temp.done(:'d4_id'::uuid);
select pg_temp.test_clear_auth();
select is(pg_temp.bal('dc140000-0000-4000-8000-000000000118'), 20, 'D23 前提:推薦人五拿到首次獎勵 20');

update bookings set status = 'cancelled' where id = :'d4_id'::uuid;  -- 模擬 #844 取消已完成訂單(狀態機由 #844 開)
select private.reverse_booking_earned_points(:'d4_id'::uuid) as r \gset d4_
select is(
  :'d4_r'::jsonb - 'shortfall_hint',
  jsonb_build_object('points_due', 10, 'points_recovered', 10, 'points_shortfall', 0,
                     'referral_due', 20, 'referral_recovered', 20, 'referral_shortfall', 0,
                     'referrer_member_id', 'dc140000-0000-4000-8000-000000000118'),
  'D24 第 8 題:本人入帳與推薦者首次獎勵一併收回,回傳推薦者 id');
select is(pg_temp.bal('dc140000-0000-4000-8000-000000000118'), 0, 'D25 推薦者餘額扣回 20');
select is(
  (select row(points_delta, related_member_id, note)::text from member_point_transactions
   where booking_id = :'d4_id'::uuid and transaction_type = 'referral_bonus_reversal'),
  row(-20, 'dc140000-0000-4000-8000-000000000119'::uuid, '應收回 20 點、實收回 20 點、差額 0 點未收回')::text,
  'D26 分類帳留一筆 referral_bonus_reversal(−20),帶被推薦者、note 三數字');
select is((select referral_rewarded_at from members where id = 'dc140000-0000-4000-8000-000000000119'), null,
  'D27 §2.6:收回首次獎勵 ⇒ 被推薦者 referral_rewarded_at 清回 null');

select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000119') as id \gset d4b_
select pg_temp.done(:'d4b_id'::uuid);
select pg_temp.test_clear_auth();
select is(pg_temp.sum_of(:'d4b_id'::uuid, 'referral_bonus'), 20,
  'D28 §2.6:清掉標記後,被推薦者下一筆完成(真正的第一筆)重新發首次獎勵');

select private.reverse_booking_earned_points(:'d4_id'::uuid) as r \gset d4c_
select ok(
  (:'d4c_r'::jsonb ->> 'referral_due')::int = 0
  and (select referral_rewarded_at is not null from members where id = 'dc140000-0000-4000-8000-000000000119'),
  'D29 冪等:對已收回的那張單再呼叫一次 ⇒ 全 0,且不會把新那筆設好的 referral_rewarded_at 又清掉');

-- D-5 推薦後續獎勵收回,推薦者餘額不足(被推薦二第二筆 c5 → 推薦人二拿了 5;把推薦人二餘額調成 2)。
update members set points_balance = 2 where id = 'dc140000-0000-4000-8000-000000000112';
select private.reverse_booking_earned_points(:'c5_id'::uuid) as r \gset d5_
select is(
  :'d5_r'::jsonb - 'shortfall_hint',
  jsonb_build_object('points_due', 10, 'points_recovered', 10, 'points_shortfall', 0,
                     'referral_due', 5, 'referral_recovered', 2, 'referral_shortfall', 3,
                     'referrer_member_id', 'dc140000-0000-4000-8000-000000000112'),
  'D30 後續獎勵收回:推薦者餘額不足 ⇒ 同樣扣到 0 為止(應收 5、實收 2、差額 3)');
select is(pg_temp.bal('dc140000-0000-4000-8000-000000000112'), 0, 'D31 推薦者餘額扣到 0');
select ok((:'d5_r'::jsonb ->> 'shortfall_hint') like '%推薦人應收回推薦獎勵 5 點%差額 3 點未收回%',
  'D32 推薦獎勵有差額 ⇒ shortfall_hint 有推薦人那一段');
select isnt((select referral_rewarded_at from members where id = 'dc140000-0000-4000-8000-000000000113'), null,
  'D33 收回的是後續獎勵(不是首次)⇒ 不清被推薦者的 referral_rewarded_at');

-- D-6 會員 / 推薦者已下架照樣收回(§3.11.2 第 7 步)。
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000132') as id \gset d6_
select pg_temp.done(:'d6_id'::uuid);
select pg_temp.test_clear_auth();
update members set status = 'removed' where id = 'dc140000-0000-4000-8000-000000000132';
select private.reverse_booking_earned_points(:'d6_id'::uuid) as r \gset d6_
select ok(
  (:'d6_r'::jsonb ->> 'points_recovered')::int = 10
  and pg_temp.bal('dc140000-0000-4000-8000-000000000132') = 0
  and pg_temp.cnt(:'d6_id'::uuid, 'earn_booking_reversal') = 1,
  'D34 §3.11.2 第 7 步:本單會員已下架 ⇒ 照樣收回、分類帳照樣留一筆');

update members set status = 'removed' where id = 'dc140000-0000-4000-8000-000000000110';  -- 推薦人一下架
select private.reverse_booking_earned_points(:'c2_id'::uuid) as r \gset d7_
select ok(
  (:'d7_r'::jsonb ->> 'referral_recovered')::int = 5
  and pg_temp.cnt(:'c2_id'::uuid, 'referral_bonus_reversal') = 1,
  'D35 §3.11.2 第 7 步:推薦者已下架 ⇒ 推薦獎勵照樣收回');

-- D-7 功能「目前關閉」照樣收回(§3.11.2 第 8 步)。
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000133', 1000, 50) as id \gset d8_
select pg_temp.done(:'d8_id'::uuid);
select pg_temp.test_clear_auth();
update merchant_member_settings set points_feature_enabled = false where merchant_id = 'dc140000-0000-4000-8000-000000000021';
select private.reverse_booking_earned_points(:'d8_id'::uuid) as r \gset d8_
update merchant_member_settings set points_feature_enabled = true where merchant_id = 'dc140000-0000-4000-8000-000000000021';
select ok(
  (:'d8_r'::jsonb ->> 'points_recovered')::int = 50
  and pg_temp.bal('dc140000-0000-4000-8000-000000000133') = 0
  and pg_temp.sum_of(:'d8_id'::uuid, 'earn_booking_reversal') = -50,
  'D36 §3.11.2 第 8 步:紅利功能目前關閉 ⇒ 照樣收回 50 點、分類帳留 earn_booking_reversal');

-- D-8 邊界:沒入帳的單(派 0 點)⇒ 全 0;找不到訂單 ⇒ raise。
select is(
  private.reverse_booking_earned_points(:'b3_id'::uuid) - 'referrer_member_id' - 'shortfall_hint',
  '{"points_due":0,"points_recovered":0,"points_shortfall":0,"referral_due":0,"referral_recovered":0,"referral_shortfall":0}'::jsonb,
  'D37 沒有入帳過的訂單 ⇒ 全 0、什麼都不寫');
select throws_ok(
  $$select private.reverse_booking_earned_points(gen_random_uuid())$$,
  'P0002', null, 'D38 找不到訂單 ⇒ raise(不默默回 0,呼叫端傳錯 id 要看得到)');

-- D-9 靜態守門:鎖順序「訂單列 → 會員列依 id 排序」(真正的兩連線併發無法在單一交易 pgTAP 裡做)。
select ok(
  (select prosrc ~ 'where b\.id = p_booking_id\s+for update' and prosrc ~ 'order by m\.id\s+for update'
   from pg_proc where oid = 'private.reverse_booking_earned_points(uuid, integer)'::regprocedure),
  'D39 收回函式先 for update 鎖訂單列,再依會員 id 排序鎖會員列(跟 refund_booking_redeem 同順序)');
select ok(
  (select prosrc ~ 'order by m\.id\s+for update'
   from pg_proc where oid = 'public.compute_member_loyalty_points(uuid)'::regprocedure),
  'D40 入帳函式也依會員 id 排序鎖本單會員與推薦者(避免與收回交叉死鎖)');

-- =========================================================================
-- F. v2.4 裁決 17:首次推薦獎勵有差額 ⇒ 不清「已拿過首次」標記;補收齊當次才清
-- =========================================================================
-- 被推薦十第一筆 → 推薦人十 +20;推薦人十餘額被用光(0);模擬 #844 取消 → 收回。
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000141') as id \gset f1_
select pg_temp.done(:'f1_id'::uuid);
select pg_temp.test_clear_auth();
update members set points_balance = 0 where id = 'dc140000-0000-4000-8000-000000000140';
update bookings set status = 'cancelled' where id = :'f1_id'::uuid;  -- 模擬 #844 取消已完成訂單

select private.reverse_booking_earned_points(:'f1_id'::uuid) as r \gset f1_
select ok(
  (:'f1_r'::jsonb ->> 'referral_due')::int = 20
  and (:'f1_r'::jsonb ->> 'referral_recovered')::int = 0
  and (:'f1_r'::jsonb ->> 'referral_shortfall')::int = 20
  and pg_temp.cnt(:'f1_id'::uuid, 'referral_bonus_reversal') = 0,
  'F1 前提:推薦者餘額 0 ⇒ 首次獎勵應收 20、實收 0、差額 20,不寫分類帳');
select isnt((select referral_rewarded_at from members where id = 'dc140000-0000-4000-8000-000000000141'), null,
  'F2 v2.4 裁決 17(核心):首次獎勵沒全額收回 ⇒ 不清被推薦者的「已拿過首次」標記');

select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000141') as id \gset f2_
select pg_temp.done(:'f2_id'::uuid);
select pg_temp.test_clear_auth();
select is(pg_temp.cnt(:'f2_id'::uuid, 'referral_bonus'), 0,
  'F3 v2.4 裁決 17(核心):同一位被推薦者下一張單完成(已完成訂單數又是 1)⇒ 不再發首次獎勵(第 8 題防刷點)');

-- 推薦人十之後有了點數,再呼叫收回把差額收齊 ⇒ 淨額歸 0,當次才清標記。
update members set points_balance = 50 where id = 'dc140000-0000-4000-8000-000000000140';
select private.reverse_booking_earned_points(:'f1_id'::uuid) as r \gset f1b_
select ok(
  (:'f1b_r'::jsonb ->> 'referral_due')::int = 20
  and (:'f1b_r'::jsonb ->> 'referral_recovered')::int = 20
  and (:'f1b_r'::jsonb ->> 'referral_shortfall')::int = 0
  and pg_temp.sum_of(:'f1_id'::uuid, 'referral_bonus_reversal') = -20,
  'F4 差額之後收齊:第二次收回實收 20、差額 0,分類帳留 −20');
select is((select referral_rewarded_at from members where id = 'dc140000-0000-4000-8000-000000000141'), null,
  'F5 v2.4 裁決 17:淨額歸 0(全額收回)的那一次才清掉「已拿過首次」標記');

-- 部分收回(推薦者只剩 5 點)也不清。
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000143') as id \gset f3_
select pg_temp.done(:'f3_id'::uuid);
select pg_temp.test_clear_auth();
update members set points_balance = 5 where id = 'dc140000-0000-4000-8000-000000000142';
select private.reverse_booking_earned_points(:'f3_id'::uuid) as r \gset f3_
select ok(
  (:'f3_r'::jsonb ->> 'referral_recovered')::int = 5
  and (:'f3_r'::jsonb ->> 'referral_shortfall')::int = 15
  and (select referral_rewarded_at is not null from members where id = 'dc140000-0000-4000-8000-000000000143'),
  'F6 v2.4 裁決 17:首次獎勵部分收回(實收 5、差額 15)⇒ 標記同樣不清');

-- =========================================================================
-- G. QA 問題 1:推薦獎勵「本單淨額 > 0 就不再發」防重複的專屬測試
--    (「已拿過首次」標記被清掉、已完成訂單數仍是 1 時,只剩淨額檢查擋得住重複發放)
-- =========================================================================
-- G-1 部分收回後(淨額 15):把標記清掉,對同一張單再跑一次入帳 ⇒ 首次獎勵仍只有 1 筆。
update members set referral_rewarded_at = null where id = 'dc140000-0000-4000-8000-000000000143';
select public.compute_member_loyalty_points(:'f3_id'::uuid);
select is(pg_temp.cnt(:'f3_id'::uuid, 'referral_bonus'), 1,
  'G1 QA 問題 1(核心):首次獎勵部分收回後(淨額 15 > 0)對同一張單再跑入帳 ⇒ 首次獎勵仍只有 1 筆');
select is(pg_temp.bal('dc140000-0000-4000-8000-000000000142'), 0, 'G2 推薦者餘額沒有被重複加(仍是 0)');

-- G-2 零收回後(淨額 20):同樣再跑入帳 ⇒ 仍只有 1 筆。
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000145') as id \gset g1_
select pg_temp.done(:'g1_id'::uuid);
select pg_temp.test_clear_auth();
update members set points_balance = 0 where id = 'dc140000-0000-4000-8000-000000000144';
select private.reverse_booking_earned_points(:'g1_id'::uuid);
update members set referral_rewarded_at = null where id = 'dc140000-0000-4000-8000-000000000145';
select public.compute_member_loyalty_points(:'g1_id'::uuid);
select is(pg_temp.cnt(:'g1_id'::uuid, 'referral_bonus'), 1,
  'G3 QA 問題 1(核心):首次獎勵零收回後(淨額 20 > 0)對同一張單再跑入帳 ⇒ 首次獎勵仍只有 1 筆');
select is(pg_temp.bal('dc140000-0000-4000-8000-000000000144'), 0, 'G4 推薦者餘額沒有被重複加(仍是 0)');

-- =========================================================================
-- H. #844 批次 4 修正:差額提示依會員 / 推薦人分句(#844 邊界 19「還原後換了會員」)
--    只有 1 位時文字逐字不變(D15 / D21 / D32 守著);2 位以上才分句並冠姓名。
-- =========================================================================
insert into members (id, merchant_id, name, phone, referral_code, points_balance, status) values
  ('dc140000-0000-4000-8000-000000000150', 'dc140000-0000-4000-8000-000000000021', '換會員舊會員', '0914000150', 'M1014A50', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000151', 'dc140000-0000-4000-8000-000000000021', '換會員新會員', '0914000151', 'M1014A51', 200, 'active'),
  ('dc140000-0000-4000-8000-000000000152', 'dc140000-0000-4000-8000-000000000021', '分句推薦人甲', '0914000152', 'M1014A52', 0, 'active'),
  ('dc140000-0000-4000-8000-000000000153', 'dc140000-0000-4000-8000-000000000021', '分句推薦人乙', '0914000153', 'M1014A53', 0, 'active');

-- 舊會員 150 的單完成(人工派 30 點);新會員 151 之後在另一張單折抵 100 點(批次4客人151)。
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000001');
select pg_temp.mk('0914000150', 1000, 30) as id \gset h1_
select pg_temp.done(:'h1_id'::uuid);
select pg_temp.mk('0914000151', 1000, null, 100) as id \gset h2_
select pg_temp.test_clear_auth();

-- 模擬邊界 19:同一張單還原後換成新會員 151 再完成入帳 40 點;兩位推薦人各拿到本單一筆後續獎勵。
insert into member_point_transactions (member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id, related_member_id, note) values
  ('dc140000-0000-4000-8000-000000000151', 'dc140000-0000-4000-8000-000000000021', 'earn_booking', 40, 140, :'h1_id'::uuid, null, 'H 測試:模擬換會員後再完成'),
  ('dc140000-0000-4000-8000-000000000152', 'dc140000-0000-4000-8000-000000000021', 'referral_repeat_bonus', 5, 5, :'h1_id'::uuid, 'dc140000-0000-4000-8000-000000000150', 'H 測試'),
  ('dc140000-0000-4000-8000-000000000153', 'dc140000-0000-4000-8000-000000000021', 'referral_repeat_bonus', 5, 5, :'h1_id'::uuid, 'dc140000-0000-4000-8000-000000000151', 'H 測試');
-- 四個人餘額都不夠扣(點數已花掉)。
update members set points_balance = 5 where id = 'dc140000-0000-4000-8000-000000000150';
update members set points_balance = 15 where id = 'dc140000-0000-4000-8000-000000000151';
update members set points_balance = 2 where id = 'dc140000-0000-4000-8000-000000000152';
update members set points_balance = 0 where id = 'dc140000-0000-4000-8000-000000000153';

select private.reverse_booking_earned_points(:'h1_id'::uuid) as r \gset h1_
select is(
  :'h1_r'::jsonb - 'referrer_member_id' - 'shortfall_hint',
  '{"points_due":70,"points_recovered":20,"points_shortfall":50,"referral_due":10,"referral_recovered":2,"referral_shortfall":8}'::jsonb,
  'H1 前提:兩位會員(30+40)、兩位推薦人(5+5)的加總數字不變(回傳鍵仍是加總)');
select ok(
  (:'h1_r'::jsonb ->> 'shortfall_hint')
    ~ '^會員「換會員舊會員」應收回 30 點,目前只有 5 點,已收回 5 點,差額 25 點未收回。 會員「換會員新會員」',
  'H2(核心):舊會員自己一句、冠姓名、只講自己的 30 / 5 / 25;他沒有折抵單 ⇒ 句尾直接接下一位會員(沒有借用新會員的折抵單)');
select ok(
  (:'h1_r'::jsonb ->> 'shortfall_hint')
    like '%會員「換會員新會員」應收回 40 點,目前只有 15 點,已收回 15 點,差額 25 點未收回。這 25 點是在訂單「% 批次4客人151」折抵掉的%',
  'H3(核心):新會員自己一句,並指出他自己的折抵單(批次4客人151)');
select ok(
  (:'h1_r'::jsonb ->> 'shortfall_hint') not like '%應收回 70 點%'
  and (:'h1_r'::jsonb ->> 'shortfall_hint') not like '%會員目前只有 20 點%',
  'H4 不再把兩位會員的應收回 / 餘額加總成一句(修正前會寫「應收回 70 點,會員目前只有 20 點」)');
select ok(
  (:'h1_r'::jsonb ->> 'shortfall_hint')
    like '%推薦人「分句推薦人甲」應收回推薦獎勵 5 點,目前只有 2 點,已收回 2 點,差額 3 點未收回%',
  'H5 推薦人甲自己一句(5 / 2 / 3)');
select ok(
  (:'h1_r'::jsonb ->> 'shortfall_hint')
    like '%推薦人「分句推薦人乙」應收回推薦獎勵 5 點,目前只有 0 點,已收回 0 點,差額 5 點未收回%'
  and (:'h1_r'::jsonb ->> 'shortfall_hint') not like '%推薦人應收回推薦獎勵 10 點%',
  'H6 推薦人乙自己一句,不再加總成「推薦人應收回推薦獎勵 10 點」');
select ok(
  strpos(:'h1_r'::jsonb ->> 'shortfall_hint', '會員「換會員新會員」') < strpos(:'h1_r'::jsonb ->> 'shortfall_hint', '推薦人「'),
  'H7 順序:會員的句子在前、推薦人的句子在後');

-- =========================================================================
-- E. 跨商家隔離
-- =========================================================================
select pg_temp.test_set_auth('dc140000-0000-4000-8000-000000000002');
select id from public.create_booking(
  p_merchant_id => 'dc140000-0000-4000-8000-000000000022',
  p_staff_id => 'dc140000-0000-4000-8000-000000000042',
  p_service_items => jsonb_build_array(jsonb_build_object(
    'service_item_id', 'dc140000-0000-4000-8000-000000000032', 'quantity', 1, 'unit_price', 1000)),
  p_start_at => '2027-06-01 10:00:00+08',
  p_customer_name => 'B店客人',
  p_customer_phone => '0914000201',
  p_payment_method_id => 'dc140000-0000-4000-8000-000000000072'
) \gset e1_
select pg_temp.done(:'e1_id'::uuid);
select pg_temp.test_clear_auth();

select is(pg_temp.sum_of(:'e1_id'::uuid, 'earn_booking'), 3, 'E1 B 店訂單用 B 店自己的定案點數入帳(3 點),不受 A 店設定影響');
select is(
  (select count(*)::int from member_point_transactions
   where merchant_id = 'dc140000-0000-4000-8000-000000000022'
     and member_id <> 'dc140000-0000-4000-8000-000000000201'),
  0, 'E2 B 店的分類帳只有 B 店會員');
select is(
  (select count(*)::int from member_point_transactions t
   join members m on m.id = t.member_id
   where t.merchant_id = 'dc140000-0000-4000-8000-000000000021' and m.merchant_id <> t.merchant_id),
  0, 'E3 A 店所有入帳 / 推薦 / 收回寫出的分類帳列,會員都屬於 A 店');
select is(
  (select count(*)::int from member_point_transactions t
   join bookings b on b.id = t.booking_id
   where b.merchant_id <> t.merchant_id),
  0, 'E4 所有分類帳列的 merchant_id 都等於訂單的 merchant_id');
select private.reverse_booking_earned_points(:'d2a_id'::uuid);
select is(pg_temp.bal('dc140000-0000-4000-8000-000000000201'), 3, 'E5 收回 A 店訂單完全不碰 B 店會員餘額');

-- 全部會員餘額都不為負(兩道 CHECK 本來就會擋,這裡當總結守門)。
select is((select count(*)::int from members where points_balance < 0), 0, 'E6 沒有任何會員餘額為負');

select * from finish();
rollback;
