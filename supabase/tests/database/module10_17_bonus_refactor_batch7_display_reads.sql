-- 紅利系統重構 批次 7(建單頁紅利區塊 / 訂單詳情 / 會員頁 / 報表卡片)的後端配套測試。
-- 對應 migration 20261001080000_bonus_refactor_batch7_display_reads.sql;
-- 規格書 .project/specs/紅利系統重構.md §3.2、§3.13、§4.6~§4.8,檔尾 v2.4 裁決 21 ①④。
--
-- 測的東西:
--   A. preview_booking_points 新鍵 reward_condition_mode:只在 ineligible_reason = reward_condition 時有值;
--      符合資格時 null;功能關閉仍只回一個鍵(不因新鍵洩漏設定)
--   B. §3.13 get_member_related_bookings 多三欄(預定派點 / 折抵 / 是否人工設定),權限照舊(members 鑰匙)
--   C. v2.4 裁決 21 ①:get_merchant_points_feature_enabled —— 🔴 只有 members 鑰匙的客服在功能關閉時拿到 false
--      (先證明他直接讀設定表是查無列 = 前端 hook 會退回 true 的根因);member_points 也可;
--      orders / billing / 別家管理員 42501;查無設定列 ⇒ true
--   D. §4.7 get_booking_points_ledger:入帳 / 收回 / 有效入帳;從未入帳為 null;只回三個鍵;
--      orders 鑰匙可、沒有 orders 鑰匙 / 別家 / 不存在 一律同一個 42501
--   E. v2.4 裁決 21 ④:merchant_point_formulas 只剩 SELECT 政策;管理員直接 INSERT / UPDATE / DELETE 都 42501;
--      讀照常;寫入走 upsert_member_point_formulas 照常
--   F. 權限衛生:三支函式 PUBLIC / anon 沒有 EXECUTE、authenticated 有
begin;

select plan(46);

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
--   使用者:1 A 店管理員 / 2 客服O(orders)/ 3 客服M(members)/ 4 客服B(billing)/
--           5 客服P(member_points)/ 6 B 店管理員
--   A 店:紅利開啟、基本模式每筆 10 點、資格條件 phone_verified
--   會員:101「未驗證」(phone_verified false)、102「已驗證」(phone_verified true)
-- =========================================================================
insert into auth.users (id, email) values
  ('db170000-0000-4000-8000-000000000001', 'pgtap-m1017-admin@test.local'),
  ('db170000-0000-4000-8000-000000000002', 'pgtap-m1017-agent-orders@test.local'),
  ('db170000-0000-4000-8000-000000000003', 'pgtap-m1017-agent-members@test.local'),
  ('db170000-0000-4000-8000-000000000004', 'pgtap-m1017-agent-billing@test.local'),
  ('db170000-0000-4000-8000-000000000005', 'pgtap-m1017-agent-points@test.local'),
  ('db170000-0000-4000-8000-000000000006', 'pgtap-m1017-admin-b@test.local');

insert into groups (id) values
  ('db170000-0000-4000-8000-000000000010'),
  ('db170000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('db170000-0000-4000-8000-000000000020', 'db170000-0000-4000-8000-000000000010', '紅利畫面測試A店', 'in_store_beauty'),
  ('db170000-0000-4000-8000-000000000021', 'db170000-0000-4000-8000-000000000011', '紅利畫面測試B店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('db170000-0000-4000-8000-000000000020', 'db170000-0000-4000-8000-000000000001'),
  ('db170000-0000-4000-8000-000000000021', 'db170000-0000-4000-8000-000000000006');

insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('db170000-0000-4000-8000-000000000052', 'db170000-0000-4000-8000-000000000020',
   'db170000-0000-4000-8000-000000000002', '客服O', '0900017102', 'pgtap-m1017-agent-orders@test.local', 'active'),
  ('db170000-0000-4000-8000-000000000053', 'db170000-0000-4000-8000-000000000020',
   'db170000-0000-4000-8000-000000000003', '客服M', '0900017103', 'pgtap-m1017-agent-members@test.local', 'active'),
  ('db170000-0000-4000-8000-000000000054', 'db170000-0000-4000-8000-000000000020',
   'db170000-0000-4000-8000-000000000004', '客服B', '0900017104', 'pgtap-m1017-agent-billing@test.local', 'active'),
  ('db170000-0000-4000-8000-000000000055', 'db170000-0000-4000-8000-000000000020',
   'db170000-0000-4000-8000-000000000005', '客服P', '0900017105', 'pgtap-m1017-agent-points@test.local', 'active');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('db170000-0000-4000-8000-000000000052', 'orders', true),
  ('db170000-0000-4000-8000-000000000053', 'members', true),
  ('db170000-0000-4000-8000-000000000054', 'billing', true),
  ('db170000-0000-4000-8000-000000000055', 'member_points', true);

-- B 店刻意不插設定列(若建商家時已自動補了一列,值也一定是預設的 true,C 段斷言照樣成立)。
insert into merchant_member_settings (merchant_id, reward_condition_mode, earn_mode, basic_points_per_order, basic_min_amount)
values ('db170000-0000-4000-8000-000000000020', 'phone_verified', 'basic', 10, 0);

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes, status) values
  ('db170000-0000-4000-8000-000000000031', 'db170000-0000-4000-8000-000000000020', '清洗', 1000, 'primary', 30, 'active');

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('db170000-0000-4000-8000-000000000041', 'db170000-0000-4000-8000-000000000020', '服務人員A', '0901001701', true);

insert into members (id, merchant_id, name, phone, referral_code, points_balance, status, phone_verified) values
  ('db170000-0000-4000-8000-000000000101', 'db170000-0000-4000-8000-000000000020', '未驗證會員', '0917000101', 'M1017A01', 0, 'active', false),
  ('db170000-0000-4000-8000-000000000102', 'db170000-0000-4000-8000-000000000020', '已驗證會員', '0917000102', 'M1017A02', 500, 'active', true);

-- 訂單 901:已完成、預定 30 點(人工設定)、折抵 50 點(5 元);902:已確認、沒派點。
insert into bookings (id, merchant_id, staff_id, customer_name, customer_phone, start_at, end_at, status,
                      created_by_role, member_id, points_planned, points_planned_auto, points_planned_overridden,
                      points_redeemed, points_redeem_amount_snapshot, final_amount_snapshot)
values
  ('db170000-0000-4000-8000-000000000901', 'db170000-0000-4000-8000-000000000020',
   'db170000-0000-4000-8000-000000000041', '已驗證會員', '0917000102',
   '2030-01-02 10:00+08', '2030-01-02 10:30+08', 'completed', 'admin',
   'db170000-0000-4000-8000-000000000102', 30, 10, true, 50, 5, 1000),
  ('db170000-0000-4000-8000-000000000902', 'db170000-0000-4000-8000-000000000020',
   'db170000-0000-4000-8000-000000000041', '已驗證會員', '0917000102',
   '2030-01-01 10:00+08', '2030-01-01 10:30+08', 'accepted', 'admin',
   'db170000-0000-4000-8000-000000000102', 0, 0, false, 0, 0, 1000);

insert into member_point_transactions (member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id) values
  ('db170000-0000-4000-8000-000000000102', 'db170000-0000-4000-8000-000000000020', 'earn_booking', 30, 530,
   'db170000-0000-4000-8000-000000000901');

-- =========================================================================
-- A. preview_booking_points 的 reward_condition_mode
-- =========================================================================
create function pg_temp.pv(p_phone text)
returns jsonb language sql as $$
  select public.preview_booking_points(
    'db170000-0000-4000-8000-000000000020', null, null, p_phone,
    '[{"service_item_id":"db170000-0000-4000-8000-000000000031","quantity":1,"unit_price":1000}]'::jsonb,
    false, null, false, null, null, false, null, null);
$$;

select pg_temp.test_set_auth('db170000-0000-4000-8000-000000000002');  -- 只有 orders 鑰匙

select is(
  (select row(r ->> 'ineligible_reason', r ->> 'reward_condition_mode', (r ->> 'auto_points')::int)::text
   from pg_temp.pv('0917000101') r),
  row('reward_condition', 'phone_verified', 0)::text,
  'A1 §4.6:不符資格 ⇒ 預覽多回 reward_condition_mode(畫面「需 {條件}」用),只有 orders 鑰匙也拿得到'
);

select is(
  (select row(r ->> 'ineligible_reason', r ->> 'reward_condition_mode', (r ->> 'auto_points')::int)::text
   from pg_temp.pv('0917000102') r),
  row(null::text, null::text, 10)::text,
  'A2:符合資格 ⇒ reward_condition_mode 是 null(不多洩漏商家設定)'
);

select is(
  (select r -> 'member' ->> 'resolution' || '/' || (r ->> 'reward_condition_mode') from pg_temp.pv('0917999999') r),
  'new/phone_verified',
  'A3:新客戶(送出後自動建立)在 phone_verified 模式下 ⇒ reward_condition 也帶條件'
);

select pg_temp.test_clear_auth();
update merchant_member_settings set points_feature_enabled = false
where merchant_id = 'db170000-0000-4000-8000-000000000020';
select pg_temp.test_set_auth('db170000-0000-4000-8000-000000000002');

select is(
  pg_temp.pv('0917000101'),
  '{"feature_enabled": false}'::jsonb,
  'A4 回歸:功能關閉仍只回一個鍵(新鍵沒有破壞「關閉時不洩漏任何設定」)'
);

-- =========================================================================
-- C. v2.4 裁決 21 ①:get_merchant_points_feature_enabled(此時 A 店功能是「關閉」)
-- =========================================================================
select pg_temp.test_set_auth('db170000-0000-4000-8000-000000000003');  -- 只有 members 鑰匙

select is(
  (select count(*)::int from merchant_member_settings where merchant_id = 'db170000-0000-4000-8000-000000000020'),
  0,
  'C1 根因:只有 members 鑰匙的客服直接讀設定表是「查無列」⇒ 前端 hook 會退回預設 true(所以會員詳情頁不能用它)'
);

select is(
  public.get_merchant_points_feature_enabled('db170000-0000-4000-8000-000000000020'),
  false,
  'C2 🔴 v2.4 裁決 21 ①:只有 members 鑰匙的客服,功能關閉時拿到 false'
);

select pg_temp.test_set_auth('db170000-0000-4000-8000-000000000005');  -- 只有 member_points
select is(
  public.get_merchant_points_feature_enabled('db170000-0000-4000-8000-000000000020'),
  false,
  'C3:只有 member_points 鑰匙也可以讀'
);

select pg_temp.test_set_auth('db170000-0000-4000-8000-000000000002');  -- 只有 orders
select throws_ok(
  $$select public.get_merchant_points_feature_enabled('db170000-0000-4000-8000-000000000020')$$,
  '42501', null,
  'C4:只有 orders 鑰匙 ⇒ 42501(建單頁有自己的來源 preview_booking_points)'
);

select pg_temp.test_set_auth('db170000-0000-4000-8000-000000000004');  -- 只有 billing
select throws_ok(
  $$select public.get_merchant_points_feature_enabled('db170000-0000-4000-8000-000000000020')$$,
  '42501', null,
  'C5:只有 billing 鑰匙 ⇒ 42501(帳務報表有自己的來源 get_merchant_billing_summary)'
);

select pg_temp.test_set_auth('db170000-0000-4000-8000-000000000006');  -- B 店管理員
select throws_ok(
  $$select public.get_merchant_points_feature_enabled('db170000-0000-4000-8000-000000000020')$$,
  '42501', null,
  'C6 IDOR:別家商家的管理員 ⇒ 42501'
);
select is(
  public.get_merchant_points_feature_enabled('db170000-0000-4000-8000-000000000021'),
  true,
  'C7:B 店(沒有自訂設定)⇒ true(跟欄位預設 / 前端預設 / 報表函式一致)'
);

select pg_temp.test_clear_auth();
update merchant_member_settings set points_feature_enabled = true
where merchant_id = 'db170000-0000-4000-8000-000000000020';
select pg_temp.test_set_auth('db170000-0000-4000-8000-000000000003');
select is(
  public.get_merchant_points_feature_enabled('db170000-0000-4000-8000-000000000020'),
  true,
  'C8:重新開啟後,members 鑰匙客服拿到 true(反向保護:不是永遠回 false 的假函式)'
);

-- =========================================================================
-- B. §3.13 get_member_related_bookings 多三欄
-- =========================================================================
select is(
  (select row(r.points_planned, r.points_redeemed, r.points_planned_overridden, r.earned_points)::text
   from public.get_member_related_bookings('db170000-0000-4000-8000-000000000102') r
   where r.id = 'db170000-0000-4000-8000-000000000901'),
  row(30, 50, true, 30)::text,
  'B1 §3.13:相關訂單多回 預定派點 / 折抵點數 / 是否人工設定;earned_points 語意不變'
);

select is(
  (select row(r.points_planned, r.points_redeemed, r.points_planned_overridden, r.earned_points)::text
   from public.get_member_related_bookings('db170000-0000-4000-8000-000000000102') r
   where r.id = 'db170000-0000-4000-8000-000000000902'),
  row(0, 0, false, null::int)::text,
  'B2:沒派點、沒折抵的單 ⇒ 0 / 0 / false / null'
);

select pg_temp.test_set_auth('db170000-0000-4000-8000-000000000002');  -- 只有 orders
select throws_ok(
  $$select * from public.get_member_related_bookings('db170000-0000-4000-8000-000000000102')$$,
  '42501', null,
  'B3 回歸:只有 orders 鑰匙 ⇒ 42501(drop + create 後權限檢查照舊)'
);

-- =========================================================================
-- D. §4.7 get_booking_points_ledger
-- =========================================================================
select pg_temp.test_set_auth('db170000-0000-4000-8000-000000000002');  -- 只有 orders
select is(
  public.get_booking_points_ledger('db170000-0000-4000-8000-000000000901'),
  '{"earned_points": 30, "reversed_points": 0, "effective_points": 30}'::jsonb,
  'D1 §4.7:只有 orders 鑰匙也查得到這張單「已入帳 30 點」'
);
select is(
  public.get_booking_points_ledger('db170000-0000-4000-8000-000000000902'),
  '{"earned_points": null, "reversed_points": 0, "effective_points": null}'::jsonb,
  'D2:從未入帳 ⇒ null(不是 0,畫面才分得出「還沒入帳」)'
);
select is(
  (select array_agg(k order by k)
   from jsonb_object_keys(public.get_booking_points_ledger('db170000-0000-4000-8000-000000000901')) k),
  array['earned_points', 'effective_points', 'reversed_points'],
  'D3 資安:只回三個數字,不回會員餘額 / 其他交易'
);

select pg_temp.test_clear_auth();
insert into member_point_transactions (member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id)
values ('db170000-0000-4000-8000-000000000102', 'db170000-0000-4000-8000-000000000020', 'earn_booking_reversal', -10, 520,
        'db170000-0000-4000-8000-000000000901');
select pg_temp.test_set_auth('db170000-0000-4000-8000-000000000002');
select is(
  public.get_booking_points_ledger('db170000-0000-4000-8000-000000000901'),
  '{"earned_points": 30, "reversed_points": 10, "effective_points": 20}'::jsonb,
  'D4:被收回 10 點 ⇒ reversed 10、有效入帳 20(#844 完成後取消 / 還原時畫面顯示「已收回」用)'
);

select pg_temp.test_clear_auth();
insert into member_point_transactions (member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id)
values ('db170000-0000-4000-8000-000000000102', 'db170000-0000-4000-8000-000000000020', 'earn_booking_reversal', -20, 500,
        'db170000-0000-4000-8000-000000000901');
select pg_temp.test_set_auth('db170000-0000-4000-8000-000000000002');
select is(
  (public.get_booking_points_ledger('db170000-0000-4000-8000-000000000901') ->> 'effective_points')::int,
  0,
  'D5:全額收回 ⇒ 有效入帳 0'
);

select pg_temp.test_set_auth('db170000-0000-4000-8000-000000000003');  -- 只有 members(沒有 orders)
select throws_ok(
  $$select public.get_booking_points_ledger('db170000-0000-4000-8000-000000000901')$$,
  '42501', '找不到這筆預約,或沒有權限查看',
  'D6:沒有 orders 鑰匙 ⇒ 42501'
);
select pg_temp.test_set_auth('db170000-0000-4000-8000-000000000006');  -- B 店管理員
select throws_ok(
  $$select public.get_booking_points_ledger('db170000-0000-4000-8000-000000000901')$$,
  '42501', '找不到這筆預約,或沒有權限查看',
  'D7 IDOR:別家商家的訂單 ⇒ 42501'
);
select throws_ok(
  $$select public.get_booking_points_ledger('db170000-0000-4000-8000-00000000dead')$$,
  '42501', '找不到這筆預約,或沒有權限查看',
  'D8:不存在的訂單 ⇒ 跟「別家的」同一個錯誤(不洩漏存不存在)'
);

-- =========================================================================
-- E. v2.4 裁決 21 ④:merchant_point_formulas 只留 SELECT
-- =========================================================================
select pg_temp.test_clear_auth();
select is(
  (select array_agg(policyname::text order by policyname) from pg_policies
   where schemaname = 'public' and tablename = 'merchant_point_formulas'),
  array['merchant_point_formulas_select'],
  'E1:只剩 SELECT 政策'
);
select ok(
  not has_table_privilege('authenticated', 'public.merchant_point_formulas', 'insert')
  and not has_table_privilege('authenticated', 'public.merchant_point_formulas', 'update')
  and not has_table_privilege('authenticated', 'public.merchant_point_formulas', 'delete')
  and not has_table_privilege('anon', 'public.merchant_point_formulas', 'insert'),
  'E2:authenticated / anon 沒有 INSERT / UPDATE / DELETE 表權限'
);
select ok(
  has_table_privilege('authenticated', 'public.merchant_point_formulas', 'select'),
  'E3:authenticated 仍有 SELECT(設定頁讀公式靠 RLS 的 member_points 政策)'
);

insert into merchant_point_formulas (id, merchant_id, name, service_item_id, points_per_unit) values
  ('db170000-0000-4000-8000-000000000091', 'db170000-0000-4000-8000-000000000020', '公式 1', null, 5);

select pg_temp.test_set_auth('db170000-0000-4000-8000-000000000001');  -- A 店管理員(最大權限)
select throws_ok(
  $$insert into merchant_point_formulas (merchant_id, name, service_item_id, points_per_unit)
    values ('db170000-0000-4000-8000-000000000020', '直接寫表', 'db170000-0000-4000-8000-000000000031', 3)$$,
  '42501', null,
  'E4 🔴:連管理員直接 INSERT 都被擋(寫入一律走 upsert_member_point_formulas)'
);
select throws_ok(
  $$update merchant_point_formulas set points_per_unit = 999 where id = 'db170000-0000-4000-8000-000000000091'$$,
  '42501', null,
  'E5 🔴:直接 UPDATE 被擋(是報錯,不是「靜默 0 列」)'
);
select throws_ok(
  $$delete from merchant_point_formulas where id = 'db170000-0000-4000-8000-000000000091'$$,
  '42501', null,
  'E6 🔴:直接 DELETE 被擋'
);
select is(
  (select count(*)::int from merchant_point_formulas where merchant_id = 'db170000-0000-4000-8000-000000000020'),
  1,
  'E7:讀照常(管理員看得到自己店的公式)'
);
select lives_ok(
  $$select * from upsert_member_point_formulas('db170000-0000-4000-8000-000000000020',
    '[{"id":"db170000-0000-4000-8000-000000000091","name":"公式 1","enabled":true,"service_item_id":null,"min_unit_price":0,"points_per_unit":8,"sort_order":1}]'::jsonb)$$,
  'E8:正規入口 upsert_member_point_formulas 照常可寫'
);
select is(
  (select points_per_unit from merchant_point_formulas where id = 'db170000-0000-4000-8000-000000000091'),
  8,
  'E9:正規入口寫進去了;直接 UPDATE 的 999 沒有生效'
);
select pg_temp.test_set_auth('db170000-0000-4000-8000-000000000003');  -- 只有 members
select is(
  (select count(*)::int from merchant_point_formulas where merchant_id = 'db170000-0000-4000-8000-000000000020'),
  0,
  'E10 回歸:SELECT 政策照舊要 member_points 鑰匙(members 鑰匙讀不到)'
);
select pg_temp.test_clear_auth();

-- E11~E16 批次 8 主腦裁決:member_birthday_bonus_grants 比照收回寫入表權限。
-- 正向對照:收回之前 UPDATE / DELETE 是「靜默 0 列」(只有 SELECT 政策),所以 E13/E14 在收回前會轉紅
-- (批次 8 故障注入實測:grant 回去 ⇒ E11、E13、E14 轉紅;E12 的 INSERT 在收回前也會被 RLS
-- 以同一個 42501 擋下,所以 E12 本身不是這次修正的證據,是「INSERT 一直都擋得住」的回歸守門)。
select ok(
  not has_table_privilege('authenticated', 'public.member_birthday_bonus_grants', 'insert')
  and not has_table_privilege('authenticated', 'public.member_birthday_bonus_grants', 'update')
  and not has_table_privilege('authenticated', 'public.member_birthday_bonus_grants', 'delete')
  and not has_table_privilege('anon', 'public.member_birthday_bonus_grants', 'insert')
  and not has_table_privilege('anon', 'public.member_birthday_bonus_grants', 'update')
  and not has_table_privilege('anon', 'public.member_birthday_bonus_grants', 'delete'),
  'E11:生日發送紀錄表 authenticated / anon 沒有 INSERT / UPDATE / DELETE 表權限'
);
select pg_temp.test_set_auth('db170000-0000-4000-8000-000000000001');  -- A 店管理員(最大權限)
select throws_ok(
  $$insert into member_birthday_bonus_grants (merchant_id, member_id, bonus_year, anchor_date, points, member_name_snapshot, line_status)
    values ('db170000-0000-4000-8000-000000000020', gen_random_uuid(), 2026, '2026-01-01', 10, '直接寫表', 'pending')$$,
  '42501', null,
  'E12 🔴:連管理員直接 INSERT 生日發送紀錄都被擋'
);
select throws_ok(
  $$update member_birthday_bonus_grants set points = 999 where merchant_id = 'db170000-0000-4000-8000-000000000020'$$,
  '42501', null,
  'E13 🔴:直接 UPDATE 生日發送紀錄被擋(是報錯,不是「靜默 0 列」)'
);
select throws_ok(
  $$delete from member_birthday_bonus_grants where merchant_id = 'db170000-0000-4000-8000-000000000020'$$,
  '42501', null,
  'E14 🔴:直接 DELETE 生日發送紀錄被擋'
);
select lives_ok(
  $$select * from get_birthday_bonus_grants('db170000-0000-4000-8000-000000000020')$$,
  'E15 回歸:讀取入口 get_birthday_bonus_grants 照常'
);
select pg_temp.test_clear_auth();
select ok(
  has_table_privilege('authenticated', 'public.member_birthday_bonus_grants', 'select')
  and has_table_privilege('service_role', 'public.member_birthday_bonus_grants', 'insert')
  and has_table_privilege('service_role', 'public.member_birthday_bonus_grants', 'update'),
  'E16:authenticated 保留 SELECT(走 RLS);service_role 寫入權限不受影響'
);

-- =========================================================================
-- F. 權限衛生
-- =========================================================================
select ok(
  has_function_privilege('authenticated', 'public.get_merchant_points_feature_enabled(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.get_merchant_points_feature_enabled(uuid)', 'execute'),
  'F1:get_merchant_points_feature_enabled —— authenticated 有、anon 沒有'
);
select ok(
  has_function_privilege('authenticated', 'public.get_booking_points_ledger(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.get_booking_points_ledger(uuid)', 'execute'),
  'F2:get_booking_points_ledger —— authenticated 有、anon 沒有'
);
select ok(
  has_function_privilege('authenticated', 'public.get_member_related_bookings(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.get_member_related_bookings(uuid)', 'execute'),
  'F3:get_member_related_bookings drop + create 後權限有重收(authenticated 有、anon 沒有)'
);
select ok(
  has_function_privilege('authenticated', 'public.preview_booking_points(uuid, uuid, uuid, text, jsonb, boolean, numeric, boolean, text, numeric, boolean, text, numeric)', 'execute')
  and not has_function_privilege('anon', 'public.preview_booking_points(uuid, uuid, uuid, text, jsonb, boolean, numeric, boolean, text, numeric, boolean, text, numeric)', 'execute'),
  'F4:preview_booking_points create or replace 後權限不變'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('get_member_related_bookings', 'preview_booking_points',
     'get_merchant_points_feature_enabled', 'get_booking_points_ledger')),
  4,
  'F5:四支函式各只有 1 個版本(沒有殘留舊 overload)'
);
select ok(
  (select bool_and(p.prosecdef and 'search_path=public' = any(p.proconfig))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('get_merchant_points_feature_enabled', 'get_booking_points_ledger',
     'get_member_related_bookings')),
  'F6:三支讀取函式都是 SECURITY DEFINER + 固定 search_path'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('get_merchant_points_feature_enabled', 'get_booking_points_ledger')
     and p.provolatile = 's'),
  2,
  'F7:兩支新函式是 stable(唯讀)'
);

select * from finish();
rollback;
